import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { WorkflowEngine } from "./WorkflowEngine.js";

function resetWorkflowEngineSingleton(): void {
  (WorkflowEngine as any).instance = undefined;
}

test("sweep() returns empty result when no runs exist", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-sweep-"));
  const runsPath = path.join(tmpDir, "workflow-runs.json");
  const prev = process.env.WORKFLOW_RUNS_PATH;
  const prevMax = process.env.WORKFLOW_MAX_RUNS;
  try {
    process.env.WORKFLOW_RUNS_PATH = runsPath;
    process.env.WORKFLOW_MAX_RUNS = "100";
    resetWorkflowEngineSingleton();
    const engine = WorkflowEngine.getInstance();
    const result = engine.sweep(30);
    assert.equal(result.totalActive, 0);
    assert.equal(result.driftedCount, 0);
    assert.equal(result.stuckCount, 0);
    assert.equal(result.oldestRunAgeMs, 0);
    assert.deepEqual(result.driftedRuns, []);
    assert.ok(result.sweptAt);
  } finally {
    if (prev === undefined) delete process.env.WORKFLOW_RUNS_PATH;
    else process.env.WORKFLOW_RUNS_PATH = prev;
    if (prevMax === undefined) delete process.env.WORKFLOW_MAX_RUNS;
    else process.env.WORKFLOW_MAX_RUNS = prevMax;
    resetWorkflowEngineSingleton();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("sweep() returns active run count without drift when runs are fresh", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-sweep-"));
  const runsPath = path.join(tmpDir, "workflow-runs.json");
  const prev = process.env.WORKFLOW_RUNS_PATH;
  const prevMax = process.env.WORKFLOW_MAX_RUNS;
  try {
    process.env.WORKFLOW_RUNS_PATH = runsPath;
    process.env.WORKFLOW_MAX_RUNS = "100";
    resetWorkflowEngineSingleton();
    const engine = WorkflowEngine.getInstance();
    engine.startRun({ templateId: "incident-response", taskId: "T-1", title: "Fresh run" });
    const result = engine.sweep(30);
    assert.equal(result.totalActive, 1);
    assert.equal(result.driftedCount, 0);
    assert.equal(result.stuckCount, 0);
    assert.deepEqual(result.driftedRuns, []);
  } finally {
    if (prev === undefined) delete process.env.WORKFLOW_RUNS_PATH;
    else process.env.WORKFLOW_RUNS_PATH = prev;
    if (prevMax === undefined) delete process.env.WORKFLOW_MAX_RUNS;
    else process.env.WORKFLOW_MAX_RUNS = prevMax;
    resetWorkflowEngineSingleton();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("sweep() flags run as drifted when updatedAt exceeds threshold", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-sweep-"));
  const runsPath = path.join(tmpDir, "workflow-runs.json");
  const prev = process.env.WORKFLOW_RUNS_PATH;
  const prevMax = process.env.WORKFLOW_MAX_RUNS;
  try {
    process.env.WORKFLOW_RUNS_PATH = runsPath;
    process.env.WORKFLOW_MAX_RUNS = "100";
    resetWorkflowEngineSingleton();
    const engine = WorkflowEngine.getInstance();
    const run = engine.startRun({ templateId: "incident-response", taskId: "T-2", title: "Drifted run" });

    // Directly set old updatedAt on in-memory run (45 min ago) to simulate drift
    const oldTime = new Date(Date.now() - 45 * 60 * 1000).toISOString();
    const inMemoryRun = (engine as any).runs.get(run.id);
    inMemoryRun.updatedAt = oldTime;

    const result = engine.sweep(30);

    assert.equal(result.totalActive, 1);
    assert.equal(result.driftedCount, 1);
    assert.equal(result.driftedRuns[0].isDrifted, true);
    assert.equal(result.driftedRuns[0].isStuck, false);
    assert.equal(result.driftedRuns[0].id, run.id);
  } finally {
    if (prev === undefined) delete process.env.WORKFLOW_RUNS_PATH;
    else process.env.WORKFLOW_RUNS_PATH = prev;
    if (prevMax === undefined) delete process.env.WORKFLOW_MAX_RUNS;
    else process.env.WORKFLOW_MAX_RUNS = prevMax;
    resetWorkflowEngineSingleton();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("sweep() flags run as stuck when updatedAt exceeds 2x threshold", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-sweep-"));
  const runsPath = path.join(tmpDir, "workflow-runs.json");
  const prev = process.env.WORKFLOW_RUNS_PATH;
  const prevMax = process.env.WORKFLOW_MAX_RUNS;
  try {
    process.env.WORKFLOW_RUNS_PATH = runsPath;
    process.env.WORKFLOW_MAX_RUNS = "100";
    resetWorkflowEngineSingleton();
    const engine = WorkflowEngine.getInstance();
    const run = engine.startRun({ templateId: "incident-response", taskId: "T-3", title: "Stuck run" });

    // Directly set very old updatedAt on in-memory run (90 min ago, 2x the 30-min threshold)
    const oldTime = new Date(Date.now() - 90 * 60 * 1000).toISOString();
    const inMemoryRun = (engine as any).runs.get(run.id);
    inMemoryRun.updatedAt = oldTime;

    const result = engine.sweep(30);

    assert.equal(result.totalActive, 1);
    assert.equal(result.driftedCount, 1);
    assert.equal(result.stuckCount, 1);
    assert.equal(result.driftedRuns[0].isDrifted, true);
    assert.equal(result.driftedRuns[0].isStuck, true);
    assert.ok(result.driftedRuns[0].lastUpdateAgeMs > 2 * 30 * 60 * 1000);
  } finally {
    if (prev === undefined) delete process.env.WORKFLOW_RUNS_PATH;
    else process.env.WORKFLOW_RUNS_PATH = prev;
    if (prevMax === undefined) delete process.env.WORKFLOW_MAX_RUNS;
    else process.env.WORKFLOW_MAX_RUNS = prevMax;
    resetWorkflowEngineSingleton();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("sweep() returns valid WorkflowSweepResult shape with all required fields", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-sweep-shape-"));
  const runsPath = path.join(tmpDir, "workflow-runs.json");
  const prev = process.env.WORKFLOW_RUNS_PATH;
  const prevMax = process.env.WORKFLOW_MAX_RUNS;
  try {
    process.env.WORKFLOW_RUNS_PATH = runsPath;
    process.env.WORKFLOW_MAX_RUNS = "100";
    resetWorkflowEngineSingleton();
    const engine = WorkflowEngine.getInstance();
    const result = engine.sweep();

    assert.equal(typeof result.totalActive, "number");
    assert.equal(typeof result.driftedCount, "number");
    assert.equal(typeof result.stuckCount, "number");
    assert.ok(Array.isArray(result.driftedRuns));
    assert.equal(typeof result.sweptAt, "string");
    assert.ok(!isNaN(Date.parse(result.sweptAt)), "sweptAt should be a valid ISO date");
    assert.equal(typeof result.oldestRunAgeMs, "number");

    engine.startRun({ templateId: "incident-response", taskId: "T-SHAPE", title: "Shape test" });
    const withRun = engine.sweep(0.0001);
    assert.equal(withRun.totalActive, 1);
    if (withRun.driftedRuns.length > 0) {
      const dr = withRun.driftedRuns[0];
      assert.equal(typeof dr.id, "string");
      assert.equal(typeof dr.name, "string");
      assert.equal(typeof dr.currentStage, "string");
      assert.equal(typeof dr.lastUpdateAgeMs, "number");
      assert.equal(typeof dr.isDrifted, "boolean");
      assert.equal(typeof dr.isStuck, "boolean");
    }
  } finally {
    if (prev === undefined) delete process.env.WORKFLOW_RUNS_PATH;
    else process.env.WORKFLOW_RUNS_PATH = prev;
    if (prevMax === undefined) delete process.env.WORKFLOW_MAX_RUNS;
    else process.env.WORKFLOW_MAX_RUNS = prevMax;
    resetWorkflowEngineSingleton();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("WorkflowEngine supports transitions, persistence, and failure reconciliation", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-engine-"));
  const runsPath = path.join(tmpDir, "workflow-runs.json");

  const previousRunsPath = process.env.WORKFLOW_RUNS_PATH;
  const previousMaxRuns = process.env.WORKFLOW_MAX_RUNS;

  try {
    process.env.WORKFLOW_RUNS_PATH = runsPath;
    process.env.WORKFLOW_MAX_RUNS = "100";

    resetWorkflowEngineSingleton();
    const engine = WorkflowEngine.getInstance();

    const run = engine.startRun({
      templateId: "incident-response",
      taskId: "TASK-WF-001",
      title: "Workflow Engine Test"
    });

    assert.equal(run.status, "active");
    assert.equal(run.currentStageIndex, 0);
    assert.equal(run.stages[0].name, "triage");
    assert.equal(run.stages[0].status, "in_progress");

    const afterTriage = engine.updateStage(run.id, "triage", { status: "done" });
    assert.equal(afterTriage.stages.find((stage) => stage.name === "triage")?.status, "done");
    assert.equal(afterTriage.stages.find((stage) => stage.name === "assign")?.status, "in_progress");
    assert.equal(afterTriage.currentStageIndex, 1);

    assert.ok(fs.existsSync(runsPath));

    resetWorkflowEngineSingleton();
    const reloadedEngine = WorkflowEngine.getInstance();
    const loaded = reloadedEngine.getRun(run.id);

    assert.ok(loaded, "run should load from persisted storage");
    assert.equal(loaded?.stages.find((stage) => stage.name === "triage")?.status, "done");
    assert.equal(loaded?.stages.find((stage) => stage.name === "assign")?.status, "in_progress");

    const failed = reloadedEngine.updateStage(run.id, "assign", { status: "failed" });
    assert.equal(failed.status, "failed");
    assert.equal(failed.currentStageIndex, 1);

    const reconciled = reloadedEngine.reconcileRun(run.id);
    const inProgressCount = reconciled.stages.filter((stage) => stage.status === "in_progress").length;
    assert.equal(inProgressCount, 0);
    assert.equal(reconciled.status, "failed");

    assert.throws(
      () => reloadedEngine.startRun({ templateId: "unknown-template", taskId: "x", title: "bad" }),
      /Unknown template/
    );
  } finally {
    if (previousRunsPath === undefined) {
      delete process.env.WORKFLOW_RUNS_PATH;
    } else {
      process.env.WORKFLOW_RUNS_PATH = previousRunsPath;
    }

    if (previousMaxRuns === undefined) {
      delete process.env.WORKFLOW_MAX_RUNS;
    } else {
      process.env.WORKFLOW_MAX_RUNS = previousMaxRuns;
    }

    resetWorkflowEngineSingleton();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("startRun deduplicates active template/task pairs and recovery terminalizes stale runs", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-recovery-"));
  const runsPath = path.join(tmpDir, "workflow-runs.json");
  const previousRunsPath = process.env.WORKFLOW_RUNS_PATH;
  try {
    process.env.WORKFLOW_RUNS_PATH = runsPath;
    resetWorkflowEngineSingleton();
    const engine = WorkflowEngine.getInstance();
    const resolved = engine.startRun({ templateId: "incident-response", taskId: "inc-resolved", title: "Resolved" });
    assert.equal(
      engine.startRun({ templateId: "incident-response", taskId: "inc-resolved", title: "Duplicate" }).id,
      resolved.id,
    );
    const orphan = engine.startRun({ templateId: "incident-response", taskId: "inc-orphan", title: "Orphan" });
    const active = engine.startRun({ templateId: "incident-response", taskId: "inc-active", title: "Active" });

    const historicalDuplicate = structuredClone(resolved);
    historicalDuplicate.id = "wf-historical-duplicate";
    historicalDuplicate.createdAt = new Date(Date.parse(resolved.createdAt) - 1000).toISOString();
    (engine as any).runs.set(historicalDuplicate.id, historicalDuplicate);
    const activeTimestamp = new Date(Date.now() - 45 * 60 * 1000).toISOString();
    (engine as any).runs.get(active.id).updatedAt = activeTimestamp;

    const report = engine.recoverActiveRuns(run => {
      if (run.taskId === "inc-resolved") return { action: "completed", reason: "Incident resolved" };
      if (run.taskId === "inc-orphan") return { action: "failed", reason: "Incident missing" };
      return { action: "keep" };
    });
    assert.equal(report.scanned, 4);
    assert.equal(report.completed, 1);
    assert.equal(report.failed, 2);
    assert.equal(report.deduplicated, 1);
    assert.equal(engine.getRun(resolved.id)?.status, "completed");
    assert.equal(engine.getRun(orphan.id)?.status, "failed");
    assert.equal(engine.getRun(active.id)?.status, "active");

    resetWorkflowEngineSingleton();
    const reloaded = WorkflowEngine.getInstance();
    assert.equal(reloaded.getRun(active.id)?.updatedAt, activeTimestamp, "loading must not make stale runs look fresh");
    assert.equal(reloaded.getRun(resolved.id)?.status, "completed");
    assert.equal(reloaded.sweep().lastRecovery?.changedRunIds.length, 3);
  } finally {
    if (previousRunsPath === undefined) delete process.env.WORKFLOW_RUNS_PATH;
    else process.env.WORKFLOW_RUNS_PATH = previousRunsPath;
    resetWorkflowEngineSingleton();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FactoryTaskService } from "./FactoryTaskService.js";

function resetFactoryTaskServiceSingleton(): void {
  (FactoryTaskService as any).instance = undefined;
}

function withTempService(fn: (service: FactoryTaskService) => void): void {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "factory-task-"));
  const tasksPath = path.join(tmpDir, "factory-tasks.json");
  const prev = process.env.FACTORY_TASKS_PATH;
  try {
    process.env.FACTORY_TASKS_PATH = tasksPath;
    resetFactoryTaskServiceSingleton();
    const service = FactoryTaskService.getInstance();
    fn(service);
  } finally {
    if (prev === undefined) delete process.env.FACTORY_TASKS_PATH;
    else process.env.FACTORY_TASKS_PATH = prev;
    resetFactoryTaskServiceSingleton();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

test("creates a task in proposed state", () => {
  withTempService((service) => {
    const task = service.create("Test task", "A test description", "alice");
    assert.equal(task.state, "proposed");
    assert.equal(task.title, "Test task");
    assert.equal(task.description, "A test description");
    assert.equal(task.actor, "alice");
    assert.ok(task.id.startsWith("ft-"));
    assert.deepEqual(task.gateResults, []);
  });
});

test("transitions through valid states sequentially", () => {
  withTempService((service) => {
    const task = service.create("Flow task", "desc", "alice");
    const states = [
      "specified",
      "ready",
      "in_progress",
      "in_review",
      "in_qa",
      "releasable",
      "released"
    ] as const;

    let current = task;
    for (const nextState of states) {
      current = service.transition(current.id, nextState, "alice");
      assert.equal(current.state, nextState);
    }
  });
});

test("throws on invalid state transition", () => {
  withTempService((service) => {
    const task = service.create("Bad transition", "desc", "alice");
    assert.throws(
      () => service.transition(task.id, "released", "alice"),
      /Invalid transition: proposed → released/
    );
  });
});

test("throws when transitioning to current state", () => {
  withTempService((service) => {
    const task = service.create("Same state", "desc", "alice");
    assert.throws(
      () => service.transition(task.id, "proposed", "alice"),
      /Task already in state: proposed/
    );
  });
});

test("records gate results on a task", () => {
  withTempService((service) => {
    const task = service.create("Gated task", "desc", "alice");
    const updated = service.recordGateResult(task.id, "code-review", "pass", "LGTM", "bob");
    assert.equal(updated.gateResults.length, 1);
    assert.equal(updated.gateResults[0].gate, "code-review");
    assert.equal(updated.gateResults[0].result, "pass");
    assert.equal(updated.gateResults[0].notes, "LGTM");
    assert.equal(updated.gateResults[0].actor, "bob");
    assert.ok(updated.gateResults[0].timestamp);
  });
});

test("throws on transition for non-existent task", () => {
  withTempService((service) => {
    assert.throws(
      () => service.transition("ft-nonexistent", "specified", "alice"),
      /Task not found: ft-nonexistent/
    );
  });
});

test("transition proposed -> specified -> ready -> in_progress", () => {
  withTempService((service) => {
    const task = service.create("Step-by-step", "desc", "actor1");

    const s1 = service.transition(task.id, "specified", "actor1");
    assert.equal(s1.state, "specified");

    const s2 = service.transition(task.id, "ready", "actor1");
    assert.equal(s2.state, "ready");

    const s3 = service.transition(task.id, "in_progress", "actor1");
    assert.equal(s3.state, "in_progress");
  });
});

test("in_review -> in_progress rejection loop works", () => {
  withTempService((service) => {
    const task = service.create("Rejection loop", "desc", "dev");
    service.transition(task.id, "specified", "dev");
    service.transition(task.id, "ready", "dev");
    service.transition(task.id, "in_progress", "dev");
    service.transition(task.id, "in_review", "dev");

    const rejected = service.transition(task.id, "in_progress", "reviewer");
    assert.equal(rejected.state, "in_progress");
    assert.equal(rejected.actor, "reviewer");

    const resubmitted = service.transition(task.id, "in_review", "dev");
    assert.equal(resubmitted.state, "in_review");
  });
});

test("invalid transition proposed -> in_progress throws", () => {
  withTempService((service) => {
    const task = service.create("Skip states", "desc", "actor1");
    assert.throws(
      () => service.transition(task.id, "in_progress", "actor1"),
      /Invalid transition/
    );
  });
});

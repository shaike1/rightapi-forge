// File-backed registry of validated WorkflowDef objects.
//
// Drop a .workflow.json file into the registry directory and it shows up
// here at startup — same shape PluginLoader uses for skills, so operators
// have one mental model. The registry runs every file through
// validateWorkflowDef before exposing it; malformed files are logged at
// warn level and skipped, never crashing the host.

import fs from 'fs';
import path from 'path';
import { createLogger } from '../observability/Logger.js';
import { validateWorkflowDef, type WorkflowDef, type ValidationError } from './WorkflowDef.js';

const log = createLogger({ component: 'workflow-registry' });

export interface RegisteredWorkflow {
  filePath: string;
  workflow: WorkflowDef;
  loadedAt: string;
}

export interface LoadFailure {
  filePath: string;
  errors: ValidationError[];
  reason?: string;
}

export interface WorkflowRegistryOptions {
  /** Directory to scan for .workflow.json files. Created if missing. */
  workflowDir: string;
  /** Filename suffix marking a workflow file. Default ".workflow.json". */
  suffix?: string;
}

export class WorkflowRegistry {
  private readonly workflowDir: string;
  private readonly suffix: string;
  private readonly byId: Map<string, RegisteredWorkflow> = new Map();
  private readonly failures: LoadFailure[] = [];

  constructor(opts: WorkflowRegistryOptions) {
    this.workflowDir = path.resolve(opts.workflowDir);
    this.suffix      = opts.suffix ?? '.workflow.json';
  }

  /** Scan the directory and register every valid workflow. Replaces any
   *  prior registration for an id (last-load wins on repeat scans). Safe
   *  to call repeatedly. */
  loadAll(): { loaded: number; failed: number } {
    fs.mkdirSync(this.workflowDir, { recursive: true });
    this.failures.length = 0;
    const before = new Set(this.byId.keys());
    let loaded = 0, failed = 0;
    for (const entry of fs.readdirSync(this.workflowDir)) {
      if (!entry.endsWith(this.suffix)) continue;
      const full = path.join(this.workflowDir, entry);
      const result = this.loadOne(full);
      if (result.ok) loaded++; else failed++;
    }
    // Drop any workflow whose file disappeared between scans.
    for (const id of before) {
      const rec = this.byId.get(id);
      if (rec && !fs.existsSync(rec.filePath)) {
        this.byId.delete(id);
      }
    }
    log.info('workflow scan complete', { dir: this.workflowDir, loaded, failed });
    return { loaded, failed };
  }

  /** Validate + register one file. Returns {ok:false} when the file is
   *  malformed; the failure is captured in failures() for the API. */
  loadOne(filePath: string): { ok: true; workflow: WorkflowDef } | { ok: false; errors: ValidationError[] } {
    let text: string;
    try { text = fs.readFileSync(filePath, 'utf8'); }
    catch (e: any) {
      const errors = [{ path: '/', message: `read failed: ${e?.message ?? String(e)}` }];
      this.failures.push({ filePath, errors, reason: 'read_failed' });
      log.warn('workflow read failed', { filePath, err: e?.message });
      return { ok: false, errors };
    }
    let parsed: unknown;
    try { parsed = JSON.parse(text); }
    catch (e: any) {
      const errors = [{ path: '/', message: `JSON parse error: ${e?.message ?? String(e)}` }];
      this.failures.push({ filePath, errors, reason: 'parse_failed' });
      log.warn('workflow parse failed', { filePath, err: e?.message });
      return { ok: false, errors };
    }
    const v = validateWorkflowDef(parsed);
    if (!v.ok) {
      this.failures.push({ filePath, errors: v.errors, reason: 'validation_failed' });
      log.warn('workflow validation failed', { filePath, errors: v.errors });
      return { ok: false, errors: v.errors };
    }
    const workflow = v.workflow!;
    this.byId.set(workflow.id, { filePath, workflow, loadedAt: new Date().toISOString() });
    log.info('workflow registered', {
      filePath, workflowId: workflow.id, version: workflow.version, steps: workflow.steps.length,
    });
    return { ok: true, workflow };
  }

  /** Validate-and-register from an in-memory object (e.g., POSTed JSON). */
  registerFromObject(value: unknown): { ok: true; workflow: WorkflowDef } | { ok: false; errors: ValidationError[] } {
    const v = validateWorkflowDef(value);
    if (!v.ok) return { ok: false, errors: v.errors };
    const workflow = v.workflow!;
    this.byId.set(workflow.id, {
      filePath: '<in-memory>', workflow, loadedAt: new Date().toISOString(),
    });
    return { ok: true, workflow };
  }

  get(id: string): WorkflowDef | undefined {
    return this.byId.get(id)?.workflow;
  }

  list(): RegisteredWorkflow[] {
    return Array.from(this.byId.values()).map(r => ({ ...r }));
  }

  /** Most recent load failures — surfaced through /api/workflows/json/failures
   *  so operators can see why a workflow file isn't appearing. */
  recentFailures(): LoadFailure[] {
    return this.failures.slice(-50);
  }
}

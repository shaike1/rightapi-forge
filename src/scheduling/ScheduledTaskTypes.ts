// Types for the workflow-aware scheduler.
//
// The legacy automation/TaskScheduler runs free-form "natural language
// prompt" tasks via cron. This module is the durable, DB-backed
// successor focused on workflow execution + history. Both can coexist:
// nothing here removes the prompt-based scheduler.
//
// A schedule binds a trigger (cron expression, tenant scope) to an
// action (workflow id + inputs OR an inline shell command) and
// records every run in a history table for audit / dashboards.

import { SYSTEM_TENANT_ID } from '../tenancy/index.js';

export type ScheduleStatus = 'enabled' | 'paused';

export interface ScheduleAction {
  /** Either run a registered workflow ... */
  kind: 'workflow';
  workflowId: string;
  inputs?: Record<string, unknown>;
}
export interface ShellAction {
  /** ... or run a one-off shell command via skill `bash.exec`. */
  kind: 'shell';
  command: string;
}
export type ScheduleActionAny = ScheduleAction | ShellAction;

export interface ScheduledTask {
  /** Stable id; user-supplied or derived. */
  id: string;
  /** Tenant the schedule + every run belongs to. */
  tenantId: string;
  name: string;
  description?: string;
  /** Cron expression (5 or 6 fields, node-cron syntax). */
  cron: string;
  action: ScheduleActionAny;
  status: ScheduleStatus;
  /** Wall-clock ISO timestamp the engine last *successfully started* a
   *  run. Updated even on failure runs so missed-run detection works. */
  lastRunAt?: string;
  /** Computed by the engine; surfaced for dashboards + the upcoming
   *  endpoint. */
  nextRunAt?: string;
  /** Bumped each time the engine starts a new run. */
  runCount: number;
  /** When non-zero, the engine stops triggering new runs while this
   *  schedule has an in-flight run. */
  inFlightCount: number;
  createdAt: string;
  updatedAt: string;
}

export type RunOutcome = 'success' | 'failed' | 'pending_approval' | 'skipped';

export interface ScheduledTaskRun {
  /** Stable id. Foreign-key target for any downstream tables. */
  id: string;
  scheduleId: string;
  tenantId: string;
  /** When the engine fired the run (start time). */
  startedAt: string;
  /** Set when the run reaches a terminal state. */
  completedAt?: string;
  outcome: RunOutcome;
  /** Workflow run id when the action was a workflow; otherwise null. */
  workflowRunId?: string;
  /** Reason for an outcome of 'skipped' — e.g. "concurrent run already
   *  in flight" or "schedule paused mid-tick". */
  skipReason?: string;
  /** Error message when outcome=failed. */
  error?: string;
  /** Whether this run was a missed-run replay (server was down at the
   *  scheduled time and the engine fired it on startup). */
  missedRun: boolean;
}

/** Convenience: build a "fresh" ScheduledTask record from minimal input.
 *  Used by tests + the API POST handler so callers don't have to keep
 *  the full shape in mind. */
export function buildSchedule(input: {
  id: string;
  name: string;
  cron: string;
  action: ScheduleActionAny;
  tenantId?: string;
  description?: string;
  status?: ScheduleStatus;
}): ScheduledTask {
  const now = new Date().toISOString();
  return {
    id: input.id,
    tenantId: input.tenantId ?? SYSTEM_TENANT_ID,
    name: input.name,
    description: input.description,
    cron: input.cron,
    action: input.action,
    status: input.status ?? 'enabled',
    runCount: 0,
    inFlightCount: 0,
    createdAt: now,
    updatedAt: now,
  };
}

import { EventEmitter } from 'events';
import type { Plan, PlanNode } from './GoalPlanner.js';
import { GoalPlanner } from './GoalPlanner.js';
import type { PlanStore } from './PlanStore.js';

const MAX_RETRIES = 2;
const TASK_TIMEOUT_MS = 60_000; // 1 minute per task

export interface PlanEvent {
  planId: string;
  nodeId?: string;
  type: 'node_started' | 'node_done' | 'node_failed' | 'plan_done' | 'plan_failed' | 'progress';
  data?: any;
}

/**
 * Simulates task execution — in a real system this would dispatch to agents via A2A/MCP.
 * Returns a realistic result string for the given task.
 */
async function simulateTaskExecution(node: PlanNode): Promise<string> {
  // Simulate variable execution time (2-8 seconds)
  const ms = 2000 + Math.random() * 6000;
  await new Promise((r) => setTimeout(r, ms));

  // 10% failure rate for realism
  if (Math.random() < 0.1) {
    throw new Error(`Task execution failed: agent ${node.assignedAgent ?? 'unknown'} reported an error`);
  }

  return `✓ ${node.task} completed by ${node.assignedAgent ?? 'unassigned'} at ${new Date().toISOString()}`;
}

export class PlanExecutor extends EventEmitter {
  private runningPlans = new Map<string, AbortController>();

  constructor(
    private planner: GoalPlanner,
    private store: PlanStore
  ) {
    super();
  }

  /**
   * Start executing a plan. Runs the DAG concurrently where deps allow.
   */
  async execute(plan: Plan): Promise<void> {
    const abort = new AbortController();
    this.runningPlans.set(plan.id, abort);

    plan.status = 'running';
    this.store.save(plan);

    try {
      await this.runDAG(plan, abort.signal);

      const failed = this.planner.hasFailed(plan);
      plan.status = failed ? 'failed' : 'done';
      plan.completedAt = new Date();
      plan.progress = this.planner.computeProgress(plan);
      plan.updatedAt = new Date();
      this.store.save(plan);

      this.emit('event', {
        planId: plan.id,
        type: failed ? 'plan_failed' : 'plan_done',
      } satisfies PlanEvent);
    } catch (err: any) {
      plan.status = 'failed';
      plan.updatedAt = new Date();
      this.store.save(plan);
      this.emit('event', { planId: plan.id, type: 'plan_failed', data: err.message } satisfies PlanEvent);
    } finally {
      this.runningPlans.delete(plan.id);
    }
  }

  pause(planId: string): void {
    const ctrl = this.runningPlans.get(planId);
    if (ctrl) {
      ctrl.abort();
      const plan = this.store.get(planId);
      if (plan) {
        plan.status = 'paused';
        plan.updatedAt = new Date();
        this.store.save(plan);
      }
      this.runningPlans.delete(planId);
    }
  }

  private async runDAG(plan: Plan, signal: AbortSignal): Promise<void> {
    // Keep iterating until all nodes are terminal
    while (!this.planner.isComplete(plan)) {
      if (signal.aborted) break;

      const ready = this.planner.getReadyNodes(plan);
      if (ready.length === 0) {
        // No ready nodes but plan not complete — check for deadlock
        const running = plan.nodes.filter((n) => n.status === 'running');
        if (running.length === 0) break; // deadlock or all failed
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }

      // Launch all ready nodes concurrently
      const launches = ready.map((node) => this.runNode(plan, node, signal));
      await Promise.allSettled(launches);
    }
  }

  private async runNode(plan: Plan, node: PlanNode, signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      node.status = 'skipped';
      this.store.save(plan);
      return;
    }

    node.status = 'running';
    node.startedAt = new Date();
    plan.updatedAt = new Date();
    this.store.save(plan);

    this.emit('event', {
      planId: plan.id,
      nodeId: node.id,
      type: 'node_started',
      data: { task: node.task, agent: node.assignedAgent },
    } satisfies PlanEvent);

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (signal.aborted) {
        node.status = 'skipped';
        this.store.save(plan);
        return;
      }

      try {
        const result = await Promise.race([
          simulateTaskExecution(node),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Task timed out')), TASK_TIMEOUT_MS)
          ),
        ]);

        node.status = 'done';
        node.result = result;
        node.completedAt = new Date();
        node.retries = attempt;
        plan.progress = this.planner.computeProgress(plan);
        plan.updatedAt = new Date();
        this.store.save(plan);

        this.emit('event', {
          planId: plan.id,
          nodeId: node.id,
          type: 'node_done',
          data: { result },
        } satisfies PlanEvent);
        return;
      } catch (err: any) {
        lastError = err;
        node.retries = attempt + 1;
        if (attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        }
      }
    }

    // All retries exhausted
    node.status = 'failed';
    node.error = lastError?.message ?? 'Unknown error';
    node.completedAt = new Date();
    plan.progress = this.planner.computeProgress(plan);
    plan.updatedAt = new Date();
    this.store.save(plan);

    this.emit('event', {
      planId: plan.id,
      nodeId: node.id,
      type: 'node_failed',
      data: { error: node.error },
    } satisfies PlanEvent);
  }
}

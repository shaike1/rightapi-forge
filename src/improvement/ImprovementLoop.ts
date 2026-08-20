// ImprovementLoop — autonomous platform watchdog (v1, deterministic).
//
// Runs on a schedule (default every 15 min, opt-in via env). Each tick
// surveys the platform's operational state and takes a small bounded
// set of actions to nudge the system toward health. v1 deliberately
// does NOT use an LLM to decide what to do — every decision is
// rule-based so an operator can audit the trace cheaply. v2 will be
// allowed to call an agent for ambiguous opportunities once v1 has a
// run history that we trust.
//
// Per tick:
//   • cap of MAX_ACTIONS_PER_TICK total actions (default 3)
//   • cooldown per (action_type, target) so a single object can't be
//     hit twice in close succession
//   • one structured 'improvement_loop.tick' log + optional broadcast
//     event so the dashboard's activity feed sees the work
//
// Three opportunities in v1, ordered by impact-per-cost:
//   1. Open incident with no aiAnalysis → run analyzer (low risk,
//      idempotent — same code path as the manual UI button).
//   2. Crystallized skill in 'approved' status sitting > REVIEW_AGE_MS
//      → emit a 'draft_ready_for_review' event. Surface only — we do
//      NOT auto-promote in v1 because promoting an executable skill
//      without sandbox validation is too dangerous.
//   3. Recent task with outcome === 'failed' → emit a 'task_failed_seen'
//      event. v2 will enqueue a follow-up "investigate" task; v1 just
//      logs so failure patterns become visible.

import { createLogger } from '../observability/Logger.js';
import type { IncidentManager } from '../incidents/IncidentManager.js';
import type { IncidentAnalyzer } from '../ai/IncidentAnalyzer.js';
import type { CrystallizedSkillStore } from '../persistence/CrystallizedSkillStore.js';
import type { CrystallizationService } from '../crystallization/CrystallizationService.js';
import type { TaskManager } from '../tasks/TaskManager.js';
import type { OrganizationManager } from '../agents/Organization.js';
import type { ImprovementLoopJudge, JudgeStats } from './ImprovementLoopJudge.js';
import type { SandboxValidator } from './SandboxValidator.js';

const log = createLogger({ component: 'improvement-loop' });

// v2 confidence floors — below these the loop falls back to "surface"
// rather than acting on the LLM's verdict. Promote is highest because
// it makes a draft platform-wide executable.
const RETRY_CONFIDENCE_FLOOR    = 0.7;
const INVESTIGATE_CONFIDENCE_FLOOR = 0.7;
const CANCEL_CONFIDENCE_FLOOR   = 0.7;
const PROMOTE_CONFIDENCE_FLOOR  = 0.85;
const REJECT_CONFIDENCE_FLOOR   = 0.7;

// Dormant-agent threshold: agents with no resolutions newer than this
// get surfaced once per cooldown window.
const DORMANT_AGENT_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface ImprovementLoopDeps {
  incidentManager: IncidentManager;
  incidentAnalyzer: IncidentAnalyzer;
  crystallizationStore: CrystallizedSkillStore;
  /** Required for v2 promote/reject actions. v1 only used the store
   *  for read-only listing; v2 needs to flip lifecycle states.        */
  crystallizationService?: CrystallizationService;
  taskManager: TaskManager;
  /** Required for v2 stuck-task surveying. */
  orchestratorService?: { getStatus(): { stuckEntries?: Array<{ taskId: string }> } };
  /** Required for v2 dormant-agent detection. */
  organization?: OrganizationManager;
  /** Required when the LLM judge is enabled (v2). v1 functioned without it. */
  judge?: ImprovementLoopJudge;
  /** v3 safety layer. When provided, every draft the judge wants to
   *  promote is first executed in a sandbox; failure ⇒ hold for
   *  review. When absent, the loop falls back to v2 behavior (judge
   *  verdict alone gates the promote). */
  sandboxValidator?: SandboxValidator;
  /** Optional: WebSocket broadcaster so the dashboard's activity feed
   *  sees ticks in real time. Falls back to log-only if not provided. */
  broadcast?: (event: { type: string; data: unknown }) => void;
}

export interface ImprovementLoopOptions {
  /** Tick cadence. Default 15 min. */
  intervalMs?: number;
  /** Hard cap on total actions per tick across all opportunity types. */
  maxActionsPerTick?: number;
  /** A draft skill must sit in 'approved' status for at least this long
   *  before the loop surfaces it for review. Default 24h. */
  draftReviewAgeMs?: number;
  /** Failed tasks newer than this are considered 'recent' for surfacing.
   *  Default 1h. */
  recentFailedTaskAgeMs?: number;
  /** Per-target cooldown after we act on it. Prevents thrash on the
   *  same incident / draft / task across consecutive ticks. */
  cooldownMs?: number;
}

export type ImprovementAction =
  // v1 actions
  | { type: 'incident_analyzed'; target: string; durationMs: number }
  | { type: 'incident_analyze_failed'; target: string; err: string }
  | { type: 'draft_ready_for_review'; target: string; ageHours: number }
  | { type: 'task_failed_seen'; target: string; agentId?: string }
  // v2 actions (LLM-judged)
  | { type: 'stuck_task_retried';      target: string; reasoning: string; confidence: number }
  | { type: 'stuck_task_investigation_queued'; target: string; followupTaskId: string; reasoning: string; confidence: number }
  | { type: 'stuck_task_cancelled';    target: string; reasoning: string; confidence: number }
  | { type: 'stuck_task_surfaced';     target: string; reasoning: string; confidence: number }
  | { type: 'draft_promoted';          target: string; reasoning: string; confidence: number; sandboxMode?: string }
  | { type: 'draft_rejected';          target: string; reasoning: string; confidence: number }
  | { type: 'draft_held_for_review';   target: string; reasoning: string; confidence: number }
  // v3 — sandbox validation outcomes that block a would-be promotion.
  | { type: 'draft_sandbox_failed';    target: string; reasoning: string; confidence: number; sandboxReason: string }
  | { type: 'draft_sandbox_blocked';   target: string; reasoning: string; confidence: number; sandboxReason: string }
  | { type: 'agent_dormant';           target: string; agentName: string; lastSeenIso: string | null }
  | { type: 'judge_skipped_no_floor';  target: string; reason: string };

export interface TickSummary {
  startedAt: string;
  finishedAt: string;
  actions: ImprovementAction[];
  capped: boolean;
  durationMs: number;
}

export class ImprovementLoop {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastTickAt: Date | null = null;
  private lastSummary: TickSummary | null = null;
  private cooldowns = new Map<string, number>(); // key → expiry epoch ms
  private readonly opts: Required<ImprovementLoopOptions>;

  constructor(
    private deps: ImprovementLoopDeps,
    opts: ImprovementLoopOptions = {},
  ) {
    this.opts = {
      intervalMs:           opts.intervalMs           ?? 15 * 60 * 1000,
      maxActionsPerTick:    opts.maxActionsPerTick    ?? 3,
      draftReviewAgeMs:     opts.draftReviewAgeMs     ?? 24 * 60 * 60 * 1000,
      recentFailedTaskAgeMs: opts.recentFailedTaskAgeMs ?? 60 * 60 * 1000,
      cooldownMs:           opts.cooldownMs           ?? 60 * 60 * 1000, // 1h default
    };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch(err =>
        log.error('tick crashed', { err: err instanceof Error ? err.message : String(err) }),
      );
    }, this.opts.intervalMs);
    // Don't keep the event loop alive solely for the loop.
    if (typeof this.timer.unref === 'function') this.timer.unref();
    log.info('improvement loop started', { intervalMs: this.opts.intervalMs });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    log.info('improvement loop stopped');
  }

  isRunning(): boolean {
    return this.timer !== null;
  }

  /** Snapshot for /api/improvement-loop/status. */
  getStatus() {
    return {
      enabled: this.timer !== null,
      lastTickAt: this.lastTickAt?.toISOString() ?? null,
      lastSummary: this.lastSummary,
      options: this.opts,
      cooldownsActive: this.cooldowns.size,
      judge: this.deps.judge ? this.deps.judge.stats() : null,
    };
  }

  private toIso(d: Date | string | undefined): string {
    if (!d) return '?';
    if (d instanceof Date) return d.toISOString();
    return String(d);
  }

  /** One pass. Bounded by maxActionsPerTick. Re-entrant-safe via the
   *  `running` flag — if a previous tick is still in flight (e.g. an
   *  LLM call hung) the next interval is a no-op. */
  async tick(): Promise<TickSummary> {
    if (this.running) {
      log.warn('tick skipped — previous tick still running');
      return this.lastSummary ?? this.emptySummary();
    }
    this.running = true;
    const startedAt = new Date();
    const actions: ImprovementAction[] = [];
    let capped = false;

    try {
      // ── 1. Analyze incidents that don't have aiAnalysis yet ────────────
      const openIncidents = await Promise.resolve(
        this.deps.incidentManager.list({ status: 'open' }),
      );
      const unanalyzed = openIncidents.filter(i => !i.aiAnalysis);
      for (const inc of unanalyzed) {
        if (actions.length >= this.opts.maxActionsPerTick) { capped = true; break; }
        const key = `analyze:${inc.id}`;
        if (this.cooldownActive(key)) continue;

        const t0 = Date.now();
        try {
          // Mirror the manual /api/incidents/:id/analyze code path.
          const similar = (await Promise.resolve(
            this.deps.incidentManager.list({ severity: inc.severity }),
          )).filter(s => s.id !== inc.id).slice(0, 3);
          const analysis = await this.deps.incidentAnalyzer.analyze(inc, similar);
          this.deps.incidentManager.incidentStore.saveAnalysis(inc.id, JSON.stringify(analysis));
          actions.push({ type: 'incident_analyzed', target: inc.id, durationMs: Date.now() - t0 });
          this.setCooldown(key, this.opts.cooldownMs);
        } catch (err) {
          // Failure cooldown is shorter than success — give the upstream
          // a chance to recover (rate limit windows etc.) rather than
          // burying the same failure for an hour.
          this.setCooldown(key, Math.min(10 * 60 * 1000, this.opts.cooldownMs));
          actions.push({
            type: 'incident_analyze_failed',
            target: inc.id,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // ── 2. 'approved' drafts > review-age ─────────────────────────────
      // v1: surface only. v2: when judge is wired, ask the LLM whether
      // the workflow is safe to promote and act on the verdict (with a
      // 0.85 confidence floor — promotion makes a skill platform-wide
      // executable). Without judge, falls back to v1's "surface".
      if (!capped && actions.length < this.opts.maxActionsPerTick) {
        const drafts = await Promise.resolve(
          this.deps.crystallizationStore.list({ status: 'approved', limit: 50 }),
        );
        const now = Date.now();
        const stale = drafts.filter(d =>
          now - new Date(d.createdAt).getTime() >= this.opts.draftReviewAgeMs
        );
        for (const draft of stale) {
          if (actions.length >= this.opts.maxActionsPerTick) { capped = true; break; }
          const key = `draft_review:${draft.id}`;
          if (this.cooldownActive(key)) continue;
          const ageHours = Math.round((now - new Date(draft.createdAt).getTime()) / 3_600_000);

          if (!this.deps.judge || !this.deps.crystallizationService) {
            // v1 path: surface only
            actions.push({ type: 'draft_ready_for_review', target: draft.id, ageHours });
            this.setCooldown(key, 6 * 60 * 60 * 1000);
            continue;
          }

          // v2 path: ask the judge
          const verdict = await this.deps.judge.judgeDraftPromotion(draft, ageHours);
          if (verdict.action === 'promote' && verdict.confidence >= PROMOTE_CONFIDENCE_FLOOR) {
            // v3: actually run the workflow in a sandbox first.
            // A high-confidence judge can still be wrong about a typo
            // or a missing dependency; running the steps catches that.
            // If no sandbox validator is wired, behavior reverts to v2:
            // the judge's verdict alone gates promotion.
            if (this.deps.sandboxValidator?.isEnabled()) {
              const sandbox = await this.deps.sandboxValidator.validate(draft);
              if (!sandbox.ok) {
                const failedStep = sandbox.steps.find(s => s.status === 'failed' || s.status === 'blocked');
                const actionType = failedStep?.status === 'blocked' ? 'draft_sandbox_blocked' : 'draft_sandbox_failed';
                actions.push({
                  type: actionType,
                  target: draft.id,
                  reasoning: verdict.reasoning,
                  confidence: verdict.confidence,
                  sandboxReason: sandbox.reason ?? 'sandbox failed without reason',
                });
                // Long cooldown — once a draft fails sandbox, the LLM
                // judge will keep voting promote until the workflow is
                // edited. Hold it 24h to avoid wasting LLM tokens
                // on the same losing case.
                this.setCooldown(key, 24 * 60 * 60 * 1000);
                continue;
              }
              // Sandbox passed — fall through to actual promote.
              try {
                await this.deps.crystallizationService.promote(draft.id);
                actions.push({
                  type: 'draft_promoted', target: draft.id,
                  reasoning: verdict.reasoning, confidence: verdict.confidence,
                  sandboxMode: sandbox.mode,
                });
                this.setCooldown(key, 24 * 60 * 60 * 1000);
              } catch (err) {
                actions.push({ type: 'draft_held_for_review', target: draft.id, reasoning: `promote failed: ${err instanceof Error ? err.message : String(err)}`, confidence: verdict.confidence });
                this.setCooldown(key, 30 * 60 * 1000);
              }
              continue;
            }
            // v2 fallback: no sandbox configured.
            try {
              await this.deps.crystallizationService.promote(draft.id);
              actions.push({ type: 'draft_promoted', target: draft.id, reasoning: verdict.reasoning, confidence: verdict.confidence });
              this.setCooldown(key, 24 * 60 * 60 * 1000);
            } catch (err) {
              actions.push({ type: 'draft_held_for_review', target: draft.id, reasoning: `promote failed: ${err instanceof Error ? err.message : String(err)}`, confidence: verdict.confidence });
              this.setCooldown(key, 30 * 60 * 1000);
            }
          } else if (verdict.action === 'reject' && verdict.confidence >= REJECT_CONFIDENCE_FLOOR) {
            try {
              await this.deps.crystallizationService.reject(draft.id, undefined, verdict.reasoning);
              actions.push({ type: 'draft_rejected', target: draft.id, reasoning: verdict.reasoning, confidence: verdict.confidence });
              this.setCooldown(key, 24 * 60 * 60 * 1000);
            } catch (err) {
              actions.push({ type: 'draft_held_for_review', target: draft.id, reasoning: `reject failed: ${err instanceof Error ? err.message : String(err)}`, confidence: verdict.confidence });
              this.setCooldown(key, 30 * 60 * 1000);
            }
          } else {
            // verdict was 'review' OR confidence too low — leave it alone, surface it.
            actions.push({ type: 'draft_held_for_review', target: draft.id, reasoning: verdict.reasoning, confidence: verdict.confidence });
            this.setCooldown(key, 6 * 60 * 60 * 1000);
          }
        }
      }

      // ── 3. Recently-failed tasks (v1: surface only) ───────────────────
      if (!capped && actions.length < this.opts.maxActionsPerTick) {
        const allTasks = this.deps.taskManager.getAllTasks();
        const cutoff = Date.now() - this.opts.recentFailedTaskAgeMs;
        const recentFailed = allTasks.filter(t => {
          if (t.status !== 'failed') return false;
          const updated = t.updatedAt instanceof Date ? t.updatedAt.getTime() : new Date(t.updatedAt).getTime();
          return updated >= cutoff;
        });
        for (const t of recentFailed) {
          if (actions.length >= this.opts.maxActionsPerTick) { capped = true; break; }
          const key = `task_failed:${t.id}`;
          if (this.cooldownActive(key)) continue;
          actions.push({ type: 'task_failed_seen', target: t.id, agentId: t.assignedTo });
          this.setCooldown(key, 4 * 60 * 60 * 1000);
        }
      }

      // ── 4. v2: stuck tasks (judge-driven retry / investigate / cancel) ─
      // Pulled from the orchestrator's stuck-entries list. Without the
      // judge, this opportunity is skipped (v1 had no analogue).
      if (!capped && actions.length < this.opts.maxActionsPerTick && this.deps.judge && this.deps.orchestratorService) {
        const stuckEntries = this.deps.orchestratorService.getStatus().stuckEntries ?? [];
        for (const entry of stuckEntries) {
          if (actions.length >= this.opts.maxActionsPerTick) { capped = true; break; }
          const key = `stuck_task:${entry.taskId}`;
          if (this.cooldownActive(key)) continue;

          const task = this.deps.taskManager.getTask(entry.taskId);
          if (!task) continue;

          const verdict = await this.deps.judge.judgeStuckTask(task);
          if (verdict.action === 'retry' && verdict.confidence >= RETRY_CONFIDENCE_FLOOR) {
            try {
              this.deps.taskManager.updateTaskStatus(task.id, 'pending');
              actions.push({ type: 'stuck_task_retried', target: task.id, reasoning: verdict.reasoning, confidence: verdict.confidence });
              this.setCooldown(key, 30 * 60 * 1000);
            } catch (err) {
              actions.push({ type: 'stuck_task_surfaced', target: task.id, reasoning: `retry failed: ${err instanceof Error ? err.message : String(err)}`, confidence: verdict.confidence });
              this.setCooldown(key, 15 * 60 * 1000);
            }
          } else if (verdict.action === 'investigate' && verdict.confidence >= INVESTIGATE_CONFIDENCE_FLOOR) {
            try {
              const followup = this.deps.taskManager.createTask({
                title: `Investigate stuck task ${task.id.slice(0, 8)}`,
                description: `Original task "${task.title}" got stuck (status=${task.status}, updated=${this.toIso(task.updatedAt)}).\n\nJudge reasoning: ${verdict.reasoning}\n\nPlease diagnose what's blocking it and report findings or unblock it.`,
                ownerId: 'improvement-loop',
                category: task.category ?? 'monitoring',
                priority: 'high',
                // Routed via AgentRouter on dispatch (no fixed assignedTo)
              });
              actions.push({ type: 'stuck_task_investigation_queued', target: task.id, followupTaskId: followup.id, reasoning: verdict.reasoning, confidence: verdict.confidence });
              this.setCooldown(key, 4 * 60 * 60 * 1000);
            } catch (err) {
              actions.push({ type: 'stuck_task_surfaced', target: task.id, reasoning: `investigate failed: ${err instanceof Error ? err.message : String(err)}`, confidence: verdict.confidence });
              this.setCooldown(key, 30 * 60 * 1000);
            }
          } else if (verdict.action === 'cancel' && verdict.confidence >= CANCEL_CONFIDENCE_FLOOR) {
            try {
              this.deps.taskManager.updateTaskStatus(task.id, 'cancelled');
              actions.push({ type: 'stuck_task_cancelled', target: task.id, reasoning: verdict.reasoning, confidence: verdict.confidence });
              this.setCooldown(key, 24 * 60 * 60 * 1000);
            } catch (err) {
              actions.push({ type: 'stuck_task_surfaced', target: task.id, reasoning: `cancel failed: ${err instanceof Error ? err.message : String(err)}`, confidence: verdict.confidence });
              this.setCooldown(key, 30 * 60 * 1000);
            }
          } else {
            actions.push({ type: 'stuck_task_surfaced', target: task.id, reasoning: verdict.reasoning, confidence: verdict.confidence });
            this.setCooldown(key, 60 * 60 * 1000);
          }
        }
      }

      // ── 5. v2: dormant agents (deterministic — no LLM) ────────────────
      // Identifies agents with no resolutions newer than DORMANT_AGENT_AGE_MS.
      // Surface only; we don't auto-create tasks for them because that
      // generates LLM load every tick and rarely surfaces real issues
      // (an agent might be idle just because no work matches its skills).
      if (!capped && actions.length < this.opts.maxActionsPerTick && this.deps.organization) {
        const allAgents = this.deps.organization.getAllAgents();
        const cutoff = Date.now() - DORMANT_AGENT_AGE_MS;
        for (const agent of allAgents) {
          if (actions.length >= this.opts.maxActionsPerTick) { capped = true; break; }
          const key = `agent_dormant:${agent.id}`;
          if (this.cooldownActive(key)) continue;

          // Use the most recent task assigned to this agent as the
          // last-seen heuristic. Cheap; doesn't require touching the
          // agent-memory store directly.
          const tasks = this.deps.taskManager.getAllTasks().filter(t => t.assignedTo === agent.id);
          let lastSeenMs = 0;
          for (const t of tasks) {
            const u = t.updatedAt instanceof Date ? t.updatedAt.getTime() : new Date(t.updatedAt).getTime();
            if (u > lastSeenMs) lastSeenMs = u;
          }
          if (lastSeenMs && lastSeenMs >= cutoff) continue; // not dormant
          actions.push({
            type: 'agent_dormant',
            target: agent.id,
            agentName: agent.name,
            lastSeenIso: lastSeenMs ? new Date(lastSeenMs).toISOString() : null,
          });
          // Long cooldown — once per day is enough for a surface event.
          this.setCooldown(key, 24 * 60 * 60 * 1000);
        }
      }
    } finally {
      this.running = false;
    }

    const finishedAt = new Date();
    const summary: TickSummary = {
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      actions,
      capped,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
    };
    this.lastTickAt = startedAt;
    this.lastSummary = summary;

    log.info('improvement_loop.tick', {
      actionCount: actions.length,
      capped,
      durationMs: summary.durationMs,
      breakdown: this.breakdown(actions),
    });
    this.deps.broadcast?.({ type: 'improvement_loop.tick', data: summary });

    // Garbage-collect expired cooldowns occasionally so the map stays bounded.
    if (this.cooldowns.size > 256) this.gcCooldowns();

    return summary;
  }

  private cooldownActive(key: string): boolean {
    const expiry = this.cooldowns.get(key);
    if (expiry === undefined) return false;
    if (Date.now() >= expiry) {
      this.cooldowns.delete(key);
      return false;
    }
    return true;
  }

  private setCooldown(key: string, ms: number): void {
    this.cooldowns.set(key, Date.now() + ms);
  }

  private gcCooldowns(): void {
    const now = Date.now();
    for (const [k, expiry] of this.cooldowns) {
      if (now >= expiry) this.cooldowns.delete(k);
    }
  }

  private breakdown(actions: ImprovementAction[]): Record<string, number> {
    const out: Record<string, number> = {};
    for (const a of actions) out[a.type] = (out[a.type] ?? 0) + 1;
    return out;
  }

  private emptySummary(): TickSummary {
    const now = new Date().toISOString();
    return { startedAt: now, finishedAt: now, actions: [], capped: false, durationMs: 0 };
  }
}

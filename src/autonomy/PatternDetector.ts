// PatternDetector — find recurring command sequences across recent
// agent work so the autonomy loop can ask the SDK to crystallize the
// pattern into a reusable skill.
//
// Why this exists:
//   The crystallization analyzer scores ONE resolution at a time. It
//   sees "this trace has 4 steps and a +5 reflection" and decides
//   whether to draft a skill. What it can't see is whether the SAME
//   sequence has been done five times across five different agents in
//   the last week. That cross-task signal is what tells us a skill
//   would actually get used, vs. crystallizing a one-off curiosity.
//
// How it works:
//   1. record(): every successful task feeds a canonicalized command
//      sequence into a rolling window (default 200 most-recent tasks).
//   2. Each command is canonicalized to its "verb + first arg" so
//      `systemctl restart redis` and `systemctl restart postgres`
//      collapse to the same fingerprint (`systemctl restart`). This
//      is intentional aggressive collapsing — we're looking for
//      shape-of-work, not exact replays.
//   3. findRecurring(): groups records by sequence fingerprint, returns
//      groups with ≥ minOccurrences across ≥ minDistinctAgents.
//
// What it explicitly does NOT do:
//   • Trigger SDK calls — that's the orchestrator's job. This file
//     is pure analysis so it can be unit-tested without any side
//     effects, sandboxes, or I/O.
//   • Filter destructive patterns — the orchestrator does that gate
//     before deciding to crystallize. PatternDetector reports
//     everything that recurs.
//
// Memory bound:
//   The window is capped (default 200 traces) and we don't keep raw
//   ReactStep objects, just the canonicalized strings + light metadata.
//   At 200 traces × ~10 steps/trace × ~40 chars/step that's < 100 KB —
//   trivial.

import { createLogger } from '../observability/Logger.js';

const log = createLogger({ component: 'pattern-detector' });

export interface PatternRecord {
  taskId: string;
  agentId: string;
  /** Canonicalized command sequence (each entry is "verb arg1" or "verb -flag"). */
  sequence: string[];
  recordedAt: number;
}

export interface PatternMatch {
  fingerprint: string;
  /** How many distinct task records share this exact sequence. */
  occurrences: number;
  /** How many distinct agents produced one of those records. */
  distinctAgents: number;
  /** A real example of the sequence, for an operator / skill description. */
  representativeSequence: string[];
  /** Pulled from the most recent matching record — useful for cooldown
   *  bookkeeping ("don't fire twice on the same pattern in 24h"). */
  lastSeenAt: number;
  /** Pulled for traceability — the operator can read the original task. */
  representativeTaskId: string;
  /** The agent ids involved (deduped, capped). */
  agents: string[];
}

export interface PatternDetectorOptions {
  /** Minimum count of records sharing the fingerprint. Default 3. */
  minOccurrences?: number;
  /** Minimum count of distinct agents in the group. Default 2 — guards
   *  against "this one agent loops on the same diagnostic" false positives. */
  minDistinctAgents?: number;
  /** Rolling window size. Older records are dropped FIFO. Default 200. */
  maxRecentTasks?: number;
  /** Hard floor on sequence length. Default 2 — a single command isn't
   *  pattern enough to be worth a skill. */
  minSequenceLength?: number;
  /** Drop records older than this when scanning. Default 7 days.
   *  Keeps stale activity from triggering "patterns" months later. */
  windowMs?: number;
}

export class PatternDetector {
  private readonly opts: Required<PatternDetectorOptions>;
  /** Ring buffer in insertion order. We re-walk it on each scan. */
  private records: PatternRecord[] = [];

  constructor(opts: PatternDetectorOptions = {}) {
    this.opts = {
      minOccurrences:    opts.minOccurrences    ?? 3,
      minDistinctAgents: opts.minDistinctAgents ?? 2,
      maxRecentTasks:    opts.maxRecentTasks    ?? 200,
      minSequenceLength: opts.minSequenceLength ?? 2,
      windowMs:          opts.windowMs          ?? 7 * 24 * 60 * 60 * 1000,
    };
  }

  /**
   * Add one task's command sequence to the window. `steps` is the
   * raw ReactStep list (or anything shaped { tool, params? }); we
   * canonicalize per step.
   */
  record(taskId: string, agentId: string, steps: Array<{ tool?: string; params?: unknown; error?: string }>): void {
    const sequence: string[] = [];
    for (const s of steps) {
      if (s.error || !s.tool) continue;
      const canon = canonicalizeStep(s.tool, s.params);
      if (canon) sequence.push(canon);
    }
    if (sequence.length < this.opts.minSequenceLength) return;

    this.records.push({ taskId, agentId, sequence, recordedAt: Date.now() });
    // Drop oldest when over cap.
    while (this.records.length > this.opts.maxRecentTasks) this.records.shift();
  }

  /**
   * Returns recurring patterns. Each PatternMatch represents a sequence
   * that's been seen at least `minOccurrences` times across at least
   * `minDistinctAgents` distinct agents inside the window.
   *
   * Sorted by occurrence count desc so the orchestrator naturally hits
   * the strongest signals first within its rate budget.
   */
  findRecurring(): PatternMatch[] {
    const cutoff = Date.now() - this.opts.windowMs;
    const inWindow = this.records.filter(r => r.recordedAt >= cutoff);

    // group by fingerprint
    const groups = new Map<string, PatternRecord[]>();
    for (const r of inWindow) {
      const fp = fingerprintFor(r.sequence);
      const arr = groups.get(fp) ?? [];
      arr.push(r);
      groups.set(fp, arr);
    }

    const matches: PatternMatch[] = [];
    for (const [fp, recs] of groups) {
      if (recs.length < this.opts.minOccurrences) continue;
      const agents = Array.from(new Set(recs.map(r => r.agentId)));
      if (agents.length < this.opts.minDistinctAgents) continue;

      // representative: first record gives a real sample sequence
      const rep = recs[0];
      const lastSeen = recs.reduce((max, r) => r.recordedAt > max ? r.recordedAt : max, 0);
      matches.push({
        fingerprint: fp,
        occurrences: recs.length,
        distinctAgents: agents.length,
        representativeSequence: rep.sequence,
        lastSeenAt: lastSeen,
        representativeTaskId: rep.taskId,
        agents: agents.slice(0, 8),
      });
    }
    matches.sort((a, b) => b.occurrences - a.occurrences);
    log.info('pattern scan', { recordsInWindow: inWindow.length, matchCount: matches.length });
    return matches;
  }

  /** Test seam — clear the window. */
  reset(): void {
    this.records = [];
  }

  /** Snapshot for diagnostics. */
  size(): number {
    return this.records.length;
  }
}

/**
 * Canonicalize a ReactStep into a short shape-of-work fingerprint.
 *
 * Examples:
 *   bash.exec   "df -h /var"            → "df -h"
 *   bash.exec   "systemctl restart x"   → "systemctl restart"
 *   bash.exec   "journalctl -u redis"   → "journalctl -u"
 *   skill.foo   {}                      → "skill.foo"
 *
 * Strategy: take the first 2 whitespace-separated tokens of the bash
 * command. Two tokens captures the verb + sub-verb / first flag while
 * stripping target arguments (paths, hostnames, ids) so different
 * invocations of the same operation collapse together.
 */
export function canonicalizeStep(tool: string, params: unknown): string | null {
  if (tool === 'bash.exec') {
    const cmd = (params as { command?: unknown })?.command;
    if (typeof cmd !== 'string' || !cmd.trim()) return null;
    return canonicalizeShellCommand(cmd);
  }
  // Non-shell tools: the tool name itself is the fingerprint.
  return tool;
}

/**
 * Two-token shell signature. Exported so the orchestrator can derive
 * a human-readable description for the SDK request from the same
 * canonicalization rule.
 */
export function canonicalizeShellCommand(cmd: string): string {
  // Strip leading `sudo` / `time` / `nohup` so they don't take the verb slot.
  const stripped = cmd.trim().replace(/^(sudo|time|nohup)\s+/, '');
  const tokens = stripped.split(/\s+/);
  if (tokens.length === 0 || !tokens[0]) return '';
  if (tokens.length === 1) return tokens[0];
  return `${tokens[0]} ${tokens[1]}`;
}

function fingerprintFor(sequence: string[]): string {
  // Use a simple delimiter that won't appear in canonicalized commands.
  return sequence.join(' ⎿ ');
}

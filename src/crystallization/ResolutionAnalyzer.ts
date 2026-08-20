// Decide whether a successful resolution is worth crystallizing.
//
// Inputs the analyzer reads:
//   - the agent's ReAct trace (steps + tool params)
//   - the SelfReflector output (selfRating + lessons + tool efficiency)
//   - already-crystallized skills (for novelty checks)
//
// Output:
//   { score, recommendation, extractedCommands, reasons }
//
// We don't *do* the crystallization here — that's SkillCrystallizer's
// job. This module is only the gating layer.
//
// Scoring formula (each component 0..1, blended):
//   complexity     (0.30)  ≥ 3 distinct tool calls
//   reflectionFit  (0.30)  selfRating ≥ 4 + at least one lesson
//   novelty        (0.20)  not duplicate of an existing skill
//   repeatability  (0.20)  generalizable commands (no one-off ad-hoc fixes)
//
// Threshold: score ≥ 0.55 + at least one component ≥ 0.5 → recommend.

import { createLogger } from '../observability/Logger.js';
import type { ReactStep } from '../agents/index.js';
import type { ReflectionResult } from '../agents/index.js';
import type { CrystallizedSkill } from './CrystallizedSkillTypes.js';
import type { ExtractedCommand } from './SkillCrystallizer.js';

const log = createLogger({ component: 'resolution-analyzer' });

export interface ResolutionAnalysisInput {
  taskId: string;
  agentId: string;
  /** Resolution title from the source incident / task. Used for the
   *  novelty comparison (string overlap) + carried into the
   *  generated skill description. */
  title: string;
  category?: string;
  steps: ReactStep[];
  reflection?: ReflectionResult;
  /** Currently-crystallized skills for the agent's tenant — feeds
   *  the novelty check. */
  existingSkills: CrystallizedSkill[];
}

export interface ResolutionAnalysis {
  score: number;
  recommended: boolean;
  /** Component scores so the dashboard can show a why-this-was-picked
   *  breakdown. */
  components: {
    complexity:    number;
    reflectionFit: number;
    novelty:       number;
    repeatability: number;
  };
  reasons: string[];
  /** Extracted command sequence ready to hand to SkillCrystallizer.
   *  Populated only when recommended=true so downstream code doesn't
   *  pay the cost on rejected resolutions. */
  extractedCommands: ExtractedCommand[];
}

export interface ResolutionAnalyzerOptions {
  /** Minimum overall score to recommend. Default 0.55. */
  scoreThreshold?: number;
  /** Minimum complexity (number of distinct tool calls) to consider.
   *  Default 3. Below this, complexity always scores 0. */
  minComplexity?: number;
  /** Reflection self-rating (1..5) below which reflectionFit caps low.
   *  Default 4. */
  minSelfRating?: number;
}

export class ResolutionAnalyzer {
  private readonly scoreThreshold: number;
  private readonly minComplexity: number;
  private readonly minSelfRating: number;

  constructor(opts: ResolutionAnalyzerOptions = {}) {
    this.scoreThreshold = opts.scoreThreshold ?? 0.50;   // was 0.55
    this.minComplexity  = opts.minComplexity  ?? 2;      // was 3 — unblock 2-tool tasks
    this.minSelfRating  = opts.minSelfRating  ?? 4;
  }

  analyze(input: ResolutionAnalysisInput): ResolutionAnalysis {
    const reasons: string[] = [];
    const components = {
      complexity:    this.scoreComplexity(input.steps, reasons),
      reflectionFit: this.scoreReflectionFit(input.reflection, reasons),
      novelty:       this.scoreNovelty(input.title, input.existingSkills, reasons),
      repeatability: this.scoreRepeatability(input.steps, reasons),
    };

    const score =
        components.complexity    * 0.30
      + components.reflectionFit * 0.30
      + components.novelty       * 0.20
      + components.repeatability * 0.20;

    // Hard gates:
    //  • complexity > 0 — a 0- or 1-step task isn't worth turning into
    //    a reusable skill no matter what.
    //  • If a reflection IS present and its self-rating is below the
    //    minimum, we trust the agent's negative self-assessment and
    //    bail. (Reflection absent ≠ reflection negative — the analyzer
    //    is now allowed to score reflection-less tasks via the other
    //    components, since Agent.ts fires the crystallization hook on
    //    every successful task even when SelfReflector.shouldReflect
    //    skipped the LLM critique.)
    const reflectionExplicitlyNegative =
      input.reflection !== undefined && input.reflection.selfRating < this.minSelfRating;

    const recommended =
      components.complexity > 0
      && !reflectionExplicitlyNegative
      && score >= this.scoreThreshold;

    const extractedCommands = recommended ? this.extractCommands(input.steps) : [];

    log.info('resolution analyzed', {
      taskId: input.taskId, agentId: input.agentId,
      score, recommended, components,
    });

    return { score: round(score), recommended, components: roundComponents(components), reasons, extractedCommands };
  }

  // ── component scorers ─────────────────────────────────────────────

  private scoreComplexity(steps: ReactStep[], reasons: string[]): number {
    const successful = steps.filter(s => s.tool && !s.error);
    const distinct = new Set(successful.map(s => s.tool!));

    // Logical-command count: agents have learned to bundle multiple
    // shell commands into one bash.exec call (e.g.
    // `df -h && free -h && uptime`). The pre-fix analyzer counted that
    // as 1 step and scored complexity:0 — real multi-step diagnostic
    // work was producing zero skill drafts. Now we count chained
    // commands inside each bash.exec by splitting on &&/||/; outside
    // quotes. Non-shell tools still contribute 1 per step.
    let logicalSteps = 0;
    for (const s of successful) {
      if (s.tool === 'bash.exec' && typeof (s.params as any)?.command === 'string') {
        logicalSteps += countShellChainParts((s.params as { command: string }).command);
      } else {
        logicalSteps += 1;
      }
    }

    if (logicalSteps < this.minComplexity) {
      reasons.push(`only ${logicalSteps} logical command(s) across ${successful.length} step(s) (< ${this.minComplexity})`);
      return 0;
    }
    // Anything that passes the gate gets a 0.5 baseline — most IT-Ops
    // tasks are a chain of bash.exec calls, and we shouldn't punish
    // them for not invoking a different tool each step.
    const baseline = 0.5;
    // Up to 0.4 extra for length, plateau at 8 logical commands.
    const lengthBonus  = 0.4 * Math.min(logicalSteps, 8) / 8;
    // Up to 0.1 extra for distinct-tool variety, plateau at 3 tools.
    const distinctBonus = 0.1 * Math.min(distinct.size, 3) / 3;
    const bundled = logicalSteps > successful.length;
    reasons.push(
      `${logicalSteps} logical command(s) across ${successful.length} step(s), ` +
      `${distinct.size} distinct tool(s)${bundled ? ' (bundled bash chains expanded)' : ''}`,
    );
    return clamp(baseline + lengthBonus + distinctBonus);
  }

  private scoreReflectionFit(r: ReflectionResult | undefined, reasons: string[]): number {
    if (!r) {
      reasons.push('no reflection captured');
      return 0;
    }
    if (r.selfRating < this.minSelfRating) {
      reasons.push(`self-rating ${r.selfRating} < ${this.minSelfRating}`);
      return 0;
    }
    // 4 → 0.7, 5 → 1.0, with extras for non-empty lessons.
    const ratingScore = (r.selfRating - this.minSelfRating) / (5 - this.minSelfRating);
    const lessonsBonus = (r.lessonsLearned?.length ?? 0) > 0 ? 0.2 : 0;
    const toolBonus    = (r.toolEfficiency?.some(t => t.useful) ? 0.1 : 0);
    const score = clamp(0.6 + ratingScore * 0.2 + lessonsBonus + toolBonus);
    reasons.push(`reflection rating ${r.selfRating}/5, ${r.lessonsLearned?.length ?? 0} lesson(s)`);
    return score;
  }

  /** Cheap string-similarity novelty check. Doesn't catch every dup,
   *  but it catches the easy "we already crystallized exactly this"
   *  case where titles overlap heavily. */
  private scoreNovelty(title: string, existing: CrystallizedSkill[], reasons: string[]): number {
    if (existing.length === 0) {
      reasons.push('no prior crystallized skills');
      return 1;
    }
    const tokens = tokenize(title);
    let bestOverlap = 0;
    let bestId = '';
    for (const s of existing) {
      const overlap = jaccard(tokens, tokenize(`${s.name} ${s.description}`));
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestId = s.id;
      }
    }
    if (bestOverlap > 0.6) {
      reasons.push(`high overlap with existing skill ${bestId} (${Math.round(bestOverlap * 100)}%)`);
      return clamp(1 - bestOverlap);
    }
    if (bestOverlap > 0.3) {
      reasons.push(`partial overlap with ${bestId} (${Math.round(bestOverlap * 100)}%)`);
    }
    return clamp(1 - bestOverlap);
  }

  /** Penalize commands that look like one-off fixes (paths under
   *  /tmp/<random>, sed -i with hardcoded substitutions, "echo magic
   *  > /dev/somewhere"). Reward steady-state ops (systemctl, ping,
   *  curl, journalctl, etc.). */
  private scoreRepeatability(steps: ReactStep[], reasons: string[]): number {
    const cmds = steps
      .filter(s => s.tool === 'bash.exec' && typeof (s.params as any)?.command === 'string')
      .map(s => (s.params as { command: string }).command);
    if (cmds.length === 0) return 0.5;
    let positive = 0, negative = 0;
    for (const cmd of cmds) {
      if (REPEATABLE_RE.test(cmd))   positive++;
      if (UNREPEATABLE_RE.test(cmd)) negative++;
    }
    const ratio = (positive - negative) / cmds.length;
    const score = clamp(0.5 + ratio * 0.5);
    reasons.push(`repeatability +${positive} / -${negative} of ${cmds.length} command(s)`);
    return score;
  }

  /** Pull bash.exec commands + skill calls out of the trace, in
   *  order, deduping consecutive duplicates. */
  private extractCommands(steps: ReactStep[]): ExtractedCommand[] {
    const out: ExtractedCommand[] = [];
    let prev = '';
    for (const s of steps) {
      if (s.error) continue;
      if (s.tool === 'bash.exec' && typeof (s.params as any)?.command === 'string') {
        const text = (s.params as { command: string }).command;
        if (text === prev) continue;
        out.push({ type: 'shell', text, note: s.thought ?? truncate(s.observation ?? '', 120) });
        prev = text;
      } else if (typeof s.tool === 'string' && s.tool.includes('.')) {
        out.push({ type: 'skill', text: s.tool, note: s.thought });
      }
    }
    return out;
  }
}

// ─── helpers ───────────────────────────────────────────────────────────

const REPEATABLE_RE   = /\b(systemctl|service|ping|curl|wget|journalctl|tail|grep|df|du|free|uptime|kubectl|docker|pg_dump|psql|nslookup|dig|netstat|ss|ip\s+addr|ip\s+route)\b/i;
const UNREPEATABLE_RE = /\b(echo\s+\S+\s*>\s*\/tmp\/|sed\s+-i\s+'?s\/[^/]{20,}\/[^/]{20,}\/'?|cat\s*<<\s*EOF\s+>\s*\/tmp\/)/i;

function clamp(v: number): number { return Math.max(0, Math.min(1, v)); }
function round(v: number): number { return Math.round(v * 100) / 100; }
function roundComponents<T extends Record<string, number>>(c: T): T {
  const out = { ...c };
  for (const k of Object.keys(out)) (out as Record<string, number>)[k] = round(out[k]);
  return out;
}

function tokenize(s: string): Set<string> {
  return new Set(
    s.toLowerCase().split(/[^a-z0-9]+/)
      .filter(t => t.length > 2 && !STOPWORDS.has(t)),
  );
}
const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'that', 'this', 'task', 'after']);

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

/**
 * Count "logical commands" in a shell command line by splitting on
 * unquoted `&&`, `||`, and `;` separators. Pipes (`|`) are NOT split:
 * `df -h | grep /` is one logical operation.
 *
 * This is intentionally a tiny scanner, not a full shell parser:
 * it tracks single/double/backtick quote state so that
 * `echo "a && b"` correctly counts as 1, but it doesn't try to
 * understand `$()` substitution, escape sequences past simple
 * backslash, or here-docs. False positives in those edge cases
 * lead to a slightly inflated complexity score, never a crash.
 *
 * Always returns ≥ 1 — an empty / whitespace-only string still
 * represents one (no-op) command from the agent's POV.
 */
export function countShellChainParts(command: string): number {
  if (!command) return 1;
  let count = 1;
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    const next = command[i + 1];
    // Skip backslash-escaped chars in unquoted / double-quoted contexts.
    if (ch === '\\' && !inSingle) { i++; continue; }
    if (ch === "'" && !inDouble && !inBacktick) { inSingle = !inSingle; continue; }
    if (ch === '"' && !inSingle && !inBacktick) { inDouble = !inDouble; continue; }
    if (ch === '`' && !inSingle && !inDouble) { inBacktick = !inBacktick; continue; }
    if (inSingle || inDouble || inBacktick) continue;
    if ((ch === '&' && next === '&') || (ch === '|' && next === '|')) {
      count++;
      i++; // skip the second char of the operator
      continue;
    }
    if (ch === ';') {
      count++;
    }
  }
  return count;
}

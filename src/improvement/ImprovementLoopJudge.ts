// ImprovementLoopJudge — LLM-driven verdicts for the improvement loop's
// ambiguous opportunities (v2).
//
// Each method takes a structured situation, asks the LLM for a JSON
// verdict { action, reasoning, confidence }, and returns it. Failures
// (no provider, malformed JSON, network error) fall back to the
// safest "surface" / "review" default with confidence=0 so the loop's
// action layer can choose to do nothing.
//
// Why a separate file: keeps the deterministic v1 path testable without
// loading the AI provider; lets us A/B-toggle LLM use via
// IMPROVEMENT_LOOP_JUDGE_ENABLED without touching the loop's core logic.

import type { AIProviderFactory } from '../ai/factory.js';
import type { AIPlatform } from '../ai/base.js';
import { createLogger } from '../observability/Logger.js';
import type { Task } from '../types/index.js';
import type { CrystallizedSkill } from '../crystallization/CrystallizedSkillTypes.js';

const log = createLogger({ component: 'improvement-loop-judge' });

const SYSTEM_PROMPT = `You are an SRE judge for an autonomous IT operations platform.
You receive structured situations and return verdict JSON.

Hard rules:
- Output ONLY valid JSON. No prose, no markdown, no \`\`\` fences.
- Required fields: action (one of the allowed enum values for the situation),
  reasoning (one or two short sentences), confidence (0..1).
- Be conservative. Default to "surface" / "review" when unsure (confidence < 0.7).
- "retry" is appropriate ONLY if the prior failure looks transient (timeout,
  rate limit, agent restart). Never retry a task whose description references
  destructive operations.
- "investigate" creates a follow-up task for another agent — appropriate when
  the task body needs human-grade reasoning to unblock.
- "cancel" is for tasks that are clearly no longer relevant or duplicate work
  already done. Use sparingly.
- "promote" makes a draft skill executable. ONLY at high confidence and ONLY
  when the workflow is clearly safe (no rm -rf, no curl|sh, no destructive
  systemctl/disk operations without an approval gate, parameters look sane).
- "reject" deletes a draft. Use when the workflow contains dangerous patterns
  or is malformed beyond repair.
`;

export interface StuckTaskVerdict {
  action: 'retry' | 'investigate' | 'surface' | 'cancel';
  reasoning: string;
  confidence: number;
}

export interface DraftVerdict {
  action: 'promote' | 'reject' | 'review';
  reasoning: string;
  confidence: number;
}

export interface JudgeStats {
  queries: number;
  successes: number;
  failures: number;
}

export class ImprovementLoopJudge {
  private platform: AIPlatform;
  private queries = 0;
  private successes = 0;
  private failures = 0;

  constructor(
    private factory: AIProviderFactory,
    platform: AIPlatform = 'claude',
  ) {
    this.platform = platform;
  }

  stats(): JudgeStats {
    return { queries: this.queries, successes: this.successes, failures: this.failures };
  }

  async judgeStuckTask(task: Task): Promise<StuckTaskVerdict> {
    const prompt = `STUCK TASK:
ID: ${task.id}
Title: ${task.title}
Description: ${(task.description || '').slice(0, 600)}
Status: ${task.status}
Priority: ${task.priority}
Category: ${task.category ?? '(none)'}
Created: ${this.toIso(task.createdAt)}
Last updated: ${this.toIso(task.updatedAt)}
Assigned to agent: ${task.assignedTo ?? '(none)'}

This task has been flagged as stuck (no progress past the configured
threshold). Decide what to do.

Allowed action values: "retry" | "investigate" | "surface" | "cancel"

Return ONLY valid JSON of shape:
{"action":"...","reasoning":"...","confidence":0.0-1.0}`;
    return this.run<StuckTaskVerdict>(prompt, {
      action: 'surface', reasoning: 'judge unavailable; default to surface', confidence: 0,
    });
  }

  async judgeDraftPromotion(skill: CrystallizedSkill, ageHours: number): Promise<DraftVerdict> {
    let parsedWf: unknown = null;
    try { parsedWf = JSON.parse(skill.generatedWorkflow); } catch { /* leave as null */ }
    const wf = parsedWf as { steps?: Array<{ id?: string; type?: string; command?: string }> } | null;
    const stepCount = Array.isArray(wf?.steps) ? wf!.steps.length : 0;
    const stepSummary = Array.isArray(wf?.steps)
      ? wf!.steps.slice(0, 8)
          .map(s => `${s.id ?? '?'}: type=${s.type ?? '?'} cmd=${(s.command ?? '').slice(0, 120)}`)
          .join('\n  ')
      : '(workflow JSON unparseable)';

    const prompt = `CRYSTALLIZED SKILL DRAFT — promotion decision:

Name: ${skill.name}
Description: ${skill.description}
Source agent: ${skill.sourceAgentId}
Confidence at creation: ${skill.confidenceScore}
Tags: ${(skill.tags || []).join(', ') || '(none)'}
Status: ${skill.status} (sitting unpromoted ${ageHours}h)

Workflow has ${stepCount} step(s):
  ${stepSummary}

Decide whether this is safe + useful enough to make executable platform-wide.

Allowed action values: "promote" | "reject" | "review"
- "promote": well-formed, no destructive commands without an approval_gate,
  parameters look sane. ≥0.85 confidence required by caller.
- "reject": contains dangerous patterns (rm -rf, curl | sh, destructive
  systemctl on critical services, hardcoded credentials, etc.) or workflow
  is malformed beyond repair.
- "review": anything else; safer default.

Return ONLY valid JSON of shape:
{"action":"...","reasoning":"...","confidence":0.0-1.0}`;
    return this.run<DraftVerdict>(prompt, {
      action: 'review', reasoning: 'judge unavailable; default to review', confidence: 0,
    });
  }

  private async run<T>(userPrompt: string, fallback: T): Promise<T> {
    this.queries++;
    try {
      const provider = await this.factory.getProvider(this.platform);
      const resp = await provider.chat({
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
        maxTokens: 400,
        temperature: 0.2,
      });
      // Defensive: even though the prompt forbids fences, Claude
      // sometimes adds them anyway. Strip + parse + fall back if any
      // step throws.
      const cleaned = resp.content
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```\s*$/, '')
        .trim();
      const parsed = JSON.parse(cleaned) as T;
      this.successes++;
      log.info('judge verdict', { verdict: parsed });
      return parsed;
    } catch (err) {
      this.failures++;
      log.warn('judge run failed; using fallback', {
        err: err instanceof Error ? err.message : String(err),
      });
      return fallback;
    }
  }

  private toIso(d: Date | string | undefined): string {
    if (!d) return '?';
    if (d instanceof Date) return d.toISOString();
    return String(d);
  }
}

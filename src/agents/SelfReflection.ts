// Self-reflection module — runs after a task completes, asks the LLM to
// critique its own ReAct trace, and produces a structured ReflectionResult.
//
// The reflection is fed back into the agent_reflections store and (next task)
// re-injected into the system prompt so the agent literally learns from its
// own mistakes. Trivial tasks (1-2 iterations, no errors) are skipped to
// preserve LLM tokens — `shouldReflect` is the gate.
//
// The module is provider-agnostic: it asks any AIProvider (Claude, OpenAI,
// Ollama, …) to return JSON, parses defensively, and falls back to a minimal
// trace-derived reflection if the LLM is unavailable or returns garbage.

import type { AIProviderFactory } from '../ai/factory.js';
import type { AIPlatform, Task } from '../types/index.js';
import type { ExecuteTaskResult, ReactStep } from './Agent.js';

export interface ReflectionResult {
  taskId: string;
  agentId: string;
  selfRating: number; // 1-5
  whatWorked: string[];
  whatDidntWork: string[];
  lessonsLearned: string[];
  suggestedImprovements: string[];
  toolEfficiency: Array<{ tool: string; useful: boolean; reason: string }>;
  wouldDoDifferently: string;
  timestamp: string;
}

export interface ReflectInput {
  task: Task;
  agentId: string;
  agentName: string;
  agentRole: string;
  agentPlatform: AIPlatform;
  detailed: ExecuteTaskResult;
}

export class SelfReflector {
  constructor(private aiFactory: AIProviderFactory) {}

  /**
   * Decide whether reflection is worth the LLM call. Reflect when:
   *   • the agent took ≥ 3 ReAct iterations (genuine multi-step reasoning), OR
   *   • any step errored out (always learn from failures), OR
   *   • the outcome was partial / failed.
   * Skip trivial 1-2 step successes — there's nothing useful to extract.
   */
  static shouldReflect(detailed: ExecuteTaskResult): boolean {
    if (detailed.iterations >= 3) return true;
    if (detailed.outcome !== 'success') return true;
    if (detailed.steps.some(s => s.error)) return true;
    return false;
  }

  async reflect(input: ReflectInput): Promise<ReflectionResult> {
    const traceSummary = this.summariseTrace(input.detailed.steps);

    try {
      const provider = await this.aiFactory.getProvider(input.agentPlatform);
      const response = await provider.chat({
        system: SYSTEM_PROMPT,
        messages: [{
          role: 'user',
          content: this.buildReflectionPrompt(input, traceSummary),
        }],
        // Reflection is short — keep it bounded.
        maxTokens: 800,
        temperature: 0.2,
      });
      const parsed = this.parseReflection(response.content);
      return this.finalise(parsed, input);
    } catch {
      // LLM unreachable or refused — synthesise a minimal reflection from
      // the trace alone so the dashboard / lesson-injection layer still has
      // something to work with.
      return this.fallbackReflection(input, traceSummary);
    }
  }

  // ─── Prompt + parsing ────────────────────────────────────────────────────

  private buildReflectionPrompt(input: ReflectInput, traceSummary: string): string {
    return [
      `You just finished executing a task. Critique your own performance honestly — your`,
      `reflection feeds back into your future system prompt, so vague filler hurts you.`,
      ``,
      `Agent: ${input.agentName} (${input.agentRole})`,
      `Task: ${input.task.title}`,
      `Description: ${input.task.description || '(none)'}`,
      `Outcome: ${input.detailed.outcome}`,
      `Iterations: ${input.detailed.iterations}`,
      `Duration: ${input.detailed.durationMs}ms`,
      `Final answer: ${input.detailed.result.slice(0, 400)}`,
      ``,
      `ReAct trace (newest last):`,
      traceSummary,
      ``,
      `Reflect on:`,
      `  1. Did you use the right tools? Was there a faster path?`,
      `  2. Did you make wrong assumptions that cost extra iterations?`,
      `  3. What should you do differently next time for a similar task?`,
      `  4. Rate your performance 1-5 (1 = wasted iterations, 5 = optimal path).`,
      ``,
      `Reply with EXACTLY this JSON shape, no prose around it:`,
      `{`,
      `  "selfRating": <integer 1-5>,`,
      `  "whatWorked": ["..."],`,
      `  "whatDidntWork": ["..."],`,
      `  "lessonsLearned": ["..."],`,
      `  "suggestedImprovements": ["..."],`,
      `  "toolEfficiency": [{"tool": "<name>", "useful": <bool>, "reason": "..."}],`,
      `  "wouldDoDifferently": "..."`,
      `}`,
      ``,
      `Be terse. Each list item one short sentence. Empty list is fine if nothing applies.`,
    ].join('\n');
  }

  /** Compact trace representation — strips long observations / params. */
  private summariseTrace(steps: ReactStep[]): string {
    if (!steps.length) return '(no steps recorded)';
    return steps.map((s, i) => {
      const parts = [`${i + 1}.`];
      if (s.thought) parts.push(`thought: ${s.thought.slice(0, 120)}`);
      if (s.tool) parts.push(`action: ${s.tool}(${truncate(JSON.stringify(s.params ?? {}), 80)})`);
      if (s.error) parts.push(`error: ${s.error.slice(0, 120)}`);
      else if (s.observation) parts.push(`obs: ${truncate(s.observation, 200)}`);
      return parts.join(' | ');
    }).join('\n');
  }

  /** Extract the JSON object from a possibly-noisy LLM response. */
  private parseReflection(raw: string): Partial<ReflectionResult> {
    if (!raw) throw new Error('empty response');
    // Some models wrap JSON in ```json fences — strip them.
    const fenced = raw.match(/```(?:json)?\s*([\s\S]+?)```/);
    const candidate = fenced ? fenced[1] : raw;
    const objMatch = candidate.match(/\{[\s\S]+\}/);
    if (!objMatch) throw new Error('no JSON object in response');
    return JSON.parse(objMatch[0]);
  }

  private finalise(parsed: Partial<ReflectionResult>, input: ReflectInput): ReflectionResult {
    const rating = clampRating(parsed.selfRating);
    return {
      taskId: input.task.id,
      agentId: input.agentId,
      selfRating: rating,
      whatWorked: ensureStringArray(parsed.whatWorked),
      whatDidntWork: ensureStringArray(parsed.whatDidntWork),
      lessonsLearned: ensureStringArray(parsed.lessonsLearned),
      suggestedImprovements: ensureStringArray(parsed.suggestedImprovements),
      toolEfficiency: ensureToolEfficiency(parsed.toolEfficiency),
      wouldDoDifferently: typeof parsed.wouldDoDifferently === 'string'
        ? parsed.wouldDoDifferently
        : '',
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * No-LLM path: derive a structural reflection from the trace itself. Lets
   * the persistence + dashboard layers stay populated even on demo / offline
   * runs. Rating is conservative because the agent didn't get to grade itself.
   */
  private fallbackReflection(input: ReflectInput, traceSummary: string): ReflectionResult {
    const errored = input.detailed.steps.filter(s => s.error);
    const tools = uniqueTools(input.detailed.steps);
    const rating = input.detailed.outcome === 'success'
      ? (errored.length === 0 ? 4 : 3)
      : input.detailed.outcome === 'partial' ? 2 : 1;

    return {
      taskId: input.task.id,
      agentId: input.agentId,
      selfRating: rating,
      whatWorked: input.detailed.outcome === 'success'
        ? [`Reached a Final Answer in ${input.detailed.iterations} iteration(s).`]
        : [],
      whatDidntWork: errored.map(s => `${s.tool ?? 'step'} failed: ${(s.error ?? '').slice(0, 80)}`),
      lessonsLearned: [],
      suggestedImprovements: errored.length > 0
        ? [`Investigate ${errored[0].tool ?? 'failing step'} before re-attempting this kind of task.`]
        : [],
      toolEfficiency: tools.map(t => ({ tool: t, useful: true, reason: 'used during trace (LLM critique unavailable)' })),
      wouldDoDifferently: input.detailed.outcome === 'failed'
        ? `Try a different tool path; trace was: ${truncate(traceSummary, 200)}`
        : '',
      timestamp: new Date().toISOString(),
    };
  }
}

const SYSTEM_PROMPT = `You are a self-reflection module. Your sole job is to critique a single completed task trace and emit a JSON object with rating, lessons, and tool feedback. Be honest, terse, and specific. Output ONLY JSON — no preamble, no markdown.`;

function ensureStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === 'string')
    .map(s => s.trim())
    .filter(Boolean)
    .slice(0, 8);
}

function ensureToolEfficiency(value: unknown): ReflectionResult['toolEfficiency'] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry: any) => ({
      tool: typeof entry?.tool === 'string' ? entry.tool : '',
      useful: typeof entry?.useful === 'boolean' ? entry.useful : true,
      reason: typeof entry?.reason === 'string' ? entry.reason.trim() : '',
    }))
    .filter(e => e.tool.length > 0)
    .slice(0, 12);
}

function clampRating(v: unknown): number {
  const n = typeof v === 'number' ? Math.round(v) : Number(v);
  if (!Number.isFinite(n)) return 3;
  return Math.min(5, Math.max(1, n));
}

function uniqueTools(steps: ReactStep[]): string[] {
  return Array.from(new Set(steps.map(s => s.tool).filter((t): t is string => !!t)));
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// Per-agent personality profile that evolves over time.
//
// What "evolves" means here: the agent's communication style + decision
// preferences + expertise areas + learned behaviours are stored in a
// structured profile, and the PersonalityEngine adjusts it based on
// signals — explicit user feedback, self-reflection outcomes, and
// successful resolution patterns. The profile is consumed by
// buildSystemPromptFragment() to compose a prompt extension that the
// Agent injects on every LLM call, making the evolution observable in
// the agent's behaviour without rewriting the base prompt.
//
// This is intentionally additive: agents that don't have a profile
// (existing deployments before this commit) keep working with their
// static system prompts. The engine creates a profile on first signal,
// not at agent registration, so the storage stays sparse.
//
// Guardrails are enforced by clampProfile(): every numeric trait is
// kept inside [PROFILE_MIN, PROFILE_MAX], every string list capped to a
// fixed length, and a per-update delta cap prevents one runaway signal
// from flipping the profile. PROFILE_DRIFT_LIMIT bounds how far any
// single trait can move from its constructor-assigned baseline; cross
// it and the engine clamps + emits a personality.drift_clamped event.

export const PROFILE_MIN = 0;
export const PROFILE_MAX = 1;
/** Per-update delta cap. Prevents one strong-negative feedback from
 *  collapsing a trait to 0 in a single step. */
export const PROFILE_DELTA_PER_UPDATE = 0.15;
/** Cap on how far a trait may drift from the role baseline (computed
 *  at first profile creation). The engine clamps to baseline ± this. */
export const PROFILE_DRIFT_LIMIT = 0.40;
/** Bounded list lengths so a chatty profile doesn't blow up. */
export const MAX_EXPERTISE_AREAS  = 8;
export const MAX_LEARNED_BEHAVIOURS = 12;
export const MAX_AVOID_PATTERNS     = 12;

/** Communication style — drives tone in the system-prompt fragment. */
export interface CommunicationStyle {
  /** 0 = curt / "exit 0", 1 = expansive / explanatory. */
  verbosity: number;
  /** 0 = casual, 1 = formal. */
  formality: number;
  /** 0 = pure prose, 1 = bullet-heavy / structured. */
  structure: number;
  /** 0 = avoid emojis entirely, 1 = use freely. */
  emoji: number;
}

/** How the agent decides + acts. */
export interface DecisionPreferences {
  /** 0 = wait for explicit approval, 1 = act fast within scope. */
  autonomy: number;
  /** 0 = risk-averse (prefer rollback-ready ops), 1 = risk-tolerant. */
  riskTolerance: number;
  /** 0 = single-shot answers, 1 = exhaustive multi-step plans. */
  thoroughness: number;
  /** 0 = ask once, 1 = ask many clarifying questions. */
  curiosity: number;
}

export interface PersonalityProfile {
  /** Profile version — bump when shape changes. Used by the store to
   *  reject incompatible older rows on read. */
  schemaVersion: 1;
  agentId: string;
  /** Captured the first time the profile is created so the drift-limit
   *  guardrail has a stable reference point even after many updates. */
  baseline: { communication: CommunicationStyle; decisions: DecisionPreferences };
  communication: CommunicationStyle;
  decisions: DecisionPreferences;
  /** Skills / domains the agent has demonstrated proficiency in. */
  expertiseAreas: string[];
  /** Plain-prose lessons the agent has internalised. Each entry should
   *  be one short sentence; the engine truncates aggressively. */
  learnedBehaviours: string[];
  /** Anti-patterns the agent has been corrected on. Becomes
   *  "Avoid: ..." in the system-prompt fragment. */
  avoidPatterns: string[];
  /** Aggregate counters — read by the engine to weight signals. */
  stats: {
    feedbackPositive: number;
    feedbackNegative: number;
    reflectionsRecorded: number;
    successesRecorded: number;
    failuresRecorded: number;
    /** Number of times the drift-limit guardrail clamped an update. */
    driftClamps: number;
  };
  createdAt: string;
  updatedAt: string;
}

/** Default trait values per role. Used at profile creation; the
 *  baseline copy stays put across updates. */
export function defaultProfile(agentId: string, role: string): PersonalityProfile {
  const base = defaultsForRole(role);
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    agentId,
    baseline: { communication: { ...base.communication }, decisions: { ...base.decisions } },
    communication: { ...base.communication },
    decisions:     { ...base.decisions },
    expertiseAreas: [],
    learnedBehaviours: [],
    avoidPatterns: [],
    stats: {
      feedbackPositive: 0,
      feedbackNegative: 0,
      reflectionsRecorded: 0,
      successesRecorded: 0,
      failuresRecorded: 0,
      driftClamps: 0,
    },
    createdAt: now,
    updatedAt: now,
  };
}

function defaultsForRole(role: string): { communication: CommunicationStyle; decisions: DecisionPreferences } {
  // Roles tuned for the existing agent catalogue. Director is more
  // formal + more thorough; sysadmin is faster + risk-aware; specialist
  // is balanced; everything else uses the universal default.
  switch (role) {
    case 'director':
      return {
        communication: { verbosity: 0.6, formality: 0.7, structure: 0.7, emoji: 0.0 },
        decisions:     { autonomy: 0.4, riskTolerance: 0.3, thoroughness: 0.8, curiosity: 0.5 },
      };
    case 'sysadmin':
      return {
        communication: { verbosity: 0.4, formality: 0.5, structure: 0.6, emoji: 0.0 },
        decisions:     { autonomy: 0.6, riskTolerance: 0.4, thoroughness: 0.6, curiosity: 0.4 },
      };
    case 'specialist':
      return {
        communication: { verbosity: 0.5, formality: 0.5, structure: 0.6, emoji: 0.0 },
        decisions:     { autonomy: 0.5, riskTolerance: 0.4, thoroughness: 0.7, curiosity: 0.6 },
      };
    default:
      return {
        communication: { verbosity: 0.5, formality: 0.5, structure: 0.5, emoji: 0.0 },
        decisions:     { autonomy: 0.5, riskTolerance: 0.4, thoroughness: 0.6, curiosity: 0.5 },
      };
  }
}

/** Re-clamp every trait to [MIN, MAX] and trim every list to its cap.
 *  The engine calls this after every adjustment; calling it on read is
 *  defensive too — older rows that predate a list-cap bump get trimmed
 *  to current limits transparently. */
export function clampProfile(p: PersonalityProfile): PersonalityProfile {
  const clamp = (v: number) => Math.min(PROFILE_MAX, Math.max(PROFILE_MIN, v));
  const driftClamp = (v: number, baseline: number) => {
    const lo = Math.max(PROFILE_MIN, baseline - PROFILE_DRIFT_LIMIT);
    const hi = Math.min(PROFILE_MAX, baseline + PROFILE_DRIFT_LIMIT);
    return Math.min(hi, Math.max(lo, v));
  };
  const dedupTrim = (xs: string[], cap: number): string[] =>
    Array.from(new Set(xs.map(s => s.trim()).filter(Boolean))).slice(-cap);

  return {
    ...p,
    communication: {
      verbosity:  driftClamp(clamp(p.communication.verbosity),  p.baseline.communication.verbosity),
      formality:  driftClamp(clamp(p.communication.formality),  p.baseline.communication.formality),
      structure:  driftClamp(clamp(p.communication.structure),  p.baseline.communication.structure),
      emoji:      driftClamp(clamp(p.communication.emoji),      p.baseline.communication.emoji),
    },
    decisions: {
      autonomy:        driftClamp(clamp(p.decisions.autonomy),        p.baseline.decisions.autonomy),
      riskTolerance:   driftClamp(clamp(p.decisions.riskTolerance),   p.baseline.decisions.riskTolerance),
      thoroughness:    driftClamp(clamp(p.decisions.thoroughness),    p.baseline.decisions.thoroughness),
      curiosity:       driftClamp(clamp(p.decisions.curiosity),       p.baseline.decisions.curiosity),
    },
    expertiseAreas:    dedupTrim(p.expertiseAreas,    MAX_EXPERTISE_AREAS),
    learnedBehaviours: dedupTrim(p.learnedBehaviours, MAX_LEARNED_BEHAVIOURS),
    avoidPatterns:     dedupTrim(p.avoidPatterns,     MAX_AVOID_PATTERNS),
  };
}

/** Compose a prompt fragment from a profile. The Agent appends this to
 *  its base system prompt on every LLM call. Stable order so prompt
 *  caches don't churn on irrelevant reorderings. */
export function buildSystemPromptFragment(p: PersonalityProfile): string {
  const lines: string[] = ['', '## Personality (evolved over time)'];

  lines.push(`Communication: ${describeStyle(p.communication)}`);
  lines.push(`Decision style: ${describeDecisions(p.decisions)}`);

  if (p.expertiseAreas.length > 0) {
    lines.push(`Expertise areas: ${p.expertiseAreas.join(', ')}`);
  }
  if (p.learnedBehaviours.length > 0) {
    lines.push('Learned behaviours:');
    for (const b of p.learnedBehaviours) lines.push(`- ${b}`);
  }
  if (p.avoidPatterns.length > 0) {
    lines.push('Avoid:');
    for (const a of p.avoidPatterns) lines.push(`- ${a}`);
  }
  return lines.join('\n');
}

function describeStyle(c: CommunicationStyle): string {
  return [
    c.verbosity < 0.35 ? 'concise' : c.verbosity > 0.65 ? 'expansive' : 'balanced verbosity',
    c.formality < 0.35 ? 'casual'  : c.formality > 0.65 ? 'formal'    : 'professional tone',
    c.structure > 0.65 ? 'prefer bulleted lists' : c.structure < 0.35 ? 'flowing prose' : 'mix prose with lists',
    c.emoji     > 0.65 ? 'emojis welcome'         : c.emoji < 0.20    ? 'no emojis'      : 'emojis sparingly',
  ].join('; ');
}

function describeDecisions(d: DecisionPreferences): string {
  return [
    d.autonomy < 0.35      ? 'wait for approval on changes'    : d.autonomy > 0.65      ? 'act decisively within scope'   : 'balance autonomy with confirmation',
    d.riskTolerance < 0.35 ? 'risk-averse'                     : d.riskTolerance > 0.65 ? 'comfortable taking risks'       : 'measured risk',
    d.thoroughness > 0.65  ? 'plan exhaustively'               : d.thoroughness < 0.35  ? 'one-shot answers'                : 'reasonable thoroughness',
    d.curiosity > 0.65     ? 'ask clarifying questions early'  : d.curiosity < 0.35     ? 'minimise back-and-forth'         : 'ask when ambiguous',
  ].join('; ');
}

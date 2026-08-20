// Adjusts a PersonalityProfile based on incoming signals and exposes
// a system-prompt fragment derived from the current profile.
//
// Signals the engine consumes:
//   - recordFeedback(agentId, rating, note?)  : explicit user feedback
//                                               (thumbs up = +1, down = -1)
//   - recordReflection(agentId, reflection)   : SelfReflector output
//   - recordResolution(agentId, outcome)      : task success / failure
//   - recordCorrection(agentId, avoid, ...)   : explicit "don't do X"
//
// What changes per signal:
//   - Positive feedback nudges the *current* communication style toward
//     "what worked" (no-op for now beyond stat counter — the next
//     correction or reflection actually moves traits). Successful
//     resolutions bump thoroughness slightly (the agent is good at
//     this; lean in).
//   - Negative feedback shrinks autonomy + verbosity slightly.
//   - Reflections with selfRating ≥ 4 bake the lessons into
//     learnedBehaviours; ratings ≤ 2 add the "wouldDoDifferently"
//     hint to avoidPatterns.
//   - recordCorrection is a hard signal: caller-supplied avoid pattern
//     goes straight in.
//
// Guardrails (in PersonalityProfile.clampProfile):
//   - Per-update delta cap so one signal can't move a trait > 0.15.
//   - Drift limit: trait stays within baseline ± 0.40.
//   - Bounded list lengths; FIFO eviction with dedup.
//
// All adjustments go through clampProfile() before save, so the
// guardrails are enforced at one place — no caller can sidestep them
// even by reaching for the store directly.

import { createLogger } from '../../observability/Logger.js';
import type { PersonalityStore } from '../../persistence/index.js';
import {
  buildSystemPromptFragment,
  clampProfile,
  defaultProfile,
  PROFILE_DELTA_PER_UPDATE,
  type PersonalityProfile,
} from './PersonalityProfile.js';

const log = createLogger({ component: 'personality-engine' });

/** Thin shape from SelfReflector — the engine reads only what it needs. */
export interface ReflectionSignal {
  selfRating: number;
  whatWorked: string[];
  whatDidntWork: string[];
  lessonsLearned: string[];
  wouldDoDifferently?: string;
  toolEfficiency?: Array<{ tool: string; useful: boolean }>;
}

export interface ResolutionSignal {
  outcome: 'success' | 'partial' | 'failed';
  /** Topic / category the agent worked in. Bubbles up into expertise
   *  areas after enough successes. */
  topic?: string;
}

/** Public side-effect-free hook used by code that wants to know how
 *  the engine moved a profile (events, audits). */
export interface AdjustmentRecord {
  agentId: string;
  signal: 'feedback' | 'reflection' | 'resolution' | 'correction';
  before: PersonalityProfile;
  after: PersonalityProfile;
}

export interface PersonalityEngineDeps {
  store: PersonalityStore;
  /** Called whenever a profile changes — used to emit a personality.*
   *  event from the wiring layer. The engine itself doesn't depend on
   *  the EventBus to keep this module test-isolated. */
  onAdjustment?: (rec: AdjustmentRecord) => void;
  now?: () => Date;
}

export class PersonalityEngine {
  private readonly store: PersonalityStore;
  private readonly onAdjustment?: (rec: AdjustmentRecord) => void;
  private readonly now: () => Date;

  constructor(deps: PersonalityEngineDeps) {
    this.store = deps.store;
    this.onAdjustment = deps.onAdjustment;
    this.now = deps.now ?? (() => new Date());
  }

  /** Get-or-create. The role is needed only when the profile is
   *  brand-new (defaults are role-tuned) — once the profile exists,
   *  role isn't re-read from the agent config. */
  async ensure(agentId: string, role: string): Promise<PersonalityProfile> {
    const existing = await Promise.resolve(this.store.get(agentId));
    if (existing) return existing;
    const fresh = clampProfile(defaultProfile(agentId, role));
    fresh.createdAt = this.now().toISOString();
    fresh.updatedAt = fresh.createdAt;
    await Promise.resolve(this.store.upsert(fresh));
    return fresh;
  }

  async get(agentId: string): Promise<PersonalityProfile | null> {
    return Promise.resolve(this.store.get(agentId));
  }

  async list(): Promise<PersonalityProfile[]> {
    return Promise.resolve(this.store.list());
  }

  /** Synthesise the system-prompt fragment for an agent. Returns "" if
   *  no profile exists so callers can concatenate unconditionally. */
  async getPromptFragment(agentId: string): Promise<string> {
    const p = await this.get(agentId);
    if (!p) return '';
    return buildSystemPromptFragment(p);
  }

  // ── Signal handlers ────────────────────────────────────────────────

  /** Explicit user feedback. rating: 1 = thumbs up, -1 = thumbs down. */
  async recordFeedback(agentId: string, rating: 1 | -1, note?: string): Promise<PersonalityProfile> {
    return this.adjust(agentId, 'feedback', (p) => {
      if (rating === 1) {
        p.stats.feedbackPositive++;
        // Reinforce thoroughness mildly when feedback is positive.
        nudge(p, ['decisions', 'thoroughness'], +0.04);
      } else {
        p.stats.feedbackNegative++;
        // Negative feedback nudges autonomy down + structure up so the
        // next interaction is more deliberate + clearer.
        nudge(p, ['decisions', 'autonomy'],   -0.05);
        nudge(p, ['communication', 'structure'], +0.04);
        if (note && note.trim()) addAvoid(p, note.trim());
      }
    });
  }

  /** Result from SelfReflector. */
  async recordReflection(agentId: string, r: ReflectionSignal): Promise<PersonalityProfile> {
    return this.adjust(agentId, 'reflection', (p) => {
      p.stats.reflectionsRecorded++;
      // High self-rating: bake the lessons in.
      if (r.selfRating >= 4) {
        for (const lesson of r.lessonsLearned.slice(0, 3)) addBehaviour(p, lesson);
        // Tools the agent rated useful become expertise hints.
        if (r.toolEfficiency) {
          for (const t of r.toolEfficiency.filter(x => x.useful).slice(0, 2)) {
            addExpertise(p, t.tool);
          }
        }
      }
      // Low self-rating: pin the avoid pattern and dial back autonomy.
      if (r.selfRating <= 2) {
        if (r.wouldDoDifferently) addAvoid(p, r.wouldDoDifferently);
        for (const w of r.whatDidntWork.slice(0, 2)) addAvoid(p, w);
        nudge(p, ['decisions', 'autonomy'], -0.04);
      }
    });
  }

  async recordResolution(agentId: string, sig: ResolutionSignal): Promise<PersonalityProfile> {
    return this.adjust(agentId, 'resolution', (p) => {
      if (sig.outcome === 'success') {
        p.stats.successesRecorded++;
        if (sig.topic) addExpertise(p, sig.topic);
      } else {
        p.stats.failuresRecorded++;
        // Failed resolutions reduce risk tolerance slightly.
        nudge(p, ['decisions', 'riskTolerance'], -0.05);
      }
    });
  }

  /** Direct operator correction — the most authoritative signal. */
  async recordCorrection(agentId: string, avoid: string, opts?: { dropAutonomy?: boolean }): Promise<PersonalityProfile> {
    return this.adjust(agentId, 'correction', (p) => {
      addAvoid(p, avoid);
      if (opts?.dropAutonomy) nudge(p, ['decisions', 'autonomy'], -0.10);
    });
  }

  // ── Internals ──────────────────────────────────────────────────────

  /** Mutator wrapper: load profile → run mutator → clamp → save → emit. */
  private async adjust(
    agentId: string,
    signal: AdjustmentRecord['signal'],
    mutate: (p: PersonalityProfile) => void,
  ): Promise<PersonalityProfile> {
    const existing = await Promise.resolve(this.store.get(agentId));
    if (!existing) {
      // The engine refuses to invent a profile mid-feedback; the agent
      // bootstrap path (Agent.attachPersonalityEngine) is expected to
      // call ensure() once. Surfacing a clear error here beats silently
      // creating a default profile and then immediately mutating it.
      throw new Error(`no personality profile for agent "${agentId}" — call ensure() at agent bootstrap`);
    }

    // Deep clone so the "before" snapshot is stable even after mutate().
    const before = JSON.parse(JSON.stringify(existing)) as PersonalityProfile;
    const draft  = JSON.parse(JSON.stringify(existing)) as PersonalityProfile;
    mutate(draft);
    draft.updatedAt = this.now().toISOString();
    const after = clampProfile(draft);

    // Tally drift clamps: if any trait touched the drift limit, log it.
    if (clampedDrift(before, after, draft)) {
      after.stats.driftClamps++;
      log.warn('personality drift clamped', {
        agentId, signal, driftClamps: after.stats.driftClamps,
      });
    }

    await Promise.resolve(this.store.upsert(after));
    if (this.onAdjustment) this.onAdjustment({ agentId, signal, before, after });
    return after;
  }
}

// ─── helpers ───────────────────────────────────────────────────────────

function nudge(
  p: PersonalityProfile,
  path: ['communication' | 'decisions', string],
  delta: number,
): void {
  const capped = Math.max(-PROFILE_DELTA_PER_UPDATE, Math.min(PROFILE_DELTA_PER_UPDATE, delta));
  const obj = (p[path[0]] as unknown as Record<string, number>);
  obj[path[1]] = (obj[path[1]] ?? 0) + capped;
}

function addBehaviour(p: PersonalityProfile, b: string): void {
  if (!b || !b.trim()) return;
  const trimmed = b.trim().slice(0, 160);
  p.learnedBehaviours = p.learnedBehaviours.filter(x => x !== trimmed);
  p.learnedBehaviours.push(trimmed);
}
function addAvoid(p: PersonalityProfile, a: string): void {
  if (!a || !a.trim()) return;
  const trimmed = a.trim().slice(0, 160);
  p.avoidPatterns = p.avoidPatterns.filter(x => x !== trimmed);
  p.avoidPatterns.push(trimmed);
}
function addExpertise(p: PersonalityProfile, e: string): void {
  if (!e || !e.trim()) return;
  const trimmed = e.trim().slice(0, 60);
  p.expertiseAreas = p.expertiseAreas.filter(x => x !== trimmed);
  p.expertiseAreas.push(trimmed);
}

/** Returns true if clampProfile() actually pulled any trait back —
 *  i.e. the proposed mutation hit the drift guardrail. */
function clampedDrift(_before: PersonalityProfile, after: PersonalityProfile, draft: PersonalityProfile): boolean {
  const keys: Array<['communication' | 'decisions', string]> = [
    ['communication', 'verbosity'], ['communication', 'formality'],
    ['communication', 'structure'], ['communication', 'emoji'],
    ['decisions', 'autonomy'],      ['decisions', 'riskTolerance'],
    ['decisions', 'thoroughness'],  ['decisions', 'curiosity'],
  ];
  for (const [section, field] of keys) {
    const a = (after[section]  as unknown as Record<string, number>)[field];
    const d = (draft[section]  as unknown as Record<string, number>)[field];
    if (Math.abs(a - d) > 1e-9) return true;
  }
  return false;
}

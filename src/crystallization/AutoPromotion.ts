// Lifecycle policy for crystallized skills.
//
// Status flow:
//   draft → approved   when confidence ≥ 0.8 AND source rating ≥ 4
//   approved → active  after 3+ usages with 100% success rate
//   active → draft     when last 5 outcomes have < 50% success rate
//   *  → rejected      manual only (the operator)
//
// AutoPromotion is a pure decision engine: given a skill, return
// the recommended next status (or null when no change is warranted).
// The caller (CrystallizationService) wires the recommendation into
// the store + emits the lifecycle event.

import { createLogger } from '../observability/Logger.js';
import type { CrystallizedSkill, CrystallizedSkillStatus } from './CrystallizedSkillTypes.js';

const log = createLogger({ component: 'auto-promotion' });

export interface AutoPromotionDecision {
  /** Next status, or null when the skill should stay where it is. */
  next: CrystallizedSkillStatus | null;
  reason: string;
}

export interface AutoPromotionOptions {
  /** Min confidence for draft → approved. Default 0.8. */
  approveConfidenceThreshold?: number;
  /** Min usage count for approved → active. Default 3. */
  promoteMinUsages?: number;
  /** Min success rate (over the last N) for approved → active. Default 1.0 (100%). */
  promoteMinSuccessRate?: number;
  /** Min source self-rating for draft → approved. Default 4. */
  approveMinSourceRating?: number;
  /** Window length for active → draft demotion. Default 5. */
  demotionWindow?: number;
  /** Below-this success rate over the window triggers demotion. Default 0.5. */
  demotionThreshold?: number;
}

export class AutoPromotion {
  private readonly approveConfidenceThreshold: number;
  private readonly approveMinSourceRating:     number;
  private readonly promoteMinUsages:           number;
  private readonly promoteMinSuccessRate:      number;
  private readonly demotionWindow:             number;
  private readonly demotionThreshold:          number;

  constructor(opts: AutoPromotionOptions = {}) {
    this.approveConfidenceThreshold = opts.approveConfidenceThreshold ?? 0.8;
    this.approveMinSourceRating     = opts.approveMinSourceRating     ?? 4;
    this.promoteMinUsages           = opts.promoteMinUsages           ?? 3;
    this.promoteMinSuccessRate      = opts.promoteMinSuccessRate      ?? 1.0;
    this.demotionWindow             = opts.demotionWindow             ?? 5;
    this.demotionThreshold          = opts.demotionThreshold          ?? 0.5;
  }

  /** Decide what to do at crystallization time — i.e. when a fresh
   *  draft has been created and we want to know whether to fast-track
   *  it to "approved". `sourceRating` comes from the SelfReflector
   *  output that fed the analyzer. */
  decideOnCreate(skill: CrystallizedSkill, sourceRating: number | undefined): AutoPromotionDecision {
    if (skill.status !== 'draft') {
      return { next: null, reason: `not in draft (was ${skill.status})` };
    }
    if (skill.confidenceScore < this.approveConfidenceThreshold) {
      return { next: null, reason: `confidence ${skill.confidenceScore.toFixed(2)} < ${this.approveConfidenceThreshold}` };
    }
    if (typeof sourceRating !== 'number' || sourceRating < this.approveMinSourceRating) {
      return { next: null, reason: `source rating ${sourceRating ?? '∅'} < ${this.approveMinSourceRating}` };
    }
    const reason = `auto-approve (conf=${skill.confidenceScore.toFixed(2)}, rating=${sourceRating})`;
    log.info('auto-promotion: approve', { id: skill.id, reason });
    return { next: 'approved', reason };
  }

  /** Decide what to do after a usage row has been appended. Drives
   *  approved → active and active → draft transitions. */
  decideOnUsage(skill: CrystallizedSkill): AutoPromotionDecision {
    if (skill.status === 'approved') {
      const window = skill.recentUsage;
      const successCount = window.filter(u => u.outcome === 'success').length;
      const allSuccess = window.length > 0 && successCount === window.length;
      if (skill.usageCount >= this.promoteMinUsages && allSuccess
          && successRate(window) >= this.promoteMinSuccessRate) {
        const reason = `auto-promote to active (uses=${skill.usageCount}, all-success in last ${window.length})`;
        log.info('auto-promotion: promote', { id: skill.id, reason });
        return { next: 'active', reason };
      }
      return { next: null, reason: 'approved → waiting for promotion criteria' };
    }
    if (skill.status === 'active') {
      const window = skill.recentUsage.slice(-this.demotionWindow);
      if (window.length >= this.demotionWindow) {
        const rate = successRate(window);
        if (rate < this.demotionThreshold) {
          const reason = `demote to draft (success ${(rate * 100).toFixed(0)}% over last ${window.length})`;
          log.warn('auto-promotion: demote', { id: skill.id, reason });
          return { next: 'draft', reason };
        }
      }
      return { next: null, reason: 'active → success rate within bounds' };
    }
    return { next: null, reason: `no auto-action for status=${skill.status}` };
  }
}

function successRate(usage: CrystallizedSkill['recentUsage']): number {
  if (usage.length === 0) return 0;
  const ok = usage.filter(u => u.outcome === 'success').length;
  return ok / usage.length;
}

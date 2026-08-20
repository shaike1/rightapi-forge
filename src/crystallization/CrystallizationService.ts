// Orchestrator that wires the crystallization pipeline end-to-end.
//
// Public surface:
//   - onResolutionCompleted(input)   ← hooked into Agent.ts after reflection
//   - approve / reject / promote     ← driven by API endpoints
//   - recordUsage                    ← called when a crystallized skill runs
//   - listSkills / getSkill          ← read paths the dashboard uses
//
// What this module guarantees:
//   - Rate limit (max N drafts per agent per UTC day)
//   - Destructive commands force draft + skip auto-promotion
//   - Every state change emits a typed event so the dashboard sees
//     it in real time
//   - Newly-active skills are registered with the SkillManager via
//     a caller-supplied `registerActive` hook, demoted skills are
//     unregistered through the matching `unregisterActive` hook —
//     keeping the service module-clean (no hard import on
//     SkillManager/SkillPluginLoader).

import { randomUUID } from 'crypto';
import { createLogger } from '../observability/Logger.js';
import { SYSTEM_TENANT_ID } from '../tenancy/index.js';
import type { CrystallizedSkillStore } from '../persistence/index.js';
import { ResolutionAnalyzer, type ResolutionAnalysisInput } from './ResolutionAnalyzer.js';
import { SkillCrystallizer } from './SkillCrystallizer.js';
import { AutoPromotion, type AutoPromotionDecision } from './AutoPromotion.js';
import type {
  CrystallizedSkill,
  CrystallizedSkillStatus,
  CrystallizedSkillUsage,
} from './CrystallizedSkillTypes.js';

const log = createLogger({ component: 'crystallization' });

/** Event payload emitted on every lifecycle change. The wiring layer
 *  (server.ts) maps these to EventBus.publish() with a stable
 *  aggregate type. */
export interface CrystallizationEvent {
  type:
    | 'crystallization.created'
    | 'crystallization.skipped'
    | 'crystallization.promoted'
    | 'crystallization.demoted'
    | 'crystallization.approved'
    | 'crystallization.rejected'
    | 'crystallization.usage_recorded'
    | 'crystallization.flagged_destructive';
  /** The skill the event is about (when applicable). */
  skillId?: string;
  agentId: string;
  tenantId: string;
  reason?: string;
  /** Optional analysis snapshot for created/skipped events. */
  analysis?: { score: number; recommended: boolean };
  /** Lifecycle delta for promotion / demotion events. */
  from?: CrystallizedSkillStatus;
  to?: CrystallizedSkillStatus;
}

export interface CrystallizationServiceDeps {
  store: CrystallizedSkillStore;
  /** Called when a skill becomes "active" — the wiring layer
   *  registers it with SkillPluginLoader so it shows up under
   *  /api/skills. Returning false means the registration failed and
   *  the service will roll back the status change. */
  registerActive?: (skill: CrystallizedSkill) => Promise<boolean> | boolean;
  /** Called when an active skill is demoted/rejected. Symmetric with
   *  registerActive — best-effort; failures are logged. */
  unregisterActive?: (skillId: string) => Promise<void> | void;
  /** Sink for lifecycle events. Defaults to a no-op so unit tests
   *  can run without an EventBus. */
  onEvent?: (event: CrystallizationEvent) => void;

  analyzer?: ResolutionAnalyzer;
  crystallizer?: SkillCrystallizer;
  autoPromotion?: AutoPromotion;

  /** Max new drafts per agent per UTC day. Default 5. */
  maxDraftsPerAgentPerDay?: number;
}

export class CrystallizationService {
  private readonly store: CrystallizedSkillStore;
  private readonly registerActive?: CrystallizationServiceDeps['registerActive'];
  private readonly unregisterActive?: CrystallizationServiceDeps['unregisterActive'];
  private readonly onEvent: NonNullable<CrystallizationServiceDeps['onEvent']>;
  private readonly analyzer: ResolutionAnalyzer;
  private readonly crystallizer: SkillCrystallizer;
  private readonly autoPromotion: AutoPromotion;
  private readonly maxDraftsPerAgentPerDay: number;

  constructor(deps: CrystallizationServiceDeps) {
    this.store              = deps.store;
    this.registerActive     = deps.registerActive;
    this.unregisterActive   = deps.unregisterActive;
    this.onEvent            = deps.onEvent ?? (() => {});
    this.analyzer           = deps.analyzer       ?? new ResolutionAnalyzer();
    this.crystallizer       = deps.crystallizer   ?? new SkillCrystallizer();
    this.autoPromotion      = deps.autoPromotion  ?? new AutoPromotion();
    this.maxDraftsPerAgentPerDay = deps.maxDraftsPerAgentPerDay ?? 5;
  }

  /** Hook called from Agent.ts after a successful task + reflection. */
  async onResolutionCompleted(input: ResolutionAnalysisInput & { resolutionId: string }): Promise<CrystallizedSkill | null> {
    const tenantId = SYSTEM_TENANT_ID;

    // Rate-limit before doing anything expensive.
    const draftsToday = await Promise.resolve(this.store.countDraftsTodayByAgent(input.agentId, tenantId));
    if (draftsToday >= this.maxDraftsPerAgentPerDay) {
      this.emit({
        type: 'crystallization.skipped', agentId: input.agentId, tenantId,
        reason: `rate-limit (${draftsToday}/${this.maxDraftsPerAgentPerDay} drafts today)`,
      });
      return null;
    }

    const analysis = this.analyzer.analyze(input);
    if (!analysis.recommended) {
      this.emit({
        type: 'crystallization.skipped', agentId: input.agentId, tenantId,
        reason: `score=${analysis.score} (below threshold)`,
        analysis: { score: analysis.score, recommended: false },
      });
      return null;
    }

    const result = this.crystallizer.crystallize({
      commands: analysis.extractedCommands,
      context: {
        title: input.title,
        category: input.category,
        selfRating: input.reflection?.selfRating,
        lessonsLearned: input.reflection?.lessonsLearned,
      },
    });

    const now = new Date().toISOString();
    const skill: CrystallizedSkill = {
      id: `cskill-${randomUUID()}`,
      tenantId,
      name: result.name,
      description: result.description,
      sourceResolutionId: input.resolutionId,
      sourceAgentId: input.agentId,
      generatedWorkflow: JSON.stringify(result.workflow),
      parameters: result.parameters,
      tags: result.tags,
      status: 'draft',
      confidenceScore: analysis.score,
      usageCount: 0,
      recentUsage: [],
      createdAt: now,
      updatedAt: now,
    };
    await Promise.resolve(this.store.upsert(skill));

    this.emit({
      type: 'crystallization.created',
      skillId: skill.id, agentId: input.agentId, tenantId,
      analysis: { score: analysis.score, recommended: true },
    });

    if (result.containsDestructive) {
      // Destructive content forces manual review. We DO NOT
      // auto-promote — the operator has to look.
      this.emit({
        type: 'crystallization.flagged_destructive',
        skillId: skill.id, agentId: input.agentId, tenantId,
        reason: result.destructiveReasons.join(', '),
      });
      return skill;
    }

    // Run the create-time auto-promotion pass.
    const decision = this.autoPromotion.decideOnCreate(skill, input.reflection?.selfRating);
    if (decision.next) {
      await this.applyDecision(skill, decision);
    }
    return skill;
  }

  /** Approve a draft. Manual operator action. */
  async approve(id: string, tenantId?: string): Promise<CrystallizedSkill | null> {
    const skill = await Promise.resolve(this.store.get(id, tenantId));
    if (!skill) return null;
    if (skill.status === 'rejected') {
      throw new Error('cannot approve a rejected skill');
    }
    await Promise.resolve(this.store.setStatus(id, 'approved', tenantId));
    const updated = (await Promise.resolve(this.store.get(id, tenantId)))!;
    this.emit({ type: 'crystallization.approved', skillId: id, agentId: skill.sourceAgentId, tenantId: skill.tenantId,
                from: skill.status, to: 'approved' });
    return updated;
  }

  /** Reject a skill (any status). Active rejections also unregister
   *  the skill from SkillManager. Rejected skills stay in the store
   *  for audit but the auto-promotion engine ignores them. */
  async reject(id: string, tenantId?: string, reason?: string): Promise<CrystallizedSkill | null> {
    const skill = await Promise.resolve(this.store.get(id, tenantId));
    if (!skill) return null;
    if (skill.status === 'active' && this.unregisterActive) {
      try { await this.unregisterActive(id); } catch (err) {
        log.warn('unregisterActive failed during reject', { id, err: errMsg(err) });
      }
    }
    await Promise.resolve(this.store.setStatus(id, 'rejected', tenantId));
    const updated = (await Promise.resolve(this.store.get(id, tenantId)))!;
    this.emit({ type: 'crystallization.rejected', skillId: id, agentId: skill.sourceAgentId, tenantId: skill.tenantId,
                from: skill.status, to: 'rejected', reason });
    return updated;
  }

  /** Force-promote: draft|approved → active. Used by the dashboard's
   *  "promote now" button; bypasses the auto-promotion gate. */
  async promote(id: string, tenantId?: string): Promise<CrystallizedSkill | null> {
    const skill = await Promise.resolve(this.store.get(id, tenantId));
    if (!skill) return null;
    if (skill.status === 'active')   return skill;
    if (skill.status === 'rejected') throw new Error('cannot promote a rejected skill');
    await this.applyDecision(skill, { next: 'active', reason: 'manual-promote' });
    return Promise.resolve(this.store.get(id, tenantId));
  }

  /** Append a usage row + run the on-usage auto-promotion pass. */
  async recordUsage(id: string, usage: CrystallizedSkillUsage, tenantId?: string): Promise<CrystallizedSkill | null> {
    const updated = await Promise.resolve(this.store.recordUsage(id, usage, tenantId));
    if (!updated) return null;
    this.emit({ type: 'crystallization.usage_recorded', skillId: id, agentId: updated.sourceAgentId, tenantId: updated.tenantId });
    const decision = this.autoPromotion.decideOnUsage(updated);
    if (decision.next) {
      await this.applyDecision(updated, decision);
    }
    return Promise.resolve(this.store.get(id, tenantId));
  }

  // ─── read paths ───────────────────────────────────────────────────

  listSkills(filter: Parameters<CrystallizedSkillStore['list']>[0] = {}): Promise<CrystallizedSkill[]> {
    return Promise.resolve(this.store.list(filter));
  }
  getSkill(id: string, tenantId?: string): Promise<CrystallizedSkill | null> {
    return Promise.resolve(this.store.get(id, tenantId));
  }

  // ─── internals ────────────────────────────────────────────────────

  private async applyDecision(skill: CrystallizedSkill, decision: AutoPromotionDecision): Promise<void> {
    const next = decision.next!;
    const from = skill.status;

    // Side effects ordering: register BEFORE flipping the status, so
    // a registration failure leaves the row in its prior state.
    if (next === 'active' && this.registerActive) {
      const registered = await this.registerActive({ ...skill, status: 'active' });
      if (!registered) {
        log.warn('skill registration refused; staying in current status', { id: skill.id, from });
        return;
      }
    }
    if ((from === 'active') && next !== 'active' && this.unregisterActive) {
      try { await this.unregisterActive(skill.id); }
      catch (err) { log.warn('unregisterActive failed during transition', { id: skill.id, err: errMsg(err) }); }
    }

    await Promise.resolve(this.store.setStatus(skill.id, next, skill.tenantId));
    this.emit({
      type: next === 'draft' ? 'crystallization.demoted' : 'crystallization.promoted',
      skillId: skill.id, agentId: skill.sourceAgentId, tenantId: skill.tenantId,
      from, to: next, reason: decision.reason,
    });
  }

  private emit(event: CrystallizationEvent): void {
    try { this.onEvent(event); } catch (err) {
      log.warn('crystallization event sink threw', { err: errMsg(err) });
    }
  }
}

function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }

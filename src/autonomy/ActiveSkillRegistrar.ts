// ActiveSkillRegistrar — bridges crystallized skills (active status)
// into the SkillManager dispatch table so agents can call them by
// name from their ReAct loop, just like any built-in skill.
//
// Why this matters:
//   Before this bridge, an "active" CrystallizedSkill was registered
//   ONLY with the WorkflowRegistry and reachable only via
//   POST /api/workflows/json/:id/run. Agents can't reach for that —
//   their tool catalogue is whatever skillManager.getAll() lists.
//   So a freshly-promoted skill effectively died the moment it was
//   promoted: it existed but was invisible to the systems supposed
//   to use it.
//
// After: every active crystallized skill becomes a SkillManager
// entry whose handler invokes WorkflowJsonExecutor with the stored
// workflow JSON. Skill IDs are namespaced as `crystal.<slug>` so
// they never collide with built-ins, and SkillPluginLoader's
// "don't shadow a built-in" guard still works (the registrar refuses
// to register a skill whose id is in skillManager.isBuiltin()).
//
// The registrar is fed by:
//   • CrystallizationService.registerActive (transition into active)
//   • boot-time replay (every active skill in the store)
//   • CrystallizationService.unregisterActive (transition out)

import type { Skill } from '../types/index.js';
import type { SkillManager } from '../skills/SkillManager.js';
import type { WorkflowJsonExecutor } from '../workflows/WorkflowJsonExecutor.js';
import type { CrystallizedSkill } from '../crystallization/CrystallizedSkillTypes.js';
import { encode, fail, ok } from '../skills/SkillResult.js';
import { createLogger } from '../observability/Logger.js';

const log = createLogger({ component: 'active-skill-registrar' });

/** SkillManager namespaces every executable command as `<skillId>.<command>`.
 *  We pick `crystal.<id>` so listing/filtering can fence them off. */
function skillIdFor(crystallizedId: string): string {
  // Drop the cskill- prefix if present, hyphenate to keep URL-safe.
  const slug = crystallizedId.replace(/^cskill-/, '').replace(/[^a-zA-Z0-9_-]+/g, '-');
  return `crystal.${slug}`;
}

export interface ActiveSkillRegistrarDeps {
  skillManager: SkillManager;
  workflowExecutor: WorkflowJsonExecutor;
}

export class ActiveSkillRegistrar {
  /** Map of crystallizedSkill.id → registered SkillManager skill id.
   *  Lets unregister() find the entry to drop without re-deriving the id
   *  (the slug rules might change in a future minor without anyone
   *  noticing it broke unregister). */
  private readonly registered = new Map<string, string>();

  constructor(private deps: ActiveSkillRegistrarDeps) {}

  /**
   * Register `skill` with the SkillManager. Returns true when registered;
   * false on any of the safety refusals:
   *   - skill.status !== 'active' (caller must promote first)
   *   - generated workflow JSON unparseable
   *   - slugged id collides with a built-in (refuse to shadow)
   *   - already registered (idempotent re-register replaces the entry)
   *
   * Failures are logged but never thrown — registration is best-effort,
   * and a malformed crystallization shouldn't crash the loop that
   * triggered it.
   */
  register(skill: CrystallizedSkill): boolean {
    if (skill.status !== 'active') {
      log.warn('refusing to register non-active crystallized skill', { id: skill.id, status: skill.status });
      return false;
    }

    let workflow: Record<string, unknown>;
    try {
      workflow = JSON.parse(skill.generatedWorkflow);
    } catch (err) {
      log.warn('crystallized skill workflow unparseable', { id: skill.id, err: err instanceof Error ? err.message : String(err) });
      return false;
    }

    const sid = skillIdFor(skill.id);
    if (this.deps.skillManager.isBuiltin(sid)) {
      log.warn('refusing to shadow a built-in skill id', { id: sid });
      return false;
    }

    const skillDef: Skill = {
      id: sid,
      name: skill.name,
      description: skill.description || `Crystallized from agent work; promoted via the autonomy loop.`,
      category: 'general' as Skill['category'],
      enabled: true,
      commands: [
        {
          name: 'run',
          description: `Execute the crystallized workflow "${skill.name}".`,
          handler: 'run',
          parameters: skill.parameters?.reduce<Record<string, unknown>>((acc, p) => {
            acc[p.name] = { type: p.type, required: p.required, description: p.description ?? '' };
            return acc;
          }, {}) ?? {},
        },
      ],
    };

    // SkillManager calls executor[<command>](params, ctx). Our handler is
    // 'run', so we expose a method named `run`. It returns an encoded
    // SkillResult string the way every other executor does.
    const executor = {
      run: async (params: Record<string, unknown> = {}): Promise<string> => {
        try {
          const wfDef = workflow as unknown as import('../workflows/WorkflowDef.js').WorkflowDef;
          const record = await this.deps.workflowExecutor.execute(wfDef, { inputs: params });
          if (record.outcome === 'completed') {
            return encode(ok(
              { runId: record.runId, steps: record.steps },
              `crystallized skill ${skill.name} completed`,
            ));
          }
          return encode(fail(`crystallized skill ${skill.name} ${record.outcome}: ${record.error ?? '<no detail>'}`));
        } catch (err) {
          return encode(fail(`crystallized skill ${skill.name} threw: ${err instanceof Error ? err.message : String(err)}`));
        }
      },
    };

    // SkillManager.registerWithExecutor overwrites cleanly when called
    // with the same id — no need to unregister first.
    this.deps.skillManager.registerWithExecutor(skillDef, executor as any);
    this.registered.set(skill.id, sid);
    log.info('crystallized skill registered in SkillManager', {
      crystallizedId: skill.id, skillId: sid, commands: skillDef.commands.length,
    });
    return true;
  }

  /** Drop a previously-registered skill. Idempotent — false return means
   *  the skill wasn't registered (so nothing to do). */
  unregister(crystallizedId: string): boolean {
    const sid = this.registered.get(crystallizedId);
    if (!sid) return false;
    const removed = this.deps.skillManager.unregister(sid);
    this.registered.delete(crystallizedId);
    if (removed) log.info('crystallized skill unregistered from SkillManager', { crystallizedId, skillId: sid });
    return removed;
  }

  /** True when this registrar has the skill currently registered. */
  isRegistered(crystallizedId: string): boolean {
    return this.registered.has(crystallizedId);
  }

  /** Snapshot for debugging / diagnostics. */
  list(): Array<{ crystallizedId: string; skillId: string }> {
    return Array.from(this.registered.entries()).map(([crystallizedId, skillId]) => ({ crystallizedId, skillId }));
  }
}

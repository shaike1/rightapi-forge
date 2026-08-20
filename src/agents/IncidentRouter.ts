// pickAgentForIncident
//
// Choose which agent should be assigned an incident. Reuses
// AgentRouter's keyword scoring (skill keywords, role keywords) and
// adds a load penalty from AgentWorkloadTracker so a busy agent isn't
// stacked with a second incident when an idle peer is available.
//
// Selection order:
//   1. Score every agent via AgentRouter against the incident
//      title + description. Apply a -20 load penalty per current
//      assignment (most agents will have 0 or 1).
//   2. Hard-prefer non-director roles when severity != critical —
//      directors coordinate, they don't run runbooks. Critical
//      incidents bypass that filter so they reach a body if no
//      sysadmin/specialist matches.
//   3. If still nothing, fall back to round-robin over sysadmins,
//      then specialists, then the director (only as last resort).
//
// Returns null only when the organization has zero agents at all —
// the fallback chain guarantees a pick otherwise. The returned object
// uses the agent's id + display name so callers can wire incident
// fields and timeline entries without re-resolving.

import type { Agent } from './Agent.js';
import { AgentRouter } from './AgentRouter.js';
import type { AgentWorkloadTracker } from './AgentWorkloadTracker.js';
import type { AgentSpecialization } from './AgentSpecialization.js';
import { AFFINITY_BONUS_PER_MATCH } from './AgentSpecialization.js';

export interface IncidentRoutingInput {
  id: string;
  title: string;
  description?: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  /** Optional — when set, agents with this server in their affinity list
   *  get a score bonus. Without it, affinity is ignored entirely. */
  serverId?: string | null;
}

export interface IncidentRoutingPick {
  agent: Agent;
  reason: string;
  score: number;
}

export interface PickAgentOpts {
  workload?: AgentWorkloadTracker;
  /** Optional — used to add an affinity bonus when the incident has a
   *  serverId. Absent ⇒ affinity is ignored (back-compat path). */
  specialization?: AgentSpecialization;
  /** Bounded historical outcome signal. Positive values reward agents
   *  with verified/assisted outcomes; negative values demote failures. */
  outcomeScore?: (agentId: string) => { bonus: number; samples: number; successRate: number | null };
}

/** Accepts either the legacy positional workload arg or an options
 *  object. Existing callers pass `workload` directly; the new path
 *  passes `{ workload, specialization }`. */
export function pickAgentForIncident(
  incident: IncidentRoutingInput,
  agents: Agent[],
  optsOrWorkload?: AgentWorkloadTracker | PickAgentOpts,
): IncidentRoutingPick | null {
  if (agents.length === 0) return null;

  const opts: PickAgentOpts =
    optsOrWorkload && 'list' in optsOrWorkload  // AgentWorkloadTracker has .list()
      ? { workload: optsOrWorkload as AgentWorkloadTracker }
      : (optsOrWorkload as PickAgentOpts) ?? {};
  const workload = opts.workload;
  const specialization = opts.specialization;

  const taskText = `${incident.title} ${incident.description ?? ''}`.trim();

  // Body candidates first — sysadmins + specialists. Director is the
  // coordinator and is held back unless there's no body to assign.
  const isCritical = incident.severity === 'critical';
  const bodyAgents = agents.filter(a => a.role === 'sysadmin' || a.role === 'specialist');
  const pool = bodyAgents.length > 0 ? bodyAgents : agents;

  const router = new AgentRouter();
  const ranked = router.scoreAll({ task: taskText }, pool);

  const withLoad: IncidentRoutingPick[] = ranked.map(r => {
    const load = workload?.getStatus(r.agent.id).status === 'busy' ? -20 : 0;
    // Affinity bonus only fires when the incident carries a serverId
    // AND the specialization store is wired. Without either, the score
    // matches the legacy keyword + load result.
    const affinityHit =
      incident.serverId && specialization
        ? specialization.hasAffinity(r.agent.id, incident.serverId)
        : false;
    const affinity = affinityHit ? AFFINITY_BONUS_PER_MATCH : 0;
    const historical = opts.outcomeScore?.(r.agent.id);
    const outcomeBonus = Math.min(10, Math.max(-10, historical?.bonus || 0));
    let reason = affinityHit
      ? `${r.reason} +affinity(${incident.serverId})`
      : r.reason;
    if (historical && historical.samples >= 3) {
      reason += ` +outcomes(${Math.round((historical.successRate || 0) * 100)}%,${outcomeBonus >= 0 ? '+' : ''}${outcomeBonus})`;
    }
    return { agent: r.agent, reason, score: r.score + load + affinity + outcomeBonus };
  });
  withLoad.sort((a, b) => b.score - a.score);

  const top = withLoad[0];
  if (top && top.score > 0) return top;

  // No keyword hits — use round-robin so we still distribute load
  // instead of always picking the same agent. But: if the incident has
  // a serverId AND any body agent has affinity to it, prefer that subset
  // over the broader pool. This is the "no keywords matched but Diana
  // owns vps3, give it to her" path.
  const minute = Math.floor(Date.now() / 60000);
  if (bodyAgents.length > 0) {
    let preferredPool = bodyAgents;
    if (incident.serverId && specialization) {
      const specialists = bodyAgents.filter(a =>
        specialization.hasAffinity(a.id, incident.serverId!),
      );
      if (specialists.length > 0) preferredPool = specialists;
    }
    // Prefer idle agents in the round-robin if we have a workload tracker.
    const idle = workload
      ? preferredPool.filter(a => workload.getStatus(a.id).status === 'idle')
      : [];
    const orderedPool = idle.length > 0 ? idle : preferredPool;
    const pick = orderedPool[minute % orderedPool.length];
    const reason = preferredPool === bodyAgents
      ? 'round-robin (no keyword match)'
      : `affinity round-robin (${incident.serverId})`;
    return { agent: pick, reason, score: 0 };
  }

  // Last resort: critical incident with no body agents — assign the
  // director so something happens.
  if (isCritical || bodyAgents.length === 0) {
    return { agent: agents[0], reason: 'fallback (no body agents)', score: 0 };
  }

  return null;
}

// AgentWorkloadTracker
//
// In-memory record of which agent is currently working on which incident,
// persisted to a small JSON file so state survives a restart.
//
// Why this exists: AgentConfig.status was historically a binary
// active/inactive deployment flag — there was no notion of a *busy*
// agent. The Mission Control "Active Agents" panel and the AgentsPage
// idle/busy badges therefore had no signal to render. IncidentManager
// now calls assign() when a new incident gets routed to an agent and
// release() when the incident is resolved/closed; both /api/agents and
// /api/task-queue read from this tracker to surface the real state.
//
// One agent can only be busy on one incident at a time. Re-assigning a
// busy agent overwrites the previous assignment (and keeps its
// startedAt fresh). release() is idempotent.

import * as fs from 'fs';
import * as path from 'path';

export interface AgentAssignment {
  agentId: string;
  agentName: string;
  incidentId: string;
  incidentTitle: string;
  startedAt: string;
}

export type AgentWorkloadStatus = 'idle' | 'busy';

export interface AgentWorkloadSnapshot {
  status: AgentWorkloadStatus;
  currentIncidentId?: string;
  currentIncidentTitle?: string;
  startedAt?: string;
}

export class AgentWorkloadTracker {
  private byAgent: Map<string, AgentAssignment> = new Map();
  private byIncident: Map<string, string> = new Map();
  private persistPath: string | null;

  constructor(persistPath: string | null = null) {
    this.persistPath = persistPath;
    this.load();
  }

  /** Mark an agent busy on an incident. Overwrites any previous
   *  assignment for that agent. */
  assign(args: { agentId: string; agentName: string; incidentId: string; incidentTitle: string }): AgentAssignment {
    const existing = this.byAgent.get(args.agentId);
    if (existing && existing.incidentId !== args.incidentId) {
      // Drop the previous incident's reverse mapping before overwriting.
      this.byIncident.delete(existing.incidentId);
    }
    const assignment: AgentAssignment = {
      agentId: args.agentId,
      agentName: args.agentName,
      incidentId: args.incidentId,
      incidentTitle: args.incidentTitle,
      startedAt: existing?.incidentId === args.incidentId ? existing.startedAt : new Date().toISOString(),
    };
    this.byAgent.set(args.agentId, assignment);
    this.byIncident.set(args.incidentId, args.agentId);
    this.save();
    return assignment;
  }

  /** Release whatever incident the agent was working on. Idempotent. */
  release(agentId: string): void {
    const existing = this.byAgent.get(agentId);
    if (!existing) return;
    this.byAgent.delete(agentId);
    this.byIncident.delete(existing.incidentId);
    this.save();
  }

  /** Release whichever agent (if any) was assigned to this incident.
   *  Used when an incident resolves and we don't have the agentId in
   *  hand. Idempotent. */
  releaseByIncident(incidentId: string): string | null {
    const agentId = this.byIncident.get(incidentId);
    if (!agentId) return null;
    this.release(agentId);
    return agentId;
  }

  getStatus(agentId: string): AgentWorkloadSnapshot {
    const a = this.byAgent.get(agentId);
    if (!a) return { status: 'idle' };
    return {
      status: 'busy',
      currentIncidentId: a.incidentId,
      currentIncidentTitle: a.incidentTitle,
      startedAt: a.startedAt,
    };
  }

  getAssignment(agentId: string): AgentAssignment | null {
    return this.byAgent.get(agentId) ?? null;
  }

  getAgentForIncident(incidentId: string): string | null {
    return this.byIncident.get(incidentId) ?? null;
  }

  /** All current assignments, keyed by agentId. */
  list(): AgentAssignment[] {
    return Array.from(this.byAgent.values());
  }

  busyCount(): number {
    return this.byAgent.size;
  }

  private save(): void {
    if (!this.persistPath) return;
    try {
      const dir = path.dirname(this.persistPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const data = { version: 1, assignments: Array.from(this.byAgent.values()) };
      fs.writeFileSync(this.persistPath, JSON.stringify(data, null, 2), 'utf8');
    } catch {
      // Swallow — workload tracking is best-effort and must never crash
      // the incident pipeline if disk is full or the dir is read-only.
    }
  }

  private load(): void {
    if (!this.persistPath || !fs.existsSync(this.persistPath)) return;
    try {
      const raw = fs.readFileSync(this.persistPath, 'utf8');
      const data = JSON.parse(raw);
      const list: AgentAssignment[] = Array.isArray(data?.assignments) ? data.assignments : [];
      for (const a of list) {
        if (a?.agentId && a?.incidentId) {
          this.byAgent.set(a.agentId, a);
          this.byIncident.set(a.incidentId, a.agentId);
        }
      }
    } catch {
      // Corrupt file — start fresh rather than blowing up boot.
    }
  }
}

// Incident lifecycle manager for itops-agents

import { v4 as uuidv4 } from 'uuid';
import {
  SqliteIncidentStore,
  type Incident,
  type IncidentSeverity,
  type IncidentStatus,
  type IncidentSource,
  type TimelineEntry
} from '../persistence/SqliteStore.js';
import { logger } from '../utils/logger.js';
import type { AgentWorkloadTracker } from '../agents/AgentWorkloadTracker.js';

/** Result of a verification pass — see verifyResolution(). Callers
 *  decide what to do when ok=false: typically re-open the incident. */
export interface IncidentVerificationResult {
  ok: boolean;
  details?: string;
  /** False when no authoritative check could be performed. This is a
   *  handoff condition, not evidence that the resolution itself failed. */
  conclusive?: boolean;
}

/** Callback the operator wires in to actually re-check the underlying
 *  problem. The default is "no verifier" — verifyResolution() then
 *  returns ok=true and a "no verifier configured" detail. */
export type IncidentVerifier = (incident: Incident) => Promise<IncidentVerificationResult> | IncidentVerificationResult;

const SEVERITY_ORDER: IncidentSeverity[] = ['low', 'medium', 'high', 'critical'];

export type SlaConfig = Record<IncidentSeverity, number>;

const DEFAULT_SLA: SlaConfig = {
  critical: parseInt(process.env.INCIDENT_SLA_CRITICAL_MIN  || '60'),
  high:     parseInt(process.env.INCIDENT_SLA_HIGH_MIN      || '240'),
  medium:   parseInt(process.env.INCIDENT_SLA_MEDIUM_MIN    || '1440'),
  low:      parseInt(process.env.INCIDENT_SLA_LOW_MIN       || '4320')
};

/** Callback fired every time an incident transitions to `resolved`. The
 *  PostMortemGenerator hooks into this — see server.ts wiring. Setter is
 *  separate from the constructor so callers can configure the generator
 *  after the manager exists (the generator depends on the AI factory and
 *  the store, both of which are wired later in server.ts). */
export type IncidentResolvedListener = (incident: Incident) => void;

export class IncidentManager {
  private workloadTracker: AgentWorkloadTracker | null = null;
  private verifier: IncidentVerifier | null = null;
  private resolvedListeners: IncidentResolvedListener[] = [];

  constructor(
    private store: SqliteIncidentStore,
    private sla: SlaConfig = DEFAULT_SLA,
    private onCritical?: (incident: Incident) => void,
    private onCreated?: (incident: Incident) => void
  ) {}

  /** Register a listener to fire each time `resolve()` succeeds. Errors
   *  in a listener are isolated — one bad subscriber doesn't break the
   *  resolve pipeline or block other subscribers. */
  onResolved(listener: IncidentResolvedListener): void {
    this.resolvedListeners.push(listener);
  }

  private emitResolved(incident: Incident): void {
    for (const fn of this.resolvedListeners) {
      try {
        fn(incident);
      } catch (e) {
        logger.error('[IncidentManager] onResolved listener threw', {
          incidentId: incident.id,
          err: e instanceof Error ? e.message : String(e),
          stack: e instanceof Error ? e.stack : undefined,
        });
      }
    }
  }

  /** Plug in the workload tracker after construction. Done this way so
   *  IncidentManager can be built early in server.ts (before the
   *  organization is loaded) and have agent assignment activated once
   *  the org is ready. Without a tracker, assignAgent() still updates
   *  the incident row but doesn't mark anything as busy. */
  setWorkloadTracker(tracker: AgentWorkloadTracker | null): void {
    this.workloadTracker = tracker;
  }

  dispose(): void {
    this.store.close();
  }

  /** Set the verification callback used by verifyResolution(). */
  setVerifier(fn: IncidentVerifier | null): void {
    this.verifier = fn;
  }

  get incidentStore(): SqliteIncidentStore {
    return this.store;
  }

  /** @deprecated use new IncidentManager(new SqliteIncidentStore(dbPath)) */
  static fromPath(dbPath: string, onCritical?: (incident: Incident) => void): IncidentManager {
    return new IncidentManager(new SqliteIncidentStore(dbPath), DEFAULT_SLA, onCritical);
  }

  create(params: {
    title: string;
    description?: string;
    severity?: IncidentSeverity | string;
    assignedTo?: string;
    source?: IncidentSource;
    sourceRef?: string;
    /** ServerRegistry id this incident is filed against (e.g. "local",
     *  "openclaw"). Threaded onto the Incident row so per-server views
     *  and external-API breakdowns can group correctly. */
    serverId?: string | null;
    /** Suppress creation if an active incident (open/investigating/mitigating)
     *  already matches the dedup key. Defaults to true. Pass `false` for
     *  callers that legitimately want to allow duplicates (e.g. an operator
     *  re-opening the same issue after rapid resolution). */
    dedup?: boolean;
    /** Selector for matching against existing incidents. Defaults to
     *  'source+title'. Use 'sourceRef' when titles vary cycle-to-cycle
     *  (e.g. health-monitor titles include the current %) — pass a stable
     *  sourceRef alongside it (e.g. 'health-monitor:disk:/data'). */
    dedupBy?: 'source+title' | 'sourceRef' | 'title';
    /** Opt-in: when a duplicate is suppressed, refresh `updatedAt` and the
     *  description (if a new one was passed). Default `false` — silent skip,
     *  no writes at all. Pass `true` only when the caller knows the
     *  underlying data has materially changed (e.g. disk usage 85% → 95%);
     *  for periodic poll-style triggers, leave this off so the timeline
     *  doesn't churn on every cycle. */
    updateOnDup?: boolean;
    /** Username of the principal that filed the incident. Null/omitted for
     *  system-generated rows (alert-rule, agent, health-monitor). Threaded
     *  onto the Incident row so the self-service portal can scope a
     *  `requester` account to its own tickets. */
    createdBy?: string | null;
  }): Incident {
    const severity = this.normaliseSeverity(params.severity);
    const source: IncidentSource = params.source ?? 'manual';
    const sourceRef = params.sourceRef ?? null;

    if (params.dedup !== false) {
      const existing = this.findActiveDuplicate({
        title: params.title,
        source,
        sourceRef,
        dedupBy: params.dedupBy ?? 'source+title',
      });
      if (existing) {
        if (!params.updateOnDup) return existing;
        const updated: Incident = {
          ...existing,
          description: params.description ?? existing.description,
          // Backfill server_id on a dup-update if a previous create
          // happened before multi-server was wired (existing.serverId
          // is null) and the new call carries it. Don't overwrite an
          // already-set value — that would mis-attribute the incident
          // if two servers ever shared a sourceRef collision.
          serverId: existing.serverId ?? params.serverId ?? null,
          updatedAt: new Date().toISOString(),
        };
        this.store.upsert(updated);
        return updated;
      }
    }

    const now = new Date().toISOString();
    const incident: Incident = {
      id: 'INC-' + uuidv4().slice(0, 8).toUpperCase(),
      title: params.title,
      description: params.description ?? '',
      severity,
      status: 'open',
      assignedTo: params.assignedTo ?? null,
      assignedAgent: null,
      createdAt: now,
      updatedAt: now,
      resolvedAt: null,
      source,
      sourceRef,
      slaMinutes: this.sla[severity] ?? this.sla.medium,
      serverId: params.serverId ?? null,
      createdBy: params.createdBy ?? null,
    };
    this.store.upsert(incident);
    this.addTimeline(incident.id, 'system', 'opened',
      `Incident opened — severity: ${severity}, source: ${incident.source}`);
    if (incident.severity === 'critical' && this.onCritical) {
      try { this.onCritical(incident); } catch (_) {}
    }
    if (this.onCreated) {
      try { this.onCreated(incident); } catch (e) {
        logger.error('[IncidentManager] onCreated callback failed:', { err: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined });
      }
    }
    return incident;
  }

  /** Find an existing active (non-resolved, non-closed) incident that
   *  matches the dedup selector. Returns null if no match. Active statuses
   *  are 'open' | 'investigating' | 'mitigating' — once an operator resolves
   *  or closes an incident, a fresh re-trigger is allowed to open a new one. */
  private findActiveDuplicate(args: {
    title: string;
    source: IncidentSource;
    sourceRef: string | null;
    dedupBy: 'source+title' | 'sourceRef' | 'title';
  }): Incident | null {
    const ACTIVE: IncidentStatus[] = ['open', 'investigating', 'mitigating'];
    const candidates: Incident[] = [];
    for (const status of ACTIVE) {
      candidates.push(...this.store.list({ status }));
    }
    for (const c of candidates) {
      if (args.dedupBy === 'sourceRef') {
        if (args.sourceRef && c.source === args.source && c.sourceRef === args.sourceRef) return c;
      } else if (args.dedupBy === 'title') {
        if (c.title === args.title) return c;
      } else { // 'source+title'
        if (c.source === args.source && c.title === args.title) return c;
      }
    }
    return null;
  }

  update(id: string, patch: Partial<Pick<Incident, 'title' | 'description' | 'assignedTo' | 'severity' | 'status'>>): Incident | null {
    const inc = this.store.get(id);
    if (!inc) return null;
    const updated = { ...inc, ...patch, updatedAt: new Date().toISOString() };
    this.store.upsert(updated);
    this.addTimeline(id, 'system', 'updated',
      `Updated: ${Object.keys(patch).join(', ')}`);
    return updated;
  }

  escalate(id: string, reason: string, newAssignee?: string): Incident | null {
    const inc = this.store.get(id);
    if (!inc) return null;
    const idx = SEVERITY_ORDER.indexOf(inc.severity);
    const newSeverity: IncidentSeverity = idx < SEVERITY_ORDER.length - 1
      ? SEVERITY_ORDER[idx + 1]
      : inc.severity;
    const updated: Incident = {
      ...inc,
      severity: newSeverity,
      status: 'investigating',
      assignedTo: newAssignee ?? inc.assignedTo,
      slaMinutes: this.sla[newSeverity],
      updatedAt: new Date().toISOString()
    };
    this.store.upsert(updated);
    this.addTimeline(id, 'system', 'escalated',
      `Escalated to ${newSeverity}${newAssignee ? ` → assigned to ${newAssignee}` : ''}. Reason: ${reason}`);
    return updated;
  }

  resolve(id: string, resolution: string): Incident | null {
    const inc = this.store.get(id);
    if (!inc) return null;
    const now = new Date().toISOString();
    const updated: Incident = {
      ...inc,
      status: 'resolved',
      resolvedAt: now,
      updatedAt: now,
      // Drop the agent ownership — the row keeps `assignedAgent` for audit
      // until the next assignment cycle, so leaving it intact is fine and
      // consistent with how Jira tracks resolved-by.
    };
    this.store.upsert(updated);
    // Free the agent in the workload tracker — without this, every
    // resolved incident still counts as "agent X is busy" forever.
    if (this.workloadTracker) {
      this.workloadTracker.releaseByIncident(id);
    }
    const ageMin = Math.round(
      (new Date(now).getTime() - new Date(inc.createdAt).getTime()) / 60000
    );
    const slaStatus = ageMin > inc.slaMinutes ? '⚠️ SLA BREACHED' : '✅ Within SLA';
    this.addTimeline(id, 'system', 'resolved',
      `Resolved in ${ageMin}m (SLA: ${inc.slaMinutes}m) ${slaStatus}. ${resolution}`);
    // Fire onResolved listeners after the timeline note lands so the
    // generator can read it as part of the post-mortem corpus.
    this.emitResolved(updated);
    return updated;
  }

  /** Resolve every active (open/investigating/mitigating) incident
   *  whose row matches the predicate. Adds an `auto-resolved` note to
   *  each timeline before flipping status, so the reason stays
   *  visible. Used by the health monitor to close out incidents whose
   *  underlying condition has cleared (e.g. disk dropped from 91% to
   *  70%). Returns the IDs that were actually resolved. */
  resolveActiveByRef(
    predicate: (incident: Incident) => boolean,
    reason: string,
    actor: string = 'system',
    opts: { verifyAfterResolve?: boolean } = {},
  ): string[] {
    const ACTIVE: IncidentStatus[] = ['open', 'investigating', 'mitigating'];
    const candidates: Incident[] = [];
    for (const status of ACTIVE) {
      candidates.push(...this.store.list({ status }));
    }
    const resolvedIds: string[] = [];
    for (const inc of candidates) {
      if (!predicate(inc)) continue;
      try {
        // Note first, then resolve — so the reason is on the timeline
        // even if `resolve()` throws for a workload-tracker reason.
        this.addNote(inc.id, actor, `Auto-resolved — ${reason}`);
        this.resolve(inc.id, `auto: ${reason}`);
        resolvedIds.push(inc.id);
        if (opts.verifyAfterResolve) {
          this.verifyResolution(inc.id).catch(e => {
            logger.error('[IncidentManager] auto-resolve verification failed', {
              incidentId: inc.id,
              err: e instanceof Error ? e.message : String(e),
            });
          });
        }
      } catch (e) {
        logger.error('[IncidentManager] resolveActiveByRef failed for incident', {
          incidentId: inc.id,
          err: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return resolvedIds;
  }

  /** Resolve every active incident whose `updatedAt` is older than the
   *  given cutoff. Used as a safety net for incidents that nothing else
   *  ever clears — typically low-severity audit rows or alerts whose
   *  source went away before posting a clear. The default age is
   *  intentionally generous; tune via INCIDENT_STALE_HOURS on the
   *  scheduling side. Returns the IDs that were resolved. */
  sweepStale(maxAgeHours: number, opts?: { actor?: string; reason?: string }): string[] {
    const actor = opts?.actor ?? 'system';
    const cutoffMs = Date.now() - Math.max(0, maxAgeHours) * 3600 * 1000;
    return this.resolveActiveByRef(
      inc => {
        const ts = Date.parse(inc.updatedAt || inc.createdAt);
        return Number.isFinite(ts) && ts < cutoffMs;
      },
      opts?.reason ?? `stale — no updates for >${maxAgeHours}h`,
      actor,
    );
  }

  /** Assign an agent to an incident. Updates the row, marks the agent
   *  busy in the workload tracker, and adds a timeline entry. Used by
   *  the create/escalate handlers in incidentsApi after an agent is
   *  picked. Idempotent — assigning the same agent twice no-ops. */
  assignAgent(id: string, agent: { id: string; name: string }, reason?: string): Incident | null {
    const inc = this.store.get(id);
    if (!inc) return null;
    if (inc.assignedAgent === agent.id) {
      // Re-mark busy in the tracker even on no-op so a restart-recovered
      // tracker stays consistent with the persisted incident state.
      if (this.workloadTracker) {
        this.workloadTracker.assign({
          agentId: agent.id, agentName: agent.name,
          incidentId: inc.id, incidentTitle: inc.title,
        });
      }
      return inc;
    }
    // Free the previous agent (if any) before binding the new one — a
    // re-assignment on escalation should release the previous owner.
    if (inc.assignedAgent && this.workloadTracker) {
      this.workloadTracker.release(inc.assignedAgent);
    }
    // assignedTo is a human-readable label. Preserve operator-set values
    // EXCEPT the 'IT Director' string, which was a legacy placeholder
    // set unconditionally by old health-monitor creation paths and which
    // we want overwritten with the actual picked agent's name when the
    // pick isn't the director. Without this, those rows stayed labelled
    // "IT Director" forever even though Ops Bravo / Ops Charlie were
    // doing the work via assignedAgent.
    const isStalePlaceholder =
      inc.assignedTo === 'IT Director' && agent.name !== 'IT Director';
    const nextAssignedTo = !inc.assignedTo || isStalePlaceholder
      ? agent.name
      : inc.assignedTo;
    const updated: Incident = {
      ...inc,
      assignedAgent: agent.id,
      assignedTo: nextAssignedTo,
      updatedAt: new Date().toISOString(),
    };
    this.store.upsert(updated);
    if (this.workloadTracker) {
      this.workloadTracker.assign({
        agentId: agent.id, agentName: agent.name,
        incidentId: inc.id, incidentTitle: inc.title,
      });
    }
    this.addTimeline(id, 'system', 'updated',
      `Agent ${agent.name} (${agent.id.slice(0, 8)}) assigned${reason ? ` — ${reason}` : ''}`);
    return updated;
  }

  /** One-shot correction pass: walks incidents whose assignedTo equals
   *  the literal 'IT Director' placeholder AND have a real assignedAgent
   *  set whose name isn't 'IT Director', and rewrites the label to the
   *  agent's actual name. Safe to call repeatedly — idempotent. Used at
   *  boot to clean up rows left behind by the historical health-monitor
   *  hardcode. Caller passes a resolver so this module stays free of
   *  any OrganizationManager dep.
   *
   *  Returns the number of rows it updated. */
  rewriteStaleDirectorLabel(resolveAgentName: (id: string) => string | null): number {
    const candidates = this.store.list({});
    let fixed = 0;
    for (const inc of candidates) {
      if (inc.assignedTo !== 'IT Director') continue;
      if (!inc.assignedAgent) continue;
      const resolved = resolveAgentName(inc.assignedAgent);
      if (!resolved || resolved === 'IT Director') continue;
      const updated: Incident = {
        ...inc,
        assignedTo: resolved,
        updatedAt: new Date().toISOString(),
      };
      this.store.upsert(updated);
      // Quiet timeline note so the audit log shows when + why the label
      // changed. Avoids confusion if an operator wonders why "IT Director"
      // suddenly became "Ops Bravo" on an incident they were watching.
      this.addTimeline(inc.id, 'system', 'updated',
        `Label corrected: assignedTo "IT Director" → "${resolved}" (carrying-over placeholder cleanup)`);
      fixed++;
    }
    return fixed;
  }

  /** Persist the escalation pipeline level for an incident. Used by
   *  EscalationPipeline as it walks an incident through L1→L4. Each
   *  transition also adds a timeline note so the history survives
   *  restarts (EscalationPipeline re-derives in-memory state from these
   *  notes on boot). Returns the updated incident, or null if not found. */
  setEscalation(
    id: string,
    level: number,
    opts?: { note?: string; actor?: string; escalatedAt?: string },
  ): Incident | null {
    const inc = this.store.get(id);
    if (!inc) return null;
    if ((inc.escalationLevel ?? 0) === level && level !== 0) {
      // No-op on repeat (e.g. tick() re-firing L3 for the same incident).
      return inc;
    }
    const now = opts?.escalatedAt ?? new Date().toISOString();
    const updated: Incident = {
      ...inc,
      escalationLevel: level,
      escalatedAt: level === 0 ? null : now,
      updatedAt: now,
    };
    this.store.upsert(updated);
    const actor = opts?.actor ?? 'escalation-pipeline';
    const message = opts?.note
      ? `[L${level}] ${opts.note}`
      : `[L${level}] escalation level updated`;
    this.addTimeline(id, actor, 'note', message);
    return updated;
  }

  /** Drop the agent ownership without resolving the incident. Mostly
   *  used when an operator cancels work or the assigned agent is
   *  deleted. Idempotent. */
  releaseAgent(id: string, reason?: string): Incident | null {
    const inc = this.store.get(id);
    if (!inc || !inc.assignedAgent) return inc;
    if (this.workloadTracker) {
      this.workloadTracker.release(inc.assignedAgent);
    }
    const updated: Incident = {
      ...inc,
      assignedAgent: null,
      updatedAt: new Date().toISOString(),
    };
    this.store.upsert(updated);
    this.addTimeline(id, 'system', 'updated',
      `Agent assignment released${reason ? ` — ${reason}` : ''}`);
    return updated;
  }

  /** Run the configured verifier against the incident and return the
   *  result. If verification fails, re-open the incident so the
   *  operator UI flips back from green to amber. Without a verifier,
   *  returns ok=true with a "no verifier configured" detail (the
   *  resolve still stands).
   *
   *  Verification is intentionally separate from resolve() so an
   *  operator clicking "Resolve" gets immediate UI feedback and the
   *  re-check happens in the background; if it fails, we revert. */
  async verifyResolution(id: string, opts?: { reopenOnFailure?: boolean }): Promise<IncidentVerificationResult> {
    const inc = this.store.get(id);
    if (!inc) return { ok: false, details: 'incident not found' };
    if (!this.verifier) {
      this.addTimeline(id, 'system', 'note', 'Verification skipped — no verifier configured');
      return { ok: true, details: 'no verifier configured' };
    }
    let result: IncidentVerificationResult;
    try {
      result = await Promise.resolve(this.verifier(inc));
    } catch (e) {
      result = { ok: false, details: e instanceof Error ? e.message : String(e) };
    }
    if (result.ok) {
      this.addTimeline(id, 'system', 'note', `Verification passed${result.details ? ` — ${result.details}` : ''}`);
      return result;
    }
    const label = result.conclusive === false ? 'Verification unavailable' : 'Verification FAILED';
    this.addTimeline(id, 'system', 'note', `${label} — ${result.details ?? 'check returned not-ok'}`);
    if (opts?.reopenOnFailure !== false) {
      const now = new Date().toISOString();
      const reopened: Incident = {
        ...inc,
        status: 'investigating',
        resolvedAt: null,
        updatedAt: now,
      };
      this.store.upsert(reopened);
      this.addTimeline(id, 'system', 'updated', result.conclusive === false
        ? 'Re-opened: post-resolution verification was unavailable'
        : 'Re-opened: post-resolution verification failed');
    }
    return result;
  }

  close(id: string): Incident | null {
    const inc = this.store.get(id);
    if (!inc) return null;
    const updated: Incident = {
      ...inc,
      status: 'closed',
      updatedAt: new Date().toISOString()
    };
    this.store.upsert(updated);
    if (this.workloadTracker) {
      this.workloadTracker.releaseByIncident(id);
    }
    this.addTimeline(id, 'system', 'closed', 'Incident closed');
    return updated;
  }

  addNote(id: string, actor: string, message: string): TimelineEntry | null {
    const inc = this.store.get(id);
    if (!inc) return null;
    return this.addTimeline(id, actor, 'note', message);
  }

  get(id: string): (Incident & { timeline: TimelineEntry[] }) | null {
    const inc = this.store.get(id);
    if (!inc) return null;
    return { ...inc, timeline: this.store.getTimeline(id) };
  }

  list(filter?: { status?: string; severity?: string; assignedTo?: string }): Incident[] {
    return this.store.list(filter);
  }

  search(q: string): Incident[] {
    const ids = this.store.search(q);
    return ids.map(id => this.store.get(id)).filter((i): i is Incident => i !== null);
  }

  getTimeline(id: string): TimelineEntry[] {
    return this.store.getTimeline(id);
  }

  getStats() {
    return this.store.stats();
  }

  /** Coerce arbitrary severity inputs into a canonical IncidentSeverity.
   *  Alert sources use their own vocabularies — AlertRulesEngine emits
   *  'warning' | 'critical', monitoring tools sometimes use 'info' / 'error'.
   *  Without normalisation, this.sla[severity] returns undefined and the
   *  insert fails the NOT NULL constraint on incidents.sla_minutes. */
  private normaliseSeverity(input: IncidentSeverity | string | undefined): IncidentSeverity {
    if (!input) return 'medium';
    const v = String(input).toLowerCase();
    if (v === 'critical' || v === 'high' || v === 'medium' || v === 'low') {
      return v as IncidentSeverity;
    }
    if (v === 'warning' || v === 'warn')          return 'medium';
    if (v === 'error' || v === 'severe')          return 'high';
    if (v === 'info' || v === 'notice' || v === 'debug') return 'low';
    return 'medium';
  }

  private addTimeline(incidentId: string, actor: string, type: TimelineEntry['type'], message: string): TimelineEntry {
    const entry: TimelineEntry = {
      id: uuidv4(),
      incidentId,
      timestamp: new Date().toISOString(),
      actor,
      type,
      message
    };
    this.store.addTimeline(entry);
    return entry;
  }
}

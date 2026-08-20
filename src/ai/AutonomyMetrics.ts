import type { IncidentManager } from '../incidents/IncidentManager.js';
import type { AiDecisionStore } from './AiDecisionStore.js';
import type { SkillManager } from '../skills/SkillManager.js';
import type { AutonomyAttemptStore, AutonomyClassification } from './AutonomyAttemptStore.js';

export interface AutonomyLayerCoverage {
  linux: boolean;
  docker: boolean;
  kubernetes: boolean;
  cloud: boolean;
}

export interface AutonomyMetricsResult {
  /** Fraction of resolved incidents in the window that the agent closed
   *  autonomously (auto-applied resolve decisions). 0..1. */
  autonomousResolutionRate: number;
  /** Mean Time To Resolution (minutes) across every resolved incident
   *  in the window — autonomous + manual alike. */
  mttrMinutes: number | null;
  /** Fraction of autonomous resolutions whose incident later reopened.
   *  0..1. Lower is better. */
  falseResolveRate: number;
  /** How many of the four infra layers (Linux, Docker, K8s, Cloud) have
   *  at least one enabled skill wired up. */
  layerCoverage: AutonomyLayerCoverage;
  window: { since: string | null; until: string };
  attributionCoverage: number;
  outcomes: {
    totalAttempts: number;
    terminalAttempts: number;
    inProgress: number;
    classifiedOutcomes: number;
    unclassifiedTerminalIncidents: number;
    byClassification: Record<AutonomyClassification, number>;
  };
  cohorts: Record<Exclude<AutonomyClassification, 'in_progress'>, {
    count: number;
    rate: number;
    mttrMinutes: number | null;
  }>;
}

function matchesAny(haystack: string, needles: string[]): boolean {
  const lower = haystack.toLowerCase();
  return needles.some(n => lower.includes(n));
}

export function computeAutonomyMetrics(
  incidents: IncidentManager,
  decisions: AiDecisionStore,
  skills: SkillManager,
  sinceMs?: number,
  attempts?: AutonomyAttemptStore,
): AutonomyMetricsResult {
  const until = new Date();
  const sinceIso = sinceMs ? new Date(until.getTime() - sinceMs).toISOString() : undefined;
  const cutoffMs = sinceMs ? until.getTime() - sinceMs : 0;

  // Autonomous resolution set: incidents with an auto-applied resolve
  // decision. These are the incidents the agent closed itself.
  const autoResolvedIds = new Set<string>();
  const autoResolveDecisions = decisions.list({ kind: 'resolve', autoApplied: true, since: sinceIso });
  for (const d of autoResolveDecisions) {
    if (d.incidentId) autoResolvedIds.add(d.incidentId);
  }

  const concludedAutoResolves = autoResolveDecisions.filter(
    d => d.outcome === 'success' || d.outcome === 'reopened',
  );
  const reopenedAutoResolved = concludedAutoResolves.filter(d => d.outcome === 'reopened').length;

  // Total resolved incidents in the window — the denominator for the
  // resolution-rate metric. Auto + manual together.
  const allIncidents = incidents.list({}).filter(i =>
    Date.parse(i.createdAt) >= cutoffMs && (i.status === 'resolved' || i.status === 'closed') && i.resolvedAt
  );
  const totalResolved = allIncidents.length;

  // MTTR across every resolved incident (auto + manual).
  let totalResolveMs = 0;
  for (const inc of allIncidents) {
    const ms = Date.parse(inc.resolvedAt!) - Date.parse(inc.createdAt);
    if (ms >= 0) totalResolveMs += ms;
  }
  const mttrMinutes = totalResolved > 0 ? (totalResolveMs / totalResolved) / 60000 : null;

  // Layer coverage — capability presence, not command count.
  const skillManifest = skills.getEnabled().map(s => `${s.id} ${s.name} ${s.commands.map(c => c.name).join(' ')}`);
  const joined = skillManifest.join(' ');
  const layerCoverage: AutonomyLayerCoverage = {
    linux:      matchesAny(joined, ['bash.exec', 'ssh.', 'host.exec', 'systemd']),
    docker:     matchesAny(joined, ['docker.', 'container.']),
    kubernetes: matchesAny(joined, ['k8s.', 'kubernetes.']),
    cloud:      matchesAny(joined, ['cloud.', 'aws.', 'gcp.', 'azure.']),
  };

  const byClassification: Record<AutonomyClassification, number> = {
    in_progress: 0,
    verified_autonomous: 0,
    assisted: 0,
    false_resolution: 0,
    failed: 0,
    human_handoff: 0,
  };
  const cohortDurations: Record<Exclude<AutonomyClassification, 'in_progress'>, number[]> = {
    verified_autonomous: [], assisted: [], false_resolution: [], failed: [], human_handoff: [],
  };
  const attemptRows = attempts?.list({ since: sinceIso, until: until.toISOString(), limit: 20_000 }) || [];
  const attemptedIncidentIds = new Set(attemptRows.map(attempt => attempt.incidentId));
  const terminalAttemptIncidentIds = new Set(
    attemptRows.filter(attempt => attempt.classification !== 'in_progress').map(attempt => attempt.incidentId),
  );
  const incidentsById = new Map(allIncidents.map(incident => [incident.id, incident]));
  for (const attempt of attemptRows) {
    byClassification[attempt.classification]++;
    if (attempt.classification === 'in_progress') continue;
    const incident = incidentsById.get(attempt.incidentId);
    const durationMs = incident?.resolvedAt
      ? Date.parse(incident.resolvedAt) - Date.parse(incident.createdAt)
      : attempt.durationMs;
    if (durationMs !== null && durationMs !== undefined && durationMs >= 0) {
      cohortDurations[attempt.classification].push(durationMs);
    }
  }

  // A resolved incident with no attempt is still classified: it required a
  // human/system path outside the attributable autonomous handler.
  for (const incident of allIncidents) {
    if (attemptedIncidentIds.has(incident.id)) continue;
    byClassification.human_handoff++;
    const durationMs = Date.parse(incident.resolvedAt!) - Date.parse(incident.createdAt);
    if (durationMs >= 0) cohortDurations.human_handoff.push(durationMs);
  }

  // Legacy fallback keeps the old contract meaningful until the first
  // attributable attempts are recorded after deployment.
  let legacyAutoResolvedInWindow = 0;
  if (!attempts) {
    legacyAutoResolvedInWindow = allIncidents.filter(i => autoResolvedIds.has(i.id)).length;
    byClassification.verified_autonomous = legacyAutoResolvedInWindow;
    byClassification.human_handoff = Math.max(0, totalResolved - legacyAutoResolvedInWindow);
    byClassification.false_resolution = reopenedAutoResolved;
  }

  const terminalAttempts = attemptRows.filter(attempt => attempt.classification !== 'in_progress').length;
  const unclassifiedTerminalIncidents = attempts
    ? allIncidents.filter(incident => attemptedIncidentIds.has(incident.id) && !terminalAttemptIncidentIds.has(incident.id)).length
    : 0;
  const classifiedOutcomes = Object.entries(byClassification)
    .filter(([classification]) => classification !== 'in_progress')
    .reduce((sum, [, count]) => sum + count, 0);
  const concludedClaims = byClassification.verified_autonomous + byClassification.false_resolution;
  const cohortDenominator = Math.max(1, classifiedOutcomes);
  const cohorts = Object.fromEntries(
    (Object.keys(cohortDurations) as Array<Exclude<AutonomyClassification, 'in_progress'>>).map(classification => {
      const durations = cohortDurations[classification];
      return [classification, {
        count: byClassification[classification],
        rate: byClassification[classification] / cohortDenominator,
        mttrMinutes: durations.length > 0 ? durations.reduce((sum, value) => sum + value, 0) / durations.length / 60_000 : null,
      }];
    }),
  ) as AutonomyMetricsResult['cohorts'];

  return {
    autonomousResolutionRate: attempts
      ? (classifiedOutcomes > 0 ? byClassification.verified_autonomous / classifiedOutcomes : 0)
      : (totalResolved > 0 ? legacyAutoResolvedInWindow / totalResolved : 0),
    mttrMinutes,
    falseResolveRate: attempts
      ? (concludedClaims > 0 ? byClassification.false_resolution / concludedClaims : 0)
      : (concludedAutoResolves.length > 0 ? reopenedAutoResolved / concludedAutoResolves.length : 0),
    layerCoverage,
    window: { since: sinceIso || null, until: until.toISOString() },
    attributionCoverage: totalResolved > 0
      ? allIncidents.filter(incident => attemptedIncidentIds.has(incident.id)).length / totalResolved
      : 0,
    outcomes: {
      totalAttempts: attemptRows.length,
      terminalAttempts,
      inProgress: byClassification.in_progress,
      classifiedOutcomes,
      unclassifiedTerminalIncidents,
      byClassification,
    },
    cohorts,
  };
}

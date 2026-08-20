// ChangeCorrelation — "did something just change?" engine.
//
// On every incident creation, query the change log for entries in
// the last N hours scoped to the incident's asset/server (or its
// upstream dependencies). Each match gets a confidence score; the
// top results surface on the incident as a "Possible cause" hint.
//
// Scoring intent:
//   • Closer in time = higher score (linear decay over the window)
//   • Same asset/server = high  (~0.7 base)
//   • Upstream dependency = medium (~0.45)
//   • Failed / rolled_back changes are weighted higher than completed
//     ones — a failed deploy is a better candidate cause
//   • Runbook-sourced changes weighted slightly higher than manual
//     change-log entries because they actually touched the system
//
// All scores are bounded to [0, 1]; UI renders three buckets:
//   ≥0.7  "likely cause"
//   ≥0.4  "possible cause"
//   else  "recent change"
//
// Pure helper functions exported under _testing for unit coverage.

import type { Change, ChangeStore } from './ChangeStore.js';
import type { AssetStore } from '../cmdb/AssetStore.js';
import { ImpactAnalyzer } from '../cmdb/ImpactAnalyzer.js';

export type CauseLikelihood = 'likely' | 'possible' | 'recent';

export interface CorrelatedChange {
  change: Change;
  /** 0..1 confidence the change caused (or contributed to) the incident. */
  score: number;
  likelihood: CauseLikelihood;
  /** Why this row was picked — surfaced as a tooltip in the UI. */
  reason: string;
  /** When the asset that holds the change is upstream (a parent
   *  dependency), how far away — populated when reasonId='upstream'. */
  upstreamDepth?: number;
}

export interface CorrelationOpts {
  /** How far back to look. Default 2h (matches spec). */
  windowMs?: number;
  /** Max matches returned, ordered by score desc. Default 5. */
  maxResults?: number;
  /** Upstream search depth — 0 disables, 1 includes direct parents,
   *  etc. Default 2. Pass higher for hyper-connected fleets. */
  upstreamDepth?: number;
}

export class ChangeCorrelation {
  constructor(
    private changes: ChangeStore,
    private assets: AssetStore,
  ) {}

  /** Find changes that might explain an incident. Returns empty when
   *  the incident has neither an asset nor a serverId — we won't
   *  surface fleet-wide changes as "possible causes" for a server-less
   *  ticket. */
  correlate(incident: {
    id: string;
    createdAt: string;
    serverId?: string | null;
    assetId?: string | null;
  }, opts: CorrelationOpts = {}): CorrelatedChange[] {
    const windowMs = opts.windowMs ?? 2 * 60 * 60 * 1000;
    const maxResults = Math.max(1, Math.min(20, opts.maxResults ?? 5));
    const upstreamDepth = Math.max(0, Math.min(5, opts.upstreamDepth ?? 2));

    const createdAt = new Date(incident.createdAt);
    const sinceIso = new Date(createdAt.getTime() - windowMs).toISOString();
    const untilIso = createdAt.toISOString();

    // Build the set of (assetId, distance) tuples we'll scan.
    const scope = this.buildScope(incident, upstreamDepth);
    if (scope.length === 0) return [];

    // Collect candidates — dedup'd by change.id across scope entries.
    const seen = new Set<string>();
    const candidates: Array<{ c: Change; depth: number; via: 'direct' | 'upstream' | 'server' }> = [];
    for (const s of scope) {
      const rows = this.changes.changesInWindow(sinceIso, untilIso, {
        assetId: s.assetId,
        serverId: s.serverId,
      });
      for (const c of rows) {
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        candidates.push({ c, depth: s.depth, via: s.via });
      }
    }

    // Score + sort.
    const scored = candidates.map(({ c, depth, via }) => {
      const { score, reason } = scoreChange(c, createdAt, windowMs, depth, via);
      return {
        change: c,
        score,
        likelihood: bucketize(score),
        reason,
        upstreamDepth: via === 'upstream' ? depth : undefined,
      };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, maxResults);
  }

  /** Build the asset/server scope to query, including upstream
   *  parents up to `upstreamDepth`. Exported for tests. */
  private buildScope(
    incident: { assetId?: string | null; serverId?: string | null },
    upstreamDepth: number,
  ): Array<{ assetId?: string; serverId?: string; depth: number; via: 'direct' | 'upstream' | 'server' }> {
    const out: Array<{ assetId?: string; serverId?: string; depth: number; via: 'direct' | 'upstream' | 'server' }> = [];
    const seenAssets = new Set<string>();

    // Direct asset match (highest weight).
    if (incident.assetId) {
      out.push({ assetId: incident.assetId, depth: 0, via: 'direct' });
      seenAssets.add(incident.assetId);
    }
    // Direct server match — important for incidents created before the
    // CMDB auto-discovery mirrored them into an asset row, or for the
    // first window after a server is added.
    if (incident.serverId) {
      out.push({ serverId: incident.serverId, depth: 0, via: 'server' });
      // Also include the auto-discovered asset for that server, if any.
      const asset = this.assets.getByServerId(incident.serverId);
      if (asset && !seenAssets.has(asset.id)) {
        out.push({ assetId: asset.id, depth: 0, via: 'direct' });
        seenAssets.add(asset.id);
      }
    }

    // Related assets — anything connected via either edge direction
    // up to `upstreamDepth` hops. We walk both directions because the
    // semantic varies per edge type: `hosts`/`runs` go parent→child
    // (downstream of a server is its services), while `depends_on`
    // goes dependent→dependency (downstream of a service is its db).
    // For change correlation we want every related asset regardless,
    // so we union both BFS walks. The `via='upstream'` label is kept
    // for backward compatibility with the scoring function — every
    // non-direct hit is treated as an upstream-equivalent.
    if (upstreamDepth > 0 && out.length > 0) {
      const rootAsset = out.find(s => s.via === 'direct')?.assetId;
      if (rootAsset) {
        const ia = new ImpactAnalyzer(this.assets);
        for (const dir of ['downstream', 'upstream'] as const) {
          const report = ia.analyze(rootAsset, { direction: dir, maxDepth: upstreamDepth });
          if (!report) continue;
          for (const n of report.nodes) {
            if (n.depth === 0) continue; // skip root
            if (seenAssets.has(n.asset.id)) continue;
            seenAssets.add(n.asset.id);
            out.push({ assetId: n.asset.id, depth: n.depth, via: 'upstream' });
          }
        }
      }
    }
    return out;
  }
}

// ── Pure scoring ──────────────────────────────────────────────────────

function scoreChange(
  c: Change,
  incidentAt: Date,
  windowMs: number,
  depth: number,
  via: 'direct' | 'upstream' | 'server',
): { score: number; reason: string } {
  // Time component: 1.0 at the moment of the incident, 0.0 at the
  // far edge of the window. Linear so it's predictable.
  const dt = Math.max(0, incidentAt.getTime() - new Date(c.createdAt).getTime());
  const timeScore = Math.max(0, 1 - dt / Math.max(1, windowMs));

  // Proximity (asset/server vs upstream hop).
  let proximity = 0.7;
  let proxReason = 'same asset';
  if (via === 'upstream') {
    proximity = Math.max(0.2, 0.6 - depth * 0.15);
    proxReason = `upstream dependency (depth ${depth})`;
  } else if (via === 'server') {
    proximity = 0.65;
    proxReason = 'same server';
  }

  // Status weighting — a failed change is a much better candidate.
  let statusBonus = 0;
  if (c.status === 'failed' || c.status === 'rolled_back') statusBonus = 0.15;
  else if (c.status === 'in_progress')                     statusBonus = 0.10;
  else if (c.status === 'completed')                       statusBonus = 0.05;

  // Source weighting — a runbook execution touched the box more
  // definitively than a manually logged change-log entry.
  let sourceBonus = 0;
  if (c.source === 'runbook')      sourceBonus = 0.07;
  if (c.source === 'remediation')  sourceBonus = 0.10;

  const score = Math.max(0, Math.min(1, timeScore * 0.5 + proximity * 0.45 + statusBonus + sourceBonus));
  const minutesAgo = Math.round(dt / 60_000);
  const reason = `${proxReason}, ${c.status}${c.source !== 'manual' ? ` via ${c.source}` : ''}, ${minutesAgo}m before incident`;
  return { score, reason };
}

function bucketize(score: number): CauseLikelihood {
  if (score >= 0.7) return 'likely';
  if (score >= 0.4) return 'possible';
  return 'recent';
}

export const _testing = { scoreChange, bucketize };

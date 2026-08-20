// ImpactAnalyzer — graph traversal over CMDB relationships.
//
// "If asset X fails, what else breaks?"
//
// Walks asset_relationships from a starting asset, returns the
// reachable subgraph (nodes + edges + a tree-shaped layout). BFS so
// the closest dependents come back first; depth-bounded to avoid
// hairballs on hyper-connected graphs.
//
// Direction:
//   • 'downstream' = follow OUTGOING edges (parent → child).
//      "This server hosts these services that run these apps…"
//   • 'upstream'   = follow INCOMING edges (child → parent).
//      "What depends on this database?"
//
// Cycle handling: a visited set is keyed on asset id, so a graph with
// A→B→A walks once and stops. Edges are returned as raw rows so
// callers can render bidirectional links cleanly.

import type { AssetStore, Asset, RelationshipType } from './AssetStore.js';

export type ImpactDirection = 'downstream' | 'upstream';

export interface ImpactNode {
  asset: Asset;
  /** Distance from the root in edges (root = 0). */
  depth: number;
  /** The relationship type by which we reached this node, or null
   *  for the root. */
  reachedVia: RelationshipType | null;
  /** Parent in the traversal tree (the prior asset id on the BFS path),
   *  or null for the root. */
  parentId: string | null;
}

export interface ImpactEdge {
  parentId: string;
  childId: string;
  type: RelationshipType;
}

export interface ImpactReport {
  rootId: string;
  direction: ImpactDirection;
  maxDepth: number;
  /** Nodes in BFS order — root first, then breadth, then breadth. */
  nodes: ImpactNode[];
  edges: ImpactEdge[];
  /** True if traversal stopped at maxDepth and there are more nodes
   *  reachable beyond. */
  truncated: boolean;
}

export class ImpactAnalyzer {
  constructor(private store: AssetStore) {}

  analyze(rootId: string, opts: { direction?: ImpactDirection; maxDepth?: number } = {}): ImpactReport | null {
    const direction = opts.direction ?? 'downstream';
    const maxDepth = Math.max(0, Math.min(10, opts.maxDepth ?? 5));
    const root = this.store.get(rootId);
    if (!root) return null;

    const visited = new Set<string>([root.id]);
    const nodes: ImpactNode[] = [{ asset: root, depth: 0, reachedVia: null, parentId: null }];
    const edges: ImpactEdge[] = [];
    const queue: Array<{ id: string; depth: number }> = [{ id: root.id, depth: 0 }];
    let truncated = false;

    while (queue.length > 0) {
      const { id, depth } = queue.shift()!;
      if (depth >= maxDepth) {
        // Mark truncated only if there ARE outgoing edges we'd have
        // followed — otherwise this is just a clean leaf.
        const neighbors = direction === 'downstream'
          ? this.store.listDownstream(id)
          : this.store.listUpstream(id);
        if (neighbors.some(n => !visited.has(direction === 'downstream' ? n.childId : n.parentId))) {
          truncated = true;
        }
        continue;
      }
      const out = direction === 'downstream'
        ? this.store.listDownstream(id).map(e => ({ otherId: e.childId, parentId: id, childId: e.childId, type: e.type }))
        : this.store.listUpstream(id).map(e =>   ({ otherId: e.parentId, parentId: e.parentId, childId: id, type: e.type }));
      for (const e of out) {
        // Record the edge regardless of visited — same edge from a
        // different traversal path is still informative for rendering.
        edges.push({ parentId: e.parentId, childId: e.childId, type: e.type });
        if (visited.has(e.otherId)) continue;
        const otherAsset = this.store.get(e.otherId);
        if (!otherAsset) continue;
        visited.add(e.otherId);
        nodes.push({ asset: otherAsset, depth: depth + 1, reachedVia: e.type, parentId: id });
        queue.push({ id: e.otherId, depth: depth + 1 });
      }
    }

    return { rootId, direction, maxDepth, nodes, edges, truncated };
  }

  /** Convenience helper — given an asset, list every other asset
   *  whose failure WOULD impact it. Inverse of `analyze(downstream)`. */
  upstreamImpact(assetId: string, maxDepth = 5): ImpactReport | null {
    return this.analyze(assetId, { direction: 'upstream', maxDepth });
  }
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AssetStore } from './AssetStore.js';
import { ImpactAnalyzer } from './ImpactAnalyzer.js';

function tmp(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'impact-test-'));
  return { dir, path: join(dir, 'assets.db') };
}

/** Build a tiny demo graph: server hosts service runs application.
 *  Side-chain: service depends_on database. */
function buildDemoGraph(store: AssetStore) {
  const server = store.create({ type: 'server', name: 'web-host' });
  const service = store.create({ type: 'service', name: 'api' });
  const app = store.create({ type: 'application', name: 'frontend' });
  const db = store.create({ type: 'database', name: 'pg' });
  store.addRelationship(server.id, service.id, 'hosts');
  store.addRelationship(service.id, app.id, 'runs');
  store.addRelationship(service.id, db.id, 'depends_on');
  return { server, service, app, db };
}

test('ImpactAnalyzer: downstream BFS reaches every dependent', () => {
  const { dir, path } = tmp();
  try {
    const store = new AssetStore(path);
    const g = buildDemoGraph(store);
    const ia = new ImpactAnalyzer(store);
    const report = ia.analyze(g.server.id, { direction: 'downstream' });
    assert.ok(report);
    assert.equal(report!.nodes.length, 4, 'all 4 nodes reachable');
    assert.equal(report!.nodes[0].asset.id, g.server.id, 'root first in BFS');
    const ids = report!.nodes.map(n => n.asset.id);
    assert.ok(ids.includes(g.service.id));
    assert.ok(ids.includes(g.app.id));
    assert.ok(ids.includes(g.db.id));
    assert.equal(report!.truncated, false);
    store.close();
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
});

test('ImpactAnalyzer: upstream BFS reaches every dependency', () => {
  const { dir, path } = tmp();
  try {
    const store = new AssetStore(path);
    const g = buildDemoGraph(store);
    const ia = new ImpactAnalyzer(store);
    // "What depends on the database?" walks up the graph from db.
    const report = ia.upstreamImpact(g.db.id);
    assert.ok(report);
    const ids = report!.nodes.map(n => n.asset.id);
    assert.ok(ids.includes(g.service.id), 'service depends_on db');
    assert.ok(ids.includes(g.server.id), 'server hosts service');
    assert.equal(report!.direction, 'upstream');
    store.close();
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
});

test('ImpactAnalyzer: depth bound + truncated flag', () => {
  const { dir, path } = tmp();
  try {
    const store = new AssetStore(path);
    // Build a linear chain: a → b → c → d → e
    const a = store.create({ type: 'server', name: 'a' });
    const b = store.create({ type: 'service', name: 'b' });
    const c = store.create({ type: 'service', name: 'c' });
    const d = store.create({ type: 'service', name: 'd' });
    const e = store.create({ type: 'service', name: 'e' });
    store.addRelationship(a.id, b.id, 'hosts');
    store.addRelationship(b.id, c.id, 'runs');
    store.addRelationship(c.id, d.id, 'depends_on');
    store.addRelationship(d.id, e.id, 'depends_on');
    const ia = new ImpactAnalyzer(store);

    const shallow = ia.analyze(a.id, { maxDepth: 2 });
    assert.equal(shallow!.nodes.length, 3, 'depth 2 → root + 2 levels = 3 nodes');
    assert.equal(shallow!.truncated, true, 'should be truncated — more reachable beyond');

    const full = ia.analyze(a.id, { maxDepth: 10 });
    assert.equal(full!.nodes.length, 5);
    assert.equal(full!.truncated, false);
    store.close();
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
});

test('ImpactAnalyzer: cycles do not cause infinite loops', () => {
  const { dir, path } = tmp();
  try {
    const store = new AssetStore(path);
    // a → b → c → a (cycle back)
    const a = store.create({ type: 'service', name: 'a' });
    const b = store.create({ type: 'service', name: 'b' });
    const c = store.create({ type: 'service', name: 'c' });
    store.addRelationship(a.id, b.id, 'depends_on');
    store.addRelationship(b.id, c.id, 'depends_on');
    store.addRelationship(c.id, a.id, 'depends_on');
    const ia = new ImpactAnalyzer(store);
    const report = ia.analyze(a.id);
    assert.equal(report!.nodes.length, 3, 'three distinct nodes despite cycle');
    // Edge for the cycle should still be in the edges list so a renderer
    // can show the loop visually.
    const edgeToA = report!.edges.find(e => e.childId === a.id);
    assert.ok(edgeToA, 'cycle edge present');
    store.close();
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
});

test('ImpactAnalyzer: returns null for unknown root', () => {
  const { dir, path } = tmp();
  try {
    const store = new AssetStore(path);
    const ia = new ImpactAnalyzer(store);
    assert.equal(ia.analyze('AST-FFFFFFFF'), null);
    store.close();
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
});

test('ImpactAnalyzer: isolated asset returns just itself', () => {
  const { dir, path } = tmp();
  try {
    const store = new AssetStore(path);
    const a = store.create({ type: 'other', name: 'lonely' });
    const ia = new ImpactAnalyzer(store);
    const report = ia.analyze(a.id);
    assert.equal(report!.nodes.length, 1);
    assert.equal(report!.edges.length, 0);
    assert.equal(report!.truncated, false);
    store.close();
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
});

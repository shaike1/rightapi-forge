import test from 'node:test';
import assert from 'node:assert/strict';
import { MODULES, getModule, importAllowed } from './ModuleRegistry.js';

test('every module declares a unique id + non-empty rootDir', () => {
  const ids = new Set<string>();
  for (const m of MODULES) {
    assert.ok(m.id.length > 0, `empty id`);
    assert.ok(m.rootDir.length > 0, `module ${m.id} missing rootDir`);
    assert.ok(!ids.has(m.id), `duplicate module id ${m.id}`);
    ids.add(m.id);
  }
});

test('every declared dependency points to an existing module', () => {
  const ids = new Set(MODULES.map(m => m.id));
  for (const m of MODULES) {
    for (const dep of m.dependencies) {
      assert.ok(ids.has(dep), `module ${m.id} depends on unknown ${dep}`);
    }
  }
});

test('getModule resolves by id', () => {
  const t = getModule('tenancy');
  assert.ok(t);
  assert.equal(t!.id, 'tenancy');
  assert.equal(getModule('does-not-exist'), undefined);
});

test('importAllowed: self-import is always allowed', () => {
  assert.equal(importAllowed('agents', 'agents'), true);
});

test('importAllowed reflects declared dependencies', () => {
  // skills declares dependencies: ['agents', 'security'].
  assert.equal(importAllowed('skills', 'agents'), true);
  assert.equal(importAllowed('skills', 'security'), true);
  // …but not workflows (which depends on skills, not the other way).
  assert.equal(importAllowed('skills', 'workflows'), false);
});

test('there is no cycle in declared dependencies', () => {
  const seen = new Map<string, 'visiting' | 'done'>();
  function visit(id: string, path: string[]): void {
    const state = seen.get(id);
    if (state === 'done') return;
    if (state === 'visiting') {
      throw new Error(`cycle detected: ${[...path, id].join(' → ')}`);
    }
    seen.set(id, 'visiting');
    const def = getModule(id);
    if (def) for (const dep of def.dependencies) visit(dep, [...path, id]);
    seen.set(id, 'done');
  }
  for (const m of MODULES) visit(m.id, []);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { WorkflowRegistry } from '../workflows/index.js';
import { RunbookLibrary } from './RunbookLibrary.js';

function tempDir(prefix: string): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `itops-${prefix}-`));
  return { dir, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } } };
}

function newRegistry(): { registry: WorkflowRegistry; cleanup: () => void } {
  const t = tempDir('runbooklib-reg');
  return { registry: new WorkflowRegistry({ workflowDir: t.dir }), cleanup: t.cleanup };
}

function writeRunbook(libDir: string, name: string, body: object): string {
  const file = path.join(libDir, `${name}.workflow.json`);
  fs.writeFileSync(file, JSON.stringify(body, null, 2), 'utf8');
  return file;
}

const VALID_RUNBOOK = (id: string, tags: string[] = []) => ({
  schemaVersion: 1, id, name: id, version: '1.0.0',
  description: `desc for ${id}`,
  tags,
  steps: [{ id: 's', type: 'bash', command: 'true' }],
});

// ─── Bundled library ───────────────────────────────────────────────────

test('default library directory loads every shipped *.workflow.json', () => {
  const { registry, cleanup } = newRegistry();
  try {
    const lib = new RunbookLibrary();
    const r = lib.loadAll(registry);
    // The library MUST contain at least the eleven runbooks the
    // platform ships (six original + five real-work additions).
    // Bumped together with new bundled runbooks so a regression where
    // a file fails to validate is caught in CI.
    assert.ok(r.loaded >= 11, `expected ≥11 loaded, got ${r.loaded}`);
    assert.equal(r.failed, 0);
    // Each must have the "library" tag.
    for (const rb of lib.list()) {
      assert.ok(rb.tags.includes('library'), `runbook ${rb.id} missing "library" tag`);
      assert.match(rb.id, /^library\./, `runbook ${rb.id} should use the "library." id prefix`);
    }
    // The five real-work additions MUST be present — if any file is
    // missing or fails validation, the schedule seeding in server.ts
    // would silently lose its workflow target. Keep this assertion
    // in lockstep with seedDefaultSchedules() in src/web/server.ts.
    const requiredIds = [
      'library.docker-housekeeping',
      'library.log-error-scan',
      'library.disk-space-audit',
      'library.security-audit',
      'library.service-dependency-check',
    ];
    for (const id of requiredIds) {
      assert.ok(lib.get(id), `bundled library is missing required runbook "${id}"`);
    }
  } finally { cleanup(); }
});

// ─── Custom directory + filtering ──────────────────────────────────────

test('list returns runbooks sorted by id', () => {
  const { dir, cleanup } = tempDir('runbooklib-sort');
  const reg = newRegistry();
  try {
    writeRunbook(dir, 'b', VALID_RUNBOOK('library.b'));
    writeRunbook(dir, 'a', VALID_RUNBOOK('library.a'));
    const lib = new RunbookLibrary({ libraryDir: dir });
    lib.loadAll(reg.registry);
    const ids = lib.list().map(r => r.id);
    assert.deepEqual(ids, ['library.a', 'library.b']);
  } finally { cleanup(); reg.cleanup(); }
});

test('byTag matches case-insensitively + returns only tagged runbooks', () => {
  const { dir, cleanup } = tempDir('runbooklib-tag');
  const reg = newRegistry();
  try {
    writeRunbook(dir, 'a', VALID_RUNBOOK('library.a', ['library', 'health']));
    writeRunbook(dir, 'b', VALID_RUNBOOK('library.b', ['library', 'security']));
    const lib = new RunbookLibrary({ libraryDir: dir });
    lib.loadAll(reg.registry);
    assert.deepEqual(lib.byTag('Health').map(r => r.id), ['library.a']);
    assert.deepEqual(lib.byTag('security').map(r => r.id), ['library.b']);
    assert.deepEqual(lib.byTag('missing'), []);
  } finally { cleanup(); reg.cleanup(); }
});

test('search matches across id / name / description / tags', () => {
  const { dir, cleanup } = tempDir('runbooklib-search');
  const reg = newRegistry();
  try {
    writeRunbook(dir, 'a', { ...VALID_RUNBOOK('library.disk-cleanup'), description: 'frees up disk space' });
    writeRunbook(dir, 'b', VALID_RUNBOOK('library.health-check', ['health', 'monitoring']));
    const lib = new RunbookLibrary({ libraryDir: dir });
    lib.loadAll(reg.registry);
    assert.deepEqual(lib.search('disk').map(r => r.id), ['library.disk-cleanup']);
    assert.deepEqual(lib.search('MONITORING').map(r => r.id), ['library.health-check']);
    assert.equal(lib.search('').length, 2, 'empty query returns all');
  } finally { cleanup(); reg.cleanup(); }
});

test('allTags returns the deduped sorted union of tags', () => {
  const { dir, cleanup } = tempDir('runbooklib-tags');
  const reg = newRegistry();
  try {
    writeRunbook(dir, 'a', VALID_RUNBOOK('library.a', ['library', 'health']));
    writeRunbook(dir, 'b', VALID_RUNBOOK('library.b', ['library', 'security']));
    const lib = new RunbookLibrary({ libraryDir: dir });
    lib.loadAll(reg.registry);
    assert.deepEqual(lib.allTags(), ['health', 'library', 'security']);
  } finally { cleanup(); reg.cleanup(); }
});

// ─── Error paths ───────────────────────────────────────────────────────

test('malformed JSON files are rejected without crashing the loader', () => {
  const { dir, cleanup } = tempDir('runbooklib-bad');
  const reg = newRegistry();
  try {
    fs.writeFileSync(path.join(dir, 'bad.workflow.json'), '{ this is not json', 'utf8');
    writeRunbook(dir, 'good', VALID_RUNBOOK('library.good'));
    const lib = new RunbookLibrary({ libraryDir: dir });
    const r = lib.loadAll(reg.registry);
    assert.equal(r.loaded, 1);
    assert.equal(r.failed, 1);
    assert.equal(lib.recentFailures().length, 1);
    assert.match(String(lib.recentFailures()[0].errors), /JSON|Unexpected/);
  } finally { cleanup(); reg.cleanup(); }
});

test('schema-invalid runbooks are rejected with the validator errors', () => {
  const { dir, cleanup } = tempDir('runbooklib-invalid');
  const reg = newRegistry();
  try {
    fs.writeFileSync(path.join(dir, 'invalid.workflow.json'), JSON.stringify({
      schemaVersion: 1, id: '', name: '', version: '', steps: [],
    }), 'utf8');
    const lib = new RunbookLibrary({ libraryDir: dir });
    const r = lib.loadAll(reg.registry);
    assert.equal(r.loaded, 0);
    assert.equal(r.failed, 1);
    const failures = lib.recentFailures();
    assert.equal(failures.length, 1);
    assert.ok(Array.isArray(failures[0].errors));
  } finally { cleanup(); reg.cleanup(); }
});

test('missing library directory degrades gracefully', () => {
  const reg = newRegistry();
  try {
    const lib = new RunbookLibrary({ libraryDir: path.join(os.tmpdir(), 'absolutely-does-not-exist-xyz123') });
    const r = lib.loadAll(reg.registry);
    assert.deepEqual(r, { loaded: 0, failed: 0 });
  } finally { reg.cleanup(); }
});

// ─── Registration with WorkflowRegistry ─────────────────────────────────

test('loaded runbooks become runnable through the WorkflowRegistry', () => {
  const { dir, cleanup } = tempDir('runbooklib-register');
  const reg = newRegistry();
  try {
    writeRunbook(dir, 'rb', VALID_RUNBOOK('library.example'));
    const lib = new RunbookLibrary({ libraryDir: dir });
    lib.loadAll(reg.registry);
    // The registry should now know about the runbook id.
    const wf = reg.registry.get('library.example');
    assert.ok(wf, 'registry must have the runbook after loadAll');
    assert.equal(wf!.id, 'library.example');
  } finally { cleanup(); reg.cleanup(); }
});

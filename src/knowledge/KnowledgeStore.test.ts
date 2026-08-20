import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { KnowledgeStore, sanitizeFtsQuery } from './KnowledgeStore.js';

function tmp(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'kb-test-'));
  return { dir, path: join(dir, 'kb.db') };
}

test('KnowledgeStore: create assigns KB-prefixed id and persists fields', () => {
  const { dir, path } = tmp();
  try {
    const store = new KnowledgeStore(path);
    const a = store.create({
      title: 'How to restart postgres',
      content: 'Run `systemctl restart postgresql`.',
      tags: ['postgres', 'restart'],
      linkedIncidents: ['INC-AAAA1111'],
      createdBy: 'alice',
      status: 'published',
    });
    assert.match(a.id, /^KB-[A-F0-9]{8}$/);
    assert.equal(a.status, 'published');
    assert.equal(a.usefulCount, 0);
    assert.deepEqual(a.tags, ['postgres', 'restart']);
    assert.deepEqual(a.linkedIncidents, ['INC-AAAA1111']);
    assert.equal(store.get(a.id)?.title, 'How to restart postgres');
    store.close();
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
});

test('KnowledgeStore: create rejects empty title/content', () => {
  const { dir, path } = tmp();
  try {
    const store = new KnowledgeStore(path);
    assert.throws(() => store.create({ title: '', content: 'x' }), /title/);
    assert.throws(() => store.create({ title: 'x', content: '' }), /content/);
    store.close();
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
});

test('KnowledgeStore: update merges fields, leaves others intact', () => {
  const { dir, path } = tmp();
  try {
    const store = new KnowledgeStore(path);
    const a = store.create({ title: 'Orig', content: 'body', tags: ['old'], status: 'draft' });
    const updated = store.update(a.id, { title: 'New title' });
    assert.equal(updated!.title, 'New title');
    assert.equal(updated!.content, 'body', 'content preserved');
    assert.deepEqual(updated!.tags, ['old'], 'tags preserved');
    assert.equal(updated!.status, 'draft', 'status preserved');
    store.close();
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
});

test('KnowledgeStore: incrementUseful bumps the counter', () => {
  const { dir, path } = tmp();
  try {
    const store = new KnowledgeStore(path);
    const a = store.create({ title: 't', content: 'c' });
    const r1 = store.incrementUseful(a.id);
    const r2 = store.incrementUseful(a.id);
    assert.equal(r1!.usefulCount, 1);
    assert.equal(r2!.usefulCount, 2);
    store.close();
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
});

test('KnowledgeStore: linkIncident is idempotent', () => {
  const { dir, path } = tmp();
  try {
    const store = new KnowledgeStore(path);
    const a = store.create({ title: 't', content: 'c', linkedIncidents: ['INC-1'] });
    store.linkIncident(a.id, 'INC-2');
    store.linkIncident(a.id, 'INC-2'); // idempotent
    const reloaded = store.get(a.id);
    assert.deepEqual(reloaded!.linkedIncidents, ['INC-1', 'INC-2']);
    store.close();
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
});

test('KnowledgeStore: list filters by status and tag', () => {
  const { dir, path } = tmp();
  try {
    const store = new KnowledgeStore(path);
    store.create({ title: 'a', content: 'x', status: 'published', tags: ['db'] });
    store.create({ title: 'b', content: 'x', status: 'draft',     tags: ['db', 'pg'] });
    store.create({ title: 'c', content: 'x', status: 'archived' });
    assert.equal(store.list({ status: 'published' }).length, 1);
    assert.equal(store.list({ status: 'draft' }).length, 1);
    assert.equal(store.list({ tag: 'db' }).length, 2);
    assert.equal(store.list({ tag: 'pg' }).length, 1);
    store.close();
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
});

test('KnowledgeStore: FTS5 search ranks results, drafts excluded by default', () => {
  const { dir, path } = tmp();
  try {
    const store = new KnowledgeStore(path);
    store.create({ title: 'restart postgres safely', content: 'use systemctl', status: 'published', tags: ['db'] });
    store.create({ title: 'reboot nginx',             content: 'pkill and restart', status: 'published' });
    store.create({ title: 'draft restart postgres',   content: 'use systemctl restart postgresql', status: 'draft' });

    const results = store.search('restart postgres');
    assert.ok(results.length >= 1, 'should find at least one match');
    assert.ok(results.some(r => r.title.includes('postgres')));
    assert.equal(results.filter(r => r.status === 'draft').length, 0, 'drafts excluded by default');

    // Explicit draft search.
    const drafts = store.search('restart postgres', { status: 'draft' });
    assert.ok(drafts.length >= 1, 'draft search returns drafts');
    store.close();
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
});

test('KnowledgeStore: topMatchForAutoReply only returns highly-upvoted articles', () => {
  const { dir, path } = tmp();
  try {
    const store = new KnowledgeStore(path);
    const a = store.create({ title: 'how to restart pg', content: 'do x', status: 'published' });
    // Below threshold (default 5).
    assert.equal(store.topMatchForAutoReply('restart pg'), null);
    // Bump useful_count to 5.
    for (let i = 0; i < 5; i++) store.incrementUseful(a.id);
    const hit = store.topMatchForAutoReply('restart pg');
    assert.ok(hit);
    assert.equal(hit!.id, a.id);
    store.close();
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
});

test('KnowledgeStore: delete removes the row + FTS mirror', () => {
  const { dir, path } = tmp();
  try {
    const store = new KnowledgeStore(path);
    const a = store.create({ title: 'gone soon', content: 'body', status: 'published' });
    assert.equal(store.search('gone soon').length, 1);
    assert.equal(store.delete(a.id), true);
    assert.equal(store.get(a.id), null);
    assert.equal(store.search('gone soon').length, 0, 'FTS mirror cleaned up via trigger');
    store.close();
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
});

test('KnowledgeStore: stats summarises totals + best useful_count', () => {
  const { dir, path } = tmp();
  try {
    const store = new KnowledgeStore(path);
    const a = store.create({ title: 'a', content: 'x', status: 'published' });
    store.create({ title: 'b', content: 'x', status: 'draft' });
    store.create({ title: 'c', content: 'x', status: 'draft' });
    for (let i = 0; i < 3; i++) store.incrementUseful(a.id);
    const s = store.stats();
    assert.equal(s.total, 3);
    assert.equal(s.byStatus.published, 1);
    assert.equal(s.byStatus.draft, 2);
    assert.equal(s.topUseful, 3);
    store.close();
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
});

test('sanitizeFtsQuery: strips FTS5 operators and quotes the phrase', () => {
  assert.equal(sanitizeFtsQuery(''), '');
  assert.equal(sanitizeFtsQuery('hello world'), '"hello world"');
  assert.equal(sanitizeFtsQuery('how to "restart"  postgres'), '"how to restart  postgres"');
  assert.equal(sanitizeFtsQuery('AND OR NOT'), '"AND OR NOT"', 'logical-operator words stay as-is inside the phrase');
  // Bracket characters get scrubbed so the FTS parser doesn't bork.
  assert.equal(sanitizeFtsQuery('foo (bar) baz'), '"foo  bar  baz"');
});

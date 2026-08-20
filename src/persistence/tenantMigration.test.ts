import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SqliteTaskStore, SqliteIncidentStore, SqliteAgentMemoryStore } from './SqliteStore.js';
import { runWithTenant, SYSTEM_TENANT_ID } from '../tenancy/TenantContext.js';
import { CredentialVault } from '../security/CredentialVault.js';

function tempPath(prefix: string): { dbPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `itops-${prefix}-`));
  return {
    dbPath: path.join(dir, 'db.db'),
    cleanup: () => {
      // Windows occasionally holds the SQLite WAL/SHM file open for a beat
      // after better-sqlite3.close(); rmSync EPERMs in that race. The
      // assertions have already run by this point, so swallowing the
      // cleanup error is the right call — the OS will reap the temp
      // directory eventually.
      try { fs.rmSync(dir, { recursive: true, force: true }); }
      catch (e: any) { if (e?.code !== 'EPERM' && e?.code !== 'EBUSY') throw e; }
    },
  };
}

function newTask(id: string, ownerId = 'agent-1') {
  return {
    id, title: `task ${id}`, description: '',
    status: 'pending' as const, priority: 'medium' as const, ownerId,
    category: 'infrastructure' as const, tags: [],
    createdAt: new Date(), updatedAt: new Date(),
  };
}

// ─── Task store ────────────────────────────────────────────────────────────

test('SqliteTaskStore writes carry the active tenant; reads scope to it', () => {
  const { dbPath, cleanup } = tempPath('task-tenant');
  try {
    const store = new SqliteTaskStore(dbPath);
    runWithTenant({ tenantId: 'acme' }, () => {
      store.upsert(newTask('a1'));
      store.upsert(newTask('a2'));
    });
    runWithTenant({ tenantId: 'beta' }, () => {
      store.upsert(newTask('b1'));
    });

    // Active scope filters reads.
    runWithTenant({ tenantId: 'acme' }, () => {
      const all = store.getAll();
      assert.equal(all.length, 2);
      assert.deepEqual(all.map(t => t.id).sort(), ['a1', 'a2']);
      assert.equal(store.count(), 2);
      assert.ok(store.get('a1'));
      assert.equal(store.get('b1'), undefined, 'beta task must not leak into acme');
    });
    runWithTenant({ tenantId: 'beta' }, () => {
      assert.equal(store.count(), 1);
      assert.ok(store.get('b1'));
    });
    store.close();
  } finally { cleanup(); }
});

test('SqliteTaskStore: outside any scope, the system tenant is the default', () => {
  const { dbPath, cleanup } = tempPath('task-system');
  try {
    const store = new SqliteTaskStore(dbPath);
    store.upsert(newTask('s1'));
    assert.equal(store.count(), 1);
    runWithTenant({ tenantId: 'unrelated' }, () => {
      assert.equal(store.count(), 0);
    });
    store.close();
  } finally { cleanup(); }
});

test('SqliteTaskStore explicit tenantId arg wins over the scope', () => {
  const { dbPath, cleanup } = tempPath('task-explicit');
  try {
    const store = new SqliteTaskStore(dbPath);
    runWithTenant({ tenantId: 'acme' }, () => {
      // Author is in acme but explicitly stamps the task as beta —
      // simulates an admin tool acting on behalf of another tenant.
      store.upsert(newTask('admin-cross-write'), 'beta');
    });
    runWithTenant({ tenantId: 'acme' }, () => assert.equal(store.count(), 0));
    runWithTenant({ tenantId: 'beta' }, () => assert.equal(store.count(), 1));
    store.close();
  } finally { cleanup(); }
});

// ─── Incident store ────────────────────────────────────────────────────────

test('SqliteIncidentStore isolates incidents + timeline + search by tenant', () => {
  const { dbPath, cleanup } = tempPath('inc-tenant');
  try {
    const store = new SqliteIncidentStore(dbPath);
    const mk = (id: string, title: string) => ({
      id, title, description: 'auth oauth network outage hostname',
      severity: 'high' as const, status: 'open' as const,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      source: 'manual' as const, slaMinutes: 120,
    });
    runWithTenant({ tenantId: 'acme' }, () => {
      store.upsert(mk('a-inc', 'oauth outage'));
      store.addTimeline({ id: 'tl-a', incidentId: 'a-inc', timestamp: new Date().toISOString(), actor: 'sys', type: 'note', message: 'opened' });
    });
    runWithTenant({ tenantId: 'beta' }, () => {
      store.upsert(mk('b-inc', 'network outage'));
    });

    runWithTenant({ tenantId: 'acme' }, () => {
      assert.equal(store.list().length, 1);
      assert.equal(store.list()[0].id, 'a-inc');
      assert.equal(store.getTimeline('a-inc').length, 1);
      // FTS search must be tenant-scoped — beta's identical-description
      // incident must NOT appear here even though both share a word.
      const hits = store.search('oauth');
      assert.deepEqual(hits, ['a-inc']);
      // Timeline lookup also stays scoped: even with an explicit
      // foreign id, a different tenant can't read it.
    });
    runWithTenant({ tenantId: 'beta' }, () => {
      assert.equal(store.list().length, 1);
      // Beta has its own incident with the shared description, so an
      // 'oauth' search returns ONLY beta's record, never acme's.
      assert.deepEqual(store.search('oauth'), ['b-inc']);
      // Beta cannot see acme's timeline.
      assert.equal(store.getTimeline('a-inc').length, 0);
    });
    store.close();
  } finally { cleanup(); }
});

// ─── Agent memory ──────────────────────────────────────────────────────────

test('SqliteAgentMemoryStore: facts, messages, reflections all isolate by tenant', () => {
  const { dbPath, cleanup } = tempPath('mem-tenant');
  try {
    const store = new SqliteAgentMemoryStore(dbPath);
    runWithTenant({ tenantId: 'acme' }, () => {
      store.saveFact('agent-1', 'acme fact');
      store.saveMessage('agent-1', 'user', 'acme message');
      store.storeReflection({
        taskId: 't-a', agentId: 'agent-1', selfRating: 5,
        whatWorked: ['x'], whatDidntWork: [], lessonsLearned: ['acme lesson'],
        suggestedImprovements: [], toolEfficiency: [],
        wouldDoDifferently: '', taskTitle: '', timestamp: new Date().toISOString(),
      });
    });
    runWithTenant({ tenantId: 'beta' }, () => {
      store.saveFact('agent-1', 'beta fact');
      store.saveMessage('agent-1', 'user', 'beta message');
    });

    runWithTenant({ tenantId: 'acme' }, () => {
      assert.deepEqual(store.listFacts('agent-1'), ['acme fact']);
      assert.equal(store.getRecentMessages('agent-1').length, 1);
      assert.equal(store.getReflections('agent-1').length, 1);
    });
    runWithTenant({ tenantId: 'beta' }, () => {
      assert.deepEqual(store.listFacts('agent-1'), ['beta fact']);
      assert.equal(store.getRecentMessages('agent-1').length, 1);
      assert.equal(store.getReflections('agent-1').length, 0);
    });
    store.close();
  } finally { cleanup(); }
});

// ─── CredentialVault ──────────────────────────────────────────────────────

test('CredentialVault scopes records by tenant; wrong-tenant reads return empty', () => {
  const { dbPath, cleanup } = tempPath('vault');
  try {
    const vault = new CredentialVault(dbPath, 'master-key-with-enough-entropy-1234567890ABCDE');
    let acmeId = '';
    let betaId = '';
    runWithTenant({ tenantId: 'acme' }, () => {
      acmeId = vault.upsert({ agentId: 'agent', name: 'a', scope: 'use', secret: 'AAA' }).id;
    });
    runWithTenant({ tenantId: 'beta' }, () => {
      betaId = vault.upsert({ agentId: 'agent', name: 'b', scope: 'use', secret: 'BBB' }).id;
    });
    runWithTenant({ tenantId: 'acme' }, () => {
      assert.deepEqual(vault.listByAgent('agent').map(c => c.name), ['a']);
      assert.equal(vault.resolveSecret(acmeId), 'AAA');
      assert.equal(vault.resolveSecret(betaId), null, 'beta secret must not leak into acme');
    });
    runWithTenant({ tenantId: 'beta' }, () => {
      assert.deepEqual(vault.listByAgent('agent').map(c => c.name), ['b']);
      assert.equal(vault.resolveSecret(betaId), 'BBB');
      assert.equal(vault.resolveSecret(acmeId), null);
    });
  } finally { cleanup(); }
});

test('CredentialVault: a credential cannot move tenants on subsequent upserts', () => {
  const { dbPath, cleanup } = tempPath('vault-move');
  try {
    const vault = new CredentialVault(dbPath, 'master-key-with-enough-entropy-1234567890ABCDE');
    let id = '';
    runWithTenant({ tenantId: 'acme' }, () => {
      id = vault.upsert({ agentId: 'agent', name: 'a', scope: 'use', secret: 'v1' }).id;
    });
    // Rotation in a different scope must NOT relocate the record.
    runWithTenant({ tenantId: 'beta' }, () => {
      vault.upsert({ id, agentId: 'agent', name: 'a', scope: 'use', secret: 'v2' });
    });
    // Acme keeps the record; beta still has nothing.
    runWithTenant({ tenantId: 'acme' }, () => {
      const list = vault.listByAgent('agent');
      assert.equal(list.length, 1);
      assert.equal(vault.resolveSecret(id), 'v2');
    });
    runWithTenant({ tenantId: 'beta' }, () => {
      assert.equal(vault.listByAgent('agent').length, 0);
    });
  } finally { cleanup(); }
});

test('CredentialVault: pre-tenancy vault files load with SYSTEM_TENANT_ID', () => {
  const { dbPath, cleanup } = tempPath('vault-legacy');
  try {
    // Author a vault file as the legacy code would have written it —
    // no tenantId field, but otherwise valid encrypted payload. Use the
    // production vault to make a record then strip tenantId from the
    // on-disk JSON.
    const vault1 = new CredentialVault(dbPath, 'master-key-with-enough-entropy-1234567890ABCDE');
    runWithTenant({ tenantId: 'acme' }, () => {
      vault1.upsert({ agentId: 'agent', name: 'old', scope: 'use', secret: 'legacy' });
    });
    const text = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    for (const r of text.records) delete r.tenantId;
    fs.writeFileSync(dbPath, JSON.stringify(text), 'utf8');
    // Reload — backfill should restore tenant via SYSTEM_TENANT_ID.
    const vault2 = new CredentialVault(dbPath, 'master-key-with-enough-entropy-1234567890ABCDE');
    runWithTenant({ tenantId: SYSTEM_TENANT_ID }, () => {
      const list = vault2.listByAgent('agent');
      assert.equal(list.length, 1);
      assert.equal(list[0].tenantId, SYSTEM_TENANT_ID);
    });
  } finally { cleanup(); }
});

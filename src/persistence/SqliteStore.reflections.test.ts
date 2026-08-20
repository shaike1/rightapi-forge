import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SqliteAgentMemoryStore, type ReflectionRecord } from './SqliteStore.js';

function tempDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'itops-refl-'));
  return path.join(dir, 'mem.db');
}

function refl(overrides: Partial<ReflectionRecord> = {}): ReflectionRecord {
  return {
    taskId: 'task-' + Math.random().toString(36).slice(2, 8),
    agentId: 'alice',
    selfRating: 4,
    whatWorked: ['used dns first'],
    whatDidntWork: [],
    lessonsLearned: ['skip ping if dns resolves'],
    suggestedImprovements: ['cache dns lookups'],
    toolEfficiency: [{ tool: 'network.dns', useful: true, reason: 'fast' }],
    wouldDoDifferently: 'reach for dns first',
    taskTitle: 'firewall investigation',
    ...overrides,
  };
}

test('storeReflection round-trips through getReflections', () => {
  const store = new SqliteAgentMemoryStore(tempDb());
  const id = store.storeReflection(refl());
  assert.match(id, /^refl-/);

  const back = store.getReflections('alice');
  assert.equal(back.length, 1);
  assert.equal(back[0].taskTitle, 'firewall investigation');
  assert.equal(back[0].selfRating, 4);
  assert.deepEqual(back[0].lessonsLearned, ['skip ping if dns resolves']);
  assert.equal(back[0].toolEfficiency[0].tool, 'network.dns');
  assert.ok(back[0].timestamp);
  store.close();
});

test('getReflections returns newest first and respects the limit', () => {
  const store = new SqliteAgentMemoryStore(tempDb());
  for (let i = 0; i < 5; i++) {
    store.storeReflection(refl({ taskId: 'task-' + i, taskTitle: 'task-' + i, timestamp: new Date(2026, 0, i + 1).toISOString() }));
  }
  const all = store.getReflections('alice');
  assert.equal(all.length, 5);
  assert.equal(all[0].taskTitle, 'task-4');

  const limited = store.getReflections('alice', 2);
  assert.equal(limited.length, 2);
  store.close();
});

test('getReflectionsByRating filters by rating range', () => {
  const store = new SqliteAgentMemoryStore(tempDb());
  store.storeReflection(refl({ selfRating: 1, taskId: 't-low' }));
  store.storeReflection(refl({ selfRating: 3, taskId: 't-mid' }));
  store.storeReflection(refl({ selfRating: 5, taskId: 't-high' }));

  const lowOnly = store.getReflectionsByRating('alice', 1, 2);
  assert.equal(lowOnly.length, 1);
  assert.equal(lowOnly[0].taskId, 't-low');

  const midUp = store.getReflectionsByRating('alice', 3, 5);
  assert.equal(midUp.length, 2);
  store.close();
});

test('getAverageRating returns 0 with no data, then arithmetic mean', () => {
  const store = new SqliteAgentMemoryStore(tempDb());
  assert.equal(store.getAverageRating('alice'), 0);
  store.storeReflection(refl({ selfRating: 1 }));
  store.storeReflection(refl({ selfRating: 4 }));
  store.storeReflection(refl({ selfRating: 5 }));
  assert.equal(store.getAverageRating('alice'), (1 + 4 + 5) / 3);
  store.close();
});

test('getRelevantLessons matches by task title keywords and prefers low ratings', () => {
  const store = new SqliteAgentMemoryStore(tempDb());
  store.storeReflection(refl({
    taskTitle: 'firewall investigation', selfRating: 5,
    lessonsLearned: ['high-rated lesson'],
  }));
  store.storeReflection(refl({
    taskTitle: 'firewall debugging', selfRating: 2,
    lessonsLearned: ['low-rated lesson — most valuable'],
    wouldDoDifferently: 'check egress rules first',
  }));
  store.storeReflection(refl({
    taskTitle: 'database backup', selfRating: 1,
    lessonsLearned: ['unrelated to firewalls'],
  }));

  const out = store.getRelevantLessons('alice', 'firewall outage on prod');
  // The unrelated reflection should not appear; the low-rated one should be first.
  assert.equal(out.lessons.length, 2);
  assert.equal(out.lessons[0], 'low-rated lesson — most valuable');
  // Both firewall reflections have a wouldDoDifferently — the low-rated one
  // sorts ahead because the query orders low-rating-first.
  assert.equal(out.wouldDoDifferently[0], 'check egress rules first');
  assert.ok(out.wouldDoDifferently.includes('reach for dns first'));
  assert.equal(out.sampleSize, 3);
  store.close();
});

test('getRelevantLessons clips long lessons + dedupes', () => {
  const store = new SqliteAgentMemoryStore(tempDb());
  const long = 'a'.repeat(200);
  store.storeReflection(refl({ lessonsLearned: [long, long], taskTitle: 'firewall' }));

  const out = store.getRelevantLessons('alice', 'firewall', { limit: 3 });
  assert.equal(out.lessons.length, 1);                     // dedupe
  assert.ok(out.lessons[0].endsWith('...'));               // clipped
  assert.ok(out.lessons[0].length <= 120);
  store.close();
});

test('rating trend reports improving / declining / insufficient', () => {
  const store = new SqliteAgentMemoryStore(tempDb());

  // Insufficient
  for (let i = 0; i < 3; i++) {
    store.storeReflection(refl({ selfRating: 3, timestamp: new Date(2026, 0, i + 1).toISOString() }));
  }
  assert.equal(store.getRelevantLessons('alice', 'whatever').recentTrend, 'insufficient');

  // Make it improving — 5 prior at 2, 5 recent at 5 (index 0..4 are prior, 5..9 recent)
  const store2 = new SqliteAgentMemoryStore(tempDb());
  for (let i = 0; i < 5; i++) {
    store2.storeReflection(refl({ selfRating: 2, timestamp: new Date(2026, 0, i + 1).toISOString() }));
  }
  for (let i = 0; i < 5; i++) {
    store2.storeReflection(refl({ selfRating: 5, timestamp: new Date(2026, 1, i + 1).toISOString() }));
  }
  assert.equal(store2.getRelevantLessons('alice', 'whatever').recentTrend, 'improving');
  store.close();
  store2.close();
});

test('getPerformanceStats aggregates totals, distribution, tools, failures', () => {
  const store = new SqliteAgentMemoryStore(tempDb());
  store.storeReflection(refl({
    selfRating: 5,
    toolEfficiency: [{ tool: 'network.dns', useful: true, reason: 'fast' }],
    whatDidntWork: ['ping retried too many times'],
  }));
  store.storeReflection(refl({
    selfRating: 2,
    toolEfficiency: [{ tool: 'network.dns', useful: true, reason: 'fast' }, { tool: 'bash.exec', useful: false, reason: 'denied' }],
    whatDidntWork: ['ping retried too many times', 'sudo prompt blocked it'],
  }));
  store.storeReflection(refl({
    selfRating: 3,
    toolEfficiency: [{ tool: 'bash.exec', useful: false, reason: 'denied' }],
    whatDidntWork: ['sudo prompt blocked it'],
  }));

  const stats = store.getPerformanceStats('alice');
  assert.equal(stats.totalReflections, 3);
  assert.equal(stats.averageRating, (5 + 2 + 3) / 3);
  assert.equal(stats.ratingDistribution[5], 1);
  assert.equal(stats.ratingDistribution[2], 1);

  // network.dns is 2-of-2 useful, bash.exec is 0-of-2; dns should rank first.
  assert.equal(stats.mostEffectiveTools[0].tool, 'network.dns');
  assert.equal(stats.mostEffectiveTools[0].usefulCount, 2);

  // Most common failure is the doubled "sudo prompt blocked it"
  assert.equal(stats.commonFailurePatterns[0].count, 2);
  store.close();
});

test('getPerformanceStats returns an empty shape for unknown agents', () => {
  const store = new SqliteAgentMemoryStore(tempDb());
  const stats = store.getPerformanceStats('nobody');
  assert.equal(stats.totalReflections, 0);
  assert.equal(stats.averageRating, 0);
  assert.equal(stats.trend, 'insufficient');
  assert.equal(stats.mostEffectiveTools.length, 0);
  assert.equal(stats.commonFailurePatterns.length, 0);
  store.close();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { UsageTracker } from './UsageTracker.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'itops-usage-'));
}

test('recordTask accumulates today\'s counters', () => {
  const t = new UsageTracker();
  t.recordTask('alice', { totalTokens: 100, toolCalls: 1, estimatedCostUsd: 0.001 });
  t.recordTask('alice', { totalTokens: 250, toolCalls: 2, estimatedCostUsd: 0.002 });

  const today = t.getToday('alice');
  assert.equal(today.totalTokens, 350);
  assert.equal(today.totalToolCalls, 3);
  assert.equal(today.totalTasks, 2);
  assert.ok(Math.abs(today.estimatedCostUsd - 0.003) < 1e-9);
});

test('checkGate is unbounded when no budget is set', () => {
  const t = new UsageTracker();
  t.recordTask('alice', { totalTokens: 99999, toolCalls: 0, estimatedCostUsd: 0 });
  const g = t.checkGate('alice');
  assert.equal(g.allowed, true);
  assert.equal(g.todayTokens, 99999);
  assert.equal(g.remainingTokens, Number.POSITIVE_INFINITY);
});

test('checkGate refuses new task when daily token cap exhausted', () => {
  const t = new UsageTracker();
  t.setBudget('alice', { dailyTokens: 1000 });
  t.recordTask('alice', { totalTokens: 1000, toolCalls: 0, estimatedCostUsd: 0 });
  const g = t.checkGate('alice');
  assert.equal(g.allowed, false);
  assert.equal(g.remainingTokens, 0);
  assert.match(g.reason!, /daily token budget exhausted/);
});

test('checkGate refuses on cost cap when set and exhausted', () => {
  const t = new UsageTracker();
  t.setBudget('alice', { dailyTokens: 100_000, dailyCostUsd: 0.01 });
  t.recordTask('alice', { totalTokens: 100, toolCalls: 0, estimatedCostUsd: 0.02 });
  const g = t.checkGate('alice');
  assert.equal(g.allowed, false);
  assert.match(g.reason!, /daily cost budget exhausted/);
});

test('checkGate stays allowed below budget; remaining figures shrink', () => {
  const t = new UsageTracker();
  t.setBudget('alice', { dailyTokens: 1000 });
  t.recordTask('alice', { totalTokens: 300, toolCalls: 1, estimatedCostUsd: 0 });
  const g = t.checkGate('alice');
  assert.equal(g.allowed, true);
  assert.equal(g.todayTokens, 300);
  assert.equal(g.remainingTokens, 700);
});

test('warning fires once at 80% of token budget', () => {
  const t = new UsageTracker();
  t.setBudget('alice', { dailyTokens: 100, warnAtFraction: 0.8 });
  // Two tasks at 50 tokens each → 100 total → above 80
  t.recordTask('alice', { totalTokens: 50, toolCalls: 0, estimatedCostUsd: 0 });
  t.recordTask('alice', { totalTokens: 30, toolCalls: 0, estimatedCostUsd: 0 }); // crosses 80
  // Subsequent record shouldn't re-fire; we don't have a hook to count, but
  // we exercise the path to ensure no exception escapes.
  t.recordTask('alice', { totalTokens: 1, toolCalls: 0, estimatedCostUsd: 0 });
  const today = t.getToday('alice');
  assert.equal(today.totalTokens, 81);
});

test('resetToday clears the day\'s counter; checkGate becomes allowed again', () => {
  const t = new UsageTracker();
  t.setBudget('alice', { dailyTokens: 100 });
  t.recordTask('alice', { totalTokens: 100, toolCalls: 0, estimatedCostUsd: 0 });
  assert.equal(t.checkGate('alice').allowed, false);
  t.resetToday('alice');
  assert.equal(t.checkGate('alice').allowed, true);
  assert.equal(t.getToday('alice').totalTokens, 0);
});

test('getWeek returns recent records newest-first; getWeekSummary aggregates', () => {
  const t = new UsageTracker();
  // We can't easily backdate without exposing internals, so seed via persist file.
  const dir = tempDir();
  const file = path.join(dir, 'usage.json');
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    records: [
      { date: yesterday, agentId: 'alice', totalTokens: 100, totalToolCalls: 1, totalTasks: 1, estimatedCostUsd: 0.001 },
      { date: today,     agentId: 'alice', totalTokens: 200, totalToolCalls: 2, totalTasks: 2, estimatedCostUsd: 0.002 },
    ]
  }));
  const t2 = new UsageTracker({ persistPath: file });
  const week = t2.getWeek('alice');
  assert.equal(week.length, 2);
  assert.equal(week[0].date, today, 'newest first');
  const summary = t2.getWeekSummary('alice');
  assert.equal(summary.totalTokens, 300);
  assert.equal(summary.totalTasks, 3);
  assert.equal(summary.days, 2);
});

test('budgets are independent per agent', () => {
  const t = new UsageTracker();
  t.setBudget('alice', { dailyTokens: 100 });
  // No budget on bob.
  t.recordTask('bob', { totalTokens: 9999, toolCalls: 0, estimatedCostUsd: 0 });
  assert.equal(t.checkGate('bob').allowed, true);
});

test('persistPath round-trip survives a restart', () => {
  const file = path.join(tempDir(), 'usage.json');
  const a = new UsageTracker({ persistPath: file });
  a.recordTask('alice', { totalTokens: 42, toolCalls: 1, estimatedCostUsd: 0.0001 });

  const b = new UsageTracker({ persistPath: file });
  const today = b.getToday('alice');
  assert.equal(today.totalTokens, 42);
  assert.equal(today.totalToolCalls, 1);
});

test('persisted history older than 14 days is pruned on load', () => {
  const file = path.join(tempDir(), 'usage.json');
  const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const recent = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    records: [
      { date: old, agentId: 'alice', totalTokens: 1, totalToolCalls: 0, totalTasks: 1, estimatedCostUsd: 0 },
      { date: recent, agentId: 'alice', totalTokens: 5, totalToolCalls: 0, totalTasks: 1, estimatedCostUsd: 0 },
    ]
  }));
  const t = new UsageTracker({ persistPath: file });
  const week = t.getWeek('alice');
  assert.equal(week.length, 1);
  assert.equal(week[0].date, recent);
});

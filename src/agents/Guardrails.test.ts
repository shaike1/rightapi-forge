import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GuardrailRunner,
  ConcurrencyLimiter,
  resolveGuardrails,
  DEFAULT_GUARDRAILS,
} from './Guardrails.js';

const baseCfg = {
  maxIterations: 10,
  maxTokensPerTask: 10000,
  maxDurationMs: 60_000,
  maxToolCallsPerTask: 20,
  maxDelegationDepth: 3,
  maxConcurrentTasks: 3,
};

// ─── resolveGuardrails ────────────────────────────────────────────────────

test('resolveGuardrails returns role default when no overrides given', () => {
  const cfg = resolveGuardrails('sysadmin');
  assert.equal(cfg.maxIterations, DEFAULT_GUARDRAILS.sysadmin.maxIterations);
  assert.equal(cfg.maxTokensPerTask, DEFAULT_GUARDRAILS.sysadmin.maxTokensPerTask);
});

test('resolveGuardrails overlays partial overrides on the role default', () => {
  const cfg = resolveGuardrails('specialist', { maxIterations: 99, costBudgetUsd: 1.25 });
  assert.equal(cfg.maxIterations, 99);
  assert.equal(cfg.costBudgetUsd, 1.25);
  // unspecified fields fall through to role default
  assert.equal(cfg.maxTokensPerTask, DEFAULT_GUARDRAILS.specialist.maxTokensPerTask);
});

test('resolveGuardrails falls back to "individual" defaults for unknown roles', () => {
  const cfg = resolveGuardrails('weird-role' as any);
  assert.equal(cfg.maxIterations, DEFAULT_GUARDRAILS.individual.maxIterations);
});

// ─── GuardrailRunner.check (per limit) ────────────────────────────────────

test('check passes when no counters have moved', () => {
  const r = new GuardrailRunner(baseCfg);
  assert.equal(r.check().ok, true);
});

test('check trips on iteration cap', () => {
  const r = new GuardrailRunner({ ...baseCfg, maxIterations: 2 });
  r.recordIteration();
  r.recordIteration();
  const v = r.check();
  assert.equal(v.ok, false);
  assert.equal(v.limitType, 'iterations');
  assert.match(v.reason!, /iteration cap \(2\)/);
});

test('check trips on tool-call cap', () => {
  const r = new GuardrailRunner({ ...baseCfg, maxToolCallsPerTask: 2 });
  r.recordToolCall();
  r.recordToolCall();
  const v = r.check();
  assert.equal(v.ok, false);
  assert.equal(v.limitType, 'tool_calls');
});

test('check trips on token budget', () => {
  const r = new GuardrailRunner({ ...baseCfg, maxTokensPerTask: 100 });
  r.recordTokens(60, 60);
  const v = r.check();
  assert.equal(v.ok, false);
  assert.equal(v.limitType, 'tokens');
  assert.match(v.reason!, /token budget \(100\)/);
});

test('check trips on duration cap', async () => {
  const r = new GuardrailRunner({ ...baseCfg, maxDurationMs: 1 });
  await new Promise(res => setTimeout(res, 5));
  const v = r.check();
  assert.equal(v.ok, false);
  assert.equal(v.limitType, 'duration');
});

test('check trips on USD cost budget when set', () => {
  // claude rate is $0.015/1k tokens. 1000 tokens = $0.015.
  const r = new GuardrailRunner({ ...baseCfg, costBudgetUsd: 0.01 }, 'claude');
  r.recordTokens(800, 0); // $0.012, exceeds $0.01
  const v = r.check();
  assert.equal(v.ok, false);
  assert.equal(v.limitType, 'cost_budget');
  assert.match(v.reason!, /cost budget/);
});

test('cost is 0 for ollama (local)', () => {
  // Bump the token budget so we're testing the cost path, not the token cap.
  const r = new GuardrailRunner({ ...baseCfg, maxTokensPerTask: 10_000_000, costBudgetUsd: 0.01 }, 'ollama');
  r.recordTokens(1_000_000, 0);
  assert.equal(r.snapshot().estimatedCostUsd, 0);
  assert.equal(r.check().ok, true);
});

// ─── time-almost-up + urgency hint ────────────────────────────────────────

test('isTimeAlmostUp false at start, true near deadline', async () => {
  // 1000ms budget so the < 10% window (under 100ms) is comfortably wider
  // than OS scheduling jitter on Windows.
  const r = new GuardrailRunner({ ...baseCfg, maxDurationMs: 1000 });
  assert.equal(r.isTimeAlmostUp(), false);
  await new Promise(res => setTimeout(res, 925));
  assert.equal(r.isTimeAlmostUp(), true);
});

test('urgencyHint contains a seconds estimate', async () => {
  const r = new GuardrailRunner({ ...baseCfg, maxDurationMs: 1000 });
  await new Promise(res => setTimeout(res, 925));
  const hint = r.urgencyHint();
  assert.ok(hint);
  assert.match(hint!, /URGENT/);
  assert.match(hint!, /\d+s left/);
});

// ─── recordTokensFromText fallback ────────────────────────────────────────

test('recordTokensFromText estimates tokens from char length when usage missing', () => {
  const r = new GuardrailRunner(baseCfg);
  r.recordTokensFromText('a'.repeat(400), 'b'.repeat(800));
  // ~4 chars/token: 100 + 200 = 300
  assert.equal(r.snapshot().totalTokens, 300);
});

// ─── snapshot ─────────────────────────────────────────────────────────────

test('snapshot reports the live counter state', () => {
  const r = new GuardrailRunner(baseCfg, 'claude');
  r.recordIteration();
  r.recordIteration();
  r.recordToolCall();
  r.recordTokens(500, 500);
  const s = r.snapshot();
  assert.equal(s.iterations, 2);
  assert.equal(s.toolCalls, 1);
  assert.equal(s.totalTokens, 1000);
  assert.ok(s.elapsedMs >= 0);
  assert.ok(s.estimatedCostUsd > 0);
});

// ─── ConcurrencyLimiter ───────────────────────────────────────────────────

test('ConcurrencyLimiter blocks the (max+1)-th task and releases on completion', () => {
  const lim = new ConcurrencyLimiter();
  const a = lim.acquire('alice', 2);
  const b = lim.acquire('alice', 2);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(lim.active_count('alice'), 2);

  const c = lim.acquire('alice', 2);
  assert.equal(c.ok, false);
  assert.equal((c as any).limitType, 'concurrent_tasks');
  assert.match((c as any).reason, /already running 2\/2/);

  // Release one and verify a third acquire now succeeds.
  if (a.ok === true) a.release();
  assert.equal(lim.active_count('alice'), 1);
  const d = lim.acquire('alice', 2);
  assert.equal(d.ok, true);
});

test('ConcurrencyLimiter is per-agent', () => {
  const lim = new ConcurrencyLimiter();
  lim.acquire('alice', 1);
  const bob = lim.acquire('bob', 1);
  assert.equal(bob.ok, true, 'bob should not be blocked by alice');
});

test('ConcurrencyLimiter release is idempotent at zero', () => {
  const lim = new ConcurrencyLimiter();
  const a = lim.acquire('alice', 1);
  if (a.ok === true) {
    a.release();
    a.release(); // double-release shouldn't go negative
  }
  assert.equal(lim.active_count('alice'), 0);
});

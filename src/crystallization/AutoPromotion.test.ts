import test from 'node:test';
import assert from 'node:assert/strict';
import { AutoPromotion } from './AutoPromotion.js';
import type { CrystallizedSkill, CrystallizedSkillStatus } from './CrystallizedSkillTypes.js';

function skill(overrides: Partial<CrystallizedSkill> = {}): CrystallizedSkill {
  return {
    id: 'cskill-1', tenantId: 'system',
    name: 's', description: '',
    sourceResolutionId: 'r', sourceAgentId: 'a',
    generatedWorkflow: '{}', parameters: [], tags: [],
    status: 'draft', confidenceScore: 0.9,
    usageCount: 0, recentUsage: [],
    createdAt: '', updatedAt: '',
    ...overrides,
  };
}

const ap = new AutoPromotion();

// ─── decideOnCreate ───────────────────────────────────────────────────

test('decideOnCreate: high confidence + rating 5 → approved', () => {
  const d = ap.decideOnCreate(skill({ confidenceScore: 0.85 }), 5);
  assert.equal(d.next, 'approved');
});

test('decideOnCreate: confidence below 0.8 → no auto-approve', () => {
  const d = ap.decideOnCreate(skill({ confidenceScore: 0.79 }), 5);
  assert.equal(d.next, null);
  assert.match(d.reason, /confidence/);
});

test('decideOnCreate: rating below 4 → no auto-approve', () => {
  const d = ap.decideOnCreate(skill({ confidenceScore: 0.95 }), 3);
  assert.equal(d.next, null);
  assert.match(d.reason, /rating/);
});

test('decideOnCreate: missing rating → no auto-approve', () => {
  const d = ap.decideOnCreate(skill({ confidenceScore: 0.95 }), undefined);
  assert.equal(d.next, null);
});

test('decideOnCreate: skill not in draft is a no-op', () => {
  const d = ap.decideOnCreate(skill({ status: 'active' }), 5);
  assert.equal(d.next, null);
  assert.match(d.reason, /not in draft/);
});

// ─── decideOnUsage: approved → active ─────────────────────────────────

const ok = (n = 1) => Array.from({ length: n }, () => ({ at: '', outcome: 'success' as const }));

test('approved → active when 3+ uses with all-success', () => {
  const s = skill({ status: 'approved', usageCount: 3, recentUsage: ok(3) });
  const d = ap.decideOnUsage(s);
  assert.equal(d.next, 'active');
});

test('approved → no transition when only 2 uses', () => {
  const s = skill({ status: 'approved', usageCount: 2, recentUsage: ok(2) });
  const d = ap.decideOnUsage(s);
  assert.equal(d.next, null);
});

test('approved → no transition when one of the recent runs failed', () => {
  const s = skill({
    status: 'approved', usageCount: 5,
    recentUsage: [...ok(4), { at: '', outcome: 'failed' as const }],
  });
  const d = ap.decideOnUsage(s);
  assert.equal(d.next, null);
});

// ─── decideOnUsage: active → draft ────────────────────────────────────

test('active demotes to draft when last 5 outcomes are < 50% success', () => {
  const recent: CrystallizedSkill['recentUsage'] = [
    { at: '', outcome: 'failed' },
    { at: '', outcome: 'failed' },
    { at: '', outcome: 'success' },
    { at: '', outcome: 'failed' },
    { at: '', outcome: 'failed' },
  ];
  const s = skill({ status: 'active', usageCount: 12, recentUsage: recent });
  const d = ap.decideOnUsage(s);
  assert.equal(d.next, 'draft');
  assert.match(d.reason, /demote/);
});

test('active stays active when success rate is at the threshold (50%)', () => {
  // 50% is the boundary; demotion fires only on STRICTLY less than 50%.
  const recent: CrystallizedSkill['recentUsage'] = [
    { at: '', outcome: 'success' }, { at: '', outcome: 'failed' },
    { at: '', outcome: 'success' }, { at: '', outcome: 'failed' },
    { at: '', outcome: 'success' },
  ];
  const s = skill({ status: 'active', usageCount: 12, recentUsage: recent });
  const d = ap.decideOnUsage(s);
  assert.equal(d.next, null);
});

test('active does not demote until the demotion window has filled', () => {
  // Only 3 recent outcomes; below the default window of 5.
  const recent: CrystallizedSkill['recentUsage'] = [
    { at: '', outcome: 'failed' }, { at: '', outcome: 'failed' }, { at: '', outcome: 'failed' },
  ];
  const s = skill({ status: 'active', usageCount: 3, recentUsage: recent });
  const d = ap.decideOnUsage(s);
  assert.equal(d.next, null);
});

// ─── status guards ─────────────────────────────────────────────────────

test('rejected skills never transition automatically', () => {
  const r1 = ap.decideOnCreate(skill({ status: 'rejected' }), 5);
  const r2 = ap.decideOnUsage(skill({ status: 'rejected' }));
  assert.equal(r1.next, null);
  assert.equal(r2.next, null);
});

test('draft never transitions on usage (only on create)', () => {
  const s = skill({ status: 'draft', usageCount: 10, recentUsage: ok(10) });
  const d = ap.decideOnUsage(s);
  assert.equal(d.next, null);
});

// ─── tunable thresholds ────────────────────────────────────────────────

test('options override the gates', () => {
  const looser = new AutoPromotion({ approveConfidenceThreshold: 0.5, approveMinSourceRating: 3 });
  const d = looser.decideOnCreate(skill({ confidenceScore: 0.55 }), 3);
  assert.equal(d.next, 'approved');
});

void [{} as CrystallizedSkillStatus];

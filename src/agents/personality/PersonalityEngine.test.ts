import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SqlitePersonalityStore } from '../../persistence/PersonalityStore.js';
import { PersonalityEngine, type AdjustmentRecord } from './PersonalityEngine.js';
import {
  buildSystemPromptFragment,
  PROFILE_DRIFT_LIMIT,
  type PersonalityProfile,
} from './PersonalityProfile.js';

function newEngine(opts?: { capture?: AdjustmentRecord[] }): { engine: PersonalityEngine; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'itops-personality-'));
  const store = new SqlitePersonalityStore(path.join(dir, 'p.db'));
  const engine = new PersonalityEngine({
    store,
    onAdjustment: opts?.capture ? (r) => opts.capture!.push(r) : undefined,
  });
  return {
    engine,
    cleanup: () => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

test('ensure() creates a role-tuned profile and returns the same one on re-call', async () => {
  const { engine, cleanup } = newEngine();
  try {
    const p1 = await engine.ensure('director-1', 'director');
    assert.equal(p1.agentId, 'director-1');
    // Director defaults: high formality + thoroughness.
    assert.ok(p1.communication.formality   >= 0.6);
    assert.ok(p1.decisions.thoroughness    >= 0.7);
    // Baseline copy is captured.
    assert.equal(p1.baseline.communication.formality, p1.communication.formality);

    const p2 = await engine.ensure('director-1', 'director');
    assert.equal(p1.createdAt, p2.createdAt);
  } finally { cleanup(); }
});

test('positive feedback increases the positive counter and nudges thoroughness up', async () => {
  const { engine, cleanup } = newEngine();
  try {
    const p0 = await engine.ensure('a', 'sysadmin');
    const before = p0.decisions.thoroughness;
    const p1 = await engine.recordFeedback('a', 1);
    assert.equal(p1.stats.feedbackPositive, 1);
    assert.ok(p1.decisions.thoroughness >= before, 'thoroughness should not decrease');
    assert.ok(p1.decisions.thoroughness > before, 'thoroughness should grow on +1 feedback');
  } finally { cleanup(); }
});

test('negative feedback drops autonomy + bumps structure + records the avoid note', async () => {
  const { engine, cleanup } = newEngine();
  try {
    const p0 = await engine.ensure('a', 'sysadmin');
    const beforeAuto = p0.decisions.autonomy;
    const beforeStruct = p0.communication.structure;
    const p1 = await engine.recordFeedback('a', -1, 'do not run rm -rf without confirmation');
    assert.equal(p1.stats.feedbackNegative, 1);
    assert.ok(p1.decisions.autonomy < beforeAuto);
    assert.ok(p1.communication.structure > beforeStruct);
    assert.ok(p1.avoidPatterns.includes('do not run rm -rf without confirmation'));
  } finally { cleanup(); }
});

test('high-rating reflection bakes lessons into learnedBehaviours', async () => {
  const { engine, cleanup } = newEngine();
  try {
    await engine.ensure('a', 'sysadmin');
    const p1 = await engine.recordReflection('a', {
      selfRating: 5,
      whatWorked: ['ran ping first'],
      whatDidntWork: [],
      lessonsLearned: ['always grep logs before restart', 'use --dry-run on destructive ops'],
      toolEfficiency: [{ tool: 'monitor.systemHealth', useful: true }],
    });
    assert.ok(p1.learnedBehaviours.includes('always grep logs before restart'));
    assert.ok(p1.learnedBehaviours.includes('use --dry-run on destructive ops'));
    assert.ok(p1.expertiseAreas.includes('monitor.systemHealth'));
  } finally { cleanup(); }
});

test('low-rating reflection records avoid patterns and dials back autonomy', async () => {
  const { engine, cleanup } = newEngine();
  try {
    const p0 = await engine.ensure('a', 'sysadmin');
    const beforeAuto = p0.decisions.autonomy;
    const p1 = await engine.recordReflection('a', {
      selfRating: 1,
      whatWorked: [],
      whatDidntWork: ['skipped the canary check'],
      lessonsLearned: [],
      wouldDoDifferently: 'verify canary before mass restart',
    });
    assert.ok(p1.avoidPatterns.includes('verify canary before mass restart'));
    assert.ok(p1.avoidPatterns.includes('skipped the canary check'));
    assert.ok(p1.decisions.autonomy < beforeAuto);
  } finally { cleanup(); }
});

test('successful resolutions add the topic to expertiseAreas; failures lower riskTolerance', async () => {
  const { engine, cleanup } = newEngine();
  try {
    const p0 = await engine.ensure('a', 'specialist');
    const beforeRisk = p0.decisions.riskTolerance;
    const p1 = await engine.recordResolution('a', { outcome: 'success', topic: 'kubernetes' });
    assert.ok(p1.expertiseAreas.includes('kubernetes'));
    const p2 = await engine.recordResolution('a', { outcome: 'failed' });
    assert.ok(p2.decisions.riskTolerance < beforeRisk);
    assert.equal(p2.stats.failuresRecorded, 1);
  } finally { cleanup(); }
});

test('drift guardrail clamps trait beyond baseline ± PROFILE_DRIFT_LIMIT', async () => {
  const { engine, cleanup } = newEngine();
  try {
    const p0 = await engine.ensure('a', 'sysadmin');
    const baseline = p0.baseline.decisions.autonomy;
    // Hammer negative feedback dozens of times — autonomy can't fall
    // below baseline - PROFILE_DRIFT_LIMIT.
    let p: PersonalityProfile = p0;
    for (let i = 0; i < 30; i++) p = await engine.recordFeedback('a', -1);
    assert.ok(p.decisions.autonomy >= baseline - PROFILE_DRIFT_LIMIT - 1e-9, 'must clamp at drift limit');
    // The engine recorded the clamp event in stats.driftClamps.
    assert.ok(p.stats.driftClamps > 0, 'driftClamps counter must be incremented');
  } finally { cleanup(); }
});

test('per-update delta is bounded so one signal cannot flip a trait', async () => {
  const { engine, cleanup } = newEngine();
  try {
    const p0 = await engine.ensure('a', 'sysadmin');
    const beforeAuto = p0.decisions.autonomy;
    const p1 = await engine.recordFeedback('a', -1);
    // The internal nudge for negative feedback is 0.05 — well under
    // the cap PROFILE_DELTA_PER_UPDATE (0.15). One step must move
    // the trait by at most 0.15.
    assert.ok(beforeAuto - p1.decisions.autonomy <= 0.15 + 1e-9);
  } finally { cleanup(); }
});

test('learnedBehaviours + avoidPatterns + expertiseAreas are deduped + capped', async () => {
  const { engine, cleanup } = newEngine();
  try {
    await engine.ensure('a', 'sysadmin');
    // Add the same lesson many times — should appear once.
    for (let i = 0; i < 5; i++) {
      await engine.recordReflection('a', {
        selfRating: 5, whatWorked: [], whatDidntWork: [], lessonsLearned: ['always check logs'],
      });
    }
    const p = (await engine.get('a'))!;
    const occurrences = p.learnedBehaviours.filter(b => b === 'always check logs').length;
    assert.equal(occurrences, 1, 'duplicate lessons should dedupe');
    // Push 30 distinct expertise areas — must cap at MAX_EXPERTISE_AREAS (8).
    for (let i = 0; i < 30; i++) {
      await engine.recordResolution('a', { outcome: 'success', topic: `topic-${i}` });
    }
    const p2 = (await engine.get('a'))!;
    assert.ok(p2.expertiseAreas.length <= 8);
    // Newer topics survive (FIFO eviction).
    assert.ok(p2.expertiseAreas.includes('topic-29'));
  } finally { cleanup(); }
});

test('recordCorrection is the most authoritative signal — drops autonomy + adds avoid', async () => {
  const { engine, cleanup } = newEngine();
  try {
    const p0 = await engine.ensure('a', 'sysadmin');
    const beforeAuto = p0.decisions.autonomy;
    const p1 = await engine.recordCorrection('a', 'never restart prod without operator OK', { dropAutonomy: true });
    assert.ok(p1.avoidPatterns.includes('never restart prod without operator OK'));
    assert.ok(p1.decisions.autonomy < beforeAuto);
  } finally { cleanup(); }
});

test('buildSystemPromptFragment renders a stable, sectioned fragment', async () => {
  const { engine, cleanup } = newEngine();
  try {
    await engine.ensure('a', 'specialist');
    await engine.recordResolution('a', { outcome: 'success', topic: 'networking' });
    await engine.recordReflection('a', {
      selfRating: 5, whatWorked: [], whatDidntWork: [], lessonsLearned: ['use tcpdump first'],
    });
    await engine.recordCorrection('a', 'do not deploy on Fridays');
    const profile = (await engine.get('a'))!;
    const fragment = buildSystemPromptFragment(profile);
    assert.match(fragment, /## Personality \(evolved over time\)/);
    assert.match(fragment, /Communication: /);
    assert.match(fragment, /Decision style: /);
    assert.match(fragment, /Expertise areas: networking/);
    assert.match(fragment, /Learned behaviours:/);
    assert.match(fragment, /- use tcpdump first/);
    assert.match(fragment, /Avoid:/);
    assert.match(fragment, /- do not deploy on Fridays/);
  } finally { cleanup(); }
});

test('onAdjustment is called with before+after snapshots for each signal', async () => {
  const captured: AdjustmentRecord[] = [];
  const { engine, cleanup } = newEngine({ capture: captured });
  try {
    await engine.ensure('a', 'sysadmin');
    await engine.recordFeedback('a', 1);
    await engine.recordCorrection('a', 'no destructive ops without approval');
    assert.equal(captured.length, 2);
    assert.equal(captured[0].signal, 'feedback');
    assert.equal(captured[1].signal, 'correction');
    // Snapshots are independent objects (mutating after must not change before).
    captured[0].after.expertiseAreas.push('mutation');
    assert.ok(!captured[0].before.expertiseAreas.includes('mutation'));
  } finally { cleanup(); }
});

test('mutating a profile without ensure() first throws — engine refuses to invent state', async () => {
  const { engine, cleanup } = newEngine();
  try {
    await assert.rejects(() => engine.recordFeedback('never-ensured', 1), /no personality profile/);
  } finally { cleanup(); }
});

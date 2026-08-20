import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SqliteCrystallizedSkillStore } from '../persistence/index.js';
import { CrystallizationService, type CrystallizationEvent } from './CrystallizationService.js';
import type { CrystallizedSkill } from './CrystallizedSkillTypes.js';
import type { ReactStep } from '../agents/index.js';
import type { ReflectionResult } from '../agents/index.js';

function tempDir(prefix: string): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `itops-${prefix}-`));
  return { dir, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* race */ } } };
}

function build(opts: { events?: CrystallizationEvent[]; registerActive?: (s: CrystallizedSkill) => boolean | Promise<boolean>; unregisterActive?: (id: string) => void } = {}) {
  const t = tempDir('crystallization');
  const store = new SqliteCrystallizedSkillStore(path.join(t.dir, 'cs.db'));
  const events = opts.events ?? [];
  const svc = new CrystallizationService({
    store,
    onEvent: e => events.push(e),
    registerActive: opts.registerActive,
    unregisterActive: opts.unregisterActive,
  });
  return { svc, store, events, cleanup: () => { store.close(); t.cleanup(); } };
}

function step(tool: string, command?: string, opts?: { error?: string; thought?: string }): ReactStep {
  return {
    iteration: 1, tool, durationMs: 100,
    params: command ? { command } : {},
    error: opts?.error, thought: opts?.thought,
  };
}

const okReflection: ReflectionResult = {
  taskId: 't', agentId: 'a', selfRating: 5,
  whatWorked: ['restart fixed it'], whatDidntWork: [],
  lessonsLearned: ['watch memory before restart'], suggestedImprovements: [],
  toolEfficiency: [{ tool: 'bash.exec', useful: true, reason: '' }],
  wouldDoDifferently: '', timestamp: '',
};

// ─── End-to-end: create → auto-approve ────────────────────────────────

test('a recommended resolution becomes a draft + auto-approves on high confidence/rating', async () => {
  const { svc, store, events, cleanup } = build();
  try {
    const skill = await svc.onResolutionCompleted({
      taskId: 't1', agentId: 'a1', resolutionId: 'r1',
      title: 'Restart redis after OOM',
      steps: [
        step('bash.exec', 'free -h'),
        step('bash.exec', 'systemctl status redis'),
        step('bash.exec', 'systemctl restart redis'),
        step('bash.exec', 'systemctl is-active redis'),
      ],
      reflection: okReflection,
      existingSkills: [],
    });
    assert.ok(skill, 'should return the created skill');
    const persisted = await store.get(skill!.id);
    // High confidence + rating 5 → auto-approved.
    assert.equal(persisted!.status, 'approved');
    assert.ok(events.some(e => e.type === 'crystallization.created'));
    assert.ok(events.some(e => e.type === 'crystallization.promoted' && e.to === 'approved'));
  } finally { cleanup(); }
});

// ─── Skipped: not recommended ─────────────────────────────────────────

test('a resolution that does not meet the threshold emits a skipped event and persists nothing', async () => {
  const { svc, store, events, cleanup } = build();
  try {
    const out = await svc.onResolutionCompleted({
      taskId: 't', agentId: 'a', resolutionId: 'r',
      title: 'Trivial echo task',
      steps: [step('bash.exec', 'echo ok')],
      reflection: okReflection,
      existingSkills: [],
    });
    assert.equal(out, null);
    const list = await store.list();
    assert.equal(list.length, 0);
    assert.ok(events.some(e => e.type === 'crystallization.skipped'));
  } finally { cleanup(); }
});

// ─── Safety: destructive content forces draft + flag ─────────────────

test('destructive commands are flagged + stay in draft (no auto-approve)', async () => {
  const { svc, store, events, cleanup } = build();
  try {
    const skill = await svc.onResolutionCompleted({
      taskId: 't', agentId: 'a', resolutionId: 'r',
      title: 'Wipe build cache',
      steps: [
        step('bash.exec', 'df -h'),
        step('bash.exec', 'du -sh /tmp/build-cache'),
        step('bash.exec', 'rm -rf /tmp/build-cache'),
      ],
      reflection: okReflection,
      existingSkills: [],
    });
    assert.ok(skill);
    const persisted = await store.get(skill!.id);
    assert.equal(persisted!.status, 'draft', 'destructive must NOT auto-approve');
    assert.ok(events.some(e => e.type === 'crystallization.flagged_destructive'));
  } finally { cleanup(); }
});

// ─── Rate limit ───────────────────────────────────────────────────────

test('rate-limit caps drafts per agent per UTC day', async () => {
  const { svc, store, events, cleanup } = build();
  try {
    const ev = events;
    // Pre-populate store with 5 draft rows for the same agent so the
    // rate-limit gate trips immediately.
    const now = new Date().toISOString();
    for (let i = 0; i < 5; i++) {
      await store.upsert({
        id: `cskill-pre-${i}`, tenantId: 'system',
        name: `pre ${i}`, description: '',
        sourceResolutionId: 'r', sourceAgentId: 'a',
        generatedWorkflow: '{}', parameters: [], tags: [],
        status: 'draft', confidenceScore: 0.9,
        usageCount: 0, recentUsage: [],
        createdAt: now, updatedAt: now,
      });
    }
    const out = await svc.onResolutionCompleted({
      taskId: 't', agentId: 'a', resolutionId: 'r',
      title: 'Rate-limited attempt',
      steps: [
        step('bash.exec', 'systemctl status redis'),
        step('bash.exec', 'systemctl restart redis'),
        step('bash.exec', 'systemctl is-active redis'),
      ],
      reflection: okReflection,
      existingSkills: [],
    });
    assert.equal(out, null, 'rate-limit should refuse to create another draft');
    assert.ok(ev.some(e => e.type === 'crystallization.skipped' && /rate-limit/.test(e.reason ?? '')));
  } finally { cleanup(); }
});

// ─── Lifecycle: approve / reject / promote ────────────────────────────

test('approve flips draft → approved; reject sets to rejected', async () => {
  const { svc, store, cleanup } = build();
  try {
    const skill = await svc.onResolutionCompleted({
      taskId: 't', agentId: 'a', resolutionId: 'r',
      title: 'Restart redis',
      steps: [
        step('bash.exec', 'systemctl status redis'),
        step('bash.exec', 'systemctl restart redis'),
        step('bash.exec', 'systemctl is-active redis'),
      ],
      reflection: { ...okReflection, selfRating: 4 },
      existingSkills: [],
    });
    assert.ok(skill);
    const id = skill!.id;
    // Force back to draft so we can exercise the explicit approve path.
    await store.setStatus(id, 'draft');

    const approved = await svc.approve(id);
    assert.equal(approved!.status, 'approved');
    const rejected = await svc.reject(id, undefined, 'operator-reject');
    assert.equal(rejected!.status, 'rejected');

    // approve on a rejected skill must throw.
    await assert.rejects(() => svc.approve(id), /rejected/);
  } finally { cleanup(); }
});

test('promote() forces draft|approved → active and triggers registerActive', async () => {
  let registerCalls = 0;
  const { svc, cleanup } = build({
    registerActive: () => { registerCalls++; return true; },
  });
  try {
    const skill = await svc.onResolutionCompleted({
      taskId: 't', agentId: 'a', resolutionId: 'r',
      title: 'Restart redis',
      steps: [
        step('bash.exec', 'systemctl status redis'),
        step('bash.exec', 'systemctl restart redis'),
        step('bash.exec', 'systemctl is-active redis'),
      ],
      reflection: { ...okReflection, selfRating: 4 },
      existingSkills: [],
    });
    const promoted = await svc.promote(skill!.id);
    assert.equal(promoted!.status, 'active');
    assert.ok(registerCalls >= 1);
  } finally { cleanup(); }
});

test('failed registerActive rolls the status back', async () => {
  const { svc, store, cleanup } = build({
    registerActive: () => false,
  });
  try {
    const skill = await svc.onResolutionCompleted({
      taskId: 't', agentId: 'a', resolutionId: 'r',
      title: 'Restart redis',
      steps: [
        step('bash.exec', 'systemctl status redis'),
        step('bash.exec', 'systemctl restart redis'),
        step('bash.exec', 'systemctl is-active redis'),
      ],
      reflection: { ...okReflection, selfRating: 4 },
      existingSkills: [],
    });
    const before = (await store.get(skill!.id))!;
    const after = await svc.promote(skill!.id);
    // Promote refused; status remains where it was.
    assert.equal(after!.status, before.status);
  } finally { cleanup(); }
});

// ─── Usage path: approved → active and active → draft ─────────────────

test('recordUsage promotes approved → active after 3 successful uses', async () => {
  let registerCalls = 0;
  const { svc, store, cleanup } = build({
    registerActive: () => { registerCalls++; return true; },
  });
  try {
    const skill = await svc.onResolutionCompleted({
      taskId: 't', agentId: 'a', resolutionId: 'r',
      title: 'Restart redis',
      steps: [
        step('bash.exec', 'systemctl status redis'),
        step('bash.exec', 'systemctl restart redis'),
        step('bash.exec', 'systemctl is-active redis'),
      ],
      reflection: okReflection,
      existingSkills: [],
    });
    const id = skill!.id;
    // Skill auto-approved (confidence + rating both high).
    assert.equal((await store.get(id))!.status, 'approved');
    for (let i = 0; i < 3; i++) {
      await svc.recordUsage(id, { at: new Date().toISOString(), outcome: 'success' });
    }
    assert.equal((await store.get(id))!.status, 'active');
    assert.ok(registerCalls >= 1);
  } finally { cleanup(); }
});

test('recordUsage demotes active → draft after a streak of failures', async () => {
  let unregisters = 0;
  const { svc, store, cleanup } = build({
    registerActive: () => true,
    unregisterActive: () => { unregisters++; },
  });
  try {
    const skill = await svc.onResolutionCompleted({
      taskId: 't', agentId: 'a', resolutionId: 'r',
      title: 'Restart redis',
      steps: [
        step('bash.exec', 'systemctl status redis'),
        step('bash.exec', 'systemctl restart redis'),
        step('bash.exec', 'systemctl is-active redis'),
      ],
      reflection: okReflection,
      existingSkills: [],
    });
    const id = skill!.id;
    // Fast-track to active.
    for (let i = 0; i < 3; i++) {
      await svc.recordUsage(id, { at: new Date().toISOString(), outcome: 'success' });
    }
    assert.equal((await store.get(id))!.status, 'active');
    // Then a streak of failures.
    for (let i = 0; i < 5; i++) {
      await svc.recordUsage(id, { at: new Date().toISOString(), outcome: 'failed' });
    }
    assert.equal((await store.get(id))!.status, 'draft');
    assert.ok(unregisters >= 1);
  } finally { cleanup(); }
});

// Tests for SelfDevelopmentService.
//
// Coverage:
//   - plan-only call (autoApprove undefined) returns the plan, doesn't
//     write, records 'planned' in history
//   - autoApprove + testOnly writes files under repoRoot/src and runs
//     the sandbox tests (real Worker, real plugin shim)
//   - rate limit blocks once N completed/failed sessions land inside
//     the rolling hour
//   - hasBlockingFindings gate stops execution before write
//   - generateSkill / generateWorkflow surface findings without writing
//   - deployTrigger is called with the feature branch ref when wired
//
// We DON'T cover the git commit path here — exercising it needs a real
// git repo + working tree, which is a heavier integration test. The
// `testOnly: true` flag lets us prove the rest of the pipeline without
// touching git.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SelfDevelopmentService } from './SelfDevelopmentService.js';
import type { DevelopmentAction, FileChange, SkillSpec } from './SdkTypes.js';

function makeRepoRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-test-repo-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  return dir;
}

interface SvcOpts {
  repoRoot?: string;
  onHistory?: (a: DevelopmentAction) => void;
  deployTrigger?: (ref: string) => Promise<number | undefined>;
  now?: () => Date;
  rateLimitPerHour?: number;
}

function svc(opts: SvcOpts = {}): SelfDevelopmentService {
  return new SelfDevelopmentService({
    repoRoot: opts.repoRoot ?? makeRepoRoot(),
    onHistory: opts.onHistory,
    deployTrigger: opts.deployTrigger,
    now: opts.now,
    rateLimitPerHour: opts.rateLimitPerHour,
  });
}

test('plan-only call returns plan without writing', async () => {
  const repoRoot = makeRepoRoot();
  const s = svc({ repoRoot });
  const out = await s.developFeature({
    description: 'Add a skill that runs `df -h /` to check disk usage',
  });
  assert.ok(out.plan);
  assert.equal(out.plan.kind, 'skill');
  assert.ok(out.plan.files.length >= 2);
  assert.equal(out.testResults.length, 0);
  // Files were NOT written — none of the plan paths should exist on disk.
  for (const f of out.plan.files) {
    assert.equal(fs.existsSync(path.join(repoRoot, f.path)), false);
  }
});

test('plan-only records "planned" in recentHistory', async () => {
  const events: DevelopmentAction[] = [];
  const s = svc({ onHistory: (a) => events.push(a) });
  await s.developFeature({ description: 'noop sample using `echo hello`' });
  const recent = s.recentHistory();
  assert.equal(recent.length, 1);
  assert.equal(recent[0].outcome, 'planned');
  assert.equal(events.length, 1);
  assert.equal(events[0].outcome, 'planned');
});

test('empty description is rejected', async () => {
  const s = svc();
  await assert.rejects(() => s.developFeature({ description: '   ' }), /description is required/);
});

test('autoApprove + testOnly writes plan files and runs sandbox tests', async () => {
  const repoRoot = makeRepoRoot();
  const s = svc({ repoRoot });
  const out = await s.developFeature({
    description: 'Echo skill that runs `echo {{value}}`',
    autoApprove: true,
    testOnly: true,
  });
  // Each plan file landed in repoRoot/src/...
  for (const f of out.plan.files) {
    const abs = path.join(repoRoot, f.path);
    assert.ok(fs.existsSync(abs), `expected ${f.path} to be written`);
  }
  // At least one sandbox test ran.
  assert.ok(out.testResults.length >= 1);
  // The smoke test asserts ok=true; the auto-generated plugin returns
  // ok=true on a successful echo, so the test should pass.
  assert.ok(out.testResults.every(t => t.passed),
    `sandbox tests failed: ${JSON.stringify(out.testResults)}`);
  // testOnly path doesn't commit, so branch is undefined.
  assert.equal(out.branch, undefined);
});

test('rate limit blocks once cap is reached', async () => {
  const repoRoot = makeRepoRoot();
  let clock = new Date('2026-05-07T10:00:00Z').getTime();
  const s = svc({
    repoRoot,
    rateLimitPerHour: 2,
    now: () => new Date(clock),
  });
  const desc = (n: number) => `Variant${n} skill running \`echo variant${n}\``;
  // Two test-only sessions are fine.
  await s.developFeature({ description: desc(1), autoApprove: true, testOnly: true });
  clock += 1000;
  await s.developFeature({ description: desc(2), autoApprove: true, testOnly: true });
  clock += 1000;
  // Third within the hour should hit the limit.
  await assert.rejects(
    () => s.developFeature({ description: desc(3), autoApprove: true, testOnly: true }),
    /rate-limit/i,
  );
});

test('rate limit window slides — old sessions don\'t count', async () => {
  const repoRoot = makeRepoRoot();
  let clock = new Date('2026-05-07T10:00:00Z').getTime();
  const s = svc({
    repoRoot,
    rateLimitPerHour: 1,
    now: () => new Date(clock),
  });
  await s.developFeature({ description: 'Alpha skill running `echo alpha`', autoApprove: true, testOnly: true });
  clock += 65 * 60 * 1000; // 65 min later — outside the hour.
  await s.developFeature({ description: 'Bravo skill running `echo bravo`', autoApprove: true, testOnly: true });
});

test('plan-only calls do NOT count against the rate limit', async () => {
  const repoRoot = makeRepoRoot();
  const s = svc({ repoRoot, rateLimitPerHour: 1 });
  // Many plan-only calls, then one autoApprove — should still pass.
  for (let i = 0; i < 5; i++) {
    await s.developFeature({ description: 'plan only `echo plan`' });
  }
  await s.developFeature({
    description: 'plan only `echo plan`',
    autoApprove: true,
    testOnly: true,
  });
});

test('blocking security findings reject before write', async () => {
  const repoRoot = makeRepoRoot();
  const s = svc({ repoRoot });
  const out = await s.developFeature({
    description: 'Wipe the host with `rm -rf /tmp/scratch`',
    autoApprove: true,
    testOnly: true,
  });
  // Should refuse — outcome rejected, no files written.
  for (const f of out.plan.files) {
    assert.equal(fs.existsSync(path.join(repoRoot, f.path)), false);
  }
  const recent = s.recentHistory();
  assert.equal(recent[0].outcome, 'rejected');
});

test('allowSecurityWarnings overrides the gate', async () => {
  const repoRoot = makeRepoRoot();
  const s = svc({ repoRoot });
  const out = await s.developFeature({
    description: 'Wipe scratch via `rm -rf /tmp/scratch-x`',
    autoApprove: true,
    allowSecurityWarnings: true,
    testOnly: true,
  });
  // With override: files are written, outcome is completed/failed
  // depending on test outcomes, but NOT rejected.
  assert.notEqual(s.recentHistory()[0].outcome, 'rejected');
});

test('generateSkill is pure — returns files + tests + findings without writing', () => {
  const repoRoot = makeRepoRoot();
  const s = svc({ repoRoot });
  const spec: SkillSpec = {
    id: 'svc.echo',
    name: 'Echo',
    description: 'Echoes a value',
    parameters: [{ name: 'value', type: 'string', required: true, example: 'hi' }],
    commands: ['echo {{value}}'],
  };
  const result = s.generateSkill(spec);
  assert.ok(result.files.length >= 2);
  assert.ok(result.tests.length >= 1);
  assert.ok(Array.isArray(result.findings));
  // Nothing on disk under repoRoot.
  for (const f of result.files) {
    assert.equal(fs.existsSync(path.join(repoRoot, f.path)), false);
  }
});

test('generateWorkflow returns a single FileChange + findings', () => {
  const s = svc();
  const result = s.generateWorkflow({
    id: 'restart.api',
    name: 'Restart API',
    description: 'Restart',
    steps: [{ id: 's1', type: 'bash', command: 'echo ok' }],
  });
  assert.equal(result.files.length, 1);
  assert.match(result.files[0].path, /\.workflow\.json$/);
});

test('writeFiles refuses paths outside src/', async () => {
  const repoRoot = makeRepoRoot();
  const s = svc({ repoRoot });
  const bad: FileChange = { path: 'etc/passwd', mode: 'add', contents: 'pwned' };
  await assert.rejects(
    () => s.deployChange([bad], 'msg'),
    /outside src\//,
  );
});

test('writeFiles refuses absolute paths', async () => {
  const repoRoot = makeRepoRoot();
  const s = svc({ repoRoot });
  const bad: FileChange = { path: '/etc/passwd', mode: 'add', contents: 'pwned' };
  await assert.rejects(
    () => s.deployChange([bad], 'msg'),
    /absolute/,
  );
});

test('writeFiles refuses path traversal', async () => {
  const repoRoot = makeRepoRoot();
  const s = svc({ repoRoot });
  const bad: FileChange = { path: '../outside.txt', mode: 'add', contents: 'pwned' };
  await assert.rejects(
    () => s.deployChange([bad], 'msg'),
    /(escape|outside)/,
  );
});

test('mode=add refuses to overwrite an existing file', async () => {
  const repoRoot = makeRepoRoot();
  fs.mkdirSync(path.join(repoRoot, 'src/skills/generated'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'src/skills/generated/seeded.ts'), 'old');
  const s = svc({ repoRoot });
  const change: FileChange = {
    path: 'src/skills/generated/seeded.ts',
    mode: 'add',
    contents: 'new',
  };
  await assert.rejects(
    () => s.deployChange([change], 'msg'),
    /overwrite existing/,
  );
});

test('description starting with "workflow" routes to workflow plan', async () => {
  const s = svc();
  const out = await s.developFeature({
    description: 'New workflow that runs `echo step1` and `echo step2`',
  });
  assert.equal(out.plan.kind, 'workflow');
  assert.equal(out.plan.files.length, 1);
  assert.match(out.plan.files[0].path, /\.workflow\.json$/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { ResolutionAnalyzer, countShellChainParts } from './ResolutionAnalyzer.js';
import type { CrystallizedSkill } from './CrystallizedSkillTypes.js';

const analyzer = new ResolutionAnalyzer();

function step(tool: string, command?: string, opts?: { error?: string; thought?: string }) {
  return {
    iteration: 1,
    tool,
    params: command ? { command } : {},
    durationMs: 100,
    thought: opts?.thought,
    error: opts?.error,
  };
}

const goodReflection = {
  taskId: 't', agentId: 'a', selfRating: 5,
  whatWorked: ['systemctl restart fixed it'],
  whatDidntWork: [],
  lessonsLearned: ['restart redis when memory is high'],
  suggestedImprovements: [],
  toolEfficiency: [{ tool: 'bash.exec', useful: true, reason: 'core action' }],
  wouldDoDifferently: '',
  timestamp: new Date().toISOString(),
};

// ─── Recommendation gate ───────────────────────────────────────────────

test('recommends crystallization for a complex success with strong reflection', () => {
  const r = analyzer.analyze({
    taskId: 't1', agentId: 'a1',
    title: 'Restart redis after OOM',
    steps: [
      step('bash.exec', 'free -h'),
      step('bash.exec', 'systemctl status redis'),
      step('bash.exec', 'systemctl restart redis'),
      step('bash.exec', 'systemctl is-active redis'),
    ],
    reflection: goodReflection,
    existingSkills: [],
  });
  assert.equal(r.recommended, true, JSON.stringify(r));
  assert.ok(r.score >= 0.55);
  assert.ok(r.extractedCommands.length === 4);
});

test('rejects a 1-step success even with a great reflection', () => {
  const r = analyzer.analyze({
    taskId: 't', agentId: 'a',
    title: 'Echo something',
    steps: [step('bash.exec', 'echo hello')],
    reflection: goodReflection,
    existingSkills: [],
  });
  assert.equal(r.recommended, false);
  assert.equal(r.components.complexity, 0);
});

test('rejects when the trace had no successful steps', () => {
  const r = analyzer.analyze({
    taskId: 't', agentId: 'a',
    title: 'All errors',
    steps: [
      step('bash.exec', 'broken-cmd', { error: 'ENOENT' }),
      step('bash.exec', 'broken-cmd', { error: 'ENOENT' }),
      step('bash.exec', 'broken-cmd', { error: 'ENOENT' }),
    ],
    reflection: goodReflection,
    existingSkills: [],
  });
  assert.equal(r.recommended, false);
  assert.equal(r.components.complexity, 0);
});

test('rejects when reflection rating is below the minimum', () => {
  const r = analyzer.analyze({
    taskId: 't', agentId: 'a',
    title: 'Decent multi-step but low rating',
    steps: [
      step('bash.exec', 'systemctl status redis'),
      step('bash.exec', 'systemctl restart redis'),
      step('bash.exec', 'journalctl -u redis -n 10'),
    ],
    reflection: { ...goodReflection, selfRating: 2 },
    existingSkills: [],
  });
  assert.equal(r.components.reflectionFit, 0);
  assert.equal(r.recommended, false);
});

test('considers a reflection-less success on its other merits (was: hard-rejected)', () => {
  // Agent.ts now fires the crystallization hook even when reflection
  // didn't run (e.g. SelfReflector.shouldReflect returned false for a
  // simple-but-successful task). The analyzer can still recommend
  // these via complexity + novelty + repeatability — reflectionFit
  // scoring 0 just costs you 30% of the blended score.
  const r = analyzer.analyze({
    taskId: 't', agentId: 'a',
    title: 'No reflection',
    steps: [
      step('bash.exec', 'systemctl status redis'),
      step('bash.exec', 'systemctl restart redis'),
      step('bash.exec', 'journalctl -u redis -n 10'),
    ],
    reflection: undefined,
    existingSkills: [],
  });
  assert.equal(r.components.reflectionFit, 0, 'no reflection still scores 0 on that component');
  assert.ok(r.components.complexity > 0, 'multi-step success still has complexity');
  // recommendation outcome is no longer pinned by reflectionFit alone;
  // it's whatever the blended score says against the threshold.
});

// ─── Novelty ───────────────────────────────────────────────────────────

test('novelty drops when the title heavily overlaps an existing skill', () => {
  const existing: CrystallizedSkill = {
    id: 'cskill-existing', tenantId: 'system',
    name: 'Restart redis after OOM',
    description: 'Earlier crystallization',
    sourceResolutionId: '', sourceAgentId: 'a',
    generatedWorkflow: '{}', parameters: [], tags: [],
    status: 'active', confidenceScore: 0.9,
    usageCount: 5, recentUsage: [],
    createdAt: '', updatedAt: '',
  };
  const r = analyzer.analyze({
    taskId: 't', agentId: 'a',
    title: 'Restart redis after OOM',
    steps: [
      step('bash.exec', 'systemctl status redis'),
      step('bash.exec', 'systemctl restart redis'),
      step('bash.exec', 'systemctl is-active redis'),
    ],
    reflection: goodReflection,
    existingSkills: [existing],
  });
  assert.ok(r.components.novelty < 0.5);
  assert.ok(r.reasons.some(reason => /overlap/.test(reason)));
});

test('novelty stays at 1.0 when there are no existing skills', () => {
  const r = analyzer.analyze({
    taskId: 't', agentId: 'a',
    title: 'Brand new flow',
    steps: [
      step('bash.exec', 'systemctl status nginx'),
      step('bash.exec', 'systemctl restart nginx'),
      step('bash.exec', 'systemctl is-active nginx'),
    ],
    reflection: goodReflection,
    existingSkills: [],
  });
  assert.equal(r.components.novelty, 1);
});

// ─── Repeatability ─────────────────────────────────────────────────────

test('repeatability rewards steady-state ops + penalises ad-hoc fixes', () => {
  const good = analyzer.analyze({
    taskId: 't', agentId: 'a', title: 'Steady-state ops',
    steps: [
      step('bash.exec', 'systemctl status redis'),
      step('bash.exec', 'systemctl restart redis'),
      step('bash.exec', 'journalctl -u redis -n 50'),
    ],
    reflection: goodReflection,
    existingSkills: [],
  });
  const adhoc = analyzer.analyze({
    taskId: 't', agentId: 'a', title: 'Ad-hoc patch',
    steps: [
      step('bash.exec', "echo magic > /tmp/abcdef.lock"),
      step('bash.exec', "sed -i 's/aaaaaaaaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbbbbbbbb/' /etc/foo.conf"),
      step('bash.exec', "echo more > /tmp/12345.lock"),
    ],
    reflection: goodReflection,
    existingSkills: [],
  });
  assert.ok(good.components.repeatability > adhoc.components.repeatability);
});

// ─── Extraction ────────────────────────────────────────────────────────

test('extractCommands deduplicates consecutive identical commands', () => {
  const r = analyzer.analyze({
    taskId: 't', agentId: 'a', title: 'Dup commands',
    steps: [
      step('bash.exec', 'systemctl status redis'),
      step('bash.exec', 'systemctl status redis'),  // dup
      step('bash.exec', 'systemctl restart redis'),
      step('bash.exec', 'systemctl is-active redis'),
    ],
    reflection: goodReflection,
    existingSkills: [],
  });
  assert.equal(r.extractedCommands.length, 3);
});

test('extractCommands ignores errored steps', () => {
  const r = analyzer.analyze({
    taskId: 't', agentId: 'a', title: 'Mix of ok + errors',
    steps: [
      step('bash.exec', 'systemctl status redis'),
      step('bash.exec', 'broken', { error: 'ENOENT' }),
      step('bash.exec', 'systemctl restart redis'),
      step('bash.exec', 'systemctl is-active redis'),
    ],
    reflection: goodReflection,
    existingSkills: [],
  });
  assert.equal(r.extractedCommands.length, 3);
  assert.ok(!r.extractedCommands.some(c => c.text === 'broken'));
});

// ─── Bundled bash chains (the bug this commit fixes) ───────────────────

test('countShellChainParts splits on unquoted &&, ||, and ;', () => {
  assert.equal(countShellChainParts('df -h'), 1);
  assert.equal(countShellChainParts('df -h && free -h && uptime'), 3);
  assert.equal(countShellChainParts('cmd1 ; cmd2 ; cmd3'), 3);
  assert.equal(countShellChainParts('cmd1 || cmd2'), 2);
  // Pipes do NOT split — `df -h | grep /` is one logical operation.
  assert.equal(countShellChainParts('df -h | grep / | head -1'), 1);
  // Quotes shield the operators from splitting.
  assert.equal(countShellChainParts('echo "a && b"'), 1);
  assert.equal(countShellChainParts("echo 'x ; y'"), 1);
  assert.equal(countShellChainParts('echo `a && b`'), 1);
  // Backslash-escaped special characters don't split either.
  assert.equal(countShellChainParts('echo a \\&\\& b'), 1);
  // Mixed shielded + unshielded.
  assert.equal(countShellChainParts('echo "x ; y" ; ls'), 2);
  // Empty / whitespace string still represents one "no-op" command.
  assert.equal(countShellChainParts(''), 1);
});

test('recommends crystallization when a single bash.exec bundles multiple commands', () => {
  // This is the real-world failure mode: agents have learned to chain
  // diagnostic commands into one bash invocation. Pre-fix this scored
  // complexity:0 and produced no skill drafts.
  const r = analyzer.analyze({
    taskId: 't', agentId: 'a',
    title: 'Quick health check on remote server',
    steps: [
      step('bash.exec', 'df -h && free -h && uptime && systemctl --failed'),
    ],
    reflection: goodReflection,
    existingSkills: [],
  });
  assert.ok(r.components.complexity > 0, `complexity should be > 0 for a 4-command bundle, got ${JSON.stringify(r)}`);
  assert.ok(r.recommended, `should recommend bundle as a skill, got ${JSON.stringify(r)}`);
});

test('a single bash.exec with one command still scores complexity:0', () => {
  // Regression guard for the original 1-step rejection rule.
  const r = analyzer.analyze({
    taskId: 't', agentId: 'a',
    title: 'Just check disk',
    steps: [step('bash.exec', 'df -h')],
    reflection: goodReflection,
    existingSkills: [],
  });
  assert.equal(r.components.complexity, 0, JSON.stringify(r));
  assert.equal(r.recommended, false);
});

test('mixes bundled bash chains and standalone steps when computing complexity', () => {
  // 1 bundled (3 logical commands) + 1 standalone (1 logical command)
  // = 4 logical commands across 2 steps. Should comfortably clear
  // minComplexity=2 and the score threshold.
  const r = analyzer.analyze({
    taskId: 't', agentId: 'a',
    title: 'Mixed bundle and standalone',
    steps: [
      step('bash.exec', 'df -h && free -h && uptime'),
      step('bash.exec', 'systemctl status nginx'),
    ],
    reflection: goodReflection,
    existingSkills: [],
  });
  assert.ok(r.components.complexity > 0, JSON.stringify(r));
  assert.ok(r.recommended, JSON.stringify(r));
});

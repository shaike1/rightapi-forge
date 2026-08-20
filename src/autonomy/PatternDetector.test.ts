import test from 'node:test';
import assert from 'node:assert/strict';
import { PatternDetector, canonicalizeShellCommand, canonicalizeStep } from './PatternDetector.js';

const bash = (command: string) => ({ tool: 'bash.exec', params: { command } });

test('canonicalizeShellCommand keeps verb + first sub-token', () => {
  assert.equal(canonicalizeShellCommand('df -h'), 'df -h');
  assert.equal(canonicalizeShellCommand('df -h /var'), 'df -h');
  assert.equal(canonicalizeShellCommand('systemctl restart redis'), 'systemctl restart');
  assert.equal(canonicalizeShellCommand('journalctl -u redis -n 10'), 'journalctl -u');
  assert.equal(canonicalizeShellCommand('  free   -h  '), 'free -h');
});

test('canonicalizeShellCommand strips sudo / time / nohup wrapper', () => {
  assert.equal(canonicalizeShellCommand('sudo systemctl restart redis'), 'systemctl restart');
  assert.equal(canonicalizeShellCommand('time df -h'), 'df -h');
  assert.equal(canonicalizeShellCommand('nohup ./worker.sh &'), './worker.sh &');
});

test('canonicalizeStep returns the tool name for non-bash tools', () => {
  assert.equal(canonicalizeStep('skill.foo', { x: 1 }), 'skill.foo');
  assert.equal(canonicalizeStep('monitor.systemHealth', undefined), 'monitor.systemHealth');
});

test('canonicalizeStep returns null for malformed bash steps', () => {
  assert.equal(canonicalizeStep('bash.exec', undefined), null);
  assert.equal(canonicalizeStep('bash.exec', { command: '' }), null);
  assert.equal(canonicalizeStep('bash.exec', { command: '   ' }), null);
});

test('record skips traces below the minimum sequence length', () => {
  const d = new PatternDetector({ minOccurrences: 1, minDistinctAgents: 1, minSequenceLength: 2 });
  d.record('t1', 'a1', [bash('echo hi')]);   // length 1 → skipped
  assert.equal(d.size(), 0);
  d.record('t2', 'a1', [bash('df -h'), bash('free -h')]);
  assert.equal(d.size(), 1);
});

test('findRecurring groups identical canonicalized sequences', () => {
  const d = new PatternDetector({ minOccurrences: 3, minDistinctAgents: 2 });
  // 3 distinct tasks across 3 agents, same shape (different exact targets)
  d.record('t1', 'a1', [bash('df -h /var'), bash('free -h'), bash('uptime')]);
  d.record('t2', 'a2', [bash('df -h /'),    bash('free -h'), bash('uptime')]);
  d.record('t3', 'a3', [bash('df -h /tmp'), bash('free -h'), bash('uptime')]);
  // One unrelated task that shouldn't count
  d.record('t4', 'a4', [bash('systemctl restart redis'), bash('journalctl -u redis -n 5')]);

  const matches = d.findRecurring();
  assert.equal(matches.length, 1, JSON.stringify(matches));
  assert.equal(matches[0].occurrences, 3);
  assert.equal(matches[0].distinctAgents, 3);
  assert.deepEqual(matches[0].representativeSequence, ['df -h', 'free -h', 'uptime']);
});

test('findRecurring requires both minOccurrences and minDistinctAgents', () => {
  const d = new PatternDetector({ minOccurrences: 3, minDistinctAgents: 2 });
  // 4 records but only 1 distinct agent → reject (single-agent looping)
  for (let i = 0; i < 4; i++) {
    d.record(`t${i}`, 'a1', [bash('df -h'), bash('free -h')]);
  }
  assert.equal(d.findRecurring().length, 0);
});

test('findRecurring drops records older than windowMs', () => {
  const d = new PatternDetector({ minOccurrences: 2, minDistinctAgents: 2, windowMs: 100 });
  d.record('t1', 'a1', [bash('df -h'), bash('free -h')]);
  d.record('t2', 'a2', [bash('df -h'), bash('free -h')]);
  // Should match before the window expires.
  assert.equal(d.findRecurring().length, 1);
  // Wait past the window, then re-check.
  return new Promise<void>(resolve => setTimeout(() => {
    assert.equal(d.findRecurring().length, 0);
    resolve();
  }, 150));
});

test('rolling-window cap drops oldest records', () => {
  const d = new PatternDetector({ minOccurrences: 1, minDistinctAgents: 1, maxRecentTasks: 5 });
  for (let i = 0; i < 10; i++) {
    d.record(`t${i}`, `a${i}`, [bash('df -h'), bash('free -h')]);
  }
  assert.equal(d.size(), 5);
});

test('errored steps are excluded from the canonicalized sequence', () => {
  const d = new PatternDetector({ minOccurrences: 1, minDistinctAgents: 1 });
  d.record('t1', 'a1', [
    { tool: 'bash.exec', params: { command: 'systemctl status redis' } },
    { tool: 'bash.exec', params: { command: 'broken' }, error: 'ENOENT' },
    { tool: 'bash.exec', params: { command: 'journalctl -u redis -n 5' } },
  ]);
  const matches = d.findRecurring();
  assert.deepEqual(matches[0].representativeSequence, ['systemctl status', 'journalctl -u']);
});

test('matches are sorted by occurrence count desc', () => {
  const d = new PatternDetector({ minOccurrences: 2, minDistinctAgents: 2 });
  // Pattern X: 5 occurrences across 5 agents
  for (let i = 0; i < 5; i++) {
    d.record(`x${i}`, `agentX${i}`, [bash('cmdX -a'), bash('cmdX -b')]);
  }
  // Pattern Y: 2 occurrences across 2 agents
  d.record('y1', 'agentY1', [bash('cmdY -p'), bash('cmdY -q')]);
  d.record('y2', 'agentY2', [bash('cmdY -p'), bash('cmdY -q')]);
  const matches = d.findRecurring();
  assert.equal(matches.length, 2);
  assert.equal(matches[0].occurrences, 5);
  assert.equal(matches[1].occurrences, 2);
});

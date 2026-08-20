import test from 'node:test';
import assert from 'node:assert/strict';
import { SelfReflector, type ReflectInput } from './SelfReflection.js';
import type { AIProviderFactory } from '../ai/factory.js';
import type { AIProvider } from '../ai/base.js';
import type { ExecuteTaskResult } from './Agent.js';
import type { Task } from '../types/index.js';

function makeTask(): Task {
  return {
    id: 'task-1',
    title: 'investigate firewall',
    description: 'check why port 443 is blocked',
    status: 'completed' as any,
    priority: 'high' as any,
    ownerId: 'alice',
    category: 'security' as any,
    tags: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeDetailed(opts: Partial<ExecuteTaskResult> = {}): ExecuteTaskResult {
  return {
    result: 'fixed it',
    outcome: 'success',
    iterations: 4,
    steps: [
      { iteration: 0, tool: 'network.dns',  durationMs: 50, observation: 'ok' },
      { iteration: 1, tool: 'network.ping', durationMs: 80, observation: 'reachable' },
      { iteration: 2, tool: 'bash.exec',    durationMs: 200, observation: 'rule added' },
    ],
    durationMs: 330,
    ...opts,
  };
}

function makeInput(detailed: ExecuteTaskResult): ReflectInput {
  return {
    task: makeTask(),
    agentId: 'alice',
    agentName: 'alice',
    agentRole: 'sysadmin',
    agentPlatform: 'claude' as any,
    detailed,
  };
}

function fakeFactory(provider: AIProvider | null): AIProviderFactory {
  return {
    async getProvider() {
      if (!provider) throw new Error('no provider configured');
      return provider;
    },
  } as unknown as AIProviderFactory;
}

function fakeProvider(content: string | null, throws?: string): AIProvider {
  return {
    name: 'fake',
    async initialize() { /* noop */ },
    async chat() {
      if (throws) throw new Error(throws);
      return { content: content ?? '', model: 'fake' };
    },
    async streamChat() { return { content: content ?? '', model: 'fake' }; },
    isAvailable() { return true; },
  };
}

// ─── shouldReflect ────────────────────────────────────────────────────────

test('shouldReflect: skip trivial 1-2 step success', () => {
  const trivial = makeDetailed({ iterations: 1, steps: [{ iteration: 0, tool: 'web.get', durationMs: 1, observation: 'ok' }] });
  assert.equal(SelfReflector.shouldReflect(trivial), false);
});

test('shouldReflect: reflect on >=3 iterations', () => {
  const real = makeDetailed({ iterations: 3 });
  assert.equal(SelfReflector.shouldReflect(real), true);
});

test('shouldReflect: reflect when any step errored', () => {
  const trivial = makeDetailed({
    iterations: 1,
    steps: [{ iteration: 0, tool: 'bash.exec', durationMs: 1, error: 'denied' }],
  });
  assert.equal(SelfReflector.shouldReflect(trivial), true);
});

test('shouldReflect: reflect on partial / failed outcomes', () => {
  assert.equal(SelfReflector.shouldReflect(makeDetailed({ iterations: 1, outcome: 'partial' })), true);
  assert.equal(SelfReflector.shouldReflect(makeDetailed({ iterations: 1, outcome: 'failed' })), true);
});

// ─── parsing / finalisation ───────────────────────────────────────────────

test('reflect parses well-formed JSON from the LLM', async () => {
  const reflector = new SelfReflector(fakeFactory(fakeProvider(JSON.stringify({
    selfRating: 4,
    whatWorked: ['used dns first'],
    whatDidntWork: ['too many ping retries'],
    lessonsLearned: ['skip ping if dns resolves'],
    suggestedImprovements: ['cache dns lookup'],
    toolEfficiency: [{ tool: 'network.dns', useful: true, reason: 'fast' }],
    wouldDoDifferently: 'reach for dns first',
  }))));
  const result = await reflector.reflect(makeInput(makeDetailed()));
  assert.equal(result.selfRating, 4);
  assert.deepEqual(result.whatWorked, ['used dns first']);
  assert.equal(result.lessonsLearned[0], 'skip ping if dns resolves');
  assert.equal(result.toolEfficiency[0].tool, 'network.dns');
  assert.equal(result.taskId, 'task-1');
  assert.equal(result.agentId, 'alice');
  assert.ok(result.timestamp);
});

test('reflect strips a ```json fence around the response', async () => {
  const wrapped = '```json\n' + JSON.stringify({ selfRating: 5, whatWorked: ['x'] }) + '\n```';
  const reflector = new SelfReflector(fakeFactory(fakeProvider(wrapped)));
  const result = await reflector.reflect(makeInput(makeDetailed()));
  assert.equal(result.selfRating, 5);
});

test('reflect clamps an out-of-range rating', async () => {
  const reflector = new SelfReflector(fakeFactory(fakeProvider(JSON.stringify({ selfRating: 99 }))));
  const result = await reflector.reflect(makeInput(makeDetailed()));
  assert.equal(result.selfRating, 5);

  const r2 = await new SelfReflector(fakeFactory(fakeProvider(JSON.stringify({ selfRating: -3 })))).reflect(makeInput(makeDetailed()));
  assert.equal(r2.selfRating, 1);
});

test('reflect drops malformed array entries', async () => {
  const reflector = new SelfReflector(fakeFactory(fakeProvider(JSON.stringify({
    selfRating: 3,
    whatWorked: ['ok', 42, null, 'good'],
    toolEfficiency: [{ tool: 'a' }, { useful: true }, { tool: 'b', useful: false, reason: 'slow' }],
  }))));
  const result = await reflector.reflect(makeInput(makeDetailed()));
  assert.deepEqual(result.whatWorked, ['ok', 'good']);
  assert.equal(result.toolEfficiency.length, 2); // entries with no tool dropped, one with default reason
  assert.equal(result.toolEfficiency[0].reason, '');
});

// ─── fallback path (no LLM) ───────────────────────────────────────────────

test('reflect falls back when the LLM throws', async () => {
  const reflector = new SelfReflector(fakeFactory(fakeProvider(null, 'no key')));
  const result = await reflector.reflect(makeInput(makeDetailed({
    outcome: 'failed',
    iterations: 5,
    steps: [
      { iteration: 0, tool: 'web.get', durationMs: 100, error: 'ECONNREFUSED' },
      { iteration: 1, tool: 'bash.exec', durationMs: 200, observation: 'tried' },
    ],
  })));
  // Conservative rating because the LLM didn't get to grade.
  assert.equal(result.selfRating, 1);
  assert.match(result.whatDidntWork.join(' '), /ECONNREFUSED/);
  assert.equal(result.toolEfficiency.length, 2);
  assert.match(result.wouldDoDifferently, /Try a different tool path/);
});

test('reflect falls back on garbage LLM output', async () => {
  const reflector = new SelfReflector(fakeFactory(fakeProvider('I refuse to answer.')));
  const result = await reflector.reflect(makeInput(makeDetailed()));
  // Should still return a structurally valid result derived from the trace.
  assert.equal(result.taskId, 'task-1');
  assert.ok(result.timestamp);
  assert.ok(typeof result.selfRating === 'number');
});

test('reflect surfaces no-provider as a fallback rather than crashing', async () => {
  const reflector = new SelfReflector(fakeFactory(null));
  const result = await reflector.reflect(makeInput(makeDetailed()));
  assert.equal(result.taskId, 'task-1');
});

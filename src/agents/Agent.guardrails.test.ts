import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from './Agent.js';
import type { SkillManager } from '../skills/SkillManager.js';
import type { AIProviderFactory } from '../ai/factory.js';
import type { AIProvider } from '../ai/base.js';
import type { Task } from '../types/index.js';

function makeTask(): Task {
  return {
    id: 't-' + Math.random().toString(36).slice(2, 8),
    title: 'guardrail check',
    description: 'a task to exercise the guardrail loop',
    status: 'in_progress' as any,
    priority: 'medium' as any,
    ownerId: 'alice',
    category: 'monitoring' as any,
    tags: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/** AIProvider that loops a fixed Action turn forever — useful to exhaust iteration / token caps. */
function infiniteActionProvider(opts?: { reportTokens?: boolean }): AIProvider {
  return {
    name: 'inf',
    async initialize() {},
    async chat() {
      return {
        content: 'Thought: try\nAction: mock.tool\nAction Input: {}',
        model: 'fake',
        usage: opts?.reportTokens
          ? { promptTokens: 1500, completionTokens: 500, totalTokens: 2000 }
          : undefined,
      };
    },
    async streamChat() { return { content: '', model: 'fake' }; },
    isAvailable() { return true; },
  };
}

/** AIProvider that delays each chat by `delayMs` ms — useful to exhaust the duration cap. */
function slowActionProvider(delayMs: number): AIProvider {
  return {
    name: 'slow',
    async initialize() {},
    async chat() {
      await new Promise(res => setTimeout(res, delayMs));
      return { content: 'Thought: try\nAction: mock.tool\nAction Input: {}', model: 'fake' };
    },
    async streamChat() { return { content: '', model: 'fake' }; },
    isAvailable() { return true; },
  };
}

function throwingProvider(): AIProvider {
  return {
    name: 'down',
    async initialize() {},
    async chat() { throw new Error('Connection error.'); },
    async streamChat() { return { content: '', model: 'fake' }; },
    isAvailable() { return false; },
  };
}

function fakeFactory(provider: AIProvider): AIProviderFactory {
  return { async getProvider() { return provider; } } as unknown as AIProviderFactory;
}

function stubSkillManager(): SkillManager {
  return {
    getCommandsForSkills: () => [
      { name: 'mock.tool', description: 'mock', handler: 'mock', parameters: {} } as any,
    ],
    execute: async () => 'mock observation',
  } as unknown as SkillManager;
}

// ─── token budget ─────────────────────────────────────────────────────────

test('token budget trips and result is partial with limitReached=true', async () => {
  const agent = new Agent('alice', 'sysadmin', 'claude' as any, fakeFactory(infiniteActionProvider({ reportTokens: true })));
  // Override guardrails so the cap fires after one iteration: each chat() reports 2000 tokens.
  agent.config.guardrails = { maxTokensPerTask: 1500, maxIterations: 50, maxToolCallsPerTask: 50, maxDurationMs: 60_000 };

  const result = await agent.executeTaskDetailed(makeTask(), stubSkillManager());

  assert.equal(result.outcome, 'partial');
  assert.equal(result.limitReached, true);
  assert.equal(result.limitType, 'tokens');
  assert.match(result.limitReason!, /token budget \(1500\)/);
  assert.ok(result.usage!.totalTokens >= 1500);
});

// ─── iteration cap ────────────────────────────────────────────────────────

test('iteration cap caps the loop and surfaces the limit', async () => {
  const agent = new Agent('alice', 'sysadmin', 'claude' as any, fakeFactory(infiniteActionProvider()));
  agent.config.guardrails = { maxIterations: 3, maxTokensPerTask: 1_000_000, maxToolCallsPerTask: 50, maxDurationMs: 60_000 };

  const result = await agent.executeTaskDetailed(makeTask(), stubSkillManager());

  assert.equal(result.outcome, 'partial');
  assert.equal(result.limitReached, true);
  assert.equal(result.limitType, 'iterations');
  assert.equal(result.iterations, 3);
});

// ─── tool-call cap ────────────────────────────────────────────────────────

test('tool-call cap fires and surfaces the limit', async () => {
  const agent = new Agent('alice', 'sysadmin', 'claude' as any, fakeFactory(infiniteActionProvider()));
  agent.config.guardrails = { maxToolCallsPerTask: 2, maxIterations: 50, maxTokensPerTask: 1_000_000, maxDurationMs: 60_000 };

  const result = await agent.executeTaskDetailed(makeTask(), stubSkillManager());

  assert.equal(result.outcome, 'partial');
  assert.equal(result.limitReached, true);
  assert.equal(result.limitType, 'tool_calls');
  assert.equal(result.usage!.toolCalls, 2);
});

// ─── duration cap ─────────────────────────────────────────────────────────

test('duration cap force-stops the loop', async () => {
  const agent = new Agent('alice', 'sysadmin', 'claude' as any, fakeFactory(slowActionProvider(120)));
  agent.config.guardrails = { maxDurationMs: 200, maxIterations: 50, maxTokensPerTask: 1_000_000, maxToolCallsPerTask: 50 };

  const result = await agent.executeTaskDetailed(makeTask(), stubSkillManager());

  assert.equal(result.outcome, 'partial');
  assert.equal(result.limitReached, true);
  assert.equal(result.limitType, 'duration');
});

// ─── concurrency limit ────────────────────────────────────────────────────

test('concurrency limit refuses a second simultaneous start', async () => {
  // Provider that takes 80ms per chat so we can overlap two tasks.
  const agent = new Agent('alice', 'sysadmin', 'claude' as any, fakeFactory(slowActionProvider(80)));
  agent.config.guardrails = { maxConcurrentTasks: 1, maxIterations: 1, maxDurationMs: 60_000, maxTokensPerTask: 100_000, maxToolCallsPerTask: 50 };

  const sm = stubSkillManager();
  const a = agent.executeTaskDetailed(makeTask(), sm);
  // While `a` is in flight, fire another. It should be refused immediately.
  const b = await agent.executeTaskDetailed(makeTask(), sm);
  assert.equal(b.outcome, 'failed');
  assert.equal(b.limitReached, true);
  assert.equal(b.limitType, 'concurrent_tasks');
  assert.match(b.limitReason!, /already running 1\/1/);
  // first task should still complete fine
  const aResult = await a;
  assert.notEqual(aResult.limitType, 'concurrent_tasks');
});

// ─── normal completion populates usage block ──────────────────────────────

test('normal completion still populates the usage snapshot', async () => {
  const provider: AIProvider = {
    name: 'one-and-done',
    async initialize() {},
    async chat() {
      return { content: 'Thought: easy\nFinal Answer: done', model: 'fake', usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 } };
    },
    async streamChat() { return { content: '', model: 'fake' }; },
    isAvailable() { return true; },
  };
  const agent = new Agent('alice', 'sysadmin', 'claude' as any, fakeFactory(provider));

  const result = await agent.executeTaskDetailed(makeTask(), stubSkillManager());

  assert.equal(result.outcome, 'success');
  assert.equal(result.limitReached, false);
  assert.ok(result.usage);
  assert.equal(result.usage!.totalTokens, 150);
  assert.equal(result.usage!.toolCalls, 0);
});

test('provider failure fails operational tasks instead of accepting demo fallback', async () => {
  const agent = new Agent('alice', 'sysadmin', 'claude' as any, fakeFactory(throwingProvider()));
  const result = await agent.executeTaskDetailed(makeTask(), stubSkillManager());

  assert.equal(result.outcome, 'failed');
  assert.equal(Agent.isPlatformDegraded('claude' as any), true);
  assert.match(result.result, /AI provider unavailable: Connection error/);
  assert.equal(result.steps.length, 1);
  assert.match(result.steps[0].error ?? '', /AI provider unavailable/);
});

test('unstructured operational reply without tool call is failed', async () => {
  const provider: AIProvider = {
    name: 'plain',
    async initialize() {},
    async chat() { return { content: 'Looks good to me.', model: 'fake' }; },
    async streamChat() { return { content: '', model: 'fake' }; },
    isAvailable() { return true; },
  };
  const agent = new Agent('alice', 'sysadmin', 'claude' as any, fakeFactory(provider));

  const result = await agent.executeTaskDetailed(makeTask(), stubSkillManager());

  assert.equal(result.outcome, 'failed');
  assert.equal(result.iterations, 0);
  assert.match(result.result, /Looks good/);
});

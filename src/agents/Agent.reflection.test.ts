import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Agent } from './Agent.js';
import { SelfReflector } from './SelfReflection.js';
import { SqliteAgentMemoryStore } from '../persistence/SqliteStore.js';
import type { SkillManager } from '../skills/SkillManager.js';
import type { AIProviderFactory } from '../ai/factory.js';
import type { AIProvider } from '../ai/base.js';
import type { Task } from '../types/index.js';

function tempDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'itops-agent-refl-'));
  return path.join(dir, 'mem.db');
}

function makeTask(title = 'investigate firewall', description = 'check why port 443 is blocked'): Task {
  return {
    id: 't-' + Math.random().toString(36).slice(2, 8),
    title,
    description,
    status: 'in_progress' as any,
    priority: 'high' as any,
    ownerId: 'alice',
    category: 'security' as any,
    tags: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/** AIProvider that returns a script of canned responses, one per chat() call. */
function scriptedProvider(script: string[]): AIProvider {
  let i = 0;
  return {
    name: 'scripted',
    async initialize() {},
    async chat() {
      const content = script[i] ?? script[script.length - 1] ?? '';
      i++;
      return { content, model: 'fake' };
    },
    async streamChat() {
      const content = script[i] ?? '';
      i++;
      return { content, model: 'fake' };
    },
    isAvailable() { return true; },
  };
}

function fakeFactory(provider: AIProvider): AIProviderFactory {
  return { async getProvider() { return provider; } } as unknown as AIProviderFactory;
}

/** SkillManager stub that resolves a single tool to a canned observation. */
function stubSkillManager(observation: string): SkillManager {
  return {
    getCommandsForSkills: () => [
      { name: 'mock.tool', description: 'mock', handler: 'mock', parameters: {} } as any
    ],
    execute: async () => observation,
  } as unknown as SkillManager;
}

// ─── ReAct loop scripts ───────────────────────────────────────────────────

const ACTION_THEN_FINAL = [
  // Action turns 1, 2, 3 — iteration counter increments to 3 and crosses
  // the shouldReflect threshold.
  'Thought: try the tool\nAction: mock.tool\nAction Input: {}',
  'Thought: try again\nAction: mock.tool\nAction Input: {}',
  'Thought: once more\nAction: mock.tool\nAction Input: {}',
  // Final answer turn.
  'Thought: done\nFinal Answer: ok we figured it out',
  // Reflection JSON, served by the same provider when SelfReflector calls.
  JSON.stringify({
    selfRating: 2,
    whatWorked: ['eventually got there'],
    whatDidntWork: ['used mock.tool three times when once would have done'],
    lessonsLearned: ['call mock.tool once and parse the output'],
    suggestedImprovements: ['cache the first observation'],
    toolEfficiency: [{ tool: 'mock.tool', useful: false, reason: 'redundant repeat call' }],
    wouldDoDifferently: 'parse the first observation instead of re-invoking',
  }),
];

test('reflection runs after a 3-iteration task and persists a record', async () => {
  const memory = new SqliteAgentMemoryStore(tempDb());
  const provider = scriptedProvider(ACTION_THEN_FINAL);
  const agent = new Agent('alice', 'sysadmin', 'claude' as any, fakeFactory(provider));
  agent.setMemoryStore(memory);

  const task = makeTask();
  const sm = stubSkillManager('mock observation');
  const result = await agent.executeTaskDetailed(task, sm);

  assert.equal(result.outcome, 'success');
  assert.ok(result.iterations >= 2, `expected ≥ 2 iterations, got ${result.iterations}`);

  const reflections = memory.getReflections(agent.id);
  assert.equal(reflections.length, 1, 'one reflection should have been stored');
  assert.equal(reflections[0].taskId, task.id);
  assert.equal(reflections[0].taskTitle, 'investigate firewall');
  assert.equal(reflections[0].selfRating, 2);
  assert.equal(reflections[0].lessonsLearned[0], 'call mock.tool once and parse the output');
  // Cross-check: averageRating should now reflect the stored rating.
  assert.equal(memory.getAverageRating(agent.id), 2);
  memory.close();
});

test('reflection skipped on a trivial single-action task with no errors', async () => {
  const memory = new SqliteAgentMemoryStore(tempDb());
  const provider = scriptedProvider([
    'Thought: easy\nFinal Answer: trivially answered',
  ]);
  const agent = new Agent('alice', 'sysadmin', 'claude' as any, fakeFactory(provider));
  agent.setMemoryStore(memory);

  const task = makeTask();
  const result = await agent.executeTaskDetailed(task, stubSkillManager('n/a'));
  assert.equal(result.outcome, 'success');
  assert.equal(result.iterations, 0); // final answer on iteration 0

  const reflections = memory.getReflections(agent.id);
  assert.equal(reflections.length, 0, 'trivial task should not produce a reflection');
  memory.close();
});

test('past lessons are injected into the next task prompt', async () => {
  const memory = new SqliteAgentMemoryStore(tempDb());

  // Capture the prompt the agent sends to the LLM by intercepting chat().
  let firstPrompt = '';
  const provider: AIProvider = {
    name: 'spy',
    async initialize() {},
    async chat({ messages }: any) {
      if (!firstPrompt) firstPrompt = messages[messages.length - 1].content;
      return { content: 'Thought: done\nFinal Answer: stopped', model: 'fake' };
    },
    async streamChat() { return { content: '', model: 'fake' }; },
    isAvailable() { return true; },
  };

  const agent = new Agent('alice', 'sysadmin', 'claude' as any, fakeFactory(provider));
  agent.setMemoryStore(memory);
  // Pre-seed a low-rated reflection from a similar past task on THIS agent.
  // (Agent IDs are uuids, so we must seed against agent.id, not the name.)
  memory.storeReflection({
    taskId: 'past',
    agentId: agent.id,
    selfRating: 1,
    whatWorked: [],
    whatDidntWork: ['ran scan before checking dns'],
    lessonsLearned: ['always check dns first when firewall is involved'],
    suggestedImprovements: ['use network.dns up front'],
    toolEfficiency: [],
    wouldDoDifferently: 'check dns before any other network tool',
    taskTitle: 'firewall outage triage',
  });

  const task = makeTask('firewall is dropping traffic', 'help me triage');
  await agent.executeTaskDetailed(task, stubSkillManager('n/a'));

  assert.match(firstPrompt, /Lessons from past similar tasks/);
  assert.match(firstPrompt, /always check dns first when firewall is involved/);
  assert.match(firstPrompt, /check dns before any other network tool/);
  memory.close();
});

test('no lessons block when there are no relevant past reflections', async () => {
  const memory = new SqliteAgentMemoryStore(tempDb());

  let firstPrompt = '';
  const provider: AIProvider = {
    name: 'spy',
    async initialize() {},
    async chat({ messages }: any) {
      if (!firstPrompt) firstPrompt = messages[messages.length - 1].content;
      return { content: 'Thought: done\nFinal Answer: ok', model: 'fake' };
    },
    async streamChat() { return { content: '', model: 'fake' }; },
    isAvailable() { return true; },
  };

  const agent = new Agent('alice', 'sysadmin', 'claude' as any, fakeFactory(provider));
  agent.setMemoryStore(memory);
  // Reflection is for THIS agent but on an unrelated topic — keyword match
  // should fail so no block gets injected.
  memory.storeReflection({
    taskId: 'unrelated',
    agentId: agent.id,
    selfRating: 5,
    whatWorked: [], whatDidntWork: [], lessonsLearned: ['x'],
    suggestedImprovements: [], toolEfficiency: [],
    wouldDoDifferently: '',
    taskTitle: 'completely different topic about databases',
  });

  await agent.executeTaskDetailed(makeTask('firewall stuff', 'unrelated'), stubSkillManager('n/a'));

  assert.doesNotMatch(firstPrompt, /Lessons from past similar tasks/);
  memory.close();
});

test('reflector failures do not break task completion', async () => {
  const memory = new SqliteAgentMemoryStore(tempDb());
  // Keep the action turns + final answer; drop only the reflection JSON entry.
  const script = ACTION_THEN_FINAL.slice(0, 4);
  const provider = scriptedProvider(script);
  const agent = new Agent('alice', 'sysadmin', 'claude' as any, fakeFactory(provider));
  agent.setMemoryStore(memory);
  // Inject a reflector that throws — agent should still return the task result.
  agent.setReflector({
    async reflect() { throw new Error('reflector boom'); }
  } as unknown as SelfReflector);

  const result = await agent.executeTaskDetailed(makeTask(), stubSkillManager('obs'));
  assert.equal(result.outcome, 'success');
  // Reflection failed silently — no rows persisted.
  assert.equal(memory.getReflections(agent.id).length, 0);
  memory.close();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { RollbackSkill } from './RollbackSkill.js';
import { RollbackRegistry } from '../agents/RollbackRegistry.js';
import { Agent } from '../agents/Agent.js';
import { SkillManager } from './SkillManager.js';
import { FilesSkill } from './FilesSkill.js';
import type { SkillExecutionContext } from './SkillManager.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'itops-rb-skill-'));
}

test('rollback.list returns no registry message when none exists', async () => {
  Agent.activeRollbackRegistries.clear();
  const skill = new RollbackSkill();
  skill.setSkillManager(new SkillManager());
  const out = JSON.parse(await skill.rollbackList({ taskId: 'unknown' }));
  assert.equal(out.ok, true);
  assert.equal(out.data.actions.length, 0);
  assert.match(out.summary, /no registry for task unknown/);
});

test('rollback.list reports actions for a registered task', async () => {
  Agent.activeRollbackRegistries.clear();
  const reg = new RollbackRegistry();
  reg.register({
    agentId: 'alice', taskId: 't-1',
    action: 'wrote /tmp/x', skill: 'files',
    rollback: { kind: 'tool', tool: 'file.delete', params: { path: '/tmp/x' } },
  });
  Agent.activeRollbackRegistries.set('t-1', reg);

  const skill = new RollbackSkill();
  skill.setSkillManager(new SkillManager());
  const out = JSON.parse(await skill.rollbackList({ taskId: 't-1' }));
  assert.equal(out.data.total, 1);
  assert.equal(out.data.actions[0].action, 'wrote /tmp/x');
});

test('rollback.list with no taskId enumerates registries', async () => {
  Agent.activeRollbackRegistries.clear();
  const a = new RollbackRegistry();
  a.register({ agentId: 'alice', taskId: 't-a', action: 'a', skill: 's',
    rollback: { kind: 'bash', command: 'echo a' } });
  const b = new RollbackRegistry();
  b.register({ agentId: 'alice', taskId: 't-b', action: 'b', skill: 's',
    rollback: { kind: 'bash', command: 'echo b' } });
  Agent.activeRollbackRegistries.set('t-a', a);
  Agent.activeRollbackRegistries.set('t-b', b);

  const skill = new RollbackSkill();
  skill.setSkillManager(new SkillManager());
  const out = JSON.parse(await skill.rollbackList({}));
  assert.equal(out.data.totalRegistries, 2);
  assert.equal(out.data.totalActions, 2);
});

test('rollback.execute by id runs the recorded recipe and updates state', async () => {
  Agent.activeRollbackRegistries.clear();
  const dir = tempDir();
  const file = path.join(dir, 'undo.txt');
  fs.writeFileSync(file, 'created by test');

  const sm = new SkillManager();
  const reg = new RollbackRegistry();
  const id = reg.register({
    agentId: 'alice', taskId: 't-undo',
    action: `wrote ${file}`,
    rollback: { kind: 'tool', tool: 'file.delete', params: { path: file } },
    skill: 'files',
  });
  Agent.activeRollbackRegistries.set('t-undo', reg);

  const skill = new RollbackSkill();
  skill.setSkillManager(sm);
  const out = JSON.parse(await skill.rollbackExecute({ id, taskId: 't-undo' }));
  assert.equal(out.ok, true);
  assert.equal(fs.existsSync(file), false, 'rollback should have deleted the file');
  // Re-running the same id should now refuse.
  const second = JSON.parse(await skill.rollbackExecute({ id, taskId: 't-undo' }));
  assert.equal(second.ok, false);
  assert.match(second.error, /already executed/);
});

test('rollback.execute with only taskId rolls back every action in reverse', async () => {
  Agent.activeRollbackRegistries.clear();
  const dir = tempDir();
  const f1 = path.join(dir, 'a.txt');
  const f2 = path.join(dir, 'b.txt');
  fs.writeFileSync(f1, '1');
  fs.writeFileSync(f2, '2');

  const sm = new SkillManager();
  const reg = new RollbackRegistry();
  reg.register({ agentId: 'alice', taskId: 't-multi', action: `wrote ${f1}`,
    rollback: { kind: 'tool', tool: 'file.delete', params: { path: f1 } }, skill: 'files' });
  reg.register({ agentId: 'alice', taskId: 't-multi', action: `wrote ${f2}`,
    rollback: { kind: 'tool', tool: 'file.delete', params: { path: f2 } }, skill: 'files' });
  Agent.activeRollbackRegistries.set('t-multi', reg);

  const skill = new RollbackSkill();
  skill.setSkillManager(sm);
  const out = JSON.parse(await skill.rollbackExecute({ taskId: 't-multi' }));
  assert.equal(out.ok, true);
  assert.equal(out.data.executed, 2);
  assert.equal(fs.existsSync(f1), false);
  assert.equal(fs.existsSync(f2), false);
});

test('rollback.execute returns fail when neither id nor taskId given', async () => {
  const skill = new RollbackSkill();
  skill.setSkillManager(new SkillManager());
  const out = JSON.parse(await skill.rollbackExecute({}));
  assert.equal(out.ok, false);
  assert.match(out.error, /requires \{ id \} or \{ taskId \}/);
});

test('rollback.clear forgets a registry without executing it', async () => {
  Agent.activeRollbackRegistries.clear();
  const reg = new RollbackRegistry();
  reg.register({ agentId: 'alice', taskId: 't-clr', action: 'x', skill: 's',
    rollback: { kind: 'bash', command: 'echo' } });
  Agent.activeRollbackRegistries.set('t-clr', reg);

  const skill = new RollbackSkill();
  skill.setSkillManager(new SkillManager());
  const out = JSON.parse(await skill.rollbackClear({ taskId: 't-clr' }));
  assert.equal(out.ok, true);
  assert.equal(out.data.cleared, true);
  assert.equal(Agent.activeRollbackRegistries.has('t-clr'), false);
});

// ─── Integration: FilesSkill registers rollbacks via SkillExecutionContext ──

test('FilesSkill.fileWrite registers a rollback when caller passes registerRollback', async () => {
  const dir = tempDir();
  const target = path.join(dir, 'created.txt');
  const files = new FilesSkill();

  const reg = new RollbackRegistry();
  const ctx: SkillExecutionContext = {
    callerAgentId: 'alice',
    taskId: 't-files',
    registerRollback: (input) => reg.register(input),
  };

  const out = JSON.parse(await files.fileWrite({ path: target, content: 'hi' }, ctx));
  assert.equal(out.ok, true);
  // One rollback registered: a fresh creation, so the recipe is file.delete.
  const list = reg.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].rollback.kind, 'tool');
  assert.equal((list[0].rollback as any).tool, 'file.delete');
  assert.equal((list[0].rollback as any).params.path, target);
});

test('FilesSkill.fileWrite over an existing file registers a content-restoring rollback', async () => {
  const dir = tempDir();
  const target = path.join(dir, 'existing.txt');
  fs.writeFileSync(target, 'PRIOR');

  const files = new FilesSkill();
  const reg = new RollbackRegistry();
  const ctx: SkillExecutionContext = {
    callerAgentId: 'alice',
    taskId: 't-overwrite',
    registerRollback: (input) => reg.register(input),
  };

  await files.fileWrite({ path: target, content: 'NEW' }, ctx);
  const list = reg.list();
  assert.equal(list.length, 1);
  // recipe should be a fresh file.write that puts PRIOR back.
  assert.equal((list[0].rollback as any).tool, 'file.write');
  assert.equal((list[0].rollback as any).params.content, 'PRIOR');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { TelegramAlerter } from '../integrations/telegram.js';
import { TicketingSink } from '../integrations/TicketingSink.js';
import { SkillManager } from '../skills/SkillManager.js';
import { encode, ok } from '../skills/SkillResult.js';
import { WorkflowJsonExecutor, WorkflowRegistry } from '../workflows/index.js';
import { RunbookLibrary } from './RunbookLibrary.js';

function fakeBashSkill(calls: string[]) {
  return {
    skill: {
      id: 'bash', name: 'bash', description: 'fake bash', category: 'shell' as const,
      enabled: true,
      commands: [{ name: 'bash.exec', description: 'run a command', handler: 'run' }],
    },
    executor: {
      run: async (params: { command?: string }) => {
        calls.push(params.command ?? '');
        return encode(ok({ stdout: 'Filesystem 100G 80G 20G 80% /' }, 'ok'));
      },
    } as any,
  };
}

test('Acceptance: disk full flow sends Telegram approval, resumes, and syncs ticketing', async () => {
  const registry = new WorkflowRegistry({ workflowDir: '/tmp/itops-e2e-ticketing-wf' });
  new RunbookLibrary().loadAll(registry);
  const diskWf = registry.get('library.disk-cleanup');
  assert.ok(diskWf, 'library.disk-cleanup must exist');

  const bashCalls: string[] = [];
  const sm = new SkillManager();
  const bash = fakeBashSkill(bashCalls);
  sm.registerWithExecutor(bash.skill, bash.executor);

  const approvals = {
    validate: ({ token, command }: { token?: string; command: string }) =>
      token === 'tok-123' && command === 'disk-cleanup.execute'
        ? { valid: true, payload: { approver: 'operator' } }
        : { valid: false, reason: 'bad token' },
  } as any;
  const exec = new WorkflowJsonExecutor({ skillManager: sm, approvals });

  const paused = await exec.execute(diskWf, { inputs: { host: 'app-node-01' } });
  assert.equal(paused.status, 'pending_approval');
  assert.equal(paused.awaitingApproval?.stepId, 'cleanup_gate');
  assert.equal(bashCalls.some(c => c.includes('-delete')), false, 'delete must not run before approval');

  const telegramPayloads: string[] = [];
  const telegram = new TelegramAlerter(
    { TELEGRAM_ALERT_ENABLED: 'true', TELEGRAM_BOT_TOKEN: 'fake', TELEGRAM_CHAT_ID: 'fake' },
    async (_url, init) => {
      telegramPayloads.push(String(init?.body ?? ''));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  );
  assert.equal(
    await telegram.sendApprovalRequest(
      paused.awaitingApproval.command,
      'Disk full cleanup requires operator approval',
      'tok-123',
    ),
    true,
  );
  assert.match(telegramPayloads[0], /disk-cleanup\.execute/);

  const completed = await exec.execute(diskWf, {
    inputs: { host: 'app-node-01' },
    approvals: { cleanup_gate: 'tok-123' },
  });
  assert.equal(completed.status, 'completed');
  assert.ok(bashCalls.some(c => c.includes('-delete')), 'delete runs only after approval');

  let persistedJiraKey: string | undefined;
  let markedSynced = false;
  let createCount = 0;
  const store = {
    get: (id: string) => ({ id, status: 'resolved', jiraKey: persistedJiraKey, ticketingSynced: false }),
    getTimeline: () => [{ type: 'resolved', message: 'Disk cleanup completed after approval.' }],
    updateJiraKey: (_id: string, jiraKey: string) => { persistedJiraKey = jiraKey; },
    markTicketingSynced: () => { markedSynced = true; },
  } as any;
  const sink = new TicketingSink({
    store,
    getJiraService: () => ({
      isEnabled: () => true,
      createTicketForIncident: async () => { createCount++; return 'OPS-999'; },
      transitionTicket: async () => {},
      addCommentToTicket: async () => {},
    }) as any,
  });

  assert.equal(
    await sink.syncResolvedIncident({ id: 'INC-DISK-FULL', status: 'resolved', ticketingSynced: false } as any),
    true,
  );
  assert.equal(createCount, 1);
  assert.equal(persistedJiraKey, 'OPS-999');
  assert.equal(markedSynced, true);
});

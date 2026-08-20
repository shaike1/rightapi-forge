import test from 'node:test';
import assert from 'node:assert/strict';
import { createLogger, log } from './Logger.js';

/** Capture exactly one JSON log line emitted on stdout/stderr during fn(). */
async function captureOne(fn: () => void | Promise<void>): Promise<any> {
  const lines: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  (process.stdout as any).write = (chunk: any) => { lines.push(chunk.toString()); return true; };
  (process.stderr as any).write = (chunk: any) => { lines.push(chunk.toString()); return true; };
  try { await fn(); } finally {
    (process.stdout as any).write = origOut;
    (process.stderr as any).write = origErr;
  }
  return lines.length > 0 ? JSON.parse(lines[0]) : null;
}

test('createLogger tags every record with the component', async () => {
  const log = createLogger({ component: 'agent' });
  const record = await captureOne(() => log.info('task started'));
  assert.equal(record.component, 'agent');
  assert.equal(record.msg, 'task started');
  assert.equal(record.level, 'info');
});

test('withContext merges static fields into every record', async () => {
  const log = createLogger({ component: 'agent' }).withContext({ agentId: 'alice', taskId: 't-1' });
  const record = await captureOne(() => log.warn('slow tool', { tool: 'bash.exec' }));
  assert.equal(record.agentId, 'alice');
  assert.equal(record.taskId, 't-1');
  assert.equal(record.tool, 'bash.exec');
  assert.equal(record.component, 'agent');
});

test('caller-supplied data overrides bound context on collisions', async () => {
  const log = createLogger({ component: 'agent', context: { agentId: 'default' } });
  const record = await captureOne(() => log.info('override', { agentId: 'alice' }));
  assert.equal(record.agentId, 'alice');
});

test('withComponent returns a new logger with a different tag', async () => {
  const root = createLogger({ component: 'agent' });
  const skill = root.withComponent('skill');
  const record = await captureOne(() => skill.info('skill ran'));
  assert.equal(record.component, 'skill');
});

test('chained withContext composes (deep merge wins on later keys)', async () => {
  const a = createLogger({ component: 'agent' }).withContext({ agentId: 'alice' });
  const b = a.withContext({ taskId: 't-99' });
  const record = await captureOne(() => b.info('chained'));
  assert.equal(record.component, 'agent');
  assert.equal(record.agentId, 'alice');
  assert.equal(record.taskId, 't-99');
});

test('withContext later override beats earlier', async () => {
  const a = createLogger({ component: 'agent' }).withContext({ agentId: 'alice' });
  const b = a.withContext({ agentId: 'bob' });
  const record = await captureOne(() => b.info('override'));
  assert.equal(record.agentId, 'bob');
});

test('error level routes to stderr (still parseable JSON)', async () => {
  const log = createLogger({ component: 'agent' });
  const lines: string[] = [];
  const origErr = process.stderr.write.bind(process.stderr);
  (process.stderr as any).write = (chunk: any) => { lines.push(chunk.toString()); return true; };
  try { log.error('boom', { code: 500 }); } finally { (process.stderr as any).write = origErr; }
  assert.equal(lines.length, 1);
  const r = JSON.parse(lines[0]);
  assert.equal(r.level, 'error');
  assert.equal(r.msg, 'boom');
  assert.equal(r.code, 500);
  assert.equal(r.component, 'agent');
});

test('default exported `log` has the same shape with no component', async () => {
  const record = await captureOne(() => log.info('no tag'));
  assert.equal(record.component, undefined);
  assert.equal(record.msg, 'no tag');
});

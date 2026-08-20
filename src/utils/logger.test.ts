import test from 'node:test';
import assert from 'node:assert/strict';
import { logger } from './logger.js';
import { withSpan } from '../observability/Telemetry.js';

/** Capture a single log line written via logger.<level>() during `fn`. */
async function captureLog(level: 'info' | 'warn' | 'error', fn: () => void | Promise<void>): Promise<string[]> {
  const target = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  const original = target.write.bind(target);
  const captured: string[] = [];
  (target as any).write = (chunk: any) => {
    captured.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
  try { await fn(); } finally {
    (target as any).write = original;
  }
  return captured;
}

test('logger emits a structured JSON line with no traceId when no span is active', async () => {
  const lines = await captureLog('info', () => { logger.info('hello world', { key: 'value' }); });
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.level, 'info');
  assert.equal(parsed.msg, 'hello world');
  assert.equal(parsed.key, 'value');
  // No active span → no correlation fields.
  assert.equal(parsed.traceId, undefined);
  assert.equal(parsed.spanId, undefined);
  assert.equal(parsed.correlationId, undefined);
});

test('logger respects existing data fields and adds them at top level', async () => {
  const lines = await captureLog('warn', () => { logger.warn('something', { count: 3 }); });
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.count, 3);
  assert.equal(parsed.level, 'warn');
});

test('within withSpan + OTel disabled, still no traceId (no-op tracer)', async () => {
  const lines = await captureLog('info', async () => {
    await withSpan('test.op', () => {
      logger.info('inside span (OTel disabled)');
    });
  });
  const parsed = JSON.parse(lines[0]);
  // OTEL_ENABLED is false in tests so the no-op tracer doesn't put a span
  // context anywhere — correlation fields stay absent.
  assert.equal(parsed.traceId, undefined);
});

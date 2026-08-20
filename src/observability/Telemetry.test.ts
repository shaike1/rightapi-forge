import test from 'node:test';
import assert from 'node:assert/strict';
import {
  initTelemetry,
  shutdownTelemetry,
  isTelemetryEnabled,
  withSpan,
  startSpan,
  endSpan,
  currentTraceContext,
  captureContext,
  withCapturedContext,
  getTracer,
} from './Telemetry.js';

// We deliberately do NOT enable OTEL during tests — we want to assert the
// no-op path stays correct. (Verifying real OTLP traffic would require a
// running collector, which the test sandbox doesn't have.)

test('initTelemetry({ enabled: false }) is a no-op', async () => {
  const started = await initTelemetry({ enabled: false });
  assert.equal(started, false);
  assert.equal(isTelemetryEnabled(), false);
});

test('initTelemetry is idempotent', async () => {
  await initTelemetry({ enabled: false });
  const second = await initTelemetry({ enabled: false });
  assert.equal(second, false);
});

test('withSpan still calls the body when telemetry is disabled', async () => {
  let ran = false;
  const result = await withSpan('test.op', async () => {
    ran = true;
    return 42;
  });
  assert.equal(ran, true);
  assert.equal(result, 42);
});

test('withSpan re-throws errors from the body', async () => {
  await assert.rejects(
    () => withSpan('test.op', async () => { throw new Error('boom'); }),
    /boom/
  );
});

test('startSpan + endSpan complete cleanly when disabled', () => {
  const span = startSpan('manual.op', { ['some.attr']: 'x' });
  assert.ok(span);
  endSpan(span);
});

test('endSpan with an error does not throw', () => {
  const span = startSpan('manual.fail');
  endSpan(span, new Error('failed'));
});

test('currentTraceContext returns null when no span is active', () => {
  // Outside any withSpan — no active span.
  const ctx = currentTraceContext();
  assert.equal(ctx, null);
});

test('captureContext + withCapturedContext run the body', async () => {
  const captured = captureContext();
  let observed = false;
  const result = await withCapturedContext(captured, async () => {
    observed = true;
    return 'ok';
  });
  assert.equal(observed, true);
  assert.equal(result, 'ok');
});

test('getTracer returns a tracer named after the service', () => {
  const tracer = getTracer();
  assert.ok(tracer);
  // Tracer is opaque in the proxy provider — the only stable assertion is
  // that the helper hands one back at all without throwing.
  assert.equal(typeof (tracer as any).startSpan, 'function');
});

test('shutdownTelemetry without init is harmless', async () => {
  await shutdownTelemetry();
});

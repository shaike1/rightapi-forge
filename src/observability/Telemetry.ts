// OpenTelemetry bootstrap.
//
// Opt-in via OTEL_ENABLED=true. When disabled, every helper here is a clean
// no-op so callers don't need to branch on whether tracing is configured —
// they unconditionally call `withSpan`/`getTracer` and pay no overhead when
// the SDK isn't running.
//
//   OTEL_ENABLED                  default false
//   OTEL_SERVICE_NAME             default "itops-agents"
//   OTEL_EXPORTER_OTLP_ENDPOINT   default http://localhost:4318
//
// The exporter speaks OTLP/HTTP, so the default endpoint is happy with
// Jaeger's all-in-one image (port 4318) or any OTel collector. Graceful
// SIGTERM/SIGINT shutdown flushes pending spans before exit.
//
// In addition to bootstrap, this module exposes a set of helpers used by the
// agent stack (Agent, SkillManager, DelegationSkill, SelfReflector, AI
// providers) to start spans without depending on @opentelemetry/api directly:
//
//   • withSpan(name, attrs?, fn)              — wrap an async block in a span
//   • startSpan / endSpan                     — manual span lifecycle when
//                                               wrapping isn't ergonomic
//   • currentTraceContext()                   — read the active trace id /
//                                               span id (for correlation IDs
//                                               in logs)
//   • activeContext / withContext             — re-attach a captured context
//                                               (used to link delegation
//                                                children to their parents)

import { trace, context, SpanStatusCode, SpanKind, type Span, type Tracer, type Context } from '@opentelemetry/api';

let initialised = false;
let sdkInstance: any = null;
let initError: string | null = null;

const SERVICE_NAME = process.env.OTEL_SERVICE_NAME || 'itops-agents';
const TRACER_NAME = 'itops-agents';

export interface TelemetryOptions {
  /** Force-enable / force-disable irrespective of OTEL_ENABLED env. */
  enabled?: boolean;
  /** OTLP HTTP endpoint base. Trace and metrics are appended automatically. */
  endpoint?: string;
  /** Service name used for the resource. */
  serviceName?: string;
  /** Service version (read from package.json by default). */
  serviceVersion?: string;
  /** Disable automatic Express/HTTP instrumentation. Default true (enabled). */
  autoInstrument?: boolean;
}

/**
 * Initialise the OTel SDK. Idempotent — repeated calls after the first are
 * no-ops. Returns true when the SDK was actually started.
 */
export async function initTelemetry(opts: TelemetryOptions = {}): Promise<boolean> {
  if (initialised) return !!sdkInstance;

  const enabled = opts.enabled ?? (process.env.OTEL_ENABLED === 'true');
  if (!enabled) {
    initialised = true;
    return false;
  }

  try {
    // Lazy-load so users that don't enable telemetry don't pay the SDK cost.
    const { NodeSDK } = await import('@opentelemetry/sdk-node');
    const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http');
    const { OTLPMetricExporter } = await import('@opentelemetry/exporter-metrics-otlp-http');
    const { resourceFromAttributes } = await import('@opentelemetry/resources');
    const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } = await import('@opentelemetry/semantic-conventions');
    const { getNodeAutoInstrumentations } = await import('@opentelemetry/auto-instrumentations-node');
    const { PeriodicExportingMetricReader } = await import('@opentelemetry/sdk-metrics');

    const endpoint = opts.endpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318';
    const serviceName = opts.serviceName ?? SERVICE_NAME;
    const serviceVersion = opts.serviceVersion ?? readPackageVersion() ?? '0.0.0';

    const resource = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_VERSION]: serviceVersion,
    });

    const sdk = new NodeSDK({
      resource,
      traceExporter: new OTLPTraceExporter({ url: `${endpoint.replace(/\/$/, '')}/v1/traces` }),
      metricReader: new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: `${endpoint.replace(/\/$/, '')}/v1/metrics` }),
        exportIntervalMillis: 60_000,
      }),
      instrumentations: opts.autoInstrument === false ? [] : [getNodeAutoInstrumentations({
        // Disable noisy or duplicate instrumentations that produce per-DB-call
        // spans we don't need (better-sqlite3 doesn't have an instrumentation
        // anyway). HTTP + Express are kept on.
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-dns': { enabled: false },
      })],
    });
    sdk.start();
    sdkInstance = sdk;
    initialised = true;

    const shutdown = async () => { try { await shutdownTelemetry(); } catch { /* best-effort */ } };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    return true;
  } catch (e: any) {
    initError = e?.message ?? String(e);
    initialised = true;
    return false;
  }
}

export async function shutdownTelemetry(): Promise<void> {
  if (sdkInstance) {
    try { await sdkInstance.shutdown(); } catch { /* swallow */ }
    sdkInstance = null;
  }
}

export function isTelemetryEnabled(): boolean {
  return !!sdkInstance;
}

export function telemetryInitError(): string | null {
  return initError;
}

// ─── Span helpers ──────────────────────────────────────────────────────────

export function getTracer(): Tracer {
  return trace.getTracer(TRACER_NAME);
}

/**
 * Run `fn` inside a child span. The span is ended automatically; thrown
 * exceptions mark the span as ERROR before re-throwing.
 *
 * Works as a no-op when telemetry isn't enabled — just runs `fn`.
 */
export async function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T> | T,
  attrs?: Record<string, string | number | boolean>,
  kind: SpanKind = SpanKind.INTERNAL
): Promise<T> {
  const tracer = getTracer();
  return tracer.startActiveSpan(name, { kind, attributes: attrs }, async (span) => {
    try {
      const out = await fn(span);
      span.end();
      return out;
    } catch (e: any) {
      span.recordException(e);
      span.setStatus({ code: SpanStatusCode.ERROR, message: e?.message ?? String(e) });
      span.end();
      throw e;
    }
  });
}

/**
 * Start a span manually. Caller MUST call endSpan(span). Use when withSpan
 * doesn't fit (long-running work split across multiple sites, e.g. the
 * task-level span the Agent loop opens at start and closes at end).
 */
export function startSpan(name: string, attrs?: Record<string, string | number | boolean>, kind: SpanKind = SpanKind.INTERNAL): Span {
  return getTracer().startSpan(name, { kind, attributes: attrs });
}

export function endSpan(span: Span, error?: unknown): void {
  if (error) {
    const e = error as Error;
    span.recordException(e);
    span.setStatus({ code: SpanStatusCode.ERROR, message: e?.message ?? String(error) });
  }
  span.end();
}

/** Snapshot of the active trace context (traceId/spanId) for log correlation. */
export function currentTraceContext(): { traceId: string; spanId: string } | null {
  const span = trace.getActiveSpan();
  if (!span) return null;
  const ctx = span.spanContext();
  if (!ctx.traceId || ctx.traceId === '00000000000000000000000000000000') return null;
  return { traceId: ctx.traceId, spanId: ctx.spanId };
}

/** Capture the current OTel Context for re-binding later (used when one
 *  agent delegates to another and we want the child's spans to share the
 *  parent's trace). */
export function captureContext(): Context {
  return context.active();
}

/** Run a function with a previously-captured Context bound as the active
 *  context. Used by DelegationSkill to ensure the delegated agent's spans
 *  hang off the requesting agent's task span. */
export async function withCapturedContext<T>(captured: Context, fn: () => Promise<T> | T): Promise<T> {
  return context.with(captured, fn);
}

/** Re-export OTel kinds/status for skills that want to set them. */
export { SpanKind, SpanStatusCode } from '@opentelemetry/api';
export type { Span } from '@opentelemetry/api';

// ─── Internals ─────────────────────────────────────────────────────────────

function readPackageVersion(): string | null {
  try {
    // Resolve relative to this compiled file's location at runtime.
    const url = new URL('../../package.json', import.meta.url);
    // Sync read — only invoked once at startup so we don't care about FS time.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('node:fs');
    const raw = fs.readFileSync(url, 'utf8');
    return JSON.parse(raw).version ?? null;
  } catch {
    return null;
  }
}

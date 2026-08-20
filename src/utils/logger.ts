import { requestLogFields } from '../observability/RequestContext.js';
import { redactLogPayload } from '../observability/Redactor.js';

type Level = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVEL = (process.env.LOG_LEVEL || 'info') as Level;
const LEVELS: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/**
 * Lazy-resolved trace-context reader. Imported via dynamic specifier so the
 * logger doesn't pull in @opentelemetry/api unless someone has actually
 * installed it (and so test runs that import logger first don't crash if
 * the dep is absent). When unavailable, getCorrelation() returns null and
 * log entries are unchanged.
 */
type CorrelationFn = () => { traceId: string; spanId: string } | null;
let resolveCorrelation: CorrelationFn = () => null;
let correlationProbed = false;

function getCorrelation(): { traceId: string; spanId: string } | null {
  if (!correlationProbed) {
    correlationProbed = true;
    try {
      // ESM dynamic import would make this async; the api package is small
      // and synchronous, so require() lets us keep log() synchronous.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { trace } = require('@opentelemetry/api');
      resolveCorrelation = () => {
        const span = trace.getActiveSpan();
        if (!span) return null;
        const ctx = span.spanContext();
        if (!ctx?.traceId || ctx.traceId === '00000000000000000000000000000000') return null;
        return { traceId: ctx.traceId, spanId: ctx.spanId };
      };
    } catch {
      // OTel api not installed → correlations stay null forever.
    }
  }
  try { return resolveCorrelation(); } catch { return null; }
}

function log(level: Level, msg: string, data?: Record<string, unknown>): void {
  if (LEVELS[level] < LEVELS[LOG_LEVEL]) return;
  // Redact secrets in the caller-supplied payload BEFORE merging. A
  // single recursive pass is cheaper than auditing every call site,
  // and the no-op path returns the same object reference.
  const safe = redactLogPayload(data);
  const entry: Record<string, unknown> = {
    time: new Date().toISOString(),
    level,
    service: 'itops-agents',
    msg,
    ...requestLogFields(),
    ...safe,
  };
  // Inject the active trace's identifiers so log records line up with the
  // distributed trace in Jaeger / Tempo etc. Only added when a span is
  // active and OTel is wired in — otherwise the fields are simply absent.
  const corr = getCorrelation();
  if (corr) {
    entry.traceId = corr.traceId;
    entry.spanId = corr.spanId;
    // `correlationId` is the conventional name many UIs filter by; alias it.
    if (entry.correlationId === undefined) entry.correlationId = corr.traceId;
  }
  const line = JSON.stringify(entry) + '\n';
  if (level === 'error' || level === 'warn') {
    process.stderr.write(line);
  } else {
    process.stdout.write(line);
  }
}

export const logger = {
  debug: (msg: string, data?: Record<string, unknown>) => log('debug', msg, data),
  info:  (msg: string, data?: Record<string, unknown>) => log('info',  msg, data),
  warn:  (msg: string, data?: Record<string, unknown>) => log('warn',  msg, data),
  error: (msg: string, data?: Record<string, unknown>) => log('error', msg, data),
};

export default logger;

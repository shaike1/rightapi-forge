// Component-aware structured logger.
//
// Wraps the JSON logger in src/utils/logger.ts (which already injects
// traceId/spanId from the active OTel context) with a thin component-tag
// + bound-context layer. Most callers do:
//
//   import { createLogger } from '../observability/Logger.js';
//   const log = createLogger({ component: 'agent' });
//   log.info('task started', { taskId });
//
// …and every record produced by `log` carries `component: "agent"` plus
// whatever was on the active OTel span.
//
// For per-task context — taskId, agentId — use withContext():
//
//   const taskLog = log.withContext({ agentId, taskId });
//   taskLog.info('iteration finished');   // tagged with agentId + taskId
//
// The base logger from utils/logger.ts is unchanged so old callers keep
// working without churn — this module is additive.

import { logger as base } from '../utils/logger.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogPayload = Record<string, unknown>;

export interface ComponentLogger {
  debug(msg: string, data?: LogPayload): void;
  info(msg: string, data?: LogPayload): void;
  warn(msg: string, data?: LogPayload): void;
  error(msg: string, data?: LogPayload): void;
  /** Return a child logger that tags every record with the given fields. */
  withContext(extra: LogPayload): ComponentLogger;
  /** Return a child logger with a different / more specific component tag. */
  withComponent(component: string): ComponentLogger;
}

export interface LoggerOptions {
  /** Tag every record with this value under `component`. */
  component?: string;
  /** Static fields merged into every record (alongside `component`). */
  context?: LogPayload;
}

function build(opts: LoggerOptions): ComponentLogger {
  const tag: LogPayload = {};
  if (opts.component) tag.component = opts.component;
  Object.assign(tag, opts.context ?? {});

  const emit = (level: LogLevel, msg: string, data?: LogPayload) => {
    // Caller-supplied data wins on field collisions — useful for one-off
    // overrides like `log.info('x', { component: 'something-else' })`.
    base[level](msg, { ...tag, ...(data ?? {}) });
  };

  return {
    debug: (m, d) => emit('debug', m, d),
    info:  (m, d) => emit('info',  m, d),
    warn:  (m, d) => emit('warn',  m, d),
    error: (m, d) => emit('error', m, d),
    withContext(extra) {
      return build({ component: opts.component, context: { ...(opts.context ?? {}), ...extra } });
    },
    withComponent(component) {
      return build({ component, context: opts.context });
    },
  };
}

/** Factory — returns a ComponentLogger with the given component tag. */
export function createLogger(opts: LoggerOptions = {}): ComponentLogger {
  return build(opts);
}

/** Default componentless logger for callers that just want the typed interface
 *  without a component tag. Equivalent to the unstamped `base` logger but
 *  exposes withContext/withComponent for incremental adoption. */
export const log: ComponentLogger = build({});

// Re-export the legacy logger so call-sites can migrate path-by-path.
export { logger } from '../utils/logger.js';

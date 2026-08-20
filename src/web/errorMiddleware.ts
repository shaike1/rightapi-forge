// Global error handler middleware + crash safety nets.
//
// What lands here:
//   * Any Express route that throws or calls next(err).
//   * Any process-level uncaught exception or unhandled rejection
//     (registered via installCrashGuards).
//
// Response shape (matches the validation + rate-limit envelopes):
//   { error: string, code: string, details?: unknown, requestId?: string }
// In production we strip stack traces; in dev (NODE_ENV !== 'production')
// the stack flows back so a developer hitting curl sees the cause.
//
// Crash guards: log + escalate to the GracefulShutdown coordinator so
// pending DB writes flush before exit(). We exit(1) on the next tick;
// pm2/Docker restarts the process. Without these handlers, Node prints
// to stderr and exits without running shutdown hooks — DB rows that
// were mid-flush get lost.

import type { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger.js';
import { ZodError } from 'zod';

const IS_PROD = process.env.NODE_ENV === 'production';

export interface AppError extends Error {
  status?: number;
  code?: string;
  details?: unknown;
  expose?: boolean;
}

/** Construct an error with status + code that the global handler will
 *  surface verbatim. Use sparingly — most validation errors should be
 *  caught by zod schemas; this is for handler-level business errors. */
export class HttpError extends Error implements AppError {
  status: number;
  code: string;
  details?: unknown;
  expose = true;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Express global error handler. Must be the LAST app.use() — anything
 *  registered after it never sees the error. */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (res.headersSent) {
    // Already streamed something — Express will close the connection.
    // Just log so an operator can correlate the partial response.
    logger.warn('[error] thrown after headers already sent', { url: req.originalUrl, err: errMessage(err) });
    return;
  }

  // Map common error shapes to a structured envelope.
  let status = 500;
  let code = 'INTERNAL';
  let message = 'Internal server error';
  let details: unknown;

  if (err instanceof HttpError) {
    status = err.status;
    code = err.code;
    message = err.message;
    details = err.details;
  } else if (err instanceof ZodError) {
    status = 400;
    code = 'VALIDATION_ERROR';
    message = 'Validation failed';
    details = err.errors.map(i => ({ path: i.path.join('.'), message: i.message }));
  } else if (err && typeof err === 'object' && 'status' in (err as any) && typeof (err as any).status === 'number') {
    // Express-style HTTP errors from body-parser, multer, etc.
    status = (err as any).status as number;
    code = (err as any).code || (status === 413 ? 'PAYLOAD_TOO_LARGE' : 'HTTP_ERROR');
    message = (err as Error).message || message;
  } else if (err instanceof Error) {
    message = err.message || message;
  }

  // Log every error — operators rely on this for incident response.
  const logCtx: Record<string, unknown> = {
    status, code,
    method: req.method,
    url: req.originalUrl,
    ip: req.ip,
    requestId: (req as any).id,
  };
  if (err instanceof Error && err.stack) logCtx.stack = err.stack;
  if (status >= 500) logger.error('[error] ' + message, logCtx);
  else                logger.warn('[error] ' + message, logCtx);

  const body: Record<string, unknown> = { error: message, code };
  if (details !== undefined) body.details = details;
  if ((req as any).id) body.requestId = (req as any).id;
  // Dev-only: surface stack for debugging.
  if (!IS_PROD && err instanceof Error) body.stack = err.stack;

  res.status(status).json(body);
}

/** Install process-level crash guards. Logs the error, escalates to
 *  the GracefulShutdown coordinator, then exits with code 1. The
 *  coordinator's hooks still run — DB closes, telemetry flushes.
 *
 *  Pass a shutdown coordinator to wire teardown; passing undefined
 *  installs naïve handlers that just log + exit(1) (suitable for
 *  short-lived CLI utilities). */
export function installCrashGuards(opts: {
  shutdown?: { shutdown: (o?: { signal?: string; exit?: boolean }) => Promise<void>; isShuttingDown: () => boolean };
} = {}): void {
  if ((process as any).__beaconCrashGuardsInstalled) return;
  (process as any).__beaconCrashGuardsInstalled = true;

  process.on('uncaughtException', (err) => {
    logger.error('[crashGuard] uncaughtException — initiating shutdown', {
      err: err?.message ?? String(err),
      stack: err?.stack,
    });
    triggerShutdown('uncaughtException');
  });

  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    logger.error('[crashGuard] unhandledRejection — initiating shutdown', {
      err: err.message,
      stack: err.stack,
    });
    triggerShutdown('unhandledRejection');
  });

  function triggerShutdown(signal: string): void {
    if (opts.shutdown) {
      if (opts.shutdown.isShuttingDown()) return;
      opts.shutdown.shutdown({ signal, exit: true }).catch(e => {
        logger.error('[crashGuard] shutdown coordinator failed', { err: (e as Error).message });
        setTimeout(() => process.exit(1), 100).unref?.();
      });
    } else {
      setTimeout(() => process.exit(1), 100).unref?.();
    }
  }
}

function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

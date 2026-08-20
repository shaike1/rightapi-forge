// Request-context middleware — generates / propagates X-Request-Id and
// runs the rest of the request inside an AsyncLocalStorage scope so
// every downstream log record carries the request id automatically.
//
// Order: must be mounted BEFORE the auth middleware so the request id
// shows up on 401 responses. The auth middleware separately calls
// `setCurrentUserId()` once it resolves the JWT subject — that fills in
// the userId field on subsequent logs.
//
// The middleware also writes ONE summary log line per request when the
// response finishes — method, path, status, duration, userId.
// Replacing the previous standalone logger middleware in server.ts.

import type { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger.js';
import { runWithRequest, newRequestId, getCurrentRequest } from '../observability/RequestContext.js';

const HEADER = 'x-request-id';

/** Express middleware factory. Optional path-prefix skips let static
 *  asset paths bypass the per-request log line. */
export function requestContextMiddleware(opts: { skipPrefixes?: string[] } = {}) {
  const skip = opts.skipPrefixes ?? ['/app/'];
  return function requestContext(req: Request, res: Response, next: NextFunction) {
    const inbound = req.header(HEADER);
    // Reuse caller-supplied request id when it looks well-formed,
    // otherwise mint a new one. A misbehaving client can't poison logs
    // — we cap length and reject anything but the safe ASCII subset.
    const requestId = isValidId(inbound) ? inbound! : newRequestId();
    res.setHeader('X-Request-Id', requestId);

    const startMs = Date.now();
    runWithRequest(
      {
        requestId,
        method: req.method,
        path: req.path,
        startMs,
      },
      () => {
        if (skip.some(p => req.path.startsWith(p))) {
          return next();
        }
        res.on('finish', () => {
          const ctx = getCurrentRequest();
          logger.info('http', {
            method: req.method,
            path: req.path,
            status: res.statusCode,
            durationMs: Date.now() - startMs,
            ip: req.ip,
            userId: ctx?.userId,
            requestId: ctx?.requestId,
          });
        });
        next();
      },
    );
  };
}

const ID_PATTERN = /^[A-Za-z0-9_.:\-]{8,128}$/;

function isValidId(v: string | undefined): boolean {
  if (!v) return false;
  return ID_PATTERN.test(v);
}

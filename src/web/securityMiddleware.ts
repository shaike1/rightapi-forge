// Security middleware bundle for Beacon's HTTP surface.
//
// What it adds on top of the existing CORS + rate-limit wiring:
//   1. Helmet (CSP, HSTS, X-Frame-Options, X-Content-Type-Options,
//      Referrer-Policy, no-X-Powered-By). CSP is hand-tuned to allow
//      the Vite-emitted inline styles + Google Fonts the SPA needs.
//   2. Per-user AI/chat rate limiter (20 req/min) keyed on the JWT
//      subject when present, falling back to IP.
//   3. WebSocket message rate limiter — a tiny token-bucket gate
//      callable from inside the existing WS message handler.
//
// HTTP-level limiters (global 100/min, auth 5/min) are exported from
// here too so server.ts no longer has to wire express-rate-limit
// directly — single import surface for everything security-shaped.

import type { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import rateLimit, { ipKeyGenerator, type Options as RateLimitOptions } from 'express-rate-limit';

// ── HTTP rate limiters ────────────────────────────────────────────
//
// Tighter than the previous values (auth 10 → 5, api 120 → 100) to
// match the production-hardening spec. standardHeaders publish the
// RFC-9239 RateLimit-* headers so clients can self-throttle; the
// legacy X-RateLimit-* headers are off to avoid double-publishing.

const SHARED_LIMIT_OPTS: Partial<RateLimitOptions> = {
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // Hand back a structured envelope matching the global error shape so
  // the React client can branch on `code` instead of regex-matching the
  // message. Retry-After is set automatically by express-rate-limit.
  handler: (req, res, _next, options) => {
    res.status(options.statusCode).json({
      error: 'Rate limit exceeded — slow down and try again in a moment.',
      code: 'RATE_LIMITED',
      details: { limit: options.max, windowMs: options.windowMs },
    });
  },
};

export const globalLimiter = rateLimit({
  ...SHARED_LIMIT_OPTS,
  windowMs: 60_000,
  max: 100,
});

export const authLimiter = rateLimit({
  ...SHARED_LIMIT_OPTS,
  windowMs: 60_000,
  max: 5,
});

export function aiRateLimitKey(req: Pick<Request, 'header' | 'ip'>): string {
  const header = req.header('authorization') || '';
  const match = header.match(/^Bearer\s+([^.]+\.[^.]+\.[^.]+)$/i);
  if (match) {
    // Authentication middleware verifies the token. This decode only
    // selects a stable per-user limiter bucket.
    try {
      const payload = JSON.parse(Buffer.from(match[1].split('.')[1], 'base64url').toString('utf8'));
      if (payload?.sub) return `user:${payload.sub}`;
    } catch { /* fall through */ }
  }
  return `ip:${ipKeyGenerator(req.ip || 'unknown')}`;
}

/** Per-user (or per-IP fallback) limiter for AI / chat endpoints.
 *  Keyed on the bearer-token subject — the same user from two
 *  different IPs is one bucket. */
export const aiLimiter = rateLimit({
  ...SHARED_LIMIT_OPTS,
  windowMs: 60_000,
  max: 20,
  keyGenerator: aiRateLimitKey,
});

// ── Helmet bundle ─────────────────────────────────────────────────
//
// CSP allowlist:
//   * scripts: self only — Vite emits hashed bundles, no eval/inline
//   * styles: self + unsafe-inline (CSS-Modules emits style attrs
//     + Google Fonts stylesheet imports the SPA needs)
//   * fonts: self + Google Fonts CDN
//   * connect: self + ws: same-origin (the WebSocket upgrade target)
//   * img: self + data: (manifest icons + a few base64 thumbnails)
// HSTS is OFF by default — we set max-age=0 when SSL_DISABLED is
// truthy (the typical dev / nsenter setup serves HTTP). In production
// the reverse proxy adds its own HSTS header; turning ours on too
// would compound + extend if a misconfigured proxy ever drops back to
// HTTP.

export function buildHelmet() {
  const cspExtraConnect = (process.env.CSP_EXTRA_CONNECT_SRC || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const cspExtraScript = (process.env.CSP_EXTRA_SCRIPT_SRC || '')
    .split(',').map(s => s.trim()).filter(Boolean);

  return helmet({
    contentSecurityPolicy: {
      // 'self' allows the SPA bundle; we add Google Fonts explicitly.
      // WebSocket upgrades require ws:/wss: in connect-src — env-driven
      // so a deployment behind nginx/cloudflare can add more origins
      // without code changes.
      useDefaults: true,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc:  ["'self'", ...cspExtraScript],
        styleSrc:   ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc:    ["'self'", 'https://fonts.gstatic.com', 'data:'],
        imgSrc:     ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'", 'ws:', 'wss:', ...cspExtraConnect],
        // No third-party iframes today; lock down.
        frameSrc:    ["'none'"],
        frameAncestors: ["'none'"],
        objectSrc:   ["'none'"],
        baseUri:     ["'self'"],
        formAction:  ["'self'"],
        upgradeInsecureRequests: process.env.SSL_DISABLED === 'true' ? null : [],
      },
    },
    // Set X-Frame-Options: DENY explicitly. helmet does this via the
    // frameguard option which is on by default; we make it explicit
    // so a future tweak to "useDefaults: false" stays safe.
    frameguard: { action: 'deny' },
    // Avoid MIME sniffing.
    noSniff: true,
    // Referrer-Policy: strict-origin-when-cross-origin (helmet default
    // since v6 — explicit for clarity).
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    // HSTS: on in production (recurring reverse proxy can override),
    // off when SSL_DISABLED is truthy so a dev that flips between
    // HTTP/HTTPS doesn't pin browsers to HTTPS-only.
    hsts: process.env.SSL_DISABLED === 'true'
      ? false
      : { maxAge: 15_768_000, includeSubDomains: true, preload: false },
    // Old IE compat headers are off — Beacon is a modern SPA.
    xPoweredBy: false,
    // Cross-Origin policies — keep COOP on so popup-based OAuth can't
    // read the SPA's window.opener, but COEP/CORP off because some
    // third-party assets (Google Fonts) lack the required headers.
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    crossOriginEmbedderPolicy: false,
  });
}

// ── WebSocket message rate limiter ─────────────────────────────────
//
// In-memory token-bucket per connection. Stateless: the limiter
// returns true/false; the caller decides whether to drop the message
// (with an `error` send) or close the socket on persistent abuse.
// Tokens regenerate at the spec rate — 10 msg/min per connection
// matches the spec.

interface BucketState {
  /** Remaining tokens at the most recent tick. */
  tokens: number;
  /** Last refill timestamp (ms). */
  lastRefillMs: number;
  /** How many times THIS connection has been rate-limited. Used to
   *  decide whether to escalate to a forced close after sustained
   *  abuse — caller chooses the threshold. */
  rejections: number;
}

export interface WsRateLimiterOptions {
  /** Tokens per window (default 10). */
  burst?: number;
  /** Window in ms across which tokens refill (default 60_000). */
  windowMs?: number;
}

export class WsMessageRateLimiter {
  private state = new WeakMap<object, BucketState>();
  private burst: number;
  private windowMs: number;

  constructor(opts: WsRateLimiterOptions = {}) {
    this.burst = Math.max(1, opts.burst ?? 10);
    this.windowMs = Math.max(1_000, opts.windowMs ?? 60_000);
  }

  /** Returns true when the message is allowed, false when the bucket
   *  is empty (caller should drop / reject the message). Increments
   *  the rejection counter on a deny so callers can escalate. */
  check(client: object): { allowed: boolean; remaining: number; resetMs: number; rejections: number } {
    const now = Date.now();
    let s = this.state.get(client);
    if (!s) {
      s = { tokens: this.burst, lastRefillMs: now, rejections: 0 };
      this.state.set(client, s);
    }
    // Refill: tokens accrue linearly across the window.
    const elapsed = now - s.lastRefillMs;
    if (elapsed > 0) {
      const refill = (elapsed / this.windowMs) * this.burst;
      s.tokens = Math.min(this.burst, s.tokens + refill);
      s.lastRefillMs = now;
    }
    if (s.tokens >= 1) {
      s.tokens -= 1;
      return { allowed: true, remaining: Math.floor(s.tokens), resetMs: this.estimateResetMs(s), rejections: s.rejections };
    }
    s.rejections += 1;
    return { allowed: false, remaining: 0, resetMs: this.estimateResetMs(s), rejections: s.rejections };
  }

  private estimateResetMs(s: BucketState): number {
    if (s.tokens >= 1) return 0;
    const needed = 1 - s.tokens;
    return Math.ceil((needed / this.burst) * this.windowMs);
  }
}

/** Singleton WS limiter — wired into server.ts WebSocket handlers. */
export const wsRateLimiter = new WsMessageRateLimiter({ burst: 10, windowMs: 60_000 });

// ── Compose: app.use() this once early in server.ts ───────────────
//
// Order matters: helmet first so security headers are present on
// every response (including 4xx/5xx). The global rate limiter goes
// after CORS so pre-flight OPTIONS aren't billed against the bucket.

export function applySecurity(app: import('express').Express): void {
  app.disable('x-powered-by');
  app.use(buildHelmet());
}

// Validation + sanitisation helpers for the REST API.
//
// Why this exists:
//   * zod is already a dep (used by MCP), so we reuse it for HTTP routes.
//   * Express handlers used to receive raw req.body and do ad-hoc type
//     coercion. That made every route a candidate for a malformed-input
//     bug. The helpers below give each route a single
//     `validate(schema, source)` call that returns 400 with field-level
//     errors on failure and a typed payload on success.
//   * Sanitisation strips control chars and any tag-looking sequences
//     from string fields that flow to user-facing surfaces (incident
//     descriptions, KB articles, chat messages). The KB renderer
//     already escapes for display, but defense-in-depth: clean at the
//     boundary so audit logs / Slack / email / Jira do not ship raw
//     attacker strings to third-party renderers.
//
// Errors fit the shared envelope: { error, code, details }. Routes
// downstream surface them unchanged.

import type { Request, Response, NextFunction } from 'express';
import { z, ZodError, type ZodIssue, type ZodType } from 'zod';

export type ValidationSource = 'body' | 'query' | 'params';

/** One-call wrapper: validate `source` against `schema`, return either
 *  the typed payload or a 400 with field details. Express middleware
 *  style — drop into a route before the handler runs. */
export function validate<T>(schema: ZodType<T>, source: ValidationSource = 'body'): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    const input = (req as any)[source] ?? {};
    const parsed = schema.safeParse(input);
    if (!parsed.success) {
      res.status(400).json(formatZodError(parsed.error, source));
      return;
    }
    // Stash on the request for the route handler. We keep req[source]
    // intact (some callers reach into it directly) and add the typed
    // copy under req.validated.<source>. TypeScript does not know
    // about this without a module augmentation; routes cast where
    // needed.
    (req as any).validated = (req as any).validated ?? {};
    (req as any).validated[source] = parsed.data;
    next();
  };
}

/** Format a ZodError as the platform standard error envelope. */
export function formatZodError(err: ZodError, source: ValidationSource = 'body'): {
  error: string;
  code: string;
  details: Array<{ path: string; message: string; received?: unknown }>;
} {
  const details = err.errors.map((i: ZodIssue) => ({
    path: i.path.length === 0 ? source : `${source}.${i.path.join('.')}`,
    message: i.message,
    received: (i as any).received,
  }));
  return {
    error: 'Validation failed',
    code: 'VALIDATION_ERROR',
    details,
  };
}

// ── Sanitisation primitives ────────────────────────────────────────
//
// Built dynamically from char codes so this source file stays pure
// ASCII (no raw control bytes). Strips C0 controls except TAB/LF/CR
// plus DEL (0x7F). Anything outside printable ASCII keeps flowing
// through — UTF-8 emoji and Hebrew etc. are unaffected.
const CONTROL_CHARS_RE = (() => {
  const ranges: string[] = [];
  for (let i = 0; i < 256; i++) {
    if ((i < 32 && i !== 9 && i !== 10 && i !== 13) || i === 127) {
      ranges.push('\\x' + i.toString(16).padStart(2, '0'));
    }
  }
  return new RegExp('[' + ranges.join('') + ']', 'g');
})();

const SCRIPT_BLOCK_RE = /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi;
// Event-handler attribute (onclick="…", /onload=…, etc.). The leading
// boundary matches either whitespace OR forward-slash so payloads
// like `<svg/onload=x>` and `<img src=x onerror=y>` both get stripped.
const EVENT_ATTR_RE = /[\s\/]on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
const JAVASCRIPT_URI_RE = /javascript\s*:/gi;
const DATA_HTML_URI_RE = /data\s*:\s*text\/html/gi;

/** Strip HTML-ish sequences + control characters from a string so it
 *  cannot break downstream renderers. Used for free-form fields that
 *  flow to Slack / email / Jira / audit logs / chat replays. NOT a
 *  replacement for context-aware escaping at the actual render site —
 *  this is defense-in-depth at the boundary. */
export function sanitizeText(input: unknown, opts: { maxLen?: number } = {}): string {
  if (input == null) return '';
  let s = String(input);
  s = s.replace(CONTROL_CHARS_RE, '');
  s = s.replace(SCRIPT_BLOCK_RE, '');
  s = s.replace(EVENT_ATTR_RE, '');
  s = s.replace(JAVASCRIPT_URI_RE, '');
  s = s.replace(DATA_HTML_URI_RE, '');
  const max = opts.maxLen ?? 10_000;
  if (s.length > max) s = s.slice(0, max);
  return s;
}

/** Apply sanitizeText to every string field in an object (one level
 *  deep). Used by route handlers that accept a body of mixed-type
 *  fields and want them all cleaned before persistence. */
export function sanitizeBody<T extends Record<string, unknown>>(body: T, opts: { maxLen?: number; skipKeys?: string[] } = {}): T {
  const skip = new Set(opts.skipKeys ?? []);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (skip.has(k)) { out[k] = v; continue; }
    if (typeof v === 'string') {
      out[k] = sanitizeText(v, { maxLen: opts.maxLen });
    } else if (Array.isArray(v)) {
      out[k] = v.map(item => typeof item === 'string' ? sanitizeText(item, { maxLen: opts.maxLen }) : item);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

// ── Global body sanitiser middleware ───────────────────────────────
//
// Recursive depth-first walk over the request body, applying:
//   * sanitizeText to every string leaf
//   * a depth + key-count cap to refuse pathological payloads
//     (deeply nested or wide-fanned objects burn CPU through every
//     downstream JSON serialiser; bound them at the boundary).
//
// Operates in-place on req.body so existing route handlers see the
// cleaned values without any code change. Body parser must have run
// first (`app.use(express.json())`); we tolerate non-object bodies
// (string, number, null) by no-oping.

const SANITISE_SKIP_PATHS = new Set<string>([
  // Keys whose values are expected to contain markup or formatting
  // that the sanitiser would over-aggressively strip. Markdown content
  // is rendered through an HTML-escaping pipeline downstream — let it
  // through here so embedded code blocks keep their fences.
  'content', 'description', 'message', 'aiAnalysis', 'aiRaw',
]);

interface SanitiseOptions {
  /** Max recursion depth. Default 6 (enough for nested config blobs,
   *  bounded enough to block GADGET payloads). */
  maxDepth?: number;
  /** Max keys per object. Default 200 — refuses gigamap exfil. */
  maxKeys?: number;
  /** Per-string length cap. Default 50_000 — large enough for KB
   *  article markdown, small enough to bound DB rows. */
  maxStringLen?: number;
}

export function sanitiseBodyMiddleware(opts: SanitiseOptions = {}) {
  const maxDepth = opts.maxDepth ?? 6;
  const maxKeys = opts.maxKeys ?? 200;
  const maxStringLen = opts.maxStringLen ?? 50_000;

  function visit(value: unknown, depth: number): unknown {
    if (value == null) return value;
    if (typeof value === 'string') {
      return sanitizeText(value, { maxLen: maxStringLen });
    }
    if (typeof value !== 'object') return value;
    if (depth >= maxDepth) {
      // Cut the recursion off — return shallow copy untouched at this
      // level. Doesn't reject the request, just stops walking.
      return value;
    }
    if (Array.isArray(value)) {
      // Cap array length to keep iteration bounded.
      const cap = Math.min(value.length, maxKeys);
      const out = new Array(cap);
      for (let i = 0; i < cap; i++) out[i] = visit(value[i], depth + 1);
      return out;
    }
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length > maxKeys) {
      // Refuse: return an empty object so downstream sees a parsable
      // shape but with no data. Logged at the handler level.
      return {};
    }
    const out: Record<string, unknown> = {};
    for (const k of keys) {
      // Skip-list: large markdown / freeform fields are passed
      // through with only the length cap applied (no sanitizeText).
      if (SANITISE_SKIP_PATHS.has(k) && typeof obj[k] === 'string') {
        const s = obj[k] as string;
        out[k] = s.length > maxStringLen ? s.slice(0, maxStringLen) : s;
        continue;
      }
      out[k] = visit(obj[k], depth + 1);
    }
    return out;
  }

  return (req: Request, _res: Response, next: NextFunction) => {
    if (req.body && typeof req.body === 'object') {
      try { req.body = visit(req.body, 0); } catch { /* leave body alone on failure */ }
    }
    next();
  };
}

// ── Shared atomic schemas — reuse across route schemas to keep error
//    messages consistent ("severity must be one of …") and reduce the
//    odds of one route accepting 'urgent' while another rejects it.

export const severitySchema = z.enum(['low', 'medium', 'high', 'critical']);
export const incidentStatusSchema = z.enum(['open', 'investigating', 'mitigating', 'resolved', 'closed']);
export const incidentSourceSchema = z.enum(['manual', 'alert-rule', 'agent']);

/** Pagination + sort shared by list endpoints. */
export const paginationSchema = z.object({
  limit:  z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).max(100_000).optional(),
  q:      z.string().max(200).optional(),
  sort:   z.enum(['asc', 'desc']).optional(),
});

/** ISO-8601 date-time validation — accepts both YYYY-MM-DDThh:mm:ssZ
 *  and lax extended forms used in some clients. */
export const isoDateTime = z.string().refine(
  s => !Number.isNaN(Date.parse(s)),
  { message: 'must be an ISO-8601 date-time' },
);

/** Free-form text field with a length cap and post-parse sanitisation.
 *  Use for descriptions, chat messages, KB content. */
export function textField(opts: { min?: number; max?: number } = {}) {
  const min = opts.min ?? 0;
  const max = opts.max ?? 10_000;
  return z.string().min(min).max(max).transform(s => sanitizeText(s, { maxLen: max }));
}

/** Title-ish field — non-empty, capped tighter, with sanitisation. */
export const titleField = textField({ min: 1, max: 200 });

/** Tag list — array of lowercase-ish tags. Caps the array length AND
 *  each tag length so tags do not act as a metadata exfil channel. */
export const tagsField = z.array(z.string().max(40)).max(20).optional();

/** ID-with-prefix validator. Pass the expected prefix (INC, AST, CHG, KB)
 *  and we will reject anything that does not match the full uppercase
 *  hex pattern. */
export function prefixedId(prefix: string) {
  const re = new RegExp(`^${prefix}-[A-F0-9]+$`);
  return z.string().regex(re, { message: `must look like ${prefix}-XXXXXXXX` });
}

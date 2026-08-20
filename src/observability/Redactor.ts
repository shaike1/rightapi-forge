// Redactor — removes sensitive values from objects bound for logs.
//
// Why a single helper instead of per-call sanitisation:
//   • The platform makes 1000s of log calls; auditing each for
//     accidental token/password leakage is unrealistic. A central pass
//     with a known key list keeps the rule simple.
//   • Long values (>200 chars) are abbreviated independent of the key
//     so a stack trace or huge JSON blob doesn't drown the JSON line.
//
// What it touches:
//   • Top-level + nested keys whose name matches the SENSITIVE_KEYS
//     pattern. Replaced with the string "[REDACTED]" (or
//     "[REDACTED:N]" when the original was a long string, so the
//     length is still visible for debugging).
//   • String values that *look like* a bearer token / API key are
//     redacted regardless of the key name. The heuristic catches the
//     common cases (eyJ… JWT, sk-… OpenAI keys, anthropic-… keys)
//     without false-positive flagging on normal identifiers.
//
// Performance:
//   • Walks the object recursively but stops at depth=6 to avoid
//     pathological cycles.
//   • Returns a new object when changes occur, otherwise returns the
//     input as-is so the common no-op path stays cheap.

const SENSITIVE_KEY_PATTERN = /(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|authorization|auth|cookie|session|bearer|credential|otp|pin|jwt)/i;

const JWT_LIKE        = /^eyJ[A-Za-z0-9_=-]+\.eyJ[A-Za-z0-9_=-]+\.[A-Za-z0-9_=-]+$/;
const OPENAI_KEY_LIKE = /^sk-[A-Za-z0-9_-]{20,}$/;
const ANTHROPIC_KEY_LIKE = /^sk-ant-[A-Za-z0-9_-]{20,}$/;
const ANTHROPIC_BEARER_LIKE = /^anthropic-[A-Za-z0-9_-]{20,}$/i;
const BASIC_AUTH_LIKE = /^Basic\s+[A-Za-z0-9+/=]{8,}$/i;

const MAX_DEPTH = 6;
const LONG_STRING_LIMIT = 1024;

/** Returns true when the supplied string looks like a credential we
 *  should never log. The heuristic is intentionally narrow: matches the
 *  common bearer / API key shapes; doesn't flag generic identifiers. */
export function looksLikeCredential(s: string): boolean {
  return JWT_LIKE.test(s)
      || OPENAI_KEY_LIKE.test(s)
      || ANTHROPIC_KEY_LIKE.test(s)
      || ANTHROPIC_BEARER_LIKE.test(s)
      || BASIC_AUTH_LIKE.test(s);
}

function redactString(v: string): string {
  if (looksLikeCredential(v)) {
    return `[REDACTED:${v.length}]`;
  }
  if (v.length > LONG_STRING_LIMIT) {
    return v.slice(0, LONG_STRING_LIMIT) + `…[+${v.length - LONG_STRING_LIMIT}]`;
  }
  return v;
}

function redactValue(value: unknown, key: string | null, depth: number): unknown {
  if (value == null) return value;
  if (depth >= MAX_DEPTH) return '[REDACTED:depth]';

  if (key && SENSITIVE_KEY_PATTERN.test(key)) {
    if (typeof value === 'string') return `[REDACTED:${value.length}]`;
    return '[REDACTED]';
  }

  if (typeof value === 'string') {
    return redactString(value);
  }
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map(v => {
      const next = redactValue(v, null, depth + 1);
      if (next !== v) changed = true;
      return next;
    });
    return changed ? out : value;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      const next = redactValue(v, k, depth + 1);
      if (next !== v) changed = true;
      out[k] = next;
    }
    return changed ? out : value;
  }
  return value;
}

/** Redact sensitive fields in-place-style: returns a new object when
 *  changes occur, otherwise returns the input. The "(no clone when
 *  unchanged)" rule keeps the cold path cheap for every log record
 *  that has no secrets. */
export function redact<T>(input: T): T {
  return redactValue(input, null, 0) as T;
}

/** Convenience for log payloads: ensures the result is an object suitable
 *  for spreading into a JSON record. Non-object inputs are wrapped under
 *  `value`. */
export function redactLogPayload(data: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (data == null) return data;
  return redact(data);
}

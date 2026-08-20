// Standard return shape for skill handlers.
//
// SkillManager dispatches handlers and contracts them to return Promise<string>.
// Skills historically returned ad-hoc prose strings like "Status: 200 OK\n\n…"
// or "Error: ENOENT" — fine for a human reading a chat, terrible for the ReAct
// loop, the agent memory store, and the runbook engine, all of which are
// happier with parseable JSON.
//
// This module gives skills a single shape:
//
//   interface SkillResult {
//     ok: boolean;
//     summary: string;     // one-line human-readable hint for the agent
//     data?: any;          // structured payload on success
//     error?: string;      // error message on failure
//   }
//
// Helpers ok()/fail() build a result object; encode() turns it into the
// JSON-stringified Promise<string> that SkillManager expects. Use
// `return encode(ok({…}, '<summary>'))` from a handler.

export interface SkillResult<T = unknown> {
  ok: boolean;
  summary: string;
  data?: T;
  error?: string;
}

export function ok<T>(data: T | undefined, summary: string): SkillResult<T> {
  return { ok: true, summary, data };
}

export function fail(error: string, summary?: string): SkillResult<never> {
  return { ok: false, summary: summary ?? error, error };
}

export function encode<T>(result: SkillResult<T>): string {
  return JSON.stringify(result, null, 2);
}

/**
 * Run an async block and convert its result/error into a SkillResult.
 * The block returns the data + summary; thrown errors become fail() results
 * with the message preserved.
 */
export async function runResult<T>(
  fn: () => Promise<{ data: T; summary: string }>,
  failSummary?: string
): Promise<string> {
  try {
    const { data, summary } = await fn();
    return encode(ok(data, summary));
  } catch (e: any) {
    const msg = e?.stderr?.toString?.()?.trim() || e?.message || String(e);
    return encode(fail(msg, failSummary));
  }
}

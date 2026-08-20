// PluginHttpClient — the implementation that backs `PluginContext.http`.
//
// Plugins MUST NOT call `fetch` directly. Going through this client gets
// them:
//   - A 10s default wall-clock timeout (overridable per-call).
//   - A User-Agent that names the plugin (helpful when reading remote logs).
//   - Non-2xx is `{ ok: false, status }` rather than a throw — every plugin
//     ends up writing the same defensive try/catch otherwise.
//   - Lazy body parsing so a plugin that only cares about the status code
//     never pays for the JSON parse.

import type { PluginHttp, PluginHttpOptions, PluginHttpResponse } from './PluginInterface.js';

const DEFAULT_TIMEOUT_MS = 10_000;

export function createPluginHttp(pluginId: string): PluginHttp {
  const ua = `itops-agents-plugin/${pluginId}`;
  function execute(method: string, url: string, body: unknown, opts?: PluginHttpOptions): Promise<PluginHttpResponse> {
    const controller = new AbortController();
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const t = setTimeout(() => controller.abort(), timeoutMs);
    const headers: Record<string, string> = {
      'user-agent': ua,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(opts?.headers ?? {}),
    };
    return fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    }).then(res => {
      clearTimeout(t);
      // Capture once — Response bodies can only be read once, so we
      // memoise the text representation lazily.
      let textPromise: Promise<string> | null = null;
      const text = () => {
        if (!textPromise) textPromise = res.text();
        return textPromise;
      };
      return {
        ok: res.ok,
        status: res.status,
        body: async () => {
          const raw = await text();
          if (!raw) return null;
          try { return JSON.parse(raw); } catch { return raw; }
        },
        text,
      } satisfies PluginHttpResponse;
    }, err => {
      clearTimeout(t);
      throw err;
    });
  }
  return {
    get:    (url, opts) => execute('GET', url, undefined, opts),
    post:   (url, body, opts) => execute('POST', url, body, opts),
    put:    (url, body, opts) => execute('PUT', url, body, opts),
    delete: (url, opts) => execute('DELETE', url, undefined, opts),
  };
}

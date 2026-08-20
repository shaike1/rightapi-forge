// Web/HTTP requests skill

import type { Skill } from '../types/index.js';
import axios, { type AxiosRequestConfig } from 'axios';
import { createWriteStream } from 'fs';
import { encode, ok, fail } from './SkillResult.js';

// Format an axios error into an actionable SkillResult-encoded string. Handles
// both responded-with-non-2xx (has err.response) and network failures (no
// response, but err.code present).
function axiosFail(action: string, err: unknown): string {
  if (axios.isAxiosError(err)) {
    if (err.response) {
      const detail = typeof err.response.data === 'string'
        ? err.response.data.slice(0, 300)
        : JSON.stringify(err.response.data).slice(0, 300);
      return encode(fail(
        `${action}: ${err.response.status} ${err.response.statusText} — ${detail}`,
        `${err.response.status} ${err.response.statusText}`
      ));
    }
    if (err.code) {
      return encode(fail(`${action}: ${err.code} — ${err.message}`, err.code));
    }
  }
  return encode(fail(`${action}: ${(err as Error)?.message ?? String(err)}`, action));
}

export class WebSkill {
  getSkill(): Skill {
    return {
      id: 'web',
      name: 'Web & HTTP Requests',
      description: 'Make HTTP requests, download files, check endpoints',
      category: 'monitoring',
      enabled: true,
      commands: [
        { name: 'web.get',      description: 'Make GET request',                       handler: 'webGet',      parameters: { url: 'string', headers: 'object', timeout: 'number' } },
        { name: 'web.post',     description: 'Make POST request',                      handler: 'webPost',     parameters: { url: 'string', data: 'object', headers: 'object' } },
        { name: 'web.put',      description: 'Make PUT request',                       handler: 'webPut',      parameters: { url: 'string', data: 'object', headers: 'object' } },
        { name: 'web.delete',   description: 'Make DELETE request',                    handler: 'webDelete',   parameters: { url: 'string', headers: 'object' } },
        { name: 'web.head',     description: 'Make HEAD request (get headers only)',   handler: 'webHead',     parameters: { url: 'string', headers: 'object' } },
        { name: 'web.status',   description: 'Check if URL is reachable',              handler: 'webStatus',   parameters: { url: 'string', timeout: 'number' } },
        { name: 'web.download', description: 'Download file from URL',                 handler: 'webDownload', parameters: { url: 'string', path: 'string' } },
        { name: 'web.json',     description: 'Parse JSON from URL (optional dot path)', handler: 'webJson',     parameters: { url: 'string', path: 'string' } }
      ]
    };
  }

  async webGet(params: { url: string; headers?: Record<string, string>; timeout?: number }): Promise<string> {
    if (!params?.url) return encode(fail('web.get requires { url }'));
    try {
      const config: AxiosRequestConfig = {
        timeout: params.timeout || 30000,
        headers: params.headers || {}
      };
      const response = await axios.get(params.url, config);
      return encode(ok(
        { status: response.status, statusText: response.statusText, body: response.data },
        `GET ${params.url} → ${response.status}`
      ));
    } catch (error) {
      return axiosFail(`GET ${params.url}`, error);
    }
  }

  async webPost(params: { url: string; data?: unknown; headers?: Record<string, string> }): Promise<string> {
    if (!params?.url) return encode(fail('web.post requires { url }'));
    try {
      const response = await axios.post(params.url, params.data || {}, {
        timeout: 30000,
        headers: { 'Content-Type': 'application/json', ...params.headers }
      });
      return encode(ok({ status: response.status, statusText: response.statusText, body: response.data }, `POST ${params.url} → ${response.status}`));
    } catch (error) {
      return axiosFail(`POST ${params.url}`, error);
    }
  }

  async webPut(params: { url: string; data?: unknown; headers?: Record<string, string> }): Promise<string> {
    if (!params?.url) return encode(fail('web.put requires { url }'));
    try {
      const response = await axios.put(params.url, params.data || {}, {
        timeout: 30000,
        headers: { 'Content-Type': 'application/json', ...params.headers }
      });
      return encode(ok({ status: response.status, statusText: response.statusText, body: response.data }, `PUT ${params.url} → ${response.status}`));
    } catch (error) {
      return axiosFail(`PUT ${params.url}`, error);
    }
  }

  async webDelete(params: { url: string; headers?: Record<string, string> }): Promise<string> {
    if (!params?.url) return encode(fail('web.delete requires { url }'));
    try {
      const response = await axios.delete(params.url, { timeout: 30000, headers: params.headers || {} });
      return encode(ok({ status: response.status, statusText: response.statusText }, `DELETE ${params.url} → ${response.status}`));
    } catch (error) {
      return axiosFail(`DELETE ${params.url}`, error);
    }
  }

  async webHead(params: { url: string; headers?: Record<string, string> }): Promise<string> {
    if (!params?.url) return encode(fail('web.head requires { url }'));
    try {
      const response = await axios.head(params.url, { timeout: 30000, headers: params.headers || {} });
      return encode(ok({ status: response.status, statusText: response.statusText, headers: response.headers }, `HEAD ${params.url} → ${response.status}`));
    } catch (error) {
      return axiosFail(`HEAD ${params.url}`, error);
    }
  }

  async webStatus(params: { url: string; timeout?: number }): Promise<string> {
    if (!params?.url) return encode(fail('web.status requires { url }'));
    try {
      const response = await axios.head(params.url, { timeout: params.timeout || 10000, method: 'HEAD' });
      return encode(ok({ url: params.url, reachable: true, status: response.status, statusText: response.statusText }, `${params.url} reachable (${response.status})`));
    } catch (error) {
      const msg = (error as Error).message;
      return encode(ok({ url: params.url, reachable: false, status: null, statusText: null, error: msg }, `${params.url} unreachable`));
    }
  }

  async webDownload(params: { url: string; path: string }): Promise<string> {
    if (!params?.url || !params?.path) return encode(fail('web.download requires { url, path }'));
    // Fixed: previously the catch path returned a string while the success path
    // returned a Promise<string> from inside an async function — TS inferred a
    // nested-Promise return that only resolved correctly half the time. Now we
    // await a single Promise that resolves with the SkillResult JSON string.
    try {
      const response = await axios({
        method: 'get',
        url: params.url,
        responseType: 'stream',
        timeout: 60000
      });

      const writer = createWriteStream(params.path);
      let bytesWritten = 0;
      response.data.on('data', (chunk: Buffer) => { bytesWritten += chunk.length; });
      response.data.pipe(writer);

      return await new Promise<string>((resolve) => {
        writer.on('finish', () => resolve(encode(ok({ url: params.url, path: params.path, bytes: bytesWritten }, `downloaded ${bytesWritten} bytes → ${params.path}`))));
        writer.on('error', (err: Error) => resolve(encode(fail(`writing to ${params.path}: ${err.message}`, 'write failed'))));
      });
    } catch (error) {
      return axiosFail(`downloading ${params.url}`, error);
    }
  }

  async webJson(params: { url: string; path?: string }): Promise<string> {
    if (!params?.url) return encode(fail('web.json requires { url }'));
    try {
      const response = await axios.get(params.url, { timeout: 30000 });
      let data = response.data;
      if (params.path) {
        const keys = params.path.split('.');
        for (const key of keys) {
          if (data == null) break;
          data = data[key];
        }
      }
      return encode(ok({ url: params.url, jsonPath: params.path ?? null, value: data }, `parsed JSON from ${params.url}`));
    } catch (error) {
      return axiosFail(`fetching JSON from ${params.url}`, error);
    }
  }
}

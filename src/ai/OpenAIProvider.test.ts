import assert from 'node:assert/strict';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import test from 'node:test';
import { OpenAIProvider } from './openai.js';

test('OpenAIProvider uses the configured compatible endpoint and model', async () => {
  let requestBody: any;
  let authorization = '';
  const server = http.createServer((req, res) => {
    authorization = String(req.headers.authorization || '');
    let body = '';
    req.on('data', chunk => {
      body += chunk;
    });
    req.on('end', () => {
      requestBody = JSON.parse(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        created: 1,
        model: requestBody.model,
        choices: [{
          index: 0,
          finish_reason: 'stop',
          message: { role: 'assistant', content: 'CODEX_OK' }
        }],
        usage: {
          prompt_tokens: 3,
          completion_tokens: 2,
          total_tokens: 5
        }
      }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));

  try {
    const port = (server.address() as AddressInfo).port;
    const provider = new OpenAIProvider('router-key', {
      baseURL: `http://127.0.0.1:${port}/v1`,
      model: 'codex'
    });
    await provider.initialize();
    const response = await provider.chat({
      messages: [{ role: 'user', content: 'health check' }],
      maxTokens: 16,
      temperature: 0
    });

    assert.equal(authorization, 'Bearer router-key');
    assert.equal(requestBody.model, 'codex');
    assert.equal(requestBody.max_tokens, 16);
    assert.equal(requestBody.temperature, 0);
    assert.equal(response.content, 'CODEX_OK');
    assert.equal(response.model, 'codex');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('OpenAIProvider falls back after a primary failure and exposes route health', async () => {
  const primary = http.createServer((_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { type: 'authentication_error', message: 'invalid key' } }));
  });
  const fallback = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        model: parsed.model,
        choices: [{ message: { role: 'assistant', content: 'FALLBACK_OK' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
    });
  });
  await new Promise<void>(resolve => primary.listen(0, '127.0.0.1', resolve));
  await new Promise<void>(resolve => fallback.listen(0, '127.0.0.1', resolve));
  try {
    const provider = new OpenAIProvider('key', {
      baseURL: `http://127.0.0.1:${(primary.address() as AddressInfo).port}/v1`,
      model: 'gpt-5.6-sol', expectedModel: 'gpt-5.6-sol',
      fallbackBaseURL: `http://127.0.0.1:${(fallback.address() as AddressInfo).port}/v1`,
      fallbackModel: 'best-chat', fallbackExpectedModel: 'best-chat',
      failureThreshold: 1,
    });
    await provider.initialize();
    const response = await provider.chat({ messages: [{ role: 'user', content: 'test' }] });
    assert.equal(response.content, 'FALLBACK_OK');
    assert.equal(provider.getActiveRoute(), 'fallback');
    const health = provider.getRouteHealth();
    assert.equal(health[0].breaker.state, 'OPEN');
    assert.equal(health[0].failures, 1);
    assert.equal(health[1].successes, 1);
  } finally {
    await new Promise<void>(resolve => primary.close(() => resolve()));
    await new Promise<void>(resolve => fallback.close(() => resolve()));
  }
});

test('OpenAIProvider fails closed and opens its breaker on route/model mismatch', async () => {
  const provider = new OpenAIProvider('key', {
    baseURL: 'http://127.0.0.1:1/v1', model: 'claude-first', expectedModel: 'gpt-5.6-sol', failureThreshold: 1,
  });
  await provider.initialize();
  await assert.rejects(() => provider.chat({ messages: [{ role: 'user', content: 'test' }] }), /route\/model mismatch/);
  assert.equal(provider.getRouteHealth()[0].breaker.state, 'OPEN');
});

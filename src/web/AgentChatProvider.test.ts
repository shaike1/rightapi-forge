import assert from 'node:assert/strict';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import test from 'node:test';
import { callChatCompletionsAPI } from './agentChatApi.js';

test('agent chat uses the configured OpenAI-compatible chat endpoint', async () => {
  let requestUrl = '';
  let authorization = '';
  let requestBody: any;
  const server = http.createServer((req, res) => {
    requestUrl = req.url || '';
    authorization = String(req.headers.authorization || '');
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      requestBody = JSON.parse(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'CODEX_CHAT_OK' } }],
      }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));

  try {
    const port = (server.address() as AddressInfo).port;
    const response = await callChatCompletionsAPI(
      `http://127.0.0.1:${port}/v1/`,
      'router-key',
      'gpt-5.6-sol',
      'System instructions',
      'User request',
      512,
    );

    assert.equal(requestUrl, '/v1/chat/completions');
    assert.equal(authorization, 'Bearer router-key');
    assert.equal(requestBody.model, 'gpt-5.6-sol');
    assert.equal(requestBody.stream, false);
    assert.equal(requestBody.max_tokens, 512);
    assert.deepEqual(requestBody.messages, [
      { role: 'system', content: 'System instructions' },
      { role: 'user', content: 'User request' },
    ]);
    assert.equal(response, 'CODEX_CHAT_OK');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

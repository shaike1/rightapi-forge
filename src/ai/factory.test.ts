import assert from 'node:assert/strict';
import test from 'node:test';
import { AIProviderFactory } from './factory.js';

test('default provider honors the ITOPS preferred platform', async () => {
  const factory = new AIProviderFactory(
    { anthropicApiKey: 'bad-legacy-key', openaiApiKey: 'router-key' },
    { preferredPlatform: 'openai' },
  );
  assert.equal((await factory.getDefaultProvider()).name, 'openai');
});

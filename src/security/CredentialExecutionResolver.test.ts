import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { CredentialCatalogStore } from './CredentialCatalogStore.js';
import { CredentialExecutionResolver } from './CredentialExecutionResolver.js';

function tempFile(name: string): string {
  return path.join(os.tmpdir(), `itops-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
}

test('credential resolver denies when mapping is missing or mismatched', () => {
  const filePath = tempFile('credential-catalog');
  const store = new CredentialCatalogStore(filePath);
  const resolver = new CredentialExecutionResolver(store);

  const result = resolver.resolve({
    agentId: 'agent-a',
    environment: 'prod',
    system: 'm365',
    requiredScopes: ['mail.read'],
    providedCredentialScopes: ['mail.read']
  });

  assert.equal(result.allowed, false);
  assert.match(result.reason || '', /No credential mapping found|mismatch/i);
  fs.rmSync(filePath, { force: true });
});

test('credential resolver allows active exact mapping and scope', () => {
  const filePath = tempFile('credential-catalog');
  const store = new CredentialCatalogStore(filePath);
  store.create({
    name: 'M365 Reader',
    agentId: 'agent-a',
    environment: 'prod',
    system: 'm365',
    scope: 'mail.read',
    active: true
  });
  const resolver = new CredentialExecutionResolver(store);

  const result = resolver.resolve({
    agentId: 'agent-a',
    environment: 'prod',
    system: 'm365',
    requiredScopes: ['mail.read'],
    providedCredentialScopes: ['mail.read']
  });

  assert.equal(result.allowed, true);
  assert.equal(result.matchedEntryIds.length, 1);
  fs.rmSync(filePath, { force: true });
});

test('resolve() returns allow when no required scopes (permissive default)', () => {
  const filePath = tempFile('credential-catalog');
  const store = new CredentialCatalogStore(filePath);
  const resolver = new CredentialExecutionResolver(store);

  const result = resolver.resolve({
    agentId: 'agent-x',
    environment: 'dev',
    system: 'slack',
    requiredScopes: [],
    providedCredentialScopes: []
  });

  assert.equal(result.allowed, true);
  assert.deepEqual(result.matchedEntryIds, []);
  assert.deepEqual(result.requiredScopes, []);
  fs.rmSync(filePath, { force: true });
});

test('resolve() returns deny when catalog entry exists but scope does not match', () => {
  const filePath = tempFile('credential-catalog');
  const store = new CredentialCatalogStore(filePath);
  store.create({
    name: 'Slack Writer',
    agentId: 'agent-b',
    environment: 'prod',
    system: 'slack',
    scope: 'chat.write',
    active: true
  });
  const resolver = new CredentialExecutionResolver(store);

  const result = resolver.resolve({
    agentId: 'agent-b',
    environment: 'prod',
    system: 'slack',
    requiredScopes: ['chat.write'],
    providedCredentialScopes: ['chat.read']
  });

  assert.equal(result.allowed, false);
  assert.ok(result.reason);
  assert.ok(result.reason!.includes('scope') || result.reason!.includes('mismatch'));
  fs.rmSync(filePath, { force: true });
});

test('resolve() returns allow when catalog entry matches agentId/environment/system/scope', () => {
  const filePath = tempFile('credential-catalog');
  const store = new CredentialCatalogStore(filePath);
  store.create({
    name: 'GitHub Read',
    agentId: 'agent-c',
    environment: 'staging',
    system: 'github',
    scope: 'repo.read',
    active: true
  });
  store.create({
    name: 'GitHub Write',
    agentId: 'agent-c',
    environment: 'staging',
    system: 'github',
    scope: 'repo.write',
    active: true
  });
  const resolver = new CredentialExecutionResolver(store);

  const result = resolver.resolve({
    agentId: 'agent-c',
    environment: 'staging',
    system: 'github',
    requiredScopes: ['repo.read', 'repo.write'],
    providedCredentialScopes: ['repo.read', 'repo.write']
  });

  assert.equal(result.allowed, true);
  assert.equal(result.matchedEntryIds.length, 2);
  assert.deepEqual(result.requiredScopes, ['repo.read', 'repo.write']);
  fs.rmSync(filePath, { force: true });
});

test('resolve() returns matchedEntryIds in allow result', () => {
  const filePath = tempFile('credential-catalog');
  const store = new CredentialCatalogStore(filePath);
  const entry = store.create({
    name: 'JIRA Access',
    agentId: 'agent-d',
    environment: 'prod',
    system: 'jira',
    scope: 'issue.read',
    active: true
  });
  const resolver = new CredentialExecutionResolver(store);

  const result = resolver.resolve({
    agentId: 'agent-d',
    environment: 'prod',
    system: 'jira',
    requiredScopes: ['issue.read'],
    providedCredentialScopes: ['issue.read']
  });

  assert.equal(result.allowed, true);
  assert.equal(result.matchedEntryIds.length, 1);
  assert.equal(result.matchedEntryIds[0], entry.id);
  fs.rmSync(filePath, { force: true });
});

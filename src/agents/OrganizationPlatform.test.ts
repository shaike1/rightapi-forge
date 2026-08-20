import assert from 'node:assert/strict';
import test from 'node:test';
import { OrganizationManager } from './Organization.js';
import type { AIProviderFactory } from '../ai/factory.js';

test('setAllAgentPlatforms updates active agents and persisted organization configs', async () => {
  const organization = new OrganizationManager(
    'IT Ops Team',
    {} as AIProviderFactory
  );
  await organization.createDirector('claude');
  await organization.createSysAdmin('Ops One', 'claude');
  await organization.createSpecialist('DB One', 'database', 'claude');

  const changed = organization.setAllAgentPlatforms('openai');

  assert.equal(changed, 3);
  assert.ok(organization.getAllAgents().every(agent => agent.config.aiPlatform === 'openai'));
  const persisted = organization.getOrganization();
  assert.equal(persisted.director.aiPlatform, 'openai');
  assert.ok(persisted.sysadmins.every(agent => agent.aiPlatform === 'openai'));
  assert.ok(persisted.specialists.every(agent => agent.aiPlatform === 'openai'));
});

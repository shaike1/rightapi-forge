import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { SqliteTenantStore } from './TenantStore.js';
import { OnboardingService } from './OnboardingService.js';

function tmpStack() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'itops-onb-'));
  const tenants = new SqliteTenantStore(path.join(dir, 't.db'));
  tenants.upsert({ id: 'acme', slug: 'acme', name: 'Acme', plan: 'free' });
  const onb = new OnboardingService(tenants);
  return { dir, tenants, onb };
}

test('OnboardingService.status returns a default state on a fresh tenant', async () => {
  const { onb } = tmpStack();
  const s = await onb.status('acme');
  assert.equal(s.state.completed, false);
  assert.equal(s.state.currentStep, 1);
  assert.equal(s.nextStep, 'welcome');
});

test('saveStep advances the cursor and stores the payload', async () => {
  const { onb } = tmpStack();
  await onb.saveStep('acme', 'welcome', { orgName: 'Acme', timezone: 'America/Los_Angeles' });
  const s = await onb.status('acme');
  assert.equal(s.state.currentStep, 1);  // step number 1 = welcome
  assert.equal(s.state.steps?.welcome?.timezone, 'America/Los_Angeles');
  await onb.saveStep('acme', 'servers', { count: 3 });
  const s2 = await onb.status('acme');
  assert.equal(s2.state.currentStep, 2);
  assert.equal(s2.nextStep, 'servers');
});

test('saveStep done flips the completed flag and stamps completedAt', async () => {
  const { onb } = tmpStack();
  await onb.saveStep('acme', 'done', {});
  const s = await onb.status('acme');
  assert.equal(s.state.completed, true);
  assert.ok(s.state.completedAt);
  assert.equal(s.nextStep, 'done');
});

test('reset returns onboarding to step 1 incomplete', async () => {
  const { onb } = tmpStack();
  await onb.saveStep('acme', 'done', {});
  await onb.reset('acme');
  const s = await onb.status('acme');
  assert.equal(s.state.completed, false);
  assert.equal(s.state.currentStep, 1);
});

test('saveStep is idempotent — re-saving the same step keeps the cursor', async () => {
  const { onb } = tmpStack();
  await onb.saveStep('acme', 'servers', { count: 1 });
  await onb.saveStep('acme', 'welcome', { orgName: 'late edit' });
  const s = await onb.status('acme');
  // Cursor must not regress to welcome's step number.
  assert.equal(s.state.currentStep, 2);
  // Welcome data is updated even though we'd already advanced past it.
  assert.equal(s.state.steps?.welcome?.orgName, 'late edit');
});

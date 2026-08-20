import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getCurrentTenantId,
  getCurrentTenant,
  runWithTenant,
  SYSTEM_TENANT_ID,
} from './TenantContext.js';

test('outside any scope, getCurrentTenantId falls back to system', () => {
  assert.equal(getCurrentTenantId(), SYSTEM_TENANT_ID);
  assert.equal(getCurrentTenant(), undefined);
});

test('runWithTenant exposes the active tenant for the duration of the callback', async () => {
  const seen: string[] = [];
  await runWithTenant({ tenantId: 'acme', tenantName: 'Acme Corp' }, async () => {
    seen.push(getCurrentTenantId());
    await new Promise(r => setTimeout(r, 10));
    seen.push(getCurrentTenantId());
  });
  assert.deepEqual(seen, ['acme', 'acme']);
  // Outside the scope we're back to system.
  assert.equal(getCurrentTenantId(), SYSTEM_TENANT_ID);
});

test('runWithTenant nests correctly — inner scope wins until it exits', async () => {
  const trail: string[] = [];
  await runWithTenant({ tenantId: 'outer' }, async () => {
    trail.push(getCurrentTenantId());
    await runWithTenant({ tenantId: 'inner' }, async () => {
      trail.push(getCurrentTenantId());
    });
    trail.push(getCurrentTenantId());
  });
  assert.deepEqual(trail, ['outer', 'inner', 'outer']);
});

test('runWithTenant context survives Promise chains', async () => {
  let observed: string | undefined;
  await runWithTenant({ tenantId: 'beta' }, async () => {
    await Promise.resolve()
      .then(() => Promise.resolve())
      .then(() => { observed = getCurrentTenantId(); });
  });
  assert.equal(observed, 'beta');
});

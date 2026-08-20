import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { CredentialVault } from './CredentialVault.js';

function withTempVault(run: (filePath: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'itops-vault-test-'));
  try {
    run(path.join(dir, 'credentials.vault.json'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('credential vault rotates master key and preserves secrets', () => {
  withTempVault(filePath => {
    const vault = new CredentialVault(filePath, 'master-key-before-0123456789012345678901234567');
    const created = vault.upsert({
      agentId: 'agent-1',
      name: 'ssh',
      scope: 'shell.exec',
      secret: 'secret-value-1'
    });

    assert.equal(vault.resolveSecret(created.id), 'secret-value-1');

    const rotated = vault.rotateMasterKey('master-key-after-012345678901234567890123456789');
    assert.equal(rotated.recordsReencrypted, 1);
    assert.equal(vault.resolveSecret(created.id), 'secret-value-1');

    assert.throws(
      () => vault.rotateMasterKey('master-key-after-012345678901234567890123456789'),
      /must differ/
    );
  });
});

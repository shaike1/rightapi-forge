import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { AuthService } from './AuthService.js';

function tempFile(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'itops-auth-test-'));
  return path.join(dir, name);
}

test('delegation permissions are enforced by role map', () => {
  const auth = new AuthService({
    tokenSecret: 'test-secret-test-secret-test-secret',
    usersFilePath: tempFile('users.json'),
    bootstrapUsers: [
      { username: 'admin', password: 'Admin-Pass-1234', role: 'admin' },
      { username: 'operator', password: 'Operator-Pass-1234', role: 'operator' },
      { username: 'viewer', password: 'Viewer-Pass-1234', role: 'viewer' }
    ]
  });

  assert.equal(auth.hasPermission('admin', 'delegations.read'), true);
  assert.equal(auth.hasPermission('admin', 'delegations.write'), true);
  assert.equal(auth.hasPermission('operator', 'delegations.read'), true);
  assert.equal(auth.hasPermission('operator', 'delegations.write'), true);
  assert.equal(auth.hasPermission('viewer', 'delegations.read'), true);
  assert.equal(auth.hasPermission('viewer', 'delegations.write'), false);
});

test('issueToken accepts usernames case insensitively', () => {
  const filename = tempFile('case-users.json');
  const auth = new AuthService({
    tokenSecret: 'case-secret',
    usersFilePath: filename,
    bootstrapUsers: [
      { username: 'CaseUser', password: 'Case-Pass-1234', role: 'operator' }
    ]
  });

  const token = auth.issueToken('caseuser', 'Case-Pass-1234');
  assert.ok(token);
  assert.equal(token?.username, 'CaseUser');
  assert.ok(auth.issueToken('CASEUSER', 'Case-Pass-1234'));
});

test('bootstrap email lands on the user record and is returned by listUsers/getUser', () => {
  const auth = new AuthService({
    tokenSecret: 'email-secret',
    usersFilePath: tempFile('email-users.json'),
    bootstrapUsers: [
      { username: 'shaike', password: 'Pass-1234567', role: 'admin', email: 'shaike@me.com' },
    ],
  });
  const list = auth.listUsers();
  assert.equal(list[0].email, 'shaike@me.com');
  const view = auth.getUser('shaike');
  assert.ok(view);
  assert.equal(view!.email, 'shaike@me.com');
  assert.equal(view!.role, 'admin');
});

test('bootstrap is create-if-missing — does not overwrite operator-changed password', () => {
  const file = tempFile('bootstrap-skip.json');
  const a1 = new AuthService({
    tokenSecret: 'sec',
    usersFilePath: file,
    bootstrapUsers: [{ username: 'admin', password: 'first-Pass-1', role: 'admin' }],
  });
  // Simulate an operator rotating the password via the API.
  a1.updateUser('admin', { password: 'rotated-Pass-2' });
  // New process starts with the env still set to the old password.
  const a2 = new AuthService({
    tokenSecret: 'sec',
    usersFilePath: file,
    bootstrapUsers: [{ username: 'admin', password: 'first-Pass-1', role: 'admin' }],
  });
  // The rotated password must still work; the env password must not.
  assert.ok(a2.issueToken('admin', 'rotated-Pass-2'), 'rotated password should still authenticate');
  assert.equal(a2.issueToken('admin', 'first-Pass-1'), null, 'env-provided password must not overwrite the rotated one');
});

test('updateUser allows setting and clearing the email without touching the password', () => {
  const auth = new AuthService({
    tokenSecret: 'sec', usersFilePath: tempFile('upd.json'),
    bootstrapUsers: [{ username: 'u', password: 'pw-1234567', role: 'operator' }],
  });
  auth.updateUser('u', { email: 'u@example.com' });
  assert.equal(auth.getUser('u')!.email, 'u@example.com');
  // Empty string explicitly clears it (used by the PATCH route for email:null).
  auth.updateUser('u', { email: '' });
  assert.equal(auth.getUser('u')!.email, '');
  // Original password still works.
  assert.ok(auth.issueToken('u', 'pw-1234567'));
});

test('refreshToken issues a fresh JWT for a valid token without re-prompting password', async () => {
  const auth = new AuthService({
    tokenSecret: 'refresh-secret',
    usersFilePath: tempFile('refresh-users.json'),
    bootstrapUsers: [{ username: 'shaike', password: 'Pass-1234567', role: 'admin' }],
  });
  const first = auth.issueToken('shaike', 'Pass-1234567');
  assert.ok(first);
  // Sleep so iat differs and the new token isn't byte-identical.
  await new Promise(r => setTimeout(r, 1100));
  const refreshed = auth.refreshToken(first!.token);
  assert.ok(refreshed);
  assert.equal(refreshed!.username, 'shaike');
  assert.equal(refreshed!.role, 'admin');
  assert.notEqual(refreshed!.token, first!.token, 'refresh should return a new token, not echo the old one');
  // The new token validates.
  const v = auth.validateToken(refreshed!.token);
  assert.equal(v.valid, true);
});

test('refreshToken rejects garbage tokens and tokens signed by a different secret', () => {
  const a = new AuthService({
    tokenSecret: 'A', usersFilePath: tempFile('a.json'),
    bootstrapUsers: [{ username: 'u', password: 'pw-1234567', role: 'operator' }],
  });
  const b = new AuthService({
    tokenSecret: 'B', usersFilePath: tempFile('b.json'),
    bootstrapUsers: [{ username: 'u', password: 'pw-1234567', role: 'operator' }],
  });
  const tokenFromB = b.issueToken('u', 'pw-1234567')!.token;
  assert.equal(a.refreshToken(tokenFromB), null, 'cross-secret refresh must be refused');
  assert.equal(a.refreshToken('not.a.token'), null);
  assert.equal(a.refreshToken(''), null);
});

test('refreshToken refuses to mint a session for a deleted user', () => {
  const auth = new AuthService({
    tokenSecret: 's', usersFilePath: tempFile('del.json'),
    bootstrapUsers: [{ username: 'gone', password: 'pw-1234567', role: 'viewer' }],
  });
  const token = auth.issueToken('gone', 'pw-1234567')!.token;
  auth.deleteUser('gone');
  assert.equal(auth.refreshToken(token), null);
});

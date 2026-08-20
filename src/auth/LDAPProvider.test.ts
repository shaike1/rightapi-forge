import assert from 'node:assert/strict';
import test from 'node:test';
import type { ClientOptions, Entry, SearchOptions } from 'ldapts';
import { LDAPProvider, ldapEscape, type LDAPConfig } from './LDAPProvider.js';

const config: LDAPConfig = {
  url: 'ldap://directory.example.com:389',
  bindDN: 'CN=service,DC=example,DC=com',
  bindPassword: 'service-secret',
  baseDN: 'DC=example,DC=com',
};

test('ldapEscape encodes every RFC 4515 special character', () => {
  assert.equal(ldapEscape('a*(b)\\c\0'), 'a\\2a\\28b\\29\\5cc\\00');
});

test('authenticate maps an ldapts entry, escapes the filter, and unbinds both clients', async () => {
  const service = new FakeClient([{
    dn: 'CN=Alice,OU=Users,DC=example,DC=com',
    sAMAccountName: 'alice',
    displayName: 'Alice Admin',
    mail: 'alice@example.com',
    memberOf: ['CN=IT-Admins,OU=Groups,DC=example,DC=com', 'CN=Operators,OU=Groups,DC=example,DC=com'],
  }]);
  const user = new FakeClient();
  const clients = [service, user];
  const provider = new LDAPProvider(config, () => clients.shift()! as any);

  const result = await provider.authenticate('ali*ce', 'user-secret');

  assert.deepEqual(result, {
    dn: 'CN=Alice,OU=Users,DC=example,DC=com',
    username: 'alice',
    displayName: 'Alice Admin',
    email: 'alice@example.com',
    groups: ['IT-Admins', 'Operators'],
  });
  assert.equal(service.searchOptions?.filter, '(sAMAccountName=ali\\2ace)');
  assert.deepEqual(service.binds, [[config.bindDN, config.bindPassword]]);
  assert.deepEqual(user.binds, [[result!.dn, 'user-secret']]);
  assert.equal(service.unbindCount, 1);
  assert.equal(user.unbindCount, 1);
});

test('authenticate returns null when the user bind fails and still closes the client', async () => {
  const service = new FakeClient([{ dn: 'CN=Alice,DC=example,DC=com', sAMAccountName: 'alice' }]);
  const user = new FakeClient([], true);
  const clients = [service, user];
  const provider = new LDAPProvider(config, () => clients.shift()! as any);

  assert.equal(await provider.authenticate('alice', 'wrong'), null);
  assert.equal(service.unbindCount, 1);
  assert.equal(user.unbindCount, 1);
});

test('tlsEnabled upgrades ldap connections before binding', async () => {
  const client = new FakeClient();
  const provider = new LDAPProvider(
    { ...config, tlsEnabled: true, tlsRejectUnauthorized: false },
    (_options: ClientOptions) => client as any,
  );

  assert.deepEqual(await provider.testConnection(), { ok: true, message: 'LDAP bind successful' });
  assert.deepEqual(client.events, ['startTLS:false', `bind:${config.bindDN}`, 'unbind']);
});

class FakeClient {
  binds: Array<[string, string | undefined]> = [];
  events: string[] = [];
  searchOptions?: SearchOptions;
  unbindCount = 0;

  constructor(private entries: Entry[] = [], private rejectBind = false) {}

  async startTLS(options?: { rejectUnauthorized?: boolean }): Promise<void> {
    this.events.push(`startTLS:${options?.rejectUnauthorized ?? true}`);
  }

  async bind(dn: string, password?: string): Promise<void> {
    this.events.push(`bind:${dn}`);
    this.binds.push([dn, password]);
    if (this.rejectBind) throw new Error('invalid credentials');
  }

  async search(_baseDN: string, options?: SearchOptions): Promise<{ searchEntries: Entry[]; searchReferences: string[] }> {
    this.searchOptions = options;
    return { searchEntries: this.entries, searchReferences: [] };
  }

  async unbind(): Promise<void> {
    this.events.push('unbind');
    this.unbindCount += 1;
  }
}

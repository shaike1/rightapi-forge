/**
 * LDAPProvider — on-premises Active Directory authentication via ldapts
 *
 * Flow:
 *   1. Bind with service account (read-only) to search for the user DN
 *   2. Re-bind with the user's DN + supplied password to validate credentials
 *   3. Query memberOf to return group DNs for role mapping
 */

import { Client, type ClientOptions, type Entry, type SearchOptions } from 'ldapts';

export interface LDAPConfig {
  url: string;           // e.g. ldap://dc01.corp.local or ldaps://dc01.corp.local:636
  bindDN: string;        // service account DN, e.g. CN=svc-itops,OU=ServiceAccounts,DC=corp,DC=local
  bindPassword: string;
  baseDN: string;        // user search base, e.g. DC=corp,DC=local
  userFilter?: string;   // default: (sAMAccountName={{username}})
  groupAttribute?: string; // default: memberOf
  tlsEnabled?: boolean;  // force TLS even on non-636 port
  tlsRejectUnauthorized?: boolean; // default true; set false for self-signed certs
  timeout?: number;      // ms, default 5000
}

export interface LDAPUserInfo {
  dn: string;
  username: string;
  displayName: string;
  email: string;
  groups: string[];      // array of group CNs (not full DNs)
}

/** Escape special characters in LDAP filter values per RFC 4515 */
export function ldapEscape(value: string): string {
  return value.replace(/[\\*()\x00]/g, c => '\\' + c.charCodeAt(0).toString(16).padStart(2, '0'));
}

type LDAPClient = Pick<Client, 'startTLS' | 'bind' | 'search' | 'unbind'>;
type LDAPClientFactory = (options: ClientOptions) => LDAPClient;

export class LDAPProvider {
  constructor(
    private config: LDAPConfig,
    private clientFactory: LDAPClientFactory = options => new Client(options),
  ) {}

  private createClient(): LDAPClient {
    const tlsOptions = this.config.tlsRejectUnauthorized === false
      ? { rejectUnauthorized: false }
      : undefined;

    return this.clientFactory({
      url: this.config.url,
      timeout: this.config.timeout ?? 5000,
      connectTimeout: this.config.timeout ?? 5000,
      tlsOptions,
    });
  }

  private async bindClient(client: LDAPClient, dn: string, password: string): Promise<void> {
    if (this.config.tlsEnabled && this.config.url.toLowerCase().startsWith('ldap://')) {
      const tlsOptions = this.config.tlsRejectUnauthorized === false
        ? { rejectUnauthorized: false }
        : undefined;
      await client.startTLS(tlsOptions);
    }
    await client.bind(dn, password);
  }

  /** Bind the service account and search for the user's DN */
  private async findUserDN(username: string): Promise<LDAPUserInfo | null> {
    const client = this.createClient();
    try {
      await this.bindClient(client, this.config.bindDN, this.config.bindPassword);

      const filter = (this.config.userFilter ?? '(sAMAccountName={{username}})')
        .replace('{{username}}', ldapEscape(username));
      const groupAttribute = this.config.groupAttribute ?? 'memberOf';
      const opts: SearchOptions = {
        filter,
        scope: 'sub',
        attributes: ['dn', 'sAMAccountName', 'displayName', 'mail', groupAttribute, 'cn'],
      };
      const { searchEntries } = await client.search(this.config.baseDN, opts);
      if (searchEntries.length === 0) return null;

      const entry = searchEntries[0];
      const attr = (name: string): string => attributeValues(entry, name)[0] ?? '';
      const groups = attributeValues(entry, groupAttribute).map(dn => {
        const match = dn.match(/^CN=([^,]+)/i);
        return match ? match[1] : dn;
      });

      return {
        dn: entry.dn,
        username: attr('sAMAccountName') || username,
        displayName: attr('displayName') || attr('cn') || username,
        email: attr('mail'),
        groups,
      };
    } finally {
      await client.unbind().catch(() => undefined);
    }
  }

  /** Re-bind as the user to validate their password */
  private async validateBind(userDN: string, password: string): Promise<boolean> {
    const client = this.createClient();
    try {
      await this.bindClient(client, userDN, password);
      return true;
    } catch {
      return false;
    } finally {
      await client.unbind().catch(() => undefined);
    }
  }

  /**
   * Authenticate a user against AD.
   * Returns user info on success, null on invalid credentials, throws on connection error.
   */
  async authenticate(username: string, password: string): Promise<LDAPUserInfo | null> {
    if (!password) return null;

    const userInfo = await this.findUserDN(username);
    if (!userInfo) return null;

    const valid = await this.validateBind(userInfo.dn, password);
    if (!valid) return null;

    return userInfo;
  }

  /** Test connectivity and service account bind — used by the settings UI */
  async testConnection(): Promise<{ ok: boolean; message: string }> {
    let client: LDAPClient | undefined;
    try {
      client = this.createClient();
      await this.bindClient(client, this.config.bindDN, this.config.bindPassword);
      return { ok: true, message: 'LDAP bind successful' };
    } catch (err: any) {
      return { ok: false, message: err?.message ?? String(err) };
    } finally {
      await client?.unbind().catch(() => undefined);
    }
  }
}

function attributeValues(entry: Entry, name: string): string[] {
  const key = Object.keys(entry).find(candidate => candidate.toLowerCase() === name.toLowerCase());
  if (!key) return [];
  const raw = entry[key];
  const values = Array.isArray(raw) ? raw : [raw];
  return values.map(value => Buffer.isBuffer(value) ? value.toString('utf8') : String(value));
}

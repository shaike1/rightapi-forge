import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { PluginConfigEncryption } from '../plugins/PluginConfigEncryption.js';
import { applyStandardPragmas } from '../utils/SqlitePragmas.js';

const connectionInput = z.object({
  name: z.string().trim().min(1).max(120),
  provider: z.enum(['http', 'postgres', 'mysql', 'github', 'slack', 'custom']),
  capabilities: z.array(z.string().trim().min(1).max(80)).min(1).max(100),
  credentials: z.record(z.string().max(120), z.string().max(10_000)).refine(value => Object.keys(value).length > 0, 'credentials are required'),
}).strict();

export interface ManagedIntegrationConnection {
  id: string;
  ref: string;
  tenantId: string;
  name: string;
  provider: z.infer<typeof connectionInput>['provider'];
  capabilities: string[];
  status: 'ready' | 'disabled';
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

interface ConnectionRow {
  id: string; ref: string; tenant_id: string; name: string; provider: ManagedIntegrationConnection['provider'];
  capabilities_json: string; secret_envelope: string; status: 'ready' | 'disabled'; created_by: string; created_at: string; updated_at: string;
}

export class ManagedIntegrationRegistry {
  private db: Database.Database;
  constructor(dbPath: string, private encryption: PluginConfigEncryption) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath); applyStandardPragmas(this.db);
    this.db.exec(`CREATE TABLE IF NOT EXISTS builder_connections (
      id TEXT PRIMARY KEY, ref TEXT NOT NULL, tenant_id TEXT NOT NULL, name TEXT NOT NULL, provider TEXT NOT NULL,
      capabilities_json TEXT NOT NULL, secret_envelope TEXT NOT NULL, status TEXT NOT NULL,
      created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE (tenant_id, ref)
    );
    CREATE INDEX IF NOT EXISTS idx_builder_connections_tenant ON builder_connections(tenant_id, updated_at DESC);`);
  }

  create(input: { tenantId: string; actor: string; connection: unknown }): ManagedIntegrationConnection {
    const parsed = connectionInput.parse(input.connection);
    const id = `connection-${crypto.randomBytes(8).toString('hex')}`;
    const ref = `managed/${slug(parsed.name)}-${id.slice(-6)}`;
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO builder_connections
      (id,ref,tenant_id,name,provider,capabilities_json,secret_envelope,status,created_by,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,'ready',?,?,?)`)
      .run(id, ref, input.tenantId, parsed.name, parsed.provider, JSON.stringify([...new Set(parsed.capabilities)].sort()),
        this.encryption.encrypt(parsed.credentials), input.actor, now, now);
    return this.get(id, input.tenantId)!;
  }

  get(id: string, tenantId: string): ManagedIntegrationConnection | null {
    const row = this.db.prepare('SELECT * FROM builder_connections WHERE id=? AND tenant_id=?').get(id, tenantId) as ConnectionRow | undefined;
    return row ? view(row) : null;
  }

  list(tenantId: string): ManagedIntegrationConnection[] {
    return (this.db.prepare('SELECT * FROM builder_connections WHERE tenant_id=? ORDER BY updated_at DESC').all(tenantId) as ConnectionRow[]).map(view);
  }

  setStatus(id: string, tenantId: string, status: 'ready' | 'disabled'): ManagedIntegrationConnection | null {
    const result = this.db.prepare('UPDATE builder_connections SET status=?, updated_at=? WHERE id=? AND tenant_id=?')
      .run(status, new Date().toISOString(), id, tenantId);
    return result.changes === 1 ? this.get(id, tenantId) : null;
  }

  resolveCapability(tenantId: string, ref: string, capability: string): { connection: ManagedIntegrationConnection; credentials: Record<string, string> } | null {
    const row = this.db.prepare('SELECT * FROM builder_connections WHERE tenant_id=? AND ref=? AND status=?').get(tenantId, ref, 'ready') as ConnectionRow | undefined;
    if (!row) return null;
    const connection = view(row);
    if (!connection.capabilities.includes(capability)) return null;
    return { connection, credentials: this.encryption.decrypt<Record<string, string>>(row.secret_envelope) };
  }

  close(): void { this.db.close(); }
}

function view(row: ConnectionRow): ManagedIntegrationConnection {
  return { id: row.id, ref: row.ref, tenantId: row.tenant_id, name: row.name, provider: row.provider,
    capabilities: JSON.parse(row.capabilities_json) as string[], status: row.status, createdBy: row.created_by,
    createdAt: row.created_at, updatedAt: row.updated_at };
}
function slug(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'connection'; }

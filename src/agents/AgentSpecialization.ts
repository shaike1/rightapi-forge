// AgentSpecialization — per-agent server affinity.
//
// Some agents are better-suited to a particular host (operator's
// preference, prior on-call rotation, post-mortem expertise tied to one
// box, …). The router currently picks by skill keywords + workload
// only; this module layers a soft preference on top: when an incident
// has a `serverId`, agents with that server in their affinity list
// score a bonus. Agents with no affinity are unchanged. The fallback
// path (round-robin across the body pool) is preserved — if no
// affinity match is available or all matched agents are busy, the
// existing logic still picks something.
//
// Storage is a tiny SQLite file keyed by agent id, with a JSON-encoded
// array of server ids. Defaults are seeded on first boot:
//   alice + ops-alpha  → vps1
//   ops-bravo + ops-charlie → vps2
//   ops-diana         → vps3
// Agent ids are looked up by display name at seed time so we don't have
// to hard-code uuids that vary per install.

import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import { logger } from '../utils/logger.js';

/** One row in the agent_affinity table. */
export interface AgentAffinity {
  agentId: string;
  serverIds: string[];
  updatedAt: string;
}

/** Boost added to an agent's router score per matching server when an
 *  incident has a `serverId`. Picked high enough to outweigh the load
 *  penalty (-20) so an affinity-match agent is preferred even if busy
 *  unless the agent is also a low-score keyword match. */
export const AFFINITY_BONUS_PER_MATCH = 30;

export class AgentSpecialization {
  private db: Database.Database;

  constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.migrate();
    logger.info(`[AgentSpecialization] Opened ${dbPath}`);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_affinity (
        agent_id    TEXT PRIMARY KEY,
        server_ids  TEXT NOT NULL DEFAULT '[]',
        updated_at  TEXT NOT NULL
      );
    `);
  }

  get(agentId: string): AgentAffinity | null {
    const row = this.db.prepare('SELECT * FROM agent_affinity WHERE agent_id = ?').get(agentId) as any;
    if (!row) return null;
    return {
      agentId: row.agent_id,
      serverIds: safeJsonArray(row.server_ids),
      updatedAt: row.updated_at,
    };
  }

  /** Full list — used by the dashboard "who handles what" view. */
  list(): AgentAffinity[] {
    return (this.db.prepare('SELECT * FROM agent_affinity').all() as any[]).map(r => ({
      agentId: r.agent_id,
      serverIds: safeJsonArray(r.server_ids),
      updatedAt: r.updated_at,
    }));
  }

  /** Replace the affinity list for one agent. Empty array clears it.
   *  De-duplicates and drops empty strings so the API doesn't have to. */
  set(agentId: string, serverIds: string[]): AgentAffinity {
    const clean = Array.from(new Set(serverIds.map(s => String(s).trim()).filter(Boolean)));
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO agent_affinity (agent_id, server_ids, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(agent_id) DO UPDATE SET
        server_ids = excluded.server_ids,
        updated_at = excluded.updated_at
    `).run(agentId, JSON.stringify(clean), now);
    return { agentId, serverIds: clean, updatedAt: now };
  }

  /** True iff this agent has the server in its affinity list. */
  hasAffinity(agentId: string, serverId: string): boolean {
    const row = this.get(agentId);
    if (!row) return false;
    return row.serverIds.includes(serverId);
  }

  /** Seed defaults only when the row doesn't exist. Re-running on every
   *  boot is safe and won't trample operator edits. */
  ensureSeed(agentId: string, serverIds: string[]): { created: boolean } {
    if (this.get(agentId)) return { created: false };
    this.set(agentId, serverIds);
    return { created: true };
  }

  clear(agentId: string): void {
    this.db.prepare('DELETE FROM agent_affinity WHERE agent_id = ?').run(agentId);
  }

  close(): void { this.db.close(); }
}

function safeJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(x => typeof x === 'string') : [];
  } catch { return []; }
}

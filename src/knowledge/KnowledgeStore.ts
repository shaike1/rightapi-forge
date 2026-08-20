// KnowledgeStore — operator-curated KB articles.
//
// Separate from PostMortemStore on purpose:
//   • PostMortems are auto-generated from incident resolutions and
//     read-only. Their job is "remember what happened".
//   • KB articles are operator-curated, edited over time, upvoted, and
//     linked to multiple incidents. Their job is "the answer when
//     this happens again".
//
// Schema:
//   • knowledge_articles  (id=KB-<hex>, title, content [markdown], tags JSON,
//                          linked_incidents JSON, useful_count, created_by,
//                          status [draft|published|archived],
//                          created_at, updated_at)
//   • knowledge_articles_fts (FTS5 mirror — content='knowledge_articles')
//
// Search is FTS5 — same pattern as incidents_fts and post_mortems_fts.
// Ranking falls through:
//   1. Phrase match in title (highest)
//   2. FTS rank (BM25)
//   3. useful_count tiebreaker (operator-curated quality signal)

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { randomBytes } from 'crypto';
import { logger } from '../utils/logger.js';
import { addTenantColumnSqlite } from '../persistence/tenantMigration.js';

export type ArticleStatus = 'draft' | 'published' | 'archived';

export interface KnowledgeArticle {
  id: string;
  title: string;
  /** Markdown body — rendered on the client; never trusted as HTML. */
  content: string;
  /** Free-form tags — used for filtering and FTS boost. */
  tags: string[];
  /** Incident ids referenced by this article. Operators wire these
   *  up manually; the auto-draft flow fills with the originating
   *  incident on first creation. */
  linkedIncidents: string[];
  /** Operator-curated useful counter. Incremented by upvote, reset
   *  by an operator who archives the article. */
  usefulCount: number;
  createdBy: string | null;
  status: ArticleStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ArticleFilter {
  status?: ArticleStatus;
  tag?: string;
  /** Free-text query (FTS5). Empty = match all. */
  q?: string;
  /** Cap on results. Default 50. */
  limit?: number;
}

export interface ScoredArticle extends KnowledgeArticle {
  /** FTS5 rank (lower = better) or 0 when no query was supplied. */
  rank: number;
}

export class KnowledgeStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.migrate();
    logger.info('[KnowledgeStore] opened', { dbPath });
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_articles (
        id              TEXT PRIMARY KEY,
        title           TEXT NOT NULL,
        content         TEXT NOT NULL,
        tags            TEXT NOT NULL DEFAULT '[]',
        linked_incidents TEXT NOT NULL DEFAULT '[]',
        useful_count    INTEGER NOT NULL DEFAULT 0,
        created_by      TEXT,
        status          TEXT NOT NULL DEFAULT 'draft',
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_kb_status ON knowledge_articles(status);
      CREATE INDEX IF NOT EXISTS idx_kb_useful ON knowledge_articles(useful_count);

      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_articles_fts USING fts5(
        id UNINDEXED, title, content, tags,
        content='knowledge_articles',
        content_rowid='rowid'
      );

      CREATE TRIGGER IF NOT EXISTS kb_ai AFTER INSERT ON knowledge_articles BEGIN
        INSERT INTO knowledge_articles_fts(rowid, id, title, content, tags)
        VALUES (new.rowid, new.id, new.title, new.content, new.tags);
      END;

      CREATE TRIGGER IF NOT EXISTS kb_ad AFTER DELETE ON knowledge_articles BEGIN
        INSERT INTO knowledge_articles_fts(knowledge_articles_fts, rowid, id, title, content, tags)
        VALUES ('delete', old.rowid, old.id, old.title, old.content, old.tags);
      END;

      CREATE TRIGGER IF NOT EXISTS kb_au AFTER UPDATE ON knowledge_articles BEGIN
        INSERT INTO knowledge_articles_fts(knowledge_articles_fts, rowid, id, title, content, tags)
        VALUES ('delete', old.rowid, old.id, old.title, old.content, old.tags);
        INSERT INTO knowledge_articles_fts(rowid, id, title, content, tags)
        VALUES (new.rowid, new.id, new.title, new.content, new.tags);
      END;
    `);
    addTenantColumnSqlite(this.db, 'knowledge_articles');
  }

  // ── CRUD ──────────────────────────────────────────────────────────

  create(input: {
    title: string;
    content: string;
    tags?: string[];
    linkedIncidents?: string[];
    createdBy?: string | null;
    status?: ArticleStatus;
  }): KnowledgeArticle {
    if (!input.title?.trim()) throw new Error('title is required');
    if (!input.content?.trim()) throw new Error('content is required');
    const id = newKbId();
    const now = new Date().toISOString();
    const row = {
      id,
      title: input.title.trim(),
      content: input.content,
      tags: JSON.stringify(dedup(input.tags ?? [])),
      linked_incidents: JSON.stringify(dedup(input.linkedIncidents ?? [])),
      useful_count: 0,
      created_by: input.createdBy ?? null,
      status: input.status ?? 'draft',
      created_at: now,
      updated_at: now,
    };
    this.db.prepare(`
      INSERT INTO knowledge_articles (id, title, content, tags, linked_incidents, useful_count, created_by, status, created_at, updated_at)
      VALUES (@id, @title, @content, @tags, @linked_incidents, @useful_count, @created_by, @status, @created_at, @updated_at)
    `).run(row);
    return this.toArticle(row);
  }

  get(id: string): KnowledgeArticle | null {
    const row = this.db.prepare('SELECT * FROM knowledge_articles WHERE id = ?').get(id) as any;
    return row ? this.toArticle(row) : null;
  }

  list(filter: ArticleFilter = {}): KnowledgeArticle[] {
    const where: string[] = [];
    const params: any[] = [];
    if (filter.status) { where.push('status = ?'); params.push(filter.status); }
    const sql = `SELECT * FROM knowledge_articles${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY useful_count DESC, updated_at DESC LIMIT ?`;
    params.push(filter.limit ?? 50);
    const rows = (this.db.prepare(sql).all(...params) as any[]).map(r => this.toArticle(r));
    if (filter.tag) return rows.filter(a => a.tags.includes(filter.tag!));
    return rows;
  }

  update(id: string, patch: Partial<{
    title: string;
    content: string;
    tags: string[];
    linkedIncidents: string[];
    status: ArticleStatus;
  }>): KnowledgeArticle | null {
    const existing = this.db.prepare('SELECT * FROM knowledge_articles WHERE id = ?').get(id) as any;
    if (!existing) return null;
    const now = new Date().toISOString();
    const next = {
      title: patch.title ?? existing.title,
      content: patch.content ?? existing.content,
      tags: patch.tags !== undefined ? JSON.stringify(dedup(patch.tags)) : existing.tags,
      linked_incidents: patch.linkedIncidents !== undefined ? JSON.stringify(dedup(patch.linkedIncidents)) : existing.linked_incidents,
      status: patch.status ?? existing.status,
    };
    this.db.prepare(`
      UPDATE knowledge_articles SET title = ?, content = ?, tags = ?, linked_incidents = ?, status = ?, updated_at = ?
      WHERE id = ?
    `).run(next.title, next.content, next.tags, next.linked_incidents, next.status, now, id);
    return this.get(id);
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM knowledge_articles WHERE id = ?').run(id).changes > 0;
  }

  /** Idempotent: bumps useful_count by 1. The route handler dedupes
   *  on (article_id, username) via the audit log; the store doesn't
   *  track per-user votes by design — operators chose simplicity. */
  incrementUseful(id: string): KnowledgeArticle | null {
    const r = this.db.prepare('UPDATE knowledge_articles SET useful_count = useful_count + 1, updated_at = ? WHERE id = ?').run(new Date().toISOString(), id);
    if (r.changes === 0) return null;
    return this.get(id);
  }

  /** Attach an incident id to an article without mutating the rest of
   *  the row. Used by the resolution auto-draft flow when the same
   *  incident type recurs and the draft already exists. Idempotent. */
  linkIncident(articleId: string, incidentId: string): KnowledgeArticle | null {
    const a = this.get(articleId);
    if (!a) return null;
    if (a.linkedIncidents.includes(incidentId)) return a;
    return this.update(articleId, { linkedIncidents: [...a.linkedIncidents, incidentId] });
  }

  // ── Search (FTS5) ────────────────────────────────────────────────

  /** FTS5-backed full-text search. Returns ranked results. `q` is
   *  sanitised for FTS5 syntax — quotes around the whole phrase to
   *  avoid accidental operator interpretation. `status` defaults to
   *  'published' so drafts don't leak into AI-grounding contexts. */
  search(q: string, opts: { tag?: string; status?: ArticleStatus; limit?: number } = {}): ScoredArticle[] {
    const cleanQ = sanitizeFtsQuery(q);
    if (!cleanQ) return [];
    const status = opts.status ?? 'published';
    const limit = Math.max(1, Math.min(50, opts.limit ?? 10));
    // FTS5 + status filter via JOIN back to the base table.
    const rows = this.db.prepare(`
      SELECT a.*, knowledge_articles_fts.rank AS rank
      FROM knowledge_articles_fts
      JOIN knowledge_articles a ON a.id = knowledge_articles_fts.id
      WHERE knowledge_articles_fts MATCH ? AND a.status = ?
      ORDER BY knowledge_articles_fts.rank ASC, a.useful_count DESC
      LIMIT ?
    `).all(cleanQ, status, limit) as any[];
    const results = rows.map(r => ({ ...this.toArticle(r), rank: r.rank ?? 0 }));
    if (opts.tag) return results.filter(a => a.tags.includes(opts.tag!));
    return results;
  }

  /** "Should we route this directly without calling the LLM?" — true
   *  when the top match is a strongly-curated article (useful_count
   *  above the threshold). The ChatBotService consults this before
   *  the omniroute call to save tokens on questions we've already
   *  answered well. */
  topMatchForAutoReply(q: string, opts: { minUsefulCount?: number; status?: ArticleStatus } = {}): ScoredArticle | null {
    const minUseful = opts.minUsefulCount ?? 5;
    const ranked = this.search(q, { status: opts.status, limit: 1 });
    if (ranked.length === 0) return null;
    return ranked[0].usefulCount >= minUseful ? ranked[0] : null;
  }

  stats(): { total: number; byStatus: Record<ArticleStatus, number>; topUseful: number } {
    const byStatus: Record<string, number> = {};
    for (const r of this.db.prepare('SELECT status, COUNT(*) AS n FROM knowledge_articles GROUP BY status').all() as any[]) {
      byStatus[r.status] = r.n;
    }
    const total = (this.db.prepare('SELECT COUNT(*) AS n FROM knowledge_articles').get() as { n: number }).n;
    const top = (this.db.prepare('SELECT MAX(useful_count) AS m FROM knowledge_articles').get() as { m: number | null }).m ?? 0;
    return { total, byStatus: byStatus as Record<ArticleStatus, number>, topUseful: top };
  }

  close(): void { try { this.db.close(); } catch { /* idempotent */ } }

  private toArticle(r: any): KnowledgeArticle {
    return {
      id: r.id,
      title: r.title,
      content: r.content,
      tags: safeJson(r.tags) as string[],
      linkedIncidents: safeJson(r.linked_incidents) as string[],
      usefulCount: r.useful_count ?? 0,
      createdBy: r.created_by ?? null,
      status: r.status as ArticleStatus,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
}

function newKbId(): string {
  return 'KB-' + randomBytes(4).toString('hex').toUpperCase();
}

function dedup<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

function safeJson(raw: unknown): unknown[] {
  if (typeof raw !== 'string') return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

/** Strip FTS5 special chars and wrap in quotes so a free-form query
 *  doesn't crash the parser. Empty input returns empty string. */
export function sanitizeFtsQuery(q: string): string {
  const stripped = String(q || '').replace(/"/g, '').replace(/[(){}\[\]:^~*]/g, ' ').trim();
  if (!stripped) return '';
  // Wrap in double quotes for a phrase-style match; FTS5 treats quoted
  // strings as a literal phrase, which is the most predictable shape
  // for free-text user input. Bigram-style ranking still works.
  return `"${stripped}"`;
}

// Shared helper for applying consistent PRAGMA settings to every
// better-sqlite3 connection. Why a single helper:
//
//   • Most stores set `journal_mode=WAL` + `synchronous=NORMAL` but forget
//     `busy_timeout`. That made concurrent writers (the scheduler + the
//     HTTP handler) intermittently throw SQLITE_BUSY under load.
//   • `foreign_keys` is OFF by default in better-sqlite3 — silent FK
//     drift is worse than the few CPU cycles spent enforcing them.
//   • A few large stores (events, metrics_history) benefit from a bigger
//     page cache. mmap_size on Linux gives a measurable read speedup for
//     hot tables; we don't try to tune it on Windows where it's a no-op.
//
// Idempotent: calling applyStandardPragmas() multiple times on the same
// connection is safe and cheap. Stores that already set pragmas
// individually can be migrated incrementally — the new helper just
// reasserts the same values plus the extras.
//
// Per-call overrides are supported for stores that need different
// defaults (e.g. ephemeral test DBs that prefer journal_mode=MEMORY).

import type Database from 'better-sqlite3';

export interface PragmaOptions {
  /** Defaults to 'WAL' — the right call for everything except in-memory
   *  test DBs where 'MEMORY' is faster. */
  journalMode?: 'WAL' | 'DELETE' | 'TRUNCATE' | 'PERSIST' | 'MEMORY' | 'OFF';
  /** Defaults to 'NORMAL' — paired with WAL gives good crash safety
   *  without the throughput cost of FULL. */
  synchronous?: 'OFF' | 'NORMAL' | 'FULL' | 'EXTRA';
  /** Milliseconds to spin on SQLITE_BUSY before returning an error.
   *  5_000 is enough to ride out a vacuum or a slow backup; lower than
   *  most HTTP request timeouts so a stuck connection still surfaces. */
  busyTimeoutMs?: number;
  /** Cache size in KiB (negative = KiB; positive = pages). Default
   *  -65536 ≈ 64 MiB — generous enough for the largest tables we run. */
  cacheSizeKib?: number;
  /** Memory-map size in bytes. Default 268_435_456 (256 MiB). Set to 0
   *  to disable. mmap is a no-op on Windows but harmless to set. */
  mmapSizeBytes?: number;
  /** Enable FK constraint enforcement. Default true. */
  foreignKeys?: boolean;
  /** Truncate the WAL on every checkpoint instead of letting it grow
   *  unbounded. Default true — keeps WAL files small for stores that
   *  rarely close their connections. */
  walAutocheckpoint?: number;
}

const DEFAULTS: Required<PragmaOptions> = {
  journalMode: 'WAL',
  synchronous: 'NORMAL',
  busyTimeoutMs: 5_000,
  cacheSizeKib: -65_536,
  mmapSizeBytes: 268_435_456,
  foreignKeys: true,
  walAutocheckpoint: 1_000,
};

/**
 * Apply the standard PRAGMA set to a better-sqlite3 connection.
 *
 * Safe to call repeatedly. Returns the resolved pragma values so callers
 * can verify (and tests can assert) the configuration applied.
 */
export function applyStandardPragmas(
  db: Database.Database,
  opts: PragmaOptions = {},
): Required<PragmaOptions> {
  const cfg: Required<PragmaOptions> = { ...DEFAULTS, ...opts };

  // Order matters: journal_mode and foreign_keys must be set before the
  // first transaction. busy_timeout must be set before the first
  // SQLITE_BUSY can fire, i.e. before any concurrent write.
  db.pragma(`journal_mode = ${cfg.journalMode}`);
  db.pragma(`synchronous = ${cfg.synchronous}`);
  db.pragma(`busy_timeout = ${cfg.busyTimeoutMs}`);
  db.pragma(`foreign_keys = ${cfg.foreignKeys ? 'ON' : 'OFF'}`);
  db.pragma(`cache_size = ${cfg.cacheSizeKib}`);
  if (cfg.mmapSizeBytes > 0) {
    try { db.pragma(`mmap_size = ${cfg.mmapSizeBytes}`); } catch { /* mmap unsupported (Windows builds) — ignore */ }
  }
  if (cfg.journalMode === 'WAL') {
    db.pragma(`wal_autocheckpoint = ${cfg.walAutocheckpoint}`);
  }
  return cfg;
}

/** Read the live PRAGMA values from a connection. Used by health probes
 *  and DB-size reporting to surface the actual settings, not the values
 *  we asked for. */
export function readPragmas(db: Database.Database): {
  journalMode: string;
  synchronous: string;
  busyTimeoutMs: number;
  cacheSize: number;
  mmapSize: number;
  foreignKeys: boolean;
  walAutocheckpoint: number;
} {
  const read = (name: string): unknown => {
    const r = db.pragma(name) as unknown;
    if (Array.isArray(r) && r.length > 0) {
      const first = r[0] as Record<string, unknown>;
      const vals = Object.values(first);
      return vals[0];
    }
    return r;
  };
  return {
    journalMode: String(read('journal_mode')),
    synchronous: String(read('synchronous')),
    busyTimeoutMs: Number(read('busy_timeout')),
    cacheSize: Number(read('cache_size')),
    mmapSize: Number(read('mmap_size')),
    foreignKeys: Number(read('foreign_keys')) === 1,
    walAutocheckpoint: Number(read('wal_autocheckpoint')),
  };
}

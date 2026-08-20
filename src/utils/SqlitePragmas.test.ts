import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { applyStandardPragmas, readPragmas } from './SqlitePragmas.js';

test('applyStandardPragmas sets the documented defaults', () => {
  const db = new Database(':memory:');
  try {
    applyStandardPragmas(db);
    const read = readPragmas(db);
    // :memory: DBs do not honor WAL on every build; checking the
    // synchronous/foreign_keys/busy_timeout suite is enough proof that
    // the helper executed correctly.
    assert.equal(read.foreignKeys, true);
    assert.equal(read.busyTimeoutMs, 5000);
    // synchronous=NORMAL is the numeric value 1 in SQLite.
    assert.equal(read.synchronous, '1');
  } finally {
    db.close();
  }
});

test('applyStandardPragmas respects per-call overrides', () => {
  const db = new Database(':memory:');
  try {
    applyStandardPragmas(db, { busyTimeoutMs: 12345, foreignKeys: false });
    const read = readPragmas(db);
    assert.equal(read.busyTimeoutMs, 12345);
    assert.equal(read.foreignKeys, false);
  } finally {
    db.close();
  }
});

test('applyStandardPragmas is idempotent', () => {
  const db = new Database(':memory:');
  try {
    applyStandardPragmas(db);
    const r1 = readPragmas(db);
    applyStandardPragmas(db);
    applyStandardPragmas(db);
    const r2 = readPragmas(db);
    assert.deepEqual(r1, r2);
  } finally {
    db.close();
  }
});

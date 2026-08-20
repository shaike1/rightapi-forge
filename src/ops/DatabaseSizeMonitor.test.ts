import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { DatabaseSizeMonitor, totalDbBytes } from './DatabaseSizeMonitor.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'itops-db-size-'));
}

interface FakeIncident { id: string; severity: string; resolved?: boolean; note?: string }

function fakeIncidentManager() {
  const opened: FakeIncident[] = [];
  const resolved: FakeIncident[] = [];
  let counter = 0;
  return {
    opened, resolved,
    create(input: any) {
      const found = opened.find(o => o.severity && (input.dedupBy === 'sourceRef'));
      if (found) return found; // dedup
      const inc: FakeIncident = { id: `inc-${++counter}`, severity: input.severity };
      opened.push(inc);
      return inc;
    },
    update(_id: string, patch: any) {
      const inc = opened[opened.length - 1];
      if (inc) inc.severity = patch.severity ?? inc.severity;
      return inc;
    },
    resolve(id: string, note?: string) {
      const inc = opened.find(o => o.id === id);
      if (inc) { inc.resolved = true; inc.note = note; resolved.push(inc); }
    },
  };
}

test('DatabaseSizeMonitor opens an incident once threshold is repeatedly breached', async () => {
  const dir = tmpDir();
  const dbPath = path.join(dir, 'big.db');
  // Write a tiny "DB" file. We'll use a 1-byte warn threshold so even
  // the smallest file trips it.
  fs.writeFileSync(dbPath, Buffer.alloc(64));

  const incidents = fakeIncidentManager();
  const mon = new DatabaseSizeMonitor(
    { incidentManager: incidents },
    { intervalMs: 60_000, warnBytes: 1, failBytes: 1024 * 1024, failStreakThreshold: 2 },
  );
  mon.register({ name: 'big', path: dbPath });

  // First tick: warn but below failStreakThreshold → no incident yet.
  await mon.tickOnce();
  assert.equal(incidents.opened.length, 0);
  // Second tick: streak crosses threshold → incident opens.
  await mon.tickOnce();
  assert.equal(incidents.opened.length, 1);
  assert.equal(incidents.opened[0].severity, 'medium');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('DatabaseSizeMonitor escalates to critical when fail threshold reached', async () => {
  const dir = tmpDir();
  const dbPath = path.join(dir, 'huge.db');
  // 2 MB file, fail threshold 1 MB → fail state.
  fs.writeFileSync(dbPath, Buffer.alloc(2 * 1024 * 1024));

  const incidents = fakeIncidentManager();
  const mon = new DatabaseSizeMonitor(
    { incidentManager: incidents },
    { warnBytes: 512 * 1024, failBytes: 1024 * 1024, failStreakThreshold: 1 },
  );
  mon.register({ name: 'huge', path: dbPath });

  await mon.tickOnce();
  assert.equal(incidents.opened.length, 1);
  assert.equal(incidents.opened[0].severity, 'critical');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('DatabaseSizeMonitor auto-resolves when DB drops back below thresholds', async () => {
  const dir = tmpDir();
  const dbPath = path.join(dir, 'shrinking.db');
  fs.writeFileSync(dbPath, Buffer.alloc(2 * 1024 * 1024));

  const incidents = fakeIncidentManager();
  const mon = new DatabaseSizeMonitor(
    { incidentManager: incidents },
    { warnBytes: 512 * 1024, failBytes: 1024 * 1024, failStreakThreshold: 1 },
  );
  mon.register({ name: 'shrinking', path: dbPath });

  await mon.tickOnce();
  assert.equal(incidents.opened.length, 1);

  // Truncate the file → next tick should auto-resolve.
  fs.writeFileSync(dbPath, Buffer.alloc(8));
  await mon.tickOnce();
  assert.equal(incidents.resolved.length, 1);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('totalDbBytes sums main + wal + shm', () => {
  const dir = tmpDir();
  const dbPath = path.join(dir, 'sum.db');
  fs.writeFileSync(dbPath, Buffer.alloc(100));
  fs.writeFileSync(dbPath + '-wal', Buffer.alloc(50));
  fs.writeFileSync(dbPath + '-shm', Buffer.alloc(25));
  assert.equal(totalDbBytes(dbPath), 175);
  fs.rmSync(dir, { recursive: true, force: true });
});

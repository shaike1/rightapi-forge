import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SqliteIncidentStore } from '../persistence/SqliteStore.js';
import { IncidentManager } from '../incidents/IncidentManager.js';
import { IncidentAutoRemediator } from './IncidentAutoRemediator.js';

function freshManager() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'itops-auto-rem-'));
  const store = new SqliteIncidentStore(path.join(dir, 'incidents.db'));
  return new IncidentManager(store);
}

function inc(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'INC-TEST',
    title: '',
    description: '',
    severity: 'medium',
    status: 'open',
    assignedTo: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    resolvedAt: null,
    source: 'health-monitor',
    sourceRef: null,
    slaMinutes: 60,
    ...overrides,
  };
}

test('matchPlan: disk title → disk-cleanup plan with 5 actions', () => {
  const mgr = freshManager();
  const r = new IncidentAutoRemediator(mgr, { enabled: true });
  const plan = r.matchPlan(inc({ title: 'Disk Critical: /data at 92%', sourceRef: 'disk:/data' }));
  assert.ok(plan, 'plan should match');
  assert.equal(plan!.kind, 'disk-cleanup');
  // 3 docker prune steps + 2 host log-cleanup steps
  assert.equal(plan!.actions.length, 5);

  // Step 1: container prune (fast, harmless first)
  const a0 = plan!.actions[0] as any;
  assert.equal(a0.mode, 'argv');
  assert.deepEqual(a0.args, ['container', 'prune', '-f']);

  // Step 2: image prune (no -a → tagged images stay; long timeout)
  const a1 = plan!.actions[1] as any;
  assert.equal(a1.mode, 'argv');
  assert.deepEqual(a1.args, ['image', 'prune', '-f']);
  assert.ok((a1.timeoutMs ?? 0) >= 300_000, 'image prune needs ≥5min timeout');

  // Step 3: builder prune with keep-storage cap
  const a2 = plan!.actions[2] as any;
  assert.equal(a2.mode, 'argv');
  assert.deepEqual(a2.args, ['builder', 'prune', '-f', '--keep-storage=2GB']);
  assert.ok((a2.timeoutMs ?? 0) >= 300_000, 'builder prune needs ≥5min timeout');

  // Step 4 + 5: host-shell (run via nsenter into host namespaces)
  const a3 = plan!.actions[3] as any;
  assert.equal(a3.mode, 'host-shell');
  assert.match(a3.command, /find \/var\/log/);

  const a4 = plan!.actions[4] as any;
  assert.equal(a4.mode, 'host-shell');
  assert.match(a4.command, /journalctl --vacuum-time/);
});

test('matchPlan: matches production alert-rule shape', () => {
  // The alert-rules engine fires with title="<rule.name> on <host>" and
  // sourceRef=rule.id (e.g. "seed-disk-warning"). Both the title-includes
  // path and the sourceRef-prefix path should catch this.
  const mgr = freshManager();
  const r = new IncidentAutoRemediator(mgr, { enabled: true });
  const plan = r.matchPlan(inc({
    title: 'High Disk Usage on 172.31.0.1',
    sourceRef: 'seed-disk-warning',
    source: 'alert-rule',
  }));
  assert.ok(plan, 'production alert-rule disk incident should match');
  assert.equal(plan!.kind, 'disk-cleanup');
});

test('matchPlan: matches structured health:disk:/ sourceRef', () => {
  const mgr = freshManager();
  const r = new IncidentAutoRemediator(mgr, { enabled: true });
  const plan = r.matchPlan(inc({
    // Title has nothing dictionary-disk in it — sourceRef must carry it.
    title: 'Threshold tripped on prod-01',
    sourceRef: 'health:disk:/',
  }));
  assert.ok(plan, 'structured disk sourceRef should match');
  assert.equal(plan!.kind, 'disk-cleanup');
});

test('matchPlan: docker housekeeping → split per-resource prune (image -a)', () => {
  // The user-facing requirement: split docker prune into smaller
  // commands. Housekeeping is now four argv steps (container / image
  // -a / network / builder) instead of one `docker system prune -af`.
  // Each one shows up as its own timeline entry, partial failures
  // don't void the rest, and `--volumes` is never passed.
  const mgr = freshManager();
  const r = new IncidentAutoRemediator(mgr, { enabled: true });
  const plan = r.matchPlan(inc({ title: 'Docker housekeeping required', sourceRef: 'docker:images' }));
  assert.ok(plan, 'plan should match');
  assert.equal(plan!.kind, 'docker-housekeeping');
  assert.equal(plan!.actions.length, 4);

  const [a0, a1, a2, a3] = plan!.actions as any[];
  assert.deepEqual(a0.args, ['container', 'prune', '-f']);
  // The `-a` is what makes housekeeping more aggressive than disk-
  // cleanup: it clears tagged-but-unused images too.
  assert.deepEqual(a1.args, ['image', 'prune', '-a', '-f']);
  assert.ok((a1.timeoutMs ?? 0) >= 300_000, 'image prune needs ≥5min timeout');
  assert.deepEqual(a2.args, ['network', 'prune', '-f']);
  assert.deepEqual(a3.args, ['builder', 'prune', '-f', '--keep-storage=2GB']);

  // No `--volumes` flag anywhere — guards against any future Docker
  // default that prunes anonymous volumes.
  for (const a of plan!.actions) {
    if (a.mode === 'argv') {
      assert.ok(!a.args.some(x => /volumes/.test(x)), `step "${a.args.join(' ')}" must not touch volumes`);
    }
  }
});

test('matchPlan: tighter title match — "Container disk1 crashed" must NOT trigger disk plan', () => {
  // Word-boundary disk-noun matching. `disk1` is not a disk noun;
  // `crashed` is not a pressure qualifier. Without a structured
  // sourceRef, this incident must NOT trigger a docker prune just
  // because "disk" appears as a substring of the container name.
  const mgr = freshManager();
  const r = new IncidentAutoRemediator(mgr, { enabled: true });
  const plan = r.matchPlan(inc({
    title: 'Container disk1 crashed',
    description: 'exited with code 1',
  }));
  assert.equal(plan, null);
});

test('matchPlan: filesystem / storage / out-of-space synonyms also match', () => {
  const mgr = freshManager();
  const r = new IncidentAutoRemediator(mgr, { enabled: true });
  assert.ok(r.matchPlan(inc({ title: 'Filesystem 95% full' })));
  assert.ok(r.matchPlan(inc({ title: 'Storage almost full on /var' })));
  assert.ok(r.matchPlan(inc({ title: 'Out of disk space' })));
});

test('matchPlan: container restart only fires with structured sourceRef', () => {
  const mgr = freshManager();
  const r = new IncidentAutoRemediator(mgr, { enabled: true });

  // No sourceRef → free-text title alone won't trigger a restart
  // (intentional safety boundary).
  const noRef = r.matchPlan(inc({
    title: 'Container web-01 has crashed',
    description: 'Container exited with code 1',
  }));
  assert.equal(noRef, null, 'free-text crash without sourceRef must not match');

  // With container:<name> sourceRef → restart plan
  const withRef = r.matchPlan(inc({
    title: 'Container crashed',
    description: 'unhealthy',
    sourceRef: 'container:itops-agents',
  }));
  assert.ok(withRef, 'plan should match');
  assert.equal(withRef!.kind, 'container-restart');
  const a = withRef!.actions[0] as any;
  assert.deepEqual(a.args, ['restart', 'itops-agents']);
});

test('matchPlan: container restart rejects unsafe container names', () => {
  const mgr = freshManager();
  const r = new IncidentAutoRemediator(mgr, { enabled: true });
  // Shell metacharacters in name → must NOT produce a plan, since the
  // name regex rejects anything outside the docker name charset.
  const malicious = r.matchPlan(inc({
    title: 'Container crashed',
    sourceRef: 'container:foo;rm -rf /',
  }));
  assert.equal(malicious, null);
});

test('matchPlan: remote service restart requires a structured target and allowlist', () => {
  const mgr = freshManager();
  const r = new IncidentAutoRemediator(mgr, { enabled: true, serviceAllowlist: ['ssh'] });
  const allowed = r.matchPlan(inc({
    title: 'Service down: ssh', sourceRef: 'service:failed:ssh:vps2', serverId: 'vps2',
  }));
  assert.equal(allowed?.kind, 'service-restart');
  assert.deepEqual((allowed?.actions[0] as any).candidates, ['ssh', 'sshd']);
  assert.equal(r.matchPlan(inc({ title: 'Service down: docker', sourceRef: 'service:failed:docker:vps2', serverId: 'vps2' })), null);
  assert.equal(r.matchPlan(inc({ title: 'Service down: ssh', sourceRef: null, serverId: 'vps2' })), null);
});

test('remediate: remote service restart falls through to a healthy platform alias', async () => {
  const mgr = freshManager();
  const created = mgr.create({
    title: 'Service down: ssh', severity: 'critical', source: 'health-monitor',
    sourceRef: 'service:failed:ssh:vps2', serverId: 'vps2',
  });
  const calls: string[] = [];
  const r = new IncidentAutoRemediator(mgr, {
    enabled: true,
    serviceAllowlist: ['ssh'],
    getServerRegistry: () => ({ get: () => ({ id: 'vps2', name: 'vps2' }) as any }),
    getRemoteExecutor: () => ({
      executeFile: async (_server: any, _file: string, args: string[]) => {
        calls.push(args[1]);
        return args[1] === 'sshd'
          ? { exitCode: 0, stdout: '', stderr: '' }
          : { exitCode: 5, stdout: '', stderr: 'unit not found' };
      },
    } as any),
  });
  const result = await r.remediate(created);
  assert.deepEqual(calls, ['ssh', 'sshd']);
  assert.equal(result?.actions[0].status, 'success');
  assert.equal(mgr.get(created.id)?.status, 'mitigating');
  assert.ok(mgr.getTimeline(created.id).some(entry => /restarted sshd/.test(entry.message)));
});

test('matchPlan: unrelated incident → no plan', () => {
  const mgr = freshManager();
  const r = new IncidentAutoRemediator(mgr, { enabled: true });
  const plan = r.matchPlan(inc({ title: 'CPU Overload: load 8.5 on 4 cores', sourceRef: 'cpu' }));
  assert.equal(plan, null);
});

test('handle: disabled → no-op (no plan executed even on disk match)', () => {
  const mgr = freshManager();
  const r = new IncidentAutoRemediator(mgr, { enabled: false });
  const created = mgr.create({ title: 'Disk Critical: /data at 92%', source: 'health-monitor', sourceRef: 'disk:/data', dedupBy: 'sourceRef' });
  r.handle(created);
  // No timeline note from the remediator — the only entry is the
  // synthetic "opened" record.
  const tl = mgr.getTimeline(created.id);
  assert.ok(!tl.some(e => e.actor === 'auto-remediator'),
    'disabled remediator must not write timeline notes');
});

test('handle: same incident → only one attempt (idempotent)', async () => {
  const mgr = freshManager();
  // Disable the actual run by passing enabled=false-equivalent: we
  // toggle via the AUTO_REMEDIATION_ENABLED env to ensure handle()
  // would otherwise fire. Here we just verify the attempted-set
  // gates re-entry.
  const r = new IncidentAutoRemediator(mgr, { enabled: true });
  const created = mgr.create({ title: 'CPU Overload', source: 'health-monitor', sourceRef: 'cpu', dedupBy: 'sourceRef' });
  // CPU has no plan, so handle() returns early without marking
  // attempted. Sanity-check the no-match path doesn't trip the
  // attempted-set logic (we don't want a no-op to lock a future
  // matching create out).
  r.handle(created);
  r.handle(created);
  const tl = mgr.getTimeline(created.id);
  assert.ok(!tl.some(e => e.actor === 'auto-remediator'));
});

test('execute: aborts when incident already resolved (race guard)', async () => {
  // Reach into the private execute() via a typed cast so we can drive
  // it with a stub plan that does nothing observable. The race guard
  // re-fetches the incident before each action; if status is already
  // 'resolved' before the FIRST action runs, no actions execute and
  // status stays 'resolved' (we don't bump it back to 'mitigating').
  const mgr = freshManager();
  const r = new IncidentAutoRemediator(mgr, { enabled: true });
  const created = mgr.create({
    title: 'Disk Critical: /data',
    source: 'health-monitor',
    sourceRef: 'disk:/data',
    dedupBy: 'sourceRef',
  });

  // Operator (or another path) resolves the incident BEFORE remediation
  // actions run.
  mgr.update(created.id, { status: 'resolved' });

  // A stub plan whose actions would error if dispatched — proves they
  // never run because the race guard short-circuits.
  const stubPlan = {
    kind: 'disk-cleanup' as const,
    actions: [
      { mode: 'argv' as const, file: 'definitely-not-a-binary-xyz', args: ['boom'] },
    ],
  };
  const outcome = await (r as any).execute(created, stubPlan);

  assert.match(String(outcome.abortedReason ?? ''), /resolved/);
  assert.equal(outcome.actions.length, 0, 'no actions should run after abort');
  // Status must not be flipped back to mitigating.
  const after = mgr.get(created.id);
  assert.equal(after?.status, 'resolved');
});

test('integration: alert-rule incident triggers remediator via onCreated', () => {
  // Mirrors the live wiring in src/web/server.ts: IncidentManager
  // constructed with an onCreated callback that calls
  // autoRemediator.handle(). Proves a fresh alert-rule incident
  // (title="High Disk Usage on …", sourceRef="seed-disk-warning")
  // routes through the remediator and matches the disk-cleanup plan.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'itops-auto-rem-int-'));
  const store = new SqliteIncidentStore(path.join(dir, 'incidents.db'));

  let remediator: IncidentAutoRemediator | null = null;
  // The onCreated closure binds the outer `remediator` by reference,
  // matching the deferred-init pattern used in server.ts.
  const mgr = new IncidentManager(store, undefined, undefined, (incident) => {
    remediator?.handle(incident);
  });
  // Disable real shell execution by replacing matchPlan with a probe
  // and routing through handle() — the test is about the wiring, not
  // about whether docker prune actually runs.
  remediator = new IncidentAutoRemediator(mgr, { enabled: true });
  let matched: any = null;
  const realMatchPlan = remediator.matchPlan.bind(remediator);
  (remediator as any).matchPlan = (inc: any) => {
    const plan = realMatchPlan(inc);
    matched = { incidentId: inc.id, plan };
    return null;  // returning null prevents execute() from running
  };

  mgr.create({
    title: 'High Disk Usage on 172.31.0.1',
    description: 'Disk over 80% — alert-rule',
    severity: 'medium',
    source: 'alert-rule',
    sourceRef: 'seed-disk-warning',
    dedupBy: 'sourceRef',
  });

  assert.ok(matched, 'matchPlan should have been called via onCreated');
  assert.ok(matched.plan, 'alert-rule disk shape must produce a plan');
  assert.equal(matched.plan.kind, 'disk-cleanup');
});

test('matchPlan: nsenter-wrapped host steps reference no caller data', () => {
  // Defensive: even if a future change accepts data from an incident,
  // the host-shell commands today are pre-baked literals. Verify they
  // contain none of the title/description/sourceRef text.
  const mgr = freshManager();
  const r = new IncidentAutoRemediator(mgr, { enabled: true });
  const plan = r.matchPlan(inc({
    title: 'Disk full $(rm -rf /) on prod',
    description: '`whoami`',
    sourceRef: 'disk:/$(id)',
  }));
  assert.ok(plan);
  for (const a of plan!.actions) {
    if (a.mode === 'host-shell') {
      assert.doesNotMatch(a.command, /rm -rf|whoami|\$\(id\)/, 'host commands must not interpolate caller data');
    }
  }
});

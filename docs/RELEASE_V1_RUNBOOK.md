# RightAPI Forge v1.0 Release Runbook

This runbook is the operational source of truth for installing, running, and
recovering RightAPI Forge v1.0. It complements `docs/DEPLOYMENT.md` (HTTPS +
S3 backup plumbing) and `docs/DEVELOPER_GUIDE.md` (architecture).

---

## 1. Pre-flight checklist

Run every item before declaring a host "production-ready".

- [ ] `node --version` is v22.x.
- [ ] `npm ci` succeeds with no audit errors against the locked deps.
- [ ] `npm run build` succeeds and emits the complete server distribution.
- [ ] `npm test` passes with no failures; use the command output as the release-record count.
- [ ] `.env` contains strong secrets for `CREDENTIAL_MASTER_KEY`,
      `APPROVAL_TOKEN_SECRET`, `AUTH_TOKEN_SECRET`. `npm run secrets:generate`
      produces an untracked `.env.generated` file for review and installation.
- [ ] Every explicitly configured monitored server is registered in the
      `ServerRegistry` and reachable from the daemon host through its approved transport.
- [ ] Cloud provider credentials (if used) are mounted read-only under
      `/data/itops-agents/cloud-creds/`.

---

## 2. Startup

```bash
npm run build
npm start          # → node dist/web/server.js
# or, with a process manager:
pm2 start dist/web/server.js --name itops-agents
```

The server listens on `PORT` (default 19123). Health endpoints:

- `GET /api/health` — process, store, and AI-provider status.
- `GET /api/metrics/autonomy` — v1 autonomy SLA metrics
  (autonomous resolution rate, MTTR, false-resolve rate, tool coverage).
- `GET /metrics` — Prometheus scrape endpoint.

---

## 3. Shutdown

`SIGTERM` triggers an orderly shutdown:

1. Stops accepting new HTTP/WS connections.
2. Drains in-flight agent tasks (each agent gets its iteration cap to finish).
3. Flushes the SQLite WAL + closes all `better-sqlite3` handles.
4. Emits `system.stopping` on the EventBus.

`SIGKILL` is safe but may leave the WAL journaled; SQLite recovers on next
boot. There is no separate "drain mode" flag.

---

## 4. Backup and restore

**Backup** runs automatically (see `docs/DEPLOYMENT.md` for the S3 plumbing):

- `SqliteBackupRunner` copies every registered DB into
  `/data/itops-agents/backups/YYYY-MM-DD/` once per day.
- `SqliteVacuumRunner` runs `VACUUM` weekly to reclaim free pages.
- `DatabaseSizeMonitor` opens an incident when any DB exceeds its threshold.

**Restore drill** (run quarterly):

```bash
# 1. Stop the daemon.
# 2. Restore the DB files from the latest snapshot:
docker cp /backups/2026-07-26/incidents.db itops-agents:/data/itops-agents/incidents.db
# 3. Restart and verify row counts via the API:
curl -s localhost:19123/api/incidents | jq '.incidents | length'
# 4. Confirm `/api/health` reports every store "ok".
```

---

## 5. Rollback

Every release is git-tagged. To roll back:

```bash
git fetch --tags
git checkout v1.0.0
npm ci
npm run build
npm test
# Then restart the process.
```

Destructive actions (`rm -rf`, `mkfs`, volume deletes) are blocked by
`ExecutionGuard` unless an operator passes an explicit destructive override.
For data rollback, prefer restoring from the most recent SQLite snapshot
rather than rolling back the binary — schema migrations are forward-only.

---

## 6. Critical environment variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `PORT` | HTTP listen port | `19123` |
| `CREDENTIAL_MASTER_KEY` | Encrypts the credential vault | (required) |
| `APPROVAL_TOKEN_SECRET` | Signs one-time approval tokens | (required) |
| `AUTH_TOKEN_SECRET` | Signs user session JWTs | (required) |
| `ANTHROPIC_API_KEY` | Claude provider (ReAct loop, post-mortems) | (optional) |
| `EVENTS_RETENTION_DAYS` | Nightly event-store prune window | `90` |
| `AI_DECISIONS_RETENTION_DAYS` | Nightly AI-decision prune window | `90` |
| `INCIDENT_AGENT_KB_TOP_K` | Past post-mortems injected per incident | `3` |
| `AUTO_RESOLVE_ENABLED` | AutoResolver autonomy gate | `true` |

Set any retention variable to `0` to disable pruning for that store.

---

## 7. Autonomy trust signals (v1)

The four Success Metrics are exposed at `/api/metrics/autonomy` and on the
"Autonomy" page of the factory dashboard:

| Metric | Target | Source |
|--------|--------|--------|
| Autonomous resolution rate | ≥ 60% | `ai_decisions` (kind=resolve) |
| False-resolve rate | ≤ 5% | `ai_decisions` (outcome=reopened) |
| MTTR | ≤ 15 min | `incidents.resolved_at − created_at` |
| Tool coverage | 4 layers | `SkillManager` capability scan |

`AutonomyWatchdog` runs every 5 minutes and opens an incident the moment any
threshold is breached. Treat those incidents as P1 — they mean the autonomy
loop is degrading and human review is needed.

---

## 8. Known risks (v1)

- **Approvals are WebSocket + Web Push only.** Telegram / webhook routing
  for `approval_required` events is intentionally deferred to a later
  integration sprint.
- **UI dashboard is functional but minimal.** The factory dashboard exposes
  the four success metrics and the task board; deeper incident triage is
  API-first.
- **LLM retry is bounded, not infinite.** The `withRetry` wrapper stops
  after 3 attempts; persistent outages still escalate to humans.
- **Forward-only migrations.** There is no automatic schema rollback path;
  rely on SQLite snapshots for data rollback.

---

## 9. Definition of Done for v1.0

- [ ] The typed builder, constrained generation, isolated preview, quality gates, approval-controlled deployment and rollback, iterative editing, and catalog acceptance flows pass against the release candidate.
- [ ] Server and client builds, tests, dependency audits, module boundaries, third-party license inventory, and publish-mode release audit are green; preserve their exact outputs in the release record.
- [ ] A clean installation plus upgrade, backup, restore, and rollback drills pass using the candidate artifacts.
- [ ] The sanitized repository has no inherited private history or private remote, and its required branch and security controls are enabled.
- [ ] The `v1.0.0-rc.1` tag and its image, SBOMs, provenance, notices, and release notes are verified before any stable tag is created.

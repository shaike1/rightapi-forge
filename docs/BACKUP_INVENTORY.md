# Backup Inventory

This inventory is the source of truth for Sprint 14 backup coverage. Query the live report with:

```bash
curl -fsS "$BASE_URL/api/system/backups/inventory" \
  -H "Authorization: Bearer $TOKEN" | jq
```

## Classification

- `sqlite-online`: covered by `SqliteBackupRunner` through SQLite's online backup API.
- `state-bundle`: embedded in the JSON state bundle managed by `StateBackupManager`.
- `uncovered`: persistent data exists but is not included in either mechanism.
- `sensitive: true`: the filename indicates authentication, credential, token, vault, secret, or configuration content.

The scanner excludes backup output, logs, SQLite WAL/SHM sidecars, bootstrap markers, and pre-restore safety copies. These are derived or transient files rather than independent restore inputs.

At startup, the coverage planner adds every discovered JSON/JSONL file to the encrypted state bundle and promotes every discovered database to the online SQLite backup runner. Explicit targets retain their configured required/optional policy; discovered state files are optional so deletion of transiently-created state does not break later backup runs. Discovered databases are required and must pass SQLite's online backup operation.

Files created after startup remain visible as `uncovered` until the next controlled service restart reconciles the target set. This prevents silently changing a running restore contract mid-process.

## Docker Volumes

| Volume | Service | Purpose | Core restore |
|---|---|---|---|
| `itops-data` | `itops-agents` | Core application state | Yes |
| `postgres-data` | `postgres` | Optional PostgreSQL backend | When `DB_PROVIDER=postgres` |
| `redis-data` | `redis` | Optional message bus persistence | No |
| `irc-data` | `irc-server` | IRC server state | No |
| `ollama-data` | `ollama` | Local model cache | No |
| `prometheus-data` | `prometheus` | Metrics history | No |
| `grafana-data` | `grafana` | Dashboard configuration | No |

## Remaining Risk

New state bundles are encrypted, but SQLite snapshots are stored separately and are not uploaded by the current S3 state-bundle path. Unified off-host packaging and isolated restore validation remain required before disaster recovery can be considered complete.

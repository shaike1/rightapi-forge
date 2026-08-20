# Backup Incident Response Runbook

Last updated: 2026-02-18

## Scope

Operational response for:
- stale or missing backups
- backup verification failures
- restore drills and confirmed restores

## Preconditions

- Service reachable (`/api/health`)
- Operator/admin credentials available
- `jq` installed for CLI checks

## 1) Triage

1. Login and export token:
```bash
TOKEN="$(
  curl -fsS -X POST http://127.0.0.1:19123/api/auth/login \
    -H 'Content-Type: application/json' \
    -d '{"username":"operator","password":"Operator123"}' \
  | jq -r '.session.token'
)"
```

2. Check backup health:
```bash
curl -fsS http://127.0.0.1:19123/api/system/backups/health \
  -H "Authorization: Bearer $TOKEN" | jq
```

3. Check operational alerts:
```bash
curl -fsS http://127.0.0.1:19123/api/alerts \
  -H "Authorization: Bearer $TOKEN" | jq '.alerts[] | select(.kind=="backup_health" or .kind=="credential_anomaly")'
```

4. Check scheduler status:
```bash
curl -fsS http://127.0.0.1:19123/api/system/backups/scheduler \
  -H "Authorization: Bearer $TOKEN" | jq
```

## 2) Immediate Remediation

### A) Trigger emergency scheduler run
```bash
curl -fsS -X POST http://127.0.0.1:19123/api/system/backups/scheduler/run \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{}' | jq
```

### B) Create + verify backup manually
```bash
BACKUP_ID="$(
  curl -fsS -X POST http://127.0.0.1:19123/api/system/backups/create \
    -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    -d '{"label":"incident-manual-backup"}' \
  | jq -r '.backup.id'
)"

curl -fsS "http://127.0.0.1:19123/api/system/backups/$BACKUP_ID/verify" \
  -H "Authorization: Bearer $TOKEN" | jq
```

## 3) Restore Drill (Dry Run)

```bash
curl -fsS -X POST "http://127.0.0.1:19123/api/system/backups/$BACKUP_ID/restore" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"dryRun":true}' | jq
```

Expected:
- `.success == true`
- `.result.dryRun == true`
- file action summary present in response

## 4) Confirmed Restore (Apply)

Use only when approved by incident commander/change owner.

```bash
curl -fsS -X POST "http://127.0.0.1:19123/api/system/backups/$BACKUP_ID/restore" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"dryRun\":false,\"confirmBackupId\":\"$BACKUP_ID\",\"confirmPhrase\":\"RESTORE\"}" | jq
```

Optional task linkage (for timeline attribution):
```bash
curl -fsS -X POST "http://127.0.0.1:19123/api/system/backups/$BACKUP_ID/restore" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"dryRun\":false,\"confirmBackupId\":\"$BACKUP_ID\",\"confirmPhrase\":\"RESTORE\",\"taskId\":\"<task-id>\"}" | jq
```

## 5) Evidence Collection Checklist

- `/api/system/backups/health` before + after
- `/api/system/backups/scheduler` before + after
- backup create/verify/restore API responses
- `/api/tasks/<taskId>/activity` (if task-linked restore used)
- `/api/audit/executions?limit=200` filtered for:
  - `system.backup.restore`
  - `system.backup.scheduler.run`

## 6) Exit Criteria

- health shows non-stale backup and successful verification
- no active critical `backup_health` alerts
- restore drill completed (or restore apply completed and validated)
- incident notes include backup ID, operator, and timestamps

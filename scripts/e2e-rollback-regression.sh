#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:19123}"
OPERATOR_USERNAME="${OPERATOR_USERNAME:-operator}"
OPERATOR_PASSWORD="${OPERATOR_PASSWORD:?Set OPERATOR_PASSWORD in the environment}"

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

need_cmd curl
need_cmd jq

echo "[1/25] Health check"
curl -fsS "$BASE_URL/api/health" >/dev/null

echo "[2/25] Login operator"
TOKEN="$(
  curl -fsS -X POST "$BASE_URL/api/auth/login" \
    -H 'Content-Type: application/json' \
    -d "{\"username\":\"$OPERATOR_USERNAME\",\"password\":\"$OPERATOR_PASSWORD\"}" \
  | jq -r '.session.token'
)"
if [[ -z "$TOKEN" || "$TOKEN" == "null" ]]; then
  echo "Login failed" >&2
  exit 1
fi

echo "[3/25] Create task"
TASK_ID="$(
  curl -fsS -X POST "$BASE_URL/api/task-queue" \
    -H 'Content-Type: application/json' \
    -d '{"title":"e2e-rollback-regression","description":"rollback flow verification","ownerId":"director","category":"security","priority":"high"}' \
  | jq -r '.id'
)"
if [[ -z "$TASK_ID" || "$TASK_ID" == "null" ]]; then
  echo "Task creation failed" >&2
  exit 1
fi

echo "[4/25] Request rollback + preview"
curl -fsS -X POST "$BASE_URL/api/tasks/$TASK_ID/rollback/request" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"reason":"e2e rollback request"}' >/dev/null

PREVIEW_JSON="$(curl -fsS "$BASE_URL/api/tasks/$TASK_ID/rollback/preview" -H "Authorization: Bearer $TOKEN")"
PREVIEW_OK="$(echo "$PREVIEW_JSON" | jq -r '.success')"
if [[ "$PREVIEW_OK" != "true" ]]; then
  echo "Rollback preview failed: $PREVIEW_JSON" >&2
  exit 1
fi

echo "[5/25] Verify apply rollback blocked without approval token"
NO_TOKEN_CODE="$(
  curl -sS -o /tmp/e2e-no-token.json -w "%{http_code}" \
    -X POST "$BASE_URL/api/tasks/$TASK_ID/rollback/apply" \
    -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    -d '{}'
)"
if [[ "$NO_TOKEN_CODE" != "403" ]]; then
  echo "Expected 403 without token, got $NO_TOKEN_CODE" >&2
  cat /tmp/e2e-no-token.json >&2 || true
  exit 1
fi

echo "[6/25] Mint approval token + apply rollback successfully"
MINT_JSON="$(
  curl -fsS -X POST "$BASE_URL/api/approvals/tokens" \
    -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    -d "{\"command\":\"task.rollback.apply\",\"agentId\":\"$OPERATOR_USERNAME\",\"reason\":\"e2e rollback\",\"ttlSeconds\":600}"
)"
APPROVAL_TOKEN="$(echo "$MINT_JSON" | jq -r '.approval.token')"
if [[ -z "$APPROVAL_TOKEN" || "$APPROVAL_TOKEN" == "null" ]]; then
  echo "Approval token mint failed: $MINT_JSON" >&2
  exit 1
fi

WITH_TOKEN_CODE="$(
  curl -sS -o /tmp/e2e-with-token.json -w "%{http_code}" \
    -X POST "$BASE_URL/api/tasks/$TASK_ID/rollback/apply" \
    -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    -d "{\"approvalToken\":\"$APPROVAL_TOKEN\"}"
)"
if [[ "$WITH_TOKEN_CODE" != "200" ]]; then
  echo "Expected 200 with valid token, got $WITH_TOKEN_CODE" >&2
  cat /tmp/e2e-with-token.json >&2 || true
  exit 1
fi

echo "[7/25] Verify token one-time use"
REUSE_CODE="$(
  curl -sS -o /tmp/e2e-reuse-token.json -w "%{http_code}" \
    -X POST "$BASE_URL/api/tasks/$TASK_ID/rollback/apply" \
    -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    -d "{\"approvalToken\":\"$APPROVAL_TOKEN\"}"
)"
if [[ "$REUSE_CODE" != "403" ]]; then
  echo "Expected 403 when reusing token, got $REUSE_CODE" >&2
  cat /tmp/e2e-reuse-token.json >&2 || true
  exit 1
fi

echo "[8/25] Verify activity endpoint filtering + pagination"
ACTIVITY_JSON="$(
  curl -fsS "$BASE_URL/api/tasks/$TASK_ID/activity?source=execution_audit&search=task.rollback.apply&limit=1" \
    -H "Authorization: Bearer $TOKEN"
)"
FEED_COUNT="$(echo "$ACTIVITY_JSON" | jq -r '.feed | length')"
FIRST_SOURCE="$(echo "$ACTIVITY_JSON" | jq -r '.feed[0].source // empty')"
HAS_MORE="$(echo "$ACTIVITY_JSON" | jq -r '.pageInfo.hasMore')"
if [[ "$FEED_COUNT" -lt 1 || "$FIRST_SOURCE" != "execution_audit" ]]; then
  echo "Activity filter failed: $ACTIVITY_JSON" >&2
  exit 1
fi

if [[ "$HAS_MORE" == "true" ]]; then
  CURSOR="$(echo "$ACTIVITY_JSON" | jq -r '.pageInfo.nextCursor')"
  NEXT_JSON="$(
    curl -fsS "$BASE_URL/api/tasks/$TASK_ID/activity?source=execution_audit&search=task.rollback.apply&limit=1&cursor=$CURSOR" \
      -H "Authorization: Bearer $TOKEN"
  )"
  echo "$NEXT_JSON" | jq -e '.feed | type=="array"' >/dev/null
fi

echo "[9/25] Verify capability matrix endpoint"
CAP_JSON="$(
  curl -fsS "$BASE_URL/api/agents/capabilities" \
    -H "Authorization: Bearer $TOKEN"
)"
echo "$CAP_JSON" | jq -e '.capabilities | type=="array"' >/dev/null

echo "[10/25] Verify operational alerts endpoint"
ALERT_JSON="$(
  curl -fsS "$BASE_URL/api/alerts" \
    -H "Authorization: Bearer $TOKEN"
)"
echo "$ALERT_JSON" | jq -e '.alerts | type=="array"' >/dev/null

echo "[11/25] Verify high-impact delegation transition blocked without token"
DEL_TASK_ID="$(
  curl -fsS -X POST "$BASE_URL/api/task-queue" \
    -H 'Content-Type: application/json' \
    -d '{"title":"e2e-delegation-guard","description":"high-impact delegation test","ownerId":"director","category":"deployment","priority":"critical"}' \
  | jq -r '.id'
)"
AGENTS_JSON="$(curl -fsS "$BASE_URL/api/agents")"
REQ_AGENT="$(echo "$AGENTS_JSON" | jq -r '.director.id')"
ASG_AGENT="$(echo "$AGENTS_JSON" | jq -r '(.sysadmins[0].id // .director.id)')"
DEL_JSON="$(
  curl -fsS -X POST "$BASE_URL/api/delegations" \
    -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    -d "{\"parentTaskId\":\"$DEL_TASK_ID\",\"requesterAgentId\":\"$REQ_AGENT\",\"assigneeAgentId\":\"$ASG_AGENT\",\"objective\":\"deploy production release\"}"
)"
DEL_ID="$(echo "$DEL_JSON" | jq -r '.delegation.id')"
DEL_BLOCK_CODE="$(
  curl -sS -o /tmp/e2e-del-block.json -w "%{http_code}" \
    -X POST "$BASE_URL/api/delegations/$DEL_ID/transition" \
    -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    -d '{"nextState":"approved"}'
)"
if [[ "$DEL_BLOCK_CODE" != "403" ]]; then
  echo "Expected delegation transition to be blocked without token, got $DEL_BLOCK_CODE" >&2
  cat /tmp/e2e-del-block.json >&2 || true
  exit 1
fi

echo "[12/25] Verify high-impact delegation transition succeeds with token"
DEL_APPR_TOKEN="$(
  curl -fsS -X POST "$BASE_URL/api/approvals/tokens" \
    -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    -d "{\"command\":\"delegation.dispatch\",\"agentId\":\"$OPERATOR_USERNAME\",\"reason\":\"e2e delegation approval\",\"ttlSeconds\":600}" \
  | jq -r '.approval.token'
)"
DEL_OK_CODE="$(
  curl -sS -o /tmp/e2e-del-ok.json -w "%{http_code}" \
    -X POST "$BASE_URL/api/delegations/$DEL_ID/transition" \
    -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    -d "{\"nextState\":\"approved\",\"approvalToken\":\"$DEL_APPR_TOKEN\"}"
)"
if [[ "$DEL_OK_CODE" != "200" ]]; then
  echo "Expected delegation transition to succeed with token, got $DEL_OK_CODE" >&2
  cat /tmp/e2e-del-ok.json >&2 || true
  exit 1
fi

echo "[13/25] Verify delegation detail endpoint"
DEL_DETAIL_JSON="$(
  curl -fsS "$BASE_URL/api/delegations/$DEL_ID" \
    -H "Authorization: Bearer $TOKEN"
)"
echo "$DEL_DETAIL_JSON" | jq -e '.delegation.id == "'"$DEL_ID"'"' >/dev/null
echo "$DEL_DETAIL_JSON" | jq -e '.history | type=="array"' >/dev/null

echo "[14/25] Verify REST task status endpoint"
STATUS_CODE="$(
  curl -sS -o /tmp/e2e-status-ok.json -w "%{http_code}" \
    -X PUT "$BASE_URL/api/tasks/$TASK_ID/status" \
    -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    -d '{"status":"in_progress"}'
)"
if [[ "$STATUS_CODE" != "200" ]]; then
  echo "Expected 200 for valid task status update, got $STATUS_CODE" >&2
  cat /tmp/e2e-status-ok.json >&2 || true
  exit 1
fi

BAD_STATUS_CODE="$(
  curl -sS -o /tmp/e2e-status-bad.json -w "%{http_code}" \
    -X PUT "$BASE_URL/api/tasks/$TASK_ID/status" \
    -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    -d '{"status":"not_a_real_status"}'
)"
if [[ "$BAD_STATUS_CODE" != "400" ]]; then
  echo "Expected 400 for invalid task status, got $BAD_STATUS_CODE" >&2
  cat /tmp/e2e-status-bad.json >&2 || true
  exit 1
fi

echo "[15/25] Verify running operations endpoint"
RUNNING_JSON="$(
  curl -fsS "$BASE_URL/api/operations/running" \
    -H "Authorization: Bearer $TOKEN"
)"
echo "$RUNNING_JSON" | jq -e '.summary.activeTaskCount >= 0' >/dev/null
echo "$RUNNING_JSON" | jq -e '.activeTasks | type=="array"' >/dev/null
echo "$RUNNING_JSON" | jq -e '.activeDelegations | type=="array"' >/dev/null
echo "$RUNNING_JSON" | jq -e '.executionSlots | type=="array"' >/dev/null

echo "[16/25] Verify running operations filters"
FILTERED_RUNNING_JSON="$(
  curl -fsS "$BASE_URL/api/operations/running?riskLevel=high&delegationState=approved&limit=10" \
    -H "Authorization: Bearer $TOKEN"
)"
echo "$FILTERED_RUNNING_JSON" | jq -e '.filters.riskLevel == "high"' >/dev/null
echo "$FILTERED_RUNNING_JSON" | jq -e '.filters.delegationState == "approved"' >/dev/null

echo "[16b/25] Verify orchestrator reliability status"
ORCH_STATUS_JSON="$(
  curl -fsS "$BASE_URL/api/orchestrator/status" \
    -H "Authorization: Bearer $TOKEN"
)"
echo "$ORCH_STATUS_JSON" | jq -e '.reliability.autoRecoverEnabled | type=="boolean"' >/dev/null
echo "$ORCH_STATUS_JSON" | jq -e '.reliability.retryLimit >= 0' >/dev/null
echo "$ORCH_STATUS_JSON" | jq -e '.reliability.recentActions | type=="array"' >/dev/null

echo "[17/25] Verify agent metrics endpoint"
METRICS_JSON="$(
  curl -fsS "$BASE_URL/api/agents/metrics" \
    -H "Authorization: Bearer $TOKEN"
)"
echo "$METRICS_JSON" | jq -e '.agents | type=="array"' >/dev/null

echo "[18/25] Verify concurrency policy endpoint"
CONCURRENCY_JSON="$(
  curl -fsS "$BASE_URL/api/tools/concurrency-policy" \
    -H "Authorization: Bearer $TOKEN"
)"
echo "$CONCURRENCY_JSON" | jq -e '.policy.byRisk.safe >= 1' >/dev/null
echo "$CONCURRENCY_JSON" | jq -e '.policy.byRisk.privileged >= 1' >/dev/null
echo "$CONCURRENCY_JSON" | jq -e '.policy.byRisk.destructive >= 1' >/dev/null
SAFE_LIMIT="$(echo "$CONCURRENCY_JSON" | jq -r '.policy.byRisk.safe')"
PRIV_LIMIT="$(echo "$CONCURRENCY_JSON" | jq -r '.policy.byRisk.privileged')"
DEST_LIMIT="$(echo "$CONCURRENCY_JSON" | jq -r '.policy.byRisk.destructive')"
CONC_REV="$(echo "$CONCURRENCY_JSON" | jq -r '.revision')"
UPDATE_CONC_CODE="$(
  curl -sS -o /tmp/e2e-conc-update.json -w "%{http_code}" \
    -X POST "$BASE_URL/api/tools/concurrency-policy" \
    -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    -d "{\"expectedRevision\":$CONC_REV,\"byRisk\":{\"safe\":$SAFE_LIMIT,\"privileged\":$PRIV_LIMIT,\"destructive\":$DEST_LIMIT},\"byCommand\":{}}"
)"
if [[ "$UPDATE_CONC_CODE" != "200" ]]; then
  echo "Expected 200 updating concurrency policy, got $UPDATE_CONC_CODE" >&2
  cat /tmp/e2e-conc-update.json >&2 || true
  exit 1
fi

echo "[18b/25] Verify target allowlist policy endpoint"
ALLOWLIST_JSON="$(
  curl -fsS "$BASE_URL/api/tools/target-allowlist-policy" \
    -H "Authorization: Bearer $TOKEN"
)"
echo "$ALLOWLIST_JSON" | jq -e '.policy.enabled | type=="boolean"' >/dev/null
echo "$ALLOWLIST_JSON" | jq -e '.policy.targets | type=="array"' >/dev/null
ALLOWLIST_REV="$(echo "$ALLOWLIST_JSON" | jq -r '.revision')"
ALLOWLIST_ENABLED="$(echo "$ALLOWLIST_JSON" | jq -r '.policy.enabled')"
ALLOWLIST_TARGETS="$(echo "$ALLOWLIST_JSON" | jq -c '.policy.targets')"
ALLOWLIST_RISKS="$(echo "$ALLOWLIST_JSON" | jq -c '.policy.enforceForRisks')"
UPDATE_ALLOWLIST_CODE="$(
  curl -sS -o /tmp/e2e-allowlist-update.json -w "%{http_code}" \
    -X POST "$BASE_URL/api/tools/target-allowlist-policy" \
    -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    -d "{\"expectedRevision\":$ALLOWLIST_REV,\"enabled\":$ALLOWLIST_ENABLED,\"targets\":$ALLOWLIST_TARGETS,\"enforceForRisks\":$ALLOWLIST_RISKS}"
)"
if [[ "$UPDATE_ALLOWLIST_CODE" != "200" ]]; then
  echo "Expected 200 updating target allowlist policy, got $UPDATE_ALLOWLIST_CODE" >&2
  cat /tmp/e2e-allowlist-update.json >&2 || true
  exit 1
fi

echo "[19/25] Verify SLA trends endpoint"
SLA_JSON="$(
  curl -fsS "$BASE_URL/api/metrics/sla?windowHours=24" \
    -H "Authorization: Bearer $TOKEN"
)"
echo "$SLA_JSON" | jq -e '.windowHours == 24' >/dev/null
echo "$SLA_JSON" | jq -e '.buckets | type=="array"' >/dev/null
echo "$SLA_JSON" | jq -e '.agentSummary | type=="array"' >/dev/null

echo "[20/25] Verify SLA snapshots list endpoint"
SLA_SNAPSHOTS_JSON="$(
  curl -fsS "$BASE_URL/api/metrics/sla/snapshots?limit=5" \
    -H "Authorization: Bearer $TOKEN"
)"
echo "$SLA_SNAPSHOTS_JSON" | jq -e '.snapshots | type=="array"' >/dev/null

echo "[21/25] Verify SLA snapshot capture endpoint"
SLA_CAPTURE_CODE="$(
  curl -sS -o /tmp/e2e-sla-capture.json -w "%{http_code}" \
    -X POST "$BASE_URL/api/metrics/sla/snapshots/capture" \
    -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    -d '{"windowHours":24}'
)"
if [[ "$SLA_CAPTURE_CODE" != "200" ]]; then
  echo "Expected 200 for SLA snapshot capture, got $SLA_CAPTURE_CODE" >&2
  cat /tmp/e2e-sla-capture.json >&2 || true
  exit 1
fi

echo "[22/25] Verify SLA snapshot policy endpoint"
SLA_POLICY_JSON="$(
  curl -fsS "$BASE_URL/api/metrics/sla/snapshot-policy" \
    -H "Authorization: Bearer $TOKEN"
)"
echo "$SLA_POLICY_JSON" | jq -e '.policy.defaultWindowHours >= 1' >/dev/null
echo "$SLA_POLICY_JSON" | jq -e '.policy.captureIntervalMs >= 10000' >/dev/null

echo "[23/25] Verify policy export endpoint"
POLICY_EXPORT_JSON="$(
  curl -fsS "$BASE_URL/api/policies/export" \
    -H "Authorization: Bearer $TOKEN"
)"
echo "$POLICY_EXPORT_JSON" | jq -e '.payload.delegationPolicy | type=="object"' >/dev/null
echo "$POLICY_EXPORT_JSON" | jq -e '.payload.concurrencyPolicy | type=="object"' >/dev/null
echo "$POLICY_EXPORT_JSON" | jq -e '.payload.targetAllowlistPolicy | type=="object"' >/dev/null
echo "$POLICY_EXPORT_JSON" | jq -e '.signature | type=="string"' >/dev/null

echo "[24/25] Verify policy import endpoint (signed payload roundtrip)"
POLICY_IMPORT_CODE="$(
  echo "$POLICY_EXPORT_JSON" | curl -sS -o /tmp/e2e-policy-import.json -w "%{http_code}" \
    -X POST "$BASE_URL/api/policies/import" \
    -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    -d @-
)"
if [[ "$POLICY_IMPORT_CODE" != "200" ]]; then
  echo "Expected 200 importing signed policy bundle, got $POLICY_IMPORT_CODE" >&2
  cat /tmp/e2e-policy-import.json >&2 || true
  exit 1
fi

echo "[25/25] Verify policy audit endpoint"
POLICY_AUDIT_JSON="$(
  curl -fsS "$BASE_URL/api/policies/audit?limit=20" \
    -H "Authorization: Bearer $TOKEN"
)"
echo "$POLICY_AUDIT_JSON" | jq -e '.records | type=="array"' >/dev/null

echo "[26/29] Verify backup create endpoint"
BACKUP_CREATE_JSON="$(
  curl -fsS -X POST "$BASE_URL/api/system/backups/create" \
    -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    -d '{"label":"e2e-backup"}'
)"
BACKUP_ID="$(echo "$BACKUP_CREATE_JSON" | jq -r '.backup.id')"
if [[ -z "$BACKUP_ID" || "$BACKUP_ID" == "null" ]]; then
  echo "Backup creation failed: $BACKUP_CREATE_JSON" >&2
  exit 1
fi

echo "[27/29] Verify backups list endpoint"
BACKUP_LIST_JSON="$(
  curl -fsS "$BASE_URL/api/system/backups?limit=10" \
    -H "Authorization: Bearer $TOKEN"
)"
echo "$BACKUP_LIST_JSON" | jq -e '.backups | type=="array"' >/dev/null
echo "$BACKUP_LIST_JSON" | jq -e '.backups[] | select(.id == "'"$BACKUP_ID"'")' >/dev/null

echo "[28/29] Verify backup integrity endpoint"
BACKUP_VERIFY_JSON="$(
  curl -fsS "$BASE_URL/api/system/backups/$BACKUP_ID/verify" \
    -H "Authorization: Bearer $TOKEN"
)"
echo "$BACKUP_VERIFY_JSON" | jq -e '.ok == true' >/dev/null
echo "$BACKUP_VERIFY_JSON" | jq -e '.checks | type=="array"' >/dev/null

echo "[29/29] Verify backup restore dry-run endpoint"
BACKUP_RESTORE_JSON="$(
  curl -fsS -X POST "$BASE_URL/api/system/backups/$BACKUP_ID/restore" \
    -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    -d '{"dryRun":true}'
)"
echo "$BACKUP_RESTORE_JSON" | jq -e '.success == true' >/dev/null
echo "$BACKUP_RESTORE_JSON" | jq -e '.result.dryRun == true' >/dev/null

echo "[30/33] Verify restore attribution links into task activity feed"
BACKUP_RESTORE_ATTR_JSON="$(
  curl -fsS -X POST "$BASE_URL/api/system/backups/$BACKUP_ID/restore" \
    -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    -d "{\"dryRun\":true,\"taskId\":\"$TASK_ID\"}"
)"
echo "$BACKUP_RESTORE_ATTR_JSON" | jq -e '.success == true' >/dev/null
RESTORE_ACTIVITY_JSON="$(
  curl -fsS "$BASE_URL/api/tasks/$TASK_ID/activity?source=task_operation&search=backup%20restore&limit=20" \
    -H "Authorization: Bearer $TOKEN"
)"
echo "$RESTORE_ACTIVITY_JSON" | jq -e '.feed | map(.payload.summary // "") | join(" ") | ascii_downcase | contains("backup restore")' >/dev/null

echo "[31/33] Verify backup scheduler status + manual scheduler run endpoint"
BACKUP_SCHEDULER_STATUS_JSON="$(
  curl -fsS "$BASE_URL/api/system/backups/scheduler" \
    -H "Authorization: Bearer $TOKEN"
)"
echo "$BACKUP_SCHEDULER_STATUS_JSON" | jq -e '.scheduler.intervalMinutes >= 5' >/dev/null
BACKUP_SCHEDULER_RUN_JSON="$(
  curl -fsS -X POST "$BASE_URL/api/system/backups/scheduler/run" \
    -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    -d '{}'
)"
echo "$BACKUP_SCHEDULER_RUN_JSON" | jq -e '.success == true' >/dev/null
echo "$BACKUP_SCHEDULER_RUN_JSON" | jq -e '.scheduler.lastSuccessAt | type=="string"' >/dev/null

echo "[32/33] Verify backup health endpoint structure"
BACKUP_HEALTH_JSON="$(
  curl -fsS "$BASE_URL/api/system/backups/health" \
    -H "Authorization: Bearer $TOKEN"
)"
echo "$BACKUP_HEALTH_JSON" | jq -e '.thresholdHours >= 1' >/dev/null
echo "$BACKUP_HEALTH_JSON" | jq -e '.stale | type=="boolean"' >/dev/null
echo "$BACKUP_HEALTH_JSON" | jq -e '.latestBackup.id | type=="string"' >/dev/null

echo "[33/33] Verify backup health alerts are present and typed"
BACKUP_ALERTS_JSON="$(
  curl -fsS "$BASE_URL/api/alerts" \
    -H "Authorization: Bearer $TOKEN"
)"
echo "$BACKUP_ALERTS_JSON" | jq -e '.alerts | type=="array"' >/dev/null
echo "$BACKUP_ALERTS_JSON" | jq -e '.alerts | all(.kind != null)' >/dev/null

echo "PASS: rollback + backup regression flow completed successfully for task $TASK_ID"

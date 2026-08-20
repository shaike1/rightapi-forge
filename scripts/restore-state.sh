#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:19123}"
OPERATOR_USERNAME="${OPERATOR_USERNAME:-operator}"
OPERATOR_PASSWORD="${OPERATOR_PASSWORD:?Set OPERATOR_PASSWORD in the environment}"
BACKUP_ID="${1:-}"
MODE="${2:---dry-run}"

if [[ -z "$BACKUP_ID" ]]; then
  echo "Usage: $0 <backup_id> [--dry-run|--apply]" >&2
  exit 1
fi

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

need_cmd curl
need_cmd jq

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

if [[ "$MODE" == "--apply" ]]; then
  echo "Applying restore for backup $BACKUP_ID"
  curl -fsS -X POST "$BASE_URL/api/system/backups/$BACKUP_ID/restore" \
    -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    -d "{\"dryRun\":false,\"confirmBackupId\":\"$BACKUP_ID\",\"confirmPhrase\":\"RESTORE\"}" | jq
  exit 0
fi

echo "Running restore dry-run for backup $BACKUP_ID"
curl -fsS -X POST "$BASE_URL/api/system/backups/$BACKUP_ID/restore" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"dryRun":true}' | jq

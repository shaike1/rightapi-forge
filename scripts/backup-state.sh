#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:19123}"
OPERATOR_USERNAME="${OPERATOR_USERNAME:-operator}"
OPERATOR_PASSWORD="${OPERATOR_PASSWORD:?Set OPERATOR_PASSWORD in the environment}"
ACTION="${1:-create}"
ACTION_ARG="${2:-}"
STATE_BACKUP_DIR="${STATE_BACKUP_DIR:-/data/itops-agents/backups}"
RETENTION_KEEP_LATEST="${RETENTION_KEEP_LATEST:-30}"
RETENTION_MAX_AGE_DAYS="${RETENTION_MAX_AGE_DAYS:-14}"
API_LIST_LIMIT="${API_LIST_LIMIT:-500}"

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

fetch_backups_json() {
  curl -fsS "$BASE_URL/api/system/backups?limit=$API_LIST_LIMIT" \
    -H "Authorization: Bearer $TOKEN"
}

create_backup() {
  local label="$1"
  local create_json created_id
  create_json="$(
    curl -fsS -X POST "$BASE_URL/api/system/backups/create" \
      -H "Authorization: Bearer $TOKEN" \
      -H 'Content-Type: application/json' \
      -d "{\"label\":\"$label\"}"
  )"
  created_id="$(echo "$create_json" | jq -r '.backup.id')"
  if [[ -z "$created_id" || "$created_id" == "null" ]]; then
    echo "Backup creation failed: $create_json" >&2
    exit 1
  fi
  echo "$create_json" | jq
  echo "Verifying backup: $created_id"
  curl -fsS "$BASE_URL/api/system/backups/$created_id/verify" \
    -H "Authorization: Bearer $TOKEN" | jq
}

prune_backups() {
  local now_ts keep_latest max_age_days deleted kept total
  now_ts="$(date -u +%s)"
  keep_latest="$RETENTION_KEEP_LATEST"
  max_age_days="$RETENTION_MAX_AGE_DAYS"
  deleted=0
  kept=0
  total=0

  if ! [[ "$keep_latest" =~ ^[0-9]+$ ]] || ! [[ "$max_age_days" =~ ^[0-9]+$ ]]; then
    echo "RETENTION_KEEP_LATEST and RETENTION_MAX_AGE_DAYS must be non-negative integers" >&2
    exit 1
  fi

  echo "Pruning backups with policy: keep_latest=$keep_latest, max_age_days=$max_age_days, dir=$STATE_BACKUP_DIR"
  while IFS='|' read -r idx backup_id created_at bundle_path; do
    [[ -z "$backup_id" ]] && continue
    total=$((total + 1))
    if (( idx <= keep_latest )); then
      kept=$((kept + 1))
      continue
    fi

    created_ts="$(date -u -d "$created_at" +%s 2>/dev/null || echo 0)"
    if (( created_ts == 0 )); then
      echo "Skipping backup with unparseable timestamp: $backup_id ($created_at)"
      kept=$((kept + 1))
      continue
    fi
    age_days="$(( (now_ts - created_ts) / 86400 ))"
    if (( age_days <= max_age_days )); then
      kept=$((kept + 1))
      continue
    fi

    case "$bundle_path" in
      "$STATE_BACKUP_DIR"/*.json)
        if [[ -f "$bundle_path" ]]; then
          rm -f "$bundle_path"
          deleted=$((deleted + 1))
          echo "Deleted: $backup_id ($bundle_path, age=${age_days}d)"
        else
          echo "Missing file (already removed): $bundle_path"
        fi
        ;;
      *)
        echo "Refusing to delete path outside backup dir: $bundle_path"
        kept=$((kept + 1))
        ;;
    esac
  done < <(
    fetch_backups_json \
      | jq -r '.backups | to_entries[] | "\(.key + 1)|\(.value.id)|\(.value.createdAt)|\(.value.bundlePath)"'
  )

  echo "Prune complete: total=$total kept=$kept deleted=$deleted"
}

case "$ACTION" in
  list)
    fetch_backups_json | jq
    ;;
  verify)
    if [[ -z "$ACTION_ARG" ]]; then
      echo "Usage: $0 verify <backup_id>" >&2
      exit 1
    fi
    curl -fsS "$BASE_URL/api/system/backups/$ACTION_ARG/verify" \
      -H "Authorization: Bearer $TOKEN" | jq
    ;;
  create)
    LABEL="${ACTION_ARG:-scheduled-$(date -u +%Y%m%dT%H%M%SZ)}"
    create_backup "$LABEL"
    ;;
  prune)
    prune_backups
    ;;
  run)
    LABEL="${ACTION_ARG:-scheduled-$(date -u +%Y%m%dT%H%M%SZ)}"
    create_backup "$LABEL"
    prune_backups
    ;;
  *)
    echo "Usage: $0 [create|list|verify|prune|run] [arg]" >&2
    echo "  create [label]  - create + verify backup" >&2
    echo "  verify <id>     - verify backup integrity" >&2
    echo "  list            - list backups" >&2
    echo "  prune           - prune by RETENTION_KEEP_LATEST and RETENTION_MAX_AGE_DAYS" >&2
    echo "  run [label]     - create + verify + prune (scheduler-friendly)" >&2
    exit 1
    ;;
esac

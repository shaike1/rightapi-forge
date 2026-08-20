#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${1:-.env}"
BACKUP_FILE="${ENV_FILE}.backup.$(date -u +%Y%m%dT%H%M%SZ)"

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

need_cmd openssl
need_cmd awk

rand_hex() {
  openssl rand -hex "$1"
}

ensure_file() {
  if [[ ! -f "$ENV_FILE" ]]; then
    cat > "$ENV_FILE" <<'EOF'
# Auto-created secure environment file
EOF
  fi
}

upsert_kv() {
  local key="$1"
  local value="$2"
  local tmp
  tmp="$(mktemp)"
  if grep -q "^${key}=" "$ENV_FILE"; then
    awk -v k="$key" -v v="$value" 'BEGIN{FS=OFS="="} $1==k{$0=k"="v} {print}' "$ENV_FILE" > "$tmp"
    mv "$tmp" "$ENV_FILE"
  else
    printf "%s=%s\n" "$key" "$value" >> "$ENV_FILE"
    rm -f "$tmp"
  fi
}

ensure_file
cp "$ENV_FILE" "$BACKUP_FILE"

upsert_kv "ADMIN_PASSWORD" "$(rand_hex 24)"
upsert_kv "OPERATOR_PASSWORD" "$(rand_hex 24)"
upsert_kv "VIEWER_PASSWORD" "$(rand_hex 24)"
upsert_kv "CREDENTIAL_MASTER_KEY" "$(rand_hex 48)"
upsert_kv "APPROVAL_TOKEN_SECRET" "$(rand_hex 48)"
upsert_kv "AUTH_TOKEN_SECRET" "$(rand_hex 48)"
upsert_kv "REQUIRE_STRONG_SECRETS" "true"

echo "Updated secure secrets in $ENV_FILE"
echo "Backup saved to $BACKUP_FILE"

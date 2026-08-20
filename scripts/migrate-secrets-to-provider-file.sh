#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${1:-.env}"
VOLUME_NAME="${2:-itops-data}"
OUTPUT_FILE="${3:-secret-provider.json}"

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

need_cmd docker
need_cmd awk
need_cmd mktemp

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Env file not found: $ENV_FILE" >&2
  exit 1
fi

get_kv() {
  local key="$1"
  local value
  value="$(awk -F= -v k="$key" '$1==k { sub(/^[^=]*=/, ""); print; exit }' "$ENV_FILE" || true)"
  if [[ -z "${value:-}" ]]; then
    value="${!key:-}"
  fi
  if [[ -z "${value:-}" ]]; then
    echo "Missing required secret: $key" >&2
    exit 1
  fi
  printf "%s" "$value"
}

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

credential_master_key="$(get_kv CREDENTIAL_MASTER_KEY)"
approval_token_secret="$(get_kv APPROVAL_TOKEN_SECRET)"
auth_token_secret="$(get_kv AUTH_TOKEN_SECRET)"
admin_password="$(get_kv ADMIN_PASSWORD)"
operator_password="$(get_kv OPERATOR_PASSWORD)"
viewer_password="$(get_kv VIEWER_PASSWORD)"

tmp_json="$(mktemp)"
cat > "$tmp_json" <<EOF
{
  "version": 1,
  "updatedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "secrets": {
    "credential_master_key": "$(json_escape "$credential_master_key")",
    "approval_token_secret": "$(json_escape "$approval_token_secret")",
    "auth_token_secret": "$(json_escape "$auth_token_secret")",
    "admin_password": "$(json_escape "$admin_password")",
    "operator_password": "$(json_escape "$operator_password")",
    "viewer_password": "$(json_escape "$viewer_password")"
  }
}
EOF

docker run --rm \
  -v "${VOLUME_NAME}:/data" \
  -v "${tmp_json}:/tmp/provider.json:ro" \
  alpine:3.20 \
  sh -lc "cp /tmp/provider.json /data/${OUTPUT_FILE} && chmod 600 /data/${OUTPUT_FILE}"

rm -f "$tmp_json"
echo "Wrote provider secrets to volume '${VOLUME_NAME}': /${OUTPUT_FILE}"

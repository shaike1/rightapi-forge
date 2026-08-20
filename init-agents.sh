#!/bin/bash
set -euo pipefail

API_BASE="${API_BASE:-http://localhost:19123}"
ADMIN_USERNAME="${ADMIN_USERNAME:-admin}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-${DEFAULT_ACCOUNT_PASSWORD:-}}"
LOGIN_RETRIES="${LOGIN_RETRIES:-12}"
LOGIN_RETRY_DELAY="${LOGIN_RETRY_DELAY:-5}"

if ! command -v curl >/dev/null 2>&1; then
  echo "❌ curl is required"
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "❌ jq is required"
  exit 1
fi

if [ -z "$ADMIN_PASSWORD" ]; then
  echo "ADMIN_PASSWORD or DEFAULT_ACCOUNT_PASSWORD is required" >&2
  exit 1
fi

echo "🔄 Initializing RightAPI Forge..."
echo "🌐 API base: $API_BASE"

TOKEN=""
for attempt in $(seq 1 "$LOGIN_RETRIES"); do
  response=$(curl -sS -X POST "$API_BASE/api/auth/login" \
    -H 'Content-Type: application/json' \
    -d "{\"username\":\"$ADMIN_USERNAME\",\"password\":\"$ADMIN_PASSWORD\"}" || true)

  TOKEN=$(printf '%s' "$response" | jq -r '.session.token // empty' 2>/dev/null || true)
  if [ -n "$TOKEN" ]; then
    break
  fi

  echo "⏳ Login attempt $attempt/$LOGIN_RETRIES failed, waiting ${LOGIN_RETRY_DELAY}s..."
  sleep "$LOGIN_RETRY_DELAY"
done

if [ -z "$TOKEN" ]; then
  echo "❌ Failed to get token from $API_BASE/api/auth/login"
  exit 1
fi

echo "✅ Logged in"

agents_json=$(curl -sS \
  -H "Authorization: Bearer $TOKEN" \
  "$API_BASE/api/agents")

has_agent() {
  local name="$1"
  printf '%s' "$agents_json" | jq -e --arg name "$name" '
    ([.director?] + (.sysadmins // []) + (.specialists // []))
    | map(select(.name == $name))
    | length > 0
  ' >/dev/null
}

create_agent() {
  local payload="$1"
  local label="$2"

  local tmp_file
  tmp_file=$(mktemp)
  local http_code
  http_code=$(curl -sS -o "$tmp_file" -w '%{http_code}' -X POST "$API_BASE/api/agents" \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $TOKEN" \
    -d "$payload")

  if [ "$http_code" -lt 200 ] || [ "$http_code" -ge 300 ]; then
    echo "❌ Failed to create $label (HTTP $http_code)"
    cat "$tmp_file"
    rm -f "$tmp_file"
    exit 1
  fi

  rm -f "$tmp_file"
  echo "✅ Created $label"
}

existing_count=$(printf '%s' "$agents_json" | jq '
  ([.director?] + (.sysadmins // []) + (.specialists // [])) | length
')
echo "👥 Existing agents: $existing_count"

if has_agent "Alice"; then
  echo "↩️ Alice already exists, skipping"
else
  create_agent '{"name":"Alice","role":"sysadmin","platform":"claude"}' 'Alice'
fi

PLATFORM="${DEFAULT_AI_PLATFORM:-ollama}"
echo "📝 Ensuring agents (platform: $PLATFORM)..."

# All creates below are idempotent: has_agent checks the snapshot taken
# at the top of this script, so a name that's already present is
# skipped instead of being re-created. Without these guards every
# container restart would add a new duplicate per name, which is the
# bug that produced 6× copies of Ops Alpha / Ops Bravo / Dev Builder /
# Dev Reviewer in the first place.

# SysAdmins — general infrastructure + ops
if has_agent "Ops Alpha"; then
  echo "↩️ Ops Alpha already exists, skipping"
else
  create_agent "{\"name\":\"Ops Alpha\",\"role\":\"sysadmin\",\"platform\":\"$PLATFORM\",\"skills\":[\"server-management\",\"monitoring\",\"docker\",\"linux\",\"bash\",\"ssh\"]}" 'Ops Alpha (sysadmin)'
fi

if has_agent "Ops Bravo"; then
  echo "↩️ Ops Bravo already exists, skipping"
else
  create_agent "{\"name\":\"Ops Bravo\",\"role\":\"sysadmin\",\"platform\":\"$PLATFORM\",\"skills\":[\"server-management\",\"monitoring\",\"docker\",\"linux\",\"bash\",\"ssh\"]}" 'Ops Bravo (sysadmin)'
fi

# Specialists — domain experts
if has_agent "Dev Builder"; then
  echo "↩️ Dev Builder already exists, skipping"
else
  create_agent "{\"name\":\"Dev Builder\",\"role\":\"specialist\",\"specialty\":\"deployment\",\"platform\":\"$PLATFORM\",\"skills\":[\"deployment\",\"docker\",\"bash\",\"infrastructure\"]}" 'Dev Builder (deployment specialist)'
fi

if has_agent "Dev Reviewer"; then
  echo "↩️ Dev Reviewer already exists, skipping"
else
  create_agent "{\"name\":\"Dev Reviewer\",\"role\":\"specialist\",\"specialty\":\"security\",\"platform\":\"$PLATFORM\",\"skills\":[\"security\",\"network\",\"bash\",\"ssh\"]}" 'Dev Reviewer (security specialist)'
fi

echo "✅ Agent set ensured."

#!/usr/bin/env bash
set -euo pipefail

OUT_FILE="${1:-.env.generated}"

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

need_cmd openssl

rand_token() {
  openssl rand -hex 24
}

cat > "$OUT_FILE" <<EOF
# Generated on $(date -u +"%Y-%m-%dT%H:%M:%SZ")
# Review and merge into your runtime env file.

ADMIN_PASSWORD=$(rand_token)
OPERATOR_PASSWORD=$(rand_token)
VIEWER_PASSWORD=$(rand_token)
CREDENTIAL_MASTER_KEY=$(rand_token)$(rand_token)
APPROVAL_TOKEN_SECRET=$(rand_token)$(rand_token)
AUTH_TOKEN_SECRET=$(rand_token)$(rand_token)

# Optional: turn on strict startup checks once values are in place.
REQUIRE_STRONG_SECRETS=true
EOF

echo "Generated secrets template: $OUT_FILE"

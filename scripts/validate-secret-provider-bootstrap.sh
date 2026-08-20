#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<USAGE
Usage:
  scripts/validate-secret-provider-bootstrap.sh --provider <aws_sm|gcp_sm|azure_kv> [options]

Options:
  --provider <name>       Required provider mode.
  --env-file <path>       Env file to load (default: .env).
  --api-base <url>        Optional API base for smoke check (example: http://localhost:19123).
  --token <token>         Bearer token for /api/security/status smoke check.
  --skip-auth-check       Skip cloud CLI auth bootstrap verification.
  --skip-api-check        Skip /api/security/status smoke check.
  -h, --help              Show this help.
USAGE
}

PROVIDER=""
ENV_FILE=".env"
API_BASE=""
TOKEN=""
SKIP_AUTH_CHECK="false"
SKIP_API_CHECK="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --provider)
      PROVIDER="${2:-}"
      shift 2
      ;;
    --env-file)
      ENV_FILE="${2:-}"
      shift 2
      ;;
    --api-base)
      API_BASE="${2:-}"
      shift 2
      ;;
    --token)
      TOKEN="${2:-}"
      shift 2
      ;;
    --skip-auth-check)
      SKIP_AUTH_CHECK="true"
      shift
      ;;
    --skip-api-check)
      SKIP_API_CHECK="true"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 2
      ;;
  esac
done

if [[ -z "$PROVIDER" ]]; then
  echo "Missing --provider" >&2
  usage
  exit 2
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Env file not found: $ENV_FILE" >&2
  exit 2
fi

load_env_file() {
  local env_path="$1"
  while IFS= read -r raw_line || [[ -n "$raw_line" ]]; do
    local line="${raw_line%$'\r'}"
    [[ -z "$line" ]] && continue
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" != *=* ]] && continue

    local key="${line%%=*}"
    local value="${line#*=}"
    key="$(echo "$key" | tr -d '[:space:]')"
    [[ -z "$key" ]] && continue

    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    if [[ "$value" =~ ^\".*\"$ ]]; then
      value="${value:1:${#value}-2}"
    elif [[ "$value" =~ ^\'.*\'$ ]]; then
      value="${value:1:${#value}-2}"
    fi
    export "$key=$value"
  done < "$env_path"
}

case "$PROVIDER" in
  aws_sm|gcp_sm|azure_kv)
    ;;
  *)
    echo "Unsupported provider '$PROVIDER'. Use aws_sm, gcp_sm, or azure_kv." >&2
    exit 2
    ;;
esac

load_env_file "$ENV_FILE"

required_secrets=(
  CREDENTIAL_MASTER_KEY
  APPROVAL_TOKEN_SECRET
  AUTH_TOKEN_SECRET
  ADMIN_PASSWORD
  OPERATOR_PASSWORD
  VIEWER_PASSWORD
)

errors=0
warnings=0

pass() { echo "[PASS] $1"; }
warn() { echo "[WARN] $1"; warnings=$((warnings + 1)); }
fail() { echo "[FAIL] $1"; errors=$((errors + 1)); }

require_cmd() {
  local cmd="$1"
  local hint="$2"
  if command -v "$cmd" >/dev/null 2>&1; then
    pass "$cmd is available"
  else
    fail "$cmd is not installed. $hint"
  fi
}

require_nonempty_var() {
  local key="$1"
  local value="${!key:-}"
  if [[ -n "$value" ]]; then
    pass "$key is set"
  else
    fail "$key is required"
  fi
}

has_default_or_overrides() {
  local default_key="$1"
  local suffix="$2"
  if [[ -n "${!default_key:-}" ]]; then
    pass "$default_key is set"
    return 0
  fi

  local missing=0
  for secret in "${required_secrets[@]}"; do
    local key="${secret}_${suffix}"
    if [[ -z "${!key:-}" ]]; then
      fail "$default_key missing and $key is not set"
      missing=1
    else
      pass "$key is set"
    fi
  done
  return "$missing"
}

if [[ -n "${SECRET_PROVIDER:-}" && "${SECRET_PROVIDER}" != "$PROVIDER" ]]; then
  warn "SECRET_PROVIDER is '${SECRET_PROVIDER}' but expected '${PROVIDER}' for this validation run"
else
  pass "SECRET_PROVIDER matches provider target (or is unset in env file context)"
fi

case "$PROVIDER" in
  aws_sm)
    require_nonempty_var "SECRET_PROVIDER_AWS_REGION"
    has_default_or_overrides "SECRET_PROVIDER_AWS_SECRET_ID" "AWS_SECRET_ID" || true

    if [[ "$SKIP_AUTH_CHECK" != "true" ]]; then
      require_cmd "aws" "Install AWS CLI v2 before bootstrap validation."
      if command -v aws >/dev/null 2>&1; then
        if aws sts get-caller-identity --output json >/dev/null 2>&1; then
          pass "AWS auth bootstrap is valid (sts get-caller-identity succeeded)"
        else
          fail "AWS auth bootstrap check failed (aws sts get-caller-identity)"
        fi
      fi
    fi
    ;;

  gcp_sm)
    require_nonempty_var "SECRET_PROVIDER_GCP_PROJECT"
    has_default_or_overrides "SECRET_PROVIDER_GCP_SECRET_ID" "GCP_SECRET_ID" || true

    if [[ "$SKIP_AUTH_CHECK" != "true" ]]; then
      require_cmd "gcloud" "Install Google Cloud SDK before bootstrap validation."
      if command -v gcloud >/dev/null 2>&1; then
        active_account="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null | head -1 || true)"
        if [[ -n "$active_account" ]]; then
          pass "GCP auth bootstrap is valid (active account: $active_account)"
        else
          fail "GCP auth bootstrap check failed (no active gcloud account)"
        fi
      fi
    fi
    ;;

  azure_kv)
    require_nonempty_var "SECRET_PROVIDER_AZURE_VAULT_NAME"
    has_default_or_overrides "SECRET_PROVIDER_AZURE_SECRET_NAME" "AZURE_SECRET_NAME" || true

    if [[ "$SKIP_AUTH_CHECK" != "true" ]]; then
      require_cmd "az" "Install Azure CLI before bootstrap validation."
      if command -v az >/dev/null 2>&1; then
        subscription_id="$(az account show --query id -o tsv 2>/dev/null || true)"
        if [[ -n "$subscription_id" ]]; then
          pass "Azure auth bootstrap is valid (subscription: $subscription_id)"
        else
          fail "Azure auth bootstrap check failed (az account show)"
        fi
      fi
    fi
    ;;
esac

if [[ "$SKIP_API_CHECK" != "true" ]]; then
  if [[ -z "$API_BASE" || -z "$TOKEN" ]]; then
    warn "Skipping API smoke check: provide --api-base and --token to verify /api/security/status"
  else
    require_cmd "curl" "curl is required for API smoke check."
    if command -v curl >/dev/null 2>&1; then
      raw_json="$(curl -fsS -H "Authorization: Bearer $TOKEN" "$API_BASE/api/security/status" 2>/dev/null || true)"
      if [[ -z "$raw_json" ]]; then
        fail "API smoke check failed: could not fetch $API_BASE/api/security/status"
      else
        if PAYLOAD="$raw_json" EXPECTED_PROVIDER="$PROVIDER" node -e '
const payload = process.env.PAYLOAD || "";
const expected = process.env.EXPECTED_PROVIDER || "";
let obj;
try { obj = JSON.parse(payload); } catch { process.exit(2); }
const provider = String(obj && obj.secretProvider ? obj.secretProvider : "").trim();
const sources = obj && obj.secretSources && typeof obj.secretSources === "object" ? obj.secretSources : {};
const values = Object.values(sources).map(v => String(v || ""));
const providerPrefix = `provider_${expected}`;
const hasProviderSource = values.some(v => v === providerPrefix || v.startsWith(providerPrefix));
if (provider !== expected) process.exit(3);
if (!hasProviderSource) process.exit(4);
process.exit(0);
'; then
          pass "API smoke check passed (/api/security/status shows secretProvider=$PROVIDER and provider-backed secret sources)"
        else
          rc=$?
          if [[ "$rc" -eq 2 ]]; then
            fail "API smoke check failed: /api/security/status returned invalid JSON"
          elif [[ "$rc" -eq 3 ]]; then
            fail "API smoke check failed: secretProvider does not match expected provider '$PROVIDER'"
          else
            fail "API smoke check failed: secretSources are not resolved through provider_${PROVIDER}"
          fi
        fi
      fi
    fi
  fi
fi

echo
if [[ "$errors" -gt 0 ]]; then
  echo "Validation completed with $errors failure(s) and $warnings warning(s)." >&2
  exit 1
fi

echo "Validation completed successfully with $warnings warning(s)."

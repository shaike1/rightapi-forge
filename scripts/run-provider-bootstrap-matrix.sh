#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<USAGE
Usage:
  scripts/run-provider-bootstrap-matrix.sh [options]

Options:
  --env-file <path>         Env file to load (default: .env)
  --providers <csv>         Providers to test (default: aws_sm,gcp_sm,azure_kv)
  --api-base <url>          Optional API base for smoke checks
  --token <token>           Optional bearer token for smoke checks
  --skip-auth-check         Skip cloud CLI auth checks
  --skip-api-check          Skip API smoke checks
  --report <path>           Output markdown report (default: /tmp/provider-bootstrap-report-<ts>.md)
  -h, --help                Show this help
USAGE
}

ENV_FILE=".env"
PROVIDERS_CSV="aws_sm,gcp_sm,azure_kv"
API_BASE=""
TOKEN=""
SKIP_AUTH_CHECK="false"
SKIP_API_CHECK="false"
REPORT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file)
      ENV_FILE="${2:-}"
      shift 2
      ;;
    --providers)
      PROVIDERS_CSV="${2:-}"
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
    --report)
      REPORT="${2:-}"
      shift 2
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

if [[ -z "$REPORT" ]]; then
  REPORT="/tmp/provider-bootstrap-report-$(date -u +%Y%m%dT%H%M%SZ).md"
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Env file not found: $ENV_FILE" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VALIDATOR="$SCRIPT_DIR/validate-secret-provider-bootstrap.sh"
if [[ ! -x "$VALIDATOR" ]]; then
  echo "Validator script is missing or not executable: $VALIDATOR" >&2
  exit 2
fi

IFS=',' read -r -a PROVIDERS <<< "$PROVIDERS_CSV"
if [[ ${#PROVIDERS[@]} -eq 0 ]]; then
  echo "No providers configured" >&2
  exit 2
fi

RUN_TS="$(date -u +"%Y-%m-%d %H:%M UTC")"
HOSTNAME_VALUE="$(hostname 2>/dev/null || echo unknown-host)"

{
  echo "# Provider Bootstrap Validation Report"
  echo
  echo "Generated: $RUN_TS"
  echo "Host: $HOSTNAME_VALUE"
  echo "Env file: $ENV_FILE"
  echo "Providers: $PROVIDERS_CSV"
  echo "API base: ${API_BASE:-not-set}"
  echo "Auth check: $([[ "$SKIP_AUTH_CHECK" == "true" ]] && echo skipped || echo enabled)"
  echo "API check: $([[ "$SKIP_API_CHECK" == "true" ]] && echo skipped || echo enabled)"
  echo
  echo "## Results"
  echo
} > "$REPORT"

failures=0
for provider_raw in "${PROVIDERS[@]}"; do
  provider="$(echo "$provider_raw" | xargs)"
  [[ -z "$provider" ]] && continue

  cmd=("$VALIDATOR" "--provider" "$provider" "--env-file" "$ENV_FILE")
  if [[ -n "$API_BASE" ]]; then
    cmd+=("--api-base" "$API_BASE")
  fi
  if [[ -n "$TOKEN" ]]; then
    cmd+=("--token" "$TOKEN")
  fi
  if [[ "$SKIP_AUTH_CHECK" == "true" ]]; then
    cmd+=("--skip-auth-check")
  fi
  if [[ "$SKIP_API_CHECK" == "true" ]]; then
    cmd+=("--skip-api-check")
  fi

  output_file="/tmp/provider-bootstrap-${provider}-$(date -u +%Y%m%dT%H%M%SZ).log"
  set +e
  "${cmd[@]}" > "$output_file" 2>&1
  rc=$?
  set -e

  {
    if [[ "$rc" -eq 0 ]]; then
      echo "- ✅ $provider: PASS"
    else
      echo "- ❌ $provider: FAIL (exit $rc)"
    fi
    echo
    echo "<details><summary>Output: $provider</summary>"
    echo
    echo '\`\`\`text'
    sed -n '1,220p' "$output_file"
    echo '\`\`\`'
    echo
    echo "</details>"
    echo
  } >> "$REPORT"

  if [[ "$rc" -ne 0 ]]; then
    failures=$((failures + 1))
  fi

done

{
  echo "## Summary"
  if [[ "$failures" -eq 0 ]]; then
    echo "All provider validations passed."
  else
    echo "$failures provider validation(s) failed."
  fi
} >> "$REPORT"

echo "Report written: $REPORT"

if [[ "$failures" -ne 0 ]]; then
  exit 1
fi

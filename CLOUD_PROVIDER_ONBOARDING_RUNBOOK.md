# Cloud Secret Provider Onboarding Runbook

Last updated: 2026-02-18

## Scope
This runbook standardizes production onboarding for:
- AWS Secrets Manager (`SECRET_PROVIDER=aws_sm`)
- GCP Secret Manager (`SECRET_PROVIDER=gcp_sm`)
- Azure Key Vault (`SECRET_PROVIDER=azure_kv`)

It includes auth bootstrap, env mapping, and smoke verification for provider-backed secret resolution.

## Required Secret Set
The platform requires this minimum secret set:
- `credential_master_key`
- `approval_token_secret`
- `auth_token_secret`
- `admin_password`
- `operator_password`
- `viewer_password`

## Common Pre-Checks
1. Confirm the runtime is already healthy with current provider settings.
2. Ensure strong secrets policy is enabled in production: `REQUIRE_STRONG_SECRETS=true`.
3. Decide per-secret strategy:
   - one default secret id/name per provider payload, or
   - explicit per-secret id/name overrides.
4. Keep one rollback path ready (previous `.env` + last known-good backup bundle).

## Provider-Specific Bootstrap

### AWS Secrets Manager
1. Ensure AWS CLI is available and authenticated on the host running validation:
   - `aws sts get-caller-identity`
2. Configure runtime env:
   - `SECRET_PROVIDER=aws_sm`
   - `SECRET_PROVIDER_AWS_REGION=<region>`
   - either `SECRET_PROVIDER_AWS_SECRET_ID=<default-secret-id>`
   - or per secret: `<SECRET_NAME>_AWS_SECRET_ID`
3. Optional payload key mapping (if JSON payload):
   - `<SECRET_NAME>_AWS_KEY`

### GCP Secret Manager
1. Ensure gcloud is available and authenticated:
   - `gcloud auth list --filter=status:ACTIVE`
2. Configure runtime env:
   - `SECRET_PROVIDER=gcp_sm`
   - `SECRET_PROVIDER_GCP_PROJECT=<project-id>`
   - either `SECRET_PROVIDER_GCP_SECRET_ID=<default-secret-id>`
   - or per secret: `<SECRET_NAME>_GCP_SECRET_ID`
3. Optional payload key mapping (if JSON payload):
   - `<SECRET_NAME>_GCP_KEY`

### Azure Key Vault
1. Ensure Azure CLI is available and authenticated:
   - `az account show`
2. Configure runtime env:
   - `SECRET_PROVIDER=azure_kv`
   - `SECRET_PROVIDER_AZURE_VAULT_NAME=<vault-name>`
   - either `SECRET_PROVIDER_AZURE_SECRET_NAME=<default-secret-name>`
   - or per secret: `<SECRET_NAME>_AZURE_SECRET_NAME`
3. Optional payload key mapping (if JSON payload):
   - `<SECRET_NAME>_AZURE_KEY`

## Deterministic Validation Checklist
Run the bootstrap validator before rollout:

```bash
# AWS
scripts/validate-secret-provider-bootstrap.sh \
  --provider aws_sm \
  --env-file .env \
  --api-base http://localhost:19123 \
  --token "$ADMIN_TOKEN"

# GCP
scripts/validate-secret-provider-bootstrap.sh \
  --provider gcp_sm \
  --env-file .env \
  --api-base http://localhost:19123 \
  --token "$ADMIN_TOKEN"

# Azure
scripts/validate-secret-provider-bootstrap.sh \
  --provider azure_kv \
  --env-file .env \
  --api-base http://localhost:19123 \
  --token "$ADMIN_TOKEN"
```

Validator checks:
- required provider env keys are present
- default secret id/name or full per-secret overrides are configured
- cloud CLI auth bootstrap passes (unless `--skip-auth-check`)
- `/api/security/status` reports matching `secretProvider` and provider-backed `secretSources` (unless `--skip-api-check`)

### Matrix Execution + Evidence Capture
Use the matrix runner to validate multiple providers and archive one report:

```bash
scripts/run-provider-bootstrap-matrix.sh \
  --env-file .env \
  --providers aws_sm,gcp_sm,azure_kv \
  --api-base http://localhost:19123 \
  --token "$ADMIN_TOKEN" \
  --report /tmp/provider-bootstrap-report.md
```

Expected output:
- markdown report with pass/fail status per provider
- embedded validator logs for audit evidence

## Rollout Sequence
1. Apply updated provider env vars to deployment.
2. Redeploy container/service.
3. Run validator with API smoke check.
4. Confirm in UI/API:
   - `GET /api/security/status`
   - `secretProvider` matches target provider
   - critical `secretSources.*` values are `provider_*`
5. Trigger a controlled operation (for example one authenticated dashboard action) to confirm runtime stability.

## Rollback
If any validation step fails after deployment:
1. Revert to previous known-good provider/env configuration.
2. Redeploy immediately.
3. Confirm `/api/security/status` returns known-good provider and sources.
4. Capture failure context and remediate before the next attempt.

## Notes
- Keep provider credentials scoped to least privilege.
- Prefer short-lived identities (role/service account/managed identity) over static long-lived credentials.
- Do not store secret values directly in runbooks or commit history.

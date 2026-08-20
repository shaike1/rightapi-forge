# RightAPI Forge - Governed AI Operations Platform

[![Node](https://img.shields.io/badge/node-22.x-339933?logo=node.js&logoColor=white)](https://nodejs.org/)

> *Self-hosted, governed AI operations and internal-tool delivery.*

## 🎯 Overview

**RightAPI Forge** is a self-hosted operations platform powered by governed AI agents. It monitors infrastructure, manages incidents, automates runbooks, integrates with operational systems, and lets teams create internal tools from typed specifications. Generated tools pass automated quality and security gates before approval-controlled deployment, and can be rolled back with an attributable audit trail.

The product is designed for IT teams and managed service providers that need AI-assisted automation while keeping credentials, deployments, and change approval inside their own infrastructure.

Originally inspired by ["I Replaced My Entire AI Workflow With an Org Chart of 7 Agents"](https://medium.com/@procoder/i-replaced-my-entire-ai-workflow-with-an-org-chart-of-7-agents-heres-the-complete-technical-eda367b91b39).

## 🏗️ Architecture

### Agent Organization



### Core Components

1. **AgentBus** - Inter-agent communication system
2. **TaskManager** - Task delegation and tracking
3. **CredentialVault** - Secure credential storage
4. **Dashboard** - Web-based management interface
5. **Codex Bridge** - Integration with OpenAI Codex

## 🚀 Quick Start

### Prerequisites

- Docker and Docker Compose
- Node.js 22
- 2GB RAM minimum
- 10GB disk space

### Installation

```bash
# Clone the repository
git clone https://github.com/shaike1/rightapi-forge rightapi-forge
cd rightapi-forge

# Generate an untracked environment file with unique secrets
npm run secrets:generate
mv .env.generated .env

# Review provider settings in .env, then start the system
docker compose up -d

# Wait for services to be healthy (30 seconds)
docker ps
```

### Access Points

- **Dashboard:** http://localhost:19123/dashboard
- **Tool Builder:** http://localhost:19123/app/tool-builder
- **Settings:** http://localhost:19123/settings.html
- **Factory Board:** http://localhost:19124

**Initial Credentials:**
- Username: `admin`
- Password: value from `ADMIN_PASSWORD` in your runtime env

Generate strong secrets/passwords:
```bash
./scripts/generate-env-secrets.sh .env.generated
```

Apply strong secrets directly into `.env` (idempotent, creates timestamped backup):
```bash
./scripts/prepare-secure-env.sh .env
```

NPM shortcuts:
```bash
npm run secrets:generate
npm run secrets:prepare
```

Note: Compose deployment defaults now enforce `REQUIRE_STRONG_SECRETS=true`. Use secure values before starting containers.

## 📊 Agent Configuration

### Default Agents

| Agent ID | Role | Model | Skills |
|----------|------|-------|--------|
| alice | SysAdmin | openai/gpt-4 | system-admin, monitoring |
| bob | SysAdmin | openai/gpt-4 | security, audit |
| eve | SysAdmin | openai/gpt-4 | networking, firewall |
| charlie | Specialist | openai/gpt-4 | backup, recovery |
| diana | Specialist | openai/gpt-4 | optimization, performance |

### Managing Agents

#### Add New Agent

```bash
curl -X POST http://localhost:19123/api/agent-config \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -d '{
    "agentId": "new-agent",
    "model": "openai/gpt-4",
    "skills": ["skill1", "skill2"],
    "temperature": 0.7,
    "maxTokens": 2000
  }'
```

#### Update Agent

```bash
curl -X PUT http://localhost:19123/api/agent-config/alice \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -d '{
    "model": "anthropic/claude-3",
    "temperature": 0.8
  }'
```

#### Delete Agent

```bash
curl -X DELETE http://localhost:19123/api/agent-config/alice \
  -H 'Authorization: Bearer YOUR_TOKEN'
```

## 🔑 API Keys Management

### Adding API Keys

```bash
curl -X POST http://localhost:19123/api/api-keys \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -d '{
    "provider": "openai",
    "key": "sk-your-key-here"
  }'
```

### Supported Providers

- `openai` - OpenAI API
- `anthropic` - Anthropic Claude
- `google` - Google Gemini
- `zai` - Z.AI

### Listing API Keys

```bash
curl http://localhost:19123/api/api-keys \
  -H 'Authorization: Bearer YOUR_TOKEN'
```

## 🔐 Credentials Management

### Adding Credentials for Agents

```bash
curl -X POST http://localhost:19123/api/credentials \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -d '{
    "agentId": "alice",
    "name": "ssh-credential",
    "scope": "production-server",
    "secret": "your-secret-here"
  }'
```

### Getting Agent Credentials

```bash
curl http://localhost:19123/api/credentials/agent/alice \
  -H 'Authorization: Bearer YOUR_TOKEN'
```

### Credential Catalog (Metadata Only, Admin-only API)

Use this catalog for credential ownership and scope metadata only (no plaintext secret values).

```bash
# List catalog entries (supports filters: agentId, environment, system, scope, active, q)
curl "http://localhost:19123/api/credentials/catalog?agentId=alice" \
  -H 'Authorization: Bearer YOUR_TOKEN'

# Create catalog entry
curl -X POST http://localhost:19123/api/credentials/catalog \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -d '{
    "name": "github-deploy-token",
    "agentId": "alice",
    "environment": "prod",
    "system": "github",
    "scope": "repo:deploy",
    "tags": ["deploy", "critical"]
  }'
```


## 📁 Data Persistence

### File Structure

```
/data/itops-agents/
├── agents.json              # Agent configurations
├── api-keys.json            # API keys
├── credentials.vault.json   # Encrypted credential secrets
├── credential-catalog.json  # Credential metadata catalog (no secrets)
├── organization.json        # Organization structure
├── config.json             # System configuration
└── sla-snapshots.json      # Performance metrics
```

### Backup

```bash
# Backup all data
docker exec itops-agents tar -czf /tmp/backup.tar.gz /data/itops-agents

# Copy to host
docker cp itops-agents:/tmp/backup.tar.gz ./backup-20260218.tar.gz
```

### Restore

```bash
# Copy backup to container
docker cp ./backup-20250218.tar.gz itops-agents:/tmp/restore.tar.gz

# Restore
docker exec itops-agents tar -xzf /tmp/restore.tar.gz -C /
docker compose restart
```

## 🎛️ Dashboard Features

### Main Dashboard (http://localhost:19123/dashboard)

1. **Overview** - System health and status
2. **Agents** - View and manage agents
3. **Skills** - Available skills
4. **Factory** - Agent factory
5. **Orchestrator** - Task orchestration
6. **Chats** - Agent communication logs
7. **Configuration** - System settings

### Settings Page (http://localhost:19123/settings.html)

1. **Agents Tab** - Configure agent models and skills
2. **API Keys Tab** - Manage API keys
3. **Credentials Tab** - Manage agent credentials

## 🔌 API Endpoints

### Authentication

```bash
# Login
curl -X POST http://localhost:19123/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"<ADMIN_PASSWORD>"}'

# Response
{
  "success": true,
  "session": {
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IklUT1BTLUFVVEgifQ...",
    "username": "admin",
    "role": "admin",
    "expiresAt": "2026-02-18T20:30:00.000Z"
  }
}
```

### Agent Configuration Endpoints

- `GET /api/agent-config` - List all agents
- `GET /api/agent-config/:id` - Get specific agent
- `POST /api/agent-config` - Create new agent
- `PUT /api/agent-config/:id` - Update agent
- `DELETE /api/agent-config/:id` - Delete agent
- Agent scope can be managed from dashboard agent create/edit forms (`scope` as comma-separated values).

### API Keys Endpoints

- `GET /api/api-keys` - List all API keys
- `POST /api/api-keys` - Add API key
- `DELETE /api/api-keys/:id` - Delete API key

### Credentials Endpoints

- `GET /api/credentials` - List all credentials
- `GET /api/credentials/agent/:id` - Get agent credentials
- `POST /api/credentials` - Add credential
- `PUT /api/credentials/:id` - Update credential
- `DELETE /api/credentials/:id` - Delete credential

### Agent Collaboration Endpoints

- `GET /api/agent-bus/threads` - List direct + group conversation threads
- `GET /api/agent-bus/messages` - List messages for thread/task/agent filters
- `POST /api/agent-bus/send` - Send direct agent message
- `POST /api/agent-bus/standup` - Run multi-agent standup conversation
- `GET /api/agent-bus/standups` - List standup rooms (or inspect one room via `roomId`)

### Organization Chart Endpoints

- `GET /api/org-chart` - Load organization chart
- `PUT /api/org-chart` - Replace organization chart document
- `PATCH /api/org-chart/nodes/:nodeId` - Update one org node (`name`, `role`, `agents`, `specializations`, `scope`)

### Backup & Recovery Endpoints

- `GET /api/system/backups` - List backup bundles
- `POST /api/system/backups/create` - Create backup bundle
- `GET /api/system/backups/:backupId/verify` - Verify backup integrity
- `POST /api/system/backups/:backupId/restore` - Restore backup (supports `dryRun`, and optional `taskId` attribution)
- `GET /api/system/backups/health` - Backup freshness + verification status
- `GET /api/system/backups/scheduler` - Backup scheduler runtime status
- `POST /api/system/backups/scheduler/run` - Trigger scheduler run manually (create + verify + prune)

### Backup Automation Environment Variables

- `BACKUP_AUTOMATION_ENABLED` - Enable in-process scheduler (`true`/`false`)
- `BACKUP_AUTOMATION_INTERVAL_MINUTES` - Scheduler interval in minutes (min 5)
- `BACKUP_AUTOMATION_RUN_ON_STARTUP` - Run one backup on service startup
- `RETENTION_KEEP_LATEST` - Keep at least this many latest backups and resolved incidents
- `RETENTION_MAX_AGE_DAYS` - Delete older backups and resolved incidents beyond this age (after keepLatest)

### Hardening Controls (New)

- Secret file loading is supported via `<KEY>_FILE` for:
  - `CREDENTIAL_MASTER_KEY`
  - `APPROVAL_TOKEN_SECRET`
  - `AUTH_TOKEN_SECRET`
  - `ADMIN_PASSWORD`, `OPERATOR_PASSWORD`, `VIEWER_PASSWORD`
- Command-based secret loading is supported via `<KEY>_CMD` for the same keys (command output is used as secret value).
- Native Vault provider is supported via:
  - `SECRET_PROVIDER=vault`
  - `SECRET_PROVIDER_VAULT_ADDR`
  - `SECRET_PROVIDER_VAULT_TOKEN` (or `_FILE`/`_CMD`)
  - `SECRET_PROVIDER_VAULT_PATH` (plus optional per-secret path/key overrides)
- Local file provider is supported via:
  - `SECRET_PROVIDER=file`
  - `SECRET_PROVIDER_FILE_PATH` (JSON object or `{ "secrets": { ... } }`)
  - optional per-secret key mapping: `<SECRET_NAME>_PROVIDER_KEY`
  - migration helper:
    - `scripts/migrate-secrets-to-provider-file.sh .env itops-data secret-provider.json`
- AWS Secrets Manager provider is supported via:
  - `SECRET_PROVIDER=aws_sm`
  - `SECRET_PROVIDER_AWS_REGION`
  - `SECRET_PROVIDER_AWS_SECRET_ID` (default secret id for all keys)
  - optional per-secret overrides:
    - `<SECRET_NAME>_AWS_SECRET_ID`
    - `<SECRET_NAME>_AWS_KEY`
  - payload mode:
    - JSON secret string: key lookup via `<SECRET_NAME>_AWS_KEY` / `<SECRET_NAME>_PROVIDER_KEY`
    - plain string: set `<SECRET_NAME>_AWS_KEY=value` (or `_`/`secret`) to use full payload
- GCP Secret Manager provider is supported via:
  - `SECRET_PROVIDER=gcp_sm`
  - `SECRET_PROVIDER_GCP_PROJECT`
  - `SECRET_PROVIDER_GCP_SECRET_ID` (default secret id for all keys)
  - optional per-secret overrides:
    - `<SECRET_NAME>_GCP_SECRET_ID`
    - `<SECRET_NAME>_GCP_KEY`
  - payload mode:
    - JSON secret payload: key lookup via `<SECRET_NAME>_GCP_KEY` / `<SECRET_NAME>_PROVIDER_KEY`
    - plain string: set `<SECRET_NAME>_GCP_KEY=value` (or `_`/`secret`) to use full payload
- Azure Key Vault provider is supported via:
  - `SECRET_PROVIDER=azure_kv`
  - `SECRET_PROVIDER_AZURE_VAULT_NAME`
  - `SECRET_PROVIDER_AZURE_SECRET_NAME` (default secret name for all keys)
  - optional per-secret overrides:
    - `<SECRET_NAME>_AZURE_SECRET_NAME`
    - `<SECRET_NAME>_AZURE_KEY`
  - payload mode:
    - JSON secret payload: key lookup via `<SECRET_NAME>_AZURE_KEY` / `<SECRET_NAME>_PROVIDER_KEY`
    - plain string: set `<SECRET_NAME>_AZURE_KEY=value` (or `_`/`secret`) to use full payload
- Cloud provider onboarding/validation runbook:
  - `CLOUD_PROVIDER_ONBOARDING_RUNBOOK.md`
  - cutover env template:
    - `config/provider-cutover.env.template`
  - bootstrap validator script:
    - `scripts/validate-secret-provider-bootstrap.sh --provider <aws_sm|gcp_sm|azure_kv> --env-file .env --api-base http://localhost:19123 --token <admin-token>`
  - matrix evidence runner:
    - `scripts/run-provider-bootstrap-matrix.sh --env-file .env --providers aws_sm,gcp_sm,azure_kv --api-base http://localhost:19123 --token <admin-token> --report /tmp/provider-bootstrap-report.md`
- Dashboard support:
  - Configuration tab includes a **Provider Bootstrap** form that persists provider mode/default identifiers in runtime config (`secretProviderBootstrap`) so onboarding values can be managed without editing `.env`.
  - Configuration tab includes **Validate Provider Bootstrap** action (backed by `POST /api/security/provider-bootstrap/validate`) for immediate required-field checks and next steps.
- Secret source visibility is exposed via `GET /api/security/status` under `secretSources` (values are not returned).
- `PRIVILEGED_TARGET_ALLOWLIST` - comma-separated allowed targets for privileged/destructive commands.
- API-managed allowlist policy endpoints:
  - `GET /api/tools/target-allowlist-policy`
  - `POST /api/tools/target-allowlist-policy` (revision-locked + policy audit trail)
- `CREDENTIAL_ANOMALY_WINDOW_MINUTES` and `CREDENTIAL_ANOMALY_MAX_USES` - thresholds for credential anomaly alerts in `/api/alerts`.
- Optional stricter anomaly enforcement:
  - `CREDENTIAL_ANOMALY_ENFORCE_BLOCK` (`true`/`false`)
  - `CREDENTIAL_ANOMALY_BLOCK_FACTOR` (multiplier over alert threshold)
  - `CREDENTIAL_ANOMALY_BLOCK_RISKS` (comma list: `privileged,destructive`)
  - when enabled, high-risk executions using hot credentials are blocked by policy and logged in execution audit.
- Orchestrator reliability controls:
  - `ORCHESTRATOR_AUTO_RECOVER`
  - `ORCHESTRATOR_STUCK_THRESHOLD_MINUTES`
  - `ORCHESTRATOR_STUCK_RETRY_LIMIT`
  - `ORCHESTRATOR_STUCK_RETRY_COOLDOWN_MINUTES`
  - `ORCHESTRATOR_RELIABILITY_POLICY_PATH` (persisted revisioned policy store for runtime API updates)
  - SLO thresholds:
    - `ORCHESTRATOR_SLO_WINDOW_MINUTES`
    - `ORCHESTRATOR_SLO_MAX_QUARANTINED`
    - `ORCHESTRATOR_SLO_MAX_RECOVERY_FAILED`
    - `ORCHESTRATOR_SLO_MIN_SUCCESS_RATE`
  - metrics/automation status are exposed in `GET /api/orchestrator/status` under `reliability`.
  - policy endpoints:
    - `GET /api/orchestrator/reliability-policy`
    - `POST /api/orchestrator/reliability-policy`
  - SLO endpoint:
    - `GET /api/orchestrator/reliability-slo`
  - SLO what-if simulation endpoint:
    - `POST /api/orchestrator/reliability-slo/simulate`
  - SLO tuning apply endpoint:
    - `POST /api/orchestrator/reliability-slo/apply`

## 🐧 Troubleshooting

Backup/restore incident procedure:
- `BACKUP_INCIDENT_RUNBOOK.md`
Cloud provider onboarding procedure:
- `CLOUD_PROVIDER_ONBOARDING_RUNBOOK.md`

### Container Not Starting

```bash
# Check logs
docker logs itops-agents

# Restart
docker compose restart

# Full restart
docker compose down && docker compose up -d
```

### Data Not Persisting

```bash
# Check data directory
docker exec itops-agents ls -la /data/itops-agents/

# Check permissions
docker exec itops-agents ls -ld /data/itops-agents
```

### API Returning Errors

```bash
# Check container health
docker ps --filter 'name=itops'

# View detailed logs
docker logs itops-agents --tail 100 -f
```

## 📈 Performance Metrics

### Default Metrics

- **CPU Usage**: ~13%
- **Memory Usage**: ~22%
- **Uptime**: Tracked per agent
- **Tasks**: Active and completed

### Monitoring

Access monitoring dashboard at:
```
http://localhost:19123/monitoring
```

## 🔒 Security

### Credential Storage

Credentials are encrypted using AES-256-GCM:
- Master key derived from `CREDENTIAL_MASTER_KEY` (fallback: `SECRET_MASTER_KEY`)
- Each credential has unique IV
- AuthTag for integrity verification

### API Security

- JWT token authentication
- Token expiration: 1 hour
- Role-based access control

### Best Practices

1. Change default password immediately
2. Use a strong `CREDENTIAL_MASTER_KEY` and rotate it periodically
3. Enable HTTPS in production
4. Rotate API keys regularly
5. Backup data frequently

## 🤝 Contributing

Issue reports, reproducible test cases, and product feedback are welcome. Code and documentation pull requests are temporarily closed until an approved contributor agreement supports the intended community and commercial dual-license model. See [CONTRIBUTING.md](CONTRIBUTING.md).

## 📝 License

RightAPI Forge is available under the [GNU Affero General Public License v3.0 or later](LICENSE). A separate paid commercial license is available for organizations that require different terms. See [COMMERCIAL.md](COMMERCIAL.md), [PRIVACY.md](PRIVACY.md), and [TRADEMARKS.md](TRADEMARKS.md).

## 🙏 Acknowledgments

Inspired by the article "I Replaced My Entire AI Workflow With an Org Chart of 7 Agents" by [procoder](https://medium.com/@procoder)

## 📧 Support

- Email: [info@right-api.com](mailto:info@right-api.com)
- Product and company: [right-api.com](https://right-api.com/)
- Support policy: [SUPPORT.md](SUPPORT.md)
- Security reports: [SECURITY.md](SECURITY.md)
- Commercial licensing: [COMMERCIAL.md](COMMERCIAL.md)

---

**Built with ❤️ by sh.ai + AI Agents**
**Version:** 1.0.0
**Last Updated:** 2026-02-18

## Credential Enforcement (Increment B)

Execution now enforces credential catalog mappings in the websocket tool execution path (`handleExecuteSkill`):
- Resolver gate checks mapping by `agentId + environment + system + scope` before execution.
- Deny reasons are explicit for: no mapping, environment/system mismatch, inactive mapping, and provided-scope mismatch.
- Decisions are audited (allow/deny) with who/what/where/why metadata, without exposing secret plaintext.

Runtime toggles:
- `CREDENTIAL_ENFORCEMENT_ENABLED` (default: `true`)
- `ENFORCE_APPROVAL_FOR_PRIVILEGED_SCOPES` (default: `false`) for minimal scope-based approval fallback when command policy does not require approval.

Read-only admin audit endpoint:
- `GET /api/credentials/usage` (auth: `audit.read`)

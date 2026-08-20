# Tooling and Security Guide

## Tool Execution Model
- Every skill command is mapped to a policy in `src/security/ToolingPolicy.ts`.
- Policies include:
  - `risk`: `safe` | `privileged` | `destructive`
  - `sandbox`: launch profile (`read_only_shell`, `container_runtime`, `k8s_admin`, `deployment_runtime`)
  - `requiresApproval`: whether explicit approval is required
  - `allowedRoles`: agent roles allowed to run the command
  - `requiredCredentialScopes`: least-privilege scopes needed to execute
  - `maxDurationMs`: maximum allowed runtime
- Launch profiles are defined in `SANDBOX_LAUNCH_SPECS` with explicit:
  - runner mode (`host_exec` vs `docker_exec`)
  - network mode, rootfs mode, user, dropped capabilities
  - allowed volume mounts and default timeout

## Policy Enforcement
- Runtime checks are enforced in `handleExecuteSkill` via `evaluateToolExecution(...)`.
- Blocked requests return a policy explanation instead of command output.
- Successful execution includes policy context prefix:
  - `[sandbox:<profile>][runner:<runner>][risk:<tier>][max:<timeout>] ...`
- Credential scopes are validated against provided credential IDs before command execution.
- Per-command concurrency limits are enforced at runtime:
  - `safe`: up to 4 concurrent executions
  - `privileged`: up to 2 concurrent executions
  - `destructive`: 1 concurrent execution
  - configurable via `GET/POST /api/tools/concurrency-policy`
  - policy writes use optimistic locking with `expectedRevision`
- Tool handlers execute through sandbox runner:
  - `src/security/SandboxRunner.ts`
  - `src/security/SandboxWorker.ts`
- Each execution runs in an ephemeral container (`docker run --rm`) with launch-profile constraints
  and returns a sandbox run ID in result metadata.

## Approval Flow (Current)
- For commands flagged `requiresApproval`, request must include:
  - `params.approvalToken` (signed, short-lived token)
- Mint tokens via:
  - `POST /api/approvals/tokens` with `{ command, agentId, approver, ttlSeconds?, reason? }`
- Token validation enforces:
  - command match
  - agent match
  - HMAC signature
  - expiry
- Tokens are one-time-use:
  - first accepted execution consumes the token
  - replay attempts are blocked
- Tokens can be revoked before use:
  - `POST /api/approvals/revoke` with `{ tokenId, revokedBy, reason? }`
  - `GET /api/approvals/status/:tokenId`
  - `GET /api/approvals/ledger?limit=100`

## Operator Authentication
- Sensitive APIs and tool execution require an authenticated user session.
- Roles:
  - `admin`: full access including user management
  - `operator`: operational access (no user write)
  - `viewer`: read-only visibility
- Login:
  - `POST /api/auth/login` with `{ username, password }`
  - Returns signed session token.
- Validate session:
  - `GET /api/auth/me` with `Authorization: Bearer <token>`
- Protected actions include:
  - config writes
  - credential read/write/delete
  - approval mint/revoke/status/ledger
  - execution audit API
  - websocket `execute_skill` (must include `params.operatorToken`)
  - user APIs:
    - `GET /api/auth/users` (`users.read`)
    - `POST/PATCH/DELETE /api/auth/users...` (`users.manage`, admin)

## Secret Hardening
- In production, set `REQUIRE_STRONG_SECRETS=true` (default when `NODE_ENV=production`).
- Startup blocks when weak/missing:
  - `CREDENTIAL_MASTER_KEY`
  - `APPROVAL_TOKEN_SECRET`
  - `AUTH_TOKEN_SECRET`
  - `ADMIN_USERNAME`
  - `ADMIN_PASSWORD`

## Credential Vault
- Per-agent credentials are stored encrypted at rest using AES-256-GCM.
- Implementation: `src/security/CredentialVault.ts`
- File path: `/data/itops-agents/credentials.vault.json` (configurable)
- Master key env vars:
  - `CREDENTIAL_MASTER_KEY` (preferred)
  - `SECRET_MASTER_KEY` (fallback)
- API never returns raw secrets, only metadata.

## Credential APIs
- `GET /api/credentials/:agentId`
  - Returns credential metadata for the agent
- `POST /api/credentials`
  - Body: `{ agentId, name, scope, secret, id? }`
  - Upserts encrypted credential
- `DELETE /api/credentials/:id`
  - Deletes credential record

## Tool Policy APIs
- `GET /api/tools/policies`
  - Returns complete policy table with launch profile details
- `GET /api/tools/catalog`
  - Returns skill command catalog + bound policy + launch metadata

## Execution Audit
- Every execution attempt is persisted with outcome:
  - `allowed`, `blocked`, or `error`
- Includes command, agent, role, reason, risk/sandbox/runner, approval token id, scopes, and duration.
- API:
  - `GET /api/audit/executions?limit=100`

## Agent Communication Bus
- Agent-to-agent delegations are persisted with:
  - `threadId`
  - optional `taskId`
  - sender/recipient agent IDs
  - message kind (`message`, `reply`, `system`)
  - delivery status (`sent`, `delivered`, `processed`, `failed`)
- APIs:
  - `GET /api/agent-bus/threads`
  - `GET /api/agent-bus/messages`
  - `POST /api/agent-bus/send`
- WebSocket events:
  - `agent_bus_message`
  - `agent_bus_threads`
  - `agent_bus_messages`

## Delegation Lifecycle
- Delegation records are persisted with:
  - `requestId`
  - `parentTaskId`
  - optional `childTaskId`
  - requester/assignee agent IDs
  - objective + optional deadline
  - state machine: `proposed -> approved -> dispatched -> accepted -> completed` (or rejected)
- APIs:
  - `GET /api/delegations`
  - `GET /api/delegations/:delegationId`
  - `POST /api/delegations`
  - `POST /api/delegations/:delegationId/transition`
    - high-impact `approved`/`dispatched` transitions require one-time approval token for command `delegation.dispatch`
- Task hierarchy APIs:
  - `GET /api/tasks/:taskId/subtasks`
  - `POST /api/tasks/:taskId/subtasks`

## Task Documentation and Rollback
- Every task now records an operations journal:
  - status changes
  - execution results/errors
  - bus delegation/reply notes (when linked by `taskId`)
- Rollback checkpoints can be attached to tasks with rollback plans.
- Rollback preview now classifies likely impact domains (infrastructure/deployment/security/data/etc).
- Rollback apply is blocked if risky execution history exists but required checkpoint coverage is missing.
- For non-safe command executions linked to a task, a rollback checkpoint is automatically added.
- For risky linked executions, a pre-change task snapshot is captured and can be restored from deterministic manifests.
- Task lifecycle actions:
  - cancel
  - drop
  - rollback requested
  - rollback applied
- APIs:
  - `GET /api/tasks/:taskId/timeline`
  - `PUT /api/tasks/:taskId/status`
  - `GET /api/tasks/:taskId/activity`
    - supports `limit`, `source`, `windowHours`, `search`, `cursor`
  - `GET /api/tasks/:taskId/snapshots`
  - `GET /api/tasks/:taskId/snapshots/:snapshotId`
  - `POST /api/tasks/:taskId/snapshots/:snapshotId/restore`
  - `GET /api/tasks/:taskId/rollback/preview`
  - `POST /api/tasks/:taskId/cancel`
  - `POST /api/tasks/:taskId/drop`
  - `POST /api/tasks/:taskId/rollback/request`
  - `POST /api/tasks/:taskId/rollback/apply` (requires approval token for command `task.rollback.apply`, one-time use)

## Regression Validation
- Unit: `npm test`
- Rollback/API end-to-end: `npm run test:e2e:rollback`
- Visibility endpoints validated in E2E:
  - `/api/agents/capabilities`
  - `/api/alerts`
  - `/api/operations/running`
  - `/api/agents/metrics`
  - `/api/metrics/sla`
  - `/api/metrics/sla/snapshots`
  - `/api/metrics/sla/snapshot-policy`
  - `/api/tools/concurrency-policy`
  - `/api/policies/export`
  - `/api/policies/import`
  - `/api/policies/audit`

## Backup Health Signals
- `GET /api/system/backups/health` (permission: `security.read`)
  - returns the most recent backup summary, age, threshold, stale flag, and optional verification block with checks or errors.
  - empowers automation and UIs to raise alerts when the backup age exceeds `BACKUP_HEALTH_MAX_AGE_HOURS` or verification fails.

## Orchestrator APIs
- `GET /api/orchestrator/status` (`security.read`)
  - returns the orchestrator queue, phase counts, stuck entries, and heartbeat metadata.
- `POST /api/orchestrator/tick` (`config.write`)
  - triggers a manual heartbeat and optionally records a reason (`{ reason?: string }`).
- `GET /api/tasks/:taskId/graph` (`security.read`)
  - returns nodes and edges linking the target task with parents, children, dependencies, and related delegations.

## Signed Audit Export
- Export endpoint: `GET /api/audit/executions/export`
- Includes:
  - ordered audit records
  - per-record hash chain (`prevHash` -> `hash`)
  - chain head
  - HMAC signature for export envelope integrity

## Next Hardening Steps
- Replace env fallback master key with mandatory KMS-backed key.
- Add signed approval tokens instead of boolean `approved`.
- Route command execution through a dedicated sandbox launcher abstraction.
- Add per-credential usage logs and anomaly detection.

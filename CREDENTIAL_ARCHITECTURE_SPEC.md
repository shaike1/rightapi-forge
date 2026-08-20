# Credential Architecture Spec (RightAPI Forge)

Last updated: 2026-02-19
Owner: platform/security
Status: proposed (implementation-ready)

## 1) Goal
Design a production-grade credential architecture for IT orchestration agents where each agent gets least-privilege access per environment and per system (AD on-prem, Azure, M365, local admin, etc.), with strict auditability and approval controls.

## 2) Principles
1. Least privilege by default (deny-by-default).
2. Agent-scoped access only (no shared global admin secrets).
3. Environment isolation (`lab` / `dev` / `stage` / `prod`).
4. Action-scoped access (read-only vs privileged/destructive).
5. Short-lived credentials whenever possible (OAuth/client credentials/managed identity).
6. Full audit trail for secret reads + tool execution context.
7. Mandatory approval gate for sensitive actions.

## 3) Identity Model
Each agent has a unique runtime identity:
- `agent-noc-l1`
- `agent-ad-ops`
- `agent-m365-monitor`
- `agent-backup-ops`

Identity is used for:
- credential lookup authorization
- policy enforcement
- execution audit attribution

## 4) Credential Taxonomy
Each credential record must include:
- `credentialId` (unique)
- `agentId`
- `environment` (`lab|dev|stage|prod`)
- `system` (`ad-onprem|azure|m365|windows-local|linux-ssh|sql|vmware|...`)
- `scope` (e.g., `directory.read`, `user.reset-password`, `mailbox.read`, `mailbox.send`, `local-admin.run`)
- `risk` (`low|medium|high|critical`)
- `provider` (`vault|file|aws_sm|gcp_sm|azure_kv`)
- `secretRef` (provider-specific reference)
- `rotationPolicy` (days / trigger / owner)
- `approvalPolicy` (`none|one_time_token|required_multi_approver`)
- `expiresAt` (optional)
- `metadata` (ticket source, owner team, business justification)

## 5) Canonical Secret Object (Provider Payload)
Provider-backed secret values should follow one structure:

```json
{
  "version": 1,
  "kind": "credential",
  "username": "optional",
  "password": "optional",
  "client_id": "optional",
  "client_secret": "optional",
  "tenant_id": "optional",
  "certificate_pem": "optional",
  "private_key_pem": "optional",
  "token": "optional",
  "extra": {}
}
```

Notes:
- Use only fields required by the integration type.
- Prefer app identities / cert auth over static passwords.
- Support key mapping if provider uses different field names.

## 6) Environment Separation
Credentials are never shared across envs:
- `prod` creds cannot be read in `dev` runtime.
- `stage` can use stage-only identities.
- Break-glass credentials are separate records with explicit reason and TTL.

Enforcement checks must validate:
- agentId match
- environment match
- scope match
- policy/approval status

## 7) System-specific Baselines

### 7.1 AD On-Prem
Recommended scopes:
- `directory.read`
- `user.unlock`
- `user.reset-password` (approval required)
- `group.membership.read`

Prefer delegated service account per agent role; disallow Domain Admin secrets in standard flows.

### 7.2 Azure
Use Entra app registrations / managed identity.
Scopes via app roles only as required (e.g. Graph read, incident automation actions).

### 7.3 M365
Split monitors and mutators:
- monitor agent: `Mail.Read`, `ChannelMessage.Read.All` (where applicable)
- responder agent: `Mail.Send`, Teams reply permissions (separate agent)

### 7.4 Local Admin / Endpoint Ops
Use LAPS/JIT or per-host privileged broker. Avoid one shared local admin password across fleet.

## 8) Intake Agents (Teams / Email)

### 8.1 Teams Intake Agent
- Dedicated bot/app identity.
- Channel/team allowlist.
- Inbound message => task with source metadata (`teamId/channelId/messageId`).
- Idempotency key to prevent duplicate processing.

### 8.2 Email Intake Agent
- Dedicated mailbox or shared mailbox with service identity.
- Rules for eligible senders/subjects.
- Inbound email => task with source metadata (`messageId`, thread id).
- Auto-ack policy + anti-loop guards.

## 9) Policy + Tool Enforcement
Before tool execution:
1. Resolve requested action + required scope.
2. Resolve credential candidate by (`agentId`, `environment`, `system`, `scope`).
3. Evaluate risk and approval requirement.
4. Allow execution only with approved, non-expired credential.
5. Emit execution audit event with credential fingerprint/reference (never plaintext).

## 10) Audit Requirements
Every credential use event should log:
- timestamp
- agentId
- environment
- system
- scope
- taskId / ticketId
- approval artifact id (if any)
- decision (`allow|deny`)
- reason

## 11) Data Model Proposal (Minimal)

### `agent_credentials` (logical model)
- id
- agent_id
- environment
- system
- scope
- risk
- provider
- secret_ref
- approval_policy
- rotation_days
- expires_at
- enabled
- created_at / updated_at

### `credential_usage_audit`
- id
- timestamp
- agent_id
- credential_id
- task_id
- action
- decision
- reason
- approval_id

## 12) API Proposal (incremental)
1. `GET /api/credentials/catalog?agentId=&environment=&system=`
2. `POST /api/credentials/catalog` (create mapping record)
3. `PUT /api/credentials/catalog/:id` (update mapping/policy)
4. `POST /api/credentials/resolve` (policy-evaluated resolve for execution path)
5. `GET /api/credentials/usage` (audit view with filters)

## 13) Implementation Plan (3 increments)

### Increment A (foundation)
- Add credential catalog model (agent/env/system/scope metadata).
- Add API CRUD for catalog (admin only).
- Add dashboard section for catalog view.

### Increment B (enforcement)
- Add execution-time resolver gate in tool path.
- Deny when no matching credential or no approval.
- Add usage audit events and dashboard table.

### Increment C (intake channels)
- Teams intake adapter (MVP webhook/poll).
- Email intake adapter (MVP mailbox polling).
- Map incoming requests to task queue + assigned intake agent identity.

## 14) Acceptance Criteria
1. A tool run cannot start without a valid credential mapping for that agent/action/env.
2. Privileged scopes require explicit approval artifact.
3. Audit can answer: who used what, where, when, and why.
4. Teams/email intake can open tasks under dedicated agent identities.
5. No plaintext secrets exposed in UI/API logs.

## 15) Immediate Next Step
Start **Increment A**:
- implement credential catalog metadata + API + dashboard list.
- seed initial systems/scopes for `ad-onprem`, `azure`, `m365`, `windows-local`.

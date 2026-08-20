# RightAPI Forge IT Operations Platform — API Reference

> **Base URL:** `http://<host>:19123`  
> **API prefix:** `/api/`  
> **Auth:** `Authorization: Bearer <jwt_token>` (except where noted)  
> **Content-Type:** `application/json` (request and response)

---

## Table of Contents

1. [Authentication](#1-authentication)
2. [Health & Config](#2-health--config)
3. [Incidents](#3-incidents)
4. [Agents](#4-agents)
5. [Skills](#5-skills)
6. [Task Queue](#6-task-queue)
7. [Delegations](#7-delegations)
8. [Runbooks](#8-runbooks)
9. [Alert Rules](#9-alert-rules)
10. [Workflows](#10-workflows)
11. [Servers & Metrics](#11-servers--metrics)
12. [JIRA Integration](#12-jira-integration)
13. [Security & Credentials](#13-security--credentials)
14. [Approvals](#14-approvals)
15. [Settings](#15-settings)
16. [Users](#16-users)
17. [Mission Control](#17-mission-control)
18. [Agent Bus](#18-agent-bus)
19. [A2A Mesh](#19-a2a-mesh)
20. [MCP Server](#20-mcp-server)
21. [Scheduler](#21-scheduler)
22. [Orchestrator](#22-orchestrator)
23. [System & Admin](#23-system--admin)
24. [Metrics & SLA](#24-metrics--sla)
25. [Policies](#25-policies)
26. [WebSocket Events](#26-websocket-events)

---

## Authentication

All API routes that require authentication expect an `Authorization: Bearer <token>` header. Tokens are JWTs issued by the login endpoint and signed with `AUTH_TOKEN_SECRET`.

**Permissions:**

| Permission | Who has it |
|-----------|-----------|
| `security.read` | viewer, operator, admin |
| `security.write` | operator, admin |
| `config.write` | admin |
| `tools.execute.privileged` | admin |
| `delegations.read` | operator, admin |

---

### POST /api/auth/login

Login and receive a JWT. No auth header required.

**Request body:**
```json
{
  "username": "admin",
  "password": "<ADMIN_PASSWORD>"
}
```

**Response `200`:**
```json
{
  "success": true,
  "session": {
    "token": "eyJhbGci...",
    "username": "admin",
    "role": "admin",
    "expiresAt": "2026-01-01T00:00:00.000Z"
  },
  "source": "local"
}
```

`source` is `"local"` for local accounts, `"ldap"` when authenticated via LDAP.

**Response `401`:**
```json
{ "error": "Invalid credentials" }
```

---

### POST /api/auth/logout

Invalidates the client-side token. Stateless — client must discard the token.

**Auth:** Not required.

**Response `200`:**
```json
{ "success": true, "message": "Logged out. Discard your token on the client side." }
```

---

### GET /api/auth/me

Returns the currently authenticated user.

**Auth:** Any valid token.

**Response `200`:**
```json
{
  "username": "admin",
  "role": "admin",
  "displayName": "Administrator"
}
```

---

### GET /api/auth/providers

Returns available authentication providers.

**Auth:** Not required.

**Response `200`:**
```json
{
  "local": true,
  "ldap": false,
  "azure": false
}
```

---

### GET /auth/azure

Redirects to Azure AD authorization page. Only available when Azure AD is configured.

### GET /auth/azure/callback

Azure AD OAuth2 callback. Do not call directly.

---

## 2. Health & Config

### GET /api/health

Returns platform health. No auth required.

**Response `200`:**
```json
{
  "status": "ok",
  "timestamp": "2026-01-15T10:30:00.000Z",
  "monitoring": {
    "agents": {
      "director": 1,
      "sysadmins": 2,
      "specialists": 3
    },
    "system": {
      "uptime": 3600.5,
      "memory": {
        "rss": 154992640,
        "heapTotal": 94371840,
        "heapUsed": 82345678
      }
    }
  }
}
```

---

### GET /api/config

Returns current runtime configuration. API keys are masked.

**Auth:** Not required (masks sensitive fields).

**Response `200`:**
```json
{
  "defaultPlatform": "claude",
  "anthropicKey": "••••••••",
  "openaiKey": "",
  "ollamaUrl": "http://ollama:11434",
  "ollamaModel": "llama3"
}
```

---

### POST /api/config

Update runtime configuration.

**Auth:** `config.write`

**Request body** (any subset):
```json
{
  "defaultPlatform": "openai",
  "anthropicKey": "sk-ant-...",
  "openaiKey": "sk-...",
  "ollamaUrl": "http://localhost:11434",
  "ollamaModel": "llama3.2"
}
```

**Response `200`:**
```json
{ "success": true, "config": { ... } }
```

---

### GET /api/status

Returns a comprehensive platform status snapshot.

**Auth:** Not required.

**Response `200`:**
```json
{
  "agents": [...],
  "tasks": { "total": 42, "pending": 5, "in_progress": 3, "completed": 34 },
  "incidents": { "open": 2, "critical": 1, "slaBreached": 0 },
  "skills": [...],
  "alertRules": [...]
}
```

---

## 3. Incidents

### GET /api/incidents/stats

Returns aggregate incident statistics.

**Auth:** `security.read`

**Response `200`:**
```json
{
  "total": 150,
  "open": 12,
  "investigating": 3,
  "resolved": 130,
  "closed": 5,
  "critical": 2,
  "high": 5,
  "medium": 8,
  "low": 2,
  "slaBreached": 1
}
```

---

### GET /api/incidents

List incidents with optional filters.

**Auth:** `security.read`

**Query parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `status` | string | Filter: `open`, `investigating`, `escalated`, `resolved`, `closed` |
| `severity` | string | Filter: `critical`, `high`, `medium`, `low` |
| `assignedTo` | string | Filter by assigned agent username |
| `q` | string | Full-text search in title and description |
| `limit` | number | Max results per page (default: 50, max: 200) |
| `offset` | number | Pagination offset (default: 0) |

**Response `200`:**
```json
{
  "incidents": [
    {
      "id": "inc-1705312200000",
      "title": "Database connection pool exhausted",
      "severity": "critical",
      "status": "investigating",
      "assignedTo": "sysadmin-01",
      "source": "manual",
      "createdAt": "2026-01-15T10:30:00.000Z",
      "resolvedAt": null,
      "slaMinutes": 60,
      "slaBreached": false,
      "jiraKey": null,
      "jiraUrl": null
    }
  ],
  "total": 1,
  "limit": 50,
  "offset": 0
}
```

---

### POST /api/incidents

Create a new incident.

**Auth:** `security.write`

**Request body:**
```json
{
  "title": "Disk space critical on web-server-01",
  "severity": "high",
  "status": "open",
  "assignedTo": "sysadmin-01",
  "description": "Disk usage at 95% on /dev/sda1",
  "source": "manual"
}
```

| Field | Required | Values |
|-------|----------|--------|
| `title` | ✅ | string |
| `severity` | ✅ | `critical` \| `high` \| `medium` \| `low` |
| `status` | ✗ | default: `open` |
| `assignedTo` | ✗ | agent username |
| `description` | ✗ | string |
| `source` | ✗ | default: `manual` |

**Response `200`:** Full incident object (see GET /api/incidents format).

Broadcasts `incident_updated` WebSocket event.

---

### GET /api/incidents/export.csv

Download all incidents as CSV.

**Auth:** `security.read` (also accepts `?token=<jwt>` query parameter for direct browser download links)

**Response:** `Content-Type: text/csv` with filename `incidents.csv`

CSV columns: `id, title, severity, status, assignedTo, source, createdAt, resolvedAt, slaMinutes, slaBreached`

---

### GET /api/incidents/:id

Get a single incident.

**Auth:** `security.read`

**Response `200`:** Full incident object.  
**Response `404`:** `{ "error": "Not found" }`

---

### PATCH /api/incidents/:id

Update an incident.

**Auth:** `security.write`

**Request body** (any subset):
```json
{
  "status": "investigating",
  "assignedTo": "specialist-02",
  "severity": "critical",
  "description": "Updated description"
}
```

If `jiraKey` is linked and `status` is changed, the status change is mirrored to JIRA as a transition and comment.

**Response `200`:** Updated incident object.

---

### POST /api/incidents/:id/escalate

Escalate an incident.

**Auth:** `security.write`

**Request body:**
```json
{
  "reason": "Not resolved within SLA window",
  "newAssignee": "director-01"
}
```

**Response `200`:** Updated incident object.

---

### POST /api/incidents/:id/resolve

Resolve an incident.

**Auth:** `security.write`

**Request body:**
```json
{ "resolution": "Increased connection pool size to 200" }
```

**Response `200`:** Updated incident object.

---

### POST /api/incidents/:id/close

Close a resolved incident.

**Auth:** `security.write`

**Response `200`:** Updated incident object.

---

### POST /api/incidents/:id/note

Add a timestamped note to an incident.

**Auth:** `security.write`

**Request body:**
```json
{ "message": "Customer notified. Monitoring." }
```

Note is mirrored to linked JIRA ticket as a comment.

**Response `200`:**
```json
{
  "author": "admin",
  "message": "Customer notified. Monitoring.",
  "timestamp": "2026-01-15T11:00:00.000Z"
}
```

---

### POST /api/incidents/:incidentId/jira-link

Link an existing JIRA ticket to an incident.

**Auth:** `security.write`

**Request body:**
```json
{ "jiraKey": "OPS-42" }
```

**Response `200`:**
```json
{ "ok": true, "jiraKey": "OPS-42", "jiraUrl": "https://yourcompany.atlassian.net/browse/OPS-42" }
```

---

### POST /api/jira/create-from-incident/:incidentId

Create a new JIRA issue from an incident.

**Auth:** `security.write`

**Response `200`:**
```json
{ "ok": true, "jiraKey": "OPS-43" }
```

**Response `503`:** `{ "error": "Jira is not configured or disabled" }`

---

## 4. Agents

### GET /api/agents

Returns the full agent organization tree.

**Auth:** Not required.

**Response `200`:**
```json
{
  "director": {
    "id": "it-director",
    "name": "IT Director",
    "role": "director",
    "aiPlatform": "claude",
    "status": "active",
    "skills": ["incident_management", "delegation"],
    "taskCount": 5
  },
  "sysadmins": [...],
  "specialists": [...]
}
```

---

### POST /api/agents

Create a new agent.

**Auth:** Not required (uses runtime config).

**Request body:**
```json
{
  "name": "DevOps Specialist",
  "role": "specialist",
  "platform": "claude",
  "specialty": "kubernetes"
}
```

| Field | Values |
|-------|--------|
| `role` | `director` \| `sysadmin` \| `specialist` |
| `platform` | `claude` \| `openai` \| `ollama` |
| `specialty` | any string, e.g. `kubernetes`, `monitoring`, `jira` |

**Response `200`:** Agent object.

---

### PATCH /api/agents/:agentId

Update an agent's name, platform, or specialty.

**Auth:** `tools.execute.privileged`

**Request body** (any subset):
```json
{
  "name": "K8s Expert",
  "platform": "claude",
  "specialty": "kubernetes"
}
```

**Response `200`:** `{ "success": true, "agent": { ... } }`

---

### DELETE /api/agents/:agentId

Delete an agent.

**Auth:** `tools.execute.privileged`

**Response `200`:** `{ "success": true, "agentId": "..." }`  
**Response `404`:** `{ "error": "Agent not found or cannot be deleted" }`

---

### GET /api/agents/:agentId/history

Get an agent's conversation history.

**Auth:** Not required.

**Response `200`:**
```json
{
  "agentId": "sysadmin-01",
  "agentName": "SysAdmin Alpha",
  "messages": [
    { "role": "user", "content": "Check disk usage on web-01" },
    { "role": "assistant", "content": "Disk usage: 45% on /dev/sda1" }
  ]
}
```

---

### GET /api/agents/:agentId/tasks

Get all tasks for a specific agent.

**Auth:** `delegations.read`

---

### GET /api/agents/capabilities

Returns a list of all agent capability tags.

**Auth:** Not required.

---

### GET /api/agents/metrics

Returns per-agent task performance metrics.

**Auth:** Not required.

---

### POST /api/agents/:id/message

Send a message to an agent (triggers AI response).

**Auth:** Not required.

**Request body:**
```json
{ "message": "What is the current disk usage on all servers?" }
```

**Response `200`:**
```json
{
  "response": "I'll check that for you...",
  "agentId": "sysadmin-01"
}
```

---

### GET /api/agents/:id/conversations

Get conversation threads for an agent.

---

### GET /api/agents/:id/logs

Get execution logs for an agent.

---

### GET /api/agents/:id/activity

Get recent activity for an agent.

---

## 5. Skills

### GET /api/skills

Returns all available skills.

**Auth:** Not required.

**Response `200`:**
```json
{
  "skills": [
    {
      "id": "disk_cleanup",
      "name": "Disk Cleanup",
      "description": "Remove old log files and temp files",
      "command": "disk.cleanup"
    }
  ]
}
```

---

### POST /api/skills/execute

Execute a skill by command string.

**Auth:** `security.write`

**Request body:**
```json
{
  "command": "disk.cleanup",
  "params": {
    "target": "/var/log",
    "olderThanDays": 30
  }
}
```

**Response `200`:** `{ "result": <skill output> }`

---

### POST /api/agents/:agentId/skills

Assign a skill to an agent.

**Auth:** `tools.execute.privileged`

**Request body:**
```json
{ "skillId": "disk_cleanup" }
```

**Response `200`:** `{ "success": true, "agent": { ... } }`

---

### DELETE /api/agents/:agentId/skills/:skillId

Remove a skill from an agent.

**Auth:** `tools.execute.privileged`

**Response `200`:** `{ "success": true, "agent": { ... } }`

---

## 6. Task Queue

### GET /api/tasks

Returns all tasks (flat list).

**Auth:** Not required.

**Response `200`:** Array of task objects.

---

### GET /api/task-queue

Returns all tasks with statistics.

**Auth:** Not required.

**Response `200`:**
```json
{
  "tasks": [...],
  "count": 42,
  "stats": {
    "pending": 5,
    "inProgress": 3,
    "completed": 34
  }
}
```

---

### GET /api/task-queue/stats

Returns task queue statistics only (no task array).

**Auth:** Not required.

**Response `200`:**
```json
{
  "total": 42,
  "pending": 5,
  "inProgress": 3,
  "completed": 34,
  "failed": 0,
  "assigned": 2,
  "cancelled": 0,
  "dropped": 0,
  "rollingBack": 0,
  "rolledBack": 0
}
```

---

### POST /api/task-queue

Create a new task.

**Auth:** Not required.

**Request body:**
```json
{
  "title": "Investigate high CPU on db-server-01",
  "assignedTo": "sysadmin-01",
  "priority": "high",
  "description": "CPU at 95% for the past 10 minutes"
}
```

**Response `200`:** Task object.

---

### PUT /api/task-queue/:taskId/status

Update task status.

**Auth:** `tools.execute.privileged`

**Request body:**
```json
{ "status": "completed" }
```

Valid statuses: `pending`, `assigned`, `in_progress`, `completed`, `failed`, `blocked`, `cancelled`, `dropped`, `rolling_back`, `rolled_back`

Aliases accepted: `in-progress` → `in_progress`, `rolling-back` → `rolling_back`, `rolled-back` → `rolled_back`

**Response `200`:** `{ "success": true, "task": { ... } }`

---

### PATCH /api/task-queue/:taskId

Reassign a task to a different agent.

**Auth:** Not required.

**Request body:**
```json
{ "assignedTo": "specialist-02" }
```

**Response `200`:** `{ "success": true, "task": { ... } }`

---

### PUT /api/tasks/:taskId/status

Alias for `PUT /api/task-queue/:taskId/status`.

**Auth:** `tools.execute.privileged`

---

### GET /api/tasks/:taskId/subtasks

Get subtasks of a task.

---

### POST /api/tasks/:taskId/subtasks

Create a subtask.

---

### GET /api/tasks/:taskId/timeline

Get a chronological timeline of task state changes.

---

### GET /api/tasks/:taskId/snapshots

Get task snapshots (for rollback purposes).

---

### GET /api/tasks/:taskId/snapshots/:snapshotId

Get a specific snapshot.

---

### POST /api/tasks/:taskId/snapshots/:snapshotId/restore

Restore a task to a snapshot state.

---

### GET /api/tasks/:taskId/activity

Get activity log for a task.

---

### POST /api/tasks/:taskId/cancel

Cancel a task.

---

### POST /api/tasks/:taskId/drop

Drop a task (remove from queue without completion).

---

### POST /api/tasks/:taskId/rollback/request

Request a rollback for a task.

---

### GET /api/tasks/:taskId/rollback/preview

Preview what a rollback would do.

---

### POST /api/tasks/:taskId/rollback/apply

Apply a rollback.

---

### GET /api/tasks/:taskId/graph

Returns the task dependency graph as a DAG.

---

## 7. Delegations

### GET /api/delegations

List all delegations.

**Auth:** Not required.

**Query params:** `state` (filter by delegation state)

---

### GET /api/delegations/:delegationId

Get a single delegation.

---

### POST /api/delegations

Create a new delegation.

**Request body:**
```json
{
  "fromAgentId": "director-01",
  "toAgentId": "sysadmin-01",
  "taskId": "task-abc123",
  "instructions": "Investigate and resolve the disk space issue"
}
```

---

### POST /api/delegations/:delegationId/transition

Transition a delegation to a new state.

**Request body:**
```json
{ "event": "accept" }
```

Valid events: `accept`, `reject`, `complete`, `fail`, `revoke`

---

### GET /api/delegations/policy

Get the current delegation policy.

---

### POST /api/delegations/policy

Update the delegation policy.

---

## 8. Runbooks

Base path: `/api/runbooks`

### GET /api/runbooks/templates

List all runbook templates.

**Auth:** `security.read`

**Response `200`:**
```json
[
  {
    "id": "rb-disk-cleanup",
    "name": "Disk Cleanup",
    "description": "Remove old logs and temp files",
    "steps": [
      { "id": "step-1", "name": "Find old files", "command": "find /var/log -mtime +30", "requiresApproval": false },
      { "id": "step-2", "name": "Delete files", "command": "find /var/log -mtime +30 -delete", "requiresApproval": true }
    ],
    "linkedSkill": "disk.cleanup",
    "createdAt": "2026-01-01T00:00:00.000Z"
  }
]
```

---

### GET /api/runbooks/templates/:id

Get a single runbook template.

---

### POST /api/runbooks/templates

Create a runbook template.

**Auth:** `security.write`

**Request body:**
```json
{
  "name": "Restart Service",
  "description": "Restart a named systemd service",
  "steps": [
    { "name": "Check status", "command": "systemctl status {service}", "requiresApproval": false },
    { "name": "Restart", "command": "systemctl restart {service}", "requiresApproval": true }
  ]
}
```

---

### PATCH /api/runbooks/templates/:id

Update a runbook template.

**Auth:** `security.write`

---

### DELETE /api/runbooks/templates/:id

Delete a runbook template.

**Auth:** `security.write`

---

### GET /api/runbooks/runs

List runbook execution history.

**Query params:** `templateId`, `status`, `limit`, `offset`

---

### GET /api/runbooks/runs/export.csv

Download execution history as CSV.

---

### GET /api/runbooks/runs/:id

Get a single runbook run.

---

### POST /api/runbooks/runs

Execute a runbook template.

**Auth:** `security.write`

**Request body:**
```json
{
  "templateId": "rb-disk-cleanup",
  "params": { "target": "/var/log" },
  "assignedTo": "sysadmin-01"
}
```

---

### POST /api/runbooks/runs/:id/approve

Approve a pending step in a runbook run.

**Auth:** `security.write`

---

### POST /api/runbooks/runs/:id/cancel

Cancel a running runbook execution.

**Auth:** `security.write`

---

## 9. Alert Rules

### GET /api/alert-rules

List all alert rules.

**Auth:** `security.read`

**Response `200`:**
```json
[
  {
    "id": "rule-cpu-critical",
    "name": "CPU Critical",
    "condition": "cpu_percent > 90",
    "severity": "critical",
    "enabled": true,
    "remediationRunbookId": "rb-disk-cleanup",
    "createdAt": "2026-01-01T00:00:00.000Z"
  }
]
```

---

### POST /api/alert-rules

Create an alert rule.

**Auth:** `security.write`

**Request body:**
```json
{
  "name": "High Memory Usage",
  "condition": "memory_percent > 85",
  "severity": "high",
  "enabled": true,
  "remediationRunbookId": null
}
```

---

### PUT /api/alert-rules/:id

Update an alert rule.

**Auth:** `security.write`

---

### DELETE /api/alert-rules/:id

Delete an alert rule.

**Auth:** `security.write`

**Response `200`:** `{ "success": true }`

---

### POST /api/alert-rules/:id/evaluate-now

Manually trigger evaluation of all alert rules.

**Auth:** `security.write`

**Response `200`:** `{ "success": true }`

---

## 10. Workflows

Base path: `/api/workflows`

### GET /api/workflows/templates

List workflow templates.

### POST /api/workflows/templates

Create a workflow template.

**Request body:**
```json
{
  "name": "Deploy Pipeline",
  "stages": [
    { "name": "Build", "assignTo": "sysadmin-01", "runbookId": "rb-build" },
    { "name": "Test", "assignTo": "specialist-01", "runbookId": "rb-test" },
    { "name": "Deploy", "assignTo": "director-01", "runbookId": "rb-deploy" }
  ],
  "trigger": { "type": "manual" }
}
```

### PATCH /api/workflows/templates/:id/schedule

Update the schedule (cron trigger) for a workflow template.

**Request body:**
```json
{ "cron": "0 2 * * *", "enabled": true }
```

### GET /api/workflows/runs

List workflow executions.

### GET /api/workflows/runs/:id

Get a workflow execution.

### POST /api/workflows/runs

Trigger a workflow execution.

**Request body:**
```json
{ "templateId": "wf-deploy", "params": {} }
```

### PATCH /api/workflows/runs/:id/stages/:stage

Update a workflow stage.

### POST /api/workflows/runs/:id/reconcile

Force reconciliation of a running workflow (re-evaluate stage states).

### GET /api/workflows/runs/:id/recommend-assignee

Get AI-recommended agent assignment for the next pending stage.

### GET /api/workflows/health

Returns workflow engine health.

### POST /api/workflows/trigger

Trigger a workflow by name or ID.

---

## 11. Servers & Metrics

### GET /api/servers

Returns the list of monitored servers.

**Auth:** Not required.

**Response `200`:**
```json
[
  { "ip": "192.168.1.10", "name": "web-server-01" },
  { "ip": "192.168.1.11", "name": "db-server-01" }
]
```

---

### GET /api/servers/metrics

Returns cached health metrics for all monitored servers.

**Auth:** Any valid token.

**Response `200`:**
```json
{
  "servers": [
    {
      "ip": "192.168.1.10",
      "name": "web-server-01",
      "cpu": 45.2,
      "memory": 67.8,
      "disk": 55.0,
      "uptime": 1209600,
      "load": "0.85 0.92 0.88",
      "status": "healthy",
      "reachable": true
    }
  ],
  "cachedAt": "2026-01-15T10:29:00.000Z"
}
```

Metrics are cached for 60 seconds. `status` is one of: `healthy`, `warning`, `critical`, `unreachable`.

---

### POST /api/servers/metrics/refresh

Force a fresh metric collection (bypasses cache).

**Auth:** Any valid token.

**Response `200`:** Same as `GET /api/servers/metrics`.

---

### GET /api/performance

Returns performance metrics for the RightAPI Forge platform.

**Response `200`:**
```json
{
  "requests": { "total": 5423, "perMinute": 12.5 },
  "latency": { "p50": 45, "p95": 120, "p99": 350 },
  "tasks": { "throughput": 2.3 }
}
```

---

### GET /api/performance/history

Returns historical performance data points.

---

## 12. JIRA Integration

### GET /api/jira/sync/status

Returns JIRA sync status.

**Auth:** `security.read`

**Response `200`:**
```json
{
  "enabled": true,
  "lastPolledAt": "2026-01-15T10:15:00.000Z",
  "lastTicketCount": 23,
  "nextPollAt": "2026-01-15T10:30:00.000Z",
  "pollIntervalMinutes": 15
}
```

---

### POST /api/jira/sync/trigger

Trigger an immediate JIRA sync.

**Auth:** `security.write`

**Response `200`:** `{ "triggered": true, "message": "Sync triggered" }`

---

### GET /api/jira/tickets

List JIRA tickets.

**Auth:** `security.read`

**Query parameters:**

| Parameter | Description |
|-----------|-------------|
| `project` | Filter by JIRA project key |
| `q` | Free-text search |
| `jql` | Custom JQL query (overrides other filters) |
| `maxResults` | Max tickets to return (default: 50) |

**Response `200`:**
```json
{
  "tickets": [
    {
      "key": "OPS-42",
      "summary": "Database connection pool exhausted",
      "status": "In Progress",
      "priority": "High",
      "assignee": "john.doe@example.com",
      "created": "2026-01-10T08:00:00.000Z",
      "updated": "2026-01-15T09:00:00.000Z",
      "url": "https://yourcompany.atlassian.net/browse/OPS-42"
    }
  ]
}
```

---

### GET /api/jira/tickets/:key

Get a single JIRA ticket by key.

**Auth:** `security.read`

---

### POST /api/jira/import/:key

Import a JIRA ticket as a RightAPI Forge incident.

**Auth:** `security.write`

**Response `200`:**
```json
{
  "incident": { ... },
  "alreadyExisted": false
}
```

---

## 13. Security & Credentials

### GET /api/security/status

Returns security system status.

**Auth:** `security.read`

**Response `200`:**
```json
{
  "credentialVault": { "initialized": true, "entries": 3 },
  "approvalTokens": { "active": 1, "expired": 5 },
  "auditLog": { "totalEntries": 423, "last24h": 47 },
  "rateLimiting": { "enabled": true, "requestsPerMinute": 100 }
}
```

---

### GET /api/audit/executions

Returns the execution audit log.

**Auth:** `security.read`

**Query params:** `actor`, `status`, `limit`, `offset`

**Response `200`:**
```json
{
  "entries": [
    {
      "id": "audit-001",
      "timestamp": "2026-01-15T10:00:00.000Z",
      "actor": "admin",
      "action": "skill.execute",
      "tool": "disk.cleanup",
      "target": "192.168.1.10",
      "status": "success",
      "durationMs": 2340
    }
  ],
  "total": 423
}
```

---

### GET /api/audit/executions/export

Export audit log as CSV.

**Auth:** `security.read`

---

### GET /api/credentials/:agentId

Get credentials for an agent (values masked).

**Auth:** `security.read`

---

### POST /api/credentials

Store credentials.

**Auth:** `security.write`

**Request body:**
```json
{
  "agentId": "sysadmin-01",
  "type": "ssh_key",
  "label": "prod-server-key",
  "value": "-----BEGIN RSA PRIVATE KEY-----..."
}
```

---

### DELETE /api/credentials/:id

Delete stored credentials.

**Auth:** `security.write`

---

### GET /api/security/rate-limit

Returns rate limiting status.

---

### GET /api/security/audit

Returns security audit events.

---

### GET /api/tools/policies

Returns all tool security policies.

---

### GET /api/tools/catalog

Returns the tool security catalog.

---

### GET /api/tools/concurrency-policy

Returns the tool concurrency policy.

---

### POST /api/tools/concurrency-policy

Update the tool concurrency policy.

**Auth:** `config.write`

---

### GET /api/tools/target-allowlist-policy

Returns the privileged target allowlist policy.

---

### POST /api/tools/target-allowlist-policy

Update the target allowlist policy.

**Auth:** `config.write`

---

## 14. Approvals

### POST /api/approvals/tokens

Create an approval token for a privileged operation.

**Auth:** `tools.execute.privileged`

**Request body:**
```json
{
  "operation": "ssh.execute",
  "target": "192.168.1.10",
  "command": "systemctl restart nginx",
  "expiresInMinutes": 30
}
```

**Response `200`:**
```json
{
  "tokenId": "appr-abc123",
  "token": "eyJ...",
  "expiresAt": "2026-01-15T11:00:00.000Z"
}
```

---

### POST /api/approvals/revoke

Revoke an approval token.

**Auth:** `tools.execute.privileged`

**Request body:** `{ "tokenId": "appr-abc123" }`

---

### GET /api/approvals/status/:tokenId

Check the status of an approval token.

---

### GET /api/approvals/ledger

Get the full approval token ledger.

**Auth:** `security.read`

---

## 15. Settings

### GET /api/settings/smtp

Get current SMTP configuration (password masked).

**Auth:** `config.write`

**Response `200`:**
```json
{
  "host": "smtp.gmail.com",
  "port": 587,
  "secure": false,
  "user": "alerts@example.com",
  "pass": "••••••••",
  "from": "RightAPI Forge Alerts <alerts@example.com>",
  "to": ["ops-team@example.com"],
  "enabled": true
}
```

---

### POST /api/settings/smtp

Save SMTP configuration.

**Auth:** `config.write`

**Request body:** Same schema as GET response (use `"pass": "••••••••"` to keep existing password unchanged).

---

### POST /api/settings/smtp/test

Test SMTP connection by sending a test email.

**Auth:** `config.write`

**Response `200`:** `{ "success": true }` or `{ "success": false, "error": "..." }`

---

### GET /api/settings/ad

Get Active Directory / LDAP configuration.

**Auth:** `config.write`

---

### PUT /api/settings/ad

Update Active Directory configuration.

**Auth:** `config.write`

---

### POST /api/settings/ad/test

Test the AD connection.

**Auth:** `config.write`

---

### GET /api/settings/teams

Get Microsoft Teams webhook configuration.

**Auth:** `config.write`

---

### PUT /api/settings/teams

Update Microsoft Teams configuration.

**Auth:** `config.write`

**Request body:**
```json
{
  "enabled": true,
  "incidentWebhookUrl": "https://outlook.office.com/webhook/...",
  "escalationWebhookUrl": "https://outlook.office.com/webhook/...",
  "outgoingWebhookSecret": "secret"
}
```

---

### POST /api/settings/teams/test

Send a test message to the configured Teams webhook.

**Auth:** `config.write`

---

## 16. Users

### GET /api/auth/users

List all users.

**Auth:** `config.write`

**Response `200`:**
```json
[
  { "username": "admin", "role": "admin", "displayName": "Administrator", "email": null },
  { "username": "ops-user", "role": "operator", "displayName": "Ops User", "email": "ops@example.com" }
]
```

---

### POST /api/auth/users

Create a new user.

**Auth:** `config.write`

**Request body:**
```json
{
  "username": "newuser",
  "password": "SecurePass123!",
  "role": "operator",
  "displayName": "New User",
  "email": "newuser@example.com"
}
```

Valid roles: `admin`, `operator`, `viewer`

**Response `200`:** `{ "success": true, "username": "newuser" }`

---

### PATCH /api/auth/users/:username

Update a user (role, password, displayName).

**Auth:** `config.write`

**Request body** (any subset):
```json
{
  "role": "viewer",
  "password": "NewPass123!",
  "displayName": "Updated Name"
}
```

---

### DELETE /api/auth/users/:username

Delete a user.

**Auth:** `config.write`

**Response `200`:** `{ "success": true }`

---

## 17. Mission Control

Base path: `/api/mission-control`

### GET /api/mission-control/dashboard

Returns a mission control dashboard snapshot with running tasks, agent workloads, and recent activity.

**Auth:** Required.

### GET /api/mission-control/agents

Returns agent status for mission control.

### GET /api/mission-control/tasks

Returns current task assignments.

### POST /api/mission-control/actions

Perform a mission control action (e.g., reassign, cancel).

**Request body:**
```json
{
  "action": "reassign",
  "taskId": "task-abc123",
  "targetAgentId": "sysadmin-02"
}
```

### GET /api/mission-control/skills

Returns skills available in mission control context.

### GET /api/mission-control/logs

Returns recent mission control log entries.

### GET /api/mission-control/activity

Returns real-time activity stream.

---

## 18. Agent Bus

The Agent Bus enables agent-to-agent messaging within RightAPI Forge.

### GET /api/agent-bus/threads

List all agent bus message threads.

**Auth:** `security.read`

---

### GET /api/agent-bus/messages

List messages on the agent bus.

**Auth:** `security.read`

**Query params:** `fromAgentId`, `toAgentId`, `threadId`

---

### POST /api/agent-bus/send

Send a message on the agent bus.

**Auth:** `security.write`

**Request body:**
```json
{
  "fromAgentId": "director-01",
  "toAgentId": "sysadmin-01",
  "message": "Please check disk usage on all servers",
  "threadId": null
}
```

---

### POST /api/agent-bus/swarm

Send a message to a swarm of agents simultaneously.

**Auth:** `security.write`

**Request body:**
```json
{
  "fromAgentId": "director-01",
  "agentIds": ["sysadmin-01", "sysadmin-02"],
  "message": "Report your current task status"
}
```

---

### GET /api/agentbus/status

Returns the agent bus health and statistics.

---

## 19. A2A Mesh

The A2A (Agent-to-Agent) API implements the Google A2A specification.

### GET /.well-known/agent.json

Returns RightAPI Forge's A2A agent card. No auth required. Used by external agents to discover capabilities.

**Response `200`:**
```json
{
  "name": "RightAPI Forge IT Operations",
  "description": "AI-powered IT operations platform",
  "url": "http://forge.example.com:19123",
  "version": "1.0.0",
  "capabilities": { "streaming": true, "pushNotifications": false },
  "skills": [...]
}
```

---

### GET /a2a/agents

List all internal A2A agents.

**Auth:** `security.read`

---

### GET /a2a/agents/:id

Get a specific A2A agent.

---

### POST /a2a/agents/:id

Send a task to an A2A agent (JSON-RPC 2.0).

**Request body** (A2A `tasks/send`):
```json
{
  "jsonrpc": "2.0",
  "id": "req-001",
  "method": "tasks/send",
  "params": {
    "id": "task-001",
    "message": {
      "role": "user",
      "parts": [{ "type": "text", "text": "Check disk usage on all servers" }]
    }
  }
}
```

**Response `200`:**
```json
{
  "jsonrpc": "2.0",
  "id": "req-001",
  "result": {
    "id": "task-001",
    "status": { "state": "completed" },
    "artifacts": [{ "parts": [{ "type": "text", "text": "Disk usage: 45% on web-01..." }] }]
  }
}
```

---

### GET /a2a/tasks/:taskId

Get a specific A2A task.

### GET /a2a/agents/:id/tasks

List tasks for a specific A2A agent.

### GET /a2a/tasks

List all A2A tasks.

### GET /a2a/tasks/:taskId/events

Server-Sent Events (SSE) stream for task progress.

---

### GET /a2a/external

List registered external A2A peers.

### POST /a2a/external

Register an external A2A peer.

**Request body:**
```json
{
  "name": "External Security Scanner",
  "url": "http://scanner-agent:8080",
  "authType": "bearer",
  "token": "secret-token"
}
```

### POST /a2a/external/:id/refresh

Re-fetch the agent card for a peer.

### PATCH /a2a/external/:id/auth

Update authentication credentials for a peer.

### DELETE /a2a/external/:id

Remove an external peer.

### GET /a2a/peers

List all known peers (internal + external).

---

## 20. MCP Server

### GET /api/mcp/tools

Returns the MCP tool catalogue.

**Auth:** Not required.

**Response `200`:**
```json
{
  "tools": [
    {
      "name": "list_incidents",
      "description": "List IT incidents with optional filters",
      "inputSchema": {
        "type": "object",
        "properties": {
          "severity": { "type": "string", "enum": ["critical", "high", "medium", "low"] },
          "status": { "type": "string" },
          "limit": { "type": "number" }
        }
      }
    }
  ],
  "endpoint": "/mcp"
}
```

---

### POST /mcp

MCP JSON-RPC 2.0 endpoint. Used by MCP clients (Claude Desktop, Cursor, etc.).

**Content-Type:** `application/json`

**Example — initialize:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": { "protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": { "name": "claude-desktop" } }
}
```

**Example — call tool:**
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "list_incidents",
    "arguments": { "severity": "critical", "limit": 10 }
  }
}
```

---

## 21. Scheduler

### GET /api/scheduler/tasks

List all scheduled tasks.

**Auth:** `security.read`

**Response `200`:**
```json
[
  {
    "id": "sched-001",
    "name": "Daily disk check",
    "cron": "0 8 * * *",
    "action": "runbook",
    "actionId": "rb-disk-cleanup",
    "enabled": true,
    "lastRun": "2026-01-15T08:00:00.000Z",
    "nextRun": "2026-01-16T08:00:00.000Z"
  }
]
```

---

### POST /api/scheduler/tasks

Create a scheduled task.

**Auth:** `security.write`

**Request body:**
```json
{
  "name": "Daily disk check",
  "cron": "0 8 * * *",
  "action": "runbook",
  "actionId": "rb-disk-cleanup",
  "enabled": true
}
```

---

### PUT /api/scheduler/tasks/:id

Update a scheduled task.

**Auth:** `security.write`

---

### DELETE /api/scheduler/tasks/:id

Delete a scheduled task.

**Auth:** `security.write`

---

### POST /api/scheduler/tasks/:id/run-now

Execute a scheduled task immediately.

**Auth:** `security.write`

---

## 22. Orchestrator

### GET /api/orchestrator/status

Returns orchestrator engine status (running tasks, recovery events, health).

**Auth:** `security.read`

---

### GET /api/orchestrator/reliability-slo

Returns the current reliability SLO and tuning suggestions.

**Auth:** `security.read`

---

### POST /api/orchestrator/reliability-slo/apply

Apply an SLO tuning suggestion.

**Auth:** `config.write`

**Request body:**
```json
{
  "suggestionId": "suggestion-abc",
  "expectedRevision": 3
}
```

---

### GET /api/orchestrator/reliability-policy

Get the current orchestrator reliability policy.

**Auth:** `security.read`

---

### POST /api/orchestrator/reliability-policy

Update the orchestrator reliability policy.

**Auth:** `config.write`

**Request body:**
```json
{
  "autoRecoverEnabled": true,
  "stuckThresholdMinutes": 30,
  "retryLimit": 3,
  "retryCooldownMinutes": 5,
  "expectedRevision": 3
}
```

---

### POST /api/orchestrator/tick

Manually trigger an orchestrator tick (runs recovery checks).

**Auth:** `security.write`

---

## 23. System & Admin

### GET /api/system/backups

List all backups.

**Auth:** `security.read`

---

### GET /api/system/backups/inventory

Returns the discovered persistent databases and JSON/JSONL state beneath the configured data root, their sensitivity classification, the backup mechanism covering each file, uncovered files, and the declared Docker volumes.

**Auth:** `security.read`

---

### POST /api/system/backups/create

Create a new state backup.

**Auth:** `config.write`

---

### GET /api/system/backups/:backupId/verify

Verify backup integrity.

**Auth:** `security.read`

---

### POST /api/system/backups/:backupId/restore

Restore from a backup.

**Auth:** `config.write`

---

### GET /api/system/backups/health

Returns backup system health.

---

### GET /api/system/backups/scheduler

Returns backup scheduler configuration.

---

### POST /api/system/backups/scheduler/run

Trigger a backup scheduler run immediately.

**Auth:** `config.write`

---

### GET /api/admin/retention/stats

Returns lifecycle policy, per-source record counts and sizes, verified checkpoint history, the last run report, and the next scheduled run.

**Auth:** `security.read`

---

### POST /api/admin/retention/sweep

Preview or execute a lifecycle sweep. The safe default is a non-destructive preview; pass `{ "dryRun": false }` to archive, verify, and then prune eligible records.

**Auth:** `config.write`

---

### GET /api/admin/retention/checkpoints/:id/verify

Recalculate archived file checksums and SQLite/JSON integrity for a lifecycle rollback checkpoint.

**Auth:** `security.read`

---

### GET /api/provider-health

Returns authenticated synthetic-inference health, latency/error budgets, route identity, breaker state, and any active provider alert.

**Auth:** `security.read`

---

### POST /api/provider-health/probe

Run an authenticated provider probe immediately.

**Auth:** `config.write`

---

### POST /api/provider-health/reset

Reset the primary, fallback, or all provider circuit breakers. Body: `{ "route": "primary" | "fallback" }`; omit `route` to reset both.

**Auth:** `config.write`

---

### GET /api/operations/running

Returns currently running operations (tasks in progress).

---

### GET /api/factory/board

Returns the factory board (task kanban state).

---

### GET /api/factory/status

Returns factory service status.

---

## 24. Metrics & SLA

### GET /api/metrics/autonomy

Returns attributable incident outcome metrics. `windowDays` optionally limits the cohort to attempts and incidents created within that many days (1-3650). The response retains `autonomousResolutionRate`, `mttrMinutes`, `falseResolveRate`, and `layerCoverage`, and adds the evaluated window, attribution coverage, counts by terminal classification, and per-classification rates and MTTR.

Terminal classifications are `verified_autonomous`, `assisted`, `false_resolution`, `failed`, and `human_handoff`. An autonomous resolution is credited only after its verifier passes. Resolved historical incidents without an attempt are counted as human handoffs rather than autonomous successes.

### GET /api/metrics/autonomy/attempts

Lists the durable trace behind the aggregate metrics, including incident, task, agent, dispatch, execution, tool, fallback, escalation, verification, and terminal phases.

**Auth:** `security.read`

**Query:** `windowDays`, `classification`, `incidentId`, `limit`

### GET /api/metrics/autonomy/attempts/:attemptId

Returns one attributable attempt trace.

**Auth:** `security.read`

### GET /api/metrics/sla

Returns current SLA metrics.

**Auth:** `security.read`

---

### GET /api/metrics/sla/snapshots

List SLA metric snapshots.

**Auth:** `security.read`

---

### POST /api/metrics/sla/snapshots/capture

Capture a new SLA snapshot.

**Auth:** `security.write`

---

### GET /api/metrics/sla/snapshot-policy

Get the SLA snapshot capture policy.

---

### POST /api/metrics/sla/snapshot-policy

Update the SLA snapshot policy.

**Auth:** `config.write`

---

### GET /api/agents/metrics

Returns per-agent performance metrics.

---

### GET /metrics

Prometheus-compatible metrics endpoint (no auth required). Returns text/plain metrics in Prometheus exposition format.

Ticketing sync observability includes `beacon_ticketing_sync_total{system,status}`, where `system` is `jira`, `github`, or `none`; `status` includes `success`, `error`, `skipped`, `ignored_unresolved`, and `ignored_already_synced`.

---

## 25. Policies

### GET /api/policies/export

Export all policies as a JSON bundle.

**Auth:** `security.read`

---

### POST /api/policies/import

Import a policy bundle.

**Auth:** `config.write`

---

### GET /api/policies/audit

Returns the policy change audit log.

**Auth:** `security.read`

---

## 26. WebSocket Events

Connect to the WebSocket server at `ws://<host>:19123`.

No authentication is required for the WebSocket connection, but sensitive data in events is omitted for unauthenticated connections.

**Connecting:**
```javascript
const ws = new WebSocket('ws://localhost:19123');
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  console.log(msg.type, msg.data);
};
```

---

### Event Reference

All events have the shape: `{ "type": "<event_type>", "data": { ... } }`

#### `task_update`

Emitted when a task changes state.

```json
{
  "type": "task_update",
  "data": {
    "taskId": "task-abc123",
    "status": "completed",
    "assignedTo": "sysadmin-01",
    "updatedAt": "2026-01-15T10:30:00.000Z"
  }
}
```

#### `agent_status`

Emitted when an agent's status changes.

```json
{
  "type": "agent_status",
  "data": {
    "agentId": "sysadmin-01",
    "status": "active",
    "currentTask": "task-abc123"
  }
}
```

#### `message_complete`

Emitted when an agent finishes streaming a chat response.

```json
{
  "type": "message_complete",
  "data": {
    "agentId": "sysadmin-01",
    "messageId": "msg-xyz789",
    "content": "Disk usage on web-01 is 45%."
  }
}
```

#### `incident_created`

Emitted when a new incident is created.

```json
{
  "type": "incident_created",
  "data": {
    "id": "inc-1705312200000",
    "title": "High CPU on db-server-01",
    "severity": "critical",
    "status": "open"
  }
}
```

#### `incident_updated`

Emitted when an incident is updated (status change, note added, etc.).

```json
{
  "type": "incident_updated",
  "data": { <full incident object or partial update> }
}
```

#### `jira_sync_complete`

Emitted after a JIRA sync completes.

```json
{
  "type": "jira_sync_complete",
  "data": { "count": 5 }
}
```

#### `retention_sweep`

Emitted after a data retention sweep.

```json
{
  "type": "retention_sweep",
  "data": {
    "purgedInc": 12,
    "purgedMsg": 430,
    "purgedFacts": 89,
    "sweptAt": "2026-01-15T00:00:00.000Z"
  }
}
```

---

### Typed Application Builder

All builder routes require an authenticated principal and are tenant-scoped. Read routes require `builder.read`; project changes, generation, gates, and previews require `builder.build`; release decisions require `builder.review`; deployment and rollback require `builder.deploy`. The built-in viewer, operator, and tenant-admin roles receive progressively broader access, while custom roles can keep builders, reviewers, and deployers separate. Generation returns files without executing them. Preview and deployment are the only builder operations that execute generated artifacts, and both use isolated containers.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/builder/projects` | List active projects for the current tenant |
| `POST` | `/api/builder/conversations` | Create a project from a message and optional validated `proposedSpec` |
| `GET` | `/api/builder/projects/:id` | Read the current project revision |
| `GET` | `/api/builder/projects/:id/revisions` | Read immutable revision history |
| `GET` | `/api/builder/projects/:id/revisions/compare` | Return a structured diff between two immutable revisions |
| `POST` | `/api/builder/projects/:id/messages` | Refine with a deterministic or AI-assisted message, optional full `proposedSpec`, and optional `expectedRevision` |
| `POST` | `/api/builder/projects/:id/visual-edits` | Apply an allowlisted component property edit |
| `POST` | `/api/builder/projects/:id/undo` | Restore the previous persisted edit state as a new immutable revision |
| `POST` | `/api/builder/projects/:id/redo` | Restore the next persisted edit state as a new immutable revision |
| `POST` | `/api/builder/projects/:id/generate` | Generate an allowlisted full-stack artifact without executing it |
| `GET` | `/api/builder/projects/:id/gates` | List immutable quality evidence, optionally filtered by `revision` |
| `POST` | `/api/builder/projects/:id/gates` | Run and persist quality gates for the current revision |
| `GET` | `/api/builder/gates/:id` | Read tenant-scoped evidence and verify its signature |
| `GET` | `/api/builder/projects/:id/releases` | List immutable releases for a project |
| `POST` | `/api/builder/projects/:id/releases` | Request review for the current passing revision |
| `GET` | `/api/builder/releases/:id` | Read a release and its ordered audit events |
| `POST` | `/api/builder/releases/:id/review` | Approve or reject a release as an independent reviewer |
| `POST` | `/api/builder/releases/:id/deploy` | Git-export and stage an approved exact artifact, then promote it after health verification |
| `GET` | `/api/builder/projects/:id/deployments` | List immutable deployment history for a project |
| `POST` | `/api/builder/deployments/:id/rollback` | Roll back a deployment to a specified prior healthy deployment |
| `GET` | `/api/builder/previews` | List preview sessions for the current tenant |
| `POST` | `/api/builder/projects/:id/previews` | Build and start an isolated preview for the current revision |
| `GET` | `/api/builder/previews/:id` | Read tenant-scoped preview state and expiry |
| `GET` | `/api/builder/previews/:id/logs` | Read bounded preview runtime logs |
| `DELETE` | `/api/builder/previews/:id` | Stop a preview and remove all runtime resources |
| `PATCH` | `/api/builder/projects/:id/status` | Set `draft`, `ready`, or `archived` |
| `GET` | `/api/builder/catalog` | Search tools by text and lifecycle with ownership, release, health, and usage data |
| `PATCH` | `/api/builder/catalog/:id/lifecycle` | Change a catalog tool's lifecycle state |
| `POST` | `/api/builder/catalog/:id/launch` | Create an expiring launch session for a healthy deployed tool |
| `GET` | `/api/builder/connections` | List tenant-managed connections without credential values |
| `POST` | `/api/builder/connections` | Store an encrypted HTTPS connection and fixed capabilities |
| `PATCH` | `/api/builder/connections/:id/status` | Enable or disable a managed connection |
| `POST` | `/api/builder/projects/:id/integration-grants` | Issue a short-lived signed grant for a declared integration capability |
| `POST` | `/api/builder/projects/:id/integrations/invoke` | Invoke one granted capability through the server-side broker |
| `GET` | `/api/builder/projects/:id/integration-calls` | Read the tenant-scoped integration invocation audit trail |

Specifications use schema version `1` and cover metadata, pages, components, data models, actions, managed integration references, roles, and the deployment target. Generated artifacts contain a React client, authenticated Express CRUD API, SQLite migration, container definition, fixed dependency manifest, and checksummed provenance. Invalid cross-references return `422` with an `issues` array. Stale revisions and duplicate tenant slugs return `409`.

Message refinement uses deterministic transforms for common safe changes and a schema-constrained AI editor for broader changes. AI output is accepted only as a complete JSON specification and is parsed through the same strict schema and cross-reference validation as user-supplied specifications. Visual edits expose a fixed property vocabulary and cannot inject source code. Undo and redo are persisted, tenant-scoped operations that append revisions rather than rewriting history.

Preview creation requires valid passing evidence for the exact current artifact. It returns `409` until the current revision passes. An `accessUrl` contains a high-entropy, single-session token. Opening it exchanges the token for an `HttpOnly`, `SameSite=Strict`, preview-path-scoped cookie and redirects to `/api/builder/previews/:id/proxy/`. The proxy injects a separate internal application credential; neither that credential nor platform credentials are exposed to the browser or generated application. Preview TTL begins when the generated image becomes ready, so build time does not consume the user-visible session lifetime.

Each preview has a private Docker network with outbound access disabled, a dedicated data volume, no published ports, a read-only root filesystem, a `noexec` temporary filesystem, all Linux capabilities dropped, `no-new-privileges`, and CPU, memory, and PID limits. Sessions expire automatically. Explicit stop, expiry, startup failure, and service startup cleanup remove the preview container, network, volume, and image. Defaults are controlled by `PREVIEW_MAX_PER_TENANT`, `PREVIEW_MAX_GLOBAL`, `PREVIEW_TTL_MINUTES`, and `PREVIEW_MAX_TTL_MINUTES`.

Catalog launches use the same one-time-token exchange pattern as previews. The access token becomes an expiring `HttpOnly`, `SameSite=Strict`, path-scoped cookie; the deployment container reference and internal application credential remain server-side. The runtime gateway verifies the deployment label and running state, permits only fixed HTTP methods and bounded paths and bodies, injects the application credential inside the container, caps responses at 2 MB, and applies both a 15-second internal request timeout and a 20-second Docker stream deadline. Deployed tools remain on private networks with no published ports. `BUILDER_LAUNCH_TTL_MINUTES` controls launch-session lifetime.

Managed connections accept HTTPS base URLs, encrypted headers, and capabilities in the exact form `METHOD /fixed/path`. A generated tool can request a short-lived HMAC grant only for a capability declared by its current specification. Invocation happens in the platform broker: credentials are decrypted and injected only on the server, redirects are disabled, request and response sizes are bounded, and every call is recorded without secret values. DNS resolution rejects private, loopback, link-local, CGNAT, multicast, and reserved IPv4/IPv6 destinations, then pins a validated public address into the TLS connection to prevent DNS rebinding. `PLUGIN_ENCRYPTION_KEY` and `BUILDER_INTEGRATION_SIGNING_KEY` should be dedicated production secrets.

Quality gates verify the artifact path allowlist and hashes, schema and provenance, fixed dependency policy, credential patterns, prohibited source primitives and outbound URLs, accessible document structure, and non-root container policy. The runtime stage installs from a clean workspace, runs `npm audit`, builds the client, exercises authentication and CRUD, launches Chromium at `1440x900` and `390x844`, runs axe accessibility checks, and records SHA-256 hashes for both visual snapshots. Results are stored immutably in the builder database with an artifact checksum, reproducibility key, actor, timestamp, and HMAC signature. `BUILDER_GATE_SIGNING_KEY` may provide a dedicated signing key; otherwise the required approval-token secret is used. `BUILDER_GATE_MAX_CONCURRENT` bounds concurrent gate runs, and `CHROMIUM_PATH` selects the browser executable.

Release requests bind the exact generated artifact to passing signed gate evidence and include a structured revision diff. Low- and medium-risk releases require one independent approval; high-risk releases require two distinct approvers. Requesters cannot approve their own releases, and duplicate reviews are rejected. Approved artifacts and signed release metadata are committed to the controlled repository configured by `BUILDER_RELEASE_REPO`; `BUILDER_RELEASE_SIGNING_KEY` provides the dedicated HMAC key when set.

Deployment builds the exported artifact, starts a candidate on a private per-project network with a dedicated volume and no published ports, and promotes it only after health verification. The runtime uses a read-only root filesystem, a `noexec` temporary filesystem, dropped Linux capabilities, `no-new-privileges`, and CPU, memory, and PID limits. A failed candidate is removed and the previous healthy runtime is restored automatically. Manual rollback selects a prior healthy deployment, health-checks it before promotion, and records the actor, target, outcome, and release transition in the immutable audit history.

### Error Responses

All API endpoints return consistent error objects:

```json
{ "error": "Human-readable error message" }
```

| HTTP Status | Meaning |
|-------------|---------|
| `400` | Bad request — missing or invalid parameters |
| `401` | Unauthorized — no or invalid token |
| `403` | Forbidden — valid token but insufficient permissions |
| `404` | Not found |
| `500` | Internal server error |
| `503` | Service unavailable — integration (e.g., JIRA) not configured |

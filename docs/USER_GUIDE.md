# RightAPI Forge IT Operations Platform — User Guide

> **Version:** 1.0 · **Default URL:** `http://<host>:19123`

---

## Table of Contents

1. [What is RightAPI Forge?](#1-what-is-rightapi-forge)
2. [Getting Started](#2-getting-started)
3. [Page Reference](#3-page-reference)
   - [Dashboard](#31-dashboard)
   - [Incidents](#32-incidents)
   - [Agents](#33-agents)
   - [Agent Chat](#34-agent-chat)
   - [Mission Control](#35-mission-control)
   - [Operations](#36-operations)
   - [Task Queue](#37-task-queue)
   - [Runbooks](#38-runbooks)
   - [Alert Rules](#39-alert-rules)
   - [Workflows](#310-workflows)
   - [Servers](#311-servers)
   - [Performance](#312-performance)
   - [Security](#313-security)
   - [Users](#314-users)
   - [Settings](#315-settings)
   - [SSH Terminal](#316-ssh-terminal)
   - [JIRA](#317-jira)
   - [A2A Mesh](#318-a2a-mesh)
   - [MCP Server](#319-mcp-server)
   - [Kubernetes Monitoring](#320-kubernetes-monitoring)
4. [Settings: SMTP, JIRA, Theme](#4-settings-smtp-jira-theme)
5. [PWA — Install as Desktop / Mobile App](#5-pwa--install-as-desktop--mobile-app)
6. [FAQ](#6-faq)

---

## 1. What is RightAPI Forge?

**RightAPI Forge** is a self-hosted, AI-powered IT Operations platform. It brings together:

- **Incident management** — create, track, escalate, and resolve incidents with full SLA tracking and JIRA bi-directional sync.
- **AI Agents** — autonomous agents (backed by Claude, OpenAI, or Ollama) that can answer questions, execute runbooks, SSH into servers, query Kubernetes, and more.
- **Automation** — alert rules that auto-remediate via runbooks; workflows with configurable triggers; a scheduler for recurring tasks.
- **Observability** — live WebSocket feeds for task progress, agent activity, server health metrics, and performance charts.
- **Integrations** — JIRA, Microsoft Teams, Azure AD / LDAP, MCP (Model Context Protocol), A2A agent mesh, and SSH.

Everything runs in a single Docker container on port **19123**. No external services are required beyond the optional AI provider API key.

---

## 2. Getting Started

### First Login

1. Open your browser and navigate to `http://<host>:19123`.
2. You will be redirected to the login page.
3. Enter the default credentials:
   - **Username:** `admin`
   - **Password:** the unique `ADMIN_PASSWORD` configured during installation
4. Click **Sign In**.

> **Tip:** If Azure AD or LDAP is configured by your administrator, a "Sign in with Azure" button appears on the login page.

### First Steps After Login

| Step | What to do |
|------|-----------|
| **1. Change password** | Navigate to **Settings → General** and update the admin password. |
| **2. Create your first incident** | Go to **Incidents → + New Incident** to start tracking work. |
| **3. Configure alert rules** | Visit **Alert Rules** and set up automated alerting thresholds. |
| **4. Set up SMTP** | In **Settings → SMTP** to enable email notifications. |
| **5. Connect JIRA** | In **Settings → Integrations** to enable two-way JIRA sync. |
| **6. Chat with an agent** | Open **Agent Chat**, pick an agent, and type a question. |

---

## 3. Page Reference

### 3.1 Dashboard

**Path:** `/` (root)

The Dashboard provides a real-time operational overview.

**Stat Cards (top row):**
| Card | What it shows |
|------|--------------|
| Open Incidents | Count of incidents with status `open` or `investigating` |
| Active Tasks | Tasks currently `in_progress` |
| Active Agents | Agents with `active` status |
| SLA Breaches | Incidents that exceeded their SLA window |

**Charts:**
- **Incident Trend (line chart)** — 7-day rolling count of incidents created per day, built with Recharts.
- **Severity Distribution (pie chart)** — breakdown of open incidents by severity: critical / high / medium / low.
- **Task Status (bar chart)** — pending vs. in-progress vs. completed task counts.

**Activity Feed:**
Real-time log of events delivered over WebSocket (`task_update`, `incident_created`, `agent_status`). New events appear at the top. The feed automatically scrolls to show the latest activity.

**Tips:**
- Hover over chart data points to see tooltips with exact values.
- The stat cards update in real time — no page refresh required.
- Click any stat card to navigate to the relevant list page.

---

### 3.2 Incidents

**Path:** `/incidents`

The Incidents page is the primary operational log for all IT events.

**Key Actions:**

| Action | How |
|--------|-----|
| **Create incident** | Click **+ New Incident**. Fill in title, severity (critical/high/medium/low), and optionally assign to an agent. |
| **Filter** | Use the **Severity** and **Status** dropdowns. Combine with the search box for full-text search. |
| **Escalate** | Open an incident → click **Escalate**. Optionally provide a reason and new assignee. |
| **Resolve** | Open an incident → click **Resolve**. Enter a resolution note. |
| **Close** | Available once an incident is resolved. |
| **Add note** | Inside an incident detail view, use the **Add Note** textarea to add a timestamped comment. |
| **Export CSV** | Click **Export CSV** to download all incidents as a spreadsheet. |
| **Create from JIRA** | Click **Import from JIRA**, enter a JIRA ticket key (e.g., `OPS-42`), and confirm. |
| **Link to JIRA** | Inside an incident, click **Link JIRA Issue** and enter the ticket key. |
| **Push to JIRA** | Inside an incident, click **Create JIRA Issue** to create a new JIRA ticket from this incident. |

**SLA Tracking:**
Each severity level has a configurable SLA window (set via environment variables, defaults: critical=60 min, high=240 min, medium=1440 min, low=4320 min). Incidents that exceed the SLA are flagged in red.

**Filters available:**
- Status: `open`, `investigating`, `escalated`, `resolved`, `closed`
- Severity: `critical`, `high`, `medium`, `low`
- Assigned to: any agent username

**Tips:**
- Use the search box to find incidents by title keywords.
- Resolved incidents are kept in history for audit purposes.
- Notes are mirrored to the linked JIRA ticket as comments automatically.

---

### 3.3 Agents

**Path:** `/agents`

Displays all AI agents in the organization hierarchy.

**What you see:**
- **Agent card** — name, role (director / sysadmin / specialist), AI platform (Claude / OpenAI / Ollama), current status (active / idle / error), assigned skills, and task counts.
- **Agent hierarchy** — directors oversee sysadmins and specialists.

**Key Actions:**

| Action | How |
|--------|-----|
| **Create agent** | Click **+ Add Agent**. Choose role, platform, and name. |
| **Edit agent** | Click the pencil icon. Update name, platform, or specialty. |
| **Delete agent** | Click the trash icon (requires admin role). |
| **Assign skill** | Click **+ Skill** on an agent card and choose from available skills. |
| **Remove skill** | Click the × badge on a skill tag. |
| **View history** | Click **History** to see the agent's conversation log. |

**Tips:**
- Directors can delegate tasks to sysadmins and specialists.
- The `specialty` field for specialist agents determines which skills they're best suited for (e.g., `kubernetes`, `jira`, `monitoring`).

---

### 3.4 Agent Chat

**Path:** `/agent-chat`

Per-agent real-time chat with full conversation history.

**How it works:**
1. Select an agent from the dropdown.
2. Type a message and press **Enter** or click **Send**.
3. The agent responds using its configured AI provider. Streaming responses are displayed token-by-token over WebSocket (`message_complete` event).
4. History is persisted to SQLite and survives server restarts.

**Key Actions:**

| Action | How |
|--------|-----|
| **Send message** | Type in the input box and press Enter or click Send. |
| **Clear history** | Click **Clear History**. This permanently deletes the conversation. |
| **Switch agent** | Use the agent selector dropdown at the top. |

**Tips:**
- Ask agents to execute skills: e.g., *"Run the disk-cleanup runbook on server 192.168.1.10"*.
- Agents remember context within a session; clearing history resets that context.
- The `message_complete` WebSocket event notifies the UI when the agent finishes responding.

---

### 3.5 Mission Control

**Path:** `/mission-control`

Live operational overview of all agent activity and task flow.

**What you see:**
- **Live task feed** — real-time stream of task state changes delivered via WebSocket `task_update` events.
- **Agent workload panel** — per-agent task counts (pending / active / completed) shown as progress bars.
- **Task detail** — click any task to expand and see subtasks, delegation chain, and timeline.

**Key Actions:**

| Action | How |
|--------|-----|
| **Reassign task** | Click a task → **Reassign** → choose a different agent. |
| **Cancel task** | Click a task → **Cancel**. Confirms before cancelling. |
| **View subtasks** | Expand a task to see its subtask tree. |

**Tips:**
- Mission Control is your real-time "war room" view during incidents.
- Agents that are stuck (no progress for over the configured threshold) are highlighted in orange.
- WebSocket reconnects automatically if the connection drops.

---

### 3.6 Operations

**Path:** `/operations`

Similar to Mission Control but focused on running tasks and agent activity logs.

**What you see:**
- **Running tasks table** — all tasks currently `in_progress` with their assigned agent, start time, and duration.
- **Agent activity log** — per-agent chronological log of actions taken.

**Key Actions:**

| Action | How |
|--------|-----|
| **Reassign task** | PATCH the task assignment from the task row actions menu. |
| **Filter by agent** | Use the agent filter dropdown. |

---

### 3.7 Task Queue

**Path:** `/task-queue`

Complete view of all tasks across all status states.

**Columns:** Task ID, title, assigned agent, priority, status, created at, updated at.

**Filters:** Pending / Active / Completed / All.

**Stats bar:** Shows counts for pending, in-progress, and completed tasks.

**Key Actions:**

| Action | How |
|--------|-----|
| **Change status** | Click the status badge on a task row to cycle statuses. |
| **Create task** | Click **+ New Task** and fill in the title and agent assignment. |
| **View subtasks** | Click the expand icon on any task with subtasks. |

---

### 3.8 Runbooks

**Path:** `/runbooks`

Runbook template library and execution history.

**Templates:**
- Pre-defined step-by-step automation playbooks (e.g., "Restart nginx", "Disk cleanup").
- Each template has a name, description, list of steps (with optional approval gates), and a linked skill.

**Key Actions:**

| Action | How |
|--------|-----|
| **Create template** | Click **+ New Template**. Fill in name, description, and steps. |
| **Edit template** | Click the pencil icon on any template card. |
| **Delete template** | Click the trash icon. |
| **Execute runbook** | Click **Run** on any template. Optionally override parameters. |
| **Approve a step** | In the execution detail view, click **Approve** on a pending step. |
| **Cancel execution** | In the execution detail view, click **Cancel Run**. |
| **Export history CSV** | Click **Export History** to download execution history as CSV. |

**Tips:**
- Runbooks can be triggered automatically by Alert Rules (see [Section 3.9](#39-alert-rules)).
- Steps that require human approval show a yellow **Awaiting Approval** badge.

---

### 3.9 Alert Rules

**Path:** `/alert-rules`

Automated alert and remediation rules.

**What an alert rule contains:**
| Field | Description |
|-------|------------|
| Name | Human-readable label |
| Condition | Metric / event type and threshold (e.g., `cpu > 90%`) |
| Severity | critical / high / medium / low |
| Auto-remediation | Optional runbook template to execute when triggered |
| Enabled | Toggle on/off without deleting |

**Key Actions:**

| Action | How |
|--------|-----|
| **Create rule** | Click **+ New Rule**. Fill in condition, severity, and optionally link a runbook. |
| **Edit rule** | Click the pencil icon. |
| **Delete rule** | Click the trash icon. |
| **Evaluate now** | Click **Evaluate** to manually trigger rule evaluation immediately. |
| **Toggle** | Use the enable/disable switch on each rule card. |

**Tips:**
- Rules are evaluated on a schedule (configurable via `ALERT_RULES_PATH`).
- Link a runbook to get zero-touch auto-remediation.

---

### 3.10 Workflows

**Path:** `/workflows`

Multi-step workflow definitions with configurable triggers.

**What workflows provide:**
- Sequential or parallel stage execution.
- Trigger types: manual, schedule (cron), webhook, alert rule.
- Stage-level agent assignment.
- Drift detection — workflows running longer than `WORKFLOW_DRIFT_THRESHOLD_MINUTES` are flagged.

**Key Actions:**

| Action | How |
|--------|-----|
| **Create workflow** | Click **+ New Workflow** and define stages. |
| **Trigger manually** | Click **Run** on any workflow definition. |
| **View runs** | Click **History** to see all past and current executions. |
| **Reconcile** | On a running execution, click **Reconcile** to re-evaluate stage states. |
| **Set schedule** | Click **Edit Schedule** on a template to configure a cron trigger. |

---

### 3.11 Servers

**Path:** `/servers`

Server inventory with live health metrics.

**What you see:**
- List of monitored servers (defined via `MONITORED_SERVERS` environment variable).
- Per-server health: CPU %, memory %, disk %, load average, uptime.
- Status badge: healthy / warning / critical / unreachable.

**Key Actions:**

| Action | How |
|--------|-----|
| **Refresh metrics** | Click **Refresh** to force an SSH-based metric collection. Metrics are otherwise cached for 60 seconds. |
| **View details** | Click a server row to see all metrics. |

**Tips:**
- RightAPI Forge collects metrics via SSH (`root@<ip>`). Ensure passwordless SSH is set up from the RightAPI Forge host.
- Add servers by setting `MONITORED_SERVERS=192.168.1.10,192.168.1.20` in `.env`.
- Set friendly names with `SERVER_NAME_192_168_1_10=web-server-01`.

---

### 3.12 Performance

**Path:** `/performance`

Performance and latency charts for the RightAPI Forge platform itself and monitored services.

**Charts include:**
- API response time histogram
- Request rate over time
- Task throughput (tasks/min)
- Agent response latency

**Tips:**
- Performance metrics are in-memory only; they reset on restart.
- Use these charts to identify if AI provider latency is impacting operations.

---

### 3.13 Security

**Path:** `/security`

Two-tab security management page.

**Tab 1 — Audit Log:**
- Chronological log of all API executions with actor, action, tool used, outcome, and timestamp.
- Filterable by actor or status.
- Exportable as CSV via the **Export** button.

**Tab 2 — API Keys:**
- Manage API keys for external integrations (separate from JWT tokens).
- Create, rotate, and revoke keys.
- Each key has associated permissions and an expiry date.

**Other security features visible here:**
- Rate limit status (requests/minute current vs. limit)
- Approval token ledger (for privileged operations that require human approval)

**Tips:**
- All privileged tool executions (SSH, credential access) require an approval token by default.
- Admin-only: users with `viewer` role cannot access this page.

---

### 3.14 Users

**Path:** `/users`

User account management.

**Roles:**
| Role | Permissions |
|------|------------|
| `admin` | Full access — all read and write operations, user management, configuration |
| `operator` | Create/update incidents, tasks, runbooks, runbook execution; no user management |
| `viewer` | Read-only access to all data; cannot create or modify anything |

**Key Actions:**

| Action | How |
|--------|-----|
| **Create user** | Click **+ New User**. Enter username, password, and role. |
| **Edit role** | Click the pencil icon on a user row and change the role. |
| **Change password** | Click **Edit** and set a new password. |
| **Delete user** | Click the trash icon (cannot delete the last admin). |

**Tips:**
- Azure AD / LDAP users are auto-provisioned on first login; their roles can be managed here.
- The `admin` account created at startup cannot be deleted via the UI.

---

### 3.15 Settings

**Path:** `/settings`

Three-tab configuration page.

#### General Tab
- **Platform name** — customise the name displayed in the header.
- **Public URL** — used for JIRA links and Teams notifications. Set to the externally reachable URL.
- **Theme** — toggle between light and dark mode (also available in the sidebar).
- **Admin password** — update the admin account password.

#### SMTP Email Tab
Configure outbound email notifications for incident alerts, SLA breaches, and approvals.

| Field | Description |
|-------|------------|
| Host | SMTP server hostname (e.g., `smtp.gmail.com`) |
| Port | Usually 587 (STARTTLS) or 465 (SSL) |
| Username | SMTP authentication username |
| Password | SMTP authentication password |
| From address | Sender email address |
| To address(es) | Default recipient(s) for alerts |

After filling in credentials, click **Test** to verify the connection before saving.

#### Integrations Tab
Configure third-party integrations.

**JIRA:**
| Field | Description |
|-------|------------|
| Base URL | Your JIRA instance URL (e.g., `https://yourcompany.atlassian.net`) |
| Email | Atlassian account email |
| API Token | JIRA API token (created in Atlassian account settings) |
| Default Project | Project key for new issues (e.g., `OPS`) |
| Issue Type | Issue type for incidents (default: `Incident`) |
| Poll Interval | Minutes between automatic sync polls (default: 15) |
| Auto Import | Automatically create incidents from new JIRA issues |

**Microsoft Teams:**
| Field | Description |
|-------|------------|
| Incident Webhook URL | Incoming webhook URL for incident notifications |
| Escalation Webhook URL | Webhook for escalation notifications |

**Azure AD / LDAP:** Configure SSO (see the AD tab in Settings).

---

### 3.16 SSH Terminal

**Path:** `/ssh`

Browser-based SSH terminal for running commands on monitored servers.

**How to use:**
1. Select a server from the **Host** dropdown (populated from `MONITORED_SERVERS`), or type a hostname/IP manually.
2. Click **Connect**.
3. The terminal output area shows real-time command results.
4. Use the **Quick Commands** panel to run pre-defined commands (disk usage, service status, etc.) with one click.

**Tips:**
- The terminal runs commands via `execFileSync` on the RightAPI Forge server (SSH client on host required).
- For persistent interactive sessions, consider using a dedicated SSH client.
- All SSH commands are logged to the execution audit log.

---

### 3.17 JIRA

**Path:** `/jira`

Browse and manage JIRA projects and issues directly from RightAPI Forge.

**What you see:**
- Project list (populated from your JIRA instance).
- Issue browser with JQL filter support.
- Issue detail view with status, assignee, priority, and comments.

**Key Actions:**

| Action | How |
|--------|-----|
| **Browse projects** | Select a project from the dropdown. |
| **Search issues** | Type in the search box (searches title and description). |
| **Custom JQL** | Use the **JQL** input for advanced queries. |
| **Create incident from issue** | Click **Import as Incident** on any issue row. |
| **Trigger sync** | Click **Sync Now** to immediately pull updates from JIRA. |

**Tips:**
- Sync status (last poll time, next poll time, ticket count) is shown at the top of the page.
- Set `JIRA_AUTO_IMPORT=true` in `.env` to automatically create RightAPI Forge incidents from new JIRA issues.
- The `JIRA_SYNC_JQL` env var filters which JIRA issues are auto-imported.

---

### 3.18 A2A Mesh

**Path:** `/a2a`

Agent-to-Agent (A2A) mesh network — connects RightAPI Forge's agents with external AI agent systems.

**What you see:**
- **Internal agents** — RightAPI Forge agents discoverable via the A2A protocol (well-known JSON at `/.well-known/agent.json`).
- **External peers** — registered external A2A-compatible agents.
- **Trust relationships** — which agents are allowed to delegate tasks to which peers.
- **A2A tasks** — tasks dispatched across the mesh with their status and event streams.

**Key Actions:**

| Action | How |
|--------|-----|
| **Register external peer** | Click **+ Add External Agent**. Provide the peer's base URL. |
| **Refresh peer** | Click the refresh icon on a peer to re-fetch its agent card. |
| **Update auth** | Click **Edit Auth** to update the peer's API key or token. |
| **Remove peer** | Click the trash icon. |
| **Send task to peer** | Select a peer and click **Dispatch Task**. |
| **View task events** | Click a task row to see its SSE event stream. |

**Tips:**
- The A2A protocol follows the Google A2A specification for interoperability.
- The `/.well-known/agent.json` endpoint is public (no auth) and describes RightAPI Forge's capabilities.

---

### 3.19 MCP Server

**Path:** `/mcp`

Model Context Protocol (MCP) server information and tool catalogue.

**What you see:**
- MCP server status and endpoint URL (`/mcp`).
- Full catalogue of registered MCP tools with names, descriptions, and input schemas.
- Connection instructions for MCP clients (e.g., Claude Desktop, Cursor).

**Available MCP tools include:**
- `list_incidents`, `create_incident`, `update_incident`
- `list_tasks`, `create_task`
- `list_agents`, `send_agent_message`
- `list_servers`, `get_server_metrics`
- `run_runbook`, `list_runbooks`
- `search_jira`, `get_jira_ticket`
- `kubectl_get`, `kubectl_describe`
- ...and more

**Tips:**
- Point any MCP-compatible AI assistant at `http://<host>:19123/mcp` to give it access to your IT operations data.
- The MCP endpoint uses JSON-RPC 2.0 over HTTP.

---

### 3.20 Kubernetes Monitoring

**Path:** `/monitoring` (Monitoring page in the sidebar)

Monitor Kubernetes cluster resources from RightAPI Forge.

**What you see:**
- **Pods** — name, namespace, status, restarts, age.
- **Deployments** — name, namespace, desired/ready/available replicas.
- **Nodes** — name, status, roles, CPU/memory capacity.
- **Events** — recent cluster events with reason, message, and object reference.

**Key Actions:**

| Action | How |
|--------|-----|
| **Refresh** | Click **Refresh** to re-query the cluster. |
| **Filter by namespace** | Use the namespace dropdown. |
| **View pod logs** | Click a pod row → **View Logs** (requires kubectl access from RightAPI Forge host). |

**Tips:**
- RightAPI Forge uses the `kubectl` binary on the host. Ensure the kubeconfig is set up for the RightAPI Forge service account.
- Kubernetes data is fetched via the MCP `kubectl_*` tools.

---

## 4. Settings: SMTP, JIRA, Theme

### SMTP Setup (Step-by-Step)

1. Go to **Settings → SMTP**.
2. Enter your SMTP server details (host, port, username, password).
3. Set the **From** address and at least one **To** address.
4. Click **Test** — a test email will be sent to the To address.
5. If the test succeeds, click **Save**.
6. RightAPI Forge will now send emails for:
   - New critical/high incidents
   - SLA breach notifications
   - Approval requests for privileged operations

**Gmail example:**
```
Host: smtp.gmail.com
Port: 587
Username: yourname@gmail.com
Password: <App Password from Google Account>
```

> **Note:** Use an App Password, not your regular Google password. Enable 2FA on the account first.

### JIRA Integration (Step-by-Step)

1. In your Atlassian account, go to **Account Settings → Security → API tokens** and create a new token.
2. Go to **RightAPI Forge → Settings → Integrations → JIRA**.
3. Fill in:
   - **Base URL**: `https://yourcompany.atlassian.net`
   - **Email**: your Atlassian email
   - **API Token**: the token you just created
   - **Default Project**: key of the project (e.g., `OPS`)
4. Click **Save**.
5. Go to the **JIRA** page and click **Sync Now** to verify the connection.

### Theme Toggle

- Click the 🌙/☀️ icon in the sidebar footer to toggle between dark and light mode.
- Your preference is saved to `localStorage` and persists across sessions.

---

## 5. PWA — Install as Desktop / Mobile App

RightAPI Forge ships as a Progressive Web App (PWA). You can install it to your desktop or mobile home screen for a native-like experience.

### Desktop (Chrome / Edge)

1. Open RightAPI Forge in your browser.
2. Look for the **Install** prompt that appears in the sidebar footer.
3. Click **Install RightAPI Forge** and confirm.
4. RightAPI Forge opens in its own window without browser chrome.

### Mobile (Android / iOS)

**Android (Chrome):**
1. Open RightAPI Forge in Chrome.
2. Tap the three-dot menu → **Add to Home screen**.
3. Confirm the name and tap **Add**.

**iOS (Safari):**
1. Open RightAPI Forge in Safari.
2. Tap the **Share** button (square with arrow).
3. Scroll down and tap **Add to Home Screen**.
4. Confirm and tap **Add**.

### Dismissing the Install Prompt

If you dismiss the install prompt in the sidebar, it won't appear again. To reset: open the browser console and run:
```javascript
localStorage.removeItem('beacon_install_dismissed')
```

---

## 6. FAQ

**Q: I forgot my password. How do I reset it?**  
A: If you have admin access to the Docker host, set a new password by restarting with the `ADMIN_PASSWORD` environment variable updated in your `.env` file. Users with admin role can also change passwords via **Users → Edit**.

**Q: The WebSocket keeps disconnecting.**  
A: The client reconnects automatically with exponential backoff. If it keeps dropping, check that your reverse proxy (nginx/Caddy) has WebSocket upgrade headers configured and the connection timeout is set to at least 300 seconds.

**Q: Agents aren't responding — what's wrong?**  
A: Check that the appropriate AI provider API key is set (`ANTHROPIC_API_KEY` or `OPENAI_API_KEY`). Visit **Settings → General** to verify the AI platform configuration. Agents using Ollama require `OLLAMA_BASE_URL` to be reachable.

**Q: How do I add more servers to monitor?**  
A: Add comma-separated IPs to the `MONITORED_SERVERS` environment variable in `.env` or `docker-compose.yml`, then restart the container. Example: `MONITORED_SERVERS=10.0.0.1,10.0.0.2,10.0.0.3`.

**Q: JIRA sync isn't importing issues.**  
A: Verify your JIRA credentials in Settings → Integrations. Check `JIRA_SYNC_JQL` isn't filtering out your issues. Try clicking **Sync Now** on the JIRA page and look for error messages.

**Q: Can I run RightAPI Forge without Docker?**
A: Yes. Build with `npm run build` and start with `npm start`. Ensure Node.js 20+ is installed and all environment variables are set in a `.env` file.

**Q: Where is data stored?**  
A: All data is in SQLite databases. By default:  
- Tasks: `/data/itops-agents/tasks.db`  
- Incidents: `/data/itops-agents/incidents.db`  
- Agent memory: `/data/itops-agents/agent-memory.db`  
These are mounted as a Docker volume (`itops-data`).

**Q: How do I back up my data?**  
A: Use the built-in backup system at **API → `POST /api/system/backups/create`**, or access it from the Docker host: `docker exec itops-agents cat /data/itops-agents/incidents.db > backup.db`.

**Q: How do I give a team member read-only access?**  
A: Create a user with the `viewer` role in **Users → + New User**.

**Q: Can multiple users be logged in simultaneously?**  
A: Yes. JWT tokens are stateless. Each user gets their own token and all sessions are independent.

**Q: The performance page shows no data.**  
A: Performance metrics are in-memory. They reset on restart and accumulate as the platform handles requests. Wait a few minutes after startup.

**Q: How do I configure Kubernetes monitoring?**  
A: Ensure `kubectl` is installed on the RightAPI Forge host and a valid kubeconfig is accessible. The MCP `kubectl_*` tools use the default kubeconfig (`~/.kube/config` or the `KUBECONFIG` env var).

# RightAPI Forge IT Operations Platform — Developer Guide

> **Repository:** Set `https://github.com/shaike1/rightapi-forge` when the sanitized repository is published.
> **Runtime:** Node.js 20 + React 18  
> **Port:** 19123

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Tech Stack](#2-tech-stack)
3. [Project Structure](#3-project-structure)
4. [Build & Development Workflow](#4-build--development-workflow)
5. [Environment Variables](#5-environment-variables)
6. [How to Add a New Agent Skill](#6-how-to-add-a-new-agent-skill)
7. [How to Add a New Page](#7-how-to-add-a-new-page)
8. [How to Add a New API Endpoint](#8-how-to-add-a-new-api-endpoint)
9. [Contributing Guide](#9-contributing-guide)
10. [Troubleshooting](#10-troubleshooting)

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Docker Container                            │
│                      (node:20-alpine, port 19123)                   │
│                                                                     │
│  ┌─────────────────────┐    ┌──────────────────────────────────┐   │
│  │   React SPA          │    │          Express Server           │   │
│  │  (Vite + React 18)   │    │        (src/web/server.ts)        │   │
│  │                      │    │                                  │   │
│  │  /client/src/        │    │  ┌──────────┐  ┌─────────────┐  │   │
│  │  ├── pages/          │◄──►│  │  REST API │  │  WebSocket  │  │   │
│  │  ├── components/     │    │  │  /api/*   │  │  wss://...  │  │   │
│  │  ├── hooks/          │    │  └────┬─────┘  └──────┬──────┘  │   │
│  │  └── App.tsx         │    │       │                │         │   │
│  └─────────────────────┘    │  ┌────▼────────────────▼──────┐  │   │
│                              │  │       Business Layer        │  │   │
│                              │  │                            │  │   │
│                              │  │  IncidentManager           │  │   │
│                              │  │  TaskManager               │  │   │
│                              │  │  OrganizationManager       │  │   │
│                              │  │  AlertRulesEngine          │  │   │
│                              │  │  WorkflowEngine            │  │   │
│                              │  │  RunbookEngine             │  │   │
│                              │  │  SkillManager              │  │   │
│                              │  │  OrchestratorService       │  │   │
│                              │  └────────────┬───────────────┘  │   │
│                              │               │                  │   │
│                              │  ┌────────────▼───────────────┐  │   │
│                              │  │       AI Layer              │  │   │
│                              │  │  AIProviderFactory         │  │   │
│                              │  │  ├── Anthropic Claude       │  │   │
│                              │  │  ├── OpenAI GPT             │  │   │
│                              │  │  └── Ollama (local)         │  │   │
│                              │  └────────────┬───────────────┘  │   │
│                              │               │                  │   │
│                              │  ┌────────────▼───────────────┐  │   │
│                              │  │     Persistence Layer       │  │   │
│                              │  │  SQLite (better-sqlite3)    │  │   │
│                              │  │  ├── tasks.db               │  │   │
│                              │  │  ├── incidents.db           │  │   │
│                              │  │  └── agent-memory.db        │  │   │
│                              │  └────────────────────────────┘  │   │
│                              └──────────────────────────────────┘   │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                     Integrations                              │   │
│  │  JIRA API  │  MS Teams Webhook  │  Azure AD / LDAP  │  MCP   │   │
│  │  A2A Mesh  │  SSH (openssh-client)  │  kubectl       │       │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

**Data Flow:**
1. React SPA makes REST API calls to `/api/*` endpoints on the Express server.
2. The Express server delegates to the appropriate business service.
3. Services persist data to SQLite databases.
4. Real-time updates are broadcast to all connected WebSocket clients.
5. The AI layer wraps Claude/OpenAI/Ollama with a unified `AIProviderFactory` interface.
6. Agent skills provide structured tool execution (SSH, kubectl, JIRA, etc.) to AI agents.

---

## 2. Tech Stack

### Backend

| Technology | Version | Purpose |
|-----------|---------|---------|
| Node.js | 20 (LTS) | Runtime |
| TypeScript | ^5.9 | Type safety |
| Express | ^4.21 | HTTP server & routing |
| `ws` | ^8.19 | WebSocket server |
| `better-sqlite3` | ^12.6 | SQLite persistence |
| `@anthropic-ai/sdk` | ^0.32 | Claude AI provider |
| `openai` | ^4.89 | OpenAI provider |
| `ollama` | ^0.5 | Local Ollama provider |
| `@modelcontextprotocol/sdk` | ^1.27 | MCP server |
| `express-rate-limit` | ^8.3 | Rate limiting |
| `nodemailer` | ^8.0 | SMTP email |
| `ldapjs` | ^3.0 | LDAP/AD authentication |
| `openid-client` | ^6.8 | Azure AD OAuth2 |
| `node-cron` | ^4.2 | Task scheduling |
| `uuid` | ^11.1 | ID generation |
| `zod` | ^3.25 | Schema validation |
| esbuild | (via build.mjs) | Fast TypeScript transpilation |

### Frontend

| Technology | Version | Purpose |
|-----------|---------|---------|
| React | ^18.3 | UI framework |
| Vite | ^5.4 | Dev server & bundler |
| TypeScript | ^5.5 | Type safety |
| React Router DOM | ^6.26 | SPA routing |
| Recharts | ^3.8 | Charts (line, pie, bar) |
| CSS Modules | — | Component-scoped styles |

### Infrastructure

| Technology | Purpose |
|-----------|---------|
| Docker / Docker Compose | Container packaging |
| SQLite | Embedded database (no separate DB service) |
| `openssh-client` (Alpine) | Server SSH connectivity |
| `kubectl` (optional) | Kubernetes monitoring |

---

## 3. Project Structure

```
itops-agents/
├── client/                     # React SPA (Vite)
│   ├── src/
│   │   ├── App.tsx             # Root component, SPA routes
│   │   ├── main.tsx            # React entry point
│   │   ├── index.css           # Global styles
│   │   ├── pages/              # One component per page route
│   │   │   ├── DashboardPage.tsx
│   │   │   ├── IncidentsPage.tsx
│   │   │   ├── AgentsPage.tsx
│   │   │   ├── AgentChatPage.tsx
│   │   │   └── ... (20 pages total)
│   │   ├── components/         # Shared UI components
│   │   │   ├── Sidebar.tsx     # Navigation sidebar
│   │   │   ├── Layout.tsx      # Page layout wrapper
│   │   │   ├── Card.tsx
│   │   │   ├── Modal.tsx
│   │   │   ├── StatCard.tsx
│   │   │   └── Toast.tsx
│   │   ├── hooks/              # Custom React hooks
│   │   │   ├── useAuth.tsx     # JWT auth context
│   │   │   ├── useWebSocket.ts # WS connection & events
│   │   │   ├── useTheme.ts     # Dark/light mode
│   │   │   ├── useToast.ts     # Toast notifications
│   │   │   └── useNotifications.ts
│   │   └── lib/                # Utility functions
│   ├── index.html
│   ├── vite.config.ts
│   └── package.json
│
├── src/                        # Backend TypeScript source
│   ├── web/                    # HTTP server and route handlers
│   │   ├── server.ts           # ⭐ Main Express + WS server (9953 lines)
│   │   ├── chatApi.ts          # /api/chat router
│   │   ├── missionControlApi.ts # /api/mission-control router
│   │   ├── runbooksApi.ts      # /api/runbooks router
│   │   ├── workflowsApi.ts     # /api/workflows router
│   │   ├── automationApi.ts    # /api/automation router
│   │   ├── taskAssignmentApi.ts
│   │   ├── chatHistoryStore.ts # Chat history persistence
│   │   ├── api-keys.ts         # /api/api-keys router
│   │   ├── credentials.ts      # /api/credentials router
│   │   └── ...
│   ├── agents/                 # Agent classes
│   │   ├── Organization.ts     # OrganizationManager (agent hierarchy)
│   │   ├── AgentMessageBus.ts  # Inter-agent messaging
│   │   └── ...
│   ├── ai/                     # AI provider abstraction
│   │   ├── factory.ts          # AIProviderFactory
│   │   └── ...
│   ├── skills/                 # Agent skill implementations
│   │   ├── SkillManager.ts     # Skill registry and execution
│   │   ├── BashSkill.ts
│   │   ├── SSHSkill.ts
│   │   ├── JiraSkill.ts
│   │   ├── MonitoringSkill.ts
│   │   ├── InfrastructureSkill.ts
│   │   └── ... (20+ skills)
│   ├── tasks/                  # Task management
│   │   ├── TaskManager.ts
│   │   ├── DelegationManager.ts
│   │   └── ...
│   ├── incidents/              # Incident management
│   │   └── IncidentManager.ts
│   ├── workflows/              # Workflow engine
│   │   └── WorkflowEngine.ts
│   ├── runbooks/               # Runbook engine
│   │   └── RunbookEngine.ts
│   ├── automation/             # Scheduler and alert rules
│   │   ├── TaskScheduler.ts
│   │   └── AlertRulesEngine.ts
│   ├── security/               # Auth, credentials, auditing
│   │   ├── AuthService.ts      # JWT auth + user management
│   │   ├── CredentialVault.ts  # Encrypted credential store
│   │   ├── ExecutionAuditStore.ts
│   │   ├── ApprovalTokenService.ts
│   │   └── ...
│   ├── integrations/           # External service connectors
│   │   ├── JiraIntegrationService.ts
│   │   ├── TeamsProvider.ts
│   │   └── ...
│   ├── a2a/                    # Agent-to-Agent protocol
│   │   ├── AgentCardService.ts
│   │   ├── A2ATaskRunner.ts
│   │   └── ...
│   ├── mcp/                    # Model Context Protocol server
│   │   └── ITOpsMcpServer.ts
│   ├── persistence/            # SQLite data stores
│   │   └── SqliteStore.ts
│   ├── metrics/                # SLA and performance metrics
│   ├── orchestrator/           # Task orchestration and recovery
│   ├── notifications/          # SMTP email
│   ├── auth/                   # Azure AD / LDAP
│   ├── ops/                    # Backup management
│   ├── factory/                # Factory board / kanban
│   └── types/                  # Shared TypeScript types
│       └── index.ts
│
├── public/                     # Static assets served by Express
├── dist/                       # Compiled output (git-ignored)
├── data/                       # Runtime data (git-ignored)
├── config/                     # Configuration files
├── docker/                     # Docker helper files
├── scripts/                    # Dev/ops scripts
├── build.mjs                   # esbuild transpile script
├── Dockerfile
├── docker-compose.yml
├── package.json
└── tsconfig.json
```

---

## 4. Build & Development Workflow

### Prerequisites

- **Node.js** 20 LTS or later
- **npm** 10+
- **Docker** + **Docker Compose** (for containerized development)

---

### Option A — Docker (Recommended for Production)

```bash
# Clone the repository
git clone https://github.com/shaike1/rightapi-forge rightapi-forge
cd itops-agents

# Copy and configure environment
cp docker-compose.override.yml.bak docker-compose.override.yml
# Edit docker-compose.override.yml with your API keys and settings

# Build and start
docker compose up --build

# Access at http://localhost:19123
```

**Rebuild after code changes:**
```bash
docker compose up --build --force-recreate
```

**View logs:**
```bash
docker compose logs -f itops-agents
```

---

### Option B — Local Development

```bash
# 1. Install backend dependencies
npm install

# 2. Install and build the React client
cd client
npm install
npm run build    # builds to client/dist → copied to public/app/
cd ..

# 3. Create a .env file
cp .env.example .env   # or create manually (see Section 5)
# Edit .env with ANTHROPIC_API_KEY, etc.

# 4. Start the backend (TypeScript, watch mode)
npm run dev
# Server starts at http://localhost:19123
```

**Client hot-reload development:**

In a separate terminal, run the Vite dev server:
```bash
cd client
npm run dev
# Vite dev server at http://localhost:5173
# (proxies API calls to http://localhost:19123)
```

> **Note:** The Vite dev server is for UI development only. The WebSocket connection still points to port 19123.

---

### Build for Production

**Backend only:**
```bash
npm run build
# Uses esbuild (build.mjs) to transpile src/ → dist/
# Output: dist/web/server.js (entry point)
```

**Start production server:**
```bash
npm start
# Runs: node dist/web/server.js
```

**Full production build (backend + frontend):**
```bash
# Build client first
cd client && npm run build && cd ..

# Build backend
npm run build
```

**Build internals:**
- The `build.mjs` script walks all `.ts` files in `src/` and transpiles each with `esbuild`.
- No bundling: each source file becomes its own `.js` file preserving directory structure.
- Module format: ESM (`"type": "module"` in package.json).
- Target: `node20`.

---

### Testing

```bash
npm test
# Runs: npm run build && node --test dist/**/*.test.js
```

**End-to-end rollback regression:**
```bash
npm run test:e2e:rollback
```

---

### Secret Generation

```bash
# Generate cryptographically secure secrets for .env
npm run secrets:generate

# Prepare a secure .env from template
npm run secrets:prepare
```

---

## 5. Environment Variables

All variables can be set in a `.env` file at the project root or passed via Docker Compose.

### Core

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `19123` | HTTP/WS server port |
| `HOST` | `0.0.0.0` | Bind address |
| `NODE_ENV` | `development` | `production` \| `development` |
| `PUBLIC_URL` | `http://localhost:19123` | Externally reachable URL (used in JIRA links, Teams cards) |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |

### Authentication

| Variable | Default | Description |
|----------|---------|-------------|
| `ADMIN_USERNAME` | `admin` | Default admin username |
| `ADMIN_PASSWORD` | required | Initial admin password; generate a unique value before startup. |
| `OPERATOR_USERNAME` | (empty) | Optional operator account username |
| `OPERATOR_PASSWORD` | (empty) | Optional operator account password |
| `VIEWER_USERNAME` | (empty) | Optional viewer account username |
| `VIEWER_PASSWORD` | (empty) | Optional viewer account password |
| `AUTH_TOKEN_SECRET` | (weak default) | JWT signing secret — **use a strong random value!** |
| `REQUIRE_STRONG_SECRETS` | `false` | Set to `true` to enforce minimum secret strength |

### AI Providers

| Variable | Default | Description |
|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | (empty) | Anthropic Claude API key |
| `OPENAI_API_KEY` | (empty) | OpenAI API key |
| `OLLAMA_BASE_URL` | `http://ollama:11434` | Ollama server base URL |
| `OLLAMA_DEFAULT_MODEL` | `llama3` | Default model for Ollama |
| `DEFAULT_AI_PLATFORM` | `claude` | `claude` \| `openai` \| `ollama` |

### Persistence

| Variable | Default | Description |
|----------|---------|-------------|
| `TASK_DB_PATH` | `/data/itops-agents/tasks.db` | SQLite path for tasks |
| `INCIDENT_DB_PATH` | `/data/itops-agents/incidents.db` | SQLite path for incidents |
| `AGENT_MEMORY_DB_PATH` | `/data/itops-agents/agent-memory.db` | SQLite path for agent memory |

### Incident SLAs

| Variable | Default | Description |
|----------|---------|-------------|
| `INCIDENT_SLA_CRITICAL_MIN` | `60` | SLA window for critical incidents (minutes) |
| `INCIDENT_SLA_HIGH_MIN` | `240` | SLA window for high incidents (minutes) |
| `INCIDENT_SLA_MEDIUM_MIN` | `1440` | SLA window for medium incidents (minutes) |
| `INCIDENT_SLA_LOW_MIN` | `4320` | SLA window for low incidents (minutes) |

### Security

| Variable | Default | Description |
|----------|---------|-------------|
| `CREDENTIAL_MASTER_KEY` | (weak default) | Master key for credential vault encryption — **replace!** |
| `APPROVAL_TOKEN_SECRET` | (weak default) | Secret for approval token signing — **replace!** |

### Servers

| Variable | Default | Description |
|----------|---------|-------------|
| `MONITORED_SERVERS` | (empty) | Comma-separated server IPs to monitor |
| `SERVER_NAME_<IP_WITH_UNDERSCORES>` | (IP address) | Friendly name for a monitored server. E.g., `SERVER_NAME_192_168_1_10=web-01` |

### JIRA

| Variable | Default | Description |
|----------|---------|-------------|
| `JIRA_BASE_URL` | (empty) | JIRA instance URL |
| `JIRA_EMAIL` | (empty) | Atlassian account email |
| `JIRA_API_TOKEN` | (empty) | JIRA API token |
| `JIRA_DEFAULT_PROJECT` | `OPS` | Default project key |
| `JIRA_INCIDENT_ISSUE_TYPE` | `Incident` | Issue type for incidents |
| `JIRA_POLL_INTERVAL_MINUTES` | `15` | Sync poll interval |
| `JIRA_AUTO_IMPORT` | `true` | Auto-create incidents from JIRA issues |
| `JIRA_SYNC_JQL` | (empty) | Custom JQL to filter which issues are synced |

### Backups

| Variable | Default | Description |
|----------|---------|-------------|
| `BACKUP_AUTOMATION_ENABLED` | `true` | Enable automatic backups |
| `BACKUP_AUTOMATION_INTERVAL_MINUTES` | `60` | Backup interval |
| `BACKUP_AUTOMATION_RUN_ON_STARTUP` | `true` | Run a backup on container startup |
| `RETENTION_KEEP_LATEST` | `30` | Number of recent backups and resolved incidents to keep |
| `RETENTION_MAX_AGE_DAYS` | `14` | Maximum age of backups and resolved incidents before purge |

### Other

| Variable | Default | Description |
|----------|---------|-------------|
| `WORKFLOW_DRIFT_THRESHOLD_MINUTES` | `30` | Minutes before a workflow is considered drifted |
| `TELEGRAM_BOT_TOKEN` | (empty) | Telegram bot token for notifications |
| `TELEGRAM_ALERT_CHAT_ID` | (empty) | Telegram chat ID for alerts |
| `PROXMOX_HOST` | (empty) | Proxmox VE host |
| `PROXMOX_TOKEN_ID` | (empty) | Proxmox API token ID |
| `PROXMOX_TOKEN_SECRET` | (empty) | Proxmox API token secret |
| `PROXMOX_NODE` | `pve` | Proxmox node name |
| `ALERT_RULES_PATH` | (empty) | Path to a JSON file with pre-defined alert rules |

---

## 6. How to Add a New Agent Skill

Skills are the building blocks of agent capability. Each skill provides one or more **commands** that agents can execute.

### Step 1 — Create the skill file

Create `src/skills/MyNewSkill.ts`:

```typescript
// src/skills/MyNewSkill.ts

import type { Skill } from '../types/index.js';
import { execFileSync } from 'child_process';

export class MyNewSkill {
  getSkill(): Skill {
    return {
      id: 'my_new_skill',
      name: 'My New Skill',
      description: 'Does something useful',
      category: 'infrastructure',    // or: 'monitoring', 'security', 'deployment', etc.
      enabled: true,
      commands: [
        {
          name: 'mynew.doSomething',
          description: 'Performs the main action',
          handler: 'doSomething',
          parameters: {
            target: 'string',   // required parameter
            verbose: 'boolean', // optional parameter
          },
        },
        {
          name: 'mynew.status',
          description: 'Check the status',
          handler: 'getStatus',
          parameters: {},
        },
      ],
    };
  }

  // Handler name must match the 'handler' field in commands above
  async doSomething(params: Record<string, unknown>): Promise<string> {
    const target = String(params.target || '');
    if (!target) throw new Error('target is required');

    // Your implementation here
    return `Successfully processed ${target}`;
  }

  async getStatus(_params: Record<string, unknown>): Promise<string> {
    return 'Status: OK';
  }
}
```

**Skill categories:** `infrastructure`, `monitoring`, `deployment`, `security`, `network`, `communication`, `service_desk`

---

### Step 2 — Register the skill in SkillManager

Edit `src/skills/SkillManager.ts`:

```typescript
// 1. Add import at the top
import { MyNewSkill } from './MyNewSkill.js';

// 2. Inside registerBuiltinSkills(), instantiate and register:
private registerBuiltinSkills(): void {
  // ... existing skills ...

  const myNewSkill = new MyNewSkill();
  this.registerSkill(myNewSkill.getSkill(), myNewSkill as unknown as SkillInstance);
}
```

---

### Step 3 — Verify

Start the server and call the skills API:

```bash
curl http://localhost:19123/api/skills | jq '.skills[] | select(.id == "my_new_skill")'
```

To test execution:

```bash
curl -X POST http://localhost:19123/api/skills/execute \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"command": "mynew.doSomething", "params": {"target": "test-value"}}'
```

---

### Step 4 — (Optional) Add MCP Tool Entry

If you want this skill accessible via the MCP protocol, add an entry to the `MCP_TOOLS_CATALOGUE` in `src/mcp/ITOpsMcpServer.ts`:

```typescript
{
  name: 'mynew_do_something',
  description: 'Performs the new skill action via MCP',
  inputSchema: {
    type: 'object',
    properties: {
      target: { type: 'string', description: 'Target to operate on' },
    },
    required: ['target'],
  },
},
```

And add a handler in the `callTool` switch statement within the same file.

---

### Available Skill Utilities

| Import | Use |
|--------|-----|
| `child_process.execFileSync` | Run a local command safely (no shell injection) |
| `child_process.exec` + `promisify` | Run async local command |
| `axios` | HTTP requests to external APIs |
| `better-sqlite3` | Direct SQLite access |

---

## 7. How to Add a New Page

### Step 1 — Create the page component

Create `client/src/pages/MyNewPage.tsx` and `client/src/pages/MyNewPage.module.css`:

```tsx
// client/src/pages/MyNewPage.tsx

import { useState, useEffect } from 'react'
import { useAuth } from '../hooks/useAuth'
import Layout from '../components/Layout'
import Card from '../components/Card'
import styles from './MyNewPage.module.css'

export default function MyNewPage() {
  const { token } = useAuth()
  const [data, setData] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/my-new-endpoint', {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.json())
      .then(setData)
      .finally(() => setLoading(false))
  }, [token])

  return (
    <Layout title="My New Page">
      <div className={styles.container}>
        {loading ? (
          <p>Loading…</p>
        ) : (
          <Card title="Results">
            <pre>{JSON.stringify(data, null, 2)}</pre>
          </Card>
        )}
      </div>
    </Layout>
  )
}
```

```css
/* client/src/pages/MyNewPage.module.css */

.container {
  padding: 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
```

---

### Step 2 — Add the route in App.tsx

Edit `client/src/App.tsx`:

```tsx
// 1. Add import
import MyNewPage from './pages/MyNewPage'

// 2. Add <Route> inside the <Routes> block
<Route path="/my-new-page" element={<MyNewPage />} />
```

---

### Step 3 — Add the nav item in Sidebar.tsx

Edit `client/src/components/Sidebar.tsx`:

Find the `NAV_SECTIONS` array and add the new item to the appropriate section:

```tsx
const NAV_SECTIONS = [
  {
    label: 'Operations',
    items: [
      // ... existing items ...
      { to: '/my-new-page', icon: '🔧', label: 'My New Page' },
    ]
  },
  // ...
]
```

Choose the right section:
- `Operations` — operational dashboards and workflows
- `Integrations` — external service integrations
- `System` — admin / configuration pages

---

### Step 4 — Build and verify

```bash
cd client && npm run build
# Or in dev mode: npm run dev (hot reload)
```

Navigate to `http://localhost:19123/my-new-page`.

---

### Using Shared Hooks

| Hook | Import | Purpose |
|------|--------|---------|
| `useAuth` | `../hooks/useAuth` | Get `token`, `user`, `logout` |
| `useWebSocket` | `../hooks/useWebSocket` | Get `connected`, `lastEvent` for real-time updates |
| `useTheme` | `../hooks/useTheme` | Get `theme`, `toggle` for dark/light mode |
| `useToast` | `../hooks/useToast` | Show toast notifications |
| `useNotifications` | `../hooks/useNotifications` | Bell notification system |

### Using Shared Components

| Component | Purpose |
|-----------|---------|
| `<Layout title="...">` | Page wrapper with sidebar |
| `<Card title="...">` | Content card with header |
| `<StatCard>` | KPI stat display card |
| `<Modal>` | Overlay modal dialog |
| `<Badge>` | Status/label badge |
| `<Button>` | Styled button |
| `<EmptyState>` | Empty state placeholder |
| `<Toast>` | Toast notification |

---

## 8. How to Add a New API Endpoint

### Option A — Add to server.ts (Simple Endpoint)

For simple endpoints, add directly to `src/web/server.ts`:

```typescript
// ─── My New API ───────────────────────────────────────────────

app.get('/api/my-resource', (req, res) => {
  // 1. Validate auth (pick appropriate permission)
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'security.read');
  if (!auth.ok) { res.status(403).json({ error: auth.reason }); return; }

  // 2. Handle query params
  const { filter } = req.query as Record<string, string>;

  // 3. Business logic
  const data = myService.getItems(filter);

  // 4. Return JSON
  res.json({ items: data, total: data.length });
});

app.post('/api/my-resource', (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'security.write');
  if (!auth.ok) { res.status(403).json({ error: auth.reason }); return; }

  try {
    const item = myService.create(req.body);
    // Broadcast real-time update (optional)
    broadcast({ type: 'my_resource_created', data: item });
    res.json(item);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});
```

**Permission levels:**
- `'security.read'` — viewer, operator, admin
- `'security.write'` — operator, admin
- `'config.write'` — admin only
- `'tools.execute.privileged'` — admin only
- `undefined` — any authenticated user (just checks token validity)

---

### Option B — Create a Router Module (Larger Feature)

For larger feature areas, create a dedicated router:

**`src/web/myResourceApi.ts`:**
```typescript
import { Router, Request, Response } from 'express';
import type { MyService } from '../services/MyService.js';

export function createMyResourceRouter(myService: MyService) {
  const router = Router();

  router.get('/', (_req: Request, res: Response) => {
    res.json(myService.getAll());
  });

  router.post('/', (req: Request, res: Response) => {
    try {
      const item = myService.create(req.body);
      res.json(item);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  router.delete('/:id', (req: Request, res: Response) => {
    const ok = myService.delete(req.params.id);
    if (!ok) { res.status(404).json({ error: 'Not found' }); return; }
    res.json({ success: true });
  });

  return router;
}
```

**Register in `server.ts`:**
```typescript
import { createMyResourceRouter } from './myResourceApi.js';

// After creating your service instance:
const myService = new MyService();

// Mount with auth middleware:
app.use('/api/my-resource', (req, res, next) => {
  const permission = ['GET', 'HEAD'].includes(req.method) ? 'security.read' : 'security.write';
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, permission);
  if (!auth.ok) { res.status(403).json({ error: auth.reason }); return; }
  next();
}, createMyResourceRouter(myService));
```

---

### Broadcasting WebSocket Events

From any route handler in `server.ts`:

```typescript
broadcast({ type: 'my_event_type', data: { id: '123', status: 'updated' } });
```

This sends the event to all connected WebSocket clients.

---

## 9. Contributing Guide

### Branch Naming

```
feature/<short-description>     # New features
fix/<issue-or-short-description> # Bug fixes
docs/<what-you-changed>         # Documentation only
chore/<what-you-did>            # Build scripts, deps, tooling
```

**Examples:**
```
feature/kubernetes-page
fix/incident-sla-calculation
docs/api-reference-jira
chore/upgrade-esbuild
```

---

### Commit Message Format

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <short description>

[optional body]

[optional footer]
Co-authored-by: ...
```

**Types:** `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `perf`

**Examples:**
```
feat(incidents): add SLA breach webhook notification
fix(auth): prevent session token reuse after logout
docs(api): document A2A mesh endpoints
chore(deps): upgrade @anthropic-ai/sdk to 0.32.1
```

---

### Pull Request Process

1. **Fork** the repository and create a branch from `main`.
2. **Write tests** for any new business logic (`.test.ts` files alongside source).
3. **Build** — `npm run build` must succeed without errors.
4. **Test** — `npm test` must pass.
5. **Update docs** — if you add endpoints or change behavior, update the relevant file in `docs/`.
6. **Open a PR** against `main` with:
   - A clear title following the commit message format.
   - A description of what changed and why.
   - Screenshots for UI changes.
   - Link to any related issues.

---

### Code Style

- **TypeScript**: `strict: false` (see `tsconfig.json`), but aim for explicit types on public APIs.
- **ES Modules**: All imports use `.js` extension (even for `.ts` source files) — this is required for Node.js ESM.
- **No default exports for services**: Use named exports (`export class MyService`).
- **Error handling**: Wrap async handlers in try/catch; return `{ error: message }` with appropriate status codes.
- **No secrets in source**: Use environment variables. Never commit `.env` files.

---

### Running Linting / Type Checks

```bash
# TypeScript type checking (no emit)
npx tsc --noEmit

# Client type checking
cd client && npx tsc -b --noEmit
```

There is no ESLint configuration currently; use `tsc --noEmit` as the linting step.

---

## 10. Troubleshooting

### Container won't start

**Symptom:** `docker compose up` exits immediately.

**Check:**
```bash
docker compose logs itops-agents
```

**Common causes:**
- `CREDENTIAL_MASTER_KEY` or `APPROVAL_TOKEN_SECRET` too short (< 32 chars) when `REQUIRE_STRONG_SECRETS=true`.
- Missing `ANTHROPIC_API_KEY` (warning only — agents won't work but server starts).
- Port 19123 already in use: `lsof -i :19123`.

---

### WebSocket disconnects frequently

**Symptom:** The status dot in the sidebar keeps turning red.

**Fix for nginx reverse proxy:**
```nginx
location / {
    proxy_pass http://localhost:19123;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}
```

**Fix for Caddy:**
```caddyfile
reverse_proxy localhost:19123 {
    transport http {
        dial_timeout 5s
        response_header_timeout 0
        read_buffer_size 64kb
    }
    header_up Upgrade {http.upgrade}
    header_up Connection "Upgrade"
}
```

---

### Agent chat returns no response

**Symptom:** Agent shows a spinner but never responds.

**Check:**
1. Verify AI provider API key is set: `curl http://localhost:19123/api/config` — check `anthropicKey` is not empty.
2. Check agent is active: `curl http://localhost:19123/api/agents` — look for `"status": "active"`.
3. Check server logs for AI provider errors:
   ```bash
   docker compose logs itops-agents | grep -i "anthropic\|openai\|ollama\|error"
   ```
4. For Ollama: verify the model is pulled: `docker exec ollama ollama list`.

---

### Build fails with "Cannot find module"

**Symptom:** `npm run build` fails with `Cannot find module 'X'`.

**Fix:**
1. Ensure all imports use the `.js` extension for local TypeScript files:
   ```typescript
   // ✅ Correct
   import { MyService } from './MyService.js';
   
   // ❌ Wrong
   import { MyService } from './MyService';
   ```
2. Run `npm install` to ensure all dependencies are present.
3. Check `tsconfig.json` `include` pattern covers your new file.

---

### SQLite database locked

**Symptom:** `SQLITE_BUSY: database is locked` in logs.

**Cause:** Multiple processes accessing the same database file, or the container was killed ungracefully.

**Fix:**
```bash
# Stop the container cleanly
docker compose stop

# Check for leftover lock files
ls /data/itops-agents/*.db-wal /data/itops-agents/*.db-shm

# Start again
docker compose start
```

If the problem persists, the WAL (Write-Ahead Log) may be corrupt. Restore from a backup (`POST /api/system/backups/:id/restore`).

---

### JIRA integration not syncing

**Symptom:** JIRA page shows "disabled" or sync never runs.

**Check:**
1. Verify environment variables are set: `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`.
2. Test connectivity:
   ```bash
   curl -u "email@example.com:api-token" \
     "https://yourcompany.atlassian.net/rest/api/3/myself"
   ```
3. Check `JIRA_SYNC_JQL` isn't too restrictive.
4. Confirm JIRA API token is still valid in Atlassian account settings.
5. In RightAPI Forge Settings → Integrations, re-save the JIRA config.

---

### Metrics endpoint returns nothing

**Symptom:** `GET /metrics` returns empty or minimal data.

**Explanation:** Performance metrics are in-memory and accumulate since last restart. Wait a few minutes after startup for meaningful data to appear.

---

### React page shows blank / 404

**Symptom:** Navigating to a new page shows blank content or a "not found" error.

**Check:**
1. Verify the route was added to `App.tsx`.
2. Verify the nav item path in `Sidebar.tsx` exactly matches the `<Route path>` in `App.tsx`.
3. Rebuild the client: `cd client && npm run build`.
4. Hard-refresh the browser (Ctrl+Shift+R) to clear cached SPA bundles.

---

### Out of memory errors

**Symptom:** Container killed with OOM, or Node.js heap errors.

**Fix — increase memory limit in docker-compose.yml:**
```yaml
services:
  itops-agents:
    deploy:
      resources:
        limits:
          memory: 2G
```

**Or increase Node.js heap:**
```yaml
environment:
  - NODE_OPTIONS=--max-old-space-size=1536
```

The default heap limit is ~512MB on Alpine. With many agents and active AI calls, 1–2GB is recommended.

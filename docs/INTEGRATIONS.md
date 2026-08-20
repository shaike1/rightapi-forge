# RightAPI Forge Integrations Guide

## OpenClaw / Copilot CLI (MCP)

RightAPI Forge exposes an MCP (Model Context Protocol) server at `<ITOPS_BASE_URL>/mcp`.
This lets OpenClaw, Copilot CLI, and any MCP-compatible orchestrator discover and call RightAPI Forge's
tools directly from natural-language prompts.

### Register with Copilot CLI

Add the following entry to `~/.copilot/mcp-config.json` (merge with existing entries):

```json
{
  "mcpServers": {
    "rightapi-forge": {
      "url": "http://<rightapi-forge-host>:19123/mcp",
      "description": "RightAPI Forge - incidents, agents, runbooks, and skills",
      "tools": [
        "list_incidents", "get_incident", "create_incident", "update_incident",
        "get_incident_stats", "list_agents", "list_skills", "execute_skill",
        "list_runbooks", "run_runbook", "get_runbook_run"
      ]
    }
  }
}
```

Replace `<rightapi-forge-host>` with your RightAPI Forge host name or address.

### Available MCP Tools

| Tool | Description |
|------|-------------|
| `list_incidents` | List all incidents with optional filters (status, severity, limit) |
| `get_incident` | Get full details of a specific incident by ID |
| `create_incident` | Create a new incident (title, severity, description) |
| `update_incident` | Update an existing incident's status or fields |
| `get_incident_stats` | Get aggregate incident statistics and counts |
| `list_agents` | List all registered agents and their current status |
| `list_skills` | List available automation skills |
| `execute_skill` | Execute a named skill with parameters |
| `list_runbooks` | List all runbook templates |
| `run_runbook` | Execute a runbook by ID with optional parameters |
| `get_runbook_run` | Get the status and output of a runbook execution |

### Use from OpenClaw

Once registered, invoke RightAPI Forge tools directly from your OpenClaw prompt:

```
# List open incidents
"list all open incidents in RightAPI Forge"

# Create an incident
"create a critical incident in RightAPI Forge: database connection pool exhausted"

# Run a runbook
"run the restart-nginx runbook in RightAPI Forge"

# Check agent health
"show me the status of all RightAPI Forge agents"
```

OpenClaw will automatically route these to the appropriate `rightapi-forge` MCP server.

You can also verify the MCP server is reachable:

```bash
curl -X POST http://localhost:19123/mcp \
  -H "Content-Type: application/json" \
  -d '{"method":"tools/list","params":{}}'
```

---

## Discord Integration

RightAPI Forge can send rich embed notifications to Discord channels via webhooks.

### Setup

1. In Discord, go to **Server Settings → Integrations → Webhooks → New Webhook**
2. Choose the target channel, copy the webhook URL
3. In RightAPI Forge, go to **Settings → Discord**
4. Paste the webhook URL and configure event toggles
5. Click **Test** to verify, then **Save**

### Supported Events

| Event | Trigger |
|-------|---------|
| Incident Created | New incident opened |
| Incident Resolved | Incident status → resolved |
| Alert Fired | Alert rule threshold breached |
| Agent Error | An agent reports an error |
| Runbook Completed | A runbook finishes (success or failure) |

### Embed Colors

Notifications are color-coded by severity: 🔴 critical · 🟠 high · 🟡 medium · 🟢 low · 🔵 info

---

### Discord Command Bot (Inbound)

RightAPI Forge includes a lightweight bot that listens to a Discord channel and responds to
ops commands in real time, using the Discord Gateway WebSocket API.

#### Setup

Set these environment variables to enable the command bot:

```
DISCORD_BOT_TOKEN=your-bot-token
DISCORD_COMMAND_CHANNEL=channel-id-to-listen-on
BEACON_ADMIN_TOKEN=your-beacon-admin-token
```

#### How to get a Discord bot token

1. Go to <https://discord.com/developers/applications>
2. Click **New Application** → open the **Bot** tab → **Reset Token**
3. Under **Privileged Gateway Intents**, enable **Message Content Intent**
4. Add the bot to your server with permissions: **Read Messages**, **Send Messages**, **Read Message History**
5. Copy the bot token to `DISCORD_BOT_TOKEN`
6. Copy the target ops channel ID to `DISCORD_COMMAND_CHANNEL`

#### Available Commands

| Command | Description |
|---------|-------------|
| `!help` | List available commands |
| `!health` | Show RightAPI Forge health status |
| `!incident list [open\|all]` | List incidents (default: open only) |
| `!incident create <title>` | Create a new incident (severity: medium) |
| `!incident get <id>` | Get details for a specific incident |
| `!runbook list` | List all runbook templates |
| `!runbook run <name>` | Execute a runbook by name |
| `!agent list` | List all registered agents |
| `!agent status` | Show agent status summary |
| `!task list` | Show the task queue |
| `!alert list` | List configured alert rules |

---

## Slack Integration

RightAPI Forge can send notifications to Slack channels via incoming webhooks.

### Setup

1. In Slack, go to **Apps → Incoming Webhooks → Add to Slack**
2. Choose the target channel and copy the webhook URL
3. In RightAPI Forge, go to **Settings → Slack**
4. Paste the webhook URL and configure event toggles
5. Click **Test** to verify, then **Save**

The event types and configuration options mirror those of the Discord integration above.

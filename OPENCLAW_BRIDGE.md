# OpenClaw Bridge (Minimal v1)

This bridge lets OpenClaw/Telegram act as a chat transport to the existing agent bus.

## Purpose

- Keep orchestration and policy in `itops-agents`.
- Use OpenClaw/Telegram as an external channel only.
- Reuse the same agent messaging flow as dashboard (`/api/agent-bus/send` behavior).

## Environment

Set these in runtime:

- `OPENCLAW_BRIDGE_ENABLED=true`
- `OPENCLAW_BRIDGE_SECRET=<shared-secret>`
- `OPENCLAW_BRIDGE_STATE_PATH=/data/itops-agents/openclaw-bridge-state.json` (optional)

## Auth

All bridge endpoints require:

- Header: `x-openclaw-secret: <OPENCLAW_BRIDGE_SECRET>`

## Endpoints

### `GET /api/openclaw-bridge/health`

Returns bridge enabled/configured status and state file path.

### `POST /api/openclaw-bridge/inbound`

Inbound message from OpenClaw/Telegram.

Request:

```json
{
  "chatId": "telegram-chat-id",
  "userId": "telegram-user-id",
  "text": "message text",
  "agentId": "optional target agent id or name",
  "expectReply": true
}
```

Commands supported in `text`:

- `/agents` list targetable agents
- `/use <agent-id-or-name>` set chat target agent
- `/status` show current target + thread
- `/swarm <task>` run swarm fan-out + synthesis

Normal message flow:

- Uses director as sender.
- Sends to selected target agent.
- Reuses thread per chat.
- Returns immediate reply (if `expectReply !== false`).

### `GET /api/openclaw-bridge/replies?chatId=<id>&since=<iso-ts>`

Poll replies for a chat thread.

- Filters to agent -> director messages only.
- Uses per-chat cursor (`lastDeliveredAt`) if `since` is omitted.

### `POST /api/agent-bus/swarm`

Fan-out a task to multiple worker agents in parallel and optionally synthesize a final answer via coordinator (director by default).

Request:

```json
{
  "task": "Assess production risk and propose next actions",
  "coordinatorAgentId": "optional-agent-id",
  "workerAgentIds": ["optional", "agent", "ids"],
  "maxWorkers": 3,
  "includeSynthesis": true,
  "threadId": "optional-thread-id",
  "taskId": "optional-task-id"
}
```

Notes:

- Requires normal API auth token (`agent_bus.write`), same as `/api/agent-bus/send`.
- Workers run in parallel and return per-worker success/error + duration.
- `synthesis` is produced by the coordinator when enabled.

## Notes

- Bridge does not bypass policy engine/tooling controls.
- Keep OpenClaw as transport/UI, not a second orchestration source.
- Recommended rollout:
  1. Enable bridge for one operator chat.
  2. Validate `/agents`, `/use`, and end-to-end send/reply.
  3. Add Telegram bot retry + idempotency at connector layer.

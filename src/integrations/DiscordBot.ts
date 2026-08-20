/**
 * DiscordBot — lightweight inbound command bot for Beacon.
 *
 * Uses the Discord Gateway WebSocket API (ws package) to receive
 * MESSAGE_CREATE events and respond via the Discord REST API.
 *
 * Required env vars:
 *   DISCORD_BOT_TOKEN       — bot token from Discord Developer Portal
 *   DISCORD_COMMAND_CHANNEL — channel ID to listen for commands
 *   BEACON_ADMIN_TOKEN      — used as Authorization: Bearer <token> for internal API calls
 */

import WebSocket from 'ws';
import { logger } from '../utils/logger.js';

const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';
const DISCORD_API = 'https://discord.com/api/v10';

// Gateway opcodes
const OP_DISPATCH = 0;
const OP_HEARTBEAT = 1;
const OP_IDENTIFY = 2;
const OP_HELLO = 10;
const OP_HEARTBEAT_ACK = 11;

const INTENT_GUILD_MESSAGES = 1 << 9;
const INTENT_MESSAGE_CONTENT = 1 << 15;

export class DiscordBot {
  private ws: WebSocket | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private sessionId: string | null = null;
  private sequence: number | null = null;
  private running = false;

  constructor(
    private token: string,
    private channelId: string,
    private beaconUrl: string,
  ) {}

  start(): void {
    this.running = true;
    this.connect();
  }

  stop(): void {
    this.running = false;
    this.cleanup();
  }

  private connect(): void {
    if (!this.running) return;
    logger.info('[DiscordBot] Connecting to Discord Gateway...');

    const ws = new WebSocket(GATEWAY_URL);
    this.ws = ws;

    ws.on('open', () => logger.info('[DiscordBot] WebSocket connected'));

    ws.on('message', (raw) => {
      let payload: any;
      try {
        payload = JSON.parse(raw.toString());
      } catch {
        return;
      }

      const { op, d, s, t } = payload;
      if (s !== null && s !== undefined) this.sequence = s;

      if (op === OP_HELLO) {
        this.startHeartbeat(d.heartbeat_interval);
        this.identify();
      } else if (op === OP_HEARTBEAT_ACK) {
        // heartbeat acknowledged — nothing to do
      } else if (op === OP_HEARTBEAT) {
        this.sendWs({ op: OP_HEARTBEAT, d: this.sequence });
      } else if (op === OP_DISPATCH && t === 'READY') {
        this.sessionId = d.session_id;
        logger.info(`[DiscordBot] Identified as ${d.user?.username}#${d.user?.discriminator}`);
      } else if (op === OP_DISPATCH && t === 'MESSAGE_CREATE') {
        this.handleMessage(d).catch((err) =>
          logger.error('[DiscordBot] handleMessage error:', { err: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined }),
        );
      }
    });

    ws.on('close', (code) => {
      logger.info(`[DiscordBot] WebSocket closed (code ${code}), reconnecting in 5s…`);
      this.cleanup(false);
      if (this.running) setTimeout(() => this.connect(), 5000);
    });

    ws.on('error', (err) => {
      logger.error('[DiscordBot] WebSocket error:', { err: err.message });
    });
  }

  private cleanup(clearRunning = true): void {
    if (clearRunning) this.running = false;
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.ws) {
      try { this.ws.terminate(); } catch { /* ignore */ }
      this.ws = null;
    }
  }

  private startHeartbeat(intervalMs: number): void {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    this.heartbeatInterval = setInterval(() => {
      this.sendWs({ op: OP_HEARTBEAT, d: this.sequence });
    }, intervalMs);
    // Send first heartbeat immediately
    this.sendWs({ op: OP_HEARTBEAT, d: this.sequence });
  }

  private identify(): void {
    this.sendWs({
      op: OP_IDENTIFY,
      d: {
        token: this.token,
        intents: INTENT_GUILD_MESSAGES | INTENT_MESSAGE_CONTENT,
        properties: { os: 'linux', browser: 'beacon-bot', device: 'beacon-bot' },
      },
    });
  }

  private sendWs(payload: object): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  // ── Command dispatch ────────────────────────────────────────────────────────

  private async handleMessage(data: any): Promise<void> {
    // Only process messages in the configured channel, ignore bots
    if (data.channel_id !== this.channelId) return;
    if (data.author?.bot) return;

    const content: string = (data.content ?? '').trim();
    if (!content.startsWith('!')) return;

    const parts = content.slice(1).split(/\s+/);
    const cmd = parts[0]?.toLowerCase();

    let response: string;

    try {
      switch (cmd) {
        case 'help':
          response = this.helpText();
          break;

        case 'health':
          response = await this.cmdHealth();
          break;

        case 'incident':
          response = await this.cmdIncident(parts.slice(1));
          break;

        case 'runbook':
          response = await this.cmdRunbook(parts.slice(1));
          break;

        case 'agent':
          response = await this.cmdAgent(parts.slice(1));
          break;

        case 'task':
          response = await this.cmdTask(parts.slice(1));
          break;

        case 'alert':
          response = await this.cmdAlert(parts.slice(1));
          break;

        default:
          response = `❌ Unknown command \`!${cmd}\`. Type \`!help\` to see available commands.`;
      }
    } catch (err: any) {
      response = `❌ Error: ${err.message ?? 'Unknown error'}`;
    }

    await this.sendToDiscord(data.channel_id, this.truncate(response));
  }

  // ── Individual command handlers ─────────────────────────────────────────────

  private helpText(): string {
    return [
      '**📋 RightAPI Forge Bot Commands**',
      '```',
      '!help                         List available commands',
      '!health                       Show RightAPI Forge health status',
      '!incident list [open|all]     List incidents',
      '!incident create <title>      Create a new incident',
      '!incident get <id>            Get incident details',
      '!runbook list                 List runbook templates',
      '!runbook run <name>           Execute a runbook by name',
      '!agent list                   List all agents',
      '!agent status                 Show agent status summary',
      '!task list                    List task queue',
      '!alert list                   List alert rules',
      '```',
    ].join('\n');
  }

  private async cmdHealth(): Promise<string> {
    const data = await this.callBeacon('/api/health');
    const status = data?.status ?? 'unknown';
    const emoji = status === 'ok' || status === 'healthy' ? '✅' : '⚠️';
    const lines = [`${emoji} **RightAPI Forge Health: ${status}**`];
    if (data?.uptime !== undefined) lines.push(`⏱ Uptime: ${Math.floor(data.uptime)}s`);
    if (data?.version) lines.push(`📦 Version: ${data.version}`);
    return lines.join('\n');
  }

  private async cmdIncident(args: string[]): Promise<string> {
    const sub = args[0]?.toLowerCase();

    if (!sub || sub === 'list') {
      const filter = args[1]?.toLowerCase();
      const query = filter === 'all' ? '' : '?status=open';
      const data = await this.callBeacon(`/api/incidents${query}`);
      const items: any[] = Array.isArray(data) ? data : (data?.incidents ?? []);
      if (items.length === 0) return '✅ No incidents found.';

      const lines = [`**🚨 Incidents (${items.length})**`];
      for (const inc of items.slice(0, 10)) {
        const sev = this.severityEmoji(inc.severity);
        lines.push(`${sev} \`${inc.id?.slice(0, 8) ?? '?'}\` **${inc.title}** — ${inc.status}`);
      }
      if (items.length > 10) lines.push(`_…and ${items.length - 10} more_`);
      return lines.join('\n');
    }

    if (sub === 'create') {
      const title = args.slice(1).join(' ');
      if (!title) return '❌ Usage: `!incident create <title>`';
      const inc = await this.callBeacon('/api/incidents', 'POST', {
        title,
        severity: 'medium',
        status: 'open',
      });
      const id = inc?.id ?? inc?.incident?.id ?? '?';
      return `✅ Incident created: \`${id}\` — **${title}**`;
    }

    if (sub === 'get') {
      const id = args[1];
      if (!id) return '❌ Usage: `!incident get <id>`';
      const inc = await this.callBeacon(`/api/incidents/${id}`);
      if (!inc) return `❌ Incident \`${id}\` not found.`;
      const sev = this.severityEmoji(inc.severity);
      return [
        `**📄 Incident \`${inc.id ?? id}\`**`,
        `**Title:** ${inc.title}`,
        `**Status:** ${inc.status}  ${sev} **Severity:** ${inc.severity}`,
        inc.description ? `**Description:** ${inc.description}` : '',
        `**Created:** ${inc.createdAt ?? inc.created_at ?? '—'}`,
      ].filter(Boolean).join('\n');
    }

    return '❌ Unknown subcommand. Use `!incident list`, `!incident create <title>`, or `!incident get <id>`.';
  }

  private async cmdRunbook(args: string[]): Promise<string> {
    const sub = args[0]?.toLowerCase();

    if (!sub || sub === 'list') {
      const data = await this.callBeacon('/api/runbooks/templates');
      const items: any[] = Array.isArray(data) ? data : (data?.templates ?? []);
      if (items.length === 0) return '📚 No runbook templates found.';
      const lines = [`**📚 Runbooks (${items.length})**`];
      for (const rb of items.slice(0, 10)) {
        lines.push(`• \`${rb.id ?? '?'}\` **${rb.name ?? rb.title ?? '—'}**`);
      }
      if (items.length > 10) lines.push(`_…and ${items.length - 10} more_`);
      return lines.join('\n');
    }

    if (sub === 'run') {
      const name = args.slice(1).join(' ');
      if (!name) return '❌ Usage: `!runbook run <name>`';

      // Resolve name → id
      const data = await this.callBeacon('/api/runbooks/templates');
      const items: any[] = Array.isArray(data) ? data : (data?.templates ?? []);
      const rb = items.find(
        (r) =>
          (r.name ?? r.title ?? '').toLowerCase() === name.toLowerCase() ||
          r.id === name,
      );
      if (!rb) return `❌ Runbook \`${name}\` not found. Use \`!runbook list\` to see available runbooks.`;

      const result = await this.callBeacon(`/api/runbooks/templates/${rb.id}/execute`, 'POST', {});
      const runId = result?.id ?? result?.runId ?? '?';
      return `▶️ Runbook **${rb.name ?? rb.title}** started. Run ID: \`${runId}\``;
    }

    return '❌ Unknown subcommand. Use `!runbook list` or `!runbook run <name>`.';
  }

  private async cmdAgent(args: string[]): Promise<string> {
    const sub = args[0]?.toLowerCase();
    const data = await this.callBeacon('/api/agents');
    const agents: any[] = Array.isArray(data) ? data : (data?.agents ?? []);

    if (!sub || sub === 'list') {
      if (agents.length === 0) return '🤖 No agents registered.';
      const lines = [`**🤖 Agents (${agents.length})**`];
      for (const ag of agents.slice(0, 15)) {
        const statusEmoji = ag.status === 'active' || ag.status === 'idle' ? '✅' : '⚠️';
        lines.push(`${statusEmoji} \`${ag.id?.slice(0, 8) ?? '?'}\` **${ag.name ?? ag.id}** — ${ag.status ?? 'unknown'}`);
      }
      if (agents.length > 15) lines.push(`_…and ${agents.length - 15} more_`);
      return lines.join('\n');
    }

    if (sub === 'status') {
      const counts: Record<string, number> = {};
      for (const ag of agents) {
        const s = ag.status ?? 'unknown';
        counts[s] = (counts[s] ?? 0) + 1;
      }
      const lines = [`**🤖 Agent Status Summary (${agents.length} total)**`];
      for (const [status, count] of Object.entries(counts)) {
        const emoji = status === 'active' || status === 'idle' ? '✅' : '⚠️';
        lines.push(`${emoji} ${status}: **${count}**`);
      }
      return lines.join('\n');
    }

    return '❌ Unknown subcommand. Use `!agent list` or `!agent status`.';
  }

  private async cmdTask(args: string[]): Promise<string> {
    const sub = args[0]?.toLowerCase();

    if (!sub || sub === 'list') {
      const data = await this.callBeacon('/api/task-queue');
      const tasks: any[] = Array.isArray(data) ? data : (data?.tasks ?? []);
      if (tasks.length === 0) return '📋 Task queue is empty.';
      const lines = [`**📋 Task Queue (${tasks.length})**`];
      for (const t of tasks.slice(0, 10)) {
        const statusEmoji = t.status === 'completed' ? '✅' : t.status === 'failed' ? '❌' : '🔄';
        lines.push(`${statusEmoji} \`${t.id?.slice(0, 8) ?? '?'}\` **${t.title ?? t.name ?? '—'}** — ${t.status ?? 'pending'}`);
      }
      if (tasks.length > 10) lines.push(`_…and ${tasks.length - 10} more_`);
      return lines.join('\n');
    }

    return '❌ Unknown subcommand. Use `!task list`.';
  }

  private async cmdAlert(args: string[]): Promise<string> {
    const sub = args[0]?.toLowerCase();

    if (!sub || sub === 'list') {
      const data = await this.callBeacon('/api/alert-rules');
      const rules: any[] = Array.isArray(data) ? data : (data?.rules ?? []);
      if (rules.length === 0) return '🔔 No alert rules configured.';
      const lines = [`**🔔 Alert Rules (${rules.length})**`];
      for (const r of rules.slice(0, 10)) {
        const enabledEmoji = r.enabled !== false ? '✅' : '⏸';
        lines.push(`${enabledEmoji} **${r.name ?? '—'}** — \`${r.metric ?? ''} ${r.operator ?? ''} ${r.threshold ?? ''}\``);
      }
      if (rules.length > 10) lines.push(`_…and ${rules.length - 10} more_`);
      return lines.join('\n');
    }

    return '❌ Unknown subcommand. Use `!alert list`.';
  }

  // ── Utilities ───────────────────────────────────────────────────────────────

  private severityEmoji(severity?: string): string {
    switch (severity?.toLowerCase()) {
      case 'critical': return '🔴';
      case 'high':     return '🟠';
      case 'medium':   return '🟡';
      case 'low':      return '🟢';
      default:         return '⚪';
    }
  }

  /** Truncate to 2000 chars — Discord message limit. */
  private truncate(text: string, limit = 1990): string {
    if (text.length <= limit) return text;
    return text.slice(0, limit - 30) + '\n_…(truncated)_';
  }

  async sendToDiscord(channelId: string, content: string): Promise<void> {
    const url = `${DISCORD_API}/channels/${channelId}/messages`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.error(`[DiscordBot] Failed to send message: HTTP ${res.status} ${text}`);
    }
  }

  async callBeacon(path: string, method = 'GET', body?: any): Promise<any> {
    const beaconToken = process.env.BEACON_ADMIN_TOKEN ?? '';
    const url = `${this.beaconUrl}${path}`;
    const options: RequestInit = {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(beaconToken ? { Authorization: `Bearer ${beaconToken}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    };
    const res = await fetch(url, options);
    if (!res.ok) {
      throw new Error(`RightAPI Forge API ${method} ${path} returned HTTP ${res.status}`);
    }
    return res.json().catch(() => null);
  }
}

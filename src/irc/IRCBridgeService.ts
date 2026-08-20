import net from 'net';
import { AgentMessageBus } from '../agents/AgentMessageBus.js';
import { logger } from '../utils/logger.js';

export interface IRCMessage {
  channel: string;
  nick: string;
  text: string;
  timestamp: string;
}

interface IRCBridgeConfig {
  host: string;
  port: number;
  nick: string;
  channels: string[];
}

type MessageBuffer = IRCMessage[];

const RING_BUFFER_SIZE = 200;
const CHANNELS = ['#ops', '#incidents', '#alerts', '#tasks'] as const;

const IRC_SUPERVISOR_STUCK_THRESHOLD_MS = Number(process.env.IRC_SUPERVISOR_STUCK_THRESHOLD_MS || 15 * 60 * 1000); // 15 min
const IRC_SUPERVISOR_CHECK_INTERVAL_MS = Number(process.env.IRC_SUPERVISOR_CHECK_INTERVAL_MS || 5 * 60 * 1000);   // 5 min
const IRC_SUPERVISOR_HEALTH_INTERVAL_MS = Number(process.env.IRC_SUPERVISOR_HEALTH_INTERVAL_MS || 60 * 60 * 1000); // 1 hour
type KnownChannel = typeof CHANNELS[number];

function isKnownChannel(c: string): c is KnownChannel {
  return (CHANNELS as readonly string[]).includes(c);
}

interface ITaskManager {
  getAllTasks(): Array<{ id: string; title: string; status: string }>;
}

interface StuckEntry {
  taskId?: string;
  idleMinutes?: number;
  phase?: string;
  orchestratorPhase?: string;
  recoveryState?: string;
}

interface IOrchestratorService {
  getStatus(): { queue: unknown[]; stuckEntries: StuckEntry[] };
}

interface IOrganizationManager {
  getAllAgents(): Array<{ id: string; status?: string; state?: string }>;
}

export class IRCBridgeService {
  private static instance: IRCBridgeService | null = null;

  private config: IRCBridgeConfig;
  private socket: net.Socket | null = null;
  private connected = false;
  private reconnectDelay = 2000;
  private readonly maxReconnectDelay = 60000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private buffer = '';
  private messageBus: AgentMessageBus;
  private messageBuffers: Map<string, MessageBuffer> = new Map();
  private totalMessageCount = 0;
  private destroyed = false;
  private taskManager: ITaskManager | null = null;
  private orchestratorService: IOrchestratorService | null = null;
  private organizationManager: IOrganizationManager | null = null;
  private supervisorCheckTimer: ReturnType<typeof setTimeout> | null = null;
  private supervisorHealthTimer: ReturnType<typeof setTimeout> | null = null;
  private lastAlertedStuckIds: Set<string> = new Set();

  private constructor(messageBus: AgentMessageBus) {
    this.messageBus = messageBus;
    this.config = {
      host: process.env.IRC_HOST || 'agentirc',
      port: parseInt(process.env.IRC_PORT || '6667', 10),
      nick: process.env.IRC_NICK || 'itops-bridge',
      channels: [...CHANNELS],
    };
    for (const ch of this.config.channels) {
      this.messageBuffers.set(ch, []);
    }
    this.subscribeToMessageBus();
  }

  static getInstance(messageBus?: AgentMessageBus): IRCBridgeService {
    if (!IRCBridgeService.instance) {
      if (!messageBus) {
        throw new Error('IRCBridgeService.getInstance() called before initialization — messageBus required');
      }
      IRCBridgeService.instance = new IRCBridgeService(messageBus);
    }
    return IRCBridgeService.instance;
  }

  // ── Service injection ──────────────────────────────────────────────────────

  setServices(services: {
    taskManager?: ITaskManager;
    orchestratorService?: IOrchestratorService;
    organizationManager?: IOrganizationManager;
  }): void {
    if (services.taskManager) this.taskManager = services.taskManager;
    if (services.orchestratorService) this.orchestratorService = services.orchestratorService;
    if (services.organizationManager) this.organizationManager = services.organizationManager;
  }

  // ── Public status ──────────────────────────────────────────────────────────

  getStatus(): {
    connected: boolean;
    host: string;
    port: number;
    nick: string;
    channels: string[];
    messageCount: number;
  } {
    return {
      connected: this.connected,
      host: this.config.host,
      port: this.config.port,
      nick: this.config.nick,
      channels: this.config.channels,
      messageCount: this.totalMessageCount,
    };
  }

  getMessages(channel: string, limit = 50): IRCMessage[] {
    const buf = this.messageBuffers.get(channel) ?? [];
    return buf.slice(-Math.min(limit, RING_BUFFER_SIZE));
  }

  // ── Connection ─────────────────────────────────────────────────────────────

  start(): void {
    if (this.destroyed) return;
    this.connect();
    this.startSupervisor();
  }

  stop(): void {
    this.destroyed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.supervisorCheckTimer) {
      clearTimeout(this.supervisorCheckTimer);
      this.supervisorCheckTimer = null;
    }
    if (this.supervisorHealthTimer) {
      clearTimeout(this.supervisorHealthTimer);
      this.supervisorHealthTimer = null;
    }
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.connected = false;
  }

  private connect(): void {
    if (this.destroyed) return;

    logger.info('IRC: connecting', { host: this.config.host, port: this.config.port });

    const socket = new net.Socket();
    this.socket = socket;

    socket.setEncoding('utf8');

    socket.connect(this.config.port, this.config.host, () => {
      logger.info('IRC: TCP connected — registering');
      this.buffer = '';
      this.send(`NICK ${this.config.nick}`);
      this.send(`USER ${this.config.nick} 0 * :IT Ops Bridge`);
    });

    socket.on('data', (data: string) => {
      this.buffer += data;
      const lines = this.buffer.split('\r\n');
      // keep incomplete last line in buffer
      this.buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim()) this.handleLine(line);
      }
    });

    socket.on('close', () => {
      if (this.connected) logger.warn('IRC: disconnected');
      this.connected = false;
      this.socket = null;
      this.scheduleReconnect();
    });

    socket.on('error', (err: Error) => {
      logger.warn('IRC: socket error', { err: err.message });
      socket.destroy();
    });
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return;
    logger.info('IRC: reconnecting in', { ms: this.reconnectDelay });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
  }

  private send(line: string): void {
    if (this.socket && !this.socket.destroyed) {
      this.socket.write(line + '\r\n', 'utf8');
    }
  }

  // ── IRC protocol ───────────────────────────────────────────────────────────

  private handleLine(raw: string): void {
    // PING :server → PONG
    if (raw.startsWith('PING')) {
      const token = raw.slice(5);
      this.send(`PONG ${token}`);
      return;
    }

    // Parse: [:prefix] CMD [params...] [:trailing]
    let rest = raw;
    let prefix = '';
    if (rest.startsWith(':')) {
      const sp = rest.indexOf(' ');
      prefix = rest.slice(1, sp);
      rest = rest.slice(sp + 1);
    }

    const trailIdx = rest.indexOf(' :');
    let trailing = '';
    if (trailIdx !== -1) {
      trailing = rest.slice(trailIdx + 2);
      rest = rest.slice(0, trailIdx);
    }

    const parts = rest.split(' ');
    const cmd = parts[0];

    // Welcome (001) → join channels
    if (cmd === '001') {
      logger.info('IRC: registered', { nick: this.config.nick });
      this.connected = true;
      this.reconnectDelay = 2000; // reset backoff
      for (const ch of this.config.channels) {
        this.send(`JOIN ${ch}`);
      }
      return;
    }

    // PRIVMSG
    if (cmd === 'PRIVMSG') {
      const target = parts[1] ?? '';
      const nick = prefix.split('!')[0] ?? prefix;
      this.handlePrivmsg(nick, target, trailing);
      return;
    }
  }

  private handlePrivmsg(nick: string, target: string, text: string): void {
    // Ignore our own messages echoed back
    if (nick === this.config.nick) return;

    const msg: IRCMessage = {
      channel: target,
      nick,
      text,
      timestamp: new Date().toISOString(),
    };

    this.pushToBuffer(target, msg);

    // Commands starting with ! in #ops
    if (target === '#ops' && text.startsWith('!')) {
      this.handleCommand(nick, text);
      return;
    }

    // @mentions of our nick
    if (text.includes(`@${this.config.nick}`)) {
      this.handleMention(nick, target, text);
      return;
    }
  }

  private handleCommand(nick: string, text: string): void {
    const parts = text.slice(1).trim().split(/\s+/);
    const cmd = (parts[0] ?? '').toLowerCase();
    const replyTarget = '#ops';

    logger.info('IRC: command received', { nick, cmd });

    if (cmd === 'status') {
      const s = this.getStatus();
      this.sendToChannel(replyTarget, `[status] connected=${s.connected} channels=${s.channels.join(',')} messages=${s.messageCount}`);
      return;
    }

    if (cmd === 'agents') {
      try {
        if (!this.organizationManager) {
          this.sendToChannel(replyTarget, '[agents] service not available');
          return;
        }
        const agents = this.organizationManager.getAllAgents();
        if (agents.length === 0) {
          this.sendToChannel(replyTarget, '[agents] No agents registered');
          return;
        }
        const list = agents.slice(0, 10).map(a => `${a.id}(${a.status || a.state || 'unknown'})`).join(', ');
        this.sendToChannel(replyTarget, `Active agents: ${list}`);
      } catch (err) {
        this.sendToChannel(replyTarget, `[agents] error: ${(err as Error).message}`);
      }
      return;
    }

    if (cmd === 'alert') {
      const sub = (parts[1] ?? '').toLowerCase();
      if (sub === 'list') {
        try {
          this.sendToChannel(replyTarget, '[alert list] No alert store available — use !status for bridge status');
        } catch (err) {
          this.sendToChannel(replyTarget, `[alert] error: ${(err as Error).message}`);
        }
        return;
      }
      if (sub === 'ack') {
        const alertId = parts[2] ?? '';
        if (!alertId) {
          this.sendToChannel(replyTarget, '[alert ack] usage: !alert ack <id>');
          return;
        }
        this.sendToChannel(replyTarget, `[alert ack] ack request for ${alertId} noted (no ack endpoint available)`);
        return;
      }
      this.sendToChannel(replyTarget, '[alert] usage: !alert list | !alert ack <id>');
      return;
    }

    if (cmd === 'task') {
      const sub = (parts[1] ?? '').toLowerCase();
      if (sub === 'list') {
        try {
          if (!this.taskManager) {
            this.sendToChannel(replyTarget, '[task list] service not available');
            return;
          }
          const tasks = this.taskManager.getAllTasks().slice(-5);
          if (tasks.length === 0) {
            this.sendToChannel(replyTarget, '[task list] No tasks found');
            return;
          }
          const list = tasks.map(t => `[${t.id.slice(0, 8)}] ${t.title.slice(0, 30)} (${t.status})`).join(' | ');
          this.sendToChannel(replyTarget, `Tasks: ${list}`);
        } catch (err) {
          this.sendToChannel(replyTarget, `[task list] error: ${(err as Error).message}`);
        }
        return;
      }
      if (sub === 'create') {
        const title = parts.slice(2).join(' ').replace(/^["']|["']$/g, '');
        if (title) {
          this.messageBus.send({
            fromAgentId: `irc:${nick}`,
            toAgentId: 'orchestrator',
            content: JSON.stringify({ type: 'irc_command', command: 'task_create', title }),
            kind: 'system',
          });
          this.sendToChannel(replyTarget, `[task] create request queued: "${title}"`);
        }
        return;
      }
      this.sendToChannel(replyTarget, '[task] usage: !task list | !task create "<title>"');
      return;
    }

    if (cmd === 'orchestrator') {
      try {
        if (!this.orchestratorService) {
          this.sendToChannel(replyTarget, '[orchestrator] service not available');
          return;
        }
        const status = this.orchestratorService.getStatus();
        const queueLen = Array.isArray(status.queue) ? status.queue.length : 0;
        const stuckLen = Array.isArray(status.stuckEntries) ? status.stuckEntries.length : 0;
        this.sendToChannel(replyTarget, `[orchestrator] Queue: ${queueLen} tasks, Stuck: ${stuckLen}`);
      } catch (err) {
        this.sendToChannel(replyTarget, `[orchestrator] error: ${(err as Error).message}`);
      }
      return;
    }

    if (cmd === 'help') {
      this.sendToChannel(replyTarget, '[help] commands: !status !agents !alert list !alert ack <id> !task list !task create "<title>" !orchestrator !help');
      return;
    }

    this.sendToChannel(replyTarget, `[error] unknown command: !${cmd}  (try !help)`);
  }

  private handleMention(nick: string, channel: string, _text: string): void {
    const s = this.getStatus();
    this.sendToChannel(channel, `${nick}: IT Ops Bridge online | connected=${s.connected} | messages=${s.messageCount}`);
  }

  // ── AgentMessageBus subscription ──────────────────────────────────────────

  private subscribeToMessageBus(): void {
    // Poll the bus every 5 s for new messages and route to IRC channels.
    // The AgentMessageBus is file-backed and doesn't have push events, so we
    // track the last-seen timestamp and fan out new messages.
    let lastSeenTimestamp = new Date().toISOString();

    const poll = (): void => {
      if (this.destroyed) return;
      try {
        const recent = this.messageBus.listMessages({ limit: 50 });
        const newMsgs = recent.filter(m => m.timestamp > lastSeenTimestamp);
        if (newMsgs.length > 0) {
          // Sort oldest first
          newMsgs.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
          lastSeenTimestamp = newMsgs[newMsgs.length - 1]!.timestamp;
          for (const m of newMsgs) {
            this.routeBusMessageToIRC(m);
          }
        }
      } catch (err) {
        logger.warn('IRC: bus poll error', { err: (err as Error).message });
      }
      setTimeout(poll, 5000);
    };

    setTimeout(poll, 5000);
  }

  private routeBusMessageToIRC(m: import('../agents/AgentMessageBus.js').AgentBusMessage): void {
    const text = m.content.slice(0, 400); // truncate for IRC line limits

    // Classify by content / metadata
    const lower = m.content.toLowerCase();

    if (m.taskId) {
      this.sendToChannel('#tasks', `[task:${m.taskId}] ${m.fromAgentId} -> ${m.toAgentId}: ${text}`);
      return;
    }

    if (lower.includes('alert') || lower.includes('alarm') || lower.includes('critical')) {
      this.sendToChannel('#alerts', `[ALERT] ${m.fromAgentId}: ${text}`);
      return;
    }

    if (lower.includes('incident')) {
      this.sendToChannel('#incidents', `[incident] ${m.fromAgentId}: ${text}`);
      return;
    }

    // Default: #ops
    this.sendToChannel('#ops', `[${m.fromAgentId}] ${text}`);
  }

  // ── Outbound helpers ───────────────────────────────────────────────────────

  sendToChannel(channel: string, text: string): void {
    if (!this.connected) {
      logger.warn('IRC: sendToChannel skipped — not connected', { channel });
      return;
    }
    // Split at 400 chars to stay inside IRC 512-byte limit
    const chunks = text.match(/.{1,400}/g) ?? [text];
    for (const chunk of chunks) {
      this.send(`PRIVMSG ${channel} :${chunk}`);
    }
    // Record in our own buffer
    const msg: IRCMessage = {
      channel,
      nick: this.config.nick,
      text,
      timestamp: new Date().toISOString(),
    };
    this.pushToBuffer(channel, msg);
  }

  // ── Supervisor: periodic stuck-task alerts + hourly health digest ──────────

  private startSupervisor(): void {
    if (this.destroyed) return;

    const scheduleCheck = (): void => {
      if (this.destroyed) return;
      this.supervisorCheckTimer = setTimeout(() => {
        this.runSupervisorCheck();
        scheduleCheck();
      }, IRC_SUPERVISOR_CHECK_INTERVAL_MS);
    };

    const scheduleHealth = (): void => {
      if (this.destroyed) return;
      this.supervisorHealthTimer = setTimeout(() => {
        this.runHealthDigest();
        scheduleHealth();
      }, IRC_SUPERVISOR_HEALTH_INTERVAL_MS);
    };

    // Delay initial checks to let services stabilise
    setTimeout(() => { scheduleCheck(); }, 60_000);
    setTimeout(() => { scheduleHealth(); }, 5 * 60_000);
  }

  private runSupervisorCheck(): void {
    if (!this.orchestratorService) return;
    try {
      const status = this.orchestratorService.getStatus();
      const stuck = Array.isArray(status.stuckEntries) ? status.stuckEntries : [];
      const nowStuckIds = new Set<string>();

      for (const entry of stuck) {
        const id = String(entry.taskId || '');
        if (!id) continue;
        const idleMs = (entry.idleMinutes || 0) * 60_000;
        if (idleMs >= IRC_SUPERVISOR_STUCK_THRESHOLD_MS) {
          nowStuckIds.add(id);
          if (!this.lastAlertedStuckIds.has(id)) {
            const mins = Math.round(idleMs / 60_000);
            const phase = entry.phase || entry.orchestratorPhase || 'unknown';
            const state = entry.recoveryState || 'unknown';
            this.sendToChannel('#alerts',
              `[STUCK] Task ${id.slice(0, 8)} idle ${mins}m | phase=${phase} | recoveryState=${state}`
            );
          }
        }
      }

      // Clear alerts for tasks that are no longer stuck
      this.lastAlertedStuckIds = nowStuckIds;
    } catch (err) {
      logger.warn('IRC supervisor check error', { err: (err as Error).message });
    }
  }

  private runHealthDigest(): void {
    try {
      const parts: string[] = ['[HEALTH]'];

      if (this.orchestratorService) {
        const status = this.orchestratorService.getStatus();
        const queueLen = Array.isArray(status.queue) ? status.queue.length : 0;
        const stuckLen = Array.isArray(status.stuckEntries) ? status.stuckEntries.length : 0;
        parts.push(`queue=${queueLen} stuck=${stuckLen}`);
      }

      if (this.organizationManager) {
        const agents = this.organizationManager.getAllAgents();
        const active = agents.filter(a => (a.status || a.state) === 'active').length;
        parts.push(`agents=${agents.length} active=${active}`);
      }

      if (this.taskManager) {
        const tasks = this.taskManager.getAllTasks();
        const running = tasks.filter(t => t.status === 'in_progress').length;
        parts.push(`tasks=${tasks.length} running=${running}`);
      }

      parts.push(`ts=${new Date().toTimeString().slice(0, 8)}`);
      this.sendToChannel('#ops', parts.join(' | '));
    } catch (err) {
      logger.warn('IRC health digest error', { err: (err as Error).message });
    }
  }

  private pushToBuffer(channel: string, msg: IRCMessage): void {
    if (!isKnownChannel(channel) && !this.messageBuffers.has(channel)) {
      this.messageBuffers.set(channel, []);
    }
    const buf = this.messageBuffers.get(channel);
    if (!buf) return;
    buf.push(msg);
    if (buf.length > RING_BUFFER_SIZE) {
      buf.splice(0, buf.length - RING_BUFFER_SIZE);
    }
    this.totalMessageCount += 1;
  }
}

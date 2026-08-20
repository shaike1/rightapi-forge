import { EventEmitter } from 'events';
import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage, Server } from 'http';
import { v4 as uuidv4 } from 'uuid';

export type WsEventType =
  | 'task:created' | 'task:updated' | 'task:completed' | 'task:failed'
  | 'agent:status' | 'agent:started' | 'agent:stopped'
  | 'alert:created' | 'alert:resolved' | 'alert:acknowledged'
  | 'workflow:started' | 'workflow:completed' | 'workflow:failed' | 'workflow:approval'
  | 'pipeline:triggered' | 'pipeline:completed' | 'pipeline:failed'
  | 'analytics:snapshot'
  | 'system:health'
  | 'ping' | 'pong';

export interface WsMessage {
  type: WsEventType | string;
  payload?: any;
  ts: number;
  id?: string;
}

interface ClientMeta {
  id: string;
  ws: WebSocket;
  subscriptions: Set<string>;  // event type prefixes e.g. 'task', 'alert', '*'
  connectedAt: Date;
  lastPing: Date;
  ip: string;
}

export class RealtimeBus extends EventEmitter {
  private wss: WebSocketServer | null = null;
  private clients: Map<string, ClientMeta> = new Map();
  private messageCount = 0;
  private pingInterval: ReturnType<typeof setInterval> | null = null;

  attach(server: Server): void {
    this.wss = new WebSocketServer({ server, path: '/ws' });

    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      const clientId = uuidv4();
      const ip = req.headers['x-forwarded-for']?.toString() || req.socket.remoteAddress || '?';

      const meta: ClientMeta = {
        id: clientId,
        ws,
        subscriptions: new Set(['*']),  // subscribe to all by default
        connectedAt: new Date(),
        lastPing: new Date(),
        ip
      };

      this.clients.set(clientId, meta);
      console.log('[WS] Client connected:', clientId, 'from', ip, '| Total:', this.clients.size);

      // Welcome message
      this.send(ws, { type: 'connected', payload: { clientId, message: 'RightAPI Forge WebSocket v15' } });

      ws.on('message', (data: Buffer) => {
        try {
          const msg: WsMessage = JSON.parse(data.toString());
          this.handleClientMessage(meta, msg);
        } catch (e) {
          // Ignore malformed messages
        }
      });

      ws.on('close', () => {
        this.clients.delete(clientId);
        console.log('[WS] Client disconnected:', clientId, '| Total:', this.clients.size);
      });

      ws.on('error', () => {
        this.clients.delete(clientId);
      });

      // Send initial state snapshot
      this.sendSnapshot(ws);
    });

    // Ping/pong keepalive every 30s
    this.pingInterval = setInterval(() => {
      const stale: string[] = [];
      this.clients.forEach((meta, id) => {
        const age = Date.now() - meta.lastPing.getTime();
        if (age > 90_000) {
          stale.push(id);
        } else {
          this.send(meta.ws, { type: 'ping' });
        }
      });
      stale.forEach(id => {
        const meta = this.clients.get(id);
        if (meta) meta.ws.terminate();
        this.clients.delete(id);
      });
    }, 30_000);

    console.log('[WS] RealtimeBus attached to server at /ws');
  }

  private handleClientMessage(meta: ClientMeta, msg: WsMessage): void {
    meta.lastPing = new Date();

    switch (msg.type) {
      case 'ping':
        this.send(meta.ws, { type: 'pong' });
        break;

      case 'subscribe':
        if (msg.payload?.events) {
          meta.subscriptions.clear();
          (msg.payload.events as string[]).forEach(e => meta.subscriptions.add(e));
        }
        this.send(meta.ws, { type: 'subscribed', payload: { events: Array.from(meta.subscriptions) } });
        break;

      case 'unsubscribe':
        if (msg.payload?.events) {
          (msg.payload.events as string[]).forEach(e => meta.subscriptions.delete(e));
        }
        break;

      case 'get:stats':
        this.send(meta.ws, { type: 'stats', payload: this.getStats() });
        break;
    }
  }

  private async sendSnapshot(ws: WebSocket): Promise<void> {
    // Send current system state to new connection
    this.send(ws, {
      type: 'system:health',
      payload: {
        status: 'operational',
        connectedClients: this.clients.size,
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        timestamp: new Date()
      }
    });
  }

  // ── Publish event to all matching subscribers ──────────────────────────────

  publish(type: string, payload?: any): void {
    const msg: WsMessage = { type, payload, ts: Date.now(), id: uuidv4() };
    this.messageCount++;

    let sent = 0;
    this.clients.forEach(meta => {
      if (meta.ws.readyState !== WebSocket.OPEN) return;

      const prefix = type.split(':')[0];
      if (
        meta.subscriptions.has('*') ||
        meta.subscriptions.has(type) ||
        meta.subscriptions.has(prefix)
      ) {
        this.send(meta.ws, msg);
        sent++;
      }
    });

    // Also emit locally for internal listeners
    this.emit(type, payload);
  }

  private send(ws: WebSocket, msg: Omit<WsMessage, 'ts'> & { ts?: number }): void {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ ...msg, ts: msg.ts || Date.now() }));
      } catch (e) {
        // Ignore send errors
      }
    }
  }

  getStats() {
    return {
      connectedClients: this.clients.size,
      totalMessages: this.messageCount,
      clients: Array.from(this.clients.values()).map(c => ({
        id: c.id,
        ip: c.ip,
        connectedAt: c.connectedAt,
        lastPing: c.lastPing,
        subscriptions: Array.from(c.subscriptions)
      }))
    };
  }

  destroy(): void {
    if (this.pingInterval) clearInterval(this.pingInterval);
    if (this.wss) this.wss.close();
  }
}

// Singleton
export const realtimeBus = new RealtimeBus();

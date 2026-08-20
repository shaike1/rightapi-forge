import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { realtimeBus } from '../realtime/RealtimeBus.js';

export type WebhookEventFilter =
  | 'task:*' | 'task:created' | 'task:completed' | 'task:failed'
  | 'alert:*' | 'alert:created' | 'alert:resolved'
  | 'agent:*' | 'agent:status'
  | 'workflow:*' | 'workflow:completed' | 'workflow:failed'
  | 'pipeline:*' | 'pipeline:completed' | 'pipeline:failed'
  | 'system:*' | '*';

export interface Webhook {
  id: string;
  name: string;
  url: string;
  events: WebhookEventFilter[];
  secret?: string;
  enabled: boolean;
  createdAt: Date;
  lastTriggeredAt?: Date;
  successCount: number;
  failureCount: number;
  headers?: Record<string, string>;
}

export interface WebhookDelivery {
  id: string;
  webhookId: string;
  event: string;
  payload: any;
  status: 'success' | 'failure';
  statusCode?: number;
  durationMs: number;
  error?: string;
  deliveredAt: Date;
}

export class WebhookManager {
  private webhooks: Map<string, Webhook> = new Map();
  private deliveries: WebhookDelivery[] = [];
  private dataPath: string;

  constructor(dataPath: string = '/data/itops-agents/webhooks') {
    this.dataPath = dataPath;
    this.ensureDir();
    this.load();
    this.startListening();
    console.log('[WebhookManager] Ready with', this.webhooks.size, 'webhooks');
  }

  private startListening(): void {
    // Listen to ALL events from the bus and route to matching webhooks
    realtimeBus.on('*', (type: string, payload: any) => {
      this.dispatch(type, payload);
    });

    // Since EventEmitter doesn't support wildcard, we hook into the publish method
    // by listening to specific event categories
    const categories = ['task', 'alert', 'agent', 'workflow', 'pipeline', 'system'];
    categories.forEach(cat => {
      ['created', 'updated', 'completed', 'failed', 'started', 'stopped', 'resolved', 'acknowledged', 'triggered', 'status', 'health'].forEach(action => {
        realtimeBus.on(cat + ':' + action, (payload: any) => {
          this.dispatch(cat + ':' + action, payload);
        });
      });
    });
  }

  private matches(webhookEvents: WebhookEventFilter[], eventType: string): boolean {
    for (const filter of webhookEvents) {
      if (filter === '*') return true;
      if (filter === eventType) return true;
      if (filter.endsWith(':*')) {
        const prefix = filter.slice(0, -2);
        if (eventType.startsWith(prefix + ':')) return true;
      }
    }
    return false;
  }

  private async dispatch(eventType: string, payload: any): Promise<void> {
    const matching = Array.from(this.webhooks.values())
      .filter(w => w.enabled && this.matches(w.events, eventType));

    if (!matching.length) return;

    await Promise.allSettled(matching.map(wh => this.deliver(wh, eventType, payload)));
  }

  private async deliver(webhook: Webhook, event: string, payload: any): Promise<void> {
    const start = Date.now();
    const body = JSON.stringify({
      id: uuidv4(),
      event,
      payload,
      webhook: { id: webhook.id, name: webhook.name },
      ts: new Date().toISOString()
    });

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'ITOps-Agents/16.0',
      'X-ITOps-Event': event,
      'X-ITOps-Webhook-Id': webhook.id,
      ...(webhook.headers || {})
    };

    if (webhook.secret) {
      const { createHmac } = await import('crypto');
      headers['X-ITOps-Signature'] = 'sha256=' + createHmac('sha256', webhook.secret).update(body).digest('hex');
    }

    let status: 'success' | 'failure' = 'failure';
    let statusCode: number | undefined;
    let error: string | undefined;

    try {
      const { default: fetch } = await import('node-fetch' as any).catch(() => ({ default: global.fetch }));
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);

      try {
        const res = await fetch(webhook.url, { method: 'POST', headers, body, signal: controller.signal as any });
        statusCode = res.status;
        status = res.ok ? 'success' : 'failure';
        if (!res.ok) error = 'HTTP ' + res.status;
      } finally {
        clearTimeout(timeout);
      }
    } catch (e: any) {
      error = e.message || 'Network error';
    }

    const duration = Date.now() - start;
    webhook.lastTriggeredAt = new Date();
    if (status === 'success') webhook.successCount++;
    else webhook.failureCount++;

    const delivery: WebhookDelivery = {
      id: uuidv4(),
      webhookId: webhook.id,
      event,
      payload,
      status,
      statusCode,
      durationMs: duration,
      error,
      deliveredAt: new Date()
    };

    this.deliveries.push(delivery);
    if (this.deliveries.length > 1000) this.deliveries = this.deliveries.slice(-1000);
    this.save();
  }

  // ── CRUD ───────────────────────────────────────────────────────────────────

  create(data: Omit<Webhook, 'id' | 'createdAt' | 'successCount' | 'failureCount'>): Webhook {
    const wh: Webhook = { ...data, id: uuidv4(), createdAt: new Date(), successCount: 0, failureCount: 0 };
    this.webhooks.set(wh.id, wh);
    this.save();
    return wh;
  }

  update(id: string, patch: Partial<Webhook>): Webhook | null {
    const wh = this.webhooks.get(id);
    if (!wh) return null;
    Object.assign(wh, patch);
    this.save();
    return wh;
  }

  delete(id: string): boolean {
    const ok = this.webhooks.delete(id);
    if (ok) this.save();
    return ok;
  }

  list(): Webhook[] {
    return Array.from(this.webhooks.values()).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  getDeliveries(webhookId?: string, limit = 50): WebhookDelivery[] {
    let list = [...this.deliveries];
    if (webhookId) list = list.filter(d => d.webhookId === webhookId);
    return list.sort((a, b) => new Date(b.deliveredAt).getTime() - new Date(a.deliveredAt).getTime()).slice(0, limit);
  }

  async testWebhook(id: string): Promise<{ success: boolean; error?: string; statusCode?: number; durationMs: number }> {
    const wh = this.webhooks.get(id);
    if (!wh) return { success: false, error: 'Webhook not found', durationMs: 0 };
    await this.deliver(wh, 'test:ping', { message: 'Test delivery from RightAPI Forge' });
    const last = this.deliveries.filter(d => d.webhookId === id).at(-1);
    return { success: last?.status === 'success', error: last?.error, statusCode: last?.statusCode, durationMs: last?.durationMs || 0 };
  }

  getStats() {
    const all = Array.from(this.webhooks.values());
    return {
      total: all.length,
      enabled: all.filter(w => w.enabled).length,
      totalDeliveries: this.deliveries.length,
      successDeliveries: this.deliveries.filter(d => d.status === 'success').length,
      failureDeliveries: this.deliveries.filter(d => d.status === 'failure').length
    };
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.dataPath)) fs.mkdirSync(this.dataPath, { recursive: true });
  }

  private save(): void {
    try {
      fs.writeFileSync(path.join(this.dataPath, 'webhooks.json'), JSON.stringify(Array.from(this.webhooks.entries()), null, 2));
    } catch (e) { console.error('[WebhookManager] Save failed:', e); }
  }

  private load(): void {
    try {
      const f = path.join(this.dataPath, 'webhooks.json');
      if (fs.existsSync(f)) this.webhooks = new Map(JSON.parse(fs.readFileSync(f, 'utf8')));
    } catch (e) { console.error('[WebhookManager] Load failed:', e); }
  }
}

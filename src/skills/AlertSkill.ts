// Alerting & Notification Skill

import type { Skill } from '../types/index.js';
import axios from 'axios';
import { encode, ok, fail } from './SkillResult.js';

const SEVERITY_EMOJI: Record<string, string> = {
  critical: '🔴',
  error:    '🔴',
  warning:  '🟠',
  warn:     '🟠',
  info:     '🔵',
  ok:       '✅'
};

function axiosFail(action: string, e: any): string {
  if (axios.isAxiosError(e) && e.response) {
    const detail = e.response.data?.description || e.response.data?.error || '';
    return encode(fail(`${action}: ${e.response.status} ${e.response.statusText}${detail ? ` — ${detail}` : ''}`, action));
  }
  return encode(fail(`${action}: ${e?.code || ''} ${e?.message || String(e)}`.trim(), action));
}

export class AlertSkill {
  // In-memory alert store
  private alerts: Map<string, any> = new Map();
  private alertCounter = 1;

  getSkill(): Skill {
    return {
      id: 'alerts',
      name: 'Alerting & Notifications',
      description: 'Send alerts via Telegram, email, Slack, Discord, PagerDuty, webhooks',
      category: 'monitoring',
      enabled: true,
      commands: [
        { name: 'alert.send',       description: 'Send alert notification',          handler: 'alertSend',       parameters: { title: 'string', message: 'string', severity: 'string', channel: 'string' } },
        { name: 'alert.telegram',   description: 'Send Telegram alert message',      handler: 'alertTelegram',   parameters: { message: 'string', severity: 'string', chatId: 'string' } },
        { name: 'alert.email',      description: 'Send email alert',                 handler: 'alertEmail',      parameters: { to: 'string', subject: 'string', body: 'string' } },
        { name: 'alert.slack',      description: 'Send Slack notification',          handler: 'alertSlack',      parameters: { webhook: 'string', message: 'string', channel: 'string' } },
        { name: 'alert.discord',    description: 'Send Discord notification',        handler: 'alertDiscord',    parameters: { webhook: 'string', message: 'string' } },
        { name: 'alert.webhook',    description: 'Send webhook notification',        handler: 'alertWebhook',    parameters: { url: 'string', method: 'string', body: 'string' } },
        { name: 'alert.pagerduty',  description: 'Trigger PagerDuty incident',       handler: 'alertPagerDuty',  parameters: { title: 'string', description: 'string', urgency: 'string' } },
        { name: 'alert.status',     description: 'Check alert status',               handler: 'alertStatus',     parameters: { alertId: 'string' } },
        { name: 'alert.list',       description: 'List recent alerts',               handler: 'alertList',       parameters: { limit: 'number', severity: 'string' } },
        { name: 'alert.config',     description: 'Configure alert channels',         handler: 'alertConfig',     parameters: { channel: 'string', config: 'object' } }
      ]
    };
  }

  async alertTelegram(params: { message: string; severity?: string; chatId?: string }): Promise<string> {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = params.chatId || process.env.TELEGRAM_ALERT_CHAT_ID;
    if (!token) return encode(fail('TELEGRAM_BOT_TOKEN not configured'));
    if (!chatId) return encode(fail('chatId or TELEGRAM_ALERT_CHAT_ID not configured'));
    if (!params?.message) return encode(fail('alert.telegram requires { message }'));

    const emoji = SEVERITY_EMOJI[params.severity?.toLowerCase() || 'info'] || '🔵';
    const text = `${emoji} *IT Ops Alert*\n\n${params.message}`;
    try {
      const res = await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
        chat_id: chatId,
        text,
        parse_mode: 'Markdown'
      });
      return encode(ok({ messageId: res.data?.result?.message_id, chatId }, `telegram → ${chatId}`));
    } catch (err) {
      return axiosFail('sending Telegram alert', err);
    }
  }

  async alertSend(params: {
    title: string;
    message: string;
    severity?: string;
    channel?: string;
  }): Promise<string> {
    if (!params?.title || !params?.message) {
      return encode(fail('alert.send requires { title, message }'));
    }
    const id = 'ALERT-' + String(this.alertCounter++);
    const alert = {
      id,
      title: params.title,
      message: params.message,
      severity: params.severity || 'info',
      channel: params.channel || 'all',
      status: 'sent',
      createdAt: new Date().toISOString()
    };
    this.alerts.set(id, alert);
    return encode(ok({ alert }, `created ${id}`));
  }

  async alertEmail(params: { to: string; subject: string; body: string }): Promise<string> {
    if (!params?.to || !params?.subject || !params?.body) {
      return encode(fail('alert.email requires { to, subject, body }'));
    }
    // SMTP integration would live here; for now we record the intent.
    const id = 'EMAIL-' + String(this.alertCounter++);
    const record = {
      id,
      type: 'email',
      to: params.to,
      subject: params.subject,
      body: params.body,
      status: 'recorded',
      createdAt: new Date().toISOString()
    };
    this.alerts.set(id, record);
    return encode(ok({ alert: record }, `email recorded → ${params.to}`));
  }

  async alertSlack(params: { webhook?: string; message: string; channel?: string }): Promise<string> {
    const webhookUrl = params.webhook || process.env.SLACK_WEBHOOK_URL;
    if (!webhookUrl) {
      return encode(fail('Slack webhook not configured. Set SLACK_WEBHOOK_URL or provide { webhook }.'));
    }
    if (!params?.message) return encode(fail('alert.slack requires { message }'));
    try {
      await axios.post(webhookUrl, { text: params.message, channel: params.channel }, { timeout: 10000 });
      return encode(ok({ channel: params.channel ?? null }, `slack → ${params.message.slice(0, 50)}`));
    } catch (error) {
      return axiosFail('sending to Slack', error);
    }
  }

  async alertDiscord(params: { webhook?: string; message: string }): Promise<string> {
    const webhookUrl = params.webhook || process.env.DISCORD_WEBHOOK_URL;
    if (!webhookUrl) {
      return encode(fail('Discord webhook not configured. Set DISCORD_WEBHOOK_URL or provide { webhook }.'));
    }
    if (!params?.message) return encode(fail('alert.discord requires { message }'));
    try {
      await axios.post(webhookUrl, { content: params.message }, { timeout: 10000 });
      return encode(ok({}, `discord → ${params.message.slice(0, 50)}`));
    } catch (error) {
      return axiosFail('sending to Discord', error);
    }
  }

  async alertWebhook(params: { url: string; method?: string; body?: string }): Promise<string> {
    if (!params?.url) return encode(fail('alert.webhook requires { url }'));
    const method = params.method || 'POST';
    let body: unknown;
    if (params.body) {
      try { body = JSON.parse(params.body); }
      catch { return encode(fail('alert.webhook { body } must be valid JSON', 'invalid body')); }
    }
    try {
      const response = await axios({
        method: method.toLowerCase(),
        url: params.url,
        data: body,
        timeout: 10000,
        headers: { 'Content-Type': 'application/json' }
      });
      return encode(ok(
        { status: response.status, statusText: response.statusText, url: params.url, method },
        `webhook ${method} → ${response.status}`
      ));
    } catch (error) {
      return axiosFail(`webhook ${method} ${params.url}`, error);
    }
  }

  async alertPagerDuty(params: { title: string; description?: string; urgency?: string }): Promise<string> {
    const apiKey = process.env.PAGERDUTY_API_KEY;
    const serviceId = process.env.PAGERDUTY_SERVICE_ID;
    if (!apiKey || !serviceId) {
      return encode(fail('PagerDuty not configured. Set PAGERDUTY_API_KEY and PAGERDUTY_SERVICE_ID.'));
    }
    if (!params?.title) return encode(fail('alert.pagerduty requires { title }'));
    try {
      const response = await axios.post(
        'https://events.pagerduty.com/v2/enqueue',
        {
          routing_key: serviceId,
          event_action: 'trigger',
          payload: {
            summary: params.title,
            severity: params.urgency || 'warning',
            source: 'itops-agents',
            custom_details: { description: params.description || '' }
          }
        },
        {
          headers: { Authorization: `Token token=${apiKey}`, 'Content-Type': 'application/json' },
          timeout: 10000
        }
      );
      return encode(ok(
        { dedupKey: response.data?.dedup_key, urgency: params.urgency || 'warning' },
        `pagerduty triggered: ${params.title}`
      ));
    } catch (error) {
      return axiosFail('triggering PagerDuty', error);
    }
  }

  async alertStatus(params: { alertId: string }): Promise<string> {
    if (!params?.alertId) return encode(fail('alert.status requires { alertId }'));
    const alert = this.alerts.get(params.alertId);
    if (!alert) return encode(fail(`alert not found: ${params.alertId}`));
    return encode(ok({ alert }, `alert ${params.alertId} status`));
  }

  async alertList(params: { limit?: number; severity?: string } = {}): Promise<string> {
    let allAlerts = Array.from(this.alerts.values());
    if (params.severity) {
      allAlerts = allAlerts.filter(a => a.severity === params.severity);
    }
    const limit = params.limit || 10;
    const recent = allAlerts.slice(-limit).reverse();
    return encode(ok(
      { alerts: recent, total: allAlerts.length, limit, severity: params.severity ?? null },
      `${recent.length} of ${allAlerts.length} alert(s)`
    ));
  }

  async alertConfig(params: { channel: string; config: any }): Promise<string> {
    if (!params?.channel) return encode(fail('alert.config requires { channel }'));
    // We don't actually persist config (would need a config store); return the
    // env-var name the operator needs to set. Mark explicitly as advisory.
    const envKey = params.channel.toUpperCase().replace(/-/g, '_') + '_WEBHOOK_URL';
    return encode(ok(
      { channel: params.channel, envVarToSet: envKey, providedConfig: params.config, note: 'advisory only — env var must still be set in the runtime' },
      `set ${envKey} to enable`
    ));
  }
}

import { AlertManager, Alert, NotificationChannel } from './AlertManager.js';
import * as https from 'https';
import * as http from 'http';

export class NotificationService {
  constructor(private alertManager: AlertManager) {
    this.alertManager.on('notify', ({ alert, channel }) => {
      this.dispatch(alert, channel).catch(err => {
        console.error('[NotificationService] Dispatch failed for channel ' + channel.name + ':', err.message);
      });
    });
  }

  async dispatch(alert: Alert, channel: NotificationChannel): Promise<void> {
    if (channel.type === 'slack') {
      await this.sendSlack(alert, channel);
    } else if (channel.type === 'webhook') {
      await this.sendWebhook(alert, channel);
    } else {
      console.log('[NotificationService] Channel type not implemented: ' + channel.type);
    }
  }

  private async sendSlack(alert: Alert, channel: NotificationChannel): Promise<void> {
    const webhookUrl = channel.config['webhookUrl'];
    if (!webhookUrl) {
      console.warn('[NotificationService] Slack channel missing webhookUrl');
      return;
    }

    const color = alert.severity === 'critical' ? '#FF0000' : alert.severity === 'warning' ? '#FFA500' : '#36A64F';
    const icon = alert.severity === 'critical' ? ':red_circle:' : alert.severity === 'warning' ? ':warning:' : ':information_source:';

    const payload = JSON.stringify({
      text: icon + ' *[' + alert.severity.toUpperCase() + ']* ' + alert.title,
      attachments: [{
        color,
        fields: [
          { title: 'Message', value: alert.message, short: false },
          { title: 'Source', value: alert.source, short: true },
          { title: 'Fired At', value: new Date(alert.firedAt).toISOString(), short: true },
          { title: 'Count', value: String(alert.count), short: true },
        ],
        footer: 'RightAPI Forge | Alert ID: ' + alert.id.slice(0, 8)
      }]
    });

    await this.post(webhookUrl, payload, { 'Content-Type': 'application/json' });
    console.log('[NotificationService] Slack notification sent: ' + alert.title);
  }

  private async sendWebhook(alert: Alert, channel: NotificationChannel): Promise<void> {
    const url = channel.config['url'];
    if (!url) {
      console.warn('[NotificationService] Webhook channel missing url');
      return;
    }

    const payload = JSON.stringify({
      id: alert.id,
      title: alert.title,
      message: alert.message,
      severity: alert.severity,
      status: alert.status,
      source: alert.source,
      labels: alert.labels,
      firedAt: alert.firedAt,
      count: alert.count
    });

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (channel.config['secret']) headers['X-Alert-Secret'] = channel.config['secret'];

    await this.post(url, payload, headers);
    console.log('[NotificationService] Webhook notification sent: ' + alert.title);
  }

  private post(url: string, body: string, headers: Record<string, string>): Promise<void> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const lib = parsed.protocol === 'https:' ? https : http;

      const req = lib.request({
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: { ...headers, 'Content-Length': Buffer.byteLength(body) }
      }, (res) => {
        res.resume();
        res.on('end', resolve);
      });

      req.on('error', reject);
      req.setTimeout(5000, () => { req.destroy(new Error('timeout')); });
      req.write(body);
      req.end();
    });
  }
}

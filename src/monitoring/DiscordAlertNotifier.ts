import axios from 'axios';
import type { OpsAlert } from './OperationalInsightsService.js';

export class DiscordAlertNotifier {
  private readonly lastSentAt = new Map<string, number>();

  constructor(
    private readonly webhookUrl: string,
    private readonly cooldownMs: number = 15 * 60 * 1000,
    private readonly minimumSeverity: 'warning' | 'high' | 'critical' = 'high'
  ) {}

  async notify(alert: OpsAlert): Promise<boolean> {
    if (!this.webhookUrl) {
      return false;
    }

    if (!this.shouldSend(alert)) {
      return false;
    }

    const key = `${alert.id}:${alert.status}:${alert.severity}`;
    const now = Date.now();
    const lastSent = this.lastSentAt.get(key) || 0;
    if (now - lastSent < this.cooldownMs) {
      return false;
    }

    const payload = {
      content: this.formatMessage(alert)
    };

    await axios.post(this.webhookUrl, payload, { timeout: 10000 });
    this.lastSentAt.set(key, now);
    return true;
  }

  private shouldSend(alert: OpsAlert): boolean {
    if (alert.status !== 'open') {
      return false;
    }
    return this.severityRank(alert.severity) >= this.severityRank(this.minimumSeverity);
  }

  private severityRank(severity: 'warning' | 'high' | 'critical' | 'info'): number {
    return {
      info: 0,
      warning: 1,
      high: 2,
      critical: 3
    }[severity];
  }

  private formatMessage(alert: OpsAlert): string {
    const emoji = alert.severity === 'critical'
      ? '🚨'
      : alert.severity === 'high'
        ? '⚠️'
        : 'ℹ️';

    return [
      `${emoji} **ITOPS Alert: ${alert.title}**`,
      `Severity: ${alert.severity}`,
      `Source: ${alert.source}`,
      `Status: ${alert.status}`,
      alert.taskId ? `Task: ${alert.taskId}` : null,
      alert.agentId ? `Agent: ${alert.agentId}` : null,
      '',
      alert.message
    ].filter(Boolean).join('\n');
  }
}

/**
 * TeamsProvider — sends Adaptive Cards to MS Teams via Incoming Webhooks
 *
 * Docs: https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook
 */

export interface TeamsCard {
  type: 'message';
  attachments: Array<{
    contentType: 'application/vnd.microsoft.card.adaptive';
    content: Record<string, unknown>;
  }>;
}

export interface IncidentPayload {
  id: string;
  title: string;
  severity: string;
  status: string;
  assignedTo?: string;
  url?: string;
  updatedAt?: string;
}

export class TeamsProvider {
  private static SEVERITY_COLOR: Record<string, string> = {
    critical: 'attention',
    high:     'warning',
    medium:   'accent',
    low:      'good',
    info:     'default',
  };

  /** Low-level send — POSTs a Teams message payload to a webhook URL */
  async send(webhookUrl: string, payload: Record<string, unknown>): Promise<void> {
    const resp = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`Teams webhook failed ${resp.status}: ${body}`);
    }
  }

  /** Send a plain text message */
  async sendText(webhookUrl: string, text: string): Promise<void> {
    return this.send(webhookUrl, { type: 'message', text });
  }

  /** Send an Adaptive Card */
  async sendCard(webhookUrl: string, cardBody: unknown[]): Promise<void> {
    return this.send(webhookUrl, {
      type: 'message',
      attachments: [{
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          body: cardBody,
        },
      }],
    });
  }

  /** Incident alert card — created / updated / resolved */
  async sendIncidentCard(webhookUrl: string, incident: IncidentPayload, event: 'created' | 'updated' | 'resolved' | 'escalated'): Promise<void> {
    const color = TeamsProvider.SEVERITY_COLOR[incident.severity?.toLowerCase()] ?? 'default';
    const icon = event === 'resolved' ? '✅' : event === 'escalated' ? '🔺' : event === 'created' ? '🚨' : '🔄';
    const title = `${icon} Incident ${event.charAt(0).toUpperCase() + event.slice(1)}: ${incident.title}`;

    const facts = [
      { title: 'Severity', value: incident.severity ?? 'unknown' },
      { title: 'Status',   value: incident.status ?? 'unknown' },
    ];
    if (incident.assignedTo) facts.push({ title: 'Assigned To', value: incident.assignedTo });
    if (incident.updatedAt) facts.push({ title: 'Time', value: new Date(incident.updatedAt).toLocaleString() });

    const body: unknown[] = [
      { type: 'TextBlock', text: title, weight: 'Bolder', size: 'Medium', color },
      { type: 'FactSet', facts },
    ];

    if (incident.url) {
      body.push({
        type: 'ActionSet',
        actions: [{ type: 'Action.OpenUrl', title: 'View Incident', url: incident.url }],
      });
    }

    return this.sendCard(webhookUrl, body);
  }

  /** SLA breach notification card */
  async sendSLABreachCard(webhookUrl: string, incident: IncidentPayload, minutesOverdue: number): Promise<void> {
    const body: unknown[] = [
      { type: 'TextBlock', text: `⏰ SLA Breach: ${incident.title}`, weight: 'Bolder', size: 'Medium', color: 'attention' },
      {
        type: 'FactSet',
        facts: [
          { title: 'Overdue By', value: `${minutesOverdue} minutes` },
          { title: 'Severity',   value: incident.severity ?? 'unknown' },
          { title: 'Status',     value: incident.status ?? 'unknown' },
          { title: 'Incident ID', value: incident.id },
        ],
      },
    ];
    if (incident.url) {
      body.push({
        type: 'ActionSet',
        actions: [{ type: 'Action.OpenUrl', title: 'View Incident', url: incident.url }],
      });
    }
    return this.sendCard(webhookUrl, body);
  }

  /** Agent chat reply card */
  async sendAgentReplyCard(webhookUrl: string, reply: string, agentName: string, userQuery: string): Promise<void> {
    const body: unknown[] = [
      { type: 'TextBlock', text: `🤖 ${agentName}`, weight: 'Bolder', size: 'Small', color: 'accent' },
      { type: 'TextBlock', text: `> ${userQuery}`, isSubtle: true, size: 'Small', wrap: true },
      { type: 'TextBlock', text: reply, wrap: true },
    ];
    return this.sendCard(webhookUrl, body);
  }

  /** Alert rule fired card */
  async sendAlertCard(webhookUrl: string, alertMsg: string, host?: string, metric?: string): Promise<void> {
    const body: unknown[] = [
      { type: 'TextBlock', text: `⚠️ Alert Fired`, weight: 'Bolder', size: 'Medium', color: 'warning' },
      { type: 'TextBlock', text: alertMsg, wrap: true },
    ];
    if (host || metric) {
      const facts = [];
      if (host)   facts.push({ title: 'Host',   value: host });
      if (metric) facts.push({ title: 'Metric', value: metric });
      body.push({ type: 'FactSet', facts });
    }
    return this.sendCard(webhookUrl, body);
  }

  /** Test connectivity — sends a simple ping card */
  async testConnection(webhookUrl: string): Promise<{ ok: boolean; message: string }> {
    try {
      await this.sendCard(webhookUrl, [
        { type: 'TextBlock', text: '✅ IT Ops — Teams integration connected!', weight: 'Bolder', color: 'good' },
        { type: 'TextBlock', text: 'Your alerts and agent chat are now active.', isSubtle: true },
      ]);
      return { ok: true, message: 'Test message sent successfully' };
    } catch (err: any) {
      return { ok: false, message: err?.message ?? String(err) };
    }
  }
}

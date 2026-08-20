import * as fs from 'fs';
import * as path from 'path';
import { SmtpService } from './SmtpService.js';
import { logger } from '../utils/logger.js';

export interface ReportSchedule {
  enabled: boolean;
  frequency: 'daily' | 'weekly';
  dayOfWeek?: number;  // 0-6, for weekly (0=Sunday)
  hour: number;        // 0-23
  recipients: string[];
  includeIncidents: boolean;
  includeAgentHealth: boolean;
  includeOpenTasks: boolean;
}

const SCHEDULE_PATH = '/data/itops-agents/report-schedule.json';

const DEFAULT_SCHEDULE: ReportSchedule = {
  enabled: false,
  frequency: 'daily',
  dayOfWeek: 1,
  hour: 8,
  recipients: [],
  includeIncidents: true,
  includeAgentHealth: true,
  includeOpenTasks: true,
};

export class ReportsScheduler {
  private smtpService: SmtpService;
  private lastSentHour: number = -1;
  private lastSentDay: number = -1;

  constructor(smtpService: SmtpService) {
    this.smtpService = smtpService;
  }

  loadSchedule(): ReportSchedule {
    try {
      const data = fs.readFileSync(SCHEDULE_PATH, 'utf8');
      return { ...DEFAULT_SCHEDULE, ...(JSON.parse(data) as Partial<ReportSchedule>) };
    } catch {
      return { ...DEFAULT_SCHEDULE };
    }
  }

  saveSchedule(schedule: ReportSchedule): void {
    fs.mkdirSync(path.dirname(SCHEDULE_PATH), { recursive: true });
    fs.writeFileSync(SCHEDULE_PATH, JSON.stringify(schedule, null, 2), 'utf8');
  }

  generateReport(
    schedule: ReportSchedule,
    incidentList: any[],
    agentList: any[],
    taskStats: { pending: number; inProgress: number; completed: number },
  ): string {
    const now = new Date();
    const windowLabel = schedule.frequency === 'daily' ? 'Last 24 Hours' : 'Last 7 Days';
    const windowMs = schedule.frequency === 'daily' ? 86_400_000 : 7 * 86_400_000;
    const since = now.getTime() - windowMs;

    const sections: string[] = [];

    if (schedule.includeIncidents) {
      const recent = incidentList.filter(i => new Date(i.createdAt).getTime() >= since);
      const openCount = recent.filter(i => i.status === 'open' || i.status === 'investigating').length;
      const closedCount = recent.filter(i => i.status === 'resolved' || i.status === 'closed').length;
      const criticalCount = recent.filter(i => i.severity === 'critical').length;
      const highCount = recent.filter(i => i.severity === 'high').length;

      const rows = recent.slice(0, 20).map(i => `
        <tr>
          <td style="padding:6px 10px;border-bottom:1px solid #e2e8f0">${escHtml(i.id)}</td>
          <td style="padding:6px 10px;border-bottom:1px solid #e2e8f0">${escHtml(i.title)}</td>
          <td style="padding:6px 10px;border-bottom:1px solid #e2e8f0">${escHtml(i.severity)}</td>
          <td style="padding:6px 10px;border-bottom:1px solid #e2e8f0">${escHtml(i.status)}</td>
          <td style="padding:6px 10px;border-bottom:1px solid #e2e8f0">${escHtml(new Date(i.createdAt).toLocaleString())}</td>
        </tr>`).join('');

      sections.push(`
        <h2 style="color:#1e293b;margin:24px 0 8px">📋 Incidents Summary (${windowLabel})</h2>
        <p style="margin:0 0 12px;color:#475569">
          <strong>${recent.length}</strong> total &nbsp;|&nbsp;
          <strong>${openCount}</strong> open &nbsp;|&nbsp;
          <strong>${closedCount}</strong> resolved &nbsp;|&nbsp;
          <strong style="color:#dc2626">${criticalCount}</strong> critical &nbsp;|&nbsp;
          <strong style="color:#ea580c">${highCount}</strong> high
        </p>
        ${recent.length > 0 ? `
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead>
            <tr style="background:#f1f5f9">
              <th style="padding:8px 10px;text-align:left;border-bottom:2px solid #e2e8f0">ID</th>
              <th style="padding:8px 10px;text-align:left;border-bottom:2px solid #e2e8f0">Title</th>
              <th style="padding:8px 10px;text-align:left;border-bottom:2px solid #e2e8f0">Severity</th>
              <th style="padding:8px 10px;text-align:left;border-bottom:2px solid #e2e8f0">Status</th>
              <th style="padding:8px 10px;text-align:left;border-bottom:2px solid #e2e8f0">Created</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>` : '<p style="color:#64748b">No incidents in this period.</p>'}
      `);
    }

    if (schedule.includeAgentHealth) {
      const agentRows = agentList.map(a => {
        const statusColor = a.status === 'online' || a.status === 'active' ? '#16a34a' :
                            a.status === 'idle' ? '#ca8a04' : '#dc2626';
        return `
          <tr>
            <td style="padding:6px 10px;border-bottom:1px solid #e2e8f0">${escHtml(a.name || a.id)}</td>
            <td style="padding:6px 10px;border-bottom:1px solid #e2e8f0">${escHtml(a.role || '—')}</td>
            <td style="padding:6px 10px;border-bottom:1px solid #e2e8f0;color:${statusColor}">${escHtml(a.status || 'unknown')}</td>
          </tr>`;
      }).join('');

      sections.push(`
        <h2 style="color:#1e293b;margin:24px 0 8px">🤖 Agent Health</h2>
        ${agentList.length > 0 ? `
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead>
            <tr style="background:#f1f5f9">
              <th style="padding:8px 10px;text-align:left;border-bottom:2px solid #e2e8f0">Agent</th>
              <th style="padding:8px 10px;text-align:left;border-bottom:2px solid #e2e8f0">Role</th>
              <th style="padding:8px 10px;text-align:left;border-bottom:2px solid #e2e8f0">Status</th>
            </tr>
          </thead>
          <tbody>${agentRows}</tbody>
        </table>` : '<p style="color:#64748b">No agents configured.</p>'}
      `);
    }

    if (schedule.includeOpenTasks) {
      sections.push(`
        <h2 style="color:#1e293b;margin:24px 0 8px">📌 Task Queue</h2>
        <p style="margin:0;color:#475569">
          <strong>${taskStats.pending}</strong> pending &nbsp;|&nbsp;
          <strong>${taskStats.inProgress}</strong> in progress &nbsp;|&nbsp;
          <strong>${taskStats.completed}</strong> completed
        </p>
      `);
    }

    return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>RightAPI Forge — Scheduled Report</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f8fafc;margin:0;padding:0">
  <div style="max-width:800px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.1)">
    <div style="background:#1e293b;padding:24px 32px">
      <h1 style="color:#fff;margin:0;font-size:20px">RightAPI Forge — Scheduled Report</h1>
      <p style="color:#94a3b8;margin:6px 0 0;font-size:13px">
        Generated: ${now.toLocaleString()} &nbsp;|&nbsp; Period: ${windowLabel}
      </p>
    </div>
    <div style="padding:24px 32px">
      ${sections.join('')}
    </div>
    <div style="padding:16px 32px;border-top:1px solid #e2e8f0;color:#94a3b8;font-size:12px">
      This is an automated report from RightAPI Forge.
    </div>
  </div>
</body>
</html>`;
  }

  async sendReport(
    schedule: ReportSchedule,
    incidentList: any[],
    agentList: any[],
    taskStats: { pending: number; inProgress: number; completed: number },
  ): Promise<void> {
    const html = this.generateReport(schedule, incidentList, agentList, taskStats);
    const subject = `RightAPI Forge — Scheduled Report (${schedule.frequency === 'daily' ? 'Daily' : 'Weekly'})`;
    await this.smtpService.sendHtmlReport(subject, html, schedule.recipients);
  }

  start(
    getIncidents: () => any[],
    getAgents: () => any[],
    getTaskStats: () => { pending: number; inProgress: number; completed: number },
  ): void {
    setInterval(() => {
      const schedule = this.loadSchedule();
      if (!schedule.enabled || schedule.recipients.length === 0) return;

      const now = new Date();
      const currentHour = now.getHours();
      const currentDay = now.getDay();
      const currentDate = now.getDate();

      if (schedule.frequency === 'daily') {
        // Fire once per day at the configured hour
        if (currentHour !== schedule.hour) return;
        if (this.lastSentDay === currentDate && this.lastSentHour === currentHour) return;
        this.lastSentDay = currentDate;
        this.lastSentHour = currentHour;
      } else {
        // Weekly: check day of week and hour
        if (currentDay !== (schedule.dayOfWeek ?? 1)) return;
        if (currentHour !== schedule.hour) return;
        if (this.lastSentDay === currentDate && this.lastSentHour === currentHour) return;
        this.lastSentDay = currentDate;
        this.lastSentHour = currentHour;
      }

      const incidents = getIncidents();
      const agents = getAgents();
      const taskStats = getTaskStats();

      this.sendReport(schedule, incidents, agents, taskStats).catch(err => {
        logger.error('[ReportsScheduler] Failed to send report:', { err: err instanceof Error ? err.message : String(err) });
      });
    }, 60_000);
  }
}

function escHtml(str: string): string {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

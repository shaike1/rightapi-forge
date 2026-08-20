// Shared types for the report subsystem.
//
// Kept in a separate file from the generator + scheduler so:
//   - The frontend can import the structural shape via the API contract.
//   - Tests can build fixtures without dragging in the full ReportGenerator
//     dependency graph.

import type { IncidentSeverity } from '../persistence/SqliteStore.js';
import type { SlaMetrics } from '../sla/SLAEngine.js';

export type ReportType = 'daily_summary' | 'weekly_report' | 'monthly_report';
export type ReportFormat = 'html' | 'markdown' | 'json';
export type ChannelKind = 'chat' | 'telegram' | 'webhook' | 'email';

export interface ReportData {
  type: ReportType;
  generatedAt: string;
  period: {
    since: string;
    until: string;
    label: string; // e.g. "Last 24 hours"
  };

  incidents: {
    createdInPeriod: number;
    resolvedInPeriod: number;
    activeAtEnd: number;
    activeBySeverity: Record<IncidentSeverity, number>;
    /** Top recurring incidents by title prefix — quick triage signal. */
    topRecurring: Array<{ title: string; count: number }>;
  };

  sla: {
    overall: SlaMetrics;
    bySeverity: Record<IncidentSeverity, SlaMetrics>;
    activeBreaches: number;
  };

  servers: {
    monitored: number;
    /** Per-server average health from the metric history table over the
     *  period — operator-facing capacity-planning signal. */
    healthSnapshots: Array<{
      serverId: string;
      name: string;
      avgCpu: number | null;
      avgMemory: number | null;
      avgDisk: number | null;
      lastCheckStatus: string;
    }>;
  };

  postMortems: {
    createdInPeriod: number;
    recent: Array<{
      id: string;
      incidentId: string;
      title: string;
      severity: string;
      createdAt: string;
    }>;
  };

  runbooks: {
    runsInPeriod: number;
    byStatus: Record<string, number>;
    /** Top runbooks invoked. */
    top: Array<{ templateId: string; templateName: string; runs: number }>;
  };
}

/** Delivery channel descriptor saved on a report schedule row. */
export interface DeliveryChannel {
  type: ChannelKind;
  /** Shape varies by channel:
   *    chat:    {}                                — broadcasts to all WS clients
   *    telegram: { chatId?: string }              — defaults to env TELEGRAM_CHAT_ID
   *    webhook: { url: string, headers?: object } — POSTs JSON to url
   *    email:   { to: string[] }                  — uses SmtpService.sendHtmlReport
   */
  config: Record<string, unknown>;
}

export interface ReportSchedule {
  id: string;
  name: string;
  reportType: ReportType;
  cronExpression: string;
  channels: DeliveryChannel[];
  enabled: boolean;
  lastRun: string | null;
  nextRun: string | null;
  lastError: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReportHistoryEntry {
  id: string;
  reportType: ReportType;
  generatedAt: string;
  triggeredBy: string;       // 'cron:<scheduleId>' | 'api:<username>'
  scheduleId: string | null;
  /** Markdown body — small enough to keep in SQLite, useful for the
   *  history page preview without recomputing. HTML/JSON formats are
   *  rendered on demand from the saved JSON. */
  summary: string;
  /** Full JSON payload of the ReportData — re-renderable into any format. */
  data: ReportData;
  /** Per-channel delivery result. Same shape across channels for the UI. */
  deliveries: Array<{
    channel: ChannelKind;
    ok: boolean;
    detail?: string;
  }>;
}

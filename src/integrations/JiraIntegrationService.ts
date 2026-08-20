import { Incident, SqliteIncidentStore } from '../persistence/SqliteStore';
import { logger } from '../utils/logger.js';

type SkillExecutor = (command: string, params?: Record<string, unknown>) => Promise<string>;

export interface JiraTicket {
  key: string;
  summary: string;
  description: string;
  status: string;
  priority: string;
  assignee: string | null;
  reporter: string | null;
  created: string;
  updated: string;
  project: string;
  issueType: string;
  url: string;
  labels: string[];
  comments: Array<{ author: string; body: string; created: string }>;
  linkedIncidentId?: string;
}

export interface JiraSyncStatus {
  enabled: boolean;
  lastPolledAt: string | null;
  lastTicketCount: number;
  nextPollAt: string | null;
  pollIntervalMinutes: number;
}

export class JiraIntegrationService {
  private static instance: JiraIntegrationService;
  private skillExecutor?: SkillExecutor;
  private store?: SqliteIncidentStore;

  private readonly defaultProject: string;
  private readonly issueType: string;
  private readonly baseUrl: string;
  private readonly enabled: boolean;

  private pollIntervalMinutes: number;
  private autoImport: boolean;
  private syncJql: string;
  private lastPolledAt: string | null = null;
  private lastTicketCount = 0;
  private pollTimer: NodeJS.Timeout | null = null;

  private constructor() {
    this.defaultProject = process.env.JIRA_DEFAULT_PROJECT || 'OPS';
    this.issueType = process.env.JIRA_INCIDENT_ISSUE_TYPE || 'Incident';
    this.baseUrl = process.env.JIRA_BASE_URL || '';
    // Only enabled if all 3 required vars are set
    this.enabled = !!(process.env.JIRA_BASE_URL && process.env.JIRA_EMAIL && process.env.JIRA_API_TOKEN);
    this.pollIntervalMinutes = parseInt(process.env.JIRA_POLL_INTERVAL_MINUTES || '15', 10);
    this.autoImport = process.env.JIRA_AUTO_IMPORT !== 'false'; // default true
    this.syncJql = process.env.JIRA_SYNC_JQL || ''; // empty = use default
    if (this.enabled) {
      logger.info(`[JiraIntegration] Enabled — project=${this.defaultProject}, issueType=${this.issueType}`);
    } else {
      logger.info('[JiraIntegration] Disabled — set JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN to enable');
    }
  }

  static getInstance(): JiraIntegrationService {
    if (!JiraIntegrationService.instance) {
      JiraIntegrationService.instance = new JiraIntegrationService();
    }
    return JiraIntegrationService.instance;
  }

  setSkillExecutor(executor: SkillExecutor): void {
    this.skillExecutor = executor;
  }

  setStore(store: SqliteIncidentStore): void {
    this.store = store;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  // Map incident severity to Jira priority
  private severityToPriority(severity: string): string {
    switch (severity) {
      case 'critical': return 'Highest';
      case 'high':     return 'High';
      case 'medium':   return 'Medium';
      default:         return 'Low';
    }
  }

  // Map incident status to Jira transition name
  private statusToTransition(status: string): string | null {
    switch (status) {
      case 'investigating': return 'In Progress';
      case 'mitigating':    return 'In Progress';
      case 'resolved':      return 'Resolved';
      case 'closed':        return 'Done';
      default:              return null;
    }
  }

  async createTicketForIncident(incident: Incident, jiraProject?: string): Promise<string | null> {
    if (!this.enabled || !this.skillExecutor) return null;

    try {
      const project = jiraProject || this.defaultProject;
      const description = [
        incident.description,
        '',
        `Incident ID: ${incident.id}`,
        `Severity: ${incident.severity}`,
        `Source: ${incident.source}`,
        incident.sourceRef ? `Source Ref: ${incident.sourceRef}` : '',
        `Created: ${incident.createdAt}`,
      ].filter(Boolean).join('\n');

      const result = await this.skillExecutor('jira.create', {
        projectKey: project,
        issueType: this.issueType,
        summary: `[${incident.severity.toUpperCase()}] ${incident.title}`,
        description,
        priority: this.severityToPriority(incident.severity),
      });

      // Extract issue key from result (e.g. "Created issue OPS-123")
      const match = result.match(/([A-Z]+-\d+)/);
      if (match) {
        const jiraKey = match[1];
        const jiraUrl = this.baseUrl ? `${this.baseUrl}/browse/${jiraKey}` : '';
        // Persist jiraKey back to incident
        this.store?.updateJiraKey(incident.id, jiraKey, jiraUrl);
        logger.info(`[JiraIntegration] Created ticket ${jiraKey} for incident ${incident.id}`);
        return jiraKey;
      }

      logger.warn('[JiraIntegration] Could not extract issue key from:', { result });
      return null;
    } catch (e) {
      logger.error('[JiraIntegration] Failed to create ticket:', { err: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined });
      return null;
    }
  }

  async addCommentToTicket(jiraKey: string, comment: string): Promise<boolean> {
    if (!this.enabled || !this.skillExecutor || !jiraKey) return false;
    try {
      await this.skillExecutor('jira.comment', { issueKey: jiraKey, comment });
      return true;
    } catch (e) {
      logger.error('[JiraIntegration] Failed to add comment:', { err: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined });
      return false;
    }
  }

  async transitionTicket(jiraKey: string, incidentStatus: string): Promise<boolean> {
    if (!this.enabled || !this.skillExecutor || !jiraKey) return false;
    const transition = this.statusToTransition(incidentStatus);
    if (!transition) return false;
    try {
      // Note: jira.transition requires transitionId not name — we pass the name and let JiraSkill handle it
      // In practice, operators set up transitions; we do a best-effort call
      await this.skillExecutor('jira.update', {
        issueKey: jiraKey,
        fields: { status: transition },
      });
      return true;
    } catch (e) {
      logger.error('[JiraIntegration] Failed to transition ticket:', { err: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined });
      return false;
    }
  }

  // ── READ / POLLING ─────────────────────────────────────────────────────────

  private mapRawToTicket(raw: Record<string, any>, key: string): JiraTicket {
    const fields = raw.fields ?? {};
    const comments: Array<{ author: string; body: string; created: string }> =
      (fields.comment?.comments ?? []).map((c: any) => ({
        author: c.author?.displayName ?? '',
        body: c.body ?? '',
        created: c.created ?? '',
      }));
    return {
      key,
      summary: fields.summary ?? '',
      description: fields.description ?? '',
      status: fields.status?.name ?? '',
      priority: fields.priority?.name ?? '',
      assignee: fields.assignee?.displayName ?? null,
      reporter: fields.reporter?.displayName ?? null,
      created: fields.created ?? '',
      updated: fields.updated ?? '',
      project: fields.project?.key ?? '',
      issueType: fields.issuetype?.name ?? '',
      url: `${this.baseUrl}/browse/${key}`,
      labels: Array.isArray(fields.labels) ? fields.labels : [],
      comments,
    };
  }

  async getTickets(jql: string, maxResults = 50): Promise<JiraTicket[]> {
    if (!this.enabled || !this.skillExecutor) return [];
    try {
      const result = await this.skillExecutor('jira.search', { jql, maxResults });
      let parsed: any;
      try {
        parsed = JSON.parse(result);
      } catch {
        logger.warn('[JiraIntegration] jira.search returned non-JSON response');
        return [];
      }
      const issues: any[] = Array.isArray(parsed) ? parsed : (parsed.issues ?? []);
      return issues.map((issue: any) => this.mapRawToTicket(issue, issue.key ?? ''));
    } catch (e) {
      logger.error('[JiraIntegration] getTickets failed:', { err: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined });
      return [];
    }
  }

  async getTicket(key: string): Promise<JiraTicket | null> {
    if (!this.enabled || !this.skillExecutor) return null;
    try {
      const result = await this.skillExecutor('jira.get', { issueKey: key });
      let parsed: any;
      try {
        parsed = JSON.parse(result);
      } catch {
        logger.warn('[JiraIntegration] jira.get returned non-JSON response for', { key });
        return null;
      }
      return this.mapRawToTicket(parsed, parsed.key ?? key);
    } catch (e) {
      logger.error('[JiraIntegration] getTicket failed:', { err: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined });
      return null;
    }
  }

  async searchTickets(query: string, project?: string): Promise<JiraTicket[]> {
    const jql = project
      ? `project=${project} AND text ~ "${query}" ORDER BY updated DESC`
      : `text ~ "${query}" ORDER BY updated DESC`;
    return this.getTickets(jql);
  }

  private priorityToSeverity(priority: string): string {
    switch (priority.toLowerCase()) {
      case 'highest':
      case 'critical': return 'critical';
      case 'high':     return 'high';
      case 'medium':   return 'medium';
      default:         return 'low';
    }
  }

  async importTicket(
    key: string,
    incidentManager: any,
  ): Promise<{ incident: any; alreadyExisted: boolean } | null> {
    try {
      // Check if already imported
      if (this.store) {
        const existing = this.store.list().find((inc: Incident) => inc.jiraKey === key);
        if (existing) {
          return { incident: existing, alreadyExisted: true };
        }
      }

      const ticket = await this.getTicket(key);
      if (!ticket) return null;

      const incident = await incidentManager.create({
        title: ticket.summary,
        description: ticket.description,
        severity: this.priorityToSeverity(ticket.priority),
        source: 'jira',
        sourceRef: key,
      });

      this.store?.updateJiraKey(incident.id, key, ticket.url);
      logger.info(`[JiraIntegration] Imported ticket ${key} as incident ${incident.id}`);
      return { incident, alreadyExisted: false };
    } catch (e) {
      logger.error('[JiraIntegration] importTicket failed:', { err: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined });
      return null;
    }
  }

  async pollForUpdates(incidentManager: any): Promise<number> {
    if (!this.enabled) return 0;
    try {
      const jql = this.syncJql
        ? this.syncJql
        : `project=${this.defaultProject} AND updated >= "-${this.pollIntervalMinutes}m" ORDER BY updated DESC`;

      const tickets = await this.getTickets(jql, 100);
      let imported = 0;

      for (const ticket of tickets) {
        const alreadyImported = this.store
          ? this.store.list().some((inc: Incident) => inc.jiraKey === ticket.key)
          : false;
        if (alreadyImported) continue;

        if (this.autoImport) {
          const result = await this.importTicket(ticket.key, incidentManager);
          if (result && !result.alreadyExisted) imported++;
        }
      }

      this.lastPolledAt = new Date().toISOString();
      this.lastTicketCount = tickets.length;
      return imported;
    } catch (e) {
      logger.error('[JiraIntegration] pollForUpdates failed:', { err: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined });
      return 0;
    }
  }

  startPolling(incidentManager: any, onComplete?: (count: number) => void): void {
    if (!this.enabled || this.pollTimer) return;

    const run = () => {
      this.pollForUpdates(incidentManager)
        .then(count => onComplete?.(count))
        .catch(e => logger.error('[JiraIntegration] Poll error:', { err: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined }));
    };

    run(); // immediate first run
    this.pollTimer = setInterval(run, this.pollIntervalMinutes * 60 * 1000);
    logger.info(`[JiraIntegration] Polling started — interval=${this.pollIntervalMinutes}m`);
  }

  stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
      logger.info('[JiraIntegration] Polling stopped');
    }
  }

  getSyncStatus(): JiraSyncStatus {
    const nextPollAt =
      this.pollTimer && this.lastPolledAt
        ? new Date(
            new Date(this.lastPolledAt).getTime() + this.pollIntervalMinutes * 60 * 1000,
          ).toISOString()
        : null;
    return {
      enabled: this.enabled,
      lastPolledAt: this.lastPolledAt,
      lastTicketCount: this.lastTicketCount,
      nextPollAt,
      pollIntervalMinutes: this.pollIntervalMinutes,
    };
  }
}

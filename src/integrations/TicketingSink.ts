import { logger } from '../utils/logger.js';
import type { Incident, IncidentStore } from '../persistence/interfaces.js';
import type { JiraIntegrationService } from './JiraIntegrationService.js';
import { GitHubIssuesService, type GitHubConfig } from './GitHubIssuesService.js';
import { withSpan } from '../observability/Telemetry.js';
import { ticketingSyncTotal } from '../observability/Metrics.js';

export interface TicketingSinkDeps {
  getJiraService?: () => JiraIntegrationService | null;
  getGitHubConfig?: () => GitHubConfig;
  store: IncidentStore;
}

/** 
 * Responsible for syncing resolved incidents to an external ticketing system
 * for compliance tracking. Preferentially uses Jira if configured; falls back
 * to GitHub Issues if configured.
 * 
 * Supports idempotency: relies on the store's markTicketingSynced to ensure
 * a sync runs only once per resolution.
 */
export class TicketingSink {
  private githubService: GitHubIssuesService | null = null;
  private githubConfigured = false;
  private readonly inFlight = new Set<string>();

  constructor(private readonly deps: TicketingSinkDeps) {
    const ghConfig = deps.getGitHubConfig?.();
    if (ghConfig && ghConfig.enabled && ghConfig.token && ghConfig.owner && ghConfig.repo) {
      this.githubService = new GitHubIssuesService(ghConfig);
      this.githubConfigured = true;
    }
  }

  async syncResolvedIncident(incident: Incident): Promise<boolean> {
    return withSpan('TicketingSink.syncResolvedIncident', async (span) => {
      if (incident.status !== 'resolved' && incident.status !== 'closed') {
        ticketingSyncTotal.inc({ system: 'none', status: 'ignored_unresolved' });
        span.setAttribute('ticketing.outcome', 'ignored_unresolved');
        return false;
      }

      const persisted = typeof this.deps.store.get === 'function'
        ? await Promise.resolve(this.deps.store.get(incident.id))
        : null;
      if (incident.ticketingSynced || persisted?.ticketingSynced || this.inFlight.has(incident.id)) {
        ticketingSyncTotal.inc({ system: 'none', status: 'ignored_already_synced' });
        span.setAttribute('ticketing.outcome', 'ignored_already_synced');
        return false;
      }

      this.inFlight.add(incident.id);
      let system = 'none';
      try {
        const timeline = await Promise.resolve(this.deps.store.getTimeline(incident.id)) || [];
        const resolveNote = timeline
          .slice()
          .reverse()
          .find(t => t.type === 'resolved' || t.message.toLowerCase().includes('resolved'));
        const resolutionText = resolveNote ? resolveNote.message : 'Resolved without detail.';
        const syncText = `Incident Resolved.\n\nResolution: ${resolutionText}`;

        const jiraService = this.deps.getJiraService?.();
        if (jiraService?.isEnabled()) {
          system = 'jira';
          let jiraKey = incident.jiraKey || persisted?.jiraKey;
          if (!jiraKey) {
            jiraKey = await jiraService.createTicketForIncident(incident);
            if (jiraKey) {
              const refreshed = typeof this.deps.store.get === 'function'
                ? await Promise.resolve(this.deps.store.get(incident.id))
                : null;
              await Promise.resolve(this.deps.store.updateJiraKey(incident.id, jiraKey, refreshed?.jiraUrl || incident.jiraUrl || ''));
              incident.jiraKey = jiraKey;
            }
          }
          if (jiraKey) {
            const transitioned = await jiraService.transitionTicket(jiraKey, 'resolved');
            const commented = await jiraService.addCommentToTicket(jiraKey, syncText);
            if (transitioned === false || commented === false) {
              ticketingSyncTotal.inc({ system, status: 'error' });
              span.setAttributes({ 'ticketing.system': system, 'ticketing.outcome': 'error' });
              return false;
            }
            await Promise.resolve(this.deps.store.markTicketingSynced(incident.id));
            incident.ticketingSynced = true;
            ticketingSyncTotal.inc({ system: 'jira', status: 'success' });
            span.setAttributes({ 'ticketing.system': system, 'ticketing.outcome': 'success' });
            logger.info('[TicketingSink] synced incident resolution', { incidentId: incident.id, jiraKey, system });
            return true;
          }
        }

        if (this.githubConfigured && this.githubService) {
          system = 'github';
          let issueNumber = incident.githubIssueNumber || persisted?.githubIssueNumber;
          if (!issueNumber) {
            const issue = await this.githubService.createIssue({
              title: `[Resolved] ${incident.title}`,
              body: `Incident ID: ${incident.id}\nSeverity: ${incident.severity}\nSource: ${incident.source}\n\n**Description**\n${incident.description}\n\n**Resolution**\n${resolutionText}`,
              labels: ['incident', incident.severity]
            });
            if (!issue) {
              ticketingSyncTotal.inc({ system, status: 'error' });
              span.setAttributes({ 'ticketing.system': system, 'ticketing.outcome': 'error' });
              return false;
            }
            issueNumber = issue.number;
            await Promise.resolve(this.deps.store.updateGitHubIssueNumber(incident.id, issueNumber));
            incident.githubIssueNumber = issueNumber;
          }

          if (await this.githubService.closeIssue(issueNumber)) {
            await Promise.resolve(this.deps.store.markTicketingSynced(incident.id, issueNumber));
            incident.ticketingSynced = true;
            ticketingSyncTotal.inc({ system: 'github', status: 'success' });
            span.setAttributes({ 'ticketing.system': system, 'ticketing.outcome': 'success' });
            logger.info('[TicketingSink] synced incident resolution', { incidentId: incident.id, issueNumber, system });
            return true;
          }
        }

        const status = system === 'none' ? 'skipped' : 'error';
        ticketingSyncTotal.inc({ system, status });
        span.setAttributes({ 'ticketing.system': system, 'ticketing.outcome': status });
        return false;
      } catch (error) {
        ticketingSyncTotal.inc({ system, status: 'error' });
        span.setAttributes({ 'ticketing.system': system, 'ticketing.outcome': 'error' });
        logger.error('[TicketingSink] sync exception', {
          incidentId: incident.id,
          system,
          err: error instanceof Error ? error.message : String(error),
        });
        throw error;
      } finally {
        this.inFlight.delete(incident.id);
      }
    }, { incidentId: incident.id, incidentStatus: incident.status });
  }
}

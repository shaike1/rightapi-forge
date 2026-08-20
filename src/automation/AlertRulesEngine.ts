// Alert Rules Engine — polls monitored servers, evaluates threshold rules, fires alerts

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import { TeamsProvider } from '../integrations/TeamsProvider.js';
import { SmtpService } from '../notifications/SmtpService.js';
import { RunbookEngine } from '../runbooks/RunbookEngine.js';
import { correlationEngine } from './AlertCorrelationEngine.js';
import { anomalyDetector } from '../monitoring/AnomalyDetector.js';
import { logger } from '../utils/logger.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const _teamsProvider = new TeamsProvider();
const _smtpService = new SmtpService();

export interface AlertChannel {
  type: 'telegram' | 'slack' | 'discord' | 'webhook' | 'pagerduty' | 'email' | 'teams';
  webhookUrl?: string;    // for slack/discord/webhook
  chatId?: string;        // for telegram override
  routingKey?: string;    // for pagerduty
  email?: string;         // for email
}

export interface AlertRule {
  id: string;
  name: string;
  enabled: boolean;
  metric: 'cpu' | 'memory' | 'disk' | 'ping';
  threshold: number;       // percentage (0–100) for cpu/mem/disk, ms for ping
  operator: '>' | '<' | '>=';
  servers: string[];       // IPs to check, or ['*'] for all MONITORED_SERVERS
  cooldownMinutes: number; // don't re-alert within this window
  severity: 'warning' | 'critical';
  createdAt: string;
  lastTriggered?: string;
  lastValue?: number;
  channels?: AlertChannel[];
  notifyEmail?: boolean;     // also send via global SMTP when rule fires
  jiraProject?: string; // override global JIRA_DEFAULT_PROJECT for tickets from this rule
  runbookId?: string;        // optional runbook template ID to auto-execute
  autoRemediate?: boolean;   // must be true to trigger auto-execution
}

type SendAlertFn = (msg: string, severity: string) => Promise<void>;
type OpenIncidentFn = (title: string, description: string, severity: string, sourceRef: string) => void;
type SkillExecutorFn = (command: string, params: Record<string, unknown>) => Promise<string>;

export class AlertRulesEngine {
  private rules: Map<string, AlertRule> = new Map();
  private persistPath: string;
  private sendAlert: SendAlertFn;
  private openIncident: OpenIncidentFn | undefined;
  private skillExecutor: SkillExecutorFn | undefined;
  private runbookEngine: RunbookEngine | undefined;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  constructor(persistPath: string, sendAlert: SendAlertFn, openIncident?: OpenIncidentFn, skillExecutor?: SkillExecutorFn, runbookEngine?: RunbookEngine) {
    this.persistPath = persistPath;
    this.sendAlert = sendAlert;
    this.openIncident = openIncident;
    this.skillExecutor = skillExecutor;
    this.runbookEngine = runbookEngine;
    this.load();
    this.seedDefaults();
  }

  // ── Persistence ─────────────────────────────────────────────────────────────

  private load(): void {
    if (!existsSync(this.persistPath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.persistPath, 'utf8')) as AlertRule[];
      for (const r of raw) this.rules.set(r.id, r);
      logger.info(`[AlertRulesEngine] Loaded ${this.rules.size} rule(s)`);
    } catch (e) {
      logger.error('[AlertRulesEngine] Failed to load rules:', { err: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined });
    }
  }

  private save(): void {
    try {
      const dir = dirname(this.persistPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(this.persistPath, JSON.stringify([...this.rules.values()], null, 2));
    } catch (e) {
      logger.error('[AlertRulesEngine] Failed to save rules:', { err: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined });
    }
  }

  private seedDefaults(): void {
    if (this.rules.size > 0) return;
    const defaults: AlertRule[] = [
      {
        id: 'seed-cpu-critical',
        name: 'High CPU Usage',
        enabled: true,
        metric: 'cpu',
        threshold: 90,
        operator: '>',
        servers: ['*'],
        cooldownMinutes: 30,
        severity: 'critical',
        createdAt: new Date().toISOString()
      },
      {
        id: 'seed-memory-warning',
        name: 'High Memory Usage',
        enabled: true,
        metric: 'memory',
        threshold: 85,
        operator: '>',
        servers: ['*'],
        cooldownMinutes: 30,
        severity: 'warning',
        createdAt: new Date().toISOString()
      },
      {
        id: 'seed-disk-warning',
        name: 'High Disk Usage',
        enabled: true,
        metric: 'disk',
        threshold: 80,
        operator: '>',
        servers: ['*'],
        cooldownMinutes: 60,
        severity: 'warning',
        createdAt: new Date().toISOString()
      }
    ];
    for (const d of defaults) this.rules.set(d.id, d);
    this.save();
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  list(): AlertRule[] {
    return [...this.rules.values()];
  }

  add(rule: Omit<AlertRule, 'id' | 'createdAt'>): AlertRule {
    const newRule: AlertRule = {
      ...rule,
      id: 'rule-' + Date.now(),
      createdAt: new Date().toISOString()
    };
    this.rules.set(newRule.id, newRule);
    this.save();
    return newRule;
  }

  update(id: string, patch: Partial<AlertRule>): AlertRule | null {
    const rule = this.rules.get(id);
    if (!rule) return null;
    Object.assign(rule, patch);
    this.save();
    return rule;
  }

  remove(id: string): boolean {
    if (!this.rules.has(id)) return false;
    this.rules.delete(id);
    this.save();
    return true;
  }

  start(): void {
    if (this.intervalHandle !== null) return;
    this.intervalHandle = setInterval(() => {
      this.evaluateNow().catch(e =>
        logger.error('[AlertRulesEngine] Error in scheduled evaluation:', { err: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined })
      );
    }, 60_000);
    logger.info('[AlertRulesEngine] Started polling (60s interval)');
  }

  stop(): void {
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
      logger.info('[AlertRulesEngine] Stopped polling');
    }
  }

  async evaluateNow(): Promise<void> {
    const enabled = [...this.rules.values()].filter(r => r.enabled);
    await Promise.all(enabled.map(r => this.evaluate(r)));
  }

  // ── Internals ────────────────────────────────────────────────────────────────

  private isLocal(host: string): boolean {
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      process.env.SSH_AVAILABLE === 'false'
    );
  }

  /**
   * Execute a metric-collection command on `host`. Local runs go through
   * a shell so command pipes resolve normally. Remote runs use execFile
   * with an argv array to avoid double-quoting: previously this method
   * built `ssh host "cmd with $vars"` and handed it to execAsync which
   * goes through /bin/sh -c — the LOCAL shell would expand the $vars
   * BEFORE the ssh ever ran, mangling commands like
   *   "free | awk '/Mem:/ {printf \"%.0f\", $3/$2*100}'"
   * into garbage. Result: every metric read returned NaN and no rule
   * had ever fired in production. The execFile path passes the command
   * verbatim as an argv element so the remote shell — and only the
   * remote shell — sees the $vars.
   */
  private async runCommand(host: string, remoteCmd: string): Promise<string> {
    if (this.isLocal(host)) {
      const { stdout } = await execAsync(remoteCmd, { timeout: 8000 });
      return stdout.trim();
    }
    const { stdout } = await execFileAsync('ssh', [
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ConnectTimeout=3',
      '-o', 'BatchMode=yes',
      host,
      remoteCmd,
    ], { timeout: 8000 });
    return stdout.trim();
  }

  private async checkMetric(host: string, metric: AlertRule['metric']): Promise<number> {
    switch (metric) {
      case 'cpu': {
        const out = await this.runCommand(
          host,
          "top -bn1 | grep 'Cpu(s)' | awk '{print $2}'"
        );
        return parseFloat(out);
      }
      case 'memory': {
        const out = await this.runCommand(
          host,
          "free | awk '/Mem:/ {printf \"%.0f\", $3/$2*100}'"
        );
        return parseInt(out, 10);
      }
      case 'disk': {
        const out = await this.runCommand(
          host,
          "df / | awk 'NR==2{print $5}' | tr -d '%'"
        );
        return parseInt(out, 10);
      }
      case 'ping': {
        const { stdout } = await execAsync(
          `ping -c 1 -W 2 ${host}`,
          { timeout: 5000 }
        );
        const match = stdout.match(/time=([\d.]+)\s*ms/);
        if (!match) throw new Error('Could not parse ping output');
        return parseFloat(match[1]);
      }
    }
  }

  private compareValue(value: number, operator: AlertRule['operator'], threshold: number): boolean {
    switch (operator) {
      case '>':  return value > threshold;
      case '<':  return value < threshold;
      case '>=': return value >= threshold;
    }
  }

  private cooldownExpired(rule: AlertRule): boolean {
    if (!rule.lastTriggered) return true;
    const elapsed = (Date.now() - new Date(rule.lastTriggered).getTime()) / 60_000;
    return elapsed >= rule.cooldownMinutes;
  }

  private resolveServers(rule: AlertRule): string[] {
    if (rule.servers.includes('*')) {
      const raw = process.env.MONITORED_SERVERS || '';
      return raw.split(',').map(s => s.trim()).filter(Boolean);
    }
    return rule.servers;
  }

  private async dispatchChannel(ch: AlertChannel, message: string, severity: string, ruleName: string): Promise<void> {
    if (!this.skillExecutor) return;

    try {
      switch (ch.type) {
        case 'slack':
          await this.skillExecutor('alert.slack', {
            webhookUrl: ch.webhookUrl,
            message: `[${severity.toUpperCase()}] ${ruleName}: ${message}`,
          });
          break;
        case 'discord':
          await this.skillExecutor('alert.discord', {
            webhookUrl: ch.webhookUrl,
            message: `[${severity.toUpperCase()}] ${ruleName}: ${message}`,
          });
          break;
        case 'webhook':
          await this.skillExecutor('alert.webhook', {
            url: ch.webhookUrl,
            payload: JSON.stringify({ severity, rule: ruleName, message }),
          });
          break;
        case 'pagerduty':
          await this.skillExecutor('alert.pagerduty', {
            routingKey: ch.routingKey,
            summary: `[${severity.toUpperCase()}] ${ruleName}: ${message}`,
            severity,
          });
          break;
        case 'telegram':
          // Use global sendAlert for telegram (it handles token/chatId from env)
          await this.sendAlert(message, severity);
          break;
        case 'teams':
          await _teamsProvider.sendAlertCard(
            ch.webhookUrl!,
            `[${severity.toUpperCase()}] ${ruleName}: ${message}`,
          );
          break;
        case 'email':
          await _smtpService.sendAlert(
            `[${severity.toUpperCase()}] ${ruleName}`,
            message,
            ch.email ? [ch.email] : undefined,
          );
          break;
        default:
          logger.warn('[AlertRulesEngine] Unknown channel type:', { channelType: ch.type });
      }
    } catch (e) {
      logger.error(`[AlertRulesEngine] Channel dispatch failed for ${ch.type}:`, { err: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined });
    }
  }

  private async evaluate(rule: AlertRule): Promise<void> {
    const servers = this.resolveServers(rule);
    for (const host of servers) {
      try {
        const value = await this.checkMetric(host, rule.metric);
        if (isNaN(value)) {
          logger.warn(`[AlertRulesEngine] NaN metric for ${rule.metric} on ${host}, skipping`);
          continue;
        }
        rule.lastValue = value;

        // Feed sample into anomaly detector (only for cpu/memory/disk)
        if (rule.metric !== 'ping') {
          try {
            anomalyDetector.addSample(host, rule.metric, value);
            anomalyDetector.detectAnomaly(host, rule.metric, value);
          } catch (e) {
            logger.error('[AlertRulesEngine] AnomalyDetector error:', { err: (e as Error).message });
          }
        }

        if (this.compareValue(value, rule.operator, rule.threshold) && this.cooldownExpired(rule)) {
          const firedAt = new Date();
          rule.lastTriggered = firedAt.toISOString();
          this.save();
          const msg =
            `[${rule.severity.toUpperCase()}] ${rule.name}: ` +
            `${rule.metric} on ${host} is ${value} ` +
            `(${rule.operator} ${rule.threshold})`;
          logger.warn(`[AlertRulesEngine] Alert fired: ${msg}`);

          // Feed into correlation engine
          try {
            correlationEngine.addAlert({
              id: `${rule.id}-${host}-${firedAt.getTime()}`,
              ruleId: rule.id,
              ruleName: rule.name,
              server: host,
              metric: rule.metric,
              value,
              severity: rule.severity,
              firedAt,
            });
          } catch (e) {
            logger.error('[AlertRulesEngine] CorrelationEngine error:', { err: (e as Error).message });
          }
          if (rule.channels && rule.channels.length > 0) {
            for (const ch of rule.channels) {
              await this.dispatchChannel(ch, msg, rule.severity, rule.name);
            }
          } else {
            await this.sendAlert(msg, rule.severity).catch(e =>
              logger.error('[AlertRulesEngine] sendAlert failed:', { err: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined })
            );
          }
          // Send global SMTP alert if notifyEmail is set on the rule
          if (rule.notifyEmail) {
            _smtpService.sendAlert(
              `[${rule.severity.toUpperCase()}] ${rule.name}`,
              msg,
            ).catch(e => logger.error('[AlertRulesEngine] SMTP sendAlert failed:', { err: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined }));
          }
          if (this.openIncident) {
            try {
              this.openIncident(
                `${rule.name} on ${host}`,
                msg,
                rule.severity,
                rule.id
              );
            } catch (e) {
              logger.error('[AlertRulesEngine] openIncident failed:', { err: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined });
            }
          }
          if (rule.autoRemediate && rule.runbookId && this.runbookEngine) {
            try {
              await this.runbookEngine.executeRun(rule.runbookId, 'alert-rule');
            } catch (err) {
              logger.error('[AlertRules] Auto-remediation failed:', { err: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined });
            }
          }
        }
      } catch (e) {
        logger.warn(`[AlertRulesEngine] Metric check failed for ${rule.metric} on ${host}:`, { err: (e as Error).message });
      }
    }
  }
}

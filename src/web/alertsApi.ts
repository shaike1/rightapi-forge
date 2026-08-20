import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { retryFetch } from '../utils/retryFetch.js';
import { logger } from '../utils/logger.js';
import { computeMetricsForAlerts } from './analyticsApi.js';

const ALERTS_CONFIG_PATH = process.env.ALERTS_CONFIG_PATH || '/data/itops-agents/alerts-config.json';
const ALERTS_FIRED_PATH = process.env.ALERTS_FIRED_PATH || '/data/itops-agents/alerts-fired.json';

export interface AlertRule {
  id: string;
  name: string;
  enabled: boolean;
  metric: 'task_completion_rate' | 'agent_error_rate' | 'pending_tasks' | 'overdue_tasks' | 'sla_breach_rate';
  threshold: number;
  operator: 'gt' | 'lt' | 'gte' | 'lte';
  severity: 'low' | 'medium' | 'high' | 'critical';
  channels: ('discord' | 'slack' | 'email')[];
  cooldownMinutes: number;
  createdAt: string;
}

export interface FiredAlert {
  id: string;
  ruleId: string;
  ruleName: string;
  severity: string;
  metric: string;
  value: number;
  threshold: number;
  message: string;
  firedAt: string;
  resolved: boolean;
  resolvedAt?: string;
}

interface AlertsConfig {
  rules: AlertRule[];
  discordWebhookUrl: string;
  slackWebhookUrl: string;
}

const DEFAULT_CONFIG: AlertsConfig = {
  rules: [],
  discordWebhookUrl: '',
  slackWebhookUrl: '',
};

function loadConfig(): AlertsConfig {
  try {
    if (fs.existsSync(ALERTS_CONFIG_PATH)) {
      return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(ALERTS_CONFIG_PATH, 'utf8')) };
    }
  } catch (e) { logger.error('[alertsApi] load config error', e); }
  return { ...DEFAULT_CONFIG };
}

function saveConfig(cfg: AlertsConfig): void {
  fs.mkdirSync(path.dirname(ALERTS_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(ALERTS_CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

function loadFiredAlerts(): FiredAlert[] {
  try {
    if (fs.existsSync(ALERTS_FIRED_PATH)) {
      return JSON.parse(fs.readFileSync(ALERTS_FIRED_PATH, 'utf8')) as FiredAlert[];
    }
  } catch { /* ignore */ }
  return [];
}

function saveFiredAlerts(alerts: FiredAlert[]): void {
  fs.mkdirSync(path.dirname(ALERTS_FIRED_PATH), { recursive: true });
  // Keep only last 500 fired alerts
  const trimmed = alerts.slice(-500);
  fs.writeFileSync(ALERTS_FIRED_PATH, JSON.stringify(trimmed, null, 2));
}

// In-memory cooldown tracking: ruleId -> last fired timestamp
const cooldowns = new Map<string, number>();

export async function fireAlert(rule: AlertRule, value: number, webhookUrl: string): Promise<void> {
  if (!webhookUrl || !rule.channels.includes('discord')) return;

  const colorMap: Record<string, number> = {
    critical: 0xE74C3C,
    high: 0xE67E22,
    medium: 0xF1C40F,
    low: 0x2ECC71,
  };

  const operatorLabel: Record<string, string> = { gt: '>', lt: '<', gte: '>=', lte: '<=' };
  const message = `Alert: **${rule.name}** — ${rule.metric} is ${value.toFixed(2)} (threshold: ${operatorLabel[rule.operator]} ${rule.threshold})`;

  try {
    await retryFetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [{
          title: `🚨 [${rule.severity.toUpperCase()}] ${rule.name}`,
          description: message,
          color: colorMap[rule.severity] ?? 0x3498DB,
          fields: [
            { name: 'Metric', value: rule.metric, inline: true },
            { name: 'Value', value: String(value.toFixed(2)), inline: true },
            { name: 'Threshold', value: `${operatorLabel[rule.operator]} ${rule.threshold}`, inline: true },
          ],
          footer: { text: 'RightAPI Forge Alert System' },
          timestamp: new Date().toISOString(),
        }],
      }),
    });
    logger.info(`[alertsApi] Fired discord alert for rule ${rule.id}`);
  } catch (e) {
    logger.error('[alertsApi] Discord webhook error', e);
  }
}

export function checkAndFireAlerts(metrics: Record<string, number>): void {
  const cfg = loadConfig();
  const fired = loadFiredAlerts();
  const now = Date.now();

  for (const rule of cfg.rules) {
    if (!rule.enabled) continue;
    const value = metrics[rule.metric];
    if (value === undefined) continue;

    const lastFired = cooldowns.get(rule.id) ?? 0;
    const cooldownMs = rule.cooldownMinutes * 60 * 1000;
    if (now - lastFired < cooldownMs) continue;

    const triggered =
      (rule.operator === 'gt' && value > rule.threshold) ||
      (rule.operator === 'lt' && value < rule.threshold) ||
      (rule.operator === 'gte' && value >= rule.threshold) ||
      (rule.operator === 'lte' && value <= rule.threshold);

    if (!triggered) continue;

    cooldowns.set(rule.id, now);
    const operatorLabel: Record<string, string> = { gt: '>', lt: '<', gte: '>=', lte: '<=' };
    const alert: FiredAlert = {
      id: `${rule.id}-${now}`,
      ruleId: rule.id,
      ruleName: rule.name,
      severity: rule.severity,
      metric: rule.metric,
      value,
      threshold: rule.threshold,
      message: `${rule.metric} is ${value.toFixed(2)} (threshold: ${operatorLabel[rule.operator]} ${rule.threshold})`,
      firedAt: new Date().toISOString(),
      resolved: false,
    };
    fired.push(alert);
    logger.warn(`[alertsApi] Alert fired: ${rule.name} (${rule.metric}=${value})`);

    if (cfg.discordWebhookUrl) {
      fireAlert(rule, value, cfg.discordWebhookUrl).catch(() => {});
    }
  }

  saveFiredAlerts(fired);
}

const router = Router();

// GET /api/alerts/rules
router.get('/rules', (_req, res) => {
  const cfg = loadConfig();
  res.json(cfg.rules);
});

// POST /api/alerts/rules
router.post('/rules', (req, res) => {
  const cfg = loadConfig();
  const { name, metric, threshold, operator, severity, channels, cooldownMinutes, enabled } = req.body as Partial<AlertRule>;
  if (!name || !metric || threshold === undefined || !operator || !severity) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  const rule: AlertRule = {
    id: `rule-${Date.now()}`,
    name,
    metric,
    threshold: Number(threshold),
    operator,
    severity,
    channels: channels ?? ['discord'],
    cooldownMinutes: Number(cooldownMinutes ?? 30),
    enabled: enabled ?? true,
    createdAt: new Date().toISOString(),
  };
  cfg.rules.push(rule);
  saveConfig(cfg);
  res.status(201).json(rule);
});

// PUT /api/alerts/rules/:id
router.put('/rules/:id', (req, res) => {
  const cfg = loadConfig();
  const idx = cfg.rules.findIndex(r => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Rule not found' });
  cfg.rules[idx] = { ...cfg.rules[idx], ...req.body, id: req.params.id };
  saveConfig(cfg);
  res.json(cfg.rules[idx]);
});

// DELETE /api/alerts/rules/:id
router.delete('/rules/:id', (req, res) => {
  const cfg = loadConfig();
  cfg.rules = cfg.rules.filter(r => r.id !== req.params.id);
  saveConfig(cfg);
  res.json({ ok: true });
});

// GET /api/alerts/fired
router.get('/fired', (_req, res) => {
  const alerts = loadFiredAlerts();
  res.json(alerts.slice(-100).reverse());
});

// POST /api/alerts/fired/:id/resolve
router.post('/fired/:id/resolve', (req, res) => {
  const alerts = loadFiredAlerts();
  const alert = alerts.find(a => a.id === req.params.id);
  if (!alert) return res.status(404).json({ error: 'Not found' });
  alert.resolved = true;
  alert.resolvedAt = new Date().toISOString();
  saveFiredAlerts(alerts);
  res.json(alert);
});

// GET /api/alerts/config
router.get('/config', (_req, res) => {
  const cfg = loadConfig();
  res.json({ discordWebhookUrl: cfg.discordWebhookUrl ? '***configured***' : '', slackWebhookUrl: cfg.slackWebhookUrl ? '***configured***' : '' });
});

// PUT /api/alerts/config
router.put('/config', (req, res) => {
  const cfg = loadConfig();
  const { discordWebhookUrl, slackWebhookUrl } = req.body;
  if (discordWebhookUrl !== undefined) cfg.discordWebhookUrl = discordWebhookUrl;
  if (slackWebhookUrl !== undefined) cfg.slackWebhookUrl = slackWebhookUrl;
  saveConfig(cfg);
  res.json({ ok: true });
});

// POST /api/alerts/test
router.post('/test', async (req, res) => {
  const cfg = loadConfig();
  if (!cfg.discordWebhookUrl) return res.status(400).json({ error: 'No Discord webhook configured' });
  try {
    await retryFetch(cfg.discordWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '✅ RightAPI Forge alert system test — connection working!' }),
    });
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});


// Periodic alert evaluator — call once at startup
export function startAlertEvaluator(intervalMs = 5 * 60 * 1000): NodeJS.Timeout {
  const run = () => {
    try {
      const metrics = computeMetricsForAlerts();
      checkAndFireAlerts(metrics);
    } catch (e) {
      logger.error('[alertsApi] evaluator error', e);
    }
  };
  run(); // immediate first run
  return setInterval(run, intervalMs);
}

export default router;

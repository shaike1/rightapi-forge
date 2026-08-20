// Startup environment-config validator. Run once at the very top of the
// server boot — before agents, DBs, or HTTP listeners initialise — so that
// a misconfigured deployment fails loudly with a clear list of what's
// missing instead of crashing later in opaque ways.
//
// Behaviour:
//   • Required vars: validate presence; missing ⇒ exit(1) with a
//     consolidated error listing every missing key.
//   • AI providers: warn (not fail) when neither ANTHROPIC_API_KEY nor
//     OPENAI_API_KEY is set — agents won't be able to think, but the
//     server can still serve dashboards / health checks.
//   • Numeric vars: bad values ⇒ collected and reported alongside missing
//     required vars. We treat malformed numerics as fatal because they
//     usually indicate a typo'd env file.
//   • Optional defaults: log every var that's falling back to a default so
//     the operator can see the effective configuration in startup logs.

import { logger } from '../utils/logger.js';

export type ValidatorIssueLevel = 'error' | 'warn' | 'info';

export interface ValidatorIssue {
  level: ValidatorIssueLevel;
  field: string;
  message: string;
  value?: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidatorIssue[];
  defaultsApplied: Array<{ field: string; default: string }>;
}

/** A single rule the validator runs against process.env. */
export interface EnvRule {
  /** Env var name (e.g. "ADMIN_PASSWORD"). */
  name: string;
  /** Required ⇒ missing is fatal. Optional ⇒ missing is fine; default is logged. */
  required?: boolean;
  /** Type validation (currently 'number' or 'boolean'; everything else is string). */
  type?: 'string' | 'number' | 'boolean';
  /** Default value used if absent. Logged in defaultsApplied. */
  default?: string;
  /** Lower bound for `number` type (inclusive). */
  min?: number;
  /** Upper bound for `number` type (inclusive). */
  max?: number;
  /** When set, missing+no-default issues a warn instead of an error
   *  (used for "soft-required" things like AI keys that we want to
   *  surface but not refuse to boot over). */
  warnIfMissing?: boolean;
  /** Human-readable explanation appended to the issue message. */
  description?: string;
}

/**
 * The canonical rule set for itops-agents. Add new env vars here when you
 * introduce them so they show up in the startup banner with a clear
 * default + type contract.
 */
export const DEFAULT_RULES: EnvRule[] = [
  // Required secrets. Missing any of these ⇒ exit.
  { name: 'ADMIN_PASSWORD',         required: true,  description: 'Admin login password.' },
  { name: 'AUTH_TOKEN_SECRET',      required: true,  description: 'HMAC secret for session tokens.' },
  { name: 'CREDENTIAL_MASTER_KEY',  required: true,  description: 'Symmetric key for encrypting the credential vault.' },

  // Soft-required: warn if neither AI key is set; that's caught separately
  // in validate().
  { name: 'ANTHROPIC_API_KEY',      warnIfMissing: true, description: 'Claude API key.' },
  { name: 'OPENAI_API_KEY',         warnIfMissing: true, description: 'OpenAI API key.' },

  // Optional with defaults. Every entry below is logged in the startup
  // banner if it's falling back to its default.
  { name: 'PORT',                   type: 'number', default: '19123', min: 1, max: 65535 },
  { name: 'LOG_LEVEL',              default: 'info',  description: 'debug | info | warn | error.' },
  { name: 'INCIDENT_SLA_CRITICAL_MIN', type: 'number', default: '60',  min: 1 },
  { name: 'INCIDENT_SLA_HIGH_MIN',     type: 'number', default: '240', min: 1 },
  { name: 'INCIDENT_SLA_MEDIUM_MIN',   type: 'number', default: '1440', min: 1 },
  { name: 'INCIDENT_SLA_LOW_MIN',      type: 'number', default: '4320', min: 1 },
  { name: 'ORCHESTRATOR_SWEEP_INTERVAL_MS', type: 'number', default: '60000', min: 1000 },
  { name: 'AGENT_STUCK_THRESHOLD_MINUTES',  type: 'number', default: '30', min: 1 },
  { name: 'BACKUP_AUTOMATION_ENABLED',      type: 'boolean', default: 'false' },
  { name: 'BACKUP_AUTOMATION_INTERVAL_MINUTES', type: 'number', default: '60', min: 5 },
  { name: 'BACKUP_HEALTH_MAX_AGE_HOURS',    type: 'number', default: '24', min: 1 },
  { name: 'RETENTION_KEEP_LATEST',          type: 'number', default: '30', min: 0 },
  { name: 'RETENTION_MAX_AGE_DAYS',         type: 'number', default: '14', min: 0 },
  { name: 'OTEL_ENABLED',                   type: 'boolean', default: 'false' },
  { name: 'OTEL_EXPORTER_OTLP_ENDPOINT',    default: 'http://localhost:4318' },
  { name: 'OTEL_SERVICE_NAME',              default: 'itops-agents' },
  { name: 'REQUIRE_STRONG_SECRETS',         type: 'boolean', default: 'false' },

  // Storage backend selection. Validated by additional logic in validate()
  // because the postgres path has a cross-field requirement (POSTGRES_URL).
  { name: 'DB_PROVIDER',                    default: 'sqlite', description: 'sqlite | postgres' },
  { name: 'POSTGRES_URL',                   description: 'Required when DB_PROVIDER=postgres.' },
  { name: 'POSTGRES_POOL_MAX',              type: 'number', default: '10', min: 1, max: 200 },

  // Message-bus selection. Cross-field check below: MESSAGE_BUS=redis
  // requires REDIS_URL.
  { name: 'MESSAGE_BUS',                    default: 'memory', description: 'memory | redis' },
  { name: 'REDIS_URL',                      description: 'Required when MESSAGE_BUS=redis.' },

  // External chat-bot API. Optional — when EXTERNAL_API_TOKEN is unset,
  // /api/external is not mounted and the endpoints simply 404.
  { name: 'EXTERNAL_API_TOKEN',             description: 'Bearer token for /api/external. Unset = endpoints disabled.' },
  { name: 'EXTERNAL_API_RESTART_ALLOWLIST', description: 'Comma-separated container names allowed via /api/external/actions/container-restart.' },

  // Multi-server monitoring (Phase 35 rewrite) — ServerRegistry seed
  // overrides + DB path. The local row is always seeded; the two remote
  // rows below are only created on first boot, so an operator who
  // deletes them from /api/servers won't see them silently respawn.
  { name: 'SERVER_REGISTRY_DB_PATH', default: '/data/itops-agents/servers.db' },
  { name: 'LOCAL_SERVER_NAME',       default: 'local' },
  { name: 'VPS2_SERVER_HOST',        description: 'Optional first remote host seed.' },
  { name: 'VPS2_SERVER_USER',        default: 'root' },
  { name: 'VPS3_SERVER_HOST',        description: 'Optional second remote host seed.' },
  { name: 'VPS3_SERVER_USER',        default: 'root' },

  // Escalation pipeline — see src/incidents/EscalationPipeline.ts.
  // L3 delay is the grace window between "auto-remediator started" and
  // "page a human", giving the recipe time to actually clear the
  // condition. L4 timeout is how long an L3 incident may sit unresolved
  // before automated severity bump + urgent follow-up.
  { name: 'ESCALATION_ENABLED',         type: 'boolean', default: 'true' },
  { name: 'ESCALATION_L3_DELAY_MS',     type: 'number',  default: '60000',   min: 0 },
  { name: 'ESCALATION_L4_TIMEOUT_MS',   type: 'number',  default: '1800000', min: 60000 },
  { name: 'ESCALATION_MIN_SEVERITY',    default: 'medium', description: 'low | medium | high | critical.' },
  { name: 'ESCALATION_WEBHOOK_URL',     description: 'Optional HTTPS endpoint POSTed at L4 (PagerDuty/Opsgenie bridge).' },

  // Direct Telegram bot alerting (src/integrations/telegram.ts).
  // Independent of OpenClaw — set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID
  // and flip TELEGRAM_ALERT_ENABLED=true to arm it.
  { name: 'TELEGRAM_BOT_TOKEN',         description: 'Bot API token from @BotFather. Required when TELEGRAM_ALERT_ENABLED=true.' },
  { name: 'TELEGRAM_CHAT_ID',           description: 'Chat or group id alerts are sent to. Required when TELEGRAM_ALERT_ENABLED=true.' },
  { name: 'TELEGRAM_ALERT_ENABLED',     type: 'boolean', default: 'false' },
  { name: 'TELEGRAM_ALERT_MIN_SEVERITY', default: 'high', description: 'low | medium | high | critical.' },
];

/**
 * Run validation against `env` (defaults to process.env) using `rules`.
 * Pure: doesn't read process.env directly, doesn't exit, doesn't log —
 * tests call this and inspect the returned issues. validateAtStartup()
 * is the side-effecting wrapper used by the actual server boot.
 */
export function validate(
  env: NodeJS.ProcessEnv = process.env,
  rules: EnvRule[] = DEFAULT_RULES,
): ValidationResult {
  const issues: ValidatorIssue[] = [];
  const defaultsApplied: Array<{ field: string; default: string }> = [];

  let anyAiKeySet = false;

  for (const rule of rules) {
    const raw = env[rule.name];
    const present = typeof raw === 'string' && raw.length > 0;

    if (rule.name === 'ANTHROPIC_API_KEY' || rule.name === 'OPENAI_API_KEY') {
      if (present) anyAiKeySet = true;
    }

    if (!present) {
      if (rule.required) {
        issues.push({
          level: 'error',
          field: rule.name,
          message: `${rule.name} is required but not set${rule.description ? ` — ${rule.description}` : ''}.`,
        });
      } else if (typeof rule.default === 'string') {
        defaultsApplied.push({ field: rule.name, default: rule.default });
      } else if (rule.warnIfMissing) {
        // Caught in the AI-key roll-up below.
      }
      continue;
    }

    // Type checks for present values.
    if (rule.type === 'number') {
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        issues.push({
          level: 'error',
          field: rule.name,
          message: `${rule.name}="${raw}" is not a valid number${rule.description ? ` — ${rule.description}` : ''}.`,
          value: raw,
        });
        continue;
      }
      if (typeof rule.min === 'number' && n < rule.min) {
        issues.push({
          level: 'error',
          field: rule.name,
          message: `${rule.name}=${n} is below minimum ${rule.min}.`,
          value: raw,
        });
      }
      if (typeof rule.max === 'number' && n > rule.max) {
        issues.push({
          level: 'error',
          field: rule.name,
          message: `${rule.name}=${n} is above maximum ${rule.max}.`,
          value: raw,
        });
      }
    } else if (rule.type === 'boolean') {
      if (!/^(true|false|1|0|yes|no)$/i.test(raw)) {
        issues.push({
          level: 'warn',
          field: rule.name,
          message: `${rule.name}="${raw}" is not a recognised boolean (true/false/1/0/yes/no).`,
          value: raw,
        });
      }
    }
  }

  // Soft-required AI key roll-up: warn (not fail) if neither is set.
  if (!anyAiKeySet) {
    issues.push({
      level: 'warn',
      field: 'ANTHROPIC_API_KEY|OPENAI_API_KEY',
      message: 'Neither ANTHROPIC_API_KEY nor OPENAI_API_KEY is set — agents will not be able to think (LLM calls will fail).',
    });
  }

  // MESSAGE_BUS allowed values + cross-field requirements.
  const busProvider = (env.MESSAGE_BUS || 'memory').toLowerCase();
  if (busProvider !== 'memory' && busProvider !== 'redis') {
    issues.push({
      level: 'error',
      field: 'MESSAGE_BUS',
      message: `MESSAGE_BUS="${env.MESSAGE_BUS}" is not supported (memory | redis).`,
      value: env.MESSAGE_BUS,
    });
  } else if (busProvider === 'redis') {
    const url = (env.REDIS_URL || '').trim();
    if (!url) {
      // Soft-error: factory falls back to memory if URL missing. Surface as
      // warn so a misconfigured deployment is still loud, but boots.
      issues.push({
        level: 'warn',
        field: 'REDIS_URL',
        message: 'MESSAGE_BUS=redis but REDIS_URL is not set — the factory will fall back to the in-memory bus.',
      });
    } else if (!/^rediss?:\/\//.test(url)) {
      issues.push({
        level: 'error',
        field: 'REDIS_URL',
        message: 'REDIS_URL must start with redis:// or rediss://',
        value: url,
      });
    }
  }

  // DB_PROVIDER allowed values + cross-field requirements.
  const dbProvider = (env.DB_PROVIDER || 'sqlite').toLowerCase();
  if (dbProvider !== 'sqlite' && dbProvider !== 'postgres') {
    issues.push({
      level: 'error',
      field: 'DB_PROVIDER',
      message: `DB_PROVIDER="${env.DB_PROVIDER}" is not supported (sqlite | postgres).`,
      value: env.DB_PROVIDER,
    });
  } else if (dbProvider === 'postgres') {
    const url = (env.POSTGRES_URL || '').trim();
    if (!url) {
      issues.push({
        level: 'error',
        field: 'POSTGRES_URL',
        message: 'POSTGRES_URL is required when DB_PROVIDER=postgres.',
      });
    } else if (!/^postgres(ql)?:\/\//.test(url)) {
      issues.push({
        level: 'error',
        field: 'POSTGRES_URL',
        message: 'POSTGRES_URL must start with postgres:// or postgresql://',
        value: url,
      });
    }
  }

  const ok = !issues.some(i => i.level === 'error');
  return { ok, issues, defaultsApplied };
}

/**
 * Run the validator and either log the banner + return on success, or
 * print a clear error block and call process.exit(1). Designed to be the
 * very first thing in server boot; everything else assumes the env is sane.
 */
export function validateAtStartup(opts: { rules?: EnvRule[]; env?: NodeJS.ProcessEnv; exitOnError?: boolean } = {}): ValidationResult {
  const result = validate(opts.env ?? process.env, opts.rules ?? DEFAULT_RULES);

  // Log defaults that were applied (debug-level — useful when you're
  // wondering why an env override didn't take effect).
  if (result.defaultsApplied.length > 0) {
    logger.info('[config] defaults applied for', {
      count: result.defaultsApplied.length,
      fields: result.defaultsApplied.map(d => `${d.field}=${d.default}`),
    });
  }

  // Log every warn-level issue.
  for (const issue of result.issues) {
    if (issue.level === 'warn') {
      logger.warn(`[config] ${issue.message}`, { field: issue.field, value: issue.value });
    } else if (issue.level === 'info') {
      logger.info(`[config] ${issue.message}`, { field: issue.field });
    }
  }

  // Errors are fatal.
  const errors = result.issues.filter(i => i.level === 'error');
  if (errors.length > 0) {
    logger.error(`[config] ${errors.length} configuration error(s) — refusing to start`, {
      errors: errors.map(e => ({ field: e.field, message: e.message })),
    });
    // Also write a human-readable block to stderr so an operator who isn't
    // running through a JSON log aggregator still sees it.
    process.stderr.write('\n' + '━'.repeat(72) + '\n');
    process.stderr.write(' Configuration errors — itops-agents will NOT start:\n');
    process.stderr.write('━'.repeat(72) + '\n');
    for (const e of errors) process.stderr.write(`  ✗  ${e.message}\n`);
    process.stderr.write('━'.repeat(72) + '\n\n');

    const shouldExit = opts.exitOnError !== false;
    if (shouldExit) process.exit(1);
  } else {
    logger.info('[config] validation passed', {
      requiredCount: (opts.rules ?? DEFAULT_RULES).filter(r => r.required).length,
      warnings: result.issues.filter(i => i.level === 'warn').length,
    });
  }

  return result;
}

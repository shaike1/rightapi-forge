// Store factory — picks SQLite (default, file-per-store) or PostgreSQL
// (shared connection pool) based on env config. Existing call-sites keep
// importing concrete classes; this module is the new entry point for
// "I want a store and don't care which backend".
//
//   DB_PROVIDER=sqlite     (default — backward compatible)
//   DB_PROVIDER=postgres   (requires POSTGRES_URL)
//   POSTGRES_URL=postgresql://user:pass@host:5432/dbname
//   POSTGRES_POOL_MAX=10   (optional)
//
// All three stores share one Postgres pool when DB_PROVIDER=postgres so
// the process doesn't open three identical connection pools to the same
// database.

import {
  SqliteTaskStore,
  SqliteIncidentStore,
  SqliteAgentMemoryStore,
} from './SqliteStore.js';
import {
  PostgresTaskStore,
  PostgresIncidentStore,
  PostgresAgentMemoryStore,
  getSharedPool,
  ensureSchema,
} from './PostgresStore.js';
import {
  SqliteEventStore,
  PostgresEventStore,
  type EventStore,
} from './EventStore.js';
import {
  SqliteScheduledTaskStore,
  PostgresScheduledTaskStore,
  type ScheduledTaskStore,
} from './ScheduledTaskStore.js';
import {
  SqliteCrystallizedSkillStore,
  PostgresCrystallizedSkillStore,
  type CrystallizedSkillStore,
} from './CrystallizedSkillStore.js';
import {
  SqliteTenantStore,
  PostgresTenantStore,
  type TenantStore,
} from '../tenancy/index.js';
import {
  SqlitePersonalityStore,
  PostgresPersonalityStore,
  type PersonalityStore,
} from './PersonalityStore.js';
import {
  SqliteRbacStore,
  PostgresRbacStore,
  type RbacStore,
} from './RbacStore.js';
import type {
  TaskStore,
  IncidentStore,
  AgentMemoryStore,
} from './interfaces.js';
import { logger } from '../utils/logger.js';

export type DbProvider = 'sqlite' | 'postgres';

export interface StoreFactoryOptions {
  /** Override the env-derived provider (used by tests). */
  provider?: DbProvider;
  /** SQLite paths — ignored when provider=postgres. */
  sqlitePaths?: {
    tasks?: string;
    incidents?: string;
    agentMemory?: string;
    events?: string;
    tenants?: string;
    personality?: string;
    rbac?: string;
    schedules?: string;
    crystallizedSkills?: string;
  };
  /** Postgres connection string — overrides POSTGRES_URL. */
  postgresUrl?: string;
  /** Postgres pool size — overrides POSTGRES_POOL_MAX. */
  postgresPoolMax?: number;
}

function resolveProvider(opts?: StoreFactoryOptions): DbProvider {
  const explicit = (opts?.provider ?? process.env.DB_PROVIDER ?? 'sqlite').toLowerCase();
  if (explicit !== 'sqlite' && explicit !== 'postgres') {
    throw new Error(`DB_PROVIDER must be "sqlite" or "postgres", got "${explicit}"`);
  }
  return explicit as DbProvider;
}

let cachedFactory: StoreFactory | null = null;

/**
 * Lazily-built singleton with the three stores. Most callers want this —
 * a fresh `new StoreFactory(...)` is reserved for tests that want isolated
 * connections.
 */
export function getStoreFactory(opts?: StoreFactoryOptions): StoreFactory {
  if (cachedFactory) return cachedFactory;
  cachedFactory = new StoreFactory(opts);
  return cachedFactory;
}

/** Drop the cached factory — used by tests + GracefulShutdown. */
export async function resetStoreFactory(): Promise<void> {
  if (cachedFactory) {
    try { await cachedFactory.close(); } catch { /* */ }
  }
  cachedFactory = null;
}

export class StoreFactory {
  private readonly provider: DbProvider;
  public readonly tasks: TaskStore;
  public readonly incidents: IncidentStore;
  public readonly agentMemory: AgentMemoryStore;
  /** Append-only event log used by EventBus + projections. Same backend as
   *  the rest of the stores (SQLite or Postgres) so a single DB_PROVIDER
   *  switch flips the whole persistence layer atomically. */
  public readonly events: EventStore;
  /** Tenant registry. Initialised with a "system" row so existing
   *  single-tenant deployments work without onboarding ceremony. */
  public readonly tenants: TenantStore;
  /** Per-agent evolving personality profile. Read on every LLM call
   *  to compose the system-prompt fragment, so it lives in its own
   *  thin store with one row per agent. */
  public readonly personality: PersonalityStore;
  /** RBAC role definitions + user-to-role assignments. Backwards-
   *  compatible: callers without an assignment fall back to super_admin
   *  via RbacService until an operator populates the table. */
  public readonly rbac: RbacStore;
  /** Workflow-aware scheduler — durable cron-based jobs + run history. */
  public readonly schedules: ScheduledTaskStore;
  /** Skills the platform crystallized from successful resolutions. */
  public readonly crystallizedSkills: CrystallizedSkillStore;

  constructor(opts: StoreFactoryOptions = {}) {
    this.provider = resolveProvider(opts);

    if (this.provider === 'postgres') {
      const url = opts.postgresUrl ?? process.env.POSTGRES_URL;
      if (!url) {
        throw new Error('DB_PROVIDER=postgres requires POSTGRES_URL to be set');
      }
      const max = opts.postgresPoolMax ?? (Number(process.env.POSTGRES_POOL_MAX) || 10);
      const pool = getSharedPool({ connectionString: url, max });

      // Run migrations once. We don't await here (constructors can't be
      // async) — the first query each store issues will block on it via
      // connection acquisition; ensureSchema itself is idempotent.
      ensureSchema(pool).catch((err) => {
        logger.error('[StoreFactory] postgres schema migration failed', { err: err.message });
      });

      this.tasks       = new PostgresTaskStore(pool);
      this.incidents   = new PostgresIncidentStore(pool);
      this.agentMemory = new PostgresAgentMemoryStore(pool);
      this.events      = new PostgresEventStore(pool);
      this.tenants     = new PostgresTenantStore(pool);
      this.personality = new PostgresPersonalityStore(pool);
      this.rbac        = new PostgresRbacStore(pool);
      this.schedules         = new PostgresScheduledTaskStore(pool);
      this.crystallizedSkills = new PostgresCrystallizedSkillStore(pool);
      logger.info('[StoreFactory] postgres backend ready', { poolMax: max });
    } else {
      const paths = opts.sqlitePaths ?? {};
      const tasksPath       = paths.tasks       ?? process.env.TASK_DB_PATH         ?? '/data/itops-agents/tasks.db';
      const incidentsPath   = paths.incidents   ?? process.env.INCIDENT_DB_PATH     ?? '/data/itops-agents/incidents.db';
      const memoryPath      = paths.agentMemory ?? process.env.AGENT_MEMORY_DB_PATH ?? '/data/itops-agents/agent-memory.db';
      const eventsPath      = paths.events      ?? process.env.EVENT_DB_PATH        ?? '/data/itops-agents/events.db';
      const tenantsPath     = paths.tenants     ?? process.env.TENANT_DB_PATH       ?? '/data/itops-agents/tenants.db';
      const personalityPath = paths.personality ?? process.env.PERSONALITY_DB_PATH  ?? '/data/itops-agents/personality.db';
      const rbacPath        = paths.rbac        ?? process.env.RBAC_DB_PATH         ?? '/data/itops-agents/rbac.db';
      const schedulesPath   = paths.schedules   ?? process.env.SCHEDULE_DB_PATH     ?? '/data/itops-agents/schedules.db';
      const crystallizedPath= paths.crystallizedSkills
                            ?? process.env.CRYSTALLIZED_DB_PATH                     ?? '/data/itops-agents/crystallized-skills.db';

      this.tasks              = new SqliteTaskStore(tasksPath);
      this.incidents          = new SqliteIncidentStore(incidentsPath);
      this.agentMemory        = new SqliteAgentMemoryStore(memoryPath);
      this.events             = new SqliteEventStore(eventsPath);
      this.tenants            = new SqliteTenantStore(tenantsPath);
      this.personality        = new SqlitePersonalityStore(personalityPath);
      this.rbac               = new SqliteRbacStore(rbacPath);
      this.schedules          = new SqliteScheduledTaskStore(schedulesPath);
      this.crystallizedSkills = new SqliteCrystallizedSkillStore(crystallizedPath);
      logger.info('[StoreFactory] sqlite backend ready', {
        tasksPath, incidentsPath, memoryPath, eventsPath, tenantsPath,
        personalityPath, rbacPath, schedulesPath, crystallizedPath,
      });
    }
  }

  getProvider(): DbProvider { return this.provider; }

  async close(): Promise<void> {
    // Both backends expose close(); Postgres needs the shared pool drained.
    await Promise.all([
      this.tasks.close(),
      this.incidents.close(),
      this.agentMemory.close(),
      this.events.close(),
      this.tenants.close(),
      this.personality.close(),
      this.rbac.close(),
      this.schedules.close(),
      this.crystallizedSkills.close(),
    ].map(v => Promise.resolve(v)));

    if (this.provider === 'postgres') {
      const { closeSharedPool } = await import('./PostgresStore.js');
      await closeSharedPool();
    }
  }
}

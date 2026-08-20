// Public API barrel for the persistence module.

export {
  type DbProvider,
  type StoreFactoryOptions,
  StoreFactory,
  getStoreFactory,
  resetStoreFactory,
} from './StoreFactory.js';

export type {
  TaskStore,
  IncidentStore,
  AgentMemoryStore,
  Incident,
  IncidentSeverity,
  IncidentStatus,
  IncidentSource,
  TimelineEntry,
  TimelineEventType,
  ResolutionRecord,
  ResolutionStep,
  ReflectionRecord,
  StoredReflection,
} from './interfaces.js';

export {
  SqliteTaskStore,
  SqliteIncidentStore,
  SqliteAgentMemoryStore,
} from './SqliteStore.js';

export {
  PostgresTaskStore,
  PostgresIncidentStore,
  PostgresAgentMemoryStore,
  getSharedPool,
  closeSharedPool,
  ensureSchema,
  type PostgresPoolConfig,
} from './PostgresStore.js';

export {
  type EventStore,
  type EventStreamFilter,
  type AppendedEvent,
  type EventInput,
  SqliteEventStore,
  PostgresEventStore,
} from './EventStore.js';

export {
  type PersonalityStore,
  SqlitePersonalityStore,
  PostgresPersonalityStore,
} from './PersonalityStore.js';

export {
  type RbacStore,
  SqliteRbacStore,
  PostgresRbacStore,
} from './RbacStore.js';

export {
  type ScheduledTaskStore,
  SqliteScheduledTaskStore,
  PostgresScheduledTaskStore,
} from './ScheduledTaskStore.js';

export {
  type CrystallizedSkillStore,
  SqliteCrystallizedSkillStore,
  PostgresCrystallizedSkillStore,
  RECENT_USAGE_CAP,
} from './CrystallizedSkillStore.js';

export { addTenantColumnSqlite, addTenantColumnPostgres } from './tenantMigration.js';

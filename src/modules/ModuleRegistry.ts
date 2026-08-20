// Declarative description of the codebase's logical modules + the
// inter-module dependency rules. Used by:
//   - tools/checkModuleBoundaries.ts (build-time enforcement)
//   - ServiceRegistry      (only registered modules can register services)
//   - documentation        (a single source of truth for boundaries)
//
// The list is intentionally NOT auto-derived from src/. Modules emerge
// from product structure, not directory layout — and a folder named
// "agents" might legitimately depend on "skills" while another folder
// of the same name shouldn't. Keeping the list explicit forces
// thoughtful change.
//
// Decomposition principle: a module's `dependencies` field lists every
// module it's allowed to import from. Anything else is a violation.
// Every module also exposes a `publicApi` barrel — outside callers
// must import the barrel, not internal files. The enforcer script
// detects both classes of violation.

export interface ModuleDefinition {
  /** Logical id used in dependency graphs. */
  id: string;
  /** Source dir (relative to src/) — the enforcer scans here. */
  rootDir: string;
  /** Public-API barrel, relative to rootDir. Outside-module imports
   *  must target this file. Set null to skip the barrel rule (rare;
   *  use only for transitional cases). */
  publicApi: string | null;
  /** Module ids this module is permitted to import from. The "core"
   *  pseudo-module is implicit and always allowed (logger, types,
   *  observability). */
  dependencies: string[];
  /** Free-form description for docs. */
  description: string;
}

/** Pseudo-module: paths every other module is allowed to import. */
export const CORE_ALLOWLIST: string[] = [
  'src/types/',
  'src/utils/',
  'src/observability/',
  'src/config/',
  'src/lifecycle/',
];

export const MODULES: ModuleDefinition[] = [
  {
    id: 'builder',
    rootDir: 'src/builder',
    publicApi: 'index.ts',
    dependencies: ['tenancy'],
    description: 'Typed application specifications and immutable project revisions.',
  },
  {
    id: 'tenancy',
    rootDir: 'src/tenancy',
    publicApi: 'index.ts',
    dependencies: [],
    description: 'Tenant context, registry, and middleware. No upward deps.',
  },
  {
    id: 'persistence',
    rootDir: 'src/persistence',
    publicApi: 'index.ts',
    // The PersonalityProfile + Task type definitions live with the
    // semantic owners (agents + types) but are imported `import type`
    // only — the boundary enforcer skips type-only imports, so this
    // module sits cleanly under tenancy without a runtime cycle.
    dependencies: ['tenancy'],
    description: 'Storage backends + StoreFactory. Stamps tenant_id.',
  },
  {
    id: 'events',
    rootDir: 'src/events',
    publicApi: 'index.ts',
    dependencies: ['persistence', 'tenancy'],
    description: 'EventBus + TenantScopedEventBus on the persistence event log.',
  },
  {
    id: 'messaging',
    rootDir: 'src/messaging',
    publicApi: 'index.ts',
    dependencies: ['agents'],  // RedisMessageBus reuses AgentMessageBus types
    description: 'Cross-process message buses (Redis/in-memory).',
  },
  {
    id: 'security',
    rootDir: 'src/security',
    publicApi: 'index.ts',
    // SandboxWorker re-imports a few first-party skills to set up the
    // worker's allowlist. That makes security ↔ skills a cycle (skills
    // also depends on security via DelegationSkill et al.). Cycle is
    // pre-existing legacy code; security is therefore not in STRICT
    // pending an inversion-of-control refactor that lets the sandbox
    // declare its skill needs without importing them.
    dependencies: ['tenancy'],
    description: 'Auth, credentials, approvals, rotation.',
  },
  {
    id: 'skills',
    rootDir: 'src/skills',
    publicApi: 'index.ts',
    // SkillManager + WorkflowSkill couple skills with workflows in
    // both directions. That mutual dependency is legacy and needs a
    // real refactor; skills stays out of STRICT for now even though
    // its barrel is wired. Declaring 'workflows' as a dep here would
    // form a cycle with workflows.dependencies=['skills'].
    dependencies: ['agents', 'security', 'persistence'],
    description: 'Skill catalogue + dispatch + sandbox.',
  },
  {
    id: 'agents',
    rootDir: 'src/agents',
    publicApi: 'index.ts',
    dependencies: ['ai', 'persistence'],
    description: 'Agent runtime, organization, personality.',
  },
  {
    id: 'workflows',
    rootDir: 'src/workflows',
    publicApi: 'index.ts',
    dependencies: ['skills', 'security'],
    description: 'WorkflowEngine + JSON workflow executor.',
  },
  {
    id: 'ai',
    rootDir: 'src/ai',
    publicApi: 'index.ts',
    dependencies: ['persistence'],
    description: 'AI provider factory, rate limiter, and persisted decision history.',
  },
  {
    id: 'modules',
    rootDir: 'src/modules',
    publicApi: 'index.ts',
    dependencies: ['tenancy'],
    description: 'Module + service registries; envelope reads tenant context.',
  },
];

/** Build a fast id→def index for the enforcer + ServiceRegistry. */
export function getModule(id: string): ModuleDefinition | undefined {
  return MODULES.find(m => m.id === id);
}

/** All module ids — used for typed registration. */
export type ModuleId = (typeof MODULES)[number]['id'];

/** Returns true when `from` is permitted to import from `to` per the
 *  declared dependencies. Self-imports are always allowed. */
export function importAllowed(from: ModuleId, to: ModuleId): boolean {
  if (from === to) return true;
  const def = MODULES.find(m => m.id === from);
  if (!def) return false;
  return def.dependencies.includes(to);
}

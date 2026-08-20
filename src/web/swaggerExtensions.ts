// Extension of swaggerConfig — adds OpenAPI definitions for the
// hardening-era endpoints (incidents, auth, assets, changes, knowledge,
// runbooks, SLA, reports, problems, plugins, health, metrics, portal).
//
// Kept in a separate file so the original swaggerConfig.ts doesn't grow
// to ~2k lines. The exported `extendSwaggerSpec(spec)` merges these
// schemas + paths into the live `swaggerSpec` produced by
// `swagger-jsdoc`. Idempotent: re-running it is a no-op.

interface OpenApiSpec {
  components?: { schemas?: Record<string, unknown>; securitySchemes?: Record<string, unknown> };
  paths?: Record<string, unknown>;
  tags?: Array<{ name: string; description?: string }>;
}

/** Add the extension paths + schemas to the swagger spec in-place,
 *  return the same object for chaining. Existing entries with the same
 *  key win — we never clobber the curated definitions. */
export function extendSwaggerSpec<T extends OpenApiSpec>(spec: T): T {
  spec.components = spec.components ?? {};
  spec.components.schemas = { ...EXTENSION_SCHEMAS, ...(spec.components.schemas ?? {}) };
  spec.tags = mergeTags(spec.tags ?? [], EXTENSION_TAGS);
  // Existing paths (curated by hand in swaggerConfig) win — extensions
  // only fill in the gaps. Spread order matters: extensions first, then
  // the existing map overwrites the same keys.
  spec.paths = { ...EXTENSION_PATHS, ...(spec.paths ?? {}) };
  return spec;
}

function mergeTags(existing: Array<{ name: string; description?: string }>, extra: Array<{ name: string; description?: string }>): Array<{ name: string; description?: string }> {
  const seen = new Set(existing.map(t => t.name));
  return [...existing, ...extra.filter(t => !seen.has(t.name))];
}

const EXTENSION_TAGS: Array<{ name: string; description?: string }> = [
  { name: 'Incidents',    description: 'Incident lifecycle, comments, timeline, assignment' },
  { name: 'Auth',         description: 'Login, JWT issuance, API keys, session management' },
  { name: 'Assets',       description: 'CMDB asset inventory and relationships' },
  { name: 'Changes',      description: 'Change records, correlation with incidents/runbooks' },
  { name: 'Knowledge',    description: 'Knowledge base articles + full-text search' },
  { name: 'Runbooks',     description: 'Runbook library, runs, approvals' },
  { name: 'SLA',          description: 'SLA policies and per-incident tracking' },
  { name: 'Reports',      description: 'Scheduled reports + on-demand generation' },
  { name: 'Problems',     description: 'Problem records and incident clustering' },
  { name: 'Plugins',      description: 'Integration plugins (Jira, Teams, Slack, etc.)' },
  { name: 'Health',       description: 'Liveness, readiness, and deep-health probes' },
  { name: 'Metrics',      description: 'Prometheus + per-server metrics history' },
  { name: 'Portal',       description: 'Self-service portal endpoints (read-only for requesters)' },
  { name: 'System',       description: 'System context + state-backup + DB hardening operations' },
];

const EXTENSION_SCHEMAS: Record<string, unknown> = {
  Incident: {
    type: 'object',
    properties: {
      id: { type: 'string', example: 'inc-1715607600-abc' },
      title: { type: 'string', example: 'Disk space critical on app-01' },
      description: { type: 'string' },
      severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
      status: { type: 'string', enum: ['open', 'investigating', 'resolved', 'closed'] },
      source: { type: 'string', enum: ['manual', 'alert-rule', 'agent', 'health-monitor', 'portal'] },
      sourceRef: { type: 'string' },
      assignedTo: { type: 'string' },
      assignedAgent: { type: 'string' },
      serverId: { type: 'string' },
      createdBy: { type: 'string' },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
      resolvedAt: { type: 'string', format: 'date-time', nullable: true },
      jiraKey: { type: 'string', nullable: true },
      jiraUrl: { type: 'string', nullable: true },
      aiAnalysis: { type: 'string', nullable: true },
      slaMinutes: { type: 'integer', example: 240 },
      escalationLevel: { type: 'integer', minimum: 0, maximum: 4 },
    },
    required: ['id', 'title', 'severity', 'status', 'source', 'createdAt'],
  },
  IncidentTimelineEntry: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      incidentId: { type: 'string' },
      timestamp: { type: 'string', format: 'date-time' },
      actor: { type: 'string' },
      type: { type: 'string', example: 'note|status_change|assignment|resolve' },
      message: { type: 'string' },
    },
  },
  LoginRequest: {
    type: 'object',
    properties: {
      username: { type: 'string', example: 'operator' },
      password: { type: 'string', format: 'password' },
    },
    required: ['username', 'password'],
  },
  LoginResponse: {
    type: 'object',
    properties: {
      session: {
        type: 'object',
        properties: {
          token: { type: 'string', example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6Ikp...' },
          userId: { type: 'string' },
          username: { type: 'string' },
          roles: { type: 'array', items: { type: 'string' } },
          expiresAt: { type: 'string', format: 'date-time' },
        },
      },
    },
  },
  ApiKey: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      label: { type: 'string' },
      scopes: { type: 'array', items: { type: 'string' } },
      createdAt: { type: 'string', format: 'date-time' },
      lastUsedAt: { type: 'string', format: 'date-time', nullable: true },
    },
  },
  Asset: {
    type: 'object',
    properties: {
      id: { type: 'string', example: 'asset-app-01' },
      name: { type: 'string', example: 'app-01' },
      type: { type: 'string', example: 'server|service|database|loadbalancer' },
      serverId: { type: 'string', nullable: true },
      attributes: { type: 'object', additionalProperties: true },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
    required: ['id', 'name', 'type'],
  },
  AssetRelationship: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      parentId: { type: 'string' },
      childId: { type: 'string' },
      type: { type: 'string', example: 'hosts|runs|depends_on|connects_to' },
    },
  },
  ChangeRecord: {
    type: 'object',
    properties: {
      id: { type: 'string', example: 'chg-1715607600-xyz' },
      title: { type: 'string' },
      type: { type: 'string', example: 'config|deploy|maintenance|emergency' },
      status: { type: 'string', enum: ['draft', 'approved', 'in_progress', 'completed', 'rolled_back', 'failed'] },
      assetId: { type: 'string', nullable: true },
      serverId: { type: 'string', nullable: true },
      author: { type: 'string' },
      summary: { type: 'string' },
      relatedRunbookRunId: { type: 'string', nullable: true },
      createdAt: { type: 'string', format: 'date-time' },
      completedAt: { type: 'string', format: 'date-time', nullable: true },
    },
  },
  KnowledgeArticle: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      title: { type: 'string' },
      body: { type: 'string', description: 'Markdown body' },
      tags: { type: 'array', items: { type: 'string' } },
      status: { type: 'string', enum: ['draft', 'published', 'archived'] },
      author: { type: 'string' },
      usefulCount: { type: 'integer', example: 17 },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
    required: ['id', 'title', 'status'],
  },
  RunbookRun: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      templateId: { type: 'string' },
      status: { type: 'string', enum: ['running', 'completed', 'failed', 'waiting_approval', 'aborted'] },
      startedAt: { type: 'string', format: 'date-time' },
      finishedAt: { type: 'string', format: 'date-time', nullable: true },
      triggeredBy: { type: 'string' },
      inputs: { type: 'object', additionalProperties: true },
      result: { type: 'object', additionalProperties: true, nullable: true },
    },
  },
  RunbookApproval: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      runId: { type: 'string' },
      stepId: { type: 'string' },
      status: { type: 'string', enum: ['pending', 'approved', 'rejected', 'cancelled'] },
      requestedAt: { type: 'string', format: 'date-time' },
      respondedAt: { type: 'string', format: 'date-time', nullable: true },
      respondedBy: { type: 'string', nullable: true },
      reason: { type: 'string', nullable: true },
    },
  },
  SLAPolicy: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
      responseMinutes: { type: 'integer', example: 15 },
      resolutionMinutes: { type: 'integer', example: 240 },
      enabled: { type: 'boolean' },
    },
  },
  SLATracking: {
    type: 'object',
    properties: {
      incidentId: { type: 'string' },
      policyId: { type: 'string' },
      respondBy: { type: 'string', format: 'date-time' },
      resolveBy: { type: 'string', format: 'date-time' },
      respondedAt: { type: 'string', format: 'date-time', nullable: true },
      resolvedAt: { type: 'string', format: 'date-time', nullable: true },
      responseMet: { type: 'boolean', nullable: true },
      resolutionMet: { type: 'boolean', nullable: true },
      breached: { type: 'boolean' },
    },
  },
  Problem: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      title: { type: 'string' },
      status: { type: 'string', enum: ['open', 'investigating', 'resolved'] },
      sourceRefPattern: { type: 'string', nullable: true },
      serverId: { type: 'string', nullable: true },
      firstSeenAt: { type: 'string', format: 'date-time' },
      lastSeenAt: { type: 'string', format: 'date-time' },
      occurrences: { type: 'integer' },
    },
  },
  ReportSchedule: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      cron: { type: 'string', example: '0 8 * * MON' },
      kind: { type: 'string', enum: ['weekly-incidents', 'monthly-incidents', 'sla-summary', 'agent-performance'] },
      enabled: { type: 'boolean' },
      lastRunAt: { type: 'string', format: 'date-time', nullable: true },
      lastError: { type: 'string', nullable: true },
    },
  },
  Plugin: {
    type: 'object',
    properties: {
      id: { type: 'string', example: 'jira' },
      name: { type: 'string', example: 'Jira Cloud' },
      version: { type: 'string', example: '1.0.0' },
      description: { type: 'string' },
      enabled: { type: 'boolean' },
      lastError: { type: 'string', nullable: true },
    },
  },
  HealthReport: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['healthy', 'degraded', 'unhealthy'] },
      timestamp: { type: 'string', format: 'date-time' },
      uptimeSec: { type: 'number' },
      durationMs: { type: 'number' },
      summary: {
        type: 'object',
        properties: {
          pass:  { type: 'integer' },
          warn:  { type: 'integer' },
          fail:  { type: 'integer' },
          total: { type: 'integer' },
        },
      },
      checks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name:       { type: 'string' },
            status:     { type: 'string', enum: ['pass', 'warn', 'fail'] },
            durationMs: { type: 'number' },
            details:    { type: 'object', additionalProperties: true },
            error:      { type: 'string', nullable: true },
          },
        },
      },
    },
  },
  DbStatus: {
    type: 'object',
    properties: {
      databases: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            path: { type: 'string' },
            totalBytes: { type: 'integer' },
            mainBytes: { type: 'integer' },
            walBytes: { type: 'integer' },
            shmBytes: { type: 'integer' },
            status: { type: 'string', enum: ['ok', 'warn', 'fail'] },
            incidentId: { type: 'string', nullable: true },
          },
        },
      },
      backups: {
        type: 'object',
        properties: {
          destRoot: { type: 'string' },
          retentionDays: { type: 'integer' },
          snapshots: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                date: { type: 'string', example: '2026-05-13' },
                bytes: { type: 'integer' },
                files: { type: 'integer' },
                path: { type: 'string' },
              },
            },
          },
        },
      },
      schedule: {
        type: 'object',
        properties: {
          backupCron: { type: 'string', example: '30 3 * * *' },
          vacuumCron: { type: 'string', example: '0 4 * * 0' },
        },
      },
      thresholds: {
        type: 'object',
        properties: {
          warnMB: { type: 'integer' },
          failMB: { type: 'integer' },
        },
      },
    },
  },
};

const SEC_BEARER = [{ BearerAuth: [] as string[] }];

const EXTENSION_PATHS: Record<string, unknown> = {
  // ── Auth ─────────────────────────────────────────────────────────────
  '/auth/login': {
    post: {
      tags: ['Auth'],
      summary: 'Username/password login → JWT session',
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { $ref: '#/components/schemas/LoginRequest' } } },
      },
      responses: {
        '200': { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/LoginResponse' } } } },
        '401': { description: 'Invalid credentials' },
        '429': { description: 'Rate limited' },
      },
    },
  },
  '/auth/logout': {
    post: { tags: ['Auth'], summary: 'Invalidate the current session', security: SEC_BEARER, responses: { '200': { description: 'OK' } } },
  },
  '/auth/me': {
    get: { tags: ['Auth'], summary: 'Current session info', security: SEC_BEARER, responses: { '200': { description: 'OK' }, '401': { description: 'Not authenticated' } } },
  },

  // ── Incidents ────────────────────────────────────────────────────────
  '/incidents': {
    get: {
      tags: ['Incidents'],
      summary: 'List incidents',
      security: SEC_BEARER,
      parameters: [
        { name: 'status',   in: 'query', schema: { type: 'string' } },
        { name: 'severity', in: 'query', schema: { type: 'string' } },
        { name: 'serverId', in: 'query', schema: { type: 'string' } },
        { name: 'limit',    in: 'query', schema: { type: 'integer', default: 100 } },
      ],
      responses: { '200': { description: 'OK', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Incident' } } } } } },
    },
    post: {
      tags: ['Incidents'],
      summary: 'Create incident',
      security: SEC_BEARER,
      requestBody: {
        required: true,
        content: { 'application/json': {
          schema: {
            type: 'object',
            properties: {
              title:       { type: 'string' },
              description: { type: 'string' },
              severity:    { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
              source:      { type: 'string' },
              serverId:    { type: 'string' },
            },
            required: ['title', 'severity'],
          },
        } },
      },
      responses: {
        '200': { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/Incident' } } } },
        '400': { description: 'Validation failed' },
      },
    },
  },
  '/incidents/{id}': {
    get: {
      tags: ['Incidents'], summary: 'Get incident by id', security: SEC_BEARER,
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { '200': { description: 'OK' }, '404': { description: 'Not found' } },
    },
    patch: {
      tags: ['Incidents'], summary: 'Update incident fields', security: SEC_BEARER,
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { '200': { description: 'OK' }, '404': { description: 'Not found' } },
    },
  },
  '/incidents/{id}/comment': {
    post: {
      tags: ['Incidents'], summary: 'Add a comment / timeline note', security: SEC_BEARER,
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { '200': { description: 'OK' } },
    },
  },
  '/incidents/{id}/resolve': {
    post: {
      tags: ['Incidents'], summary: 'Resolve incident', security: SEC_BEARER,
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { '200': { description: 'OK' } },
    },
  },
  '/incidents/{id}/timeline': {
    get: {
      tags: ['Incidents'], summary: 'Get incident timeline', security: SEC_BEARER,
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { '200': { description: 'OK', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/IncidentTimelineEntry' } } } } } },
    },
  },

  // ── Assets / CMDB ────────────────────────────────────────────────────
  '/assets': {
    get:  { tags: ['Assets'], summary: 'List assets', security: SEC_BEARER, responses: { '200': { description: 'OK', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Asset' } } } } } } },
    post: { tags: ['Assets'], summary: 'Create asset', security: SEC_BEARER, responses: { '200': { description: 'OK' }, '400': { description: 'Validation failed' } } },
  },
  '/assets/{id}': {
    get:    { tags: ['Assets'], summary: 'Get asset', security: SEC_BEARER, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' }, '404': { description: 'Not found' } } },
    patch:  { tags: ['Assets'], summary: 'Update asset', security: SEC_BEARER, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } },
    delete: { tags: ['Assets'], summary: 'Delete asset', security: SEC_BEARER, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } },
  },
  '/assets/{id}/relationships': {
    get: { tags: ['Assets'], summary: 'List relationships', security: SEC_BEARER, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } },
    post: { tags: ['Assets'], summary: 'Add relationship', security: SEC_BEARER, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } },
  },
  '/assets/{id}/impact': {
    get: { tags: ['Assets'], summary: 'Compute blast radius for an asset', security: SEC_BEARER, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } },
  },

  // ── Changes ──────────────────────────────────────────────────────────
  '/changes': {
    get: { tags: ['Changes'], summary: 'List change records', security: SEC_BEARER, responses: { '200': { description: 'OK', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/ChangeRecord' } } } } } } },
    post: { tags: ['Changes'], summary: 'Create change record', security: SEC_BEARER, responses: { '200': { description: 'OK' } } },
  },
  '/changes/{id}': {
    get:   { tags: ['Changes'], summary: 'Get change', security: SEC_BEARER, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } },
    patch: { tags: ['Changes'], summary: 'Update change', security: SEC_BEARER, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } },
  },
  '/changes/{id}/correlate': {
    get: { tags: ['Changes'], summary: 'Find incidents/runbook runs correlated with this change', security: SEC_BEARER, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } },
  },

  // ── Knowledge ────────────────────────────────────────────────────────
  '/knowledge/articles': {
    get: { tags: ['Knowledge'], summary: 'List knowledge articles', security: SEC_BEARER, parameters: [{ name: 'status', in: 'query', schema: { type: 'string' } }, { name: 'limit', in: 'query', schema: { type: 'integer' } }], responses: { '200': { description: 'OK', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/KnowledgeArticle' } } } } } } },
    post: { tags: ['Knowledge'], summary: 'Create article', security: SEC_BEARER, responses: { '200': { description: 'OK' } } },
  },
  '/knowledge/articles/{id}': {
    get:    { tags: ['Knowledge'], summary: 'Get article', security: SEC_BEARER, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } },
    patch:  { tags: ['Knowledge'], summary: 'Update article', security: SEC_BEARER, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } },
    delete: { tags: ['Knowledge'], summary: 'Delete article', security: SEC_BEARER, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } },
  },
  '/knowledge/search': {
    get: { tags: ['Knowledge'], summary: 'FTS5 search over knowledge articles', security: SEC_BEARER, parameters: [{ name: 'q', in: 'query', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } },
  },

  // ── Runbooks ─────────────────────────────────────────────────────────
  '/runbooks/library': {
    get: { tags: ['Runbooks'], summary: 'List runbook templates', security: SEC_BEARER, responses: { '200': { description: 'OK' } } },
  },
  '/runbooks/run': {
    post: { tags: ['Runbooks'], summary: 'Start a runbook execution', security: SEC_BEARER, responses: { '200': { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/RunbookRun' } } } } } },
  },
  '/runbooks/runs': {
    get: { tags: ['Runbooks'], summary: 'List recent runbook runs', security: SEC_BEARER, responses: { '200': { description: 'OK' } } },
  },
  '/runbooks/runs/{id}': {
    get: { tags: ['Runbooks'], summary: 'Get a runbook run by id', security: SEC_BEARER, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } },
  },
  '/runbooks/approvals': {
    get: { tags: ['Runbooks'], summary: 'List pending approvals', security: SEC_BEARER, responses: { '200': { description: 'OK', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/RunbookApproval' } } } } } } },
  },
  '/runbooks/approvals/{id}/respond': {
    post: { tags: ['Runbooks'], summary: 'Approve or reject a pending step', security: SEC_BEARER, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } },
  },

  // ── SLA ──────────────────────────────────────────────────────────────
  '/sla/policies': {
    get:  { tags: ['SLA'], summary: 'List SLA policies', security: SEC_BEARER, responses: { '200': { description: 'OK', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/SLAPolicy' } } } } } } },
    post: { tags: ['SLA'], summary: 'Create SLA policy', security: SEC_BEARER, responses: { '200': { description: 'OK' } } },
  },
  '/sla/policies/{id}': {
    patch:  { tags: ['SLA'], summary: 'Update policy', security: SEC_BEARER, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } },
    delete: { tags: ['SLA'], summary: 'Delete policy', security: SEC_BEARER, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } },
  },
  '/sla/tracking': {
    get: { tags: ['SLA'], summary: 'List per-incident SLA tracking', security: SEC_BEARER, responses: { '200': { description: 'OK', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/SLATracking' } } } } } } },
  },
  '/sla/tracking/{incidentId}': {
    get: { tags: ['SLA'], summary: 'SLA tracking for one incident', security: SEC_BEARER, parameters: [{ name: 'incidentId', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } },
  },

  // ── Reports ──────────────────────────────────────────────────────────
  '/reports/schedules': {
    get:  { tags: ['Reports'], summary: 'List report schedules', security: SEC_BEARER, responses: { '200': { description: 'OK', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/ReportSchedule' } } } } } } },
    post: { tags: ['Reports'], summary: 'Create report schedule', security: SEC_BEARER, responses: { '200': { description: 'OK' } } },
  },
  '/reports/generate': {
    post: { tags: ['Reports'], summary: 'Generate a report on demand', security: SEC_BEARER, responses: { '200': { description: 'OK' } } },
  },
  '/reports/history': {
    get: { tags: ['Reports'], summary: 'Recent report generation history', security: SEC_BEARER, responses: { '200': { description: 'OK' } } },
  },

  // ── Problems ─────────────────────────────────────────────────────────
  '/problems': {
    get: { tags: ['Problems'], summary: 'List problems', security: SEC_BEARER, responses: { '200': { description: 'OK', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Problem' } } } } } } },
    post: { tags: ['Problems'], summary: 'Create / promote problem', security: SEC_BEARER, responses: { '200': { description: 'OK' } } },
  },
  '/problems/{id}': {
    get:    { tags: ['Problems'], summary: 'Get problem', security: SEC_BEARER, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } },
    patch:  { tags: ['Problems'], summary: 'Update problem', security: SEC_BEARER, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } },
  },
  '/problems/{id}/incidents': {
    get: { tags: ['Problems'], summary: 'List incidents linked to this problem', security: SEC_BEARER, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } },
  },

  // ── Plugins ──────────────────────────────────────────────────────────
  '/plugins': {
    get: { tags: ['Plugins'], summary: 'List installed integration plugins', security: SEC_BEARER, responses: { '200': { description: 'OK', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Plugin' } } } } } } },
  },
  '/plugins/{id}/enable': {
    post: { tags: ['Plugins'], summary: 'Enable plugin', security: SEC_BEARER, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } },
  },
  '/plugins/{id}/disable': {
    post: { tags: ['Plugins'], summary: 'Disable plugin', security: SEC_BEARER, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } },
  },
  '/plugins/{id}/config': {
    put: { tags: ['Plugins'], summary: 'Update plugin config', security: SEC_BEARER, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } },
  },

  // ── Health ───────────────────────────────────────────────────────────
  '/health': {
    get: {
      tags: ['Health'], summary: 'Deep health probe',
      responses: {
        '200': { description: 'OK / degraded', content: { 'application/json': { schema: { $ref: '#/components/schemas/HealthReport' } } } },
        '503': { description: 'Unhealthy' },
      },
    },
  },
  '/health/ready': {
    get: { tags: ['Health'], summary: 'Readiness probe (200 once boot finished)', responses: { '200': { description: 'Ready' }, '503': { description: 'Not ready' } } },
  },
  '/health/live': {
    get: { tags: ['Health'], summary: 'Liveness probe (200 while the process is alive)', responses: { '200': { description: 'Alive' } } },
  },

  // ── Metrics ──────────────────────────────────────────────────────────
  '/metrics': {
    get: { tags: ['Metrics'], summary: 'Prometheus text-format scrape', responses: { '200': { description: 'Prometheus exposition', content: { 'text/plain': { schema: { type: 'string' } } } } } },
  },
  '/metrics/history/{serverId}': {
    get: { tags: ['Metrics'], summary: 'Historical metric series for a server', security: SEC_BEARER, parameters: [{ name: 'serverId', in: 'path', required: true, schema: { type: 'string' } }, { name: 'metric', in: 'query', required: true, schema: { type: 'string' } }, { name: 'fromMs', in: 'query', schema: { type: 'integer' } }, { name: 'limit', in: 'query', schema: { type: 'integer' } }], responses: { '200': { description: 'OK' } } },
  },

  // ── Portal ───────────────────────────────────────────────────────────
  '/portal/incidents': {
    get: { tags: ['Portal'], summary: 'List incidents created by the current requester', security: SEC_BEARER, responses: { '200': { description: 'OK' } } },
  },
  '/portal/incidents/{id}': {
    get: { tags: ['Portal'], summary: 'Get requester incident', security: SEC_BEARER, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } },
  },
  '/portal/submit': {
    post: { tags: ['Portal'], summary: 'Submit a new ticket from the self-service portal', security: SEC_BEARER, responses: { '200': { description: 'OK' } } },
  },

  // ── System / DB hardening ────────────────────────────────────────────
  '/system/db/status': {
    get: { tags: ['System'], summary: 'SQLite DB sizes + backup snapshot status', security: SEC_BEARER, responses: { '200': { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/DbStatus' } } } } } },
  },
  '/system/db/backup-now': {
    post: { tags: ['System'], summary: 'Trigger an immediate SQLite backup run', security: SEC_BEARER, responses: { '200': { description: 'OK' } } },
  },
  '/system/db/vacuum-now': {
    post: { tags: ['System'], summary: 'Trigger an immediate VACUUM run (heavy)', security: SEC_BEARER, responses: { '200': { description: 'OK' } } },
  },
};

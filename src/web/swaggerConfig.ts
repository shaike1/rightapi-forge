import swaggerJsdoc from 'swagger-jsdoc';

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'RightAPI Forge API',
      version: '1.0.0',
      description: 'REST API for RightAPI Forge - governed AI-driven IT operations platform',
      contact: { name: 'RightAPI Forge', url: process.env.PROJECT_URL || 'http://localhost:19123' },
    },
    servers: [{ url: '/api', description: 'RightAPI Forge API' }],
    tags: [
      { name: 'Agents', description: 'Agent management and status' },
      { name: 'Tasks', description: 'Task lifecycle and assignment' },
      { name: 'Analytics', description: 'Performance metrics and trends' },
      { name: 'Alerts', description: 'Alert rules and evaluation' },
      { name: 'Automation', description: 'Automation rules and agent memory' },
      { name: 'Leaderboard', description: 'Agent performance rankings' },
      { name: 'Integrations', description: 'PagerDuty, GitHub Issues, external services' },
      { name: 'Workflows', description: 'Workflow definitions and executions' },
      { name: 'Runbooks', description: 'Runbook management and execution' },
      { name: 'Mission Control', description: 'Activity timeline and event bus' },
      { name: 'Task Assignment', description: 'Smart task assignment engine' },
      { name: 'Factory', description: 'Agent factory and team creation' },
      { name: 'Reflections', description: 'Stored self-reflections and per-agent performance stats' },
      { name: 'Usage', description: 'Per-agent daily token / tool-call counters and budgets' },
      { name: 'Guardrails', description: 'Circuit breaker state and operator overrides' },
    ],
    components: {
      securitySchemes: {
        BearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        ApiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
      },
      schemas: {
        Agent: {
          type: 'object',
          properties: {
            id: { type: 'string', example: 'agent-alice' },
            name: { type: 'string', example: 'Alice' },
            role: { type: 'string', example: 'SysAdmin' },
            status: { type: 'string', enum: ['idle', 'busy', 'offline'], example: 'idle' },
            skills: { type: 'array', items: { type: 'string' }, example: ['monitoring', 'deployment'] },
          },
        },
        Task: {
          type: 'object',
          properties: {
            id: { type: 'string', example: 'task-001' },
            title: { type: 'string', example: 'Monitor Server Health' },
            status: { type: 'string', enum: ['pending', 'in-progress', 'completed', 'failed'], example: 'in-progress' },
            assignedTo: { type: 'string', example: 'agent-alice' },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
          },
        },
        AlertRule: {
          type: 'object',
          properties: {
            id: { type: 'string', example: 'rule-001' },
            name: { type: 'string', example: 'High Error Rate' },
            enabled: { type: 'boolean', example: true },
            condition: { type: 'string', example: 'errorRate > 0.1' },
            webhookUrl: { type: 'string', example: 'https://hooks.slack.com/...' },
          },
        },
        AnalyticsOverview: {
          type: 'object',
          properties: {
            totalTasks: { type: 'number', example: 120 },
            completedTasks: { type: 'number', example: 98 },
            failedTasks: { type: 'number', example: 5 },
            activeAgents: { type: 'number', example: 6 },
            slaBreachRate: { type: 'number', example: 0.04 },
            avgTaskDurationMs: { type: 'number', example: 18500 },
          },
        },
        AutomationRule: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string', example: 'Restart on Threshold' },
            trigger: { type: 'string', example: 'cpu > 90' },
            action: { type: 'string', example: 'restart_service' },
            enabled: { type: 'boolean', example: true },
          },
        },
        LeaderboardEntry: {
          type: 'object',
          properties: {
            agentId: { type: 'string', example: 'agent-alice' },
            agentName: { type: 'string', example: 'Alice' },
            completedTasks: { type: 'number', example: 42 },
            successRate: { type: 'number', example: 0.97 },
            avgDurationMs: { type: 'number', example: 12000 },
            streak: { type: 'number', example: 7 },
            score: { type: 'number', example: 850 },
          },
        },
        Error: {
          type: 'object',
          properties: {
            error: { type: 'string', example: 'Not found' },
            message: { type: 'string', example: 'The requested resource was not found' },
          },
        },
        Reflection: {
          type: 'object',
          description: 'A self-reflection record an agent wrote after a task. Persisted in agent_reflections.',
          properties: {
            id: { type: 'string', example: 'refl-1730000000-abc123' },
            taskId: { type: 'string', example: 'task-001' },
            taskTitle: { type: 'string', example: 'Investigate firewall outage' },
            agentId: { type: 'string', example: 'agent-alice' },
            selfRating: { type: 'integer', minimum: 1, maximum: 5, example: 3 },
            whatWorked: { type: 'array', items: { type: 'string' }, example: ['used dns first'] },
            whatDidntWork: { type: 'array', items: { type: 'string' }, example: ['too many ping retries'] },
            lessonsLearned: { type: 'array', items: { type: 'string' }, example: ['skip ping if dns resolves'] },
            suggestedImprovements: { type: 'array', items: { type: 'string' } },
            toolEfficiency: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  tool: { type: 'string', example: 'network.dns' },
                  useful: { type: 'boolean', example: true },
                  reason: { type: 'string', example: 'fast' },
                },
              },
            },
            wouldDoDifferently: { type: 'string', example: 'reach for dns first' },
            timestamp: { type: 'string', format: 'date-time' },
          },
        },
        PerformanceStats: {
          type: 'object',
          description: 'Aggregated performance stats derived from agent_reflections.',
          properties: {
            agentId: { type: 'string', example: 'agent-alice' },
            agentName: { type: 'string', example: 'Alice' },
            role: { type: 'string', example: 'sysadmin' },
            totalReflections: { type: 'integer', example: 12 },
            averageRating: { type: 'number', format: 'float', example: 3.4 },
            trend: { type: 'string', enum: ['improving', 'declining', 'stable', 'insufficient'] },
            ratingDistribution: {
              type: 'object',
              description: 'Histogram of ratings 1..5',
              properties: {
                '1': { type: 'integer' }, '2': { type: 'integer' },
                '3': { type: 'integer' }, '4': { type: 'integer' }, '5': { type: 'integer' },
              },
            },
            mostEffectiveTools: {
              type: 'array',
              items: { type: 'object', properties: { tool: { type: 'string' }, usefulCount: { type: 'integer' }, total: { type: 'integer' } } },
            },
            commonFailurePatterns: {
              type: 'array',
              items: { type: 'object', properties: { pattern: { type: 'string' }, count: { type: 'integer' } } },
            },
          },
        },
        DailyUsageRecord: {
          type: 'object',
          properties: {
            date: { type: 'string', example: '2026-05-06' },
            agentId: { type: 'string', example: 'agent-alice' },
            totalTokens: { type: 'integer', example: 12450 },
            totalToolCalls: { type: 'integer', example: 38 },
            totalTasks: { type: 'integer', example: 7 },
            estimatedCostUsd: { type: 'number', format: 'float', example: 0.187 },
          },
        },
        UsageBudget: {
          type: 'object',
          properties: {
            dailyTokens: { type: 'integer', example: 50000 },
            dailyCostUsd: { type: 'number', format: 'float', example: 0.5, nullable: true },
            warnAtFraction: { type: 'number', format: 'float', minimum: 0, maximum: 1, example: 0.8 },
            autoResetDaily: { type: 'boolean', example: true },
          },
        },
        UsageGate: {
          type: 'object',
          description: 'Daily-budget gate consulted before starting a task.',
          properties: {
            allowed: { type: 'boolean', example: true },
            reason: { type: 'string', nullable: true, example: null },
            remainingTokens: { type: 'integer', nullable: true, example: 37550 },
            remainingCostUsd: { type: 'number', format: 'float', nullable: true, example: 0.31 },
          },
        },
        UsageReport: {
          type: 'object',
          properties: {
            agentId: { type: 'string', example: 'agent-alice' },
            agentName: { type: 'string', example: 'Alice' },
            role: { type: 'string', example: 'sysadmin' },
            today: { $ref: '#/components/schemas/DailyUsageRecord' },
            week: {
              type: 'object',
              properties: {
                totalTokens: { type: 'integer' },
                totalToolCalls: { type: 'integer' },
                totalTasks: { type: 'integer' },
                estimatedCostUsd: { type: 'number', format: 'float' },
                days: { type: 'integer' },
              },
            },
            budget: { allOf: [{ $ref: '#/components/schemas/UsageBudget' }], nullable: true },
            gate: { $ref: '#/components/schemas/UsageGate' },
          },
        },
        CircuitBreakerSnapshot: {
          type: 'object',
          properties: {
            skillId: { type: 'string', example: 'web' },
            state: { type: 'string', enum: ['CLOSED', 'OPEN', 'HALF_OPEN'], example: 'OPEN' },
            consecutiveFailures: { type: 'integer', example: 3 },
            lastFailureAt: { type: 'string', format: 'date-time', nullable: true },
            openedAt: { type: 'string', format: 'date-time', nullable: true },
            reopensAfterMs: { type: 'integer', example: 42000 },
            halfOpenInFlight: { type: 'integer', example: 0 },
          },
        },
      },
    },
    paths: {
      '/analytics/overview': {
        get: {
          tags: ['Analytics'],
          summary: 'Get analytics overview',
          description: 'Returns aggregated metrics: task counts, SLA breach rate, active agents.',
          responses: {
            '200': { description: 'Analytics overview', content: { 'application/json': { schema: { $ref: '#/components/schemas/AnalyticsOverview' } } } },
          },
        },
      },
      '/analytics/trends': {
        get: {
          tags: ['Analytics'],
          summary: 'Get task trends over time',
          parameters: [{ name: 'days', in: 'query', schema: { type: 'integer', default: 7 }, description: 'Number of days to look back' }],
          responses: {
            '200': { description: 'Trend data points', content: { 'application/json': { schema: { type: 'array', items: { type: 'object' } } } } },
          },
        },
      },
      '/analytics/sla': {
        get: {
          tags: ['Analytics'],
          summary: 'Get SLA compliance data',
          responses: { '200': { description: 'SLA stats per agent/task type' } },
        },
      },
      '/analytics/export/csv': {
        get: {
          tags: ['Analytics'],
          summary: 'Export analytics as CSV',
          responses: { '200': { description: 'CSV file download', content: { 'text/csv': {} } } },
        },
      },
      '/alerts-mgr/rules': {
        get: {
          tags: ['Alerts'],
          summary: 'List all alert rules',
          responses: { '200': { description: 'Array of alert rules', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/AlertRule' } } } } } },
        },
        post: {
          tags: ['Alerts'],
          summary: 'Create an alert rule',
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/AlertRule' } } } },
          responses: { '201': { description: 'Created rule' }, '400': { description: 'Invalid input' } },
        },
      },
      '/alerts-mgr/rules/{id}': {
        put: {
          tags: ['Alerts'],
          summary: 'Update an alert rule',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/AlertRule' } } } },
          responses: { '200': { description: 'Updated rule' }, '404': { description: 'Rule not found' } },
        },
        delete: {
          tags: ['Alerts'],
          summary: 'Delete an alert rule',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'Deleted' }, '404': { description: 'Rule not found' } },
        },
      },
      '/automation/rules': {
        get: { tags: ['Automation'], summary: 'List automation rules', responses: { '200': { description: 'Array of rules', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/AutomationRule' } } } } } } },
        post: { tags: ['Automation'], summary: 'Create automation rule', requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/AutomationRule' } } } }, responses: { '201': { description: 'Created' } } },
      },
      '/automation/rules/{id}': {
        delete: { tags: ['Automation'], summary: 'Delete automation rule', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Deleted' } } },
        put: { tags: ['Automation'], summary: 'Enable/disable rule', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Updated' } } },
      },
      '/automation/memory/{agentId}': {
        get: { tags: ['Automation'], summary: 'Get agent memory', parameters: [{ name: 'agentId', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Agent memory data' } } },
      },
      '/automation/insights/{agentId}': {
        get: { tags: ['Automation'], summary: 'Get agent learning insights', parameters: [{ name: 'agentId', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Insights and recommendations' } } },
      },
      '/leaderboard': {
        get: {
          tags: ['Leaderboard'],
          summary: 'Get agent performance leaderboard',
          parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', default: 10 } }],
          responses: { '200': { description: 'Ranked agent list', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/LeaderboardEntry' } } } } } },
        },
      },
      '/integrations': {
        get: { tags: ['Integrations'], summary: 'Get integration configurations', responses: { '200': { description: 'Current integration settings' } } },
        put: { tags: ['Integrations'], summary: 'Update integration configuration', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } }, responses: { '200': { description: 'Updated' } } },
      },
      '/integrations/pagerduty/trigger': {
        post: {
          tags: ['Integrations'],
          summary: 'Trigger a PagerDuty incident',
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { title: { type: 'string' }, severity: { type: 'string', enum: ['critical', 'error', 'warning', 'info'] }, summary: { type: 'string' } } } } } },
          responses: { '200': { description: 'Incident triggered' }, '400': { description: 'PagerDuty not configured' } },
        },
      },
      '/integrations/github/issue': {
        post: {
          tags: ['Integrations'],
          summary: 'Create a GitHub issue',
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' }, labels: { type: 'array', items: { type: 'string' } } } } } } },
          responses: { '200': { description: 'Issue created', content: { 'application/json': { schema: { type: 'object', properties: { issueNumber: { type: 'integer' }, url: { type: 'string' } } } } } }, '400': { description: 'GitHub not configured' } },
        },
      },
      '/task-assignment/assign': {
        post: {
          tags: ['Task Assignment'],
          summary: 'Smart-assign a task to the best available agent',
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { taskId: { type: 'string' }, requiredSkills: { type: 'array', items: { type: 'string' } }, priority: { type: 'string', enum: ['low', 'normal', 'high', 'critical'] } }, required: ['taskId'] } } } },
          responses: { '200': { description: 'Assignment result with agent and confidence score' }, '404': { description: 'No suitable agent found' } },
        },
      },
      '/mission-control/timeline': {
        get: {
          tags: ['Mission Control'],
          summary: 'Get activity timeline',
          parameters: [
            { name: 'agentId', in: 'query', schema: { type: 'string' } },
            { name: 'severity', in: 'query', schema: { type: 'string', enum: ['info', 'warning', 'error', 'critical'] } },
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 50 } },
          ],
          responses: { '200': { description: 'Timeline events array' } },
        },
      },

      // ─── Reflections ────────────────────────────────────────────────────
      '/agents/{id}/reflections': {
        get: {
          tags: ['Reflections'],
          summary: 'List stored reflections for an agent',
          description: 'Returns the agent\'s self-reflection records, newest first. Optional rating-range and limit filters.',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 50, minimum: 1, maximum: 500 } },
            { name: 'minRating', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 5 } },
            { name: 'maxRating', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 5 } },
          ],
          responses: {
            '200': {
              description: 'Reflections payload',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      agentId: { type: 'string' },
                      agentName: { type: 'string' },
                      count: { type: 'integer' },
                      reflections: { type: 'array', items: { $ref: '#/components/schemas/Reflection' } },
                    },
                  },
                },
              },
            },
            '404': { description: 'Agent not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          },
        },
      },
      '/agents/{id}/performance': {
        get: {
          tags: ['Reflections'],
          summary: 'Get aggregated performance stats for an agent',
          description: 'Returns total reflections, average rating, recent rating trend (improving / declining / stable / insufficient), rating histogram, top-5 most-effective tools, and top-5 common failure patterns. Returns the empty shape when the agent has no reflections rather than a 404.',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '200': { description: 'Performance stats', content: { 'application/json': { schema: { $ref: '#/components/schemas/PerformanceStats' } } } },
            '404': { description: 'Agent not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          },
        },
      },

      // ─── Usage ──────────────────────────────────────────────────────────
      '/agents/{id}/usage': {
        get: {
          tags: ['Usage'],
          summary: 'Get an agent\'s usage and budget gate',
          description: 'Returns today\'s daily counter, the rolling 7-day summary, the configured budget (if any), and the daily-budget gate state (allowed + remaining figures).',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '200': { description: 'Usage report', content: { 'application/json': { schema: { $ref: '#/components/schemas/UsageReport' } } } },
            '404': { description: 'Agent not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          },
        },
      },
      '/agents/{id}/usage/history': {
        get: {
          tags: ['Usage'],
          summary: 'Get the agent\'s last 7 daily usage records',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '200': {
              description: 'Daily records, newest first',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      agentId: { type: 'string' },
                      agentName: { type: 'string' },
                      days: { type: 'array', items: { $ref: '#/components/schemas/DailyUsageRecord' } },
                    },
                  },
                },
              },
            },
            '404': { description: 'Agent not found' },
          },
        },
      },
      '/agents/{id}/usage/budget': {
        post: {
          tags: ['Usage'],
          summary: 'Set or replace an agent\'s daily usage budget',
          description: 'Sets the daily token cap (required) and optional daily cost cap, warning fraction, and auto-reset flag.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/UsageBudget' },
                example: { dailyTokens: 50000, dailyCostUsd: 0.5, warnAtFraction: 0.8, autoResetDaily: true },
              },
            },
          },
          responses: {
            '200': {
              description: 'Updated budget',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { agentId: { type: 'string' }, budget: { $ref: '#/components/schemas/UsageBudget' } },
                  },
                },
              },
            },
            '400': { description: 'Missing or invalid dailyTokens', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            '404': { description: 'Agent not found' },
          },
        },
      },
      '/agents/{id}/usage/reset': {
        post: {
          tags: ['Usage'],
          summary: 'Reset an agent\'s usage counters',
          description: 'Operator override that drops today\'s counter (default) or all stored counters. Use scope="all" to wipe history.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: false,
            content: {
              'application/json': {
                schema: { type: 'object', properties: { scope: { type: 'string', enum: ['today', 'all'], default: 'today' } } },
              },
            },
          },
          responses: {
            '200': {
              description: 'Reset acknowledged',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      agentId: { type: 'string' },
                      scope: { type: 'string' },
                      today: { $ref: '#/components/schemas/DailyUsageRecord' },
                    },
                  },
                },
              },
            },
            '404': { description: 'Agent not found' },
          },
        },
      },

      // ─── Guardrails / Circuit Breakers ─────────────────────────────────
      '/skills/circuit-breakers': {
        get: {
          tags: ['Guardrails'],
          summary: 'List active circuit breakers',
          description: 'Returns every per-skill circuit breaker that has seen at least one failure (CLOSED + clean breakers are omitted). Used by the dashboard and oncall tooling to spot broken integrations.',
          responses: {
            '200': {
              description: 'Active breakers',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      count: { type: 'integer' },
                      breakers: { type: 'array', items: { $ref: '#/components/schemas/CircuitBreakerSnapshot' } },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/skills/circuit-breakers/{skillId}/reset': {
        post: {
          tags: ['Guardrails'],
          summary: 'Manually reset a tripped circuit breaker',
          description: 'Operator override — closes the breaker, zeroes the consecutive-failure counter, and re-allows traffic immediately. The breaker will trip again on subsequent failures the same way it did the first time.',
          parameters: [{ name: 'skillId', in: 'path', required: true, schema: { type: 'string' }, example: 'web' }],
          responses: {
            '200': {
              description: 'Breaker state after the reset',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      skillId: { type: 'string' },
                      state: { $ref: '#/components/schemas/CircuitBreakerSnapshot' },
                    },
                  },
                },
              },
            },
            '400': { description: 'Missing skillId' },
          },
        },
      },
    },
  },
  apis: [],
};

import { extendSwaggerSpec } from './swaggerExtensions.js';

export const swaggerSpec = extendSwaggerSpec(swaggerJsdoc(options) as any);

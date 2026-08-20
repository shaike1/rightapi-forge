import express, { Request, Response, NextFunction } from 'express';
import { ApiGateway, ApiScope } from '../gateway/ApiGateway.js';

// ── Auth Middleware ─────────────────────────────────────────────────────────

export function apiKeyMiddleware(gateway: ApiGateway) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const authHeader = req.headers['authorization'];
    const plain = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : String(req.headers['x-api-key'] || '');

    if (!plain) {
      res.status(401).json({ error: 'API key required', hint: 'Add Authorization: Bearer <key> header' });
      return;
    }

    const { valid, key, error } = gateway.validateKey(plain);
    if (!valid || !key) {
      res.status(401).json({ error: error || 'Invalid API key' });
      return;
    }

    const rateCheck = gateway.checkRateLimit(key.id, key.rateLimit);
    if (!rateCheck.allowed) {
      res.status(429).json({ error: 'Rate limit exceeded', retryAfter: rateCheck.retryAfter });
      return;
    }

    const start = Date.now();
    (req as any).apiKey = key;

    // Record usage after response
    res.on('finish', () => {
      gateway.recordUsage(key.id, {
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        durationMs: Date.now() - start,
        ip: req.ip || '?'
      });
    });

    next();
  };
}

export function requireScope(gateway: ApiGateway, scope: ApiScope) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = (req as any).apiKey;
    if (!key || !gateway.hasScope(key, scope)) {
      res.status(403).json({ error: 'Insufficient scope', required: scope, granted: key?.scopes });
      return;
    }
    next();
  };
}

// ── Management Router ───────────────────────────────────────────────────────

export function createGatewayRouter(gateway: ApiGateway): express.Router {
  const router = express.Router();

  // Stats (no auth required — internal use)
  router.get('/stats', (_req, res) => {
    res.json(gateway.getStats());
  });

  // List all keys (admin only — no third-party auth, protected by session/UI)
  router.get('/keys', (_req, res) => {
    const keys = gateway.listKeys();
    res.json({ keys: keys.map(k => ({ ...k, key: undefined })), count: keys.length });
  });

  // Create key
  router.post('/keys', (req, res) => {
    const { name, owner, scopes, rateLimit, expiresAt } = req.body;
    if (!name || !owner || !scopes?.length) {
      res.status(400).json({ error: 'name, owner, scopes required' });
      return;
    }
    const { apiKey, plainKey } = gateway.createKey({
      name, owner, scopes,
      rateLimit,
      expiresAt: expiresAt ? new Date(expiresAt) : undefined
    });
    // Return plain key ONCE — can't recover it later
    res.json({ success: true, key: { ...apiKey, key: undefined }, plainKey });
  });

  // Revoke key
  router.post('/keys/:id/revoke', (req, res) => {
    const ok = gateway.revokeKey(String(req.params.id));
    if (!ok) { res.status(404).json({ error: 'Key not found' }); return; }
    res.json({ success: true });
  });

  // Delete key
  router.delete('/keys/:id', (req, res) => {
    const ok = gateway.deleteKey(String(req.params.id));
    if (!ok) { res.status(404).json({ error: 'Key not found' }); return; }
    res.json({ success: true });
  });

  // Request log
  router.get('/requests', (req, res) => {
    const { keyId, limit } = req.query as Record<string, string>;
    const requests = gateway.getRequests({ keyId, limit: limit ? parseInt(limit) : 100 });
    res.json({ requests, count: requests.length });
  });

  // OpenAPI spec
  router.get('/openapi.json', (_req, res) => {
    res.json(buildOpenApiSpec());
  });

  return router;
}

// ── OpenAPI Spec ───────────────────────────────────────────────────────────

function buildOpenApiSpec() {
  const publicUrl = (process.env.PUBLIC_URL || 'http://localhost:19123').replace(/\/$/, '');
  return {
    openapi: '3.0.0',
    info: {
      title: 'RightAPI Forge API',
      version: '1.0.0',
      description: 'REST API for RightAPI Forge - manage tasks, agents, workflows, alerts, and more.',
      contact: { name: 'RightAPI Forge', url: publicUrl }
    },
    servers: [{ url: `${publicUrl}/api/v1`, description: 'Configured deployment' }],
    security: [{ ApiKeyAuth: [] }],
    components: {
      securitySchemes: {
        ApiKeyAuth: { type: 'http', scheme: 'bearer', description: 'API key from /api/gateway/keys' }
      },
      schemas: {
        Task: {
          type: 'object',
          properties: {
            id: { type: 'string' }, title: { type: 'string' },
            status: { type: 'string', enum: ['pending', 'running', 'completed', 'failed'] },
            agentId: { type: 'string' }, priority: { type: 'number' },
            createdAt: { type: 'string', format: 'date-time' }
          }
        },
        Agent: {
          type: 'object',
          properties: {
            id: { type: 'string' }, name: { type: 'string' },
            role: { type: 'string' }, status: { type: 'string' },
            skills: { type: 'array', items: { type: 'string' } }
          }
        },
        Workflow: {
          type: 'object',
          properties: {
            id: { type: 'string' }, name: { type: 'string' },
            version: { type: 'string' }, steps: { type: 'array', items: {} }
          }
        },
        Alert: {
          type: 'object',
          properties: {
            id: { type: 'string' }, title: { type: 'string' },
            severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
            status: { type: 'string', enum: ['open', 'acknowledged', 'resolved'] }
          }
        },
        Error: {
          type: 'object',
          properties: { error: { type: 'string' }, hint: { type: 'string' } }
        }
      }
    },
    paths: {
      '/tasks': {
        get: { summary: 'List tasks', tags: ['Tasks'], security: [{ ApiKeyAuth: [] }],
          parameters: [
            { name: 'status', in: 'query', schema: { type: 'string' } },
            { name: 'agentId', in: 'query', schema: { type: 'string' } },
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 50 } }
          ],
          responses: { '200': { description: 'Task list' }, '401': { description: 'Unauthorized' } }
        },
        post: { summary: 'Create task', tags: ['Tasks'],
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Task' } } } },
          responses: { '200': { description: 'Created task' } }
        }
      },
      '/tasks/{id}': {
        get: { summary: 'Get task', tags: ['Tasks'], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'Task details' }, '404': { description: 'Not found' } }
        }
      },
      '/agents': {
        get: { summary: 'List agents', tags: ['Agents'],
          responses: { '200': { description: 'Agent list' } }
        }
      },
      '/workflows': {
        get: { summary: 'List workflows', tags: ['Workflows'],
          responses: { '200': { description: 'Workflow list' } }
        },
        post: { summary: 'Create workflow', tags: ['Workflows'],
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Workflow' } } } },
          responses: { '200': { description: 'Created workflow' } }
        }
      },
      '/workflows/{id}/execute': {
        post: { summary: 'Execute workflow', tags: ['Workflows'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'Execution started' } }
        }
      },
      '/alerts': {
        get: { summary: 'List alerts', tags: ['Alerts'],
          parameters: [{ name: 'status', in: 'query', schema: { type: 'string' } }],
          responses: { '200': { description: 'Alert list' } }
        }
      },
      '/analytics/snapshot': {
        get: { summary: 'Current system snapshot', tags: ['Analytics'],
          responses: { '200': { description: 'Snapshot data' } }
        }
      }
    }
  };
}

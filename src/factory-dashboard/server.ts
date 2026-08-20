// Factory Dashboard server — thin HTTP + WebSocket proxy in front of the
// control API (default http://127.0.0.1:19123). Serves the Kanban board UI
// at /, forwards every /api/* request through to the control API, and
// proxies the WebSocket on /ws so the browser doesn't need direct access.

import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import { WebSocketServer, WebSocket } from 'ws';
import { logger } from '../utils/logger.js';

const FACTORY_DASHBOARD_PORT = Number(process.env.FACTORY_DASHBOARD_PORT || 19124);
const FACTORY_DASHBOARD_HOST = process.env.FACTORY_DASHBOARD_HOST || '0.0.0.0';
const CONTROL_API_BASE = process.env.CONTROL_API_BASE || 'http://127.0.0.1:19123';

const app = express();
const server = http.createServer(app);

app.use(express.json({ limit: '256kb' }));

function mergedHeaders(req: express.Request): Record<string, string> {
  const headers: Record<string, string> = {};
  const auth = req.header('authorization');
  if (auth) headers.authorization = auth;
  if (req.header('content-type')) headers['content-type'] = req.header('content-type') || 'application/json';
  return headers;
}

/** Forward an HTTP request to the control API and pipe the response back. */
async function proxyRequest(req: express.Request, res: express.Response, targetPath: string): Promise<void> {
  try {
    const upstream = await fetch(`${CONTROL_API_BASE}${targetPath}`, {
      method: req.method,
      headers: mergedHeaders(req),
      body: ['GET', 'HEAD'].includes(req.method.toUpperCase())
        ? undefined
        : JSON.stringify(req.body || {})
    });
    const text = await upstream.text();
    const contentType = upstream.headers.get('content-type') || 'application/json';
    res.status(upstream.status);
    res.setHeader('content-type', contentType);
    res.send(text);
  } catch (error) {
    res.status(502).json({
      error: `Factory dashboard could not reach control API at ${CONTROL_API_BASE}`,
      details: (error as Error).message
    });
  }
}

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'factory-dashboard',
    controlApiBase: CONTROL_API_BASE,
    timestamp: new Date().toISOString()
  });
});

// Generic /api/* proxy. Catches every API request the new Kanban UI makes —
// /api/tasks, /api/agents, /api/agents/:id/reflections, /api/agents/:id/usage,
// /api/skills/circuit-breakers, etc — without enumerating each route.
app.all('/api/*', async (req, res) => {
  // req.originalUrl preserves the query string; req.path strips it.
  const target = req.originalUrl;
  await proxyRequest(req, res, target);
});

// ─── WebSocket forwarding ─────────────────────────────────────────────────
//
// The control API broadcasts task / workflow / delegation events on its
// WebSocket. Browser-side JS opens a WS to /ws on this dashboard, and we
// pipe messages through to the control API and back so the browser never
// needs direct network access to the control host.

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (browserSocket) => {
  let upstream: WebSocket | null = null;
  const upstreamUrl = CONTROL_API_BASE.replace(/^http/, 'ws');
  const queue: string[] = [];
  let upstreamReady = false;

  try {
    upstream = new WebSocket(upstreamUrl);
  } catch (e) {
    browserSocket.close(1011, `failed to connect to control API: ${(e as Error).message}`);
    return;
  }

  upstream.on('open', () => {
    upstreamReady = true;
    while (queue.length > 0) {
      const msg = queue.shift();
      if (msg !== undefined) upstream!.send(msg);
    }
  });

  upstream.on('message', (data) => {
    try { browserSocket.send(data.toString()); } catch { /* socket closed */ }
  });
  upstream.on('error', (err) => {
    try { browserSocket.send(JSON.stringify({ type: 'upstream_error', message: err.message })); } catch { /* */ }
  });
  upstream.on('close', () => browserSocket.close(1011, 'upstream closed'));

  browserSocket.on('message', (data) => {
    const msg = data.toString();
    if (upstreamReady && upstream) upstream.send(msg);
    else queue.push(msg);
  });
  browserSocket.on('close', () => { try { upstream?.close(); } catch { /* */ } });
  browserSocket.on('error', () => { try { upstream?.close(); } catch { /* */ } });
});

// ─── Static dashboard ─────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// dist layout: dist/factory-dashboard/server.js + dist/factory-dashboard/public/*
const PUBLIC_DIR = path.resolve(__dirname, 'public');

app.use('/dashboard-assets', express.static(PUBLIC_DIR, { maxAge: '1h' }));

app.get('/', (_req, res) => {
  try {
    const html = readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
    res.type('html').send(html);
  } catch (e) {
    res.status(500).type('text').send(`Failed to load dashboard: ${(e as Error).message}\nLooked in: ${PUBLIC_DIR}`);
  }
});

server.listen(FACTORY_DASHBOARD_PORT, FACTORY_DASHBOARD_HOST, () => {
  logger.info('Factory Dashboard started');
  logger.info(`URL: http://${FACTORY_DASHBOARD_HOST}:${FACTORY_DASHBOARD_PORT}`);
  logger.info(`Control API: ${CONTROL_API_BASE}`);
});

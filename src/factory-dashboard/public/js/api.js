// HTTP + WebSocket client. All requests go through the dashboard's own
// /api/* proxy (which forwards to the control API), so the browser only
// needs network access to this server.

const TOKEN_KEY = 'beacon.token';
const USER_KEY = 'beacon.user';

export const auth = {
  get token() { return localStorage.getItem(TOKEN_KEY) || ''; },
  set token(v) {
    if (v) localStorage.setItem(TOKEN_KEY, v);
    else localStorage.removeItem(TOKEN_KEY);
  },
  get username() { return localStorage.getItem(USER_KEY) || ''; },
  set username(v) {
    if (v) localStorage.setItem(USER_KEY, v);
    else localStorage.removeItem(USER_KEY);
  },
  clear() { this.token = ''; this.username = ''; },
};

function authHeaders() {
  return auth.token ? { Authorization: `Bearer ${auth.token}` } : {};
}

async function request(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const ct = res.headers.get('content-type') || '';
  const text = await res.text();
  let parsed;
  try { parsed = ct.includes('json') ? JSON.parse(text) : text; }
  catch { parsed = text; }
  if (!res.ok) {
    const err = new Error((parsed && parsed.error) || `HTTP ${res.status}`);
    err.status = res.status;
    err.body = parsed;
    throw err;
  }
  return parsed;
}

export const api = {
  // Auth
  login(username, password) { return request('POST', '/api/auth/login', { username, password }); },

  // Tasks
  listTasks() { return request('GET', '/api/tasks'); },
  createTask(payload) { return request('POST', '/api/task-queue', payload); },
  updateTaskStatus(taskId, status) { return request('PUT', `/api/tasks/${encodeURIComponent(taskId)}/status`, { status }); },
  assignTask(taskId, assignedTo) { return request('PUT', `/api/tasks/${encodeURIComponent(taskId)}/assign`, { assignedTo }); },
  cancelTask(taskId, reason) { return request('POST', `/api/tasks/${encodeURIComponent(taskId)}/cancel`, { reason }); },

  // Agents
  listAgents() { return request('GET', '/api/agents'); },
  agentReflections(agentId, limit = 50) { return request('GET', `/api/agents/${encodeURIComponent(agentId)}/reflections?limit=${limit}`); },
  agentPerformance(agentId) { return request('GET', `/api/agents/${encodeURIComponent(agentId)}/performance`); },
  agentUsage(agentId) { return request('GET', `/api/agents/${encodeURIComponent(agentId)}/usage`); },
  setAgentBudget(agentId, budget) { return request('POST', `/api/agents/${encodeURIComponent(agentId)}/usage/budget`, budget); },
  resetAgentUsage(agentId, scope = 'today') { return request('POST', `/api/agents/${encodeURIComponent(agentId)}/usage/reset`, { scope }); },

  // Guardrails / circuit breakers
  listCircuitBreakers() { return request('GET', '/api/skills/circuit-breakers'); },
  resetCircuitBreaker(skillId) { return request('POST', `/api/skills/circuit-breakers/${encodeURIComponent(skillId)}/reset`, {}); },

  // Workflows (JSON-defined). The visual editor in workflows.js owns
  // the heavy interactions; these are convenience methods exposed for
  // any future caller (e.g. a "list workflows" widget on the board).
  listWorkflows() { return request('GET', '/api/workflows/json'); },
  validateWorkflow(def) { return request('POST', '/api/workflows/json/validate', def); },
  runWorkflow(id, opts = {}) { return request('POST', `/api/workflows/json/${encodeURIComponent(id)}/run`, opts); },

  // RBAC — what is the current caller allowed to do? Used to gate UI
  // affordances (hide buttons the caller can't actually press).
  whoami() { return request('GET', '/api/rbac/whoami'); },
};

// ─── Live event stream over WebSocket ──────────────────────────────────────
//
// The dashboard server proxies our WS connection to the control API, which
// emits task / workflow / delegation events via broadcast(). Subscribers
// register a listener with `on(eventType, handler)`; '*' catches everything.

class LiveEvents extends EventTarget {
  constructor() {
    super();
    this.socket = null;
    this.connected = false;
    this.shouldReconnect = true;
    this.reconnectDelayMs = 1500;
    this.indicators = [];
  }

  connect() {
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/ws`;
    this.socket = new WebSocket(url);
    this.socket.addEventListener('open', () => {
      this.connected = true;
      this.reconnectDelayMs = 1500;
      this.dispatchEvent(new CustomEvent('connection', { detail: { connected: true } }));
      this.indicators.forEach(fn => fn(true));
    });
    this.socket.addEventListener('close', () => {
      this.connected = false;
      this.dispatchEvent(new CustomEvent('connection', { detail: { connected: false } }));
      this.indicators.forEach(fn => fn(false));
      if (this.shouldReconnect) {
        setTimeout(() => this.connect(), this.reconnectDelayMs);
        this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 1.5, 15000);
      }
    });
    this.socket.addEventListener('message', (ev) => {
      let data;
      try { data = JSON.parse(ev.data); } catch { return; }
      const type = data.type || data.event || 'unknown';
      this.dispatchEvent(new CustomEvent(type, { detail: data }));
      this.dispatchEvent(new CustomEvent('*', { detail: data }));
    });
  }

  on(eventType, handler) {
    const wrapped = (ev) => handler(ev.detail);
    this.addEventListener(eventType, wrapped);
    return () => this.removeEventListener(eventType, wrapped);
  }

  send(payload) {
    if (this.connected && this.socket) {
      this.socket.send(JSON.stringify(payload));
    }
  }

  /** Register a callback that fires on every connection state change. */
  onConnectionChange(fn) {
    this.indicators.push(fn);
    fn(this.connected);
  }
}

export const live = new LiveEvents();

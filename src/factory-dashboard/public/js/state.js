// Tiny pub/sub store. The UI subscribes to slices it cares about and gets
// notified when any of its consumed paths change. Keeps board / memory /
// settings views in sync without each one polling or implementing its own
// refresh logic.

import { api, live } from './api.js';

const store = {
  tasks: [],            // Task[]
  agents: [],           // Agent[]
  agentsOnline: 0,
  // Live-activity overlay keyed by taskId. Populated from WebSocket events
  // that mention a task ("task_started", "task_step", "task_completed",
  // "agent_bus_message", etc). Each entry is the most-recent activity blurb.
  taskActivity: {},     // { [taskId]: { agent, step, tool, since, summary } }
  search: '',
  route: 'board',
  loginError: null,
};

const listeners = new Set();
function emit() { listeners.forEach(fn => { try { fn(store); } catch { /* */ } }); }

export const state = {
  get() { return store; },
  subscribe(fn) { listeners.add(fn); fn(store); return () => listeners.delete(fn); },
  set(patch) { Object.assign(store, patch); emit(); },
  patchTaskActivity(taskId, patch) {
    const next = { ...(store.taskActivity[taskId] || {}), ...patch, _ts: Date.now() };
    store.taskActivity = { ...store.taskActivity, [taskId]: next };
    emit();
  },
  setRoute(route) { store.route = route; emit(); },
  setSearch(q) { store.search = q || ''; emit(); },
};

// ─── Loaders ───────────────────────────────────────────────────────────────

export async function refreshTasks() {
  try {
    const tasks = await api.listTasks();
    state.set({ tasks: Array.isArray(tasks) ? tasks : [] });
  } catch (e) {
    if (e?.status !== 401) console.warn('refreshTasks failed', e);
  }
}

export async function refreshAgents() {
  try {
    const data = await api.listAgents();
    // /api/agents response shape is `{ director, sysadmins, specialists }`
    // OR a flat array depending on how the control API was registered. Handle both.
    let list = [];
    if (Array.isArray(data)) list = data;
    else if (data && typeof data === 'object') {
      if (data.director) list.push(data.director);
      if (Array.isArray(data.sysadmins)) list = list.concat(data.sysadmins);
      if (Array.isArray(data.specialists)) list = list.concat(data.specialists);
    }
    state.set({ agents: list, agentsOnline: list.filter(a => (a.status ?? 'active') !== 'inactive').length });
  } catch (e) {
    if (e?.status !== 401) console.warn('refreshAgents failed', e);
  }
}

// ─── Wire WebSocket events into the store ─────────────────────────────────

export function bindLiveEvents() {
  // Connection-state indicator (sidebar dot).
  live.onConnectionChange(() => emit());

  // Any "task_*" message refreshes that task's activity blurb. The control
  // API uses several event names — task_completed / task_failed /
  // task_step / agent_bus_message — so we treat type as the verb.
  live.on('*', (data) => {
    const type = data.type;
    const payload = data.data || data;
    if (!type) return;

    // Task-scoped events: pull taskId from common shapes.
    const taskId = payload.taskId || payload.task?.id;

    if (taskId && /^task_/.test(type)) {
      state.patchTaskActivity(taskId, {
        agent: payload.agentName || payload.agentId || payload.task?.assignedTo || undefined,
        step: humaniseStep(type, payload),
        tool: payload.tool || payload.skill || undefined,
        summary: payload.message || payload.result || payload.error || undefined,
      });
      // Terminal events trigger a tasks refresh so columns reflect server state.
      if (type === 'task_completed' || type === 'task_failed') {
        // Stagger slightly so the server has flushed its DB update first.
        setTimeout(() => refreshTasks(), 200);
      }
    }

    // Agent-bus messages carry a taskId in their content; surface them as
    // activity steps if so.
    if (type === 'agent_bus_message' && payload.taskId) {
      state.patchTaskActivity(payload.taskId, {
        agent: payload.fromAgentId,
        step: 'thinking',
        summary: typeof payload.content === 'string' ? payload.content.slice(0, 80) : undefined,
      });
    }

    // Workflow-stage events refresh task list (status may change).
    if (type === 'workflow_stage_active' || type === 'workflow_completed') {
      setTimeout(() => refreshTasks(), 200);
    }
  });
}

function humaniseStep(eventType, payload) {
  switch (eventType) {
    case 'task_started':   return 'thinking';
    case 'task_step':      return payload.tool ? `running: ${payload.tool}` : 'thinking';
    case 'task_completed': return 'completed';
    case 'task_failed':    return 'failed';
    case 'task_assigned':  return 'assigned';
    default: return eventType.replace(/^task_/, '');
  }
}

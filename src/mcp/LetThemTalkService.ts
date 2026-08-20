import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';

const DATA_DIR = process.env.AGENT_BRIDGE_DATA_DIR || '/data/itops-agents/agent-bridge';

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function sanitizeName(name: string): string {
  if (!/^[a-zA-Z0-9_-]{1,20}$/.test(name))
    throw new Error(`Invalid agent name: ${name}`);
  return name;
}

export interface BridgeAgent {
  name: string;
  registered_at: string;
  last_seen: string;
  status: 'online' | 'offline';
  role?: string;
}

export interface BridgeMessage {
  id: string;
  from: string;
  to: string; // 'all' for broadcast
  content: string;
  type: 'message' | 'task' | 'broadcast' | 'handoff';
  timestamp: string;
  read?: boolean;
}

export interface BridgeTask {
  id: string;
  title: string;
  assigned_to: string;
  assigned_by: string;
  status: 'pending' | 'in_progress' | 'done' | 'failed';
  created_at: string;
  updated_at: string;
}

const MESSAGES_FILE = path.join(DATA_DIR, 'messages.jsonl');
const AGENTS_FILE = path.join(DATA_DIR, 'agents.json');
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');

export const bridgeEvents = new EventEmitter();

export function getAgents(): BridgeAgent[] {
  ensureDir();
  if (!fs.existsSync(AGENTS_FILE)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf8'));
    // let-them-talk stores agents as object keyed by name
    if (Array.isArray(data)) return data;
    return Object.entries(data).map(([name, info]: [string, any]) => ({
      name,
      registered_at: info.registered_at || info.created_at || new Date().toISOString(),
      last_seen: info.last_seen || info.registered_at || new Date().toISOString(),
      status: info.status || 'offline',
      role: info.role || '',
    }));
  } catch { return []; }
}

export function registerAgent(name: string, role?: string): BridgeAgent {
  sanitizeName(name);
  ensureDir();
  const agents: Record<string, any> = {};
  if (fs.existsSync(AGENTS_FILE)) {
    try { Object.assign(agents, JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf8'))); } catch {}
  }
  const now = new Date().toISOString();
  agents[name] = {
    ...agents[name],
    registered_at: agents[name]?.registered_at || now,
    last_seen: now,
    status: 'online',
    role: role || agents[name]?.role || '',
  };
  fs.writeFileSync(AGENTS_FILE, JSON.stringify(agents, null, 2));
  bridgeEvents.emit('agent_registered', { name, ...agents[name] });
  return { name, ...agents[name] };
}

export function heartbeatAgent(name: string) {
  sanitizeName(name);
  if (!fs.existsSync(AGENTS_FILE)) return;
  try {
    const agents = JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf8'));
    if (agents[name]) {
      agents[name].last_seen = new Date().toISOString();
      agents[name].status = 'online';
      fs.writeFileSync(AGENTS_FILE, JSON.stringify(agents, null, 2));
    }
  } catch {}
}

export function sendMessage(from: string, to: string, content: string, type: BridgeMessage['type'] = 'message'): BridgeMessage {
  sanitizeName(from);
  if (to !== 'all') sanitizeName(to);
  ensureDir();
  const msg: BridgeMessage = {
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    from,
    to,
    content,
    type,
    timestamp: new Date().toISOString(),
    read: false,
  };
  fs.appendFileSync(MESSAGES_FILE, JSON.stringify(msg) + '\n');
  bridgeEvents.emit('message', msg);
  return msg;
}

export function getMessages(filter?: { to?: string; from?: string; since?: string; limit?: number }): BridgeMessage[] {
  if (!fs.existsSync(MESSAGES_FILE)) return [];
  const lines = fs.readFileSync(MESSAGES_FILE, 'utf8').split('\n').filter(Boolean);
  let msgs: BridgeMessage[] = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  if (filter?.from) msgs = msgs.filter(m => m.from === filter.from);
  if (filter?.to) msgs = msgs.filter(m => m.to === filter.to || m.to === 'all');
  if (filter?.since) msgs = msgs.filter(m => m.timestamp > filter.since!);
  if (filter?.limit) msgs = msgs.slice(-filter.limit);
  return msgs;
}

export function getTasks(): BridgeTask[] {
  if (!fs.existsSync(TASKS_FILE)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
    if (Array.isArray(data)) return data;
    return Object.values(data);
  } catch { return []; }
}

export function createTask(title: string, assignedTo: string, assignedBy: string): BridgeTask {
  sanitizeName(assignedTo);
  sanitizeName(assignedBy);
  ensureDir();
  const tasks: Record<string, any> = {};
  if (fs.existsSync(TASKS_FILE)) {
    try { Object.assign(tasks, JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'))); } catch {}
  }
  const now = new Date().toISOString();
  const task: BridgeTask = {
    id: `task-${Date.now()}`,
    title,
    assigned_to: assignedTo,
    assigned_by: assignedBy,
    status: 'pending',
    created_at: now,
    updated_at: now,
  };
  tasks[task.id] = task;
  fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2));
  // Also send a task message on the bridge
  sendMessage(assignedBy, assignedTo, `Task assigned: ${title}`, 'task');
  bridgeEvents.emit('task_created', task);
  return task;
}

export function updateTaskStatus(taskId: string, status: BridgeTask['status']): BridgeTask | null {
  if (!fs.existsSync(TASKS_FILE)) return null;
  try {
    const tasks = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
    if (!tasks[taskId]) return null;
    tasks[taskId].status = status;
    tasks[taskId].updated_at = new Date().toISOString();
    fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2));
    bridgeEvents.emit('task_updated', tasks[taskId]);
    return tasks[taskId];
  } catch { return null; }
}

// Register all operations agents on startup
export function bootstrapITOpsAgents(agentNames: string[]) {
  for (const name of agentNames) {
    try { registerAgent(name, 'itops-agent'); } catch {}
  }
}

// Watch for new messages (SSE support)
let watcherStarted = false;
export function startFileWatcher() {
  if (watcherStarted) return;
  watcherStarted = true;
  ensureDir();
  let lastSize = fs.existsSync(MESSAGES_FILE) ? fs.statSync(MESSAGES_FILE).size : 0;
  setInterval(() => {
    if (!fs.existsSync(MESSAGES_FILE)) return;
    const size = fs.statSync(MESSAGES_FILE).size;
    if (size > lastSize) {
      const content = fs.readFileSync(MESSAGES_FILE, 'utf8');
      const newLines = content.slice(lastSize).split('\n').filter(Boolean);
      lastSize = size;
      for (const line of newLines) {
        try { bridgeEvents.emit('new_message', JSON.parse(line)); } catch {}
      }
    }
  }, 1000);
}

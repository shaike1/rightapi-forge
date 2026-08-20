// Kanban board page.
//
//   BACKLOG ↔ pending
//   IN PROGRESS ↔ assigned + in_progress
//   REVIEW ↔ blocked
//   DONE ↔ completed
//
// Drag-and-drop is native HTML5 (draggable=true, dragstart/dragover/drop) —
// no library needed for a board this size. On drop, we PUT the new status
// to the control API; the WebSocket then broadcasts confirmation back so
// every connected client converges to the same view.

import { api } from './api.js';
import { state, refreshTasks } from './state.js';

const COLUMNS = [
  { id: 'backlog',     label: 'Backlog',     status: 'pending',     accent: 'border-text-dim' },
  { id: 'in_progress', label: 'In Progress', status: 'in_progress', accent: 'border-accent-500' },
  { id: 'review',      label: 'Review',      status: 'blocked',     accent: 'border-warn' },
  { id: 'done',        label: 'Done',        status: 'completed',   accent: 'border-ok' },
];

/** Map a task's server-side status to its visible column id. */
function columnForTask(task) {
  const s = String(task.status || '').toLowerCase();
  if (s === 'in_progress' || s === 'assigned') return 'in_progress';
  if (s === 'blocked') return 'review';
  if (s === 'completed') return 'done';
  if (s === 'failed' || s === 'cancelled' || s === 'dropped' || s === 'rolled_back') return 'done'; // terminal — show as done
  return 'backlog'; // pending / unknown
}

/** Reverse map: column id → server status to PUT on drop. */
function statusForColumn(columnId) {
  const c = COLUMNS.find(c => c.id === columnId);
  return c ? c.status : 'pending';
}

const PRIORITY_BADGE = {
  critical: 'bg-danger/15 text-danger border border-danger/40',
  high:     'bg-danger/15 text-danger border border-danger/40',
  medium:   'bg-warn/15 text-warn border border-warn/40',
  low:      'bg-ok/15 text-ok border border-ok/40',
};

// ─── Render ────────────────────────────────────────────────────────────────

export function renderBoard(rootEl) {
  rootEl.innerHTML = '';

  const wrap = document.createElement('div');
  wrap.className = 'p-6 h-full flex flex-col';
  wrap.innerHTML = `
    <div class="flex items-center gap-3 mb-5">
      <h2 class="text-xl font-semibold tracking-tight">Development Board</h2>
      <span class="text-text-dim text-sm">·</span>
      <span class="text-sm text-text-muted">Drop a card on <span class="text-accent-400">In Progress</span> to assign an agent.</span>
      <button id="new-task-btn" class="ml-auto inline-flex items-center gap-2 px-3 py-1.5 bg-accent-600 hover:bg-accent-500 rounded-md text-xs font-medium transition">
        <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>
        <span>New task</span>
      </button>
    </div>
    <div id="kanban-grid" class="grid grid-cols-4 gap-4 flex-1 min-h-0"></div>
  `;
  rootEl.appendChild(wrap);

  const grid = wrap.querySelector('#kanban-grid');
  const dragState = { taskId: null, sourceColumn: null };

  COLUMNS.forEach(col => {
    const el = document.createElement('section');
    el.className = `flex flex-col bg-base-900 border border-line rounded-lg overflow-hidden`;
    el.dataset.columnId = col.id;
    el.innerHTML = `
      <header class="flex items-center justify-between px-3 py-2 border-b border-line bg-base-850">
        <div class="flex items-center gap-2">
          <span class="w-2 h-2 rounded-full ${col.id === 'in_progress' ? 'bg-accent-500' : col.id === 'review' ? 'bg-warn' : col.id === 'done' ? 'bg-ok' : 'bg-text-dim'}"></span>
          <span class="text-[11px] font-semibold tracking-wider uppercase text-text-muted">${col.label}</span>
          <span class="text-[10px] px-1.5 py-0.5 rounded bg-base-800 text-text-dim count-badge">0</span>
        </div>
      </header>
      <div class="flex-1 overflow-y-auto scroll-thin px-2 py-2 space-y-2 column-cards"></div>
    `;
    grid.appendChild(el);

    // Drag-over highlight + drop handling.
    el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('col-dropping'); });
    el.addEventListener('dragleave', () => el.classList.remove('col-dropping'));
    el.addEventListener('drop', async (e) => {
      e.preventDefault();
      el.classList.remove('col-dropping');
      const taskId = dragState.taskId;
      const sourceCol = dragState.sourceColumn;
      const targetCol = col.id;
      if (!taskId || !sourceCol || sourceCol === targetCol) return;
      const newStatus = statusForColumn(targetCol);
      try {
        await api.updateTaskStatus(taskId, newStatus);
        await refreshTasks();
      } catch (err) {
        console.error('drop → status update failed', err);
        // Optimistic visual rollback: refresh re-renders from server truth.
        await refreshTasks();
        notify(`Could not move task: ${err.message}`, 'danger');
      }
    });
  });

  // Subscribe to state for re-rendering cards.
  const unsubscribe = state.subscribe(({ tasks, taskActivity, search }) => {
    const filtered = applySearch(tasks, search);
    const byColumn = { backlog: [], in_progress: [], review: [], done: [] };
    for (const t of filtered) byColumn[columnForTask(t)].push(t);

    grid.querySelectorAll('section[data-column-id]').forEach(section => {
      const colId = section.dataset.columnId;
      const cards = byColumn[colId] || [];
      const list = section.querySelector('.column-cards');
      const count = section.querySelector('.count-badge');
      count.textContent = String(cards.length);
      list.innerHTML = '';
      if (cards.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'text-center text-text-dim text-xs py-8';
        empty.textContent = colId === 'backlog' ? 'No backlog items. Create a task →' : 'Empty';
        list.appendChild(empty);
      } else {
        cards.forEach(task => list.appendChild(buildCard(task, colId, dragState, taskActivity[task.id])));
      }
    });
  });

  // "New task" → modal
  wrap.querySelector('#new-task-btn').addEventListener('click', () => openTaskModal());

  // Initial fetch
  refreshTasks();

  return () => unsubscribe();
}

function applySearch(tasks, q) {
  if (!q) return tasks;
  const needle = q.toLowerCase();
  return tasks.filter(t =>
    String(t.title || '').toLowerCase().includes(needle) ||
    String(t.description || '').toLowerCase().includes(needle) ||
    String(t.id || '').toLowerCase().includes(needle) ||
    (Array.isArray(t.tags) && t.tags.some(tag => String(tag).toLowerCase().includes(needle)))
  );
}

// ─── Card rendering ───────────────────────────────────────────────────────

function buildCard(task, colId, dragState, activity) {
  const el = document.createElement('article');
  el.className = 'card group bg-base-850 border border-line hover:border-accent-500/60 rounded-md p-3 cursor-grab active:cursor-grabbing transition';
  el.draggable = true;
  el.dataset.taskId = task.id;

  const idShort = (task.id || '').slice(0, 8);
  const priority = String(task.priority || 'medium').toLowerCase();
  const priorityClass = PRIORITY_BADGE[priority] || PRIORITY_BADGE.medium;
  const tags = Array.isArray(task.tags) ? task.tags.slice(0, 4) : [];
  const description = (task.description || '').slice(0, 200);

  el.innerHTML = `
    <div class="flex items-start gap-2">
      <span class="text-[10px] font-mono text-text-dim tracking-wider">${escapeHtml(idShort)}</span>
      <span class="ml-auto inline-flex items-center text-[10px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded ${priorityClass}">${escapeHtml(priority)}</span>
    </div>
    <h3 class="mt-2 text-sm font-semibold leading-snug text-text-primary line-clamp-2">${escapeHtml(task.title || '(untitled)')}</h3>
    ${description ? `<p class="mt-1.5 text-xs text-text-muted line-clamp-2">${escapeHtml(description)}</p>` : ''}
    ${tags.length > 0 ? `
      <div class="mt-2 flex flex-wrap gap-1">
        ${tags.map(t => `<span class="text-[10px] px-1.5 py-0.5 rounded bg-base-800 border border-line text-text-muted">${escapeHtml(String(t))}</span>`).join('')}
      </div>` : ''}
    ${colId === 'in_progress' ? renderActivityRow(task, activity) : ''}
    <div class="mt-2 flex items-center justify-between text-[11px] text-text-dim">
      <span>${task.assignedTo ? `→ ${escapeHtml(String(task.assignedTo).slice(0, 12))}` : 'unassigned'}</span>
      <span>${formatRelative(task.updatedAt || task.createdAt)}</span>
    </div>
  `;

  el.addEventListener('dragstart', (e) => {
    dragState.taskId = task.id;
    dragState.sourceColumn = colId;
    el.classList.add('card-dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', task.id); } catch { /* */ }
  });
  el.addEventListener('dragend', () => {
    dragState.taskId = null;
    dragState.sourceColumn = null;
    el.classList.remove('card-dragging');
  });
  el.addEventListener('click', () => openTaskModal(task));

  return el;
}

function renderActivityRow(task, activity) {
  if (!activity) {
    return `
      <div class="mt-2 flex items-center gap-2 text-[11px] text-text-dim border-t border-line pt-2">
        <span class="w-1.5 h-1.5 rounded-full bg-text-dim"></span>
        <span>idle</span>
      </div>`;
  }
  const stepLabel = activity.tool ? `${escapeHtml(activity.step || 'running')}: ${escapeHtml(activity.tool)}` :
                    activity.step ? escapeHtml(activity.step) : 'thinking';
  const elapsed = activity._ts ? formatRelative(new Date(activity._ts).toISOString()) : '';
  const summary = activity.summary ? `<div class="mt-1 text-[10px] text-text-dim line-clamp-1">${escapeHtml(String(activity.summary))}</div>` : '';
  return `
    <div class="mt-2 border-t border-line pt-2">
      <div class="flex items-center gap-2 text-[11px]">
        <span class="activity-dot w-1.5 h-1.5 rounded-full bg-accent-400"></span>
        <span class="font-mono text-accent-400 truncate">${stepLabel}</span>
        <span class="ml-auto text-text-dim">${elapsed}</span>
      </div>
      ${summary}
    </div>`;
}

// ─── Task creation modal ───────────────────────────────────────────────────

const CATEGORIES = ['monitoring','infrastructure','deployment','security','microsoft365','service-management','general'];
const PRIORITIES = ['low','medium','high','critical'];

export function openTaskModal(existingTask) {
  const root = document.getElementById('modal-root');
  const isView = !!existingTask;
  root.innerHTML = `
    <div class="fixed inset-0 modal-backdrop flex items-center justify-center z-50">
      <div class="bg-base-900 border border-line rounded-xl w-[520px] max-w-[92vw] shadow-2xl overflow-hidden">
        <header class="flex items-center justify-between px-5 py-3.5 border-b border-line">
          <h3 class="font-semibold text-sm">${isView ? 'Task details' : 'New task'}</h3>
          <button class="modal-close text-text-dim hover:text-text-primary" aria-label="Close">✕</button>
        </header>
        <div class="px-5 py-4 space-y-3 text-sm">
          ${isView ? `
            <div class="text-xs font-mono text-text-dim">${escapeHtml(existingTask.id)}</div>
            <h4 class="text-base font-semibold">${escapeHtml(existingTask.title || '')}</h4>
            <div class="text-text-muted whitespace-pre-wrap">${escapeHtml(existingTask.description || '(no description)')}</div>
            <div class="grid grid-cols-2 gap-3 pt-2 text-xs">
              <div><span class="text-text-dim">Status</span><div class="font-mono">${escapeHtml(existingTask.status)}</div></div>
              <div><span class="text-text-dim">Priority</span><div>${escapeHtml(existingTask.priority || 'medium')}</div></div>
              <div><span class="text-text-dim">Category</span><div>${escapeHtml(existingTask.category || '-')}</div></div>
              <div><span class="text-text-dim">Owner</span><div class="font-mono">${escapeHtml(String(existingTask.ownerId || '').slice(0, 14)) || '-'}</div></div>
              <div><span class="text-text-dim">Assigned</span><div class="font-mono">${escapeHtml(String(existingTask.assignedTo || '').slice(0, 14)) || 'unassigned'}</div></div>
              <div><span class="text-text-dim">Updated</span><div>${formatRelative(existingTask.updatedAt)}</div></div>
            </div>
            ${Array.isArray(existingTask.tags) && existingTask.tags.length > 0 ? `
              <div class="flex flex-wrap gap-1 pt-2">
                ${existingTask.tags.map(t => `<span class="text-[10px] px-1.5 py-0.5 rounded bg-base-800 border border-line text-text-muted">${escapeHtml(String(t))}</span>`).join('')}
              </div>` : ''}
            ${existingTask.result ? `<div class="pt-2 text-xs"><span class="text-text-dim">Result</span><pre class="mt-1 p-2 bg-base-850 rounded border border-line text-text-muted overflow-auto max-h-40 whitespace-pre-wrap font-mono text-[11px]">${escapeHtml(existingTask.result)}</pre></div>` : ''}
          ` : `
            <label class="block">
              <span class="block text-text-muted text-xs mb-1">Title <span class="text-danger">*</span></span>
              <input id="t-title" type="text" required class="w-full bg-base-850 border border-line rounded-md px-3 py-2 focus:outline-none focus:border-accent-500" />
            </label>
            <label class="block">
              <span class="block text-text-muted text-xs mb-1">Description</span>
              <textarea id="t-desc" rows="3" class="w-full bg-base-850 border border-line rounded-md px-3 py-2 focus:outline-none focus:border-accent-500"></textarea>
            </label>
            <div class="grid grid-cols-2 gap-3">
              <label class="block">
                <span class="block text-text-muted text-xs mb-1">Priority</span>
                <select id="t-prio" class="w-full bg-base-850 border border-line rounded-md px-3 py-2 focus:outline-none focus:border-accent-500">
                  ${PRIORITIES.map(p => `<option value="${p}"${p === 'medium' ? ' selected' : ''}>${p}</option>`).join('')}
                </select>
              </label>
              <label class="block">
                <span class="block text-text-muted text-xs mb-1">Category</span>
                <select id="t-cat" class="w-full bg-base-850 border border-line rounded-md px-3 py-2 focus:outline-none focus:border-accent-500">
                  ${CATEGORIES.map(c => `<option value="${c}"${c === 'monitoring' ? ' selected' : ''}>${c}</option>`).join('')}
                </select>
              </label>
            </div>
            <label class="block">
              <span class="block text-text-muted text-xs mb-1">Tags <span class="text-text-dim">(comma-separated)</span></span>
              <input id="t-tags" type="text" placeholder="alert, on-call, p1" class="w-full bg-base-850 border border-line rounded-md px-3 py-2 focus:outline-none focus:border-accent-500" />
            </label>
          `}
        </div>
        <footer class="flex items-center justify-end gap-2 px-5 py-3 border-t border-line bg-base-850">
          <button class="modal-close px-3 py-1.5 text-sm text-text-muted hover:text-text-primary">${isView ? 'Close' : 'Cancel'}</button>
          ${!isView ? `<button id="t-create" class="px-3 py-1.5 bg-accent-600 hover:bg-accent-500 rounded-md text-sm font-medium">Create task</button>` : ''}
        </footer>
      </div>
    </div>
  `;

  const close = () => { root.innerHTML = ''; };
  root.querySelectorAll('.modal-close').forEach(b => b.addEventListener('click', close));
  root.addEventListener('click', (e) => { if (e.target === root.firstElementChild) close(); });

  const createBtn = root.querySelector('#t-create');
  if (createBtn) {
    createBtn.addEventListener('click', async () => {
      const title = root.querySelector('#t-title').value.trim();
      if (!title) { notify('Title is required', 'warn'); return; }
      const desc = root.querySelector('#t-desc').value.trim();
      const prio = root.querySelector('#t-prio').value;
      const cat = root.querySelector('#t-cat').value;
      const tagsRaw = root.querySelector('#t-tags').value;
      const tags = tagsRaw.split(',').map(s => s.trim()).filter(Boolean);
      try {
        await api.createTask({
          title, description: desc, priority: prio, category: cat, tags,
        });
        close();
        await refreshTasks();
      } catch (err) {
        notify(`Could not create task: ${err.message}`, 'danger');
      }
    });
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function escapeHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatRelative(iso) {
  if (!iso) return '';
  const t = typeof iso === 'string' ? Date.parse(iso) : new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const d = Date.now() - t;
  if (d < 0) return 'just now';
  const s = Math.floor(d / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24); return `${days}d ago`;
}

function notify(message, kind = 'info') {
  const colors = { info: 'bg-accent-600', warn: 'bg-warn', danger: 'bg-danger' };
  const el = document.createElement('div');
  el.className = `fixed bottom-5 right-5 px-4 py-2 rounded-md text-sm font-medium shadow-lg z-50 ${colors[kind] || colors.info}`;
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

export const _internals = { columnForTask, statusForColumn, applySearch };

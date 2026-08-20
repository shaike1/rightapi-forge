// Learned Skills page — list crystallized skills + lifecycle controls.
//
// Layout (matches the existing dashboard's three-pane convention):
//
//   ┌────────────┬─────────────────────────────────────────────────────────┐
//   │  Filters   │ Stats row (counts, usage, avg confidence, success rate)│
//   │  + Status  ├─────────────────────────────────────────────────────────┤
//   │  + Tag     │ Table: skills × {status, confidence, usage, controls}  │
//   │  + Refresh │                                                         │
//   └────────────┴─────────────────────────────────────────────────────────┘

import { auth } from './api.js';

async function http(method, url, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth.token) headers.Authorization = `Bearer ${auth.token}`;
  const res = await fetch(url, {
    method, headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const ct = res.headers.get('content-type') || '';
  const text = await res.text();
  let parsed; try { parsed = ct.includes('json') ? JSON.parse(text) : text; } catch { parsed = text; }
  if (!res.ok) {
    const err = new Error((parsed && parsed.error) || `HTTP ${res.status}`);
    err.body = parsed;
    throw err;
  }
  return parsed;
}

const STATUS_COLOURS = {
  draft:    { dot: '#f5a62a', text: 'text-warn'  },
  approved: { dot: '#7cc4ff', text: 'text-accent-400' },
  active:   { dot: '#42d392', text: 'text-ok'    },
  rejected: { dot: '#ff5d6c', text: 'text-danger'},
};

let state = {
  skills: [],
  stats: null,
  filters: { status: '', tag: '' },
};

export function renderCrystallized(rootEl) {
  rootEl.innerHTML = `
    <div class="grid h-full" style="grid-template-columns: 240px 1fr;">

      <!-- ─── Filters rail ───────────────────────────────────── -->
      <aside class="border-r border-line bg-base-900 overflow-y-auto scroll-thin">
        <div class="px-4 py-3 border-b border-line">
          <div class="text-xs uppercase tracking-wide text-text-dim mb-1">Learned Skills</div>
          <div class="text-[11px] text-text-dim">Auto-crystallized from successful resolutions.</div>
        </div>

        <div class="p-4 space-y-4 text-sm">
          <label class="block">
            <span class="block text-[11px] uppercase tracking-wide text-text-dim mb-1">Status</span>
            <select id="cs-status" class="w-full bg-base-850 border border-line rounded-md px-2 py-1.5 text-xs focus:outline-none focus:border-accent-500">
              <option value="">All</option>
              <option value="draft">Draft</option>
              <option value="approved">Approved</option>
              <option value="active">Active</option>
              <option value="rejected">Rejected</option>
            </select>
          </label>

          <label class="block">
            <span class="block text-[11px] uppercase tracking-wide text-text-dim mb-1">Tag</span>
            <input id="cs-tag" type="text" placeholder="e.g. networking" class="w-full bg-base-850 border border-line rounded-md px-2 py-1.5 text-xs focus:outline-none focus:border-accent-500" />
          </label>

          <button id="cs-refresh" class="w-full px-3 py-1.5 bg-accent-600 hover:bg-accent-500 rounded-md text-xs font-medium">Refresh</button>
        </div>

        <div class="px-4 py-3 border-t border-line text-[11px] text-text-dim leading-relaxed">
          <p class="mb-2">Lifecycle:</p>
          <ul class="space-y-1">
            <li><span class="inline-block w-2 h-2 rounded-full mr-1.5" style="background:#f5a62a"></span>Draft — awaiting review</li>
            <li><span class="inline-block w-2 h-2 rounded-full mr-1.5" style="background:#7cc4ff"></span>Approved — eligible for promotion</li>
            <li><span class="inline-block w-2 h-2 rounded-full mr-1.5" style="background:#42d392"></span>Active — registered as a workflow</li>
            <li><span class="inline-block w-2 h-2 rounded-full mr-1.5" style="background:#ff5d6c"></span>Rejected — kept for audit only</li>
          </ul>
        </div>
      </aside>

      <!-- ─── Main pane ─────────────────────────────────────── -->
      <section class="flex-1 overflow-y-auto scroll-thin">
        <div id="cs-stats" class="grid gap-3 p-4 border-b border-line bg-base-900"
             style="grid-template-columns: repeat(5, minmax(0, 1fr));"></div>
        <div id="cs-table" class="p-4"></div>
      </section>
    </div>
  `;

  // Bind handlers.
  rootEl.querySelector('#cs-refresh').addEventListener('click', refresh);
  const statusEl = rootEl.querySelector('#cs-status');
  const tagEl    = rootEl.querySelector('#cs-tag');
  statusEl.addEventListener('change', () => { state.filters.status = statusEl.value; refresh(); });
  let tagDebounce;
  tagEl.addEventListener('input', () => {
    clearTimeout(tagDebounce);
    tagDebounce = setTimeout(() => { state.filters.tag = tagEl.value.trim(); refresh(); }, 200);
  });

  refresh();
  return () => { /* nothing to dispose */ };
}

async function refresh() {
  try {
    const params = new URLSearchParams();
    if (state.filters.status) params.set('status', state.filters.status);
    if (state.filters.tag)    params.set('tag',    state.filters.tag);
    const [list, stats] = await Promise.all([
      http('GET', '/api/crystallized-skills?' + params.toString()),
      http('GET', '/api/crystallized-skills/stats'),
    ]);
    state.skills = list.skills || [];
    state.stats  = stats;
    renderStats();
    renderTable();
  } catch (err) {
    document.getElementById('cs-table').innerHTML = `
      <div class="text-danger text-sm p-4">Failed to load: ${escapeHtml(err.message)}</div>
    `;
  }
}

function renderStats() {
  const host = document.getElementById('cs-stats');
  if (!host) return;
  const s = state.stats;
  if (!s) { host.innerHTML = ''; return; }
  const sr = s.successRate === null ? '–' : `${Math.round(s.successRate * 100)}%`;
  const cards = [
    { label: 'Total',     value: s.total },
    { label: 'Active',    value: s.counts.active ?? 0,   color: 'text-ok' },
    { label: 'Approved',  value: s.counts.approved ?? 0, color: 'text-accent-400' },
    { label: 'Drafts',    value: s.counts.draft ?? 0,    color: 'text-warn' },
    { label: 'Success rate', value: sr,                  color: 'text-text-primary' },
  ];
  host.innerHTML = cards.map(c => `
    <div class="bg-base-850 border border-line rounded-lg px-4 py-3">
      <div class="text-[11px] uppercase tracking-wide text-text-dim">${escapeHtml(c.label)}</div>
      <div class="text-2xl font-semibold mt-1 ${c.color || 'text-text-primary'}">${escapeHtml(String(c.value))}</div>
    </div>
  `).join('');
}

function renderTable() {
  const host = document.getElementById('cs-table');
  if (!host) return;
  if (state.skills.length === 0) {
    host.innerHTML = `
      <div class="bg-base-900 border border-line rounded-lg p-8 text-center text-text-muted">
        <div class="text-base font-medium text-text-primary mb-1">No learned skills yet</div>
        <div class="text-sm">Crystallization fires after multi-step tasks succeed with a high self-rating.</div>
      </div>
    `;
    return;
  }
  host.innerHTML = `
    <div class="bg-base-900 border border-line rounded-lg overflow-hidden">
      <table class="w-full text-sm">
        <thead class="bg-base-850 text-text-muted text-[11px] uppercase tracking-wide">
          <tr>
            <th class="px-4 py-2 text-left">Name</th>
            <th class="px-4 py-2 text-left">Status</th>
            <th class="px-4 py-2 text-right">Confidence</th>
            <th class="px-4 py-2 text-right">Usage</th>
            <th class="px-4 py-2 text-right">Recent</th>
            <th class="px-4 py-2 text-left">Tags</th>
            <th class="px-4 py-2 text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          ${state.skills.map(rowFor).join('')}
        </tbody>
      </table>
    </div>
  `;
  // Bind action buttons.
  host.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', () => act(btn.dataset.action, btn.dataset.id));
  });
}

function rowFor(s) {
  const colour = STATUS_COLOURS[s.status] || STATUS_COLOURS.draft;
  const recent = recentSummary(s.recentUsage);
  const tags = (s.tags || []).slice(0, 4).map(t =>
    `<span class="inline-block px-2 py-0.5 mr-1 mb-1 rounded bg-base-850 border border-line text-[10px] text-text-muted">${escapeHtml(t)}</span>`
  ).join('');
  return `
    <tr class="border-t border-line hover:bg-base-850 transition">
      <td class="px-4 py-2.5">
        <div class="font-medium text-text-primary">${escapeHtml(s.name)}</div>
        <div class="text-[11px] text-text-dim font-mono">${escapeHtml(s.id)}</div>
        <div class="text-[11px] text-text-dim truncate max-w-md">${escapeHtml(truncate(s.description || '', 120))}</div>
      </td>
      <td class="px-4 py-2.5">
        <span class="inline-flex items-center gap-1.5 ${colour.text} text-xs font-medium uppercase tracking-wide">
          <span class="w-1.5 h-1.5 rounded-full" style="background:${colour.dot}"></span>${escapeHtml(s.status)}
        </span>
      </td>
      <td class="px-4 py-2.5 text-right tabular-nums">${(s.confidenceScore || 0).toFixed(2)}</td>
      <td class="px-4 py-2.5 text-right tabular-nums">${s.usageCount || 0}</td>
      <td class="px-4 py-2.5 text-right text-[11px] text-text-muted">${recent}</td>
      <td class="px-4 py-2.5">${tags}</td>
      <td class="px-4 py-2.5 text-right">
        ${actionsFor(s)}
      </td>
    </tr>
  `;
}

function actionsFor(s) {
  const btn = (action, label, cls) =>
    `<button data-action="${action}" data-id="${attr(s.id)}" class="px-2 py-1 ${cls} rounded text-[11px] mr-1">${label}</button>`;
  switch (s.status) {
    case 'draft':
      return btn('approve', 'Approve', 'bg-accent-600 hover:bg-accent-500')
           + btn('promote', 'Promote', 'bg-base-800 hover:bg-base-700 border border-line')
           + btn('reject',  'Reject',  'bg-base-800 hover:bg-danger/30 border border-line text-danger');
    case 'approved':
      return btn('promote', 'Promote', 'bg-accent-600 hover:bg-accent-500')
           + btn('reject',  'Reject',  'bg-base-800 hover:bg-danger/30 border border-line text-danger');
    case 'active':
      return btn('reject',  'Reject',  'bg-base-800 hover:bg-danger/30 border border-line text-danger');
    case 'rejected':
    default:
      return `<span class="text-text-dim text-[11px]">—</span>`;
  }
}

function recentSummary(recent) {
  if (!Array.isArray(recent) || recent.length === 0) return '<span class="text-text-dim">—</span>';
  const last = recent.slice(-5);
  return last.map(u =>
    u.outcome === 'success'
      ? '<span class="text-ok">●</span>'
      : '<span class="text-danger">●</span>'
  ).join(' ');
}

async function act(action, id) {
  try {
    const url = `/api/crystallized-skills/${encodeURIComponent(id)}/${action}`;
    await http('POST', url, action === 'reject' ? { reason: 'operator-reject' } : undefined);
    refresh();
  } catch (err) {
    alert(`${action} failed: ${err.message}`);
  }
}

// ─── render helpers ────────────────────────────────────────────────────

function escapeHtml(v) { return String(v ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
function attr(v) { return escapeHtml(v).replace(/"/g, '&quot;'); }
function truncate(s, n) { s = String(s ?? ''); return s.length <= n ? s : s.slice(0, n - 1) + '…'; }

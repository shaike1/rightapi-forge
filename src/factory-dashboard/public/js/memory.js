// Memory Store page — agent-by-agent reflection + performance browser.
// Picks the first agent by default, lets you switch via a left rail.

import { api } from './api.js';
import { state } from './state.js';

export function renderMemory(rootEl) {
  rootEl.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'h-full flex';
  wrap.innerHTML = `
    <aside class="w-60 shrink-0 border-r border-line bg-base-900 overflow-y-auto scroll-thin" id="mem-agent-rail">
      <header class="px-4 py-3 border-b border-line text-[11px] uppercase tracking-wider text-text-dim font-semibold">Agents</header>
      <ul id="mem-agent-list" class="py-2"></ul>
    </aside>
    <section class="flex-1 overflow-y-auto scroll-thin p-6" id="mem-content">
      <div class="text-text-muted text-sm">Pick an agent on the left to view their reflections and stats.</div>
    </section>
  `;
  rootEl.appendChild(wrap);

  const railList = wrap.querySelector('#mem-agent-list');
  const content = wrap.querySelector('#mem-content');

  const unsub = state.subscribe(({ agents }) => {
    railList.innerHTML = '';
    if (!agents.length) {
      const empty = document.createElement('li');
      empty.className = 'px-4 py-3 text-xs text-text-dim';
      empty.textContent = 'No agents loaded yet.';
      railList.appendChild(empty);
      return;
    }
    agents.forEach((agent, idx) => {
      const li = document.createElement('li');
      li.className = 'px-2';
      li.innerHTML = `
        <button data-agent-id="${escapeAttr(agent.id)}" class="w-full text-left px-3 py-2 rounded-md hover:bg-base-800 transition flex items-center gap-2.5">
          <span class="w-1.5 h-1.5 rounded-full bg-ok"></span>
          <span class="flex-1 min-w-0">
            <span class="block text-sm font-medium truncate">${escapeHtml(agent.name)}</span>
            <span class="block text-[11px] text-text-dim truncate">${escapeHtml(agent.role || '')}</span>
          </span>
        </button>
      `;
      li.querySelector('button').addEventListener('click', () => {
        railList.querySelectorAll('button').forEach(b => b.classList.remove('bg-base-800', 'border', 'border-line'));
        li.querySelector('button').classList.add('bg-base-800', 'border', 'border-line');
        loadAgentMemory(agent, content);
      });
      railList.appendChild(li);
      // Auto-pick first agent on first render.
      if (idx === 0) li.querySelector('button').click();
    });
  });

  return () => unsub();
}

async function loadAgentMemory(agent, container) {
  container.innerHTML = `
    <div class="flex items-center gap-3 mb-5">
      <h2 class="text-xl font-semibold tracking-tight">${escapeHtml(agent.name)}</h2>
      <span class="text-text-dim text-sm">·</span>
      <span class="text-sm text-text-muted">${escapeHtml(agent.role || '')}</span>
    </div>
    <div id="mem-stats" class="text-text-muted text-sm">Loading…</div>
    <div id="mem-reflections" class="mt-6"></div>
  `;

  const statsEl = container.querySelector('#mem-stats');
  const reflEl = container.querySelector('#mem-reflections');

  let perf = null, reflections = [];
  try { perf = await api.agentPerformance(agent.id); }
  catch (e) { statsEl.innerHTML = `<span class="text-danger">Failed to load performance: ${escapeHtml(e.message)}</span>`; return; }
  try { reflections = (await api.agentReflections(agent.id, 50)).reflections || []; }
  catch (e) { /* keep stats; just leave reflections empty */ }

  // Performance band.
  statsEl.innerHTML = `
    <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
      ${stat('Total reflections', perf.totalReflections ?? 0)}
      ${stat('Avg rating', (perf.averageRating ?? 0).toFixed(2) + ' / 5')}
      ${stat('Trend', `<span class="${trendClass(perf.trend)}">${escapeHtml(perf.trend || 'insufficient')}</span>`)}
      ${stat('Most-effective tool', perf.mostEffectiveTools?.[0]?.tool ? escapeHtml(perf.mostEffectiveTools[0].tool) : '—')}
    </div>
    ${(perf.commonFailurePatterns?.length ?? 0) > 0 ? `
      <div class="mt-4 bg-base-900 border border-line rounded-lg p-4">
        <div class="text-[11px] uppercase tracking-wider text-text-dim font-semibold mb-2">Common failure patterns</div>
        <ul class="space-y-1.5 text-sm">
          ${perf.commonFailurePatterns.slice(0, 5).map(f => `
            <li class="flex items-center gap-3"><span class="text-danger font-mono text-xs w-8">${f.count}×</span><span class="text-text-muted">${escapeHtml(f.pattern)}</span></li>
          `).join('')}
        </ul>
      </div>` : ''}
  `;

  // Reflections list.
  if (reflections.length === 0) {
    reflEl.innerHTML = `<div class="text-text-dim text-sm">No reflections recorded yet — completed tasks will populate this list.</div>`;
    return;
  }
  reflEl.innerHTML = `
    <h3 class="text-sm font-semibold tracking-tight mb-3">Reflections (${reflections.length})</h3>
    <div class="space-y-2">
      ${reflections.map(r => `
        <div class="bg-base-900 border border-line rounded-lg p-3.5">
          <div class="flex items-start gap-3">
            <div class="w-9 h-9 rounded-md bg-base-800 flex items-center justify-center font-bold ${ratingColor(r.selfRating)}">${r.selfRating}</div>
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 mb-1">
                <span class="text-sm font-medium truncate">${escapeHtml(r.taskTitle || r.taskId || '(untitled)')}</span>
                <span class="ml-auto text-[11px] text-text-dim">${escapeHtml(r.timestamp || '')}</span>
              </div>
              ${r.lessonsLearned?.length > 0 ? `
                <div class="text-xs text-text-muted">
                  <span class="text-text-dim">Lessons:</span> ${r.lessonsLearned.slice(0, 3).map(l => escapeHtml(l)).join(' · ')}
                </div>` : ''}
              ${r.wouldDoDifferently ? `
                <div class="text-xs text-text-muted mt-1">
                  <span class="text-text-dim">Next time:</span> ${escapeHtml(r.wouldDoDifferently)}
                </div>` : ''}
            </div>
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

function stat(label, value) {
  return `
    <div class="bg-base-900 border border-line rounded-lg p-3.5">
      <div class="text-[10px] uppercase tracking-wider text-text-dim font-semibold">${escapeHtml(label)}</div>
      <div class="text-lg font-semibold mt-1">${value}</div>
    </div>`;
}

function ratingColor(r) {
  if (r >= 4) return 'text-ok';
  if (r === 3) return 'text-accent-400';
  return 'text-warn';
}

function trendClass(t) {
  if (t === 'improving') return 'text-ok';
  if (t === 'declining') return 'text-danger';
  if (t === 'stable')    return 'text-accent-400';
  return 'text-text-dim';
}

function escapeHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
function escapeAttr(s) { return escapeHtml(s); }

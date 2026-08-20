// Settings page — agent roster with role/skills/guardrails view + circuit
// breaker overview. Inline edit for daily-token budget per agent because
// that's the most common operator override.

import { api } from './api.js';
import { state } from './state.js';

export function renderSettings(rootEl) {
  rootEl.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'p-6 space-y-8';
  wrap.innerHTML = `
    <section>
      <header class="flex items-center gap-3 mb-4">
        <h2 class="text-lg font-semibold tracking-tight">Agents</h2>
        <span class="text-text-dim text-sm">·</span>
        <span class="text-sm text-text-muted">Roles, skills, and per-agent token budgets.</span>
      </header>
      <div id="agent-table" class="bg-base-900 border border-line rounded-lg overflow-hidden"></div>
    </section>

    <section>
      <header class="flex items-center gap-3 mb-4">
        <h2 class="text-lg font-semibold tracking-tight">Circuit breakers</h2>
        <span class="text-text-dim text-sm">·</span>
        <span class="text-sm text-text-muted">Skills with non-default state. Reset to re-allow traffic.</span>
        <button id="cb-refresh" class="ml-auto text-xs text-text-muted hover:text-text-primary">Refresh</button>
      </header>
      <div id="cb-table" class="bg-base-900 border border-line rounded-lg overflow-hidden"></div>
    </section>
  `;
  rootEl.appendChild(wrap);

  const agentTable = wrap.querySelector('#agent-table');
  const cbTable    = wrap.querySelector('#cb-table');
  const cbRefresh  = wrap.querySelector('#cb-refresh');

  cbRefresh.addEventListener('click', () => loadCircuitBreakers(cbTable));

  const unsub = state.subscribe(({ agents }) => renderAgentTable(agentTable, agents));
  loadCircuitBreakers(cbTable);

  return () => unsub();
}

async function renderAgentTable(table, agents) {
  if (!agents.length) {
    table.innerHTML = `<div class="px-4 py-6 text-text-dim text-sm">No agents loaded yet.</div>`;
    return;
  }

  // Pull each agent's usage in parallel for the inline budget view.
  const usages = await Promise.all(agents.map(async a => {
    try { return [a.id, await api.agentUsage(a.id)]; } catch { return [a.id, null]; }
  }));
  const usageMap = new Map(usages);

  table.innerHTML = `
    <table class="w-full text-sm">
      <thead class="bg-base-850 text-text-dim text-[10px] uppercase tracking-wider">
        <tr>
          <th class="text-left px-4 py-2.5 font-semibold">Agent</th>
          <th class="text-left px-4 py-2.5 font-semibold">Role</th>
          <th class="text-left px-4 py-2.5 font-semibold">Skills</th>
          <th class="text-left px-4 py-2.5 font-semibold">Today</th>
          <th class="text-left px-4 py-2.5 font-semibold">Daily budget</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-line">
        ${agents.map(a => {
          const usage = usageMap.get(a.id);
          const today = usage?.today;
          const budget = usage?.budget;
          const gate = usage?.gate;
          const skills = (a.skills || []).slice(0, 6);
          return `
            <tr class="hover:bg-base-850/60 transition" data-agent-id="${escapeAttr(a.id)}">
              <td class="px-4 py-3">
                <div class="font-medium">${escapeHtml(a.name)}</div>
                <div class="text-[11px] font-mono text-text-dim">${escapeHtml(String(a.id).slice(0, 14))}</div>
              </td>
              <td class="px-4 py-3 text-text-muted capitalize">${escapeHtml(a.role || '-')}</td>
              <td class="px-4 py-3">
                <div class="flex flex-wrap gap-1">
                  ${skills.map(s => `<span class="text-[10px] px-1.5 py-0.5 rounded bg-base-800 border border-line text-text-muted">${escapeHtml(s)}</span>`).join('')}
                  ${(a.skills?.length ?? 0) > 6 ? `<span class="text-[10px] text-text-dim">+${a.skills.length - 6}</span>` : ''}
                </div>
              </td>
              <td class="px-4 py-3 text-text-muted">
                ${today ? `<span class="font-mono">${today.totalTokens.toLocaleString()}</span> tokens · ${today.totalTasks} tasks` : '<span class="text-text-dim">no data</span>'}
              </td>
              <td class="px-4 py-3">
                <div class="flex items-center gap-2">
                  <input type="number" data-budget-input value="${budget?.dailyTokens ?? ''}" placeholder="unlimited"
                         class="w-28 bg-base-850 border border-line rounded px-2 py-1 text-xs focus:outline-none focus:border-accent-500" />
                  <button data-budget-save class="px-2 py-1 text-xs bg-accent-600/80 hover:bg-accent-500 rounded">Save</button>
                  ${gate?.allowed === false ? `<span class="text-[10px] text-danger" title="${escapeAttr(gate.reason || '')}">blocked</span>` : ''}
                </div>
              </td>
            </tr>`;
        }).join('')}
      </tbody>
    </table>
  `;

  // Wire budget save buttons.
  table.querySelectorAll('tr[data-agent-id]').forEach(row => {
    const agentId = row.dataset.agentId;
    const input = row.querySelector('[data-budget-input]');
    const btn   = row.querySelector('[data-budget-save]');
    btn.addEventListener('click', async () => {
      const v = parseInt(input.value, 10);
      if (!Number.isFinite(v) || v <= 0) { notify('Enter a positive number of tokens', 'warn'); return; }
      try {
        await api.setAgentBudget(agentId, { dailyTokens: v });
        notify(`Budget set to ${v.toLocaleString()} tokens/day`, 'info');
      } catch (e) {
        notify(`Could not save: ${e.message}`, 'danger');
      }
    });
  });
}

async function loadCircuitBreakers(table) {
  table.innerHTML = `<div class="px-4 py-6 text-text-dim text-sm">Loading…</div>`;
  let payload;
  try { payload = await api.listCircuitBreakers(); }
  catch (e) {
    table.innerHTML = `<div class="px-4 py-4 text-danger text-sm">Failed to load: ${escapeHtml(e.message)}</div>`;
    return;
  }
  if (!payload.count) {
    table.innerHTML = `<div class="px-4 py-6 text-text-dim text-sm">All breakers healthy. ✓</div>`;
    return;
  }
  table.innerHTML = `
    <table class="w-full text-sm">
      <thead class="bg-base-850 text-text-dim text-[10px] uppercase tracking-wider">
        <tr>
          <th class="text-left px-4 py-2.5 font-semibold">Skill</th>
          <th class="text-left px-4 py-2.5 font-semibold">State</th>
          <th class="text-left px-4 py-2.5 font-semibold">Failures</th>
          <th class="text-left px-4 py-2.5 font-semibold">Last failure</th>
          <th class="text-left px-4 py-2.5 font-semibold">Re-opens in</th>
          <th></th>
        </tr>
      </thead>
      <tbody class="divide-y divide-line">
        ${payload.breakers.map(b => `
          <tr>
            <td class="px-4 py-3 font-mono text-xs">${escapeHtml(b.skillId)}</td>
            <td class="px-4 py-3"><span class="${stateClass(b.state)}">${escapeHtml(b.state)}</span></td>
            <td class="px-4 py-3 text-text-muted">${b.consecutiveFailures}</td>
            <td class="px-4 py-3 text-text-dim text-xs">${escapeHtml(b.lastFailureAt || '–')}</td>
            <td class="px-4 py-3 text-text-dim">${b.reopensAfterMs > 0 ? Math.ceil(b.reopensAfterMs / 1000) + 's' : '—'}</td>
            <td class="px-4 py-3 text-right">
              <button data-cb-reset="${escapeAttr(b.skillId)}" class="text-xs px-2 py-1 bg-base-800 hover:bg-base-700 rounded">Reset</button>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
  table.querySelectorAll('[data-cb-reset]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const skillId = btn.dataset.cbReset;
      try { await api.resetCircuitBreaker(skillId); notify(`Reset ${skillId}`, 'info'); loadCircuitBreakers(table); }
      catch (e) { notify(`Reset failed: ${e.message}`, 'danger'); }
    });
  });
}

function stateClass(s) {
  if (s === 'OPEN')      return 'inline-flex px-1.5 py-0.5 text-[10px] rounded bg-danger/15 text-danger border border-danger/40 font-semibold';
  if (s === 'HALF_OPEN') return 'inline-flex px-1.5 py-0.5 text-[10px] rounded bg-warn/15 text-warn border border-warn/40 font-semibold';
  return 'inline-flex px-1.5 py-0.5 text-[10px] rounded bg-ok/15 text-ok border border-ok/40 font-semibold';
}

function escapeHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
function escapeAttr(s) { return escapeHtml(s); }

function notify(message, kind = 'info') {
  const colors = { info: 'bg-accent-600', warn: 'bg-warn', danger: 'bg-danger' };
  const el = document.createElement('div');
  el.className = `fixed bottom-5 right-5 px-4 py-2 rounded-md text-sm font-medium shadow-lg z-50 ${colors[kind] || colors.info}`;
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

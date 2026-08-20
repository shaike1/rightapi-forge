// Visual workflow editor.
//
// What's on screen:
//   ┌─────────────┬──────────────────────────────────┬──────────────┐
//   │ Step palette│ Canvas (SVG + HTML step boxes)   │ Property pane│
//   └─────────────┴──────────────────────────────────┴──────────────┘
//
// Steps are positioned absolutely on a relative-positioned canvas.
// SVG paths between steps are recomputed on every render so dragging a
// step keeps its arrows attached. Connections are author-driven: pick
// "from" and "to" via the property pane (each step's `next` field) and
// the renderer draws the arrow.
//
// JSON I/O matches WorkflowDef in src/workflows/WorkflowDef.ts. Validation
// is server-side via POST /api/workflows/json/validate. The Run button
// calls POST /api/workflows/json/:id/run after registering the workflow
// (POST /api/workflows/json which writes to the in-memory registry).

import { auth } from './api.js';

// ─── HTTP helper (shared shape with api.js but namespaced for clarity) ──────

async function http(method, url, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth.token) headers.Authorization = `Bearer ${auth.token}`;
  const res = await fetch(url, {
    method,
    headers,
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

// ─── Editor state ──────────────────────────────────────────────────────────

const STEP_TYPES = [
  { type: 'bash',          label: 'Bash',         color: '#6ee7b7', desc: 'Run a shell command via bash.exec' },
  { type: 'skill',         label: 'Skill',        color: '#7cc4ff', desc: 'Invoke any registered skill' },
  { type: 'api_call',      label: 'API Call',     color: '#f5a62a', desc: 'HTTP request to a URL' },
  { type: 'delegation',    label: 'Delegate',     color: '#c084fc', desc: 'Hand the task to another agent' },
  { type: 'approval_gate', label: 'Approval',     color: '#fb7185', desc: 'Pause until an approval token is provided' },
  { type: 'conditional',   label: 'Conditional',  color: '#facc15', desc: 'Branch on a runtime expression' },
];

let workflow = blankWorkflow();
let positions = {};          // stepId → { x, y }
let selectedStepId = null;
let workflowList = [];       // list of registered workflows
let lastRunSummary = null;   // most recent run result for the status panel
let currentTearDown = null;

function blankWorkflow() {
  return {
    schemaVersion: 1,
    id: 'my-workflow',
    name: 'New Workflow',
    description: '',
    version: '1.0.0',
    inputs: [],
    steps: [],
    onError: 'fail',
  };
}

function makeStepId() {
  let i = 1;
  while (workflow.steps.some(s => s.id === `step_${i}`)) i++;
  return `step_${i}`;
}

// ─── Public entry point used by ui.js ──────────────────────────────────────

export function renderWorkflowEditor(rootEl) {
  rootEl.innerHTML = `
    <div class="grid h-full" style="grid-template-columns: 220px 1fr 360px;">
      <!-- ─── Step palette ────────────────────────────────────────────── -->
      <aside class="border-r border-line bg-base-900 overflow-y-auto scroll-thin">
        <div class="px-4 py-3 border-b border-line">
          <div class="text-xs uppercase tracking-wide text-text-dim mb-1">Step Library</div>
          <div class="text-[11px] text-text-dim">Click to add to canvas.</div>
        </div>
        <div id="step-palette" class="p-2 space-y-1.5">
          ${STEP_TYPES.map(t => `
            <button data-step-type="${t.type}"
                    class="w-full text-left px-3 py-2 rounded-md bg-base-850 border border-line hover:border-accent-500 transition group">
              <div class="flex items-center gap-2">
                <span class="w-2 h-2 rounded-full" style="background:${t.color}"></span>
                <span class="text-sm font-medium text-text-primary">${t.label}</span>
              </div>
              <div class="text-[11px] text-text-dim mt-0.5">${t.desc}</div>
            </button>
          `).join('')}
        </div>
        <div class="border-t border-line mt-3 px-4 py-3">
          <div class="text-xs uppercase tracking-wide text-text-dim mb-2">Saved</div>
          <div id="workflow-list" class="space-y-1 text-sm"></div>
        </div>
      </aside>

      <!-- ─── Canvas ──────────────────────────────────────────────────── -->
      <section class="relative bg-base-950 overflow-hidden flex flex-col">
        <header class="h-11 shrink-0 border-b border-line bg-base-900 flex items-center px-3 gap-2">
          <input id="wf-id" class="bg-base-850 border border-line rounded-md px-2 py-1 text-xs w-40 focus:outline-none focus:border-accent-500" placeholder="workflow id"/>
          <input id="wf-name" class="bg-base-850 border border-line rounded-md px-2 py-1 text-xs w-56 focus:outline-none focus:border-accent-500" placeholder="Display name"/>
          <input id="wf-version" class="bg-base-850 border border-line rounded-md px-2 py-1 text-xs w-20 focus:outline-none focus:border-accent-500" placeholder="1.0.0"/>
          <div class="ml-auto flex items-center gap-1.5">
            <button id="wf-import" class="px-2 py-1 bg-base-800 hover:bg-base-700 border border-line rounded-md text-xs">Import</button>
            <button id="wf-export" class="px-2 py-1 bg-base-800 hover:bg-base-700 border border-line rounded-md text-xs">Export</button>
            <button id="wf-validate" class="px-2 py-1 bg-base-800 hover:bg-base-700 border border-line rounded-md text-xs">Validate</button>
            <button id="wf-save" class="px-2 py-1 bg-accent-600 hover:bg-accent-500 rounded-md text-xs font-medium">Save</button>
            <button id="wf-run" class="px-2 py-1 bg-ok hover:opacity-80 text-base-950 rounded-md text-xs font-medium">Run</button>
          </div>
        </header>
        <div id="canvas-host" class="flex-1 relative overflow-auto scroll-thin">
          <div id="canvas" class="relative" style="width: 2400px; height: 1400px;">
            <svg id="wf-arrows" class="absolute inset-0 pointer-events-none" width="2400" height="1400"></svg>
          </div>
        </div>
        <footer class="border-t border-line bg-base-900 px-3 py-2 text-[11px] flex items-center gap-3">
          <span class="text-text-dim">Tip:</span>
          <span class="text-text-muted">click a palette tile to add a step • drag a step to reposition • set <span class="text-text-primary">next</span> in the property pane to draw an arrow</span>
          <span id="wf-status" class="ml-auto text-text-muted"></span>
        </footer>
      </section>

      <!-- ─── Property pane ───────────────────────────────────────────── -->
      <aside class="border-l border-line bg-base-900 overflow-y-auto scroll-thin">
        <div id="prop-pane" class="p-4 text-sm"></div>
      </aside>
    </div>
  `;

  // Bind handlers + initial render.
  bindHandlers(rootEl);
  refreshWorkflowList();
  renderProps();
  renderCanvas();
  return () => { currentTearDown && currentTearDown(); };
}

function bindHandlers(root) {
  // Header field bindings.
  const idEl = root.querySelector('#wf-id');
  const nameEl = root.querySelector('#wf-name');
  const versionEl = root.querySelector('#wf-version');
  idEl.value = workflow.id;
  nameEl.value = workflow.name;
  versionEl.value = workflow.version;
  idEl.addEventListener('input', () => { workflow.id = idEl.value.trim(); });
  nameEl.addEventListener('input', () => { workflow.name = nameEl.value; });
  versionEl.addEventListener('input', () => { workflow.version = versionEl.value.trim(); });

  // Step palette → add a step.
  root.querySelectorAll('[data-step-type]').forEach(btn => {
    btn.addEventListener('click', () => {
      const type = btn.dataset.stepType;
      addStep(type);
    });
  });

  // Top bar buttons.
  root.querySelector('#wf-import').addEventListener('click', importWorkflow);
  root.querySelector('#wf-export').addEventListener('click', exportWorkflow);
  root.querySelector('#wf-validate').addEventListener('click', () => validateWorkflow(root));
  root.querySelector('#wf-save').addEventListener('click', () => saveWorkflow(root));
  root.querySelector('#wf-run').addEventListener('click', () => runWorkflow(root));
}

// ─── Step ops ──────────────────────────────────────────────────────────────

function addStep(type) {
  const id = makeStepId();
  const next = workflow.steps[workflow.steps.length - 1]?.id;
  const step = defaultStep(type, id);
  workflow.steps.push(step);
  // Position next to the previous step, fall back to the corner.
  const prev = next ? positions[next] : null;
  positions[id] = prev ? { x: prev.x + 220, y: prev.y } : { x: 60, y: 60 };
  selectedStepId = id;
  renderCanvas();
  renderProps();
}

function defaultStep(type, id) {
  switch (type) {
    case 'bash':          return { id, type, command: 'echo hello' };
    case 'skill':         return { id, type, skill: 'monitor.systemHealth', params: {} };
    case 'api_call':      return { id, type, url: 'https://example.test/health', method: 'GET' };
    case 'delegation':    return { id, type, toAgentId: 'specialist-1', objective: '' };
    case 'approval_gate': return { id, type, command: 'deploy.prod' };
    case 'conditional':   return { id, type, when: '${steps.previous.ok}', then: '', else: '' };
    default: return { id, type };
  }
}

function deleteStep(stepId) {
  workflow.steps = workflow.steps.filter(s => s.id !== stepId);
  delete positions[stepId];
  if (selectedStepId === stepId) selectedStepId = workflow.steps[0]?.id ?? null;
  renderCanvas();
  renderProps();
}

// ─── Canvas + arrow rendering ──────────────────────────────────────────────

function renderCanvas() {
  const canvas = document.getElementById('canvas');
  if (!canvas) return;
  // Wipe non-SVG children.
  Array.from(canvas.querySelectorAll('.step-box')).forEach(el => el.remove());

  for (const step of workflow.steps) {
    const pos = positions[step.id] || { x: 60, y: 60 };
    const t = STEP_TYPES.find(t => t.type === step.type) || { color: '#888', label: step.type };
    const box = document.createElement('div');
    box.className = 'step-box absolute select-none cursor-grab';
    box.style.left = pos.x + 'px';
    box.style.top  = pos.y + 'px';
    box.dataset.stepId = step.id;
    const isSel = step.id === selectedStepId;
    box.innerHTML = `
      <div class="bg-base-850 border ${isSel ? 'border-accent-500' : 'border-line'} rounded-lg shadow-md"
           style="width: 200px;">
        <div class="flex items-center gap-2 px-3 py-2 border-b border-line">
          <span class="w-2 h-2 rounded-full" style="background:${t.color}"></span>
          <span class="text-xs font-semibold text-text-primary">${t.label}</span>
          <span class="ml-auto text-[10px] text-text-dim">${escapeHtml(step.id)}</span>
        </div>
        <div class="px-3 py-2 text-[11px] text-text-muted truncate">${stepSummary(step)}</div>
      </div>
    `;
    box.addEventListener('mousedown', (e) => beginDrag(box, step.id, e));
    box.addEventListener('click', (e) => {
      if (e.detail !== 1) return;          // ignore double-click for drag
      selectedStepId = step.id;
      renderCanvas();
      renderProps();
    });
    canvas.appendChild(box);
  }

  drawArrows();
}

function stepSummary(s) {
  switch (s.type) {
    case 'bash':          return escapeHtml(s.command || '');
    case 'skill':         return escapeHtml(s.skill || '');
    case 'api_call':      return escapeHtml((s.method || 'GET') + ' ' + (s.url || ''));
    case 'delegation':    return escapeHtml('→ ' + (s.toAgentId || ''));
    case 'approval_gate': return escapeHtml('approve: ' + (s.command || ''));
    case 'conditional':   return escapeHtml('if ' + (s.when || ''));
    default:              return '';
  }
}

function drawArrows() {
  const svg = document.getElementById('wf-arrows');
  if (!svg) return;
  // Clear existing children except the defs marker.
  svg.innerHTML = `
    <defs>
      <marker id="arrowhead" markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto">
        <path d="M0,0 L10,4 L0,8 Z" fill="#3aa3ff"/>
      </marker>
    </defs>
  `;
  // Sequential arrows + conditional then/else + onError.goto.
  const idx = (id) => workflow.steps.findIndex(s => s.id === id);
  for (let i = 0; i < workflow.steps.length; i++) {
    const step = workflow.steps[i];
    const next = workflow.steps[i + 1];
    if (next && step.type !== 'conditional') addEdge(svg, step.id, next.id, '#3aa3ff', null);
    if (step.type === 'conditional') {
      if (step.then && idx(step.then) >= 0) addEdge(svg, step.id, step.then, '#42d392', 'then');
      if (step.else && idx(step.else) >= 0) addEdge(svg, step.id, step.else, '#ff5d6c', 'else');
    }
    if (step.onError && typeof step.onError === 'object' && step.onError.goto && idx(step.onError.goto) >= 0) {
      addEdge(svg, step.id, step.onError.goto, '#f5a62a', 'on err');
    }
  }
}

function addEdge(svg, fromId, toId, color, label) {
  const a = positions[fromId], b = positions[toId];
  if (!a || !b) return;
  const x1 = a.x + 200, y1 = a.y + 32;
  const x2 = b.x,       y2 = b.y + 32;
  const cx = (x1 + x2) / 2;
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', `M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}`);
  path.setAttribute('stroke', color);
  path.setAttribute('stroke-width', '1.6');
  path.setAttribute('fill', 'none');
  path.setAttribute('marker-end', 'url(#arrowhead)');
  svg.appendChild(path);
  if (label) {
    const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    t.setAttribute('x', cx);
    t.setAttribute('y', (y1 + y2) / 2 - 6);
    t.setAttribute('fill', color);
    t.setAttribute('font-size', '10');
    t.setAttribute('text-anchor', 'middle');
    t.textContent = label;
    svg.appendChild(t);
  }
}

// ─── Drag-to-move ──────────────────────────────────────────────────────────

function beginDrag(box, stepId, ev) {
  ev.preventDefault();
  const start = { x: ev.clientX, y: ev.clientY };
  const orig  = { ...positions[stepId] };
  box.style.cursor = 'grabbing';
  function onMove(e) {
    const dx = e.clientX - start.x, dy = e.clientY - start.y;
    positions[stepId] = { x: Math.max(0, orig.x + dx), y: Math.max(0, orig.y + dy) };
    box.style.left = positions[stepId].x + 'px';
    box.style.top  = positions[stepId].y + 'px';
    drawArrows();
  }
  function onUp() {
    box.style.cursor = 'grab';
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  }
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// ─── Property pane ─────────────────────────────────────────────────────────

function renderProps() {
  const host = document.getElementById('prop-pane');
  if (!host) return;
  const step = workflow.steps.find(s => s.id === selectedStepId);
  if (!step) {
    host.innerHTML = `
      <div class="text-xs uppercase tracking-wide text-text-dim mb-2">Workflow</div>
      ${renderWorkflowProps()}
      ${renderRunStatus()}
    `;
    bindWorkflowProps();
    return;
  }
  host.innerHTML = `
    <div class="flex items-center justify-between mb-3">
      <div class="text-xs uppercase tracking-wide text-text-dim">Step</div>
      <button id="prop-delete" class="text-[11px] text-danger hover:underline">delete</button>
    </div>
    <div class="space-y-2">
      ${field('id', `<input id="p-id" value="${attr(step.id)}" class="${inputCls()}" />`)}
      ${field('type', `<input value="${step.type}" disabled class="${inputCls()}" />`)}
      ${field('description', `<input id="p-desc" value="${attr(step.description ?? '')}" class="${inputCls()}" />`)}
      ${typeSpecificFields(step)}
      ${field('onError', renderOnError(step))}
      <div class="text-[11px] text-text-dim mt-3">Sequential next: ${nextStepHint(step.id)}</div>
    </div>
    ${renderRunStatus()}
  `;
  // Bind generic fields.
  document.getElementById('prop-delete').addEventListener('click', () => deleteStep(step.id));
  bindStepInput('p-id', (v) => {
    if (!v.trim()) return;
    if (workflow.steps.some(s => s.id === v && s.id !== step.id)) return;
    // Update id everywhere.
    const old = step.id;
    step.id = v.trim();
    positions[step.id] = positions[old]; delete positions[old];
    if (selectedStepId === old) selectedStepId = step.id;
    // Repoint refs.
    for (const s of workflow.steps) {
      if (s.type === 'conditional') {
        if (s.then === old) s.then = step.id;
        if (s.else === old) s.else = step.id;
      }
      if (s.onError && typeof s.onError === 'object' && s.onError.goto === old) s.onError.goto = step.id;
    }
    renderCanvas();
  });
  bindStepInput('p-desc', (v) => { step.description = v; });
  bindTypeSpecific(step);
  bindOnError(step);
}

function renderWorkflowProps() {
  return `
    <div class="space-y-2">
      ${field('description', `<textarea id="wp-desc" rows="3" class="${inputCls()} resize-none">${esc(workflow.description ?? '')}</textarea>`)}
      ${field('default onError',
        selectField('wp-default-onerror', ['fail', 'continue'], typeof workflow.onError === 'string' ? workflow.onError : 'fail'),
      )}
      <div class="text-[11px] text-text-dim mt-3">Steps: ${workflow.steps.length}</div>
    </div>
  `;
}

function bindWorkflowProps() {
  bindStepInput('wp-desc', (v) => { workflow.description = v; });
  const sel = document.getElementById('wp-default-onerror');
  if (sel) sel.addEventListener('change', () => { workflow.onError = sel.value; });
}

function typeSpecificFields(s) {
  switch (s.type) {
    case 'bash':
      return field('command', `<textarea id="p-command" rows="3" class="${inputCls()} font-mono text-xs">${esc(s.command ?? '')}</textarea>`);
    case 'skill':
      return field('skill', `<input id="p-skill" value="${attr(s.skill ?? '')}" class="${inputCls()} font-mono text-xs"/>`)
        + field('params (JSON)', `<textarea id="p-params" rows="3" class="${inputCls()} font-mono text-xs">${esc(JSON.stringify(s.params ?? {}, null, 2))}</textarea>`);
    case 'api_call':
      return field('method', selectField('p-method', ['GET','POST','PUT','PATCH','DELETE'], s.method || 'GET'))
        + field('url', `<input id="p-url" value="${attr(s.url ?? '')}" class="${inputCls()} font-mono text-xs"/>`);
    case 'delegation':
      return field('toAgentId', `<input id="p-to-agent" value="${attr(s.toAgentId ?? '')}" class="${inputCls()}"/>`)
        + field('objective', `<textarea id="p-objective" rows="3" class="${inputCls()}">${esc(s.objective ?? '')}</textarea>`);
    case 'approval_gate':
      return field('command', `<input id="p-command" value="${attr(s.command ?? '')}" class="${inputCls()}"/>`);
    case 'conditional':
      return field('when (template)', `<input id="p-when" value="${attr(s.when ?? '')}" class="${inputCls()} font-mono text-xs"/>`)
        + field('equals (optional)', `<input id="p-equals" value="${attr(s.equals ?? '')}" class="${inputCls()}"/>`)
        + field('then →', stepSelect('p-then', s.id, s.then ?? ''))
        + field('else →', stepSelect('p-else', s.id, s.else ?? ''));
    default:
      return '';
  }
}

function bindTypeSpecific(s) {
  switch (s.type) {
    case 'bash':
      bindStepInput('p-command', (v) => { s.command = v; });
      break;
    case 'skill': {
      bindStepInput('p-skill', (v) => { s.skill = v; });
      const pa = document.getElementById('p-params');
      pa.addEventListener('change', () => {
        try { s.params = JSON.parse(pa.value || '{}'); } catch { /* keep prior */ }
      });
      break;
    }
    case 'api_call':
      bindStepInput('p-url', (v) => { s.url = v; });
      document.getElementById('p-method').addEventListener('change', (e) => { s.method = e.target.value; });
      break;
    case 'delegation':
      bindStepInput('p-to-agent', (v) => { s.toAgentId = v; });
      bindStepInput('p-objective', (v) => { s.objective = v; });
      break;
    case 'approval_gate':
      bindStepInput('p-command', (v) => { s.command = v; });
      break;
    case 'conditional':
      bindStepInput('p-when',   (v) => { s.when   = v; });
      bindStepInput('p-equals', (v) => { s.equals = v; });
      document.getElementById('p-then').addEventListener('change', (e) => { s.then = e.target.value; renderCanvas(); });
      document.getElementById('p-else').addEventListener('change', (e) => { s.else = e.target.value; renderCanvas(); });
      break;
  }
}

function renderOnError(step) {
  const oe = step.onError;
  const mode = !oe ? 'inherit' : typeof oe === 'string' ? oe : 'goto';
  const gotoVal = (oe && typeof oe === 'object') ? (oe.goto ?? '') : '';
  return `
    <div class="space-y-1.5">
      ${selectField('p-onerror-mode', ['inherit', 'fail', 'continue', 'goto'], mode)}
      <div id="p-onerror-goto-wrap" style="${mode === 'goto' ? '' : 'display:none'}">
        ${stepSelect('p-onerror-goto', step.id, gotoVal)}
      </div>
    </div>
  `;
}

function bindOnError(step) {
  const modeEl = document.getElementById('p-onerror-mode');
  const gotoWrap = document.getElementById('p-onerror-goto-wrap');
  modeEl.addEventListener('change', () => {
    const mode = modeEl.value;
    if (mode === 'inherit') delete step.onError;
    else if (mode === 'goto') step.onError = { goto: '' };
    else step.onError = mode;
    renderProps();
    renderCanvas();
  });
  const gotoEl = document.getElementById('p-onerror-goto');
  if (gotoEl) gotoEl.addEventListener('change', () => {
    step.onError = { goto: gotoEl.value };
    renderCanvas();
  });
}

function bindStepInput(id, set) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('input', () => set(el.value));
  el.addEventListener('blur', () => renderCanvas());
}

function nextStepHint(stepId) {
  const idx = workflow.steps.findIndex(s => s.id === stepId);
  const next = workflow.steps[idx + 1];
  return next ? next.id : '<end>';
}

// ─── Run status panel ───────────────────────────────────────────────────────

function renderRunStatus() {
  if (!lastRunSummary) return '';
  const r = lastRunSummary;
  const color =
    r.status === 'completed'        ? 'text-ok' :
    r.status === 'pending_approval' ? 'text-warn' : 'text-danger';
  return `
    <div class="mt-6 border-t border-line pt-3">
      <div class="text-xs uppercase tracking-wide text-text-dim mb-2">Last run</div>
      <div class="space-y-1 text-xs">
        <div><span class="text-text-dim">runId</span> <span class="font-mono">${esc(r.runId)}</span></div>
        <div><span class="text-text-dim">status</span> <span class="${color} font-semibold">${esc(r.status)}</span></div>
        ${r.error ? `<div class="text-danger">${esc(r.error)}</div>` : ''}
      </div>
      <details class="mt-2">
        <summary class="text-[11px] text-text-muted cursor-pointer">Steps (${r.steps.length})</summary>
        <ul class="mt-1 space-y-1 text-[11px] font-mono">
          ${r.steps.map(s => `
            <li>
              <span class="text-text-dim">${esc(s.id)}</span>
              <span class="${s.status === 'success' ? 'text-ok' : s.status === 'failed' ? 'text-danger' : 'text-warn'}">
                ${esc(s.status)}
              </span>${s.error ? ` — ${esc(s.error)}` : ''}
            </li>
          `).join('')}
        </ul>
      </details>
    </div>
  `;
}

// ─── Workflow list (sidebar bottom) ────────────────────────────────────────

async function refreshWorkflowList() {
  const host = document.getElementById('workflow-list');
  if (!host) return;
  try {
    const res = await http('GET', '/api/workflows/json');
    workflowList = res.workflows || [];
    host.innerHTML = workflowList.length === 0
      ? '<div class="text-text-dim text-[11px]">no saved workflows</div>'
      : workflowList.map(w => `
          <button data-load-id="${attr(w.id)}"
                  class="w-full text-left px-2 py-1 rounded hover:bg-base-800 transition">
            <div class="text-text-primary text-[12px]">${esc(w.name)}</div>
            <div class="text-text-dim text-[10px]">${esc(w.id)} · v${esc(w.version)} · ${w.steps} steps</div>
          </button>
        `).join('');
    host.querySelectorAll('[data-load-id]').forEach(btn => {
      btn.addEventListener('click', () => loadWorkflowFromList(btn.dataset.loadId));
    });
  } catch (e) {
    host.innerHTML = `<div class="text-danger text-[11px]">${esc(e.message)}</div>`;
  }
}

function loadWorkflowFromList(id) {
  // For now we just fetch the schema-validated definition by re-asking
  // the server for the list (which includes only metadata). To get the
  // full body we re-validate against the server's stored copy through
  // the registry list; the list endpoint should be richer in future.
  // Local fallback: leave the canvas alone; the user reloads from JSON.
  const summary = workflowList.find(w => w.id === id);
  if (!summary) return;
  alert(`Loaded "${summary.name}". Open the saved file or paste its JSON via Import to edit.`);
}

// ─── Top bar actions ───────────────────────────────────────────────────────

function importWorkflow() {
  const text = prompt('Paste WorkflowDef JSON:');
  if (!text) return;
  try {
    const parsed = JSON.parse(text);
    workflow = parsed;
    positions = autoLayout(workflow.steps);
    selectedStepId = workflow.steps[0]?.id ?? null;
    document.getElementById('wf-id').value = workflow.id;
    document.getElementById('wf-name').value = workflow.name;
    document.getElementById('wf-version').value = workflow.version;
    renderCanvas();
    renderProps();
    setStatus(`imported "${workflow.id}" (${workflow.steps.length} steps)`);
  } catch (e) {
    setStatus(`import failed: ${e.message}`, 'danger');
  }
}

function exportWorkflow() {
  const text = JSON.stringify(workflow, null, 2);
  navigator.clipboard?.writeText(text).then(
    () => setStatus('JSON copied to clipboard'),
    () => prompt('Copy:', text),
  );
}

async function validateWorkflow(root) {
  setStatus('validating…');
  try {
    const res = await http('POST', '/api/workflows/json/validate', workflow);
    if (res.ok) {
      setStatus('valid', 'ok');
    } else {
      const first = res.errors[0];
      setStatus(`${res.errors.length} error(s) — ${first.path}: ${first.message}`, 'danger');
    }
  } catch (e) { setStatus(`validate failed: ${e.message}`, 'danger'); }
}

async function saveWorkflow(root) {
  setStatus('saving…');
  try {
    // POST /api/workflows/json validates the shape AND registers the
    // workflow in memory so Run can use it immediately. For durable
    // storage the operator still drops a file into WORKFLOW_DIR — this
    // endpoint is the dashboard's quick-iterate path.
    const res = await http('POST', '/api/workflows/json', workflow);
    if (res && res.ok === false) {
      const first = res.errors?.[0];
      setStatus(`save blocked — ${first?.path}: ${first?.message}`, 'danger');
      return;
    }
    setStatus('saved (in memory); Run will use this workflow', 'ok');
    refreshWorkflowList();
  } catch (e) { setStatus(`save failed: ${e.message}`, 'danger'); }
}

async function runWorkflow(root) {
  if (!workflow.id) { setStatus('workflow id required', 'danger'); return; }
  setStatus('running…');
  try {
    const res = await http('POST', `/api/workflows/json/${encodeURIComponent(workflow.id)}/run`, {});
    lastRunSummary = res.run;
    setStatus(`run ${res.run.status}`, res.run.status === 'completed' ? 'ok' : 'danger');
    renderProps();
  } catch (e) { setStatus(`run failed: ${e.message}`, 'danger'); }
}

function setStatus(text, level) {
  const el = document.getElementById('wf-status');
  if (!el) return;
  el.textContent = text;
  el.className = 'ml-auto ' + (level === 'danger' ? 'text-danger' : level === 'ok' ? 'text-ok' : 'text-text-muted');
}

// ─── Layout helpers ────────────────────────────────────────────────────────

function autoLayout(steps) {
  const out = {};
  steps.forEach((s, i) => { out[s.id] = { x: 60 + 220 * (i % 6), y: 60 + 130 * Math.floor(i / 6) }; });
  return out;
}

function field(label, control) {
  return `
    <label class="block">
      <span class="block text-[11px] uppercase tracking-wide text-text-dim mb-1">${label}</span>
      ${control}
    </label>
  `;
}
function inputCls() {
  return 'w-full bg-base-850 border border-line rounded-md px-2 py-1.5 text-xs focus:outline-none focus:border-accent-500';
}
function selectField(id, options, value) {
  return `
    <select id="${id}" class="${inputCls()}">
      ${options.map(o => `<option value="${attr(o)}" ${o === value ? 'selected' : ''}>${esc(o)}</option>`).join('')}
    </select>
  `;
}
function stepSelect(id, currentStepId, value) {
  return `
    <select id="${id}" class="${inputCls()}">
      <option value="">(none)</option>
      ${workflow.steps.filter(s => s.id !== currentStepId).map(s =>
        `<option value="${attr(s.id)}" ${s.id === value ? 'selected' : ''}>${esc(s.id)}</option>`
      ).join('')}
    </select>
  `;
}

function esc(v) { return String(v ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
function attr(v) { return esc(v).replace(/"/g, '&quot;'); }
function escapeHtml(v) { return esc(v); }

// Top-level UI orchestrator. Wires the sidebar / top-bar to the page state,
// drives a tiny hash-based router, opens the login modal on demand, and
// keeps the connection / agents-online indicators in sync with live data.

import { auth, api, live } from './api.js';
import { state, refreshTasks, refreshAgents, bindLiveEvents } from './state.js';
import { renderBoard } from './board.js';
import { renderMemory } from './memory.js';
import { renderSettings } from './settings.js';
import { renderWorkflowEditor } from './workflows.js';
import { renderCrystallized } from './crystallized.js';
import { renderAutonomy } from './autonomy.js';

const PAGE_META = {
  board:        { title: 'Board',          subtitle: 'Drag tasks between columns to assign and progress them.' },
  sessions:     { title: 'Sessions',       subtitle: 'Active agent sessions and chat threads.' },
  memory:       { title: 'Memory Store',   subtitle: 'Reflections, lessons, and per-agent performance.' },
  workflows:    { title: 'Workflows',      subtitle: 'Visual editor for JSON-defined multi-step workflows.' },
  crystallized: { title: 'Learned Skills', subtitle: 'Skills the platform crystallized from successful resolutions.' },
  autonomy:     { title: 'Autonomy',       subtitle: 'Success metrics and watchdog thresholds.' },
  settings:     { title: 'Settings',       subtitle: 'Agent roster, guardrail budgets, and circuit breakers.' },
};

const outlet = document.getElementById('page-outlet');
const titleEl = document.getElementById('page-title');
const subtitleEl = document.getElementById('page-subtitle');
const wsIndicator = document.getElementById('ws-indicator');
const wsLabel = document.getElementById('ws-label');
const agentsOnlineEl = document.getElementById('agents-online');
const loginBtn = document.getElementById('login-btn');
const searchInput = document.getElementById('topbar-search');

let currentPageCleanup = null;

function navigate(route) {
  if (!PAGE_META[route]) route = 'board';
  state.setRoute(route);
  document.querySelectorAll('.nav-item').forEach(b => {
    const isActive = b.dataset.route === route;
    b.classList.toggle('bg-base-800', isActive);
    b.classList.toggle('text-text-primary', isActive);
    b.classList.toggle('font-semibold', isActive);
    if (!isActive) b.classList.remove('border', 'border-line');
  });
  titleEl.textContent = PAGE_META[route].title;
  subtitleEl.textContent = PAGE_META[route].subtitle;
  if (typeof currentPageCleanup === 'function') currentPageCleanup();
  currentPageCleanup = null;
  switch (route) {
    case 'board':        currentPageCleanup = renderBoard(outlet);            break;
    case 'memory':       currentPageCleanup = renderMemory(outlet);           refreshAgents(); break;
    case 'workflows':    currentPageCleanup = renderWorkflowEditor(outlet);   break;
    case 'crystallized': currentPageCleanup = renderCrystallized(outlet);     break;
    case 'autonomy':     currentPageCleanup = renderAutonomy(outlet);         break;
    case 'settings':     currentPageCleanup = renderSettings(outlet);         refreshAgents(); break;
    case 'sessions':
    default:             renderSessionsStub(outlet);                          break;
  }
}

function renderSessionsStub(rootEl) {
  rootEl.innerHTML = `
    <div class="p-6">
      <div class="bg-base-900 border border-line rounded-lg p-8 text-center text-text-muted">
        <h3 class="text-lg font-semibold text-text-primary mb-1">Sessions view</h3>
        <p class="text-sm">Live agent chat sessions will appear here. The agent message bus already powers this on the server side; the page surface is on the roadmap.</p>
      </div>
    </div>
  `;
}

// ─── Login flow ────────────────────────────────────────────────────────────

function openLoginModal() {
  const root = document.getElementById('modal-root');
  root.innerHTML = `
    <div class="fixed inset-0 modal-backdrop flex items-center justify-center z-50">
      <form id="login-form" class="bg-base-900 border border-line rounded-xl w-[400px] max-w-[92vw] shadow-2xl overflow-hidden">
        <header class="flex items-center justify-between px-5 py-3.5 border-b border-line">
          <h3 class="font-semibold text-sm">Sign in</h3>
          <button type="button" class="modal-close text-text-dim hover:text-text-primary">✕</button>
        </header>
        <div class="px-5 py-4 space-y-3 text-sm">
          <label class="block">
            <span class="block text-text-muted text-xs mb-1">Username</span>
            <input id="li-user" type="text" autocomplete="username" value="${auth.username || 'operator'}" required class="w-full bg-base-850 border border-line rounded-md px-3 py-2 focus:outline-none focus:border-accent-500" />
          </label>
          <label class="block">
            <span class="block text-text-muted text-xs mb-1">Password</span>
            <input id="li-pass" type="password" autocomplete="current-password" required class="w-full bg-base-850 border border-line rounded-md px-3 py-2 focus:outline-none focus:border-accent-500" />
          </label>
          <div id="li-err" class="text-danger text-xs"></div>
        </div>
        <footer class="flex items-center justify-end gap-2 px-5 py-3 border-t border-line bg-base-850">
          <button type="button" class="modal-close px-3 py-1.5 text-sm text-text-muted hover:text-text-primary">Cancel</button>
          <button type="submit" class="px-3 py-1.5 bg-accent-600 hover:bg-accent-500 rounded-md text-sm font-medium">Sign in</button>
        </footer>
      </form>
    </div>
  `;
  const close = () => { root.innerHTML = ''; };
  root.querySelectorAll('.modal-close').forEach(b => b.addEventListener('click', close));
  const form = root.querySelector('#login-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = root.querySelector('#li-user').value.trim();
    const password = root.querySelector('#li-pass').value;
    try {
      const data = await api.login(username, password);
      auth.token = data.session?.token || data.token;
      auth.username = data.session?.username || username;
      close();
      updateLoginButton();
      refreshTasks();
      refreshAgents();
    } catch (err) {
      root.querySelector('#li-err').textContent = err.message || 'Login failed';
    }
  });
}

function updateLoginButton() {
  if (auth.token) {
    loginBtn.textContent = `Logout (${auth.username || 'me'})`;
    loginBtn.classList.remove('bg-accent-600', 'hover:bg-accent-500');
    loginBtn.classList.add('bg-base-800', 'hover:bg-base-700', 'border', 'border-line');
  } else {
    loginBtn.textContent = 'Login';
    loginBtn.classList.add('bg-accent-600', 'hover:bg-accent-500');
    loginBtn.classList.remove('bg-base-800', 'hover:bg-base-700', 'border', 'border-line');
  }
}

loginBtn.addEventListener('click', () => {
  if (auth.token) {
    auth.clear();
    updateLoginButton();
    state.set({ tasks: [], agents: [], agentsOnline: 0 });
  } else {
    openLoginModal();
  }
});

// ─── Top-bar search ────────────────────────────────────────────────────────

let searchDebounce;
searchInput.addEventListener('input', () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => state.setSearch(searchInput.value), 120);
});

// ─── Sidebar wiring ────────────────────────────────────────────────────────

document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => {
    const route = btn.dataset.route;
    location.hash = `#/${route}`;
  });
});

window.addEventListener('hashchange', () => {
  const route = (location.hash || '#/board').replace(/^#\//, '');
  navigate(route);
});

// ─── Connection indicator ──────────────────────────────────────────────────

state.subscribe(() => {
  if (live.connected) {
    wsIndicator.classList.remove('bg-danger', 'bg-text-dim');
    wsIndicator.classList.add('bg-ok');
    wsLabel.textContent = 'live';
  } else {
    wsIndicator.classList.remove('bg-ok');
    wsIndicator.classList.add('bg-text-dim');
    wsLabel.textContent = 'offline';
  }
  agentsOnlineEl.textContent = state.get().agentsOnline ?? 0;
});

// ─── Boot ──────────────────────────────────────────────────────────────────

bindLiveEvents();
live.connect();
updateLoginButton();
refreshAgents();

// Initial route from hash, defaulting to board.
const initialRoute = (location.hash || '#/board').replace(/^#\//, '');
navigate(initialRoute);

// Periodic refresh of usage / agent counters every 30s so the top-bar stays
// fresh even when no events fire.
setInterval(() => refreshAgents(), 30_000);

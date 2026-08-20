// Shared sidebar component - auto-injects consistent navigation
(function() {
  var currentPath = window.location.pathname;

  var navItems = [
    { href: '/home.html', icon: '**', label: 'Home' },
    { section: 'Operations' },
    { href: '/incidents', icon: '!', label: 'Incidents' },
    { href: '/workflows', icon: '>', label: 'Workflows' },
    { href: '/runbooks', icon: '#', label: 'Runbooks' },
    { href: '/servers', icon: '@', label: 'Servers' },
    { href: '/monitoring.html', icon: '%', label: 'Monitoring' },
    { section: 'Integrations' },
    { href: '/jira.html', icon: '*', label: 'Jira' },
    { href: '/a2a.html', icon: '&', label: 'A2A Mesh' },
    { section: 'System' },
    { href: '/agent-details.html', icon: '$', label: 'Agents' },
    { href: '/agents-manage.html', icon: '%%', label: 'Agent Manager' },
    { href: '/workflows.html', icon: '&&', label: 'Workflows' },
    { href: '/servers.html', icon: '@@', label: 'Servers' },
    { href: '/webhooks.html', icon: '<<', label: 'Webhooks' },
    { href: '/scheduler', icon: '~', label: 'Scheduler' },
    { href: '/security.html', icon: '^', label: 'Security' },
    { href: '/users.html', icon: '+', label: 'Users', id: 'nav-users', hidden: true },
    { section: 'Communication' },
    { href: '/agent-chat.html', icon: '<', label: 'Agent Chat' },
    { href: '/roundtable.html', icon: '$$', label: 'Roundtable' },
    { href: '/stats.html', icon: '##', label: 'Stats' },
    { href: '/scheduled-tasks.html', icon: '@@', label: 'Scheduler' },
    { href: '/knowledge-base.html', icon: '??', label: 'Knowledge Base' },
    { href: '/audit.html', icon: '!!', label: 'Audit Trail' },
    { href: '/health.html', icon: '++', label: 'Health' },
    { href: '/agent-bridge', icon: '<>', label: 'Agent Bridge' },
    { section: 'Tools' },
    { href: '/dashboard', icon: '=', label: 'Dashboard' },
    { href: '/cicd', icon: '|', label: 'CI/CD' },
    { href: '/audit', icon: '.', label: 'Audit' },
    { href: '/rbac', icon: ':', label: 'RBAC' },
    { href: '/plugin-manager', icon: ',', label: 'Plugins' },
    { href: '/agent-runtime', icon: '>>', label: 'Agent Runtime' }
  ];

  function isActive(href) {
    if (!href) return false;
    if (currentPath === href) return true;
    if (currentPath === href.replace('.html', '')) return true;
    if (currentPath + '.html' === href) return true;
    return false;
  }

  function esc(s) { var d = document.createElement('span'); d.textContent = s; return d.innerHTML; }

  var navHtml = navItems.map(function(item) {
    if (item.section) {
      return '<span class="sidebar-section">' + esc(item.section) + '</span>';
    }
    var active = isActive(item.href) ? ' active' : '';
    var style = item.hidden ? ' style="display:none"' : '';
    var id = item.id ? ' id="' + item.id + '"' : '';
    return '<a href="' + esc(item.href) + '" class="nav-item' + active + '"' + id + style + '>' +
      '<span class="nav-icon">' + esc(item.icon) + '</span>' + esc(item.label) + '</a>';
  }).join('\n    ');

  var sidebarHtml = '<aside class="sidebar">\n' +
    '  <div class="sidebar-logo"><span>[=] IT OPS</span></div>\n' +
    '  <nav class="sidebar-nav">\n    ' + navHtml + '\n  </nav>\n' +
    '  <div class="sidebar-footer">\n' +
    '    <div class="sidebar-user">\n' +
    '      <div class="sidebar-avatar" id="user-avatar">?</div>\n' +
    '      <div class="sidebar-user-info">\n' +
    '        <div class="sidebar-username" id="user-name">---</div>\n' +
    '        <div class="sidebar-role" id="user-role"></div>\n' +
    '      </div>\n' +
    '    </div>\n' +
    '    <div class="sidebar-actions">\n' +
    '      <button class="btn-icon" onclick="doLogout()" title="Logout">[X]</button>\n' +
    '    </div>\n' +
    '  </div>\n' +
    '</aside>';

  // Only inject if no sidebar already exists
  if (!document.querySelector('.sidebar')) {
    // Wrap existing body content in main if needed
    var body = document.body;
    var existingContent = body.innerHTML;

    // Check if content is already wrapped in <main>
    if (!body.querySelector('main.main')) {
      // Find the old .nav element and remove it (replaced by sidebar)
      var oldNav = body.querySelector('.nav');
      if (oldNav) oldNav.remove();

      body.innerHTML = sidebarHtml + '\n<main class="main">\n' +
        '<div class="page-content">' + body.innerHTML + '</div>\n</main>';
    } else {
      body.insertAdjacentHTML('afterbegin', sidebarHtml);
    }

    // Add design.css and theme.css if not present
    if (!document.querySelector('link[href="/design.css"]')) {
      var link = document.createElement('link');
      link.rel = 'stylesheet'; link.href = '/design.css';
      document.head.appendChild(link);
    }
    if (!document.querySelector('link[href="/theme.css"]')) {
      var link2 = document.createElement('link');
      link2.rel = 'stylesheet'; link2.href = '/theme.css';
      document.head.appendChild(link2);
    }
  }
})();


// Notification Bell Widget
(function() {
  var token = sessionStorage.getItem('itops_token') || localStorage.getItem('itops_token');
  if (!token) return;

  var bellHtml = '<div id="notif-bell" style="position:fixed;top:12px;right:16px;z-index:10000;cursor:pointer;">' +
    '<div style="width:36px;height:36px;border-radius:50%;background:var(--bg2,#1e1e2e);border:1px solid var(--border,#333);display:flex;align-items:center;justify-content:center;font-size:16px;" id="notif-bell-icon">\u{1F514}</div>' +
    '<span id="notif-badge" style="position:absolute;top:-2px;right:-2px;background:#e74c3c;color:#fff;font-size:10px;font-weight:700;border-radius:8px;padding:1px 5px;display:none;"></span>' +
    '</div>' +
    '<div id="notif-panel" style="position:fixed;top:54px;right:16px;width:360px;max-height:480px;background:var(--bg2,#1e1e2e);border:1px solid var(--border,#333);border-radius:8px;box-shadow:0 8px 32px rgba(0,0,0,.4);z-index:10000;display:none;overflow:hidden;">' +
    '<div style="padding:10px 14px;border-bottom:1px solid var(--border,#333);display:flex;align-items:center;justify-content:space-between;">' +
    '<span style="font-size:.85rem;font-weight:600;color:var(--text,#eee);">Notifications</span>' +
    '<button id="notif-read-all" style="font-size:.7rem;border:none;background:none;color:var(--accent,#7c3aed);cursor:pointer;">Mark all read</button>' +
    '</div>' +
    '<div id="notif-list" style="max-height:400px;overflow-y:auto;padding:8px;"></div>' +
    '</div>';

  document.body.insertAdjacentHTML('beforeend', bellHtml);

  var bell = document.getElementById('notif-bell');
  var panel = document.getElementById('notif-panel');
  var badge = document.getElementById('notif-badge');
  var list = document.getElementById('notif-list');
  var readAllBtn = document.getElementById('notif-read-all');

  bell.onclick = function() {
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    if (panel.style.display === 'block') loadNotifs();
  };

  document.addEventListener('click', function(e) {
    if (!bell.contains(e.target) && !panel.contains(e.target)) panel.style.display = 'none';
  });

  readAllBtn.onclick = function() {
    fetch('/api/notifications/read-all', { method: 'PUT', headers: { 'Authorization': 'Bearer ' + token } })
      .then(function() { loadNotifs(); });
  };

  function loadNotifs() {
    fetch('/api/notifications?limit=20', { headers: { 'Authorization': 'Bearer ' + token } })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        // Handle both array (old API) and object format
        var notifs = Array.isArray(data) ? data : (data.notifications || []);
        var unread = notifs.filter(function(n) { return !n.read; }).length;
        badge.style.display = unread > 0 ? 'inline' : 'none';
        badge.textContent = unread > 9 ? '9+' : unread;
        if (notifs.length === 0) {
          list.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text3,#666);font-size:.8rem;">No notifications</div>';
          return;
        }
        list.innerHTML = notifs.map(function(n) {
          var ntype = n.type || n.severity || 'info';
          var icon = ntype === 'error' || ntype === 'critical' ? '\u{274C}' : ntype === 'warning' ? '\u{26A0}\u{FE0F}' : ntype === 'success' ? '\u{2705}' : '\u{2139}\u{FE0F}';
          var bg = n.read ? 'transparent' : 'rgba(124,58,237,.05)';
          var ts = n.timestamp || n.created_at;
          var diff = Date.now() - new Date(ts).getTime();
          var ago = diff < 60000 ? Math.round(diff/1000)+'s' : diff < 3600000 ? Math.round(diff/60000)+'m' : diff < 86400000 ? Math.round(diff/3600000)+'h' : Math.round(diff/86400000)+'d';
          return '<div style="padding:8px 10px;border-radius:6px;background:'+bg+';margin-bottom:4px;border-left:3px solid '+(ntype==='error'||ntype==='critical'?'#e74c3c':ntype==='warning'?'#f1c40f':ntype==='success'?'#2ecc71':'#7c3aed')+';">' +
            '<div style="display:flex;align-items:center;gap:6px;">' +
            '<span style="font-size:12px;">'+icon+'</span>' +
            '<span style="font-size:.8rem;font-weight:600;color:var(--text,#eee);flex:1;">'+n.title+'</span>' +
            '<span style="font-size:.65rem;color:var(--text3,#666);">'+ago+'</span>' +
            '</div>' +
            '<div style="font-size:.72rem;color:var(--text2,#aaa);margin-top:3px;line-height:1.3;">'+(n.message||'').slice(0,120)+'</div>' +
            (n.agentName ? '<div style="font-size:.65rem;color:var(--text3,#666);margin-top:2px;">via '+n.agentName+'</div>' : '') +
            '</div>';
        }).join('');
      });
  }

  // Poll for unread count
  function checkUnread() {
    fetch('/api/notifications?limit=50', { headers: { 'Authorization': 'Bearer ' + token } })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        var notifs = Array.isArray(data) ? data : (data.notifications || []);
        var unread = notifs.filter(function(n) { return !n.read; }).length;
        badge.style.display = unread > 0 ? 'inline' : 'none';
        badge.textContent = unread > 9 ? '9+' : unread;
      }).catch(function(){});
  }
  checkUnread();
  setInterval(checkUnread, 15000);
})();

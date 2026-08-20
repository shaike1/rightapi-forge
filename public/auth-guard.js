// IT Ops Auth Guard — include on every page that requires authentication
// Redirects to /login.html if no token found, populates sidebar user info
(function() {
  var token = sessionStorage.getItem('itops_token') || localStorage.getItem('itops_token');

  // Pages that don't require auth
  var noAuthPages = ['/login.html', '/login', '/tui', '/tui.html'];
  var currentPath = window.location.pathname;
  var isPublicPage = noAuthPages.some(function(p) { return currentPath === p; });

  if (!token && !isPublicPage) {
    window.location.href = '/login.html?return=' + encodeURIComponent(currentPath);
    return;
  }

  // Hide sidebar until auth confirmed (prevents flash)
  var sidebar = document.querySelector('.sidebar');
  if (sidebar && !isPublicPage) {
    sidebar.style.visibility = 'hidden';
  }

  if (token) {
    fetch('/api/auth/me', { headers: { Authorization: 'Bearer ' + token } })
      .then(function(r) {
        if (!r.ok) throw new Error('Unauthorized');
        return r.json();
      })
      .then(function(u) {
        // Show sidebar
        if (sidebar) sidebar.style.visibility = 'visible';

        // Populate user info
        var nameEl = document.getElementById('user-name');
        var roleEl = document.getElementById('user-role');
        var avatarEl = document.getElementById('user-avatar');
        var navUsers = document.getElementById('nav-users');

        if (nameEl) nameEl.textContent = u.username || '---';
        if (roleEl) roleEl.textContent = u.role || '';
        if (avatarEl && u.username) avatarEl.textContent = u.username[0].toUpperCase();
        if (navUsers && u.role === 'admin') navUsers.style.display = 'flex';
      })
      .catch(function() {
        // Token invalid — clear and redirect
        if (!isPublicPage) {
          sessionStorage.removeItem('itops_token');
          localStorage.removeItem('itops_token');
          window.location.href = '/login.html?return=' + encodeURIComponent(currentPath);
        }
      });
  }

  // Global logout function
  window.doLogout = function() {
    sessionStorage.removeItem('itops_token');
    localStorage.removeItem('itops_token');
    // Also clear legacy keys
    try {
      localStorage.removeItem('dashboard.ops.token');
      localStorage.removeItem('itops_global_token');
    } catch(e) {}
    window.location.href = '/login.html';
  };
})();

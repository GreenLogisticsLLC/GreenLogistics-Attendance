/**
 * Administration module pages — placeholder UI with sub-nav.
 */
window.GreenOSModules = window.GreenOSModules || {};
window.GreenOSModules['administration'] = {
  children: [
      { id: 'users', title: 'Users' },
      { id: 'email-accounts', title: 'Email Accounts' },
      { id: 'roles', title: 'Roles' },
      { id: 'permissions', title: 'Permissions' },
      { id: 'company-settings', title: 'Company Settings' },
      { id: 'api-integrations', title: 'API Integrations' },
      { id: 'audit-log', title: 'Audit Log' },
      { id: 'system-logs', title: 'System Logs' },
  ],

  render(root, subPageId) {
    if (!root) return;
    var children = this.children || [];
    var active = children.find(function (c) { return c.id === subPageId; }) || children[0];
    var label = active ? active.title : 'Administration';

    var navHtml = children.map(function (c) {
      var isActive = active && c.id === active.id;
      return (
        '<button type="button" class="gos-subnav-item' + (isActive ? ' is-active' : '') + '" data-subpage="' + c.id + '">' +
        c.title +
        '</button>'
      );
    }).join('');

    root.innerHTML =
      '<div class="gos-module-placeholder" data-module="administration">' +
      '  <nav class="gos-subnav" aria-label="Administration sections">' + navHtml + '</nav>' +
      '  <div class="gos-module-body" id="administration-body"></div>' +
      '</div>';

    root.querySelectorAll('[data-subpage]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        window.GreenOSModules['administration'].render(root, btn.getAttribute('data-subpage'));
      });
    });

    var body = root.querySelector('#administration-body');
    if (active && active.id === 'email-accounts') {
      this.renderEmailAccounts(body);
      return;
    }
    body.innerHTML =
      '<h2>Administration — ' + label + '</h2>' +
      '<p>Coming soon</p>';
  },

  async renderEmailAccounts(body) {
    if (!body) return;
    body.innerHTML =
      '<section class="gos-dash-hero">' +
      '<h1>Email Accounts</h1>' +
      '<p>Company Gmail creates new Shipments. Each broker Gmail updates only Shipments assigned to that broker.</p>' +
      '</section>' +
      '<div style="display:flex;gap:0.75rem;align-items:center;flex-wrap:wrap;margin-bottom:1rem">' +
      '<button type="button" class="btn-primary" id="email-account-connect-help" style="width:auto">+ Connect Gmail</button>' +
      '<button type="button" class="btn-secondary" id="email-accounts-refresh" style="width:auto">Refresh</button>' +
      '<span class="gos-muted" id="email-accounts-summary">Loading…</span>' +
      '</div>' +
      '<div class="table-wrap"><table>' +
      '<thead><tr><th>Email</th><th>Employee</th><th>Status</th><th>Last Sync</th><th>Action</th></tr></thead>' +
      '<tbody id="email-accounts-body"><tr><td colspan="5">Loading…</td></tr></tbody>' +
      '</table></div>';

    var tbody = body.querySelector('#email-accounts-body');
    var summary = body.querySelector('#email-accounts-summary');

    function esc(value) {
      return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function fmtDate(value) {
      if (!value) return '—';
      try {
        return new Date(value).toLocaleString();
      } catch {
        return String(value);
      }
    }

    async function api(path, options) {
      var token = localStorage.getItem('gl_token');
      var response = await fetch('/api/email' + path, {
        method: (options && options.method) || 'GET',
        headers: {
          'Content-Type': 'application/json',
          Authorization: token ? 'Bearer ' + token : '',
        },
      });
      return response.json();
    }

    async function load() {
      summary.textContent = 'Loading…';
      var response = await api('/broker/accounts');
      if (!response.success) {
        summary.textContent = response.message || 'Failed to load Gmail accounts';
        tbody.innerHTML = '<tr><td colspan="5">Unable to load accounts</td></tr>';
        return;
      }

      var rows = response.data || [];
      var connected = rows.filter(function (row) {
        return row.status === 'CONNECTED' && row.isActive;
      }).length;
      summary.textContent = connected + ' connected / ' + rows.length + ' broker(s)';

      tbody.innerHTML = rows.map(function (row) {
        var isConnected = row.status === 'CONNECTED' && row.isActive;
        var statusLabel =
          row.status === 'RECONNECT_REQUIRED'
            ? '⚠ Reconnect required'
            : isConnected
              ? '✅ Connected'
              : '❌ Not connected';
        return (
          '<tr>' +
          '<td>' + esc(row.gmailAddress || '—') + '</td>' +
          '<td><strong>' + esc(row.name) + '</strong>' +
          (row.employeeNumber ? '<br><span class="gos-muted">' + esc(row.employeeNumber) + '</span>' : '') +
          '</td>' +
          '<td>' + statusLabel +
          (row.lastError ? '<br><span style="color:var(--red)">' + esc(row.lastError) + '</span>' : '') +
          '</td>' +
          '<td>' + fmtDate(row.lastSyncAt) + '</td>' +
          '<td>' +
          (isConnected
            ? '<button type="button" class="btn-secondary" data-disconnect-user="' + esc(row.userId) + '">Disconnect</button>'
            : '<span class="gos-muted">Broker must connect</span>') +
          '</td>' +
          '</tr>'
        );
      }).join('') || '<tr><td colspan="5">No Broker accounts found</td></tr>';

      tbody.querySelectorAll('[data-disconnect-user]').forEach(function (button) {
        button.addEventListener('click', async function () {
          if (!confirm('Disconnect this broker Gmail from Green OS?')) return;
          button.disabled = true;
          var result = await api(
            '/broker/accounts/' + encodeURIComponent(button.getAttribute('data-disconnect-user')) + '/disconnect',
            { method: 'POST' }
          );
          if (!result.success) alert(result.message || 'Disconnect failed');
          await load();
        });
      });
    }

    body.querySelector('#email-account-connect-help').addEventListener('click', function () {
      alert(
        'For security, each broker connects their own Gmail: sign in as Broker → My Workspace → Personal Dashboard → Connect Gmail. Administrators can monitor and disconnect accounts here.'
      );
    });
    body.querySelector('#email-accounts-refresh').addEventListener('click', load);

    await load();
  },
};
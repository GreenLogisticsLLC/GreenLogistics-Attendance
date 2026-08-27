/**
 * Administration module pages — placeholder UI with sub-nav.
 */
window.GreenOSModules = window.GreenOSModules || {};
window.GreenOSModules['administration'] = {
  children: [
      { id: 'users', title: 'Users' },
      { id: 'email-accounts', title: 'Email Accounts' },
      { id: 'carrier-onboarding', title: 'Carrier Onboarding' },
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
    if (active && active.id === 'company-settings') {
      this.renderCompanySettings(body);
      return;
    }
    if (active && active.id === 'api-integrations') {
      this.renderApiIntegrations(body);
      return;
    }
    if (active && active.id === 'carrier-onboarding') {
      if (window.GreenOS && typeof window.GreenOS.navigate === 'function') {
        window.GreenOS.navigate('carriers');
        return;
      }
      if (window.GreenOSModules.carriers) {
        window.GreenOSModules.carriers.render(body);
        return;
      }
    }
    body.innerHTML =
      '<h2>Administration — ' + label + '</h2>' +
      '<p>Coming soon</p>';
  },

  async renderCompanySettings(body) {
    if (!body) return;
    body.innerHTML =
      '<section class="gos-dash-hero">' +
      '<h1>Company Settings — Assignment &amp; Mailing</h1>' +
      '<p>Clean slate clears old shipments. Refresh redistributes unworked leads to brokers who are In Office and stops importing older Gmail.</p>' +
      '</section>' +
      '<div class="gos-card" style="padding:1.25rem;margin-bottom:1rem">' +
      '<h3 style="margin:0 0 0.5rem">Refresh mailing</h3>' +
      '<p class="gos-muted" style="margin:0 0 0.75rem">From this moment: ignore old unread company Gmail, reclaim shipments brokers did not accept, assign parked leads to In Office brokers.</p>' +
      '<button type="button" class="btn-primary" id="assign-refresh-mailing" style="width:auto">Refresh mailing &amp; redistribute</button>' +
      '</div>' +
      '<div class="gos-card" style="padding:1.25rem;margin-bottom:1rem;border-color:#c45c5c">' +
      '<h3 style="margin:0 0 0.5rem">Start clean slate</h3>' +
      '<p class="gos-muted" style="margin:0 0 0.75rem">Deletes <strong>all</strong> shipments / CRM pipeline cards. Keeps users, Gmail accounts, and attendance. Then mailing only imports mail received after this click.</p>' +
      '<button type="button" class="btn-secondary" id="assign-clean-slate" style="width:auto;background:#b42318;color:#fff;border-color:#b42318">Start clean slate (delete all shipments)</button>' +
      '</div>' +
      '<p id="assign-ops-msg" class="gos-muted"></p>';

    var token = localStorage.getItem('gl_token') || '';
    var msg = body.querySelector('#assign-ops-msg');

    async function post(path, payload) {
      var res = await fetch('/api/assignment' + path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + token,
        },
        body: JSON.stringify(payload || {}),
      });
      var json = await res.json().catch(function () { return {}; });
      if (!res.ok || json.success === false) {
        throw new Error(json.message || ('HTTP ' + res.status));
      }
      return json;
    }

    body.querySelector('#assign-refresh-mailing')?.addEventListener('click', async function () {
      if (!window.confirm('Refresh mailing now? Unworked shipments will move to In Office brokers. Old unread Gmail will be skipped from this moment.')) {
        return;
      }
      try {
        msg.textContent = 'Refreshing…';
        var json = await post('/refresh-mailing', {});
        var d = json.data || {};
        msg.textContent =
          (json.message || 'Done') +
          ' | dismissed unread: ' + (d.dismissedUnread || 0) +
          ', reclaimed: ' + (d.reclaimed || 0) +
          ', drained: ' + (d.drained || 0) +
          ', In Office: ' + ((d.eligible || []).join(', ') || 'none');
      } catch (err) {
        msg.textContent = err.message || String(err);
      }
    });

    body.querySelector('#assign-clean-slate')?.addEventListener('click', async function () {
      var typed = window.prompt(
        'This DELETES all shipments. Type CLEAN_SLATE_SHIPMENTS to confirm.'
      );
      if (typed !== 'CLEAN_SLATE_SHIPMENTS') {
        msg.textContent = 'Clean slate cancelled.';
        return;
      }
      try {
        msg.textContent = 'Cleaning…';
        var json = await post('/clean-slate', { confirm: 'CLEAN_SLATE_SHIPMENTS' });
        var d = json.data || {};
        msg.textContent =
          (json.message || 'Clean slate done') +
          ' | deleted: ' + (d.deletedShipments || 0) +
          ', import after: ' + (d.importAfter || '—');
      } catch (err) {
        msg.textContent = err.message || String(err);
      }
    });
  },

  async renderApiIntegrations(body) {
    if (!body) return;
    body.innerHTML =
      '<h2>API Integrations</h2>' +
      '<p class="gos-muted">CarrierView token stays on the server only — never shown here.</p>' +
      '<div class="gos-card" id="cv-status-card" style="padding:1rem 1.25rem;margin-bottom:1rem">Loading CarrierView…</div>' +
      '<div style="display:flex;gap:0.5rem;flex-wrap:wrap">' +
      '<button type="button" class="btn-primary" id="cv-test" style="width:auto">Test connection (GET /api/profile)</button>' +
      '<button type="button" class="btn-secondary" id="cv-register" style="width:auto">Register webhooks</button>' +
      '<button type="button" class="btn-secondary" id="cv-reconcile" style="width:auto">Reconcile now</button>' +
      '</div>' +
      '<p id="cv-msg" class="gos-muted" style="margin-top:0.75rem"></p>';

    var token = localStorage.getItem('gl_token') || '';
    async function api(path, opts) {
      var res = await fetch('/api/integrations/carrier-view' + path, Object.assign({
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + token,
        },
      }, opts || {}));
      var json = await res.json().catch(function () { return {}; });
      if (!res.ok || json.success === false) throw new Error(json.message || ('HTTP ' + res.status));
      return json.data;
    }
    async function paint() {
      try {
        var d = await api('/admin/status');
        var card = body.querySelector('#cv-status-card');
        var conn =
          !d.tokenConfigured || !d.baseUrlConfigured
            ? 'NOT CONNECTED'
            : d.healthy === true
              ? 'CONNECTED'
              : d.healthy === false
                ? 'FAILED'
                : 'CONFIGURED';
        card.innerHTML =
          '<h3 style="margin:0 0 0.5rem">CarrierView — <strong>' + conn + '</strong></h3>' +
          '<p>Enabled: <strong>' + (d.enabled ? 'yes' : 'no') + '</strong></p>' +
          '<p>API token: <strong>' + (d.tokenConfigured ? 'configured' : 'missing') + '</strong></p>' +
          '<p>API base URL: <strong>' + (d.baseUrlConfigured ? (d.baseUrlHost || 'set') : 'missing') + '</strong></p>' +
          '<p>Connection: <strong>' +
          (d.healthy === true ? 'healthy' : d.healthy === false ? 'failed' : 'not tested') +
          '</strong>' +
          (d.error ? ' — ' + d.error : '') +
          '</p>' +
          '<p>Webhooks (register these in CarrierView or use Register):</p>' +
          '<ul style="margin:0.35rem 0;padding-left:1.25rem;font-size:0.9rem;word-break:break-all">' +
          '<li>Position: ' + (d.webhooks && d.webhooks.position) + '</li>' +
          '<li>Load status: ' + (d.webhooks && d.webhooks.loadStatus) + '</li>' +
          '<li>Chat: ' + (d.webhooks && d.webhooks.chat) + '</li>' +
          '</ul>';
      } catch (err) {
        body.querySelector('#cv-status-card').textContent = err.message || err;
      }
    }
    body.querySelector('#cv-test')?.addEventListener('click', async function () {
      var msg = body.querySelector('#cv-msg');
      try {
        msg.textContent = 'Testing…';
        await paint();
        msg.textContent = 'Status refreshed.';
      } catch (err) {
        msg.textContent = err.message || err;
      }
    });
    body.querySelector('#cv-register')?.addEventListener('click', async function () {
      var msg = body.querySelector('#cv-msg');
      try {
        msg.textContent = 'Registering webhooks with CarrierView…';
        var urls = await api('/admin/register-webhooks', { method: 'POST', body: '{}' });
        msg.textContent = 'Webhooks registered.';
        console.log(urls);
        await paint();
      } catch (err) {
        msg.textContent = err.message || err;
      }
    });
    body.querySelector('#cv-reconcile')?.addEventListener('click', async function () {
      var msg = body.querySelector('#cv-msg');
      try {
        msg.textContent = 'Reconciling…';
        var r = await api('/admin/reconcile', { method: 'POST', body: '{}' });
        msg.textContent = 'Checked ' + (r.checked || 0) + ', updated ' + (r.updated || 0);
      } catch (err) {
        msg.textContent = err.message || err;
      }
    });
    await paint();
  },

  async renderEmailAccounts(body) {
    if (!body) return;
    body.innerHTML =
      '<section class="gos-dash-hero">' +
      '<h1>Email Accounts</h1>' +
      '<p>Same as company Gmail: Owner connects each broker mailbox once. After that, uShip emails on that Gmail update the shipment card automatically (questions, accepted codes, booked, lost). Brokers do not need to connect anything.</p>' +
      '</section>' +
      '<div class="gos-card" style="margin-bottom:1rem;padding:1rem 1.25rem">' +
      '<strong>Connect a broker Gmail (one time)</strong>' +
      '<ol style="margin:0.5rem 0 0;padding-left:1.25rem;line-height:1.55">' +
      '<li>Click <em>Connect Gmail</em> on the broker row.</li>' +
      '<li>On Google, sign in as <strong>that broker\'s personal Gmail</strong> (the one uShip emails) — same idea as connecting company Gmail.</li>' +
      '<li>Click Allow. GreenOS stores access and syncs uShip mail forever (until Disconnect).</li>' +
      '</ol>' +
      '</div>' +
      '<div style="display:flex;gap:0.75rem;align-items:center;flex-wrap:wrap;margin-bottom:1rem">' +
      '<button type="button" class="btn-primary" id="email-accounts-sync-all" style="width:auto">Sync all now</button>' +
      '<button type="button" class="btn-secondary" id="email-accounts-refresh" style="width:auto">Refresh</button>' +
      '<span class="gos-muted" id="email-accounts-summary">Loading…</span>' +
      '</div>' +
      '<div class="table-wrap"><table>' +
      '<thead><tr><th>Gmail</th><th>Broker</th><th>Status</th><th>Last Sync</th><th>Action</th></tr></thead>' +
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
          Accept: 'application/json',
          Authorization: token ? 'Bearer ' + token : '',
        },
      });
      return response.json();
    }

    async function connectBroker(userId, button) {
      button.disabled = true;
      button.textContent = 'Opening Google…';
      try {
        var result = await api(
          '/broker/accounts/' + encodeURIComponent(userId) + '/connect?json=1'
        );
        if (!result.success || !result.data || !result.data.url) {
          alert(result.message || 'Could not start Gmail connect');
          button.textContent = 'Connect Gmail';
          button.disabled = false;
          return;
        }
        // Same pattern as company Connect Gmail — browser goes to Google consent.
        window.location.href = result.data.url;
      } catch (err) {
        alert('Connect failed');
        button.textContent = 'Connect Gmail';
        button.disabled = false;
      }
    }

    async function load() {
      summary.textContent = 'Loading…';
      var response;
      try {
        response = await api('/broker/accounts');
      } catch (err) {
        // A restarting server returns an HTML error page — never leave the table on "Loading…".
        summary.textContent = 'Server is not responding. Reload the page in a moment.';
        tbody.innerHTML = '<tr><td colspan="5">Connection error — press Refresh to retry</td></tr>';
        return;
      }
      if (!response.success) {
        summary.textContent = response.message || 'Failed to load Gmail accounts';
        tbody.innerHTML = '<tr><td colspan="5">Unable to load accounts</td></tr>';
        return;
      }

      var rows = response.data || [];
      var connected = rows.filter(function (row) {
        return row.status === 'CONNECTED' && row.isActive;
      }).length;
      var missing = rows.length - connected;
      summary.textContent =
        connected + ' connected / ' + rows.length + ' broker(s)' +
        (missing ? ' — ' + missing + ' without Gmail (still can receive loads if In Office; connect for uShip updates)' : '');

      tbody.innerHTML = rows.map(function (row) {
        var isConnected = row.status === 'CONNECTED' && row.isActive;
        var statusLabel =
          row.status === 'RECONNECT_REQUIRED'
            ? '⚠ Reconnect required'
            : isConnected
              ? '✅ Connected'
              : '❌ Not connected';
        var connectLabel =
          row.status === 'RECONNECT_REQUIRED'
            ? 'Reconnect Gmail'
            : isConnected
              ? 'Reconnect'
              : 'Connect Gmail';
        return (
          '<tr>' +
          '<td>' + esc(row.gmailAddress || '—') + '</td>' +
          '<td><strong>' + esc(row.name) + '</strong>' +
          (row.employeeNumber ? '<br><span class="gos-muted">' + esc(row.employeeNumber) + '</span>' : '') +
          (!row.employeeId ? '<br><span style="color:var(--red)">No employee link</span>' : '') +
          '</td>' +
          '<td>' + statusLabel +
          (row.lastError ? '<br><span style="color:var(--red)">' + esc(row.lastError) + '</span>' : '') +
          '</td>' +
          '<td>' + fmtDate(row.lastSyncAt) + '</td>' +
          '<td style="display:flex;gap:0.4rem;flex-wrap:wrap">' +
          (row.employeeId
            ? '<button type="button" class="btn-primary" style="width:auto" data-connect-user="' +
              esc(row.userId) +
              '">' +
              connectLabel +
              '</button>'
            : '<span class="gos-muted">Link employee first</span>') +
          (isConnected
            ? '<button type="button" class="btn-secondary" style="width:auto" data-disconnect-user="' +
              esc(row.userId) +
              '">Disconnect</button>'
            : '') +
          '</td>' +
          '</tr>'
        );
      }).join('') || '<tr><td colspan="5">No Broker accounts found</td></tr>';

      tbody.querySelectorAll('[data-connect-user]').forEach(function (button) {
        button.addEventListener('click', function () {
          connectBroker(button.getAttribute('data-connect-user'), button);
        });
      });

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

    body.querySelector('#email-accounts-refresh').addEventListener('click', load);
    body.querySelector('#email-accounts-sync-all').addEventListener('click', async function () {
      var btn = body.querySelector('#email-accounts-sync-all');
      btn.disabled = true;
      btn.textContent = 'Syncing…';
      try {
        var result = await api('/check', { method: 'POST' });
        if (!result.success) {
          alert(result.message || 'Sync failed');
        }
      } catch (e) {
        alert('Sync failed');
      }
      btn.disabled = false;
      btn.textContent = 'Sync all now';
      await load();
    });

    window.GreenOSEmailAccountsReload = function () {
      if (!document.body.contains(body)) return;
      load();
    };

    await load();
  },
};

/**
 * Broker-only GreenOS workspace.
 * Personal Dashboard · My Shipments · My Customers · Notifications
 */
window.GreenOSModules = window.GreenOSModules || {};
window.GreenOSModules.broker = {
  children: [
    { id: "dashboard", title: "Personal Dashboard" },
    { id: "shipments", title: "My Shipments" },
    { id: "customers", title: "My Customers" },
    { id: "notifications", title: "Notifications" },
  ],

  render(root, subPageId) {
    if (!root) return;
    var self = this;
    var children = this.children;
    var active =
      children.find(function (c) {
        return c.id === subPageId;
      }) || children[0];

    var nav = children
      .map(function (c) {
        return (
          '<button type="button" class="gos-subnav-item' +
          (active.id === c.id ? " is-active" : "") +
          '" data-subpage="' +
          c.id +
          '">' +
          c.title +
          "</button>"
        );
      })
      .join("");

    root.innerHTML =
      '<div class="gos-module-placeholder broker-root">' +
      '<nav class="gos-subnav">' +
      nav +
      "</nav>" +
      '<div class="gos-module-body" id="broker-body"><p>Loading…</p></div>' +
      '<div id="crm-modal" class="crm-modal hidden"></div>' +
      "</div>";

    root.querySelectorAll("[data-subpage]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        self.render(root, btn.getAttribute("data-subpage"));
      });
    });

    var body = root.querySelector("#broker-body");
    if (active.id === "shipments") self.renderShipments(body, root);
    else if (active.id === "customers") self.renderCustomers(body, root);
    else if (active.id === "notifications") self.renderNotifications(body);
    else self.renderDashboard(body, root);
  },

  async api(path, options) {
    var token = localStorage.getItem("gl_token");
    var res = await fetch("/api/crm" + path, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Authorization: token ? "Bearer " + token : "",
        ...(options && options.headers),
      },
    });
    return res.json();
  },

  esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  },

  fmtDate(v) {
    if (!v) return "—";
    try {
      return new Date(v).toLocaleString();
    } catch {
      return String(v);
    }
  },

  statusBadge(status) {
    if (window.GreenOSModules.crm && window.GreenOSModules.crm.statusBadge) {
      return window.GreenOSModules.crm.statusBadge(status);
    }
    return "<strong>" + this.esc(status) + "</strong>";
  },

  async renderDashboard(body, root) {
    body.innerHTML = "<p>Loading dashboard…</p>";
    try {
      var data = await this.api("/dashboard");
      if (!data.success) {
        body.innerHTML = "<p>" + this.esc(data.message) + "</p>";
        return;
      }
      var d = data.data || {};
      var s = d.stats || {};
      var name = (d.broker && d.broker.name) || "Broker";
      body.innerHTML =
        '<section class="gos-dash-hero">' +
        "<h1>Personal Dashboard</h1>" +
        "<p>Welcome, " +
        this.esc(name) +
        " — only your shipments</p>" +
        "</section>" +
        '<div class="gos-card-grid">' +
        this.card("Active", s.currentShipments || 0, "accent-green") +
        this.card("Awaiting Acceptance", s.awaitingAcceptance || 0, "accent-warn") +
        this.card("Follow Up", s.followUp || 0, "accent-warn") +
        this.card("Quotes Sent", s.quotesSent || 0, "accent-blue") +
        this.card("Won", s.won || 0, "accent-green") +
        this.card("Lost", s.lost || 0, "accent-warn") +
        "</div>" +
        '<section class="gos-module-placeholder" style="margin-top:1.25rem" id="broker-gmail-box">' +
        "<h3>My Gmail (uShip sync)</h3>" +
        '<p class="gos-muted">Connect your broker Gmail. GreenOS monitors uShip emails only — personal mail is ignored.</p>' +
        '<p id="broker-gmail-status">Checking…</p>' +
        '<div style="display:flex;gap:0.5rem;flex-wrap:wrap;margin-top:0.75rem">' +
        '<button type="button" class="btn-primary" id="broker-gmail-connect" style="width:auto">Connect Gmail</button>' +
        '<button type="button" class="btn-secondary" id="broker-gmail-sync" style="width:auto">Sync now</button>' +
        '<button type="button" class="btn-secondary" id="broker-gmail-disconnect" style="width:auto">Disconnect</button>' +
        "</div></section>" +
        '<p style="margin-top:1rem"><button type="button" class="btn-primary" id="broker-goto-shipments" style="width:auto">Open My Shipments</button></p>';
      body.querySelector("#broker-goto-shipments")?.addEventListener("click", function () {
        window.GreenOSModules.broker.render(root, "shipments");
      });
      window.GreenOSModules.broker.bindGmailBox(body);
    } catch {
      body.innerHTML = "<p>Failed to load dashboard</p>";
    }
  },

  async emailApi(path, options) {
    var token = localStorage.getItem("gl_token");
    var res = await fetch("/api/email" + path, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: token ? "Bearer " + token : "",
        ...(options && options.headers),
      },
    });
    return res.json();
  },

  async bindGmailBox(body) {
    var statusEl = body.querySelector("#broker-gmail-status");
    var self = this;
    async function refresh() {
      try {
        var data = await self.emailApi("/broker/status");
        if (!data.success) {
          statusEl.textContent = data.message || "Status unavailable";
          return;
        }
        var d = data.data || {};
        if (d.connected) {
          statusEl.innerHTML =
            "Connected: <strong>" +
            self.esc(d.gmailAddress) +
            "</strong>" +
            (d.lastSyncAt ? " · last sync " + self.fmtDate(d.lastSyncAt) : "") +
            (d.lastError ? '<br><span style="color:var(--red)">' + self.esc(d.lastError) + "</span>" : "");
        } else {
          statusEl.textContent = d.oauthClientConfigured
            ? "Not connected — click Connect Gmail"
            : "Gmail OAuth is not configured on the server";
        }
      } catch {
        statusEl.textContent = "Could not load Gmail status";
      }
    }
    body.querySelector("#broker-gmail-connect")?.addEventListener("click", async function () {
      var data = await self.emailApi("/broker/auth?json=1");
      if (data.success && data.data && data.data.url) {
        window.location.href = data.data.url;
      } else {
        alert(data.message || "Could not start Gmail OAuth");
      }
    });
    body.querySelector("#broker-gmail-sync")?.addEventListener("click", async function () {
      statusEl.textContent = "Syncing…";
      var data = await self.emailApi("/broker/sync", { method: "POST" });
      statusEl.textContent = data.message || (data.success ? "Synced" : "Sync failed");
      refresh();
    });
    body.querySelector("#broker-gmail-disconnect")?.addEventListener("click", async function () {
      if (!confirm("Disconnect your Gmail from GreenOS?")) return;
      await self.emailApi("/broker/disconnect", { method: "POST" });
      refresh();
    });
    refresh();
  },

  card(label, value, tone) {
    return (
      '<div class="gos-card ' +
      (tone || "") +
      '"><div class="label">' +
      label +
      '</div><div class="value">' +
      value +
      "</div></div>"
    );
  },

  async renderShipments(body, root) {
    body.innerHTML = "<p>Loading my shipments…</p>";
    try {
      var data = await this.api("/shipments");
      if (!data.success) {
        body.innerHTML = "<p>" + this.esc(data.message) + "</p>";
        return;
      }
      var rows = data.data || [];
      body.innerHTML =
        '<section class="gos-dash-hero"><h1>My Shipments</h1><p>Shipments assigned to you</p></section>' +
        '<div class="table-wrap"><table class="crm-table"><thead><tr>' +
        "<th>#</th><th>Shipment</th><th>Customer</th><th>Pickup</th><th>Delivery</th><th>Status</th><th>Updated</th>" +
        '</tr></thead><tbody id="broker-ship-body"></tbody></table></div>';
      var tbody = body.querySelector("#broker-ship-body");
      if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="7">No shipments assigned yet</td></tr>';
        return;
      }
      var esc = this.esc.bind(this);
      var fmt = this.fmtDate.bind(this);
      var badge = this.statusBadge.bind(this);
      tbody.innerHTML = rows
        .map(function (s, i) {
          return (
            '<tr class="crm-row" data-id="' +
            s.shipmentLeadId +
            '"><td>' +
            (i + 1) +
            "</td><td><strong>" +
            esc(s.greenOsShipmentId || s.shipmentTitle) +
            "</strong>" +
            (s.greenOsShipmentId
              ? '<br><small class="gos-muted">' + esc(s.shipmentTitle) + "</small>"
              : "") +
            "</td><td>" +
            esc(s.customer) +
            "</td><td>" +
            esc(s.pickup) +
            "</td><td>" +
            esc(s.delivery) +
            "</td><td>" +
            badge(s.status) +
            "</td><td>" +
            fmt(s.updatedAt) +
            "</td></tr>"
          );
        })
        .join("");
      tbody.querySelectorAll("[data-id]").forEach(function (tr) {
        tr.addEventListener("click", function () {
          if (window.GreenOSModules.crm && window.GreenOSModules.crm.openShipmentCard) {
            window.GreenOSModules.crm.openShipmentCard(root, tr.getAttribute("data-id"));
          }
        });
      });
    } catch {
      body.innerHTML = "<p>Failed to load shipments</p>";
    }
  },

  async renderCustomers(body) {
    body.innerHTML = "<p>Loading customers…</p>";
    try {
      var data = await this.api("/customers");
      if (!data.success) {
        body.innerHTML = "<p>" + this.esc(data.message) + "</p>";
        return;
      }
      var rows = data.data || [];
      body.innerHTML =
        '<section class="gos-dash-hero"><h1>My Customers</h1><p>From your assigned shipments</p></section>' +
        '<div class="table-wrap"><table class="crm-table"><thead><tr>' +
        "<th>Customer</th><th>Shipments</th><th>Last Status</th><th>Updated</th>" +
        '</tr></thead><tbody id="broker-cust-body"></tbody></table></div>';
      var tbody = body.querySelector("#broker-cust-body");
      if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="4">No customers yet</td></tr>';
        return;
      }
      var esc = this.esc.bind(this);
      var fmt = this.fmtDate.bind(this);
      tbody.innerHTML = rows
        .map(function (c) {
          return (
            "<tr><td><strong>" +
            esc(c.customer) +
            "</strong></td><td>" +
            c.shipmentCount +
            "</td><td>" +
            esc(c.lastStatus) +
            "</td><td>" +
            fmt(c.lastUpdated) +
            "</td></tr>"
          );
        })
        .join("");
    } catch {
      body.innerHTML = "<p>Failed to load customers</p>";
    }
  },

  async renderNotifications(body) {
    body.innerHTML = "<p>Loading notifications…</p>";
    try {
      var data = await this.api("/notifications");
      if (!data.success) {
        body.innerHTML = "<p>" + this.esc(data.message) + "</p>";
        return;
      }
      var rows = data.data || [];
      var soundOn = localStorage.getItem("gos_notify_sound") !== "0";
      body.innerHTML =
        '<section class="gos-dash-hero"><h1>Notifications</h1>' +
        "<p>Live assignment alerts (SSE) + recent queue events. No page refresh needed.</p></section>" +
        '<label class="gos-muted" style="display:flex;align-items:center;gap:0.5rem;margin-bottom:1rem">' +
        '<input type="checkbox" id="broker-sound-toggle"' +
        (soundOn ? " checked" : "") +
        "/> Play sound on new assignment</label>" +
        '<ul class="broker-notify-list" id="broker-notify"></ul>';
      body.querySelector("#broker-sound-toggle")?.addEventListener("change", function (e) {
        var on = !!e.target.checked;
        if (window.GreenOSRealtime) window.GreenOSRealtime.setSoundEnabled(on);
        else localStorage.setItem("gos_notify_sound", on ? "1" : "0");
      });
      var list = body.querySelector("#broker-notify");
      if (!rows.length) {
        list.innerHTML = "<li class=\"gos-muted\">No notifications yet — new assignments will pop up live</li>";
        return;
      }
      var esc = this.esc.bind(this);
      var fmt = this.fmtDate.bind(this);
      list.innerHTML = rows
        .map(function (n) {
          return (
            "<li><strong>" +
            esc(n.type) +
            "</strong> — " +
            esc(n.message) +
            '<br><small class="gos-muted">' +
            fmt(n.createdAt) +
            "</small></li>"
          );
        })
        .join("");
    } catch {
      body.innerHTML = "<p>Failed to load notifications</p>";
    }
  },
};

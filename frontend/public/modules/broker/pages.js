/**
 * Broker-only GreenOS workspace.
 * Personal Dashboard · My Shipments · My Customers · MY Carrier · ON Road · Notifications
 */
window.GreenOSModules = window.GreenOSModules || {};
window.GreenOSModules.broker = {
  children: [
    { id: "dashboard", title: "Personal Dashboard" },
    { id: "shipments", title: "My Shipments" },
    { id: "customers", title: "My Customers" },
    { id: "carriers", title: "MY Carrier" },
    { id: "on-road", title: "ON Road" },
    { id: "notifications", title: "Notifications" },
  ],
  _shipmentsTimer: null,

  stopShipmentsAutoRefresh() {
    if (this._shipmentsTimer) {
      clearInterval(this._shipmentsTimer);
      this._shipmentsTimer = null;
    }
  },

  render(root, subPageId) {
    if (!root) return;
    var self = this;
    this.stopShipmentsAutoRefresh();
    var children = this.children;
    var active =
      children.find(function (c) {
        return c.id === subPageId;
      }) || children[0];

    if (window.GreenOS) {
      window.GreenOS.currentModule = "broker";
      window.GreenOS.currentSub = active.id;
    }

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
    else if (active.id === "carriers") self.renderCarriers(body, root);
    else if (active.id === "on-road") self.renderOnRoad(body, root);
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
        "<h3>Personal Gmail (uShip updates)</h3>" +
        '<p class="gos-muted">Your Team Lead / Owner connects this mailbox once (like company Gmail). After that, GreenOS automatically shows questions, accepted codes, and booking updates on your shipment cards.</p>' +
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
    var authUrl = null;
    async function refresh() {
      try {
        var data = await self.emailApi("/broker/status");
        if (!data.success) {
          statusEl.textContent = data.message || "Status unavailable";
          return;
        }
        var d = data.data || {};
        authUrl = d.authUrl;
        var connectButton = body.querySelector("#broker-gmail-connect");
        var syncButton = body.querySelector("#broker-gmail-sync");
        var disconnectButton = body.querySelector("#broker-gmail-disconnect");
        if (d.connected) {
          statusEl.innerHTML =
            "<strong>" +
            self.esc(d.gmailAddress) +
            "</strong><br>Status: <span style=\"color:#22c55e\">Connected</span>" +
            "<br>Last Sync: " +
            (d.lastSyncAt ? self.fmtDate(d.lastSyncAt) : "Not synced yet") +
            (d.lastError ? '<br><span style="color:var(--red)">' + self.esc(d.lastError) + "</span>" : "");
          if (connectButton) connectButton.hidden = true;
          if (syncButton) syncButton.hidden = false;
          if (disconnectButton) disconnectButton.hidden = true;
        } else {
          statusEl.innerHTML = d.oauthClientConfigured
            ? "Status: <strong>Not connected yet</strong><br><span class=\"gos-muted\">Owner connects your uShip Gmail once under Administration → Email Accounts. You do not need to do anything here.</span>"
            : "Status: <strong>OAuth is not configured on the server</strong>";
          if (connectButton) connectButton.hidden = true;
          if (syncButton) syncButton.hidden = true;
          if (disconnectButton) disconnectButton.hidden = true;
        }
      } catch {
        statusEl.textContent = "Could not load Gmail status";
      }
    }
    body.querySelector("#broker-gmail-connect")?.addEventListener("click", async function () {
      if (!authUrl) {
        alert("This GreenOS account is not linked to an employee profile.");
        return;
      }
      var separator = authUrl.indexOf("?") >= 0 ? "&" : "?";
      var path = authUrl.replace("/api/email", "") + separator + "json=1";
      var data = await self.emailApi(path);
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
    var self = this;
    body.innerHTML =
      '<section class="gos-dash-hero"><h1>My Shipments</h1><p>Shipments assigned to you — list refreshes automatically every 10 seconds</p></section>' +
      '<p class="gos-muted" id="broker-ship-sync" style="margin:0 0 0.75rem">Loading…</p>' +
      '<div class="table-wrap"><table class="crm-table"><thead><tr>' +
      "<th>#</th><th>Shipment</th><th>Customer</th><th>Pickup</th><th>Delivery</th><th>Status</th><th>Updated</th>" +
      '</tr></thead><tbody id="broker-ship-body"><tr><td colspan="7">Loading…</td></tr></tbody></table></div>';

    async function paint() {
      var tbody = document.getElementById("broker-ship-body");
      var syncEl = document.getElementById("broker-ship-sync");
      if (!tbody) return;
      try {
        var data = await self.api("/shipments");
        if (!data.success) {
          if (syncEl) syncEl.textContent = data.message || "Failed to load";
          return;
        }
        var rows = data.data || [];
        if (syncEl) {
          syncEl.textContent =
            "Auto-refresh on · " +
            rows.length +
            " shipment(s) · updated " +
            new Date().toLocaleTimeString();
        }
        if (!rows.length) {
          tbody.innerHTML = '<tr><td colspan="7">No shipments assigned yet</td></tr>';
          return;
        }
        var esc = self.esc.bind(self);
        var fmt = self.fmtDate.bind(self);
        var badge = self.statusBadge.bind(self);
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
        if (syncEl) syncEl.textContent = "Refresh failed — retrying…";
      }
    }

    window.GreenOSBrokerReloadShipments = function () {
      if (!document.getElementById("broker-ship-body")) return;
      paint();
    };

    self.stopShipmentsAutoRefresh();
    self._shipmentsTimer = setInterval(function () {
      if (document.hidden) return;
      if (!document.getElementById("broker-ship-body")) {
        self.stopShipmentsAutoRefresh();
        return;
      }
      paint();
    }, 10000);

    await paint();
  },

  async renderCustomers(body, root) {
    body.innerHTML = "<p>Loading customers…</p>";
    try {
      var data = await this.api("/customers");
      if (!data.success) {
        body.innerHTML = "<p>" + this.esc(data.message) + "</p>";
        return;
      }
      var rows = data.data || [];
      body.innerHTML =
        '<section class="gos-dash-hero"><h1>My Customers</h1><p>Same Shipment Cards — no duplicate records</p></section>' +
        '<div class="table-wrap"><table class="crm-table"><thead><tr>' +
        "<th>Customer</th><th>Shipments</th><th>Last Status</th><th>Updated</th>" +
        '</tr></thead><tbody id="broker-cust-body"></tbody></table></div>' +
        '<div id="broker-customer-detail"></div>';
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
            '<tr class="crm-row" data-customer="' +
            esc(c.customer) +
            '"><td><strong>' +
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
      tbody.querySelectorAll("[data-customer]").forEach(function (tr) {
        tr.addEventListener("click", function () {
          window.GreenOSModules.broker.openCustomer(
            body.querySelector("#broker-customer-detail"),
            tr.getAttribute("data-customer"),
            root
          );
        });
      });
    } catch {
      body.innerHTML = "<p>Failed to load customers</p>";
    }
  },

  async renderCarriers(body, root) {
    body.innerHTML = "<p>Loading carriers…</p>";
    try {
      var data = await this.api("/carriers");
      if (!data.success) {
        body.innerHTML = "<p>" + this.esc(data.message) + "</p>";
        return;
      }
      var rows = data.data || [];
      body.innerHTML =
        '<section class="gos-dash-hero">' +
        "<h1>MY Carrier</h1>" +
        "<p>Carriers that worked with you — filled from Operations on the shipment card</p>" +
        "</section>" +
        '<div class="table-wrap"><table class="crm-table"><thead><tr>' +
        "<th>Carrier</th><th>Shipments</th><th>Active</th><th>Drivers used</th><th>Last status</th><th>Updated</th>" +
        '</tr></thead><tbody id="broker-carrier-body"></tbody></table></div>';
      var tbody = body.querySelector("#broker-carrier-body");
      if (!rows.length) {
        tbody.innerHTML =
          '<tr><td colspan="6">No carriers yet — add Carrier in Operations on a shipment card</td></tr>';
        return;
      }
      var esc = this.esc.bind(this);
      var fmt = this.fmtDate.bind(this);
      tbody.innerHTML = rows
        .map(function (c) {
          return (
            "<tr><td><strong>" +
            esc(c.carrier) +
            "</strong></td><td>" +
            c.shipmentCount +
            "</td><td>" +
            c.activeCount +
            "</td><td>" +
            esc((c.drivers || []).join(", ") || "—") +
            "</td><td>" +
            esc(c.lastStatus || "—") +
            "</td><td>" +
            fmt(c.lastUpdated) +
            "</td></tr>"
          );
        })
        .join("");
    } catch {
      body.innerHTML = "<p>Failed to load carriers</p>";
    }
  },

  async renderOnRoad(body, root) {
    body.innerHTML = "<p>Loading On Road…</p>";
    try {
      var data = await this.api("/on-road");
      if (!data.success) {
        body.innerHTML = "<p>" + this.esc(data.message) + "</p>";
        return;
      }
      var payload = data.data || {};
      var rows = payload.items || [];
      body.innerHTML =
        '<section class="gos-dash-hero">' +
        "<h1>ON Road</h1>" +
        "<p>Drivers currently hauling your loads (Dispatch / in transit) — " +
        (payload.count || 0) +
        " active</p>" +
        "</section>" +
        '<div class="table-wrap"><table class="crm-table"><thead><tr>' +
        "<th>Driver</th><th>Carrier</th><th>Truck</th><th>Trailer</th><th>Load #</th><th>Route</th><th>Shipment</th><th>Updated</th>" +
        '</tr></thead><tbody id="broker-onroad-body"></tbody></table></div>';
      var tbody = body.querySelector("#broker-onroad-body");
      if (!rows.length) {
        tbody.innerHTML =
          '<tr><td colspan="8">Nobody on the road right now — set status to Dispatch and fill Driver in Operations</td></tr>';
        return;
      }
      var esc = this.esc.bind(this);
      var fmt = this.fmtDate.bind(this);
      tbody.innerHTML = rows
        .map(function (r) {
          return (
            '<tr class="crm-row" data-id="' +
            esc(r.shipmentLeadId) +
            '"><td><strong>' +
            esc(r.driver) +
            "</strong></td><td>" +
            esc(r.carrier) +
            "</td><td>" +
            esc(r.truck) +
            "</td><td>" +
            esc(r.trailer) +
            "</td><td>" +
            esc(r.loadNumber || "—") +
            "</td><td>" +
            esc(r.pickup) +
            " → " +
            esc(r.delivery) +
            "</td><td>" +
            esc(r.greenOsShipmentId || r.shipmentLeadId.slice(0, 8)) +
            "</td><td>" +
            fmt(r.updatedAt) +
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
      body.innerHTML = "<p>Failed to load On Road</p>";
    }
  },

  async openCustomer(host, name, root) {
    if (!host) return;
    host.innerHTML = "<p>Loading customer…</p>";
    try {
      var data = await this.api("/customers/" + encodeURIComponent(name));
      if (!data.success) {
        host.innerHTML = "<p>" + this.esc(data.message) + "</p>";
        return;
      }
      var d = data.data || {};
      var fin = d.financial || {};
      var esc = this.esc.bind(this);
      var fmt = this.fmtDate.bind(this);
      var badge = this.statusBadge.bind(this);
      host.innerHTML =
        '<section class="gos-module-placeholder" style="margin-top:1rem">' +
        "<h2>" +
        esc(d.customer) +
        "</h2>" +
        '<div class="gos-card-grid">' +
        this.card("Shipments", (d.shipments || []).length, "accent-blue") +
        this.card("Active", fin.active || 0, "accent-green") +
        this.card("Completed", fin.completed || 0, "accent-green") +
        this.card("Quoted $", Math.round(fin.totalQuoted || 0), "accent-warn") +
        "</div>" +
        "<h3>All Shipments</h3>" +
        '<div class="table-wrap"><table class="crm-table"><thead><tr>' +
        "<th>Green OS ID</th><th>Status</th><th>Load #</th><th>Route</th><th>Updated</th>" +
        "</tr></thead><tbody>" +
        (d.shipments || [])
          .map(function (s) {
            return (
              '<tr class="crm-row" data-id="' +
              s.shipmentLeadId +
              '"><td>' +
              esc(s.greenOsShipmentId || s.shipmentLeadId.slice(0, 8)) +
              "</td><td>" +
              badge(s.status) +
              "</td><td>" +
              esc(s.loadNumber || "—") +
              "</td><td>" +
              esc([s.pickupCity, s.deliveryCity].filter(Boolean).join(" → ") || "—") +
              "</td><td>" +
              fmt(s.updatedAt) +
              "</td></tr>"
            );
          })
          .join("") +
        "</tbody></table></div>" +
        "<h3>Timeline / Events</h3><ul class='gos-muted'>" +
        (d.domainEvents || [])
          .slice(0, 40)
          .map(function (e) {
            return (
              "<li><strong>" +
              esc(e.title || e.eventType) +
              "</strong> — " +
              esc(e.message || "") +
              " <small>" +
              fmt(e.createdAt) +
              "</small></li>"
            );
          })
          .join("") +
        (d.domainEvents && d.domainEvents.length ? "" : "<li>No events yet</li>") +
        "</ul>" +
        "<h3>Communication</h3><ul class='gos-muted'>" +
        (d.communications || [])
          .slice(0, 30)
          .map(function (m) {
            return (
              "<li><strong>" +
              esc(m.subject) +
              "</strong><br><small>" +
              esc(m.fromAddress) +
              " · " +
              fmt(m.receivedAt) +
              "</small></li>"
            );
          })
          .join("") +
        (d.communications && d.communications.length ? "" : "<li>No mailbox history</li>") +
        "</ul></section>";
      host.querySelectorAll("[data-id]").forEach(function (tr) {
        tr.addEventListener("click", function () {
          if (window.GreenOSModules.crm) {
            window.GreenOSModules.crm.openShipmentCard(root, tr.getAttribute("data-id"));
          }
        });
      });
    } catch {
      host.innerHTML = "<p>Failed to load customer</p>";
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
      var payload = data.data || {};
      var rows = Array.isArray(payload) ? payload : payload.items || [];
      var unread = payload.unread != null ? payload.unread : 0;
      var soundOn = localStorage.getItem("gos_notify_sound") !== "0";
      body.innerHTML =
        '<section class="gos-dash-hero"><h1>Notification Center</h1>' +
        "<p>GreenOS alerts (not Gmail). Unread: <strong>" +
        unread +
        "</strong></p></section>" +
        '<div style="display:flex;gap:0.75rem;flex-wrap:wrap;align-items:center;margin-bottom:1rem">' +
        '<label class="gos-muted" style="display:flex;align-items:center;gap:0.5rem">' +
        '<input type="checkbox" id="broker-sound-toggle"' +
        (soundOn ? " checked" : "") +
        "/> Play sound</label>" +
        '<button type="button" class="btn-secondary" id="broker-mark-all-read" style="width:auto">Mark all read</button>' +
        "</div>" +
        '<ul class="broker-notify-list" id="broker-notify"></ul>';
      body.querySelector("#broker-sound-toggle")?.addEventListener("change", function (e) {
        var on = !!e.target.checked;
        if (window.GreenOSRealtime) window.GreenOSRealtime.setSoundEnabled(on);
        else localStorage.setItem("gos_notify_sound", on ? "1" : "0");
      });
      body.querySelector("#broker-mark-all-read")?.addEventListener("click", async function () {
        await window.GreenOSModules.broker.api("/notifications/read-all", { method: "POST" });
        window.GreenOSModules.broker.renderNotifications(body);
      });
      var list = body.querySelector("#broker-notify");
      if (!rows.length) {
        list.innerHTML =
          '<li class="gos-muted">No notifications yet — assignments and uShip events appear here</li>';
        return;
      }
      var esc = this.esc.bind(this);
      var fmt = this.fmtDate.bind(this);
      list.innerHTML = rows
        .map(function (n) {
          return (
            '<li class="' +
            (n.status === "UNREAD" ? "is-unread" : "") +
            '" data-id="' +
            esc(n.id) +
            '" data-shipment="' +
            esc(n.shipmentLeadId || "") +
            '"><strong>' +
            esc(n.title || n.type) +
            "</strong> — " +
            esc(n.message) +
            '<br><small class="gos-muted">' +
            fmt(n.createdAt) +
            (n.status === "UNREAD" ? " · UNREAD" : "") +
            "</small></li>"
          );
        })
        .join("");
      list.querySelectorAll("[data-id]").forEach(function (li) {
        li.addEventListener("click", async function () {
          var nid = li.getAttribute("data-id");
          var sid = li.getAttribute("data-shipment");
          await window.GreenOSModules.broker.api("/notifications/" + nid + "/read", {
            method: "POST",
          });
          if (sid && window.GreenOSModules.crm) {
            var host = document.getElementById("gos-module-host");
            if (host) window.GreenOSModules.crm.openShipmentCard(host, sid);
          }
        });
      });
    } catch {
      body.innerHTML = "<p>Failed to load notifications</p>";
    }
  },
};

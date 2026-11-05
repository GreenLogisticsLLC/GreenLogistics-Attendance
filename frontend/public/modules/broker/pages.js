/**
 * Broker-only GreenOS workspace.
 * Personal Dashboard · My Shipments · My Customers · MY Carrier · ON Road · Trucking
 */
window.GreenOSModules = window.GreenOSModules || {};
window.GreenOSModules.broker = {
  children: [
    { id: "dashboard", title: "Personal Dashboard" },
    { id: "shipments", title: "My Shipments" },
    { id: "customer-respond", title: "Customer respond" },
    { id: "loads", title: "My Loads" },
    { id: "customers", title: "My Customers" },
    { id: "carriers", title: "MY Carrier" },
    { id: "on-road", title: "ON Road" },
    { id: "trucking", title: "Trucking" },
  ],
  _shipmentsTimer: null,
  _shipmentsCache: null,
  _customerRespondTimer: null,
  _customerRespondCache: null,

  stopShipmentsAutoRefresh() {
    if (this._shipmentsTimer) {
      clearInterval(this._shipmentsTimer);
      this._shipmentsTimer = null;
    }
    if (this._customerRespondTimer) {
      clearInterval(this._customerRespondTimer);
      this._customerRespondTimer = null;
    }
  },

  render(root, subPageId, opsView) {
    if (!root) return;
    var self = this;
    if (opsView && opsView.brokerId) {
      this._opsView = {
        brokerId: String(opsView.brokerId),
        name: opsView.name || "Employee",
        role: opsView.role || "",
      };
      this._scopeBrokerId = this._opsView.brokerId;
      this._personalMine = false;
    }
    this.stopShipmentsAutoRefresh();
    var children = this.children;
    var active =
      children.find(function (c) {
        return c.id === subPageId;
      }) || children[0];

    if (!this._opsView && window.GreenOS) {
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

    var opsBar = "";
    if (this._opsView) {
      opsBar =
        '<div style="display:flex;gap:0.75rem;align-items:center;flex-wrap:wrap;margin:0 0 0.75rem">' +
        '<button type="button" class="btn-secondary" id="ops-desk-back" style="width:auto">← All brokers</button>' +
        "<strong>" +
        this.esc(this._opsView.name) +
        "</strong>" +
        '<span class="gos-muted">' +
        this.esc(this._opsView.role || "") +
        " — same account they see. You can change everything, pass locked steps, and transfer shipments.</span>" +
        "</div>";
    }
    root.innerHTML =
      '<div class="gos-module-placeholder broker-root" data-module="brokers">' +
      opsBar +
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
    root.querySelector("#ops-desk-back")?.addEventListener("click", function () {
      self._opsView = null;
      self._scopeBrokerId = "";
      self._personalMine = false;
      if (window.GreenOSModules.loads) window.GreenOSModules.loads._listBrokerId = "";
      if (window.GreenOSModules.dispatch) window.GreenOSModules.dispatch._listBrokerId = "";
      if (window.GreenOSModules.brokers) {
        window.GreenOSModules.brokers.render(root);
      }
    });

    var body = root.querySelector("#broker-body");
    var scope = this._opsView
      ? { brokerId: this._opsView.brokerId, mine: false }
      : { brokerId: "", mine: false };
    if (active.id === "shipments") self.renderShipments(body, root, scope);
    else if (active.id === "customer-respond") self.renderCustomerRespond(body, root);
    else if (active.id === "loads") self.renderLoads(body, root);
    else if (active.id === "customers") self.renderCustomers(body, root);
    else if (active.id === "carriers") self.renderCarriers(body, root);
    else if (active.id === "on-road") self.renderOnRoad(body, root);
    else if (active.id === "trucking") {
      if (window.GreenOSModules.trucking) window.GreenOSModules.trucking.render(body);
      else body.innerHTML = "<p>Trucking module not loaded — hard refresh.</p>";
    }
    else self.renderDashboard(body, root);
  },

  renderLoads(body) {
    var loads = window.GreenOSModules.loads;
    var brokerId = this._opsView && this._opsView.brokerId;
    if (loads && typeof loads.render === "function") {
      loads._listBrokerId = brokerId || "";
      loads._keepListBroker = Boolean(brokerId);
      if (window.GreenOSModules.dispatch) {
        window.GreenOSModules.dispatch._listBrokerId = brokerId || "";
      }
      loads.render(body, "active-loads");
      return;
    }
    body.innerHTML =
      "<h2>My Loads</h2><p class=\"gos-muted\">Loads module not loaded. Hard-refresh the page.</p>";
  },

  shipmentsQuery(qs) {
    var q = String(qs || "");
    if (this._scopeBrokerId) {
      q += (q ? "&" : "") + "brokerId=" + encodeURIComponent(this._scopeBrokerId);
    }
    if (this._personalMine) {
      q += (q ? "&" : "") + "mine=1";
    }
    return "/shipments?" + q;
  },

  async api(path, options) {
    var token = localStorage.getItem("gl_token");
    var url = String(path || "");
    if (this._opsView && this._opsView.brokerId && url.indexOf("brokerId=") < 0) {
      url += (url.indexOf("?") >= 0 ? "&" : "?") + "brokerId=" + encodeURIComponent(this._opsView.brokerId);
    }
    var res = await fetch("/api/crm" + url, {
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

  receivedAtLabel(value) {
    if (!value) return "—";
    var d = new Date(value);
    if (isNaN(d.getTime())) return "—";
    return d.toLocaleString("en-GB", {
      timeZone: "Asia/Yerevan",
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
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
        this.card("Bids", s.quotesSent || 0, "accent-blue") +
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

  async renderShipments(body, root, options) {
    var self = this;
    if (options && Object.prototype.hasOwnProperty.call(options, "brokerId")) {
      self._scopeBrokerId = options.brokerId ? String(options.brokerId) : "";
    }
    if (options && Object.prototype.hasOwnProperty.call(options, "mine")) {
      self._personalMine = Boolean(options.mine);
    }
    var activeTab = self._shipmentsTab || "new";
    body.innerHTML =
      '<section class="gos-dash-hero"><h1>My Shipments</h1><p>New imports first — passed loads in Other · accepted work in Accepted · customer-approved loads in Load Created</p></section>' +
      '<nav class="gos-subnav" id="broker-ship-tabs">' +
      '<button type="button" class="gos-subnav-item' +
      (activeTab === "new" ? " is-active" : "") +
      '" data-ship-tab="new">New Shipment <span class="gos-queue-badge" id="broker-ship-count-new">…</span></button>' +
      '<button type="button" class="gos-subnav-item' +
      (activeTab === "other" ? " is-active" : "") +
      '" data-ship-tab="other">Other Shipment <span class="gos-queue-badge" id="broker-ship-count-other">…</span></button>' +
      '<button type="button" class="gos-subnav-item' +
      (activeTab === "decline" ? " is-active" : "") +
      '" data-ship-tab="decline">Decline <span class="gos-queue-badge" id="broker-ship-count-decline">…</span></button>' +
      '<button type="button" class="gos-subnav-item' +
      (activeTab === "accepted" ? " is-active" : "") +
      '" data-ship-tab="accepted">Accepted shipments <span class="gos-queue-badge" id="broker-ship-count-accepted">…</span></button>' +
      '<button type="button" class="gos-subnav-item' +
      (activeTab === "accepted-another" ? " is-active" : "") +
      '" data-ship-tab="accepted-another">Accepted to another company <span class="gos-queue-badge" id="broker-ship-count-aac">…</span></button>' +
      '<button type="button" class="gos-subnav-item' +
      (activeTab === "no-longer" ? " is-active" : "") +
      '" data-ship-tab="no-longer">No longer needed <span class="gos-queue-badge" id="broker-ship-count-nlr">…</span></button>' +
      '<button type="button" class="gos-subnav-item' +
      (activeTab === "loads" ? " is-active" : "") +
      '" data-ship-tab="loads">Load Created <span class="gos-queue-badge" id="broker-ship-count-loads">…</span></button>' +
      "</nav>" +
      '<div class="crm-ship-pager" style="display:flex;flex-wrap:wrap;gap:0.75rem;align-items:center;justify-content:space-between;margin:0 0 0.75rem">' +
      '<p class="gos-muted broker-ship-sync" style="margin:0">Loading…</p>' +
      '<div style="display:flex;gap:0.5rem;align-items:center">' +
      '<label class="crm-page-size">Per page <select class="crm-page-size-select broker-page-size" aria-label="Shipments per page">' +
      "<option value=\"25\">25</option><option value=\"50\">50</option><option value=\"100\">100</option><option value=\"200\">200</option>" +
      "</select></label>" +
      '<button type="button" class="btn-secondary broker-ship-prev" style="width:auto" disabled>Previous</button>' +
      '<button type="button" class="btn-secondary broker-ship-next" style="width:auto" disabled>Next</button>' +
      "</div></div>" +
      '<div class="table-wrap crm-ship-scroll"><table class="crm-table"><thead><tr>' +
      "<th>#</th><th>Shipment</th><th>Customer</th><th>Pickup</th><th>Delivery</th><th>Status</th><th>Bid</th><th>Updates</th><th>Bid Submitted</th><th>Received</th>" +
      (self._opsView ? '<th class="gos-give-head">Give to</th>' : "") +
      '</tr></thead><tbody id="broker-ship-body"><tr><td colspan="' +
      (self._opsView ? "11" : "10") +
      '">Loading…</td></tr></tbody></table></div>' +
      '<div class="crm-ship-pager" style="display:flex;flex-wrap:wrap;gap:0.75rem;align-items:center;justify-content:space-between;margin:0.75rem 0 0">' +
      '<p class="gos-muted broker-ship-sync" style="margin:0">Loading…</p>' +
      '<div style="display:flex;gap:0.5rem;align-items:center">' +
      '<label class="crm-page-size">Per page <select class="crm-page-size-select broker-page-size" aria-label="Shipments per page">' +
      "<option value=\"25\">25</option><option value=\"50\">50</option><option value=\"100\">100</option><option value=\"200\">200</option>" +
      "</select></label>" +
      '<button type="button" class="btn-secondary broker-ship-prev" style="width:auto" disabled>Previous</button>' +
      '<button type="button" class="btn-secondary broker-ship-next" style="width:auto" disabled>Next</button>' +
      "</div></div>";

    body.querySelectorAll("[data-ship-tab]").forEach(function (btn) {
      btn.addEventListener("click", function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        self._shipmentsTab = btn.getAttribute("data-ship-tab") || "new";
        self._shipmentsPage = 1;
        self.renderShipments(body, root, {
          brokerId: self._scopeBrokerId || "",
          mine: Boolean(self._personalMine),
        });
      });
    });
    function syncPageSizeSelects() {
      var current = 50;
      try {
        var storedSize = Number(sessionStorage.getItem("gos_ship_page_size") || "");
        if ([25, 50, 100, 200].indexOf(storedSize) >= 0) current = storedSize;
      } catch (e) {}
      body.querySelectorAll(".broker-page-size").forEach(function (sel) {
        sel.value = String(current);
      });
    }
    syncPageSizeSelects();
    body.querySelectorAll(".broker-page-size").forEach(function (sel) {
      sel.addEventListener("change", function () {
        var nextSize = Number(sel.value);
        if ([25, 50, 100, 200].indexOf(nextSize) < 0) nextSize = 50;
        try {
          sessionStorage.setItem("gos_ship_page_size", String(nextSize));
        } catch (e) {}
        self._shipmentsPage = 1;
        syncPageSizeSelects();
        paint(true);
      });
    });
    body.querySelectorAll(".broker-ship-prev").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var p = Math.max(1, (self._shipmentsPage || 1) - 1);
        if (p === (self._shipmentsPage || 1)) return;
        self._shipmentsPage = p;
        paint(true);
      });
    });
    body.querySelectorAll(".broker-ship-next").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var totalPages = self._shipmentsTotalPages || 1;
        var p = Math.min(totalPages, (self._shipmentsPage || 1) + 1);
        if (p === (self._shipmentsPage || 1)) return;
        self._shipmentsPage = p;
        paint(true);
      });
    });

    var paintGen = 0;
    self._shipmentsPage = self._shipmentsPage || 1;

    function searchQuery() {
      var input = document.getElementById("gos-global-search");
      return input ? String(input.value || "").trim().toLowerCase() : "";
    }

    function isOtherShipment(s) {
      return Boolean(s.isReassignment || s.wasEverReassigned);
    }

    function isAcceptedAnother(s) {
      return s.status === "ACCEPTED_ANOTHER_COMPANY";
    }

    function isNoLongerNeeded(s) {
      return s.status === "NO_LONGER_NEEDED";
    }

    function isRoundDeclined(s) {
      return s.status === "ROUND_DECLINED";
    }

    function isWaitingShipment(s) {
      var st = String(s.status || "");
      return (
        st === "NEW" ||
        st === "UNASSIGNED" ||
        st === "ASSIGNED" ||
        st === "AWAITING_ACCEPTANCE" ||
        st === "AGENT_OPEN"
      );
    }

    function stNotDeleted(s) {
      return String(s.status || "") !== "DELETED_FROM_CUSTOMER";
    }

    function isAcceptedShipment(s) {
      return !isAcceptedAnother(s) && !isNoLongerNeeded(s) && !isRoundDeclined(s) && !isWaitingShipment(s) && stNotDeleted(s);
    }

    function tabLabelFor(tab) {
      if (tab === "other") return "Other Shipment";
      if (tab === "loads") return "Load Created";
      if (tab === "accepted") return "Accepted shipments";
      if (tab === "accepted-another") return "Accepted to another company";
      if (tab === "no-longer") return "No longer needed";
      if (tab === "decline") return "Decline";
      return "New Shipment";
    }

    function rowsForTab(rows) {
      var tab = self._shipmentsTab || "new";
      return rows.filter(function (s) {
        if (isAcceptedAnother(s)) return tab === "accepted-another";
        if (tab === "accepted-another") return false;
        if (isNoLongerNeeded(s)) return tab === "no-longer";
        if (tab === "no-longer") return false;
        if (isRoundDeclined(s)) return tab === "decline";
        if (tab === "decline") return false;
        if (isAcceptedShipment(s)) return tab === "accepted";
        if (tab === "accepted") return false;
        return tab === "other" ? isOtherShipment(s) : !isOtherShipment(s);
      });
    }

    function sortRows(rows) {
      // Waiting → Open in uShip → BROKER REPLY → Bid Submitted → Shipment Accepted → rest
      var priority = {
        AWAITING_ACCEPTANCE: 0,
        ASSIGNED: 0,
        AGENT_OPEN: 1,
        BROKER_REPLY: 2,
        FOLLOW_UP: 2,
        CUSTOMER_REPLIED: 2,
        BID_SUBMITTED: 3,
        QUOTE_SENT: 3,
        WORKING: 4,
      };
      return rows.slice().sort(function (a, b) {
        var pa = priority[a.status] != null ? priority[a.status] : 9;
        var pb = priority[b.status] != null ? priority[b.status] : 9;
        if (pa !== pb) return pa - pb;
        return new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime();
      });
    }

    function filterByLocationZip(rows) {
      var query = searchQuery();
      if (!query) return rows;
      return rows.filter(function (shipment) {
        var locations =
          String(shipment.pickup || "") + " " + String(shipment.delivery || "");
        return locations.toLowerCase().includes(query);
      });
    }

    function updateTabCounts(meta) {
      var newEl = document.getElementById("broker-ship-count-new");
      var otherEl = document.getElementById("broker-ship-count-other");
      var acceptedEl = document.getElementById("broker-ship-count-accepted");
      var aacEl = document.getElementById("broker-ship-count-aac");
      if (newEl && meta.newCount != null) newEl.textContent = String(meta.newCount);
      if (otherEl && meta.otherCount != null) otherEl.textContent = String(meta.otherCount);
      if (acceptedEl && meta.acceptedCount != null)
        acceptedEl.textContent = String(meta.acceptedCount);
      var loadsEl = document.getElementById("broker-ship-count-loads");
      if (loadsEl && meta.loadsCount != null) loadsEl.textContent = String(meta.loadsCount);
      if (aacEl && meta.aacCount != null) aacEl.textContent = String(meta.aacCount);
      var nlrEl = document.getElementById("broker-ship-count-nlr");
      if (nlrEl && meta.nlrCount != null) nlrEl.textContent = String(meta.nlrCount);
      var declineEl = document.getElementById("broker-ship-count-decline");
      if (declineEl && meta.declineCount != null) declineEl.textContent = String(meta.declineCount);
    }

    function renderRows(rows, pageMeta) {
      var tbody = document.getElementById("broker-ship-body");
      if (!tbody) return;
      var staleMenu = document.getElementById("gos-give-menu");
      if (staleMenu) staleMenu.remove();
      var esc = self.esc.bind(self);
      var fmt = self.fmtDate.bind(self);
      var statusCell =
        window.GreenOSModules.crm && window.GreenOSModules.crm.statusCellHtml
          ? window.GreenOSModules.crm.statusCellHtml.bind(window.GreenOSModules.crm)
          : function (st) {
              return self.statusBadge(st);
            };
      var query = searchQuery();
      var tab = self._shipmentsTab || "new";
      var page = pageMeta && pageMeta.page ? pageMeta.page : 1;
      var pageSize = pageMeta && pageMeta.pageSize ? pageMeta.pageSize : 50;
      var visibleRows = sortRows(filterByLocationZip(rows));
      var tabLabel = tabLabelFor(tab);
      if (!visibleRows.length) {
        tbody.innerHTML =
          '<tr><td colspan="' + (self._opsView ? "11" : "10") + '">' +
          (query
            ? "No shipments found for ZIP " + esc(query)
            : "No " + tabLabel.toLowerCase() + " loads yet") +
          "</td></tr>";
        return;
      }
      tbody.innerHTML = visibleRows
        .map(function (s, i) {
          return (
            '<tr class="crm-row' +
            (s.carrierMissingOnPickup ? " load-row-no-carrier" : "") +
            '" data-id="' +
            s.shipmentLeadId +
            '"' +
            (s.carrierMissingOnPickup ? ' title="Pickup day and no carrier registered"' : "") +
            "><td>" +
            ((page - 1) * pageSize + i + 1) +
            "</td><td>" +
            '<div class="gos-ship-title">' +
            esc(s.shipmentTitle || s.greenOsShipmentId || "Shipment") +
            "</div>" +
            (s.greenOsShipmentId
              ? '<div class="gos-ship-id">' + esc(s.greenOsShipmentId) + "</div>"
              : "") +
            (isOtherShipment(s) && tab !== "accepted-another"
              ? '<br><small class="gos-muted">Passed from another broker</small>'
              : "") +
            "</td><td>" +
            esc(s.customer) +
            "</td><td>" +
            esc(s.pickup) +
            "</td><td>" +
            esc(s.delivery) +
            "</td><td>" +
            statusCell(s.status, { customerReplied: Boolean(s.customerReplied) }) +
            "</td><td>" +
            (s.bidSubmitted
              ? '<div class="gos-bid-flag">Bid Submitted</div>' +
                (s.bidSubmittedAt
                  ? '<small class="gos-muted">' + esc(fmt(s.bidSubmittedAt)) + "</small>"
                  : "")
              : '<span class="gos-muted">—</span>') +
            "</td><td>" +
            (function () {
              var bits = [];
              if (Number(s.competitorQuotes) > 0) {
                bits.push(
                  '<div class="gos-competition-badge">Another provider quoted' +
                    (Number(s.competitorQuotes) > 1
                      ? " · " + Number(s.competitorQuotes)
                      : "") +
                    (s.competitorQuoteAt
                      ? '<small>' + esc(fmt(s.competitorQuoteAt)) + "</small>"
                      : "") +
                    "</div>"
                );
              }
              if (s.quoteDeclined) {
                bits.push(
                  '<div class="gos-declined-badge">Customer declined' +
                    (s.quoteDeclinedAt
                      ? '<small>' + esc(fmt(s.quoteDeclinedAt)) + "</small>"
                      : "") +
                    "</div>"
                );
              }
              var alertMs = 0;
              [s.competitorQuoteAt, s.quoteDeclinedAt].forEach(function (v) {
                if (!v) return;
                var ms = new Date(v).getTime();
                if (ms > alertMs) alertMs = ms;
              });
              var bidMs = s.bidSubmittedAt ? new Date(s.bidSubmittedAt).getTime() : 0;
              if (bidMs && alertMs && bidMs >= alertMs) {
                bits.push(
                  '<div class="gos-bid-flag">Bid submitted<small>' +
                    esc(fmt(s.bidSubmittedAt)) +
                    "</small></div>"
                );
              }
              return bits.length ? bits.join("") : '<span class="gos-muted">—</span>';
            })() +
            "</td><td>" +
            '<button type="button" class="btn-secondary gos-bid-btn" data-bid="' +
            esc(s.shipmentLeadId) +
            '">Bid Submitted</button>' +
            (s.status === "AWAITING_ACCEPTANCE" || s.status === "ASSIGNED" || s.status === "AGENT_OPEN"
              ? ' <button type="button" class="btn-secondary gos-decline-btn" data-decline="' +
                esc(s.shipmentLeadId) +
                '">Decline</button>'
              : "") +
            "</td><td>" +
            esc(self.receivedAtLabel(s.assignedAt)) +
            "</td>" +
            (self._opsView
              ? '<td class="gos-give-cell"><div class="gos-give-row">' +
                '<button type="button" class="btn-secondary gos-give-pick" data-give="' +
                esc(s.shipmentLeadId) +
                '">Choose…</button>' +
                '<button type="button" class="btn-secondary gos-transfer-btn" data-transfer="' +
                esc(s.shipmentLeadId) +
                '" disabled>Transfer</button></div></td>'
              : "") +
            "</tr>"
          );
        })
        .join("");
      function closeGiveMenu() {
        var menu = document.getElementById("gos-give-menu");
        if (menu) menu.remove();
      }
      if (!self._giveMenuBound) {
        self._giveMenuBound = true;
        document.addEventListener(
          "pointerdown",
          function (ev) {
            var menu = document.getElementById("gos-give-menu");
            if (!menu) return;
            var target = ev.target;
            if (target && menu.contains(target)) return;
            if (target && target.closest && target.closest(".gos-give-pick")) return;
            menu.remove();
          },
          true
        );
      }
      function openGiveMenu(anchor) {
        closeGiveMenu();
        var people = self._opsGivePeople || [];
        var menu = document.createElement("div");
        menu.id = "gos-give-menu";
        menu.className = "gos-give-menu";
        menu.setAttribute("data-for", anchor.getAttribute("data-give") || "");
        menu.innerHTML = people.length
          ? people
              .map(function (person) {
                return (
                  '<button type="button" data-user="' +
                  self.esc(person.id) +
                  '">' +
                  self.esc(person.label) +
                  "</button>"
                );
              })
              .join("")
          : '<p class="gos-muted">No one else to give this to</p>';
        document.body.appendChild(menu);
        var rect = anchor.getBoundingClientRect();
        var menuRect = menu.getBoundingClientRect();
        var top = rect.bottom + 4;
        if (top + menuRect.height > window.innerHeight - 8) {
          top = Math.max(8, rect.top - menuRect.height - 4);
        }
        var left = rect.left;
        if (left + menuRect.width > window.innerWidth - 8) {
          left = Math.max(8, window.innerWidth - menuRect.width - 8);
        }
        menu.style.top = top + "px";
        menu.style.left = left + "px";
        menu.addEventListener("click", function (ev) {
          ev.preventDefault();
          ev.stopPropagation();
          var choice = ev.target && ev.target.closest ? ev.target.closest("[data-user]") : null;
          if (!choice) return;
          anchor.textContent = choice.textContent || "Choose…";
          anchor.setAttribute("data-to", choice.getAttribute("data-user") || "");
          var transfer = tbody.querySelector(
            '[data-transfer="' + (anchor.getAttribute("data-give") || "") + '"]'
          );
          if (transfer) transfer.disabled = false;
          closeGiveMenu();
        });
      }
      tbody.querySelectorAll(".gos-give-pick").forEach(function (btn) {
        btn.addEventListener("click", function (ev) {
          ev.preventDefault();
          ev.stopPropagation();
          var existing = document.getElementById("gos-give-menu");
          var same =
            existing && existing.getAttribute("data-for") === btn.getAttribute("data-give");
          closeGiveMenu();
          if (!same) openGiveMenu(btn);
        });
      });
      tbody.querySelectorAll(".gos-give-cell").forEach(function (cell) {
        cell.addEventListener("click", function (ev) {
          ev.stopPropagation();
        });
      });
      tbody.querySelectorAll(".gos-transfer-btn").forEach(function (btn) {
        btn.addEventListener("click", async function (ev) {
          ev.preventDefault();
          ev.stopPropagation();
          var id = btn.getAttribute("data-transfer");
          var pick = tbody.querySelector('[data-give="' + id + '"]');
          var toUserId = pick ? pick.getAttribute("data-to") || "" : "";
          if (!toUserId) {
            alert("Choose who should receive this shipment");
            return;
          }
          btn.disabled = true;
          try {
            var json = await self.api("/shipments/" + encodeURIComponent(id) + "/reassign", {
              method: "POST",
              body: JSON.stringify({ toUserId: toUserId }),
            });
            if (!json || json.success === false) {
              throw new Error((json && json.message) || "Could not transfer");
            }
            paint(true);
          } catch (err) {
            alert(err.message || err);
            btn.disabled = false;
          }
        });
      });
      tbody.querySelectorAll(".gos-decline-btn").forEach(function (btn) {
        btn.addEventListener("click", async function (ev) {
          ev.stopPropagation();
          var id = btn.getAttribute("data-decline");
          if (!id) return;
          if (!confirm("Decline this shipment? It goes to the next broker now. The 15-minute timer stays for the others.")) return;
          btn.disabled = true;
          try {
            var json = await self.api("/shipments/" + encodeURIComponent(id) + "/decline", {
              method: "POST",
              body: "{}",
            });
            if (!json || json.success === false) {
              throw new Error((json && json.message) || "Could not decline");
            }
            paint(true);
          } catch (err) {
            alert(err.message || err);
            btn.disabled = false;
          }
        });
      });
      tbody.querySelectorAll(".gos-bid-btn").forEach(function (btn) {
        btn.addEventListener("click", async function (ev) {
          ev.stopPropagation();
          var id = btn.getAttribute("data-bid");
          if (!id) return;
          btn.disabled = true;
          btn.textContent = "Saving…";
          try {
            var json = await self.api(
              "/shipments/" + encodeURIComponent(id) + "/bid-submitted",
              { method: "POST", body: "{}" }
            );
            if (!json || json.success === false) {
              throw new Error((json && json.message) || "Could not save Bid Submitted");
            }
            paint(true);
          } catch (err) {
            alert(err.message || err);
            btn.disabled = false;
            btn.textContent = "Bid Submitted";
          }
        });
      });
      tbody.querySelectorAll("[data-id]").forEach(function (tr) {
        tr.addEventListener("click", function (ev) {
          var target = ev.target;
          if (
            target &&
            target.closest &&
            target.closest("button, select, input, textarea, a, label, .gos-give-cell")
          ) {
            return;
          }
          if (document.getElementById("gos-give-menu")) return;
          if (window.GreenOSModules.crm && window.GreenOSModules.crm.openShipmentCard) {
            var sid = tr.getAttribute("data-id");
            var preview = (self._shipmentsCache || []).find(function (r) {
              return r.shipmentLeadId === sid;
            });
            window.GreenOSModules.crm.openShipmentCard(root, sid, preview);
          }
        });
      });
    }

    function applyGlobalSearch() {
      if (!document.getElementById("broker-ship-body")) return;
      paint(true);
    }

    var globalSearch = document.getElementById("gos-global-search");
    if (window.GreenOSBrokerSearchHandler && globalSearch) {
      globalSearch.removeEventListener("input", window.GreenOSBrokerSearchHandler);
    }
    window.GreenOSBrokerSearchHandler = applyGlobalSearch;
    globalSearch?.addEventListener("input", applyGlobalSearch);

    async function paint(force) {
      if (self._opsView && !self._opsGivePeople) {
        try {
          var staff = await self.api("/brokers");
          var people = staff && staff.success ? staff.data || [] : [];
          self._opsGivePeople = people
            .filter(function (person) {
              return person.brokerId && person.brokerId !== self._opsView.brokerId;
            })
            .map(function (person) {
              return {
                id: String(person.brokerId),
                label: person.name + (person.role ? " · " + person.role : ""),
              };
            });
        } catch (e) {
          self._opsGivePeople = [];
        }
      }
      var tbody = document.getElementById("broker-ship-body");
      var syncEls = body.querySelectorAll(".broker-ship-sync");
      var prevBtns = body.querySelectorAll(".broker-ship-prev");
      var nextBtns = body.querySelectorAll(".broker-ship-next");
      if (!tbody) return;
      var modal = document.getElementById("crm-modal");
      if (
        !force &&
        modal &&
        !modal.classList.contains("hidden") &&
        modal.getAttribute("data-card-loading") === "1"
      ) {
        return;
      }
      if (self._shipmentsPaintBusy) return;
      self._shipmentsPaintBusy = true;
      var myGen = ++paintGen;
      if (self._shipmentsCache && self._shipmentsCache.length) {
        renderRows(self._shipmentsCache, {
          page: self._shipmentsPage || 1,
          pageSize: self._shipmentsPageSize || 50,
        });
        syncEls.forEach(function (el) {
          el.textContent = "Refreshing…";
        });
      }
      try {
        var tab = self._shipmentsTab || "new";
        var page = self._shipmentsPage || 1;
        var pageSize = 50;
        try {
          var storedSize = Number(sessionStorage.getItem("gos_ship_page_size") || "");
          if ([25, 50, 100, 200].indexOf(storedSize) >= 0) pageSize = storedSize;
        } catch (e) {}
        var params = ["page=" + page, "pageSize=" + pageSize];
        if (tab === "accepted-another") {
          params.push("status=ACCEPTED_ANOTHER_COMPANY");
        } else if (tab === "no-longer") {
          params.push("status=NO_LONGER_NEEDED");
        } else if (tab === "decline") {
          params.push("status=ROUND_DECLINED");
        } else if (tab === "accepted") {
          params.push("assignmentKind=accepted");
        } else if (tab === "loads") {
          params.push("assignmentKind=loads");
        } else {
          params.push("assignmentKind=" + encodeURIComponent(tab));
        }
        var data = await self.api(self.shipmentsQuery(params.join("&")));
        if (myGen !== paintGen) return;
        if (!data.success) {
          syncEls.forEach(function (el) {
            el.textContent = data.message || "Failed to load";
          });
          return;
        }
        var payload = data.data || {};
        var rows = Array.isArray(payload)
          ? payload
          : Array.isArray(payload.items)
            ? payload.items
            : [];
        var total = Array.isArray(payload)
          ? rows.length
          : Number(payload.total != null ? payload.total : rows.length) || 0;
        var totalPages = Array.isArray(payload)
          ? 1
          : Math.max(1, Number(payload.totalPages) || Math.ceil(total / pageSize) || 1);
        self._shipmentsCache = rows;
        self._shipmentsPage = page;
        self._shipmentsPageSize = pageSize;
        self._shipmentsTotalPages = totalPages;
        self._shipmentsTotal = total;

        // Lightweight count probes for the other tabs (pageSize=1 → total only).
        try {
          var [newMeta, otherMeta, acceptedMeta, loadsMeta, aacMeta, nlrMeta, declineMeta] = await Promise.all([
            self.api(self.shipmentsQuery("assignmentKind=new&page=1&pageSize=1")),
            self.api(self.shipmentsQuery("assignmentKind=other&page=1&pageSize=1")),
            self.api(self.shipmentsQuery("assignmentKind=accepted&page=1&pageSize=1")),
            self.api(self.shipmentsQuery("assignmentKind=loads&page=1&pageSize=1")),
            self.api(self.shipmentsQuery("status=ACCEPTED_ANOTHER_COMPANY&page=1&pageSize=1")),
            self.api(self.shipmentsQuery("status=NO_LONGER_NEEDED&page=1&pageSize=1")),
            self.api(self.shipmentsQuery("status=ROUND_DECLINED&page=1&pageSize=1")),
          ]);
          updateTabCounts({
            newCount: newMeta && newMeta.success ? (newMeta.data && newMeta.data.total) || 0 : "…",
            otherCount:
              otherMeta && otherMeta.success ? (otherMeta.data && otherMeta.data.total) || 0 : "…",
            acceptedCount:
              acceptedMeta && acceptedMeta.success
                ? (acceptedMeta.data && acceptedMeta.data.total) || 0
                : "…",
            loadsCount:
              loadsMeta && loadsMeta.success ? (loadsMeta.data && loadsMeta.data.total) || 0 : "…",
            aacCount: aacMeta && aacMeta.success ? (aacMeta.data && aacMeta.data.total) || 0 : "…",
            nlrCount: nlrMeta && nlrMeta.success ? (nlrMeta.data && nlrMeta.data.total) || 0 : "…",
            declineCount:
              declineMeta && declineMeta.success ? (declineMeta.data && declineMeta.data.total) || 0 : "…",
          });
        } catch {
          /* counts are optional */
        }

        prevBtns.forEach(function (btn) {
          btn.disabled = page <= 1;
        });
        nextBtns.forEach(function (btn) {
          btn.disabled = page >= totalPages;
        });
        var query = searchQuery();
        var fromIdx = total === 0 ? 0 : (page - 1) * pageSize + 1;
        var toIdx = Math.min(total, (page - 1) * pageSize + rows.length);
        var syncText = query
          ? "ZIP " + query + " · filtering current page"
          : "Showing " +
            fromIdx +
            "–" +
            toIdx +
            " of " +
            total +
            (totalPages > 1 ? " · Page " + page + " / " + totalPages : "") +
            " · updated " +
            new Date().toLocaleTimeString();
        syncEls.forEach(function (el) {
          el.textContent = syncText;
        });
        renderRows(rows, { page: page, pageSize: pageSize });
      } catch (err) {
        var failText =
          "Refresh failed" +
          (err && err.message ? " (" + err.message + ")" : "") +
          (self._shipmentsCache && self._shipmentsCache.length
            ? " — showing cached list"
            : " — retrying…");
        syncEls.forEach(function (el) {
          el.textContent = failText;
        });
      } finally {
        self._shipmentsPaintBusy = false;
      }
    }

    window.GreenOSBrokerReloadShipments = function () {
      if (self._opsView) return;
      paint(true);
    };

    self.stopShipmentsAutoRefresh();
    if (!self._opsView) {
      self._shipmentsTimer = setInterval(function () {
        if (!document.getElementById("broker-ship-body")) {
          self.stopShipmentsAutoRefresh();
          return;
        }
        if (document.hidden) return;
        paint(true);
      }, 50000);
    }

    await paint(true);
  },

  /** Shipments where the customer replied (status CUSTOMER_REPLIED) — this broker only. */
  async renderCustomerRespond(body, root) {
    var self = this;
    body.innerHTML =
      '<section class="gos-dash-hero">' +
      "<h1>Customer respond</h1>" +
      "<p>Only your shipments where the customer replied — open a row to continue</p>" +
      "</section>" +
      '<p class="gos-muted" id="broker-cr-sync" style="margin:0 0 0.75rem">Loading…</p>' +
      '<div class="table-wrap"><table class="crm-table"><thead><tr>' +
      "<th>#</th><th>Shipment</th><th>Customer</th><th>Pickup</th><th>Delivery</th><th>Status</th><th>Updated</th>" +
      '</tr></thead><tbody id="broker-cr-body"><tr><td colspan="7">Loading…</td></tr></tbody></table></div>';

    var paintGen = 0;

    function isCustomerRespond(s) {
      var st = String(s.status || "").toUpperCase();
      return st === "CUSTOMER_REPLIED" || st === "CUSTOMER_RESPOND";
    }

    function renderRows(rows) {
      var tbody = document.getElementById("broker-cr-body");
      if (!tbody) return;
      var esc = self.esc.bind(self);
      var fmt = self.fmtDate.bind(self);
      var statusCell =
        window.GreenOSModules.crm && window.GreenOSModules.crm.statusCellHtml
          ? window.GreenOSModules.crm.statusCellHtml.bind(window.GreenOSModules.crm)
          : function (st) {
              return self.statusBadge(st);
            };
      var filtered = (rows || []).filter(isCustomerRespond);
      self._customerRespondCache = filtered;
      if (!filtered.length) {
        tbody.innerHTML =
          '<tr><td colspan="7">No Customer Respond shipments yet</td></tr>';
        return;
      }
      tbody.innerHTML = filtered
        .map(function (s, i) {
          return (
            '<tr class="crm-row" data-id="' +
            s.shipmentLeadId +
            '"><td>' +
            (i + 1) +
            "</td><td>" +
            '<div class="gos-ship-title">' +
            esc(s.shipmentTitle || s.greenOsShipmentId || "Shipment") +
            "</div>" +
            (s.greenOsShipmentId
              ? '<div class="gos-ship-id">' + esc(s.greenOsShipmentId) + "</div>"
              : "") +
            "</td><td>" +
            esc(s.customer) +
            "</td><td>" +
            esc(s.pickup) +
            "</td><td>" +
            esc(s.delivery) +
            "</td><td>" +
            statusCell(s.status, { customerReplied: true }) +
            "</td><td>" +
            fmt(s.updatedAt) +
            "</td></tr>"
          );
        })
        .join("");
      tbody.querySelectorAll("[data-id]").forEach(function (tr) {
        tr.addEventListener("click", function () {
          if (window.GreenOSModules.crm && window.GreenOSModules.crm.openShipmentCard) {
            var sid = tr.getAttribute("data-id");
            var preview = (self._customerRespondCache || []).find(function (r) {
              return r.shipmentLeadId === sid;
            });
            window.GreenOSModules.crm.openShipmentCard(root, sid, preview);
          }
        });
      });
    }

    async function paint() {
      var tbody = document.getElementById("broker-cr-body");
      var syncEl = document.getElementById("broker-cr-sync");
      if (!tbody) return;
      var modal = document.getElementById("crm-modal");
      if (
        modal &&
        !modal.classList.contains("hidden") &&
        modal.getAttribute("data-card-loading") === "1"
      ) {
        return;
      }
      if (self._crPaintBusy) return;
      self._crPaintBusy = true;
      var myGen = ++paintGen;
      try {
        var data = await self.api("/shipments?page=1&pageSize=200");
        if (myGen !== paintGen) return;
        if (!data.success) {
          if (syncEl) syncEl.textContent = data.message || "Failed to load";
          return;
        }
        var payload = data.data || {};
        var all = Array.isArray(payload)
          ? payload
          : Array.isArray(payload.items)
            ? payload.items
            : [];
        var filtered = all.filter(isCustomerRespond);
        self._customerRespondCache = all;
        renderRows(all);
        if (syncEl) {
          syncEl.textContent =
            filtered.length +
            " Customer Respond · updated " +
            new Date().toLocaleTimeString();
        }
      } catch (err) {
        if (syncEl) {
          syncEl.textContent =
            "Refresh failed" + (err && err.message ? " (" + err.message + ")" : "");
        }
      } finally {
        self._crPaintBusy = false;
      }
    }

    window.GreenOSBrokerReloadCustomerRespond = function () {
      if (!document.getElementById("broker-cr-body")) return;
      paint();
    };

    if (this._customerRespondTimer) {
      clearInterval(this._customerRespondTimer);
      this._customerRespondTimer = null;
    }
    this._customerRespondTimer = setInterval(function () {
      if (document.hidden) return;
      if (!document.getElementById("broker-cr-body")) {
        if (self._customerRespondTimer) {
          clearInterval(self._customerRespondTimer);
          self._customerRespondTimer = null;
        }
        return;
      }
      paint();
    }, 30000);

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
        "<th>Customer</th><th>Gmail</th><th>Phone</th><th>Shipments</th><th>Last Status</th><th>Updated</th>" +
        '</tr></thead><tbody id="broker-cust-body"></tbody></table></div>' +
        '<div id="broker-customer-detail"></div>';
      var tbody = body.querySelector("#broker-cust-body");
      if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="6">No customers yet</td></tr>';
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
            esc(c.gmail || "—") +
            "</td><td>" +
            esc(c.phone || "—") +
            "</td><td>" +
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
      var mod = window.GreenOSModules && window.GreenOSModules.carriers;
      if (!mod || typeof mod.api !== "function") {
        body.innerHTML = "<p>Carriers module is not loaded. Refresh the page.</p>";
        return;
      }
      var rows = (await mod.api("/")) || [];
      var esc = this.esc.bind(this);
      body.innerHTML =
        '<section class="gos-dash-hero">' +
        "<h1>MY Carrier</h1>" +
        "<p>Registered carriers in Green OS. Open a row to see the onboarding package.</p>" +
        "</section>" +
        '<div class="table-wrap"><table class="crm-table"><thead><tr>' +
        "<th>Carrier</th><th>MC</th><th>DOT</th><th>Email</th><th>Status</th><th>Broker</th>" +
        '</tr></thead><tbody id="broker-carrier-body"></tbody></table></div>';
      var tbody = body.querySelector("#broker-carrier-body");
      if (!rows.length) {
        tbody.innerHTML =
          '<tr><td colspan="6">No registered carriers yet.</td></tr>';
        return;
      }
      tbody.innerHTML = rows
        .map(function (r) {
          var broker = r.assignedBroker
            ? (r.assignedBroker.firstName || "") + " " + (r.assignedBroker.lastName || "")
            : "—";
          return (
            '<tr data-carrier="' +
            esc(r.carrierId) +
            '"><td><strong>' +
            esc(r.legalName) +
            "</strong></td><td>" +
            esc(r.mcNumber || "—") +
            "</td><td>" +
            esc(r.dotNumber || "—") +
            "</td><td>" +
            esc(r.email || "—") +
            "</td><td>" +
            esc(r.onboardingStatus || "—") +
            "</td><td>" +
            esc(broker.trim() || "—") +
            "</td></tr>"
          );
        })
        .join("");
      tbody.querySelectorAll("[data-carrier]").forEach(function (tr) {
        tr.addEventListener("click", function () {
          var id = tr.getAttribute("data-carrier");
          if (!id || !window.GreenOS || typeof window.GreenOS.navigate !== "function") return;
          window.GreenOSModules.carriers._carrierId = id;
          window.GreenOS.navigate("carriers");
        });
      });
    } catch (err) {
      body.innerHTML = "<p>" + this.esc(err.message || "Failed to load carriers") + "</p>";
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
      var statusCell =
        window.GreenOSModules.crm && window.GreenOSModules.crm.statusCellHtml
          ? window.GreenOSModules.crm.statusCellHtml.bind(window.GreenOSModules.crm)
          : function (st) {
              return this.statusBadge(st);
            }.bind(this);
      host.innerHTML =
        '<section class="gos-module-placeholder" style="margin-top:1rem">' +
        "<h2>" +
        esc(d.customer) +
        "</h2>" +
        '<p class="gos-muted">Gmail: <strong>' +
        esc((d.contact && d.contact.gmail) || "—") +
        "</strong> · Phone: <strong>" +
        esc((d.contact && d.contact.phone) || "—") +
        "</strong></p>" +
        '<div class="gos-card-grid">' +
        this.card("Shipments", (d.shipments || []).length, "accent-blue") +
        this.card("Active", fin.active || 0, "accent-green") +
        this.card("Completed", fin.completed || 0, "accent-green") +
        (d.canViewMoney
          ? this.card(
              "Profit $",
              Math.round(fin.profit != null ? fin.profit : 0),
              "accent-warn"
            )
          : "") +
        "</div>" +
        (d.canViewMoney
          ? '<p class="gos-muted" style="margin:0.35rem 0 0.75rem">' +
            "From customer (взяли): <strong>$" +
            Math.round(fin.fromCustomer != null ? fin.fromCustomer : fin.totalSold || 0) +
            "</strong> · To carrier (отдали): <strong>$" +
            Math.round(fin.toCarrier != null ? fin.toCarrier : fin.totalPaid || 0) +
            "</strong> · <strong>Profit = from customer − to carrier</strong></p>"
          : '<p class="gos-muted" style="margin:0.35rem 0 0.75rem">Profit is available only to Accounting and Owner.</p>') +
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
              statusCell(s.status, { customerReplied: Boolean(s.customerReplied) }) +
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

};

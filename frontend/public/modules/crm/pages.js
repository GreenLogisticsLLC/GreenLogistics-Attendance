/**
 * GreenOS CRM Dashboard v1.0 — real-time shipment pipeline for brokers & managers.
 */
window.GreenOSModules = window.GreenOSModules || {};
window.GreenOSModules.crm = {
  children: [
    { id: "dashboard", title: "Dashboard" },
    { id: "shipments", title: "Shipments" },
    { id: "brokers", title: "My Team" },
  ],

  currentRole() {
    try {
      var raw = localStorage.getItem("gl_user");
      if (!raw) return "";
      var u = JSON.parse(raw);
      return u.role || u.roleName || "";
    } catch {
      return "";
    }
  },

  isTeamLead() {
    return this.currentRole() === "Team Lead" || this._lastScope === "team";
  },

  render(root, subPageId) {
    if (!root) return;
    var self = this;
    var children = (this.children || []).map(function (c) {
      if (c.id === "brokers" && !self.isTeamLead()) {
        return { id: "brokers", title: "Brokers" };
      }
      return c;
    });
    var active = children.find(function (c) {
      return c.id === subPageId;
    }) || children[0];

    var navHtml = children
      .map(function (c) {
        var isActive = active && c.id === active.id;
        return (
          '<button type="button" class="gos-subnav-item' +
          (isActive ? " is-active" : "") +
          '" data-subpage="' +
          c.id +
          '">' +
          c.title +
          "</button>"
        );
      })
      .join("");

    root.innerHTML =
      '<div class="gos-module-placeholder crm-root" data-module="crm">' +
      '<nav class="gos-subnav" aria-label="CRM sections">' +
      navHtml +
      "</nav>" +
      '<div class="gos-module-body" id="crm-body"><p class="gos-muted">Loading…</p></div>' +
      '<div id="crm-modal" class="crm-modal hidden" role="dialog" aria-modal="true"></div>' +
      "</div>";

    root.querySelectorAll("[data-subpage]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        self.render(root, btn.getAttribute("data-subpage"));
      });
    });

    var body = root.querySelector("#crm-body");
    var page = active ? active.id : "dashboard";
    if (page === "dashboard") self.renderDashboard(body, root);
    else if (page === "brokers") self.renderBrokers(body, root);
    else self.renderShipments(body, root);
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
    var map = {
      NEW: { cls: "crm-st-new", label: "🟢 New" },
      UNASSIGNED: { cls: "crm-st-unassigned", label: "⚪ Unassigned" },
      ASSIGNED: { cls: "crm-st-await", label: "🟡 Awaiting Agent" },
      AWAITING_ACCEPTANCE: { cls: "crm-st-await", label: "🟡 Awaiting Agent" },
      AGENT_OPEN: { cls: "crm-st-quote", label: "🔵 Agent Open" },
      WORKING: { cls: "crm-st-working", label: "🟢 Agent Working" },
      FOLLOW_UP: { cls: "crm-st-follow", label: "🟠 Follow Up" },
      QUOTE_SENT: { cls: "crm-st-quote", label: "🔵 Quote Sent" },
      NEGOTIATION: { cls: "crm-st-nego", label: "🟣 Negotiation" },
      BOOKED: { cls: "crm-st-quote", label: "🔵 Booked" },
      PICKED_UP: { cls: "crm-st-quote", label: "🔵 Picked Up" },
      DELIVERED: { cls: "crm-st-quote", label: "🔵 Delivered" },
      WON: { cls: "crm-st-won", label: "✅ Won" },
      LOST: { cls: "crm-st-lost", label: "🔴 Lost" },
      COMPLETED: { cls: "crm-st-done", label: "⚫ Completed" },
    };
    var m = map[status] || { cls: "crm-st-done", label: status || "—" };
    return '<span class="crm-badge ' + m.cls + '">' + m.label + "</span>";
  },

  async renderDashboard(body, root) {
    body.innerHTML = "<p>Loading CRM dashboard…</p>";
    try {
      var data = await this.api("/dashboard");
      if (!data.success) {
        body.innerHTML = "<p>" + this.esc(data.message || "Failed") + "</p>";
        return;
      }
      var d = data.data || {};
      var k = d.kpis || {};
      var workload = d.brokerWorkload || [];
      this._lastScope = d.scope || "company";
      var teamMode = d.scope === "team";

      body.innerHTML =
        '<section class="gos-dash-hero">' +
        "<h1>" +
        (teamMode ? "My Team CRM" : "CRM Dashboard") +
        ' <span class="crm-ver">v1.0</span></h1>' +
        "<p>" +
        (teamMode
          ? "Oversight of your brokers, their shipments, and pipeline"
          : "Real-time view of shipments, pipeline, and broker workload") +
        "</p>" +
        "</section>" +
        '<div class="gos-card-grid crm-kpi-grid">' +
        this.kpiCard("Unassigned", k.unassigned || 0, "accent-warn") +
        this.kpiCard("New Today", k.newShipmentsToday, "accent-green") +
        this.kpiCard("Awaiting Agent", k.awaitingAcceptance, "accent-warn") +
        this.kpiCard("Agent Working", k.working || 0, "accent-green") +
        this.kpiCard("Quotes Sent", k.quotesSent, "accent-blue") +
        this.kpiCard("Won", k.won, "accent-green") +
        this.kpiCard("Lost", k.lost, "accent-warn") +
        this.kpiCard("Active Shipments", k.activeShipments, "accent-purple") +
        this.kpiCard(
          "Avg Response",
          k.averageResponseTimeMinutes != null ? k.averageResponseTimeMinutes + " min" : "—",
          "accent-blue"
        ) +
        "</div>" +
        '<section class="crm-section">' +
        "<h2>Unassigned Shipments</h2>" +
        "<p class=\"gos-muted\">Waiting for a broker In Office — auto-assigned when someone swipes in.</p>" +
        '<div id="crm-unassigned"></div>' +
        "</section>" +
        '<section class="crm-section">' +
        "<h2>" +
        (teamMode ? "Team Workload" : "Broker Workload") +
        "</h2>" +
        '<div class="crm-workload" id="crm-workload"></div>' +
        "</section>" +
        '<section class="crm-section">' +
        "<h2>Brokers at a Glance</h2>" +
        '<div class="crm-broker-glance" id="crm-glance"></div>' +
        "</section>";

      var unassigned = d.unassignedShipments || [];
      var ua = body.querySelector("#crm-unassigned");
      if (!unassigned.length) {
        ua.innerHTML = "<p class=\"gos-muted\">None — all shipments are assigned or none are waiting.</p>";
      } else {
        ua.innerHTML =
          '<table class="crm-table"><thead><tr>' +
          "<th>Lot</th><th>Title</th><th>Route</th><th>Received</th><th></th>" +
          "</tr></thead><tbody>" +
          unassigned
            .map(function (s) {
              return (
                "<tr>" +
                "<td>" +
                window.GreenOSModules.crm.esc(s.externalShipmentId || "—") +
                "</td>" +
                "<td>" +
                window.GreenOSModules.crm.esc(s.shipmentTitle || "—") +
                "</td>" +
                "<td>" +
                window.GreenOSModules.crm.esc((s.pickup || "—") + " → " + (s.delivery || "—")) +
                "</td>" +
                "<td>" +
                window.GreenOSModules.crm.esc(
                  s.createdAt ? new Date(s.createdAt).toLocaleString() : "—"
                ) +
                "</td>" +
                '<td><button type="button" class="btn-primary crm-open-unassigned" data-id="' +
                s.shipmentLeadId +
                '" style="width:auto;padding:0.35rem 0.7rem">Open</button></td>' +
                "</tr>"
              );
            })
            .join("") +
          "</tbody></table>";
        ua.querySelectorAll(".crm-open-unassigned").forEach(function (btn) {
          btn.addEventListener("click", function () {
            window.GreenOSModules.crm.openShipmentCard(root, btn.getAttribute("data-id"));
          });
        });
      }
      var wl = body.querySelector("#crm-workload");
      if (!workload.length) {
        wl.innerHTML = "<p class=\"gos-muted\">No brokers with active shipments yet</p>";
      } else {
        wl.innerHTML = workload
          .map(function (b) {
            return (
              '<div class="crm-workload-row" data-broker="' +
              b.brokerId +
              '">' +
              "<strong>" +
              window.GreenOSModules.crm.esc(b.name) +
              "</strong>" +
              '<span class="crm-bar-wrap"><span class="crm-bar" style="width:' +
              Math.min(100, (b.activeShipments || 0) * 3) +
              '%"></span></span>' +
              "<em>" +
              (b.activeShipments || 0) +
              "</em>" +
              "</div>"
            );
          })
          .join("");
        wl.querySelectorAll("[data-broker]").forEach(function (row) {
          row.addEventListener("click", function () {
            window.GreenOSModules.crm.openBrokerWorkspace(root, row.getAttribute("data-broker"));
          });
        });
      }

      // Manager glance cards from brokers endpoint
      var brokersRes = await this.api("/brokers");
      var glance = body.querySelector("#crm-glance");
      var brokers = (brokersRes.data || []);
      if (!brokers.length) {
        glance.innerHTML = "<p class=\"gos-muted\">No brokers found</p>";
      } else {
        glance.innerHTML = brokers
          .map(function (b) {
            return (
              '<article class="crm-glance-card" data-broker="' +
              b.brokerId +
              '">' +
              "<h3>" +
              window.GreenOSModules.crm.esc(b.name) +
              "</h3>" +
              '<div class="crm-glance-grid">' +
              "<div><span>Active</span><strong>" +
              b.currentShipments +
              "</strong></div>" +
              "<div><span>Need Follow Up</span><strong>" +
              b.followUp +
              "</strong></div>" +
              "<div><span>Quotes</span><strong>" +
              b.quotesSent +
              "</strong></div>" +
              "<div><span>Won</span><strong>" +
              b.won +
              "</strong></div>" +
              "<div><span>Lost</span><strong>" +
              b.lost +
              "</strong></div>" +
              "</div></article>"
            );
          })
          .join("");
        glance.querySelectorAll("[data-broker]").forEach(function (card) {
          card.addEventListener("click", function () {
            window.GreenOSModules.crm.openBrokerWorkspace(root, card.getAttribute("data-broker"));
          });
        });
      }
    } catch (e) {
      body.innerHTML = "<p>Failed to load CRM dashboard</p>";
    }
  },

  kpiCard(label, value, tone) {
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

  async renderShipments(body, root, brokerId) {
    body.innerHTML = "<p>Loading shipments…</p>";
    try {
      var q = brokerId ? "?brokerId=" + encodeURIComponent(brokerId) : "";
      var data = await this.api("/shipments" + q);
      if (!data.success) {
        body.innerHTML = "<p>" + this.esc(data.message || "Failed") + "</p>";
        return;
      }
      var rows = data.data || [];
      body.innerHTML =
        '<section class="gos-dash-hero">' +
        "<h1>Shipments</h1>" +
        "<p>Main CRM pipeline — click a row to open the shipment card</p>" +
        "</section>" +
        '<div class="table-wrap crm-table-wrap"><table class="crm-table">' +
        "<thead><tr>" +
        "<th>#</th><th>Shipment</th><th>Customer</th><th>Broker</th><th>Pickup</th><th>Delivery</th>" +
        "<th>Miles</th><th>Equipment</th><th>Price</th><th>Status</th><th>Priority</th>" +
        "<th>Created</th><th>Updated</th>" +
        "</tr></thead><tbody id=\"crm-ship-body\"></tbody></table></div>";

      var tbody = body.querySelector("#crm-ship-body");
      if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="13">No shipments yet — import from Email Imports</td></tr>';
        return;
      }
      var esc = this.esc.bind(this);
      var fmt = this.fmtDate.bind(this);
      var badge = this.statusBadge.bind(this);
      function operationalDayKey(v) {
        if (!v) return "";
        var d = new Date(v);
        if (isNaN(d.getTime())) return "";
        d.setHours(d.getHours() - 17);
        return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate();
      }
      tbody.innerHTML = rows
        .map(function (s, index) {
          var when = s.createdAt || s.receivedAt;
          var key = operationalDayKey(when);
          var prevKey =
            index > 0
              ? operationalDayKey(rows[index - 1].createdAt || rows[index - 1].receivedAt)
              : null;
          var isDayStart = index === 0 || (key && key !== prevKey);
          return (
            '<tr class="crm-row' +
            (isDayStart ? " lot-day-start" : "") +
            '" data-id="' +
            s.shipmentLeadId +
            '">' +
            '<td class="lot-num">' +
            (index + 1) +
            (isDayStart
              ? '<span class="lot-day-badge" title="Operational day: 17:00–16:59">17:00–16:59</span>'
              : "") +
            "</td>" +
            "<td><strong>" +
            esc(s.greenOsShipmentId || s.shipmentTitle || s.externalShipmentId || s.shipmentLeadId.slice(0, 8)) +
            "</strong></td>" +
            "<td>" +
            esc(s.customer) +
            "</td>" +
            "<td>" +
            esc(s.brokerName) +
            "</td>" +
            "<td>" +
            esc(s.pickup) +
            "</td>" +
            "<td>" +
            esc(s.delivery) +
            "</td>" +
            "<td>" +
            (s.miles != null ? s.miles : "—") +
            "</td>" +
            "<td>" +
            esc(s.equipment) +
            "</td>" +
            "<td>" +
            (s.price != null ? "$" + s.price : "—") +
            "</td>" +
            "<td>" +
            badge(s.status) +
            "</td>" +
            "<td>" +
            esc(s.priority || "NORMAL") +
            "</td>" +
            "<td>" +
            fmt(s.createdAt) +
            "</td>" +
            "<td>" +
            fmt(s.updatedAt) +
            "</td>" +
            "</tr>"
          );
        })
        .join("");

      tbody.querySelectorAll("tr[data-id]").forEach(function (tr) {
        tr.addEventListener("click", function () {
          window.GreenOSModules.crm.openShipmentCard(root, tr.getAttribute("data-id"));
        });
      });
    } catch {
      body.innerHTML = "<p>Failed to load shipments</p>";
    }
  },

  async renderBrokers(body, root) {
    body.innerHTML = "<p>Loading brokers…</p>";
    try {
      var data = await this.api("/brokers");
      if (!data.success) {
        body.innerHTML = "<p>" + this.esc(data.message || "Failed") + "</p>";
        return;
      }
      var rows = data.data || [];
      var teamMode = /team/i.test(data.message || "") || this.isTeamLead();
      body.innerHTML =
        '<section class="gos-dash-hero">' +
        "<h1>" +
        (teamMode ? "My Team" : "Brokers") +
        "</h1>" +
        "<p>" +
        (teamMode
          ? "Brokers reporting to you — open a workspace to review their full pipeline"
          : "Select a broker to open their workspace") +
        "</p>" +
        "</section>" +
        '<div class="table-wrap"><table class="crm-table">' +
        "<thead><tr>" +
        "<th>Broker</th><th>Status</th><th>In Office</th><th>Current Shipments</th>" +
        "<th>Awaiting Acceptance</th><th>Follow Up</th><th>Quotes Sent</th>" +
        "<th>Won</th><th>Lost</th><th>Avg Response</th>" +
        "</tr></thead><tbody id=\"crm-broker-body\"></tbody></table></div>";

      var tbody = body.querySelector("#crm-broker-body");
      if (!rows.length) {
        tbody.innerHTML =
          '<tr><td colspan="10">' +
          (teamMode
            ? "No brokers on your team yet — approve Broker registrations and they will appear here"
            : "No brokers") +
          "</td></tr>";
        return;
      }
      var esc = this.esc.bind(this);
      tbody.innerHTML = rows
        .map(function (b) {
          return (
            '<tr class="crm-row" data-broker="' +
            b.brokerId +
            '">' +
            "<td><strong>" +
            esc(b.name) +
            "</strong></td>" +
            "<td>" +
            esc(b.status) +
            "</td>" +
            "<td>" +
            (b.inOffice ? "In Office" : "Out") +
            "</td>" +
            "<td>" +
            b.currentShipments +
            "</td>" +
            "<td>" +
            b.awaitingAcceptance +
            "</td>" +
            "<td>" +
            b.followUp +
            "</td>" +
            "<td>" +
            b.quotesSent +
            "</td>" +
            "<td>" +
            b.won +
            "</td>" +
            "<td>" +
            b.lost +
            "</td>" +
            "<td>" +
            (b.averageResponseTimeMinutes != null ? b.averageResponseTimeMinutes + " min" : "—") +
            "</td>" +
            "</tr>"
          );
        })
        .join("");

      tbody.querySelectorAll("[data-broker]").forEach(function (tr) {
        tr.addEventListener("click", function () {
          window.GreenOSModules.crm.openBrokerWorkspace(root, tr.getAttribute("data-broker"));
        });
      });
    } catch {
      body.innerHTML = "<p>Failed to load brokers</p>";
    }
  },

  async openBrokerWorkspace(root, brokerId) {
    var body = root.querySelector("#crm-body");
    if (!body) return;
    body.innerHTML = "<p>Loading workspace…</p>";
    try {
      var data = await this.api("/brokers/" + encodeURIComponent(brokerId));
      if (!data.success) {
        body.innerHTML = "<p>" + this.esc(data.message || "Failed") + "</p>";
        return;
      }
      var d = data.data;
      var s = d.stats || {};
      var shipments = d.shipments || [];
      body.innerHTML =
        '<section class="gos-dash-hero">' +
        '<button type="button" class="btn-secondary crm-back" id="crm-back-brokers">← Brokers</button>' +
        "<h1>" +
        this.esc(d.broker.name) +
        "</h1>" +
        "<p>" +
        (s.currentShipments || 0) +
        " Active Shipments</p>" +
        "</section>" +
        '<div class="crm-glance-grid crm-ws-stats">' +
        "<div><span>Active</span><strong>" +
        (s.currentShipments || 0) +
        "</strong></div>" +
        "<div><span>Need Follow Up</span><strong>" +
        (s.followUp || 0) +
        "</strong></div>" +
        "<div><span>Quotes</span><strong>" +
        (s.quotesSent || 0) +
        "</strong></div>" +
        "<div><span>Won</span><strong>" +
        (s.won || 0) +
        "</strong></div>" +
        "<div><span>Lost</span><strong>" +
        (s.lost || 0) +
        "</strong></div>" +
        "</div>" +
        '<div class="crm-ws-list" id="crm-ws-list"></div>';

      body.querySelector("#crm-back-brokers")?.addEventListener("click", function () {
        window.GreenOSModules.crm.render(root, "brokers");
      });

      var list = body.querySelector("#crm-ws-list");
      if (!shipments.length) {
        list.innerHTML = "<p class=\"gos-muted\">No shipments for this broker</p>";
        return;
      }
      var esc = this.esc.bind(this);
      var badge = this.statusBadge.bind(this);
      list.innerHTML = shipments
        .map(function (sh, i) {
          return (
            '<button type="button" class="crm-ws-item" data-id="' +
            sh.shipmentLeadId +
            '">' +
            "<span>Shipment " +
            (i + 1) +
            "</span>" +
            "<strong>" +
            esc(sh.shipmentTitle) +
            "</strong>" +
            "<span>" +
            esc(sh.pickup) +
            " → " +
            esc(sh.delivery) +
            "</span>" +
            badge(sh.status) +
            "</button>"
          );
        })
        .join("");
      list.querySelectorAll("[data-id]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          window.GreenOSModules.crm.openShipmentCard(root, btn.getAttribute("data-id"));
        });
      });
    } catch {
      body.innerHTML = "<p>Failed to load workspace</p>";
    }
  },

  async openShipmentCard(root, id) {
    var modal = root.querySelector("#crm-modal");
    if (!modal) return;
    modal.classList.remove("hidden");
    modal.innerHTML = '<div class="crm-modal-card"><p>Loading…</p></div>';
    try {
      var data = await this.api("/shipments/" + encodeURIComponent(id));
      if (!data.success) {
        modal.innerHTML =
          '<div class="crm-modal-card"><p>' +
          this.esc(data.message) +
          '</p><button type="button" class="btn-secondary" id="crm-close">Close</button></div>';
        modal.querySelector("#crm-close")?.addEventListener("click", function () {
          modal.classList.add("hidden");
          modal.innerHTML = "";
        });
        return;
      }
      var s = data.data;
      var esc = this.esc.bind(this);
      var pipeline = (s.pipeline || [])
        .map(function (p) {
          return (
            '<li class="' +
            (p.done ? "is-done" : "") +
            '"><span class="crm-pipe-dot"></span><div><strong>' +
            esc(p.title) +
            "</strong>" +
            (p.at
              ? '<small>' + window.GreenOSModules.crm.fmtDate(p.at) + "</small>"
              : "") +
            "</div></li>"
          );
        })
        .join("");

      var statusActions = [
        "AGENT_OPEN",
        "WORKING",
        "FOLLOW_UP",
        "BID_SUBMITTED",
        "CUSTOMER_REPLIED",
        "ACCEPTED",
        "LOAD_CREATED",
        "DISPATCH",
        "COMPLETED",
        "CLOSED",
        "LOST",
        "QUOTE_SENT",
        "NEGOTIATION",
        "BOOKED",
        "WON",
      ]
        .map(function (st) {
          return (
            '<option value="' +
            st +
            '"' +
            (s.status === st ? " selected" : "") +
            ">" +
            st +
            "</option>"
          );
        })
        .join("");

      modal.innerHTML =
        '<div class="crm-modal-card">' +
        '<header class="crm-modal-head">' +
        "<div><h2>" +
        esc(s.shipmentTitle) +
        '</h2><p class="gos-muted">Green OS ID: <strong>' +
        esc(s.greenOsShipmentId || s.shipmentLeadId) +
        "</strong>" +
        (s.externalShipmentId
          ? " · uShip: " + esc(s.externalShipmentId)
          : "") +
        "</p></div>" +
        '<button type="button" class="btn-secondary" id="crm-close">Close</button>' +
        "</header>" +
        '<div class="crm-card-grid">' +
        "<div><span>Status</span>" +
        this.statusBadge(s.status) +
        "</div>" +
        "<div><span>Load Number</span><strong>" +
        esc(s.loadNumber || "—") +
        "</strong></div>" +
        "<div><span>Customer</span><strong>" +
        esc(s.customer) +
        "</strong></div>" +
        "<div><span>Broker</span><strong>" +
        esc(s.brokerName) +
        "</strong></div>" +
        "<div><span>Pickup</span><strong>" +
        esc(s.pickup) +
        "</strong></div>" +
        "<div><span>Delivery</span><strong>" +
        esc(s.delivery) +
        "</strong></div>" +
        "<div><span>Distance</span><strong>" +
        (s.miles != null ? s.miles + " mi" : "—") +
        "</strong></div>" +
        "<div><span>Vehicle</span><strong>" +
        esc(s.vehicle) +
        "</strong></div>" +
        "<div><span>Weight</span><strong>" +
        esc(s.weight || "—") +
        "</strong></div>" +
        "<div><span>Rate</span><strong>" +
        (s.price != null ? "$" + s.price : "—") +
        "</strong></div>" +
        "<div><span>uShip</span>" +
        (s.ushipUrl
          ? '<a class="crm-open-uship" href="' +
            esc(s.ushipUrl) +
            '" target="_blank" rel="noopener">Open in uShip</a>'
          : "—") +
        "</div>" +
        "</div>" +
        '<div class="crm-notes"><span>Internal Notes</span>' +
        '<textarea id="crm-notes" rows="3" style="width:100%;margin-top:0.35rem;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:0.6rem">' +
        esc(s.notes || "") +
        "</textarea>" +
        '<button type="button" class="btn-secondary" id="crm-save-notes" style="width:auto;margin-top:0.5rem">Save Notes</button>' +
        "</div>" +
        "<h3>Files</h3>" +
        '<ul class="gos-muted" id="crm-files">' +
        (Array.isArray(s.documents) && s.documents.length
          ? s.documents
              .map(function (d) {
                var name = typeof d === "string" ? d : d.name || d.url || "file";
                var url = typeof d === "object" && d.url ? d.url : null;
                return (
                  "<li>" +
                  (url
                    ? '<a href="' + esc(url) + '" target="_blank" rel="noopener">' + esc(name) + "</a>"
                    : esc(name)) +
                  "</li>"
                );
              })
              .join("")
          : "<li>No files attached yet</li>") +
        "</ul>" +
        "<h3>uShip email history</h3>" +
        '<ul class="gos-muted" id="crm-mailbox">' +
        (Array.isArray(s.mailboxEmails) && s.mailboxEmails.length
          ? s.mailboxEmails
              .map(function (m) {
                return (
                  "<li><strong>" +
                  esc(m.subject) +
                  "</strong><br><small>" +
                  esc(m.fromAddress) +
                  " · " +
                  window.GreenOSModules.crm.fmtDate(m.receivedAt) +
                  "</small>" +
                  (m.snippet ? "<br>" + esc(m.snippet) : "") +
                  "</li>"
                );
              })
              .join("")
          : "<li>No broker mailbox emails linked yet</li>") +
        "</ul>" +
        "<h3>Operations</h3>" +
        '<div class="crm-card-grid" id="crm-ops">' +
        '<div><span>Carrier</span><input id="ops-carrier" value="' +
        esc(s.carrierName || "") +
        '"></div>' +
        '<div><span>Driver</span><input id="ops-driver" value="' +
        esc(s.driverName || "") +
        '"></div>' +
        '<div><span>Truck</span><input id="ops-truck" value="' +
        esc(s.truckNumber || "") +
        '"></div>' +
        '<div><span>Trailer</span><input id="ops-trailer" value="' +
        esc(s.trailerNumber || "") +
        '"></div>' +
        '<div><span>Rate Confirmation</span><input id="ops-rc" value="' +
        esc(s.rateConfirmation || "") +
        '"></div>' +
        '<div><span>POD URL</span><input id="ops-pod" value="' +
        esc(s.podUrl || "") +
        '"></div>' +
        '<div><span>Invoice #</span><input id="ops-invoice" value="' +
        esc(s.invoiceNumber || "") +
        '"></div>' +
        '<div><span>Payment</span><input id="ops-payment" value="' +
        esc(s.paymentStatus || "") +
        '"></div>' +
        "</div>" +
        '<button type="button" class="btn-secondary" id="crm-save-ops" style="width:auto;margin:0.75rem 0">Save Operations</button>' +
        '<div class="crm-actions">' +
        (s.status === "AWAITING_ACCEPTANCE" || s.status === "ASSIGNED" || s.status === "AGENT_OPEN"
          ? '<button type="button" class="btn-primary" id="crm-accept">Accept Shipment</button>'
          : "") +
        (s.ushipUrl
          ? '<a class="btn-primary crm-open-uship" href="' +
            esc(s.ushipUrl) +
            '" target="_blank" rel="noopener" style="width:auto;padding:0.65rem 1rem;text-decoration:none;display:inline-block">Open in uShip</a>'
          : "") +
        '<label>Load # <input id="crm-load-number" type="text" placeholder="Load number" value="' +
        esc(s.loadNumber || "") +
        '" style="max-width:10rem"></label>' +
        '<button type="button" class="btn-secondary" id="crm-save-load">Apply Load #</button>' +
        '<label>Update status <select id="crm-status">' +
        statusActions +
        "</select></label>" +
        '<button type="button" class="btn-secondary" id="crm-save-status">Save</button>' +
        "</div>" +
        "<h3>Timeline / Lifecycle</h3>" +
        '<ol class="crm-pipeline">' +
        pipeline +
        "</ol>" +
        "</div>";

      modal.querySelector("#crm-close")?.addEventListener("click", function () {
        modal.classList.add("hidden");
        modal.innerHTML = "";
      });
      modal.addEventListener("click", function (ev) {
        if (ev.target === modal) {
          modal.classList.add("hidden");
          modal.innerHTML = "";
        }
      });

      modal.querySelectorAll(".crm-open-uship").forEach(function (link) {
        link.addEventListener("click", function () {
          // The external tab opens normally; record only an assigned Broker's actual uShip click.
          window.GreenOSModules.crm.api("/shipments/" + encodeURIComponent(id) + "/opened", {
            method: "POST",
            keepalive: true,
          });
        });
      });

      modal.querySelector("#crm-accept")?.addEventListener("click", async function () {
        await window.GreenOSModules.crm.api("/shipments/" + id + "/accept", { method: "POST" });
        window.GreenOSModules.crm.openShipmentCard(root, id);
      });
      modal.querySelector("#crm-save-status")?.addEventListener("click", async function () {
        var st = modal.querySelector("#crm-status").value;
        var notes = modal.querySelector("#crm-notes")?.value;
        await window.GreenOSModules.crm.api("/shipments/" + id, {
          method: "PATCH",
          body: JSON.stringify({ status: st, notes: notes }),
        });
        window.GreenOSModules.crm.openShipmentCard(root, id);
      });
      modal.querySelector("#crm-save-notes")?.addEventListener("click", async function () {
        var notes = modal.querySelector("#crm-notes").value;
        await window.GreenOSModules.crm.api("/shipments/" + id, {
          method: "PATCH",
          body: JSON.stringify({ status: s.status, notes: notes }),
        });
        window.GreenOSModules.crm.openShipmentCard(root, id);
      });
      modal.querySelector("#crm-save-load")?.addEventListener("click", async function () {
        var ln = modal.querySelector("#crm-load-number").value;
        var token = localStorage.getItem("gl_token") || "";
        await fetch("/api/shipments/" + encodeURIComponent(id) + "/load-number", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + token,
          },
          body: JSON.stringify({ loadNumber: ln }),
        });
        window.GreenOSModules.crm.openShipmentCard(root, id);
      });
      modal.querySelector("#crm-save-ops")?.addEventListener("click", async function () {
        var token = localStorage.getItem("gl_token") || "";
        await fetch("/api/shipments/" + encodeURIComponent(id) + "/operations", {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + token,
          },
          body: JSON.stringify({
            carrierName: modal.querySelector("#ops-carrier")?.value || null,
            driverName: modal.querySelector("#ops-driver")?.value || null,
            truckNumber: modal.querySelector("#ops-truck")?.value || null,
            trailerNumber: modal.querySelector("#ops-trailer")?.value || null,
            rateConfirmation: modal.querySelector("#ops-rc")?.value || null,
            podUrl: modal.querySelector("#ops-pod")?.value || null,
            invoiceNumber: modal.querySelector("#ops-invoice")?.value || null,
            paymentStatus: modal.querySelector("#ops-payment")?.value || null,
          }),
        });
        window.GreenOSModules.crm.openShipmentCard(root, id);
      });
    } catch {
      modal.innerHTML =
        '<div class="crm-modal-card"><p>Failed to load card</p></div>';
    }
  },
};

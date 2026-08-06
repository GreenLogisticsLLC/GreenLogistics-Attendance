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

    function paint() {
      var current = document.getElementById("crm-body") || body;
      if (page === "dashboard") self.renderDashboard(current, root);
      else if (page === "brokers") self.renderBrokers(current, root);
      else self.renderShipments(current, root);
    }

    // Soft reload used by realtime/poll: keeps the subnav and the open card alive.
    window.GreenOSCrmReloadBody = paint;
    paint();
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

  fmtDateShort(v) {
    if (!v) return "—";
    try {
      return new Date(v).toLocaleDateString("en-US", {
        month: "numeric",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      });
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
      DELETED_FROM_CUSTOMER: { cls: "crm-st-deleted", label: "⚫ Deleted from Customer" },
      DELETED: { cls: "crm-st-deleted", label: "⚫ Deleted from Customer" },
      CLOSED: { cls: "crm-st-done", label: "⚫ Closed" },
      COMPLETED: { cls: "crm-st-done", label: "⚫ Completed" },
      BID_SUBMITTED: { cls: "crm-st-quote", label: "🔵 Bid Submitted" },
      CUSTOMER_REPLIED: { cls: "crm-st-nego", label: "🟣 Customer Replied" },
      ACCEPTED: { cls: "crm-st-won", label: "✅ Accepted" },
      LOAD_CREATED: { cls: "crm-st-quote", label: "🔵 Load Created" },
      DISPATCH: { cls: "crm-st-quote", label: "🔵 Dispatch" },
    };
    var m = map[status] || { cls: "crm-st-done", label: status || "—" };
    return '<span class="crm-badge ' + m.cls + '">' + m.label + "</span>";
  },

  async renderDashboard(body, root) {
    if (!body.querySelector(".crm-kpi-grid")) {
      body.innerHTML = "<p>Loading CRM dashboard…</p>";
    }
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
        "<p class=\"gos-muted\">Waiting for a broker In Office — new shipments go round-robin to whoever is checked in.</p>" +
        '<div id="crm-unassigned"></div>' +
        "</section>" +
        '<section class="crm-section">' +
        "<h2>Recently Assigned</h2>" +
        "<p class=\"gos-muted\">Which shipment went to which broker — you and the Team Lead both see the name.</p>" +
        '<div id="crm-recent-assigned"></div>' +
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
        ua.innerHTML = "<p class=\"gos-muted\">None — waiting for new shipments. Brokers In Office receive them in turn.</p>";
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

      var recent = d.recentlyAssigned || [];
      var ra = body.querySelector("#crm-recent-assigned");
      if (!recent.length) {
        ra.innerHTML =
          "<p class=\"gos-muted\">No assignments yet — when a shipment is given out, the broker name appears here.</p>";
      } else {
        ra.innerHTML =
          '<table class="crm-table"><thead><tr>' +
          "<th>Shipment</th><th>Title</th><th>Assigned to (Broker)</th><th>When</th><th></th>" +
          "</tr></thead><tbody>" +
          recent
            .map(function (s) {
              return (
                "<tr>" +
                "<td><strong>" +
                window.GreenOSModules.crm.esc(
                  s.greenOsShipmentId ||
                    s.externalShipmentId ||
                    String(s.shipmentLeadId || "").slice(0, 8)
                ) +
                "</strong></td>" +
                "<td>" +
                window.GreenOSModules.crm.esc(s.shipmentTitle || "—") +
                "</td>" +
                '<td><strong style="color:#34d399">' +
                window.GreenOSModules.crm.esc(s.brokerName || "—") +
                "</strong></td>" +
                "<td>" +
                window.GreenOSModules.crm.esc(
                  s.assignedAt ? new Date(s.assignedAt).toLocaleString() : "—"
                ) +
                "</td>" +
                '<td><button type="button" class="btn-primary crm-open-recent" data-id="' +
                s.shipmentLeadId +
                '" style="width:auto;padding:0.35rem 0.7rem">Open</button></td>' +
                "</tr>"
              );
            })
            .join("") +
          "</tbody></table>";
        ra.querySelectorAll(".crm-open-recent").forEach(function (btn) {
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
    // Keep the current table on background reloads so the page does not blink.
    if (!body.querySelector("#crm-ship-body")) {
      body.innerHTML = "<p>Loading shipments…</p>";
    }
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
    if (!body.querySelector("#crm-broker-body")) {
      body.innerHTML = "<p>Loading brokers…</p>";
    }
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

  /**
   * Re-render the open card when uShip mail moved the shipment forward.
   * Re-renders only on a real status/timeline change so typing is not interrupted.
   */
  async refreshOpenShipmentCard() {
    var modal = document.getElementById("crm-modal");
    if (!modal || modal.classList.contains("hidden")) return;
    var id = modal.getAttribute("data-shipment-id");
    if (!id) return;
    try {
      var data = await this.api("/shipments/" + encodeURIComponent(id));
      if (!data || !data.success || !data.data) return;
      var fresh = data.data;
      var shownStatus = modal.getAttribute("data-shipment-status") || "";
      var shownSteps = modal.getAttribute("data-pipeline-steps") || "";
      var freshSteps = String((fresh.pipeline || []).filter(function (p) {
        return p.done;
      }).length);
      var shownLoad = modal.getAttribute("data-load-number") || "";
      var shownMail = modal.getAttribute("data-mailbox-count") || "";
      if (
        String(fresh.status || "") === shownStatus &&
        freshSteps === shownSteps &&
        String(fresh.loadNumber || "") === shownLoad &&
        String((fresh.mailboxEmails || []).length) === shownMail
      ) {
        return;
      }
      var notesEl = modal.querySelector("#crm-notes");
      var draft = notesEl && notesEl.value !== (modal.getAttribute("data-notes") || "")
        ? notesEl.value
        : null;
      await this.openShipmentCard(document, id);
      if (draft != null) {
        var restored = modal.querySelector("#crm-notes");
        if (restored) restored.value = draft;
      }
    } catch (e) {
      /* keep the card as-is on network errors */
    }
  },

  async openShipmentCard(root, id) {
    var modal = root.querySelector("#crm-modal");
    if (!modal) return;
    modal.classList.remove("hidden");
    modal.setAttribute("data-shipment-id", id);
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
      modal.setAttribute("data-shipment-status", String(s.status || ""));
      modal.setAttribute("data-load-number", String(s.loadNumber || ""));
      modal.setAttribute(
        "data-pipeline-steps",
        String((s.pipeline || []).filter(function (p) {
          return p.done;
        }).length)
      );
      modal.setAttribute("data-notes", String(s.notes || ""));
      modal.setAttribute(
        "data-mailbox-count",
        String((s.mailboxEmails || []).length)
      );
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

      var statusLabels = {
        AGENT_OPEN: "AGENT OPEN",
        WORKING: "WORKING",
        FOLLOW_UP: "FOLLOW UP",
        BID_SUBMITTED: "BID SUBMITTED",
        CUSTOMER_REPLIED: "CUSTOMER REPLIED",
        ACCEPTED: "ACCEPTED",
        LOAD_CREATED: "LOAD CREATED",
        DISPATCH: "DISPATCH",
        COMPLETED: "COMPLETED",
        CLOSED: "CLOSED",
        LOST: "LOST",
        DELETED_FROM_CUSTOMER: "DELETED FROM CUSTOMER",
        QUOTE_SENT: "QUOTE SENT",
        NEGOTIATION: "NEGOTIATION",
        BOOKED: "BOOKED",
        WON: "WON",
        AWAITING_ACCEPTANCE: "AWAITING AGENT",
        ASSIGNED: "AWAITING AGENT",
        NEW: "NEW",
        UNASSIGNED: "UNASSIGNED",
      };
      // Pipeline stages from uShip / broker Gmail — not manually selectable.
      var autoStatuses = {
        AGENT_OPEN: true,
        WORKING: true,
        BID_SUBMITTED: true,
        CUSTOMER_REPLIED: true,
        ACCEPTED: true,
        LOAD_CREATED: true,
        BOOKED: true,
        WON: true,
      };
      var manualStatuses = [
        "FOLLOW_UP",
        "DISPATCH",
        "COMPLETED",
        "CLOSED",
        "LOST",
        "DELETED_FROM_CUSTOMER",
        "QUOTE_SENT",
        "NEGOTIATION",
      ];
      var statusActions = "";
      if (autoStatuses[s.status] || !manualStatuses.includes(s.status)) {
        statusActions +=
          '<option value="" selected disabled>' +
          esc(statusLabels[s.status] || s.status || "Current (auto)") +
          " — auto</option>";
      }
      statusActions += manualStatuses
        .map(function (st) {
          return (
            '<option value="' +
            st +
            '"' +
            (s.status === st || (st === "DELETED_FROM_CUSTOMER" && s.status === "DELETED")
              ? " selected"
              : "") +
            ">" +
            (statusLabels[st] || st) +
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
        "</strong>" +
        (s.pickupFrom || s.pickupTo
          ? '<div class="gos-muted" style="font-size:0.78rem;margin-top:0.15rem">' +
            esc(
              [s.pickupFrom, s.pickupTo]
                .filter(Boolean)
                .map(function (d) {
                  return window.GreenOSModules.crm.fmtDateShort(d);
                })
                .join(" – ")
            ) +
            "</div>"
          : "") +
        "</div>" +
        "<div><span>Delivery</span><strong>" +
        esc(s.delivery) +
        "</strong>" +
        (s.deliveryFrom || s.deliveryTo
          ? '<div class="gos-muted" style="font-size:0.78rem;margin-top:0.15rem">' +
            esc(
              [s.deliveryFrom, s.deliveryTo]
                .filter(Boolean)
                .map(function (d) {
                  return window.GreenOSModules.crm.fmtDateShort(d);
                })
                .join(" – ")
            ) +
            "</div>"
          : "") +
        "</div>" +
        "<div><span>Distance</span><strong>" +
        (s.miles != null ? s.miles + " mi" : "—") +
        "</strong></div>" +
        "<div><span>Vehicle</span><strong>" +
        esc(s.vehicle) +
        "</strong></div>" +
        "<div><span>Equipment</span><strong>" +
        esc(s.equipment || "—") +
        "</strong></div>" +
        "<div><span>Weight</span><strong>" +
        esc(s.weight || "—") +
        "</strong></div>" +
        "<div><span>Rate</span><strong>" +
        (s.price != null ? "$" + s.price : "—") +
        "</strong></div>" +
        (s.imageUrl
          ? '<div class="crm-card-image" style="grid-column:1/-1"><span>Photo</span><img src="' +
            esc(s.imageUrl) +
            '" alt="Shipment" style="max-width:100%;max-height:160px;border-radius:8px;margin-top:0.35rem;object-fit:cover"></div>'
          : "") +
        "</div>" +
        '<div class="crm-notes"><span>Internal Notes</span>' +
        '<textarea id="crm-notes" rows="3" style="width:100%;margin-top:0.35rem;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:0.6rem">' +
        esc(s.notes || "") +
        "</textarea>" +
        '<button type="button" class="btn-secondary" id="crm-save-notes" style="width:auto;margin-top:0.5rem">Save Notes</button>' +
        "</div>" +
        "<h3>Files</h3>" +
        '<div class="crm-files-upload" style="display:flex;flex-wrap:wrap;gap:0.5rem;align-items:center;margin:0.35rem 0 0.75rem">' +
        '<input type="file" id="crm-file-input" accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.png,.jpg,.jpeg,.webp,.gif,.heic,.zip" style="max-width:100%">' +
        '<button type="button" class="btn-secondary" id="crm-upload-file" style="width:auto">Upload from computer</button>' +
        '<span class="gos-muted" id="crm-upload-status" style="font-size:0.8rem"></span>' +
        "</div>" +
        '<ul class="gos-muted" id="crm-files">' +
        (Array.isArray(s.documents) && s.documents.length
          ? s.documents
              .map(function (d) {
                var name = typeof d === "string" ? d : d.name || d.url || "file";
                var url = typeof d === "object" && d.url ? d.url : null;
                var fileId = typeof d === "object" && d.id ? d.id : null;
                var size =
                  typeof d === "object" && d.size
                    ? " · " + Math.max(1, Math.round(d.size / 1024)) + " KB"
                    : "";
                var isImage =
                  typeof d === "object" &&
                  d.mimeType &&
                  String(d.mimeType).indexOf("image/") === 0;
                return (
                  "<li style=\"margin-bottom:0.45rem\">" +
                  (url
                    ? '<a class="crm-file-open" href="' +
                      esc(url) +
                      '" data-url="' +
                      esc(url) +
                      '" target="_blank" rel="noopener">' +
                      esc(name) +
                      "</a>"
                    : esc(name)) +
                  '<small>' +
                  esc(size) +
                  "</small>" +
                  (isImage && url
                    ? '<div style="margin-top:0.35rem"><img class="crm-file-thumb" data-url="' +
                      esc(url) +
                      '" alt="" style="max-width:160px;max-height:100px;border-radius:6px;display:none;object-fit:cover"></div>'
                    : "") +
                  (fileId
                    ? ' <button type="button" class="btn-secondary crm-file-del" data-file-id="' +
                      esc(fileId) +
                      '" style="width:auto;padding:0.15rem 0.45rem;font-size:0.72rem;margin-left:0.35rem">Remove</button>'
                    : "") +
                  "</li>"
                );
              })
              .join("")
          : "<li>No files attached yet — upload a photo or document from your computer</li>") +
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
        "</select>" +
        '<small class="gos-muted" style="display:block;margin-top:0.25rem">Agent Open → Won update from uShip automatically</small></label>' +
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

      function authFileUrl(url) {
        var token = localStorage.getItem("gl_token") || "";
        if (!url) return url;
        var sep = url.indexOf("?") >= 0 ? "&" : "?";
        return url + sep + "token=" + encodeURIComponent(token);
      }

      modal.querySelectorAll(".crm-file-open").forEach(function (link) {
        link.addEventListener("click", function (ev) {
          ev.preventDefault();
          var u = link.getAttribute("data-url") || link.getAttribute("href");
          if (u) window.open(authFileUrl(u), "_blank", "noopener");
        });
      });

      modal.querySelectorAll(".crm-file-thumb").forEach(function (img) {
        var u = img.getAttribute("data-url");
        if (!u) return;
        img.src = authFileUrl(u);
        img.style.display = "block";
      });

      modal.querySelector("#crm-upload-file")?.addEventListener("click", async function () {
        var input = modal.querySelector("#crm-file-input");
        var statusEl = modal.querySelector("#crm-upload-status");
        if (!input || !input.files || !input.files[0]) {
          if (statusEl) statusEl.textContent = "Choose a file first";
          return;
        }
        var file = input.files[0];
        if (statusEl) statusEl.textContent = "Uploading…";
        try {
          var token = localStorage.getItem("gl_token") || "";
          var fd = new FormData();
          fd.append("file", file, file.name);
          var res = await fetch("/api/crm/shipments/" + encodeURIComponent(id) + "/files", {
            method: "POST",
            headers: { Authorization: token ? "Bearer " + token : "" },
            body: fd,
          });
          var data = await res.json();
          if (!data.success) {
            if (statusEl) statusEl.textContent = data.message || "Upload failed";
            return;
          }
          window.GreenOSModules.crm.openShipmentCard(root, id);
        } catch (e) {
          if (statusEl) statusEl.textContent = "Upload failed";
        }
      });

      modal.querySelectorAll(".crm-file-del").forEach(function (btn) {
        btn.addEventListener("click", async function () {
          var fileId = btn.getAttribute("data-file-id");
          if (!fileId) return;
          if (!confirm("Remove this file?")) return;
          await window.GreenOSModules.crm.api(
            "/shipments/" + encodeURIComponent(id) + "/files/" + encodeURIComponent(fileId),
            { method: "DELETE" }
          );
          window.GreenOSModules.crm.openShipmentCard(root, id);
        });
      });

      modal.querySelector("#crm-save-status")?.addEventListener("click", async function () {
        var st = modal.querySelector("#crm-status").value;
        if (!st) {
          alert("This status updates automatically from uShip. Choose a manual status to override.");
          return;
        }
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

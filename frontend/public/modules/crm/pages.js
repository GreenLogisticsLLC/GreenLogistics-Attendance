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

  /** Comments for Team Lead / Manager / Owner — never shown to Broker. */
  canSeeOpsComments() {
    var r = this.currentRole();
    return (
      r === "Team Lead" ||
      r === "Manager" ||
      r === "Owner" ||
      r === "Administrator"
    );
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

    // Soft reload for CRM dashboard/brokers only — never remount Shipments via push.
    window.GreenOSCrmReloadBody = function () {
      if (
        document.getElementById("shipments-module-body") ||
        document.getElementById("crm-ship-body") ||
        document.getElementById("broker-ship-body")
      ) {
        return;
      }
      if (page === "shipments") return;
      paint();
    };
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

  ushipListingUrl(s) {
    if (!s) return "";
    // Prefer the concrete URL already bound on the card at import time.
    var stored = String(s.viewUrl || s.ushipUrl || "").trim();
    if (stored) {
      var storedClean = stored
        .replace(/=\r?\n/g, "")
        .replace(/=3D/gi, "=")
        .replace(/=2F/gi, "/")
        .replace(/%2F/gi, "/")
        .replace(/%3A/gi, ":");
      var sm =
        storedClean.match(/uship\.com\/shipment\/([^\/?#\s"']+)\/(\d{6,})/i) ||
        storedClean.match(/uship\.com\/(?:listing|l)\/(\d{6,})\/([^\/?#\s"']+)/i);
      if (sm) {
        if (/\/shipment\//i.test(sm[0])) {
          return "https://www.uship.com/shipment/" + sm[1] + "/" + sm[2] + "/";
        }
        return "https://www.uship.com/listing/" + sm[1] + "/" + sm[2].replace(/\/+$/, "") + "/";
      }
      var bare = storedClean.match(/uship\.com\/(?:listing|l)\/(\d{6,})\/?(?:[?#]|$)/i);
      if (bare) return "https://www.uship.com/listing/" + bare[1] + "/";
    }
    var extra = [];
    if (s.email) extra.push(s.email.subject, s.email.snippet);
    if (Array.isArray(s.mailboxEmails)) {
      s.mailboxEmails.forEach(function (m) {
        extra.push(m && (m.subject || ""), m && (m.snippet || ""), m && (m.bodyText || ""));
      });
    }
    if (Array.isArray(s.domainEvents)) {
      s.domainEvents.forEach(function (ev) {
        extra.push(ev && (ev.message || ""), ev && (ev.payloadJson || ""));
      });
    }
    if (Array.isArray(s.correspondence)) {
      s.correspondence.forEach(function (c) {
        extra.push(c && (c.message || ""), c && (c.title || ""));
      });
    }
    var blob = [s.ushipUrl, s.viewUrl, s.imageUrl, s.notes, s.externalShipmentId]
      .concat(extra)
      .join("\n");
    blob = String(blob || "")
      .replace(/=\r?\n/g, "")
      .replace(/=3D/gi, "=")
      .replace(/=2F/gi, "/")
      .replace(/%2F/gi, "/")
      .replace(/%3A/gi, ":");
    var m =
      blob.match(/uship\.com\/shipment\/([^\/?#\s"']+)\/(\d{6,})/i) ||
      blob.match(/uship\.com\/(?:listing|l)\/(\d{6,})\/([^\/?#\s"']+)/i);
    if (!m) return "";
    if (/\/shipment\//i.test(m[0])) {
      return "https://www.uship.com/shipment/" + m[1] + "/" + m[2] + "/";
    }
    return "https://www.uship.com/listing/" + m[1] + "/" + m[2].replace(/\/+$/, "") + "/";
  },

  ushipOpenHref(s, id) {
    var listing = this.ushipListingUrl(s);
    if (listing) return listing;
    var token = localStorage.getItem("gl_token") || "";
    return (
      "/api/crm/shipments/" +
      encodeURIComponent(id) +
      "/uship?token=" +
      encodeURIComponent(token)
    );
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
      ASSIGNED: { cls: "crm-st-await", label: "🟡 Waiting" },
      AWAITING_ACCEPTANCE: { cls: "crm-st-await", label: "🟡 Waiting" },
      AGENT_OPEN: { cls: "crm-st-quote", label: "🔵 Open in uShip" },
      WORKING: { cls: "crm-st-working", label: "✅ Shipment Accepted" },
      FOLLOW_UP: { cls: "crm-st-follow", label: "🟠 Follow Up" },
      BROKER_REPLY: { cls: "crm-st-follow", label: "🟠 BROKER REPLY" },
      QUOTE_SENT: { cls: "crm-st-quote", label: "🔵 Quote Sent" },
      NEGOTIATION: { cls: "crm-st-nego", label: "🟣 Negotiation" },
      BOOKED: { cls: "crm-st-quote", label: "🔵 Booked" },
      PICKED_UP: { cls: "crm-st-quote", label: "🔵 Picked Up" },
      DELIVERED: { cls: "crm-st-quote", label: "🔵 Delivered" },
      WON: { cls: "crm-st-won", label: "✅ Won" },
      LOST: { cls: "crm-st-lost", label: "🔴 Lost" },
      ACCEPTED_ANOTHER_COMPANY: { cls: "crm-st-lost", label: "🔴 Accepted another company" },
      DELETED_FROM_CUSTOMER: { cls: "crm-st-deleted", label: "⚫ Deleted from Customer" },
      DELETED: { cls: "crm-st-deleted", label: "⚫ Deleted from Customer" },
      CLOSED: { cls: "crm-st-done", label: "⚫ Closed" },
      COMPLETED: { cls: "crm-st-done", label: "⚫ Completed" },
      BID_SUBMITTED: { cls: "crm-st-quote", label: "🔵 Bid Submitted" },
      CUSTOMER_REPLIED: { cls: "crm-st-replied", label: "🔴 Customer Replied" },
      ACCEPTED: { cls: "crm-st-won", label: "✅ Accept Green" },
      ACCEPT_GREEN: { cls: "crm-st-won", label: "✅ Accept Green" },
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

  async renderShipments(body, root, brokerId, options) {
    options = options || {};
    // Keep the current table on background reloads so the page does not blink.
    if (!body.querySelector("#crm-ship-body")) {
      body.innerHTML = "<p>Loading shipments…</p>";
    }
    try {
      var params = [];
      if (brokerId) params.push("brokerId=" + encodeURIComponent(brokerId));
      if (options.assignmentKind === "new" || options.assignmentKind === "other") {
        params.push("assignmentKind=" + options.assignmentKind);
      }
      var q = params.length ? "?" + params.join("&") : "";
      var data = await this.api("/shipments" + q);
      if (!data.success) {
        body.innerHTML = "<p>" + this.esc(data.message || "Failed") + "</p>";
        return;
      }
      var rows = data.data || [];
      var tabLabel =
        options.assignmentKind === "other"
          ? "Other Shipment"
          : options.assignmentKind === "new"
            ? "New Shipment"
            : "All Shipments";
      body.innerHTML =
        '<section class="gos-dash-hero">' +
        "<h1>" +
        tabLabel +
        "</h1>" +
        "<p>" +
        (options.assignmentKind === "other"
          ? "Loads passed from another broker who did not accept in time."
          : options.assignmentKind === "new"
            ? "Fresh imports and first-time assignments — prioritized in round-robin."
            : "All company shipments — Broker column shows who received each one. Click a row to open and work the card (Owner/Manager have full access).") +
        "</p>" +
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
    // Never interrupt an in-flight first open (stuck "Loading…" race).
    if (modal.getAttribute("data-card-loading") === "1") return;
    if (modal.querySelector(".crm-modal-card p") && /Loading/i.test(modal.textContent || "")) {
      return;
    }
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

  async openShipmentCard(root, id, preview) {
    var modal =
      (root && root.querySelector && root.querySelector("#crm-modal")) ||
      document.getElementById("crm-modal");
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "crm-modal";
      modal.className = "crm-modal";
      modal.setAttribute("role", "dialog");
      modal.setAttribute("aria-modal", "true");
      document.body.appendChild(modal);
    }
    var gen = (this._cardOpenGen = (this._cardOpenGen || 0) + 1);
    modal.classList.remove("hidden");
    modal.setAttribute("data-shipment-id", id);
    modal.setAttribute("data-card-loading", "1");
    var previewHtml = "";
    if (preview) {
      var esc = this.esc.bind(this);
      previewHtml =
        "<h2>" +
        esc(preview.greenOsShipmentId || preview.shipmentTitle || "Shipment") +
        "</h2>" +
        (preview.customer ? "<p><strong>Customer:</strong> " + esc(preview.customer) + "</p>" : "") +
        (preview.pickup || preview.delivery
          ? "<p class=\"gos-muted\">" +
            esc(preview.pickup || "—") +
            " → " +
            esc(preview.delivery || "—") +
            "</p>"
          : "") +
        (preview.status ? "<p>" + this.statusBadge(preview.status) + "</p>" : "");
    }
    modal.innerHTML =
      '<div class="crm-modal-card">' +
      previewHtml +
      '<p class="gos-muted" style="margin-top:0.75rem">Loading details…</p>' +
      "</div>";
    try {
      var data = await this.api("/shipments/" + encodeURIComponent(id));
      if (gen !== this._cardOpenGen) return; // superseded by a newer open
      if (modal.getAttribute("data-shipment-id") !== id) return;
      if (!data.success) {
        modal.removeAttribute("data-card-loading");
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
      modal.removeAttribute("data-card-loading");
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
      var pipeSteps = s.pipeline || [];
      var brokerQ = null;
      var customerR = null;
      for (var pi = 0; pi < pipeSteps.length; pi++) {
        if (pipeSteps[pi].stage === "BROKER_QUESTION") brokerQ = pipeSteps[pi];
        if (pipeSteps[pi].stage === "CUSTOMER_RESPOND") customerR = pipeSteps[pi];
      }
      // Customer reply owns the pair: red on, green off. Never both glowing.
      if (customerR && customerR.done && brokerQ && brokerQ.done) {
        brokerQ = Object.assign({}, brokerQ, { done: false, at: null });
      }

      function pipeNodeHtml(p, opts) {
        opts = opts || {};
        var interactive = opts.interactive || p.interactive || p.stage === "BROKER_QUESTION";
        var side = opts.side || "";
        return (
          '<div class="crm-qa-node ' +
          side +
          (p.done ? " is-done" : " is-pending") +
          (interactive ? " is-interactive" : "") +
          '" data-stage="' +
          esc(p.stage) +
          '">' +
          '<button type="button" class="crm-qa-lamp' +
          (interactive ? " crm-pipe-click" : "") +
          '" title="' +
          (interactive
            ? p.done
              ? "Green: you asked. Click again after the next question"
              : "Click after you send a question to the customer — lamp turns green"
            : p.done
              ? "Red: customer wrote back"
              : "Turns red automatically when the customer writes to you") +
          '"' +
          (interactive ? "" : " tabindex=\"-1\"") +
          "></button>" +
          '<div class="crm-qa-label"><strong>' +
          esc(p.title) +
          "</strong>" +
          (interactive
            ? '<small class="crm-pipe-hint">' +
              (p.done
                ? "Green lamp on — click again after each new question"
                : "Click the circle after you ask — green lamp") +
              "</small>"
            : '<small class="crm-pipe-hint">' +
              (p.done
                ? "Red lamp — customer replied (uShip email)"
                : "Turns red when the customer writes back") +
              "</small>") +
          (p.at ? "<small>" + window.GreenOSModules.crm.fmtDate(p.at) + "</small>" : "") +
          "</div></div>"
        );
      }

      function qaArrowHtml(customerDone, brokerDone) {
        // Red lamp (customer replied) → red arrow points to broker (right)
        // Green lamp (broker asked) → green arrow points to customer (left)
        var redToBroker = Boolean(customerDone);
        var greenToCustomer = !redToBroker && Boolean(brokerDone);
        var cls = "crm-qa-arrow";
        if (redToBroker) cls += " is-to-broker";
        else if (greenToCustomer) cls += " is-to-customer";
        else cls += " is-idle";
        var head = redToBroker ? "▶" : "◀";
        return (
          '<div class="' +
          cls +
          '" aria-hidden="true">' +
          (redToBroker
            ? '<span class="crm-qa-arrow-line"></span>' +
              '<span class="crm-qa-arrow-head">' +
              head +
              "</span>"
            : '<span class="crm-qa-arrow-head">' +
              head +
              "</span>" +
              '<span class="crm-qa-arrow-line"></span>') +
          "</div>"
        );
      }

      function qaPairHtml() {
        var cust = customerR || { stage: "CUSTOMER_RESPOND", title: "Customer Respond", done: false };
        var brok = brokerQ || {
          stage: "BROKER_QUESTION",
          title: "Broker Question",
          done: false,
          interactive: true,
        };
        return (
          '<li class="crm-pipe-qa-row">' +
          '<div class="crm-qa-pair' +
          (cust.done ? " is-customer-active" : brok.done ? " is-broker-active" : "") +
          '">' +
          pipeNodeHtml(cust, { side: "is-customer" }) +
          qaArrowHtml(cust.done, brok.done) +
          pipeNodeHtml(brok, { side: "is-broker", interactive: true }) +
          "</div></li>"
        );
      }

      var pipeline = "";
      var qaInserted = false;
      var afterLoadCreated = false;
      pipeSteps.forEach(function (p) {
        if (afterLoadCreated) return;
        if (p.stage === "BROKER_QUESTION" || p.stage === "CUSTOMER_RESPOND") {
          if (qaInserted) return;
          qaInserted = true;
          pipeline += qaPairHtml();
          return;
        }
        pipeline +=
          '<li class="' +
          (p.done ? "is-done" : "") +
          (p.stage === "AGENT_OPENED" ? " crm-pipe-uship" : "") +
          '" data-stage="' +
          esc(p.stage) +
          '">' +
          '<span class="crm-pipe-dot"></span>' +
          "<div><strong>" +
          esc(p.title) +
          "</strong>" +
          (p.at ? "<small>" + window.GreenOSModules.crm.fmtDate(p.at) + "</small>" : "") +
          "</div></li>";
        if (p.stage === "LOAD_CREATED") afterLoadCreated = true;
      });
      if (afterLoadCreated || s.loadNumber) {
        pipeline +=
          '<li class="crm-pipe-loads-note">' +
          '<span class="crm-pipe-dot"></span>' +
          "<div><strong>Continue in Loads</strong>" +
          "<small>Carrier, Rate Con, Pickup, POD, Invoice — open the Loads section</small></div></li>";
      }
      if (!qaInserted && (brokerQ || customerR)) {
        pipeline += qaPairHtml();
      }

      var correspondence = Array.isArray(s.correspondence) ? s.correspondence : [];
      // Only latest Broker Answer + latest Customer Respond (server already prunes).
      var latestBroker = null;
      var latestCustomer = null;
      correspondence.forEach(function (c) {
        var isBroker = c.kind === "BROKER_ANSWER" || c.kind === "BROKER_QUESTION";
        if (isBroker) latestBroker = c;
        else latestCustomer = c;
      });
      var corrShow = [];
      if (latestBroker) corrShow.push(latestBroker);
      if (latestCustomer) corrShow.push(latestCustomer);
      corrShow.sort(function (a, b) {
        return new Date(a.at || 0) - new Date(b.at || 0);
      });

      var correspondenceHtml =
        '<h3>Q&amp;A traffic light</h3>' +
        '<p class="gos-muted" style="font-size:0.8rem;margin:0 0 0.5rem">Green lamp = you asked (click the circle). Red lamp = customer wrote back (from uShip/Gmail).</p>' +
        '<ul class="crm-correspondence">' +
        (corrShow.length
          ? corrShow
              .map(function (c) {
                var isBroker = c.kind === "BROKER_ANSWER" || c.kind === "BROKER_QUESTION";
                return (
                  '<li class="' +
                  (isBroker ? "is-broker" : "is-customer") +
                  '"><span class="crm-corr-dot"></span><div><strong>' +
                  esc(c.title || (isBroker ? "Broker Answer" : "Customer Respond")) +
                  "</strong>" +
                  (c.message ? "<div>" + esc(c.message) + "</div>" : "") +
                  (c.at
                    ? "<small>" + window.GreenOSModules.crm.fmtDate(c.at) + "</small>"
                    : "") +
                  "</div></li>"
                );
              })
              .join("")
          : "<li class=\"gos-muted\">No Q&amp;A yet — tap the green Broker Question lamp after you write to the customer</li>") +
        "</ul>";

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
        (window.GreenOSModules.crm.canSeeOpsComments()
          ? (function () {
              var comments = Array.isArray(s.opsComments) ? s.opsComments : [];
              var listHtml = comments.length
                ? comments
                    .map(function (c) {
                      return (
                        '<li style="margin-bottom:0.65rem;padding:0.55rem 0.65rem;border:1px solid var(--border);border-radius:8px;background:var(--bg)">' +
                        '<div style="display:flex;flex-wrap:wrap;gap:0.35rem 0.75rem;align-items:baseline;margin-bottom:0.25rem">' +
                        "<strong>" +
                        esc(c.authorName || "—") +
                        "</strong>" +
                        '<span class="gos-muted" style="font-size:0.78rem">' +
                        esc(c.authorRole || "") +
                        " · " +
                        esc(window.GreenOSModules.crm.fmtDate(c.createdAt)) +
                        "</span>" +
                        (c.sentToManager
                          ? '<span style="font-size:0.72rem;color:#f59e0b">Sent to Manager</span>'
                          : '<button type="button" class="btn-secondary crm-ops-send-mgr" data-comment-id="' +
                            esc(c.commentId) +
                            '" style="width:auto;padding:0.15rem 0.5rem;font-size:0.72rem">Send to Manager</button>') +
                        "</div>" +
                        '<div style="white-space:pre-wrap">' +
                        esc(c.body || "") +
                        "</div>" +
                        "</li>"
                      );
                    })
                    .join("")
                : '<li class="gos-muted">No comments yet — Team Lead can write here; Broker never sees this.</li>';
              return (
                '<div class="crm-ops-comments" style="margin-top:1rem">' +
                "<h3>Comments</h3>" +
                '<p class="gos-muted" style="font-size:0.8rem;margin:0.15rem 0 0.5rem">Visible to Team Lead, Manager, Owner — hidden from Broker.</p>' +
                '<ul id="crm-ops-comment-list" style="list-style:none;padding:0;margin:0 0 0.75rem">' +
                listHtml +
                "</ul>" +
                '<textarea id="crm-ops-comment-body" rows="3" placeholder="Write a comment for Manager…" style="width:100%;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:0.6rem"></textarea>' +
                '<div style="display:flex;flex-wrap:wrap;gap:0.5rem;margin-top:0.5rem">' +
                '<button type="button" class="btn-secondary" id="crm-ops-comment-save" style="width:auto">Save comment</button>' +
                '<button type="button" class="btn-primary" id="crm-ops-comment-send" style="width:auto">Send to Manager</button>' +
                "</div>" +
                "</div>"
              );
            })()
          : "") +
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
        '<div class="crm-actions">' +
        (s.status === "AWAITING_ACCEPTANCE" || s.status === "ASSIGNED" || s.status === "AGENT_OPEN"
          ? '<button type="button" class="btn-primary" id="crm-accept">Accept Shipment</button>'
          : "") +
        (function () {
          var href = window.GreenOSModules.crm.ushipOpenHref(s, id);
          return (
            '<a class="btn-primary crm-open-uship" href="' +
            esc(href) +
            '" target="_blank" rel="noopener noreferrer" data-uship-url="' +
            esc(href) +
            '">Open in uShip</a>'
          );
        })() +
        (s.loadNumber
          ? '<button type="button" class="btn-primary" id="crm-open-load">Open Load ' +
            esc(s.loadNumber) +
            "</button>"
          : s.status === "ACCEPTED" || s.status === "ACCEPT_GREEN" || s.status === "BOOKED"
            ? '<button type="button" class="btn-primary" id="crm-save-load">Create Load (auto GL#)</button>' +
              '<small class="gos-muted" style="display:block;width:100%">Accept Green — Load Number is generated by GreenOS only</small>'
            : s.status === "LOAD_CREATED" ||
                s.status === "CARRIER_ASSIGNED" ||
                s.status === "DISPATCH"
              ? '<button type="button" class="btn-secondary" id="crm-save-load">Create Load (auto GL#)</button>'
              : "") +
        (!s.loadNumber &&
        s.status !== "CLOSED" &&
        s.status !== "LOST" &&
        s.status !== "ACCEPTED_ANOTHER_COMPANY" &&
        s.status !== "DELETED_FROM_CUSTOMER" &&
        s.status !== "ACCEPTED" &&
        s.status !== "ACCEPT_GREEN" &&
        s.status !== "BOOKED" &&
        s.status !== "LOAD_CREATED"
          ? '<button type="button" class="btn-secondary" id="crm-test-accept" style="border-color:#f59e0b;color:#f59e0b">TEST: Customer Accepted → Create Load</button>' +
            '<small class="gos-muted" style="display:block;width:100%">Skips uShip email — for Load / Rate Con / BOL / POD testing only</small>'
          : "") +
        "</div>" +
        "<h3>Timeline / Lifecycle</h3>" +
        '<ol class="crm-pipeline">' +
        pipeline +
        "</ol>" +
        correspondenceHtml +
        "</div>";

      modal.querySelector("#crm-close")?.addEventListener("click", function () {
        modal.classList.add("hidden");
        modal.innerHTML = "";
        if (typeof window.GreenOSCrmReloadBody === "function") {
          window.GreenOSCrmReloadBody();
        }
        if (typeof window.GreenOSBrokerReloadShipments === "function") {
          window.GreenOSBrokerReloadShipments();
        }
        if (typeof window.GreenOSBrokerReloadCustomerRespond === "function") {
          window.GreenOSBrokerReloadCustomerRespond();
        }
      });
      modal.addEventListener("click", function (ev) {
        if (ev.target === modal) {
          modal.classList.add("hidden");
          modal.innerHTML = "";
          if (typeof window.GreenOSCrmReloadBody === "function") {
            window.GreenOSCrmReloadBody();
          }
          if (typeof window.GreenOSBrokerReloadShipments === "function") {
            window.GreenOSBrokerReloadShipments();
          }
          if (typeof window.GreenOSBrokerReloadCustomerRespond === "function") {
            window.GreenOSBrokerReloadCustomerRespond();
          }
        }
      });

      modal.querySelectorAll(".crm-open-uship, .crm-pipe-uship").forEach(function (link) {
        link.addEventListener("click", function (ev) {
          ev.stopPropagation();
          var href =
            link.getAttribute("data-uship-url") ||
            link.getAttribute("href") ||
            window.GreenOSModules.crm.ushipOpenHref(s, id);
          if (!href) return;
          // Never block the tab — native <a target=_blank> survives popup blockers.
          if (link.tagName !== "A") {
            window.open(href, "_blank", "noopener");
          }
          var waiting =
            s.status === "NEW" ||
            s.status === "UNASSIGNED" ||
            s.status === "ASSIGNED" ||
            s.status === "AWAITING_ACCEPTANCE" ||
            s.status === "AGENT_OPEN";
          if (!waiting) return;
          var badgeHost = modal.querySelector(".crm-card-grid div");
          if (badgeHost) {
            badgeHost.innerHTML =
              "<span>Status</span>" + window.GreenOSModules.crm.statusBadge("AGENT_OPEN");
          }
          window.GreenOSModules.crm.api("/shipments/" + encodeURIComponent(id) + "/opened?action=uship", {
            method: "POST",
            body: JSON.stringify({ action: "uship" }),
          });
        });
      });

      modal.querySelectorAll(".crm-pipe-click").forEach(function (btn) {
        btn.addEventListener("click", async function () {
          var host = btn.closest("[data-stage]");
          var stage = host && host.getAttribute("data-stage");
          if (stage !== "BROKER_QUESTION") return;
          var node = btn.closest(".crm-qa-node");
          if (node) {
            node.classList.remove("is-pending");
            node.classList.add("is-done");
          }
          var customerNode = modal.querySelector(".crm-qa-node.is-customer");
          if (customerNode) {
            customerNode.classList.remove("is-done");
            customerNode.classList.add("is-pending");
          }
          btn.disabled = true;
          try {
            var res = await window.GreenOSModules.crm.api(
              "/shipments/" + encodeURIComponent(id) + "/broker-question",
              { method: "POST", body: JSON.stringify({}) }
            );
            if (!res || res.success === false) {
              throw new Error((res && res.message) || "Could not mark Broker Answer");
            }
            var next = res.data || null;
            window.GreenOSModules.crm.openShipmentCard(document, id, next);
            if (typeof window.GreenOSBrokerReloadCustomerRespond === "function") {
              window.GreenOSBrokerReloadCustomerRespond();
            }
            if (typeof window.GreenOSBrokerReloadShipments === "function") {
              window.GreenOSBrokerReloadShipments();
            }
          } catch (e) {
            btn.disabled = false;
            if (customerNode) {
              customerNode.classList.add("is-done");
              customerNode.classList.remove("is-pending");
            }
            alert((e && e.message) || "Could not mark Broker Answer");
          }
        });
      });

      modal.querySelector("#crm-accept")?.addEventListener("click", async function () {
        var res = await window.GreenOSModules.crm.api("/shipments/" + id + "/accept", {
          method: "POST",
        });
        if (!res || res.success === false) {
          alert((res && res.message) || "Could not accept shipment");
          return;
        }
        window.GreenOSModules.crm.openShipmentCard(document, id, res.data || null);
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

      modal.querySelector("#crm-save-notes")?.addEventListener("click", async function () {
        var notes = modal.querySelector("#crm-notes").value;
        await window.GreenOSModules.crm.api("/shipments/" + id, {
          method: "PATCH",
          body: JSON.stringify({ status: s.status, notes: notes }),
        });
        window.GreenOSModules.crm.openShipmentCard(root, id);
      });

      async function postOpsComment(sendToManager) {
        var ta = modal.querySelector("#crm-ops-comment-body");
        var body = ta ? String(ta.value || "").trim() : "";
        if (!body) {
          alert("Write a comment first");
          return;
        }
        var saveBtn = modal.querySelector("#crm-ops-comment-save");
        var sendBtn = modal.querySelector("#crm-ops-comment-send");
        if (saveBtn) saveBtn.disabled = true;
        if (sendBtn) sendBtn.disabled = true;
        try {
          var res = await window.GreenOSModules.crm.api(
            "/shipments/" + encodeURIComponent(id) + "/ops-comments",
            {
              method: "POST",
              body: JSON.stringify({ body: body, sendToManager: !!sendToManager }),
            }
          );
          if (!res || !res.success) {
            throw new Error((res && res.message) || "Comment failed");
          }
          window.GreenOSModules.crm.openShipmentCard(root, id);
        } catch (err) {
          alert(err.message || err);
          if (saveBtn) saveBtn.disabled = false;
          if (sendBtn) sendBtn.disabled = false;
        }
      }

      modal.querySelector("#crm-ops-comment-save")?.addEventListener("click", function () {
        postOpsComment(false);
      });
      modal.querySelector("#crm-ops-comment-send")?.addEventListener("click", function () {
        postOpsComment(true);
      });
      modal.querySelectorAll(".crm-ops-send-mgr").forEach(function (btn) {
        btn.addEventListener("click", async function () {
          var commentId = btn.getAttribute("data-comment-id");
          if (!commentId) return;
          btn.disabled = true;
          try {
            var res = await window.GreenOSModules.crm.api(
              "/shipments/" +
                encodeURIComponent(id) +
                "/ops-comments/" +
                encodeURIComponent(commentId) +
                "/send-to-manager",
              { method: "POST", body: "{}" }
            );
            if (!res || !res.success) {
              throw new Error((res && res.message) || "Send failed");
            }
            window.GreenOSModules.crm.openShipmentCard(root, id);
          } catch (err) {
            alert(err.message || err);
            btn.disabled = false;
          }
        });
      });

      modal.querySelector("#crm-save-load")?.addEventListener("click", async function () {
        var token = localStorage.getItem("gl_token") || "";
        var btn = modal.querySelector("#crm-save-load");
        if (btn) btn.disabled = true;
        try {
          var res = await fetch("/api/loads/" + encodeURIComponent(id) + "/create", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: "Bearer " + token,
            },
            body: JSON.stringify({}),
          });
          var json = await res.json().catch(function () {
            return {};
          });
          if (!res.ok || json.success === false) {
            throw new Error(json.message || "Create Load failed");
          }
          modal.classList.add("hidden");
          modal.innerHTML = "";
          if (typeof window.GreenOSOpenLoad === "function") {
            window.GreenOSOpenLoad(id, "general");
          } else {
            window.GreenOSModules.crm.openShipmentCard(root, id);
          }
        } catch (err) {
          alert(err.message || err);
          if (btn) btn.disabled = false;
        }
      });
      modal.querySelector("#crm-test-accept")?.addEventListener("click", async function () {
        if (
          !confirm(
            "TEST only: simulate Customer Accepted (as if uShip email arrived) and auto-create Load Number?\n\nReal production Accepted still comes from Gmail."
          )
        ) {
          return;
        }
        var btn = modal.querySelector("#crm-test-accept");
        if (btn) btn.disabled = true;
        try {
          var json = await window.GreenOSModules.crm.api(
            "/shipments/" + encodeURIComponent(id) + "/test-customer-accept",
            { method: "POST", body: "{}" }
          );
          if (!json || json.success === false) {
            throw new Error((json && json.message) || "Test accept failed");
          }
          var card = json.data || {};
          var loadNo = card.loadNumber || "";
          modal.classList.add("hidden");
          modal.innerHTML = "";
          if (typeof window.GreenOSOpenLoad === "function") {
            window.GreenOSOpenLoad(id, "general");
          } else {
            alert("TEST OK" + (loadNo ? " — Load " + loadNo : "") + ". Open Loads module.");
            window.GreenOSModules.crm.openShipmentCard(root, id);
          }
        } catch (err) {
          alert(err.message || err);
          if (btn) btn.disabled = false;
        }
      });
      modal.querySelector("#crm-open-load")?.addEventListener("click", function () {
        modal.classList.add("hidden");
        modal.innerHTML = "";
        if (typeof window.GreenOSOpenLoad === "function") {
          window.GreenOSOpenLoad(id, "general");
        } else {
          try {
            sessionStorage.setItem("gos_open_load_id", id);
          } catch (e) {}
          if (window.GreenOSShell && typeof window.GreenOSShell.navigate === "function") {
            window.GreenOSShell.navigate("loads", "active-loads");
          }
        }
      });
    } catch (err) {
      if (gen !== this._cardOpenGen) return;
      modal.removeAttribute("data-card-loading");
      modal.innerHTML =
        '<div class="crm-modal-card"><p>Failed to load card' +
        (err && err.message ? ": " + this.esc(err.message) : "") +
        '</p><button type="button" class="btn-secondary" id="crm-close">Close</button></div>';
      modal.querySelector("#crm-close")?.addEventListener("click", function () {
        modal.classList.add("hidden");
        modal.innerHTML = "";
      });
    }
  },
};

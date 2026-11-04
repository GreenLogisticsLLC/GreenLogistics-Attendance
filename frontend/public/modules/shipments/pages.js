/**
 * Top-level Shipments workspace (Owner / Manager / Admin).
 * Reuses CRM shipment list + card so ops can open and work any lead.
 */
window.GreenOSModules = window.GreenOSModules || {};
window.GreenOSModules.shipments = {
  render(root, subPageId) {
    if (!root) return;
    var crm = window.GreenOSModules.crm;
    if (!crm || typeof crm.renderShipments !== "function") {
      root.innerHTML =
        '<p class="gos-muted">Shipments module failed to load CRM helpers. Refresh the page.</p>';
      return;
    }

    var me = (window.GreenOS && window.GreenOS.user) || window.GreenOSUser || {};
    var isTeamLead = me.role === "Team Lead";
    var brokerMod = window.GreenOSModules.broker;
    if (brokerMod && typeof brokerMod.stopShipmentsAutoRefresh === "function") {
      brokerMod.stopShipmentsAutoRefresh();
    }
    if (isTeamLead) {
      return this.renderTeamLead(root, subPageId, me);
    }
    var canSeeQueue =
      me.role === "Owner" || me.role === "Manager" || me.role === "Administrator";
    var tab =
      subPageId === "other"
        ? "other"
        : subPageId === "accepted"
          ? "accepted"
          : subPageId === "load-created"
            ? "load-created"
          : subPageId === "accepted-another"
            ? "accepted-another"
            : subPageId === "no-longer"
              ? "no-longer"
            : subPageId === "decline"
              ? "decline"
            : subPageId === "by-broker"
              ? "by-broker"
              : subPageId === "queue" && canSeeQueue
                ? "queue"
                : subPageId === "new"
                ? "new"
                : "new";

    root.innerHTML =
      '<div class="gos-module-layout">' +
      '<nav class="gos-subnav">' +
      '<button type="button" class="gos-subnav-item' +
      (tab === "new" ? " is-active" : "") +
      '" data-subpage="new">New Shipment</button>' +
      '<button type="button" class="gos-subnav-item' +
      (tab === "other" ? " is-active" : "") +
      '" data-subpage="other">Other Shipment</button>' +
      '<button type="button" class="gos-subnav-item' +
      (tab === "accepted" ? " is-active" : "") +
      '" data-subpage="accepted">Accepted shipments</button>' +
      '<button type="button" class="gos-subnav-item' +
      (tab === "accepted-another" ? " is-active" : "") +
      '" data-subpage="accepted-another">Accepted to another company</button>' +
      '<button type="button" class="gos-subnav-item' +
      (tab === "no-longer" ? " is-active" : "") +
      '" data-subpage="no-longer">No longer needed</button>' +
      '<button type="button" class="gos-subnav-item' +
      (tab === "decline" ? " is-active" : "") +
      '" data-subpage="decline">Decline</button>' +
      '<button type="button" class="gos-subnav-item' +
      (tab === "load-created" ? " is-active" : "") +
      '" data-subpage="load-created">Load Created</button>' +
      (canSeeQueue
        ? '<button type="button" class="gos-subnav-item' +
          (tab === "queue" ? " is-active" : "") +
          '" data-subpage="queue">Queue</button>'
        : "") +
      "</nav>" +
      '<div class="gos-module-body" id="shipments-module-body"></div>' +
      "</div>";
    var body = root.querySelector("#shipments-module-body");
    window.GreenOSCrmReloadBody = function () {
      /* Team Lead / ops Shipments list is manual — no push remount. */
    };
    if (tab === "by-broker") {
      this.renderBrokerStats(body);
      return;
    }
    if (tab === "queue") {
      this.renderQueue(body);
      return;
    }
    var opts =
      tab === "accepted-another"
        ? { status: "ACCEPTED_ANOTHER_COMPANY", page: 1 }
        : tab === "no-longer"
          ? { status: "NO_LONGER_NEEDED", page: 1 }
        : tab === "decline"
          ? { status: "ROUND_DECLINED", page: 1 }
        : tab === "load-created"
            ? { assignmentKind: "loads", page: 1 }
          : { assignmentKind: tab, page: 1 };
    crm.renderShipments(body, root, null, opts);
  },

  /** Team Lead: own broker desk, and Team beside it for the whole group. */
  renderTeamLead(root, subPageId, me) {
    var teamTabs = {
      team: "new",
      new: "new",
      other: "other",
      accepted: "accepted",
      "accepted-another": "accepted-another",
      "no-longer": "no-longer",
      decline: "decline",
      "load-created": "load-created",
      "by-broker": "by-broker",
    };
    var teamTab = Object.prototype.hasOwnProperty.call(teamTabs, subPageId)
      ? teamTabs[subPageId]
      : null;
    var mode = teamTab ? "team" : "mine";
    function item(id, label) {
      return (
        '<button type="button" class="gos-subnav-item' +
        (teamTab === id ? " is-active" : "") +
        '" data-subpage="' +
        id +
        '">' +
        label +
        "</button>"
      );
    }
    var teamNav =
      mode === "team"
        ? '<nav class="gos-subnav">' +
          item("new", "New Shipment") +
          item("other", "Other Shipment") +
          item("accepted", "Accepted shipments") +
          item("accepted-another", "Accepted to another company") +
          item("no-longer", "No longer needed") +
          item("decline", "Decline") +
          item("load-created", "Load Created") +
          item("by-broker", "By Broker") +
          "</nav>"
        : "";
    root.innerHTML =
      '<div class="gos-module-layout">' +
      '<nav class="gos-subnav">' +
      '<button type="button" class="gos-subnav-item' +
      (mode === "mine" ? " is-active" : "") +
      '" data-subpage="mine">My Shipments</button>' +
      '<button type="button" class="gos-subnav-item' +
      (mode === "team" ? " is-active" : "") +
      '" data-subpage="team">Team</button>' +
      "</nav>" +
      teamNav +
      '<div class="gos-module-body" id="shipments-module-body"></div>' +
      "</div>";
    var body = root.querySelector("#shipments-module-body");
    window.GreenOSCrmReloadBody = function () {};
    if (mode === "mine") {
      var broker = window.GreenOSModules.broker;
      if (!broker || typeof broker.renderShipments !== "function") {
        body.innerHTML = "<p>My Shipments failed to load. Refresh the page.</p>";
        return;
      }
      var mineId =
        me.userId ||
        me.id ||
        (window.GreenOSUser && (window.GreenOSUser.userId || window.GreenOSUser.id)) ||
        "";
      return broker.renderShipments(body, root, { brokerId: mineId, mine: true });
    }
    if (teamTab === "by-broker") {
      this.renderBrokerStats(body);
      return;
    }
    var crm = window.GreenOSModules.crm;
    var opts =
      teamTab === "accepted-another"
        ? { status: "ACCEPTED_ANOTHER_COMPANY", page: 1 }
        : teamTab === "no-longer"
          ? { status: "NO_LONGER_NEEDED", page: 1 }
        : teamTab === "decline"
          ? { status: "ROUND_DECLINED", page: 1 }
        : teamTab === "load-created"
          ? { assignmentKind: "loads", page: 1 }
          : { assignmentKind: teamTab, page: 1 };
    crm.renderShipments(body, root, null, opts);
  },

  async renderQueue(body) {
    var self = this;
    body.innerHTML =
      '<section class="gos-dash-hero"><h1>Shipment queue</h1>' +
      "<p>Who receives the next New shipment and the next Other shipment. Names and turns only.</p></section>" +
      '<p class="gos-muted">Loading…</p>';
    var token = "";
    try {
      token = localStorage.getItem("gl_token") || "";
    } catch (e) {}
    var response;
    var ctrl = typeof AbortController === "function" ? new AbortController() : null;
    var timer = setTimeout(function () {
      if (ctrl) ctrl.abort();
    }, 20000);
    try {
      response = await fetch("/api/assignment/board", {
        headers: { Accept: "application/json", Authorization: token ? "Bearer " + token : "" },
        signal: ctrl ? ctrl.signal : undefined,
      });
    } catch (err) {
      clearTimeout(timer);
      body.innerHTML = "<p>Could not load the queue. Press Refresh.</p>";
      return;
    }
    clearTimeout(timer);
    var data = await response.json().catch(function () {
      return {};
    });
    if (!response.ok || !data.success) {
      body.innerHTML = "<p>" + self.esc(data.message || "Could not load the queue.") + "</p>";
      return;
    }
    var board = data.data || {};
    function placeLabel(place) {
      if (place === "next") return "Receives next";
      if (place === "received") return "Received last";
      return "Waiting";
    }
    function countCell(row, kind) {
      var total = kind === "other" ? row.otherShipments || 0 : row.newShipments || 0;
      if (kind === "other") {
        return "<td><strong>" + self.esc(total) + "</strong></td>";
      }
      var lines =
        "<div class=\"gos-muted\">Accept " +
        self.esc(row.newAccepted || 0) +
        "</div><div class=\"gos-muted\">Declined " +
        self.esc(row.newDeclined || 0) +
        "</div>";
      if (row.newWaiting) {
        lines += "<div class=\"gos-muted\">Waiting " + self.esc(row.newWaiting) + "</div>";
      }
      return "<td><strong>" + self.esc(total) + "</strong>" + lines + "</td>";
    }
    function table(queue, emptyText) {
      var people = (queue && queue.people) || [];
      if (!people.length) {
        return '<p class="gos-muted">' + emptyText + "</p>";
      }
      return (
        '<div class="table-wrap"><table class="crm-table"><thead><tr>' +
        "<th>#</th><th>New shipment</th><th>Other shipment</th><th>Name</th><th>Turn</th></tr></thead><tbody>" +
        people
          .map(function (row) {
            return (
              "<tr><td>" +
              self.esc(row.position) +
              "</td>" +
              countCell(row, "new") +
              countCell(row, "other") +
              "<td><strong>" +
              self.esc(row.name) +
              "</strong></td><td>" +
              self.esc(placeLabel(row.place)) +
              "</td></tr>"
            );
          })
          .join("") +
        "</tbody></table></div>"
      );
    }
    var outside = board.outside || [];
    body.innerHTML =
      '<section class="gos-dash-hero"><h1>Shipment queue</h1>' +
      "<p>" +
      self.esc(board.assignmentModeLabel || "") +
      ". The next shipment goes to the person marked Receives next. Everyone else in the circle is Waiting.</p></section>" +
      '<div style="display:flex;gap:0.75rem;margin:0 0 1rem"><button type="button" class="btn-secondary" id="queue-refresh" style="width:auto">Refresh</button></div>' +
      '<div class="gos-queue-grid">' +
      '<section class="gos-card" style="padding:1rem"><h2 style="margin:0 0 0.35rem">New shipments</h2>' +
      '<p class="gos-muted" style="margin:0 0 0.75rem">Next: ' +
      self.esc((board.newQueue && board.newQueue.nextName) || "nobody") +
      "</p>" +
      table(board.newQueue, "No one is in the New queue.") +
      "</section>" +
      '<section class="gos-card" style="padding:1rem"><h2 style="margin:0 0 0.35rem">Other shipments</h2>' +
      '<p class="gos-muted" style="margin:0 0 0.75rem">Next: ' +
      self.esc((board.otherQueue && board.otherQueue.nextName) || "nobody") +
      "</p>" +
      table(board.otherQueue, "No one is in the Other queue.") +
      "</section></div>" +
      '<section class="gos-card" style="padding:1rem;margin-top:1rem"><h2 style="margin:0 0 0.75rem">Not in the queue</h2>' +
      (outside.length
        ? '<div class="table-wrap"><table class="crm-table"><thead><tr><th>New shipment</th><th>Other shipment</th><th>Name</th><th>Role</th><th>Why</th></tr></thead><tbody>' +
          outside
            .map(function (row) {
              return (
                "<tr>" +
                countCell(row, "new") +
                countCell(row, "other") +
                "<td><strong>" +
                self.esc(row.name) +
                "</strong></td><td>" +
                self.esc(row.role) +
                "</td><td>" +
                self.esc(row.reason) +
                "</td></tr>"
              );
            })
            .join("") +
          "</tbody></table></div>"
        : '<p class="gos-muted">Everyone who can receive shipments is in the queue.</p>') +
      "</section>";
    var refresh = body.querySelector("#queue-refresh");
    if (refresh) {
      refresh.addEventListener("click", function () {
        self.renderQueue(body);
      });
    }
  },

  esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  },

  async renderBrokerStats(body) {
    var crm = window.GreenOSModules.crm;
    body.innerHTML =
      '<section class="gos-dash-hero"><h1>By Broker</h1>' +
      "<p>New shipments that arrived, Other shipments passed from someone who did not Accept, how many this broker Accepted, and New shipments still without Accept.</p></section>" +
      '<p class="gos-muted">Loading…</p>';
    var data;
    try {
      data = await crm.api("/team-broker-stats");
    } catch (err) {
      body.innerHTML = "<p>Could not load broker totals.</p>";
      return;
    }
    if (!data || !data.success) {
      body.innerHTML = "<p>" + (data && data.message ? data.message : "Could not load broker totals.") + "</p>";
      return;
    }
    var payload = data.data || {};
    var rows = payload.rows || [];
    var selected = "";

    function esc(s) {
      return String(s == null ? "" : s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }
    function sum(list, key) {
      return list.reduce(function (n, row) {
        return n + (Number(row[key]) || 0);
      }, 0);
    }
    function card(label, value, hint) {
      return (
        '<article class="gos-broker-stat"><div class="label">' +
        esc(label) +
        '</div><div class="value">' +
        esc(value) +
        '</div><p>' +
        esc(hint) +
        "</p></article>"
      );
    }
    function paint() {
      var shown = selected
        ? rows.filter(function (row) {
            return row.brokerId === selected;
          })
        : rows;
      var options =
        '<option value="">All brokers</option>' +
        rows
          .map(function (row) {
            return (
              '<option value="' +
              esc(row.brokerId) +
              '"' +
              (row.brokerId === selected ? " selected" : "") +
              ">" +
              esc(row.name) +
              "</option>"
            );
          })
          .join("");
      var groups = [
        ["New received", "newShipments"],
        ["Other received", "otherShipments"],
        ["Accepted", "acceptedShipments"],
        ["New without Accept", "newNotAcceptedShipments"],
      ];
      var listRows = [];
      shown.forEach(function (row) {
        groups.forEach(function (group) {
          (row[group[1]] || []).forEach(function (ship) {
            listRows.push({
              broker: row.name,
              group: group[0],
              ship: ship,
            });
          });
        });
      });
      var table = shown.length
        ? '<div class="table-wrap"><table class="crm-table"><thead><tr>' +
          "<th>Broker</th><th>New received</th><th>Other received</th><th>Accepted</th><th>New without Accept</th>" +
          "</tr></thead><tbody>" +
          shown
            .map(function (row) {
              return (
                "<tr><td>" +
                esc(row.name) +
                "</td><td>" +
                row.newReceived +
                "</td><td>" +
                row.otherReceived +
                "</td><td>" +
                row.accepted +
                "</td><td>" +
                row.newNotAccepted +
                "</td></tr>"
              );
            })
            .join("") +
          "</tbody></table></div>" +
          '<h2 style="margin:1.25rem 0 0.6rem;font-size:1.05rem">Shipments</h2>' +
          (listRows.length
            ? '<div class="table-wrap"><table class="crm-table"><thead><tr>' +
              "<th>Broker</th><th>List</th><th>Shipment</th><th>ID</th><th>Customer</th><th>Status</th>" +
              "</tr></thead><tbody>" +
              listRows
                .map(function (item) {
                  var ship = item.ship || {};
                  return (
                    '<tr class="crm-row" data-ship="' +
                    esc(ship.shipmentLeadId) +
                    '"><td>' +
                    esc(item.broker) +
                    "</td><td>" +
                    esc(item.group) +
                    "</td><td>" +
                    esc(ship.title || "Shipment") +
                    "</td><td>" +
                    esc(ship.greenOsShipmentId || "—") +
                    "</td><td>" +
                    esc(ship.customerName || "—") +
                    "</td><td>" +
                    esc(ship.status || "—") +
                    "</td></tr>"
                  );
                })
                .join("") +
              "</tbody></table></div>"
            : '<p class="gos-muted">No shipments in this filter.</p>')
        : '<p class="gos-muted">No brokers on your team yet.</p>';
      body.innerHTML =
        '<section class="gos-dash-hero"><h1>By Broker</h1>' +
        "<p>Filter one broker, or leave All brokers to compare the team.</p></section>" +
        '<label class="crm-page-size">Broker <select id="gos-broker-stat-filter" aria-label="Broker">' +
        options +
        "</select></label>" +
        '<div class="gos-broker-stats">' +
        card("New received", sum(shown, "newReceived"), "First assignment to this broker") +
        card("Other received", sum(shown, "otherReceived"), "Passed on because someone did not Accept") +
        card("Accepted", sum(shown, "accepted"), "This broker clicked Accept") +
        card("New without Accept", sum(shown, "newNotAccepted"), "New that is still waiting or was passed on") +
        "</div>" +
        table;
      var select = document.getElementById("gos-broker-stat-filter");
      if (select) {
        select.value = selected;
        select.addEventListener("change", function () {
          selected = select.value || "";
          paint();
        });
      }
      body.querySelectorAll("tr[data-ship]").forEach(function (tr) {
        tr.addEventListener("click", function () {
          var id = tr.getAttribute("data-ship");
          if (id && crm.openShipmentCard) crm.openShipmentCard(document, id);
        });
      });
    }
    paint();
  },
};

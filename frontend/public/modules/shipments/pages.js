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
    var tab =
      subPageId === "other"
        ? "other"
        : subPageId === "accepted"
          ? "accepted"
          : subPageId === "accepted-another"
            ? "accepted-another"
            : subPageId === "by-broker"
              ? "by-broker"
              : subPageId === "new"
                ? "new"
                : isTeamLead
                  ? "mine"
                  : "new";

    root.innerHTML =
      '<div class="gos-module-layout">' +
      '<nav class="gos-subnav">' +
      (isTeamLead
        ? '<button type="button" class="gos-subnav-item' +
          (tab === "mine" ? " is-active" : "") +
          '" data-subpage="mine">New Shipment</button>'
        : "") +
      '<button type="button" class="gos-subnav-item' +
      (tab === "new" ? " is-active" : "") +
      '" data-subpage="new">' +
      (isTeamLead ? "Team New" : "New Shipment") +
      "</button>" +
      '<button type="button" class="gos-subnav-item' +
      (tab === "other" ? " is-active" : "") +
      '" data-subpage="other">Other Shipment</button>' +
      '<button type="button" class="gos-subnav-item' +
      (tab === "accepted" ? " is-active" : "") +
      '" data-subpage="accepted">Accepted shipments</button>' +
      '<button type="button" class="gos-subnav-item' +
      (tab === "accepted-another" ? " is-active" : "") +
      '" data-subpage="accepted-another">Accepted to another company</button>' +
      (isTeamLead
        ? '<button type="button" class="gos-subnav-item' +
          (tab === "by-broker" ? " is-active" : "") +
          '" data-subpage="by-broker">By Broker</button>'
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
    var opts =
      tab === "accepted-another"
        ? { status: "ACCEPTED_ANOTHER_COMPANY", page: 1 }
        : tab === "mine"
          ? { assignmentKind: "new", page: 1, onlyMine: true }
          : { assignmentKind: tab, page: 1 };
    var brokerId = tab === "mine" ? me.userId || null : null;
    crm.renderShipments(body, root, brokerId, opts);
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

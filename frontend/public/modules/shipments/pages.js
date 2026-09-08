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

    var tab =
      subPageId === "other"
        ? "other"
        : subPageId === "accepted-another"
          ? "accepted-another"
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
      (tab === "accepted-another" ? " is-active" : "") +
      '" data-subpage="accepted-another">Accepted to another company</button>' +
      "</nav>" +
      '<div class="gos-module-body" id="shipments-module-body"></div>' +
      "</div>";
    var body = root.querySelector("#shipments-module-body");
    window.GreenOSCrmReloadBody = function () {
      /* Team Lead / ops Shipments list is manual — no push remount. */
    };
    var opts =
      tab === "accepted-another"
        ? { status: "ACCEPTED_ANOTHER_COMPANY", page: 1 }
        : { assignmentKind: tab, page: 1 };
    crm.renderShipments(body, root, null, opts);
  },
};

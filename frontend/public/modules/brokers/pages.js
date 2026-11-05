/**
 * Owner / Manager — every Broker and Team Lead personal account.
 * Open their shipments, transfer them, and open loads without broker step locks.
 */
window.GreenOSModules = window.GreenOSModules || {};
window.GreenOSModules.brokers = {
  render(root) {
    if (!root) return;
    var self = this;
    root.innerHTML =
      '<div class="gos-module-placeholder" data-module="brokers">' +
      '<div class="gos-module-body" id="brokers-body"><p class="gos-muted">Loading…</p></div>' +
      "</div>";
    this.renderList(root.querySelector("#brokers-body"), root);
  },

  async api(path, options) {
    var token = localStorage.getItem("gl_token") || "";
    var opts = options || {};
    var res = await fetch("/api/crm" + path, {
      method: opts.method || "GET",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: token ? "Bearer " + token : "",
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    return res.json().catch(function () {
      return { success: false, message: "Bad response" };
    });
  },

  esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  },

  async renderList(body, root) {
    var self = this;
    self._openId = null;
    if (!body) return;
    body.innerHTML = "<p class=\"gos-muted\">Loading staff…</p>";
    var data = await this.api("/brokers");
    if (!data.success) {
      body.innerHTML = "<p>" + this.esc(data.message || "Failed") + "</p>";
      return;
    }
    var rows = data.data || [];
    this._rows = rows;
    var esc = this.esc.bind(this);
    body.innerHTML =
      '<section class="gos-dash-hero"><h1>Brokers</h1>' +
      "<p>Every broker and every team lead personal account. Open one to see their shipments and loads, change them, and give a shipment to someone else.</p></section>" +
      '<div class="table-wrap"><table class="crm-table"><thead><tr>' +
      "<th>Name</th><th>Role</th><th>In Office</th><th>Shipments</th><th></th>" +
      "</tr></thead><tbody>" +
      (rows.length
        ? rows
            .map(function (b) {
              return (
                "<tr><td><strong>" +
                esc(b.name) +
                "</strong></td><td>" +
                esc(b.role || "Broker") +
                "</td><td>" +
                (b.inOffice ? "In Office" : "Out") +
                "</td><td>" +
                esc(b.currentShipments || 0) +
                '</td><td><button type="button" class="btn-primary" style="width:auto" data-open="' +
                esc(b.brokerId) +
                '">Open</button></td></tr>'
              );
            })
            .join("")
        : '<tr><td colspan="5">No broker or team lead accounts</td></tr>') +
      "</tbody></table></div>";
    body.querySelectorAll("[data-open]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        self.openPerson(root, btn.getAttribute("data-open"));
      });
    });
  },

  async openPerson(root, brokerId) {
    var rows = this._rows || [];
    var person = null;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].brokerId === brokerId) person = rows[i];
    }
    var desk = window.GreenOSModules.broker;
    if (!desk || typeof desk.render !== "function") {
      var body = root.querySelector("#brokers-body");
      if (body) body.innerHTML = "<p>Employee desk failed to load. Refresh the page.</p>";
      return;
    }
    desk._opsGiveOptions = "";
    desk.render(root, "shipments", {
      brokerId: brokerId,
      name: person ? person.name : "Employee",
      role: person ? person.role : "",
    });
  },
};

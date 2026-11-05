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
    var self = this;
    var body = root.querySelector("#brokers-body");
    if (!body || !brokerId) return;
    self._openId = brokerId;
    body.innerHTML = "<p class=\"gos-muted\">Loading account…</p>";
    var [personRes, staffRes] = await Promise.all([
      this.api("/brokers/" + encodeURIComponent(brokerId)),
      this.api("/brokers"),
    ]);
    if (!personRes.success) {
      body.innerHTML = "<p>" + this.esc(personRes.message || "Failed") + "</p>";
      return;
    }
    var d = personRes.data || {};
    var broker = d.broker || {};
    var shipments = d.shipments || [];
    var staff = (staffRes && staffRes.success && staffRes.data) || [];
    var esc = this.esc.bind(this);
    var options = staff
      .filter(function (s) {
        return s.brokerId && s.brokerId !== brokerId;
      })
      .map(function (s) {
        return (
          '<option value="' +
          esc(s.brokerId) +
          '">' +
          esc(s.name) +
          (s.role ? " · " + esc(s.role) : "") +
          "</option>"
        );
      })
      .join("");
    body.innerHTML =
      '<section class="gos-dash-hero">' +
      '<button type="button" class="btn-secondary" id="brokers-back" style="width:auto">← All brokers</button>' +
      "<h1>" +
      esc(broker.name || "Account") +
      "</h1>" +
      "<p>" +
      esc(broker.role || "") +
      (broker.teamLeadName ? " · Team lead " + esc(broker.teamLeadName) : "") +
      " — " +
      shipments.length +
      " shipment(s). You can edit loads and move them to the next step without broker locks.</p></section>" +
      (shipments.length
        ? '<div class="table-wrap"><table class="crm-table"><thead><tr>' +
          "<th>Shipment</th><th>Lane</th><th>Status</th><th>Give to</th><th></th></tr></thead><tbody>" +
          shipments
            .map(function (sh) {
              return (
                "<tr><td><strong>" +
                esc(sh.shipmentTitle || sh.greenOsShipmentId || "Shipment") +
                "</strong>" +
                (sh.loadNumber
                  ? '<div class="gos-muted">' + esc(sh.loadNumber) + "</div>"
                  : "") +
                "</td><td>" +
                esc(sh.pickup || "—") +
                " → " +
                esc(sh.delivery || "—") +
                "</td><td>" +
                esc(sh.statusLabel || sh.status || "—") +
                '</td><td><select data-give="' +
                esc(sh.shipmentLeadId) +
                '"><option value="">Choose…</option>' +
                options +
                "</select></td><td>" +
                '<button type="button" class="btn-secondary" style="width:auto" data-transfer="' +
                esc(sh.shipmentLeadId) +
                '">Transfer</button> ' +
                '<button type="button" class="btn-primary" style="width:auto" data-load="' +
                esc(sh.shipmentLeadId) +
                '">Open load</button></td></tr>'
              );
            })
            .join("") +
          "</tbody></table></div>"
        : '<p class="gos-muted">No shipments on this account.</p>');
    body.querySelector("#brokers-back")?.addEventListener("click", function () {
      self.renderList(body, root);
    });
    body.querySelectorAll("[data-transfer]").forEach(function (btn) {
      btn.addEventListener("click", async function () {
        var id = btn.getAttribute("data-transfer");
        var sel = body.querySelector('[data-give="' + id + '"]');
        var toUserId = sel ? sel.value : "";
        if (!toUserId) {
          alert("Choose who should receive this shipment");
          return;
        }
        btn.disabled = true;
        var result = await self.api("/shipments/" + encodeURIComponent(id) + "/reassign", {
          method: "POST",
          body: { toUserId: toUserId },
        });
        btn.disabled = false;
        if (!result.success) {
          alert(result.message || "Could not transfer");
          return;
        }
        self.openPerson(root, brokerId);
      });
    });
    body.querySelectorAll("[data-load]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var id = btn.getAttribute("data-load");
        var nav = window.GreenOSShell || window.GreenOS;
        if (nav && typeof nav.navigate === "function") {
          nav.navigate("loads", "active-loads", { detail: { type: "load", id: id } });
        }
      });
    });
  },
};

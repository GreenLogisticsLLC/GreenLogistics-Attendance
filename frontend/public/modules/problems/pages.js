/**
 * Problems — Customer Respond with no Broker Answer after 10 minutes.
 * Owner / Manager / Team Lead / Admin: archive list + monthly broker miss stats.
 */
window.GreenOSModules = window.GreenOSModules || {};
window.GreenOSModules.problems = {
  _timer: null,

  stopAutoRefresh() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  },

  async api(path) {
    var token = localStorage.getItem("gl_token");
    var res = await fetch("/api/crm" + path, {
      headers: {
        "Content-Type": "application/json",
        Authorization: token ? "Bearer " + token : "",
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

  monthLabel(year, month) {
    try {
      return new Date(Date.UTC(year, month - 1, 1)).toLocaleString(undefined, {
        month: "long",
        year: "numeric",
        timeZone: "UTC",
      });
    } catch {
      return year + "-" + String(month).padStart(2, "0");
    }
  },

  render(root) {
    if (!root) return;
    var self = this;
    this.stopAutoRefresh();

    root.innerHTML =
      '<div class="gos-module-layout problems-root">' +
      '<div class="gos-module-body" id="problems-body">' +
      "<p>Loading Problems…</p>" +
      "</div>" +
      "</div>";

    var body = root.querySelector("#problems-body");
    this.paint(body);
    this._timer = setInterval(function () {
      if (!document.body.contains(body)) {
        self.stopAutoRefresh();
        return;
      }
      self.paint(body, true);
    }, 45000);
  },

  async paint(body, soft) {
    if (!body) return;
    var self = this;
    try {
      var now = new Date();
      var year = now.getFullYear();
      var month = now.getMonth() + 1;
      var qs = "?year=" + year + "&month=" + month;
      var [listRes, statsRes] = await Promise.all([
        this.api("/problems"),
        this.api("/problems/monthly-stats" + qs),
      ]);
      if (!listRes.success) {
        if (!soft) {
          body.innerHTML =
            '<p class="gos-muted">' +
            this.esc(listRes.message || "Could not load problems") +
            "</p>";
        }
        return;
      }

      var items = (listRes.data && listRes.data.items) || [];
      var stats = (statsRes.success && statsRes.data) || {
        year: year,
        month: month,
        totalProblems: 0,
        teamLeadReminders: 0,
        brokers: [],
      };
      var scope = (listRes.data && listRes.data.scope) || "company";

      var brokerRows =
        (stats.brokers || [])
          .map(function (b) {
            return (
              "<tr>" +
              "<td>" +
              self.esc(b.brokerName) +
              "</td>" +
              '<td style="text-align:right">' +
              Number(b.missCount || 0) +
              "</td>" +
              "</tr>"
            );
          })
          .join("") ||
        '<tr><td colspan="2" class="gos-muted">No misses this month</td></tr>';

      var archiveRows =
        items
          .map(function (p) {
            var sid = p.greenOsShipmentId || (p.shipmentLeadId || "").slice(0, 8);
            var href = "#/shipments/" + encodeURIComponent(p.shipmentLeadId);
            return (
              "<tr>" +
              '<td><a href="' +
              href +
              '"># ' +
              self.esc(sid) +
              "</a></td>" +
              "<td>" +
              self.esc(p.shipmentTitle || "—") +
              "</td>" +
              "<td>" +
              self.esc(p.brokerName) +
              "</td>" +
              "<td>" +
              self.esc(p.teamLeadName || "—") +
              "</td>" +
              "<td>" +
              self.fmtDate(p.customerRespondAt) +
              "</td>" +
              "<td>" +
              self.fmtDate(p.detectedAt) +
              "</td>" +
              "<td>" +
              (p.notifiedTeamLead ? "Yes" : "No") +
              "</td>" +
              "</tr>"
            );
          })
          .join("") ||
        '<tr><td colspan="7" class="gos-muted">No archived problems yet</td></tr>';

      body.innerHTML =
        '<section class="gos-dash-hero" style="margin-bottom:1.25rem">' +
        "<h1>Problems</h1>" +
        '<p class="gos-muted">Customer Respond with no Broker Answer after 10 minutes. ' +
        "Scope: <strong>" +
        self.esc(scope) +
        "</strong>. Team Lead is notified once per shipment episode.</p>" +
        "</section>" +
        '<section style="margin-bottom:1.5rem">' +
        "<h2>This month — " +
        self.esc(self.monthLabel(stats.year, stats.month)) +
        "</h2>" +
        '<div style="display:flex;flex-wrap:wrap;gap:1.25rem;margin:0.75rem 0 1rem">' +
        '<div><div class="gos-muted">Missed answers</div><div style="font-size:1.5rem;font-weight:600">' +
        Number(stats.totalProblems || 0) +
        "</div></div>" +
        '<div><div class="gos-muted">Reminders to Team Lead</div><div style="font-size:1.5rem;font-weight:600">' +
        Number(stats.teamLeadReminders || 0) +
        "</div></div>" +
        "</div>" +
        '<div style="overflow:auto">' +
        '<table class="gos-table" style="width:100%;min-width:280px">' +
        "<thead><tr><th>Broker</th><th style=\"text-align:right\">Times no answer</th></tr></thead>" +
        "<tbody>" +
        brokerRows +
        "</tbody></table></div>" +
        "</section>" +
        "<section>" +
        "<h2>Archive</h2>" +
        '<p class="gos-muted" style="margin-bottom:0.5rem">Shipment + broker when Customer Respond had no Broker Answer in time.</p>' +
        '<div style="overflow:auto">' +
        '<table class="gos-table" style="width:100%;min-width:720px">' +
        "<thead><tr>" +
        "<th>Shipment</th><th>Title</th><th>Broker</th><th>Team Lead</th>" +
        "<th>Customer Respond</th><th>Detected</th><th>TL notified</th>" +
        "</tr></thead>" +
        "<tbody>" +
        archiveRows +
        "</tbody></table></div>" +
        "</section>";
    } catch (err) {
      if (!soft) {
        body.innerHTML =
          '<p class="gos-muted">Failed to load Problems: ' +
          this.esc(err && err.message ? err.message : err) +
          "</p>";
      }
    }
  },
};

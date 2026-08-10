/**
 * Trucking — live trucks (CarrierView GPS + In Road loads).
 * Brokers see only their assigned loads.
 */
window.GreenOSModules = window.GreenOSModules || {};
window.GreenOSModules.trucking = {
  _timer: null,

  stopTimer() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  },

  esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  },

  async api(path) {
    var token = localStorage.getItem("gl_token") || "";
    var res = await fetch("/api/crm" + path, {
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + token,
      },
    });
    return res.json();
  },

  render(root) {
    if (!root) return;
    var self = this;
    this.stopTimer();
    if (window.GreenOS) {
      window.GreenOS.currentModule = "trucking";
      window.GreenOS.currentSub = null;
    }
    root.innerHTML =
      '<div class="gos-module-placeholder" data-module="trucking">' +
      '<section class="gos-dash-hero">' +
      "<h1>Trucking</h1>" +
      "<p>Live trucks on your loads — GPS online first, then In Road without tracking.</p>" +
      "</section>" +
      '<p class="gos-muted" id="trucking-sync">Loading…</p>' +
      '<div class="table-wrap"><table class="crm-table"><thead><tr>' +
      "<th>Online</th><th>Truck</th><th>Driver</th><th>Load</th><th>Lane</th><th>Status</th><th>Location</th><th>Updated</th><th></th>" +
      '</tr></thead><tbody id="trucking-body"><tr><td colspan="9">Loading…</td></tr></tbody></table></div>' +
      "</div>";

    async function paint() {
      var tbody = document.getElementById("trucking-body");
      var sync = document.getElementById("trucking-sync");
      if (!tbody) return;
      try {
        var data = await self.api("/trucking");
        if (!data.success) {
          if (sync) sync.textContent = data.message || "Failed";
          return;
        }
        var payload = data.data || {};
        var rows = payload.items || [];
        if (sync) {
          sync.textContent =
            (payload.onlineCount || 0) +
            " online · " +
            (payload.count || 0) +
            " total · updated " +
            new Date().toLocaleTimeString() +
            " (auto every 20s)";
        }
        if (!rows.length) {
          tbody.innerHTML =
            '<tr><td colspan="9">No trucks in trucking yet. Start CarrierView on a Load → Tracking, or mark a load In Road with truck #.</td></tr>';
          return;
        }
        var esc = self.esc.bind(self);
        tbody.innerHTML = rows
          .map(function (r) {
            var mapBtn = "";
            if (r.latitude != null && r.longitude != null) {
              var mapUrl =
                "https://www.openstreetmap.org/?mlat=" +
                encodeURIComponent(r.latitude) +
                "&mlon=" +
                encodeURIComponent(r.longitude) +
                "#map=11/" +
                encodeURIComponent(r.latitude) +
                "/" +
                encodeURIComponent(r.longitude);
              mapBtn =
                '<a class="btn-secondary" style="width:auto;padding:0.25rem 0.5rem" href="' +
                esc(mapUrl) +
                '" target="_blank" rel="noopener">Map</a>';
            }
            var openBtn =
              '<button type="button" class="btn-secondary trucking-open" style="width:auto;padding:0.25rem 0.5rem" data-id="' +
              esc(r.shipmentLeadId) +
              '">Open</button>';
            return (
              "<tr>" +
              "<td>" +
              (r.online
                ? '<span class="load-status-pill" style="background:#1a5c3a">ONLINE</span>'
                : '<span class="gos-muted">offline</span>') +
              "</td>" +
              "<td><strong>" +
              esc(r.truck) +
              "</strong><br><small class="gos-muted">" +
              esc(r.carrier) +
              "</small></td>" +
              "<td>" +
              esc(r.driver) +
              "<br><small class="gos-muted">" +
              esc(r.driverPhone) +
              "</small></td>" +
              "<td><strong>" +
              esc(r.loadNumber || r.greenOsShipmentId || "—") +
              "</strong></td>" +
              "<td>" +
              esc(r.pickup) +
              " → " +
              esc(r.delivery) +
              "</td>" +
              "<td>" +
              esc(r.status) +
              (r.driverIsLate ? '<br><small style="color:#f59e0b">LATE</small>' : "") +
              "</td>" +
              "<td>" +
              esc(r.address || (r.online ? "—" : "No GPS yet")) +
              (r.movementType ? "<br><small class=\"gos-muted\">" + esc(r.movementType) + "</small>" : "") +
              "</td>" +
              "<td>" +
              (r.lastPositionAt ? new Date(r.lastPositionAt).toLocaleString() : "—") +
              "</td>" +
              "<td style=\"white-space:nowrap\">" +
              mapBtn +
              " " +
              openBtn +
              "</td>" +
              "</tr>"
            );
          })
          .join("");

        tbody.querySelectorAll(".trucking-open").forEach(function (btn) {
          btn.addEventListener("click", function () {
            var id = btn.getAttribute("data-id");
            if (window.GreenOSModules.dispatch && window.GreenOSModules.dispatch.openLoad) {
              if (window.GreenOS && window.GreenOS.navigate) {
                window.GreenOS.navigate("loads", "active-loads");
              }
              setTimeout(function () {
                var host =
                  document.getElementById("load-tms-body") ||
                  document.querySelector(".gos-module-body");
                window.GreenOSModules.dispatch.openLoad(host, id, "tracking");
              }, 200);
            } else if (window.GreenOSModules.crm && window.GreenOSModules.crm.openShipmentCard) {
              window.GreenOSModules.crm.openShipmentCard(document, id);
            }
          });
        });
      } catch (err) {
        if (sync) sync.textContent = "Refresh failed" + (err && err.message ? ": " + err.message : "");
      }
    }

    paint();
    this._timer = setInterval(function () {
      if (document.hidden) return;
      if (!document.getElementById("trucking-body")) {
        self.stopTimer();
        return;
      }
      paint();
    }, 20000);
  },
};

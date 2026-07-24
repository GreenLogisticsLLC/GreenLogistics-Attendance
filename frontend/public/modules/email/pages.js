/**
 * Email Imports module — uShip Gmail → ShipmentLead dashboard.
 */
window.GreenOSModules = window.GreenOSModules || {};
window.GreenOSModules.email = {
  async render(root) {
    if (!root) return;
    root.innerHTML =
      '<section class="gos-dash-hero">' +
      "<h1>Email Imports</h1>" +
      "<p>uShip shipment emails → Shipment Leads → Assignment pipeline</p>" +
      "</section>" +
      '<div class="gos-module-placeholder" style="margin-bottom:1rem">' +
      '<div style="display:flex;gap:0.75rem;flex-wrap:wrap;align-items:center">' +
      '<a class="btn-primary" id="email-connect-gmail" href="/api/email/auth" style="width:auto;padding:0.65rem 1rem;text-decoration:none;display:inline-block">Connect Gmail</a>' +
      '<button type="button" class="btn-primary" id="email-check-now" style="width:auto;padding:0.65rem 1rem">Check Gmail Now</button>' +
      '<span id="email-import-status" class="sync-status"></span>' +
      "</div></div>" +
      '<div class="table-wrap">' +
      '<table id="email-shipments-table">' +
      "<thead><tr>" +
      "<th>Received</th><th>Title</th><th>Pickup</th><th>Delivery</th><th>Miles</th><th>Status</th><th>Imported By</th><th>Created</th>" +
      "</tr></thead>" +
      '<tbody id="email-shipments-body"><tr><td colspan="8">Loading…</td></tr></tbody>' +
      "</table></div>";

    const statusEl = root.querySelector("#email-import-status");
    const body = root.querySelector("#email-shipments-body");

    async function api(path, options) {
      const token = localStorage.getItem("gl_token");
      const res = await fetch("/api/email" + path, {
        ...options,
        headers: {
          "Content-Type": "application/json",
          Authorization: token ? "Bearer " + token : "",
          ...(options && options.headers),
        },
      });
      return res.json();
    }

    function fmtPlace(city, state, zip) {
      return [city, state, zip].filter(Boolean).join(", ") || "—";
    }

    function fmtDate(v) {
      if (!v) return "—";
      try {
        return new Date(v).toLocaleString();
      } catch {
        return String(v);
      }
    }

    async function loadShipments() {
      try {
        const data = await api("/shipments");
        if (!data.success) {
          body.innerHTML = '<tr><td colspan="8">' + (data.message || "Failed") + "</td></tr>";
          return;
        }
        const rows = data.data || [];
        if (!rows.length) {
          body.innerHTML = '<tr><td colspan="8">No shipments imported yet</td></tr>';
          return;
        }
        body.innerHTML = rows
          .map(function (s) {
            return (
              "<tr>" +
              "<td>" +
              fmtDate(s.receivedAt || s.createdAt) +
              "</td>" +
              "<td>" +
              (s.shipmentTitle || "—") +
              (s.viewUrl
                ? ' <a href="' + s.viewUrl + '" target="_blank" rel="noopener">view</a>'
                : "") +
              "</td>" +
              "<td>" +
              fmtPlace(s.pickupCity, s.pickupState, s.pickupZip) +
              "</td>" +
              "<td>" +
              fmtPlace(s.deliveryCity, s.deliveryState, s.deliveryZip) +
              "</td>" +
              "<td>" +
              (s.miles != null ? s.miles : "—") +
              "</td>" +
              "<td><strong>" +
              (s.status || "NEW") +
              "</strong></td>" +
              "<td>" +
              (s.source || "—") +
              "</td>" +
              "<td>" +
              fmtDate(s.createdAt) +
              "</td>" +
              "</tr>"
            );
          })
          .join("");
      } catch (err) {
        body.innerHTML = '<tr><td colspan="8">Connection error</td></tr>';
      }
    }

    root.querySelector("#email-check-now")?.addEventListener("click", async function () {
      statusEl.textContent = "Checking Gmail…";
      statusEl.style.color = "";
      try {
        const data = await api("/check", { method: "POST" });
        statusEl.textContent = data.message || (data.success ? "Done" : "Failed");
        statusEl.style.color = data.success ? "#22c55e" : "#ef4444";
        await loadShipments();
      } catch {
        statusEl.textContent = "Check failed";
        statusEl.style.color = "#ef4444";
      }
    });

    async function loadStatus() {
      try {
        const data = await api("/status");
        const d = data.data || {};
        if (d.gmailConfigured) {
          statusEl.textContent = "Gmail connected" + (d.gmailUser ? ": " + d.gmailUser : "");
          statusEl.style.color = "#22c55e";
          const btn = root.querySelector("#email-connect-gmail");
          if (btn) btn.textContent = "Reconnect Gmail";
        } else if (d.oauthClientConfigured) {
          statusEl.textContent = "Gmail not connected — use Connect Gmail";
          statusEl.style.color = "#eab308";
        } else {
          statusEl.textContent = "Set GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET on server";
          statusEl.style.color = "#ef4444";
        }
      } catch {
        /* ignore */
      }
    }

    await loadStatus();
    await loadShipments();
  },
};

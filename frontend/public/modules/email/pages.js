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
      "<p>uShip shipment emails → Shipment Leads → Assignment pipeline. Broker column shows who is working the load.</p>" +
      "</section>" +
      '<div class="gos-module-placeholder" style="margin-bottom:1rem">' +
      '<div style="display:flex;gap:0.75rem;flex-wrap:wrap;align-items:center">' +
      '<a class="btn-primary" id="email-connect-gmail" href="/api/email/auth" style="width:auto;padding:0.65rem 1rem;text-decoration:none;display:inline-block">Connect Company Gmail</a>' +
      '<button type="button" class="btn-primary" id="email-check-now" style="width:auto;padding:0.65rem 1rem">Check Gmail Now</button>' +
      '<span id="email-import-status" class="sync-status"></span>' +
      "</div></div>" +
      '<div class="table-wrap">' +
      '<table id="email-shipments-table" class="email-lots-table">' +
      "<thead><tr>" +
      "<th>#</th><th>Received</th><th>Title</th><th>Pickup</th><th>Delivery</th><th>Miles</th><th>Status</th><th>Broker</th><th>Imported By</th><th>Created</th>" +
      "</tr></thead>" +
      '<tbody id="email-shipments-body"><tr><td colspan="10">Loading…</td></tr></tbody>' +
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

    function esc(s) {
      return String(s == null ? "" : s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
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

    /** Operational day key: 17:00 through 16:59 next day (local browser timezone). */
    function operationalDayKey(v) {
      if (!v) return "";
      var d = new Date(v);
      if (isNaN(d.getTime())) return "";
      d.setHours(d.getHours() - 17);
      return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate();
    }

    function statusLabel(status) {
      var labels = {
        ASSIGNED: "Assigned — awaiting Accept",
        AWAITING_ACCEPTANCE: "Assigned — awaiting Accept",
        AGENT_OPEN: "Opened — awaiting Accept",
        WORKING: "Agent Working",
        UNASSIGNED: "Unassigned (waiting for check-in)",
        NEW: "New",
      };
      return labels[status] || status || "NEW";
    }

    async function loadShipments() {
      try {
        body.innerHTML = '<tr><td colspan="10">Loading…</td></tr>';
        const data = await api("/shipments");
        if (!data.success) {
          body.innerHTML = '<tr><td colspan="10">' + esc(data.message || "Failed") + "</td></tr>";
          return;
        }
        const rows = data.data || [];
        if (!rows.length) {
          body.innerHTML = '<tr><td colspan="10">No shipments imported yet</td></tr>';
          return;
        }
        body.innerHTML = rows
          .map(function (s, index) {
            var when = s.receivedAt || s.createdAt;
            var key = operationalDayKey(when);
            var prevKey =
              index > 0
                ? operationalDayKey(rows[index - 1].receivedAt || rows[index - 1].createdAt)
                : null;
            var isDayStart = index === 0 || (key && key !== prevKey);
            var broker =
              s.brokerName ||
              (s.assignedBrokerId ? "—" : "Unassigned");
            return (
              '<tr class="' +
              (isDayStart ? "lot-day-start" : "") +
              '" data-shipment-id="' +
              esc(s.shipmentLeadId) +
              '">' +
              '<td class="lot-num">' +
              (index + 1) +
              (isDayStart
                ? '<span class="lot-day-badge" title="Operational day: 17:00–16:59">17:00–16:59</span>'
                : "") +
              "</td>" +
              "<td>" +
              fmtDate(when) +
              "</td>" +
              "<td>" +
              esc(s.shipmentTitle || "—") +
              (s.viewUrl
                ? ' <a href="' +
                  esc(s.viewUrl) +
                  '" target="_blank" rel="noopener">Open in uShip</a>'
                : "") +
              "</td>" +
              "<td>" +
              esc(fmtPlace(s.pickupCity, s.pickupState, s.pickupZip)) +
              "</td>" +
              "<td>" +
              esc(fmtPlace(s.deliveryCity, s.deliveryState, s.deliveryZip)) +
              "</td>" +
              "<td>" +
              (s.miles != null ? s.miles : "—") +
              "</td>" +
              "<td><strong>" +
              esc(statusLabel(s.status)) +
              "</strong></td>" +
              '<td class="email-broker-cell"><strong style="color:#34d399">' +
              esc(broker) +
              "</strong></td>" +
              "<td>" +
              esc(s.source || "—") +
              "</td>" +
              "<td>" +
              fmtDate(s.createdAt) +
              "</td>" +
              "</tr>"
            );
          })
          .join("");
      } catch (err) {
        body.innerHTML =
          '<tr><td colspan="10">Connection error — server may be restarting. Reload in a moment.</td></tr>';
      }
    }

    // Keep Broker column in sync when assignment / reassignment events arrive
    window.GreenOSEmailReload = loadShipments;

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
          statusEl.textContent = "Gmail import" + (d.gmailUser ? ": " + d.gmailUser : "");
          statusEl.style.color = "#22c55e";
          const btn = root.querySelector("#email-connect-gmail");
          if (btn) btn.textContent = "Reconnect Gmail";
        } else if (d.oauthClientConfigured) {
          statusEl.textContent = "Gmail not connected — use Connect Gmail (uShip import inbox)";
          statusEl.style.color = "#eab308";
        } else {
          statusEl.textContent = "Set GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET on server";
          statusEl.style.color = "#ef4444";
        }
        if (d.mailRolesSeparated === false) {
          statusEl.textContent +=
            " ⚠ GMAIL_USER and SMTP_USER are the same — split import vs outbound mailboxes";
          statusEl.style.color = "#eab308";
        }
      } catch {
        /* ignore */
      }
    }

    // Gmail status must never delay the shipment table.
    void loadStatus();
    await loadShipments();
  },
};

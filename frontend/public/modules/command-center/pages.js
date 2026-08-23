(function () {
  "use strict";

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function token() {
    return localStorage.getItem("gl_token") || "";
  }

  async function request(path, options) {
    var response = await fetch(path, Object.assign({}, options || {}, {
      headers: Object.assign({
        Authorization: token() ? "Bearer " + token() : "",
        "Content-Type": "application/json",
      }, (options && options.headers) || {}),
    }));
    var json = await response.json();
    if (!response.ok || !json.success) throw new Error(json.message || "Request failed");
    return json.data;
  }

  function entityLink(item) {
    if (item.entityType === "carrier") {
      return "?module=carriers&carrierId=" + encodeURIComponent(item.entityId);
    }
    if (item.entityType === "shipment") {
      return "?module=dispatch&shipmentId=" + encodeURIComponent(item.entityId);
    }
    return "";
  }

  window.GreenOSModules = window.GreenOSModules || {};
  window.GreenOSModules["command-center"] = {
    render: function (root) {
      if (!root) return;
      root.innerHTML =
        "<section class='gos-module-body' data-command-center>" +
        "<div style='display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap'>" +
        "<div><h2 style='margin-bottom:.25rem'>AI Command Center</h2><div class='gos-muted'>Computed from ACL-scoped GreenOS operational data</div></div>" +
        "<button class='gos-btn' type='button' data-cc-refresh>Refresh</button></div>" +
        "<div data-cc-counts style='display:grid;grid-template-columns:repeat(5,minmax(90px,1fr));gap:.75rem;margin:1rem 0'></div>" +
        "<div style='display:flex;gap:.75rem;flex-wrap:wrap;margin-bottom:1rem'>" +
        "<select data-cc-priority class='gos-input'><option value=''>All priorities</option><option>CRITICAL</option><option>HIGH</option><option>MEDIUM</option><option>LOW</option><option>INFO</option></select>" +
        "<select data-cc-category class='gos-input'><option value=''>All categories</option><option>SHIPMENT</option><option>CARRIER</option><option>DOCUMENT</option><option>COMMUNICATION</option><option>COMPLIANCE</option><option>FOLLOW_UP</option><option>MARKET</option><option>INTERNAL_REVIEW</option></select>" +
        "</div><div data-cc-status class='gos-muted'>Loading…</div><div data-cc-items></div></section>";
      var self = this;
      root.querySelector("[data-cc-refresh]").addEventListener("click", function () { self.load(root); });
      root.querySelector("[data-cc-priority]").addEventListener("change", function () { self.load(root); });
      root.querySelector("[data-cc-category]").addEventListener("change", function () { self.load(root); });
      this.load(root);
    },

    load: async function (root) {
      var status = root.querySelector("[data-cc-status]");
      var list = root.querySelector("[data-cc-items]");
      var priority = root.querySelector("[data-cc-priority]").value;
      var category = root.querySelector("[data-cc-category]").value;
      status.textContent = "Loading…";
      list.innerHTML = "";
      try {
        var params = new URLSearchParams({ limit: "50" });
        if (priority) params.set("priority", priority);
        if (category) params.set("category", category);
        var data = await request("/api/ai/command-center?" + params.toString());
        var counts = data.counts || {};
        root.querySelector("[data-cc-counts]").innerHTML = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"].map(function (p) {
          return "<div class='gos-card' style='padding:.75rem'><div class='gos-muted' style='font-size:.75rem'>" + p + "</div><strong style='font-size:1.5rem'>" + Number(counts[p] || 0) + "</strong></div>";
        }).join("");
        status.textContent = data.incomplete && data.incomplete.length
          ? "Some sources were unavailable; available results are shown."
          : "";
        if (!data.items || !data.items.length) {
          list.innerHTML = "<div class='gos-card' style='padding:1rem'>Nothing requiring attention was found.</div>";
          return;
        }
        list.innerHTML = data.items.map(function (item) {
          var action = item.action;
          var link = entityLink(item);
          return "<article class='gos-card' style='padding:1rem;margin-bottom:.75rem;border-left:4px solid " +
            (item.priority === "CRITICAL" ? "#dc2626" : item.priority === "HIGH" ? "#ea580c" : "#64748b") + "'>" +
            "<div style='display:flex;justify-content:space-between;gap:1rem'><strong>[" + esc(item.priority) + "] " + esc(item.title) + "</strong><span class='gos-muted'>" + esc(item.category) + "</span></div>" +
            "<div style='margin:.4rem 0'>" + esc(item.summary) + "</div><div class='gos-muted' style='font-size:.85rem'>" + esc(item.reason) + "</div>" +
            "<div style='display:flex;gap:.5rem;align-items:center;margin-top:.75rem;flex-wrap:wrap'>" +
            (link ? "<a class='gos-btn gos-btn-sm gos-btn-ghost' href='" + esc(link) + "'>Open record</a>" : "") +
            (action && action.status === "PENDING_CONFIRMATION"
              ? "<button class='gos-btn gos-btn-sm' data-cc-confirm='" + esc(action.actionId) + "'>Review &amp; Confirm</button><button class='gos-btn gos-btn-sm gos-btn-ghost' data-cc-cancel='" + esc(action.actionId) + "'>Cancel</button>"
              : "<span class='gos-muted'>" + esc(item.nextBestAction) + "</span>") +
            "</div></article>";
        }).join("");
        var self = this;
        list.querySelectorAll("[data-cc-confirm]").forEach(function (button) {
          button.addEventListener("click", async function () {
            if (!confirm("Confirm this proposed action? It will execute now.")) return;
            button.disabled = true;
            try {
              await request("/api/ai/actions/" + encodeURIComponent(button.getAttribute("data-cc-confirm")) + "/confirm", { method: "POST", body: "{}" });
              self.load(root);
            } catch (error) {
              alert(error.message || error);
              button.disabled = false;
            }
          });
        });
        list.querySelectorAll("[data-cc-cancel]").forEach(function (button) {
          button.addEventListener("click", async function () {
            button.disabled = true;
            try {
              await request("/api/ai/actions/" + encodeURIComponent(button.getAttribute("data-cc-cancel")) + "/cancel", { method: "POST", body: "{}" });
              self.load(root);
            } catch (error) {
              alert(error.message || error);
              button.disabled = false;
            }
          });
        });
      } catch (error) {
        status.textContent = error.message || String(error);
      }
    },
  };
})();

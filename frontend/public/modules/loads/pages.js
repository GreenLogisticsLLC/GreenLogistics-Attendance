/**
 * Loads — primary GreenOS TMS section (after Customer Accepted).
 * Reuses Dispatch Load Details UI; this is the dedicated nav entry.
 */
window.GreenOSModules = window.GreenOSModules || {};

(function () {
  var base = window.GreenOSModules.dispatch || {};

  window.GreenOSModules.loads = Object.assign({}, base, {
    children: [
      { id: "active-loads", title: "Active Loads" },
      { id: "completed-loads", title: "Completed Loads" },
    ],

    openById: function (shipmentLeadId, tab) {
      try {
        sessionStorage.setItem("gos_open_load_id", shipmentLeadId);
        sessionStorage.setItem("gos_viewing_load_id", shipmentLeadId);
        if (tab) sessionStorage.setItem("gos_open_load_tab", tab);
      } catch (e) {}
      this._loadId = shipmentLeadId;
      if (tab) this._tab = tab;
      var nav = window.GreenOSShell || window.GreenOS;
      var role =
        (nav && nav.role && nav.role()) ||
        (window.GreenOS && window.GreenOS.user && window.GreenOS.user.role) ||
        "";
      if (nav && typeof nav.navigate === "function") {
        if (role === "Broker") nav.navigate("broker", "loads");
        else nav.navigate("loads", "active-loads");
      }
    },

    render: function (root, subPageId) {
      if (!root) return;
      var self = this;
      var children = this.children || [];
      var active =
        children.find(function (c) {
          return c.id === subPageId;
        }) || children[0];

      var openId = null;
      var openTab = null;
      var viewingId = null;
      try {
        openId = sessionStorage.getItem("gos_open_load_id");
        openTab = sessionStorage.getItem("gos_open_load_tab");
        if (openId) sessionStorage.removeItem("gos_open_load_id");
      } catch (e) {}
      // Fresh "My Loads" opens the list; only keep details if already on screen.
      if (document.querySelector(".load-layout")) {
        viewingId = self._loadId || null;
        try {
          if (!viewingId) viewingId = sessionStorage.getItem("gos_viewing_load_id");
        } catch (e) {}
      } else {
        self._loadId = null;
      }

      var navHtml = children
        .map(function (c) {
          var isActive = active && c.id === active.id;
          return (
            '<button type="button" class="gos-subnav-item' +
            (isActive ? " is-active" : "") +
            '" data-subpage="' +
            c.id +
            '">' +
            c.title +
            "</button>"
          );
        })
        .join("");

      root.innerHTML =
        '<div class="gos-module-placeholder load-tms" data-module="loads">' +
        '<div class="load-module-hero">' +
        "<h2>Loads</h2>" +
        '<p class="gos-muted">Single Load is the center of GreenOS TMS — Rate Con, BOL, POD, invoices, tracking and money never stand alone.</p>' +
        '<p class="gos-muted" style="margin-top:0.35rem">After <strong>Customer Accepted</strong> → Create Load (auto GL#) → Assign Carrier → Rate Con → … → Closed.</p>' +
        "</div>" +
        '<nav class="gos-subnav" aria-label="Loads">' +
        navHtml +
        "</nav>" +
        '<div class="gos-module-body load-tms-body" id="load-tms-body"></div>' +
        "</div>";

      root.querySelectorAll("[data-subpage]").forEach(function (btn) {
        btn.addEventListener("click", function (ev) {
          ev.preventDefault();
          ev.stopPropagation();
          if (typeof self.clearOpenLoad === "function") self.clearOpenLoad();
          else self._loadId = null;
          self.render(root, btn.getAttribute("data-subpage"));
        });
      });

      var body = root.querySelector("#load-tms-body");
      if (!body) return;

      if (openId) {
        self.openLoad(body, openId, openTab || "general");
        return;
      }

      if (viewingId) {
        self.openLoad(body, viewingId, openTab || self._tab || "general");
        return;
      }

      self.renderList(body, active.id === "completed-loads" ? "completed" : "active");
    },
  });

  window.GreenOSOpenLoad = function (id, tab) {
    window.GreenOSModules.loads.openById(id, tab);
  };
})();

/**
 * Dispatch / Loads — Load-centric TMS UI.
 * Everything belongs to one Load (ShipmentLead with loadNumber).
 */
window.GreenOSModules = window.GreenOSModules || {};
window.GreenOSModules["dispatch"] = {
  children: [
    { id: "active-loads", title: "Active Loads" },
    { id: "completed-loads", title: "Completed Loads" },
    { id: "carriers", title: "Carriers" },
    { id: "available-trucks", title: "Available Trucks" },
    { id: "tracking", title: "Tracking" },
    { id: "documents", title: "Documents" },
  ],

  _tab: "general",
  _loadId: null,

  async api(path, opts) {
    var token = localStorage.getItem("gl_token") || "";
    var res = await fetch("/api/loads" + path, Object.assign({
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + token,
      },
    }, opts || {}));
    var json = await res.json().catch(function () { return {}; });
    if (!res.ok || json.success === false) {
      throw new Error(json.message || ("Request failed " + res.status));
    }
    return json.data;
  },

  esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  },

  money(n) {
    var v = Number(n);
    if (!Number.isFinite(v)) return "—";
    return "$" + v.toFixed(2);
  },

  render(root, subPageId) {
    if (!root) return;
    var self = this;
    var children = this.children || [];
    var active = children.find(function (c) { return c.id === subPageId; }) || children[0];
    var openId = null;
    var viewingId = self._loadId || null;
    try {
      openId = sessionStorage.getItem("gos_open_load_id");
      if (openId) sessionStorage.removeItem("gos_open_load_id");
      if (!viewingId) viewingId = sessionStorage.getItem("gos_viewing_load_id");
    } catch (e) {}

    var navHtml = children.map(function (c) {
      var isActive = active && c.id === active.id;
      return (
        '<button type="button" class="gos-subnav-item' + (isActive ? " is-active" : "") + '" data-subpage="' + c.id + '">' +
        c.title +
        "</button>"
      );
    }).join("");

    root.innerHTML =
      '<div class="gos-module-placeholder load-tms" data-module="dispatch">' +
      '  <nav class="gos-subnav" aria-label="Dispatch sections">' + navHtml + "</nav>" +
      '  <div class="gos-module-body load-tms-body" id="load-tms-body"></div>' +
      "</div>";

    root.querySelectorAll("[data-subpage]").forEach(function (btn) {
      btn.addEventListener("click", function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        self.clearOpenLoad();
        self.render(root, btn.getAttribute("data-subpage"));
      });
    });

    var body = root.querySelector("#load-tms-body");
    if (!body) return;

    if (openId) {
      self.openLoad(body, openId);
      return;
    }

    // Keep Load Details open across soft module refreshes.
    if (
      viewingId &&
      (active.id === "active-loads" || active.id === "completed-loads")
    ) {
      self.openLoad(body, viewingId, self._tab || "general");
      return;
    }

    if (active.id === "active-loads" || active.id === "completed-loads") {
      self.renderList(body, active.id === "completed-loads" ? "completed" : "active");
      return;
    }

    body.innerHTML =
      "<h2>Dispatch — " + self.esc(active.title) + "</h2>" +
      "<p class=\"gos-muted\">Placeholder — load documents, carriers, and GPS will attach to each Load.</p>";
  },

  async renderList(body, phase) {
    var self = this;
    body.innerHTML = "<p class=\"gos-muted\">Loading loads…</p>";
    try {
      var rows = await self.api("/?phase=" + encodeURIComponent(phase));
      if (!rows || !rows.length) {
        body.innerHTML =
          "<h2>" + (phase === "completed" ? "Completed Loads" : "Active Loads") + "</h2>" +
          "<p class=\"gos-muted\">No loads yet. Create a Load from an Accepted shipment — number is assigned automatically (GL100001…).</p>";
        return;
      }
      var html =
        "<h2>" + (phase === "completed" ? "Completed Loads" : "Active Loads") + "</h2>" +
        '<div class="load-table-wrap"><table class="load-table"><thead><tr>' +
        "<th>Load #</th><th>Shipment</th><th>Customer</th><th>Lane</th><th>Carrier</th><th>Status</th><th>Profit</th><th></th>" +
        "</tr></thead><tbody>";
      rows.forEach(function (r) {
        html +=
          "<tr>" +
          "<td><strong>" + self.esc(r.loadNumber) + "</strong></td>" +
          "<td>" + self.esc(r.shipmentNumber || "—") + "</td>" +
          "<td>" + self.esc(r.customerName || "—") + "</td>" +
          "<td>" + self.esc((r.pickup || "—") + " → " + (r.delivery || "—")) + "</td>" +
          "<td>" + self.esc(r.carrierName || "—") + "</td>" +
          "<td><span class=\"load-status-pill\">" + self.esc(r.statusLabel || r.status) + "</span></td>" +
          "<td>" + self.money(r.pricing && r.pricing.grossProfit) + "</td>" +
          '<td><button type="button" class="btn-secondary load-open-btn" data-id="' +
          self.esc(r.shipmentLeadId) +
          '">Open</button></td>' +
          "</tr>";
      });
      html += "</tbody></table></div>";
      body.innerHTML = html;
      body.querySelectorAll(".load-open-btn").forEach(function (btn) {
        btn.addEventListener("click", function () {
          self.openLoad(body, btn.getAttribute("data-id"));
        });
      });
    } catch (err) {
      body.innerHTML = '<p class="gos-error">' + self.esc(err.message || err) + "</p>";
    }
  },

  async openLoad(body, id, tab) {
    var self = this;
    self._loadId = id;
    self._tab = tab || self._tab || "general";
    try {
      sessionStorage.setItem("gos_viewing_load_id", id);
      if (self._tab) sessionStorage.setItem("gos_open_load_tab", self._tab);
    } catch (e) {}
    if (!body) {
      body = document.getElementById("load-tms-body");
    }
    if (!body) return;
    body.innerHTML = "<p class=\"gos-muted\">Loading Load Details…</p>";
    try {
      var data = await self.api("/" + encodeURIComponent(id));
      // Stale response if user navigated away / opened another load.
      if (self._loadId && self._loadId !== id) return;
      self.renderDetails(body, data);
    } catch (err) {
      body.innerHTML = '<p class="gos-error">' + self.esc(err.message || err) + "</p>";
    }
  },

  clearOpenLoad() {
    this._loadId = null;
    try {
      sessionStorage.removeItem("gos_viewing_load_id");
      sessionStorage.removeItem("gos_open_load_id");
      sessionStorage.removeItem("gos_open_load_tab");
    } catch (e) {}
  },

  /** While Load Details are open, block auto-refresh (return true = skip remount). */
  refreshOpenLoadIfAny() {
    var id = this._loadId;
    try {
      if (!id) id = sessionStorage.getItem("gos_viewing_load_id");
    } catch (e) {}
    if (!id && !document.querySelector(".load-layout")) return false;
    // Intentionally do not reload — editing must stay stable.
    return true;
  },

  renderDetails(body, data) {
    var self = this;
    var id = data.identity.shipmentLeadId;
    var tabs = [
      "general",
      "carrier",
      "pricing",
      "tracking",
      "documents",
      "timeline",
      "notes",
      "accounting",
      "communications",
    ];
    var tabLabels = {
      general: "General",
      carrier: "Carrier",
      pricing: "Pricing",
      tracking: "Tracking",
      documents: "Documents",
      timeline: "Timeline",
      notes: "Notes",
      accounting: "Accounting",
      communications: "Communications",
    };

    var tabNav = tabs.map(function (t) {
      return (
        '<button type="button" class="load-tab' +
        (self._tab === t ? " is-active" : "") +
        '" data-tab="' +
        t +
        '">' +
        tabLabels[t] +
        "</button>"
      );
    }).join("");

    var lifecycle = [
      "LOAD_CREATED",
      "CARRIER_ASSIGNED",
      "RATE_CON_GENERATED",
      "CARRIER_ACCEPTED",
      "PICKUP",
      "IN_TRANSIT",
      "DELIVERED",
      "POD_UPLOADED",
      "CUSTOMER_INVOICE",
      "CARRIER_PAYMENT",
      "CLOSED",
    ];
    var cur = String((data.identity && data.identity.status) || "").toUpperCase();
    var curIdx = lifecycle.indexOf(cur);
    var lifeHtml = lifecycle
      .map(function (st, i) {
        var cls = i < curIdx ? "is-done" : i === curIdx ? "is-active" : "";
        return '<li class="' + cls + '">' + self.esc(st.replace(/_/g, " ")) + "</li>";
      })
      .join("");

    var actions = (data.quickActions || [])
      .map(function (a) {
        return (
          '<button type="button" class="btn-secondary load-action-btn" data-action="' +
          self.esc(a.id) +
          '">' +
          self.esc(a.label) +
          "</button>"
        );
      })
      .join("");

    var timelineMini = (data.timeline || [])
      .slice()
      .reverse()
      .slice(0, 12)
      .map(function (e) {
        return (
          '<li><strong>' +
          self.esc(e.title) +
          "</strong><span>" +
          self.esc(new Date(e.createdAt).toLocaleString()) +
          "</span></li>"
        );
      })
      .join("");

    body.innerHTML =
      '<div class="load-layout">' +
      '<aside class="load-nav">' +
      '<button type="button" class="btn-secondary" id="load-back">← Loads</button>' +
      "<h3>" +
      self.esc(data.identity.loadNumber || "No Load #") +
      "</h3>" +
      "<p class=\"gos-muted\">" +
      self.esc(data.identity.shipmentNumber || "") +
      "</p>" +
      '<ol class="load-life-mini">' +
      lifeHtml +
      "</ol>" +
      '<div class="load-tabs">' +
      tabNav +
      "</div>" +
      "</aside>" +
      '<main class="load-main" id="load-main"></main>' +
      '<aside class="load-rail">' +
      "<h4>Status</h4>" +
      '<p class="load-status-pill">' +
      self.esc(data.identity.statusLabel || data.identity.status) +
      "</p>" +
      "<h4>Quick Actions</h4>" +
      '<div class="load-actions">' +
      actions +
      "</div>" +
      "<h4>Timeline</h4>" +
      '<ul class="load-timeline-mini">' +
      (timelineMini || "<li class=\"gos-muted\">No events yet</li>") +
      "</ul>" +
      "</aside>" +
      "</div>";

    body.querySelector("#load-back")?.addEventListener("click", function () {
      self.clearOpenLoad();
      self.renderList(body, "active");
    });

    body.querySelectorAll(".load-tab").forEach(function (btn) {
      btn.addEventListener("click", function () {
        self._tab = btn.getAttribute("data-tab");
        self.renderDetails(body, data);
      });
    });

    body.querySelectorAll(".load-action-btn").forEach(function (btn) {
      btn.addEventListener("click", async function () {
        var action = btn.getAttribute("data-action");
        // Assign Carrier = go fill Carrier tab (do not jump status without data).
        if (action === "assign_carrier") {
          self._tab = "carrier";
          self.renderDetails(body, data);
          setTimeout(function () {
            var input = document.getElementById("ld-carrier");
            if (input) {
              input.focus();
              input.scrollIntoView({ behavior: "smooth", block: "center" });
            }
          }, 50);
          return;
        }
        // Rate Con = open fillable form (auto + extras), then generate PDF.
        if (action === "generate_rate_con") {
          self._tab = "documents";
          self.renderDetails(body, data);
          setTimeout(function () {
            var mainEl = body.querySelector("#load-main");
            if (mainEl) self.showRateConWizard(mainEl, id, data, "GENERATED");
          }, 40);
          return;
        }
        try {
          btn.disabled = true;
          await self.api("/" + encodeURIComponent(id) + "/actions/" + encodeURIComponent(action), {
            method: "POST",
            body: JSON.stringify({}),
          });
          self.openLoad(body, id, self._tab);
        } catch (err) {
          alert(err.message || err);
          btn.disabled = false;
        }
      });
    });

    var main = body.querySelector("#load-main");
    self.renderTab(main, data, self._tab);
  },

  renderTab(main, data, tab) {
    var self = this;
    var g = data.general || {};
    var c = data.carrier || {};
    var p = data.pricing || {};
    var id = data.identity.shipmentLeadId;

    function field(label, value) {
      return (
        '<div class="load-field"><span>' +
        self.esc(label) +
        "</span><strong>" +
        self.esc(value == null || value === "" ? "—" : value) +
        "</strong></div>"
      );
    }

    function place(obj) {
      if (!obj) return "—";
      return [obj.city, obj.state, obj.zip].filter(Boolean).join(", ") || "—";
    }

    if (tab === "general") {
      main.innerHTML =
        "<h2>General</h2>" +
        '<div class="load-grid">' +
        field("Load Number", g.loadNumber) +
        field("Shipment Number", g.shipmentNumber) +
        field("Customer", g.customer) +
        field("Broker", g.broker && g.broker.name) +
        field("Dispatcher", g.dispatcher && g.dispatcher.name) +
        field("Status", g.statusLabel || g.status) +
        field("Reference Number", g.referenceNumber) +
        field("Pickup", place(g.pickup)) +
        field("Delivery", place(g.delivery)) +
        field("Equipment", g.equipment) +
        field("Commodity", g.commodity) +
        field("Weight", g.weight) +
        field("Pieces", g.pieces) +
        field("Miles", g.miles) +
        field("Created", g.createdAt ? new Date(g.createdAt).toLocaleString() : "—") +
        field("Last Updated", g.updatedAt ? new Date(g.updatedAt).toLocaleString() : "—") +
        "</div>" +
        '<div class="load-edit-panel">' +
        "<h3>Edit Load Details</h3>" +
        '<div class="load-form-grid">' +
        '<label>Reference <input id="ld-ref" value="' + self.esc(g.referenceNumber || "") + '"></label>' +
        '<label>Commodity <input id="ld-commodity" value="' + self.esc(g.commodity || "") + '"></label>' +
        '<label>Equipment <input id="ld-equipment" value="' + self.esc(g.equipment || "") + '"></label>' +
        '<label>Weight <input id="ld-weight" value="' + self.esc(g.weight || "") + '"></label>' +
        '<label>Pieces <input id="ld-pieces" type="number" value="' + self.esc(g.pieces == null ? "" : g.pieces) + '"></label>' +
        '<label>Miles <input id="ld-miles" type="number" value="' + self.esc(g.miles == null ? "" : g.miles) + '"></label>' +
        '<label class="full">Special Instructions <textarea id="ld-special">' + self.esc(g.specialInstructions || "") + "</textarea></label>" +
        "</div>" +
        '<button type="button" class="btn-primary" id="ld-save-general">Save</button>' +
        "</div>";
      main.querySelector("#ld-save-general")?.addEventListener("click", async function () {
        try {
          await self.api("/" + encodeURIComponent(id), {
            method: "PATCH",
            body: JSON.stringify({
              referenceNumber: main.querySelector("#ld-ref").value || null,
              commodity: main.querySelector("#ld-commodity").value || null,
              equipment: main.querySelector("#ld-equipment").value || null,
              weight: main.querySelector("#ld-weight").value || null,
              pieces: main.querySelector("#ld-pieces").value || null,
              miles: main.querySelector("#ld-miles").value || null,
              specialInstructions: main.querySelector("#ld-special").value || null,
            }),
          });
          self.openLoad(main.closest(".load-tms-body") || main.parentElement, id, "general");
        } catch (err) {
          alert(err.message || err);
        }
      });
      return;
    }

    if (tab === "carrier") {
      main.innerHTML =
        "<h2>Assign Carrier</h2>" +
        '<p class="gos-muted">Phase 2 — fill carrier details, then Save &amp; Assign to move the Load forward.</p>' +
        '<div class="load-grid">' +
        field("Carrier", c.carrierName) +
        field("MC", c.mc) +
        field("DOT", c.dot) +
        field("Insurance", c.insurance) +
        field("Carrier Status", c.carrierStatus) +
        field("Assigned Dispatcher", c.assignedDispatcher && c.assignedDispatcher.name) +
        field("Driver", c.driverName) +
        field("Truck", c.truckNumber) +
        field("Trailer", c.trailerNumber) +
        "</div>" +
        '<p class="gos-muted">Future: ' + self.esc((c.futureIntegrations || []).join(", ")) + "</p>" +
        '<div class="load-edit-panel" id="ld-carrier-form">' +
        "<h3>Register carrier on this Load</h3>" +
        '<div class="load-form-grid">' +
        '<label>Carrier name * <input id="ld-carrier" value="' + self.esc(c.carrierName || "") + '" placeholder="e.g. Swift Transport LLC"></label>' +
        '<label>MC <input id="ld-mc" value="' + self.esc(c.mc || "") + '" placeholder="MC123456"></label>' +
        '<label>DOT <input id="ld-dot" value="' + self.esc(c.dot || "") + '"></label>' +
        '<label>Insurance <input id="ld-ins" value="' + self.esc(c.insurance || "") + '"></label>' +
        '<label>Driver <input id="ld-driver" value="' + self.esc(c.driverName || "") + '"></label>' +
        '<label>Truck <input id="ld-truck" value="' + self.esc(c.truckNumber || "") + '"></label>' +
        '<label>Trailer <input id="ld-trailer" value="' + self.esc(c.trailerNumber || "") + '"></label>' +
        '<label>Carrier Status <input id="ld-cstatus" value="' + self.esc(c.carrierStatus || "Assigned") + '"></label>' +
        "</div>" +
        '<button type="button" class="btn-primary" id="ld-save-carrier">Save &amp; Assign Carrier</button>' +
        '<p class="gos-muted" style="margin-top:0.5rem">After save → status <strong>Carrier Assigned</strong>. Next: Generate Rate Confirmation.</p>' +
        "</div>";
      main.querySelector("#ld-save-carrier")?.addEventListener("click", async function () {
        var name = (main.querySelector("#ld-carrier").value || "").trim();
        if (!name) {
          alert("Enter Carrier name to assign.");
          main.querySelector("#ld-carrier")?.focus();
          return;
        }
        try {
          await self.api("/" + encodeURIComponent(id), {
            method: "PATCH",
            body: JSON.stringify({
              carrierName: name,
              carrierMc: main.querySelector("#ld-mc").value || null,
              carrierDot: main.querySelector("#ld-dot").value || null,
              carrierInsurance: main.querySelector("#ld-ins").value || null,
              driverName: main.querySelector("#ld-driver").value || null,
              truckNumber: main.querySelector("#ld-truck").value || null,
              trailerNumber: main.querySelector("#ld-trailer").value || null,
              carrierStatus: main.querySelector("#ld-cstatus").value || "Assigned",
              status: "CARRIER_ASSIGNED",
            }),
          });
          var host = document.querySelector("#load-tms-body");
          self.openLoad(host, id, "carrier");
        } catch (err) {
          alert(err.message || err);
        }
      });
      return;
    }

    if (tab === "pricing") {
      main.innerHTML =
        "<h2>Pricing</h2>" +
        '<p class="gos-muted">Profit and margin are calculated automatically — brokers never hand-calc.</p>' +
        '<div class="load-grid">' +
        field("Customer Rate", self.money(p.customerRate)) +
        field("Carrier Rate", self.money(p.carrierRate)) +
        field("Fuel", self.money(p.fuelSurcharge)) +
        field("Accessorials", self.money(p.accessorialCharges)) +
        field("Total Revenue", self.money(p.totalRevenue)) +
        field("Total Cost", self.money(p.totalCost)) +
        field("Gross Profit", self.money(p.grossProfit)) +
        field("Margin %", (p.marginPct != null ? p.marginPct + "%" : "—")) +
        "</div>" +
        '<div class="load-edit-panel">' +
        '<div class="load-form-grid">' +
        '<label>Customer Rate <input id="ld-cr" type="number" step="0.01" value="' + self.esc(p.customerRate || "") + '"></label>' +
        '<label>Carrier Rate <input id="ld-crr" type="number" step="0.01" value="' + self.esc(p.carrierRate || "") + '"></label>' +
        '<label>Fuel <input id="ld-fuel" type="number" step="0.01" value="' + self.esc(p.fuelSurcharge || "") + '"></label>' +
        '<label>Accessorials <input id="ld-acc" type="number" step="0.01" value="' + self.esc(p.accessorialCharges || "") + '"></label>' +
        "</div>" +
        '<button type="button" class="btn-primary" id="ld-save-pricing">Save Rates</button>' +
        "</div>";
      main.querySelector("#ld-save-pricing")?.addEventListener("click", async function () {
        try {
          await self.api("/" + encodeURIComponent(id), {
            method: "PATCH",
            body: JSON.stringify({
              customerRate: main.querySelector("#ld-cr").value || null,
              carrierRate: main.querySelector("#ld-crr").value || null,
              fuelSurcharge: main.querySelector("#ld-fuel").value || null,
              accessorialCharges: main.querySelector("#ld-acc").value || null,
            }),
          });
          self.openLoad(document.querySelector("#load-tms-body"), id, "pricing");
        } catch (err) {
          alert(err.message || err);
        }
      });
      return;
    }

    if (tab === "tracking") {
      var steps = ((data.tracking && data.tracking.steps) || [])
        .map(function (s) {
          return (
            '<li class="' +
            (s.done ? "is-done" : "") +
            (s.active ? " is-active" : "") +
            '">' +
            self.esc(s.title) +
            "</li>"
          );
        })
        .join("");
      main.innerHTML =
        "<h2>Tracking</h2>" +
        '<ol class="load-tracking">' +
        steps +
        "</ol>" +
        '<p class="gos-muted">GPS integrations (future) will update these steps on the Load.</p>';
      return;
    }

    if (tab === "documents") {
      self.renderDocumentsTab(main, data);
      return;
    }

    if (tab === "timeline") {
      var items = (data.timeline || [])
        .slice()
        .reverse()
        .map(function (e) {
          return (
            "<li><div><strong>" +
            self.esc(e.title) +
            "</strong><span>" +
            self.esc(e.eventType) +
            "</span></div><p>" +
            self.esc(e.message || "") +
            "</p><time>" +
            self.esc(new Date(e.createdAt).toLocaleString()) +
            "</time></li>"
          );
        })
        .join("");
      main.innerHTML =
        "<h2>Timeline</h2>" +
        '<p class="gos-muted">Automatic — never enter timeline rows manually.</p>' +
        '<ul class="load-timeline-full">' +
        (items || "<li>No events</li>") +
        "</ul>";
      return;
    }

    if (tab === "notes") {
      var n = data.notes || {};
      main.innerHTML =
        "<h2>Notes</h2>" +
        '<div class="load-form-grid">' +
        '<label class="full">Internal Notes <textarea id="ld-notes">' + self.esc(n.internal || "") + "</textarea></label>" +
        '<label class="full">Customer Notes <textarea id="ld-cnotes">' + self.esc(n.customer || "") + "</textarea></label>" +
        '<label class="full">Carrier Notes <textarea id="ld-carnotes">' + self.esc(n.carrier || "") + "</textarea></label>" +
        '<label class="full">AI Notes <textarea id="ld-ainotes" readonly>' + self.esc(n.ai || "") + "</textarea></label>" +
        "</div>" +
        '<button type="button" class="btn-primary" id="ld-save-notes">Save Notes</button>';
      main.querySelector("#ld-save-notes")?.addEventListener("click", async function () {
        try {
          await self.api("/" + encodeURIComponent(id), {
            method: "PATCH",
            body: JSON.stringify({
              notes: main.querySelector("#ld-notes").value || null,
              customerNotes: main.querySelector("#ld-cnotes").value || null,
              carrierNotes: main.querySelector("#ld-carnotes").value || null,
            }),
          });
          self.openLoad(document.querySelector("#load-tms-body"), id, "notes");
        } catch (err) {
          alert(err.message || err);
        }
      });
      return;
    }

    if (tab === "accounting") {
      var a = data.accounting || {};
      main.innerHTML =
        "<h2>Accounting</h2>" +
        '<div class="load-grid">' +
        field("Customer Invoice", a.customerInvoice) +
        field("Carrier Invoice", a.carrierInvoice) +
        field("Payment Status", a.paymentStatus) +
        field("Factoring", self.money(a.factoring)) +
        field("Broker Profit", self.money(a.brokerProfit)) +
        field("Company Profit", self.money(a.companyProfit)) +
        field("Margin", a.margin != null ? a.margin + "%" : "—") +
        field("Invoice Date", a.invoiceDate ? new Date(a.invoiceDate).toLocaleDateString() : "—") +
        field("Due Date", a.dueDate ? new Date(a.dueDate).toLocaleDateString() : "—") +
        field("Payment Date", a.paymentDate ? new Date(a.paymentDate).toLocaleDateString() : "—") +
        field("Outstanding Balance", self.money(a.outstandingBalance)) +
        "</div>";
      return;
    }

    if (tab === "communications") {
      var emails = ((data.communications && data.communications.emails) || [])
        .map(function (m) {
          return (
            "<li><strong>" +
            self.esc(m.subject) +
            "</strong><span>" +
            self.esc(m.fromAddress) +
            "</span><p>" +
            self.esc(m.snippet || "") +
            "</p></li>"
          );
        })
        .join("");
      main.innerHTML =
        "<h2>Communications</h2>" +
        "<h3>Emails (linked to this Load)</h3>" +
        '<ul class="load-comms">' +
        (emails || "<li class=\"gos-muted\">No linked emails yet</li>") +
        "</ul>" +
        '<p class="gos-muted">Future: RingCentral, Gmail send with PDF attach.</p>';
      return;
    }

    main.innerHTML = "<p>Unknown tab</p>";
  },

  async openPdf(url, inline) {
    var token = localStorage.getItem("gl_token") || "";
    var res = await fetch(url + (inline ? (url.indexOf("?") >= 0 ? "&" : "?") + "inline=1" : ""), {
      headers: { Authorization: "Bearer " + token },
    });
    if (!res.ok) throw new Error("Failed to open PDF");
    var blob = await res.blob();
    var obj = URL.createObjectURL(blob);
    if (inline) window.open(obj, "_blank");
    else {
      var a = document.createElement("a");
      a.href = obj;
      a.download = "document.pdf";
      a.click();
    }
  },

  renderDocumentsTab(main, data) {
    var self = this;
    var id = data.identity.shipmentLeadId;
    var docs = data.documents || [];
    var genTypes = [
      ["RATE_CONFIRMATION", "Generate Rate Confirmation"],
      ["BOL", "Generate BOL"],
      ["CUSTOMER_INVOICE", "Generate Invoice"],
      ["CARRIER_INVOICE", "Generate Carrier Invoice"],
      ["DISPATCH_SHEET", "Generate Dispatch Sheet"],
      ["LOAD_SUMMARY", "Generate Load Summary"],
      ["POD", "Generate POD"],
    ];

    var genBtns = genTypes
      .map(function (t) {
        return (
          '<button type="button" class="btn-secondary load-gen-doc" data-type="' +
          t[0] +
          '">' +
          t[1] +
          "</button>"
        );
      })
      .join("");

    var rows = docs
      .map(function (d) {
        var dl = d.fileUrl || "";
        return (
          '<tr data-doc="' +
          self.esc(d.documentId) +
          '" data-type="' +
          self.esc(d.docType) +
          '">' +
          "<td>" +
          self.esc(d.title) +
          "</td>" +
          "<td>v" +
          self.esc(d.version) +
          "</td>" +
          "<td>" +
          self.esc(d.changeReason) +
          "</td>" +
          "<td>" +
          self.esc(d.status) +
          "</td>" +
          "<td class=\"load-doc-actions\">" +
          (dl
            ? '<button type="button" class="btn-secondary load-preview-doc" data-url="' +
              self.esc(dl) +
              '">Preview</button>' +
              '<button type="button" class="btn-secondary load-dl-doc" data-url="' +
              self.esc(dl) +
              '">Download</button>'
            : "") +
          '<button type="button" class="btn-secondary load-edit-doc" data-type="' +
          self.esc(d.docType) +
          '">Edit</button>' +
          '<button type="button" class="btn-secondary load-replace-doc" data-type="' +
          self.esc(d.docType) +
          '">Replace</button>' +
          '<button type="button" class="btn-secondary load-print-doc" data-url="' +
          self.esc(dl || "") +
          '">Print</button>' +
          '<button type="button" class="btn-secondary load-hist-doc" data-type="' +
          self.esc(d.docType) +
          '">History</button>' +
          '<button type="button" class="btn-secondary load-sent-doc" data-id="' +
          self.esc(d.documentId) +
          '">Email / Sent</button>' +
          '<button type="button" class="btn-secondary load-arch-doc" data-id="' +
          self.esc(d.documentId) +
          '">Archive</button>' +
          "</td>" +
          "</tr>"
        );
      })
      .join("");

    main.innerHTML =
      "<h2>Documents</h2>" +
      '<p class="gos-muted">Every document belongs to this Load. Edits create a new version — never overwrite.</p>' +
      '<div class="load-actions">' +
      genBtns +
      "</div>" +
      '<div class="load-table-wrap"><table class="load-table"><thead><tr>' +
      "<th>Document</th><th>Ver</th><th>Change</th><th>Status</th><th>Actions</th>" +
      "</tr></thead><tbody>" +
      (rows || '<tr><td colspan="5" class="gos-muted">No documents yet</td></tr>') +
      "</tbody></table></div>" +
      '<div id="load-doc-editor" class="load-edit-panel hidden"></div>' +
      '<div id="load-doc-history" class="load-edit-panel hidden"></div>';

    main.querySelectorAll(".load-gen-doc").forEach(function (btn) {
      btn.addEventListener("click", async function () {
        var docType = btn.getAttribute("data-type");
        if (docType === "RATE_CONFIRMATION") {
          self.showRateConWizard(main, id, data, "GENERATED");
          return;
        }
        try {
          btn.disabled = true;
          var row = await self.api(
            "/" + encodeURIComponent(id) + "/documents/" + encodeURIComponent(docType) + "/generate",
            { method: "POST", body: JSON.stringify({ changeReason: "GENERATED" }) }
          );
          await self.openLoad(document.querySelector("#load-tms-body"), id, "documents");
          if (row && row.documentId) {
            try {
              await self.openPdf(
                "/api/loads/" + encodeURIComponent(id) + "/documents/" + encodeURIComponent(row.documentId) + "/download",
                true
              );
            } catch (e) {}
          }
        } catch (err) {
          alert(err.message || err);
          btn.disabled = false;
        }
      });
    });

    main.querySelectorAll(".load-preview-doc").forEach(function (btn) {
      btn.addEventListener("click", function () {
        self.openPdf(btn.getAttribute("data-url"), true).catch(function (err) {
          alert(err.message || err);
        });
      });
    });
    main.querySelectorAll(".load-dl-doc").forEach(function (btn) {
      btn.addEventListener("click", function () {
        self.openPdf(btn.getAttribute("data-url"), false).catch(function (err) {
          alert(err.message || err);
        });
      });
    });

    main.querySelectorAll(".load-edit-doc").forEach(function (btn) {
      btn.addEventListener("click", function () {
        self.showDocEditor(main, id, btn.getAttribute("data-type"), data);
      });
    });

    main.querySelectorAll(".load-replace-doc").forEach(function (btn) {
      btn.addEventListener("click", function () {
        self.showDocEditor(main, id, btn.getAttribute("data-type"), data);
        var reason = main.querySelector("#de-reason");
        if (reason) reason.value = "REPLACED";
      });
    });

    main.querySelectorAll(".load-print-doc").forEach(function (btn) {
      btn.addEventListener("click", async function () {
        var url = btn.getAttribute("data-url");
        if (!url) return alert("No PDF yet");
        try {
          var token = localStorage.getItem("gl_token") || "";
          var res = await fetch(url + (url.indexOf("?") >= 0 ? "&" : "?") + "inline=1", {
            headers: { Authorization: "Bearer " + token },
          });
          if (!res.ok) throw new Error("Failed to open PDF");
          var blob = await res.blob();
          var obj = URL.createObjectURL(blob);
          var w = window.open(obj, "_blank");
          if (w) {
            setTimeout(function () {
              try {
                w.print();
              } catch (e) {}
            }, 600);
          }
        } catch (err) {
          alert(err.message || err);
        }
      });
    });

    main.querySelectorAll(".load-hist-doc").forEach(function (btn) {
      btn.addEventListener("click", async function () {
        try {
          var hist = await self.api(
            "/" + encodeURIComponent(id) + "/documents/history/" + encodeURIComponent(btn.getAttribute("data-type"))
          );
          var box = main.querySelector("#load-doc-history");
          box.classList.remove("hidden");
          box.innerHTML =
            "<h3>Version History</h3><ul>" +
            (hist || [])
              .map(function (h) {
                return (
                  "<li><strong>" +
                  self.esc(h.title) +
                  "</strong> — " +
                  self.esc(h.changeReason) +
                  " · " +
                  self.esc(new Date(h.createdAt).toLocaleString()) +
                  (h.fileUrl
                    ? ' <a href="/api/loads/' +
                      encodeURIComponent(id) +
                      "/documents/" +
                      encodeURIComponent(h.documentId) +
                      '/download?inline=1" target="_blank">View</a>'
                    : "") +
                  "</li>"
                );
              })
              .join("") +
            "</ul>";
        } catch (err) {
          alert(err.message || err);
        }
      });
    });

    main.querySelectorAll(".load-sent-doc").forEach(function (btn) {
      btn.addEventListener("click", async function () {
        try {
          await self.api(
            "/" + encodeURIComponent(id) + "/documents/" + encodeURIComponent(btn.getAttribute("data-id")) + "/sent",
            { method: "POST", body: "{}" }
          );
          alert("Marked as sent. Email provider attach comes next.");
          self.openLoad(document.querySelector("#load-tms-body"), id, "documents");
        } catch (err) {
          alert(err.message || err);
        }
      });
    });

    main.querySelectorAll(".load-arch-doc").forEach(function (btn) {
      btn.addEventListener("click", async function () {
        if (!confirm("Archive this document version?")) return;
        try {
          await self.api(
            "/" + encodeURIComponent(id) + "/documents/" + encodeURIComponent(btn.getAttribute("data-id")) + "/archive",
            { method: "POST", body: "{}" }
          );
          self.openLoad(document.querySelector("#load-tms-body"), id, "documents");
        } catch (err) {
          alert(err.message || err);
        }
      });
    });
  },

  showDocEditor(main, id, docType, data) {
    if (docType === "RATE_CONFIRMATION") {
      this.showRateConWizard(main, id, data, "BROKER_EDITED");
      return;
    }
    var self = this;
    var g = data.general || {};
    var c = data.carrier || {};
    var p = data.pricing || {};
    var box = main.querySelector("#load-doc-editor");
    if (!box) return;
    box.classList.remove("hidden");
    box.innerHTML =
      "<h3>Edit " +
      self.esc(docType.replace(/_/g, " ")) +
      " (creates new version)</h3>" +
      '<div class="load-form-grid">' +
      '<label>Customer <input id="de-customer" value="' + self.esc(g.customer || "") + '"></label>' +
      '<label>Carrier <input id="de-carrier" value="' + self.esc(c.carrierName || "") + '"></label>' +
      '<label>Pickup <input id="de-pickup" value="' + self.esc([g.pickup && g.pickup.city, g.pickup && g.pickup.state].filter(Boolean).join(", ")) + '"></label>' +
      '<label>Delivery <input id="de-delivery" value="' + self.esc([g.delivery && g.delivery.city, g.delivery && g.delivery.state].filter(Boolean).join(", ")) + '"></label>' +
      '<label>Commodity <input id="de-commodity" value="' + self.esc(g.commodity || "") + '"></label>' +
      '<label>Weight <input id="de-weight" value="' + self.esc(g.weight || "") + '"></label>' +
      '<label>Equipment <input id="de-equipment" value="' + self.esc(g.equipment || "") + '"></label>' +
      '<label>Reference <input id="de-ref" value="' + self.esc(g.referenceNumber || "") + '"></label>' +
      '<label>Customer Rate <input id="de-cr" type="number" step="0.01" value="' + self.esc(p.customerRate || "") + '"></label>' +
      '<label>Carrier Rate <input id="de-crr" type="number" step="0.01" value="' + self.esc(p.carrierRate || "") + '"></label>' +
      '<label class="full">Terms <textarea id="de-terms">Payment per Green Logistics carrier agreement.</textarea></label>' +
      '<label class="full">Special Instructions <textarea id="de-special">' + self.esc(g.specialInstructions || "") + "</textarea></label>" +
      '<label>Change reason <select id="de-reason">' +
      '<option value="BROKER_EDITED">Broker Edited</option>' +
      '<option value="CUSTOMER_REQUESTED">Customer Requested Changes</option>' +
      '<option value="FINAL_SIGNED">Final Signed</option>' +
      '<option value="REPLACED">Replaced</option>' +
      "</select></label>" +
      "</div>" +
      '<button type="button" class="btn-primary" id="de-save">Save &amp; Regenerate PDF</button>';

    box.querySelector("#de-save")?.addEventListener("click", async function () {
      try {
        await self.api(
          "/" + encodeURIComponent(id) + "/documents/" + encodeURIComponent(docType) + "/edit",
          {
            method: "POST",
            body: JSON.stringify({
              changeReason: box.querySelector("#de-reason").value,
              content: {
                customerName: box.querySelector("#de-customer").value,
                carrierName: box.querySelector("#de-carrier").value,
                pickupAddress: box.querySelector("#de-pickup").value,
                deliveryAddress: box.querySelector("#de-delivery").value,
                commodity: box.querySelector("#de-commodity").value,
                weight: box.querySelector("#de-weight").value,
                equipment: box.querySelector("#de-equipment").value,
                referenceNumber: box.querySelector("#de-ref").value,
                customerRate: box.querySelector("#de-cr").value,
                carrierRate: box.querySelector("#de-crr").value,
                terms: box.querySelector("#de-terms").value,
                specialInstructions: box.querySelector("#de-special").value,
              },
            }),
          }
        );
        self.openLoad(document.querySelector("#load-tms-body"), id, "documents");
      } catch (err) {
        alert(err.message || err);
      }
    });
  },

  /**
   * Rate Confirmation wizard — auto-filled from Load, broker can add detail, then PDF.
   * Layout/fields mirror the current Green Logistics RC form.
   */
  showRateConWizard(main, id, data, changeReason) {
    var self = this;
    var g = data.general || {};
    var c = data.carrier || {};
    var p = data.pricing || {};
    var box = main.querySelector("#load-doc-editor");
    if (!box) {
      // Documents tab not mounted yet — ensure editor host exists.
      main.insertAdjacentHTML(
        "beforeend",
        '<div id="load-doc-editor" class="load-edit-panel"></div>'
      );
      box = main.querySelector("#load-doc-editor");
    }
    box.classList.remove("hidden");

    function place(obj) {
      if (!obj) return "";
      return [obj.city, obj.state, obj.zip].filter(Boolean).join(", ");
    }
    function dt(d) {
      if (!d) return "";
      try {
        return new Date(d).toLocaleDateString();
      } catch (e) {
        return "";
      }
    }
    function tm(d) {
      if (!d) return "";
      try {
        return new Date(d).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      } catch (e) {
        return "";
      }
    }

    var pickupSrc = (g.pickup && (g.pickup.opsAt || g.pickup.from)) || null;
    var deliverySrc = (g.delivery && (g.delivery.opsAt || g.delivery.from)) || null;
    var defaultTerms =
      "Payment of detention is determined on a load-by-load basis. Unauthorized charges will not be paid. Detention payment does not begin for at least 2 hours unless otherwise agreed to in writing. Each hour pays $25 after checking in, max is $250.\n\n" +
      "Layover starts to count if the total waiting time exceeds 12 hours after checking in. The standard rate applies for a total of $250.\n\n" +
      "Late delivery fee is $500 per each day. Deductions for missed appointments and non macropoint acceptance will apply. Fee is $200.\n\n" +
      "Truck Ordered Not Used pays $150. If the carrier picked up a partial load instead of the full load the deduction may apply. For the shipments with the rate less than $1000 TONU pays $100.\n\n" +
      "If the shipment got damaged/scratched or the carrier picked up the shipment in damaged condition without confirming, the customer have the right to apply charges even if the damage was not mentioned on the BOL.\n\n" +
      "This is a rate confirmation not a BOL. If you use this as BOL you may not be paid. Send the clear picture of POD after delivery within 24 hours. No pictures or dark images accepted.";

    box.innerHTML =
      "<h3>Generate Rate Confirmation</h3>" +
      '<p class="gos-muted">Fields auto-fill from this Load. Add contacts, times, rate and notes — then create the PDF (new version, never overwrite).</p>' +
      '<div class="load-form-grid">' +
      '<label>Load No <input id="rc-load" value="' + self.esc(g.loadNumber || "") + '" readonly></label>' +
      '<label>Shipment <input id="rc-ship" value="' + self.esc(g.shipmentNumber || "") + '" readonly></label>' +
      '<label>Confirmation date <input id="rc-date" value="' + self.esc(new Date().toLocaleDateString()) + '"></label>' +
      '<label>Broker <input id="rc-broker" value="' + self.esc((g.broker && g.broker.name) || "") + '"></label>' +
      '<label>Carrier * <input id="rc-carrier" value="' + self.esc(c.carrierName || "") + '"></label>' +
      '<label>MC# <input id="rc-mc" value="' + self.esc(c.mc || "") + '"></label>' +
      '<label>DOT# <input id="rc-dot" value="' + self.esc(c.dot || "") + '"></label>' +
      '<label>Carrier phone <input id="rc-cphone" value="" placeholder="(xxx) xxx-xxxx"></label>' +
      '<label>Equipment <input id="rc-equip" value="' + self.esc(g.equipment || "") + '"></label>' +
      '<label>Weight <input id="rc-weight" value="' + self.esc(g.weight || "") + '"></label>' +
      '<label>Commodity <input id="rc-commodity" value="' + self.esc(g.commodity || "") + '"></label>' +
      '<label>Flat Rate $USD * <input id="rc-rate" type="number" step="0.01" value="' + self.esc(p.carrierRate || "") + '"></label>' +
      '<label class="full">Origin (pickup address) <input id="rc-origin" value="' + self.esc(place(g.pickup)) + '"></label>' +
      '<label>Pickup date <input id="rc-pdate" value="' + self.esc(dt(pickupSrc)) + '"></label>' +
      '<label>Pickup time <input id="rc-ptime" value="' + self.esc(tm(pickupSrc)) + '"></label>' +
      '<label class="full">Pickup contact <input id="rc-pcontact" placeholder="Name / phone at shipper"></label>' +
      '<label class="full">Final destination <input id="rc-dest" value="' + self.esc(place(g.delivery)) + '"></label>' +
      '<label>Delivery date <input id="rc-ddate" value="' + self.esc(dt(deliverySrc)) + '"></label>' +
      '<label>Delivery time <input id="rc-dtime" value="' + self.esc(tm(deliverySrc)) + '"></label>' +
      '<label class="full">Delivery contact <input id="rc-dcontact" placeholder="Name / phone at consignee"></label>' +
      '<label>Driver name <input id="rc-driver" value="' + self.esc(c.driverName || "") + '"></label>' +
      '<label>Driver phone <input id="rc-dphone" value=""></label>' +
      '<label>Truck # <input id="rc-truck" value="' + self.esc(c.truckNumber || "") + '"></label>' +
      '<label>Trailer # <input id="rc-trailer" value="' + self.esc(c.trailerNumber || "") + '"></label>' +
      '<label class="full">Payment option <input id="rc-pay" value="" placeholder="QuickPay / Factoring / Net 30…"></label>' +
      '<label class="full">Delivery note <textarea id="rc-delnote" rows="2"></textarea></label>' +
      '<label class="full">Special notes <textarea id="rc-notes" rows="3">' +
      self.esc(g.specialInstructions || "") +
      "</textarea></label>" +
      '<label class="full">Terms (RC standard) <textarea id="rc-terms" rows="8">' +
      self.esc(defaultTerms) +
      "</textarea></label>" +
      "</div>" +
      '<div class="load-actions" style="margin-top:0.75rem">' +
      '<button type="button" class="btn-primary" id="rc-generate">Save Load &amp; Generate Rate Con PDF</button>' +
      '<button type="button" class="btn-secondary" id="rc-cancel">Cancel</button>' +
      "</div>" +
      '<p id="rc-status" class="gos-muted" style="margin-top:0.5rem"></p>';

    box.scrollIntoView({ behavior: "smooth", block: "start" });

    box.querySelector("#rc-cancel")?.addEventListener("click", function () {
      box.classList.add("hidden");
      box.innerHTML = "";
    });

    box.querySelector("#rc-generate")?.addEventListener("click", async function () {
      var carrier = (box.querySelector("#rc-carrier").value || "").trim();
      var rate = (box.querySelector("#rc-rate").value || "").trim();
      if (!carrier) {
        alert("Carrier name is required for Rate Confirmation.");
        box.querySelector("#rc-carrier").focus();
        return;
      }
      if (!rate) {
        alert("Flat Rate ($USD) is required.");
        box.querySelector("#rc-rate").focus();
        return;
      }
      var statusEl = box.querySelector("#rc-status");
      var btnGen = box.querySelector("#rc-generate");
      try {
        if (btnGen) btnGen.disabled = true;
        if (statusEl) statusEl.textContent = "Saving load details…";

        await self.api("/" + encodeURIComponent(id), {
          method: "PATCH",
          body: JSON.stringify({
            carrierName: carrier,
            carrierMc: box.querySelector("#rc-mc").value || null,
            carrierDot: box.querySelector("#rc-dot").value || null,
            driverName: box.querySelector("#rc-driver").value || null,
            truckNumber: box.querySelector("#rc-truck").value || null,
            trailerNumber: box.querySelector("#rc-trailer").value || null,
            equipment: box.querySelector("#rc-equip").value || null,
            weight: box.querySelector("#rc-weight").value || null,
            commodity: box.querySelector("#rc-commodity").value || null,
            carrierRate: rate,
            specialInstructions: box.querySelector("#rc-notes").value || null,
            carrierNotes: box.querySelector("#rc-delnote").value || null,
          }),
        });

        if (statusEl) statusEl.textContent = "Generating Rate Confirmation PDF…";
        var content = {
          loadNumber: box.querySelector("#rc-load").value,
          shipmentNumber: box.querySelector("#rc-ship").value,
          confirmationDate: box.querySelector("#rc-date").value,
          brokerName: box.querySelector("#rc-broker").value,
          carrierName: carrier,
          carrierMc: box.querySelector("#rc-mc").value,
          carrierDot: box.querySelector("#rc-dot").value,
          carrierPhone: box.querySelector("#rc-cphone").value,
          equipment: box.querySelector("#rc-equip").value,
          weight: box.querySelector("#rc-weight").value,
          commodity: box.querySelector("#rc-commodity").value,
          flatRate: rate,
          carrierRate: rate,
          pickupAddress: box.querySelector("#rc-origin").value,
          pickupDate: box.querySelector("#rc-pdate").value,
          pickupTime: box.querySelector("#rc-ptime").value,
          pickupContact: box.querySelector("#rc-pcontact").value,
          deliveryAddress: box.querySelector("#rc-dest").value,
          deliveryDate: box.querySelector("#rc-ddate").value,
          deliveryTime: box.querySelector("#rc-dtime").value,
          deliveryContact: box.querySelector("#rc-dcontact").value,
          driverName: box.querySelector("#rc-driver").value,
          driverPhone: box.querySelector("#rc-dphone").value,
          truckNumber: box.querySelector("#rc-truck").value,
          trailerNumber: box.querySelector("#rc-trailer").value,
          paymentOption: box.querySelector("#rc-pay").value,
          deliveryNote: box.querySelector("#rc-delnote").value,
          specialNotes: box.querySelector("#rc-notes").value,
          specialInstructions: box.querySelector("#rc-notes").value,
          terms: box.querySelector("#rc-terms").value,
        };

        var endpoint =
          (changeReason || "GENERATED") === "GENERATED"
            ? "/" + encodeURIComponent(id) + "/documents/RATE_CONFIRMATION/generate"
            : "/" + encodeURIComponent(id) + "/documents/RATE_CONFIRMATION/edit";

        var row = await self.api(endpoint, {
          method: "POST",
          body: JSON.stringify({
            changeReason: changeReason || "GENERATED",
            content: content,
          }),
        });

        if (statusEl) statusEl.textContent = "Done — opening PDF…";
        await self.openLoad(document.querySelector("#load-tms-body"), id, "documents");
        if (row && row.documentId) {
          try {
            await self.openPdf(
              "/api/loads/" +
                encodeURIComponent(id) +
                "/documents/" +
                encodeURIComponent(row.documentId) +
                "/download",
              true
            );
          } catch (e) {}
        } else {
          alert("Rate Confirmation created. Open it from Documents → Preview.");
        }
      } catch (err) {
        alert(err.message || err);
        if (btnGen) btnGen.disabled = false;
        if (statusEl) statusEl.textContent = "";
      }
    });
  },
};

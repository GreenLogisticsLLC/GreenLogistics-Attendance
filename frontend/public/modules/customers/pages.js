/**
 * Direct Customers — add a customer, then Create Load (new lot, not uShip).
 */
window.GreenOSModules = window.GreenOSModules || {};
window.GreenOSModules.customers = {
  _customerId: null,
  _view: "list",

  esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  },

  async api(path, opts) {
    var token = localStorage.getItem("gl_token") || "";
    var res = await fetch("/api/customers" + path, Object.assign({
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + token,
      },
    }, opts || {}));
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok || data.success === false) {
      throw new Error(data.message || "Request failed");
    }
    return data.data;
  },

  render(root, subPageId) {
    if (!root) return;
    var self = this;
    if (window.GreenOS) {
      window.GreenOS.currentModule = "customers";
      window.GreenOS.currentSub = subPageId || null;
    }
    root.innerHTML =
      '<div class="gos-module-placeholder load-tms" data-module="customers">' +
      '<div class="load-page-head">' +
      "<h2>Customers</h2>" +
      '<nav class="gos-subnav load-subnav" aria-label="Customers">' +
      '<button type="button" class="gos-subnav-item' +
      (subPageId !== "add" ? " is-active" : "") +
      '" data-subpage="list">All Customers</button>' +
      '<button type="button" class="gos-subnav-item' +
      (subPageId === "add" ? " is-active" : "") +
      '" data-subpage="add">Add Customer</button>' +
      "</nav></div>" +
      '<div class="gos-module-body load-tms-body" id="cust-body"></div></div>';

    root.querySelectorAll("[data-subpage]").forEach(function (btn) {
      btn.addEventListener("click", function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        self._customerId = null;
        self.render(root, btn.getAttribute("data-subpage"));
      });
    });

    var body = root.querySelector("#cust-body");
    if (!body) return;
    if (self._customerId && subPageId !== "add") {
      self.renderDetail(body, root, self._customerId);
      return;
    }
    if (subPageId === "add") {
      self.renderForm(body, root, null);
      return;
    }
    self.renderList(body, root);
  },

  async renderList(body, root) {
    var self = this;
    body.innerHTML = '<p class="gos-muted">Loading customers…</p>';
    try {
      var rows = await self.api("/");
      if (!rows || !rows.length) {
        body.innerHTML =
          '<div class="load-empty"><h2>No customers yet</h2>' +
          "<p>Add a direct customer, then Create Load from their card.</p>" +
          '<button type="button" class="btn-primary" id="cust-empty-add" style="width:auto;margin-top:1rem">Add Customer</button></div>';
        body.querySelector("#cust-empty-add")?.addEventListener("click", function () {
          self.render(root, "add");
        });
        return;
      }
      var html =
        '<div class="load-list-bar"><h2>Direct customers</h2>' +
        '<input type="search" class="load-list-search" id="cust-search" placeholder="Search company, contact, email…" autocomplete="off">' +
        '<span class="load-list-count">' +
        rows.length +
        " customers</span></div>" +
        '<div class="load-table-wrap"><table class="load-table"><thead><tr>' +
        "<th>Company</th><th>Contact</th><th>Email</th><th>Phone</th><th>Loads</th><th></th>" +
        "</tr></thead><tbody>";
      rows.forEach(function (r) {
        var hay = [r.companyName, r.contactName, r.email, r.phone, r.city, r.state]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        html +=
          '<tr class="load-row" data-id="' +
          self.esc(r.customerId) +
          '" data-hay="' +
          self.esc(hay) +
          '"><td><strong>' +
          self.esc(r.companyName) +
          "</strong></td><td>" +
          self.esc(r.contactName || "—") +
          "</td><td>" +
          self.esc(r.email || "—") +
          "</td><td>" +
          self.esc(r.phone || "—") +
          "</td><td>" +
          (r.loadCount || 0) +
          '</td><td><button type="button" class="btn-secondary cust-open" data-id="' +
          self.esc(r.customerId) +
          '">Open</button></td></tr>';
      });
      html += "</tbody></table></div>";
      body.innerHTML = html;
      function openId(id) {
        self._customerId = id;
        self.renderDetail(body, root, id);
      }
      body.querySelectorAll(".cust-open").forEach(function (btn) {
        btn.addEventListener("click", function (ev) {
          ev.stopPropagation();
          openId(btn.getAttribute("data-id"));
        });
      });
      body.querySelectorAll("tr.load-row").forEach(function (tr) {
        tr.addEventListener("click", function () {
          openId(tr.getAttribute("data-id"));
        });
      });
      var search = body.querySelector("#cust-search");
      if (search) {
        search.addEventListener("input", function () {
          var q = (search.value || "").trim().toLowerCase();
          body.querySelectorAll("tr.load-row").forEach(function (tr) {
            tr.style.display = !q || (tr.getAttribute("data-hay") || "").indexOf(q) >= 0 ? "" : "none";
          });
        });
      }
    } catch (err) {
      body.innerHTML = '<p class="gos-error">' + self.esc(err.message || err) + "</p>";
    }
  },

  customerFormHtml(c) {
    var self = this;
    c = c || {};
    return (
      '<div class="load-form-grid">' +
      '<label>Company name * <input id="cu-company" value="' + self.esc(c.companyName || "") + '"></label>' +
      '<label>Contact <input id="cu-contact" value="' + self.esc(c.contactName || "") + '"></label>' +
      '<label>Email <input id="cu-email" type="email" value="' + self.esc(c.email || "") + '"></label>' +
      '<label>Phone <input id="cu-phone" type="tel" value="' + self.esc(c.phone || "") + '"></label>' +
      '<label>City <input id="cu-city" value="' + self.esc(c.city || "") + '"></label>' +
      '<label>State <input id="cu-state" value="' + self.esc(c.state || "") + '"></label>' +
      '<label>ZIP <input id="cu-zip" value="' + self.esc(c.zip || "") + '"></label>' +
      '<label class="full">Billing address <input id="cu-addr" value="' + self.esc(c.billingAddress || "") + '"></label>' +
      '<label class="full">Notes <textarea id="cu-notes" rows="3">' + self.esc(c.notes || "") + "</textarea></label>" +
      "</div>"
    );
  },

  readCustomerForm(root) {
    return {
      companyName: (root.querySelector("#cu-company").value || "").trim(),
      contactName: (root.querySelector("#cu-contact").value || "").trim() || null,
      email: (root.querySelector("#cu-email").value || "").trim() || null,
      phone: (root.querySelector("#cu-phone").value || "").trim() || null,
      city: (root.querySelector("#cu-city").value || "").trim() || null,
      state: (root.querySelector("#cu-state").value || "").trim() || null,
      zip: (root.querySelector("#cu-zip").value || "").trim() || null,
      billingAddress: (root.querySelector("#cu-addr").value || "").trim() || null,
      notes: (root.querySelector("#cu-notes").value || "").trim() || null,
    };
  },

  renderForm(body, root, existing) {
    var self = this;
    body.innerHTML =
      '<div class="load-main" style="min-height:auto">' +
      "<h2>" +
      (existing ? "Edit customer" : "Add customer") +
      "</h2>" +
      "<p class=\"gos-muted\">Direct customer — not from uShip. After save you can Create Load.</p>" +
      self.customerFormHtml(existing) +
      '<div class="load-actions"><button type="button" class="btn-primary" id="cu-save">Save Customer</button>' +
      '<button type="button" class="btn-secondary" id="cu-cancel">Cancel</button></div></div>';
    body.querySelector("#cu-cancel")?.addEventListener("click", function () {
      self._customerId = existing && existing.customerId ? existing.customerId : null;
      if (self._customerId) self.renderDetail(body, root, self._customerId);
      else self.render(root, "list");
    });
    body.querySelector("#cu-save")?.addEventListener("click", async function () {
      var payload = self.readCustomerForm(body);
      if (!payload.companyName) {
        alert("Company name is required.");
        return;
      }
      try {
        var saved = existing && existing.customerId
          ? await self.api("/" + encodeURIComponent(existing.customerId), {
              method: "PATCH",
              body: JSON.stringify(payload),
            })
          : await self.api("/", { method: "POST", body: JSON.stringify(payload) });
        self._customerId = saved.customerId;
        self.renderDetail(body, root, saved.customerId);
      } catch (err) {
        alert(err.message || err);
      }
    });
  },

  async renderDetail(body, root, id) {
    var self = this;
    body.innerHTML = '<p class="gos-muted">Loading customer…</p>';
    try {
      var c = await self.api("/" + encodeURIComponent(id));
      self._customerId = id;
      var loads = c.loads || [];
      var loadRows = loads.length
        ? loads
            .map(function (l) {
              return (
                '<tr class="load-row" data-load="' +
                self.esc(l.shipmentLeadId) +
                '"><td><strong>' +
                self.esc(l.loadNumber || "—") +
                "</strong></td><td>" +
                self.esc(l.greenOsShipmentId || "—") +
                "</td><td>" +
                self.esc((l.pickupCity || "—") + " → " + (l.deliveryCity || "—")) +
                "</td><td>" +
                self.esc(l.status || "") +
                "</td></tr>"
              );
            })
            .join("")
        : '<tr><td colspan="4" class="gos-muted">No loads yet — Create Load from this customer.</td></tr>';
      body.innerHTML =
        '<div class="load-main" style="min-height:auto">' +
        '<button type="button" class="load-back-btn" id="cu-back" style="width:auto">← All customers</button>' +
        "<h2>" +
        self.esc(c.companyName) +
        "</h2>" +
        '<p class="gos-muted">' +
        self.esc([c.contactName, c.email, c.phone].filter(Boolean).join(" · ") || "No contact yet") +
        "</p>" +
        '<div class="load-actions" style="margin:1rem 0">' +
        '<button type="button" class="btn-primary" id="cu-create-load">Create Load</button>' +
        '<button type="button" class="btn-secondary" id="cu-edit">Edit customer</button>' +
        "</div>" +
        "<h3>Loads from this customer</h3>" +
        '<div class="load-table-wrap"><table class="load-table"><thead><tr>' +
        "<th>Load #</th><th>Shipment</th><th>Lane</th><th>Status</th></tr></thead><tbody>" +
        loadRows +
        "</tbody></table></div></div>";
      body.querySelector("#cu-back")?.addEventListener("click", function () {
        self._customerId = null;
        self.render(root, "list");
      });
      body.querySelector("#cu-edit")?.addEventListener("click", function () {
        self.renderForm(body, root, c);
      });
      body.querySelector("#cu-create-load")?.addEventListener("click", function () {
        self.renderCreateLoad(body, root, c);
      });
      body.querySelectorAll("tr[data-load]").forEach(function (tr) {
        tr.addEventListener("click", function () {
          var lid = tr.getAttribute("data-load");
          if (typeof window.GreenOSOpenLoad === "function") window.GreenOSOpenLoad(lid, "general");
        });
      });
    } catch (err) {
      body.innerHTML = '<p class="gos-error">' + self.esc(err.message || err) + "</p>";
    }
  },

  renderCreateLoad(body, root, c) {
    var self = this;
    body.innerHTML =
      '<div class="load-main" style="min-height:auto">' +
      '<button type="button" class="load-back-btn" id="cl-back" style="width:auto">← ' +
      self.esc(c.companyName) +
      "</button>" +
      "<h2>Create Load</h2>" +
      '<p class="gos-muted">New lot from this direct customer. Load number (GL#) is assigned automatically.</p>' +
      '<h3>Customer</h3><div class="load-form-grid">' +
      '<label>Company <input id="cl-cust" value="' + self.esc(c.companyName || "") + '"></label>' +
      '<label>Email <input id="cl-email" type="email" value="' + self.esc(c.email || "") + '"></label>' +
      '<label>Phone <input id="cl-phone" type="tel" value="' + self.esc(c.phone || "") + '"></label>' +
      '<label>Title / commodity <input id="cl-title" placeholder="e.g. 6 pallets machinery"></label>' +
      "</div>" +
      '<h3>Load</h3><div class="load-form-grid">' +
      '<label>Pickup city * <input id="cl-pcity"></label>' +
      '<label>Pickup state <input id="cl-pstate"></label>' +
      '<label>Pickup ZIP <input id="cl-pzip"></label>' +
      '<label>Pickup date <input id="cl-pdate" type="date"></label>' +
      '<label>Delivery city * <input id="cl-dcity"></label>' +
      '<label>Delivery state <input id="cl-dstate"></label>' +
      '<label>Delivery ZIP <input id="cl-dzip"></label>' +
      '<label>Delivery date <input id="cl-ddate" type="date"></label>' +
      '<label>Equipment <input id="cl-equip" placeholder="Van, Flatbed…"></label>' +
      '<label>Weight <input id="cl-weight"></label>' +
      '<label>Pieces <input id="cl-pieces" type="number" min="0"></label>' +
      '<label>Miles <input id="cl-miles" type="number" min="0"></label>' +
      '<label>Customer rate $ <input id="cl-rate" inputmode="decimal" placeholder="0.00"></label>' +
      '<label class="full">Special instructions <textarea id="cl-notes" rows="3"></textarea></label>' +
      "</div>" +
      '<div class="load-actions"><button type="button" class="btn-primary" id="cl-save">Create Load</button>' +
      '<button type="button" class="btn-secondary" id="cl-cancel">Cancel</button></div></div>';
    function back() {
      self.renderDetail(body, root, c.customerId);
    }
    body.querySelector("#cl-back")?.addEventListener("click", back);
    body.querySelector("#cl-cancel")?.addEventListener("click", back);
    body.querySelector("#cl-save")?.addEventListener("click", async function () {
      var pickupCity = (body.querySelector("#cl-pcity").value || "").trim();
      var deliveryCity = (body.querySelector("#cl-dcity").value || "").trim();
      if (!pickupCity || !deliveryCity) {
        alert("Pickup city and delivery city are required.");
        return;
      }
      var btn = body.querySelector("#cl-save");
      try {
        if (btn) btn.disabled = true;
        var result = await self.api("/" + encodeURIComponent(c.customerId) + "/loads", {
          method: "POST",
          body: JSON.stringify({
            customerName: (body.querySelector("#cl-cust").value || "").trim(),
            customerEmail: (body.querySelector("#cl-email").value || "").trim() || null,
            customerPhone: (body.querySelector("#cl-phone").value || "").trim() || null,
            shipmentTitle: (body.querySelector("#cl-title").value || "").trim() || null,
            commodity: (body.querySelector("#cl-title").value || "").trim() || null,
            pickupCity: pickupCity,
            pickupState: (body.querySelector("#cl-pstate").value || "").trim() || null,
            pickupZip: (body.querySelector("#cl-pzip").value || "").trim() || null,
            pickupFrom: body.querySelector("#cl-pdate").value || null,
            deliveryCity: deliveryCity,
            deliveryState: (body.querySelector("#cl-dstate").value || "").trim() || null,
            deliveryZip: (body.querySelector("#cl-dzip").value || "").trim() || null,
            deliveryFrom: body.querySelector("#cl-ddate").value || null,
            equipment: (body.querySelector("#cl-equip").value || "").trim() || null,
            weight: (body.querySelector("#cl-weight").value || "").trim() || null,
            pieces: body.querySelector("#cl-pieces").value || null,
            miles: body.querySelector("#cl-miles").value || null,
            customerRate: body.querySelector("#cl-rate").value || null,
            specialInstructions: (body.querySelector("#cl-notes").value || "").trim() || null,
          }),
        });
        alert("Load " + (result.loadNumber || "") + " created.");
        if (typeof window.GreenOSOpenLoad === "function") {
          window.GreenOSOpenLoad(result.shipmentLeadId, "general");
        } else {
          self.renderDetail(body, root, c.customerId);
        }
      } catch (err) {
        if (btn) btn.disabled = false;
        alert(err.message || err);
      }
    });
  },
};

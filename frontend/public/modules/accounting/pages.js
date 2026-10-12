/**
 * Accounting Team workspace — isolated from Broker/Operations.
 */
window.GreenOSModules = window.GreenOSModules || {};
window.GreenOSModules.accounting = {
  children: [
    { id: "dashboard", title: "Dashboard" },
    { id: "shipments", title: "Shipments" },
    { id: "document-review", title: "Document Review" },
    { id: "customer-billing", title: "Customer Billing" },
    { id: "customer-payments", title: "Customer Payments" },
    { id: "carrier-payments", title: "Carrier Payments" },
    { id: "history", title: "Accounting History" },
  ],

  _selectedId: null,

  async api(path, options) {
    var token = localStorage.getItem("gl_token");
    var opts = options || {};
    var res = await fetch("/api/accounting" + path, {
      method: opts.method || "GET",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: token ? "Bearer " + token : "",
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    var json = await res.json().catch(function () {
      return { success: false, message: "Bad response" };
    });
    if (!res.ok && !json.message) {
      json.message = "Request failed (" + res.status + ")";
      json.success = false;
    }
    return json;
  },

  esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  },

  money(n) {
    if (n == null || n === "") return "—";
    var v = Number(n);
    if (Number.isNaN(v)) return "—";
    return "$" + v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  },

  userMeta() {
    var u = window.GreenOSUser || (window.GreenOS && window.GreenOS.user) || {};
    return {
      role: u.role || "",
      sub: u.accountingSubRole || null,
      label: u.accountingLabel || "Accounting Team",
    };
  },

  filterForSub(subPageId) {
    if (subPageId === "document-review") return "documents";
    if (subPageId === "customer-billing") return "billing";
    if (subPageId === "customer-payments") return "customer-payments";
    if (subPageId === "carrier-payments") return "carrier-payment";
    if (subPageId === "history") return "history";
    return "all";
  },

  render(root, subPageId) {
    if (!root) return;
    var self = this;
    var children = this.children || [];
    var active =
      children.find(function (c) {
        return c.id === subPageId;
      }) || children[0];
    var meta = this.userMeta();

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
      '<div class="gos-module-body" data-module="accounting">' +
      '  <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:1rem;flex-wrap:wrap;margin-bottom:0.75rem">' +
      "    <div>" +
      '      <h2 style="margin:0">Accounting Team</h2>' +
      '      <p class="gos-muted" style="margin:0.25rem 0 0">' +
      self.esc(meta.label) +
      " — isolated workspace (not Broker / Operations)</p>" +
      "    </div>" +
      '    <span class="emp-badge-off" style="padding:0.35rem 0.65rem;border-radius:6px;background:#064e3b;color:#a7f3d0;font-size:0.85rem">' +
      self.esc(meta.label) +
      "</span>" +
      "  </div>" +
      '  <nav class="gos-subnav" aria-label="Accounting sections">' +
      navHtml +
      "</nav>" +
      '  <div id="acc-body" style="margin-top:1rem"><p class="gos-muted">Loading…</p></div>' +
      "</div>";

    root.querySelectorAll("[data-subpage]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        if (window.GreenOS && typeof window.GreenOS.navigate === "function") {
          window.GreenOS.navigate("accounting", btn.getAttribute("data-subpage"));
        } else {
          self.render(root, btn.getAttribute("data-subpage"));
        }
      });
    });

    var body = root.querySelector("#acc-body");
    if (!active || active.id === "dashboard") {
      this.renderDashboard(body);
    } else {
      this.renderList(body, active.id);
    }
  },

  async renderDashboard(body) {
    if (!body) return;
    var self = this;
    body.innerHTML = '<p class="gos-muted">Loading dashboard…</p>';
    try {
      var res = await this.api("/dashboard");
      if (!res.success) {
        body.innerHTML =
          '<p style="color:#ef4444">' + self.esc(res.message || "Access denied") + "</p>";
        return;
      }
      var kpis = (res.data && res.data.kpis) || {};
      var labels = {
        documentsToReview: "Documents To Review",
        needsCorrection: "Needs Correction",
        readyForBilling: "Ready For Billing",
        invoicesOutstanding: "Invoices Outstanding",
        customerPaymentsReceived: "Customer Payments Received",
        readyForCarrierPayment: "Ready For Carrier Payment",
        carrierPaymentsCompleted: "Carrier Payments Completed",
        overdueCustomerPayments: "Overdue Customer Payments",
        accountingClosed: "Accounting Closed",
      };
      var cards = Object.keys(kpis)
        .map(function (key) {
          return (
            '<div style="padding:1rem;border:1px solid rgba(255,255,255,0.08);border-radius:10px;background:rgba(0,0,0,0.15)">' +
            '<div class="gos-muted" style="font-size:0.8rem">' +
            self.esc(labels[key] || key) +
            "</div>" +
            '<div style="font-size:1.75rem;font-weight:700;margin-top:0.25rem">' +
            self.esc(kpis[key]) +
            "</div></div>"
          );
        })
        .join("");
      body.innerHTML =
        '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:0.75rem">' +
        cards +
        "</div>" +
        '<p class="gos-muted" style="margin-top:1rem">Open a queue from the tabs above to review shipments.</p>';
    } catch (err) {
      body.innerHTML =
        '<p style="color:#ef4444">' + self.esc(err.message || "Failed to load") + "</p>";
    }
  },

  async renderList(body, subPageId) {
    if (!body) return;
    var self = this;
    var filter = this.filterForSub(subPageId);
    body.innerHTML = '<p class="gos-muted">Loading shipments…</p>';
    try {
      var res = await this.api("/shipments?filter=" + encodeURIComponent(filter));
      if (!res.success) {
        body.innerHTML =
          '<p style="color:#ef4444">' + self.esc(res.message || "Access denied") + "</p>";
        return;
      }
      var rows = res.data || [];
      if (!rows.length) {
        body.innerHTML = '<p class="gos-muted">No shipments in this queue.</p>';
        return;
      }
      var table =
        '<div class="emp-users-wrap"><table class="emp-users-table"><thead><tr>' +
        "<th>Load</th><th>Customer</th><th>Carrier</th><th>Doc status</th><th>Ready</th><th>Payments</th><th></th>" +
        "</tr></thead><tbody>" +
        rows
          .map(function (r) {
            return (
              '<tr>' +
              "<td>" +
              self.esc(r.loadNumber || r.greenOsShipmentId || "—") +
              "</td>" +
              "<td>" +
              self.esc(r.customerName || "—") +
              "</td>" +
              "<td>" +
              self.esc(r.carrierName || "—") +
              "</td>" +
              "<td>" +
              self.esc(r.accountingDocStatus || "PENDING") +
              "</td>" +
              "<td>" +
              (r.accountingReadyForBilling ? "Billing " : "") +
              (r.accountingReadyForCarrierPayment ? "Carrier$ " : "") +
              (!r.accountingReadyForBilling && !r.accountingReadyForCarrierPayment ? "—" : "") +
              "</td>" +
              "<td>" +
              (r.customerPaidAt ? "Cust✓ " : "") +
              (r.carrierPaidAt ? "Carr✓" : "") +
              (!r.customerPaidAt && !r.carrierPaidAt ? "—" : "") +
              "</td>" +
              '<td><button type="button" class="btn-primary acc-open" data-id="' +
              self.esc(r.shipmentLeadId) +
              '" style="width:auto;padding:0.35rem 0.65rem">Open</button></td>' +
              "</tr>"
            );
          })
          .join("") +
        "</tbody></table></div>" +
        '<div id="acc-detail" style="margin-top:1.25rem"></div>';
      body.innerHTML = table;
      body.querySelectorAll(".acc-open").forEach(function (btn) {
        btn.addEventListener("click", function () {
          self.openShipment(body.querySelector("#acc-detail"), btn.getAttribute("data-id"));
        });
      });
      if (self._selectedId) {
        self.openShipment(body.querySelector("#acc-detail"), self._selectedId);
      }
    } catch (err) {
      body.innerHTML =
        '<p style="color:#ef4444">' + self.esc(err.message || "Failed to load") + "</p>";
    }
  },

  async openShipment(host, id) {
    if (!host || !id) return;
    var self = this;
    self._selectedId = id;
    host.innerHTML = '<p class="gos-muted">Loading shipment…</p>';
    try {
      var res = await this.api("/shipments/" + encodeURIComponent(id));
      if (!res.success) {
        host.innerHTML =
          '<p style="color:#ef4444">' + self.esc(res.message || "Failed") + "</p>";
        return;
      }
      var d = res.data;
      var perms = d.permissions || {};
      var acc = d.accounting || {};
      var cust = d.customer || {};
      var carr = d.carrier || {};
      var docs = (d.documents || [])
        .map(function (doc) {
          return (
            "<li>" +
            self.esc(doc.docType) +
            " — " +
            self.esc(doc.status || "") +
            (doc.fileUrl
              ? ' <a href="' +
                self.esc(doc.fileUrl) +
                '" target="_blank" rel="noopener">file</a>'
              : "") +
            "</li>"
          );
        })
        .join("");

      var actions = "";
      if (perms.canVerifyDocuments) {
        actions +=
          '<button type="button" class="btn-primary" data-act="verify-docs" style="width:auto">Verify documents</button> ';
        actions +=
          '<button type="button" data-act="reject-docs" style="width:auto">Reject / request correction</button> ';
      }
      if (perms.canVerifyFinancials) {
        actions +=
          '<button type="button" class="btn-primary" data-act="verify-fin" style="width:auto">Confirm amounts</button> ';
        actions +=
          '<button type="button" data-act="ready-bill" style="width:auto">Ready for Billing</button> ';
        actions +=
          '<button type="button" data-act="ready-pay" style="width:auto">Ready for Carrier Payment</button> ';
      }
      if (perms.canCreateInvoice) {
        actions +=
          '<button type="button" class="btn-primary" data-act="invoice" style="width:auto">Create invoice</button> ';
        actions +=
          '<button type="button" data-act="send-invoice" style="width:auto">Mark invoice sent</button> ';
      }
      if (perms.canRecordCustomerPayment) {
        actions +=
          '<button type="button" class="btn-primary" data-act="cust-pay" style="width:auto">Record customer payment</button> ';
      }
      if (perms.canExecuteCarrierPayment) {
        actions +=
          '<button type="button" class="btn-primary" data-act="carr-pay" style="width:auto"' +
          (acc.canPayCarrier ? "" : " disabled title=\"Blocked until Documents verification\"") +
          ">Execute carrier payment</button> ";
      }
      actions +=
        '<button type="button" data-act="note" style="width:auto">Add accounting note</button>';

      host.innerHTML =
        '<div style="padding:1rem;border:1px solid rgba(255,255,255,0.1);border-radius:12px;background:rgba(0,0,0,0.2)">' +
        "<h3 style=\"margin-top:0\">" +
        self.esc((d.identity && d.identity.loadNumber) || id) +
        " — " +
        self.esc((d.identity && d.identity.status) || "") +
        "</h3>" +
        '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:1rem">' +
        "<div><h4>Customer</h4>" +
        "<div>" +
        self.esc(cust.name || "—") +
        "</div>" +
        "<div>Rate: " +
        self.money(cust.rate) +
        "</div>" +
        "<div>Accessorials: " +
        self.money(cust.accessorials) +
        "</div>" +
        "<div>Total: " +
        self.money(cust.total) +
        "</div>" +
        "<div>Invoice: " +
        self.esc(cust.invoiceNumber || "—") +
        "</div>" +
        "<div>Received: " +
        self.money(cust.amountReceived) +
        "</div>" +
        "<div>Outstanding: " +
        self.money(cust.outstanding) +
        "</div>" +
        "<div>Status: " +
        self.esc(cust.paymentStatus || "—") +
        "</div></div>" +
        "<div><h4>Carrier</h4>" +
        "<div>" +
        self.esc(carr.name || "—") +
        "</div>" +
        "<div>Rate: " +
        self.money(carr.rate) +
        "</div>" +
        "<div>Total: " +
        self.money(carr.total) +
        "</div>" +
        "<div>Paid: " +
        self.money(carr.amountPaid) +
        "</div>" +
        "<div>Outstanding: " +
        self.money(carr.outstanding) +
        "</div>" +
        "<div>Status: " +
        self.esc(carr.paymentStatus || "—") +
        "</div></div>" +
        "<div><h4>Documents</h4><ul style=\"padding-left:1.1rem;margin:0\">" +
        (docs || "<li class=\"gos-muted\">None</li>") +
        "</ul></div>" +
        "<div><h4>Accounting</h4>" +
        "<div>Doc status: " +
        self.esc(acc.docStatus || "—") +
        "</div>" +
        "<div>Financial verified: " +
        (acc.financialVerified ? "Yes" : "No") +
        "</div>" +
        "<div>Ready billing: " +
        (acc.readyForBilling ? "Yes" : "No") +
        "</div>" +
        "<div>Ready carrier pay: " +
        (acc.readyForCarrierPayment ? "Yes" : "No") +
        "</div>" +
        "<div>Can pay carrier: " +
        (acc.canPayCarrier ? "Yes" : "Blocked") +
        "</div>" +
        '<pre class="gos-muted" style="white-space:pre-wrap;font-size:0.8rem">' +
        self.esc(acc.notes || "No notes") +
        "</pre></div>" +
        "</div>" +
        '<div style="margin-top:1rem;display:flex;flex-wrap:wrap;gap:0.5rem">' +
        actions +
        "</div>" +
        '<p id="acc-msg" class="gos-muted" style="margin-top:0.75rem"></p>' +
        "</div>";

      host.querySelectorAll("[data-act]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          self.runAction(host, id, btn.getAttribute("data-act"));
        });
      });
    } catch (err) {
      host.innerHTML =
        '<p style="color:#ef4444">' + self.esc(err.message || "Failed") + "</p>";
    }
  },

  async runAction(host, id, act) {
    var self = this;
    var msg = host.querySelector("#acc-msg");
    var path = null;
    var body = {};
    if (act === "verify-docs") path = "/shipments/" + id + "/documents/verify";
    else if (act === "reject-docs") {
      var reason = window.prompt("Rejection / correction reason:");
      if (!reason) return;
      path = "/shipments/" + id + "/documents/reject";
      body = { reason: reason, needsCorrection: true };
    } else if (act === "verify-fin") path = "/shipments/" + id + "/financials/verify";
    else if (act === "ready-bill") path = "/shipments/" + id + "/ready-for-billing";
    else if (act === "ready-pay") path = "/shipments/" + id + "/ready-for-carrier-payment";
    else if (act === "invoice") {
      var inv = window.prompt("Invoice number (optional):", "");
      path = "/shipments/" + id + "/invoice";
      body = { invoiceNumber: inv || null };
    } else if (act === "send-invoice") path = "/shipments/" + id + "/invoice/send";
    else if (act === "cust-pay") path = "/shipments/" + id + "/customer-payment";
    else if (act === "carr-pay") {
      if (
        !window.confirm(
          "Execute carrier payment? Backend will block if Documents verification is incomplete."
        )
      ) {
        return;
      }
      path = "/shipments/" + id + "/carrier-payment";
    } else if (act === "note") {
      var note = window.prompt("Accounting note:");
      if (!note) return;
      path = "/shipments/" + id + "/notes";
      body = { note: note };
    }
    if (!path) return;
    if (msg) {
      msg.textContent = "Working…";
      msg.style.color = "";
    }
    try {
      var res = await this.api(path, { method: "POST", body: body });
      if (!res.success) {
        if (msg) {
          msg.textContent = res.message || "Failed";
          msg.style.color = "#ef4444";
        }
        return;
      }
      if (msg) {
        msg.textContent = res.message || "Done";
        msg.style.color = "#22c55e";
      }
      await self.openShipment(host, id);
    } catch (err) {
      if (msg) {
        msg.textContent = err.message || "Failed";
        msg.style.color = "#ef4444";
      }
    }
  },
};

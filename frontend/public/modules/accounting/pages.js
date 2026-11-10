/**
 * Accounting Team workspace — isolated from Broker/Operations.
 */
window.GreenOSModules = window.GreenOSModules || {};
window.GreenOSModules.accounting = {
  children: [
    { id: "dashboard", title: "Dashboard" },
    { id: "document-review", title: "Loads for Review" },
    { id: "verified", title: "Verified" },
    { id: "customer-billing", title: "Billing (AR)" },
    { id: "carrier-payments", title: "Carrier Payments (AP)" },
    { id: "customer-payments", title: "Invoices" },
    { id: "shipments", title: "All Loads" },
    { id: "history", title: "Transactions" },
  ],

  _selectedId: null,
  _subPageId: null,
  _idleTimer: null,
  _activityRoot: null,
  _onActivity: null,
  /** Load column sort: "asc" | "desc". */
  _loadSortDir: "asc",

  /** Accounting never auto-refreshes — only after user clicks / navigation. */
  stopIdleRefresh() {
    if (this._idleTimer) {
      clearInterval(this._idleTimer);
      this._idleTimer = null;
    }
    if (this._activityRoot && this._onActivity) {
      try {
        this._activityRoot.removeEventListener("click", this._onActivity, true);
        this._activityRoot.removeEventListener("keydown", this._onActivity, true);
        this._activityRoot.removeEventListener("input", this._onActivity, true);
        this._activityRoot.removeEventListener("change", this._onActivity, true);
        this._activityRoot.removeEventListener("pointerdown", this._onActivity, true);
      } catch (e) {
        /* ignore */
      }
    }
    this._activityRoot = null;
    this._onActivity = null;
  },

  startIdleRefresh() {
    this.stopIdleRefresh();
  },

  softRefresh() {
    var body = document.getElementById("acc-body");
    if (!body) return;
    var sub = this._subPageId || "dashboard";
    if (!sub || sub === "dashboard") {
      this.renderDashboard(body);
    } else {
      this.renderList(body, sub);
    }
  },

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

  /** Calendar day for accounting tables (DD.MM.YYYY). */
  formatDay(iso) {
    if (!iso) return "—";
    try {
      var d = new Date(iso);
      if (Number.isNaN(d.getTime())) return "—";
      return d.toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
      });
    } catch (e) {
      return "—";
    }
  },

  /** YYYY-MM-DD for date-input filter matching. */
  dayKey(iso) {
    if (!iso) return "";
    try {
      var d = new Date(iso);
      if (Number.isNaN(d.getTime())) return "";
      var y = d.getFullYear();
      var m = String(d.getMonth() + 1).padStart(2, "0");
      var day = String(d.getDate()).padStart(2, "0");
      return y + "-" + m + "-" + day;
    } catch (e) {
      return "";
    }
  },

  emptyTableFilters() {
    return {
      load: "",
      pickupDayFrom: "",
      pickupDayTo: "",
      deliveryDayFrom: "",
      deliveryDayTo: "",
      broker: "",
    };
  },

  getTableFilters() {
    return this._tableFilters || this.emptyTableFilters();
  },

  setTableFilters(next) {
    this._tableFilters = Object.assign(this.emptyTableFilters(), next || {});
  },

  /** Inclusive YYYY-MM-DD range match. Empty from/to sides are open-ended. */
  dayInRange(iso, fromKey, toKey) {
    var day = this.dayKey(iso);
    var from = String(fromKey || "").trim();
    var to = String(toKey || "").trim();
    if (!from && !to) return true;
    if (!day) return false;
    if (from && to && from > to) {
      var swap = from;
      from = to;
      to = swap;
    }
    if (from && day < from) return false;
    if (to && day > to) return false;
    return true;
  },

  filtersAreActive(filters) {
    var f = filters || this.getTableFilters();
    return !!(
      f.load ||
      f.pickupDayFrom ||
      f.pickupDayTo ||
      f.deliveryDayFrom ||
      f.deliveryDayTo ||
      f.broker
    );
  },

  rowMatchesFilters(r, filters) {
    var f = filters || this.getTableFilters();
    var loadQ = String(f.load || "").trim().toLowerCase();
    if (loadQ) {
      var loadHay = String(r.loadNumber || r.greenOsShipmentId || "").toLowerCase();
      if (loadHay.indexOf(loadQ) < 0) return false;
    }
    if (!this.dayInRange(r.pickupDay, f.pickupDayFrom, f.pickupDayTo)) return false;
    if (!this.dayInRange(r.deliveryDay, f.deliveryDayFrom, f.deliveryDayTo)) return false;
    var brokerQ = String(f.broker || "").trim().toLowerCase();
    if (brokerQ) {
      var brokerHay = String(r.brokerName || "").toLowerCase();
      if (brokerHay.indexOf(brokerQ) < 0) return false;
    }
    return true;
  },

  dayRangeFieldHtml(label, fromKey, toKey) {
    var f = this.getTableFilters();
    return (
      '<div class="acc-filter-field acc-filter-range-field">' +
      '<span class="acc-filter-range-label">' +
      this.esc(label) +
      "</span>" +
      '<div class="acc-filter-range" role="group" aria-label="' +
      this.esc(label) +
      ' range">' +
      '<input type="date" data-acc-filter="' +
      this.esc(fromKey) +
      '" value="' +
      this.esc(f[fromKey] || "") +
      '" title="From" aria-label="' +
      this.esc(label) +
      ' from">' +
      '<span class="acc-filter-range-sep" aria-hidden="true">–</span>' +
      '<input type="date" data-acc-filter="' +
      this.esc(toKey) +
      '" value="' +
      this.esc(f[toKey] || "") +
      '" title="To" aria-label="' +
      this.esc(label) +
      ' to">' +
      "</div></div>"
    );
  },

  filterBarHtml() {
    var f = this.getTableFilters();
    return (
      '<div class="acc-table-filters" role="search" aria-label="Filter loads">' +
      '<label class="acc-filter-field">Load' +
      '<input type="search" data-acc-filter="load" value="' +
      this.esc(f.load || "") +
      '" placeholder="GL…" autocomplete="off"></label>' +
      this.dayRangeFieldHtml("Pickup day", "pickupDayFrom", "pickupDayTo") +
      this.dayRangeFieldHtml("Delivery day", "deliveryDayFrom", "deliveryDayTo") +
      '<label class="acc-filter-field">Broker' +
      '<input type="search" data-acc-filter="broker" value="' +
      this.esc(f.broker || "") +
      '" placeholder="Name…" autocomplete="off"></label>' +
      '<button type="button" class="btn-secondary acc-filter-clear" style="width:auto">Clear</button>' +
      "</div>"
    );
  },

  bindTableFilters(body, allRows, opts) {
    var self = this;
    if (!body) return;
    var options = opts || {};
    var showQueue = !!options.showQueue;
    var countEl = options.countEl || null;
    var totalCount = allRows ? allRows.length : 0;

    function readFilters() {
      var next = self.emptyTableFilters();
      body.querySelectorAll("[data-acc-filter]").forEach(function (input) {
        var key = input.getAttribute("data-acc-filter");
        if (key && Object.prototype.hasOwnProperty.call(next, key)) {
          next[key] = input.value || "";
        }
      });
      return next;
    }

    function apply() {
      self.setTableFilters(readFilters());
      var filters = self.getTableFilters();
      var filtered = (allRows || []).filter(function (r) {
        return self.rowMatchesFilters(r, filters);
      });
      var host = body.querySelector("[data-acc-table-host]");
      if (host) {
        host.innerHTML = self.shipmentsTableHtml(filtered, {
          showQueue: showQueue,
          skipFilterBar: true,
          allRows: allRows,
        });
        self.bindOpenHandlers(body);
        self.bindLoadSortHandlers(body, function () {
          apply();
        });
      }
      if (countEl) {
        countEl.textContent = self.filtersAreActive(filters)
          ? filtered.length + " of " + totalCount + " load" + (totalCount === 1 ? "" : "s")
          : totalCount + " load" + (totalCount === 1 ? "" : "s");
      }
    }

    body.querySelectorAll("[data-acc-filter]").forEach(function (input) {
      input.addEventListener("input", apply);
      input.addEventListener("change", apply);
      input.addEventListener("keyup", apply);
    });
    var clearBtn = body.querySelector(".acc-filter-clear");
    if (clearBtn) {
      clearBtn.addEventListener("click", function () {
        body.querySelectorAll("[data-acc-filter]").forEach(function (input) {
          input.value = "";
        });
        apply();
      });
    }
    self.bindLoadSortHandlers(body, function () {
      apply();
    });
  },

  loadSortHeaderHtml(label) {
    var dir = this._loadSortDir === "desc" ? "desc" : "asc";
    return (
      '<th class="acc-load-sort-th">' +
      '<span class="acc-load-sort-label">' +
      this.esc(label || "Load") +
      "</span>" +
      '<span class="acc-load-sort-arrows" role="group" aria-label="Sort by load number">' +
      '<button type="button" class="acc-load-sort-btn' +
      (dir === "asc" ? " is-active" : "") +
      '" data-acc-load-sort="asc" title="Ascending (10001 → 10002)">▲</button>' +
      '<button type="button" class="acc-load-sort-btn' +
      (dir === "desc" ? " is-active" : "") +
      '" data-acc-load-sort="desc" title="Descending (10068 → 10067)">▼</button>' +
      "</span></th>"
    );
  },

  bindLoadSortHandlers(root, onChange) {
    var self = this;
    if (!root) return;
    root.querySelectorAll("[data-acc-load-sort]").forEach(function (btn) {
      btn.addEventListener("click", function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        var next = btn.getAttribute("data-acc-load-sort") === "desc" ? "desc" : "asc";
        if (self._loadSortDir === next) return;
        self._loadSortDir = next;
        if (typeof onChange === "function") onChange(next);
      });
    });
  },

  /** Customer rate beside carrier rate. A +3% method adds that fee under the rate. */
  paymentsCell(r) {
    var accessorials = Number(r.accessorialCharges);
    if (!Number.isFinite(accessorials)) accessorials = 0;
    var hasCustomerRate = r.customerRate != null && r.customerRate !== "" && !Number.isNaN(Number(r.customerRate));
    var hasCarrierRate = r.carrierRate != null && r.carrierRate !== "" && !Number.isNaN(Number(r.carrierRate));
    var fee = Number(r.customerPaymentFee);
    if (!Number.isFinite(fee)) fee = 0;
    var customerDue =
      r.customerPays != null && r.customerPays !== "" && !Number.isNaN(Number(r.customerPays))
        ? Number(r.customerPays)
        : hasCustomerRate
          ? Number(r.customerRate) + accessorials + fee
          : null;
    var carrierDue = hasCarrierRate ? Number(r.carrierRate) : null;
    var customerPaid = Boolean(r.customerPaidAt);
    var carrierPaid = Boolean(r.carrierPaidAt);
    function due(amount, paid) {
      if (amount == null) return '<div class="acc-pay-due">—</div>';
      return (
        '<div class="acc-pay-due ' +
        (paid ? "is-paid" : "is-unpaid") +
        '">' +
        this.money(amount) +
        "</div>"
      );
    }
    var method = r.customerPaymentLabel
      ? '<div class="acc-pay-method">' + this.esc(r.customerPaymentLabel) + "</div>"
      : '<div class="acc-pay-method acc-pay-label">Payment option —</div>';
    var feeLine = "";
    if (fee > 0) {
      feeLine =
        '<div class="acc-pay-fee ' +
        (customerPaid ? "is-paid" : "is-unpaid") +
        '">+3% ' +
        this.money(fee) +
        "</div>";
    }
    return (
      '<div class="acc-pay-grid">' +
      '<div><div class="acc-pay-label">Customer rate</div><div class="acc-pay-rate">' +
      this.money(hasCustomerRate ? r.customerRate : null) +
      "</div>" +
      method +
      feeLine +
      due.call(this, customerDue, customerPaid) +
      "</div>" +
      '<div><div class="acc-pay-label">Carrier rate</div><div class="acc-pay-rate">' +
      this.money(hasCarrierRate ? r.carrierRate : null) +
      "</div>" +
      due.call(this, carrierDue, carrierPaid) +
      "</div>" +
      "</div>"
    );
  },

  paymentMethodOptions(selected, hideFee) {
    var methods = [
      ["WIRE", "Wire"],
      ["VENMO", "Venmo +3%"],
      ["PAYPAL", "PayPal +3%"],
      ["CREDIT_CARD", "Credit card +3%"],
      ["CASHAPP", "Cash App +3%"],
      ["ZELLE", "Zelle"],
      ["ACH", "ACH"],
    ];
    return (
      '<option value="">Select payment option</option>' +
      methods
        .map(function (pair) {
          var text = hideFee ? pair[1].replace(/ \+3%$/, "") : pair[1];
          return (
            '<option value="' +
            pair[0] +
            '" data-full="' +
            pair[1] +
            '"' +
            (selected === pair[0] ? " selected" : "") +
            ">" +
            text +
            "</option>"
          );
        })
        .join("")
    );
  },

  userMeta() {
    var u = window.GreenOSUser || (window.GreenOS && window.GreenOS.user) || {};
    return {
      role: u.role || "",
      sub: u.accountingSubRole || null,
      label: u.accountingLabel || "Accounting Team",
    };
  },

  /** Delete and Change next to Open. Team Lead keeps these on the Loads list only. */
  canManageLoads() {
    var r = this.userMeta().role;
    return r === "Accounting" || r === "Manager" || r === "Owner";
  },

  loadChangeStatuses() {
    return [
      ["LOAD_CREATED", "Load Created"],
      ["CARRIER_ASSIGNED", "Assign Carrier"],
      ["RATE_CON_GENERATED", "Rate Confirmation Generated"],
      ["CARRIER_ACCEPTED", "Carrier Accepted"],
      ["PICKUP", "Pickup"],
      ["IN_TRANSIT", "In Road"],
      ["DELIVERED", "Delivered"],
      ["POD_UPLOADED", "POD Uploaded"],
      ["CUSTOMER_INVOICE", "Customer Invoice"],
      ["CARRIER_PAYMENT", "Carrier Payment"],
      ["DISPATCH", "Dispatch"],
      ["COMPLETED", "Completed"],
      ["CLOSED", "Closed"],
    ];
  },

  async loadApi(path, opts) {
    opts = opts || {};
    var token = "";
    try {
      token = localStorage.getItem("gl_token") || sessionStorage.getItem("gl_token") || "";
    } catch (e) {}
    if (!token && window.GreenOSToken) token = window.GreenOSToken;
    var headers = { Accept: "application/json", "Content-Type": "application/json" };
    if (token) {
      headers.Authorization = "Bearer " + token;
      headers["X-GreenOS-Token"] = token;
    }
    var body = opts.body;
    if (body && token) body = Object.assign({ sessionToken: token }, body);
    var res = await fetch("/api/loads" + path, {
      method: opts.method || "GET",
      cache: "no-store",
      headers: headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    var json = await res.json().catch(function () {
      return { success: false, message: "Bad response" };
    });
    if (!res.ok || json.success === false) {
      throw new Error(json.message || "Request failed (" + res.status + ")");
    }
    return json;
  },

  filterForSub(subPageId) {
    if (subPageId === "document-review") return "documents";
    if (subPageId === "verified") return "verified";
    if (subPageId === "customer-billing") return "billing";
    if (subPageId === "customer-payments") return "customer-payments";
    if (subPageId === "carrier-payments") return "carrier-payment";
    if (subPageId === "history") return "history";
    return "all";
  },

  /** KPI meta: waiting-for-accounting queues use bright urgency tones when count > 0. */
  kpiMeta(key) {
    var map = {
      documentsToReview: {
        label: "Documents To Review",
        tone: "amber",
        pending: true,
        tab: "document-review",
      },
      needsCorrection: {
        label: "Needs Correction",
        tone: "red",
        pending: true,
        tab: "document-review",
      },
      readyForBilling: {
        label: "Ready For Billing",
        tone: "orange",
        pending: true,
        tab: "customer-billing",
      },
      invoicesOutstanding: {
        label: "Invoices Outstanding",
        tone: "amber",
        pending: true,
        tab: "customer-payments",
      },
      readyForCarrierPayment: {
        label: "Ready For Carrier Payment",
        tone: "blue",
        pending: true,
        tab: "carrier-payments",
      },
      overdueCustomerPayments: {
        label: "Overdue Customer Payments",
        tone: "red",
        pending: true,
        tab: "customer-payments",
      },
      customerPaymentsReceived: {
        label: "Customer Payments Received",
        tone: "green",
        pending: false,
        tab: "customer-payments",
      },
      carrierPaymentsCompleted: {
        label: "Carrier Payments Completed",
        tone: "green",
        pending: false,
        tab: "carrier-payments",
      },
      accountingClosed: {
        label: "Accounting Closed",
        tone: "green",
        pending: false,
        tab: "history",
      },
    };
    return (
      map[key] || {
        label: key,
        tone: "amber",
        pending: true,
        tab: "shipments",
      }
    );
  },

  kpiCard(key, count) {
    var meta = this.kpiMeta(key);
    var n = Number(count) || 0;
    var hot = meta.pending ? n > 0 : n > 0;
    var classes =
      "acc-kpi tone-" +
      meta.tone +
      (hot ? " is-hot" : " is-empty") +
      (meta.tab ? " is-clickable" : "");
    return (
      '<button type="button" class="' +
      classes +
      '" data-acc-tab="' +
      this.esc(meta.tab || "") +
      '" aria-label="' +
      this.esc(meta.label) +
      ": " +
      n +
      '">' +
      '<div class="label">' +
      this.esc(meta.label) +
      "</div>" +
      '<div class="value">' +
      this.esc(n) +
      "</div>" +
      "</button>"
    );
  },

  docStatusPill(status) {
    var s = String(status || "PENDING").toUpperCase();
    var cls = "acc-status-pill is-pending";
    if (s === "NEEDS_CORRECTION" || s.indexOf("CORRECTION") >= 0) cls = "acc-status-pill is-correction";
    else if (s === "VERIFIED" || s === "APPROVED") cls = "acc-status-pill is-verified";
    return '<span class="' + cls + '">' + this.esc(s) + "</span>";
  },

  rowUrgencyClass(r) {
    var status = String(r.status || "").toUpperCase();
    if (r.isVoided || status === "VOIDED") return "acc-row-voided";
    if (r.isReactivated) return "acc-row-reactivated";
    var doc = String(r.accountingDocStatus || "PENDING").toUpperCase();
    if (doc === "NEEDS_CORRECTION" || doc.indexOf("CORRECTION") >= 0) return "acc-row-correction";
    if (!r.accountingDocStatus || doc === "PENDING") return "acc-row-pending";
    if (r.accountingReadyForBilling && !r.customerPaidAt) return "acc-row-billing";
    if (r.accountingReadyForCarrierPayment && !r.carrierPaidAt) return "acc-row-carrier-pay";
    if (r.invoiceNumber && !r.customerPaidAt) return "acc-row-billing";
    return "";
  },

  /** Why this load still needs accounting attention (Dashboard queue labels). */
  pendingReasons(r) {
    var bits = [];
    var status = String(r.status || "").toUpperCase();
    if (r.isVoided || status === "VOIDED") {
      bits.push('<span class="acc-status-pill is-voided">Voided</span>');
      return bits.join(" ");
    }
    if (r.isReactivated) {
      bits.push('<span class="acc-status-pill is-reactivated">Reactivated</span>');
    }
    var doc = String(r.accountingDocStatus || "PENDING").toUpperCase();
    if (doc === "NEEDS_CORRECTION" || doc.indexOf("CORRECTION") >= 0) {
      bits.push('<span class="acc-status-pill is-correction">Needs Correction</span>');
    } else if (!r.accountingDocStatus || doc === "PENDING") {
      bits.push('<span class="acc-status-pill is-pending">Documents To Review</span>');
    }
    if (r.accountingReadyForBilling && !r.customerPaidAt && !r.invoiceNumber) {
      bits.push('<span class="acc-status-pill is-ready">Ready For Billing</span>');
    }
    if (r.invoiceNumber && !r.customerPaidAt) {
      bits.push('<span class="acc-status-pill is-ready">Invoice Outstanding</span>');
    }
    if (r.accountingReadyForCarrierPayment && !r.carrierPaidAt) {
      bits.push('<span class="acc-status-pill is-ready">Ready For Carrier Payment</span>');
    }
    return bits.length ? bits.join(" ") : '<span class="acc-status-pill is-pending">Awaiting</span>';
  },

  loadNumberCell(r) {
    var label = r.loadNumber || r.greenOsShipmentId || "—";
    var id = r.shipmentLeadId;
    if (!id) return this.esc(label);
    return (
      '<button type="button" class="acc-load-link acc-open" data-id="' +
      this.esc(id) +
      '" title="Open load ' +
      this.esc(label) +
      '">' +
      this.esc(label) +
      "</button>"
    );
  },

  bindOpenHandlers(body) {
    var self = this;
    if (!body) return;
    body.querySelectorAll(".acc-open").forEach(function (btn) {
      btn.addEventListener("click", function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        self.openShipmentModal(btn.getAttribute("data-id"));
      });
    });
    self.bindLoadManageHandlers(body);
  },

  openById(shipmentLeadId) {
    if (!shipmentLeadId) return;
    var self = this;
    try {
      sessionStorage.setItem("gos_open_accounting_load_id", shipmentLeadId);
    } catch (e) {}
    self._pendingOpenId = shipmentLeadId;
    var nav = window.GreenOSShell || window.GreenOS;
    var onAccounting =
      (nav && nav.currentModule === "accounting") ||
      Boolean(document.querySelector('[data-module="accounting"]'));
    if (onAccounting) {
      self.openShipmentModal(shipmentLeadId);
      try {
        sessionStorage.removeItem("gos_open_accounting_load_id");
      } catch (e2) {}
      self._pendingOpenId = null;
      return;
    }
    if (nav && typeof nav.navigate === "function") {
      nav.navigate("accounting", self._subPageId || "dashboard");
    }
  },

  openShipmentModal(id) {
    var self = this;
    var existing = document.getElementById("acc-modal");
    if (existing) existing.remove();
    var modal = document.createElement("div");
    modal.id = "acc-modal";
    modal.className = "crm-modal acc-profile-modal";
    modal.innerHTML =
      '<div class="crm-modal-card acc-profile-card">' +
      '<div id="acc-detail" class="acc-profile-host"></div></div>';
    document.body.appendChild(modal);
    function close() {
      if (modal.parentNode) modal.remove();
      document.removeEventListener("keydown", onKey);
    }
    modal.addEventListener("click", function (ev) {
      if (ev.target === modal) close();
    });
    function onKey(ev) {
      if (ev.key === "Escape") close();
    }
    document.addEventListener("keydown", onKey);
    self._closeProfile = close;
    if (!id) {
      modal.querySelector("#acc-detail").innerHTML =
        '<p style="color:#ef4444">This load has no id, so it cannot be opened.</p>';
      return;
    }
    self.openShipment(modal.querySelector("#acc-detail"), id);
  },

  statusBadgeText(status) {
    return String(status || "—")
      .replace(/_/g, " ")
      .trim();
  },

  formatDateTime(iso) {
    if (!iso) return "—";
    try {
      var d = new Date(iso);
      if (Number.isNaN(d.getTime())) return "—";
      return d.toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch (e) {
      return "—";
    }
  },

  findDoc(docs, docType) {
    var want = String(docType || "").toUpperCase();
    return (docs || []).find(function (d) {
      return String(d.docType || "").toUpperCase() === want;
    });
  },

  docReady(doc) {
    if (!doc) return false;
    if (doc.openUrl) return true;
    var st = String(doc.status || "").toUpperCase();
    return st === "READY" || st === "UPLOADED" || st === "CURRENT" || st === "VERIFIED";
  },

  /** All broker + carrier documents for this load (API already merged). */
  isCustomerDoc(doc) {
    var t = String((doc && doc.docType) || "").toUpperCase();
    return t === "CUSTOMER_AGREEMENT" || t === "CUSTOMER_INVOICE" || t === "CUSTOMER_PAID_PROOF";
  },

  profileDocumentsHtml(docs, emptyText) {
    var self = this;
    var rows = docs || [];
    if (!rows.length) {
      return (
        '<li class="gos-muted" style="padding:0.4rem 0">' +
        self.esc(emptyText || "No documents uploaded for this load yet.") +
        "</li>"
      );
    }
    return rows
      .map(function (doc) {
        var ready = self.docReady(doc) && Boolean(doc.openUrl);
        var label = doc.label || doc.docType || "Document";
        var who = doc.uploadedBy || (doc.source === "carrier" ? "Carrier" : "Broker");
        var actions = "";
        if (ready && doc.openUrl) {
          actions +=
            '<button type="button" class="acc-doc-icon acc-doc-file" data-url="' +
            self.esc(doc.openUrl) +
            '" data-name="' +
            self.esc(doc.fileName || label) +
            '" data-mime="' +
            self.esc(doc.mimeType || "application/pdf") +
            '" title="View">View</button>';
          actions +=
            '<button type="button" class="acc-doc-icon acc-doc-file" data-url="' +
            self.esc(doc.openUrl) +
            '" data-name="' +
            self.esc(doc.fileName || label) +
            '" data-mime="' +
            self.esc(doc.mimeType || "application/pdf") +
            '" data-download="1" title="Download">Download</button>';
        }
        if (doc.source === "load") {
          actions +=
            '<button type="button" class="acc-doc-upload-btn" data-doc-type="' +
            self.esc(doc.docType) +
            '">' +
            (ready ? "Replace" : "Upload") +
            "</button>";
        }
        return (
          '<li class="acc-doc-row">' +
          '<span class="acc-doc-dot' +
          (ready ? " is-ready" : "") +
          '"></span>' +
          '<span class="acc-doc-name">' +
          self.esc(label) +
          ' <span class="acc-doc-who">' +
          self.esc(who) +
          "</span></span>" +
          (ready
            ? self.pill(String(doc.status || "READY").toUpperCase(), "ok")
            : self.pill("MISSING", "muted")) +
          '<span class="acc-doc-actions">' +
          actions +
          "</span></li>"
        );
      })
      .join("");
  },

  yesNo(v) {
    return v ? "Yes" : "No";
  },

  pill(text, tone) {
    return (
      '<span class="acc-pill tone-' +
      this.esc(tone || "muted") +
      '">' +
      this.esc(text) +
      "</span>"
    );
  },

  neighborLoadIds(id) {
    var rows = this._tableRows || [];
    var idx = -1;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i] && rows[i].shipmentLeadId === id) {
        idx = i;
        break;
      }
    }
    return {
      prev: idx > 0 ? rows[idx - 1].shipmentLeadId : null,
      next: idx >= 0 && idx < rows.length - 1 ? rows[idx + 1].shipmentLeadId : null,
    };
  },

  invoiceFileAccept() {
    return "application/pdf,.pdf,image/*,.png,.jpg,.jpeg,.webp";
  },

  /** Visually-hidden file input + label (HTML hidden blocks programmatic .click() in some browsers). */
  invoiceUploadControlHtml(docType, labelText) {
    var id =
      "acc-file-" +
      String(docType || "doc")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-");
    return (
      '<input type="file" id="' +
      this.esc(id) +
      '" class="acc-file-input" data-doc-type="' +
      this.esc(docType) +
      '" accept="' +
      this.esc(this.invoiceFileAccept()) +
      '">' +
      '<label for="' +
      this.esc(id) +
      '" class="btn-secondary acc-invoice-add-label">' +
      this.esc(labelText) +
      "</label>"
    );
  },

  openFilePicker(input) {
    if (!input) return false;
    try {
      input.value = "";
    } catch (e) {
      /* ignore */
    }
    try {
      if (typeof input.showPicker === "function") {
        input.showPicker();
        return true;
      }
    } catch (e) {
      /* fall through to click() */
    }
    try {
      input.click();
      return true;
    } catch (e2) {
      return false;
    }
  },

  async uploadLoadDoc(id, docType, file) {
    var token = "";
    try {
      token = localStorage.getItem("gl_token") || sessionStorage.getItem("gl_token") || "";
    } catch (e) {}
    if (!token && window.GreenOSToken) token = window.GreenOSToken;
    if (!file) throw new Error("Choose a file to upload");
    if (!docType) throw new Error("Document type is missing");
    var form = new FormData();
    form.append("file", file);
    if (token) form.append("sessionToken", token);
    var headers = { Accept: "application/json" };
    if (token) {
      headers.Authorization = "Bearer " + token;
      headers["X-GreenOS-Token"] = token;
    }
    var path =
      docType === "POD"
        ? "/" + encodeURIComponent(id) + "/documents/POD/upload"
        : "/" + encodeURIComponent(id) + "/documents/" + encodeURIComponent(docType) + "/upload";
    var res = await fetch("/api/loads" + path, {
      method: "POST",
      cache: "no-store",
      headers: headers,
      body: form,
    });
    var json = await res.json().catch(function () {
      return { success: false, message: "Bad response" };
    });
    if (!res.ok || json.success === false) {
      throw new Error(json.message || "Upload failed (" + res.status + ")");
    }
    return json;
  },

  refreshLoads(body) {
    if (!body) return;
    var sub = this._subPageId || "dashboard";
    if (!sub || sub === "dashboard") this.renderDashboard(body);
    else this.renderList(body, sub);
  },

  bindLoadManageHandlers(body) {
    var self = this;
    if (!body || !self.canManageLoads()) return;
    var table = body.querySelector(".emp-users-table");
    var cols = table ? table.querySelectorAll("thead th").length : 6;
    function field(label, name, value) {
      return (
        "<label>" +
        self.esc(label) +
        '<input name="' +
        name +
        '" value="' +
        self.esc(value || "") +
        '"></label>'
      );
    }
    body.querySelectorAll(".acc-change").forEach(function (btn) {
      btn.addEventListener("click", function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        var id = btn.getAttribute("data-id");
        var row = (self._tableRows || []).filter(function (item) {
          return item.shipmentLeadId === id;
        })[0];
        var tr = btn.closest("tr");
        var next = tr && tr.nextElementSibling;
        if (next && next.classList.contains("acc-change-row") && next.getAttribute("data-id") === id) {
          next.remove();
          return;
        }
        body.querySelectorAll(".acc-change-row").forEach(function (open) {
          open.remove();
        });
        if (!tr || !row) return;
        var options = self
          .loadChangeStatuses()
          .map(function (pair) {
            return (
              '<option value="' +
              pair[0] +
              '"' +
              (row.status === pair[0] ? " selected" : "") +
              ">" +
              self.esc(pair[1]) +
              "</option>"
            );
          })
          .join("");
        var editor = document.createElement("tr");
        editor.className = "acc-change-row";
        editor.setAttribute("data-id", id);
        editor.innerHTML =
          '<td colspan="' +
          cols +
          '"><form class="load-change-form acc-change-form">' +
          field("Customer", "customerName", row.customerName) +
          field("Pickup city", "pickupCity", row.pickupCity) +
          field("Pickup state", "pickupState", row.pickupState) +
          field("Delivery city", "deliveryCity", row.deliveryCity) +
          field("Delivery state", "deliveryState", row.deliveryState) +
          field("Carrier", "carrierName", row.carrierName) +
          '<label>Status<select name="status">' +
          options +
          "</select></label>" +
          '<button type="submit" class="btn-primary">Save</button>' +
          '<button type="button" class="btn-secondary acc-change-cancel">Cancel</button>' +
          '<span class="gos-muted load-change-msg"></span>' +
          "</form></td>";
        tr.insertAdjacentElement("afterend", editor);
        editor.querySelector(".acc-change-cancel").addEventListener("click", function () {
          editor.remove();
        });
        editor.querySelector("form").addEventListener("submit", async function (submitEv) {
          submitEv.preventDefault();
          var form = submitEv.target;
          var msg = editor.querySelector(".load-change-msg");
          function fieldValue(name) {
            var el = form.elements.namedItem(name);
            return el ? el.value : "";
          }
          var payload = {
            customerName: fieldValue("customerName"),
            pickupCity: fieldValue("pickupCity"),
            pickupState: fieldValue("pickupState"),
            deliveryCity: fieldValue("deliveryCity"),
            deliveryState: fieldValue("deliveryState"),
            carrierName: fieldValue("carrierName"),
            status: fieldValue("status"),
          };
          if (msg) msg.textContent = "Saving…";
          try {
            await self.loadApi("/" + encodeURIComponent(id), { method: "PATCH", body: payload });
            self.refreshLoads(body);
          } catch (err) {
            if (msg) msg.textContent = err.message || "Could not save";
          }
        });
      });
    });
    body.querySelectorAll(".acc-load-delete").forEach(function (btn) {
      btn.addEventListener("click", async function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        var id = btn.getAttribute("data-id");
        var num = btn.getAttribute("data-load") || "this load";
        if (!confirm("Delete load " + num + "? This removes it from Loads.")) return;
        btn.disabled = true;
        try {
          await self.loadApi("/" + encodeURIComponent(id), { method: "DELETE" });
          if (self._selectedId === id) self._selectedId = null;
          self.refreshLoads(body);
        } catch (err) {
          btn.disabled = false;
          alert(err.message || "Could not delete the load");
        }
      });
    });
  },

  shipmentsTableHtml(rows, opts) {
    var self = this;
    var options = opts || {};
    var showQueue = !!options.showQueue;
    var skipFilterBar = !!options.skipFilterBar;
    var sourceRows = self.sortRowsByLoadNumber(options.allRows || rows || []);
    self._tableRows = sourceRows;
    var displayRows = rows || [];
    if (!skipFilterBar) {
      displayRows = sourceRows.filter(function (r) {
        return self.rowMatchesFilters(r);
      });
    } else {
      displayRows = self.sortRowsByLoadNumber(displayRows);
    }
    var head =
      self.loadSortHeaderHtml("Load") +
      "<th>Customer</th><th>Carrier</th>" +
      "<th>Pickup day</th><th>Delivery day</th>" +
      (showQueue ? "<th>Waiting for</th>" : "<th>Doc status</th><th>Ready</th>") +
      "<th>Broker</th><th>Payments</th><th></th>";
    var bodyRows = displayRows
      .map(function (r) {
        var urgency = self.rowUrgencyClass(r);
        var mid;
        if (showQueue) {
          mid = "<td>" + self.pendingReasons(r) + "</td>";
        } else {
          var readyBits = [];
          if (r.accountingReadyForBilling) {
            readyBits.push('<span class="acc-status-pill is-ready">Billing</span>');
          }
          if (r.accountingReadyForCarrierPayment) {
            readyBits.push('<span class="acc-status-pill is-ready">Carrier$</span>');
          }
          mid =
            "<td>" +
            self.docStatusPill(r.accountingDocStatus || "PENDING") +
            "</td>" +
            "<td>" +
            (readyBits.length ? readyBits.join(" ") : "—") +
            "</td>";
        }
        return (
          '<tr class="' +
          urgency +
          '">' +
          "<td>" +
          self.loadNumberCell(r) +
          "</td>" +
          "<td>" +
          self.esc(r.customerName || "—") +
          "</td>" +
          "<td>" +
          self.esc(r.carrierName || "—") +
          "</td>" +
          "<td>" +
          self.esc(self.formatDay(r.pickupDay)) +
          "</td>" +
          "<td>" +
          self.esc(self.formatDay(r.deliveryDay)) +
          "</td>" +
          mid +
          "<td>" +
          self.esc(r.brokerName || "—") +
          "</td>" +
          "<td class=\"acc-pay-cell\">" +
          self.paymentsCell(r) +
          "</td>" +
          '<td class="acc-row-actions">' +
          (self.canManageLoads()
            ? '<button type="button" class="btn-secondary acc-change" data-id="' +
              self.esc(r.shipmentLeadId) +
              '">Change</button>' +
              '<button type="button" class="btn-secondary acc-load-delete" data-id="' +
              self.esc(r.shipmentLeadId) +
              '" data-load="' +
              self.esc(r.loadNumber || "") +
              '">Delete</button>'
            : "") +
          '<button type="button" class="btn-primary acc-open" data-id="' +
          self.esc(r.shipmentLeadId) +
          '">Open</button></td>' +
          "</tr>"
        );
      })
      .join("");
    if (!bodyRows) {
      var colCount = showQueue ? 9 : 10;
      bodyRows =
        '<tr class="acc-filter-empty"><td colspan="' +
        colCount +
        '"><p class="gos-muted" style="margin:0.5rem 0">No loads match these filters.</p></td></tr>';
    }
    var tableOnly =
      '<table class="emp-users-table"><thead><tr>' +
      head +
      "</tr></thead><tbody>" +
      bodyRows +
      "</tbody></table>";
    if (skipFilterBar) return tableOnly;
    return (
      self.filterBarHtml() +
      '<div class="emp-users-wrap" data-acc-table-host>' +
      tableOnly +
      "</div>"
    );
  },

  render(root, subPageId) {
    if (!root) return;
    var self = this;
    var children = this.children || [];
    var active =
      children.find(function (c) {
        return c.id === subPageId;
      }) || children[0];
    this._subPageId = (active && active.id) || "dashboard";
    this.startIdleRefresh(root);
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

    var openId = self._pendingOpenId || null;
    try {
      if (!openId) openId = sessionStorage.getItem("gos_open_accounting_load_id");
      if (openId) sessionStorage.removeItem("gos_open_accounting_load_id");
    } catch (e) {}
    self._pendingOpenId = null;
    if (openId) {
      setTimeout(function () {
        self.openShipmentModal(openId);
      }, 0);
    }
  },

  dashMoney(n) {
    var v = Number(n);
    if (!Number.isFinite(v)) return "$0.00";
    return (
      "$" +
      v.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })
    );
  },

  dashSummaryCard(label, valueHtml, deltaHtml, tone) {
    return (
      '<article class="acc-dash-summary-card tone-' +
      this.esc(tone || "green") +
      '"><div class="acc-dash-summary-label">' +
      this.esc(label) +
      '</div><div class="acc-dash-summary-value">' +
      valueHtml +
      "</div>" +
      (deltaHtml ? '<div class="acc-dash-summary-delta">' + deltaHtml + "</div>" : "") +
      "</article>"
    );
  },

  accountingQueueLabel(r) {
    if (r.customerPaidAt && r.carrierPaidAt) return { text: "Paid", tone: "paid" };
    if (r.accountingReadyForCarrierPayment && !r.carrierPaidAt) {
      return { text: "Ready for Carrier Pay", tone: "carrier" };
    }
    if (r.accountingReadyForBilling && !r.customerPaidAt) {
      return { text: "Ready for Billing", tone: "billing" };
    }
    var doc = String(r.accountingDocStatus || "PENDING").toUpperCase();
    if (doc === "NEEDS_CORRECTION" || doc.indexOf("CORRECTION") >= 0) {
      return { text: "Needs Correction", tone: "review" };
    }
    return { text: "In Review", tone: "review" };
  },

  podPill(r) {
    var st = String(r.status || "").toUpperCase();
    var uploaded =
      st === "POD_UPLOADED" ||
      st === "CUSTOMER_INVOICE" ||
      st === "CARRIER_PAYMENT" ||
      st === "CLOSED" ||
      st === "COMPLETED";
    return uploaded
      ? '<span class="acc-mini-pill is-ok">Uploaded</span>'
      : '<span class="acc-mini-pill is-warn">Pending</span>';
  },

  invCustPill(r) {
    if (r.invoiceNumber) return '<span class="acc-mini-pill is-ok">Ready</span>';
    if (r.accountingReadyForBilling) return '<span class="acc-mini-pill is-warn">Pending</span>';
    return '<span class="acc-mini-pill is-muted">—</span>';
  },

  invCarrPill(r) {
    if (r.carrierPaidAt) return '<span class="acc-mini-pill is-ok">Ready</span>';
    if (r.accountingReadyForCarrierPayment) {
      return '<span class="acc-mini-pill is-warn">Pending</span>';
    }
    return '<span class="acc-mini-pill is-muted">—</span>';
  },

  loadNumberSortKey(loadNumber) {
    var digits = String(loadNumber || "").replace(/\D+/g, "");
    if (!digits) return Number.MAX_SAFE_INTEGER;
    var n = Number(digits);
    return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
  },

  sortRowsByLoadNumber(rows, dir) {
    var self = this;
    var direction = dir || self._loadSortDir || "asc";
    var mult = direction === "desc" ? -1 : 1;
    return (rows || []).slice().sort(function (a, b) {
      var diff =
        self.loadNumberSortKey(a && a.loadNumber) - self.loadNumberSortKey(b && b.loadNumber);
      if (diff !== 0) return diff * mult;
      return (
        String((a && a.loadNumber) || "").localeCompare(String((b && b.loadNumber) || "")) * mult
      );
    });
  },

  filterDashboardRows(rows, queue) {
    var list = rows || [];
    var filtered;
    if (queue === "billing") {
      filtered = list.filter(function (r) {
        return r.accountingReadyForBilling && !r.customerPaidAt;
      });
    } else if (queue === "carrier") {
      filtered = list.filter(function (r) {
        return r.accountingReadyForCarrierPayment && !r.carrierPaidAt;
      });
    } else if (queue === "paid") {
      filtered = list.filter(function (r) {
        return Boolean(r.customerPaidAt) && Boolean(r.carrierPaidAt);
      });
    } else if (queue === "all") {
      filtered = list.slice();
    } else {
      filtered = list.filter(function (r) {
        if (r.accountingClosedAt) return false;
        var doc = String(r.accountingDocStatus || "PENDING").toUpperCase();
        var docPending =
          !r.accountingDocStatus || doc === "PENDING" || doc.indexOf("CORRECTION") >= 0;
        var billingReady = Boolean(r.accountingReadyForBilling) && !r.customerPaidAt;
        var carrierReady = Boolean(r.accountingReadyForCarrierPayment) && !r.carrierPaidAt;
        var invoiceOut = Boolean(r.invoiceNumber) && !r.customerPaidAt;
        return docPending || billingReady || carrierReady || invoiceOut;
      });
    }
    return this.sortRowsByLoadNumber(filtered);
  },

  dashboardTableHtml(rows) {
    var self = this;
    var sorted = self.sortRowsByLoadNumber(rows || []);
    var bodyRows = sorted
      .slice(0, 12)
      .map(function (r) {
        var status = self.accountingQueueLabel(r);
        return (
          "<tr>" +
          '<td class="acc-dash-check"><input type="checkbox" aria-label="Select load"></td>' +
          "<td>" +
          self.loadNumberCell(r) +
          "</td>" +
          "<td>" +
          self.esc(r.customerName || "—") +
          "</td>" +
          "<td>" +
          self.esc(r.carrierName || "—") +
          "</td>" +
          "<td>" +
          self.esc(self.money(r.customerRate)) +
          "</td>" +
          "<td>" +
          self.esc(self.money(r.carrierRate)) +
          "</td>" +
          "<td>" +
          self.podPill(r) +
          "</td>" +
          "<td>" +
          self.invCustPill(r) +
          "</td>" +
          "<td>" +
          self.invCarrPill(r) +
          "</td>" +
          "<td>" +
          '<span class="acc-queue-pill tone-' +
          self.esc(status.tone) +
          '">' +
          self.esc(status.text) +
          "</span></td>" +
          '<td class="acc-row-actions">' +
          '<button type="button" class="btn-primary acc-open" data-id="' +
          self.esc(r.shipmentLeadId) +
          '">Open</button></td>' +
          "</tr>"
        );
      })
      .join("");
    if (!bodyRows) {
      bodyRows =
        '<tr><td colspan="11"><p class="gos-muted" style="margin:0.6rem 0">No loads in this queue.</p></td></tr>';
    }
    return (
      '<div class="emp-users-wrap acc-dash-table-wrap"><table class="emp-users-table acc-dash-table">' +
      "<thead><tr>" +
      "<th></th>" +
      self.loadSortHeaderHtml("Load") +
      "<th>Customer</th><th>Carrier</th>" +
      "<th>Customer Rate</th><th>Carrier Rate</th>" +
      "<th>POD</th><th>Inv. (Cust.)</th><th>Inv. (Carrier)</th>" +
      "<th>Status</th><th></th>" +
      "</tr></thead><tbody>" +
      bodyRows +
      "</tbody></table></div>"
    );
  },

  agingBarHtml(aging) {
    var total = Math.max(Number(aging && aging.total) || 0, 0.01);
    var current = Number(aging && aging.current) || 0;
    var mid = Number(aging && aging.mid) || 0;
    var old = Number(aging && aging.old) || 0;
    return (
      '<div class="acc-aging-bar" aria-hidden="true">' +
      '<span class="is-current" style="width:' +
      ((current / total) * 100).toFixed(2) +
      '%"></span>' +
      '<span class="is-mid" style="width:' +
      ((mid / total) * 100).toFixed(2) +
      '%"></span>' +
      '<span class="is-old" style="width:' +
      ((old / total) * 100).toFixed(2) +
      '%"></span>' +
      "</div>" +
      '<div class="acc-aging-legend">' +
      "<span><i class=\"is-current\"></i>Current (0–30)</span>" +
      "<span><i class=\"is-mid\"></i>31–60</span>" +
      "<span><i class=\"is-old\"></i>61+</span>" +
      "</div>"
    );
  },

  trendChartHtml(trend) {
    var rows = trend || [];
    var max = 1;
    rows.forEach(function (w) {
      max = Math.max(max, Number(w.billed) || 0, Number(w.paid) || 0);
    });
    var bars = rows
      .map(function (w) {
        var billedH = Math.max(4, Math.round(((Number(w.billed) || 0) / max) * 100));
        var paidH = Math.max(4, Math.round(((Number(w.paid) || 0) / max) * 100));
        return (
          '<div class="acc-trend-col">' +
          '<div class="acc-trend-bars">' +
          '<span class="is-billed" style="height:' +
          billedH +
          '%" title="Billed ' +
          this.dashMoney(w.billed) +
          '"></span>' +
          '<span class="is-paid" style="height:' +
          paidH +
          '%" title="Paid ' +
          this.dashMoney(w.paid) +
          '"></span>' +
          "</div>" +
          '<div class="acc-trend-label">' +
          this.esc(w.label || "") +
          "</div></div>"
        );
      }, this)
      .join("");
    return (
      '<div class="acc-trend-chart">' +
      bars +
      "</div>" +
      '<div class="acc-trend-legend"><span><i class="is-billed"></i>Billed (AR)</span>' +
      '<span><i class="is-paid"></i>Paid (AP)</span></div>'
    );
  },

  readinessDonutHtml(ready) {
    var pct = Math.max(0, Math.min(100, Number(ready && ready.percentComplete) || 0));
    var missing = Number(ready && ready.missing) || 0;
    var action = Number(ready && ready.actionRequired) || 0;
    var complete = Number(ready && ready.complete) || 0;
    var total = Math.max(complete + missing + action, 1);
    var missPct = Math.round((missing / total) * 100);
    var actPct = Math.round((action / total) * 100);
    var compPct = Math.max(0, 100 - missPct - actPct);
    var grad =
      "conic-gradient(#34d399 0 " +
      compPct +
      "%, #fbbf24 " +
      compPct +
      "% " +
      (compPct + missPct) +
      "%, #f87171 " +
      (compPct + missPct) +
      "% 100%)";
    return (
      '<div class="acc-ready-wrap">' +
      '<div class="acc-ready-donut" style="background:' +
      grad +
      '"><div class="acc-ready-hole"><strong>' +
      pct +
      "%</strong><span>Complete</span></div></div>" +
      '<ul class="acc-ready-legend">' +
      "<li><i class=\"is-complete\"></i>Complete <strong>" +
      pct +
      "%</strong></li>" +
      "<li><i class=\"is-missing\"></i>Missing Docs <strong>" +
      missPct +
      "%</strong></li>" +
      "<li><i class=\"is-action\"></i>Action Required <strong>" +
      actPct +
      "%</strong></li>" +
      "</ul></div>"
    );
  },

  async renderDashboard(body) {
    if (!body) return;
    var self = this;
    body.innerHTML = '<p class="gos-muted">Loading dashboard…</p>';
    try {
      var results = await Promise.all([
        this.api("/dashboard"),
        this.api("/shipments?filter=all"),
      ]);
      var res = results[0];
      var listRes = results[1];
      if (!res.success) {
        body.innerHTML =
          '<p style="color:#ef4444">' + self.esc(res.message || "Access denied") + "</p>";
        return;
      }
      var data = res.data || {};
      var summary = data.summary || {};
      var queues = data.queues || {};
      var tasks = data.tasks || [];
      var allRows = listRes && listRes.success ? listRes.data || [] : [];
      self._dashAllRows = allRows;
      self._dashQueue = self._dashQueue || "review";

      function goTab(tab) {
        if (!tab) return;
        if (window.GreenOS && typeof window.GreenOS.navigate === "function") {
          window.GreenOS.navigate("accounting", tab);
        } else {
          self.render(document.getElementById("gos-module-host") || body.parentElement, tab);
        }
      }

      function paintQueue(queue) {
        self._dashQueue = queue || "review";
        var filtered = self.filterDashboardRows(allRows, self._dashQueue);
        var host = body.querySelector("#acc-dash-table-host");
        if (host) host.innerHTML = self.dashboardTableHtml(filtered);
        body.querySelectorAll("[data-dash-queue]").forEach(function (btn) {
          btn.classList.toggle(
            "is-active",
            btn.getAttribute("data-dash-queue") === self._dashQueue
          );
        });
        self.bindOpenHandlers(body);
        self.bindLoadSortHandlers(body, function () {
          paintQueue(self._dashQueue);
        });
      }

      var summaryHtml =
        self.dashSummaryCard(
          "Total Loads",
          self.esc(String(summary.totalLoads || 0)),
          "",
          "green"
        ) +
        self.dashSummaryCard(
          "Ready for Billing",
          self.esc(String(summary.readyForBilling || 0)),
          "",
          "mint"
        ) +
        self.dashSummaryCard(
          "Ready for Carrier Pay",
          self.esc(String(summary.readyForCarrierPay || 0)),
          "",
          "blue"
        ) +
        self.dashSummaryCard(
          "A/R (To Receive)",
          self.esc(self.dashMoney(summary.arToReceive)),
          "",
          "money"
        ) +
        self.dashSummaryCard(
          "A/P (To Pay)",
          self.esc(self.dashMoney(summary.apToPay)),
          "",
          "money"
        );

      var queueTabs =
        '<button type="button" class="acc-dash-tab" data-dash-queue="review">Loads for Accounting (' +
        self.esc(String(queues.forReview || 0)) +
        ")</button>" +
        '<button type="button" class="acc-dash-tab" data-dash-queue="billing">Ready for Billing (' +
        self.esc(String(queues.readyBilling || 0)) +
        ")</button>" +
        '<button type="button" class="acc-dash-tab" data-dash-queue="carrier">Ready for Carrier Pay (' +
        self.esc(String(queues.readyCarrierPay || 0)) +
        ")</button>" +
        '<button type="button" class="acc-dash-tab" data-dash-queue="paid">Paid (' +
        self.esc(String(queues.paid || 0)) +
        ")</button>" +
        '<button type="button" class="acc-dash-tab" data-dash-queue="all">All Loads</button>';

      var tasksHtml = tasks
        .map(function (t) {
          return (
            '<button type="button" class="acc-task-row" data-acc-tab="' +
            self.esc(t.tab || "") +
            '"><span class="acc-task-check" aria-hidden="true"></span>' +
            "<span>" +
            self.esc(t.label || "") +
            '</span><strong>' +
            self.esc(String(t.count || 0)) +
            "</strong></button>"
          );
        })
        .join("");

      body.innerHTML =
        '<section class="acc-dash">' +
        '<header class="acc-dash-head">' +
        "<div><h2>Accounting Dashboard</h2>" +
        '<p class="gos-muted">Financial operations, billing, and carrier payments for Green Logistics.</p></div>' +
        '<div class="acc-dash-range">Last 30 Days</div>' +
        "</header>" +
        '<div class="acc-dash-summary">' +
        summaryHtml +
        "</div>" +
        '<div class="acc-dash-main">' +
        '<div class="acc-dash-board">' +
        '<div class="acc-dash-board-top">' +
        '<div class="acc-dash-tabs">' +
        queueTabs +
        "</div></div>" +
        '<div id="acc-dash-table-host"></div>' +
        "</div>" +
        '<aside class="acc-dash-tasks"><h3>Accounting Tasks</h3>' +
        '<div class="acc-task-list">' +
        (tasksHtml || '<p class="gos-muted">No open tasks.</p>') +
        "</div></aside>" +
        "</div>" +
        '<div class="acc-dash-widgets">' +
        '<section class="acc-dash-widget"><h3>Accounts Receivable (A/R)</h3>' +
        '<div class="acc-dash-widget-value">' +
        self.esc(self.dashMoney((data.arAging && data.arAging.total) || summary.arToReceive)) +
        "</div>" +
        self.agingBarHtml(data.arAging || {}) +
        "</section>" +
        '<section class="acc-dash-widget"><h3>Accounts Payable (A/P)</h3>' +
        '<div class="acc-dash-widget-value">' +
        self.esc(self.dashMoney((data.apAging && data.apAging.total) || summary.apToPay)) +
        "</div>" +
        self.agingBarHtml(data.apAging || {}) +
        "</section>" +
        '<section class="acc-dash-widget"><h3>Billing &amp; Payments Trend</h3>' +
        self.trendChartHtml(data.trend || []) +
        "</section>" +
        '<section class="acc-dash-widget"><h3>Document Readiness</h3>' +
        self.readinessDonutHtml(data.documentReadiness || {}) +
        "</section>" +
        "</div>" +
        '<div id="acc-detail" style="margin-top:1.25rem"></div>' +
        "</section>";

      paintQueue(self._dashQueue);
      body.querySelectorAll("[data-dash-queue]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          paintQueue(btn.getAttribute("data-dash-queue"));
        });
      });
      body.querySelectorAll("[data-acc-tab]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          goTab(btn.getAttribute("data-acc-tab"));
        });
      });
      if (!listRes || !listRes.success) {
        var host = body.querySelector("#acc-dash-table-host");
        if (host) {
          host.innerHTML =
            '<p style="color:#ef4444">' +
            self.esc((listRes && listRes.message) || "Could not load loads") +
            "</p>";
        }
      }
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
      body.innerHTML =
        self.shipmentsTableHtml(rows, { showQueue: false, allRows: rows }) +
        '<div id="acc-detail" style="margin-top:1.25rem"></div>';
      self.bindTableFilters(body, rows, { showQueue: false });
      self.bindOpenHandlers(body);
      if (self._selectedId) {
        self.openShipment(body.querySelector("#acc-detail"), self._selectedId);
      }
    } catch (err) {
      body.innerHTML =
        '<p style="color:#ef4444">' + self.esc(err.message || "Failed to load") + "</p>";
    }
  },

  async openDocumentFile(url, filename, mime, asDownload) {
    if (!url) return;
    var token = "";
    try {
      token = localStorage.getItem("gl_token") || sessionStorage.getItem("gl_token") || "";
    } catch (e) {}
    if (!token && window.GreenOSToken) token = window.GreenOSToken;
    var headers = { Accept: "application/pdf,image/*,*/*" };
    if (token) {
      headers.Authorization = "Bearer " + token;
      headers["X-GreenOS-Token"] = token;
    }
    try {
      var res = await fetch(url, { headers: headers, cache: "no-store" });
      var headerType = String(res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      if (!res.ok || headerType.indexOf("application/json") === 0 || headerType.indexOf("text/html") === 0) {
        var errBody = await res.json().catch(function () { return {}; });
        throw new Error(errBody.message || "Could not open the file");
      }
      var type = headerType;
      var hinted = String(mime || "").toLowerCase();
      var name = String(filename || "document.pdf");
      if (!type || type === "application/octet-stream") type = hinted || "application/pdf";
      if (hinted.indexOf("pdf") >= 0 || /\.pdf$/i.test(name) || type === "application/pdf" || type === "application/x-pdf") {
        type = "application/pdf";
      }
      var bytes = await res.arrayBuffer();
      var blob = new Blob([bytes], { type: type || "application/pdf" });
      var obj = URL.createObjectURL(blob);
      if (asDownload) {
        var a = document.createElement("a");
        a.href = obj;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () {
          URL.revokeObjectURL(obj);
        }, 1500);
        return;
      }
      var opened = window.open(obj, "_blank", "noopener");
      if (!opened) alert("Allow pop-ups to view the PDF.");
    } catch (err) {
      alert(err.message || "Could not open the file");
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
      var lane = d.lane || {};
      var ident = d.identity || {};
      var pod = d.pod || {};
      var loadNo = ident.loadNumber || id;
      var neighbors = self.neighborLoadIds(id);
      var allDocs = d.documents || [];
      var customerDocs = allDocs.filter(function (doc) {
        return self.isCustomerDoc(doc);
      });
      var carrierDocs = allDocs.filter(function (doc) {
        return !self.isCustomerDoc(doc);
      });
      var custReady = customerDocs.filter(function (doc) {
        return self.docReady(doc) && doc.openUrl;
      }).length;
      var carrierReady = carrierDocs.filter(function (doc) {
        return self.docReady(doc) && doc.openUrl;
      }).length;
      var customerDocsHtml = self.profileDocumentsHtml(
        customerDocs,
        "No customer documents yet."
      );
      var docsHtml = self.profileDocumentsHtml(
        carrierDocs,
        "No carrier / load documents yet."
      );

      var custInvoice = cust.invoiceDoc;
      var carrInvoice = carr.invoiceDoc;
      var custPayStatus = String(cust.paymentStatus || "UNPAID").toUpperCase();
      var carrPayStatus = String(carr.paymentStatus || "UNPAID").toUpperCase();
      var custPayTone = custPayStatus === "PAID" ? "ok" : "warn";
      var carrPayTone = carrPayStatus === "PAID" ? "ok" : "warn";
      var custRateNum = Number(cust.rate);
      var carrRateNum = Number(carr.rate);
      var brokerProfit =
        Number.isFinite(custRateNum) && Number.isFinite(carrRateNum)
          ? custRateNum - carrRateNum
          : null;

      var custDocsVerified = Boolean(acc.customerDocsVerified);
      var carrDocsVerified = Boolean(acc.carrierDocsVerified);
      var verifyCustBtn = "";
      var verifyCarrBtn = "";
      if (perms.canVerifyDocuments) {
        verifyCustBtn = custDocsVerified
          ? '<span class="acc-verified-badge" title="Customer documents verified">Verified</span>'
          : '<button type="button" class="btn-primary acc-verify-side-btn" data-act="verify-customer-docs">Verified</button>';
        verifyCarrBtn = carrDocsVerified
          ? '<span class="acc-verified-badge" title="Carrier documents verified">Verified</span>'
          : '<button type="button" class="btn-primary acc-verify-side-btn" data-act="verify-carrier-docs">Verified</button>';
      } else if (custDocsVerified || carrDocsVerified) {
        if (custDocsVerified) {
          verifyCustBtn =
            '<span class="acc-verified-badge" title="Customer documents verified">Verified</span>';
        }
        if (carrDocsVerified) {
          verifyCarrBtn =
            '<span class="acc-verified-badge" title="Carrier documents verified">Verified</span>';
        }
      }

      var toolbar = "";
      toolbar +=
        '<button type="button" class="btn-primary" id="acc-save-pay">Save Rate and Payment</button>';
      toolbar +=
        '<button type="button" class="btn-secondary" data-act="note">Add Accounting Note</button>';

      host.innerHTML =
        '<div class="acc-profile">' +
        '<div class="acc-profile-top">' +
        "<div>" +
        '<div class="acc-profile-title">' +
        "<h2>" +
        self.esc(loadNo) +
        "</h2>" +
        self.pill(
          self.statusBadgeText(ident.status),
          String(ident.status || "").toUpperCase() === "VOIDED"
            ? "bad"
            : ident.isReactivated
              ? "warn"
              : "ok"
        ) +
        (ident.isReactivated && String(ident.status || "").toUpperCase() !== "VOIDED"
          ? self.pill("Reactivated", "warn")
          : "") +
        "</div>" +
        '<div class="acc-profile-days">' +
        "<span>Pickup day: <strong>" +
        self.esc(self.formatDay(lane.pickupDay)) +
        "</strong></span>" +
        "<span>Delivery day: <strong>" +
        self.esc(self.formatDay(lane.deliveryDay)) +
        "</strong></span></div>" +
        "</div>" +
        '<div class="acc-profile-nav" aria-label="Load navigation">' +
        '<button type="button" class="btn-secondary" id="acc-prev-load" title="Previous Load"' +
        (neighbors.prev ? "" : " disabled") +
        ">Prev</button>" +
        '<button type="button" class="btn-secondary" id="acc-next-load" title="Next Load"' +
        (neighbors.next ? "" : " disabled") +
        ">Next</button>" +
        '<button type="button" class="btn-secondary" id="acc-profile-close" title="Close">Close</button>' +
        "</div></div>" +
        '<div class="acc-broker-bar">' +
        '<div class="acc-quick-item acc-quick-broker"><span class="acc-quick-label">Broker</span><strong>' +
        self.esc(ident.brokerName || "—") +
        '</strong><div class="acc-profit-block"><span class="acc-profit-label">PROFIT</span><span class="acc-profit-value">' +
        self.esc(self.money(brokerProfit)) +
        "</span></div></div></div>" +
        '<div class="acc-status-grid">' +
        '<section class="acc-card acc-status-card acc-status-cust-pay"><h3>Customer Payment Status</h3>' +
        self.pill(custPayStatus, custPayTone) +
        '<div class="acc-carrier-pay-meta">Outstanding: <strong>' +
        self.money(cust.outstanding) +
        "</strong></div>" +
        '<div class="acc-carrier-pay-meta">Received: <strong>' +
        self.money(cust.amountReceived) +
        "</strong></div></section>" +
        '<section class="acc-card acc-status-card acc-status-pod"><h3>POD Status</h3>' +
        self.pill(String(pod.status || "PENDING").toUpperCase(), pod.document ? "ok" : "warn") +
        '<button type="button" class="btn-secondary acc-doc-upload-btn" data-doc-type="POD">Upload POD</button></section>' +
        '<section class="acc-card acc-status-card acc-status-carrier-pay"><h3>Carrier Payment Status</h3>' +
        self.pill(carrPayStatus, carrPayTone) +
        '<div class="acc-carrier-pay-meta">Outstanding: <strong>' +
        self.money(carr.outstanding) +
        "</strong></div>" +
        '<div class="acc-carrier-pay-meta">Paid: <strong>' +
        self.money(carr.amountPaid) +
        "</strong></div></section>" +
        "</div>" +
        '<div class="acc-profile-grid">' +
        '<section class="acc-card"><h3>Customer</h3><div class="acc-card-name">' +
        self.esc(cust.name || "—") +
        '</div><div class="acc-kv"><span>Rate</span><strong>' +
        self.money(cust.rate) +
        "</strong></div>" +
        '<div class="acc-kv"><span>Payment Terms</span><strong>' +
        self.esc(cust.paymentLabel || "—") +
        "</strong></div>" +
        '<div class="acc-kv"><span>3% Fee</span><strong>' +
        self.money(cust.paymentFee || 0) +
        "</strong></div>" +
        '<div class="acc-kv"><span>Accessories</span><strong>' +
        self.money(cust.accessorials) +
        "</strong></div>" +
        '<div class="acc-kv acc-kv-total"><span>Total (Customer)</span><strong>' +
        self.money(cust.total) +
        "</strong></div>" +
        '<div class="acc-kv"><span>Invoiced</span><strong>' +
        self.money(cust.invoiceNumber ? cust.total : 0) +
        "</strong></div>" +
        '<div class="acc-kv"><span>Received</span><strong>' +
        self.money(cust.amountReceived) +
        "</strong></div>" +
        '<div class="acc-kv"><span>Outstanding</span><strong>' +
        self.money(cust.outstanding) +
        "</strong></div></section>" +
        '<section class="acc-card"><h3>Carrier</h3><div class="acc-card-name">' +
        self.esc(carr.name || "—") +
        '</div><div class="acc-kv"><span>Rate</span><strong>' +
        self.money(carr.rate) +
        "</strong></div>" +
        '<div class="acc-kv"><span>Total</span><strong>' +
        self.money(carr.total) +
        "</strong></div>" +
        '<div class="acc-kv"><span>Paid</span><strong>' +
        self.money(carr.amountPaid) +
        "</strong></div>" +
        '<div class="acc-kv"><span>Outstanding</span><strong>' +
        self.money(carr.outstanding) +
        "</strong></div>" +
        '<div class="acc-kv"><span>Status</span>' +
        self.pill(String(carr.paymentStatus || "UNPAID").toUpperCase(), carr.paymentStatus === "PAID" ? "ok" : "muted") +
        "</div></section>" +
        '<section class="acc-card"><div class="acc-card-head"><h3>Customer Documents</h3><span class="gos-muted">' +
        custReady +
        "/" +
        customerDocs.length +
        "</span></div><ul class=\"acc-doc-list\">" +
        customerDocsHtml +
        "</ul>" +
        (verifyCustBtn
          ? '<div class="acc-doc-verify-row">' + verifyCustBtn + "</div>"
          : "") +
        "</section>" +
        '<section class="acc-card"><div class="acc-card-head"><h3>Documents</h3><span class="gos-muted">' +
        carrierReady +
        "/" +
        carrierDocs.length +
        " on this load</span></div><ul class=\"acc-doc-list\">" +
        docsHtml +
        "</ul>" +
        (verifyCarrBtn
          ? '<div class="acc-doc-verify-row">' + verifyCarrBtn + "</div>"
          : "") +
        "</section></div>" +
        '<div class="acc-invoice-grid">' +
        '<section class="acc-card acc-drop-card"><h3>Customer Invoice (For Billing)</h3>' +
        (custInvoice && custInvoice.openUrl
          ? '<p class="acc-drop-file"><button type="button" class="acc-doc-file" data-url="' +
            self.esc(custInvoice.openUrl) +
            '" data-name="' +
            self.esc(custInvoice.fileName || "customer-invoice.pdf") +
            '" data-mime="' +
            self.esc(custInvoice.mimeType || "application/pdf") +
            '">' +
            self.esc(custInvoice.fileName || "Customer invoice") +
            "</button></p>"
          : '<p class="gos-muted">No customer invoice uploaded yet.</p>') +
        '<div class="acc-invoice-actions">' +
        self.invoiceUploadControlHtml("CUSTOMER_INVOICE", "+ Add Customer Invoice") +
        '<button type="button" class="btn-primary acc-send-btn" data-act="send-invoice"' +
        (perms.canSendInvoice || perms.canCreateInvoice
          ? custInvoice && custInvoice.openUrl
            ? ""
            : ' disabled title="Upload the customer invoice first"'
          : ' disabled title="Billing send permission required"') +
        ">Send</button></div>" +
        '<p class="gos-muted" style="margin:0.45rem 0 0;font-size:0.78rem">Send emails the invoice to the customer with a delivery thank-you and payment request.</p>' +
        "</section>" +
        '<section class="acc-card acc-drop-card"><h3>Carrier Invoice (For Payment)</h3>' +
        (carrInvoice && carrInvoice.openUrl
          ? '<p class="acc-drop-file"><button type="button" class="acc-doc-file" data-url="' +
            self.esc(carrInvoice.openUrl) +
            '" data-name="' +
            self.esc(carrInvoice.fileName || "carrier-invoice.pdf") +
            '" data-mime="' +
            self.esc(carrInvoice.mimeType || "application/pdf") +
            '">' +
            self.esc(carrInvoice.fileName || "Carrier invoice") +
            "</button></p>"
          : '<p class="gos-muted">No carrier invoice uploaded yet.</p>') +
        '<div class="acc-invoice-actions">' +
        self.invoiceUploadControlHtml("CARRIER_INVOICE", "+ Add Carrier Invoice") +
        '<button type="button" class="btn-primary acc-send-btn" data-act="carr-pay"' +
        (perms.canExecuteCarrierPayment && acc.canPayCarrier
          ? ""
          : ' disabled title="' +
            (perms.canExecuteCarrierPayment
              ? "Blocked until documents are verified and carrier payment is ready"
              : "Carrier payment permission required") +
            '"') +
        ">Send</button></div>" +
        '<p class="gos-muted" style="margin:0.45rem 0 0;font-size:0.78rem">Send pays the carrier after documents and amounts are verified.</p>' +
        "</section></div>" +
        '<section class="acc-card acc-rate-card"><h3>Rate &amp; Payment</h3>' +
        '<div class="acc-rate-sides">' +
        '<div class="acc-rate-side">' +
        "<h4>Customer</h4>" +
        '<label>Customer Rate (Required)<input id="acc-cust-rate" inputmode="decimal" value="' +
        self.esc(cust.rate == null ? "" : cust.rate) +
        '"></label>' +
        '<label>Payment Option<select id="acc-pay-method">' +
        self.paymentMethodOptions(cust.paymentMethod, false) +
        "</select></label>" +
        '<label class="acc-check"><input type="checkbox" id="acc-pay-fee"' +
        (cust.paymentFeeWaived ? "" : " checked") +
        "> Add 3% Fee</label>" +
        '<div class="acc-rate-summary">' +
        "<div>Base Rate: <strong>" +
        self.money(cust.rate) +
        "</strong></div>" +
        "<div>3% Fee: <strong>" +
        self.money(cust.paymentFee || 0) +
        "</strong></div>" +
        '<div class="acc-rate-total">Total Payment: <strong>' +
        self.money(cust.total) +
        "</strong></div></div></div>" +
        '<div class="acc-rate-side">' +
        "<h4>Carrier</h4>" +
        '<label>Carrier Rate<input id="acc-carrier-rate" inputmode="decimal" value="' +
        self.esc(carr.rate == null ? "" : carr.rate) +
        '"></label>' +
        '<label>Carrier Choose Payment Option' +
        '<input type="text" id="acc-carrier-pay-opt" readonly value="' +
        self.esc(carr.paymentOption || "—") +
        '" title="' +
        self.esc(
          carr.paymentOptionFromRateCon
            ? "From Rate Confirmation document"
            : "From carrier profile (no payment option saved on Rate Confirmation)"
        ) +
        '"></label>' +
        '<p class="gos-muted acc-rc-pay-hint">' +
        (carr.paymentOptionFromRateCon
          ? "Taken from Rate Confirmation"
          : "No payment option on Rate Confirmation — showing carrier profile value") +
        "</p>" +
        '<button type="button" class="btn-secondary" id="acc-save-carrier-rate" style="width:auto">Save carrier rate</button>' +
        "</div></div></section>" +
        '<div class="acc-profile-toolbar">' +
        toolbar +
        "</div>" +
        '<p id="acc-msg" class="gos-muted" style="margin-top:0.75rem"></p>' +
        '<input type="file" id="acc-generic-file" class="acc-file-input" accept="' +
        self.esc(self.invoiceFileAccept()) +
        '">' +
        "</div>";

      function closeProfile() {
        if (typeof self._closeProfile === "function") self._closeProfile();
      }
      var closeBtn = host.querySelector("#acc-profile-close");
      if (closeBtn) closeBtn.addEventListener("click", closeProfile);
      var prevBtn = host.querySelector("#acc-prev-load");
      var nextBtn = host.querySelector("#acc-next-load");
      if (prevBtn && neighbors.prev) {
        prevBtn.addEventListener("click", function () {
          self.openShipment(host, neighbors.prev);
        });
      }
      if (nextBtn && neighbors.next) {
        nextBtn.addEventListener("click", function () {
          self.openShipment(host, neighbors.next);
        });
      }

      host.querySelectorAll("[data-act]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          self.runAction(host, id, btn.getAttribute("data-act"));
        });
      });

      var genericFile = host.querySelector("#acc-generic-file");
      var pendingDocType = null;
      host.querySelectorAll(".acc-doc-upload-btn").forEach(function (btn) {
        btn.addEventListener("click", function (ev) {
          ev.preventDefault();
          ev.stopPropagation();
          pendingDocType = btn.getAttribute("data-doc-type");
          var dedicated = host.querySelector(
            '.acc-file-input[data-doc-type="' + pendingDocType + '"]'
          );
          var target = dedicated || genericFile;
          if (!self.openFilePicker(target)) {
            alert("Could not open the file picker. Try again or use a different browser.");
          }
        });
      });
      function handleFileInput(input) {
        input.addEventListener("change", async function () {
          var file = input.files && input.files[0];
          var docType = input.getAttribute("data-doc-type") || pendingDocType;
          if (!file || !docType) {
            input.value = "";
            return;
          }
          var msg = host.querySelector("#acc-msg");
          if (msg) {
            msg.textContent = "Uploading " + docType.replace(/_/g, " ").toLowerCase() + "…";
            msg.style.color = "";
          }
          try {
            await self.uploadLoadDoc(id, docType, file);
            input.value = "";
            pendingDocType = null;
            await self.openShipment(host, id);
          } catch (err) {
            input.value = "";
            if (msg) {
              msg.textContent = err.message || "Upload failed";
              msg.style.color = "#ef4444";
            }
            alert(err.message || "Upload failed");
          }
        });
      }
      host.querySelectorAll(".acc-file-input").forEach(handleFileInput);

      var savePay = host.querySelector("#acc-save-pay");
      var payMethod = host.querySelector("#acc-pay-method");
      var payFee = host.querySelector("#acc-pay-fee");
      function syncPayLabels() {
        if (!payMethod) return;
        var addFee = Boolean(payFee && payFee.checked);
        payMethod.querySelectorAll("option").forEach(function (opt) {
          var full = opt.getAttribute("data-full");
          if (!full) return;
          opt.textContent = addFee ? full : full.replace(/ \+3%$/, "");
        });
      }
      if (payFee) payFee.addEventListener("change", syncPayLabels);
      syncPayLabels();
      if (savePay) {
        savePay.addEventListener("click", async function () {
          var raw = (host.querySelector("#acc-cust-rate") || {}).value;
          var rate =
            raw == null || String(raw).trim() === ""
              ? null
              : Number(String(raw).replace(/[$,\s]/g, ""));
          var method = (host.querySelector("#acc-pay-method") || {}).value || "";
          var waive = !(payFee && payFee.checked);
          if (rate == null || !Number.isFinite(rate) || rate < 0) {
            alert("Customer rate is required");
            return;
          }
          if (!method) {
            alert("Payment option is required");
            return;
          }
          savePay.disabled = true;
          try {
            await self.loadApi("/" + encodeURIComponent(id), {
              method: "PATCH",
              body: {
                customerRate: String(rate),
                customerPaymentMethod: method,
                waiveCustomerPaymentFee: waive,
              },
            });
            self.openShipment(host, id);
          } catch (err) {
            savePay.disabled = false;
            alert(err.message || "Could not save");
          }
        });
      }

      var saveCarrier = host.querySelector("#acc-save-carrier-rate");
      if (saveCarrier) {
        saveCarrier.addEventListener("click", async function () {
          var raw = (host.querySelector("#acc-carrier-rate") || {}).value;
          var rate =
            raw == null || String(raw).trim() === ""
              ? null
              : Number(String(raw).replace(/[$,\s]/g, ""));
          if (rate == null || !Number.isFinite(rate) || rate < 0) {
            alert("Carrier rate is required");
            return;
          }
          saveCarrier.disabled = true;
          try {
            await self.loadApi("/" + encodeURIComponent(id), {
              method: "PATCH",
              body: { carrierRate: String(rate) },
            });
            self.openShipment(host, id);
          } catch (err) {
            saveCarrier.disabled = false;
            alert(err.message || "Could not save");
          }
        });
      }

      var saveNotes = host.querySelector("#acc-save-notes");
      if (saveNotes) {
        saveNotes.addEventListener("click", async function () {
          var note = ((host.querySelector("#acc-notes-box") || {}).value || "").trim();
          if (!note) {
            alert("Enter a note first");
            return;
          }
          saveNotes.disabled = true;
          try {
            var noteRes = await self.api("/shipments/" + encodeURIComponent(id) + "/notes", {
              method: "POST",
              body: { note: note },
            });
            if (!noteRes.success) throw new Error(noteRes.message || "Could not save note");
            self.openShipment(host, id);
          } catch (err) {
            saveNotes.disabled = false;
            alert(err.message || "Could not save note");
          }
        });
      }

      host.querySelectorAll(".acc-doc-file").forEach(function (btn) {
        btn.addEventListener("click", function (ev) {
          ev.preventDefault();
          self.openDocumentFile(
            btn.getAttribute("data-url"),
            btn.getAttribute("data-name"),
            btn.getAttribute("data-mime"),
            btn.getAttribute("data-download") === "1"
          );
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
    if (act === "verify-docs") {
      path = "/shipments/" + id + "/documents/verify";
      body = { side: "both" };
    } else if (act === "verify-customer-docs") {
      path = "/shipments/" + id + "/documents/verify";
      body = { side: "customer" };
    } else if (act === "verify-carrier-docs") {
      path = "/shipments/" + id + "/documents/verify";
      body = { side: "carrier" };
    } else if (act === "reject-docs") {
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
    } else if (act === "send-invoice") {
      if (
        !window.confirm(
          "Send the customer invoice by email now? The customer will receive a delivery thank-you with the invoice attached and a payment request."
        )
      ) {
        return;
      }
      path = "/shipments/" + id + "/invoice/send";
    } else if (act === "cust-pay") path = "/shipments/" + id + "/customer-payment";
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

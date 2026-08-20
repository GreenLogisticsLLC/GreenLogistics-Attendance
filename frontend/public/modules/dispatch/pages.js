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

  role() {
    return (
      (window.GreenOS && window.GreenOS.user && window.GreenOS.user.role) ||
      (window.GreenOSUser && window.GreenOSUser.role) ||
      ""
    );
  },

  /** Money / Profit — Accounting + Owner (+ Admin). Brokers never see it. */
  canSeeMoney() {
    var r = this.role();
    return r === "Owner" || r === "Accounting" || r === "Administrator";
  },

  currentDocContent(data, docType) {
    var docs = (data && data.documents) || [];
    var want = String(docType || "").toUpperCase();
    for (var i = 0; i < docs.length; i++) {
      if (String(docs[i].docType || "").toUpperCase() === want && docs[i].content) {
        return docs[i].content;
      }
    }
    return {};
  },

  carrierDocTypeLabel(type) {
    var map = {
      BROKER_CARRIER_AGREEMENT: "Broker–Carrier Agreement",
      MC_AUTHORITY: "MC Authority",
      NOA: "Notice of Assignment (NOA)",
      W9: "W-9",
      INSURANCE: "Insurance",
      COI: "Certificate of Insurance",
      RATE_CONFIRMATION: "Rate Confirmation (signed)",
      BOL: "BOL (signed)",
      OTHER: "Other",
    };
    return map[String(type || "").toUpperCase()] || String(type || "Document");
  },

  async openCarrierPacketDoc(carrierId, documentId, filename, inline) {
    if (window.GreenOSModules && window.GreenOSModules.carriers && window.GreenOSModules.carriers.openCarrierDoc) {
      return window.GreenOSModules.carriers.openCarrierDoc(carrierId, documentId, filename, inline);
    }
    var token = localStorage.getItem("gl_token") || "";
    var url =
      "/api/carriers/" +
      encodeURIComponent(carrierId) +
      "/documents/" +
      encodeURIComponent(documentId) +
      "/download" +
      (inline ? "?inline=1" : "");
    var res = await fetch(url, { headers: { Authorization: "Bearer " + token } });
    if (!res.ok) throw new Error(inline ? "Failed to open document" : "Download failed");
    var blob = await res.blob();
    var obj = URL.createObjectURL(blob);
    if (inline) {
      window.open(obj, "_blank", "noopener");
      setTimeout(function () {
        try {
          URL.revokeObjectURL(obj);
        } catch (e) {}
      }, 60000);
      return;
    }
    var a = document.createElement("a");
    a.href = obj;
    a.download = filename || "document.pdf";
    a.click();
    URL.revokeObjectURL(obj);
  },

  carrierPacketDocsHtml(c) {
    var self = this;
    var docs = (c && c.onboardingDocuments) || [];
    if (!docs.length) {
      return '<p class="gos-muted" style="margin:0.5rem 0 0">No signed / uploaded carrier documents yet.</p>';
    }
    return (
      '<div class="load-table-wrap" style="margin-top:0.65rem"><table class="load-table"><thead><tr>' +
      "<th>Document</th><th>File</th><th>Ver</th><th>Uploaded</th><th>Actions</th>" +
      "</tr></thead><tbody>" +
      docs
        .map(function (d) {
          return (
            "<tr>" +
            "<td><strong>" +
            self.esc(self.carrierDocTypeLabel(d.documentType)) +
            "</strong></td>" +
            "<td>" +
            self.esc(d.originalFilename || "—") +
            "</td>" +
            "<td>v" +
            self.esc(d.version) +
            "</td>" +
            "<td>" +
            self.esc(d.uploadedAt ? new Date(d.uploadedAt).toLocaleString() : "—") +
            "</td>" +
            '<td class="load-doc-actions">' +
            '<button type="button" class="btn-secondary ld-carrier-doc-view" data-id="' +
            self.esc(d.documentId) +
            '" data-name="' +
            self.esc(d.originalFilename || "document.pdf") +
            '">Open</button>' +
            '<button type="button" class="btn-secondary ld-carrier-doc-dl" data-id="' +
            self.esc(d.documentId) +
            '" data-name="' +
            self.esc(d.originalFilename || "document.pdf") +
            '">Download</button>' +
            "</td>" +
            "</tr>"
          );
        })
        .join("") +
      "</tbody></table></div>"
    );
  },

  carrierOnboardingPanelHtml(c) {
    var self = this;
    var status = String(c.onboardingStatus || "").toUpperCase();
    if (!c.carrierProfileId && !status) return "";

    var signed = c.agreementSigned || (c.agreementSignature && c.agreementSignature.agreed);
    var signMeta = c.agreementSignature
      ? self.esc(c.agreementSignature.signerName || "") +
        (c.agreementSignature.signedAt
          ? " · " + new Date(c.agreementSignature.signedAt).toLocaleString()
          : "")
      : "";
    var docs = c.onboardingDocuments || [];
    var readyStatuses = ["SUBMITTED", "UNDER_REVIEW", "APPROVED"];
    var showPanel = readyStatuses.indexOf(status) >= 0 || (signed && docs.length > 0);
    if (!showPanel && !status) return "";

    var bannerClass = "ld-carrier-review";
    var title = "Carrier onboarding";
    var body = "";
    var actions = "";

    if (status === "APPROVED") {
      bannerClass += " is-approved";
      title = "Carrier approved";
      body =
        "This carrier signed the Broker–Carrier Agreement, returned the packet, and is <strong>approved</strong> on our side. " +
        "Open the documents below to double-check they still match your criteria.";
    } else if (status === "SUBMITTED" || status === "UNDER_REVIEW") {
      bannerClass += " is-pending";
      title = "Carrier package ready for review";
      body =
        "The carrier signed the agreement and sent all required documents. " +
        "Open each file below, verify against your criteria, then approve this carrier.";
      actions =
        '<div class="load-actions" style="margin-top:0.75rem">' +
        '<button type="button" class="btn-primary" id="ld-approve-carrier">Approve carrier</button>' +
        '<button type="button" class="btn-secondary" id="ld-open-carrier-record">Open full carrier record</button>' +
        "</div>";
    } else if (status === "REQUEST_CHANGES") {
      bannerClass += " is-changes";
      title = "Waiting for carrier corrections";
      body = "You requested changes. Documents already on file stay available below until the carrier resubmits.";
    } else if (signed || docs.length) {
      bannerClass += " is-progress";
      title = "Carrier documents in progress";
      body =
        "Onboarding status: <strong>" +
        self.esc(status || "IN PROGRESS") +
        "</strong>. Documents received so far are listed below.";
    } else {
      bannerClass += " is-progress";
      title = "Waiting for carrier packet";
      body =
        "Invite sent. Status: <strong>" +
        self.esc(status || "INVITED") +
        "</strong>. After the carrier signs and uploads MC / NOA / W-9, the package will appear here for review.";
    }

    return (
      '<div class="' +
      bannerClass +
      '" id="ld-carrier-review">' +
      "<h3>" +
      title +
      "</h3>" +
      '<p class="gos-muted" style="margin:0.25rem 0 0">Onboarding: <strong>' +
      self.esc(status || "—") +
      "</strong>" +
      (signed ? " · Agreement signed" + (signMeta ? " (" + signMeta + ")" : "") : "") +
      "</p>" +
      "<p style=\"margin:0.55rem 0 0\">" +
      body +
      "</p>" +
      actions +
      "<h4 style=\"margin:1rem 0 0.35rem;font-size:0.9rem\">Signed &amp; returned documents</h4>" +
      self.carrierPacketDocsHtml(c) +
      "</div>"
    );
  },

  bindCarrierPacketDocButtons(root, carrierId) {
    var self = this;
    if (!root || !carrierId) return;
    root.querySelectorAll(".ld-carrier-doc-view").forEach(function (btn) {
      btn.addEventListener("click", async function () {
        try {
          await self.openCarrierPacketDoc(
            carrierId,
            btn.getAttribute("data-id"),
            btn.getAttribute("data-name"),
            true
          );
        } catch (e) {
          alert(e.message || e);
        }
      });
    });
    root.querySelectorAll(".ld-carrier-doc-dl").forEach(function (btn) {
      btn.addEventListener("click", async function () {
        try {
          await self.openCarrierPacketDoc(
            carrierId,
            btn.getAttribute("data-id"),
            btn.getAttribute("data-name"),
            false
          );
        } catch (e) {
          alert(e.message || e);
        }
      });
    });
  },

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

  async apiUpload(path, formData) {
    var token = localStorage.getItem("gl_token") || "";
    var res = await fetch("/api/loads" + path, {
      method: "POST",
      headers: { Authorization: "Bearer " + token },
      body: formData,
    });
    var json = await res.json().catch(function () { return {}; });
    if (!res.ok || json.success === false) {
      throw new Error(json.message || ("Upload failed " + res.status));
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

  /** US phone: (XXX) XXX-XXXX */
  formatUsPhone(raw) {
    var d = String(raw == null ? "" : raw).replace(/\D/g, "");
    if (d.length === 11 && d.charAt(0) === "1") d = d.slice(1);
    if (!d) return "";
    if (d.length <= 3) return "(" + d;
    if (d.length <= 6) return "(" + d.slice(0, 3) + ") " + d.slice(3);
    return "(" + d.slice(0, 3) + ") " + d.slice(3, 6) + "-" + d.slice(6, 10);
  },

  /** E.164 for APIs (CarrierView SMS): +1XXXXXXXXXX */
  toE164UsPhone(raw) {
    var d = String(raw == null ? "" : raw).replace(/\D/g, "");
    if (d.length === 11 && d.charAt(0) === "1") d = d.slice(1);
    if (d.length !== 10) {
      var t = String(raw == null ? "" : raw).trim();
      return t || null;
    }
    return "+1" + d;
  },

  bindUsPhoneInput(el) {
    if (!el) return;
    var self = this;
    el.value = self.formatUsPhone(el.value);
    el.setAttribute("placeholder", "(XXX) XXX-XXXX");
    el.setAttribute("maxlength", "14");
    el.addEventListener("input", function () {
      var start = el.selectionStart;
      var before = el.value.length;
      el.value = self.formatUsPhone(el.value);
      var after = el.value.length;
      if (typeof start === "number") {
        var pos = Math.max(0, start + (after - before));
        try {
          el.setSelectionRange(pos, pos);
        } catch (e) {}
      }
    });
    el.addEventListener("blur", function () {
      el.value = self.formatUsPhone(el.value);
    });
  },

  parseMoneyInput(raw) {
    if (raw == null || raw === "") return null;
    var n = parseFloat(String(raw).replace(/[$,\s]/g, ""));
    return Number.isFinite(n) ? String(n) : null;
  },

  paymentProofHtml(doc, opts) {
    opts = opts || {};
    var html = "";
    if (doc && doc.fileUrl) {
      html +=
        '<div class="load-pay-doc">' +
        "<small>" +
        this.esc(doc.fileName || doc.title || "Document") +
        "</small>" +
        '<div class="load-doc-actions">' +
        '<button type="button" class="btn-secondary load-pay-view" data-url="' +
        this.esc(doc.fileUrl) +
        '">View</button>' +
        '<button type="button" class="btn-secondary load-pay-dl" data-url="' +
        this.esc(doc.fileUrl) +
        '">Download</button>' +
        "</div></div>";
    } else {
      html += '<small class="gos-muted">No document uploaded</small>';
    }
    if (opts.canUpload) {
      html +=
        '<label class="load-pay-upload">' +
        (doc && doc.fileUrl ? "Replace document" : "Upload document") +
        '<input type="file" class="' +
        this.esc(opts.inputClass || "") +
        '" accept=".pdf,.png,.jpg,.jpeg,.webp,.heic,.doc,.docx,.xls,.xlsx"></label>';
    }
    return html;
  },

  bindPaymentDocButtons(root) {
    var self = this;
    if (!root) return;
    root.querySelectorAll(".load-pay-view").forEach(function (btn) {
      btn.addEventListener("click", function () {
        self.openPdf(btn.getAttribute("data-url"), true).catch(function (err) {
          alert(err.message || err);
        });
      });
    });
    root.querySelectorAll(".load-pay-dl").forEach(function (btn) {
      btn.addEventListener("click", function () {
        self.openPdf(btn.getAttribute("data-url"), false).catch(function (err) {
          alert(err.message || err);
        });
      });
    });
  },

  moneyFieldHtml(id, value, placeholder) {
    var v = value == null || value === "" ? "" : value;
    return (
      '<span class="gos-money-field">' +
      '<span class="gos-money-prefix" aria-hidden="true">$</span>' +
      '<input id="' +
      id +
      '" type="text" inputmode="decimal" value="' +
      this.esc(v) +
      '" placeholder="' +
      this.esc(placeholder || "0.00") +
      '">' +
      "</span>"
    );
  },

  /** YYYY-MM-DD for <input type="date"> calendar */
  toInputDate(raw) {
    if (!raw) return "";
    try {
      var d = raw instanceof Date ? raw : new Date(raw);
      if (Number.isNaN(d.getTime())) return "";
      var pad = function (n) {
        return String(n).padStart(2, "0");
      };
      return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
    } catch (e) {
      return "";
    }
  },

  /** HH:MM (24h) from Date / ISO */
  toInputTime(raw) {
    if (!raw) return "";
    try {
      var d = raw instanceof Date ? raw : new Date(raw);
      if (Number.isNaN(d.getTime())) return "";
      var pad = function (n) {
        return String(n).padStart(2, "0");
      };
      return pad(d.getHours()) + ":" + pad(d.getMinutes());
    } catch (e) {
      return "";
    }
  },

  /** Split HH:MM / Date into 12-hour parts for AM/PM selects */
  ampmPartsFromRaw(raw) {
    var hhmm = "";
    if (raw == null || raw === "") return { h: "", m: "", p: "" };
    if (typeof raw === "string" && /^\d{1,2}:\d{2}/.test(raw.trim())) {
      hhmm = raw.trim().slice(0, 5);
    } else {
      hhmm = this.toInputTime(raw);
    }
    if (!hhmm) return { h: "", m: "", p: "" };
    var bits = hhmm.split(":");
    var h24 = parseInt(bits[0], 10);
    var m = parseInt(bits[1], 10);
    if (!Number.isFinite(h24) || !Number.isFinite(m)) return { h: "", m: "", p: "" };
    var p = h24 >= 12 ? "PM" : "AM";
    var h12 = h24 % 12;
    if (h12 === 0) h12 = 12;
    return {
      h: String(h12),
      m: String(m).padStart(2, "0"),
      p: p,
    };
  },

  /** AM/PM time controls → value still stored/read as HH:MM 24h */
  timeFieldHtml(idPrefix, raw) {
    var parts = this.ampmPartsFromRaw(raw);
    var hOpts = ['<option value="">--</option>'];
    for (var h = 1; h <= 12; h++) {
      hOpts.push(
        '<option value="' +
          h +
          '"' +
          (String(parts.h) === String(h) ? " selected" : "") +
          ">" +
          h +
          "</option>"
      );
    }
    var mOpts = ['<option value="">--</option>'];
    for (var m = 0; m < 60; m++) {
      var mm = String(m).padStart(2, "0");
      mOpts.push(
        '<option value="' +
          mm +
          '"' +
          (parts.m === mm ? " selected" : "") +
          ">" +
          mm +
          "</option>"
      );
    }
    var pOpts =
      '<option value="">--</option>' +
      '<option value="AM"' +
      (parts.p === "AM" ? " selected" : "") +
      ">AM</option>" +
      '<option value="PM"' +
      (parts.p === "PM" ? " selected" : "") +
      ">PM</option>";
    return (
      '<span class="gos-ampm-time" data-ampm="' +
      this.esc(idPrefix) +
      '">' +
      '<select id="' +
      idPrefix +
      '-h" aria-label="Hour">' +
      hOpts.join("") +
      "</select>" +
      '<span class="gos-ampm-sep" aria-hidden="true">:</span>' +
      '<select id="' +
      idPrefix +
      '-m" aria-label="Minute">' +
      mOpts.join("") +
      "</select>" +
      '<select id="' +
      idPrefix +
      '-p" aria-label="AM or PM" class="gos-ampm-period">' +
      pOpts +
      "</select>" +
      "</span>"
    );
  },

  /** Read AM/PM selects as HH:MM 24h (empty if incomplete) */
  readAmPmTime(root, idPrefix) {
    if (!root) return "";
    var hEl = root.querySelector("#" + idPrefix + "-h");
    var mEl = root.querySelector("#" + idPrefix + "-m");
    var pEl = root.querySelector("#" + idPrefix + "-p");
    if (!hEl || !mEl || !pEl) return "";
    var h12 = parseInt(hEl.value, 10);
    var m = mEl.value;
    var p = pEl.value;
    if (!Number.isFinite(h12) || !m || (p !== "AM" && p !== "PM")) return "";
    var h24 = h12 % 12;
    if (p === "PM") h24 += 12;
    return String(h24).padStart(2, "0") + ":" + String(m).padStart(2, "0");
  },

  /** Human label e.g. "1:30 PM" for PDFs */
  formatAmPmLabel(hhmm) {
    if (!hhmm) return "";
    var parts = this.ampmPartsFromRaw(hhmm);
    if (!parts.h || !parts.m || !parts.p) return String(hhmm);
    return parts.h + ":" + parts.m + " " + parts.p;
  },

  /** Combine date + time inputs into ISO string for API */
  combineDateTime(dateStr, timeStr) {
    if (!dateStr) return null;
    var t = timeStr && String(timeStr).trim() ? String(timeStr).trim() : "00:00";
    if (t.length === 5) t += ":00";
    var d = new Date(String(dateStr) + "T" + t);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString();
  },

  render(root, subPageId) {
    if (!root) return;
    var self = this;
    var children = this.children || [];
    var active = children.find(function (c) { return c.id === subPageId; }) || children[0];
    var openId = null;
    var viewingId = null;
    try {
      openId = sessionStorage.getItem("gos_open_load_id");
      if (openId) sessionStorage.removeItem("gos_open_load_id");
    } catch (e) {}
    // Resume open Load Details only when already on screen (soft refresh).
    // Fresh My Loads / Active Loads always shows the list first.
    if (document.querySelector(".load-layout")) {
      viewingId = self._loadId || null;
      try {
        if (!viewingId) viewingId = sessionStorage.getItem("gos_viewing_load_id");
      } catch (e) {}
    } else {
      self._loadId = null;
    }

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
    self._listPhase = phase || "active";
    body.innerHTML = "<p class=\"gos-muted\">Loading loads…</p>";
    try {
      var rows = await self.api("/?phase=" + encodeURIComponent(phase));
      var title = phase === "completed" ? "Completed Loads" : "Active Loads";
      if (!rows || !rows.length) {
        body.innerHTML =
          '<div class="load-empty">' +
          "<h2>" +
          title +
          "</h2>" +
          "<p>No loads yet. Open an Accepted shipment and create a Load — the number is assigned automatically.</p>" +
          "</div>";
        return;
      }
      var html =
        '<div class="load-list-bar">' +
        "<h2>" +
        title +
        "</h2>" +
        '<input type="search" class="load-list-search" id="load-list-search" placeholder="Search load, customer, lane, carrier…" autocomplete="off">' +
        '<span class="load-list-count" id="load-list-count">' +
        rows.length +
        " loads</span>" +
        "</div>" +
        '<div class="load-table-wrap"><table class="load-table"><thead><tr>' +
        "<th>Load #</th><th>Shipment</th><th>Customer</th><th>Lane</th><th>Carrier</th><th>Status</th>" +
        (self.canSeeMoney() ? "<th>Customer $</th><th>Carrier $</th><th>Profit</th>" : "") +
        "<th></th>" +
        "</tr></thead><tbody>";
      rows.forEach(function (r) {
        var pr = r.pricing || {};
        var moneyCols = "";
        if (self.canSeeMoney()) {
          var profitCell =
            pr.hasBothSides === false
              ? '<span class="gos-muted" title="Enter Customer price and Carrier price">—</span>'
              : self.money(pr.grossProfit != null ? pr.grossProfit : pr.profit);
          moneyCols =
            "<td>" +
            (pr.hasCustomerPrice
              ? self.money(pr.fromCustomer != null ? pr.fromCustomer : pr.customerRate)
              : "—") +
            "</td>" +
            "<td>" +
            (pr.hasCarrierPrice
              ? self.money(pr.toCarrier != null ? pr.toCarrier : pr.carrierRate)
              : "—") +
            "</td>" +
            "<td>" +
            profitCell +
            "</td>";
        }
        var hay =
          [r.loadNumber, r.shipmentNumber, r.customerName, r.pickup, r.delivery, r.carrierName, r.statusLabel, r.status]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();
        html +=
          '<tr class="load-row" data-id="' +
          self.esc(r.shipmentLeadId) +
          '" data-hay="' +
          self.esc(hay) +
          '">' +
          "<td><strong>" + self.esc(r.loadNumber) + "</strong></td>" +
          "<td>" + self.esc(r.shipmentNumber || "—") + "</td>" +
          "<td>" + self.esc(r.customerName || "—") + "</td>" +
          "<td>" + self.esc((r.pickup || "—") + " → " + (r.delivery || "—")) + "</td>" +
          "<td>" + self.esc(r.carrierName || "—") + "</td>" +
          "<td><span class=\"load-status-pill\">" + self.esc(r.statusLabel || r.status) + "</span></td>" +
          moneyCols +
          '<td><button type="button" class="btn-secondary load-open-btn" data-id="' +
          self.esc(r.shipmentLeadId) +
          '">Open</button></td>' +
          "</tr>";
      });
      html += "</tbody></table></div>";
      body.innerHTML = html;
      function openLoadRow(id) {
        if (id) self.openLoad(body, id);
      }
      body.querySelectorAll(".load-open-btn").forEach(function (btn) {
        btn.addEventListener("click", function (ev) {
          ev.stopPropagation();
          openLoadRow(btn.getAttribute("data-id"));
        });
      });
      body.querySelectorAll("tr.load-row").forEach(function (tr) {
        tr.addEventListener("click", function () {
          openLoadRow(tr.getAttribute("data-id"));
        });
      });
      var search = body.querySelector("#load-list-search");
      var countEl = body.querySelector("#load-list-count");
      if (search) {
        search.addEventListener("input", function () {
          var q = (search.value || "").trim().toLowerCase();
          var shown = 0;
          body.querySelectorAll("tr.load-row").forEach(function (tr) {
            var ok = !q || (tr.getAttribute("data-hay") || "").indexOf(q) >= 0;
            tr.style.display = ok ? "" : "none";
            if (ok) shown += 1;
          });
          if (countEl) countEl.textContent = shown + " loads";
        });
      }
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
      var qs = self._tab === "tracking" ? "?includeGps=1" : "";
      var data = await self.api("/" + encodeURIComponent(id) + qs);
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
    var showMoney = data.canViewMoney === true || self.canSeeMoney();
    var tabs = [
      "general",
      "carrier",
      "pricing",
      "tracking",
      "documents",
      "notes",
      "accounting",
      "communications",
    ].filter(function (t) {
      if (!showMoney && t === "pricing") return false;
      return true;
    });
    var tabLabels = {
      general: "General",
      carrier: "Carrier",
      pricing: "Pricing",
      tracking: "Tracking",
      documents: "Documents",
      notes: "Notes",
      accounting: "Accounting",
      communications: "Communications",
    };
    if (self._tab === "timeline") self._tab = "general";
    if (!showMoney && self._tab === "pricing") {
      self._tab = "general";
    }

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

    var docs = data.documents || [];
    var hasDocType = function (t) {
      return docs.some(function (d) {
        return String(d.docType || "").toUpperCase() === t;
      });
    };
    var accounting = data.accounting || {};
    var qaSteps = (data.quickActions || []).filter(function (a) {
      return a.kind !== "status";
    });
    var qaDone = qaSteps.filter(function (a) {
      return a.state === "done";
    }).length;
    var qaCurrent = qaSteps.find(function (a) {
      return a.state === "current";
    });
    var qaPct = qaSteps.length ? Math.round((qaDone / qaSteps.length) * 100) : 0;
    var progressHtml =
      '<div class="load-progress">' +
      '<div class="load-progress-bar" aria-hidden="true"><span style="width:' +
      qaPct +
      '%"></span></div>' +
      "<p>" +
      (qaCurrent
        ? "Now: " + self.esc(qaCurrent.label)
        : qaDone === qaSteps.length
          ? "All steps complete"
          : "In progress") +
      " · " +
      qaDone +
      "/" +
      qaSteps.length +
      "</p>" +
      "</div>";

    var actions = (data.quickActions || [])
      .map(function (a) {
        if (a.kind === "status") return "";
        var state = a.state || "current";
        var cls =
          "load-action-btn" +
          (state === "current" ? " btn-primary is-current" : " btn-secondary") +
          (state === "done" ? " is-done" : "") +
          (state === "locked" ? " is-locked" : "");
        var label =
          (state === "done" ? "✓ " : "") +
          self.esc(a.label);
        var disabled = state === "locked" || (state === "done" && a.id === "close_load");
        return (
          '<button type="button" class="' +
          cls +
          '" data-action="' +
          self.esc(a.id) +
          '" data-state="' +
          self.esc(state) +
          '" data-blocked="' +
          self.esc(a.blockedReason || "") +
          '"' +
          (disabled ? " disabled" : "") +
          " title=\"" +
          self.esc(
            state === "locked"
              ? a.blockedReason || "Complete the previous step first"
              : state === "done"
                ? a.id === "close_load"
                  ? "Load is closed"
                  : "Done — click to view or change"
                : a.label
          ) +
          '">' +
          label +
          "</button>"
        );
      })
      .join("");

    var podComplete = hasDocType("POD");
    var paymentPanel = podComplete
      ? '<h4>Payments</h4><div class="load-payment-statuses">' +
        '<div class="load-payment-status' +
        (accounting.customerPaidAt ? " is-paid" : "") +
        '"><span>Customer Paid</span><strong>' +
        (accounting.customerPaidAt
          ? "✓ Payment Received"
          : "Waiting for Accounting") +
        "</strong>" +
        (accounting.customerPaidAt
          ? "<small>" +
            self.esc(new Date(accounting.customerPaidAt).toLocaleString()) +
            "</small>"
          : "") +
        self.paymentProofHtml(accounting.customerPaidDoc) +
        "</div>" +
        '<div class="load-payment-status' +
        (accounting.carrierPaidAt ? " is-paid" : "") +
        '"><span>Carrier Paid</span><strong>' +
        (accounting.carrierPaidAt
          ? "✓ Carrier / Factoring Paid"
          : "Waiting for Accounting") +
        "</strong>" +
        (accounting.carrierPaidAt
          ? "<small>" +
            self.esc(new Date(accounting.carrierPaidAt).toLocaleString()) +
            "</small>"
          : "") +
        self.paymentProofHtml(accounting.carrierPaidDoc) +
        "</div></div>"
      : "";

    body.innerHTML =
      '<div class="load-layout">' +
      '<aside class="load-nav">' +
      '<button type="button" class="load-back-btn" id="load-back">← All loads</button>' +
      "<h3>" +
      self.esc(data.identity.loadNumber || "No Load #") +
      "</h3>" +
      "<p class=\"gos-muted load-nav-sub\">" +
      self.esc(data.identity.shipmentNumber || "") +
      "</p>" +
      progressHtml +
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
      paymentPanel +
      "</aside>" +
      "</div>";

    self.bindPaymentDocButtons(body);

    body.querySelector("#load-back")?.addEventListener("click", function () {
      self.clearOpenLoad();
      self.renderList(body, self._listPhase || "active");
    });

    body.querySelectorAll(".load-tab").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var next = btn.getAttribute("data-tab");
        self._tab = next;
        if (next === "tracking" && !(data.gps && data.gps.configured != null)) {
          self.openLoad(body, id, "tracking");
          return;
        }
        self.renderDetails(body, data);
      });
    });

    body.querySelectorAll(".load-action-btn").forEach(function (btn) {
      btn.addEventListener("click", async function () {
        var state = btn.getAttribute("data-state") || "current";
        var action = btn.getAttribute("data-action");
        if (state === "locked") {
          alert(btn.getAttribute("data-blocked") || "Complete the previous step first");
          return;
        }
        if (state === "done" && action === "close_load") {
          return;
        }
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
            if (mainEl) self.showRateConWizard(mainEl, id, data, state === "done" ? "BROKER_EDITED" : "GENERATED");
          }, 40);
          return;
        }
        if (action === "generate_bol") {
          self._tab = "documents";
          self.renderDetails(body, data);
          setTimeout(function () {
            var mainEl = body.querySelector("#load-main");
            if (mainEl) self.showBolWizard(mainEl, id, data, state === "done" ? "BROKER_EDITED" : "GENERATED");
          }, 40);
          return;
        }
        if (action === "upload_pod" || action === "generate_pod") {
          self._tab = "documents";
          self.renderDetails(body, data);
          setTimeout(function () {
            var mainEl = body.querySelector("#load-main");
            if (mainEl) self.showPodWizard(mainEl, id, data, state === "done" ? "BROKER_EDITED" : "GENERATED");
          }, 40);
          return;
        }
        if (action === "create_invoice" || action === "generate_invoice") {
          self._tab = "documents";
          self.renderDetails(body, data);
          setTimeout(function () {
            var mainEl = body.querySelector("#load-main");
            if (mainEl) self.showInvoiceWizard(mainEl, id, data, "GENERATED");
          }, 40);
          return;
        }
        if (action === "mark_pickup") {
          if (state === "done") {
            self._tab = "general";
            self.renderDetails(body, data);
            setTimeout(function () {
              var input = document.getElementById("ld-pickup-date");
              if (input) {
                input.focus();
                input.scrollIntoView({ behavior: "smooth", block: "center" });
              }
            }, 50);
            return;
          }
        }
        if (action === "send_review_link") {
          self.showReviewLinkModal(body, id, data);
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
    var showMoney = data.canViewMoney === true || self.canSeeMoney();

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
      var contacts = data.contacts || {};
      var custPrice = p.customerRate != null && p.customerRate !== "" ? p.customerRate : "";
      var carrPrice = p.carrierRate != null && p.carrierRate !== "" ? p.carrierRate : "";
      var profitVal = p.profit != null ? p.profit : p.grossProfit;
      var moneyGrid =
        showMoney
          ? field("Customer price (взяли)", self.money(custPrice)) +
            field("Carrier price (отдали)", self.money(carrPrice)) +
            field("Our profit", self.money(profitVal))
          : "";
      var moneyPanel =
        showMoney
          ? "<h3>Money on this Load</h3>" +
            '<p class="gos-muted">Accounting / Owner only. Profit = Customer price − Carrier price. Example: $1500 − $1000 = <strong>$500</strong>.</p>' +
            '<div class="load-form-grid">' +
            "<label>Customer price (взяли у customer)" +
            self.moneyFieldHtml("ld-cust-price", custPrice, "1500.00") +
            "</label>" +
            "<label>Carrier price (отдали carrier)" +
            self.moneyFieldHtml("ld-carr-price", carrPrice, "1000.00") +
            "</label>" +
            '<label class="full">Our profit' +
            '<span class="gos-money-field">' +
            '<span class="gos-money-prefix" aria-hidden="true">$</span>' +
            '<input id="ld-profit-view" type="text" readonly value="' +
            self.esc(
              custPrice !== "" && carrPrice !== ""
                ? (Number(custPrice) - Number(carrPrice)).toFixed(2)
                : "—"
            ) +
            '">' +
            "</span></label>" +
            "</div>"
          : "";
      main.innerHTML =
        "<h2>General</h2>" +
        '<div class="load-grid">' +
        field("Load Number", g.loadNumber) +
        field("Shipment Number", g.shipmentNumber) +
        field("Customer", g.customer) +
        field("Broker", g.broker && g.broker.name) +
        field("Status", g.statusLabel || g.status) +
        field("Pickup", place(g.pickup)) +
        field("Delivery", place(g.delivery)) +
        field(
          "Pickup date",
          g.pickup && (g.pickup.from || g.pickup.opsAt)
            ? new Date(g.pickup.from || g.pickup.opsAt).toLocaleString()
            : "—"
        ) +
        field(
          "Delivery date",
          g.delivery && (g.delivery.from || g.delivery.opsAt)
            ? new Date(g.delivery.from || g.delivery.opsAt).toLocaleString()
            : "—"
        ) +
        field("Equipment", g.equipment) +
        field("Commodity", g.commodity) +
        field("Weight", g.weight) +
        field("Pieces", g.pieces) +
        field("Miles", g.miles) +
        field("Rate", self.money(custPrice)) +
        moneyGrid +
        field("Created", g.createdAt ? new Date(g.createdAt).toLocaleString() : "—") +
        field("Last Updated", g.updatedAt ? new Date(g.updatedAt).toLocaleString() : "—") +
        "</div>" +
        '<div class="load-edit-panel">' +
        moneyPanel +
        "<h3>Emails — Broker Gmail / Customer / Carrier</h3>" +
        '<p class="gos-muted">These emails go on Rate Con and BOL. Fill them as soon as the Load is created.</p>' +
        '<div class="load-grid" style="margin-bottom:0.75rem">' +
        field("Broker Gmail", contacts.brokerGmail || (g.broker && g.broker.gmail) || (g.broker && g.broker.email)) +
        field("Customer Email", contacts.customerEmail || g.customerEmail) +
        field(
          "Customer Phone",
          self.formatUsPhone(contacts.customerPhone || g.customerPhone) ||
            contacts.customerPhone ||
            g.customerPhone
        ) +
        field("Carrier Email", contacts.carrierEmail || (data.carrier && data.carrier.carrierEmail)) +
        "</div>" +
        '<div class="load-form-grid">' +
        '<label>Customer name <input id="ld-customer" value="' + self.esc(g.customer || "") + '"></label>' +
        '<label>Customer email (Gmail) <input id="ld-customer-email" type="email" value="' +
        self.esc(contacts.customerEmail || g.customerEmail || "") +
        '" placeholder="customer@gmail.com"></label>' +
        '<label>Customer phone <input id="ld-customer-phone" type="tel" value="' +
        self.esc(self.formatUsPhone(contacts.customerPhone || g.customerPhone || "")) +
        '" placeholder="(XXX) XXX-XXXX"></label>' +
        '<label>Carrier email <input id="ld-carrier-email-g" type="email" value="' +
        self.esc(contacts.carrierEmail || (data.carrier && data.carrier.carrierEmail) || "") +
        '" placeholder="dispatch@carrier.com"></label>' +
        '<label class="full gos-muted">Broker Gmail (from connected account): <strong>' +
        self.esc(contacts.brokerGmail || (g.broker && g.broker.gmail) || (g.broker && g.broker.email) || "— not connected —") +
        "</strong></label>" +
        '<label>Commodity <input id="ld-commodity" value="' + self.esc(g.commodity || "") + '"></label>' +
        '<label>Equipment <input id="ld-equipment" value="' + self.esc(g.equipment || "") + '"></label>' +
        '<label>Weight <input id="ld-weight" value="' + self.esc(g.weight || "") + '"></label>' +
        '<label>Pieces <input id="ld-pieces" type="number" value="' + self.esc(g.pieces == null ? "" : g.pieces) + '"></label>' +
        '<label>Miles <input id="ld-miles" type="number" value="' + self.esc(g.miles == null ? "" : g.miles) + '"></label>' +
        '<label>Pickup date <input id="ld-pickup-date" type="date" value="' +
        self.esc(self.toInputDate((g.pickup && (g.pickup.from || g.pickup.opsAt)) || "")) +
        '"></label>' +
        "<label>Pickup time" +
        self.timeFieldHtml("ld-pickup-time", (g.pickup && (g.pickup.from || g.pickup.opsAt)) || "") +
        "</label>" +
        '<label>Delivery date <input id="ld-delivery-date" type="date" value="' +
        self.esc(self.toInputDate((g.delivery && (g.delivery.from || g.delivery.opsAt)) || "")) +
        '"></label>' +
        "<label>Delivery time" +
        self.timeFieldHtml("ld-delivery-time", (g.delivery && (g.delivery.from || g.delivery.opsAt)) || "") +
        "</label>" +
        "<label>Rate" +
        self.moneyFieldHtml("ld-rate", custPrice, "0.00") +
        "</label>" +
        '<label class="full">Special Instructions <textarea id="ld-special">' + self.esc(g.specialInstructions || "") + "</textarea></label>" +
        "</div>" +
        '<button type="button" class="btn-primary" id="ld-save-general">Save</button>' +
        "</div>";

      function updateProfitView() {
        var a = parseFloat(self.parseMoneyInput(main.querySelector("#ld-cust-price").value));
        var b = parseFloat(self.parseMoneyInput(main.querySelector("#ld-carr-price").value));
        var el = main.querySelector("#ld-profit-view");
        if (!el) return;
        if (Number.isFinite(a) && Number.isFinite(b)) el.value = (a - b).toFixed(2);
        else el.value = "—";
      }
      function syncRatePair(fromId, toId) {
        var from = main.querySelector("#" + fromId);
        var to = main.querySelector("#" + toId);
        if (from && to) to.value = from.value;
      }
      self.bindUsPhoneInput(main.querySelector("#ld-customer-phone"));
      main.querySelector("#ld-rate")?.addEventListener("input", function () {
        syncRatePair("ld-rate", "ld-cust-price");
        updateProfitView();
      });
      if (showMoney) {
        main.querySelector("#ld-cust-price")?.addEventListener("input", function () {
          syncRatePair("ld-cust-price", "ld-rate");
          updateProfitView();
        });
        main.querySelector("#ld-carr-price")?.addEventListener("input", updateProfitView);
      }

      main.querySelector("#ld-save-general")?.addEventListener("click", async function () {
        try {
          var phoneRaw = main.querySelector("#ld-customer-phone").value || "";
          var phoneFmt = self.formatUsPhone(phoneRaw);
          var payload = {
            customerName: main.querySelector("#ld-customer").value || null,
            customerEmail: main.querySelector("#ld-customer-email").value || null,
            customerPhone: phoneFmt || null,
            carrierEmail: main.querySelector("#ld-carrier-email-g").value || null,
            commodity: main.querySelector("#ld-commodity").value || null,
            equipment: main.querySelector("#ld-equipment").value || null,
            weight: main.querySelector("#ld-weight").value || null,
            pieces: main.querySelector("#ld-pieces").value || null,
            miles: main.querySelector("#ld-miles").value || null,
            specialInstructions: main.querySelector("#ld-special").value || null,
            pickupFrom: self.combineDateTime(
              main.querySelector("#ld-pickup-date").value,
              self.readAmPmTime(main, "ld-pickup-time")
            ),
            deliveryFrom: self.combineDateTime(
              main.querySelector("#ld-delivery-date").value,
              self.readAmPmTime(main, "ld-delivery-time")
            ),
            opsPickupAt: self.combineDateTime(
              main.querySelector("#ld-pickup-date").value,
              self.readAmPmTime(main, "ld-pickup-time")
            ),
            opsDeliveryAt: self.combineDateTime(
              main.querySelector("#ld-delivery-date").value,
              self.readAmPmTime(main, "ld-delivery-time")
            ),
            customerRate: self.parseMoneyInput(main.querySelector("#ld-rate").value),
          };
          if (showMoney) {
            payload.carrierRate = self.parseMoneyInput(main.querySelector("#ld-carr-price").value);
          }
          await self.api("/" + encodeURIComponent(id), {
            method: "PATCH",
            body: JSON.stringify(payload),
          });
          self.openLoad(main.closest(".load-tms-body") || main.parentElement, id, "general");
        } catch (err) {
          alert(err.message || err);
        }
      });
      return;
    }

    if (tab === "carrier") {
      var carrierMoneyGrid = showMoney
        ? field("Carrier price (отдали)", self.money(p.carrierRate)) +
          field("Customer price (взяли)", self.money(p.customerRate)) +
          field("Our profit", self.money(p.profit != null ? p.profit : p.grossProfit))
        : "";
      var carrierPriceField = showMoney
        ? "<label>Carrier price (отдали)" +
          self.moneyFieldHtml(
            "ld-carr-price",
            p.carrierRate != null && p.carrierRate !== "" ? p.carrierRate : "",
            "1000.00"
          ) +
          "</label>"
        : "";
      main.innerHTML =
        "<h2>Assign Carrier</h2>" +
        '<p class="gos-muted">Phase 2 — fill carrier details' +
        (showMoney ? ", then set Carrier price (Accounting). " : ". ") +
        "Next: Generate Rate Confirmation.</p>" +
        '<div class="load-grid">' +
        field("Carrier", c.carrierName) +
        field("Carrier Email", c.carrierEmail) +
        field("Carrier cell", self.formatUsPhone(c.carrierPhone) || c.carrierPhone) +
        carrierMoneyGrid +
        field("MC", c.mc) +
        field("DOT", c.dot) +
        field("Insurance", c.insurance) +
        field("Carrier Status", c.carrierStatus) +
        field("Driver", c.driverName) +
        field("Driver phone", self.formatUsPhone(c.driverPhone) || c.driverPhone) +
        field("Truck", c.truckNumber) +
        field("Trailer", c.trailerNumber) +
        field(
          "Pickup date",
          g.pickup && (g.pickup.from || g.pickup.opsAt)
            ? new Date(g.pickup.from || g.pickup.opsAt).toLocaleString()
            : "—"
        ) +
        field(
          "Delivery date",
          g.delivery && (g.delivery.from || g.delivery.opsAt)
            ? new Date(g.delivery.from || g.delivery.opsAt).toLocaleString()
            : "—"
        ) +
        "</div>" +
        self.carrierOnboardingPanelHtml(c) +
        '<p class="gos-muted">Future: ' + self.esc((c.futureIntegrations || []).join(", ")) + "</p>" +
        '<div class="load-edit-panel" id="ld-carrier-form">' +
        "<h3>Register carrier on this Load</h3>" +
        '<div class="load-form-grid">' +
        '<label>Carrier name * <input id="ld-carrier" value="' + self.esc(c.carrierName || "") + '" placeholder="e.g. Swift Transport LLC"></label>' +
        '<label>Carrier email * <input id="ld-carrier-email" type="email" value="' +
        self.esc(c.carrierEmail || "") +
        '" placeholder="dispatch@carrier.com"></label>' +
        '<label>Carrier cell phone <input id="ld-carrier-phone" type="tel" value="' +
        self.esc(self.formatUsPhone(c.carrierPhone || "")) +
        '" placeholder="(XXX) XXX-XXXX"></label>' +
        carrierPriceField +
        '<label>MC <input id="ld-mc" value="' + self.esc(c.mc || "") + '" placeholder="MC123456"></label>' +
        '<label>DOT <input id="ld-dot" value="' + self.esc(c.dot || "") + '"></label>' +
        '<label>Insurance <input id="ld-ins" value="' + self.esc(c.insurance || "") + '"></label>' +
        '<label>Driver <input id="ld-driver" value="' + self.esc(c.driverName || "") + '"></label>' +
        '<label>Driver phone <input id="ld-driver-phone" type="tel" value="' +
        self.esc(self.formatUsPhone(c.driverPhone || "")) +
        '" placeholder="(XXX) XXX-XXXX"></label>' +
        '<label>Truck <input id="ld-truck" value="' + self.esc(c.truckNumber || "") + '"></label>' +
        '<label>Trailer <input id="ld-trailer" value="' + self.esc(c.trailerNumber || "") + '"></label>' +
        '<label>Carrier Status <input id="ld-cstatus" value="' + self.esc(c.carrierStatus || "Assigned") + '"></label>' +
        '<label>Pickup date <input id="ld-c-pickup-date" type="date" value="' +
        self.esc(self.toInputDate((g.pickup && (g.pickup.from || g.pickup.opsAt)) || "")) +
        '"></label>' +
        "<label>Pickup time" +
        self.timeFieldHtml("ld-c-pickup-time", (g.pickup && (g.pickup.from || g.pickup.opsAt)) || "") +
        "</label>" +
        '<label>Delivery date <input id="ld-c-delivery-date" type="date" value="' +
        self.esc(self.toInputDate((g.delivery && (g.delivery.from || g.delivery.opsAt)) || "")) +
        '"></label>' +
        "<label>Delivery time" +
        self.timeFieldHtml("ld-c-delivery-time", (g.delivery && (g.delivery.from || g.delivery.opsAt)) || "") +
        "</label>" +
        "</div>" +
        '<button type="button" class="btn-primary" id="ld-save-carrier">' +
        (c.carrierName ? "Save Carrier Changes" : "Save &amp; Assign Carrier") +
        "</button>" +
        '<p class="gos-muted" style="margin-top:0.5rem">' +
        (c.carrierName
          ? "You can change the carrier or details. Status stays where the load already is."
          : "After save → status <strong>Carrier Assigned</strong>. Green OS emails the Agreement + MC/NOA/W-9 link from <strong>your Gmail</strong> to the carrier.") +
        "</p>" +
        "</div>";
      self.bindUsPhoneInput(main.querySelector("#ld-carrier-phone"));
      self.bindUsPhoneInput(main.querySelector("#ld-driver-phone"));
      self.bindCarrierPacketDocButtons(main, c.carrierProfileId);
      main.querySelector("#ld-open-carrier-record")?.addEventListener("click", function () {
        if (!c.carrierProfileId) return;
        if (window.GreenOSModules && window.GreenOSModules.carriers) {
          window.GreenOSModules.carriers._carrierId = c.carrierProfileId;
          window.GreenOSModules.carriers._tab = "documents";
        }
        if (window.GreenOS && typeof window.GreenOS.navigate === "function") {
          window.GreenOS.navigate("carriers");
        } else {
          window.location.hash = "#/carriers";
        }
      });
      main.querySelector("#ld-approve-carrier")?.addEventListener("click", async function () {
        if (!c.carrierProfileId) {
          alert("No carrier profile linked to this load yet.");
          return;
        }
        if (!confirm("Approve this carrier? They will be marked approved for Green OS.")) return;
        try {
          var token = localStorage.getItem("gl_token") || "";
          var res = await fetch(
            "/api/carriers/" + encodeURIComponent(c.carrierProfileId) + "/onboarding/approve",
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: "Bearer " + token,
              },
              body: "{}",
            }
          );
          var json = await res.json().catch(function () {
            return {};
          });
          if (!res.ok || json.success === false) {
            throw new Error(json.message || "Approve failed");
          }
          alert("Carrier approved.");
          var host = document.querySelector("#load-tms-body");
          self.openLoad(host, id, "carrier");
        } catch (err) {
          alert(err.message || err);
        }
      });
      main.querySelector("#ld-save-carrier")?.addEventListener("click", async function () {
        var name = (main.querySelector("#ld-carrier").value || "").trim();
        if (!name) {
          alert("Enter Carrier name to assign.");
          main.querySelector("#ld-carrier")?.focus();
          return;
        }
        try {
          var pickupIso = self.combineDateTime(
            main.querySelector("#ld-c-pickup-date").value,
            self.readAmPmTime(main, "ld-c-pickup-time")
          );
          var deliveryIso = self.combineDateTime(
            main.querySelector("#ld-c-delivery-date").value,
            self.readAmPmTime(main, "ld-c-delivery-time")
          );
          var carrierPayload = {
            carrierName: name,
            carrierEmail: main.querySelector("#ld-carrier-email").value || null,
            carrierPhone: self.formatUsPhone(main.querySelector("#ld-carrier-phone").value) || null,
            carrierMc: main.querySelector("#ld-mc").value || null,
            carrierDot: main.querySelector("#ld-dot").value || null,
            carrierInsurance: main.querySelector("#ld-ins").value || null,
            driverName: main.querySelector("#ld-driver").value || null,
            driverPhone: self.formatUsPhone(main.querySelector("#ld-driver-phone").value) || null,
            truckNumber: main.querySelector("#ld-truck").value || null,
            trailerNumber: main.querySelector("#ld-trailer").value || null,
            carrierStatus: main.querySelector("#ld-cstatus").value || "Assigned",
            pickupFrom: pickupIso,
            deliveryFrom: deliveryIso,
            opsPickupAt: pickupIso,
            opsDeliveryAt: deliveryIso,
          };
          var curStatus = String((data.identity && data.identity.status) || "").toUpperCase();
          if (!c.carrierName || curStatus === "LOAD_CREATED" || curStatus === "DISPATCH") {
            carrierPayload.status = "CARRIER_ASSIGNED";
          }
          if (showMoney && main.querySelector("#ld-carr-price")) {
            carrierPayload.carrierRate = self.parseMoneyInput(main.querySelector("#ld-carr-price").value);
          }
          await self.api("/" + encodeURIComponent(id), {
            method: "PATCH",
            body: JSON.stringify(carrierPayload),
          });
          var inviteMsg = "";
          try {
            var token = localStorage.getItem("gl_token") || "";
            var invRes = await fetch(
              "/api/carriers/from-load/" + encodeURIComponent(id) + "/invite-agreement",
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: "Bearer " + token,
                },
                body: "{}",
              }
            );
            var invJson = await invRes.json().catch(function () { return {}; });
            if (!invRes.ok || invJson.success === false) {
              inviteMsg =
                "\n\nCarrier saved, but onboarding email failed:\n" +
                (invJson.message || "Connect Broker Gmail, then Resend from Carriers.");
            } else {
              inviteMsg =
                "\n\nSecure Agreement link emailed to the carrier from your Gmail.";
            }
          } catch (inviteErr) {
            inviteMsg =
              "\n\nCarrier saved, but onboarding email failed. Connect Broker Gmail and resend.";
          }
          alert((c.carrierName ? "Carrier updated." : "Carrier assigned.") + inviteMsg);
          var host = document.querySelector("#load-tms-body");
          self.openLoad(host, id, "carrier");
        } catch (err) {
          alert(err.message || err);
        }
      });
      return;
    }

    if (tab === "pricing") {
      if (!showMoney) {
        main.innerHTML =
          "<h2>Pricing</h2>" +
          '<p class="gos-muted">Money / Profit is only available to Accounting and Owner.</p>';
        return;
      }
      main.innerHTML =
        "<h2>Pricing</h2>" +
        '<p class="gos-muted">Profit = From customer (взяли) − To carrier (отдали). Example: $1500 − $1000 = <strong>$500</strong>.</p>' +
        '<div class="load-grid">' +
        field("From customer (Customer Invoice)", self.money(p.customerRate)) +
        field("To carrier (Rate Con / Carrier Invoice)", self.money(p.carrierRate)) +
        field("Fuel (info only)", self.money(p.fuelSurcharge)) +
        field("Accessorials (info only)", self.money(p.accessorialCharges)) +
        field("Profit", self.money(p.profit != null ? p.profit : p.grossProfit)) +
        field("Margin %", p.marginPct != null ? p.marginPct + "%" : "—") +
        "</div>" +
        '<div class="load-edit-panel">' +
        '<div class="load-form-grid">' +
        "<label>From customer (Customer Invoice)" +
        self.moneyFieldHtml("ld-cr", p.customerRate || "", "1500.00") +
        "</label>" +
        "<label>To carrier (Rate Con / Carrier Invoice)" +
        self.moneyFieldHtml("ld-crr", p.carrierRate || "", "1000.00") +
        "</label>" +
        "<label>Fuel" +
        self.moneyFieldHtml("ld-fuel", p.fuelSurcharge || "", "0.00") +
        "</label>" +
        "<label>Accessorials" +
        self.moneyFieldHtml("ld-acc", p.accessorialCharges || "", "0.00") +
        "</label>" +
        "</div>" +
        '<button type="button" class="btn-primary" id="ld-save-pricing">Save Rates</button>' +
        "</div>";
      main.querySelector("#ld-save-pricing")?.addEventListener("click", async function () {
        try {
          await self.api("/" + encodeURIComponent(id), {
            method: "PATCH",
            body: JSON.stringify({
              customerRate: self.parseMoneyInput(main.querySelector("#ld-cr").value),
              carrierRate: self.parseMoneyInput(main.querySelector("#ld-crr").value),
              fuelSurcharge: self.parseMoneyInput(main.querySelector("#ld-fuel").value),
              accessorialCharges: self.parseMoneyInput(main.querySelector("#ld-acc").value),
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
      var gps = data.gps || {};
      var active = gps.active || null;
      var ready = gps.providerReady && gps.providerReady.carrier_view;
      var gpsHtml = "";
      if (active) {
        gpsHtml =
          '<div class="load-grid" style="margin-top:1rem">' +
          field("Provider", active.provider) +
          field("Provider Load ID", active.providerLoadId) +
          field("Status", active.status) +
          field("Driver phone", active.driverPhone) +
          field("Movement", active.movementType) +
          field("Address", active.lastAddress) +
          field("Lat / Lng", active.lastLatitude != null ? active.lastLatitude + ", " + active.lastLongitude : "—") +
          field("Last GPS update", active.lastPositionAt ? new Date(active.lastPositionAt).toLocaleString() : "—") +
          field("Route started", active.routeStarted ? "Yes" : "No") +
          field("Driver late", active.driverIsLate ? "Yes" : "No") +
          field("ETA (sec left)", active.timeLeftSec != null ? active.timeLeftSec : "—") +
          field("Distance left (m)", active.distanceLeftMeters != null ? active.distanceLeftMeters : "—") +
          field("Pickup arrived", active.pickupArrivedAt ? new Date(active.pickupArrivedAt).toLocaleString() : "—") +
          field("Pickup departed", active.pickupDepartedAt ? new Date(active.pickupDepartedAt).toLocaleString() : "—") +
          field("Delivery arrived", active.destinationArrivedAt ? new Date(active.destinationArrivedAt).toLocaleString() : "—") +
          field("Delivery departed", active.destinationDepartedAt ? new Date(active.destinationDepartedAt).toLocaleString() : "—") +
          field("Tracking URL", active.trackingUrl || "—") +
          field("Client URL", active.clientTrackingUrl || "—") +
          "</div>";
        if (active.lastLatitude != null && active.lastLongitude != null) {
          var mapUrl =
            "https://www.openstreetmap.org/?mlat=" +
            encodeURIComponent(active.lastLatitude) +
            "&mlon=" +
            encodeURIComponent(active.lastLongitude) +
            "#map=12/" +
            encodeURIComponent(active.lastLatitude) +
            "/" +
            encodeURIComponent(active.lastLongitude);
          gpsHtml +=
            '<p style="margin-top:0.75rem"><a class="btn-secondary" href="' +
            self.esc(mapUrl) +
            '" target="_blank" rel="noopener">Open map</a></p>';
        }
      } else {
        gpsHtml =
          '<p class="gos-muted" style="margin-top:0.75rem">No active CarrierView session. Enter driver phone and start tracking.</p>';
      }
      main.innerHTML =
        "<h2>Tracking</h2>" +
        '<ol class="load-tracking">' +
        steps +
        "</ol>" +
        "<h3>GPS — CarrierView</h3>" +
        (ready && ready.configured
          ? ready.enabled
            ? '<p class="gos-muted">Provider connected. Webhooks update live position.</p>'
            : '<p class="gos-muted">CarrierView token configured but <code>CARRIER_VIEW_ENABLED=false</code>.</p>'
          : '<p class="gos-muted">Set <code>CARRIER_VIEW_API_BASE_URL</code> + <code>CARRIER_VIEW_API_TOKEN</code> on the server.</p>') +
        gpsHtml +
        '<div class="load-edit-panel" style="margin-top:1rem">' +
        '<div class="load-form-grid">' +
        '<label>Driver phone <input id="ld-gps-phone" type="tel" value="' +
        self.esc(
          self.formatUsPhone(
            (active && active.driverPhone) || (data.carrier && data.carrier.driverPhone) || ""
          )
        ) +
        '" placeholder="(XXX) XXX-XXXX"></label>' +
        '<label class="full">Message to driver <input id="ld-gps-chat" maxlength="500" placeholder="Chat via CarrierView"></label>' +
        "</div>" +
        '<div class="load-actions" style="margin-top:0.5rem">' +
        '<button type="button" class="btn-primary" id="ld-gps-start">Start CarrierView tracking</button>' +
        '<button type="button" class="btn-secondary" id="ld-gps-refresh">Refresh</button>' +
        '<button type="button" class="btn-secondary" id="ld-gps-disable">Disable tracking</button>' +
        '<button type="button" class="btn-secondary" id="ld-gps-chat-send">Send chat</button>' +
        '<button type="button" class="btn-secondary" id="ld-gps-sms">Send welcome SMS</button>' +
        "</div>" +
        '<p id="ld-gps-status" class="gos-muted" style="margin-top:0.5rem"></p>' +
        "</div>";

      async function gpsApi(path, opts) {
        return self.api("/" + encodeURIComponent(id) + "/tracking" + path, opts);
      }
      function setGpsStatus(t) {
        var el = main.querySelector("#ld-gps-status");
        if (el) el.textContent = t || "";
      }
      self.bindUsPhoneInput(main.querySelector("#ld-gps-phone"));
      main.querySelector("#ld-gps-start")?.addEventListener("click", async function () {
        try {
          setGpsStatus("Starting…");
          await gpsApi("/start", {
            method: "POST",
            body: JSON.stringify({
              driverPhone: self.toE164UsPhone(main.querySelector("#ld-gps-phone").value) || null,
            }),
          });
          self.openLoad(document.querySelector("#load-tms-body"), id, "tracking");
        } catch (err) {
          alert(err.message || err);
          setGpsStatus("");
        }
      });
      main.querySelector("#ld-gps-refresh")?.addEventListener("click", async function () {
        try {
          setGpsStatus("Refreshing…");
          await gpsApi("/refresh", { method: "POST", body: "{}" });
          self.openLoad(document.querySelector("#load-tms-body"), id, "tracking");
        } catch (err) {
          alert(err.message || err);
          setGpsStatus("");
        }
      });
      main.querySelector("#ld-gps-disable")?.addEventListener("click", async function () {
        if (!confirm("Disable CarrierView tracking for this Load? History is kept.")) return;
        try {
          await gpsApi("/disable", { method: "POST", body: "{}" });
          self.openLoad(document.querySelector("#load-tms-body"), id, "tracking");
        } catch (err) {
          alert(err.message || err);
        }
      });
      main.querySelector("#ld-gps-chat-send")?.addEventListener("click", async function () {
        var msg = (main.querySelector("#ld-gps-chat").value || "").trim();
        if (!msg) return alert("Enter a message");
        try {
          await gpsApi("/chat", { method: "POST", body: JSON.stringify({ message: msg }) });
          setGpsStatus("Chat sent");
          main.querySelector("#ld-gps-chat").value = "";
        } catch (err) {
          alert(err.message || err);
        }
      });
      main.querySelector("#ld-gps-sms")?.addEventListener("click", async function () {
        if (!confirm("Send welcome SMS via CarrierView? This is NOT idempotent — do not spam.")) return;
        try {
          await gpsApi("/sms", { method: "POST", body: JSON.stringify({ type: "welcome" }) });
          setGpsStatus("SMS sent");
        } catch (err) {
          alert(err.message || err);
        }
      });
      return;
    }

    if (tab === "documents") {
      self.renderDocumentsTab(main, data);
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
      var paymentRole = self.role();
      var canManagePayments =
        paymentRole === "Accounting" ||
        paymentRole === "Owner" ||
        paymentRole === "Administrator";
      var paymentActions = data.quickActions || [];
      var customerPaymentAction = paymentActions.find(function (x) {
        return x.id === "mark_customer_paid";
      });
      var carrierPaymentAction = paymentActions.find(function (x) {
        return x.id === "mark_carrier_paid";
      });
      function isoDate(value) {
        if (!value) return "";
        try {
          return new Date(value).toISOString().slice(0, 10);
        } catch (e) {
          return "";
        }
      }
      var moneyFields = canManagePayments
        ? '<div class="load-form-grid">' +
          "<label>Freight cost (customer)" +
          self.moneyFieldHtml("acc-freight", a.customerRate || "", "0.00") +
          "</label>" +
          "<label>Carrier pay" +
          self.moneyFieldHtml("acc-carrier-rate", a.carrierRate || "", "0.00") +
          "</label>" +
          "<label>Factoring" +
          self.moneyFieldHtml("acc-factoring", a.factoring || "", "0.00") +
          "</label>" +
          "<label>Customer invoice #" +
          '<input id="acc-invoice" type="text" value="' +
          self.esc(a.customerInvoice || "") +
          '"></label>' +
          "<label>Payment status" +
          '<select id="acc-pay-status">' +
          ["", "Pending", "Invoiced", "Partial", "Paid", "Overdue"]
            .map(function (opt) {
              var selected =
                String(a.paymentStatus || "") === opt ||
                (!a.paymentStatus && opt === "")
                  ? " selected"
                  : "";
              return (
                '<option value="' +
                self.esc(opt) +
                '"' +
                selected +
                ">" +
                (opt || "—") +
                "</option>"
              );
            })
            .join("") +
          "</select></label>" +
          "<label>Invoice date" +
          '<input id="acc-invoice-date" type="date" value="' +
          isoDate(a.invoiceDate) +
          '"></label>' +
          "<label>Due date" +
          '<input id="acc-due-date" type="date" value="' +
          isoDate(a.dueDate) +
          '"></label>' +
          "<label>Payment date" +
          '<input id="acc-pay-date" type="date" value="' +
          isoDate(a.paymentDate) +
          '"></label>' +
          "</div>" +
          '<div class="load-grid" style="margin-top:0.75rem">' +
          field("Broker Profit", self.money(a.brokerProfit)) +
          field("Company Profit", self.money(a.companyProfit)) +
          field("Margin", a.margin != null ? a.margin + "%" : "—") +
          field("Outstanding Balance", self.money(a.outstandingBalance)) +
          "</div>" +
          '<button type="button" class="btn-primary" id="acc-save" style="width:auto;margin-top:0.85rem">Save accounting</button>'
        : '<div class="load-grid">' +
          field("Customer Invoice", a.customerInvoice) +
          field("Payment Status", a.paymentStatus) +
          field("Invoice Date", a.invoiceDate ? new Date(a.invoiceDate).toLocaleDateString() : "—") +
          field("Due Date", a.dueDate ? new Date(a.dueDate).toLocaleDateString() : "—") +
          field("Payment Date", a.paymentDate ? new Date(a.paymentDate).toLocaleDateString() : "—") +
          "</div>";
      main.innerHTML =
        "<h2>Accounting</h2>" +
        '<p class="gos-muted">' +
        (canManagePayments
          ? "Enter freight cost, invoices, and payment proofs. Brokers see payment status and uploaded documents."
          : "Payment status and documents from Accounting. Money / profit stays with Accounting.") +
        "</p>" +
        '<div class="load-payment-statuses load-payment-statuses-wide">' +
        '<div class="load-payment-status' +
        (a.customerPaidAt ? " is-paid" : "") +
        '"><span>Customer Paid</span><strong>' +
        (a.customerPaidAt ? "✓ Payment Received" : "Pending") +
        "</strong>" +
        (a.customerPaidAt
          ? "<small>" + self.esc(new Date(a.customerPaidAt).toLocaleString()) + "</small>"
          : "") +
        self.paymentProofHtml(a.customerPaidDoc, {
          canUpload: canManagePayments,
          inputClass: "acc-upload-customer",
        }) +
        (canManagePayments && !a.customerPaidAt
          ? '<button type="button" class="btn-primary" id="acc-customer-paid"' +
            (customerPaymentAction && customerPaymentAction.state === "current"
              ? ""
              : " disabled") +
            ">Payment Received</button>"
          : "") +
        "</div>" +
        '<div class="load-payment-status' +
        (a.carrierPaidAt ? " is-paid" : "") +
        '"><span>Carrier Paid</span><strong>' +
        (a.carrierPaidAt ? "✓ Carrier / Factoring Paid" : "Pending") +
        "</strong>" +
        (a.carrierPaidAt
          ? "<small>" + self.esc(new Date(a.carrierPaidAt).toLocaleString()) + "</small>"
          : "") +
        self.paymentProofHtml(a.carrierPaidDoc, {
          canUpload: canManagePayments,
          inputClass: "acc-upload-carrier",
        }) +
        (canManagePayments && !a.carrierPaidAt
          ? '<button type="button" class="btn-primary" id="acc-carrier-paid"' +
            (carrierPaymentAction && carrierPaymentAction.state === "current"
              ? ""
              : " disabled") +
            ">Mark Carrier Paid</button>"
          : "") +
        "</div></div>" +
        moneyFields +
        '<p id="acc-payment-msg" class="gos-muted" style="margin-top:0.65rem"></p>';

      self.bindPaymentDocButtons(main);

      async function reloadAccounting() {
        var host =
          document.querySelector("#load-tms-body") ||
          main.closest("[data-module]") ||
          main.parentElement;
        await self.openLoad(host, id, "accounting");
      }

      async function confirmPayment(action, promptText) {
        if (!confirm(promptText)) return;
        var msg = main.querySelector("#acc-payment-msg");
        try {
          if (msg) msg.textContent = "Saving payment status…";
          await self.api(
            "/" + encodeURIComponent(id) + "/actions/" + encodeURIComponent(action),
            { method: "POST", body: "{}" }
          );
          await reloadAccounting();
        } catch (err) {
          if (msg) msg.textContent = err.message || "Failed to update payment";
        }
      }

      async function uploadProof(docType, file) {
        var msg = main.querySelector("#acc-payment-msg");
        if (!file) return;
        try {
          if (msg) msg.textContent = "Uploading document…";
          var form = new FormData();
          form.append("file", file);
          await self.apiUpload(
            "/" + encodeURIComponent(id) + "/documents/" + encodeURIComponent(docType) + "/upload",
            form
          );
          await reloadAccounting();
        } catch (err) {
          if (msg) msg.textContent = err.message || "Upload failed";
        }
      }

      main.querySelector("#acc-customer-paid")?.addEventListener("click", function () {
        confirmPayment(
          "mark_customer_paid",
          "Confirm that customer payment was received?"
        );
      });
      main.querySelector("#acc-carrier-paid")?.addEventListener("click", function () {
        confirmPayment(
          "mark_carrier_paid",
          "Confirm that the carrier / factoring company was paid?"
        );
      });
      main.querySelector(".acc-upload-customer")?.addEventListener("change", function (ev) {
        uploadProof("CUSTOMER_PAID_PROOF", ev.target.files && ev.target.files[0]);
      });
      main.querySelector(".acc-upload-carrier")?.addEventListener("change", function (ev) {
        uploadProof("CARRIER_PAID_PROOF", ev.target.files && ev.target.files[0]);
      });
      main.querySelector("#acc-save")?.addEventListener("click", async function () {
        var msg = main.querySelector("#acc-payment-msg");
        try {
          if (msg) msg.textContent = "Saving accounting…";
          await self.api("/" + encodeURIComponent(id), {
            method: "PATCH",
            body: JSON.stringify({
              customerRate: self.parseMoneyInput(main.querySelector("#acc-freight")?.value),
              carrierRate: self.parseMoneyInput(main.querySelector("#acc-carrier-rate")?.value),
              factoringFee: self.parseMoneyInput(main.querySelector("#acc-factoring")?.value),
              invoiceNumber: main.querySelector("#acc-invoice")?.value || null,
              paymentStatus: main.querySelector("#acc-pay-status")?.value || null,
              invoiceDate: main.querySelector("#acc-invoice-date")?.value || null,
              invoiceDueDate: main.querySelector("#acc-due-date")?.value || null,
              paymentDate: main.querySelector("#acc-pay-date")?.value || null,
            }),
          });
          await reloadAccounting();
        } catch (err) {
          if (msg) msg.textContent = err.message || "Failed to save accounting";
        }
      });
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
    var c = data.carrier || {};
    var docs = data.documents || [];
    var genTypes = [
      ["RATE_CONFIRMATION", "Generate Rate Confirmation"],
      ["BOL", "Generate BOL"],
      ["CUSTOMER_INVOICE", "Generate Invoice"],
      ["CARRIER_INVOICE", "Generate Carrier Invoice"],
      ["DISPATCH_SHEET", "Generate Dispatch Sheet"],
      ["LOAD_SUMMARY", "Generate Load Summary"],
      ["POD", "Upload POD"],
    ].filter(function (t) {
      // After POD, invoice/payment work belongs to Accounting—not the broker.
      if (
        self.role() === "Broker" &&
        (t[0] === "CUSTOMER_INVOICE" || t[0] === "CARRIER_INVOICE")
      ) {
        return false;
      }
      return true;
    });

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
      (c.carrierProfileId || (c.onboardingDocuments && c.onboardingDocuments.length)
        ? '<div class="ld-carrier-review' +
          (String(c.onboardingStatus || "").toUpperCase() === "APPROVED"
            ? " is-approved"
            : String(c.onboardingStatus || "").toUpperCase() === "SUBMITTED" ||
                String(c.onboardingStatus || "").toUpperCase() === "UNDER_REVIEW"
              ? " is-pending"
              : "") +
          '" style="margin-bottom:1rem">' +
          "<h3>Carrier packet (signed &amp; returned)</h3>" +
          '<p class="gos-muted" style="margin:0.25rem 0 0">Onboarding: <strong>' +
          self.esc(c.onboardingStatus || "—") +
          "</strong>" +
          (c.agreementSigned ? " · Agreement signed" : "") +
          ". Open these to verify MC / NOA / W-9 and the signed Broker–Carrier Agreement.</p>" +
          self.carrierPacketDocsHtml(c) +
          "</div>"
        : "") +
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

    self.bindCarrierPacketDocButtons(main, c.carrierProfileId);

    main.querySelectorAll(".load-gen-doc").forEach(function (btn) {
      btn.addEventListener("click", async function () {
        var docType = btn.getAttribute("data-type");
        if (docType === "RATE_CONFIRMATION") {
          self.showRateConWizard(main, id, data, "GENERATED");
          return;
        }
        if (docType === "BOL") {
          self.showBolWizard(main, id, data, "GENERATED");
          return;
        }
        if (docType === "POD") {
          self.showPodWizard(main, id, data, "GENERATED");
          return;
        }
        if (docType === "CUSTOMER_INVOICE") {
          self.showInvoiceWizard(main, id, data, "GENERATED");
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
    if (docType === "BOL") {
      this.showBolWizard(main, id, data, "BROKER_EDITED");
      return;
    }
    if (docType === "POD") {
      this.showPodWizard(main, id, data, "BROKER_EDITED");
      return;
    }
    if (docType === "CUSTOMER_INVOICE") {
      this.showInvoiceWizard(main, id, data, "BROKER_EDITED");
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
    var prev = self.currentDocContent(data, "RATE_CONFIRMATION");
    function pick(key, fallback) {
      var v = prev[key];
      if (v == null || v === "") return fallback == null ? "" : fallback;
      return v;
    }
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
      '<label>Broker Gmail <input id="rc-broker-email" value="' +
      self.esc((data.contacts && data.contacts.brokerGmail) || (g.broker && g.broker.gmail) || (g.broker && g.broker.email) || "") +
      '" readonly></label>' +
      '<label>Customer email <input id="rc-customer-email" type="email" value="' +
      self.esc((data.contacts && data.contacts.customerEmail) || g.customerEmail || "") +
      '" placeholder="customer@gmail.com"></label>' +
      '<label>Carrier * <input id="rc-carrier" value="' + self.esc(c.carrierName || "") + '"></label>' +
      '<label>Carrier email * <input id="rc-carrier-email" type="email" value="' +
      self.esc(c.carrierEmail || (data.contacts && data.contacts.carrierEmail) || "") +
      '" placeholder="dispatch@carrier.com"></label>' +
      '<label>MC# <input id="rc-mc" value="' + self.esc(c.mc || "") + '"></label>' +
      '<label>DOT# <input id="rc-dot" value="' + self.esc(c.dot || "") + '"></label>' +
      '<label>Carrier phone <input id="rc-cphone" type="tel" value="' +
      self.esc(self.formatUsPhone(c.carrierPhone || "")) +
      '" placeholder="(XXX) XXX-XXXX"></label>' +
      '<label>Equipment <input id="rc-equip" value="' + self.esc(g.equipment || "") + '"></label>' +
      '<label>Weight <input id="rc-weight" value="' + self.esc(g.weight || "") + '"></label>' +
      '<label>Commodity <input id="rc-commodity" value="' + self.esc(g.commodity || "") + '"></label>' +
      "<label>Flat Rate $USD *" +
      self.moneyFieldHtml("rc-rate", p.carrierRate || "", "1000.00") +
      "</label>" +
      '<label class="full">Origin (pickup address) <input id="rc-origin" value="' + self.esc(place(g.pickup)) + '"></label>' +
      '<label>Pickup date <input id="rc-pdate" type="date" value="' + self.esc(self.toInputDate(pickupSrc)) + '"></label>' +
      "<label>Pickup time" +
      self.timeFieldHtml("rc-ptime", pickupSrc) +
      "</label>" +
      '<label class="full">Pickup contact <input id="rc-pcontact" placeholder="Name / phone at shipper" value="' +
      self.esc(pick("pickupContact", "")) +
      '"></label>' +
      '<label class="full">Final destination <input id="rc-dest" value="' + self.esc(pick("deliveryAddress", place(g.delivery))) + '"></label>' +
      '<label>Delivery date <input id="rc-ddate" type="date" value="' + self.esc(self.toInputDate(deliverySrc)) + '"></label>' +
      "<label>Delivery time" +
      self.timeFieldHtml("rc-dtime", deliverySrc) +
      "</label>" +
      '<label class="full">Delivery contact <input id="rc-dcontact" placeholder="Name / phone at consignee" value="' +
      self.esc(pick("deliveryContact", "")) +
      '"></label>' +
      '<label>Driver name <input id="rc-driver" value="' + self.esc(c.driverName || "") + '"></label>' +
      '<label>Driver phone <input id="rc-dphone" type="tel" value="' +
      self.esc(self.formatUsPhone(c.driverPhone || "")) +
      '" placeholder="(XXX) XXX-XXXX"></label>' +
      '<label>Truck # <input id="rc-truck" value="' + self.esc(c.truckNumber || "") + '"></label>' +
      '<label>Trailer # <input id="rc-trailer" value="' + self.esc(c.trailerNumber || "") + '"></label>' +
      '<label class="full">Payment option <input id="rc-pay" value="' +
      self.esc(pick("paymentOption", "")) +
      '" placeholder="QuickPay / Factoring / Net 30…"></label>' +
      '<label class="full">Delivery note <textarea id="rc-delnote" rows="2">' +
      self.esc(pick("deliveryNote", "")) +
      "</textarea></label>" +
      '<label class="full">Special notes <textarea id="rc-notes" rows="3">' +
      self.esc(pick("specialNotes", g.specialInstructions || "")) +
      "</textarea></label>" +
      '<label class="full">Terms (RC standard) <textarea id="rc-terms" rows="8">' +
      self.esc(pick("terms", defaultTerms)) +
      "</textarea></label>" +
      "</div>" +
      '<div class="load-actions" style="margin-top:0.75rem">' +
      '<button type="button" class="btn-primary" id="rc-generate">Save Load &amp; Generate Rate Con PDF</button>' +
      '<button type="button" class="btn-secondary" id="rc-cancel">Cancel</button>' +
      "</div>" +
      '<p id="rc-status" class="gos-muted" style="margin-top:0.5rem"></p>';

    box.scrollIntoView({ behavior: "smooth", block: "start" });
    self.bindUsPhoneInput(box.querySelector("#rc-cphone"));
    self.bindUsPhoneInput(box.querySelector("#rc-dphone"));

    box.querySelector("#rc-cancel")?.addEventListener("click", function () {
      box.classList.add("hidden");
      box.innerHTML = "";
    });

    box.querySelector("#rc-generate")?.addEventListener("click", async function () {
      var carrier = (box.querySelector("#rc-carrier").value || "").trim();
      var rate = self.parseMoneyInput(box.querySelector("#rc-rate").value);
      var carrierEmail = (box.querySelector("#rc-carrier-email").value || "").trim();
      if (!carrier) {
        alert("Carrier name is required for Rate Confirmation.");
        box.querySelector("#rc-carrier").focus();
        return;
      }
      if (!carrierEmail) {
        alert("Carrier email is required for Rate Confirmation.");
        box.querySelector("#rc-carrier-email").focus();
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
          body: JSON.stringify(
            Object.assign(
              {
                carrierName: carrier,
                carrierEmail: carrierEmail,
                carrierPhone: self.formatUsPhone(box.querySelector("#rc-cphone").value) || null,
                customerEmail: box.querySelector("#rc-customer-email").value || null,
                carrierMc: box.querySelector("#rc-mc").value || null,
                carrierDot: box.querySelector("#rc-dot").value || null,
                driverName: box.querySelector("#rc-driver").value || null,
                driverPhone: self.formatUsPhone(box.querySelector("#rc-dphone").value) || null,
                truckNumber: box.querySelector("#rc-truck").value || null,
                trailerNumber: box.querySelector("#rc-trailer").value || null,
                equipment: box.querySelector("#rc-equip").value || null,
                weight: box.querySelector("#rc-weight").value || null,
                commodity: box.querySelector("#rc-commodity").value || null,
                specialInstructions: box.querySelector("#rc-notes").value || null,
                carrierNotes: box.querySelector("#rc-delnote").value || null,
                pickupFrom: self.combineDateTime(
                  box.querySelector("#rc-pdate").value,
                  self.readAmPmTime(box, "rc-ptime")
                ),
                deliveryFrom: self.combineDateTime(
                  box.querySelector("#rc-ddate").value,
                  self.readAmPmTime(box, "rc-dtime")
                ),
                opsPickupAt: self.combineDateTime(
                  box.querySelector("#rc-pdate").value,
                  self.readAmPmTime(box, "rc-ptime")
                ),
                opsDeliveryAt: self.combineDateTime(
                  box.querySelector("#rc-ddate").value,
                  self.readAmPmTime(box, "rc-dtime")
                ),
              },
              // Money / books: Accounting+Owner only. Brokers still put Flat Rate on the PDF.
              self.canSeeMoney() ? { carrierRate: rate } : {}
            )
          ),
        });

        if (statusEl) statusEl.textContent = "Generating Rate Confirmation PDF…";
        var pickupTime24 = self.readAmPmTime(box, "rc-ptime");
        var deliveryTime24 = self.readAmPmTime(box, "rc-dtime");
        var content = {
          loadNumber: box.querySelector("#rc-load").value,
          shipmentNumber: box.querySelector("#rc-ship").value,
          confirmationDate: box.querySelector("#rc-date").value,
          brokerName: box.querySelector("#rc-broker").value,
          brokerEmail: box.querySelector("#rc-broker-email").value,
          customerEmail: box.querySelector("#rc-customer-email").value,
          carrierName: carrier,
          carrierEmail: carrierEmail,
          carrierMc: box.querySelector("#rc-mc").value,
          carrierDot: box.querySelector("#rc-dot").value,
          carrierPhone: self.formatUsPhone(box.querySelector("#rc-cphone").value) || box.querySelector("#rc-cphone").value,
          equipment: box.querySelector("#rc-equip").value,
          weight: box.querySelector("#rc-weight").value,
          commodity: box.querySelector("#rc-commodity").value,
          flatRate: rate,
          carrierRate: rate,
          pickupAddress: box.querySelector("#rc-origin").value,
          pickupDate: box.querySelector("#rc-pdate").value,
          pickupTime: self.formatAmPmLabel(pickupTime24) || pickupTime24,
          pickupContact: box.querySelector("#rc-pcontact").value,
          deliveryAddress: box.querySelector("#rc-dest").value,
          deliveryDate: box.querySelector("#rc-ddate").value,
          deliveryTime: self.formatAmPmLabel(deliveryTime24) || deliveryTime24,
          deliveryContact: box.querySelector("#rc-dcontact").value,
          driverName: box.querySelector("#rc-driver").value,
          driverPhone: self.formatUsPhone(box.querySelector("#rc-dphone").value) || box.querySelector("#rc-dphone").value,
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

  /** BOL wizard — Master Bill of Lading fields matching company BOL.pdf. */
  showBolWizard(main, id, data, changeReason) {
    var self = this;
    var g = data.general || {};
    var c = data.carrier || {};
    var contacts = data.contacts || {};
    var box = main.querySelector("#load-doc-editor");
    if (!box) {
      main.insertAdjacentHTML("beforeend", '<div id="load-doc-editor" class="load-edit-panel"></div>');
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
    var pickupSrc = (g.pickup && (g.pickup.opsAt || g.pickup.from)) || null;
    var deliverySrc = (g.delivery && (g.delivery.opsAt || g.delivery.from)) || null;
    var prev = self.currentDocContent(data, "BOL");
    function pick(key, fallback) {
      var v = prev[key];
      if (v == null || v === "") return fallback == null ? "" : fallback;
      return v;
    }

    box.innerHTML =
      "<h3>Generate Bill of Lading</h3>" +
      '<p class="gos-muted">Layout matches Green Logistics Master BOL (SHIPS FROM / SHIPS TO / Carrier / Order / Signatures). Emails included.</p>' +
      '<div class="load-form-grid">' +
      '<label>BOL / Load No <input id="bol-no" value="' + self.esc(g.loadNumber || "") + '"></label>' +
      '<label>Pickup date <input id="bol-pdate" value="' + self.esc(dt(pickupSrc)) + '"></label>' +
      '<label>Broker Gmail <input id="bol-broker-email" value="' +
      self.esc(contacts.brokerGmail || (g.broker && g.broker.gmail) || (g.broker && g.broker.email) || "") +
      '" readonly></label>' +
      '<label>Customer email <input id="bol-customer-email" type="email" value="' +
      self.esc(contacts.customerEmail || g.customerEmail || "") +
      '"></label>' +
      '<label>Carrier email * <input id="bol-carrier-email" type="email" value="' +
      self.esc(c.carrierEmail || contacts.carrierEmail || "") +
      '"></label>' +
      '<label>Customer <input id="bol-customer" value="' + self.esc(g.customer || "") + '"></label>' +
      '<label class="full">SHIPS FROM (origin) <input id="bol-origin" value="' + self.esc(pick("pickupAddress", place(g.pickup))) + '"></label>' +
      '<label>Shipper ID No. <input id="bol-shipper-id" value="' + self.esc(pick("shipperIdNo", "")) + '"></label>' +
      '<label>Seal No. <input id="bol-seal" value="' + self.esc(pick("sealNo", "")) + '"></label>' +
      '<label>FOB <input id="bol-fob" value="' + self.esc(pick("fob", "")) + '"></label>' +
      '<label>Freight terms <select id="bol-terms">' +
      '<option value="PREPAID">PREPAID</option>' +
      '<option value="COLLECT">COLLECT</option>' +
      '<option value="3RD_PARTY">3RD PARTY</option>' +
      "</select></label>" +
      '<label class="full">SHIPS TO (destination) <input id="bol-dest" value="' + self.esc(pick("deliveryAddress", place(g.delivery))) + '"></label>' +
      '<label>Consignee ID No. <input id="bol-consignee-id" value="' + self.esc(pick("consigneeIdNo", "")) + '"></label>' +
      '<label>Delivery contact <input id="bol-dcontact" value="' + self.esc(pick("deliveryContact", "")) + '"></label>' +
      '<label>Carrier <input id="bol-carrier" value="' + self.esc(c.carrierName || "") + '"></label>' +
      '<label>MC# <input id="bol-mc" value="' + self.esc(c.mc || "") + '"></label>' +
      '<label>Truck <input id="bol-truck" value="' + self.esc(c.truckNumber || "") + '"></label>' +
      '<label>Trailer# <input id="bol-trailer" value="' + self.esc(c.trailerNumber || "") + '"></label>' +
      '<label>VIN# <input id="bol-vin" value="' + self.esc(pick("vinNumber", "")) + '"></label>' +
      '<label>Carrier / driver contact <input id="bol-cphone" value="' + self.esc(c.driverName || "") + '"></label>' +
      '<label class="full">Third party freight bills to <input id="bol-third" value="' + self.esc(g.customer || "") + '"></label>' +
      '<label>Customer order no. <input id="bol-order" value="' + self.esc(pick("customerOrderNo", "")) + '"></label>' +
      '<label># Pkgs <input id="bol-pkgs" type="number" value="' + self.esc(g.pieces == null ? "" : g.pieces) + '"></label>' +
      '<label>Weight <input id="bol-weight" value="' + self.esc(g.weight || "") + '"></label>' +
      '<label>Pallet/Slip <select id="bol-pallet"><option value="N">N</option><option value="Y">Y</option></select></label>' +
      '<label>Handling type <input id="bol-htype" value="PLT"></label>' +
      '<label>Package type <input id="bol-ptype" value="PCS"></label>' +
      '<label>Hazmat <select id="bol-hm"><option value="">No</option><option value="X">Yes (X)</option></select></label>' +
      '<label class="full">Commodity description <input id="bol-commodity" value="' + self.esc(g.commodity || "") + '"></label>' +
      '<label>COD amount $ <input id="bol-cod" value="' + self.esc(pick("codAmount", "")) + '"></label>' +
      '<label>Remit COD to <input id="bol-cod-to" value="' + self.esc(pick("remittanceCodTo", "")) + '"></label>' +
      '<label>Trailer loaded by <select id="bol-loaded"><option value="">—</option><option value="SHIPPER">BY SHIPPER</option><option value="DRIVER">BY DRIVER</option></select></label>' +
      '<label>Freight counted by <select id="bol-counted"><option value="">—</option><option value="SHIPPER">BY SHIPPER</option><option value="DRIVER_PALLETS">BY DRIVER/PALLETS</option><option value="DRIVER_PIECES">BY DRIVER/PIECES</option></select></label>' +
      '<label class="full">Special instructions <textarea id="bol-notes" rows="3">' +
      self.esc(g.specialInstructions || "") +
      "</textarea></label>" +
      "</div>" +
      '<div class="load-actions" style="margin-top:0.75rem">' +
      '<button type="button" class="btn-primary" id="bol-generate">Save &amp; Generate BOL PDF</button>' +
      '<p class="gos-muted" style="margin:0.35rem 0 0">After Save, Green OS emails the filled RC + BOL secure link from your Gmail to the carrier.</p>' +
      '<button type="button" class="btn-secondary" id="bol-cancel">Cancel</button>' +
      "</div>" +
      '<p id="bol-status" class="gos-muted" style="margin-top:0.5rem"></p>';

    box.scrollIntoView({ behavior: "smooth", block: "start" });
    if (box.querySelector("#bol-terms")) {
      box.querySelector("#bol-terms").value = pick("freightTerms", "PREPAID") || "PREPAID";
    }
    if (box.querySelector("#bol-pallet")) {
      box.querySelector("#bol-pallet").value = prev.palletSlip === true || prev.palletSlip === "Y" ? "Y" : "N";
    }
    if (box.querySelector("#bol-hm")) {
      box.querySelector("#bol-hm").value = prev.hazmat === true || prev.hazmat === "X" ? "X" : "";
    }
    if (box.querySelector("#bol-loaded") && prev.trailerLoadedBy) {
      box.querySelector("#bol-loaded").value = prev.trailerLoadedBy;
    }
    if (box.querySelector("#bol-counted") && prev.freightCountedBy) {
      box.querySelector("#bol-counted").value = prev.freightCountedBy;
    }
    if (box.querySelector("#bol-htype") && prev.handlingType) {
      box.querySelector("#bol-htype").value = prev.handlingType;
    }
    if (box.querySelector("#bol-ptype") && prev.packageType) {
      box.querySelector("#bol-ptype").value = prev.packageType;
    }
    box.querySelector("#bol-cancel")?.addEventListener("click", function () {
      box.classList.add("hidden");
      box.innerHTML = "";
    });

    box.querySelector("#bol-generate")?.addEventListener("click", async function () {
      var carrierEmail = (box.querySelector("#bol-carrier-email").value || "").trim();
      if (!carrierEmail) {
        alert("Carrier email is required on BOL.");
        box.querySelector("#bol-carrier-email").focus();
        return;
      }
      var statusEl = box.querySelector("#bol-status");
      var btnGen = box.querySelector("#bol-generate");
      try {
        if (btnGen) btnGen.disabled = true;
        if (statusEl) statusEl.textContent = "Saving load…";
        await self.api("/" + encodeURIComponent(id), {
          method: "PATCH",
          body: JSON.stringify({
            customerName: box.querySelector("#bol-customer").value || null,
            customerEmail: box.querySelector("#bol-customer-email").value || null,
            carrierName: box.querySelector("#bol-carrier").value || null,
            carrierEmail: carrierEmail,
            carrierMc: box.querySelector("#bol-mc").value || null,
            truckNumber: box.querySelector("#bol-truck").value || null,
            trailerNumber: box.querySelector("#bol-trailer").value || null,
            commodity: box.querySelector("#bol-commodity").value || null,
            weight: box.querySelector("#bol-weight").value || null,
            pieces: box.querySelector("#bol-pkgs").value || null,
            specialInstructions: box.querySelector("#bol-notes").value || null,
          }),
        });
        if (statusEl) statusEl.textContent = "Generating Master BOL PDF…";
        var content = {
          loadNumber: g.loadNumber,
          shipmentNumber: g.shipmentNumber,
          bolNumber: box.querySelector("#bol-no").value,
          pickupDate: box.querySelector("#bol-pdate").value,
          deliveryDate: dt(deliverySrc),
          brokerEmail: box.querySelector("#bol-broker-email").value,
          brokerName: (g.broker && g.broker.name) || "",
          customerName: box.querySelector("#bol-customer").value,
          customerEmail: box.querySelector("#bol-customer-email").value,
          carrierName: box.querySelector("#bol-carrier").value,
          carrierEmail: carrierEmail,
          carrierMc: box.querySelector("#bol-mc").value,
          carrierPhone: box.querySelector("#bol-cphone").value,
          truckNumber: box.querySelector("#bol-truck").value,
          trailerNumber: box.querySelector("#bol-trailer").value,
          vinNumber: box.querySelector("#bol-vin").value,
          pickupAddress: box.querySelector("#bol-origin").value,
          deliveryAddress: box.querySelector("#bol-dest").value,
          shipperIdNo: box.querySelector("#bol-shipper-id").value,
          consigneeIdNo: box.querySelector("#bol-consignee-id").value,
          sealNo: box.querySelector("#bol-seal").value,
          fob: box.querySelector("#bol-fob").value,
          freightTerms: box.querySelector("#bol-terms").value,
          thirdPartyBillTo: box.querySelector("#bol-third").value,
          deliveryContact: box.querySelector("#bol-dcontact").value,
          customerOrderNo: box.querySelector("#bol-order").value,
          pieces: box.querySelector("#bol-pkgs").value,
          packageQty: box.querySelector("#bol-pkgs").value,
          handlingQty: box.querySelector("#bol-pkgs").value,
          weight: box.querySelector("#bol-weight").value,
          palletSlip: box.querySelector("#bol-pallet").value === "Y",
          handlingType: box.querySelector("#bol-htype").value,
          packageType: box.querySelector("#bol-ptype").value,
          hazmat: box.querySelector("#bol-hm").value === "X",
          commodity: box.querySelector("#bol-commodity").value,
          codAmount: box.querySelector("#bol-cod").value,
          remittanceCodTo: box.querySelector("#bol-cod-to").value,
          trailerLoadedBy: box.querySelector("#bol-loaded").value,
          freightCountedBy: box.querySelector("#bol-counted").value,
          specialInstructions: box.querySelector("#bol-notes").value,
          specialNotes: box.querySelector("#bol-notes").value,
        };
        var endpoint =
          (changeReason || "GENERATED") === "GENERATED"
            ? "/" + encodeURIComponent(id) + "/documents/BOL/generate"
            : "/" + encodeURIComponent(id) + "/documents/BOL/edit";
        var row = await self.api(endpoint, {
          method: "POST",
          body: JSON.stringify({ changeReason: changeReason || "GENERATED", content: content }),
        });
        if (statusEl) statusEl.textContent = "Sending RC/BOL secure link to carrier…";
        try {
          var bolToken = localStorage.getItem("gl_token") || "";
          var bolInvRes = await fetch(
            "/api/carriers/from-load/" + encodeURIComponent(id) + "/invite-rc-bol",
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: "Bearer " + bolToken,
              },
              body: "{}",
            }
          );
          var bolInvJson = await bolInvRes.json().catch(function () { return {}; });
          if (!bolInvRes.ok || bolInvJson.success === false) {
            alert(
              "BOL saved, but RC/BOL email failed:\n" +
                (bolInvJson.message || "Connect Broker Gmail and retry.")
            );
          }
        } catch (bolInvErr) {
          alert("BOL saved, but RC/BOL email failed. Connect Broker Gmail.");
        }
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
        }
      } catch (err) {
        alert(err.message || err);
        if (btnGen) btnGen.disabled = false;
        if (statusEl) statusEl.textContent = "";
      }
    });
  },

  /** Thank-you / review link email: Send Customer, Send Carrier, or both. */
  showReviewLinkModal(body, id, data) {
    var self = this;
    document.getElementById("load-review-modal")?.remove();
    var reviews = data.reviews || {};
    var contacts = data.contacts || {};
    var g = data.general || {};
    var c = data.carrier || {};
    var customerEmail = contacts.customerEmail || g.customerEmail || "";
    var carrierEmail = contacts.carrierEmail || (c && c.carrierEmail) || "";
    var customerSent = Boolean(reviews.customerSentAt);
    var carrierSent = Boolean(reviews.carrierSentAt);
    var modal = document.createElement("div");
    modal.id = "load-review-modal";
    modal.className = "crm-modal";
    modal.innerHTML =
      '<div class="crm-modal-card load-review-card">' +
      '<div class="crm-modal-head">' +
      "<div><h2>Send Review Link</h2>" +
      '<p class="gos-muted">Choose Customer, Carrier, or both. The thank-you email is always sent from accounting@greengrouplogistics.com.</p></div>' +
      '<button type="button" class="btn-secondary" id="review-close">Close</button>' +
      "</div>" +
      '<div class="load-review-choices">' +
      '<label class="load-review-choice' +
      (customerSent ? " is-sent" : "") +
      '">' +
      '<input type="checkbox" id="review-send-customer"' +
      (customerEmail ? " checked" : "") +
      ">" +
      "<div><strong>Send Customer</strong>" +
      "<span>" +
      self.esc(g.customer || "Customer") +
      "</span>" +
      '<input type="email" id="review-customer-email" value="' +
      self.esc(customerEmail) +
      '" placeholder="customer@email.com">' +
      (customerSent
        ? "<small>✓ Sent " +
          self.esc(new Date(reviews.customerSentAt).toLocaleString()) +
          (reviews.customerSentTo ? " to " + self.esc(reviews.customerSentTo) : "") +
          "</small>"
        : "") +
      "</div></label>" +
      '<label class="load-review-choice' +
      (carrierSent ? " is-sent" : "") +
      '">' +
      '<input type="checkbox" id="review-send-carrier"' +
      (carrierEmail ? " checked" : "") +
      ">" +
      "<div><strong>Send Carrier</strong>" +
      "<span>" +
      self.esc((c && c.carrierName) || "Carrier") +
      "</span>" +
      '<input type="email" id="review-carrier-email" value="' +
      self.esc(carrierEmail) +
      '" placeholder="carrier@email.com">' +
      (carrierSent
        ? "<small>✓ Sent " +
          self.esc(new Date(reviews.carrierSentAt).toLocaleString()) +
          (reviews.carrierSentTo ? " to " + self.esc(reviews.carrierSentTo) : "") +
          "</small>"
        : "") +
      "</div></label>" +
      "</div>" +
      '<p id="review-status" class="gos-muted"></p>' +
      '<div class="load-actions">' +
      '<button type="button" class="btn-primary" id="review-send">Send Review Email</button>' +
      "</div></div>";
    document.body.appendChild(modal);

    function closeModal() {
      modal.remove();
    }
    modal.addEventListener("click", function (ev) {
      if (ev.target === modal) closeModal();
    });
    modal.querySelector("#review-close")?.addEventListener("click", closeModal);
    modal.querySelector("#review-send")?.addEventListener("click", async function () {
      var sendBtn = modal.querySelector("#review-send");
      var statusEl = modal.querySelector("#review-status");
      var sendCustomer = modal.querySelector("#review-send-customer").checked;
      var sendCarrier = modal.querySelector("#review-send-carrier").checked;
      if (!sendCustomer && !sendCarrier) {
        alert("Choose Send Customer, Send Carrier, or both.");
        return;
      }
      try {
        if (sendBtn) sendBtn.disabled = true;
        if (statusEl)
          statusEl.textContent =
            "Sending from accounting@greengrouplogistics.com…";
        var result = await self.api(
          "/" + encodeURIComponent(id) + "/actions/send_review_link",
          {
            method: "POST",
            body: JSON.stringify({
              sendCustomer: sendCustomer,
              sendCarrier: sendCarrier,
              customerEmail: modal.querySelector("#review-customer-email").value,
              carrierEmail: modal.querySelector("#review-carrier-email").value,
            }),
          }
        );
        closeModal();
        var rows = (result && result.reviewSendResult) || [];
        var msg = rows.length
          ? "Review link sent:\n" +
            rows
              .map(function (r) {
                return (
                  "• " +
                  r.kind +
                  " → " +
                  r.to +
                  "\n   from " +
                  r.from
                );
              })
              .join("\n")
          : "Review link sent.";
        if (result && result.reviewSendWarning) {
          msg += "\n\n" + result.reviewSendWarning;
        }
        alert(msg);
        self.openLoad(body, id, self._tab);
      } catch (err) {
        if (statusEl) statusEl.textContent = err.message || "Failed to send";
        if (sendBtn) sendBtn.disabled = false;
      }
    });
  },
  showPodWizard(main, id, data, changeReason) {
    var self = this;
    var g = data.general || {};
    var c = data.carrier || {};
    var docs = data.documents || [];
    var role = self.role();
    var canManualApprove =
      role === "Team Lead" || role === "Manager" || role === "Accounting";
    var bolDoc = docs.find(function (d) {
      return String(d.docType || "").toUpperCase() === "BOL";
    });
    var box = main.querySelector("#load-doc-editor");
    if (!box) {
      main.insertAdjacentHTML("beforeend", '<div id="load-doc-editor" class="load-edit-panel"></div>');
      box = main.querySelector("#load-doc-editor");
    }
    box.classList.remove("hidden");

    function place(obj) {
      if (!obj) return "—";
      return [obj.city, obj.state, obj.zip].filter(Boolean).join(", ") || "—";
    }

    box.innerHTML =
      "<h3>Upload Proof of Delivery (POD)</h3>" +
      '<p class="gos-muted">Upload the <strong>same BOL</strong> after the receiver signs the <strong>SIGNATURE</strong> box (cargo received). Any mark/scribble in SIGNATURE = POD complete → next step unlocks. Team Lead is alerted only if there are exception notes beyond the signature. Load <strong>' +
      self.esc(g.loadNumber || "") +
      "</strong></p>" +
      '<div class="load-grid" style="margin:0.75rem 0">' +
      '<div class="load-field"><span>Load / BOL</span><strong>' +
      self.esc(g.loadNumber || "—") +
      "</strong></div>" +
      '<div class="load-field"><span>Carrier</span><strong>' +
      self.esc(c.carrierName || "—") +
      "</strong></div>" +
      '<div class="load-field"><span>Pickup</span><strong>' +
      self.esc(place(g.pickup)) +
      "</strong></div>" +
      '<div class="load-field"><span>Delivery</span><strong>' +
      self.esc(place(g.delivery)) +
      "</strong></div>" +
      "</div>" +
      (bolDoc && bolDoc.fileUrl
        ? '<p><button type="button" class="btn-secondary" id="pod-view-bol">View current BOL</button></p>'
        : '<p class="error">No BOL on this load yet — generate BOL first.</p>') +
      '<label class="full" style="display:flex;flex-direction:column;gap:0.35rem;margin-top:0.75rem">POD file (PDF or photo)' +
      '<input type="file" id="pod-file" accept=".pdf,image/*"></label>' +
      '<label style="display:flex;flex-direction:row;align-items:center;gap:0.5rem;margin-top:0.65rem">' +
      '<input type="checkbox" id="pod-confirm-sig"> I confirm there is a mark in the SIGNATURE box (receiver received cargo)' +
      "</label>" +
      (canManualApprove
        ? '<div style="margin-top:0.75rem;padding:0.75rem;border:1px solid var(--gos-border);border-radius:8px">' +
          '<label style="display:flex;flex-direction:row;align-items:center;gap:0.5rem">' +
          '<input type="checkbox" id="pod-manual-approve"> Manually approve this POD (' +
          self.esc(role) +
          ")</label>" +
          '<label style="display:flex;flex-direction:column;gap:0.3rem;margin-top:0.55rem">Approval reason' +
          '<input id="pod-manual-reason" placeholder="Why automated verification may be overridden"></label>' +
          '<p class="gos-muted" style="margin:0.4rem 0 0">Manual approval is recorded in the Load timeline and POD audit.</p>' +
          "</div>"
        : "") +
      '<div class="load-actions" style="margin-top:0.75rem">' +
      '<button type="button" class="btn-primary" id="pod-upload"' +
      (bolDoc ? "" : " disabled") +
      ">Upload &amp; Verify POD</button>" +
      '<button type="button" class="btn-secondary" id="pod-cancel">Cancel</button>' +
      "</div>" +
      '<p id="pod-status" class="gos-muted" style="margin-top:0.5rem"></p>';

    box.scrollIntoView({ behavior: "smooth", block: "start" });
    box.querySelector("#pod-cancel")?.addEventListener("click", function () {
      box.classList.add("hidden");
      box.innerHTML = "";
    });
    box.querySelector("#pod-view-bol")?.addEventListener("click", function () {
      if (!bolDoc || !bolDoc.fileUrl) return;
      self.openPdf(bolDoc.fileUrl, true).catch(function (err) {
        alert(err.message || "Failed to open BOL");
      });
    });

    box.querySelector("#pod-upload")?.addEventListener("click", async function () {
      var fileInput = box.querySelector("#pod-file");
      var file = fileInput && fileInput.files && fileInput.files[0];
      if (!file) {
        alert("Choose a POD file (signed BOL PDF or photo).");
        return;
      }
      var statusEl = box.querySelector("#pod-status");
      var btn = box.querySelector("#pod-upload");
      var confirmSig = Boolean(box.querySelector("#pod-confirm-sig")?.checked);
      var manualApprove = Boolean(box.querySelector("#pod-manual-approve")?.checked);
      var manualReason = String(box.querySelector("#pod-manual-reason")?.value || "").trim();
      if (manualApprove && !manualReason) {
        alert("Enter the reason for manual POD approval.");
        box.querySelector("#pod-manual-reason")?.focus();
        return;
      }
      try {
        if (btn) btn.disabled = true;
        if (statusEl) statusEl.textContent = "Uploading and verifying against BOL…";
        var token = localStorage.getItem("gl_token") || "";
        var fd = new FormData();
        fd.append("file", file);
        if (confirmSig) fd.append("confirmSignature", "1");
        if (manualApprove) {
          fd.append("manualApprove", "1");
          fd.append("manualApprovalReason", manualReason);
        }
        var res = await fetch(
          "/api/loads/" + encodeURIComponent(id) + "/documents/POD/upload",
          {
            method: "POST",
            headers: { Authorization: "Bearer " + token },
            body: fd,
          }
        );
        var payload = await res.json().catch(function () {
          return {};
        });
        if (!res.ok || payload.success === false) {
          var msg = payload.message || "POD upload failed";
          if (payload.code === "POD_NO_SIGNATURE") {
            msg +=
              "\n\nCheck “I confirm the receiver signature…” if the signature is clearly on the file, then retry.";
          }
          throw new Error(msg);
        }
        var a = (payload.data && payload.data.analysis) || {};
        var extra =
          payload.data && payload.data.teamLeadNotified
            ? " Team Lead was notified about exception notes."
            : "";
        if (statusEl) {
          statusEl.textContent =
            "POD accepted" + (a.hasExceptionNotes ? " (exceptions noted)." : ".") + extra;
          statusEl.className = a.hasExceptionNotes ? "error" : "gos-muted";
        }
        alert(
          (payload.data && payload.data.manuallyApproved
            ? "POD manually approved and saved."
            : "POD verified — receiver SIGNATURE accepted. Cargo marked received.") +
            (a.hasExceptionNotes ? "\nException notes found — Team Lead notified." : "") +
            "\nNext step unlocked: Create Invoice."
        );
        var host =
          document.querySelector("#load-tms-body") ||
          main.closest("[data-module]") ||
          main.parentElement;
        await self.openLoad(host, id, "documents");
      } catch (err) {
        if (statusEl) {
          statusEl.textContent = err.message || "Upload failed";
          statusEl.className = "error";
        } else {
          alert(err.message || err);
        }
        if (btn) btn.disabled = false;
      }
    });
  },

  /** Customer Invoice wizard — Green Logistics invoice template, autofill + editable. */
  showInvoiceWizard(main, id, data, changeReason) {
    var self = this;
    var g = data.general || {};
    var p = data.pricing || {};
    var contacts = data.contacts || {};
    var a = data.accounting || {};
    var box = main.querySelector("#load-doc-editor");
    if (!box) {
      main.insertAdjacentHTML("beforeend", '<div id="load-doc-editor" class="load-edit-panel"></div>');
      box = main.querySelector("#load-doc-editor");
    }
    box.classList.remove("hidden");

    function place(obj) {
      if (!obj) return "";
      return [obj.city, obj.state, obj.zip].filter(Boolean).join(", ");
    }

    var rate = p.customerRate != null && p.customerRate !== "" ? p.customerRate : "";
    var invNo =
      a.customerInvoice ||
      (g.loadNumber ? String(g.loadNumber).replace(/^GL/i, "") : "") ||
      "";
    var desc =
      "Freight transportation" +
      (place(g.pickup) && place(g.delivery) ? " · " + place(g.pickup) + " → " + place(g.delivery) : "") +
      (g.commodity ? " · " + g.commodity : "");
    var defaultTerms =
      "Payment is due per the terms stated on this invoice. Please reference Load # on all remittances. Questions: info@greengrouplogistics.com or greenlogisticsllc20@gmail.com.";
    var defaultPay =
      "BANK OF AMERICA\n121 FROG HOLLOW RD\nSOUTHAMPTON PA 18966\nGreen Logistics LLC";

    box.innerHTML =
      "<h3>Create Customer Invoice</h3>" +
      '<p class="gos-muted">Template matches Green Logistics invoice. Fields auto-fill from this Load — edit before generating PDF for the customer.</p>' +
      '<div class="load-form-grid">' +
      '<label>Invoice # <input id="inv-no" value="' + self.esc(invNo) + '"></label>' +
      '<label>Invoice date <input id="inv-date" value="' + self.esc(new Date().toLocaleDateString()) + '"></label>' +
      '<label>Load # <input id="inv-load" value="' + self.esc(g.loadNumber || "") + '" readonly></label>' +
      '<label>Shipment <input id="inv-ship" value="' + self.esc(g.shipmentNumber || "") + '" readonly></label>' +
      '<label>Bill To name <input id="inv-bill-name" value="' + self.esc(g.customer || "") + '"></label>' +
      '<label>Bill To Gmail <input id="inv-bill-email" type="email" value="' +
      self.esc(contacts.customerEmail || g.customerEmail || "") +
      '"></label>' +
      '<label>Bill To phone <input id="inv-bill-phone" type="tel" value="' +
      self.esc(self.formatUsPhone(contacts.customerPhone || g.customerPhone || "")) +
      '" placeholder="(XXX) XXX-XXXX"></label>' +
      '<label class="full">Bill To address <input id="inv-bill-addr" value="" placeholder="Street, city, state, ZIP"></label>' +
      '<label class="full">Description <textarea id="inv-desc" rows="2">' + self.esc(desc) + "</textarea></label>" +
      '<label>Hours <input id="inv-hours" type="number" step="0.01" value="1"></label>' +
      "<label>Rate / Hour" +
      self.moneyFieldHtml("inv-rate", rate, "0.00") +
      "</label>" +
      "<label>Line total" +
      self.moneyFieldHtml("inv-line", rate, "0.00") +
      "</label>" +
      "<label>Subtotal" +
      self.moneyFieldHtml("inv-sub", rate, "0.00") +
      "</label>" +
      '<label>Tax rate % <input id="inv-taxrate" type="number" step="0.01" value="0"></label>' +
      "<label>Tax" +
      self.moneyFieldHtml("inv-tax", "0", "0.00") +
      "</label>" +
      "<label>Customer price / Total Due *" +
      self.moneyFieldHtml("inv-due", rate, "0.00") +
      "</label>" +
      '<label>Payment terms <input id="inv-payterms" value="Net 30"></label>' +
      '<label class="full">Terms and Conditions <textarea id="inv-terms" rows="4">' +
      self.esc(defaultTerms) +
      "</textarea></label>" +
      '<label class="full">Send Payment To <textarea id="inv-payto" rows="4">' +
      self.esc(defaultPay) +
      "</textarea></label>" +
      "</div>" +
      '<div class="load-actions" style="margin-top:0.75rem">' +
      '<button type="button" class="btn-primary" id="inv-generate">Save &amp; Generate Invoice PDF</button>' +
      '<button type="button" class="btn-secondary" id="inv-cancel">Cancel</button>' +
      "</div>" +
      '<p id="inv-status" class="gos-muted" style="margin-top:0.5rem"></p>';

    box.scrollIntoView({ behavior: "smooth", block: "start" });
    self.bindUsPhoneInput(box.querySelector("#inv-bill-phone"));

    function recalc() {
      var h = parseFloat(box.querySelector("#inv-hours").value) || 0;
      var r = parseFloat(self.parseMoneyInput(box.querySelector("#inv-rate").value)) || 0;
      var line = Math.round(h * r * 100) / 100;
      box.querySelector("#inv-line").value = line;
      box.querySelector("#inv-sub").value = line;
      var tr = parseFloat(box.querySelector("#inv-taxrate").value) || 0;
      var tax = Math.round(((line * tr) / 100) * 100) / 100;
      box.querySelector("#inv-tax").value = tax;
      box.querySelector("#inv-due").value = Math.round((line + tax) * 100) / 100;
    }
    box.querySelector("#inv-hours")?.addEventListener("input", recalc);
    box.querySelector("#inv-rate")?.addEventListener("input", recalc);
    box.querySelector("#inv-taxrate")?.addEventListener("input", recalc);

    box.querySelector("#inv-cancel")?.addEventListener("click", function () {
      box.classList.add("hidden");
      box.innerHTML = "";
    });

    box.querySelector("#inv-generate")?.addEventListener("click", async function () {
      var due = self.parseMoneyInput(box.querySelector("#inv-due").value);
      if (!due) {
        alert("Total Amount Due is required.");
        return;
      }
      var statusEl = box.querySelector("#inv-status");
      var btnGen = box.querySelector("#inv-generate");
      try {
        if (btnGen) btnGen.disabled = true;
        if (statusEl) statusEl.textContent = "Saving invoice fields…";
        var billPhone = self.formatUsPhone(box.querySelector("#inv-bill-phone").value);
        await self.api("/" + encodeURIComponent(id), {
          method: "PATCH",
          body: JSON.stringify(
            Object.assign(
              {
                customerName: box.querySelector("#inv-bill-name").value || null,
                customerEmail: box.querySelector("#inv-bill-email").value || null,
                customerPhone: billPhone || null,
                invoiceNumber: box.querySelector("#inv-no").value || null,
                invoiceDate: box.querySelector("#inv-date").value || null,
              },
              self.canSeeMoney()
                ? {
                    customerRate:
                      due ||
                      self.parseMoneyInput(box.querySelector("#inv-line").value) ||
                      null,
                  }
                : {}
            )
          ),
        });
        if (statusEl) statusEl.textContent = "Generating Invoice PDF…";
        var content = {
          loadNumber: box.querySelector("#inv-load").value,
          shipmentNumber: box.querySelector("#inv-ship").value,
          invoiceNumber: box.querySelector("#inv-no").value,
          invoiceDate: box.querySelector("#inv-date").value,
          billToName: box.querySelector("#inv-bill-name").value,
          customerName: box.querySelector("#inv-bill-name").value,
          billToEmail: box.querySelector("#inv-bill-email").value,
          customerEmail: box.querySelector("#inv-bill-email").value,
          billToPhone: billPhone || box.querySelector("#inv-bill-phone").value,
          billToAddress: box.querySelector("#inv-bill-addr").value,
          invoiceDescription: box.querySelector("#inv-desc").value,
          invoiceHours: box.querySelector("#inv-hours").value,
          invoiceRatePerHour: self.parseMoneyInput(box.querySelector("#inv-rate").value),
          customerRate: due || self.parseMoneyInput(box.querySelector("#inv-line").value),
          invoiceLineTotal: self.parseMoneyInput(box.querySelector("#inv-line").value),
          invoiceSubtotal: self.parseMoneyInput(box.querySelector("#inv-sub").value),
          taxRate: box.querySelector("#inv-taxrate").value,
          taxAmount: self.parseMoneyInput(box.querySelector("#inv-tax").value),
          totalAmountDue: due,
          paymentTerms: box.querySelector("#inv-payterms").value,
          invoiceTerms: box.querySelector("#inv-terms").value,
          sendPaymentTo: box.querySelector("#inv-payto").value,
          pickupAddress: place(g.pickup),
          deliveryAddress: place(g.delivery),
          commodity: g.commodity,
          equipment: g.equipment,
        };
        var endpoint =
          (changeReason || "GENERATED") === "GENERATED"
            ? "/" + encodeURIComponent(id) + "/documents/CUSTOMER_INVOICE/generate"
            : "/" + encodeURIComponent(id) + "/documents/CUSTOMER_INVOICE/edit";
        var row = await self.api(endpoint, {
          method: "POST",
          body: JSON.stringify({ changeReason: changeReason || "GENERATED", content: content }),
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
        }
      } catch (err) {
        alert(err.message || err);
        if (btnGen) btnGen.disabled = false;
        if (statusEl) statusEl.textContent = "";
      }
    });
  },
};

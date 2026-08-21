/**
 * Carrier Onboarding — Green OS system of record for carrier packages.
 */
window.GreenOSModules = window.GreenOSModules || {};
window.GreenOSModules.carriers = {
  _carrierId: null,
  _tab: "overview",

  esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  },

  async api(path, opts) {
    var token = localStorage.getItem("gl_token") || "";
    var res = await fetch("/api/carriers" + path, Object.assign({
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

  /** Open or download a carrier-archived document (Agreement / RC / BOL / uploads). */
  async openCarrierDoc(carrierId, documentId, filename, inline) {
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

  render(root, subPageId) {
    if (!root) return;
    var self = this;
    if (window.GreenOS) {
      window.GreenOS.currentModule = "carriers";
      window.GreenOS.currentSub = subPageId || null;
    }
    try {
      var params = new URLSearchParams(window.location.search);
      if (params.get("carrierId")) self._carrierId = params.get("carrierId");
    } catch (e) {}

    root.innerHTML =
      '<div class="gos-module-placeholder" data-module="carriers">' +
      '<section class="gos-dash-hero">' +
      "<h1>Carriers</h1>" +
      "<p>Register carriers, send secure onboarding links, and review packages in Green OS — not Gmail.</p>" +
      "</section>" +
      '<div class="load-actions" style="margin-bottom:0.75rem">' +
      '<button type="button" class="btn-primary" id="cr-add">Add Carrier</button>' +
      '<button type="button" class="btn-secondary" id="cr-refresh">Refresh</button>' +
      "</div>" +
      '<div id="cr-dash" class="gos-muted" style="margin-bottom:0.75rem">Loading…</div>' +
      '<div id="cr-main"></div>' +
      "</div>";

    root.querySelector("#cr-add")?.addEventListener("click", function () {
      self._carrierId = null;
      self.showCreate(root.querySelector("#cr-main"));
    });
    root.querySelector("#cr-refresh")?.addEventListener("click", function () {
      self.paint(root);
    });
    if (subPageId === "add") {
      self.showCreate(root.querySelector("#cr-main"));
      self.api("/dashboard").then(function (d) {
        var dash = root.querySelector("#cr-dash");
        var c = d.counts || {};
        if (dash) {
          dash.innerHTML =
            "Invited " + (c.INVITED || 0) +
            " · Submitted " + (c.SUBMITTED || 0) +
            " · Total " + (d.total || 0);
        }
      }).catch(function () {});
      return;
    }
    this.paint(root);
  },

  async paint(root) {
    var self = this;
    var dash = root.querySelector("#cr-dash");
    var main = root.querySelector("#cr-main");
    try {
      var d = await self.api("/dashboard");
      var c = d.counts || {};
      dash.innerHTML =
        "Invited " + (c.INVITED || 0) +
        " · Opened " + (c.OPENED || 0) +
        " · In progress " + (c.IN_PROGRESS || 0) +
        " · Submitted " + (c.SUBMITTED || 0) +
        " · Approved " + (c.APPROVED || 0) +
        " · Total " + (d.total || 0);
    } catch (e) {
      if (dash) dash.textContent = e.message;
    }
    if (self._carrierId) {
      await self.showDetail(main, self._carrierId);
    } else {
      await self.showList(main);
    }
  },

  async showList(main) {
    var self = this;
    main.innerHTML = '<p class="gos-muted">Loading carriers…</p>';
    try {
      var rows = await self.api("/");
      if (!rows.length) {
        main.innerHTML =
          '<p class="gos-muted">No carriers yet. Click <strong>Add Carrier</strong> to create one and send a secure onboarding link.</p>';
        return;
      }
      main.innerHTML =
        '<div class="table-wrap"><table class="crm-table"><thead><tr>' +
        "<th>Carrier</th><th>MC</th><th>DOT</th><th>Email</th><th>Status</th><th>Broker</th><th></th>" +
        '</tr></thead><tbody>' +
        rows.map(function (r) {
          var broker = r.assignedBroker
            ? self.esc(r.assignedBroker.firstName + " " + r.assignedBroker.lastName)
            : "—";
          return (
            "<tr>" +
            "<td><strong>" + self.esc(r.legalName) + "</strong></td>" +
            "<td>" + self.esc(r.mcNumber) + "</td>" +
            "<td>" + self.esc(r.dotNumber) + "</td>" +
            "<td>" + self.esc(r.email) + "</td>" +
            "<td>" + self.esc(r.onboardingStatus) + "</td>" +
            "<td>" + broker + "</td>" +
            '<td><button type="button" class="btn-secondary" data-open="' +
            self.esc(r.carrierId) +
            '">Open</button></td>' +
            "</tr>"
          );
        }).join("") +
        "</tbody></table></div>";
      main.querySelectorAll("[data-open]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          self._carrierId = btn.getAttribute("data-open");
          self._tab = "overview";
          self.showDetail(main, self._carrierId);
        });
      });
    } catch (e) {
      main.innerHTML = '<p class="error">' + self.esc(e.message) + "</p>";
    }
  },

  showCreate(main) {
    var self = this;
    var user = window.GreenOSUser || {};
    main.innerHTML =
      '<div class="load-edit-panel"><h3>Add Carrier &amp; Send Onboarding Link</h3>' +
      '<p class="gos-muted">Green OS emails a secure link. The carrier does not need a Green OS account.</p>' +
      '<div class="load-form-grid">' +
      '<label>Company Legal Name * <input id="cr-legal" required></label>' +
      '<label>DBA <input id="cr-dba"></label>' +
      '<label>Carrier Contact Name <input id="cr-contact"></label>' +
      '<label>Carrier Email * <input id="cr-email" type="email" required></label>' +
      '<label>Phone <input id="cr-phone"></label>' +
      '<label>MC Number <input id="cr-mc"></label>' +
      '<label>DOT Number <input id="cr-dot"></label>' +
      '<label>Address <input id="cr-address"></label>' +
      '<label>ZIP <input id="cr-zip"></label>' +
      '<label>City <input id="cr-city"></label>' +
      '<label>State <input id="cr-state" maxlength="2"></label>' +
      '<label>Link Shipment for RC (optional) <input id="cr-ship" placeholder="shipmentLeadId UUID"></label>' +
      '<label class="full">Assigned Broker <input id="cr-broker" value="' +
      self.esc(user.firstName ? user.firstName + " " + user.lastName + " (you)" : "Current user") +
      '" disabled></label>' +
      "</div>" +
      '<div class="load-actions">' +
      '<button type="button" class="btn-primary" id="cr-create">Create Carrier &amp; Send Onboarding Link</button>' +
      '<button type="button" class="btn-secondary" id="cr-cancel">Cancel</button>' +
      "</div>" +
      '<p id="cr-msg" class="gos-muted"></p></div>';

    if (window.GreenOSZipLookup) {
      window.GreenOSZipLookup.bind(main, "#cr-zip", "#cr-city", "#cr-state");
    }

    main.querySelector("#cr-cancel")?.addEventListener("click", function () {
      self.showList(main);
    });
    main.querySelector("#cr-create")?.addEventListener("click", async function () {
      var msg = main.querySelector("#cr-msg");
      try {
        if (msg) msg.textContent = "Creating & sending invite…";
        var data = await self.api("/", {
          method: "POST",
          body: JSON.stringify({
            legalName: main.querySelector("#cr-legal").value,
            dbaName: main.querySelector("#cr-dba").value,
            contactName: main.querySelector("#cr-contact").value,
            email: main.querySelector("#cr-email").value,
            phone: main.querySelector("#cr-phone").value,
            mcNumber: main.querySelector("#cr-mc").value,
            dotNumber: main.querySelector("#cr-dot").value,
            address: main.querySelector("#cr-address").value,
            city: main.querySelector("#cr-city").value,
            state: main.querySelector("#cr-state").value,
            zip: main.querySelector("#cr-zip").value,
            shipmentLeadId: main.querySelector("#cr-ship").value || null,
          }),
        });
        self._carrierId = data.carrier.carrierId;
        alert(
          (data.inviteSent ? "Invite sent. " : "Carrier created. ") +
            (data.warning || "Open the carrier record to review status.")
        );
        self.showDetail(main, self._carrierId);
      } catch (e) {
        if (msg) msg.textContent = e.message;
      }
    });
  },

  async showDetail(main, id) {
    var self = this;
    main.innerHTML = '<p class="gos-muted">Loading carrier…</p>';
    try {
      var data = await self.api("/" + encodeURIComponent(id));
      var c = data;
      var broker = c.assignedBroker
        ? self.esc(c.assignedBroker.firstName + " " + c.assignedBroker.lastName)
        : "—";
      var tabs = [
        { id: "overview", label: "Overview" },
        { id: "documents", label: "Documents" },
        { id: "agreement", label: "Agreement" },
        { id: "rc", label: "RC/BOL" },
        { id: "onboarding", label: "Onboarding" },
        { id: "timeline", label: "Timeline" },
      ];
      main.innerHTML =
        '<div class="load-actions" style="margin-bottom:0.5rem">' +
        '<button type="button" class="btn-secondary" id="cr-back">← Carriers</button>' +
        '<button type="button" class="btn-secondary" id="cr-resend">Resend Invitation</button>' +
        '<button type="button" class="btn-secondary" id="cr-changes">Request Changes</button>' +
        '<button type="button" class="btn-primary" id="cr-approve">Approve</button>' +
        "</div>" +
        "<h2>" + self.esc(c.legalName) + "</h2>" +
        '<p class="gos-muted">Onboarding: <strong>' + self.esc(c.onboardingStatus) +
        "</strong> · Broker: " + broker + "</p>" +
        '<nav class="gos-subnav" style="margin:0.75rem 0">' +
        tabs.map(function (t) {
          return (
            '<button type="button" class="gos-subnav-item' +
            (self._tab === t.id ? " is-active" : "") +
            '" data-tab="' + t.id + '">' + t.label + "</button>"
          );
        }).join("") +
        "</nav>" +
        '<div id="cr-tab"></div>';

      main.querySelector("#cr-back")?.addEventListener("click", function () {
        self._carrierId = null;
        self.showList(main);
      });
      main.querySelectorAll("[data-tab]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          self._tab = btn.getAttribute("data-tab");
          self.showDetail(main, id);
        });
      });
      main.querySelector("#cr-resend")?.addEventListener("click", async function () {
        try {
          var r = await self.api("/" + encodeURIComponent(id) + "/onboarding/resend", { method: "POST", body: "{}" });
          alert(r.warning || "Invitation resent.");
          self.showDetail(main, id);
        } catch (e) {
          alert(e.message);
        }
      });
      main.querySelector("#cr-changes")?.addEventListener("click", async function () {
        var reason = prompt("What should the carrier correct?");
        if (!reason) return;
        try {
          await self.api("/" + encodeURIComponent(id) + "/onboarding/request-changes", {
            method: "POST",
            body: JSON.stringify({ reason: reason }),
          });
          alert("Change request sent.");
          self.showDetail(main, id);
        } catch (e) {
          alert(e.message);
        }
      });
      main.querySelector("#cr-approve")?.addEventListener("click", async function () {
        try {
          await self.api("/" + encodeURIComponent(id) + "/onboarding/approve", { method: "POST", body: "{}" });
          self.showDetail(main, id);
        } catch (e) {
          alert(e.message);
        }
      });

      var tab = main.querySelector("#cr-tab");
      if (self._tab === "documents") self.renderDocs(tab, c);
      else if (self._tab === "agreement") self.renderAgreement(tab, c);
      else if (self._tab === "rc") self.renderRc(tab, c);
      else if (self._tab === "onboarding") self.renderOnboarding(tab, c);
      else if (self._tab === "timeline") self.renderTimeline(tab, c);
      else self.renderOverview(tab, c);
    } catch (e) {
      main.innerHTML = '<p class="error">' + self.esc(e.message) + "</p>";
    }
  },

  field(label, value) {
    return (
      '<div class="load-field"><span>' +
      this.esc(label) +
      "</span><strong>" +
      this.esc(value == null || value === "" ? "—" : value) +
      "</strong></div>"
    );
  },

  renderOverview(el, c) {
    el.innerHTML =
      '<div class="load-grid">' +
      this.field("Legal Name", c.legalName) +
      this.field("DBA", c.dbaName) +
      this.field("Contact", c.contactName) +
      this.field("Email", c.email) +
      this.field("Phone", c.phone) +
      this.field("MC", c.mcNumber) +
      this.field("DOT", c.dotNumber) +
      this.field("Address", [c.address, c.city, c.state, c.zip].filter(Boolean).join(", ")) +
      this.field("Status", c.status) +
      this.field("Onboarding", c.onboardingStatus) +
      "</div>";
  },

  renderDocs(el, c) {
    var self = this;
    var docs = c.documents || [];
    if (!docs.length) {
      el.innerHTML = '<p class="gos-muted">No documents uploaded yet.</p>';
      return;
    }
    el.innerHTML =
      '<div class="table-wrap"><table class="crm-table"><thead><tr>' +
      "<th>Type</th><th>File</th><th>Version</th><th>Status</th><th>AI</th><th>Uploaded</th><th></th>" +
      "</tr></thead><tbody>" +
      docs.map(function (d) {
        return (
          "<tr data-doc-id=\"" + self.esc(d.documentId) + "\">" +
          "<td>" + self.esc(d.documentType) + "</td>" +
          "<td>" + self.esc(d.originalFilename) + "</td>" +
          "<td>" + d.version + "</td>" +
          "<td>" + self.esc(d.status) + "</td>" +
          '<td class="cr-doc-ai" data-id="' + self.esc(d.documentId) + '"><span class="gos-muted">—</span></td>' +
          "<td>" + self.esc(d.uploadedAt ? new Date(d.uploadedAt).toLocaleString() : "") + "</td>" +
          '<td style="white-space:nowrap">' +
          '<button type="button" class="btn-secondary cr-doc-view" data-id="' +
          self.esc(d.documentId) +
          '" data-name="' +
          self.esc(d.originalFilename) +
          '">View</button> ' +
          '<button type="button" class="btn-secondary cr-doc-dl" data-id="' +
          self.esc(d.documentId) +
          '" data-name="' +
          self.esc(d.originalFilename) +
          '">Download</button> ' +
          '<button type="button" class="btn-secondary cr-doc-ai-run" data-id="' +
          self.esc(d.documentId) +
          '">Validate AI</button>' +
          "</td>" +
          "</tr>"
        );
      }).join("") +
      "</tbody></table></div>" +
      '<p class="gos-muted" style="margin-top:8px">Document AI: GREEN / REVIEW / RED — never auto-changes carrier master data.</p>';
    el.querySelectorAll(".cr-doc-view").forEach(function (btn) {
      btn.addEventListener("click", async function () {
        try {
          await self.openCarrierDoc(
            c.carrierId,
            btn.getAttribute("data-id"),
            btn.getAttribute("data-name"),
            true
          );
        } catch (e) {
          alert(e.message);
        }
      });
    });
    el.querySelectorAll(".cr-doc-dl").forEach(function (btn) {
      btn.addEventListener("click", async function () {
        try {
          await self.openCarrierDoc(
            c.carrierId,
            btn.getAttribute("data-id"),
            btn.getAttribute("data-name"),
            false
          );
        } catch (e) {
          alert(e.message);
        }
      });
    });
    el.querySelectorAll(".cr-doc-ai-run").forEach(function (btn) {
      btn.addEventListener("click", async function () {
        var docId = btn.getAttribute("data-id");
        var cell = el.querySelector('.cr-doc-ai[data-id="' + docId + '"]');
        if (cell) cell.innerHTML = '<span class="gos-muted">Queued…</span>';
        try {
          var token = localStorage.getItem("gl_token") || "";
          var res = await fetch("/api/ai/documents/process", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: token ? "Bearer " + token : "",
            },
            body: JSON.stringify({ documentSource: "CARRIER", documentId: docId }),
          });
          var json = await res.json();
          if (!json.success) throw new Error(json.message || "Queue failed");
          var jobId = json.data && json.data.jobId;
          await self.pollDocAiJob(jobId, cell);
        } catch (e) {
          if (cell) cell.innerHTML = '<span style="color:#b42318">Error</span>';
          alert(e.message || "Document AI failed");
        }
      });
    });
    docs.forEach(function (d) {
      self.loadDocAiStatus(d.documentId, el.querySelector('.cr-doc-ai[data-id="' + d.documentId + '"]'));
    });
  },

  async loadDocAiStatus(documentId, cell) {
    if (!cell) return;
    try {
      var token = localStorage.getItem("gl_token") || "";
      var res = await fetch("/api/ai/documents/" + encodeURIComponent(documentId) + "/validation", {
        headers: { Authorization: token ? "Bearer " + token : "" },
        cache: "no-store",
      });
      var json = await res.json();
      if (!json.success || !json.data || !json.data.validation) return;
      cell.innerHTML = this.formatDocAiBadge(json.data);
    } catch (_e) {
      /* ignore */
    }
  },

  async pollDocAiJob(jobId, cell) {
    var self = this;
    var token = localStorage.getItem("gl_token") || "";
    for (var i = 0; i < 40; i++) {
      await new Promise(function (r) { setTimeout(r, 1000); });
      var res = await fetch("/api/ai/documents/jobs/" + encodeURIComponent(jobId), {
        headers: { Authorization: token ? "Bearer " + token : "" },
        cache: "no-store",
      });
      var json = await res.json();
      if (!json.success) throw new Error(json.message || "Job failed");
      var st = json.data && json.data.status;
      if (st === "SUCCEEDED" || st === "CACHED" || st === "FAILED") {
        if (cell) cell.innerHTML = self.formatDocAiBadge(json.data);
        if (st === "FAILED") throw new Error((json.data && json.data.errorMessage) || "Processing failed");
        return;
      }
      if (cell) cell.innerHTML = '<span class="gos-muted">' + self.esc(st || "…") + "</span>";
    }
    if (cell) cell.innerHTML = '<span class="gos-muted">Still running…</span>';
  },

  formatDocAiBadge(payload) {
    var v = payload && payload.validation;
    if (!v) return '<span class="gos-muted">—</span>';
    var light = String(v.trafficLight || "").toUpperCase();
    var color = light === "GREEN" ? "#067647" : light === "YELLOW" ? "#b54708" : "#b42318";
    var label = light === "GREEN" ? "GREEN" : light === "YELLOW" ? "REVIEW" : "RED";
    var status = v.overallStatus || "";
    var sig = "";
    var signs = payload.extraction && payload.extraction.signatures;
    if (Array.isArray(signs) && signs[0] && signs[0].status) {
      sig = " · sig:" + signs[0].status;
    }
    var tip = [status, payload.classifiedDocType || "", sig].filter(Boolean).join(" ");
    return (
      '<span title="' +
      this.esc(tip) +
      '" style="font-weight:600;color:' +
      color +
      '">' +
      this.esc(label) +
      "</span>" +
      '<span class="gos-muted"> ' +
      this.esc(status) +
      "</span>"
    );
  },

  renderAgreement(el, c) {
    var self = this;
    var signs = c.agreementSigns || [];
    var pdfDocs = (c.documents || []).filter(function (d) {
      return d.documentType === "BROKER_CARRIER_AGREEMENT";
    });
    var currentPdf = pdfDocs.find(function (d) { return d.status === "CURRENT"; }) || pdfDocs[0];

    if (!signs.length && !currentPdf) {
      el.innerHTML = '<p class="gos-muted">Agreement not signed yet.</p>';
      return;
    }

    var pdfBlock =
      '<div class="load-edit-panel" style="margin-bottom:0.75rem">' +
      "<h3 style=\"margin:0 0 0.35rem\">Signed Agreement PDF</h3>" +
      (currentPdf
        ? '<p class="gos-muted">v' +
          currentPdf.version +
          " · " +
          self.esc(currentPdf.originalFilename) +
          " · " +
          self.esc(currentPdf.uploadedAt ? new Date(currentPdf.uploadedAt).toLocaleString() : "") +
          "</p>" +
          '<div style="display:flex;flex-wrap:wrap;gap:0.45rem">' +
          '<button type="button" class="btn-secondary" id="cr-view-agreement">View</button>' +
          '<button type="button" class="btn-primary" id="cr-dl-agreement">Download PDF</button>' +
          "</div>"
        : '<p class="gos-muted">PDF not generated yet for this signature.</p>' +
          '<button type="button" class="btn-secondary" id="cr-gen-agreement">Generate PDF</button>') +
      '<p id="cr-agreement-msg" class="gos-muted" style="margin-top:0.5rem"></p>' +
      "</div>";

    el.innerHTML =
      pdfBlock +
      (signs.length
        ? signs.map(function (s) {
            return (
              '<div class="load-edit-panel">' +
              "<p><strong>" +
              self.esc(s.signerName) +
              "</strong> · " +
              self.esc(s.signedAt ? new Date(s.signedAt).toLocaleString() : "") +
              "</p>" +
              '<p class="gos-muted">Template ' +
              self.esc(s.template && s.template.version) +
              " · IP " +
              self.esc(s.ipAddress) +
              "</p>" +
              (s.signatureData && String(s.signatureData).indexOf("data:image") === 0
                ? '<img alt="Signature" src="' +
                  s.signatureData +
                  '" style="max-width:320px;background:#fff;border:1px solid var(--gos-border);border-radius:8px">'
                : "") +
              "</div>"
            );
          }).join("")
        : "");

    async function openDoc(inline) {
      await self.openCarrierDoc(
        c.carrierId,
        currentPdf.documentId,
        (currentPdf && currentPdf.originalFilename) || "Broker-Carrier-Agreement.pdf",
        inline
      );
    }

    el.querySelector("#cr-view-agreement")?.addEventListener("click", async function () {
      var msg = el.querySelector("#cr-agreement-msg");
      try {
        if (msg) msg.textContent = "Opening…";
        await openDoc(true);
        if (msg) msg.textContent = "";
      } catch (e) {
        if (msg) msg.textContent = e.message || "Failed to open";
      }
    });

    el.querySelector("#cr-dl-agreement")?.addEventListener("click", async function () {
      var msg = el.querySelector("#cr-agreement-msg");
      try {
        if (msg) msg.textContent = "Downloading…";
        await openDoc(false);
        if (msg) msg.textContent = "";
      } catch (e) {
        if (msg) msg.textContent = e.message || "Download failed";
      }
    });

    el.querySelector("#cr-gen-agreement")?.addEventListener("click", async function () {
      var msg = el.querySelector("#cr-agreement-msg");
      try {
        if (msg) msg.textContent = "Generating PDF…";
        await self.api("/" + encodeURIComponent(c.carrierId) + "/agreement/regenerate-pdf", {
          method: "POST",
          body: "{}",
        });
        self.showDetail(document.getElementById("cr-main") || el.parentElement, c.carrierId);
      } catch (e) {
        if (msg) msg.textContent = e.message || "Generate failed";
      }
    });
  },

  renderRc(el, c) {
    var self = this;
    var rows = c.rcSignatures || [];
    var docs = c.documents || [];
    function currentDoc(type) {
      return (
        docs.find(function (d) {
          return d.documentType === type && d.status === "CURRENT";
        }) ||
        docs.find(function (d) {
          return d.documentType === type;
        }) ||
        null
      );
    }
    var rcPdf = currentDoc("RATE_CONFIRMATION");
    var bolPdf = currentDoc("BOL");

    if (!rows.length && !rcPdf && !bolPdf) {
      el.innerHTML =
        '<p class="gos-muted">No RC/BOL signature on file. Send the RC/BOL link from the Load after Rate Confirmation and BOL are saved.</p>';
      return;
    }

    function pdfPanel(title, doc, viewId, dlId) {
      return (
        '<div class="load-edit-panel" style="margin-bottom:0.75rem">' +
        "<h3 style=\"margin:0 0 0.35rem\">" +
        self.esc(title) +
        "</h3>" +
        (doc
          ? '<p class="gos-muted">v' +
            doc.version +
            " · " +
            self.esc(doc.originalFilename) +
            " · " +
            self.esc(doc.uploadedAt ? new Date(doc.uploadedAt).toLocaleString() : "") +
            "</p>" +
            '<div style="display:flex;flex-wrap:wrap;gap:0.45rem">' +
            '<button type="button" class="btn-secondary" id="' +
            viewId +
            '">View</button>' +
            '<button type="button" class="btn-primary" id="' +
            dlId +
            '">Download PDF</button>' +
            "</div>"
          : '<p class="gos-muted">PDF not archived on this carrier yet.</p>') +
        "</div>"
      );
    }

    var needsGenerate = rows.length && (!rcPdf || !bolPdf);
    el.innerHTML =
      pdfPanel("Rate Confirmation PDF", rcPdf, "cr-view-rc", "cr-dl-rc") +
      pdfPanel("Bill of Lading PDF", bolPdf, "cr-view-bol", "cr-dl-bol") +
      (needsGenerate
        ? '<div class="load-edit-panel" style="margin-bottom:0.75rem">' +
          '<p class="gos-muted">Copy the current Load RC/BOL PDFs into this carrier record.</p>' +
          '<button type="button" class="btn-secondary" id="cr-gen-rcbol">Generate / Archive PDFs</button>' +
          '<p id="cr-rcbol-msg" class="gos-muted" style="margin-top:0.5rem"></p>' +
          "</div>"
        : '<p id="cr-rcbol-msg" class="gos-muted"></p>') +
      (rows.length
        ? rows
            .map(function (r) {
              return (
                '<div class="load-edit-panel">' +
                "<p><strong>" +
                self.esc(r.signerName) +
                "</strong> · " +
                self.esc(r.signedAt ? new Date(r.signedAt).toLocaleString() : "") +
                "</p>" +
                '<p class="gos-muted">IP ' +
                self.esc(r.ipAddress || "—") +
                (r.shipmentLeadId ? " · Load linked" : "") +
                "</p>" +
                (r.signatureData && String(r.signatureData).indexOf("data:image") === 0
                  ? '<img alt="Signature" src="' +
                    r.signatureData +
                    '" style="max-width:320px;background:#fff;border:1px solid var(--gos-border);border-radius:8px">'
                  : "") +
                "</div>"
              );
            })
            .join("")
        : "");

    async function openDoc(doc, inline) {
      await self.openCarrierDoc(
        c.carrierId,
        doc.documentId,
        doc.originalFilename || "document.pdf",
        inline
      );
    }

    el.querySelector("#cr-view-rc")?.addEventListener("click", async function () {
      var msg = el.querySelector("#cr-rcbol-msg");
      try {
        if (msg) msg.textContent = "Opening…";
        await openDoc(rcPdf, true);
        if (msg) msg.textContent = "";
      } catch (e) {
        if (msg) msg.textContent = e.message || "Failed to open";
      }
    });
    el.querySelector("#cr-dl-rc")?.addEventListener("click", async function () {
      var msg = el.querySelector("#cr-rcbol-msg");
      try {
        if (msg) msg.textContent = "Downloading…";
        await openDoc(rcPdf, false);
        if (msg) msg.textContent = "";
      } catch (e) {
        if (msg) msg.textContent = e.message || "Download failed";
      }
    });
    el.querySelector("#cr-view-bol")?.addEventListener("click", async function () {
      var msg = el.querySelector("#cr-rcbol-msg");
      try {
        if (msg) msg.textContent = "Opening…";
        await openDoc(bolPdf, true);
        if (msg) msg.textContent = "";
      } catch (e) {
        if (msg) msg.textContent = e.message || "Failed to open";
      }
    });
    el.querySelector("#cr-dl-bol")?.addEventListener("click", async function () {
      var msg = el.querySelector("#cr-rcbol-msg");
      try {
        if (msg) msg.textContent = "Downloading…";
        await openDoc(bolPdf, false);
        if (msg) msg.textContent = "";
      } catch (e) {
        if (msg) msg.textContent = e.message || "Download failed";
      }
    });
    el.querySelector("#cr-gen-rcbol")?.addEventListener("click", async function () {
      var msg = el.querySelector("#cr-rcbol-msg");
      try {
        if (msg) msg.textContent = "Archiving PDFs from Load…";
        await self.api("/" + encodeURIComponent(c.carrierId) + "/rc-bol/regenerate-pdf", {
          method: "POST",
          body: "{}",
        });
        self._tab = "rc";
        self.showDetail(document.getElementById("cr-main") || el.parentElement, c.carrierId);
      } catch (e) {
        if (msg) msg.textContent = e.message || "Generate failed";
      }
    });
  },

  renderOnboarding(el, c) {
    var sessions = c.sessions || [];
    el.innerHTML =
      '<div class="load-grid">' +
      this.field("Current status", c.onboardingStatus) +
      "</div>" +
      "<h3>Sessions</h3>" +
      (sessions.length
        ? '<ul>' +
          sessions.map(function (s) {
            return (
              "<li>" +
              this.esc(s.status) +
              " · expires " +
              this.esc(s.expiresAt ? new Date(s.expiresAt).toLocaleString() : "") +
              (s.submittedAt ? " · submitted " + new Date(s.submittedAt).toLocaleString() : "") +
              "</li>"
            );
          }, this).join("") +
          "</ul>"
        : '<p class="gos-muted">No sessions.</p>');
  },

  renderTimeline(el, c) {
    var events = c.events || [];
    if (!events.length) {
      el.innerHTML = '<p class="gos-muted">No timeline events yet.</p>';
      return;
    }
    el.innerHTML =
      '<ul style="list-style:none;padding:0;margin:0">' +
      events.map(function (e) {
        return (
          '<li style="padding:0.55rem 0;border-bottom:1px solid var(--gos-border)">' +
          "<strong>" + this.esc(e.title) + "</strong>" +
          '<div class="gos-muted" style="font-size:0.82rem">' +
          this.esc(e.createdAt ? new Date(e.createdAt).toLocaleString() : "") +
          " · " + this.esc(e.actorType) +
          (e.message ? " — " + this.esc(e.message) : "") +
          "</div></li>"
        );
      }, this).join("") +
      "</ul>";
  },
};

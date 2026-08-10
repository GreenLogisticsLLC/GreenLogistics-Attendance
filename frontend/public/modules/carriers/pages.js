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
      '<label>City <input id="cr-city"></label>' +
      '<label>State <input id="cr-state" maxlength="2"></label>' +
      '<label>ZIP <input id="cr-zip"></label>' +
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
      var tabs = ["overview", "documents", "agreement", "rc", "onboarding", "timeline"];
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
            (self._tab === t ? " is-active" : "") +
            '" data-tab="' + t + '">' + t + "</button>"
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
      "<th>Type</th><th>File</th><th>Version</th><th>Status</th><th>Uploaded</th><th></th>" +
      "</tr></thead><tbody>" +
      docs.map(function (d) {
        return (
          "<tr>" +
          "<td>" + self.esc(d.documentType) + "</td>" +
          "<td>" + self.esc(d.originalFilename) + "</td>" +
          "<td>" + d.version + "</td>" +
          "<td>" + self.esc(d.status) + "</td>" +
          "<td>" + self.esc(d.uploadedAt ? new Date(d.uploadedAt).toLocaleString() : "") + "</td>" +
          '<td><a class="btn-secondary" href="/api/carriers/' +
          encodeURIComponent(c.carrierId) +
          "/documents/" +
          encodeURIComponent(d.documentId) +
          '/download" target="_blank" rel="noopener">Download</a></td>' +
          "</tr>"
        );
      }).join("") +
      "</tbody></table></div>";
    // Attach auth via fetch download buttons instead of naked links
    el.querySelectorAll("a.btn-secondary").forEach(function (a) {
      a.addEventListener("click", async function (ev) {
        ev.preventDefault();
        try {
          var token = localStorage.getItem("gl_token") || "";
          var res = await fetch(a.getAttribute("href"), {
            headers: { Authorization: "Bearer " + token },
          });
          if (!res.ok) throw new Error("Download failed");
          var blob = await res.blob();
          var url = URL.createObjectURL(blob);
          var link = document.createElement("a");
          link.href = url;
          link.download = a.closest("tr")?.children[1]?.textContent || "document";
          link.click();
          URL.revokeObjectURL(url);
        } catch (e) {
          alert(e.message);
        }
      });
    });
  },

  renderAgreement(el, c) {
    var signs = c.agreementSigns || [];
    if (!signs.length) {
      el.innerHTML = '<p class="gos-muted">Agreement not signed yet.</p>';
      return;
    }
    el.innerHTML = signs.map(function (s) {
      return (
        '<div class="load-edit-panel">' +
        "<p><strong>" + this.esc(s.signerName) + "</strong> · " +
        this.esc(s.signedAt ? new Date(s.signedAt).toLocaleString() : "") +
        "</p>" +
        "<p class=\"gos-muted\">Template " + this.esc(s.template && s.template.version) +
        " · IP " + this.esc(s.ipAddress) + "</p>" +
        (s.signatureData && String(s.signatureData).indexOf("data:image") === 0
          ? '<img alt="Signature" src="' + s.signatureData + '" style="max-width:320px;background:#fff;border:1px solid var(--gos-border);border-radius:8px">'
          : "") +
        "</div>"
      );
    }, this).join("");
  },

  renderRc(el, c) {
    var rows = c.rcSignatures || [];
    if (!rows.length) {
      el.innerHTML = '<p class="gos-muted">No RC signature on file. Link a shipment when inviting to pre-fill RC.</p>';
      return;
    }
    el.innerHTML = rows.map(function (r) {
      var content = {};
      try { content = JSON.parse(r.contentJson || "{}"); } catch (e) {}
      return (
        '<div class="load-edit-panel"><pre style="white-space:pre-wrap;font:inherit">' +
        this.esc(JSON.stringify(content, null, 2)) +
        "</pre><p class=\"gos-muted\">Signed by " +
        this.esc(r.signerName) + " · " +
        this.esc(r.signedAt ? new Date(r.signedAt).toLocaleString() : "") +
        "</p></div>"
      );
    }, this).join("");
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

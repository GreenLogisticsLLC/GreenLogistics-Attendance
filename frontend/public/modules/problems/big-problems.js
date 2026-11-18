/**
 * Problems → Big Problems — case / task / financial management UI.
 * Loaded after problems/pages.js; attached as GreenOSModules.problems.bigProblems.
 */
(function () {
  window.GreenOSModules = window.GreenOSModules || {};
  var problems = window.GreenOSModules.problems;
  if (!problems) return;

  var BP = {
    _section: "overview",
    _caseId: null,
    _caseTab: "overview",
    _meta: null,
    _page: 1,

    async api(path, options) {
      var token = localStorage.getItem("gl_token");
      var opts = options || {};
      var headers = opts.headers || {};
      if (!headers.Authorization) {
        headers.Authorization = token ? "Bearer " + token : "";
      }
      if (!(opts.body instanceof FormData) && !headers["Content-Type"] && opts.method && opts.method !== "GET") {
        headers["Content-Type"] = "application/json";
      }
      var res = await fetch("/api/big-problems" + path, {
        method: opts.method || "GET",
        headers: headers,
        body: opts.body,
      });
      if (opts.raw) return res;
      return res.json();
    },

    esc: function (s) {
      return problems.esc(s);
    },

    fmtDate: function (v) {
      return problems.fmtDate(v);
    },

    fmtMoney: function (n) {
      var v = Number(n);
      if (!Number.isFinite(v)) return "—";
      return "$" + v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    },

    role: function () {
      try {
        var u = (window.GreenOS && window.GreenOS.user) || {};
        return u.role || "";
      } catch (_) {
        return "";
      }
    },

    isOps: function () {
      var r = this.role();
      return r === "Owner" || r === "Administrator" || r === "Manager" || r === "Team Lead";
    },

    canDelete: function () {
      var r = this.role();
      return r === "Owner" || r === "Administrator";
    },

    canFin: function () {
      var r = this.role();
      return this.isOps() || r === "Accounting";
    },

    sections: function () {
      var base = [
        { id: "overview", title: "Overview" },
        { id: "all-cases", title: "All Cases" },
        { id: "my-tasks", title: "My Tasks" },
        { id: "deadlines", title: "Deadlines" },
        { id: "closed", title: "Closed Cases" },
      ];
      if (this.canFin()) {
        base.splice(4, 0, { id: "financial", title: "Financial Exposure" });
      }
      return base;
    },

    async ensureMeta() {
      if (this._meta) return this._meta;
      var res = await this.api("/meta");
      if (res.success) this._meta = res.data;
      return this._meta || { categories: [], users: [], severities: [], caseStatuses: [] };
    },

    render(body, sectionId, caseId) {
      if (!body) return;
      this._section = sectionId || this._section || "overview";
      this._caseId = caseId || null;
      var self = this;
      var sections = this.sections();
      if (!sections.find(function (s) { return s.id === self._section; })) {
        this._section = sections[0].id;
      }

      var nav = sections
        .map(function (s) {
          return (
            '<button type="button" class="gos-subnav-item' +
            (self._section === s.id && !self._caseId ? " is-active" : "") +
            '" data-bp-section="' +
            s.id +
            '">' +
            s.title +
            "</button>"
          );
        })
        .join("");

      body.innerHTML =
        '<div class="bp-root">' +
        '<nav class="gos-subnav" style="margin-bottom:1rem" aria-label="Big Problems sections">' +
        nav +
        "</nav>" +
        '<div id="bp-body"><p class="gos-muted">Loading…</p></div>' +
        "</div>";

      body.querySelectorAll("[data-bp-section]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          self._caseId = null;
          self.render(body, btn.getAttribute("data-bp-section"));
        });
      });

      var target = body.querySelector("#bp-body");
      if (this._caseId) this.paintCaseDetail(target, this._caseId);
      else if (this._section === "overview") this.paintOverview(target);
      else if (this._section === "all-cases") this.paintCases(target, { closed: "0" });
      else if (this._section === "closed") this.paintCases(target, { closed: "1" });
      else if (this._section === "my-tasks") this.paintMyTasks(target);
      else if (this._section === "deadlines") this.paintDeadlines(target);
      else if (this._section === "financial") this.paintFinancial(target);
    },

    metricCard: function (label, value, accent) {
      return (
        '<div style="min-width:140px;flex:1;padding:0.85rem 1rem;border:1px solid rgba(255,255,255,0.08);border-radius:10px;background:rgba(255,255,255,0.03)">' +
        '<div class="gos-muted" style="font-size:0.8rem">' +
        this.esc(label) +
        "</div>" +
        '<div style="font-size:1.45rem;font-weight:650;margin-top:0.2rem;color:' +
        (accent || "inherit") +
        '">' +
        value +
        "</div></div>"
      );
    },

    async paintOverview(el) {
      var self = this;
      try {
        var res = await this.api("/overview");
        if (!res.success) {
          el.innerHTML = '<p class="gos-muted">' + this.esc(res.message) + "</p>";
          return;
        }
        var d = res.data || {};
        var attention =
          (d.casesRequiringAttention || [])
            .map(function (c) {
              return (
                "<tr>" +
                '<td><button type="button" class="gos-linkish" data-open-case="' +
                self.esc(c.caseId) +
                '">' +
                self.esc(c.caseNumber) +
                "</button></td>" +
                "<td>" +
                self.esc(c.title) +
                "</td>" +
                "<td>" +
                self.esc(c.severity) +
                "</td>" +
                "<td>" +
                self.esc(c.status) +
                "</td>" +
                "<td>" +
                self.esc(c.reason) +
                "</td></tr>"
              );
            })
            .join("") ||
          '<tr><td colspan="5" class="gos-muted">No cases requiring attention</td></tr>';

        el.innerHTML =
          '<section class="gos-dash-hero" style="margin-bottom:1rem;display:flex;justify-content:space-between;gap:1rem;flex-wrap:wrap;align-items:flex-end">' +
          "<div><h1>Big Problems</h1>" +
          '<p class="gos-muted">High-impact case management — claims, tasks, deadlines, exposure.</p></div>' +
          (d.canCreate
            ? '<button type="button" class="gos-btn gos-btn-primary" id="bp-create">Create Big Problem</button>'
            : "") +
          "</section>" +
          '<div style="display:flex;flex-wrap:wrap;gap:0.75rem;margin-bottom:1.25rem">' +
          this.metricCard("Total Cases", d.totalCases) +
          this.metricCard("Open Cases", d.openCases) +
          this.metricCard("Critical", d.criticalCases, "#f87171") +
          this.metricCard("Outstanding Tasks", d.outstandingTasks) +
          this.metricCard("Overdue Tasks", d.overdueTasks, d.overdueTasks ? "#fbbf24" : undefined) +
          (d.canViewFinancials
            ? this.metricCard("Financial Exposure", this.fmtMoney(d.totalFinancialExposure), "#34d399")
            : "") +
          "</div>" +
          "<section><h2>Cases Requiring Attention</h2>" +
          '<div style="overflow:auto;margin-top:0.5rem"><table class="gos-table" style="width:100%;min-width:640px">' +
          "<thead><tr><th>Case ID</th><th>Title</th><th>Severity</th><th>Status</th><th>Why</th></tr></thead>" +
          "<tbody>" +
          attention +
          "</tbody></table></div></section>";

        this.bindCaseLinks(el);
        var createBtn = el.querySelector("#bp-create");
        if (createBtn) {
          createBtn.addEventListener("click", function () {
            self.openCreateModal(el);
          });
        }
      } catch (err) {
        el.innerHTML = '<p class="gos-muted">Failed: ' + this.esc(err.message || err) + "</p>";
      }
    },

    bindCaseLinks: function (root) {
      var self = this;
      var body = root.closest(".gos-module-body") || root.parentElement;
      root.querySelectorAll("[data-open-case]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          var id = btn.getAttribute("data-open-case");
          self._caseId = id;
          self.render(body.closest("#problems-body") || body, self._section, id);
        });
      });
    },

    async paintCases(el, opts) {
      var self = this;
      opts = opts || {};
      try {
        await this.ensureMeta();
        var q = el._bpQ || "";
        var status = el._bpStatus || "";
        var severity = el._bpSeverity || "";
        var category = el._bpCategory || "";
        var page = el._bpPage || 1;
        var qs =
          "?page=" +
          page +
          "&pageSize=25&closed=" +
          (opts.closed || "0") +
          (q ? "&q=" + encodeURIComponent(q) : "") +
          (status ? "&status=" + encodeURIComponent(status) : "") +
          (severity ? "&severity=" + encodeURIComponent(severity) : "") +
          (category ? "&category=" + encodeURIComponent(category) : "") +
          "&sort=updatedAt&sortDir=desc";
        var res = await this.api("/cases" + qs);
        if (!res.success) {
          el.innerHTML = '<p class="gos-muted">' + this.esc(res.message) + "</p>";
          return;
        }
        var data = res.data || {};
        var showFin = data.canViewFinancials;
        var canDelete = !!(data.canDelete || self.canDelete());
        var colSpan = 11 + (showFin ? 1 : 0) + (canDelete ? 1 : 0);
        var rows =
          (data.items || [])
            .map(function (c) {
              return (
                "<tr>" +
                '<td><button type="button" class="gos-linkish" data-open-case="' +
                self.esc(c.caseId) +
                '">' +
                self.esc(c.caseNumber) +
                "</button></td>" +
                "<td>" +
                self.esc(c.title) +
                "</td>" +
                "<td>" +
                self.esc(c.categoryLabel || c.category) +
                "</td>" +
                "<td>" +
                self.esc(c.severity) +
                "</td>" +
                "<td>" +
                self.esc(c.status) +
                "</td>" +
                "<td>" +
                self.esc(c.shipmentId || "—") +
                "</td>" +
                "<td>" +
                self.esc(c.customerName || "—") +
                "</td>" +
                "<td>" +
                self.esc(c.carrierName || "—") +
                "</td>" +
                "<td>" +
                self.esc(c.responsibleManagerName || "—") +
                "</td>" +
                (showFin ? "<td>" + self.fmtMoney(c.financialExposure) + "</td>" : "") +
                "<td>" +
                self.fmtDate(c.nextDeadlineAt) +
                "</td>" +
                (canDelete
                  ? '<td><button type="button" class="gos-btn" style="color:#f87171;border-color:rgba(248,113,113,0.35)" data-delete-case="' +
                    self.esc(c.caseId) +
                    '" data-delete-label="' +
                    self.esc(c.caseNumber) +
                    '">Delete</button></td>'
                  : "") +
                "</tr>"
              );
            })
            .join("") ||
          '<tr><td colspan="' + colSpan + '" class="gos-muted">No cases</td></tr>';

        var catOpts = (this._meta.categories || [])
          .map(function (c) {
            return (
              '<option value="' +
              self.esc(c.id) +
              '"' +
              (category === c.id ? " selected" : "") +
              ">" +
              self.esc(c.label) +
              "</option>"
            );
          })
          .join("");

        el.innerHTML =
          '<section class="gos-dash-hero" style="margin-bottom:1rem;display:flex;justify-content:space-between;gap:1rem;flex-wrap:wrap;align-items:flex-end">' +
          "<div><h1>" +
          (opts.closed === "1" ? "Closed Cases" : "All Cases") +
          "</h1>" +
          '<p class="gos-muted">Search, filter, and open case details.</p></div>' +
          (data.canCreate && opts.closed !== "1"
            ? '<button type="button" class="gos-btn gos-btn-primary" id="bp-create">Create Big Problem</button>'
            : "") +
          "</section>" +
          '<div style="display:flex;flex-wrap:wrap;gap:0.5rem;margin-bottom:0.75rem;align-items:center">' +
          '<input id="bp-q" class="gos-input" placeholder="Search case ID, title, customer…" value="' +
          this.esc(q) +
          '" style="min-width:220px;flex:1" />' +
          '<select id="bp-severity" class="gos-input"><option value="">Severity</option>' +
          ["LOW", "MEDIUM", "HIGH", "CRITICAL"]
            .map(function (s) {
              return (
                '<option value="' +
                s +
                '"' +
                (severity === s ? " selected" : "") +
                ">" +
                s +
                "</option>"
              );
            })
            .join("") +
          "</select>" +
          '<select id="bp-category" class="gos-input"><option value="">Category</option>' +
          catOpts +
          "</select>" +
          (opts.closed === "1"
            ? ""
            : '<select id="bp-status" class="gos-input"><option value="">Status</option>' +
              ["OPEN", "IN_PROGRESS", "PENDING_REVIEW", "RESOLVED", "REOPENED"]
                .map(function (s) {
                  return (
                    '<option value="' +
                    s +
                    '"' +
                    (status === s ? " selected" : "") +
                    ">" +
                    s +
                    "</option>"
                  );
                })
                .join("") +
              "</select>") +
          '<button type="button" class="gos-btn" id="bp-filter">Apply</button>' +
          "</div>" +
          '<div style="overflow:auto"><table class="gos-table" style="width:100%;min-width:980px">' +
          "<thead><tr>" +
          "<th>Case ID</th><th>Title</th><th>Category</th><th>Severity</th><th>Status</th>" +
          "<th>Shipment ID</th><th>Customer</th><th>Carrier</th><th>Manager</th>" +
          (showFin ? "<th>Exposure</th>" : "") +
          "<th>Next Deadline</th>" +
          (canDelete ? "<th></th>" : "") +
          "</tr></thead><tbody>" +
          rows +
          "</tbody></table></div>" +
          '<div style="display:flex;gap:0.75rem;align-items:center;margin-top:0.75rem">' +
          '<button type="button" class="gos-btn" id="bp-prev"' +
          (page <= 1 ? " disabled" : "") +
          ">Prev</button>" +
          '<span class="gos-muted">Page ' +
          page +
          " / " +
          (data.totalPages || 1) +
          " · " +
          (data.total || 0) +
          " cases</span>" +
          '<button type="button" class="gos-btn" id="bp-next"' +
          (page >= (data.totalPages || 1) ? " disabled" : "") +
          ">Next</button></div>";

        this.bindCaseLinks(el);
        el.querySelectorAll("[data-delete-case]").forEach(function (btn) {
          btn.addEventListener("click", async function (e) {
            e.preventDefault();
            e.stopPropagation();
            var id = btn.getAttribute("data-delete-case");
            var label = btn.getAttribute("data-delete-label") || id;
            if (!id) return;
            if (!confirm("Delete " + label + " permanently? This cannot be undone.")) return;
            var r = await self.api("/cases/" + encodeURIComponent(id), { method: "DELETE" });
            if (!r.success) {
              alert(r.message || "Delete failed");
              return;
            }
            self.paintCases(el, opts);
          });
        });
        var apply = function () {
          el._bpQ = (el.querySelector("#bp-q") || {}).value || "";
          el._bpSeverity = (el.querySelector("#bp-severity") || {}).value || "";
          el._bpCategory = (el.querySelector("#bp-category") || {}).value || "";
          el._bpStatus = (el.querySelector("#bp-status") || {}).value || "";
          el._bpPage = 1;
          self.paintCases(el, opts);
        };
        var filterBtn = el.querySelector("#bp-filter");
        if (filterBtn) filterBtn.addEventListener("click", apply);
        var qInput = el.querySelector("#bp-q");
        if (qInput) {
          qInput.addEventListener("keydown", function (e) {
            if (e.key === "Enter") apply();
          });
        }
        var prev = el.querySelector("#bp-prev");
        var next = el.querySelector("#bp-next");
        if (prev) {
          prev.addEventListener("click", function () {
            el._bpPage = Math.max(1, page - 1);
            self.paintCases(el, opts);
          });
        }
        if (next) {
          next.addEventListener("click", function () {
            el._bpPage = page + 1;
            self.paintCases(el, opts);
          });
        }
        var createBtn = el.querySelector("#bp-create");
        if (createBtn) {
          createBtn.addEventListener("click", function () {
            self.openCreateModal(el);
          });
        }
      } catch (err) {
        el.innerHTML = '<p class="gos-muted">Failed: ' + this.esc(err.message || err) + "</p>";
      }
    },

    async paintMyTasks(el) {
      var self = this;
      try {
        var res = await this.api("/my-tasks");
        if (!res.success) {
          el.innerHTML = '<p class="gos-muted">' + this.esc(res.message) + "</p>";
          return;
        }
        var rows =
          (res.data.items || [])
            .map(function (t) {
              return (
                "<tr" +
                (t.isOverdue ? ' style="background:rgba(248,113,113,0.08)"' : "") +
                ">" +
                '<td><button type="button" class="gos-linkish" data-open-case="' +
                self.esc(t.case.caseId) +
                '">' +
                self.esc(t.case.caseNumber) +
                "</button></td>" +
                "<td>" +
                self.esc(t.title) +
                "</td>" +
                "<td>" +
                self.esc(t.priority) +
                "</td>" +
                "<td>" +
                self.esc(t.status) +
                "</td>" +
                "<td>" +
                self.fmtDate(t.deadlineAt) +
                "</td>" +
                "<td>" +
                (t.isOverdue ? "Overdue" : "—") +
                "</td></tr>"
              );
            })
            .join("") ||
          '<tr><td colspan="6" class="gos-muted">No open tasks assigned to you</td></tr>';
        el.innerHTML =
          '<section class="gos-dash-hero" style="margin-bottom:1rem"><h1>My Tasks</h1>' +
          '<p class="gos-muted">Tasks assigned to you across Big Problem cases.</p></section>' +
          '<div style="overflow:auto"><table class="gos-table" style="width:100%;min-width:720px">' +
          "<thead><tr><th>Case</th><th>Task</th><th>Priority</th><th>Status</th><th>Deadline</th><th>Flag</th></tr></thead>" +
          "<tbody>" +
          rows +
          "</tbody></table></div>";
        this.bindCaseLinks(el);
      } catch (err) {
        el.innerHTML = '<p class="gos-muted">Failed: ' + this.esc(err.message || err) + "</p>";
      }
    },

    async paintDeadlines(el) {
      var self = this;
      try {
        var res = await this.api("/deadlines");
        if (!res.success) {
          el.innerHTML = '<p class="gos-muted">' + this.esc(res.message) + "</p>";
          return;
        }
        var rows =
          (res.data.items || [])
            .map(function (t) {
              return (
                "<tr" +
                (t.isOverdue ? ' style="background:rgba(251,191,36,0.08)"' : "") +
                ">" +
                '<td><button type="button" class="gos-linkish" data-open-case="' +
                self.esc(t.caseId) +
                '">' +
                self.esc(t.caseNumber) +
                "</button></td>" +
                "<td>" +
                self.esc(t.title) +
                "</td>" +
                "<td>" +
                self.esc(t.assigneeName || "—") +
                "</td>" +
                "<td>" +
                self.esc(t.priority) +
                "</td>" +
                "<td>" +
                self.fmtDate(t.deadlineAt) +
                "</td>" +
                "<td>" +
                (t.isOverdue ? "OVERDUE" : "Upcoming") +
                "</td></tr>"
              );
            })
            .join("") ||
          '<tr><td colspan="6" class="gos-muted">No upcoming deadlines</td></tr>';
        el.innerHTML =
          '<section class="gos-dash-hero" style="margin-bottom:1rem"><h1>Deadlines</h1>' +
          '<p class="gos-muted">Open tasks ordered by deadline.</p></section>' +
          '<div style="overflow:auto"><table class="gos-table" style="width:100%;min-width:720px">' +
          "<thead><tr><th>Case</th><th>Task</th><th>Assignee</th><th>Priority</th><th>Deadline</th><th>State</th></tr></thead>" +
          "<tbody>" +
          rows +
          "</tbody></table></div>";
        this.bindCaseLinks(el);
      } catch (err) {
        el.innerHTML = '<p class="gos-muted">Failed: ' + this.esc(err.message || err) + "</p>";
      }
    },

    async paintFinancial(el) {
      var self = this;
      try {
        var res = await this.api("/financial-exposure");
        if (!res.success) {
          el.innerHTML = '<p class="gos-muted">' + this.esc(res.message) + "</p>";
          return;
        }
        var d = res.data || {};
        var rows =
          (d.items || [])
            .map(function (c) {
              return (
                "<tr>" +
                '<td><button type="button" class="gos-linkish" data-open-case="' +
                self.esc(c.caseId) +
                '">' +
                self.esc(c.caseNumber) +
                "</button></td>" +
                "<td>" +
                self.esc(c.title) +
                "</td>" +
                "<td>" +
                self.esc(c.customerName || "—") +
                "</td>" +
                "<td>" +
                self.fmtMoney(c.potentialExposure) +
                "</td>" +
                "<td>" +
                self.fmtMoney(c.amountRecovered) +
                "</td>" +
                "<td>" +
                self.fmtMoney(c.outstandingExposure) +
                "</td>" +
                "<td>" +
                self.esc(c.insuranceStatus) +
                "</td></tr>"
              );
            })
            .join("") ||
          '<tr><td colspan="7" class="gos-muted">No outstanding exposure</td></tr>';
        el.innerHTML =
          '<section class="gos-dash-hero" style="margin-bottom:1rem"><h1>Financial Exposure</h1>' +
          '<p class="gos-muted">Outstanding exposure across open cases. Pending insurance is never counted as recovered.</p>' +
          '<div style="font-size:1.6rem;font-weight:650;margin-top:0.5rem">' +
          this.fmtMoney(d.totalOutstanding) +
          "</div></section>" +
          '<div style="overflow:auto"><table class="gos-table" style="width:100%;min-width:800px">' +
          "<thead><tr><th>Case</th><th>Title</th><th>Customer</th><th>Potential</th><th>Recovered</th><th>Outstanding</th><th>Insurance</th></tr></thead>" +
          "<tbody>" +
          rows +
          "</tbody></table></div>";
        this.bindCaseLinks(el);
      } catch (err) {
        el.innerHTML = '<p class="gos-muted">Failed: ' + this.esc(err.message || err) + "</p>";
      }
    },

    async openCreateModal(hostEl) {
      var self = this;
      var meta = await this.ensureMeta();
      var overlay = document.createElement("div");
      overlay.style.cssText =
        "position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:9999;display:flex;align-items:center;justify-content:center;padding:1rem";
      var users = (meta.users || [])
        .map(function (u) {
          return (
            '<option value="' +
            self.esc(u.userId) +
            '">' +
            self.esc(u.name + " (" + u.role + ")") +
            "</option>"
          );
        })
        .join("");
      var cats = (meta.categories || [])
        .map(function (c) {
          return '<option value="' + self.esc(c.id) + '">' + self.esc(c.label) + "</option>";
        })
        .join("");
      overlay.innerHTML =
        '<div style="background:#111827;border:1px solid rgba(255,255,255,0.1);border-radius:12px;max-width:640px;width:100%;padding:1.25rem;max-height:90vh;overflow:auto">' +
        "<h2 style=\"margin:0 0 1rem\">Create Big Problem</h2>" +
        '<label class="gos-muted">Title</label><input id="bp-f-title" class="gos-input" style="width:100%;margin-bottom:0.6rem" />' +
        '<label class="gos-muted">Category</label><select id="bp-f-cat" class="gos-input" style="width:100%;margin-bottom:0.6rem">' +
        cats +
        "</select>" +
        '<label class="gos-muted">Severity</label><select id="bp-f-sev" class="gos-input" style="width:100%;margin-bottom:0.6rem">' +
        ["MEDIUM", "LOW", "HIGH", "CRITICAL"]
          .map(function (s) {
            return '<option value="' + s + '">' + s + "</option>";
          })
          .join("") +
        "</select>" +
        '<label class="gos-muted">Responsible Manager</label><select id="bp-f-mgr" class="gos-input" style="width:100%;margin-bottom:0.6rem"><option value="">—</option>' +
        users +
        "</select>" +
        '<label class="gos-muted">Broker</label><select id="bp-f-broker" class="gos-input" style="width:100%;margin-bottom:0.6rem"><option value="">—</option>' +
        users +
        "</select>" +
        '<label class="gos-muted">Carrier name (optional)</label><input id="bp-f-carrier" class="gos-input" style="width:100%;margin-bottom:0.6rem" />' +
        '<label class="gos-muted">Shipment ID / ref (optional)</label><input id="bp-f-ship" class="gos-input" style="width:100%;margin-bottom:0.6rem" />' +
        '<label class="gos-muted">Incident date</label><input id="bp-f-inc" type="date" class="gos-input" style="width:100%;margin-bottom:0.6rem" />' +
        '<label class="gos-muted">Description</label><textarea id="bp-f-desc" class="gos-input" rows="4" style="width:100%;margin-bottom:0.85rem"></textarea>' +
        '<div style="display:flex;gap:0.5rem;justify-content:flex-end">' +
        '<button type="button" class="gos-btn" id="bp-f-cancel">Cancel</button>' +
        '<button type="button" class="gos-btn gos-btn-primary" id="bp-f-save">Create</button></div></div>';
      document.body.appendChild(overlay);
      overlay.querySelector("#bp-f-cancel").addEventListener("click", function () {
        overlay.remove();
      });
      overlay.querySelector("#bp-f-save").addEventListener("click", async function () {
        var payload = {
          title: overlay.querySelector("#bp-f-title").value,
          category: overlay.querySelector("#bp-f-cat").value,
          severity: overlay.querySelector("#bp-f-sev").value,
          responsibleManagerId: overlay.querySelector("#bp-f-mgr").value || null,
          brokerUserId: overlay.querySelector("#bp-f-broker").value || null,
          carrierName: overlay.querySelector("#bp-f-carrier").value || null,
          shipmentRef: overlay.querySelector("#bp-f-ship").value || null,
          incidentDate: overlay.querySelector("#bp-f-inc").value || null,
          description: overlay.querySelector("#bp-f-desc").value || null,
        };
        var res = await self.api("/cases", { method: "POST", body: JSON.stringify(payload) });
        if (!res.success) {
          alert(res.message || "Create failed");
          return;
        }
        overlay.remove();
        var body = hostEl.closest("#problems-body") || hostEl;
        self._caseId = res.data.caseId;
        self.render(body, "all-cases", res.data.caseId);
      });
    },

    async paintCaseDetail(el, caseId) {
      var self = this;
      try {
        await this.ensureMeta();
        var res = await this.api("/cases/" + encodeURIComponent(caseId));
        if (!res.success) {
          el.innerHTML = '<p class="gos-muted">' + this.esc(res.message) + "</p>";
          return;
        }
        var c = res.data;
        this._caseTab = this._caseTab || "overview";
        var tabs = ["overview", "tasks", "timeline", "documents", "communication"];
        if (c.permissions && c.permissions.canViewFinancials) tabs.push("financials");
        var tabNav = tabs
          .map(function (t) {
            return (
              '<button type="button" class="gos-subnav-item' +
              (self._caseTab === t ? " is-active" : "") +
              '" data-case-tab="' +
              t +
              '">' +
              t.charAt(0).toUpperCase() +
              t.slice(1) +
              "</button>"
            );
          })
          .join("");

        el.innerHTML =
          '<div style="margin-bottom:0.75rem"><button type="button" class="gos-btn" id="bp-back">← Back</button></div>' +
          '<section class="gos-dash-hero" style="margin-bottom:1rem">' +
          "<h1>" +
          this.esc(c.caseNumber) +
          " — " +
          this.esc(c.title) +
          "</h1>" +
          '<p class="gos-muted">' +
          this.esc(c.categoryLabel || c.category) +
          " · " +
          this.esc(c.severity) +
          " · " +
          this.esc(c.status) +
          (c.permissions && c.permissions.canViewFinancials
            ? " · Exposure " + this.fmtMoney(c.outstandingExposure)
            : "") +
          "</p>" +
          '<div style="display:flex;gap:0.5rem;flex-wrap:wrap;margin-top:0.75rem">' +
          (c.permissions && c.permissions.canClose && c.status !== "CLOSED"
            ? '<button type="button" class="gos-btn" id="bp-close">Close case</button>'
            : "") +
          (c.permissions && c.permissions.canClose && c.status === "CLOSED"
            ? '<button type="button" class="gos-btn" id="bp-reopen">Reopen</button>'
            : "") +
          (c.permissions && c.permissions.canDelete
            ? '<button type="button" class="gos-btn" id="bp-delete" style="color:#f87171;border-color:rgba(248,113,113,0.35)">Delete</button>'
            : "") +
          "</div></section>" +
          '<nav class="gos-subnav" style="margin-bottom:1rem">' +
          tabNav +
          "</nav>" +
          '<div id="bp-case-tab"></div>';

        el.querySelector("#bp-back").addEventListener("click", function () {
          self._caseId = null;
          var body = el.closest("#problems-body");
          self.render(body, self._section || "all-cases");
        });
        el.querySelectorAll("[data-case-tab]").forEach(function (btn) {
          btn.addEventListener("click", function () {
            self._caseTab = btn.getAttribute("data-case-tab");
            self.paintCaseDetail(el, caseId);
          });
        });
        var closeBtn = el.querySelector("#bp-close");
        if (closeBtn) {
          closeBtn.addEventListener("click", async function () {
            var summary = prompt("Resolution summary (optional)") || "";
            var r = await self.api("/cases/" + encodeURIComponent(caseId) + "/close", {
              method: "POST",
              body: JSON.stringify({ resolutionSummary: summary }),
            });
            if (!r.success) alert(r.message);
            else self.paintCaseDetail(el, caseId);
          });
        }
        var deleteBtn = el.querySelector("#bp-delete");
        if (deleteBtn) {
          deleteBtn.addEventListener("click", async function () {
            if (
              !confirm(
                "Delete " + (c.caseNumber || "this case") + " permanently? This cannot be undone."
              )
            ) {
              return;
            }
            var r = await self.api("/cases/" + encodeURIComponent(caseId), { method: "DELETE" });
            if (!r.success) {
              alert(r.message || "Delete failed");
              return;
            }
            self._caseId = null;
            var body = el.closest("#problems-body");
            self.render(body, "all-cases");
          });
        }
        var reopenBtn = el.querySelector("#bp-reopen");
        if (reopenBtn) {
          reopenBtn.addEventListener("click", async function () {
            var r = await self.api("/cases/" + encodeURIComponent(caseId) + "/reopen", {
              method: "POST",
              body: "{}",
            });
            if (!r.success) alert(r.message);
            else self.paintCaseDetail(el, caseId);
          });
        }

        var tabEl = el.querySelector("#bp-case-tab");
        if (this._caseTab === "tasks") this.paintCaseTasks(tabEl, c);
        else if (this._caseTab === "timeline") this.paintCaseTimeline(tabEl, c);
        else if (this._caseTab === "documents") this.paintCaseDocuments(tabEl, c);
        else if (this._caseTab === "communication") this.paintCaseComms(tabEl, c);
        else if (this._caseTab === "financials") this.paintCaseFinancials(tabEl, c);
        else this.paintCaseOverview(tabEl, c);
      } catch (err) {
        el.innerHTML = '<p class="gos-muted">Failed: ' + this.esc(err.message || err) + "</p>";
      }
    },

    paintCaseOverview: function (el, c) {
      var self = this;
      el.innerHTML =
        '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:0.75rem">' +
        this.kv("Customer", c.customerName || "—") +
        this.kv("Carrier", c.carrierName || "—") +
        this.kv("Broker", c.brokerName || "—") +
        this.kv("Manager", c.responsibleManagerName || "—") +
        this.kv("Shipment", c.shipmentId || "—") +
        this.kv("Incident", this.fmtDate(c.incidentDate)) +
        this.kv("Next deadline", this.fmtDate(c.nextDeadlineAt)) +
        this.kv("Open tasks", String(c.openTaskCount || 0)) +
        "</div>" +
        '<div style="margin-top:1rem"><h3>Description</h3><p style="white-space:pre-wrap">' +
        this.esc(c.description || "—") +
        "</p></div>" +
        (c.permissions && c.permissions.canEdit
          ? '<div style="margin-top:1rem"><button type="button" class="gos-btn" id="bp-edit-case">Edit case</button></div>'
          : "");
      var edit = el.querySelector("#bp-edit-case");
      if (edit) {
        edit.addEventListener("click", async function () {
          var title = prompt("Title", c.title);
          if (title == null) return;
          var severity = prompt("Severity (LOW/MEDIUM/HIGH/CRITICAL)", c.severity);
          if (severity == null) return;
          var status = prompt(
            "Status (OPEN/IN_PROGRESS/PENDING_REVIEW/RESOLVED/REOPENED)",
            c.status === "CLOSED" ? "REOPENED" : c.status
          );
          if (status == null) return;
          var r = await self.api("/cases/" + encodeURIComponent(c.caseId), {
            method: "PATCH",
            body: JSON.stringify({ title: title, severity: severity, status: status }),
          });
          if (!r.success) alert(r.message);
          else {
            var body = el.closest("#problems-body");
            self.paintCaseDetail(body.querySelector("#bp-body") || el.parentElement, c.caseId);
          }
        });
      }
    },

    kv: function (label, value) {
      return (
        '<div style="padding:0.75rem;border:1px solid rgba(255,255,255,0.08);border-radius:8px">' +
        '<div class="gos-muted" style="font-size:0.78rem">' +
        this.esc(label) +
        '</div><div style="margin-top:0.25rem">' +
        this.esc(value) +
        "</div></div>"
      );
    },

    paintCaseTasks: function (el, c) {
      var self = this;
      var rows =
        (c.tasks || [])
          .map(function (t) {
            return (
              "<tr" +
              (t.isOverdue ? ' style="background:rgba(248,113,113,0.08)"' : "") +
              ">" +
              "<td>" +
              self.esc(t.title) +
              "</td>" +
              "<td>" +
              self.esc(t.assigneeName || "—") +
              "</td>" +
              "<td>" +
              self.esc(t.priority) +
              "</td>" +
              "<td>" +
              self.esc(t.status) +
              "</td>" +
              "<td>" +
              self.fmtDate(t.deadlineAt) +
              "</td>" +
              "<td>" +
              (t.status !== "COMPLETED" && t.status !== "CANCELLED"
                ? '<button type="button" class="gos-btn" data-complete-task="' +
                  self.esc(t.taskId) +
                  '">Complete</button> '
                : "") +
              '<button type="button" class="gos-btn" data-comment-task="' +
              self.esc(t.taskId) +
              '">Comment</button></td></tr>'
            );
          })
          .join("") ||
        '<tr><td colspan="6" class="gos-muted">No tasks yet</td></tr>';

      el.innerHTML =
        (c.permissions && c.permissions.canAssignTasks
          ? '<div style="margin-bottom:0.75rem"><button type="button" class="gos-btn gos-btn-primary" id="bp-add-task">Add task</button></div>'
          : "") +
        '<div style="overflow:auto"><table class="gos-table" style="width:100%;min-width:720px">' +
        "<thead><tr><th>Task</th><th>Assignee</th><th>Priority</th><th>Status</th><th>Deadline</th><th></th></tr></thead>" +
        "<tbody>" +
        rows +
        "</tbody></table></div>";

      var add = el.querySelector("#bp-add-task");
      if (add) {
        add.addEventListener("click", async function () {
          var title = prompt("Task title");
          if (!title) return;
          var meta = await self.ensureMeta();
          var userList = (meta.users || [])
            .map(function (u, i) {
              return i + 1 + ". " + u.name + " (" + u.role + ")";
            })
            .join("\n");
          var pick = prompt("Assignee number (optional):\n" + userList);
          var assigneeUserId = null;
          if (pick) {
            var idx = Number(pick) - 1;
            if (meta.users[idx]) assigneeUserId = meta.users[idx].userId;
          }
          var deadline = prompt("Deadline (YYYY-MM-DDTHH:mm, optional)") || null;
          var priority = prompt("Priority (LOW/MEDIUM/HIGH/URGENT)", "MEDIUM") || "MEDIUM";
          var r = await self.api("/cases/" + encodeURIComponent(c.caseId) + "/tasks", {
            method: "POST",
            body: JSON.stringify({
              title: title,
              assigneeUserId: assigneeUserId,
              deadlineAt: deadline,
              priority: priority,
            }),
          });
          if (!r.success) alert(r.message);
          else {
            var body = el.closest("#bp-body");
            self.paintCaseDetail(body, c.caseId);
          }
        });
      }
      el.querySelectorAll("[data-complete-task]").forEach(function (btn) {
        btn.addEventListener("click", async function () {
          var r = await self.api("/tasks/" + encodeURIComponent(btn.getAttribute("data-complete-task")), {
            method: "PATCH",
            body: JSON.stringify({ status: "COMPLETED" }),
          });
          if (!r.success) alert(r.message);
          else self.paintCaseDetail(el.closest("#bp-body"), c.caseId);
        });
      });
      el.querySelectorAll("[data-comment-task]").forEach(function (btn) {
        btn.addEventListener("click", async function () {
          var text = prompt("Comment");
          if (!text) return;
          var r = await self.api(
            "/tasks/" + encodeURIComponent(btn.getAttribute("data-comment-task")) + "/comments",
            { method: "POST", body: JSON.stringify({ body: text }) }
          );
          if (!r.success) alert(r.message);
          else alert("Comment added");
        });
      });
    },

    paintCaseTimeline: function (el, c) {
      var self = this;
      var items =
        (c.timeline || [])
          .map(function (e) {
            return (
              '<li style="margin-bottom:0.75rem;padding-bottom:0.75rem;border-bottom:1px solid rgba(255,255,255,0.06)">' +
              '<div style="font-weight:600">' +
              self.esc(e.summary) +
              '</div><div class="gos-muted" style="font-size:0.8rem">' +
              self.esc(e.eventType) +
              " · " +
              self.esc(e.actorName || "System") +
              " · " +
              self.fmtDate(e.createdAt) +
              "</div></li>"
            );
          })
          .join("") || '<li class="gos-muted">No timeline events</li>';
      el.innerHTML = "<ul style=\"list-style:none;padding:0;margin:0\">" + items + "</ul>";
    },

    paintCaseDocuments: function (el, c) {
      var self = this;
      var token = localStorage.getItem("gl_token") || "";
      var rows =
        (c.documents || [])
          .map(function (d) {
            var url =
              (d.url || "/api/big-problems/documents/" + d.documentId + "/download") +
              (token ? "?token=" + encodeURIComponent(token) : "");
            return (
              "<tr><td>" +
              self.esc(d.fileName) +
              "</td><td>" +
              self.esc(d.docKind) +
              "</td><td>" +
              self.fmtDate(d.createdAt) +
              '</td><td><a href="' +
              self.esc(url) +
              '" target="_blank" rel="noopener">Download</a></td></tr>'
            );
          })
          .join("") ||
        '<tr><td colspan="4" class="gos-muted">No documents</td></tr>';
      el.innerHTML =
        '<div style="margin-bottom:0.75rem;display:flex;gap:0.5rem;flex-wrap:wrap;align-items:center">' +
        '<input type="file" id="bp-doc-file" />' +
        '<select id="bp-doc-kind" class="gos-input">' +
        ["GENERAL", "EVIDENCE", "FINANCIAL", "COMMUNICATION", "OTHER"]
          .map(function (k) {
            return '<option value="' + k + '">' + k + "</option>";
          })
          .join("") +
        '</select><button type="button" class="gos-btn" id="bp-doc-up">Upload</button></div>' +
        '<table class="gos-table" style="width:100%"><thead><tr><th>File</th><th>Kind</th><th>Uploaded</th><th></th></tr></thead><tbody>' +
        rows +
        "</tbody></table>";
      el.querySelector("#bp-doc-up").addEventListener("click", async function () {
        var fileInput = el.querySelector("#bp-doc-file");
        if (!fileInput.files || !fileInput.files[0]) {
          alert("Choose a file");
          return;
        }
        var fd = new FormData();
        fd.append("file", fileInput.files[0]);
        fd.append("docKind", el.querySelector("#bp-doc-kind").value);
        var token = localStorage.getItem("gl_token");
        var res = await fetch("/api/big-problems/cases/" + encodeURIComponent(c.caseId) + "/documents", {
          method: "POST",
          headers: { Authorization: token ? "Bearer " + token : "" },
          body: fd,
        });
        var json = await res.json();
        if (!json.success) alert(json.message);
        else self.paintCaseDetail(el.closest("#bp-body"), c.caseId);
      });
    },

    paintCaseComms: function (el, c) {
      var self = this;
      var items =
        (c.communications || [])
          .map(function (m) {
            return (
              '<div style="margin-bottom:0.85rem;padding:0.75rem;border:1px solid rgba(255,255,255,0.08);border-radius:8px">' +
              '<div class="gos-muted" style="font-size:0.8rem">' +
              self.esc(m.channel) +
              " · " +
              self.esc(m.authorName) +
              " · " +
              self.fmtDate(m.createdAt) +
              "</div>" +
              (m.subject ? "<div style=\"font-weight:600\">" + self.esc(m.subject) + "</div>" : "") +
              '<div style="white-space:pre-wrap;margin-top:0.35rem">' +
              self.esc(m.body) +
              "</div></div>"
            );
          })
          .join("") || '<p class="gos-muted">No communication yet</p>';
      el.innerHTML =
        items +
        '<div style="margin-top:1rem"><textarea id="bp-comm-body" class="gos-input" rows="3" style="width:100%" placeholder="Add a note…"></textarea>' +
        '<div style="margin-top:0.5rem;display:flex;gap:0.5rem">' +
        '<select id="bp-comm-ch" class="gos-input"><option>NOTE</option><option>EMAIL</option><option>CALL</option><option>MEETING</option><option>OTHER</option></select>' +
        '<button type="button" class="gos-btn gos-btn-primary" id="bp-comm-add">Add</button></div></div>';
      el.querySelector("#bp-comm-add").addEventListener("click", async function () {
        var r = await self.api("/cases/" + encodeURIComponent(c.caseId) + "/communications", {
          method: "POST",
          body: JSON.stringify({
            body: el.querySelector("#bp-comm-body").value,
            channel: el.querySelector("#bp-comm-ch").value,
          }),
        });
        if (!r.success) alert(r.message);
        else self.paintCaseDetail(el.closest("#bp-body"), c.caseId);
      });
    },

    paintCaseFinancials: function (el, c) {
      var self = this;
      var f = c.financials || {};
      var canEdit = c.permissions && c.permissions.canEditFinancials;
      var field = function (id, label, val) {
        return (
          '<label class="gos-muted">' +
          self.esc(label) +
          '</label><input id="' +
          id +
          '" class="gos-input" type="number" step="0.01" min="0" value="' +
          self.esc(val == null ? 0 : val) +
          '" style="width:100%;margin-bottom:0.5rem" ' +
          (canEdit ? "" : "readonly") +
          " />"
        );
      };
      el.innerHTML =
        '<p class="gos-muted" style="margin-bottom:0.75rem">Potential exposure = customer claim + compensation + legal + other. Carrier/insurance claims are tracked separately (no double-count). Pending insurance never counts as recovered.</p>' +
        '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:0.75rem">' +
        "<div>" +
        field("f-cust", "Customer Claim Amount", f.customerClaimAmount) +
        field("f-carr", "Carrier Claim Amount", f.carrierClaimAmount) +
        field("f-ins", "Insurance Claim Amount", f.insuranceClaimAmount) +
        '<label class="gos-muted">Insurance Status</label><select id="f-ins-st" class="gos-input" style="width:100%;margin-bottom:0.5rem" ' +
        (canEdit ? "" : "disabled") +
        ">" +
        ["PENDING", "APPROVED", "PAID", "DENIED"]
          .map(function (s) {
            return (
              '<option value="' +
              s +
              '"' +
              (f.insuranceStatus === s ? " selected" : "") +
              ">" +
              s +
              "</option>"
            );
          })
          .join("") +
        "</select></div><div>" +
        field("f-comp", "Customer Compensation", f.customerCompensation) +
        field("f-legal", "Legal Expenses", f.legalExpenses) +
        field("f-other", "Other Expenses", f.otherExpenses) +
        field("f-rec", "Amount Recovered (confirmed only)", f.amountRecovered) +
        "</div></div>" +
        '<div style="display:flex;flex-wrap:wrap;gap:1rem;margin:1rem 0">' +
        this.metricCard("Potential Exposure", this.fmtMoney(f.potentialExposure)) +
        this.metricCard("Actual Net Loss", this.fmtMoney(f.actualNetLoss)) +
        this.metricCard("Outstanding Exposure", this.fmtMoney(f.outstandingExposure), "#34d399") +
        "</div>" +
        (canEdit
          ? '<button type="button" class="gos-btn gos-btn-primary" id="bp-fin-save">Save financials</button>'
          : "");
      var save = el.querySelector("#bp-fin-save");
      if (save) {
        save.addEventListener("click", async function () {
          var payload = {
            customerClaimAmount: Number(el.querySelector("#f-cust").value || 0),
            carrierClaimAmount: Number(el.querySelector("#f-carr").value || 0),
            insuranceClaimAmount: Number(el.querySelector("#f-ins").value || 0),
            insuranceStatus: el.querySelector("#f-ins-st").value,
            customerCompensation: Number(el.querySelector("#f-comp").value || 0),
            legalExpenses: Number(el.querySelector("#f-legal").value || 0),
            otherExpenses: Number(el.querySelector("#f-other").value || 0),
            amountRecovered: Number(el.querySelector("#f-rec").value || 0),
          };
          var r = await self.api("/cases/" + encodeURIComponent(c.caseId) + "/financials", {
            method: "PUT",
            body: JSON.stringify(payload),
          });
          if (!r.success) alert(r.message);
          else self.paintCaseDetail(el.closest("#bp-body"), c.caseId);
        });
      }
    },
  };

  problems.bigProblems = BP;
})();

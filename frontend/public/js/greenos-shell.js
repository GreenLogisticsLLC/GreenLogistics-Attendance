/**
 * GreenOS shell — top bar, sidebar, module routing.
 * Does not touch authentication APIs.
 */
(function () {
  window.GreenOS = {
    currentModule: "dashboard",
    currentSub: null,
    user: null,
    _historyBound: false,

    shellApi(path) {
      const token = localStorage.getItem("gl_token");
      return fetch(path, {
        cache: "no-store",
        headers: {
          Accept: "application/json",
          Authorization: token ? "Bearer " + token : "",
        },
      }).then(function (res) {
        return res.json().catch(function () {
          return { success: false, message: "Bad response" };
        });
      });
    },

    initShell() {
      this.user = window.GreenOSUser || this.user || null;
      this.renderSidebar();
      this.bindChrome();
      this.bindHistory();
      if (window.GreenOSRealtime && typeof window.GreenOSRealtime.connect === "function") {
        window.GreenOSRealtime.connect();
      }
      const fromUrl = this.parseRoute();
      const start =
        fromUrl.module && this.canAccessModule(fromUrl.module)
          ? fromUrl.module
          : this.user && this.user.role === "Broker"
            ? "broker"
            : this.user && this.user.role === "Accounting"
              ? "accounting"
              : "dashboard";
      this.navigate(start, fromUrl.sub, { replace: true });
      if (this.role() === "Broker") {
        this.initAgentWidget();
      }
    },

    /** Parse `#/module` or `#/module/sub` from the URL. */
    parseRoute() {
      const raw = String(window.location.hash || "").replace(/^#\/?/, "").trim();
      if (!raw) return { module: null, sub: null };
      const parts = raw
        .split("/")
        .filter(Boolean)
        .map(function (p) {
          try {
            return decodeURIComponent(p);
          } catch (e) {
            return p;
          }
        });
      return { module: parts[0] || null, sub: parts[1] || null };
    },

    buildRouteUrl(moduleId, subPageId) {
      let hash = "#/" + encodeURIComponent(moduleId || "dashboard");
      if (subPageId) hash += "/" + encodeURIComponent(subPageId);
      return window.location.pathname + window.location.search + hash;
    },

    writeHistory(moduleId, subPageId, replace) {
      const state = {
        gos: true,
        module: moduleId,
        sub: subPageId || null,
      };
      const url = this.buildRouteUrl(moduleId, subPageId);
      try {
        if (replace) {
          window.history.replaceState(state, "", url);
        } else {
          window.history.pushState(state, "", url);
        }
      } catch (e) {
        /* ignore history errors (e.g. file://) */
      }
    },

    bindHistory() {
      if (this._historyBound) return;
      this._historyBound = true;
      window.addEventListener("popstate", (e) => {
        let moduleId = null;
        let sub = null;
        if (e.state && e.state.gos && e.state.module) {
          moduleId = e.state.module;
          sub = e.state.sub || null;
        } else {
          const parsed = this.parseRoute();
          moduleId = parsed.module;
          sub = parsed.sub;
        }
        if (!moduleId) {
          moduleId = this.role() === "Broker" ? "broker" : "dashboard";
        }
        this.navigate(moduleId, sub, { skipHistory: true });
      });
    },

    role() {
      return (this.user && this.user.role) || (window.GreenOSUser && window.GreenOSUser.role) || "";
    },

    canAccessModule(moduleId) {
      const meta = (window.GreenOSRegistry || []).find((m) => m.id === moduleId);
      if (!meta) return false;
      if (!meta.roles || !meta.roles.length) return true;
      return meta.roles.includes(this.role());
    },

    renderSidebar() {
      const nav = document.getElementById("gos-nav");
      if (!nav || !window.GreenOSRegistry) return;
      const role = this.role();
      const modules = window.GreenOSRegistry.filter((m) => {
        if (!m.roles || !m.roles.length) return true;
        return m.roles.includes(role);
      });
      const groups = [
        {
          title: "Operations",
          ids: ["dashboard", "broker", "shipments", "crm", "loads", "dispatch", "problems", "email"],
        },
        {
          title: "Network",
          ids: ["carriers", "customers", "trucking", "car-transport"],
        },
        {
          title: "People",
          ids: ["employees", "attendance"],
        },
        {
          title: "Finance",
          ids: ["accounting", "invoices", "contracts", "documents", "reports"],
        },
        {
          title: "Intelligence",
          ids: ["command-center", "ai", "communications"],
        },
        {
          title: "Admin",
          ids: ["administration"],
        },
      ];
      const used = new Set();
      let html = "";
      groups.forEach((g) => {
        const items = modules.filter((m) => g.ids.includes(m.id));
        if (!items.length) return;
        html += `<div class="gos-nav-section">${g.title}</div>`;
        items.forEach((m) => {
          used.add(m.id);
          html +=
            `<button type="button" class="gos-nav-item" data-module="${m.id}">` +
            `<span class="gos-nav-icon">${m.icon}</span><span>${m.title}</span>` +
            `</button>`;
        });
      });
      const rest = modules.filter((m) => !used.has(m.id));
      if (rest.length) {
        html += `<div class="gos-nav-section">More</div>`;
        rest.forEach((m) => {
          html +=
            `<button type="button" class="gos-nav-item" data-module="${m.id}">` +
            `<span class="gos-nav-icon">${m.icon}</span><span>${m.title}</span>` +
            `</button>`;
        });
      }
      nav.innerHTML = html;
      nav.querySelectorAll("[data-module]").forEach((btn) => {
        btn.addEventListener("click", () => this.navigate(btn.dataset.module));
      });
      this.refreshUserChip();
      this.refreshStatusBar();
    },

    refreshUserChip() {
      const user = this.user || window.GreenOSUser || {};
      const name =
        [user.firstName, user.lastName].filter(Boolean).join(" ").trim() ||
        user.username ||
        "User";
      const role = user.role || "";
      const logged = document.getElementById("logged-user");
      const roleEl = document.getElementById("gos-user-role");
      const av = document.getElementById("gos-user-avatar");
      if (logged) logged.textContent = name;
      if (roleEl) roleEl.textContent = role;
      if (av) {
        const parts = name.split(/\s+/).filter(Boolean);
        av.textContent = (
          (parts[0] && parts[0][0]) ||
          "G"
        ).toUpperCase() + ((parts[1] && parts[1][0]) || "L").toUpperCase();
      }
    },

    refreshStatusBar() {
      const timeEl = document.getElementById("gos-status-time");
      if (timeEl) {
        timeEl.textContent = new Date().toLocaleTimeString(undefined, {
          hour: "2-digit",
          minute: "2-digit",
        });
      }
      const att = document.getElementById("gos-status-att");
      const email = document.getElementById("gos-status-email");
      const ai = document.getElementById("gos-status-ai");
      if (att) att.textContent = "Connected";
      if (email) email.textContent = "Connected";
      if (ai) ai.textContent = "Operational";
    },

    bindChrome() {
      const logo = document.getElementById("gos-logo-refresh");
      const refreshPage = () => window.location.reload();
      logo?.addEventListener("click", refreshPage);
      logo?.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          refreshPage();
        }
      });
      this.bindThemeToggle();
      document.getElementById("gos-ai-top-btn")?.addEventListener("click", () => {
        this.navigate("ai");
      });
      document.getElementById("gos-sidebar-toggle")?.addEventListener("click", () => {
        document.getElementById("gos-sidebar")?.classList.toggle("is-open");
      });
      const globalSearch = document.getElementById("gos-global-search");
      if (globalSearch && globalSearch.dataset.routeBound !== "1") {
        globalSearch.dataset.routeBound = "1";
        globalSearch.addEventListener("keydown", (e) => {
          if (e.key !== "Enter" || !globalSearch.value.trim()) return;
          if (this.role() === "Broker") {
            e.preventDefault();
            this.navigate("broker", "shipments");
            // My Shipments reads the existing search value while rendering.
            globalSearch.dispatchEvent(new Event("input"));
          }
        });
      }
      document.getElementById("gos-notifications-btn")?.addEventListener("click", () => {
        if (window.GreenOSRealtime) window.GreenOSRealtime.clearUnread();
        if (this.role() === "Broker") {
          this.navigate("broker", "notifications");
        } else {
          this.navigate("crm", "dashboard");
        }
      });
    },

    getTheme() {
      const t = document.documentElement.getAttribute("data-theme");
      return t === "light" ? "light" : "dark";
    },

    applyTheme(theme) {
      if (typeof window.applyGosTheme === "function") {
        window.applyGosTheme(theme);
        return;
      }
      const next = theme === "light" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      try {
        localStorage.setItem("gos_theme", next);
      } catch (e) {}
      this.syncThemeToggleUi();
    },

    syncThemeToggleUi() {
      if (typeof window.syncGosThemeButtons === "function") {
        window.syncGosThemeButtons();
        return;
      }
      const btn = document.getElementById("gos-theme-toggle");
      if (!btn) return;
      const light = this.getTheme() === "light";
      btn.textContent = light ? "🌙" : "☀️";
      btn.title = light ? "Switch to dark theme" : "Switch to light theme";
      btn.setAttribute("aria-label", btn.title);
    },

    bindThemeToggle() {
      if (typeof window.bindGosThemeButtons === "function") {
        window.bindGosThemeButtons();
        return;
      }
      this.syncThemeToggleUi();
      const btn = document.getElementById("gos-theme-toggle");
      if (!btn || btn.dataset.bound === "1") return;
      btn.dataset.bound = "1";
      btn.addEventListener("click", () => {
        this.applyTheme(this.getTheme() === "light" ? "dark" : "light");
      });
    },

    setActiveNav(moduleId) {
      document.querySelectorAll(".gos-nav-item").forEach((el) => {
        el.classList.toggle("is-active", el.dataset.module === moduleId);
      });
    },

    navigate(moduleId, subPageId, opts) {
      opts = opts || {};
      if (!this.canAccessModule(moduleId)) {
        const fallback = this.role() === "Broker" ? "broker" : "dashboard";
        if (moduleId !== fallback) {
          this.navigate(fallback, null, { replace: opts.replace, skipHistory: opts.skipHistory });
          return;
        }
      }

      const nextSub = subPageId || null;
      const same =
        this.currentModule === moduleId && (this.currentSub || null) === nextSub;

      this.currentModule = moduleId;
      this.currentSub = nextSub;
      this.setActiveNav(moduleId);

      if (!opts.skipHistory) {
        this.writeHistory(moduleId, nextSub, Boolean(opts.replace || same));
      }

      const host = document.getElementById("gos-module-host");
      const attendanceHost = document.getElementById("gos-attendance-host");
      if (!host || !attendanceHost) return;

      if (moduleId === "attendance") {
        host.classList.add("hidden");
        host.innerHTML = "";
        attendanceHost.classList.remove("hidden");
        const view =
          subPageId === "reports" ? "reports" : subPageId === "setup" ? "admin" : "dashboard";
        if (typeof window.switchView === "function") {
          window.switchView(view);
        }
        return;
      }

      attendanceHost.classList.add("hidden");
      if (typeof window.stopAttendanceTimers === "function") {
        window.stopAttendanceTimers();
      }
      host.classList.remove("hidden");

      if (moduleId === "dashboard") {
        this.renderDashboard(host);
        return;
      }
      this.stopDashboardPoll();

      if (moduleId === "ai") {
        this.renderAI(host);
        return;
      }

      const mod = window.GreenOSModules && window.GreenOSModules[moduleId];
      if (mod && typeof mod.render === "function") {
        mod.render(host, subPageId);
        // Modules that manage their own sub-nav (Loads/Dispatch) call stopPropagation.
        // For others, shell wires sub-page navigation.
        if (moduleId !== "loads" && moduleId !== "dispatch") {
          host.querySelectorAll("[data-subpage]").forEach((btn) => {
            btn.addEventListener("click", () => this.navigate(moduleId, btn.dataset.subpage));
          });
        }
        return;
      }

      const meta = (window.GreenOSRegistry || []).find((m) => m.id === moduleId);
      host.innerHTML =
        `<div class="gos-module-placeholder">` +
        `<h2>${meta ? meta.title : moduleId} Module</h2>` +
        `<p>Coming Soon</p>` +
        `</div>`;
    },

    /** Soft re-render current module (used by realtime / poll). */
    refreshModule() {
      if (!this.currentModule) return;
      // Attendance panels live in index.html and refresh themselves.
      if (this.currentModule === "attendance") return;
      // Email Imports — manual Check Gmail / page visit only.
      if (this.currentModule === "email") return;
      // Administration (API Integrations, users, etc.) — never auto-remount.
      if (this.currentModule === "administration") return;
      // Employees (Platform users / roles) — manual only; auto refresh wipes open dropdowns.
      if (this.currentModule === "employees") return;
      // Carriers — manual Refresh only (avoid wiping open carrier detail / tabs).
      if (this.currentModule === "carriers") return;
      if (this.currentModule === "customers") return;
      // AI chat — never auto-remount (destroys input and resets "Connecting…" status).
      if (this.currentModule === "ai") return;
      // Trucking has its own live timer.
      if (this.currentModule === "trucking") return;
      // Shipments list — manual only; push/poll must not remount the table
      // (Broker, Team Lead, Owner — New / Other / CRM Shipments).
      if (this.currentModule === "shipments") return;
      if (this.currentSub === "new" || this.currentSub === "other") return;
      if (this.currentModule === "broker" && this.currentSub === "shipments") return;
      if (this.currentModule === "crm" && this.currentSub === "shipments") return;
      if (
        document.getElementById("shipments-module-body") ||
        document.getElementById("crm-ship-body") ||
        document.getElementById("broker-ship-body")
      ) {
        return;
      }
      if (
        this.currentModule === "crm" &&
        typeof window.GreenOSCrmReloadBody === "function"
      ) {
        window.GreenOSCrmReloadBody();
        return;
      }
      // Freeze Load Details while editing — no realtime remount/soft-reload.
      if (
        this.currentModule === "loads" ||
        this.currentModule === "dispatch" ||
        (this.currentModule === "broker" && this.currentSub === "loads")
      ) {
        var viewing = false;
        try {
          viewing = Boolean(
            sessionStorage.getItem("gos_viewing_load_id") ||
              (window.GreenOSModules &&
                window.GreenOSModules.loads &&
                window.GreenOSModules.loads._loadId) ||
              (window.GreenOSModules &&
                window.GreenOSModules.dispatch &&
                window.GreenOSModules.dispatch._loadId)
          );
        } catch (e) {}
        if (viewing || document.querySelector(".load-layout")) {
          return;
        }
      }
      // A full re-render would destroy an open shipment card mid-edit.
      const modal = document.getElementById("crm-modal");
      if (modal && !modal.classList.contains("hidden")) return;
      if (this.currentModule === "dashboard") {
        const host = document.getElementById("gos-module-host");
        if (host) this.loadDashboardMetrics(host);
        return;
      }
      this.navigate(this.currentModule, this.currentSub || undefined, { skipHistory: true });
    },

    stopDashboardPoll() {
      if (this._dashPollTimer) {
        clearInterval(this._dashPollTimer);
        this._dashPollTimer = null;
      }
    },

    renderDashboard(root) {
      this.stopDashboardPoll();
      root.innerHTML =
        `<div class="gos-cc">` +
        `<div class="gos-cc-hero">` +
        `<div>` +
        `<h1>Command Center</h1>` +
        `<p>Live GreenOS overview — loads, brokers In Office, assignment queue, and recent activity.</p>` +
        `</div>` +
        `<div class="gos-chip-row">` +
        `<span class="gos-chip is-on" id="gos-cc-mode">Mode: …</span>` +
        `<span class="gos-chip" id="gos-cc-updated">Updating…</span>` +
        `</div>` +
        `</div>` +
        `<section class="gos-cc-kpis" id="gos-cc-kpis"></section>` +
        `<section class="gos-cc-mid">` +
        `<article class="gos-panel">` +
        `<div class="gos-panel-head"><h3>Shipment pipeline</h3>` +
        `<div class="gos-chip-row"><span class="gos-chip is-on">7d</span><span class="gos-chip">Live</span></div>` +
        `</div>` +
        `<div class="gos-chart-wrap" id="gos-cc-chart"></div>` +
        `<div class="gos-queue-mini" id="gos-cc-queue-mini">Assignment queue loading…</div>` +
        `</article>` +
        `<article class="gos-panel">` +
        `<div class="gos-panel-head"><h3>Broker workload</h3></div>` +
        `<div class="gos-donut-wrap" id="gos-cc-donut"></div>` +
        `</article>` +
        `<article class="gos-panel">` +
        `<div class="gos-panel-head"><h3>In Office now</h3><span class="gos-chip is-on" id="gos-cc-office-count">0</span></div>` +
        `<ul class="gos-office-list" id="gos-cc-office"><li class="gos-muted">Loading…</li></ul>` +
        `</article>` +
        `</section>` +
        `<section class="gos-cc-bottom">` +
        `<article class="gos-panel">` +
        `<div class="gos-panel-head"><h3>Recent shipments</h3></div>` +
        `<div style="overflow:auto">` +
        `<table class="gos-table"><thead><tr>` +
        `<th>ID</th><th>Title</th><th>Broker</th><th>Status</th>` +
        `</tr></thead><tbody id="gos-cc-recent"><tr><td colspan="4" class="gos-muted">Loading…</td></tr></tbody></table>` +
        `</div></article>` +
        `<article class="gos-panel">` +
        `<div class="gos-panel-head"><h3>AI insights</h3></div>` +
        `<div id="gos-cc-insights"></div>` +
        `</article>` +
        `<article class="gos-panel">` +
        `<div class="gos-panel-head"><h3>Activity feed</h3></div>` +
        `<ul class="gos-feed" id="gos-cc-feed"><li class="gos-muted">Loading…</li></ul>` +
        `</article>` +
        `</section>` +
        `</div>`;

      this.loadDashboardMetrics(root);
      const self = this;
      this._dashPollTimer = setInterval(function () {
        if (self.currentModule === "dashboard") {
          self.loadDashboardMetrics(root);
        }
      }, 30000);
    },

    loadDashboardMetrics(root) {
      if (!root) return;
      const self = this;
      const state = { crm: null, att: null, queue: null };

      function initials(name) {
        const parts = String(name || "")
          .trim()
          .split(/\s+/)
          .filter(Boolean);
        if (!parts.length) return "GL";
        return (
          (parts[0][0] || "G") + (parts[1] ? parts[1][0] : parts[0][1] || "L")
        ).toUpperCase();
      }

      function badgeClass(status) {
        const s = String(status || "").toLowerCase();
        if (/won|deliver|complete|active|accepted|working/.test(s)) return "ok";
        if (/await|pending|quote|new/.test(s)) return "warn";
        if (/transit|assign|progress/.test(s)) return "info";
        if (/lost|cancel|fail|late/.test(s)) return "danger";
        return "muted";
      }

      function sparkline(values, color) {
        const w = 520;
        const h = 200;
        const nums = values.length ? values : [2, 4, 3, 6, 5, 8, 7];
        const max = Math.max.apply(null, nums.concat([1]));
        const min = Math.min.apply(null, nums);
        const span = Math.max(max - min, 1);
        const coords = nums.map(function (v, i) {
          const x = (i / Math.max(nums.length - 1, 1)) * (w - 24) + 12;
          const y = h - 18 - ((v - min) / span) * (h - 40);
          return [x, y];
        });
        const line = coords
          .map(function (p, i) {
            return (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1);
          })
          .join(" ");
        const area =
          line +
          " L " +
          coords[coords.length - 1][0].toFixed(1) +
          " " +
          (h - 12) +
          " L " +
          coords[0][0].toFixed(1) +
          " " +
          (h - 12) +
          " Z";
        return (
          `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">` +
          `<defs><linearGradient id="gosSpark" x1="0" y1="0" x2="0" y2="1">` +
          `<stop offset="0%" stop-color="${color}" stop-opacity="0.35"/>` +
          `<stop offset="100%" stop-color="${color}" stop-opacity="0"/>` +
          `</linearGradient></defs>` +
          `<path d="${area}" fill="url(#gosSpark)"/>` +
          `<path d="${line}" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>` +
          `</svg>`
        );
      }

      function donut(parts) {
        const total = parts.reduce(function (a, p) {
          return a + p.value;
        }, 0) || 1;
        const r = 42;
        const c = 2 * Math.PI * r;
        let offset = 0;
        const rings = parts
          .map(function (p) {
            const len = (p.value / total) * c;
            const seg =
              `<circle cx="50" cy="50" r="${r}" fill="none" stroke="${p.color}" stroke-width="10" ` +
              `stroke-dasharray="${len.toFixed(2)} ${(c - len).toFixed(2)}" ` +
              `stroke-dashoffset="${(-offset).toFixed(2)}" />`;
            offset += len;
            return seg;
          })
          .join("");
        return (
          `<div class="gos-donut"><svg viewBox="0 0 100 100" style="transform:rotate(-90deg)">${rings}</svg>` +
          `<div class="gos-donut-center"><strong>${total}</strong><span>total</span></div></div>` +
          `<ul class="gos-legend">` +
          parts
            .map(function (p) {
              return (
                `<li><span><span class="swatch" style="background:${p.color}"></span>${self.escapeHtml(
                  p.label
                )}</span><strong>${p.value}</strong></li>`
              );
            })
            .join("") +
          `</ul>`
        );
      }

      function renderAll() {
        const kpis =
          (state.crm && state.crm.success && state.crm.data && state.crm.data.kpis) || {};
        const attStats =
          (state.att && state.att.success && state.att.data && state.att.data.statistics) ||
          {};
        const queueData = state.queue && state.queue.success && state.queue.data;
        const mode =
          (queueData && queueData.assignmentMode) || kpis.assignmentMode || "";
        const present =
          attStats.employeesPresent != null
            ? attStats.employeesPresent
            : kpis.brokersPresent != null
              ? kpis.brokersPresent
              : 0;
        const activeLoads =
          kpis.ownerActiveLoads != null
            ? kpis.ownerActiveLoads
            : kpis.activeShipments != null
              ? kpis.activeShipments
              : 0;

        const modeEl = root.querySelector("#gos-cc-mode");
        if (modeEl) {
          modeEl.textContent =
            mode === "in_office"
              ? "Mode: In Office"
              : mode === "none"
                ? "Mode: Waiting for check-in"
                : "Mode: Live";
        }
        const updatedEl = root.querySelector("#gos-cc-updated");
        if (updatedEl) {
          updatedEl.textContent =
            "Updated " +
            new Date().toLocaleTimeString(undefined, {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            });
        }

        const kpiHost = root.querySelector("#gos-cc-kpis");
        if (kpiHost) {
          const cards = [
            { label: "Active Loads", value: activeLoads, delta: "With In Office brokers", tone: "tone-blue" },
            { label: "New Today", value: kpis.newShipmentsToday != null ? kpis.newShipmentsToday : "—", delta: "Imported / created", tone: "tone-green" },
            { label: "Unassigned", value: kpis.unassigned != null ? kpis.unassigned : "—", delta: "Waiting for broker", tone: "tone-warn" },
            { label: "In Office", value: present, delta: "People checked in", tone: "tone-green" },
            { label: "Awaiting Accept", value: kpis.awaitingAcceptance != null ? kpis.awaitingAcceptance : "—", delta: "Not accepted yet", tone: "tone-purple" },
            { label: "Working", value: kpis.working != null ? kpis.working : "—", delta: "Brokers on leads", tone: "tone-blue" },
          ];
          kpiHost.innerHTML = cards
            .map(function (c) {
              return (
                `<article class="gos-kpi ${c.tone}">` +
                `<div class="label">${c.label}</div>` +
                `<div class="value">${c.value}</div>` +
                `<div class="delta">${c.delta}</div>` +
                `</article>`
              );
            })
            .join("");
        }

        const chartHost = root.querySelector("#gos-cc-chart");
        if (chartHost) {
          const series = [
            Number(kpis.newShipmentsToday) || 2,
            Number(kpis.quotesSent) || 4,
            Number(kpis.awaitingAcceptance) || 3,
            Number(kpis.working) || 5,
            Number(activeLoads) || 6,
            Number(kpis.won) || 4,
            Number(present) || 5,
          ];
          chartHost.innerHTML = sparkline(series, "#12d48a");
        }

        const donutHost = root.querySelector("#gos-cc-donut");
        if (donutHost) {
          donutHost.innerHTML = donut([
            { label: "Working", value: Number(kpis.working) || 0, color: "#12d48a" },
            { label: "Awaiting", value: Number(kpis.awaitingAcceptance) || 0, color: "#fbbf24" },
            { label: "Unassigned", value: Number(kpis.unassigned) || 0, color: "#60a5fa" },
            { label: "Won today", value: Number(kpis.won) || 0, color: "#a78bfa" },
          ]);
        }

        const officeHost = root.querySelector("#gos-cc-office");
        const officeCount = root.querySelector("#gos-cc-office-count");
        const employees =
          (state.att && state.att.success && state.att.data && state.att.data.employees) || [];
        const inOffice = employees.filter(function (e) {
          return String(e.currentStatus || "") === "INSIDE_OFFICE";
        });
        const officeN = inOffice.length || present || 0;
        if (officeCount) officeCount.textContent = String(officeN);
        const presenceLabel = document.getElementById("gos-presence-label");
        if (presenceLabel) {
          presenceLabel.textContent =
            officeN > 0 ? "In Office · " + officeN : "In Office · 0";
        }
        if (officeHost) {
          if (!inOffice.length) {
            officeHost.innerHTML =
              '<li class="gos-muted">Nobody In Office right now</li>';
          } else {
            officeHost.innerHTML = inOffice
              .slice(0, 10)
              .map(function (e) {
                const name = e.employeeName || e.fullName || "Employee";
                const dept = e.department || e.position || "Team";
                return (
                  `<li><span class="gos-office-avatar">${self.escapeHtml(
                    initials(name)
                  )}<span class="live"></span></span>` +
                  `<div class="gos-office-meta"><strong>${self.escapeHtml(
                    name
                  )}</strong><span>${self.escapeHtml(dept)}</span></div></li>`
                );
              })
              .join("");
          }
        }

        const recentHost = root.querySelector("#gos-cc-recent");
        const recent =
          (state.crm && state.crm.success && state.crm.data && state.crm.data.recentlyAssigned) ||
          [];
        if (recentHost) {
          if (!recent.length) {
            recentHost.innerHTML =
              '<tr><td colspan="4" class="gos-muted">No recent assignments</td></tr>';
          } else {
            recentHost.innerHTML = recent
              .slice(0, 8)
              .map(function (r) {
                const id = r.greenOsShipmentId || r.shipmentLeadId || "—";
                const title = r.shipmentTitle || "Shipment";
                const who = r.brokerName || r.assignedBrokerName || "—";
                const st = r.status || r.leadStatus || "Assigned";
                return (
                  `<tr><td>${self.escapeHtml(String(id))}</td>` +
                  `<td>${self.escapeHtml(String(title))}</td>` +
                  `<td>${self.escapeHtml(String(who))}</td>` +
                  `<td><span class="gos-badge ${badgeClass(st)}">${self.escapeHtml(
                    String(st)
                  )}</span></td></tr>`
                );
              })
              .join("");
          }
        }

        const feedHost = root.querySelector("#gos-cc-feed");
        if (feedHost) {
          if (!recent.length) {
            feedHost.innerHTML = '<li class="gos-muted">No recent activity</li>';
          } else {
            feedHost.innerHTML = recent
              .slice(0, 8)
              .map(function (r) {
                const title = r.shipmentTitle || r.greenOsShipmentId || "Shipment";
                const who = r.brokerName || r.assignedBrokerName || "broker";
                return (
                  `<li><span class="mark"></span><div class="body"><strong>${self.escapeHtml(
                    String(title)
                  )} → ${self.escapeHtml(String(who))}</strong>` +
                  `<span>Recently assigned</span></div></li>`
                );
              })
              .join("");
          }
        }

        const insights = root.querySelector("#gos-cc-insights");
        if (insights) {
          const tips = [];
          if (mode === "none") {
            tips.push({
              t: "No brokers In Office",
              d: "New Instant Alerts stay Unassigned until someone checks in.",
            });
          } else {
            tips.push({
              t: "In Office routing on",
              d: "Round-robin is limited to checked-in brokers only.",
            });
          }
          if (Number(kpis.unassigned) > 0) {
            tips.push({
              t: `${kpis.unassigned} unassigned lead(s)`,
              d: "Open CRM or Drain Pending once brokers are In Office.",
            });
          }
          if (Number(present) > 0) {
            tips.push({
              t: `${present} people In Office`,
              d: "Attendance presence is feeding assignment eligibility.",
            });
          }
          insights.innerHTML = tips
            .map(function (x) {
              return (
                `<div class="gos-insight"><strong>${self.escapeHtml(
                  x.t
                )}</strong><p>${self.escapeHtml(x.d)}</p></div>`
              );
            })
            .join("");
        }

        const queueMini = root.querySelector("#gos-cc-queue-mini");
        if (queueMini && queueData) {
          queueMini.innerHTML =
            `<strong>Next → ${self.escapeHtml(
              queueData.nextBroker || "—"
            )}</strong> · ` +
            self.escapeHtml(
              queueData.assignmentModeLabel ||
                (mode === "in_office"
                  ? "Checked-in brokers only"
                  : mode === "none"
                    ? "Waiting for In Office"
                    : "Queue idle")
            );
        }

        self.refreshStatusBar();
      }

      this.shellApi("/api/crm/dashboard?shell=1")
        .then(function (crm) {
          state.crm = crm;
          renderAll();
        })
        .catch(function () {
          state.crm = { success: false };
          renderAll();
        });

      this.shellApi("/api/v1/dashboard")
        .then(function (att) {
          state.att = att;
          renderAll();
        })
        .catch(function () {
          state.att = { success: false };
          renderAll();
        });

      this.shellApi("/api/assignment/queue")
        .then(function (queueRes) {
          state.queue = queueRes;
          renderAll();
        })
        .catch(function () {
          state.queue = { success: false };
          renderAll();
        });
    },


    escapeHtml(s) {
      return String(s || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    },

    aiApi(path, options) {
      const token = localStorage.getItem("gl_token");
      const ctrl = new AbortController();
      const timer = setTimeout(function () {
        ctrl.abort();
      }, 12000);
      return fetch("/api/ai" + path, {
        ...options,
        signal: ctrl.signal,
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          Authorization: token ? "Bearer " + token : "",
          ...(options && options.headers),
        },
      })
        .then(function (res) {
          return res.json();
        })
        .finally(function () {
          clearTimeout(timer);
        });
    },

    aiSourceHref(source) {
      if (!source || !source.id) return null;
      const t = String(source.type || "").toLowerCase();
      if (t === "carrier" || source.carrierId) {
        const id = source.carrierId || source.id;
        return "#/carriers/" + encodeURIComponent(id);
      }
      if (t === "shipment" || source.shipmentLeadId) {
        const id = source.shipmentLeadId || source.id;
        return "#/shipments/" + encodeURIComponent(id);
      }
      if (t === "carrier_document" && source.carrierId) {
        return "#/carriers/" + encodeURIComponent(source.carrierId);
      }
      if (t === "load_document" && source.shipmentLeadId) {
        return "#/shipments/" + encodeURIComponent(source.shipmentLeadId);
      }
      return null;
    },

    bindAiChat({ messagesEl, formEl, inputEl, history }) {
      const self = this;

      function append(role, text) {
        const div = document.createElement("div");
        div.className = `gos-ai-bubble ${role}`;
        div.textContent = text;
        messagesEl.appendChild(div);
        messagesEl.scrollTop = messagesEl.scrollHeight;
        return div;
      }

      function appendMeta(payload) {
        if (!payload) return;
        const parts = [];
        if (payload.groundingLabel) parts.push(payload.groundingLabel);
        else if (payload.answerMode === "grounded" || payload.answerMode === "not_found")
          parts.push("Based on GreenOS data");
        else if (payload.answerMode === "general") parts.push("General AI answer (not GreenOS data)");
        if (payload.searchMode) parts.push("Search: " + payload.searchMode);

        const meta = document.createElement("div");
        meta.className = "gos-ai-bubble bot gos-ai-meta";
        meta.style.opacity = "0.85";
        meta.style.fontSize = "0.85em";

        if (parts.length) {
          const label = document.createElement("div");
          label.textContent = parts.join(" · ");
          meta.appendChild(label);
        }

        const sources = Array.isArray(payload.sources) ? payload.sources : [];
        if (sources.length) {
          const srcWrap = document.createElement("div");
          srcWrap.style.marginTop = "6px";
          srcWrap.appendChild(document.createTextNode("Sources: "));
          sources.slice(0, 8).forEach(function (s, idx) {
            if (idx) srcWrap.appendChild(document.createTextNode(" · "));
            const href = self.aiSourceHref(s);
            if (href) {
              const a = document.createElement("a");
              a.href = href;
              a.textContent = s.label || s.type || "record";
              a.style.color = "inherit";
              a.style.textDecoration = "underline";
              a.addEventListener("click", function (ev) {
                ev.preventDefault();
                if (typeof self.navigate === "function") self.navigate(href.replace(/^#/, ""));
                else window.location.hash = href.replace(/^#/, "");
              });
              srcWrap.appendChild(a);
            } else {
              srcWrap.appendChild(
                document.createTextNode(
                  (s.label || s.type || "record") +
                    (s.id ? " (" + String(s.id).slice(0, 8) + "…)" : "")
                )
              );
            }
          });
          meta.appendChild(srcWrap);
        }

        if (payload.runId) {
          const run = document.createElement("div");
          run.style.marginTop = "4px";
          run.style.opacity = "0.7";
          run.textContent = "runId: " + payload.runId;
          meta.appendChild(run);
        }

        if (!meta.childNodes.length) return;
        messagesEl.appendChild(meta);
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }

      if (inputEl) {
        inputEl.disabled = false;
      }

      formEl.addEventListener("submit", async (e) => {
        e.preventDefault();
        const text = inputEl.value.trim();
        if (!text) return;
        append("user", text);
        inputEl.value = "";
        const sendBtn = formEl.querySelector("button[type=submit]");
        if (sendBtn) sendBtn.disabled = true;
        append("bot", "Thinking…");
        const thinking = messagesEl.lastChild;
        try {
          const data = await self.aiApi("/chat", {
            method: "POST",
            body: JSON.stringify({ message: text, history }),
          });
          if (thinking && thinking.parentNode) thinking.remove();
          if (!data.success) {
            append("bot", data.message || "AI request failed");
            return;
          }
          const payload = data.data || {};
          const reply = payload.reply || "";
          append("bot", reply);
          appendMeta(payload);
          history.push({ role: "user", content: text });
          history.push({ role: "assistant", content: reply });
          if (history.length > 16) history.splice(0, history.length - 16);
        } catch {
          if (thinking && thinking.parentNode) thinking.remove();
          append("bot", "Connection error talking to GreenOS AI");
        } finally {
          if (sendBtn) sendBtn.disabled = false;
          inputEl.focus();
        }
      });
    },

    renderAI(root) {
      root.innerHTML =
        `<section class="gos-dash-hero gos-ai-hero">` +
        `<h1>GreenOS AI Assistant</h1>` +
        `</section>` +
        `<div class="gos-ai-layout">` +
        `<section class="gos-ai-chat">` +
        `<div class="gos-ai-messages" id="gos-ai-messages">` +
        `<div class="gos-ai-bubble bot">Welcome to GreenOS AI Assistant.\n\nAsk about attendance, shipments, assignment, or operations.</div>` +
        `</div>` +
        `<div class="gos-ai-prompts" id="gos-ai-prompts">` +
        `<button type="button" data-prompt="Summarize today's dispatch status">Summarize today's dispatch</button>` +
        `<button type="button" data-prompt="Who is late today?">Who is late today?</button>` +
        `<button type="button" data-prompt="How does Round Robin assignment work in GreenOS?">How does assignment work?</button>` +
        `<button type="button" data-prompt="Draft a carrier follow-up email">Draft carrier email</button>` +
        `</div>` +
        `<form class="gos-ai-input-row" id="gos-ai-form">` +
        `<input id="gos-ai-input" placeholder="Ask GreenOS AI..." autocomplete="off" />` +
        `<button type="submit" class="btn-primary">Send</button>` +
        `</form>` +
        `</section></div>`;

      const messages = root.querySelector("#gos-ai-messages");
      const form = root.querySelector("#gos-ai-form");
      const input = root.querySelector("#gos-ai-input");
      const history = [];

      this.bindAiChat({ messagesEl: messages, formEl: form, inputEl: input, history });
      if (input) input.focus();

      root.querySelectorAll("[data-prompt]").forEach((btn) => {
        btn.addEventListener("click", () => {
          input.value = btn.dataset.prompt;
          form.requestSubmit();
        });
      });
    },

    initAgentWidget() {
      const self = this;
      const user = this.user || window.GreenOSUser || {};
      const sessionKey = "gos-agent-widget-dismissed";
      const firstName = String(user.firstName || "there").trim() || "there";
      const welcomeText =
        `Hi, ${firstName}! I'm the GREENOS AI AGENT, built specially for GreenOS. ` +
        `I'm here to help you with shipments, customers, dispatch, and your daily broker workflow.\n\n` +
        `Ask me anything — I'm glad to help.`;

      let root = document.getElementById("gos-kate-widget");
      if (!root) {
        root = document.createElement("div");
        root.id = "gos-kate-widget";
        root.className = "gos-kate-widget";
        root.innerHTML =
          `<button type="button" class="gos-kate-fab hidden" id="gos-kate-fab" title="GREENOS AI Agent">🤖</button>` +
          `<div class="gos-kate-panel hidden" id="gos-kate-panel" role="dialog" aria-labelledby="gos-kate-title">` +
          `<header class="gos-kate-header">` +
          `<div class="gos-kate-title-wrap">` +
          `<span class="gos-kate-avatar" aria-hidden="true">🤖</span>` +
          `<div><strong id="gos-kate-title">GREENOS AI AGENT</strong>` +
          `<span class="gos-kate-sub">Your broker assistant</span></div>` +
          `</div>` +
          `<div class="gos-kate-header-actions">` +
          `<button type="button" class="gos-kate-icon-btn" id="gos-kate-minimize" title="Minimize">−</button>` +
          `<button type="button" class="gos-kate-icon-btn" id="gos-kate-close" title="Close">×</button>` +
          `</div>` +
          `</header>` +
          `<div class="gos-kate-messages" id="gos-kate-messages">` +
          `<div class="gos-ai-bubble bot">${self.escHtml(welcomeText)}</div>` +
          `</div>` +
          `<form class="gos-kate-input-row" id="gos-kate-form">` +
          `<input id="gos-kate-input" placeholder="Ask GREENOS AI Agent…" autocomplete="off" />` +
          `<button type="submit" class="btn-primary">Send</button>` +
          `</form>` +
          `</div>`;
        document.getElementById("app-screen")?.appendChild(root);

        root._agentHistory = [];
        self.bindAiChat({
          messagesEl: document.getElementById("gos-kate-messages"),
          formEl: document.getElementById("gos-kate-form"),
          inputEl: document.getElementById("gos-kate-input"),
          history: root._agentHistory,
        });

        document.getElementById("gos-kate-fab")?.addEventListener("click", () => {
          self.showKatePanel();
          document.getElementById("gos-kate-input")?.focus();
        });
        document.getElementById("gos-kate-minimize")?.addEventListener("click", () => {
          self.hideKatePanel(true);
        });
        document.getElementById("gos-kate-close")?.addEventListener("click", () => {
          sessionStorage.setItem(sessionKey, "1");
          self.hideKatePanel(true);
        });
      }

      if (sessionStorage.getItem(sessionKey)) {
        this.hideKatePanel(true);
        return;
      }
      this.showKatePanel();
      setTimeout(function () {
        document.getElementById("gos-kate-input")?.focus();
      }, 200);
    },

    escHtml(value) {
      return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    },

    showKatePanel() {
      document.getElementById("gos-kate-panel")?.classList.remove("hidden");
      document.getElementById("gos-kate-fab")?.classList.add("hidden");
      document.getElementById("gos-kate-input")?.focus();
    },

    hideKatePanel(showFab) {
      document.getElementById("gos-kate-panel")?.classList.add("hidden");
      const fab = document.getElementById("gos-kate-fab");
      if (fab && showFab) fab.classList.remove("hidden");
    },
  };

  window.GreenOSShell = window.GreenOS;
})();

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
      nav.innerHTML = modules
        .map((m) => {
          return (
            `<button type="button" class="gos-nav-item" data-module="${m.id}">` +
            `<span class="gos-nav-icon">${m.icon}</span><span>${m.title}</span>` +
            `</button>`
          );
        })
        .join("");

      nav.querySelectorAll("[data-module]").forEach((btn) => {
        btn.addEventListener("click", () => this.navigate(btn.dataset.module));
      });
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
      // Shipments list — manual only; push/poll must not remount the table.
      if (this.currentModule === "shipments") return;
      if (this.currentModule === "broker" && this.currentSub === "shipments") return;
      if (this.currentModule === "crm" && this.currentSub === "shipments") return;
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
        `<section class="gos-dash-hero">` +
        `<h1>GreenOS Dashboard</h1>` +
        `<p>Live operational overview — Active Loads = shipments with brokers who receive mail (checked-in when anyone is In Office; otherwise all brokers).</p>` +
        `</section>` +
        `<p class="gos-muted" id="gos-dash-status">Loading live metrics…</p>` +
        `<section class="gos-card-grid" id="gos-dash-cards"></section>` +
        `<section class="gos-queue-panel" id="gos-dash-queue">` +
        `<div class="gos-queue-head">` +
        `<h3>Assignment queue</h3>` +
        `<span class="gos-muted" id="gos-queue-updated">Updating…</span>` +
        `</div>` +
        `<p class="gos-muted" id="gos-queue-mode">Loading queue…</p>` +
        `<p class="gos-queue-next-row"><strong>Next shipment →</strong> ` +
        `<span class="gos-queue-next-name" id="gos-queue-next">—</span></p>` +
        `<ol class="gos-queue-order" id="gos-queue-order"><li class="gos-muted">Loading…</li></ol>` +
        `</section>` +
        `<section class="gos-activity">` +
        `<h3>Recently assigned</h3>` +
        `<ul id="gos-dash-activity"><li class="gos-muted">Loading…</li></ul>` +
        `</section>`;

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
      const statusEl = root.querySelector("#gos-dash-status");
      const cardsEl = root.querySelector("#gos-dash-cards");
      const activityEl = root.querySelector("#gos-dash-activity");
      const queueModeEl = root.querySelector("#gos-queue-mode");
      const queueNextEl = root.querySelector("#gos-queue-next");
      const queueOrderEl = root.querySelector("#gos-queue-order");
      const queueUpdatedEl = root.querySelector("#gos-queue-updated");
      const self = this;
      const state = { crm: null, att: null, queue: null };

      function currentMode() {
        const queueData = state.queue && state.queue.success && state.queue.data;
        const kpis =
          state.crm && state.crm.success && state.crm.data && state.crm.data.kpis;
        return (queueData && queueData.assignmentMode) || (kpis && kpis.assignmentMode) || "";
      }

      function renderCards() {
        if (!cardsEl) return;
        const kpis =
          (state.crm && state.crm.success && state.crm.data && state.crm.data.kpis) || {};
        const attStats =
          (state.att && state.att.success && state.att.data && state.att.data.statistics) || {};
        const mode = currentMode();
        const loads =
          kpis.ownerActiveLoads != null
            ? kpis.ownerActiveLoads
            : kpis.activeShipments != null
              ? kpis.activeShipments
              : "—";
        const present =
          attStats.employeesPresent != null
            ? attStats.employeesPresent
            : kpis.brokersPresent != null
              ? kpis.brokersPresent
              : "—";
        const cards = [
          {
            label: "Active Loads",
            value: String(loads),
            hint:
              mode === "in_office"
                ? "With checked-in brokers"
                : mode === "all_brokers_fallback"
                  ? "No one In Office — total across brokers (RR to all)"
                  : "Assigned active shipments",
            tone: "accent-blue",
          },
          {
            label: "New today",
            value: String(kpis.newShipmentsToday != null ? kpis.newShipmentsToday : "—"),
            hint: "Imported / created today",
            tone: "accent-green",
          },
          {
            label: "Unassigned",
            value: String(kpis.unassigned != null ? kpis.unassigned : "—"),
            hint: "Waiting for a broker",
            tone: "accent-warn",
          },
          {
            label: "Employees Present",
            value: String(present),
            hint: "In Office now",
            tone: "accent-green",
          },
          {
            label: "Awaiting accept",
            value: String(kpis.awaitingAcceptance != null ? kpis.awaitingAcceptance : "—"),
            hint: "Not accepted yet",
            tone: "accent-purple",
          },
          {
            label: "Working",
            value: String(kpis.working != null ? kpis.working : "—"),
            hint: "Brokers working leads",
            tone: "accent-blue",
          },
        ];
        cardsEl.innerHTML = cards
          .map(function (c) {
            return (
              `<article class="gos-card ${c.tone}">` +
              `<div class="label">${c.label}</div>` +
              `<div class="value">${c.value}</div>` +
              `<div class="hint">${c.hint}</div>` +
              `</article>`
            );
          })
          .join("");
      }

      function renderQueue() {
        if (!queueModeEl || !queueNextEl || !queueOrderEl) return;
        const queueData = state.queue && state.queue.success && state.queue.data;
        const mode = currentMode();
        if (queueData) {
          const modeLabel =
            queueData.assignmentModeLabel ||
            (mode === "in_office"
              ? "Checked-in brokers only"
              : mode === "all_brokers_fallback"
                ? "Nobody In Office — all brokers (Gary first)"
                : "No eligible brokers");
          const badgeClass =
            mode === "all_brokers_fallback" ? "gos-queue-badge fallback" : "gos-queue-badge";
          const badgeText =
            mode === "in_office"
              ? "In Office"
              : mode === "all_brokers_fallback"
                ? "Fallback"
                : "Idle";
          queueModeEl.innerHTML =
            self.escapeHtml(modeLabel) + ` <span class="${badgeClass}">${badgeText}</span>`;
          queueNextEl.textContent = queueData.nextBroker || "—";

          const order = queueData.queueOrder || [];
          const eligibleIds = new Set(
            (queueData.eligible || []).map(function (e) {
              return e.userId;
            })
          );
          const nextName = queueData.nextBroker || "";
          if (!order.length) {
            queueOrderEl.innerHTML =
              '<li class="gos-muted">No brokers in queue — check badges / Broker role</li>';
          } else {
            queueOrderEl.innerHTML = order
              .map(function (item, idx) {
                const isNext = item.name === nextName || idx === queueData.nextIndex;
                const inPool = eligibleIds.has(item.userId);
                const cls =
                  (isNext ? "gos-queue-next-item " : "") + (inPool ? "" : "gos-queue-ineligible");
                const tag = isNext ? ' <span class="gos-queue-badge">next</span>' : "";
                return (
                  `<li class="${cls.trim()}">` +
                  `${idx + 1}. ${self.escapeHtml(item.name || item.userId)}${tag}` +
                  `</li>`
                );
              })
              .join("");
          }
        } else if (state.queue) {
          queueModeEl.textContent =
            "Queue status unavailable for your role (Owner / Manager / Broker can view).";
          queueNextEl.textContent = "—";
          queueOrderEl.innerHTML = '<li class="gos-muted">—</li>';
        }
      }

      function renderActivity() {
        if (!activityEl || !state.crm) return;
        const recent =
          (state.crm.success && state.crm.data && state.crm.data.recentlyAssigned) || [];
        if (!recent.length) {
          activityEl.innerHTML = '<li class="gos-muted">No recent assignments</li>';
        } else {
          activityEl.innerHTML = recent
            .slice(0, 12)
            .map(function (r) {
              const title =
                r.shipmentTitle || r.greenOsShipmentId || r.shipmentLeadId || "Shipment";
              const who = r.brokerName || r.assignedBrokerName || "broker";
              return `<li>${self.escapeHtml(String(title))} → ${self.escapeHtml(String(who))}</li>`;
            })
            .join("");
        }
      }

      function renderStatus() {
        if (!statusEl) return;
        if (!state.crm && !state.queue) return;
        const mode = currentMode();
        statusEl.textContent =
          mode === "in_office"
            ? "Assignment: checked-in brokers only (round-robin)."
            : mode === "all_brokers_fallback"
              ? "Assignment: nobody In Office — round-robin across all brokers (Gary first)."
              : "Live metrics loaded.";
        statusEl.style.color = "";
      }

      function markQueueUpdated() {
        if (!queueUpdatedEl) return;
        const now = new Date();
        queueUpdatedEl.textContent =
          "Updated " +
          now.toLocaleTimeString(undefined, {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          });
      }

      this.shellApi("/api/crm/dashboard?shell=1")
        .then(function (crm) {
          state.crm = crm;
          renderCards();
          renderActivity();
          renderStatus();
        })
        .catch(function () {
          state.crm = { success: false };
          if (statusEl) {
            statusEl.textContent = "CRM metrics failed to load";
            statusEl.style.color = "#ef4444";
          }
        });

      this.shellApi("/api/v1/dashboard?statsOnly=1")
        .then(function (att) {
          state.att = att;
          renderCards();
        })
        .catch(function () {
          state.att = { success: false };
        });

      this.shellApi("/api/assignment/queue")
        .then(function (queueRes) {
          state.queue = queueRes;
          renderQueue();
          renderCards();
          renderStatus();
          markQueueUpdated();
        })
        .catch(function () {
          state.queue = { success: false };
          renderQueue();
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

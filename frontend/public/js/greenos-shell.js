/**
 * GreenOS shell — top bar, sidebar, module routing.
 * Does not touch authentication APIs.
 */
(function () {
  const DEMO_CARDS = [
    { label: "Active Loads", value: "24", hint: "Demo data", tone: "accent-blue" },
    { label: "Active Customers", value: "86", hint: "Demo data", tone: "accent-green" },
    { label: "Employees Present", value: "18", hint: "Demo data", tone: "accent-green" },
    { label: "Late Employees", value: "3", hint: "Demo data", tone: "accent-warn" },
    { label: "Pending Registrations", value: "2", hint: "Demo data", tone: "accent-purple" },
    { label: "Revenue Today", value: "$12,480", hint: "Demo data", tone: "accent-green" },
    { label: "Carrier Payments", value: "$4,920", hint: "Demo data", tone: "accent-blue" },
    { label: "Open Invoices", value: "14", hint: "Demo data", tone: "accent-warn" },
    { label: "Monthly Revenue", value: "$186K", hint: "Demo data", tone: "accent-green" },
    { label: "Total Employees", value: "42", hint: "Demo data", tone: "" },
    { label: "Active Carriers", value: "31", hint: "Demo data", tone: "accent-blue" },
  ];

  const DEMO_ACTIVITY = [
    "Load #GL-2041 dispatched to Carrier SwiftHaul",
    "Invoice INV-889 marked as paid",
    "New CRM lead: Pacific Auto Group",
    "Attendance: 3 employees marked late",
    "Contract template updated for carriers",
  ];

  window.GreenOS = {
    currentModule: "dashboard",
    currentSub: null,
    user: null,
    _historyBound: false,

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
      // Administration (API Integrations, users, etc.) — never auto-remount.
      if (this.currentModule === "administration") return;
      // Carriers — manual Refresh only (avoid wiping open carrier detail / tabs).
      if (this.currentModule === "carriers") return;
      if (this.currentModule === "customers") return;
      // AI chat — never auto-remount (destroys input and resets "Connecting…" status).
      if (this.currentModule === "ai") return;
      // Trucking has its own live timer.
      if (this.currentModule === "trucking") return;
      if (
        this.currentModule === "broker" &&
        this.currentSub === "shipments" &&
        typeof window.GreenOSBrokerReloadShipments === "function"
      ) {
        window.GreenOSBrokerReloadShipments();
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
      this.navigate(this.currentModule, this.currentSub || undefined, { skipHistory: true });
    },

    renderDashboard(root) {
      const cards = DEMO_CARDS.map(
        (c) =>
          `<article class="gos-card ${c.tone}">` +
          `<div class="label">${c.label}</div>` +
          `<div class="value">${c.value}</div>` +
          `<div class="hint">${c.hint}</div>` +
          `</article>`
      ).join("");

      const activity = DEMO_ACTIVITY.map((a) => `<li>${a}</li>`).join("");

      root.innerHTML =
        `<section class="gos-dash-hero">` +
        `<h1>GreenOS Dashboard</h1>` +
        `<p>Operational overview for Green Logistics — demo metrics for architecture phase.</p>` +
        `</section>` +
        `<section class="gos-card-grid">${cards}</section>` +
        `<section class="gos-activity">` +
        `<h3>Recent Activity</h3>` +
        `<ul>${activity}</ul>` +
        `</section>` +
        `<article class="gos-card" style="margin-top:1rem">` +
        `<div class="label">Recent Activity feed</div>` +
        `<div class="value" style="font-size:1rem;font-weight:500;color:var(--gos-muted)">` +
        `Live operational stream will connect in a later phase.` +
        `</div></article>`;
    },

    renderAI(root) {
      root.innerHTML =
        `<section class="gos-dash-hero">` +
        `<h1>GreenOS AI Assistant</h1>` +
        `<p id="gos-ai-status-line">Connecting to OpenAI…</p>` +
        `</section>` +
        `<div class="gos-ai-layout">` +
        `<aside class="gos-ai-history">` +
        `<h3>Conversations</h3>` +
        `<button type="button">Welcome overview</button>` +
        `<button type="button">Dispatch help</button>` +
        `<button type="button">Attendance summary</button>` +
        `</aside>` +
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
      const statusLine = root.querySelector("#gos-ai-status-line");
      const history = [];

      function append(role, text) {
        const div = document.createElement("div");
        div.className = `gos-ai-bubble ${role}`;
        div.textContent = text;
        messages.appendChild(div);
        messages.scrollTop = messages.scrollHeight;
      }

      async function api(path, options) {
        const token = localStorage.getItem("gl_token");
        const ctrl = new AbortController();
        const timer = setTimeout(function () {
          ctrl.abort();
        }, 12000);
        try {
          const res = await fetch("/api/ai" + path, {
            ...options,
            signal: ctrl.signal,
            headers: {
              "Content-Type": "application/json",
              Authorization: token ? "Bearer " + token : "",
              ...(options && options.headers),
            },
          });
          return res.json();
        } finally {
          clearTimeout(timer);
        }
      }

      api("/status")
        .then(function (data) {
          if (!statusLine) return;
          if (data.success && data.data && data.data.configured) {
            var bits = ["Model: " + (data.data.model || "OpenAI") + " — ready"];
            if (data.data.keyType) bits.push("key: " + data.data.keyType);
            if (data.data.keySuffix) bits.push("…" + data.data.keySuffix);
            statusLine.textContent = bits.join(" · ");
          } else {
            statusLine.textContent =
              "OPENAI_API_KEY not configured on server — add it to .env and restart";
          }
        })
        .catch(function () {
          if (statusLine) statusLine.textContent = "AI ready — type a message below";
        });

      if (input) {
        input.disabled = false;
        input.focus();
      }

      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const text = input.value.trim();
        if (!text) return;
        append("user", text);
        input.value = "";
        const sendBtn = form.querySelector("button[type=submit]");
        if (sendBtn) sendBtn.disabled = true;
        append("bot", "Thinking…");
        const thinking = messages.lastChild;
        try {
          const data = await api("/chat", {
            method: "POST",
            body: JSON.stringify({ message: text, history }),
          });
          if (thinking && thinking.parentNode) thinking.remove();
          if (!data.success) {
            append("bot", data.message || "AI request failed");
            return;
          }
          const reply = (data.data && data.data.reply) || "";
          append("bot", reply);
          history.push({ role: "user", content: text });
          history.push({ role: "assistant", content: reply });
          if (history.length > 16) history.splice(0, history.length - 16);
        } catch {
          if (thinking && thinking.parentNode) thinking.remove();
          append("bot", "Connection error talking to GreenOS AI");
        } finally {
          if (sendBtn) sendBtn.disabled = false;
        }
      });

      root.querySelectorAll("[data-prompt]").forEach((btn) => {
        btn.addEventListener("click", () => {
          input.value = btn.dataset.prompt;
          form.requestSubmit();
        });
      });
    },
  };

  window.GreenOSShell = window.GreenOS;
})();

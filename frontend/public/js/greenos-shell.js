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

    initShell() {
      this.user = window.GreenOSUser || this.user || null;
      this.renderSidebar();
      this.bindChrome();
      const start =
        this.user && this.user.role === "Broker" ? "broker" : "dashboard";
      this.navigate(start);
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
      document.getElementById("gos-ai-top-btn")?.addEventListener("click", () => {
        this.navigate("ai");
      });
      document.getElementById("gos-sidebar-toggle")?.addEventListener("click", () => {
        document.getElementById("gos-sidebar")?.classList.toggle("is-open");
      });
      document.getElementById("gos-notifications-btn")?.addEventListener("click", () => {
        alert("Notifications center — coming soon");
      });
    },

    setActiveNav(moduleId) {
      document.querySelectorAll(".gos-nav-item").forEach((el) => {
        el.classList.toggle("is-active", el.dataset.module === moduleId);
      });
    },

    navigate(moduleId, subPageId) {
      if (!this.canAccessModule(moduleId)) {
        const fallback = this.role() === "Broker" ? "broker" : "dashboard";
        if (moduleId !== fallback) {
          this.navigate(fallback);
          return;
        }
      }
      this.currentModule = moduleId;
      this.currentSub = subPageId || null;
      this.setActiveNav(moduleId);

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
        host.querySelectorAll("[data-subpage]").forEach((btn) => {
          btn.addEventListener("click", () => this.navigate(moduleId, btn.dataset.subpage));
        });
        return;
      }

      const meta = (window.GreenOSRegistry || []).find((m) => m.id === moduleId);
      host.innerHTML =
        `<div class="gos-module-placeholder">` +
        `<h2>${meta ? meta.title : moduleId} Module</h2>` +
        `<p>Coming Soon</p>` +
        `</div>`;
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
        `<p>Conversation UI prepared — LLM connection comes in a later phase.</p>` +
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
        `<div class="gos-ai-bubble bot">Welcome to GreenOS AI Assistant.\n\nI will help you manage Green Logistics operations.</div>` +
        `</div>` +
        `<div class="gos-ai-prompts" id="gos-ai-prompts">` +
        `<button type="button" data-prompt="Summarize today's dispatch status">Summarize today's dispatch</button>` +
        `<button type="button" data-prompt="Who is late today?">Who is late today?</button>` +
        `<button type="button" data-prompt="List open invoices">List open invoices</button>` +
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

      function append(role, text) {
        const div = document.createElement("div");
        div.className = `gos-ai-bubble ${role}`;
        div.textContent = text;
        messages.appendChild(div);
        messages.scrollTop = messages.scrollHeight;
      }

      form.addEventListener("submit", (e) => {
        e.preventDefault();
        const text = input.value.trim();
        if (!text) return;
        append("user", text);
        input.value = "";
        setTimeout(() => {
          append(
            "bot",
            "AI responses will be connected in a later phase. Your message was received and saved in this local conversation UI."
          );
        }, 350);
      });

      root.querySelectorAll("[data-prompt]").forEach((btn) => {
        btn.addEventListener("click", () => {
          input.value = btn.dataset.prompt;
          form.requestSubmit();
        });
      });
    },
  };
})();

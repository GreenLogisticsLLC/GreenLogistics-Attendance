const API = "/api/v1";
let token = localStorage.getItem("gl_token");

function consumeTokenFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const urlToken = params.get("token");
    if (!urlToken) return;
    token = urlToken;
    localStorage.setItem("gl_token", urlToken);
    window.history.replaceState({}, document.title, window.location.pathname);
}

consumeTokenFromUrl();
let refreshTimer = null;
let currentUser = null;
let adminEmployees = [];

const $ = (sel) => document.querySelector(sel);
const loginScreen = $("#login-screen");
const appScreen = $("#app-screen");
const loginForm = $("#login-form");
const signupForm = $("#signup-form");
const loginError = $("#login-error");
const signupError = $("#signup-error");
const signupSuccess = $("#signup-success");

function showLogin() {
    loginScreen.classList.remove("hidden");
    appScreen.classList.add("hidden");
    loginForm.classList.remove("hidden");
    signupForm.classList.add("hidden");
    stopAttendanceTimers();
}

function stopAttendanceTimers() {
    if (refreshTimer) clearInterval(refreshTimer);
    if (reportRefreshTimer) clearInterval(reportRefreshTimer);
    refreshTimer = null;
    reportRefreshTimer = null;
}
window.stopAttendanceTimers = stopAttendanceTimers;

function showApp(user) {
    currentUser = user;
    window.GreenOSUser = user;
    loginScreen.classList.add("hidden");
    appScreen.classList.remove("hidden");
    $("#logged-user").textContent = `${user.firstName} ${user.lastName} (${user.role})`;

    const canAdmin = ["Administrator", "Manager", "Owner"].includes(user.role);
    $("#nav-admin").classList.toggle("hidden", !canAdmin);
    if (user.role === "Administrator" || user.role === "Owner") {
        loadSettings();
    }

    updateWebhookUrlDisplays();
    updateClock();

    if (window.GreenOS && typeof window.GreenOS.initShell === "function") {
        window.GreenOS.user = user;
        window.GreenOS.initShell();
    } else {
        switchView("dashboard");
    }
}

async function updateWebhookUrlDisplays() {
    let url = `${window.location.origin}/api/v1/webhook/attendance`;
    let ips = [];
    try {
        const res = await fetch("/api/v1/network-info");
        const data = await res.json();
        if (data.success && data.data) {
            if (data.data.webhookUrls?.network) {
                url = data.data.webhookUrls.network;
            } else if (data.data.webhookUrls?.recommended) {
                url = data.data.webhookUrls.recommended;
            }
            ips = data.data.networkIps || [];
        }
    } catch {
        try {
            const res = await fetch("/api/health");
            const data = await res.json();
            if (data.webhookUrls?.network) url = data.webhookUrls.network;
            ips = data.networkIps || [];
        } catch { /* use origin */ }
    }

    $("#webhook-url-display").textContent = url;
    const adminWebhook = $("#admin-webhook-url");
    if (adminWebhook) adminWebhook.textContent = url;

    const setupUrl = $("#setup-webhook-url");
    if (setupUrl) setupUrl.textContent = url;

    const healthEl = $("#setup-health-url");
    if (healthEl) {
        const base = url.replace("/api/v1/webhook/attendance", "");
        healthEl.textContent = `${base}/api/health`;
    }

    const ipsEl = $("#setup-network-ips");
    if (ipsEl) {
        ipsEl.textContent = ips.length
            ? `IP этого компьютера: ${ips.join(", ")}`
            : "IP не найден — выполните ipconfig в cmd и найдите IPv4 Wi‑Fi/Ethernet";
    }
}

let reportRefreshTimer = null;

function toDateInput(d) {
    return d.toLocaleDateString("en-CA");
}

function currentAttendanceDate() {
    const date = new Date();
    if (date.getHours() < 2) date.setDate(date.getDate() - 1);
    return date;
}

function initReportDates() {
    const today = currentAttendanceDate();
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
    const fromEl = $("#report-from");
    const toEl = $("#report-to");
    if (fromEl && !fromEl.value) fromEl.value = toDateInput(monthStart);
    if (toEl && !toEl.value) toEl.value = toDateInput(today);
}

function setReportPreset(preset) {
    const today = currentAttendanceDate();
    const to = toDateInput(today);
    let from;
    if (preset === "today") {
        from = to;
    } else if (preset === "week") {
        const d = new Date(today);
        d.setDate(d.getDate() - 6);
        from = toDateInput(d);
    } else {
        from = toDateInput(new Date(today.getFullYear(), today.getMonth(), 1));
    }
    $("#report-from").value = from;
    $("#report-to").value = to;
    loadPeriodReport();
}

function switchView(view) {
    document.querySelectorAll(".nav-btn").forEach((b) => {
        b.classList.toggle("active", b.dataset.view === view);
    });
    $("#dashboard-view").classList.toggle("hidden", view !== "dashboard");
    $("#reports-view").classList.toggle("hidden", view !== "reports");
    $("#admin-view").classList.toggle("hidden", view !== "admin");

    stopAttendanceTimers();

    if (view === "dashboard") {
        loadDashboard();
        refreshTimer = setInterval(loadDashboard, 2000);
    } else if (view === "reports") {
        initReportDates();
        loadPeriodReport();
        reportRefreshTimer = setInterval(() => {
            if ($("#report-live")?.checked) loadPeriodReport(true);
        }, 10000);
    } else if (view === "admin") {
        loadAdminEmployees();
        loadPendingScans();
        updateWebhookUrlDisplays();
        if (cardScanPollTimer) {
            clearInterval(cardScanPollTimer);
            cardScanPollTimer = null;
        }
    }
}
window.switchView = switchView;

document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchView(btn.dataset.view));
});

function updateClock() {
    const el = $("#current-date");
    if (!el) return;
    const now = new Date();
    el.textContent = now.toLocaleString("en-GB", {
        weekday: "long", year: "numeric", month: "long", day: "numeric",
        hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    });
    setTimeout(updateClock, 1000);
}

async function apiFetch(path, options = {}) {
    const headers = { "Content-Type": "application/json", ...options.headers };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${API}${path}`, { ...options, headers });
    let data;
    try {
        data = await res.json();
    } catch {
        throw new Error(`Server returned invalid response (HTTP ${res.status})`);
    }
    if (res.status === 401) {
        localStorage.removeItem("gl_token");
        token = null;
        showLogin();
        throw new Error("Unauthorized");
    }
    if (!data.success && res.status >= 400 && !data.message) {
        data.message = `Request failed (HTTP ${res.status})`;
    }
    return data;
}

function normalizeCardInput(raw) {
    return raw.toLowerCase().trim().replace(/^0x_/i, "").replace(/0x/gi, "").replace(/[\s_-]/g, "");
}

function suggestEmployeeNumber() {
    const nums = adminEmployees.map((e) => {
        const m = e.employeeNumber.match(/(\d+)\s*$/);
        return m ? parseInt(m[1], 10) : 0;
    });
    const max = nums.length ? Math.max(...nums) : 0;
    return `GL-${String(max + 1).padStart(3, "0")}`;
}

function findEmployeeByCard(cardNumber) {
    const normalized = normalizeCardInput(cardNumber);
    if (!normalized) return null;
    return adminEmployees.find(
        (e) => normalizeCardInput(e.cardNumber) === normalized
    ) || null;
}

function validateUniqueCard(cardNumber, excludeEmployeeId = null) {
    const normalized = normalizeCardInput(cardNumber);
    if (!normalized) {
        return "Введите уникальный код карты (любые буквы и цифры)";
    }
    const existing = findEmployeeByCard(normalized);
    if (existing && existing.employeeId !== excludeEmployeeId) {
        return `Карта ${normalized} уже зарегистрирована у ${existing.firstName} ${existing.lastName} (${existing.employeeNumber})`;
    }
    return null;
}

loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    loginError.classList.add("hidden");
    try {
        const res = await fetch(`${API}/auth/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                username: $("#username").value,
                password: $("#password").value,
            }),
        });
        const data = await res.json();
        if (!data.success) {
            loginError.textContent = data.message || "Login failed";
            loginError.classList.remove("hidden");
            return;
        }
        token = data.data.token;
        localStorage.setItem("gl_token", token);
        showApp(data.data.user);
    } catch {
        loginError.textContent = "Connection error";
        loginError.classList.remove("hidden");
    }
});

$("#toggle-login-password").addEventListener("click", () => {
    const input = $("#password");
    const btn = $("#toggle-login-password");
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    btn.setAttribute("aria-label", show ? "Hide password" : "Show password");
    btn.setAttribute("title", show ? "Hide password" : "Show password");
    btn.querySelector(".eye-open").classList.toggle("hidden", show);
    btn.querySelector(".eye-closed").classList.toggle("hidden", !show);
});

$("#toggle-signup-password")?.addEventListener("click", () => {
    const input = $("#signup-password");
    const btn = $("#toggle-signup-password");
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    btn.setAttribute("aria-label", show ? "Hide password" : "Show password");
    btn.setAttribute("title", show ? "Hide password" : "Show password");
    btn.querySelector(".eye-open").classList.toggle("hidden", show);
    btn.querySelector(".eye-closed").classList.toggle("hidden", !show);
});

$("#show-signup-btn").addEventListener("click", () => {
    loginForm.classList.add("hidden");
    signupForm.classList.remove("hidden");
    loginError.classList.add("hidden");
    signupError.classList.add("hidden");
    signupSuccess.classList.add("hidden");
    loadSignupTeamLeads();
});

$("#show-login-btn").addEventListener("click", () => {
    signupForm.classList.add("hidden");
    loginForm.classList.remove("hidden");
    signupError.classList.add("hidden");
    signupSuccess.classList.add("hidden");
    loginError.classList.add("hidden");
});

async function loadSignupTeamLeads() {
    const select = $("#signup-team-lead");
    const wrap = $("#signup-team-lead-wrap");
    if (!select || !wrap) return;
    try {
        const res = await fetch(`${API}/auth/team-leads`);
        const data = await res.json();
        const leads = (data.success && data.data) || [];
        select.innerHTML =
            '<option value="">Select Team Lead (Gary or Alen)…</option>' +
            leads
                .map(
                    (l) =>
                        `<option value="${l.userId}">${l.name}${l.email ? " — " + l.email : ""}</option>`
                )
                .join("");
        wrap.dataset.ready = leads.length ? "1" : "0";
    } catch {
        select.innerHTML = '<option value="">Team Leads unavailable</option>';
    }
    toggleSignupTeamLead();
}

function toggleSignupTeamLead() {
    const wrap = $("#signup-team-lead-wrap");
    const role = $("#signup-role")?.value;
    if (!wrap) return;
    wrap.classList.toggle("hidden", role !== "Broker");
}

$("#signup-role")?.addEventListener("change", toggleSignupTeamLead);

signupForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    signupError.classList.add("hidden");
    signupSuccess.classList.add("hidden");
    try {
        const role = $("#signup-role").value;
        const body = {
            firstName: $("#signup-first-name").value,
            lastName: $("#signup-last-name").value,
            username: $("#signup-username").value,
            email: $("#signup-email").value,
            password: $("#signup-password").value,
            role,
        };
        if (role === "Broker") {
            body.teamLeadId = $("#signup-team-lead")?.value || "";
            if (!body.teamLeadId) {
                signupError.textContent = "Select a Team Lead (Gary or Alen) for this Broker";
                signupError.classList.remove("hidden");
                return;
            }
        }
        const res = await fetch(`${API}/auth/register`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!data.success) {
            signupError.textContent = data.message || "Registration failed";
            signupError.classList.remove("hidden");
            return;
        }
        signupForm.reset();
        toggleSignupTeamLead();
        signupSuccess.textContent =
            (data.data && data.data.message) ||
            data.message ||
            "Request sent. Wait for administrator approval by email, then sign in.";
        signupSuccess.classList.remove("hidden");
    } catch {
        signupError.textContent = "Connection error";
        signupError.classList.remove("hidden");
    }
});

$("#logout-btn").addEventListener("click", () => {
    localStorage.removeItem("gl_token");
    token = null;
    showLogin();
});

$("#refresh-btn").addEventListener("click", loadDashboard);
$("#search-input").addEventListener("input", filterTable);
$("#status-filter").addEventListener("change", filterTable);
$("#close-drawer").addEventListener("click", () => $("#employee-drawer").classList.add("hidden"));

let allEmployees = [];

async function loadDashboard() {
    try {
        const data = await apiFetch("/dashboard");
        if (!data.success) return;
        renderStats(data.data.statistics);
        allEmployees = data.data.employees;
        renderTable(allEmployees);
        renderNotifications(data.data.notifications);
        renderSystemHealth(data.data.systemHealth);
        renderWebhooks(data.data.recentWebhooks);
    } catch (err) {
        console.error("Dashboard load failed", err);
    }
}

function renderStats(stats) {
    const items = [
        ["Scheduled", stats.employeesScheduled, ""],
        ["Inside Office", stats.employeesPresent, "var(--green)"],
        ["Outside", stats.employeesOutside, "var(--yellow)"],
        ["OutTime In Office", stats.employeesOvertime, "var(--blue)"],
        ["Not Arrived", stats.employeesNotArrived, "var(--gray)"],
        ["Left", stats.completedSessions, "var(--blue)"],
    ];
    $("#stats-panel").innerHTML = items.map(([label, value, color]) => `
        <div class="stat-card">
            <div class="label">${label}</div>
            <div class="value" style="color:${color || "inherit"}">${value}</div>
        </div>
    `).join("");
}

function statusLabel(status) {
    const map = {
        INSIDE_OFFICE: "In Office",
        OUTSIDE_OFFICE: "Outside (break)",
        SCHEDULED: "Not Arrived",
        COMPLETED: "Left",
        EXCEPTION: "Exception",
    };
    return map[status] || status;
}

function formatDuration(minutes) {
    if (minutes == null || minutes < 0) return "0h 0m";
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return `${h}h ${m}m`;
}

function renderTable(employees) {
    const tbody = $("#employees-body");
    tbody.innerHTML = employees.map((emp) => `
        <tr data-id="${emp.employeeId}" data-status="${emp.currentStatus}">
            <td><strong>${emp.employeeName}</strong><br><small style="color:var(--muted)">${emp.employeeNumber}</small></td>
            <td>${emp.department || "—"}</td>
            <td>${emp.firstEntry || "—"}</td>
            <td><span class="status-badge status-${emp.currentStatus}">${statusLabel(emp.currentStatus)}</span></td>
            <td>${emp.currentStatus === "INSIDE_OFFICE" ? formatDuration(emp.currentOfficeMinutes) : "—"}</td>
            <td>${emp.currentStatus === "OUTSIDE_OFFICE" ? formatDuration(emp.currentAbsenceMinutes) : "—"}</td>
            <td>${formatDuration(emp.totalAbsenceMinutes)}</td>
            <td>${emp.overtimeInOfficeMinutes ? formatDuration(emp.overtimeInOfficeMinutes) : "—"}</td>
            <td>${emp.exitCount || 0}</td>
            <td>${emp.lastActivity || "—"}</td>
        </tr>
    `).join("");

    tbody.querySelectorAll("tr").forEach((row) => {
        row.addEventListener("click", () => openEmployeeDrawer(row.dataset.id));
    });
}

function generateTempCardUid() {
    const num = suggestEmployeeNumber();
    return `temp${num.replace(/\D/g, "") || Date.now().toString(36).slice(-4)}`;
}

async function fillTempCardUid() {
    await loadAdminEmployees();
    const uid = generateTempCardUid();
    const input = $("#quick-card");
    if (input) input.value = uid;
    const dup = validateUniqueCard(uid);
    if (dup) {
        input.value = `${uid}${Math.random().toString(36).slice(2, 5)}`;
    }
    $("#quick-first")?.focus();
}

$("#generate-temp-uid-btn")?.addEventListener("click", () => fillTempCardUid());

$("#manual-uid-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const statusEl = $("#manual-uid-status");
    const token = normalizeCardInput($("#manual-uid-input")?.value || "");
    if (!token) {
        setSyncStatus(statusEl, "Введите UID карты", false);
        return;
    }
    setSyncStatus(statusEl, "Saving...", true);
    try {
        const data = await apiFetch("/card-registration/register-uid", {
            method: "POST",
            body: JSON.stringify({ token }),
        });
        if (!data.success) {
            setSyncStatus(statusEl, data.message || "Failed", false);
            return;
        }
        setSyncStatus(statusEl, `UID ${data.data.cardToken} записан — заполните форму регистрации`, true);
        $("#quick-card").value = data.data.cardToken;
        await loadPendingScans();
        $("#manual-uid-input").value = "";
        $("#quick-first")?.focus();
    } catch (err) {
        setSyncStatus(statusEl, err.message || "Failed", false);
    }
});

/* ========== REPORTS ========== */

async function loadPeriodReport(silent = false) {
    const from = $("#report-from")?.value;
    const to = $("#report-to")?.value;
    const statusEl = $("#report-status");
    if (!from || !to) return;

    if (!silent) setSyncStatus(statusEl, "Loading...", true);

    try {
        const data = await apiFetch(`/reports/period?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
        if (!data.success) {
            setSyncStatus(statusEl, data.message || "Failed", false);
            return;
        }
        renderReportStats(data.data.summary, from, to);
        renderReportTable(data.data.rows);
        setSyncStatus(
            statusEl,
            `Период: ${from} — ${to} · записей: ${data.data.rows.length}`,
            true
        );
    } catch (err) {
        if (!silent) setSyncStatus(statusEl, err.message || "Load failed", false);
    }
}

function renderReportStats(summary, from, to) {
    const panel = $("#report-stats-panel");
    if (!panel) return;
    const items = [
        ["Period", `${from} → ${to}`, ""],
        ["Records", summary.totalSessions, ""],
        ["With Entry", summary.daysWithEntry, "var(--green)"],
        ["Total In Office", formatDuration(summary.totalInOfficeMinutes), "var(--green)"],
        ["Total Outside", formatDuration(summary.totalOutsideMinutes), "var(--yellow)"],
        ["OutTime In Office", formatDuration(summary.totalOvertimeMinutes), "var(--blue)"],
    ];
    panel.innerHTML = items.map(([label, value, color]) => `
        <div class="stat-card">
            <div class="label">${label}</div>
            <div class="value" style="color:${color || "inherit"}">${value}</div>
        </div>
    `).join("");
}

function renderReportTable(rows) {
    const tbody = $("#report-body");
    if (!rows.length) {
        tbody.innerHTML = `<tr><td colspan="10" style="text-align:center;color:var(--muted)">Нет данных за выбранный период</td></tr>`;
        return;
    }
    tbody.innerHTML = rows.map((r) => `
        <tr>
            <td>${r.workDate}</td>
            <td><strong>${r.employeeName}</strong><br><small style="color:var(--muted)">${r.employeeNumber}</small></td>
            <td>${r.department || "—"}</td>
            <td>${r.firstEntry || "—"}</td>
            <td>${r.lastExit || "—"}</td>
            <td>${formatDuration(r.timeInOfficeMinutes)}</td>
            <td>${formatDuration(r.totalOutsideMinutes)}</td>
            <td>${r.overtimeInOfficeMinutes ? formatDuration(r.overtimeInOfficeMinutes) : "—"}</td>
            <td>${r.status}</td>
            <td>${r.exitCount}</td>
        </tr>
    `).join("");
}

async function downloadReportPdf() {
    const from = $("#report-from")?.value;
    const to = $("#report-to")?.value;
    const statusEl = $("#report-status");
    if (!from || !to) return;

    setSyncStatus(statusEl, "Generating PDF...", true);
    try {
        const res = await fetch(
            `${API}/reports/period/pdf?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
            { headers: { Authorization: `Bearer ${token}` } }
        );
        if (!res.ok) {
            setSyncStatus(statusEl, "PDF failed", false);
            return;
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `attendance-${from}-${to}.pdf`;
        a.click();
        URL.revokeObjectURL(url);
        setSyncStatus(statusEl, "PDF downloaded", true);
    } catch {
        setSyncStatus(statusEl, "PDF download failed", false);
    }
}

$("#report-range-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    loadPeriodReport();
});

$("#report-pdf-btn")?.addEventListener("click", downloadReportPdf);

document.querySelectorAll("[data-preset]").forEach((btn) => {
    btn.addEventListener("click", () => setReportPreset(btn.dataset.preset));
});

function filterTable() {
    const search = $("#search-input").value.toLowerCase();
    const status = $("#status-filter").value;
    const filtered = allEmployees.filter((emp) => {
        const matchSearch =
            emp.employeeName.toLowerCase().includes(search) ||
            emp.employeeNumber.toLowerCase().includes(search) ||
            (emp.department || "").toLowerCase().includes(search);
        const matchStatus = !status || emp.currentStatus === status;
        return matchSearch && matchStatus;
    });
    renderTable(filtered);
}

function renderNotifications(notifications) {
    const list = $("#notifications-list");
    if (!notifications.length) {
        list.innerHTML = "<li>No new notifications</li>";
        return;
    }
    list.innerHTML = notifications.map((n) => `
        <li>
            <strong>${n.notificationType}</strong>
            ${n.message}
            <small>${new Date(n.createdAt).toLocaleString()}</small>
        </li>
    `).join("");
}

function renderSystemHealth(health) {
    $("#system-status").innerHTML = Object.entries(health).map(([key, val]) => `
        <div class="health-item">
            <span>${key.charAt(0).toUpperCase() + key.slice(1)}</span>
            <span class="health-${val}">${val}</span>
        </div>
    `).join("");
}

function renderWebhooks(webhooks) {
    const list = $("#webhooks-list");
    const hint = $("#webhook-last-received");

    const real = (webhooks || []).filter((w) => {
        try {
            const p = JSON.parse(w.requestPayload || "{}");
            return p.device_id !== "local-test" && p.device_id !== "manual-test";
        } catch {
            return true;
        }
    });

    if (hint) {
        if (!webhooks?.length) {
            hint.className = "webhook-hint warn";
            hint.textContent =
                "Событий от считывателя нет. Дверь открывается, но Legacy Reader не шлёт webhook на этот ПК.";
        } else if (!real.length) {
            hint.className = "webhook-hint warn";
            hint.textContent =
                "Только тесты с ПК. Скан у двери не доходит — настройте webhook в Legacy Reader.";
        } else {
            const last = new Date(real[0].requestTime);
            hint.className = "webhook-hint ok";
            hint.textContent = `Последний скан у двери: ${last.toLocaleString()}`;
        }
    }

    if (!webhooks?.length) {
        list.innerHTML = "<li>Нет событий. Приложите карту к считывателю у двери — здесь должна появиться строка SUCCESS.</li>";
        return;
    }
    list.innerHTML = webhooks.map((w) => {
        let decision = "";
        let action = w.errorMessage?.startsWith("→") ? w.errorMessage : "";
        try {
            const p = JSON.parse(w.requestPayload || "{}");
            decision = p.decision ? ` · ${p.decision}` : "";
        } catch { /* ignore */ }
        return `
        <li>
            <strong>${w.processingStatus}</strong>
            ${w.employeeIdentifier || "—"}${decision}${action ? ` ${action}` : ""} · ${w.processingTimeMs}ms
            <small>${new Date(w.requestTime).toLocaleString()}</small>
        </li>
    `;
    }).join("");
}

async function openEmployeeDrawer(employeeId) {
    const data = await apiFetch(`/employees/${employeeId}`);
    if (!data.success) return;

    const { employee, session, events, intervals, gmail } = data.data;
    const sessionEnd = session
        ? session.currentStatus === "INSIDE_OFFICE"
            ? new Date()
            : new Date(session.lastExit || session.lastActivity || session.scheduledEnd)
        : null;
    const scheduledEnd = session ? new Date(session.scheduledEnd) : null;
    const overtimeMinutes =
        sessionEnd && scheduledEnd
            ? Math.max(0, Math.floor((sessionEnd - scheduledEnd) / 60000))
            : 0;
    const rawOutsideMinutes = (intervals || []).reduce((sum, interval) => {
        const end = interval.endTime ? new Date(interval.endTime) : new Date();
        return sum + Math.max(0, Math.floor((end - new Date(interval.startTime)) / 60000));
    }, 0);
    $("#drawer-title").textContent = `${employee.firstName} ${employee.lastName}`;
    $("#drawer-content").innerHTML = `
        <div class="drawer-section">
            <h4>Employee Info</h4>
            <div class="info-grid">
                <div>Department: ${employee.department || "—"}</div>
                <div>Position: ${employee.position || "—"}</div>
                <div>Card: ${employee.cardNumber}</div>
            </div>
        </div>
        ${gmail ? `
        <div class="drawer-section">
            <h4>Gmail</h4>
            <div class="info-grid">
                <div>Email: ${gmail.gmailAddress || "—"}</div>
                <div>Status: ${gmail.status === "CONNECTED" ? "Connected" : gmail.status === "RECONNECT_REQUIRED" ? "Reconnect required" : "Not connected"}</div>
                <div>Last Sync: ${gmail.lastSyncAt ? new Date(gmail.lastSyncAt).toLocaleString() : "—"}</div>
                ${gmail.lastError ? `<div>Error: ${gmail.lastError}</div>` : ""}
            </div>
            <p style="margin-top:0.75rem">The broker can connect, reconnect, or disconnect Gmail from their Personal Dashboard.</p>
        </div>` : ""}
        ${session ? `
        <div class="drawer-section">
            <h4>Today's Session</h4>
            <div class="info-grid">
                <div>Status: ${statusLabel(session.currentStatus)}</div>
                <div>First Entry: ${session.firstEntry ? new Date(session.firstEntry).toLocaleString() : "—"}</div>
                <div>OutTime In Office: ${overtimeMinutes ? formatDuration(overtimeMinutes) : "—"}</div>
                <div>Total Outside: ${formatDuration(Math.max(0, rawOutsideMinutes - 60))}</div>
                <div>Exits: ${session.exitCount}</div>
            </div>
        </div>` : "<p>No session today</p>"}
        <div class="drawer-section">
            <h4>Timeline</h4>
            <ul class="timeline">
                ${events.map((e) => `
                    <li>
                        <span class="time">${new Date(e.eventTime).toLocaleString()}</span>
                        <span class="dir-${e.direction}">${e.direction}</span>
                        <span>${e.deviceId} · ${e.eventType}</span>
                    </li>
                `).join("") || "<li>No events</li>"}
            </ul>
        </div>
        <div class="drawer-section">
            <h4>Absence Intervals</h4>
            <ul class="timeline">
                ${intervals.map((i) => `
                    <li>
                        <span class="time">${new Date(i.startTime).toLocaleTimeString()} → ${i.endTime ? new Date(i.endTime).toLocaleTimeString() : "ongoing"}</span>
                        <span>${i.durationMinutes != null ? formatDuration(i.durationMinutes) : "..."}</span>
                    </li>
                `).join("") || "<li>No absences</li>"}
            </ul>
        </div>
    `;
    $("#employee-drawer").classList.remove("hidden");
}

/* ========== ADMIN ========== */

async function loadAdminEmployees() {
    const data = await apiFetch("/employees?all=true");
    if (!data.success) return;
    adminEmployees = data.data;
    renderAdminTable();
}

function renderAdminTable() {
    const tbody = $("#admin-employees-body");
    tbody.innerHTML = adminEmployees.map((emp) => `
        <tr>
            <td>${emp.firstName} ${emp.lastName}</td>
            <td>${emp.employeeNumber}</td>
            <td><code>${emp.cardNumber}</code></td>
            <td class="status-${emp.status.toLowerCase()}">${emp.status}</td>
            <td class="action-btns">
                <button data-action="test-scan" data-id="${emp.employeeId}" class="btn-test">Test Entry</button>
                <button data-action="edit" data-id="${emp.employeeId}">Edit</button>
                <button data-action="sync" data-id="${emp.employeeId}">Sync</button>
                <button data-action="mark-left" data-id="${emp.employeeId}">Mark Left</button>
                ${emp.status === "ACTIVE" ? `<button data-action="deactivate" data-id="${emp.employeeId}">Deactivate</button>` : ""}
                <button data-action="delete" data-id="${emp.employeeId}" class="btn-danger-text">Delete</button>
            </td>
        </tr>
    `).join("");

    tbody.querySelectorAll("button").forEach((btn) => {
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            const id = btn.dataset.id;
            if (btn.dataset.action === "edit") openEmployeeModal(id);
            if (btn.dataset.action === "test-scan") testEmployeeScan(id);
            if (btn.dataset.action === "sync") syncOneEmployee(id);
            if (btn.dataset.action === "mark-left") markEmployeeLeft(id);
            if (btn.dataset.action === "deactivate") deactivateEmployee(id);
            if (btn.dataset.action === "delete") deleteEmployee(id);
        });
    });
}

function setSyncStatus(el, message, ok) {
    el.textContent = message;
    el.className = "sync-status " + (ok === null ? "info" : ok ? "ok" : "err");
}

let cardScanPollTimer = null;

async function loadPendingScans() {
    try {
        const data = await apiFetch("/card-registration/pending");
        if (!data.success) return [];
        const list = $("#pending-scans-list");
        if (!data.data.length) {
            list.innerHTML = "";
            return [];
        }
        list.innerHTML = data.data.map((s) => `
            <li>
                <span><code>${s.cardToken}</code> · ${new Date(s.scannedAt).toLocaleString()}</span>
                <button type="button" data-token="${s.cardToken}">Register</button>
            </li>
        `).join("");
        list.querySelectorAll("button").forEach((btn) => {
            btn.addEventListener("click", () => {
                openEmployeeModal(null, btn.dataset.token);
            });
        });
        return data.data;
    } catch {
        return [];
    }
}

function openModalWithDetectedCard(cardToken, statusEl) {
    const box = $("#card-scan-box");
    box.classList.remove("waiting");
    box.classList.add("detected");
    if (statusEl) {
        statusEl.textContent = `Карта обнаружена: ${cardToken}`;
    }
    openEmployeeModal(null, cardToken);
}

$("#start-card-scan-btn").addEventListener("click", async () => {
    if (cardScanPollTimer) {
        clearInterval(cardScanPollTimer);
        cardScanPollTimer = null;
    }

    const pending = await loadPendingScans();
    const status = $("#card-scan-status");
    const box = $("#card-scan-box");

    if (pending.length > 0) {
        const latest = pending[0];
        openModalWithDetectedCard(latest.cardToken, status);
        return;
    }

    const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    box.classList.add("waiting");
    box.classList.remove("detected");
    status.textContent = "Ожидание скана… Приложите карту к считывателю (до 2 мин). Если карта не появится — используйте форму ниже.";

    let attempts = 0;
    cardScanPollTimer = setInterval(async () => {
        attempts++;
        if (attempts > 60) {
            clearInterval(cardScanPollTimer);
            cardScanPollTimer = null;
            box.classList.remove("waiting");
            status.textContent = "Скан не получен. Введите UID карты вручную в форму «Быстрая регистрация» или настройте webhook на считывателе.";
            return;
        }
        try {
            const data = await apiFetch(`/card-registration/poll?since=${encodeURIComponent(since)}`);
            if (data.success && data.data) {
                clearInterval(cardScanPollTimer);
                cardScanPollTimer = null;
                openModalWithDetectedCard(data.data.cardToken, status);
                loadPendingScans();
            }
        } catch { /* keep polling */ }
    }, 2000);
});

$("#quick-register-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const statusEl = $("#quick-register-status");
    const cardNumber = normalizeCardInput($("#quick-card").value);
    const firstName = $("#quick-first").value.trim();
    const lastName = $("#quick-last").value.trim();

    if (!cardNumber) {
        setSyncStatus(statusEl, "Введите UID или нажмите «Сгенерировать временный UID»", false);
        return;
    }

    await loadAdminEmployees();
    const dupMsg = validateUniqueCard(cardNumber);
    if (dupMsg) {
        setSyncStatus(statusEl, dupMsg, false);
        alert(dupMsg);
        return;
    }
    const payload = {
        employeeNumber: suggestEmployeeNumber(),
        firstName,
        lastName,
        cardNumber,
        syncToDevice: false,
    };

    setSyncStatus(statusEl, "Saving...", true);
    try {
        const data = await apiFetch("/employees", { method: "POST", body: JSON.stringify(payload) });
        if (!data.success) {
            setSyncStatus(statusEl, data.message || "Ошибка регистрации", false);
            alert(data.message || "Ошибка регистрации");
            return;
        }
        setSyncStatus(statusEl, `Зарегистрировано: ${firstName} ${lastName} — карта ${cardNumber}. Нажмите Test Entry для проверки входа.`, true);
        $("#quick-register-form").reset();
        await loadAdminEmployees();
        await loadPendingScans();
    } catch (err) {
        const msg = err.message || "Connection error";
        setSyncStatus(statusEl, msg, false);
        alert(msg);
    }
});

async function openEmployeeModal(employeeId = null, prefilledCard = null) {
    if (!employeeId) {
        await loadAdminEmployees();
    }
    $("#modal-status").textContent = "";
    $("#emp-id").value = employeeId || "";
    $("#modal-title").textContent = employeeId ? "Edit Employee" : "Add Employee";

    if (employeeId) {
        const emp = adminEmployees.find((e) => e.employeeId === employeeId);
        if (emp) {
            $("#emp-number").value = emp.employeeNumber;
            $("#emp-first").value = emp.firstName;
            $("#emp-last").value = emp.lastName;
            $("#emp-dept").value = emp.department || "";
            $("#emp-position").value = emp.position || "";
            $("#emp-card").value = emp.cardNumber;
            $("#emp-extref").value = emp.externalRef || "";
            $("#emp-cardtype").value = String(emp.cardType || 2);
            $("#emp-status").value = emp.status;
        }
    } else {
        $("#employee-form").reset();
        $("#emp-sync").checked = false;
        $("#emp-number").value = suggestEmployeeNumber();
        if (prefilledCard) {
            $("#emp-card").value = normalizeCardInput(prefilledCard);
        }
    }

    $("#employee-modal").classList.remove("hidden");
}

$("#add-employee-btn").addEventListener("click", () => openEmployeeModal());
$("#close-modal").addEventListener("click", () => $("#employee-modal").classList.add("hidden"));
$("#cancel-modal").addEventListener("click", () => $("#employee-modal").classList.add("hidden"));

$("#employee-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = $("#emp-id").value;
    const payload = {
        employeeNumber: $("#emp-number").value.trim(),
        firstName: $("#emp-first").value.trim(),
        lastName: $("#emp-last").value.trim(),
        department: $("#emp-dept").value.trim() || undefined,
        position: $("#emp-position").value.trim() || undefined,
        cardNumber: normalizeCardInput($("#emp-card").value),
        externalRef: $("#emp-extref").value.trim() || undefined,
        cardType: parseInt($("#emp-cardtype").value, 10),
        status: $("#emp-status").value,
        syncToDevice: $("#emp-sync").checked,
    };

    if (!payload.cardNumber) {
        alert("Введите уникальный код карты");
        return;
    }

    const dupMsg = validateUniqueCard(payload.cardNumber, id || null);
    if (dupMsg) {
        alert(dupMsg);
        setSyncStatus($("#modal-status"), dupMsg, false);
        return;
    }

    try {
        const data = id
            ? await apiFetch(`/employees/${id}`, { method: "PUT", body: JSON.stringify(payload) })
            : await apiFetch("/employees", { method: "POST", body: JSON.stringify(payload) });

        if (!data.success) {
            setSyncStatus($("#modal-status"), data.message || "Save failed", false);
            alert(data.message || "Save failed");
            return;
        }

        let msg = id ? "Employee updated" : "Employee created";
        if (data.data.syncReport) {
            msg += " — " + data.data.syncReport.message;
        }
        setSyncStatus($("#modal-status"), msg, data.data.syncReport?.success !== false);
        await loadAdminEmployees();
        setTimeout(() => $("#employee-modal").classList.add("hidden"), 1200);
    } catch (err) {
        setSyncStatus($("#modal-status"), "Error saving employee", false);
    }
});

async function syncOneEmployee(id) {
    setSyncStatus($("#admin-sync-status"), "Syncing...", true);
    try {
        const data = await apiFetch(`/employees/${id}/sync`, { method: "POST" });
        const optional = data.message?.includes("not configured");
        setSyncStatus(
            $("#admin-sync-status"),
            optional
                ? "Sync пропущен: Legacy API не настроен (это нормально для учёта входа/выхода)"
                : data.message,
            optional ? null : data.success
        );
    } catch {
        setSyncStatus($("#admin-sync-status"), "Sync failed", false);
    }
}

async function testEmployeeScan(id) {
    const emp = adminEmployees.find((e) => e.employeeId === id);
    const name = emp ? `${emp.firstName} ${emp.lastName}` : "employee";
    setSyncStatus($("#admin-sync-status"), `Testing entry for ${name}...`, true);
    try {
        const data = await apiFetch(`/employees/${id}/test-scan`, { method: "POST" });
        setSyncStatus($("#admin-sync-status"), data.message || "Test done", data.success);
        if (data.success) {
            alert(
                `Тест прошёл!\nКарта: ${data.data.cardNumber}\nСтатус: ${data.data.currentStatus}\n\nОткройте Dashboard — должно быть In Office.\n\nЕсли тест работает, а дверной считыватель нет — Legacy Reader не шлёт webhook при проходе.`
            );
            loadDashboard();
        }
    } catch {
        setSyncStatus($("#admin-sync-status"), "Test failed", false);
    }
}

async function markEmployeeLeft(id) {
    const emp = adminEmployees.find((e) => e.employeeId === id);
    const name = emp ? `${emp.firstName} ${emp.lastName}` : "employee";
    if (!confirm(`Mark ${name} as left the office?`)) return;
    try {
        const data = await apiFetch(`/employees/${id}/mark-left`, { method: "POST" });
        setSyncStatus($("#admin-sync-status"), data.message, data.success);
        if (data.success) loadDashboard();
    } catch {
        setSyncStatus($("#admin-sync-status"), "Mark left failed", false);
    }
}

async function deleteEmployee(id) {
    const emp = adminEmployees.find((e) => e.employeeId === id);
    const name = emp ? `${emp.firstName} ${emp.lastName}` : "this employee";
    if (!confirm(`Permanently delete ${name}? This cannot be undone.`)) return;
    try {
        const data = await apiFetch(`/employees/${id}`, { method: "DELETE" });
        setSyncStatus($("#admin-sync-status"), data.message, data.success);
        if (data.success) await loadAdminEmployees();
    } catch {
        setSyncStatus($("#admin-sync-status"), "Delete failed", false);
    }
}

async function deactivateEmployee(id) {
    if (!confirm("Deactivate this employee and revoke card on device?")) return;
    const data = await apiFetch(`/employees/${id}/deactivate`, {
        method: "POST",
        body: JSON.stringify({ syncToDevice: true }),
    });
    setSyncStatus($("#admin-sync-status"), data.message, data.success);
    loadAdminEmployees();
}

$("#sync-all-btn").addEventListener("click", async () => {
    setSyncStatus($("#admin-sync-status"), "Syncing all cards...", true);
    try {
        const data = await apiFetch("/employees/sync-all", { method: "POST" });
        setSyncStatus($("#admin-sync-status"), data.message, data.success);
    } catch {
        setSyncStatus($("#admin-sync-status"), "Sync all failed", false);
    }
});

async function loadSettings() {
    try {
        const data = await apiFetch("/settings");
        if (!data.success) return;
        const s = data.data;
        $("#legacy-api-url").value = s.legacyApiUrl || "";
        $("#legacy-auto-sync").checked = s.legacyAutoSync || false;
    } catch { /* viewer role */ }
}

$("#settings-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const payload = {
        legacyApiUrl: $("#legacy-api-url").value.trim(),
        legacyIngestToken: $("#legacy-ingest-token").value.trim() || undefined,
        legacyAutoSync: $("#legacy-auto-sync").checked,
    };
    try {
        const data = await apiFetch("/settings", { method: "PUT", body: JSON.stringify(payload) });
        setSyncStatus($("#settings-status"), data.success ? "Settings saved" : data.message, data.success);
        $("#legacy-ingest-token").value = "";
    } catch {
        setSyncStatus($("#settings-status"), "Failed to save settings", false);
    }
});

$("#test-legacy-btn").addEventListener("click", async () => {
    setSyncStatus($("#settings-status"), "Testing connection...", true);
    try {
        const res = await fetch(`${API}/settings/test-legacy`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        });
        const data = await res.json();
        setSyncStatus($("#settings-status"), data.message, data.success);
    } catch {
        setSyncStatus($("#settings-status"), "Connection test failed", false);
    }
});

$("#copy-webhook-btn")?.addEventListener("click", async () => {
    const url = $("#setup-webhook-url")?.textContent || "";
    try {
        await navigator.clipboard.writeText(url);
        setSyncStatus($("#setup-status"), "Webhook URL copied", true);
    } catch {
        setSyncStatus($("#setup-status"), "Copy failed — select and copy manually", false);
    }
});

$("#refresh-network-btn")?.addEventListener("click", async () => {
    setSyncStatus($("#setup-status"), "Refreshing...", true);
    await updateWebhookUrlDisplays();
    setSyncStatus($("#setup-status"), "Network info updated", true);
});

$("#test-webhook-local-btn")?.addEventListener("click", async () => {
    const statusEl = $("#setup-status");
    setSyncStatus(statusEl, "Sending test webhook...", true);
    const bearer = $("#setup-webhook-token")?.textContent?.trim() || "";
    const card = adminEmployees[0]?.cardNumber || "tatf";
    try {
        const res = await fetch(`${API}/webhook/attendance`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${bearer}`,
            },
            body: JSON.stringify({
                decision: "enter",
                token: card,
                device_id: "local-test",
                scanned_at: new Date().toISOString(),
            }),
        });
        const data = await res.json();
        if (data.success) {
            setSyncStatus(statusEl, `Test OK — check Dashboard (card ${card})`, true);
            loadDashboard();
        } else {
            setSyncStatus(statusEl, data.message || "Test failed", false);
        }
    } catch (e) {
        setSyncStatus(statusEl, "Test failed — is server running?", false);
    }
});

if (token) {
    apiFetch("/auth/me")
        .then((data) => {
            if (data.success && data.data) showApp(data.data);
            else showLogin();
        })
        .catch(showLogin);
} else {
    showLogin();
}

/**
 * Employees module — platform user accounts + role changes (Broker → Team Lead, etc.).
 */
window.GreenOSModules = window.GreenOSModules || {};
window.GreenOSModules["employees"] = {
  children: [
    { id: "accounts", title: "Platform users" },
    { id: "employees", title: "Badge employees" },
    { id: "departments", title: "Departments" },
    { id: "positions", title: "Positions" },
    { id: "schedules", title: "Schedules" },
    { id: "payroll", title: "Payroll" },
  ],

  render(root, subPageId) {
    if (!root) return;
    var self = this;
    var children = this.children || [];
    var active =
      children.find(function (c) {
        return c.id === subPageId;
      }) || children[0];

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
      '<div class="gos-module-placeholder" data-module="employees">' +
      '<nav class="gos-subnav" aria-label="Employees sections">' +
      navHtml +
      "</nav>" +
      '<div class="gos-module-body" id="employees-body"></div>' +
      "</div>";

    root.querySelectorAll("[data-subpage]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        self.render(root, btn.getAttribute("data-subpage"));
      });
    });

    var body = root.querySelector("#employees-body");
    if (!body) return;

    if (active.id === "accounts") {
      self.renderAccounts(body);
      return;
    }

    if (active.id === "employees") {
      body.innerHTML =
        "<h2>Badge employees</h2>" +
        "<p class=\"gos-muted\">Attendance badge / card records are managed in the Attendance admin area. " +
        "Use <strong>Platform users</strong> here to change Green OS login roles (Broker → Team Lead, etc.).</p>";
      return;
    }

    body.innerHTML =
      "<h2>Employees — " +
      (active.title || "") +
      "</h2><p class=\"gos-muted\">Coming soon</p>";
  },

  async renderAccounts(body) {
    body.innerHTML =
      "<h2>Platform users</h2>" +
      "<p class=\"gos-muted\">After signup approval, each person has a Green OS account. " +
      "Change their <strong>role / status</strong> here (for example Broker → Team Lead). " +
      "They need to sign in again for the new menu to appear.</p>" +
      '<p id="emp-users-status" class="gos-muted">Loading…</p>' +
      '<div class="emp-users-wrap"><table class="emp-users-table" id="emp-users-table">' +
      "<thead><tr>" +
      "<th>Name</th><th>Username</th><th>Email</th><th>Role / status</th><th></th>" +
      "</tr></thead><tbody></tbody></table></div>";

    var statusEl = body.querySelector("#emp-users-status");
    var tbody = body.querySelector("#emp-users-table tbody");

    async function api(path, options) {
      var token = localStorage.getItem("gl_token");
      var res = await fetch("/api/v1" + path, {
        method: (options && options.method) || "GET",
        headers: {
          "Content-Type": "application/json",
          Authorization: token ? "Bearer " + token : "",
        },
        body: options && options.body ? JSON.stringify(options.body) : undefined,
      });
      return res.json();
    }

    function esc(s) {
      return String(s == null ? "" : s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    try {
      var rolesRes = await api("/roles");
      var usersRes = await api("/users");
      if (!rolesRes.success || !usersRes.success) {
        statusEl.textContent = rolesRes.message || usersRes.message || "Failed to load users";
        statusEl.style.color = "#ef4444";
        return;
      }

      var roles = rolesRes.data || [];
      var users = usersRes.data || [];
      statusEl.textContent = users.length + " account(s)";
      statusEl.style.color = "";

      tbody.innerHTML = users
        .map(function (u) {
          var options = roles
            .map(function (r) {
              var selected = r.roleName === u.role ? " selected" : "";
              return (
                '<option value="' +
                esc(r.roleName) +
                '"' +
                selected +
                ">" +
                esc(r.roleName) +
                "</option>"
              );
            })
            .join("");
          // If current role is not in assignable list (e.g. Manager viewing Owner), still show it
          if (
            !roles.some(function (r) {
              return r.roleName === u.role;
            })
          ) {
            options =
              '<option value="' +
              esc(u.role) +
              '" selected>' +
              esc(u.role) +
              "</option>" +
              options;
          }
          return (
            "<tr data-user-id=\"" +
            esc(u.userId) +
            '">' +
            "<td>" +
            esc(u.firstName + " " + u.lastName) +
            (u.isActive ? "" : ' <span class="emp-badge-off">inactive</span>') +
            "</td>" +
            "<td>" +
            esc(u.username) +
            "</td>" +
            "<td>" +
            esc(u.email || "—") +
            "</td>" +
            '<td><select class="emp-role-select" data-prev="' +
            esc(u.role) +
            '">' +
            options +
            "</select></td>" +
            '<td><button type="button" class="btn-primary emp-role-save" style="width:auto;padding:0.4rem 0.75rem">Save</button></td>' +
            "</tr>"
          );
        })
        .join("");

      tbody.querySelectorAll(".emp-role-save").forEach(function (btn) {
        btn.addEventListener("click", async function () {
          var tr = btn.closest("tr");
          if (!tr) return;
          var userId = tr.getAttribute("data-user-id");
          var select = tr.querySelector(".emp-role-select");
          if (!select) return;
          var role = select.value;
          var prev = select.getAttribute("data-prev") || "";
          if (role === prev) {
            statusEl.textContent = "No change";
            return;
          }
          btn.disabled = true;
          statusEl.textContent = "Saving…";
          statusEl.style.color = "";
          try {
            var data = await api("/users/" + encodeURIComponent(userId) + "/role", {
              method: "PATCH",
              body: { role: role },
            });
            if (!data.success) {
              statusEl.textContent = data.message || "Update failed";
              statusEl.style.color = "#ef4444";
              select.value = prev;
              return;
            }
            select.setAttribute("data-prev", role);
            statusEl.textContent = data.message || "Role updated";
            statusEl.style.color = "#22c55e";
          } catch (e) {
            statusEl.textContent = "Connection error";
            statusEl.style.color = "#ef4444";
            select.value = prev;
          } finally {
            btn.disabled = false;
          }
        });
      });
    } catch (e) {
      statusEl.textContent = "Connection error";
      statusEl.style.color = "#ef4444";
    }
  },
};

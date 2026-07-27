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
    var self = this;

    body.innerHTML =
      "<h2>Platform users</h2>" +
      "<p class=\"gos-muted\">After signup approval, each person has a Green OS account. " +
      "Change their <strong>role / status</strong> here (for example Broker → Team Lead). " +
      "They need to sign in again for the new menu to appear.</p>" +
      '<p id="emp-users-status" class="gos-muted">Loading…</p>' +
      '<div class="emp-users-wrap"><table class="emp-users-table" id="emp-users-table">' +
      "<thead><tr>" +
      "<th>Name</th><th>Username</th><th>Email</th><th>Role / status</th><th>Actions</th>" +
      "</tr></thead><tbody></tbody></table></div>";

    var statusEl = body.querySelector("#emp-users-status");
    var tbody = body.querySelector("#emp-users-table tbody");

    async function api(path, options) {
      var token = localStorage.getItem("gl_token");
      var method = (options && options.method) || "GET";
      var res = await fetch("/api/v1" + path, {
        method: method,
        headers: {
          "Content-Type": "application/json",
          Authorization: token ? "Bearer " + token : "",
        },
        body:
          options && options.body !== undefined
            ? JSON.stringify(options.body)
            : undefined,
      });
      var text = await res.text();
      var data;
      try {
        data = text ? JSON.parse(text) : {};
      } catch (e) {
        throw new Error(
          "Server returned non-JSON (" + res.status + "). " + text.slice(0, 120)
        );
      }
      if (!res.ok && data && data.success === undefined) {
        data.success = false;
        data.message = data.message || "HTTP " + res.status;
      }
      return data;
    }

    function esc(s) {
      return String(s == null ? "" : s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    async function loadTable() {
      statusEl.textContent = "Loading…";
      statusEl.style.color = "";
      try {
        var rolesRes = await api("/roles");
        var usersRes = await api("/users");
        if (!rolesRes.success || !usersRes.success) {
          statusEl.textContent =
            rolesRes.message || usersRes.message || "Failed to load users";
          statusEl.style.color = "#ef4444";
          tbody.innerHTML = "";
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
              '<tr data-user-id="' +
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
              '<td class="emp-actions">' +
              '<button type="button" class="btn-primary emp-role-save" style="width:auto;padding:0.4rem 0.75rem">Save</button> ' +
              '<button type="button" class="emp-user-delete" style="width:auto;padding:0.4rem 0.75rem">Delete</button>' +
              "</td>" +
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
            if (!select || !userId) return;
            var role = select.value;
            var prev = select.getAttribute("data-prev") || "";
            if (role === prev) {
              statusEl.textContent = "No change — pick a different role first";
              statusEl.style.color = "#eab308";
              return;
            }
            btn.disabled = true;
            statusEl.textContent = "Saving…";
            statusEl.style.color = "";
            try {
              var data = await api(
                "/users/" + encodeURIComponent(userId) + "/role",
                {
                  method: "PUT",
                  body: { role: role },
                }
              );
              if (!data.success) {
                statusEl.textContent = data.message || "Update failed";
                statusEl.style.color = "#ef4444";
                select.value = prev;
                return;
              }
              statusEl.textContent = data.message || "Role updated";
              statusEl.style.color = "#22c55e";
              await loadTable();
            } catch (e) {
              statusEl.textContent =
                e && e.message ? e.message : "Connection error";
              statusEl.style.color = "#ef4444";
              select.value = prev;
            } finally {
              btn.disabled = false;
            }
          });
        });

        tbody.querySelectorAll(".emp-user-delete").forEach(function (btn) {
          btn.addEventListener("click", async function () {
            var tr = btn.closest("tr");
            if (!tr) return;
            var userId = tr.getAttribute("data-user-id");
            if (!userId) return;
            var name =
              (tr.cells[0] && tr.cells[0].textContent) || "this user";
            var username =
              (tr.cells[1] && tr.cells[1].textContent) || "";
            var ok = window.confirm(
              "Delete " +
                name.trim() +
                " (" +
                username +
                ")?\n\nThis permanently removes the account and related GreenOS data " +
                "(assigned CRM shipments, assignment queue, audit logs, linked attendance badge employee)."
            );
            if (!ok) return;
            btn.disabled = true;
            statusEl.textContent = "Deleting…";
            statusEl.style.color = "";
            try {
              var data = await api("/users/" + encodeURIComponent(userId), {
                method: "DELETE",
              });
              if (!data.success) {
                statusEl.textContent = data.message || "Delete failed";
                statusEl.style.color = "#ef4444";
                btn.disabled = false;
                return;
              }
              statusEl.textContent = data.message || "User deleted";
              statusEl.style.color = "#22c55e";
              await loadTable();
            } catch (e) {
              statusEl.textContent =
                e && e.message ? e.message : "Connection error";
              statusEl.style.color = "#ef4444";
              btn.disabled = false;
            }
          });
        });
      } catch (e) {
        statusEl.textContent =
          e && e.message ? e.message : "Connection error";
        statusEl.style.color = "#ef4444";
        tbody.innerHTML = "";
      }
    }

    await loadTable();
  },
};

/**
 * Employees module — platform user accounts + role changes (Broker → Team Lead, etc.).
 */
window.GreenOSModules = window.GreenOSModules || {};
window.GreenOSModules["employees"] = {
  children: [
    { id: "accounts", title: "Platform users" },
    { id: "pending", title: "Pending approve" },
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

    if (active.id === "pending") {
      self.renderPending(body);
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

  empApi(path, options) {
    var token = localStorage.getItem("gl_token");
    var method = (options && options.method) || "GET";
    return fetch("/api/v1" + path, {
      method: method,
      headers: {
        "Content-Type": "application/json",
        Authorization: token ? "Bearer " + token : "",
      },
      body:
        options && options.body !== undefined
          ? JSON.stringify(options.body)
          : undefined,
    }).then(function (res) {
      return res.text().then(function (text) {
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
      });
    });
  },

  empEsc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  },

  async renderPending(body) {
    var self = this;
    var api = function (path, options) {
      return self.empApi(path, options);
    };
    var esc = function (s) {
      return self.empEsc(s);
    };

    body.innerHTML =
      "<h2>Pending approve</h2>" +
      "<p class=\"gos-muted\">People who signed up and are waiting for confirmation. " +
      "<strong>Approve</strong> creates their Green OS login. <strong>Delete</strong> removes the request.</p>" +
      '<p id="emp-pending-status" class="gos-muted">Loading…</p>' +
      '<div class="emp-users-wrap"><table class="emp-users-table" id="emp-pending-table">' +
      "<thead><tr>" +
      "<th>Name</th><th>Username</th><th>Email</th><th>Role</th><th>Team Lead</th><th>Requested</th><th>Actions</th>" +
      "</tr></thead><tbody></tbody></table></div>";

    var statusEl = body.querySelector("#emp-pending-status");
    var tbody = body.querySelector("#emp-pending-table tbody");

    function formatWhen(iso) {
      if (!iso) return "—";
      try {
        var d = new Date(iso);
        if (isNaN(d.getTime())) return String(iso);
        return d.toLocaleString();
      } catch (e) {
        return String(iso);
      }
    }

    async function loadTable() {
      statusEl.textContent = "Loading…";
      statusEl.style.color = "";
      try {
        var res = await api("/auth/registrations/pending");
        if (!res.success) {
          statusEl.textContent = res.message || "Failed to load pending requests";
          statusEl.style.color = "#ef4444";
          tbody.innerHTML = "";
          return;
        }
        var rows = res.data || [];
        statusEl.textContent =
          rows.length === 0
            ? "No pending requests"
            : rows.length + " waiting for approval";
        statusEl.style.color = rows.length ? "#eab308" : "";

        tbody.innerHTML = rows
          .map(function (r) {
            return (
              '<tr data-pending-id="' +
              esc(r.pendingId) +
              '">' +
              "<td>" +
              esc(r.firstName + " " + r.lastName) +
              "</td>" +
              "<td>" +
              esc(r.username) +
              "</td>" +
              "<td>" +
              esc(r.email || "—") +
              "</td>" +
              "<td>" +
              esc(r.requestedRole) +
              "</td>" +
              "<td>" +
              esc(
                r.requestedTeamLeadName ||
                  (r.requestedRole === "Broker" ? "—" : "n/a")
              ) +
              "</td>" +
              "<td>" +
              esc(formatWhen(r.createdAt)) +
              "</td>" +
              '<td class="emp-actions">' +
              '<button type="button" class="btn-primary emp-pending-approve" style="width:auto;padding:0.4rem 0.75rem">Approve</button> ' +
              '<button type="button" class="emp-pending-delete" style="width:auto;padding:0.4rem 0.75rem">Delete</button>' +
              "</td>" +
              "</tr>"
            );
          })
          .join("");

        tbody.querySelectorAll(".emp-pending-approve").forEach(function (btn) {
          btn.addEventListener("click", async function () {
            var tr = btn.closest("tr");
            if (!tr) return;
            var pendingId = tr.getAttribute("data-pending-id");
            if (!pendingId) return;
            var name =
              (tr.cells[0] && tr.cells[0].textContent) || "this person";
            var ok = window.confirm(
              "Approve " +
                name.trim() +
                "?\n\nThey will be able to sign in with the password they chose at signup."
            );
            if (!ok) return;
            btn.disabled = true;
            statusEl.textContent = "Approving…";
            statusEl.style.color = "";
            try {
              var data = await api(
                "/auth/registrations/" +
                  encodeURIComponent(pendingId) +
                  "/approve",
                { method: "POST" }
              );
              if (!data.success) {
                statusEl.textContent = data.message || "Approve failed";
                statusEl.style.color = "#ef4444";
                btn.disabled = false;
                return;
              }
              statusEl.textContent = data.message || "Approved";
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

        tbody.querySelectorAll(".emp-pending-delete").forEach(function (btn) {
          btn.addEventListener("click", async function () {
            var tr = btn.closest("tr");
            if (!tr) return;
            var pendingId = tr.getAttribute("data-pending-id");
            if (!pendingId) return;
            var name =
              (tr.cells[0] && tr.cells[0].textContent) || "this request";
            var username =
              (tr.cells[1] && tr.cells[1].textContent) || "";
            var ok = window.confirm(
              "Delete pending request for " +
                name.trim() +
                " (" +
                username +
                ")?\n\nThey will need to sign up again."
            );
            if (!ok) return;
            btn.disabled = true;
            statusEl.textContent = "Deleting…";
            statusEl.style.color = "";
            try {
              var data = await api(
                "/auth/registrations/" + encodeURIComponent(pendingId),
                { method: "DELETE" }
              );
              if (!data.success) {
                statusEl.textContent = data.message || "Delete failed";
                statusEl.style.color = "#ef4444";
                btn.disabled = false;
                return;
              }
              statusEl.textContent = data.message || "Deleted";
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

  async renderAccounts(body) {
    var self = this;

    body.innerHTML =
      "<h2>Platform users</h2>" +
      "<p class=\"gos-muted\">After signup approval, each person has a Green OS account. " +
      "Change their <strong>role</strong> and assign Brokers to a <strong>Team Lead</strong> (Gary or Alen). " +
      "Gary sees only his brokers; Alen sees only his. Users need to sign in again after a role change.</p>" +
      '<p id="emp-users-status" class="gos-muted">Loading…</p>' +
      '<div class="emp-users-wrap"><table class="emp-users-table" id="emp-users-table">' +
      "<thead><tr>" +
      "<th>Name</th><th>Username</th><th>Email</th><th>Role / status</th><th>Team Lead</th><th>Actions</th>" +
      "</tr></thead><tbody></tbody></table></div>";

    var statusEl = body.querySelector("#emp-users-status");
    var tbody = body.querySelector("#emp-users-table tbody");

    async function api(path, options) {
      return self.empApi(path, options);
    }

    function esc(s) {
      return self.empEsc(s);
    }

    function teamLeadOptionsHtml(teamLeads, selectedId, enabled) {
      var opts =
        '<option value="">' +
        (enabled ? "Select Gary or Alen…" : "—") +
        "</option>";
      (teamLeads || []).forEach(function (tl) {
        var selected = tl.userId === selectedId ? " selected" : "";
        opts +=
          '<option value="' +
          esc(tl.userId) +
          '"' +
          selected +
          ">" +
          esc(tl.name) +
          "</option>";
      });
      return (
        '<select class="emp-team-lead-select"' +
        (enabled ? "" : " disabled") +
        ' data-prev="' +
        esc(selectedId || "") +
        '">' +
        opts +
        "</select>"
      );
    }

    async function loadTable() {
      statusEl.textContent = "Loading…";
      statusEl.style.color = "";
      try {
        var rolesRes = await api("/roles");
        var usersRes = await api("/users");
        var leadsRes = await api("/auth/team-leads");
        if (!rolesRes.success || !usersRes.success) {
          statusEl.textContent =
            rolesRes.message || usersRes.message || "Failed to load users";
          statusEl.style.color = "#ef4444";
          tbody.innerHTML = "";
          return;
        }

        var roles = rolesRes.data || [];
        var users = usersRes.data || [];
        var teamLeads = (leadsRes && leadsRes.success && leadsRes.data) || [];
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
            var isBroker = u.role === "Broker";
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
              "<td>" +
              teamLeadOptionsHtml(teamLeads, u.teamLeadId || "", isBroker) +
              "</td>" +
              '<td class="emp-actions">' +
              '<button type="button" class="btn-primary emp-role-save" style="width:auto;padding:0.4rem 0.75rem">Save</button> ' +
              '<button type="button" class="emp-user-delete" style="width:auto;padding:0.4rem 0.75rem">Delete</button>' +
              "</td>" +
              "</tr>"
            );
          })
          .join("");

        tbody.querySelectorAll(".emp-role-select").forEach(function (select) {
          select.addEventListener("change", function () {
            var tr = select.closest("tr");
            if (!tr) return;
            var tl = tr.querySelector(".emp-team-lead-select");
            if (!tl) return;
            var broker = select.value === "Broker";
            tl.disabled = !broker;
            if (!broker) tl.value = "";
          });
        });

        tbody.querySelectorAll(".emp-role-save").forEach(function (btn) {
          btn.addEventListener("click", async function () {
            var tr = btn.closest("tr");
            if (!tr) return;
            var userId = tr.getAttribute("data-user-id");
            var roleSelect = tr.querySelector(".emp-role-select");
            var tlSelect = tr.querySelector(".emp-team-lead-select");
            if (!roleSelect || !userId) return;

            var role = roleSelect.value;
            var prevRole = roleSelect.getAttribute("data-prev") || "";
            var teamLeadId = tlSelect ? tlSelect.value || null : null;
            var prevTl = tlSelect ? tlSelect.getAttribute("data-prev") || "" : "";
            var roleChanged = role !== prevRole;
            var tlChanged =
              role === "Broker"
                ? String(teamLeadId || "") !== String(prevTl || "")
                : String(prevTl || "") !== "";

            if (!roleChanged && !tlChanged) {
              statusEl.textContent = "No change — update role or Team Lead first";
              statusEl.style.color = "#eab308";
              return;
            }
            if (role === "Broker" && !teamLeadId) {
              statusEl.textContent = "Select Team Lead (Gary or Alen) for this Broker";
              statusEl.style.color = "#ef4444";
              return;
            }

            btn.disabled = true;
            statusEl.textContent = "Saving…";
            statusEl.style.color = "";
            try {
              if (roleChanged) {
                var roleData = await api(
                  "/users/" + encodeURIComponent(userId) + "/role",
                  {
                    method: "PUT",
                    body: { role: role },
                  }
                );
                if (!roleData.success) {
                  statusEl.textContent = roleData.message || "Role update failed";
                  statusEl.style.color = "#ef4444";
                  roleSelect.value = prevRole;
                  return;
                }
              }

              if (role === "Broker" || tlChanged) {
                var tlPayload = role === "Broker" ? teamLeadId : null;
                var tlData = await api(
                  "/users/" + encodeURIComponent(userId) + "/team-lead",
                  {
                    method: "PATCH",
                    body: { teamLeadId: tlPayload },
                  }
                );
                if (!tlData.success) {
                  statusEl.textContent = tlData.message || "Team Lead update failed";
                  statusEl.style.color = "#ef4444";
                  return;
                }
              }

              statusEl.textContent =
                role === "Broker"
                  ? "Saved — broker assigned to selected Team Lead"
                  : "Saved";
              statusEl.style.color = "#22c55e";
              await loadTable();
            } catch (e) {
              statusEl.textContent =
                e && e.message ? e.message : "Connection error";
              statusEl.style.color = "#ef4444";
              roleSelect.value = prevRole;
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

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
      "For Brokers, choose any <strong>Team Lead</strong> (or someone to promote), then <strong>Approve</strong>. " +
      "<strong>Delete</strong> removes the request.</p>" +
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

    function teamLeadSelectHtml(teamLeads, selectedId, isBroker) {
      if (!isBroker) {
        return '<span class="gos-muted">n/a</span>';
      }
      var opts = '<option value="">Select Team Lead…</option>';
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
        '<select class="emp-team-lead-select emp-pending-team-lead">' +
        opts +
        "</select>"
      );
    }

    async function loadTable() {
      statusEl.textContent = "Loading…";
      statusEl.style.color = "";
      try {
        var res = await api("/auth/registrations/pending");
        var leadsRes = await api("/auth/team-leads");
        if (!res.success) {
          statusEl.textContent = res.message || "Failed to load pending requests";
          statusEl.style.color = "#ef4444";
          tbody.innerHTML = "";
          return;
        }
        var rows = res.data || [];
        var teamLeads = (leadsRes && leadsRes.success && leadsRes.data) || [];
        statusEl.textContent =
          rows.length === 0
            ? "No pending requests"
            : rows.length + " waiting for approval";
        statusEl.style.color = rows.length ? "#eab308" : "";

        tbody.innerHTML = rows
          .map(function (r) {
            var isBroker = r.requestedRole === "Broker";
            return (
              '<tr data-pending-id="' +
              esc(r.pendingId) +
              '" data-role="' +
              esc(r.requestedRole) +
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
              teamLeadSelectHtml(teamLeads, r.requestedTeamLeadId || "", isBroker) +
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

        tbody.querySelectorAll(".emp-pending-team-lead").forEach(function (select) {
          select.addEventListener("change", async function () {
            var tr = select.closest("tr");
            if (!tr) return;
            var pendingId = tr.getAttribute("data-pending-id");
            var teamLeadId = select.value || "";
            if (!pendingId || !teamLeadId) return;
            statusEl.textContent = "Saving Team Lead…";
            statusEl.style.color = "";
            try {
              var data = await api(
                "/auth/registrations/" +
                  encodeURIComponent(pendingId) +
                  "/team-lead",
                { method: "PATCH", body: { teamLeadId: teamLeadId } }
              );
              if (!data.success) {
                statusEl.textContent = data.message || "Failed to set Team Lead";
                statusEl.style.color = "#ef4444";
                return;
              }
              statusEl.textContent = data.message || "Team Lead saved";
              statusEl.style.color = "#22c55e";
            } catch (e) {
              statusEl.textContent =
                e && e.message ? e.message : "Connection error";
              statusEl.style.color = "#ef4444";
            }
          });
        });

        tbody.querySelectorAll(".emp-pending-approve").forEach(function (btn) {
          btn.addEventListener("click", async function () {
            var tr = btn.closest("tr");
            if (!tr) return;
            var pendingId = tr.getAttribute("data-pending-id");
            if (!pendingId) return;
            var role = tr.getAttribute("data-role") || "";
            var tlSelect = tr.querySelector(".emp-pending-team-lead");
            var teamLeadId = tlSelect ? tlSelect.value || null : null;
            if (role === "Broker" && !teamLeadId) {
              statusEl.textContent =
                "Select a Team Lead before approving this Broker";
              statusEl.style.color = "#ef4444";
              return;
            }
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
              var body =
                role === "Broker" ? { teamLeadId: teamLeadId } : {};
              var data = await api(
                "/auth/registrations/" +
                  encodeURIComponent(pendingId) +
                  "/approve",
                { method: "POST", body: body }
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
      "Assign Brokers to any <strong>Team Lead</strong> (any employee can be promoted to that role). " +
      "Each Team Lead sees only their brokers. If you remove Team Lead role from someone who has brokers, " +
      "pick who takes the team — brokers and notifications move automatically. Users must sign in again after a role change.</p>" +
      '<p id="emp-users-status" class="gos-muted">Loading…</p>' +
      '<div class="emp-users-wrap"><table class="emp-users-table" id="emp-users-table">' +
      "<thead><tr>" +
      "<th>Name</th><th>Username</th><th>Email</th><th>Role / status</th><th>Team Lead / transfer</th><th>Actions</th>" +
      "</tr></thead><tbody></tbody></table></div>";

    var statusEl = body.querySelector("#emp-users-status");
    var tbody = body.querySelector("#emp-users-table tbody");

    async function api(path, options) {
      return self.empApi(path, options);
    }

    function esc(s) {
      return self.empEsc(s);
    }

    function teamLeadOptionsHtml(teamLeads, selectedId, enabled, excludeUserId) {
      var opts =
        '<option value="">' +
        (enabled ? "Select any person as Team Lead…" : "—") +
        "</option>";
      (teamLeads || []).forEach(function (tl) {
        if (excludeUserId && tl.userId === excludeUserId) return;
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

    function transferOptionsHtml(teamLeads, excludeUserId) {
      var opts = '<option value="">Transfer team to… (required if leaving Team Lead)</option>';
      (teamLeads || []).forEach(function (tl) {
        if (excludeUserId && tl.userId === excludeUserId) return;
        opts +=
          '<option value="' +
          esc(tl.userId) +
          '">' +
          esc(tl.name) +
          "</option>";
      });
      return (
        '<select class="emp-transfer-team-select" style="margin-top:0.35rem;display:none">' +
        opts +
        "</select>"
      );
    }

    function takeOverOptionsHtml(users, excludeUserId) {
      var tls = (users || []).filter(function (u) {
        return u.role === "Team Lead" && u.userId !== excludeUserId;
      });
      var opts = '<option value="">Optional: take over team from…</option>';
      tls.forEach(function (tl) {
        opts +=
          '<option value="' +
          esc(tl.userId) +
          '">' +
          esc((tl.firstName + " " + tl.lastName).trim() || tl.username) +
          "</option>";
      });
      return (
        '<select class="emp-takeover-select" style="margin-top:0.35rem;display:none">' +
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
            var isTeamLead = u.role === "Team Lead";
            return (
              '<tr data-user-id="' +
              esc(u.userId) +
              '" data-prev-role="' +
              esc(u.role) +
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
              "</select>" +
              takeOverOptionsHtml(users, u.userId) +
              "</td>" +
              "<td>" +
              teamLeadOptionsHtml(teamLeads, u.teamLeadId || "", isBroker, u.userId) +
              transferOptionsHtml(teamLeads, u.userId) +
              (isTeamLead
                ? '<div class="gos-muted" style="font-size:0.8rem;margin-top:0.25rem">Team Lead — use transfer if changing role</div>'
                : "") +
              "</td>" +
              '<td class="emp-actions">' +
              '<button type="button" class="btn-primary emp-role-save" style="width:auto;padding:0.4rem 0.75rem">Save</button> ' +
              '<button type="button" class="emp-user-delete" style="width:auto;padding:0.4rem 0.75rem">Delete</button>' +
              "</td>" +
              "</tr>"
            );
          })
          .join("");

        function syncRowControls(tr) {
          if (!tr) return;
          var roleSelect = tr.querySelector(".emp-role-select");
          var tl = tr.querySelector(".emp-team-lead-select");
          var transfer = tr.querySelector(".emp-transfer-team-select");
          var takeover = tr.querySelector(".emp-takeover-select");
          if (!roleSelect) return;
          var role = roleSelect.value;
          var prev = roleSelect.getAttribute("data-prev") || "";
          if (tl) {
            tl.disabled = role !== "Broker";
            if (role !== "Broker") tl.value = "";
          }
          if (transfer) {
            var showTransfer = prev === "Team Lead" && role !== "Team Lead";
            transfer.style.display = showTransfer ? "block" : "none";
            if (!showTransfer) transfer.value = "";
          }
          if (takeover) {
            var showTakeover = prev !== "Team Lead" && role === "Team Lead";
            takeover.style.display = showTakeover ? "block" : "none";
            if (!showTakeover) takeover.value = "";
          }
        }

        tbody.querySelectorAll(".emp-role-select").forEach(function (select) {
          select.addEventListener("change", function () {
            syncRowControls(select.closest("tr"));
          });
          syncRowControls(select.closest("tr"));
        });

        tbody.querySelectorAll(".emp-role-save").forEach(function (btn) {
          btn.addEventListener("click", async function () {
            var tr = btn.closest("tr");
            if (!tr) return;
            var userId = tr.getAttribute("data-user-id");
            var roleSelect = tr.querySelector(".emp-role-select");
            var tlSelect = tr.querySelector(".emp-team-lead-select");
            var transferSelect = tr.querySelector(".emp-transfer-team-select");
            var takeoverSelect = tr.querySelector(".emp-takeover-select");
            if (!roleSelect || !userId) return;

            var role = roleSelect.value;
            var prevRole = roleSelect.getAttribute("data-prev") || "";
            var teamLeadId = tlSelect ? tlSelect.value || null : null;
            var prevTl = tlSelect ? tlSelect.getAttribute("data-prev") || "" : "";
            var transferTo = transferSelect ? transferSelect.value || null : null;
            var takeOverFrom = takeoverSelect ? takeoverSelect.value || null : null;
            var roleChanged = role !== prevRole;
            var tlChanged =
              role === "Broker"
                ? String(teamLeadId || "") !== String(prevTl || "")
                : String(prevTl || "") !== "";

            if (!roleChanged && !tlChanged && !takeOverFrom) {
              statusEl.textContent = "No change — update role or Team Lead first";
              statusEl.style.color = "#eab308";
              return;
            }
            if (role === "Broker" && !teamLeadId) {
              statusEl.textContent = "Select a Team Lead for this Broker (any employee)";
              statusEl.style.color = "#ef4444";
              return;
            }
            if (prevRole === "Team Lead" && role !== "Team Lead" && !transferTo) {
              statusEl.textContent =
                "Choose who takes this Team Lead's brokers before changing the role";
              statusEl.style.color = "#ef4444";
              if (transferSelect) transferSelect.style.display = "block";
              return;
            }

            btn.disabled = true;
            statusEl.textContent = "Saving…";
            statusEl.style.color = "";
            var savedMessage = "";
            try {
              if (roleChanged || takeOverFrom) {
                var roleBody = { role: role };
                if (prevRole === "Team Lead" && role !== "Team Lead" && transferTo) {
                  roleBody.transferTeamToUserId = transferTo;
                }
                if (role === "Team Lead" && takeOverFrom) {
                  roleBody.takeOverFromUserId = takeOverFrom;
                }
                var roleData = await api(
                  "/users/" + encodeURIComponent(userId) + "/role",
                  {
                    method: "PUT",
                    body: roleBody,
                  }
                );
                if (!roleData.success) {
                  statusEl.textContent = roleData.message || "Role update failed";
                  statusEl.style.color = "#ef4444";
                  roleSelect.value = prevRole;
                  syncRowControls(tr);
                  return;
                }
                savedMessage = roleData.message || "";
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
                if (!savedMessage) {
                  savedMessage =
                    role === "Broker"
                      ? "Saved — broker assigned to selected Team Lead"
                      : "Saved";
                }
              }

              statusEl.textContent = savedMessage || "Saved";
              statusEl.style.color = "#22c55e";
              await loadTable();
            } catch (e) {
              statusEl.textContent =
                e && e.message ? e.message : "Connection error";
              statusEl.style.color = "#ef4444";
              roleSelect.value = prevRole;
              syncRowControls(tr);
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

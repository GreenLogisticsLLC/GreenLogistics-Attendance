/**
 * GreenOS realtime — SSE client for live shipment assignment notifications.
 * Popup toast + optional sound + nav badge. No page refresh required.
 */
(function () {
  var es = null;
  var unread = 0;
  var soundEnabled = localStorage.getItem("gos_notify_sound") !== "0";

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function ensureToastHost() {
    var host = document.getElementById("gos-toast-host");
    if (host) return host;
    host = document.createElement("div");
    host.id = "gos-toast-host";
    host.className = "gos-toast-host";
    document.body.appendChild(host);
    return host;
  }

  function updateBadge() {
    var btn = document.getElementById("gos-notifications-btn");
    if (!btn) return;
    var badge = btn.querySelector(".gos-notify-badge");
    if (!unread) {
      if (badge) badge.remove();
      return;
    }
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "gos-notify-badge";
      btn.appendChild(badge);
    }
    badge.textContent = unread > 99 ? "99+" : String(unread);
  }

  function playNotifySound() {
    if (!soundEnabled) return;
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      var ctx = new Ctx();
      var o = ctx.createOscillator();
      var g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = 880;
      g.gain.value = 0.04;
      o.connect(g);
      g.connect(ctx.destination);
      o.start();
      setTimeout(function () {
        o.frequency.value = 1175;
      }, 90);
      setTimeout(function () {
        o.stop();
        ctx.close();
      }, 220);
    } catch (e) {
      /* ignore */
    }
  }

  function showAssignedToast(data) {
    var host = ensureToastHost();
    var el = document.createElement("div");
    el.className = "gos-toast gos-toast-assign";
    var miles =
      data.miles != null && data.miles !== ""
        ? esc(data.miles) + " miles"
        : "";
    el.innerHTML =
      '<div class="gos-toast-title">New Shipment Assigned</div>' +
      '<div class="gos-toast-body">' +
      (data.greenOsShipmentId || data.shipmentNumber
        ? "<strong>Shipment # " +
          esc(data.greenOsShipmentId || data.shipmentNumber) +
          "</strong><br/>"
        : "") +
      "<strong>" +
      esc(data.vehicle || data.shipmentTitle || "Shipment") +
      "</strong><br/>" +
      esc(data.pickup || "—") +
      " → " +
      esc(data.delivery || "—") +
      (miles ? "<br/>" + miles : "") +
      "</div>" +
      '<div class="gos-toast-actions">' +
      '<button type="button" class="btn-primary gos-toast-open" style="width:auto;padding:0.45rem 0.85rem">Open Shipment</button>' +
      '<button type="button" class="btn-secondary gos-toast-dismiss" style="width:auto;padding:0.45rem 0.85rem">Dismiss</button>' +
      "</div>";

    function close() {
      el.classList.add("is-leaving");
      setTimeout(function () {
        el.remove();
      }, 280);
    }

    el.querySelector(".gos-toast-dismiss").addEventListener("click", close);
    el.querySelector(".gos-toast-open").addEventListener("click", function () {
      close();
      unread = Math.max(0, unread - 1);
      updateBadge();
      var id = data.shipmentLeadId;
      if (!id) return;
      if (window.GreenOS && window.GreenOS.user && window.GreenOS.user.role === "Broker") {
        window.GreenOS.navigate("broker", "shipments");
        setTimeout(function () {
          var hostEl = document.getElementById("gos-module-host");
          if (
            hostEl &&
            window.GreenOSModules &&
            window.GreenOSModules.crm &&
            window.GreenOSModules.crm.openShipmentCard
          ) {
            window.GreenOSModules.crm.openShipmentCard(hostEl, id);
          }
        }, 400);
      } else if (window.GreenOS) {
        window.GreenOS.navigate("crm", "shipments");
        setTimeout(function () {
          var hostEl = document.getElementById("gos-module-host");
          if (
            hostEl &&
            window.GreenOSModules &&
            window.GreenOSModules.crm &&
            window.GreenOSModules.crm.openShipmentCard
          ) {
            window.GreenOSModules.crm.openShipmentCard(hostEl, id);
          }
        }, 400);
      }
    });

    host.appendChild(el);
    setTimeout(close, 45000);
  }

  function showSimpleToast(title, body) {
    var host = ensureToastHost();
    var el = document.createElement("div");
    el.className = "gos-toast";
    el.innerHTML =
      '<div class="gos-toast-title">' +
      esc(title) +
      "</div>" +
      '<div class="gos-toast-body">' +
      esc(body) +
      "</div>";
    host.appendChild(el);
    setTimeout(function () {
      el.classList.add("is-leaving");
      setTimeout(function () {
        el.remove();
      }, 280);
    }, 8000);
  }

  function refreshOpenViews() {
    if (typeof window.GreenOSEmailReload === "function") {
      window.GreenOSEmailReload();
    }
    // Prefer soft My Shipments reload for brokers (avoid full remount).
    if (typeof window.GreenOSBrokerReloadShipments === "function") {
      window.GreenOSBrokerReloadShipments();
    }
    if (
      window.GreenOS &&
      typeof window.GreenOS.refreshModule === "function" &&
      window.GreenOS.currentModule &&
      window.GreenOS.currentModule !== "broker"
    ) {
      window.GreenOS.refreshModule();
    }
    if (typeof window.GreenOSEmailAccountsReload === "function") {
      window.GreenOSEmailAccountsReload();
    }
  }

  function onAssigned(data) {
    unread += 1;
    updateBadge();
    playNotifySound();
    showAssignedToast(data || {});
    refreshOpenViews();
  }

  function removeFromMyQueue(d) {
    unread += 1;
    updateBadge();
    playNotifySound();
    var num = d.greenOsShipmentId || d.shipmentNumber || "";
    showSimpleToast(
      d.title || "Removed from your queue",
      (num ? "Shipment # " + num + " — " : "") +
        (d.message || d.reason || "Passed to another broker")
    );
    var modal = document.getElementById("crm-modal");
    if (modal && !modal.classList.contains("hidden") && d.shipmentLeadId) {
      var openId = modal.getAttribute("data-shipment-id");
      if (openId === d.shipmentLeadId) {
        modal.classList.add("hidden");
        modal.innerHTML = "";
        modal.removeAttribute("data-shipment-id");
      }
    }
    refreshOpenViews();
  }

  function connect() {
    var token = localStorage.getItem("gl_token");
    if (!token) return;
    if (es) {
      try {
        es.close();
      } catch (e) {
        /* ignore */
      }
      es = null;
    }
    var url = "/api/crm/events?token=" + encodeURIComponent(token);
    try {
      es = new EventSource(url);
    } catch (e) {
      console.warn("[realtime] EventSource failed", e);
      es = null;
    }

    // Always keep My Shipments / boards refreshing — even if SSE is unavailable.
    if (!window.__gosShipmentPoll) {
      window.__gosShipmentPoll = setInterval(function () {
        if (document.hidden) return;
        refreshOpenViews();
      }, 10000);
    }

    if (!es) return;

    es.addEventListener("connected", function () {
      console.log("[realtime] SSE connected");
    });

    es.addEventListener("SHIPMENT_ASSIGNED", function (ev) {
      try {
        onAssigned(JSON.parse(ev.data));
      } catch (e) {
        console.warn("[realtime] bad SHIPMENT_ASSIGNED", e);
      }
    });

    es.addEventListener("SHIPMENT_ASSIGNED_BROADCAST", function (ev) {
      try {
        var d = JSON.parse(ev.data);
        // Brokers already get SHIPMENT_ASSIGNED; Owner / Team Lead see who got it
        if (window.GreenOSUser && window.GreenOSUser.role === "Broker") return;
        unread += 1;
        updateBadge();
        showSimpleToast(
          "New shipment → " + (d.brokerName || "broker"),
          (d.greenOsShipmentId || d.shipmentNumber
            ? "Shipment # " + (d.greenOsShipmentId || d.shipmentNumber) + " — "
            : "") +
            (d.shipmentTitle || "Shipment") +
            " assigned to " +
            (d.brokerName || "broker")
        );
        refreshOpenViews();
      } catch (e) {
        /* ignore */
      }
    });

    es.addEventListener("SHIPMENT_UNASSIGNED", function (ev) {
      try {
        var d = JSON.parse(ev.data);
        if (window.GreenOSUser && window.GreenOSUser.role === "Broker") {
          // Previous assignee: drop row from My Shipments immediately.
          removeFromMyQueue(
            Object.assign({}, d, {
              title: "Removed from your queue",
              message: d.reason || "Shipment is no longer assigned to you",
            })
          );
          return;
        }
        unread += 1;
        updateBadge();
        showSimpleToast(
          "Unassigned shipment",
          (d.shipmentTitle || "Shipment") + " — waiting for broker In Office"
        );
        refreshOpenViews();
      } catch (e) {
        /* ignore */
      }
    });

    // Fired to the broker who missed the 20-minute accept window (shipment leaves their account).
    es.addEventListener("ACCEPTANCE_MISSED", function (ev) {
      try {
        var d = JSON.parse(ev.data);
        removeFromMyQueue(
          Object.assign({}, d, {
            title: "Shipment reassigned",
            message:
              d.message ||
              "You did not accept in time — shipment passed to the next broker",
          })
        );
      } catch (e) {
        /* ignore */
      }
    });

    es.addEventListener("ACCEPTANCE_MISSED_BROADCAST", function (ev) {
      try {
        var d = JSON.parse(ev.data);
        if (window.GreenOSUser && window.GreenOSUser.role === "Broker") return;
        unread += 1;
        updateBadge();
        showSimpleToast(
          d.title || "Acceptance missed",
          d.message || "Reassigning shipment"
        );
        refreshOpenViews();
      } catch (e) {
        /* ignore */
      }
    });

    function onLifecycle(d) {
      unread += 1;
      updateBadge();
      playNotifySound();
      var num = d.greenOsShipmentId || d.shipmentNumber || "";
      showSimpleToast(
        d.title || "Shipment update",
        (num ? "Shipment # " + num + " — " : "") + (d.subject || d.kind || "")
      );
      refreshOpenViews();
    }

    es.addEventListener("SHIPMENT_LIFECYCLE", function (ev) {
      try {
        onLifecycle(JSON.parse(ev.data));
      } catch (e) {
        /* ignore */
      }
    });

    es.addEventListener("SHIPMENT_LIFECYCLE_BROADCAST", function (ev) {
      try {
        if (window.GreenOSUser && window.GreenOSUser.role === "Broker") return;
        onLifecycle(JSON.parse(ev.data));
      } catch (e) {
        /* ignore */
      }
    });

    es.onerror = function () {
      // Browser auto-reconnects EventSource
    };
  }

  function disconnect() {
    if (es) {
      try {
        es.close();
      } catch (e) {
        /* ignore */
      }
      es = null;
    }
  }

  window.GreenOSRealtime = {
    connect: connect,
    disconnect: disconnect,
    setSoundEnabled: function (on) {
      soundEnabled = !!on;
      localStorage.setItem("gos_notify_sound", on ? "1" : "0");
    },
    clearUnread: function () {
      unread = 0;
      updateBadge();
    },
  };

  // Auto-connect when shell is ready / token present
  document.addEventListener("DOMContentLoaded", function () {
    if (localStorage.getItem("gl_token")) connect();
  });

  // Reconnect after login (app.js sets token then showApp)
  var _setItem = localStorage.setItem.bind(localStorage);
  localStorage.setItem = function (k, v) {
    _setItem(k, v);
    if (k === "gl_token" && v) connect();
  };
  var _removeItem = localStorage.removeItem.bind(localStorage);
  localStorage.removeItem = function (k) {
    _removeItem(k);
    if (k === "gl_token") disconnect();
  };
})();

/**
 * GreenOS realtime — SSE client for live shipment assignment notifications.
 * Popup toast + optional sound + nav badge. No page refresh required.
 *
 * Rules:
 * - Same toast (shipment + title + kind) is shown only once (persisted).
 * - Click on a toast opens the shipment card.
 */
(function () {
  var es = null;
  var unread = 0;
  var soundEnabled = localStorage.getItem("gos_notify_sound") !== "0";
  var TOAST_SEEN_KEY = "gos_toast_seen_v1";
  var TOAST_SEEN_MAX = 400;

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function currentRole() {
    if (window.GreenOS && typeof window.GreenOS.role === "function") {
      var r = window.GreenOS.role();
      if (r) return r;
    }
    return (
      (window.GreenOS && window.GreenOS.user && window.GreenOS.user.role) ||
      (window.GreenOSUser && window.GreenOSUser.role) ||
      ""
    );
  }

  function currentUserId() {
    return (
      (window.GreenOS && window.GreenOS.user && window.GreenOS.user.userId) ||
      (window.GreenOSUser && window.GreenOSUser.userId) ||
      ""
    );
  }

  function isBrokerRole() {
    return currentRole() === "Broker";
  }

  /** Brokers must never toast/open cards for shipments owned by someone else. */
  function brokerOwnsEvent(data) {
    if (!isBrokerRole()) return true;
    if (!data) return false;
    var mine = currentUserId();
    if (!mine) return false;
    var assigned =
      data.assignedBrokerId ||
      data.brokerUserId ||
      data.forUserId ||
      data.userId ||
      "";
    // Events without an owner claim are OK only when explicitly targeted via SSE to this user
    // (server already scoped). If another broker id is present and differs — hide.
    if (assigned && assigned !== mine) return false;
    return true;
  }

  function loadSeenMap() {
    try {
      var raw = localStorage.getItem(TOAST_SEEN_KEY);
      var obj = raw ? JSON.parse(raw) : {};
      return obj && typeof obj === "object" ? obj : {};
    } catch (e) {
      return {};
    }
  }

  function saveSeenMap(map) {
    try {
      var keys = Object.keys(map);
      if (keys.length > TOAST_SEEN_MAX) {
        keys
          .sort(function (a, b) {
            return (map[a] || 0) - (map[b] || 0);
          })
          .slice(0, keys.length - TOAST_SEEN_MAX)
          .forEach(function (k) {
            delete map[k];
          });
      }
      localStorage.setItem(TOAST_SEEN_KEY, JSON.stringify(map));
    } catch (e) {
      /* ignore quota */
    }
  }

  function toastFingerprint(parts) {
    return parts
      .map(function (p) {
        return String(p == null ? "" : p)
          .trim()
          .toLowerCase()
          .replace(/\s+/g, " ");
      })
      .filter(Boolean)
      .join("|");
  }

  /** Returns false if this toast was already shown (and marks it seen). */
  function claimToastOnce(key) {
    if (!key) return true;
    var map = loadSeenMap();
    if (map[key]) return false;
    map[key] = Date.now();
    saveSeenMap(map);
    return true;
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

  var MAX_VISIBLE_TOASTS = 3;
  var hiddenToasts = 0;

  function updateMoreCounter(host) {
    var pill = host.querySelector(".gos-toast-more");
    if (!hiddenToasts) {
      if (pill) pill.remove();
      return;
    }
    if (!pill) {
      pill = document.createElement("button");
      pill.type = "button";
      pill.className = "gos-toast-more";
      pill.addEventListener("click", function () {
        hiddenToasts = 0;
        pill.remove();
        if (window.GreenOS) {
          if (isBrokerRole()) window.GreenOS.navigate("broker", "shipments");
          else window.GreenOS.navigate("crm", "shipments");
        }
      });
      host.appendChild(pill);
    }
    pill.textContent = "+" + hiddenToasts + " more";
  }

  function trimToasts(host) {
    var items = host.querySelectorAll(".gos-toast");
    for (var i = 0; i < items.length - MAX_VISIBLE_TOASTS; i++) {
      items[i].remove();
      hiddenToasts += 1;
    }
    updateMoreCounter(host);
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

  var audioCtx = null;

  /** Browsers stay silent until the broker has clicked or typed once. */
  function unlockAudio() {
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      if (!audioCtx) audioCtx = new Ctx();
      if (audioCtx.state === "suspended") audioCtx.resume();
      return audioCtx;
    } catch (e) {
      return null;
    }
  }

  function alarmStrike(ctx, dest, when, freq, volume) {
    var layers = [
      { type: "square", weight: 0.42 },
      { type: "triangle", weight: 0.85 },
      { type: "sine", weight: 1 },
    ];
    for (var i = 0; i < layers.length; i++) {
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.type = layers[i].type;
      osc.frequency.setValueAtTime(freq, when);
      var peak = Math.max(0.0001, volume * layers[i].weight);
      gain.gain.setValueAtTime(0.0001, when);
      gain.gain.exponentialRampToValueAtTime(peak, when + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.42);
      osc.connect(gain);
      gain.connect(dest);
      osc.start(when);
      osc.stop(when + 0.46);
    }
  }

  /** Fast rising alarm, played twice. Loud enough to cut through the office. */
  function playEnergizingBell() {
    if (!soundEnabled) return;
    try {
      var ctx = unlockAudio();
      if (!ctx) return;
      var master = ctx.createGain();
      master.gain.setValueAtTime(1, ctx.currentTime);
      master.connect(ctx.destination);
      var start = ctx.currentTime + 0.02;
      var notes = [740, 988, 1318, 1760];
      for (var burst = 0; burst < 2; burst++) {
        for (var n = 0; n < notes.length; n++) {
          alarmStrike(ctx, master, start + burst * 0.72 + n * 0.13, notes[n], 0.72);
        }
      }
    } catch (e) {
      /* ignore */
    }
  }

  function playShipmentBell() {
    playEnergizingBell();
  }

  function playNotifySound() {
    playEnergizingBell();
  }

  /** Open shipment card from toast / notification click. */
  function openShipmentById(shipmentLeadId) {
    if (!shipmentLeadId) return;
    var role = currentRole();
    var nav = window.GreenOSShell || window.GreenOS;
    if (nav && typeof nav.navigate === "function") {
      if (role === "Broker") nav.navigate("broker", "shipments");
      else nav.navigate("crm", "shipments");
    }
    setTimeout(function () {
      var hostEl = document.getElementById("gos-module-host");
      if (
        hostEl &&
        window.GreenOSModules &&
        window.GreenOSModules.crm &&
        typeof window.GreenOSModules.crm.openShipmentCard === "function"
      ) {
        window.GreenOSModules.crm.openShipmentCard(hostEl, shipmentLeadId);
      }
    }, 350);
  }

  function dismissToast(el) {
    el.classList.add("is-leaving");
    setTimeout(function () {
      el.remove();
    }, 280);
  }

  function showAssignedToast(data) {
    var key = toastFingerprint([
      "assign",
      data.shipmentLeadId,
      data.greenOsShipmentId || data.shipmentNumber,
      "SHIPMENT_ASSIGNED",
    ]);
    if (!claimToastOnce(key)) return false;

    var host = ensureToastHost();
    var el = document.createElement("div");
    el.className = "gos-toast gos-toast-assign gos-toast-clickable";
    el.setAttribute("role", "button");
    el.tabIndex = 0;
    var miles =
      data.miles != null && data.miles !== "" ? esc(data.miles) + " miles" : "";
    var route = "";
    if (data.pickup || data.delivery) {
      route =
        esc(data.pickup || "—") +
        " → " +
        esc(data.delivery || "—") +
        (miles ? "<br/>" + miles : "");
    }
    el.innerHTML =
      '<div class="gos-toast-title">New Shipment</div>' +
      '<div class="gos-toast-body">' +
      (data.greenOsShipmentId || data.shipmentNumber
        ? "<strong>Shipment # " +
          esc(data.greenOsShipmentId || data.shipmentNumber) +
          "</strong><br/>"
        : "") +
      "<strong>" +
      esc(data.vehicle || data.shipmentTitle || "Shipment") +
      "</strong>" +
      (route ? "<br/>" + route : "") +
      "</div>" +
      '<div class="gos-toast-actions">' +
      '<button type="button" class="btn-primary gos-toast-open" style="width:auto;padding:0.3rem 0.6rem">Open</button>' +
      '<button type="button" class="btn-secondary gos-toast-dismiss" style="width:auto;padding:0.3rem 0.6rem">Dismiss</button>' +
      "</div>";

    function open() {
      dismissToast(el);
      unread = Math.max(0, unread - 1);
      updateBadge();
      openShipmentById(data.shipmentLeadId);
    }

    el.querySelector(".gos-toast-dismiss").addEventListener("click", function (ev) {
      ev.stopPropagation();
      dismissToast(el);
    });
    el.querySelector(".gos-toast-open").addEventListener("click", function (ev) {
      ev.stopPropagation();
      open();
    });
    el.addEventListener("click", open);

    host.appendChild(el);
    trimToasts(host);
    setTimeout(function () {
      dismissToast(el);
    }, 20000);
    return true;
  }

  /**
   * @param {string} title
   * @param {string} body
   * @param {{ shipmentLeadId?: string, greenOsShipmentId?: string, kind?: string, dedupeKey?: string }} [opts]
   */
  function showSimpleToast(title, body, opts) {
    opts = opts || {};
    var key =
      opts.dedupeKey ||
      toastFingerprint([
        opts.shipmentLeadId,
        opts.greenOsShipmentId,
        title,
        opts.kind,
        body,
      ]);
    if (!claimToastOnce(key)) return false;

    var host = ensureToastHost();
    var el = document.createElement("div");
    el.className =
      "gos-toast" + (opts.shipmentLeadId ? " gos-toast-clickable" : "");
    if (opts.shipmentLeadId) {
      el.setAttribute("role", "button");
      el.tabIndex = 0;
      el.title = "Click to open shipment";
    }
    el.innerHTML =
      '<div class="gos-toast-title">' +
      esc(title) +
      "</div>" +
      '<div class="gos-toast-body">' +
      esc(body) +
      (opts.shipmentLeadId
        ? '<div class="gos-toast-hint">Click to open shipment</div>'
        : "") +
      "</div>";

    if (opts.shipmentLeadId) {
      el.addEventListener("click", function () {
        dismissToast(el);
        unread = Math.max(0, unread - 1);
        updateBadge();
        openShipmentById(opts.shipmentLeadId);
      });
    }

    host.appendChild(el);
    trimToasts(host);
    setTimeout(function () {
      dismissToast(el);
    }, 10000);
    return true;
  }

  function requestDesktopPush() {
    if (!("Notification" in window)) return;
    if (Notification.permission === "default") {
      Notification.requestPermission().catch(function () {});
    }
  }

  function showDesktopPush(title, body, shipmentLeadId) {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    try {
      var n = new Notification(title, {
        body: body || "",
        tag: shipmentLeadId ? "gos-" + shipmentLeadId + "-customer" : "gos-customer",
        requireInteraction: true,
      });
      n.onclick = function () {
        try {
          window.focus();
        } catch (e) {}
        n.close();
        if (shipmentLeadId) openShipmentById(shipmentLeadId);
      };
    } catch (e) {
      /* ignore */
    }
  }

  function isShipmentsListPage() {
    var g = window.GreenOS;
    if (
      document.getElementById("shipments-module-body") ||
      document.getElementById("crm-ship-body") ||
      document.getElementById("broker-ship-body")
    ) {
      return true;
    }
    if (!g) return false;
    if (g.currentModule === "shipments") return true;
    if (g.currentSub === "new" || g.currentSub === "other") return true;
    if (g.currentModule === "broker" && g.currentSub === "shipments") return true;
    if (g.currentModule === "crm" && g.currentSub === "shipments") return true;
    return false;
  }

  function refreshOpenViews() {
    // Shipments list is manual only — no SSE / poll remount (toast still shows).
    var loadOpen = false;
    try {
      loadOpen = Boolean(
        sessionStorage.getItem("gos_viewing_load_id") ||
          document.querySelector(".load-layout")
      );
    } catch (e) {}
    if (
      !loadOpen &&
      !isShipmentsListPage() &&
      window.GreenOS &&
      typeof window.GreenOS.refreshModule === "function" &&
      window.GreenOS.currentModule &&
      window.GreenOS.currentModule !== "broker" &&
      window.GreenOS.currentModule !== "attendance" &&
      window.GreenOS.currentModule !== "loads" &&
      window.GreenOS.currentModule !== "dispatch" &&
      window.GreenOS.currentModule !== "administration" &&
      window.GreenOS.currentModule !== "carriers" &&
      window.GreenOS.currentModule !== "ai" &&
      window.GreenOS.currentModule !== "email" &&
      window.GreenOS.currentModule !== "shipments" &&
      window.GreenOS.currentModule !== "accounting"
    ) {
      window.GreenOS.refreshModule();
    }

    // Email Accounts stays still while the owner is on it. Refresh is manual.
    if (
      window.GreenOSModules &&
      window.GreenOSModules.crm &&
      typeof window.GreenOSModules.crm.refreshOpenShipmentCard === "function"
    ) {
      window.GreenOSModules.crm.refreshOpenShipmentCard();
    }
  }

  function onAssignedFixed(data) {
    var shown = showAssignedToast(data || {});
    if (!shown) {
      refreshOpenViews();
      return;
    }
    unread += 1;
    updateBadge();
    playShipmentBell();
    var num = (data && (data.greenOsShipmentId || data.shipmentNumber)) || "";
    var titleText = (data && (data.vehicle || data.shipmentTitle)) || "New Shipment";
    showDesktopPush(
      "New Shipment",
      (num ? "Shipment # " + num + " — " : "") + titleText,
      data && data.shipmentLeadId
    );
    refreshOpenViews();
  }

  function removeFromMyQueue(d) {
    // After reassignment the card belongs to another broker — show info only, no open.
    var shown = showSimpleToast(
      d.title || "Removed from your queue",
      ((d.greenOsShipmentId || d.shipmentNumber)
        ? "Shipment # " + (d.greenOsShipmentId || d.shipmentNumber) + " — "
        : "") + (d.message || d.reason || "Passed to another broker"),
      {
        greenOsShipmentId: d.greenOsShipmentId || d.shipmentNumber,
        kind: "REMOVED",
      }
    );
    if (shown) {
      unread += 1;
      updateBadge();
      playNotifySound();
    }
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
    requestDesktopPush();
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

    if (!window.__gosShipmentPoll) {
      window.__gosShipmentPoll = setInterval(function () {
        if (document.hidden) return;
        refreshOpenViews();
      }, 10000);
    }

    // SSE can drop behind the proxy. Poll the broker's own assignment alerts
    // so the corner toast and bell still fire within a few seconds.
    if (!window.__gosAssignPoll) {
      var assignSince = Date.now() - 25000;
      window.__gosAssignPoll = setInterval(pollAssignedShipments, 8000);
      setTimeout(pollAssignedShipments, 1200);
    }

    function pollAssignedShipments() {
      var role = currentRole();
      if (role !== "Broker" && role !== "Team Lead") return;
      var token = localStorage.getItem("gl_token");
      if (!token) return;
      fetch("/api/crm/notifications", {
        headers: { Authorization: "Bearer " + token },
      })
        .then(function (res) {
          return res.ok ? res.json() : null;
        })
        .then(function (body) {
          var items = body && body.data && body.data.items;
          if (!items || !items.length) return;
          var nextSince = assignSince;
          items.forEach(function (item) {
            if (!item || item.type !== "SHIPMENT_ASSIGNED") return;
            if (item.title !== "New Shipment Assigned") return;
            var created = new Date(item.createdAt).getTime();
            if (!created || created < assignSince) return;
            if (created > nextSince) nextSince = created;
            var message = String(item.message || "");
            var match = message.match(/Shipment #\s*([A-Za-z0-9-]+)/);
            var num = match ? match[1] : "";
            var name = message.split("—").slice(1).join("—").trim();
            onAssignedFixed({
              shipmentLeadId: item.shipmentLeadId,
              greenOsShipmentId: num,
              shipmentNumber: num,
              shipmentTitle: name || message || "Shipment",
              vehicle: name || message || "Shipment",
            });
          });
          assignSince = Math.max(nextSince, Date.now() - 2000);
        })
        .catch(function () {});
    }

    if (!es) return;

    es.addEventListener("connected", function () {
      console.log("[realtime] SSE connected");
    });

    es.addEventListener("SHIPMENT_ASSIGNED", function (ev) {
      try {
        onAssignedFixed(JSON.parse(ev.data));
      } catch (e) {
        console.warn("[realtime] bad SHIPMENT_ASSIGNED", e);
      }
    });

    es.addEventListener("SHIPMENT_ASSIGNED_BROADCAST", function (ev) {
      try {
        var d = JSON.parse(ev.data);
        if (isBrokerRole()) return;
        var shown = showSimpleToast(
          "New shipment → " + (d.brokerName || "broker"),
          (d.greenOsShipmentId || d.shipmentNumber
            ? "Shipment # " + (d.greenOsShipmentId || d.shipmentNumber) + " — "
            : "") +
            (d.shipmentTitle || "Shipment") +
            " assigned to " +
            (d.brokerName || "broker"),
          {
            shipmentLeadId: d.shipmentLeadId,
            greenOsShipmentId: d.greenOsShipmentId || d.shipmentNumber,
            kind: "ASSIGNED_BROADCAST",
          }
        );
        if (shown) {
          unread += 1;
          updateBadge();
        }
        refreshOpenViews();
      } catch (e) {
        /* ignore */
      }
    });

    es.addEventListener("SHIPMENT_UNASSIGNED", function (ev) {
      try {
        var d = JSON.parse(ev.data);
        if (isBrokerRole()) {
          removeFromMyQueue(
            Object.assign({}, d, {
              title: "Removed from your queue",
              message: d.reason || "Shipment is no longer assigned to you",
            })
          );
          return;
        }
        var shown = showSimpleToast(
          "Unassigned shipment",
          (d.shipmentTitle || "Shipment") + " — waiting for broker In Office",
          {
            shipmentLeadId: d.shipmentLeadId,
            greenOsShipmentId: d.greenOsShipmentId || d.shipmentNumber,
            kind: "UNASSIGNED",
          }
        );
        if (shown) {
          unread += 1;
          updateBadge();
        }
        refreshOpenViews();
      } catch (e) {
        /* ignore */
      }
    });

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
        if (isBrokerRole()) return;
        var shown = showSimpleToast(
          d.title || "Acceptance missed",
          d.message || "Reassigning shipment",
          {
            shipmentLeadId: d.shipmentLeadId,
            greenOsShipmentId: d.greenOsShipmentId || d.shipmentNumber,
            kind: "ACCEPTANCE_MISSED",
          }
        );
        if (shown) {
          unread += 1;
          updateBadge();
        }
        refreshOpenViews();
      } catch (e) {
        /* ignore */
      }
    });

    function onLifecycle(d) {
      if (!brokerOwnsEvent(d)) return;
      var num = d.greenOsShipmentId || d.shipmentNumber || "";
      var shown = showSimpleToast(
        d.title || "Shipment update",
        (num ? "Shipment # " + num + " — " : "") + (d.subject || d.kind || ""),
        {
          shipmentLeadId: d.shipmentLeadId,
          greenOsShipmentId: num,
          kind: d.kind || d.title || "LIFECYCLE",
          // Same shipment + same event title = once only (ignore subject churn).
          // Each new "another provider quoted" email should alert again.
          dedupeKey: toastFingerprint(
            String(d.kind || "") === "COMPETITOR_QUOTE" ||
              String(d.kind || "") === "QUOTE_DECLINED"
              ? [d.shipmentLeadId, num, d.title, d.kind, d.at || d.subject]
              : [d.shipmentLeadId, num, d.title, d.kind]
          ),
        }
      );
      if (shown) {
        unread += 1;
        updateBadge();
        playNotifySound();
        var kind = String(d.kind || "");
        if (
          kind === "CUSTOMER_RESPOND" ||
          kind === "CUSTOMER_REPLIED" ||
          kind === "CUSTOMER_QUESTION" ||
          kind === "NEW_MESSAGE"
        ) {
          showDesktopPush(
            "Customer Respond",
            (num ? "Shipment # " + num + " — " : "") +
              (d.subject || "Customer replied to your question"),
            d.shipmentLeadId
          );
        }
        if (kind === "COMPETITOR_QUOTE") {
          showDesktopPush(
            "Another provider quoted",
            (num ? "Shipment # " + num + " — " : "") +
              (d.subject || "Another provider has quoted on this shipment"),
            d.shipmentLeadId
          );
        }
        if (kind === "QUOTE_DECLINED") {
          showDesktopPush(
            "Customer declined",
            (num ? "Shipment # " + num + " — " : "") +
              (d.subject || "The customer declined this quote"),
            d.shipmentLeadId
          );
        }
      }
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
        if (isBrokerRole()) return;
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
    openShipment: openShipmentById,
    setSoundEnabled: function (on) {
      soundEnabled = !!on;
      localStorage.setItem("gos_notify_sound", on ? "1" : "0");
    },
    clearUnread: function () {
      unread = 0;
      updateBadge();
    },
  };

  document.addEventListener("pointerdown", unlockAudio, true);
  document.addEventListener("keydown", unlockAudio, true);

  document.addEventListener("DOMContentLoaded", function () {
    if (localStorage.getItem("gl_token")) connect();
  });

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

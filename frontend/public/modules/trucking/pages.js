/**
 * Trucking — live CarrierView-style board: track list + map + location cards.
 * Brokers see only their assigned loads.
 */
window.GreenOSModules = window.GreenOSModules || {};
window.GreenOSModules.trucking = {
  _timer: null,
  _map: null,
  _markers: {},
  _rows: [],
  _selectedId: null,
  _leafletLoading: null,

  stopTimer() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  },

  destroyMap() {
    if (this._map) {
      try {
        this._map.remove();
      } catch (e) {
        /* ignore */
      }
      this._map = null;
    }
    this._markers = {};
  },

  esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  },

  async api(path) {
    var token = localStorage.getItem("gl_token") || "";
    var res = await fetch("/api/crm" + path, {
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + token,
      },
    });
    return res.json();
  },

  ensureLeaflet() {
    if (window.L) return Promise.resolve(window.L);
    if (this._leafletLoading) return this._leafletLoading;
    var self = this;
    this._leafletLoading = new Promise(function (resolve, reject) {
      var cssId = "gos-leaflet-css";
      if (!document.getElementById(cssId)) {
        var link = document.createElement("link");
        link.id = cssId;
        link.rel = "stylesheet";
        link.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
        document.head.appendChild(link);
      }
      var script = document.createElement("script");
      script.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
      script.onload = function () {
        resolve(window.L);
      };
      script.onerror = function () {
        self._leafletLoading = null;
        reject(new Error("Leaflet failed to load"));
      };
      document.head.appendChild(script);
    });
    return this._leafletLoading;
  },

  relativeTime(iso) {
    if (!iso) return "—";
    var t = new Date(iso).getTime();
    if (!t) return "—";
    var sec = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (sec < 45) return "now";
    if (sec < 3600) return Math.round(sec / 60) + "m ago";
    if (sec < 86400) return Math.round(sec / 3600) + "h ago";
    if (sec < 86400 * 7) return Math.round(sec / 86400) + "d ago";
    return new Date(iso).toLocaleString();
  },

  formatEta(sec) {
    if (sec == null || !isFinite(sec) || sec < 0) return null;
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    if (h >= 48) return Math.round(h / 24) + "d " + (h % 24) + "h";
    if (h > 0) return h + "h " + m + "m";
    return m + "m";
  },

  formatDistance(meters) {
    if (meters == null || !isFinite(meters) || meters < 0) return null;
    var mi = meters / 1609.344;
    if (mi >= 100) return Math.round(mi) + " mi left";
    if (mi >= 10) return mi.toFixed(0) + " mi left";
    return mi.toFixed(1) + " mi left";
  },

  progressPct(r) {
    if (r.distanceLeftMeters == null || !isFinite(r.distanceLeftMeters)) return null;
    // Without total miles we show a soft fill from remaining distance (lower left = closer).
    var mi = r.distanceLeftMeters / 1609.344;
    var pct = Math.max(8, Math.min(92, 100 - Math.min(mi / 25, 1) * 70));
    return Math.round(pct);
  },

  loadLabel(r) {
    return r.loadNumber || r.greenOsShipmentId || "—";
  },

  openLoad(id) {
    if (window.GreenOSModules.dispatch && window.GreenOSModules.dispatch.openLoad) {
      if (window.GreenOS && window.GreenOS.navigate) {
        window.GreenOS.navigate("loads", "active-loads");
      }
      setTimeout(function () {
        var host =
          document.getElementById("load-tms-body") ||
          document.querySelector(".gos-module-body");
        window.GreenOSModules.dispatch.openLoad(host, id, "tracking");
      }, 200);
    } else if (window.GreenOSModules.crm && window.GreenOSModules.crm.openShipmentCard) {
      window.GreenOSModules.crm.openShipmentCard(document, id);
    }
  },

  selectTrack(id, opts) {
    opts = opts || {};
    this._selectedId = id;
    var list = document.getElementById("trucking-track-list");
    if (list) {
      list.querySelectorAll(".gos-track-card").forEach(function (el) {
        el.classList.toggle("is-selected", el.getAttribute("data-id") === id);
      });
    }
    this.renderDetail();
    var row = this._rows.find(function (r) {
      return r.shipmentLeadId === id;
    });
    if (row && row.latitude != null && row.longitude != null && this._map && this._markers[id]) {
      this._map.setView([row.latitude, row.longitude], opts.zoom || 8, { animate: true });
      try {
        this._markers[id].openPopup();
      } catch (e) {
        /* ignore */
      }
    }
  },

  cardHtml(r) {
    var esc = this.esc.bind(this);
    var load = this.loadLabel(r);
    var locLine = r.online
      ? this.relativeTime(r.lastPositionAt) +
        (r.address ? " — " + r.address : r.latitude != null ? " — GPS fix" : " — waiting for GPS")
      : "No GPS yet";
    var eta = this.formatEta(r.timeLeftSec);
    var dist = this.formatDistance(r.distanceLeftMeters);
    var pct = this.progressPct(r);
    var late = r.driverIsLate
      ? '<span class="gos-track-pill gos-track-pill--warn">LATE</span>'
      : "";
    var online = r.online
      ? '<span class="gos-track-pill gos-track-pill--on">active</span>'
      : '<span class="gos-track-pill">offline</span>';
    var progress =
      pct != null
        ? '<div class="gos-track-progress" aria-hidden="true"><div class="gos-track-progress__bar" style="width:' +
          pct +
          '%"></div></div>'
        : r.online
          ? '<div class="gos-track-progress gos-track-progress--indeterminate" aria-hidden="true"></div>'
          : "";
    var metaBits = [];
    if (dist) metaBits.push(dist);
    if (eta) metaBits.push("ETA " + eta);
    if (r.movementType) metaBits.push(String(r.movementType));
    return (
      '<article class="gos-track-card' +
      (this._selectedId === r.shipmentLeadId ? " is-selected" : "") +
      (r.online ? " is-online" : "") +
      '" data-id="' +
      esc(r.shipmentLeadId) +
      '" role="button" tabindex="0">' +
      '<div class="gos-track-card__top">' +
      "<div>" +
      '<div class="gos-track-card__route">' +
      esc(r.pickup) +
      " → " +
      esc(r.delivery) +
      "</div>" +
      '<div class="gos-track-card__ref">#' +
      esc(load) +
      (r.customer && r.customer !== "—" ? " · " + esc(r.customer) : "") +
      "</div>" +
      "</div>" +
      '<div class="gos-track-card__flags">' +
      online +
      late +
      "</div>" +
      "</div>" +
      '<div class="gos-track-card__carrier">' +
      "<strong>" +
      esc(r.carrier) +
      "</strong>" +
      (r.driverPhone && r.driverPhone !== "—"
        ? ' <a class="gos-track-phone" href="tel:' +
          esc(r.driverPhone) +
          '">' +
          esc(r.driverPhone) +
          "</a>"
        : "") +
      "</div>" +
      '<div class="gos-track-card__loc' +
      (r.online ? "" : " is-muted") +
      '">' +
      '<span class="gos-track-card__loc-dot" aria-hidden="true"></span>' +
      "<span>" +
      esc(locLine) +
      "</span>" +
      "</div>" +
      progress +
      (metaBits.length
        ? '<div class="gos-track-card__meta">' + esc(metaBits.join(" · ")) + "</div>"
        : "") +
      '<div class="gos-track-card__foot">' +
      "<span>Truck " +
      esc(r.truck) +
      (r.driver && r.driver !== "—" ? " · " + esc(r.driver) : "") +
      "</span>" +
      '<button type="button" class="gos-track-details" data-open="' +
      esc(r.shipmentLeadId) +
      '">details</button>' +
      "</div>" +
      "</article>"
    );
  },

  renderList(rows, q) {
    var list = document.getElementById("trucking-track-list");
    if (!list) return;
    var self = this;
    var filtered = rows;
    if (q) {
      var needle = q.toLowerCase();
      filtered = rows.filter(function (r) {
        return [
          r.loadNumber,
          r.greenOsShipmentId,
          r.carrier,
          r.driver,
          r.driverPhone,
          r.truck,
          r.pickup,
          r.delivery,
          r.address,
          r.customer,
          r.status,
        ]
          .join(" ")
          .toLowerCase()
          .indexOf(needle) !== -1;
      });
    }
    if (!filtered.length) {
      list.innerHTML =
        '<p class="gos-muted gos-track-empty">No tracks match. Start CarrierView on Load → Tracking, or mark a load In Road.</p>';
      return;
    }
    list.innerHTML = filtered.map(function (r) {
      return self.cardHtml(r);
    }).join("");

    list.querySelectorAll(".gos-track-card").forEach(function (card) {
      card.addEventListener("click", function (ev) {
        if (ev.target.closest(".gos-track-details") || ev.target.closest("a")) return;
        self.selectTrack(card.getAttribute("data-id"), { zoom: 9 });
      });
      card.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          self.selectTrack(card.getAttribute("data-id"), { zoom: 9 });
        }
      });
    });
    list.querySelectorAll(".gos-track-details").forEach(function (btn) {
      btn.addEventListener("click", function (ev) {
        ev.stopPropagation();
        self.openLoad(btn.getAttribute("data-open"));
      });
    });
  },

  renderDetail() {
    var panel = document.getElementById("trucking-detail");
    if (!panel) return;
    var r = this._rows.find(function (x) {
      return x.shipmentLeadId === this._selectedId;
    }, this);
    if (!r) {
      panel.innerHTML =
        '<div class="gos-track-detail gos-track-detail--empty">' +
        "<strong>Select a track</strong>" +
        "<p class=\"gos-muted\">Location, ETA and CarrierView links appear here.</p>" +
        "</div>";
      return;
    }
    var esc = this.esc.bind(this);
    var sources = [];
    if (r.online) {
      sources.push({
        name: "CarrierView GPS",
        status: this.relativeTime(r.lastPositionAt),
        place: r.address || (r.latitude != null ? r.latitude.toFixed(4) + ", " + r.longitude.toFixed(4) : "—"),
        live: true,
      });
    } else {
      sources.push({
        name: "CarrierView GPS",
        status: "No location",
        place: "Tracking not started or offline",
        live: false,
      });
    }
    var eta = this.formatEta(r.timeLeftSec);
    var dist = this.formatDistance(r.distanceLeftMeters);
    var cvLink = r.trackingUrl || r.clientTrackingUrl;
    panel.innerHTML =
      '<div class="gos-track-detail">' +
      '<div class="gos-track-detail__head">' +
      "<div>" +
      "<strong>" +
      esc(r.driver !== "—" ? r.driver : r.carrier) +
      "</strong>" +
      '<div class="gos-muted">Truck ' +
      esc(r.truck) +
      (r.trailer && r.trailer !== "—" ? " · Trailer " + esc(r.trailer) : "") +
      "</div>" +
      "</div>" +
      (r.driverPhone && r.driverPhone !== "—"
        ? '<a class="btn-secondary gos-track-call" href="tel:' +
          esc(r.driverPhone) +
          '">' +
          esc(r.driverPhone) +
          "</a>"
        : "") +
      "</div>" +
      '<div class="gos-track-sources">' +
      sources
        .map(function (s) {
          return (
            '<div class="gos-track-source' +
            (s.live ? " is-live" : " is-dead") +
            '">' +
            '<div class="gos-track-source__name">' +
            esc(s.name) +
            "</div>" +
            '<div class="gos-track-source__place">' +
            esc(s.place) +
            "</div>" +
            '<div class="gos-track-source__when">' +
            esc(s.status) +
            "</div>" +
            "</div>"
          );
        })
        .join("") +
      "</div>" +
      '<dl class="gos-track-stats">' +
      "<div><dt>Load</dt><dd>#" +
      esc(this.loadLabel(r)) +
      "</dd></div>" +
      "<div><dt>Lane</dt><dd>" +
      esc(r.pickup) +
      " → " +
      esc(r.delivery) +
      "</dd></div>" +
      "<div><dt>Status</dt><dd>" +
      esc(r.status) +
      (r.driverIsLate ? ' <span class="gos-track-pill gos-track-pill--warn">LATE</span>' : "") +
      "</dd></div>" +
      "<div><dt>Distance</dt><dd>" +
      esc(dist || "—") +
      "</dd></div>" +
      "<div><dt>ETA</dt><dd>" +
      esc(eta || "—") +
      "</dd></div>" +
      "<div><dt>Movement</dt><dd>" +
      esc(r.movementType || "—") +
      "</dd></div>" +
      "</dl>" +
      '<div class="gos-track-detail__actions">' +
      '<button type="button" class="btn-primary" id="trucking-open-load">Open Load Tracking</button>' +
      (cvLink
        ? '<a class="btn-secondary" href="' +
          esc(cvLink) +
          '" target="_blank" rel="noopener">Open in CarrierView</a>'
        : "") +
      "</div>" +
      "</div>";

    var openBtn = document.getElementById("trucking-open-load");
    if (openBtn) {
      var self = this;
      openBtn.addEventListener("click", function () {
        self.openLoad(r.shipmentLeadId);
      });
    }
  },

  async ensureMap() {
    var el = document.getElementById("trucking-map");
    if (!el) return null;
    try {
      await this.ensureLeaflet();
    } catch (e) {
      el.innerHTML =
        '<p class="gos-muted" style="padding:1rem">Map unavailable. Location still shows in the track list.</p>';
      return null;
    }
    if (this._map) {
      try {
        this._map.invalidateSize();
      } catch (e) {
        /* ignore */
      }
      return this._map;
    }
    el.innerHTML = "";
    var L = window.L;
    this._map = L.map(el, { zoomControl: true, attributionControl: true }).setView(
      [39.5, -98.35],
      4
    );
    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
      attribution: '&copy; OpenStreetMap &copy; CARTO',
      subdomains: "abcd",
      maxZoom: 19,
    }).addTo(this._map);
    return this._map;
  },

  syncMarkers(rows) {
    if (!this._map || !window.L) return;
    var L = window.L;
    var self = this;
    var seen = {};
    var bounds = [];
    rows.forEach(function (r) {
      if (r.latitude == null || r.longitude == null) return;
      seen[r.shipmentLeadId] = true;
      bounds.push([r.latitude, r.longitude]);
      var html =
        '<div class="gos-map-pin' +
        (r.online ? " is-online" : "") +
        (self._selectedId === r.shipmentLeadId ? " is-selected" : "") +
        '" title="' +
        self.esc(self.loadLabel(r)) +
        '"><span></span></div>';
      var icon = L.divIcon({
        className: "gos-map-pin-wrap",
        html: html,
        iconSize: [22, 22],
        iconAnchor: [11, 11],
      });
      var popup =
        "<strong>#" +
        self.esc(self.loadLabel(r)) +
        "</strong><br>" +
        self.esc(r.carrier) +
        "<br>" +
        self.esc(r.address || "GPS") +
        "<br><span class='gos-muted'>" +
        self.esc(self.relativeTime(r.lastPositionAt)) +
        "</span>";
      if (self._markers[r.shipmentLeadId]) {
        self._markers[r.shipmentLeadId].setLatLng([r.latitude, r.longitude]);
        self._markers[r.shipmentLeadId].setIcon(icon);
        self._markers[r.shipmentLeadId].setPopupContent(popup);
      } else {
        var m = L.marker([r.latitude, r.longitude], { icon: icon }).addTo(self._map);
        m.bindPopup(popup);
        m.on("click", function () {
          self.selectTrack(r.shipmentLeadId, { zoom: 9 });
        });
        self._markers[r.shipmentLeadId] = m;
      }
    });
    Object.keys(this._markers).forEach(function (id) {
      if (!seen[id]) {
        self._map.removeLayer(self._markers[id]);
        delete self._markers[id];
      }
    });
    if (!this._selectedId && bounds.length) {
      try {
        this._map.fitBounds(bounds, { padding: [40, 40], maxZoom: 7 });
      } catch (e) {
        /* ignore */
      }
    }
  },

  bindChrome() {
    var self = this;
    var search = document.getElementById("trucking-search");
    if (search && !search._gosBound) {
      search._gosBound = true;
      search.addEventListener("input", function () {
        self.renderList(self._rows, search.value.trim());
      });
    }
    var fit = document.getElementById("trucking-fit");
    if (fit && !fit._gosBound) {
      fit._gosBound = true;
      fit.addEventListener("click", function () {
        if (!self._map) return;
        var pts = self._rows
          .filter(function (r) {
            return r.latitude != null && r.longitude != null;
          })
          .map(function (r) {
            return [r.latitude, r.longitude];
          });
        if (pts.length) {
          self._map.fitBounds(pts, { padding: [40, 40], maxZoom: 8 });
        }
      });
    }
  },

  render(root) {
    if (!root) return;
    var self = this;
    this.stopTimer();
    this.destroyMap();
    if (window.GreenOS) {
      window.GreenOS.currentModule = "trucking";
      window.GreenOS.currentSub = null;
    }
    root.innerHTML =
      '<div class="gos-module-placeholder gos-trucking" data-module="trucking">' +
      '<header class="gos-trucking__header">' +
      "<div>" +
      "<h1>Trucking</h1>" +
      '<p class="gos-muted">Live CarrierView locations inside GreenOS — tracks, map, ETA.</p>' +
      "</div>" +
      '<div class="gos-trucking__header-meta">' +
      '<span class="gos-track-pill gos-track-pill--on" id="trucking-online-pill">0 online</span>' +
      '<span class="gos-muted" id="trucking-sync">Loading…</span>' +
      "</div>" +
      "</header>" +
      '<div class="gos-trucking__board">' +
      '<aside class="gos-trucking__sidebar">' +
      '<div class="gos-trucking__sidebar-tools">' +
      '<input type="search" id="trucking-search" class="gos-trucking__search" placeholder="Search loads, carrier, phone…" autocomplete="off">' +
      "</div>" +
      '<div id="trucking-track-list" class="gos-trucking__list" aria-live="polite"></div>' +
      "</aside>" +
      '<section class="gos-trucking__map-pane">' +
      '<div class="gos-trucking__map-tools">' +
      '<button type="button" class="btn-secondary" id="trucking-fit">Fit to Map</button>' +
      "</div>" +
      '<div id="trucking-map" class="gos-trucking__map" role="img" aria-label="Live truck map"></div>' +
      '<div id="trucking-detail" class="gos-trucking__detail"></div>' +
      "</section>" +
      "</div>" +
      "</div>";

    this.bindChrome();
    this.renderDetail();

    async function paint() {
      var sync = document.getElementById("trucking-sync");
      var pill = document.getElementById("trucking-online-pill");
      if (!document.getElementById("trucking-track-list")) return;
      try {
        var data = await self.api("/trucking");
        if (!data.success) {
          if (sync) sync.textContent = data.message || "Failed";
          return;
        }
        var payload = data.data || {};
        self._rows = payload.items || [];
        if (pill) {
          pill.textContent = (payload.onlineCount || 0) + " online";
        }
        if (sync) {
          sync.textContent =
            (payload.count || 0) +
            " tracks · " +
            new Date().toLocaleTimeString() +
            " · auto 20s";
        }
        if (
          self._selectedId &&
          !self._rows.some(function (r) {
            return r.shipmentLeadId === self._selectedId;
          })
        ) {
          self._selectedId = null;
        }
        if (!self._selectedId && self._rows.length) {
          var firstOnline = self._rows.find(function (r) {
            return r.online && r.latitude != null;
          });
          self._selectedId = (firstOnline || self._rows[0]).shipmentLeadId;
        }
        var qEl = document.getElementById("trucking-search");
        self.renderList(self._rows, qEl ? qEl.value.trim() : "");
        self.renderDetail();
        await self.ensureMap();
        self.syncMarkers(self._rows);
      } catch (err) {
        if (sync) {
          sync.textContent =
            "Refresh failed" + (err && err.message ? ": " + err.message : "");
        }
      }
    }

    paint();
    this._timer = setInterval(function () {
      if (document.hidden) return;
      if (!document.getElementById("trucking-track-list")) {
        self.stopTimer();
        self.destroyMap();
        return;
      }
      paint();
    }, 20000);
  },
};

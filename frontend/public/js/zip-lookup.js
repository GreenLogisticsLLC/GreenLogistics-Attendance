/**
 * US ZIP → city / state lookup (GreenOS).
 * Binds a ZIP input to city + state fields and shows all places for that ZIP.
 */
window.GreenOSZipLookup = {
  _cache: {},
  _timers: {},

  digits(raw) {
    return String(raw == null ? "" : raw).replace(/\D/g, "").slice(0, 5);
  },

  async lookup(zip) {
    var code = this.digits(zip);
    if (code.length !== 5) return null;
    if (Object.prototype.hasOwnProperty.call(this._cache, code)) return this._cache[code];
    var token = localStorage.getItem("gl_token") || "";
    var res = await fetch("/api/geo/zip/" + encodeURIComponent(code), {
      headers: { Authorization: "Bearer " + token },
    });
    var json = await res.json().catch(function () {
      return {};
    });
    if (res.status === 404) {
      this._cache[code] = null;
      return null;
    }
    if (!res.ok || json.success === false) {
      throw new Error(json.message || "ZIP lookup failed");
    }
    var data = json.data || null;
    this._cache[code] = data;
    return data;
  },

  placeLine(p, zip) {
    var bits = [p.city, p.stateName || p.state, zip || "", p.latitude && p.longitude ? p.latitude + ", " + p.longitude : ""];
    return bits.filter(Boolean).join(" · ");
  },

  fill(data, cityEl, stateEl, hintEl) {
    if (!data) {
      if (hintEl) hintEl.textContent = "ZIP not found";
      return;
    }
    var places = data.places || [];
    var first = places[0] || data;
    if (cityEl && first.city) cityEl.value = first.city;
    if (stateEl && first.state) stateEl.value = first.state;
    if (!hintEl) return;
    if (places.length > 1) {
      hintEl.innerHTML =
        places
          .map(function (p) {
            var title = [
              p.city,
              p.stateName || p.state,
              p.latitude && p.longitude ? p.latitude + ", " + p.longitude : "",
            ]
              .filter(Boolean)
              .join(" · ");
            return (
              '<button type="button" class="gos-zip-place" title="' +
              String(title).replace(/"/g, "&quot;") +
              '" data-city="' +
              String(p.city || "").replace(/"/g, "&quot;") +
              '" data-state="' +
              String(p.state || "").replace(/"/g, "&quot;") +
              '">' +
              String(p.city || "") +
              ", " +
              String(p.state || "") +
              "</button>"
            );
          })
          .join(" ");
      hintEl.querySelectorAll(".gos-zip-place").forEach(function (btn) {
        btn.addEventListener("click", function () {
          if (cityEl) cityEl.value = btn.getAttribute("data-city") || "";
          if (stateEl) stateEl.value = btn.getAttribute("data-state") || "";
        });
      });
    } else {
      hintEl.textContent = this.placeLine(first, data.zip);
    }
  },

  /**
   * zipSelector, citySelector, stateSelector are CSS selectors inside `root`.
   */
  bind(root, zipSelector, citySelector, stateSelector) {
    var self = this;
    var zipEl = root.querySelector(zipSelector);
    if (!zipEl) return;
    zipEl.setAttribute("inputmode", "numeric");
    zipEl.setAttribute("maxlength", "10");
    zipEl.setAttribute("placeholder", "ZIP → city, state");
    var wrap = zipEl.closest("label") || zipEl.parentElement;
    var hint = wrap && wrap.querySelector(".gos-zip-hint");
    if (!hint && wrap) {
      hint = document.createElement("small");
      hint.className = "gos-zip-hint";
      wrap.appendChild(hint);
    }
    var key = zipSelector;
    function run() {
      var code = self.digits(zipEl.value);
      if (zipEl.value !== code) zipEl.value = code;
      if (!hint) return;
      if (code.length < 5) {
        hint.textContent = code.length ? "Enter 5-digit ZIP" : "";
        return;
      }
      hint.textContent = "Looking up…";
      self.lookup(code).then(function (data) {
        if (self.digits(zipEl.value) !== code) return;
        self.fill(
          data,
          root.querySelector(citySelector),
          root.querySelector(stateSelector),
          hint
        );
      }).catch(function () {
        if (hint) hint.textContent = "ZIP lookup failed";
      });
    }
    zipEl.addEventListener("input", function () {
      clearTimeout(self._timers[key]);
      self._timers[key] = setTimeout(run, 220);
    });
    zipEl.addEventListener("blur", run);
    if (self.digits(zipEl.value).length === 5) run();
  },
};

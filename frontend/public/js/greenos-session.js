/**
 * Green OS session: 20 minutes without clicks or typing signs the user out.
 * Background polls do not count as activity and do not keep new shipments coming.
 */
(function () {
  var IDLE_MS = 20 * 60 * 1000;
  var PING_GAP_MS = 20 * 1000;
  var MESSAGE =
    "Signed out after 20 minutes without activity. Sign in again to receive new shipments.";
  var lastPing = 0;
  var timer = null;

  function token() {
    try {
      return localStorage.getItem("gl_token");
    } catch (e) {
      return null;
    }
  }

  function logout(message) {
    if (!token()) return;
    try {
      localStorage.removeItem("gl_token");
    } catch (e) {}
    if (typeof window.showLogin === "function") window.showLogin();
    var err = document.getElementById("login-error");
    if (err) {
      err.textContent = message || MESSAGE;
      err.classList.remove("hidden");
    }
  }

  function arm() {
    if (timer) clearTimeout(timer);
    if (!token()) return;
    timer = setTimeout(function () {
      logout(MESSAGE);
    }, IDLE_MS);
  }

  function ping() {
    var current = token();
    if (!current) return;
    lastPing = Date.now();
    fetch("/api/v1/auth/activity", {
      method: "POST",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        Authorization: "Bearer " + current,
      },
    })
      .then(function (res) {
        if (res.status !== 401) return null;
        return res.json().catch(function () {
          return null;
        });
      })
      .then(function (body) {
        if (!body) return;
        logout(body.message || MESSAGE);
      })
      .catch(function () {});
  }

  function onActivity() {
    if (!token()) return;
    arm();
    if (Date.now() - lastPing >= PING_GAP_MS) ping();
  }

  ["pointerdown", "keydown"].forEach(function (name) {
    document.addEventListener(name, onActivity, true);
  });

  var origFetch = window.fetch.bind(window);
  window.fetch = function () {
    return origFetch.apply(window, arguments).then(function (res) {
      if (res.status === 401 && token()) {
        res
          .clone()
          .json()
          .then(function (body) {
            if (body && (body.code === "SESSION_IDLE" || /20 minutes/i.test(body.message || ""))) {
              logout(body.message || MESSAGE);
            }
          })
          .catch(function () {});
      }
      return res;
    });
  };

  if (token()) {
    arm();
    ping();
  }
})();

(function () {
  "use strict";

  // ---------------------------------------------------------------------
  // Avisos de precio por notificación push (RFC 8291/8292). Archivo aparte
  // de main.js a propósito: main.js ya está muy probado tal cual, y esta
  // función es opcional/aditiva (si algo aquí falla, el resto de la web
  // sigue funcionando exactamente igual — por eso todo va envuelto en
  // comprobaciones de soporte y try/catch).
  // ---------------------------------------------------------------------

  var data = window.__BRAND__ || {};
  var $ = function (sel, scope) { return (scope || document).querySelector(sel); };
  var escHTML = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };
  var PREFS_KEY = "kzd_alertas_prefs";

  function cargarPrefs() {
    try {
      var raw = localStorage.getItem(PREFS_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function guardarPrefs(prefs) {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (e) { /* noop */ }
  }

  // El VAPID public key llega en base64url; pushManager.subscribe necesita
  // un Uint8Array (la representación binaria bruta de esa clave).
  function urlBase64ToUint8Array(base64url) {
    var padding = "=".repeat((4 - (base64url.length % 4)) % 4);
    var base64 = (base64url + padding).replace(/-/g, "+").replace(/_/g, "/");
    var raw = atob(base64);
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  function instrumentoActivo() {
    var btn = $("[data-instrument-switch] .chip-btn.is-active");
    return btn ? btn.getAttribute("data-symbol") : (data.instruments && data.instruments[0] && data.instruments[0].symbol);
  }

  function post(ruta, body) {
    return fetch(ruta, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (json) {
        return { ok: r.ok, status: r.status, json: json };
      });
    });
  }

  function initAlertas() {
    var panel = $("[data-alertas-panel]");
    if (!panel) return;

    var soportado = ("serviceWorker" in navigator) && ("PushManager" in window) && ("Notification" in window);
    if (!soportado) {
      var aviso = $("[data-alertas-no-soportado]");
      if (aviso) aviso.hidden = false;
      var cuerpo = $("[data-alertas-body]");
      if (cuerpo) cuerpo.hidden = true;
      return;
    }

    var fieldset = $("[data-alertas-instrumentos]");
    var umbralInput = $("[data-alertas-umbral]");
    var btnActivar = $("[data-alertas-activar]");
    var btnDesactivar = $("[data-alertas-desactivar]");
    var btnTest = $("[data-alertas-test]");
    var elMensaje = $("[data-alertas-mensaje]");
    var elEstado = $("[data-alertas-estado]");

    var prefsGuardadas = cargarPrefs();
    var simboloActivo = instrumentoActivo();

    (data.instruments || []).forEach(function (inst, idx) {
      var marcado = prefsGuardadas
        ? (prefsGuardadas.symbols || []).indexOf(inst.symbol) !== -1
        : inst.symbol === simboloActivo;
      var label = document.createElement("label");
      label.className = "alertas-instrumentos__item";
      label.innerHTML = '<input type="checkbox" value="' + escHTML(inst.symbol) + '"' + (marcado ? " checked" : "") + '> ' + escHTML(inst.label);
      fieldset.appendChild(label);
    });
    if (prefsGuardadas && prefsGuardadas.thresholdPips) umbralInput.value = prefsGuardadas.thresholdPips;

    function mensaje(texto, esError) {
      if (!elMensaje) return;
      elMensaje.hidden = !texto;
      elMensaje.textContent = texto || "";
      elMensaje.classList.toggle("alertas-mensaje--error", !!esError);
    }

    function estadoUI(activo) {
      if (elEstado) elEstado.textContent = activo ? "Activados" : "Sin activar";
      if (btnActivar) btnActivar.hidden = activo;
      if (btnDesactivar) btnDesactivar.hidden = !activo;
      if (btnTest) btnTest.hidden = !activo;
    }

    function simbolosSeleccionados() {
      return Array.from(fieldset.querySelectorAll("input[type=checkbox]:checked")).map(function (i) { return i.value; });
    }

    function obtenerRegistroSW() {
      return navigator.serviceWorker.register("sw.js").then(function () {
        return navigator.serviceWorker.ready;
      });
    }

    function suscripcionActual() {
      return obtenerRegistroSW().then(function (reg) { return reg.pushManager.getSubscription(); });
    }

    // Si el navegador ya tenía una suscripción de una visita anterior,
    // reflejarlo en la interfaz sin que el usuario tenga que volver a pulsar
    // "Activar avisos".
    if (navigator.serviceWorker.controller || prefsGuardadas) {
      suscripcionActual().then(function (sub) { estadoUI(!!sub); }).catch(function () { estadoUI(false); });
    } else {
      estadoUI(false);
    }

    if (btnActivar) btnActivar.addEventListener("click", function () {
      var simbolos = simbolosSeleccionados();
      if (!simbolos.length) { mensaje("Marca al menos un instrumento para vigilar.", true); return; }
      var umbral = Math.max(1, Number(umbralInput.value) || 20);
      btnActivar.disabled = true;
      mensaje("Activando…", false);

      Promise.resolve()
        .then(function () {
          if (Notification.permission === "denied") {
            throw new Error("Has bloqueado las notificaciones para esta web. Actívalas desde el candado/ajustes del sitio en tu navegador y vuelve a intentarlo.");
          }
          if (Notification.permission === "granted") return "granted";
          return Notification.requestPermission();
        })
        .then(function (permiso) {
          if (permiso !== "granted") throw new Error("No se han concedido permisos de notificación, así que no podemos avisarte.");
          return obtenerRegistroSW();
        })
        .then(function (reg) {
          return reg.pushManager.getSubscription().then(function (sub) {
            if (sub) return sub;
            return reg.pushManager.subscribe({
              userVisibleOnly: true,
              applicationServerKey: urlBase64ToUint8Array(data.vapidPublicKey)
            });
          });
        })
        .then(function (sub) {
          return post("/api/push/suscribir", { subscription: sub.toJSON(), symbols: simbolos, thresholdPips: umbral })
            .then(function (resp) {
              if (!resp.ok) throw new Error((resp.json && resp.json.error) || "No se pudo activar (" + resp.status + ").");
              guardarPrefs({ symbols: simbolos, thresholdPips: umbral });
              estadoUI(true);
              mensaje("Avisos activados para " + simbolos.join(", ") + ". Prueba el botón de aviso de prueba para comprobar que te llega.", false);
            });
        })
        .catch(function (err) {
          mensaje(err && err.message ? err.message : "No se pudo activar los avisos.", true);
        })
        .then(function () { btnActivar.disabled = false; });
    });

    if (btnDesactivar) btnDesactivar.addEventListener("click", function () {
      btnDesactivar.disabled = true;
      suscripcionActual()
        .then(function (sub) {
          if (!sub) { estadoUI(false); return; }
          return post("/api/push/desuscribir", { endpoint: sub.endpoint })
            .catch(function () { /* aunque falle el servidor, seguimos dando de baja en el navegador */ })
            .then(function () { return sub.unsubscribe(); })
            .then(function () { estadoUI(false); mensaje("Avisos desactivados.", false); });
        })
        .catch(function (err) { mensaje(err && err.message ? err.message : "No se pudo desactivar.", true); })
        .then(function () { btnDesactivar.disabled = false; });
    });

    if (btnTest) btnTest.addEventListener("click", function () {
      btnTest.disabled = true;
      mensaje("Enviando aviso de prueba…", false);
      suscripcionActual()
        .then(function (sub) {
          if (!sub) throw new Error("No hay ninguna suscripción activa.");
          return post("/api/push/test", { subscription: sub.toJSON() });
        })
        .then(function (resp) {
          if (!resp.ok) throw new Error((resp.json && resp.json.error) || "No se pudo enviar (" + resp.status + ").");
          mensaje("Aviso de prueba enviado: debería llegarte una notificación en unos segundos.", false);
        })
        .catch(function (err) { mensaje(err && err.message ? err.message : "No se pudo enviar el aviso de prueba.", true); })
        .then(function () { btnTest.disabled = false; });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initAlertas);
  } else {
    initAlertas();
  }
})();

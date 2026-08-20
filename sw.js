// sw.js — Service Worker mínimo, solo para recibir notificaciones Web Push
// (RFC 8291) y abrir la web al pulsarlas. No cachea nada ni intercepta
// peticiones normales (no hay "fetch" handler): el sitio sigue funcionando
// exactamente igual con o sin este archivo, y una versión nueva de
// alertas.js no necesita coordinarse con este Service Worker en absoluto.
"use strict";

self.addEventListener("push", function (event) {
  var datos = { title: "Liquidez Diaria", body: "Tienes un nuevo aviso de precio." };
  try {
    if (event.data) datos = event.data.json();
  } catch (e) {
    // si el payload no es JSON válido, se usa el texto tal cual como cuerpo
    try { datos.body = event.data ? event.data.text() : datos.body; } catch (e2) { /* noop */ }
  }
  var opciones = {
    body: datos.body || "",
    icon: "assets/img/favicon.svg",
    data: datos.data || {},
    tag: (datos.data && datos.data.symbol) || "liquidez-diaria",
    renotify: true,
  };
  event.waitUntil(self.registration.showNotification(datos.title || "Liquidez Diaria", opciones));
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (lista) {
      for (var i = 0; i < lista.length; i++) {
        var cliente = lista[i];
        if ("focus" in cliente) { cliente.navigate(url); return cliente.focus(); }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});

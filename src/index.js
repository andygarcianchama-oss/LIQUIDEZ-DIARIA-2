// src/index.js
//
// Punto de entrada único para el despliegue en Cloudflare Workers (el sistema
// nuevo que sustituye a "Pages" para proyectos importados desde Git en 2026).
//
// Qué hace: para la mayoría de peticiones, sirve directamente los archivos
// estáticos del sitio (index.html, main.js, styles.css...) sin tocar nada.
// Solo cuando la petición es a /api/datos, ejecuta el "motor de precios" de
// abajo (idéntico en lógica a functions/api/datos.js, la versión pensada
// para Cloudflare Pages clásico — se mantiene también por si el proyecto se
// despliega alguna vez ahí en vez de en Workers). También expone las rutas
// /api/push/* para las alertas push (ver sección "Alertas push" más abajo)
// y el manejador scheduled() del Cron Trigger que las dispara.
import { calcularTodasLasZonas } from "./motor.js";
import { enviarWebPush } from "./webpush.js";

const SIMBOLOS = {
  EURUSD: { td: "EUR/USD", yahoo: "EURUSD=X", stooq: "eurusd", demoBase: 1.156, demoRango: 0.0065 },
  GBPUSD: { td: "GBP/USD", yahoo: "GBPUSD=X", stooq: "gbpusd", demoBase: 1.3535, demoRango: 0.0085 },
  USDJPY: { td: "USD/JPY", yahoo: "USDJPY=X", stooq: "usdjpy", demoBase: 157.35, demoRango: 0.95 },
  XAUUSD: { td: "XAU/USD", yahoo: "XAUUSD=X", stooq: "xauusd", demoBase: 4358.0, demoRango: 33.0 },
  BTCUSD: { td: "BTC/USD", yahoo: "BTC-USD", stooq: "btcusd", demoBase: 68000, demoRango: 2500 },
};
// Nº de velas de 15 min que se piden a las fuentes de datos. Se pide un
// histórico amplio (no solo las últimas horas) porque el motor de análisis
// agrega estas velas de 15 min en velas de 1H y 4H en el navegador (ver
// resamplearVelas() en main.js) para poder detectar zonas y señales en
// varias temporalidades sin tener que hacer llamadas adicionales a la API.
const VELAS_SOLICITADAS = 1000;
const CACHE_TTL = 900; // 15 minutos
const CACHE_STORE_SECONDS = 21600; // 6h de margen en la Cache API como último recurso
function jsonResponse(data, cacheControl, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": cacheControl || "no-cache, must-revalidate",
    },
  });
}
/**
 * Fuente principal: Twelve Data (twelvedata.com), plan gratuito.
 * A diferencia de Yahoo/Stooq, esta API está pensada para ser llamada desde
 * servidores (no navegadores), así que no bloquea las IPs de Cloudflare.
 * Requiere una clave gratuita guardada como variable de entorno
 * TWELVEDATA_API_KEY en el Worker (Configuración → Variables y secretos).
 * Si no hay clave configurada, esta función falla en silencio y el código
 * sigue probando las demás fuentes.
 */
async function traerTwelveData(tdSimbolo, apiKey, diag) {
  if (!apiKey) {
    diag.twelvedata = "sin API key configurada (TWELVEDATA_API_KEY)";
    return null;
  }
  const url =
    "https://api.twelvedata.com/time_series?symbol=" +
    encodeURIComponent(tdSimbolo) +
    "&interval=15min&outputsize=" + VELAS_SOLICITADAS + "&timezone=UTC&apikey=" +
    encodeURIComponent(apiKey);
  try {
    const res = await fetch(url);
    if (!res.ok) {
      diag.twelvedata = "HTTP " + res.status;
      return null;
    }
    const json = await res.json();
    if (!json || json.status === "error" || !Array.isArray(json.values)) {
      diag.twelvedata =
        "error de la API: " + (json && json.message ? json.message : JSON.stringify(json).slice(0, 200));
      return null;
    }
    const candles = [];
    for (const v of json.values) {
      const t = Math.floor(Date.parse(v.datetime.replace(" ", "T") + "Z") / 1000);
      if (!t || Number.isNaN(t)) continue;
      candles.push({
        t,
        o: parseFloat(v.open) || 0,
        h: parseFloat(v.high) || 0,
        l: parseFloat(v.low) || 0,
        c: parseFloat(v.close) || 0,
      });
    }
    candles.sort((a, b) => a.t - b.t);
    if (candles.length < 10) {
      diag.twelvedata = "solo " + candles.length + " velas válidas";
      return null;
    }
    return candles;
  } catch (e) {
    diag.twelvedata = "excepción: " + (e && e.message ? e.message : String(e));
    return null;
  }
}
async function traerYahoo(yahooSimbolo, diag) {
  const url =
    "https://query1.finance.yahoo.com/v8/finance/chart/" +
    encodeURIComponent(yahooSimbolo) +
    "?interval=15m&range=60d";
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        Accept: "*/*",
      },
    });
    if (!res.ok) { diag.yahoo = "HTTP " + res.status; return null; }
    const json = await res.json();
    const result = json && json.chart && json.chart.result && json.chart.result[0];
    if (!result) { diag.yahoo = "sin result en JSON (" + JSON.stringify(json).slice(0, 200) + ")"; return null; }
    const ts = result.timestamp;
    const q = result.indicators && result.indicators.quote && result.indicators.quote[0];
    if (!ts || !q) { diag.yahoo = "sin timestamp/quote"; return null; }
    const candles = [];
    for (let i = 0; i < ts.length; i++) {
      const o = q.open ? q.open[i] : null;
      const h = q.high ? q.high[i] : null;
      const l = q.low ? q.low[i] : null;
      const c = q.close ? q.close[i] : null;
      if (o == null || h == null || l == null || c == null) continue;
      candles.push({ t: Math.floor(ts[i]), o: +o, h: +h, l: +l, c: +c });
    }
    if (candles.length < 10) { diag.yahoo = "solo " + candles.length + " velas válidas"; return null; }
    return candles;
  } catch (e) {
    diag.yahoo = "excepción: " + (e && e.message ? e.message : String(e));
    return null;
  }
}
function parseCsvLine(line) {
  return line.split(",").map((v) => v.trim());
}
async function traerStooq(stooqSimbolo, diag) {
  const url = "https://stooq.com/q/d/l/?s=" + encodeURIComponent(stooqSimbolo) + "&i=15";
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) { diag.stooq = "HTTP " + res.status; return null; }
    const body = await res.text();
    if (!body) { diag.stooq = "respuesta vacía"; return null; }
    if (/exceeded/i.test(body)) { diag.stooq = "límite de la fuente excedido"; return null; }
    const lineas = body.trim().split(/\r\n|\r|\n/);
    if (lineas.length < 10) { diag.stooq = "solo " + lineas.length + " líneas (" + body.slice(0, 150) + ")"; return null; }
    const header = parseCsvLine(lineas.shift()).map((h) => h.toLowerCase());
    const idx = {};
    header.forEach((h, i) => {
      idx[h] = i;
    });
    if (
      idx.date == null ||
      idx.time == null ||
      idx.open == null ||
      idx.high == null ||
      idx.low == null ||
      idx.close == null
    ) {
      diag.stooq = "cabecera CSV inesperada: " + header.join(",");
      return null;
    }
    const candles = [];
    for (const linea of lineas) {
      if (!linea) continue;
      const c = parseCsvLine(linea);
      const fecha = c[idx.date];
      const hora = c[idx.time];
      if (!fecha || !hora) continue;
      const t = Date.parse(fecha + "T" + hora + "Z") / 1000;
      if (!t || Number.isNaN(t)) continue;
      candles.push({
        t: Math.floor(t),
        o: parseFloat(c[idx.open]) || 0,
        h: parseFloat(c[idx.high]) || 0,
        l: parseFloat(c[idx.low]) || 0,
        c: parseFloat(c[idx.close]) || 0,
      });
    }
    if (candles.length < 10) { diag.stooq = "solo " + candles.length + " velas válidas tras parsear"; return null; }
    return candles;
  } catch (e) {
    diag.stooq = "excepción: " + (e && e.message ? e.message : String(e));
    return null;
  }
}
/** Último recurso: datos sintéticos, siempre marcados demo:true, deterministas por día+símbolo. */
function generarDemo(cfg) {
  const candles = [];
  let ahora = Math.floor(Date.now() / 1000);
  ahora -= ahora % 900;
  let precio = cfg.demoBase;
  let seed = Math.floor(ahora / 86400) + cfg.stooq.length;
  function rand() {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  }
  for (let i = VELAS_SOLICITADAS - 1; i >= 0; i--) {
    const t = ahora - i * 900;
    const ruido = (rand() * 2 - 1) * (cfg.demoRango / 24);
    const tendencia = Math.sin(i / 18) * (cfg.demoRango / 3);
    const o = precio;
    const c = cfg.demoBase + tendencia + ruido;
    const h = Math.max(o, c) + Math.abs(ruido) * 0.6;
    const l = Math.min(o, c) - Math.abs(ruido) * 0.6;
    candles.push({
      t,
      o: +o.toFixed(6),
      h: +h.toFixed(6),
      l: +l.toFixed(6),
      c: +c.toFixed(6),
    });
    precio = c;
  }
  return candles;
}
/**
 * Igual que antes, pero factorizada aparte de manejarDatos() para que el
 * Cron Trigger de alertas push (ejecutarBarridoAlertas, más abajo) pueda
 * reusar EXACTAMENTE la misma lógica de caché/fuentes de datos que ya usa
 * la ruta /api/datos, en vez de duplicarla y arriesgarse a que ambas
 * gasten cuota de la API en vivo por separado.
 */
async function obtenerDatosSimbolo(simbolo, env, ctx) {
  const cfg = SIMBOLOS[simbolo];
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const cacheKey = new Request("https://cache.liquidezdiaria.internal/datos/" + simbolo);
  // 0) Si hay una copia reciente en caché (menos de 15 min y no era demo), se
  //    sirve directamente sin gastar cuota de la API en vivo.
  if (cache) {
    try {
      const cachedRapida = await cache.match(cacheKey);
      if (cachedRapida) {
        const dataRapida = await cachedRapida.json();
        const edad = Math.floor(Date.now() / 1000) - (dataRapida.fetched_at || 0);
        if (!dataRapida.demo && edad < CACHE_TTL) {
          dataRapida.stale = false;
          return dataRapida;
        }
      }
    } catch (e) {
      // sigue al resto del flujo
    }
  }
  const diag = {};
  let candles = await traerTwelveData(cfg.td, env.TWELVEDATA_API_KEY, diag);
  let fuente = "twelvedata";
  if (!candles) {
    candles = await traerYahoo(cfg.yahoo, diag);
    fuente = "yahoo";
  }
  if (!candles) {
    candles = await traerStooq(cfg.stooq, diag);
    fuente = "stooq";
  }
  if (candles) {
    const salida = {
      symbol: simbolo,
      candles,
      fetched_at: Math.floor(Date.now() / 1000),
      fuente,
      demo: false,
      stale: false,
    };
    if (cache) {
      const respParaGuardar = jsonResponse(salida, "public, max-age=" + CACHE_STORE_SECONDS);
      const guardar = cache.put(cacheKey, respParaGuardar);
      if (ctx && ctx.waitUntil) ctx.waitUntil(guardar); else await guardar;
    }
    return salida;
  }
  if (cache) {
    try {
      const cached = await cache.match(cacheKey);
      if (cached) {
        const data = await cached.json();
        data.stale = true;
        return data;
      }
    } catch (e) {
      // sigue al modo demo
    }
  }
  return {
    symbol: simbolo,
    candles: generarDemo(cfg),
    fetched_at: Math.floor(Date.now() / 1000),
    fuente: "demo",
    demo: true,
    stale: false,
    diag: diag, // temporal: por qué fallaron Yahoo y Stooq (quitar cuando esté diagnosticado)
  };
}
async function manejarDatos(request, env, ctx) {
  const url = new URL(request.url);
  let simbolo = (url.searchParams.get("symbol") || "EURUSD").toUpperCase().replace(/[^A-Z]/g, "");
  if (!SIMBOLOS[simbolo]) simbolo = "EURUSD";
  const datos = await obtenerDatosSimbolo(simbolo, env, ctx);
  return jsonResponse(datos, "no-cache, must-revalidate");
}

// =============================================================
// Alertas push: suscripción/desuscripción + barrido programado
// =============================================================
//
// Guardamos las suscripciones Web Push en un KV namespace (binding
// PUSH_SUBS). Mientras ese binding no exista todavía en la configuración
// del Worker (hay que crear el namespace en el dashboard de Cloudflare y
// añadirlo a wrangler.jsonc, ver comentario junto a "triggers" en ese
// archivo), estas rutas responden con un error claro en vez de tirar el
// Worker entero abajo — el resto del sitio (gráfico, zonas, setups...)
// sigue funcionando igual aunque las alertas push aún no estén activadas.

// Debe coincidir con instruments[].decimals/pip en lib/manifest.js — es la
// misma tabla, copiada aquí porque el backend no carga ese archivo (es solo
// para el navegador). Si se añade o cambia un instrumento en manifest.js,
// hay que reflejarlo también aquí para que las alertas usen los mismos
// decimales/tamaño de pip que ve el usuario en pantalla.
const INSTRUMENTOS = {
  EURUSD: { decimals: 5, pip: 0.0001 },
  GBPUSD: { decimals: 5, pip: 0.0001 },
  USDJPY: { decimals: 3, pip: 0.01 },
  XAUUSD: { decimals: 2, pip: 0.1 },
  BTCUSD: { decimals: 2, pip: 10 },
};

// Clave pública VAPID (RFC 8292) — no es secreta, se sirve también al
// navegador (ver lib/manifest.js `vapidPublicKey`) para pushManager.subscribe().
// La clave PRIVADA correspondiente se guarda como secreto del Worker
// (env.VAPID_PRIVATE_KEY_JWK, un JSON de tipo JWK) y nunca se expone aquí.
const VAPID_PUBLIC_KEY = "BL6ttFQB8xxFZWLrmgte1JBXwY0jyNicZJ7g2AtJkO5ToCyKL10uFwcOzDnqo1Tpz-NgNs9X-9gzEoQjrncLxW8";
const VAPID_SUBJECT = "mailto:andygarcianchama@gmail.com";
const COOLDOWN_NOTIF_SEGUNDOS = 6 * 3600; // no repetir el mismo aviso (misma zona) antes de 6h
const UMBRAL_PIPS_POR_DEFECTO = 20;

function vapidKeysDesdeEnv(env) {
  if (!env.VAPID_PRIVATE_KEY_JWK) return null;
  let jwk;
  try { jwk = JSON.parse(env.VAPID_PRIVATE_KEY_JWK); } catch (e) { return null; }
  return { publicKeyB64url: VAPID_PUBLIC_KEY, privateJwk: jwk, subject: VAPID_SUBJECT };
}

async function sha256Hex(texto) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(texto));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function validarSuscripcion(body) {
  return !!(
    body &&
    body.subscription &&
    typeof body.subscription.endpoint === "string" &&
    body.subscription.keys &&
    typeof body.subscription.keys.p256dh === "string" &&
    typeof body.subscription.keys.auth === "string" &&
    Array.isArray(body.symbols) &&
    body.symbols.length &&
    body.symbols.every((s) => INSTRUMENTOS[s])
  );
}

async function manejarSuscribir(request, env) {
  if (!env.PUSH_SUBS) return jsonResponse({ error: "Las alertas push todavía no están configuradas en el servidor." }, "no-cache", 503);
  let body;
  try { body = await request.json(); } catch (e) { return jsonResponse({ error: "JSON inválido" }, "no-cache", 400); }
  if (!validarSuscripcion(body)) return jsonResponse({ error: "Faltan datos de la suscripción o del símbolo" }, "no-cache", 400);
  const hash = await sha256Hex(body.subscription.endpoint);
  // Si ya existía una suscripción con este endpoint (p. ej. el usuario
  // cambia qué símbolos quiere vigilar), primero borramos sus punteros
  // sub:{symbol}:{hash} antiguos para no dejar entradas huérfanas.
  const anteriorRaw = await env.PUSH_SUBS.get("subidx:" + hash);
  if (anteriorRaw) {
    try {
      const anterior = JSON.parse(anteriorRaw);
      await Promise.all((anterior.symbols || []).map((s) => env.PUSH_SUBS.delete("sub:" + s + ":" + hash)));
    } catch (e) { /* ignorar, sobrescribimos igualmente */ }
  }
  const registro = {
    subscription: body.subscription,
    symbols: body.symbols,
    thresholdPips: Number(body.thresholdPips) > 0 ? Number(body.thresholdPips) : UMBRAL_PIPS_POR_DEFECTO,
    updatedAt: Date.now(),
  };
  await env.PUSH_SUBS.put("subidx:" + hash, JSON.stringify(registro));
  await Promise.all(body.symbols.map((s) => env.PUSH_SUBS.put("sub:" + s + ":" + hash, "1")));
  return jsonResponse({ ok: true });
}

async function manejarDesuscribir(request, env) {
  if (!env.PUSH_SUBS) return jsonResponse({ error: "Las alertas push todavía no están configuradas en el servidor." }, "no-cache", 503);
  let body;
  try { body = await request.json(); } catch (e) { return jsonResponse({ error: "JSON inválido" }, "no-cache", 400); }
  if (!body || typeof body.endpoint !== "string") return jsonResponse({ error: "Falta endpoint" }, "no-cache", 400);
  const hash = await sha256Hex(body.endpoint);
  const raw = await env.PUSH_SUBS.get("subidx:" + hash);
  if (raw) {
    try {
      const registro = JSON.parse(raw);
      await Promise.all((registro.symbols || []).map((s) => env.PUSH_SUBS.delete("sub:" + s + ":" + hash)));
    } catch (e) { /* ignorar */ }
  }
  await env.PUSH_SUBS.delete("subidx:" + hash);
  return jsonResponse({ ok: true });
}

/** Envía un aviso de prueba inmediato a la suscripción indicada, para que el usuario compruebe que las notificaciones le llegan de verdad antes de confiar en las alertas de precio. */
async function manejarPushTest(request, env) {
  if (!env.PUSH_SUBS) return jsonResponse({ error: "Las alertas push todavía no están configuradas en el servidor." }, "no-cache", 503);
  const vapidKeys = vapidKeysDesdeEnv(env);
  if (!vapidKeys) return jsonResponse({ error: "Falta configurar la clave privada VAPID en el servidor." }, "no-cache", 503);
  let body;
  try { body = await request.json(); } catch (e) { return jsonResponse({ error: "JSON inválido" }, "no-cache", 400); }
  if (!body || !body.subscription) return jsonResponse({ error: "Falta la suscripción" }, "no-cache", 400);
  try {
    const resp = await enviarWebPush(body.subscription, {
      title: "✅ Alertas activadas",
      body: "Así se verá un aviso cuando el precio se acerque a una zona. Puedes desactivarlas cuando quieras.",
      data: { url: "https://liquidez-diaria-2.andygarcianchama.workers.dev/" },
    }, vapidKeys);
    if (!resp.ok) return jsonResponse({ error: "El servicio de push respondió " + resp.status }, "no-cache", 502);
    return jsonResponse({ ok: true });
  } catch (e) {
    return jsonResponse({ error: "No se pudo enviar el aviso de prueba: " + (e && e.message ? e.message : String(e)) }, "no-cache", 502);
  }
}

/**
 * Barrido periódico (Cron Trigger): para cada símbolo con suscripciones
 * activas, calcula las zonas/setups en vivo (mismo motor que ve el usuario
 * en pantalla, vía src/motor.js) y avisa por push a quien tenga el precio
 * actual dentro o cerca (según su umbral en pips) de la zona de entrada de
 * algún setup vigente. No repite el mismo aviso (misma zona) antes de
 * COOLDOWN_NOTIF_SEGUNDOS, y da de baja automáticamente las suscripciones
 * que el navegador ya descartó (respuesta 404/410 del servicio de push).
 */
async function ejecutarBarridoAlertas(env, ctx) {
  if (!env.PUSH_SUBS) return;
  const vapidKeys = vapidKeysDesdeEnv(env);
  if (!vapidKeys) return; // sin clave privada configurada todavía, no hay nada que enviar

  for (const simbolo of Object.keys(SIMBOLOS)) {
    const lista = await env.PUSH_SUBS.list({ prefix: "sub:" + simbolo + ":" });
    if (!lista.keys.length) continue; // nadie vigila este símbolo, no gastamos una petición de datos

    let datos;
    try { datos = await obtenerDatosSimbolo(simbolo, env, ctx); } catch (e) { continue; }
    if (!datos || datos.demo || !Array.isArray(datos.candles)) continue; // no alertar con datos sintéticos

    const instrumento = INSTRUMENTOS[simbolo];
    let resultado;
    try { resultado = calcularTodasLasZonas(datos.candles, instrumento); } catch (e) { continue; }
    const precioActual = resultado.precioActual;
    const setups = (resultado.zonas || []).filter((z) => z.setup && z.estado !== "mitigada");
    if (precioActual == null || !setups.length) continue;

    for (const key of lista.keys) {
      const hash = key.name.slice(("sub:" + simbolo + ":").length);
      const raw = await env.PUSH_SUBS.get("subidx:" + hash);
      if (!raw) continue;
      let registro;
      try { registro = JSON.parse(raw); } catch (e) { continue; }
      const umbral = (registro.thresholdPips || UMBRAL_PIPS_POR_DEFECTO) * instrumento.pip;

      for (const z of setups) {
        const s = z.setup;
        const dentro = precioActual >= s.entradaBaja && precioActual <= s.entradaAlta;
        const distancia = Math.min(Math.abs(precioActual - s.entradaBaja), Math.abs(precioActual - s.entradaAlta));
        if (!dentro && distancia > umbral) continue;

        const zonaKey = z.tf + "|" + z.tipo + "|" + z.direccion + "|" + z.t;
        const notifKey = "notif:" + hash + ":" + simbolo + ":" + zonaKey;
        if (await env.PUSH_SUBS.get(notifKey)) continue;

        const dec = instrumento.decimals;
        const payload = {
          title: "⚡ " + simbolo + (dentro ? ": precio DENTRO de una zona de entrada" : ": precio cerca de una zona de entrada"),
          body: (s.sesgo === "alcista" ? "Sesgo alcista" : "Sesgo bajista") + " · " + z.tfLabel +
            (z.confluencia ? " · en confluencia" : "") + " — Entrada " + s.entradaBaja.toFixed(dec) + "–" + s.entradaAlta.toFixed(dec),
          data: { url: "https://liquidez-diaria-2.andygarcianchama.workers.dev/?symbol=" + simbolo },
        };
        try {
          const resp = await enviarWebPush(registro.subscription, payload, vapidKeys);
          if (resp.status === 404 || resp.status === 410) {
            // el navegador ya no reconoce esta suscripción: la damos de baja
            await Promise.all((registro.symbols || []).map((sym) => env.PUSH_SUBS.delete("sub:" + sym + ":" + hash)));
            await env.PUSH_SUBS.delete("subidx:" + hash);
            break; // no seguir comprobando más zonas para una suscripción ya borrada
          }
          if (resp.ok) {
            await env.PUSH_SUBS.put(notifKey, "1", { expirationTtl: COOLDOWN_NOTIF_SEGUNDOS });
          }
        } catch (e) {
          // fallo transitorio de red: se reintentará en el próximo barrido
        }
      }
    }
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/datos") {
      return manejarDatos(request, env, ctx);
    }
    if (url.pathname === "/api/push/suscribir" && request.method === "POST") {
      return manejarSuscribir(request, env);
    }
    if (url.pathname === "/api/push/desuscribir" && request.method === "POST") {
      return manejarDesuscribir(request, env);
    }
    if (url.pathname === "/api/push/test" && request.method === "POST") {
      return manejarPushTest(request, env);
    }
    // Todo lo demás: sirve el sitio estático tal cual (index.html, main.js,
    // styles.css, assets/, etc.) usando el binding de assets de Cloudflare.
    return env.ASSETS.fetch(request);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(ejecutarBarridoAlertas(env, ctx));
  },
};

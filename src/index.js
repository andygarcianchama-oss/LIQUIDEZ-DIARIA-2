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
// despliega alguna vez ahí en vez de en Workers).

const SIMBOLOS = {
  EURUSD: { yahoo: "EURUSD=X", stooq: "eurusd", demoBase: 1.085, demoRango: 0.006 },
  GBPUSD: { yahoo: "GBPUSD=X", stooq: "gbpusd", demoBase: 1.265, demoRango: 0.008 },
  USDJPY: { yahoo: "USDJPY=X", stooq: "usdjpy", demoBase: 151.2, demoRango: 0.9 },
  XAUUSD: { yahoo: "XAUUSD=X", stooq: "xauusd", demoBase: 2415.0, demoRango: 18.0 },
};

const CACHE_TTL = 900; // 15 minutos
const CACHE_STORE_SECONDS = 21600; // 6h de margen en la Cache API como último recurso

function jsonResponse(data, cacheControl) {
  return new Response(JSON.stringify(data), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": cacheControl || "no-cache, must-revalidate",
    },
  });
}

async function traerYahoo(yahooSimbolo) {
  const url =
    "https://query1.finance.yahoo.com/v8/finance/chart/" +
    encodeURIComponent(yahooSimbolo) +
    "?interval=15m&range=5d";
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        Accept: "*/*",
      },
    });
    if (!res.ok) return null;
    const json = await res.json();
    const result = json && json.chart && json.chart.result && json.chart.result[0];
    if (!result) return null;
    const ts = result.timestamp;
    const q = result.indicators && result.indicators.quote && result.indicators.quote[0];
    if (!ts || !q) return null;
    const candles = [];
    for (let i = 0; i < ts.length; i++) {
      const o = q.open ? q.open[i] : null;
      const h = q.high ? q.high[i] : null;
      const l = q.low ? q.low[i] : null;
      const c = q.close ? q.close[i] : null;
      if (o == null || h == null || l == null || c == null) continue;
      candles.push({ t: Math.floor(ts[i]), o: +o, h: +h, l: +l, c: +c });
    }
    return candles.length >= 10 ? candles : null;
  } catch (e) {
    return null;
  }
}

function parseCsvLine(line) {
  return line.split(",").map((v) => v.trim());
}

async function traerStooq(stooqSimbolo) {
  const url = "https://stooq.com/q/d/l/?s=" + encodeURIComponent(stooqSimbolo) + "&i=15";
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) return null;
    const body = await res.text();
    if (!body || /exceeded/i.test(body)) return null;
    const lineas = body.trim().split(/\r\n|\r|\n/);
    if (lineas.length < 10) return null;
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
    return candles.length >= 10 ? candles : null;
  } catch (e) {
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
  for (let i = 191; i >= 0; i--) {
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

async function manejarDatos(request, env, ctx) {
  const url = new URL(request.url);
  let simbolo = (url.searchParams.get("symbol") || "EURUSD").toUpperCase().replace(/[^A-Z]/g, "");
  if (!SIMBOLOS[simbolo]) simbolo = "EURUSD";
  const cfg = SIMBOLOS[simbolo];

  const cache = typeof caches !== "undefined" ? caches.default : null;
  const cacheKey = new Request("https://cache.liquidezdiaria.internal/datos/" + simbolo);

  let candles = await traerYahoo(cfg.yahoo);
  let fuente = "yahoo";
  if (!candles) {
    candles = await traerStooq(cfg.stooq);
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
    const respParaCliente = jsonResponse(salida, "no-cache, must-revalidate");
    if (cache) {
      const respParaGuardar = jsonResponse(salida, "public, max-age=" + CACHE_STORE_SECONDS);
      ctx.waitUntil(cache.put(cacheKey, respParaGuardar));
    }
    return respParaCliente;
  }

  if (cache) {
    try {
      const cached = await cache.match(cacheKey);
      if (cached) {
        const data = await cached.json();
        data.stale = true;
        return jsonResponse(data, "no-cache, must-revalidate");
      }
    } catch (e) {
      // sigue al modo demo
    }
  }

  const demo = {
    symbol: simbolo,
    candles: generarDemo(cfg),
    fetched_at: Math.floor(Date.now() / 1000),
    fuente: "demo",
    demo: true,
    stale: false,
  };
  return jsonResponse(demo, "no-cache, must-revalidate");
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/datos") {
      return manejarDatos(request, env, ctx);
    }
    // Todo lo demás: sirve el sitio estático tal cual (index.html, main.js,
    // styles.css, assets/, etc.) usando el binding de assets de Cloudflare.
    return env.ASSETS.fetch(request);
  },
};

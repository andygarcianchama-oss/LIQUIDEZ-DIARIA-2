// functions/api/datos.js
//
// Proxy de datos OHLC intradía para Liquidez Diaria — versión Cloudflare Pages
// Functions. Hace exactamente lo mismo que api/datos.php (que se mantiene en
// el proyecto por si en algún momento se aloja en un hosting con PHP): el
// navegador del visitante no puede pedir velas de precio directamente a la
// mayoría de fuentes gratuitas (bloqueos de CORS / anti-bot), así que esta
// función corre en el servidor de Cloudflare, pide los datos una vez, los
// cachea unos minutos con la Cache API de Cloudflare y se los sirve al JS del
// sitio en un JSON idéntico al que devolvía la versión PHP.
//
// No usa ninguna clave de API de pago. Si las fuentes gratuitas fallan,
// intenta servir la última copia buena que tenga en caché (marcada "stale")
// o, si nunca hubo una copia buena, un set de datos de ejemplo claramente
// marcado "demo" para que la página nunca se quede rota.

const SIMBOLOS = {
  EURUSD: { yahoo: "EURUSD=X", stooq: "eurusd", demoBase: 1.085, demoRango: 0.006 },
  GBPUSD: { yahoo: "GBPUSD=X", stooq: "gbpusd", demoBase: 1.265, demoRango: 0.008 },
  USDJPY: { yahoo: "USDJPY=X", stooq: "usdjpy", demoBase: 151.2, demoRango: 0.9 },
  XAUUSD: { yahoo: "XAUUSD=X", stooq: "xauusd", demoBase: 2415.0, demoRango: 18.0 },
};

const CACHE_TTL = 900; // 15 minutos, igual que la versión PHP
const CACHE_STORE_SECONDS = 21600; // cuánto se conserva en la Cache API como último recurso (6h)

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
      // Asumimos que Stooq entrega hora UTC (mismo límite honesto documentado en la FAQ).
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

export async function onRequestGet(context) {
  const { request, waitUntil } = context;
  const url = new URL(request.url);
  let simbolo = (url.searchParams.get("symbol") || "EURUSD").toUpperCase().replace(/[^A-Z]/g, "");
  if (!SIMBOLOS[simbolo]) simbolo = "EURUSD";
  const cfg = SIMBOLOS[simbolo];

  const cache = typeof caches !== "undefined" ? caches.default : null;
  const cacheKey = new Request("https://cache.liquidezdiaria.internal/datos/" + simbolo);

  // 1) Intenta fuentes en vivo.
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
    if (cache && waitUntil) {
      const respParaGuardar = jsonResponse(salida, "public, max-age=" + CACHE_STORE_SECONDS);
      waitUntil(cache.put(cacheKey, respParaGuardar));
    }
    return respParaCliente;
  }

  // 2) Ambas fuentes en vivo fallaron: intenta servir la última copia cacheada, aunque esté vieja.
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

  // 3) No hay ni fuente en vivo ni caché: modo demostración explícito.
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

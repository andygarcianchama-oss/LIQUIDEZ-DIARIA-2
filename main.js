(function () {
  "use strict";

  var data = window.__BRAND__ || {};
  var $ = function (sel, scope) { return (scope || document).querySelector(sel); };
  var $$ = function (sel, scope) { return Array.prototype.slice.call((scope || document).querySelectorAll(sel)); };
  var escHTML = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };
  function safe(fn, name) { try { fn(); } catch (e) { console.warn("[" + name + "] fallo:", e); } }

  var estadoActual = { symbol: null, resultado: null };
  var cacheInstrumentos = {};

  // ---------------------------------------------------------------------
  // Utilidades de fecha/hora
  // ---------------------------------------------------------------------
  function diaUTC(tsSegundos) { return Math.floor(tsSegundos / 86400); }
  // Las sesiones y niveles se calculan internamente en UTC (es el estándar
  // para definir horarios de mercado), pero todo lo que se muestra en
  // pantalla se convierte a hora de España, con cambio de horario de
  // verano/invierno calculado automáticamente por el propio navegador.
  function horaEspanaDesdeUTC(horaUTCEntera) {
    var hoy = new Date();
    var d = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), hoy.getUTCDate(), horaUTCEntera, 0, 0));
    return new Intl.DateTimeFormat("es-ES", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Europe/Madrid" }).format(d);
  }
  function horaEspanaDesdeTs(tsSegundos) {
    var d = new Date(tsSegundos * 1000);
    return new Intl.DateTimeFormat("es-ES", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Europe/Madrid" }).format(d);
  }
  function rangoHorarioEspana(startUTC, endUTC) {
    return horaEspanaDesdeUTC(startUTC) + "–" + horaEspanaDesdeUTC(endUTC);
  }
  function fechaLegible(tsSegundos) {
    var d = new Date(tsSegundos * 1000);
    return d.toLocaleDateString("es-ES", { day: "2-digit", month: "short", timeZone: "UTC" });
  }
  function fmt(valor, decimales) {
    if (valor == null || isNaN(valor)) return "—";
    return Number(valor).toFixed(decimales);
  }

  // ---------------------------------------------------------------------
  // Motor ICT / SMC — puramente determinista sobre las velas recibidas
  // ---------------------------------------------------------------------
  function calcularAnalisis(candles, instrumento) {
    if (!candles || candles.length < 5) return null;
    var ordenadas = candles.slice().sort(function (a, b) { return a.t - b.t; });

    var dias = [];
    ordenadas.forEach(function (v) {
      var dk = diaUTC(v.t);
      if (dias.indexOf(dk) === -1) dias.push(dk);
    });
    if (dias.length < 2) return null;
    dias.sort(function (a, b) { return a - b; });
    var hoyKey = dias[dias.length - 1];
    var ayerKey = dias[dias.length - 2];

    var velasAyer = ordenadas.filter(function (v) { return diaUTC(v.t) === ayerKey; });
    var velasHoy = ordenadas.filter(function (v) { return diaUTC(v.t) === hoyKey; });

    var PDH = Math.max.apply(null, velasAyer.map(function (v) { return v.h; }));
    var PDL = Math.min.apply(null, velasAyer.map(function (v) { return v.l; }));

    var sesiones = (data.sessions || []).map(function (s) {
      var velasSesion = velasAyer.filter(function (v) {
        var hUTC = new Date(v.t * 1000).getUTCHours();
        return hUTC >= s.startUTC && hUTC < s.endUTC;
      });
      var rango = rangoHorarioEspana(s.startUTC, s.endUTC);
      if (!velasSesion.length) return { id: s.id, label: s.label, rango: rango, high: null, low: null };
      return {
        id: s.id,
        label: s.label,
        rango: rango,
        high: Math.max.apply(null, velasSesion.map(function (v) { return v.h; })),
        low: Math.min.apply(null, velasSesion.map(function (v) { return v.l; }))
      };
    });

    var todayHigh = velasHoy.length ? Math.max.apply(null, velasHoy.map(function (v) { return v.h; })) : null;
    var todayLow = velasHoy.length ? Math.min.apply(null, velasHoy.map(function (v) { return v.l; })) : null;
    var ultimaVela = ordenadas[ordenadas.length - 1];
    var precioActual = ultimaVela.c;

    var barridoAlcista = todayHigh != null && todayHigh > PDH;
    var barridoBajista = todayLow != null && todayLow < PDL;
    var revirtioTrasAlcista = barridoAlcista && precioActual < PDH;
    var revirtioTrasBajista = barridoBajista && precioActual > PDL;

    var ahoraMs = Date.now();
    var horaActualUTC = new Date(ahoraMs).getUTCHours();
    var sesionActual = (data.sessions || []).find(function (s) { return horaActualUTC >= s.startUTC && horaActualUTC < s.endUTC; });
    var killzoneActual = (data.killzones || []).find(function (s) { return horaActualUTC >= s.startUTC && horaActualUTC < s.endUTC; });

    var dec = instrumento.decimals;
    var relato = construirRelato({
      PDH: PDH, PDL: PDL, dec: dec,
      barridoAlcista: barridoAlcista, barridoBajista: barridoBajista,
      revirtioTrasAlcista: revirtioTrasAlcista, revirtioTrasBajista: revirtioTrasBajista,
      sesionActual: sesionActual, killzoneActual: killzoneActual, horaActualUTC: horaActualUTC
    });

    return {
      PDH: PDH, PDL: PDL, sesiones: sesiones,
      todayHigh: todayHigh, todayLow: todayLow, precioActual: precioActual,
      fechaAyer: fechaLegible(velasAyer[0].t),
      barridoAlcista: barridoAlcista, barridoBajista: barridoBajista,
      relato: relato, sesionActual: sesionActual, killzoneActual: killzoneActual,
      velasOrdenadas: ordenadas
    };
  }

  // ---------------------------------------------------------------------
  // Motor de señal técnica: estructura (BOS) + Order Block + Fibonacci
  // ---------------------------------------------------------------------
  function detectarSwings(velas, ventana) {
    ventana = ventana || 3;
    var swings = [];
    for (var i = ventana; i < velas.length - ventana; i++) {
      var esAlto = true, esBajo = true;
      for (var j = i - ventana; j <= i + ventana; j++) {
        if (j === i) continue;
        if (velas[j].h >= velas[i].h) esAlto = false;
        if (velas[j].l <= velas[i].l) esBajo = false;
      }
      if (esAlto) swings.push({ idx: i, tipo: "high", precio: velas[i].h });
      if (esBajo) swings.push({ idx: i, tipo: "low", precio: velas[i].l });
    }
    return swings;
  }

  function detectarRotura(velas, swings) {
    var lista = swings.slice().sort(function (a, b) { return a.idx - b.idx; });
    var ultimoAlto = null, ultimoBajo = null, si = 0, rotura = null;
    for (var i = 0; i < velas.length; i++) {
      while (si < lista.length && lista[si].idx === i) {
        if (lista[si].tipo === "high") ultimoAlto = lista[si]; else ultimoBajo = lista[si];
        si++;
      }
      if (ultimoAlto && velas[i].c > ultimoAlto.precio) {
        rotura = { idx: i, direccion: "alcista", swingRoto: ultimoAlto };
        ultimoAlto = null;
      }
      if (ultimoBajo && velas[i].c < ultimoBajo.precio) {
        rotura = { idx: i, direccion: "bajista", swingRoto: ultimoBajo };
        ultimoBajo = null;
      }
    }
    return rotura;
  }

  function encontrarOB(velas, rotura) {
    if (!rotura) return null;
    var inicio = rotura.swingRoto.idx, fin = rotura.idx;
    for (var i = fin; i >= inicio; i--) {
      if (rotura.direccion === "alcista" && velas[i].c < velas[i].o) return { idx: i, alto: velas[i].h, bajo: velas[i].l };
      if (rotura.direccion === "bajista" && velas[i].c > velas[i].o) return { idx: i, alto: velas[i].h, bajo: velas[i].l };
    }
    return null;
  }

  // Todas las rupturas de estructura detectadas en la serie (no solo la última)
  function detectarTodasRoturas(velas, swings) {
    var lista = swings.slice().sort(function (a, b) { return a.idx - b.idx; });
    var ultimoAlto = null, ultimoBajo = null, si = 0;
    var roturas = [];
    for (var i = 0; i < velas.length; i++) {
      while (si < lista.length && lista[si].idx === i) {
        if (lista[si].tipo === "high") ultimoAlto = lista[si]; else ultimoBajo = lista[si];
        si++;
      }
      if (ultimoAlto && velas[i].c > ultimoAlto.precio) {
        roturas.push({ idx: i, direccion: "alcista", swingRoto: ultimoAlto });
        ultimoAlto = null;
      }
      if (ultimoBajo && velas[i].c < ultimoBajo.precio) {
        roturas.push({ idx: i, direccion: "bajista", swingRoto: ultimoBajo });
        ultimoBajo = null;
      }
    }
    return roturas;
  }

  // Sin testear = el precio no ha vuelto a entrar en la zona desde que se formó.
  // Testeada = el precio ha vuelto a tocarla pero no la ha atravesado del todo.
  // Mitigada = el precio ha cerrado más allá del lado contrario: la zona ya se considera "consumida".
  function estadoOB(velas, ob, rotura) {
    var tras = velas.slice(rotura.idx + 1);
    if (!tras.length) return "sin testear";
    if (rotura.direccion === "alcista") {
      var minLow = Math.min.apply(null, tras.map(function (v) { return v.l; }));
      var minClose = Math.min.apply(null, tras.map(function (v) { return v.c; }));
      if (minClose < ob.bajo) return "mitigada";
      if (minLow <= ob.alto) return "testeada";
      return "sin testear";
    } else {
      var maxHigh = Math.max.apply(null, tras.map(function (v) { return v.h; }));
      var maxClose = Math.max.apply(null, tras.map(function (v) { return v.c; }));
      if (maxClose > ob.alto) return "mitigada";
      if (maxHigh >= ob.bajo) return "testeada";
      return "sin testear";
    }
  }

  function calcularZonasLiquidez(velas, instrumento, maxZonas) {
    maxZonas = maxZonas || 4;
    if (!velas || velas.length < 40) return [];
    var swings = detectarSwings(velas, 3);
    var roturas = detectarTodasRoturas(velas, swings);
    var zonas = [];
    for (var i = roturas.length - 1; i >= 0 && zonas.length < maxZonas; i--) {
      var rotura = roturas[i];
      var ob = encontrarOB(velas, rotura);
      if (!ob) continue;
      // evita duplicar la misma vela de origen si dos rupturas la comparten
      if (zonas.some(function (z) { return z.ob.idx === ob.idx; })) continue;
      zonas.push({
        direccion: rotura.direccion,
        ob: ob,
        estado: estadoOB(velas, ob, rotura),
        t: velas[ob.idx].t
      });
    }
    return zonas;
  }

  function pintarZonasLiquidez(instrumento, zonas) {
    var cont = $("[data-zonas-liquidez]");
    var vacio = $("[data-zonas-vacio]");
    if (!cont) return;
    if (!zonas.length) {
      cont.innerHTML = "";
      if (vacio) vacio.hidden = false;
      return;
    }
    if (vacio) vacio.hidden = true;
    var dec = instrumento.decimals;
    var estadoTexto = { "sin testear": "Sin testear", "testeada": "Testeada", "mitigada": "Mitigada" };
    cont.innerHTML = zonas.map(function (z) {
      var fecha = new Date(z.t * 1000).toLocaleString("es-ES", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Madrid" });
      return '<div class="zona-liquidez zona-liquidez--' + z.direccion + ' zona-liquidez--' + z.estado.replace(" ", "-") + '">' +
        '<div class="zona-liquidez__top">' +
        '<span class="zona-liquidez__tipo">' + (z.direccion === "alcista" ? "Bloque de órdenes alcista" : "Bloque de órdenes bajista") + '</span>' +
        '<span class="zona-liquidez__estado">' + estadoTexto[z.estado] + '</span>' +
        '</div>' +
        '<span class="zona-liquidez__rango">' + fmt(z.ob.bajo, dec) + ' – ' + fmt(z.ob.alto, dec) + '</span>' +
        '<span class="zona-liquidez__fecha">Formado ' + fecha + ' (hora de España)</span>' +
        '</div>';
    }).join("");
  }

  function calcularSenal(velas, instrumento, PDH, PDL) {
    if (!velas || velas.length < 40) return { sesgo: "neutral", motivo: "No hay velas suficientes todavía para evaluar la estructura." };
    var swings = detectarSwings(velas, 3);
    var rotura = detectarRotura(velas, swings);
    if (!rotura) return { sesgo: "neutral", motivo: "No se ha detectado una ruptura de estructura (BOS) clara en las velas recientes." };
    var ob = encontrarOB(velas, rotura);
    if (!ob) return { sesgo: "neutral", motivo: "Hay una ruptura de estructura, pero no se identifica un Order Block claro que la origine." };

    var buffer = instrumento.pip * 10;
    var dec = instrumento.decimals;

    if (rotura.direccion === "alcista") {
      var segTramo = velas.slice(ob.idx, rotura.idx + 1);
      var puntoBajo = Math.min.apply(null, segTramo.map(function (v) { return v.l; }));
      var segExt = velas.slice(rotura.idx);
      var puntoAlto = Math.max.apply(null, segExt.map(function (v) { return v.h; }));
      var rango = puntoAlto - puntoBajo;
      if (rango <= buffer) return { sesgo: "neutral", motivo: "El movimiento detectado es demasiado pequeño para calcular niveles fiables." };
      var fibo618 = puntoAlto - rango * 0.618;
      var fibo79 = puntoAlto - rango * 0.79;
      var entradaBaja = Math.min(fibo79, ob.bajo);
      var entradaAlta = Math.max(fibo618, ob.alto);
      var stopLoss = Math.min(puntoBajo, ob.bajo) - buffer;
      var candA = (PDH != null && PDH > puntoAlto) ? PDH : puntoAlto + rango * 0.272;
      var candB = puntoAlto + rango * 0.618;
      var tp1 = Math.min(candA, candB); // TP1 = objetivo más cercano
      var tp2 = Math.max(candA, candB); // TP2 = objetivo más lejano (extensión)
      var entradaMedia = (entradaBaja + entradaAlta) / 2;
      var riesgo = entradaMedia - stopLoss;
      var beneficio = tp1 - entradaMedia;
      return {
        sesgo: "alcista", dec: dec,
        entradaBaja: entradaBaja, entradaAlta: entradaAlta,
        stopLoss: stopLoss, tp1: tp1, tp2: tp2,
        rr: riesgo > 0 ? (beneficio / riesgo) : null,
        ob: ob
      };
    } else {
      var segTramo2 = velas.slice(ob.idx, rotura.idx + 1);
      var puntoAlto2 = Math.max.apply(null, segTramo2.map(function (v) { return v.h; }));
      var segExt2 = velas.slice(rotura.idx);
      var puntoBajo2 = Math.min.apply(null, segExt2.map(function (v) { return v.l; }));
      var rango2 = puntoAlto2 - puntoBajo2;
      if (rango2 <= buffer) return { sesgo: "neutral", motivo: "El movimiento detectado es demasiado pequeño para calcular niveles fiables." };
      var fibo618b = puntoBajo2 + rango2 * 0.618;
      var fibo79b = puntoBajo2 + rango2 * 0.79;
      var entradaBaja2 = Math.min(fibo618b, ob.bajo);
      var entradaAlta2 = Math.max(fibo79b, ob.alto);
      var stopLoss2 = Math.max(puntoAlto2, ob.alto) + buffer;
      var candA2 = (PDL != null && PDL < puntoBajo2) ? PDL : puntoBajo2 - rango2 * 0.272;
      var candB2 = puntoBajo2 - rango2 * 0.618;
      var tp1b = Math.max(candA2, candB2); // TP1 = objetivo más cercano (precio menos bajo)
      var tp2b = Math.min(candA2, candB2); // TP2 = objetivo más lejano (extensión)
      var entradaMedia2 = (entradaBaja2 + entradaAlta2) / 2;
      var riesgo2 = stopLoss2 - entradaMedia2;
      var beneficio2 = entradaMedia2 - tp1b;
      return {
        sesgo: "bajista", dec: dec,
        entradaBaja: entradaBaja2, entradaAlta: entradaAlta2,
        stopLoss: stopLoss2, tp1: tp1b, tp2: tp2b,
        rr: riesgo2 > 0 ? (beneficio2 / riesgo2) : null,
        ob: ob
      };
    }
  }

  function pintarSenal(instrumento, senal) {
    var panel = $("[data-senal-panel]");
    if (!panel) return;
    var dec = instrumento.decimals;
    panel.setAttribute("data-sesgo", senal.sesgo);

    var badge = $("[data-senal-badge]");
    if (badge) {
      var textos = { alcista: "Sesgo alcista", bajista: "Sesgo bajista", neutral: "Sin señal clara ahora mismo" };
      badge.textContent = textos[senal.sesgo] || "Sin señal";
    }

    var vacio = $("[data-senal-neutral]");
    var niveles = $("[data-senal-niveles]");
    if (senal.sesgo === "neutral") {
      if (niveles) niveles.hidden = true;
      if (vacio) { vacio.hidden = false; vacio.textContent = senal.motivo || "No hay una señal técnica clara ahora mismo con las reglas de esta herramienta. Vigila los niveles PDH/PDL de arriba."; }
      return;
    }
    if (vacio) vacio.hidden = true;
    if (niveles) niveles.hidden = false;

    var setTxt = function (sel, val) { var el = $(sel); if (el) el.textContent = val; };
    setTxt("[data-senal-entrada]", fmt(senal.entradaBaja, dec) + " – " + fmt(senal.entradaAlta, dec));
    setTxt("[data-senal-sl]", fmt(senal.stopLoss, dec));
    setTxt("[data-senal-tp1]", fmt(senal.tp1, dec));
    setTxt("[data-senal-tp2]", fmt(senal.tp2, dec));
    setTxt("[data-senal-rr]", senal.rr != null && isFinite(senal.rr) ? ("1:" + senal.rr.toFixed(2)) : "—");
    setTxt("[data-senal-ob]", fmt(senal.ob.bajo, dec) + " – " + fmt(senal.ob.alto, dec));
    setTxt("[data-senal-explicacion]",
      (senal.sesgo === "alcista"
        ? "Estructura alcista: el precio rompió un máximo previo (BOS) tras un impulso que nació en el Order Block señalado. La zona de entrada combina ese Order Block con el retroceso de Fibonacci 61,8%–79% del impulso."
        : "Estructura bajista: el precio rompió un mínimo previo (BOS) tras un impulso que nació en el Order Block señalado. La zona de entrada combina ese Order Block con el retroceso de Fibonacci 61,8%–79% del impulso.")
      + " El stop loss queda más allá del Order Block y el primer objetivo apunta a la siguiente liquidez no capturada."
    );
  }

  // ---------------------------------------------------------------------
  // Gauge de "Momentum del día" — calculado en el navegador a partir de la
  // propia estructura/rango reciente del instrumento que se está mirando.
  // No es un índice de sentimiento de mercado agregado ni de terceros: es
  // una lectura rápida de dónde cotiza el precio dentro de su rango
  // reciente y hacia qué lado se ha movido, con las mismas velas que ya
  // usa el resto de la herramienta.
  // ---------------------------------------------------------------------
  function calcularMomentum(velas, instrumento) {
    if (!velas || velas.length < 20) return null;
    var ventana = velas.length > 96 ? velas.slice(velas.length - 96) : velas.slice();
    if (ventana.length < 20) return null;

    var maxH = Math.max.apply(null, ventana.map(function (v) { return v.h; }));
    var minL = Math.min.apply(null, ventana.map(function (v) { return v.l; }));
    var rango = maxH - minL;
    var precioActual = ventana[ventana.length - 1].c;
    // Posición del precio actual dentro del rango reciente (0 = en el mínimo, 1 = en el máximo)
    var posicion = rango > 0 ? (precioActual - minL) / rango : 0.5;

    // Tendencia: compara el cierre actual con el cierre de la primera mitad de la ventana
    var idxInicio = Math.floor(ventana.length / 2);
    var precioInicio = ventana[idxInicio].c;
    var cambioAbs = precioActual - precioInicio;
    var refMovimiento = (instrumento.pip || 0.0001) * 300; // referencia de "movimiento grande" para este instrumento
    var tendenciaNormalizada = refMovimiento > 0 ? Math.max(-1, Math.min(1, cambioAbs / refMovimiento)) : 0;

    // 60% posición en el rango reciente + 40% tendencia reciente, todo reescalado a 0–100
    var score = (posicion * 0.6 + ((tendenciaNormalizada + 1) / 2) * 0.4) * 100;
    return Math.max(0, Math.min(100, Math.round(score)));
  }

  function etiquetaMomentum(score) {
    if (score == null) return { texto: "Sin datos suficientes", clase: "neutral" };
    if (score >= 80) return { texto: "Codicia extrema", clase: "codicia-extrema" };
    if (score >= 60) return { texto: "Codicia", clase: "codicia" };
    if (score >= 40) return { texto: "Neutral", clase: "neutral" };
    if (score >= 20) return { texto: "Miedo", clase: "miedo" };
    return { texto: "Miedo extremo", clase: "miedo-extremo" };
  }

  function pintarGauge(score) {
    var panel = $("[data-gauge-panel]");
    if (!panel) return;
    var etiqueta = etiquetaMomentum(score);
    var badge = $("[data-gauge-badge]");
    if (badge) {
      badge.textContent = etiqueta.texto;
      badge.setAttribute("data-gauge-clase", etiqueta.clase);
    }
    var valorEl = $("[data-gauge-valor]");
    var arc = $("[data-gauge-arc]");
    var needle = $("[data-gauge-needle]");
    if (score == null) {
      if (valorEl) valorEl.textContent = "—";
      return;
    }
    if (valorEl) valorEl.textContent = String(score);
    if (arc) {
      var longitudTotal = 282.74; // perímetro aproximado del arco (PI * radio 90)
      var longitudLlena = longitudTotal * (score / 100);
      arc.setAttribute("stroke-dasharray", longitudLlena.toFixed(2) + " " + longitudTotal.toFixed(2));
      arc.style.stroke = score >= 60 ? "var(--up)" : (score <= 40 ? "var(--down)" : "var(--accent)");
    }
    if (needle) {
      var angulo = -90 + (score / 100) * 180; // -90° (izquierda/miedo) a +90° (derecha/codicia)
      needle.setAttribute("transform", "rotate(" + angulo.toFixed(1) + ")");
    }
  }

  function construirRelato(p) {
    var dec = p.dec;
    var pdh = fmt(p.PDH, dec), pdl = fmt(p.PDL, dec);
    var frases = [];

    if (p.barridoAlcista && p.revirtioTrasAlcista) {
      frases.push("El precio ya superó el máximo del día anterior (" + pdh + ") y ha vuelto a cotizar por debajo. Bajo la lógica ICT/SMC esto se lee como un posible barrido de liquidez al alza (un \"movimiento trampa\" o \"judas swing\"), un patrón que suele preceder una búsqueda de liquidez hacia abajo, con el mínimo del día anterior (" + pdl + ") como objetivo de liquidez.");
    } else if (p.barridoAlcista) {
      frases.push("El precio ha superado el máximo del día anterior (" + pdh + ") y por ahora se mantiene por encima, sin confirmar un rechazo. Conviene vigilar si aparece un cierre de vuelta por debajo de ese nivel para considerar el escenario de barrido de liquidez.");
    }
    if (p.barridoBajista && p.revirtioTrasBajista) {
      frases.push("También ha operado por debajo del mínimo del día anterior (" + pdl + ") y ha vuelto a cotizar por encima. Ese barrido a la baja apunta, según la metodología, a una posible búsqueda de liquidez hacia el máximo del día anterior (" + pdh + ").");
    } else if (p.barridoBajista) {
      frases.push("El precio ha perforado el mínimo del día anterior (" + pdl + ") y de momento sigue por debajo, sin confirmar el rechazo al alza.");
    }
    if (!p.barridoAlcista && !p.barridoBajista) {
      frases.push("Todavía no se ha barrido ni el máximo (" + pdh + ") ni el mínimo (" + pdl + ") del día anterior. En la metodología ICT, ambos niveles siguen actuando como imanes de liquidez; la zona horaria clave de Londres o de Nueva York suele ser el momento con más probabilidad de que ocurra ese movimiento.");
    }
    if (p.barridoAlcista && p.barridoBajista) {
      frases.push("El precio ha tomado liquidez en ambos extremos del rango anterior, así que la estructura es menos clara por sí sola: conviene esperar confirmación adicional (ruptura de estructura, un hueco de valor razonable) antes de plantear cualquier sesgo.");
    }

    if (p.killzoneActual) {
      frases.push("Ahora mismo (" + horaEspanaDesdeUTC(p.horaActualUTC) + " hora de España aprox.) el mercado está dentro de la " + p.killzoneActual.label + ", la franja horaria que la metodología señala como más propensa a movimientos direccionales.");
    } else if (p.sesionActual) {
      frases.push("Ahora mismo el mercado está en la " + p.sesionActual.label + ", fuera de las zonas horarias clave principales de Londres y Nueva York.");
    } else {
      frases.push("Ahora mismo el mercado está fuera de las sesiones principales (probablemente cierre de fin de semana o baja liquidez).");
    }

    frases.push("Este es un razonamiento metodológico sobre datos históricos, no una previsión garantizada ni una recomendación personalizada de inversión.");
    return frases.join(" ");
  }

  // ---------------------------------------------------------------------
  // Carga de datos + render
  // ---------------------------------------------------------------------
  function cargarInstrumento(symbol) {
    var instrumento = (data.instruments || []).find(function (i) { return i.symbol === symbol; });
    if (!instrumento) return;
    estadoActual.symbol = symbol;
    mostrarEstado("cargando");

    if (cacheInstrumentos[symbol] && (Date.now() - cacheInstrumentos[symbol]._t) < 5 * 60 * 1000) {
      pintarResultado(instrumento, cacheInstrumentos[symbol]);
      return;
    }

    // Prueba primero la ruta de función serverless (Cloudflare Pages: /api/datos).
    // Si no existe (p. ej. en un hosting con PHP donde en su lugar corre
    // api/datos.php), cae automáticamente a la ruta PHP. Así el mismo sitio
    // funciona sin cambios en cualquiera de los dos tipos de hosting.
    fetch("/api/datos?symbol=" + encodeURIComponent(symbol), { cache: "no-store" })
      .then(function (r) {
        if (r.status === 404) {
          return fetch("api/datos.php?symbol=" + encodeURIComponent(symbol), { cache: "no-store" });
        }
        return r;
      })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (json) {
        json._t = Date.now();
        cacheInstrumentos[symbol] = json;
        if (estadoActual.symbol === symbol) pintarResultado(instrumento, json);
      })
      .catch(function (err) {
        console.warn("[cargarInstrumento] error:", err);
        if (estadoActual.symbol === symbol) mostrarEstado("error");
      });
  }

  function mostrarEstado(estado) {
    var card = $("[data-tool-card]");
    if (card) card.setAttribute("data-state", estado);
    var errorAviso = $("[data-error-aviso]");
    if (errorAviso) errorAviso.hidden = estado !== "error";
  }

  function initReintentar() {
    var btn = $("[data-reintentar]");
    if (!btn) return;
    btn.addEventListener("click", function () {
      if (estadoActual.symbol) {
        delete cacheInstrumentos[estadoActual.symbol]; // fuerza una petición nueva, no la caché
        cargarInstrumento(estadoActual.symbol);
      }
    });
  }

  function pintarResultado(instrumento, json) {
    var analisis = calcularAnalisis(json.candles, instrumento);
    if (!analisis) { mostrarEstado("error"); return; }
    estadoActual.resultado = analisis;
    mostrarEstado("done");

    var aviso = $("[data-fuente-aviso]");
    if (aviso) {
      if (json.demo) {
        aviso.hidden = false;
        aviso.textContent = "⚠ Modo demostración: no se pudo contactar con la fuente de datos en vivo, estos valores son ilustrativos.";
      } else if (json.stale) {
        aviso.hidden = false;
        aviso.textContent = "⚠ Mostrando la última actualización disponible; la fuente de datos en vivo no respondió en este momento.";
      } else {
        aviso.hidden = true;
      }
    }

    var actualizado = $("[data-actualizado]");
    if (actualizado) {
      actualizado.textContent = "Última actualización: " + horaEspanaDesdeTs(json.fetched_at || 0) + " (hora de España) · " + fechaLegibleHoy();
    }

    var dec = instrumento.decimals;
    var pdhEl = $("[data-pdh]"), pdlEl = $("[data-pdl]"), precioEl = $("[data-precio-actual]");
    if (pdhEl) pdhEl.textContent = fmt(analisis.PDH, dec);
    if (pdlEl) pdlEl.textContent = fmt(analisis.PDL, dec);
    if (precioEl) precioEl.textContent = fmt(analisis.precioActual, dec);

    var fechaAyerEl = $("[data-fecha-ayer]");
    if (fechaAyerEl) fechaAyerEl.textContent = analisis.fechaAyer;

    var cont = $("[data-sesiones]");
    if (cont) {
      cont.innerHTML = analisis.sesiones.map(function (s) {
        return '<div class="sesion-card">' +
          '<span class="sesion-card__label">' + escHTML(s.label) + '</span>' +
          '<span class="sesion-card__rango">' + escHTML(s.rango) + '</span>' +
          '<div class="sesion-card__niveles">' +
          '<span><em>Máx.</em> ' + fmt(s.high, dec) + '</span>' +
          '<span><em>Mín.</em> ' + fmt(s.low, dec) + '</span>' +
          '</div></div>';
      }).join("");
    }

    var relatoEl = $("[data-relato]");
    if (relatoEl) relatoEl.textContent = analisis.relato;

    var badges = $("[data-badges]");
    if (badges) {
      var chips = [];
      if (analisis.barridoAlcista) chips.push('<span class="chip chip--alerta">Máximo de ayer barrido</span>');
      if (analisis.barridoBajista) chips.push('<span class="chip chip--alerta">Mínimo de ayer barrido</span>');
      if (!analisis.barridoAlcista && !analisis.barridoBajista) chips.push('<span class="chip">Rango de ayer intacto</span>');
      if (analisis.killzoneActual) chips.push('<span class="chip chip--activo">' + escHTML(analisis.killzoneActual.label) + ' en curso</span>');
      badges.innerHTML = chips.join("");
    }

    safe(function () {
      var senal = calcularSenal(analisis.velasOrdenadas, instrumento, analisis.PDH, analisis.PDL);
      pintarSenal(instrumento, senal);
    }, "calcularSenal");

    safe(function () {
      var zonas = calcularZonasLiquidez(analisis.velasOrdenadas, instrumento, 4);
      pintarZonasLiquidez(instrumento, zonas);
    }, "calcularZonasLiquidez");

    safe(function () {
      var score = calcularMomentum(analisis.velasOrdenadas, instrumento);
      pintarGauge(score);
    }, "calcularMomentum");

    safe(function () { cargarGraficoTV(instrumento); }, "cargarGraficoTV");
    safe(function () { dispararPopupSiProcede(); }, "popup");
  }

  function fechaLegibleHoy() {
    return new Date().toLocaleDateString("es-ES", { day: "2-digit", month: "short", year: "numeric" });
  }

  // ---------------------------------------------------------------------
  // Selector de instrumento
  // ---------------------------------------------------------------------
  function initSelectorInstrumentos() {
    var cont = $("[data-instrument-switch]");
    if (!cont || !data.instruments) return;
    cont.innerHTML = data.instruments.map(function (i, idx) {
      return '<button type="button" role="tab" aria-selected="' + (idx === 0 ? "true" : "false") + '" class="chip-btn' + (idx === 0 ? " is-active" : "") + '" data-symbol="' + i.symbol + '">' + escHTML(i.label) + "</button>";
    }).join("");
    cont.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-symbol]");
      if (!btn) return;
      $$(".chip-btn", cont).forEach(function (b) { b.classList.remove("is-active"); b.setAttribute("aria-selected", "false"); });
      btn.classList.add("is-active");
      btn.setAttribute("aria-selected", "true");
      cargarInstrumento(btn.getAttribute("data-symbol"));
    });
    cargarInstrumento(data.instruments[0].symbol);
  }

  // ---------------------------------------------------------------------
  // Gráfico TradingView — carga perezosa, solo al hacerse visible
  // ---------------------------------------------------------------------
  var tvCargado = false, tvScriptPromesa = null;
  function cargarScriptTV() {
    if (tvScriptPromesa) return tvScriptPromesa;
    tvScriptPromesa = new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = "https://s3.tradingview.com/tv.js";
      s.async = true;
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
    return tvScriptPromesa;
  }
  function cargarGraficoTV(instrumento) {
    var contenedor = $("[data-tv-chart]");
    if (!contenedor) return;
    if (window.innerHeight === 0) return; // pestaña/segundo plano sin layout real
    contenedor.setAttribute("data-tv-symbol", instrumento.tv);
    if (!tvCargado) {
      var obs = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          obs.disconnect();
          tvCargado = true;
          cargarScriptTV().then(function () { dibujarWidgetTV(contenedor); }).catch(function () {
            contenedor.innerHTML = '<p class="tv-fallback">No se pudo cargar el gráfico en vivo (puede estar bloqueado por un bloqueador de anuncios). Los niveles calculados arriba siguen siendo válidos.</p>';
          });
        });
      }, { threshold: 0.05 });
      obs.observe(contenedor);
    } else {
      dibujarWidgetTV(contenedor);
    }
  }
  function dibujarWidgetTV(contenedor) {
    if (!window.TradingView) return;
    contenedor.innerHTML = "";
    var div = document.createElement("div");
    div.id = "tv_widget_" + Date.now();
    div.style.height = "100%";
    contenedor.appendChild(div);
    try {
      new window.TradingView.widget({
        autosize: true,
        symbol: contenedor.getAttribute("data-tv-symbol") || "OANDA:EURUSD",
        interval: "15",
        timezone: "Europe/Madrid",
        theme: "light",
        style: "1",
        locale: "es",
        toolbar_bg: "#f5f6f8",
        enable_publishing: false,
        hide_top_toolbar: false,
        allow_symbol_change: false,
        container_id: div.id
      });
    } catch (e) { console.warn("[TradingView]", e); }
  }

  // ---------------------------------------------------------------------
  // Huecos de anuncios (placeholders — nunca anuncios reales)
  // ---------------------------------------------------------------------
  function dispararPopupSiProcede() {
    if (sessionStorage.getItem("kzd_popup_visto")) return;
    var dialog = $("[data-ad-popup]");
    if (!dialog || typeof dialog.showModal !== "function") return;
    sessionStorage.setItem("kzd_popup_visto", "1");
    setTimeout(function () {
      try { dialog.showModal(); } catch (e) { /* noop */ }
    }, 900);
  }
  function initPopupCierre() {
    var dialog = $("[data-ad-popup]");
    if (!dialog) return;
    $$("[data-ad-popup-close]", dialog).forEach(function (btn) {
      btn.addEventListener("click", function () { dialog.close(); });
    });
    dialog.addEventListener("click", function (e) { if (e.target === dialog) dialog.close(); });
  }
  function initToastEsquina() {
    var toast = $("[data-ad-toast]");
    if (!toast) return;
    if (sessionStorage.getItem("kzd_toast_visto")) return;
    setTimeout(function () {
      toast.hidden = false;
      requestAnimationFrame(function () { toast.classList.add("is-visible"); });
    }, 4000);
    var cerrar = $("[data-ad-toast-close]", toast);
    if (cerrar) cerrar.addEventListener("click", function () {
      toast.classList.remove("is-visible");
      sessionStorage.setItem("kzd_toast_visto", "1");
      setTimeout(function () { toast.hidden = true; }, 300);
    });
  }

  // ---------------------------------------------------------------------
  // Contenido enriquecido (pasos, usos, FAQ) — la copia base ya está en el HTML
  // ---------------------------------------------------------------------
  function mountPasos() {
    var t = $("[data-pasos]");
    if (!t || t.children.length > 0 || !data.pasos) return;
    t.innerHTML = data.pasos.map(function (p) {
      return '<div class="paso"><h3>' + escHTML(p.titulo) + "</h3><p>" + escHTML(p.texto) + "</p></div>";
    }).join("");
  }
  function mountUsos() {
    var t = $("[data-usos]");
    if (!t || t.children.length > 0 || !data.usos) return;
    t.innerHTML = data.usos.map(function (u) {
      return '<article class="uso-card"><h3>' + escHTML(u.titulo) + "</h3><p>" + escHTML(u.texto) + "</p></article>";
    }).join("");
  }
  function mountFaqs() {
    var t = $("[data-faqs]");
    if (!t || t.children.length > 0 || !data.faqs) return;
    t.innerHTML = data.faqs.map(function (f) {
      return "<details><summary>" + escHTML(f.p) + "</summary><p>" + escHTML(f.r) + "</p></details>";
    }).join("");
  }
  function mountConceptos() {
    var t = $("[data-conceptos]");
    if (!t || t.children.length > 0 || !data.conceptos) return;
    t.innerHTML = data.conceptos.map(function (c) {
      return '<div class="concepto-card"><h3>' + escHTML(c.t) + "</h3><p>" + escHTML(c.d) + "</p></div>";
    }).join("");
  }

  // ---------------------------------------------------------------------
  // Calendario económico (noticias) — widget de TradingView, carga perezosa
  // ---------------------------------------------------------------------
  function initNoticias() {
    var contenedor = $("[data-noticias-widget]");
    if (!contenedor) return;
    var cargado = false;
    var obs = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting || cargado || window.innerHeight === 0) return;
        cargado = true;
        obs.disconnect();
        try {
          var script = document.createElement("script");
          script.src = "https://s3.tradingview.com/external-embedding/embed-widget-events.js";
          script.async = true;
          script.text = JSON.stringify({
            colorTheme: "light", isTransparent: false, width: "100%", height: 420,
            locale: "es", importanceFilter: "0,1", countryFilter: "us,eu,gb,jp"
          });
          script.onerror = function () {
            contenedor.innerHTML = '<p class="tv-fallback">No se pudo cargar el calendario de noticias (puede estar bloqueado por un bloqueador de anuncios).</p>';
          };
          contenedor.appendChild(script);
        } catch (e) {
          contenedor.innerHTML = '<p class="tv-fallback">No se pudo cargar el calendario de noticias.</p>';
        }
      });
    }, { threshold: 0.05 });
    obs.observe(contenedor);
  }

  function initAnioFooter() {
    $$("[data-anio]").forEach(function (el) { el.textContent = String(data.year || new Date().getFullYear()); });
  }

  function boot() {
    safe(mountPasos, "mountPasos");
    safe(mountUsos, "mountUsos");
    safe(mountFaqs, "mountFaqs");
    safe(mountConceptos, "mountConceptos");
    safe(initAnioFooter, "initAnioFooter");
    safe(initSelectorInstrumentos, "initSelectorInstrumentos");
    safe(initReintentar, "initReintentar");
    safe(initPopupCierre, "initPopupCierre");
    safe(initToastEsquina, "initToastEsquina");
    safe(initNoticias, "initNoticias");
    document.documentElement.classList.add("is-ready");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();

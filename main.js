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
  // El "día de trading" NO empieza a medianoche UTC: empieza cuando cierra
  // la sesión de Nueva York (las sesiones de abajo ya modelan Asia 00-08,
  // Londres 08-13 y NY 13-21 UTC, dejando 21-24 UTC como el hueco de baja
  // liquidez entre el cierre de NY y la apertura de Asia). Ese es el mismo
  // corte que usan brokers y TradingView para las velas diarias de forex y
  // oro. Antes este código cortaba a las 00:00 UTC, así que "máximo/mínimo
  // de hoy" podía incluir movimientos de las últimas horas que el broker
  // del usuario todavía contaba como "ayer" (o al revés), dando valores que
  // no cuadraban con el gráfico real.
  var ROLLOVER_DIA_UTC_SEGUNDOS = 21 * 3600;
  function diaUTC(tsSegundos) { return Math.floor((tsSegundos - ROLLOVER_DIA_UTC_SEGUNDOS) / 86400); }
  // Fecha legible de un día de trading a partir de su clave (el entero que
  // devuelve diaUTC): se toma el mediodía UTC del tramo 00-21 UTC de ese
  // día para no depender de si ya hay velas cargadas justo tras el corte.
  function fechaLegibleDia(diaKey) {
    return fechaLegible(diaKey * 86400 + ROLLOVER_DIA_UTC_SEGUNDOS + 12 * 3600);
  }
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

    // Mismas sesiones (Asia/Londres/NY) pero con las velas del día EN CURSO,
    // no del día anterior. Una sesión que todavía no ha empezado hoy queda
    // con high/low null y se pinta como "en curso" o "pendiente" en pantalla.
    var sesionesHoy = (data.sessions || []).map(function (s) {
      var velasSesion = velasHoy.filter(function (v) {
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
    var fechaHoy = velasHoy.length ? fechaLegibleDia(hoyKey) : fechaLegibleHoy();

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
      PDH: PDH, PDL: PDL, sesiones: sesiones, sesionesHoy: sesionesHoy,
      todayHigh: todayHigh, todayLow: todayLow, precioActual: precioActual,
      fechaAyer: fechaLegibleDia(ayerKey), fechaHoy: fechaHoy,
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

  // Zona del Order Block basada en el CUERPO de la vela (apertura/cierre), no
  // en la mecha completa (máximo/mínimo). Da zonas más pequeñas y precisas,
  // una variante habitual y más estricta de la definición ICT del concepto.
  function encontrarOB(velas, rotura) {
    if (!rotura) return null;
    var inicio = rotura.swingRoto.idx, fin = rotura.idx;
    for (var i = fin; i >= inicio; i--) {
      if (rotura.direccion === "alcista" && velas[i].c < velas[i].o) {
        return { idx: i, alto: Math.max(velas[i].o, velas[i].c), bajo: Math.min(velas[i].o, velas[i].c) };
      }
      if (rotura.direccion === "bajista" && velas[i].c > velas[i].o) {
        return { idx: i, alto: Math.max(velas[i].o, velas[i].c), bajo: Math.min(velas[i].o, velas[i].c) };
      }
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

  // Reagrupa velas de 15 min en velas de una temporalidad mayor (factor = nº
  // de velas de 15 min por vela nueva: 4 -> 1H, 16 -> 4H). Se hace en el
  // propio navegador para no multiplicar las peticiones a la API de datos
  // por cada temporalidad.
  function resamplearVelas(velas, factor) {
    if (!velas || !velas.length) return [];
    var segundos = factor * 900;
    var buckets = {}, orden = [];
    velas.forEach(function (v) {
      var key = Math.floor(v.t / segundos) * segundos;
      if (!buckets[key]) {
        buckets[key] = { t: key, o: v.o, h: v.h, l: v.l, c: v.c };
        orden.push(key);
      } else {
        var b = buckets[key];
        if (v.h > b.h) b.h = v.h;
        if (v.l < b.l) b.l = v.l;
        b.c = v.c; // las velas llegan en orden cronológico: el último cierre gana
      }
    });
    orden.sort(function (a, b) { return a - b; });
    return orden.map(function (k) { return buckets[k]; });
  }

  // Marca como "en confluencia" las zonas cuyo rango de precio se solapa y
  // comparten sesgo, siempre que no sean exactamente la misma zona: distinta
  // temporalidad con el mismo tipo (varias temporalidades señalando el mismo
  // Order Block/FVG) o la misma temporalidad con distinto tipo (un Order
  // Block y un FVG coincidiendo en la misma zona) cuentan como confluencia
  // según la metodología ICT/SMC.
  function detectarConfluencias(zonas) {
    zonas.forEach(function (z) { z.confluyeCon = []; });
    for (var i = 0; i < zonas.length; i++) {
      for (var j = i + 1; j < zonas.length; j++) {
        var a = zonas[i], b = zonas[j];
        if (a.tf === b.tf && a.tipo === b.tipo) continue;
        if (a.direccion !== b.direccion) continue;
        var solapa = a.ob.bajo <= b.ob.alto && b.ob.bajo <= a.ob.alto;
        if (solapa) {
          a.confluencia = true; b.confluencia = true;
          // Guardamos con qué zona concreta confluye cada una (temporalidad,
          // tipo y rango de precio) para poder señalarlo en el diagrama y en
          // el texto, no solo marcar un booleano genérico.
          a.confluyeCon.push({ tf: b.tfLabel, tipo: b.tipo, bajo: b.ob.bajo, alto: b.ob.alto });
          b.confluyeCon.push({ tf: a.tfLabel, tipo: a.tipo, bajo: a.ob.bajo, alto: a.ob.alto });
        }
      }
    }
    return zonas;
  }

  // Recorta un rango [bajo, alto] para que su anchura no supere anchoMax.
  // ancla = "alta"  -> mantiene fijo el extremo alto y sube el bajo
  // ancla = "baja"  -> mantiene fijo el extremo bajo y baja el alto
  // ancla = "centro" -> recorta simétricamente desde el centro del rango
  function limitarAncho(bajo, alto, anchoMax, ancla) {
    if (alto <= bajo || (alto - bajo) <= anchoMax) return { bajo: bajo, alto: alto };
    if (ancla === "alta") return { bajo: alto - anchoMax, alto: alto };
    if (ancla === "baja") return { bajo: bajo, alto: bajo + anchoMax };
    var centro = (bajo + alto) / 2;
    return { bajo: centro - anchoMax / 2, alto: centro + anchoMax / 2 };
  }

  // Igual que limitarAncho, pero en vez de anclar a un extremo fijo intenta
  // mantener centrada la ventana de anchoMax alrededor de un punto de
  // referencia (centro), sin salirse del rango original [bajo, alto]. Se usa
  // para que, al recortar la zona de entrada, se priorice conservar la parte
  // más "óptima" (la zona OTE de Fibonacci) en vez de recortar a ciegas desde
  // un extremo.
  function limitarAnchoAlrededor(bajo, alto, anchoMax, centro) {
    if (alto <= bajo || (alto - bajo) <= anchoMax) return { bajo: bajo, alto: alto };
    var nuevoBajo = centro - anchoMax / 2;
    var nuevoAlto = centro + anchoMax / 2;
    if (nuevoBajo < bajo) { nuevoBajo = bajo; nuevoAlto = Math.min(alto, nuevoBajo + anchoMax); }
    if (nuevoAlto > alto) { nuevoAlto = alto; nuevoBajo = Math.max(bajo, nuevoAlto - anchoMax); }
    return { bajo: nuevoBajo, alto: nuevoAlto };
  }

  // Calcula entrada/OTE/SL/TP para UN Order Block concreto (misma lógica que
  // antes usaba una sola vez para la última señal, ahora reutilizable para
  // todas las zonas detectadas en todas las temporalidades).
  function calcularSetupDesdeOB(velas, instrumento, PDH, PDL, rotura, ob) {
    var buffer = instrumento.pip * 10;
    var maxAncho = instrumento.pip * 60;
    var slDistancia = instrumento.pip * 100;
    var dec = instrumento.decimals;

    if (rotura.direccion === "alcista") {
      var segTramo = velas.slice(ob.idx, rotura.idx + 1);
      var puntoBajo = Math.min.apply(null, segTramo.map(function (v) { return v.l; }));
      var segExt = velas.slice(rotura.idx);
      var puntoAlto = Math.max.apply(null, segExt.map(function (v) { return v.h; }));
      var rango = puntoAlto - puntoBajo;
      if (rango <= buffer) return null;
      var fibo618 = puntoAlto - rango * 0.618;
      var fibo79 = puntoAlto - rango * 0.79;
      var entradaBajaCruda = Math.min(fibo79, ob.bajo);
      var entradaAltaCruda = Math.max(fibo618, ob.alto);
      var oteBajaCruda = Math.min(fibo618, fibo79), oteAltaCruda = Math.max(fibo618, fibo79);
      // Al recortar la zona de entrada priorizamos conservar la zona OTE
      // (61,8–79% de Fibonacci, el tramo más "óptimo" según ICT/SMC): la
      // ventana de anchoMax se centra en el punto medio de la OTE en vez de
      // anclarse a ciegas en un extremo.
      var oteCentro = (oteBajaCruda + oteAltaCruda) / 2;
      var entradaRec = limitarAnchoAlrededor(entradaBajaCruda, entradaAltaCruda, maxAncho, oteCentro);
      var entradaBaja = entradaRec.bajo, entradaAlta = entradaRec.alto;
      var oteRec = limitarAncho(oteBajaCruda, oteAltaCruda, maxAncho, "centro");
      // El stop se coloca a una distancia fija (100 pips) de la "primera
      // entrada del rango": en un retroceso alcista el precio llega a la zona
      // desde arriba, así que el primer borde que toca es el alto.
      var stopLoss = entradaAlta - slDistancia;
      var entradaMedia = (entradaBaja + entradaAlta) / 2;
      var riesgo = entradaMedia - stopLoss;
      // TPs pensados para scalping: se buscan los niveles de liquidez más
      // próximos EN LA DIRECCIÓN de la operación (el máximo del propio
      // movimiento, que actúa como imán de liquidez cercano, y el PDH si aún
      // no ha sido barrido), con extensiones de Fibonacci como respaldo
      // cuando no hay un nivel de liquidez claro. Se acotan entre 1,5R y 4R
      // para que los objetivos sigan siendo alcanzables en una operación
      // corta, en vez de extensiones estructurales lejanas.
      var pisoTP1 = entradaMedia + riesgo * 1.5;
      var techoTP = entradaMedia + riesgo * 4;
      var candidatosTP = [puntoAlto, (PDH != null && PDH > puntoAlto) ? PDH : null, puntoAlto + rango * 0.272, puntoAlto + rango * 0.618]
        .filter(function (v) { return v != null && v > entradaMedia; })
        .sort(function (a, b) { return a - b; });
      var clampAlcista = function (v) { return Math.min(Math.max(v, pisoTP1), techoTP); };
      var tp1 = candidatosTP.length ? clampAlcista(candidatosTP[0]) : pisoTP1;
      var restoTP = candidatosTP.filter(function (v) { return clampAlcista(v) > tp1 + 1e-9; });
      var tp2 = restoTP.length ? clampAlcista(restoTP[0]) : (entradaMedia + riesgo * 3);
      if (tp2 <= tp1) tp2 = tp1 + riesgo;
      var beneficio = tp1 - entradaMedia;
      return {
        sesgo: "alcista", dec: dec,
        entradaBaja: entradaBaja, entradaAlta: entradaAlta,
        oteBaja: oteRec.bajo, oteAlta: oteRec.alto,
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
      if (rango2 <= buffer) return null;
      var fibo618b = puntoBajo2 + rango2 * 0.618;
      var fibo79b = puntoBajo2 + rango2 * 0.79;
      var entradaBajaCruda2 = Math.min(fibo618b, ob.bajo);
      var entradaAltaCruda2 = Math.max(fibo79b, ob.alto);
      var oteBajaCruda2 = Math.min(fibo618b, fibo79b), oteAltaCruda2 = Math.max(fibo618b, fibo79b);
      // Igual que en el caso alcista: se prioriza conservar la zona OTE al
      // recortar, centrando la ventana de anchoMax en su punto medio.
      var oteCentro2 = (oteBajaCruda2 + oteAltaCruda2) / 2;
      var entradaRec2 = limitarAnchoAlrededor(entradaBajaCruda2, entradaAltaCruda2, maxAncho, oteCentro2);
      var entradaBaja2 = entradaRec2.bajo, entradaAlta2 = entradaRec2.alto;
      var oteRec2 = limitarAncho(oteBajaCruda2, oteAltaCruda2, maxAncho, "centro");
      // En un retroceso bajista el precio llega a la zona desde abajo, así
      // que el primer borde que toca es el bajo: el stop se coloca a 100
      // pips por encima de ese borde.
      var stopLoss2 = entradaBaja2 + slDistancia;
      var entradaMedia2 = (entradaBaja2 + entradaAlta2) / 2;
      var riesgo2 = stopLoss2 - entradaMedia2;
      // Igual que en el caso alcista: TPs de scalping anclados a la liquidez
      // más próxima (el mínimo del propio movimiento y el PDL si sigue sin
      // barrer), con extensiones de Fibonacci como respaldo, acotados entre
      // 1,5R y 4R para mantener objetivos realistas a corto plazo.
      var pisoTP1b = entradaMedia2 - riesgo2 * 1.5;
      var techoTPb = entradaMedia2 - riesgo2 * 4;
      var candidatosTPb = [puntoBajo2, (PDL != null && PDL < puntoBajo2) ? PDL : null, puntoBajo2 - rango2 * 0.272, puntoBajo2 - rango2 * 0.618]
        .filter(function (v) { return v != null && v < entradaMedia2; })
        .sort(function (a, b) { return b - a; });
      var clampBajista = function (v) { return Math.max(Math.min(v, pisoTP1b), techoTPb); };
      var tp1b = candidatosTPb.length ? clampBajista(candidatosTPb[0]) : pisoTP1b;
      var restoTPb = candidatosTPb.filter(function (v) { return clampBajista(v) < tp1b - 1e-9; });
      var tp2b = restoTPb.length ? clampBajista(restoTPb[0]) : (entradaMedia2 - riesgo2 * 3);
      if (tp2b >= tp1b) tp2b = tp1b - riesgo2;
      var beneficio2 = entradaMedia2 - tp1b;
      return {
        sesgo: "bajista", dec: dec,
        entradaBaja: entradaBaja2, entradaAlta: entradaAlta2,
        oteBaja: oteRec2.bajo, oteAlta: oteRec2.alto,
        stopLoss: stopLoss2, tp1: tp1b, tp2: tp2b,
        rr: riesgo2 > 0 ? (beneficio2 / riesgo2) : null,
        ob: ob
      };
    }
  }

  // Detecta TODAS las zonas de liquidez (Order Blocks) de una temporalidad
  // concreta y, para cada una, calcula también su setup de entrada asociado
  // (si el movimiento que la originó es lo bastante grande para ser fiable).
  function analizarZonasTF(velas, instrumento, PDH, PDL, tfId, tfLabel, maxZonas) {
    maxZonas = maxZonas || 20;
    if (!velas || velas.length < 40) return [];
    var maxAncho = instrumento.pip * 60;
    // Anchura mínima para que un Order Block se considere "relevante": por
    // debajo de esto (p. ej. 20-30 pips) son bloques demasiado pequeños/poco
    // fiables y se descartan, tanto si acaban como Breaker Block (mitigados)
    // como si no.
    var minAnchoOB = instrumento.pip * 40;
    var swings = detectarSwings(velas, 3);
    var roturas = detectarTodasRoturas(velas, swings);
    var zonas = [];
    for (var i = roturas.length - 1; i >= 0 && zonas.length < maxZonas; i--) {
      var rotura = roturas[i];
      var ob = encontrarOB(velas, rotura);
      if (!ob) continue;
      if ((ob.alto - ob.bajo) < minAnchoOB) continue; // descarta OB poco relevantes (demasiado estrechos)
      // evita duplicar la misma vela de origen si dos rupturas la comparten
      if (zonas.some(function (z) { return z.ob.idx === ob.idx; })) continue;
      var estado = estadoOB(velas, ob, rotura);
      var setup = null;
      safe(function () { setup = calcularSetupDesdeOB(velas, instrumento, PDH, PDL, rotura, ob); }, "calcularSetupDesdeOB");
      var rangoOB = limitarAncho(ob.bajo, ob.alto, maxAncho, "centro");
      var obMostrado = { idx: ob.idx, bajo: rangoOB.bajo, alto: rangoOB.alto };
      zonas.push({
        tf: tfId, tfLabel: tfLabel,
        tipo: "ob",
        direccion: rotura.direccion,
        ob: obMostrado,
        estado: estado,
        t: velas[ob.idx].t,
        setup: setup,
        confluencia: false
      });
    }
    return zonas;
  }

  // Detecta huecos de valor razonable (Fair Value Gap): un desequilibrio de
  // tres velas donde la mecha de la vela 1 y la de la vela 3 no llegan a
  // solaparse, dejando un hueco que el precio no ha negociado todavía.
  function detectarFVG(velas) {
    var huecos = [];
    if (!velas || velas.length < 3) return huecos;
    for (var i = 1; i < velas.length - 1; i++) {
      var previa = velas[i - 1], siguiente = velas[i + 1];
      if (siguiente.l > previa.h) {
        huecos.push({ idx: i, direccion: "alcista", bajo: previa.h, alto: siguiente.l });
      } else if (siguiente.h < previa.l) {
        huecos.push({ idx: i, direccion: "bajista", bajo: siguiente.h, alto: previa.l });
      }
    }
    return huecos;
  }

  // Clasifica el estado de un FVG según lo ocurrido tras su formación:
  // "sin testear" si el precio no ha vuelto a entrar en el hueco, "testeada"
  // si ha entrado sin cerrar del todo al otro lado, y "mitigada" (rellenado)
  // si el precio ha cerrado una vela completamente al otro lado del hueco.
  function estadoFVG(velas, fvg) {
    var estado = "sin testear";
    for (var i = fvg.idx + 2; i < velas.length; i++) {
      var v = velas[i];
      if (fvg.direccion === "alcista") {
        if (v.c <= fvg.bajo) return "mitigada";
        if (v.l <= fvg.alto) estado = "testeada";
      } else {
        if (v.c >= fvg.alto) return "mitigada";
        if (v.h >= fvg.bajo) estado = "testeada";
      }
    }
    return estado;
  }

  // Igual que analizarZonasTF pero para huecos de valor razonable (FVG). Los
  // FVG no generan un setup de entrada propio (setup: null): son zonas de
  // referencia/confluencia, no señales de trading por sí solas.
  function analizarFVGTF(velas, instrumento, tfId, tfLabel, maxZonas) {
    maxZonas = maxZonas || 20;
    if (!velas || velas.length < 10) return [];
    var maxAncho = instrumento.pip * 60;
    var huecos = detectarFVG(velas);
    var zonas = [];
    for (var i = huecos.length - 1; i >= 0 && zonas.length < maxZonas; i--) {
      var g = huecos[i];
      var estado = estadoFVG(velas, g);
      var rango = limitarAncho(g.bajo, g.alto, maxAncho, "centro");
      zonas.push({
        tf: tfId, tfLabel: tfLabel,
        tipo: "fvg",
        direccion: g.direccion,
        ob: { idx: g.idx, bajo: rango.bajo, alto: rango.alto },
        estado: estado,
        t: velas[g.idx].t,
        setup: null,
        confluencia: false
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
    // "Mitigada" en un Order Block se muestra como Breaker Block: una zona
    // que el precio ya atravesó del todo y que, según ICT/SMC, puede invertir
    // su polaridad (de soporte a resistencia o viceversa). En un FVG,
    // "mitigada" significa que el hueco quedó "rellenado" por el precio.
    var estadoTextoOB = { "sin testear": "Sin testear", "testeada": "Testeada", "mitigada": "Breaker Block" };
    var estadoTextoFVG = { "sin testear": "Sin testear", "testeada": "Testeada", "mitigada": "Rellenado" };
    var ordenadas = zonas.slice().sort(function (a, b) { return b.t - a.t; });
    cont.innerHTML = ordenadas.map(function (z) {
      var esFVG = z.tipo === "fvg";
      var fecha = new Date(z.t * 1000).toLocaleString("es-ES", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Madrid" });
      var claseEstado = z.estado === "mitigada" ? (esFVG ? "rellenado" : "breaker") : z.estado.replace(" ", "-");
      var claseTipo = esFVG ? " zona-liquidez--fvg" : "";
      var etiquetaTipo = esFVG
        ? (z.direccion === "alcista" ? "FVG alcista" : "FVG bajista")
        : (z.direccion === "alcista" ? "Bloque de órdenes alcista" : "Bloque de órdenes bajista");
      var estadoTexto = esFVG ? estadoTextoFVG : estadoTextoOB;
      return '<div class="zona-liquidez zona-liquidez--' + z.direccion + ' zona-liquidez--' + claseEstado + claseTipo + '">' +
        '<div class="zona-liquidez__top">' +
        '<span class="zona-liquidez__tf">' + escHTML(z.tfLabel) + '</span>' +
        '<span class="zona-liquidez__tipo">' + etiquetaTipo + '</span>' +
        '<span class="zona-liquidez__estado">' + estadoTexto[z.estado] + '</span>' +
        '</div>' +
        '<span class="zona-liquidez__rango">' + fmt(z.ob.bajo, dec) + ' – ' + fmt(z.ob.alto, dec) + '</span>' +
        (z.confluencia ? '<span class="chip chip--confluencia">Confluencia</span>' : '') +
        '<span class="zona-liquidez__fecha">Formado ' + fecha + ' (hora de España)</span>' +
        '</div>';
    }).join("");
  }

  // ---------------------------------------------------------------------
  // Diagrama de confluencias por setup: una "escalera de precio" SVG que
  // sitúa visualmente TP2/TP1/zona de entrada/zona OTE/stop y el precio
  // actual, y señala con un marco punteado morado cualquier otra zona
  // (de otra temporalidad o tipo) que confluya con la zona de entrada.
  // El color nunca es la única forma de distinguir algo: cada elemento
  // lleva también su etiqueta de texto y su posición en el eje de precio.
  // ---------------------------------------------------------------------
  function construirDiagramaSetup(instrumento, z, precioActual, PDH, PDL) {
    var s = z.setup;
    var dec = instrumento.decimals;
    var alcista = s.sesgo === "alcista";
    var W = 320, H = 176, ML = 74, MR = 10, MT = 10, MB = 10;
    var plotH = H - MT - MB;

    var nivelesBase = [s.stopLoss, s.tp1, s.tp2, s.entradaBaja, s.entradaAlta, s.oteBaja, s.oteAlta];
    var lo = Math.min.apply(null, nivelesBase), hi = Math.max.apply(null, nivelesBase);
    var pad = Math.max((hi - lo) * 0.12, instrumento.pip * 2);
    var domLo = lo - pad, domHi = hi + pad;
    if (domHi <= domLo) domHi = domLo + instrumento.pip; // por si el rango es degenerado

    function y(precio) {
      var t = (precio - domLo) / (domHi - domLo);
      return MT + (1 - t) * plotH;
    }
    function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
    function etq(v) { return fmt(v, dec); }

    var partes = [];
    partes.push('<rect class="diagrama__fondo" x="0" y="0" width="' + W + '" height="' + H + '" rx="8"></rect>');

    // PDH/PDL: solo si caen dentro del dominio visible (si el máximo/mínimo
    // del día anterior queda lejos, se omite para no aplastar la zona de
    // trading en una franja ilegible).
    [{ v: PDH, label: "PDH" }, { v: PDL, label: "PDL" }].forEach(function (item) {
      if (item.v == null || item.v < domLo || item.v > domHi) return;
      var yy = y(item.v);
      partes.push('<line class="diagrama__pdhpdl" x1="' + ML + '" y1="' + yy + '" x2="' + (W - MR) + '" y2="' + yy + '"></line>');
      partes.push('<text class="diagrama__pdhpdl-txt" x="' + (W - MR) + '" y="' + (yy - 3) + '" text-anchor="end">' + item.label + ' ' + etq(item.v) + '</text>');
    });

    // Zonas en confluencia con la zona de entrada: marco punteado morado +
    // etiqueta con la temporalidad y el tipo de zona que coincide aquí.
    var confluencias = (z.confluyeCon || []).slice().sort(function (a, b) { return b.alto - a.alto; });
    var MAX_TAGS = 3;
    confluencias.slice(0, MAX_TAGS).forEach(function (c, idx) {
      var cBajo = clamp(c.bajo, domLo, domHi), cAlto = clamp(c.alto, domLo, domHi);
      if (cAlto <= cBajo) { cAlto = cBajo + (domHi - domLo) * 0.01; }
      var yTop = y(cAlto), yBot = y(cBajo);
      partes.push('<rect class="diagrama__confluencia" x="' + ML + '" y="' + yTop + '" width="' + (W - ML - MR) + '" height="' + Math.max(2, yBot - yTop) + '"></rect>');
      var tipoLabel = c.tipo === "fvg" ? "FVG" : "OB";
      partes.push('<text class="diagrama__confluencia-txt" x="' + (W - MR - 2) + '" y="' + (yTop - 3 - idx * 0) + '" text-anchor="end">' + escHTML(c.tf) + ' ' + tipoLabel + '</text>');
    });
    if (confluencias.length > MAX_TAGS) {
      partes.push('<text class="diagrama__confluencia-txt" x="' + (W - MR - 2) + '" y="' + (H - 4) + '" text-anchor="end">+' + (confluencias.length - MAX_TAGS) + ' zona(s) más aquí</text>');
    }

    // Zona de entrada (banda ancha) y, dentro, la zona OTE (banda más
    // saturada) — la franja "óptima" según Fibonacci/ICT.
    var yEA = y(s.entradaAlta), yEB = y(s.entradaBaja);
    partes.push('<rect class="diagrama__entrada diagrama__entrada--' + s.sesgo + '" x="' + ML + '" y="' + yEA + '" width="' + (W - ML - MR) + '" height="' + Math.max(2, yEB - yEA) + '"></rect>');
    partes.push('<text class="diagrama__label" x="' + (ML + 6) + '" y="' + (yEA + (yEB - yEA) / 2 + 4) + '">Entrada ' + etq(s.entradaBaja) + '–' + etq(s.entradaAlta) + '</text>');
    var yOA = y(s.oteAlta), yOB = y(s.oteBaja);
    partes.push('<rect class="diagrama__ote diagrama__ote--' + s.sesgo + '" x="' + ML + '" y="' + yOA + '" width="' + (W - ML - MR) + '" height="' + Math.max(2, yOB - yOA) + '"></rect>');

    // Stop loss: línea punteada en ámbar (color de riesgo, no de dirección).
    var ySL = y(s.stopLoss);
    partes.push('<line class="diagrama__sl" x1="' + ML + '" y1="' + ySL + '" x2="' + (W - MR) + '" y2="' + ySL + '"></line>');
    partes.push('<text class="diagrama__sl-txt" x="' + ML + '" y="' + (ySL + (alcista ? 13 : -5)) + '">SL ' + etq(s.stopLoss) + '</text>');

    // TP1 / TP2: líneas sólidas en el color de la dirección de la operación.
    [{ v: s.tp1, label: "TP1" }, { v: s.tp2, label: "TP2" }].forEach(function (tp) {
      var yy = y(tp.v);
      partes.push('<line class="diagrama__tp diagrama__tp--' + s.sesgo + '" x1="' + ML + '" y1="' + yy + '" x2="' + (W - MR) + '" y2="' + yy + '"></line>');
      partes.push('<text class="diagrama__tp-txt diagrama__tp-txt--' + s.sesgo + '" x="' + ML + '" y="' + (yy - 4) + '">' + tp.label + ' ' + etq(tp.v) + '</text>');
    });

    // Precio actual: línea discontinua azul, siempre visible por encima del
    // resto. Si queda fuera del dominio visible, se ancla al borde con una
    // flecha en vez de desaparecer.
    if (precioActual != null) {
      if (precioActual >= domLo && precioActual <= domHi) {
        var yP = y(precioActual);
        partes.push('<line class="diagrama__precio" x1="' + ML + '" y1="' + yP + '" x2="' + (W - MR) + '" y2="' + yP + '"></line>');
        partes.push('<text class="diagrama__precio-txt" x="' + (ML + 6) + '" y="' + (yP - 4) + '">Precio ' + etq(precioActual) + '</text>');
      } else {
        var arriba = precioActual > domHi;
        var yEdge = arriba ? MT + 3 : H - MB - 3;
        partes.push('<text class="diagrama__precio-txt diagrama__precio-txt--fuera" x="' + (ML + 6) + '" y="' + yEdge + '">' + (arriba ? "▲" : "▼") + ' Precio ' + etq(precioActual) + '</text>');
      }
    }

    return '<svg class="setup-diagrama" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Diagrama de niveles del setup: entrada, OTE, stop y objetivos">' + partes.join("") + '</svg>';
  }

  // Pinta TODOS los setups detectados (sin límite artificial, a petición del
  // usuario), uno por cada zona de liquidez no mitigada con un movimiento de
  // origen suficientemente grande, en cualquiera de las tres temporalidades.
  function pintarSetups(instrumento, zonas, precioActual, PDH, PDL) {
    var cont = $("[data-setups]");
    var vacio = $("[data-setups-vacio]");
    var contador = $("[data-setups-contador]");
    if (!cont) return;
    var setups = zonas.filter(function (z) { return z.setup && z.estado !== "mitigada"; })
      .sort(function (a, b) { return b.t - a.t; });
    if (contador) contador.textContent = String(setups.length);
    if (!setups.length) {
      cont.innerHTML = "";
      if (vacio) vacio.hidden = false;
      return;
    }
    if (vacio) vacio.hidden = true;
    var dec = instrumento.decimals;
    cont.innerHTML = setups.map(function (z) {
      var s = z.setup;
      var fecha = new Date(z.t * 1000).toLocaleString("es-ES", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Madrid" });
      var diagrama = "";
      safe(function () { diagrama = construirDiagramaSetup(instrumento, z, precioActual, PDH, PDL); }, "construirDiagramaSetup");
      var confluenciaTxt = "";
      if (z.confluyeCon && z.confluyeCon.length) {
        var lista = z.confluyeCon.map(function (c) { return escHTML(c.tf) + " " + (c.tipo === "fvg" ? "FVG" : "OB"); }).join(", ");
        confluenciaTxt = '<span class="setup-card__confluencia-detalle">En confluencia con: ' + lista + '</span>';
      }
      return '<div class="setup-card setup-card--' + s.sesgo + '">' +
        '<div class="setup-card__top">' +
        '<span class="setup-card__tf">' + escHTML(z.tfLabel) + '</span>' +
        '<span class="setup-card__sesgo">' + (s.sesgo === "alcista" ? "Sesgo alcista" : "Sesgo bajista") + '</span>' +
        (z.confluencia ? '<span class="chip chip--confluencia">Confluencia</span>' : '') +
        '</div>' +
        '<div class="setup-card__niveles">' +
        '<span><em>Entrada</em> ' + fmt(s.entradaBaja, dec) + ' – ' + fmt(s.entradaAlta, dec) + '</span>' +
        '<span><em>Zona OTE (61,8–79%)</em> ' + fmt(s.oteBaja, dec) + ' – ' + fmt(s.oteAlta, dec) + '</span>' +
        '<span><em>Stop loss</em> ' + fmt(s.stopLoss, dec) + '</span>' +
        '<span><em>TP1</em> ' + fmt(s.tp1, dec) + '</span>' +
        '<span><em>TP2</em> ' + fmt(s.tp2, dec) + '</span>' +
        '<span><em>R:R</em> ' + (s.rr != null && isFinite(s.rr) ? ("1:" + s.rr.toFixed(2)) : "—") + '</span>' +
        '</div>' +
        diagrama + confluenciaTxt +
        '<span class="setup-card__fecha">Order Block formado ' + fecha + ' (hora de España)</span>' +
        '</div>';
    }).join("");
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
      var velas15 = analisis.velasOrdenadas;
      var velas1h = resamplearVelas(velas15, 4);
      var velas4h = resamplearVelas(velas15, 16);
      var zonas15 = analizarZonasTF(velas15, instrumento, analisis.PDH, analisis.PDL, "15m", "15m", 20);
      var zonas1h = analizarZonasTF(velas1h, instrumento, analisis.PDH, analisis.PDL, "1h", "1H", 20);
      var zonas4h = analizarZonasTF(velas4h, instrumento, analisis.PDH, analisis.PDL, "4h", "4H", 20);
      // Los FVG (Fair Value Gaps) se han retirado de "Zonas de liquidez": a
      // petición del usuario generaban demasiado ruido/dispersión frente a
      // los Order Blocks y Breaker Blocks, que son las zonas que de verdad
      // quiere vigilar. Ya no se detectan ni se mezclan en las confluencias.
      var todasZonas = detectarConfluencias(zonas15.concat(zonas1h, zonas4h));
      pintarZonasLiquidez(instrumento, todasZonas);
      pintarSetups(instrumento, todasZonas, analisis.precioActual, analisis.PDH, analisis.PDL);
    }, "analizarZonasTF");

    safe(function () {
      pintarHoy(analisis);
    }, "pintarHoy");

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
  // Panel "Hoy": máximo/mínimo y sesiones del día EN CURSO (no del día
  // anterior, que ya se muestra en el bloque de PDH/PDL de arriba).
  // ---------------------------------------------------------------------
  function pintarHoy(analisis) {
    var panel = $("[data-hoy-panel]");
    if (!panel) return;
    var instrumento = (data.instruments || []).find(function (i) { return i.symbol === estadoActual.symbol; });
    var dec = instrumento ? instrumento.decimals : 2;

    var fechaEl = $("[data-fecha-hoy]");
    if (fechaEl) fechaEl.textContent = analisis.fechaHoy;

    var maxEl = $("[data-hoy-max]"), minEl = $("[data-hoy-min]");
    if (maxEl) maxEl.textContent = fmt(analisis.todayHigh, dec);
    if (minEl) minEl.textContent = fmt(analisis.todayLow, dec);

    var cont = $("[data-sesiones-hoy]");
    if (cont) {
      cont.innerHTML = (analisis.sesionesHoy || []).map(function (s) {
        var sinDatos = s.high == null;
        return '<div class="sesion-card' + (sinDatos ? ' sesion-card--pendiente' : '') + '">' +
          '<span class="sesion-card__label">' + escHTML(s.label) + '</span>' +
          '<span class="sesion-card__rango">' + escHTML(s.rango) + '</span>' +
          '<div class="sesion-card__niveles">' +
          '<span><em>Máx.</em> ' + (sinDatos ? "—" : fmt(s.high, dec)) + '</span>' +
          '<span><em>Mín.</em> ' + (sinDatos ? "—" : fmt(s.low, dec)) + '</span>' +
          '</div></div>';
      }).join("");
    }
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
            locale: "es", importanceFilter: "-1,0,1", countryFilter: "us,eu,gb,jp"
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

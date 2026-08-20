// src/motor.js
//
// Copia, para el backend (Worker), del motor de análisis ICT/SMC puro que
// vive en main.js (detección de swings, Order Blocks, FVG, confluencias y
// el cálculo de setup asociado a cada zona). Se necesita aquí porque el
// disparador programado (Cron Trigger) tiene que saber qué setups/zonas
// existen AHORA MISMO para decidir a quién avisar por push, sin depender
// de que haya un navegador abierto ejecutando main.js.
//
// IMPORTANTE — mantenimiento: estas funciones son una copia deliberada
// (no una importación compartida) de las mismas funciones en main.js, para
// no arriesgar convertir main.js en un módulo ES y tener que revalidar todo
// el arranque del sitio sin poder probarlo en un navegador real durante
// este cambio. Si se ajusta la lógica de zonas/setups en main.js (anchura
// de zona, distancia de stop, fórmula de TP...), hay que replicar el mismo
// cambio aquí o las alertas push dejarán de coincidir con lo que ve el
// usuario en la web.
//
// Corte de "día de trading" igual que en main.js: empieza a las 21:00 UTC
// (cierre de la sesión de Nueva York), no a medianoche UTC.
export var ROLLOVER_DIA_UTC_SEGUNDOS = 21 * 3600;
export function diaUTC(tsSegundos) { return Math.floor((tsSegundos - ROLLOVER_DIA_UTC_SEGUNDOS) / 86400); }

/** Versión mínima de calcularAnalisis (main.js) que solo calcula lo que necesita el cron: PDH/PDL y precio actual del día en curso. */
export function calcularPDHPDL(candles) {
  if (!candles || candles.length < 5) return null;
  var ordenadas = candles.slice().sort(function (a, b) { return a.t - b.t; });
  var dias = [];
  ordenadas.forEach(function (v) {
    var dk = diaUTC(v.t);
    if (dias.indexOf(dk) === -1) dias.push(dk);
  });
  if (dias.length < 2) return null;
  dias.sort(function (a, b) { return a - b; });
  var ayerKey = dias[dias.length - 2];
  var velasAyer = ordenadas.filter(function (v) { return diaUTC(v.t) === ayerKey; });
  var PDH = Math.max.apply(null, velasAyer.map(function (v) { return v.h; }));
  var PDL = Math.min.apply(null, velasAyer.map(function (v) { return v.l; }));
  var precioActual = ordenadas[ordenadas.length - 1].c;
  return { PDH: PDH, PDL: PDL, precioActual: precioActual, velasOrdenadas: ordenadas };
}

export function resamplearVelas(velas, factor) {
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
      b.c = v.c;
    }
  });
  orden.sort(function (a, b) { return a - b; });
  return orden.map(function (k) { return buckets[k]; });
}

export function detectarSwings(velas, ventana) {
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

export function detectarTodasRoturas(velas, swings) {
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

export function encontrarOB(velas, rotura) {
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

export function estadoOB(velas, ob, rotura) {
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

export function limitarAncho(bajo, alto, anchoMax, ancla) {
  if (alto <= bajo || (alto - bajo) <= anchoMax) return { bajo: bajo, alto: alto };
  if (ancla === "alta") return { bajo: alto - anchoMax, alto: alto };
  if (ancla === "baja") return { bajo: bajo, alto: bajo + anchoMax };
  var centro = (bajo + alto) / 2;
  return { bajo: centro - anchoMax / 2, alto: centro + anchoMax / 2 };
}

export function limitarAnchoAlrededor(bajo, alto, anchoMax, centro) {
  if (alto <= bajo || (alto - bajo) <= anchoMax) return { bajo: bajo, alto: alto };
  var nuevoBajo = centro - anchoMax / 2;
  var nuevoAlto = centro + anchoMax / 2;
  if (nuevoBajo < bajo) { nuevoBajo = bajo; nuevoAlto = Math.min(alto, nuevoBajo + anchoMax); }
  if (nuevoAlto > alto) { nuevoAlto = alto; nuevoBajo = Math.max(bajo, nuevoAlto - anchoMax); }
  return { bajo: nuevoBajo, alto: nuevoAlto };
}

export function calcularSetupDesdeOB(velas, instrumento, PDH, PDL, rotura, ob) {
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
    var oteCentro = (oteBajaCruda + oteAltaCruda) / 2;
    var entradaRec = limitarAnchoAlrededor(entradaBajaCruda, entradaAltaCruda, maxAncho, oteCentro);
    var entradaBaja = entradaRec.bajo, entradaAlta = entradaRec.alto;
    var oteRec = limitarAncho(oteBajaCruda, oteAltaCruda, maxAncho, "centro");
    var stopLoss = entradaAlta - slDistancia;
    var entradaMedia = (entradaBaja + entradaAlta) / 2;
    var riesgo = entradaMedia - stopLoss;
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
    var oteCentro2 = (oteBajaCruda2 + oteAltaCruda2) / 2;
    var entradaRec2 = limitarAnchoAlrededor(entradaBajaCruda2, entradaAltaCruda2, maxAncho, oteCentro2);
    var entradaBaja2 = entradaRec2.bajo, entradaAlta2 = entradaRec2.alto;
    var oteRec2 = limitarAncho(oteBajaCruda2, oteAltaCruda2, maxAncho, "centro");
    var stopLoss2 = entradaBaja2 + slDistancia;
    var entradaMedia2 = (entradaBaja2 + entradaAlta2) / 2;
    var riesgo2 = stopLoss2 - entradaMedia2;
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

export function analizarZonasTF(velas, instrumento, PDH, PDL, tfId, tfLabel, maxZonas) {
  maxZonas = maxZonas || 20;
  if (!velas || velas.length < 40) return [];
  var maxAncho = instrumento.pip * 60;
  var swings = detectarSwings(velas, 3);
  var roturas = detectarTodasRoturas(velas, swings);
  var zonas = [];
  for (var i = roturas.length - 1; i >= 0 && zonas.length < maxZonas; i--) {
    var rotura = roturas[i];
    var ob = encontrarOB(velas, rotura);
    if (!ob) continue;
    if (zonas.some(function (z) { return z.ob.idx === ob.idx; })) continue;
    var estado = estadoOB(velas, ob, rotura);
    var setup = null;
    try { setup = calcularSetupDesdeOB(velas, instrumento, PDH, PDL, rotura, ob); } catch (e) { setup = null; }
    var rangoOB = limitarAncho(ob.bajo, ob.alto, maxAncho, "centro");
    var obMostrado = { idx: ob.idx, bajo: rangoOB.bajo, alto: rangoOB.alto };
    zonas.push({
      tf: tfId, tfLabel: tfLabel, tipo: "ob",
      direccion: rotura.direccion, ob: obMostrado, estado: estado,
      t: velas[ob.idx].t, setup: setup, confluencia: false
    });
  }
  return zonas;
}

export function detectarFVG(velas) {
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

export function estadoFVG(velas, fvg) {
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

export function analizarFVGTF(velas, instrumento, tfId, tfLabel, maxZonas) {
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
      tf: tfId, tfLabel: tfLabel, tipo: "fvg",
      direccion: g.direccion, ob: { idx: g.idx, bajo: rango.bajo, alto: rango.alto },
      estado: estado, t: velas[g.idx].t, setup: null, confluencia: false
    });
  }
  return zonas;
}

export function detectarConfluencias(zonas) {
  zonas.forEach(function (z) { z.confluyeCon = []; });
  for (var i = 0; i < zonas.length; i++) {
    for (var j = i + 1; j < zonas.length; j++) {
      var a = zonas[i], b = zonas[j];
      if (a.tf === b.tf && a.tipo === b.tipo) continue;
      if (a.direccion !== b.direccion) continue;
      var solapa = a.ob.bajo <= b.ob.alto && b.ob.bajo <= a.ob.alto;
      if (solapa) {
        a.confluencia = true; b.confluencia = true;
        a.confluyeCon.push({ tf: b.tfLabel, tipo: b.tipo, bajo: b.ob.bajo, alto: b.ob.alto });
        b.confluyeCon.push({ tf: a.tfLabel, tipo: a.tipo, bajo: a.ob.bajo, alto: a.ob.alto });
      }
    }
  }
  return zonas;
}

/** Calcula todas las zonas (OB + FVG, 15m/1H/4H) con confluencias marcadas, a partir de velas de 15 min crudas. Es el mismo pipeline que ejecuta pintarResultado() en main.js. */
export function calcularTodasLasZonas(candles, instrumento) {
  var info = calcularPDHPDL(candles);
  if (!info) return { zonas: [], PDH: null, PDL: null, precioActual: null };
  var velas15 = info.velasOrdenadas;
  var velas1h = resamplearVelas(velas15, 4);
  var velas4h = resamplearVelas(velas15, 16);
  var zonas15 = analizarZonasTF(velas15, instrumento, info.PDH, info.PDL, "15m", "15m", 20);
  var zonas1h = analizarZonasTF(velas1h, instrumento, info.PDH, info.PDL, "1h", "1H", 20);
  var zonas4h = analizarZonasTF(velas4h, instrumento, info.PDH, info.PDL, "4h", "4H", 20);
  var fvg15 = analizarFVGTF(velas15, instrumento, "15m", "15m", 20);
  var fvg1h = analizarFVGTF(velas1h, instrumento, "1h", "1H", 20);
  var fvg4h = analizarFVGTF(velas4h, instrumento, "4h", "4H", 20);
  var todas = detectarConfluencias(zonas15.concat(zonas1h, zonas4h, fvg15, fvg1h, fvg4h));
  return { zonas: todas, PDH: info.PDH, PDL: info.PDL, precioActual: info.precioActual };
}

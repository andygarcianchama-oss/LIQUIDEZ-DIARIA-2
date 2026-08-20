(function () {
  "use strict";

  window.__BRAND__ = {
    name: "Liquidez Diaria",
    tagline: "Niveles y contexto de mercado basados en ICT y Smart Money Concepts",
    year: new Date().getFullYear(),

    instruments: [
      { symbol: "EURUSD", label: "EUR/USD", tv: "OANDA:EURUSD", decimals: 5, pip: 0.0001 },
      { symbol: "GBPUSD", label: "GBP/USD", tv: "OANDA:GBPUSD", decimals: 5, pip: 0.0001 },
      { symbol: "USDJPY", label: "USD/JPY", tv: "OANDA:USDJPY", decimals: 3, pip: 0.01 },
      { symbol: "XAUUSD", label: "XAU/USD (Oro)", tv: "OANDA:XAUUSD", decimals: 2, pip: 0.1 },
      { symbol: "BTCUSD", label: "BTC/USD (Bitcoin)", tv: "COINBASE:BTCUSD", decimals: 2, pip: 10 }
    ],

    sessions: [
      { id: "asia", label: "Sesión Asiática", startUTC: 0, endUTC: 8 },
      { id: "londres", label: "Sesión de Londres", startUTC: 8, endUTC: 13 },
      { id: "ny", label: "Sesión de Nueva York", startUTC: 13, endUTC: 21 }
    ],

    killzones: [
      { id: "londres", label: "Zona clave de Londres", startUTC: 7, endUTC: 10 },
      { id: "ny", label: "Zona clave de Nueva York", startUTC: 12, endUTC: 15 }
    ],

    pasos: [
      {
        titulo: "1. Elige el instrumento",
        texto: "Selecciona EUR/USD, GBP/USD, USD/JPY u oro (XAU/USD). La herramienta carga automáticamente las velas más recientes, sin registro ni configuración."
      },
      {
        titulo: "2. Revisa los niveles de la sesión anterior",
        texto: "Verás el máximo y el mínimo de cada sesión (Asia, Londres, Nueva York) del día previo, además del máximo y mínimo del día completo (PDH / PDL)."
      },
      {
        titulo: "3. Lee el contexto ICT/SMC del día",
        texto: "La herramienta señala si el precio ya barrió alguno de esos extremos y qué zona de liquidez suele buscarse a continuación según la metodología, siempre en clave educativa."
      }
    ],

    usos: [
      { titulo: "Day trading intradía", texto: "Ubica rápidamente el rango del día anterior y las zonas de liquidez antes de la apertura de Londres o Nueva York." },
      { titulo: "Swing trading", texto: "Usa el PDH/PDL como referencia de estructura de mercado al planear entradas de varios días." },
      { titulo: "Estudiantes de ICT y Smart Money Concepts", texto: "Practica identificar barridos de liquidez, zonas horarias clave y objetivos de liquidez con datos reales, sin tener que dibujarlos a mano." },
      { titulo: "Gestión de riesgo antes de operar", texto: "Revisa el contexto de la sesión anterior para fijar invalidaciones (stops) coherentes con la estructura, en vez de niveles arbitrarios." },
      { titulo: "Creadores de contenido de trading", texto: "Consulta en segundos los niveles clave del día para preparar directos, publicaciones o análisis para su comunidad." }
    ],

    conceptos: [
      { t: "Acción del precio (Price Action)", d: "Analizar el movimiento del precio (velas, máximos, mínimos, rangos) sin depender de indicadores. Es la base sobre la que se apoyan tanto ICT como SMC." },
      { t: "Liquidez", d: "Las órdenes stop-loss y de entrada acumuladas por encima de máximos recientes y por debajo de mínimos recientes. El precio tiende a moverse hacia zonas de alta liquidez antes de continuar su tendencia." },
      { t: "Barrido de liquidez", d: "Movimiento que perfora un máximo o mínimo reciente para \"cazar\" los stops acumulados ahí, y después revierte con fuerza en la dirección contraria." },
      { t: "Movimiento trampa (Judas Swing)", d: "Barrido de liquidez que ocurre justo al inicio de una zona horaria clave, pensado para atrapar a los operadores que entran en la dirección equivocada antes del movimiento real." },
      { t: "Estructura de mercado", d: "La secuencia de máximos y mínimos que forma el precio. Una estructura alcista hace máximos y mínimos cada vez más altos; una bajista, cada vez más bajos." },
      { t: "Ruptura de estructura (BOS)", d: "Del inglés Break of Structure: el precio cierra más allá de un máximo o mínimo relevante, confirmando que la tendencia en curso continúa." },
      { t: "Cambio de carácter (CHoCH)", d: "Del inglés Change of Character: la primera ruptura en sentido contrario a la tendencia previa, la primera señal de que el sesgo del mercado podría estar girando." },
      { t: "Bloque de órdenes (Order Block)", d: "La última vela contraria antes de un movimiento impulsivo fuerte. Se considera una zona donde el \"dinero institucional\" dejó órdenes pendientes, y suele actuar como soporte o resistencia cuando el precio vuelve a visitarla." },
      { t: "Hueco de valor razonable (Fair Value Gap)", d: "Un hueco de desequilibrio entre tres velas consecutivas, donde el precio se movió tan rápido que dejó una zona sin negociar. A menudo el precio vuelve a \"rellenarlo\" antes de continuar." },
      { t: "Desplazamiento (Displacement)", d: "Un movimiento de velas grandes y consecutivas en la misma dirección, señal de entrada agresiva de liquidez institucional y origen habitual de los bloques de órdenes y huecos de valor relevantes." },
      { t: "Objetivo de liquidez (Draw on Liquidity)", d: "El nivel hacia el que el mercado parece \"querer\" dirigirse a continuación: normalmente el siguiente máximo o mínimo relevante donde hay liquidez acumulada." },
      { t: "Zona horaria clave (Kill Zone)", d: "Las franjas horarias con mayor probabilidad de movimientos direccionales fuertes, típicamente coincidiendo con la apertura de Londres y de Nueva York." },
      { t: "Entrada óptima de Fibonacci (OTE)", d: "Del inglés Optimal Trade Entry: la zona entre el 61,8% y el 79% de retroceso de un movimiento impulsivo, usada como área preferente para buscar entradas a favor de la tendencia." },
      { t: "Máximo y mínimo del día anterior (PDH / PDL)", d: "El máximo y el mínimo del día de negociación anterior, dos de los niveles de liquidez más vigilados." },
      { t: "Mitigación", d: "Cuando el precio vuelve a una zona (un Order Block, por ejemplo) y la atraviesa por completo. Se considera que la zona queda \"mitigada\" o consumida, y pierde buena parte de su relevancia para operar." }
    ],

    faqs: [
      {
        p: "¿Esto es una recomendación de compra o venta?",
        r: "Los niveles de entrada, stop loss y take profit que muestra la herramienta se calculan aplicando reglas técnicas (estructura de mercado, Order Blocks, Fibonacci y liquidez) sobre datos históricos recientes, de forma totalmente automática. No son una recomendación personalizada de un asesor humano ni una garantía de resultado: son un ejercicio de aplicación de la metodología ICT/SMC, y debes verificarlos siempre con tu propio análisis y criterio antes de operar. Cada persona es responsable de sus propias decisiones de inversión."
      },
      {
        p: "¿Por qué a veces no aparece ninguna señal?",
        r: "Cuando la estructura reciente no muestra una ruptura clara (BOS) ni un Order Block identificable, la herramienta lo indica en vez de inventar una señal forzada. Es preferible no operar a operar sin un contexto técnico claro."
      },
      {
        p: "¿Cómo se calculan el stop loss y los take profit?",
        r: "El stop loss se coloca justo más allá del Order Block o del origen del movimiento (donde la idea quedaría invalidada). Los take profit usan el siguiente nivel de liquidez no capturado (por ejemplo, el máximo o mínimo del día anterior) y extensiones de Fibonacci (127% y 161,8%) del movimiento impulsivo. Es una forma de calcularlos entre varias posibles, no la única ni una fórmula infalible."
      },
      {
        p: "¿Qué son los conceptos ICT y Smart Money Concepts (SMC)?",
        r: "Son un conjunto de ideas sobre cómo se mueve el precio en los mercados: liquidez (los stops acumulados por encima o por debajo de máximos y mínimos recientes), barridos de liquidez (movimientos que \"cazan\" esos stops antes de revertir), estructura de mercado y zonas horarias clave (franjas con más probabilidad de movimiento direccional, típicamente en la apertura de Londres y Nueva York)."
      },
      {
        p: "¿Por qué son importantes los máximos y mínimos del día anterior?",
        r: "En la metodología ICT/SMC, el máximo del día anterior (PDH) y el mínimo del día anterior (PDL) suelen actuar como imanes de liquidez: zonas donde es probable que el precio busque operativa antes de continuar o revertir su movimiento."
      },
      {
        p: "¿De dónde salen los datos de precio?",
        r: "La herramienta consulta fuentes de datos de mercado de acceso gratuito y los actualiza periódicamente. Si en algún momento esas fuentes no responden, la web te avisa y muestra los últimos datos disponibles o un ejemplo ilustrativo, nunca datos inventados presentados como reales."
      },
      {
        p: "¿Con qué frecuencia se actualizan los niveles?",
        r: "Los datos se refrescan varias veces por hora. La hora de la última actualización aparece siempre junto al análisis de cada instrumento."
      },
      {
        p: "¿Necesito registrarme para usarla?",
        r: "No. La herramienta funciona directamente al entrar, sin cuentas, sin contraseñas y sin instalar nada."
      },
      {
        p: "¿En qué zona horaria están las sesiones?",
        r: "Todas las horas se muestran en UTC. Asia: 00:00–08:00, Londres: 08:00–13:00, Nueva York: 13:00–21:00 (franjas aproximadas y simplificadas con fines educativos; no coinciden exactamente con el horario oficial de cada bolsa, especialmente en cambios de horario de verano)."
      },
      {
        p: "¿Funciona para criptomonedas o acciones?",
        r: "La herramienta cubre los pares de forex y materias primas más consultados en la comunidad ICT/SMC (EUR/USD, GBP/USD, USD/JPY, XAU/USD) y también Bitcoin (BTC/USD). Por ahora no incluye acciones individuales."
      }
    ]
  };
})();

<?php
/**
 * datos.php — proxy de datos OHLC intradía para Liquidez Diaria.
 *
 * Por qué existe este archivo: el navegador del visitante no puede pedir
 * velas de precio directamente a la mayoría de fuentes gratuitas (bloqueos
 * de CORS / anti-bot). Este script corre en el servidor de Hostinger (que sí
 * tiene salida normal a internet), pide los datos una vez, los cachea en
 * disco unos minutos y se los sirve al JS del sitio en un JSON sencillo.
 *
 * No usa ninguna clave de API de pago. Si las fuentes gratuitas fallan,
 * devuelve la última copia guardada en caché (marcada "stale") o, si nunca
 * hubo una copia buena, un set de datos de ejemplo claramente marcado
 * "demo" para que la página nunca se quede rota.
 */

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-cache, must-revalidate');

$SIMBOLOS = [
  'EURUSD' => ['yahoo' => 'EURUSD=X', 'stooq' => 'eurusd', 'demoBase' => 1.0850, 'demoRango' => 0.0060, 'decimales' => 5],
  'GBPUSD' => ['yahoo' => 'GBPUSD=X', 'stooq' => 'gbpusd', 'demoBase' => 1.2650, 'demoRango' => 0.0080, 'decimales' => 5],
  'USDJPY' => ['yahoo' => 'USDJPY=X', 'stooq' => 'usdjpy', 'demoBase' => 151.20, 'demoRango' => 0.90,   'decimales' => 3],
  'XAUUSD' => ['yahoo' => 'XAUUSD=X', 'stooq' => 'xauusd', 'demoBase' => 2415.0, 'demoRango' => 18.0,   'decimales' => 2],
];

$simbolo = isset($_GET['symbol']) ? strtoupper(preg_replace('/[^A-Z]/', '', $_GET['symbol'])) : 'EURUSD';
if (!isset($SIMBOLOS[$simbolo])) { $simbolo = 'EURUSD'; }
$cfg = $SIMBOLOS[$simbolo];

$cacheDir = __DIR__ . '/cache';
if (!is_dir($cacheDir)) { @mkdir($cacheDir, 0775, true); }
$cacheFile = $cacheDir . '/' . strtolower($simbolo) . '.json';
$CACHE_TTL = 900; // 15 minutos: suficiente para "diario" sin machacar la fuente gratuita

function respuesta_cache_valida($cacheFile, $ttl) {
  if (!file_exists($cacheFile)) return null;
  $raw = @file_get_contents($cacheFile);
  if ($raw === false) return null;
  $data = json_decode($raw, true);
  if (!$data || empty($data['candles'])) return null;
  $data['_edad'] = time() - ($data['fetched_at'] ?? 0);
  if ($data['_edad'] <= $ttl) { $data['stale'] = false; return $data; }
  $data['stale'] = true;
  return $data; // devuelto igualmente como candidato "stale" si todo lo demás falla
}

function http_get($url, $headers = []) {
  if (!function_exists('curl_init')) {
    $ctx = stream_context_create(['http' => ['timeout' => 8, 'header' => implode("\r\n", $headers)]]);
    $body = @file_get_contents($url, false, $ctx);
    return $body === false ? null : $body;
  }
  $ch = curl_init($url);
  curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT => 8,
    CURLOPT_CONNECTTIMEOUT => 5,
    CURLOPT_SSL_VERIFYPEER => true,
    CURLOPT_HTTPHEADER => array_merge([
      'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'Accept: */*',
    ], $headers),
  ]);
  $body = curl_exec($ch);
  $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
  curl_close($ch);
  if ($body === false || $code >= 400) return null;
  return $body;
}

/** Fuente 1: Yahoo Finance chart API — timestamps en epoch UTC, sin ambigüedad de zona horaria. */
function traer_yahoo($yahooSimbolo) {
  $url = 'https://query1.finance.yahoo.com/v8/finance/chart/' . rawurlencode($yahooSimbolo) . '?interval=15m&range=5d';
  $body = http_get($url);
  if (!$body) return null;
  $json = json_decode($body, true);
  $result = $json['chart']['result'][0] ?? null;
  if (!$result) return null;
  $ts = $result['timestamp'] ?? null;
  $q = $result['indicators']['quote'][0] ?? null;
  if (!$ts || !$q) return null;
  $candles = [];
  for ($i = 0; $i < count($ts); $i++) {
    $o = $q['open'][$i] ?? null; $h = $q['high'][$i] ?? null;
    $l = $q['low'][$i] ?? null;  $c = $q['close'][$i] ?? null;
    if ($o === null || $h === null || $l === null || $c === null) continue;
    $candles[] = ['t' => (int)$ts[$i], 'o' => (float)$o, 'h' => (float)$h, 'l' => (float)$l, 'c' => (float)$c];
  }
  return count($candles) >= 10 ? $candles : null;
}

/** Fuente 2 (respaldo): Stooq CSV intradía de 15 minutos. */
function traer_stooq($stooqSimbolo) {
  $url = 'https://stooq.com/q/d/l/?s=' . rawurlencode($stooqSimbolo) . '&i=15';
  $body = http_get($url);
  if (!$body || stripos($body, 'Exceeded') !== false) return null;
  $lineas = preg_split('/\r\n|\r|\n/', trim($body));
  if (count($lineas) < 10) return null;
  $header = str_getcsv(array_shift($lineas));
  $idx = array_flip(array_map('strtolower', $header));
  if (!isset($idx['date'], $idx['time'], $idx['open'], $idx['high'], $idx['low'], $idx['close'])) return null;
  $candles = [];
  foreach ($lineas as $linea) {
    if (!$linea) continue;
    $c = str_getcsv($linea);
    $fecha = $c[$idx['date']] ?? null; $hora = $c[$idx['time']] ?? null;
    if (!$fecha || !$hora) continue;
    // Asumimos que stooq entrega hora UTC (aproximado — documentado como límite honesto en la FAQ).
    $t = strtotime($fecha . ' ' . $hora . ' UTC');
    if (!$t) continue;
    $candles[] = [
      't' => $t,
      'o' => (float)($c[$idx['open']] ?? 0), 'h' => (float)($c[$idx['high']] ?? 0),
      'l' => (float)($c[$idx['low']] ?? 0),  'c' => (float)($c[$idx['close']] ?? 0),
    ];
  }
  return count($candles) >= 10 ? $candles : null;
}

/** Último recurso: datos sintéticos, siempre marcados demo:true, para que la web nunca se rompa. */
function generar_demo($cfg) {
  $candles = [];
  $ahora = time();
  $ahora -= $ahora % 900;
  $precio = $cfg['demoBase'];
  srand(intdiv($ahora, 86400) + strlen($cfg['stooq'])); // determinista por día, distinto por símbolo
  for ($i = 191; $i >= 0; $i--) {
    $t = $ahora - $i * 900;
    $ruido = (mt_rand(-100, 100) / 100) * ($cfg['demoRango'] / 24);
    $tendencia = sin($i / 18) * ($cfg['demoRango'] / 3);
    $o = $precio;
    $c = $cfg['demoBase'] + $tendencia + $ruido;
    $h = max($o, $c) + abs($ruido) * 0.6;
    $l = min($o, $c) - abs($ruido) * 0.6;
    $candles[] = ['t' => $t, 'o' => round($o, 6), 'h' => round($h, 6), 'l' => round($l, 6), 'c' => round($c, 6)];
    $precio = $c;
  }
  return $candles;
}

$candles = traer_yahoo($cfg['yahoo']);
$fuente = 'yahoo';
if (!$candles) { $candles = traer_stooq($cfg['stooq']); $fuente = 'stooq'; }

if ($candles) {
  $salida = ['symbol' => $simbolo, 'candles' => $candles, 'fetched_at' => time(), 'fuente' => $fuente, 'demo' => false, 'stale' => false];
  @file_put_contents($cacheFile, json_encode($salida));
  echo json_encode($salida);
  exit;
}

// Ambas fuentes en vivo fallaron: intenta servir la última caché buena, aunque esté vieja.
$cache = respuesta_cache_valida($cacheFile, PHP_INT_MAX);
if ($cache) {
  $cache['demo'] = false;
  $cache['stale'] = true;
  echo json_encode($cache);
  exit;
}

// No hay ni fuente en vivo ni caché: modo demostración explícito.
$demo = ['symbol' => $simbolo, 'candles' => generar_demo($cfg), 'fetched_at' => time(), 'fuente' => 'demo', 'demo' => true, 'stale' => false];
echo json_encode($demo);

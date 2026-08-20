// src/webpush.js
//
// Envío de notificaciones Web Push (RFC 8291 "Message Encryption for Web
// Push" + RFC 8188 "aes128gcm" content-coding + RFC 8292 "VAPID") escrito
// a mano con la Web Crypto API (crypto.subtle), sin dependencias de npm,
// porque este proyecto se despliega como Worker plano sin paso de build.
// Módulo ES puro: funciona igual en Cloudflare Workers (crypto.subtle
// global) y en Node >= 19 (crypto.subtle también es global ahí), lo que
// permite probar este archivo con `node` de forma local antes de
// desplegarlo — ver /tmp/ld2test/test_webpush.mjs.
//
// Referencias:
//  - RFC 8291: https://www.rfc-editor.org/rfc/rfc8291
//  - RFC 8188: https://www.rfc-editor.org/rfc/rfc8188
//  - RFC 8292: https://www.rfc-editor.org/rfc/rfc8292

export function b64urlEncode(bufferLike) {
  var bytes = bufferLike instanceof Uint8Array ? bufferLike : new Uint8Array(bufferLike);
  var bin = "";
  for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(str) {
  var b64 = String(str).replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  var bin = atob(b64);
  var bytes = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function utf8(str) { return new TextEncoder().encode(str); }

function concatBytes(arrays) {
  var total = arrays.reduce(function (n, a) { return n + a.length; }, 0);
  var out = new Uint8Array(total);
  var off = 0;
  arrays.forEach(function (a) { out.set(a, off); off += a.length; });
  return out;
}

async function hmacSha256(keyBytes, msgBytes) {
  var key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  var sig = await crypto.subtle.sign("HMAC", key, msgBytes);
  return new Uint8Array(sig);
}

// HKDF de un solo paso (RFC 5869) tal como lo usan RFC 8291/8188: PRK = HMAC(salt, ikm);
// salida = HMAC(PRK, info || 0x01) truncada a `len` bytes (solo necesitamos <= 32 bytes,
// así que un único bloque de HKDF-Expand basta).
async function hkdfUnBloque(salt, ikm, info, len) {
  var prk = await hmacSha256(salt, ikm);
  var okm = await hmacSha256(prk, concatBytes([info, new Uint8Array([1])]));
  return okm.slice(0, len);
}

/**
 * Cifra `payloadObj` (se serializa a JSON) para una suscripción push
 * concreta, siguiendo RFC 8291 (derivación de claves) + RFC 8188
 * (content-coding aes128gcm, un único registro ya que el payload es
 * pequeño). Devuelve los bytes listos para el cuerpo de la petición POST
 * al endpoint de la suscripción.
 */
export async function cifrarPayload(subscription, payloadObj) {
  var uaPublic = b64urlDecode(subscription.keys.p256dh); // clave pública EC del navegador (65 bytes sin comprimir)
  var authSecret = b64urlDecode(subscription.keys.auth); // secreto de 16 bytes de la suscripción

  var asKeyPair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  var asPublicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", asKeyPair.publicKey));

  var uaPublicKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  var ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaPublicKey }, asKeyPair.privateKey, 256));

  // RFC 8291 §3.3-3.4: IKM = HMAC(HMAC(auth_secret, ecdh_secret), "WebPush: info"||0x00||ua_pub||as_pub || 0x01)
  var prkKey = await hmacSha256(authSecret, ecdhSecret);
  var keyInfo = concatBytes([utf8("WebPush: info"), new Uint8Array([0]), uaPublic, asPublicRaw]);
  var ikm = (await hmacSha256(prkKey, concatBytes([keyInfo, new Uint8Array([1])]))).slice(0, 32);

  var salt = crypto.getRandomValues(new Uint8Array(16));
  var cek = await hkdfUnBloque(salt, ikm, concatBytes([utf8("Content-Encoding: aes128gcm"), new Uint8Array([0])]), 16);
  var nonce = await hkdfUnBloque(salt, ikm, concatBytes([utf8("Content-Encoding: nonce"), new Uint8Array([0])]), 12);

  var plano = utf8(JSON.stringify(payloadObj));
  // RFC 8188 §2: cada registro lleva un delimitador de relleno; al ser el
  // (único) último registro, el delimitador es 0x02, sin relleno adicional.
  var planoConDelimitador = concatBytes([plano, new Uint8Array([2])]);

  var cekKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  var cifradoBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, cekKey, planoConDelimitador);
  var cifrado = new Uint8Array(cifradoBuf); // incluye ya el tag de 16 bytes al final

  var rs = 4096; // tamaño de registro, 4 bytes big-endian (un único registro, así que basta con rs >= longitud del registro)
  var rsBytes = new Uint8Array([(rs >>> 24) & 0xff, (rs >>> 16) & 0xff, (rs >>> 8) & 0xff, rs & 0xff]);
  var idlen = new Uint8Array([asPublicRaw.length]);
  var cabecera = concatBytes([salt, rsBytes, idlen, asPublicRaw]);

  return concatBytes([cabecera, cifrado]);
}

/**
 * Descifra un cuerpo aes128gcm producido por cifrarPayload(), usando la
 * clave PRIVADA de la suscripción (la que tendría el navegador). Solo se
 * usa en las pruebas locales de este archivo para verificar por ronda
 * completa que el cifrado es autoconsistente; el Worker en producción
 * nunca descifra, solo cifra y envía.
 */
export async function descifrarPayload(cuerpo, uaPrivateKey, uaPublicRawB64url, authSecretB64url) {
  var authSecret = b64urlDecode(authSecretB64url);
  var uaPublic = b64urlDecode(uaPublicRawB64url);

  var salt = cuerpo.slice(0, 16);
  var idlen = cuerpo[20];
  var asPublicRaw = cuerpo.slice(21, 21 + idlen);
  var cifrado = cuerpo.slice(21 + idlen);

  var asPublicKey = await crypto.subtle.importKey("raw", asPublicRaw, { name: "ECDH", namedCurve: "P-256" }, false, []);
  var ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asPublicKey }, uaPrivateKey, 256));

  var prkKey = await hmacSha256(authSecret, ecdhSecret);
  var keyInfo = concatBytes([utf8("WebPush: info"), new Uint8Array([0]), uaPublic, asPublicRaw]);
  var ikm = (await hmacSha256(prkKey, concatBytes([keyInfo, new Uint8Array([1])]))).slice(0, 32);

  var cek = await hkdfUnBloque(salt, ikm, concatBytes([utf8("Content-Encoding: aes128gcm"), new Uint8Array([0])]), 16);
  var nonce = await hkdfUnBloque(salt, ikm, concatBytes([utf8("Content-Encoding: nonce"), new Uint8Array([0])]), 12);

  var cekKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["decrypt"]);
  var planoBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, cekKey, cifrado);
  var plano = new Uint8Array(planoBuf);
  // quitar el delimitador de relleno (0x02, último byte, sin relleno extra)
  var sinDelimitador = plano.slice(0, plano.length - 1);
  return JSON.parse(new TextDecoder().decode(sinDelimitador));
}

/** Construye la cabecera Authorization: vapid t=<jwt>, k=<clave pública> (RFC 8292). */
export async function construirCabeceraVapid(endpointUrl, vapidPrivateJwk, vapidPublicB64url, subjectMailto) {
  var origen = new URL(endpointUrl).origin;
  var header = { typ: "JWT", alg: "ES256" };
  var payload = { aud: origen, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subjectMailto };
  var signingInput = b64urlEncode(utf8(JSON.stringify(header))) + "." + b64urlEncode(utf8(JSON.stringify(payload)));
  var privKey = await crypto.subtle.importKey("jwk", vapidPrivateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  // Web Crypto devuelve la firma ECDSA como r||s (64 bytes para P-256), que
  // es exactamente el formato "raw" que exige JWS ES256 (no hace falta
  // convertir desde/hacia DER).
  var firma = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privKey, utf8(signingInput));
  var jwt = signingInput + "." + b64urlEncode(firma);
  return "vapid t=" + jwt + ", k=" + vapidPublicB64url;
}

/**
 * Envía una notificación push a una suscripción. `vapidKeys` = { publicKeyB64url, privateJwk, subject }.
 * Devuelve la Response cruda del servicio de push (fetch): 201 = entregada
 * a la cola del navegador, 404/410 = la suscripción ya no existe (hay que
 * borrarla), otros códigos = error transitorio.
 */
export async function enviarWebPush(subscription, payloadObj, vapidKeys) {
  var cuerpo = await cifrarPayload(subscription, payloadObj);
  var auth = await construirCabeceraVapid(subscription.endpoint, vapidKeys.privateJwk, vapidKeys.publicKeyB64url, vapidKeys.subject);
  return fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Encoding": "aes128gcm",
      "TTL": "86400",
      "Authorization": auth
    },
    body: cuerpo
  });
}

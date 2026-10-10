/**
 * Web Push 발송 (VAPID + aes128gcm).
 *
 * web-push 패키지는 Node crypto 를 써서 Workers 에서 못 쓴다. WebCrypto 로
 * RFC 8292(VAPID), RFC 8291(페이로드 암호화), RFC 8188(aes128gcm)을 직접 구현했다.
 */

import { B64URL } from './security.js';

const P256 = { name: 'ECDH', namedCurve: 'P-256' };
const RECORD_SIZE = 4096;
const JWT_TTL_SEC = 12 * 60 * 60; // VAPID 명세상 최대 24시간. 절반으로 여유를 둔다.

/* ---------- 바이트 유틸 ---------- */

export function b64urlToBytes(s) {
  let t = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (t.length % 4) t += '=';
  const bin = atob(t);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64url(buf) {
  const arr = new Uint8Array(buf);
  let bin = '';
  // String.fromCharCode 인자 개수 제한 때문에 나눠서 만든다.
  const CHUNK = 0x8000;
  for (let i = 0; i < arr.length; i += CHUNK) {
    bin += String.fromCharCode(...arr.subarray(i, i + CHUNK));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

const utf8 = (s) => new TextEncoder().encode(s);

/* ---------- HKDF ---------- */

async function hmacSha256(keyBytes, data) {
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
}

/** 출력이 32바이트 이하일 때만 써서 expand 는 1블록만 한다. */
async function hkdf(salt, ikm, info, length) {
  const prk = await hmacSha256(salt, ikm);
  const okm = await hmacSha256(prk, concat(info, new Uint8Array([1])));
  return okm.slice(0, length);
}

/* ---------- VAPID ---------- */

// VAPID 키는 배포 동안 안 바뀌니 import 한 CryptoKey 를 isolate 가 살아 있는 동안
// 재사용한다. 구독자마다 다시 import 하지 않게.
let cachedVapidKey = null; // { publicKeyB64, privateKeyB64, key }

/**
 * base64url VAPID 키쌍 → ECDSA 서명용 CryptoKey.
 * JWK 에는 d 말고 x, y 도 필요해서 공개키에서 떼어 넣는다.
 */
async function importVapidKey(publicKeyB64, privateKeyB64) {
  // 시크릿을 붙여넣을 때 공백·줄바꿈·따옴표가 같이 들어가는 일이 많아서 정리한다.
  // 안 그러면 서명할 때 알아보기 힘든 에러가 난다.
  const pubB64 = String(publicKeyB64 ?? '').trim().replace(/^["']|["']$/g, '');
  const privB64 = String(privateKeyB64 ?? '').trim().replace(/^["']|["']$/g, '');

  if (
    cachedVapidKey &&
    cachedVapidKey.publicKeyB64 === pubB64 &&
    cachedVapidKey.privateKeyB64 === privB64
  ) {
    return cachedVapidKey.key;
  }

  if (!privB64) {
    throw new Error('VAPID_PRIVATE_KEY 시크릿이 비어 있습니다. wrangler secret put 으로 등록하세요.');
  }
  if (!B64URL.test(privB64)) {
    throw new Error('VAPID_PRIVATE_KEY 가 base64url 형식이 아닙니다. genkeys 의 ② 값을 그대로 넣으세요.');
  }
  // P-256 개인키는 32바이트(base64url 43자). 잘렸거나 공개키를 넣은 경우를 잡는다.
  const privLen = b64urlToBytes(privB64).length;
  if (privLen !== 32) {
    throw new Error(
      `VAPID_PRIVATE_KEY 길이가 32바이트가 아닙니다 (${privLen}바이트). ` +
        '값이 잘렸거나 공개키를 잘못 등록했을 수 있습니다.',
    );
  }

  const pub = b64urlToBytes(pubB64);
  if (pub.length !== 65 || pub[0] !== 0x04) {
    throw new Error(
      `VAPID_PUBLIC_KEY 가 65바이트 비압축 P-256 점이 아닙니다 (길이 ${pub.length}).`,
    );
  }

  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    x: bytesToB64url(pub.slice(1, 33)),
    y: bytesToB64url(pub.slice(33, 65)),
    d: privB64,
    ext: true,
  };

  try {
    const key = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign'],
    );
    cachedVapidKey = { publicKeyB64: pubB64, privateKeyB64: privB64, key };
    return key;
  } catch (err) {
    // 주로 공개키·개인키가 서로 다른 키쌍일 때 난다.
    throw new Error(
      `VAPID 키 import 실패 — 공개키와 개인키가 같은 genkeys 실행에서 나온 값인지 확인하세요. (${err.message})`,
    );
  }
}

export async function makeVapidHeader(endpoint, publicKeyB64, privateKeyB64, subject) {
  const audience = new URL(endpoint).origin;
  const header = bytesToB64url(utf8(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = bytesToB64url(
    utf8(
      JSON.stringify({
        aud: audience,
        exp: Math.floor(Date.now() / 1000) + JWT_TTL_SEC,
        sub: subject,
      }),
    ),
  );

  const signingInput = utf8(`${header}.${payload}`);
  const key = await importVapidKey(publicKeyB64, privateKeyB64);
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    signingInput,
  );

  const jwt = `${header}.${payload}.${bytesToB64url(sig)}`;
  return `vapid t=${jwt}, k=${publicKeyB64}`;
}

/* ---------- 페이로드 암호화 (RFC 8291) ---------- */

export async function encryptPayload(plaintext, p256dhB64, authB64) {
  const uaPublicRaw = b64urlToBytes(p256dhB64);
  const authSecret = b64urlToBytes(authB64);

  const uaPublicKey = await crypto.subtle.importKey('raw', uaPublicRaw, P256, true, []);

  // 발신자 임시 키쌍(메시지마다 새로).
  const asKeyPair = await crypto.subtle.generateKey(P256, true, ['deriveBits']);
  const asPublicRaw = new Uint8Array(
    await crypto.subtle.exportKey('raw', asKeyPair.publicKey),
  );

  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'ECDH', public: uaPublicKey },
      asKeyPair.privateKey,
      256,
    ),
  );

  // IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info\0" || ua_public || as_public)
  const keyInfo = concat(utf8('WebPush: info\0'), uaPublicRaw, asPublicRaw);
  const ikm = await hkdf(authSecret, sharedSecret, keyInfo, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, utf8('Content-Encoding: nonce\0'), 12);

  // 평문 뒤에 패딩 구분자 0x02(마지막 레코드).
  const padded = concat(utf8(plaintext), new Uint8Array([0x02]));

  const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, [
    'encrypt',
  ]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, padded),
  );

  // aes128gcm 헤더: salt(16) | rs(4, BE) | idlen(1) | keyid(as_public, 65)
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, RECORD_SIZE, false);

  return concat(salt, rs, new Uint8Array([asPublicRaw.length]), asPublicRaw, ciphertext);
}

/* ---------- 발송 ---------- */

/**
 * 구독 하나에 푸시 발송.
 *
 * @returns {Promise<{ok: boolean, status: number, gone: boolean}>}
 *   gone 이면 만료·해지된 구독이라 호출부에서 DB 에서 지운다.
 */
export async function sendPush(subscription, payloadObject, env) {
  const { endpoint, p256dh, auth } = subscription;

  const body = await encryptPayload(JSON.stringify(payloadObject), p256dh, auth);
  const authorization = await makeVapidHeader(
    endpoint,
    env.VAPID_PUBLIC_KEY,
    env.VAPID_PRIVATE_KEY,
    env.VAPID_SUBJECT,
  );

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: authorization,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '86400',
      Urgency: 'high',
      /*
       * Topic(RFC 8030 §5.4): 아직 전달 안 된 같은 topic 메시지를 새 것으로 바꾼다.
       * sw.js tag 와 같이 경기 단위로 묶는다. 기기가 잠들어 있는 동안 쌓인 알림은
       * 마지막 것만 있으면 된다.
       *
       * 이벤트 단위로 하면 안 된다. FCM 은 기기당 collapse key 를 4개까지만 갖고,
       * 넘으면 아무거나 버린다. 2026-10-10 경기(이벤트 14개)에서 뒤쪽 4건이 끝내
       * 안 왔다. 경기 단위면 키가 하나다.
       *
       * 값은 32자 이하 URL-safe base64 문자만 된다. "g" + gameId 가 18자.
       * 테스트 알림은 gameId 가 없어서 안 붙인다.
       */
      ...(payloadObject.gameId ? { Topic: `g${payloadObject.gameId}` } : {}),
    },
    body,
  });

  // 404/410 = 구독 없어짐.
  return { ok: res.ok, status: res.status, gone: res.status === 404 || res.status === 410 };
}

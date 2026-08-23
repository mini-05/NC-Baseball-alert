/**
 * Web Push 발송 (VAPID + aes128gcm).
 *
 * 외부 패키지(web-push 등)는 Node 전용 crypto 에 의존해 Workers 에서 그대로 쓸 수 없다.
 * 여기서는 WebCrypto 만으로 RFC 8292(VAPID), RFC 8291(페이로드 암호화),
 * RFC 8188(aes128gcm 인코딩)을 직접 구현한다.
 */

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
  // 인자 개수 한계를 피하려고 청크 단위로 문자열을 만든다.
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

/** 출력이 32바이트 이하인 경우만 쓰므로 expand 는 1블록으로 충분하다. */
async function hkdf(salt, ikm, info, length) {
  const prk = await hmacSha256(salt, ikm);
  const okm = await hmacSha256(prk, concat(info, new Uint8Array([1])));
  return okm.slice(0, length);
}

/* ---------- VAPID ---------- */

/**
 * base64url 로 저장된 VAPID 키쌍을 ECDSA 서명용 CryptoKey 로 되살린다.
 * 개인키(d)만으로는 JWK 를 구성할 수 없어 공개키에서 x, y 를 떼어 함께 넣는다.
 */
async function importVapidKey(publicKeyB64, privateKeyB64) {
  // 키를 콘솔에서 붙여넣어 등록하다 보면 앞뒤 공백·줄바꿈이나 따옴표가 딸려 오기 쉽다.
  // 그대로 두면 서명 단계에서야 알 수 없는 예외로 터지므로 여기서 정리한다.
  const pubB64 = String(publicKeyB64 ?? '').trim().replace(/^["']|["']$/g, '');
  const privB64 = String(privateKeyB64 ?? '').trim().replace(/^["']|["']$/g, '');

  if (!privB64) {
    throw new Error('VAPID_PRIVATE_KEY 시크릿이 비어 있습니다. wrangler secret put 으로 등록하세요.');
  }
  if (!/^[A-Za-z0-9_-]+$/.test(privB64)) {
    throw new Error('VAPID_PRIVATE_KEY 가 base64url 형식이 아닙니다. genkeys 의 ② 값을 그대로 넣으세요.');
  }
  // P-256 개인키는 32바이트 = base64url 43자. 값이 잘렸거나 공개키를 잘못 넣은 경우를 잡는다.
  if (b64urlToBytes(privB64).length !== 32) {
    throw new Error(
      `VAPID_PRIVATE_KEY 길이가 32바이트가 아닙니다 (${b64urlToBytes(privB64).length}바이트). ` +
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
    return await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign'],
    );
  } catch (err) {
    // 개인키와 공개키가 서로 다른 키쌍에서 나온 경우가 대표적이다.
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

  // 발신자 임시 키쌍. 메시지마다 새로 만든다.
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

  // 평문 뒤에 패딩 구분자 0x02(마지막 레코드)를 붙인다.
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
 * 구독 하나에 푸시를 보낸다.
 *
 * @returns {Promise<{ok: boolean, status: number, gone: boolean}>}
 *   gone === true 이면 구독이 만료·해지된 것이므로 호출자가 DB에서 지워야 한다.
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
    },
    body,
  });

  // 404/410 은 구독 폐기를 뜻하는 표준 응답이다.
  return { ok: res.ok, status: res.status, gone: res.status === 404 || res.status === 410 };
}

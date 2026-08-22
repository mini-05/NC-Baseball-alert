/**
 * 암호화·상태감지 로직 자체 검증.
 *
 *   node scripts/selftest.mjs
 *
 * 푸시 암호화(RFC 8291)는 실제 브라우저 없이는 확인이 어려우므로,
 * 여기서 브라우저 역할(수신자 키쌍 보유)을 직접 맡아 복호화까지 해 본다.
 * 복호문이 원문과 일치하면 구현이 맞다는 뜻이다.
 */

import { encryptPayload, makeVapidHeader, b64urlToBytes, bytesToB64url } from '../src/push.js';
import { detectEvents } from '../src/detect.js';
import { normalizeGame, perspective } from '../src/kbo.js';

let failed = 0;

function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failed++;
}

const utf8 = (s) => new TextEncoder().encode(s);

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}

async function hkdf(salt, ikm, info, len) {
  const prk = await hmac(salt, ikm);
  return (await hmac(prk, concat(info, new Uint8Array([1])))).slice(0, len);
}

/* ── 1. 푸시 페이로드 암복호화 왕복 ── */

async function testEncryption() {
  // 브라우저(수신자) 역할의 키쌍과 auth 시크릿을 만든다.
  const ua = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'],
  );
  const uaPublicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey));
  const authSecret = crypto.getRandomValues(new Uint8Array(16));

  const original = JSON.stringify({ kind: 'score', title: 'NC 2점 득점!', body: 'NC 5 : 3 삼성 · 7회말' });

  const body = await encryptPayload(
    original,
    bytesToB64url(uaPublicRaw),
    bytesToB64url(authSecret),
  );

  // ── 여기서부터 수신자 입장의 복호화 (RFC 8188 역순) ──
  const salt = body.slice(0, 16);
  const rs = new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0, false);
  const idlen = body[20];
  const asPublicRaw = body.slice(21, 21 + idlen);
  const ciphertext = body.slice(21 + idlen);

  check('aes128gcm 헤더 rs = 4096', rs === 4096, `rs=${rs}`);
  check('keyid 길이 = 65 (비압축 P-256 점)', idlen === 65, `idlen=${idlen}`);

  const asPublicKey = await crypto.subtle.importKey(
    'raw', asPublicRaw, { name: 'ECDH', namedCurve: 'P-256' }, true, [],
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: asPublicKey }, ua.privateKey, 256),
  );

  const ikm = await hkdf(
    authSecret, shared,
    concat(utf8('WebPush: info\0'), uaPublicRaw, asPublicRaw), 32,
  );
  const cek = await hkdf(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, utf8('Content-Encoding: nonce\0'), 12);

  const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['decrypt']);
  const plain = new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, ciphertext),
  );

  check('패딩 구분자 0x02', plain[plain.length - 1] === 0x02);

  const decoded = new TextDecoder().decode(plain.slice(0, -1));
  check('복호문이 원문과 일치', decoded === original, decoded.slice(0, 60));
}

/* ── 2. VAPID JWT 서명 검증 ── */

async function testVapid() {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'],
  );
  const publicKey = bytesToB64url(await crypto.subtle.exportKey('raw', pair.publicKey));
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);

  const endpoint = 'https://fcm.googleapis.com/fcm/send/abc123';
  const header = await makeVapidHeader(endpoint, publicKey, jwk.d, 'mailto:test@example.com');

  check('Authorization 형식', header.startsWith('vapid t=') && header.includes(', k='));

  const jwt = header.slice('vapid t='.length, header.indexOf(', k='));
  const [h, p, s] = jwt.split('.');

  const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(p)));
  check('aud = 엔드포인트 origin', payload.aud === 'https://fcm.googleapis.com', payload.aud);
  check('exp 가 24시간 이내', payload.exp - Math.floor(Date.now() / 1000) <= 86400);
  check('sub 포함', payload.sub === 'mailto:test@example.com');

  const ok = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    pair.publicKey,
    b64urlToBytes(s),
    utf8(`${h}.${p}`),
  );
  check('JWT 서명이 공개키로 검증됨', ok);
}

/* ── 3. 상태 전이 감지 ── */

function g(over = {}) {
  return normalizeGame({
    gameId: 'G1', gameDate: '2026-08-22', gameDateTime: '2026-08-22T18:30:00',
    stadium: '창원', homeTeamCode: 'NC', homeTeamName: 'NC',
    awayTeamCode: 'SS', awayTeamName: '삼성',
    homeTeamScore: 0, awayTeamScore: 0,
    statusCode: 'BEFORE', statusInfo: null, cancel: false, suspended: false,
    ...over,
  });
}

function testDetect() {
  const T = 'NC';
  const kinds = (evs) => evs.map((e) => e.kind).join(',');

  check('처음 보는 경기는 알리지 않음', detectEvents(null, g(), T).length === 0);

  check(
    '경기 시작 감지',
    kinds(detectEvents(g(), g({ statusCode: 'STARTED', statusInfo: '1회초' }), T)) === 'start',
  );

  check(
    '변화 없으면 아무 이벤트 없음',
    detectEvents(g(), g(), T).length === 0,
  );

  check(
    '경기 취소 감지',
    kinds(detectEvents(g(), g({ cancel: true, statusInfo: '경기취소' }), T)) === 'cancel',
  );

  check(
    '취소는 한 번만 (이미 취소된 상태에선 재발송 없음)',
    detectEvents(g({ cancel: true }), g({ cancel: true }), T).length === 0,
  );

  const live = (h, a) => g({ statusCode: 'STARTED', statusInfo: '5회말', homeTeamScore: h, awayTeamScore: a });

  const scored = detectEvents(live(1, 0), live(3, 0), T);
  check('우리 팀 득점 감지', kinds(scored) === 'score');
  check('득점 문구', scored[0]?.title === 'NC 2점 득점!', scored[0]?.title);

  const conceded = detectEvents(live(1, 0), live(1, 2), T);
  check('실점 문구', conceded[0]?.title === '삼성 2점 실점', conceded[0]?.title);

  check(
    '득점 dedup 키에 점수가 들어감',
    scored[0]?.dedupKey === 'G1:score:3-0',
    scored[0]?.dedupKey,
  );

  const ended = detectEvents(live(5, 3), g({ statusCode: 'RESULT', homeTeamScore: 5, awayTeamScore: 3 }), T);
  check('경기 종료 감지', kinds(ended) === 'end');
  check('승리 판정', ended[0]?.title.includes('승리'), ended[0]?.title);

  const lost = detectEvents(live(2, 3), g({ statusCode: 'RESULT', homeTeamScore: 2, awayTeamScore: 7 }), T);
  // 종료 시점에 점수도 함께 바뀌지만, phase 가 result 이므로 득점 알림은 나가지 않아야 한다.
  check('종료 전이에서는 득점 알림 없음', kinds(lost) === 'end', kinds(lost));
  check('패배 판정', lost[0]?.title.includes('패배'), lost[0]?.title);

  // 원정 경기: 대상 팀이 away 인 경우에도 관점이 뒤집히지 않아야 한다.
  const awayBefore = g({ homeTeamCode: 'SS', homeTeamName: '삼성', awayTeamCode: 'NC', awayTeamName: 'NC',
    statusCode: 'STARTED', homeTeamScore: 0, awayTeamScore: 0 });
  const awayAfter = g({ homeTeamCode: 'SS', homeTeamName: '삼성', awayTeamCode: 'NC', awayTeamName: 'NC',
    statusCode: 'STARTED', homeTeamScore: 0, awayTeamScore: 1 });
  const awayEv = detectEvents(awayBefore, awayAfter, T);
  check('원정 경기 득점 판정', awayEv[0]?.title === 'NC 1점 득점!', awayEv[0]?.title);

  const p = perspective(awayAfter, T);
  check('원정 경기 관점', p.isHome === false && p.oppName === '삼성' && p.teamScore === 1);
}

/* ── 실행 ── */

console.log('\n[1] 푸시 페이로드 암복호화');
await testEncryption();
console.log('\n[2] VAPID JWT');
await testVapid();
console.log('\n[3] 상태 전이 감지');
testDetect();

console.log(failed === 0 ? '\n전부 통과.\n' : `\n실패 ${failed}건.\n`);
process.exit(failed === 0 ? 0 : 1);

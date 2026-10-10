/**
 * 자체 검증. 네트워크 없이 돌아간다.
 *
 *   node scripts/selftest.mjs
 *
 * 푸시 암호화(RFC 8291)는 브라우저 없이 확인하기 어려워서, 여기서 수신자 키쌍을
 * 만들어 직접 복호화해 본다. 원문과 같으면 구현이 맞다.
 */

import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import vm from 'node:vm';
import { encryptPayload, makeVapidHeader, b64urlToBytes, bytesToB64url, sendPush } from '../src/push.js';
import { detectEvents, dispatchKindOf } from '../src/detect.js';
import { normalizeGame, perspective, seriesOf, isPostseason, postseasonOutlook, kstIsoToEpoch,
         seasonYearOf, filterCurrentSeason, fetchScoreboard, fetchRelayFinish, inningOf, headToHead,
         inningSumMatches } from '../src/kbo.js';
import { pollWindowGames, loadSchedule, loadStandings, resolveSeasonOpener, invalidateSchedule } from '../src/season.js';
import { boardCoversScore, POLLS_PER_TICK } from '../src/index.js';
import { validateEndpoint, validateKeys, checkOrigin, readJson, MAX_SUBSCRIPTIONS,
         SUBREQUEST_BUDGET } from '../src/security.js';
import { subscribersFor, getCache, putCache, pruneDatedCache, allSettledBefore, insertEvent, markDelivered,
         listUndelivered, markResent, makeRoomForSubscription, saveSubscription,
         deleteSubscription, getSettings, updateSettings, SETTING_COLUMN } from '../src/db.js';

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

/* ══ 1. 푸시 페이로드 암복호화 왕복 ══ */

async function testEncryption() {
  const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const uaPublicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey));
  const authSecret = crypto.getRandomValues(new Uint8Array(16));

  const original = JSON.stringify({ kind: 'score', title: '[한국시리즈] NC 2점 득점!', body: 'NC 5 : 3 삼성 · 7회말' });

  const body = await encryptPayload(original, bytesToB64url(uaPublicRaw), bytesToB64url(authSecret));

  // ── 수신자 입장의 복호화 (RFC 8188 역순) ──
  const salt = body.slice(0, 16);
  const rs = new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0, false);
  const idlen = body[20];
  const asPublicRaw = body.slice(21, 21 + idlen);
  const ciphertext = body.slice(21 + idlen);

  check('aes128gcm 헤더 rs = 4096', rs === 4096, `rs=${rs}`);
  check('keyid 길이 = 65 (비압축 P-256 점)', idlen === 65, `idlen=${idlen}`);

  const asPublicKey = await crypto.subtle.importKey('raw', asPublicRaw, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asPublicKey }, ua.privateKey, 256));

  const ikm = await hkdf(authSecret, shared, concat(utf8('WebPush: info\0'), uaPublicRaw, asPublicRaw), 32);
  const cek = await hkdf(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, utf8('Content-Encoding: nonce\0'), 12);

  const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['decrypt']);
  const plain = new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, ciphertext),
  );

  check('패딩 구분자 0x02', plain[plain.length - 1] === 0x02);
  const decoded = new TextDecoder().decode(plain.slice(0, -1));
  check('복호문이 원문과 일치', decoded === original);

  // 같은 평문이어도 암호문은 매번 달라야 한다(salt·임시키가 매번 새로 생김).
  const again = await encryptPayload(original, bytesToB64url(uaPublicRaw), bytesToB64url(authSecret));
  check('같은 평문도 매번 다른 암호문', bytesToB64url(again) !== bytesToB64url(body));
}

/* ══ 2. VAPID JWT ══ */

async function testVapid() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
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
    { name: 'ECDSA', hash: 'SHA-256' }, pair.publicKey, b64urlToBytes(s), utf8(`${h}.${p}`),
  );
  check('JWT 서명이 공개키로 검증됨', ok);

  // ── 키 설정 실수를 발송 전에 잡는지 ──
  // 예전에 공개키·개인키를 다른 genkeys 실행에서 가져와서 "Invalid EC key" 만
  // 나오고 원인을 찾기 어려웠던 적이 있다.
  const other = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'],
  );
  const otherJwk = await crypto.subtle.exportKey('jwk', other.privateKey);

  const failsWith = async (pub, priv) => {
    try {
      await makeVapidHeader(endpoint, pub, priv, 'mailto:t@e.com');
      return null;
    } catch (e) { return e.message; }
  };

  const mismatch = await failsWith(publicKey, otherJwk.d);
  check('짝이 안 맞는 키쌍을 잡아냄', /키쌍|import 실패/.test(mismatch ?? ''), mismatch);

  const empty = await failsWith(publicKey, '');
  check('개인키 누락을 잡아냄', /비어 있습니다/.test(empty ?? ''), empty);

  const badChars = await failsWith(publicKey, 'not+valid/base64url!');
  check('base64url 아닌 개인키를 잡아냄', /base64url/.test(badChars ?? ''), badChars);

  const truncated = await failsWith(publicKey, jwk.d.slice(0, 20));
  check('잘린 개인키를 잡아냄', /32바이트가 아닙니다/.test(truncated ?? ''), truncated);

  // 앞뒤 공백·따옴표가 붙어 있어도 돼야 한다(붙여넣기 실수).
  const padded = await makeVapidHeader(endpoint, ` "${publicKey}" `, `\n ${jwk.d} \n`, 'mailto:t@e.com');
  check('공백·따옴표가 붙어도 통과', padded.startsWith('vapid t='));
}

/* ══ 2-b. 발송 묶음(Topic) ══ */

/**
 * Topic 은 경기 단위(sw.js tag 와 같은 범위).
 * FCM 은 기기당 collapse key 를 4개까지만 갖는다. 이벤트 단위로 하면 한 경기에서
 * 이 한도를 넘는다(2026-10-10 뒤쪽 4건 미배달). 한 경기의 이벤트가 전부 같은
 * Topic 인지, 키가 몇 개 생기는지 본다.
 */
async function testTopic() {
  const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const p256dh = bytesToB64url(new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey)));
  const auth = bytesToB64url(crypto.getRandomValues(new Uint8Array(16)));

  const vapid = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const env = {
    VAPID_PUBLIC_KEY: bytesToB64url(new Uint8Array(await crypto.subtle.exportKey('raw', vapid.publicKey))),
    VAPID_PRIVATE_KEY: (await crypto.subtle.exportKey('jwk', vapid.privateKey)).d,
    VAPID_SUBJECT: 'mailto:test@example.com',
  };
  const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc123', p256dh, auth };

  const sent = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => { sent.push(init.headers); return { ok: true, status: 201 }; };

  const GAME = '20261010HHNC02026';
  const OTHER = '20261011HHNC02026';
  try {
    // 2026-10-10 한화전처럼 한 경기에 이벤트 14건.
    for (let i = 1; i <= 14; i++) {
      await sendPush(sub, { kind: 'score', id: i, gameId: GAME, ts: i * 1000 }, env);
    }
    // 재발송은 원본과 같은 경기다.
    await sendPush(sub, { kind: 'score', id: 3, gameId: GAME, ts: 3000, resend: true }, env);
    // 다른 경기.
    await sendPush(sub, { kind: 'start', id: 99, gameId: OTHER, ts: 99000 }, env);
    // 테스트 알림에는 gameId 가 없다.
    await sendPush(sub, { kind: 'test', title: '테스트 알림', ts: 3000 }, env);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const gameTopics = new Set(sent.slice(0, 15).map((h) => h.Topic));
  check('한 경기의 모든 이벤트가 같은 Topic (재발송 포함)',
    gameTopics.size === 1 && [...gameTopics][0] === `g${GAME}`, [...gameTopics].join(','));

  check('다른 경기는 다른 Topic', sent[15].Topic === `g${OTHER}`, sent[15].Topic);
  check('테스트 알림에는 Topic 이 없다', sent[16].Topic === undefined, String(sent[16].Topic));

  // 한 경기가 키를 하나보다 많이 쓰면 여기서 실패한다(FCM 4개 한도).
  const FCM_COLLAPSE_KEY_LIMIT = 4;
  const distinct = new Set(sent.map((h) => h.Topic).filter(Boolean)).size;
  check(`경기 둘을 보내도 서로 다른 Topic 이 ${FCM_COLLAPSE_KEY_LIMIT}개를 안 넘는다 (${distinct}개)`,
    distinct <= FCM_COLLAPSE_KEY_LIMIT, `${distinct}개`);

  // RFC 8030 §5.4: 32자 이내, URL-safe base64 문자만.
  check('Topic 이 RFC 8030 제한을 지킨다',
    sent.every((h) => h.Topic === undefined || (h.Topic.length <= 32 && /^[A-Za-z0-9_-]+$/.test(h.Topic))));
}

/* ══ 3. 시리즈 판별 ══ */

function testSeries() {
  // 2023~2025 실제 gameId 에서 관측한 값
  check('정규시즌', seriesOf('20260822SSNC02026') === 'regular');
  check('와일드카드', seriesOf('44441006NCSS02025') === 'wildcard');
  check('준플레이오프', seriesOf('33331009SSSK02025') === 'semi_playoff');
  check('플레이오프', seriesOf('55551017SSHH02025') === 'playoff');
  check('한국시리즈', seriesOf('77771026HHLG02025') === 'korean_series');
  check('순위결정전', seriesOf('66661001KTSK02024') === 'tiebreaker');

  check('모르는 접두사는 정규시즌으로 안전 처리', seriesOf('1234abcd') === 'regular');
  check('빈 값도 터지지 않음', seriesOf(undefined) === 'regular' && seriesOf(null) === 'regular');

  check('올스타전', seriesOf('99990711WEEA02026') === 'allstar');

  check('포스트시즌 판정', isPostseason('korean_series') && isPostseason('wildcard'));
  check('정규시즌은 포스트시즌 아님', !isPostseason('regular'));
  check('올스타전도 포스트시즌 아님', !isPostseason('allstar'));

  // gameId 끝 4자리 = 시즌 연도. 11월 한국시리즈도 그해 시즌으로 묶인다.
  check('시즌 연도 추출', seasonYearOf('20260822SSNC02026') === 2026);
  check('포스트시즌도 시즌 연도로', seasonYearOf('77771026HHLG02025') === 2025);
  check('잘못된 값은 null', seasonYearOf('abc') === null && seasonYearOf(undefined) === null);
}

/* ══ 3-b. 이번 시즌 필터 ══ */

function testSeasonFilter() {
  const mk = (over) => normalizeGame({
    gameId: '20260415SSNC02026', gameDate: '2026-04-15', gameDateTime: '2026-04-15T18:30:00',
    stadium: '창원', homeTeamCode: 'NC', homeTeamName: 'NC',
    awayTeamCode: 'SS', awayTeamName: '삼성', homeTeamScore: 0, awayTeamScore: 0,
    statusCode: 'BEFORE', cancel: false, suspended: false, ...over,
  });

  const OPENER = '2026-03-28'; // 2026 시즌 실제 개막일 (10개 구단 데이터로 역산 확인)
  const keep = (games) => filterCurrentSeason(games, 2026, OPENER);

  check('정규시즌 경기는 통과', keep([mk({})]).length === 1);

  // 시범경기: 정규시즌과 형식이 같고 날짜만 개막일 전
  const exhibition = mk({ gameId: '20260315WONC02026', gameDate: '2026-03-15' });
  check('시범경기 제외', keep([exhibition]).length === 0);

  const openerDay = mk({ gameId: '20260328SSNC02026', gameDate: '2026-03-28' });
  check('개막일 당일은 포함', keep([openerDay]).length === 1);

  // 올스타전: gameId 접두 9999 + 팀 코드 EA/WE
  const allstar = mk({
    gameId: '99990711WEEA02026', gameDate: '2026-07-11',
    homeTeamCode: 'EA', homeTeamName: '이스턴', awayTeamCode: 'WE', awayTeamName: '웨스턴',
  });
  check('올스타전 제외', keep([allstar]).length === 0);

  // 접두사가 바뀌어도 팀 코드로 걸린다
  const oddAllstar = mk({ gameId: '12340711WEEA02026', homeTeamCode: 'EA', awayTeamCode: 'WE' });
  check('올스타 접두사가 바뀌어도 팀 코드로 제외', keep([oddAllstar]).length === 0);

  const lastSeason = mk({ gameId: '20251026HHLG02025', gameDate: '2025-10-26' });
  check('지난 시즌 제외', keep([lastSeason]).length === 0);

  const lastPost = mk({ gameId: '77771026HHLG02025', gameDate: '2025-10-26' });
  check('지난 시즌 포스트시즌도 제외', keep([lastPost]).length === 0);

  const thisPost = mk({ gameId: '77771026NCLG02026', gameDate: '2026-10-26' });
  check('올해 포스트시즌은 통과', keep([thisPost]).length === 1);

  // 개막일을 모르면 시범경기를 거르지 않는다
  check('개막일 없으면 3월 경기도 통과', filterCurrentSeason([exhibition], 2026, null).length === 1);
  check('개막일 없어도 지난 시즌은 제외', filterCurrentSeason([lastSeason], 2026, null).length === 0);
  check('개막일 없어도 올스타전은 제외', filterCurrentSeason([allstar], 2026, null).length === 0);
}

/* ══ 4. 상태 전이 감지 ══ */

function g(over = {}) {
  return normalizeGame({
    gameId: '20260822SSNC02026', gameDate: '2026-08-22', gameDateTime: '2026-08-22T18:30:00',
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

  const started = detectEvents(g(), g({ statusCode: 'STARTED', statusInfo: '1회초' }), T);
  check('경기 시작 감지', kinds(started) === 'start');
  // es-hangul josa: 삼성(받침 ㅇ) → 과
  check('시작 문구 조사', started[0]?.body === '삼성과의 홈 경기가 시작됐어요. (창원)', started[0]?.body);

  check('변화 없으면 이벤트 없음', detectEvents(g(), g(), T).length === 0);

  const cancelled = detectEvents(g(), g({ cancel: true }), T);
  check('경기 취소 감지', kinds(cancelled) === 'cancel');
  check('취소 문구 조사', cancelled[0]?.body === '삼성과의 홈 경기가 취소됐어요. (창원)', cancelled[0]?.body);

  // 받침 없는 팀명과 영문 약어에서도 조사가 맞아야 한다.
  const vsLotte = detectEvents(
    g({ awayTeamCode: 'LT', awayTeamName: '롯데' }),
    g({ awayTeamCode: 'LT', awayTeamName: '롯데', statusCode: 'STARTED' }), T,
  );
  check('롯데 → 와', vsLotte[0]?.body.startsWith('롯데와의'), vsLotte[0]?.body);

  const vsKt = detectEvents(
    g({ awayTeamCode: 'KT', awayTeamName: 'KT' }),
    g({ awayTeamCode: 'KT', awayTeamName: 'KT', statusCode: 'STARTED' }), T,
  );
  // KT → 케이티 → 받침 없음 → 와
  check('KT → 와 (영문 약어를 한글 발음으로 읽음)', vsKt[0]?.body.startsWith('KT와의'), vsKt[0]?.body);
  check('취소는 한 번만', detectEvents(g({ cancel: true }), g({ cancel: true }), T).length === 0);

  const live = (h, a) => g({ statusCode: 'STARTED', statusInfo: '5회말', homeTeamScore: h, awayTeamScore: a });

  const scored = detectEvents(live(1, 0), live(3, 0), T);
  check('우리 팀 득점', scored[0]?.title === 'NC 2점 득점!', scored[0]?.title);
  check('득점 dedup 키에 점수 포함', scored[0]?.dedupKey.endsWith(':score:3-0'), scored[0]?.dedupKey);
  check('정규시즌 scope', scored[0]?.scope === 'regular');

  /*
   * 상대 득점: 알림 문구는 "○○ n점 득점", 기록에는 concede.
   * 기록 탭의 "실점" 라벨은 recordKind 로 정해진다(app.js KIND_LABEL).
   */
  const conceded = detectEvents(live(1, 0), live(1, 2), T)[0];
  check('상대 득점 문구', conceded?.title === '삼성 2점 득점', conceded?.title);
  check('상대 득점은 기록에 concede 로', conceded?.recordKind === 'concede', conceded?.recordKind);

  // 발송용 kind 는 score 여야 한다. concede 면 수신자가 0명이 된다.
  check('상대 득점도 발송은 score 로', conceded?.kind === 'score', conceded?.kind);

  // 우리 팀 득점·양 팀 득점은 기록도 score 다.
  const ourRun = detectEvents(live(1, 0), live(3, 0), T)[0];
  check('우리 득점 문구', ourRun?.title === 'NC 2점 득점!', ourRun?.title);
  check('우리 득점은 기록도 score', ourRun?.recordKind === 'score', ourRun?.recordKind);

  const bothScored = detectEvents(live(1, 1), live(2, 2), T)[0];
  check('양 팀 득점 문구', bothScored?.title === '양 팀 득점', bothScored?.title);
  check('양 팀 득점은 기록도 score', bothScored?.recordKind === 'score', bothScored?.recordKind);

  // 점수가 내려가는 경우(네이버 정정, 잠깐 예전 값·0:0). 알림이 나가면 안 된다
  // ("삼성 -2점 득점" 같은 게 실제로 나간 적 있음).
  check('홈 점수 하향은 알리지 않는다', detectEvents(live(3, 0), live(2, 0), T).length === 0,
    JSON.stringify(detectEvents(live(3, 0), live(2, 0), T).map((e) => e.title)));
  check('원정 점수 하향도 알리지 않는다', detectEvents(live(2, 5), live(2, 3), T).length === 0);
  check('일시적으로 0:0 이 와도 알리지 않는다', detectEvents(live(3, 2), live(0, 0), T).length === 0);

  // 우리가 득점하면서 상대 점수가 정정돼 내려간 경우. 우리 득점으로 나가야 한다.
  const comeback = detectEvents(live(2, 3), live(3, 2), T)[0];
  check('우리 득점 + 상대 하향이면 우리 득점으로 알린다',
    comeback?.title === 'NC 1점 득점!' && comeback?.recordKind === 'score', comeback?.title);

  // 반대로 상대가 득점하면서 우리 점수가 내려간 경우.
  const oppUp = detectEvents(live(3, 1), live(2, 3), T)[0];
  check('상대 득점 + 우리 하향이면 상대 득점으로 알린다',
    oppUp?.title === '삼성 2점 득점' && oppUp?.recordKind === 'concede', oppUp?.title);

  // 득점 외 이벤트는 recordKind 를 따로 주지 않으므로 kind 와 같아야 한다.
  const startEv = detectEvents(g(), g({ statusCode: 'STARTED', statusInfo: '1회초' }), T)[0];
  check('시작 이벤트는 recordKind 가 kind 와 같다', startEv?.recordKind === startEv?.kind);

  // ── 득점 이닝: 전광판 합이 총점과 맞을 때만 붙인다 (detect.js scoringInning) ──
  const withBoard = (h, a, board) => Object.assign(live(h, a), { board });
  const side = (innings) => ({ innings, r: 0, h: 0, e: 0, b: 0 });
  const bodyOf = (prev, cur) => detectEvents(prev, cur, T)[0]?.body;

  check('홈 득점 이닝은 말',
    bodyOf(live(1, 0), withBoard(3, 0, { home: side([0, 0, 1, 0, 2]), away: side([0, 0, 0, 0, 0]) }))
      === 'NC 3 : 0 삼성 · 5회말');

  check('원정 득점 이닝은 초',
    bodyOf(live(1, 0), withBoard(1, 2, { home: side([0, 1]), away: side([0, 2]) }))
      === 'NC 1 : 2 삼성 · 2회초');

  check('이닝별 합이 총점과 다르면 이닝 생략 (두 API 시점 어긋남)',
    bodyOf(live(1, 0), withBoard(3, 0, { home: side([0, 0, 1]), away: side([0, 0, 0]) }))
      === 'NC 3 : 0 삼성');

  check('양 팀이 같은 틱에 득점하면 이닝 생략',
    bodyOf(live(1, 1), withBoard(2, 2, { home: side([1, 1]), away: side([1, 1]) }))
      === 'NC 2 : 2 삼성');

  check('전광판이 없으면 이닝 생략',
    bodyOf(live(1, 0), withBoard(2, 0, null)) === 'NC 2 : 0 삼성');

  check('연장 이닝도 그대로 센다',
    bodyOf(live(3, 3), withBoard(4, 3, { home: side([1, 0, 0, 0, 0, 2, 0, 0, 0, 1]), away: side([]) }))
      === 'NC 4 : 3 삼성 · 10회말');

  const ended = detectEvents(live(5, 3), g({ statusCode: 'RESULT', homeTeamScore: 5, awayTeamScore: 3 }), T);
  check('경기 종료 · 승리', ended[0]?.title === '경기 종료 · NC 승리', ended[0]?.title);

  const lost = detectEvents(live(2, 3), g({ statusCode: 'RESULT', homeTeamScore: 2, awayTeamScore: 7 }), T);
  check('종료 전이에서는 득점 알림 없음', kinds(lost) === 'end', kinds(lost));

  // ENDED: RESULT 전에 최대 10분쯤 거치는 상태(poll_log). result 로 봐야 종료 알림이 안 밀린다.
  const endedStatus = detectEvents(live(5, 3), g({ statusCode: 'ENDED', homeTeamScore: 5, awayTeamScore: 3 }), T);
  check('ENDED 도 종료로 감지', kinds(endedStatus) === 'end', kinds(endedStatus));
  check('ENDED → RESULT 전이는 중복 아님(같은 스냅샷이면 재알림 없음)',
    detectEvents(
      g({ statusCode: 'ENDED', homeTeamScore: 5, awayTeamScore: 3 }),
      g({ statusCode: 'RESULT', homeTeamScore: 5, awayTeamScore: 3 }),
      T,
    ).length === 0);

  // READY: BEFORE 와 STARTED 사이에 최대 53분 거치는 상태(poll_log). live 로 보면
  // 시작 알림이 그만큼 일찍 나간다.
  const beforeToReady = detectEvents(g(), g({ statusCode: 'READY' }), T);
  check('READY 는 아직 경기 전 — 시작 알림 없음', beforeToReady.length === 0, kinds(beforeToReady));

  const readyToStarted = detectEvents(
    g({ statusCode: 'READY' }),
    g({ statusCode: 'STARTED', statusInfo: '1회초' }),
    T,
  );
  check('READY → STARTED 전이에서 시작 알림', kinds(readyToStarted) === 'start', kinds(readyToStarted));

  // 원정 경기에서도 우리 팀 기준이 맞아야 한다.
  const away = (h, a) => g({
    homeTeamCode: 'SS', homeTeamName: '삼성', awayTeamCode: 'NC', awayTeamName: 'NC',
    statusCode: 'STARTED', homeTeamScore: h, awayTeamScore: a,
  });
  check('원정 경기 득점 판정', detectEvents(away(0, 0), away(0, 1), T)[0]?.title === 'NC 1점 득점!');
  const p = perspective(away(0, 1), T);
  check('원정 경기 관점', !p.isHome && p.oppName === '삼성' && p.teamScore === 1);

  // ── 홈/원정 표시("홈경기만 받기" 필터용) ──
  check('홈경기 이벤트는 isHome true', detectEvents(live(1, 0), live(2, 0), T)[0]?.isHome === true);
  check('원정경기 이벤트는 isHome false', detectEvents(away(0, 0), away(0, 1), T)[0]?.isHome === false);

  // ── 포스트시즌 ──
  const ks = (over) => normalizeGame({
    gameId: '77771026NCLG02026', gameDate: '2026-10-26', gameDateTime: '2026-10-26T14:00:00',
    stadium: '창원', homeTeamCode: 'NC', homeTeamName: 'NC', awayTeamCode: 'LG', awayTeamName: 'LG',
    homeTeamScore: 0, awayTeamScore: 0, statusCode: 'BEFORE', cancel: false, suspended: false, ...over,
  });

  const ksStart = detectEvents(ks(), ks({ statusCode: 'STARTED' }), T);
  check('한국시리즈 scope = postseason', ksStart[0]?.scope === 'postseason', ksStart[0]?.scope);
  check('제목에 시리즈 표시', ksStart[0]?.title === '[한국시리즈] 경기 시작', ksStart[0]?.title);

  const ksScore = detectEvents(
    ks({ statusCode: 'STARTED', homeTeamScore: 0, awayTeamScore: 0 }),
    ks({ statusCode: 'STARTED', homeTeamScore: 1, awayTeamScore: 0 }), T,
  );
  check('포스트시즌 득점 제목', ksScore[0]?.title === '[한국시리즈] NC 1점 득점!', ksScore[0]?.title);

  // ── 홈런 표시. index.js poll() 이 game.hr 을 채우는 걸 흉내 낸다.
  // hr 은 "오스틴33호(8회3점 손주환)" 같은 문자열 목록이다.
  const withHr = (game, hr) => Object.assign(game, { hr });
  const HR1 = '오스틴33호(8회3점 손주환)';
  const HR2 = '박건우5호(3회1점 김진수)';

  const hrScored = detectEvents(withHr(live(1, 0), []), withHr(live(4, 0), [HR1]), T);
  check('새 홈런이 원문 그대로 붙음', hrScored[0]?.body.endsWith(` · ${HR1}`), hrScored[0]?.body);

  const noHrScored = detectEvents(withHr(live(1, 0), [HR1]), withHr(live(2, 0), [HR1]), T);
  check('목록이 그대로면(새 홈런 없음) 표시 없음', !noHrScored[0]?.body.includes(HR1), noHrScored[0]?.body);

  // 전광판 조회 실패로 hr 이 이전 값 그대로인 경우. 새 홈런이 아니다.
  const carriedOver = detectEvents(withHr(live(1, 0), [HR1]), withHr(live(1, 1), [HR1]), T);
  check('hr 목록이 안 늘면 실점이어도 표시 없음', !carriedOver[0]?.body.includes(HR1), carriedOver[0]?.body);

  // 한 틱에 둘 이상 새로 생기면(드물지만) 둘 다 붙인다.
  const twoHr = detectEvents(withHr(live(1, 0), []), withHr(live(5, 0), [HR1, HR2]), T);
  check('한 틱에 홈런 2개면 둘 다 표시', twoHr[0]?.body.includes(HR1) && twoHr[0]?.body.includes(HR2), twoHr[0]?.body);
}

/* ══ 5. 포스트시즌 진출 판정 ══ */

function testOutlook() {
  // 2026-08-23 실제 순위표에서 가져온 값 (NC 8위)
  const standings = {
    cutoff: 5,
    tiers: [
      { title: '한국시리즈 진출', from: 1, to: 1 },
      { title: '플레이오프 진출', from: 2, to: 2 },
      { title: '준플레이오프 진출', from: 3, to: 3 },
      { title: '와일드카드 결정전 진출', from: 4, to: 5 },
    ],
    teams: [
      { code: 'KT', name: 'KT', rank: 1, games: 107, wins: 63, draws: 3, losses: 41, pct: 0.606, gb: 0.0 },
      { code: 'SS', name: '삼성', rank: 2, games: 110, wins: 64, draws: 2, losses: 44, pct: 0.593, gb: 1.0 },
      { code: 'HT', name: 'KIA', rank: 3, games: 111, wins: 60, draws: 2, losses: 49, pct: 0.550, gb: 5.5 },
      { code: 'LG', name: 'LG', rank: 4, games: 111, wins: 60, draws: 1, losses: 50, pct: 0.545, gb: 6.0 },
      { code: 'OB', name: '두산', rank: 5, games: 111, wins: 57, draws: 4, losses: 50, pct: 0.533, gb: 7.5 },
      { code: 'NC', name: 'NC', rank: 8, games: 105, wins: 48, draws: 2, losses: 55, pct: 0.466, gb: 14.5 },
    ],
  };

  const o = postseasonOutlook(standings, 'NC', 144);
  check('NC 8위 인식', o.rank === 8);
  check('진출 하한선 = 5위', o.cutoff === 5 && o.cutoffTeam.name === '두산');
  check('잔여 경기 = 39', o.remaining === 39, String(o.remaining));
  check('5위와 7.0경기차', o.gamesBehindLine === 7, String(o.gamesBehindLine));
  // 48 + 39 = 87 > 57 이므로 산술적으로는 아직 가능하다.
  check('아직 산술적 가능 → chasing', o.status === 'chasing', o.status);
  // 두산(받침 ㄴ) → 을
  check('note 조사 처리', o.note === '잔여 39경기. 두산을 넘어야 진출권에 들어요.', o.note);

  // 잔여 경기가 적어 5위 현재 승수를 못 넘는 경우 → 확정 탈락
  const late = structuredClone(standings);
  late.teams.find((t) => t.code === 'NC').games = 143;
  const oLate = postseasonOutlook(late, 'NC', 144);
  check('산술적 탈락 확정', oLate.status === 'eliminated', oLate.status);

  // 진출권 안이면 tier 제목을 그대로 준다.
  const top = structuredClone(standings);
  top.teams.find((t) => t.code === 'NC').rank = 3;
  const oTop = postseasonOutlook(top, 'NC', 144);
  check('진출권 안 → in', oTop.status === 'in' && oTop.tierTitle === '준플레이오프 진출', oTop.tierTitle);

  // 진출 기준을 못 받아오면 추측하지 않고 판정을 포기한다.
  check('cutoff 없으면 null', postseasonOutlook({ ...standings, cutoff: null }, 'NC', 144) === null);
  check('없는 팀이면 null', postseasonOutlook(standings, 'XX', 144) === null);

  // 바로 아래 순위와의 승차(chaser).
  check('목록 마지막이면 쫓아오는 팀 없음', o.chaser === null, JSON.stringify(o.chaser));

  const withBelow = structuredClone(standings);
  withBelow.teams.push(
    { code: 'LT', name: '롯데', rank: 9, games: 106, wins: 45, draws: 1, losses: 60, pct: 0.429, gb: 17.5 },
  );
  const oBelow = postseasonOutlook(withBelow, 'NC', 144);
  check('바로 아래 순위를 집어낸다', oBelow.chaser?.rank === 9 && oBelow.chaser?.name === '롯데',
    JSON.stringify(oBelow.chaser));
  // 둘 다 1위 기준 승차라 빼면 이웃 간 거리가 된다: 17.5 - 14.5
  check('아래와의 승차 = 3', oBelow.chaser?.gap === 3, String(oBelow.chaser?.gap));

  // 공동 순위. rank + 1 로는 못 찾으니(공동 8위면 다음은 10위) 목록의 다음 팀을 쓴다.
  const tied = structuredClone(standings);
  tied.teams.push(
    { code: 'LT', name: '롯데', rank: 8, games: 105, wins: 48, draws: 2, losses: 55, pct: 0.466, gb: 14.5 },
  );
  const oTied = postseasonOutlook(tied, 'NC', 144);
  check('공동 순위여도 다음 팀을 찾는다', oTied.chaser?.name === '롯데' && oTied.chaser?.gap === 0,
    JSON.stringify(oTied.chaser));
}

/* ══ 5-b. 상대 전적 ══ */

function testHeadToHead() {
  const g = (oppName, result, series = 'regular') => ({ oppName, result, series });

  const rows = headToHead([
    g('삼성', 'win'), g('삼성', 'win'), g('삼성', 'lose'), g('삼성', 'draw'),
    g('LG', 'lose'), g('LG', 'lose'), g('LG', 'win'),
    g('KIA', 'win'),
    // 아직 안 끝난 경기는 result 가 null 이라 세지 않는다.
    g('한화', null),
  ]);

  const find = (o) => rows.find((r) => r.opp === o);
  check('상대별로 묶어 센다', find('삼성')?.wins === 2 && find('삼성')?.losses === 1, JSON.stringify(find('삼성')));
  check('무승부도 따로 센다', find('삼성')?.draws === 1, String(find('삼성')?.draws));
  check('안 끝난 경기는 빼고 센다', find('한화') === undefined, JSON.stringify(find('한화')));

  // KBO 공식대로 무승부는 승률에서 뺀다: 2/(2+1)
  check('승률은 무승부 제외', Math.abs(find('삼성').pct - 2 / 3) < 1e-9, String(find('삼성').pct));
  // 승률 높은 순: KIA 1.000 이 삼성 .667 보다 먼저
  check('승률 높은 상대부터 정렬', rows[0].opp === 'KIA' && rows.at(-1).opp === 'LG',
    rows.map((r) => r.opp).join(','));

  // 포스트시즌 경기는 세지 않는다.
  const mixed = headToHead([g('두산', 'win'), g('두산', 'win', 'semi_playoff'), g('두산', 'lose', 'korean_series')]);
  check('포스트시즌은 상대전적에서 제외', mixed[0].wins === 1 && mixed[0].losses === 0,
    JSON.stringify(mixed[0]));

  // 승패가 하나도 없는 상대는 pct null(0 으로 나누면 NaN).
  const allDraw = headToHead([g('키움', 'draw'), g('키움', 'draw')]);
  check('승도 패도 없으면 승률 null (0 나눗셈 방지)',
    allDraw[0].pct === null && allDraw[0].draws === 2, JSON.stringify(allDraw[0]));

  check('경기가 없으면 빈 목록', headToHead([]).length === 0);
}

/* ══ 6. 시즌·시간대 게이팅 ══ */

function testWindow() {
  const start = kstIsoToEpoch('2026-08-22T18:30:00');
  check('KST 문자열 → epoch', start === Date.parse('2026-08-22T09:30:00Z'), String(start));

  const plan = { games: [{ gameId: 'G', startAt: '2026-08-22T18:30:00' }] };
  const isPollWindow = (p, t) => pollWindowGames(p, t).length > 0;
  const MIN = 60000, HOUR = 3600000;

  check('경기 3시간 전 → 감시 안 함', !isPollWindow(plan, start - 3 * HOUR));
  check('경기 90분 전 → 감시 시작', isPollWindow(plan, start - 90 * MIN));
  check('경기 중 → 감시', isPollWindow(plan, start + 2 * HOUR));
  check('종료 후 7시간 → 감시', isPollWindow(plan, start + 7 * HOUR));
  check('종료 후 8시간 → 감시 안 함', !isPollWindow(plan, start + 8 * HOUR));
  check('경기 없는 날 → 감시 안 함', !isPollWindow({ games: [] }, start));
  check('시각을 못 읽으면 안전하게 감시', isPollWindow({ games: [{ startAt: 'broken' }] }, start));

  // 시간대 안에 있는 경기만 골라야 한다(종료 판단 대상).
  const two = {
    games: [
      { gameId: 'TODAY', startAt: '2026-08-22T18:30:00' },
      { gameId: 'YESTERDAY', startAt: '2026-08-21T18:30:00' },
    ],
  };
  const ids = (now) => pollWindowGames(two, now).map((g) => g.gameId).join(',');
  check('창 안의 경기만 고른다', ids(start + HOUR) === 'TODAY', ids(start + HOUR));
  check('창 밖이면 빈 목록', pollWindowGames(two, start + 9 * HOUR).length === 0);
}

/* ══ 6-b. 경기가 끝난 뒤 감시를 접는 판단 ══ */

async function testSettled() {
  const { db, insert } = sqliteD1();
  const ev = (game_id, kind, created_at) => insert('events', {
    game_id, kind, created_at, game_date: '2026-08-22', dedup_key: `${game_id}:${kind}`, title: 't', body: 'b',
  });
  ev('A', 'end', '2026-08-22T13:00:00.000Z');
  ev('B', 'cancel', '2026-08-22T13:20:00.000Z');
  ev('C', 'start', '2026-08-22T12:00:00.000Z'); // 시작만 한 경기는 끝난 걸로 치면 안 된다
  const late = '2026-08-22T14:00:00.000Z'; // 두 경기 모두 끝나고 40분 지난 시점
  const soon = '2026-08-22T13:10:00.000Z'; // B 가 아직 안 끝난 시점

  check('감시 대상이 없으면 멈춘다', await allSettledBefore(db, [], late));
  check('모두 끝나고 유예가 지나면 멈춘다', await allSettledBefore(db, ['A', 'B'], late));
  check('한 경기만 끝났으면 계속 본다', !(await allSettledBefore(db, ['A', 'B'], soon)));
  check('기록에 없는 경기가 섞이면 계속 본다', !(await allSettledBefore(db, ['A', 'C'], late)));
}

async function testScheduleResilience() {
  const originalFetch = globalThis.fetch;
  const expired = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  try {
    // 네이버가 완전히 안 돼서 fetch 가 예외를 던지는 상황.
    globalThis.fetch = async () => { throw new Error('naver down'); };

    // 남은 캐시도 없으면(첫 배포 직후 등) 빈 목록.
    const games = await loadSchedule({ DB: cacheDb(), TEAM_CODE: 'NC' }, 2026);
    check(
      '일정 조회 실패 + 캐시 없음 → 빈 목록',
      Array.isArray(games) && games.length === 0,
      JSON.stringify(games),
    );

    // 만료된 캐시가 있으면 그걸 준다.
    const lastGood = [{ gameId: '20260822SSNC02026', gameDate: '2026-08-22', oppName: '삼성' }];
    const staleDb = cacheDb({
      'schedule:2026': { value: JSON.stringify(lastGood), expires_at: expired },
    });
    const fallback = await loadSchedule({ DB: staleDb, TEAM_CODE: 'NC' }, 2026);
    check(
      '일정 조회 실패 + 만료 캐시 있음 → 마지막 정상값',
      JSON.stringify(fallback) === JSON.stringify(lastGood),
      JSON.stringify(fallback),
    );

    // 정상 조회면 조회 시각(fetchedAt)이 붙는다. 화면의 "○○ 기준" 표시용.
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        success: true,
        result: {
          seasonTeamStats: [{
            teamId: 'NC', teamName: 'NC', ranking: 8, gameCount: 107, winGameCount: 48,
            drawnGameCount: 2, loseGameCount: 57, wra: 0.457, gameBehind: 12.5,
            continuousGameResult: '3승',
          }],
        },
      }),
    });
    const before = Date.now();
    const fresh = await loadStandings({ DB: cacheDb() }, 2026);
    const at = Date.parse(fresh?.fetchedAt ?? '');
    check('정상 조회한 순위에 fetchedAt 부착', at >= before && at <= Date.now(), fresh?.fetchedAt);

    // 연속 기록은 continuousGameResult 를 그대로 쓴다. 필드명이 바뀌면 칸만 비고
    // 에러는 안 나서 여기서 확인한다.
    check('연속 기록을 순위에 실어 보낸다', fresh?.teams?.[0]?.streak === '3승', fresh?.teams?.[0]?.streak);

    globalThis.fetch = async () => { throw new Error('naver down'); };

    // 순위도 같은 방식으로 되돌아간다.
    const lastStandings = { year: 2026, teams: [{ code: 'NC', rank: 8 }] };
    const standDb = cacheDb({
      'standings:2026': { value: JSON.stringify(lastStandings), expires_at: expired },
    });
    const standFallback = await loadStandings({ DB: standDb }, 2026);
    check(
      '순위 조회 실패 + 만료 캐시 있음 → 마지막 정상값',
      standFallback?.teams?.[0]?.rank === 8,
      JSON.stringify(standFallback),
    );

    // 평소 경로(getCache)는 만료된 값을 읽으면 안 된다.
    const plain = await getCache(
      cacheDb({ 'schedule:2026': { value: '[1,2,3]', expires_at: expired } }),
      'schedule:2026',
    );
    check('만료된 캐시는 평상시 getCache 로는 안 읽힘', plain === null, JSON.stringify(plain));

    // 경기 종료 때 만료시킨 값도 폴백으로 쓸 수 있어야 한다. null 로 덮어쓰면
    // 그 직후 네이버가 안 될 때 일정이 빈 목록이 된다.
    const { db: realDb } = sqliteD1();
    await putCache(realDb, 'schedule:2026', lastGood, 60 * 60 * 1000);
    await invalidateSchedule({ DB: realDb }, 2026);
    check('무효화하면 평상시 getCache 는 미스', (await getCache(realDb, 'schedule:2026')) === null);
    const afterInvalidate = await loadSchedule({ DB: realDb, TEAM_CODE: 'NC' }, 2026);
    check('무효화 직후 조회 실패 → 마지막 정상값',
      JSON.stringify(afterInvalidate) === JSON.stringify(lastGood), JSON.stringify(afterInvalidate));
  } finally {
    globalThis.fetch = originalFetch;
  }
}

/**
 * 개막일을 못 정한 결과도 캐시되는지.
 *
 * resolveSeasonOpener 는 자주 불려서, 개막 전(경기 수 0)이나 조회 실패를 캐시하지
 * 않으면 그때마다 외부 호출이 나간다.
 */
async function testOpenerCaching() {
  const originalFetch = globalThis.fetch;
  try {
    let fetches = 0;
    const standingsWith = (gameCount) => async () => {
      fetches++;
      return {
        ok: true,
        json: async () => ({
          success: true,
          result: { seasonTeamStats: [{ teamId: 'NC', teamName: 'NC', ranking: 1, gameCount }] },
        }),
      };
    };

    // 개막 전: 순위표는 오지만 경기 수가 0
    globalThis.fetch = standingsWith(0);
    const env = { DB: cacheDb(), TEAM_CODE: 'NC' };
    for (let i = 0; i < 5; i++) await resolveSeasonOpener(env, 2027);
    check('개막 전 5틱 → 외부 호출 1회 (결과 null 도 캐시)', fetches === 1, `${fetches}회`);

    // 조회 실패도 마찬가지
    fetches = 0;
    globalThis.fetch = async () => { fetches++; throw new Error('naver down'); };
    const env2 = { DB: cacheDb(), TEAM_CODE: 'NC' };
    for (let i = 0; i < 5; i++) await resolveSeasonOpener(env2, 2027);
    check('조회 실패 5틱 → 외부 호출 1회', fetches === 1, `${fetches}회`);

    // 못 정한 결과는 짧게 캐시한다. 개막하면 금방 다시 확인해야 하니까.
    const db3 = cacheDb();
    await resolveSeasonOpener({ DB: db3, TEAM_CODE: 'NC' }, 2027);
    const row = await db3.prepare('SELECT value, expires_at FROM cache WHERE key = ?').bind('opener:2027').first();
    const ttlH = (Date.parse(row?.expires_at ?? '') - Date.now()) / 3600000;
    check('미확정 캐시는 하루 안에 만료', ttlH > 0 && ttlH < 24, `${ttlH.toFixed(1)}시간`);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

/** 날짜별 캐시 정리가 지울 것과 남길 것을 맞게 고르는지. */
async function testCachePrune() {
  const keys = ['plan:2026-08-01', 'plan:2026-08-18', 'plan:2026-08-19', 'plan:2026-08-25',
    'today:2026-08-01', 'today:2026-08-19', 'schedule:2026', 'standings:2026', 'opener:2026'];
  const d = sqliteD1();
  for (const key of keys) d.insert('cache', { key, value: '1', expires_at: 'x', updated_at: 'x' });
  await pruneDatedCache(d.db, '2026-08-19');

  const left = d.sqlite.prepare('SELECT key FROM cache ORDER BY key').all().map((r) => r.key);
  const gone = keys.filter((k) => !left.includes(k)).sort();
  check('지난 plan·today 만 지운다', gone.join() === 'plan:2026-08-01,plan:2026-08-18,today:2026-08-01', gone.join());
  check('기준일 당일은 남긴다', left.includes('plan:2026-08-19') && left.includes('today:2026-08-19'));
  check('연도별 키는 남긴다(폴백용)', ['schedule:2026', 'standings:2026', 'opener:2026'].every((k) => left.includes(k)));
}

/* ══ 7. 보안 검증 ══ */

function testSecurity() {
  // SSRF: 서버가 이 URL 로 POST 하니까 아무 호스트나 받으면 안 된다.
  check('FCM 허용', validateEndpoint('https://fcm.googleapis.com/fcm/send/x').ok);
  check('Apple 허용', validateEndpoint('https://web.push.apple.com/abc').ok);
  check('Mozilla 허용', validateEndpoint('https://updates.push.services.mozilla.com/wpush/v2/x').ok);
  check('WNS 허용', validateEndpoint('https://wns2-par02p.notify.windows.com/w/?token=x').ok);

  check('임의 호스트 거부', !validateEndpoint('https://evil.example.com/collect').ok);
  check('내부망 주소 거부', !validateEndpoint('https://192.168.0.1/admin').ok);
  check('http 거부', !validateEndpoint('http://fcm.googleapis.com/fcm/send/x').ok);
  check('file 스킴 거부', !validateEndpoint('file:///etc/passwd').ok);
  check('URL 아닌 값 거부', !validateEndpoint('not a url').ok);
  check('빈 값 거부', !validateEndpoint('').ok && !validateEndpoint(undefined).ok);
  check('과도하게 긴 값 거부', !validateEndpoint('https://fcm.googleapis.com/' + 'a'.repeat(2000)).ok);

  // 접미사 검사가 도메인 경계를 지키는지(evil-notify.windows.com.attacker.com 같은 것)
  check('접미사 우회 거부', !validateEndpoint('https://notify.windows.com.evil.com/x').ok);

  check('EXTRA_PUSH_HOSTS 로 추가 허용', validateEndpoint('https://push.example.org/x', 'push.example.org').ok);

  // 키 형식
  const p256 = 'A'.repeat(87); // 87자 → 65바이트
  const auth = 'B'.repeat(22); // 22자 → 16바이트
  check('정상 키 통과', validateKeys(p256, auth).ok);
  check('짧은 p256dh 거부', !validateKeys('AAA', auth).ok);
  check('짧은 auth 거부', !validateKeys(p256, 'BB').ok);
  check('base64url 아닌 문자 거부', !validateKeys('A'.repeat(86) + '!', auth).ok);
  check('타입 다르면 거부', !validateKeys(null, auth).ok && !validateKeys(p256, 123).ok);

  // CSRF: Origin 이 다르면 거부, 없으면(브라우저가 아님) 통과
  const url = new URL('https://app.example.com/api/settings');
  const req = (origin) => ({ headers: { get: (k) => (k === 'Origin' ? origin : null) } });
  check('같은 출처 통과', checkOrigin(req('https://app.example.com'), url));
  check('다른 출처 거부', !checkOrigin(req('https://evil.example.com'), url));
  check('Origin 없으면 통과', checkOrigin(req(null), url));
}

/**
 * 본문 크기 제한이 문자 수가 아니라 바이트 수 기준인지.
 * Content-Length 가 없으면 본문을 읽어서 재는데, 한글은 3바이트라 문자 수로 재면
 * 4096자 제한에 12KB 까지 통과한다.
 */
async function testReadJsonByteLimit() {
  const req = (text) => ({
    headers: { get: () => null }, // Content-Length 없음. 본문을 읽어서 재는 경로
    text: async () => text,
  });

  // 한글 1400자 ≈ 4200바이트: 문자 수로는 상한(4096) 안이지만 바이트로는 넘는다.
  const asciiJson = `{"a":"${'a'.repeat(4000)}"}`; // 문자 수·바이트 수 모두 상한 안
  const koreanOverflow = `{"a":"${'가'.repeat(1400)}"}`; // 문자 수는 상한 안, 바이트는 초과

  check(
    '문자 수 기준으로는 상한 안인 한글 본문도 바이트 기준으로 거부',
    !(await readJson(req(koreanOverflow))).ok,
    `문자 수 ${koreanOverflow.length}, 바이트 ${new TextEncoder().encode(koreanOverflow).byteLength}`,
  );
  check(
    'ASCII 상한 근처 정상 본문은 그대로 통과',
    (await readJson(req(asciiJson))).ok,
  );
}


/* ══ 7-c. 구독 상한이 subrequest 예산 안인지 ══ */

/**
 * broadcast 는 구독 수만큼 fetch 를 보낸다. 호출당 50개를 넘으면 51번째부터
 * 실패하는데 allSettled 라 티가 안 난다. 구독 상한이나 POLLS_PER_TICK 을 올리면
 * 여기서 먼저 걸리게 한다.
 */
function testSubrequestBudget() {
  const N = MAX_SUBSCRIPTIONS;
  // 재발송 1건 + 폴링마다 (전광판 1 + 재조회/중계 1 + 이벤트 2건 발송 2N)
  const worst = N + POLLS_PER_TICK * (2 + 2 * N);

  check(`최악의 틱이 subrequest 예산 안에 든다 (${worst} ≤ ${SUBREQUEST_BUDGET})`,
    worst <= SUBREQUEST_BUDGET, `구독 ${N}, 폴링 ${POLLS_PER_TICK}회`);

  // 상한이 예산에 딱 맞게 정해졌는지(하나 더 받으면 넘어야 함).
  const oneMore = (N + 1) + POLLS_PER_TICK * (2 + 2 * (N + 1));
  check('상한이 예산에 비해 지나치게 낮지 않다',
    oneMore > SUBREQUEST_BUDGET - POLLS_PER_TICK * 2,
    `구독 ${N + 1} → ${oneMore}`);
}


/* ══ 7-d. 상한에 찼을 때 그 기기에 알림이 가는가 ══ */

/**
 * 2026-09-20 상한을 200 → 8 로 내린 뒤 상한에서 등록을 거절(429)하게 돼 있었고,
 * 9/24~27 알림이 끊긴 원인이 이거였다.
 *
 * 행 개수가 아니라 그 기기가 실제로 발송 대상(subscribersFor)에 들어가는지 본다.
 * 실제 스키마(schema.sql)로 돌린다.
 */
async function testSubscriptionEviction() {
  const { sqlite, db } = sqliteD1();

  // 기본값(모든 알림 켜짐)으로 n 건을 채운다. updated_at 이 오래된 순으로 ep0..
  const seed = (n) => {
    sqlite.exec('DELETE FROM subscriptions');
    for (let i = 0; i < n; i++) {
      sqlite
        .prepare('INSERT INTO subscriptions (endpoint,p256dh,auth,created_at,updated_at) VALUES (?,?,?,?,?)')
        .run(`ep${i}`, 'p', 'a', '2026-01-01', `2026-01-${String(i + 1).padStart(2, '0')}`);
    }
  };
  const rows = () => sqlite.prepare('SELECT endpoint FROM subscriptions ORDER BY updated_at').all()
    .map((r) => r.endpoint);
  // 실제 발송 대상. broadcast 가 이 목록으로 푸시를 보낸다(index.js).
  const willBeNotified = async (endpoint) =>
    (await subscribersFor(db, 'score', 'regular', false)).some((r) => r.endpoint === endpoint);

  /*
   * 그때 상황 재현:
   *   1. 구독이 상한까지 차 있다
   *   2. 기기 엔드포인트가 만료돼 410, 행 삭제
   *   3. 앱이 새 엔드포인트로 다시 등록
   *   4. 그 기기에 알림이 가야 한다 (예전 코드는 3에서 429 로 막혔다)
   */
  seed(8);
  await deleteSubscription(db, 'ep3');                      // 410 으로 지워짐
  sqlite.prepare('INSERT INTO subscriptions (endpoint,p256dh,auth,created_at,updated_at) VALUES (?,?,?,?,?)')
    .run('ep8', 'p', 'a', '2026-02-01', '2026-02-01');      // 그 사이 다른 기기가 자리를 채움
  await makeRoomForSubscription(db, 8);
  await saveSubscription(db, { endpoint: 'ep3-rotated', p256dh: 'p', auth: 'a' });

  check('엔드포인트가 바뀐 기기가 다시 등록된다', rows().includes('ep3-rotated'), rows().join(','));
  check('그 기기가 실제 발송 대상에 든다 (알림이 간다)',
    await willBeNotified('ep3-rotated'));
  check('표는 여전히 상한 이하', rows().length <= 8, `${rows().length}건`);

  // 몇 개에서 시작하든 상한 밑으로 줄어드는지. 12건은 상한을 내리기 전에 쌓인 경우.
  for (const [startCount, max] of [[12, 8], [8, 8], [7, 8], [0, 8], [1, 1]]) {
    seed(startCount);
    await makeRoomForSubscription(db, max);
    await saveSubscription(db, { endpoint: 'NEW', p256dh: 'p', auth: 'a' });
    const after = rows();
    check(`구독 ${startCount}건·상한 ${max} → 새 기기에 알림이 가고 상한을 안 넘는다 (${after.length}건)`,
      after.includes('NEW') && after.length <= max && await willBeNotified('NEW'),
      after.join(','));
  }

  // 지워지는 건 가장 오래 갱신 안 된 행이어야 한다(대개 죽은 엔드포인트).
  seed(8);
  const evicted = await makeRoomForSubscription(db, 8);
  check('가장 오래된 행부터 밀어낸다', evicted.length === 1 && evicted[0] === 'ep0', evicted.join(','));

  // 지워진 기기는 발송 대상에서도 빠져야 한다(안 그러면 예산 계산이 틀어짐).
  check('밀려난 기기는 발송 대상에서도 빠진다', !(await willBeNotified('ep0')));
}

/* ══ 8. 홈경기 전용 알림 필터 ══ */

async function testHomeOnly() {
  const subsDb = () => {
    const d = sqliteD1();
    const sub = (endpoint, home_only) =>
      d.insert('subscriptions', { endpoint, p256dh: 'p', auth: 'a', home_only, created_at: 'x', updated_at: 'x' });
    sub('all', 0);
    sub('homeonly', 1);
    d.insert('subscriptions', { endpoint: 'nostart', p256dh: 'p', auth: 'a', on_start: 0, created_at: 'x', updated_at: 'x' });
    return d;
  };
  const names = (r) => r.map((x) => x.endpoint).sort().join(',');

  const home = await subscribersFor(subsDb().db, 'start', 'regular', true);
  check('홈경기 → 전체 수신자 + 홈경기전용 모두', names(home) === 'all,homeonly', names(home));

  const awayGame = await subscribersFor(subsDb().db, 'start', 'regular', false);
  check('원정경기 → 홈경기전용은 제외', names(awayGame) === 'all', names(awayGame));

  // 종류를 끈 구독은 빠지고, 다른 종류에서는 받는다.
  const score = await subscribersFor(subsDb().db, 'score', 'regular', true);
  check('알림 종류를 끈 구독은 그 종류만 제외', names(home).indexOf('nostart') < 0 && names(score).includes('nostart'), names(score));

  // 모르는 kind·scope 면 조회하지 않는다.
  const d = subsDb();
  check('모르는 종류는 빈 배열', (await subscribersFor(d.db, 'nope', 'regular', true)).length === 0);
  check('모르는 범위는 빈 배열', (await subscribersFor(d.db, 'start', 'nope', true)).length === 0);
  check('모르는 값이면 쿼리도 안 나간다', d.calls.length === 0, String(d.calls.length));
}

/** 알림 설정 읽기·쓰기가 SETTING_COLUMN 하나로 화면 스위치와 맞물리는지. */
async function testSettings() {
  // 화면의 설정 스위치(data-key)와 서버가 받는 키가 같아야 한다. 어긋나면 그 스위치는 저장이 안 된다.
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const uiKeys = [...html.matchAll(/data-key="(\w+)"/g)].map((m) => m[1]).sort().join();
  check('화면 스위치 키 = 서버 설정 키', uiKeys === Object.keys(SETTING_COLUMN).sort().join(), uiKeys);

  const { db, insert } = sqliteD1();
  insert('subscriptions', { endpoint: 'e', p256dh: 'p', auth: 'a', created_at: 'x', updated_at: 'x' });
  const all = await getSettings(db, 'e');
  check('기본값: 알림 전부 켬, 홈경기만은 끔',
    Object.entries(all).every(([k, v]) => v === (k !== 'homeOnly')), JSON.stringify(all));

  await updateSettings(db, 'e', { score: false, homeOnly: true, bogus: true });
  const after = await getSettings(db, 'e');
  check('준 항목만 바뀐다', after.score === false && after.homeOnly === true && after.start === true, JSON.stringify(after));
  check('모르는 키는 결과에 없다', !('bogus' in after));
  check('없는 구독은 null', (await getSettings(db, 'none')) === null);
}

/* ══ 9. 전광판 조회 ══ */

/** 네이버 record 응답. 2026-08-22 SS@NC 실제 응답에서 가져왔다. */
function fakeRecordResponse(scoreBoard, etcRecords) {
  return {
    ok: true,
    json: async () => ({
      code: 200, success: true,
      result: { recordData: scoreBoard ? { scoreBoard, etcRecords } : null },
    }),
  };
}

async function testScoreboard() {
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async () => fakeRecordResponse({
      rheb: { away: { r: 8, b: 1, e: 2, h: 10 }, home: { r: 6, b: 0, e: 1, h: 12 } },
      inn: { away: [1, 1, 0, 3, 0, 0, 0, 2, 1], home: [2, 1, 0, 3, 0, 0, 0, 0, 0] },
    });
    const sb = await fetchScoreboard('20260822SSNC02026');
    check('전광판 파싱 — 이닝 배열', JSON.stringify(sb.away.innings) === '[1,1,0,3,0,0,0,2,1]');
    check('전광판 파싱 — R/H/E/B', sb.home.r === 6 && sb.home.h === 12 && sb.home.e === 1 && sb.home.b === 0);
    check('전광판 파싱 — 원정 R', sb.away.r === 8);
    check('etcRecords 없으면 홈런 빈 목록', Array.isArray(sb.hr) && sb.hr.length === 0, JSON.stringify(sb.hr));

    // 2026-08-25 NC@LG 10회말 실제 응답(오스틴 8회 3점 홈런). etcRecords 에는
    // 결승타·실책·도루도 섞여 있어서 how 로 거르고 result 는 그대로 쓴다.
    globalThis.fetch = async () => fakeRecordResponse(
      { rheb: { away: { r: 4, b: 6, e: 0, h: 10 }, home: { r: 5, b: 5, e: 1, h: 11 } },
        inn: { away: [0], home: [0] } },
      [
        { result: '홍창기(10회 2사 만루서 우중간 안타)', how: '결승타' },
        { result: '오스틴33호(8회3점 손주환)', how: '홈런' },
        { result: '오지환(3회)', how: '실책' },
      ],
    );
    const withHr = await fetchScoreboard('20260825NCLG02026');
    check('etcRecords 에서 홈런만 원문 그대로', JSON.stringify(withHr.hr) === '["오스틴33호(8회3점 손주환)"]', JSON.stringify(withHr.hr));

    // 경기 전에는 recordData 가 null(정상).
    globalThis.fetch = async () => fakeRecordResponse(null);
    check('경기 전 → null', (await fetchScoreboard('20260825NCLG02026')) === null);

    // HTTP 오류나 이상한 응답도 예외 없이 null(전광판 때문에 폴링이 실패하면 안 됨).
    globalThis.fetch = async () => ({ ok: false, json: async () => ({}) });
    check('HTTP 오류 → null', (await fetchScoreboard('x')) === null);

    globalThis.fetch = async () => { throw new Error('network down'); };
    check('네트워크 예외 → null (throw 안 함)', (await fetchScoreboard('x')) === null);

    globalThis.fetch = async () => ({ ok: true, json: async () => ({ success: true, result: {} }) });
    check('스키마가 달라져도 null', (await fetchScoreboard('x')) === null);
  } finally {
    globalThis.fetch = originalFetch;
  }

  // 이닝 합 검증. record API 가 schedule API 보다 늦어서 합이 안 맞는 경우 대비.
  check('이닝 합이 총점과 일치', inningSumMatches([1, 0, 2, 0], 3));
  check('이닝 합이 총점과 불일치(record API 지연)', !inningSumMatches([1, 0, 1, 0], 3));
  check('빈 배열은 불일치', !inningSumMatches([], 0));
  check('배열이 아니면 불일치', !inningSumMatches(undefined, 0));

  // index.js 가 전광판을 다시 부를지 정하는 기준. 한쪽만 안 맞아도 못 쓴다.
  const sb2 = (home, away) => ({ home: { innings: home }, away: { innings: away } });
  const sc = (h, a) => ({ homeScore: h, awayScore: a });

  check('양쪽 합이 다 맞으면 쓸 수 있다',
    boardCoversScore(sb2([1, 0, 2], [0, 1, 0]), sc(3, 1)));
  check('홈만 어긋나도 못 쓴다',
    !boardCoversScore(sb2([1, 0, 0], [0, 1, 0]), sc(3, 1)));
  check('원정만 어긋나도 못 쓴다',
    !boardCoversScore(sb2([1, 0, 2], [0, 0, 0]), sc(3, 1)));
  check('전광판을 아예 못 받았으면 못 쓴다 (null 에 접근해 터지지 않는다)',
    !boardCoversScore(null, sc(3, 1)));
  check('한쪽 배열이 통째로 없어도 터지지 않는다',
    !boardCoversScore({ home: {}, away: {} }, sc(0, 0)));
}

/* ══ 11-b. 문자중계 종료 감지 ══ */

/**
 * 2026-08-29 NC-한화 relay 응답에서 판정에 필요한 부분만 남긴 것.
 * 종료 블록은 type 99 + "=====" 구분선이고 투구·타격은 다른 type 이다.
 */
function fakeRelayResponse({ ended, homeScore = 4, awayScore = 11 }) {
  const playing = [
    { textOptions: [{ type: 8, text: '9번타자 박정현' }, { type: 1, text: '1구 스트라이크' }] },
    { textOptions: [{ type: 13, text: '박정현 : 삼진 아웃' }] },
  ];
  const finish = {
    textOptions: [
      { type: 99, text: '=====================================' },
      { type: 99, text: '승리투수: 라일리' },
    ],
  };
  return {
    ok: true,
    json: async () => ({
      result: {
        textRelayData: {
          currentGameState: { homeScore: String(homeScore), awayScore: String(awayScore), out: '3' },
          textRelays: ended ? [finish, ...playing] : playing,
        },
      },
    }),
  };
}

async function testRelayFinish() {
  check('회차 추출', inningOf('9회말') === 9 && inningOf('10회초') === 10);
  check('회차를 못 읽으면 0 (문자중계를 안 보는 쪽이 안전)',
    inningOf('경기전') === 0 && inningOf(null) === 0 && inningOf(undefined) === 0);

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => fakeRelayResponse({ ended: true });
    const done = await fetchRelayFinish('20260829NCHH02026');
    check('종료 블록(type 99 + 구분선)을 잡아낸다',
      done?.homeScore === 4 && done?.awayScore === 11, JSON.stringify(done));

    globalThis.fetch = async () => fakeRelayResponse({ ended: false });
    check('진행 중이면 null', (await fetchRelayFinish('x')) === null);

    // 문자열만이 아니라 type 도 보는지. 타격 결과에 "====" 가 있어도 종료가 아니다.
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        result: {
          textRelayData: {
            currentGameState: { homeScore: '1', awayScore: '0' },
            textRelays: [{ textOptions: [{ type: 13, text: '=====' }] }],
          },
        },
      }),
    });
    check('type 이 99 가 아니면 종료 아님', (await fetchRelayFinish('x')) === null);

    globalThis.fetch = async () => ({ ok: false, status: 500 });
    check('HTTP 오류 → null', (await fetchRelayFinish('x')) === null);

    globalThis.fetch = async () => { throw new Error('network down'); };
    check('네트워크 예외 → null (throw 안 함)', (await fetchRelayFinish('x')) === null);

    globalThis.fetch = async () => ({ ok: true, json: async () => ({ result: {} }) });
    check('스키마가 달라져도 null', (await fetchRelayFinish('x')) === null);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

/* ══ 12. 서비스 워커 진동 설정 ══ */

/**
 * public/sw.js 파일을 그대로 실행해서 검증한다. self·indexedDB 같은 서비스 워커
 * 전역만 흉내 낸다(로직을 여기 복사하면 실제 코드와 달라질 수 있어서).
 *
 * @param {'ok'|'blocked'|'error'} idbMode IndexedDB open 이 어떻게 끝나는지
 */
function loadServiceWorker(store, idbMode = 'ok', onClose = () => {}, fetchMode = 'ok') {
  const fakeIdb = {
    open() {
      const req = { result: { objectStoreNames: { contains: () => true } } };
      req.result.close = onClose;
      req.result.transaction = () => ({
        objectStore: () => ({
          get: () => {
            const getReq = {};
            queueMicrotask(() => { getReq.result = store.get('vibrate'); getReq.onsuccess?.(); });
            return getReq;
          },
        }),
      });
      queueMicrotask(() => {
        if (idbMode === 'blocked') req.onblocked?.();
        else if (idbMode === 'error') req.onerror?.();
        else req.onsuccess?.();
      });
      return req;
    },
  };

  const listeners = {};
  const notifications = [];
  const acks = []; // sw.js 가 /api/delivered 로 보낸 body 들
  const sandbox = {
    self: {
      addEventListener: (type, fn) => { listeners[type] = fn; },
      registration: {
        // 같은 tag 면 덮어쓴다(실제 동작과 같게).
        showNotification: (title, opts) => {
          const at = notifications.findIndex((n) => n.opts.tag === opts.tag);
          const entry = { title, opts };
          if (at >= 0) notifications[at] = entry;
          else notifications.push(entry);
          return Promise.resolve();
        },
        // 실제 getNotifications 처럼 n.data·n.timestamp 가 속성으로 있어야 한다.
        // ({opts} 형태로 주면 sw.js 검사가 항상 통과해 버린다)
        getNotifications: async ({ tag }) => notifications
          .filter((n) => n.opts.tag === tag)
          .map((n) => ({ ...n.opts, title: n.title })),
        pushManager: { getSubscription: async () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/TEST' }) },
      },
      clients: { matchAll: async () => [] },
    },
    indexedDB: fakeIdb,
    fetch: async (url, init) => {
      if (fetchMode === 'fail') throw new Error('offline');
      acks.push({ url, body: JSON.parse(init.body) });
      return { ok: true };
    },
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'), sandbox);

  const push = async (payload) => {
    let waited;
    listeners.push({ data: { json: () => payload }, waitUntil: (p) => { waited = p; } });
    await waited;
  };
  return { push, notifications, acks };
}

async function testServiceWorkerVibrate() {
  const PATTERN = {
    start: [200], cancel: [200, 100, 200], score: [120, 80, 120], end: [200, 100, 200, 100, 200],
  };
  const store = new Map();

  for (const kind of ['start', 'cancel', 'score', 'end']) {
    for (const on of [true, false]) {
      store.set('vibrate', { start: true, cancel: true, score: true, end: true, [kind]: on });
      const { push, notifications } = loadServiceWorker(store);
      await push({ kind, title: 't', body: 'b', ts: Date.now() });

      const want = on ? PATTERN[kind] : [];
      check(`${kind} 진동 ${on ? 'ON' : 'OFF'}`,
        JSON.stringify(notifications[0]?.opts.vibrate) === JSON.stringify(want),
        JSON.stringify(notifications[0]?.opts.vibrate));
    }
  }

  // 설정을 못 읽어도 알림은 떠야 한다.
  store.clear();
  {
    const { push, notifications } = loadServiceWorker(store);
    await push({ kind: 'score', title: 't', body: 'b', ts: Date.now() });
    check('설정 없음(첫 실행) → 기본값은 켬',
      JSON.stringify(notifications[0]?.opts.vibrate) === JSON.stringify(PATTERN.score));
  }
  {
    // onblocked 를 처리 안 하면 Promise 가 안 끝나서 알림이 안 뜬다.
    const { push, notifications } = loadServiceWorker(store, 'blocked');
    const raced = await Promise.race([
      push({ kind: 'score', title: 't', body: 'b', ts: Date.now() }).then(() => 'DONE'),
      new Promise((r) => setTimeout(() => r('TIMEOUT'), 500)),
    ]);
    check('IDB upgrade 대기(onblocked) 여도 알림은 뜬다',
      raced === 'DONE' && notifications.length === 1, `${raced}, ${notifications.length}건`);
  }
  {
    const { push, notifications } = loadServiceWorker(store, 'error');
    await push({ kind: 'end', title: 't', body: 'b', ts: Date.now() });
    check('IDB 열기 실패여도 알림은 뜬다', notifications.length === 1);
  }

  // 연결을 안 닫으면 나중에 DB 버전을 올릴 때 막힌다.
  store.set('vibrate', { score: true });
  let closes = 0;
  const { push } = loadServiceWorker(store, 'ok', () => { closes++; });
  await push({ kind: 'score', title: 't', body: 'b', ts: Date.now() });
  check('푸시 처리 후 IDB 연결을 닫는다', closes === 1, `close() ${closes}회`);

  // tag 는 경기 단위. 한 경기 알림은 알림함에 하나만 남는다.
  const tagOf = async (payload) => {
    const { push, notifications } = loadServiceWorker(store);
    await push({ title: 't', body: 'b', ts: Date.now(), ...payload });
    return notifications[0]?.opts.tag;
  };

  // 경기가 다르면 tag 도 달라야 한다. 2026-08-30 에 종류로만 tag 를 만들어서
  // 어제 경기 종료 알림을 덮어쓴 적이 있다.
  const endA = await tagOf({ kind: 'end', gameId: '20260829NCHH02026' });
  const endB = await tagOf({ kind: 'end', gameId: '20260830NCHH02026' });
  check('경기가 다르면 tag 도 다르다', endA !== endB, `${endA} vs ${endB}`);

  const startB = await tagOf({ kind: 'start', gameId: '20260830NCHH02026' });
  check('같은 경기면 종류가 달라도 같은 tag (최신 하나만 남긴다)', endB === startB, `${endB} vs ${startB}`);

  // 득점이 여러 번 나도 알림함에는 가장 최근 것 하나만.
  {
    const { push, notifications } = loadServiceWorker(store);
    const game = '20260830NCHH02026';
    await push({ kind: 'start', gameId: game, id: 1, title: '경기 시작', body: '', ts: 1000 });
    await push({ kind: 'score', gameId: game, id: 2, title: '1회 득점', body: '1:0', ts: 2000 });
    await push({ kind: 'score', gameId: game, id: 3, title: '3회 득점', body: '2:0', ts: 3000 });
    await push({ kind: 'score', gameId: game, id: 4, title: '5회 득점', body: '3:0', ts: 4000 });
    check('한 경기에 알림이 넷 와도 알림함에는 하나만 남는다',
      notifications.length === 1, `${notifications.length}건`);
    check('남는 것은 가장 최근 알림이다',
      notifications[0]?.title === '5회 득점', notifications[0]?.title);
  }

  // 밀린 푸시가 순서 없이 와도 예전 알림이 최신 알림을 덮으면 안 된다.
  {
    const { push, notifications } = loadServiceWorker(store);
    const game = '20260830NCHH02026';
    await push({ kind: 'score', gameId: game, id: 9, title: '5회 득점', body: '3:0', ts: 4000 });
    await push({ kind: 'score', gameId: game, id: 8, title: '3회 득점', body: '2:0', ts: 3000 });
    check('늦게 도착한 옛 알림이 최신 알림을 덮지 않는다',
      notifications.length === 1 && notifications[0]?.title === '5회 득점',
      `${notifications.length}건 / ${notifications[0]?.title}`);
  }

  // 같은 tag 라고 건너뛰면 새 득점이 안 뜬다. 같은 이벤트(id)일 때만 건너뛴다.
  {
    const { push, notifications, acks } = loadServiceWorker(store);
    const game = '20260830NCHH02026';
    await push({ kind: 'score', gameId: game, id: 66, title: '1회 득점', body: '', ts: 1000 });
    await push({ kind: 'score', gameId: game, id: 66, title: '1회 득점', body: '', ts: 2000, resend: true });
    check('같은 이벤트를 다시 보내도 다시 울리지 않는다',
      notifications.length === 1 && notifications[0]?.title === '1회 득점');
    check('그때도 배달 확인은 다시 올린다', acks.map((a) => a.body.id).join(',') === '66,66',
      acks.map((a) => a.body.id).join(','));

    await push({ kind: 'score', gameId: game, id: 67, title: '3회 득점', body: '', ts: 3000 });
    check('다른 이벤트는 같은 tag 라도 최신으로 갱신된다',
      notifications.length === 1 && notifications[0]?.title === '3회 득점',
      `${notifications.length}건 / ${notifications[0]?.title}`);
  }

  // gameId 가 없는 payload(테스트 알림)도 경기 알림을 덮으면 안 된다.
  const t1 = await tagOf({ kind: 'test', ts: 1 });
  check('gameId 없는 알림은 종류로 묶인다', t1 === 'nc-test', t1);
  check('그 tag 는 경기 알림과 겹치지 않는다', t1 !== endB, `${t1} vs ${endB}`);

  // ── 배달 확인: 알림을 띄운 뒤 서버에 id 를 보낸다 ──
  {
    const { push, acks } = loadServiceWorker(store);
    await push({ kind: 'score', id: 66, title: 't', body: 'b', ts: 1 });
    check('띄운 뒤 /api/delivered 에 id 와 endpoint 를 보낸다',
      acks.length === 1 && acks[0].url === '/api/delivered'
        && acks[0].body.id === 66 && acks[0].body.endpoint.endsWith('/TEST'),
      JSON.stringify(acks));
  }
  {
    const { push, acks, notifications } = loadServiceWorker(store);
    await push({ kind: 'test', title: 't', body: 'b', ts: 1 });
    check('id 없는 payload(테스트 알림)는 배달 확인을 안 보낸다',
      acks.length === 0 && notifications.length === 1);
  }
  {
    // 배달 확인 요청이 실패해도 예외가 밖으로 나오면 안 된다(waitUntil 실패 방지).
    const { push, notifications } = loadServiceWorker(store, 'ok', () => {}, 'fail');
    const outcome = await push({ kind: 'end', id: 69, title: 't', body: 'b', ts: 1 })
      .then(() => 'RESOLVED', () => 'REJECTED');
    check('배달 확인 실패가 알림을 막지 않는다', outcome === 'RESOLVED' && notifications.length === 1,
      `${outcome}, ${notifications.length}건`);
  }

  /*
   * ── 재발송 ──
   * 서버 쪽 "확인이 안 왔다"는 틀릴 수 있다(2026-09-02, 떴는데 확인만 실패).
   * 다시 띄울지는 기기가 알림함을 보고 정한다.
   */
  {
    const { push, notifications, acks } = loadServiceWorker(store);
    await push({ kind: 'score', id: 75, title: 't', body: 'b', ts: 1 });
    check('재발송 전: 알림 1건', notifications.length === 1);

    await push({ kind: 'score', id: 75, title: 't', body: 'b', ts: 2, resend: true });
    check('이미 떠 있으면 재발송으로 다시 울리지 않는다', notifications.length === 1,
      `${notifications.length}건`);
    check('대신 배달 확인을 다시 올린다 (서버가 그만 보내도록)',
      acks.filter((a) => a.body.id === 75).length === 2,
      JSON.stringify(acks.map((a) => a.body.id)));
  }
  {
    // 알림함에 없으면(못 받았거나 지웠거나) 재발송은 뜬다.
    const { push, notifications } = loadServiceWorker(store);
    await push({ kind: 'end', id: 76, title: 't', body: 'b', ts: 1, resend: true });
    check('알림함에 없으면 재발송은 정상적으로 뜬다', notifications.length === 1,
      `${notifications.length}건`);

    // 시각은 payload 의 ts 그대로(2026-09-17: 감지 19:28 인데 알림함에 7:33 으로 찍혔음).
    const detectedAt = Date.parse('2026-09-17T10:28:34.334Z');
    await push({ kind: 'score', id: 77, title: 't', body: 'b', ts: detectedAt, resend: true });
    check('재발송 알림은 서버가 준 감지 시각으로 찍힌다',
      notifications.at(-1).opts.timestamp === detectedAt,
      String(notifications.at(-1).opts.timestamp));
  }
  {
    // 같은 tag 에 다른 이벤트가 떠 있으면 새 이벤트로 바뀌어야 한다.
    const { push, notifications } = loadServiceWorker(store);
    await push({ kind: 'score', id: 80, title: '먼저', body: 'b', ts: 1 });
    await push({ kind: 'score', id: 81, title: '나중', body: 'b', ts: 2, resend: true });
    check('다른 이벤트가 떠 있어도 이 이벤트로 갱신된다',
      notifications.length === 1 && notifications[0]?.title === '나중',
      `${notifications.length}건 / ${notifications[0]?.title}`);
  }
  {
    // 원본 푸시가 재발송보다 늦게 오는 경우도 다시 울리면 안 된다(renotify: true 라서).
    const { push, notifications, acks } = loadServiceWorker(store);
    await push({ kind: 'score', id: 90, title: 't', body: 'b', ts: 1, resend: true });
    await push({ kind: 'score', id: 90, title: 't', body: 'b', ts: 1 });
    check('재발송이 먼저 뜬 뒤 원래 푸시가 와도 다시 울리지 않는다',
      notifications.length === 1, `${notifications.length}건`);
    check('그때도 배달 확인은 올린다', acks.filter((a) => a.body.id === 90).length === 2,
      JSON.stringify(acks.map((a) => a.body.id)));
  }
}

/* ══ 6-c. 배달 확인(events.delivered_at) ══ */

/**
 * INSERT/UPDATE 결과(meta.changes, last_row_id)만 흉내 내는 D1.
 * 실행한 SQL·인자를 남겨서 조건절도 확인한다.
 */
function fakeWriteDb(meta) {
  const calls = [];
  return {
    calls,
    prepare: (sql) => ({
      bind(...args) { calls.push({ sql, args }); return this; },
      async run() { return { meta }; },
    }),
  };
}

async function testDelivered() {
  const game = { gameId: 'G', gameDate: '2026-09-01', homeScore: 3, awayScore: 1 };
  const ev = { kind: 'score', series: 'regular', dedupKey: 'G:score:3-1', title: 't', body: 'b' };

  // 새 행 id 를 돌려줘야 payload 에 넣을 수 있다.
  const inserted = fakeWriteDb({ changes: 1, last_row_id: 66 });
  check('insertEvent 는 새 행의 id 를 돌려준다', (await insertEvent(inserted, game, ev)) === 66);

  // OR IGNORE 로 건너뛰었으면 last_row_id 에 이전 값이 있어도 null 이어야 한다
  // (아니면 중복 발송).
  const ignored = fakeWriteDb({ changes: 0, last_row_id: 66 });
  check('dedup 충돌이면 stale last_row_id 를 무시하고 null', (await insertEvent(ignored, game, ev)) === null);

  const marked = fakeWriteDb({ changes: 1 });
  check('markDelivered 는 채웠으면 true', await markDelivered(marked, 66));
  check('delivered_at 이 비어 있을 때만 채운다 (첫 응답만 남김)',
    /WHERE id = \? AND delivered_at IS NULL/.test(marked.calls[0].sql) && marked.calls[0].args[1] === 66,
    marked.calls[0].sql);

  const already = fakeWriteDb({ changes: 0 });
  check('이미 채워져 있거나 없는 id 면 false', !(await markDelivered(already, 66)));

  // ── 재발송 대상 고르기 ──
  const picked = {
    prepare: (sql) => ({
      _sql: sql,
      bind(...args) { this._args = args; return this; },
      async all() {
        return { results: [
          { id: 75, kind: 'concede', series: 'regular', title: 't', body: 'b',
            game_id: '20260902HTNC02026', home_code: 'NC',
            created_at: '2026-09-17T10:28:34.334Z' },
        ] };
      },
    }),
  };
  const rows = await listUndelivered(picked, 'NC', { olderThan: 'B', newerThan: 'A' });
  check('재발송 대상은 홈/원정까지 풀어서 준다',
    rows[0].id === 75 && rows[0].isHome === true && rows[0].gameId === '20260902HTNC02026',
    JSON.stringify(rows[0]));

  // concede 가 score 로 안 바뀌면 실점만 재발송이 안 된다.
  check('재발송 대상은 발송 모양(kind·scope)으로 준다',
    rows[0].kind === 'score' && rows[0].scope === 'regular', JSON.stringify(rows[0]));

  const away = await listUndelivered(picked, 'LG', { olderThan: 'B', newerThan: 'A' });
  check('우리 팀이 홈이 아니면 isHome=false', away[0].isHome === false);

  // 재발송 알림에는 원래 감지 시각이 찍혀야 한다(sw.js timestamp).
  check('재발송 대상은 원래 감지 시각을 함께 준다',
    rows[0].createdAt === '2026-09-17T10:28:34.334Z', rows[0].createdAt);

  // 조건절 확인. resent_at 이 빠지면 매 틱 다시 보내고, 시간 조건이 빠지면
  // 방금 보낸 알림까지 다시 보낸다.
  let q = '';
  await listUndelivered(
    { prepare: (sql) => { q = sql; return { bind() { return this; }, async all() { return { results: [] }; } }; } },
    'NC',
    { olderThan: 'B', newerThan: 'A' },
  );
  check('배달 확인이 없는 것만', /delivered_at IS NULL/.test(q));
  check('아직 재발송 안 한 것만', /resent_at IS NULL/.test(q));
  check('창 밖은 제외', /created_at <= \?/.test(q) && /created_at >= \?/.test(q), q.replace(/\s+/g, ' '));

  // SELECT 에 created_at 이 없으면 재발송 시각이 찍힌다. WHERE 에도 있어서
  // SELECT~FROM 사이만 본다.
  const selectList = /SELECT([^]*?)FROM/.exec(q)?.[1] ?? '';
  check('원래 감지 시각을 SELECT 목록에 넣는다',
    /e\.created_at/.test(selectList), selectList.replace(/\s+/g, ' ').trim());

  const resentDb = fakeWriteDb({ changes: 1 });
  await markResent(resentDb, 75);
  check('markResent 는 그 행만 표시한다',
    /UPDATE events SET resent_at = \? WHERE id = \?/.test(resentDb.calls[0].sql)
      && resentDb.calls[0].args[1] === 75,
    resentDb.calls[0].sql);

  // dispatchKindOf: 기록용 concede → 발송용 score.
  check('재발송 때 concede 는 score 로 되돌린다', dispatchKindOf('concede') === 'score');
  check('나머지 종류는 그대로', dispatchKindOf('end') === 'end' && dispatchKindOf('start') === 'start');
}

/**
 * 실제 스키마(schema.sql)를 올린 메모리 SQLite 를 D1 모양으로 감싼다.
 * calls 에 실행한 SQL 이 쌓이고, insert(table, row) 로 행을 미리 넣을 수 있다.
 */
function sqliteD1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const calls = [];
  const db = {
    prepare(sql) {
      calls.push(sql);
      const st = sqlite.prepare(sql);
      let args = [];
      const api = {
        bind: (...a) => { args = a; return api; },
        all: async () => ({ results: st.all(...args) }),
        first: async () => st.get(...args) ?? null,
        run: async () => {
          const r = st.run(...args);
          return { meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } };
        },
      };
      return api;
    },
    async batch(stmts) {
      const out = [];
      for (const s of stmts) out.push(await s.run());
      return out;
    },
  };
  const insert = (table, row) => {
    const cols = Object.keys(row);
    sqlite.prepare(`INSERT INTO ${table} (${cols}) VALUES (${cols.map(() => '?')})`).run(...Object.values(row));
  };
  return { sqlite, db, calls, insert };
}

/** cache 행을 미리 넣은 D1. rows: { key: { value, expires_at } } */
function cacheDb(rows = {}) {
  const d = sqliteD1();
  for (const [key, r] of Object.entries(rows)) d.insert('cache', { key, ...r, updated_at: r.expires_at });
  return d.db;
}

/* ══ 실행 ══ */

console.log('\n[1] 푸시 페이로드 암복호화');  await testEncryption();
console.log('\n[2] VAPID JWT');              await testVapid();
console.log('\n[2-b] 재발송 묶음(Topic)');  await testTopic();
console.log('\n[3] 시리즈 판별');            testSeries();
console.log('\n[3b] 이번 시즌 필터');        testSeasonFilter();
console.log('\n[4] 상태 전이 감지');         testDetect();
console.log('\n[5] 포스트시즌 진출 판정');   testOutlook();
console.log('\n[5-b] 상대 전적');            testHeadToHead();
console.log('\n[6] 시즌·시간대 게이팅');     testWindow();
console.log('\n[6-b] 종료 후 감시 종료');     await testSettled();
console.log('\n[6-c] 배달 확인');            await testDelivered();
console.log('\n[7] 보안 검증');              testSecurity();
console.log('\n[7-b] 본문 크기 상한(바이트)'); await testReadJsonByteLimit();
console.log('\n[7-c] 구독 상한 vs subrequest 예산'); testSubrequestBudget();
console.log('\n[7-d] 상한 도달 시 알림 수신'); await testSubscriptionEviction();
console.log('\n[8] 홈경기 전용 알림 필터');  await testHomeOnly();
console.log('\n[8-b] 알림 설정 읽기·쓰기');  await testSettings();
console.log('\n[9] 전광판 조회');            await testScoreboard();
console.log('\n[10] 조회 장애 시 만료 캐시 폴백'); await testScheduleResilience();
console.log('\n[10-b] 개막일 미확정 캐시');    await testOpenerCaching();
console.log('\n[11] 날짜별 캐시 청소');       await testCachePrune();
console.log('\n[11-b] 문자중계 종료 감지');   await testRelayFinish();
console.log('\n[12] 서비스 워커 진동 설정');  await testServiceWorkerVibrate();

console.log(failed === 0 ? '\n전부 통과.\n' : `\n실패 ${failed}건.\n`);
process.exit(failed === 0 ? 0 : 1);

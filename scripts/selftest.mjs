/**
 * 자체 검증. 네트워크 없이 돌아간다.
 *
 *   node scripts/selftest.mjs
 *
 * 푸시 암호화(RFC 8291)는 실제 브라우저 없이는 확인이 어려우므로,
 * 여기서 브라우저 역할(수신자 키쌍 보유)을 직접 맡아 복호화까지 해 본다.
 * 복호문이 원문과 일치하면 구현이 맞다는 뜻이다.
 */

import fs from 'node:fs';
import vm from 'node:vm';
import { encryptPayload, makeVapidHeader, b64urlToBytes, bytesToB64url } from '../src/push.js';
import { detectEvents } from '../src/detect.js';
import { normalizeGame, perspective, seriesOf, isPostseason, postseasonOutlook, kstIsoToEpoch,
         seasonYearOf, filterCurrentSeason, fetchScoreboard } from '../src/kbo.js';
import { isPollWindow, pollWindowGames, loadSchedule, loadStandings } from '../src/season.js';
import { validateEndpoint, validateKeys, checkOrigin } from '../src/security.js';
import { subscribersFor, getCache, pruneDatedCache, allSettledBefore } from '../src/db.js';

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

  // 같은 평문이라도 매번 다른 암호문이어야 한다 (salt·임시키가 매번 새로 생성되므로).
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

  // ── 설정 실수를 발송 전에 잡아내는지 ──
  // 실제로 겪은 사고: 공개키와 개인키가 서로 다른 genkeys 실행에서 나와
  // "DataError: Invalid EC key in JSON Web Key" 로만 터져 원인 파악이 어려웠다.
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

  // 앞뒤 공백·따옴표가 붙어도 정상 동작해야 한다 (콘솔 붙여넣기 사고 방지)
  const padded = await makeVapidHeader(endpoint, ` "${publicKey}" `, `\n ${jwk.d} \n`, 'mailto:t@e.com');
  check('공백·따옴표가 붙어도 통과', padded.startsWith('vapid t='));
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

  // 시범경기: 형식은 정규시즌과 같고 개막일 이전이라는 점만 다르다
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

  // 접두사만 바뀌어도 팀 코드로 한 번 더 걸린다 (이중 방어)
  const oddAllstar = mk({ gameId: '12340711WEEA02026', homeTeamCode: 'EA', awayTeamCode: 'WE' });
  check('올스타 접두사가 바뀌어도 팀 코드로 제외', keep([oddAllstar]).length === 0);

  const lastSeason = mk({ gameId: '20251026HHLG02025', gameDate: '2025-10-26' });
  check('지난 시즌 제외', keep([lastSeason]).length === 0);

  const lastPost = mk({ gameId: '77771026HHLG02025', gameDate: '2025-10-26' });
  check('지난 시즌 포스트시즌도 제외', keep([lastPost]).length === 0);

  const thisPost = mk({ gameId: '77771026NCLG02026', gameDate: '2026-10-26' });
  check('올해 포스트시즌은 통과', keep([thisPost]).length === 1);

  // 개막일을 못 구했으면 시범경기 판별을 포기한다 (빠뜨리는 것보다 낫다)
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

  // app.js 의 tlKind() 가 이 '실점' 문구로 타임라인 아이콘·라벨을 고른다.
  // 문구를 바꾸면 여기와 app.js 를 같이 고쳐야 한다.
  const conceded = detectEvents(live(1, 0), live(1, 2), T)[0];
  check('실점 문구', conceded?.title === '삼성 2점 실점', conceded?.title);

  // 푸시 알림 제목만 "득점"으로 나간다. title(기록 탭·DB)은 위처럼 그대로여야
  // 하고, 둘이 실제로 달라야 이 분리가 의미가 있다.
  check('상대 득점 알림 문구', conceded?.pushTitle === '삼성 2점 득점', conceded?.pushTitle);
  check('알림 문구와 기록 문구가 갈린다', conceded?.pushTitle !== conceded?.title);

  // 우리 팀 득점·양 팀 득점은 둘을 나눌 이유가 없으므로 같아야 한다.
  const ourRun = detectEvents(live(1, 0), live(3, 0), T)[0];
  check('우리 득점은 알림·기록 문구가 같다',
    ourRun?.pushTitle === ourRun?.title && ourRun?.pushTitle === 'NC 2점 득점!', ourRun?.pushTitle);

  const bothScored = detectEvents(live(1, 1), live(2, 2), T)[0];
  check('양 팀 득점은 알림·기록 문구가 같다',
    bothScored?.pushTitle === bothScored?.title && bothScored?.pushTitle === '양 팀 득점',
    bothScored?.pushTitle);

  // 득점 외 이벤트는 pushTitle 을 따로 주지 않으므로 title 과 같아야 한다.
  const startEv = detectEvents(g(), g({ statusCode: 'STARTED', statusInfo: '1회초' }), T)[0];
  check('시작 알림은 pushTitle 이 title 과 같다', startEv?.pushTitle === startEv?.title);

  // ── 득점 이닝 — 전광판이 총점과 맞아떨어질 때만 말한다 ──
  // (statusInfo 는 폴링 순간의 이닝이라 쓰지 않는다. detect.js scoringInning 참고)
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

  // ENDED — RESULT 확정 전 최대 10여 분 거치는 상태(실측, poll_log). 이걸
  // 놓치면 그 10분 동안 종료 알림이 밀린다. RESULT 와 동일하게 취급해야 한다.
  const endedStatus = detectEvents(live(5, 3), g({ statusCode: 'ENDED', homeTeamScore: 5, awayTeamScore: 3 }), T);
  check('ENDED 도 종료로 감지', kinds(endedStatus) === 'end', kinds(endedStatus));
  check('ENDED → RESULT 전이는 중복 아님(같은 스냅샷이면 재알림 없음)',
    detectEvents(
      g({ statusCode: 'ENDED', homeTeamScore: 5, awayTeamScore: 3 }),
      g({ statusCode: 'RESULT', homeTeamScore: 5, awayTeamScore: 3 }),
      T,
    ).length === 0);

  // READY — BEFORE 와 STARTED 사이에 최대 53분 거치는 상태(실측, poll_log).
  // statusInfo 가 "경기전"이고 점수도 0:0 으로 고정돼 있었다. live 로 처리하면
  // 실제 플레이볼보다 최대 53분 이른 "경기 시작" 알림이 나간다.
  const beforeToReady = detectEvents(g(), g({ statusCode: 'READY' }), T);
  check('READY 는 아직 경기 전 — 시작 알림 없음', beforeToReady.length === 0, kinds(beforeToReady));

  const readyToStarted = detectEvents(
    g({ statusCode: 'READY' }),
    g({ statusCode: 'STARTED', statusInfo: '1회초' }),
    T,
  );
  check('READY → STARTED 전이에서 시작 알림', kinds(readyToStarted) === 'start', kinds(readyToStarted));

  // 원정 경기: 대상 팀이 away 여도 관점이 뒤집히지 않아야 한다.
  const away = (h, a) => g({
    homeTeamCode: 'SS', homeTeamName: '삼성', awayTeamCode: 'NC', awayTeamName: 'NC',
    statusCode: 'STARTED', homeTeamScore: h, awayTeamScore: a,
  });
  check('원정 경기 득점 판정', detectEvents(away(0, 0), away(0, 1), T)[0]?.title === 'NC 1점 득점!');
  const p = perspective(away(0, 1), T);
  check('원정 경기 관점', !p.isHome && p.oppName === '삼성' && p.teamScore === 1);

  // ── 홈/원정 표시 — "홈경기만 받기" 설정이 이 값으로 걸러진다 ──
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

  // ── 홈런 표시 — index.js 가 poll() 에서 game.hr 을 채워 넘기는 것을 흉내낸다.
  // hr 은 "오스틴33호(8회3점 손주환)" 같은 원문 문자열 목록이지 개수가 아니다.
  const withHr = (game, hr) => Object.assign(game, { hr });
  const HR1 = '오스틴33호(8회3점 손주환)';
  const HR2 = '박건우5호(3회1점 김진수)';

  const hrScored = detectEvents(withHr(live(1, 0), []), withHr(live(4, 0), [HR1]), T);
  check('새 홈런이 원문 그대로 붙음', hrScored[0]?.body.endsWith(` · ${HR1}`), hrScored[0]?.body);

  const noHrScored = detectEvents(withHr(live(1, 0), [HR1]), withHr(live(2, 0), [HR1]), T);
  check('목록이 그대로면(새 홈런 없음) 표시 없음', !noHrScored[0]?.body.includes(HR1), noHrScored[0]?.body);

  // 전광판 조회 실패로 hr 목록이 직전 값을 그대로 이어받은 경우 — 새 홈런이 아니다.
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
}

/* ══ 6. 시즌·시간대 게이팅 ══ */

function testWindow() {
  const start = kstIsoToEpoch('2026-08-22T18:30:00');
  check('KST 문자열 → epoch', start === Date.parse('2026-08-22T09:30:00Z'), String(start));

  const plan = { games: [{ gameId: 'G', startAt: '2026-08-22T18:30:00' }] };
  const MIN = 60000, HOUR = 3600000;

  check('경기 3시간 전 → 감시 안 함', !isPollWindow(plan, start - 3 * HOUR));
  check('경기 90분 전 → 감시 시작', isPollWindow(plan, start - 90 * MIN));
  check('경기 중 → 감시', isPollWindow(plan, start + 2 * HOUR));
  check('종료 후 7시간 → 감시', isPollWindow(plan, start + 7 * HOUR));
  check('종료 후 8시간 → 감시 안 함', !isPollWindow(plan, start + 8 * HOUR));
  check('경기 없는 날 → 감시 안 함', !isPollWindow({ games: [] }, start));
  check('시각을 못 읽으면 안전하게 감시', isPollWindow({ games: [{ startAt: 'broken' }] }, start));

  // 시간 창 안에 든 경기만 골라야 한다 — 감시 종료 판단의 대상이 되는 목록이다.
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

/** events 테이블만 지원하는 최소 D1 흉내. end/cancel 행을 세어 돌려준다. */
function fakeEventsDb(rows) {
  return {
    prepare: () => ({
      bind(...ids) {
        this.ids = ids;
        return this;
      },
      first: async function () {
        const hit = rows.filter((r) => this.ids.includes(r.game_id));
        return {
          done: new Set(hit.map((r) => r.game_id)).size,
          last_at: hit.length ? hit.map((r) => r.created_at).sort().at(-1) : null,
        };
      },
    }),
  };
}

async function testSettled() {
  const db = fakeEventsDb([
    { game_id: 'A', created_at: '2026-08-22T13:00:00.000Z' },
    { game_id: 'B', created_at: '2026-08-22T13:20:00.000Z' },
  ]);
  const late = '2026-08-22T14:00:00.000Z'; // 두 경기 모두 끝나고 40분 지난 시점
  const soon = '2026-08-22T13:10:00.000Z'; // B 가 아직 안 끝난 시점

  check('감시 대상이 없으면 멈춘다', await allSettledBefore(db, [], late));
  check('모두 끝나고 유예가 지나면 멈춘다', await allSettledBefore(db, ['A', 'B'], late));
  check('한 경기만 끝났으면 계속 본다', !(await allSettledBefore(db, ['A', 'B'], soon)));
  check('기록에 없는 경기가 섞이면 계속 본다', !(await allSettledBefore(db, ['A', 'C'], late)));
}

/**
 * cache 테이블만 지원하는 최소 D1 흉내.
 *
 * @param rows 미리 들어 있는 캐시 행. { 'schedule:2026': { value, expires_at } }
 *   value 는 문자열(JSON), expires_at 은 ISO 문자열이다. 비우면 캐시 미스가 되어
 *   실제 조회 경로를 타게 된다.
 */
function fakeCacheDb(rows = {}) {
  const deletes = []; // pruneDatedCache 가 무엇을 지우려 했는지 확인용
  return {
    deletes,
    prepare(sql) {
      return {
        _sql: sql,
        _args: [],
        bind(...args) { this._args = args; return this; },
        async first() { return rows[this._args[0]] ?? null; },
        async run() {
          if (this._sql.startsWith('DELETE')) deletes.push(this._args);
          return {};
        },
      };
    },
    async batch(stmts) {
      for (const s of stmts) await s.run();
      return [];
    },
  };
}

async function testScheduleResilience() {
  const originalFetch = globalThis.fetch;
  const expired = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  try {
    // 네이버 API가 완전히 죽어 fetch 자체가 예외를 던지는 상황을 흉내낸다.
    globalThis.fetch = async () => { throw new Error('naver down'); };

    // 남아 있는 캐시조차 없으면(첫 배포 직후 등) 빈 목록으로 물러난다.
    const games = await loadSchedule({ DB: fakeCacheDb(), TEAM_CODE: 'NC' }, 2026);
    check(
      '일정 조회 실패 + 캐시 없음 → 빈 목록',
      Array.isArray(games) && games.length === 0,
      JSON.stringify(games),
    );

    // 만료된 캐시가 남아 있으면 그것으로 되돌아간다 — 이번 변경의 핵심.
    const lastGood = [{ gameId: '20260822SSNC02026', gameDate: '2026-08-22', oppName: '삼성' }];
    const staleDb = fakeCacheDb({
      'schedule:2026': { value: JSON.stringify(lastGood), expires_at: expired },
    });
    const fallback = await loadSchedule({ DB: staleDb, TEAM_CODE: 'NC' }, 2026);
    check(
      '일정 조회 실패 + 만료 캐시 있음 → 마지막 정상값',
      JSON.stringify(fallback) === JSON.stringify(lastGood),
      JSON.stringify(fallback),
    );

    // 정상 조회에는 조회 시각이 붙는다 — 화면의 "○○ 기준" 표시가 이 값을 쓴다.
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        success: true,
        result: {
          seasonTeamStats: [{
            teamId: 'NC', teamName: 'NC', ranking: 8, gameCount: 107, winGameCount: 48,
            drawnGameCount: 2, loseGameCount: 57, wra: 0.457, gameBehind: 12.5,
          }],
        },
      }),
    });
    const before = Date.now();
    const fresh = await loadStandings({ DB: fakeCacheDb() }, 2026);
    const at = Date.parse(fresh?.fetchedAt ?? '');
    check('정상 조회한 순위에 fetchedAt 부착', at >= before && at <= Date.now(), fresh?.fetchedAt);

    globalThis.fetch = async () => { throw new Error('naver down'); };

    // 순위도 같은 방식으로 되돌아간다.
    const lastStandings = { year: 2026, teams: [{ code: 'NC', rank: 8 }] };
    const standDb = fakeCacheDb({
      'standings:2026': { value: JSON.stringify(lastStandings), expires_at: expired },
    });
    const standFallback = await loadStandings({ DB: standDb }, 2026);
    check(
      '순위 조회 실패 + 만료 캐시 있음 → 마지막 정상값',
      standFallback?.teams?.[0]?.rank === 8,
      JSON.stringify(standFallback),
    );

    // 만료된 값을 평상시 경로가 집어 오면 안 된다 — getCache 는 여전히 미스여야 한다.
    const plain = await getCache(
      fakeCacheDb({ 'schedule:2026': { value: '[1,2,3]', expires_at: expired } }),
      'schedule:2026',
    );
    check('만료된 캐시는 평상시 getCache 로는 안 읽힘', plain === null, JSON.stringify(plain));
  } finally {
    globalThis.fetch = originalFetch;
  }
}

/** 날짜별 캐시 청소가 지울 대상과 남길 대상을 올바르게 고르는지. */
async function testCachePrune() {
  const db = fakeCacheDb();
  await pruneDatedCache(db, '2026-08-19');

  const ranges = db.deletes.map((args) => args.join(' ~ '));
  check('plan: 범위로 지움', ranges.includes('plan: ~ plan:2026-08-19'), ranges.join(' / '));
  check('today: 범위로 지움', ranges.includes('today: ~ today:2026-08-19'), ranges.join(' / '));
  check('지우는 대상은 이 둘뿐', db.deletes.length === 2, String(db.deletes.length));

  /*
   * 범위 비교가 연도별 키를 건드리지 않는지 문자열로 직접 확인한다.
   * 키가 기본 키라 SQLite 도 같은 사전순 비교를 쓴다.
   */
  const inRange = (key, prefix) => key >= `${prefix}:` && key < `${prefix}:2026-08-19`;
  check('지난 plan 은 범위 안', inRange('plan:2026-08-01', 'plan'));
  check('오늘 plan 은 범위 밖', !inRange('plan:2026-08-25', 'plan'));
  check('schedule 은 범위 밖 (폴백 보존)', !inRange('schedule:2026', 'plan'));
  check('standings 는 범위 밖 (폴백 보존)', !inRange('standings:2026', 'plan'));
  check('opener 는 범위 밖 (폴백 보존)', !inRange('opener:2026', 'plan'));
  check('today 키는 plan 범위에 안 걸림', !inRange('today:2026-08-01', 'plan'));
}

/* ══ 7. 보안 검증 ══ */

function testSecurity() {
  // SSRF 방어: 서버가 이 URL 로 직접 POST 하므로 임의 호스트를 받으면 안 된다.
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

  // 접미사 검사가 도메인 경계를 지키는지 (evil-notify.windows.com.attacker.com 류)
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

/* ══ 8. 홈경기 전용 알림 필터 ══ */

/**
 * D1 을 흉내 내는 최소 스텁. 실행된 SQL 과 바인딩을 기록하고,
 * subscriptions 테이블을 자바스크립트에서 직접 필터링해 결과를 돌려준다.
 * 이렇게 하면 실제 DB 없이도 "어떤 구독이 대상이 되는가"를 검증할 수 있다.
 */
function fakeDb(rows) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      calls.push(sql);
      return {
        bind: () => this,
        all: async () => {
          // WHERE 절을 해석해 스텁 데이터에 적용한다.
          const needsKind = /on_(\w+) = 1/.exec(sql)?.[1];
          const needsScope = /on_(regular|postseason) = 1/.exec(sql)?.[1];
          const homeOnlyExcluded = sql.includes('home_only = 0');

          const results = rows.filter((r) => {
            if (needsKind && !r[`on_${needsKind}`]) return false;
            if (needsScope && !r[`on_${needsScope}`]) return false;
            if (homeOnlyExcluded && r.home_only) return false;
            return true;
          });
          return { results };
        },
      };
    },
  };
}

async function testHomeOnly() {
  const rows = [
    { endpoint: 'all', on_start: 1, on_regular: 1, on_postseason: 1, home_only: 0 },
    { endpoint: 'homeonly', on_start: 1, on_regular: 1, on_postseason: 1, home_only: 1 },
  ];

  const names = (r) => r.map((x) => x.endpoint).sort().join(',');

  const home = await subscribersFor(fakeDb(rows), 'start', 'regular', true);
  check('홈경기 → 전체 수신자 + 홈경기전용 모두', names(home) === 'all,homeonly', names(home));

  const awayGame = await subscribersFor(fakeDb(rows), 'start', 'regular', false);
  check('원정경기 → 홈경기전용은 제외', names(awayGame) === 'all', names(awayGame));

  // 원정 경기일 때만 home_only 조건이 SQL 에 붙어야 한다.
  const dbHome = fakeDb(rows);
  await subscribersFor(dbHome, 'start', 'regular', true);
  check('홈경기 쿼리에는 home_only 조건 없음', !dbHome.calls[0].includes('home_only'));

  const dbAway = fakeDb(rows);
  await subscribersFor(dbAway, 'start', 'regular', false);
  check('원정 쿼리에는 home_only = 0 조건 포함', dbAway.calls[0].includes('home_only = 0'));

  // 알 수 없는 종류·범위는 조회 자체를 하지 않는다.
  check('모르는 종류는 빈 배열', (await subscribersFor(fakeDb(rows), 'nope', 'regular', true)).length === 0);
  check('모르는 범위는 빈 배열', (await subscribersFor(fakeDb(rows), 'start', 'nope', true)).length === 0);
}

/* ══ 9. 전광판 조회 ══ */

/** 네이버 record 응답을 흉내 낸다. 실제 2026-08-22 SS@NC 경기 응답을 그대로 옮겨 왔다. */
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

    // 실제 2026-08-25 NC@LG 10회말 응답에서 그대로 옮겨 왔다(오스틴 8회 3점 홈런).
    // etcRecords 는 홈런 외에 결승타·실책·도루 같은 다른 기록도 섞여 온다 —
    // how 로만 걸러야 하고, result 는 재가공 없이 원문 그대로 뽑아야 한다.
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

    // 경기 전에는 recordData 자체가 null — 정상이며 오류가 아니다.
    globalThis.fetch = async () => fakeRecordResponse(null);
    check('경기 전 → null', (await fetchScoreboard('20260825NCLG02026')) === null);

    // HTTP 오류나 예상과 다른 응답 형태도 예외를 던지지 않고 null 로 흡수한다
    // (전광판은 부가 정보라 이것 때문에 폴링 전체가 실패하면 안 된다).
    globalThis.fetch = async () => ({ ok: false, json: async () => ({}) });
    check('HTTP 오류 → null', (await fetchScoreboard('x')) === null);

    globalThis.fetch = async () => { throw new Error('network down'); };
    check('네트워크 예외 → null (throw 안 함)', (await fetchScoreboard('x')) === null);

    globalThis.fetch = async () => ({ ok: true, json: async () => ({ success: true, result: {} }) });
    check('스키마가 달라져도 null', (await fetchScoreboard('x')) === null);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

/* ══ 12. 서비스 워커 진동 설정 ══ */

/**
 * public/sw.js 를 고치지 않고 그대로 실행해 검증한다. 서비스워커 전용
 * 전역(self·indexedDB)만 최소한으로 흉내 내므로, 여기서 통과하면 실제 배포되는
 * 코드가 통과한 것이다 — 로직을 여기에 다시 옮겨 적으면 그때부터 둘이 갈라진다.
 *
 * @param {'ok'|'blocked'|'error'} idbMode IndexedDB open 이 어떻게 끝나는지
 */
function loadServiceWorker(store, idbMode = 'ok', onClose = () => {}) {
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
  const sandbox = {
    self: {
      addEventListener: (type, fn) => { listeners[type] = fn; },
      registration: {
        showNotification: (title, opts) => { notifications.push({ title, opts }); return Promise.resolve(); },
      },
      clients: { matchAll: async () => [] },
    },
    indexedDB: fakeIdb,
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'), sandbox);

  const push = async (payload) => {
    let waited;
    listeners.push({ data: { json: () => payload }, waitUntil: (p) => { waited = p; } });
    await waited;
  };
  return { push, notifications };
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

  // 설정을 못 읽는 경우들 — 어느 쪽이든 알림 자체는 반드시 떠야 한다.
  store.clear();
  {
    const { push, notifications } = loadServiceWorker(store);
    await push({ kind: 'score', title: 't', body: 'b', ts: Date.now() });
    check('설정 없음(첫 실행) → 기본값은 켬',
      JSON.stringify(notifications[0]?.opts.vibrate) === JSON.stringify(PATTERN.score));
  }
  {
    // onblocked 갈래가 비어 있으면 Promise 가 영영 안 끝나 알림이 아예 안 뜬다.
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

  // 연결을 안 닫으면 나중에 스키마 버전을 올릴 때 upgrade 가 막힌다.
  store.set('vibrate', { score: true });
  let closes = 0;
  const { push } = loadServiceWorker(store, 'ok', () => { closes++; });
  await push({ kind: 'score', title: 't', body: 'b', ts: Date.now() });
  check('푸시 처리 후 IDB 연결을 닫는다', closes === 1, `close() ${closes}회`);
}

/* ══ 실행 ══ */

console.log('\n[1] 푸시 페이로드 암복호화');  await testEncryption();
console.log('\n[2] VAPID JWT');              await testVapid();
console.log('\n[3] 시리즈 판별');            testSeries();
console.log('\n[3b] 이번 시즌 필터');        testSeasonFilter();
console.log('\n[4] 상태 전이 감지');         testDetect();
console.log('\n[5] 포스트시즌 진출 판정');   testOutlook();
console.log('\n[6] 시즌·시간대 게이팅');     testWindow();
console.log('\n[6-b] 종료 후 감시 종료');     await testSettled();
console.log('\n[7] 보안 검증');              testSecurity();
console.log('\n[8] 홈경기 전용 알림 필터');  await testHomeOnly();
console.log('\n[9] 전광판 조회');            await testScoreboard();
console.log('\n[10] 조회 장애 시 만료 캐시 폴백'); await testScheduleResilience();
console.log('\n[11] 날짜별 캐시 청소');       await testCachePrune();
console.log('\n[12] 서비스 워커 진동 설정');  await testServiceWorkerVibrate();

console.log(failed === 0 ? '\n전부 통과.\n' : `\n실패 ${failed}건.\n`);
process.exit(failed === 0 ? 0 : 1);

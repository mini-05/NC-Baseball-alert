/**
 * 자체 검증. 네트워크 없이 돌아간다.
 *
 *   node scripts/selftest.mjs
 *
 * 푸시 암호화(RFC 8291)는 실제 브라우저 없이는 확인이 어려우므로,
 * 여기서 브라우저 역할(수신자 키쌍 보유)을 직접 맡아 복호화까지 해 본다.
 * 복호문이 원문과 일치하면 구현이 맞다는 뜻이다.
 */

import { encryptPayload, makeVapidHeader, b64urlToBytes, bytesToB64url } from '../src/push.js';
import { detectEvents } from '../src/detect.js';
import { normalizeGame, perspective, seriesOf, isPostseason, postseasonOutlook, kstIsoToEpoch,
         seasonYearOf, filterCurrentSeason } from '../src/kbo.js';
import { isPollWindow } from '../src/season.js';
import { validateEndpoint, validateKeys, checkOrigin } from '../src/security.js';
import { subscribersFor } from '../src/db.js';

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

  check('실점 문구', detectEvents(live(1, 0), live(1, 2), T)[0]?.title === '삼성 2점 실점');

  const ended = detectEvents(live(5, 3), g({ statusCode: 'RESULT', homeTeamScore: 5, awayTeamScore: 3 }), T);
  check('경기 종료 · 승리', ended[0]?.title === '경기 종료 · NC 승리', ended[0]?.title);

  const lost = detectEvents(live(2, 3), g({ statusCode: 'RESULT', homeTeamScore: 2, awayTeamScore: 7 }), T);
  check('종료 전이에서는 득점 알림 없음', kinds(lost) === 'end', kinds(lost));

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

/* ══ 실행 ══ */

console.log('\n[1] 푸시 페이로드 암복호화');  await testEncryption();
console.log('\n[2] VAPID JWT');              await testVapid();
console.log('\n[3] 시리즈 판별');            testSeries();
console.log('\n[3b] 이번 시즌 필터');        testSeasonFilter();
console.log('\n[4] 상태 전이 감지');         testDetect();
console.log('\n[5] 포스트시즌 진출 판정');   testOutlook();
console.log('\n[6] 시즌·시간대 게이팅');     testWindow();
console.log('\n[7] 보안 검증');              testSecurity();
console.log('\n[8] 홈경기 전용 알림 필터');  await testHomeOnly();

console.log(failed === 0 ? '\n전부 통과.\n' : `\n실패 ${failed}건.\n`);
process.exit(failed === 0 ? 0 : 1);

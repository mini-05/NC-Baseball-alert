/**
 * 입력 검증과 접근 제어.
 *
 * 제일 위험한 곳은 /api/subscribe 다. 받은 endpoint 로 서버가 직접 POST 를 보내니까
 * 검증 없이 받으면 아무 주소로나 요청을 보내게 된다(SSRF). 알려진 푸시 서비스
 * 호스트만 허용한다.
 */

/* ─────────────── 푸시 엔드포인트 허용 목록 ─────────────── */

/** 정확히 일치해야 하는 호스트 */
const EXACT_HOSTS = new Set([
  'fcm.googleapis.com',        // Chrome, Edge(Chromium), Samsung Internet
  'android.googleapis.com',    // 구형 FCM
  'web.push.apple.com',        // Safari / iOS
]);

/** 서브도메인이 바뀌는 서비스용 접미사 */
const HOST_SUFFIXES = [
  '.push.services.mozilla.com', // Firefox
  '.notify.windows.com',        // Windows WNS
  '.push.apple.com',
];

const MAX_ENDPOINT_LEN = 1024;

/**
 * 푸시 엔드포인트 검증.
 * @param {string} endpoint
 * @param {string} [extraHosts] 쉼표로 구분한 추가 허용 호스트 (env.EXTRA_PUSH_HOSTS)
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function validateEndpoint(endpoint, extraHosts = '') {
  if (typeof endpoint !== 'string' || endpoint.length === 0) {
    return { ok: false, reason: 'endpoint 가 비어 있습니다.' };
  }
  if (endpoint.length > MAX_ENDPOINT_LEN) {
    return { ok: false, reason: 'endpoint 가 너무 깁니다.' };
  }

  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return { ok: false, reason: 'endpoint 가 올바른 URL 이 아닙니다.' };
  }

  if (url.protocol !== 'https:') {
    return { ok: false, reason: 'endpoint 는 https 여야 합니다.' };
  }

  const host = url.hostname.toLowerCase();
  const extras = extraHosts
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);

  const allowed =
    EXACT_HOSTS.has(host) ||
    extras.includes(host) ||
    HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));

  if (!allowed) {
    // 브라우저가 새 푸시 호스트를 쓰면 여기서 막힌다.
    // EXTRA_PUSH_HOSTS 에 넣으면 코드 수정 없이 허용된다.
    return { ok: false, reason: `허용되지 않은 푸시 호스트입니다: ${host}` };
  }

  return { ok: true };
}

/* ─────────────── 키 검증 ─────────────── */

export const B64URL = /^[A-Za-z0-9_-]+$/;

/** base64url 디코딩 후 바이트 수(실제로 디코딩하지 않고 계산). */
function b64urlByteLength(s) {
  return Math.floor((s.length * 3) / 4);
}

/**
 * p256dh(65바이트 비압축 P-256 점), auth(16바이트) 검증.
 * 잘못된 값을 저장하면 발송할 때 가서야 에러가 나니까 받을 때 막는다.
 */
export function validateKeys(p256dh, auth) {
  if (typeof p256dh !== 'string' || !B64URL.test(p256dh)) {
    return { ok: false, reason: 'p256dh 형식이 올바르지 않습니다.' };
  }
  if (typeof auth !== 'string' || !B64URL.test(auth)) {
    return { ok: false, reason: 'auth 형식이 올바르지 않습니다.' };
  }
  if (b64urlByteLength(p256dh) !== 65) {
    return { ok: false, reason: 'p256dh 는 65바이트여야 합니다.' };
  }
  if (b64urlByteLength(auth) !== 16) {
    return { ok: false, reason: 'auth 는 16바이트여야 합니다.' };
  }
  return { ok: true };
}

/* ─────────────── 요청 검증 ─────────────── */

/** JSON 본문 크기 상한. 구독 정보는 1KB 안쪽이다. */
const MAX_BODY_BYTES = 4096;

/**
 * 요청 본문을 JSON 으로 읽는다. 크기 제한 있음.
 * Content-Length 로 먼저 걸러서 큰 본문은 읽지 않는다.
 */
export async function readJson(request) {
  const declared = Number(request.headers.get('Content-Length') ?? 0);
  if (declared > MAX_BODY_BYTES) {
    return { ok: false, reason: '요청 본문이 너무 큽니다.' };
  }

  const text = await request.text();
  // Content-Length 가 없거나 거짓인 요청은 여기서 다시 잰다. text.length 는 문자
  // 수라 한글이 섞이면 바이트 수보다 작게 나와서 실제 바이트로 잰다.
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    return { ok: false, reason: '요청 본문이 너무 큽니다.' };
  }

  try {
    const data = JSON.parse(text);
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      return { ok: false, reason: 'JSON 객체가 필요합니다.' };
    }
    return { ok: true, data };
  } catch {
    return { ok: false, reason: 'JSON 을 해석할 수 없습니다.' };
  }
}

/**
 * 상태를 바꾸는 요청은 같은 출처에서만 받는다.
 *
 * application/json 이면 프리플라이트가 걸려서 CSRF 는 대부분 막히지만 Origin 도
 * 직접 확인한다. Origin 이 없는 요청(curl 등)은 브라우저가 아니라서 통과시킨다.
 * CSRF 는 브라우저를 통해서 오니 Origin 이 항상 붙는다.
 */
export function checkOrigin(request, url) {
  const origin = request.headers.get('Origin');
  if (!origin) return true;
  return origin === url.origin;
}

/**
 * 관리자 엔드포인트 인증.
 * ADMIN_TOKEN 시크릿이 없으면 항상 거부.
 */
export function isAdmin(request, env) {
  const expected = env.ADMIN_TOKEN;
  if (!expected) return false;

  const got = request.headers.get('X-Admin-Token') ?? '';
  return timingSafeEqual(got, expected);
}

/** 비교 시간이 입력에 따라 달라지지 않게 한다(타이밍 공격 방지). */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** 테스트 알림 최소 간격(초). 구독마다 적용. */
export const TEST_COOLDOWN_SEC = 30;

/**
 * 무료 플랜의 워커 호출당 외부 요청(subrequest) 한도.
 * 구독 수 상한이 이걸로 정해진다(아래 MAX_SUBSCRIPTIONS).
 */
export const SUBREQUEST_BUDGET = 50;

/**
 * 최대 구독 수.
 *
 * 저장 공간이 아니라 subrequest 한도 때문에 정한 값이다. broadcast 가 구독 수만큼
 * fetch 를 보낸다(index.js). 구독 수를 N 이라 하면 크론 한 번에 최악의 경우:
 *
 *   재발송 1건                                    N
 *   폴링 POLLS_PER_TICK(2)회, 회당
 *     전광판 조회                                 1
 *     득점 시 재조회 또는 9회 이후 문자중계        1   (둘은 같은 틱에 안 겹친다)
 *     이벤트 2건 발송(시작+득점이 겹치는 틱)      2N
 *
 *   = N + 2 × (2 + 2N) = 5N + 4 ≤ 50  →  N ≤ 9
 *
 * 동시에 진행되는 경기는 하나로 본다(더블헤더도 순서대로 열린다).
 * 9 가 아니라 8 인 건 계산에 안 들어간 호출을 위한 여유. selftest [7-c] 가 확인한다.
 *
 * 한도를 넘으면 51번째 fetch 부터 실패하는데 allSettled 라 틱은 성공으로 끝나고
 * 뒤쪽 구독자만 알림을 못 받는다. 그래서 저장 단계에서 개수를 묶어 둔다
 * (꽉 차면 거절하지 않고 가장 오래된 구독을 지운다. db.js makeRoomForSubscription).
 *
 * 상한을 올리려면 broadcast 를 여러 호출로 나눠야 한다. 구독이 8개 찰 때 할 일.
 */
export const MAX_SUBSCRIPTIONS = 8;

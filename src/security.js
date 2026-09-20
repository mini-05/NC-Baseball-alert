/**
 * 입력 검증과 접근 제어.
 *
 * 이 서비스에서 가장 위험한 지점은 /api/subscribe 다. 클라이언트가 준 endpoint 로
 * 서버가 직접 HTTP 요청을 보내기 때문에, 검증 없이 받으면 Worker 가 임의의 주소로
 * POST 를 날리는 도구(SSRF)가 된다. 그래서 알려진 푸시 서비스 호스트만 허용한다.
 */

/* ─────────────── 푸시 엔드포인트 허용 목록 ─────────────── */

/** 정확히 일치해야 하는 호스트 */
const EXACT_HOSTS = new Set([
  'fcm.googleapis.com',        // Chrome, Edge(Chromium), Samsung Internet
  'android.googleapis.com',    // 구형 FCM
  'web.push.apple.com',        // Safari / iOS
]);

/** 이 접미사로 끝나야 하는 호스트 (서브도메인이 동적으로 붙는 서비스) */
const HOST_SUFFIXES = [
  '.push.services.mozilla.com', // Firefox
  '.notify.windows.com',        // Windows WNS
  '.push.apple.com',
];

const MAX_ENDPOINT_LEN = 1024;

/**
 * 푸시 엔드포인트를 검증한다.
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
    // 새 브라우저가 새 호스트를 쓰기 시작하면 여기서 걸린다.
    // 로그를 보고 EXTRA_PUSH_HOSTS 에 추가하면 코드 수정 없이 풀 수 있다.
    return { ok: false, reason: `허용되지 않은 푸시 호스트입니다: ${host}` };
  }

  return { ok: true };
}

/* ─────────────── 키 검증 ─────────────── */

const B64URL = /^[A-Za-z0-9_-]+$/;

/** base64url 문자열의 디코딩 후 바이트 수를 계산한다. (실제 디코딩 없이) */
function b64urlByteLength(s) {
  return Math.floor((s.length * 3) / 4);
}

/**
 * p256dh(65바이트 비압축 P-256 점)와 auth(16바이트 시크릿)를 검증한다.
 * 형식이 틀린 값을 그대로 저장하면 발송 시점에야 터지므로 입력에서 막는다.
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

/** JSON 본문 크기 상한. 구독 정보는 1KB 를 넘지 않는다. */
const MAX_BODY_BYTES = 4096;

/**
 * 요청 본문을 안전하게 JSON 으로 읽는다.
 * Content-Length 로 먼저 걸러 큰 본문을 메모리에 올리지 않는다.
 */
export async function readJson(request) {
  const declared = Number(request.headers.get('Content-Length') ?? 0);
  if (declared > MAX_BODY_BYTES) {
    return { ok: false, reason: '요청 본문이 너무 큽니다.' };
  }

  const text = await request.text();
  // text.length 는 문자 수라 한글처럼 UTF-8 로 3바이트인 문자가 섞이면 실제
  // 바이트 수보다 최대 3배 작게 나온다 — Content-Length 헤더 없이(또는 거짓
  // 값으로) 오는 요청은 위 검사를 피해 이 줄만 남으므로, 여기서는 실제
  // 바이트 수로 다시 잰다.
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
 * 상태를 바꾸는 요청은 같은 출처에서 와야 한다.
 *
 * Content-Type: application/json 은 프리플라이트를 유발하므로 브라우저發 CSRF 는
 * 이미 대부분 막히지만, Origin 을 명시적으로 확인해 의도를 코드에 남긴다.
 * Origin 헤더가 아예 없는 요청(curl 등)은 브라우저가 아니므로 통과시킨다 —
 * CSRF 는 피해자의 브라우저를 이용하는 공격이라 Origin 이 반드시 붙는다.
 */
export function checkOrigin(request, url) {
  const origin = request.headers.get('Origin');
  if (!origin) return true;
  return origin === url.origin;
}

/**
 * 관리자 전용 엔드포인트 인증.
 * ADMIN_TOKEN 시크릿이 설정돼 있지 않으면 해당 기능을 잠근다(기본 거부).
 */
export function isAdmin(request, env) {
  const expected = env.ADMIN_TOKEN;
  if (!expected) return false;

  const got = request.headers.get('X-Admin-Token') ?? '';
  return timingSafeEqual(got, expected);
}

/** 길이·내용 비교 시간을 입력에 무관하게 만든다. */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** 테스트 알림 최소 간격(초). 같은 구독이 이보다 자주 보내지 못한다. */
export const TEST_COOLDOWN_SEC = 30;

/**
 * 무료 플랜이 워커 호출 하나에 허용하는 외부 요청(subrequest) 수.
 * 이 예산이 구독 수 상한을 정한다 — 아래 MAX_SUBSCRIPTIONS 참고.
 */
export const SUBREQUEST_BUDGET = 50;

/**
 * 저장 가능한 최대 구독 수.
 *
 * 이 값을 정하는 것은 저장 공간이 아니라 위 subrequest 예산이다. broadcast 가
 * 구독 수만큼 fetch 를 한꺼번에 날리기 때문이다(index.js `Promise.allSettled`).
 * 크론 한 번이 쓰는 최악의 예산은 N 을 구독 수라 할 때:
 *
 *   재발송 1건                                    N
 *   폴링 POLLS_PER_TICK(2)회, 회당
 *     전광판 조회                                 1
 *     득점 시 재조회 또는 9회 이후 문자중계        1   (둘은 같은 틱에 안 겹친다)
 *     이벤트 2건 발송(시작+득점이 겹치는 틱)      2N
 *
 *   = N + 2 × (2 + 2N) = 5N + 4 ≤ 50  →  N ≤ 9
 *
 * 동시에 진행되는 경기는 하나로 본다. 더블헤더도 순차라 한쪽이 끝난 뒤
 * 다른 쪽이 시작하므로, 이벤트가 나는 경기는 어느 순간에도 하나다.
 *
 * 9 가 아니라 8 로 두는 것은 위 계산에 안 잡힌 호출 하나를 위한 여유다.
 * 자체 검증이 이 부등식을 상수로 다시 계산해 지키는지 확인한다.
 *
 * 넘기면 조용히 깨진다 — 51번째 fetch 부터 예외가 나는데 broadcast 의
 * allSettled 가 rejected 로 기록만 하고 틱은 성공으로 끝난다. 앞쪽 구독자는
 * 받고 뒤쪽은 못 받는데 서버는 다 보냈다고 여긴다. 그래서 문 앞에서 막는다.
 *
 * 이 천장을 올리려면 broadcast 를 여러 호출로 쪼개야 한다. 구독이 8을
 * 채우기 전에는 없는 문제라 지금은 상한만 정직하게 둔다.
 */
export const MAX_SUBSCRIPTIONS = 8;

/**
 * Worker 진입점.
 *  - scheduled(): 경기 시간대에만 상태를 확인하고 변화가 있으면 푸시를 보낸다.
 *  - fetch():     PWA 정적 파일 + /api/*
 */

import {
  fetchGames, filterTeam, filterCurrentSeason, kstNow, kstDateOffset, postseasonOutlook,
  fetchScoreboard,
} from './kbo.js';
import { detectEvents, KINDS, SCOPES } from './detect.js';
import { sendPush } from './push.js';
import {
  loadDailyPlan, isPollWindow, loadStandings, loadSchedule, loadTodayStatus,
  invalidatePlan, resolveSeasonOpener, invalidateStandings, invalidateSchedule,
} from './season.js';
import {
  loadStates, upsertStateStmt, insertEvent, listHistory,
  saveSubscription, deleteSubscription, getSubscription, getSettings,
  updateSettings, subscribersFor, countSubscriptions, touchTestSent, pruneOtherSeasons,
} from './db.js';
import {
  validateEndpoint, validateKeys, readJson, checkOrigin, isAdmin,
  TEST_COOLDOWN_SEC, MAX_SUBSCRIPTIONS,
} from './security.js';

/** 팀당 정규시즌 경기 수. 포스트시즌 진출 가능성 계산에 쓴다. */
const REGULAR_SEASON_GAMES = 144;

/* ============================ 크론: 상태 감시 ============================ */

/**
 * 오늘 경기 계획을 보고 감시가 필요한 시간인지 판단한다.
 * 비시즌이나 경기 없는 날에는 여기서 끝나므로 일정 API 호출이 하루 1회로 줄어든다.
 */
async function tick(env) {
  const kst = kstNow();
  // loadDailyPlan 도 내부적으로 이 값을 쓰지만, 하루 계획이 캐시에 있으면
  // 그쪽에서는 조회하지 않는다. 여기서 한 번 구해 poll() 에도 그대로 넘겨,
  // 경기 시간대 동안 1분마다 반복되는 poll() 이 같은 값을 또 캐시 조회하지 않게 한다.
  const opener = await resolveSeasonOpener(env, kst.year);
  const plan = await loadDailyPlan(env, kst.date);

  if (plan.games.length === 0) return { skipped: 'no-games-today' };
  if (!isPollWindow(plan)) return { skipped: 'outside-window' };

  return poll(env, opener);
}

/** opener 를 생략하면(예: /api/admin/poll 에서 tick() 없이 직접 호출) 직접 구한다. */
async function poll(env, opener) {
  const kst = kstNow();
  opener ??= await resolveSeasonOpener(env, kst.year);

  // 자정을 넘겨 끝나는 경기가 있어 어제~오늘을 함께 본다.
  // 시범경기·올스타전·지난 시즌 경기는 알림 대상이 아니므로 여기서 걸러 낸다.
  const games = filterCurrentSeason(
    filterTeam(await fetchGames(kstDateOffset(-1), kst.date), env.TEAM_CODE),
    kst.year,
    opener,
  );
  if (games.length === 0) return { checked: 0, fired: 0 };

  const prevStates = await loadStates(env.DB, games.map((g) => g.gameId));

  // 전광판은 경기 전에는 존재하지 않으니 그 경우만 조회를 건너뛴다.
  // 단일 팀만 폴링하므로 한 틱에 많아야 한두 건이라 병렬로 불러도 부담이 없다.
  const scoreboards = new Map(
    await Promise.all(
      games
        .filter((g) => g.phase !== 'before')
        .map(async (g) => [g.gameId, await fetchScoreboard(g.gameId)]),
    ),
  );

  const writes = [];
  const pending = [];

  for (const game of games) {
    const prev = prevStates.get(game.gameId) ?? null;
    const board = scoreboards.get(game.gameId);

    // 스냅샷은 이벤트 발생 여부와 무관하게 항상 최신으로 맞춘다.
    writes.push(upsertStateStmt(env.DB, game, board ? JSON.stringify(board) : null));

    for (const ev of detectEvents(prev, game, env.TEAM_CODE)) {
      pending.push({ game, ev });
    }
  }

  if (writes.length > 0) await env.DB.batch(writes);

  let fired = 0;
  let ended = false;

  for (const { game, ev } of pending) {
    // dedup_key 충돌이면 이미 발송한 이벤트이므로 건너뛴다.
    if (!(await insertEvent(env.DB, game, ev))) continue;

    await broadcast(env, ev);
    if (ev.kind === 'end') ended = true;
    fired++;
  }

  // 경기가 끝났으면 순위와 지난 일정의 결과가 함께 바뀐다. 두 캐시를 비운다.
  if (ended) {
    await invalidateStandings(env, kst.year);
    await invalidateSchedule(env, kst.year);
  }

  return { checked: games.length, fired };
}

/**
 * 이 이벤트를 받기로 한 구독자에게만 발송하고, 폐기된 구독은 정리한다.
 * 종류·시리즈 범위·홈경기 여부를 모두 만족하는 구독만 대상이 된다.
 */
async function broadcast(env, ev) {
  const subs = await subscribersFor(env.DB, ev.kind, ev.scope, ev.isHome);
  if (subs.length === 0) return;

  const payload = {
    kind: ev.kind,
    scope: ev.scope,
    series: ev.series,
    isHome: ev.isHome,
    title: ev.title,
    body: ev.body,
    ts: Date.now(),
  };

  const results = await Promise.allSettled(subs.map((s) => sendPush(s, payload, env)));

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'rejected') {
      console.error('push failed', r.reason?.message);
    } else if (r.value.gone) {
      await deleteSubscription(env.DB, subs[i].endpoint);
    } else if (!r.value.ok) {
      console.error('push rejected with status', r.value.status);
    }
  }
}

/* ============================ HTTP API ============================ */

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });

/**
 * endpoint 를 검증해 통과하면 null, 실패하면 바로 반환할 오류 Response 를 준다.
 * 네 개의 API 핸들러가 같은 "검증 후 400 응답" 모양을 반복하고 있어 한곳으로 모았다.
 */
function endpointOrError(endpoint, env, { warn = false } = {}) {
  const check = validateEndpoint(endpoint, env.EXTRA_PUSH_HOSTS ?? '');
  if (check.ok) return null;

  if (warn) console.warn('rejected endpoint:', check.reason);
  return json({ error: check.reason }, 400);
}

/** 요청 본문에서 검증된 endpoint 와 그 구독 레코드를 꺼낸다. */
async function requireSubscription(request, env) {
  const parsed = await readJson(request);
  if (!parsed.ok) return { error: json({ error: parsed.reason }, 400) };

  const endpoint = parsed.data.endpoint;
  const epError = endpointOrError(endpoint, env);
  if (epError) return { error: epError };

  const sub = await getSubscription(env.DB, endpoint);
  if (!sub) return { error: json({ error: '등록되지 않은 구독입니다.' }, 404) };

  return { body: parsed.data, endpoint, sub };
}

async function handleApi(request, env, url) {
  const path = url.pathname;
  const method = request.method;

  // 상태를 바꾸는 요청은 같은 출처에서만 받는다.
  if (method !== 'GET' && !checkOrigin(request, url)) {
    return json({ error: '허용되지 않은 출처입니다.' }, 403);
  }

  /* ── 공개 조회 ── */

  if (path === '/api/config' && method === 'GET') {
    return json({
      vapidPublicKey: env.VAPID_PUBLIC_KEY,
      teamCode: env.TEAM_CODE,
    });
  }

  if (path === '/api/history' && method === 'GET') {
    const days = Math.min(Math.max(Number(url.searchParams.get('days')) || 30, 1), 120);
    const { year } = kstNow();
    return json({
      games: await listHistory(env.DB, { limitDays: days, seasonYear: year, teamCode: env.TEAM_CODE }),
    });
  }

  /**
   * 이번 시즌 전체 일정. 홈경기 여부와 지난 경기의 결과를 함께 내려
   * 앱에서 홈경기를 강조하고 지난 일정에 스코어를 붙일 수 있게 한다.
   */
  if (path === '/api/schedule' && method === 'GET') {
    const { year, date } = kstNow();
    return json({ today: date, games: await loadSchedule(env, year) });
  }

  /** 순위와 포스트시즌 진출 상황. 비시즌이면 standings 가 null 이다. */
  if (path === '/api/standings' && method === 'GET') {
    const { year, date } = kstNow();
    const standings = await loadStandings(env, year);
    if (!standings) return json({ standings: null, outlook: null });

    // 팀별 잔여 경기와 "오늘 경기가 순위에 들어갔는지"를 붙여 내려준다.
    // 캐시된 순위 자체는 건드리지 않고 응답에서만 덧붙인다 — 잔여 경기 수는
    // 시즌 상수(여기)에 달려 있고, 오늘 상태는 순위보다 빨리 바뀌기 때문이다.
    const todayStatus = await loadTodayStatus(env, date, year);

    return json({
      standings: {
        ...standings,
        teams: standings.teams.map((t) => ({
          ...t,
          remaining: Math.max(0, REGULAR_SEASON_GAMES - t.games),
          todayGame: todayStatus[t.code] ?? null,
        })),
      },
      outlook: postseasonOutlook(standings, env.TEAM_CODE, REGULAR_SEASON_GAMES),
    });
  }

  /* ── 구독 ── */

  if (path === '/api/subscribe' && method === 'POST') {
    const parsed = await readJson(request);
    if (!parsed.ok) return json({ error: parsed.reason }, 400);

    const { endpoint, keys } = parsed.data;

    const epError = endpointOrError(endpoint, env, { warn: true });
    if (epError) return epError;

    const keyCheck = validateKeys(keys?.p256dh, keys?.auth);
    if (!keyCheck.ok) return json({ error: keyCheck.reason }, 400);

    // 이미 있는 구독의 갱신은 개수 제한과 무관하다.
    if (!(await getSubscription(env.DB, endpoint))) {
      if ((await countSubscriptions(env.DB)) >= MAX_SUBSCRIPTIONS) {
        return json({ error: '구독 수 한도에 도달했습니다.' }, 429);
      }
    }

    await saveSubscription(env.DB, { endpoint, p256dh: keys.p256dh, auth: keys.auth });
    return json({ ok: true, settings: await getSettings(env.DB, endpoint) });
  }

  if (path === '/api/unsubscribe' && method === 'POST') {
    const parsed = await readJson(request);
    if (!parsed.ok) return json({ error: parsed.reason }, 400);

    const epError = endpointOrError(parsed.data.endpoint, env);
    if (epError) return epError;

    // 없는 구독을 지워도 성공으로 답한다. 존재 여부를 알려 줄 이유가 없다.
    await deleteSubscription(env.DB, parsed.data.endpoint);
    return json({ ok: true });
  }

  /* ── 설정 ── */

  if (path === '/api/settings' && method === 'GET') {
    const endpoint = url.searchParams.get('endpoint');
    const epError = endpointOrError(endpoint, env);
    if (epError) return epError;

    const settings = await getSettings(env.DB, endpoint);
    return settings ? json({ settings }) : json({ error: '등록되지 않은 구독입니다.' }, 404);
  }

  if (path === '/api/settings' && method === 'POST') {
    const req = await requireSubscription(request, env);
    if (req.error) return req.error;

    // 알려진 키의 불린 값만 통과시킨다.
    const patch = {};
    for (const name of [...KINDS, ...SCOPES, 'homeOnly']) {
      if (typeof req.body[name] === 'boolean') patch[name] = req.body[name];
    }
    if (Object.keys(patch).length === 0) {
      return json({ error: '변경할 항목이 없습니다.' }, 400);
    }

    await updateSettings(env.DB, req.endpoint, patch);
    return json({ ok: true, settings: await getSettings(env.DB, req.endpoint) });
  }

  /* ── 테스트 알림 ── */

  if (path === '/api/test' && method === 'POST') {
    const req = await requireSubscription(request, env);
    if (req.error) return req.error;

    // 같은 구독이 짧은 간격으로 반복 발송하지 못하게 막는다.
    const last = req.sub.last_test_at ? Date.parse(req.sub.last_test_at) : 0;
    const waited = (Date.now() - last) / 1000;
    if (waited < TEST_COOLDOWN_SEC) {
      return json({ error: `${Math.ceil(TEST_COOLDOWN_SEC - waited)}초 후에 다시 시도해 주세요.` }, 429);
    }

    await touchTestSent(env.DB, req.endpoint);

    // 이 엔드포인트는 설정을 점검하는 용도다. 실패 원인을 감추면 진단이 불가능하므로
    // 여기서만은 예외 메시지를 그대로 돌려준다. (VAPID 키 설정 오류 등)
    try {
      const res = await sendPush(
        req.sub,
        { kind: 'test', title: '테스트 알림', body: '알림이 정상 동작합니다.', ts: Date.now() },
        env,
      );

      if (!res.ok) {
        return json(
          { error: `푸시 서비스가 거부했습니다 (HTTP ${res.status}).`, status: res.status },
          502,
        );
      }
      return json({ ok: true, status: res.status });
    } catch (err) {
      console.error('test push failed', err);
      return json({ error: err.message }, 500);
    }
  }

  /* ── 관리자 전용 ── */
  // 외부 API 호출을 유발하므로 공개하지 않는다. ADMIN_TOKEN 시크릿이 필요하다.

  if (path === '/api/admin/poll' && method === 'POST') {
    if (!isAdmin(request, env)) return json({ error: '권한이 없습니다.' }, 401);
    return json(await poll(env));
  }

  if (path === '/api/admin/refresh-plan' && method === 'POST') {
    if (!isAdmin(request, env)) return json({ error: '권한이 없습니다.' }, 401);

    const { date } = kstNow();
    await invalidatePlan(env, date);
    return json({ ok: true, plan: await loadDailyPlan(env, date) });
  }

  /** 이번 시즌이 아닌 경기 기록을 DB에서 지운다. 필터 도입 전에 쌓인 행 정리용. */
  if (path === '/api/admin/prune' && method === 'POST') {
    if (!isAdmin(request, env)) return json({ error: '권한이 없습니다.' }, 401);

    const { year } = kstNow();
    return json({ ok: true, season: year, deleted: await pruneOtherSeasons(env.DB, year) });
  }

  return json({ error: 'Not found' }, 404);
}

/* ============================ 정적 파일 ============================ */

/**
 * PWA 응답에 보안 헤더를 붙인다.
 * CSP 는 인라인 스크립트를 막아 XSS 가 성립할 여지를 한 겹 더 줄인다.
 * (앱의 CSS/JS 는 모두 별도 파일이므로 인라인 허용이 필요 없다.)
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // 웹폰트 출처만 허용한다.
  //   Google Fonts — Cormorant Garamond · Inter · Noto Serif KR
  //   jsdelivr     — Pretendard (본문 한글)
  // Tossface 는 SVG 심볼로 인라인돼 있어 외부 출처가 필요 없다.
  "style-src 'self' https://fonts.googleapis.com https://cdn.jsdelivr.net",
  "font-src 'self' https://fonts.gstatic.com https://cdn.jsdelivr.net",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function withSecurityHeaders(res) {
  const headers = new Headers(res.headers);
  headers.set('Content-Security-Policy', CSP);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'same-origin');
  headers.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(request, env, url);
      } catch (err) {
        // 내부 오류 메시지를 그대로 노출하지 않는다. 상세는 로그로만 남긴다.
        console.error('api error', url.pathname, err);
        return json({ error: '서버 오류가 발생했습니다.' }, 500);
      }
    }

    return withSecurityHeaders(await env.ASSETS.fetch(request));
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      tick(env).catch((err) => {
        console.error('tick failed', err);
      }),
    );
  },
};

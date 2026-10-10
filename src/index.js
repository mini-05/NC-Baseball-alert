/**
 * Worker 진입점.
 *  - scheduled(): 매분 크론. 경기 시간대면 상태를 보고 바뀐 게 있으면 푸시를 보낸다.
 *  - fetch():     PWA 정적 파일과 /api/*
 */

import {
  fetchGames, filterTeam, filterCurrentSeason, kstNow, kstDateOffset, postseasonOutlook,
  fetchScoreboard, fetchRelayFinish, inningOf, inningSumMatches, headToHead,
} from './kbo.js';
import { detectEvents } from './detect.js';
import { sendPush } from './push.js';
import {
  loadDailyPlan, pollWindowGames, loadStandings, loadSchedule, loadTodayStatus,
  invalidatePlan, resolveSeasonOpener, invalidateStandings, invalidateSchedule,
  FINISH_COOLDOWN_MIN,
} from './season.js';
import {
  loadStates, upsertStateStmt, insertEvent, listHistory, insertPollLogStmt,
  saveSubscription, deleteSubscription, getSubscription, getSettings,
  updateSettings, subscribersFor, makeRoomForSubscription, touchTestSent, pruneOtherSeasons,
  allSettledBefore, markDelivered, listUndelivered, markResent, SETTING_COLUMN,
} from './db.js';
import {
  validateEndpoint, validateKeys, readJson, checkOrigin, isAdmin,
  TEST_COOLDOWN_SEC, MAX_SUBSCRIPTIONS,
} from './security.js';

/** 팀당 정규시즌 경기 수. 잔여 경기·진출 가능성 계산용. */
const REGULAR_SEASON_GAMES = 144;

/* ============================ 크론: 상태 감시 ============================ */

/**
 * 크론 한 번에 몇 번 폴링할지와 그 간격.
 *
 * 크론은 1분이 최소라 그대로면 득점 알림이 최대 60초 늦는다. 한 번 깨어났을 때
 * 30초 간격으로 2번 보면 절반으로 준다.
 *
 * 무료 플랜 크론 CPU 한도는 10ms 인데 대기 시간은 CPU 로 안 친다. 횟수를 늘리면
 * 폴링마다 CPU 를 더 쓰니 그 한도부터 확인할 것. subrequest 예산도 이 값에 묶여
 * 있다(security.js MAX_SUBSCRIPTIONS).
 */
export const POLLS_PER_TICK = 2;

const POLL_GAP_MS = 30 * 1000;

/**
 * 전광판(record API)이 총점(schedule API)보다 늦을 때 다시 부르기 전 대기 시간.
 * 바로 다시 부르면 같은 값이 온다.
 * 득점 틱에서 합이 안 맞을 때만 기다리고, 폴링 간격(30초)보다 한참 짧다.
 */
const BOARD_RETRY_MS = 2 * 1000;

/**
 * 배달 확인이 이 시간 안에 안 오면 다시 보낸다.
 *
 * 확인이 몇 분씩 늦은 적이 있는데(2026-09-02, 2분 53초) 확인해 보니 늘 다음
 * 푸시가 온 2~3초 뒤에 도착했다. 서비스 워커가 잠들어 있으면 /api/delivered 가
 * 밀려 있다가 다음 푸시 때 같이 나간다. 그러니 오래 기다린다고 오지 않는다.
 *
 * 괜히 다시 보내도 문제는 없다. 원본이 FCM 에 남아 있으면 Topic 이 같아서 교체되고,
 * 이미 떠 있으면 sw.js 가 같은 id 를 보고 건너뛴다. 재발송은 이벤트당 한 번이다.
 *
 * 90초보다 짧으면 정상 전달 중인 것까지 다시 보내게 되고, 길면 득점 알림으로서
 * 의미가 없어진다.
 */
const RESEND_AFTER_MS = 90 * 1000;

/** 이보다 오래된 이벤트는 재발송하지 않는다. 한참 지나서 뜨면 헷갈리기만 한다. */
const RESEND_GIVE_UP_MS = 30 * 60 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 크론 한 번 분량. 오늘 계획을 보고 감시 시간이 아니면 바로 끝낸다.
 * 경기 없는 날은 계획 조회(하루 1번) 말고는 외부 호출이 없다.
 */
async function tick(env) {
  const kst = kstNow();
  const plan = await loadDailyPlan(env, kst.date);

  if (plan.games.length === 0) return { skipped: 'no-games-today' };

  const watching = pollWindowGames(plan);
  if (watching.length === 0) return { skipped: 'outside-window' };

  // 재발송은 아래 all-finished 판단보다 먼저 한다. 놓친 알림 중에 종료 알림이
  // 있으면 바로 그 뒤가 감시를 접는 구간이라, 뒤에 두면 재발송이 안 돈다.
  const resent = await resendUndelivered(env)
    .catch((err) => { console.error('resend failed', err); return 0; });

  // 시간대 안이어도 경기가 다 끝났고 FINISH_COOLDOWN_MIN 이 지났으면 그만 본다.
  // 폴링(30초 대기 포함)보다 먼저 판단해야 헛대기가 없다.
  const cutoff = new Date(Date.now() - FINISH_COOLDOWN_MIN * 60 * 1000).toISOString();
  if (await allSettledBefore(env.DB, watching.map((g) => g.gameId), cutoff)) {
    return { skipped: 'all-finished', resent };
  }

  // 개막일은 폴링에만 쓴다. 감시 안 하는 틱에서 캐시를 읽지 않게 여기서 구한다.
  const opener = await resolveSeasonOpener(env, kst.year);

  // 한 번 실패해도 다음 폴링은 그대로 한다.
  const runs = [];
  for (let i = 0; i < POLLS_PER_TICK; i++) {
    if (i > 0) await sleep(POLL_GAP_MS);
    runs.push(
      await poll(env, opener).catch((err) => {
        console.error('poll failed', err);
        return { error: err.message };
      }),
    );
  }
  return { runs, resent };
}

/**
 * 전광판으로 득점 이닝을 알 수 있는지. 양 팀 이닝 합이 둘 다 총점과 맞아야 한다.
 * scoringInning 은 득점한 쪽만 보지만, 어느 쪽인지 여기서 또 판단하기 싫어서
 * 양쪽을 다 본다.
 */
export function boardCoversScore(board, game) {
  return !!board
    && inningSumMatches(board.home?.innings, game.homeScore)
    && inningSumMatches(board.away?.innings, game.awayScore);
}

/** 한 번 폴링. opener 가 없으면(/api/admin/poll) 여기서 구한다. */
async function poll(env, opener) {
  const kst = kstNow();
  opener ??= await resolveSeasonOpener(env, kst.year);

  // 자정 넘어 끝나는 경기 때문에 어제~오늘을 본다. 시범경기·올스타전·지난 시즌은 뺀다.
  const games = filterCurrentSeason(
    filterTeam(await fetchGames(kstDateOffset(-1), kst.date), env.TEAM_CODE),
    kst.year,
    opener,
  );
  if (games.length === 0) return { checked: 0, fired: 0 };

  const prevStates = await loadStates(env.DB, games.map((g) => g.gameId));

  // 경기 전에는 전광판이 없으니 건너뛴다. 한 팀만 보니까 많아야 한두 건이다.
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
    let board = scoreboards.get(game.gameId) ?? null;

    const scored = prev
      && (game.homeScore !== prev.homeScore || game.awayScore !== prev.awayScore);

    /*
     * 득점 틱인데 전광판을 못 쓰면(못 받았거나 합이 안 맞음) 잠깐 뒤 한 번 더 부른다.
     * 이 득점 알림은 dedup_key 때문에 다시 못 보내서, 지금 이닝을 못 붙이면 끝이다.
     * 다시 불러도 안 맞으면 이닝 없이 보낸다(scoringInning 이 null 을 준다).
     */
    if (scored && game.phase === 'live' && !boardCoversScore(board, game)) {
      await sleep(BOARD_RETRY_MS);
      board = (await fetchScoreboard(game.gameId)) ?? board;
    }

    /*
     * 9회 이후 진행 중이면 문자중계로 종료를 먼저 확인한다(kbo.js fetchRelayFinish).
     * schedule API 는 ENDED 가 2분쯤 늦다.
     *
     * 점수가 schedule API 와 다르면 안 쓴다. 틀린 최종 점수로 종료 알림이 나가면
     * 되돌릴 수 없다.
     *
     * 이번 틱에 득점이 있었으면(끝내기) 다음 폴링으로 넘긴다. 여기서 result 로
     * 바꾸면 detect.js 가 live 일 때만 득점을 보기 때문에 끝내기 득점 알림이 빠진다.
     */
    if (!scored && game.phase === 'live' && inningOf(game.statusInfo) >= 9) {
      const finish = await fetchRelayFinish(game.gameId);
      if (finish
        && finish.homeScore === game.homeScore
        && finish.awayScore === game.awayScore) {
        game.phase = 'result';
      }
    }

    // 이벤트가 없어도 스냅샷은 항상 갱신.
    writes.push(upsertStateStmt(env.DB, game, board ? JSON.stringify(board) : null));
    // 디버깅용 원본 상태 로그.
    writes.push(insertPollLogStmt(env.DB, game));

    // 전광판을 못 받았으면 홈런 목록은 이전 값을 쓴다. 조회 한 번 실패로 홈런
    // 기록이 없어진 걸로 처리되지 않게(저장 쪽 COALESCE 와 같은 이유).
    game.hr = board?.hr ?? prev?.hr ?? [];

    // 득점 이닝 계산용. hr 과 달리 이전 값을 쓰지 않는다(예전 전광판이면 이닝이 틀림).
    game.board = board ?? null;

    for (const ev of detectEvents(prev, game, env.TEAM_CODE)) {
      pending.push({ game, ev });
    }
  }

  if (writes.length > 0) await env.DB.batch(writes);

  let fired = 0;
  let ended = false;

  for (const { game, ev } of pending) {
    // null 이면 이미 보낸 이벤트.
    const eventId = await insertEvent(env.DB, game, ev);
    if (!eventId) continue;

    await broadcast(env, ev, game.gameId, eventId);
    if (ev.kind === 'end') ended = true;
    fired++;
  }

  // 경기가 끝나면 순위와 일정 결과가 바뀌니 두 캐시를 만료시킨다.
  if (ended) {
    await invalidateStandings(env, kst.year);
    await invalidateSchedule(env, kst.year);
  }

  return { checked: games.length, fired };
}

/**
 * 배달 확인이 안 온 알림을 한 번 더 보낸다.
 *
 * 서버는 FCM 이 받은 데까지만 알고, 기기에 안 뜬 건 모른다(2026-08-30·09-01·
 * 09-02·09-09 에 한 건씩 있었음). sw.js 가 보내는 배달 확인이 없으면 다시 보낸다.
 *
 * 확인 신호도 가끔 빠진다(떴는데 확인만 실패, 2026-09-02 id 74). 그래서 실제로
 * 띄울지는 기기가 정한다. sw.js 가 알림함에 같은 id 가 있으면 건너뛴다.
 */
async function resendUndelivered(env) {
  const now = Date.now();
  const pending = await listUndelivered(env.DB, env.TEAM_CODE, {
    olderThan: new Date(now - RESEND_AFTER_MS).toISOString(),
    newerThan: new Date(now - RESEND_GIVE_UP_MS).toISOString(),
  });

  for (const ev of pending) {
    // 보내기 전에 표시부터 한다. 발송이 실패해도 다시 안 한다. 실패할 때마다
    // 재시도하면 창이 닫힐 때까지 매 틱 같은 걸 보내게 된다.
    await markResent(env.DB, ev.id);
    await broadcast(
      env,
      {
        ...ev,
        // 알림함에 재발송 시각 말고 원래 감지 시각이 찍히게.
        ts: Date.parse(ev.createdAt) || Date.now(),
      },
      ev.gameId,
      ev.id,
      true,
    );
  }

  if (pending.length > 0) {
    console.log('resent undelivered', pending.map((e) => `${e.id}:${e.kind}`).join(','));
  }
  return pending.length;
}

/**
 * 이벤트를 받을 구독자(종류·시리즈·홈경기 설정 확인)에게 보내고,
 * 없어진 구독(404/410)은 지운다.
 */
async function broadcast(env, ev, gameId, eventId, resend = false) {
  const subs = await subscribersFor(env.DB, ev.kind, ev.scope, ev.isHome);
  if (subs.length === 0) {
    // 로그가 없으면 "받을 사람이 없음"과 "보냈는데 안 뜸"을 구분할 수 없다.
    // 어떤 설정에 걸렸는지 보이게 kind·scope·isHome 을 같이 남긴다.
    console.log('broadcast skipped: 수신 대상 0명', ev.kind, ev.scope, `isHome=${ev.isHome}`, gameId);
    return;
  }

  const payload = {
    kind: ev.kind,
    scope: ev.scope,
    series: ev.series,
    isHome: ev.isHome,
    title: ev.title,
    body: ev.body,
    // sw.js 에서 같은 이벤트인지 확인(재발송 중복 방지)하고 /api/delivered 로
    // 배달 확인을 보낼 때 쓴다. 테스트 알림에는 없다.
    id: eventId,
    // 알림 tag(nc-{gameId})와 FCM Topic 에 쓴다. 경기마다 알림 하나로 묶인다.
    gameId,
    /*
     * 알림함에 찍히는 시각(sw.js notification timestamp).
     * 재발송은 원래 감지 시각을 넣는다. 재발송 시각을 쓰면 늦게 감지한 것처럼
     * 보인다(2026-09-17: 감지 19:28:34, 알림함에는 "오후 7:33").
     */
    ts: ev.ts ?? Date.now(),
  };

  // 재발송 표시. 지금 sw.js 는 이 값과 상관없이 모든 푸시에서 알림함을 확인한다.
  if (resend) payload.resend = true;

  // 발송 결과를 kind·gameId·endpoint 로 찾을 수 있게 로그에 남긴다.
  // endpoint 는 끝 12자만(구분은 되고 전체는 안 남게).
  const sentAt = Date.now();
  const results = await Promise.allSettled(subs.map((s) => sendPush(s, payload, env)));

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const ep = subs[i].endpoint.slice(-12);
    if (r.status === 'rejected') {
      console.error('push failed', ev.kind, gameId, ep, r.reason?.message);
    } else if (r.value.gone) {
      console.log('push gone, deleting sub', ev.kind, gameId, ep, r.value.status);
      await deleteSubscription(env.DB, subs[i].endpoint);
    } else if (!r.value.ok) {
      console.error('push rejected with status', ev.kind, gameId, ep, r.value.status);
    } else {
      console.log('push sent', ev.kind, gameId, ep, `${Date.now() - sentAt}ms`);
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

/** endpoint 가 괜찮으면 null, 아니면 바로 돌려줄 400 응답. */
function endpointOrError(endpoint, env, { warn = false } = {}) {
  const check = validateEndpoint(endpoint, env.EXTRA_PUSH_HOSTS ?? '');
  if (check.ok) return null;

  if (warn) console.warn('rejected endpoint:', check.reason);
  return json({ error: check.reason }, 400);
}

/** 요청 본문의 endpoint 를 검증하고 등록된 구독을 찾는다. 실패하면 { error }. */
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

  /** 이번 시즌 전체 일정(홈/원정, 지난 경기 결과 포함)과 상대전적. */
  if (path === '/api/schedule' && method === 'GET') {
    const { year, date } = kstNow();
    const games = await loadSchedule(env, year);
    // 상대전적은 일정에서 센다(kbo.js headToHead). 추가 조회 없음.
    return json({ today: date, games, headToHead: headToHead(games) });
  }

  /** 순위와 포스트시즌 진출 상황. 데이터가 없으면 standings 가 null. */
  if (path === '/api/standings' && method === 'GET') {
    const { year, date } = kstNow();
    const standings = await loadStandings(env, year);
    if (!standings) return json({ standings: null, outlook: null });

    // 잔여 경기와 오늘 경기 상태는 응답에서만 붙인다. 오늘 상태는 순위보다 자주
    // 바뀌어서 순위 캐시에 넣지 않는다.
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

    // 새 endpoint 면 상한을 넘지 않게 오래된 구독을 지우고 받는다. 거절하면 안 된다
    // (db.js makeRoomForSubscription 참고). 기존 구독 갱신은 그냥 저장.
    if (!(await getSubscription(env.DB, endpoint))) {
      const evicted = await makeRoomForSubscription(env.DB, MAX_SUBSCRIPTIONS);
      // endpoint 는 끝 12자만 로그에 남긴다.
      if (evicted.length > 0) {
        console.log('evicted for new subscription', evicted.map((e) => e.slice(-12)).join(','));
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

    // 없는 구독이어도 성공으로 답한다. 있는지 없는지 알려 줄 필요 없음.
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

    // 아는 키의 boolean 값만 받는다.
    const patch = {};
    for (const name of Object.keys(SETTING_COLUMN)) {
      if (typeof req.body[name] === 'boolean') patch[name] = req.body[name];
    }
    if (Object.keys(patch).length === 0) {
      return json({ error: '변경할 항목이 없습니다.' }, 400);
    }

    await updateSettings(env.DB, req.endpoint, patch);
    return json({ ok: true, settings: await getSettings(env.DB, req.endpoint) });
  }

  /*
   * ── 배달 확인 ──
   * sw.js 가 알림을 띄운 뒤 부른다. 이게 없으면 기기에 안 뜬 알림을 알 수 없다.
   * 아무나 표시하지 못하게 등록된 구독만 받는다.
   */
  if (path === '/api/delivered' && method === 'POST') {
    const req = await requireSubscription(request, env);
    if (req.error) return req.error;

    const id = req.body.id;
    if (!Number.isInteger(id) || id <= 0) {
      return json({ error: '이벤트 id 가 필요합니다.' }, 400);
    }

    await markDelivered(env.DB, id);
    return json({ ok: true });
  }

  /* ── 테스트 알림 ── */

  if (path === '/api/test' && method === 'POST') {
    const req = await requireSubscription(request, env);
    if (req.error) return req.error;

    // 연타 방지.
    const last = req.sub.last_test_at ? Date.parse(req.sub.last_test_at) : 0;
    const waited = (Date.now() - last) / 1000;
    if (waited < TEST_COOLDOWN_SEC) {
      return json({ error: `${Math.ceil(TEST_COOLDOWN_SEC - waited)}초 후에 다시 시도해 주세요.` }, 429);
    }

    await touchTestSent(env.DB, req.endpoint);

    // 설정 점검용이라 여기서만 에러 메시지를 그대로 돌려준다(VAPID 키 오류 등).
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
  // 외부 API 를 부르니까 공개하지 않는다. ADMIN_TOKEN 필요.

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

  /** 이번 시즌이 아닌 경기 기록 삭제. */
  if (path === '/api/admin/prune' && method === 'POST') {
    if (!isAdmin(request, env)) return json({ error: '권한이 없습니다.' }, 401);

    const { year } = kstNow();
    return json({ ok: true, season: year, deleted: await pruneOtherSeasons(env.DB, year) });
  }

  return json({ error: 'Not found' }, 404);
}

/* ============================ 정적 파일 ============================ */

// 정적 파일 보안 헤더(CSP 등)는 public/_headers 에 있다.

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(request, env, url);
      } catch (err) {
        // 내부 에러 내용은 응답에 넣지 않고 로그로만 남긴다.
        console.error('api error', url.pathname, err);
        return json({ error: '서버 오류가 발생했습니다.' }, 500);
      }
    }

    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        // 틱마다 결과 한 줄. 이게 없으면 "건너뛰는 중"과 "크론이 안 도는 중"을
        // 로그로 구분할 수 없다(2026-09 알림 끊겼을 때 이것 때문에 늦게 찾음).
        const result = await tick(env).catch((err) => {
          console.error('tick failed', err);
          return { error: err.message };
        });
        console.log('tick', JSON.stringify(result));
      })(),
    );
  },
};

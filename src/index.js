/**
 * Worker 진입점.
 *  - scheduled(): 1분마다 경기 상태를 확인하고 변화가 있으면 푸시를 보낸다.
 *  - fetch():     PWA 정적 파일 + /api/* 엔드포인트
 */

import { fetchGames, filterTeam, kstNow, kstDateOffset } from './kbo.js';
import { detectEvents, KINDS } from './detect.js';
import { sendPush } from './push.js';
import {
  loadStates,
  upsertStateStmt,
  insertEvent,
  listHistory,
  saveSubscription,
  deleteSubscription,
  getSettings,
  updateSettings,
  subscribersFor,
} from './db.js';

/** KBO 경기는 이 시간대(KST) 밖에서 상태가 바뀌지 않는다. 나머지 시간의 크론은 즉시 반환한다. */
const ACTIVE_HOUR_START = 12;
const ACTIVE_HOUR_END = 23; // 23시대까지 포함(연장전 대비)

/* ============================ 크론: 상태 감시 ============================ */

async function poll(env) {
  const kst = kstNow();

  // 자정 직후 시작한 경기가 전날 날짜로 잡히는 경우가 있어 어제~오늘을 함께 본다.
  const games = filterTeam(
    await fetchGames(kstDateOffset(-1), kst.date),
    env.TEAM_CODE,
  );
  if (games.length === 0) return { checked: 0, fired: 0 };

  const prevStates = await loadStates(env.DB, games.map((g) => g.gameId));

  const writes = [];
  const pending = [];

  for (const game of games) {
    const prev = prevStates.get(game.gameId) ?? null;

    // 스냅샷은 이벤트 발생 여부와 무관하게 항상 최신으로 맞춘다.
    writes.push(upsertStateStmt(env.DB, game));

    for (const ev of detectEvents(prev, game, env.TEAM_CODE)) {
      pending.push({ game, ev });
    }
  }

  if (writes.length > 0) await env.DB.batch(writes);

  let fired = 0;
  for (const { game, ev } of pending) {
    // dedup_key 충돌이면 이미 발송한 이벤트이므로 건너뛴다.
    const isNew = await insertEvent(env.DB, game, ev);
    if (!isNew) continue;

    await broadcast(env, ev);
    fired++;
  }

  return { checked: games.length, fired };
}

/** 해당 종류를 켜 둔 구독자 전원에게 발송하고, 폐기된 구독은 정리한다. */
async function broadcast(env, ev) {
  const subs = await subscribersFor(env.DB, ev.kind);
  if (subs.length === 0) return;

  const payload = { kind: ev.kind, title: ev.title, body: ev.body, ts: Date.now() };

  const results = await Promise.allSettled(
    subs.map((s) => sendPush(s, payload, env)),
  );

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'rejected') {
      console.error('push failed', subs[i].endpoint, r.reason?.message);
    } else if (r.value.gone) {
      await deleteSubscription(env.DB, subs[i].endpoint);
    } else if (!r.value.ok) {
      console.error('push rejected', subs[i].endpoint, r.value.status);
    }
  }
}

/* ============================ HTTP API ============================ */

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });

async function handleApi(request, env, url) {
  const path = url.pathname;

  // 클라이언트가 구독 생성 시 필요한 VAPID 공개키
  if (path === '/api/config' && request.method === 'GET') {
    return json({ vapidPublicKey: env.VAPID_PUBLIC_KEY, teamCode: env.TEAM_CODE });
  }

  if (path === '/api/history' && request.method === 'GET') {
    const days = Math.min(Number(url.searchParams.get('days')) || 30, 120);
    return json({ games: await listHistory(env.DB, { limitDays: days }) });
  }

  if (path === '/api/subscribe' && request.method === 'POST') {
    const body = await request.json().catch(() => null);
    const endpoint = body?.endpoint;
    const p256dh = body?.keys?.p256dh;
    const auth = body?.keys?.auth;

    if (!endpoint || !p256dh || !auth) {
      return json({ error: 'endpoint, keys.p256dh, keys.auth 가 모두 필요합니다.' }, 400);
    }

    await saveSubscription(env.DB, { endpoint, p256dh, auth });
    return json({ ok: true, settings: await getSettings(env.DB, endpoint) });
  }

  if (path === '/api/unsubscribe' && request.method === 'POST') {
    const body = await request.json().catch(() => null);
    if (!body?.endpoint) return json({ error: 'endpoint 가 필요합니다.' }, 400);

    await deleteSubscription(env.DB, body.endpoint);
    return json({ ok: true });
  }

  if (path === '/api/settings') {
    if (request.method === 'GET') {
      const endpoint = url.searchParams.get('endpoint');
      if (!endpoint) return json({ error: 'endpoint 가 필요합니다.' }, 400);

      const settings = await getSettings(env.DB, endpoint);
      return settings ? json({ settings }) : json({ error: '등록되지 않은 구독입니다.' }, 404);
    }

    if (request.method === 'POST') {
      const body = await request.json().catch(() => null);
      if (!body?.endpoint) return json({ error: 'endpoint 가 필요합니다.' }, 400);

      const patch = {};
      for (const kind of KINDS) {
        if (typeof body[kind] === 'boolean') patch[kind] = body[kind];
      }

      const updated = await updateSettings(env.DB, body.endpoint, patch);
      if (!updated) return json({ error: '등록되지 않은 구독이거나 변경할 항목이 없습니다.' }, 404);

      return json({ ok: true, settings: await getSettings(env.DB, body.endpoint) });
    }
  }

  // 설정이 제대로 됐는지 확인용. 자기 자신에게 테스트 알림을 한 번 보낸다.
  if (path === '/api/test' && request.method === 'POST') {
    const body = await request.json().catch(() => null);
    if (!body?.endpoint) return json({ error: 'endpoint 가 필요합니다.' }, 400);

    const sub = await env.DB.prepare(
      'SELECT endpoint, p256dh, auth FROM subscriptions WHERE endpoint = ?',
    )
      .bind(body.endpoint)
      .first();
    if (!sub) return json({ error: '등록되지 않은 구독입니다.' }, 404);

    const res = await sendPush(
      sub,
      { kind: 'test', title: '테스트 알림', body: '알림이 정상 동작합니다.', ts: Date.now() },
      env,
    );
    return json({ ok: res.ok, status: res.status });
  }

  // 크론을 기다리지 않고 즉시 한 번 폴링한다. 배포 직후 동작 확인용.
  if (path === '/api/poll' && request.method === 'POST') {
    return json(await poll(env));
  }

  return json({ error: 'Not found' }, 404);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(request, env, url);
      } catch (err) {
        console.error('api error', err);
        return json({ error: err.message }, 500);
      }
    }

    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    const { hour } = kstNow();
    if (hour < ACTIVE_HOUR_START || hour > ACTIVE_HOUR_END) return;

    ctx.waitUntil(
      poll(env).catch((err) => {
        console.error('poll failed', err);
      }),
    );
  },
};

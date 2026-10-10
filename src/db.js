/** D1 접근은 전부 여기서 한다. 다른 파일에는 SQL 을 두지 않는다. */

import { KIND_COLUMN, SCOPE_COLUMN, dispatchKindOf } from './detect.js';
import { perspective, scopeOf } from './kbo.js';

const nowIso = () => new Date().toISOString();

/* ─────────────── 캐시 ─────────────── */

/** 캐시 값. 없거나, allowExpired 가 아닌데 만료됐으면 null. */
async function readCache(db, key, allowExpired) {
  const row = await db
    .prepare('SELECT value, expires_at FROM cache WHERE key = ?')
    .bind(key)
    .first();

  if (!row) return null;
  if (!allowExpired && Date.parse(row.expires_at) <= Date.now()) return null;

  try {
    return JSON.parse(row.value);
  } catch {
    return null; // 값이 깨졌으면 없는 걸로 친다.
  }
}

export const getCache = (db, key) => readCache(db, key, false);

/**
 * 만료와 상관없이 저장된 값을 읽는다.
 *
 * 외부 조회가 실패했을 때 마지막 정상값을 쓰려는 용도. putCache·expireCache 는
 * 행을 지우지 않아서 만료된 값도 남아 있다.
 * 조회 실패 catch 안에서만 쓴다.
 */
export const getCacheStale = (db, key) => readCache(db, key, true);

/**
 * 오래된 날짜별 캐시(plan:·today:)를 지운다.
 *
 * 하루에 하나씩 늘어나는 키는 이 둘뿐이다. 연도별 키(opener:·schedule:·standings:)는
 * 늘지 않고 getCacheStale 폴백에 쓰이니 건드리지 않는다.
 *
 * 키가 `접두사:YYYY-MM-DD` 라 문자열 범위 비교로 고를 수 있다(기본 키 인덱스 사용).
 *
 * @param {string} olderThan 이 날짜(YYYY-MM-DD) 이전 것을 지운다. 해당일은 남는다.
 */
export async function pruneDatedCache(db, olderThan) {
  const range = (prefix) =>
    db
      .prepare('DELETE FROM cache WHERE key >= ? AND key < ?')
      .bind(`${prefix}:`, `${prefix}:${olderThan}`);

  await db.batch([range('plan'), range('today')]);
}

/**
 * 값은 두고 만료만 시킨다. 다음 getCache 는 미스라 새로 조회하고, 그 조회가
 * 실패하면 getCacheStale 로 이 값을 쓸 수 있다.
 * (null 로 덮어쓰면 경기 종료 직후 네이버 장애 때 폴백할 값이 없어진다)
 */
export async function expireCache(db, key) {
  await db.prepare('UPDATE cache SET expires_at = ? WHERE key = ?').bind(nowIso(), key).run();
}

export async function putCache(db, key, value, ttlMs) {
  const expires = new Date(Date.now() + ttlMs).toISOString();
  await db
    .prepare(
      `INSERT INTO cache (key, value, expires_at, updated_at) VALUES (?,?,?,?)
       ON CONFLICT(key) DO UPDATE SET
         value=excluded.value, expires_at=excluded.expires_at, updated_at=excluded.updated_at`,
    )
    .bind(key, JSON.stringify(value ?? null), expires, nowIso())
    .run();
}

/* ─────────────── 경기 스냅샷 ─────────────── */

/** gameId 들의 직전 스냅샷. Map<gameId, snapshot> */
export async function loadStates(db, gameIds) {
  if (gameIds.length === 0) return new Map();

  const placeholders = gameIds.map(() => '?').join(',');
  const { results } = await db
    .prepare(`SELECT * FROM game_state WHERE game_id IN (${placeholders})`)
    .bind(...gameIds)
    .all();

  return new Map(
    (results ?? []).map((r) => {
      // 지난 틱까지의 홈런 기록 목록. 컬럼을 따로 두지 않고 scoreboard JSON 에
      // 같이 저장한다. 예전에 hr 을 숫자로 저장한 행이 있어서 배열일 때만 쓴다.
      let hr = [];
      try {
        const parsed = JSON.parse(r.scoreboard)?.hr;
        if (Array.isArray(parsed)) hr = parsed;
      } catch {
        /* 전광판이 없거나(경기 전) 깨졌으면 빈 목록 */
      }

      return [
        r.game_id,
        {
          gameId: r.game_id,
          homeCode: r.home_code,
          awayCode: r.away_code,
          homeScore: r.home_score,
          awayScore: r.away_score,
          phase: r.phase,
          series: r.series,
          cancelled: Boolean(r.cancelled),
          suspended: Boolean(r.suspended),
          hr,
        },
      ];
    }),
  );
}

/**
 * 스냅샷을 현재 상태로 덮어쓴다.
 * @param {string|null} scoreboardJson 전광판 JSON. 이번 틱에 못 받았으면 null 을
 *   넘기고, 그러면 COALESCE 로 기존 값을 유지한다(조회 한 번 실패로 비워지지 않게).
 */
export function upsertStateStmt(db, g, scoreboardJson = null) {
  return db
    .prepare(
      `INSERT INTO game_state
         (game_id, game_date, start_at, stadium, home_code, home_name, away_code, away_name,
          home_score, away_score, phase, series, status_code, status_info, cancelled, suspended,
          scoreboard, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(game_id) DO UPDATE SET
         home_score=excluded.home_score,
         away_score=excluded.away_score,
         phase=excluded.phase,
         series=excluded.series,
         status_code=excluded.status_code,
         status_info=excluded.status_info,
         cancelled=excluded.cancelled,
         suspended=excluded.suspended,
         start_at=excluded.start_at,
         stadium=excluded.stadium,
         scoreboard=COALESCE(excluded.scoreboard, game_state.scoreboard),
         updated_at=excluded.updated_at`,
    )
    .bind(
      g.gameId, g.gameDate, g.startAt, g.stadium,
      g.homeCode, g.homeName, g.awayCode, g.awayName,
      g.homeScore, g.awayScore, g.phase, g.series,
      g.statusCode, g.statusInfo,
      g.cancelled ? 1 : 0, g.suspended ? 1 : 0,
      scoreboardJson,
      nowIso(),
    );
}

/**
 * 이번 틱에 받은 원본 상태 기록(디버깅용). 네이버가 상태를 언제 바꿨는지,
 * 폴링이 제대로 돌았는지 D1 콘솔에서 확인할 때 본다.
 */
export function insertPollLogStmt(db, g) {
  return db
    .prepare(
      `INSERT INTO poll_log (game_id, status_code, status_info, home_score, away_score, created_at)
       VALUES (?,?,?,?,?,?)`,
    )
    .bind(g.gameId, g.statusCode, g.statusInfo, g.homeScore, g.awayScore, nowIso());
}

/** olderThanIso 보다 오래된 poll_log 를 지운다(보관 기간은 season.js). */
export async function prunePollLog(db, olderThanIso) {
  await db.prepare('DELETE FROM poll_log WHERE created_at < ?').bind(olderThanIso).run();
}

/* ─────────────── 이벤트 ─────────────── */

/**
 * 경기들이 전부 끝났고(end 또는 cancel), 마지막 종료가 cutoff 이전인지.
 * 경기 후 폴링을 멈출지 판단할 때 쓴다.
 *
 * 종료 시각은 events.created_at 을 쓴다. game_state.updated_at 은 매 틱 바뀌어서
 * 종료 시각으로 못 쓴다.
 *
 * @param {string[]} gameIds 지금 감시 중인 경기들
 * @param {string} cutoffIso 이 시각 이전에 마무리됐으면 멈춰도 되는 기준선
 */
export async function allSettledBefore(db, gameIds, cutoffIso) {
  if (gameIds.length === 0) return true;

  const marks = gameIds.map(() => '?').join(',');
  const row = await db
    .prepare(
      `SELECT COUNT(DISTINCT game_id) AS done, MAX(created_at) AS last_at
         FROM events
        WHERE kind IN ('end','cancel') AND game_id IN (${marks})`,
    )
    .bind(...gameIds)
    .first();

  // UTC ISO 문자열이라 문자열 비교로 시각을 비교할 수 있다.
  return row?.done === gameIds.length && row.last_at != null && row.last_at < cutoffIso;
}

/**
 * 이벤트 저장. dedup_key 가 UNIQUE 라 같은 이벤트는 한 번만 들어간다.
 *
 * kind 컬럼에는 기록용 ev.recordKind 를 넣는다(기록 탭 라벨·아이콘용).
 * 실점만 kind=score / recordKind=concede 로 다르다(detect.js push 참고).
 *
 * @returns {Promise<number|null>} 새로 들어갔으면 행 id, 이미 있었으면 null
 */
export async function insertEvent(db, game, ev) {
  const res = await db
    .prepare(
      `INSERT OR IGNORE INTO events
         (game_id, game_date, kind, series, dedup_key, title, body, home_score, away_score, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
    .bind(
      game.gameId, game.gameDate, ev.recordKind ?? ev.kind, ev.series, ev.dedupKey,
      ev.title, ev.body, game.homeScore, game.awayScore, nowIso(),
    )
    .run();

  // OR IGNORE 로 건너뛰면 last_row_id 에 이전 값이 남아 있을 수 있어서
  // changes 를 먼저 본다. 호출부는 null 여부로 발송할지 정하고, id 는 푸시에
  // 실어 sw.js 배달 확인에 쓴다.
  if ((res.meta?.changes ?? 0) === 0) return null;
  return res.meta.last_row_id;
}

/**
 * 배달 확인이 안 온 이벤트(재발송 대상).
 *
 *   olderThan  막 보낸 건 뺀다. 확인이 늦게 오기도 해서(2026-09-02, 2분 53초)
 *              너무 빨리 고르면 이미 받은 알림을 또 보낸다.
 *   newerThan  너무 오래된 건 포기한다. 경기 끝나고 한참 뒤에 뜨면 헷갈리기만 한다.
 *
 * 재발송은 이벤트당 한 번이라 resent_at 이 빈 것만 고른다.
 * isHome(홈경기만 받기 필터용)은 game_state 에만 있어서 join 한다.
 * created_at 은 재발송 알림에 원래 감지 시각을 찍으려고 가져온다.
 */
export async function listUndelivered(db, teamCode, { olderThan, newerThan }) {
  const { results } = await db
    .prepare(
      `SELECT e.id, e.kind, e.series, e.title, e.body, e.game_id, e.created_at, g.home_code
         FROM events e
         JOIN game_state g ON g.game_id = e.game_id
        WHERE e.delivered_at IS NULL
          AND e.resent_at IS NULL
          AND e.created_at <= ?
          AND e.created_at >= ?
        ORDER BY e.id`,
    )
    .bind(olderThan, newerThan)
    .all();

  // detectEvents 결과와 같은 형태로 맞춘다. events.kind 는 기록용 값이라
  // 발송 종류로 바꾸고(concede → score) scope 를 채운다.
  return (results ?? []).map((r) => ({
    id: r.id,
    kind: dispatchKindOf(r.kind),
    scope: scopeOf(r.series),
    series: r.series,
    title: r.title,
    body: r.body,
    gameId: r.game_id,
    createdAt: r.created_at,
    isHome: r.home_code === teamCode,
  }));
}

/** 재발송 표시. 표시된 이벤트는 다시 고르지 않는다. */
export async function markResent(db, eventId) {
  await db
    .prepare(`UPDATE events SET resent_at = ? WHERE id = ?`)
    .bind(nowIso(), eventId)
    .run();
}

/**
 * 단말이 알림을 띄웠다고 알려온 시각을 저장한다.
 * 첫 번째 확인만 남긴다. 구독이 여러 개여도 한 기기라도 띄웠는지만 본다.
 *
 * @returns {Promise<boolean>} 이번에 채웠으면 true, 이미 있었거나 id 가 없으면 false
 */
export async function markDelivered(db, eventId) {
  const res = await db
    .prepare(`UPDATE events SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL`)
    .bind(nowIso(), eventId)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

/**
 * 최근 경기와 경기별 이벤트, 날짜 내림차순.
 * 이번 시즌만 준다(gameId 끝 4자리 = 시즌 연도로 SQL 에서 거름).
 */
export async function listHistory(db, { limitDays = 30, seasonYear, teamCode } = {}) {
  const season = String(seasonYear);
  const seasonFilter = `substr(game_id, -4) = ?`;

  const dateFilter = `game_date IN (
    SELECT DISTINCT game_date FROM game_state WHERE ${seasonFilter}
    ORDER BY game_date DESC LIMIT ?
  )`;

  const games = await db
    .prepare(
      `SELECT * FROM game_state
       WHERE ${seasonFilter} AND ${dateFilter}
       ORDER BY game_date DESC, start_at DESC`,
    )
    .bind(season, season, limitDays)
    .all();

  const events = await db
    .prepare(
      `SELECT game_id, kind, series, title, body, created_at, delivered_at FROM events
       WHERE ${seasonFilter} AND ${dateFilter} ORDER BY id ASC`,
    )
    .bind(season, season, limitDays)
    .all();

  const byGame = new Map();
  for (const e of events.results ?? []) {
    if (!byGame.has(e.game_id)) byGame.set(e.game_id, []);
    byGame.get(e.game_id).push({
      kind: e.kind,
      title: e.title,
      body: e.body,
      createdAt: e.created_at,
      // 단말이 알림을 띄운 시각. created_at 과의 차이가 배달 지연이고 null 이면
      // 미배달. 서버 로그로는 FCM 이 받은 것까지만 알 수 있어서 응답에 싣는다
      // (diagnose.yml 이 읽는다).
      deliveredAt: e.delivered_at,
    });
  }

  return (games.results ?? []).map((r) => {
    // /api/schedule 과 같이 우리 팀 기준 값(isHome, teamScore...)으로 내려 준다.
    const p = perspective(
      { homeCode: r.home_code, awayCode: r.away_code, homeName: r.home_name,
        awayName: r.away_name, homeScore: r.home_score, awayScore: r.away_score },
      teamCode,
    );

    // 전광판도 우리 팀/상대 기준으로 바꾼다. 없으면(경기 전, 조회 실패) null.
    let scoreboard = null;
    if (r.scoreboard) {
      try {
        const raw = JSON.parse(r.scoreboard);
        const teamSide = p.isHome ? raw.home : raw.away;
        const oppSide = p.isHome ? raw.away : raw.home;
        scoreboard = { team: teamSide, opp: oppSide };
      } catch {
        scoreboard = null; // 값이 깨졌으면 생략.
      }
    }

    return {
      gameId: r.game_id,
      gameDate: r.game_date,
      startAt: r.start_at,
      stadium: r.stadium,
      isHome: p.isHome,
      teamName: p.teamName,
      oppName: p.oppName,
      teamScore: p.teamScore,
      oppScore: p.oppScore,
      phase: r.phase,
      series: r.series,
      statusInfo: r.status_info,
      cancelled: Boolean(r.cancelled),
      scoreboard,
      events: byGame.get(r.game_id) ?? [],
    };
  });
}

/**
 * 이번 시즌이 아닌 경기·이벤트를 지운다(/api/admin/prune).
 * 시즌 필터를 넣기 전에 쌓인 지난 시즌 행을 정리하려고 만들었다.
 */
export async function pruneOtherSeasons(db, seasonYear) {
  const season = String(seasonYear);

  const res = await db.batch([
    db.prepare('DELETE FROM events WHERE substr(game_id, -4) != ?').bind(season),
    db.prepare('DELETE FROM game_state WHERE substr(game_id, -4) != ?').bind(season),
  ]);

  return {
    events: res[0]?.meta?.changes ?? 0,
    games: res[1]?.meta?.changes ?? 0,
  };
}

/* ─────────────── 구독 ─────────────── */

export async function saveSubscription(db, sub) {
  const ts = nowIso();
  await db
    .prepare(
      `INSERT INTO subscriptions (endpoint, p256dh, auth, created_at, updated_at)
       VALUES (?,?,?,?,?)
       ON CONFLICT(endpoint) DO UPDATE SET
         p256dh=excluded.p256dh, auth=excluded.auth, updated_at=excluded.updated_at`,
    )
    .bind(sub.endpoint, sub.p256dh, sub.auth, ts, ts)
    .run();
}

export async function deleteSubscription(db, endpoint) {
  await db.prepare('DELETE FROM subscriptions WHERE endpoint = ?').bind(endpoint).run();
}

/**
 * 새 구독 자리를 만든다. 상한이 찼으면 updated_at 이 가장 오래된 것부터 지운다.
 *
 * 상한에서 등록을 거절하면 안 된다. 엔드포인트가 만료되면 410 으로 행이 지워지고
 * (index.js broadcast) 앱이 다시 등록하는데(app.js), 그걸 막으면 그 기기는 계속
 * 알림을 못 받는다(2026-09 실제로 겪음). 가장 오래된 행은 대개 이미 죽은 엔드포인트다.
 *
 * 상한을 넘겨 쌓여 있는 경우도 있어서 한 번에 상한 밑으로 줄인다.
 *
 * @returns {Promise<string[]>} 지운 endpoint 목록. 지울 필요가 없었으면 빈 배열.
 */
export async function makeRoomForSubscription(db, max) {
  const { results } = await db
    .prepare(
      `DELETE FROM subscriptions
         WHERE endpoint IN (
           SELECT endpoint FROM subscriptions
            ORDER BY updated_at ASC
            LIMIT MAX(0, (SELECT COUNT(*) FROM subscriptions) - ? + 1)
         )
       RETURNING endpoint`,
    )
    .bind(max)
    .all();
  return (results ?? []).map((r) => r.endpoint);
}

export async function getSubscription(db, endpoint) {
  return db
    .prepare('SELECT endpoint, p256dh, auth, last_test_at FROM subscriptions WHERE endpoint = ?')
    .bind(endpoint)
    .first();
}

export async function getSettings(db, endpoint) {
  const row = await db
    .prepare(
      `SELECT on_start, on_cancel, on_score, on_end, on_regular, on_postseason, home_only
       FROM subscriptions WHERE endpoint = ?`,
    )
    .bind(endpoint)
    .first();

  if (!row) return null;
  return {
    start: Boolean(row.on_start),
    cancel: Boolean(row.on_cancel),
    score: Boolean(row.on_score),
    end: Boolean(row.on_end),
    regular: Boolean(row.on_regular),
    postseason: Boolean(row.on_postseason),
    homeOnly: Boolean(row.home_only),
  };
}

/**
 * settings 에 들어 있는 항목만 갱신한다.
 * 컬럼명은 아래 고정 목록에서만 나오므로 입력값이 SQL 식별자로 들어갈 일은 없다.
 */
export async function updateSettings(db, endpoint, settings) {
  const columns = { ...KIND_COLUMN, ...SCOPE_COLUMN, homeOnly: 'home_only' };
  const sets = [];
  const values = [];

  for (const [name, column] of Object.entries(columns)) {
    if (name in settings) {
      sets.push(`${column} = ?`);
      values.push(settings[name] ? 1 : 0);
    }
  }
  if (sets.length === 0) return false;

  sets.push('updated_at = ?');
  values.push(nowIso(), endpoint);

  const res = await db
    .prepare(`UPDATE subscriptions SET ${sets.join(', ')} WHERE endpoint = ?`)
    .bind(...values)
    .run();

  return (res.meta?.changes ?? 0) > 0;
}

export async function touchTestSent(db, endpoint) {
  await db
    .prepare('UPDATE subscriptions SET last_test_at = ? WHERE endpoint = ?')
    .bind(nowIso(), endpoint)
    .run();
}

/**
 * 이 이벤트를 받을 구독 목록.
 *   1. 알림 종류가 켜져 있고
 *   2. 시리즈 범위(정규/포스트시즌)가 켜져 있고
 *   3. "홈경기만 받기"면 홈경기일 것
 *
 * 컬럼명은 KIND_COLUMN / SCOPE_COLUMN 에서만 나온다. 모르는 kind·scope 면 빈 배열.
 */
export async function subscribersFor(db, kind, scope, isHome) {
  const kindColumn = KIND_COLUMN[kind];
  const scopeColumn = SCOPE_COLUMN[scope];
  if (!kindColumn || !scopeColumn) return [];

  // 원정 경기면 home_only 구독은 뺀다.
  const homeClause = isHome ? '' : ' AND home_only = 0';

  const { results } = await db
    .prepare(
      `SELECT endpoint, p256dh, auth FROM subscriptions
       WHERE ${kindColumn} = 1 AND ${scopeColumn} = 1${homeClause}`,
    )
    .all();

  return results ?? [];
}

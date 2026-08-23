/** D1 접근을 한곳에 모은다. 나머지 코드는 SQL 을 직접 쓰지 않는다. */

import { KIND_COLUMN, SCOPE_COLUMN } from './detect.js';
import { isPostseason } from './kbo.js';

const nowIso = () => new Date().toISOString();

/* ─────────────── 캐시 ─────────────── */

/** 만료되지 않은 캐시 값을 돌려준다. 없거나 만료됐으면 null. */
export async function getCache(db, key) {
  const row = await db
    .prepare('SELECT value, expires_at FROM cache WHERE key = ?')
    .bind(key)
    .first();

  if (!row) return null;
  if (Date.parse(row.expires_at) <= Date.now()) return null;

  try {
    return JSON.parse(row.value);
  } catch {
    return null; // 저장된 값이 깨졌으면 캐시 미스로 취급한다.
  }
}

/** ttlMs 가 0 이하이면 즉시 만료된 값으로 넣어 사실상 무효화한다. */
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

/** 주어진 gameId 들의 직전 스냅샷을 Map<gameId, snapshot> 으로 반환한다. */
export async function loadStates(db, gameIds) {
  if (gameIds.length === 0) return new Map();

  const placeholders = gameIds.map(() => '?').join(',');
  const { results } = await db
    .prepare(`SELECT * FROM game_state WHERE game_id IN (${placeholders})`)
    .bind(...gameIds)
    .all();

  return new Map(
    (results ?? []).map((r) => [
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
      },
    ]),
  );
}

/** 현재 상태로 스냅샷을 덮어쓴다. */
export function upsertStateStmt(db, g) {
  return db
    .prepare(
      `INSERT INTO game_state
         (game_id, game_date, start_at, stadium, home_code, home_name, away_code, away_name,
          home_score, away_score, phase, series, status_code, status_info, cancelled, suspended, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
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
         updated_at=excluded.updated_at`,
    )
    .bind(
      g.gameId, g.gameDate, g.startAt, g.stadium,
      g.homeCode, g.homeName, g.awayCode, g.awayName,
      g.homeScore, g.awayScore, g.phase, g.series,
      g.statusCode, g.statusInfo,
      g.cancelled ? 1 : 0, g.suspended ? 1 : 0,
      nowIso(),
    );
}

/* ─────────────── 이벤트 ─────────────── */

/**
 * 이벤트를 기록한다. dedup_key 가 UNIQUE 이므로 같은 전이는 두 번 들어가지 않는다.
 * @returns {Promise<boolean>} 실제로 새로 삽입됐으면 true (= 지금 발송해야 함)
 */
export async function insertEvent(db, game, ev) {
  const res = await db
    .prepare(
      `INSERT OR IGNORE INTO events
         (game_id, game_date, kind, series, dedup_key, title, body, home_score, away_score, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
    .bind(
      game.gameId, game.gameDate, ev.kind, ev.series, ev.dedupKey,
      ev.title, ev.body, game.homeScore, game.awayScore, nowIso(),
    )
    .run();

  return (res.meta?.changes ?? 0) > 0;
}

/** 최근 경기 기록 + 각 경기에 딸린 이벤트를 일자 내림차순으로 반환한다. */
export async function listHistory(db, { limitDays = 30 } = {}) {
  const dateFilter = `game_date IN (
    SELECT DISTINCT game_date FROM game_state ORDER BY game_date DESC LIMIT ?
  )`;

  const games = await db
    .prepare(`SELECT * FROM game_state WHERE ${dateFilter} ORDER BY game_date DESC, start_at DESC`)
    .bind(limitDays)
    .all();

  const events = await db
    .prepare(
      `SELECT game_id, kind, series, title, body, created_at FROM events
       WHERE ${dateFilter} ORDER BY id ASC`,
    )
    .bind(limitDays)
    .all();

  const byGame = new Map();
  for (const e of events.results ?? []) {
    if (!byGame.has(e.game_id)) byGame.set(e.game_id, []);
    byGame.get(e.game_id).push({
      kind: e.kind,
      title: e.title,
      body: e.body,
      createdAt: e.created_at,
    });
  }

  return (games.results ?? []).map((r) => ({
    gameId: r.game_id,
    gameDate: r.game_date,
    startAt: r.start_at,
    stadium: r.stadium,
    homeCode: r.home_code,
    homeName: r.home_name,
    awayCode: r.away_code,
    awayName: r.away_name,
    homeScore: r.home_score,
    awayScore: r.away_score,
    phase: r.phase,
    series: r.series,
    // 시리즈 태그(한국시리즈·준PO 등)를 붙일지 여부를 서버가 명시적으로 정한다.
    // 정규시즌 경기에는 태그가 붙지 않는다.
    isPostseason: isPostseason(r.series),
    statusInfo: r.status_info,
    cancelled: Boolean(r.cancelled),
    events: byGame.get(r.game_id) ?? [],
  }));
}

/* ─────────────── 구독 ─────────────── */

export async function countSubscriptions(db) {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM subscriptions').first();
  return row?.n ?? 0;
}

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
 * 전달된 항목만 갱신한다.
 * 컬럼명은 KIND_COLUMN / SCOPE_COLUMN 화이트리스트에서만 나오므로,
 * 클라이언트 입력이 SQL 식별자로 흘러 들어갈 경로가 없다.
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
 * 이 이벤트를 받을 구독만 가져온다.
 *
 * 세 조건을 모두 만족해야 한다.
 *   1. 해당 알림 종류를 켜 두었을 것
 *   2. 해당 시리즈 범위(정규/포스트시즌)를 켜 두었을 것
 *   3. "홈경기만 받기"를 켰다면 그 경기가 홈경기일 것
 *
 * 컬럼명은 KIND_COLUMN / SCOPE_COLUMN 화이트리스트에서만 나오므로
 * 클라이언트 입력이 SQL 식별자 위치로 흘러갈 경로가 없다.
 */
export async function subscribersFor(db, kind, scope, isHome) {
  const kindColumn = KIND_COLUMN[kind];
  const scopeColumn = SCOPE_COLUMN[scope];
  if (!kindColumn || !scopeColumn) return [];

  // 원정 경기면 home_only 를 켜 둔 구독을 제외한다. 홈경기면 모두 통과.
  const homeClause = isHome ? '' : ' AND home_only = 0';

  const { results } = await db
    .prepare(
      `SELECT endpoint, p256dh, auth FROM subscriptions
       WHERE ${kindColumn} = 1 AND ${scopeColumn} = 1${homeClause}`,
    )
    .all();

  return results ?? [];
}

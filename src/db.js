/** D1 접근을 한곳에 모은다. 나머지 코드는 SQL 을 직접 쓰지 않는다. */

import { KIND_COLUMN } from './detect.js';

const nowIso = () => new Date().toISOString();

/* ---------- 경기 스냅샷 ---------- */

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
          home_score, away_score, phase, status_code, status_info, cancelled, suspended, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(game_id) DO UPDATE SET
         home_score=excluded.home_score,
         away_score=excluded.away_score,
         phase=excluded.phase,
         status_code=excluded.status_code,
         status_info=excluded.status_info,
         cancelled=excluded.cancelled,
         suspended=excluded.suspended,
         start_at=excluded.start_at,
         stadium=excluded.stadium,
         updated_at=excluded.updated_at`,
    )
    .bind(
      g.gameId,
      g.gameDate,
      g.startAt,
      g.stadium,
      g.homeCode,
      g.homeName,
      g.awayCode,
      g.awayName,
      g.homeScore,
      g.awayScore,
      g.phase,
      g.statusCode,
      g.statusInfo,
      g.cancelled ? 1 : 0,
      g.suspended ? 1 : 0,
      nowIso(),
    );
}

/* ---------- 이벤트 ---------- */

/**
 * 이벤트를 기록한다. dedup_key 가 UNIQUE 이므로 같은 전이는 두 번 들어가지 않는다.
 * @returns {Promise<boolean>} 실제로 새로 삽입됐으면 true (= 지금 발송해야 함)
 */
export async function insertEvent(db, game, ev) {
  const res = await db
    .prepare(
      `INSERT OR IGNORE INTO events
         (game_id, game_date, kind, dedup_key, title, body, home_score, away_score, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    )
    .bind(
      game.gameId,
      game.gameDate,
      ev.kind,
      ev.dedupKey,
      ev.title,
      ev.body,
      game.homeScore,
      game.awayScore,
      nowIso(),
    )
    .run();

  return (res.meta?.changes ?? 0) > 0;
}

/** 최근 경기 기록 + 각 경기에 딸린 이벤트를 일자 내림차순으로 반환한다. */
export async function listHistory(db, { limitDays = 30 } = {}) {
  const games = await db
    .prepare(
      `SELECT * FROM game_state
       WHERE game_date IN (
         SELECT DISTINCT game_date FROM game_state ORDER BY game_date DESC LIMIT ?
       )
       ORDER BY game_date DESC, start_at DESC`,
    )
    .bind(limitDays)
    .all();

  const events = await db
    .prepare(
      `SELECT game_id, kind, title, body, created_at FROM events
       WHERE game_date IN (
         SELECT DISTINCT game_date FROM game_state ORDER BY game_date DESC LIMIT ?
       )
       ORDER BY id ASC`,
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
    statusInfo: r.status_info,
    cancelled: Boolean(r.cancelled),
    events: byGame.get(r.game_id) ?? [],
  }));
}

/* ---------- 구독 ---------- */

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

export async function getSettings(db, endpoint) {
  const row = await db
    .prepare('SELECT on_start, on_cancel, on_score, on_end FROM subscriptions WHERE endpoint = ?')
    .bind(endpoint)
    .first();

  if (!row) return null;
  return {
    start: Boolean(row.on_start),
    cancel: Boolean(row.on_cancel),
    score: Boolean(row.on_score),
    end: Boolean(row.on_end),
  };
}

/** 전달된 종류만 갱신한다. 알 수 없는 키는 무시해 SQL 주입 여지를 없앤다. */
export async function updateSettings(db, endpoint, settings) {
  const sets = [];
  const values = [];

  for (const [kind, column] of Object.entries(KIND_COLUMN)) {
    if (kind in settings) {
      sets.push(`${column} = ?`);
      values.push(settings[kind] ? 1 : 0);
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

/** 해당 종류의 알림을 켜 둔 구독만 가져온다. */
export async function subscribersFor(db, kind) {
  const column = KIND_COLUMN[kind];
  if (!column) return [];

  const { results } = await db
    .prepare(`SELECT endpoint, p256dh, auth FROM subscriptions WHERE ${column} = 1`)
    .all();

  return results ?? [];
}

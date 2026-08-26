/** D1 접근을 한곳에 모은다. 나머지 코드는 SQL 을 직접 쓰지 않는다. */

import { KIND_COLUMN, SCOPE_COLUMN } from './detect.js';
import { isPostseason, perspective } from './kbo.js';

const nowIso = () => new Date().toISOString();

/* ─────────────── 캐시 ─────────────── */

/** 만료되지 않은 캐시 값을 돌려준다. 없거나 만료됐으면 null. */
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
    return null; // 저장된 값이 깨졌으면 캐시 미스로 취급한다.
  }
}

export const getCache = (db, key) => readCache(db, key, false);

/**
 * 만료 여부를 무시하고 저장된 값을 읽는다.
 *
 * 외부 API 조회가 실패했을 때 "마지막으로 확인됐던 값"으로 되돌아가기 위한 것이다.
 * putCache 는 행을 지우지 않고 덮어쓰기만 하므로, 만료된 값도 테이블에 그대로
 * 남아 있다 — 이 함수는 그것을 꺼내 쓴다.
 *
 * 평상시 경로에서는 절대 쓰지 않는다. 실패한 catch 안에서만 부른다.
 */
export const getCacheStale = (db, key) => readCache(db, key, true);

/**
 * 날짜별 캐시(plan:·today:) 중 오래된 것을 지운다.
 *
 * 이 두 키만 하루 한 개씩 늘어난다. 지난 날짜의 값은 다시 읽히지 않으므로
 * 남겨 둘 이유가 없다. 반면 연도별 키(opener:·schedule:·standings:)는
 * 개수가 늘지 않고, 만료된 값이 곧 getCacheStale 의 폴백 재료이므로 건드리지 않는다.
 *
 * 키가 `접두사:YYYY-MM-DD` 라 사전순과 날짜순이 같다. 그래서 범위 비교만으로
 * 고를 수 있고, key 가 기본 키라 인덱스를 그대로 탄다.
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
    (results ?? []).map((r) => {
      // 직전 틱까지 확인된 홈런 기록 문자열 목록. 저장된 전광판 JSON에서
      // 꺼낸다 — 이 값을 위해 새 컬럼을 두지 않고 이미 있는 scoreboard 에
      // 얹었다. Array.isArray 로 거르는 이유: 예전에 hr 을 개수(숫자)로
      // 저장했던 적이 있어(되돌린 이력), 그 시절 값이 아직 남아 있어도
      // 배열이 아니면 빈 목록으로 취급해 조용히 무시한다.
      let hr = [];
      try {
        const parsed = JSON.parse(r.scoreboard)?.hr;
        if (Array.isArray(parsed)) hr = parsed;
      } catch {
        /* 전광판이 없거나(경기 전) 깨졌으면 빈 목록으로 취급 */
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
 * 현재 상태로 스냅샷을 덮어쓴다.
 * @param {string|null} scoreboardJson 이닝별 점수(전광판) JSON 문자열. 이번 틱에
 *   못 가져왔으면 null 을 넘긴다 — COALESCE 로 기존에 저장된 값을 그대로 둔다
 *   (한 번 채워진 전광판이 일시적인 조회 실패로 비워지지 않도록).
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
 * 이번 틱에 받은 원본 상태를 그대로 남긴다. 화면·알림과 무관한 디버깅 전용
 * 로그다 — 네이버가 상태를 실제로 언제 바꿨는지, 우리가 매 분 제대로
 * 폴링했는지를 나중에 D1 콘솔에서 SELECT 로 확인하려는 목적.
 */
export function insertPollLogStmt(db, g) {
  return db
    .prepare(
      `INSERT INTO poll_log (game_id, status_code, status_info, home_score, away_score, created_at)
       VALUES (?,?,?,?,?,?)`,
    )
    .bind(g.gameId, g.statusCode, g.statusInfo, g.homeScore, g.awayScore, nowIso());
}

/** poll_log 는 디버깅용이라 오래 둘 필요 없다 — 며칠 지난 건 지운다. */
export async function prunePollLog(db, olderThanIso) {
  await db.prepare('DELETE FROM poll_log WHERE created_at < ?').bind(olderThanIso).run();
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

/**
 * 최근 경기 기록 + 각 경기에 딸린 이벤트를 일자 내림차순으로 반환한다.
 *
 * 이번 시즌 경기만 돌려준다. gameId 끝 4자리가 시즌 연도이므로 SQL 에서 바로 거른다.
 * 지난 시즌에 쌓인 행이 남아 있어도 화면에 섞이지 않는다.
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
      `SELECT game_id, kind, series, title, body, created_at FROM events
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
    });
  }

  return (games.results ?? []).map((r) => {
    // 홈/원정 관점을 서버에서 한 번만 계산해 내려준다. /api/schedule 이 이미 같은
    // 방식(perspective())으로 isHome/teamScore/oppScore 를 계산해 보내고 있어,
    // 클라이언트가 두 엔드포인트마다 따로 홈/원정을 되짚을 필요가 없어진다.
    const p = perspective(
      { homeCode: r.home_code, awayCode: r.away_code, homeName: r.home_name,
        awayName: r.away_name, homeScore: r.home_score, awayScore: r.away_score },
      teamCode,
    );

    // 전광판도 같은 관점(팀/상대)으로 재배열해 내려준다. 아직 없으면(경기 전,
    // 혹은 조회 실패가 이어진 경우) null — 클라이언트가 있는지 없는지로만 판단한다.
    let scoreboard = null;
    if (r.scoreboard) {
      try {
        const raw = JSON.parse(r.scoreboard);
        const teamSide = p.isHome ? raw.home : raw.away;
        const oppSide = p.isHome ? raw.away : raw.home;
        scoreboard = { team: teamSide, opp: oppSide };
      } catch {
        scoreboard = null; // 저장된 값이 깨졌으면 조용히 생략한다.
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
      // 시리즈 태그(한국시리즈·준PO 등)를 붙일지 여부를 서버가 명시적으로 정한다.
      // 정규시즌 경기에는 태그가 붙지 않는다.
      isPostseason: isPostseason(r.series),
      statusInfo: r.status_info,
      cancelled: Boolean(r.cancelled),
      scoreboard,
      events: byGame.get(r.game_id) ?? [],
    };
  });
}

/**
 * 이번 시즌이 아닌 경기 기록을 지운다.
 *
 * 필터를 넣기 전에 쌓인 시범경기·올스타전·지난 시즌 행을 실제로 걷어내는 용도다.
 * gameId 끝 4자리가 시즌 연도라는 점을 그대로 쓴다.
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

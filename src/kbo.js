/**
 * 네이버 스포츠 KBO API 어댑터.
 *
 * 공식 문서가 없는 비공식 엔드포인트다. 응답 스키마가 예고 없이 바뀔 수 있으므로
 * 이 파일 하나만 고치면 되도록 나머지 코드와의 접점을 좁혀 둔다.
 */

import { josa } from 'es-hangul';

const SCHEDULE_URL = 'https://api-gw.sports.naver.com/schedule/games';
const STANDINGS_URL = 'https://api-gw.sports.naver.com/statistics/categories/kbo/seasons';
const FIELDS = 'basic,superCategoryId,categoryName,stadium,statusNum';

/** 네이버가 봇 트래픽을 막는 경우가 있어 모바일 웹과 동일한 헤더를 보낸다. */
const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  Referer: 'https://m.sports.naver.com/',
  Accept: 'application/json',
};

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/* ─────────────────────────── 시간 ─────────────────────────── */

/** 현재 시각을 KST 기준으로 분해한다. (Workers 런타임은 UTC로 동작) */
export function kstNow(now = new Date()) {
  const k = new Date(now.getTime() + KST_OFFSET_MS);
  return {
    date: k.toISOString().slice(0, 10), // YYYY-MM-DD
    year: k.getUTCFullYear(),
    month: k.getUTCMonth() + 1,
    hour: k.getUTCHours(),
    minute: k.getUTCMinutes(),
    iso: k.toISOString().slice(0, 19), // 오프셋 없는 KST 로컬시각
  };
}

/** KST 기준으로 days 만큼 이동한 날짜 문자열. */
export function kstDateOffset(days, now = new Date()) {
  const k = new Date(now.getTime() + KST_OFFSET_MS + days * 86400000);
  return k.toISOString().slice(0, 10);
}

/** "2026-08-23T18:30:00" (KST 로컬) 을 UTC epoch ms 로 바꾼다. */
export function kstIsoToEpoch(iso) {
  const t = Date.parse(`${iso}+09:00`);
  return Number.isNaN(t) ? null : t;
}

/* ─────────────────────────── 시리즈 ─────────────────────────── */

export const SERIES = {
  exhibition: { label: '시범경기', short: '시범', post: false, order: -2 },
  allstar: { label: '올스타전', short: '올스타', post: false, order: -1 },
  regular: { label: '정규시즌', short: '', post: false, order: 0 },
  tiebreaker: { label: '순위결정전', short: '순위결정전', post: true, order: 1 },
  wildcard: { label: '와일드카드 결정전', short: '와일드카드', post: true, order: 2 },
  semi_playoff: { label: '준플레이오프', short: '준PO', post: true, order: 3 },
  playoff: { label: '플레이오프', short: 'PO', post: true, order: 4 },
  korean_series: { label: '한국시리즈', short: '한국시리즈', post: true, order: 5 },
};

/**
 * gameId 접두 4자리로 시리즈를 판별한다.
 *
 * 네이버는 시리즈를 나타내는 별도 필드를 주지 않는다. 대신 포스트시즌 경기의
 * gameId 는 날짜 대신 고정 접두사로 시작한다. 2023·2024·2025 세 시즌에서
 * 아래 대응이 일치하는 것을 확인했다.
 *
 *   20260823...  정규시즌 또는 시범경기 (경기일 YYYYMMDD)
 *   9999...      올스타전 (팀 코드도 EA/WE 로 나온다)
 *   6666...      순위결정전   (2024년 KT-SSG 5위 결정전에서 관측)
 *   4444...      와일드카드 결정전
 *   3333...      준플레이오프
 *   5555...      플레이오프
 *   7777...      한국시리즈
 *
 * 시범경기는 접두사로 구분되지 않는다. 정규시즌과 형식이 완전히 같아서
 * 개막일 이전인지로 갈라야 한다. (season.js 의 resolveSeasonBounds 참고)
 *
 * 문서화된 규칙이 아니므로, 모르는 접두사는 정규시즌으로 간주해
 * "알림이 아예 안 오는" 최악을 피한다.
 */
export function seriesOf(gameId) {
  const prefix = String(gameId ?? '').slice(0, 4);
  switch (prefix) {
    case '9999': return 'allstar';
    case '6666': return 'tiebreaker';
    case '4444': return 'wildcard';
    case '3333': return 'semi_playoff';
    case '5555': return 'playoff';
    case '7777': return 'korean_series';
    default: return 'regular';
  }
}

export const isPostseason = (series) => SERIES[series]?.post === true;

/**
 * gameId 끝 4자리는 시즌 연도다. (`20260822SSNC0` + `2026`)
 * 포스트시즌 경기도 같은 규칙을 따른다: `77771026HHLG0` + `2025`.
 * 이 값으로 "올해 경기"를 가려낸다 — 경기 날짜가 아니라 시즌 기준이어야
 * 11월에 열리는 한국시리즈가 그해 시즌으로 묶인다.
 */
export function seasonYearOf(gameId) {
  const tail = String(gameId ?? '').slice(-4);
  return /^\d{4}$/.test(tail) ? Number(tail) : null;
}

/** 정규 KBO 10개 구단 코드. 올스타전은 EA(이스턴)·WE(웨스턴)으로 나온다. */
export const TEAM_CODES = new Set(['HT', 'SS', 'LG', 'OB', 'KT', 'SK', 'LT', 'NC', 'WO', 'HH']);

/* ─────────────────────────── 일정 ─────────────────────────── */

/**
 * 네이버 원본 경기 객체를 내부 표현으로 변환한다.
 *
 * phase 판정: 관측으로 확인된 값은 BEFORE(경기 전)와 RESULT(종료)뿐이다.
 * 경기 중 상태값은 문서화돼 있지 않으므로 "둘 중 어느 쪽도 아니면 진행 중"으로 본다.
 * 원본 statusCode 를 그대로 저장해 두어 나중에 추적할 수 있게 한다.
 */
export function normalizeGame(g) {
  const status = String(g.statusCode || '').toUpperCase();
  let phase;
  if (status === 'RESULT') phase = 'result';
  else if (status === 'BEFORE') phase = 'before';
  else phase = 'live';

  return {
    gameId: g.gameId,
    gameDate: g.gameDate,
    startAt: g.gameDateTime,
    stadium: g.stadium ?? null,
    homeCode: g.homeTeamCode,
    homeName: g.homeTeamName,
    awayCode: g.awayTeamCode,
    awayName: g.awayTeamName,
    homeScore: Number(g.homeTeamScore ?? 0),
    awayScore: Number(g.awayTeamScore ?? 0),
    phase,
    series: seriesOf(g.gameId),
    statusCode: status,
    statusInfo: g.statusInfo ?? null,
    cancelled: Boolean(g.cancel),
    suspended: Boolean(g.suspended),
  };
}

/**
 * size 는 kbo 경기가 아니라 *응답 전체*(퓨처스·국가대표 포함)에 걸리는 상한이고,
 * 넘으면 아무 표시 없이 잘린다. 500 을 넘겨 요청하면 오히려 결과가 깨진다
 * (2000 으로 요청하면 10건만 돌아오는 것을 확인).
 * 그래서 상한은 500 으로 두고, 기간을 짧게 쪼개 여러 번 부른다.
 */
const PAGE_SIZE = 500;

/** 한 번에 요청할 최대 일수. 하루 최대 5경기 × 여러 카테고리를 고려한 값. */
const CHUNK_DAYS = 31;

const addDays = (dateStr, n) =>
  new Date(Date.parse(`${dateStr}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

async function fetchWindow(fromDate, toDate) {
  const url =
    `${SCHEDULE_URL}?fields=${FIELDS}&upperCategoryId=kbaseball` +
    `&fromDate=${fromDate}&toDate=${toDate}&size=${PAGE_SIZE}`;

  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`KBO schedule fetch failed: HTTP ${res.status}`);

  const json = await res.json();
  if (!json?.success || !Array.isArray(json?.result?.games)) {
    throw new Error('KBO schedule response shape changed');
  }

  const games = json.result.games;
  if (games.length >= PAGE_SIZE) {
    // 잘렸다는 뜻이다. 조용히 넘어가면 경기가 통째로 빠진 채 동작하게 된다.
    console.warn(`KBO schedule truncated at ${PAGE_SIZE}: ${fromDate}~${toDate}`);
  }
  return games;
}

/**
 * 지정한 기간의 KBO 경기를 가져온다.
 * categoryId 가 'kbo' 인 경기만 남긴다. (퓨처스·국가대표 경기 제외)
 * 기간이 길면 자동으로 나눠 요청하고 gameId 로 중복을 제거한다.
 */
export async function fetchGames(fromDate, toDate) {
  const windows = [];
  for (let start = fromDate; start <= toDate; start = addDays(start, CHUNK_DAYS)) {
    const end = addDays(start, CHUNK_DAYS - 1);
    windows.push([start, end > toDate ? toDate : end]);
  }

  const pages = await Promise.all(windows.map(([f, t]) => fetchWindow(f, t)));

  const byId = new Map();
  for (const g of pages.flat()) {
    if (g.categoryId === 'kbo') byId.set(g.gameId, g);
  }

  return [...byId.values()].map(normalizeGame);
}

/** 해당 팀이 뛰는 경기만 남긴다. */
export function filterTeam(games, teamCode) {
  return games.filter((g) => g.homeCode === teamCode || g.awayCode === teamCode);
}

/**
 * "이번 시즌의 진짜 경기"만 남긴다.
 *
 * 네이버의 kbo 카테고리에는 정규시즌·포스트시즌 외에 아래가 섞여 있다.
 *   - 시범경기: 형식이 정규시즌과 완전히 같고 개막일 이전에만 열린다 (2026년 팀당 12경기)
 *   - 올스타전: gameId 접두 9999, 팀 코드가 EA(이스턴)·WE(웨스턴)
 *   - 지난 시즌 경기: 날짜 범위가 겹치면 함께 딸려 온다
 *
 * @param {number} year   이번 시즌 연도
 * @param {string|null} opener 정규시즌 개막일(YYYY-MM-DD). null 이면 시범경기를 거르지 않는다.
 */
export function filterCurrentSeason(games, year, opener) {
  return games.filter((g) => {
    if (seasonYearOf(g.gameId) !== year) return false;

    // 올스타전은 접두사와 팀 코드 양쪽으로 걸러 한쪽이 바뀌어도 새지 않게 한다.
    if (g.series === 'allstar') return false;
    if (!TEAM_CODES.has(g.homeCode) || !TEAM_CODES.has(g.awayCode)) return false;

    // 개막일을 모르면 시범경기 판별을 포기한다. 빠뜨리는 것보다 낫다.
    if (opener && g.series === 'regular' && g.gameDate < opener) return false;

    return true;
  });
}

/** 대상 팀 관점에서 상대팀 이름과 홈/원정 여부를 뽑는다. */
export function perspective(game, teamCode) {
  const isHome = game.homeCode === teamCode;
  return {
    isHome,
    teamName: isHome ? game.homeName : game.awayName,
    oppName: isHome ? game.awayName : game.homeName,
    teamScore: isHome ? game.homeScore : game.awayScore,
    oppScore: isHome ? game.awayScore : game.homeScore,
  };
}

/* ─────────────────────────── 순위 · 포스트시즌 ─────────────────────────── */

/**
 * 시즌 순위표를 가져온다.
 *
 * 응답의 postSeason.teamColors 에 그 해의 포스트시즌 진출 기준이 들어 있다.
 * ("1위 한국시리즈 진출", "4~5위 와일드카드 결정전 진출" 등)
 * 규칙이 바뀌어도 따라가도록 상수로 박지 않고 이 값을 그대로 쓴다.
 */
export async function fetchStandings(year) {
  const res = await fetch(`${STANDINGS_URL}/${year}/teams`, { headers: HEADERS });
  if (!res.ok) throw new Error(`KBO standings fetch failed: HTTP ${res.status}`);

  const json = await res.json();
  const stats = json?.result?.seasonTeamStats;
  if (!json?.success || !Array.isArray(stats)) {
    throw new Error('KBO standings response shape changed');
  }

  const tiers = (json.result.postSeason?.teamColors ?? []).map((c) => ({
    title: c.title,
    from: c.startRanking,
    to: c.endRanking,
    color: c.color,
  }));

  return {
    year,
    gameType: json.result.gameType ?? null,
    // 진출권 하한선. tiers 가 비어 있으면 판정을 포기한다(추측하지 않는다).
    cutoff: tiers.length ? Math.max(...tiers.map((t) => t.to)) : null,
    tiers,
    teams: stats
      .map((t) => ({
        code: t.teamId,
        name: t.teamName,
        rank: t.ranking,
        games: t.gameCount,
        wins: t.winGameCount,
        draws: t.drawnGameCount,
        losses: t.loseGameCount,
        pct: t.wra,
        gb: t.gameBehind,
        streak: t.continuousGameResult,
        last5: t.lastFiveGames,
      }))
      .sort((a, b) => a.rank - b.rank),
  };
}

/**
 * 포스트시즌 진출 상황을 판정한다.
 *
 * "탈락 확정"은 산술적으로만 판단한다: 대상 팀이 남은 경기를 전승해도
 * 진출 하한선 팀의 *현재* 승수에 못 미치면 확정 탈락이다. 하한선 팀도 승수가
 * 줄어들 수는 없으므로 이 판정은 반증 불가능하다. 반대로 "가능"은 어디까지나
 * 산술적 가능성이며 확률이 아니다.
 *
 * @param standings fetchStandings() 결과
 * @param teamCode  대상 팀
 * @param totalGames 팀당 정규시즌 경기 수
 */
export function postseasonOutlook(standings, teamCode, totalGames) {
  const me = standings.teams.find((t) => t.code === teamCode);
  if (!me || standings.cutoff == null) return null;

  const line = standings.teams.find((t) => t.rank === standings.cutoff);
  const remaining = Math.max(0, totalGames - me.games);

  // 현재 순위가 진출권 안이면 그대로 보고한다.
  const inside = me.rank <= standings.cutoff;
  const tier = standings.tiers.find((t) => me.rank >= t.from && me.rank <= t.to) ?? null;

  let status;
  if (inside) {
    status = 'in';
  } else if (line && me.wins + remaining < line.wins) {
    status = 'eliminated';
  } else {
    status = 'chasing';
  }

  const gamesBehindLine = inside ? 0 : Number((me.gb - (line?.gb ?? 0)).toFixed(1));
  const lineName = line?.name ?? `${standings.cutoff}위`;

  // 문장을 서버에서 완성해 내려보낸다. 조사 처리를 한곳(es-hangul)에 모으기 위함이다.
  let note;
  if (status === 'in') {
    note = `현재 순위를 지키면 ${tier?.title ?? '포스트시즌 진출'}이에요. 잔여 ${remaining}경기.`;
  } else if (status === 'eliminated') {
    note = `남은 ${remaining}경기를 모두 이겨도 ${josa(lineName, '이/가')} 지금까지 쌓은 승수에 미치지 못해요.`;
  } else {
    note = `잔여 ${remaining}경기. ${josa(lineName, '을/를')} 넘어야 진출권에 들어요.`;
  }

  return {
    team: me,
    rank: me.rank,
    cutoff: standings.cutoff,
    cutoffTeam: line ? { name: line.name, rank: line.rank, wins: line.wins } : null,
    remaining,
    // 진출권 팀과의 승차. 이미 진출권 안이면 0.
    gamesBehindLine,
    tierTitle: tier?.title ?? null,
    status, // in | chasing | eliminated
    note,
  };
}

/* ─────────────────────────── 전광판 ─────────────────────────── */

const RECORD_URL = 'https://api-gw.sports.naver.com/schedule/games';

/**
 * 경기 하나의 이닝별 점수(전광판)를 가져온다.
 *
 * 경기 시작 전에는 `recordData` 가 null 로 온다(정상). 진행 중·종료 후에는
 * `scoreBoard.inn.{home,away}` 에 이닝별 점수 배열이, `scoreBoard.rheb` 에
 * 팀별 R(득점)·H(안타)·E(실책)·B(볼넷) 합계가 들어 있다. 홈/원정 구분은
 * schedule API 의 homeCode/awayCode 와 같은 관례(gameInfo.hCode/aCode)를 쓴다.
 *
 * 실패하거나 아직 데이터가 없으면 null 을 준다 — 전광판은 부가 정보라
 * 이것 때문에 폴링 전체가 실패해서는 안 된다.
 */
export async function fetchScoreboard(gameId) {
  try {
    const res = await fetch(`${RECORD_URL}/${gameId}/record`, { headers: HEADERS });
    if (!res.ok) return null;

    const json = await res.json();
    const board = json?.result?.recordData?.scoreBoard;
    if (!board?.inn || !board?.rheb) return null;

    const side = (team) => ({
      innings: Array.isArray(board.inn[team]) ? board.inn[team].map(Number) : [],
      r: Number(board.rheb[team]?.r ?? 0),
      h: Number(board.rheb[team]?.h ?? 0),
      e: Number(board.rheb[team]?.e ?? 0),
      b: Number(board.rheb[team]?.b ?? 0),
    });

    return { home: side('home'), away: side('away') };
  } catch (err) {
    console.error('scoreboard fetch failed', gameId, err.message);
    return null;
  }
}

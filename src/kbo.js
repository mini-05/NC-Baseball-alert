/**
 * 네이버 스포츠 KBO API 어댑터.
 *
 * 문서 없는 비공식 API라 응답 형식이 언제든 바뀔 수 있다. 바뀌면 이 파일만
 * 고치면 되도록 네이버 응답을 다루는 코드는 전부 여기에 둔다.
 */

import { josa } from 'es-hangul';

const SCHEDULE_URL = 'https://api-gw.sports.naver.com/schedule/games';
const STANDINGS_URL = 'https://api-gw.sports.naver.com/statistics/categories/kbo/seasons';
const FIELDS = 'basic,superCategoryId,categoryName,stadium,statusNum';

/** 봇으로 막히는 걸 피하려고 모바일 웹과 같은 헤더를 보낸다. */
const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  Referer: 'https://m.sports.naver.com/',
  Accept: 'application/json',
};

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/* ─────────────────────────── 시간 ─────────────────────────── */

/** 현재 KST 날짜·연도. Workers 런타임은 UTC 기준이다. */
export function kstNow(now = new Date()) {
  const k = new Date(now.getTime() + KST_OFFSET_MS);
  return {
    date: k.toISOString().slice(0, 10), // YYYY-MM-DD
    year: k.getUTCFullYear(),
  };
}

/** KST 기준 오늘에서 days 만큼 옮긴 날짜(YYYY-MM-DD). */
export function kstDateOffset(days, now = new Date()) {
  const k = new Date(now.getTime() + KST_OFFSET_MS + days * 86400000);
  return k.toISOString().slice(0, 10);
}

/** "2026-08-23T18:30:00"(KST) → epoch ms. 못 읽으면 null. */
export function kstIsoToEpoch(iso) {
  const t = Date.parse(`${iso}+09:00`);
  return Number.isNaN(t) ? null : t;
}

/* ─────────────────────────── 시리즈 ─────────────────────────── */

export const SERIES = {
  allstar: { short: '올스타', post: false },
  regular: { short: '', post: false },
  tiebreaker: { short: '순위결정전', post: true },
  wildcard: { short: '와일드카드', post: true },
  semi_playoff: { short: '준PO', post: true },
  playoff: { short: 'PO', post: true },
  korean_series: { short: '한국시리즈', post: true },
};

/**
 * gameId 앞 4자리로 시리즈를 구분한다.
 *
 * 시리즈 필드가 따로 없다. 포스트시즌 경기는 gameId 가 날짜 대신 고정 접두사로
 * 시작하는데, 2023~2025 시즌 데이터로 아래 대응을 확인했다.
 *
 *   20260823...  정규시즌 또는 시범경기 (경기일 YYYYMMDD)
 *   9999...      올스타전 (팀 코드도 EA/WE 로 나온다)
 *   6666...      순위결정전   (2024년 KT-SSG 5위 결정전에서 관측)
 *   4444...      와일드카드 결정전
 *   3333...      준플레이오프
 *   5555...      플레이오프
 *   7777...      한국시리즈
 *
 * 시범경기는 정규시즌과 gameId 형식이 같아서 개막일로 가른다
 * (season.js resolveSeasonOpener).
 *
 * 공식 규칙이 아니라서 모르는 접두사는 정규시즌으로 본다. 알림이 아예 안 가는
 * 것보다는 낫다.
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

/** 알림 설정의 시리즈 범위(SCOPES): regular | postseason */
export const scopeOf = (series) => (isPostseason(series) ? 'postseason' : 'regular');

/**
 * gameId 끝 4자리 = 시즌 연도. (`20260822SSNC0` + `2026`, `77771026HHLG0` + `2025`)
 * 경기 날짜가 아니라 이 값으로 시즌을 나눠야 11월 한국시리즈도 그해 시즌에 들어간다.
 */
export function seasonYearOf(gameId) {
  const tail = String(gameId ?? '').slice(-4);
  return /^\d{4}$/.test(tail) ? Number(tail) : null;
}

/** KBO 10개 구단 코드. 올스타전 팀은 EA(이스턴)·WE(웨스턴)이라 여기 없다. */
export const TEAM_CODES = new Set(['HT', 'SS', 'LG', 'OB', 'KT', 'SK', 'LT', 'NC', 'WO', 'HH']);

/* ─────────────────────────── 일정 ─────────────────────────── */

/**
 * 네이버 경기 객체를 내부 형식으로 바꾼다.
 *
 * phase: BEFORE·READY → before, RESULT·ENDED → result, 나머지 → live.
 *
 * ENDED(poll_log 로 확인): 점수 확정 후 RESULT 로 바뀌기 전까지 최대 10분 정도
 *   거친다. 점수가 더 안 바뀌므로 result 로 봐야 종료 알림이 10분 늦지 않는다.
 * READY(poll_log 로 확인): BEFORE 와 STARTED 사이에 최대 53분 거친다. 그동안
 *   statusInfo 는 "경기전", 점수는 0:0 이다. live 로 보면 시작 알림이 최대 53분
 *   일찍 나간다.
 *
 * 처음 보는 statusCode 가 나와도 추적할 수 있게 원본 값도 같이 저장한다.
 */
export function normalizeGame(g) {
  const status = String(g.statusCode || '').toUpperCase();
  let phase;
  if (status === 'RESULT' || status === 'ENDED') phase = 'result';
  else if (status === 'BEFORE' || status === 'READY') phase = 'before';
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
 * size 는 KBO 경기만이 아니라 응답 전체(퓨처스·국가대표 포함)에 걸리고, 넘치면
 * 표시 없이 잘린다. 500 보다 크게 주면 오히려 깨진다(2000 → 10건만 옴).
 * 그래서 500 으로 두고 기간을 쪼개 여러 번 부른다.
 */
const PAGE_SIZE = 500;

/** 한 번에 요청하는 최대 일수. 하루 5경기 + 다른 카테고리 경기를 감안한 값. */
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
    // 잘린 것. 경기가 빠진 채로 돌 수 있어서 로그는 남긴다.
    console.warn(`KBO schedule truncated at ${PAGE_SIZE}: ${fromDate}~${toDate}`);
  }
  return games;
}

/**
 * 기간 안의 KBO 경기(categoryId 'kbo', 퓨처스·국가대표 제외)를 가져온다.
 * 긴 기간은 CHUNK_DAYS 단위로 나눠 요청하고 gameId 로 중복을 뺀다.
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
 * 이번 시즌 정규시즌·포스트시즌 경기만 남긴다.
 *
 * kbo 카테고리에 섞여 오는 것들:
 *   - 시범경기: 정규시즌과 형식이 같고 개막일 전에만 열림 (2026년 팀당 12경기)
 *   - 올스타전: gameId 접두 9999, 팀 코드 EA·WE
 *   - 지난 시즌 경기: 날짜 범위가 겹치면 같이 온다
 *
 * @param {number} year   이번 시즌 연도
 * @param {string|null} opener 정규시즌 개막일(YYYY-MM-DD). null 이면 시범경기를 거르지 않는다.
 */
export function filterCurrentSeason(games, year, opener) {
  return games.filter((g) => {
    if (seasonYearOf(g.gameId) !== year) return false;

    // 올스타전은 접두사와 팀 코드 둘 다로 거른다. 한쪽이 바뀌어도 걸리게.
    if (g.series === 'allstar') return false;
    if (!TEAM_CODES.has(g.homeCode) || !TEAM_CODES.has(g.awayCode)) return false;

    // 개막일을 모르면 시범경기는 거르지 않는다. 정규시즌 경기를 빠뜨리는 것보단 낫다.
    if (opener && g.series === 'regular' && g.gameDate < opener) return false;

    return true;
  });
}

/** 우리 팀 기준으로 홈/원정, 팀명, 점수를 정리한다. */
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
 * 시즌 순위표.
 *
 * postSeason.teamColors 에 그해 포스트시즌 진출 구간이 들어 있다
 * ("1위 한국시리즈 진출", "4~5위 와일드카드 결정전 진출" 등).
 * 규칙이 바뀌어도 그대로 따라가도록 하드코딩하지 않고 이 값을 쓴다.
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
  }));

  return {
    year,
    // 진출권 마지막 순위. tiers 가 없으면 null(추측하지 않음).
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
 * 포스트시즌 진출 상황.
 *
 * 탈락 확정: 남은 경기를 다 이겨도 진출권 마지막 팀의 현재 승수에 못 미칠 때.
 * 승수는 줄지 않으니 이 판정은 뒤집히지 않는다. "가능"은 산술적으로 가능하다는
 * 뜻이지 확률이 아니다.
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

  // 지금 진출권 안이면 in.
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

  /*
   * 바로 아래 팀과의 승차. 순위표의 승차는 1위 기준이라 따로 계산한다.
   *
   * rank + 1 대신 정렬된 목록의 다음 팀을 쓴다. 공동 7위가 둘이면 다음은 9위라
   * rank + 1 로는 못 찾는다. 공동 순위면 승차 0 으로 나온다.
   * (teams 는 fetchStandings 에서 rank 순으로 정렬돼 있다)
   */
  const below = standings.teams[standings.teams.indexOf(me) + 1];
  const chaser = below
    ? { name: below.name, rank: below.rank, gap: Number((below.gb - me.gb).toFixed(1)) }
    : null;

  // 조사 처리(es-hangul)를 서버 한 곳에 두려고 문장까지 여기서 만든다.
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
    // 바로 아래 순위 팀과 그 승차. 꼴찌면 null.
    chaser,
    tierTitle: tier?.title ?? null,
    status, // in | chasing | eliminated
    note,
  };
}

/**
 * 상대 팀별 시즌 전적.
 *
 * 순위 API 에는 상대전적이 없어서 loadSchedule 결과(상대팀·결과 포함)를 센다.
 * 추가 조회는 없다.
 *
 * 정규시즌 경기만 센다. 포스트시즌 시리즈가 섞이면 팀당 16경기 전적이 틀어진다.
 *
 * pct 는 KBO 방식대로 무승부를 뺀 승/(승+패). 승패가 하나도 없으면 null.
 *
 * @param {Array} games loadSchedule() 결과
 */
export function headToHead(games) {
  const by = new Map();

  for (const g of games) {
    if (g.series !== 'regular' || !g.result) continue;
    const r = by.get(g.oppName) ?? { opp: g.oppName, wins: 0, draws: 0, losses: 0 };
    if (g.result === 'win') r.wins++;
    else if (g.result === 'lose') r.losses++;
    else r.draws++;
    by.set(g.oppName, r);
  }

  // 승률 높은 상대부터. pct 가 null 이면 맨 뒤.
  return [...by.values()]
    .map((r) => ({ ...r, pct: r.wins + r.losses ? r.wins / (r.wins + r.losses) : null }))
    .sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1));
}

/* ─────────────────────────── 전광판 ─────────────────────────── */

/**
 * 경기 전광판(이닝별 점수, R·H·E·B, 홈런 기록).
 *
 * 경기 전에는 recordData 가 null 로 온다. 경기 중·후에는
 * scoreBoard.inn.{home,away} 에 이닝별 점수, scoreBoard.rheb 에 팀별
 * R(득점)·H(안타)·E(실책)·B(볼넷) 합계가 있다.
 *
 * 전광판은 부가 정보라 실패하면 예외 대신 null 을 준다. 이것 때문에 폴링이
 * 통째로 실패하면 안 된다.
 */
export async function fetchScoreboard(gameId) {
  try {
    const res = await fetch(`${SCHEDULE_URL}/${gameId}/record`, { headers: HEADERS });
    if (!res.ok) return null;

    const json = await res.json();
    const record = json?.result?.recordData;
    const board = record?.scoreBoard;
    if (!board?.inn || !board?.rheb) return null;

    const side = (team) => ({
      innings: Array.isArray(board.inn[team]) ? board.inn[team].map(Number) : [],
      r: Number(board.rheb[team]?.r ?? 0),
      h: Number(board.rheb[team]?.h ?? 0),
      e: Number(board.rheb[team]?.e ?? 0),
      b: Number(board.rheb[team]?.b ?? 0),
    });

    /*
     * 홈런은 etcRecords(홈런·3루타·실책 등 기타 기록)에 how:'홈런' 으로 섞여 온다.
     * result 에 "오스틴33호(8회3점 손주환)"처럼 선수·이닝·타점이 다 있어서
     * (타자 기록 rbi 와 맞는 것 확인) 문자열을 그대로 쓴다.
     */
    const hr = Array.isArray(record?.etcRecords)
      ? record.etcRecords.filter((r) => r.how === '홈런').map((r) => r.result)
      : [];

    return { home: side('home'), away: side('away'), hr };
  } catch (err) {
    console.error('scoreboard fetch failed', gameId, err.message);
    return null;
  }
}

/* ─────────── 문자중계(relay): 경기 종료를 빨리 잡는 용도 ─────────── */

/**
 * statusInfo("9회말")에서 회차 숫자. 못 읽으면 0.
 * 문자중계를 볼지 정하는 데만 쓰므로 못 읽으면 안 보는 쪽으로 간다.
 */
export function inningOf(statusInfo) {
  return Number(/^(\d+)회/.exec(String(statusInfo ?? ''))?.[1]) || 0;
}

/**
 * 전광판 이닝별 점수 합이 총점(schedule API)과 같은지.
 *
 * record API 와 schedule API 는 따로 조회해서 같은 틱에도 시점이 어긋날 수 있다
 * (record 쪽에 방금 난 점수가 아직 없는 경우). 합이 맞을 때만 전광판을 믿는다.
 */
export function inningSumMatches(innings, score) {
  if (!Array.isArray(innings) || innings.length === 0) return false;
  return innings.reduce((sum, v) => sum + (Number(v) || 0), 0) === score;
}

/**
 * 문자중계로 경기 종료 여부만 본다. 끝났으면 최종 점수, 아니면 null.
 *
 * schedule API 의 statusCode 는 마지막 아웃 후 2분쯤 지나야 ENDED 로 바뀐다
 * (2026-08-29: 마지막 투구 21:22:09, ENDED 21:24:17). 문자중계에는 종료 블록이
 * 바로 붙어서 그만큼 빨리 알 수 있다.
 *
 * 종료 알림은 한 번 나가면 dedup_key(`${gameId}:end`) 때문에 다시 못 보내니
 * 세 단계로 확인한다.
 *   1) 9회 이후 진행 중인 경기에서만 호출 (index.js poll)
 *   2) type 99 + "=====" 구분선. 99 는 종료 블록에만 나온다(실제 응답으로 확인)
 *   3) 점수를 호출부에서 schedule API 값과 비교, 다르면 버림
 *
 * 응답이 커서(한 이닝 분량) 매번 부르지 않는다. 1)이 그 조건이다.
 */
export async function fetchRelayFinish(gameId) {
  try {
    const res = await fetch(`${SCHEDULE_URL}/${gameId}/relay`, { headers: HEADERS });
    if (!res.ok) return null;

    const relay = (await res.json())?.result?.textRelayData;
    if (!relay) return null;

    const ended = (relay.textRelays ?? []).some((tr) =>
      (tr.textOptions ?? []).some((o) => o.type === 99 && /^=+$/.test(String(o.text ?? ''))),
    );
    if (!ended) return null;

    const s = relay.currentGameState ?? {};
    const homeScore = Number(s.homeScore);
    const awayScore = Number(s.awayScore);
    if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore)) return null;

    return { homeScore, awayScore };
  } catch (err) {
    console.error('relay fetch failed', gameId, err.message);
    return null;
  }
}

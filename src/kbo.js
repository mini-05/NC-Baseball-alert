/**
 * 네이버 스포츠 KBO API 어댑터.
 *
 * 공식 문서가 없는 비공식 엔드포인트다. 응답 스키마가 예고 없이 바뀔 수 있으므로
 * 이 파일 하나만 고치면 되도록 나머지 코드와의 접점을 좁혀 둔다.
 */

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
 *   20260823...  정규시즌 (경기일 YYYYMMDD)
 *   6666...      순위결정전   (2024년 KT-SSG 5위 결정전에서 관측)
 *   4444...      와일드카드 결정전
 *   3333...      준플레이오프
 *   5555...      플레이오프
 *   7777...      한국시리즈
 *
 * 문서화된 규칙이 아니므로, 모르는 접두사는 정규시즌으로 간주해
 * "알림이 아예 안 오는" 최악을 피한다.
 */
export function seriesOf(gameId) {
  const prefix = String(gameId ?? '').slice(0, 4);
  switch (prefix) {
    case '6666': return 'tiebreaker';
    case '4444': return 'wildcard';
    case '3333': return 'semi_playoff';
    case '5555': return 'playoff';
    case '7777': return 'korean_series';
    default: return 'regular';
  }
}

export const isPostseason = (series) => SERIES[series]?.post === true;

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
 * 지정한 기간의 KBO 경기를 가져온다.
 * categoryId 가 'kbo' 인 경기만 남긴다. (퓨처스·국가대표 경기 제외)
 */
export async function fetchGames(fromDate, toDate) {
  const url =
    `${SCHEDULE_URL}?fields=${FIELDS}&upperCategoryId=kbaseball` +
    `&fromDate=${fromDate}&toDate=${toDate}&size=500`;

  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`KBO schedule fetch failed: HTTP ${res.status}`);

  const json = await res.json();
  if (!json?.success || !Array.isArray(json?.result?.games)) {
    throw new Error('KBO schedule response shape changed');
  }

  return json.result.games
    .filter((g) => g.categoryId === 'kbo')
    .map(normalizeGame);
}

/** 해당 팀이 뛰는 경기만 남긴다. */
export function filterTeam(games, teamCode) {
  return games.filter((g) => g.homeCode === teamCode || g.awayCode === teamCode);
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

  return {
    team: me,
    rank: me.rank,
    cutoff: standings.cutoff,
    cutoffTeam: line ? { name: line.name, rank: line.rank, wins: line.wins } : null,
    remaining,
    // 진출권 팀과의 승차. 이미 진출권 안이면 0.
    gamesBehindLine: inside ? 0 : Number((me.gb - (line?.gb ?? 0)).toFixed(1)),
    tierTitle: tier?.title ?? null,
    status, // in | chasing | eliminated
  };
}

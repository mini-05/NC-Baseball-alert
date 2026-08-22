/**
 * 네이버 스포츠 KBO 일정 API 어댑터.
 *
 * 공식 문서가 없는 비공식 엔드포인트다. 응답 스키마가 예고 없이 바뀔 수 있으므로
 * 이 파일 하나만 고치면 되도록 나머지 코드와의 접점을 normalizeGame() 결과로 좁혀 둔다.
 */

const SCHEDULE_URL = 'https://api-gw.sports.naver.com/schedule/games';
const FIELDS = 'basic,superCategoryId,categoryName,stadium,statusNum';

/** 네이버가 봇 트래픽을 막는 경우가 있어 모바일 웹과 동일한 헤더를 보낸다. */
const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  Referer: 'https://m.sports.naver.com/',
  Accept: 'application/json',
};

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 현재 시각을 KST 기준 Date 필드로 분해한다. (Workers 런타임은 UTC로 동작) */
export function kstNow(now = new Date()) {
  const k = new Date(now.getTime() + KST_OFFSET_MS);
  return {
    date: k.toISOString().slice(0, 10), // YYYY-MM-DD
    hour: k.getUTCHours(),
    minute: k.getUTCMinutes(),
    iso: k.toISOString().slice(0, 19), // 오프셋 없는 KST 로컬시각
  };
}

/** KST 기준으로 offsetDays 만큼 이동한 날짜 문자열. */
export function kstDateOffset(days, now = new Date()) {
  const k = new Date(now.getTime() + KST_OFFSET_MS + days * 86400000);
  return k.toISOString().slice(0, 10);
}

/**
 * 네이버 원본 경기 객체를 내부 표현으로 변환한다.
 *
 * phase 판정: 관측으로 확인된 값은 BEFORE(경기 전)와 RESULT(종료)뿐이다.
 * 경기 중 상태값은 문서화돼 있지 않으므로 "둘 중 어느 쪽도 아니면 진행 중"으로 본다.
 * 새로운 statusCode 가 오면 statusCode 를 그대로 저장해 두어 나중에 추적할 수 있게 한다.
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
    statusCode: status,
    statusInfo: g.statusInfo ?? null,
    cancelled: Boolean(g.cancel),
    suspended: Boolean(g.suspended),
  };
}

/**
 * 지정한 기간의 KBO 경기를 가져온다.
 * @returns {Promise<Array>} normalizeGame() 을 거친 경기 배열
 */
export async function fetchGames(fromDate, toDate) {
  const url = `${SCHEDULE_URL}?fields=${FIELDS}&upperCategoryId=kbaseball&fromDate=${fromDate}&toDate=${toDate}&size=500`;

  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) {
    throw new Error(`KBO schedule fetch failed: HTTP ${res.status}`);
  }

  const json = await res.json();
  if (!json?.success || !Array.isArray(json?.result?.games)) {
    throw new Error('KBO schedule response shape changed');
  }

  return json.result.games.map(normalizeGame);
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

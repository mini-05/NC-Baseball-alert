/**
 * 시즌 게이팅 — 경기가 없는 날·시간에는 외부 API를 아예 호출하지 않는다.
 *
 * 크론은 1분마다 깨어나지만, 실제로 감시가 필요한 시간은 하루에 3~4시간뿐이고
 * 비시즌(11월~3월)에는 아예 없다. 그래서 "오늘 우리 팀 경기 목록"을 하루 한 번만
 * 조회해 캐시하고, 그 계획에 따라 폴링 여부를 정한다.
 *
 * 결과적으로 비시즌 외부 호출은 하루 1회, 시즌 중에도 경기 시간대에만 발생한다.
 */

import {
  fetchGames, filterTeam, filterCurrentSeason, fetchStandings, perspective,
  kstDateOffset, kstIsoToEpoch, seasonYearOf, TEAM_CODES,
} from './kbo.js';
import { getCache, putCache } from './db.js';

/** 경기 시작 몇 분 전부터 감시할지. 우천 취소는 보통 시작 1시간 안쪽에 공지된다. */
const PRE_START_MIN = 90;

/** 경기 시작 후 몇 시간까지 감시할지. 연장·중단을 포함해도 이 안에서 끝난다. */
const POST_START_HOURS = 7;

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

/**
 * 정규시즌 개막일을 알아낸다.
 *
 * 시범경기는 정규시즌과 형식이 완전히 같아 gameId 만으로는 구분할 수 없다.
 * 대신 순위표의 gameCount 는 **정규시즌 경기만** 센다는 점을 이용한다:
 * 완료된 경기를 날짜순으로 늘어놓고 뒤에서 gameCount 개를 세면 그 앞이 시범경기다.
 *
 * 2026 시즌 데이터로 검증했을 때 10개 구단 전부 같은 날짜(2026-03-28)를 가리켰다.
 * 상수로 박지 않는 이유는 개막일이 매년 다르고 우천으로 밀릴 수도 있기 때문이다.
 *
 * 개막 전(gameCount 가 0)이거나 조회에 실패하면 null 을 준다.
 * 그 경우 호출부는 시범경기 판별을 포기한다 — 경기를 통째로 빠뜨리는 것보다 낫다.
 */
export async function resolveSeasonOpener(env, year) {
  const key = `opener:${year}`;
  const cached = await getCache(env.DB, key);
  if (cached !== null) return cached.date;

  try {
    const standings = await fetchStandings(year);
    const me = standings.teams.find((t) => t.code === env.TEAM_CODE);
    if (!me || !me.games) return null; // 아직 정규시즌 경기가 없다

    // 시즌 전체 일정이 필요하다. 한 달 단위로 쪼개 받으므로 요청이 여러 번 나간다.
    // 30일 캐시라 시즌당 몇 번만 실행된다.
    const all = await fetchGames(`${year}-01-01`, `${year}-12-31`);

    const done = filterTeam(all, env.TEAM_CODE)
      .filter(
        (g) =>
          seasonYearOf(g.gameId) === year &&
          g.phase === 'result' &&
          !g.cancelled &&
          TEAM_CODES.has(g.homeCode) &&
          TEAM_CODES.has(g.awayCode),
      )
      .sort((a, b) => (a.gameDate + a.gameId).localeCompare(b.gameDate + b.gameId));

    const skip = done.length - me.games;
    // skip 이 음수면 순위표가 일정보다 앞서 있다는 뜻이라 신뢰할 수 없다.
    const date = skip >= 0 && skip < done.length ? done[skip].gameDate : null;

    await putCache(env.DB, key, { date }, 30 * 24 * HOUR);
    return date;
  } catch (err) {
    console.error('season opener resolution failed', err.message);
    return null;
  }
}

/**
 * 오늘(과 어제) 우리 팀 경기 계획을 가져온다. 하루 한 번만 실제 조회한다.
 *
 * 어제를 포함하는 이유: 자정을 넘겨 끝나는 경기의 마지막 상태 전이를 놓치지 않기 위함.
 */
export async function loadDailyPlan(env, today) {
  const key = `plan:${today}`;
  const cached = await getCache(env.DB, key);
  if (cached) return cached;

  const year = Number(today.slice(0, 4));
  const opener = await resolveSeasonOpener(env, year);

  const games = filterCurrentSeason(
    filterTeam(await fetchGames(kstDateOffset(-1), today), env.TEAM_CODE),
    year,
    opener,
  );

  const plan = {
    date: today,
    games: games.map((g) => ({
      gameId: g.gameId,
      startAt: g.startAt,
      series: g.series,
      phase: g.phase,
    })),
    fetchedAt: new Date().toISOString(),
  };

  // 계획은 당일에만 유효하다. 자정이 지나면 새로 만든다.
  await putCache(env.DB, key, plan, 12 * HOUR);
  return plan;
}

/**
 * 지금이 감시가 필요한 시간대인지 판단한다.
 *
 * 이미 끝난(result) 경기만 있는 계획이라면 더 볼 이유가 없다. 다만 계획은
 * 하루 한 번만 갱신되므로 phase 는 오래된 값일 수 있다. 따라서 phase 로
 * 건너뛰지 않고 시간 창만으로 판단한다.
 */
export function isPollWindow(plan, now = Date.now()) {
  for (const g of plan.games) {
    const start = kstIsoToEpoch(g.startAt);
    if (start == null) return true; // 시각을 못 읽으면 안전하게 감시한다.

    if (now >= start - PRE_START_MIN * MIN && now <= start + POST_START_HOURS * HOUR) {
      return true;
    }
  }
  return false;
}

/** 계획을 강제로 다시 만든다. (경기가 추가·변경됐을 때 쓰는 관리용) */
export async function invalidatePlan(env, today) {
  await putCache(env.DB, `plan:${today}`, null, -1);
}

/**
 * 앞으로의 경기 일정을 가져온다. 하루 한 번만 실제 조회한다.
 *
 * 경기 결과가 아니라 "언제 어디서 누구와 붙는지"만 쓰므로 캐시를 길게 잡아도 된다.
 * 다만 우천 취소가 당일 반영되어야 하므로 오늘 경기는 포함해 6시간마다 갱신한다.
 */
export async function loadSchedule(env, year) {
  const key = `schedule:${year}`;
  const cached = await getCache(env.DB, key);
  if (cached) return cached;

  const opener = await resolveSeasonOpener(env, year);

  // 시즌 전체를 받는다. 지난 경기의 결과까지 함께 보여주기 위함이다.
  const games = filterCurrentSeason(
    filterTeam(await fetchGames(`${year}-01-01`, `${year}-12-31`), env.TEAM_CODE),
    year,
    opener,
  );

  const schedule = games
    .map((g) => {
      const p = perspective(g, env.TEAM_CODE);

      return {
        gameId: g.gameId,
        gameDate: g.gameDate,
        startAt: g.startAt,
        stadium: g.stadium,
        series: g.series,
        isHome: p.isHome,
        oppName: p.oppName,
        phase: g.phase,
        cancelled: g.cancelled,
        statusInfo: g.statusInfo,
        // 지난 경기의 결과. 아직 안 끝난 경기는 화면에서 phase 로 걸러 쓴다.
        teamScore: p.teamScore,
        oppScore: p.oppScore,
        result:
          g.phase === 'result' && !g.cancelled
            ? p.teamScore > p.oppScore ? 'win' : p.teamScore < p.oppScore ? 'lose' : 'draw'
            : null,
      };
    })
    .sort((a, b) => a.startAt.localeCompare(b.startAt));

  // 경기 결과가 반영돼야 하므로 짧게 잡고, 경기가 끝나면 invalidateSchedule 로 즉시 비운다.
  await putCache(env.DB, key, schedule, 30 * MIN);
  return schedule;
}

/** 경기가 끝났을 때 호출한다. 지난 일정의 결과를 바로 반영하기 위함이다. */
export async function invalidateSchedule(env, year) {
  await putCache(env.DB, `schedule:${year}`, null, -1);
}

/**
 * 순위표를 캐시와 함께 가져온다.
 *
 * 순위는 경기가 끝나야 바뀌므로 짧은 캐시로 충분하고, 경기 종료를 감지하면
 * invalidateStandings 로 즉시 비운다. 그래서 경기가 끝나는 즉시 새 순위가 보인다.
 * 비시즌에는 해당 연도 데이터가 없을 수 있어 실패를 조용히 삼키고 null 을 준다.
 */
export async function loadStandings(env, year) {
  const key = `standings:${year}`;
  const cached = await getCache(env.DB, key);
  if (cached) return cached;

  try {
    const standings = await fetchStandings(year);
    await putCache(env.DB, key, standings, 10 * MIN);
    return standings;
  } catch (err) {
    console.error('standings fetch failed', err.message);
    return null;
  }
}

/** 경기가 끝났을 때 호출한다. 다음 조회에서 최신 순위를 새로 받아 온다. */
export async function invalidateStandings(env, year) {
  await putCache(env.DB, `standings:${year}`, null, -1);
}

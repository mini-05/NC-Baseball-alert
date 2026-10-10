/**
 * 시즌·시간대 판단과 일정·순위 캐시.
 *
 * 크론은 1분마다 돌지만 실제로 볼 시간은 경기 있는 날 3~4시간뿐이다. 오늘 경기
 * 목록(계획)을 하루 한 번 받아 캐시해 두고, 그 시간대에만 네이버를 부른다.
 * 비시즌에는 외부 호출이 하루 1번이다.
 */

import {
  fetchGames, filterTeam, filterCurrentSeason, fetchStandings, perspective,
  kstDateOffset, kstIsoToEpoch,
} from './kbo.js';
import { getCache, getCacheStale, putCache, expireCache, pruneDatedCache, prunePollLog } from './db.js';

/** 경기 시작 몇 분 전부터 볼지. 우천 취소는 보통 시작 1시간 전쯤 나온다. */
const PRE_START_MIN = 90;

/**
 * 경기 시작 후 몇 시간까지 볼지. 연장·중단이 있어도 이 안에 끝난다.
 *
 * 보통은 종료 후 FINISH_COOLDOWN_MIN 이 지나면 먼저 멈춘다(index.js tick).
 * 이 값은 종료를 끝내 못 잡았을 때의 상한이다.
 */
const POST_START_HOURS = 7;

/**
 * 경기 종료 후 더 지켜보는 시간(분).
 * 더블헤더 2차전이 있을 수 있고, 네이버가 최종 기록을 늦게 고치는 경우도 있다.
 */
export const FINISH_COOLDOWN_MIN = 30;

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

/**
 * 날짜별 캐시(plan:·today:) 보관 일수.
 * 지난 값은 다시 안 읽지만, 나중에 지난 시즌을 확인할 일이 있을까 봐 1년 둔다.
 * 하루 2행이라 1년이어도 700행 정도다.
 */
const CACHE_KEEP_DAYS = 365;

/** poll_log 보관 일수. 디버깅용. */
const POLL_LOG_KEEP_DAYS = 183;

/**
 * 개막일을 못 정했을 때(개막 전이거나 조회 실패) 다시 시도하기까지의 간격.
 *
 * 못 정한 결과도 캐시해야 한다. resolveSeasonOpener 는 폴링·일정·계획 조회에서
 * 자주 불려서, 캐시가 없으면 개막 전 석 달 내내 그때마다 순위 API 를 부른다.
 */
const OPENER_RETRY_MS = 6 * HOUR;

/**
 * 정규시즌 개막일.
 *
 * 시범경기는 gameId 로 구분이 안 된다. 대신 순위표 gameCount 는 정규시즌 경기만
 * 센다. 끝난 경기를 날짜순으로 놓고 뒤에서 gameCount 개를 빼면 남는 앞쪽이 시범경기다.
 *
 * 2026 시즌으로 확인했을 때 10개 구단 모두 2026-03-28 이 나왔다. 해마다 다르고
 * 우천으로 밀리기도 해서 상수로 두지 않는다.
 *
 * 개막 전(gameCount 0)이거나 조회에 실패하면 null. 그러면 호출부는 시범경기를
 * 거르지 않는다.
 */
export async function resolveSeasonOpener(env, year) {
  const key = `opener:${year}`;
  const cached = await getCache(env.DB, key);
  if (cached !== null) return cached.date;

  let date = null;
  try {
    const standings = await fetchStandings(year);
    const me = standings.teams.find((t) => t.code === env.TEAM_CODE);

    // me.games 가 0 이면 아직 정규시즌 전이라 null.
    if (me?.games) {
      // 시즌 전체 일정을 한 달씩 나눠 받아서 요청이 여러 번 나간다.
      // 결과는 30일 캐시라 시즌에 몇 번 안 돈다.
      const all = await fetchGames(`${year}-01-01`, `${year}-12-31`);

      // 개막일을 구하는 중이라 opener 는 null 로 넘긴다(시즌·구단만 거름).
      const done = filterCurrentSeason(filterTeam(all, env.TEAM_CODE), year, null)
        .filter((g) => g.phase === 'result' && !g.cancelled)
        .sort((a, b) => (a.gameDate + a.gameId).localeCompare(b.gameDate + b.gameId));

      const skip = done.length - me.games;
      // skip 이 음수면 순위표가 일정보다 앞선 상태라 믿을 수 없다.
      if (skip >= 0 && skip < done.length) date = done[skip].gameDate;
    }
  } catch (err) {
    console.error('season opener resolution failed', err.message);
  }

  // null 도 짧게 캐시한다(OPENER_RETRY_MS 참고). 캐시 쓰기 실패는 무시한다.
  // 이 함수는 예외를 던지지 않고 호출부는 null 이어도 돌아간다.
  await putCache(env.DB, key, { date }, date ? 30 * 24 * HOUR : OPENER_RETRY_MS)
    .catch((err) => console.error('season opener cache failed', err.message));
  return date;
}

/**
 * 어제·오늘 우리 팀 경기 계획. 캐시가 있으면 조회하지 않는다.
 * 어제를 넣는 건 자정을 넘겨 끝나는 경기의 종료를 놓치지 않으려고.
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

  // 키에 날짜가 들어가서 자정이 지나면 새로 만든다.
  await putCache(env.DB, key, plan, 12 * HOUR);

  /*
   * 오래된 캐시·로그 정리. 계획을 새로 만들 때(하루 한두 번)만 돌린다.
   * 실패해도 계획은 저장됐으니 넘어간다.
   */
  await pruneDatedCache(env.DB, kstDateOffset(-CACHE_KEEP_DAYS))
    .catch((err) => console.error('cache prune failed', err.message));
  await prunePollLog(env.DB, new Date(Date.now() - POLL_LOG_KEEP_DAYS * 24 * HOUR).toISOString())
    .catch((err) => console.error('poll log prune failed', err.message));

  return plan;
}

/**
 * 지금 감시 시간대에 있는 경기만 고른다.
 *
 * 계획의 phase 는 하루 한 번 받은 값이라 오래됐을 수 있어서 시간으로만 판단한다.
 * 경기가 실제로 끝났는지는 호출부(index.js tick)가 DB 로 따로 확인한다.
 */
export function pollWindowGames(plan, now = Date.now()) {
  return plan.games.filter((g) => {
    const start = kstIsoToEpoch(g.startAt);
    if (start == null) return true; // 시각을 못 읽으면 일단 본다.

    return now >= start - PRE_START_MIN * MIN && now <= start + POST_START_HOURS * HOUR;
  });
}

/** 오늘 계획을 만료시킨다. 경기가 추가·변경됐을 때 관리용(/api/admin/refresh-plan). */
export async function invalidatePlan(env, today) {
  await expireCache(env.DB, `plan:${today}`);
}

/**
 * 시즌 전체 일정(지난 경기 결과 포함). 30분 캐시.
 * 경기가 끝나면 invalidateSchedule 로 만료시켜 결과가 바로 반영되게 한다.
 */
export async function loadSchedule(env, year) {
  const key = `schedule:${year}`;
  const cached = await getCache(env.DB, key);
  if (cached) return cached;

  try {
    const opener = await resolveSeasonOpener(env, year);

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
          // 점수는 안 끝난 경기에도 들어가지만 화면에서 phase 로 걸러 쓴다.
          teamScore: p.teamScore,
          oppScore: p.oppScore,
          result:
            g.phase === 'result' && !g.cancelled
              ? p.teamScore > p.oppScore ? 'win' : p.teamScore < p.oppScore ? 'lose' : 'draw'
              : null,
        };
      })
      .sort((a, b) => a.startAt.localeCompare(b.startAt));

    await putCache(env.DB, key, schedule, 30 * MIN);
    return schedule;
  } catch (err) {
    // 네이버가 잠깐 안 될 때 /api/schedule 이 500 이 되지 않게 잡는다.
    // 실패는 캐시하지 않고 마지막 정상값을 돌려준다. 일정은 거의 안 바뀌어서
    // 좀 오래된 값이라도 빈 화면보다 낫다.
    console.error('schedule fetch failed', err.message);
    return (await getCacheStale(env.DB, key)) ?? [];
  }
}

/** 경기 종료 때 호출. 값은 남기고 만료만 시켜서 조회 실패 시 폴백으로 쓴다. */
export async function invalidateSchedule(env, year) {
  await expireCache(env.DB, `schedule:${year}`);
}

/**
 * 순위표. 10분 캐시이고 경기 종료 때 invalidateStandings 로 만료시킨다.
 * 조회에 실패하면 마지막 정상값, 그것도 없으면(비시즌 첫 조회 등) null.
 */
export async function loadStandings(env, year) {
  const key = `standings:${year}`;
  const cached = await getCache(env.DB, key);
  if (cached) return cached;

  try {
    // 화면의 "○○ 기준" 표시용 조회 시각. 폴백으로 예전 순위를 보여줄 때도
    // 언제 값인지 알 수 있다.
    const standings = { ...(await fetchStandings(year)), fetchedAt: new Date().toISOString() };
    await putCache(env.DB, key, standings, 10 * MIN);
    return standings;
  } catch (err) {
    console.error('standings fetch failed', err.message);
    return (await getCacheStale(env.DB, key)) ?? null;
  }
}

/** 경기 종료 때 호출. 다음 조회에서 새 순위를 받는다. */
export async function invalidateStandings(env, year) {
  await expireCache(env.DB, `standings:${year}`);
}

/**
 * 오늘 경기의 팀별 진행 상태. 순위표에 "오늘 경기 반영 전" 표시를 붙이는 데 쓴다.
 * 10개 구단 전부 본다.
 *
 * 반환: 팀코드 → 'done' | 'pending'(경기 전·중). 오늘 경기 없는 팀은 키가 없다.
 * 취소 경기는 순위에 안 들어가니 뺀다(넣으면 그 팀이 하루 종일 대기로 나옴).
 *
 * ponytail: 'done' 은 경기가 끝났다는 뜻이지 순위표가 이미 갱신됐다는 뜻은
 * 아니다. 종료 직후 잠깐 차이가 난다. 정확히 하려면 10개 구단 완료 경기 수를
 * gameCount 와 맞춰 봐야 하는데 표시 하나에 비해 비용이 크다.
 */
export async function loadTodayStatus(env, today, year) {
  const key = `today:${today}`;
  const cached = await getCache(env.DB, key);
  if (cached) return cached;

  const status = {};
  try {
    const opener = await resolveSeasonOpener(env, year);
    const games = filterCurrentSeason(await fetchGames(today, today), year, opener);

    for (const g of games) {
      if (g.cancelled) continue;
      const s = g.phase === 'result' ? 'done' : 'pending';
      status[g.homeCode] = s;
      status[g.awayCode] = s;
    }
  } catch (err) {
    // 부가 표시라 실패해도 순위는 그대로 보여 준다.
    console.error('today status fetch failed', err.message);
    return {};
  }

  // 진행 중인 경기가 있으면 3분, 아니면 그날은 더 안 바뀌니 6시간.
  const pending = Object.values(status).some((s) => s === 'pending');
  await putCache(env.DB, key, status, pending ? 3 * MIN : 6 * HOUR);
  return status;
}

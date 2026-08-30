/**
 * 직전 스냅샷과 현재 상태를 비교해 알림 이벤트를 만든다.
 *
 * 설계 원칙
 * - 처음 보는 경기(prev === null)는 기록만 하고 알리지 않는다. 배포 직후나
 *   DB 초기화 후에 과거 경기들이 한꺼번에 알림으로 쏟아지는 것을 막기 위함이다.
 * - 모든 이벤트는 dedup_key 를 갖는다. 크론이 중복 실행되거나 재시도돼도
 *   같은 전이가 두 번 발송되지 않는다.
 */

import { josa } from 'es-hangul';
import { perspective, SERIES, isPostseason, inningSumMatches } from './kbo.js';

export const KINDS = ['start', 'cancel', 'score', 'end'];

/** 알림 종류 → subscriptions 테이블의 on/off 컬럼명 */
export const KIND_COLUMN = {
  start: 'on_start',
  cancel: 'on_cancel',
  score: 'on_score',
  end: 'on_end',
};

/** 시리즈 범위 → subscriptions 테이블의 on/off 컬럼명 */
export const SCOPES = ['regular', 'postseason'];
export const SCOPE_COLUMN = {
  regular: 'on_regular',
  postseason: 'on_postseason',
};

export const KIND_LABEL = {
  start: '경기 시작',
  cancel: '경기 취소',
  score: '득점',
  end: '경기 종료',
};

/** 포스트시즌 경기는 제목 앞에 시리즈를 붙여 정규시즌과 구별되게 한다. */
function tag(series) {
  const short = SERIES[series]?.short;
  return short ? `[${short}] ` : '';
}

/** "NC 3 : 2 삼성" 형태의 스코어 문자열 (대상 팀을 항상 왼쪽에 둔다) */
function scoreLine(game, teamCode) {
  const p = perspective(game, teamCode);
  return `${p.teamName} ${p.teamScore} : ${p.oppScore} ${p.oppName}`;
}

/**
 * 득점이 난 이닝을 전광판에서 되짚는다. 확실할 때만 문자열을, 아니면 null.
 *
 * 왜 statusInfo("5회초")를 안 쓰나 — 그건 폴링한 순간의 이닝이지 점수가 난
 * 이닝이 아니다. 이닝이 넘어간 직후 틱에 걸리면 한 칸 밀린 이닝을 단언하게 된다.
 *
 * 왜 일치 검사가 필요한가 — 총점은 schedule API, 이닝별 점수는 record API 에서
 * 온다(kbo.js). 두 응답의 시점이 어긋나면 이닝별 합과 총점이 다르다. 그 상태의
 * 전광판으로 이닝을 고르면 확신에 찬 오답이 나오므로, 합이 총점과 같을 때만
 * 이닝을 말하고 아니면 아무 말도 하지 않는다.
 *
 * @param {object|null|undefined} board fetchScoreboard() 결과
 * @param {'home'|'away'} side 점수를 낸 쪽
 * @param {number} score 그 쪽의 현재 총점 (schedule API 값)
 */
function scoringInning(board, side, score) {
  const innings = board?.[side]?.innings;
  if (!inningSumMatches(innings, score)) return null;

  // 합이 맞으므로 마지막으로 점수가 난 이닝이 방금 그 이닝이다.
  for (let i = innings.length - 1; i >= 0; i--) {
    if ((Number(innings[i]) || 0) > 0) return `${i + 1}회${side === 'home' ? '말' : '초'}`;
  }
  return null;
}

/**
 * @param {object|null} prev DB에 저장돼 있던 직전 스냅샷 (없으면 null)
 * @param {object} cur  방금 조회한 현재 상태 (normalizeGame 결과)
 * @param {string} teamCode 알림 대상 팀 코드
 * @returns {Array<{kind,scope,series,dedupKey,title,body}>}
 */
export function detectEvents(prev, cur, teamCode) {
  if (!prev) return [];

  const events = [];
  const p = perspective(cur, teamCode);

  // "삼성과의 경기" / "롯데와의 경기" — 받침에 따라 조사가 갈린다.
  // es-hangul 의 josa 는 KT·SSG 같은 영문 약어도 한글 발음(케이티·에스에스지)으로
  // 읽어 조사를 고르므로 팀명을 예외 처리할 필요가 없다.
  const matchup = `${josa(p.oppName, '와/과')}의 ${p.isHome ? '홈' : '원정'} 경기`;
  const where = cur.stadium ? ` (${cur.stadium})` : '';
  const t = tag(cur.series);
  const scope = isPostseason(cur.series) ? 'postseason' : 'regular';

  /*
   * isHome 은 "홈경기만 받기" 설정을 거르는 데 쓰인다.
   *
   * kind 와 recordKind 를 나눈 이유 — 둘은 쓰이는 곳이 다르다.
   *
   *   kind       알림을 누구에게 보낼지 정하는 값. KIND_COLUMN 을 거쳐
   *              subscriptions 의 on/off 컬럼을 고르고, sw.js 의 진동 패턴도
   *              이 값으로 고른다. 여기 없는 값을 쓰면 subscribersFor 가 조용히
   *              빈 배열을 돌려줘 알림이 아예 안 나가므로 KINDS 안에서만 쓴다.
   *   recordKind events 테이블에 저장돼 기록 탭 타임라인이 읽는 값. 화면 라벨과
   *              아이콘이 이 값으로 정해진다(app.js KIND_LABEL). 발송 경로를
   *              타지 않으므로 'concede' 처럼 KINDS 밖의 값을 써도 안전하다.
   *
   * 생략하면 recordKind 는 kind 와 같다. 실점만 둘을 다르게 준다 — 알림은
   * 득점(score)으로 보내되 기록에는 실점(concede)으로 남긴다.
   */
  const push = (kind, dedupKey, title, body, recordKind = kind) =>
    events.push({
      kind, recordKind, scope, series: cur.series, isHome: p.isHome, dedupKey, title, body,
    });

  // 1) 경기 취소 — 취소된 경기는 시작/종료 알림을 낼 이유가 없으므로 여기서 끝낸다.
  if (!prev.cancelled && cur.cancelled) {
    push('cancel', `${cur.gameId}:cancel`, `${t}경기 취소`, `${matchup}가 취소됐어요.${where}`);
    return events;
  }
  if (cur.cancelled) return events;

  // 2) 경기 시작
  if (prev.phase === 'before' && cur.phase === 'live') {
    push('start', `${cur.gameId}:start`, `${t}경기 시작`, `${matchup}가 시작됐어요.${where}`);
  }

  // 3) 득점 — 점수가 변한 경기 중 상태에서만. 어느 팀이 냈는지 구분해 알린다.
  // prev 스냅샷에는 팀명이 없지만(db.js 저장 컬럼에 없음) perspective() 는 점수만
  // 봐도 정상 동작한다 — teamName/oppName 을 쓰지 않으므로 undefined 여도 무해하다.
  const pPrev = perspective(prev, teamCode);
  const teamGained = p.teamScore - pPrev.teamScore;
  const oppGained = p.oppScore - pPrev.oppScore;

  if (cur.phase === 'live' && (teamGained !== 0 || oppGained !== 0)) {
    const ours = teamGained > 0 && oppGained === 0;
    const both = teamGained > 0 && oppGained > 0;

    /*
     * 상대가 낸 점수도 "실점"이 아니라 "득점"으로 쓴다 — 알림함에서 스치듯
     * 볼 때는 우리 팀 시점보다 "누가 몇 점 냈다"가 바로 읽힌다. 느낌표는
     * 우리 득점에만 붙인다.
     *
     * 기록 탭에서 "실점"으로 보이는 것은 이 문구가 아니라 아래 recordKind 가
     * 정한다(app.js KIND_LABEL.concede). 그래서 문구를 바꿔도 기록 화면의
     * 라벨·아이콘 판정은 흔들리지 않는다.
     */
    const who = both
      ? '양 팀 득점'
      : ours
        ? `${p.teamName} ${teamGained}점 득점!`
        : `${p.oppName} ${oppGained}점 득점`;

    /*
     * 이번 틱 사이에 새로 생긴 홈런 기록만 골라 원문 그대로 붙인다.
     * (cur.hr·prev.hr 는 fetchScoreboard() 가 etcRecords 에서 뽑아 온
     * "오스틴33호(8회3점 손주환)" 형태의 문자열 목록 — kbo.js 참고.)
     * "몇 점 중 몇 점이 홈런인지"를 여기서 다시 계산하지 않는다 — 원문에
     * 이미 선수명·이닝·타점이 다 있어서, 굳이 뽑아 재조합하면 잘못 계산할
     * 여지만 늘어난다.
     */
    const newHomeruns = (cur.hr ?? []).filter((r) => !(prev.hr ?? []).includes(r));

    // 양 팀이 같은 틱에 점수를 냈으면 이닝이 하나로 정해지지 않는다 — 생략한다.
    const side = both ? null : (teamGained > 0) === p.isHome ? 'home' : 'away';
    const inning = side
      ? scoringInning(cur.board, side, side === 'home' ? cur.homeScore : cur.awayScore)
      : null;

    push(
      'score',
      // 점수 조합을 키에 넣어, 같은 경기의 서로 다른 득점 상황이 각각 발송되게 한다.
      `${cur.gameId}:score:${cur.homeScore}-${cur.awayScore}`,
      `${t}${who}`,
      `${scoreLine(cur, teamCode)}${inning ? ` · ${inning}` : ''}`
        + (newHomeruns.length ? ` · ${newHomeruns.join(', ')}` : ''),
      // 상대만 점수를 냈으면 기록에는 실점으로 남긴다. 알림 발송은 그대로 score.
      both || ours ? 'score' : 'concede',
    );
  }

  // 4) 경기 종료
  if (prev.phase !== 'result' && cur.phase === 'result') {
    const diff = p.teamScore - p.oppScore;
    const verdict = diff > 0 ? '승리' : diff < 0 ? '패배' : '무승부';
    push('end', `${cur.gameId}:end`, `${t}경기 종료 · ${p.teamName} ${verdict}`, scoreLine(cur, teamCode));
  }

  return events;
}

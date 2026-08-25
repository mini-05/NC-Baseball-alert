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
import { perspective, SERIES, isPostseason } from './kbo.js';

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

  // isHome 은 "홈경기만 받기" 설정을 거르는 데 쓰인다.
  const push = (kind, dedupKey, title, body) =>
    events.push({ kind, scope, series: cur.series, isHome: p.isHome, dedupKey, title, body });

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
    const who =
      teamGained > 0 && oppGained > 0
        ? '양 팀 득점'
        : teamGained > 0
          ? `${p.teamName} ${teamGained}점 득점!`
          : `${p.oppName} ${oppGained}점 실점`;

    // 이번 틱 사이에 홈런이 하나라도 새로 생겼으면 표시한다. 홈런 자체는
    // fetchScoreboard() 가 etcRecords 에서 세어 cur.hr 로 넘겨받는다(kbo.js).
    const newHomerun = cur.hr > (prev.hr ?? 0);

    push(
      'score',
      // 점수 조합을 키에 넣어, 같은 경기의 서로 다른 득점 상황이 각각 발송되게 한다.
      `${cur.gameId}:score:${cur.homeScore}-${cur.awayScore}`,
      `${t}${who}`,
      `${scoreLine(cur, teamCode)}${cur.statusInfo ? ` · ${cur.statusInfo}` : ''}${newHomerun ? ' (홈런)' : ''}`,
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

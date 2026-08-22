/**
 * 직전 스냅샷과 현재 상태를 비교해 알림 이벤트를 만든다.
 *
 * 설계 원칙
 * - 처음 보는 경기(prev === null)는 기록만 하고 알리지 않는다. 배포 직후나
 *   DB 초기화 후에 과거 경기들이 한꺼번에 알림으로 쏟아지는 것을 막기 위함이다.
 * - 모든 이벤트는 dedup_key 를 갖는다. 크론이 중복 실행되거나 재시도돼도
 *   같은 전이가 두 번 발송되지 않는다.
 */

import { perspective } from './kbo.js';

export const KINDS = ['start', 'cancel', 'score', 'end'];

/** 알림 종류 → subscriptions 테이블의 on/off 컬럼명 */
export const KIND_COLUMN = {
  start: 'on_start',
  cancel: 'on_cancel',
  score: 'on_score',
  end: 'on_end',
};

export const KIND_LABEL = {
  start: '경기 시작',
  cancel: '경기 취소',
  score: '득점',
  end: '경기 종료',
};

/** "NC 3 : 2 삼성" 형태의 스코어 문자열 (대상 팀을 항상 왼쪽에 둔다) */
function scoreLine(game, teamCode) {
  const p = perspective(game, teamCode);
  return `${p.teamName} ${p.teamScore} : ${p.oppScore} ${p.oppName}`;
}

/**
 * @param {object|null} prev DB에 저장돼 있던 직전 스냅샷 (없으면 null)
 * @param {object} cur  방금 조회한 현재 상태 (normalizeGame 결과)
 * @param {string} teamCode 알림 대상 팀 코드
 * @returns {Array<{kind,dedupKey,title,body}>}
 */
export function detectEvents(prev, cur, teamCode) {
  if (!prev) return [];

  const events = [];
  const p = perspective(cur, teamCode);
  const vs = `${p.isHome ? 'vs' : '@'} ${p.oppName}`;

  // 1) 경기 취소 — 취소된 경기는 시작/종료 알림을 낼 이유가 없으므로 여기서 끝낸다.
  if (!prev.cancelled && cur.cancelled) {
    events.push({
      kind: 'cancel',
      dedupKey: `${cur.gameId}:cancel`,
      title: '경기 취소',
      body: `${p.teamName} ${vs} 경기가 취소됐습니다.${cur.stadium ? ` (${cur.stadium})` : ''}`,
    });
    return events;
  }
  if (cur.cancelled) return events;

  // 2) 경기 시작
  if (prev.phase === 'before' && cur.phase === 'live') {
    events.push({
      kind: 'start',
      dedupKey: `${cur.gameId}:start`,
      title: '경기 시작',
      body: `${p.teamName} ${vs} 경기가 시작됐습니다.${cur.stadium ? ` (${cur.stadium})` : ''}`,
    });
  }

  // 3) 득점 — 점수가 변한 경기 중 상태에서만. 어느 팀이 냈는지 구분해 알린다.
  const teamGained = p.teamScore - (prev.homeCode === teamCode ? prev.homeScore : prev.awayScore);
  const oppGained = p.oppScore - (prev.homeCode === teamCode ? prev.awayScore : prev.homeScore);

  if (cur.phase === 'live' && (teamGained !== 0 || oppGained !== 0)) {
    const who =
      teamGained > 0 && oppGained > 0
        ? '양 팀 득점'
        : teamGained > 0
          ? `${p.teamName} ${teamGained}점 득점!`
          : `${p.oppName} ${oppGained}점 실점`;

    events.push({
      kind: 'score',
      // 점수 조합을 키에 넣어, 같은 경기의 서로 다른 득점 상황이 각각 발송되게 한다.
      dedupKey: `${cur.gameId}:score:${cur.homeScore}-${cur.awayScore}`,
      title: who,
      body: `${scoreLine(cur, teamCode)}${cur.statusInfo ? ` · ${cur.statusInfo}` : ''}`,
    });
  }

  // 4) 경기 종료
  if (prev.phase !== 'result' && cur.phase === 'result') {
    const diff = p.teamScore - p.oppScore;
    const verdict = diff > 0 ? '승리' : diff < 0 ? '패배' : '무승부';
    events.push({
      kind: 'end',
      dedupKey: `${cur.gameId}:end`,
      title: `경기 종료 · ${p.teamName} ${verdict}`,
      body: scoreLine(cur, teamCode),
    });
  }

  return events;
}

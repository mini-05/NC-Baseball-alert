/**
 * 직전 스냅샷과 현재 상태를 비교해서 알림 이벤트를 만든다.
 *
 * - 처음 보는 경기(prev === null)는 저장만 하고 알리지 않는다. 배포 직후나
 *   DB를 비운 뒤 지난 경기 알림이 한꺼번에 나가는 걸 막으려는 것.
 * - 이벤트마다 dedup_key 가 있어서 크론이 겹쳐 돌아도 같은 알림은 한 번만 나간다.
 */

import { josa } from 'es-hangul';
import { perspective, SERIES, scopeOf, inningSumMatches } from './kbo.js';

/** 알림 종류 → subscriptions 테이블의 on/off 컬럼명 */
export const KIND_COLUMN = {
  start: 'on_start',
  cancel: 'on_cancel',
  score: 'on_score',
  end: 'on_end',
};

/**
 * events.kind(기록용 값)를 발송 종류로 바꾼다.
 *
 * 실점은 concede 로 저장되는데(아래 push 참고) KIND_COLUMN 에는 concede 가 없다.
 * 그대로 subscribersFor 에 넘기면 빈 배열이 와서 재발송 때 실점만 빠진다.
 */
export function dispatchKindOf(recordKind) {
  return recordKind === 'concede' ? 'score' : recordKind;
}

/** 시리즈 범위 → subscriptions 테이블의 on/off 컬럼명 */
export const SCOPE_COLUMN = {
  regular: 'on_regular',
  postseason: 'on_postseason',
};

/** 포스트시즌 경기는 제목 앞에 [준PO] 같은 시리즈 표시를 붙인다. */
function tag(series) {
  const short = SERIES[series]?.short;
  return short ? `[${short}] ` : '';
}

/** "NC 3 : 2 삼성" 형태. 우리 팀이 항상 왼쪽. */
function scoreLine(game, teamCode) {
  const p = perspective(game, teamCode);
  return `${p.teamName} ${p.teamScore} : ${p.oppScore} ${p.oppName}`;
}

/**
 * 전광판에서 득점 이닝을 찾는다. 확실하지 않으면 null.
 *
 * statusInfo("5회초")는 폴링한 시점의 이닝이라 쓰지 않는다. 이닝이 바뀐 직후에
 * 폴링하면 한 칸 밀린 이닝이 나온다.
 *
 * 총점은 schedule API, 이닝별 점수는 record API 에서 따로 받기 때문에(kbo.js)
 * 둘의 시점이 어긋날 수 있다. 이닝별 합이 총점과 같을 때만 이닝을 붙인다.
 *
 * @param {object|null|undefined} board fetchScoreboard() 결과
 * @param {'home'|'away'} side 점수를 낸 쪽
 * @param {number} score 그 쪽의 현재 총점 (schedule API 값)
 */
function scoringInning(board, side, score) {
  const innings = board?.[side]?.innings;
  if (!inningSumMatches(innings, score)) return null;

  // 합이 맞으면 마지막으로 점수가 난 이닝이 이번 득점 이닝이다.
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

  // "삼성과의 경기" / "롯데와의 경기". es-hangul josa 는 KT·SSG 같은 영문도
  // 한글 발음(케이티·에스에스지) 기준으로 조사를 고른다.
  const matchup = `${josa(p.oppName, '와/과')}의 ${p.isHome ? '홈' : '원정'} 경기`;
  const where = cur.stadium ? ` (${cur.stadium})` : '';
  const t = tag(cur.series);
  const scope = scopeOf(cur.series);

  /*
   * isHome: "홈경기만 받기" 필터용.
   *
   * kind       발송용. KIND_COLUMN 으로 구독 on/off 컬럼을 고르고 sw.js 진동
   *            패턴도 이걸로 정한다. KIND_COLUMN 에 없는 값이면 수신자가 0명이 된다.
   * recordKind 기록용. events 에 저장되고 기록 탭 라벨·아이콘(app.js KIND_LABEL)이
   *            이걸 본다. 발송에는 안 쓰여서 'concede' 처럼 KIND_COLUMN 에 없는 값도 된다.
   *
   * 기본은 둘이 같고, 실점만 kind=score / recordKind=concede 로 갈린다.
   */
  const push = (kind, dedupKey, title, body, recordKind = kind) =>
    events.push({
      kind, recordKind, scope, series: cur.series, isHome: p.isHome, dedupKey, title, body,
    });

  // 1) 경기 취소. 취소된 경기는 시작·종료 알림이 필요 없어 여기서 끝낸다.
  if (!prev.cancelled && cur.cancelled) {
    push('cancel', `${cur.gameId}:cancel`, `${t}경기 취소`, `${matchup}가 취소됐어요.${where}`);
    return events;
  }
  if (cur.cancelled) return events;

  // 2) 경기 시작
  if (prev.phase === 'before' && cur.phase === 'live') {
    push('start', `${cur.gameId}:start`, `${t}경기 시작`, `${matchup}가 시작됐어요.${where}`);
  }

  // 3) 득점. 경기 중에 점수가 오른 경우만 보고, 어느 팀이 냈는지 나눠 알린다.
  // prev 에는 팀명이 없지만(db.js 에 저장 안 함) 여기선 점수만 쓰니 상관없다.
  const pPrev = perspective(prev, teamCode);
  const teamGained = p.teamScore - pPrev.teamScore;
  const oppGained = p.oppScore - pPrev.oppScore;

  /*
   * 점수가 올라갔을 때만 알린다. 네이버가 기록을 정정하거나 잠깐 예전 값·0:0 을
   * 줄 때가 있어서, 변화만 보면 "삼성 -2점 득점" 같은 알림이 나간다(실제로 있었음).
   * 점수가 내려간 건 알리지 않는다. 스냅샷은 호출부(index.js poll)에서 따로 갱신된다.
   */
  if (cur.phase === 'live' && (teamGained > 0 || oppGained > 0)) {
    // 상대 점수가 정정돼 내려간 틱(oppGained < 0)도 우리 득점으로 친다.
    // === 0 으로 비교하면 이때 상대 득점 문구가 나간다.
    const ours = teamGained > 0 && oppGained <= 0;
    const both = teamGained > 0 && oppGained > 0;

    /*
     * 상대 점수도 "실점"이 아니라 "○○ 2점 득점"으로 쓴다. 알림함에서 훑어볼 땐
     * 누가 냈는지가 더 빨리 읽힌다. 느낌표는 우리 득점에만.
     *
     * 기록 탭의 "실점" 라벨은 이 문구가 아니라 recordKind 로 정해진다.
     */
    const who = both
      ? '양 팀 득점'
      : ours
        ? `${p.teamName} ${teamGained}점 득점!`
        : `${p.oppName} ${oppGained}점 득점`;

    /*
     * 지난 틱 이후 새로 생긴 홈런 기록만 원문 그대로 붙인다.
     * hr 은 fetchScoreboard() 가 etcRecords 에서 뽑은 "오스틴33호(8회3점 손주환)"
     * 형태의 문자열 목록이다(kbo.js). 선수·이닝·타점이 이미 들어 있어서 따로
     * 계산하지 않는다.
     */
    const newHomeruns = (cur.hr ?? []).filter((r) => !(prev.hr ?? []).includes(r));

    // 양 팀이 같은 틱에 득점했으면 이닝을 하나로 못 정하니 생략.
    const side = both ? null : (teamGained > 0) === p.isHome ? 'home' : 'away';
    const inning = side
      ? scoringInning(cur.board, side, side === 'home' ? cur.homeScore : cur.awayScore)
      : null;

    push(
      'score',
      // 점수 조합을 키에 넣어서 득점 상황마다 따로 발송되게 한다.
      `${cur.gameId}:score:${cur.homeScore}-${cur.awayScore}`,
      `${t}${who}`,
      `${scoreLine(cur, teamCode)}${inning ? ` · ${inning}` : ''}`
        + (newHomeruns.length ? ` · ${newHomeruns.join(', ')}` : ''),
      // 상대만 득점했으면 기록에는 실점으로 남긴다. 발송은 score 그대로.
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

/* NC 다이노스 경기 알림 — PWA 클라이언트 */

/*
 * 테마. 최대한 이르게(파일 맨 위에서) 적용해 깜빡임을 줄인다.
 * CSP(script-src 'self')가 인라인 스크립트를 막아 <head> 에서 더 일찍 적용할 수는
 * 없다 — 'unsafe-inline' 을 허용하는 대신 이 정도 지연을 감수했다.
 * 'auto' 는 저장하지 않는다: 값이 없으면 곧 시스템 설정(prefers-color-scheme)을
 * 그대로 따르는 것이 'auto' 이기 때문이다.
 */
const THEME_KEY = 'theme';

function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') {
    document.documentElement.setAttribute('data-theme', theme);
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
}

applyTheme(localStorage.getItem(THEME_KEY));

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

/**
 * DOM 생성 헬퍼.
 *
 * 문자열을 innerHTML 로 조립하지 않는 이유: 경기 데이터는 외부 API에서 온다.
 * 팀명·구장·상황("7회말") 같은 값이 언제든 태그처럼 생긴 문자열이 될 수 있는데,
 * 아래처럼 textContent 로만 넣으면 XSS 가 성립할 여지 자체가 없어진다.
 */
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else node.setAttribute(key, value);
  }

  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

const clear = (node) => { while (node.firstChild) node.firstChild.remove(); };

/**
 * Tossface 아이콘. index.html 에 인라인된 <symbol> 을 참조한다.
 * 같은 문서 안의 참조라 외부 SVG use 의 브라우저 호환 문제가 없다.
 */
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'tf');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#tf-${name}`);
  svg.append(use);
  return svg;
}

const KIND_LABEL = { start: '시작', cancel: '취소', score: '득점', concede: '실점', end: '종료', test: '테스트' };

/*
 * 득점·실점 구분. 서버가 알림 제목에 이미 "NC 3점 득점!" / "두산 2점 실점" 으로
 * 써 두었으므로 여기서 점수를 다시 계산하지 않고 그 문구를 그대로 믿는다.
 * ponytail: 제목 문구 의존. detect.js 의 who 문구를 바꾸면 여기도 같이 손본다.
 */
const tlKind = (e) => (e.kind === 'score' && e.title?.includes('실점') ? 'concede' : e.kind);
const SERIES_SHORT = {
  tiebreaker: '순위결정전',
  wildcard: '와일드카드',
  semi_playoff: '준PO',
  playoff: 'PO',
  korean_series: '한국시리즈',
};

const SETTING_KEYS = ['start', 'cancel', 'score', 'end', 'regular', 'postseason', 'homeOnly'];

let teamCode = 'NC';
let subscription = null; // 현재 기기의 PushSubscription

/* ─────────── 공통 ─────────── */

async function api(path, options) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `요청 실패 (${res.status})`);
  return data;
}

let toastTimer;
function toast(message) {
  const box = $('#toast');
  box.textContent = message;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, 2800);
}

function urlBase64ToUint8Array(base64) {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4))
    .replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function serialize(sub) {
  const j = sub.toJSON();
  return { endpoint: sub.endpoint, keys: { p256dh: j.keys.p256dh, auth: j.keys.auth } };
}

/* ─────────── 탭 ─────────── */

/**
 * .topbar(제목+탭 메뉴) 는 sticky 로 화면 위에 고정된다. 일정 탭의 .sched-fixed
 * 가 그 바로 아래에 이어 붙으려면 정확한 높이가 필요한데, 폰트 로딩·글자 크기
 * 설정 등으로 실제 렌더 높이가 미묘하게 달라질 수 있어 하드코딩하지 않고
 * ResizeObserver 로 실측해 CSS 변수에 반영한다.
 */
{
  const topbar = $('.topbar');
  const syncTopbarHeight = () => {
    document.documentElement.style.setProperty('--topbar-h', `${topbar.offsetHeight}px`);
  };

  // ResizeObserver 는 관측 시작 시 콜백을 한 번 비동기로 보내주는 게 스펙이지만,
  // 그 첫 콜백이 오기 전 스크롤이 먼저 일어나면 --topbar-h 가 비어 있어
  // .sched-fixed 가 topbar 와 겹친다. 그래서 최초 값은 여기서 동기적으로
  // 먼저 채워 두고, 이후 폰트 로딩 등으로 실제 높이가 바뀌는 경우만 관측자에 맡긴다.
  syncTopbarHeight();
  if ('ResizeObserver' in window) new ResizeObserver(syncTopbarHeight).observe(topbar);
}

const TAB_KEY = 'tab';

/**
 * 탭을 켠다. 없는 이름이면 아무것도 바꾸지 않고 false 를 준다.
 *
 * 탭 목록을 따로 두지 않고 그때그때 DOM 에서 찾는다 — 탭이 늘거나 줄어도
 * index.html 만 고치면 되고 이 파일은 그대로다.
 */
function activateTab(name) {
  const tabs = $$('.tab');
  const tab = tabs.find((t) => t.dataset.tab === name);
  if (!tab) return false;

  tabs.forEach((t) => t.classList.toggle('is-active', t === tab));
  $$('.panel').forEach((p) => p.classList.toggle('is-active', p.id === `panel-${name}`));
  return true;
}

$$('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    const name = tab.dataset.tab;
    activateTab(name);

    // 새로고침·앱 재실행 후에도 보던 탭으로 돌아오게 한다. 테마와 같은 방식이다.
    localStorage.setItem(TAB_KEY, name);

    // 일정 탭을 열 때 리스트가 기본으로 보이는 뷰라면 오늘 경기 위치로 맞춘다.
    // 패널이 display:none 인 동안은 scrollIntoView 가 아무 효과가 없으므로,
    // 반드시 패널이 보이게 된 "이 시점"에 호출해야 한다.
    if (name === 'schedule' &&
        document.querySelector('.view-btn.is-active')?.dataset.view === 'list') {
      scrollListToToday();
    }
  });
});

/*
 * 마지막으로 보던 탭 복원.
 *
 * 저장된 값이 없거나(첫 방문) 그 탭이 사라졌으면 activateTab 이 false 를 주고,
 * 마크업에 이미 붙어 있는 is-active 가 그대로 기본값이 된다.
 */
activateTab(localStorage.getItem(TAB_KEY));

/**
 * 좌우 스와이프로 탭을 넘긴다. 탭 버튼 클릭과 같은 경로(.tab.click())를 타서
 * 스크롤-투데이 같은 부수 동작도 그대로 적용된다.
 *
 * 전광판(.scorebox-wrap)은 자체 가로 스크롤 표라, 그 안에서 시작한 터치는
 * 스와이프 판정에서 제외한다 — 표를 넘겨 보려는 손짓이 탭 전환으로 새면 안 된다.
 */
{
  // 순서는 마크업의 탭 순서를 그대로 따른다. 탭이 늘어도 고칠 곳이 없다.
  const TAB_ORDER = $$('.tab').map((t) => t.dataset.tab);
  const SWIPE_MIN_X = 60; // 오탭 방지용 최소 이동 거리
  let touchStartX = 0;
  let touchStartY = 0;
  let touchStartTarget = null;

  const main = $('main');

  main.addEventListener('touchstart', (ev) => {
    const t = ev.touches[0];
    touchStartX = t.clientX;
    touchStartY = t.clientY;
    touchStartTarget = ev.target;
  }, { passive: true });

  main.addEventListener('touchend', (ev) => {
    if (touchStartTarget?.closest('.scorebox-wrap')) return;

    const t = ev.changedTouches[0];
    const dx = t.clientX - touchStartX;
    const dy = t.clientY - touchStartY;

    // 가로로 충분히, 세로보다 뚜렷하게 움직인 경우만 스와이프로 본다.
    if (Math.abs(dx) < SWIPE_MIN_X || Math.abs(dx) < Math.abs(dy) * 1.5) return;

    const activeTab = document.querySelector('.tab.is-active')?.dataset.tab;
    const i = TAB_ORDER.indexOf(activeTab);
    if (i < 0) return;

    const next = TAB_ORDER[dx < 0 ? i + 1 : i - 1]; // 왼쪽으로 밀면 다음 탭
    if (next) document.querySelector(`.tab[data-tab="${next}"]`)?.click();
  }, { passive: true });
}

/* ─────────── 순위 · 포스트시즌 ─────────── */

/**
 * 전체 순위표. 포스트시즌 진출 구간을 구분선으로 나눠 보여준다.
 *
 * 진출 기준(1위 한국시리즈 / 4~5위 와일드카드 등)은 서버가 순위 API 응답의
 * postSeason.teamColors 를 그대로 넘겨준 것이라, KBO 가 규칙을 바꿔도 따라간다.
 */
function renderTable(standings) {
  const box = $('#table');
  clear(box);

  if (!standings?.teams?.length) {
    box.append(el('p', { class: 'empty' }, '순위 정보를 불러올 수 없어요.', el('br'), '비시즌일 수 있습니다.'));
    return;
  }

  const tiers = standings.tiers ?? [];
  const rows = [];

  /*
   * 오늘 경기가 아직 안 끝난 팀이 하나라도 있을 때만 반영 표시를 붙인다.
   * 다 끝났거나 경기가 없는 날은 표시할 것이 없으므로 아예 그리지 않는다 —
   * 모든 줄에 체크가 붙어 있는 화면은 아무 정보도 주지 않는다.
   */
  const showMarks = standings.teams.some((t) => t.todayGame === 'pending');

  for (const t of standings.teams) {
    // 이 순위에서 시작하는 진출 구간이 있으면 라벨을 먼저 넣는다.
    const tier = tiers.find((x) => x.from === t.rank);
    if (tier) rows.push(el('p', { class: 'tier-label', text: tier.title }));

    const isMine = t.code === teamCode;

    // 팀명 바로 뒤에 붙인다. 따로 칸을 만들면 좁은 화면에서 이름이 밀린다.
    const mark = showMarks && t.todayGame
      ? el('span', {
          class: `tmark ${t.todayGame}`,
          text: t.todayGame === 'done' ? '✓' : '•',
          title: t.todayGame === 'done' ? '오늘 경기 반영됨' : '오늘 경기 미반영',
        })
      : null;

    rows.push(
      el('div', { class: `trow${isMine ? ' mine' : ''}` },
        el('span', { class: 'trank', text: String(t.rank) }),
        el('span', { class: 'tname' }, t.name, mark),
        el('span', { class: 'trec', text: `${t.wins}승 ${t.draws}무 ${t.losses}패` }),
        el('span', { class: 'tpct', text: t.pct.toFixed(3).replace(/^0/, '') }),
        el('span', { class: 'tgb', text: t.gb === 0 ? '-' : t.gb.toFixed(1) }),
        el('span', { class: 'tleft', text: String(t.remaining ?? '') }),
      ),
    );

    // 진출권 마지막 순위 뒤에 선을 그어 경계를 분명히 한다.
    if (standings.cutoff && t.rank === standings.cutoff) {
      rows.push(el('div', { class: 'cutline' }, el('span', { text: '포스트시즌 진출선' })));
    }
  }

  box.append(
    el('div', { class: 'card table-card' },
      el('div', { class: 'thead' },
        el('span', { class: 'trank', text: '순위' }),
        el('span', { class: 'tname', text: '팀' }),
        el('span', { class: 'trec', text: '승-무-패' }),
        el('span', { class: 'tpct', text: '승률' }),
        el('span', { class: 'tgb', text: '승차' }),
        el('span', { class: 'tleft', text: '잔여' }),
      ),
      ...rows,
    ),
  );
}

/**
 * 순위가 언제 것인지 알려 주는 한 줄.
 *
 * 서버가 조회 시각(fetchedAt)을 함께 내려준다. 화면을 그린 시각이 아니라 이
 * 값을 써야 하는 이유: 네이버 조회가 실패하면 서버가 마지막으로 확인된 순위로
 * 되돌아가는데(season.js 의 getCacheStale), 그때 렌더 시각을 보여 주면 방금
 * 받아온 최신 순위처럼 보인다.
 */
const STANDINGS_STALE_MS = 30 * 60 * 1000; // 캐시 수명이 10분이라, 이보다 오래됐으면 갱신이 막힌 것이다

function standingsStamp(standings) {
  if (!standings) return '';

  // 이 기능이 나오기 전에 캐시된 값에는 fetchedAt 이 없다. 캐시가 갱신되면 사라진다.
  if (!standings.fetchedAt) return '경기 종료 시 갱신';

  const at = new Date(standings.fetchedAt);
  const time = at.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
  // 오늘 것이면 시각만, 지난 날짜면 날짜까지 밝힌다.
  const when =
    at.toDateString() === new Date().toDateString()
      ? time
      : `${at.getMonth() + 1}월 ${at.getDate()}일 ${time}`;

  return Date.now() - at.getTime() > STANDINGS_STALE_MS
    ? `${when} 기준 · 최신 순위를 불러오지 못했어요`
    : `${when} 기준 · 경기 종료 시 갱신`;
}

function renderStandings({ standings, outlook }) {
  renderTable(standings);

  const stamp = $('#standings-updated');
  if (stamp) stamp.textContent = standingsStamp(standings);

  const slot = $('#outlook');
  clear(slot);
  if (!standings || !outlook) return; // 비시즌이면 카드를 아예 띄우지 않는다.

  const { team, rank, cutoff, remaining, gamesBehindLine, tierTitle, status } = outlook;

  // 진출권 안일 때만 코랄. 시스템은 코랄을 아껴 쓴다.
  const pill =
    status === 'in'
      ? el('span', { class: 'pill in', text: tierTitle ?? '포스트시즌 진출권' })
      : status === 'eliminated'
        ? el('span', { class: 'pill out', text: '포스트시즌 탈락 확정' })
        : el('span', { class: 'pill', text: `${cutoff}위까지 ${gamesBehindLine}경기차` });

  // 문장은 서버가 es-hangul 로 조사까지 맞춰 내려준다. 여기서는 그대로 쓴다.
  const note = outlook.note ?? '';

  // 진출권까지의 거리를 시각화. 승차가 클수록 막대가 짧아진다.
  const progress = status === 'in' ? 1 : Math.max(0, 1 - gamesBehindLine / Math.max(remaining, 1));

  slot.append(
    el('div', { class: 'card card-outline' },
      el('div', { class: 'rank-line' },
        el('span', { class: 'rank-num', text: String(rank) }),
        el('span', { class: 'rank-unit', text: '위' }),
        el('span', {
          class: 'rank-record',
          text: `${team.wins}승 ${team.draws}무 ${team.losses}패 · ${team.pct.toFixed(3)}`,
        }),
      ),
      pill,
      el('p', { class: 'rank-note', text: note }),
      status !== 'eliminated' &&
        el('div', { class: 'gap-bar' }, el('i', { style: `width:${Math.round(progress * 100)}%` })),
    ),
  );
}

/* ─────────── 경기 기록 ─────────── */

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

function formatDay(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const wd = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${m}월 ${d}일 ${wd}요일`;
}

/** ISO 시각(UTC)을 24시간제 HH:MM 로. 이벤트 기록 시각에 쓴다. */
function clockOf(iso) {
  return new Date(iso).toLocaleTimeString('ko-KR', {
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

/** 서버가 저장한 KST 로컬시각 문자열. 시간대 변환 없이 그대로 읽는다. */
function formatStart(iso) {
  const m = /T(\d{2}):(\d{2})/.exec(iso || '');
  if (!m) return '';
  const h = Number(m[1]);
  return `${h < 12 ? '오전' : '오후'} ${h % 12 || 12}:${m[2]}`;
}

/**
 * 사용자가 직접 여닫은 경기. gameId → 열림 여부.
 *
 * 자동 갱신(20·60초)이 카드를 통째로 다시 그리므로, 이 기억이 없으면 펼쳐 둔
 * 경기가 갱신될 때마다 도로 접힌다. 명시적으로 누른 경기만 여기에 남고,
 * 나머지는 그때그때의 기본값(가장 최근 경기만 펼침)을 따른다.
 */
const gameOpenState = new Map();

function renderGame(g, defaultOpen) {
  // 홈/원정 관점은 서버가 이미 계산해 보낸다(perspective()) — /api/schedule 과 같은 방식.
  const isHome = g.isHome;
  const mine = { name: g.teamName, score: g.teamScore };
  const opp = { name: g.oppName, score: g.oppScore };

  const done = g.phase === 'result' && !g.cancelled;
  const diff = mine.score - opp.score;

  const status = g.cancelled
    ? '취소'
    : g.phase === 'live'
      ? (g.statusInfo || '경기 중')
      : g.phase === 'result'
        ? '종료'
        : formatStart(g.startAt);

  const isLive = g.phase === 'live' && !g.cancelled;

  // 시리즈 태그는 포스트시즌 경기에만 붙인다. 정규시즌 경기에는 표시하지 않는다.
  // 판단 근거는 서버가 내려주는 isPostseason 이며, 라벨만 여기서 고른다.
  const seriesTag =
    g.isPostseason && SERIES_SHORT[g.series]
      ? el('span', { class: 'tag' }, icon('post'), SERIES_SHORT[g.series])
      : null;

  const team = (t, lost) =>
    el('div', { class: `team${t === mine ? ' mine' : ''}${lost ? ' lost' : ''}` },
      el('div', { class: 'team-name', text: t.name }),
      el('div', { class: 'team-score', text: g.cancelled ? '–' : String(t.score) }),
    );

  const verdict = g.cancelled
    ? el('div', { class: 'verdict off', text: '경기 취소' })
    : done
      ? el('div', {
          class: `verdict ${diff > 0 ? 'win' : diff < 0 ? 'lose' : 'draw'}`,
          text: diff > 0 ? '승리' : diff < 0 ? '패배' : '무승부',
        })
      : null;

  /*
   * 시작·종료 시각.
   *
   * 알림 이벤트에 기록된 시각이 실제 관측 시각이라 가장 정확하다.
   * 다만 앱이 감시를 시작하기 전에 이미 끝난 경기에는 이벤트가 없으므로,
   * 그때는 편성 시각(startAt)으로 대신하고 '예정'임을 밝힌다.
   */
  const at = (kind) => {
    const e = g.events.find((x) => x.kind === kind);
    return e ? clockOf(e.createdAt) : null;
  };

  const observedStart = at('start');
  const observedEnd = at('end');

  const timeParts = [];
  if (observedStart) timeParts.push(`${observedStart} 시작`);
  else if (!g.cancelled) timeParts.push(`${formatStart(g.startAt)} 예정`);
  if (observedEnd) timeParts.push(`${observedEnd} 종료`);

  const times = timeParts.length
    ? el('div', { class: 'game-times', text: timeParts.join(' · ') })
    : null;

  const scoreboard = renderScoreboard(g.scoreboard, mine.name, opp.name);

  const timeline = g.events.length
    ? el('ul', { class: 'timeline' },
        g.events.map((e) =>
          el('li', { class: 'tl-item' },
            el('span', { class: 'tl-time', text: clockOf(e.createdAt) }),
            icon(tlKind(e)),
            el('span', { class: 'tl-body' },
              el('b', { class: 'tl-kind', text: KIND_LABEL[tlKind(e)] ?? e.kind }),
              e.body,
            ),
          ),
        ),
      )
    : null;

  /*
   * 접기·펼치기는 <details> 에 맡긴다 — 클릭 토글·키보드·스크린리더가 전부
   * 브라우저 기본 동작이라 직접 구현할 것이 없다.
   *
   * <summary>(항상 보임)에 경기 결과를, 그 아래(펼쳤을 때만 보임)에 전광판·
   * 시각·타임라인을 둔다. 접힌 상태에서 "결과만 간단히"가 그대로 나온다.
   */
  const open = gameOpenState.get(g.gameId) ?? defaultOpen;

  // 카드 색은 모든 경기가 같다. 진행 중 표시는 Live 태그가 맡는다.
  const card = el('details', { class: 'card game', open: open || null },
    el('summary', { class: 'game-summary' },
      el('div', { class: 'game-meta' },
        seriesTag,
        isLive ? el('span', { class: 'tag live', text: 'Live' }) : null,
        el('span', { text: `${g.stadium ?? ''} · ${isHome ? '홈' : '원정'}` }),
        el('span', { class: 'game-status', text: status }),
      ),
      el('div', { class: 'matchup' },
        team(mine, done && diff < 0),
        el('span', { class: 'colon', text: ':' }),
        team(opp, done && diff > 0),
      ),
      verdict,
    ),
    scoreboard,
    times,
    timeline,
  );

  /*
   * 기본값과 다를 때만 기억한다.
   *
   * open 속성을 달고 만든 <details> 는 DOM 에 붙을 때 toggle 이 한 번 발생한다.
   * 그것까지 "사용자가 폈다"로 저장하면, 기본으로 펼쳐졌던 어제 경기가 오늘
   * 경기 시작 후에도 계속 펼쳐진 채로 남는다. 기본값과 같아지면 기억을 지워
   * 그 뒤로는 다시 기본 규칙을 따르게 한다.
   */
  card.addEventListener('toggle', () => {
    if (card.open === defaultOpen) gameOpenState.delete(g.gameId);
    else gameOpenState.set(g.gameId, card.open);
  });
  return card;
}

/**
 * 전광판(이닝별 점수 표). 경기 전이거나 서버가 아직 못 가져왔으면(g.scoreboard
 * 가 null) 아무것도 그리지 않는다 — 없는 데이터를 빈 표로 보여주지 않는다.
 * 가로 폭이 좁은 화면에서 연장전(10회 이상)까지 다 담기면 넘칠 수 있어
 * 바깥을 가로 스크롤 컨테이너로 감싼다.
 */
function renderScoreboard(sb, teamLabel, oppLabel) {
  if (!sb) return null;

  const innings = Math.max(sb.team.innings.length, sb.opp.innings.length, 9);
  const at = (arr, i) => (arr[i] != null ? String(arr[i]) : '');

  const row = (label, side, isMine) =>
    el('tr', { class: isMine ? 'mine' : null },
      el('th', { text: label }),
      ...Array.from({ length: innings }, (_, i) => el('td', { text: at(side.innings, i) })),
      el('td', { class: 'sb-total', text: String(side.r) }),
      el('td', { text: String(side.h) }),
      el('td', { text: String(side.e) }),
      el('td', { text: String(side.b) }),
    );

  return el('div', { class: 'scorebox-wrap' },
    el('table', { class: 'scorebox' },
      el('thead', {},
        el('tr', {},
          el('th'),
          ...Array.from({ length: innings }, (_, i) => el('th', { text: String(i + 1) })),
          el('th', { text: 'R' }),
          el('th', { text: 'H' }),
          el('th', { text: 'E' }),
          el('th', { text: 'B' }),
        ),
      ),
      el('tbody', {}, row(teamLabel, sb.team, true), row(oppLabel, sb.opp, false)),
    ),
  );
}

/**
 * 진행 중인 경기가 있는지. 회차와 초·말이 계속 바뀌는 상태라는 뜻이라,
 * 자동 갱신 주기를 여기에 맞춘다. 판단 기준은 카드에 'Live' 를 붙이는 것과 같다.
 */
let liveGame = false;

async function loadHistory() {
  const box = $('#history');
  try {
    const { games } = await api('/api/history?days=30');
    liveGame = games.some((g) => g.phase === 'live' && !g.cancelled);
    clear(box);

    if (!games.length) {
      box.append(
        el('p', { class: 'empty' }, '아직 기록이 없어요.', el('br'), '경기가 열리면 여기에 쌓입니다.'),
      );
      return;
    }

    /*
     * 기본으로 펼칠 경기 하나를 고른다: "이미 시작한 것 중 가장 최근 경기".
     * 서버가 최신순으로 주므로 앞에서부터 처음 걸리는 것이 그것이다.
     *
     * 오늘 경기가 시작되면 그 경기가 이 자리를 가져가고, 직전까지 펼쳐져 있던
     * 어제 경기는 자동으로 접힌다 — 규칙 하나로 두 경우가 모두 처리된다.
     * 아직 시작 전인 경기는 펼쳐 봐야 보여 줄 내용이 없어 건너뛴다.
     */
    const featured = games.find((g) => g.phase !== 'before')?.gameId ?? null;

    const byDay = new Map();
    for (const g of games) {
      if (!byDay.has(g.gameDate)) byDay.set(g.gameDate, []);
      byDay.get(g.gameDate).push(g);
    }

    for (const [date, list] of byDay) {
      box.append(
        el('h2', { class: 'day-title', text: formatDay(date) }),
        ...list.map((g) => renderGame(g, g.gameId === featured)),
      );
    }
  } catch (err) {
    clear(box);
    box.append(el('p', { class: 'empty' }, '기록을 불러오지 못했어요.', el('br'), err.message));
  }
}

async function loadStandings() {
  try {
    renderStandings(await api('/api/standings'));
  } catch {
    /* 순위는 부가 정보다. 실패해도 기록 화면은 그대로 쓴다. */
  }
}

/* ─────────── 일정 ─────────── */

/**
 * dateStr 이 today 로부터 며칠 뒤인지. 0이면 오늘, 1이면 내일.
 * today 는 서버가 이미 계산해 준 KST 날짜 문자열('YYYY-MM-DD')을 그대로 받는다 —
 * 일정 목록의 매 행마다 new Date() 로 "오늘"을 다시 구할 이유가 없다.
 */
function daysFromToday(dateStr, today) {
  const [ay, am, ad] = today.split('-').map(Number);
  const [by, bm, bd] = dateStr.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

function relativeDay(dateStr, today) {
  const d = daysFromToday(dateStr, today);
  if (d === 0) return '오늘';
  if (d === 1) return '내일';
  if (d === 2) return '모레';
  return null;
}

const RESULT_LABEL = { win: '승', lose: '패', draw: '무' };

function renderScheduleItem(g, today) {
  const rel = relativeDay(g.gameDate, today);
  const isPast = g.gameDate < today;
  const isToday = g.gameDate === today;

  const seriesTag =
    SERIES_SHORT[g.series] && g.series !== 'regular'
      ? el('span', { class: 'tag' }, icon('post'), SERIES_SHORT[g.series])
      : null;

  // 지난 경기는 결과를, 예정 경기는 시각을 오른쪽에 둔다.
  const trailing = g.result
    ? el('div', { class: `sched-score ${g.result}` },
        el('span', { class: 'sched-vs', text: `${g.teamScore} : ${g.oppScore}` }),
        el('span', { class: 'sched-wl', text: RESULT_LABEL[g.result] }),
      )
    : null;

  const sub = g.cancelled
    ? '경기 취소'
    : isPast && !g.result
      ? (g.stadium ?? '')
      : `${formatStart(g.startAt)} · ${g.stadium ?? ''}`;

  const classes = [
    'sched',
    g.isHome && 'is-home',
    g.cancelled && 'is-off',
    isPast && !g.cancelled && 'is-past',
    isToday && 'is-today',
  ].filter(Boolean).join(' ');

  return el('article', { class: classes, 'data-date': g.gameDate },
    el('div', { class: 'sched-date' },
      el('span', { class: 'sched-md', text: g.gameDate.slice(5).replace('-', '.') }),
      el('span', { class: 'sched-rel', text: rel ?? formatDay(g.gameDate).split(' ')[2] }),
    ),
    el('div', { class: 'sched-main' },
      el('div', { class: 'sched-top' },
        el('span', { class: `hb ${g.isHome ? 'home' : 'away'}`, text: g.isHome ? '홈' : '원정' }),
        seriesTag,
        el('span', { class: 'sched-opp', text: g.oppName }),
      ),
      el('div', { class: 'sched-sub', text: sub }),
    ),
    trailing,
  );
}

/* ─────────── 일정 · 달력 ─────────── */


/** 마지막으로 불러온 일정. 리스트/달력 전환과 '오늘' 버튼이 재조회 없이 이 값을 함께 쓴다. */
let scheduleData = null;
let calendarMonth = null; // 'YYYY-MM'. 달력이 지금 보여주는 달.

/**
 * 리스트 뷰에서 날짜 카드를 찾아 화면 중앙으로 옮긴다.
 * 그 날짜에 경기가 없으면(휴식일) 그 이후 가장 가까운 경기로 대신한다 —
 * "오늘 경기, 없으면 내일 경기"를 일반화한 동작이다.
 */
function scrollListToDate(box, date) {
  const anchor =
    box.querySelector(`[data-date="${date}"]`) ??
    [...box.querySelectorAll('[data-date]')].find((n) => n.dataset.date > date);
  if (anchor) anchor.scrollIntoView({ block: 'center', behavior: 'smooth' });
  return Boolean(anchor);
}

/** 리스트가 켜질 때마다 호출한다: 오늘(없으면 다음) 경기를 화면 중앙으로. */
function scrollListToToday() {
  if (scheduleData) scrollListToDate($('#schedule-list'), scheduleData.today);
}

/** 리스트/달력 버튼 상태를 바꾸고 해당 뷰를 다시 그린다. 스크롤은 호출부가 필요할 때 따로 한다. */
function activateScheduleView(view) {
  $$('.view-btn').forEach((b) => b.classList.toggle('is-active', b.dataset.view === view));
  renderScheduleView();
}

function renderScheduleList(box, { games, today }) {
  clear(box);

  const played = games.filter((g) => g.result);
  const wins = played.filter((g) => g.result === 'win').length;
  const losses = played.filter((g) => g.result === 'lose').length;
  const draws = played.filter((g) => g.result === 'draw').length;
  const homeCount = games.filter((g) => g.isHome).length;

  // 요약줄은 카드 목록과 달리 #sched-fixed 안에 고정된 요소라, 매번 새로 만들지 않고
  // 내용만 갈아 끼운다 — '경기 알림' 제목부터 이 줄까지는 그대로 있고 카드만 스크롤되게
  // 하려는 것이 목적이라, 애초에 스크롤 영역(box) 안에 넣지 않는다.
  const summary = $('#sched-summary');
  clear(summary);
  summary.append(
    el('b', { text: `${games.length}경기` }),
    ' · 홈 ',
    el('b', { class: 'hl', text: `${homeCount}경기` }),
    played.length ? ` · ${wins}승 ${draws}무 ${losses}패` : '',
  );

  // 월별로 끊어 긴 목록을 훑기 쉽게 한다.
  let lastMonth = null;
  for (const g of games) {
    const month = g.gameDate.slice(0, 7);
    if (month !== lastMonth) {
      lastMonth = month;
      box.append(el('h2', { class: 'month-title', text: `${Number(month.slice(5))}월` }));
    }
    box.append(renderScheduleItem(g, today));
  }
}

/**
 * 달력 뷰. 한 달을 7열 격자로 그리고, 경기가 있는 날짜에 상대팀 이름(검정)과
 * 결과 배지(승 파랑 · 패 빨강 · 무 회색)를 얹는다. 홈경기는 배경을 한 단계
 * 진한 크림으로 칠해 원정과 구분한다.
 *
 * 날짜를 누르면 리스트 뷰로 전환해 그 날짜로 스크롤한다 — 달력은 훑어보는 용도,
 * 상세 확인은 리스트가 맡는 방식으로 역할을 나눴다.
 */
function renderCalendar(box, { games, today }) {
  clear(box);

  const byDate = new Map();
  for (const g of games) {
    if (!byDate.has(g.gameDate)) byDate.set(g.gameDate, []);
    byDate.get(g.gameDate).push(g);
  }

  const [y, m] = calendarMonth.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1));
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const leadBlanks = first.getUTCDay(); // 1일이 무슨 요일인지 (0=일)

  const monthDates = games.map((g) => g.gameDate.slice(0, 7));
  const canPrev = monthDates.some((d) => d < calendarMonth);
  const canNext = monthDates.some((d) => d > calendarMonth);

  const nav = el('div', { class: 'cal-nav' },
    el('button', { class: `cal-arrow${canPrev ? '' : ' is-disabled'}`, 'data-nav': '-1', text: '‹' }),
    el('span', { class: 'cal-title', text: `${y}년 ${m}월` }),
    el('button', { class: `cal-arrow${canNext ? '' : ' is-disabled'}`, 'data-nav': '1', text: '›' }),
  );

  const grid = el('div', { class: 'cal-grid' },
    ...WEEKDAYS.map((w) => el('div', { class: 'cal-dow', text: w })),
  );

  for (let i = 0; i < leadBlanks; i++) grid.append(el('div', { class: 'cal-cell is-blank' }));

  for (let d = 1; d <= daysInMonth; d++) {
    const date = `${calendarMonth}-${String(d).padStart(2, '0')}`;
    const dayGames = byDate.get(date) ?? [];
    const g = dayGames[0]; // 같은 날 더블헤더는 드물게만 있어 첫 경기만 표시한다.

    const cellClasses = [
      'cal-cell',
      date === today && 'cal-today',
      g && 'has-game',
      g?.isHome && 'is-home-game',
      g?.cancelled && 'is-off',
      // 승/패/무를 원 배지 대신 셀 테두리 색으로 표시한다. 홈/원정 구분(배경 명도)과
      // 별개로, 결과가 있는 날짜는 어느 쪽이든 이 테두리가 붙는다.
      g?.result && `result-${g.result}`,
    ].filter(Boolean).join(' ');

    const opp = g ? el('span', { class: 'cal-opp', text: g.oppName }) : null;

    grid.append(
      el('button', { class: cellClasses, type: 'button', 'data-date': date, disabled: !g },
        el('span', { class: 'cal-daynum', text: String(d) }),
        opp,
      ),
    );
  }

  box.append(nav, grid);
}

function renderScheduleView() {
  if (!scheduleData) return;

  const active = document.querySelector('.view-btn.is-active')?.dataset.view ?? 'list';
  $('#schedule-list').classList.toggle('is-active', active === 'list');
  $('#schedule-calendar').classList.toggle('is-active', active === 'calendar');
  // 요약줄은 리스트 전용 정보라, 고정 영역에 상시 존재하는 대신 리스트일 때만 보여준다.
  $('#sched-summary').hidden = active !== 'list';

  if (active === 'list') {
    renderScheduleList($('#schedule-list'), scheduleData);
  } else {
    calendarMonth ??= scheduleData.today.slice(0, 7);
    renderCalendar($('#schedule-calendar'), scheduleData);
  }
}

$$('.view-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    activateScheduleView(btn.dataset.view);
    // 리스트가 켜질 때마다("리스트 상태 on") 오늘 경기 위치로 다시 맞춘다.
    if (btn.dataset.view === 'list') scrollListToToday();
  });
});

$('#schedule-calendar').addEventListener('click', (ev) => {
  const nav = ev.target.closest('[data-nav]');
  if (nav && !nav.classList.contains('is-disabled')) {
    const [y, m] = calendarMonth.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + Number(nav.dataset.nav), 1));
    calendarMonth = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    renderCalendar($('#schedule-calendar'), scheduleData);
    return;
  }

  const cell = ev.target.closest('[data-date]');
  if (cell && !cell.disabled) {
    // activateScheduleView 로 직접 전환한다(view-btn.click() 을 거치면 위의
    // "오늘로 스크롤"이 먼저 실행돼 방금 고른 날짜로 다시 스크롤하는 두 번째
    // 애니메이션과 겹친다). 여기서는 고른 날짜로 곧장 한 번만 스크롤한다.
    activateScheduleView('list');
    scrollListToDate($('#schedule-list'), cell.dataset.date);
  }
});

$('#btn-today').addEventListener('click', () => {
  if (!scheduleData) return;
  const active = document.querySelector('.view-btn.is-active')?.dataset.view;

  if (active === 'calendar') {
    calendarMonth = scheduleData.today.slice(0, 7);
    renderCalendar($('#schedule-calendar'), scheduleData);
  } else {
    scrollListToToday();
  }
});

async function loadSchedule() {
  // 비어 있거나 실패했을 때의 안내는 지금 켜져 있는 뷰에 띄운다.
  // 기본이 달력이라, 리스트에만 넣으면 아무것도 안 보이는 화면이 된다.
  const box = () =>
    document.querySelector('.view-btn.is-active')?.dataset.view === 'calendar'
      ? $('#schedule-calendar')
      : $('#schedule-list');

  try {
    scheduleData = await api('/api/schedule');

    if (!scheduleData.games.length) {
      clear(box());
      box().append(
        el('p', { class: 'empty' }, '일정이 없어요.', el('br'), '비시즌이거나 일정이 아직 나오지 않았습니다.'),
      );
      return;
    }

    renderScheduleView();
    // 오늘 경기 위치로 맞추는 시점은 여기가 아니라 "일정 탭을 열 때"·"리스트로
    // 전환할 때"다(패널이 안 보이는 동안은 스크롤이 무효하다). .tab 클릭 핸들러 참고.
  } catch (err) {
    clear(box());
    box().append(el('p', { class: 'empty' }, '일정을 불러오지 못했어요.', el('br'), err.message));
  }
}

/* ─────────── 알림 설정 ─────────── */

function setPushUi(state, desc) {
  $('#push-desc').textContent = desc;

  // 알림이 꺼져 있을 때만 전면 코랄 콜아웃으로 바꿔 행동을 유도한다.
  // 켜진 뒤에는 평범한 크림 카드로 돌아간다 — 코랄은 아껴 쓰는 색이다.
  $('#push-card').classList.toggle('card-coral', state === 'off' || state === 'error');

  const btn = $('#btn-toggle');
  btn.textContent = state === 'on' ? '알림 끄기' : state === 'error' ? '다시 시도' : '알림 켜기';
  btn.disabled = state === 'unsupported';
  $('#btn-test').hidden = state !== 'on';
  $$('.sw input').forEach((i) => { i.disabled = state !== 'on'; });
}

function applySettings(settings) {
  $$('.sw input').forEach((input) => {
    input.checked = Boolean(settings?.[input.dataset.key]);
  });
}

async function enablePush() {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    toast('알림 권한이 거부됐어요. 브라우저 설정에서 허용해 주세요.');
    setPushUi('off', '알림 권한이 필요해요.');
    return;
  }

  const { vapidPublicKey } = await api('/api/config');

  // 초기화 때 등록이 실패했을 수 있으므로 다시 시도한다. register() 는 멱등이다.
  await navigator.serviceWorker.register('/sw.js');
  const reg = await navigator.serviceWorker.ready;

  subscription = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
  });

  const { settings } = await api('/api/subscribe', {
    method: 'POST',
    body: JSON.stringify(serialize(subscription)),
  });

  applySettings(settings);
  setPushUi('on', '이 기기로 알림을 보내드려요.');
  toast('알림이 켜졌어요');
}

async function disablePush() {
  if (!subscription) return;

  const { endpoint } = subscription;
  await subscription.unsubscribe().catch(() => {});
  await api('/api/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint }) });

  subscription = null;
  setPushUi('off', '이 기기에서 알림을 받으려면 켜 주세요.');
  toast('알림이 꺼졌어요');
}

/* ─────────── 테마 전환 ─────────── */

$$('.theme-btn').forEach((btn) => {
  btn.classList.toggle('is-active', btn.dataset.theme === (localStorage.getItem(THEME_KEY) ?? 'auto'));

  btn.addEventListener('click', () => {
    const theme = btn.dataset.theme;
    if (theme === 'auto') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, theme);

    applyTheme(theme);
    $$('.theme-btn').forEach((b) => b.classList.toggle('is-active', b === btn));
  });
});

$('#btn-toggle').addEventListener('click', async () => {
  const btn = $('#btn-toggle');
  btn.disabled = true;
  try {
    subscription ? await disablePush() : await enablePush();
  } catch (err) {
    toast(err.message);
    setPushUi('error', `알림을 준비하지 못했어요: ${err.message}`);
  } finally {
    if (btn.textContent !== '확인 중') btn.disabled = false;
  }
});

$('#btn-test').addEventListener('click', async () => {
  if (!subscription) return;
  try {
    await api('/api/test', {
      method: 'POST',
      body: JSON.stringify({ endpoint: subscription.endpoint }),
    });
    toast('테스트 알림을 보냈어요');
  } catch (err) {
    toast(err.message);
  }
});

$$('.sw input').forEach((input) => {
  input.addEventListener('change', async () => {
    if (!subscription) return;
    const key = input.dataset.key;
    if (!SETTING_KEYS.includes(key)) return;

    try {
      await api('/api/settings', {
        method: 'POST',
        body: JSON.stringify({ endpoint: subscription.endpoint, [key]: input.checked }),
      });
    } catch (err) {
      input.checked = !input.checked; // 서버 반영 실패 시 UI 를 되돌린다.
      toast(err.message);
    }
  });
});

/* ─────────── 시작 ─────────── */

async function initPush() {
  const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const standalone =
    window.navigator.standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches;

  if (isIos && !standalone) $('#ios-hint').hidden = false;

  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    setPushUi(
      'unsupported',
      isIos
        ? '홈 화면에 추가한 뒤 다시 열면 알림을 켤 수 있어요.'
        : '이 브라우저는 웹 푸시를 지원하지 않아요.',
    );
    $('#btn-toggle').textContent = '사용할 수 없음';
    return;
  }

  await navigator.serviceWorker.register('/sw.js');
  const reg = await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();

  if (!existing || Notification.permission !== 'granted') {
    setPushUi('off', '이 기기에서 알림을 받으려면 켜 주세요.');
    return;
  }

  subscription = existing;
  setPushUi('on', '이 기기로 알림을 보내드려요.');

  // 서버에 남아 있는 설정을 복원한다. 서버에서 사라졌다면 다시 등록한다.
  try {
    const { settings } = await api(
      `/api/settings?endpoint=${encodeURIComponent(existing.endpoint)}`,
    );
    applySettings(settings);
  } catch {
    const { settings } = await api('/api/subscribe', {
      method: 'POST',
      body: JSON.stringify(serialize(existing)),
    });
    applySettings(settings);
  }
}

(async function main() {
  try {
    const cfg = await api('/api/config');
    teamCode = cfg.teamCode || 'NC';
  } catch {
    /* 설정 조회 실패는 기본값으로 계속 진행 */
  }

  await Promise.all([loadHistory(), loadStandings(), loadSchedule()]);

  initPush().catch((err) => {
    setPushUi('error', `알림을 준비하지 못했어요: ${err.message}`);
    console.error('initPush failed', err);
  });

  /*
   * 자동 갱신. 새로고침 없이 화면이 따라오게 하는 경로는 세 가지다.
   *
   *  - 20초 주기(경기 중에만): 회차와 초·말이 바뀌는 곳은 경기 카드뿐이라
   *    기록만 다시 부른다. 서버 크론이 1분 간격이라 원본은 1분마다 갱신되는데,
   *    그 시점이 클라이언트 주기와 어긋나면 60초 주기로는 이미 바뀐 값을 다시
   *    60초 가까이 못 보게 된다(최악 2분). 20초로 좁혀 그 어긋남을 줄인다.
   *  - 60초 주기: 순위·일정까지 함께 맞춘다. 이 둘은 경기가 끝나야 바뀌므로
   *    짧은 주기에 끼울 이유가 없다 — 일정은 시즌 전체라 응답도 크다.
   *  - 푸시 수신 즉시: 득점·시작·종료가 감지되면 서비스 워커가 알려준다(sw.js).
   *    알림을 켠 기기에서는 폴링을 기다리지 않고 그 순간 반영된다.
   *
   * 화면을 보고 있지 않을 때는 요청하지 않는다. 모든 호출부가 아래 두 함수를
   * 지나므로 판단을 여기 한 곳에만 둔다.
   */
  const refresh = () => {
    if (document.hidden) return;
    loadHistory();
    loadStandings();
    loadSchedule();
  };

  const refreshLive = () => {
    if (document.hidden || !liveGame) return;
    loadHistory();
  };

  setInterval(refresh, 60_000);
  setInterval(refreshLive, 20_000);

  // 앱을 다시 볼 때 최신 상태로 갱신한다.
  document.addEventListener('visibilitychange', refresh);

  navigator.serviceWorker?.addEventListener('message', (ev) => {
    if (ev.data?.type === 'refresh') refresh();
  });
})();

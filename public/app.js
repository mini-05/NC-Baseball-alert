/* NC 다이노스 경기 알림 PWA 클라이언트 */

/*
 * 테마는 깜빡임을 줄이려고 파일 맨 위에서 적용한다. CSP 때문에 <head> 인라인
 * 스크립트는 못 쓴다('unsafe-inline' 은 안 열기로 함).
 * 'auto' 는 저장하지 않는다. 값이 없으면 시스템 설정을 따르는 게 곧 auto 다.
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
/** 일정 탭에서 지금 켜진 뷰(list | calendar). */
const scheduleView = () => $('.view-btn.is-active')?.dataset.view;

/**
 * DOM 생성 헬퍼.
 * 경기 데이터는 외부 API 값이라 innerHTML 로 조립하지 않고 textContent 로만 넣는다(XSS 방지).
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

/** Tossface 아이콘. index.html 에 넣어 둔 <symbol> 을 <use> 로 참조한다. */
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

// 기록 타임라인 라벨. events.kind 값 기준이라 득점·실점이 서버에서 이미 나뉘어 온다
// (src/db.js insertEvent).
const KIND_LABEL = { start: '시작', cancel: '취소', score: '득점', concede: '실점', end: '종료' };

// 포스트시즌 시리즈만 있다. 여기 없는 시리즈(정규시즌)는 태그 없음.
const SERIES_SHORT = {
  tiebreaker: '순위결정전',
  wildcard: '와일드카드',
  semi_playoff: '준PO',
  playoff: 'PO',
  korean_series: '한국시리즈',
};
const seriesTagOf = (series) =>
  SERIES_SHORT[series] ? el('span', { class: 'tag' }, icon('post'), SERIES_SHORT[series]) : null;

const DEFAULT_VIBRATE = { start: true, cancel: true, score: true, end: true };
const VIBRATE_KEYS = Object.keys(DEFAULT_VIBRATE);

let teamCode = 'NC';
// 서버 설정(teamCode). 순위표 강조에만 필요해서 다른 요청은 이걸 기다리지 않는다.
const configReady = api('/api/config')
  .then((cfg) => { teamCode = cfg.teamCode || 'NC'; })
  .catch(() => { /* 실패하면 기본값으로 */ });
let subscription = null; // 현재 기기의 PushSubscription

/*
 * 진동 on/off 는 서버가 아니라 기기의 IndexedDB 에 둔다. 보낼지는 서버가 정하지만
 * 받은 알림을 어떻게 띄울지는 기기 문제다. sw.js 에서도 읽어야 해서
 * localStorage 대신 IndexedDB 를 쓴다.
 */
function openSettingsDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('nc-alert', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getVibrateSettings() {
  let db;
  try {
    db = await openSettingsDb();
    return await new Promise((resolve) => {
      const req = db.transaction('kv', 'readonly').objectStore('kv').get('vibrate');
      req.onsuccess = () => resolve({ ...DEFAULT_VIBRATE, ...req.result });
      req.onerror = () => resolve(DEFAULT_VIBRATE);
    });
  } catch {
    return DEFAULT_VIBRATE; // IndexedDB 를 못 쓰면 전부 켬
  } finally {
    // 연결은 꼭 닫는다. 열어 두면 나중에 DB 버전을 올릴 때 막힌다.
    db?.close();
  }
}

async function setVibrateSettings(settings) {
  const db = await openSettingsDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(settings, 'vibrate');
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

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
 * .topbar(제목+탭)는 sticky 로 위에 붙어 있고, 일정 탭 .sched-fixed 가 그 바로 아래에
 * 붙는다. 높이가 폰트·글자 크기 설정에 따라 달라서 재서 --topbar-h 에 넣는다.
 */
{
  const topbar = $('.topbar');
  const syncTopbarHeight = () => {
    document.documentElement.style.setProperty('--topbar-h', `${topbar.offsetHeight}px`);
  };

  // ResizeObserver 첫 콜백은 비동기라 그 전에 스크롤하면 겹친다. 처음 값은
  // 바로 넣고, 이후 변화만 ResizeObserver 에 맡긴다.
  syncTopbarHeight();
  if ('ResizeObserver' in window) new ResizeObserver(syncTopbarHeight).observe(topbar);
}

const TAB_KEY = 'tab';

/**
 * 탭 전환. 없는 이름이면 그대로 두고 false.
 * 탭 목록은 DOM 에서 찾는다. 탭을 바꿀 땐 index.html 만 고치면 된다.
 */
function activateTab(name) {
  const tabs = $$('.tab');
  const tab = tabs.find((t) => t.dataset.tab === name);
  if (!tab) return false;

  // 이동 방향(data-enter)을 패널에 붙여서 CSS 가 그 방향으로 슬라이드한다.
  // 스와이프도 .tab.click() 을 거치니 같은 동작. 첫 렌더나 같은 탭이면 안 붙인다.
  const from = tabs.findIndex((t) => t.classList.contains('is-active'));
  const to = tabs.indexOf(tab);
  const enter = from === -1 || from === to ? null : to > from ? 'next' : 'prev';

  tabs.forEach((t) => t.classList.toggle('is-active', t === tab));
  $$('.panel').forEach((p) => {
    const on = p.id === `panel-${name}`;
    if (on && enter) p.dataset.enter = enter;
    else if (on) delete p.dataset.enter;
    p.classList.toggle('is-active', on);
  });

  // 탭을 옮기면 맨 위로. 스크롤은 문서 하나를 같이 써서 그대로 두면 다른 탭
  // 중간에 떨어진다. 일정 탭의 "오늘로 스크롤"은 클릭 핸들러에서 이 뒤에 돈다.
  if (from !== to) window.scrollTo(0, 0);
  return true;
}

$$('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    const name = tab.dataset.tab;
    activateTab(name);

    // 다시 열었을 때 보던 탭으로.
    localStorage.setItem(TAB_KEY, name);

    // 일정 리스트면 오늘 경기로 스크롤. 패널이 숨어 있을 땐 scrollIntoView 가
    // 안 먹어서 패널을 켠 다음에 부른다.
    if (name === 'schedule' &&
        scheduleView() === 'list') {
      scrollListToToday();
    }
  });
});

// 마지막 탭 복원. 값이 없거나 없는 탭이면 마크업의 is-active 가 기본.
activateTab(localStorage.getItem(TAB_KEY));

/**
 * 좌우 스와이프로 탭 전환. .tab.click() 을 불러서 클릭과 똑같이 동작한다.
 * 전광판(.scorebox-wrap)은 가로 스크롤이 있어서 거기서 시작한 터치는 무시한다.
 */
{
  // 탭 순서는 마크업 순서.
  const TAB_ORDER = $$('.tab').map((t) => t.dataset.tab);
  const SWIPE_MIN_X = 60; // 최소 이동 거리(px)
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

    // 가로로 충분히, 세로보다 확실히 많이 움직였을 때만.
    if (Math.abs(dx) < SWIPE_MIN_X || Math.abs(dx) < Math.abs(dy) * 1.5) return;

    const activeTab = $('.tab.is-active')?.dataset.tab;
    const i = TAB_ORDER.indexOf(activeTab);
    if (i < 0) return;

    const next = TAB_ORDER[dx < 0 ? i + 1 : i - 1]; // 왼쪽으로 밀면 다음 탭
    if (next) $(`.tab[data-tab="${next}"]`)?.click();
  }, { passive: true });
}

/* ─────────── 순위 · 포스트시즌 ─────────── */

/**
 * 전체 순위표. 포스트시즌 진출 구간마다 구분선을 넣는다.
 * 구간은 서버가 순위 API(postSeason.teamColors)에서 받아 온 값 그대로다.
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

  // 오늘 경기가 안 끝난 팀이 있을 때만 반영 표시(✓/•)를 붙인다.
  // 다 끝났으면 전부 ✓ 라 의미가 없다.
  const showMarks = standings.teams.some((t) => t.todayGame === 'pending');

  for (const t of standings.teams) {
    // 이 순위에서 진출 구간이 시작되면 라벨부터.
    const tier = tiers.find((x) => x.from === t.rank);
    if (tier) rows.push(el('p', { class: 'tier-label', text: tier.title }));

    const isMine = t.code === teamCode;
    // 연속 기록. 네이버 값 그대로("3승", "2패").
    const streak = String(t.streak ?? '');

    // 팀명 뒤에 붙인다. 칸을 따로 두면 좁은 화면에서 이름이 밀린다.
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
        el('span', { class: 'tpct', text: pctText(t.pct) }),
        el('span', { class: 'tgb', text: t.gb === 0 ? '-' : t.gb.toFixed(1) }),
        // 연승 초록, 연패 빨강(.verdict 와 같은 색 변수).
        el('span', {
          class: `tstreak${/승$/.test(streak) ? ' win' : /패$/.test(streak) ? ' lose' : ''}`,
          text: streak,
        }),
        el('span', { class: 'tleft', text: String(t.remaining ?? '') }),
      ),
    );

    // 진출권 마지막 순위 아래에 구분선.
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
        el('span', { class: 'tstreak', text: '연속' }),
        el('span', { class: 'tleft', text: '잔여' }),
      ),
      ...rows,
    ),
  );
}

/**
 * "○○ 기준" 한 줄. 화면 그린 시각이 아니라 서버 조회 시각(fetchedAt)을 쓴다.
 * 조회에 실패하면 서버가 예전 순위를 주는데(season.js getCacheStale), 그때도
 * 언제 값인지 맞게 보여야 한다.
 */
const STANDINGS_STALE_MS = 30 * 60 * 1000; // 캐시가 10분이니 이보다 오래됐으면 갱신이 안 되는 중

function standingsStamp(standings) {
  if (!standings) return '';

  // 예전 캐시 값에는 fetchedAt 이 없다.
  if (!standings.fetchedAt) return '경기 종료 시 갱신';

  const at = new Date(standings.fetchedAt);
  const time = at.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
  // 오늘이면 시각만, 아니면 날짜도.
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
  if (!standings || !outlook) return; // 데이터 없으면(비시즌) 카드 없음

  const { team, rank, cutoff, remaining, gamesBehindLine, tierTitle, status } = outlook;

  // 진출권 안일 때만 강조색(골드).
  const pill =
    status === 'in'
      ? el('span', { class: 'pill in', text: tierTitle ?? '포스트시즌 진출권' })
      : status === 'eliminated'
        ? el('span', { class: 'pill out', text: '포스트시즌 탈락 확정' })
        : el('span', { class: 'pill', text: `${cutoff}위까지 ${gamesBehindLine}경기차` });

  // 바로 아래 순위와의 승차 칩. 꼴찌면 chaser 가 null 이라 없음.
  const chaserPill = outlook.chaser
    ? el('span', {
        class: 'pill chaser',
        text: `${outlook.chaser.rank}위와 ${outlook.chaser.gap}경기차`,
      })
    : null;

  // 문장은 서버가 조사까지 맞춰서 준다.
  const note = outlook.note ?? '';

  // 진출권까지 거리 막대. 승차가 클수록 짧다.
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
      chaserPill,
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

// 렌더할 때마다 많이 불려서 포매터는 한 번만 만든다.
const CLOCK = new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });

/** ISO 시각(UTC) → 24시간제 HH:MM. 이벤트 시각용. */
function clockOf(iso) {
  return CLOCK.format(new Date(iso));
}

/** 승률을 .xxx 로. 순위표·상대전적 공용. */
const pctText = (pct) => pct.toFixed(3).replace(/^0/, '');

/** KST 시각 문자열("2026-08-23T18:30:00") → "오후 6:30". 시간대 변환 없음. */
function formatStart(iso) {
  const m = /T(\d{2}):(\d{2})/.exec(iso || '');
  if (!m) return '';
  const h = Number(m[1]);
  return `${h < 12 ? '오전' : '오후'} ${h % 12 || 12}:${m[2]}`;
}

/**
 * 사용자가 직접 여닫은 경기(gameId → 열림 여부).
 * 자동 갱신 때 카드를 새로 그려서, 이게 없으면 펼쳐 둔 경기가 다시 접힌다.
 */
const gameOpenState = new Map();

function renderGame(g, defaultOpen) {
  // 우리 팀 기준 값은 서버가 계산해서 준다.
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

  const seriesTag = seriesTagOf(g.series);

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

  // 시작·종료 시각은 이벤트 시각(실제 감지 시각)을 쓴다. 이벤트가 없으면
  // (감시 전에 끝난 경기) 편성 시각에 '예정'을 붙인다.
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

  const scoreboard = renderScoreboard(g.scoreboard, mine.name, opp.name, isHome);

  const timeline = g.events.length
    ? el('ul', { class: 'timeline' },
        g.events.map((e) =>
          el('li', { class: 'tl-item' },
            el('span', { class: 'tl-time', text: clockOf(e.createdAt) }),
            icon(e.kind),
            el('span', { class: 'tl-body' },
              el('b', { class: 'tl-kind', text: KIND_LABEL[e.kind] ?? e.kind }),
              e.body,
            ),
          ),
        ),
      )
    : null;

  // 접기·펼치기는 <details> 로(키보드·스크린리더 지원이 기본으로 됨).
  // summary 에 결과, 펼치면 전광판·시각·타임라인.
  const open = gameOpenState.get(g.gameId) ?? defaultOpen;

  // 진행 중 표시는 Live 태그로만.
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

  // 기본값과 다를 때만 기억한다. open 으로 만든 <details> 는 붙을 때 toggle 이
  // 한 번 나는데, 그것까지 저장하면 어제 경기가 계속 펼쳐져 있게 된다.
  card.addEventListener('toggle', () => {
    if (card.open === defaultOpen) gameOpenState.delete(g.gameId);
    else gameOpenState.set(g.gameId, card.open);
  });
  return card;
}

/**
 * 전광판(이닝별 점수 표). 데이터가 없으면(경기 전 등) 안 그린다.
 * 연장전이면 좁은 화면에서 넘쳐서 가로 스크롤로 감싼다.
 */
function renderScoreboard(sb, teamLabel, oppLabel, isHome) {
  if (!sb) return null;

  const innings = Math.max(sb.team.innings.length, sb.opp.innings.length, 9);
  // 안 친 이닝은 '-'(9회말 없이 끝나는 경우 등). 네이버 전광판과 같은 표기.
  const at = (arr, i) => (arr[i] != null ? String(arr[i]) : '-');

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
      /*
       * 원정 위, 홈 아래(위아래 = 초·말). 우리 팀을 항상 위에 두면 홈경기에서
       * 9회말 '-' 가 윗줄에 보여서 틀린 표처럼 읽힌다(2026-09-01 NC:KIA).
       * 우리 팀 표시는 tr.mine 이 한다.
       */
      el('tbody', {}, ...(isHome
        ? [row(oppLabel, sb.opp, false), row(teamLabel, sb.team, true)]
        : [row(teamLabel, sb.team, true), row(oppLabel, sb.opp, false)])),
    ),
  );
}

/** 진행 중인 경기가 있는지. 있으면 자동 갱신을 더 자주 한다(refresh). */
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

    // 기본으로 펼칠 경기: 시작한 경기 중 가장 최근 것(서버가 최신순으로 준다).
    // 오늘 경기가 시작되면 어제 경기는 자동으로 접힌다.
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
    const data = await api('/api/standings');
    await configReady; // 우리 팀 행 강조에 teamCode 가 필요하다
    renderStandings(data);
  } catch {
    /* 순위는 실패해도 넘어간다. */
  }
}

/**
 * 상대 팀별 시즌 전적(순위 탭, 순위표 아래).
 * 서버가 일정에서 세서 /api/schedule 에 같이 주기 때문에 일정을 불러올 때 그린다.
 * 순위표와 형식을 맞추려고 무승부는 0 이어도 적는다. pct 가 null 이면 '-'.
 */
function renderHeadToHead(rows) {
  const box = $('#h2h');
  clear(box);

  if (!rows?.length) {
    box.append(el('p', { class: 'empty', text: '아직 맞대결 기록이 없어요.' }));
    return;
  }

  const n = (v) => el('span', { class: 'n', text: String(v) });

  box.append(
    el('div', { class: 'card table-card' },
      ...rows.map((r) =>
        el('div', { class: 'h2h-row' },
          el('span', { class: 'h2h-opp', text: r.opp }),
          // 숫자를 고정 폭 칸(.n)에 넣어 "10승"/"9승" 자릿수가 달라도 줄이 맞게.
          el('span', { class: 'h2h-rec' },
            n(r.wins), '승 ', n(r.draws), '무 ', n(r.losses), '패'),
          el('span', {
            class: 'h2h-pct',
            text: r.pct === null ? '-' : pctText(r.pct),
          }),
        ),
      ),
    ),
  );
}

/* ─────────── 일정 ─────────── */

/** dateStr 이 today 로부터 며칠 뒤인지(0 오늘, 1 내일). today 는 서버가 준 KST 날짜. */
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

  const seriesTag = seriesTagOf(g.series);

  // 오른쪽: 지난 경기는 결과, 예정 경기는 시각.
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


/** 마지막으로 받은 일정. 뷰 전환·'오늘' 버튼이 다시 조회하지 않고 쓴다. */
let scheduleData = null;
let calendarMonth = null; // 달력에 보이는 달 'YYYY-MM'

/** 리스트에서 그 날짜 카드를 화면 가운데로. 경기 없는 날이면 다음 경기로. */
function scrollListToDate(box, date) {
  const anchor =
    box.querySelector(`[data-date="${date}"]`) ??
    [...box.querySelectorAll('[data-date]')].find((n) => n.dataset.date > date);
  if (anchor) anchor.scrollIntoView({ block: 'center', behavior: 'smooth' });
  return Boolean(anchor);
}

/** 오늘(없으면 다음) 경기를 가운데로. */
function scrollListToToday() {
  if (scheduleData) scrollListToDate($('#schedule-list'), scheduleData.today);
}

/** 리스트/달력 전환. 스크롤은 호출부에서. */
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

  // 요약줄은 고정 영역(#sched-fixed)에 있어서 내용만 바꾼다. 카드 목록만 스크롤된다.
  const summary = $('#sched-summary');
  clear(summary);
  summary.append(
    el('b', { text: `${games.length}경기` }),
    ' · 홈 ',
    el('b', { class: 'hl', text: `${homeCount}경기` }),
    played.length ? ` · ${wins}승 ${draws}무 ${losses}패` : '',
  );

  // 월별로 나눈다.
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
 * 달력 뷰(7열). 경기 있는 날에 상대팀 이름을 쓰고, 결과는 칸 테두리 색
 * (승 파랑, 패 빨강, 무 노랑)으로 표시한다. 홈경기는 배경색이 다르다.
 * 날짜를 누르면 리스트로 바꿔서 그 날짜로 스크롤한다.
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
      // 결과는 테두리 색(style.css .result-*).
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

  const active = scheduleView() ?? 'list';
  $('#schedule-list').classList.toggle('is-active', active === 'list');
  $('#schedule-calendar').classList.toggle('is-active', active === 'calendar');
  // 요약줄은 리스트일 때만.
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
    // 리스트로 바꿀 때마다 오늘 경기로 스크롤.
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
    // view-btn.click() 을 쓰면 "오늘로 스크롤"이 먼저 돌아서 스크롤이 두 번 된다.
    // 직접 전환하고 고른 날짜로 한 번만 스크롤한다.
    activateScheduleView('list');
    scrollListToDate($('#schedule-list'), cell.dataset.date);
  }
});

$('#btn-today').addEventListener('click', () => {
  if (!scheduleData) return;
  const active = scheduleView();

  if (active === 'calendar') {
    calendarMonth = scheduleData.today.slice(0, 7);
    renderCalendar($('#schedule-calendar'), scheduleData);
  } else {
    scrollListToToday();
  }
});

async function loadSchedule() {
  // 빈 상태·에러 안내는 지금 켜진 뷰에 넣는다(기본 뷰가 달력).
  const box = () =>
    scheduleView() === 'calendar'
      ? $('#schedule-calendar')
      : $('#schedule-list');

  try {
    scheduleData = await api('/api/schedule');

    // 상대전적은 일정이 비어도 그려야(스켈레톤 지우기) 해서 return 보다 먼저.
    renderHeadToHead(scheduleData.headToHead);

    if (!scheduleData.games.length) {
      clear(box());
      box().append(
        el('p', { class: 'empty' }, '일정이 없어요.', el('br'), '비시즌이거나 일정이 아직 나오지 않았습니다.'),
      );
      return;
    }

    renderScheduleView();
    // 오늘로 스크롤은 여기서 안 한다. 패널이 숨어 있으면 안 먹어서 탭을 열 때 한다.
  } catch (err) {
    clear(box());
    box().append(el('p', { class: 'empty' }, '일정을 불러오지 못했어요.', el('br'), err.message));
  }
}

/* ─────────── 알림 설정 ─────────── */

function setPushUi(state, desc) {
  $('#push-desc').textContent = desc;

  // 알림이 꺼져 있을 때만 강조 카드(card-coral)로 보여서 켜도록 유도한다.
  $('#push-card').classList.toggle('card-coral', state === 'off' || state === 'error');

  const btn = $('#btn-toggle');
  btn.textContent = state === 'on' ? '알림 끄기' : state === 'error' ? '다시 시도' : '알림 켜기';
  btn.disabled = state === 'unsupported';
  $('#btn-test').hidden = state !== 'on';
  $$('.sw input').forEach((i) => { i.disabled = state !== 'on'; });
}

function applySettings(settings) {
  // [data-key] 만. 진동 스위치도 .sw 를 쓰는데 서버 설정에는 없어서 꺼진 걸로 덮인다.
  $$('.sw input[data-key]').forEach((input) => {
    input.checked = Boolean(settings?.[input.dataset.key]);
  });
}

async function applyVibrateSettings() {
  const settings = await getVibrateSettings();
  $$('.vibrate-toggle').forEach((input) => {
    input.checked = Boolean(settings[input.dataset.vibrateKey]);
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

  // 처음에 등록이 실패했을 수도 있어서 다시 한다(여러 번 불러도 괜찮다).
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

// 진동 스위치(data-vibrate-key)는 서버 설정이 아니므로 [data-key] 로 한정한다.
$$('.sw input[data-key]').forEach((input) => {
  input.addEventListener('change', async () => {
    if (!subscription) return;
    const key = input.dataset.key;

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

$$('.vibrate-toggle').forEach((input) => {
  input.addEventListener('change', async () => {
    // 아는 키만 저장한다. sw.js 는 kind 로 이 값을 찾아서, 마크업 키에 오타가
    // 있으면 스위치는 멀쩡해 보여도 진동은 계속 켜진 채로 동작한다.
    const settings = Object.fromEntries(
      $$('.vibrate-toggle')
        .filter((i) => VIBRATE_KEYS.includes(i.dataset.vibrateKey))
        .map((i) => [i.dataset.vibrateKey, i.checked]),
    );
    try {
      await setVibrateSettings(settings);
    } catch (err) {
      input.checked = !input.checked; // 저장 실패하면 되돌림
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

  /*
   * 서버에서 설정을 받아 온다. 서버에 구독이 없으면 다시 등록한다.
   * "켜짐" 표시는 서버 확인 뒤에 한다. 먼저 켜 두면 재등록이 실패해도 화면은
   * 켜진 걸로 보인다(2026-09 구독 상한 때문에 실제로 그랬음).
   */
  try {
    let settings;
    try {
      ({ settings } = await api(
        `/api/settings?endpoint=${encodeURIComponent(existing.endpoint)}`,
      ));
    } catch {
      ({ settings } = await api('/api/subscribe', {
        method: 'POST',
        body: JSON.stringify(serialize(existing)),
      }));
    }
    applySettings(settings);
    setPushUi('on', '이 기기로 알림을 보내드려요.');
  } catch (err) {
    setPushUi('off', `알림 등록을 확인하지 못했어요. 다시 켜 주세요. (${err.message})`);
  }
}

(async function main() {
  // 알림 준비는 데이터 로딩과 상관없어서 같이 시작한다.
  // 진동 설정은 로컬 값이라 구독과 상관없이 불러온다.
  applyVibrateSettings().catch((err) => console.error('vibrate settings load failed', err));

  initPush().catch((err) => {
    setPushUi('error', `알림을 준비하지 못했어요: ${err.message}`);
    console.error('initPush failed', err);
  });

  await Promise.all([loadHistory(), loadStandings(), loadSchedule()]);

  /*
   * 자동 갱신
   *  - 20초(경기 중일 때만): 기록만. 60초로 하면 서버 갱신(1분)과 어긋나서
   *    최악 2분 늦게 보인다.
   *  - 60초: 기록·순위·일정 전부. 순위·일정은 경기가 끝나야 바뀐다.
   *  - 푸시 받았을 때: sw.js 가 메시지를 보내면 바로.
   * 화면이 안 보일 때는 요청하지 않는다.
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

  // 앱으로 돌아오면 바로 갱신.
  document.addEventListener('visibilitychange', refresh);

  navigator.serviceWorker?.addEventListener('message', (ev) => {
    if (ev.data?.type === 'refresh') refresh();
  });
})();

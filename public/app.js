/* NC 다이노스 경기 알림 — PWA 클라이언트 */

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

const KIND_LABEL = { start: '시작', cancel: '취소', score: '득점', end: '종료', test: '테스트' };
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

$$('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach((t) => t.classList.toggle('is-active', t === tab));
    $$('.panel').forEach((p) => p.classList.toggle('is-active', p.id === `panel-${tab.dataset.tab}`));
  });
});

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

  for (const t of standings.teams) {
    // 이 순위에서 시작하는 진출 구간이 있으면 라벨을 먼저 넣는다.
    const tier = tiers.find((x) => x.from === t.rank);
    if (tier) rows.push(el('p', { class: 'tier-label', text: tier.title }));

    const isMine = t.code === teamCode;

    rows.push(
      el('div', { class: `trow${isMine ? ' mine' : ''}` },
        el('span', { class: 'trank', text: String(t.rank) }),
        el('span', { class: 'tname', text: t.name }),
        el('span', { class: 'trec', text: `${t.wins}승 ${t.draws}무 ${t.losses}패` }),
        el('span', { class: 'tpct', text: t.pct.toFixed(3).replace(/^0/, '') }),
        el('span', { class: 'tgb', text: t.gb === 0 ? '-' : t.gb.toFixed(1) }),
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
      ),
      ...rows,
    ),
  );
}

function renderStandings({ standings, outlook }) {
  renderTable(standings);

  const stamp = $('#standings-updated');
  if (stamp) {
    stamp.textContent = standings
      ? `${new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })} 기준 · 경기 종료 시 갱신`
      : '';
  }

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

function renderGame(g) {
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

  // 진행 중인 경기는 다크 표면에 올린다. 크림 카드 사이에서 확실히 구분되고,
  // 크림↔다크 교차가 이 디자인 시스템의 페이싱 방식이다.
  return el('article', { class: `card${isLive ? ' card-dark' : ''}` },
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
    times,
    timeline,
  );
}

async function loadHistory() {
  const box = $('#history');
  try {
    const { games } = await api('/api/history?days=30');
    clear(box);

    if (!games.length) {
      box.append(
        el('p', { class: 'empty' }, '아직 기록이 없어요.', el('br'), '경기가 열리면 여기에 쌓입니다.'),
      );
      return;
    }

    const byDay = new Map();
    for (const g of games) {
      if (!byDay.has(g.gameDate)) byDay.set(g.gameDate, []);
      byDay.get(g.gameDate).push(g);
    }

    for (const [date, list] of byDay) {
      box.append(el('h2', { class: 'day-title', text: formatDay(date) }), ...list.map(renderGame));
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
let scheduleScrolled = false;
let calendarMonth = null; // 'YYYY-MM'. 달력이 지금 보여주는 달.

/** 리스트 뷰에서 날짜 카드를 찾아 화면 중앙으로 옮긴다. */
function scrollListToDate(box, date) {
  const anchor =
    box.querySelector(`[data-date="${date}"]`) ??
    [...box.querySelectorAll('[data-date]')].find((n) => n.dataset.date > date);
  if (anchor) anchor.scrollIntoView({ block: 'center', behavior: 'smooth' });
  return Boolean(anchor);
}

function renderScheduleList(box, { games, today }) {
  clear(box);

  const played = games.filter((g) => g.result);
  const wins = played.filter((g) => g.result === 'win').length;
  const losses = played.filter((g) => g.result === 'lose').length;
  const draws = played.filter((g) => g.result === 'draw').length;
  const homeCount = games.filter((g) => g.isHome).length;

  box.append(
    el('p', { class: 'sched-summary' },
      el('b', { text: `${games.length}경기` }),
      ' · 홈 ',
      el('b', { class: 'hl', text: `${homeCount}경기` }),
      played.length ? ` · ${wins}승 ${draws}무 ${losses}패` : '',
    ),
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

  // 처음 열었을 때만 자동으로 오늘 근처로 스크롤한다. 이후 이동은 '오늘' 버튼이 맡는다.
  if (!scheduleScrolled) {
    scheduleScrolled = scrollListToDate(box, today);
  }
}

/**
 * 달력 뷰. 한 달을 7열 격자로 그리고, 경기가 있는 날짜에 홈/원정 점과
 * 결과 색(승 초록 테두리 · 패 빨강 테두리)을 얹는다.
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

    const cellClasses = ['cal-cell', date === today && 'cal-today', g && 'has-game']
      .filter(Boolean).join(' ');

    const dot = g
      ? el('span', {
          class: `cal-dot ${g.isHome ? 'home' : 'away'}${g.result ? ` r-${g.result}` : ''}${g.cancelled ? ' is-off' : ''}`,
        })
      : null;

    grid.append(
      el('button', { class: cellClasses, type: 'button', 'data-date': date, disabled: !g },
        el('span', { class: 'cal-daynum', text: String(d) }),
        dot,
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

  if (active === 'list') {
    renderScheduleList($('#schedule-list'), scheduleData);
  } else {
    calendarMonth ??= scheduleData.today.slice(0, 7);
    renderCalendar($('#schedule-calendar'), scheduleData);
  }
}

$$('.view-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('.view-btn').forEach((b) => b.classList.toggle('is-active', b === btn));
    renderScheduleView();
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
    document.querySelector('.view-btn[data-view="list"]').click();
    // scrollIntoView 는 필요한 레이아웃을 동기적으로 계산하므로,
    // 리스트를 새로 그린 직후 바로 불러도 위치가 정확하다.
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
    scrollListToDate($('#schedule-list'), scheduleData.today);
  }
});

async function loadSchedule() {
  const box = $('#schedule-list');
  try {
    scheduleData = await api('/api/schedule');

    if (!scheduleData.games.length) {
      clear(box);
      box.append(
        el('p', { class: 'empty' }, '일정이 없어요.', el('br'), '비시즌이거나 일정이 아직 나오지 않았습니다.'),
      );
      return;
    }

    renderScheduleView();
  } catch (err) {
    clear(box);
    box.append(el('p', { class: 'empty' }, '일정을 불러오지 못했어요.', el('br'), err.message));
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

  // 앱을 다시 볼 때 최신 상태로 갱신한다.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      loadHistory();
      loadStandings();
      loadSchedule();
    }
  });
})();

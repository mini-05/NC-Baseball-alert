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
 * 받침 유무에 맞는 조사를 붙인다. ("두산을" / "롯데를")
 *
 * KBO 팀명 중 영문 표기(KT·LG·NC·SSG·KIA)는 한국어 발음이 모두 모음으로 끝나므로
 * (케이티, 엘지, 엔씨, 에스에스지, 기아) 받침 없음으로 처리하면 맞다.
 */
function withParticle(word, hasJong, noJong) {
  const text = String(word ?? '').trim();
  if (!text) return text;

  const code = text.charCodeAt(text.length - 1);
  const isHangul = code >= 0xac00 && code <= 0xd7a3;
  return text + (isHangul && (code - 0xac00) % 28 !== 0 ? hasJong : noJong);
}

const KIND_LABEL = { start: '시작', cancel: '취소', score: '득점', end: '종료', test: '테스트' };
const SERIES_SHORT = {
  tiebreaker: '순위결정전',
  wildcard: '와일드카드',
  semi_playoff: '준PO',
  playoff: 'PO',
  korean_series: '한국시리즈',
};

const SETTING_KEYS = ['start', 'cancel', 'score', 'end', 'regular', 'postseason'];

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

const segmented = $('.segmented');

$$('.seg').forEach((seg, index) => {
  seg.addEventListener('click', () => {
    segmented.dataset.index = String(index);
    $$('.seg').forEach((s) => s.classList.toggle('is-active', s === seg));
    $$('.panel').forEach((p) => p.classList.toggle('is-active', p.id === `panel-${seg.dataset.tab}`));
  });
});

/* ─────────── 순위 · 포스트시즌 ─────────── */

function renderStandings({ standings, outlook }) {
  const slot = $('#standings');
  clear(slot);
  if (!standings || !outlook) return; // 비시즌이면 카드를 아예 띄우지 않는다.

  const { team, rank, cutoff, cutoffTeam, remaining, gamesBehindLine, tierTitle, status } = outlook;

  const pill =
    status === 'in'
      ? el('span', { class: 'ps-pill in', text: tierTitle ?? '포스트시즌 진출권' })
      : status === 'eliminated'
        ? el('span', { class: 'ps-pill out', text: '포스트시즌 탈락 확정' })
        : el('span', { class: 'ps-pill', text: `${cutoff}위까지 ${gamesBehindLine}경기차` });

  const lineName = cutoffTeam?.name ?? `${cutoff}위`;

  let note;
  if (status === 'in') {
    note = `현재 순위를 지키면 ${tierTitle ?? '포스트시즌 진출'}이에요. 잔여 ${remaining}경기.`;
  } else if (status === 'eliminated') {
    note = `남은 ${remaining}경기를 모두 이겨도 ${lineName}의 현재 승수에 미치지 못해요.`;
  } else {
    note = `잔여 ${remaining}경기. ${withParticle(lineName, '을', '를')} 넘어야 진출권에 들어요.`;
  }

  // 진출권까지의 거리를 시각화. 승차가 클수록 막대가 짧아진다.
  const progress = status === 'in' ? 1 : Math.max(0, 1 - gamesBehindLine / Math.max(remaining, 1));

  slot.append(
    el('div', { class: 'card rank-card' },
      el('div', { class: 'rank-head' },
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

/** 서버가 저장한 KST 로컬시각 문자열. 시간대 변환 없이 그대로 읽는다. */
function formatStart(iso) {
  const m = /T(\d{2}):(\d{2})/.exec(iso || '');
  if (!m) return '';
  const h = Number(m[1]);
  return `${h < 12 ? '오전' : '오후'} ${h % 12 || 12}:${m[2]}`;
}

function renderGame(g) {
  const isHome = g.homeCode === teamCode;
  const mine = { name: isHome ? g.homeName : g.awayName, score: isHome ? g.homeScore : g.awayScore };
  const opp = { name: isHome ? g.awayName : g.homeName, score: isHome ? g.awayScore : g.homeScore };

  const done = g.phase === 'result' && !g.cancelled;
  const diff = mine.score - opp.score;

  const status = g.cancelled
    ? '취소'
    : g.phase === 'live'
      ? (g.statusInfo || '경기 중')
      : g.phase === 'result'
        ? '종료'
        : formatStart(g.startAt);

  const seriesChip = SERIES_SHORT[g.series]
    ? el('span', { class: 'chip post', text: SERIES_SHORT[g.series] })
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

  const timeline = g.events.length
    ? el('ul', { class: 'timeline' },
        g.events.map((e) =>
          el('li', { class: 'tl-item' },
            el('span', {
              class: 'tl-time',
              text: new Date(e.createdAt).toLocaleTimeString('ko-KR', {
                hour: '2-digit', minute: '2-digit', hour12: false,
              }),
            }),
            el('span', { class: 'tl-body' },
              el('b', { class: 'tl-kind', text: KIND_LABEL[e.kind] ?? e.kind }),
              e.body,
            ),
          ),
        ),
      )
    : null;

  return el('article', { class: 'card game' },
    el('div', { class: 'game-meta' },
      seriesChip,
      g.phase === 'live' && !g.cancelled ? el('span', { class: 'chip live', text: 'LIVE' }) : null,
      el('span', { text: `${g.stadium ?? ''} · ${isHome ? '홈' : '원정'}` }),
      el('span', { class: 'game-status', text: status }),
    ),
    el('div', { class: 'matchup' },
      team(mine, done && diff < 0),
      el('span', { class: 'colon', text: ':' }),
      team(opp, done && diff > 0),
    ),
    verdict,
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

/* ─────────── 알림 설정 ─────────── */

function setPushUi(state, desc) {
  const dot = $('#push-dot');
  dot.className = `dot ${state === 'on' ? 'on' : state === 'error' ? 'err' : ''}`;
  $('#push-desc').textContent = desc;

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

  await Promise.all([loadHistory(), loadStandings()]);

  initPush().catch((err) => {
    setPushUi('error', `알림을 준비하지 못했어요: ${err.message}`);
    console.error('initPush failed', err);
  });

  // 앱을 다시 볼 때 최신 상태로 갱신한다.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      loadHistory();
      loadStandings();
    }
  });
})();

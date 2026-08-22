/* NC 다이노스 경기 알림 — PWA 클라이언트 */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const KIND_LABEL = { start: '시작', cancel: '취소', score: '득점', end: '종료', test: '테스트' };

let teamCode = 'NC';
let subscription = null; // 현재 기기의 PushSubscription

/* ---------- 공통 ---------- */

async function api(path, options) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

let toastTimer;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 2600);
}

/** VAPID 공개키(base64url)를 pushManager 가 요구하는 Uint8Array 로 변환한다. */
function urlBase64ToUint8Array(base64) {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4))
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** PushSubscription 을 서버로 보낼 평범한 객체로 바꾼다. */
function serialize(sub) {
  const json = sub.toJSON();
  return { endpoint: sub.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } };
}

/* ---------- 탭 ---------- */

$$('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach((t) => t.classList.toggle('is-active', t === tab));
    $$('.panel').forEach((p) =>
      p.classList.toggle('is-active', p.id === `panel-${tab.dataset.tab}`),
    );
  });
});

/* ---------- 기록 화면 ---------- */

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

function formatDay(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const wd = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${m}월 ${d}일 (${wd})`;
}

function formatTime(iso) {
  // 서버가 저장한 KST 로컬시각 문자열. 브라우저 시간대 변환 없이 그대로 읽는다.
  const m = /T(\d{2}):(\d{2})/.exec(iso || '');
  return m ? `${m[1]}:${m[2]}` : '';
}

function renderGame(g) {
  const isHome = g.homeCode === teamCode;
  const teamScore = isHome ? g.homeScore : g.awayScore;
  const oppScore = isHome ? g.awayScore : g.homeScore;
  const teamName = isHome ? g.homeName : g.awayName;
  const oppName = isHome ? g.awayName : g.homeName;

  const done = g.phase === 'result' && !g.cancelled;
  const diff = teamScore - oppScore;

  const stateLabel = g.cancelled
    ? '취소'
    : g.phase === 'live'
      ? g.statusInfo || '경기 중'
      : g.phase === 'result'
        ? '종료'
        : formatTime(g.startAt);
  const stateClass = g.cancelled ? '' : g.phase === 'live' ? 'live' : g.phase === 'before' ? 'before' : '';

  const teamSide = done ? (diff > 0 ? 'win' : diff < 0 ? 'lose' : '') : '';
  const oppSide = done ? (diff < 0 ? 'win' : diff > 0 ? 'lose' : '') : '';

  const verdict = g.cancelled
    ? '<p class="result-line cancel">경기 취소</p>'
    : done
      ? `<p class="result-line ${teamSide}">${diff > 0 ? '승리' : diff < 0 ? '패배' : '무승부'}</p>`
      : '';

  const events = g.events.length
    ? `<ul class="evlog">${g.events
        .map(
          (e) =>
            `<li><time>${new Date(e.createdAt).toLocaleTimeString('ko-KR', {
              hour: '2-digit',
              minute: '2-digit',
            })}</time><span class="k">${KIND_LABEL[e.kind] ?? e.kind}</span><span class="t">${
              e.body
            }</span></li>`,
        )
        .join('')}</ul>`
    : '';

  return `
    <article class="game">
      <div class="game-top">
        <span>${g.stadium ?? ''} · ${isHome ? '홈' : '원정'}</span>
        <span class="state ${stateClass}">${stateLabel}</span>
      </div>
      <div class="score">
        <div class="side is-team ${teamSide}">
          <div class="name">${teamName}</div>
          <div class="pts">${g.cancelled ? '-' : teamScore}</div>
        </div>
        <div class="vs">:</div>
        <div class="side ${oppSide}">
          <div class="name">${oppName}</div>
          <div class="pts">${g.cancelled ? '-' : oppScore}</div>
        </div>
      </div>
      ${verdict}
      ${events}
    </article>`;
}

async function loadHistory() {
  const box = $('#history');
  try {
    const { games } = await api('/api/history?days=30');
    if (!games.length) {
      box.innerHTML =
        '<p class="empty">아직 기록이 없습니다.<br />경기가 열리면 여기에 쌓입니다.</p>';
      return;
    }

    const byDay = new Map();
    for (const g of games) {
      if (!byDay.has(g.gameDate)) byDay.set(g.gameDate, []);
      byDay.get(g.gameDate).push(g);
    }

    box.innerHTML = Array.from(byDay, ([date, list]) => `
      <section class="day">
        <h2 class="day-label">${formatDay(date)}</h2>
        ${list.map(renderGame).join('')}
      </section>`).join('');
  } catch (err) {
    box.innerHTML = `<p class="empty">기록을 불러오지 못했습니다.<br />${err.message}</p>`;
  }
}

/* ---------- 알림 설정 ---------- */

function setPushState(on, label) {
  const badge = $('#push-state');
  badge.textContent = label;
  badge.className = `badge ${on ? 'on' : 'off'}`;

  $('#btn-toggle').textContent = on ? '알림 끄기' : '알림 켜기';
  $('#btn-toggle').disabled = false;
  $('#btn-test').hidden = !on;
  $$('#switches input').forEach((i) => (i.disabled = !on));
}

function applySettings(settings) {
  $$('#switches input').forEach((input) => {
    input.checked = Boolean(settings?.[input.dataset.kind]);
  });
}

async function enablePush() {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    toast('알림 권한이 거부됐습니다. 브라우저 설정에서 허용해 주세요.');
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
  setPushState(true, '켜짐');
  toast('알림이 켜졌습니다.');
}

async function disablePush() {
  if (!subscription) return;

  const endpoint = subscription.endpoint;
  await subscription.unsubscribe().catch(() => {});
  await api('/api/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint }) });

  subscription = null;
  setPushState(false, '꺼짐');
  toast('알림이 꺼졌습니다.');
}

$('#btn-toggle').addEventListener('click', async () => {
  $('#btn-toggle').disabled = true;
  try {
    subscription ? await disablePush() : await enablePush();
  } catch (err) {
    toast(`실패: ${err.message}`);
    $('#btn-toggle').disabled = false;
  }
});

$('#btn-test').addEventListener('click', async () => {
  if (!subscription) return;
  try {
    await api('/api/test', {
      method: 'POST',
      body: JSON.stringify({ endpoint: subscription.endpoint }),
    });
    toast('테스트 알림을 보냈습니다.');
  } catch (err) {
    toast(`실패: ${err.message}`);
  }
});

$$('#switches input').forEach((input) => {
  input.addEventListener('change', async () => {
    if (!subscription) return;
    try {
      await api('/api/settings', {
        method: 'POST',
        body: JSON.stringify({
          endpoint: subscription.endpoint,
          [input.dataset.kind]: input.checked,
        }),
      });
    } catch (err) {
      input.checked = !input.checked; // 서버 반영 실패 시 UI 를 되돌린다.
      toast(`설정 저장 실패: ${err.message}`);
    }
  });
});

/* ---------- 시작 ---------- */

async function initPush() {
  const supported = 'serviceWorker' in navigator && 'PushManager' in window;

  // iOS 는 홈 화면에 추가한 상태에서만 PushManager 를 노출한다.
  const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const standalone = window.navigator.standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches;
  if (isIos && !standalone) $('#ios-hint').hidden = false;

  if (!supported) {
    $('#push-state').textContent = '지원 안 함';
    $('#push-state').className = 'badge off';
    $('#push-desc').textContent = isIos
      ? '홈 화면에 추가한 뒤 다시 열면 알림을 켤 수 있습니다.'
      : '이 브라우저는 웹 푸시를 지원하지 않습니다.';
    $('#btn-toggle').textContent = '사용 불가';
    return;
  }

  await navigator.serviceWorker.register('/sw.js');
  const reg = await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();

  if (existing && Notification.permission === 'granted') {
    subscription = existing;
    setPushState(true, '켜짐');

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
  } else {
    setPushState(false, '꺼짐');
  }
}

(async function main() {
  try {
    const cfg = await api('/api/config');
    teamCode = cfg.teamCode || 'NC';
  } catch {
    /* 설정 조회 실패는 기본값으로 계속 진행 */
  }

  await loadHistory();

  initPush().catch((err) => {
    // 초기화가 실패해도 버튼이 "확인 중"에 멈춰 있으면 안 된다. 원인을 보여주고 재시도를 허용한다.
    $('#push-state').textContent = '오류';
    $('#push-state').className = 'badge off';
    $('#push-desc').textContent = `알림을 준비하지 못했습니다: ${err.message}`;
    $('#btn-toggle').textContent = '다시 시도';
    $('#btn-toggle').disabled = false;
    console.error('initPush failed', err);
  });

  // 앱을 다시 볼 때 최신 기록으로 갱신한다.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) loadHistory();
  });
})();

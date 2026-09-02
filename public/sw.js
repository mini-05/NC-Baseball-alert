/* 서비스 워커 — 푸시 수신과 알림 클릭 처리만 담당한다. */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

/*
 * 진동 패턴(ms 단위, [울림, 멈춤, 울림...]). 화면을 안 봐도 종류가 느껴지도록
 * 득점은 짧게 두 번, 종료는 길게 세 번으로 나눴다.
 *
 * Chrome/Android 계열에서만 동작한다 — iOS Safari 는 이 옵션 자체를 조용히
 * 무시한다(에러 없음). 알림음은 브라우저/OS 기본음이 자동 재생되며, 커스텀
 * 사운드는 Notifications API 표준에 없어(2018년 표준에서 제외) 지정할 방법이
 * 없다. silent:true 로 끌 수만 있고 바꿀 수는 없다.
 */
const VIBRATE = {
  start: [200],
  cancel: [200, 100, 200],
  score: [120, 80, 120],
  end: [200, 100, 200, 100, 200],
};

/**
 * 진동 on/off 설정을 읽는다. app.js 가 같은 IndexedDB('nc-alert' → 'kv' 스토어의
 * 'vibrate' 키)에 저장한 값을 그대로 읽는다 — 앱이 안 떠 있어도 푸시는 오므로,
 * 페이지 쪽 상태(변수·localStorage)에 의존할 수 없다.
 *
 * 못 읽으면(첫 실행이라 스토어가 비어 있거나, IndexedDB 를 못 쓰는 환경이면)
 * 기존 동작대로 전부 켠 것으로 본다.
 */
function getVibrateSettings() {
  return new Promise((resolve) => {
    let req;
    try {
      req = indexedDB.open('nc-alert', 1);
    } catch {
      resolve({});
      return;
    }
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => {
      const db = req.result;
      // 연결은 어느 경로로 빠져나가든 닫는다. 남겨 두면 나중에 스키마 버전을
      // 올릴 때 upgrade 가 막히고, 그러면 아래 onblocked 로 떨어진다.
      const done = (value) => { db.close(); resolve(value); };

      if (!db.objectStoreNames.contains('kv')) { done({}); return; }
      const getReq = db.transaction('kv', 'readonly').objectStore('kv').get('vibrate');
      getReq.onsuccess = () => done(getReq.result ?? {});
      getReq.onerror = () => done({});
    };
    req.onerror = () => resolve({});
    // 다른 탭이 옛 버전 연결을 쥐고 있으면 open 이 여기서 멈춘다. 이 갈래를
    // 비워 두면 Promise 가 영영 settle 되지 않아 event.waitUntil 도 끝나지 않고,
    // 그러면 알림 자체가 안 뜬다 — 설정을 포기하고 기본값으로 진행한다.
    req.onblocked = () => resolve({});
  });
}

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'NC 다이노스', body: event.data?.text() ?? '' };
  }

  event.waitUntil((async () => {
    const vibrateSettings = await getVibrateSettings();
    const vibrateOn = vibrateSettings[data.kind] ?? true;

    const options = {
      body: data.body ?? '',
      icon: '/icon-192.png',
      badge: '/badge-96.png',
      /*
       * 같은 tag 의 알림은 새로 뜨지 않고 기존 알림을 제자리에서 덮어쓴다.
       * 그래서 tag 는 "덮어써도 되는 범위"와 정확히 같아야 한다.
       *
       * 이벤트 id 가 있으면 그것만 쓴다. 이벤트 하나 = 알림 하나이고, 서버가
       * 같은 이벤트를 다시 보내도(배달 확인이 없을 때의 재발송) tag 가 같아
       * 제자리 갱신될 뿐 두 번 뜨지 않는다. ts 를 쓰면 재발송마다 tag 가 달라져
       * 그 보장이 깨진다.
       *
       * id 가 없는 payload(테스트 알림, 옛 서버)는 종전 규칙으로 흘린다 —
       * 종류만으로 묶으면 어제 경기의 알림을 덮어써 새 알림이 안 온 것처럼
       * 보이므로 경기까지 붙이고, 득점은 한 경기에 여러 번 나므로 ts 로 가른다.
       */
      tag: data.id != null
        ? `nc-${data.id}`
        : data.kind === 'score'
          ? `score-${data.ts}`
          : `nc-${data.kind ?? 'info'}-${data.gameId ?? data.ts}`,
      renotify: true,
      timestamp: data.ts ?? Date.now(),
      vibrate: vibrateOn ? (VIBRATE[data.kind] ?? [200]) : [],
      data: { url: '/' },
    };

    await Promise.all([
      self.registration.showNotification(data.title ?? 'NC 다이노스', options),
      // 앱이 열려 있으면 화면도 그 자리에서 갱신하게 알린다 — 알림만 뜨고
      // 내용은 새로고침해야 바뀌는 상황을 없앤다. (app.js 의 refresh)
      self.clients.matchAll({ type: 'window' }).then((list) => {
        for (const client of list) client.postMessage({ type: 'refresh' });
      }),
    ]);

    // 알림이 실제로 떴다고 서버에 알린다. 서버는 FCM 에 넘긴 것까지만 알 수
    // 있어 이 신호가 없으면 단말에서 사라진 알림을 재지 못한다.
    // showNotification 이 끝난 뒤에만 부른다 — "띄웠다"는 뜻이니까.
    // 실패해도 알림은 이미 떠 있으므로 삼킨다. id 가 없는 payload(테스트 알림)는
    // 서버에 대응하는 행이 없어 보내지 않는다.
    if (data.id != null) await reportDelivered(data.id);
  })());
});

async function reportDelivered(id) {
  try {
    const sub = await self.registration.pushManager.getSubscription();
    if (!sub) return;
    await fetch('/api/delivered', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: sub.endpoint, id }),
    });
  } catch {
    // 서버가 잠깐 안 받아도 알림은 이미 떴다. 여기서 실패를 올리면
    // waitUntil 이 거부돼 브라우저가 "백그라운드에서 갱신됨" 같은 대체
    // 알림을 띄울 수 있다 — 조용히 넘긴다.
  }
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      // 이미 열려 있는 창이 있으면 새 창을 띄우지 않고 그쪽으로 포커스를 옮긴다.
      for (const client of list) {
        if ('focus' in client) return client.focus();
      }
      return self.clients.openWindow('/');
    }),
  );
});

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
       * 종류만으로 묶으면 그 범위가 경기를 넘어간다 — 어제 경기의 종료 알림이
       * 알림함에 남아 있으면 오늘 종료 알림이 새로 뜨는 대신 그 자리를 갱신해,
       * 사용자에게는 알림이 아예 안 온 것으로 보인다. 그래서 경기까지 붙인다.
       *
       * 득점만 ts 를 쓴다 — 한 경기에 여러 번 나므로 경기 단위로 묶으면
       * 마지막 득점만 남는다. gameId 가 없는 payload(테스트 알림)도 ts 로 흘린다.
       */
      tag: data.kind === 'score'
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
  })());
});

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

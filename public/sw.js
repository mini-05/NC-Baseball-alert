/* 서비스 워커. 푸시 수신과 알림 클릭만 처리한다. */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

/*
 * 진동 패턴(ms, [울림, 멈춤, 울림...]). 화면을 안 봐도 구분되게 득점은 짧게 두 번,
 * 종료는 세 번.
 *
 * Android Chrome 계열만 된다. iOS Safari 는 무시한다(에러는 안 남).
 * 알림음은 OS 기본음이고 바꿀 방법이 없다(표준에서 sound 옵션이 빠짐).
 */
const VIBRATE = {
  start: [200],
  cancel: [200, 100, 200],
  score: [120, 80, 120],
  end: [200, 100, 200, 100, 200],
};

/**
 * 진동 on/off 설정. app.js 가 IndexedDB('nc-alert' / 'kv' / 'vibrate')에 저장한 값을
 * 읽는다. 앱이 꺼져 있어도 푸시는 오니까 localStorage 는 못 쓴다.
 * 못 읽으면 {} 를 줘서 전부 켜진 걸로 처리된다.
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
      // 연결은 항상 닫는다. 열어 두면 나중에 DB 버전을 올릴 때 막힌다.
      const done = (value) => { db.close(); resolve(value); };

      if (!db.objectStoreNames.contains('kv')) { done({}); return; }
      const getReq = db.transaction('kv', 'readonly').objectStore('kv').get('vibrate');
      getReq.onsuccess = () => done(getReq.result ?? {});
      getReq.onerror = () => done({});
    };
    req.onerror = () => resolve({});
    // 다른 탭이 예전 버전 연결을 잡고 있으면 여기로 온다. resolve 안 하면
    // waitUntil 이 안 끝나서 알림이 안 뜬다. 기본값으로 넘어간다.
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

    const ts = data.ts ?? Date.now();
    const options = {
      body: data.body ?? '',
      icon: '/icon-192.png',
      badge: '/badge-96.png',
      /*
       * tag 가 같으면 새로 쌓이지 않고 기존 알림을 덮어쓴다.
       * 경기 단위로 묶어서 알림함에는 그 경기의 최신 알림 하나만 남긴다
       * (득점마다 알림이 쌓이지 않게). 종류로만 묶으면 어제 경기 알림을 덮어쓴다.
       * 같은 이벤트인지는 tag 가 아니라 아래 data.id 로 본다.
       */
      tag: `nc-${data.gameId ?? data.kind ?? 'info'}`,
      renotify: true,
      timestamp: ts,
      vibrate: vibrateOn ? (VIBRATE[data.kind] ?? [200]) : [],
      // 아래 두 검사(같은 이벤트인지, 더 새 알림이 있는지)에서 읽는다.
      data: { url: '/', id: data.id ?? null, ts },
    };

    // 띄울지는 여기서 정한다(알림함은 기기에서만 보인다). 같은 tag 라고 같은
    // 이벤트는 아니니 data 로 비교한다.
    const existing = await self.registration.getNotifications({ tag: options.tag });

    /*
     * 1) 같은 이벤트가 떠 있으면 다시 안 띄운다.
     * 배달 확인만 실패해서 서버가 재발송하는 경우가 있다(2026-09-02). 원본이
     * 재발송보다 늦게 오는 경우도 있어서(2026-09-17) 재발송 여부와 상관없이 본다.
     * 건너뛰어도 배달 확인은 보낸다.
     */
    if (data.id != null && existing.some((n) => n.data?.id === data.id)) {
      await reportDelivered(data.id);
      return;
    }

    /*
     * 2) 더 새 알림이 떠 있으면 예전 알림으로 덮지 않는다.
     * 절전에서 깨어날 때 밀린 푸시가 순서 없이 오면 5회 득점 위에 3회 득점이
     * 덮여 점수가 거꾸로 보일 수 있다.
     */
    if (existing.some((n) => (n.data?.ts ?? 0) > options.timestamp)) {
      await reportDelivered(data.id);
      return;
    }

    await Promise.all([
      self.registration.showNotification(data.title ?? 'NC 다이노스', options),
      // 앱이 열려 있으면 화면도 바로 갱신하게 한다(app.js refresh).
      self.clients.matchAll({ type: 'window' }).then((list) => {
        for (const client of list) client.postMessage({ type: 'refresh' });
      }),
    ]);

    // 띄웠다고 서버에 알린다(배달 확인). showNotification 이 끝난 뒤에 부른다.
    await reportDelivered(data.id);
  })());
});

async function reportDelivered(id) {
  // id 가 없으면(테스트 알림) 서버에 해당 행이 없어서 안 보낸다.
  if (id == null) return;
  try {
    const sub = await self.registration.pushManager.getSubscription();
    if (!sub) return;
    await fetch('/api/delivered', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: sub.endpoint, id }),
    });
  } catch {
    // 실패해도 무시한다. 예외를 올리면 waitUntil 이 실패해서 브라우저가
    // "백그라운드에서 업데이트됨" 같은 알림을 대신 띄울 수 있다.
  }
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      // 열린 창이 있으면 그쪽으로 포커스, 없으면 새로 연다.
      for (const client of list) {
        if ('focus' in client) return client.focus();
      }
      return self.clients.openWindow('/');
    }),
  );
});

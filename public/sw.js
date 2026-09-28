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
       * 경기 하나가 그 범위다. 한 경기의 시작·득점·종료가 모두 같은 tag 를 써서
       * 알림함에는 그 경기의 가장 최근 것 하나만 남는다. 득점이 여러 번 나는
       * 경기에서 알림이 다섯 개씩 쌓이던 것을 없앤다 — 지난 득점은 이미 지난
       * 일이고, 알림함에서 보고 싶은 것은 지금 몇 대 몇인가다.
       *
       * 경기까지는 갈라야 한다. 종류만으로 묶으면 어제 경기의 알림을 덮어써
       * 새 알림이 안 뜬 것처럼 보인다.
       *
       * id 를 tag 에 안 쓴다. 이벤트마다 고유해서 tag 도 매번 달라지고, 그러면
       * 무엇도 합쳐지지 않는다. 대신 아래에서 data.id 로 같은 이벤트인지 본다.
       */
      tag: `nc-${data.gameId ?? data.kind ?? 'info'}`,
      renotify: true,
      timestamp: data.ts ?? Date.now(),
      vibrate: vibrateOn ? (VIBRATE[data.kind] ?? [200]) : [],
      /*
       * id·ts 를 함께 싣는다. tag 를 경기 단위로 공유하게 됐으므로, 떠 있는
       * 알림이 "같은 이벤트인지" "더 새것인지"를 tag 로는 못 가린다. 아래 두
       * 검사가 이 값을 읽는다.
       */
      data: { url: '/', id: data.id ?? null, ts: data.ts ?? Date.now() },
    };

    /*
     * 띄울지 말지는 단말이 정한다. 알림함을 볼 수 있는 쪽이 여기뿐이다.
     *
     * tag 가 경기 단위라 같은 tag 에 걸리는 것이 "같은 이벤트"라는 보장이
     * 없어졌다. 그래서 tag 존재만 보고 건너뛰면 안 된다 — 그러면 새 득점 알림이
     * 직전 알림에 막혀 영영 안 뜬다. 무엇이 떠 있는지 data 로 따진다.
     */
    const existing = await self.registration.getNotifications({ tag: options.tag });

    /*
     * 1) 같은 이벤트가 이미 떠 있으면 다시 안 띄운다.
     *
     * 서버는 "배달 확인이 안 왔다"까지만 알 수 있고 그 확인 자체가 실패할 때가
     * 있어(2026-09-02: 화면에는 떴는데 확인만 안 올라간 건) 멀쩡히 본 알림을
     * 재발송한다. 재발송 여부와 무관하게 검사해야 한다 — FCM 이 첫 푸시를 물고
     * 있다가 재발송보다 늦게 흘리는 경우가 있어(2026-09-17 관측) 원래 푸시가
     * 뒤늦게 도착하는 방향도 막아야 한다. 넘길 때도 확인은 다시 올려 보낸다.
     */
    if (data.id != null && existing.some((n) => n.data?.id === data.id)) {
      await reportDelivered(data.id);
      return;
    }

    /*
     * 2) 더 새 알림이 이미 떠 있으면 옛 알림으로 덮어쓰지 않는다.
     *
     * 도즈에서 깨어날 때 밀려 있던 푸시가 한꺼번에 오는데 순서가 보장되지
     * 않는다. 그대로 두면 5회 득점 알림이 떠 있는 자리에 3회 득점이 덮여
     * 점수가 거꾸로 간다. 최신 하나만 남기는 것이 목적이므로 최신이 남아야 한다.
     */
    if (existing.some((n) => (n.data?.ts ?? 0) > options.timestamp)) {
      if (data.id != null) await reportDelivered(data.id);
      return;
    }

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

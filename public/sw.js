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

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'NC 다이노스', body: event.data?.text() ?? '' };
  }

  const options = {
    body: data.body ?? '',
    icon: '/icon-192.png',
    badge: '/badge-96.png',
    // 같은 종류의 알림은 최신 것으로 덮어써 알림창이 쌓이지 않게 한다.
    // 단 득점은 매 상황을 따로 보여주는 편이 유용하므로 태그를 나눈다.
    tag: data.kind === 'score' ? `score-${data.ts}` : `nc-${data.kind ?? 'info'}`,
    renotify: true,
    timestamp: data.ts ?? Date.now(),
    vibrate: VIBRATE[data.kind] ?? [200],
    data: { url: '/' },
  };

  event.waitUntil(Promise.all([
    self.registration.showNotification(data.title ?? 'NC 다이노스', options),
    // 앱이 열려 있으면 화면도 그 자리에서 갱신하게 알린다 — 알림만 뜨고
    // 내용은 새로고침해야 바뀌는 상황을 없앤다. (app.js 의 refresh)
    self.clients.matchAll({ type: 'window' }).then((list) => {
      for (const client of list) client.postMessage({ type: 'refresh' });
    }),
  ]));
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

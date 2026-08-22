/* 서비스 워커 — 푸시 수신과 알림 클릭 처리만 담당한다. */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

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
    data: { url: '/' },
  };

  event.waitUntil(self.registration.showNotification(data.title ?? 'NC 다이노스', options));
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

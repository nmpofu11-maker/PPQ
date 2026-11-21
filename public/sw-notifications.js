self.addEventListener('push', (event) => {
  if (!event.data) return;

  let payload = {
    title: 'PitchPulse Quant Alert',
    body: 'New live momentum edge detected.',
    icon: '/pwa-192x192.png',
    badge: '/pwa-192x192.png',
    tag: 'pitchpulse-push',
    vibrate: [200, 90, 200],
    data: { matchId: '', url: '/' },
  };

  try {
    const parsed = event.data.json();
    payload = { ...payload, ...parsed };
  } catch {
    payload.body = event.data.text();
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: payload.icon,
      badge: payload.badge,
      tag: payload.tag,
      renotify: true,
      vibrate: payload.vibrate,
      data: payload.data,
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const matchId = data.matchId || '';
  const targetUrl = matchId ? `/?matchId=${encodeURIComponent(matchId)}` : '/';

  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          if ('focus' in client) {
            client.postMessage({
              type: 'SELECT_MATCH_FROM_ALERT',
              matchId,
            });
            return client.focus();
          }
        }
        if (self.clients.openWindow) {
          return self.clients.openWindow(targetUrl);
        }
        return undefined;
      })
  );
});

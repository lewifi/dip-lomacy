// Dip-lomacy service worker — powers "remind me before the week ends" push.
// The server sends a contentless push (a "tickle"); this worker fetches the live
// scores and builds the notification here, so no payload encryption is needed.
// Recipients are only ever pinged when their own side is losing, so "your side"
// is accurate by construction.

const ICON = '/favicon.svg';

self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  event.waitUntil(buildAndShow());
});

async function buildAndShow() {
  let title = 'The Snack War needs you';
  let body = 'Your side is slipping before the week closes. Get back in there.';

  try {
    const res = await fetch('/api/scores', { cache: 'no-store' });
    if (res.ok) {
      const s = await res.json();
      const wt = s.weekly_tendie || 0;
      const wd = s.weekly_dimmie || 0;
      const total = wt + wd;
      const tPct = total === 0 ? 50 : Math.round((wt / total) * 100);
      const dPct = 100 - tPct;

      // Recipients were only pinged if their side is the one losing.
      const tendieLosing = wt <= wd;
      if (tendieLosing) {
        title = '🍗 Tendie is losing the week!';
        body = `Tendie ${tPct}% vs Dimmie ${dPct}%. The tendies need you before Monday.`;
      } else {
        title = '🥟 Dimmie is losing the week!';
        body = `Dimmie ${dPct}% vs Tendie ${tPct}%. Time to earn some respect before Monday.`;
      }
    }
  } catch (e) {
    // fall through to the generic copy
  }

  return self.registration.showNotification(title, {
    body,
    icon: ICON,
    badge: ICON,
    tag: 'diplomacy-weekly',
    renotify: true,
    data: { url: '/' },
  });
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if ('focus' in w) return w.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});

// Hamptons Coconuts dashboard: RETIRED service worker (2026-09-24).
// Cache version marker: 'hc-deliveries-v6-retired'. Changing this file's
// bytes is what makes browsers notice a new service worker and install it.
//
// Why this file still exists: the dashboard moved to
// https://app.hamptonscoconuts.com/ and this GitHub Pages site is now only a
// "moved" notice. The OLD version of this file saved the whole old app on each
// phone and served that saved copy first, so a phone that had not opened the
// site in a while would keep showing the old app. This version removes itself:
//  - install: take over right away instead of waiting for old tabs to close.
//  - activate: delete EVERY saved copy (all caches), take control of any open
//    page, then unregister so this worker never runs again.
//  - There is deliberately NO fetch listener, so this worker never answers a
//    request itself. Every request goes straight to the network and gets the
//    new notice page.
//  - It also does NOT force open pages to reload. GitHub Pages lets browsers
//    reuse a saved index.html for a few minutes, and a forced reload could
//    bounce between the old page and this worker. The next normal open shows
//    the notice.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
      .then(() => self.registration.unregister())
      .catch(() => self.registration.unregister())   // even if a cleanup step fails, still remove this worker
  );
});

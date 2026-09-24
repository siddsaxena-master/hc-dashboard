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
//  - activate then reloads any open window of the old app once, to ?moved=1,
//    so it switches to the notice right away (otherwise the old app keeps
//    running in that tab until the next cold open, which on an iPhone
//    home-screen app can be days). That address was never used before, so it
//    always comes fresh from the network, and a page already on ?moved=1 is
//    never reloaded again, so this can never loop.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
      .catch(() => {})   // a failed cleanup must not stop the steps below
      .then(() => self.clients.claim())
      // Unregister BEFORE reloading, so the reload is not routed through this worker.
      .then(() => self.registration.unregister())
      .then(() => self.clients.matchAll({ type: 'window' }))
      .then((wins) => Promise.all(wins.map((win) => {
        // Reload each open copy of the old app once. GitHub Pages lets a browser
        // reuse its saved copy of the plain address for up to 10 minutes, so we
        // reload to '?moved=1', an address the old app never used. The check
        // below stops a second reload.
        const url = new URL(win.url);
        if (url.searchParams.has('moved')) return null;
        if (typeof win.navigate !== 'function') return null;   // older browsers: next open shows the notice
        url.searchParams.set('moved', '1');
        return win.navigate(url.href).catch(() => null);
      })))
      .catch(() => self.registration.unregister())   // even if a step fails, still remove this worker
  );
});

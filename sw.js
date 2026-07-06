// Hamptons Coconuts dashboard — offline service worker.
// Lets the app OPEN and run with no signal (field deliveries in dead zones).
// It caches the app itself, but never interferes with live data:
//  - Only same-origin GET requests are cached (the app shell, icons).
//  - Cross-origin calls (Supabase, Google sign-in, fonts) always go to the network.
//  - Writes (POST/PATCH) are never touched, so signing/saving works normally.

const CACHE = 'hc-deliveries-v3';  // v3: 2026-07-05 UI redesign — bump forces clients to fetch the new shell
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL).catch(() => {}))   // tolerate a missing optional file
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                 // leave writes alone
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;  // let Supabase/Google/fonts hit the network
  e.respondWith(
    caches.match(req).then((cached) => {
      const fromNet = fetch(req).then((resp) => {
        if (resp && resp.status === 200) {
          const copy = resp.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return resp;
      }).catch(() => cached);
      return cached || fromNet;                      // cached first (instant + offline), refresh in background
    })
  );
});

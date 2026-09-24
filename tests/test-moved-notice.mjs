// Safety checks for the "dashboard moved" notice that replaced the old
// GitHub Pages dashboard (2026-09-24).
//
// Run with: node tests/test-moved-notice.mjs
// No database or network connection is used. Exits non-zero on any failure.
//
// What it proves:
//  - index.html only points people to app.hamptonscoconuts.com and carries no
//    database address, no key, no email address and makes no network calls.
//  - index.html's small script removes old service workers and saved caches,
//    and is safe to run twice or on a browser without those features.
//  - sw.js never answers requests itself, deletes every cache and unregisters.

import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const read = (name) => readFileSync(new URL(name, root), 'utf8');

const html = read('index.html');
const sw = read('sw.js');
const manifest = JSON.parse(read('manifest.webmanifest'));

const checks = [];
function check(name, test) {
  checks.push({ name, test });
}

// Pull out the text of every <script>...</script> block in the page.
function inlineScripts(source) {
  return [...source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .map((m) => ({ attrs: m[1], body: m[2] }));
}

// Let pending promise callbacks (from either the test or the vm) finish.
async function settle() {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
}

// A pretend browser: some old service worker registrations and saved caches.
function fakeBrowser({ registrations = 2, cacheNames = ['hc-deliveries-v5', 'hc-deliveries-v4'] } = {}) {
  const state = { regs: [], caches: new Set(cacheNames), unregisterCalls: 0, deleteCalls: 0 };
  for (let i = 0; i < registrations; i += 1) {
    const reg = {
      unregister() {
        state.unregisterCalls += 1;
        state.regs = state.regs.filter((r) => r !== reg);
        return Promise.resolve(true);
      },
    };
    state.regs.push(reg);
  }
  const navigator = {
    serviceWorker: { getRegistrations: () => Promise.resolve([...state.regs]) },
  };
  const caches = {
    keys: () => Promise.resolve([...state.caches]),
    delete: (name) => {
      state.deleteCalls += 1;
      return Promise.resolve(state.caches.delete(name));
    },
  };
  return { state, navigator, caches };
}

// ---------- index.html: content rules ----------

check('page title says the dashboard moved', () => {
  assert.match(html, /<title>Hamptons Coconuts: dashboard moved<\/title>/);
});

check('page shows the moved message', () => {
  assert.ok(html.includes(
    'This dashboard has moved to app.hamptonscoconuts.com. Sign in there with your work email.',
  ));
});

check('page links to https://app.hamptonscoconuts.com/ with rel="noopener"', () => {
  const links = [...html.matchAll(/<a\b[^>]*>/gi)].map((m) => m[0]);
  assert.equal(links.length, 1, 'exactly one link on the page');
  assert.match(links[0], /href="https:\/\/app\.hamptonscoconuts\.com\/"/);
  assert.match(links[0], /rel="[^"]*\bnoopener\b[^"]*"/);
});

check('page has no Supabase reference (any case)', () => {
  assert.ok(!/supabase/i.test(html));
});

check('page has no JWT-looking key (eyJ)', () => {
  assert.ok(!html.includes('eyJ'));
});

check('page has no "@" at all, so no email address can hide in it', () => {
  assert.ok(!html.includes('@'));
});

check('page makes no network calls (no fetch, XHR, WebSocket, beacon)', () => {
  assert.ok(!html.includes('fetch('));
  assert.ok(!/XMLHttpRequest|WebSocket|sendBeacon|EventSource/.test(html));
});

check('page does not register a service worker again', () => {
  assert.ok(!/serviceWorker\s*\.\s*register\s*\(/.test(html));
});

check('page loads no external scripts, styles or fonts', () => {
  assert.ok(!/<script\b[^>]*\bsrc\s*=/i.test(html), 'no <script src>');
  assert.ok(!/rel="stylesheet"/i.test(html), 'no linked stylesheet');
  assert.ok(!/fonts\.googleapis|fonts\.gstatic|import\s+url|url\(/i.test(html), 'no web fonts');
  // The only full web address allowed anywhere in the page is the new app.
  const urls = html.match(/https?:\/\/[^\s"'<>)]+/g) || [];
  assert.deepEqual([...new Set(urls)], ['https://app.hamptonscoconuts.com/']);
});

check('page has exactly one small inline script', () => {
  const scripts = inlineScripts(html);
  assert.equal(scripts.length, 1);
  assert.ok(scripts[0].body.length < 2000, 'script stays small');
});

check('page files it references exist (icons, manifest)', () => {
  for (const name of ['manifest.webmanifest', 'icon-180.png', 'icon-192.png']) {
    assert.ok(html.includes(`href="${name}"`), `page references ${name}`);
    assert.ok(existsSync(new URL(name, root)), `${name} exists`);
  }
});

check('page and sw.js contain no em or en dashes', () => {
  assert.ok(!/[\u2013\u2014]/.test(html), 'index.html');
  assert.ok(!/[\u2013\u2014]/.test(sw), 'sw.js');
});

// ---------- index.html: the cleanup script really works ----------

check('page script names the right browser calls', () => {
  const body = inlineScripts(html)[0].body;
  assert.match(body, /navigator\.serviceWorker\.getRegistrations\(\)/);
  assert.match(body, /\.unregister\(\)/);
  assert.match(body, /caches\.keys\(\)/);
  assert.match(body, /caches\.delete\(/);
});

check('page script unregisters every service worker and deletes every cache', async () => {
  const body = inlineScripts(html)[0].body;
  const b = fakeBrowser({ registrations: 3, cacheNames: ['hc-deliveries-v5', 'a', 'b'] });
  vm.runInNewContext(body, { navigator: b.navigator, caches: b.caches });
  await settle();
  assert.equal(b.state.regs.length, 0, 'no registrations left');
  assert.equal(b.state.caches.size, 0, 'no caches left');
  assert.equal(b.state.unregisterCalls, 3);
});

check('page script is safe to run twice', async () => {
  const body = inlineScripts(html)[0].body;
  const b = fakeBrowser();
  const context = vm.createContext({ navigator: b.navigator, caches: b.caches });
  vm.runInContext(body, context);
  await settle();
  const afterFirst = { ...b.state };
  vm.runInContext(body, context);   // second run: nothing left, must not throw
  await settle();
  assert.equal(b.state.regs.length, 0);
  assert.equal(b.state.caches.size, 0);
  assert.equal(b.state.unregisterCalls, afterFirst.unregisterCalls, 'no extra unregisters');
  assert.equal(b.state.deleteCalls, afterFirst.deleteCalls, 'no extra deletes');
});

check('page script does not crash on a browser without these features', async () => {
  const body = inlineScripts(html)[0].body;
  vm.runInNewContext(body, { navigator: {} });                        // no serviceWorker, no caches
  vm.runInNewContext(body, { navigator: { serviceWorker: {} } });     // serviceWorker without getRegistrations
  // Features present but failing: errors must be swallowed, not thrown.
  vm.runInNewContext(body, {
    navigator: { serviceWorker: { getRegistrations: () => Promise.reject(new Error('blocked')) } },
    caches: { keys: () => Promise.reject(new Error('blocked')), delete: () => Promise.resolve(false) },
  });
  await settle();
});

// ---------- sw.js: the self-destructing service worker ----------

check('sw.js never answers requests itself (no respondWith, no fetch listener)', () => {
  assert.ok(!sw.includes('respondWith'));
  assert.ok(!/addEventListener\(\s*['"]fetch['"]/.test(sw));
  assert.ok(!sw.includes('fetch('));
});

check('sw.js deletes caches, skips waiting and unregisters', () => {
  assert.match(sw, /self\.skipWaiting\(\)/);
  assert.match(sw, /caches\.delete\(/);
  assert.match(sw, /self\.clients\.claim\(\)/);
  assert.match(sw, /self\.registration\.unregister\(\)/);
  assert.ok(!/caches\.open|addAll/.test(sw), 'no longer saves anything');
});

check('sw.js carries the new version marker so browsers see a changed file', () => {
  assert.ok(sw.includes('hc-deliveries-v6-retired'));
  assert.ok(!sw.includes("'hc-deliveries-v5'"));
});

check('sw.js has no Supabase reference or key', () => {
  assert.ok(!/supabase/i.test(sw));
  assert.ok(!sw.includes('eyJ'));
});

// Run sw.js against a pretend service worker environment.
function fakeWorker({ cacheNames = ['hc-deliveries-v5', 'other'], keysFails = false } = {}) {
  const log = [];
  const listeners = {};
  const store = new Set(cacheNames);
  const self = {
    addEventListener: (type, fn) => { listeners[type] = fn; },
    skipWaiting: () => { log.push('skipWaiting'); return Promise.resolve(); },
    clients: { claim: () => { log.push('claim'); return Promise.resolve(); } },
    registration: { unregister: () => { log.push('unregister'); return Promise.resolve(true); } },
  };
  const caches = {
    keys: () => (keysFails ? Promise.reject(new Error('blocked')) : Promise.resolve([...store])),
    delete: (name) => { log.push(`delete:${name}`); return Promise.resolve(store.delete(name)); },
  };
  vm.runInNewContext(sw, { self, caches });
  return { log, listeners, store };
}

async function fire(listeners, type) {
  let pending = Promise.resolve();
  listeners[type]({ waitUntil: (p) => { pending = p; } });
  await pending;
}

check('sw.js only listens for install and activate', () => {
  const w = fakeWorker();
  assert.deepEqual(Object.keys(w.listeners).sort(), ['activate', 'install']);
});

check('sw.js install takes over right away', async () => {
  const w = fakeWorker();
  await fire(w.listeners, 'install');
  assert.deepEqual(w.log, ['skipWaiting']);
});

check('sw.js activate deletes ALL caches, then claims, then unregisters', async () => {
  const w = fakeWorker({ cacheNames: ['hc-deliveries-v5', 'hc-deliveries-v4', 'x'] });
  await fire(w.listeners, 'activate');
  assert.equal(w.store.size, 0, 'every cache deleted');
  const claimAt = w.log.indexOf('claim');
  const unregisterAt = w.log.indexOf('unregister');
  const lastDelete = Math.max(...w.log.map((l, i) => (l.startsWith('delete:') ? i : -1)));
  assert.ok(lastDelete < claimAt && claimAt < unregisterAt, `order was ${w.log.join(', ')}`);
});

check('sw.js still unregisters when cache cleanup fails', async () => {
  const w = fakeWorker({ keysFails: true });
  await fire(w.listeners, 'activate');
  assert.ok(w.log.includes('unregister'));
});

// ---------- manifest ----------

check('manifest name says the dashboard moved', () => {
  assert.equal(manifest.name, 'HC Dashboard (moved)');
});

// ---------- run ----------

let failed = 0;
// Any promise rejection nobody handled counts as a failure.
process.on('unhandledRejection', (err) => {
  failed += 1;
  console.error(`FAIL  unhandled promise rejection: ${err && err.message}`);
});
for (const { name, test } of checks) {
  try {
    await test();
    console.log(`PASS  ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL  ${name}\n      ${err.message}`);
  }
}
await settle();
if (failed) {
  console.error(`\n${failed} of ${checks.length} moved-notice checks FAILED`);
  process.exit(1);
}
console.log(`\nPASS  ${checks.length}/${checks.length} moved-notice checks`);

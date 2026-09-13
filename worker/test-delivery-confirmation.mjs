// Tests for the delivery-time confirmation push scan in worker.js.
//
// Why this file exists: when the owner confirms a delivery time in the
// app's Calendar (migration 034 delivery_request), owner and manager
// phones get one banner. Sending it twice is noise; sending it to the
// wrong market is a leak; sending nothing loses the whole point. The
// rules are pinned here.
//
// Run it with:  node worker/test-delivery-confirmation.mjs
//
// No test framework and no network. We swap the global fetch for a fake
// one that records every call and hands back whatever rows a case wants,
// so nothing here can touch Supabase, Apple, or Telegram.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  runDeliveryConfirmationScan,
  deliveryConfirmationMessage,
  deliveryConfirmationQueueId,
  formatDeliveryDay,
} from './worker.js';

// ── fixtures (all made up, no real customer data) ──────────────────
const SB = 'https://example.invalid';
const env = { SUPABASE_URL: SB, SUPABASE_SERVICE_KEY: 'not-a-real-key', ALLOWED_CHAT_IDS: '111, 222' };
const ORDER_ID = '0f1e2d3c-4b5a-4a6b-8c7d-9e0f1a2b3c4d';
// Postgres now() shape on purpose: the '+' and the dots must survive the
// URL guard untouched.
const CHECKED = '2026-09-07T14:03:22.123456+00:00';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const STAFF = [
  { email: 'owner@example.com', role: 'owner', market: 'ny' },
  { email: 'ny.manager@example.com', role: 'manager', market: 'ny' },
  { email: 'miami.manager@example.com', role: 'manager', market: 'miami' },
  { email: 'crew@example.com', role: 'team', market: 'ny' },
];
const TOKENS = {
  'owner@example.com': 'owner-token',
  'ny.manager@example.com': 'ny-manager-token',
  'miami.manager@example.com': 'miami-token',
  'crew@example.com': 'crew-token',
};

// One confirmed request as the app writes it.
function request(extra = {}) {
  return { date: '2026-09-11', window: '2:00 PM', status: 'confirmed', source: 'owner', checked_at: CHECKED, ...extra };
}
// One order row as the scan's SELECT returns it.
function order(extra = {}) {
  return {
    id: ORDER_ID,
    client_name: 'Acme Beach Club',
    market: 'ny',
    venue: 'Acme Beach Club, Southampton',
    delivery_at_utc: '2026-09-11T12:00:00+00:00',
    delivery_request: request(),
    ...extra,
  };
}

function reply(status, data = null) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return data; },
    async text() { return data == null ? '' : JSON.stringify(data); },
  };
}

// ── fake Supabase ──────────────────────────────────────────────────
// Records every call. `rows` is what the orders read returns AFTER the
// same filters the real database would apply (so a case can prove the
// scan asks for them). Knobs: ordersRead 'ok' | '500' | 'throw',
// queueInsert 'ok' | '503', stamp 'echo' | 'none' | '500'.
function harness(opts = {}) {
  const rows = opts.rows || [];
  const ordersRead = opts.ordersRead || 'ok';
  const queueInsert = opts.queueInsert || 'ok';
  const stamp = opts.stamp || 'echo';
  const calls = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (urlValue, options = {}) => {
    const url = String(urlValue);
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, method, body, headers: options.headers || {} });

    if (method === 'GET' && url.startsWith(SB + '/rest/v1/orders?')) {
      if (ordersRead === 'throw') throw new Error('simulated network failure');
      if (ordersRead === '500') return reply(500, { message: 'boom' });
      const asksNotNotified = url.includes('delivery_request->>notified_at=is.null');
      const asksConfirmed = url.includes('delivery_request->>status=eq.confirmed');
      const asksOwner = url.includes('delivery_request->>source=eq.owner');
      const asksLive = url.includes('stage=neq.cancelled');
      return reply(200, rows.filter((r) => {
        const dr = r.delivery_request || {};
        if (asksNotNotified && dr.notified_at != null) return false;
        if (asksConfirmed && dr.status !== 'confirmed') return false;
        if (asksOwner && dr.source !== 'owner') return false;
        if (asksLive && r.stage === 'cancelled') return false;
        return true;
      }));
    }
    if (method === 'GET' && url.startsWith(SB + '/rest/v1/field_workers?')) {
      return reply(200, STAFF.map((s) => ({ ...s, active: true, name: s.email.split('@')[0] })));
    }
    // The market-wide send reads open shifts to find the clocked-in crew.
    // Nobody is clocked in here, so every active team phone in the market
    // is a recipient (Sidd's rule, 2026-09-13).
    if (method === 'GET' && url.startsWith(SB + '/rest/v1/shifts?')) {
      return reply(200, []);
    }
    if (method === 'GET' && url.startsWith(SB + '/rest/v1/push_tokens?')) {
      // Honor the email=in.("a","b") filter exactly like PostgREST would,
      // so a token the worker did not ask for never sneaks into a send.
      const list = decodeURIComponent(url.split('email=in.(')[1].split(')')[0]);
      const wanted = list.split(',').map((s) => s.replace(/"/g, '').trim().toLowerCase());
      return reply(200, wanted.filter((e) => TOKENS[e]).map((e) => ({ email: e, apns_token: TOKENS[e] })));
    }
    if (method === 'POST' && url === SB + '/rest/v1/push_queue') {
      if (queueInsert === '503') return reply(503, { message: 'queue down' });
      return reply(201, null);
    }
    if (method === 'GET' && url.startsWith(SB + '/rest/v1/push_queue?id=eq.')) {
      return reply(200, []); // verification lookup after a failed insert: nothing there
    }
    if (method === 'PATCH' && url.startsWith(SB + '/rest/v1/orders?id=eq.')) {
      if (stamp === '500') return reply(500, { message: 'stamp down' });
      if (stamp === 'none') return reply(200, []);
      return reply(200, [{ id: ORDER_ID, delivery_request: body.delivery_request }]);
    }
    throw new Error('unexpected offline fetch: ' + method + ' ' + url);
  };

  return {
    calls,
    ordersReads: () => calls.filter((c) => c.method === 'GET' && c.url.startsWith(SB + '/rest/v1/orders?')),
    queuePosts: () => calls.filter((c) => c.method === 'POST' && c.url === SB + '/rest/v1/push_queue'),
    stamps: () => calls.filter((c) => c.method === 'PATCH'),
    restore() { globalThis.fetch = originalFetch; },
  };
}

// Run the scan with console output captured, so a failure case's logging
// does not bury the PASS/FAIL lines. Returns { counts, logs, errors }.
async function runScan(h) {
  const logs = [], errors = [];
  const origLog = console.log, origErr = console.error;
  console.log = (...a) => logs.push(a.join(' '));
  console.error = (...a) => errors.push(a.map(String).join(' '));
  try {
    const counts = await runDeliveryConfirmationScan(env);
    return { counts, logs, errors };
  } finally {
    console.log = origLog;
    console.error = origErr;
    h.restore();
  }
}

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const PHONE_RE = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/;

// ── tiny runner ────────────────────────────────────────────────────
const cases = [];
function test(name, fn) { cases.push({ name, fn }); }

// ── 1) the happy path ──────────────────────────────────────────────
test('one confirmed row: one push with the right title, body, market, and one guarded stamp', async () => {
  const h = harness({ rows: [order()] });
  const { counts, logs } = await runScan(h);

  // The read asks the database for exactly the contract's filters.
  const reads = h.ordersReads();
  assert.equal(reads.length, 1);
  const url = reads[0].url;
  for (const part of [
    'select=id,client_name,market,venue,delivery_at_utc,delivery_request',
    'delivery_request->>status=eq.confirmed',
    'delivery_request->>source=eq.owner',
    'delivery_request->>notified_at=is.null',
    'stage=neq.cancelled',
    'order=updated_at.asc',
    'limit=20',
  ]) assert.ok(url.includes(part), 'orders read is missing ' + part);
  assert.equal(reads[0].headers.apikey, 'not-a-real-key');

  // Exactly one queue row, with the words and the recipients we expect.
  const posts = h.queuePosts();
  assert.equal(posts.length, 1);
  const q = posts[0].body;
  assert.equal(q.kind, 'alert');
  assert.equal(q.payload.aps.alert.title, 'Delivery time confirmed');
  assert.equal(q.payload.aps.alert.body, 'Acme Beach Club · Sep 11 · 2:00 PM');
  // No Telegram copy any more (Sidd, 2026-09-13: everything through the app).
  assert.equal(q.payload.telegram_text, null);
  assert.deepEqual(q.payload.fallback_chat_ids, []);
  assert.equal(q.payload.headers.topic, 'com.hamptonscoconuts.field');
  // Each order's banners share one collapse id so the newest replaces the last.
  assert.equal(q.payload.headers.collapse_id, 'dep-' + ORDER_ID);
  assert.equal(q.payload.body.kind, 'confirmed');
  assert.equal(q.payload.body.order_id, ORDER_ID);
  // Owner, the NY manager, and the NY crew (nobody is clocked in, so every
  // active NY team phone); never the Miami manager.
  assert.deepEqual([...q.payload.tokens].sort(), ['crew-token', 'ny-manager-token', 'owner-token']);

  // Exactly one stamp, guarded on id AND the checked_at we read, asking
  // for the changed rows back, writing the whole object plus notified_at.
  const stamps = h.stamps();
  assert.equal(stamps.length, 1);
  assert.equal(stamps[0].url,
    SB + '/rest/v1/orders?id=eq.' + ORDER_ID +
    '&delivery_request->>checked_at=eq.' + encodeURIComponent(CHECKED));
  assert.ok(stamps[0].url.includes('%2B00%3A00'), 'the + in checked_at must be percent-encoded');
  assert.equal(stamps[0].headers.Prefer, 'return=representation');
  const written = stamps[0].body.delivery_request;
  assert.ok(Number.isFinite(Date.parse(written.notified_at)), 'notified_at must be an ISO timestamp');
  const { notified_at, ...rest } = written;
  assert.deepEqual(rest, request());
  assert.deepEqual(Object.keys(stamps[0].body), ['delivery_request']);

  // Push first, stamp second.
  const postAt = h.calls.indexOf(posts[0]);
  const stampAt = h.calls.indexOf(stamps[0]);
  assert.ok(postAt < stampAt, 'the push must be queued before the row is stamped');

  assert.deepEqual(counts, { seen: 1, pushed: 1, stamped: 1, reedited: 0, skipped: 0, failed: 0 });
  assert.ok(logs.some((l) => l.startsWith('delivery confirmation scan: ')), 'counts are logged');
});

// ── 2) already notified: nothing ───────────────────────────────────
test('a row already notified is filtered out by the read, so nothing is sent', async () => {
  const h = harness({ rows: [order({ delivery_request: request({ notified_at: '2026-09-07T14:05:00.000Z' }) })] });
  const { counts } = await runScan(h);
  assert.ok(h.ordersReads()[0].url.includes('delivery_request->>notified_at=is.null'));
  assert.equal(h.queuePosts().length, 0);
  assert.equal(h.stamps().length, 0);
  assert.deepEqual(counts, { seen: 0, pushed: 0, stamped: 0, reedited: 0, skipped: 0, failed: 0 });
});

test('requested, conflict, email-sourced, and cancelled rows are never announced', async () => {
  const h = harness({ rows: [
    order({ delivery_request: request({ status: 'requested' }) }),
    order({ delivery_request: request({ status: 'conflict' }) }),
    order({ delivery_request: request({ source: 'email' }) }),
    order({ stage: 'cancelled' }),
  ] });
  await runScan(h);
  assert.equal(h.queuePosts().length, 0);
  assert.equal(h.stamps().length, 0);
});

// ── 3) location ────────────────────────────────────────────────────
test('a location is appended after the window; the venue column itself is not used', async () => {
  const h = harness({ rows: [order({
    venue: 'service entrance on Main St, gate code 1234', // 034 mirrors location into venue
    delivery_request: request({ location: 'service entrance on Main St, gate code 1234', venue_before: 'Acme Beach Club, Southampton' }),
  })] });
  await runScan(h);
  const q = h.queuePosts()[0].body;
  assert.equal(q.payload.aps.alert.body,
    'Acme Beach Club · Sep 11 · 2:00 PM · service entrance on Main St, gate code 1234');
  // venue_before travels back into the stamp untouched (whole object + notified_at).
  assert.equal(h.stamps()[0].body.delivery_request.venue_before, 'Acme Beach Club, Southampton');
});

test('a blank location is left out, and stray spaces are trimmed', () => {
  assert.equal(deliveryConfirmationMessage(order({ delivery_request: request({ location: '   ' }) })).body,
    'Acme Beach Club · Sep 11 · 2:00 PM');
  assert.equal(deliveryConfirmationMessage(order({ delivery_request: request({ window: '  10am - 12pm ', location: ' side gate ' }) })).body,
    'Acme Beach Club · Sep 11 · 10am - 12pm · side gate');
});

// ── 4) failures never throw ────────────────────────────────────────
test('a failed read never throws and never writes', async () => {
  for (const ordersRead of ['throw', '500']) {
    const h = harness({ rows: [order()], ordersRead });
    const { counts } = await runScan(h);
    assert.equal(h.queuePosts().length, 0, ordersRead + ': no push');
    assert.equal(h.stamps().length, 0, ordersRead + ': no stamp');
    assert.equal(counts.seen, 0);
  }
});

test('a push that never reached the queue leaves the row unstamped for the next tick', async () => {
  const h = harness({ rows: [order()], queueInsert: '503' });
  const { counts } = await runScan(h);
  assert.ok(h.queuePosts().length >= 1, 'the insert was attempted');
  assert.equal(h.stamps().length, 0, 'nothing is stamped when nothing was queued');
  assert.deepEqual(counts, { seen: 1, pushed: 0, stamped: 0, reedited: 0, skipped: 0, failed: 1 });
});

// ── 5) the guard losing the race is quiet ──────────────────────────
test('a stamp that matches zero rows (re-edited meanwhile) is a quiet skip, not an error', async () => {
  const h = harness({ rows: [order()], stamp: 'none' });
  const { counts, errors } = await runScan(h);
  assert.equal(h.queuePosts().length, 1);
  assert.equal(h.stamps().length, 1);
  assert.deepEqual(counts, { seen: 1, pushed: 1, stamped: 0, reedited: 1, skipped: 0, failed: 0 });
  assert.equal(errors.length, 0, 'no error is logged for a lost guard race');
});

test('a stamp that fails outright is counted and still never throws', async () => {
  const h = harness({ rows: [order()], stamp: '500' });
  const { counts } = await runScan(h);
  assert.deepEqual(counts, { seen: 1, pushed: 1, stamped: 0, reedited: 0, skipped: 0, failed: 1 });
});

// ── 6) deterministic queue id ──────────────────────────────────────
test('the queue id is deterministic across two runs and changes with checked_at', async () => {
  const first = harness({ rows: [order()] });
  await runScan(first);
  const second = harness({ rows: [order()] });
  await runScan(second);
  const a = first.queuePosts()[0].body.id;
  const b = second.queuePosts()[0].body.id;
  assert.equal(a, b, 'same order + same checked_at must reuse the same queue row id');
  assert.match(a, UUID_RE);
  assert.equal(a, await deliveryConfirmationQueueId(ORDER_ID, CHECKED));

  const other = harness({ rows: [order({ delivery_request: request({ checked_at: '2026-09-07T15:00:00.000000+00:00' }) })] });
  await runScan(other);
  assert.notEqual(other.queuePosts()[0].body.id, a, 'a fresh owner edit gets a fresh queue row');
  assert.notEqual(await deliveryConfirmationQueueId('another-order', CHECKED), a);
});

// ── 7) no email, no phone ──────────────────────────────────────────
test('the banner never carries an email address or a phone number', async () => {
  // Even if the row came back wider than the SELECT (it cannot, but be
  // paranoid), none of that reaches the words that go to a phone.
  const h = harness({ rows: [order({
    client_email: 'someone@customer.example',
    client_phone: '(631) 555-0199',
    delivery_notes: '12 Main St, call 631-555-0199 on arrival',
  })] });
  await runScan(h);
  const q = h.queuePosts()[0].body.payload;
  assert.equal(q.telegram_text, null);
  for (const text of [q.aps.alert.title, q.aps.alert.body]) {
    assert.doesNotMatch(text, EMAIL_RE);
    assert.doesNotMatch(text, PHONE_RE);
  }
  const url = h.ordersReads()[0].url;
  assert.ok(!url.includes('client_email') && !url.includes('phone') && !url.includes('delivery_notes'),
    'the read never asks for contact details');
});

// ── 8) markets ─────────────────────────────────────────────────────
test('managers only hear about their own market; owners hear about every market', async () => {
  const h = harness({ rows: [order({ market: 'miami' })] });
  await runScan(h);
  assert.deepEqual([...h.queuePosts()[0].body.payload.tokens].sort(), ['miami-token', 'owner-token']);

  const blank = harness({ rows: [order({ market: null })] });
  await runScan(blank);
  assert.deepEqual(blank.queuePosts()[0].body.payload.tokens, ['owner-token'], 'no market: managers fail closed');
});

// ── 9) malformed requests ──────────────────────────────────────────
test('a confirmed request with no window or no checked_at is skipped without a write', async () => {
  const h = harness({ rows: [
    order({ delivery_request: request({ window: '   ' }) }),
    order({ delivery_request: request({ checked_at: null }) }),
  ] });
  const { counts } = await runScan(h);
  assert.equal(h.queuePosts().length, 0);
  assert.equal(h.stamps().length, 0);
  assert.deepEqual(counts, { seen: 2, pushed: 0, stamped: 0, reedited: 0, skipped: 2, failed: 0 });
  assert.equal(deliveryConfirmationMessage({ id: 'x', delivery_request: null }), null);
  assert.equal(deliveryConfirmationMessage({ id: 'x', delivery_request: ['nope'] }), null);
  assert.equal(deliveryConfirmationMessage(null), null);
});

test('a missing client name still produces a banner', () => {
  assert.equal(deliveryConfirmationMessage(order({ client_name: '' })).body, 'Unnamed · Sep 11 · 2:00 PM');
});

// ── 10) date formatting never shifts the day ───────────────────────
test('formatDeliveryDay turns YYYY-MM-DD into Mon D with no timezone math', () => {
  assert.equal(formatDeliveryDay('2026-09-11'), 'Sep 11');
  assert.equal(formatDeliveryDay('2026-01-01'), 'Jan 1');
  assert.equal(formatDeliveryDay('2026-12-31'), 'Dec 31');
  assert.equal(formatDeliveryDay('2026-12-31T00:00:00+00:00'), 'Dec 31'); // the row's date marker, midnight UTC
  assert.equal(formatDeliveryDay(' 2026-07-04 '), 'Jul 4');
  assert.equal(formatDeliveryDay(''), '');
  assert.equal(formatDeliveryDay(null), '');
  assert.equal(formatDeliveryDay('not a date'), '');
  assert.equal(formatDeliveryDay('2026-13-01'), '');
  assert.equal(formatDeliveryDay('2026-09-00'), '');
  assert.equal(formatDeliveryDay('09/11/2026'), '');
});

test('the request date wins; the row date marker is only the fallback', () => {
  assert.equal(deliveryConfirmationMessage(order({ delivery_request: request({ date: '2026-09-12' }) })).body,
    'Acme Beach Club · Sep 12 · 2:00 PM');
  assert.equal(deliveryConfirmationMessage(order({ delivery_request: request({ date: null }) })).body,
    'Acme Beach Club · Sep 11 · 2:00 PM');
  assert.equal(deliveryConfirmationMessage(order({ delivery_at_utc: null, delivery_request: request({ date: null }) })).body,
    'Acme Beach Club · 2:00 PM');
});

// ── 11) wiring ─────────────────────────────────────────────────────
test('the 5-minute cron runs the scan right after the intake cards', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'worker.js'), 'utf8');
  const branch = src.indexOf("cron === '*/5 * * * *'");
  assert.ok(branch > 0);
  const chain = src.slice(branch, branch + 2500);
  const intakeAt = chain.indexOf('await runIntakeCardScan(env);');
  const confirmAt = chain.indexOf('await runDeliveryConfirmationScan(env);');
  assert.ok(intakeAt >= 0 && confirmAt > intakeAt, 'delivery confirmations must follow the intake cards');
  assert.ok(confirmAt < chain.indexOf('await runLiveActivityStartScan(env);'));
});

// ── run ────────────────────────────────────────────────────────────
let failed = 0;
for (const c of cases) {
  try {
    await c.fn();
    console.log('PASS  ' + c.name);
  } catch (e) {
    failed++;
    console.log('FAIL  ' + c.name);
    console.log('      ' + String((e && e.stack) || e).split('\n').join('\n      '));
  }
}
console.log('');
console.log((cases.length - failed) + ' passed, ' + failed + ' failed, ' + cases.length + ' total');
process.exit(failed ? 1 : 0);

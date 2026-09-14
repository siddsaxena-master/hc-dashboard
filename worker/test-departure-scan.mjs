// Tests for the departure plan's wiring in worker.js: the five-minute
// scan, the market-wide push, and the Apple Maps client, all against a
// fake network. Nothing here can reach Supabase, Apple or a phone.
//
// Run it with:  node worker/test-departure-scan.mjs
//
// The Saturday this exists for: 2026-09-12, order 567ba3a6 (Pridwin Hotel,
// Shelter Island), window "As close to 3:30/4 PM as possible", 3h05m drive
// with a ferry, nobody told to leave. Every case below is a moment of that
// day replayed through the real code.

import assert from 'node:assert/strict';
import {
  runDeparturePlanScan, sendPushToMarket, resolveMarketRecipients, routeProvider, appleMapsJwt,
  appleDirectionsHasFerry, computeRoute, enqueuePush, runDayBeforeDepartureScan, departureCardStatusForMarket,
  departureCardWordsForMarket, runShiftStatusScan,
} from './worker.js';

let passed = 0;
const pass = (m) => { passed++; console.log('PASS: ' + m); };
const SB = 'https://example.invalid';
const ORDER_ID = '567ba3a6-7101-4eeb-bb74-4fd5069724cd';
const GARAGE = { lat: 40.586659, lng: -74.323824 };
const PRIDWIN = { lat: 41.0879, lng: -72.3593 };
const T = (iso) => Date.parse(iso);
const MIN = 60000;

// A throwaway P-256 key so the Apple token path signs for real.
async function fakeAppleKeyPem() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const b64 = Buffer.from(der).toString('base64').replace(/(.{64})/g, '$1\n');
  return '-----BEGIN PRIVATE KEY-----\n' + b64 + '\n-----END PRIVATE KEY-----\n';
}
const APPLE_ENV = { SUPABASE_URL: SB, SUPABASE_SERVICE_KEY: 'not-a-real-key', APPLE_MAPS_KEY_ID: 'ABCDEFGHIJ', APPLE_MAPS_TEAM_ID: 'TEAM123456', APPLE_MAPS_PRIVATE_KEY: await fakeAppleKeyPem() };
const NO_KEY_ENV = { SUPABASE_URL: SB, SUPABASE_SERVICE_KEY: 'not-a-real-key' };

const ROSTER = [
  { email: 'owner@example.invalid', name: 'Sidd', role: 'owner', market: 'ny', active: true },
  { email: 'ny.manager@example.invalid', name: 'Jayden Martin', role: 'manager', market: 'ny', active: true },
  { email: 'miami.manager@example.invalid', name: 'Mia', role: 'manager', market: 'miami', active: true },
  { email: 'crew@example.invalid', name: 'Hashim Nadir', role: 'team', market: 'ny', active: true },
  { email: 'vegas@example.invalid', name: 'Lian Alpuerto', role: 'team', market: 'vegas', active: true },
  { email: 'appreview@hamptonscoconuts.com', name: 'App Review', role: 'team', market: 'ny', active: true },
];
const TOKENS = { 'owner@example.invalid': 'owner-token', 'ny.manager@example.invalid': 'manager-token', 'miami.manager@example.invalid': 'miami-token', 'crew@example.invalid': 'crew-token', 'vegas@example.invalid': 'vegas-token' };

function pridwinOrder(extra = {}) {
  return {
    id: ORDER_ID, client_name: 'Abigail Canelle', venue: 'Pridwin Hotel', delivery_notes: 'Pridwin Hotel, Shelter Island, NY',
    delivery_at_utc: '2026-09-12T00:00:00+00:00', event_start_at: '2026-09-12T00:00:00+00:00', stage: 'paid_full', market: 'ny', coconuts_qty: 100,
    delivery_request: { date: '2026-09-12', window: 'As close to 3:30/4 PM as possible', status: 'confirmed', source: 'email', checked_at: '2026-09-06T19:29:22.762Z' },
    invoice_fulfillment: { read_status: 'complete', address: 'Pridwin Hotel, Shelter Island, NY, US', delivery_date: '2026-09-12' },
    ...extra,
  };
}
const plannedRow = (extra = {}) => ({
  order_id: ORDER_ID, plan_date: '2026-09-12', market: 'ny', state: 'planned', window_text: 'As close to 3:30/4 PM as possible',
  arrive_source: 'delivery_request', arrive_kind: 'range', arrive_at: '2026-09-12T19:30:00+00:00',
  origin_kind: 'garage', origin_lat: GARAGE.lat, origin_lng: GARAGE.lng, origin_label: 'NJ garage',
  dest_source: 'invoice', dest_address: 'Pridwin Hotel, Shelter Island, NY, US', dest_lat: PRIDWIN.lat, dest_lng: PRIDWIN.lng,
  drive_seconds: 11100, static_seconds: 10000, distance_meters: 186700, has_ferry: true, route_source: 'apple_maps', route_error: null,
  buffer_seconds: 3600, ferry_seconds: 1800, leave_by_at: '2026-09-12T14:55:00+00:00', eta_at: null,
  movement: 'nobody', pickup_seen_at: null, pickup_source: null, en_route_shift_id: null,
  silenced_at: null, silenced_by: null, ack_at: null, ack_by: null, ack_name: null,
  alerts: {}, computed_at: '2026-09-12T13:50:00+00:00', next_refresh_at: null, updated_at: '2026-09-12T13:50:00+00:00',
  ...extra,
});
function reply(status, data = null) {
  return { ok: status >= 200 && status < 300, status, async json() { return data; }, async text() { return data == null ? '' : JSON.stringify(data); } };
}
// The fake world. `plans` is the order_departures table (by order id) and
// is mutated by the scan's upserts and PATCHes exactly as PostgREST would.
function harness(opts = {}) {
  const calls = [];
  const plans = new Map((opts.plans || []).map((p) => [p.order_id, { ...p }]));
  const shifts = opts.shifts || [];
  const points = opts.points || {};
  const tokens = opts.tokens || TOKENS;
  const apple = { tokenCalls: 0, geocode: 0, directions: 0, etas: 0 };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (urlValue, options = {}) => {
    const url = String(urlValue);
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, method, body, headers: options.headers || {} });
    const u = new URL(url);
    if (u.origin === 'https://maps-api.apple.com') {
      if (u.pathname === '/v1/token') { apple.tokenCalls++; return reply(200, { accessToken: 'fake-access', expiresInSeconds: 1800 }); }
      // A Las Vegas address lands in Las Vegas; everything else is the Pridwin.
      const vegasQuery = /las vegas/i.test(u.searchParams.get('q') || '');
      const vegasDest = /^36\./.test(u.searchParams.get('destination') || u.searchParams.get('destinations') || '');
      if (u.pathname === '/v1/geocode') { apple.geocode++; return reply(200, { results: [vegasQuery ? { coordinate: { latitude: 36.1265, longitude: -115.1655 } } : { coordinate: { latitude: PRIDWIN.lat, longitude: PRIDWIN.lng } }] }); }
      if (u.pathname === '/v1/directions') {
        apple.directions++;
        if (vegasDest) return reply(200, { routes: [{ name: 'S Las Vegas Blvd', distanceMeters: 4000, durationSeconds: 700 }], steps: [{ instructions: 'Head north' }] });
        return reply(200, { routes: [{ name: 'I-495 E', distanceMeters: 186700, durationSeconds: 10000 }], steps: [{ instructions: 'Merge onto I-495 E' }, { instructions: 'Take the ferry to Shelter Island' }] });
      }
      if (u.pathname === '/v1/etas') {
        apple.etas++;
        if (vegasDest) return reply(200, { etas: [{ destination: { latitude: 36.1265, longitude: -115.1655 }, distanceMeters: 4000, expectedTravelTimeSeconds: 900, staticTravelTimeSeconds: 700, transportType: 'Automobile' }] });
        return reply(200, { etas: [{ destination: { latitude: PRIDWIN.lat, longitude: PRIDWIN.lng }, distanceMeters: 186700, expectedTravelTimeSeconds: 11100, staticTravelTimeSeconds: 10000, transportType: 'Automobile' }] });
      }
      return reply(404, {});
    }
    if (!url.startsWith(SB + '/rest/v1/')) throw new Error('unexpected offline fetch: ' + method + ' ' + url);
    const path = url.slice((SB + '/rest/v1/').length);
    if (method === 'GET' && path.startsWith('orders?')) {
      const m = /market=eq\.([a-z]+)/.exec(path);
      // Honour an id filter too, so the worker's by-id read is really proved.
      const idm = /id=eq\.([^&]+)/.exec(path);
      return reply(200, (opts.orders || [])
        .filter((o) => !m || String(o.market || 'ny') === m[1])
        .filter((o) => !idm || String(o.id) === decodeURIComponent(idm[1])));
    }
    if (method === 'GET' && path.startsWith('order_departures?')) {
      const rows = [...plans.values()];
      const m = /market=eq\.([a-z]+)/.exec(path);
      return reply(200, m ? rows.filter((r) => r.market === m[1]) : rows);
    }
    if (method === 'GET' && path.startsWith('shifts?')) {
      if (path.includes('clock_out_at=is.null')) return reply(200, shifts);
      return reply(200, []);
    }
    if (method === 'GET' && path.startsWith('shift_locations?')) {
      const id = /shift_id=eq\.([^&]+)/.exec(path)[1];
      return reply(200, points[id] || []);
    }
    if (method === 'GET' && path.startsWith('field_workers?')) return reply(200, ROSTER);
    // Live Activity update tokens: `laTokens` rows are { shift_id, email, token }.
    if (method === 'GET' && path.startsWith('live_activity_tokens?')) {
      const id = decodeURIComponent(/shift_id=eq\.([^&]+)/.exec(path)[1]);
      return reply(200, (opts.laTokens || []).filter((r) => r.shift_id === id).map((r) => ({ email: r.email, token: r.token })));
    }
    if (method === 'GET' && path.startsWith('push_tokens?')) {
      const list = decodeURIComponent(path.split('email=in.(')[1].split(')')[0]);
      const wanted = list.split(',').map((s) => s.replace(/"/g, '').trim().toLowerCase());
      return reply(200, wanted.filter((e) => tokens[e]).map((e) => ({ email: e, apns_token: tokens[e] })));
    }
    if (method === 'POST' && path.startsWith('order_departures?on_conflict=order_id')) {
      const merged = { ...(plans.get(body.order_id) || plannedRow({ state: 'pending', alerts: {} })), ...body };
      if (!plans.has(body.order_id)) { merged.alerts = {}; merged.pickup_seen_at = null; merged.pickup_source = null; merged.silenced_at = null; merged.ack_at = null; }
      plans.set(body.order_id, merged);
      return reply(201, [merged]);
    }
    if (method === 'PATCH' && path.startsWith('order_departures?order_id=eq.')) {
      const id = decodeURIComponent(/order_id=eq\.([^&]+)/.exec(path)[1]);
      const row = plans.get(id);
      if (!row) return reply(200, []);
      const guardAlerts = /alerts->>([a-z_0-9]+)=is\.null/.exec(path);
      if (guardAlerts && row.alerts && row.alerts[guardAlerts[1]] !== undefined) return reply(200, []);
      if (path.includes('pickup_seen_at=is.null') && row.pickup_seen_at) return reply(200, []);
      Object.assign(row, body);
      return reply(200, [row]);
    }
    if (method === 'POST' && path === 'push_queue') return reply(201, null);
    if (method === 'GET' && path.startsWith('push_queue?id=eq.')) return reply(200, []);
    throw new Error('unexpected offline fetch: ' + method + ' ' + url);
  };
  return {
    calls, plans, apple,
    queuePosts: () => calls.filter((c) => c.method === 'POST' && c.url === SB + '/rest/v1/push_queue').map((c) => c.body),
    patches: () => calls.filter((c) => c.method === 'PATCH'),
    upserts: () => calls.filter((c) => c.method === 'POST' && c.url.startsWith(SB + '/rest/v1/order_departures')).map((c) => c.body),
    restore: () => { globalThis.fetch = originalFetch; },
  };
}
const realNow = Date.now;
async function at(iso, fn) {
  Date.now = () => T(iso);
  try { return await fn(); } finally { Date.now = realNow; }
}
async function scanAt(iso, env, opts) {
  const h = harness(opts);
  try {
    const counts = await at(iso, () => runDeparturePlanScan(env));
    return { h, counts };
  } finally { h.restore(); }
}
const fresh = (p, nowIso, minAgo) => ({ ...p, at: new Date(T(nowIso) - minAgo * MIN).toISOString() });
const crewShift = { id: 's-crew', worker_name: 'Hashim Nadir', worker_email: 'crew@example.invalid', market: 'ny', clock_in_at: '2026-09-12T16:12:00Z', clock_in_lat: GARAGE.lat + 0.0009, clock_in_lng: GARAGE.lng };

// ── 1. Saturday 9:55 AM: the first plan and the heads-up ────────────
{
  const { h, counts } = await scanAt('2026-09-12T13:55:00Z', APPLE_ENV, { orders: [pridwinOrder()] });
  assert.equal(h.apple.tokenCalls, 1); assert.equal(h.apple.geocode, 1); assert.equal(h.apple.directions, 1); assert.equal(h.apple.etas, 1);
  const up = h.upserts()[0];
  assert.equal(up.state, 'planned');
  assert.equal(up.arrive_at, '2026-09-12T19:30:00.000Z');
  assert.equal(up.leave_by_at, '2026-09-12T14:55:00.000Z');
  assert.equal(up.drive_seconds, 11100); assert.equal(up.has_ferry, true); assert.equal(up.route_source, 'apple_maps');
  assert.equal(up.dest_lat, PRIDWIN.lat); assert.equal(up.origin_label, 'NJ garage'); assert.equal(up.movement, 'nobody');
  for (const k of ['alerts', 'pickup_seen_at', 'pickup_source', 'silenced_at', 'ack_at', 'ack_name']) assert.ok(!(k in up), k + ' must never be in the upsert body');
  const posts = h.queuePosts();
  assert.equal(posts.length, 1);
  const q = posts[0];
  assert.equal(q.payload.aps.alert.title, 'Leave in 1 hour: Canelle / Pridwin');
  assert.equal(q.payload.aps.alert.body, 'Leave NJ garage by 10:55 AM to arrive 3:30 PM. 3h 05m with traffic incl. ferry, +1h buffer, +30m ferry. On shift (NY): nobody clocked in.');
  assert.deepEqual([...q.payload.tokens].sort(), ['crew-token', 'manager-token', 'owner-token']);
  assert.equal(q.payload.headers.collapse_id, 'dep-' + ORDER_ID);
  assert.equal(q.payload.headers.expiration, Math.floor(T('2026-09-12T14:55:00Z') / 1000));
  assert.equal(q.payload.telegram_text, null); assert.deepEqual(q.payload.fallback_chat_ids, []);
  assert.equal(q.payload.body.kind, 'heads_up'); assert.equal(q.payload.body.order_id, ORDER_ID); assert.equal(q.payload.aps['thread-id'], ORDER_ID);
  assert.ok(h.plans.get(ORDER_ID).alerts.heads_up.queue_id === q.id);
  assert.equal(counts.alerts, 1); assert.equal(counts.routeCalls, 1); assert.equal(counts.planned, 1);
  pass('9:55 AM: Apple geocode + directions (ferry seen) + etas once, plan stored, heads-up to owner, manager and every NY crew phone, nothing to Vegas or Miami');
}
// ── 2. No routing key: honest no_route, owner told once ─────────────
{
  const { h, counts } = await scanAt('2026-09-12T13:55:00Z', NO_KEY_ENV, { orders: [pridwinOrder()] });
  assert.equal(h.apple.tokenCalls, 0);
  const up = h.upserts()[0];
  assert.equal(up.state, 'no_route'); assert.equal(up.route_error, 'key missing'); assert.equal(up.leave_by_at, null);
  const q = h.queuePosts()[0];
  assert.equal(q.payload.aps.alert.title, 'Cannot plan departure: Canelle (Sat Sep 12)');
  assert.equal(q.payload.aps.alert.body, 'Apple Maps routing failed (key missing). Leave-by unknown until it works.');
  assert.deepEqual([...q.payload.tokens].sort(), ['manager-token', 'owner-token']);
  assert.equal(h.plans.get(ORDER_ID).alerts.cannot_plan, '2026-09-12');
  assert.equal(counts.noRoute, 1); assert.equal(counts.alerts, 0);
  pass('no key: state no_route, "routing unavailable" to owner and manager only, never a guessed leave-by');
  const again = await scanAt('2026-09-12T14:00:00Z', NO_KEY_ENV, { orders: [pridwinOrder()], plans: [h.plans.get(ORDER_ID)] });
  assert.equal(again.h.queuePosts().length, 0);
  pass('the cannot-plan nag goes once per day, not every tick');
}
// ── 3. No time and AM/PM ambiguity ──────────────────────────────────
{
  const { h } = await scanAt('2026-09-12T13:55:00Z', APPLE_ENV, { orders: [pridwinOrder({ delivery_request: null, invoice_fulfillment: { read_status: 'complete', address: 'Pridwin Hotel, Shelter Island, NY, US' } })] });
  assert.equal(h.upserts()[0].state, 'no_time');
  assert.equal(h.apple.tokenCalls, 0);
  assert.equal(h.queuePosts()[0].payload.aps.alert.body, 'No delivery time on file. Set one in Needs you.');
  const amb = await scanAt('2026-09-12T13:55:00Z', APPLE_ENV, { orders: [pridwinOrder({ delivery_request: { date: '2026-09-12', window: '7', status: 'confirmed', source: 'owner', checked_at: 'x' } })] });
  assert.equal(amb.h.upserts()[0].state, 'needs_ampm');
  assert.equal(amb.h.upserts()[0].arrive_at, '2026-09-12T11:00:00.000Z');
  assert.ok(amb.h.queuePosts()[0].payload.aps.alert.body.includes('has no AM or PM'));
  pass('no clock time and a bare "7" are reported, never routed, never alerted');
}
// ── 4. 11:25 AM, Hashim clocked in at the garage: Late 30 ──────────
{
  const nowIso = '2026-09-12T15:25:00Z';
  const row = plannedRow({ alerts: { heads_up: { at: 'x' }, leave_now: { at: 'x' }, late_10: { at: 'x' } } });
  const { h, counts } = await scanAt(nowIso, APPLE_ENV, { orders: [pridwinOrder()], plans: [row], shifts: [crewShift], points: { 's-crew': [fresh({ lat: GARAGE.lat + 0.0009, lng: GARAGE.lng }, nowIso, 1)] } });
  // Past leave-by the drive time refreshes every five minutes (it was
  // computed 95 minutes ago), but the stored coordinates and the ferry
  // answer are reused: one ETA call, no geocode, no directions.
  assert.equal(h.apple.etas, 1); assert.equal(h.apple.geocode, 0); assert.equal(h.apple.directions, 0);
  const q = h.queuePosts()[0];
  assert.equal(q.payload.aps.alert.title, 'Late 30 min: Canelle / Pridwin');
  assert.equal(q.payload.aps.alert.body, 'Nobody has left the NJ garage. Leaving now arrives 3:00 PM with traffic, needed 3:30 PM. On shift (NY): Hashim Nadir, at the garage since 12:12 PM.');
  assert.deepEqual([...q.payload.tokens].sort(), ['crew-token', 'manager-token', 'owner-token']);
  assert.ok(h.plans.get(ORDER_ID).alerts.late_30);
  assert.equal(h.plans.get(ORDER_ID).movement, 'at_origin');
  assert.equal(counts.alerts, 1);
  pass('late 30: names the clocked-in worker at the garage, goes to the clocked-in crew phone');
}
// ── 5. Departed: pickup seen by GPS, moving away, no more nags ──────
{
  const nowIso = '2026-09-12T16:00:00Z';
  const row = plannedRow({ alerts: { heads_up: {}, leave_now: {}, late_10: {}, late_30: {} }, computed_at: '2026-09-12T15:57:00+00:00' });
  const away = { lat: GARAGE.lat + 0.03, lng: GARAGE.lng + 0.03 };
  const { h } = await scanAt(nowIso, APPLE_ENV, { orders: [pridwinOrder()], plans: [row], shifts: [crewShift], points: { 's-crew': [fresh(away, nowIso, 1), fresh({ lat: GARAGE.lat + 0.002, lng: GARAGE.lng }, nowIso, 30)] } });
  const stored = h.plans.get(ORDER_ID);
  assert.equal(stored.pickup_source, 'gps'); assert.ok(stored.pickup_seen_at);
  assert.equal(stored.movement, 'departed'); assert.equal(stored.en_route_shift_id, 's-crew');
  assert.ok(stored.eta_at, 'an ETA is stored once departed');
  assert.equal(h.queuePosts().length, 0);
  pass('departed: the garage visit is seen in the trail, the departure is stamped, an ETA appears, and no late banner fires');
}
// ── 6. Silenced: stamped, never sent ────────────────────────────────
{
  const nowIso = '2026-09-12T15:25:00Z';
  const row = plannedRow({ silenced_at: '2026-09-12T15:10:00+00:00', alerts: { heads_up: {}, leave_now: {}, late_10: {} } });
  const { h } = await scanAt(nowIso, APPLE_ENV, { orders: [pridwinOrder()], plans: [row] });
  assert.equal(h.queuePosts().length, 0);
  assert.ok(h.plans.get(ORDER_ID).alerts.late_30.silent);
  pass('silenced: late 30 is stamped so un-silencing never replays it, and nothing is sent');
}
// ── 7. Nobody reachable: no claim, a visible stamp ──────────────────
{
  const { h } = await scanAt('2026-09-12T13:55:00Z', APPLE_ENV, { orders: [pridwinOrder()], tokens: {} });
  assert.equal(h.queuePosts().length, 0);
  const stored = h.plans.get(ORDER_ID);
  assert.ok(stored.alerts.no_recipients_at);
  assert.equal(stored.alerts.heads_up, undefined);
  pass('zero phones: the stage is not claimed, no_recipients_at is stamped, and the same stage comes back next tick');
}
// ── 8. A changed arrival time resets the stamps and lifts a silence ─
{
  const row = plannedRow({ silenced_at: '2026-09-12T13:00:00+00:00', alerts: { heads_up: {}, leave_now: {} }, computed_at: '2026-09-12T13:50:00+00:00' });
  const order = pridwinOrder({ delivery_request: { date: '2026-09-12', window: '2:00 PM', status: 'confirmed', source: 'owner', checked_at: '2026-09-12T13:52:00Z' } });
  const { h } = await scanAt('2026-09-12T13:20:00Z', APPLE_ENV, { orders: [order], plans: [row] });
  const stored = h.plans.get(ORDER_ID);
  assert.equal(stored.arrive_at, '2026-09-12T18:00:00.000Z');
  assert.equal(stored.silenced_at, null);
  assert.equal(stored.leave_by_at, '2026-09-12T13:25:00.000Z');
  const q = h.queuePosts()[0];
  // Five minutes to the new leave-by counts as "now" (one tick wide).
  assert.equal(q.payload.aps.alert.title, 'LEAVE NOW: Canelle / Pridwin');
  assert.ok(q.payload.aps.alert.body.endsWith('Alerts un-silenced: the time changed.'));
  pass('a new time (Accept or owner edit): stamps reset, silence lifted, the next banner says so');
}
// ── 9. Vegas: the crew there, not the NY crew ───────────────────────
{
  const lian = { id: 's-lian', worker_name: 'Lian Alpuerto', worker_email: 'vegas@example.invalid', market: 'vegas', clock_in_at: '2026-09-12T16:00:00Z', clock_in_lat: 36.11, clock_in_lng: -115.17 };
  const order = pridwinOrder({ id: 'v1', client_name: 'Dana Ruiz', venue: 'Wynn', delivery_notes: 'Wynn Las Vegas, Las Vegas, NV', market: 'vegas', invoice_fulfillment: null, delivery_request: { date: '2026-09-12', window: '2 PM', status: 'confirmed', source: 'owner', checked_at: 'x' } });
  const { h } = await scanAt('2026-09-12T19:30:00Z', APPLE_ENV, { orders: [order], shifts: [lian], points: { 's-lian': [fresh({ lat: 36.11, lng: -115.17 }, '2026-09-12T19:30:00Z', 1)] } });
  const up = h.upserts()[0];
  assert.equal(up.origin_kind, 'clock_in'); assert.equal(up.origin_label, 'where Lian clocked in');
  assert.equal(up.arrive_at, '2026-09-12T21:00:00.000Z');
  const q = h.queuePosts()[0];
  assert.ok(q, 'a banner was queued');
  assert.deepEqual([...q.payload.tokens].sort(), ['owner-token', 'vegas-token']);
  assert.ok(q.payload.aps.alert.body.includes('PT'));
  pass('Vegas: starts where Lian clocked in, times print in Pacific, only Lian and the owner are addressed');
}
// ── 10. sendPushToMarket recipients and the payload shape ───────────
{
  const h = harness({ shifts: [] });
  try {
    const r = await resolveMarketRecipients(APPLE_ENV, 'ny', { recipients: 'all' });
    assert.deepEqual(r.people.map((p) => p.email), ['owner@example.invalid', 'ny.manager@example.invalid', 'crew@example.invalid']);
    const shiftReads = () => h.calls.filter((c) => c.url.includes('/rest/v1/shifts?')).length;
    const before = shiftReads();
    const manage = await resolveMarketRecipients(APPLE_ENV, 'ny', { recipients: 'manage' });
    assert.deepEqual(manage.people.map((p) => p.email), ['owner@example.invalid', 'ny.manager@example.invalid']);
    assert.equal(shiftReads(), before, 'recipients "manage" never reads shifts');
    const sent = await sendPushToMarket(APPLE_ENV, 'ny', 'T', 'B', { queueId: '11111111-1111-5111-8111-111111111111', collapseId: 'dep-x', teamBody: 'crew words', kind: 'late', orderId: 'x', day: '2026-09-12', expiration: 123 });
    assert.equal(sent.queued, true);
    const posts = h.queuePosts();
    assert.equal(posts.length, 2);
    const crewRow = posts.find((p) => p.payload.aps.alert.body === 'crew words');
    assert.deepEqual(crewRow.payload.tokens, ['crew-token']);
    assert.notEqual(crewRow.id, '11111111-1111-5111-8111-111111111111');
    for (const p of posts) { assert.equal(p.payload.telegram_text, null); assert.deepEqual(p.payload.fallback_chat_ids, []); assert.equal(p.payload.headers.collapse_id, 'dep-x'); assert.equal(p.payload.headers.expiration, 123); assert.equal(p.payload.body.kind, 'late'); }
  } finally { h.restore(); }
  pass('sendPushToMarket: owners, same-market manager, crew; manage never reads shifts; a different crew body makes a second row with a derived id');
}
// ── 11. enqueuePush keeps a caller collapse id and trims a huge body ─
{
  const h = harness({});
  try {
    await enqueuePush(APPLE_ENV, 'alert', { tokens: ['t'], headers: { topic: 'x' }, aps: { alert: { title: 'T', body: 'x'.repeat(6000) } }, body: { v: 1 } }, '22222222-2222-5222-8222-222222222222');
    const row = h.queuePosts()[0];
    assert.equal(row.payload.headers.collapse_id, '22222222-2222-5222-8222-222222222222');
    assert.ok(new TextEncoder().encode(JSON.stringify({ aps: row.payload.aps, body: row.payload.body })).length <= 3800);
    await enqueuePush(APPLE_ENV, 'alert', { tokens: ['t'], headers: { topic: 'x', collapse_id: 'dep-y' }, aps: { alert: { title: 'T', body: 'short' } } }, null);
    assert.equal(h.queuePosts()[1].payload.headers.collapse_id, 'dep-y');
  } finally { h.restore(); }
  pass('enqueuePush: the queue id stays the collapse id by default, a caller id is kept, a 6,000-character body is trimmed under 3,800 bytes');
}
// ── 12. The day-before message at 6 PM Eastern ──────────────────────
{
  const h = harness({ orders: [pridwinOrder()], plans: [plannedRow()], shifts: [] });
  try {
    const counts = await at('2026-09-11T22:10:00Z', () => runDayBeforeDepartureScan(APPLE_ENV));
    assert.equal(counts.sent, 1);
    const posts = h.queuePosts();
    const manage = posts.find((p) => p.payload.tokens.includes('owner-token'));
    assert.equal(manage.payload.aps.alert.title, 'Tomorrow Sat Sep 12 (NY): 1 job');
    assert.ok(manage.payload.aps.alert.body.startsWith('• Abigail Canelle · Pridwin Hotel, Shelter Island, NY, US · arrive 3:30 PM (window "As close to 3:30/4 PM as possible") · leave NJ garage by 10:55 AM (3h 05m predicted traffic incl. ferry, +1h buffer, +30m ferry) · 100 coconuts: brand and box them TODAY (Fri)'));
    const crew = posts.find((p) => p.payload.tokens.includes('crew-token') && !p.payload.tokens.includes('owner-token'));
    assert.ok(crew, 'the crew get their own body');
    assert.ok(!crew.payload.aps.alert.body.includes('(window'));
  } finally { h.restore(); }
  const quiet = harness({ orders: [pridwinOrder()], plans: [plannedRow()] });
  try {
    const counts = await at('2026-09-11T20:10:00Z', () => runDayBeforeDepartureScan(APPLE_ENV));
    assert.equal(counts.sent, 0); assert.equal(quiet.queuePosts().length, 0);
  } finally { quiet.restore(); }
  pass('day-before: at 6 PM Eastern one manage body and one crew body; at 4 PM nothing');
}
// ── 13. The lock-screen card comes from the plan ────────────────────
{
  const h = harness({ plans: [plannedRow()], orders: [pridwinOrder()] });
  try {
    assert.deepEqual(await at('2026-09-12T13:00:00Z', () => departureCardStatusForMarket(APPLE_ENV, 'ny', T('2026-09-12T13:00:00Z'))), {
      status: 'Leave by 10:55a', stage: 'garage', headline: 'Leave by 10:55 AM', jobTag: 'Canelle / Pridwin',
      leaveByISO: '2026-09-12T14:55:00.000Z', etaISO: null, lateMinutes: null,
    });
    assert.deepEqual(await at('2026-09-12T15:25:00Z', () => departureCardStatusForMarket(APPLE_ENV, 'ny', T('2026-09-12T15:25:00Z'))), {
      status: 'Late 30m · Pridwin', stage: 'garage', headline: 'Late 30m', jobTag: 'Canelle / Pridwin',
      leaveByISO: '2026-09-12T14:55:00.000Z', etaISO: null, lateMinutes: 30,
    });
    assert.equal(await departureCardStatusForMarket(APPLE_ENV, 'vegas', T('2026-09-12T13:00:00Z')), null);
    // The string path for callers that only want the words.
    assert.equal(await at('2026-09-12T13:00:00Z', () => departureCardWordsForMarket(APPLE_ENV, 'ny', T('2026-09-12T13:00:00Z'))), 'Leave by 10:55a');
    assert.equal(await at('2026-09-12T15:25:00Z', () => departureCardWordsForMarket(APPLE_ENV, 'ny', T('2026-09-12T15:25:00Z'))), 'Late 30m · Pridwin');
    assert.equal(await departureCardWordsForMarket(APPLE_ENV, 'vegas', T('2026-09-12T13:00:00Z')), null);
  } finally { h.restore(); }
  // No order row (read failed or gone): the card still goes out with the venue word alone.
  const bare = harness({ plans: [plannedRow()] });
  try {
    const card = await at('2026-09-12T13:00:00Z', () => departureCardStatusForMarket(APPLE_ENV, 'ny', T('2026-09-12T13:00:00Z')));
    assert.equal(card.status, 'Leave by 10:55a'); assert.equal(card.jobTag, 'Pridwin');
  } finally { bare.restore(); }
  // A plan with no leave-by and nobody moving has nothing to say yet.
  const quiet = harness({ plans: [plannedRow({ leave_by_at: null })], orders: [pridwinOrder()] });
  try {
    assert.equal(await at('2026-09-12T13:00:00Z', () => departureCardStatusForMarket(APPLE_ENV, 'ny', T('2026-09-12T13:00:00Z'))), null);
  } finally { quiet.restore(); }
  pass('card: the structured card before and after leave-by, the words path, venue-only tag without the order, null with no plan or no leave-by');
}
// ── 13b. The shift scan sends the card in content-state; Stopped wins ─
{
  const laShift = (id) => ({ id, worker_name: 'Hashim Nadir', worker_email: 'crew@example.invalid', market: 'ny', clock_in_at: '2026-09-12T12:30:00Z', clock_in_lat: GARAGE.lat + 0.0009, clock_in_lng: GARAGE.lng });
  const laTokens = (id) => [{ shift_id: id, email: 'owner@example.invalid', token: 'la-owner-' + id }];
  const contentStates = (h) => h.queuePosts().filter((p) => p.kind === 'la_update').map((p) => ({ tokens: p.payload.tokens, state: p.payload.aps['content-state'], event: p.payload.aps.event }));
  // At the garage at 9:00 AM with a plan: the words every build renders plus the six new keys.
  const atGarage = harness({ plans: [plannedRow()], orders: [pridwinOrder()], shifts: [laShift('la-1')], points: { 'la-1': [fresh(GARAGE, '2026-09-12T13:00:00Z', 2)] }, laTokens: laTokens('la-1') });
  try {
    await at('2026-09-12T13:00:00Z', () => runShiftStatusScan(APPLE_ENV));
    const sent = contentStates(atGarage);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].event, 'update');
    assert.deepEqual(sent[0].tokens, ['la-owner-la-1']);
    assert.deepEqual(sent[0].state, {
      status: 'Leave by 10:55a', statusMinutes: 0, lastReportISO: '2026-09-12T12:58:00.000Z', marketLabel: 'NJ',
      stage: 'garage', headline: 'Leave by 10:55 AM', jobTag: 'Canelle / Pridwin', leaveByISO: '2026-09-12T14:55:00.000Z',
    });
    // The same tick again changes nothing the phone would see: no second update.
    await at('2026-09-12T13:00:00Z', () => runShiftStatusScan(APPLE_ENV));
    assert.equal(contentStates(atGarage).length, 1);
    // One more late minute is something the phone would see: it goes out.
    atGarage.plans.get(ORDER_ID).leave_by_at = '2026-09-12T12:30:00+00:00';
    await at('2026-09-12T13:00:00Z', () => runShiftStatusScan(APPLE_ENV));
    const late = contentStates(atGarage);
    assert.equal(late.length, 2);
    assert.equal(late[1].state.status, 'Late 30m · Pridwin'); assert.equal(late[1].state.headline, 'Late 30m'); assert.equal(late[1].state.lateMinutes, 30);
  } finally { atGarage.restore(); }
  // A GPS stamp 30 minutes old away from the garage: "Stopped 30m" and none of the plan's keys.
  const stopped = harness({ plans: [plannedRow()], orders: [pridwinOrder()], shifts: [laShift('la-2')], points: { 'la-2': [fresh({ lat: 40.7555, lng: -74.1059 }, '2026-09-12T13:00:00Z', 30)] }, laTokens: laTokens('la-2') });
  try {
    await at('2026-09-12T13:00:00Z', () => runShiftStatusScan(APPLE_ENV));
    const sent = contentStates(stopped);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].state, { status: 'Stopped', statusMinutes: 30, lastReportISO: '2026-09-12T12:30:00.000Z', marketLabel: 'NJ' });
    // The plan was never even read for a stopped shift.
    assert.ok(!stopped.calls.some((c) => c.url.includes('order_departures?')));
  } finally { stopped.restore(); }
  pass('shift scan: content-state carries the card (stage, headline, jobTag, leaveByISO), dedupes on it, resends on a new late count; Stopped keeps precedence and skips the plan');
}
// ── 14. The router facade and the Apple token ───────────────────────
{
  assert.equal(routeProvider(APPLE_ENV), 'apple_maps'); assert.equal(routeProvider({ GOOGLE_ROUTES_API_KEY: 'k' }), 'google_routes'); assert.equal(routeProvider({}), 'none');
  const jwt = await appleMapsJwt(APPLE_ENV, T('2026-09-12T13:00:00Z'));
  const [head, claims] = jwt.split('.').slice(0, 2).map((p) => JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()));
  assert.deepEqual(head, { alg: 'ES256', kid: 'ABCDEFGHIJ', typ: 'JWT' });
  assert.equal(claims.iss, 'TEAM123456'); assert.equal(claims.exp - claims.iat, 1800);
  assert.equal(appleDirectionsHasFerry({ steps: [{ instructions: 'Board the North Ferry' }] }), true);
  assert.equal(appleDirectionsHasFerry({ steps: [{ instructions: 'Turn left' }], routes: [{ name: 'I-495' }] }), false);
  const noKey = await computeRoute({}, { originLat: 1, originLng: 1, destAddress: 'x' });
  assert.deepEqual(noKey, { ok: false, provider: 'none', error: 'key missing' });
  pass('router: Apple first, Google fallback, honest "key missing"; the Apple token is a 30-minute ES256 JWT');
}

console.log(`\nPASS: ${passed} departure scan checks. No network, no database, no phone.`);

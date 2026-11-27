// Tests for the crew plan's one change to the departure plan (migration
// 073, design 6.2): with CREW_PLAN_MODE on, an approved deliver trip gives
// the leave-by its destination (the plan's to_address) and, from a cold
// storage with confirmed coordinates, its start place ("Leave Cold storage B
// by ..."). With the switch unset or in practice the scan must behave
// exactly as before: NJ garage start, invoice address first, and not one
// extra request. Fake network only: nothing can reach Supabase, Apple or a
// phone.
//
// Run it with:  node worker/test-departure-site-origin.mjs
//
// The DEPART cases come from the shared contract
// worker/test-vectors/crew-plan-cases.json (pinned by sha256).

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runDeparturePlanScan, movementState, pickupSeenByGps, originFor, classifyShiftLocationReport } from './worker.js';

let passed = 0;
const pass = (m) => { passed++; console.log('PASS: ' + m); };
const SB = 'https://example.invalid';
const ENV = { SUPABASE_URL: SB, SUPABASE_SERVICE_KEY: 'not-a-real-key' };
const GARAGE = { lat: 40.586659, lng: -74.323824 };
const COLD = { lat: 40.3, lng: -73.9 };
const W1 = '73d00000-0000-4000-8000-000000000001';

const raw = readFileSync(new URL('./test-vectors/crew-plan-cases.json', import.meta.url));
assert.equal(createHash('sha256').update(raw).digest('hex'), '072030b2dfd165823149a0e0afd1523caf326323812896b68d987608e7745af1');
const V = JSON.parse(raw.toString('utf8'));
const caseById = (id) => V.cases.find((c) => c.id === id);
const departCases = V.cases.filter((c) => c.rule === 'DEPART' && c.packages.includes('worker'));
assert.equal(departCases.length, 6);
pass('vectors file is the pinned copy; 6 DEPART cases for the worker');

const reply = (status, data) => ({ ok: status >= 200 && status < 300, status, async json() { return data; }, async text() { return data == null ? '' : JSON.stringify(data); } });
async function fakeAppleKeyPem() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  return '-----BEGIN PRIVATE KEY-----\n' + Buffer.from(der).toString('base64').replace(/(.{64})/g, '$1\n') + '\n-----END PRIVATE KEY-----\n';
}
const realNow = Date.now;
async function at(iso, fn) { Date.now = () => Date.parse(iso); try { return await fn(); } finally { Date.now = realNow; } }
const ORDER_DEFAULTS = { venue: null, delivery_notes: null, delivery_request: null, invoice_fulfillment: null, coconuts_qty: null };
const ROSTER = [
  { email: 'oli@example.test', name: 'Oli', role: 'owner', market: 'ny', active: true },
  { email: 'ana@example.test', name: 'Ana', role: 'manager', market: 'ny', active: true },
  { email: 'ben@example.test', name: 'Ben', role: 'team', market: 'ny', active: true },
];
const TOKENS = { 'oli@example.test': 'tok-oli', 'ana@example.test': 'tok-ana', 'ben@example.test': 'tok-ben' };

// The fake world for runDeparturePlanScan. originsReply answers
// hc_crew_departure_origins; refuseSite makes the order_departures upsert
// refuse origin_kind 'site' (073's widened check missing).
function world(opts = {}) {
  const calls = [];
  const plans = new Map((opts.plans || []).map((p) => [p.order_id, { ...p }]));
  const original = globalThis.fetch;
  globalThis.fetch = async (urlValue, options = {}) => {
    const url = String(urlValue);
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, method, body });
    if (opts.apple && url.startsWith('https://maps-api.apple.com/')) {
      // A fake Apple Maps: 20 minutes from the cold storage, 45 from the NJ
      // garage, to one spot in Manhattan.
      const u = new URL(url);
      if (u.pathname === '/v1/token') return reply(200, { accessToken: 'fake-access', expiresInSeconds: 1800 });
      if (u.pathname === '/v1/geocode') return reply(200, { results: [{ coordinate: { latitude: 40.75, longitude: -73.99 } }] });
      const [olat] = String(u.searchParams.get('origin')).split(',').map(Number);
      const secs = Math.abs(olat - COLD.lat) < 1e-6 ? 1200 : 2700;
      const meters = Math.abs(olat - COLD.lat) < 1e-6 ? 65000 : 45000;
      if (u.pathname === '/v1/directions') return reply(200, { routes: [{ name: 'Test Rd', distanceMeters: meters, durationSeconds: secs }], steps: [{ instructions: 'Head north' }] });
      if (u.pathname === '/v1/etas') return reply(200, { etas: [{ expectedTravelTimeSeconds: secs, staticTravelTimeSeconds: secs, distanceMeters: meters }] });
      return reply(404, {});
    }
    if (!url.startsWith(SB + '/rest/v1/')) throw new Error('unexpected offline fetch: ' + method + ' ' + url);
    const path = url.slice((SB + '/rest/v1/').length);
    if (method === 'POST' && path === 'rpc/hc_crew_departure_origins') {
      if (opts.originsStatus) return reply(opts.originsStatus, { code: 'PGRST202' });
      return reply(200, opts.originsReply || { v: 1, code: 'off', trips: [], message: null });
    }
    if (method === 'GET' && path.startsWith('orders?')) return reply(200, (opts.orders || []).map((o) => ({ ...ORDER_DEFAULTS, ...o })));
    if (method === 'GET' && path.startsWith('order_departures?')) return reply(200, [...plans.values()]);
    if (method === 'GET' && path.startsWith('order_time_proposals?')) return reply(200, []);
    if (method === 'GET' && path.startsWith('shifts?')) return reply(200, path.includes('clock_out_at=is.null') ? (opts.shifts || []) : []);
    if (method === 'GET' && path.startsWith('shift_locations?')) {
      const id = decodeURIComponent(/shift_id=eq\.([^&]+)/.exec(path)[1]);
      return reply(200, (opts.points || {})[id] || []);
    }
    if (method === 'GET' && path.startsWith('field_workers?')) return reply(200, ROSTER);
    if (method === 'GET' && path.startsWith('push_tokens?')) {
      const list = decodeURIComponent(path.split('email=in.(')[1].split(')')[0]).split(',').map((s) => s.replace(/"/g, '').trim());
      return reply(200, list.filter((e) => TOKENS[e]).map((e) => ({ email: e, apns_token: TOKENS[e] })));
    }
    if (method === 'POST' && path.startsWith('order_departures?on_conflict=order_id')) {
      if (opts.refuseSite && body.origin_kind === 'site') return reply(400, { code: '23514', message: 'order_departures_origin_kind_check' });
      const merged = { alerts: {}, pickup_seen_at: null, pickup_source: null, silenced_at: null, ack_at: null, ...(plans.get(body.order_id) || {}), ...body };
      plans.set(body.order_id, merged);
      return reply(201, [merged]);
    }
    if (method === 'PATCH' && path.startsWith('order_departures?order_id=eq.')) {
      const id = decodeURIComponent(/order_id=eq\.([^&]+)/.exec(path)[1]);
      const row = plans.get(id);
      if (!row) return reply(200, []);
      if (path.includes('pickup_seen_at=is.null') && row.pickup_seen_at) return reply(200, []);
      const guard = /alerts->>([a-z_0-9]+)=is\.null/.exec(path);
      if (guard && row.alerts && row.alerts[guard[1]] !== undefined) return reply(200, []);
      Object.assign(row, body);
      return reply(200, [row]);
    }
    if (method === 'POST' && path === 'push_queue') return reply(201, null);
    if (method === 'GET' && path.startsWith('push_queue?id=eq.')) return reply(200, []);
    throw new Error('unexpected offline fetch: ' + method + ' ' + url);
  };
  return {
    calls, plans,
    upserts: () => calls.filter((c) => c.method === 'POST' && c.url.includes('/order_departures?on_conflict')).map((c) => c.body),
    originCalls: () => calls.filter((c) => c.url.endsWith('/rpc/hc_crew_departure_origins')).length,
    restore: () => { globalThis.fetch = original; },
  };
}
async function depScan(env, opts, nowIso = '2026-11-29T23:30:00Z') {
  const w = world(opts);
  try { const counts = await at(nowIso, () => runDeparturePlanScan(env)); return { w, counts }; } finally { w.restore(); }
}
const modeEnv = (mode) => (mode ? { ...ENV, CREW_PLAN_MODE: mode } : { ...ENV });
const orderOf = (c) => c.input.rows.orders.find((o) => o.id === W1);
const lastUpsert = (w) => w.upserts().filter((u) => u.order_id === W1).slice(-1)[0];

// -- DEPART-01: unset or practice is exactly today -------------------
{
  const c = caseById('DEPART-01');
  for (const [mode, want] of [[c.input.worker_mode, { departure: c.expected.departure, calls: c.expected.calls_crew_origins }], [c.input.then[0].worker_mode, { departure: c.expected.then[0].departure, calls: c.expected.then[0].calls_crew_origins }]]) {
    const { w } = await depScan(modeEnv(mode), { orders: [orderOf(c)] });
    const up = lastUpsert(w);
    for (const [k, v] of Object.entries(want.departure)) assert.equal(up[k], v, 'DEPART-01 mode ' + mode + ': ' + k);
    assert.equal(w.originCalls() > 0, want.calls, 'DEPART-01 mode ' + mode + ': hc_crew_departure_origins is never called');
    assert.equal(up.origin_lat, GARAGE.lat); assert.equal(up.origin_lng, GARAGE.lng);
  }
  pass('DEPART-01: CREW_PLAN_MODE unset and practice: NJ garage, the invoice address wins, hc_crew_departure_origins is never called');
}
// -- DEPART-02 to 04: mode on ----------------------------------------
for (const id of ['DEPART-02', 'DEPART-03', 'DEPART-04', 'DEPART-07']) {
  const c = caseById(id);
  const { w } = await depScan(modeEnv('on'), { orders: [orderOf(c)], originsReply: c.input.crew_origins_reply });
  const up = lastUpsert(w);
  for (const [k, v] of Object.entries(c.expected.departure)) assert.equal(up[k], v, id + ': ' + k);
  if (c.expected.calls_crew_origins !== undefined) assert.equal(w.originCalls() > 0, c.expected.calls_crew_origins);
  assert.equal(w.originCalls(), 1, id + ': ONE origins read per tick');
  if (up.origin_kind === 'garage') { assert.equal(up.origin_lat, GARAGE.lat); assert.equal(up.origin_label, 'NJ garage'); }
  pass(id + ': ' + c.about.slice(0, 110));
}
{
  // A held trip is not returned by the database; the order then plans as today.
  const c = caseById('DEPART-02');
  const { w } = await depScan(modeEnv('on'), { orders: [orderOf(c)], originsReply: { v: 1, code: 'ok', trips: [], message: null } });
  const up = lastUpsert(w);
  assert.equal(up.origin_kind, 'garage'); assert.equal(up.dest_source, 'invoice');
  const failed = await depScan(modeEnv('on'), { orders: [orderOf(c)], originsStatus: 404 });
  const up2 = lastUpsert(failed.w);
  assert.equal(up2.origin_kind, 'garage'); assert.equal(up2.dest_source, 'invoice');
  assert.equal(failed.w.upserts().length, 1, 'before 073 (404) the scan still plans the order');
  pass('mode on with no trip (held, or 073 not live and the read answers 404): the order plans exactly as today');
}
{
  // The 073 origin word missing: the site start is refused, the job keeps its alarm from the garage.
  const c = caseById('DEPART-02');
  const { w, counts } = await depScan(modeEnv('on'), { orders: [orderOf(c)], originsReply: c.input.crew_origins_reply, refuseSite: true });
  const ups = w.upserts();
  assert.equal(ups.length, 2);
  assert.equal(ups[0].origin_kind, 'site');
  assert.equal(ups[1].origin_kind, 'garage'); assert.equal(ups[1].origin_label, 'NJ garage');
  assert.equal(w.plans.get(W1).origin_kind, 'garage');
  assert.equal(counts.failed, 0);
  pass('a refused cold storage start (the origin check without "site") never costs the job its alarm: saved from the garage instead');
}
{
  // C-8: the garage fallback carries a GARAGE drive time and leave-by,
  // never the cold storage's numbers under the garage's name. With the
  // router: the site route (20 min) is refused, the garage is routed (45
  // min) and the leave-by follows it. With a stored garage route for the
  // same address: that route is reused, no extra call.
  const c = caseById('DEPART-02');
  const APPLE_ENV = { ...modeEnv('on'), APPLE_MAPS_KEY_ID: 'ABCDEFGHIJ', APPLE_MAPS_TEAM_ID: 'TEAM123456', APPLE_MAPS_PRIVATE_KEY: await fakeAppleKeyPem() };
  const { w } = await depScan(APPLE_ENV, { orders: [orderOf(c)], originsReply: c.input.crew_origins_reply, refuseSite: true, apple: true });
  const ups = w.upserts();
  assert.equal(ups.length, 2);
  assert.deepEqual([ups[0].origin_kind, ups[0].drive_seconds], ['site', 1200]);
  assert.deepEqual([ups[1].origin_kind, ups[1].drive_seconds], ['garage', 2700], 'the fallback is routed from the garage');
  // 7:00 AM ET on Mon Nov 30 is 12:00 UTC; minus 60 min buffer and 45 min drive.
  assert.equal(ups[1].leave_by_at, '2026-11-30T10:15:00.000Z', "the leave-by is the garage's");
  const stored = { order_id: W1, plan_date: '2026-11-30', market: 'ny', state: 'planned', window_text: '7:00 AM', arrive_source: 'delivery_request', arrive_kind: 'exact',
    arrive_at: '2026-11-30T12:00:00.000Z', origin_kind: 'garage', origin_lat: GARAGE.lat, origin_lng: GARAGE.lng, origin_label: 'NJ garage', dest_source: 'crew_plan',
    dest_address: c.input.crew_origins_reply.trips[0].to_address, dest_lat: 40.75, dest_lng: -73.99, drive_seconds: 2700, has_ferry: false, route_source: 'apple_maps',
    leave_by_at: '2026-11-30T10:15:00.000Z', computed_at: '2026-11-29T22:00:00Z', alerts: {}, movement: 'nobody' };
  const again = await depScan(modeEnv('on'), { orders: [orderOf(c)], originsReply: c.input.crew_origins_reply, refuseSite: true, plans: [stored] });
  const last = again.w.upserts().slice(-1)[0];
  assert.deepEqual([last.origin_kind, last.drive_seconds, last.leave_by_at], ['garage', 2700, '2026-11-30T10:15:00.000Z'], 'a stored garage route for the same address is carried');
  pass('C-8: a refused cold storage start is saved from the garage with the garage drive time and leave-by (routed now, or the stored garage route carried), never the cold storage numbers');
}
{
  // C-S2: an approved trip address the router may not be given ("Test
  // Pier", or "Test Pier, New York": no state, zip or known town) never
  // replaces today's complete invoice address: the alarm keeps working.
  const c = caseById('DEPART-03');
  for (const [to, source] of [['Test Pier', 'invoice'], ['Test Pier, New York', 'invoice'], ['Test Pier, 1 Test Pier, New York, NY 10011', 'crew_plan']]) {
    const reply2 = { v: 1, code: 'ok', trips: [{ ...c.input.crew_origins_reply.trips[0], to_address: to }] };
    const { w } = await depScan(modeEnv('on'), { orders: [orderOf(c)], originsReply: reply2 });
    const up = lastUpsert(w);
    assert.equal(up.dest_source, source, to + ': dest_source');
    assert.notEqual(up.state, 'no_address', to + ': the job keeps an address it can alarm from');
    if (source === 'invoice') assert.equal(up.dest_address, 'Test Hall, 9 Test Ave, New York, NY 10001');
  }
  pass('C-S2: with CREW_PLAN_MODE on, an approved trip to "Test Pier" (not routable) keeps the complete invoice address; a complete trip address still wins');
}
// -- DEPART-05: the site as base for movement and the GPS pickup stamp -
{
  const c = caseById('DEPART-05');
  const { base, points, now } = c.input;
  const nowMs = Date.parse(now);
  const newest = points[points.length - 1];
  const args = { marketHasGarage: true, origin: { lat: base.lat, lng: base.lng }, dest: null, clockInPoint: null, newestPoint: newest, recentPoints: points, nowMs, pickupSeenAt: null, pickupSource: null, hasOpenShift: true };
  assert.equal(movementState({ ...args, base }), c.expected.movement_with_base);
  assert.equal(pickupSeenByGps(points, base), c.expected.pickup_seen_with_base);
  // Without a base the function is the old one, byte for byte in behavior:
  // the old body (worker.js at bad6b1b) is pinned here and compared on a grid.
  const oldMovement = (a) => {
    const d = (x, y) => distM(x, y);
    if (a.hasOpenShift === false || (!a.clockInPoint && !a.newestPoint)) return 'nobody';
    if (!classifyShiftLocationReport(a.newestPoint, a.nowMs).fresh) return 'unknown';
    if (a.dest && Number.isFinite(a.dest.lat) && d(a.newestPoint, a.dest) <= 300) return 'arrived';
    if (a.marketHasGarage) {
      const claimed = a.pickupSource === 'claim';
      const pickupSeen = !!a.pickupSeenAt || claimed || pickupSeenByGps(a.recentPoints, GARAGE);
      const fromGarage = d(a.newestPoint, GARAGE);
      if (fromGarage <= 150) return 'at_origin';
      if (pickupSeen && fromGarage > 400) return 'departed';
      if (claimed && a.clockInPoint && d(a.newestPoint, a.clockInPoint) > 2000) return 'departed';
      if (!pickupSeen && a.clockInPoint && Number.isFinite(a.clockInPoint.lat) && d(a.newestPoint, a.clockInPoint) > 2000) return 'moving_no_pickup';
      return 'at_origin';
    }
    return 'other';
  };
  let compared = 0;
  const spots = [GARAGE, { lat: GARAGE.lat + 0.001, lng: GARAGE.lng }, { lat: GARAGE.lat + 0.004, lng: GARAGE.lng }, COLD, { lat: 40.75, lng: -73.99 }];
  for (const p of spots) for (const ci of [null, GARAGE, COLD]) for (const seen of [null, '2026-11-30T10:00:00Z']) for (const src of [null, 'gps', 'claim']) for (const trail of [[], [{ ...GARAGE, at: '2026-11-30T10:30:00Z' }]]) {
    const a = { marketHasGarage: true, origin: GARAGE, dest: null, clockInPoint: ci, newestPoint: { ...p, at: '2026-11-30T10:45:00Z' }, recentPoints: trail, nowMs, pickupSeenAt: seen, pickupSource: src, hasOpenShift: true };
    const got = movementState(a);
    const want = oldMovement(a);
    { assert.equal(got, want, 'no base: same answer as before for ' + JSON.stringify({ p, ci, seen, src, trail: trail.length })); compared++; }
    assert.equal(movementState({ ...a, base: undefined }), got);
    assert.equal(movementState({ ...a, base: null }), got);
  }
  assert.ok(compared >= 100);
  assert.equal(c.expected.movement_without_base_unchanged, true);
  const g = originFor({ market: 'ny', openShifts: [], lastShift: null });
  assert.deepEqual(g, { kind: 'garage', lat: GARAGE.lat, lng: GARAGE.lng, label: 'NJ garage', shiftId: null });
  assert.deepEqual(originFor({ market: 'ny', openShifts: [], lastShift: null, site: null }), g);
  assert.deepEqual(originFor({ market: 'ny', openShifts: [], lastShift: null, site: { lat: 40.3, lng: -73.9, label: 'Cold storage B' } }), { kind: 'site', lat: 40.3, lng: -73.9, label: 'Cold storage B', shiftId: null });
  pass('DEPART-05: parked inside Cold storage B\'s fence reads at_origin and stamps the GPS pickup; with no base movementState and originFor answer exactly as before (' + compared + ' grid points)');
}
{
  // The scan with a site start: Ana clocks in at the NJ garage, drives to
  // the cold storage and parks there. With the site as base she reads
  // at_origin and the GPS pickup is stamped there; today the same phone
  // reads "moving with no boxes" and the pickup is never stamped.
  const c = caseById('DEPART-02');
  const shift = { id: 's-ana', worker_name: 'Ana', worker_email: 'ana@example.test', market: 'ny', clock_in_at: '2026-11-30T10:00:00Z', clock_in_lat: GARAGE.lat, clock_in_lng: GARAGE.lng };
  const pts = { 's-ana': [{ lat: COLD.lat + 0.0004, lng: COLD.lng, at: '2026-11-30T10:44:00Z' }, { lat: COLD.lat + 0.0003, lng: COLD.lng + 0.0001, at: '2026-11-30T10:40:00Z' }] };
  const { w } = await depScan(modeEnv('on'), { orders: [orderOf(c)], originsReply: c.input.crew_origins_reply, shifts: [shift], points: pts }, '2026-11-30T10:46:00Z');
  const up = lastUpsert(w);
  assert.equal(up.origin_kind, 'site'); assert.equal(up.movement, 'at_origin');
  const stamp = w.calls.find((x) => x.method === 'PATCH' && x.url.includes('pickup_seen_at=is.null'));
  assert.ok(stamp && stamp.body.pickup_source === 'gps', 'the GPS pickup is stamped at the cold storage');
  const garageRun = await depScan(modeEnv(null), { orders: [orderOf(c)], shifts: [shift], points: pts }, '2026-11-30T10:46:00Z');
  assert.equal(lastUpsert(garageRun.w).movement, 'moving_no_pickup', 'today (switch unset) the same phone reads moving with no boxes, the bug 6.2 fixes');
  assert.ok(!garageRun.w.calls.some((x) => x.method === 'PATCH' && x.url.includes('pickup_seen_at=is.null')));
  pass('scan with a cold storage start: at_origin at the Bronx-style site and the GPS pickup stamped there; with the switch unset nothing changes (still moving_no_pickup)');
}
// -- the garage behavior is identical with the switch unset or practice -
{
  const order = { id: '567ba3a6-7101-4eeb-bb74-4fd5069724cd', client_name: 'Client X', venue: 'Test Hall', delivery_notes: 'Test Hall, 9 Test Ave, New York, NY 10001',
    delivery_at_utc: '2026-11-30T00:00:00+00:00', event_start_at: '2026-11-30T00:00:00+00:00', stage: 'paid_full', market: 'ny', coconuts_qty: 100,
    delivery_request: { date: '2026-11-30', window: '3:30 PM', status: 'confirmed', source: 'owner', checked_at: '2026-11-25T10:00:00Z' },
    invoice_fulfillment: { read_status: 'complete', address: 'Test Hall, 9 Test Ave, New York, NY 10001', delivery_date: '2026-11-30' } };
  const plan = { order_id: order.id, plan_date: '2026-11-30', market: 'ny', state: 'planned', window_text: '3:30 PM', arrive_source: 'delivery_request', arrive_kind: 'exact',
    arrive_at: '2026-11-30T20:30:00.000Z', origin_kind: 'garage', origin_lat: GARAGE.lat, origin_lng: GARAGE.lng, origin_label: 'NJ garage', dest_source: 'invoice',
    dest_address: 'Test Hall, 9 Test Ave, New York, NY 10001', dest_lat: 40.75, dest_lng: -73.99, drive_seconds: 3600, has_ferry: false, route_source: 'apple_maps',
    leave_by_at: '2026-11-30T18:30:00.000Z', computed_at: '2026-11-30T17:00:00Z', alerts: {}, movement: 'nobody' };
  const shift = { id: 's-ben', worker_name: 'Ben', worker_email: 'ben@example.test', market: 'ny', clock_in_at: '2026-11-30T16:00:00Z', clock_in_lat: GARAGE.lat, clock_in_lng: GARAGE.lng };
  const pts = { 's-ben': [{ lat: GARAGE.lat + 0.006, lng: GARAGE.lng, at: '2026-11-30T17:44:00Z' }, { lat: GARAGE.lat, lng: GARAGE.lng, at: '2026-11-30T17:20:00Z' }] };
  const strip = (calls) => JSON.stringify(calls.filter((x) => !x.url.endsWith('/rpc/hc_crew_departure_origins')).map((x) => ({ m: x.method, u: x.url, b: x.body && { ...x.body, updated_at: null } })));
  const moments = ['2026-11-30T17:45:00Z', '2026-11-30T18:28:00Z', '2026-11-30T18:45:00Z', '2026-11-30T21:00:00Z'];
  for (const iso of moments) {
    const unset = await depScan(modeEnv(null), { orders: [order], plans: [plan], shifts: [shift], points: pts }, iso);
    const practice = await depScan(modeEnv('practice'), { orders: [order], plans: [plan], shifts: [shift], points: pts }, iso);
    const onNoTrip = await depScan(modeEnv('on'), { orders: [order], plans: [plan], shifts: [shift], points: pts }, iso);
    assert.equal(strip(practice.w.calls), strip(unset.w.calls), iso + ': practice makes the very same requests and writes as unset');
    assert.equal(practice.w.calls.length, unset.w.calls.length);
    assert.equal(strip(onNoTrip.w.calls), strip(unset.w.calls), iso + ': on, with the database answering off, writes the same as unset');
    assert.equal(onNoTrip.w.calls.length, unset.w.calls.length + 1, iso + ': on adds exactly one read');
    assert.equal(unset.w.originCalls(), 0);
  }
  pass('garage plans are identical with CREW_PLAN_MODE unset, practice, and on with no approved trip (every request and body, at 4 moments of a job day); on adds exactly one read');
}

// Haversine in meters (the worker's distMeters is not exported).
function distM(a, b) {
  const R = 6371000, r = (x) => x * Math.PI / 180;
  const dLat = r(b.lat - a.lat), dLng = r(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

console.log('PASS: ' + passed + ' departure site origin checks. Fake network only, no database, no phone.');

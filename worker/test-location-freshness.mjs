// The real shift and START producers against a closed fake network. Nothing
// here reaches Supabase, Apple, Telegram or a physical phone.
import assert from 'node:assert/strict';
import {
  buildLiveActivityContentState, classifyShiftLocationReport, liveActivityStaleDate,
  movementState, runLiveActivityStartScan, runShiftStatusScan,
} from './worker.js';

const NOW = Date.parse('2026-10-02T18:00:00Z');
const MIN = 60000;
const GARAGE = { lat: 40.586659, lng: -74.323824 };
const AWAY = { lat: 40.75, lng: -74.1 };
const ENV = { SUPABASE_URL: 'https://offline.invalid', SUPABASE_SERVICE_KEY: 'offline-only' };
const iso = (at) => new Date(at).toISOString();
const point = (place, age) => ({ ...place, at: iso(NOW - age * MIN) });
const uuid = (n) => String(n).padStart(8, '0') + '-0000-4000-8000-000000000000';
let serial = 0, passed = 0;

function reply(status, data = null) {
  return { ok: status >= 200 && status < 300, status,
    json: async () => data, text: async () => JSON.stringify(data) };
}

function harness(report, options = {}) {
  const id = uuid(++serial);
  const shift = {
    id, worker_name: 'Offline Worker', worker_email: 'crew@example.invalid', market: 'ny',
    clock_in_at: iso(NOW - 30 * MIN), clock_in_lat: GARAGE.lat, clock_in_lng: GARAGE.lng,
    ...options.shift,
  };
  const claim = {
    shift_id: id, delivery_id: uuid(10000 + serial), queue_id: uuid(20000 + serial),
    device_id: uuid(30000 + serial), generation: 1, token: 'a'.repeat(64),
    worker_name: shift.worker_name, clock_in_at: shift.clock_in_at, market: 'ny',
    report_at: report?.at, report_lat: report?.lat, report_lng: report?.lng,
  };
  const queue = new Map(), calls = [], inserts = [];
  const previous = { fetch: globalThis.fetch, now: Date.now, error: console.error };
  const state = {
    now: NOW, report, points: options.points, failPoints: false, failInsert: false,
    lookup: 'normal', tokens: ['offline-owner-token'], plans: options.plans || [],
  };
  Date.now = () => state.now;
  console.error = () => {}; // Expected fake failures must not expose fixture data.
  globalThis.fetch = async (input, init = {}) => {
    const u = new URL(String(input));
    assert.equal(u.origin, ENV.SUPABASE_URL, 'the fake network blocks all external calls');
    const resource = u.pathname.replace('/rest/v1/', '');
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ resource, method });
    if (method === 'GET') {
      if (resource === 'shifts') return reply(200, [shift]);
      if (resource === 'shift_locations') return state.failPoints ? reply(503, {})
        : reply(200, state.points ?? (state.report ? [state.report] : []));
      if (resource === 'field_workers') return reply(200, [
        { email: 'owner@example.invalid', role: 'owner', active: true, market: 'ny' },
      ]);
      if (resource === 'live_activity_tokens') return reply(200, state.tokens.map((token) =>
        ({ email: 'owner@example.invalid', token })));
      if (resource === 'order_departures') return reply(200, state.plans);
      if (resource === 'orders') return reply(200, []);
      if (resource === 'push_queue') {
        if (state.lookup === 'unknown') return reply(503, {});
        if (state.lookup === 'malformed') return reply(200, {});
        const queued = queue.get((u.searchParams.get('id') || '').replace(/^eq\./, ''));
        return reply(200, queued ? [queued] : []);
      }
    }
    if (method === 'POST' && resource === 'push_queue') {
      inserts.push(body);
      if (state.failInsert) return reply(503, {});
      if (!queue.has(body.id)) queue.set(body.id, { ...body, done_at: null, last_error: null });
      return reply(201);
    }
    if (method === 'POST' && resource === 'rpc/hc_claim_live_activity_starts_v2') return reply(200, [claim]);
    if (method === 'PATCH' && resource === 'live_activity_start_deliveries') return reply(204);
    throw new Error('unexpected offline operation');
  };
  return { state, shift, queue, calls, inserts,
    updates: () => inserts.filter((row) => row.kind === 'la_update'),
    starts: () => inserts.filter((row) => row.kind === 'la_start'),
    restore() { globalThis.fetch = previous.fetch; Date.now = previous.now; console.error = previous.error; },
  };
}

async function check(name, test) {
  await test(); passed++; console.log('PASS: ' + name);
}

const cases = [
  ['fresh garage', point(GARAGE, 2), 'At NJ Garage'],
  ['garage just before the boundary', point(GARAGE, 15 - 1 / MIN), 'At NJ Garage'],
  ['garage at the exact 15-minute boundary', point(GARAGE, 15), 'Location delayed'],
  ['one-hour-old garage', point(GARAGE, 60), 'Location delayed'],
  ['fresh away', point(AWAY, 2), 'Enroute'],
  ['old away is not proof of stopping', point(AWAY, 30), 'Location delayed'],
  ['missing report time', { ...GARAGE }, 'Location delayed'],
  ['invalid report time', { ...GARAGE, at: 'not-a-date' }, 'Location delayed'],
  ['future report time', { ...GARAGE, at: iso(NOW + 1) }, 'Location delayed'],
  ['missing coordinates', { at: iso(NOW - MIN), lat: null, lng: null }, 'Location delayed'],
  ['invalid latitude', { lat: 91, lng: 0, at: iso(NOW - MIN) }, 'Location delayed'],
  ['invalid longitude', { lat: 0, lng: 181, at: iso(NOW - MIN) }, 'Location delayed'],
];

for (const [label, report, expected] of cases) {
  await check('UPDATE and START: ' + label, async () => {
    const h = harness(report);
    try {
      const classification = classifyShiftLocationReport(report);
      assert.equal(classification.status, expected);
      await runShiftStatusScan(ENV);
      assert.equal(h.updates().length, 1);
      assert.equal(await runLiveActivityStartScan(ENV), 1);
      for (const row of [h.updates()[0], h.starts()[0]]) {
        const payload = row.payload, content = payload.aps['content-state'];
        assert.equal(content.status, expected);
        assert.equal(content.lastReportISO ?? null, classification.lastReportISO);
        assert.equal(payload.aps['stale-date'], classification.fresh
          ? Math.max(Math.floor(NOW / 1000) + 1, Math.floor((Date.parse(report.at) + 15 * MIN) / 1000))
          : Math.floor(NOW / 1000) + 1);
        assert.ok(payload.aps['stale-date'] > payload.aps.timestamp);
        assert.equal(payload.headers.push_type, 'liveactivity');
        if (!classification.fresh) {
          assert.equal(content.stage, 'location_delayed');
          assert.equal(content.headline, 'Location delayed');
          for (const key of ['etaISO', 'leaveByISO', 'jobTag', 'lateMinutes']) assert.ok(!(key in content));
        }
      }
      if (!classification.fresh) assert.equal(movementState({
        marketHasGarage: true, clockInPoint: GARAGE, newestPoint: report, nowMs: NOW,
        recentPoints: [], hasOpenShift: true,
      }), 'unknown');
    } finally { h.restore(); }
  });
}

await check('no points: valid clock-in position is usable only while fresh', async () => {
  for (const age of [2, 15]) {
    const h = harness(null, { shift: { clock_in_at: iso(NOW - age * MIN) } });
    try {
      await runShiftStatusScan(ENV);
      assert.equal(h.updates()[0].payload.aps['content-state'].status,
        age < 15 ? 'At NJ Garage' : 'Location delayed');
    } finally { h.restore(); }
  }
});

await check('START with no report does not invent garage or use clock-in as a GPS time', async () => {
  const h = harness(null);
  try {
    assert.equal(await runLiveActivityStartScan(ENV), 1);
    const payload = h.starts()[0].payload;
    assert.equal(payload.aps['content-state'].status, 'Location delayed');
    assert.equal(payload.aps['content-state'].stage, 'location_delayed');
    assert.ok(!('lastReportISO' in payload.aps['content-state']));
    assert.equal(payload.aps['stale-date'], Math.floor(NOW / 1000) + 1);
    assert.equal(payload.aps.attributes.clockInISO, h.shift.clock_in_at);
  } finally { h.restore(); }
});

await check('no coordinates and failed location reads do not preserve a garage claim', async () => {
  const h = harness(null, { shift: { clock_in_lat: null, clock_in_lng: null } });
  try {
    await runShiftStatusScan(ENV);
    assert.equal(h.updates()[0].payload.aps['content-state'].status, 'Location delayed');
    h.state.failPoints = true;
    h.state.now += 5 * MIN;
    await runShiftStatusScan(ENV);
    assert.equal(h.updates().at(-1).payload.aps['content-state'].status, 'Location delayed');
    assert.ok(!('lastReportISO' in h.updates().at(-1).payload.aps['content-state']));
  } finally { h.restore(); }
});

await check('a departure plan cannot mask stale garage or invalid GPS', async () => {
  const plan = { state: 'planned', movement: 'departed', dest_address: 'Offline venue',
    leave_by_at: iso(NOW - MIN), arrive_at: iso(NOW + 60 * MIN), eta_at: iso(NOW + 30 * MIN) };
  const h = harness(point(GARAGE, 60), { plans: [plan] });
  try {
    await runShiftStatusScan(ENV);
    const content = h.updates()[0].payload.aps['content-state'];
    assert.equal(content.status, 'Location delayed');
    assert.ok(!h.calls.some((call) => call.resource === 'order_departures'));
    assert.ok(!('etaISO' in content));
    assert.deepEqual(buildLiveActivityContentState('Location delayed', 60, iso(NOW - 60 * MIN), 'ny',
      { stage: 'enroute', headline: 'ETA soon', etaISO: iso(NOW + MIN), jobTag: 'Offline' }), content);
  } finally { h.restore(); }
});

await check('lost signal after fresh garage changes status without a new point', async () => {
  const h = harness(point(GARAGE, 2));
  try {
    await runShiftStatusScan(ENV);
    h.state.now += 13 * MIN;
    await runShiftStatusScan(ENV);
    assert.deepEqual(h.updates().map((row) => row.payload.aps['content-state'].status),
      ['At NJ Garage', 'Location delayed']);
  } finally { h.restore(); }
});

await check('fresh GPS recovery restores a current location and a new deadline', async () => {
  const h = harness(point(GARAGE, 60));
  try {
    await runShiftStatusScan(ENV);
    h.state.now += 5 * MIN;
    h.state.report = { ...AWAY, at: iso(h.state.now - MIN) };
    await runShiftStatusScan(ENV);
    const update = h.updates().at(-1).payload;
    assert.equal(update.aps['content-state'].status, 'Enroute');
    assert.equal(update.aps['stale-date'], Math.floor((h.state.now + 14 * MIN) / 1000));
  } finally { h.restore(); }
});

await check('definite queue insertion failure is retried when data is unchanged', async () => {
  const h = harness(point(GARAGE, 2));
  try {
    h.state.failInsert = true;
    await runShiftStatusScan(ENV);
    assert.equal(h.queue.size, 0);
    h.state.failInsert = false;
    await runShiftStatusScan(ENV);
    assert.equal(h.queue.size, 1);
  } finally { h.restore(); }
});

await check('queued UPDATE errors retry next tick; pending rows do not double-send', async () => {
  const h = harness({ ...GARAGE, at: 'not-a-date' });
  try {
    await runShiftStatusScan(ENV);
    const first = [...h.queue.values()][0];
    h.state.now += 5 * MIN;
    await runShiftStatusScan(ENV);
    assert.equal(h.updates().length, 1, 'pending row keeps its drainer retries');
    first.done_at = iso(h.state.now); first.last_error = 'offline delivery failed';
    h.state.now += 5 * MIN;
    await runShiftStatusScan(ENV);
    assert.equal(h.updates().length, 2);
    assert.notEqual(h.updates()[0].id, h.updates()[1].id);
  } finally { h.restore(); }
});

await check('unknown, malformed and successful queue outcomes have a bounded refresh', async () => {
  for (const lookup of ['unknown', 'malformed', 'normal']) {
    const h = harness({ ...GARAGE, at: 'not-a-date' });
    try {
      await runShiftStatusScan(ENV);
      const first = [...h.queue.values()][0];
      first.done_at = iso(NOW); first.last_error = null;
      h.state.lookup = lookup;
      h.state.now += 5 * MIN;
      await runShiftStatusScan(ENV);
      assert.equal(h.updates().length, 1);
      h.state.now += 10 * MIN;
      await runShiftStatusScan(ENV);
      assert.equal(h.updates().length, 2, 'queue success is not a phone display receipt');
    } finally { h.restore(); }
  }
});

await check('pending UPDATE remains drainer-owned at and beyond the refresh boundary', async () => {
  const h = harness({ ...GARAGE, at: 'not-a-date' });
  try {
    await runShiftStatusScan(ENV);
    const first = [...h.queue.values()][0];
    h.state.now += 15 * MIN;
    await runShiftStatusScan(ENV);
    assert.equal(h.updates().length, 1, 'pending row is not replaced at 15 minutes');
    h.state.now += 5 * MIN;
    await runShiftStatusScan(ENV);
    assert.equal(h.updates().length, 1, 'pending row is still not duplicated after 15 minutes');
    first.done_at = iso(h.state.now); first.last_error = 'expired before delivery';
    h.state.now += 5 * MIN;
    await runShiftStatusScan(ENV);
    assert.equal(h.updates().length, 2, 'drainer closure allows the unchanged state to retry');
    assert.notEqual(h.updates()[0].id, h.updates()[1].id);
  } finally { h.restore(); }
});

await check('missing cached queue row is requeued without changing its content', async () => {
  const h = harness({ ...GARAGE, at: 'not-a-date' });
  try {
    await runShiftStatusScan(ENV);
    h.queue.clear(); h.state.now += 5 * MIN;
    await runShiftStatusScan(ENV);
    assert.equal(h.updates().length, 2);
  } finally { h.restore(); }
});

await check('new and rotated phone tokens are not suppressed by the shift cache', async () => {
  const h = harness(point(GARAGE, 2));
  try {
    h.state.tokens = [];
    await runShiftStatusScan(ENV);
    assert.equal(h.updates().length, 0);
    h.state.tokens = ['offline-owner-token'];
    await runShiftStatusScan(ENV);
    h.state.tokens = ['offline-rotated-token'];
    await runShiftStatusScan(ENV);
    assert.equal(h.updates().length, 2);
    assert.deepEqual(h.updates().at(-1).payload.tokens, ['offline-rotated-token']);
  } finally { h.restore(); }
});

await check('staleness deadlines never contain an invalid or ancient timestamp', () => {
  for (const report of [null, 'not-a-date', iso(NOW + MIN), iso(NOW - 24 * 60 * MIN)]) {
    assert.equal(liveActivityStaleDate(report, NOW), Math.floor(NOW / 1000) + 1);
  }
});

console.log(`PASS: ${passed} location freshness checks. Fake network only, no phone-delivery claim.`);

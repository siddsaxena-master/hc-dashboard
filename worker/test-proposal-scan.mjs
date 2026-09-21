// Tests for the proposed-time wiring in worker.js (migration 042):
// runProposalScan, runStillWaitingScan, the alt time inside the departure
// scan, and the three banner texts. Fake network throughout.
//
// Run it with:  node worker/test-proposal-scan.mjs
//
// The Thursday this exists for: 2026-09-10 13:15 ET, a coordinator's
// forwarded timeline about Abigail Canelle's Saturday wedding, the 2:00 PM
// only inside the PDF, the order on file saying 3:30/4 PM.

import assert from 'node:assert/strict';
import { runProposalScan, runStillWaitingScan, runDeparturePlanScan, proposalTexts, linkedNoTimeReason, addressProposalsOn, addressPlaceWords, extractArrivalTimes, reconfirmAnswerFirstText } from './worker.js';

let passed = 0;
const pass = (m) => { passed++; console.log('PASS: ' + m); };
const SB = 'https://example.invalid';
const ORDER_ID = '567ba3a6-7101-4eeb-bb74-4fd5069724cd';
const T = (iso) => Date.parse(iso);
const ENV = { SUPABASE_URL: SB, SUPABASE_SERVICE_KEY: 'not-a-real-key' };
const ROSTER = [
  { email: 'owner@example.invalid', name: 'Sidd', role: 'owner', market: 'ny', active: true },
  { email: 'ny.manager@example.invalid', name: 'Jayden Martin', role: 'manager', market: 'ny', active: true },
  { email: 'crew@example.invalid', name: 'Hashim Nadir', role: 'team', market: 'ny', active: true },
];
const TOKENS = { 'owner@example.invalid': 'owner-token', 'ny.manager@example.invalid': 'manager-token', 'crew@example.invalid': 'crew-token' };
const ORDER = {
  id: ORDER_ID, client_name: 'Abigail Canelle', market: 'ny', venue: 'Pridwin Hotel', delivery_notes: 'Pridwin Hotel, Shelter Island, NY',
  delivery_at_utc: '2026-09-12T00:00:00+00:00', stage: 'paid_full',
  delivery_request: { date: '2026-09-12', window: 'As close to 3:30/4 PM as possible', status: 'confirmed', source: 'email', checked_at: '2026-09-06T19:29:22.762Z' },
};
const BODY_54869 = 'Resending with the correct email address!\n\nWarmest Regards,\nAnadina\n862-899-1468\n\n---------- Forwarded message ---------\nDate: Thu, Sep 10, 2026 at 12:12 PM\nHello, everyone,\nPlease find the timeline attached.';
const PDF_SECTION = '\n\n=== ATTACHMENT: Canelle-Walsh Timeline.pdf (PDF text, 20 pages) ===\n12:00 PM Isabel arrives (Day-of coordinator)\n2:00 PM Branded Fresh Coconuts: Hamptons Coconuts- Sidd Saxena / sidd@hamptonscoconuts.com / 732-887-3962\n4:30 PM Ceremony';
const intakeRow = (extra = {}) => ({ id: 54869, subject: 'Fwd: Abigail Canelle & Nolan Walsh-Day-of Coordination Timeline-09/12/2026', raw_text: BODY_54869 + PDF_SECTION, order_id: ORDER_ID, created_at: '2026-09-10T17:15:23+00:00', error_detail: null, orders: ORDER, ...extra });

function reply(status, data = null) {
  return { ok: status >= 200 && status < 300, status, async json() { return data; }, async text() { return data == null ? '' : JSON.stringify(data); } };
}
// A throwaway P-256 key so the Apple token path signs for real (the ZIP
// fill in case 17 goes through the worker's own appleGet).
async function fakeAppleKeyPem() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const b64 = Buffer.from(der).toString('base64').replace(/(.{64})/g, '$1\n');
  return '-----BEGIN PRIVATE KEY-----\n' + b64 + '\n-----END PRIVATE KEY-----\n';
}
// The fake world. opts: intakes (each with its embedded orders row),
// proposals (order_time_proposals), addressProposals
// (order_address_proposals, migration 045; the table answers 404 until
// the option is given), orders (for the address follow-up reads), plans,
// geocode (a function from the query text to an Apple geocode answer;
// absent means the geocoder answers 404), intakeColumnsMissing (a worker
// ahead of 045: the intake read naming replayed_at answers 400),
// intakeReadFail ({status, text}: every intake read fails that way),
// failStampOnce (the first address_scanned_at PATCH times out).
function harness(opts = {}) {
  const calls = [];
  let stampFailed = false;
  const proposals = new Map((opts.proposals || []).map((p) => [Number(p.intake_id), { ...p }]));
  const intakes = new Map((opts.intakes || []).map((r) => [Number(r.id), { ...r }]));
  const plans = new Map((opts.plans || []).map((p) => [p.order_id, { ...p }]));
  const address = new Map((opts.addressProposals || []).map((p) => [Number(p.intake_id), { status: 'pending', apply_status: null, notified_at: null, ...p }]));
  const ordersById = new Map([...(opts.orders || []), ...[...intakes.values()].map((r) => r.orders).filter(Boolean)].map((o) => [o.id, o]));
  const apple = { geocode: 0 };
  const embedIntake = (p) => ({ ...p, intake_messages: { created_at: (intakes.get(Number(p.intake_id)) || {}).created_at || null } });
  // The few PostgREST filters these scans use, applied to a row.
  const filtered = (rows, path) => {
    let out = rows;
    for (const [, key, val] of path.matchAll(/(?:\?|&)(status|apply_status|notified_at|applied_at|order_id|intake_id)=([^&]+)/g)) {
      const v = decodeURIComponent(val);
      if (v === 'is.null') out = out.filter((p) => p[key] == null);
      else if (v === 'not.is.null') out = out.filter((p) => p[key] != null);
      else if (v.startsWith('eq.')) out = out.filter((p) => String(p[key]) === v.slice(3));
      else if (v.startsWith('in.(')) { const set = v.slice(4, -1).split(','); out = out.filter((p) => set.includes(String(p[key]))); }
    }
    return out;
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (urlValue, options = {}) => {
    const url = String(urlValue);
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, method, body });
    if (url.startsWith('https://maps-api.apple.com')) {
      const u = new URL(url);
      if (u.pathname === '/v1/token') return reply(200, { accessToken: 'fake-access', expiresInSeconds: 1800 });
      if (u.pathname === '/v1/geocode') { apple.geocode++; return opts.geocode ? reply(200, opts.geocode(u.searchParams.get('q'))) : reply(404, {}); }
      return reply(404, {});
    }
    if (!url.startsWith(SB + '/rest/v1/')) throw new Error('unexpected offline fetch: ' + method + ' ' + url);
    const path = url.slice((SB + '/rest/v1/').length);
    if (method === 'GET' && path.startsWith('intake_messages?')) {
      if (opts.intakeReadFail) return { ok: false, status: opts.intakeReadFail.status, async json() { return null; }, async text() { return opts.intakeReadFail.text; } };
      // Before 045 PostgREST refuses a select naming the two new columns.
      if (opts.intakeColumnsMissing && /replayed_at/.test(path)) {
        return { ok: false, status: 400, async json() { return null; }, async text() { return JSON.stringify({ code: '42703', message: 'column intake_messages.replayed_at does not exist' }); } };
      }
      // Newest first, the way the scan asks (it walks the page oldest first).
      return reply(200, [...intakes.values()].filter((r) => r.order_id && (!r.status || r.status === 'pending_review'))
        .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))
        .map((r) => {
          const out = { ...r, orders: r.orders || ordersById.get(r.order_id) };
          if (opts.intakeColumnsMissing) { delete out.replayed_at; delete out.address_scanned_at; }
          return out;
        }));
    }
    if (method === 'PATCH' && path.startsWith('intake_messages?id=eq.')) {
      const id = Number(/id=eq\.(\d+)/.exec(path)[1]);
      if (opts.failStampOnce && body && body.address_scanned_at && !stampFailed) {
        stampFailed = true;
        throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
      }
      const row = intakes.get(id);
      if (row && !(path.includes('status=eq.pending_review') && row.status && row.status !== 'pending_review')) Object.assign(row, body);
      return reply(200, []);
    }
    if (method === 'GET' && path.startsWith('order_time_proposals?')) {
      if (opts.proposalsTableMissing) return reply(404, { code: 'PGRST205' });
      let rows = [...proposals.values()];
      const st = /status=eq\.([a-z]+)/.exec(path);
      if (st) rows = rows.filter((p) => p.status === st[1]);
      const byOrder = /order_id=eq\.([^&]+)/.exec(path);
      if (byOrder) rows = rows.filter((p) => p.order_id === decodeURIComponent(byOrder[1]));
      if (path.includes('orders!inner')) rows = rows.map((p) => ({ ...p, orders: ORDER }));
      if (path.includes('intake_messages!inner')) rows = rows.map(embedIntake);
      return reply(200, rows);
    }
    if (path.startsWith('order_address_proposals')) {
      if (!opts.addressProposals && !opts.addressTable) return reply(404, { code: 'PGRST205' });
      if (method === 'GET') {
        let rows = filtered([...address.values()], path);
        if (path.includes('intake_messages!inner')) rows = rows.map(embedIntake);
        if (path.includes('orders!inner')) rows = rows.filter((p) => ordersById.has(p.order_id)).map((p) => ({ ...p, orders: ordersById.get(p.order_id) }));
        return reply(200, rows);
      }
      if (method === 'POST') {
        if (!address.has(Number(body.intake_id))) address.set(Number(body.intake_id), { status: 'pending', apply_status: null, notified_at: null, ...body });
        return reply(201, null);
      }
      if (method === 'PATCH') {
        for (const p of filtered([...address.values()], path)) Object.assign(p, body);
        return reply(200, []);
      }
    }
    if (method === 'POST' && path === 'order_time_proposals') {
      if (!proposals.has(Number(body.intake_id))) proposals.set(Number(body.intake_id), { status: 'pending', ...body });
      return reply(201, null);
    }
    if (method === 'PATCH' && path.startsWith('order_time_proposals?')) {
      const byIntake = /intake_id=eq\.(\d+)/.exec(path);
      const byOrder = /order_id=eq\.([^&]+)/.exec(path);
      for (const p of proposals.values()) {
        if (byIntake && Number(p.intake_id) !== Number(byIntake[1])) continue;
        if (byOrder && p.order_id !== decodeURIComponent(byOrder[1])) continue;
        if (path.includes('status=eq.pending') && p.status !== 'pending') continue;
        Object.assign(p, body);
      }
      return reply(200, []);
    }
    if (method === 'GET' && path.startsWith('orders?')) return reply(200, opts.orders || []);
    if (method === 'GET' && path.startsWith('order_departures?')) return reply(200, [...plans.values()]);
    if (method === 'POST' && path.startsWith('order_departures?on_conflict')) {
      const merged = { alerts: {}, ...(plans.get(body.order_id) || {}), ...body };
      plans.set(body.order_id, merged);
      return reply(201, [merged]);
    }
    if (method === 'PATCH' && path.startsWith('order_departures?order_id=eq.')) {
      const id = decodeURIComponent(/order_id=eq\.([^&]+)/.exec(path)[1]);
      const row = plans.get(id);
      if (!row) return reply(200, []);
      const guard = /alerts->>([a-z_0-9]+)=is\.null/.exec(path);
      if (guard && row.alerts && row.alerts[guard[1]] !== undefined) return reply(200, []);
      Object.assign(row, body);
      return reply(200, [row]);
    }
    if (method === 'GET' && path.startsWith('shifts?')) return reply(200, []);
    if (method === 'GET' && path.startsWith('shift_locations?')) return reply(200, []);
    if (method === 'GET' && path.startsWith('field_workers?')) return reply(200, ROSTER);
    if (method === 'GET' && path.startsWith('push_tokens?')) {
      const list = decodeURIComponent(path.split('email=in.(')[1].split(')')[0]);
      const wanted = list.split(',').map((s) => s.replace(/"/g, '').trim().toLowerCase());
      return reply(200, wanted.filter((e) => TOKENS[e]).map((e) => ({ email: e, apns_token: TOKENS[e] })));
    }
    if (method === 'POST' && path === 'push_queue') return reply(201, null);
    if (method === 'GET' && path.startsWith('push_queue?id=eq.')) return reply(200, []);
    // The sent reconfirmation rows the scan reads quoted answers against
    // (case 25, 2026-09-21): read only with RECONFIRM_MODE on.
    if (method === 'GET' && path.startsWith('order_reconfirmations?')) return reply(200, opts.reconfirmations || []);
    throw new Error('unexpected offline fetch: ' + method + ' ' + url);
  };
  return {
    calls, proposals, intakes, plans, address, apple,
    queuePosts: () => calls.filter((c) => c.method === 'POST' && c.url === SB + '/rest/v1/push_queue').map((c) => c.body),
    addressCalls: () => calls.filter((c) => c.url.startsWith(SB + '/rest/v1/order_address_proposals')),
    restore: () => { globalThis.fetch = originalFetch; },
  };
}
const realNow = Date.now;
async function at(iso, fn) { Date.now = () => T(iso); try { return await fn(); } finally { Date.now = realNow; } }

// ── 1. Thursday 1:20 PM: the proposal and the owner's banner ────────
{
  const h = harness({ intakes: [intakeRow()] });
  try {
    const counts = await at('2026-09-10T17:20:00Z', () => runProposalScan(ENV));
    assert.equal(counts.proposed, 1);
    const p = h.proposals.get(54869);
    assert.equal(p.order_id, ORDER_ID);
    assert.equal(p.proposed_arrive_at, '2026-09-12T18:00:00.000Z');
    assert.equal(p.proposed_label, '2:00 PM');
    assert.equal(p.evidence_where, 'attachment:Canelle-Walsh Timeline.pdf');
    assert.ok(!p.evidence_line.includes('@') && !/\d{3}[\s.-]\d{3}[\s.-]\d{4}/.test(p.evidence_line), p.evidence_line);
    assert.equal(p.on_file_window, 'As close to 3:30/4 PM as possible');
    const posts = h.queuePosts();
    assert.equal(posts.length, 2, 'owner body and manager body');
    const owner = posts.find((q) => q.payload.tokens.includes('owner-token'));
    const manager = posts.find((q) => q.payload.tokens.includes('manager-token'));
    assert.equal(owner.payload.aps.alert.title, 'Time change? Canelle, Sat Sep 12');
    // The evidence line is cut at 90 characters by the extractor (the phone
    // number sat past that) and the email address inside it is masked.
    assert.equal(owner.payload.aps.alert.body, 'A coordinator email says arrive 2:00 PM (PDF timeline: "2:00 PM Branded Fresh Coconuts: Hamptons Coconuts- Sidd Saxena / [email]"). On file: "As close to 3:30/4 PM as possible" (customer email, checked Sep 6). Open Needs you to Accept or Keep. Until you decide, the alarm uses 2:00 PM.');
    assert.equal(manager.payload.aps.alert.body, 'A coordinator email says arrive 2:00 PM, on file As close to 3:30/4 PM as possible. Sidd decides in the app. Until then the alarm uses 2:00 PM.');
    for (const q of posts) {
      assert.ok(!q.payload.tokens.includes('crew-token'), 'crew never hear an unconfirmed time');
      assert.equal(q.payload.headers.collapse_id, 'prop-54869');
      assert.equal(q.payload.body.kind, 'time_change'); assert.equal(q.payload.body.intake_id, 54869);
      assert.equal(q.payload.telegram_text, null);
    }
    const again = await at('2026-09-10T17:25:00Z', () => runProposalScan(ENV));
    assert.equal(again.skipped, 1); assert.equal(h.queuePosts().length, 2);
    // ARTWORK_PROPOSALS unset (migration 048, worker/test-artwork-proposals.mjs
    // has the rest): the artwork table is never read and counts.artwork is null.
    assert.equal(again.artwork, null);
    assert.equal(h.calls.filter((c) => c.url.includes('order_artwork_proposals')).length, 0, 'zero artwork reads with the switch unset');
  } finally { h.restore(); }
  pass('Thursday 1:20 PM: the 2:00 PM is read out of the PDF, stored as a proposal, and the owner and manager get their banners once; crew never');
}
// ── 2. A time that agrees with the on-file window makes no proposal ─
{
  const h = harness({ intakes: [intakeRow({ raw_text: 'Confirming Hamptons Coconuts arrival 3:30 PM Saturday' })] });
  try {
    const counts = await at('2026-09-10T17:20:00Z', () => runProposalScan(ENV));
    assert.equal(counts.agree, 1); assert.equal(h.proposals.size, 0); assert.equal(h.queuePosts().length, 0);
  } finally { h.restore(); }
  pass('an email that agrees with the time on file changes nothing and sends nothing');
}
// ── 3. Linked but no readable time: one banner, then quiet ──────────
{
  const h = harness({ intakes: [intakeRow({ raw_text: BODY_54869 + '\n\n=== ATTACHMENT: scan.pdf (no text layer, NOT read) ===' })] });
  try {
    const counts = await at('2026-09-10T17:20:00Z', () => runProposalScan(ENV));
    assert.equal(counts.noTime, 1);
    const q = h.queuePosts()[0];
    assert.equal(q.payload.aps.alert.title, 'Coordinator email: Canelle / Pridwin, Sat Sep 12');
    assert.equal(q.payload.aps.alert.body, 'PDF attached, NOT readable (no text layer). Open it in Outlook.');
    assert.ok(String(h.intakes.get(54869).error_detail).startsWith('linked_no_time notified '));
    await at('2026-09-10T17:25:00Z', () => runProposalScan(ENV));
    assert.equal(h.queuePosts().length, 1);
  } finally { h.restore(); }
  assert.equal(linkedNoTimeReason('x\n=== ATTACHMENT: t.pdf (PDF text, 3 pages) ===\nnothing'), 'pdf_no_time');
  assert.equal(linkedNoTimeReason('plain'), 'no_attachment');
  pass('a linked email with no readable time tells the owner once and is marked');
}
// ── 4. The table is not there yet: nothing happens, nothing throws ──
{
  const h = harness({ intakes: [intakeRow()], proposalsTableMissing: true });
  try {
    const counts = await at('2026-09-10T17:20:00Z', () => runProposalScan(ENV));
    assert.equal(counts.proposed, 0); assert.equal(h.queuePosts().length, 0);
  } finally { h.restore(); }
  pass('before migration 042 the scan does nothing and logs it');
}
// ── 5. The departure alarm uses the earlier undecided time ──────────
{
  const APPLE = { ...ENV, APPLE_MAPS_KEY_ID: 'k', APPLE_MAPS_TEAM_ID: 't', APPLE_MAPS_PRIVATE_KEY: 'x' };
  const plan = {
    order_id: ORDER_ID, plan_date: '2026-09-12', market: 'ny', state: 'planned', window_text: 'As close to 3:30/4 PM as possible',
    arrive_source: 'delivery_request', arrive_kind: 'range', arrive_at: '2026-09-12T19:30:00+00:00', alt_arrive_at: null,
    origin_kind: 'garage', origin_lat: 40.586659, origin_lng: -74.323824, origin_label: 'NJ garage',
    dest_source: 'invoice', dest_address: 'Pridwin Hotel, Shelter Island, NY, US', dest_lat: 41.0879, dest_lng: -72.3593,
    drive_seconds: 11100, static_seconds: 10000, distance_meters: 186700, has_ferry: true, route_source: 'apple_maps', route_error: null,
    buffer_seconds: 3600, ferry_seconds: 1800, leave_by_at: '2026-09-12T14:55:00+00:00', movement: 'nobody',
    silenced_at: null, alerts: { heads_up: { at: 'x' }, leave_now: { at: 'x' }, late_10: { at: 'x' } }, computed_at: '2026-09-12T13:00:00+00:00',
  };
  const order = { ...ORDER, invoice_fulfillment: { read_status: 'complete', address: 'Pridwin Hotel, Shelter Island, NY, US' } };
  const h = harness({ orders: [order], plans: [plan], proposals: [{ intake_id: 54869, order_id: ORDER_ID, proposed_arrive_at: '2026-09-12T18:00:00+00:00', proposed_label: '2:00 PM', status: 'pending' }] });
  try {
    await at('2026-09-12T13:05:00Z', () => runDeparturePlanScan(APPLE));
    const stored = h.plans.get(ORDER_ID);
    assert.equal(stored.alt_arrive_at, '2026-09-12T18:00:00.000Z');
    assert.equal(stored.alt_intake_id, 54869);
    assert.equal(stored.arrive_at, '2026-09-12T19:30:00.000Z', 'the time on file is untouched');
    assert.equal(stored.leave_by_at, '2026-09-12T13:25:00.000Z', 'leave-by now follows the earlier 2:00 PM');
    // The alt-only change carried the late stamps: at 13:05 (20 min before the
    // new leave-by) nothing fires, and late_10 stays stamped rather than replaying.
    assert.ok(stored.alerts.late_10, 'late_10 carried across the alt change');
    const q = h.queuePosts();
    assert.equal(q.length, 0);
  } finally { h.restore(); }
  pass('the departure alarm follows the earlier undecided time; already-sent nags are carried, not replayed');
}
// ── 6. Still waiting: cadence, quiet hours, owner only, retirement ──
{
  const pending = { intake_id: 54869, order_id: ORDER_ID, proposed_arrive_at: '2026-09-12T18:00:00+00:00', proposed_label: '2:00 PM', on_file_window: 'As close to 3:30/4 PM as possible', found_at: '2026-09-10T17:20:00+00:00', status: 'pending', nagged_at: null };
  let h = harness({ proposals: [pending], plans: [{ order_id: ORDER_ID, leave_by_at: '2026-09-12T13:25:00+00:00', origin_label: 'NJ garage', alt_arrive_at: '2026-09-12T18:00:00+00:00' }] });
  try {
    let counts = await at('2026-09-11T01:00:00Z', () => runStillWaitingScan(ENV)); // 9 PM ET Thursday, 41 h out
    assert.equal(counts.nagged, 1);
    const q = h.queuePosts()[0];
    assert.deepEqual(q.payload.tokens, ['owner-token']);
    assert.equal(q.payload.aps.alert.title, 'Still waiting: Canelle in 41h');
    assert.equal(q.payload.aps.alert.body, 'Email says 2:00 PM, on file As close to 3:30/4 PM as possible. If 2:00 PM: leave NJ garage by about 9:25 AM. The alarm uses 2:00 PM until you decide. Open Needs you to Accept or Keep.');
    assert.ok(h.proposals.get(54869).nagged_at);
    counts = await at('2026-09-11T03:00:00Z', () => runStillWaitingScan(ENV)); // 11 PM ET: quiet hours
    assert.equal(counts.nagged, 0);
    counts = await at('2026-09-11T14:00:00Z', () => runStillWaitingScan(ENV)); // 10 AM Friday, 28 h out: 4-hour cadence, 13 h since
    assert.equal(counts.nagged, 1);
    counts = await at('2026-09-11T16:00:00Z', () => runStillWaitingScan(ENV)); // 2 h later: too soon at the 4-hour cadence
    assert.equal(counts.nagged, 0);
    counts = await at('2026-09-12T13:00:00Z', () => runStillWaitingScan(ENV)); // Saturday 9 AM, 5 h out: hourly
    assert.equal(counts.nagged, 1);
  } finally { h.restore(); }
  const decidedByHand = { ...ORDER, delivery_request: { ...ORDER.delivery_request, source: 'owner', checked_at: '2026-09-11T12:00:00Z' } };
  h = harness({ proposals: [{ ...pending, nagged_at: null }] });
  try {
    const orig = globalThis.fetch;
    globalThis.fetch = async (u, o) => {
      const r = await orig(u, o);
      if (String(u).includes('order_time_proposals?select=*,orders!inner')) {
        const rows = await r.json();
        return { ...r, async json() { return rows.map((p) => ({ ...p, orders: decidedByHand })); } };
      }
      return r;
    };
    const counts = await at('2026-09-11T14:00:00Z', () => runStillWaitingScan(ENV));
    assert.equal(counts.retired, 1);
    assert.equal(h.proposals.get(54869).status, 'superseded');
    assert.equal(h.proposals.get(54869).decided_via, 'owner_edit');
    assert.equal(h.queuePosts().length, 0);
  } finally { h.restore(); }
  pass('still waiting: owner only, hourly inside 24 h, every 4 h before, quiet 10 PM to 7 AM, retired when the owner typed a newer time');
}
// ── 7. The texts, standalone ────────────────────────────────────────
{
  const t = proposalTexts('time_change', ORDER, { day: '2026-09-12', label: '2:00 PM', evidence: '2:00 PM Hamptons Coconuts arrival + setup', where: 'attachment:Canelle-Walsh Timeline.pdf', onFileText: 'As close to 3:30/4 PM as possible', onFileSource: 'customer email', onFileChecked: '2026-09-06T19:29:22.762Z' });
  assert.equal(t.body, 'A coordinator email says arrive 2:00 PM (PDF timeline: "2:00 PM Hamptons Coconuts arrival + setup"). On file: "As close to 3:30/4 PM as possible" (customer email, checked Sep 6). Open Needs you to Accept or Keep. Until you decide, the alarm uses 2:00 PM.');
  const u = proposalTexts('time_change', ORDER, { day: '2026-09-12', label: '2:00 PM', onFileText: '' });
  assert.ok(u.body.includes('On file: no clock time.'));
  assert.equal(proposalTexts('linked_no_time', ORDER, { day: '2026-09-12', why: 'reader_missing' }).body, 'PDF reader not installed, NOT read. Open it in Outlook.');
  pass('proposal texts: the owner body, the no-clock-time variant, the reader-missing variant');
}

// ════════════════════════════════════════════════════════════════════
// Address proposals (migration 045, PHASE2-ADDRESS-PROPOSALS-PLAN
// section 5a). The customer this exists for: Alison Sheeley's August email
// naming 491 S Dean Street, Englewood, NJ, which sat unread while invoice
// 2049 carried the address on one line and taxed it as NYC.
// ════════════════════════════════════════════════════════════════════
const ENV_ADDR = { ...ENV, ADDRESS_PROPOSALS: 'on' };
const SHEELEY_ID = '9b2c4d6e-1f3a-4b5c-8d7e-0a1b2c3d4e5f';
const SHEELEY_BODY = 'Hi Sidd,\n\nConfirming for Friday the 18th. Please deliver the coconuts to 491 S Dean Street, Englewood, NJ 07631.\n\nThanks,\nAlison Sheeley\n201-555-0143\nalison@example.invalid';
const sheeleyOrder = (extra = {}) => ({
  id: SHEELEY_ID, client_name: 'Alison Sheeley', market: 'ny', venue: null, delivery_notes: null, delivery_at_utc: '2026-09-18T00:00:00+00:00', event_start_at: null,
  stage: 'deposit_paid', external_invoice_id: '188', delivery_request: null, invoice_fulfillment: null, ...extra,
});
// Marked linked_no_time already, so the time branch stays quiet and the
// address branch is what the pushes show.
const sheeleyIntake = (extra = {}) => ({
  id: 70001, subject: 'Friday delivery', raw_text: SHEELEY_BODY, order_id: SHEELEY_ID, created_at: '2026-08-22T14:00:00+00:00',
  error_detail: 'linked_no_time notified 2026-08-22T14:05:00.000Z', replayed_at: null, address_scanned_at: null, orders: sheeleyOrder(), ...extra,
});
const invoiceWith = (address, structured, updated = '2026-08-20T10:00:00Z') => ({ read_status: 'complete', address, address_structured: structured, source_updated_at: updated });
const addressPosts = (h) => h.queuePosts().filter((q) => q.payload.body.kind === 'address_change');

// ── 8. The switch: unset or anything but 'on' means off, zero address calls
{
  assert.equal(addressProposalsOn({}), false); assert.equal(addressProposalsOn({ ADDRESS_PROPOSALS: 'ON' }), true);
  assert.equal(addressProposalsOn({ ADDRESS_PROPOSALS: 'yes' }), false); assert.equal(addressProposalsOn({ ADDRESS_PROPOSALS: 'on' }), true);
  const h = harness({ intakes: [sheeleyIntake()], addressProposals: [] });
  try {
    const counts = await at('2026-09-15T14:00:00Z', () => runProposalScan(ENV));
    assert.equal(counts.address, null);
    assert.equal(h.addressCalls().length, 0, 'no read or write of order_address_proposals');
    assert.equal(h.intakes.get(70001).address_scanned_at, null, 'not stamped');
    assert.equal(h.queuePosts().length, 0);
  } finally { h.restore(); }
  pass('switch off: the scan never touches order_address_proposals and behaves as before');
}
// ── 9. Invoice blank: the row, the owner-only banner, one pass per email
{
  const h = harness({ intakes: [sheeleyIntake({ orders: sheeleyOrder({ invoice_fulfillment: invoiceWith(null, false) }) })], addressProposals: [] });
  try {
    const counts = await at('2026-09-15T14:00:00Z', () => runProposalScan(ENV_ADDR));
    assert.equal(counts.address.proposed, 1);
    const p = h.address.get(70001);
    assert.equal(p.order_id, SHEELEY_ID);
    assert.deepEqual(p.proposed_address, { line1: '491 S Dean Street', city: 'Englewood', state: 'NJ', postal_code: '07631' });
    assert.equal(p.proposed_text, '491 S Dean Street, Englewood, NJ 07631');
    assert.equal(p.evidence_where, 'body');
    assert.ok(p.evidence_line.includes('491 S Dean Street') && !p.evidence_line.includes('@') && !/\d{3}[\s.-]\d{3}[\s.-]\d{4}/.test(p.evidence_line), p.evidence_line);
    assert.equal(p.on_file_address, null); assert.equal(p.on_file_source, null);
    assert.equal(p.on_file_structured, false); assert.equal(p.on_file_newer, false);
    assert.equal(p.invoice_id_snapshot, '188'); assert.equal(p.delivery_day_snapshot, '2026-09-18');
    assert.equal(p.found_at, '2026-09-15T14:00:00.000Z');
    assert.equal(h.intakes.get(70001).address_scanned_at, '2026-09-15T14:00:00.000Z', 'stamped');
    const posts = h.queuePosts();
    assert.equal(posts.length, 1);
    const q = posts[0];
    assert.deepEqual(q.payload.tokens, ['owner-token'], 'owner only, never the manager or crew');
    assert.equal(q.payload.aps.alert.title, 'Address? Sheeley, Fri Sep 18');
    assert.equal(q.payload.aps.alert.body, 'A customer email gives a drop off address in Englewood, NJ. The invoice has none. Open Needs you to Accept or Keep.');
    assert.equal(q.payload.headers.collapse_id, 'addr-70001'); assert.equal(q.payload.aps['thread-id'], 'prop-70001');
    assert.equal(q.payload.body.kind, 'address_change'); assert.equal(q.payload.body.intake_id, 70001); assert.equal(q.payload.body.order_id, SHEELEY_ID);
    assert.ok(!JSON.stringify(q).includes('Dean'), 'the street never rides in a push');
    assert.equal(q.payload.telegram_text, null);
    // The same email again: already scanned, nothing new. The stamp is
    // what skips it (not the repeat rule): no rejection is counted and
    // the existing-proposals read is not made a second time.
    const existingReads = () => h.addressCalls().filter((c) => c.method === 'GET' && c.url.includes('status=in.(pending,kept')).length;
    assert.equal(existingReads(), 1);
    const again = await at('2026-09-15T14:05:00Z', () => runProposalScan(ENV_ADDR));
    assert.equal(again.address.proposed, 0); assert.equal(again.address.rejected, 0); assert.equal(again.address.none, 0);
    assert.equal(existingReads(), 1, 'no second existing-proposals read'); assert.equal(h.queuePosts().length, 1);
  } finally { h.restore(); }
  pass('invoice blank: one order_address_proposals row, one owner-only Address? banner with city and state only, one pass per email (the stamp skips it, nothing is re-read)');
}
// ── 10. Invoice differs: the banner names both towns; the snapshot holds the invoice address
{
  const inv = invoiceWith('45 Main St, Southampton, NY 11968', true);
  const h = harness({ intakes: [sheeleyIntake({ orders: sheeleyOrder({ invoice_fulfillment: inv }) })], addressProposals: [] });
  try {
    await at('2026-09-15T14:00:00Z', () => runProposalScan(ENV_ADDR));
    const p = h.address.get(70001);
    assert.equal(p.on_file_address, '45 Main St, Southampton, NY 11968'); assert.equal(p.on_file_source, 'invoice'); assert.equal(p.on_file_structured, true);
    assert.equal(addressPosts(h)[0].payload.aps.alert.body, 'A customer email gives a drop off address in Englewood, NJ; the invoice says Southampton, NY. Open Needs you to Accept or Keep.');
  } finally { h.restore(); }
  pass('invoice differs: the banner says which town the invoice has, the row snapshots the invoice address');
}
// ── 11. One-line agree proposes; structured agree is silent
{
  let h = harness({ intakes: [sheeleyIntake({ orders: sheeleyOrder({ invoice_fulfillment: invoiceWith('491 S Dean Street, Englewood, NJ 07631', false) }) })], addressProposals: [] });
  try {
    const counts = await at('2026-09-15T14:00:00Z', () => runProposalScan(ENV_ADDR));
    assert.equal(counts.address.proposed, 1); assert.equal(counts.address.agree, 0);
    assert.equal(h.address.get(70001).on_file_structured, false);
    assert.equal(addressPosts(h)[0].payload.aps.alert.body, 'A customer email gives the drop off address in Englewood, NJ. The invoice has it on one line, so QuickBooks may tax it wrong. Open Needs you to Accept or Keep.');
  } finally { h.restore(); }
  // Structure unknown (synced before Jarvis learned to record it): still one tap.
  h = harness({ intakes: [sheeleyIntake({ orders: sheeleyOrder({ invoice_fulfillment: { read_status: 'complete', address: '491 South Dean St, Englewood NJ 07631' } }) })], addressProposals: [] });
  try {
    const counts = await at('2026-09-15T14:00:00Z', () => runProposalScan(ENV_ADDR));
    assert.equal(counts.address.proposed, 1); assert.equal(h.address.get(70001).on_file_structured, null);
  } finally { h.restore(); }
  // The invoice holds it structured: dropped silently, stamped, no row, no banner.
  h = harness({ intakes: [sheeleyIntake({ orders: sheeleyOrder({ invoice_fulfillment: invoiceWith('491 S Dean Street, Englewood, NJ 07631', true) }) })], addressProposals: [] });
  try {
    const counts = await at('2026-09-15T14:00:00Z', () => runProposalScan(ENV_ADDR));
    assert.equal(counts.address.agree, 1); assert.equal(counts.address.proposed, 0);
    assert.equal(h.address.size, 0); assert.equal(h.queuePosts().length, 0);
    assert.equal(h.intakes.get(70001).address_scanned_at, '2026-09-15T14:00:00.000Z');
  } finally { h.restore(); }
  pass('agree with a one-line (or unknown-structure) invoice proposes with the one-line words; agree with a structured invoice is silent');
}
// ── 12. The address STALE rule, and no invoice means not stamped
{
  // The owner put a full structured Southampton address on the invoice on
  // Sep 14, AFTER the August email: the email is not news.
  let h = harness({ intakes: [sheeleyIntake({ orders: sheeleyOrder({ invoice_fulfillment: invoiceWith('45 Main St, Southampton, NY 11968', true, '2026-09-14T10:00:00Z') }) })], addressProposals: [] });
  try {
    const counts = await at('2026-09-15T14:00:00Z', () => runProposalScan(ENV_ADDR));
    assert.equal(counts.address.stale, 1); assert.equal(h.address.size, 0); assert.equal(h.queuePosts().length, 0);
    assert.equal(h.intakes.get(70001).address_scanned_at, '2026-09-15T14:00:00.000Z');
  } finally { h.restore(); }
  // The same later edit but on one line (structured false): Sidd's hand fix
  // must not hide the structured rewrite. Proposed, marked invoice-newer.
  h = harness({ intakes: [sheeleyIntake({ orders: sheeleyOrder({ invoice_fulfillment: invoiceWith('491 S Dean Street Englewood NJ 07631', false, '2026-09-14T10:00:00Z') }) })], addressProposals: [] });
  try {
    const counts = await at('2026-09-15T14:00:00Z', () => runProposalScan(ENV_ADDR));
    assert.equal(counts.address.proposed, 1); assert.equal(h.address.get(70001).on_file_newer, true);
  } finally { h.restore(); }
  // No invoice yet: nothing to write to, and NOT stamped so the row is read
  // again once the job is invoiced. No geocode, no proposal write (the two
  // reads left are the follow-up loop's).
  h = harness({ intakes: [sheeleyIntake({ orders: sheeleyOrder({ external_invoice_id: null }) })], addressProposals: [] });
  try {
    const counts = await at('2026-09-15T14:00:00Z', () => runProposalScan(ENV_ADDR));
    assert.equal(counts.address.noInvoice, 1); assert.equal(h.addressCalls().filter((c) => c.method !== 'GET').length, 0); assert.equal(h.apple.geocode, 0);
    assert.equal(h.intakes.get(70001).address_scanned_at, null); assert.equal(h.queuePosts().length, 0);
  } finally { h.restore(); }
  pass('STALE: a structured address written after the email makes no proposal; a one-line later edit still does; no invoice leaves the row unstamped');
}
// ── 13. Replayed rows: dismissed after both branches, never a linked_no_time banner
{
  const replayed = sheeleyIntake({ error_detail: null, replayed_at: '2026-09-15T13:00:00+00:00', orders: sheeleyOrder({ invoice_fulfillment: invoiceWith(null, false) }) });
  let h = harness({ intakes: [replayed], addressProposals: [] });
  try {
    const counts = await at('2026-09-15T14:00:00Z', () => runProposalScan(ENV_ADDR));
    assert.equal(counts.replayed, 1); assert.equal(counts.noTime, 1);
    const row = h.intakes.get(70001);
    assert.equal(row.status, 'dismissed'); assert.equal(row.reviewed_at, '2026-09-15T14:00:00.000Z');
    assert.equal(row.error_detail, 'replay: time=none, address=proposed');
    // The dismissal is guarded on pending_review in the URL itself (plan 5a
    // step 5), so a row the RPC or a time decision already dismissed is
    // never rewritten.
    const dismiss = h.calls.find((c) => c.method === 'PATCH' && c.body && c.body.status === 'dismissed');
    assert.ok(dismiss && dismiss.url.endsWith('intake_messages?id=eq.70001&status=eq.pending_review'), dismiss && dismiss.url);
    const posts = h.queuePosts();
    assert.equal(posts.length, 1); assert.equal(posts[0].payload.body.kind, 'address_change');
    assert.ok(h.address.get(70001), 'the proposal row stands on its own');
  } finally { h.restore(); }
  // Switch off: the replayed row keeps pending_review (invisible through the
  // replayed_at filters) and no banner of any kind goes out.
  h = harness({ intakes: [sheeleyIntake({ error_detail: null, replayed_at: '2026-09-15T13:00:00+00:00' })], addressProposals: [] });
  try {
    const counts = await at('2026-09-15T14:00:00Z', () => runProposalScan(ENV));
    assert.equal(counts.replayed, 0); assert.equal(counts.noTime, 1);
    assert.equal(h.intakes.get(70001).status, undefined); assert.equal(h.queuePosts().length, 0);
  } finally { h.restore(); }
  // A live row with no time still gets its Coordinator email banner.
  h = harness({ intakes: [sheeleyIntake({ error_detail: null })], addressProposals: [] });
  try {
    await at('2026-09-15T14:00:00Z', () => runProposalScan(ENV));
    assert.equal(h.queuePosts().length, 1); assert.equal(h.queuePosts()[0].payload.body.kind, 'linked_no_time');
  } finally { h.restore(); }
  // A replayed row on a quoted job (no invoice yet): the address pass did
  // not run, so the row is NOT dismissed. It stays pending_review, hidden
  // by the replayed_at filters, and is read again once the job is
  // invoiced, so a quoted job's replayed address is never lost.
  h = harness({ intakes: [sheeleyIntake({ error_detail: null, replayed_at: '2026-09-15T13:00:00+00:00', orders: sheeleyOrder({ external_invoice_id: null }) })], addressProposals: [] });
  try {
    const counts = await at('2026-09-15T14:00:00Z', () => runProposalScan(ENV_ADDR));
    assert.equal(counts.address.noInvoice, 1); assert.equal(counts.replayed, 0); assert.equal(counts.noTime, 1);
    assert.equal(h.intakes.get(70001).status, undefined, 'still pending_review'); assert.equal(h.intakes.get(70001).address_scanned_at, null);
    assert.equal(h.queuePosts().length, 0); assert.equal(h.apple.geocode, 0);
    // The job is invoiced: the same row is read again and dismissed with its outcome.
    h.intakes.get(70001).orders = sheeleyOrder({ invoice_fulfillment: invoiceWith(null, false) });
    const later = await at('2026-09-16T14:00:00Z', () => runProposalScan(ENV_ADDR));
    assert.equal(later.replayed, 1); assert.equal(later.address.proposed, 1);
    assert.equal(h.intakes.get(70001).status, 'dismissed'); assert.equal(h.intakes.get(70001).error_detail, 'replay: time=none, address=proposed');
  } finally { h.restore(); }
  // The other note shapes the Jarvis --report counts (replay_intake_since.py
  // parses 'replay: time=<x>, address=<y>'): a coordinator's footer is
  // rejected:signature, a structured invoice that already holds the address
  // is agree. Real worker output, not hand-written strings.
  const footer = 'Timeline attached.\n\nBest,\nAnadina Lopez\nEvents by Anadina\n12 Bridge Street, Suite 4, Nutley, NJ 07110\n973-555-0199\nanadina@example.invalid';
  h = harness({ intakes: [sheeleyIntake({ raw_text: footer, error_detail: null, replayed_at: '2026-09-15T13:00:00+00:00', orders: sheeleyOrder({ invoice_fulfillment: invoiceWith(null, false) }) })], addressProposals: [] });
  try {
    const counts = await at('2026-09-15T14:00:00Z', () => runProposalScan(ENV_ADDR));
    assert.equal(counts.replayed, 1); assert.equal(counts.address.rejected, 1); assert.equal(counts.address.none, 0);
    assert.equal(h.intakes.get(70001).status, 'dismissed'); assert.equal(h.intakes.get(70001).error_detail, 'replay: time=none, address=rejected:signature');
    assert.equal(h.address.size, 0); assert.equal(h.queuePosts().length, 0);
  } finally { h.restore(); }
  h = harness({ intakes: [sheeleyIntake({ error_detail: null, replayed_at: '2026-09-15T13:00:00+00:00', orders: sheeleyOrder({ invoice_fulfillment: invoiceWith('491 S Dean Street, Englewood, NJ 07631', true) }) })], addressProposals: [] });
  try {
    const counts = await at('2026-09-15T14:00:00Z', () => runProposalScan(ENV_ADDR));
    assert.equal(counts.replayed, 1); assert.equal(counts.address.agree, 1);
    assert.equal(h.intakes.get(70001).status, 'dismissed'); assert.equal(h.intakes.get(70001).error_detail, 'replay: time=none, address=agree');
    assert.equal(h.address.size, 0); assert.equal(h.queuePosts().length, 0);
  } finally { h.restore(); }
  // No street in the email at all (the 'none' outcome): stamped like every
  // other outcome, so the extraction runs once per email, no row, no
  // banner, and a second tick makes no existing-proposals read.
  const noStreet = 'See you Friday, thanks!';
  h = harness({ intakes: [sheeleyIntake({ raw_text: noStreet, orders: sheeleyOrder({ invoice_fulfillment: invoiceWith(null, false) }) })], addressProposals: [] });
  try {
    const existingReads = () => h.addressCalls().filter((c) => c.method === 'GET' && c.url.includes('status=in.(pending,kept')).length;
    const counts = await at('2026-09-15T14:00:00Z', () => runProposalScan(ENV_ADDR));
    assert.equal(counts.address.none, 1); assert.equal(counts.address.rejected, 0); assert.equal(counts.address.proposed, 0);
    assert.equal(h.intakes.get(70001).address_scanned_at, '2026-09-15T14:00:00.000Z', 'the none outcome is stamped');
    assert.equal(h.address.size, 0); assert.equal(h.queuePosts().length, 0); assert.equal(existingReads(), 0);
    const again = await at('2026-09-15T14:05:00Z', () => runProposalScan(ENV_ADDR));
    assert.equal(again.address.none, 0, 'the stamp skips it, nothing is counted again'); assert.equal(existingReads(), 0);
    assert.equal(h.intakes.get(70001).address_scanned_at, '2026-09-15T14:00:00.000Z', 'not re-stamped');
  } finally { h.restore(); }
  // The same email as a replayed row: dismissed with a real address=none note.
  h = harness({ intakes: [sheeleyIntake({ raw_text: noStreet, error_detail: null, replayed_at: '2026-09-15T13:00:00+00:00', orders: sheeleyOrder({ invoice_fulfillment: invoiceWith(null, false) }) })], addressProposals: [] });
  try {
    const counts = await at('2026-09-15T14:00:00Z', () => runProposalScan(ENV_ADDR));
    assert.equal(counts.replayed, 1); assert.equal(counts.address.none, 1);
    assert.equal(h.intakes.get(70001).status, 'dismissed'); assert.equal(h.intakes.get(70001).error_detail, 'replay: time=none, address=none');
    assert.equal(h.intakes.get(70001).address_scanned_at, '2026-09-15T14:00:00.000Z');
    assert.equal(h.address.size, 0); assert.equal(h.queuePosts().length, 0);
  } finally { h.restore(); }
  // A replayed row on a cancelled order: neither branch runs, so it is
  // dismissed on the cancelled path (never left pending_review for good,
  // which the 045 rollback needs empty). Only with the switch on; a live
  // row on a cancelled order is skipped and left alone as before.
  h = harness({ intakes: [sheeleyIntake({ error_detail: null, replayed_at: '2026-09-15T13:00:00+00:00', orders: sheeleyOrder({ stage: 'cancelled', invoice_fulfillment: invoiceWith(null, false) }) })], addressProposals: [] });
  try {
    const counts = await at('2026-09-15T14:00:00Z', () => runProposalScan(ENV_ADDR));
    assert.equal(counts.skipped, 1); assert.equal(counts.replayed, 1); assert.equal(counts.address.none, 0); assert.equal(counts.address.proposed, 0);
    assert.equal(h.intakes.get(70001).status, 'dismissed'); assert.equal(h.intakes.get(70001).error_detail, 'replay: order cancelled');
    assert.equal(h.intakes.get(70001).reviewed_at, '2026-09-15T14:00:00.000Z');
    assert.equal(h.intakes.get(70001).address_scanned_at, null, 'no address pass ran');
    const dismiss = h.calls.find((c) => c.method === 'PATCH' && c.body && c.body.status === 'dismissed');
    assert.ok(dismiss && dismiss.url.endsWith('intake_messages?id=eq.70001&status=eq.pending_review'), dismiss && dismiss.url);
    assert.equal(h.address.size, 0); assert.equal(h.queuePosts().length, 0);
  } finally { h.restore(); }
  h = harness({ intakes: [sheeleyIntake({ error_detail: null, replayed_at: '2026-09-15T13:00:00+00:00', orders: sheeleyOrder({ stage: 'cancelled' }) })], addressProposals: [] });
  try {
    const counts = await at('2026-09-15T14:00:00Z', () => runProposalScan(ENV));
    assert.equal(counts.skipped, 1); assert.equal(counts.replayed, 0);
    assert.equal(h.intakes.get(70001).status, undefined, 'switch off: left pending_review');
  } finally { h.restore(); }
  h = harness({ intakes: [sheeleyIntake({ error_detail: null, orders: sheeleyOrder({ stage: 'cancelled' }) })], addressProposals: [] });
  try {
    const counts = await at('2026-09-15T14:00:00Z', () => runProposalScan(ENV_ADDR));
    assert.equal(counts.skipped, 1); assert.equal(counts.replayed, 0);
    assert.equal(h.intakes.get(70001).status, undefined, 'a live row on a cancelled order is untouched');
    assert.equal(h.calls.filter((c) => c.method === 'PATCH').length, 0);
  } finally { h.restore(); }
  // Every note the worker can write matches the report's parser shape.
  for (const note of ['replay: time=none, address=proposed', 'replay: time=none, address=rejected:signature', 'replay: time=none, address=agree', 'replay: time=none, address=none']) {
    const m = /replay: time=([^,]+), address=(.+)$/.exec(note);
    assert.ok(m && !/[\s,]/.test(m[1]) && !/[\s,]/.test(m[2]), note);
  }
  pass('replayed rows: dismissed with the replay note once the address branch ran (proposed, rejected:signature, agree, none, each parseable by the report; the PATCH guarded on pending_review), no Coordinator email banner ever; switch off leaves them pending; a quoted job keeps its replayed row until it is invoiced; a cancelled order dismisses the replayed row with "replay: order cancelled"; a no-street email is stamped once');
}
// ── 14. The time STALE rule and the newest-email guard
{
  // Sidd confirmed 3:30 PM in the app on Sep 11, AFTER the Sep 10 email: no proposal.
  const ownerLater = { ...ORDER, delivery_request: { ...ORDER.delivery_request, source: 'owner', checked_at: '2026-09-11T12:00:00Z' } };
  let h = harness({ intakes: [intakeRow({ orders: ownerLater })] });
  try {
    const counts = await at('2026-09-12T13:00:00Z', () => runProposalScan(ENV));
    assert.equal(counts.stale, 1); assert.equal(counts.proposed, 0); assert.equal(h.proposals.size, 0); assert.equal(h.queuePosts().length, 0);
  } finally { h.restore(); }
  // Confirmed BEFORE the email: the email is news, proposed as before.
  const ownerEarlier = { ...ORDER, delivery_request: { ...ORDER.delivery_request, source: 'owner', checked_at: '2026-09-09T12:00:00Z' } };
  h = harness({ intakes: [intakeRow({ orders: ownerEarlier })] });
  try {
    const counts = await at('2026-09-10T17:20:00Z', () => runProposalScan(ENV));
    assert.equal(counts.proposed, 1);
  } finally { h.restore(); }
  // A LIVE correction that landed 20 seconds before the owner's tap on the
  // previous email (classified after the tap, so scanned now): still news,
  // proposed. The strict compare would have dropped it silently.
  const tapJustAfter = { ...ORDER, delivery_request: { ...ORDER.delivery_request, source: 'owner', checked_at: '2026-09-10T17:15:43Z' } };
  h = harness({ intakes: [intakeRow({ orders: tapJustAfter })] });
  try {
    const counts = await at('2026-09-10T17:20:00Z', () => runProposalScan(ENV));
    assert.equal(counts.stale, 0); assert.equal(counts.proposed, 1, 'a live email 20 seconds older than the tap is not stale');
    assert.equal(h.queuePosts().length, 2, 'owner body and manager body, as in case 1');
  } finally { h.restore(); }
  // A REPLAYED August email behind a September confirmation: stale, no row,
  // no banner (the grace is for live rows only).
  const replayedAugust = intakeRow({ created_at: '2026-08-20T10:00:00+00:00', replayed_at: '2026-09-15T13:00:00+00:00', orders: { ...ORDER, delivery_request: { ...ORDER.delivery_request, source: 'owner', checked_at: '2026-08-20T10:00:20Z' } } });
  h = harness({ intakes: [replayedAugust] });
  try {
    const counts = await at('2026-09-10T17:20:00Z', () => runProposalScan(ENV));
    assert.equal(counts.stale, 1); assert.equal(counts.proposed, 0); assert.equal(h.proposals.size, 0); assert.equal(h.queuePosts().length, 0);
  } finally { h.restore(); }
  // Across ticks: a pending proposal from a NEWER email stands; the older
  // email is skipped and retires nothing.
  h = harness({
    intakes: [intakeRow({ id: 54868, created_at: '2026-09-08T10:00:00+00:00' }), { ...intakeRow({ id: 54869 }), status: 'dismissed' }],
    proposals: [{ intake_id: 54869, order_id: ORDER_ID, proposed_arrive_at: '2026-09-12T18:00:00+00:00', proposed_label: '2:00 PM', status: 'pending' }],
  });
  try {
    const counts = await at('2026-09-10T17:30:00Z', () => runProposalScan(ENV));
    assert.equal(counts.skipped, 1); assert.equal(counts.proposed, 0);
    assert.equal(h.proposals.get(54869).status, 'pending', 'the newer email keeps its proposal');
    assert.ok(!h.proposals.has(54868));
  } finally { h.restore(); }
  // Within one tick: two unscanned emails are walked oldest first, so the
  // newest one's proposal is the one left standing.
  h = harness({ intakes: [intakeRow({ id: 54868, created_at: '2026-09-08T10:00:00+00:00' }), intakeRow({ id: 54869 })] });
  try {
    const counts = await at('2026-09-10T17:30:00Z', () => runProposalScan(ENV));
    assert.equal(counts.proposed, 2);
    assert.equal(h.proposals.get(54868).status, 'superseded'); assert.equal(h.proposals.get(54868).decided_via, 'newer_email');
    assert.equal(h.proposals.get(54869).status, 'pending');
  } finally { h.restore(); }
  pass('time STALE: an owner confirmation after the email makes no proposal (a live row gets an hour of classify grace, a replayed row none); newest email wins across ticks and within a tick');
}
// ── 15. The follow-up loop: applied and failed banners once, then stamped; retirements
{
  const accepted = (extra = {}) => ({
    intake_id: 70001, order_id: SHEELEY_ID, status: 'accepted', apply_status: 'applied', proposed_text: '491 S Dean Street, Englewood, NJ 07631',
    proposed_address: { line1: '491 S Dean Street', city: 'Englewood', state: 'NJ', postal_code: '07631' }, invoice_doc_number: '2049',
    total_moved: false, tax_zero: false, applied_at: '2026-09-15T14:10:00Z', notified_at: null, ...extra,
  });
  let h = harness({ orders: [sheeleyOrder()], addressProposals: [accepted({ total_moved: true })] });
  try {
    const counts = await at('2026-09-15T14:15:00Z', () => runProposalScan(ENV_ADDR));
    assert.equal(counts.address.notified, 1);
    const q = h.queuePosts()[0];
    assert.deepEqual(q.payload.tokens, ['owner-token']);
    assert.equal(q.payload.aps.alert.title, 'Address on the invoice: Sheeley, Fri Sep 18');
    assert.equal(q.payload.aps.alert.body, 'Invoice #2049 now ships to Englewood, NJ. Sales tax re-calculated. The plan, the app and the reconfirmation draft follow within the hour. The total moved; open the invoice in QuickBooks.');
    assert.equal(q.payload.body.kind, 'address_applied'); assert.equal(q.payload.headers.collapse_id, 'addr-70001');
    assert.equal(h.address.get(70001).notified_at, '2026-09-15T14:15:00.000Z');
    const again = await at('2026-09-15T14:20:00Z', () => runProposalScan(ENV_ADDR));
    assert.equal(again.address.notified, 0); assert.equal(h.queuePosts().length, 1, 'pushed once');
  } finally { h.restore(); }
  h = harness({ orders: [sheeleyOrder()], addressProposals: [accepted({ invoice_doc_number: null, tax_zero: true })] });
  try {
    await at('2026-09-15T14:15:00Z', () => runProposalScan(ENV_ADDR));
    assert.equal(h.queuePosts()[0].payload.aps.alert.body, 'The invoice now ships to Englewood, NJ. Sales tax re-calculated. The plan, the app and the reconfirmation draft follow within the hour. Tax came back zero: check the QuickBooks tax center.');
  } finally { h.restore(); }
  // A QuickBooks refusal: no write happened, so applied_at is null.
  h = harness({ orders: [sheeleyOrder()], addressProposals: [accepted({ apply_status: 'failed', applied_at: null, error_detail: 'QuickBooks said: Stale Object' })] });
  try {
    await at('2026-09-15T14:15:00Z', () => runProposalScan(ENV_ADDR));
    const q = h.queuePosts()[0];
    assert.equal(q.payload.aps.alert.title, 'Address not saved: Sheeley, Fri Sep 18');
    assert.equal(q.payload.aps.alert.body, 'Jarvis could not put the email\'s address on invoice #2049. Open Needs you for the reason.');
    assert.equal(q.payload.body.kind, 'address_failed');
    assert.ok(!JSON.stringify(q).includes('Stale Object'), 'the reason stays in the row, off the banner');
  } finally { h.restore(); }
  // The sync give-up: QuickBooks holds the address (applied_at stamped by
  // the write) but the app never caught up, so Jarvis failed the row two
  // days later. The banner must say the opposite of "not saved", and the
  // flags stamped with the write ride on it (no applied banner follows).
  h = harness({ orders: [sheeleyOrder()], addressProposals: [accepted({ apply_status: 'failed', applied_at: '2026-09-13T13:00:00Z', total_moved: true, error_detail: 'QuickBooks has the address; the app could not be refreshed for two days; re-sync from the Jarvis chat' })] });
  try {
    const counts = await at('2026-09-15T14:15:00Z', () => runProposalScan(ENV_ADDR));
    assert.equal(counts.address.notified, 1);
    const q = h.queuePosts()[0];
    assert.equal(q.payload.aps.alert.title, 'Address on the invoice, app not refreshed: Sheeley, Fri Sep 18');
    assert.equal(q.payload.aps.alert.body, 'Invoice #2049 has the address in QuickBooks, but the app could not be refreshed. Open Needs you. The total moved; open the invoice in QuickBooks.');
    assert.equal(q.payload.body.kind, 'address_failed'); assert.deepEqual(q.payload.tokens, ['owner-token']);
    assert.equal(h.address.get(70001).notified_at, '2026-09-15T14:15:00.000Z');
  } finally { h.restore(); }
  assert.equal(proposalTexts('address_failed', sheeleyOrder(), { day: '2026-09-18', city: 'Englewood', state: 'NJ', docNumber: null, appliedAt: true }).body, 'The invoice has the address in QuickBooks, but the app could not be refreshed. Open Needs you.');
  // Written but the dashboard re-sync is pending: not pushed yet.
  h = harness({ orders: [sheeleyOrder()], addressProposals: [accepted({ apply_status: 'applying' })] });
  try {
    const counts = await at('2026-09-15T14:15:00Z', () => runProposalScan(ENV_ADDR));
    assert.equal(counts.address.notified, 0); assert.equal(h.queuePosts().length, 0);
  } finally { h.restore(); }
  // Retire: the on-file address moved since the scan (owner_edit) or the
  // order was cancelled; both leave apply_status null.
  const pendingRow = { intake_id: 70001, order_id: SHEELEY_ID, status: 'pending', on_file_address: '45 Main St, Southampton, NY 11968', found_at: '2026-09-15T14:00:00Z' };
  h = harness({ orders: [sheeleyOrder({ invoice_fulfillment: invoiceWith('12 Ocean Rd, Bridgehampton, NY 11932', true) })], addressProposals: [pendingRow] });
  try {
    const counts = await at('2026-09-15T15:00:00Z', () => runProposalScan(ENV_ADDR));
    assert.equal(counts.address.retired, 1);
    const p = h.address.get(70001);
    assert.equal(p.status, 'superseded'); assert.equal(p.decided_via, 'owner_edit'); assert.equal(p.apply_status, null);
  } finally { h.restore(); }
  h = harness({ orders: [sheeleyOrder({ invoice_fulfillment: invoiceWith('45 Main St, Southampton, NY 11968', true) })], addressProposals: [pendingRow] });
  try {
    const counts = await at('2026-09-15T15:00:00Z', () => runProposalScan(ENV_ADDR));
    assert.equal(counts.address.retired, 0); assert.equal(h.address.get(70001).status, 'pending', 'unchanged on file: left alone');
  } finally { h.restore(); }
  h = harness({ orders: [sheeleyOrder({ stage: 'cancelled', invoice_fulfillment: invoiceWith('45 Main St, Southampton, NY 11968', true) })], addressProposals: [pendingRow] });
  try {
    await at('2026-09-15T15:00:00Z', () => runProposalScan(ENV_ADDR));
    assert.equal(h.address.get(70001).decided_via, 'cancelled');
  } finally { h.restore(); }
  pass('follow-ups: applied and failed banners go to the owner once and stamp notified_at (a failed row with applied_at set gets the "app not refreshed" banner, not "not saved"); applying waits; moved or cancelled pending rows are retired');
}
// ── 16. Newest email wins for addresses; a repeat of a refused address stays quiet
{
  const older = sheeleyIntake({ id: 70000, created_at: '2026-08-10T09:00:00+00:00', raw_text: 'Deliver to 12 Ocean Rd, Bridgehampton, NY 11932 please.', orders: sheeleyOrder({ invoice_fulfillment: invoiceWith(null, false) }) });
  const newer = sheeleyIntake({ orders: sheeleyOrder({ invoice_fulfillment: invoiceWith(null, false) }) });
  // Both unscanned in one tick: walked oldest first, the newer retires the older.
  let h = harness({ intakes: [older, newer], addressProposals: [] });
  try {
    const counts = await at('2026-09-15T14:00:00Z', () => runProposalScan(ENV_ADDR));
    assert.equal(counts.address.proposed, 2);
    assert.equal(h.address.get(70000).status, 'superseded'); assert.equal(h.address.get(70000).decided_via, 'newer_email');
    assert.equal(h.address.get(70001).status, 'pending');
  } finally { h.restore(); }
  // The newer one already pending from an earlier tick: the older row is
  // skipped and retires nothing.
  h = harness({ intakes: [older, { ...newer, status: 'dismissed' }], addressProposals: [{ intake_id: 70001, order_id: SHEELEY_ID, status: 'pending', proposed_text: '491 S Dean Street, Englewood, NJ 07631' }] });
  try {
    const counts = await at('2026-09-15T14:00:00Z', () => runProposalScan(ENV_ADDR));
    assert.equal(counts.address.rejected, 1); assert.equal(counts.address.proposed, 0);
    assert.equal(h.address.get(70001).status, 'pending'); assert.ok(!h.address.has(70000));
    assert.equal(h.intakes.get(70000).address_scanned_at, '2026-09-15T14:00:00.000Z');
  } finally { h.restore(); }
  // The owner kept the invoice as it was ten days ago; the customer quotes
  // the same address again: no second row.
  h = harness({ intakes: [newer], addressProposals: [{ intake_id: 69999, order_id: SHEELEY_ID, status: 'kept', decided_at: '2026-09-05T12:00:00Z', proposed_text: '491 South Dean St, Englewood NJ 07631' }] });
  try {
    const counts = await at('2026-09-15T14:00:00Z', () => runProposalScan(ENV_ADDR));
    assert.equal(counts.address.rejected, 1); assert.ok(!h.address.has(70001)); assert.equal(h.queuePosts().length, 0);
  } finally { h.restore(); }
  pass('newest email wins for addresses within a tick and across ticks; an address kept within 30 days is not proposed again');
}
// ── 17. No ZIP in the email: one geocode fills it, a mismatch leaves it null
{
  const noZip = sheeleyIntake({ raw_text: 'Please deliver the coconuts to 491 S Dean Street, Englewood, NJ. Thanks!', orders: sheeleyOrder({ invoice_fulfillment: invoiceWith(null, false) }) });
  const APPLE = { ...ENV_ADDR, APPLE_MAPS_KEY_ID: 'ABCDEFGHIJ', APPLE_MAPS_TEAM_ID: 'TEAM123456', APPLE_MAPS_PRIVATE_KEY: await fakeAppleKeyPem() };
  const hit = (house) => ({ results: [{ structuredAddress: { subThoroughfare: house, thoroughfare: 'S Dean St', locality: 'Englewood', administrativeAreaCode: 'NJ', postCode: '07631' } }] });
  let h = harness({ intakes: [noZip], addressProposals: [], geocode: () => hit('491') });
  try {
    await at('2026-09-15T14:00:00Z', () => runProposalScan(APPLE));
    assert.equal(h.apple.geocode, 1);
    assert.equal(h.address.get(70001).proposed_address.postal_code, '07631');
    assert.equal(h.address.get(70001).proposed_text, '491 S Dean Street, Englewood, NJ 07631');
  } finally { h.restore(); }
  h = harness({ intakes: [noZip], addressProposals: [], geocode: () => hit('493') });
  try {
    await at('2026-09-15T14:00:00Z', () => runProposalScan(APPLE));
    assert.equal(h.apple.geocode, 1);
    assert.equal(h.address.get(70001).proposed_address.postal_code, null, 'a different house never lends its ZIP');
    assert.equal(h.address.get(70001).proposed_text, '491 S Dean Street, Englewood, NJ');
    assert.equal(h.queuePosts().length, 1, 'the proposal still goes out');
  } finally { h.restore(); }
  // No provider: no call, ZIP stays empty, the proposal still goes out.
  h = harness({ intakes: [noZip], addressProposals: [] });
  try {
    await at('2026-09-15T14:00:00Z', () => runProposalScan(ENV_ADDR));
    assert.equal(h.apple.geocode, 0); assert.equal(h.address.get(70001).proposed_address.postal_code, null);
  } finally { h.restore(); }
  // The proposals table unreadable (a worker ahead of 045, an outage): the
  // row is left unstamped for the next tick WITHOUT spending an Apple call,
  // so a retry every tick never geocodes the same email twice.
  h = harness({ intakes: [noZip], geocode: () => hit('491') });
  try {
    const counts = await at('2026-09-15T14:00:00Z', () => runProposalScan(APPLE));
    assert.equal(h.apple.geocode, 0, 'no geocode before the table read succeeds'); assert.equal(counts.address.geocoded, 0);
    assert.equal(counts.address.failed, 1); assert.equal(h.intakes.get(70001).address_scanned_at, null, 'left for the next tick');
    assert.equal(h.queuePosts().length, 0);
  } finally { h.restore(); }
  // The counter names each Apple call so a repeat would show in the log.
  h = harness({ intakes: [noZip], addressProposals: [], geocode: () => hit('491') });
  try {
    const counts = await at('2026-09-15T14:00:00Z', () => runProposalScan(APPLE));
    assert.equal(counts.address.geocoded, 1); assert.equal(h.apple.geocode, 1);
  } finally { h.restore(); }
  pass('no ZIP: one Apple geocode fills it when the house matches; a mismatch or no provider leaves it null and the proposal still goes out; an unreadable table costs no geocode');
}
// ── 18. The address texts, standalone
{
  const o = sheeleyOrder();
  assert.equal(proposalTexts('address_change', o, { day: '2026-09-18', city: 'Englewood', state: 'NJ', variant: 'blank' }).title, 'Address? Sheeley, Fri Sep 18');
  assert.equal(proposalTexts('address_change', o, { day: '2026-09-18', city: 'Bridgehampton', state: 'NY', variant: 'differs', onFilePlace: 'Southampton, NY' }).body,
    'A customer email gives a drop off address in Bridgehampton, NY; the invoice says Southampton, NY. Open Needs you to Accept or Keep.');
  // A comma-free one-line invoice address yields no place words (never the
  // street): the body falls back to "a different address".
  assert.equal(proposalTexts('address_change', o, { day: '2026-09-18', city: 'Bridgehampton', state: 'NY', variant: 'differs', onFilePlace: addressPlaceWords('491 S Dean Street Englewood NJ 07631') }).body,
    'A customer email gives a drop off address in Bridgehampton, NY; the invoice says a different address. Open Needs you to Accept or Keep.');
  assert.equal(proposalTexts('address_applied', o, { day: '2026-09-18', city: 'Englewood', state: 'NJ', docNumber: '2049' }).body,
    'Invoice #2049 now ships to Englewood, NJ. Sales tax re-calculated. The plan, the app and the reconfirmation draft follow within the hour.');
  assert.equal(proposalTexts('address_failed', o, { day: '2026-09-18', docNumber: '2049' }).body, 'Jarvis could not put the email\'s address on invoice #2049. Open Needs you for the reason.');
  for (const kind of ['address_change', 'address_applied', 'address_failed']) assert.equal(proposalTexts(kind, o, { day: '2026-09-18', city: 'Englewood', state: 'NJ' }).managerBody, null);
  pass('address texts: the three banners word for word, never a manager body');
}
// ── 19. A worker ahead of 045: the intake read retries without the two columns
{
  // The wide select answers 400 naming replayed_at; the time branch must
  // still propose (Thursday's 2:00 PM) through the narrow re-read.
  let h = harness({ intakes: [intakeRow()], intakeColumnsMissing: true });
  try {
    const counts = await at('2026-09-10T17:20:00Z', () => runProposalScan(ENV));
    assert.equal(counts.proposed, 1); assert.equal(h.proposals.get(54869).proposed_label, '2:00 PM');
    const reads = h.calls.filter((c) => c.method === 'GET' && c.url.includes('/intake_messages?'));
    assert.equal(reads.length, 2, 'one wide read, one narrow retry');
    assert.ok(reads[0].url.includes('replayed_at,address_scanned_at')); assert.ok(!reads[1].url.includes('replayed_at') && !reads[1].url.includes('address_scanned_at'));
    assert.equal(h.queuePosts().length, 2);
  } finally { h.restore(); }
  // A 400 naming another column, or a 500: null, no retry, nothing done.
  for (const fail of [{ status: 400, text: 'column intake_messages.nope does not exist' }, { status: 500, text: 'boom' }]) {
    h = harness({ intakes: [intakeRow()], intakeReadFail: fail });
    try {
      const counts = await at('2026-09-10T17:20:00Z', () => runProposalScan(ENV));
      assert.equal(counts.seen, 0); assert.equal(counts.proposed, 0);
      assert.equal(h.calls.filter((c) => c.method === 'GET' && c.url.includes('/intake_messages?')).length, 1, 'no blind retry');
      assert.equal(h.queuePosts().length, 0);
    } finally { h.restore(); }
  }
  pass('ahead of 045 the intake read retries once without replayed_at and address_scanned_at and time proposals still go out; any other failure is null with no retry');
}
// ── 20. State assumed from a town: the geocode must confirm house, town and state
{
  const town = (extra = {}) => sheeleyIntake({ raw_text: 'Deliver to 12 Ocean Rd, Southampton. Thanks!', orders: sheeleyOrder({ invoice_fulfillment: invoiceWith(null, false) }), ...extra });
  const APPLE = { ...ENV_ADDR, APPLE_MAPS_KEY_ID: 'ABCDEFGHIJ', APPLE_MAPS_TEAM_ID: 'TEAM123456', APPLE_MAPS_PRIVATE_KEY: await fakeAppleKeyPem() };
  const hit = (extra = {}) => ({ results: [{ structuredAddress: { subThoroughfare: '12', thoroughfare: 'Ocean Rd', locality: 'Southampton', administrativeAreaCode: 'NY', postCode: '11968', ...extra } }] });
  let h = harness({ intakes: [town()], addressProposals: [], geocode: () => hit() });
  try {
    const counts = await at('2026-09-15T14:00:00Z', () => runProposalScan(APPLE));
    assert.equal(counts.address.proposed, 1); assert.equal(h.apple.geocode, 1);
    const p = h.address.get(70001);
    assert.deepEqual(p.proposed_address, { line1: '12 Ocean Rd', city: 'Southampton', state: 'NY', postal_code: '11968', state_inferred: true, state_from: 'Southampton' });
    assert.equal(p.proposed_text, '12 Ocean Rd, Southampton, NY 11968');
    assert.equal(addressPosts(h)[0].payload.aps.alert.body, 'A customer email gives a drop off address in Southampton, NY. The invoice has none. Open Needs you to Accept or Keep.');
  } finally { h.restore(); }
  // A Southampton, PA answer, a different house, or no answer at all: no
  // row, rejected as state_missing, stamped so it is not asked again.
  for (const geocode of [() => hit({ administrativeAreaCode: 'PA', postCode: '18966' }), () => hit({ subThoroughfare: '14' }), undefined]) {
    h = harness({ intakes: [town()], addressProposals: [], geocode });
    try {
      const counts = await at('2026-09-15T14:00:00Z', () => runProposalScan(APPLE));
      assert.equal(counts.address.rejected, 1); assert.equal(counts.address.proposed, 0); assert.equal(h.apple.geocode, 1);
      assert.equal(h.address.size, 0); assert.equal(h.queuePosts().length, 0);
      assert.equal(h.intakes.get(70001).address_scanned_at, '2026-09-15T14:00:00.000Z');
    } finally { h.restore(); }
  }
  // No geocoder configured: nothing can confirm the state, so nothing is proposed.
  h = harness({ intakes: [town()], addressProposals: [] });
  try {
    const counts = await at('2026-09-15T14:00:00Z', () => runProposalScan(ENV_ADDR));
    assert.equal(counts.address.rejected, 1); assert.equal(h.apple.geocode, 0); assert.equal(h.address.size, 0);
  } finally { h.restore(); }
  pass('state assumed from a town: proposed with state_inferred and state_from only when the geocode confirms house, town and state; a mismatch, no answer or no geocoder rejects (state_missing) and stamps');
}
// ── 21. A lost stamp after the insert never costs the banner
{
  const h = harness({ intakes: [sheeleyIntake({ orders: sheeleyOrder({ invoice_fulfillment: invoiceWith(null, false) }) })], addressProposals: [], failStampOnce: true });
  try {
    const counts = await at('2026-09-15T14:00:00Z', () => runProposalScan(ENV_ADDR));
    assert.equal(counts.address.proposed, 1); assert.equal(counts.address.failed, 0);
    assert.equal(h.queuePosts().length, 1, 'the banner went out before the stamp');
    assert.equal(h.intakes.get(70001).address_scanned_at, null, 'the stamp was lost');
    const again = await at('2026-09-15T14:05:00Z', () => runProposalScan(ENV_ADDR));
    assert.equal(again.address.rejected, 1, 'the re-read finds its own pending row: a repeat');
    assert.equal(h.queuePosts().length, 1, 'no second banner');
    assert.equal(h.intakes.get(70001).address_scanned_at, '2026-09-15T14:05:00.000Z', 'stamped on the re-read');
    assert.equal(h.address.get(70001).status, 'pending');
  } finally { h.restore(); }
  // The same lost stamp on an email with no ZIP, the geocoder empty on
  // tick 1 and answering on tick 2: the email's own pending row is never
  // superseded by itself (the re-insert would be ignored on the intake_id
  // key and the order left with no row). The ZIP found on tick 2 is
  // written into the row in place, so the owner gets an Accept button;
  // still one row, one banner.
  const noZipMail = sheeleyIntake({ raw_text: 'Please deliver the coconuts to 491 S Dean Street, Englewood, NJ. Thanks!', orders: sheeleyOrder({ invoice_fulfillment: invoiceWith(null, false) }) });
  const hit = { results: [{ structuredAddress: { subThoroughfare: '491', thoroughfare: 'S Dean St', locality: 'Englewood', administrativeAreaCode: 'NJ', postCode: '07631' } }] };
  let geocodeCalls = 0;
  const APPLE = { ...ENV_ADDR, APPLE_MAPS_KEY_ID: 'ABCDEFGHIJ', APPLE_MAPS_TEAM_ID: 'TEAM123456', APPLE_MAPS_PRIVATE_KEY: await fakeAppleKeyPem() };
  const h2 = harness({ intakes: [noZipMail], addressProposals: [], failStampOnce: true, geocode: () => (++geocodeCalls === 1 ? { results: [] } : hit) });
  try {
    const first = await at('2026-09-15T14:00:00Z', () => runProposalScan(APPLE));
    assert.equal(first.address.proposed, 1); assert.equal(first.address.geocoded, 1); assert.equal(h2.address.get(70001).proposed_text, '491 S Dean Street, Englewood, NJ');
    assert.equal(h2.address.get(70001).proposed_address.postal_code, null); assert.equal(h2.intakes.get(70001).address_scanned_at, null, 'the stamp was lost');
    const supersedes = () => h2.addressCalls().filter((c) => c.method === 'PATCH' && c.body.status === 'superseded').length;
    const afterTick1 = supersedes();
    const again = await at('2026-09-15T14:05:00Z', () => runProposalScan(APPLE));
    assert.equal(again.address.proposed, 1); assert.equal(again.address.rejected, 0); assert.equal(again.address.failed, 0); assert.equal(again.address.geocoded, 1);
    assert.equal(h2.address.size, 1, 'still one row');
    const p = h2.address.get(70001);
    assert.equal(p.status, 'pending', 'never superseded by itself'); assert.equal(p.decided_via, undefined);
    assert.equal(p.proposed_text, '491 S Dean Street, Englewood, NJ 07631'); assert.equal(p.proposed_address.postal_code, '07631');
    assert.equal(p.updated_at, '2026-09-15T14:05:00.000Z'); assert.equal(p.found_at, '2026-09-15T14:00:00.000Z', 'the row keeps its first-tick stamp');
    assert.equal(h2.queuePosts().length, 1, 'no second banner');
    assert.equal(h2.intakes.get(70001).address_scanned_at, '2026-09-15T14:05:00.000Z', 'stamped on the re-read');
    assert.equal(supersedes(), afterTick1, 'no supersede PATCH on the re-read');
    assert.equal(h2.addressCalls().filter((c) => c.method === 'POST').length, 1, 'one insert, on tick 1');
  } finally { h2.restore(); }
  pass('a stamp that times out after the insert: the banner still goes out, the next tick sees a repeat and stamps, no second banner; a ZIP found only on the re-read is written into the email\'s own row in place, never superseding it');
}
// ── 22. An accepted address waiting for Jarvis, then a newer email
{
  const OCEAN = { line1: '12 Ocean Rd', city: 'Bridgehampton', state: 'NY', postal_code: '11932' };
  const queuedA = { intake_id: 70000, order_id: SHEELEY_ID, status: 'accepted', apply_status: 'queued', proposed_text: '12 Ocean Rd, Bridgehampton, NY 11932', proposed_address: OCEAN, on_file_address: null, on_file_source: null, decided_at: '2026-09-14T12:00:00Z', applied_at: null, notified_at: null };
  // The newer email repeats the accepted address: a repeat, no second row.
  let h = harness({ intakes: [sheeleyIntake({ raw_text: 'Deliver to 12 Ocean Rd, Bridgehampton, NY 11932 please.', orders: sheeleyOrder({ invoice_fulfillment: invoiceWith(null, false) }) })], addressProposals: [queuedA] });
  try {
    const counts = await at('2026-09-15T14:00:00Z', () => runProposalScan(ENV_ADDR));
    assert.equal(counts.address.rejected, 1); assert.equal(counts.address.proposed, 0); assert.ok(!h.address.has(70001)); assert.equal(h.queuePosts().length, 0);
    assert.equal(h.address.get(70000).status, 'accepted'); assert.equal(h.address.get(70000).apply_status, 'queued');
  } finally { h.restore(); }
  // A different address: proposed beside the accepted one. The owner's tap
  // is never undone and the accepted row is never retired.
  h = harness({ intakes: [sheeleyIntake({ orders: sheeleyOrder({ invoice_fulfillment: invoiceWith(null, false) }) })], addressProposals: [queuedA] });
  try {
    const counts = await at('2026-09-15T14:00:00Z', () => runProposalScan(ENV_ADDR));
    assert.equal(counts.address.proposed, 1);
    assert.equal(h.address.get(70000).status, 'accepted'); assert.equal(h.address.get(70000).apply_status, 'queued');
    assert.equal(h.address.get(70001).status, 'pending'); assert.equal(h.address.get(70001).on_file_address, null);
  } finally { h.restore(); }
  // Jarvis then writes the accepted address and the order re-syncs: the
  // pending row is re-snapshotted against the new invoice address (invoice
  // newer than its email), not retired, so the owner still decides it.
  const appliedA = { ...queuedA, apply_status: 'applied', applied_at: '2026-09-15T14:10:00Z', notified_at: '2026-09-15T14:15:00Z' };
  const pendingB = { intake_id: 70001, order_id: SHEELEY_ID, status: 'pending', proposed_text: '491 S Dean Street, Englewood, NJ 07631', on_file_address: null, on_file_source: null, on_file_structured: false, on_file_newer: false, found_at: '2026-09-15T14:00:00Z' };
  // The decided intake row (dismissed, so the scan never re-reads it) carries
  // the same order the follow-up reads, the way one order row serves both.
  const synced = sheeleyOrder({ invoice_fulfillment: invoiceWith('12 Ocean Rd, Bridgehampton, NY 11932', true, '2026-09-15T14:12:00Z') });
  const decidedOn = (o) => ({ ...sheeleyIntake({ orders: o }), status: 'dismissed' });
  h = harness({ intakes: [decidedOn(synced)], orders: [synced], addressProposals: [appliedA, pendingB] });
  try {
    const counts = await at('2026-09-15T14:20:00Z', () => runProposalScan(ENV_ADDR));
    assert.equal(counts.address.retired, 0); assert.equal(counts.address.resnapshotted, 1); assert.equal(counts.address.notified, 0);
    const b = h.address.get(70001);
    assert.equal(b.status, 'pending'); assert.equal(b.on_file_address, '12 Ocean Rd, Bridgehampton, NY 11932'); assert.equal(b.on_file_source, 'invoice');
    assert.equal(b.on_file_structured, true); assert.equal(b.on_file_newer, true); assert.equal(b.updated_at, '2026-09-15T14:20:00.000Z');
    assert.equal(h.queuePosts().length, 0);
    // Next tick: nothing moved, nothing to do.
    const again = await at('2026-09-15T14:25:00Z', () => runProposalScan(ENV_ADDR));
    assert.equal(again.address.resnapshotted, 0); assert.equal(again.address.retired, 0);
  } finally { h.restore(); }
  // The owner's own hand edit to some other address still retires it.
  const handEdited = sheeleyOrder({ invoice_fulfillment: invoiceWith('45 Main St, Southampton, NY 11968', true, '2026-09-15T14:12:00Z') });
  h = harness({ intakes: [decidedOn(handEdited)], orders: [handEdited], addressProposals: [appliedA, pendingB] });
  try {
    const counts = await at('2026-09-15T14:20:00Z', () => runProposalScan(ENV_ADDR));
    assert.equal(counts.address.retired, 1); assert.equal(counts.address.resnapshotted, 0);
    assert.equal(h.address.get(70001).status, 'superseded'); assert.equal(h.address.get(70001).decided_via, 'owner_edit');
  } finally { h.restore(); }
  pass('an accepted address waiting for Jarvis: the same address again is a repeat, a different one is proposed beside it, and once Jarvis writes the accepted one the newer row is re-snapshotted (not retired); a hand edit still retires');
}
// ── 23. The OWN_ADDRESS_DENYLIST secret, and a kept row past 30 days
{
  let h = harness({ intakes: [sheeleyIntake({ orders: sheeleyOrder({ invoice_fulfillment: invoiceWith(null, false) }) })], addressProposals: [] });
  try {
    const counts = await at('2026-09-15T14:00:00Z', () => runProposalScan({ ...ENV_ADDR, OWN_ADDRESS_DENYLIST: '12 main, 491 dean' }));
    assert.equal(counts.address.rejected, 1); assert.equal(counts.address.proposed, 0); assert.equal(h.address.size, 0); assert.equal(h.queuePosts().length, 0);
    assert.equal(h.intakes.get(70001).address_scanned_at, '2026-09-15T14:00:00.000Z');
  } finally { h.restore(); }
  // An unrelated denylist entry denies nothing.
  h = harness({ intakes: [sheeleyIntake({ orders: sheeleyOrder({ invoice_fulfillment: invoiceWith(null, false) }) })], addressProposals: [] });
  try {
    const counts = await at('2026-09-15T14:00:00Z', () => runProposalScan({ ...ENV_ADDR, OWN_ADDRESS_DENYLIST: '12 main' }));
    assert.equal(counts.address.proposed, 1);
  } finally { h.restore(); }
  // Kept 31 days ago: the 30-day repeat rule has lapsed, so it is proposed again.
  h = harness({ intakes: [sheeleyIntake({ orders: sheeleyOrder({ invoice_fulfillment: invoiceWith(null, false) }) })], addressProposals: [{ intake_id: 69999, order_id: SHEELEY_ID, status: 'kept', decided_at: '2026-08-15T12:00:00Z', proposed_text: '491 South Dean St, Englewood NJ 07631' }] });
  try {
    const counts = await at('2026-09-15T14:00:00Z', () => runProposalScan(ENV_ADDR));
    assert.equal(counts.address.proposed, 1); assert.equal(h.address.get(70001).status, 'pending');
  } finally { h.restore(); }
  pass('OWN_ADDRESS_DENYLIST from the env rejects a listed street (comma split, house plus first street word); an address kept 31 days ago is proposed again');
}
// ── 24. A repeat is the same address by the AGREE test, not the exact key
{
  // Email 1 (Aug 10) proposed the address with its ZIP and is pending with
  // Accept. Email 2 (Aug 22) quotes it without the ZIP and no geocoder
  // confirms one: a repeat. Row 1 stays pending, no Dismiss-only row
  // replaces it, no second banner.
  const withZip = { intake_id: 70000, order_id: SHEELEY_ID, status: 'pending', proposed_text: '491 S Dean Street, Englewood, NJ 07631' };
  const olderDecided = { ...sheeleyIntake({ id: 70000, created_at: '2026-08-10T09:00:00+00:00' }), status: 'dismissed' };
  const noZipEmail = sheeleyIntake({ raw_text: 'Confirming 491 S Dean Street, Englewood, NJ for Friday. Thanks!', orders: sheeleyOrder({ invoice_fulfillment: invoiceWith(null, false) }) });
  let h = harness({ intakes: [olderDecided, noZipEmail], addressProposals: [withZip] });
  try {
    const counts = await at('2026-09-15T14:00:00Z', () => runProposalScan(ENV_ADDR));
    assert.equal(counts.address.rejected, 1); assert.equal(counts.address.proposed, 0); assert.equal(h.apple.geocode, 0);
    assert.equal(h.address.get(70000).status, 'pending', 'the Accept-able row stands'); assert.ok(!h.address.has(70001), 'no Dismiss-only row beside it');
    assert.equal(h.queuePosts().length, 0); assert.equal(h.intakes.get(70001).address_scanned_at, '2026-09-15T14:00:00.000Z');
  } finally { h.restore(); }
  // The direction word dropped ("491 Dean Street"): still the same house
  // and street, still a repeat.
  h = harness({ intakes: [olderDecided, sheeleyIntake({ raw_text: 'Deliver to 491 Dean Street, Englewood, NJ 07631.', orders: sheeleyOrder({ invoice_fulfillment: invoiceWith(null, false) }) })], addressProposals: [withZip] });
  try {
    const counts = await at('2026-09-15T14:00:00Z', () => runProposalScan(ENV_ADDR));
    assert.equal(counts.address.rejected, 1); assert.equal(h.address.get(70000).status, 'pending'); assert.ok(!h.address.has(70001));
  } finally { h.restore(); }
  // Kept ten days ago with the ZIP, quoted again without it: no second row.
  h = harness({ intakes: [noZipEmail], addressProposals: [{ intake_id: 69999, order_id: SHEELEY_ID, status: 'kept', decided_at: '2026-09-05T12:00:00Z', proposed_text: '491 S Dean Street, Englewood, NJ 07631' }] });
  try {
    const counts = await at('2026-09-15T14:00:00Z', () => runProposalScan(ENV_ADDR));
    assert.equal(counts.address.rejected, 1); assert.equal(counts.address.proposed, 0); assert.ok(!h.address.has(70001)); assert.equal(h.queuePosts().length, 0);
  } finally { h.restore(); }
  // Accepted with the ZIP, quoted again without it: a repeat, the tap stands.
  h = harness({ intakes: [noZipEmail], addressProposals: [{ intake_id: 69999, order_id: SHEELEY_ID, status: 'accepted', apply_status: 'queued', proposed_text: '491 S Dean Street, Englewood, NJ 07631', decided_at: '2026-09-14T12:00:00Z' }] });
  try {
    const counts = await at('2026-09-15T14:00:00Z', () => runProposalScan(ENV_ADDR));
    assert.equal(counts.address.rejected, 1); assert.ok(!h.address.has(70001)); assert.equal(h.address.get(69999).status, 'accepted');
  } finally { h.restore(); }
  // The one exception: the pending row has NO ZIP (a Dismiss-only row) and
  // the newer email brings it. That email supersedes the row and the owner
  // gets an Accept button instead of a chat errand.
  const dismissOnly = { intake_id: 70000, order_id: SHEELEY_ID, status: 'pending', proposed_text: '491 S Dean Street, Englewood, NJ' };
  h = harness({ intakes: [olderDecided, sheeleyIntake({ orders: sheeleyOrder({ invoice_fulfillment: invoiceWith(null, false) }) })], addressProposals: [dismissOnly] });
  try {
    const counts = await at('2026-09-15T14:00:00Z', () => runProposalScan(ENV_ADDR));
    assert.equal(counts.address.proposed, 1); assert.equal(counts.address.rejected, 0);
    assert.equal(h.address.get(70000).status, 'superseded'); assert.equal(h.address.get(70000).decided_via, 'newer_email');
    assert.equal(h.address.get(70001).status, 'pending'); assert.equal(h.address.get(70001).proposed_address.postal_code, '07631');
    assert.equal(h.queuePosts().length, 1);
  } finally { h.restore(); }
  // Both without a ZIP: a repeat (nothing is gained by a second Dismiss-only row).
  h = harness({ intakes: [olderDecided, noZipEmail], addressProposals: [dismissOnly] });
  try {
    const counts = await at('2026-09-15T14:00:00Z', () => runProposalScan(ENV_ADDR));
    assert.equal(counts.address.rejected, 1); assert.equal(h.address.get(70000).status, 'pending'); assert.ok(!h.address.has(70001));
  } finally { h.restore(); }
  // A direction correction is another house, never a repeat: Englewood
  // has both N Dean St and S Dean St. The customer's "N, not South"
  // retires the S row and is proposed; against a structured invoice
  // holding S Dean it is a conflict, not a silent agree.
  const correction = sheeleyIntake({ raw_text: 'Sorry, correction: please deliver to 491 N Dean Street, Englewood, NJ 07631, not South.', orders: sheeleyOrder({ invoice_fulfillment: invoiceWith(null, false) }) });
  h = harness({ intakes: [olderDecided, correction], addressProposals: [withZip] });
  try {
    const counts = await at('2026-09-15T14:00:00Z', () => runProposalScan(ENV_ADDR));
    assert.equal(counts.address.proposed, 1); assert.equal(counts.address.rejected, 0);
    assert.equal(h.address.get(70000).status, 'superseded'); assert.equal(h.address.get(70000).decided_via, 'newer_email');
    assert.equal(h.address.get(70001).status, 'pending'); assert.equal(h.address.get(70001).proposed_text, '491 N Dean Street, Englewood, NJ 07631');
    assert.equal(h.queuePosts().length, 1);
  } finally { h.restore(); }
  h = harness({ intakes: [sheeleyIntake({ raw_text: correction.raw_text, orders: sheeleyOrder({ invoice_fulfillment: invoiceWith('491 S Dean Street, Englewood, NJ 07631', true) }) })], addressProposals: [] });
  try {
    const counts = await at('2026-09-15T14:00:00Z', () => runProposalScan(ENV_ADDR));
    assert.equal(counts.address.agree, 0); assert.equal(counts.address.proposed, 1);
    assert.equal(h.address.get(70001).on_file_address, '491 S Dean Street, Englewood, NJ 07631');
    assert.equal(h.queuePosts()[0].payload.aps.alert.body, 'A customer email gives a drop off address in Englewood, NJ; the invoice says Englewood, NJ. Open Needs you to Accept or Keep.');
  } finally { h.restore(); }
  pass('repeat by the AGREE test: the address re-quoted without its ZIP or direction word is a repeat against a pending, kept or accepted row (the Accept-able row stands, no Dismiss-only row beside it); only a pending row with no ZIP is superseded by an email that brings the ZIP; a direction correction (N for S) is another house, proposed and never a silent agree');
}

// ── 25. A time typed inside the quoted reconfirmation bullets ────────
// 2026-09-21: Allie Sugano answered our reconfirmation email by typing
// "1:15pm - 1:30pm" over "please tell us" INSIDE the quoted copy (Outlook,
// intake 68785). The extractor strips the quote, so the scan sent the
// "Coordinator email" banner instead of a Time change? proposal. Now an
// email on a sent reconfirmation's thread (sent_conversation_id, or the
// reply scan's reply_intake_id stamp) is read with the answers first.
// Phones and emails are 555 numbers and example.invalid; the shape is
// the poller's, byte for byte. The full helper is pinned in
// test-quoted-answers.mjs.
{
  const SUGANO_ID = '99999999-9999-4999-8999-999999999999';
  const sugano = { id: SUGANO_ID, client_name: 'Allie Sugano', client_email: 'allie@example.invalid', market: 'ny', venue: null, delivery_notes: null, delivery_at_utc: '2026-09-23T00:00:00+00:00', stage: 'paid_full', delivery_request: null, invoice_fulfillment: null, external_invoice_id: null, event_start_at: null };
  const sentBody = ['Hi Allie,', '', 'Just sending the final details for reconfirmation. Two things we still need: what time our driver should arrive and who they should call on site. Once we have those two items, we are set.', '',
    '• Delivery: Wednesday, September 23, arrival time: please tell us', '• Drop off: 24 Spring St., New York, NY, 10012, US', '• Count: 40 coconuts', '• Cracking: straw hole pre-cracked, ready for straws', '• On site contact: please send a name and cell', '• Your contact: Sidd, 732.555.0199', '',
    'We brand and box on Tuesday, September 22, the day before, so changes need to reach us today.', '', 'Thanks so much,', 'Sidd', 'Hamptons Coconuts'].join('\n');
  const raw = 'Hi Sidd!\r\n\r\nAdded the details below! Thank you \r\n\r\n[photo]<https://example.invalid/>\r\nAllie Sugano\r\nDirector, Retail & Brand Activation\r\n[icon] + 1 (949) 555-0123<tel:714.555.0167>\r\n\r\nFrom: Sidd Saxena <sidd@hamptonscoconuts.com>\r\nDate: Sunday, September 20, 2026 at 12:02 PM\r\nTo: Allie Sugano <allie@example.invalid>\r\nSubject: Your coconuts for Wednesday, September 23: quick check\r\n\r\n\r\nHi Allie,\r\n\r\n\r\n\r\nJust sending the final details for reconfirmation. Two things we still need: what time our driver should arrive and who they should call on site. Once we have those two items, we are set.\r\n\r\n\r\n\r\n  *\r\nDelivery: Wednesday, September 23, arrival time: 1:15pm - 1:30pm\r\n  *   Drop off: 24 Spring St., New York, NY, 10012, US\r\n  *   Count: 40 coconuts\r\n  *   Cracking: straw hole pre-cracked, ready for straws\r\n  *\r\nOn site contact: Allie, 9495550123\r\n  *   Your contact: Sidd, 732.555.0199\r\n\r\n\r\n\r\nWe brand and box on Tuesday, September 22, the day before, so changes need to reach us today.\r\n\r\n\r\n\r\nThanks so much,\r\n\r\nSidd\r\n\r\nHamptons Coconuts';
  const suganoIntake = (extra = {}) => ({ id: 68785, subject: 'Re: Your coconuts for Wednesday, September 23: quick check', raw_text: raw, order_id: SUGANO_ID, conversation_id: 'conv-sugano', created_at: '2026-09-21T13:31:00+00:00', error_detail: null, orders: sugano, ...extra });
  const sentRow = (extra = {}) => ({ id: 2, order_id: SUGANO_ID, status: 'changed', sent_conversation_id: 'conv-sugano', reply_intake_id: null, body: sentBody, ...extra });
  const ENV_RECONFIRM = { ...ENV, RECONFIRM_MODE: 'auto' };
  const NOW = '2026-09-21T13:35:00Z';
  // The thread match: one proposal, 1:15 PM, the answered line as evidence, one owner and one manager banner.
  let h = harness({ intakes: [suganoIntake()], reconfirmations: [sentRow()] });
  try {
    const counts = await at(NOW, () => runProposalScan(ENV_RECONFIRM));
    assert.equal(counts.proposed, 1); assert.equal(counts.noTime, 0);
    const p = h.proposals.get(68785);
    assert.equal(p.order_id, SUGANO_ID); assert.equal(p.proposed_label, '1:15 PM');
    assert.equal(p.proposed_arrive_at, '2026-09-23T17:15:00.000Z');
    assert.equal(p.evidence_line, 'Delivery: Wednesday, September 23, arrival time: 1:15pm - 1:30pm'); assert.equal(p.evidence_where, 'body');
    assert.equal(p.on_file_window, null);
    const posts = h.queuePosts();
    assert.equal(posts.length, 2);
    const owner = posts.find((q) => q.payload.tokens.includes('owner-token'));
    assert.equal(owner.payload.aps.alert.title, 'Time change? Sugano, Wed Sep 23');
    assert.equal(owner.payload.aps.alert.body, 'A coordinator email says arrive 1:15 PM (email: "Delivery: Wednesday, September 23, arrival time: 1:15pm - 1:30pm"). On file: no clock time. Open Needs you to Accept or Keep. Until you decide, the alarm uses 1:15 PM.');
    for (const q of posts) { assert.ok(!q.payload.aps.alert.body.includes('555'), 'no phone in a banner'); assert.equal(q.payload.body.kind, 'time_change'); }
    assert.equal(h.intakes.get(68785).error_detail, null, 'never marked linked_no_time');
    // One bounded read of the sent rows, by the orders in hand, with the body.
    const read = h.calls.find((c) => c.url.includes('/order_reconfirmations?'));
    assert.ok(read.url.includes('select=order_id,sent_conversation_id,reply_intake_id,body&status=in.(sent,confirmed,changed)&order_id=in.(' + SUGANO_ID + ')'), read.url);
    assert.equal(h.calls.filter((c) => c.url.includes('/order_reconfirmations?')).length, 1);
  } finally { h.restore(); }
  // The reply scan's own link (reply_intake_id) matches too when the
  // intake carries no conversation id.
  h = harness({ intakes: [suganoIntake({ conversation_id: null })], reconfirmations: [sentRow({ reply_intake_id: 68785 })] });
  try {
    const counts = await at(NOW, () => runProposalScan(ENV_RECONFIRM));
    assert.equal(counts.proposed, 1); assert.equal(h.proposals.get(68785).proposed_label, '1:15 PM');
  } finally { h.restore(); }
  // The bug as it stood, and the narrow rule: the same email with no sent
  // row on its thread (another conversation, or none at all) is read as
  // before, "Coordinator email", no proposal; with the mode off the sent
  // rows are never read at all.
  h = harness({ intakes: [suganoIntake()], reconfirmations: [sentRow({ sent_conversation_id: 'conv-other' })] });
  try {
    const counts = await at(NOW, () => runProposalScan(ENV_RECONFIRM));
    assert.equal(counts.proposed, 0); assert.equal(counts.noTime, 1); assert.ok(!h.proposals.has(68785));
    assert.equal(h.queuePosts().length, 1); assert.equal(h.queuePosts()[0].payload.aps.alert.title, 'Coordinator email: Sugano, Wed Sep 23');
    assert.ok(String(h.intakes.get(68785).error_detail).startsWith('linked_no_time notified '));
  } finally { h.restore(); }
  h = harness({ intakes: [suganoIntake()], reconfirmations: [] });
  try {
    const counts = await at(NOW, () => runProposalScan(ENV_RECONFIRM));
    assert.equal(counts.proposed, 0); assert.equal(counts.noTime, 1);
  } finally { h.restore(); }
  h = harness({ intakes: [suganoIntake()], reconfirmations: [sentRow()] });
  try {
    const counts = await at(NOW, () => runProposalScan(ENV));
    assert.equal(counts.proposed, 0); assert.equal(counts.noTime, 1);
    assert.equal(h.calls.filter((c) => c.url.includes('/order_reconfirmations?')).length, 0, 'mode off: the sent rows are never read');
  } finally { h.restore(); }
  // An untouched quote on the thread proposes nothing: our own "please
  // tell us" and a 3:30 PM we printed ourselves are never the answer.
  const untouched = raw.replace('  *\r\nDelivery: Wednesday, September 23, arrival time: 1:15pm - 1:30pm', '  *   Delivery: Wednesday, September 23, arrival time: please tell us').replace('  *\r\nOn site contact: Allie, 9495550123', '  *   On site contact: please send a name and cell');
  h = harness({ intakes: [suganoIntake({ raw_text: untouched })], reconfirmations: [sentRow()] });
  try {
    const counts = await at(NOW, () => runProposalScan(ENV_RECONFIRM));
    assert.equal(counts.proposed, 0); assert.equal(counts.noTime, 1); assert.ok(!h.proposals.has(68785));
  } finally { h.restore(); }
  pass('Allie (2026-09-21): a time typed over "please tell us" inside the quoted bullets makes the 1:15 PM Time change? proposal with the answered line as evidence (thread match, or the reply link), one read of the sent rows; no sent row on the thread, mode off, or an untouched quote reads as before (Coordinator email, no proposal)');

  // ── 26. The reply's own words beat the quoted answers ──────────────
  // Review finding (2026-09-21): the answered lines went ahead of the
  // email for every reconfirmation thread, so a second reply, which
  // quotes the first one with its edited bullets under the customer's
  // own header, proposed the OLD 1:15 PM again: over a fresh "2pm
  // instead?" (both rank 2, the earlier clock wins) and even under
  // "Perfect, thank you!" (retiring the pending 1:15 PM row and pushing
  // the banner twice). Now the email is read on its own first and the
  // answers only when it has no time of its own; and a header that is
  // not ours above ours answers nothing (test-quoted-answers.mjs 11).
  // A fresh time at the top of the FIRST reply, beside an answer typed in
  // the bullet, both lines at the same rank ("delivery" alone, no
  // "coconut"): the top wins (before, 1:15 PM did on the earliest tie:
  // the answer-first text reads [1:15 PM, 2:00 PM]).
  const topAndBullet = raw.replace('Added the details below! Thank you ', 'Actually, can we do 2pm for the delivery? Details below too.');
  assert.deepEqual(extractArrivalTimes(reconfirmAnswerFirstText(topAndBullet, sentBody)).map((t) => t.label), ['1:15 PM', '2:00 PM'], 'the tie the guard exists for');
  h = harness({ intakes: [suganoIntake({ raw_text: topAndBullet })], reconfirmations: [sentRow()] });
  try {
    const counts = await at(NOW, () => runProposalScan(ENV_RECONFIRM));
    assert.equal(counts.proposed, 1); assert.equal(h.proposals.get(68785).proposed_label, '2:00 PM');
    assert.equal(h.proposals.get(68785).evidence_line, 'Actually, can we do 2pm for the delivery? Details below too.');
  } finally { h.restore(); }
  // The second reply, Outlook: her From: block over the first reply. The
  // first reply's proposal (1:15 PM) is pending and its intake decided.
  const pending115 = () => ({ intake_id: 68785, order_id: SUGANO_ID, proposed_arrive_at: '2026-09-23T17:15:00+00:00', proposed_label: '1:15 PM', status: 'pending' });
  const second = (top, viaGmail) => viaGmail
    ? top + '\r\n\r\nOn Mon, Sep 21, 2026 at 9:31 AM Allie Sugano <allie@example.invalid> wrote:\r\n' + raw.split('\r\n').map((l) => '> ' + l).join('\r\n')
    : [top, '', 'From: Allie Sugano <allie@example.invalid>', 'Sent: Monday, September 21, 2026 9:31 AM', 'To: Sidd Saxena <sidd@hamptonscoconuts.com>', 'Subject: Re: Your coconuts for Wednesday, September 23: quick check', '', raw].join('\r\n');
  const LATER = '2026-09-21T13:45:00Z';
  h = harness({
    intakes: [{ ...suganoIntake(), status: 'dismissed' }, suganoIntake({ id: 68786, raw_text: second('Sorry, can the delivery be 2pm instead?', false), created_at: '2026-09-21T13:41:00+00:00' })],
    proposals: [pending115()], reconfirmations: [sentRow()],
  });
  try {
    const counts = await at(LATER, () => runProposalScan(ENV_RECONFIRM));
    assert.equal(counts.proposed, 1); assert.equal(counts.noTime, 0);
    assert.equal(h.proposals.get(68786).proposed_label, '2:00 PM', 'the fresh 2pm, never the quoted 1:15');
    assert.equal(h.proposals.get(68786).evidence_line, 'Sorry, can the delivery be 2pm instead?');
    assert.equal(h.proposals.get(68785).status, 'superseded'); assert.equal(h.proposals.get(68785).decided_via, 'newer_email');
    const owner = h.queuePosts().find((q) => q.payload.tokens.includes('owner-token'));
    assert.ok(owner.payload.aps.alert.body.startsWith('A coordinator email says arrive 2:00 PM'), owner.payload.aps.alert.body);
  } finally { h.restore(); }
  // The second reply, Gmail: "Perfect, thank you!" over the first reply
  // (in the live chain the reply scan confirms and dismisses it first;
  // here it reaches the scan as a linked email). Nothing is re-proposed,
  // the pending 1:15 PM row stands, and no Time change? banner goes out.
  h = harness({
    intakes: [{ ...suganoIntake(), status: 'dismissed' }, suganoIntake({ id: 68786, raw_text: second('Perfect, thank you!', true), created_at: '2026-09-21T13:41:00+00:00' })],
    proposals: [pending115()], reconfirmations: [sentRow()],
  });
  try {
    const counts = await at(LATER, () => runProposalScan(ENV_RECONFIRM));
    assert.equal(counts.proposed, 0); assert.ok(!h.proposals.has(68786), 'nothing re-proposed');
    assert.equal(h.proposals.get(68785).status, 'pending', 'the first reply\'s proposal stands');
    assert.ok(h.queuePosts().every((q) => q.payload.body.kind !== 'time_change'), 'no second Time change? banner');
  } finally { h.restore(); }
  pass('the reply\'s own words first: a 2pm at the top beats a 1:15 typed in the bullet; a second reply on the thread (Outlook From: block, Gmail wrote: line) never re-proposes the first reply\'s 1:15 PM: "2pm instead" proposes 2:00 PM and retires the 1:15 row as newer_email, "Perfect, thank you!" proposes nothing and leaves it pending');
}

console.log(`\nPASS: ${passed} proposal checks. No network, no database, no phone.`);

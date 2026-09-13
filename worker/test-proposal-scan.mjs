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
import { runProposalScan, runStillWaitingScan, runDeparturePlanScan, proposalTexts, linkedNoTimeReason } from './worker.js';

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
function harness(opts = {}) {
  const calls = [];
  const proposals = new Map((opts.proposals || []).map((p) => [Number(p.intake_id), { ...p }]));
  const intakes = new Map((opts.intakes || []).map((r) => [Number(r.id), { ...r }]));
  const plans = new Map((opts.plans || []).map((p) => [p.order_id, { ...p }]));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (urlValue, options = {}) => {
    const url = String(urlValue);
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, method, body });
    if (url.startsWith('https://maps-api.apple.com')) return reply(404, {});
    if (!url.startsWith(SB + '/rest/v1/')) throw new Error('unexpected offline fetch: ' + method + ' ' + url);
    const path = url.slice((SB + '/rest/v1/').length);
    if (method === 'GET' && path.startsWith('intake_messages?')) {
      return reply(200, [...intakes.values()].filter((r) => r.order_id && (!r.status || r.status === 'pending_review')));
    }
    if (method === 'PATCH' && path.startsWith('intake_messages?id=eq.')) {
      const id = Number(/id=eq\.(\d+)/.exec(path)[1]);
      if (intakes.has(id)) Object.assign(intakes.get(id), body);
      return reply(200, []);
    }
    if (method === 'GET' && path.startsWith('order_time_proposals?')) {
      if (opts.proposalsTableMissing) return reply(404, { code: 'PGRST205' });
      let rows = [...proposals.values()];
      const st = /status=eq\.([a-z]+)/.exec(path);
      if (st) rows = rows.filter((p) => p.status === st[1]);
      if (path.includes('orders!inner')) rows = rows.map((p) => ({ ...p, orders: ORDER }));
      return reply(200, rows);
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
    throw new Error('unexpected offline fetch: ' + method + ' ' + url);
  };
  return {
    calls, proposals, intakes, plans,
    queuePosts: () => calls.filter((c) => c.method === 'POST' && c.url === SB + '/rest/v1/push_queue').map((c) => c.body),
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

console.log(`\nPASS: ${passed} proposal checks. No network, no database, no phone.`);

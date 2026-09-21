// Tests for the artwork-proposal wiring in worker.js (migration 048,
// PHASE3-ARTWORK-PLAN-2026-09-21.md sections 2, 5b and 7): the
// ARTWORK_PROPOSALS switch, runArtworkFollowUps inside runProposalScan
// (one owner-only "Artwork?" banner per email, the retire step) and the
// two banner texts. Fake network throughout; nothing here fetches bytes,
// renders or writes artwork, and no file name ever reaches a banner.
//
// Run it with:  node worker/test-artwork-proposals.mjs

import assert from 'node:assert/strict';
import { runProposalScan, runArtworkFollowUps, proposalTexts, artworkProposalsOn } from './worker.js';

let passed = 0;
const pass = (m) => { passed++; console.log('PASS: ' + m); };
const SB = 'https://example.invalid';
const T = (iso) => Date.parse(iso);
const ENV = { SUPABASE_URL: SB, SUPABASE_SERVICE_KEY: 'not-a-real-key' };
const ENV_ON = { ...ENV, ARTWORK_PROPOSALS: 'on' };
const ROSTER = [
  { email: 'owner@example.invalid', name: 'Sidd', role: 'owner', market: 'ny', active: true },
  { email: 'ny.manager@example.invalid', name: 'Jayden Martin', role: 'manager', market: 'ny', active: true },
  { email: 'crew@example.invalid', name: 'Hashim Nadir', role: 'team', market: 'ny', active: true },
];
const TOKENS = { 'owner@example.invalid': 'owner-token', 'ny.manager@example.invalid': 'manager-token', 'crew@example.invalid': 'crew-token' };
const ORDER_ID = '30000000-0000-4000-8000-000000000001';
const ORDER = {
  id: ORDER_ID, client_name: 'Alison Sheeley', market: 'ny', venue: '491 S Dean Street, Englewood, NJ 07631',
  delivery_at_utc: '2026-09-18T00:00:00+00:00', event_start_at: null, stage: 'paid_full', external_invoice_id: '3449', logo_asset: null,
};
const FILE_NAME = 'SIENNA BEACH V1 BLUE WITH PINK.ps';
// A proposal row the way the droplet pass inserts it (the columns the
// worker reads), with the snapshots matching ORDER.
let seq = 0;
const row = (extra = {}) => {
  seq++;
  return {
    id: 100 + seq, intake_id: 68785, order_id: ORDER_ID, file_name: FILE_NAME, verdict: 'ready', sender_kind: 'customer',
    card_files_at_scan: 0, card_checked_at_snapshot: null, invoice_id_snapshot: '3449', delivery_day_snapshot: '2026-09-18',
    found_at: '2026-09-15T17:0' + (seq % 10) + ':00.000Z', status: 'pending', notified_at: null, decided_at: null, decided_via: null, updated_at: null, ...extra,
  };
};
function reply(status, data = null) {
  return { ok: status >= 200 && status < 300, status, async json() { return data; }, async text() { return data == null ? '' : JSON.stringify(data); } };
}
// The intake row the pass has finished (artwork_scanned_at stamped at the
// end of the email), the normal case.
const INTAKE_ID = 68785;
const INTAKES = { [INTAKE_ID]: { artwork_scanned_at: '2026-09-15T17:06:00.000Z' } };
// The fake world. opts: proposals (order_artwork_proposals rows; the table
// answers 404 until the option is given), orders (each row's orders!inner
// embed, by id; ORDER by default), intakes (each row's
// intake_messages!inner embed, by intake id; INTAKES by default, so every
// email is stamped unless a test says otherwise), tokens (push_tokens by
// email).
function harness(opts = {}) {
  const calls = [];
  const proposals = new Map((opts.proposals || []).map((p) => [Number(p.id), { ...p }]));
  const ordersById = new Map([ORDER, ...(opts.orders || [])].map((o) => [o.id, o]));
  const intakesById = opts.intakes || INTAKES;
  const tokens = opts.tokens || TOKENS;
  const filtered = (rows, path) => {
    let out = rows;
    for (const [, key, val] of path.matchAll(/(?:\?|&)(status|notified_at|order_id|intake_id|id)=([^&]+)/g)) {
      const v = decodeURIComponent(val);
      if (v === 'is.null') out = out.filter((p) => p[key] == null);
      else if (v === 'not.is.null') out = out.filter((p) => p[key] != null);
      else if (v.startsWith('eq.')) out = out.filter((p) => String(p[key]) === v.slice(3));
      else if (v.startsWith('in.(') && v.endsWith(')')) { const set = new Set(v.slice(4, -1).split(',')); out = out.filter((p) => set.has(String(p[key]))); }
    }
    if (/order=found_at\.asc/.test(path)) out = out.slice().sort((a, b) => (a.found_at < b.found_at ? -1 : a.found_at > b.found_at ? 1 : 0));
    const limit = /limit=(\d+)/.exec(path);
    if (limit) out = out.slice(0, Number(limit[1]));
    return out;
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (urlValue, options = {}) => {
    const url = String(urlValue);
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, method, body });
    if (!url.startsWith(SB + '/rest/v1/')) throw new Error('unexpected offline fetch: ' + method + ' ' + url);
    const path = url.slice((SB + '/rest/v1/').length);
    // No intake rows this tick: the time and address branches have nothing to read.
    if (method === 'GET' && path.startsWith('intake_messages?')) return reply(200, []);
    if (path.startsWith('order_artwork_proposals')) {
      if (!opts.proposals) return reply(404, { code: 'PGRST205', message: 'Could not find the table' });
      if (method === 'GET') {
        let rows = filtered([...proposals.values()], path);
        if (path.includes('orders!inner')) rows = rows.filter((p) => ordersById.has(p.order_id)).map((p) => ({ ...p, orders: ordersById.get(p.order_id) }));
        if (path.includes('intake_messages!inner')) rows = rows.filter((p) => intakesById[p.intake_id]).map((p) => ({ ...p, intake_messages: { ...intakesById[p.intake_id] } }));
        return reply(200, rows);
      }
      if (method === 'PATCH') {
        for (const p of filtered([...proposals.values()], path)) Object.assign(p, body);
        return reply(200, []);
      }
    }
    if (method === 'GET' && path.startsWith('shifts?')) return reply(200, []);
    if (method === 'GET' && path.startsWith('field_workers?')) return reply(200, ROSTER);
    if (method === 'GET' && path.startsWith('push_tokens?')) {
      const list = decodeURIComponent(path.split('email=in.(')[1].split(')')[0]);
      const wanted = list.split(',').map((s) => s.replace(/"/g, '').trim().toLowerCase());
      return reply(200, wanted.filter((e) => tokens[e]).map((e) => ({ email: e, apns_token: tokens[e] })));
    }
    if (method === 'POST' && path === 'push_queue') return reply(201, null);
    if (method === 'GET' && path.startsWith('push_queue?id=eq.')) return reply(200, []);
    throw new Error('unexpected offline fetch: ' + method + ' ' + url);
  };
  return {
    calls, proposals,
    queuePosts: () => calls.filter((c) => c.method === 'POST' && c.url === SB + '/rest/v1/push_queue').map((c) => c.body),
    artworkCalls: () => calls.filter((c) => c.url.startsWith(SB + '/rest/v1/order_artwork_proposals')),
    patches: () => calls.filter((c) => c.method === 'PATCH' && c.url.startsWith(SB + '/rest/v1/order_artwork_proposals')),
    restore: () => { globalThis.fetch = originalFetch; },
  };
}
const realNow = Date.now;
async function at(iso, fn) { Date.now = () => T(iso); try { return await fn(); } finally { Date.now = realNow; } }
const TICK = '2026-09-15T17:20:00Z';
// Words that must never reach a banner or its data payload.
const forbidden = (text) => {
  assert.ok(!text.includes('SIENNA') && !text.includes('.ps') && !text.includes(FILE_NAME), 'no file name: ' + text);
  assert.ok(!/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(text), 'no email address: ' + text);
  assert.ok(!/\d{3}[\s.-]\d{3}[\s.-]\d{4}/.test(text), 'no phone: ' + text);
  assert.ok(!text.includes('$') && !text.includes('Dean Street') && !text.includes('Englewood'), 'no dollar, no street: ' + text);
};

// ── 1. The switch ───────────────────────────────────────────────────
{
  assert.equal(artworkProposalsOn({}), false);
  assert.equal(artworkProposalsOn({ ARTWORK_PROPOSALS: 'on' }), true);
  assert.equal(artworkProposalsOn({ ARTWORK_PROPOSALS: 'ON' }), true);
  assert.equal(artworkProposalsOn({ ARTWORK_PROPOSALS: 'yes' }), false);
  assert.equal(artworkProposalsOn({ ARTWORK_PROPOSALS: '' }), false);
  assert.equal(artworkProposalsOn(null), false);
  // Switch off: the scan never touches the artwork table, whatever it holds.
  const h = harness({ proposals: [row()] });
  try {
    const counts = await at(TICK, () => runProposalScan(ENV));
    assert.equal(counts.artwork, null);
    assert.equal(h.artworkCalls().length, 0, 'zero artwork reads with the switch off');
    assert.equal(h.queuePosts().length, 0);
    assert.equal(h.proposals.get(101).notified_at, null);
  } finally { h.restore(); }
  pass('ARTWORK_PROPOSALS: only the word on (any case) enables; off means zero artwork reads, no banner, no stamp, counts.artwork null');
}
// ── 2. Two pending rows on one email: one banner, both stamped ──────
{
  const h = harness({ proposals: [row(), row({ file_name: 'SIENNA BEACH V1 BACK.ps' })] });
  try {
    const counts = await at(TICK, () => runProposalScan(ENV_ON));
    assert.deepEqual(counts.artwork, { notified: 1, deferred: 0, retired: 0, failed: 0 });
    const posts = h.queuePosts();
    assert.equal(posts.length, 1, 'one email is one banner');
    const q = posts[0];
    assert.equal(q.payload.aps.alert.title, 'Artwork? Sheeley, Fri Sep 18');
    assert.equal(q.payload.aps.alert.body, 'A customer email carries 2 artwork files. Nothing is on the card yet. Open Needs you to look at them and choose.');
    assert.deepEqual(q.payload.tokens, ['owner-token'], 'owner only: never a manager, never crew');
    assert.equal(q.payload.headers.collapse_id, 'art-68785');
    assert.equal(q.payload.aps['thread-id'], 'prop-68785', 'threads with the same email\'s Time change? or Address? banner');
    assert.equal(q.payload.body.kind, 'artwork_proposed');
    assert.equal(q.payload.body.intake_id, 68785);
    assert.deepEqual(q.payload.body.proposal_ids, [102, 103]);
    assert.equal(q.payload.body.order_id, ORDER_ID);
    assert.equal(q.payload.body.day, '2026-09-18');
    assert.equal(q.payload.telegram_text, null);
    assert.deepEqual(q.payload.fallback_chat_ids, []);
    forbidden(JSON.stringify(q));
    for (const id of [102, 103]) {
      assert.equal(h.proposals.get(id).notified_at, '2026-09-15T17:20:00.000Z', 'row ' + id + ' stamped');
      assert.equal(h.proposals.get(id).status, 'pending', 'a banner is not a decision');
    }
    const patch = h.patches();
    assert.equal(patch.length, 1);
    assert.ok(patch[0].url.endsWith('order_artwork_proposals?id=in.(102,103)&notified_at=is.null'), 'exactly the pushed rows are stamped: ' + patch[0].url);
    assert.deepEqual(patch[0].body, { notified_at: '2026-09-15T17:20:00.000Z', updated_at: '2026-09-15T17:20:00.000Z' });
    // Next tick: notified rows are never pushed twice.
    const again = await at('2026-09-15T17:25:00Z', () => runProposalScan(ENV_ON));
    assert.deepEqual(again.artwork, { notified: 0, deferred: 0, retired: 0, failed: 0 });
    assert.equal(h.queuePosts().length, 1);
    assert.equal(h.patches().length, 1);
  } finally { h.restore(); }
  pass('two pending rows on one email: one owner-only banner with the exact words, collapse art-<intake>, thread prop-<intake>, data = intake id and proposal ids only, both rows stamped by one guarded PATCH on their ids; the next tick pushes nothing');
}
// ── 2b. The pass is still working the email: the banner waits ───────
{
  // The pass renders one file per pass and stamps artwork_scanned_at at the
  // end of the email, so a front and a back land a minute apart. A tick
  // between them must not push "carries 1 artwork file" and then swallow
  // the second file's push on the stable queue id while stamping its row.
  const unstamped = { [INTAKE_ID]: { artwork_scanned_at: null } };
  const h = harness({ proposals: [row({ id: 301, found_at: '2026-09-15T17:18:00.000Z' })], intakes: unstamped });
  try {
    // Tick 1: one row, the email unstamped: deferred, nothing pushed, nothing stamped.
    const first = await at(TICK, () => runProposalScan(ENV_ON));
    assert.deepEqual(first.artwork, { notified: 0, deferred: 1, retired: 0, failed: 0 });
    assert.equal(h.queuePosts().length, 0, 'no banner while the pass is still working the email');
    assert.equal(h.patches().length, 0);
    assert.equal(h.proposals.get(301).notified_at, null);
    const read = h.artworkCalls()[0].url;
    assert.ok(read.includes('intake_messages!inner(artwork_scanned_at)'), 'the fresh read embeds the stamp: ' + read);
    // The second file lands and the pass stamps the email.
    h.proposals.set(302, row({ id: 302, found_at: '2026-09-15T17:19:00.000Z' }));
    unstamped[INTAKE_ID].artwork_scanned_at = '2026-09-15T17:19:30.000Z';
    // Tick 2: one banner with the right count, both rows stamped by id.
    const second = await at('2026-09-15T17:25:00Z', () => runProposalScan(ENV_ON));
    assert.deepEqual(second.artwork, { notified: 1, deferred: 0, retired: 0, failed: 0 });
    const posts = h.queuePosts();
    assert.equal(posts.length, 1);
    assert.equal(posts[0].payload.aps.alert.body, 'A customer email carries 2 artwork files. Nothing is on the card yet. Open Needs you to look at them and choose.');
    assert.deepEqual(posts[0].payload.body.proposal_ids, [301, 302]);
    assert.equal(h.patches().length, 1);
    assert.ok(h.patches()[0].url.endsWith('?id=in.(301,302)&notified_at=is.null'), h.patches()[0].url);
    for (const id of [301, 302]) assert.equal(h.proposals.get(id).notified_at, '2026-09-15T17:25:00.000Z');
    // Tick 3: nothing left.
    const third = await at('2026-09-15T17:30:00Z', () => runProposalScan(ENV_ON));
    assert.deepEqual(third.artwork, { notified: 0, deferred: 0, retired: 0, failed: 0 });
    assert.equal(h.queuePosts().length, 1);
  } finally { h.restore(); }
  pass('an email the pass has not stamped yet is deferred (counted, no banner, no stamp); once stamped, one banner carries every file with the right count and stamps exactly those rows');
}
// ── 2c. A stuck email still gets its banner; a late row gets its own ──
{
  // An upload that keeps failing leaves the email unstamped for good. After
  // 30 minutes the banner goes with the rows in hand; a row that lands after
  // that gets a push of its own (a fresh queue id from its own ids) and the
  // first push is never repeated.
  const unstamped = { [INTAKE_ID]: { artwork_scanned_at: null } };
  const h = harness({ proposals: [row({ id: 401, found_at: '2026-09-15T16:49:00.000Z' })], intakes: unstamped });
  try {
    // 29 minutes old: still waiting.
    const early = await at('2026-09-15T17:18:00Z', () => runProposalScan(ENV_ON));
    assert.deepEqual(early.artwork, { notified: 0, deferred: 1, retired: 0, failed: 0 });
    assert.equal(h.queuePosts().length, 0);
    // 31 minutes old: the banner goes with what is there.
    const late = await at('2026-09-15T17:20:00Z', () => runProposalScan(ENV_ON));
    assert.deepEqual(late.artwork, { notified: 1, deferred: 0, retired: 0, failed: 0 });
    assert.equal(h.queuePosts().length, 1);
    assert.equal(h.queuePosts()[0].payload.aps.alert.body, 'A customer email carries 1 artwork file. Nothing is on the card yet. Open Needs you to look at it and tap Use it or Not this one.');
    assert.deepEqual(h.queuePosts()[0].payload.body.proposal_ids, [401]);
    assert.equal(h.proposals.get(401).notified_at, '2026-09-15T17:20:00.000Z');
    const firstQueueId = h.queuePosts()[0].id;
    // A second file lands later (still unstamped): its own push, its own queue id, only it is stamped.
    h.proposals.set(402, row({ id: 402, found_at: '2026-09-15T17:21:00.000Z' }));
    const again = await at('2026-09-15T17:25:00Z', () => runProposalScan(ENV_ON));
    assert.deepEqual(again.artwork, { notified: 0, deferred: 1, retired: 0, failed: 0 }, 'the late row waits its own 30 minutes first');
    const much = await at('2026-09-15T17:52:00Z', () => runProposalScan(ENV_ON));
    assert.deepEqual(much.artwork, { notified: 1, deferred: 0, retired: 0, failed: 0 });
    assert.equal(h.queuePosts().length, 2);
    assert.notEqual(h.queuePosts()[1].id, firstQueueId, 'a later batch never reuses the first queue id (ignore-duplicates would swallow it)');
    assert.deepEqual(h.queuePosts()[1].payload.body.proposal_ids, [402]);
    assert.equal(h.queuePosts()[1].payload.headers.collapse_id, 'art-68785', 'same collapse id: the newer banner replaces the older on the lock screen');
    assert.ok(h.patches()[1].url.endsWith('?id=in.(402)&notified_at=is.null'), h.patches()[1].url);
    assert.equal(h.proposals.get(401).notified_at, '2026-09-15T17:20:00.000Z', 'the first row keeps its stamp');
    assert.equal(h.proposals.get(402).notified_at, '2026-09-15T17:52:00.000Z');
  } finally { h.restore(); }
  pass('an email unstamped for 30 minutes gets its banner with the rows in hand; a row that lands after that gets its own push under a new queue id and only it is stamped');
}
// ── 3. The banner variants ──────────────────────────────────────────
{
  // One file, empty card.
  let h = harness({ proposals: [row()] });
  try {
    await at(TICK, () => runProposalScan(ENV_ON));
    assert.equal(h.queuePosts()[0].payload.aps.alert.body, 'A customer email carries 1 artwork file. Nothing is on the card yet. Open Needs you to look at it and tap Use it or Not this one.');
  } finally { h.restore(); }
  // One new file, the card already has one.
  h = harness({ proposals: [row({ card_files_at_scan: 1, card_checked_at_snapshot: '2026-09-17T20:00:00.000Z' })], orders: [{ ...ORDER, logo_asset: { status: 'received', checked_at: '2026-09-17T20:00:00.000Z', files: [{ file_name: 'logo-v1.png' }] } }] });
  try {
    await at(TICK, () => runProposalScan(ENV_ON));
    const body = h.queuePosts()[0].payload.aps.alert.body;
    assert.equal(body, 'A customer email carries 1 new artwork file. The card already has 1 file. Open Needs you to compare them.');
    assert.ok(!body.includes('logo-v1'), 'the card\'s file name stays off the banner too');
  } finally { h.restore(); }
  // Three new files beside two on the card.
  h = harness({ proposals: [row({ card_files_at_scan: 2, card_checked_at_snapshot: 'c2' }), row({ card_files_at_scan: 2, card_checked_at_snapshot: 'c2' }), row({ card_files_at_scan: 2, card_checked_at_snapshot: 'c2' })], orders: [{ ...ORDER, logo_asset: { checked_at: 'c2', files: [{}, {}] } }] });
  try {
    await at(TICK, () => runProposalScan(ENV_ON));
    assert.equal(h.queuePosts().length, 1);
    assert.equal(h.queuePosts()[0].payload.aps.alert.body, 'A customer email carries 3 new artwork files. The card already has 2 files. Open Needs you to compare them.');
    assert.equal(h.queuePosts()[0].payload.body.proposal_ids.length, 3);
  } finally { h.restore(); }
  // Forwarded from our own mailbox.
  h = harness({ proposals: [row({ sender_kind: 'own' })] });
  try {
    await at(TICK, () => runProposalScan(ENV_ON));
    assert.equal(h.queuePosts()[0].payload.aps.alert.body, 'A file forwarded from our own mailbox carries 1 artwork file. Nothing is on the card yet. Open Needs you to look at it and tap Use it or Not this one.');
    assert.equal(h.queuePosts()[0].payload.aps.alert.title, 'Artwork? Sheeley, Fri Sep 18');
  } finally { h.restore(); }
  // An SVG (no preview) still counts as a saved file.
  h = harness({ proposals: [row({ verdict: 'no_preview', file_name: 'logo.svg' })] });
  try {
    await at(TICK, () => runProposalScan(ENV_ON));
    assert.equal(h.queuePosts()[0].payload.body.kind, 'artwork_proposed');
    assert.equal(h.queuePosts()[0].payload.aps.alert.body, 'A customer email carries 1 artwork file. Nothing is on the card yet. Open Needs you to look at it and tap Use it or Not this one.');
  } finally { h.restore(); }
  pass('banner variants: one file, several files, a card that already has files (count, never a name), a forward from our own mailbox, a no_preview file');
}
// ── 4. Nothing saved: the failed words ──────────────────────────────
{
  let h = harness({ proposals: [row({ verdict: 'too_large' })] });
  try {
    const counts = await at(TICK, () => runProposalScan(ENV_ON));
    assert.deepEqual(counts.artwork, { notified: 1, deferred: 0, retired: 0, failed: 0 });
    const q = h.queuePosts()[0];
    assert.equal(q.payload.aps.alert.title, 'Artwork not saved: Sheeley, Fri Sep 18');
    assert.equal(q.payload.aps.alert.body, 'A customer email carries an artwork file that could not be saved. Open Needs you for the reason.');
    assert.equal(q.payload.body.kind, 'artwork_failed');
    assert.deepEqual(q.payload.tokens, ['owner-token']);
    forbidden(JSON.stringify(q));
    assert.equal([...h.proposals.values()][0].notified_at, '2026-09-15T17:20:00.000Z', 'the failed row is stamped too');
  } finally { h.restore(); }
  h = harness({ proposals: [row({ verdict: 'fetch_failed', sender_kind: 'own' })] });
  try {
    await at(TICK, () => runProposalScan(ENV_ON));
    assert.equal(h.queuePosts()[0].payload.aps.alert.body, 'A file forwarded from our own mailbox carries an artwork file that could not be saved. Open Needs you for the reason.');
  } finally { h.restore(); }
  // One saved and one failed on the same email: the proposed banner, count 1, both stamped.
  h = harness({ proposals: [row(), row({ verdict: 'too_large' })] });
  try {
    await at(TICK, () => runProposalScan(ENV_ON));
    assert.equal(h.queuePosts().length, 1);
    assert.equal(h.queuePosts()[0].payload.body.kind, 'artwork_proposed');
    assert.equal(h.queuePosts()[0].payload.aps.alert.body, 'A customer email carries 1 artwork file. Nothing is on the card yet. Open Needs you to look at it and tap Use it or Not this one.');
    assert.ok([...h.proposals.values()].every((p) => p.notified_at), 'both rows stamped');
  } finally { h.restore(); }
  pass('a failed-verdict row uses the "Artwork not saved" words (own mailbox variant too); a saved file beside a failed one gets the proposed banner with the saved count');
}
// ── 5. The retire step ──────────────────────────────────────────────
{
  const CANCELLED = { ...ORDER, id: '30000000-0000-4000-8000-000000000002', stage: 'cancelled' };
  const PAST = { ...ORDER, id: '30000000-0000-4000-8000-000000000003', delivery_at_utc: '2026-09-14T00:00:00+00:00' };
  const MOVED_INVOICE = { ...ORDER, id: '30000000-0000-4000-8000-000000000004', external_invoice_id: '3450' };
  const MOVED_CARD = { ...ORDER, id: '30000000-0000-4000-8000-000000000005', logo_asset: { status: 'received', checked_at: '2026-09-15T16:00:00.000Z', files: [{}] } };
  const EVENT_ONLY = { ...ORDER, id: '30000000-0000-4000-8000-000000000006', delivery_at_utc: null, event_start_at: '2026-09-14T22:00:00+00:00' };
  const TODAY = { ...ORDER, id: '30000000-0000-4000-8000-000000000007', delivery_at_utc: '2026-09-15T00:00:00+00:00' };
  const rows = [
    row({ id: 201, notified_at: '2026-09-15T12:00:00.000Z' }),
    row({ id: 202, order_id: CANCELLED.id }),
    row({ id: 203, order_id: PAST.id, delivery_day_snapshot: '2026-09-14', notified_at: '2026-09-15T12:00:00.000Z' }),
    row({ id: 204, order_id: MOVED_INVOICE.id, notified_at: '2026-09-15T12:00:00.000Z' }),
    row({ id: 205, order_id: MOVED_CARD.id, card_files_at_scan: 1, card_checked_at_snapshot: '2026-09-14T16:00:00.000Z', notified_at: '2026-09-15T12:00:00.000Z' }),
    row({ id: 206, order_id: EVENT_ONLY.id, delivery_day_snapshot: '2026-09-14', notified_at: '2026-09-15T12:00:00.000Z' }),
    row({ id: 207, order_id: TODAY.id, delivery_day_snapshot: '2026-09-15', notified_at: '2026-09-15T12:00:00.000Z' }),
    row({ id: 208, status: 'used', decided_at: '2026-09-15T12:00:00.000Z', decided_via: 'app', notified_at: '2026-09-15T12:00:00.000Z' }),
  ];
  const h = harness({ proposals: rows, orders: [CANCELLED, PAST, MOVED_INVOICE, MOVED_CARD, EVENT_ONLY, TODAY] });
  try {
    const counts = await at(TICK, () => runProposalScan(ENV_ON));
    assert.deepEqual(counts.artwork, { notified: 0, deferred: 0, retired: 5, failed: 0 });
    assert.equal(h.queuePosts().length, 0, 'a cancelled order gets no banner; the rest were already notified');
    const p = (id) => h.proposals.get(id);
    assert.equal(p(201).status, 'pending', 'a healthy row is untouched');
    assert.equal(p(201).decided_via, null);
    assert.equal(p(202).status, 'superseded'); assert.equal(p(202).decided_via, 'cancelled');
    assert.equal(p(203).status, 'superseded'); assert.equal(p(203).decided_via, 'date_passed');
    assert.equal(p(204).status, 'superseded'); assert.equal(p(204).decided_via, 'invoice_changed');
    assert.equal(p(205).status, 'superseded'); assert.equal(p(205).decided_via, 'artwork_changed');
    assert.equal(p(206).status, 'superseded'); assert.equal(p(206).decided_via, 'date_passed', 'the day comes from event_start_at when there is no delivery marker');
    assert.equal(p(207).status, 'pending', 'delivery today is not past');
    assert.equal(p(208).status, 'used', 'a decided row is never touched');
    for (const id of [202, 203, 204, 205, 206]) {
      assert.equal(p(id).decided_at, '2026-09-15T17:20:00.000Z');
      assert.equal(p(id).updated_at, '2026-09-15T17:20:00.000Z');
    }
    const patches = h.patches();
    assert.equal(patches.length, 5);
    for (const c of patches) {
      assert.ok(/order_artwork_proposals\?id=eq\.\d+&status=eq\.pending$/.test(c.url), 'guarded on the row still pending: ' + c.url);
      assert.equal(c.body.status, 'superseded');
      assert.equal(typeof c.body.decided_via, 'string');
    }
    // A second tick changes nothing more.
    const again = await at('2026-09-15T17:25:00Z', () => runProposalScan(ENV_ON));
    assert.deepEqual(again.artwork, { notified: 0, deferred: 0, retired: 0, failed: 0 });
    assert.equal(h.patches().length, 5);
  } finally { h.restore(); }
  pass('retire: cancelled, past day (delivery marker or event start), invoice moved and card moved rows are superseded with decided_via and a guarded PATCH; a healthy row, a same-day row and a decided row are untouched; a second tick is a no-op');
}
// ── 6. The table is not there yet (048 not applied): logs and returns ─
{
  const h = harness();
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => { errors.push(args.map(String).join(' ')); };
  try {
    const counts = await at(TICK, () => runProposalScan(ENV_ON));
    assert.deepEqual(counts.artwork, { notified: 0, deferred: 0, retired: 0, failed: 0 });
    assert.equal(h.queuePosts().length, 0);
    assert.equal(h.artworkCalls().length, 1, 'one read, then out');
    assert.ok(errors.some((e) => e.includes('migration 048')), errors.join('\n'));
  } finally { console.error = originalError; h.restore(); }
  pass('a 404 on the table (pre-048) logs the migration name and returns; nothing throws, nothing is pushed');
}
// ── 7. No owner phone: counted as failed, the rows stay unstamped ───
{
  const h = harness({ proposals: [row()], tokens: { 'ny.manager@example.invalid': 'manager-token', 'crew@example.invalid': 'crew-token' } });
  try {
    const counts = await at(TICK, () => runProposalScan(ENV_ON));
    assert.deepEqual(counts.artwork, { notified: 0, deferred: 0, retired: 0, failed: 1 });
    assert.equal(h.queuePosts().length, 0, 'never a manager or crew banner in the owner\'s place');
    assert.equal([...h.proposals.values()][0].notified_at, null, 'unstamped, so the next tick tries again');
    assert.equal(h.patches().length, 0);
  } finally { h.restore(); }
  pass('with no owner token nothing is queued (managers and crew never stand in), the row stays unstamped and failed counts 1');
}
// ── 8. A row whose order is gone from the embed is skipped, not thrown ─
{
  // orders!inner drops rows whose order does not match; a row on an
  // unknown order never reaches the banner loop.
  const h = harness({ proposals: [row({ order_id: '30000000-0000-4000-8000-000000000099' }), row()] });
  try {
    const counts = await at(TICK, () => runProposalScan(ENV_ON));
    assert.deepEqual(counts.artwork, { notified: 1, deferred: 0, retired: 0, failed: 0 });
    assert.equal(h.queuePosts().length, 1);
  } finally { h.restore(); }
  pass('rows the orders!inner embed drops are simply absent; the rest still get their banner');
}
// ── 9. runArtworkFollowUps called on its own with fake counts ────────
{
  const h = harness({ proposals: [row(), row({ order_id: '30000000-0000-4000-8000-000000000002' })], orders: [{ ...ORDER, id: '30000000-0000-4000-8000-000000000002', stage: 'cancelled' }] });
  try {
    const counts = { notified: 0, deferred: 0, retired: 0, failed: 0 };
    await at(TICK, () => runArtworkFollowUps(ENV_ON, counts, T(TICK), '2026-09-15T17:20:00.000Z'));
    assert.deepEqual(counts, { notified: 1, deferred: 0, retired: 1, failed: 0 });
    assert.equal(h.queuePosts().length, 1);
  } finally { h.restore(); }
  pass('runArtworkFollowUps: the banner step and the retire step each count their own work');
}
// ── 10. The texts, byte for byte ────────────────────────────────────
{
  const o = { client_name: 'Alison Sheeley' };
  assert.deepEqual(proposalTexts('artwork_proposed', o, { day: '2026-09-18', count: 1, cardFiles: 0 }),
    { title: 'Artwork? Sheeley, Fri Sep 18', body: 'A customer email carries 1 artwork file. Nothing is on the card yet. Open Needs you to look at it and tap Use it or Not this one.', managerBody: null });
  assert.deepEqual(proposalTexts('artwork_proposed', o, { day: '2026-09-18', count: 3, cardFiles: 0 }),
    { title: 'Artwork? Sheeley, Fri Sep 18', body: 'A customer email carries 3 artwork files. Nothing is on the card yet. Open Needs you to look at them and choose.', managerBody: null });
  assert.deepEqual(proposalTexts('artwork_proposed', o, { day: '2026-09-18', count: 1, cardFiles: 1 }),
    { title: 'Artwork? Sheeley, Fri Sep 18', body: 'A customer email carries 1 new artwork file. The card already has 1 file. Open Needs you to compare them.', managerBody: null });
  assert.equal(proposalTexts('artwork_proposed', o, { day: '2026-09-18', count: 2, cardFiles: 3 }).body,
    'A customer email carries 2 new artwork files. The card already has 3 files. Open Needs you to compare them.');
  assert.equal(proposalTexts('artwork_proposed', o, { day: '2026-09-18', count: 1, cardFiles: 0, own: true }).body,
    'A file forwarded from our own mailbox carries 1 artwork file. Nothing is on the card yet. Open Needs you to look at it and tap Use it or Not this one.');
  assert.equal(proposalTexts('artwork_proposed', o, { day: '2026-09-18', count: 2, cardFiles: 1, own: true }).body,
    'A file forwarded from our own mailbox carries 2 new artwork files. The card already has 1 file. Open Needs you to compare them.');
  assert.deepEqual(proposalTexts('artwork_failed', o, { day: '2026-09-18' }),
    { title: 'Artwork not saved: Sheeley, Fri Sep 18', body: 'A customer email carries an artwork file that could not be saved. Open Needs you for the reason.', managerBody: null });
  assert.equal(proposalTexts('artwork_failed', o, { day: '2026-09-18', own: true }).body,
    'A file forwarded from our own mailbox carries an artwork file that could not be saved. Open Needs you for the reason.');
  // Defensive: a missing or silly count reads as one file; a missing name is Unnamed.
  assert.equal(proposalTexts('artwork_proposed', o, { day: '2026-09-18' }).body, 'A customer email carries 1 artwork file. Nothing is on the card yet. Open Needs you to look at it and tap Use it or Not this one.');
  assert.equal(proposalTexts('artwork_proposed', {}, { day: '2026-09-18', count: 0 }).title, 'Artwork? Unnamed, Fri Sep 18');
  for (const kind of ['artwork_proposed', 'artwork_failed']) {
    const t = proposalTexts(kind, { client_name: 'Alison Sheeley', venue: '491 S Dean Street', client_email: 'a@example.invalid' }, { day: '2026-09-18', count: 2, cardFiles: 1, own: false });
    forbidden(t.title + ' ' + t.body);
  }
  pass('the artwork banner texts are byte-exact per plan section 2: every variant, and never a file name, address, phone or dollar');
}

console.log(`\nPASS: ${passed} artwork proposal scenarios (fake network; no live systems were contacted).`);

// Tests for the intake thread-suppression helpers in worker.js.
//
// Why this file exists: thread matching decides whether a real inbound
// order gets shown to Sidd or quietly noted as "just a reply". Getting
// it wrong loses money, so the rules are pinned here.
//
// Run it with:  node worker/test-intake-suppression.mjs
//
// No test framework and no network. We swap the global fetch for a fake
// one that hands back whatever rows a case wants, so nothing here can
// touch Supabase, Telegram, or Claude.

import assert from 'node:assert/strict';
import { normalizeSubject, findHandledThreadSibling, fetchIntakeLive, buildIntakeDigestLines, runIntakeNagScan, runIntakeCardScan } from './worker.js';

// ── fake Supabase ──────────────────────────────────────────────────
// findHandledThreadSibling reads recent rows through the worker's
// fetchIntake, which calls the global fetch. We replace that with a
// stub. `nextRows` is what the next read returns; set it to null to
// simulate a failed read.
let nextRows = [];
let readFailed = false;
globalThis.fetch = async () => {
  if (readFailed) {
    return { ok: false, status: 500, text: async () => 'boom', json: async () => null };
  }
  return { ok: true, status: 200, text: async () => '', json: async () => nextRows };
};

// A fake env. Values are dummies; the stub above never uses them.
const env = { SUPABASE_URL: 'https://example.invalid', SUPABASE_SERVICE_KEY: 'not-a-real-key' };

// Helper: build the row under test.
function subjectRow(extra = {}) {
  return {
    id: 100,
    from_addr: 'mary@favouragency.com',
    subject: 'Re: Coconut order',
    created_at: '2026-07-24T12:00:00Z',
    ...extra,
  };
}

// Helper: build a sibling row on the same thread.
function sibling(extra = {}) {
  return {
    id: 90,
    subject: 'Coconut order',
    status: 'pending_review',
    error_detail: null,
    created_at: '2026-07-22T12:00:00Z',
    ...extra,
  };
}

// Helper: run one lookup against a given set of recent rows.
async function lookup(row, recent, opts = {}) {
  nextRows = recent;
  readFailed = !!opts.readFailed;
  const found = await findHandledThreadSibling(env, row);
  readFailed = false;
  return found;
}

// ── tiny runner ────────────────────────────────────────────────────
const cases = [];
function test(name, fn) { cases.push({ name, fn }); }

// ── 1) subject normalizing ─────────────────────────────────────────
test('normalizeSubject strips stacked reply and forward prefixes', () => {
  assert.equal(normalizeSubject('Re: Coconut order'), 'coconut order');
  assert.equal(normalizeSubject('RE:Coconut order'), 'coconut order');
  assert.equal(normalizeSubject('Fwd: Coconut order'), 'coconut order');
  assert.equal(normalizeSubject('FW:Coconut order'), 'coconut order');
  assert.equal(normalizeSubject('Re: RE: Fwd: FW: Coconut order'), 'coconut order');
  assert.equal(normalizeSubject('re : Coconut order'), 'coconut order');
});

test('normalizeSubject collapses whitespace and casefolds', () => {
  assert.equal(normalizeSubject('  COCONUT   Order  '), 'coconut order');
  assert.equal(normalizeSubject('Coconut\t\norder'), 'coconut order');
  assert.equal(normalizeSubject(null), '');
  assert.equal(normalizeSubject(undefined), '');
});

// ── 2) an empty subject is never a thread ──────────────────────────
test('an empty or whitespace subject never matches anything', async () => {
  const handledSib = sibling({ status: 'invoiced', subject: '' });
  assert.equal(await lookup(subjectRow({ subject: '' }), [handledSib]), null);
  assert.equal(await lookup(subjectRow({ subject: '   ' }), [handledSib]), null);
  // A bare "Re:" with nothing after it normalizes to empty too.
  assert.equal(await lookup(subjectRow({ subject: 'Re: ' }), [handledSib]), null);
});

// ── 3) decided siblings count as handled ───────────────────────────
test('a sibling that is invoiced, approved, or drafting counts as handled', async () => {
  for (const status of ['invoiced', 'approved', 'drafting']) {
    const found = await lookup(subjectRow(), [sibling({ status })]);
    assert.ok(found, 'expected a match for sibling status ' + status);
    assert.equal(found.id, 90);
  }
});

// ── 4) FIX 1a: a merely carded, undecided sibling does NOT count ────
test('a sibling that was only carded and is still undecided does NOT count', async () => {
  // This is the load-bearing case: an earlier email on the thread got a
  // card but Sidd has not tapped anything yet. The follow-up email
  // usually carries the real order details, so it must not be treated
  // as an already-handled thread.
  const carded = sibling({ status: 'pending_review', telegram_message_id: '4242' });
  assert.equal(await lookup(subjectRow(), [carded]), null);
});

// ── 5) Jarvis's "final" marker counts ──────────────────────────────
test('a sibling Jarvis marked final in error_detail counts as handled', async () => {
  const finalSib = sibling({
    status: 'pending_review',
    error_detail: '{"reason": "parked", "final": true}',
  });
  const found = await lookup(subjectRow(), [finalSib]);
  assert.ok(found);
  assert.equal(found.id, 90);
});

// ── 6) the 14-day window ───────────────────────────────────────────
test('a sibling older than the 14-day window does not count', async () => {
  // Same subject, invoiced, but 53 days earlier: plausibly new business.
  const old = sibling({ status: 'invoiced', created_at: '2026-06-01T12:00:00Z' });
  assert.equal(await lookup(subjectRow(), [old]), null);
  // Just inside the window still matches.
  const justInside = sibling({ status: 'invoiced', created_at: '2026-07-11T12:00:00Z' });
  assert.ok(await lookup(subjectRow(), [justInside]));
});

// ── 7) a row is never its own sibling ──────────────────────────────
test('the row itself is never its own sibling', async () => {
  const self = {
    id: 100,
    subject: 'Re: Coconut order',
    status: 'invoiced',
    error_detail: '{"final": true}',
    created_at: '2026-07-24T12:00:00Z',
  };
  assert.equal(await lookup(subjectRow(), [self]), null);
  // Same when the ids differ only by type (string vs number).
  assert.equal(await lookup(subjectRow({ id: '100' }), [self]), null);
});

// ── 8) own-domain exemption (website form leads) ────────────────────
test('a sender on our own domain is exempt even on a perfect match', async () => {
  // The GoDaddy website form emails us FROM our own domain, and every
  // one of those notifications shares ONE subject line while being a
  // DIFFERENT lead. Suppressing those would throw away real business.
  const perfect = sibling({ status: 'invoiced', subject: 'Re: Coconut order' });
  assert.equal(
    await lookup(subjectRow({ from_addr: 'forms@hamptonscoconuts.com' }), [perfect]),
    null
  );
  // Case and stray spaces in the address must not defeat the exemption.
  assert.equal(
    await lookup(subjectRow({ from_addr: '  Forms@HamptonsCoconuts.COM ' }), [perfect]),
    null
  );
  // Sanity check: the same match from an outside sender DOES hit.
  assert.ok(await lookup(subjectRow({ from_addr: 'mary@favouragency.com' }), [perfect]));
});

// ── 9) never suppress on a guess ───────────────────────────────────
test('a failed read never suppresses', async () => {
  const found = await lookup(subjectRow(), null, { readFailed: true });
  assert.equal(found, null);
});

// ── 10) a thread reply from a DIFFERENT sender still matches ─────
// The 2026-07-23 incident thread ("7/28 Influencer Dinner") was answered
// by four people at three different companies, and each reply became its
// own intake row. Sender is deliberately NOT part of the match, or that
// incident would go unflagged. The note the card carries names the
// sibling's sender so Sidd can still tell a real thread reply from two
// unrelated leads that happen to share a subject.
test('a reply from a different sender on the same thread still matches', async () => {
  const found = await lookup(
    subjectRow({ id: 101, from_addr: 'david@nameandnumber.com' }),
    [sibling({ id: 58, from_addr: 'mary.ryan@favour.agency', status: 'invoiced' })],
  );
  assert.ok(found, 'expected the invoiced sibling to be found');
  assert.equal(found.id, 58);
});

// ── 11) the matcher returns the sibling's sender for the card note ─
// The card wording depends on from_addr coming back from this lookup; if
// the SELECT ever drops it the note would read "from unknown sender".
test('the returned sibling carries its sender for the card note', async () => {
  const found = await lookup(
    subjectRow({ id: 102 }),
    [sibling({ id: 59, from_addr: 'kristi@nameandnumber.com', status: 'drafting' })],
  );
  assert.ok(found);
  assert.equal(found.from_addr, 'kristi@nameandnumber.com');
  assert.equal(found.status, 'drafting');
});

// ── 12) replayed rows never reach Telegram (migration 045) ─────────
// The one-time replay script re-reads old mail and stamps each row with
// replayed_at. fetchIntakeLive adds `&replayed_at=is.null` to every
// Telegram-facing read (cards, reply scan, digest, nag) and retries once
// WITHOUT the filter only on a 400 that names the column (a worker
// deployed ahead of 045). The filters, not the proposal scan's later
// dismissal, are the guard, so the URLs themselves are pinned here.
//
// A second fake: it records every URL, applies the few filters these
// reads use (status eq/in, replayed_at is.null, reviewed_at gte, channel
// eq, limit) to `liveRows`, and answers the other tables with nothing.
// Anything that is not a Supabase REST call (Telegram, Claude) is recorded
// in `leaked` and refused, so a leaked card or nag is visible to the case.
let liveRows = [];
let liveUrls = [];
let leaked = [];
let liveFail = null;
function fakeLive() {
  liveUrls = [];
  leaked = [];
  globalThis.fetch = async (urlValue) => {
    const url = String(urlValue);
    if (!url.startsWith(env.SUPABASE_URL + '/rest/v1/')) { leaked.push(url); throw new Error('leaked non-Supabase call: ' + url); }
    const path = url.slice((env.SUPABASE_URL + '/rest/v1/').length);
    const table = path.split('?')[0];
    if (table !== 'intake_messages') return { ok: true, status: 200, text: async () => '', json: async () => [] };
    liveUrls.push(path);
    if (liveFail) return { ok: false, status: liveFail.status, text: async () => liveFail.text, json: async () => null };
    const qs = new URLSearchParams(path.split('?')[1] || '');
    let out = liveRows.filter((r) => {
      for (const [k, v] of qs.entries()) {
        if (['select', 'order', 'limit'].includes(k)) continue;
        if (v === 'is.null') { if (r[k] != null) return false; continue; }
        if (v === 'not.is.null') { if (r[k] == null) return false; continue; }
        if (v.startsWith('eq.')) { if (String(r[k]) !== v.slice(3)) return false; continue; }
        if (v.startsWith('in.(')) { if (!v.slice(4, -1).split(',').includes(String(r[k]))) return false; continue; }
        if (v.startsWith('gte.')) { if (!(String(r[k] || '') >= v.slice(4))) return false; continue; }
      }
      return true;
    });
    const limit = Number(qs.get('limit') || out.length);
    return { ok: true, status: 200, text: async () => '', json: async () => out.slice(0, limit) };
  };
}
const HOUR = 3600 * 1000;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const errors = [];
const origError = console.error;
const catchErrors = () => { errors.length = 0; console.error = (...a) => { errors.push(a.join(' ')); }; };
const releaseErrors = () => { console.error = origError; };

test('fetchIntakeLive filters replayed rows and retries once, without the filter, only on a 400 naming replayed_at', async () => {
  fakeLive();
  liveRows = [{ id: 1, status: 'pending_review', replayed_at: null }, { id: 2, status: 'pending_review', replayed_at: '2026-09-16T13:00:00Z' }];
  const rows = await fetchIntakeLive(env, 'select=id&status=eq.pending_review');
  assert.deepEqual(rows.map((r) => r.id), [1], 'the replayed row is filtered out');
  assert.equal(liveUrls.length, 1); assert.ok(liveUrls[0].endsWith('&replayed_at=is.null'), liveUrls[0]);
  // Ahead of 045: PostgREST names the missing column; one retry without it, one logged error.
  catchErrors();
  try {
    liveFail = { status: 400, text: JSON.stringify({ code: '42703', message: 'column intake_messages.replayed_at does not exist' }) };
    let calls = 0;
    const inner = globalThis.fetch;
    globalThis.fetch = async (u) => { calls++; if (calls === 2) { liveFail = null; } return inner(u); };
    const retried = await fetchIntakeLive(env, 'select=id&status=eq.pending_review');
    assert.equal(calls, 2, 'exactly one retry');
    assert.ok(!liveUrls[2].includes('replayed_at'), 'the retry carries no filter');
    assert.deepEqual(retried.map((r) => r.id), [1, 2], 'without 045 nothing tells the rows apart');
    assert.equal(errors.length, 1); assert.ok(errors[0].includes('replayed_at column missing'));
  } finally { releaseErrors(); liveFail = null; }
  // A 500, or a 400 naming some other column: null and NO second fetch.
  for (const fail of [{ status: 500, text: 'boom' }, { status: 400, text: 'column intake_messages.nope does not exist' }]) {
    fakeLive();
    liveFail = fail;
    catchErrors();
    try {
      const out = await fetchIntakeLive(env, 'select=id&status=eq.pending_review');
      assert.equal(out, null);
      assert.equal(liveUrls.length, 1, 'no blind retry on ' + fail.status);
      assert.equal(errors.length, 1);
    } finally { releaseErrors(); liveFail = null; }
  }
});

test('the card scan never cards a replayed row (its read carries the filter; no Claude, no Telegram)', async () => {
  fakeLive();
  liveRows = [{ id: 7, status: 'pending_review', telegram_message_id: null, classified_at: iso(HOUR), classification: 'maybe_order', from_addr: 'old@example.invalid', subject: 'August order', raw_text: 'Deliver to 491 S Dean Street, Englewood, NJ 07631', created_at: '2026-08-22T14:00:00Z', replayed_at: '2026-09-16T13:00:00Z', order_id: 'o1' }];
  catchErrors();
  try { await runIntakeCardScan({ ...env, TG_BOT_TOKEN: 'x', ALLOWED_CHAT_IDS: '1', ANTHROPIC_API_KEY: 'x' }); } finally { releaseErrors(); }
  const cardRead = liveUrls.find((u) => u.includes('telegram_message_id=is.null') && u.includes('classification=in.(order,maybe_order)'));
  assert.ok(cardRead, 'the card read happened: ' + liveUrls.join(' | '));
  assert.ok(cardRead.includes('&replayed_at=is.null'), cardRead);
  assert.deepEqual(leaked, [], 'no Claude summary, no Telegram card');
  assert.equal(liveRows[0].telegram_message_id, null, 'no card stamp');
});

test('the hourly nag never names a replayed row', async () => {
  fakeLive();
  liveRows = [{ id: 8, status: 'pending_review', from_addr: 'old@example.invalid', created_at: iso(4.5 * HOUR), reviewed_at: null, replayed_at: '2026-09-16T13:00:00Z' }];
  await runIntakeNagScan({ ...env, TG_BOT_TOKEN: 'x', ALLOWED_CHAT_IDS: '1' });
  const nagReads = liveUrls.filter((u) => u.includes('status=in.(pending_review,approved)'));
  assert.equal(nagReads.length, 2, 'one read per window');
  for (const u of nagReads) assert.ok(u.includes('&replayed_at=is.null'), u);
  assert.deepEqual(leaked, [], 'no Telegram nag');
  // The same row, live: the nag goes to Telegram (this fake refuses it and
  // records the attempt), which proves the filter is what kept it quiet.
  liveRows[0].replayed_at = null;
  catchErrors();
  try { await runIntakeNagScan({ ...env, TG_BOT_TOKEN: 'x', ALLOWED_CHAT_IDS: '1' }); } finally { releaseErrors(); }
  assert.equal(leaked.length, 1); assert.ok(leaked[0].includes('api.telegram.org'), leaked[0]);
});

test('the 8am digest counts no replayed row: not as waiting, not as skipped, not as set aside', async () => {
  fakeLive();
  const replayedDismissed = { id: 9, channel: 'email', status: 'dismissed', reviewed_at: iso(HOUR), created_at: '2026-08-22T14:00:00Z', replayed_at: '2026-09-16T13:00:00Z' };
  const replayedIgnored = { id: 10, channel: 'email', status: 'ignored', reviewed_at: iso(HOUR), created_at: '2026-08-23T14:00:00Z', replayed_at: '2026-09-16T13:00:00Z' };
  const replayedWaiting = { id: 11, channel: 'email', status: 'pending_review', reviewed_at: null, created_at: '2026-08-24T14:00:00Z', replayed_at: '2026-09-16T13:00:00Z' };
  const liveLead = { id: 12, channel: 'email', status: 'pending_review', reviewed_at: null, created_at: iso(HOUR), replayed_at: null };
  liveRows = [replayedDismissed, replayedIgnored, replayedWaiting, liveLead];
  const lines = await buildIntakeDigestLines(env);
  assert.equal(lines.filter((l) => l.includes('skipped in the last 2 days')).length, 0, lines.join(' | '));
  assert.equal(lines.filter((l) => l.includes('set aside as not-orders')).length, 0, lines.join(' | '));
  assert.equal(lines.filter((l) => l.startsWith('Intake: 1 awaiting review')).length, 1, lines.join(' | '));
  for (const u of liveUrls.filter((x) => /status=eq\.(dismissed|ignored)|status=in\.\(pending_review,approved\)/.test(x))) assert.ok(u.includes('&replayed_at=is.null'), u);
  // The same skip and set-aside on LIVE rows are still reported (the audit lines stay).
  liveRows = [{ ...replayedDismissed, replayed_at: null }, { ...replayedIgnored, replayed_at: null }, liveLead];
  const live = await buildIntakeDigestLines(env);
  assert.equal(live.filter((l) => l.includes('1 email skipped in the last 2 days (double check with: show 9)')).length, 1, live.join(' | '));
  assert.equal(live.filter((l) => l.includes('1 email set aside as not-orders in the last 2 days (double check with: show 10)')).length, 1, live.join(' | '));
});

test('the thread-sibling window and the digest dead-man read are live rows only', async () => {
  // Sibling window: a replayed row (fresh id, old created_at) never fills
  // the 60-row window and never counts as the handled sibling; the live
  // handled sibling behind it is still found.
  fakeLive();
  const live = { id: 90, subject: 'Coconut order', from_addr: 'mary@favouragency.com', status: 'invoiced', error_detail: null, created_at: '2026-07-22T12:00:00Z', replayed_at: null };
  const replayed = { id: 91, subject: 'Coconut order', from_addr: 'old@example.invalid', status: 'invoiced', error_detail: null, created_at: '2026-07-23T12:00:00Z', replayed_at: '2026-09-16T13:00:00Z' };
  liveRows = [replayed, live];
  const found = await findHandledThreadSibling(env, subjectRow());
  const sibRead = liveUrls.find((u) => u.includes('order=id.desc&limit=60'));
  assert.ok(sibRead, 'the sibling read happened: ' + liveUrls.join(' | '));
  assert.ok(sibRead.includes('&replayed_at=is.null'), sibRead);
  assert.equal(found && found.id, 90, 'the live handled sibling, never the replayed one');
  // Dead-man: the only email in the last day is a replayed row, so the
  // poller warning still fires (the newest-email read carries the filter).
  fakeLive();
  liveRows = [{ id: 92, channel: 'email', status: 'dismissed', reviewed_at: iso(HOUR), created_at: iso(HOUR), replayed_at: '2026-09-16T13:00:00Z' }];
  const lines = await buildIntakeDigestLines(env);
  const deadMan = liveUrls.find((u) => u.includes('channel=eq.email&order=created_at.desc&limit=1'));
  assert.ok(deadMan, 'the newest-email read happened: ' + liveUrls.join(' | '));
  assert.ok(deadMan.includes('&replayed_at=is.null'), deadMan);
  assert.equal(lines.filter((l) => l.includes('no email intake seen in 24h')).length, 1, lines.join(' | '));
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
    console.log('      ' + String((e && e.message) || e).split('\n').join('\n      '));
  }
}
console.log('');
console.log((cases.length - failed) + ' passed, ' + failed + ' failed, ' + cases.length + ' total');
process.exit(failed ? 1 : 0);

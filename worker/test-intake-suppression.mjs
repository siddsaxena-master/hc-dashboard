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
import { normalizeSubject, findHandledThreadSibling } from './worker.js';

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

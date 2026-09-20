// Tests for the passed-leads line in the 8am digest (worker.js, the
// PASSED LEADS block, migration 047). A lead the owner marked passed from
// its Calendar card carries orders.passed = {reason, competitor, note, at,
// by, prior_stage}; the digest names this month's total in one line and
// says nothing when there are none. Everything runs against a fake
// network: nothing here can reach Supabase or Telegram.
//
// Run it with:  node worker/test-passed-leads.mjs
//
// The word is PASSED. The pins below also make sure the block never uses
// the other word and never uses a dash character.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { passedMonthStart, passedLeadsDigestLine, buildPassedLeadsDigestLines } from './worker.js';

let passed = 0;
const pass = (m) => { passed++; console.log('PASS: ' + m); };
const SB = 'https://example.invalid';
const ENV = { SUPABASE_URL: SB, SUPABASE_SERVICE_KEY: 'not-a-real-key', TG_BOT_TOKEN: 'x', ALLOWED_CHAT_IDS: '' };
const T = (iso) => Date.parse(iso);

// Freeze the clock for one call, the way test-reconfirmation.mjs does.
const realNow = Date.now;
async function at(iso, fn) {
  Date.now = () => T(iso);
  try { return await fn(); } finally { Date.now = realNow; }
}

// A passed object the way hc_mark_order_passed writes it.
function mark(reason, extra = {}) {
  return { reason, competitor: null, note: null, at: '2026-09-15T14:03:22.123456+00:00', by: '11111111-1111-4111-8111-111111111111', prior_stage: 'inquiry', ...extra };
}

// The fake network: answers the one orders read with the rows a case
// wants (each wrapped as {passed}), or fails the way a case asks.
function harness(opts = {}) {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (urlValue, options = {}) => {
    const url = String(urlValue);
    calls.push({ url, method: options.method || 'GET', headers: options.headers || {} });
    if (opts.throws) throw new TypeError('fetch failed');
    if (opts.status) return { ok: false, status: opts.status, async json() { return null; }, async text() { return 'boom'; } };
    const body = opts.body !== undefined ? opts.body : (opts.rows || []).map((p) => ({ passed: p }));
    return { ok: true, status: 200, async json() { return body; }, async text() { return JSON.stringify(body); } };
  };
  return { calls, restore: () => { globalThis.fetch = originalFetch; } };
}

// ── 1. The month start is the owner's (Eastern) month ───────────────
{
  assert.equal(passedMonthStart(T('2026-09-19T12:00:00Z')), '2026-09-01');
  // 10pm on September 30 in New York is already October 1 in UTC.
  assert.equal(passedMonthStart(T('2026-10-01T02:00:00Z')), '2026-09-01');
  assert.equal(passedMonthStart(T('2026-10-01T05:00:00Z')), '2026-10-01');
  assert.equal(passedMonthStart(T('2026-01-01T12:00:00Z')), '2026-01-01');
  pass('month start: first day of the Eastern month, never the UTC one');
}

// ── 2. The line itself ──────────────────────────────────────────────
{
  // The exact example from the spec.
  assert.equal(passedLeadsDigestLine([mark('price'), mark('price'), mark('competitor', { competitor: 'Cocolux' }), mark('no_reply')]),
    'Passed leads this month: 4 (price 2, competitor 1: Cocolux, no reply 1)');
  // Nothing to say: empty string, never a zero line.
  assert.equal(passedLeadsDigestLine([]), '');
  assert.equal(passedLeadsDigestLine(null), '');
  assert.equal(passedLeadsDigestLine([null, undefined, 'x']), '');
  // Every reason, named in list order with its words.
  assert.equal(passedLeadsDigestLine([mark('other'), mark('event_cancelled'), mark('no_reply'), mark('timing'), mark('competitor'), mark('price')]),
    'Passed leads this month: 6 (price 1, competitor 1, timing 1, no reply 1, event cancelled 1, other 1)');
  pass('line: the spec example byte for byte, empty when none, every reason in list order');
}
{
  // Competitor names: de-duplicated, joined as words, named behind the
  // reason that carries them (a cheaper price with Cocolux names Cocolux
  // under price).
  assert.equal(passedLeadsDigestLine([mark('competitor', { competitor: 'Cocolux' }), mark('competitor', { competitor: 'Windansea' }), mark('competitor', { competitor: 'Cocolux' })]),
    'Passed leads this month: 3 (competitor 3: Cocolux and Windansea)');
  assert.equal(passedLeadsDigestLine([mark('competitor', { competitor: 'Cocolux' }), mark('competitor', { competitor: 'Windansea' }), mark('competitor', { competitor: 'Beach Bums' })]),
    'Passed leads this month: 3 (competitor 3: Cocolux, Windansea and Beach Bums)');
  assert.equal(passedLeadsDigestLine([mark('price', { competitor: 'Cocolux', note: 'cheaper price with Cocolux' }), mark('price')]),
    'Passed leads this month: 2 (price 2: Cocolux)');
  // A blank or whitespace competitor names nobody; the note never prints.
  assert.equal(passedLeadsDigestLine([mark('competitor', { competitor: '   ' }), mark('other', { note: 'went with a cousin' })]),
    'Passed leads this month: 2 (competitor 1, other 1)');
  // Telegram Markdown characters in a typed name are blanked and the
  // spaces collapsed, so the digest can never break rendering.
  assert.equal(passedLeadsDigestLine([mark('competitor', { competitor: 'Co_co*lux [NY]' })]),
    'Passed leads this month: 1 (competitor 1: Co co lux NY])');
  // A reason outside the list (the constraint should stop it) still
  // counts toward the total, so the number never quietly shrinks.
  assert.equal(passedLeadsDigestLine([mark('price'), mark('ghosted')]), 'Passed leads this month: 2 (price 1)');
  assert.equal(passedLeadsDigestLine([mark('ghosted')]), 'Passed leads this month: 1');
  pass('line: competitor names de-duplicated and joined as words, named under price too, Telegram-safe, notes never print, odd reasons still counted');
}

// ── 3. The digest helper against the fake network ───────────────────
{
  const h = harness({ rows: [mark('price'), mark('competitor', { competitor: 'Cocolux' }), mark('no_reply'), mark('price')] });
  try {
    const lines = await at('2026-09-19T12:00:00Z', () => buildPassedLeadsDigestLines(ENV));
    assert.deepEqual(lines, ['Passed leads this month: 4 (price 2, competitor 1: Cocolux, no reply 1)']);
    // Exactly one bounded read, month start in the filter, newest first.
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].method, 'GET');
    assert.equal(h.calls[0].url, SB + '/rest/v1/orders?select=passed&passed=not.is.null&passed->>at=gte.2026-09-01&order=passed->>at.desc&limit=500');
    assert.equal(h.calls[0].headers.apikey, 'not-a-real-key');
    assert.equal(h.calls[0].headers.Authorization, 'Bearer not-a-real-key');
  } finally { h.restore(); }
  pass('digest: one GET on orders (passed set, this month, newest first, 500 at most) and the line');
}
{
  // Nothing passed this month: no line at all.
  const empty = harness({ rows: [] });
  try { assert.deepEqual(await at('2026-09-19T12:00:00Z', () => buildPassedLeadsDigestLines(ENV)), []); } finally { empty.restore(); }
  // The Eastern-day guard: a mark at 10pm New York on August 31 sits at
  // September 1 in UTC text and would pass the server filter; it is not
  // this month. One at 1am New York on September 1 is.
  const edge = harness({ rows: [mark('price', { at: '2026-09-01T02:00:00+00:00' }), mark('timing', { at: '2026-09-01T05:00:00+00:00' })] });
  try { assert.deepEqual(await at('2026-09-19T12:00:00Z', () => buildPassedLeadsDigestLines(ENV)), ['Passed leads this month: 1 (timing 1)']); } finally { edge.restore(); }
  // An unreadable "at" is kept (the server filter already vouched for it).
  const odd = harness({ rows: [mark('other', { at: 'not a date' }), mark('other', { at: null })] });
  try { assert.deepEqual(await at('2026-09-19T12:00:00Z', () => buildPassedLeadsDigestLines(ENV)), ['Passed leads this month: 2 (other 2)']); } finally { odd.restore(); }
  pass('digest: silent when none; the Eastern day decides the month; an odd timestamp still counts');
}
{
  // Fails soft: a bad status, a network throw, or a body that is not a
  // list each leave the digest unchanged (no line, no throw).
  const status = harness({ status: 500 });
  try { assert.deepEqual(await at('2026-09-19T12:00:00Z', () => buildPassedLeadsDigestLines(ENV)), []); } finally { status.restore(); }
  const missing = harness({ status: 404 });
  try { assert.deepEqual(await at('2026-09-19T12:00:00Z', () => buildPassedLeadsDigestLines(ENV)), []); } finally { missing.restore(); }
  const thrown = harness({ throws: true });
  try { assert.deepEqual(await at('2026-09-19T12:00:00Z', () => buildPassedLeadsDigestLines(ENV)), []); } finally { thrown.restore(); }
  const shape = harness({ body: { message: 'not a list' } });
  try { assert.deepEqual(await at('2026-09-19T12:00:00Z', () => buildPassedLeadsDigestLines(ENV)), []); } finally { shape.restore(); }
  const nulls = harness({ body: [{ passed: null }, {}] });
  try { assert.deepEqual(await at('2026-09-19T12:00:00Z', () => buildPassedLeadsDigestLines(ENV)), []); } finally { nulls.restore(); }
  pass('digest: fails soft on a bad status, a missing column (404), a thrown fetch, a non-list body and null rows');
}

// ── 4. The wiring and the words, pinned in the source ───────────────
{
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'worker.js'), 'utf8');
  const digest = src.slice(src.indexOf('async function runDailyDigest(env)'), src.indexOf('async function runReconfirmationScan(env)'));
  const reconfirmAt = digest.indexOf('await buildReconfirmationDigestLines(env)');
  const passedAt = digest.indexOf('await buildPassedLeadsDigestLines(env)');
  const payrollAt = digest.indexOf('await buildPayrollDigestLines(env)');
  assert.ok(reconfirmAt >= 0 && passedAt > reconfirmAt && payrollAt > passedAt, 'the passed line sits after reconfirmations and before payroll');
  assert.ok(digest.includes("if (passedLines.length) {\r\n    lines.push('');\r\n    passedLines.forEach(l => lines.push(l));") || digest.includes("if (passedLines.length) {\n    lines.push('');\n    passedLines.forEach(l => lines.push(l));"), 'the line is appended only when present');
  const block = src.slice(src.indexOf('PASSED LEADS (2026-09-19'), src.indexOf('end of the passed leads block'));
  assert.ok(block.length > 0, 'the block exists');
  // The two dash characters (en and em) are built from their code points
  // so this file never contains one either.
  const dashes = new RegExp('[' + String.fromCharCode(0x2013, 0x2014) + ']');
  assert.ok(!dashes.test(block) && !dashes.test(digest.slice(passedAt - 200, passedAt + 200)), 'no dashes in the new code');
  // The other word (the one Sidd does not want) is spelled from its
  // letters so it never appears in this file either.
  const otherWord = new RegExp(['l', 'o', 's', 't'].join(''), 'i');
  assert.ok(!otherWord.test(block), 'the block never uses the other word');
  assert.ok(block.includes("'orders?select=passed&passed=not.is.null&passed->>at=gte.'"), 'the read is the one PostgREST query');
  assert.ok(block.includes('&limit=500'), 'the read is bounded');
  assert.ok(block.includes('await fetchSb(env,'), 'the read goes through the guarded fetchSb (never throws, null on error)');
  assert.ok(block.includes("'Passed leads this month: '"), 'the exact line prefix');
  pass('wiring: called from runDailyDigest between reconfirmations and payroll, one bounded guarded read, the word is passed, no dashes');
}

console.log(`\nPASS: ${passed} passed-leads checks. No network, no database, no Telegram.`);

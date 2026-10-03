// Tests for the Email reader in worker.js (migration 056, DEAL-FACTS-SPEC.md
// section 2): extractCoconutCounts, the strict coconut-count reader, and
// runDealFactScan, the 5-minute tick that sends 056 numbers and reason
// codes only.
//
// Run it with:  node worker/test-deal-facts.mjs
//
// No test framework and no network. The global fetch is swapped for a fake
// that plays Supabase (056's two functions and the intake read), so nothing
// here can touch the real database. Every email below is made up in the
// shape of real mail (Outlook, Gmail, Apple Mail, the website form).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { extractCoconutCounts, runDealFactScan, dealFactsOn, dealFactReportItemOk } from './worker.js';

const cases = [];
function test(name, fn) { cases.push({ name, fn }); }

// Short form: [result, value, reason] plus otherValues when given.
function expectFact(text, want, opts) {
  const got = extractCoconutCounts(text, opts || {});
  assert.equal(got.result, want[0], 'result for ' + JSON.stringify(text).slice(0, 80));
  assert.equal(got.value, want[1], 'value for ' + JSON.stringify(text).slice(0, 80));
  assert.equal(got.reason, want[2], 'reason for ' + JSON.stringify(text).slice(0, 80));
  if (want[3]) assert.deepEqual(got.otherValues, want[3], 'otherValues for ' + JSON.stringify(text).slice(0, 80));
  return got;
}
const EV = { eventDate: '2026-10-27' };

// ── 1) the spec's own vectors (section 2c) ─────────────────────────
test('spec 2c: clear counts', () => {
  expectFact('350 coconuts', ['one', 350, null]);
  expectFact('Coconuts: 350', ['one', 350, null]);
  expectFact('350 fresh young coconuts', ['one', 350, null]);
  expectFact('1,350 coconuts', ['one', 1350, null]);
  expectFact('For Oct 27, 350 coconuts', ['one', 350, null], EV);
});

test('spec 2c: never a count (money, guests)', () => {
  expectFact('$350', ['none', null, null]);
  expectFact('350 guests', ['none', null, null]);
  expectFact('350 guests, coconuts for all', ['none', null, null]);
  expectFact('for 350 people we want coconuts', ['none', null, null]);
});

test('spec 2c: unclear counts carry their reason', () => {
  expectFact('1 350 coconuts', ['unclear', null, 'thousands_unclear']);
  expectFact('about 350 coconuts', ['unclear', 350, 'hedge']);
  expectFact('300 to 350 coconuts', ['unclear', 350, 'range']);
  expectFact('add 100 more coconuts', ['unclear', 100, 'change_word']);
  expectFact('can we cut 50 coconuts', ['unclear', 50, 'change_word']);
  expectFact('350 coconuts per day for 2 days', ['unclear', 350, 'per_unit']);
  expectFact('2 x 175 coconuts', ['unclear', 175, 'multiply']);
  expectFact('last year we did 350 coconuts', ['unclear', 350, 'other_event']);
  expectFact('For the Nov 5 event we need 350 coconuts', ['unclear', 350, 'date_mismatch'], EV);
  expectFact('5,500 coconuts', ['unclear', 5500, 'out_of_range']);
});

test('spec 2c: two different counts = several', () => {
  expectFact('We need 350 coconuts.\n\nSorry, make that 300 coconuts.', ['several', 300, 'two_values', [350]]);
});

test('spec 2c: quotes, forwards and > lines are never her words', () => {
  const outlook = 'Thanks Sidd, all good on our end.\r\n\r\n________________________________\r\n' +
    'From: Sidd Saxena <sidd@hamptonscoconuts.com>\r\nSent: Tuesday, September 29, 2026 10:00 AM\r\n' +
    'To: Test Customer <customer@example.invalid>\r\nSubject: Your coconuts for Tuesday, October 27\r\n\r\n' +
    'Hi Test Customer,\r\n\r\n  *   Count: 350 coconuts\r\n  *   Drop off: 1 Example Plaza, New York, NY\r\n';
  expectFact(outlook, ['none', null, null], EV);
  expectFact('Sounds great, thank you!\n\nOn Tue, Sidd wrote: 350 coconuts at $10', ['none', null, 'quoted_only']);
  expectFact('FYI\n\n---------- Forwarded message ---------\nFrom: Planner <p@example.invalid>\n' +
    'Date: Mon, Sep 28, 2026 at 9:00 AM\nSubject: coconuts\n\n350 coconuts please', ['none', null, 'quoted_only']);
  expectFact('> 350 coconuts', ['none', null, 'quoted_only']);
});

test('spec 2c: an attachment alone can only suggest', () => {
  expectFact('=== ATTACHMENT: plan.pdf (PDF text, 2 pages) ===\n350 coconuts', ['unclear', 350, 'attachment_only']);
  expectFact('See the plan attached.\n\n=== ATTACHMENT: plan.pdf (PDF text, 2 pages) ===\nBar: 100 coconuts\nPool: 250 coconuts',
    ['unclear', null, 'attachment_only', [100, 250]]);
  // Her own words win over the attachment.
  expectFact('We want 300 coconuts.\n\n=== ATTACHMENT: plan.pdf (PDF text, 1 page) ===\n350 coconuts', ['one', 300, null]);
});

// ── 2) Test Customer's pattern: three follow-ups, each saying 350 coconuts ──
// Made-up text in the shape of her three emails (intake 70739, 70746,
// 70750): a company domain, a signature with a phone and a link, Gmail
// and Outlook quotes of our own quote under her words.
const TEST_CUSTOMER_SIG = '\n\nBest,\nTest Customer\n\nTest Customer\nEvents | Example Client\n(917) 555-0142\nwww.example.invalid\n';
const TEST_CUSTOMER_1 = 'Hi Sidd,\n\nFollowing up on our quote request. We will need 350 coconuts for our event on October 27th.' + TEST_CUSTOMER_SIG;
const TEST_CUSTOMER_2 = 'Hi Sidd,\n\nJust confirming the count: 350 coconuts, branded with our logo.' + TEST_CUSTOMER_SIG +
  '\nOn Tue, Sep 29, 2026 at 10:00 AM Sidd Saxena <sidd@hamptonscoconuts.com>\nwrote:\n\n> Hi Test Customer, 300 coconuts at $10 each would be $3,000.\n';
const TEST_CUSTOMER_3 = 'Hi Sidd,\r\n\r\nCoconuts: 350\r\nDelivery Oct 27 by 2:30 pm, please.\r\n' + TEST_CUSTOMER_SIG.replace(/\n/g, '\r\n') +
  '\r\n________________________________\r\nFrom: Sidd Saxena <sidd@hamptonscoconuts.com>\r\nSent: Wednesday, September 30, 2026 4:12 PM\r\n' +
  'To: Test Customer R. <customer@example.invalid>\r\nSubject: RE: Coconuts for Example Client\r\n\r\nHappy to help. 300 coconuts works on our side.\r\n';

test('Test Customer: each of her three emails reads one 350 (quotes of our 300 never count)', () => {
  for (const body of [TEST_CUSTOMER_1, TEST_CUSTOMER_2, TEST_CUSTOMER_3]) {
    const got = expectFact(body, ['one', 350, null], EV);
    assert.equal(got.formNotice, false);
    assert.deepEqual(got.otherValues, []);
  }
});

test('Test Customer: the same words with no deal date, or another year, are a date mismatch', () => {
  expectFact(TEST_CUSTOMER_1, ['unclear', 350, 'date_mismatch'], { eventDate: null });
  expectFact('We will need 350 coconuts on October 27th, 2025.', ['unclear', 350, 'date_mismatch'], EV);
  expectFact('We will need 350 coconuts on October 27th, 2026.', ['one', 350, null], EV);
});

// ── 3) the website form notice (Graph plain text, as in Jarvis's tests) ──
function formNotice(fields, opts = {}) {
  const parts = ["You've received a new form submission. --", 'New form submission on Hamptons Coconuts Quote Requests',
    "Someone just submitted a form on hamptonscoconuts.com/. Here's what they had to say:"];
  for (const [label, value] of fields) { parts.push(label); if (value !== '') parts.push(value); }
  const lines = opts.noPreheader ? parts.slice(1) : parts;
  return lines.join('\r\n\r\n') + '\r\n';
}
const FORM_BASE = [['name', 'Kayla Example'], ['email', 'kayla@example.com'], ['phone', '6315550142'],
  ['event_date', '2026-10-10'], ['event_type', 'wedding'], ['delivery_market', 'Hamptons (NY)']];

test('form: a message field saying 350 coconuts reads one 350 with formNotice true', () => {
  const body = formNotice([...FORM_BASE, ['coconut_count', ''], ['budget', '$1,000 to $2,000'], ['message', 'We would love 350 coconuts']]);
  const got = expectFact(body, ['one', 350, null], { eventDate: '2026-10-10' });
  assert.equal(got.formNotice, true);
});

test('form: the coconut_count field is read like "Coconuts: N"', () => {
  const body = formNotice([...FORM_BASE, ['coconut_count', '200'], ['budget', '$2,000'], ['message', 'Beach wedding']]);
  assert.equal(extractCoconutCounts(body, { eventDate: '2026-10-10' }).formNotice, true);
  expectFact(body, ['one', 200, null], { eventDate: '2026-10-10' });
  expectFact(formNotice([...FORM_BASE, ['coconut_count', '150-200'], ['message', 'hi']]), ['unclear', 150, 'range']);
  expectFact(formNotice([...FORM_BASE, ['coconut_count', 'TBD'], ['message', 'hi']]), ['none', null, null]);
});

test('form: the count field and the message disagree = several', () => {
  const body = formNotice([...FORM_BASE, ['coconut_count', '100'], ['message', 'Actually 350 coconuts']]);
  expectFact(body, ['several', 350, 'two_values', [100]]);
});

test('form: a count label seen twice is given up; labels and budget never count', () => {
  const twice = formNotice([...FORM_BASE, ['coconut_count', '100'], ['message', 'coconut_count'], ['x', '300']]);
  expectFact(twice, ['none', null, null]);
  const quiet = formNotice([...FORM_BASE, ['coconut_count', ''], ['budget', '$3,500'], ['message', '200 guests, beach wedding']]);
  expectFact(quiet, ['none', null, null]);
});

test('form: the heading must be in the first 3 non-blank lines', () => {
  expectFact(formNotice([...FORM_BASE, ['message', '350 coconuts']], { noPreheader: true }), ['one', 350, null]);
  const quotedForm = 'Hi,\n\nThanks so much!\n\nOne more line\n\n' + formNotice([...FORM_BASE, ['message', '120 coconuts']]);
  const got = extractCoconutCounts(quotedForm);
  assert.equal(got.formNotice, false);
});

// ── 4) the traps ───────────────────────────────────────────────────
test('trap: quote headers of every client cut the body (fresh words still read)', () => {
  expectFact("Let's do 400 coconuts.\n\nOn Tue, Sep 29, 2026 at 10:00 AM Sidd Saxena <sidd@hamptonscoconuts.com> wrote:\n> 350 coconuts at $10",
    ['one', 400, null]);
  expectFact('Perfect.\n\n-----Original Message-----\nFrom: Sidd\nSent: Monday\n\n350 coconuts', ['none', null, 'quoted_only']);
  expectFact('see below\n\nBegin forwarded message:\n\nFrom: Jane <jane@example.invalid>\nDate: September 28, 2026\n\n350 coconuts',
    ['none', null, 'quoted_only']);
  // An Outlook header block from ANY sender cuts, not only ours.
  expectFact('Adding Mark.\n\nFrom: Mark Planner <mark@example.invalid>\nSent: Monday, September 28, 2026 9:00 AM\nTo: Test Customer\n\n350 coconuts',
    ['none', null, 'quoted_only']);
  // A plain "On Oct 27 we need ..." line is not a quote header.
  expectFact('On Oct 27 we need 350 coconuts.\nThanks!', ['one', 350, null], EV);
});

test('trap: signatures, our company name and our own bullet are never a count', () => {
  expectFact('Sounds good.\n--\nTest Customer\n350 coconuts were great last time', ['none', null, null]);
  expectFact('Thanks!\n\nSidd Saxena | Hamptons Coconuts | 732-555-0100', ['none', null, null]);
  expectFact('  *   Count: 350 coconuts\n  *   Drop off: 1 Example Plaza', ['none', null, null]);
  expectFact('\u2022 Count: 1,350 coconuts', ['none', null, null]);
});

test('trap: money, phones, emails and links are blanked first', () => {
  expectFact('350 coconuts at $10 each, so $3,500 total', ['one', 350, null]);
  expectFact('$3,500 for the coconuts', ['none', null, null]);
  expectFact('USD 350 of coconuts', ['none', null, null]);
  expectFact('350 dollars of coconuts', ['none', null, null]);
  expectFact('Call 201-555-0104 about the coconuts', ['none', null, null]);
  expectFact('Email coconuts350@example.com or see www.example.invalid', ['none', null, null]);
  expectFact('350 coconuts at 2:30 pm', ['one', 350, null]);
  expectFact('350 coconuts by 2pm please', ['one', 350, null]);
});

test('trap: guest words own their own number only', () => {
  expectFact('Coconuts: 350 guests', ['none', null, 'guest_word']);
  expectFact('Coconut count of 350 people', ['none', null, 'guest_word']);
  expectFact('We have 200 guests and need 150 coconuts', ['one', 150, null]);
  expectFact('350 coconuts for 350 guests', ['one', 350, null]);
  expectFact('350 coconuts for our guests', ['one', 350, null]);
  expectFact('we expect 350 attendees and want coconuts for each', ['none', null, null]);
});

test('trap: ranges', () => {
  expectFact('300-350 coconuts', ['unclear', 350, 'range']);
  expectFact('300 \u2013 350 coconuts', ['unclear', 350, 'range']);
  expectFact('between 300 and 350 coconuts', ['unclear', 350, 'range']);
  expectFact('Coconuts: 300-350', ['unclear', 300, 'range']);
  expectFact('300 or 350 coconuts', ['unclear', 350, 'range']);
  expectFact('300/350 coconuts', ['unclear', 350, 'range']);
});

test('trap: hedges', () => {
  expectFact('~350 coconuts', ['unclear', 350, 'hedge']);
  expectFact('350ish coconuts', ['unclear', 350, 'hedge']);
  expectFact('350 coconuts or so', ['unclear', 350, 'hedge']);
  expectFact('up to 350 coconuts', ['unclear', 350, 'hedge']);
  expectFact('at least 300 coconuts', ['unclear', 300, 'hedge']);
  expectFact('approx. 350 coconuts', ['unclear', 350, 'hedge']);
  expectFact('Coconuts: about 350', ['unclear', 350, 'hedge']);
  expectFact('Coconuts: ~350', ['unclear', 350, 'hedge']);
  expectFact('350 coconuts max', ['unclear', 350, 'hedge']);
  expectFact('maybe 350 coconuts', ['unclear', 350, 'hedge']);
});

test('trap: change words (a reply that changes a count is never a total)', () => {
  expectFact('50 fewer coconuts please', ['unclear', 50, 'change_word']);
  expectFact('another 40 coconuts', ['unclear', 40, 'change_word']);
  expectFact('please reduce to 300 coconuts', ['unclear', 300, 'change_word']);
  expectFact('can you remove 25 coconuts', ['unclear', 25, 'change_word']);
  expectFact('increase to 400 coconuts', ['unclear', 400, 'change_word']);
  expectFact('350 coconuts instead of 300 coconuts', ['several', null, 'two_values', [350, 300]]);
  // "drop off" is a delivery, not a change.
  expectFact('Please drop off 350 coconuts at the venue', ['one', 350, null]);
  expectFact('Drop-off of 350 coconuts at noon', ['one', 350, null]);
});

test('trap: per-day, per-station and multiplied counts', () => {
  expectFact('350 coconuts each day', ['unclear', 350, 'per_unit']);
  expectFact('350 coconuts a day', ['unclear', 350, 'per_unit']);
  expectFact('175 coconuts per station', ['unclear', 175, 'per_unit']);
  expectFact('each day we need 200 coconuts', ['unclear', 200, 'per_unit']);
  expectFact('200 coconuts for both days', ['unclear', 200, 'per_unit']);
  expectFact('2x175 coconuts', ['unclear', 175, 'multiply']);
  expectFact('175 coconuts x 2', ['unclear', 175, 'multiply']);
  expectFact('175 coconuts times two', ['unclear', 175, 'multiply']);
});

test('trap: other events and other dates in the same paragraph', () => {
  expectFact('For our next event, 200 coconuts', ['unclear', 200, 'other_event']);
  expectFact('Also for the holiday party, 200 coconuts', ['unclear', 200, 'other_event']);
  expectFact('We did 300 coconuts previously.\n\nThis time 350 coconuts.', ['several', 350, 'two_values', [300]]);
  // The other event sits in ANOTHER paragraph: this paragraph is clean.
  expectFact('Last year was a blast!\n\nThis year we need 350 coconuts.', ['one', 350, null]);
  expectFact('10/27: 350 coconuts', ['one', 350, null], EV);
  expectFact('2026-10-27 delivery, 350 coconuts', ['one', 350, null], EV);
  expectFact('27th of October, 350 coconuts', ['one', 350, null], EV);
  expectFact('On 10/28 we need 350 coconuts', ['unclear', 350, 'date_mismatch'], EV);
  expectFact('Setup Oct 26, event Oct 27: 350 coconuts', ['unclear', 350, 'date_mismatch'], EV);
});

test('trap: thousands, decimals and the 10 to 5000 bounds', () => {
  expectFact('2,000 coconuts', ['one', 2000, null]);
  expectFact('1.350 coconuts', ['unclear', null, 'thousands_unclear']);
  expectFact('1.5k coconuts', ['unclear', null, 'thousands_unclear']);
  expectFact('Coconuts: 1 350', ['unclear', null, 'thousands_unclear']);
  expectFact('Coconuts: 350.', ['one', 350, null]);
  expectFact('5 coconuts for the tasting', ['unclear', 5, 'out_of_range']);
  expectFact('10 coconuts', ['one', 10, null]);
  expectFact('5,000 coconuts', ['one', 5000, null]);
  // Over 20000 cannot even be stored: the reason stays, the value goes.
  expectFact('25,000 coconuts', ['unclear', null, 'out_of_range']);
});

test('shapes: spelling, case, line endings and the same count twice', () => {
  expectFact('three hundred coconuts', ['none', null, null]);      // spelled out = a silent miss
  expectFact('COCONUTS: 350', ['one', 350, null]);
  expectFact('350 cocos', ['one', 350, null]);
  expectFact('a 350-coconut order', ['one', 350, null]);
  expectFact('Coconut qty = 350', ['one', 350, null]);
  // Only the fixed word list may sit between the number and "coconuts".
  expectFact('350 big coconuts', ['none', null, null]);
  expectFact('for 20 tables with coconuts', ['none', null, null]);
  expectFact('350 Thai young coconuts', ['one', 350, null]);
  expectFact('350 fresh young drinking coconuts', ['none', null, null]);    // 3 words is one too many
  expectFact('Coconuts: 350\r\n\r\nYes, 350 coconuts confirmed.', ['one', 350, null]);
  expectFact('100 coconuts at the bar, 200 coconuts at the pool, 300 coconuts on the beach',
    ['several', 300, 'two_values', [100, 200]]);
  expectFact('', ['none', null, null]);
  expectFact(null, ['none', null, null]);
  expectFact('Coconuts sound great, can you send a quote?', ['none', null, null]);
});

// ── 4b) review fixes (2026-10-02): each vector gave a clean 'one' before ──
test('review: a long dense paragraph stays fast (the guest check is local)', () => {
  const fill = (unit) => { let s = ''; for (let i = 0; s.length < 20000; i++) s += unit(i); return s; };
  const shapes = [fill(() => 'Guests 120 Coconuts 150 '), fill(() => 'Coconuts: 350 guests '),
    fill((i) => (100 + (i % 900)) + ' coconuts guests '), '=== ATTACHMENT: a.pdf ===\n' + fill(() => 'Coconuts: 350 guests '),
    fill((i) => (10 + i) + ' coconuts '), fill((i) => 'Oct ' + (1 + (i % 28)) + ' 350 coconuts '),
    '350 coconuts ' + '!'.repeat(19000) + ' guests', fill((i) => (10 + i) + ' coconuts -> >> => ')];
  extractCoconutCounts(shapes[4]);   // warm up
  for (const text of shapes) {
    const t0 = performance.now();
    extractCoconutCounts(text, EV);
    const ms = performance.now() - t0;
    assert.ok(ms < 100, 'took ' + ms.toFixed(0) + ' ms for ' + JSON.stringify(text.slice(0, 40)));
  }
  // The local guest check gives the same answers as the old full scan
  // (15 vectors compared side by side on 2026-10-02).
  expectFact('Guests 120 Coconuts 150', ['none', null, 'guest_word']);
  expectFact('120 guests, 150 coconuts', ['none', null, 'guest_word']);
  expectFact('200 coconuts 50 guests', ['one', 200, null]);
  expectFact('100 guests 200 coconuts 300 guests', ['none', null, 'guest_word']);
  // A guest word more than 3 words away never owns the count.
  expectFact('Coconuts: 350 for all of our lovely guests', ['one', 350, null]);
  expectFact('Our guests will love these, we need 350 coconuts', ['one', 350, null]);
});

test('review: the same count on two days is per_unit, never half the total', () => {
  expectFact('Sat: 350 coconuts\nSun: 350 coconuts', ['unclear', 350, 'per_unit']);
  expectFact('Day 1: 350 coconuts\nDay 2: 350 coconuts', ['unclear', 350, 'per_unit']);
  expectFact('350 coconuts on Saturday and 350 coconuts on Sunday', ['unclear', 350, 'per_unit']);
  expectFact('350 coconuts for the weekend', ['unclear', 350, 'per_unit']);
  expectFact('350 coconuts for Friday and Saturday', ['unclear', 350, 'per_unit']);
  expectFact('350 coconuts for the 2-day event', ['unclear', 350, 'per_unit']);
  expectFact('Saturday:\n\n350 coconuts\n\nSunday:\n\n350 coconuts', ['unclear', 350, 'per_unit']);
  // A list in one paragraph (per bar, no day word) is per_unit too.
  expectFact('Bar 1: 350 coconuts\nBar 2: 350 coconuts', ['unclear', 350, 'per_unit']);
  // Her repeating herself in two paragraphs, one day: still one.
  expectFact('We need 350 coconuts for Tuesday.\n\nTo confirm, 350 coconuts.', ['one', 350, null]);
});

test('review: change, negation and hedge wording is never a clean count', () => {
  for (const text of ['Please go down to 300 coconuts', 'Can we lower it to 300 coconuts?', 'Make it 300 coconuts instead',
    '300 coconuts + 50 backup coconuts', '300 coconuts + backups', 'We no longer need 300 coconuts', 'Please cancel the 300 coconuts',
    'Not 300 coconuts, 250', 'Quick change: 300 coconuts', 'Updated count, 300 coconuts']) {
    expectFact(text, ['unclear', 300, 'change_word']);
  }
  for (const text of ['Coconuts: 350 \u2192 400', 'Coconuts: 350 >> 400', 'Coconuts: 350 -> 400', 'Coconuts: 350 => 400',
    'Coconuts: 350; actually 400']) {
    expectFact(text, ['unclear', 350, 'change_word']);
  }
  expectFact('Coconuts: 350, maybe 400', ['unclear', 350, 'hedge']);
  expectFact('350 coconuts (could go to 400)', ['unclear', 350, 'hedge']);
  expectFact('Coconuts: 350, will confirm', ['unclear', 350, 'hedge']);
  expectFact('We might want 350 coconuts', ['unclear', 350, 'hedge']);
  expectFact('Coconuts: 350+', ['unclear', 350, 'hedge']);
  // The rejected number is never the suggestion.
  expectFact('Sorry, 300 coconuts, not 350 coconuts', ['several', 300, 'two_values', [350]]);
  expectFact('need 350 coconuts, not 300 coconuts', ['several', 350, 'two_values', [300]]);
  expectFact('350 coconuts rather than 300 coconuts', ['several', 350, 'two_values', [300]]);
  expectFact('350 coconuts, not 300', ['one', 350, null]);
  // "Actually 350 coconuts" is her new count; polite asks stay clear.
  expectFact('Actually 350 coconuts', ['one', 350, null]);
  expectFact('Could you please send 350 coconuts?', ['one', 350, null]);
  expectFact('We are confirmed for 350 coconuts, thank you!', ['one', 350, null]);
});

test('review: a street, a place or a product is not a coconut count', () => {
  for (const text of ['Jane Doe | 350 Coconut Grove Ave, Miami', 'Our address is 350 Coconut Row, Palm Beach',
    'Deliver to 350 Coconut Ln', '350 coconut cups', '350 coconut waters', '350 coco cups', '350 coconuts drinks']) {
    expectFact(text, ['none', null, null]);
  }
  expectFact('a 350 coconut order', ['one', 350, null]);
  // Place words only reject the singular: a plural is an order.
  expectFact('We need 350 coconuts beach side by noon', ['one', 350, null]);
  expectFact('350 coconut, please', ['one', 350, null]);
});

test('review: more quote headers cut the body', () => {
  expectFact('Looks good\n\nFrom: Sidd Saxena <sidd@hamptonscoconuts.com>\nSubject: Re: coconuts\nTo: Test Customer\n\nWe can do 300 coconuts',
    ['none', null, 'quoted_only']);
  expectFact('Sounds good\n\nSidd Saxena wrote on Tue:\n300 coconuts', ['none', null, 'quoted_only']);
  expectFact('Danke\n\nAm Di., 29. Sept. 2026 um 10:00 Uhr schrieb Sidd Saxena <sidd@hamptonscoconuts.com>:\n300 coconuts',
    ['none', null, 'quoted_only']);
  expectFact('Merci\n\nLe mar. 29 sept. 2026, Sidd <sidd@hamptonscoconuts.com> a \u00e9crit :\n300 coconuts', ['none', null, 'quoted_only']);
  expectFact('Gracias\n\nEl mar, 29 sept 2026, Sidd <sidd@hamptonscoconuts.com> escribi\u00f3:\n300 coconuts', ['none', null, 'quoted_only']);
  // Her own words that mention "wrote" or "From:" are kept.
  expectFact('Here is what my boss wrote: 350 coconuts', ['one', 350, null]);
  expectFact('From: our planner, we need 350 coconuts', ['one', 350, null]);
  expectFact('Lets do 350 coconuts.\n\nOn Tue, Sep 29, 2026 at 10:00 AM Sidd <sidd@hamptonscoconuts.com>\nwrote:\n300 coconuts',
    ['one', 350, null]);
});

test('review: another year, hidden characters and odd spaces', () => {
  expectFact('We ordered 350 coconuts in 2025', ['unclear', 350, 'other_event'], EV);
  expectFact('At our 2025 event we had 350 coconuts', ['unclear', 350, 'other_event'], EV);
  expectFact('For our 2026 event, 350 coconuts', ['one', 350, null], EV);
  // A count that looks like a year is still the count.
  expectFact('Coconuts: 2025', ['one', 2025, null], EV);
  expectFact('An order of 2025 coconuts', ['one', 2025, null], EV);
  expectFact('3\u200b50 coconuts', ['one', 350, null]);
  expectFact('\ufeff350 coconuts', ['one', 350, null]);
  expectFact('1\u00a0350 coconuts', ['unclear', null, 'thousands_unclear']);
  expectFact('1\u202f350 coconuts', ['unclear', null, 'thousands_unclear']);
});

// Takeover review regressions: ordinary phrases that previously returned
// a clear count and were therefore eligible for automatic filling.
test('takeover: a rejection anywhere before the count in its clause prevents filling', () => {
  for (const text of ["We don't need 350 coconuts.", 'We don\u2019t need 350 coconuts.',
    'Please do not send us 350 coconuts.', 'We will not be ordering 350 coconuts.',
    'No 350 coconuts please.', 'We cannot use 350 coconuts.',
    'Do not, under any circumstances, send us 350 coconuts.',
    '350 coconuts is too many.', '350 coconuts are not needed.', '350 coconuts are unwanted.']) {
    expectFact(text, ['unclear', 350, 'change_word']);
  }
  // A rejected alternate number must not poison the preceding good one.
  expectFact('350 coconuts, not 300', ['one', 350, null]);
  expectFact('350 coconuts, not 300 coconuts', ['several', 350, 'two_values', [300]]);
  expectFact('No cups needed. We are confirmed for 350 coconuts.', ['one', 350, null]);
  expectFact('Actually 350 coconuts', ['one', 350, null]);
  expectFact('Could you please send 350 coconuts?', ['one', 350, null]);
});

test('takeover: a mobile one-line quote header ends customer words', () => {
  for (const header of ['From: Sidd <sidd@example.invalid> Sent: Tue, Oct 27, 2026 To: Client Subject: Quote',
    'From: Planner <planner@example.invalid> Date: 27 Oct 2026 Subject: Coconuts',
    '*From: Planner <planner@example.invalid> *To: Client *Subject: Quote']) {
    expectFact('Thanks, please hold.\n\n' + header + '\n\nWe can do 350 coconuts.', ['none', null, 'quoted_only'], EV);
    expectFact('Please send 400 coconuts.\n\n' + header + '\n\nWe can do 350 coconuts.', ['one', 400, null], EV);
  }
  expectFact('From: our planner, we need 350 coconuts', ['one', 350, null]);
});

test('takeover: numeric dates cannot bypass the different-event guard', () => {
  for (const date of ['10-28', '28-10', '28/10/2026', '10/28/26', '28.10.2026', '2026-10-28', '10/99/2026']) {
    expectFact('Delivery ' + date + ': 350 coconuts.', ['unclear', 350, 'date_mismatch'], EV);
  }
  for (const date of ['10-27', '27-10', '10/27/2026', '27/10/2026', '27.10.2026', '2026-10-27']) {
    expectFact('Delivery ' + date + ': 350 coconuts.', ['one', 350, null], EV);
  }
  // If both month/day orders are real, do not pick one to allow a fill.
  for (const eventDate of ['2026-10-11', '2026-11-10']) {
    expectFact('Delivery 10/11/2026: 350 coconuts.', ['unclear', 350, 'date_mismatch'], { eventDate });
  }
  expectFact('For 10-27, 350 coconuts', ['unclear', 350, 'date_mismatch']);
  expectFact('350 coconuts at $10 each', ['one', 350, null], EV);
});

test('takeover: recurring deliveries never become a one-event total', () => {
  for (const text of ['350 coconuts every Saturday for 4 weeks.', '350 coconuts every other Saturday.',
    'Every Saturday we would like a delivery of 350 coconuts.', '350 coconuts each Saturday for 4 weeks.',
    '350 coconuts weekly.', '350 coconuts monthly.', '350 coconuts for 4 weeks.',
    'The weekly event will need 350 coconuts.']) {
    expectFact(text, ['unclear', 350, 'per_unit']);
  }
  expectFact('We need 350 coconuts for Saturday.', ['one', 350, null]);
  expectFact('Please send 350 coconuts for the event on Oct 27.', ['one', 350, null], EV);
});

test('takeover: a truncated fresh message cannot authorize a count from its prefix', () => {
  const prefix = '350 coconuts\n';
  const exact = prefix + 'a'.repeat(20000 - prefix.length);
  expectFact(exact, ['one', 350, null]);
  expectFact(exact + 'a', ['unclear', null, 'no_value']);
  expectFact(exact + '\n\nActually change this to 500 coconuts.', ['unclear', null, 'no_value']);
  expectFact('a'.repeat(20000) + '\n350 coconuts', ['unclear', null, 'no_value']);
  // A proven boundary lets us keep a complete short answer even when its
  // quoted history, signature or attachment goes beyond the read budget.
  expectFact(prefix + '\nOn Tue, Sidd wrote:\n' + 'a'.repeat(21000), ['one', 350, null]);
  expectFact(prefix + '\n--\n' + 'a'.repeat(21000), ['one', 350, null]);
  expectFact(prefix + '\n=== ATTACHMENT: a.pdf ===\n' + 'a'.repeat(21000), ['one', 350, null]);
  expectFact('a'.repeat(20001) + '\nOn Tue, Sidd wrote:\n350 coconuts', ['unclear', null, 'no_value']);
});

// Every vector above, wrapped as a report item, passes 056's shape rules.
const CORPUS = ['350 coconuts', '1 350 coconuts', 'about 350 coconuts', '$350', '350 coconuts\n\n300 coconuts',
  '=== ATTACHMENT: a.pdf (PDF text, 1 page) ===\n100 coconuts\n\n200 coconuts', '> 350 coconuts', 'Coconuts: 350 guests',
  '25,000 coconuts', '5 coconuts', TEST_CUSTOMER_1, TEST_CUSTOMER_2, TEST_CUSTOMER_3, '350 coconuts instead of 300 coconuts', '1.5k coconuts',
  "We don't need 350 coconuts.", 'For 10-28 we need 350 coconuts.', '350 coconuts every Saturday for 4 weeks.',
  '350 coconuts\n' + 'a'.repeat(21000), 'Thanks.\nFrom: Sidd Sent: Tuesday To: Client\n\n350 coconuts'];
test('every result fits the 056 report item shape exactly', () => {
  for (const text of CORPUS) {
    for (const eventDate of ['2026-10-27', null]) {
      const f = extractCoconutCounts(text, { eventDate });
      const item = { intake_id: 1, order_id: ORDER, link_id: 2, result: f.result, value: f.value,
        reason: f.reason, other_values: f.otherValues, form_notice: f.formNotice };
      assert.ok(dealFactReportItemOk(item), 'bad shape for ' + JSON.stringify(text).slice(0, 60) + ': ' + JSON.stringify(f));
    }
  }
  // And the checker itself refuses the shapes 056 refuses.
  const ok = { intake_id: 1, order_id: ORDER, link_id: 2, result: 'one', value: 350, reason: null, other_values: [], form_notice: false };
  assert.ok(dealFactReportItemOk(ok));
  assert.equal(dealFactReportItemOk({ ...ok, value: 5 }), false);              // one needs 10 to 5000
  assert.equal(dealFactReportItemOk({ ...ok, value: '350' }), false);          // never a string
  assert.equal(dealFactReportItemOk({ ...ok, reason: 'hedge' }), false);       // one has no reason
  assert.equal(dealFactReportItemOk({ ...ok, result: 'unclear' }), false);     // unclear needs one
  assert.equal(dealFactReportItemOk({ ...ok, result: 'none' }), false);        // none has no value
  assert.equal(dealFactReportItemOk({ ...ok, other_values: [1, 2, 3, 4] }), false);
  assert.equal(dealFactReportItemOk({ ...ok, subject: 'x' }), false);          // exactly 8 keys
});

// ── 5) the scan against a fake network ─────────────────────────────
const ORDER = '0b6c1d2e-3f40-4a5b-8c6d-7e8f90a1b2c3';
let calls = [];
let db = {};
function resetFake(extra = {}) {
  calls = [];
  db = { tickStatus: 200, tickBody: null, tickThrows: false, readStatus: 200, reportStatus: 200,
    bodies: {}, reports: [], ...extra };
}
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const json = (status, body) => ({ ok: status >= 200 && status < 300, status,
    json: async () => body, text: async () => JSON.stringify(body) });
  assert.equal((init.headers || {}).apikey, 'not-a-real-key');
  if (u === 'https://example.invalid/rest/v1/rpc/hc_crm_facts_tick') {
    calls.push('tick');
    assert.equal(init.method, 'POST');
    assert.equal(init.body, '{"p":{"v":1,"limit":10}}');
    if (db.tickThrows) throw new Error('network down');
    if (db.tickStatus !== 200) return json(db.tickStatus, db.tickBody || { message: 'nope' });
    return json(200, db.tickBody);
  }
  if (u.startsWith('https://example.invalid/rest/v1/intake_messages?')) {
    calls.push('read');
    db.readUrl = u;
    assert.equal(init.method, undefined);
    if (db.readStatus !== 200) return json(db.readStatus, { message: 'nope' });
    if (db.readBody !== undefined) return json(200, db.readBody);
    const ids = /id=in\.\(([\d,]+)\)/.exec(u)[1].split(',').map(Number);
    return json(200, ids.filter((id) => id in db.bodies).map((id) => ({ id, raw_text: db.bodies[id] })));
  }
  if (u === 'https://example.invalid/rest/v1/rpc/hc_crm_facts_report') {
    calls.push('report');
    db.reportRaw = init.body;
    db.reports.push(JSON.parse(init.body));
    if (db.reportStatus !== 200) return json(db.reportStatus, { message: 'nope' });
    if (db.reportBody !== undefined) return json(200, db.reportBody);
    return json(200, { v: 1, code: 'ok', counts: { applied: 1, would_apply: 0, suggested: 0, info: 0, same: 2,
      ignored: 0, closed: 0, waited: 0, skipped: 0, repeat: 0, bad: 0 } });
  }
  throw new Error('unexpected fetch in test: ' + u);
};
const env = { SUPABASE_URL: 'https://example.invalid', SUPABASE_SERVICE_KEY: 'not-a-real-key', DEAL_FACTS: 'on' };
const tickItem = (intake, extra = {}) => ({ intake_id: intake, order_id: ORDER, link_id: intake + 1000,
  event_date: '2026-10-27', open_lead: true, on_file: null, ...extra });
const tickOk = (items, mode = 'on') => ({ v: 1, code: 'ok', mode, closed: 0, items });

// Captures console.log lines while fn runs.
async function logsOf(fn) {
  const lines = [];
  const realLog = console.log;
  console.log = (...a) => { lines.push(a.join(' ')); };
  try { await fn(); } finally { console.log = realLog; }
  return lines;
}

test('switch: DEAL_FACTS unset, blank, off or mistyped = no call at all', async () => {
  for (const value of [undefined, '', 'off', 'yes', ' on']) {
    resetFake({ tickBody: tickOk([tickItem(70739)]) });
    await runDealFactScan({ ...env, DEAL_FACTS: value });
    assert.deepEqual(calls, [], 'value ' + JSON.stringify(value));
  }
  assert.equal(dealFactsOn({ DEAL_FACTS: 'on' }), true);
  assert.equal(dealFactsOn({ DEAL_FACTS: 'ON' }), true);
  assert.equal(dealFactsOn({}), false);
});

test('056 not live: a 404 or PGRST202 logs one line and stops', async () => {
  resetFake({ tickStatus: 404, tickBody: { code: 'PGRST202', message: 'Could not find the function' } });
  const lines = await logsOf(() => runDealFactScan(env));
  assert.deepEqual(calls, ['tick']);
  assert.deepEqual(lines, ['deal facts: hc_crm_facts_tick answered 404, 056 is not live']);
  resetFake({ tickStatus: 400, tickBody: { code: 'PGRST202' } });
  assert.deepEqual(await logsOf(() => runDealFactScan(env)), ['deal facts: hc_crm_facts_tick answered 404, 056 is not live']);
  resetFake({ tickStatus: 403, tickBody: { code: '42501', message: 'Robot only.' } });
  assert.deepEqual(await logsOf(() => runDealFactScan(env)), ['deal facts: hc_crm_facts_tick answered 403 (42501)']);
});

test('a network failure never throws and stops after the one call', async () => {
  resetFake({ tickThrows: true });
  await runDealFactScan(env);
  assert.deepEqual(calls, ['tick']);
});

test('mode off, or no new emails: only the tick runs', async () => {
  resetFake({ tickBody: { v: 1, code: 'ok', mode: 'off', closed: 2, items: [] } });
  assert.deepEqual(await logsOf(() => runDealFactScan(env)), ['deal facts: none (off, closed 2)']);
  assert.deepEqual(calls, ['tick']);
  resetFake({ tickBody: tickOk([], 'shadow') });
  assert.deepEqual(await logsOf(() => runDealFactScan(env)), ['deal facts: none (no new emails, mode shadow, closed 0)']);
  assert.deepEqual(calls, ['tick']);
  resetFake({ tickBody: { v: 1, code: 'bad_input', mode: null, closed: 0, items: [] } });
  assert.deepEqual(await logsOf(() => runDealFactScan(env)), ['deal facts: tick code bad_input']);
});

test('Test Customer: three emails, three calls, three items of numbers and codes only', async () => {
  resetFake({ tickBody: tickOk([tickItem(70739), tickItem(70746), tickItem(70750)]),
    bodies: { 70739: TEST_CUSTOMER_1, 70746: TEST_CUSTOMER_2, 70750: TEST_CUSTOMER_3 } });
  const lines = await logsOf(() => runDealFactScan(env));
  assert.deepEqual(calls, ['tick', 'read', 'report']);
  assert.equal(db.readUrl, 'https://example.invalid/rest/v1/intake_messages?id=in.(70739,70746,70750)&select=id,raw_text');
  const body = db.reports[0];
  assert.deepEqual(Object.keys(body), ['p']);
  assert.deepEqual(Object.keys(body.p), ['v', 'items']);
  assert.equal(body.p.v, 1);
  assert.equal(body.p.items.length, 3);
  for (const [n, item] of body.p.items.entries()) {
    assert.deepEqual(Object.keys(item), ['intake_id', 'order_id', 'link_id', 'result', 'value', 'reason', 'other_values', 'form_notice']);
    assert.deepEqual(item, { intake_id: [70739, 70746, 70750][n], order_id: ORDER, link_id: [71739, 71746, 71750][n],
      result: 'one', value: 350, reason: null, other_values: [], form_notice: false });
  }
  // No email words anywhere in what leaves the worker, or in the log.
  for (const word of ['Test Customer', 'Tie', 'thetie', 'coconut', 'Sidd', '917', '@', 'logo', 'October']) {
    assert.ok(!db.reportRaw.includes(word), 'report carries ' + word);
    assert.ok(!lines.join('\n').includes(word), 'log carries ' + word);
  }
  assert.deepEqual(lines, ['deal facts: ok, mode on, read 3, tick closed 0, applied 1, would_apply 0, suggested 0, info 0, ' +
    'same 2, ignored 0, closed 0, waited 0, skipped 0, repeat 0, bad 0']);
});

test('mixed tick: quoted, guest, attachment and form rows each report their code', async () => {
  const form = formNotice([...FORM_BASE, ['coconut_count', '120'], ['message', 'hi']]);
  resetFake({ tickBody: tickOk([tickItem(1), tickItem(2), tickItem(3), tickItem(4, { event_date: null })]),
    bodies: { 1: 'Perfect!\n\nOn Tue, Sidd wrote: 350 coconuts', 2: 'Coconuts: 350 guests',
      3: '=== ATTACHMENT: run.pdf (PDF text, 2 pages) ===\n180 coconuts', 4: form } });
  await runDealFactScan(env);
  const got = db.reports[0].p.items.map((i) => [i.intake_id, i.result, i.value, i.reason, i.form_notice]);
  assert.deepEqual(got, [[1, 'none', null, 'quoted_only', false], [2, 'none', null, 'guest_word', false],
    [3, 'unclear', 180, 'attachment_only', false], [4, 'one', 120, null, true]]);
});

test('takeover: all five unsafe emails remain non-fillable in the actual report', async () => {
  resetFake({ tickBody: tickOk([1, 2, 3, 4, 5].map((id) => tickItem(id))), bodies: {
    1: "We don't need 350 coconuts.",
    2: 'Thanks, please hold.\n\nFrom: Sidd Sent: Tuesday To: Client Subject: Quote\n\n350 coconuts',
    3: 'For 10-28 we need 350 coconuts.',
    4: '350 coconuts every Saturday for 4 weeks.',
    5: '350 coconuts\n' + 'a'.repeat(21000) + '\nActually change this to 500 coconuts.',
  } });
  await logsOf(() => runDealFactScan(env));
  assert.deepEqual(calls, ['tick', 'read', 'report']);
  const items = db.reports[0].p.items;
  assert.equal(items.length, 5);
  assert.deepEqual(items.map((i) => [i.result, i.value, i.reason]), [
    ['unclear', 350, 'change_word'], ['none', null, 'quoted_only'],
    ['unclear', 350, 'date_mismatch'], ['unclear', 350, 'per_unit'], ['unclear', null, 'no_value'],
  ]);
  assert.ok(items.every((i) => i.result !== 'one' && dealFactReportItemOk(i)));
});

test('bad tick items are dropped, a missing body is never guessed, 10 items max', async () => {
  const items = [tickItem(5), { ...tickItem(6), order_id: 'not-a-uuid' }, { ...tickItem(7), intake_id: '7' },
    { ...tickItem(8), event_date: 'Oct 27' }, tickItem(9)];
  resetFake({ tickBody: tickOk(items), bodies: { 5: '350 coconuts' } });   // 9 has no row
  await runDealFactScan(env);
  assert.equal(db.readUrl, 'https://example.invalid/rest/v1/intake_messages?id=in.(5,9)&select=id,raw_text');
  assert.deepEqual(db.reports[0].p.items.map((i) => i.intake_id), [5]);
  const many = Array.from({ length: 14 }, (_, k) => tickItem(100 + k));
  const bodies = Object.fromEntries(many.map((it) => [it.intake_id, '200 coconuts']));
  resetFake({ tickBody: tickOk(many), bodies });
  await runDealFactScan(env);
  assert.deepEqual(calls, ['tick', 'read', 'report']);
  assert.equal(db.reports[0].p.items.length, 10);
});

test('one email on two deals is read once and reported for each deal', async () => {
  const other = '9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d';
  resetFake({ tickBody: tickOk([tickItem(40), { ...tickItem(40), order_id: other, link_id: 77 }]), bodies: { 40: '350 coconuts' } });
  await runDealFactScan(env);
  assert.equal(db.readUrl, 'https://example.invalid/rest/v1/intake_messages?id=in.(40)&select=id,raw_text');
  assert.deepEqual(db.reports[0].p.items.map((i) => [i.order_id, i.link_id]), [[ORDER, 1040], [other, 77]]);
});

test('a failed read or report stops quietly; nothing to report sends nothing', async () => {
  resetFake({ tickBody: tickOk([tickItem(50)]), readStatus: 500 });
  assert.deepEqual(await logsOf(() => runDealFactScan(env)), ['deal facts: intake read answered 500']);
  assert.deepEqual(calls, ['tick', 'read']);
  resetFake({ tickBody: tickOk([tickItem(51)]), bodies: { 51: '350 coconuts' }, reportStatus: 500 });
  assert.deepEqual(await logsOf(() => runDealFactScan(env)), ['deal facts: hc_crm_facts_report answered 500']);
  resetFake({ tickBody: tickOk([tickItem(52)]), bodies: {} });
  assert.deepEqual(await logsOf(() => runDealFactScan(env)), ['deal facts: nothing to report (mode on, offered 1)']);
  assert.deepEqual(calls, ['tick', 'read']);
});

test('a success answer of the wrong shape logs one line, never stops quietly', async () => {
  for (const body of [[], null, 7, 'ok']) {
    resetFake({ tickBody: body });
    assert.deepEqual(await logsOf(() => runDealFactScan(env)), ['deal facts: hc_crm_facts_tick answered 200 (not an object)'],
      'tick body ' + JSON.stringify(body));
    assert.deepEqual(calls, ['tick']);
  }
  resetFake({ tickBody: tickOk([tickItem(60)]), bodies: { 60: '350 coconuts' }, reportBody: [] });
  assert.deepEqual(await logsOf(() => runDealFactScan(env)), ['deal facts: hc_crm_facts_report answered 200 (not an object)']);
  resetFake({ tickBody: tickOk([tickItem(61)]), readBody: { id: 61 } });
  assert.deepEqual(await logsOf(() => runDealFactScan(env)), ['deal facts: intake read answered 200 (not a list)']);
  assert.deepEqual(calls, ['tick', 'read']);
});

test('a report answering off or bad_input logs its code and counts', async () => {
  for (const code of ['off', 'bad_input']) {
    resetFake({ tickBody: tickOk([tickItem(62)], 'shadow'), bodies: { 62: '350 coconuts' },
      reportBody: { v: 1, code, counts: { waited: 1 } } });
    assert.deepEqual(await logsOf(() => runDealFactScan(env)), ['deal facts: ' + code + ', mode shadow, read 1, tick closed 0, ' +
      'applied 0, would_apply 0, suggested 0, info 0, same 0, ignored 0, closed 0, waited 1, skipped 0, repeat 0, bad 0']);
  }
});

test('the scan is LAST in the 5-minute chain, after the webhook intake scan', () => {
  const src = fs.readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
  const chain = src.slice(src.indexOf("cron === '*/5 * * * *'"), src.indexOf('// Daily 8am ET'));
  const webhook = chain.indexOf('await runWebhookIntakeScan(env, 2);');
  const facts = chain.indexOf('await runDealFactScan(env);');
  assert.ok(webhook >= 0 && facts > webhook, 'order');
  assert.equal(chain.slice(facts).match(/await run/g).length, 1, 'nothing runs after it');
  // And it is called nowhere else.
  assert.equal(src.split('await runDealFactScan(env)').length - 1, 1);
});

// ── runner ─────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
for (const c of cases) {
  try { await c.fn(); passed++; console.log('ok    ' + c.name); }
  catch (e) { failed++; console.log('FAIL  ' + c.name + '\n      ' + ((e && e.message) || e)); }
}
console.log(passed + ' passed, ' + failed + ' failed, ' + cases.length + ' total');
if (failed) process.exit(1);

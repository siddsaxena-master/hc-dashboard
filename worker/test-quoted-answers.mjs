// Tests for the answers a customer types INSIDE the quoted copy of our
// reconfirmation email: quotedBulletAnswers in worker.js and the two
// paths that read it, the reply classifier (classifyReconfirmationReply
// with sent_body) and the time extractor (extractArrivalTimes over
// reconfirmAnswerFirstText). Every function here is pure: no network.
// The scans that wire them in are pinned in test-reconfirmation.mjs
// (the reply step's change note) and test-proposal-scan.mjs (the Time
// change? proposal).
//
// Run it with:  node worker/test-quoted-answers.mjs
//
// The Monday this exists for: 2026-09-21, Allie Sugano's reply to the
// first real reconfirmation email (order_reconfirmations row 2, sent
// 2026-09-20 19:02 UTC, intake 68785). Her own words were "Added the
// details below! Thank you"; the answers sat inside the quote, typed
// over our asks: "arrival time: please tell us" became "arrival time:
// 1:15pm - 1:30pm" and "On site contact: please send a name and cell"
// became "On site contact: Allie, <cell>". The worker read the one
// sentence (reply_kind changed, change_note that sentence) and found no
// time (linked_no_time notified). Nothing reached the card.
//
// Phones, emails and links below are swapped for 555 numbers and
// example.invalid; the SHAPE (Outlook's "  *" bullets with the edited
// items on the next line, the CRLF endings, the tel: link, the header
// block) is byte for byte what the poller stored.

import assert from 'node:assert/strict';
import {
  quotedBulletAnswers, reconfirmQuotedAnswerLines, reconfirmAnswerFirstText,
  classifyReconfirmationReply, extractArrivalTimes, stripQuotedText, reconfirmTemplate, reconfirmFacts,
} from './worker.js';

let passed = 0;
const pass = (m) => { passed++; console.log('PASS: ' + m); };

// The body we sent Allie (case B of the template: both asks, no picture).
const ALLIE_SENT = [
  'Hi Allie,',
  '',
  'Just sending the final details for reconfirmation. Two things we still need: what time our driver should arrive and who they should call on site. Once we have those two items, we are set.',
  '',
  '• Delivery: Wednesday, September 23, arrival time: please tell us',
  '• Drop off: 24 Spring St., New York, NY, 10012, US',
  '• Count: 40 coconuts',
  '• Cracking: straw hole pre-cracked, ready for straws',
  '• On site contact: please send a name and cell',
  '• Your contact: Sidd, 732.555.0199',
  '',
  'We brand and box on Tuesday, September 22, the day before, so changes need to reach us today.',
  '',
  'Thanks so much,',
  'Sidd',
  'Hamptons Coconuts',
].join('\n');
// Her reply as intake_messages.raw_text (intake 68785), shape for shape.
const ALLIE_RAW = 'Hi Sidd!\r\n\r\nAdded the details below! Thank you \r\n\r\n[photo]<https://example.invalid/>\r\nAllie Sugano\r\nDirector, Retail & Brand Activation\r\n[icon] + 1 (949) 555-0123<tel:714.555.0167>\r\n[icon] allie@example.invalid<mailto:allie@example.invalid>\r\n\r\nFrom: Sidd Saxena <sidd@hamptonscoconuts.com>\r\nDate: Sunday, September 20, 2026 at 12:02 PM\r\nTo: Allie Sugano <allie@example.invalid>\r\nSubject: Your coconuts for Wednesday, September 23: quick check\r\n\r\n\r\nHi Allie,\r\n\r\n\r\n\r\nJust sending the final details for reconfirmation. Two things we still need: what time our driver should arrive and who they should call on site. Once we have those two items, we are set.\r\n\r\n\r\n\r\n  *\r\nDelivery: Wednesday, September 23, arrival time: 1:15pm - 1:30pm\r\n  *   Drop off: 24 Spring St., New York, NY, 10012, US\r\n  *   Count: 40 coconuts\r\n  *   Cracking: straw hole pre-cracked, ready for straws\r\n  *\r\nOn site contact: Allie, 9495550123\r\n  *   Your contact: Sidd, 732.555.0199\r\n\r\n\r\n\r\nWe brand and box on Tuesday, September 22, the day before, so changes need to reach us today.\r\n\r\n\r\n\r\nThanks so much,\r\n\r\nSidd\r\n\r\nHamptons Coconuts';
const ALLIE_ANSWERS = [
  { label: 'Delivery', value: 'Wednesday, September 23, arrival time: 1:15pm - 1:30pm', placeholder: true },
  { label: 'On site contact', value: 'Allie, 9495550123', placeholder: true },
];
const ALLIE_LINES = ['Delivery: Wednesday, September 23, arrival time: 1:15pm - 1:30pm', 'On site contact: Allie, 9495550123'];
const HEADER = ['From: Sidd Saxena <sidd@hamptonscoconuts.com>', 'Date: Sunday, September 20, 2026 at 12:02 PM', 'To: Allie Sugano <allie@example.invalid>', 'Subject: Your coconuts for Wednesday, September 23: quick check', ''];
// Outlook's plain text of our HTML email quoted under a reply: the header
// block, then every "• Label: value" as "  *   Label: value", or as "  *"
// with the line under it when that label is in `edits` (the shape an
// item takes once the customer typed in it). CRLF throughout.
function outlookReply(top, sentBody, edits = {}) {
  const lines = sentBody.split('\n').map((l) => {
    const m = /^• ([^:]+): (.*)$/.exec(l);
    if (!m) return l;
    if (m[1] in edits) return '  *\r\n' + m[1] + ': ' + edits[m[1]];
    return '  *   ' + m[1] + ': ' + m[2];
  });
  return [top, '', ...HEADER, ...lines].join('\r\n');
}
const classify = (raw, extra = {}) => classifyReconfirmationReply({ subject: 'Re: Your coconuts for Wednesday, September 23: quick check', from_addr: 'allie@example.invalid', raw_text: raw, client_name: 'Allie Sugano', ...extra });

// ── 1. Allie's reply against the body we sent ───────────────────────
{
  assert.deepEqual(quotedBulletAnswers(ALLIE_RAW, ALLIE_SENT), ALLIE_ANSWERS);
  assert.deepEqual(reconfirmQuotedAnswerLines(ALLIE_RAW, ALLIE_SENT), ALLIE_LINES);
  // Only the two bullets that moved: the four we wrote ourselves are quoted back as sent.
  assert.equal(quotedBulletAnswers(ALLIE_RAW, ALLIE_SENT).length, 2);
  pass('Allie (intake 68785): the arrival time and the site contact typed over our two asks come back as the two answers, placeholder true, in the order we printed them');
}

// ── 2. An untouched quote answers nothing ───────────────────────────
{
  assert.deepEqual(quotedBulletAnswers(outlookReply('Confirmed, thanks!', ALLIE_SENT), ALLIE_SENT), []);
  // Outlook's own touches are not the customer's: a tel: link printed
  // after our cell, "St" for "St.", the "(picture below)" note dropped by
  // the droplet when the download failed, a wrapped line, a bold marker
  // a text rendering leaves around the label.
  const branded = ALLIE_SENT.replace('• Count: 40 coconuts', '• Count: 40 custom branded coconuts (picture below)');
  const touched = outlookReply('Confirmed', branded, { 'Your contact': 'Sidd, 732.555.0199<tel:732.555.0199>', 'Drop off': '24 Spring St, New York, NY, 10012, US', Count: '40 custom branded coconuts', Delivery: 'Wednesday, September 23, arrival\r\ntime: please tell us' })
    .replace('  *   Cracking:', '  *   *Cracking*:');
  assert.deepEqual(quotedBulletAnswers(touched, branded), []);
  // No sent body, or a body with no bullets: nothing to compare against.
  assert.deepEqual(quotedBulletAnswers(ALLIE_RAW, null), []);
  assert.deepEqual(quotedBulletAnswers(ALLIE_RAW, ''), []);
  assert.deepEqual(quotedBulletAnswers(ALLIE_RAW, 'b'), []);
  assert.deepEqual(quotedBulletAnswers('', ALLIE_SENT), []);
  assert.deepEqual(quotedBulletAnswers(null, ALLIE_SENT), []);
  // An emptied line ("Delivery:" with the ask deleted and nothing typed) is not an answer.
  assert.deepEqual(quotedBulletAnswers(outlookReply('See below', ALLIE_SENT, { Delivery: '' }), ALLIE_SENT), []);
  pass('an untouched quote, a mail client\'s own touches (tel: link, St for St., a dropped picture note, a wrap, a bold marker), no sent body and an emptied line all answer nothing');
}

// ── 3. A bullet we wrote ourselves, rewritten: placeholder false ────
{
  const count = outlookReply('Confirmed', ALLIE_SENT, { Count: '60 coconuts' });
  assert.deepEqual(quotedBulletAnswers(count, ALLIE_SENT), [{ label: 'Count', value: '60 coconuts', placeholder: false }]);
  const both = outlookReply('Hi Sidd', ALLIE_SENT, { Count: '60 coconuts', 'Drop off': '30 Spring St., New York, NY, 10012, US', 'On site contact': 'Allie, 9495550123' });
  assert.deepEqual(quotedBulletAnswers(both, ALLIE_SENT), [
    { label: 'Drop off', value: '30 Spring St., New York, NY, 10012, US', placeholder: false },
    { label: 'Count', value: '60 coconuts', placeholder: false },
    { label: 'On site contact', value: 'Allie, 9495550123', placeholder: true },
  ]);
  pass('a rewritten Count or Drop off bullet comes back with placeholder false (a change request), beside any answered ask');
}

// ── 4. The classifier: answers make the reply a change, answers first ─
{
  const v = classify(ALLIE_RAW, { sent_body: ALLIE_SENT });
  assert.equal(v.kind, 'changed');
  assert.deepEqual(v.answers, ALLIE_LINES);
  assert.ok(v.stripped.startsWith(ALLIE_LINES.join('\n') + '\nHi Sidd!\n\nAdded the details below! Thank you'), v.stripped);
  assert.ok(!v.stripped.includes('From: Sidd Saxena'), 'the quote itself is still dropped');
  // Without the sent body (an older row, a caller that has none) the reply reads exactly as before: one sentence.
  const before = classify(ALLIE_RAW);
  assert.equal(before.kind, 'changed'); assert.equal(before.answers, undefined);
  assert.equal(before.stripped, stripQuotedText(ALLIE_RAW));
  // A plain "Confirmed" over an untouched quote is still a confirmation;
  // over a rewritten count it is a change with the count first; a time in
  // the reply's own words over an untouched quote is still a time.
  assert.equal(classify(outlookReply('Confirmed, thanks!', ALLIE_SENT), { sent_body: ALLIE_SENT }).kind, 'confirmed');
  const count = classify(outlookReply('Confirmed', ALLIE_SENT, { Count: '60 coconuts' }), { sent_body: ALLIE_SENT });
  assert.equal(count.kind, 'changed'); assert.equal(count.stripped, 'Count: 60 coconuts\nConfirmed\n');
  assert.equal(classify(outlookReply('Can we do 4:00 PM for the coconut delivery instead?', ALLIE_SENT), { sent_body: ALLIE_SENT }).kind, 'time');
  // A time typed over "please tell us" alone is a change here (the note
  // carries it); the proposal scan makes the Time change? row from it.
  const timeOnly = classify(outlookReply('Added below', ALLIE_SENT, { Delivery: 'Wednesday, September 23, arrival time: 1:15pm - 1:30pm' }), { sent_body: ALLIE_SENT });
  assert.equal(timeOnly.kind, 'changed'); assert.deepEqual(timeOnly.answers, [ALLIE_LINES[0]]);
  // An auto reply and a bounce are sorted before the quote is read.
  assert.equal(classify(ALLIE_RAW, { subject: 'Automatic reply: Your coconuts', sent_body: ALLIE_SENT }).kind, 'auto_reply');
  assert.equal(classify(ALLIE_RAW, { from_addr: 'postmaster@example.invalid', sent_body: ALLIE_SENT }).kind, 'bounced');
  pass('classifier: with the sent body Allie\'s reply is changed with the two answer lines ahead of her own words; without it nothing moved; Confirmed over an untouched quote stays confirmed, over a rewritten count becomes a change; a top-of-email time stays a time; auto reply and bounce first');
}

// ── 5. The time extractor: the answered line proposes 1:15 PM ───────
{
  // The bug: the quote is stripped, so the raw text alone has no time.
  assert.deepEqual(extractArrivalTimes(ALLIE_RAW), []);
  const text = reconfirmAnswerFirstText(ALLIE_RAW, ALLIE_SENT);
  assert.ok(text.startsWith(ALLIE_LINES.join('\n') + '\nHi Sidd!'), text.slice(0, 120));
  assert.deepEqual(extractArrivalTimes(text), [{ hh: 13, mm: 15, label: '1:15 PM', line: 'Delivery: Wednesday, September 23, arrival time: 1:15pm - 1:30pm', where: 'body' }]);
  // The evidence line carries no phone: the contact answer is its own line.
  assert.ok(!/\d{10}/.test(extractArrivalTimes(text)[0].line));
  // No answers: the text is the email itself, unchanged.
  assert.equal(reconfirmAnswerFirstText(ALLIE_RAW, 'b'), ALLIE_RAW);
  assert.equal(reconfirmAnswerFirstText(outlookReply('Confirmed', ALLIE_SENT), ALLIE_SENT), outlookReply('Confirmed', ALLIE_SENT));
  // Our own quoted 3:30 PM is still never the answer: an untouched
  // "arriving 3:30 PM" bullet proposes nothing.
  const known = ALLIE_SENT.replace('arrival time: please tell us', 'arriving 3:30 PM');
  assert.deepEqual(extractArrivalTimes(reconfirmAnswerFirstText(outlookReply('Confirmed', known), known)), []);
  pass('extractor: the raw reply alone has no time (the bug), the answer-first text proposes 1:15 PM with the answered line as evidence and no phone in it; no answers leaves the email untouched; our own quoted 3:30 PM still proposes nothing');
}

// ── 6. Other quote shapes: "•" and ">" (Gmail, Apple Mail), "- " ────
{
  const gmail = 'Thanks Sidd, see below\r\n\r\nOn Sun, Sep 20, 2026 at 12:02 PM Sidd Saxena <sidd@hamptonscoconuts.com> wrote:\r\n> Hi Allie,\r\n>\r\n> • Delivery: Wednesday, September 23, arrival time: 1:15pm\r\n> • Drop off: 24 Spring St., New York, NY, 10012, US\r\n> • Count: 40 coconuts\r\n> • Cracking: straw hole pre-cracked, ready for straws\r\n> • On site contact: Allie, 949-555-0123\r\n> • Your contact: Sidd, 732.555.0199\r\n>\r\n> We brand and box on Tuesday, September 22, the day before, so changes need to reach us today.';
  assert.deepEqual(quotedBulletAnswers(gmail, ALLIE_SENT), [
    { label: 'Delivery', value: 'Wednesday, September 23, arrival time: 1:15pm', placeholder: true },
    { label: 'On site contact', value: 'Allie, 949-555-0123', placeholder: true },
  ]);
  assert.equal(classify(gmail, { sent_body: ALLIE_SENT }).kind, 'changed');
  assert.equal(extractArrivalTimes(reconfirmAnswerFirstText(gmail, ALLIE_SENT))[0].label, '1:15 PM');
  // Apple Mail: the header itself sits behind '>' and the bullets are nested one level deeper.
  const apple = 'Yes\r\n\r\n> On Sep 20, 2026, at 12:02 PM, Sidd Saxena <sidd@hamptonscoconuts.com> wrote:\r\n>\r\n> > • Delivery: Wednesday, September 23, arrival time: please tell us\r\n> > • On site contact: Allie, 9495550123\r\n> > • Your contact: Sidd, 732.555.0199';
  assert.deepEqual(quotedBulletAnswers(apple, ALLIE_SENT), [{ label: 'On site contact', value: 'Allie, 9495550123', placeholder: true }]);
  // A phone's "- " bullets, and a wrapped answer continued on the next line.
  const dash = 'Below\r\n\r\nOn Sun, Sep 20, 2026 at 12:02 PM Sidd Saxena <sidd@hamptonscoconuts.com> wrote:\r\n> - Delivery: Wednesday, September 23, arrival time:\r\n> 1:15pm - 1:30pm\r\n> - Count: 40 coconuts\r\n> - On site contact: please send a name and cell';
  assert.deepEqual(quotedBulletAnswers(dash, ALLIE_SENT), [{ label: 'Delivery', value: 'Wednesday, September 23, arrival time: 1:15pm - 1:30pm', placeholder: true }]);
  // The first quoted copy wins: an older copy of our email deeper down
  // (a second reply on the same thread) never overrides the top one.
  const nested = ALLIE_RAW + '\r\n\r\n' + HEADER.join('\r\n') + '\r\n  *   Delivery: Wednesday, September 23, arrival time: 9:00am\r\n  *   On site contact: please send a name and cell';
  assert.deepEqual(quotedBulletAnswers(nested, ALLIE_SENT), ALLIE_ANSWERS);
  pass('Gmail (wrote: header, "> •" bullets), Apple Mail (the header behind ">", nested one deeper), "- " bullets with a wrapped answer, and the first quoted copy wins over an older one below it');
}

// ── 7. No quote header: top-posted only, unchanged from before ──────
{
  // A "Delivery:" the customer types at the top is not a quoted bullet:
  // the classifier's own paths read the top, as before.
  const top = 'Delivery: 2pm please\r\nOn site contact: Allie';
  assert.deepEqual(quotedBulletAnswers(top, ALLIE_SENT), []);
  assert.equal(reconfirmAnswerFirstText(top, ALLIE_SENT), top);
  for (const t of ['Confirmed', 'Confirmed, thanks!\r\n\r\nAllie Sugano']) {
    assert.equal(classify(t, { sent_body: ALLIE_SENT }).kind, 'confirmed', t);
    assert.equal(classify(t, { sent_body: ALLIE_SENT }).stripped, classify(t).stripped);
  }
  assert.equal(classify('Please make it 60 coconuts', { sent_body: ALLIE_SENT }).kind, 'changed');
  assert.equal(classify('Please make it 60 coconuts', { sent_body: ALLIE_SENT }).stripped, 'Please make it 60 coconuts');
  assert.equal(classify('Can we do 4:00 PM for the coconut delivery instead?', { sent_body: ALLIE_SENT }).kind, 'time');
  // A '>' line with no header above it is still quoted text, never the top.
  assert.deepEqual(quotedBulletAnswers('Yes\r\n> • Delivery: Wednesday, September 23, arrival time: please tell us', ALLIE_SENT), []);
  assert.deepEqual(quotedBulletAnswers('Yes\r\n> • On site contact: Allie, 9495550123', ALLIE_SENT), [{ label: 'On site contact', value: 'Allie, 9495550123', placeholder: true }]);
  // A forwarded coordinator email: their From: line is not ours, so nothing under it is our quote.
  assert.deepEqual(quotedBulletAnswers('FYI\r\n\r\nFrom: Planner <planner@example.invalid>\r\nSent: Monday\r\n\r\nDelivery: 9:00am\r\nOn site contact: Pat', ALLIE_SENT), []);
  pass('top-posted only (no quote header): nothing is read from the top by this path and the classifier answers exactly as before; a lone ">" line is quoted; a forwarded planner block is not our quote');
}

// ── 8. Attachment sections are never quoted mail ────────────────────
{
  const withPdf = outlookReply('Confirmed, timeline attached', ALLIE_SENT) + '\r\n\r\n=== ATTACHMENT: timeline.pdf (PDF text, 1 page) ===\r\nDelivery: 9:00am vendor arrival\r\nOn site contact: Pat, 631-555-0100';
  assert.deepEqual(quotedBulletAnswers(withPdf, ALLIE_SENT), []);
  // The PDF is still read by the time scan on its own (nothing here hides it).
  assert.equal(extractArrivalTimes(reconfirmAnswerFirstText(withPdf, ALLIE_SENT))[0].where, 'attachment:timeline.pdf');
  pass('a PDF section under the quote is never an answer, and the time scan still reads it as an attachment');
}

// ── 9. The labels come from the real template ───────────────────────
{
  // A made-up Saturday job with both asks open (the same fixture shape
  // test-reconfirmation.mjs uses), rendered by reconfirmTemplate itself.
  const order = {
    id: '11111111-1111-4111-8111-111111111111', client_name: 'Jamie Rivera', client_email: 'jamie@example.invalid', client_phone: '(631) 555-0177',
    venue: 'Pridwin Hotel', delivery_notes: 'Pridwin Hotel, Shelter Island, NY', delivery_at_utc: '2026-09-19T00:00:00+00:00',
    stage: 'deposit_paid', market: 'ny', coconuts_qty: 100, crack_type: null,
    invoice_fulfillment: { source: 'quickbooks', read_status: 'complete', invoice_id: '1523', address: 'Pridwin Hotel, 81 Shore Rd, Shelter Island, NY 11964', cracking: 'straw_hole', cracking_note: null, delivery_window: null, checked_at: '2026-09-10T15:00:00Z' },
    delivery_request: null, logo_url: null, logo_asset: null, logo_received: false,
    balance_cents: 0, deposit_cents: 50000, external_invoice_id: '1523', external_invoice_url: 'https://connect.intuit.com/pay/abc', is_recurring: false,
  };
  const body = reconfirmTemplate(reconfirmFacts(order, { deliveryDay: '2026-09-19' }), { ownerCell: '732-555-0199', picture: null, today: '2026-09-15', deliveryDay: '2026-09-19' }).body;
  assert.ok(body.includes('• Delivery: Saturday, September 19, arrival time: please tell us'), body);
  assert.ok(body.includes('• On site contact: please send a name and cell'), body);
  const reply = outlookReply('Hi Sidd!\r\n\r\nAdded the details below! Thank you', body, { Delivery: 'Saturday, September 19, arrival time: 2:30 PM', 'On site contact': 'Ana, 631-555-0100' });
  assert.deepEqual(quotedBulletAnswers(reply, body), [
    { label: 'Delivery', value: 'Saturday, September 19, arrival time: 2:30 PM', placeholder: true },
    { label: 'On site contact', value: 'Ana, 631-555-0100', placeholder: true },
  ]);
  assert.deepEqual(extractArrivalTimes(reconfirmAnswerFirstText(reply, body)).map((t) => t.label), ['2:30 PM']);
  // Every label the template prints is read: each one rewritten comes back.
  const all = outlookReply('See below', body, { Delivery: 'Saturday, September 19, arrival time: 2:30 PM', 'Drop off': 'Pridwin Hotel, 81 Shore Rd, Shelter Island, NY 11964, side gate', Count: '120 coconuts', Cracking: 'whole, uncracked', 'On site contact': 'Ana, 631-555-0100', 'Your contact': 'Sidd' });
  assert.deepEqual(quotedBulletAnswers(all, body).map((a) => a.label), ['Delivery', 'Drop off', 'Count', 'Cracking', 'On site contact', 'Your contact']);
  assert.deepEqual(quotedBulletAnswers(all, body).map((a) => a.placeholder), [true, false, false, false, true, false]);
  pass('the labels are read off the sent template itself: a case B body from reconfirmTemplate yields the two answers, and every one of its six bullets is compared');
}

// ── 10. The wiring, pinned in the source ────────────────────────────
{
  const { readFileSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'worker.js'), 'utf8');
  const replyScan = src.slice(src.indexOf('export async function runReconfirmationReplyScan(env)'), src.indexOf('export async function buildReconfirmationDigestLines(env)'));
  assert.ok(replyScan.includes('sent_conversation_id,sent_at,reply_kind,reply_intake_id,body'), 'the reply scan reads the sent body');
  assert.ok(replyScan.includes('sent_body: row.body'), 'the classifier gets the sent body');
  const proposal = src.slice(src.indexOf('async function fetchProposalIntakes(env, since)'), src.indexOf('export async function runStillWaitingScan(env)'));
  assert.ok(proposal.includes('select=id,subject,raw_text,order_id,conversation_id,created_at,error_detail'), 'the proposal scan reads the conversation id');
  assert.ok(proposal.includes('const sentBodies = await reconfirmSentBodies(env, rows.map((r) => r.order_id));'), 'one bounded read of the sent bodies');
  // The reply's own words first; the answers only when the email alone has no time.
  assert.ok(proposal.includes('let times = extractArrivalTimes(row.raw_text);'), 'the email is read on its own first');
  assert.ok(proposal.includes('if (!times.length && sentBody) times = extractArrivalTimes(reconfirmAnswerFirstText(row.raw_text, sentBody));'), 'the answers go ahead of the email only when it has no time of its own, only on a reconfirmation thread');
  assert.ok(replyScan.includes("reconfirmMode(env) === 'off') return out;"), 'mode off reads nothing');
  const block = src.slice(src.indexOf('answers typed inside our quoted bullets'), src.indexOf('the reply classifier (plan section 5'));
  assert.ok(block.includes('export function quotedBulletAnswers(rawText, sentBody)'));
  assert.ok(!/[\u2013\u2014]/.test(block), 'no dashes in the new block');
  pass('wiring: the reply scan selects body and hands it to the classifier, the proposal scan selects conversation_id, reads the sent bodies once (mode off: never), reads the email on its own first and feeds the answers to the extractor only when it has no time, only on a reconfirmation thread, no dashes');
}

// \u2500\u2500 11. A second reply on the thread never re-reads the first one \u2500\u2500\u2500
// Review finding (2026-09-21): a customer's second email quotes her FIRST
// reply, edited bullets and all, under HER header. Read again, those old
// answers made "Perfect, thank you!" a change that re-proposed 1:15 PM
// (retiring the pending proposal and pushing a second banner), and made
// "can the delivery be 2pm instead?" propose 1:15 PM over the 2pm
// (earliest wins on an equal rank). Now another sender's header above
// ours answers nothing, and the callers read the reply's own words.
{
  const reply1 = outlookReply('Hi Sidd!\r\n\r\nAdded the details below! Thank you', ALLIE_SENT, { Delivery: 'Wednesday, September 23, arrival time: 1:15pm - 1:30pm', 'On site contact': 'Allie, 9495550123' });
  assert.deepEqual(quotedBulletAnswers(reply1, ALLIE_SENT), ALLIE_ANSWERS, 'the first reply still answers');
  // Outlook: her From: block (Sent: within three lines) over the first reply.
  const outlook2 = (top) => [top, '', 'From: Allie Sugano <allie@example.invalid>', 'Sent: Monday, September 21, 2026 9:31 AM', 'To: Sidd Saxena <sidd@hamptonscoconuts.com>', 'Subject: Re: Your coconuts for Wednesday, September 23: quick check', '', reply1].join('\r\n');
  // Gmail: her "On <date> ... wrote:" line over the first reply behind '>'.
  const gmail2 = (top) => top + '\r\n\r\nOn Mon, Sep 21, 2026 at 9:31 AM Allie Sugano <allie@example.invalid> wrote:\r\n' + reply1.split('\r\n').map((l) => '> ' + l).join('\r\n');
  // Apple Mail: her header itself behind '>', ours behind '> >'.
  const apple2 = (top) => top + '\r\n\r\n> On Sep 21, 2026, at 9:31 AM, Allie Sugano <allie@example.invalid> wrote:\r\n> \r\n' + reply1.split('\r\n').map((l) => '> > ' + l).join('\r\n');
  // Outlook with the wrapped Gmail-style attribution (the address on the next line).
  const wrapped2 = (top) => top + '\r\n\r\nOn Mon, Sep 21, 2026 at 9:31 AM Allie Sugano <\r\nallie@example.invalid> wrote:\r\n' + reply1.split('\r\n').map((l) => '> ' + l).join('\r\n');
  for (const shape of [outlook2, gmail2, apple2, wrapped2]) {
    const thanks = shape('Perfect, thank you!');
    assert.deepEqual(quotedBulletAnswers(thanks, ALLIE_SENT), [], shape.name + ': nothing re-read');
    // Exactly as before the sent body existed. Gmail and Apple Mail strip
    // to the two words and confirm; Outlook keeps the customer's own
    // From: block in the top text (stripQuotedText's forwarded-email
    // rule, older than this helper), so that one reads as a change there
    // as it always did, and never as a re-proposed time.
    assert.equal(classify(thanks, { sent_body: ALLIE_SENT }).kind, classify(thanks).kind, shape.name + ': unchanged from before');
    if (shape !== outlook2) assert.equal(classify(thanks, { sent_body: ALLIE_SENT }).kind, 'confirmed', shape.name + ': still a confirmation');
    assert.equal(reconfirmAnswerFirstText(thanks, ALLIE_SENT), thanks);
    assert.deepEqual(extractArrivalTimes(reconfirmAnswerFirstText(thanks, ALLIE_SENT)), [], shape.name + ': proposes nothing');
    const later = shape('Sorry, can the delivery be 2pm instead?');
    assert.deepEqual(quotedBulletAnswers(later, ALLIE_SENT), []);
    assert.equal(classify(later, { sent_body: ALLIE_SENT }).kind, 'time', shape.name + ': a time, as before');
    assert.deepEqual(extractArrivalTimes(reconfirmAnswerFirstText(later, ALLIE_SENT)).map((t) => t.label), ['2:00 PM'], shape.name + ': the 2pm alone');
  }
  // A From: block with no address at all is not ours either.
  assert.deepEqual(quotedBulletAnswers(['Perfect, thank you!', '', 'From: Allie Sugano', 'Sent: Monday, September 21, 2026 9:31 AM', '', reply1].join('\r\n'), ALLIE_SENT), []);
  // Our own wrapped attribution is still ours: the first reply through Gmail with the address on the next line answers.
  const ownWrapped = 'Thanks Sidd, see below\r\n\r\nOn Sun, Sep 20, 2026 at 12:02 PM Sidd Saxena <\r\nsidd@hamptonscoconuts.com> wrote:\r\n> \u2022 Delivery: Wednesday, September 23, arrival time: 1:15pm\r\n> \u2022 On site contact: please send a name and cell';
  assert.deepEqual(quotedBulletAnswers(ownWrapped, ALLIE_SENT), [{ label: 'Delivery', value: 'Wednesday, September 23, arrival time: 1:15pm', placeholder: true }]);
  // An "On <date>" sentence with no "wrote:" is not a header of anyone's.
  const sentence = 'On Wednesday, September 23 the loading dock opens at noon.\r\n\r\n' + reply1;
  assert.deepEqual(quotedBulletAnswers(sentence, ALLIE_SENT), ALLIE_ANSWERS);
  pass('a second reply on the thread (Outlook From: block, Gmail and Apple Mail "wrote:" lines, a wrapped attribution, a From: with no address) re-reads nothing: "Perfect, thank you!" reads as it did before (confirmed through Gmail and Apple Mail) and proposes nothing, "2pm instead" is a time and proposes 2:00 PM alone; our own wrapped attribution and an "On <date>" sentence still read the quote');
}

// \u2500\u2500 12. An answer typed in parentheses after our ask \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// Review finding: every parenthetical was stripped before the compare,
// so "please tell us (1:15pm)" read as untouched (the live bug again).
// Only the template's own "(picture below)" note is dropped now.
{
  const paren = outlookReply('See below', ALLIE_SENT, { Delivery: 'Wednesday, September 23, arrival time: please tell us (1:15pm)', 'On site contact': 'please send a name and cell (Allie, 949-555-0123)' });
  assert.deepEqual(quotedBulletAnswers(paren, ALLIE_SENT), [
    { label: 'Delivery', value: 'Wednesday, September 23, arrival time: please tell us (1:15pm)', placeholder: true },
    { label: 'On site contact', value: 'please send a name and cell (Allie, 949-555-0123)', placeholder: true },
  ]);
  assert.equal(classify(paren, { sent_body: ALLIE_SENT }).kind, 'changed');
  assert.ok(classify(paren, { sent_body: ALLIE_SENT }).stripped.startsWith('Delivery: Wednesday, September 23, arrival time: please tell us (1:15pm)\n'));
  assert.deepEqual(extractArrivalTimes(reconfirmAnswerFirstText(paren, ALLIE_SENT)).map((t) => t.label), ['1:15 PM']);
  // The "(picture below)" note dropped by the droplet is still no change (case 2 pins the branded body too).
  const branded = ALLIE_SENT.replace('\u2022 Count: 40 coconuts', '\u2022 Count: 40 custom branded coconuts (picture below)');
  assert.deepEqual(quotedBulletAnswers(outlookReply('Confirmed', branded, { Count: '40 custom branded coconuts' }), branded), []);
  // A parenthetical the customer ADDS to a bullet we filled in is a change.
  assert.deepEqual(quotedBulletAnswers(outlookReply('Confirmed', ALLIE_SENT, { Count: '40 coconuts (plus 10 spare)' }), ALLIE_SENT), [{ label: 'Count', value: '40 coconuts (plus 10 spare)', placeholder: false }]);
  pass('"please tell us (1:15pm)" and "(Allie, 949-555-0123)" typed after our asks are answers (change note first, 1:15 PM proposed); a dropped "(picture below)" note is still no change; a parenthetical added to our own bullet is a change');
}

// \u2500\u2500 13. A hyphenated link scheme on an untouched bullet \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// Review finding: the link strip only knew single-word schemes, so an
// Apple data-detector link on our own address read as a customer change
// and a plain "Confirmed" became a change. RFC scheme shapes now.
{
  const detectors = outlookReply('Confirmed', ALLIE_SENT, { 'Drop off': '24 Spring St., New York, NY, 10012, US<x-apple-data-detectors://0/1>', 'Your contact': 'Sidd, 732.555.0199<x-apple-data-detectors://1/0>' });
  assert.deepEqual(quotedBulletAnswers(detectors, ALLIE_SENT), []);
  assert.equal(classify(detectors, { sent_body: ALLIE_SENT }).kind, 'confirmed');
  // tel:, mailto: and https: shapes as before; a real change next to a link is still a change.
  assert.deepEqual(quotedBulletAnswers(outlookReply('Confirmed', ALLIE_SENT, { 'Your contact': 'Sidd, 732.555.0199<tel:7325550199>', 'Drop off': '24 Spring St., New York, NY, 10012, US<https://maps.example.invalid/x>' }), ALLIE_SENT), []);
  assert.deepEqual(quotedBulletAnswers(outlookReply('Confirmed', ALLIE_SENT, { 'Drop off': '30 Spring St., New York, NY, 10012, US<x-apple-data-detectors://0/1>' }), ALLIE_SENT), [{ label: 'Drop off', value: '30 Spring St., New York, NY, 10012, US<x-apple-data-detectors://0/1>', placeholder: false }]);
  pass('an untouched address or cell carrying <x-apple-data-detectors://...> is no answer and "Confirmed" stays confirmed; tel:, mailto: and https: shapes as before; a changed address beside a link is still a change');
}

// \u2500\u2500 14. A line after the list that is not a wrapped tail \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// Review finding: any bullet-prefixed line without one of our labels was
// appended to the open value above it, so a bulleted line under the list
// (a future colon-less bullet, a client that lists the paragraph) made
// "Your contact" gain "We brand and box on ..." and a confirmation a
// change. A new bullet ends the item now, and so does a line we printed
// ourselves (wrapped or not) when a client drops the blank line after
// the list; only an unbulleted wrapped tail continues.
{
  const last = '  *   Your contact: Sidd, 732.555.0199\r\n';
  const base = outlookReply('Confirmed', ALLIE_SENT);
  assert.ok(base.includes(last + '\r\nWe brand and box'), 'the fixture has the blank line the clients keep');
  // The paragraph as a bullet, and the paragraph with no blank line before it.
  const bulleted = base.replace(last + '\r\nWe brand', last + '  *   We brand');
  const noBlank = base.replace(last + '\r\nWe brand', last + 'We brand');
  // The paragraph wrapped by the client, its head directly under the list.
  const wrappedHead = base.replace(last + '\r\nWe brand and box on Tuesday, September 22, the day before, so changes need to reach us today.', last + 'We brand and box on Tuesday, September 22, the day before, so changes need\r\nto reach us today.');
  for (const [name, text] of [['bulleted', bulleted], ['noBlank', noBlank], ['wrappedHead', wrappedHead]]) {
    assert.deepEqual(quotedBulletAnswers(text, ALLIE_SENT), [], name);
    assert.equal(classify(text, { sent_body: ALLIE_SENT }).kind, 'confirmed', name);
  }
  // A colon-less bullet the template might gain later, under an answered ask, ends that answer.
  const future = outlookReply('See below', ALLIE_SENT, { 'On site contact': 'Allie, 9495550123' }).replace(last, last + '  *   Reply confirmed if everything looks right\r\n');
  assert.deepEqual(quotedBulletAnswers(future, ALLIE_SENT), [{ label: 'On site contact', value: 'Allie, 9495550123', placeholder: true }]);
  // A real wrapped tail still continues (the "- " shape of case 6, and Outlook's).
  const tail = outlookReply('See below', ALLIE_SENT, { Delivery: 'Wednesday, September 23, arrival time:\r\n1:15pm - 1:30pm' });
  assert.deepEqual(quotedBulletAnswers(tail, ALLIE_SENT), [{ label: 'Delivery', value: 'Wednesday, September 23, arrival time: 1:15pm - 1:30pm', placeholder: true }]);
  // A wrapped tail that happens to start like one of our lines but is one word is still a tail.
  const oneWord = outlookReply('See below', ALLIE_SENT, { 'On site contact': 'Allie,\r\n9495550123' });
  assert.deepEqual(quotedBulletAnswers(oneWord, ALLIE_SENT), [{ label: 'On site contact', value: 'Allie, 9495550123', placeholder: true }]);
  pass('the "We brand and box" paragraph directly under the list (as a bullet, with no blank line, or wrapped) is never the tail of "Your contact" and "Confirmed" stays confirmed; a colon-less bullet ends the answer above it; a real wrapped tail still continues');
}

console.log(`\nPASS: ${passed} quoted-answer checks. No network, no database, no phone, no email.`);

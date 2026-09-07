// Lead-dedupe guard tests: no framework, no network, exit non-zero on failure.
// Run: node worker/test-lead-dedupe.mjs   (mirrors test-manage-push.mjs)
// Background: 2026-09-06, two "RE: Labor Day Event" replies from an
// already-invoiced customer became fresh inquiry rows on the calendar.
// Every rule fails OPEN toward creating the row (a lead pipeline).
import { leadDedupeDecision, leadLookupEmail, escapeLikePattern } from './worker.js';

let failed = 0;
let total = 0;
const check = (name, cond) => {
  total++;
  console.log((cond ? 'PASS ' : 'FAIL ') + ' ' + name);
  if (!cond) failed++;
};

const invoiced = { id: 'row-inv', stage: 'invoiced', external_invoice_id: '3475', total_cents: 200000, deposit_cents: 0, notes: 'x' };
const paid = { id: 'row-paid', stage: 'paid_full', external_invoice_id: '3513', total_cents: 201825, deposit_cents: 0 };
const openLead = { id: 'row-lead', stage: 'inquiry', external_invoice_id: null, total_cents: null, deposit_cents: 0, event_start_at: '2026-10-05T12:00:00+00:00', notes: 'Email lead via MS Graph: hi' };
const quotedLead = { id: 'row-quoted', stage: 'quoted', external_invoice_id: null, total_cents: 150000, deposit_cents: 0, event_start_at: null };
const passedOld = { id: 'row-passed-old', stage: 'complete', external_invoice_id: null, total_cents: 0, deposit_cents: 0 }; // pre-Sept "passed" mapping
const passedOldQuoted = { id: 'row-passed-quoted', stage: 'complete', external_invoice_id: null, total_cents: 150000, deposit_cents: 0 }; // passed AFTER a quote
const passedNew = { id: 'row-passed', stage: 'cancelled', external_invoice_id: null, total_cents: 0, deposit_cents: 0 };
const doneReal = { id: 'row-done', stage: 'complete', external_invoice_id: '3300', total_cents: 90000, deposit_cents: 0 };
const depositOnly = { id: 'row-dep', stage: 'deposit_paid', external_invoice_id: null, total_cents: 80000, deposit_cents: 40000 };
const weirdStage = { id: 'row-weird', stage: 'something_new', external_invoice_id: null, total_cents: 0, deposit_cents: 0 };

// ── rule 3: unknown sender always creates ──
let d = leadDedupeDecision('Coconuts for our gala?', []);
check('fresh subject, unknown sender: create', d.create === true && d.appendTo === null && d.sibling === null);
d = leadDedupeDecision('RE: Coconut bar for 200 guests', []);
check('RE: from a sender with NO history is a first contact: create', d.create === true);
d = leadDedupeDecision('Fwd: Coconut bar for 200 guests', []);
check('forwards are never suppressed (owner self-forwards leads): create', d.create === true);
d = leadDedupeDecision('hello', null);
check('null rows behave like no rows', d.create === true);
d = leadDedupeDecision(undefined, [{ id: 'x', stage: null }]);
check('rows without a stage or evidence are ignored', d.create === true);

// ── rule 1: real customers (evidence, never stage or bare total) ──
// Owner decision 2026-09-07: a repeat customer asking about a NEW event
// gets its own row. A reply, or the same event date, is still a thread.
const invoicedDated = { ...invoiced, event_start_at: '2026-09-05T12:00:00+00:00' };
d = leadDedupeDecision('RE: Labor Day Event', [invoiced]);
check('the Danielle case: invoiced customer + reply -> no row, note on the order row', d.create === false && d.appendTo === 'row-inv' && /order on file/.test(d.reason));
d = leadDedupeDecision('RE: Labor Day Event', [invoicedDated], '2026-09-07');
check('the Danielle case with the guessed date: a reply is a thread whatever the date says', d.create === false && d.appendTo === 'row-inv');
d = leadDedupeDecision('Brand new question', [paid]);
check('paid customer, fresh subject, no date: NEW row, the order named as sibling', d.create === true && d.sibling === 'row-paid' && /existing customer/.test(d.reason));
d = leadDedupeDecision('Coconuts for our holiday party', [invoicedDated], '2026-12-12');
check('customer, fresh subject, DIFFERENT event date: new row, sibling named', d.create === true && d.sibling === 'row-inv');
d = leadDedupeDecision('Coconuts for Sep 5', [invoicedDated], '2026-09-05');
check('customer, fresh subject, SAME event date as the order: no row, note on the order', d.create === false && d.appendTo === 'row-inv' && /same event date/.test(d.reason));
d = leadDedupeDecision('FW: intro from the venue', [invoiced]);
check('a forward from a real customer with no date is a new inquiry (forwards are never suppressed)', d.create === true && d.sibling === 'row-inv');
d = leadDedupeDecision('Coconuts for our October launch?', [doneReal], '2026-10-20');
check('complete WITH an invoice on file is still recognized: new row, that order named as sibling', d.create === true && d.sibling === 'row-done');
d = leadDedupeDecision('hello', [depositOnly]);
check('a deposit on file is a customer even without an invoice id: sibling named', d.create === true && d.sibling === 'row-dep');
d = leadDedupeDecision('hello', [openLead, invoiced]);
check('customer AND open lead, fresh subject, no date: new row, the open lead is the sibling', d.create === true && d.sibling === 'row-lead' && /open lead/.test(d.reason));
d = leadDedupeDecision('RE: hello', [openLead, invoiced]);
check('customer AND open lead, reply: no row, note goes to the open lead', d.create === false && d.appendTo === 'row-lead');
d = leadDedupeDecision('Coconuts for Oct 5', [openLead, invoicedDated], '2026-10-05');
check('customer AND open lead, same date as the open lead: note on the open lead', d.create === false && d.appendTo === 'row-lead');
d = leadDedupeDecision('[EXTERNAL] RE: Labor Day Event', [invoiced]);
check('M365 external tag before RE: still a customer thread', d.create === false);
d = leadDedupeDecision('hello', [{ ...invoiced, total_cents: '200000' }]);
check('total_cents as a string still counts on an invoiced stage (sibling named)', d.create === true && d.sibling === 'row-inv');
d = leadDedupeDecision('Coconuts for Sep 5', [{ ...invoicedDated, stage: 'cancelled' }], '2026-09-05');
check('a cancelled row never absorbs a same-date email', d.create === true && d.sibling === null);
d = leadDedupeDecision('Coconuts for Sep 5', [invoicedDated], '2026-09-05T12:00:00Z');
check('event date with a time part still matches on the calendar day', d.create === false && d.appendTo === 'row-inv');

// ── NOT evidence: quotes, passed leads, unknown stages ──
d = leadDedupeDecision('Coconuts for our October launch?', [passedOld]);
check('pre-Sept passed lead (complete, no invoice, $0) writing again IS a new lead', d.create === true);
d = leadDedupeDecision('Coconuts for our October launch?', [passedOldQuoted]);
check('passed AFTER a $1,500 quote (complete, no invoice, no deposit) is STILL a new lead', d.create === true);
d = leadDedupeDecision('Coconuts for our October launch?', [passedNew]);
check('cancelled (passed) customer writing again IS a new lead', d.create === true);
d = leadDedupeDecision('RE: Labor Day Event', [passedOld]);
check('a reply from a passed sender creates (the reply rule is gone on purpose)', d.create === true);
d = leadDedupeDecision('hello', [weirdStage]);
check('unknown stage without evidence fails OPEN: create', d.create === true);
d = leadDedupeDecision('hello', [{ ...weirdStage, total_cents: 12345 }]);
check('unknown stage with a bare total is NOT evidence: create', d.create === true);
d = leadDedupeDecision('hello', [{ ...invoiced, external_invoice_id: ' ', total_cents: -5, stage: 'invoiced' }]);
check('blank invoice id + negative total: not evidence', d.create === true);

// ── rule 2: open leads (follow-up vs a different event) ──
d = leadDedupeDecision('RE: quote', [quotedLead]);
check('reply on a quoted lead ($1,500 quote, no invoice): append to it', d.create === false && d.appendTo === 'row-quoted');
d = leadDedupeDecision('RE: quick question', [openLead]);
check('reply on an open lead: append', d.create === false && d.appendTo === 'row-lead');
d = leadDedupeDecision('Coconuts for Oct 5', [openLead], '2026-10-05');
check('fresh subject, SAME event date as the open lead: append', d.create === false && d.appendTo === 'row-lead');
d = leadDedupeDecision('Another event in November', [openLead], '2026-11-01');
check('fresh subject, DIFFERENT event date: new row, sibling named', d.create === true && d.sibling === 'row-lead');
d = leadDedupeDecision('Another question', [openLead], null);
check('fresh subject, unknown event date: new row, sibling named', d.create === true && d.sibling === 'row-lead');
d = leadDedupeDecision('Re[2]: quick question', [openLead]);
check('bracket-counter reply prefix counts as a reply', d.create === false && d.appendTo === 'row-lead');
d = leadDedupeDecision('Retail order question', [openLead]);
check('a subject that merely STARTS with re is not a reply (new row + sibling)', d.create === true && d.sibling === 'row-lead');
d = leadDedupeDecision('RE: hi', [{ id: 'lead-newer', stage: 'inquiry', total_cents: 0 }, { id: 'lead-older', stage: 'inquiry', total_cents: 0 }]);
check('two open leads: the first (caller orders created_at desc = newest) wins', d.appendTo === 'lead-newer');
d = leadDedupeDecision('RE: hi', [{ ...quotedLead, external_invoice_id: '3600' }]);
check('a quoted row that carries an invoice id is a customer, not an open lead', d.create === false && d.appendTo === 'row-quoted' && /order on file/.test(d.reason));

// ── lookup address hygiene ──
check('normal address normalizes', leadLookupEmail('  Jane@Example.com ') === 'jane@example.com');
check('display-name form reduces to the address', leadLookupEmail('Jane Doe <Jane@Example.com>') === 'jane@example.com');
check('formspree relay never drives a lookup', leadLookupEmail('submissions@formspree.io') === null);
check('formspree subdomain relay never drives a lookup', leadLookupEmail('x@mail.formspree.io') === null);
check('godaddy relay never drives a lookup', leadLookupEmail('noreply@godaddy.com') === null);
check('secureserver relay never drives a lookup', leadLookupEmail('forms@secureserver.net') === null);
check('no-reply local part never drives a lookup', leadLookupEmail('no-reply@somevenue.com') === null);
check('notifications local part never drives a lookup', leadLookupEmail('notifications@planner.app') === null);
check('missing @ is rejected', leadLookupEmail('not an email') === null);
check('null is rejected', leadLookupEmail(null) === null);

// ── LIKE escaping ──
check('underscore is escaped', escapeLikePattern('jane_doe@gmail.com') === 'jane\\_doe@gmail.com');
check('percent is escaped', escapeLikePattern('a%b@x.com') === 'a\\%b@x.com');
check('backslash is escaped', escapeLikePattern('a\\b') === 'a\\\\b');
check('a plain address is untouched', escapeLikePattern('jane.doe@gmail.com') === 'jane.doe@gmail.com');

console.log('');
console.log(failed === 0 ? `${total} passed, 0 failed, ${total} total` : `${total - failed} passed, ${failed} failed, ${total} total`);
process.exit(failed ? 1 : 0);

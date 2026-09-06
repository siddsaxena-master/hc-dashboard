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

const invoiced = { id: 'row-inv', stage: 'invoiced', external_invoice_id: '3475', total_cents: 200000, notes: 'x' };
const paid = { id: 'row-paid', stage: 'paid_full', external_invoice_id: '3513', total_cents: 201825 };
const openLead = { id: 'row-lead', stage: 'inquiry', external_invoice_id: null, total_cents: null, notes: 'Email lead via MS Graph: hi' };
const quoted = { id: 'row-quoted', stage: 'quoted', total_cents: 0 };
const passedOld = { id: 'row-passed-old', stage: 'complete', external_invoice_id: null, total_cents: 0 }; // pre-Sept "passed" mapping
const passedNew = { id: 'row-passed', stage: 'cancelled', external_invoice_id: null, total_cents: 0 };
const doneReal = { id: 'row-done', stage: 'complete', external_invoice_id: '3300', total_cents: 90000 };
const weirdStage = { id: 'row-weird', stage: 'something_new', external_invoice_id: null, total_cents: 0 };

// ── decision table ──
let d = leadDedupeDecision('Coconuts for our gala?', []);
check('fresh subject, unknown sender: create', d.create === true && d.appendTo === null);

d = leadDedupeDecision('RE: Coconut bar for 200 guests', []);
check('RE: from a sender with NO history is a first contact: create', d.create === true);

d = leadDedupeDecision('Fwd: Coconut bar for 200 guests', []);
check('forwards are never suppressed (owner self-forwards leads): create', d.create === true);

d = leadDedupeDecision('FW: intro from the venue', [passedOld]);
check('a forward from a sender with history (no order) is NOT read as a reply: create', d.create === true);

d = leadDedupeDecision('FW: intro from the venue', [invoiced]);
check('a forward from a real customer is still a customer thread (rule 1): no row', d.create === false);

d = leadDedupeDecision('RE: Labor Day Event', [invoiced]);
check('the Danielle case: invoiced customer + reply -> no row, no append', d.create === false && d.appendTo === null && /order on file/.test(d.reason));

d = leadDedupeDecision('Brand new question', [paid]);
check('paid customer with a fresh subject: still a customer thread, no row', d.create === false && d.appendTo === null);

d = leadDedupeDecision('Brand new question', [openLead]);
check('open lead on file: append instead of duplicating', d.create === false && d.appendTo === 'row-lead');

d = leadDedupeDecision('RE: quote', [quoted]);
check('quoted counts as an open lead (append)', d.create === false && d.appendTo === 'row-quoted');

d = leadDedupeDecision('Coconuts for our October launch?', [passedOld]);
check('pre-Sept passed lead (stage complete, no invoice, $0) writing again IS a new lead', d.create === true);

d = leadDedupeDecision('Coconuts for our October launch?', [passedNew]);
check('cancelled (passed) customer writing again IS a new lead', d.create === true);

d = leadDedupeDecision('Coconuts for our October launch?', [doneReal]);
check('complete WITH an invoice on file is a real customer: no row', d.create === false);

d = leadDedupeDecision('RE: Labor Day Event', [passedOld]);
check('reply from a passed (complete/$0) sender WITH history: thread reply, no row', d.create === false && d.appendTo === null);

d = leadDedupeDecision('hello', [weirdStage]);
check('unknown stage without order evidence fails OPEN: create', d.create === true);

d = leadDedupeDecision('hello', [{ ...weirdStage, total_cents: 12345 }]);
check('unknown stage WITH money on the row is a customer: no row', d.create === false);

d = leadDedupeDecision('hello', [openLead, invoiced]);
check('customer AND open lead: no row, note goes to the open lead', d.create === false && d.appendTo === 'row-lead');

d = leadDedupeDecision('hello', [{ id: 'lead-newer', stage: 'inquiry', total_cents: 0 }, { id: 'lead-older', stage: 'inquiry', total_cents: 0 }]);
check('two open leads: the first (caller orders created_at desc = newest) wins', d.appendTo === 'lead-newer');

d = leadDedupeDecision('[EXTERNAL] RE: Labor Day Event', [invoiced]);
check('M365 external tag before RE: still customer (rule 1 does not need the subject)', d.create === false);

d = leadDedupeDecision('[EXTERNAL] RE: pricing?', [passedOld]);
check('M365 external tag before RE: still reads as a reply when the sender has history', d.create === false);

d = leadDedupeDecision('Retail order question', [passedOld]);
check('a subject that merely STARTS with re is not a reply', d.create === true);

d = leadDedupeDecision('hello', null);
check('null rows behave like no rows', d.create === true);

d = leadDedupeDecision(undefined, [{ id: 'x', stage: null }]);
check('rows without a stage or evidence are ignored', d.create === true);

// ── lookup address hygiene ──
check('normal address normalizes', leadLookupEmail('  Jane@Example.com ') === 'jane@example.com');
check('formspree relay never drives a lookup', leadLookupEmail('submissions@formspree.io') === null);
check('godaddy relay never drives a lookup', leadLookupEmail('noreply@godaddy.com') === null);
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

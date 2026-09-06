// Lead-dedupe guard tests: no framework, no network, exit non-zero on failure.
// Run: node worker/test-lead-dedupe.mjs   (mirrors test-manage-push.mjs)
// Background: 2026-09-06, two "RE: Labor Day Event" replies from an
// already-invoiced customer became fresh inquiry rows on the calendar.
import { leadDedupeDecision } from './worker.js';

let failed = 0;
const check = (name, cond) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + ' ' + name);
  if (!cond) failed++;
};

const invoiced = { id: 'row-inv', stage: 'invoiced', notes: 'x' };
const paid = { id: 'row-paid', stage: 'paid_full', notes: '' };
const openLead = { id: 'row-lead', stage: 'inquiry', notes: 'Email lead via MS Graph: hi' };
const quoted = { id: 'row-quoted', stage: 'quoted', notes: '' };
const passed = { id: 'row-passed', stage: 'cancelled', notes: '' };

let d = leadDedupeDecision('Coconuts for our gala?', []);
check('fresh subject, unknown sender: create', d.create === true && d.appendTo === null);

d = leadDedupeDecision('RE: Labor Day Event', []);
check('reply subject, unknown sender: no row', d.create === false && d.appendTo === null);

d = leadDedupeDecision('Fwd: pricing', []);
check('forward prefix is case-insensitive', d.create === false);

d = leadDedupeDecision('  re :  anything', []);
check('spaced prefix still counts as a reply', d.create === false);

d = leadDedupeDecision('Retail order question', []);
check('a subject that merely STARTS with re is not a reply', d.create === true);

d = leadDedupeDecision('RE: Labor Day Event', [invoiced]);
check('the Danielle case: invoiced customer, reply -> no row, no append', d.create === false && d.appendTo === null && /customer/.test(d.reason));

d = leadDedupeDecision('Brand new question', [paid]);
check('paid customer with a fresh subject: still a customer thread, no row', d.create === false && d.appendTo === null);

d = leadDedupeDecision('Brand new question', [openLead]);
check('open lead on file: append instead of duplicating', d.create === false && d.appendTo === 'row-lead');

d = leadDedupeDecision('RE: quote', [quoted]);
check('quoted counts as an open lead', d.create === false && d.appendTo === 'row-quoted');

d = leadDedupeDecision('Brand new question', [passed]);
check('a passed (cancelled) customer writing again IS a new lead', d.create === true);

d = leadDedupeDecision('RE: Labor Day Event', [passed]);
check('but a reply from a passed customer is still just a reply', d.create === false && d.appendTo === null);

d = leadDedupeDecision('hello', [openLead, invoiced]);
check('customer AND open lead: no row, note goes to the open lead', d.create === false && d.appendTo === 'row-lead');

d = leadDedupeDecision('hello', null);
check('null rows behave like no rows', d.create === true);

d = leadDedupeDecision(undefined, [{ id: 'x', stage: null }]);
check('rows without a stage are ignored', d.create === true);

console.log('');
const total = 14;
console.log(failed === 0 ? `${total} passed, 0 failed, ${total} total` : `${total - failed} passed, ${failed} failed, ${total} total`);
process.exit(failed ? 1 : 0);

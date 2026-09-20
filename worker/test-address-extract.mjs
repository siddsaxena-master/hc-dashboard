// Tests for the address extractor in worker.js (PHASE2-ADDRESS-PROPOSALS-
// PLAN-2026-09-15.md section 4): extractDeliveryAddresses, the normalized
// key, the geocode match, the agreement verdict and the banner place words.
// Pure functions only: no network, no clock, no database.
//
// Run it with:  node worker/test-address-extract.mjs
//
// The customer this exists for: Alison Sheeley's August email naming
// 491 S Dean Street, Englewood, NJ, which sat unread while invoice 2049
// carried the address on one line and QuickBooks taxed it as NYC.

import assert from 'node:assert/strict';
import {
  extractDeliveryAddresses, normalizeAddressKey, addressKeyParts, addressesAgree, addressProposalVerdict, quotesOwnDropOffLine,
  geocodeZipFor, addressPlaceWords, OWN_ADDRESS_MARKS,
} from './worker.js';

let passed = 0;
const pass = (m) => { passed++; console.log('PASS: ' + m); };
const SHEELEY = { clientName: 'Alison Sheeley', venue: null };
const reasons = (r) => r.rejected.map((x) => x.reason);
const PDF = (name, text) => `\n\n=== ATTACHMENT: ${name} (PDF text, 2 pages) ===\n${text}`;

// ── 1. The Sheeley body with and without a ZIP ─────────────────────
{
  const withZip = extractDeliveryAddresses('Hi Sidd,\n\nConfirming for Friday the 18th. Please deliver the coconuts to 491 S Dean Street, Englewood, NJ 07631 by 6pm.\n\nThanks,\nAlison Sheeley\n201-555-0143\nalison@example.invalid', SHEELEY);
  const c = withZip.candidate;
  assert.ok(c, 'found');
  assert.equal(c.line1, '491 S Dean Street'); assert.equal(c.line2, null);
  assert.equal(c.city, 'Englewood'); assert.equal(c.state, 'NJ'); assert.equal(c.postal_code, '07631');
  assert.equal(c.text, '491 S Dean Street, Englewood, NJ 07631');
  assert.equal(c.state_inferred, false); assert.equal(c.rank, 0); assert.equal(c.where, 'body');
  assert.equal(c.house, '491'); assert.equal(c.key, '491 s dean st englewood nj 07631');
  assert.ok(c.evidence.includes('deliver the coconuts to 491 S Dean Street') && !c.evidence.includes('@'), c.evidence);
  assert.deepEqual(withZip.rejected, []);
  const noZip = extractDeliveryAddresses('Hi Sidd,\n\nDrop off is at our house:\n491 S Dean Street\nEnglewood, NJ\n\nThanks,\nAlison', SHEELEY);
  assert.equal(noZip.candidate.text, '491 S Dean Street, Englewood, NJ');
  assert.equal(noZip.candidate.postal_code, null);
  assert.equal(noZip.candidate.rank, 1, 'the STRONG word sits on the line above');
  assert.equal(noZip.candidate.evidence, '491 S Dean Street, Englewood, NJ', 'two lines joined');
  // A unit line between the street and the town, and the full state name.
  const unit = extractDeliveryAddresses('Deliver to:\n491 S Dean Street\nApt 4B\nEnglewood, New Jersey 07631', SHEELEY);
  assert.equal(unit.candidate.line2, 'Apt 4B'); assert.equal(unit.candidate.state, 'NJ');
  assert.equal(unit.candidate.text, '491 S Dean Street, Apt 4B, Englewood, NJ 07631');
  // A PDF that shouts: capitals are tidied, S and NJ left alone.
  const caps = extractDeliveryAddresses('x' + PDF('run-of-show.pdf', 'DELIVERY: 491 S DEAN STREET, ENGLEWOOD, NJ 07631'), SHEELEY);
  assert.equal(caps.candidate.text, '491 S Dean Street, Englewood, NJ 07631'); assert.equal(caps.candidate.where, 'attachment:run-of-show.pdf');
  pass('the Sheeley body: with a ZIP, without one (two lines joined), with a unit line, with the state in full, shouted in a PDF');
}
// ── 2. Signatures ──────────────────────────────────────────────────
{
  // A coordinator's footer after a sign-off word: never a proposal, even as the only address.
  const coordinator = extractDeliveryAddresses('Timeline attached.\n\nBest,\nAnadina Lopez\nEvents by Anadina\n12 Bridge Street, Suite 4, Nutley, NJ 07110\n973-555-0199\nanadina@example.invalid', { clientName: 'Abigail Canelle' });
  assert.equal(coordinator.candidate, null); assert.deepEqual(reasons(coordinator), ['signature']);
  // No sign-off word: the customer's own home under her name, phone and email below.
  const home = extractDeliveryAddresses('See you Friday!\nAlison Sheeley\n491 S Dean Street\nEnglewood, NJ 07631\n201-555-0143\nalison@example.invalid', SHEELEY);
  assert.equal(home.candidate, null); assert.deepEqual(reasons(home), ['signature']);
  // The name directly above, nothing else: still a footer.
  const named = extractDeliveryAddresses('See you Friday!\n\nAlison Sheeley\n491 S Dean Street, Englewood, NJ 07631', SHEELEY);
  assert.equal(named.candidate, null); assert.deepEqual(reasons(named), ['signature']);
  // A STRONG word on the line rescues a street inside a signature block.
  const rescued = extractDeliveryAddresses('Thanks,\nAlison\nDeliver to 491 S Dean Street, Englewood, NJ 07631', SHEELEY);
  assert.equal(rescued.candidate.text, '491 S Dean Street, Englewood, NJ 07631');
  // "Sent from my iPhone" starts a signature too.
  const phone = extractDeliveryAddresses('ok\nSent from my iPhone\n491 S Dean Street, Englewood, NJ 07631', SHEELEY);
  assert.equal(phone.candidate, null); assert.deepEqual(reasons(phone), ['signature']);
  // A company tagline carrying a STRONG word ("We Deliver Joy LLC") one line
  // above a coordinator's office street is not an instruction: the rescue
  // needs the word followed by "to" or "at", or a STRONG label with a colon.
  const tagline = extractDeliveryAddresses('See you then.\n\nBest,\nJane Doe\nEvent Planner, We Deliver Joy LLC\n200 Park Avenue, New York, NY 10166\n212-555-0100\njane@example.invalid', { clientName: 'Abigail Canelle' });
  assert.equal(tagline.candidate, null); assert.deepEqual(reasons(tagline), ['signature']);
  const labelled = extractDeliveryAddresses('Best,\nJane\nDrop off at\n200 Park Avenue, New York, NY 10166', { clientName: 'Abigail Canelle' });
  assert.equal(labelled.candidate.text, '200 Park Avenue, New York, NY 10166', 'an instruction shape on the line above still rescues');
  // An accented customer name above the street: the accents are stripped
  // (NFKD plus the combining-mark range) so the name still gates it.
  const accented = extractDeliveryAddresses('See you Friday!\n\nRenée Côté\n491 S Dean Street, Englewood, NJ 07631', { clientName: 'Renée Côté' });
  assert.equal(accented.candidate, null); assert.deepEqual(reasons(accented), ['signature']);
  const plainName = extractDeliveryAddresses('See you Friday!\n\nRenee Cote\n491 S Dean Street, Englewood, NJ 07631', { clientName: 'Renée Côté' });
  assert.equal(plainName.candidate, null); assert.deepEqual(reasons(plainName), ['signature']);
  pass('signatures: a sign-off word, a phone-and-email footer, the customer name above (accented too); only an instruction-shaped STRONG word rescues, never a company tagline');
}
// ── 3. Vendor lists, our garage, billing blocks ────────────────────
{
  const vendors = extractDeliveryAddresses('Timeline attached.' + PDF('timeline.pdf', 'Vendors\nFlorist: Blooms\n12 Bridge Street, Nutley, NJ 07110\nCaterer: Feast Co\n88 Elm Ave, Montclair, NJ 07042'), { venue: 'Pridwin Hotel' });
  assert.equal(vendors.candidate, null); assert.deepEqual(reasons(vendors), ['vendor', 'vendor']);
  // The same list with the venue's own line: that one reads.
  const venue = extractDeliveryAddresses('x' + PDF('timeline.pdf', 'Venue: Pridwin Hotel\n81 Shore Rd, Shelter Island, NY 11964\nFlorist: Blooms\n12 Bridge Street, Nutley, NJ 07110'), { venue: 'Pridwin Hotel' });
  assert.equal(venue.candidate.text, '81 Shore Rd, Shelter Island, NY 11964'); assert.deepEqual(reasons(venue), ['vendor']);
  // A PDF street with no delivery word and no venue word near it: nothing.
  const bare = extractDeliveryAddresses('x' + PDF('timeline.pdf', 'Day of contacts\n88 Elm Ave, Montclair, NJ 07042'), { venue: 'Pridwin Hotel' });
  assert.equal(bare.candidate, null); assert.deepEqual(reasons(bare), ['attachment_no_context']);
  // Our garage inside a vendor list: the window names us (so not a vendor
  // reject), the own-address mark rejects it instead.
  const garage = extractDeliveryAddresses('x' + PDF('timeline.pdf', 'Vendors\nCoconuts: Hamptons Coconuts\n55 Cambridge Dr, Colonia, NJ 07067'), { venue: 'Pridwin Hotel' });
  assert.equal(garage.candidate, null); assert.deepEqual(reasons(garage), ['own_address']);
  assert.deepEqual(OWN_ADDRESS_MARKS, ['55 cambridge']);
  // The OWN_ADDRESS_DENYLIST secret adds prefixes; our own signature (sidd
  // saxena, hamptonscoconuts.com) just above a street rejects too.
  const deny = extractDeliveryAddresses('Deliver to 7 Ocean Ave, Miami Beach, FL 33139', { ownMarks: ['7 ocean'] });
  assert.equal(deny.candidate, null); assert.deepEqual(reasons(deny), ['own_address']);
  const denyShort = extractDeliveryAddresses('Deliver to 3708 S Las Vegas Blvd, Las Vegas, NV 89109', { ownMarks: ['12 main', '3708 las'] });
  assert.equal(denyShort.candidate, null, 'a mark without the direction word still matches');
  assert.ok(extractDeliveryAddresses('Deliver to 3708 S Las Vegas Blvd, Las Vegas, NV 89109', { ownMarks: ['12 main'] }).candidate, 'an unrelated mark denies nothing');
  const ownSig = extractDeliveryAddresses('Sidd Saxena\nHamptons Coconuts\n55 Cambridge Drive, Colonia, NJ 07067', {});
  assert.equal(ownSig.candidate, null); assert.deepEqual(reasons(ownSig), ['own_address']);
  // A billing block, and a forwarded From: header just above a street.
  const bill = extractDeliveryAddresses('Bill to:\nCanelle Holdings LLC\n120 Park Avenue, Suite 900, New York, NY 10271', {});
  assert.equal(bill.candidate, null); assert.deepEqual(reasons(bill), ['billing']);
  const remit = extractDeliveryAddresses('Please remit payment to 120 Park Avenue, Suite 900, New York, NY 10271', {});
  assert.equal(remit.candidate, null); assert.deepEqual(reasons(remit), ['billing']);
  const fwd = extractDeliveryAddresses('From: Jane Doe <jane@example.invalid>\n120 Park Avenue, Suite 900, New York, NY 10271', {});
  assert.equal(fwd.candidate, null); assert.deepEqual(reasons(fwd), ['billing']);
  // A real forward puts Date:/Sent:, Subject: and To: between the From:
  // line and the message (review round 3): the From: line is looked up
  // through that header block. A florist's or a rental company's drop
  // point is not ours (vendor); a planner's forward is the billing rule's
  // forwarded From: header; a forward from the customer's own other
  // address still reads.
  const gmailFwd = extractDeliveryAddresses('FYI\n\n---------- Forwarded message ---------\nFrom: Blooms Florist <b@blooms.com>\nDate: Mon, Sep 14, 2026 at 9:00 AM\nSubject: delivery\nTo: Alison <a@icloud.com>\n\nWe will deliver the arrangements to 12 Ocean Rd, Southampton, NY 11968 at 2pm.', SHEELEY);
  assert.equal(gmailFwd.candidate, null); assert.deepEqual(reasons(gmailFwd), ['vendor']);
  const outlookFwd = extractDeliveryAddresses('FYI\n\nFrom: Party Rentals Co <x@rentals.com>\nSent: Monday, September 14, 2026 9:00 AM\nTo: Alison Sheeley\nSubject: Saturday\n\nWe will send everything to 45 Main St, Sag Harbor, NY 11963', SHEELEY);
  assert.equal(outlookFwd.candidate, null); assert.deepEqual(reasons(outlookFwd), ['vendor']);
  const appleFwd = extractDeliveryAddresses('Begin forwarded message:\n\nFrom: Jane Doe <jane@example.invalid>\nSubject: address\nDate: September 14, 2026 at 9:00:00 AM EDT\nTo: Alison <a@icloud.com>\n\nHi Alison,\nPlease deliver to 491 S Dean Street, Englewood, NJ 07631.', SHEELEY);
  assert.equal(appleFwd.candidate, null); assert.deepEqual(reasons(appleFwd), ['billing']);
  const ownFwd = extractDeliveryAddresses('FYI\n\n---------- Forwarded message ---------\nFrom: Sheeley, Alison <alison@icloud.com>\nDate: Mon, Sep 14, 2026 at 9:00 AM\nSubject: address\nTo: Jane <jane@example.invalid>\n\nPlease deliver to 491 S Dean Street, Englewood, NJ 07631.', SHEELEY);
  assert.equal(ownFwd.candidate.text, '491 S Dean Street, Englewood, NJ 07631'); assert.deepEqual(reasons(ownFwd), []);
  // The common forward shape: header block, blank, a greeting, blank, the
  // body (and a body two paragraphs down). Everything under a real
  // forward header belongs to the forwarded sender, whatever the distance,
  // for all four clients: Gmail, Outlook desktop, Apple Mail and the
  // one-line Outlook mobile header.
  const GREETED = 'Hi Alison,\n\nWe will deliver the arrangements to 12 Ocean Rd, Southampton, NY 11968 at 2pm.';
  const gmailGreeted = extractDeliveryAddresses('FYI\n\n---------- Forwarded message ---------\nFrom: Blooms Florist <b@blooms.com>\nDate: Mon, Sep 14, 2026 at 9:00 AM\nSubject: delivery\nTo: Alison <a@icloud.com>\n\n' + GREETED, SHEELEY);
  assert.equal(gmailGreeted.candidate, null); assert.deepEqual(reasons(gmailGreeted), ['vendor'], 'Gmail, greeting then blank');
  const outlookGreeted = extractDeliveryAddresses('FYI\n\nFrom: Party Rentals Co <x@rentals.com>\nSent: Monday, September 14, 2026 9:00 AM\nTo: Alison Sheeley\nSubject: Saturday\nImportance: High\nAttachments: quote.pdf\n\n' + GREETED, SHEELEY);
  assert.equal(outlookGreeted.candidate, null); assert.deepEqual(reasons(outlookGreeted), ['vendor'], 'Outlook, Importance: and Attachments: close the block');
  const appleGreeted = extractDeliveryAddresses('Begin forwarded message:\n\nFrom: Jane Doe <jane@example.invalid>\nSubject: address\nDate: September 14, 2026 at 9:00:00 AM EDT\nTo: Alison <a@icloud.com>\n\nHi Alison,\n\nPlease deliver to 491 S Dean Street, Englewood, NJ 07631.', SHEELEY);
  assert.equal(appleGreeted.candidate, null); assert.deepEqual(reasons(appleGreeted), ['billing'], 'Apple Mail, greeting then blank');
  const oneLinePlanner = extractDeliveryAddresses('FYI\n\nFrom: Jane Doe <jane@planner.com> Sent: Monday, September 14, 2026 9:00 AM To: Alison Sheeley <a@icloud.com> Subject: Saturday\n\nHi Alison,\n\nPlease deliver to 491 S Dean Street, Englewood, NJ 07631.', SHEELEY);
  assert.equal(oneLinePlanner.candidate, null); assert.deepEqual(reasons(oneLinePlanner), ['billing'], 'a one-line header: the customer in To: does not make it hers');
  const twoDown = extractDeliveryAddresses('FYI\n\n---------- Forwarded message ---------\nFrom: Blooms Florist <b@blooms.com>\nDate: Mon, Sep 14, 2026 at 9:00 AM\nSubject: delivery\nTo: Alison <a@icloud.com>\n\nHi Alison,\n\nThanks for your order.\n\nWe will deliver the arrangements to 12 Ocean Rd, Southampton, NY 11968 at 2pm.', SHEELEY);
  assert.equal(twoDown.candidate, null); assert.deepEqual(reasons(twoDown), ['vendor'], 'a body two paragraphs under the header');
  // The customer's own forward reads whatever the From: line calls her: a
  // first name alone, her surname alone, her address alone (compared with
  // the order's client_email, a list), or a one-line header whose Subject:
  // names a florist (only the sender part is tested). A customer whose own
  // name carries a vendor word (a caterer, a DJ buying coconuts) is tested
  // as the customer before the vendor rule sees her.
  const FWD = (from) => 'FYI\n\n---------- Forwarded message ---------\nFrom: ' + from + '\nDate: Mon, Sep 14, 2026 at 9:00 AM\nSubject: address\nTo: Jane <jane@example.invalid>\n\nHi Jane,\n\nPlease deliver to 491 S Dean Street, Englewood, NJ 07631.';
  for (const from of ['Alison <alison@icloud.com>', 'Sheeley <alison@icloud.com>', 'A. Sheeley <alison@icloud.com>']) {
    const r = extractDeliveryAddresses(FWD(from), SHEELEY);
    assert.equal(r.candidate && r.candidate.text, '491 S Dean Street, Englewood, NJ 07631', from); assert.deepEqual(reasons(r), [], from);
  }
  const bareEmail = extractDeliveryAddresses(FWD('alison@icloud.com'), { ...SHEELEY, clientEmails: 'other@x.com, Alison@icloud.com' });
  assert.equal(bareEmail.candidate.text, '491 S Dean Street, Englewood, NJ 07631'); assert.deepEqual(reasons(bareEmail), []);
  assert.deepEqual(reasons(extractDeliveryAddresses(FWD('alison@icloud.com'), SHEELEY)), ['billing'], 'a bare address not on the order is still another sender');
  assert.deepEqual(reasons(extractDeliveryAddresses(FWD('Jane Doe <jane@example.invalid>'), { ...SHEELEY, clientEmails: 'alison@icloud.com' })), ['billing']);
  assert.deepEqual(reasons(extractDeliveryAddresses(FWD('Blooms Florist <b@blooms.com>'), { clientName: 'Blooms Sheeley' })), ['vendor'], 'one shared word is not the customer');
  const oneLineOwn = extractDeliveryAddresses('FYI\n\nFrom: Alison Sheeley <a@icloud.com> Sent: Monday, September 14, 2026 9:00 AM To: Jane Doe <jane@planner.com> Subject: florist and cake\n\nPlease deliver to 491 S Dean Street, Englewood, NJ 07631.', SHEELEY);
  assert.equal(oneLineOwn.candidate.text, '491 S Dean Street, Englewood, NJ 07631'); assert.deepEqual(reasons(oneLineOwn), []);
  const subjectVendor = extractDeliveryAddresses('FYI\n\nFrom: Alison Sheeley <a@icloud.com>\nSent: Monday, September 14, 2026 9:00 AM\nTo: Jane Doe <jane@planner.com>\nSubject: florist and cake\n\nPlease deliver to 491 S Dean Street, Englewood, NJ 07631.', SHEELEY);
  assert.equal(subjectVendor.candidate.text, '491 S Dean Street, Englewood, NJ 07631', 'a Subject: line naming a vendor is not a vendor list'); assert.deepEqual(reasons(subjectVendor), []);
  for (const [name, from] of [['Feast Co Catering', 'Feast Co Catering <orders@feastco.com>'], ['DJ Marco Events', 'DJ Marco Events <dj@marco.com>']]) {
    const r = extractDeliveryAddresses(FWD(from), { clientName: name });
    assert.equal(r.candidate && r.candidate.text, '491 S Dean Street, Englewood, NJ 07631', name); assert.deepEqual(reasons(r), [], name);
  }
  assert.deepEqual(reasons(extractDeliveryAddresses(FWD('Blooms Catering <b@blooms.com>'), { clientName: 'Feast Co Catering' })), ['vendor'], 'another caterer is still a vendor');
  // A From: label the customer pasted paragraphs up, with no header line
  // beside it, is not a header block and never reaches her own instruction.
  const pasted = extractDeliveryAddresses('From: Jane (my planner)\n"use the side entrance"\n\nAnyway, please deliver to 491 S Dean Street, Englewood, NJ 07631.', SHEELEY);
  assert.equal(pasted.candidate.text, '491 S Dean Street, Englewood, NJ 07631'); assert.deepEqual(reasons(pasted), []);
  // A plural "Vendors:" header, and our own entry directly above another
  // vendor's line: the florist's street is still a vendor's (the exemption
  // reads the candidate's own line and its label, never the whole window).
  const plural = extractDeliveryAddresses('Vendors:\nHamptons Coconuts, 55 Cambridge Dr, Colonia, NJ 07067\nFlorist: 12 Bridge Street, Sag Harbor, NY 11963', {});
  assert.equal(plural.candidate, null); assert.deepEqual(reasons(plural), ['own_address', 'vendor']);
  assert.deepEqual(reasons(extractDeliveryAddresses('Caterers: 88 Elm Ave, Montclair, NJ 07042', {})), ['vendor']);
  assert.deepEqual(reasons(extractDeliveryAddresses("The florist's shop is at 12 Bridge Street, Sag Harbor, NY 11963", {})), ['vendor']);
  // Our own entry in a vendor list still reads, labelled on its line or above it.
  const ours = extractDeliveryAddresses('Vendors:\nFlorist: 12 Bridge Street, Sag Harbor, NY 11963\nHamptons Coconuts: deliver to 45 Main St, Southampton, NY 11968', {});
  assert.equal(ours.candidate.text, '45 Main St, Southampton, NY 11968'); assert.deepEqual(reasons(ours), ['vendor']);
  const oursBelow = extractDeliveryAddresses('Vendors:\nHamptons Coconuts\n45 Main St, Southampton, NY 11968', {});
  assert.equal(oursBelow.candidate.text, '45 Main St, Southampton, NY 11968');
  // "Bill to" one line above "Deliver to": only the billing line goes. A
  // billing word on the candidate's own line rejects whatever else it says.
  const twoLines = extractDeliveryAddresses('Bill to: 10 Park Ave, New York, NY 10016\nDeliver to: 491 S Dean Street, Englewood, NJ 07631', {});
  assert.equal(twoLines.candidate.text, '491 S Dean Street, Englewood, NJ 07631'); assert.deepEqual(reasons(twoLines), ['billing']);
  assert.deepEqual(reasons(extractDeliveryAddresses('Deliver to 491 S Dean Street, Englewood, NJ 07631 and bill to our office', {})), ['billing']);
  // "Avenue" is not the STRONG word "venue": a billing block on Park Avenue
  // stays a billing block, and a bare Avenue address has no keyword rank.
  assert.deepEqual(reasons(extractDeliveryAddresses('Bill to:\n120 Park Avenue, New York, NY 10271', {})), ['billing']);
  assert.equal(extractDeliveryAddresses('120 Park Avenue, New York, NY 10271', {}).candidate.rank, 3);
  assert.equal(extractDeliveryAddresses('Delivery: 120 Park Avenue, New York, NY 10271', {}).candidate.rank, 0, '"delivery" still reads as "deliver"');
  pass('vendor lists yield nothing (plural and possessive labels too, our entry never exempts a neighbour), the venue line in one reads, our garage and denylisted streets are own_address, billing blocks and From: headers reject (a forwarded vendor is vendor, a forwarded planner is billing, the customer\'s own forward reads by name, surname, first name or client_email, through the header, the greeting and any distance; one-line headers are cut at the next label; a Subject: line is never a vendor label; a caterer buying coconuts is the customer first), a STRONG line beats a billing line above it, Avenue is not venue');
}
// ── 4. Quoted text and reply headers ───────────────────────────────
{
  // Our reconfirmation email quoted back under a reply: the address in it is not new.
  const quoted = extractDeliveryAddresses('Confirmed, thanks!\n\nOn Mon, Sep 14, 2026 at 1:24 AM Sidd Saxena <sidd@hamptonscoconuts.com> wrote:\n> Delivery: Saturday, September 19, arriving 3:30 PM\n> Drop off: Pridwin Hotel, 81 Shore Rd, Shelter Island, NY 11964', { venue: 'Pridwin Hotel' });
  assert.equal(quoted.candidate, null); assert.deepEqual(quoted.rejected, []);
  // A Gmail reply header whose sender is named after a street: dropped with
  // everything under it.
  const header = extractDeliveryAddresses('Sounds good.\n\nOn Mon, Sep 14, 2026 at 10:02 AM 45 Ocean Road Events <events@example.invalid> wrote:\n> Deliver to 45 Ocean Road, Bridgehampton, NY 11932', {});
  assert.equal(header.candidate, null);
  // An Outlook "Sent:" line is skipped whole and never lends context.
  const sent = extractDeliveryAddresses('Sent: 12 Ocean Rd, Bridgehampton, NY 11932\nSee attached.', {});
  assert.equal(sent.candidate, null);
  pass('quoted reconfirmations, reply headers carrying a street name and Sent: lines are never read');
}
// ── 5. Two sites ───────────────────────────────────────────────────
{
  const one = extractDeliveryAddresses('Ceremony at 12 Ocean Rd, Bridgehampton, NY 11932.\nPlease deliver the coconuts to 45 Main St, Southampton, NY 11968 for the reception.', {});
  assert.equal(one.candidate.text, '45 Main St, Southampton, NY 11968'); assert.equal(one.reason, null);
  const none = extractDeliveryAddresses('12 Ocean Rd, Bridgehampton, NY 11932\n\n45 Main St, Southampton, NY 11968', {});
  assert.equal(none.candidate, null); assert.equal(none.reason, 'ambiguous'); assert.equal(none.found.length, 2);
  // The same site twice (once with a period, once with the long suffix) is one candidate, not two.
  const twice = extractDeliveryAddresses('45 Main St., Southampton, NY 11968\nthen later: 45 Main Street, Southampton, NY', {});
  assert.equal(twice.candidate.text, '45 Main St, Southampton, NY 11968');
  // Two WEAK candidates tie: ambiguous; a body candidate beats a PDF one at equal rank.
  const weak = extractDeliveryAddresses('The ceremony is at 12 Ocean Rd, Bridgehampton, NY 11932 and the reception at 45 Main St, Southampton, NY 11968.', {});
  assert.equal(weak.reason, 'ambiguous');
  const body = extractDeliveryAddresses('Deliver to 45 Main St, Southampton, NY 11968.' + PDF('t.pdf', 'Deliver to 12 Ocean Rd, Bridgehampton, NY 11932'), {});
  assert.equal(body.reason, 'ambiguous', 'two distinct STRONG sites, one in a PDF: still nobody guesses');
  pass('two sites: the one with "deliver" wins; two with none or two WEAK ties are ambiguous; the same site written twice is one');
}
// ── 6. Shapes that are never candidates ────────────────────────────
{
  assert.equal(extractDeliveryAddresses('Deliver to PO Box 12, Sag Harbor, NY 11963', {}).candidate, null);
  assert.equal(extractDeliveryAddresses('Deliver to P.O. Box 12 Main Street, Sag Harbor, NY 11963', {}).candidate, null);
  assert.equal(extractDeliveryAddresses('Deliver to 45 Main St', {}).candidate, null, 'a street with no city or state');
  assert.equal(extractDeliveryAddresses('Deliver to Englewood, NJ', {}).candidate, null, 'a town with no street');
  assert.equal(extractDeliveryAddresses('Call 201-555-0143 or deliver to 07631', {}).candidate, null, 'a phone and a ZIP alone');
  assert.equal(extractDeliveryAddresses('Deliver to Route 27', {}).candidate, null);
  assert.equal(extractDeliveryAddresses('Deliver to 45 Main St, Toronto, ON M5V 2T6', {}).candidate, null, 'a state outside the list');
  assert.equal(extractDeliveryAddresses('Deliver to 45 Main St, Nowhere Special', {}).candidate, null, 'a bare unknown city never borrows a state');
  pass('PO boxes, a street alone, a town alone, a phone, a ZIP, Route 27 alone, an unlisted state and an unknown bare city are never candidates');
}
// ── 7. Nevada, and a town-hint town with no state written ──────────
{
  const nv = extractDeliveryAddresses('Send to 3708 S Las Vegas Blvd, Las Vegas, NV 89109', {});
  assert.equal(nv.candidate.text, '3708 S Las Vegas Blvd, Las Vegas, NV 89109'); assert.equal(nv.candidate.state, 'NV');
  const town = extractDeliveryAddresses('Deliver to 12 Ocean Rd, Southampton', {});
  assert.equal(town.candidate.text, '12 Ocean Rd, Southampton, NY'); assert.equal(town.candidate.state_inferred, true); assert.equal(town.candidate.state_from, 'Southampton');
  const vegas = extractDeliveryAddresses('Deliver to 3708 S Las Vegas Blvd\nLas Vegas 89109', {});
  assert.equal(vegas.candidate.state, 'NV'); assert.equal(vegas.candidate.postal_code, '89109'); assert.equal(vegas.candidate.state_inferred, true);
  // The order's own venue town is never borrowed to complete a bare street.
  const borrow = extractDeliveryAddresses('Deliver to 12 Ocean Rd', { venue: 'Pridwin Hotel, Shelter Island' });
  assert.equal(borrow.candidate, null);
  // A Hamptons highway shape and a county road.
  assert.equal(extractDeliveryAddresses('Deliver to 2266 Montauk Highway, Bridgehampton, NY 11932', {}).candidate.line1, '2266 Montauk Highway');
  assert.equal(extractDeliveryAddresses('Deliver to 100 County Road 39, Southampton, NY 11968', {}).candidate.line1, '100 County Road 39');
  pass('Nevada reads; a town-hint town supplies its state as state_inferred; the venue is never borrowed; highway shapes read');
}
// ── 8. The normalized key and agreement ────────────────────────────
{
  assert.equal(normalizeAddressKey('491 S. Dean Street, Englewood, NJ 07631, USA'), '491 s dean st englewood nj 07631');
  assert.equal(normalizeAddressKey('491 South Dean St Englewood NJ 07631 United States'), '491 s dean st englewood nj 07631');
  assert.deepEqual(addressKeyParts('491 s dean st englewood nj 07631'), { house: '491', dir: 's', word: 'dean' });
  assert.deepEqual(addressKeyParts('pridwin hotel 81 shore rd shelter island ny 11964'), { house: '81', dir: null, word: 'shore' });
  assert.equal(addressKeyParts('shelter island ny'), null);
  const cand = { key: normalizeAddressKey('491 S Dean Street, Englewood, NJ 07631'), city: 'Englewood', postal_code: '07631', text: '491 S Dean Street, Englewood, NJ 07631' };
  assert.equal(addressesAgree(cand, '491 South Dean St Englewood NJ 07631'), true, 'same house, street word and city');
  assert.equal(addressesAgree(cand, '491 S Dean St, 07631'), true, 'same ZIP stands in for the city');
  assert.equal(addressesAgree(cand, '419 S Dean Street, Englewood, NJ 07631'), false, 'a different house number');
  assert.equal(addressesAgree(cand, '491 S Dean Street, Teaneck, NJ 07666'), false, 'a different town and ZIP');
  assert.equal(addressesAgree(cand, 'Pridwin Hotel, Shelter Island, NY'), false);
  assert.equal(addressesAgree(cand, null), false);
  // The direction word: 491 N Dean and 491 S Dean are two houses in
  // Englewood, Manhattan's numbered streets split E/W. Both sides carrying
  // one must match; one side without it still agrees (a re-quote that
  // dropped the S).
  const north = { key: normalizeAddressKey('491 N Dean Street, Englewood, NJ 07631'), city: 'Englewood', postal_code: '07631', text: '491 N Dean Street, Englewood, NJ 07631' };
  assert.equal(addressesAgree(north, '491 S Dean Street, Englewood, NJ 07631'), false, 'N versus S');
  assert.equal(addressesAgree(cand, '491 North Dean Street, Englewood, NJ 07631'), false, 'S versus North written out');
  assert.equal(addressesAgree({ key: normalizeAddressKey('12 E 4th St, New York, NY 10003'), city: 'New York', postal_code: '10003' }, '12 W 4th St, New York, NY 10011'), false, 'E versus W');
  assert.equal(addressesAgree({ key: normalizeAddressKey('491 Dean Street, Englewood, NJ 07631'), city: 'Englewood', postal_code: '07631' }, '491 S Dean Street, Englewood, NJ 07631'), true, 'no direction on one side still agrees');
  assert.equal(addressesAgree(cand, '491 Dean Street, Englewood, NJ'), true, 'no direction on file still agrees');
  // The city must be the whole town: Englewood is not Englewood Cliffs,
  // Miami is not Miami Beach (adjacent towns, different ZIPs); the words
  // after the city on file must be a state (short or in full), a ZIP or
  // nothing at all.
  const noZip = { key: normalizeAddressKey('491 S Dean St, Englewood, NJ'), city: 'Englewood', postal_code: null };
  assert.equal(addressesAgree(noZip, '491 S Dean St, Englewood Cliffs, NJ 07632'), false, 'Englewood versus Englewood Cliffs');
  assert.equal(addressesAgree({ key: normalizeAddressKey('12 Ocean Dr, Miami, FL'), city: 'Miami', postal_code: null }, '12 Ocean Dr, Miami Beach, FL 33139'), false, 'Miami versus Miami Beach');
  assert.equal(addressesAgree(noZip, '491 S Dean St, Englewood, NJ'), true);
  assert.equal(addressesAgree(noZip, '491 S Dean Street Englewood NJ 07631'), true, 'a one-line file without commas');
  assert.equal(addressesAgree(noZip, '491 S Dean St, Englewood 07631'), true, 'a ZIP after the city');
  assert.equal(addressesAgree(noZip, '491 S Dean St, Englewood, New Jersey 07631'), true, 'the state in full');
  assert.equal(addressesAgree(noZip, '491 S Dean St, Englewood'), true, 'the city ends the text');
  assert.equal(addressesAgree({ key: normalizeAddressKey('12 Southampton Rd, Southampton, NY'), city: 'Southampton', postal_code: null }, '12 Southampton Rd, Southampton, NY 11968'), true, 'the town word inside the street name is skipped');
  assert.equal(addressPlaceWords('45 Main St, Southampton, NY 11968'), 'Southampton, NY');
  assert.equal(addressPlaceWords('Pridwin Hotel, 81 Shore Rd, Shelter Island, New York 11964'), 'Shelter Island, NY');
  assert.equal(addressPlaceWords('Pridwin Hotel'), null);
  // A one-line invoice address typed without commas must answer null, never
  // the street: the banner then says "a different address" (review round 2).
  assert.equal(addressPlaceWords('491 S Dean Street Englewood NJ 07631'), null, 'a comma-free one-line address never leaks the street into a banner');
  assert.equal(addressPlaceWords('491 S Dean St, Englewood, NJ, 07631'), 'Englewood, NJ');
  assert.equal(addressPlaceWords('55 Cambridge Dr Colonia NJ'), null);
  pass('normalized keys agree across punctuation and suffixes; agreement needs the house, the street word, the direction when both sides carry one, and the whole town (state, ZIP or nothing after it) or the ZIP; place words for a banner, never the street');
}
// ── 9. The geocode match: a ZIP only from the same house ───────────
{
  const cand = { house: '491', state: 'NJ', city: 'Englewood' };
  const hit = (sa) => ({ results: [{ structuredAddress: sa }] });
  assert.deepEqual(geocodeZipFor(cand, hit({ subThoroughfare: '491', administrativeAreaCode: 'NJ', locality: 'Englewood', postCode: '07631' })), { confirmed: true, postal_code: '07631' });
  assert.deepEqual(geocodeZipFor(cand, hit({ subThoroughfare: '493', administrativeAreaCode: 'NJ', locality: 'Englewood', postCode: '07631' })), { confirmed: false, postal_code: null }, 'house mismatch');
  assert.deepEqual(geocodeZipFor(cand, hit({ subThoroughfare: '491', administrativeAreaCode: 'PA', locality: 'Englewood', postCode: '19000' })), { confirmed: false, postal_code: null }, 'state mismatch');
  assert.deepEqual(geocodeZipFor(cand, hit({ subThoroughfare: '491', administrativeAreaCode: 'NJ', locality: 'Teaneck', postCode: '07666' })), { confirmed: false, postal_code: null }, 'town mismatch');
  assert.deepEqual(geocodeZipFor(cand, hit({ subThoroughfare: '491', administrativeAreaCode: 'NJ', locality: 'Bergen', dependentLocalities: ['Englewood'], postCode: '07631-1234' })), { confirmed: true, postal_code: '07631' }, 'a dependent locality counts; ZIP+4 is cut');
  assert.deepEqual(geocodeZipFor(cand, hit({ subThoroughfare: '491', administrativeAreaCode: 'NJ', locality: 'Englewood' })), { confirmed: true, postal_code: null }, 'confirmed but no postCode');
  assert.deepEqual(geocodeZipFor(cand, { results: [] }), { confirmed: false, postal_code: null });
  assert.deepEqual(geocodeZipFor(cand, null), { confirmed: false, postal_code: null });
  pass('geocode: the ZIP is taken only when house, state and town all match; any mismatch or empty answer keeps it null');
}
// ── 10. Agreement with what is on file ─────────────────────────────
{
  const cand = extractDeliveryAddresses('Deliver to 491 S Dean Street, Englewood, NJ 07631', SHEELEY).candidate;
  const order = (inv, extra = {}) => ({ id: 'o1', external_invoice_id: '188', invoice_fulfillment: inv, delivery_notes: null, venue: null, ...extra });
  const inv = (address, structured, updated = '2026-08-20T10:00:00Z') => ({ read_status: 'complete', address, address_structured: structured, source_updated_at: updated });
  const EMAIL_AT = '2026-08-22T14:00:00Z';
  assert.equal(addressProposalVerdict(cand, order(inv('491 S Dean Street, Englewood, NJ 07631', true)), EMAIL_AT).verdict, 'agree', 'structured and equal: silent');
  assert.equal(addressProposalVerdict(cand, order(inv('491 S Dean Street Englewood NJ 07631', false)), EMAIL_AT).verdict, 'one_line', 'one line: propose');
  assert.equal(addressProposalVerdict(cand, order(inv('491 S Dean Street, Englewood, NJ 07631')), EMAIL_AT).verdict, 'one_line', 'structure unknown: propose');
  assert.equal(addressProposalVerdict(cand, order(inv(null, false), { delivery_notes: '491 S Dean St, Englewood NJ' }), EMAIL_AT).verdict, 'one_line', 'the match came from the notes: propose');
  assert.equal(addressProposalVerdict(cand, order(inv(null, false)), EMAIL_AT).verdict, 'conflict', 'nothing on file');
  assert.equal(addressProposalVerdict(cand, order(inv('45 Main St, Southampton, NY 11968', true)), EMAIL_AT).verdict, 'conflict', 'a different structured address, older than the email');
  const v = addressProposalVerdict(cand, order(inv('45 Main St, Southampton, NY 11968', true, '2026-09-14T10:00:00Z')), EMAIL_AT);
  assert.equal(v.verdict, 'stale'); assert.equal(v.onFileNewer, true);
  assert.equal(addressProposalVerdict(cand, order(inv('45 Main St Southampton NY', false, '2026-09-14T10:00:00Z')), EMAIL_AT).verdict, 'conflict', 'a newer one-line edit is not stale');
  assert.equal(addressProposalVerdict(cand, order(inv(null, false), { venue: 'Pridwin Hotel, Shelter Island, NY' }), EMAIL_AT).verdict, 'conflict', 'a venue-only file');
  assert.equal(addressProposalVerdict(cand, order(inv('491 S Dean Street, Englewood, NJ 07631', true), { external_invoice_id: null }), EMAIL_AT).verdict, 'no_invoice');
  const d = addressProposalVerdict(cand, order(inv('45 Main St, Southampton, NY 11968', true)), EMAIL_AT);
  assert.equal(d.dest.address, '45 Main St, Southampton, NY 11968'); assert.equal(d.dest.source, 'invoice'); assert.equal(d.structured, true);
  pass('agreement: structured agree is silent, one-line or unknown or notes agree proposes, a newer structured edit is stale, everything else conflicts, no invoice is skipped');
}
// ── 10b. Our own reconfirmation bullet quoted back ──────────────────
{
  // The plain-text shape Outlook gives our HTML bullet list, as Sidd's
  // edited test copy for Allie Sugano arrived on 2026-09-19.
  const quoted = 'Hi Allie,\n\nJust sending the final details for reconfirmation.\n\n  *   Delivery: Wednesday, September 23, arrival time: please tell us\n  *   Drop off: 24 Spring St., New York, NY, 10012, US\n  *   Count: 40 coconuts\n\nThanks so much,\nSidd\nHamptons Coconuts';
  const cand = extractDeliveryAddresses(quoted, { venue: '24 Spring St.', clientName: 'Allie Sugano', clientEmails: 'allie@caliraybeauty.com' }).candidate;
  assert.ok(cand && cand.evidence.includes('Drop off:'), 'the bullet is read as a candidate');
  const order = (inv) => ({ id: 'o2', external_invoice_id: '3519', invoice_fulfillment: inv, delivery_notes: null, venue: '24 Spring St.' });
  const inv = (address, structured) => ({ read_status: 'complete', address, address_structured: structured, source_updated_at: '2026-09-10T10:00:00Z' });
  const EMAIL_AT = '2026-09-20T01:28:53Z';
  assert.equal(quotesOwnDropOffLine(cand, '24 Spring St., New York, NY, 10012, US'), true, 'St. and St agree, US is dropped');
  assert.equal(quotesOwnDropOffLine(cand, '30 Spring St., New York, NY, 10012, US'), false, 'a different house is not a quote');
  assert.equal(quotesOwnDropOffLine({ evidence: 'Deliver to 24 Spring St, New York, NY 10012' }, '24 Spring St., New York, NY, 10012, US'), false, 'no Drop off label: not our bullet');
  assert.equal(addressProposalVerdict(cand, order(inv('24 Spring St., New York, NY, 10012, US')), EMAIL_AT).verdict, 'agree', 'structure unknown but our own bullet quoted: silent');
  assert.equal(addressProposalVerdict(cand, order(inv('24 Spring St., New York, NY, 10012, US', false)), EMAIL_AT).verdict, 'agree', 'one-line invoice, our own bullet quoted: still silent (nothing new to write)');
  assert.equal(addressProposalVerdict(cand, order(inv('30 Spring St., New York, NY, 10012, US', true)), EMAIL_AT).verdict, 'conflict', 'a different address on file: the quote is news, proposed as before');
  const other = extractDeliveryAddresses('Hi, please note the new spot:\n\n  *   Drop off: 30 Spring St., New York, NY, 10012, US', { venue: '24 Spring St.', clientName: 'Allie Sugano', clientEmails: 'allie@caliraybeauty.com' }).candidate;
  assert.equal(addressProposalVerdict(other, order(inv('24 Spring St., New York, NY, 10012, US')), EMAIL_AT).verdict, 'conflict', 'a changed address after Drop off: proposes');
  pass('own bullet: a reply quoting our Drop off line for the address on file is silent whatever the structure flag; any other address still proposes');
}

console.log(`\nPASS: ${passed} address extraction checks. No network, no database, no phone.`);

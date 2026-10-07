// Website quote form reader tests: no framework, no network, exit non-zero
// on failure. Run: node worker/test-website-form.mjs
// Background (2026-10-06): a customer's website form said coconut_count 20,
// event_type Wedding, delivery_market Greater NY area and budget $1,500 to
// $3,000, and her lead showed no count. The classifier prompt has no count
// or budget field, so the model filed the count as guests (13 of 16 recent
// form leads) and often guessed market and event type. Every person, address
// and phone number below is invented (example.com, 555 numbers).
import assert from 'node:assert/strict';
import worker, {
  parseWebsiteForm, websiteFormMarket, websiteFormEventType,
  websiteFormFromNotification, applyWebsiteFormToLead, websiteFormNoteLines,
  runWebhookIntakeScan,
} from './worker.js';

let failed = 0;
let total = 0;
async function check(name, fn) {
  total++;
  try {
    await fn();
    console.log('PASS  ' + name);
  } catch (error) {
    failed++;
    console.log('FAIL  ' + name);
    console.log('      ' + String(error && error.message || error).split('\n')[0]);
  }
}

const LABELS = ['name', 'email', 'phone', 'event_date', 'event_type',
  'delivery_market', 'coconut_count', 'budget', 'message'];

// A Formspree notice in Graph's plain-text layout, the same shape as the
// real rows (and Jarvis's tests/test_form_phone_fill.py _form): a preheader
// line, the heading, the "Someone just submitted" line, then label and value
// lines with a blank line between every line. A field set to '' leaves its
// label followed straight by the next label; a field in `omit` is left out.
function formNotice(fields = {}, opts = {}) {
  const { eol = '\r\n', preheader = true, intro = true, omit = [], tail = [] } = opts;
  const values = {
    name: 'Avery Testcase',
    email: 'avery.testcase@example.com<mailto:avery.testcase@example.com>',
    phone: '(555) 010-0142',
    event_date: '2027-07-17',
    event_type: 'Wedding',
    delivery_market: 'Greater NY area (NY, NJ, CT)',
    coconut_count: '20',
    budget: '$1,500 to $3,000',
    message: 'Beach ceremony, branded coconuts for the welcome table.',
    ...fields,
  };
  const parts = [];
  if (preheader) parts.push("You've received a new form submission. --");
  parts.push('New form submission on Hamptons Coconuts Quote Requests');
  if (intro) parts.push("Someone just submitted a form on hamptonscoconuts.com/. Here's what they had to say:");
  for (const label of LABELS) {
    if (omit.includes(label)) continue;
    parts.push(label);
    if (values[label] !== '') parts.push(values[label]);
  }
  parts.push(...tail);
  return parts.join(eol + eol) + eol;
}

const EXPECTED = {
  name: 'Avery Testcase',
  email: 'avery.testcase@example.com',
  phone: '(555) 010-0142',
  event_date: '2027-07-17',
  event_type: 'Wedding',
  delivery_market: 'Greater NY area (NY, NJ, CT)',
  coconut_count: 20,
  budget: '$1,500 to $3,000',
};

// One field's parsed value from an otherwise complete notice.
const parsedField = (label, value) => parseWebsiteForm(formNotice({ [label]: value }))[label];

// ── 1. The parser ──
await check('the real layout (CRLF, preheader, intro line) reads every field', () => {
  assert.deepEqual(parseWebsiteForm(formNotice()), EXPECTED);
});

await check('LF line ends and no preheader read the same', () => {
  assert.deepEqual(parseWebsiteForm(formNotice({}, { eol: '\n', preheader: false })), EXPECTED);
  assert.deepEqual(parseWebsiteForm(formNotice({}, { eol: '\n', intro: false })), EXPECTED);
});

await check('the message is never returned and trailing lines change nothing', () => {
  const parsed = parseWebsiteForm(formNotice({}, { tail: ['Mark as spam', 'Formspree footer line'] }));
  assert.deepEqual(parsed, EXPECTED);
  assert.equal('message' in parsed, false);
});

await check('only the known fields come back (unknown labels are ignored)', () => {
  const body = formNotice().replace('name\r\n', '_subject\r\n\r\nquote request\r\n\r\ncompany\r\n\r\nExample Co\r\n\r\nname\r\n');
  const parsed = parseWebsiteForm(body);
  assert.deepEqual(parsed, EXPECTED);
  for (const key of Object.keys(parsed)) assert.ok(Object.keys(EXPECTED).includes(key), key);
});

await check('no heading, or the heading below line 3, is not a form', () => {
  assert.deepEqual(parseWebsiteForm('Hi,\n\nWe need coconuts.\n\ncoconut_count\n\n20\n'), {});
  const late = 'Hello\n\nForwarded\n\nAnother line\n\n' + formNotice({}, { eol: '\n', preheader: false });
  assert.deepEqual(parseWebsiteForm(late), {});
  assert.deepEqual(parseWebsiteForm(null), {});
  assert.deepEqual(parseWebsiteForm(undefined), {});
  assert.deepEqual(parseWebsiteForm(42), {});
});

await check('the heading test ignores letter case', () => {
  const body = formNotice().replace('New form submission on', 'NEW FORM SUBMISSION ON');
  assert.deepEqual(parseWebsiteForm(body), EXPECTED);
});

await check('a blank field (label straight to the next label) and a missing label are absent', () => {
  const parsed = parseWebsiteForm(formNotice({ phone: '', budget: '' }, { omit: ['delivery_market'] }));
  assert.equal('phone' in parsed, false);
  assert.equal('budget' in parsed, false);
  assert.equal('delivery_market' in parsed, false);
  assert.equal(parsed.coconut_count, 20);
  assert.equal(parsed.event_date, '2027-07-17');
  // A blank name is followed by the "email" label, a word that would pass
  // the name check: the blank-field rule is what keeps it out.
  const noName = parseWebsiteForm(formNotice({ name: '' }));
  assert.equal('name' in noName, false);
  assert.equal(noName.email, EXPECTED.email);
});

await check('a label repeated inside the message gives that field up', () => {
  const parsed = parseWebsiteForm(formNotice({
    message: 'Our numbers:\r\n\r\ncoconut_count\r\n\r\n400\r\n\r\nphone\r\n\r\n(555) 010-0199',
  }));
  assert.equal('coconut_count' in parsed, false);
  assert.equal('phone' in parsed, false);
  assert.equal(parsed.email, EXPECTED.email);
});

await check('a cut-off body keeps the fields that arrived whole', () => {
  const body = formNotice();
  const cut = body.slice(0, body.indexOf('coconut_count'));
  const parsed = parseWebsiteForm(cut + 'coconut_count');
  assert.equal('coconut_count' in parsed, false);
  assert.equal(parsed.delivery_market, EXPECTED.delivery_market);
});

await check('email: the mailto suffix is dropped and the address is lower case', () => {
  assert.equal(parsedField('email', 'Avery.Testcase@Example.COM<mailto:Avery.Testcase@Example.COM>'), 'avery.testcase@example.com');
  assert.equal(parsedField('email', 'avery@example.co.uk'), 'avery@example.co.uk');
});

await check('email: junk shapes are absent', () => {
  for (const junk of ['not-an-email', 'a@@example.com', 'two@example.com, three@example.com',
    'avery@example', '.avery@example.com', 'av..ery@example.com', 'avery @example.com',
    'avery@-example.com', 'x'.repeat(250) + '@example.com']) {
    assert.equal(parsedField('email', junk), undefined, junk);
  }
});

await check('email: our own addresses and relays never name a customer', () => {
  for (const own of ['events@hamptonscoconuts.com', 'EMMA@FreshHamptonsCoconuts.com',
    'emma@brandedcoco.com', '15550100142.15550100199.abcde@txt.voice.google.com',
    'voice-noreply@google.com', 'submissions@formspree.io', 'noreply@example.com']) {
    assert.equal(parsedField('email', own), undefined, own);
  }
});

await check('phone: HC App rule (7 to 15 digits, digits and ( ) + . - only)', () => {
  assert.equal(parsedField('phone', '+1 (555) 010-0142'), '+1 (555) 010-0142');
  assert.equal(parsedField('phone', '555-0142'), '555-0142');
  assert.equal(parsedField('phone', '555.010.0142<tel:5550100142>'), '555.010.0142');
  for (const junk of ['12345', 'call me', '1'.repeat(16), '555-0142 ext 7', '(555) 010-0142!']) {
    assert.equal(parsedField('phone', junk), undefined, junk);
  }
});

await check('event_date: a real YYYY-MM-DD date only', () => {
  assert.equal(parsedField('event_date', '2028-02-29'), '2028-02-29');
  for (const junk of ['2027-02-29', '2027-13-01', '2027-7-17', '07/17/2027', '1999-12-31',
    'July 17, 2027', '2027-07-17T10:00']) {
    assert.equal(parsedField('event_date', junk), undefined, junk);
  }
});

await check('coconut_count: digits only, 1 to 20000', () => {
  assert.equal(parsedField('coconut_count', '1'), 1);
  assert.equal(parsedField('coconut_count', '20000'), 20000);
  assert.equal(parsedField('coconut_count', ' 350 '), 350);
  for (const junk of ['0', '20001', '-5', '1.5', '1,000', '20 coconuts', 'about 200', '1e3', '']) {
    assert.equal(parsedField('coconut_count', junk), undefined, JSON.stringify(junk));
  }
});

await check('budget: the site choices, any dash written as "to", free text dropped', () => {
  for (const choice of ['$1,500 to $3,000', '$3,000 to $7,000', '$7,000 to $15,000', '$15,000+', 'Not sure yet']) {
    assert.equal(parsedField('budget', choice), choice);
  }
  assert.equal(parsedField('budget', '$1,500 - $3,000'), '$1,500 to $3,000');
  assert.equal(parsedField('budget', '$1,500\u2013$3,000'), '$1,500 to $3,000');
  assert.equal(parsedField('budget', '$1,500 \u2014 $3,000'), '$1,500 to $3,000');
  assert.equal(parsedField('budget', '$1,000 to $2,000'), '$1,000 to $2,000');
  assert.equal(parsedField('budget', 'not sure'), 'Not sure yet');
  for (const junk of ['around 2k', '$1,500 to $3,000 maybe', 'cheap!', '1500 to 3000', '$1,500 to', 'Call me']) {
    assert.equal(parsedField('budget', junk), undefined, junk);
  }
});

await check('name: spaces collapsed; no letters, an address or a link is absent', () => {
  assert.equal(parsedField('name', '  Avery    Testcase '), 'Avery Testcase');
  assert.equal(parsedField('name', 'Zo\u00eb Example'), 'Zo\u00eb Example');
  for (const junk of ['12345', 'avery@example.com', 'x'.repeat(101), 'http://spam.example', '<b>Avery</b>']) {
    assert.equal(parsedField('name', junk), undefined, junk);
  }
});

await check('hidden characters: zero-width removed, no-break spaces read as spaces', () => {
  assert.equal(parsedField('coconut_count', '2\u200b0'), 20);
  const nbsp = formNotice().replace('New form submission on', 'New\u00a0form submission on');
  assert.deepEqual(parseWebsiteForm(nbsp), EXPECTED);
});

// ── 2. Market and event type from the live site's options ──
const MARKET_OPTIONS = [
  ['Greater NY area (NY, NJ, CT)', 'ny'],
  ['The Hamptons / Long Island', 'ny'],
  ['Greater Miami / South Florida', 'miami'],
  ['Orlando / Tampa / Central Florida', 'miami'],
  ['Boston', 'other'],
  ['Philadelphia / Washington DC / Baltimore', 'other'],
  ['Chicago / Midwest', 'other'],
  ['Atlanta / Southeast', 'other'],
  ['Dallas / Houston / Austin / Texas', 'other'],
  ['Las Vegas', 'vegas'],
  ['Los Angeles / Orange County / San Diego', 'other'],
  ['San Francisco / Bay Area', 'other'],
  ['Denver / Phoenix / Salt Lake City', 'other'],
  ['Seattle / Portland', 'other'],
  ['Other US city', 'other'],
];

await check('every live delivery_market option maps (15 options)', () => {
  assert.equal(MARKET_OPTIONS.length, 15);
  for (const [option, market] of MARKET_OPTIONS) {
    assert.equal(websiteFormMarket(option), market, option);
    assert.equal(parsedField('delivery_market', option), option, option);
  }
  assert.equal(websiteFormMarket('Other US city (tell us in the notes)'), 'other');
});

await check('market: letter case, spaces and dashes do not matter', () => {
  assert.equal(websiteFormMarket('greater ny area (ny, nj, ct)'), 'ny');
  assert.equal(websiteFormMarket('The Hamptons/Long Island'), 'ny');
  assert.equal(websiteFormMarket('  LAS   VEGAS '), 'vegas');
  assert.equal(websiteFormMarket('Greater Miami / South-Florida'), 'miami');
});

await check('market: unknown text maps to nothing and is not returned by the parser', () => {
  for (const unknown of ['Hamptons (NY)', 'New York', 'Miami', 'Mars', '', null, undefined]) {
    assert.equal(websiteFormMarket(unknown), null, String(unknown));
  }
  assert.equal(parsedField('delivery_market', 'Hamptons (NY)'), undefined);
});

const EVENT_OPTIONS = [
  ['Wedding', 'wedding'],
  ['Corporate / brand activation', 'corporate'],
  ['Hotel / hospitality', 'hospitality'],
  ['Festival / large event', 'other'],
  ['Private party', 'other'],
  ['Other', 'other'],
];

await check('every live event_type option maps onto the insert allowlist', () => {
  const allow = ['wedding', 'corporate', 'trade_show', 'hospitality', 'cruise', 'wellness', 'other'];
  for (const [option, type] of EVENT_OPTIONS) {
    assert.equal(websiteFormEventType(option), type, option);
    assert.ok(allow.includes(type), type);
    assert.equal(parsedField('event_type', option), option, option);
  }
  assert.equal(websiteFormEventType('WEDDING'), 'wedding');
  assert.equal(websiteFormEventType('corporate/brand-activation'), 'corporate');
});

await check('event_type: unknown text maps to nothing', () => {
  for (const unknown of ['Bar mitzvah', 'wellness', 'corporate', '', null]) {
    assert.equal(websiteFormEventType(unknown), null, String(unknown));
  }
  assert.equal(parsedField('event_type', 'Bar mitzvah'), undefined);
});

// ── 3. The notification gate: Formspree sender, plain-text body ──
function formspreeNotification(body, overrides = {}) {
  return {
    subscriptionId: 'outlook-poller',
    resourceData: {
      id: 'msg-form-1',
      subject: 'Hamptons Coconuts, new quote request',
      from: { emailAddress: { name: 'Formspree', address: 'noreply@formspree.io' } },
      body,
      bodyContentType: 'text',
      ...overrides,
    },
  };
}

await check('a Formspree notice with a plain-text body is read', () => {
  assert.deepEqual(websiteFormFromNotification(formspreeNotification(formNotice())), EXPECTED);
  assert.deepEqual(websiteFormFromNotification(formspreeNotification(formNotice(), {
    from: { emailAddress: { address: 'Submissions@Formspree.com' } },
  })), EXPECTED);
  assert.deepEqual(websiteFormFromNotification(formspreeNotification(formNotice(), {
    from: 'Formspree <noreply@formspree.io>',
  })), EXPECTED);
});

await check('a Graph-shaped {contentType, content} body is read; HTML is not', () => {
  assert.deepEqual(websiteFormFromNotification(formspreeNotification(
    { contentType: 'text', content: formNotice() }, { bodyContentType: undefined })), EXPECTED);
  assert.equal(websiteFormFromNotification(formspreeNotification(
    { contentType: 'html', content: formNotice() })), null);
  assert.equal(websiteFormFromNotification(formspreeNotification(formNotice(), { bodyContentType: 'html' })), null);
  assert.equal(websiteFormFromNotification(formspreeNotification(formNotice(), { bodyContentType: 'HTML' })), null);
});

await check('the same layout from any other sender is not a form', () => {
  for (const address of ['sidd@hamptonscoconuts.com', 'avery.testcase@example.com',
    'noreply@formspree.io.example.com', 'formspree.io@example.com', 'noreply@mail.formspree.io', '']) {
    assert.equal(websiteFormFromNotification(formspreeNotification(formNotice(), {
      from: { emailAddress: { address } },
    })), null, address);
  }
  assert.equal(websiteFormFromNotification(formspreeNotification(formNotice(), { from: undefined })), null);
});

await check('a notice with no field that passed, or no body, is null', () => {
  const junk = formNotice({ name: '123', email: 'x', phone: 'x', event_date: 'x', event_type: 'x',
    delivery_market: 'x', coconut_count: 'x', budget: 'x' });
  assert.equal(websiteFormFromNotification(formspreeNotification(junk)), null);
  assert.equal(websiteFormFromNotification(formspreeNotification(undefined)), null);
  assert.equal(websiteFormFromNotification(formspreeNotification({ content: 7 })), null);
  assert.equal(websiteFormFromNotification({}), null);
  assert.equal(websiteFormFromNotification(null), null);
});

// ── 4. Applying the form to the model's extracted_lead ──
const MODEL_LEAD = Object.freeze({
  client_name: 'Avery Testcase',
  client_email: 'avery.testcase@example.com',
  client_phone: null,
  event_type: 'other',
  event_date: '2027-07-17',
  headcount: 20,
  venue: null,
  market: 'other',
  notes: 'Wedding inquiry, 20 coconuts, budget $1,500 to $3,000.',
});

await check('the count the model filed as guests is cleared; type, market and phone come from the form', () => {
  const { lead, changed } = applyWebsiteFormToLead(MODEL_LEAD, EXPECTED);
  assert.equal(lead.headcount, null);
  assert.equal(lead.market, 'ny');
  assert.equal(lead.event_type, 'wedding');
  assert.equal(lead.client_phone, '(555) 010-0142');
  assert.equal(lead.event_date, '2027-07-17');
  assert.equal(lead.notes, MODEL_LEAD.notes);
  assert.equal(lead.venue, null);
  assert.deepEqual(changed.sort(), ['client_phone', 'event_type', 'headcount', 'market']);
  assert.equal('coconuts_qty' in lead, false);
  assert.equal(MODEL_LEAD.headcount, 20, 'the model object is never changed');
});

await check('a different guest number the model read from the message stays', () => {
  assert.equal(applyWebsiteFormToLead({ ...MODEL_LEAD, headcount: 150 }, EXPECTED).lead.headcount, 150);
  assert.equal(applyWebsiteFormToLead({ ...MODEL_LEAD, headcount: '20' }, EXPECTED).lead.headcount, null);
  assert.equal(applyWebsiteFormToLead({ ...MODEL_LEAD, headcount: 20 }, { ...EXPECTED, coconut_count: undefined }).lead.headcount, 20);
});

await check('name: empty, Unknown or a different name takes the form; the same name in other case stays', () => {
  for (const modelName of [null, '', 'Unknown', 'Formspree']) {
    assert.equal(applyWebsiteFormToLead({ ...MODEL_LEAD, client_name: modelName }, EXPECTED).lead.client_name, 'Avery Testcase', String(modelName));
  }
  const same = applyWebsiteFormToLead({ ...MODEL_LEAD, client_name: 'AVERY  testcase' }, EXPECTED);
  assert.equal(same.lead.client_name, 'AVERY  testcase');
  assert.equal(same.changed.includes('client_name'), false);
});

await check('email: the form address wins over a different model address; case alone is no change', () => {
  const other = applyWebsiteFormToLead({ ...MODEL_LEAD, client_email: 'planner@example.org' }, EXPECTED);
  assert.equal(other.lead.client_email, 'avery.testcase@example.com');
  assert.ok(other.changed.includes('client_email'));
  const cased = applyWebsiteFormToLead({ ...MODEL_LEAD, client_email: 'Avery.Testcase@Example.com' }, EXPECTED);
  assert.equal(cased.lead.client_email, 'Avery.Testcase@Example.com');
  assert.equal(cased.changed.includes('client_email'), false);
  const empty = applyWebsiteFormToLead({ ...MODEL_LEAD, client_email: null }, EXPECTED);
  assert.equal(empty.lead.client_email, 'avery.testcase@example.com');
});

await check('fields the form did not give keep the model value', () => {
  const partial = { coconut_count: 20 };
  const { lead, changed } = applyWebsiteFormToLead({ ...MODEL_LEAD, market: 'miami', event_type: 'corporate' }, partial);
  assert.equal(lead.market, 'miami');
  assert.equal(lead.event_type, 'corporate');
  assert.equal(lead.client_email, MODEL_LEAD.client_email);
  assert.deepEqual(changed, ['headcount']);
});

await check('no form (or a bad lead) changes nothing', () => {
  const { lead, changed } = applyWebsiteFormToLead(MODEL_LEAD, null);
  assert.deepEqual(lead, { ...MODEL_LEAD });
  assert.deepEqual(changed, []);
  assert.deepEqual(applyWebsiteFormToLead(['x'], null).lead, {});
});

await check('only the seven named fields can change; coconuts_qty is never set', () => {
  const { lead } = applyWebsiteFormToLead({ ...MODEL_LEAD, client_name: null, client_email: null, market: 'zzz' }, EXPECTED);
  const allowed = new Set([...Object.keys(MODEL_LEAD), 'client_name', 'client_email', 'client_phone',
    'event_date', 'event_type', 'market', 'headcount']);
  for (const key of Object.keys(lead)) assert.ok(allowed.has(key), key);
  assert.equal('coconuts_qty' in lead, false);
});

// ── 5. The fixed notes lines ──
await check('notes lines: count and budget, each only when it passed', () => {
  assert.equal(websiteFormNoteLines(EXPECTED), 'Coconuts requested (form): 20\nBudget (form): $1,500 to $3,000');
  assert.equal(websiteFormNoteLines({ coconut_count: 350 }), 'Coconuts requested (form): 350');
  assert.equal(websiteFormNoteLines({ budget: 'Not sure yet' }), 'Budget (form): Not sure yet');
  assert.equal(websiteFormNoteLines({ coconut_count: '20' }), '');
  assert.equal(websiteFormNoteLines({}), '');
  assert.equal(websiteFormNoteLines(null), '');
});

// ── 6. End to end: the real /webhooks/ms-graph route, the */5 intake drain
// (runWebhookIntakeScan) and a fake network. Nothing leaves this process. ──
const GRAPH_CLIENT_STATE = 'graph-test-client-state';
const ENV = {
  MS_GRAPH_CLIENT_STATE: GRAPH_CLIENT_STATE,
  SUPABASE_URL: 'https://sandbox.supabase.test',
  SUPABASE_SERVICE_KEY: 'sandbox-service-key',
  ANTHROPIC_API_KEY: 'sandbox-anthropic-key',
  TG_BOT_TOKEN: 'sandbox-telegram-token',
  ALLOWED_CHAT_IDS: '',
};
const SB = ENV.SUPABASE_URL + '/rest/v1/';
// The lead row's columns today (processMsGraphNotification's insert).
const ROW_KEYS = ['client_email', 'client_name', 'client_phone', 'coi_required', 'coi_submitted',
  'deposit_cents', 'event_start_at', 'event_type', 'event_tz', 'headcount', 'id', 'is_recurring',
  'logo_received', 'market', 'notes', 'source', 'stage', 'stamp_status', 'venue'];
const FORM_SUBJECT = 'Hamptons Coconuts, new quote request';

function installHarness({ classification, existingOrders = [], loseFirstInsertResponse = false }) {
  const original = globalThis.fetch;
  const st = { intake: [], receipts: new Map(), inserts: [], insertHeaders: [], stored: new Map(),
    lookups: [], patches: [], ai: [], nextId: 1, insertResponseLost: false };
  const uuid = () => '20000000-0000-4000-8000-' + String(st.nextId++).padStart(12, '0');
  const reply = (status, value) => new Response(JSON.stringify(value), {
    status, headers: { 'Content-Type': 'application/json' } });
  globalThis.fetch = async (input, options = {}) => {
    const url = String(input);
    const method = String(options.method || 'GET').toUpperCase();
    let body = null;
    try { body = options.body ? JSON.parse(options.body) : null; } catch {}
    const rpc = url.startsWith(SB + 'rpc/') ? url.slice((SB + 'rpc/').length) : null;
    if (rpc === 'hc_enqueue_webhook_intake') {
      for (const item of body.p_items) st.intake.push({ id: uuid(), item, state: 'pending', token: null, attempts: 0 });
      return reply(200, body.p_items.length);
    }
    if (rpc === 'hc_claim_webhook_intake') {
      const row = st.intake.find((r) => r.state === 'pending');
      if (!row) return reply(200, []);
      row.state = 'processing';
      row.token = uuid();
      row.attempts++;
      return reply(200, [{ intake_id: row.id, provider: row.item.provider, event_key: row.item.event_key,
        payload: row.item.payload, attempt_count: row.attempts, claim_token: row.token }]);
    }
    if (rpc === 'hc_finish_webhook_intake' || rpc === 'hc_release_webhook_intake') {
      const row = st.intake.find((r) => r.id === body.p_intake_id && r.token === body.p_claim_token);
      if (row) { row.state = rpc === 'hc_finish_webhook_intake' ? 'done' : 'released'; row.token = null; }
      return reply(200, !!row);
    }
    if (rpc === 'hc_claim_webhook_delivery') {
      const key = body.p_provider + '|' + body.p_event_key;
      let receipt = st.receipts.get(key);
      if (receipt && receipt.state === 'completed') {
        return reply(200, [{ claim_state: 'completed', receipt_id: receipt.id, claim_token: null, claim_expires_at: null }]);
      }
      if (!receipt) { receipt = { id: uuid(), state: 'processing' }; st.receipts.set(key, receipt); }
      receipt.token = uuid();
      return reply(200, [{ claim_state: 'claimed', receipt_id: receipt.id, claim_token: receipt.token,
        claim_expires_at: new Date(Date.now() + 300000).toISOString() }]);
    }
    if (rpc === 'hc_renew_webhook_delivery' || rpc === 'hc_release_webhook_delivery') return reply(200, true);
    if (rpc === 'hc_finish_webhook_delivery') {
      const receipt = st.receipts.get(body.p_provider + '|' + body.p_event_key);
      if (receipt) receipt.state = 'completed';
      return reply(200, true);
    }
    if (url === 'https://api.anthropic.com/v1/messages') {
      st.ai.push(body);
      return reply(200, { content: [{ type: 'text', text: JSON.stringify(classification) }] });
    }
    if (url.startsWith(SB + 'orders?on_conflict=id') && method === 'POST') {
      st.inserts.push(body);
      st.insertHeaders.push(options.headers || {});
      // resolution=ignore-duplicates: a row already stored is never replaced.
      if (!st.stored.has(body.id)) st.stored.set(body.id, body);
      if (loseFirstInsertResponse && !st.insertResponseLost) {
        st.insertResponseLost = true;
        throw new Error('simulated lost insert response after commit');
      }
      return new Response(null, { status: 201 });
    }
    if (url.startsWith(SB + 'orders?select=') && method === 'GET') {
      st.lookups.push(url);
      const needle = String(new URL(url).searchParams.get('client_email') || '')
        .replace(/^ilike\./, '').replace(/\*/g, '').replace(/\\(.)/g, '$1').toLowerCase();
      return reply(200, existingOrders.filter((row) => String(row.client_email || '').toLowerCase().includes(needle)));
    }
    if (url.startsWith(SB + 'orders?id=eq.') && method === 'PATCH') {
      st.patches.push({ url, body });
      return new Response(null, { status: 204 });
    }
    throw new Error('unexpected offline fetch: ' + method + ' ' + url);
  };
  return { st, restore() { globalThis.fetch = original; } };
}

// One notification through the real webhook, then one drain, exactly as
// production runs it. Logs are captured (and checked for leaks), not printed.
async function runCase({ classification, resourceData, existingOrders, loseFirstInsertResponse, drains = 1 }) {
  const h = installHarness({ classification, existingOrders, loseFirstInsertResponse });
  const logs = [];
  const keepLog = console.log;
  const keepError = console.error;
  console.log = (...args) => logs.push(args.map(String).join(' '));
  console.error = (...args) => logs.push(args.map(String).join(' '));
  try {
    const response = await worker.fetch(new Request('https://worker.example.test/webhooks/ms-graph', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: [{
        clientState: GRAPH_CLIENT_STATE,
        subscriptionId: 'outlook-poller',
        changeType: 'created',
        resource: '/me/messages/' + resourceData.id,
        resourceData,
      }] }),
    }), ENV);
    const drained = [];
    for (let i = 0; i < drains; i++) {
      // A released item is retried on the next drain.
      for (const row of h.st.intake) if (row.state === 'released') row.state = 'pending';
      drained.push(await runWebhookIntakeScan(ENV));
    }
    return { ...h.st, status: response.status, drained, logs };
  } finally {
    console.log = keepLog;
    console.error = keepError;
    h.restore();
  }
}

// What the poller forwards for a Formspree notice (forward_to_claudia).
function formResource(id, body, overrides = {}) {
  return {
    id,
    subject: FORM_SUBJECT,
    from: { emailAddress: { name: 'Formspree', address: 'noreply@formspree.io' } },
    toRecipients: [],
    bodyPreview: '',
    body,
    bodyContentType: 'text',
    attachmentNames: [],
    receivedDateTime: '2026-09-15T14:00:00Z',
    conversationId: 'conv-' + id,
    ...overrides,
  };
}

// What the model did with such a notice: the count as guests, market and
// type guessed as other, no phone.
function formClassification(leadFields = {}, fields = {}) {
  return {
    category: 'lead_inquiry',
    from_email: 'noreply@formspree.io',
    from_name: 'Formspree',
    subject: FORM_SUBJECT,
    summary: 'Website quote request',
    should_alert: true,
    extracted_lead: {
      client_name: 'Avery Testcase',
      client_email: 'avery.testcase@example.com',
      client_phone: null,
      event_type: 'other',
      event_date: '2027-07-17',
      headcount: 20,
      venue: null,
      market: 'other',
      notes: 'Wedding, 20 coconuts, budget $1,500 to $3,000.',
      ...leadFields,
    },
    ...fields,
  };
}

// Today's row for a classification, built with the insert's own rules, so
// "untouched" means byte for byte what the worker wrote before this change.
function todaysRow(row, cls, email) {
  const lead = cls.extracted_lead;
  return {
    id: row.id,
    client_name: lead.client_name || 'Unknown',
    client_email: email,
    client_phone: lead.client_phone || null,
    event_type: ['wedding', 'corporate', 'trade_show', 'hospitality', 'cruise', 'wellness', 'other']
      .includes(lead.event_type) ? lead.event_type : 'other',
    event_start_at: lead.event_date ? lead.event_date + 'T12:00:00Z' : null,
    event_tz: 'America/New_York',
    headcount: parseInt(lead.headcount) || null,
    venue: lead.venue || null,
    market: ['ny', 'miami', 'vegas', 'other'].includes(lead.market) ? lead.market : 'ny',
    stage: 'inquiry',
    source: 'website',
    notes: 'Email lead via MS Graph: ' + (cls.subject || '') + '\n\n' + (lead.notes || ''),
    stamp_status: 'not_ordered',
    logo_received: false,
    deposit_cents: 0,
    coi_required: false,
    coi_submitted: false,
    is_recurring: false,
  };
}

const formLogLines = (logs) => logs.filter((line) => line.startsWith('ms_graph website form'));

function assertCompleted(r) {
  assert.equal(r.status, 202);
  assert.deepEqual(r.drained.at(-1), { claimed: 1, completed: 1, released: 0 });
  assert.equal(r.ai.length, r.drained.length);
}

await check('end to end: the form lead row gets the form fields and the count never becomes guests', async () => {
  const cls = formClassification();
  const r = await runCase({ classification: cls, resourceData: formResource('form-e2e-1', formNotice()) });
  assertCompleted(r);
  assert.equal(r.inserts.length, 1);
  const row = r.inserts[0];
  assert.deepEqual(Object.keys(row).sort(), ROW_KEYS);
  assert.equal('coconuts_qty' in row, false);
  assert.equal(row.headcount, null);
  assert.equal(row.market, 'ny');
  assert.equal(row.event_type, 'wedding');
  assert.equal(row.client_phone, '(555) 010-0142');
  assert.equal(row.client_email, 'avery.testcase@example.com');
  assert.equal(row.client_name, 'Avery Testcase');
  assert.equal(row.event_start_at, '2027-07-17T12:00:00Z');
  assert.equal(row.notes, 'Email lead via MS Graph: ' + FORM_SUBJECT + '\n\n' +
    'Coconuts requested (form): 20\nBudget (form): $1,500 to $3,000\n\n' + cls.extracted_lead.notes);
  assert.equal(row.notes.split('\n')[0], 'Email lead via MS Graph: ' + FORM_SUBJECT);
  // Everything else is today's row.
  const today = todaysRow(row, cls, 'avery.testcase@example.com');
  for (const key of ['id', 'event_tz', 'venue', 'stage', 'source', 'stamp_status', 'logo_received',
    'deposit_cents', 'coi_required', 'coi_submitted', 'is_recurring']) {
    assert.deepEqual(row[key], today[key], key);
  }
  assert.match(String(r.insertHeaders[0].Prefer || r.insertHeaders[0].prefer), /resolution=ignore-duplicates/);
});

await check('end to end: the log names fields only, never a value', async () => {
  const r = await runCase({ classification: formClassification(),
    resourceData: formResource('form-e2e-log', formNotice()) });
  const lines = formLogLines(r.logs);
  assert.equal(lines.length, 1);
  assert.equal(lines[0], 'ms_graph website form: read budget,coconut_count,delivery_market,email,event_date,' +
    'event_type,name,phone; changed client_phone,event_type,market,headcount');
  for (const line of r.logs) {
    assert.doesNotMatch(line, /avery|testcase|555|1,500|wedding|greater ny|2027-07-17/i, line);
  }
});

await check('end to end: every live market option sets the row market', async () => {
  for (const [option, market] of MARKET_OPTIONS) {
    const modelMarket = market === 'ny' ? 'vegas' : 'ny';
    const r = await runCase({
      classification: formClassification({ market: modelMarket }),
      resourceData: formResource('form-market-' + market + '-' + option.length, formNotice({ delivery_market: option })),
    });
    assertCompleted(r);
    assert.equal(r.inserts[0].market, market, option);
  }
});

await check('end to end: every live event type sets the row event_type', async () => {
  for (const [option, type] of EVENT_OPTIONS) {
    const modelType = type === 'wedding' ? 'corporate' : 'wedding';
    const r = await runCase({
      classification: formClassification({ event_type: modelType }),
      resourceData: formResource('form-type-' + option.length, formNotice({ event_type: option })),
    });
    assertCompleted(r);
    assert.equal(r.inserts[0].event_type, type, option);
  }
});

await check('end to end: a guest number different from the count stays as guests', async () => {
  const r = await runCase({ classification: formClassification({ headcount: 150 }),
    resourceData: formResource('form-guests-150', formNotice()) });
  assertCompleted(r);
  assert.equal(r.inserts[0].headcount, 150);
  assert.match(r.inserts[0].notes, /Coconuts requested \(form\): 20/);
});

await check('end to end: empty model name and email are filled from the form, and the lookup uses that email', async () => {
  const r = await runCase({ classification: formClassification({ client_name: null, client_email: null }),
    resourceData: formResource('form-fill-name', formNotice()) });
  assertCompleted(r);
  assert.equal(r.inserts[0].client_name, 'Avery Testcase');
  assert.equal(r.inserts[0].client_email, 'avery.testcase@example.com');
  assert.equal(r.lookups.length, 1);
  assert.ok(decodeURIComponent(r.lookups[0]).includes('avery.testcase@example.com'));
});

await check('end to end: a form with missing fields keeps the model value for each missing one', async () => {
  const cls = formClassification({ client_phone: '555-0199', market: 'miami' });
  const r = await runCase({ classification: cls,
    resourceData: formResource('form-missing', formNotice({ phone: '', coconut_count: '' }, { omit: ['budget', 'delivery_market'] })) });
  assertCompleted(r);
  const row = r.inserts[0];
  assert.equal(row.client_phone, '555-0199');
  assert.equal(row.market, 'miami');
  assert.equal(row.headcount, 20, 'no count on the form, nothing to compare');
  assert.equal(row.event_type, 'wedding');
  assert.equal(row.notes, 'Email lead via MS Graph: ' + FORM_SUBJECT + '\n\n' + cls.extracted_lead.notes);
});

await check('end to end: a form of junk values leaves today\'s row exactly', async () => {
  const cls = formClassification();
  const junk = formNotice({ name: '123', email: 'x', phone: 'call me', event_date: '07/17/2027',
    event_type: 'Bar mitzvah', delivery_market: 'Mars', coconut_count: 'lots', budget: 'cheap' });
  const r = await runCase({ classification: cls, resourceData: formResource('form-junk', junk) });
  assertCompleted(r);
  assert.deepEqual(r.inserts[0], todaysRow(r.inserts[0], cls, 'avery.testcase@example.com'));
  assert.deepEqual(formLogLines(r.logs), []);
});

await check('end to end: a non-form email is untouched (same row as today)', async () => {
  const cls = formClassification({
    client_name: 'Robin Sample', client_email: 'robin.sample@example.net', headcount: 120,
    market: 'other', event_type: 'other', notes: 'Asked about 120 coconuts.',
  }, { from_email: 'robin.sample@example.net', from_name: 'Robin Sample', subject: 'Coconuts for our party' });
  const body = 'Hi there,\n\nCould you do coconuts for our party?\n\ncoconut_count\n\n120\n\nThanks, Robin';
  const r = await runCase({ classification: cls, resourceData: formResource('plain-email', body, {
    subject: 'Coconuts for our party',
    from: { emailAddress: { name: 'Robin Sample', address: 'robin.sample@example.net' } },
  }) });
  assertCompleted(r);
  assert.deepEqual(r.inserts[0], todaysRow(r.inserts[0], cls, 'robin.sample@example.net'));
  assert.deepEqual(formLogLines(r.logs), []);
});

await check('end to end: the same form layout from a non-Formspree sender is untouched', async () => {
  const cls = formClassification({}, { subject: 'Fwd: ' + FORM_SUBJECT, from_email: null });
  const r = await runCase({ classification: cls, resourceData: formResource('self-forward', formNotice(), {
    subject: 'Fwd: ' + FORM_SUBJECT,
    from: { emailAddress: { name: 'Owner', address: 'sidd@hamptonscoconuts.com' } },
  }) });
  assertCompleted(r);
  assert.deepEqual(r.inserts[0], todaysRow(r.inserts[0], cls, 'avery.testcase@example.com'));
  assert.equal(r.inserts[0].headcount, 20);
  assert.deepEqual(formLogLines(r.logs), []);
});

await check('end to end: an HTML form body is untouched (no guessed parser)', async () => {
  const cls = formClassification();
  const r = await runCase({ classification: cls, resourceData: formResource('form-html', formNotice(), { bodyContentType: 'html' }) });
  assertCompleted(r);
  assert.deepEqual(r.inserts[0], todaysRow(r.inserts[0], cls, 'avery.testcase@example.com'));
});

const OPEN_LEAD = {
  id: '30000000-0000-4000-8000-000000000001',
  stage: 'inquiry',
  external_invoice_id: null,
  total_cents: null,
  deposit_cents: 0,
  client_email: 'avery.testcase@example.com',
  client_phone: '555-0100',
  headcount: 75,
  market: 'ny',
  notes: 'Email lead via MS Graph: earlier request',
  event_start_at: '2027-07-17T12:00:00+00:00',
  created_at: '2026-09-10T00:00:00Z',
};

await check('end to end: the suppressed path writes today\'s note only, never a column', async () => {
  const cls = formClassification();
  const r = await runCase({ classification: cls, resourceData: formResource('form-suppressed', formNotice()),
    existingOrders: [OPEN_LEAD] });
  assertCompleted(r);
  assert.equal(r.inserts.length, 0);
  assert.equal(r.patches.length, 1);
  assert.ok(r.patches[0].url.endsWith('orders?id=eq.' + OPEN_LEAD.id));
  assert.deepEqual(Object.keys(r.patches[0].body), ['notes']);
  const receiptId = [...r.receipts.values()][0].id;
  assert.equal(r.patches[0].body.notes, OPEN_LEAD.notes + '\n\nFollow-up email via MS Graph: ' + FORM_SUBJECT +
    '\n' + cls.extracted_lead.notes + ' [rcpt ' + receiptId.slice(0, 8) + ']');
  assert.doesNotMatch(r.patches[0].body.notes, /\(form\)/);
});

await check('end to end: the duplicate check finds the open lead by the form email when the model got it wrong', async () => {
  const cls = formClassification({ client_email: 'someone.else@example.org' });
  const r = await runCase({ classification: cls, resourceData: formResource('form-dedupe-email', formNotice()),
    existingOrders: [OPEN_LEAD] });
  assertCompleted(r);
  assert.equal(r.inserts.length, 0);
  assert.equal(r.patches.length, 1);
  assert.deepEqual(Object.keys(r.patches[0].body), ['notes']);
  assert.ok(decodeURIComponent(r.lookups[0]).includes('avery.testcase@example.com'));
  assert.ok(r.lookups.every((url) => !decodeURIComponent(url).includes('someone.else@example.org')));
});

await check('end to end: customer_reply, vendor and noise on a form notice write nothing', async () => {
  for (const category of ['customer_reply', 'vendor', 'noise']) {
    for (const extracted of [null, formClassification().extracted_lead]) {
      const r = await runCase({
        classification: formClassification({}, { category, extracted_lead: extracted }),
        resourceData: formResource('form-' + category + '-' + (extracted ? 'x' : 'n'), formNotice()),
      });
      assertCompleted(r);
      assert.equal(r.inserts.length, 0, category);
      assert.equal(r.patches.length, 0, category);
      assert.equal(r.lookups.length, 0, category);
      assert.deepEqual(formLogLines(r.logs), [], category);
    }
  }
});

await check('end to end: lead_inquiry without extracted_lead on a form notice writes nothing', async () => {
  const r = await runCase({ classification: formClassification({}, { extracted_lead: null }),
    resourceData: formResource('form-no-lead', formNotice()) });
  assertCompleted(r);
  assert.equal(r.inserts.length, 0);
  assert.equal(r.patches.length, 0);
});

await check('end to end: a retried delivery never replaces the stored row', async () => {
  const r = await runCase({ classification: formClassification(),
    resourceData: formResource('form-retry', formNotice()), loseFirstInsertResponse: true, drains: 2 });
  assert.deepEqual(r.drained[0], { claimed: 1, completed: 0, released: 1 });
  assert.deepEqual(r.drained[1], { claimed: 1, completed: 1, released: 0 });
  assert.equal(r.inserts.length, 2);
  assert.deepEqual(r.inserts[1], r.inserts[0]);
  assert.equal(r.stored.size, 1);
  assert.deepEqual([...r.stored.values()][0], r.inserts[0]);
  for (const headers of r.insertHeaders) {
    assert.match(String(headers.Prefer || headers.prefer), /resolution=ignore-duplicates/);
  }
});

console.log('');
console.log(`${total - failed} passed, ${failed} failed, ${total} total`);
process.exit(failed ? 1 : 0);

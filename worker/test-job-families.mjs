// Tests for the calendar job families in worker.js (calendar accuracy,
// built 2026-11-24): the shared vectors (family-rules-cases.json, pinned by
// sha256), the reconfirmation scan (one email per job, from day 1, listing
// every day; an extra day never drafts; the multi_day hold), the clock-out
// Day P&L and the 8am buy lines. Everything runs against a fake network:
// nothing here can reach Supabase, QuickBooks, Telegram or a phone. Every
// name, email, id and amount is made up.
//
// Run it with:  node worker/test-job-families.mjs

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import worker, {
  familyFacts, familyMoney, familyDayOf, loadJobFamilies, familyLeavesPrep, familyDayTag, familyRevenueOf,
  reconfirmEligibility, reconfirmFacts, reconfirmHolds, reconfirmTemplate, reconfirmSourceDiff, reconfirmChangeNote,
  reconfirmReasonWords, runReconfirmationScan, buildShiftSummaryText,
} from './worker.js';

const here = dirname(fileURLToPath(import.meta.url));
let passed = 0;
const pass = (m) => { passed++; console.log('PASS: ' + m); };

// -- 1. The shared vectors file is the byte-for-byte copy --
const VECTORS_SHA256 = '7d931307f21ea3f8ee62eb89b16b688e0b61ae15556f9d09a847ac2f285337ec';
const vectorBytes = readFileSync(join(here, 'test-vectors', 'family-rules-cases.json'));
{
  const sha = createHash('sha256').update(vectorBytes).digest('hex');
  assert.equal(sha, VECTORS_SHA256, 'worker/test-vectors/family-rules-cases.json differs from the master copy (re-copy it byte for byte and re-pin)');
  assert.ok(![...vectorBytes].some((b) => b > 127), 'ASCII only');
  assert.ok(!vectorBytes.includes(13), 'LF line endings (.gitattributes marks it -text)');
  pass('vectors: the pinned sha256 matches, ASCII, LF');
}
const V = JSON.parse(vectorBytes.toString('utf8'));

// -- 2. family_cases F01 to F14, every expected key --
{
  assert.equal(V.family_cases.length, 14);
  let checks = 0;
  for (const c of V.family_cases) {
    const r = familyFacts(c.orders, c.attachments);
    for (const [id, exp] of Object.entries(c.expect)) {
      const got = r.rows.get(id);
      assert.ok(got, c.id + ' has facts for ' + id);
      for (const [k, want] of Object.entries(exp)) {
        assert.deepEqual(got[k], want, c.id + ' ' + id.slice(-4) + ' ' + k);
        checks++;
      }
    }
    if (c.family) {
      assert.deepEqual(r.families.get(c.family.head), c.family, c.id + ' family sums');
      assert.equal(r.families.size, 1, c.id + ' one family');
    } else {
      assert.equal(r.families.size, 0, c.id + ' no family');
    }
  }
  assert.ok(checks > 300, 'every key checked (' + checks + ')');
  // The vectors' own money and day formats.
  assert.equal(familyMoney(113794), '$1,137.94');
  assert.equal(familyMoney(40000), '$400.00');
  assert.equal(familyMoney(100000000), '$1,000,000.00');
  assert.equal(familyDayOf({ delivery_at_utc: '2026-12-01T00:00:00+00:00' }), '2026-12-01', 'a 00:00 UTC marker is that date');
  assert.equal(familyDayOf({ event_start_at: '2026-12-02T12:00:00Z' }), '2026-12-02');
  pass('family_cases: all 14 cases and their family sums match (' + checks + ' values)');
}

// -- 3. finding_words lint, and the worker's own new words --
const LINT = (text) => !/@/.test(text) && !/\$/.test(text) && !/\d{3}[\s.)-]*\d{3}[\s.-]\d{4}/.test(text);
const DASHES = new RegExp('[' + String.fromCharCode(0x2013, 0x2014) + ']');
const src = readFileSync(join(here, 'worker.js'), 'utf8');
{
  const codes = V.finding_words.codes;
  assert.equal(Object.keys(codes).length, 23, 'the 23 codes of section 13e');
  for (const [code, w] of Object.entries(codes)) {
    for (const k of ['words', 'button', 'fine']) {
      assert.ok(typeof w[k] === 'string' && w[k].length > 0, code + ' has ' + k);
      assert.ok(LINT(w[k]) && !DASHES.test(w[k]), code + ' ' + k + ' passes the lint');
    }
  }
  // The codes that hold day 1's email as multi_day are real codes.
  const list = /const RECONFIRM_MULTI_DAY_CODES = \[([^\]]*)\]/.exec(src);
  assert.ok(list, 'RECONFIRM_MULTI_DAY_CODES is in the source');
  const multi = list[1].split(',').map((s) => s.trim().replace(/'/g, '')).filter(Boolean);
  assert.deepEqual(multi, ['count_differs', 'days_differ', 'days_undated', 'day_not_on_invoice', 'day_link']);
  for (const c of multi) assert.ok(codes[c], c + ' is a finding code');
  // The worker's new owner words pass the same lint.
  const mine = [reconfirmReasonWords(['multi_day']), reconfirmChangeNote([{ key: 'family_days', from: 'a', to: 'b' }]),
    'extra day of a job: day 1 sends one email for every day', 'day of a removed job',
    'Left out of the buy lines: 2 days of a cancelled or removed job (see HC Field).', ' (job links not read)'];
  for (const m of mine) assert.ok(LINT(m) && !DASHES.test(m), 'lint: ' + m);
  assert.equal(reconfirmReasonWords(['multi_day']), 'the coconuts by day disagree with the invoice');
  pass('finding_words: 23 codes lint clean; the multi_day codes exist; the worker\'s new words lint clean');
}

// -- shared fixtures (made up) --
const SB = 'https://example.invalid';
const T = (iso) => Date.parse(iso);
const CELL = '732-555-0199';
const ENV = { SUPABASE_URL: SB, SUPABASE_SERVICE_KEY: 'not-a-real-key', TG_BOT_TOKEN: 'x', ALLOWED_CHAT_IDS: '', RECONFIRM_MODE: 'preview', OWNER_CELL: CELL };
const HEAD = 'aaaaaaaa-0000-4000-8000-000000000001';
const DAY2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const DAY3 = 'aaaaaaaa-0000-4000-8000-000000000003';
const LONE = 'bbbbbbbb-0000-4000-8000-000000000001';
const GONE_HEAD = 'cccccccc-0000-4000-8000-000000000001';
const GONE_DAY = 'cccccccc-0000-4000-8000-000000000002';
const ROSTER = [
  { email: 'owner@example.invalid', name: 'Sidd', role: 'owner', market: 'ny', active: true },
  { email: 'vegas@example.invalid', name: 'Crew Vegas', role: 'team', market: 'vegas', active: true },
];
const TOKENS = { 'owner@example.invalid': 'owner-token', 'vegas@example.invalid': 'vegas-token' };
// Day 1 of a three-day expo job: paid in full, everything on file.
function head(extra = {}) {
  return {
    id: HEAD, client_name: 'Jamie Rivera', client_email: 'jamie@example.invalid', client_phone: '(702) 555-0177',
    venue: 'Expo Hall', delivery_notes: 'Expo Hall, Las Vegas, NV', delivery_at_utc: '2026-12-01T00:00:00Z', event_start_at: '2026-12-01T00:00:00Z',
    stage: 'paid_full', market: 'vegas', coconuts_qty: 300, crack_type: null,
    invoice_fulfillment: { source: 'quickbooks', read_status: 'complete', invoice_id: '9701', address: 'Expo Hall, 201 Sands Ave, Las Vegas, NV 89169', cracking: 'straw_hole', cracking_note: null, delivery_window: null },
    delivery_request: { window: '10:00 AM', status: 'confirmed', contact_name: 'Ana', contact_phone: '(702) 555-0100' },
    logo_url: 'https://files.example.invalid/logos/rivera.png', logo_asset: null, logo_received: true,
    total_cents: 500000, balance_cents: 500000, deposit_cents: 0, external_invoice_id: '9701', external_invoice_url: 'https://pay.example.invalid/9701',
    is_recurring: false, parent_order_id: null, job_day_origin: null, cancelled_at: null,
    ...extra,
  };
}
// An extra day: no invoice, no money, stage invoiced, its own count.
function extraDay(id, day, qty, extra = {}) {
  return {
    id, client_name: 'Jamie Rivera', client_email: 'jamie@example.invalid', client_phone: '(702) 555-0177',
    venue: 'Expo Hall', delivery_notes: 'Expo Hall, Las Vegas, NV', delivery_at_utc: day + 'T00:00:00Z', event_start_at: day + 'T00:00:00Z',
    stage: 'invoiced', market: 'vegas', coconuts_qty: qty, crack_type: null, invoice_fulfillment: null, delivery_request: null,
    logo_url: null, logo_asset: null, logo_received: false,
    total_cents: null, balance_cents: null, deposit_cents: 0, external_invoice_id: null, external_invoice_url: null,
    is_recurring: false, parent_order_id: HEAD, job_day_origin: 'owner', cancelled_at: null,
    ...extra,
  };
}
// A one-day job on the same days, to prove one-day jobs are untouched.
function lone(extra = {}) {
  return {
    ...head(), id: LONE, client_name: 'Robin Lake', client_email: 'robin@example.invalid', venue: 'Lake House', market: 'ny',
    delivery_notes: 'Lake House, Southampton, NY', delivery_at_utc: '2026-12-01T00:00:00Z', coconuts_qty: 80,
    invoice_fulfillment: { source: 'quickbooks', read_status: 'complete', invoice_id: '9801', address: 'Lake House, 1 Pond Ln, Southampton, NY 11968', cracking: 'straw_hole', cracking_note: null, delivery_window: null },
    total_cents: 90000, balance_cents: 90000, external_invoice_id: '9801', external_invoice_url: 'https://pay.example.invalid/9801',
    ...extra,
  };
}

// -- a tiny PostgREST (eq, neq, in, gte, lte, gt, lt, is.null, not.is.null,
// not.is.true, or=(...) and and=(...) trees, order, offset, limit) --
function matches(row, key, value) {
  const v = row[key];
  if (value === 'not.is.null') return v != null;
  if (value === 'is.null') return v == null;
  if (value === 'not.is.true') return v !== true;
  const m = /^(eq|neq|gte|lte|gt|lt|in)\.(.*)$/s.exec(value);
  if (!m) return true;
  const [, op, raw] = m;
  if (op === 'in') return raw.slice(1, -1).split(',').map((s) => s.replace(/"/g, '').trim()).includes(String(v));
  const s = v == null ? '' : String(v);
  if (op === 'eq') return s === raw;
  if (op === 'neq') return s !== raw;
  if (op === 'gte') return s >= raw;
  if (op === 'lte') return s <= raw;
  if (op === 'gt') return s > raw;
  if (op === 'lt') return s < raw;
  return true;
}
function splitTop(text) {
  const parts = [];
  let depth = 0, cur = '';
  for (const ch of text) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur) parts.push(cur);
  return parts;
}
function logic(row, kind, inner) {
  const test = (part) => {
    const p = part.trim();
    const nested = /^(and|or)\((.*)\)$/s.exec(p);
    if (nested) return logic(row, nested[1], nested[2]);
    const i = p.indexOf('.');
    return matches(row, p.slice(0, i), p.slice(i + 1));
  };
  const parts = splitTop(inner);
  return kind === 'and' ? parts.every(test) : parts.some(test);
}
function query(rows, path) {
  const qs = new URLSearchParams(path.split('?')[1] || '');
  let out = rows.filter((r) => {
    for (const [k, v] of qs.entries()) {
      if (['select', 'order', 'limit', 'offset', 'on_conflict'].includes(k)) continue;
      if (k === 'or' || k === 'and') { if (!logic(r, k, v.slice(1, -1))) return false; continue; }
      if (!matches(r, k, v)) return false;
    }
    return true;
  });
  const orderSpec = qs.get('order');
  if (orderSpec) {
    const keys = orderSpec.split(',').map((k) => { const [f, dir] = k.split('.'); return { f, desc: dir === 'desc' }; });
    out = [...out].sort((a, b) => {
      for (const { f, desc } of keys) {
        const x = a[f] == null ? '' : a[f], y = b[f] == null ? '' : b[f];
        if (x === y) continue;
        const c = x < y ? -1 : 1;
        return desc ? -c : c;
      }
      return 0;
    });
  }
  const offset = Number(qs.get('offset') || 0), limit = Number(qs.get('limit') || out.length);
  return out.slice(offset, offset + limit);
}
function reply(status, data = null) {
  const text = data == null ? '' : (typeof data === 'string' ? data : JSON.stringify(data));
  return { ok: status >= 200 && status < 300, status, async json() { return typeof data === 'string' ? JSON.parse(data) : data; }, async text() { return text; } };
}
// The fake world. opts: orders, rows, findings (array, 'missing' or
// 'fail'), attachments (array or 'missing'), familyReadFails, originMissing
// (072 not applied: orders.job_day_origin does not exist), checkRefuses
// (the hold_reasons check does not admit multi_day yet), config (the
// coconut cost row), shifts.
function harness(opts = {}) {
  const calls = [];
  const orders = (opts.orders || []).map((o) => ({ ...o }));
  let nextId = (opts.rows || []).reduce((m, r) => Math.max(m, Number(r.id) || 0), 0) + 1;
  const rows = new Map((opts.rows || []).map((r) => [Number(r.id), { hold_reasons: [], recipients: [], facts: {}, picture: null, mode: 'preview', decision: null, send_after: null, reminded_at: null, previewed_at: null, reply_kind: null, error_detail: null, ...r }]));
  const originalFetch = globalThis.fetch;
  const refused = (b) => opts.checkRefuses && Array.isArray(b && b.hold_reasons) && b.hold_reasons.includes('multi_day');
  const REFUSAL = { code: '23514', message: 'new row for relation "order_reconfirmations" violates check constraint "order_reconfirmations_hold_reasons_check"' };
  globalThis.fetch = async (urlValue, options = {}) => {
    const url = String(urlValue);
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, method, body });
    if (url.includes('api.telegram.org')) return reply(200, { ok: true });
    if (!url.startsWith(SB + '/rest/v1/')) throw new Error('unexpected offline fetch: ' + method + ' ' + url);
    const path = url.slice((SB + '/rest/v1/').length);
    const table = path.split('?')[0];
    if (table === 'orders' && method === 'GET') {
      const family = path.includes('or=(id.in.(');
      if (family && opts.familyReadFails) return reply(500, { code: 'XX000', message: 'boom' });
      if (opts.originMissing && decodeURIComponent(path).includes('job_day_origin')) return reply(400, { code: '42703', message: 'column orders.job_day_origin does not exist' });
      const out = structuredClone(query(orders, path));
      if (opts.originMissing) for (const o of out) delete o.job_day_origin;
      return reply(200, out);
    }
    if (table === 'order_reconfirmations') {
      if (method === 'GET') return reply(200, structuredClone(query([...rows.values()], path)));
      if (method === 'POST') {
        if (refused(body)) return reply(400, REFUSAL);
        const row = { id: nextId++, status: 'ready', hold_reasons: [], facts: {}, recipients: [], picture: null, mode: 'preview', test_to: null, send_after: null, previewed_at: null, reminded_at: null, decision: null, reply_kind: null, change_note: null, error_detail: null, created_at: new Date(Date.now()).toISOString(), updated_at: new Date(Date.now()).toISOString(), ...body };
        rows.set(row.id, row);
        return reply(201, structuredClone([row]));
      }
      if (method === 'PATCH') {
        if (refused(body)) return reply(400, REFUSAL);
        const hit = query([...rows.values()], path);
        for (const r of hit) Object.assign(r, body);
        return reply(200, structuredClone(hit));
      }
    }
    if (table === 'hc_calendar_findings' && method === 'GET') {
      if (opts.findings === 'missing' || opts.findings === undefined) return reply(404, { code: 'PGRST205' });
      if (opts.findings === 'fail') return reply(500, { code: 'XX000' });
      return reply(200, query(opts.findings, path));
    }
    if (table === 'order_invoices' && method === 'GET') {
      if (opts.attachments === 'missing' || opts.attachments === undefined) return reply(404, { code: 'PGRST205' });
      return reply(200, query(opts.attachments, path));
    }
    if (table === 'order_time_proposals' && method === 'GET') return reply(200, []);
    if (table === 'order_address_proposals' && method === 'GET') return reply(200, []);
    if (table === 'intake_messages' && method === 'GET') return reply(200, []);
    if (table === 'field_workers' && method === 'GET') return reply(200, ROSTER);
    if (table === 'push_tokens' && method === 'GET') {
      const list = decodeURIComponent(path.split('email=in.(')[1].split(')')[0]);
      const wanted = list.split(',').map((s) => s.replace(/"/g, '').trim().toLowerCase());
      return reply(200, wanted.filter((e) => TOKENS[e]).map((e) => ({ email: e, apns_token: TOKENS[e] })));
    }
    if (table === 'push_queue') return reply(method === 'POST' ? 201 : 200, method === 'POST' ? null : []);
    if (table === 'shifts' && method === 'GET') return reply(200, opts.shifts || []);
    if (table === 'shift_locations' && method === 'GET') return reply(200, []);
    if (table === 'shift_orders' && method === 'GET') return reply(200, []);
    if (table === 'app_config' && method === 'GET') return reply(200, opts.config || [{ value: '139' }]);
    if (method === 'GET') return reply(200, []);
    throw new Error('unexpected offline fetch: ' + method + ' ' + url);
  };
  return {
    calls, rows, orders,
    all: () => [...rows.values()],
    pushes: () => calls.filter((c) => c.method === 'POST' && c.url === SB + '/rest/v1/push_queue').map((c) => c.body),
    reads: (prefix) => calls.filter((c) => c.method === 'GET' && c.url.startsWith(SB + '/rest/v1/' + prefix)),
    telegrams: () => calls.filter((c) => c.url.includes('api.telegram.org')).map((c) => c.body),
    restore: () => { globalThis.fetch = originalFetch; },
  };
}
const realNow = Date.now;
async function at(iso, fn) {
  Date.now = () => T(iso);
  try { return await fn(); } finally { Date.now = realNow; }
}
async function scanAt(iso, opts) {
  const h = harness(opts);
  try { return { h, counts: await at(iso, () => runReconfirmationScan(opts.env || ENV)) }; } finally { h.restore(); }
}
// Thu Nov 26, 08:05 in Las Vegas: day 1 (Tue Dec 1) is 5 days out.
const THU_0805_PT = '2026-11-26T16:05:00Z';
const B = String.fromCharCode(0x2022) + ' ';
// The existing digest and shift summary print an em dash, a middle dot and
// a bullet; this file builds them from code points so it stays ASCII.
const EM = String.fromCharCode(0x2014), DOT = String.fromCharCode(0xb7), BUL = String.fromCharCode(0x2022);

// -- 4. One email per job: day 1 lists every day, extra days never draft --
const THREE_DAY_SUBJECT = 'Your coconuts for Tuesday, December 1 to Thursday, December 3: quick check';
const THREE_DAY_BODY = [
  'Hi Jamie,',
  '',
  'Just sending the final details for reconfirmation. One thing we still need: what time our driver should arrive each day. Once we have that, we are set.',
  '',
  B + 'Tuesday, December 1: 300 coconuts, arriving 10:00 AM',
  B + 'Wednesday, December 2: 200 coconuts, arriving 9:30 AM',
  B + 'Thursday, December 3: 200 coconuts, arrival time: please tell us',
  B + 'Drop off: Expo Hall, 201 Sands Ave, Las Vegas, NV 89169',
  B + 'Count: 700 custom branded coconuts over 3 days (picture below)',
  B + 'Cracking: straw hole pre-cracked, ready for straws',
  B + 'On site contact: Ana, (702) 555-0100',
  B + 'Your contact: Sidd, ' + CELL,
  '',
  'We brand and box the day before each delivery, starting Monday, November 30, so changes need to reach us by Saturday, November 28.',
  '',
  'Thanks so much,',
  'Sidd',
  'Hamptons Coconuts',
].join('\n');
const threeDay = () => [
  head(),
  extraDay(DAY2, '2026-12-02', 200, { delivery_request: { window: '9:30 AM', status: 'confirmed' } }),
  extraDay(DAY3, '2026-12-03', 200),
];
{
  const { h, counts } = await scanAt(THU_0805_PT, { orders: threeDay() });
  assert.equal(counts.drafted, 1, 'one draft for the whole job');
  const all = h.all();
  assert.equal(all.length, 1);
  const row = all[0];
  assert.equal(row.order_id, HEAD, 'the draft belongs to day 1');
  assert.equal(row.delivery_day, '2026-12-01');
  assert.equal(row.status, 'ready');
  assert.deepEqual(row.hold_reasons, []);
  assert.equal(row.subject, THREE_DAY_SUBJECT);
  assert.equal(row.body, THREE_DAY_BODY);
  assert.deepEqual(row.facts.source.family_days.map((d) => [d.order_id, d.day, d.coconuts_qty]),
    [[HEAD, '2026-12-01', 300], [DAY2, '2026-12-02', 200], [DAY3, '2026-12-03', 200]]);
  assert.ok(!all.some((r) => r.order_id === DAY2 || r.order_id === DAY3), 'no draft for an extra day');
  assert.equal(h.reads('orders?select=id,stage,delivery_at_utc').length, 1, 'one family read');
  assert.equal(h.reads('hc_calendar_findings').length, 1, 'one findings read for the multi-day job');
  const push = h.pushes()[0];
  assert.equal(push.payload.body.order_id, HEAD);
  assert.ok(!/@|\$|\d{3}[-.)\s]\d{3}/.test(push.payload.aps.alert.body), 'no email, phone or dollar in a push');
  // The droplet's rules still hold for the family body: every fact line is
  // "Label: value", the picture paragraph opens "We brand and box", the
  // "(picture below)" note sits on the Count bullet only, and the bold
  // phrase "what time our driver should arrive" is there.
  const bullets = row.body.split('\n').filter((l) => l.startsWith(B));
  assert.ok(bullets.every((l) => l.slice(2).includes(': ')), 'every bullet is Label: value');
  assert.equal(bullets.filter((l) => l.includes('(picture below)')).length, 1);
  assert.ok(row.body.split('\n').some((l) => l.startsWith('We brand and box')));
  assert.ok(/(what time our driver should arrive)/.test(row.body));
  assert.ok(!/\$/.test(row.body), 'never an amount');
  pass('one email per job: day 1 drafts the family email listing every day with its own count and time; the extra days draft nothing');
}
{
  // Everything known (each day has a time): the approved "We are set for"
  // sentence carries the span, and the droplet's bold pattern still finds it.
  const orders = [head(), extraDay(DAY2, '2026-12-02', 200, { delivery_request: { window: '9:30 AM', status: 'confirmed' } })];
  const { h } = await scanAt(THU_0805_PT, { orders });
  const row = h.all()[0];
  assert.equal(row.subject, 'Your coconuts for Tuesday, December 1 to Wednesday, December 2: quick check');
  const opening = row.body.split('\n')[2];
  assert.equal(opening, 'Just sending the final details for reconfirmation. We are set for Tuesday, December 1 to Wednesday, December 2. Here is what we have on file for each day. Reply confirmed if it all looks right, or reply with any change by Saturday, November 28.');
  assert.equal(/We are set for ([^.]+)\./.exec(opening)[1], 'Tuesday, December 1 to Wednesday, December 2');
  assert.equal(/reply with any change (by [^.]+|today)\./.exec(opening)[1], 'by Saturday, November 28');
  assert.ok(row.body.includes(B + 'Count: 500 custom branded coconuts over 2 days (picture below)'));
  // No logo file: plain coconuts and no picture note.
  const plain = await scanAt(THU_0805_PT, { orders: [head({ logo_url: null }), orders[1]] });
  assert.ok(plain.h.all()[0].body.includes(B + 'Count: 500 coconuts over 2 days\n'));
  pass('two-day job, everything known: the set-for span and reply-by keep the droplet bold shapes; no logo means plain coconuts with no picture note');
}
{
  // A cancelled extra day is not a day of the job: day 1 lists the live ones.
  const orders = [head(), extraDay(DAY2, '2026-12-02', 200, { delivery_request: { window: '9:30 AM', status: 'confirmed' } }),
    extraDay(DAY3, '2026-12-03', 100, { stage: 'cancelled', cancelled_at: '2026-11-20T00:00:00Z' })];
  const { h } = await scanAt(THU_0805_PT, { orders });
  const row = h.all()[0];
  assert.ok(row.body.includes('over 2 days'));
  assert.ok(!row.body.includes('Thursday, December 3'));
  // Only one live day left: the one-day email, byte for byte the approved shape.
  const one = await scanAt(THU_0805_PT, { orders: [head(), extraDay(DAY3, '2026-12-03', 100, { stage: 'cancelled', cancelled_at: '2026-11-20T00:00:00Z' })] });
  const r1 = one.h.all()[0];
  assert.equal(r1.subject, 'Your coconuts for Tuesday, December 1: quick check');
  assert.ok(r1.body.includes(B + 'Delivery: Tuesday, December 1, arriving 10:00 AM'));
  assert.ok(r1.body.includes(B + 'Count: 300 custom branded coconuts (picture below)'));
  assert.equal(r1.facts.source.family_days, undefined, 'a one-day job carries no family_days');
  pass('a cancelled extra day is left off the list; with one live day left the approved one-day email comes back');
}
{
  // An extra day with no count holds day 1's email (count_missing).
  const { h } = await scanAt(THU_0805_PT, { orders: [head(), extraDay(DAY2, '2026-12-02', null)] });
  const row = h.all()[0];
  assert.equal(row.status, 'held');
  assert.deepEqual(row.hold_reasons, ['count_missing']);
  pass('a day with no count holds the job email as count_missing');
}
{
  // Pure checks: eligibility refuses an extra day (even one with its own
  // fee invoice and money) and a day whose day 1 was removed.
  const nowMs = T(THU_0805_PT);
  const fee = extraDay(DAY2, '2026-12-02', 0, { stage: 'paid_full', external_invoice_id: '9702', total_cents: 15000, balance_cents: 15000, external_invoice_url: 'https://pay.example.invalid/9702' });
  assert.deepEqual([reconfirmEligibility(fee, nowMs).eligible, reconfirmEligibility(fee, nowMs).reason], [false, 'extra day of a job']);
  const orphan = { ...head(), id: DAY3, job_day_origin: 'jarvis' };
  assert.deepEqual([reconfirmEligibility(orphan, nowMs).eligible, reconfirmEligibility(orphan, nowMs).reason], [false, 'day of a removed job']);
  assert.equal(reconfirmEligibility(head(), nowMs).eligible, true, 'day 1 is eligible');
  // The scan: the fee day drafts nothing, day 1 drafts the family email
  // (the fee day has 0 coconuts, so it holds as count_missing).
  const { h } = await scanAt(THU_0805_PT, { orders: [head(), fee] });
  assert.deepEqual(h.all().map((r) => r.order_id), [HEAD]);
  assert.deepEqual(h.all()[0].hold_reasons, ['count_missing']);
  pass('an extra day never drafts, even one holding its own fee invoice; a day of a removed job never drafts');
}
{
  // A draft made for a day before it was linked expires on the next tick.
  const rows = [{ id: 7, order_id: DAY2, delivery_day: '2026-12-02', status: 'ready', subject: 's', body: 'b', facts: { source: {} } }];
  const { h, counts } = await scanAt(THU_0805_PT, { orders: threeDay(), rows });
  assert.equal(h.rows.get(7).status, 'expired');
  assert.equal(h.rows.get(7).error_detail, 'extra day of a job: day 1 sends one email for every day');
  assert.ok(counts.expired >= 1);
  pass('a draft made for a day before it was linked expires');
}

// -- 5. The multi_day hold --
const FINDING = (code, extra = {}) => ({ id: 1, finding_key: code + ':order:' + HEAD, code, order_id: HEAD, qbo_id: null, status: 'open', ...extra });
{
  const held = await scanAt(THU_0805_PT, { orders: threeDay(), findings: [FINDING('count_differs')] });
  const row = held.h.all()[0];
  assert.equal(row.status, 'held');
  assert.deepEqual(row.hold_reasons, ['multi_day']);
  const push = held.h.pushes()[0];
  assert.equal(push.payload.body.kind, 'reconfirm_held');
  assert.ok(push.payload.aps.alert.body.endsWith('the coconuts by day disagree with the invoice.'));
  // Matched through the invoice id too (a day_link finding names day 1's invoice).
  const byQbo = await scanAt(THU_0805_PT, { orders: threeDay(), findings: [FINDING('day_link', { order_id: 'dddddddd-0000-4000-8000-000000000009', qbo_id: '9701' })] });
  assert.deepEqual(byQbo.h.all()[0].hold_reasons, ['multi_day']);
  // A finding on an extra day holds day 1's email.
  const onDay = await scanAt(THU_0805_PT, { orders: threeDay(), findings: [FINDING('days_differ', { order_id: DAY3 })] });
  assert.deepEqual(onDay.h.all()[0].hold_reasons, ['multi_day']);
  // A dismissed finding, another code, or the table missing (072 not live): no hold.
  for (const findings of [[FINDING('count_differs', { status: 'dismissed' })], [FINDING('no_time')], 'missing']) {
    const r = await scanAt(THU_0805_PT, { orders: threeDay(), findings });
    assert.equal(r.h.all()[0].status, 'ready', 'no hold for ' + JSON.stringify(findings).slice(0, 40));
  }
  // A one-day job never reads the findings table.
  const one = await scanAt(THU_0805_PT, { orders: [lone()], findings: 'fail' });
  assert.equal(one.h.reads('hc_calendar_findings').length, 0);
  assert.equal(one.counts.drafted, 1);
  pass('multi_day: an open count finding on day 1, an extra day or day 1\'s invoice holds the email; dismissed, other codes and a missing table do not; one-day jobs never read findings');
}
{
  // The findings read fails: the multi-day job waits an hour untouched,
  // the one-day job in the same tick still drafts.
  const { h, counts } = await scanAt(THU_0805_PT, { orders: [...threeDay(), lone()], findings: 'fail' });
  assert.deepEqual(h.all().map((r) => r.order_id), [LONE]);
  assert.equal(counts.skipped, 1);
  pass('a failed findings read makes the multi-day job wait (fail closed) and leaves one-day jobs alone');
}
{
  // The database check does not admit multi_day yet: the same write goes
  // once more with date_unverified, so the email still holds.
  const { h } = await scanAt(THU_0805_PT, { orders: threeDay(), findings: [FINDING('count_differs')], checkRefuses: true });
  const posts = h.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/order_reconfirmations'));
  assert.equal(posts.length, 2, 'refused once, then written');
  assert.deepEqual(posts[0].body.hold_reasons, ['multi_day']);
  assert.deepEqual(posts[1].body.hold_reasons, ['date_unverified']);
  assert.equal(h.all()[0].status, 'held');
  // A rewrite PATCH takes the same path.
  const rows = [{ id: 3, order_id: HEAD, delivery_day: '2026-12-01', status: 'ready', subject: 'old', body: 'old', facts: { source: {} }, recipients: [] }];
  const again = await scanAt(THU_0805_PT, { orders: threeDay(), rows, findings: [FINDING('count_differs')], checkRefuses: true });
  assert.equal(again.h.rows.get(3).status, 'held');
  assert.deepEqual(again.h.rows.get(3).hold_reasons, ['date_unverified']);
  pass('until the hold check admits multi_day, the write is retried as date_unverified and the email still holds');
}

// -- 6. Change detection after the email went out --
{
  const first = await scanAt(THU_0805_PT, { orders: threeDay() });
  const draft = first.h.all()[0];
  // The row went out; jsonb hands the facts back with its own key order.
  const shuffled = structuredClone(draft.facts);
  shuffled.source.family_days = shuffled.source.family_days.map((d) => Object.fromEntries(Object.entries(d).reverse()));
  const sent = { ...draft, status: 'sent', facts: shuffled, sent_at: '2026-11-27T18:00:00Z' };
  const quiet = await scanAt('2026-11-27T19:05:00Z', { orders: threeDay(), rows: [sent] });
  assert.equal(quiet.h.rows.get(sent.id).status, 'sent', 'same days in another key order: no change');
  // Day 3 is recounted after the email went out.
  const moved = threeDay();
  moved[2].coconuts_qty = 250;
  const changed = await scanAt('2026-11-27T19:05:00Z', { orders: moved, rows: [sent] });
  assert.equal(changed.h.rows.get(sent.id).status, 'changed');
  assert.equal(changed.h.rows.get(sent.id).change_note, 'job days changed');
  // An email that went out when the job had one day, before day 2 was linked.
  const oldFacts = reconfirmFacts(head(), { deliveryDay: '2026-12-01' });
  const loneSent = { ...draft, status: 'sent', facts: oldFacts };
  const linked = await scanAt('2026-11-27T19:05:00Z', { orders: threeDay(), rows: [loneSent] });
  assert.equal(linked.h.rows.get(loneSent.id).status, 'changed');
  assert.equal(linked.h.rows.get(loneSent.id).change_note, 'job days changed');
  // The pure diff: a one-day job compares as before (no family_days either side).
  assert.deepEqual(reconfirmSourceDiff(oldFacts.source, reconfirmFacts(head(), { deliveryDay: '2026-12-01' }).source), []);
  pass('after the email went out: same days in another key order are quiet; a recount or a newly linked day flips the row to changed (job days changed)');
}

// -- 7. Failures and the time before migration 072 --
{
  const { h, counts } = await scanAt(THU_0805_PT, { orders: [...threeDay(), lone()], familyReadFails: true });
  assert.equal(h.all().length, 0, 'nothing drafted');
  assert.equal(counts.failed, 1);
  // Before 072: no job_day_origin column. The family read retries without
  // it and the job still drafts as one email.
  const pre = await scanAt(THU_0805_PT, { orders: threeDay(), originMissing: true });
  assert.equal(pre.counts.drafted, 1);
  assert.equal(pre.h.all()[0].body, THREE_DAY_BODY);
  const famReads = pre.h.reads('orders?select=id,stage,delivery_at_utc');
  assert.equal(famReads.length, 2);
  assert.ok(famReads[0].url.includes(',job_day_origin') && !famReads[1].url.includes('job_day_origin'));
  pass('a failed family read stops the hour; before 072 the read retries without job_day_origin and works');
}
{
  // One-day jobs are byte for byte as before: same body, no family_days.
  const { h } = await scanAt('2026-11-26T13:05:00Z', { orders: [lone()] });
  const row = h.all()[0];
  assert.equal(row.facts.source.family_days, undefined);
  assert.ok(row.body.includes(B + 'Delivery: Tuesday, December 1, arriving 10:00 AM'));
  assert.ok(row.body.includes(B + 'Count: 80 custom branded coconuts (picture below)'));
  assert.ok(row.body.includes('We brand and box on Monday, November 30, the day before,'));
  // The template alone with a one-entry family list stays one-day.
  const f = reconfirmFacts(lone(), { deliveryDay: '2026-12-01', familyDays: [lone()] });
  assert.equal(f.derived.family, undefined);
  assert.deepEqual(reconfirmHolds(f, { recipients: ['robin@example.invalid'] }), []);
  assert.ok(reconfirmTemplate(f, {}).body.includes('Delivery: Tuesday'));
  pass('one-day jobs keep the approved email byte for byte');
}

// -- 8. The clock-out Day P&L and the shift lists --
const SHIFT = (clockIn) => ({ id: 'eeeeeeee-0000-4000-8000-000000000001', worker_name: 'Crew Vegas', worker_email: 'vegas@example.invalid', market: 'vegas',
  clock_in_at: clockIn, clock_out_at: new Date(T(clockIn) + 8 * 3600000).toISOString() });
const WORKERS = [{ email: 'vegas@example.invalid', name: 'Crew Vegas', hourly_rate_cents: 2000 }];
// A cancelled job's day 1 and its extra day, on the expo's days.
const goneHead = () => ({ ...head(), id: GONE_HEAD, client_name: 'Casey Shore', stage: 'cancelled', cancelled_at: '2026-11-20T00:00:00Z', delivery_at_utc: '2026-12-01T00:00:00Z', external_invoice_id: '9901', total_cents: 90000, balance_cents: 0 });
const goneDay = () => extraDay(GONE_DAY, '2026-12-02', 60, { client_name: 'Casey Shore', venue: 'Shore Club', parent_order_id: GONE_HEAD, job_day_origin: 'jarvis' });
const CART = { head_order_id: HEAD, qbo_id: '9702', role: 'addon', total_cents: 113794, open_cents: 113794, voided: false, line_names: ['Coconut Cart Rental'], detached_at: null };
async function summary(clockIn, opts) {
  const h = harness(opts);
  try { return { h, text: (await at(clockIn, () => buildShiftSummaryText(ENV, SHIFT(clockIn), WORKERS))).text }; } finally { h.restore(); }
}
{
  // Day 2 of the job: its coconuts count, its revenue is $0, the extra day
  // of the cancelled job is left out, tomorrow's day 3 is in prep.
  const { text } = await summary('2026-12-02T15:00:00Z', { orders: [...threeDay(), goneHead(), goneDay()], attachments: [CART] });
  const lines = text.split('\n');
  assert.ok(lines.includes(DOT + ' Jamie Rivera @ Expo Hall (day 2 of 3) - 22.2 boxes (200 coconuts)'));
  assert.ok(!text.includes('Casey Shore'), 'the day of the cancelled job is left out');
  assert.ok(lines.includes('Total: 22.2 boxes (200 coconuts)'));
  assert.ok(lines.includes(DOT + ' Jamie Rivera @ Expo Hall (day 3 of 3) - 22.2 boxes (200 coconuts)'), 'day 3 in prep');
  assert.ok(lines.includes('Revenue: $0.00 across 1 order'), 'an extra day adds $0');
  assert.ok(lines.includes('Coconuts: $278.00 (200 at $1.39)'), 'its own coconuts on its own day');
  // A day card made by hand can carry a typed total with no invoice: it
  // still adds $0 (the money is on day 1's invoice; counting it would add
  // the job twice).
  const typed = threeDay();
  typed[1].total_cents = 250000;
  const t2 = await summary('2026-12-02T15:00:00Z', { orders: typed, attachments: [] });
  assert.ok(t2.text.split('\n').includes('Revenue: $0.00 across 1 order'), 'a typed total on an extra day adds $0');
  assert.equal(familyFacts(typed, []).rows.get(DAY2).revenue_cents, 0);
  pass('Day P&L on an extra day: its own coconuts, $0 revenue even with a typed total, labelled (day 2 of 3); a day of a cancelled job leaves the lists');
}
{
  // Day 1: its own total plus the attached add-on invoice, once.
  const { text } = await summary('2026-12-01T15:00:00Z', { orders: threeDay(), attachments: [CART] });
  assert.ok(text.split('\n').includes('Revenue: $6137.94 across 1 order'));
  assert.ok(text.includes(DOT + ' Jamie Rivera @ Expo Hall (day 1 of 3) - 33.3 boxes (300 coconuts)'));
  // Unread or voided add-ons count nothing; before 072 there are none.
  const unread = await summary('2026-12-01T15:00:00Z', { orders: threeDay(), attachments: [{ ...CART, total_cents: null, open_cents: null }] });
  assert.ok(unread.text.includes('Revenue: $5000.00 across 1 order'));
  const pre = await summary('2026-12-01T15:00:00Z', { orders: threeDay(), attachments: 'missing', originMissing: true });
  assert.ok(pre.text.includes('Revenue: $5000.00 across 1 order'));
  // The family read fails: today's math, said plainly.
  const failed = await summary('2026-12-02T15:00:00Z', { orders: [...threeDay(), goneHead(), goneDay()], familyReadFails: true });
  assert.ok(failed.text.includes('Revenue: $0.00 across 2 orders (job links not read)'));
  assert.ok(failed.text.includes('Total: 28.9 boxes (260 coconuts)'), 'nothing left out without the family read');
  // A one-day job reads exactly as before.
  const plain = await summary('2026-12-01T15:00:00Z', { orders: [lone({ market: 'vegas' })] });
  assert.ok(plain.text.includes(DOT + ' Robin Lake @ Lake House - 8.9 boxes (80 coconuts)'));
  assert.ok(plain.text.includes('Revenue: $900.00 across 1 order\n'));
  pass('Day P&L on day 1: own total plus the read add-on once; unread add-ons and the time before 072 add nothing; a failed read keeps today\'s math and says so');
}
{
  // The pure helpers the coconut guard must use when it merges.
  const fam = { rows: familyFacts([...threeDay(), goneHead(), goneDay()], [CART]).rows };
  assert.equal(familyLeavesPrep(fam, { id: GONE_DAY }), true);
  assert.equal(familyLeavesPrep(fam, { id: DAY2 }), false);
  assert.equal(familyLeavesPrep(null, { id: GONE_DAY }), false, 'no facts: nothing is left out');
  assert.equal(familyDayTag(fam, { id: DAY3 }), ' (day 3 of 3)');
  assert.equal(familyDayTag(fam, { id: GONE_DAY }), '');
  assert.equal(familyRevenueOf(fam, { id: HEAD }), 613794);
  assert.equal(familyRevenueOf(null, { total_cents: 1234 }), 1234);
  pass('helpers: leaves-prep, the day tag and the revenue share follow the vectors');
}
{
  // loadJobFamilies reads the head and every extra day once, in one query,
  // and never writes.
  const h = harness({ orders: [...threeDay(), lone()], attachments: [CART] });
  try {
    const fam = await loadJobFamilies(ENV, [{ id: DAY3, parent_order_id: HEAD }, { id: LONE, parent_order_id: null }], { attachments: true });
    assert.deepEqual(fam.orders.map((o) => o.id).sort(), [HEAD, DAY2, DAY3, LONE].sort());
    assert.equal(fam.attachments.length, 1);
    assert.equal(fam.rows.get(DAY3).day_n, 3);
    assert.equal(fam.families.get(HEAD).coconuts, 700);
    assert.ok(h.calls.every((c) => c.method === 'GET'), 'reads only');
    assert.equal(h.reads('orders').length, 1);
    assert.ok(h.reads('orders')[0].url.includes('or=(id.in.(' + HEAD + ',' + LONE + '),parent_order_id.in.(' + HEAD + ',' + LONE + '))'));
  } finally { h.restore(); }
  pass('loadJobFamilies: one read for every member, the add-ons, GET only');
}

// -- 9. The 8am buy lines --
{
  const h = harness({ orders: [...threeDay(), goneHead(), goneDay()] });
  const waits = [];
  // runDailyDigest takes "today" from new Date(), which ignores a mocked
  // Date.now; this stand-in makes new Date() read the mocked clock too.
  const RealDate = Date;
  class ClockDate extends RealDate { constructor(...a) { super(...(a.length ? a : [globalThis.Date.now()])); } }
  try {
    globalThis.Date = ClockDate;
    await at('2026-12-01T12:00:00Z', async () => {
      await worker.scheduled({ cron: '0 12 * * *' }, { ...ENV, RECONFIRM_MODE: 'off', ALLOWED_CHAT_IDS: '111' }, { waitUntil: (p) => waits.push(p) });
      await Promise.all(waits);
    });
  } finally { globalThis.Date = RealDate; h.restore(); }
  const text = h.telegrams().map((b) => b.text).join('\n');
  assert.ok(text.includes('ORDER TODAY: 78 boxes* (700 coconuts)'), 'every day its own count, 300 + 200 + 200');
  assert.ok(text.includes('2026-12-02 ' + EM + ' Jamie Rivera (day 2 of 3) (200)'));
  assert.ok(text.includes('  ' + BUL + ' Jamie Rivera (day 3 of 3) ' + EM + ' 200 @ Expo Hall'));
  assert.ok(!text.includes('Casey Shore'), 'the day of a cancelled job is not in the buy lines');
  assert.ok(text.includes('Left out of the buy lines: 1 day of a cancelled or removed job (see HC Field).'));
  pass('8am buy lines: each day its own count, labelled; a day of a cancelled job is left out and counted once');
}

// -- 10. Source pins --
{
  const block = src.slice(src.indexOf('// JOB FAMILIES (calendar accuracy'), src.indexOf('// end of the job families block'));
  assert.ok(block.length > 2000, 'the block exists');
  assert.ok(!DASHES.test(block), 'no dashes in the block');
  assert.ok(![...block].some((ch) => ch.charCodeAt(0) > 127), 'the block is ASCII');
  assert.ok(!/method:\s*'(POST|PATCH|DELETE)'/.test(block), 'the block never writes');
  const columns = /const RECONFIRM_ORDER_COLUMNS = '([^']*)'/.exec(src)[1].split(',');
  assert.ok(columns.includes('parent_order_id'), 'the reconfirmation read carries parent_order_id');
  assert.ok(!columns.includes('job_day_origin'), 'and never job_day_origin (not there before 072)');
  const family = src.slice(src.indexOf('// The multi-day email (calendar families'), src.indexOf('// ' + String.fromCharCode(0x2500, 0x2500) + ' push words'));
  assert.ok(family.includes('const RECONFIRM_BULLET = String.fromCharCode(0x2022)'), 'the bullet constant is in the slice');
  assert.ok(!DASHES.test(family) && ![...family].some((ch) => ch.charCodeAt(0) > 127), 'the family template source is ASCII');
  pass('source: the family block is ASCII, dash free and read only; the reconfirmation read carries parent_order_id only');
}

console.log(`\nPASS: ${passed} job family checks. Fake network only, no database, no email, no push sent.`);

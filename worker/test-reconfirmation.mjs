// Tests for the reconfirmation email wiring in worker.js: eligibility,
// the clock, the facts, every hold, the template byte for byte, the
// pushes and their stable ids, the daily cap, preview versus auto, change
// detection before and after the send, the reply classifier, the digest
// line, and mode off. Everything runs against a fake network: nothing
// here can reach Supabase, Microsoft, or a phone.
//
// Run it with:  node worker/test-reconfirmation.mjs
//
// Spec: RECONFIRMATION-CONTRACT-2026-09-14.md (sections 2 and 4) and
// RECONFIRMATION-EMAIL-PLAN-2026-09-14.md (sections 2 and 5).

import assert from 'node:assert/strict';
import {
  reconfirmMode, reconfirmDailyCap, daysBetween, addDays, longDayWords, reconfirmDeliveryDay,
  reconfirmMoneyRecorded, reconfirmMoneyReceived, reconfirmEligibility, reconfirmInDraftHours, reconfirmSendAfter,
  reconfirmRecipients, reconfirmRecipientHolds, reconfirmCrackingWords, reconfirmPicture, reconfirmFacts, reconfirmHolds,
  reconfirmSourceDiff, reconfirmChangeNote, reconfirmTemplate, reconfirmReasonWords, reconfirmTag, reconfirmPushTexts, reconfirmQueueId,
  stripQuotedText, isPlainConfirmation, classifyReconfirmationReply, extractArrivalTimes,
  runReconfirmationScan, runReconfirmationReplyScan, buildReconfirmationDigestLines,
} from './worker.js';

let passed = 0;
const pass = (m) => { passed++; console.log('PASS: ' + m); };
const SB = 'https://example.invalid';
const T = (iso) => Date.parse(iso);
const ORDER_ID = '11111111-1111-4111-8111-111111111111';
const ORDER_2 = '22222222-2222-4222-8222-222222222222';
const ORDER_3 = '33333333-3333-4333-8333-333333333333';
const CELL = '732-555-0199';
const ENV_OFF = { SUPABASE_URL: SB, SUPABASE_SERVICE_KEY: 'not-a-real-key', TG_BOT_TOKEN: 'x', ALLOWED_CHAT_IDS: '' };
const ENV_PREVIEW = { ...ENV_OFF, RECONFIRM_MODE: 'preview', OWNER_CELL: CELL };
const ENV_AUTO = { ...ENV_OFF, RECONFIRM_MODE: 'auto', OWNER_CELL: CELL };

const ROSTER = [
  { email: 'owner@example.invalid', name: 'Sidd', role: 'owner', market: 'ny', active: true },
  { email: 'ny.manager@example.invalid', name: 'Jayden Martin', role: 'manager', market: 'ny', active: true },
  { email: 'crew@example.invalid', name: 'Hashim Nadir', role: 'team', market: 'ny', active: true },
  { email: 'vegas@example.invalid', name: 'Lian Alpuerto', role: 'team', market: 'vegas', active: true },
];
const TOKENS = { 'owner@example.invalid': 'owner-token', 'ny.manager@example.invalid': 'manager-token', 'crew@example.invalid': 'crew-token', 'vegas@example.invalid': 'vegas-token' };

// A deposit-paid Saturday job with everything on file (made up). deposit_cents
// and balance_cents are RECEIVED installments (the payment poller writes
// them): the deposit is in, the balance is not, so the invoice link prints.
// logo_received is a boolean column in Supabase (the dashboard maps its
// 'Yes' word to true on the way in), so the fixture holds true, never text.
function order(extra = {}) {
  return {
    id: ORDER_ID, client_name: 'Jamie Rivera', client_email: 'jamie@example.invalid', client_phone: '(631) 555-0177',
    venue: 'Pridwin Hotel', delivery_notes: 'Pridwin Hotel, Shelter Island, NY', delivery_at_utc: '2026-09-19T00:00:00+00:00',
    stage: 'deposit_paid', market: 'ny', coconuts_qty: 100, crack_type: null,
    invoice_fulfillment: { source: 'quickbooks', read_status: 'complete', invoice_id: '1523', address: 'Pridwin Hotel, 81 Shore Rd, Shelter Island, NY 11964', cracking: 'straw_hole', cracking_note: null, delivery_window: null, checked_at: '2026-09-10T15:00:00Z' },
    delivery_request: { date: '2026-09-19', window: '3:30 PM', status: 'confirmed', source: 'owner', checked_at: '2026-09-11T15:00:00Z', contact_name: 'Ana', contact_phone: '(631) 555-0100' },
    logo_url: 'https://files.example.invalid/logos/rivera.png', logo_asset: null, logo_received: true,
    balance_cents: 0, deposit_cents: 50000, external_invoice_id: '1523', external_invoice_url: 'https://connect.intuit.com/pay/abc', is_recurring: false,
    ...extra,
  };
}
function reply(status, data = null) {
  return { ok: status >= 200 && status < 300, status, async json() { return data; }, async text() { return data == null ? '' : JSON.stringify(data); } };
}
// A tiny PostgREST: filters eq / in / gte / lte / lt / is.null / not.is.null /
// not.is.true and the logic trees or=(...) and and=(...), nested the way
// PostgREST nests them (or=(a.eq.1,and(b.eq.2,c.gte.3))), then offset and
// limit. Two logic trees on one query are ANDed, as PostgREST does.
function matches(row, key, value) {
  const v = row[key];
  if (value === 'not.is.null') return v != null;
  if (value === 'is.null') return v == null;
  if (value === 'not.is.true') return v !== true;
  if (value === 'is.true') return v === true;
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
// Splits a logic list on its top-level commas only (a nested and(...) or
// or(...) keeps its own commas).
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
// Evaluates one logic tree ('and' or 'or') against a row.
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
      if (k === 'or' || k === 'and') {
        if (!logic(r, k, v.slice(1, -1))) return false;
        continue;
      }
      if (!matches(r, k, v)) return false;
    }
    return true;
  });
  // order=a.desc,b.asc is honoured (the reply scan reads its page newest
  // first and then walks it oldest first, so the fake must sort for real).
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
// The fake world: orders, reconfirmation rows, proposals, intake rows.
// Every row answer is a fresh copy (structuredClone), the way PostgREST
// answers: the worker's local rows must never be refreshed by a PATCH
// inside a tick, or a pin could pass here and fail in production.
function harness(opts = {}) {
  const calls = [];
  const orders = (opts.orders || []).map((o) => ({ ...o }));
  let nextId = (opts.rows || []).reduce((m, r) => Math.max(m, Number(r.id) || 0), 0) + 1;
  const rows = new Map((opts.rows || []).map((r) => [Number(r.id), { hold_reasons: [], recipients: [], facts: {}, picture: null, mode: 'preview', decision: null, send_after: null, reminded_at: null, previewed_at: null, reply_intake_id: null, reply_kind: null, sent_conversation_id: null, error_detail: null, ...r }]));
  const proposals = opts.proposals || [];
  const intakes = new Map((opts.intakes || []).map((r) => [Number(r.id), { status: 'pending_review', telegram_message_id: null, order_id: null, conversation_id: null, ...r }]));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (urlValue, options = {}) => {
    const url = String(urlValue);
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, method, body });
    if (!url.startsWith(SB + '/rest/v1/')) throw new Error('unexpected offline fetch: ' + method + ' ' + url);
    const path = url.slice((SB + '/rest/v1/').length);
    const table = path.split('?')[0];
    if (table === 'order_reconfirmations') {
      if (opts.tableMissing) return reply(404, { code: 'PGRST205' });
      if (method === 'GET') return reply(200, structuredClone(query([...rows.values()], path)));
      if (method === 'POST') {
        const dup = [...rows.values()].some((r) => r.order_id === body.order_id && r.delivery_day === body.delivery_day && r.status !== 'superseded');
        if (dup) return reply(409, { code: '23505' });
        const row = { id: nextId++, status: 'ready', hold_reasons: [], facts: {}, recipients: [], picture: null, mode: 'preview', test_to: null, send_after: null, previewed_at: null, reminded_at: null, decided_at: null, decided_by: null, decision: null, claimed_at: null, sent_at: null, reply_kind: null, replied_at: null, reply_intake_id: null, change_note: null, error_detail: null, sent_conversation_id: null, created_at: new Date(Date.now()).toISOString(), updated_at: new Date(Date.now()).toISOString(), ...body };
        rows.set(row.id, row);
        return reply(201, structuredClone([row]));
      }
      if (method === 'PATCH') {
        const hit = query([...rows.values()], path);
        for (const r of hit) Object.assign(r, body);
        return reply(200, structuredClone(hit));
      }
    }
    if (table === 'orders' && method === 'GET') return reply(200, structuredClone(query(orders, path)));
    if (table === 'order_time_proposals' && method === 'GET') {
      if (opts.proposalsMissing) return reply(404, { code: 'PGRST205' });
      return reply(200, query(proposals, path));
    }
    // Address? rows (migration 045): the scan reads pending ones and
    // accepted ones Jarvis has not finished. Missing before 045: a 404.
    if (table === 'order_address_proposals' && method === 'GET') {
      if (!opts.addressProposals) return reply(404, { code: 'PGRST205' });
      return reply(200, query(opts.addressProposals, path));
    }
    if (table === 'intake_messages') {
      if (method === 'GET') {
        // The hourly nag scan's own read: nothing waiting, so no Telegram.
        if (path.includes('from_addr,status,created_at,reviewed_at')) return reply(200, []);
        return reply(200, structuredClone(query([...intakes.values()], path)));
      }
      if (method === 'PATCH') {
        const hit = query([...intakes.values()], path);
        for (const r of hit) Object.assign(r, body);
        return reply(200, structuredClone(hit));
      }
    }
    if (table === 'field_workers' && method === 'GET') return reply(200, ROSTER);
    if (table === 'shifts' && method === 'GET') return reply(200, []);
    if (table === 'push_tokens' && method === 'GET') {
      const list = decodeURIComponent(path.split('email=in.(')[1].split(')')[0]);
      const wanted = list.split(',').map((s) => s.replace(/"/g, '').trim().toLowerCase());
      return reply(200, wanted.filter((e) => TOKENS[e]).map((e) => ({ email: e, apns_token: TOKENS[e] })));
    }
    if (table === 'push_queue' && method === 'POST') return reply(201, null);
    if (table === 'push_queue' && method === 'GET') return reply(200, []);
    throw new Error('unexpected offline fetch: ' + method + ' ' + url);
  };
  return {
    calls, rows, intakes, orders,
    row: (id) => rows.get(Number(id)),
    all: () => [...rows.values()],
    pushes: () => calls.filter((c) => c.method === 'POST' && c.url === SB + '/rest/v1/push_queue').map((c) => c.body),
    reads: (table) => calls.filter((c) => c.method === 'GET' && c.url.startsWith(SB + '/rest/v1/' + table)),
    restore: () => { globalThis.fetch = originalFetch; },
  };
}
const realNow = Date.now;
async function at(iso, fn) {
  Date.now = () => T(iso);
  try { return await fn(); } finally { Date.now = realNow; }
}
async function scanAt(iso, env, opts) {
  const h = harness(opts);
  try { return { h, counts: await at(iso, () => runReconfirmationScan(env)) }; } finally { h.restore(); }
}
async function replyScanAt(iso, env, opts) {
  const h = harness(opts);
  try { return { h, result: await at(iso, () => runReconfirmationReplyScan(env)) }; } finally { h.restore(); }
}
// Monday 2026-09-14 08:05 ET (delivery day minus 5 for the Saturday job).
const MON_0805 = '2026-09-14T12:05:00Z';
// Case A, everything known, with the picture: the wording Sidd approved
// on 2026-09-18, byte for byte. Bullet lines start with "• " and read
// "Label: value" (the droplet bolds the label up to the first colon).
const FULL_SUBJECT = 'Your coconuts for Saturday, September 19: quick check';
const FULL_BODY = [
  'Hi Jamie,',
  '',
  'Just sending the final details for reconfirmation. We are set for Saturday, September 19. Here is what we have on file. Reply confirmed if it all looks right, or reply with any change by Wednesday, September 16.',
  '',
  '• Delivery: Saturday, September 19, arriving 3:30 PM',
  '• Drop off: Pridwin Hotel, 81 Shore Rd, Shelter Island, NY 11964',
  '• Count: 100 custom branded coconuts (picture below)',
  '• Cracking: straw hole pre-cracked, ready for straws',
  '• On site contact: Ana, (631) 555-0100',
  '• Your contact: Sidd, 732-555-0199',
  '',
  'We brand and box on Friday, September 18, the day before, so changes need to reach us by Wednesday, September 16.',
  '',
  'Invoice, if you need it: https://connect.intuit.com/pay/abc',
  '',
  'Thanks so much,',
  'Sidd',
  'Hamptons Coconuts',
].join('\n');
// The wording the worker made before 2026-09-18, as a row drafted then
// still carries it. Used to pin that a template change rewrites an
// existing draft once.
const OLD_SUBJECT = 'Your coconuts for Saturday, September 19: quick reconfirm';
const OLD_BODY = [
  'Hi Jamie,',
  '',
  'Your coconuts for Saturday, September 19 are locked in. One quick read through before we brand them.',
  '',
  'Delivery: Saturday, September 19, arriving 3:30 PM',
  'Drop off: Pridwin Hotel, 81 Shore Rd, Shelter Island, NY 11964',
  'Count: 100 custom branded coconuts',
  'Cracking: straw hole pre-cracked, ready for straws',
  'On site contact: Ana, (631) 555-0100',
  'Your contact on our side: Sidd, 732-555-0199, sidd@hamptonscoconuts.com',
  '',
  'We brand and box everything on Friday, September 18, the day before. If anything above needs to change (count, time, address, or who meets us), reply by Wednesday, September 16 and I will update it.',
  '',
  'If it all looks right, just reply "confirmed" and we are set.',
  '',
  'If there is a run of show or vendor timeline for the day, send it over and I will make sure our arrival matches it.',
  '',
  'Your invoice is here if you need it: https://connect.intuit.com/pay/abc',
  '',
  'Thanks so much,',
  'Sidd',
  'Hamptons Coconuts',
  '732-555-0199',
].join('\n');

// ── 1. Settings and calendar helpers ────────────────────────────────
{
  assert.equal(reconfirmMode({}), 'off'); assert.equal(reconfirmMode({ RECONFIRM_MODE: 'Preview ' }), 'preview');
  assert.equal(reconfirmMode({ RECONFIRM_MODE: 'auto' }), 'auto'); assert.equal(reconfirmMode({ RECONFIRM_MODE: 'yes' }), 'off');
  assert.equal(reconfirmDailyCap({}), 8); assert.equal(reconfirmDailyCap({ RECONFIRM_DAILY_CAP: '3' }), 3); assert.equal(reconfirmDailyCap({ RECONFIRM_DAILY_CAP: 'lots' }), 8);
  assert.equal(daysBetween('2026-09-14', '2026-09-19'), 5); assert.equal(daysBetween('2026-10-31', '2026-11-02'), 2); assert.equal(daysBetween('x', '2026-09-19'), null);
  assert.equal(addDays('2026-09-19', -4), '2026-09-15'); assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(longDayWords('2026-09-19'), 'Saturday, September 19'); assert.equal(longDayWords('2026-11-01'), 'Sunday, November 1');
  assert.equal(reconfirmDeliveryDay({ delivery_at_utc: '2026-09-19T00:00:00+00:00' }), '2026-09-19'); assert.equal(reconfirmDeliveryDay({}), '');
  pass('settings default to off and 8; day arithmetic is string based and DST proof; day words read Saturday, September 19');
}

// ── 2. Eligibility, every branch ────────────────────────────────────
{
  const now = T(MON_0805);
  const ok = reconfirmEligibility(order(), now);
  assert.deepEqual(ok, { eligible: true, reason: null, market: 'ny', today: '2026-09-14', deliveryDay: '2026-09-19', daysOut: 5 });
  assert.equal(reconfirmEligibility(order({ stage: 'paid_full' }), now).eligible, true);
  assert.equal(reconfirmEligibility(order({ stage: 'invoiced', deposit_cents: 0, balance_cents: 100 }), now).eligible, true);
  assert.equal(reconfirmEligibility(order({ stage: 'invoiced', deposit_cents: 0, balance_cents: 0 }), now).reason, 'no payment yet');
  assert.equal(reconfirmEligibility(order({ stage: 'invoiced', deposit_cents: null, balance_cents: null }), now).reason, 'no payment yet');
  assert.equal(reconfirmEligibility(order({ stage: 'quoted' }), now).reason, 'no payment yet');
  // MONEY RECORDED is required: a paid stage with nothing recorded (the
  // hand-set deposit_paid December order of 2026-09-14) never qualifies,
  // and carries its own reason so the digest can name it.
  assert.equal(reconfirmEligibility(order({ stage: 'deposit_paid', deposit_cents: 0, balance_cents: 0 }), now).eligible, false);
  assert.equal(reconfirmEligibility(order({ stage: 'deposit_paid', deposit_cents: 0, balance_cents: 0 }), now).reason, 'stage says paid but nothing recorded');
  assert.equal(reconfirmEligibility(order({ stage: 'deposit_paid', deposit_cents: null, balance_cents: null }), now).reason, 'stage says paid but nothing recorded');
  assert.equal(reconfirmEligibility(order({ stage: 'paid_full', deposit_cents: 0, balance_cents: 0 }), now).reason, 'stage says paid but nothing recorded');
  assert.equal(reconfirmEligibility(order({ stage: 'paid_full', deposit_cents: '', balance_cents: '' }), now).reason, 'stage says paid but nothing recorded');
  assert.equal(reconfirmEligibility(order({ stage: 'deposit_paid', deposit_cents: 0, balance_cents: 250 }), now).eligible, true);
  assert.equal(reconfirmEligibility(order({ stage: 'paid_full', deposit_cents: null, balance_cents: '99' }), now).eligible, true);
  assert.equal(reconfirmMoneyRecorded({ deposit_cents: null, balance_cents: '5' }), true);
  assert.equal(reconfirmMoneyRecorded({ deposit_cents: 0, balance_cents: 0 }), false);
  assert.equal(reconfirmMoneyRecorded({}), false);
  assert.equal(reconfirmMoneyReceived({ stage: 'deposit_paid' }), false);
  assert.equal(reconfirmMoneyReceived({ stage: 'paid_full', deposit_cents: 0, balance_cents: 0 }), false);
  assert.equal(reconfirmMoneyReceived({ stage: 'deposit_paid', deposit_cents: 1 }), true);
  assert.equal(reconfirmMoneyReceived({ stage: 'quoted', deposit_cents: 100 }), false, 'money on a quoted order is not an invoiced payment');
  assert.equal(reconfirmMoneyReceived({ stage: 'cancelled', deposit_cents: 100 }), false);
  for (const stage of ['cancelled', 'fulfilled', 'complete']) assert.equal(reconfirmEligibility(order({ stage }), now).reason, 'stage ' + stage);
  assert.equal(reconfirmEligibility(order({ external_invoice_id: null }), now).reason, 'no invoice');
  assert.equal(reconfirmEligibility(order({ external_invoice_id: '  ' }), now).reason, 'no invoice');
  assert.equal(reconfirmEligibility(order({ delivery_at_utc: null }), now).reason, 'no delivery date');
  assert.equal(reconfirmEligibility(order({ is_recurring: true }), now).reason, 'recurring account');
  assert.equal(reconfirmEligibility(order({ delivery_at_utc: '2026-09-20T00:00:00+00:00' }), now).reason, 'too far');
  assert.equal(reconfirmEligibility(order({ delivery_at_utc: '2026-09-16T00:00:00+00:00' }), now).daysOut, 2);
  // Minus 1 and the day itself still qualify (Send now only, see the clock); the day after does not.
  assert.deepEqual(reconfirmEligibility(order({ delivery_at_utc: '2026-09-15T00:00:00+00:00' }), now), { eligible: true, reason: null, market: 'ny', today: '2026-09-14', deliveryDay: '2026-09-15', daysOut: 1 });
  assert.equal(reconfirmEligibility(order({ delivery_at_utc: '2026-09-14T00:00:00+00:00' }), now).eligible, true);
  assert.equal(reconfirmEligibility(order({ delivery_at_utc: '2026-09-14T00:00:00+00:00' }), now).daysOut, 0);
  assert.equal(reconfirmEligibility(order({ delivery_at_utc: '2026-09-13T00:00:00+00:00' }), now).reason, 'delivery day passed');
  // Calendar days in the MARKET zone: at 23:30 ET on Monday it is still
  // Monday in New York but 20:30 Monday in Vegas too; at 02:30 ET Tuesday
  // Vegas is still on Monday, so the Vegas job is one day further out.
  const lateNight = T('2026-09-15T06:30:00Z');
  assert.equal(reconfirmEligibility(order(), lateNight).daysOut, 4);
  assert.equal(reconfirmEligibility(order({ market: 'vegas' }), lateNight).daysOut, 5);
  assert.equal(reconfirmEligibility(order({ market: 'vegas' }), lateNight).today, '2026-09-14');
  // Never zone-converted: midnight UTC on the 19th is the 19th in Vegas too.
  assert.equal(reconfirmEligibility(order({ market: 'vegas' }), now).deliveryDay, '2026-09-19');
  assert.equal(reconfirmMoneyReceived({ stage: 'invoiced', deposit_cents: '250' }), true);
  pass('eligibility: money recorded AND a paid or invoiced stage (a paid stage with zero recorded is out, with its own reason), closed stages, no invoice, no date, recurring, the 0 to 5 day window counted in the market zone on date strings (the day after delivery is out)');
}

// ── 3. The clock: NY and Vegas, DST, late arrivals, the minus-1 rule ─
{
  assert.equal(reconfirmInDraftHours(T('2026-09-14T11:30:00Z'), 'ny'), false);  // 07:30 ET
  assert.equal(reconfirmInDraftHours(T('2026-09-14T12:00:00Z'), 'ny'), true);   // 08:00 ET
  assert.equal(reconfirmInDraftHours(T('2026-09-15T00:59:00Z'), 'ny'), true);   // 20:59 ET
  assert.equal(reconfirmInDraftHours(T('2026-09-15T01:00:00Z'), 'ny'), false);  // 21:00 ET: the edge is closed
  assert.equal(reconfirmInDraftHours(T('2026-09-15T01:30:00Z'), 'ny'), false);  // 21:30 ET
  assert.equal(reconfirmInDraftHours(T('2026-09-15T02:00:00Z'), 'ny'), false);  // 22:00 ET
  assert.equal(reconfirmInDraftHours(T('2026-09-14T12:00:00Z'), 'vegas'), false); // 05:00 PT
  assert.equal(reconfirmInDraftHours(T('2026-09-14T15:00:00Z'), 'vegas'), true);  // 08:00 PT
  // Minus 5: 10:00 market time on minus 4.
  assert.equal(reconfirmSendAfter({ deliveryDay: '2026-09-19', daysOut: 5, nowMs: T(MON_0805), market: 'ny' }), '2026-09-15T14:00:00.000Z');
  assert.equal(reconfirmSendAfter({ deliveryDay: '2026-09-19', daysOut: 5, nowMs: T(MON_0805), market: 'vegas' }), '2026-09-15T17:00:00.000Z');
  // DST ends Sunday 2026-11-01. Minus 4 on Oct 31 is still daylight time,
  // on Nov 1 it is standard time, in both zones.
  assert.equal(reconfirmSendAfter({ deliveryDay: '2026-11-04', daysOut: 5, nowMs: T('2026-10-30T13:00:00Z'), market: 'ny' }), '2026-10-31T14:00:00.000Z');
  assert.equal(reconfirmSendAfter({ deliveryDay: '2026-11-05', daysOut: 5, nowMs: T('2026-10-31T13:00:00Z'), market: 'ny' }), '2026-11-01T15:00:00.000Z');
  assert.equal(reconfirmSendAfter({ deliveryDay: '2026-11-04', daysOut: 5, nowMs: T('2026-10-30T16:00:00Z'), market: 'vegas' }), '2026-10-31T17:00:00.000Z');
  assert.equal(reconfirmSendAfter({ deliveryDay: '2026-11-05', daysOut: 5, nowMs: T('2026-10-31T16:00:00Z'), market: 'vegas' }), '2026-11-01T18:00:00.000Z');
  // Late arrivals: three hours later; never after 17:00 on minus 2.
  assert.equal(reconfirmSendAfter({ deliveryDay: '2026-09-19', daysOut: 4, nowMs: T('2026-09-15T18:00:00Z'), market: 'ny' }), '2026-09-15T21:00:00.000Z'); // 14:00 -> 17:00 ET
  assert.equal(reconfirmSendAfter({ deliveryDay: '2026-09-19', daysOut: 2, nowMs: T('2026-09-17T17:00:00Z'), market: 'ny' }), '2026-09-17T20:00:00.000Z'); // 13:00 -> 16:00 ET
  assert.equal(reconfirmSendAfter({ deliveryDay: '2026-09-19', daysOut: 2, nowMs: T('2026-09-17T19:00:00Z'), market: 'ny' }), '2026-09-17T21:00:00.000Z'); // 15:00 -> capped 17:00 ET
  assert.equal(reconfirmSendAfter({ deliveryDay: '2026-09-19', daysOut: 2, nowMs: T('2026-09-17T21:30:00Z'), market: 'ny' }), null);                       // 17:30 on minus 2: Send now only
  assert.equal(reconfirmSendAfter({ deliveryDay: '2026-09-19', daysOut: 2, nowMs: T('2026-09-17T22:00:00Z'), market: 'vegas' }), '2026-09-18T00:00:00.000Z'); // 15:00 PT -> 17:00 PT
  // A late evening draft rolls to 10:00 the next morning instead of 00:30.
  assert.equal(reconfirmSendAfter({ deliveryDay: '2026-09-19', daysOut: 3, nowMs: T('2026-09-17T01:30:00Z'), market: 'ny' }), '2026-09-17T14:00:00.000Z'); // 21:30 ET Wed -> 10:00 ET Thu
  assert.equal(reconfirmSendAfter({ deliveryDay: '2026-09-19', daysOut: 3, nowMs: T('2026-09-16T06:00:00Z'), market: 'ny' }), '2026-09-16T14:00:00.000Z'); // 02:00 ET -> 10:00 ET
  // Minus 1 and the day: never automatic.
  assert.equal(reconfirmSendAfter({ deliveryDay: '2026-09-19', daysOut: 1, nowMs: T('2026-09-18T15:00:00Z'), market: 'ny' }), null);
  assert.equal(reconfirmSendAfter({ deliveryDay: '2026-09-19', daysOut: 0, nowMs: T('2026-09-19T15:00:00Z'), market: 'ny' }), null);
  pass('clock: draft hours 08:00 to 21:00 market time; 10:00 on minus 4 in NY and Vegas across the DST switch; late arrivals +3h with the 17:00 cap on minus 2; nothing automatic on minus 1 or the day');
}

// ── 4. Recipients and their holds ───────────────────────────────────
{
  assert.deepEqual(reconfirmRecipients(' Jamie@Example.invalid , ops@example.invalid,jamie@example.invalid'), ['jamie@example.invalid', 'ops@example.invalid']);
  assert.deepEqual(reconfirmRecipients('Jamie Rivera <jamie@example.invalid>'), ['jamie@example.invalid']);
  // QuickBooks accepts semicolons in BillEmail: the second person is never lost.
  assert.deepEqual(reconfirmRecipients('a@x.com; b@y.com'), ['a@x.com', 'b@y.com']);
  assert.deepEqual(reconfirmRecipients('a@x.com;b@y.com, c@z.com'), ['a@x.com', 'b@y.com', 'c@z.com']);
  assert.deepEqual(reconfirmRecipients(''), []); assert.deepEqual(reconfirmRecipients('not an email'), []);
  assert.deepEqual(reconfirmRecipientHolds([]), ['no_email']);
  assert.deepEqual(reconfirmRecipientHolds(['a@x.co', 'b@x.co', 'c@x.co', 'd@x.co', 'e@x.co']), ['too_many_emails']);
  assert.deepEqual(reconfirmRecipientHolds(['jamie@example.invalid', 'sidd@hamptonscoconuts.com']), ['no_email']);
  assert.deepEqual(reconfirmRecipientHolds(['emma@gethamptonscoco.com']), ['no_email']);
  assert.deepEqual(reconfirmRecipientHolds(['ar@example.invalid', 'billing@example.invalid']), ['billing_email_only']);
  assert.deepEqual(reconfirmRecipientHolds(['ar@example.invalid', 'jamie@example.invalid']), []);
  pass('recipients: split on commas or semicolons, trimmed, lowercased, de-duplicated; holds for none, more than 4, our own domains, billing-only');
}

// ── 5. Facts, cracking, picture, holds ──────────────────────────────
{
  const f = reconfirmFacts(order());
  assert.equal(f.source.stage, 'deposit_paid'); assert.equal(f.source.coconuts_qty, 100); assert.equal(f.source.client_email, 'jamie@example.invalid');
  assert.deepEqual(f.source.invoice_fulfillment, { address: 'Pridwin Hotel, 81 Shore Rd, Shelter Island, NY 11964', cracking: 'straw_hole', cracking_note: null, delivery_window: null, read_status: 'complete' });
  assert.deepEqual(f.source.delivery_request, { status: 'confirmed', window: '3:30 PM', contact_name: 'Ana', contact_phone: '(631) 555-0100', location: null });
  assert.equal(f.source.logo_asset_status, null); assert.equal(f.source.balance_cents, 0);
  assert.deepEqual(f.derived, {
    first_name: 'Jamie', day_words: 'Saturday, September 19', prep_day_words: 'Friday, September 18', reply_by_words: 'Wednesday, September 16',
    count: 100, address: 'Pridwin Hotel, 81 Shore Rd, Shelter Island, NY 11964', cracking_words: 'straw hole pre-cracked, ready for straws',
    window_words: '3:30 PM', contact_words: 'Ana, (631) 555-0100', balance_open: true, market: 'ny', zone: 'America/New_York',
  });
  // Numbers stay numbers and null stays null on both sides (contract
  // section 4): a null column is never stored as 0, or the droplet's
  // compare (None there) would bounce the row every hour.
  assert.equal(reconfirmFacts(order({ balance_cents: null })).source.balance_cents, null);
  assert.equal(reconfirmFacts(order({ balance_cents: '' })).source.balance_cents, null);
  assert.equal(reconfirmFacts(order({ balance_cents: '2500' })).source.balance_cents, 2500);
  assert.equal(reconfirmFacts(order({ coconuts_qty: null })).source.coconuts_qty, null);
  assert.equal(reconfirmFacts(order({ coconuts_qty: 'lots' })).source.coconuts_qty, null);
  assert.equal(reconfirmFacts(order({ coconuts_qty: 0 })).source.coconuts_qty, 0);
  assert.deepEqual(reconfirmSourceDiff(reconfirmFacts(order({ balance_cents: null })).source, reconfirmFacts(order({ balance_cents: null })).source), []);
  // Booleans stay booleans: orders.logo_received is a boolean column and
  // the droplet compares the live true/false to what is stored here, so
  // the text 'true' would read as a change at send time on every row and
  // nothing would ever send. Null stays null; a text value stays text.
  assert.strictEqual(reconfirmFacts(order({ logo_received: true })).source.logo_received, true);
  assert.strictEqual(reconfirmFacts(order({ logo_received: false })).source.logo_received, false);
  assert.strictEqual(reconfirmFacts(order({ logo_received: null })).source.logo_received, null);
  assert.strictEqual(reconfirmFacts(order({ logo_received: 'unbranded' })).source.logo_received, 'unbranded');
  assert.deepEqual(reconfirmSourceDiff(reconfirmFacts(order({ logo_received: false })).source, reconfirmFacts(order({ logo_received: false })).source), []);
  assert.deepEqual(reconfirmSourceDiff(reconfirmFacts(order({ logo_received: true })).source, reconfirmFacts(order({ logo_received: false })).source).map((d) => d.key), ['logo_received']);
  assert.deepEqual(JSON.parse(JSON.stringify(reconfirmFacts(order({ logo_received: true })).source)).logo_received, true, 'still a boolean after the jsonb round trip');
  // Balance open means the stage is not paid_full (the cents columns are what was received, never what is owed).
  assert.equal(reconfirmFacts(order({ stage: 'paid_full', balance_cents: 50000 })).derived.balance_open, false);
  assert.equal(reconfirmFacts(order({ stage: 'deposit_paid', balance_cents: 0 })).derived.balance_open, true);
  assert.equal(reconfirmFacts(order({ stage: 'invoiced', deposit_cents: 100, balance_cents: null })).derived.balance_open, true);
  assert.equal(reconfirmFacts(order({ external_invoice_url: null })).derived.balance_open, false);
  // First name: skips articles and titles, drops punctuation, else 'there'.
  assert.equal(reconfirmFacts(order({ client_name: 'The Maidstone' })).derived.first_name, 'Maidstone');
  assert.equal(reconfirmFacts(order({ client_name: 'Rivera, Jamie' })).derived.first_name, 'Rivera');
  assert.equal(reconfirmFacts(order({ client_name: 'Dr. Casey Lin' })).derived.first_name, 'Casey');
  assert.equal(reconfirmFacts(order({ client_name: 'A Mrs Robin Park' })).derived.first_name, 'Robin');
  assert.equal(reconfirmFacts(order({ client_name: "Jamie O'Neil" })).derived.first_name, 'Jamie');
  assert.equal(reconfirmFacts(order({ client_name: null })).derived.first_name, 'there');
  assert.equal(reconfirmFacts(order({ client_name: 'The' })).derived.first_name, 'there');
  // Address precedence: the invoice only when read completely, else notes, else venue; never a billing address.
  assert.equal(reconfirmFacts(order({ invoice_fulfillment: { read_status: 'unread', address: 'Accountant, 1 Billing Way, NJ' } })).derived.address, 'Pridwin Hotel, Shelter Island, NY');
  assert.equal(reconfirmFacts(order({ invoice_fulfillment: null, delivery_notes: '' })).derived.address, 'Pridwin Hotel');
  assert.equal(reconfirmFacts(order({ invoice_fulfillment: null, delivery_notes: null, venue: null })).derived.address, null);
  // Window: the confirmed request wins; else a parseable invoice window; a time without AM/PM is asked for.
  assert.equal(reconfirmFacts(order({ delivery_request: null, invoice_fulfillment: { ...order().invoice_fulfillment, delivery_window: 'between 2 and 3 pm' } })).derived.window_words, '2:00 PM');
  assert.equal(reconfirmFacts(order({ delivery_request: { ...order().delivery_request, status: 'requested' }, invoice_fulfillment: { ...order().invoice_fulfillment, delivery_window: null } })).derived.window_words, null);
  assert.equal(reconfirmFacts(order({ delivery_request: { ...order().delivery_request, window: 'around 4' } })).derived.window_words, null);
  assert.equal(reconfirmFacts(order({ delivery_request: { ...order().delivery_request, window: 'morning' } })).derived.window_words, null);
  // Cracking: the box when it agrees with the invoice reading (or there is
  // none), else the invoice reading; a disagreement is UNKNOWN (a hard hold),
  // never the box alone; mixed reads the note; review is unknown.
  assert.equal(reconfirmCrackingWords({ crack_type: 'circle', invoice_fulfillment: { cracking: 'straw_hole' } }), null);
  assert.equal(reconfirmCrackingWords({ crack_type: 'circle', invoice_fulfillment: { cracking: 'mixed', cracking_note: 'Cocktail cut on 60 of 100 coconuts; straw hole on the other 40.' } }), null);
  assert.equal(reconfirmCrackingWords({ crack_type: 'straw', invoice_fulfillment: { cracking: 'cocktail' } }), null);
  assert.equal(reconfirmCrackingWords({ crack_type: 'straw', invoice_fulfillment: { cracking: 'mixed' } }), null);
  assert.equal(reconfirmCrackingWords({ crack_type: 'whole', invoice_fulfillment: { cracking: 'cocktail' } }), null);
  assert.equal(reconfirmCrackingWords({ crack_type: 'circle', invoice_fulfillment: { cracking: 'cocktail' } }), 'cocktail cut');
  assert.equal(reconfirmCrackingWords({ crack_type: 'straw', invoice_fulfillment: { cracking: 'straw_hole' } }), 'straw hole pre-cracked, ready for straws');
  assert.equal(reconfirmCrackingWords({ crack_type: 'straw', invoice_fulfillment: { cracking: 'review' } }), 'straw hole pre-cracked, ready for straws');
  assert.equal(reconfirmCrackingWords({ crack_type: 'straw', invoice_fulfillment: {} }), 'straw hole pre-cracked, ready for straws');
  assert.equal(reconfirmCrackingWords({ crack_type: 'straw', invoice_fulfillment: null }), 'straw hole pre-cracked, ready for straws');
  assert.equal(reconfirmCrackingWords({ crack_type: 'whole', invoice_fulfillment: { cracking: 'review' } }), 'whole, unopened.');
  assert.equal(reconfirmCrackingWords({ crack_type: 'whole', invoice_fulfillment: {} }), 'whole, unopened.');
  assert.equal(reconfirmCrackingWords({ crack_type: null, invoice_fulfillment: { cracking: 'cocktail' } }), 'cocktail cut');
  assert.equal(reconfirmCrackingWords({ crack_type: null, invoice_fulfillment: { cracking: 'mixed', cracking_note: 'Cocktail cut on 60 of 100 coconuts; straw hole on the other 40.' } }), '60 cocktail cut, 40 straw hole pre-cracked.');
  assert.equal(reconfirmCrackingWords({ crack_type: null, invoice_fulfillment: { cracking: 'mixed', cracking_note: 'some of each' } }), null);
  assert.equal(reconfirmCrackingWords({ crack_type: null, invoice_fulfillment: { cracking: 'review', cracking_note: 'Invoice requests whole or unopened coconuts.' } }), null);
  assert.equal(reconfirmCrackingWords({ crack_type: null, invoice_fulfillment: {} }), null);
  // Picture: approved preview first (Coconut front preferred), else a PNG or JPEG logo_url, never a .pdf or .ai, never needs_review.
  const asset = { status: 'approved', files: [{ file_name: 'back.png', preview_path: 'o/back-preview.png', usage: 'Coconut back' }, { file_name: 'front.png', preview_path: 'o/front-preview.png', usage: 'Coconut front' }] };
  assert.deepEqual(reconfirmPicture(order({ logo_asset: asset })), { source: 'logo_asset', bucket: 'order-logos', path: 'o/front-preview.png', content_type: 'image/png' });
  assert.deepEqual(reconfirmPicture(order({ logo_asset: { ...asset, status: 'needs_review' } })), { source: 'logo_url', bucket: null, path: 'https://files.example.invalid/logos/rivera.png', content_type: 'image/png' });
  assert.deepEqual(reconfirmPicture(order({ logo_url: 'https://files.example.invalid/logos/rivera.JPG?x=1' })), { source: 'logo_url', bucket: null, path: 'https://files.example.invalid/logos/rivera.JPG?x=1', content_type: 'image/jpeg' });
  assert.equal(reconfirmPicture(order({ logo_url: 'https://files.example.invalid/logos/rivera.ai' })), null);
  assert.equal(reconfirmPicture(order({ logo_url: null })), null);
  // Holds: count, address, cracking, pending proposal, recipients, date.
  assert.deepEqual(reconfirmHolds(f, { recipients: ['jamie@example.invalid'] }), []);
  assert.deepEqual(reconfirmHolds(reconfirmFacts(order({ coconuts_qty: 0 })), { recipients: ['jamie@example.invalid'] }), ['count_missing']);
  assert.deepEqual(reconfirmHolds(reconfirmFacts(order({ coconuts_qty: null })), { recipients: ['jamie@example.invalid'] }), ['count_missing']);
  assert.deepEqual(reconfirmHolds(reconfirmFacts(order({ invoice_fulfillment: { ...order().invoice_fulfillment, address: null }, delivery_notes: null, venue: null })), { recipients: ['jamie@example.invalid'] }), ['address_missing']);
  assert.deepEqual(reconfirmHolds(reconfirmFacts(order({ invoice_fulfillment: { ...order().invoice_fulfillment, cracking: 'review' } })), { recipients: ['jamie@example.invalid'] }), ['cracking_unknown']);
  // The box and the invoice disagree (box cocktail, invoice straw hole): a hard hold, never the box alone.
  assert.deepEqual(reconfirmHolds(reconfirmFacts(order({ crack_type: 'circle' })), { recipients: ['jamie@example.invalid'] }), ['cracking_unknown']);
  assert.deepEqual(reconfirmHolds(reconfirmFacts(order({ crack_type: 'straw' })), { recipients: ['jamie@example.invalid'] }), []);
  assert.deepEqual(reconfirmHolds(f, { recipients: ['jamie@example.invalid'], pendingProposal: true }), ['pending_time_proposal']);
  assert.deepEqual(reconfirmHolds(f, { recipients: ['jamie@example.invalid'], pendingAddressProposal: true }), ['pending_address_proposal']);
  assert.deepEqual(reconfirmHolds(f, { recipients: ['jamie@example.invalid'], pendingProposal: true, pendingAddressProposal: true }), ['pending_time_proposal', 'pending_address_proposal']);
  assert.deepEqual(reconfirmHolds(f, { recipients: [] }), ['no_email']);
  assert.deepEqual(reconfirmHolds(f, { recipients: ['ap@example.invalid'] }), ['billing_email_only']);
  assert.deepEqual(reconfirmHolds(reconfirmFacts(order({ delivery_at_utc: null }), { deliveryDay: '2026-09-19' }), { recipients: ['jamie@example.invalid'] }), ['date_unverified']);
  assert.deepEqual(reconfirmHolds(reconfirmFacts(order({ coconuts_qty: null, venue: null, delivery_notes: null, invoice_fulfillment: null })), { recipients: [] }), ['count_missing', 'address_missing', 'cracking_unknown', 'no_email']);
  // Soft gaps never hold.
  assert.deepEqual(reconfirmHolds(reconfirmFacts(order({ delivery_request: null, logo_url: null, logo_received: null })), { recipients: ['jamie@example.invalid'] }), []);
  pass('facts: source and derived per section 4 (null numbers stay null, balance open = not paid_full, first name skips articles and titles), address precedence, window rules, cracking words (a box and invoice disagreement is unknown), the picture choice, and every hold reason (soft gaps never hold)');
}

// ── 6. The template, byte for byte (the 2026-09-18 wording) ─────────
{
  const OPTS = { ownerCell: CELL, picture: reconfirmPicture(order()), today: '2026-09-14', deliveryDay: '2026-09-19' };
  // The first paragraph of case A and the two bullets case B changes.
  const CASE_A_OPENER = 'Just sending the final details for reconfirmation. We are set for Saturday, September 19. Here is what we have on file. Reply confirmed if it all looks right, or reply with any change by Wednesday, September 16.';
  const DELIVERY_KNOWN = '• Delivery: Saturday, September 19, arriving 3:30 PM';
  const DELIVERY_ASK = '• Delivery: Saturday, September 19, arrival time: please tell us';
  const CONTACT_KNOWN = '• On site contact: Ana, (631) 555-0100';
  const CONTACT_ASK = '• On site contact: please send a name and cell';
  // Case A with the picture: the approved email, byte for byte.
  const full = reconfirmTemplate(reconfirmFacts(order()), OPTS);
  assert.equal(full.subject, FULL_SUBJECT);
  assert.equal(full.body, FULL_BODY);
  // Case A without a picture: plain "coconuts", no "(picture below)", and
  // every other line the same.
  const noPic = reconfirmTemplate(reconfirmFacts(order({ logo_url: null, logo_received: false })), { ...OPTS, picture: null });
  assert.equal(noPic.subject, FULL_SUBJECT);
  assert.equal(noPic.body, FULL_BODY.replace('• Count: 100 custom branded coconuts (picture below)', '• Count: 100 coconuts'));
  assert.ok(!/picture|branded/i.test(noPic.body), 'no picture is mentioned when none goes with the email');
  // No cell: the contact bullet is the name alone, never an email address,
  // and the sign-off ends at the company.
  const noCell = reconfirmTemplate(reconfirmFacts(order()), { ...OPTS, ownerCell: '' }).body;
  assert.equal(noCell, FULL_BODY.replace('• Your contact: Sidd, 732-555-0199', '• Your contact: Sidd'));
  assert.ok(!noCell.includes('@'), 'never an email address in the body');
  assert.ok(noCell.endsWith('\nThanks so much,\nSidd\nHamptons Coconuts'));
  // The shape the droplet renders (reconfirm_sender.py): every fact line
  // starts with the bullet and a space and reads "Label: value" (the label
  // up to the first colon goes bold), in this order, and no other line
  // starts with a bullet.
  const bullets = full.body.split('\n').filter((l) => l.startsWith('•'));
  assert.deepEqual(bullets.map((l) => l.slice('• '.length).split(':')[0]), ['Delivery', 'Drop off', 'Count', 'Cracking', 'On site contact', 'Your contact']);
  for (const l of bullets) assert.ok(/^• [A-Z][a-z ]+: \S/.test(l), l);
  const deliveryLine = full.body.split('\n').find((l) => l.startsWith('• Delivery:'));
  assert.equal(deliveryLine, DELIVERY_KNOWN);
  assert.ok(deliveryLine.slice('•'.length).trim().toLowerCase().startsWith('delivery:'), 'the Delivery bullet keeps its label shape once the bullet is stripped');
  assert.equal(full.body.split('\n').filter((l) => /^delivery:/i.test(l)).length, 0, 'no bare Delivery line without the bullet');
  // The bullets sit as one block between two blank lines (one <ul>).
  assert.ok(full.body.includes('\n\n' + bullets.join('\n') + '\n\n'));
  // The picture hook (the fix of 2026-09-18): the droplet puts the picture
  // UNDER the facts, right after the paragraph that starts "We brand and
  // box" and the blank line beneath it, so "(picture below)" on the Count
  // bullet is true. That paragraph must keep its opening words, sit as a
  // plain line (never a bullet) AFTER the bullets, and be followed by a
  // blank line, in case A and in case B alike.
  const PREP_LINE = 'We brand and box on Friday, September 18, the day before, so changes need to reach us by Wednesday, September 16.';
  const lines = full.body.split('\n');
  const prepAt = lines.findIndex((l) => l.toLowerCase().startsWith('we brand and box'));
  assert.equal(lines[prepAt], PREP_LINE);
  assert.ok(prepAt > lines.lastIndexOf(bullets[bullets.length - 1]), 'the picture hook paragraph comes after the bullets');
  assert.equal(lines[prepAt + 1], '', 'a blank line under the hook paragraph, then the picture');
  assert.equal(lines.filter((l) => /we brand and box/i.test(l)).length, 1, 'exactly one hook paragraph');
  assert.ok(full.body.indexOf('(picture below)') < full.body.indexOf(PREP_LINE), 'the promise reads above where the picture goes');
  const askBoth = reconfirmTemplate(reconfirmFacts(order({ delivery_request: null })), OPTS).body;
  assert.ok(askBoth.includes('\n\n' + PREP_LINE + '\n\n'), 'case B keeps the same hook paragraph');
  // Case B, time only: the one-thing ask, the Delivery bullet asks, the
  // contact bullet stays, the second paragraph stays, no clock time anywhere.
  const noTime = reconfirmTemplate(reconfirmFacts(order({ delivery_request: { ...order().delivery_request, window: null } })), OPTS).body;
  assert.equal(noTime, FULL_BODY
    .replace(CASE_A_OPENER, 'Just sending the final details for reconfirmation. One thing we still need: what time our driver should arrive. Once we have that, we are set.')
    .replace(DELIVERY_KNOWN, DELIVERY_ASK));
  assert.ok(!/\d{1,2}:\d{2}/.test(noTime), 'no example clock time');
  assert.ok(noTime.includes(CONTACT_KNOWN) && noTime.includes('\nWe brand and box on Friday, September 18, the day before, so changes need to reach us by Wednesday, September 16.\n'));
  // Case B, contact only.
  const noContact = reconfirmTemplate(reconfirmFacts(order({ delivery_request: { ...order().delivery_request, contact_name: null, contact_phone: null } })), OPTS).body;
  assert.equal(noContact, FULL_BODY
    .replace(CASE_A_OPENER, 'Just sending the final details for reconfirmation. One thing we still need: who our driver should call on site. Once we have a name and cell, we are set.')
    .replace(CONTACT_KNOWN, CONTACT_ASK));
  assert.ok(noContact.includes(DELIVERY_KNOWN));
  // Case B, both missing: the two-things ask and both bullets ask.
  const both = reconfirmTemplate(reconfirmFacts(order({ delivery_request: null })), OPTS).body;
  assert.equal(both, FULL_BODY
    .replace(CASE_A_OPENER, 'Just sending the final details for reconfirmation. Two things we still need: what time our driver should arrive and who they should call on site. Once we have those two items, we are set.')
    .replace(DELIVERY_KNOWN, DELIVERY_ASK)
    .replace(CONTACT_KNOWN, CONTACT_ASK));
  // Case B never asks for a "confirmed" and never names the customer's own
  // phone as the site contact.
  for (const body of [noTime, noContact, both]) {
    assert.ok(!/confirmed/.test(body));
    assert.ok(!body.includes('(631) 555-0177'));
  }
  // The run-of-show sentence is gone (removed 2026-09-18).
  for (const body of [full.body, noTime, noContact, both]) assert.ok(!/run of show|vendor timeline/i.test(body));
  // Cracking variants.
  const mixed = reconfirmTemplate(reconfirmFacts(order({ invoice_fulfillment: { ...order().invoice_fulfillment, cracking: 'mixed', cracking_note: 'Cocktail cut on 60 of 100 coconuts; straw hole on the other 40.' } })), { ownerCell: CELL, picture: {} }).body;
  assert.ok(mixed.includes('\n• Cracking: 60 cocktail cut, 40 straw hole pre-cracked.\n'));
  // The invoice reader says 'review' for a whole request; the ticked whole box then prints.
  assert.ok(reconfirmTemplate(reconfirmFacts(order({ crack_type: 'whole', invoice_fulfillment: { ...order().invoice_fulfillment, cracking: 'review', cracking_note: 'Invoice requests whole or unopened coconuts.' } })), { ownerCell: CELL, picture: {} }).body.includes('\n• Cracking: whole, unopened.\n'));
  // Branding (decided 2026-09-14): the picture alone decides the Count
  // line. A logo file on file (an approved preview or a png/jpeg logo_url,
  // the same rule as reconfirmPicture) -> "custom branded coconuts (picture
  // below)" and the picture rides along; no picture -> plain "coconuts", no
  // picture, no logo sentence, no branding line, whatever logo_received
  // says (it is a boolean column and no value means plain coconuts). The
  // owner sees "no image" on the row instead; the customer is never asked
  // for a logo.
  const plainLines = '\n• Drop off: Pridwin Hotel, 81 Shore Rd, Shelter Island, NY 11964\n• Count: 100 coconuts\n• Cracking: straw hole pre-cracked, ready for straws\n• On site contact: Ana, (631) 555-0100\n';
  const noPicture = (extra) => reconfirmTemplate(reconfirmFacts(order({ logo_url: null, logo_received: false, ...extra })), { ownerCell: CELL, picture: null }).body;
  const plain = noPicture({});
  for (const body of [plain, noPicture({ logo_received: null }), noPicture({ logo_received: true }), noPicture({ logo_url: 'https://files.example.invalid/logo.ai' }), noPicture({ logo_received: 'unbranded' }), noPicture({ logo_asset: { status: 'needs_review', files: [] } })]) {
    assert.ok(body.includes(plainLines), body);
    assert.ok(!/logo|branding|branded|stamp|picture/i.test(body), 'no logo sentence, no branding line, no picture word, no ask');
  }
  // With the picture: the branded count, and still no logo sentence.
  const branded = reconfirmTemplate(reconfirmFacts(order({ logo_received: false })), { ownerCell: CELL, picture: reconfirmPicture(order()) }).body;
  assert.ok(branded.includes('\n• Count: 100 custom branded coconuts (picture below)\n• Cracking: straw hole pre-cracked, ready for straws\n• On site contact: Ana, (631) 555-0100\n'));
  assert.ok(!/logo|branding|stamp/i.test(branded));
  // The draft's own picture choice drives it end to end: an approved
  // preview or a png/jpeg logo_url brands, a .ai logo or nothing does not.
  const approved = { status: 'approved', files: [{ file_name: 'front.png', preview_path: 'o/front-preview.png', usage: 'Coconut front' }] };
  const countLine = (o) => reconfirmTemplate(reconfirmFacts(o), { ownerCell: CELL, picture: reconfirmPicture(o) }).body.match(/\n• Count: [^\n]+\n/)[0];
  assert.equal(countLine(order()), '\n• Count: 100 custom branded coconuts (picture below)\n');
  assert.equal(countLine(order({ logo_url: null, logo_received: false, logo_asset: approved })), '\n• Count: 100 custom branded coconuts (picture below)\n');
  assert.equal(countLine(order({ logo_url: 'https://files.example.invalid/logos/rivera.JPG?x=1' })), '\n• Count: 100 custom branded coconuts (picture below)\n');
  assert.equal(countLine(order({ logo_url: 'https://files.example.invalid/logos/rivera.ai', logo_received: true })), '\n• Count: 100 coconuts\n');
  assert.equal(countLine(order({ logo_url: null, logo_received: true })), '\n• Count: 100 coconuts\n');
  assert.equal(countLine(order({ logo_url: null, logo_asset: { ...approved, status: 'needs_review' } })), '\n• Count: 100 coconuts\n');
  // Paid in full: no invoice line. Deposit paid (balance still owed): the
  // link, whatever the received cents say. Balance open with no link: no
  // line either (never an amount).
  const paid = reconfirmTemplate(reconfirmFacts(order({ stage: 'paid_full', balance_cents: 50000 })), { ownerCell: CELL, picture: {} }).body;
  assert.ok(!/invoice/i.test(paid) && paid.includes('reach us by Wednesday, September 16.\n\nThanks so much,'));
  assert.ok(reconfirmTemplate(reconfirmFacts(order({ stage: 'deposit_paid', balance_cents: 0 })), { ownerCell: CELL, picture: {} }).body.includes('\nInvoice, if you need it: https://connect.intuit.com/pay/abc\n\nThanks so much,'));
  assert.ok(reconfirmTemplate(reconfirmFacts(order({ stage: 'deposit_paid', balance_cents: null })), { ownerCell: CELL, picture: {} }).body.includes('Invoice, if you need it'));
  assert.ok(!/invoice/i.test(reconfirmTemplate(reconfirmFacts(order({ external_invoice_url: null })), { ownerCell: CELL, picture: {} }).body));
  // Gate note rides on the Drop off bullet.
  const gate = reconfirmTemplate(reconfirmFacts(order({ delivery_request: { ...order().delivery_request, location: 'service entrance, gate code 4471' } })), { ownerCell: CELL, picture: {} }).body;
  assert.ok(gate.includes('\n• Drop off: Pridwin Hotel, 81 Shore Rd, Shelter Island, NY 11964, service entrance, gate code 4471\n'));
  // Same customer, two orders on one day, and the resend subject (an
  // updated draft keeps its own subject).
  assert.equal(reconfirmTemplate(reconfirmFacts(order()), { venueWord: 'Pridwin' }).subject, 'Your coconuts for Saturday, September 19 at Pridwin: quick check');
  assert.equal(reconfirmTemplate(reconfirmFacts(order()), { updated: true }).subject, 'Updated details for Saturday, September 19');
  // The reply-by flip: from delivery day minus 3 (the reply-by day itself)
  // on, "by Wednesday, September 16" reads "today" in BOTH places it
  // appears; the day before, the date still prints; without today and
  // deliveryDay the date prints too.
  const late = reconfirmTemplate(reconfirmFacts(order()), { ...OPTS, today: '2026-09-17' }).body;
  assert.equal(late, FULL_BODY.split('by Wednesday, September 16').join('today'));
  assert.ok(late.includes('or reply with any change today.\n') && late.includes('so changes need to reach us today.\n') && !late.includes('September 16'));
  assert.ok(reconfirmTemplate(reconfirmFacts(order()), { ...OPTS, today: '2026-09-16' }).body.includes('reach us today.'));
  assert.ok(reconfirmTemplate(reconfirmFacts(order()), { ...OPTS, today: '2026-09-15' }).body.includes('reach us by Wednesday, September 16.'));
  assert.ok(reconfirmTemplate(reconfirmFacts(order()), { ownerCell: CELL, picture: {} }).body.includes('reach us by Wednesday, September 16.'));
  // Case B late: the second paragraph flips, the ask stays as it is.
  const bothLate = reconfirmTemplate(reconfirmFacts(order({ delivery_request: null })), { ...OPTS, today: '2026-09-17' }).body;
  assert.ok(bothLate.startsWith('Hi Jamie,\n\nJust sending the final details for reconfirmation. Two things we still need: what time our driver should arrive and who they should call on site. Once we have those two items, we are set.\n'));
  assert.ok(bothLate.includes('so changes need to reach us today.\n') && !bothLate.includes('September 16'));
  // Never money, never an email address, never the garage, never crew
  // names or internal notes, never a dash.
  for (const body of [full.body, noPic.body, noCell, noTime, noContact, both, plain, late, bothLate]) {
    assert.ok(!/\$|@|\bgarage\b|Colonia|Auto-synced|Hashim|Jayden/i.test(body));
    assert.ok(!/[–—]/.test(body), 'no dashes');
  }
  pass('template: case A byte for byte with and without the picture, no cell, the bullet shape the droplet renders (the brand-and-box paragraph feeds the picture hook, under the facts), case B time only, contact only and both, no run-of-show line, mixed and whole cracking, the picture alone decides branded versus plain coconuts and there is never a logo sentence, balance, gate note, venue subject, resend subject, the reply-today flip in both places');
}

// ── 7. Push words, stable ids, change notes, quoted text ────────────
{
  const tag = reconfirmTag(order(), null);
  assert.equal(tag, 'Rivera / Pridwin');
  assert.equal(reconfirmTag({ client_name: 'Acme LLC', venue: '12 Main St' }, null), 'Acme / Main');
  assert.equal(reconfirmTag({ client_name: 'Acme LLC', venue: '1245' }, null), 'Acme');
  assert.equal(reconfirmTag({ client_name: 'Jamie O\'Neil', venue: 'sidd@hamptonscoconuts.com $500' }, null), 'O\'Neil');
  // A push body never carries an email or digits: an unsafe surname falls back to 'Unnamed'.
  assert.equal(reconfirmTag({ client_name: 'jamie@example.invalid' }, null), 'Unnamed');
  assert.equal(reconfirmTag({ client_name: '12345', venue: '' }, null), 'Unnamed');
  assert.equal(reconfirmTag({}, null), 'Unnamed');
  const ctx = { tag, day: '2026-09-19', market: 'ny', sendAfter: '2026-09-15T14:00:00.000Z' };
  assert.deepEqual(reconfirmPushTexts('previewed', { ...ctx, sendsItself: true }), { title: 'Reconfirmation: Rivera / Pridwin, Sat Sep 19', body: 'Reconfirmation ready: Rivera / Pridwin, sends Tue 10:00a unless you hold it.' });
  assert.equal(reconfirmPushTexts('previewed', { ...ctx, sendsItself: false }).body, 'Reconfirmation ready: Rivera / Pridwin, needs your Send now.');
  assert.equal(reconfirmPushTexts('previewed', { ...ctx, sendsItself: true, sendAfter: null }).body, 'Reconfirmation ready: Rivera / Pridwin, needs your Send now.');
  assert.equal(reconfirmPushTexts('previewed', { ...ctx, market: 'vegas', sendsItself: true, sendAfter: '2026-09-15T17:00:00.000Z' }).body, 'Reconfirmation ready: Rivera / Pridwin, sends Tue 10:00a unless you hold it.');
  assert.equal(reconfirmPushTexts('reminded', ctx).body, 'Sends at 10:00a unless you hold it.');
  assert.equal(reconfirmPushTexts('held', { ...ctx, reasons: ['count_missing', 'no_email'] }).body, 'Reconfirmation needs details: Rivera / Pridwin, coconut count missing, no usable customer email.');
  assert.equal(reconfirmPushTexts('changed', { ...ctx, note: 'count 100 to 120' }).body, 'Details changed after the reconfirmation went out: count 100 to 120.');
  assert.equal(reconfirmPushTexts('confirmed', ctx).body, 'Rivera / Pridwin confirmed for Sat Sep 19.');
  assert.equal(reconfirmPushTexts('bounced', ctx).body, 'Reconfirmation email bounced: Rivera / Pridwin. Check the customer email on the invoice.');
  assert.equal(reconfirmReasonWords(['owner_hold', 'pending_time_proposal', 'billing_email_only', 'too_many_emails', 'date_unverified', 'address_missing', 'cracking_unknown']),
    'held by you, a Time change? proposal is waiting, only an accounting email on file, more than 4 email addresses, delivery date unverified, drop off address missing, cracking unknown');
  assert.equal(reconfirmReasonWords(['pending_address_proposal']), 'an Address? row is waiting');
  const a = await reconfirmQueueId('previewed', 7, '2026-09-15T14:00:00.000Z');
  assert.equal(a, await reconfirmQueueId('previewed', 7, '2026-09-15T14:00:00.000Z'));
  assert.notEqual(a, await reconfirmQueueId('previewed', 8, '2026-09-15T14:00:00.000Z'));
  assert.notEqual(a, await reconfirmQueueId('held', 7, 'count_missing'));
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  // Change notes name the field, never the value of an address, email or phone.
  const before = reconfirmFacts(order()).source;
  const after = reconfirmFacts(order({ coconuts_qty: 120, client_email: 'new@example.invalid', invoice_fulfillment: { ...order().invoice_fulfillment, address: '2 Other Rd, Montauk, NY 11954' }, delivery_request: { ...order().delivery_request, contact_phone: '(631) 555-0199' } })).source;
  const diff = reconfirmSourceDiff(before, after);
  assert.deepEqual(diff.map((d) => d.key), ['coconuts_qty', 'client_email', 'invoice_fulfillment.address', 'delivery_request.contact_phone']);
  assert.equal(reconfirmChangeNote(diff), 'count 100 to 120, address changed, site contact changed');
  assert.deepEqual(reconfirmSourceDiff(before, { ...before, delivery_notes: '  ' + before.delivery_notes + ' ', client_phone: null }), [{ key: 'client_phone', from: '(631) 555-0177', to: null }]);
  assert.deepEqual(reconfirmSourceDiff(before, JSON.parse(JSON.stringify(before))), []);
  assert.equal(reconfirmChangeNote(reconfirmSourceDiff(before, { ...before, delivery_at_utc: '2026-09-20T00:00:00+00:00' })), 'date 2026-09-19 to 2026-09-20');
  assert.equal(reconfirmChangeNote([]), null);
  // Quoted text: '>' lines and everything under a wrote: line go; Outlook's
  // own From/Sent block goes; a forward's block and attachments stay.
  assert.equal(stripQuotedText('Confirmed\n\nOn Tue, Sep 15, 2026 at 10:00 AM Sidd Saxena <sidd@hamptonscoconuts.com> wrote:\n> Hi Jamie,\n> Delivery: Saturday, arriving 3:30 PM'), 'Confirmed\n');
  assert.equal(stripQuotedText('Yes\n> On Sep 15, 2026, at 10:00 AM, Sidd wrote:\n>\n> Delivery: 3:30 PM\nnot quoted'), 'Yes\nnot quoted');
  assert.equal(stripQuotedText('Looks good.\n\n________________________________\nFrom: Sidd Saxena <sidd@hamptonscoconuts.com>\nSent: Tuesday, September 15, 2026 10:00 AM\nTo: Jamie\nSubject: Your coconuts\n\nHi Jamie,'), 'Looks good.\n\n________________________________');
  assert.equal(stripQuotedText('FYI\n\nFrom: Planner <planner@example.invalid>\nSent: Monday\n\nArrival 2:00 PM'), 'FYI\n\nFrom: Planner <planner@example.invalid>\nSent: Monday\n\nArrival 2:00 PM');
  assert.equal(stripQuotedText('On Mon, Sep 14, 2026 at 1:24 AM Hamptons Coconuts <sidd@hamptonscoconuts.com>\nwrote:\n> old'), '');
  assert.equal(stripQuotedText('On site vendor arrival at 2:00 PM\n> quoted'), 'On site vendor arrival at 2:00 PM');
  assert.equal(stripQuotedText('Thanks\n\nOn Tue, Sep 15, 2026 at 10:00 AM Sidd wrote:\n> our line 3:30 PM\n\n=== ATTACHMENT: ros.pdf (PDF text, 2 pages) ===\n> 2:00 PM Hamptons Coconuts arrival'), 'Thanks\n\n=== ATTACHMENT: ros.pdf (PDF text, 2 pages) ===\n> 2:00 PM Hamptons Coconuts arrival');
  assert.equal(stripQuotedText('a\r\n> b\r\nc'), 'a\nc');
  pass('push words for every kind (auto, preview, Vegas), stable queue ids, change notes without private values, quoted text stripping incl. Outlook and attachments');
}

// ── 8. The reply classifier ─────────────────────────────────────────
{
  const sig = '\n\nBest,\nJamie Rivera\nEvents Director\nThe Pridwin';
  const quote = '\n\nOn Tue, Sep 15, 2026 at 10:00 AM Sidd Saxena <sidd@hamptonscoconuts.com> wrote:\n> Delivery: Saturday, September 19, arriving 3:30 PM\n> Count: 100 custom branded coconuts';
  const NAME = 'Jamie Rivera';
  const c = (raw, extra = {}) => classifyReconfirmationReply({ subject: 'Re: Your coconuts for Saturday, September 19: quick check', from_addr: 'jamie@example.invalid', raw_text: raw, client_name: NAME, ...extra });
  // A phone-appended footer ('Sent from my iPhone', 'Get Outlook for iOS',
  // a carrier's '5G Device' line) is the phone's, never the customer's
  // words: it is dropped before the digit test, so the confirmation holds.
  for (const t of ['Confirmed', 'confirmed!', 'Confirmed, thanks!\n\nJamie', 'Yes', 'Looks good', 'All good.', 'All set, thank you.\n\nBest,\nJamie Rivera', 'Sounds good', 'Perfect', 'Correct', 'Great, thanks', 'Thank you', 'We are set', 'Good to go', 'Hi Sidd, confirmed. Thanks!', 'CONFIRMED', 'Yes confirmed thanks Sidd', 'Confirmed.\n\nJamie Rivera', 'Confirmed Jamie', 'Perfect, thanks.\n\nJAMIE RIVERA', 'Yes.\n\nThanks,\nJamie',
    'Confirmed\n\nSent from my iPhone', 'Confirmed!\n\nJamie\n\nSent from my iPhone', 'Yes\n\nGet Outlook for iOS', 'Confirmed\n\nSent from Outlook for Android', 'Confirmed\n\nSent from my T-Mobile 5G Device', 'Confirmed.\n\nSent from my iPad', 'Looks good\n\nSent from my Galaxy S24 Ultra', 'Confirmed\nSent from my Verizon Wireless 4G LTE smartphone', 'Yes\n\nSent via the Samsung Galaxy S23']) {
    assert.equal(c(t + quote).kind, 'confirmed', t);
    assert.equal(isPlainConfirmation(t, NAME), true, t);
  }
  // Digits refuse the list, a question refuses it, a change word refuses it, an empty reply is not a confirmation.
  // A device footer with words after it, or an answer around it, is content; a footer alone says nothing.
  // A customer typing on the footer line itself without punctuation
  // ('Sent from my iPhone please arrive at noon', 'Sent from my iPhone
  // noon') is content too: after the device name the footer is a fixed
  // vocabulary (a token with a digit, a device, carrier or typo-excuse
  // word), never free text, so 'noon', 'gate b', 'loading dock' and
  // 'friday' on that line keep it, with or without a change word.
  for (const t of ['Confirmed, see you at 3:30', 'Confirmed but 120 please', 'Confirmed?', 'Confirmed, but please change the address', 'Yes, cancel the order', 'Yes, come to the back', 'Looks good, can we do four instead', 'No problem, confirmed', 'Yes we moved venues', '', 'Jamie', 'confirmed and also we need more coconuts and a later time and a new address',
    'Sent from my iPhone. Please arrive at noon', 'Confirmed\n\nSent from my iPhone\nNoon', 'Yes. Noon\n\nSent from my iPhone', 'Sent from my iPhone', 'Confirmed\n\nSent from my iPhone, the gate code is on the invoice',
    'Confirmed\nSent from my iPhone please arrive at noon', 'Confirmed\nSent from my iPhone we moved venues',
    'Confirmed\nSent from my iPhone noon', 'Confirmed\nSent from my iPhone gate b', 'Yes\nSent from my iPhone loading dock', 'Confirmed\nSent from my iPhone friday']) {
    assert.equal(isPlainConfirmation(t, NAME), false, JSON.stringify(t));
  }
  for (const t of ['Sent from my iPhone. Please arrive at noon', 'Confirmed\n\nSent from my iPhone\nNoon', 'Sent from my iPhone', 'Confirmed\nSent from my iPhone please arrive at noon', 'Confirmed\nSent from my iPhone we moved venues',
    'Confirmed\nSent from my iPhone noon', 'Confirmed\nSent from my iPhone gate b', 'Yes\nSent from my iPhone loading dock', 'Confirmed\nSent from my iPhone friday']) {
    assert.equal(c(t + quote).kind, 'changed', t);
  }
  // The carrier and app footers still drop (no change word on them).
  for (const t of ['Confirmed\nSent from my phone so excuse typos', 'Confirmed\nSent from my T-Mobile 5G Device', 'Confirmed\nSent from my Verizon Wireless 4G LTE smartphone']) {
    assert.equal(isPlainConfirmation(t, NAME), true, JSON.stringify(t));
  }
  // A signature may carry ONLY the customer's own name words, sign-off
  // words and Sidd, never any other word, not even under the name line.
  // 'Yes. Noon' answers the email's own time question, 'Yes / Jamie Rivera
  // / Noon' buries the same answer under the name, and a title or company
  // line ('Events Director', 'The Pridwin') is content too: each is a
  // change card, never a confirmation (one extra card beats a lost time).
  for (const t of ['Yes. Noon', 'Confirmed. NOON', 'Confirmed. Four PM', 'Yes. Loading Dock', 'Perfect. Gate B', 'Yes, Side Entrance', 'Confirmed, Tuesday', 'Yes. Friday', 'Confirmed. Morning', 'Looks good. Ask For Maria', 'Yes. Sarah Will Meet You', 'Confirmed. Noon. Jamie Rivera', 'Confirmed.\n\nEvents Director\nThe Pridwin', 'Confirmed. Jamie Rivera. come to the back', 'Confirmed.\n\nJamie Rivera\nEvents Director\nThe Pridwin\nShelter Island\nNew York',
    'Yes.\n\nJamie Rivera\nNoon', 'Confirmed\nJamie\nGate B', 'Confirmed\nJamie\nNOON', 'Yes\nJamie Rivera\nLoading Dock', 'Confirmed.\n\nJamie Rivera\nEvents Director\nThe Pridwin', 'Confirmed.\n\nJamie Rivera\nEvents Director', 'All set, thank you.' + sig, 'Thanks!\n\nBest,\nJamie Rivera\nThe Pridwin', 'Yes\nJamie\nFriday']) {
    assert.equal(isPlainConfirmation(t, NAME), false, JSON.stringify(t));
    assert.equal(c(t + quote).kind, 'changed', t);
  }
  // Without the customer's name only 'Sidd' is a known signature word.
  assert.equal(isPlainConfirmation('Confirmed, thanks!\n\nJamie'), false);
  assert.equal(isPlainConfirmation('Confirmed, thanks Sidd'), true);
  // A company customer: the reply is signed by a person the name does not carry, so it goes to the owner.
  assert.equal(isPlainConfirmation('Confirmed.\n\nJamie', 'The Maidstone'), false);
  assert.equal(isPlainConfirmation('Confirmed.\n\nThe Maidstone', 'The Maidstone'), true);
  // An attachment is content (a logo, a run of show): never a plain confirmation.
  assert.equal(c('Thanks!' + quote + '\n\n=== ATTACHMENT: logo.png (image, 240 KB) ===\n').kind, 'changed');
  assert.equal(c('Confirmed\n\n=== ATTACHMENT: notes.pdf (PDF text, 1 page) ===\nSee you Saturday.').kind, 'changed');
  // A clock time with no delivery word on its line is not a proposal (the
  // scanner's own rule), so it goes to the owner as a change card instead.
  assert.equal(c('Confirmed, see you at 3:30 PM' + quote).kind, 'changed');
  assert.equal(c('Confirmed, please arrive at 3:30 PM' + quote).kind, 'time');
  assert.equal(c('Can we do 4:00 PM for the coconut delivery instead?' + quote).kind, 'time');
  assert.deepEqual(c('Can we do 4:00 PM for the coconut delivery instead?' + quote).times.map((t) => t.hh), [16]);
  // Our own quoted 3:30 PM line is never the answer: with nothing new it is a change, not a time.
  assert.equal(c('Please make it 120 coconuts' + quote).kind, 'changed');
  assert.equal(c('Who is driving?' + quote).kind, 'changed');
  assert.equal(c(quote).kind, 'changed');
  assert.equal(c('Confirmed' + quote + '\n\n=== ATTACHMENT: Run of Show.pdf (PDF text, 3 pages) ===\n2:00 PM Hamptons Coconuts arrival').kind, 'time');
  assert.equal(c('I am out of the office until Monday with limited access to email.').kind, 'auto_reply');
  assert.equal(c('Thank you for your email. I am currently out of the office until Monday.').kind, 'auto_reply');
  assert.equal(c("I'll be away from my desk until Thursday.\n\nFor urgent matters call the front desk.").kind, 'auto_reply');
  assert.equal(c('Confirmed', { subject: 'Automatic reply: Your coconuts for Saturday, September 19: quick check' }).kind, 'auto_reply');
  // A human reply that mentions the office deeper in the body is content: the site contact it gives must reach the owner.
  assert.equal(c('Hi Sidd, I will be out of the office that day, so please call my assistant Maria on arrival instead. Thanks' + quote).kind, 'changed');
  assert.equal(c('Looks good. Note I am out of the office Friday, Ana will meet you.' + quote).kind, 'changed');
  // A human reply that OPENS with the office line and then goes on with
  // the job (a site contact, a drop-off instruction) is content too: the
  // greeting alone must never decide. A real auto reply says when the
  // sender is back or how little access they have, or stops after the
  // announcement.
  for (const t of ['I will be out of the office that day, please call Maria at the gate.', "I'll be out of the office on Saturday, my colleague Dana will receive the delivery.", 'We are out of the office Saturday so please leave the boxes with security.']) assert.equal(c(t + quote).kind, 'changed', t);
  for (const t of ['I am out of the office.', 'I am out of the office', "I'm out of the office right now. I'll get back to you as soon as I can.", 'I am out of the office and will have limited access to email.', 'I am out of the office from September 14 through September 21.', 'I will be out of the office beginning Friday, returning Monday.']) assert.equal(c(t).kind, 'auto_reply', t);
  assert.equal(c('Delivery has failed to these recipients', { from_addr: 'postmaster@example.invalid', subject: 'Undeliverable: Your coconuts for Saturday, September 19: quick check' }).kind, 'bounced');
  assert.equal(c('x', { from_addr: 'Mail Delivery System <MAILER-DAEMON@example.invalid>', subject: 'Re: whatever' }).kind, 'bounced');
  assert.equal(c('Confirmed').stripped, 'Confirmed');
  pass('reply classifier: every confirmation phrase (with greeting, a name-only signature and our quoted email), digits, questions, change words and any non-name word (a title line or an answer under the name included) refuse the list, attachments are content, time, changed, auto reply by subject or opening line only, bounce');
}

// ── 9. Mode off does nothing ────────────────────────────────────────
{
  const { h, counts } = await scanAt(MON_0805, ENV_OFF, { orders: [order()] });
  assert.equal(counts.mode, 'off'); assert.equal(counts.drafted, 0);
  assert.equal(h.reads('order_reconfirmations').length, 0); assert.equal(h.reads('orders').length, 0);
  assert.equal(h.all().length, 0); assert.equal(h.pushes().length, 0);
  // The intake nag scan still ran first (its one read).
  assert.equal(h.reads('intake_messages').length, 2);
  const r = await replyScanAt(MON_0805, ENV_OFF, { rows: [{ id: 1, order_id: ORDER_ID, delivery_day: '2026-09-19', status: 'sent', recipients: ['jamie@example.invalid'] }], intakes: [{ id: 5, order_id: ORDER_ID, from_addr: 'jamie@example.invalid', subject: 'Re: x', raw_text: 'Confirmed' }] });
  assert.equal(r.result.counts.seen, 0); assert.equal(r.h.calls.length, 0); assert.equal(r.h.intakes.get(5).status, 'pending_review');
  const d = harness({ rows: [{ id: 1, order_id: ORDER_ID, delivery_day: '2026-09-19', status: 'held', hold_reasons: ['count_missing'] }] });
  try { assert.deepEqual(await at(MON_0805, () => buildReconfirmationDigestLines(ENV_OFF)), []); } finally { d.restore(); }
  assert.equal(d.calls.length, 0);
  pass('mode off: the hourly scan, the reply step and the digest line all return at once and read nothing (the intake nags still run)');
}

// ── 10. Monday 08:05 ET, minus 5: the first draft and the preview push ─
{
  const { h, counts } = await scanAt(MON_0805, ENV_AUTO, { orders: [order()] });
  assert.equal(counts.drafted, 1); assert.equal(counts.held, 0);
  const row = h.all()[0];
  assert.equal(row.status, 'ready'); assert.deepEqual(row.hold_reasons, []); assert.equal(row.mode, 'auto');
  assert.equal(row.order_id, ORDER_ID); assert.equal(row.delivery_day, '2026-09-19');
  assert.equal(row.send_after, '2026-09-15T14:00:00.000Z');
  assert.equal(row.subject, FULL_SUBJECT);
  assert.equal(row.body, FULL_BODY);
  assert.deepEqual(row.recipients, ['jamie@example.invalid']);
  assert.deepEqual(row.picture, { source: 'logo_url', bucket: null, path: 'https://files.example.invalid/logos/rivera.png', content_type: 'image/png' });
  assert.equal(row.facts.source.coconuts_qty, 100); assert.equal(row.facts.derived.window_words, '3:30 PM');
  assert.strictEqual(row.facts.source.logo_received, true, 'the boolean column is stored as a boolean, never the text true');
  assert.equal(row.previewed_at, '2026-09-14T12:05:00.000Z');
  assert.equal(row.test_to, null);
  const posts = h.pushes();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].id, await reconfirmQueueId('previewed', row.id, row.send_after));
  assert.equal(posts[0].payload.aps.alert.title, 'Reconfirmation: Rivera / Pridwin, Sat Sep 19');
  assert.equal(posts[0].payload.aps.alert.body, 'Reconfirmation ready: Rivera / Pridwin, sends Tue 10:00a unless you hold it.');
  assert.deepEqual(posts[0].payload.tokens, ['owner-token']);
  assert.equal(posts[0].payload.body.kind, 'reconfirm_previewed'); assert.equal(posts[0].payload.body.order_id, ORDER_ID); assert.equal(posts[0].payload.body.reconfirmation_id, row.id);
  assert.equal(posts[0].payload.headers.collapse_id, 'reconfirm-' + row.id);
  assert.ok(!/@|\$|\d{3}[-.)\s]\d{3}/.test(posts[0].payload.aps.alert.body), 'no email, phone or dollar in a push');
  // The orders read is paged and filtered, and the proposals table was consulted.
  const orderRead = h.reads('orders')[0].url;
  assert.ok(orderRead.includes('offset=0&limit=1000') && orderRead.includes('stage=in.(invoiced,deposit_paid,paid_full)') && orderRead.includes('external_invoice_id=not.is.null') && orderRead.includes('is_recurring=not.is.true'));
  assert.equal(h.reads('order_time_proposals').length, 1);
  // The same tick again: the active row blocks a second draft, the push id repeats (a no-op on the queue).
  const again = await scanAt('2026-09-14T13:05:00Z', ENV_AUTO, { orders: [order()], rows: h.all() });
  assert.equal(again.counts.drafted, 0); assert.equal(again.h.all().length, 1); assert.equal(again.h.pushes().length, 0);
  // Preview mode: same draft, the push says Send now.
  const preview = await scanAt(MON_0805, ENV_PREVIEW, { orders: [order()] });
  assert.equal(preview.h.all()[0].mode, 'preview'); assert.equal(preview.h.all()[0].send_after, '2026-09-15T14:00:00.000Z');
  assert.equal(preview.h.pushes()[0].payload.aps.alert.body, 'Reconfirmation ready: Rivera / Pridwin, needs your Send now.');
  // Out of hours (07:05 ET) nothing is drafted; Vegas at 05:05 PT waits too.
  const early = await scanAt('2026-09-14T11:05:00Z', ENV_AUTO, { orders: [order(), order({ id: ORDER_2, market: 'vegas' })] });
  assert.equal(early.counts.drafted, 0); assert.equal(early.h.all().length, 0);
  const vegasLater = await scanAt('2026-09-14T15:05:00Z', ENV_AUTO, { orders: [order({ id: ORDER_2, market: 'vegas' })] });
  assert.equal(vegasLater.counts.drafted, 1); assert.equal(vegasLater.h.all()[0].send_after, '2026-09-15T17:00:00.000Z');
  // Phase A: RECONFIRM_TEST_TO is stamped into test_to on insert and on
  // every rewrite, and cleared by the next rewrite once the setting is gone.
  const ENV_TEST = { ...ENV_AUTO, RECONFIRM_TEST_TO: ' sidd.test@example.invalid ' };
  const testDraft = await scanAt(MON_0805, ENV_TEST, { orders: [order()] });
  assert.equal(testDraft.h.all()[0].test_to, 'sidd.test@example.invalid');
  assert.deepEqual(testDraft.h.all()[0].recipients, ['jamie@example.invalid'], 'the real recipients stay on the row');
  const testRewrite = await scanAt('2026-09-14T13:05:00Z', ENV_TEST, { orders: [order({ coconuts_qty: 120 })], rows: h.all() });
  assert.equal(testRewrite.h.all()[0].test_to, 'sidd.test@example.invalid');
  const testFlip = await scanAt('2026-09-14T13:05:00Z', ENV_TEST, { orders: [order()], rows: h.all() });
  assert.equal(testFlip.counts.rewritten, 1, 'a new test address alone rewrites the row'); assert.equal(testFlip.h.all()[0].test_to, 'sidd.test@example.invalid');
  assert.equal(testFlip.h.pushes().length, 0, 'no fresh preview when only the test address moved');
  const testGone = await scanAt('2026-09-14T14:05:00Z', ENV_AUTO, { orders: [order()], rows: testFlip.h.all() });
  assert.equal(testGone.h.all()[0].test_to, null);
  // A null balance stays null in the stored facts (never 0).
  const nullBalance = await scanAt(MON_0805, ENV_AUTO, { orders: [order({ balance_cents: null })] });
  assert.equal(nullBalance.counts.drafted, 1); assert.equal(nullBalance.h.all()[0].facts.source.balance_cents, null);
  assert.ok(nullBalance.h.all()[0].body.includes('Invoice, if you need it'));
  // Minus 1 and the day itself: the row is created ready with no
  // send_after (Send now only) and the preview says so; auto mode never
  // releases it.
  const minus1 = await scanAt('2026-09-18T15:05:00Z', ENV_AUTO, { orders: [order()] });
  assert.equal(minus1.counts.drafted, 1); assert.equal(minus1.h.all()[0].status, 'ready'); assert.equal(minus1.h.all()[0].send_after, null);
  assert.equal(minus1.h.pushes()[0].payload.aps.alert.body, 'Reconfirmation ready: Rivera / Pridwin, needs your Send now.');
  assert.ok(minus1.h.all()[0].body.includes('or reply with any change today.') && minus1.h.all()[0].body.includes('so changes need to reach us today.'));
  const minus1Again = await scanAt('2026-09-18T16:05:00Z', ENV_AUTO, { orders: [order()], rows: minus1.h.all() });
  assert.equal(minus1Again.counts.released, 0); assert.equal(minus1Again.h.all()[0].status, 'ready'); assert.equal(minus1Again.h.pushes().length, 0);
  const dayOf = await scanAt('2026-09-19T15:05:00Z', ENV_AUTO, { orders: [order()] });
  assert.equal(dayOf.counts.drafted, 1); assert.equal(dayOf.h.all()[0].send_after, null); assert.equal(dayOf.h.all()[0].status, 'ready');
  const dayAfter = await scanAt('2026-09-20T15:05:00Z', ENV_AUTO, { orders: [order()] });
  assert.equal(dayAfter.counts.drafted, 0); assert.equal(dayAfter.h.all().length, 0);
  // Not eligible: nothing drafted, nothing pushed. The fourth order is the
  // hand-set deposit_paid stage with nothing recorded: a stage alone never
  // qualifies.
  const none = await scanAt(MON_0805, ENV_AUTO, { orders: [order({ stage: 'invoiced', deposit_cents: 0, balance_cents: 0 }), order({ id: ORDER_2, is_recurring: true }), order({ id: ORDER_3, delivery_at_utc: '2026-09-25T00:00:00+00:00' }), order({ id: '77777777-7777-4777-8777-777777777777', stage: 'deposit_paid', deposit_cents: 0, balance_cents: null })] });
  assert.equal(none.counts.drafted, 0); assert.equal(none.h.all().length, 0); assert.equal(none.h.pushes().length, 0);
  // A 409 on insert (two ticks raced) is a skip, never a crash or a push.
  const raced = harness({ orders: [order()] });
  try {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (u, o) => (String(u).endsWith('/rest/v1/order_reconfirmations') && (o || {}).method === 'POST') ? reply(409, {}) : realFetch(u, o);
    const counts = await at(MON_0805, () => runReconfirmationScan(ENV_AUTO));
    assert.equal(counts.skipped, 1); assert.equal(counts.failed, 0); assert.equal(raced.pushes().length, 0);
  } finally { raced.restore(); }
  // Missing table (044 not applied): nothing done, nothing thrown.
  const missing = await scanAt(MON_0805, ENV_AUTO, { orders: [order()], tableMissing: true });
  assert.equal(missing.counts.drafted, 0); assert.equal(missing.h.reads('orders').length, 0);
  pass('minus 5 at 08:05: one ready row with the exact email, recipients, picture, facts and send_after; one owner push with a stable id; repeat is a no-op; preview wording; hours; ineligible orders; 409 and missing table are quiet');
}

// ── 11. Holds: held row, one push per reason set, expiry on minus 1 ─
{
  const held = await scanAt(MON_0805, ENV_AUTO, { orders: [order({ coconuts_qty: null, client_email: 'ar@example.invalid' })] });
  const row = held.h.all()[0];
  assert.equal(row.status, 'held'); assert.deepEqual(row.hold_reasons, ['count_missing', 'billing_email_only']); assert.equal(row.send_after, null);
  assert.equal(held.counts.held, 1);
  const p = held.h.pushes();
  assert.equal(p.length, 1);
  assert.equal(p[0].payload.aps.alert.body, 'Reconfirmation needs details: Rivera / Pridwin, coconut count missing, only an accounting email on file.');
  assert.equal(p[0].id, await reconfirmQueueId('held', row.id, 'count_missing,billing_email_only'));
  assert.equal(p[0].payload.body.kind, 'reconfirm_held');
  // The pending proposal hold.
  const prop = await scanAt(MON_0805, ENV_AUTO, { orders: [order()], proposals: [{ order_id: ORDER_ID, status: 'pending' }] });
  assert.deepEqual(prop.h.all()[0].hold_reasons, ['pending_time_proposal']);
  assert.equal(prop.h.pushes()[0].payload.aps.alert.body, 'Reconfirmation needs details: Rivera / Pridwin, a Time change? proposal is waiting.');
  // The pending Address? hold (migration 045): an undecided row holds, and
  // so does an accepted row Jarvis has not finished (queued, applying,
  // failed). An applied row and a kept row do not.
  const addr = await scanAt(MON_0805, ENV_AUTO, { orders: [order()], addressProposals: [{ order_id: ORDER_ID, status: 'pending', apply_status: null }] });
  assert.deepEqual(addr.h.all()[0].hold_reasons, ['pending_address_proposal']);
  assert.equal(addr.h.pushes()[0].payload.aps.alert.body, 'Reconfirmation needs details: Rivera / Pridwin, an Address? row is waiting.');
  for (const applyStatus of ['queued', 'applying', 'failed']) {
    const q = await scanAt(MON_0805, ENV_AUTO, { orders: [order()], addressProposals: [{ order_id: ORDER_ID, status: 'accepted', apply_status: applyStatus }] });
    assert.deepEqual(q.h.all()[0].hold_reasons, ['pending_address_proposal'], applyStatus);
  }
  const applied = await scanAt(MON_0805, ENV_AUTO, { orders: [order()], addressProposals: [{ order_id: ORDER_ID, status: 'accepted', apply_status: 'applied' }, { order_id: ORDER_ID, status: 'kept', apply_status: null }] });
  assert.deepEqual(applied.h.all()[0].hold_reasons, []); assert.equal(applied.h.all()[0].status, 'ready');
  // Before 045 the table answers 404 and nothing is held.
  const no045 = await scanAt(MON_0805, ENV_AUTO, { orders: [order()] });
  assert.deepEqual(no045.h.all()[0].hold_reasons, []);
  // Same reasons next hour: no second push. New reason set: one more push.
  const same = await scanAt('2026-09-14T13:05:00Z', ENV_AUTO, { orders: [order({ coconuts_qty: null, client_email: 'ar@example.invalid' })], rows: held.h.all() });
  assert.equal(same.h.pushes().length, 0); assert.equal(same.counts.rewritten, 0);
  const shifted = await scanAt('2026-09-14T13:05:00Z', ENV_AUTO, { orders: [order({ coconuts_qty: null })], rows: held.h.all() });
  assert.deepEqual(shifted.h.all()[0].hold_reasons, ['count_missing']); assert.equal(shifted.h.all()[0].status, 'held');
  assert.equal(shifted.h.pushes().length, 1); assert.equal(shifted.h.pushes()[0].id, await reconfirmQueueId('held', row.id, 'count_missing'));
  // The fact lands (a count): the row becomes ready, scheduled as if drafted now, previewed.
  const fixed = await scanAt('2026-09-15T18:05:00Z', ENV_AUTO, { orders: [order()], rows: shifted.h.all() }); // Tue 14:05 ET, minus 4
  const ready = fixed.h.all()[0];
  assert.equal(ready.status, 'ready'); assert.deepEqual(ready.hold_reasons, []); assert.equal(ready.send_after, '2026-09-15T21:05:00.000Z');
  assert.equal(ready.body, FULL_BODY); assert.equal(ready.previewed_at, '2026-09-15T18:05:00.000Z');
  assert.equal(fixed.h.pushes()[0].payload.aps.alert.body, 'Reconfirmation ready: Rivera / Pridwin, sends Tue 5:05p unless you hold it.');
  // A ready row that loses a hard fact becomes held (the owner is told once).
  const lost = await scanAt('2026-09-15T19:05:00Z', ENV_AUTO, { orders: [order({ invoice_fulfillment: { ...order().invoice_fulfillment, cracking: 'review' } })], rows: fixed.h.all() });
  assert.equal(lost.h.all()[0].status, 'held'); assert.deepEqual(lost.h.all()[0].hold_reasons, ['cracking_unknown']);
  assert.equal(lost.h.pushes()[0].payload.aps.alert.body, 'Reconfirmation needs details: Rivera / Pridwin, cracking unknown.');
  assert.equal(lost.h.all()[0].send_after, null, 'a ready row that becomes held loses its send clock');
  // The Address? hold on the REWRITE path (the common case: the draft
  // exists days before the address email arrives). A ready row with a send
  // clock plus a pending Address? row comes back held, clock cleared, with
  // one held push naming the row (plan 5a: the draft cannot go out with
  // the old address between the tap and Jarvis's write).
  const addrHold = await scanAt('2026-09-15T19:05:00Z', ENV_AUTO, { orders: [order()], rows: fixed.h.all(), addressProposals: [{ order_id: ORDER_ID, status: 'pending', apply_status: null }] });
  assert.equal(addrHold.h.all()[0].status, 'held'); assert.deepEqual(addrHold.h.all()[0].hold_reasons, ['pending_address_proposal']);
  assert.equal(addrHold.h.all()[0].send_after, null);
  assert.equal(addrHold.h.pushes().length, 1); assert.equal(addrHold.h.pushes()[0].payload.body.kind, 'reconfirm_held');
  assert.equal(addrHold.h.pushes()[0].payload.aps.alert.body, 'Reconfirmation needs details: Rivera / Pridwin, an Address? row is waiting.');
  // Jarvis applied it: the hold lifts to ready with a fresh clock and a preview push.
  const addrLift = await scanAt('2026-09-15T20:05:00Z', ENV_AUTO, { orders: [order()], rows: addrHold.h.all(), addressProposals: [{ order_id: ORDER_ID, status: 'accepted', apply_status: 'applied' }] });
  assert.equal(addrLift.h.all()[0].status, 'ready'); assert.deepEqual(addrLift.h.all()[0].hold_reasons, []);
  assert.equal(addrLift.h.all()[0].send_after, '2026-09-15T23:05:00.000Z', 'scheduled as if drafted now');
  assert.equal(addrLift.h.pushes().length, 1); assert.equal(addrLift.h.pushes()[0].payload.body.kind, 'reconfirm_previewed');
  // Owner hold: the worker never lifts it, never nags about it, but adds
  // and clears its own reasons beside it (a fact change rewrites the text).
  const ownerHeld = { ...fixed.h.all()[0], status: 'held', hold_reasons: ['owner_hold'], decision: 'hold' };
  const kept = await scanAt('2026-09-15T19:05:00Z', ENV_AUTO, { orders: [order()], rows: [ownerHeld] });
  assert.equal(kept.h.all()[0].status, 'held'); assert.deepEqual(kept.h.all()[0].hold_reasons, ['owner_hold']); assert.equal(kept.h.pushes().length, 0);
  assert.equal(kept.h.calls.filter((c) => c.method === 'PATCH').length, 0);
  const ownerEdit = await scanAt('2026-09-15T19:05:00Z', ENV_AUTO, { orders: [order({ coconuts_qty: 110 })], rows: [ownerHeld] });
  assert.equal(ownerEdit.h.all()[0].status, 'held'); assert.deepEqual(ownerEdit.h.all()[0].hold_reasons, ['owner_hold']);
  assert.ok(ownerEdit.h.all()[0].body.includes('Count: 110 custom')); assert.equal(ownerEdit.h.pushes().length, 0);
  const ownerPlus = await scanAt('2026-09-15T19:05:00Z', ENV_AUTO, { orders: [order({ coconuts_qty: null })], rows: [ownerHeld] });
  assert.deepEqual(ownerPlus.h.all()[0].hold_reasons, ['owner_hold', 'count_missing']);
  assert.equal(ownerPlus.h.pushes()[0].payload.aps.alert.body, 'Reconfirmation needs details: Rivera / Pridwin, held by you, coconut count missing.');
  // Still held on minus 1: expired.
  const expired = await scanAt('2026-09-18T15:05:00Z', ENV_AUTO, { orders: [order({ coconuts_qty: null })], rows: [{ ...held.h.all()[0], hold_reasons: ['count_missing'] }] });
  assert.equal(expired.h.all()[0].status, 'expired'); assert.equal(expired.counts.expired, 1); assert.ok(expired.h.all()[0].error_detail.startsWith('still held'));
  // The fix lands on minus 1: the facts are recomputed BEFORE the expiry
  // check, so the row becomes ready (Send now only, no send_after) instead.
  const lateFix = await scanAt('2026-09-18T15:05:00Z', ENV_AUTO, { orders: [order()], rows: [{ ...held.h.all()[0], hold_reasons: ['count_missing'] }] });
  assert.equal(lateFix.h.all()[0].status, 'ready'); assert.equal(lateFix.h.all()[0].send_after, null); assert.equal(lateFix.counts.expired, 0);
  assert.equal(lateFix.h.pushes()[0].payload.aps.alert.body, 'Reconfirmation ready: Rivera / Pridwin, needs your Send now.');
  // The owner's own hold on minus 1 expires like any other (the digest names it).
  const ownerLate = await scanAt('2026-09-18T15:05:00Z', ENV_AUTO, { orders: [order()], rows: [{ ...held.h.all()[0], hold_reasons: ['owner_hold'], decision: 'hold' }] });
  assert.equal(ownerLate.h.all()[0].status, 'expired');
  // A cancelled order retires its ready row.
  const cancelled = await scanAt('2026-09-15T15:05:00Z', ENV_AUTO, { orders: [order({ stage: 'cancelled' })], rows: fixed.h.all() });
  assert.equal(cancelled.h.all()[0].status, 'expired'); assert.equal(cancelled.h.all()[0].error_detail, 'order stage cancelled');
  pass('holds: held row with no send_after, one push per distinct reason set, pending proposal, ready when fixed (rescheduled), back to held on a lost fact, owner hold respected, expiry on minus 1 and on cancel');
}

// ── 12. Auto release, the reminder, the daily cap, preview never releases ─
{
  const drafted = (await scanAt(MON_0805, ENV_AUTO, { orders: [order()] })).h.all();
  // Tuesday 09:05 ET: the one-hour reminder.
  const remind = await scanAt('2026-09-15T13:05:00Z', ENV_AUTO, { orders: [order()], rows: drafted });
  assert.equal(remind.counts.reminded, 1); assert.equal(remind.counts.released, 0);
  assert.equal(remind.h.pushes()[0].payload.aps.alert.body, 'Sends at 10:00a unless you hold it.');
  assert.equal(remind.h.pushes()[0].id, await reconfirmQueueId('reminded', drafted[0].id));
  assert.equal(remind.h.all()[0].reminded_at, '2026-09-15T13:05:00.000Z'); assert.equal(remind.h.all()[0].status, 'ready');
  // Tuesday 10:05 ET: released (once), and the release moment is stamped
  // into send_after so the daily cap counts it today.
  const release = await scanAt('2026-09-15T14:05:00Z', ENV_AUTO, { orders: [order()], rows: remind.h.all() });
  assert.equal(release.counts.released, 1); assert.equal(release.h.all()[0].status, 'released'); assert.equal(release.h.pushes().length, 0);
  assert.equal(release.h.all()[0].send_after, '2026-09-15T14:05:00.000Z');
  const patch = release.h.calls.find((c) => c.method === 'PATCH' && c.body.status === 'released');
  assert.ok(patch.url.includes('status=eq.ready'), 'the release PATCH is guarded on ready');
  assert.equal(patch.body.decision, undefined);
  // Preview mode at the same moment: nothing releases, no reminder either.
  const preview = await scanAt('2026-09-15T14:05:00Z', ENV_PREVIEW, { orders: [order()], rows: drafted });
  assert.equal(preview.counts.released, 0); assert.equal(preview.counts.reminded, 0); assert.equal(preview.h.all()[0].status, 'ready'); assert.equal(preview.h.pushes().length, 0);
  // Never on minus 1 or the day, even with send_after long past.
  const tooLate = await scanAt('2026-09-18T14:05:00Z', ENV_AUTO, { orders: [order()], rows: drafted });
  assert.equal(tooLate.counts.released, 0); assert.equal(tooLate.h.all()[0].status, 'ready');
  // Never outside 08:00 to 21:00 market time: a planned time missed by an
  // outage waits for the morning instead of sending at midnight.
  const midnight = await scanAt('2026-09-16T04:05:00Z', ENV_AUTO, { orders: [order()], rows: drafted }); // Wed 00:05 ET
  assert.equal(midnight.counts.released, 0); assert.equal(midnight.h.all()[0].status, 'ready'); assert.equal(midnight.h.all()[0].send_after, '2026-09-15T14:00:00.000Z');
  const evening = await scanAt('2026-09-16T01:05:00Z', ENV_AUTO, { orders: [order()], rows: drafted }); // Tue 21:05 ET
  assert.equal(evening.counts.released, 0);
  const morning = await scanAt('2026-09-16T12:05:00Z', ENV_AUTO, { orders: [order()], rows: drafted }); // Wed 08:05 ET
  assert.equal(morning.counts.released, 1); assert.equal(morning.h.all()[0].send_after, '2026-09-16T12:05:00.000Z');
  // The daily cap per market: two allowed, the third waits; an earlier
  // automatic release today counts, an owner Send now does not, Vegas has
  // its own count (judged at 08:05 PT, inside its own hours).
  const rowFor = (id, orderId, extra = {}) => ({ id, order_id: orderId, delivery_day: '2026-09-19', status: 'ready', send_after: '2026-09-15T14:00:00.000Z', facts: reconfirmFacts(order({ id: orderId })), recipients: ['jamie@example.invalid'], subject: 's', body: 'b', ...extra });
  const ORDER_4 = '44444444-4444-4444-8444-444444444444', ORDER_5 = '55555555-5555-4555-8555-555555555555';
  const capEnv = { ...ENV_AUTO, RECONFIRM_DAILY_CAP: '2' };
  const capped = await scanAt('2026-09-15T15:05:00Z', capEnv, {
    orders: [order(), order({ id: ORDER_2 }), order({ id: ORDER_3 }), order({ id: ORDER_4 }), order({ id: ORDER_5, market: 'vegas' })],
    rows: [rowFor(1, ORDER_ID), rowFor(2, ORDER_2), rowFor(3, ORDER_3), rowFor(4, ORDER_4, { status: 'sent', decision: 'send_now', send_after: '2026-09-15T12:00:00.000Z' }), rowFor(5, ORDER_5, { send_after: '2026-09-15T15:00:00.000Z' })],
  });
  assert.deepEqual(capped.h.all().map((r) => r.status), ['released', 'released', 'ready', 'sent', 'released']);
  assert.equal(capped.counts.released, 3); assert.equal(capped.counts.capped, 1);
  const already = await scanAt('2026-09-15T15:05:00Z', capEnv, {
    orders: [order(), order({ id: ORDER_2 }), order({ id: ORDER_3 })],
    rows: [rowFor(1, ORDER_ID, { status: 'sent', send_after: '2026-09-15T14:00:00.000Z' }), rowFor(2, ORDER_2), rowFor(3, ORDER_3)],
  });
  assert.deepEqual(already.h.all().map((r) => r.status), ['sent', 'released', 'ready']);
  assert.equal(already.counts.capped, 1);
  // The cap holds across ticks even when send_after fell on an earlier day
  // (a mode flip or an outage): the two released at 10:05 carry today's
  // release moment, so 11:05 releases nothing more, and neither does the
  // next morning's 00:05 tick (outside hours) or its 08:05 tick (the day
  // count is now fresh, so two more go).
  const stale = (id, orderId) => rowFor(id, orderId, { send_after: '2026-09-14T14:00:00.000Z' });
  const tick1 = await scanAt('2026-09-15T14:05:00Z', capEnv, { orders: [order(), order({ id: ORDER_2 }), order({ id: ORDER_3 }), order({ id: ORDER_4 })], rows: [stale(1, ORDER_ID), stale(2, ORDER_2), stale(3, ORDER_3), stale(4, ORDER_4)] });
  assert.deepEqual(tick1.h.all().map((r) => r.status), ['released', 'released', 'ready', 'ready']);
  assert.deepEqual(tick1.h.all().slice(0, 2).map((r) => r.send_after), ['2026-09-15T14:05:00.000Z', '2026-09-15T14:05:00.000Z']);
  assert.equal(tick1.counts.released, 2); assert.equal(tick1.counts.capped, 2);
  const tick2 = await scanAt('2026-09-15T15:05:00Z', capEnv, { orders: [order(), order({ id: ORDER_2 }), order({ id: ORDER_3 }), order({ id: ORDER_4 })], rows: tick1.h.all() });
  assert.equal(tick2.counts.released, 0); assert.equal(tick2.counts.capped, 2);
  assert.deepEqual(tick2.h.all().map((r) => r.status), ['released', 'released', 'ready', 'ready']);
  const tick3 = await scanAt('2026-09-16T04:05:00Z', capEnv, { orders: [order(), order({ id: ORDER_2 }), order({ id: ORDER_3 }), order({ id: ORDER_4 })], rows: tick2.h.all() }); // Wed 00:05 ET
  assert.equal(tick3.counts.released, 0);
  const tick4 = await scanAt('2026-09-16T12:05:00Z', capEnv, { orders: [order(), order({ id: ORDER_2 }), order({ id: ORDER_3 }), order({ id: ORDER_4 })], rows: tick3.h.all() }); // Wed 08:05 ET
  assert.equal(tick4.counts.released, 2); assert.deepEqual(tick4.h.all().map((r) => r.status), ['released', 'released', 'released', 'released']);
  // A row the owner held and released by hand (decision 'release') goes out
  // by the worker and counts; only Send now is exempt.
  const byHand = await scanAt('2026-09-15T15:05:00Z', capEnv, {
    orders: [order(), order({ id: ORDER_2 }), order({ id: ORDER_3 })],
    rows: [rowFor(1, ORDER_ID, { status: 'released', decision: 'release', send_after: '2026-09-15T14:05:00.000Z' }), rowFor(2, ORDER_2, { status: 'sent', decision: 'send_now', send_after: '2026-09-15T14:06:00.000Z' }), rowFor(3, ORDER_3)],
  });
  assert.deepEqual(byHand.h.all().map((r) => r.status), ['released', 'sent', 'released']);
  const byHand2 = await scanAt('2026-09-15T16:05:00Z', capEnv, { orders: [order(), order({ id: ORDER_2 }), order({ id: ORDER_3 })], rows: [...byHand.h.all().slice(0, 2), rowFor(3, ORDER_3)] });
  assert.equal(byHand2.counts.released, 1);
  const byHand3 = await scanAt('2026-09-15T16:05:00Z', capEnv, { orders: [order(), order({ id: ORDER_2 }), order({ id: ORDER_3 })], rows: [{ ...byHand.h.all()[0], decision: null }, { ...byHand.h.all()[1], decision: null }, rowFor(3, ORDER_3)] });
  assert.equal(byHand3.counts.released, 0); assert.equal(byHand3.counts.capped, 1);
  // A ready row whose order was cancelled in the meantime is never
  // released, even with send_after long past: it expires instead.
  const cancelled = await scanAt('2026-09-15T15:05:00Z', ENV_AUTO, { orders: [order({ stage: 'cancelled' })], rows: [stale(1, ORDER_ID)] });
  assert.equal(cancelled.counts.released, 0); assert.equal(cancelled.h.all()[0].status, 'expired'); assert.equal(cancelled.h.all()[0].error_detail, 'order stage cancelled');
  assert.ok(!cancelled.h.calls.some((c) => c.method === 'PATCH' && c.body.status === 'released'));
  // The order lost its payment (a refund moved it back to invoiced with no
  // money): the row stays ready and is not released.
  const refunded = await scanAt('2026-09-15T15:05:00Z', ENV_AUTO, { orders: [order({ stage: 'invoiced', deposit_cents: 0, balance_cents: 0 })], rows: [stale(1, ORDER_ID)] });
  assert.equal(refunded.counts.released, 0); assert.equal(refunded.h.all()[0].status, 'ready');
  // A paid stage with nothing recorded (the stage and QuickBooks disagree)
  // is not money received either: the row stays ready, nothing releases.
  const stageOnly = await scanAt('2026-09-15T15:05:00Z', ENV_AUTO, { orders: [order({ stage: 'deposit_paid', deposit_cents: 0, balance_cents: 0 })], rows: [stale(1, ORDER_ID)] });
  assert.equal(stageOnly.counts.released, 0); assert.equal(stageOnly.h.all()[0].status, 'ready');
  assert.ok(!stageOnly.h.calls.some((c) => c.method === 'PATCH' && c.body.status === 'released'));
  // The droplet requeued a row ('facts changed at send time', send_after in
  // the past, stale facts): ONE tick rewrites the body from the fresh facts
  // and releases it again, in that order, so the stale body never ping-pongs
  // between the worker and the droplet. No preview push: it went out.
  const requeued = { ...stale(1, ORDER_ID), send_after: '2026-09-15T14:05:00.000Z', error_detail: 'facts changed at send time', body: 'stale body', facts: reconfirmFacts(order({ coconuts_qty: 90 })) };
  const fixedUp = await scanAt('2026-09-15T15:05:00Z', ENV_AUTO, { orders: [order()], rows: [requeued] });
  assert.equal(fixedUp.counts.rewritten, 1); assert.equal(fixedUp.counts.released, 1);
  assert.equal(fixedUp.h.all()[0].status, 'released'); assert.equal(fixedUp.h.all()[0].body, FULL_BODY); assert.equal(fixedUp.h.all()[0].facts.source.coconuts_qty, 100);
  assert.equal(fixedUp.h.all()[0].send_after, '2026-09-15T15:05:00.000Z');
  const patches = fixedUp.h.calls.filter((c) => c.method === 'PATCH').map((c) => c.body.status);
  assert.deepEqual(patches, ['ready', 'released'], 'rewrite first, release second');
  assert.equal(fixedUp.h.pushes().length, 0);
  // The same requeue in preview mode: rewritten, kept ready, and the owner
  // gets a fresh preview asking for a new Send now.
  const requeuedPreview = await scanAt('2026-09-15T15:05:00Z', ENV_PREVIEW, { orders: [order()], rows: [requeued] });
  assert.equal(requeuedPreview.h.all()[0].status, 'ready'); assert.equal(requeuedPreview.h.all()[0].body, FULL_BODY);
  assert.equal(requeuedPreview.h.pushes().length, 1);
  assert.equal(requeuedPreview.h.pushes()[0].payload.aps.alert.body, 'Reconfirmation ready: Rivera / Pridwin, needs your Send now.');
  assert.equal(requeuedPreview.h.all()[0].previewed_at, '2026-09-15T15:05:00.000Z');
  // The same requeue in auto mode but capped: rewritten, kept ready, and
  // the fresh preview asks for a Send now (the owner's tap is never capped).
  const requeuedCapped = await scanAt('2026-09-15T15:05:00Z', { ...ENV_AUTO, RECONFIRM_DAILY_CAP: '0' }, { orders: [order()], rows: [requeued] });
  assert.equal(requeuedCapped.h.all()[0].status, 'ready'); assert.equal(requeuedCapped.counts.capped, 1);
  assert.equal(requeuedCapped.h.pushes()[0].payload.aps.alert.body, 'Reconfirmation ready: Rivera / Pridwin, needs your Send now.');
  pass('auto: reminder an hour before with a stable id, guarded release once with the moment stamped, preview never releases, never on minus 1 or outside 08:00 to 21:00, the daily cap per market holds across ticks and days and exempts only Send now, a cancelled or refunded order is never released, a requeued row is rewritten then released in one tick');
}

// ── 13. Change detection before and after the send ──────────────────
{
  const drafted = (await scanAt(MON_0805, ENV_AUTO, { orders: [order()] })).h.all();
  // Before the send: the row is rewritten in place, schedule kept, and the
  // owner gets a fresh preview (the draft they saw is gone) under a new
  // stable id; a repeat of the same tick sends nothing more.
  const before = await scanAt('2026-09-14T15:05:00Z', ENV_AUTO, { orders: [order({ coconuts_qty: 120 })], rows: drafted });
  assert.equal(before.counts.rewritten, 1);
  const r = before.h.all()[0];
  assert.equal(r.status, 'ready'); assert.equal(r.send_after, '2026-09-15T14:00:00.000Z');
  assert.ok(r.body.includes('\n• Count: 120 custom branded coconuts (picture below)\n')); assert.equal(r.facts.source.coconuts_qty, 120);
  assert.equal(before.h.pushes().length, 1);
  assert.equal(before.h.pushes()[0].payload.aps.alert.body, 'Reconfirmation ready: Rivera / Pridwin, sends Tue 10:00a unless you hold it.');
  assert.equal(before.h.pushes()[0].id, await reconfirmQueueId('previewed', r.id, r.updated_at));
  assert.notEqual(before.h.pushes()[0].id, await reconfirmQueueId('previewed', r.id, r.send_after), 'a new id, not the first preview');
  assert.equal(r.previewed_at, '2026-09-14T15:05:00.000Z');
  // Nothing changed: nothing written, nothing pushed.
  const still = await scanAt('2026-09-14T16:05:00Z', ENV_AUTO, { orders: [order({ coconuts_qty: 120 })], rows: before.h.all() });
  assert.equal(still.counts.rewritten, 0); assert.equal(still.h.calls.filter((c) => c.method === 'PATCH').length, 0); assert.equal(still.h.pushes().length, 0);
  // Preview mode: the fresh preview asks for a new Send now.
  const beforePreview = await scanAt('2026-09-14T15:05:00Z', ENV_PREVIEW, { orders: [order({ coconuts_qty: 120 })], rows: drafted });
  assert.equal(beforePreview.h.pushes()[0].payload.aps.alert.body, 'Reconfirmation ready: Rivera / Pridwin, needs your Send now.');
  // The customer pays the balance before the send: the row is rewritten
  // and the invoice line drops out of the body (never an amount either way).
  const paidBefore = await scanAt('2026-09-14T15:05:00Z', ENV_AUTO, { orders: [order({ stage: 'paid_full', balance_cents: 50000 })], rows: drafted });
  assert.equal(paidBefore.counts.rewritten, 1); assert.ok(!/invoice/i.test(paidBefore.h.all()[0].body));
  assert.equal(paidBefore.h.pushes().length, 1, 'the body changed, so the owner sees a fresh preview');
  // A received installment landing before the send (balance_cents moves,
  // the stage stays deposit_paid): the facts are rewritten so the
  // droplet's compare stays in step, but the email reads the same word for
  // word, so NO second preview push. The next tick is quiet.
  const balanceOnly = await scanAt('2026-09-14T15:05:00Z', ENV_AUTO, { orders: [order({ balance_cents: 12345 })], rows: drafted });
  assert.equal(balanceOnly.counts.rewritten, 1); assert.equal(balanceOnly.h.pushes().length, 0);
  assert.equal(balanceOnly.h.all()[0].status, 'ready'); assert.equal(balanceOnly.h.all()[0].body, FULL_BODY);
  assert.equal(balanceOnly.h.all()[0].facts.source.balance_cents, 12345); assert.equal(balanceOnly.h.all()[0].send_after, '2026-09-15T14:00:00.000Z');
  assert.equal(balanceOnly.h.all()[0].previewed_at, drafted[0].previewed_at, 'previewed_at is not re-stamped');
  const balanceQuiet = await scanAt('2026-09-14T16:05:00Z', ENV_AUTO, { orders: [order({ balance_cents: 12345 })], rows: balanceOnly.h.all() });
  assert.equal(balanceQuiet.counts.rewritten, 0); assert.equal(balanceQuiet.h.pushes().length, 0);
  // The same in preview mode: no "needs your Send now" repeat for a payment.
  const balancePreview = await scanAt('2026-09-14T15:05:00Z', ENV_PREVIEW, { orders: [order({ balance_cents: 12345 })], rows: drafted });
  assert.equal(balancePreview.counts.rewritten, 1); assert.equal(balancePreview.h.pushes().length, 0);
  // A recipient change with the same body IS something the owner sees.
  const newAddress = await scanAt('2026-09-14T15:05:00Z', ENV_AUTO, { orders: [order({ client_email: 'jamie@example.invalid, ops@example.invalid' })], rows: drafted });
  assert.equal(newAddress.counts.rewritten, 1); assert.equal(newAddress.h.pushes().length, 1);
  assert.deepEqual(newAddress.h.all()[0].recipients, ['jamie@example.invalid', 'ops@example.invalid']);
  // A template change shipped in the worker reaches the drafts that
  // already exist: a ready row still carrying the wording from before
  // 2026-09-18 (same facts, same day, so no diff) is rewritten ONCE to the
  // new text, schedule kept, with a fresh preview (the draft the owner saw
  // is gone). The next tick compares equal and writes nothing, and so does
  // the one after: the template is deterministic for fixed facts and day,
  // so the stored text and the template can never ping-pong.
  const oldWording = { ...drafted[0], subject: OLD_SUBJECT, body: OLD_BODY };
  const reworded = await scanAt('2026-09-14T15:05:00Z', ENV_AUTO, { orders: [order()], rows: [oldWording] });
  assert.equal(reworded.counts.rewritten, 1);
  assert.equal(reworded.h.all()[0].subject, FULL_SUBJECT); assert.equal(reworded.h.all()[0].body, FULL_BODY);
  assert.equal(reworded.h.all()[0].status, 'ready'); assert.equal(reworded.h.all()[0].send_after, '2026-09-15T14:00:00.000Z', 'the schedule is kept');
  assert.equal(reworded.h.pushes().length, 1); assert.equal(reworded.h.pushes()[0].payload.body.kind, 'reconfirm_previewed');
  assert.equal(reworded.h.all()[0].previewed_at, '2026-09-14T15:05:00.000Z');
  const rewordedQuiet = await scanAt('2026-09-14T16:05:00Z', ENV_AUTO, { orders: [order()], rows: reworded.h.all() });
  assert.equal(rewordedQuiet.counts.rewritten, 0); assert.equal(rewordedQuiet.h.calls.filter((c) => c.method === 'PATCH').length, 0); assert.equal(rewordedQuiet.h.pushes().length, 0);
  const rewordedStill = await scanAt('2026-09-14T17:05:00Z', ENV_AUTO, { orders: [order()], rows: rewordedQuiet.h.all() });
  assert.equal(rewordedStill.counts.rewritten, 0); assert.equal(rewordedStill.h.pushes().length, 0);
  // The subject alone moving is enough (the old suffix on the new body).
  const subjectOnly = await scanAt('2026-09-14T15:05:00Z', ENV_AUTO, { orders: [order()], rows: [{ ...drafted[0], subject: OLD_SUBJECT }] });
  assert.equal(subjectOnly.counts.rewritten, 1); assert.equal(subjectOnly.h.all()[0].subject, FULL_SUBJECT); assert.equal(subjectOnly.h.pushes().length, 1);
  // A held row with the old wording is brought level too; it stays held
  // with no clock, and the held push repeats under its stable id (a no-op
  // on the queue, the reasons did not move).
  const heldOld = { ...drafted[0], status: 'held', hold_reasons: ['count_missing'], send_after: null, subject: OLD_SUBJECT, body: OLD_BODY.replace('Count: 100 custom', 'Count:  custom'), facts: reconfirmFacts(order({ coconuts_qty: null })) };
  const heldReworded = await scanAt('2026-09-14T15:05:00Z', ENV_AUTO, { orders: [order({ coconuts_qty: null })], rows: [heldOld] });
  assert.equal(heldReworded.counts.rewritten, 1); assert.equal(heldReworded.h.all()[0].status, 'held'); assert.deepEqual(heldReworded.h.all()[0].hold_reasons, ['count_missing']);
  assert.equal(heldReworded.h.all()[0].subject, FULL_SUBJECT); assert.ok(heldReworded.h.all()[0].body.includes('\n• Count:  custom branded coconuts (picture below)\n')); assert.equal(heldReworded.h.all()[0].send_after, null);
  assert.equal(heldReworded.h.pushes().length, 1); assert.equal(heldReworded.h.pushes()[0].id, await reconfirmQueueId('held', heldOld.id, 'count_missing'));
  const heldQuiet = await scanAt('2026-09-14T16:05:00Z', ENV_AUTO, { orders: [order({ coconuts_qty: null })], rows: heldReworded.h.all() });
  assert.equal(heldQuiet.counts.rewritten, 0); assert.equal(heldQuiet.h.pushes().length, 0);
  // The one dated word: on delivery day minus 3 the stored "by Wednesday,
  // September 16" flips to "today" in both places (one rewrite, one fresh
  // preview), and the next day compares equal again. Preview mode, so the
  // row is not released on top of it.
  const flip = await scanAt('2026-09-16T15:05:00Z', ENV_PREVIEW, { orders: [order()], rows: drafted });
  assert.equal(flip.counts.rewritten, 1); assert.equal(flip.h.all()[0].body, FULL_BODY.split('by Wednesday, September 16').join('today')); assert.equal(flip.h.pushes().length, 1);
  const flipQuiet = await scanAt('2026-09-17T15:05:00Z', ENV_PREVIEW, { orders: [order()], rows: flip.h.all() });
  assert.equal(flipQuiet.counts.rewritten, 0); assert.equal(flipQuiet.h.calls.filter((c) => c.method === 'PATCH').length, 0); assert.equal(flipQuiet.h.pushes().length, 0);
  // After the send: status changed, a note, one push; the next tick is quiet; Done then stays quiet.
  const sent = { ...before.h.all()[0], status: 'sent', sent_at: '2026-09-15T14:06:00.000Z', sent_conversation_id: 'conv-1' };
  const after = await scanAt('2026-09-16T15:05:00Z', ENV_AUTO, { orders: [order({ coconuts_qty: 150, delivery_request: { ...order().delivery_request, window: '4:00 PM' } })], rows: [sent] });
  assert.equal(after.counts.changed, 1);
  const c = after.h.all()[0];
  assert.equal(c.status, 'changed'); assert.equal(c.change_note, 'count 120 to 150, delivery time changed');
  assert.equal(c.body, sent.body, 'the sent body is kept as it went out');
  assert.equal(c.facts.source.coconuts_qty, 150);
  assert.equal(after.h.pushes().length, 1);
  assert.equal(after.h.pushes()[0].payload.aps.alert.body, 'Details changed after the reconfirmation went out: count 120 to 150, delivery time changed.');
  assert.equal(after.h.pushes()[0].id, await reconfirmQueueId('changed', c.id, 'count 120 to 150, delivery time changed'));
  const quiet = await scanAt('2026-09-16T16:05:00Z', ENV_AUTO, { orders: [order({ coconuts_qty: 150, delivery_request: { ...order().delivery_request, window: '4:00 PM' } })], rows: after.h.all() });
  assert.equal(quiet.counts.changed, 0); assert.equal(quiet.h.pushes().length, 0);
  const done = await scanAt('2026-09-16T17:05:00Z', ENV_AUTO, { orders: [order({ coconuts_qty: 150, delivery_request: { ...order().delivery_request, window: '4:00 PM' } })], rows: [{ ...after.h.all()[0], status: 'sent', decision: 'done' }] });
  assert.equal(done.counts.changed, 0); assert.equal(done.h.all()[0].status, 'sent');
  // A payment landing after the send is not a detail change: the balance
  // moves and the stage goes deposit_paid -> paid_full, the facts refresh
  // quietly, the row stays sent (or confirmed), no push, no Resend or Done
  // for nothing. The next tick is then quiet too.
  const paidOrder = order({ coconuts_qty: 120, stage: 'paid_full', balance_cents: 50000 });
  const paid = await scanAt('2026-09-16T15:05:00Z', ENV_AUTO, { orders: [paidOrder], rows: [sent] });
  assert.equal(paid.counts.changed, 0); assert.equal(paid.h.all()[0].status, 'sent'); assert.equal(paid.h.pushes().length, 0);
  assert.equal(paid.h.all()[0].facts.source.stage, 'paid_full'); assert.equal(paid.h.all()[0].facts.source.balance_cents, 50000);
  assert.equal(paid.h.all()[0].change_note, sent.change_note ?? null);
  const paidQuiet = await scanAt('2026-09-16T16:05:00Z', ENV_AUTO, { orders: [paidOrder], rows: paid.h.all() });
  assert.equal(paidQuiet.h.calls.filter((c) => c.method === 'PATCH').length, 0);
  const paidConfirmed = await scanAt('2026-09-16T15:05:00Z', ENV_AUTO, { orders: [order({ coconuts_qty: 120, external_invoice_url: 'https://connect.intuit.com/pay/new' })], rows: [{ ...sent, status: 'confirmed' }] });
  assert.equal(paidConfirmed.h.all()[0].status, 'confirmed'); assert.equal(paidConfirmed.h.pushes().length, 0); assert.equal(paidConfirmed.h.all()[0].facts.source.external_invoice_url, 'https://connect.intuit.com/pay/new');
  // Money plus a real detail still raises the change (the note names the detail first).
  const paidAndCount = await scanAt('2026-09-16T15:05:00Z', ENV_AUTO, { orders: [order({ coconuts_qty: 150, stage: 'paid_full', balance_cents: 50000 })], rows: [sent] });
  assert.equal(paidAndCount.h.all()[0].status, 'changed'); assert.equal(paidAndCount.h.all()[0].change_note, 'count 120 to 150, stage deposit_paid to paid_full, balance changed');
  // A move to cancelled after the send is never money-only.
  const cancelledAfter = await scanAt('2026-09-16T15:05:00Z', ENV_AUTO, { orders: [order({ coconuts_qty: 120, stage: 'cancelled' })], rows: [sent] });
  assert.equal(cancelledAfter.h.all()[0].status, 'changed'); assert.equal(cancelledAfter.h.all()[0].change_note, 'stage deposit_paid to cancelled');
  assert.equal(cancelledAfter.h.pushes()[0].payload.aps.alert.body, 'Details changed after the reconfirmation went out: stage deposit_paid to cancelled.');
  // A confirmed row watches too; a superseded row plus Resend drafts "Updated details".
  const conf = await scanAt('2026-09-16T15:05:00Z', ENV_AUTO, { orders: [order({ coconuts_qty: 121 })], rows: [{ ...sent, status: 'confirmed' }] });
  assert.equal(conf.h.all()[0].status, 'changed'); assert.equal(conf.h.all()[0].change_note, 'count 120 to 121');
  const resend = await scanAt('2026-09-16T15:05:00Z', ENV_AUTO, { orders: [order({ coconuts_qty: 121 })], rows: [{ ...sent, status: 'superseded', decision: 'resend' }] });
  assert.equal(resend.counts.drafted, 1);
  const fresh = resend.h.all().find((x) => x.status === 'ready');
  assert.equal(fresh.subject, 'Updated details for Saturday, September 19'); assert.equal(fresh.send_after, '2026-09-16T18:05:00.000Z');
  // Sent rows for a past delivery day are left alone.
  const past = await scanAt('2026-09-21T15:05:00Z', ENV_AUTO, { orders: [order({ coconuts_qty: 999 })], rows: [sent] });
  assert.equal(past.counts.changed, 0); assert.equal(past.h.all()[0].status, 'sent');
  // The date moves after the send (Sat 19 -> Sun 20): the sent row becomes
  // changed with the date in the note and NO fresh draft is made for the
  // new day until the owner decides. Resend (superseded) then drafts
  // "Updated details for Sunday, September 20"; Done (back to sent) never
  // drafts a second email.
  const moved = order({ coconuts_qty: 120, delivery_at_utc: '2026-09-20T00:00:00+00:00' });
  const dateMove = await scanAt('2026-09-16T15:05:00Z', ENV_AUTO, { orders: [moved], rows: [sent] });
  assert.equal(dateMove.h.all().length, 1); assert.equal(dateMove.counts.drafted, 0);
  assert.equal(dateMove.h.all()[0].status, 'changed'); assert.equal(dateMove.h.all()[0].change_note, 'date 2026-09-19 to 2026-09-20');
  const afterResend = await scanAt('2026-09-16T16:05:00Z', ENV_AUTO, { orders: [moved], rows: [{ ...dateMove.h.all()[0], status: 'superseded', decision: 'resend' }] });
  assert.equal(afterResend.counts.drafted, 1);
  const moving = afterResend.h.all().find((x) => x.status === 'ready');
  assert.equal(moving.delivery_day, '2026-09-20'); assert.equal(moving.subject, 'Updated details for Sunday, September 20');
  assert.ok(moving.body.includes('We are set for Sunday, September 20. Here is what we have on file.'));
  const afterDone = await scanAt('2026-09-16T16:05:00Z', ENV_AUTO, { orders: [moved], rows: [{ ...dateMove.h.all()[0], status: 'sent', decision: 'done' }] });
  assert.equal(afterDone.counts.drafted, 0); assert.equal(afterDone.h.all().length, 1);
  // Done keeps holding after the old day passes: Sat 19 moved to Thu 24,
  // Done tapped on the 16th; on Mon 21 (the old day two days gone, the new
  // day three days out and otherwise eligible) the sent row for the 19th is
  // still read (rows are read from a week back), so NO first-time draft
  // appears for the 24th and nothing auto-sends. The old row is left alone.
  const movedFar = order({ coconuts_qty: 120, delivery_at_utc: '2026-09-24T00:00:00+00:00' });
  const farMove = await scanAt('2026-09-16T15:05:00Z', ENV_AUTO, { orders: [movedFar], rows: [sent] });
  assert.equal(farMove.h.all()[0].status, 'changed'); assert.equal(farMove.h.all()[0].change_note, 'date 2026-09-19 to 2026-09-24');
  const doneRow = { ...farMove.h.all()[0], status: 'sent', decision: 'done' };
  const weekLater = await scanAt('2026-09-21T15:05:00Z', ENV_AUTO, { orders: [movedFar], rows: [doneRow] });
  assert.equal(weekLater.counts.drafted, 0); assert.equal(weekLater.counts.skipped, 1); assert.equal(weekLater.h.all().length, 1);
  assert.equal(weekLater.h.all()[0].status, 'sent'); assert.equal(weekLater.h.calls.filter((c) => c.method === 'PATCH').length, 0); assert.equal(weekLater.h.pushes().length, 0);
  assert.ok(weekLater.h.reads('order_reconfirmations')[0].url.includes('delivery_day=gte.2026-09-14'), 'rows read from a week back');
  assert.ok(weekLater.h.reads('orders')[0].url.includes('delivery_at_utc=gte.2026-09-20T00:00:00Z'), 'the orders read keeps its one-day-back window');
  // The hold lasts while the old row is read: a week after the old day it
  // falls out, and an order still ahead (moved again, to the 30th) gets a
  // first-time draft. Pinned so the lifetime is a fact, not a surprise.
  const movedAgain = order({ coconuts_qty: 120, delivery_at_utc: '2026-09-30T00:00:00+00:00' });
  const weekGone = await scanAt('2026-09-27T15:05:00Z', ENV_AUTO, { orders: [movedAgain], rows: [doneRow] });
  assert.equal(weekGone.counts.drafted, 1); assert.equal(weekGone.h.all().find((x) => x.status === 'ready').delivery_day, '2026-09-30');
  // A rain date: the date moves only AFTER the old day passed (Sat 19 was
  // rained out, moved to Thu 24 on Mon 21). The old sent or confirmed row
  // was never flipped to changed (past-day rows are left alone), the
  // owner never tapped Done on it, so it must not hold: the new day gets
  // a fresh draft at once, and it reads as an update since the customer
  // had the first email. The old row is left as it is. Only a Done row
  // (doneRow above, same instant, drafted 0) holds after the old day.
  const rainRow = { ...sent, status: 'confirmed', decision: null };
  const rain = await scanAt('2026-09-21T15:05:00Z', ENV_AUTO, { orders: [movedFar], rows: [rainRow] });
  assert.equal(rain.counts.drafted, 1, 'rain date drafts');
  assert.equal(rain.h.row(rainRow.id).status, 'confirmed');
  assert.equal(rain.h.all().find((x) => x.status === 'ready').subject, 'Updated details for Thursday, September 24');
  assert.equal(rain.h.all().find((x) => x.status === 'ready').delivery_day, '2026-09-24');
  // The same for a sent row the owner had sent by hand (decision send_now).
  const rainSent = await scanAt('2026-09-21T15:05:00Z', ENV_AUTO, { orders: [movedFar], rows: [{ ...sent, decision: 'send_now' }] });
  assert.equal(rainSent.counts.drafted, 1); assert.equal(rainSent.h.row(sent.id).status, 'sent');
  assert.equal(rainSent.h.all().find((x) => x.status === 'ready').subject, 'Updated details for Thursday, September 24');
  // A held row whose hold lifts only after its day is over expires too
  // (never a "needs your Send now" for a past job), and a still-held one
  // as before.
  const heldPast = { ...drafted[0], status: 'held', hold_reasons: ['count_missing'], send_after: null };
  const heldLifted = await scanAt('2026-09-20T15:05:00Z', ENV_AUTO, { orders: [order()], rows: [heldPast] });
  assert.equal(heldLifted.h.all()[0].status, 'expired'); assert.equal(heldLifted.h.all()[0].error_detail, 'delivery day passed unsent'); assert.equal(heldLifted.h.pushes().length, 0);
  const heldStill = await scanAt('2026-09-20T15:05:00Z', ENV_AUTO, { orders: [order({ coconuts_qty: null })], rows: [heldPast] });
  assert.equal(heldStill.h.all()[0].status, 'expired'); assert.equal(heldStill.h.pushes().length, 0);
  // A bounced row the owner resends is not an update (the customer never
  // got the first one): the fresh draft keeps the first subject.
  const bouncedResend = await scanAt('2026-09-16T15:05:00Z', ENV_AUTO, { orders: [order()], rows: [{ ...sent, status: 'superseded', decision: 'resend', reply_kind: 'bounced' }] });
  assert.equal(bouncedResend.h.all().find((x) => x.status === 'ready').subject, FULL_SUBJECT);
  // A bounced row is retired when its order moves to another day (the
  // fresh draft for the new day still goes in, with the first-time
  // subject since the customer never got the first one) or when the order
  // is cancelled. An untouched order keeps its bounced row as it is.
  const bouncedRow = { ...sent, status: 'bounced', reply_kind: 'bounced', error_detail: 'bounced: Undeliverable' };
  const bouncedMoved = await scanAt('2026-09-16T15:05:00Z', ENV_AUTO, { orders: [moved], rows: [bouncedRow] });
  assert.equal(bouncedMoved.counts.expired, 1); assert.equal(bouncedMoved.h.row(bouncedRow.id).status, 'expired');
  assert.equal(bouncedMoved.h.row(bouncedRow.id).error_detail, 'bounced row retired: order moved or closed');
  assert.ok(bouncedMoved.h.calls.find((c) => c.method === 'PATCH' && c.body.status === 'expired').url.includes('status=eq.bounced'), 'guarded on bounced');
  assert.equal(bouncedMoved.counts.drafted, 1);
  const afterBounce = bouncedMoved.h.all().find((x) => x.status === 'ready');
  assert.equal(afterBounce.delivery_day, '2026-09-20'); assert.equal(afterBounce.subject, 'Your coconuts for Sunday, September 20: quick check');
  const bouncedCancelled = await scanAt('2026-09-16T15:05:00Z', ENV_AUTO, { orders: [order({ coconuts_qty: 120, stage: 'cancelled' })], rows: [bouncedRow] });
  assert.equal(bouncedCancelled.counts.expired, 1); assert.equal(bouncedCancelled.h.row(bouncedRow.id).status, 'expired'); assert.equal(bouncedCancelled.counts.drafted, 0);
  assert.equal(bouncedCancelled.h.pushes().length, 0);
  const bouncedKept = await scanAt('2026-09-16T15:05:00Z', ENV_AUTO, { orders: [order({ coconuts_qty: 120 })], rows: [bouncedRow] });
  assert.equal(bouncedKept.counts.expired, 0); assert.equal(bouncedKept.h.row(bouncedRow.id).status, 'bounced'); assert.equal(bouncedKept.counts.drafted, 0);
  assert.equal(bouncedKept.h.calls.filter((c) => c.method === 'PATCH').length, 0);
  // A ready row nobody sent expires the day after delivery (never a Send
  // now for a past job); on the day itself it stays ready, and it is left
  // word for word: the "reply today" flip the template would make that
  // day is a wording change alone, so nothing is written and no push goes.
  const readyOnDay = await scanAt('2026-09-19T15:05:00Z', ENV_AUTO, { orders: [order()], rows: drafted });
  assert.equal(readyOnDay.h.all()[0].status, 'ready'); assert.equal(readyOnDay.h.all()[0].body, FULL_BODY);
  assert.equal(readyOnDay.counts.rewritten, 0); assert.equal(readyOnDay.h.calls.filter((c) => c.method === 'PATCH').length, 0); assert.equal(readyOnDay.h.pushes().length, 0);
  const readyAfter = await scanAt('2026-09-20T15:05:00Z', ENV_AUTO, { orders: [order()], rows: drafted });
  assert.equal(readyAfter.h.all()[0].status, 'expired'); assert.equal(readyAfter.h.all()[0].error_detail, 'delivery day passed unsent'); assert.equal(readyAfter.counts.expired, 1);
  // A wording change shipped in the worker never touches a row on its
  // delivery day (Sidd, 2026-09-18, the day Alison's job was delivered:
  // "skip it for Alison, do it for the next event"). Her row's likely
  // state: ready, send_after null (a Phase A test copy handed it back),
  // still carrying the old wording. Deployed that day, the scan leaves it
  // word for word, writes nothing and pushes nothing; the day after it
  // expires as above, still with no push. The same row for a job the
  // NEXT day is brought level (a preview push follows), so the next event
  // gets the approved wording.
  const alison = { ...drafted[0], subject: OLD_SUBJECT, body: OLD_BODY, send_after: null };
  const oldOnDay = await scanAt('2026-09-19T15:05:00Z', ENV_AUTO, { orders: [order()], rows: [alison] });
  assert.equal(oldOnDay.counts.rewritten, 0); assert.equal(oldOnDay.h.calls.filter((c) => c.method === 'PATCH').length, 0); assert.equal(oldOnDay.h.pushes().length, 0);
  assert.equal(oldOnDay.h.all()[0].status, 'ready'); assert.equal(oldOnDay.h.all()[0].subject, OLD_SUBJECT); assert.equal(oldOnDay.h.all()[0].body, OLD_BODY);
  const oldOnDayPreview = await scanAt('2026-09-19T15:05:00Z', ENV_PREVIEW, { orders: [order()], rows: [alison] });
  assert.equal(oldOnDayPreview.counts.rewritten, 0); assert.equal(oldOnDayPreview.h.pushes().length, 0); assert.equal(oldOnDayPreview.h.all()[0].body, OLD_BODY);
  const oldAfterDay = await scanAt('2026-09-20T15:05:00Z', ENV_AUTO, { orders: [order()], rows: oldOnDay.h.all() });
  assert.equal(oldAfterDay.h.all()[0].status, 'expired'); assert.equal(oldAfterDay.h.pushes().length, 0); assert.equal(oldAfterDay.counts.expired, 1);
  const oldDayBefore = await scanAt('2026-09-18T15:05:00Z', ENV_AUTO, { orders: [order()], rows: [alison] });
  assert.equal(oldDayBefore.counts.rewritten, 1); assert.equal(oldDayBefore.h.all()[0].subject, FULL_SUBJECT);
  assert.equal(oldDayBefore.h.all()[0].body, FULL_BODY.split('by Wednesday, September 16').join('today'), 'the reply-by day has passed, so "today"');
  assert.equal(oldDayBefore.h.all()[0].status, 'ready'); assert.equal(oldDayBefore.h.all()[0].send_after, null, 'no clock is invented for it');
  assert.equal(oldDayBefore.h.pushes().length, 1); assert.equal(oldDayBefore.h.pushes()[0].payload.body.kind, 'reconfirm_previewed');
  // A FACT that moves on the delivery day still rewrites the row (as it
  // always did), and the new wording rides along with a fresh preview: the
  // owner must see what changed.
  const factOnDay = await scanAt('2026-09-19T15:05:00Z', ENV_AUTO, { orders: [order({ coconuts_qty: 120 })], rows: [alison] });
  assert.equal(factOnDay.counts.rewritten, 1); assert.equal(factOnDay.h.all()[0].facts.source.coconuts_qty, 120);
  assert.ok(factOnDay.h.all()[0].body.includes('\n• Count: 120 custom branded coconuts (picture below)\n')); assert.equal(factOnDay.h.all()[0].subject, FULL_SUBJECT);
  assert.equal(factOnDay.h.pushes().length, 1); assert.equal(factOnDay.h.pushes()[0].payload.body.kind, 'reconfirm_previewed');
  // A resend draft ("Updated details for ...") is re-judged every tick from
  // the superseded rows in the week-back read: once the old sent row that
  // made it an update ages out (a date moved by more than a week), the
  // subject flips back to the first-time one with ONE rewrite and one
  // preview, then stays. Rare, accepted as is (2026-09-18 review); this
  // pins that it is a single flip, never a loop.
  const updatedAlone = { ...drafted[0], subject: 'Updated details for Saturday, September 19' };
  const flipBack = await scanAt('2026-09-14T15:05:00Z', ENV_AUTO, { orders: [order()], rows: [updatedAlone] });
  assert.equal(flipBack.counts.rewritten, 1); assert.equal(flipBack.h.all()[0].subject, FULL_SUBJECT); assert.equal(flipBack.h.pushes().length, 1);
  const flipBackQuiet = await scanAt('2026-09-14T16:05:00Z', ENV_AUTO, { orders: [order()], rows: flipBack.h.all() });
  assert.equal(flipBackQuiet.counts.rewritten, 0); assert.equal(flipBackQuiet.h.pushes().length, 0);
  // With the superseded row still in the read the subject holds.
  const stillUpdated = await scanAt('2026-09-14T15:05:00Z', ENV_AUTO, { orders: [order()], rows: [updatedAlone, { ...drafted[0], id: 77, status: 'superseded', decision: 'resend', sent_at: '2026-09-10T14:00:00.000Z' }] });
  assert.equal(stillUpdated.counts.rewritten, 0); assert.equal(stillUpdated.h.row(updatedAlone.id).subject, 'Updated details for Saturday, September 19');
  // Two orders, one customer, one day: each subject carries its venue word.
  const twins = await scanAt(MON_0805, ENV_AUTO, { orders: [order(), order({ id: ORDER_2, venue: 'Maidstone Arms', delivery_notes: 'Maidstone Arms, East Hampton, NY', invoice_fulfillment: { ...order().invoice_fulfillment, address: 'Maidstone Arms, 207 Main St, East Hampton, NY 11937' } })] });
  assert.deepEqual(twins.h.all().map((x) => x.subject).sort(), ['Your coconuts for Saturday, September 19 at Maidstone: quick check', 'Your coconuts for Saturday, September 19 at Pridwin: quick check']);
  pass('change detection: a ready row is rewritten with a fresh preview only when the owner-visible text moved (a balance alone is quiet), a template change rewrites an old-wording ready or held row once and never again (the reply-today word flips once on minus 3), a sent or confirmed row becomes changed with a note and one push, a payment landing is quiet, Done stays quiet and keeps holding a week past a moved date (rows read from a week back), Resend drafts Updated details (a moved date too, never before the owner decides; a bounce keeps the first subject), a bounced row retires when the order moves or cancels, a ready or held row expires after the day, twins get venue subjects');
}

// ── 14. The reply step: each kind against a sent row ────────────────
{
  const sentRow = (id, orderId, extra = {}) => ({ id, order_id: orderId, delivery_day: '2026-09-19', status: 'sent', recipients: ['jamie@example.invalid'], sent_conversation_id: 'conv-' + id, sent_at: '2026-09-15T14:06:00Z', subject: 's', body: 'b', facts: reconfirmFacts(order({ id: orderId })), ...extra });
  const quote = '\n\nOn Tue, Sep 15, 2026 at 10:00 AM Sidd Saxena <sidd@hamptonscoconuts.com> wrote:\n> Delivery: Saturday, September 19, arriving 3:30 PM';
  const intake = (id, extra = {}) => ({ id, order_id: ORDER_ID, from_addr: 'Jamie Rivera <jamie@example.invalid>', subject: 'Re: Your coconuts for Saturday, September 19: quick check', raw_text: 'Confirmed, thanks!' + quote, created_at: '2026-09-15T15:00:00Z', ...extra });
  const NOW = '2026-09-15T15:05:00Z';
  // Confirmed: row stamped, intake dismissed, one push, no card material.
  const conf = await replyScanAt(NOW, ENV_PREVIEW, { orders: [order()], rows: [sentRow(1, ORDER_ID)], intakes: [intake(10)] });
  assert.equal(conf.result.counts.confirmed, 1); assert.deepEqual([...conf.result.changedIntakeIds], []);
  assert.equal(conf.h.row(1).status, 'confirmed'); assert.equal(conf.h.row(1).reply_kind, 'confirmed'); assert.equal(conf.h.row(1).reply_intake_id, 10); assert.equal(conf.h.row(1).replied_at, '2026-09-15T15:05:00.000Z');
  assert.equal(conf.h.intakes.get(10).status, 'dismissed'); assert.equal(conf.h.intakes.get(10).reviewed_at, '2026-09-15T15:05:00.000Z');
  assert.equal(conf.h.pushes().length, 1);
  assert.equal(conf.h.pushes()[0].payload.aps.alert.body, 'Rivera / Pridwin confirmed for Sat Sep 19.');
  assert.equal(conf.h.pushes()[0].id, await reconfirmQueueId('confirmed', 1));
  assert.deepEqual(conf.h.pushes()[0].payload.tokens, ['owner-token']);
  // Time: reply_kind stamped, status kept, intake left for the proposal scan.
  const time = await replyScanAt(NOW, ENV_PREVIEW, { orders: [order()], rows: [sentRow(1, ORDER_ID)], intakes: [intake(11, { raw_text: 'Can we do 4:00 PM for the coconut delivery instead?' + quote })] });
  assert.equal(time.result.counts.time, 1); assert.equal(time.h.row(1).status, 'sent'); assert.equal(time.h.row(1).reply_kind, 'time'); assert.equal(time.h.row(1).reply_intake_id, 11);
  assert.equal(time.h.intakes.get(11).status, 'pending_review'); assert.equal(time.h.pushes().length, 0);
  // Changed: status changed, a safe excerpt, the intake id handed to the card scan, no push here.
  const chg = await replyScanAt(NOW, ENV_PREVIEW, { orders: [order()], rows: [sentRow(1, ORDER_ID)], intakes: [intake(12, { raw_text: 'Please make it 120 coconuts and call Ana at (631) 555-0100, budget is $500' + quote })] });
  assert.equal(chg.result.counts.changed, 1); assert.deepEqual([...chg.result.changedIntakeIds], [12]);
  assert.equal(chg.h.row(1).status, 'changed'); assert.equal(chg.h.row(1).reply_kind, 'changed');
  assert.equal(chg.h.row(1).change_note, 'reply: Please make it 120 coconuts and call Ana at [phone], budget is [amount]');
  assert.equal(chg.h.intakes.get(12).status, 'pending_review'); assert.equal(chg.h.pushes().length, 0);
  // Next tick: not re-sorted, still reported to the card scan.
  const chg2 = await replyScanAt('2026-09-15T15:10:00Z', ENV_PREVIEW, { orders: [order()], rows: [chg.h.row(1)], intakes: [intake(12, { raw_text: 'Please make it 120 coconuts' })] });
  assert.equal(chg2.result.counts.seen, 0); assert.deepEqual([...chg2.result.changedIntakeIds], [12]);
  // Auto reply: dismissed quietly. Bounce: status bounced, a push, dismissed (matched on the conversation id, no order link needed).
  const auto = await replyScanAt(NOW, ENV_PREVIEW, { orders: [order()], rows: [sentRow(1, ORDER_ID)], intakes: [intake(13, { subject: 'Automatic reply: Your coconuts for Saturday, September 19: quick check', raw_text: 'I am out of the office.' })] });
  assert.equal(auto.result.counts.autoReply, 1); assert.equal(auto.h.row(1).status, 'sent'); assert.equal(auto.h.row(1).reply_kind, 'auto_reply'); assert.equal(auto.h.intakes.get(13).status, 'dismissed'); assert.equal(auto.h.pushes().length, 0);
  const bounce = await replyScanAt(NOW, ENV_PREVIEW, { orders: [order()], rows: [sentRow(1, ORDER_ID)], intakes: [intake(14, { order_id: null, conversation_id: 'conv-1', from_addr: 'postmaster@example.invalid', subject: 'Undeliverable: Your coconuts for Saturday, September 19: quick check', raw_text: 'Delivery has failed.' })] });
  assert.equal(bounce.result.counts.bounced, 1); assert.equal(bounce.h.row(1).status, 'bounced'); assert.equal(bounce.h.intakes.get(14).status, 'dismissed');
  assert.equal(bounce.h.pushes()[0].payload.aps.alert.body, 'Reconfirmation email bounced: Rivera / Pridwin. Check the customer email on the invoice.');
  // No match: another sender on the same order, or a reply about a past delivery day, is left alone.
  const other = await replyScanAt(NOW, ENV_PREVIEW, { orders: [order()], rows: [sentRow(1, ORDER_ID)], intakes: [intake(15, { from_addr: 'planner@example.invalid' })] });
  assert.equal(other.result.counts.seen, 0); assert.equal(other.h.row(1).status, 'sent'); assert.equal(other.h.intakes.get(15).status, 'pending_review');
  const past = await replyScanAt('2026-09-21T15:05:00Z', ENV_PREVIEW, { orders: [order()], rows: [sentRow(1, ORDER_ID, { sent_conversation_id: null })], intakes: [intake(16)] });
  assert.equal(past.result.counts.seen, 0); assert.equal(past.h.row(1).status, 'sent');
  // The sender rule needs the mail to have arrived after the send: a
  // 'Thanks for the invoice!' that landed a minute before it (still waiting
  // on its card) is not the reply. A conversation-id match needs no check.
  const early = await replyScanAt(NOW, ENV_PREVIEW, { orders: [order()], rows: [sentRow(1, ORDER_ID)], intakes: [intake(18, { raw_text: 'Thanks for the invoice!', created_at: '2026-09-15T14:05:00Z' })] });
  assert.equal(early.result.counts.seen, 0); assert.equal(early.h.row(1).status, 'sent'); assert.equal(early.h.intakes.get(18).status, 'pending_review');
  const noStamp = await replyScanAt(NOW, ENV_PREVIEW, { orders: [order()], rows: [sentRow(1, ORDER_ID, { sent_at: null })], intakes: [intake(19)] });
  assert.equal(noStamp.result.counts.seen, 0);
  const byThread = await replyScanAt(NOW, ENV_PREVIEW, { orders: [order()], rows: [sentRow(1, ORDER_ID)], intakes: [intake(20, { order_id: null, conversation_id: 'conv-1', created_at: '2026-09-15T14:05:00Z' })] });
  assert.equal(byThread.result.counts.confirmed, 1);
  // A row already confirmed: a second thanks is dismissed without a second push.
  const twice = await replyScanAt(NOW, ENV_PREVIEW, { orders: [order()], rows: [sentRow(1, ORDER_ID, { status: 'confirmed', reply_intake_id: 10 })], intakes: [intake(17, { raw_text: 'Thanks!' })] });
  assert.equal(twice.h.intakes.get(17).status, 'dismissed'); assert.equal(twice.h.pushes().length, 0); assert.equal(twice.h.row(1).status, 'confirmed');
  // The customer's name is what a signature may carry: 'Confirmed. Noon'
  // from Jamie is a change card, 'Confirmed.\n\nJamie Rivera' is confirmed,
  // and a title line under the name ('Events Director') or an answer
  // buried under it ('Noon') is a change card too, so the row stays
  // pending for the owner and nothing is confirmed by mistake.
  const noon = await replyScanAt(NOW, ENV_PREVIEW, { orders: [order()], rows: [sentRow(1, ORDER_ID)], intakes: [intake(21, { raw_text: 'Yes. Noon' + quote })] });
  assert.equal(noon.result.counts.changed, 1); assert.equal(noon.h.row(1).status, 'changed'); assert.equal(noon.h.intakes.get(21).status, 'pending_review');
  const signed = await replyScanAt(NOW, ENV_PREVIEW, { orders: [order()], rows: [sentRow(1, ORDER_ID)], intakes: [intake(22, { raw_text: 'Confirmed.\n\nJamie Rivera' + quote })] });
  assert.equal(signed.result.counts.confirmed, 1); assert.equal(signed.h.row(1).status, 'confirmed'); assert.equal(signed.h.intakes.get(22).status, 'dismissed');
  const titled = await replyScanAt(NOW, ENV_PREVIEW, { orders: [order()], rows: [sentRow(1, ORDER_ID)], intakes: [intake(29, { raw_text: 'Confirmed.\n\nJamie Rivera\nEvents Director' + quote })] });
  assert.equal(titled.result.counts.changed, 1); assert.equal(titled.result.counts.confirmed, 0); assert.equal(titled.h.row(1).status, 'changed'); assert.equal(titled.h.intakes.get(29).status, 'pending_review');
  assert.deepEqual([...titled.result.changedIntakeIds], [29]); assert.equal(titled.h.pushes().length, 0);
  const underName = await replyScanAt(NOW, ENV_PREVIEW, { orders: [order()], rows: [sentRow(1, ORDER_ID)], intakes: [intake(30, { raw_text: 'Yes.\n\nJamie Rivera\nNoon' + quote })] });
  assert.equal(underName.result.counts.changed, 1); assert.equal(underName.h.row(1).status, 'changed'); assert.equal(underName.h.intakes.get(30).status, 'pending_review'); assert.equal(underName.h.pushes().length, 0);
  // A plain "Confirmed" on a row the WORKER flipped to changed (the details
  // moved after the send; the customer confirmed an email that no longer
  // matches): the reply is stamped, the intake dismissed, the status stays
  // changed with its note and NO push, so the owner still decides Resend
  // or Done in the app.
  const flaggedRow = sentRow(1, ORDER_ID, { status: 'changed', change_note: 'count 100 to 150', reply_kind: null });
  const flagged = await replyScanAt(NOW, ENV_PREVIEW, { orders: [order()], rows: [flaggedRow], intakes: [intake(31)] });
  assert.equal(flagged.result.counts.confirmed, 1); assert.equal(flagged.h.row(1).status, 'changed'); assert.equal(flagged.h.row(1).change_note, 'count 100 to 150');
  assert.equal(flagged.h.row(1).reply_kind, 'confirmed'); assert.equal(flagged.h.row(1).reply_intake_id, 31); assert.equal(flagged.h.row(1).replied_at, '2026-09-15T15:05:00.000Z');
  assert.equal(flagged.h.intakes.get(31).status, 'dismissed'); assert.equal(flagged.h.pushes().length, 0); assert.deepEqual([...flagged.result.changedIntakeIds], []);
  const flaggedPatch = flagged.h.calls.find((c) => c.method === 'PATCH' && c.url.includes('order_reconfirmations'));
  assert.ok(flaggedPatch.url.includes('status=eq.changed') && flaggedPatch.body.status === undefined, 'stamp only, guarded on changed');
  // A row the CUSTOMER's own reply made changed, then a later "Confirmed":
  // that closes it as confirmed, with the push, as before.
  const customerChanged = sentRow(1, ORDER_ID, { status: 'changed', reply_kind: 'changed', reply_intake_id: 12, change_note: 'reply: Please make it more' });
  const closed = await replyScanAt(NOW, ENV_PREVIEW, { orders: [order()], rows: [customerChanged], intakes: [intake(32, { created_at: '2026-09-15T15:02:00Z' })] });
  assert.equal(closed.result.counts.confirmed, 1); assert.equal(closed.h.row(1).status, 'confirmed'); assert.equal(closed.h.row(1).reply_intake_id, 32); assert.equal(closed.h.pushes().length, 1);
  // Rows Jarvis already filed as 'ignored' (a postmaster is on no invoice)
  // are still read for bounces and auto replies; any other ignored mail is
  // left as Jarvis filed it, never confirmed from there.
  const ignoredBounce = await replyScanAt(NOW, ENV_PREVIEW, { orders: [order()], rows: [sentRow(1, ORDER_ID)], intakes: [intake(23, { status: 'ignored', order_id: null, conversation_id: 'conv-1', from_addr: 'postmaster@example.invalid', subject: 'Undeliverable: Your coconuts for Saturday, September 19: quick check', raw_text: 'Delivery has failed.' })] });
  assert.equal(ignoredBounce.result.counts.bounced, 1); assert.equal(ignoredBounce.h.row(1).status, 'bounced'); assert.equal(ignoredBounce.h.row(1).reply_intake_id, 23);
  assert.equal(ignoredBounce.h.intakes.get(23).status, 'ignored', 'the ignored row is left as filed');
  assert.equal(ignoredBounce.h.pushes()[0].payload.aps.alert.body, 'Reconfirmation email bounced: Rivera / Pridwin. Check the customer email on the invoice.');
  const ignoredAuto = await replyScanAt(NOW, ENV_PREVIEW, { orders: [order()], rows: [sentRow(1, ORDER_ID)], intakes: [intake(24, { status: 'ignored', subject: 'Automatic reply: Your coconuts', raw_text: 'I am out of the office.' })] });
  assert.equal(ignoredAuto.result.counts.autoReply, 1); assert.equal(ignoredAuto.h.row(1).reply_kind, 'auto_reply'); assert.equal(ignoredAuto.h.intakes.get(24).status, 'ignored');
  const ignoredPlain = await replyScanAt(NOW, ENV_PREVIEW, { orders: [order()], rows: [sentRow(1, ORDER_ID)], intakes: [intake(25, { status: 'ignored', raw_text: 'Confirmed' })] });
  assert.equal(ignoredPlain.result.counts.seen, 0); assert.equal(ignoredPlain.result.counts.skipped, 1); assert.equal(ignoredPlain.h.row(1).status, 'sent'); assert.equal(ignoredPlain.h.pushes().length, 0);
  assert.equal(ignoredPlain.h.calls.filter((c) => c.method === 'PATCH').length, 0);
  // The belt: a reply on our OWN thread (matched by the conversation id)
  // that Jarvis filed 'ignored' (a planner replying all from an address
  // the order does not carry, called not_order by the model) is read in
  // full. A change or a time re-opens the intake to pending_review as
  // maybe_order with the order id stamped and classified_at kept (so
  // Jarvis never re-judges it and the card scan cards it next tick); a
  // plain confirmation confirms the row and dismisses the intake from
  // ignored. Every write is guarded on the status it expects.
  const belt = (id, extra = {}) => intake(id, { status: 'ignored', order_id: null, conversation_id: 'conv-1', from_addr: 'Pat Planner <planner@example.invalid>', classification: 'not_order', classified_at: '2026-09-15T15:02:00Z', reviewed_at: '2026-09-15T15:02:00Z', ...extra });
  const beltChange = await replyScanAt(NOW, ENV_PREVIEW, { orders: [order()], rows: [sentRow(1, ORDER_ID)], intakes: [belt(40, { raw_text: 'Yes. Noon' + quote })] });
  assert.equal(beltChange.result.counts.changed, 1); assert.equal(beltChange.result.counts.skipped, 0);
  assert.equal(beltChange.h.row(1).status, 'changed'); assert.equal(beltChange.h.row(1).reply_kind, 'changed'); assert.equal(beltChange.h.row(1).reply_intake_id, 40); assert.equal(beltChange.h.row(1).change_note, 'reply: Yes. Noon');
  const reopened = beltChange.h.intakes.get(40);
  assert.equal(reopened.status, 'pending_review'); assert.equal(reopened.classification, 'maybe_order'); assert.equal(reopened.reviewed_at, null);
  assert.equal(reopened.order_id, ORDER_ID, 'linked to the booked job the way Jarvis links'); assert.equal(reopened.classified_at, '2026-09-15T15:02:00Z', 'classified_at kept');
  assert.deepEqual([...beltChange.result.changedIntakeIds], [40]); assert.equal(beltChange.h.pushes().length, 0);
  const reopenPatch = beltChange.h.calls.find((c) => c.method === 'PATCH' && c.url.includes('intake_messages'));
  assert.ok(reopenPatch.url.endsWith('intake_messages?id=eq.40&status=eq.ignored'), reopenPatch.url);
  assert.deepEqual(reopenPatch.body, { status: 'pending_review', classification: 'maybe_order', reviewed_at: null, order_id: ORDER_ID });
  const beltTime = await replyScanAt(NOW, ENV_PREVIEW, { orders: [order()], rows: [sentRow(1, ORDER_ID)], intakes: [belt(41, { raw_text: 'Can we do 4:00 PM for the coconut delivery instead?' + quote })] });
  assert.equal(beltTime.result.counts.time, 1); assert.equal(beltTime.h.row(1).status, 'sent'); assert.equal(beltTime.h.row(1).reply_kind, 'time'); assert.equal(beltTime.h.row(1).reply_intake_id, 41);
  assert.equal(beltTime.h.intakes.get(41).status, 'pending_review'); assert.equal(beltTime.h.intakes.get(41).classification, 'maybe_order'); assert.equal(beltTime.h.intakes.get(41).order_id, ORDER_ID);
  assert.equal(beltTime.h.pushes().length, 0); assert.deepEqual([...beltTime.result.changedIntakeIds], []);
  const beltConfirmed = await replyScanAt(NOW, ENV_PREVIEW, { orders: [order()], rows: [sentRow(1, ORDER_ID)], intakes: [belt(42, { raw_text: 'Confirmed' + quote })] });
  assert.equal(beltConfirmed.result.counts.confirmed, 1); assert.equal(beltConfirmed.h.row(1).status, 'confirmed'); assert.equal(beltConfirmed.h.row(1).reply_intake_id, 42);
  assert.equal(beltConfirmed.h.intakes.get(42).status, 'dismissed'); assert.equal(beltConfirmed.h.intakes.get(42).error_detail, 'reconfirmation reply: confirmed');
  assert.equal(beltConfirmed.h.pushes().length, 1); assert.equal(beltConfirmed.h.pushes()[0].payload.aps.alert.body, 'Rivera / Pridwin confirmed for Sat Sep 19.');
  assert.ok(beltConfirmed.h.calls.find((c) => c.method === 'PATCH' && c.url.includes('intake_messages')).url.includes('status=in.(pending_review,ignored)'), 'dismissed from ignored too');
  // An intake Jarvis linked to another job keeps that link; the re-open never overwrites it.
  const beltLinked = await replyScanAt(NOW, ENV_PREVIEW, { orders: [order()], rows: [sentRow(1, ORDER_ID)], intakes: [belt(43, { order_id: ORDER_2, raw_text: 'Yes. Noon' + quote })] });
  assert.equal(beltLinked.h.intakes.get(43).status, 'pending_review'); assert.equal(beltLinked.h.intakes.get(43).order_id, ORDER_2);
  // Next tick: the re-opened row is not sorted twice (the row already names it) and is still reported to the card scan.
  const beltAgain = await replyScanAt('2026-09-15T15:10:00Z', ENV_PREVIEW, { orders: [order()], rows: [beltChange.h.row(1)], intakes: [{ ...reopened }] });
  assert.equal(beltAgain.result.counts.seen, 0); assert.deepEqual([...beltAgain.result.changedIntakeIds], [40]); assert.equal(beltAgain.h.calls.filter((c) => c.method === 'PATCH').length, 0);
  // A pending_review reply matched by the thread does not touch the intake beyond the change (no re-open write).
  const pendingThread = await replyScanAt(NOW, ENV_PREVIEW, { orders: [order()], rows: [sentRow(1, ORDER_ID)], intakes: [intake(44, { order_id: null, conversation_id: 'conv-1', from_addr: 'planner@example.invalid', raw_text: 'Yes. Noon' + quote })] });
  assert.equal(pendingThread.result.counts.changed, 1); assert.equal(pendingThread.h.calls.filter((c) => c.method === 'PATCH' && c.url.includes('intake_messages')).length, 0);
  // Two replies inside one tick: the page is read newest first (the bound
  // keeps the newest mail) but walked oldest first, so the customer's LAST
  // word is the one that lands on the row, whichever way round they came.
  const lastWins = await replyScanAt(NOW, ENV_PREVIEW, { orders: [order()], rows: [sentRow(1, ORDER_ID)], intakes: [intake(10, { raw_text: 'Confirmed, thanks!' + quote, created_at: '2026-09-15T15:01:00Z' }), intake(11, { raw_text: 'Actually, please make it 120 coconuts' + quote, created_at: '2026-09-15T15:03:00Z' })] });
  assert.equal(lastWins.h.row(1).status, 'changed'); assert.equal(lastWins.h.row(1).reply_intake_id, 11); assert.equal(lastWins.h.row(1).change_note, 'reply: Actually, please make it 120 coconuts');
  assert.deepEqual([...lastWins.result.changedIntakeIds], [11]); assert.equal(lastWins.h.intakes.get(10).status, 'dismissed'); assert.equal(lastWins.h.intakes.get(11).status, 'pending_review');
  assert.equal(lastWins.h.pushes().length, 1); assert.equal(lastWins.h.pushes()[0].payload.aps.alert.body, 'Rivera / Pridwin confirmed for Sat Sep 19.');
  assert.deepEqual(lastWins.h.reads('intake_messages').map((c) => c.url.includes('order=created_at.desc,id.desc')), [true], 'still read newest first');
  const lastConfirms = await replyScanAt(NOW, ENV_PREVIEW, { orders: [order()], rows: [sentRow(1, ORDER_ID)], intakes: [intake(10, { raw_text: 'Actually, please make it 120 coconuts' + quote, created_at: '2026-09-15T15:01:00Z' }), intake(11, { raw_text: 'Confirmed, thanks!' + quote, created_at: '2026-09-15T15:03:00Z' })] });
  assert.equal(lastConfirms.h.row(1).status, 'confirmed'); assert.equal(lastConfirms.h.row(1).reply_intake_id, 11); assert.equal(lastConfirms.h.intakes.get(11).status, 'dismissed');
  assert.deepEqual([...lastConfirms.result.changedIntakeIds], [10]); assert.equal(lastConfirms.h.intakes.get(10).status, 'pending_review');
  // A reply OLDER than the one already on the row never replaces it. An
  // ignored auto reply (50) is never dismissed and is read for two days;
  // after the customer's change (51) landed on the row it must not be
  // stamped again on a later tick, or the customer's next "Confirmed"
  // (52) would read as worker-flagged and lose its push.
  const oldAuto = intake(50, { status: 'ignored', order_id: null, conversation_id: 'conv-1', subject: 'Automatic reply: Your coconuts', raw_text: 'I am out of the office.', created_at: '2026-09-15T14:07:00Z' });
  const stale = await replyScanAt(NOW, ENV_PREVIEW, { orders: [order()], rows: [sentRow(1, ORDER_ID, { status: 'changed', reply_kind: 'changed', reply_intake_id: 51, change_note: 'reply: Please make it 120 coconuts' })], intakes: [oldAuto, intake(51, { raw_text: 'Please make it 120 coconuts' + quote })] });
  assert.equal(stale.result.counts.seen, 0, 'older auto reply skipped');
  assert.equal(stale.h.row(1).reply_kind, 'changed'); assert.equal(stale.h.row(1).reply_intake_id, 51); assert.equal(stale.h.row(1).status, 'changed');
  assert.equal(stale.h.calls.filter((c) => c.method === 'PATCH').length, 0);
  const laterYes = await replyScanAt(NOW, ENV_PREVIEW, { orders: [order()], rows: [stale.h.row(1)], intakes: [oldAuto, intake(52, { created_at: '2026-09-15T15:02:00Z' })] });
  assert.equal(laterYes.h.row(1).status, 'confirmed'); assert.equal(laterYes.h.row(1).reply_intake_id, 52);
  assert.equal(laterYes.h.pushes().length, 1); assert.equal(laterYes.h.pushes()[0].payload.aps.alert.body, 'Rivera / Pridwin confirmed for Sat Sep 19.');
  // The same shape with an older uncarded change (60) behind a newer
  // confirmation (61): the confirmed row stays confirmed.
  const olderChange = await replyScanAt(NOW, ENV_PREVIEW, { orders: [order()], rows: [sentRow(1, ORDER_ID, { status: 'confirmed', reply_kind: 'confirmed', reply_intake_id: 61 })], intakes: [intake(60, { raw_text: 'Please make it 120 coconuts' + quote, created_at: '2026-09-15T14:30:00Z' })] });
  assert.equal(olderChange.result.counts.seen, 0); assert.equal(olderChange.h.row(1).status, 'confirmed'); assert.equal(olderChange.h.row(1).reply_intake_id, 61);
  assert.deepEqual([...olderChange.result.changedIntakeIds], []);
  // An ignored row older than two days is outside the read (bulk ignored
  // mail must not fill the page); a pending row that old is still read.
  const ignoredOld = await replyScanAt(NOW, ENV_PREVIEW, { orders: [order()], rows: [sentRow(1, ORDER_ID, { sent_at: '2026-09-12T14:06:00Z' })], intakes: [intake(33, { status: 'ignored', order_id: null, conversation_id: 'conv-1', from_addr: 'postmaster@example.invalid', subject: 'Undeliverable: Your coconuts', raw_text: 'Delivery has failed.', created_at: '2026-09-12T15:00:00Z' })] });
  assert.equal(ignoredOld.result.counts.seen, 0); assert.equal(ignoredOld.h.row(1).status, 'sent');
  const pendingOld = await replyScanAt(NOW, ENV_PREVIEW, { orders: [order()], rows: [sentRow(1, ORDER_ID, { sent_at: '2026-09-12T14:06:00Z' })], intakes: [intake(34, { created_at: '2026-09-12T15:00:00Z' })] });
  assert.equal(pendingOld.result.counts.confirmed, 1);
  // The reads: sent rows (with sent_at) first, then intake rows with no
  // card yet, newest first: pending ones from the last week, ignored ones
  // from the last two days only, each linked to an order or a conversation.
  const reads = conf.h.reads('order_reconfirmations')[0].url;
  assert.ok(reads.includes('status=in.(sent,confirmed,changed)') && reads.includes('sent_at'));
  const intakeRead = conf.h.reads('intake_messages')[0].url;
  assert.ok(intakeRead.includes('&or=(status.eq.pending_review,and(status.eq.ignored,created_at.gte.2026-09-13T15%3A05%3A00.000Z))&telegram_message_id=is.null&or=(order_id.not.is.null,conversation_id.not.is.null)'), intakeRead);
  assert.ok(!intakeRead.includes('status=in.(pending_review,ignored)'));
  assert.ok(intakeRead.includes('created_at=gte.2026-09-08T15%3A05%3A00.000Z'), 'bounded to the last week');
  assert.ok(intakeRead.includes('&order=created_at.desc,id.desc&limit=200'), 'newest first');
  // Replayed rows (old mail re-read by the replay script, migration 045)
  // never reach the reply scan: the filter rides on the read itself.
  assert.ok(intakeRead.includes('&replayed_at=is.null'), 'replayed rows are filtered out of the reply scan');
  const replayedReply = await replyScanAt(NOW, ENV_PREVIEW, { orders: [order()], rows: [sentRow(1, ORDER_ID)], intakes: [intake(70, { raw_text: 'Confirmed' + quote, replayed_at: '2026-09-15T13:00:00Z' })] });
  assert.equal(replayedReply.result.counts.seen, 0); assert.equal(replayedReply.h.row(1).status, 'sent'); assert.equal(replayedReply.h.pushes().length, 0);
  assert.equal(replayedReply.h.intakes.get(70).status, 'pending_review', 'never stamped or dismissed');
  pass('reply step: confirmed (stamp, dismiss, one push), time (left to the proposal scan), changed (safe excerpt, card line), auto reply, bounce via conversation id (from an ignored row too, two days back), sender rule needs arrival after the send, the customer name gates the signature (a title or a buried answer under it is a change), a worker-flagged changed row only takes the stamp, no match, second thanks quiet, newest-first read walked oldest first (the last reply wins), the belt re-opens an ignored thread reply for its card, a replayed row is never read');
}

// ── 15. The digest line ─────────────────────────────────────────────
{
  const rows = [
    { id: 1, order_id: ORDER_ID, delivery_day: '2026-09-19', status: 'ready', send_after: '2026-09-15T14:00:00.000Z' },
    { id: 2, order_id: ORDER_2, delivery_day: '2026-09-19', status: 'held', hold_reasons: ['count_missing'] },
    { id: 3, order_id: ORDER_3, delivery_day: '2026-09-18', status: 'confirmed' },
    { id: 4, order_id: ORDER_3, delivery_day: '2026-09-17', status: 'expired', error_detail: 'still held on delivery day minus 1', facts: { source: { client_name: 'Old Job' } } },
  ];
  // Two orders with nothing recorded inside the window: 'invoiced' is the
  // "no payment yet" name on the main line; the hand-set deposit_paid one
  // ('December Co') goes on the second line so the owner checks
  // QuickBooks. A paid_full order with nothing recorded but six days out
  // is outside the window and named nowhere yet.
  const orders = [order(), order({ id: ORDER_2, client_name: 'Casey Lin', coconuts_qty: null }), order({ id: ORDER_3, client_name: 'Robin Park', delivery_at_utc: '2026-09-18T00:00:00+00:00' }),
    order({ id: '66666666-6666-4666-8666-666666666666', client_name: 'No Money Inc', stage: 'invoiced', deposit_cents: 0, balance_cents: 0 }),
    order({ id: '77777777-7777-4777-8777-777777777777', client_name: 'December Co', stage: 'deposit_paid', deposit_cents: 0, balance_cents: null }),
    order({ id: '88888888-8888-4888-8888-888888888888', client_name: 'Far Out LLC', stage: 'paid_full', deposit_cents: null, balance_cents: 0, delivery_at_utc: '2026-09-21T00:00:00+00:00' })];
  const h = harness({ rows, orders });
  try {
    const lines = await at('2026-09-15T12:00:00Z', () => buildReconfirmationDigestLines(ENV_PREVIEW));
    assert.deepEqual(lines, [
      'Reconfirmations: 1 send today, 1 held (coconut count missing), 1 confirmed, 1 not sent, no payment yet (No Money Inc), 1 expired unsent (Robin Park)',
      'Stage says paid but nothing recorded, check QuickBooks: December Co',
    ]);
    for (const l of lines) assert.ok(!l.includes('@') && !l.includes('$') && !/[–—]/.test(l));
  } finally { h.restore(); }
  // Two such orders are named together; a paid_full one with money is not.
  const two = harness({ rows: [], orders: [order({ client_name: 'Paid Fine', stage: 'paid_full', balance_cents: 100 }), order({ id: ORDER_2, client_name: 'December Co', stage: 'deposit_paid', deposit_cents: 0, balance_cents: 0 }), order({ id: ORDER_3, client_name: 'Full But Empty', stage: 'paid_full', deposit_cents: 0, balance_cents: 0 })] });
  try {
    assert.deepEqual(await at('2026-09-15T12:00:00Z', () => buildReconfirmationDigestLines(ENV_PREVIEW)), [
      'Reconfirmations: 0 send today, 0 held, 0 confirmed, 0 not sent, no payment yet',
      'Stage says paid but nothing recorded, check QuickBooks: December Co, Full But Empty',
    ]);
  } finally { two.restore(); }
  // No such order: one line only, never an empty warning.
  const empty = harness({ rows: [], orders: [] });
  try { assert.deepEqual(await at('2026-09-15T12:00:00Z', () => buildReconfirmationDigestLines(ENV_PREVIEW)), ['Reconfirmations: 0 send today, 0 held, 0 confirmed, 0 not sent, no payment yet']); } finally { empty.restore(); }
  const missing = harness({ tableMissing: true, orders: [] });
  try { assert.deepEqual(await at('2026-09-15T12:00:00Z', () => buildReconfirmationDigestLines(ENV_PREVIEW)), []); } finally { missing.restore(); }
  pass('digest: the one line with counts, hold reasons and names only, plus the "stage says paid but nothing recorded" line when a paid stage has zero recorded (only then); empty counts; missing table is silent');
}

// ── 16. The wiring, pinned in the source ────────────────────────────
{
  const { readFileSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'worker.js'), 'utf8');
  const hourly = src.slice(src.indexOf("cron === '0 * * * *'"), src.indexOf("cron === '*/5 * * * *'"));
  assert.ok(hourly.includes('await runReconfirmationScan(env);'), 'the scan keeps its hourly slot');
  assert.ok(!src.includes('Reply *send* in Telegram'), 'the 7-day Telegram stub is gone');
  const card = src.slice(src.indexOf('async function runIntakeCardScan(env)'));
  const replyAt = card.indexOf('await runReconfirmationReplyScan(env)');
  const readAt = card.indexOf("'select=id,from_addr,subject,raw_text,classification");
  assert.ok(replyAt >= 0 && readAt > replyAt, 'the reply step runs before the cards are read');
  assert.ok(card.includes("notes.push('Reply to the reconfirmation email');"));
  const digest = src.slice(src.indexOf('async function runDailyDigest(env)'), src.indexOf('async function runReconfirmationScan(env)'));
  assert.ok(digest.includes('await buildReconfirmationDigestLines(env)'));
  assert.ok(src.includes("stripQuotedText(String(rawText || '').slice(0, 100000))"), 'extractArrivalTimes strips quoted text');
  const block = src.slice(src.indexOf('RECONFIRMATION EMAILS (2026-09-14)'), src.indexOf('end of the reconfirmation block'));
  assert.ok(!/[–—]/.test(block), 'no dashes in the new block');
  assert.ok(!/OWNER_CELL\s*=\s*['"]\d/.test(block), 'the cell number is never in code');
  const toml = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'wrangler.toml'), 'utf8');
  for (const name of ['RECONFIRM_MODE', 'RECONFIRM_DAILY_CAP', 'RECONFIRM_TEST_TO', 'OWNER_CELL']) assert.ok(toml.includes('# ' + name + ' - '), name + ' documented in wrangler.toml');
  assert.ok(!/RECONFIRM_TEST_TO\s*=/.test(toml) && !/@/.test(toml.split('RECONFIRM_TEST_TO')[1].split('\n')[0]), 'no address in the file');
  pass('wiring: hourly slot kept, stub gone, reply step before the cards, card line, digest line, quoted text stripped, settings documented, no dashes');
}

console.log(`\nPASS: ${passed} reconfirmation checks. No network, no database, no phone, no email.`);

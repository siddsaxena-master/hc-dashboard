// Tests for the payday payroll section of the daily digest (worker.js,
// SHIFT PAYROLL section: payrollDueWeek and buildPayrollDigestLines).
// 2026-11-16: Sidd pays the crew every MONDAY for the Monday to Sunday
// week that just ended (New York time), so the section moved from Sunday
// to Monday and now names the week due today. Everything runs against a
// fake network: nothing here can reach Supabase or Telegram. Every person
// and rate below is made up.
//
// Run it with:  node worker/test-payroll-digest.mjs
// (It also reads ../hc-field-app/App.js beside the repo for the pay
// formula parity check, like test-payroll-payment-safety.mjs.)

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import worker, { payrollDueWeek, buildPayrollDigestLines } from './worker.js';

const here = dirname(fileURLToPath(import.meta.url));
let passed = 0;
const pass = (m) => { passed++; console.log('PASS: ' + m); };
const SB = 'https://example.invalid';
const ENV = { SUPABASE_URL: SB, SUPABASE_SERVICE_KEY: 'not-a-real-key', TG_BOT_TOKEN: 'x', ALLOWED_CHAT_IDS: '' };
const T = (iso) => Date.parse(iso);
const SHIFTS_URL = SB + '/rest/v1/shifts?select=id,worker_name,worker_email,clock_in_at,clock_out_at&paid_at=is.null&order=clock_in_at.asc&limit=200';
const WORKERS_URL = SB + '/rest/v1/field_workers?select=email,name,hourly_rate_cents';

// Made-up crew. Rates are odd on purpose so nobody mistakes them for real.
const ALEX = { name: 'Alex Example', email: 'alex@example.test' };
const BLAKE = { name: 'Blake Example', email: 'blake@example.test' };
const CASEY = { name: 'Casey Example', email: 'casey@example.test' };
const DANA = { name: 'Dana Example', email: null };
const ERIN = { name: 'Erin Example', email: 'erin@example.test' };
const FRAN = { name: 'Fran Example', email: 'fran@example.test' };
const PAT = { name: 'Pat Example', email: 'pat@example.test' };
const QUINN = { name: 'Quinn Example', email: 'quinn@example.test' };
const WORKERS = [
  { email: 'alex@example.test', name: 'Alex Example', hourly_rate_cents: 1234 },
  { email: 'blake@example.test', name: 'Blake Example', hourly_rate_cents: 1500 },
  { email: 'casey@example.test', name: 'Casey Example', hourly_rate_cents: null },
  { email: null, name: 'Dana Example', hourly_rate_cents: 1800 },
  { email: 'fran@example.test', name: 'Fran Example', hourly_rate_cents: 1500 },
  { email: 'pat@example.test', name: 'Pat Example', hourly_rate_cents: 1000 },
  { email: 'quinn@example.test', name: 'Quinn Example', hourly_rate_cents: 1000 },
];

let nextId = 1;
function shift(who, inIso, outIso) {
  return { id: nextId++, worker_name: who.name, worker_email: who.email, clock_in_at: inIso, clock_out_at: outIso || null };
}
// The database answers oldest clock-in first (order=clock_in_at.asc).
const byClockIn = (rows) => rows.slice().sort((a, b) => Date.parse(a.clock_in_at) - Date.parse(b.clock_in_at));

// The fake network: the shifts read and the field_workers read, each with
// the rows or the failure a case asks for. Anything else is a test bug.
function harness(opts = {}) {
  const calls = [];
  const originalFetch = globalThis.fetch;
  const ok = (body) => ({ ok: true, status: 200, async json() { return body; }, async text() { return JSON.stringify(body); } });
  const bad = (status) => ({ ok: false, status, async json() { return null; }, async text() { return 'boom'; } });
  globalThis.fetch = async (urlValue, options = {}) => {
    const url = String(urlValue);
    calls.push({ url, method: options.method || 'GET' });
    if (opts.throws) throw new TypeError('fetch failed');
    if (url.startsWith(SB + '/rest/v1/shifts?')) return opts.shiftsStatus ? bad(opts.shiftsStatus) : ok(byClockIn(opts.shifts || []));
    if (url.startsWith(SB + '/rest/v1/field_workers?')) return opts.workersStatus ? bad(opts.workersStatus) : ok(opts.workers || WORKERS);
    throw new Error('unexpected fetch ' + url);
  };
  return { calls, restore: () => { globalThis.fetch = originalFetch; } };
}
async function digestAt(iso, opts) {
  const h = harness(opts);
  try {
    const lines = await buildPayrollDigestLines(ENV, T(iso));
    return { lines, calls: h.calls };
  } finally { h.restore(); }
}
// etTimeStr may put a narrow no-break space before AM/PM (newer ICU);
// \s matches it, so the open-shift flag is checked with a pattern.
const openFlag = (name, day, time) =>
  new RegExp('^⚠️ ' + name + ' has a shift open since ' + day + ' ' + time.replace(' ', '\\s') + ' ET - missing clock-out, not counted\\.$');

// ── 1. The week due today: label at the DST edges, at 12:00 and 13:00 UTC ──
{
  const cases = [
    // [now, start, end, thisWeekStart, label]
    ['2026-11-16T12:00:00Z', '2026-11-09', '2026-11-15', '2026-11-16', 'Mon Nov 9 to Sun Nov 15'],
    ['2026-11-16T13:00:00Z', '2026-11-09', '2026-11-15', '2026-11-16', 'Mon Nov 9 to Sun Nov 15'],
    // DST ended Sun Nov 1 2026: 12:00 UTC on Mon Nov 2 is 7am EST.
    ['2026-11-02T12:00:00Z', '2026-10-26', '2026-11-01', '2026-11-02', 'Mon Oct 26 to Sun Nov 1'],
    ['2026-11-02T13:00:00Z', '2026-10-26', '2026-11-01', '2026-11-02', 'Mon Oct 26 to Sun Nov 1'],
    // DST began Sun Mar 14 2027: 12:00 UTC on Mon Mar 15 is 8am EDT.
    ['2027-03-15T12:00:00Z', '2027-03-08', '2027-03-14', '2027-03-15', 'Mon Mar 8 to Sun Mar 14'],
    ['2027-03-15T13:00:00Z', '2027-03-08', '2027-03-14', '2027-03-15', 'Mon Mar 8 to Sun Mar 14'],
    // Month and year boundary.
    ['2027-01-04T12:00:00Z', '2026-12-28', '2027-01-03', '2027-01-04', 'Mon Dec 28 to Sun Jan 3'],
    // Mid-week it is still the last FINISHED week.
    ['2026-11-18T12:00:00Z', '2026-11-09', '2026-11-15', '2026-11-16', 'Mon Nov 9 to Sun Nov 15'],
    // On a Sunday the current week is not finished, so the week before.
    ['2026-11-15T12:00:00Z', '2026-11-02', '2026-11-08', '2026-11-09', 'Mon Nov 2 to Sun Nov 8'],
  ];
  for (const [now, start, end, thisWeekStart, label] of cases) {
    assert.deepEqual(payrollDueWeek(T(now)), { start, end, thisWeekStart, label }, now);
  }
  // The New York midnight decides, never the UTC one, on both DST edges.
  assert.equal(payrollDueWeek(T('2026-11-02T04:59:00Z')).label, 'Mon Oct 19 to Sun Oct 25'); // Sun 11:59 PM EST
  assert.equal(payrollDueWeek(T('2026-11-02T05:00:00Z')).label, 'Mon Oct 26 to Sun Nov 1');  // Mon 12:00 AM EST
  assert.equal(payrollDueWeek(T('2027-03-15T03:59:00Z')).label, 'Mon Mar 1 to Sun Mar 7');   // Sun 11:59 PM EDT
  assert.equal(payrollDueWeek(T('2027-03-15T04:00:00Z')).label, 'Mon Mar 8 to Sun Mar 14');  // Mon 12:00 AM EDT
  pass('due week: last finished Mon-Sun New York week, right at both DST edges at 12:00 and 13:00 UTC and at New York midnight');
}

// ── 2. Monday only, judged by the New York weekday ───────────────────
{
  const rows = [shift(BLAKE, '2026-11-10T13:00:00Z', '2026-11-10T21:00:00Z')];
  for (const now of ['2026-11-15T12:00:00Z', '2026-11-15T13:00:00Z', '2026-11-17T12:00:00Z', '2026-11-21T12:00:00Z',
    // UTC already Monday, New York still Sunday (11 PM EST / 11:59 PM EDT).
    '2026-11-16T04:00:00Z', '2027-03-15T03:59:00Z']) {
    const r = await digestAt(now, { shifts: rows });
    assert.deepEqual(r.lines, [], now);
    assert.equal(r.calls.length, 0, 'no read at all on ' + now);
  }
  for (const now of ['2026-11-16T12:00:00Z', '2026-11-16T13:00:00Z', '2026-11-16T05:00:00Z', '2026-11-23T12:00:00Z']) {
    const r = await digestAt(now, { shifts: rows });
    assert.ok(r.lines.length > 0 && r.lines[0].startsWith('💵 Payroll due today for '), now);
  }
  pass('weekday: section on a New York Monday (12:00 and 13:00 UTC, from 00:00 ET), none on Sunday, Tuesday or Saturday, and no read made');
}

// ── 3. The full Monday section ───────────────────────────────────────
// Mon Nov 16 2026 at 12:00 UTC (7am EST). Due week Mon Nov 9 to Sun Nov 15.
const MAIN_ROWS = [
  // Fran: one OLDER unpaid shift (12h) and 4 x 8h in the due week. 44h
  // due in total but only 32h in the due week, so no over-40 flag.
  shift(FRAN, '2026-11-02T13:00:00Z', '2026-11-03T01:00:00Z'),
  shift(FRAN, '2026-11-09T13:00:00Z', '2026-11-09T21:00:00Z'),
  shift(FRAN, '2026-11-10T13:00:00Z', '2026-11-10T21:00:00Z'),
  shift(FRAN, '2026-11-11T13:00:00Z', '2026-11-11T21:00:00Z'),
  shift(FRAN, '2026-11-12T13:00:00Z', '2026-11-12T21:00:00Z'),
  // Alex: one older shift, one due-week shift, one Sunday-night shift that
  // ends Monday 2am (clock-in Sun Nov 15 10 PM EST: due week), and one
  // shift that clocked in this Monday at 4am (not due yet).
  shift(ALEX, '2026-11-03T14:00:00Z', '2026-11-03T18:00:00Z'),
  shift(ALEX, '2026-11-11T13:00:00Z', '2026-11-11T21:30:00Z'),
  shift(ALEX, '2026-11-16T03:00:00Z', '2026-11-16T07:00:00Z'),
  shift(ALEX, '2026-11-16T09:00:00Z', '2026-11-16T11:00:00Z'),
  // Blake: 5 x 8h05m in the due week = 40h25m, over 40.
  shift(BLAKE, '2026-11-09T13:00:00Z', '2026-11-09T21:05:00Z'),
  shift(BLAKE, '2026-11-10T13:00:00Z', '2026-11-10T21:05:00Z'),
  shift(BLAKE, '2026-11-11T13:00:00Z', '2026-11-11T21:05:00Z'),
  shift(BLAKE, '2026-11-12T13:00:00Z', '2026-11-12T21:05:00Z'),
  shift(BLAKE, '2026-11-13T13:00:00Z', '2026-11-13T21:05:00Z'),
  // Casey: no rate on the roster.
  shift(CASEY, '2026-11-12T14:00:00Z', '2026-11-12T17:20:00Z'),
  // Dana: open 21 hours (forgotten clock-out). Erin: open 2 hours (fine).
  shift(DANA, '2026-11-15T15:00:00Z', null),
  shift(ERIN, '2026-11-16T10:00:00Z', null),
];
{
  for (const now of ['2026-11-16T12:00:00Z', '2026-11-16T13:00:00Z']) {
    const { lines, calls } = await digestAt(now, { shifts: MAIN_ROWS });
    assert.deepEqual(lines.slice(0, 8), [
      '💵 Payroll due today for Mon Nov 9 to Sun Nov 15',
      '  • Fran Example - 5 shifts · 44:00 · $660.00 · includes 1 older shift from before Mon Nov 9',
      '  • Alex Example - 3 shifts · 16:30 · $203.61 · includes 1 older shift from before Mon Nov 9',
      '  • Blake Example - 5 shifts · 40:25 · $606.25 · over 40h last week',
      '  • Casey Example - 1 shift · 3:20 · rate not set',
      '  Total due today: $1469.86',
      '  This week, not due yet:',
      '  • Alex Example - 1 shift · 2:00 · $24.68',
    ], now);
    assert.equal(lines.length, 9, now);
    assert.match(lines[8], openFlag('Dana Example', 'Sun, Nov 15', '10:00 AM'));
    // The same two reads as before, nothing else.
    assert.deepEqual(calls.map((c) => c.method + ' ' + c.url), ['GET ' + SHIFTS_URL, 'GET ' + WORKERS_URL]);
  }
  pass('section: header names the week, older unpaid shifts kept and counted, over 40 on the due week only, this week listed as not due and left out of the total, forgotten open shift flagged');
}
{
  // Only this week's shifts: nothing due, still listed.
  const { lines } = await digestAt('2026-11-16T12:00:00Z', { shifts: [shift(ALEX, '2026-11-16T09:00:00Z', '2026-11-16T11:00:00Z')] });
  assert.deepEqual(lines, [
    '💵 Payroll due today for Mon Nov 9 to Sun Nov 15',
    '  No closed unpaid shifts are due today.',
    '  This week, not due yet:',
    '  • Alex Example - 1 shift · 2:00 · $24.68',
  ]);
  // Nothing unpaid at all: no section, as before.
  assert.deepEqual((await digestAt('2026-11-16T12:00:00Z', { shifts: [] })).lines, []);
  // Only a recent open shift: nothing to say.
  assert.deepEqual((await digestAt('2026-11-16T12:00:00Z', { shifts: [shift(ERIN, '2026-11-16T10:00:00Z', null)] })).lines, []);
  pass('section: nothing due but this week listed; silent when nothing is unpaid or only a fresh open shift');
}

// ── 4. DST edges: which week a shift right at midnight belongs to ────
{
  // Mon Nov 2 2026 (EST since Sun Nov 1). Pat clocked in Sun Nov 1 at
  // 11:30 PM EST (due); Quinn clocked in Mon Nov 2 at 12:30 AM EST (not
  // due). Reading the clock as EDT would swap them.
  const rows = [
    shift(PAT, '2026-11-02T04:30:00Z', '2026-11-02T06:30:00Z'),
    shift(QUINN, '2026-11-02T05:30:00Z', '2026-11-02T07:30:00Z'),
  ];
  for (const now of ['2026-11-02T12:00:00Z', '2026-11-02T13:00:00Z']) {
    assert.deepEqual((await digestAt(now, { shifts: rows })).lines, [
      '💵 Payroll due today for Mon Oct 26 to Sun Nov 1',
      '  • Pat Example - 1 shift · 2:00 · $20.00',
      '  Total due today: $20.00',
      '  This week, not due yet:',
      '  • Quinn Example - 1 shift · 2:00 · $20.00',
    ], now);
  }
}
{
  // Mon Mar 15 2027 (EDT since Sun Mar 14). Pat clocked in Sun Mar 14 at
  // 11:30 PM EDT (due); Quinn clocked in Mon Mar 15 at 12:30 AM EDT (not
  // due). Reading the clock as EST would swap them.
  const rows = [
    shift(PAT, '2027-03-15T03:30:00Z', '2027-03-15T05:30:00Z'),
    shift(QUINN, '2027-03-15T04:30:00Z', '2027-03-15T06:30:00Z'),
  ];
  for (const now of ['2027-03-15T12:00:00Z', '2027-03-15T13:00:00Z']) {
    assert.deepEqual((await digestAt(now, { shifts: rows })).lines, [
      '💵 Payroll due today for Mon Mar 8 to Sun Mar 14',
      '  • Pat Example - 1 shift · 2:00 · $20.00',
      '  Total due today: $20.00',
      '  This week, not due yet:',
      '  • Quinn Example - 1 shift · 2:00 · $20.00',
    ], now);
  }
  pass('DST edges: a shift is in the week of its New York clock-in date on Mon Nov 2 2026 and Mon Mar 15 2027, at 12:00 and 13:00 UTC');
}

// ── 5. Totals unchanged versus the old Sunday section, same rows ─────
// The grouping and money of d7af6c5's Sunday buildPayrollDigestLines,
// copied rule for rule (minus its words and its weekday gate).
function oldSundayGroups(rows, workers) {
  const rateFor = (row) => {
    const email = (row.worker_email || '').toLowerCase();
    let w = email ? workers.find((x) => (x.email || '').toLowerCase() === email) : null;
    if (!w) w = workers.find((x) => x.name === row.worker_name) || null;
    return (w && w.hourly_rate_cents != null) ? w.hourly_rate_cents : null;
  };
  const groups = {};
  let grand = 0;
  rows.forEach((row) => {
    if (!row.clock_out_at) return;
    const key = (row.worker_email || row.worker_name || '?').toLowerCase();
    if (!groups[key]) groups[key] = { name: row.worker_name, rate: rateFor(row), count: 0, mins: 0, cents: 0 };
    const g = groups[key];
    g.count += 1;
    const mins = Math.max(0, Math.floor((new Date(row.clock_out_at) - new Date(row.clock_in_at)) / 60000));
    g.mins += mins;
    if (g.rate != null) { const c = Math.round(mins * g.rate / 60); g.cents += c; grand += c; }
  });
  return { list: Object.values(groups), grand };
}
const hm = (m) => Math.floor(m / 60) + ':' + String(m % 60).padStart(2, '0');
const usd = (c) => '$' + (c / 100).toFixed(2);
{
  // Every row before this week: each worker line and the total match the
  // old math exactly.
  const rows = byClockIn(MAIN_ROWS.filter((r) => !(r.clock_out_at && r.clock_in_at >= '2026-11-16T05:00:00Z')));
  const old = oldSundayGroups(rows, WORKERS);
  const { lines } = await digestAt('2026-11-16T12:00:00Z', { shifts: rows });
  old.list.forEach((g, i) => {
    const expect = '  • ' + g.name + ' - ' + g.count + ' shift' + (g.count === 1 ? '' : 's') + ' · ' + hm(g.mins) +
      (g.rate != null ? ' · ' + usd(g.cents) : ' · rate not set');
    assert.ok(lines[i + 1].startsWith(expect), lines[i + 1] + ' vs ' + expect);
  });
  assert.equal(lines[old.list.length + 1], '  Total due today: ' + usd(old.grand));
  assert.ok(!lines.includes('  This week, not due yet:'));
}
{
  // With this week's shift too: due plus not due equals the old total,
  // shift by shift and dollar by dollar.
  const old = oldSundayGroups(byClockIn(MAIN_ROWS), WORKERS);
  const { lines } = await digestAt('2026-11-16T12:00:00Z', { shifts: MAIN_ROWS });
  const money = (line) => { const m = line.match(/\$(\d+)\.(\d\d)/); return m ? Number(m[1]) * 100 + Number(m[2]) : 0; };
  const total = money(lines.find((l) => l.startsWith('  Total due today: ')));
  const notDue = lines.slice(lines.indexOf('  This week, not due yet:') + 1).filter((l) => l.startsWith('  • ')).reduce((s, l) => s + money(l), 0);
  assert.equal(total + notDue, old.grand);
  const shiftsListed = lines.filter((l) => l.startsWith('  • ')).reduce((s, l) => s + Number(l.match(/ - (\d+) shifts? /)[1]), 0);
  assert.equal(shiftsListed, old.list.reduce((s, g) => s + g.count, 0), 'every closed unpaid shift is listed once');
  pass('totals: same rows give the same per-worker shifts, hours, dollars and total as the old Sunday math; due plus not due equals the old total');
}

// ── 6. Pay math parity with the HC Field Pay card (App.js) ───────────
{
  const app = readFileSync(join(here, '..', '..', 'hc-field-app', 'App.js'), 'utf8');
  const pick = (name) => {
    const m = app.match(new RegExp('^const ' + name + ' = .*$', 'm'));
    assert.ok(m, name + ' found in App.js');
    return m[0];
  };
  const appPay = new Function([pick('payMins'), pick('payCents'), pick('fmtHm'), pick('moneyCents')].join('\n') +
    '\nreturn { payMins, payCents, fmtHm, moneyCents };')();
  // Durations in seconds and made-up rates in cents, picked to hit the
  // floor and the half-cent rounding.
  const vectors = [[61, 30], [119, 90], [3599, 1234], [28799, 1999], [30 * 60, 1], [7 * 3600 + 59 * 60 + 59, 1501], [90, 2500]];
  for (const [secs, rate] of vectors) {
    const inIso = '2026-11-10T13:00:00Z';
    const outIso = new Date(T(inIso) + secs * 1000).toISOString();
    const workers = [{ email: 'pat@example.test', name: 'Pat Example', hourly_rate_cents: rate }];
    const { lines } = await digestAt('2026-11-16T12:00:00Z', { shifts: [shift(PAT, inIso, outIso)], workers });
    const mins = appPay.payMins(inIso, outIso);
    const cents = appPay.payCents(mins, rate);
    assert.equal(lines[1], '  • Pat Example - 1 shift · ' + appPay.fmtHm(mins) + ' · ' + appPay.moneyCents(cents), secs + 's at ' + rate);
    assert.equal(lines[2], '  Total due today: ' + appPay.moneyCents(cents));
  }
  pass('parity: hours and dollars printed by the digest equal App.js payMins, payCents, fmtHm and moneyCents');
}

// ── 7. Fails soft, and says when the read limit was hit ──────────────
{
  const now = '2026-11-16T12:00:00Z';
  assert.deepEqual((await digestAt(now, { shifts: MAIN_ROWS, shiftsStatus: 500 })).lines, []);
  assert.deepEqual((await digestAt(now, { throws: true })).lines, []);
  // Roster read failed: shifts still listed, every rate unknown.
  const noRoster = (await digestAt(now, { shifts: MAIN_ROWS, workersStatus: 500 })).lines;
  assert.equal(noRoster[1], '  • Fran Example - 5 shifts · 44:00 · rate not set · includes 1 older shift from before Mon Nov 9');
  assert.equal(noRoster[5], '  Total due today: $0.00');
  // 200 rows back = the read limit: the section says the total may be short.
  const many = [];
  for (let i = 0; i < 200; i++) {
    const start = T('2026-11-09T13:00:00Z') + i * 30 * 60000;
    many.push(shift(PAT, new Date(start).toISOString(), new Date(start + 20 * 60000).toISOString()));
  }
  const full = (await digestAt(now, { shifts: many })).lines;
  assert.equal(full[full.length - 1], '⚠️ Read 200 unpaid shifts, the most it reads (oldest first). Newer shifts may be missing, so the total may be short.');
  const notFull = (await digestAt(now, { shifts: many.slice(0, 199) })).lines;
  assert.ok(!notFull.some((l) => l.includes('the most it reads')));
  pass('fails soft: a failed or thrown shifts read drops the section, a failed roster read shows rate not set, and hitting the 200-row read limit is said out loud');
}

// ── 8. The real cron path: the Monday digest carries it, Sunday does not ──
async function cronDigestAt(iso, shifts) {
  const sent = [];
  const originalFetch = globalThis.fetch;
  const realNow = Date.now;
  globalThis.fetch = async (urlValue, options = {}) => {
    const url = String(urlValue);
    if (url.includes('api.telegram.org')) {
      sent.push(JSON.parse(options.body));
      return { ok: true, status: 200, async json() { return { ok: true }; }, async text() { return '{"ok":true}'; } };
    }
    const body = url.startsWith(SB + '/rest/v1/shifts?') ? byClockIn(shifts)
      : url.startsWith(SB + '/rest/v1/field_workers?') ? WORKERS : [];
    return { ok: true, status: 200, async json() { return body; }, async text() { return JSON.stringify(body); } };
  };
  Date.now = () => T(iso);
  const waits = [];
  try {
    await worker.scheduled({ cron: '0 12 * * *' }, { ...ENV, ALLOWED_CHAT_IDS: '111' }, { waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
  } finally { globalThis.fetch = originalFetch; Date.now = realNow; }
  return sent;
}
{
  const monday = await cronDigestAt('2026-11-16T12:00:00Z', MAIN_ROWS);
  assert.equal(monday.length, 1, 'one digest message');
  assert.equal(monday[0].chat_id, '111');
  assert.equal(monday[0].parse_mode, 'Markdown');
  assert.ok(monday[0].text.startsWith('🥥 *Daily Game Plan*'));
  assert.ok(!monday[0].text.includes('Scheduled job failed'));
  const at = monday[0].text.indexOf('\n💵 Payroll due today for Mon Nov 9 to Sun Nov 15\n');
  assert.ok(at > 0, 'the section sits in the digest after a blank line');
  const section = monday[0].text.slice(at + 1);
  assert.ok(section.includes('  Total due today: $1469.86\n  This week, not due yet:\n  • Alex Example - 1 shift · 2:00 · $24.68'));
  // Telegram Markdown would choke on these; names are made safe by tgSafe.
  assert.ok(!/[_*`[]/.test(section), 'no Markdown control characters in the section');
  const sunday = await cronDigestAt('2026-11-15T12:00:00Z', MAIN_ROWS);
  assert.equal(sunday.length, 1);
  assert.ok(!sunday[0].text.includes('Payroll'), 'no payroll on Sunday');
  pass('cron path: the 12:00 UTC digest carries the section on Monday (Markdown-safe), and nothing about payroll on Sunday');
}

// ── 9. Source pins ───────────────────────────────────────────────────
{
  const src = readFileSync(join(here, 'worker.js'), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(src.includes("\nconst PAYROLL_DIGEST_WEEKDAY = 'Mon';\n"), 'the knob says Monday');
  // The pay math itself is untouched (byte for byte as in d7af6c5).
  for (const body of [
    'function shiftMinutes(row) {\n  return Math.max(0, Math.floor((new Date(row.clock_out_at) - new Date(row.clock_in_at)) / 60000));\n}',
    'function payCents(mins, rateCents) {\n  return Math.round(mins * rateCents / 60);  // half-up on positive values\n}',
    "function fmtHm(mins) {\n  return Math.floor(mins / 60) + ':' + String(mins % 60).padStart(2, '0');\n}",
    "function usd(cents) {\n  return '$' + (cents / 100).toFixed(2);\n}",
  ]) assert.ok(src.includes(body), 'unchanged: ' + body.split('\n')[0]);
  // The new block has no en or em dash (built from code points, so this
  // file never contains one either).
  const block = src.slice(src.indexOf('const PAYROLL_READ_LIMIT'), src.indexOf('// ── APNs push -> droplet queue'));
  assert.ok(block.length > 1000, 'block found');
  const dashes = new RegExp('[' + String.fromCharCode(0x2013, 0x2014) + ']');
  assert.ok(!dashes.test(block), 'no dashes in the payroll block');
  assert.ok(!/Sunday-only|Sunday reminder|'  Total owed: '|Payroll - unpaid shifts|over 40h this week/.test(block), 'no Sunday wording left');
  // Still called once from the daily digest.
  const digest = src.slice(src.indexOf('async function runDailyDigest(env)'), src.indexOf('async function runReconfirmationScan(env)'));
  assert.equal(digest.split('await buildPayrollDigestLines(env)').length, 2, 'one call in runDailyDigest');
  pass('source: knob is Mon, pay math byte for byte unchanged, no dashes or Sunday words in the block, one call from the digest');
}

console.log(`\nPASS: ${passed} payroll digest checks. Fake network only, no database, no Telegram.`);

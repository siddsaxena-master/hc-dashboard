// Tests for the automatic crew plan (migration 073): the pure rules in
// worker/crew-plan.js and the robot scan in worker.js (runCrewPlanScan),
// against the shared contract worker/test-vectors/crew-plan-cases.json
// (copied byte for byte from HC Secure Backups/tools/crew/073/tests/ and
// pinned by sha256 below) and a fake network. Nothing here can reach
// Supabase, Apple, Telegram or a phone.
//
// Run it with:  node worker/test-crew-plan.mjs
//
// Every case of the vectors file that lists the "worker" package runs here.
// Synthetic data only (Client W, Garage G, Ana, Ben, Cy, Zed).

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as crew from './crew-plan.js';
import * as W from './worker.js';

let passed = 0;
const pass = (m) => { passed++; console.log('PASS: ' + m); };

// -- the contract file, pinned ---------------------------------------
const VECTORS_SHA256 = 'b9887715a68e9ceb5d9ca739fb8e6c3dcaaa18f243b93f62af3078bb1b77d0ab';
const rawVectors = readFileSync(new URL('./test-vectors/crew-plan-cases.json', import.meta.url));
assert.equal(createHash('sha256').update(rawVectors).digest('hex'), VECTORS_SHA256, 'crew-plan-cases.json must be the pinned copy, byte for byte');
const V = JSON.parse(rawVectors.toString('utf8'));
const WORKER_CASES = V.cases.filter((c) => c.packages.includes('worker'));
assert.equal(WORKER_CASES.length, 97, 'the contract lists 97 worker cases');
pass('vectors file is the pinned copy (sha256 b9887715...), 97 worker cases');

const LIB = { parseArrivalTime: W.parseArrivalTime, leaveByMs: W.leaveByMs, routeSanity: W.routeSanity, marketZone: W.marketZone };
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const APP_REVIEW = 'appreview@hamptonscoconuts.com';

// -- fixtures (merge_rules) ------------------------------------------
function expandTasks(v) {
  if (typeof v === 'string' && v.startsWith('$task:')) return clone(V.named_tasks[v.slice(6)]);
  if (Array.isArray(v)) return v.map(expandTasks);
  if (v && typeof v === 'object') {
    if (typeof v.$task === 'string') {
      const { $task, ...rest } = v;
      return { ...clone(V.named_tasks[$task]), ...expandTasks(rest) };
    }
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = expandTasks(x);
    return out;
  }
  return v;
}
function rowKey(table, row) {
  if (table === 'route_answers') return String(row.from_site) + '|' + String(row.to_site || row.to_address);
  const keys = V.table_keys[table] || ['id'];
  return keys.map((k) => String(row[k])).join('|');
}
function applyLayer(state, layer) {
  if (!layer) return state;
  if (layer.now !== undefined) state.now = layer.now;
  if (Object.prototype.hasOwnProperty.call(layer, 'worker_mode')) state.worker_mode = layer.worker_mode;
  if (layer.settings) state.settings = { ...state.settings, ...clone(layer.settings) };
  for (const [table, rows] of Object.entries(layer.rows || {})) {
    state.rows[table] = state.rows[table] || [];
    for (const r of rows) {
      const k = rowKey(table, r);
      const i = state.rows[table].findIndex((x) => rowKey(table, x) === k);
      if (i >= 0) state.rows[table][i] = clone(r); else state.rows[table].push(clone(r));
    }
  }
  for (const [table, keys] of Object.entries(layer.remove || {})) {
    const drop = new Set(keys.map(String));
    state.rows[table] = (state.rows[table] || []).filter((x) => !drop.has(rowKey(table, x)));
  }
  return state;
}
function resolveFixture(name) {
  const f = expandTasks(V.fixtures[name]);
  const state = f.extends ? resolveFixture(f.extends) : { now: null, worker_mode: null, settings: {}, rows: {} };
  return applyLayer(state, f);
}
function resolveCase(c) {
  const inp = expandTasks(c.input || {});
  const state = inp.extends ? resolveFixture(inp.extends) : { now: null, worker_mode: null, settings: {}, rows: {} };
  return applyLayer(state, inp);
}
const SITE_DEFAULTS = { address: null, lat: null, lng: null, geo_status: 'pending', fence_m: 150, hold_nights: null, hold_confirmed: false, can_prep: 'unknown', opens_at: null, closes_at: null, active: true, version: 1 };
const CARD_DEFAULTS = { stage: 'auto', prep: 'auto', branding: 'auto', crew_start: null, people_min: null, extras: [], on_site: [], version: 1 };
const DAY_DEFAULTS = { status: 'draft', tasks: [], cancelled_keys: [], gaps: [], red_count: 0, amber_count: 0, inputs_md5: null, proposal: null, kept_md5: [], helper_told: {}, version: 1, approved_version: 0, approved_tasks_md5: null, approved_at: null, approved_by: null };
const ORDER_DEFAULTS = { company: null, venue: null, delivery_notes: null, crack_type: null, logo_received: false, logo_asset: null, external_invoice_id: null, parent_order_id: null, job_day_origin: null, cancelled_at: null, deposit_cents: 0, balance_cents: null, invoice_fulfillment: null, delivery_request: null };
// The robot person view (reply-shapes 2.7), as hc_crew_plan_inputs builds it.
function peopleView(state) {
  const rows = state.rows;
  const workers = new Map((rows.field_workers || []).map((w) => [w.id, w]));
  const never = new Set(state.settings.never_schedule || []);
  const tokens = new Set((rows.push_tokens || []).filter((t) => t.apns_token).map((t) => String(t.email).toLowerCase()));
  return (rows.crew_people || []).map((p) => {
    const w = p.worker_id ? workers.get(p.worker_id) : null;
    let lock = null;
    if (p.kind === 'roster') {
      if (!w) lock = 'inactive';
      else if (never.has(w.id)) lock = 'never_schedule';
      else if (String(w.email || '').toLowerCase() === APP_REVIEW) lock = 'app_review';
      else if (w.active === false) lock = 'inactive';
      else if (!w.auth_user_id) lock = 'no_login';
    }
    const email = w ? String(w.email || '').trim().toLowerCase() : null;
    return {
      person_id: p.id, kind: p.kind, worker_id: p.worker_id || null,
      name: p.kind === 'helper' ? p.helper_name : String((w && w.name) || '').split(' ')[0],
      helper_name: p.helper_name || null, role: w ? w.role : null,
      market: p.kind === 'helper' ? p.helper_market : (w ? w.market : null),
      auto_pick: p.auto_pick, drives: p.drives || 'unknown', rank: p.rank == null ? 100 : p.rank,
      active: p.active !== false, locked: !!lock, lock_reason: lock, has_login: !!(w && w.auth_user_id),
      has_push: !!(email && tokens.has(email)), version: p.version == null ? 1 : p.version, email,
    };
  });
}
// One stored day as hc_crew_plan_inputs returns it: the 12 keys of
// reply-shapes 4.1, plus (whole: true) the stored day state the worker
// uses for the owner nudges and the digest when it is there.
function dayView(d, whole = true) {
  const x = { ...DAY_DEFAULTS, ...d };
  const approvedLike = x.status === 'approved' || x.status === 'changed';
  const v = {
    market: x.market, day: x.plan_day, status: x.status, version: x.version, inputs_md5: x.inputs_md5,
    approved_version: x.approved_version, approved_tasks_md5: x.approved_tasks_md5, cancelled_keys: x.cancelled_keys,
    kept_md5: x.kept_md5, owner_tasks: (x.tasks || []).filter((t) => t.source === 'owner'),
    approved_tasks: approvedLike ? x.tasks : [], proposal_md5: x.proposal ? x.proposal.md5 : null,
  };
  if (whole) Object.assign(v, { tasks: x.tasks, gaps: x.gaps, red_count: x.red_count, amber_count: x.amber_count, proposal: x.proposal });
  return v;
}
function plannerInput(state, opts = {}) {
  const r = state.rows;
  return {
    now: state.now,
    settings: { mode: 'off', notify: false, manager_can_approve: false, never_schedule: [], version: 1, ...state.settings },
    rules: clone(r.crew_rules || []),
    sites: (r.crew_sites || []).map((s) => ({ ...SITE_DEFAULTS, ...s })),
    people: peopleView(state),
    jobs: (r.crew_jobs || []).map((j) => ({ ...CARD_DEFAULTS, ...j })),
    days: (r.crew_plan_days || []).map((d) => dayView(d, opts.whole !== false)),
    time_off: (r.field_time_off || []).filter((t) => t.status === 'approved' || t.status === 'pending').map((t) => ({ worker_id: t.worker_id, start_day: t.start_day, end_day: t.end_day, status: t.status })),
    orders: (r.orders || []).map((o) => ({ ...ORDER_DEFAULTS, ...o })),
    attachments: clone(r.order_invoices || []),
    supply: clone(r.coconut_supply_orders || []),
    findings: clone(r.hc_calendar_findings || []),
    proposals: clone(r.order_time_proposals || []).filter((p) => !p.status || p.status === 'pending'),
    departures: clone(r.order_departures || []),
    routes: clone(r.route_answers || []),
  };
}

// -- matching (match_rules) ------------------------------------------
function checkTask(label, actual, want) {
  for (const [k, v] of Object.entries(want)) {
    if (k === 'gaps_include') { for (const g of v) assert.ok(actual.gaps.includes(g), label + ': gaps include ' + g + ' (got ' + actual.gaps.join(',') + ')'); continue; }
    if (k === 'gaps_exclude') { for (const g of v) assert.ok(!actual.gaps.includes(g), label + ': gaps exclude ' + g); continue; }
    assert.deepEqual(actual[k], v, label + ': field ' + k);
  }
}
function checkGapEntry(actual, want) {
  return Object.entries(want).every(([k, v]) => JSON.stringify(actual[k]) === JSON.stringify(v));
}
function findDay(plan, market, day) {
  return plan.days.find((d) => d.market === market && d.day === day) || null;
}
function checkPlan(id, plan, exp) {
  for (const want of exp.days || []) {
    const label = id + ' ' + want.market + ' ' + want.day;
    const d = findDay(plan, want.market, want.day);
    assert.ok(d, label + ': the day exists');
    if (want.tasks) {
      if (want.tasks_exact !== false) assert.deepEqual(d.tasks.map((t) => t.key), want.tasks.map((t) => t.key), label + ': the ordered task keys');
      for (const wt of want.tasks) {
        const t = d.tasks.find((x) => x.key === wt.key);
        assert.ok(t, label + ': task ' + wt.key + ' exists');
        checkTask(label + ' ' + wt.key, t, wt);
      }
    }
    if (want.gaps) assert.deepEqual(d.gaps, want.gaps, label + ': the day gap entries');
    for (const g of want.gaps_include || []) assert.ok(d.gaps.some((x) => checkGapEntry(x, g)), label + ': gaps include ' + JSON.stringify(g) + ' (got ' + JSON.stringify(d.gaps) + ')');
    if (want.red_count !== undefined) assert.equal(d.red_count, want.red_count, label + ': red_count');
    if (want.amber_count !== undefined) assert.equal(d.amber_count, want.amber_count, label + ': amber_count');
  }
  for (const nd of exp.no_tasks || []) {
    const d = findDay(plan, nd.market, nd.day);
    assert.ok(!d || d.tasks.length === 0, id + ': no tasks on ' + nd.market + ' ' + nd.day);
  }
  const allTasks = plan.days.flatMap((d) => d.tasks);
  for (const k of exp.no_task_kinds || []) assert.ok(!allTasks.some((t) => t.kind === k), id + ': no task of kind ' + k);
  for (const k of exp.no_task_keys || []) assert.ok(!allTasks.some((t) => t.key === k), id + ': no task with key ' + k);
  for (const p of exp.never_people || []) assert.ok(!allTasks.some((t) => t.people.some((x) => x.person_id === p)), id + ': never person ' + p);
  for (const s of exp.never_sites || []) assert.ok(!allTasks.some((t) => t.from_site === s || t.to_site === s), id + ': never site ' + s);
  for (const c of exp.gaps_absent || []) assert.ok(!plan.days.some((d) => d.gaps.some((g) => g.code === c)), id + ': no gap ' + c);
  for (const txt of exp.forbidden_text_in_words || []) assert.ok(!allTasks.some((t) => String(t.words).includes(txt)), id + ': no words contain ' + txt);
  if (exp.totals) {
    const days = plan.days.filter((d) => d.tasks.length);
    assert.equal(allTasks.length, exp.totals.rows, id + ': total rows');
    assert.equal(allTasks.filter((t) => t.source === 'owner').length, exp.totals.rows_typed_by_hand, id + ': rows typed by hand');
    assert.equal(days.reduce((s, d) => s + d.red_count, 0), exp.totals.red, id + ': total red');
    assert.equal(days.reduce((s, d) => s + d.amber_count, 0), exp.totals.amber, id + ': total amber');
  }
  if (exp.approve) {
    const withRows = plan.days.filter((d) => d.tasks.length);
    const clean = withRows.filter((d) => d.red_count === 0).map((d) => [d.market, d.day]);
    const red = withRows.filter((d) => d.red_count > 0).map((d) => [d.market, d.day]);
    assert.deepEqual(clean, exp.approve.clean_days, id + ': the clean days (Approve all clean days)');
    assert.deepEqual(red, exp.approve.red_days, id + ': the red days (one tap each)');
    if (exp.approve.taps !== undefined) assert.equal((clean.length ? 1 : 0) + red.length, exp.approve.taps, id + ': approve taps');
  }
}
function ownerBilled(state, task) {
  const parts = String(task.key).split(':');
  const card = (state.rows.crew_jobs || []).find((j) => j.order_id === parts[1]);
  const e = card && (card.extras || []).find((x) => x.key === parts[2]);
  return e ? e.billed === true : null;
}

// -- 1. md5 and small helpers ----------------------------------------
{
  const samples = ['', 'a', 'abc', 'hc-crew-v1ny2026-11-301', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), 'x'.repeat(1000), 'Cold storage B: ' + String.fromCharCode(233) + 't' + String.fromCharCode(233)];
  for (const s of samples) assert.equal(crew.md5Hex(s), createHash('md5').update(s, 'utf8').digest('hex'), 'md5 of ' + JSON.stringify(s.slice(0, 20)));
  assert.equal(crew.md5Uuid('hc-crew-tomorrow-v1ny2026-11-301' + '73b00000-0000-4000-8000-000000000002'), '653cb47e-13ca-2299-f504-16e0557a9252');
  assert.equal(crew.crewClock(360, 'ny'), '6:00 AM'); assert.equal(crew.crewClock(720, 'ny'), '12:00 PM'); assert.equal(crew.crewClock(1110, 'ny'), '6:30 PM');
  assert.equal(crew.crewClock(540, 'vegas'), '9:00 AM PT');
  assert.equal(crew.crewDayWords('2026-11-30', '2026'), 'Mon Nov 30'); assert.equal(crew.crewDayWords('2027-02-27', '2026'), 'Sat Feb 27, 2027');
  assert.deepEqual(crew.crewSupplyWindow('Arrival 10:00 AM - 06:00 PM'), { start: 600, end: 1080 });
  assert.equal(crew.crewSupplyWindow('Arrival 10:00 AM'), null);
  assert.equal(crew.crewStateOf('Test Barn, 4 Test Rd, Testtown, IL 60000'), 'IL');
  assert.equal(crew.crewZipOf('Test Pier, 1 Test Pier, New York, NY 10011'), '10011');
  assert.equal(crew.crewOrderDay({ delivery_at_utc: '2026-12-04T02:00:00+00:00' }), '2026-12-03');
  assert.equal(crew.crewOrderDay({ delivery_at_utc: '2026-12-03T00:00:00+00:00' }), '2026-12-03');
  for (const bad of ['a@b', '$5', 'call 212-555-1234', '1234567', 'http://x', 'tab\there']) assert.equal(crew.crewTextOk(bad), false, 'word check refuses ' + bad);
  assert.equal(crew.crewTextOk('Test Pier, 1 Test Pier, New York, NY 10011'), true);
  assert.equal(crew.crewCleanAddress('Test Pier, 1 Test Pier, New York, NY 10011, call 212-555-1234'), 'Test Pier, 1 Test Pier, New York, NY 10011');
  pass('md5 equals node:crypto (multi-block, unicode), the 070 uuid shape, clock, day words, drop window, state, zip, day marker and the word check');
}
{
  // The catalog in crew-plan.js equals the contract's 41 gap codes.
  const codes = Object.keys(V.gap_codes).sort();
  assert.deepEqual(Object.keys(crew.CREW_GAPS).sort(), codes);
  for (const c of codes) assert.deepEqual(crew.CREW_GAPS[c], [V.gap_codes[c].level, V.gap_codes[c].owner_only], 'gap ' + c);
  assert.equal(codes.length, 41);
  pass('the gap catalog equals the contract (41 codes, levels and owner_only)');
}

// -- 2. every pure-rule case -----------------------------------------
const PLAN_RULES = new Set(['SCENARIO', 'R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9', 'R10', 'R11', 'R12', 'R13']);
const planCases = WORKER_CASES.filter((c) => PLAN_RULES.has(c.rule) && !c.input.calls);
for (const c of planCases) {
  const state = resolveCase(c);
  if (c.expected.variants) {
    const base = crew.planCrew(plannerInput(state), LIB);
    for (const vnt of c.expected.variants) {
      const next = applyLayer(JSON.parse(JSON.stringify(state)), { rows: vnt.patch });
      const after = crew.planCrew(plannerInput(next), LIB);
      for (const d of vnt.same_days || []) {
        const a = findDay(base, 'ny', d), b = findDay(after, 'ny', d);
        assert.ok(a && b, c.id + ' ' + vnt.label + ': day ' + d + ' exists');
        assert.equal(b.inputs_md5, a.inputs_md5, c.id + ' ' + vnt.label + ': same md5 on ' + d);
        if (vnt.rows_identical) assert.equal(JSON.stringify(b.tasks), JSON.stringify(a.tasks), c.id + ': byte-identical rows on ' + d);
      }
      for (const d of vnt.differ_days || []) {
        const a = findDay(base, 'ny', d), b = findDay(after, 'ny', d);
        assert.ok(a && b, c.id + ' ' + vnt.label + ': day ' + d + ' exists');
        assert.notEqual(b.inputs_md5, a.inputs_md5, c.id + ' ' + vnt.label + ': md5 differs on ' + d);
      }
    }
    pass(c.id + ': ' + c.about.slice(0, 110));
    continue;
  }
  const plan = crew.planCrew(plannerInput(state), LIB);
  checkPlan(c.id, plan, c.expected);
  if (c.expected.owner_view) {
    for (const [key, want] of Object.entries(c.expected.owner_view)) {
      const t = plan.days.flatMap((d) => d.tasks).find((x) => x.key === key);
      assert.ok(t, c.id + ': owner view task ' + key);
      assert.equal(ownerBilled(state, t), want.billed, c.id + ': billed flag of ' + key + ' (owner only)');
      assert.ok(!('billed' in t), c.id + ': the stored task never carries billed');
    }
  }
  // Same inputs give byte-identical output.
  const again = crew.planCrew(plannerInput(resolveCase(c)), LIB);
  assert.equal(JSON.stringify(again.days), JSON.stringify(plan.days), c.id + ': same inputs, byte-identical days and md5');
  pass(c.id + ': ' + c.about.slice(0, 110));
}

// -- 3. the robot (runCrewPlanScan) against a fake network -----------
const SB = 'https://example.invalid';
const ENV = { SUPABASE_URL: SB, SUPABASE_SERVICE_KEY: 'not-a-real-key' };
async function fakeAppleKeyPem() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  return '-----BEGIN PRIVATE KEY-----\n' + Buffer.from(der).toString('base64').replace(/(.{64})/g, '$1\n') + '\n-----END PRIVATE KEY-----\n';
}
const APPLE = { APPLE_MAPS_KEY_ID: 'ABCDEFGHIJ', APPLE_MAPS_TEAM_ID: 'TEAM123456', APPLE_MAPS_PRIVATE_KEY: await fakeAppleKeyPem() };
const reply = (status, data) => ({ ok: status >= 200 && status < 300, status, async json() { return data; }, async text() { return data == null ? '' : JSON.stringify(data); } });
const realNow = Date.now;
async function at(iso, fn) { Date.now = () => Date.parse(iso); try { return await fn(); } finally { Date.now = realNow; } }
const distM = (a, b) => { const R = 6371000, r = (x) => x * Math.PI / 180; const dLat = r(b.lat - a.lat), dLng = r(b.lng - a.lng); const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };

// The fake world: the resolved fixture state is the database. The 073
// functions follow reply-shapes-073.md; hc_crew_plan_put follows design 4.5
// and changes the state, so a second run sees the first run's writes.
// opts: whole (default true: days come whole), fault, crewOriginsReply,
// anyRoute (the fake router answers every pair), missingRpc.
function crewWorld(state, opts = {}) {
  const rows = state.rows;
  rows.crew_plan_days = rows.crew_plan_days || [];
  const calls = [], puts = [], runLogs = [], geoPuts = [], queue = [], rpc = {};
  const apple = { token: 0, geocode: 0, directions: 0, etas: 0 };
  const settings = () => ({ mode: 'off', notify: false, manager_can_approve: false, never_schedule: [], version: 1, ...state.settings });
  const todayOf = (m) => crew.crewDayInZone(Date.now(), W.marketZone(m));
  const sites = () => (rows.crew_sites || []).map((s) => ({ ...SITE_DEFAULTS, ...s }));
  const answers = () => rows.route_answers || [];
  const addressCoord = (q) => {
    const hit = answers().find((a) => a.to_address === q && Number.isFinite(a.dest_lat));
    if (hit) return { lat: hit.dest_lat, lng: hit.dest_lng };
    if (!opts.anyRoute) return null;
    let h = 0; for (const ch of String(q)) h = (h * 31 + ch.charCodeAt(0)) % 997;
    return { lat: 40.7 + h / 10000, lng: -73.95 - h / 10000 };
  };
  const answerFor = (originText, destText) => {
    const [olat, olng] = String(originText).split(',').map(Number);
    const [dlat, dlng] = String(destText).split(',').map(Number);
    const from = sites().find((s) => s.lat === olat && s.lng === olng);
    const toSite = sites().find((s) => s.lat === dlat && s.lng === dlng);
    const straight = distM({ lat: olat, lng: olng }, { lat: dlat, lng: dlng });
    const ans = from && answers().find((a) => a.from_site === from.id && Number.isFinite(a.drive_seconds)
      && (toSite ? a.to_site === toSite.id : (a.to_address && (() => { const c = addressCoord(a.to_address); return c && c.lat === dlat && c.lng === dlng; })())));
    if (ans) return { drive_seconds: ans.drive_seconds, meters: Math.max(ans.meters || 0, Math.round(straight * 1.3)), has_ferry: !!ans.has_ferry };
    return opts.anyRoute ? { drive_seconds: 1800, meters: Math.round(straight * 1.3) + 1000, has_ferry: false } : null;
  };
  const inputsReply = (b) => {
    const s = settings();
    const base = { v: 1, code: 'ok', mode: s.mode, notify: s.notify === true, manager_can_approve: s.manager_can_approve === true, never_schedule: s.never_schedule || [], settings_version: s.version,
      today: { ny: todayOf('ny'), vegas: todayOf('vegas'), miami: todayOf('miami'), la: todayOf('la') }, from: b.p_from, to: b.p_to };
    if (s.mode === 'off') return { ...base, code: 'off', rules: [], sites: [], people: [], jobs: [], days: [], time_off: [], message: 'The crew plan is off.' };
    const pi = plannerInput(state, { whole: opts.whole !== false });
    return { ...base, rules: pi.rules, sites: pi.sites, people: pi.people, jobs: pi.jobs, days: pi.days.filter((d) => d.day >= b.p_from && d.day <= b.p_to), time_off: pi.time_off, message: null };
  };
  const applyPut = (b) => {
    const s = settings();
    const out = (code, message, d) => ({ v: 1, code, message, repeat: false, market: b.p_market, day: b.p_day, status: d ? d.status : null, version: d ? d.version : null, inputs_md5: d ? d.inputs_md5 : null });
    if (s.mode === 'off') return out('off', 'The crew plan is off. Nothing was saved.', null);
    if (b.p_day < todayOf(b.p_market)) return out('frozen', 'That day is over. Nothing was saved.', null);
    let i = rows.crew_plan_days.findIndex((x) => x.market === b.p_market && x.plan_day === b.p_day);
    const cur = i >= 0 ? { ...DAY_DEFAULTS, ...rows.crew_plan_days[i] } : null;
    if ((cur ? cur.version : 0) !== b.p_expected_version) return out('stale', 'This changed since you looked. Nothing was saved.', cur);
    if (cur && cur.inputs_md5 === b.p_inputs_md5) return out('same', 'No change.', cur);
    const d = cur || { ...DAY_DEFAULTS, market: b.p_market, plan_day: b.p_day, version: 0 };
    if (d.status === 'approved' || d.status === 'changed') {
      if ((d.kept_md5 || []).includes(b.p_inputs_md5)) { Object.assign(d, { proposal: null, status: 'approved', inputs_md5: b.p_inputs_md5, version: d.version + 1 }); rows.crew_plan_days[i] = d; return out('kept', 'Sidd kept his plan for these facts.', d); }
      Object.assign(d, { proposal: { tasks: clone(b.p_tasks), gaps: clone(b.p_gaps), reasons: clone(b.p_reasons), md5: b.p_inputs_md5 }, status: 'changed', inputs_md5: b.p_inputs_md5, version: d.version + 1 });
      rows.crew_plan_days[i] = d;
      return out('change_proposed', 'New plan waiting for Sidd.', d);
    }
    const owner = (d.tasks || []).filter((t) => t.source === 'owner');
    const held = new Set([...(d.cancelled_keys || []), ...owner.map((t) => t.key)]);
    d.tasks = [...clone(b.p_tasks).filter((t) => !held.has(t.key)), ...owner];
    d.gaps = clone(b.p_gaps).filter((g) => g.task_key == null || d.tasks.some((t) => t.key === g.task_key));
    d.red_count = d.gaps.filter((g) => g.level === 'red').length;
    d.amber_count = d.gaps.length - d.red_count;
    Object.assign(d, { inputs_md5: b.p_inputs_md5, status: 'draft', version: d.version + 1 });
    if (i >= 0) rows.crew_plan_days[i] = d; else rows.crew_plan_days.push(d);
    return out('written', 'Draft saved.', d);
  };
  const list = (path) => {
    const [table, qs] = path.split('?');
    const q = new URLSearchParams(qs || '');
    const offset = Number(q.get('offset') || 0), limit = Number(q.get('limit') || 1000);
    const inList = (v) => (v && v.startsWith('in.(') ? v.slice(4, -1).split(',').map((x) => x.replace(/"/g, '')) : null);
    let out = [];
    if (table === 'orders') {
      const all = (rows.orders || []).map((o) => ({ ...ORDER_DEFAULTS, ...o }));
      const ids = inList(q.get('id'));
      const or = q.get('or') || '';
      if (ids) out = all.filter((o) => ids.includes(o.id));
      else if (or.startsWith('(id.in.')) {
        const fam = (/id\.in\.\(([^)]*)\)/.exec(or) || [])[1].split(',');
        out = all.filter((o) => fam.includes(o.id) || fam.includes(o.parent_order_id));
      } else {
        out = all.filter((o) => ['invoiced', 'deposit_paid', 'paid_full'].includes(o.stage));
        if (opts.fault === 'orders_page_2_fails') {
          if (offset >= 1000) return [500, { message: 'page 2 failed' }];
          const pad = [];
          for (let k = out.length; k < 1000; k++) pad.push({ ...ORDER_DEFAULTS, id: '73d00000-0000-4000-9000-' + String(k).padStart(12, '0'), client_name: 'Filler', market: 'ny', stage: 'invoiced', delivery_at_utc: '2030-01-01T00:00:00+00:00' });
          out = [...out, ...pad];
        }
      }
    } else if (table === 'order_invoices') {
      const heads = inList(q.get('head_order_id')) || [];
      out = (rows.order_invoices || []).filter((a) => heads.includes(a.head_order_id) && !a.detached_at);
    } else if (table === 'coconut_supply_orders') {
      out = (rows.coconut_supply_orders || []).filter((r) => r.status === 'confirmed' || r.status === 'claimed');
    } else if (table === 'hc_calendar_findings') {
      const ids = inList(q.get('order_id')) || [];
      out = (rows.hc_calendar_findings || []).filter((f) => ids.includes(f.order_id) && (f.status === 'open' || f.status === 'still_on'));
    } else if (table === 'order_time_proposals') {
      const ids = inList(q.get('order_id')) || [];
      out = (rows.order_time_proposals || []).filter((p) => ids.includes(p.order_id) && (p.status || 'pending') === 'pending');
    } else if (table === 'order_departures') out = clone(rows.order_departures || []);
    else if (table === 'push_tokens') {
      const emails = (inList(q.get('email')) || []).map((e) => e.toLowerCase());
      out = (rows.push_tokens || []).filter((t) => emails.includes(String(t.email).toLowerCase()));
    } else if (table === 'field_workers') out = (rows.field_workers || []).filter((w) => w.active !== false);
    else if (table === 'shifts') out = clone(opts.shifts || []);
    else if (table === 'push_queue') out = [];
    else return [404, { message: 'unknown table ' + table }];
    return [200, out.slice(offset, offset + limit)];
  };
  const original = globalThis.fetch;
  globalThis.fetch = async (urlValue, options = {}) => {
    const url = String(urlValue);
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, method, body });
    const u = new URL(url);
    if (u.origin === 'https://maps-api.apple.com') {
      if (u.pathname === '/v1/token') { apple.token++; return reply(200, { accessToken: 'fake-access', expiresInSeconds: 1800 }); }
      if (u.pathname === '/v1/geocode') { apple.geocode++; const c = addressCoord(u.searchParams.get('q')); return reply(200, { results: c ? [{ coordinate: { latitude: c.lat, longitude: c.lng } }] : [] }); }
      if (u.pathname === '/v1/directions') { apple.directions++; const a = answerFor(u.searchParams.get('origin'), u.searchParams.get('destination')); return reply(200, a ? { routes: [{ name: 'Test Rd', distanceMeters: a.meters, durationSeconds: a.drive_seconds }], steps: [{ instructions: a.has_ferry ? 'Take the ferry' : 'Head north' }] } : { routes: [] }); }
      if (u.pathname === '/v1/etas') { apple.etas++; const a = answerFor(u.searchParams.get('origin'), u.searchParams.get('destinations')); return reply(200, a ? { etas: [{ expectedTravelTimeSeconds: a.drive_seconds, staticTravelTimeSeconds: a.drive_seconds, distanceMeters: a.meters }] } : { etas: [] }); }
      return reply(404, {});
    }
    if (!url.startsWith(SB + '/rest/v1/')) throw new Error('unexpected offline fetch: ' + method + ' ' + url);
    const path = url.slice((SB + '/rest/v1/').length);
    if (method === 'POST' && path.startsWith('rpc/')) {
      const name = path.slice(4);
      rpc[name] = (rpc[name] || 0) + 1;
      if (opts.missingRpc) return reply(404, { code: 'PGRST202', message: 'not found' });
      if (name === 'hc_crew_plan_inputs') return reply(200, inputsReply(body));
      if (name === 'hc_crew_plan_put') { puts.push(clone(body)); return reply(200, applyPut(body)); }
      if (name === 'hc_crew_run_log') { runLogs.push(clone(body)); return reply(200, { v: 1, code: 'done', message: 'Logged.', repeat: false, id: runLogs.length }); }
      if (name === 'hc_crew_site_geo_put') {
        geoPuts.push(clone(body));
        const site = (rows.crew_sites || []).find((s) => s.id === body.p_site_id);
        if (!site || site.geo_status !== 'pending') return reply(200, { v: 1, code: 'already', message: 'Already geocoded.', site_id: body.p_site_id, version: site ? site.version : null, geo_status: site ? site.geo_status : null });
        Object.assign(site, { lat: body.p_lat, lng: body.p_lng, geo_status: body.p_status, version: (site.version || 1) + 1 });
        return reply(200, { v: 1, code: 'done', message: null, site_id: site.id, version: site.version, geo_status: site.geo_status });
      }
      if (name === 'hc_crew_departure_origins') return reply(200, opts.crewOriginsReply || { v: 1, code: settings().mode === 'on' ? 'ok' : 'off', trips: [], message: null });
      return reply(404, {});
    }
    if (method === 'GET') { const [status, data] = list(path); return reply(status, data); }
    if (method === 'POST' && path === 'push_queue') { queue.push(clone(body)); return reply(201, null); }
    throw new Error('unexpected offline fetch: ' + method + ' ' + url);
  };
  // Banners as the contract's "sends": person_id from the token's email.
  const sends = () => queue.map((row) => {
    const p = row.payload;
    const emails = p.tokens.map((t) => ((rows.push_tokens || []).find((x) => x.apns_token === t) || {}).email);
    const workers = emails.map((e) => (rows.field_workers || []).find((w) => String(w.email).toLowerCase() === String(e).toLowerCase()));
    const person = workers.length === 1 && workers[0] ? (rows.crew_people || []).find((cp) => cp.worker_id === workers[0].id) : null;
    return { kind: p.body.kind, person_id: person ? person.id : null, to: workers.length && workers.every((w) => w && w.role === 'owner') ? 'owner' : null, id: row.id,
      title: p.aps.alert.title, body: p.aps.alert.body, thread_id: p.aps['thread-id'] || null, collapse_id: p.headers.collapse_id, time_sensitive: p.aps['interruption-level'] === 'time-sensitive', tokens: p.tokens };
  });
  return { calls, puts, runLogs, geoPuts, queue, rpc, apple, sends, restore: () => { globalThis.fetch = original; } };
}
async function scan(state, opts = {}) {
  const w = crewWorld(state, opts);
  const env = { ...ENV, ...(state.worker_mode ? { CREW_PLAN_MODE: state.worker_mode } : {}), ...(opts.apple ? APPLE : {}) };
  try {
    const counts = await at(opts.now || state.now, () => W.runCrewPlanScan(env));
    return { w, counts };
  } finally { w.restore(); }
}
const caseById = (id) => WORKER_CASES.find((c) => c.id === id);
function subsetEqual(label, actual, want) {
  for (const [k, v] of Object.entries(want)) assert.deepEqual(actual[k], v, label + ': ' + k);
}
const DAY_KEYS = ['tasks', 'gaps', 'red_count', 'amber_count'];

// -- 3a. the scan writes the same plan the pure rules make -----------
{
  for (const id of ['SCN-01', 'SCN-02', 'SCN-03']) {
    const c = caseById(id);
    const state = resolveCase(c);
    const { w, counts } = await scan(state, { apple: true });
    assert.equal(counts.mode, 'practice');
    assert.equal(counts.error, null, id + ': no error');
    const plan = crew.planCrew(plannerInput(resolveCase(c)), LIB);
    const written = plan.days.filter((d) => d.tasks.length || d.gaps.length).filter((d) => !d.frozen);
    for (const d of written) {
      const put = w.puts.find((p) => p.p_market === d.market && p.p_day === d.day);
      assert.ok(put, id + ': a put for ' + d.day);
      assert.deepEqual(put.p_tasks.map((t) => t.key), d.tasks.map((t) => t.key), id + ' ' + d.day + ': same rows as the pure rules');
      for (const t of put.p_tasks) {
        assert.deepEqual(Object.keys(t), crew.CREW_TASK_KEYS, id + ': every stored task has the 26 keys in order');
        const want = d.tasks.find((x) => x.key === t.key);
        const { route_at: a1, why: b1, ...gotRest } = t;
        const { route_at: a2, why: b2, ...wantRest } = want;
        assert.deepEqual(gotRest, wantRest, id + ' ' + d.day + ' ' + t.key + ': same task (the router answered what the fixture says)');
      }
      assert.deepEqual(put.p_gaps, d.gaps, id + ' ' + d.day + ': same gap entries');
      assert.equal(put.p_expected_version, 0, id + ': a new day is written at version 0');
      assert.equal(put.p_reasons.length, 0, id + ': no reasons on a draft');
    }
    checkPlan(id + ' via scan', { days: written.map((d) => ({ ...d, tasks: w.puts.find((p) => p.p_day === d.day).p_tasks.map(({ route_at, why, ...x }) => x) })) }, { days: c.expected.days });
    assert.equal(w.runLogs.length, 1, id + ': one run log');
    assert.ok(w.apple.etas <= crew.CREW_ROUTE_CALLS_MAX, id + ': at most 3 route calls');
    assert.equal(w.queue.length, 0, id + ': practice with notify off queues no banner');
  }
  pass('SCN-01/02/03 through runCrewPlanScan: the robot reads, routes (fake Apple from route_answers) and writes exactly the pure plan, 26 keys per task, one run log, no banner');
}

// -- 3b. PUT-13: an approved day keeps its people; the proposal says person_off
{
  const c = caseById('PUT-13');
  const state = resolveCase(c);
  const { w } = await scan(state);
  const put = w.puts.find((p) => p.p_market === c.expected.robot_put.market && p.p_day === c.expected.robot_put.day);
  assert.ok(put, 'PUT-13: the robot sends a put for the approved day');
  assert.deepEqual(put.p_tasks.map((t) => t.key), c.expected.robot_put.task_keys);
  for (const [k, people] of Object.entries(c.expected.robot_put.task_people)) assert.deepEqual(put.p_tasks.find((t) => t.key === k).people, people, 'PUT-13: people kept on ' + k);
  for (const [k, codes] of Object.entries(c.expected.robot_put.task_gaps_include)) for (const g of codes) assert.ok(put.p_tasks.find((t) => t.key === k).gaps.includes(g), 'PUT-13: ' + k + ' has ' + g);
  assert.equal(put.p_expected_version, 2);
  assert.ok(put.p_gaps.some((g) => g.code === 'person_off' && g.words === 'Ben has an approved day off.'));
  assert.equal(put.p_reasons[0], 'Ben has an approved day off.', 'PUT-13: the first reason names the day off');
  const day = state.rows.crew_plan_days.find((d) => d.plan_day === '2026-11-30');
  assert.equal(day.status, 'changed');
  assert.deepEqual(day.tasks.map((t) => t.key), ['deliver:73d00000-0000-4000-8000-000000000001', 'prep:73d00000-0000-4000-8000-000000000003'], 'PUT-13: the approved tasks are untouched');
  assert.equal(day.tasks[1].people[0].person_id, '73b00000-0000-4000-8000-000000000003');
  assert.deepEqual(day.proposal.gaps.map((g) => g.code).filter((x) => x === 'person_off'), c.expected.after.days[0].proposal_gap_codes);
  pass('PUT-13: the robot proposes the SAME rows for an approved day with red person_off on Ben\'s prep, never swaps him; the approved tasks stay as they were');
}
{
  // An approved day whose new plan equals the approved rows is left alone
  // (no put, so no "crew plan changed" banner for nothing).
  const state = resolveFixture('approved_week');
  const first = await scan(state);
  const nov30 = first.w.puts.find((p) => p.p_day === '2026-11-30');
  const fixture = resolveFixture('approved_week');
  const day = fixture.rows.crew_plan_days.find((d) => d.plan_day === '2026-11-30');
  day.tasks = nov30 ? nov30.p_tasks : day.tasks;
  const again = await scan(fixture);
  assert.ok(!again.w.puts.some((p) => p.p_day === '2026-11-30'), 'an approved day equal to the new plan gets no put');
  assert.ok(again.counts.quiet >= 1);
  pass('an approved day whose fresh plan equals its approved rows is not re-proposed (quiet), so Sidd gets no empty "plan changed"');
}

{
  // A job cancelled after its rows were drafted or approved: the draft day
  // loses its robot rows (put with no rows), the approved day gets a
  // proposal without them whose first reason says so (the database's
  // crew_change banner names it), and the approved rows stay untouched.
  const s = resolveFixture('approved_week');
  const w1 = s.rows.orders.find((o) => o.id === '73d00000-0000-4000-8000-000000000001');
  Object.assign(w1, { stage: 'cancelled', cancelled_at: '2026-11-27T00:30:00Z' });
  const q = s.rows.orders.find((o) => o.id === '73d00000-0000-4000-8000-000000000005');
  Object.assign(q, { stage: 'cancelled', cancelled_at: '2026-11-27T00:30:00Z' });
  const p = s.rows.orders.find((o) => o.id === '73d00000-0000-4000-8000-000000000003');
  Object.assign(p, { stage: 'cancelled', cancelled_at: '2026-11-27T00:30:00Z' });
  const { w } = await scan(s);
  const nov30 = w.puts.find((x) => x.p_day === '2026-11-30');
  assert.ok(nov30, 'the approved day gets a put');
  assert.deepEqual(nov30.p_tasks.map((t) => t.key), [], 'its proposal has no rows for the cancelled jobs');
  assert.equal(nov30.p_reasons[0], 'Client W was cancelled.');
  assert.ok(nov30.p_reasons.includes('Client P was cancelled.'));
  const day = s.rows.crew_plan_days.find((d) => d.plan_day === '2026-11-30');
  assert.equal(day.status, 'changed');
  assert.equal(day.tasks.length, 2, 'the approved rows are untouched');
  const dec1 = w.puts.find((x) => x.p_day === '2026-12-01');
  assert.ok(dec1 && !dec1.p_tasks.some((t) => t.order_id === p.id), 'the draft day drops the cancelled job\'s rows');
  pass('a cancelled job: the draft loses its rows, the approved day gets a proposal without them ("Client W was cancelled." first), approved rows untouched');
}

// -- 3c. SETUP-08: a pending place is geocoded once, never routed from -
{
  const c = caseById('SETUP-08');
  const state = resolveCase(c);
  const { w } = await scan(state, { apple: true, anyRoute: true });
  assert.equal(w.geoPuts.length, 1, 'SETUP-08: one geocode write');
  subsetEqual('SETUP-08', w.geoPuts[0], { p_site_id: '73c00000-0000-4000-8000-000000000002', p_version: 3, p_status: 'found' });
  assert.ok(Number.isFinite(w.geoPuts[0].p_lat) && Number.isFinite(w.geoPuts[0].p_lng));
  const second = await scan(state, { apple: true, anyRoute: true });
  assert.equal(second.w.geoPuts.length, 0, 'SETUP-08: found is never geocoded again (only Sidd confirms it)');
  const noKey = await scan(resolveCase(c));
  assert.equal(noKey.w.geoPuts.length, 0, 'no Apple key: no geocode write at all');
  pass('SETUP-08: the robot geocodes a pending cold storage once (found, version 3), never again, and only Sidd confirms it');
}

// -- 3d. WORDS-01: the one wording source ----------------------------
{
  const c = caseById('WORDS-01');
  const state = resolveCase(c);
  const pi = plannerInput(state);
  c.input = expandTasks(c.input);
  const got = c.input.words_from.map((x) => crew.crewWordsFor(x.task, x.market, { now: state.now, sites: pi.sites, people: pi.people, orders: pi.orders, jobs: pi.jobs, proposals: pi.proposals, held: x.held === true }, LIB));
  assert.deepEqual(got, c.expected.words);
  for (const s of got) assert.ok(crew.crewTextOk(s), 'WORDS-01: words pass the word check: ' + s);
  pass('WORDS-01: singular box, no time, no address, count unknown, an owner row, Vegas PT, the held constant, all from structured fields');
}

// -- 3e. NOTICE: the worker's timed banners --------------------------
// Each step runs on the case state plus that step's own layers. The
// robot's puts inside a tick are not carried to the next step: the
// contract's banner counts are those of the stored state as given.
for (const id of ['NOTICE-04', 'NOTICE-05', 'NOTICE-06', 'NOTICE-07']) {
  const c = caseById(id);
  const layers = (expandTasks(c.input).then) || [];
  const steps = [{ expected: c.expected, upTo: 0 }, ...layers.map((layer, i) => ({ upTo: i + 1, expected: c.expected.then[i] }))];
  for (const [si, step] of steps.entries()) {
    const state = resolveCase(c);
    for (const layer of layers.slice(0, step.upTo)) applyLayer(state, layer);
    const { w } = await scan(state);
    const sends = w.sends();
    if (step.expected.sends) {
      assert.equal(sends.length, step.expected.sends.length, id + ' step ' + si + ': the exact banner list (' + JSON.stringify(sends.map((s) => s.kind + ':' + (s.person_id || s.to))) + ')');
      step.expected.sends.forEach((want, i) => subsetEqual(id + ' step ' + si + ' send ' + i, sends[i], want));
    }
    for (const p of step.expected.never_to || []) assert.ok(!sends.some((s) => s.person_id === p), id + ': never to ' + p);
    for (const [m, kinds] of Object.entries(step.expected.never_kinds_for_market || {})) {
      for (const k of kinds) assert.ok(!w.queue.some((r) => r.payload.body.kind === k && r.payload.body.market === m), id + ': no ' + k + ' in ' + m);
    }
    for (const s of sends) {
      assert.ok(Buffer.byteLength(s.body, 'utf8') < 1500, id + ': body under 1500 bytes');
      assert.ok(!/[@$]|http|billed|weee/i.test(s.body), id + ': no money, email, link, billed or supplier word');
      assert.ok(!/^(prop|addr|art|coco)-/.test(String(s.collapse_id)) && !/^(prop|addr|art|coco)-/.test(String(s.thread_id || '')), id + ': never a Needs you strip prefix');
    }
  }
  pass(id + ': ' + c.about.slice(0, 110));
}
{
  // The 6 PM gate in both markets, the stable ids, and mode practice.
  const state = resolveFixture('approved_week');
  const kinds = async (iso, layer) => { const s = resolveFixture('approved_week'); if (layer) applyLayer(s, layer); const { w } = await scan(s, { now: iso }); return w.sends(); };
  assert.equal((await kinds('2026-11-29T22:30:00Z')).filter((s) => s.kind === 'crew_tomorrow').length, 0, '5:30 PM New York: too early');
  assert.equal((await kinds('2026-11-30T01:30:00Z')).filter((s) => s.kind === 'crew_tomorrow').length, 2, '8:30 PM New York: inside');
  assert.equal((await kinds('2026-11-30T02:30:00Z')).filter((s) => s.kind === 'crew_tomorrow').length, 0, '9:30 PM New York: outside');
  assert.equal((await kinds('2026-12-01T01:30:00Z')).filter((s) => s.kind === 'crew_tomorrow').length, 0, '5:30 PM Las Vegas: too early');
  assert.equal((await kinds('2026-12-01T04:30:00Z')).filter((s) => s.kind === 'crew_tomorrow').length, 1, '8:30 PM Las Vegas: inside');
  const a = await kinds('2026-11-29T23:30:00Z'), b = await kinds('2026-11-30T00:30:00Z');
  assert.deepEqual(a.map((s) => s.id), b.map((s) => s.id), 'the 6 PM and 7 PM ticks queue the SAME ids (the second is a no-op)');
  assert.equal((await kinds('2026-11-29T23:30:00Z', { settings: { mode: 'practice' } })).length, 0, 'mode practice: no crew banner');
  assert.equal((await kinds('2026-11-29T23:30:00Z', { settings: { notify: false } })).length, 0, 'notify off: nothing');
  void state;
  pass('crew_tomorrow: 18:00 to 21:00 market time in New York and Las Vegas, stable queue ids, nothing in practice or with notify off');
}
{
  // Locked people, helpers and the owner never get crew_tomorrow, even on a row.
  const s = resolveFixture('approved_week');
  const day = s.rows.crew_plan_days.find((d) => d.plan_day === '2026-11-30');
  day.tasks[1] = { ...day.tasks[1], people: [{ person_id: '73b00000-0000-4000-8000-000000000003', car: null }, { person_id: '73b00000-0000-4000-8000-000000000004', car: null }, { person_id: '73b00000-0000-4000-8000-000000000001', car: null }] };
  s.rows.crew_people.push({ id: '73b00000-0000-4000-8000-000000000004', kind: 'roster', worker_id: '73a00000-0000-4000-8000-000000000004', auto_pick: 'yes', drives: 'yes', rank: 1, active: true, version: 1 });
  const { w } = await scan(s, { now: '2026-11-29T23:30:00Z' });
  const to = w.sends().map((x) => x.person_id);
  assert.ok(!to.includes('73b00000-0000-4000-8000-000000000004'), 'never_schedule worker (Zed) gets nothing');
  assert.ok(!to.includes('73b00000-0000-4000-8000-000000000001'), 'the owner gets no crew_tomorrow');
  assert.ok(!to.includes('73b00000-0000-4000-8000-000000000009'), 'the helper gets nothing');
  assert.ok(!w.calls.some((c) => c.url.includes('push_tokens') && /zed%40|zed@/.test(c.url)), 'a locked person\'s tokens are never even read');
  pass('crew_tomorrow never reaches a never_schedule worker, the owner or a helper, even when they are on an approved row');
}
{
  // The first lock on its own: a helper never gets crew_tomorrow even if a
  // bad row ever carried an email for one (helpers have no login).
  const day = { market: 'ny', day: '2026-11-30', status: 'approved', approved_version: 1, approved_tasks: [{ ...V.named_tasks.T_W1 }] };
  const people = [{ person_id: '73b00000-0000-4000-8000-000000000002', kind: 'roster', worker_id: '73a00000-0000-4000-8000-000000000002', name: 'Ana', role: 'manager', market: 'ny', active: true, locked: false, email: 'ana@example.test' },
    { person_id: '73b00000-0000-4000-8000-000000000009', kind: 'helper', worker_id: null, name: 'Cy', helper_name: 'Cy', market: 'ny', active: true, locked: false, email: 'cy@example.test' }];
  const sends = crew.crewTomorrowSends(day, people, new Map([['73d00000-0000-4000-8000-000000000001', { id: '73d00000-0000-4000-8000-000000000001', stage: 'paid_full', delivery_at_utc: '2026-11-30T00:00:00+00:00', delivery_notes: 'Test Pier, 1 Test Pier, New York, NY 10011' }]]), [], {}, '2026');
  assert.deepEqual(sends.map((s) => s.person_id), ['73b00000-0000-4000-8000-000000000002'], 'only Ana; the helper is never a recipient');
  pass('a helper is never a crew_tomorrow recipient, even with an email on its row (first lock, the kind check)');
}
{
  // The strict 12-key day shape (no whole day state): crew_tomorrow is the
  // same (approved rows are always sent); the owner counts fall back to
  // the robot's own drafts and stay sane.
  const c = caseById('NOTICE-04');
  const { w } = await scan(resolveCase(c), { whole: false });
  assert.deepEqual(w.sends().map((s) => s.id), c.expected.sends.map((s) => s.id));
  const owner = await scan(resolveFixture('approved_week'), { whole: false, now: '2026-11-26T23:10:00Z' });
  const week = owner.w.sends().find((s) => s.kind === 'crew_owner');
  assert.ok(week && /^Next week's crew plan is ready: \d+ days?, \d+ questions?\.$/.test(week.body), 'the Thursday nudge still goes out with counts from the robot\'s drafts');
  pass('with the strict reply shape (days not sent whole) crew_tomorrow is unchanged and the owner nudges use the robot\'s own drafts');
}
{
  // NOTICE-08: the 8am digest line, a summary only.
  const c = caseById('NOTICE-08');
  const state = resolveCase(c);
  const w = crewWorld(state);
  let lines;
  try { lines = await at(state.now, () => W.buildCrewPlanDigestLines({ ...ENV, CREW_PLAN_MODE: state.worker_mode }, Date.parse(state.now))); } finally { w.restore(); }
  assert.deepEqual(lines, c.expected.digest_lines);
  for (const ch of c.expected.forbidden_chars) assert.ok(!lines.join('\n').includes(ch), 'NOTICE-08: no ' + ch);
  const off = crewWorld(resolveCase(c));
  let none;
  try { none = await W.buildCrewPlanDigestLines({ ...ENV }, Date.parse(state.now)); } finally { off.restore(); }
  assert.deepEqual(none, []);
  assert.equal(off.calls.length, 0, 'switch unset: the digest reads nothing');
  pass('NOTICE-08: "' + lines[0] + '"; no _ * backtick or [; switch unset reads nothing and adds nothing');
}
{
  // The practice scorecard (counts only, never pay).
  // Wed Nov 25 (in the 7 past days): one robot row (Ana), one row typed by
  // hand (Ben), one robot row Sidd edited (Ana), one robot row removed.
  const s = resolveFixture('approved_week');
  s.settings.mode = 'practice';
  const nov25 = s.rows.crew_plan_days.find((d) => d.plan_day === '2026-11-25');
  Object.assign(nov25, { version: 2, cancelled_keys: ['receive:7392'], tasks: [
    { ...V.named_tasks.T_RECV, key: 'receive:7390' }, { ...V.named_tasks.OWNER_ROW_03 }, { ...V.named_tasks.T_RECV, key: 'receive:7391', source: 'owner' }] });
  const w = crewWorld(s, { shifts: [{ worker_email: 'ana@example.test', clock_in_at: '2026-11-25T14:00:00Z' }, { worker_email: 'appreview@hamptonscoconuts.com', clock_in_at: '2026-11-25T14:00:00Z' }] });
  let lines;
  try { lines = await at('2026-11-27T13:00:00Z', () => W.buildCrewPlanDigestLines({ ...ENV, CREW_PLAN_MODE: 'practice' }, Date.parse('2026-11-27T13:00:00Z'))); } finally { w.restore(); }
  const card = lines.find((l) => l.startsWith('Crew plan 7 days'));
  assert.equal(card, 'Crew plan 7 days: 3 rows drafted, you changed 1, removed 1, added 1 by hand. Planned 2 people-days, clocked 1.');
  assert.ok(!/\$|rate|cents/.test(card));
  pass('practice scorecard: "' + card + '" (counts only, App Review shifts never count)');
}
{
  // NOTICE-10: every banner body the plan can make stays small and clean.
  const c = caseById('NOTICE-10');
  const state = resolveCase(c);
  const plan = crew.planCrew(plannerInput(state), LIB);
  const rules = c.expected.banner_rules;
  const people = peopleView(state);
  const bodies = [];
  for (const d of plan.days) {
    for (const t of d.tasks) bodies.push(t.words);
    const asApproved = { market: d.market, day: d.day, status: 'approved', approved_version: 1, approved_tasks: d.tasks };
    const ordersById = new Map(plannerInput(state).orders.map((o) => [o.id, o]));
    for (const s of crew.crewTomorrowSends(asApproved, people, ordersById, [], state.settings, '2026')) bodies.push(s.body);
  }
  assert.ok(bodies.length > 8);
  for (const b of bodies) {
    assert.ok(Buffer.byteLength(b, 'utf8') <= rules.max_body_bytes, 'NOTICE-10: under ' + rules.max_body_bytes + ' bytes');
    for (const t of rules.forbidden_text) assert.ok(!b.includes(t), 'NOTICE-10: no "' + t + '" in ' + b);
    for (const p of rules.forbidden_patterns) assert.ok(!new RegExp(p).test(b), 'NOTICE-10: no ' + p + ' in ' + b);
  }
  pass('NOTICE-10: every task sentence and crew_tomorrow body of the sidd-week plan is under 1500 bytes with no money, email, phone, long number, link, supplier word or billed');
}

// -- 3f. MODE: the switches ------------------------------------------
{
  const c = caseById('MODE-01');
  const { w, counts } = await scan(resolveCase(c));
  assert.deepEqual({ hc_crew_plan_inputs: w.rpc.hc_crew_plan_inputs || 0, hc_crew_plan_put: w.rpc.hc_crew_plan_put || 0, hc_crew_run_log: w.rpc.hc_crew_run_log || 0 }, c.expected.calls);
  assert.equal(w.calls.length, 0, 'MODE-01: not one request of any kind');
  assert.equal(w.queue.length, c.expected.crew_banners);
  assert.equal(counts.mode, 'off');
  for (const v of ['', ' ', 'ON ', 'onn', 'yes', 'true']) {
    const s = resolveCase(c); s.worker_mode = v;
    const r = await scan(s);
    assert.equal(r.w.calls.length, v.trim().toLowerCase() === 'on' ? r.w.calls.length : 0, 'a mistyped switch "' + v + '" is off');
  }
  pass('MODE-01: CREW_PLAN_MODE unset (or blank or mistyped) reads nothing and writes nothing, whatever the database says');
}
{
  const c = caseById('MODE-02');
  const state = resolveCase(c);
  const { w, counts } = await scan(state, { now: '2026-11-29T23:30:00Z' });
  assert.equal(counts.mode, c.expected.effective);
  assert.equal(w.queue.filter((r) => r.payload.body.kind === 'crew_tomorrow').length, c.expected.crew_banners);
  assert.ok(w.puts.length > 0, 'MODE-02: practice still drafts');
  applyLayer(state, expandTasks(c.input.then[0]));
  const off = await scan(state);
  assert.equal(off.counts.mode, c.expected.then[0].effective);
  assert.equal(off.w.rpc.hc_crew_plan_put || 0, c.expected.then[0].calls.hc_crew_plan_put);
  assert.equal(off.w.rpc.hc_crew_plan_inputs, 1, 'MODE-02: with the secret on the robot asks, and the database says off');
  pass('MODE-02: the lower switch wins (secret on + database practice = practice, no crew banner; database off = off, no put); departure origin is in test-departure-site-origin.mjs');
}
{
  const c = caseById('MODE-03');
  const { w, counts } = await scan(resolveCase(c), { fault: c.input.fault });
  assert.equal(w.rpc.hc_crew_plan_put || 0, c.expected.calls.hc_crew_plan_put);
  assert.equal(w.rpc.hc_crew_run_log || 0, c.expected.calls.hc_crew_run_log);
  assert.equal(!!w.runLogs[0].p_counts.error, c.expected.run_log_counts.error);
  assert.match(w.runLogs[0].p_counts.error, /orders read failed/);
  assert.ok(w.calls.some((x) => x.url.includes('offset=1000')), 'MODE-03: page 2 was asked for');
  assert.equal(counts.written, 0);
  pass('MODE-03: a failed second page of the orders read means no put that run, and the run log records the error');
}
{
  for (const failing of ['coconut_supply_orders', 'order_departures', 'order_time_proposals']) {
    const s = resolveCase(caseById('MODE-03'));
    const w = crewWorld(s, {});
    const inner = globalThis.fetch;
    globalThis.fetch = async (u, o) => (String(u).includes('/rest/v1/' + failing + '?') ? reply(500, { message: 'down' }) : inner(u, o));
    let counts;
    try { counts = await at(s.now, () => W.runCrewPlanScan({ ...ENV, CREW_PLAN_MODE: 'practice' })); } finally { w.restore(); }
    assert.equal(w.puts.length, 0, failing + ' failing: no put');
    assert.equal(w.runLogs.length, 1);
    assert.ok(counts.error, failing + ' failing: the error is logged');
  }
  pass('any failed input read (supply, departures, time proposals) means no put and one run log with the error');
}
{
  const c = caseById('MODE-04');
  const state = resolveCase(c);
  const first = await scan(state, { apple: true, anyRoute: true });
  assert.ok(first.counts.routes <= c.expected.route_calls_max, 'MODE-04: at most 3 route calls');
  assert.ok(first.w.apple.etas <= c.expected.route_calls_max);
  assert.ok(first.counts.routes >= 1);
  // Five delivery addresses: 3 routed the first hour, the other 2 the next,
  // and the cached ones are not asked again.
  const s5 = resolveFixture('setup');
  const addresses = ['Test Hall, 9 Test Ave, New York, NY 10001', 'Test Loft, 5 Test St, New York, NY 10002', 'Test Dock, 7 Test Pl, New York, NY 10014', 'Test Pier, 1 Test Pier, New York, NY 10011', 'Test Yard, 2 Test Ct, New York, NY 10003'];
  s5.rows.orders = addresses.map((a, i) => ({ id: '73d00000-0000-4000-8000-0000000003' + String(i).padStart(2, '0'), client_name: 'Client ' + 'ABCDE'[i], market: 'ny', stage: 'paid_full', coconuts_qty: 45, delivery_at_utc: '2026-12-0' + (i % 3 + 1) + 'T00:00:00+00:00', delivery_notes: a, stamp_status: 'not_needed', external_invoice_id: '9' + i, delivery_request: { status: 'confirmed', window: '10:00 AM', date: '2026-12-0' + (i % 3 + 1), source: 'owner' } }));
  s5.rows.coconut_supply_orders = [{ id: 7399, supplier: 'weee', delivery_date: '2026-11-28', delivery_window: 'Arrival 10:00 AM - 06:00 PM', market: 'ny', ship_to_garage: true, boxes: 30, status: 'confirmed', source: 'weee_email', recorded_by: 'poller' }];
  s5.rows.crew_jobs = s5.rows.orders.map((o) => ({ order_id: o.id, stage: 'never', prep: 'skip', branding: 'auto', extras: [], on_site: [], version: 1 }));
  const r1 = await scan(s5, { apple: true, anyRoute: true, now: '2026-11-27T00:58:00Z' });
  assert.equal(r1.counts.routes, 3, 'five unrouted trips: 3 route calls in the first run');
  const routed1 = r1.w.puts.flatMap((p) => p.p_tasks).filter((t) => t.kind === 'deliver' && t.drive_min != null).length;
  const pending1 = r1.w.puts.flatMap((p) => p.p_tasks).filter((t) => t.kind === 'deliver' && t.gaps.includes('route_pending')).length;
  assert.equal(routed1, 3); assert.equal(pending1, 2, 'the other two show amber route_pending');
  const r2 = await scan(s5, { apple: true, anyRoute: true, now: '2026-11-27T01:58:00Z' });
  assert.equal(r2.counts.routes, 2, 'the next run routes only the two that are left (the cache on the stored rows holds the rest)');
  const r3 = await scan(s5, { apple: true, anyRoute: true, now: '2026-11-27T02:58:00Z' });
  assert.equal(r3.counts.routes, 0, 'nothing left to route');
  assert.equal(r3.w.puts.length, 0, 'and nothing changed, so nothing is written');
  const r4 = await scan(s5, { apple: true, anyRoute: true, now: '2026-11-28T03:58:00Z' });
  assert.equal(r4.counts.routes, 3, 'after ' + c.expected.cache_hours + ' hours a draft day\'s drive times are asked again (3 a run)');
  pass('MODE-04: at most 3 route calls a run, cached on the stored rows for 24 hours while both ends are unchanged, the rest amber route_pending');
}
{
  const c = caseById('MODE-05');
  const state = resolveCase(c);
  const first = await scan(state, { apple: true });
  assert.ok(first.w.puts.length >= 5);
  const second = await scan(state, { apple: true, now: '2026-11-27T01:58:00Z' });
  const written = second.w.puts.filter(() => true).length;
  assert.equal(written, c.expected.second_run_written, 'MODE-05: the second run writes nothing');
  assert.equal(second.counts.written, 0);
  pass('MODE-05: only days whose inputs_md5 changed are written: a second run with nothing changed sends zero puts');
}
{
  // Before 073 is applied: one 404, nothing else, no error banner.
  const { w, counts } = await scan(resolveFixture('sidd_week'), { missingRpc: true });
  assert.equal(w.calls.length, 1);
  assert.equal(counts.written, 0);
  pass('before migration 073 (hc_crew_plan_inputs answers 404): one request, nothing written, nothing sent');
}
{
  // The cron wiring: '17 * * * *' runs the robot and nothing else.
  const src = readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
  const branch = src.slice(src.indexOf("cron === '17 * * * *'"), src.indexOf("cron === '*/5 * * * *'"));
  assert.equal((branch.match(/await run\w+\(/g) || []).join(','), 'await runCrewPlanScan(');
  const toml = readFileSync(new URL('./wrangler.toml', import.meta.url), 'utf8');
  const crons = (/crons = \[([\s\S]*?)\]/.exec(toml) || [])[1].match(/"[^"]+"/g);
  assert.deepEqual(crons, ['"0 12 * * *"', '"0 * * * *"', '"*/5 * * * *"', '"17 * * * *"'], 'wrangler.toml has exactly four cron lines (free plan: 5 per account)');
  const s = resolveFixture('sidd_week');
  const w = crewWorld(s);
  try {
    await at(s.now, async () => {
      let job = null;
      await W.default.scheduled({ cron: '17 * * * *' }, { ...ENV, CREW_PLAN_MODE: 'practice' }, { waitUntil: (p) => { job = p; } });
      await job;
    });
  } finally { w.restore(); }
  assert.equal(w.rpc.hc_crew_plan_inputs, 1, 'the cron tick asked for the inputs once');
  assert.ok(w.rpc.hc_crew_plan_put >= 5, 'and wrote the drafts');
  assert.equal(w.rpc.hc_crew_run_log, 1);
  pass('cron wiring: wrangler.toml lists 4 crons, and the "17 * * * *" tick runs runCrewPlanScan only (inputs once, drafts, one run log)');
}

console.log('\n' + passed + ' crew plan checks passed. Fake network only: no database, no Apple, no Telegram, no phone.');

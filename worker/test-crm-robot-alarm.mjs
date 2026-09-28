// Tests for the CRM mail reader alarm in worker.js (CRM Step C, plan
// section 5 item 1). The alarm reads hc_crm_robot_health() every 5
// minutes and sends ONE Telegram message when the droplet's mail reader
// stops and ONE when it is back, never repeating.
//
// Run it with:  node worker/test-crm-robot-alarm.mjs
//
// No test framework and no network. The global fetch is swapped for a
// fake that plays Supabase (the two robot RPCs) and Telegram, so nothing
// here can touch the real database or send a real message.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  crmAlarmDecision, crmAlarmStampMs, crmAlarmInWindow, crmAlarmStaleText,
  runCrmRobotAlarmScan, CRM_ALARM_BACK_TEXT,
} from './worker.js';

const MIN = 60 * 1000;
// 12:00 PM Eastern (daylight time) on 2026-09-28, inside the 7 AM to 11 PM window.
const NOON = Date.parse('2026-09-28T16:00:00Z');
// 3:00 AM Eastern the same day, outside the window.
const NIGHT = Date.parse('2026-09-28T07:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

// A health answer shaped like 052's R4 (only the keys the alarm reads
// matter; the rest are there so the shape looks real).
function health(nowMs, extra = {}) {
  return {
    v: 1, now: iso(nowMs), master: 'on', jobs: {},
    last_pass_at: iso(nowMs - 2 * MIN), graph_ok_at: iso(nowMs - 3 * MIN), poller_ok_at: iso(nowMs - 1 * MIN),
    fail_streak: 0, gv_intake_enabled: false, today: {}, rate_limited_at: null,
    asks_waiting: 0, asks_older: 0, watermark_reset_at: null, last_alarm: null,
    ...extra,
  };
}
const lastAlarm = (code) => ({ last_alarm: { code, at: iso(NOON - 60 * MIN) } });

const cases = [];
function test(name, fn) { cases.push({ name, fn }); }

// ── 1) the pure rules ──────────────────────────────────────────────
test('a fresh heartbeat is healthy and sends nothing', () => {
  assert.equal(crmAlarmDecision(health(NOON), NOON).action, 'none');
});

test('master off: never armed, even when the reader is long dead', () => {
  const h = health(NOON, { master: 'off', graph_ok_at: iso(NOON - 600 * MIN), fail_streak: 9 });
  assert.equal(crmAlarmDecision(h, NOON).action, 'none');
  assert.equal(crmAlarmDecision(null, NOON).action, 'none');
});

test('the OLDER of graph_ok_at and poller_ok_at sets the age (31 minutes = stale)', () => {
  const oldGraph = health(NOON, { graph_ok_at: iso(NOON - 31 * MIN) });
  const oldPoller = health(NOON, { poller_ok_at: iso(NOON - 31 * MIN) });
  assert.equal(crmAlarmDecision(oldGraph, NOON).action, 'stale');
  assert.equal(crmAlarmDecision(oldPoller, NOON).action, 'stale');
  // Exactly 30 minutes is not over 30 minutes.
  assert.equal(crmAlarmDecision(health(NOON, { graph_ok_at: iso(NOON - 30 * MIN) }), NOON).action, 'none');
});

test('an empty stamp falls back to last_pass_at; nothing at all counts as stale', () => {
  const h = health(NOON, { graph_ok_at: null, poller_ok_at: null });
  assert.equal(crmAlarmStampMs(h), NOON - 2 * MIN);
  assert.equal(crmAlarmDecision(h, NOON).action, 'none');
  const none = health(NOON, { graph_ok_at: null, poller_ok_at: null, last_pass_at: null });
  assert.equal(crmAlarmStampMs(none), null);
  const d = crmAlarmDecision(none, NOON);
  assert.equal(d.action, 'stale');
  assert.equal(d.text, 'Mail reader stopped. The CRM is not updating from email.');
});

test('the stopped message shows the older stamp in Eastern time, h:mm AM/PM', () => {
  const d = crmAlarmDecision(health(NOON, { graph_ok_at: iso(NOON - 48 * MIN) }), NOON);
  assert.equal(d.text, 'Mail reader stopped at 11:12 AM. The CRM is not updating from email.');
  // 01:12 UTC on 9/29 is 9:12 PM Eastern on 9/28.
  assert.equal(crmAlarmStaleText(Date.parse('2026-09-29T01:12:00Z')),
    'Mail reader stopped at 9:12 PM. The CRM is not updating from email.');
  // Winter time: 14:05 UTC in December is 9:05 AM Eastern.
  assert.equal(crmAlarmStaleText(Date.parse('2026-12-01T14:05:00Z')),
    'Mail reader stopped at 9:05 AM. The CRM is not updating from email.');
  assert.equal(crmAlarmStaleText(Date.parse('2026-09-28T04:00:00Z')),
    'Mail reader stopped at 12:00 AM. The CRM is not updating from email.');
});

test('the window is 7:00 AM to 10:59 PM Eastern, summer and winter', () => {
  assert.equal(crmAlarmInWindow(Date.parse('2026-09-28T10:59:00Z')), false); // 6:59 AM EDT
  assert.equal(crmAlarmInWindow(Date.parse('2026-09-28T11:00:00Z')), true);  // 7:00 AM EDT
  assert.equal(crmAlarmInWindow(Date.parse('2026-09-29T02:59:00Z')), true);  // 10:59 PM EDT
  assert.equal(crmAlarmInWindow(Date.parse('2026-09-29T03:00:00Z')), false); // 11:00 PM EDT
  assert.equal(crmAlarmInWindow(Date.parse('2026-12-01T11:59:00Z')), false); // 6:59 AM EST
  assert.equal(crmAlarmInWindow(Date.parse('2026-12-01T12:00:00Z')), true);  // 7:00 AM EST
});

test('at night an old heartbeat alone never alarms', () => {
  const h = health(NIGHT, { graph_ok_at: iso(NIGHT - 300 * MIN) });
  assert.equal(crmAlarmDecision(h, NIGHT).action, 'none');
});

test('3 failed passes in a row alarm at any hour; 2 do not', () => {
  assert.equal(crmAlarmDecision(health(NIGHT, { fail_streak: 3 }), NIGHT).action, 'stale');
  assert.equal(crmAlarmDecision(health(NOON, { fail_streak: 3 }), NOON).reason, 'fail_streak');
  assert.equal(crmAlarmDecision(health(NOON, { fail_streak: 2 }), NOON).action, 'none');
});

test('a rate_limited line in the last hour alarms', () => {
  const d = crmAlarmDecision(health(NOON, { rate_limited_at: iso(NOON - 10 * MIN) }), NOON);
  assert.equal(d.action, 'stale');
  assert.equal(d.reason, 'rate_limited');
});

test('never twice: after "stopped" was sent, a still-stale reader sends nothing', () => {
  const h = health(NOON, { fail_streak: 5, ...lastAlarm('alarm_stale') });
  assert.equal(crmAlarmDecision(h, NOON).action, 'none');
});

test('a failed send (alarm_failed) lets the next tick try "stopped" again', () => {
  const h = health(NOON, { fail_streak: 5, ...lastAlarm('alarm_failed') });
  assert.equal(crmAlarmDecision(h, NOON).action, 'stale');
});

test('back: one message once healthy, day or night, and only after a "stopped"', () => {
  const d = crmAlarmDecision(health(NOON, lastAlarm('alarm_stale')), NOON);
  assert.equal(d.action, 'back');
  assert.equal(d.text, CRM_ALARM_BACK_TEXT);
  assert.equal(CRM_ALARM_BACK_TEXT, 'Mail reader is back.');
  assert.equal(crmAlarmDecision(health(NIGHT, lastAlarm('alarm_stale')), NIGHT).action, 'back');
  assert.equal(crmAlarmDecision(health(NOON, lastAlarm('alarm_back')), NOON).action, 'none');
  assert.equal(crmAlarmDecision(health(NOON, lastAlarm('alarm_failed')), NOON).action, 'none');
});

test('at night a still-old reader is held, never reported as back', () => {
  const h = health(NIGHT, { graph_ok_at: iso(NIGHT - 300 * MIN), ...lastAlarm('alarm_stale') });
  const d = crmAlarmDecision(h, NIGHT);
  assert.equal(d.action, 'none');
  assert.equal(d.reason, 'night_hold');
});

// ── 2) the scan against a fake network ─────────────────────────────
// The fake plays a tiny database: the health answer is built from `db`
// on every read, and each alarm RPC writes Claudia's memory line into
// db.lastAlarm exactly like 052's R6 would. `calls` records every request
// in order: 'health', 'alarm:<state>', 'telegram'.
let db;
let calls;
function resetFake(extra = {}) {
  db = { health: null, healthStatus: 200, healthThrows: false, alarmOk: true, telegramOk: true, lastAlarm: null, ...extra };
  calls = [];
}
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const json = (status, body) => ({ ok: status >= 200 && status < 300, status,
    json: async () => body, text: async () => JSON.stringify(body) });
  if (u.endsWith('/rest/v1/rpc/hc_crm_robot_health')) {
    calls.push('health');
    assert.equal(init.method, 'POST');
    assert.equal(init.body, '{}');
    assert.equal(init.headers.apikey, 'not-a-real-key');
    if (db.healthThrows) throw new Error('network down');
    if (db.healthStatus !== 200) return json(db.healthStatus, { message: 'not found' });
    return json(200, { ...db.health(), last_alarm: db.lastAlarm });
  }
  if (u.endsWith('/rest/v1/rpc/hc_crm_robot_alarm')) {
    const body = JSON.parse(init.body);
    assert.deepEqual(Object.keys(body), ['p']);
    assert.deepEqual(Object.keys(body.p).sort(), ['state', 'v']);
    assert.equal(body.p.v, 1);
    calls.push('alarm:' + body.p.state);
    if (!db.alarmOk) return json(500, { message: 'boom' });
    const code = { stale: 'alarm_stale', back: 'alarm_back', send_failed: 'alarm_failed' }[body.p.state];
    db.lastAlarm = { code, at: new Date().toISOString() };
    return json(200, { v: 1, code: 'ok' });
  }
  if (u.includes('api.telegram.org') && u.endsWith('/sendMessage')) {
    const body = JSON.parse(init.body);
    calls.push('telegram');
    db.sent = (db.sent || []).concat([body]);
    return db.telegramOk ? json(200, { ok: true }) : json(502, { ok: false });
  }
  throw new Error('unexpected fetch in test');
};

const env = { SUPABASE_URL: 'https://example.invalid', SUPABASE_SERVICE_KEY: 'not-a-real-key',
  TG_BOT_TOKEN: 'not-a-real-token', ALLOWED_CHAT_IDS: '111' };
// Health built at read time. fail_streak 3 makes a stale reader at ANY
// hour, so these cases do not depend on when the test runs.
const liveStale = () => health(Date.now(), { fail_streak: 3 });
const liveFresh = () => health(Date.now());

test('before 052 exists (health 404): silent, no memory line, no Telegram', async () => {
  resetFake({ healthStatus: 404 });
  await runCrmRobotAlarmScan(env);
  assert.deepEqual(calls, ['health']);
});

test('a network failure on the health read is silent and never throws', async () => {
  resetFake({ healthThrows: true });
  await runCrmRobotAlarmScan(env);
  assert.deepEqual(calls, ['health']);
});

test('stale: memory line FIRST, then one plain text message, no buttons', async () => {
  resetFake({ health: liveStale });
  await runCrmRobotAlarmScan(env);
  assert.deepEqual(calls, ['health', 'alarm:stale', 'telegram']);
  const msg = db.sent[0];
  assert.equal(msg.chat_id, '111');
  assert.match(msg.text, /^Mail reader stopped at \d{1,2}:\d{2} (AM|PM)\. The CRM is not updating from email\.$/);
  assert.equal(msg.parse_mode, undefined);
  assert.equal(msg.reply_markup, undefined);
});

test('never repeats: 4 stale ticks, then 3 healthy ticks = exactly 2 messages', async () => {
  resetFake({ health: liveStale });
  for (let i = 0; i < 4; i++) await runCrmRobotAlarmScan(env);
  db.health = liveFresh;
  for (let i = 0; i < 3; i++) await runCrmRobotAlarmScan(env);
  assert.equal(db.sent.length, 2);
  assert.match(db.sent[0].text, /^Mail reader stopped at /);
  assert.equal(db.sent[1].text, 'Mail reader is back.');
  assert.deepEqual(calls.filter((c) => c !== 'health'), ['alarm:stale', 'telegram', 'alarm:back', 'telegram']);
});

test('a Telegram failure is recorded as send_failed and retried next tick', async () => {
  resetFake({ health: liveStale, telegramOk: false });
  await runCrmRobotAlarmScan(env);
  assert.deepEqual(calls, ['health', 'alarm:stale', 'telegram', 'alarm:send_failed']);
  db.telegramOk = true;
  calls = [];
  await runCrmRobotAlarmScan(env);
  assert.deepEqual(calls, ['health', 'alarm:stale', 'telegram']);
});

test('if the memory line cannot be written, nothing is sent', async () => {
  resetFake({ health: liveStale, alarmOk: false });
  await runCrmRobotAlarmScan(env);
  assert.deepEqual(calls, ['health', 'alarm:stale']);
});

test('master off, or no owner chat configured: no memory line, no message', async () => {
  resetFake({ health: () => health(Date.now(), { master: 'off', fail_streak: 9 }) });
  await runCrmRobotAlarmScan(env);
  assert.deepEqual(calls, ['health']);
  resetFake({ health: liveStale });
  await runCrmRobotAlarmScan({ ...env, ALLOWED_CHAT_IDS: '' });
  assert.deepEqual(calls, []);
});

test('the scan rides the 5-minute chain right after the intake cards', () => {
  const src = fs.readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
  const chain = src.slice(src.indexOf("cron === '*/5 * * * *'"));
  const cards = chain.indexOf('await runIntakeCardScan(env);');
  const alarm = chain.indexOf('await runCrmRobotAlarmScan(env);');
  const next = chain.indexOf('await runDeliveryConfirmationScan(env);');
  assert.ok(cards >= 0 && alarm > cards && next > alarm);
});

// ── runner ─────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
for (const c of cases) {
  try { await c.fn(); passed++; console.log('ok    ' + c.name); }
  catch (e) { failed++; console.log('FAIL  ' + c.name + '\n      ' + ((e && e.message) || e)); }
}
console.log(passed + ' passed, ' + failed + ' failed, ' + cases.length + ' total');
if (failed) process.exit(1);

// Tests for the departure plan's pure functions in worker.js.
//
// Why this file exists: on 2026-09-12 the Pridwin (Shelter Island) wedding
// delivery ran 2h45 late because nothing knew a clock time, a drive time,
// or when anyone should leave the garage. These functions are the rules
// that stop that happening again. They are pinned here so a changed word
// or a shifted minute is caught before a deploy.
//
// Run it with:  node worker/test-departure-plan.mjs
//
// No test framework and no network. Everything is pure.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseArrivalTime, wallClockToUtc, etHour, marketHour, marketTimeStr, weekdayDayLabel, dayBefore, hmsLabel,
  departureDestination, originFor, leaveByMs, refreshDue, movementState, pickupSeenByGps, alertStage,
  departureQueueId, cardStatus, departureCard, cardJobTag, buildLiveActivityContentState,
  routeSanity, extractArrivalTimes, windowsConflict, pushBodyByteCap,
  departureAlertTexts, onShiftLine, dayBeforeLines, stripDateShapes,
  DEPARTURE_BUFFER_SECONDS, FERRY_QUEUE_SECONDS, ROUTE_CALLS_PER_TICK_MAX,
} from './worker.js';

const here = dirname(fileURLToPath(import.meta.url));
let passed = 0;
const pass = (m) => { passed++; console.log('PASS: ' + m); };
const T = (iso) => Date.parse(iso);
const MIN = 60000;

// ── fixtures (made up, no real customer data beyond the incident shape) ──
const GARAGE = { lat: 40.586659, lng: -74.323824 };
const KEARNY = { lat: 40.7555, lng: -74.1059 };
const PRIDWIN = { lat: 41.0879, lng: -72.3593 };
const PLAN = {
  plan_date: '2026-09-12', market: 'ny', state: 'planned',
  arrive_at: '2026-09-12T19:30:00.000Z', leave_by_at: '2026-09-12T14:55:00.000Z',
  drive_seconds: 11100, has_ferry: true, origin_label: 'NJ garage',
  dest_address: 'Pridwin Hotel, Shelter Island, NY', window_text: 'As close to 3:30/4 PM as possible',
  venue: 'Pridwin Hotel',
};
const ORDER = { id: '567ba3a6-7101-4eeb-bb74-4fd5069724cd', client_name: 'Abigail Canelle', venue: 'Pridwin Hotel', coconuts_qty: 100, stage: 'paid_full' };
const NOBODY = { market: 'ny', onShift: [], unreachable: [] };

// ── 1. parseArrivalTime, from the shared vectors ────────────────────
const vectors = JSON.parse(readFileSync(join(here, 'test-vectors', 'window-parse.json'), 'utf8'));
for (const v of vectors) {
  const got = parseArrivalTime(v.input, v.day, v.tz);
  for (const [key, want] of Object.entries(v.expect)) {
    assert.equal(got[key], want, `parseArrivalTime(${JSON.stringify(v.input)}).${key}: got ${JSON.stringify(got[key])}, want ${JSON.stringify(want)}`);
  }
}
pass(`parseArrivalTime: all ${vectors.length} shared vectors (range, exact, deadline, assumed, none, dates and phones stripped, DST, Vegas)`);
assert.equal(stripDateShapes('3:30/4 pm').text.includes('3:30/4'), true);
assert.equal(stripDateShapes('8-9 am').text.includes('8-9'), true);
assert.equal(stripDateShapes('9-12-2026 and 9/12').text.trim(), 'and');
pass('stripDateShapes never eats a clock\'s minutes or a dash time range, and strips dates with a year');

// ── 2. wall clock helpers ───────────────────────────────────────────
assert.equal(wallClockToUtc('2026-09-12', 15, 30, 'America/New_York'), '2026-09-12T19:30:00.000Z');
assert.equal(wallClockToUtc('2026-11-01', 14, 0, 'America/New_York'), '2026-11-01T19:00:00.000Z');
assert.equal(wallClockToUtc('2026-09-12', 14, 0, 'America/Los_Angeles'), '2026-09-12T21:00:00.000Z');
assert.equal(wallClockToUtc('2026-9-12', 14, 0, 'America/New_York'), null);
assert.equal(etHour('2026-09-11T22:00:00Z'), '18');
assert.equal(etHour('2026-12-11T23:00:00Z'), '18');
assert.equal(etHour('2026-09-11T21:59:00Z'), '17');
assert.equal(marketHour('2026-09-11T22:00:00Z', 'ny'), '18');
assert.equal(marketHour('2026-09-12T01:00:00Z', 'vegas'), '18');
assert.equal(marketHour('2026-09-11T22:00:00Z', 'vegas'), '15');
assert.equal(marketHour('2026-09-11T22:00:00Z', 'atlantis'), '18');
assert.equal(marketTimeStr('2026-09-12T19:30:00Z', 'ny'), '3:30 PM');
assert.equal(marketTimeStr('2026-09-12T19:30:00Z', 'vegas'), '12:30 PM PT');
assert.equal(weekdayDayLabel('2026-09-12'), 'Sat Sep 12');
assert.equal(dayBefore('2026-10-01'), '2026-09-30');
assert.equal(hmsLabel(11100), '3h 05m');
assert.equal(hmsLabel(900), '15m');
pass('wallClockToUtc, etHour, marketHour, marketTimeStr, weekday labels, hmsLabel');

// ── 3. departureDestination ─────────────────────────────────────────
let d = departureDestination({ invoice_fulfillment: { read_status: 'complete', address: 'Pridwin Hotel, Shelter Island, NY, US' }, delivery_notes: 'x', venue: 'y' });
assert.deepEqual(d, { address: 'Pridwin Hotel, Shelter Island, NY, US', source: 'invoice', usable: true, reason: null });
d = departureDestination({ invoice_fulfillment: { read_status: 'partial', address: 'Pridwin Hotel, Shelter Island, NY, US' }, delivery_notes: 'Pridwin Hotel, Shelter Island, NY' });
assert.equal(d.source, 'delivery_notes'); assert.equal(d.usable, true);
d = departureDestination({ venue: '45 Ocean Ave' });
assert.deepEqual(d, { address: '45 Ocean Ave', source: 'venue', usable: false, reason: 'address incomplete' });
d = departureDestination({ venue: "Gurney's, Montauk" });
assert.equal(d.usable, true);
d = departureDestination({ venue: '  ', delivery_notes: null });
assert.deepEqual(d, { address: null, source: null, usable: false, reason: 'no address' });
pass('departureDestination: invoice first, then notes, then venue; incomplete addresses never reach a router');

// ── 4. originFor ────────────────────────────────────────────────────
const jaydenOpen = { id: 's1', worker_name: 'Jayden Martin', worker_email: 'j@example.invalid', market: 'ny', clock_in_at: '2026-09-12T16:12:00Z', clock_in_lat: KEARNY.lat, clock_in_lng: KEARNY.lng };
let o = originFor({ market: 'ny', openShifts: [jaydenOpen], lastShift: null });
assert.deepEqual(o, { kind: 'garage', lat: GARAGE.lat, lng: GARAGE.lng, label: 'NJ garage', shiftId: null });
assert.equal(originFor({ market: 'ny', openShifts: [], lastShift: null }).kind, 'garage');
const lianOpen = { id: 's2', worker_name: 'Lian Alpuerto', worker_email: 'l@example.invalid', market: 'vegas', clock_in_at: '2026-09-12T16:00:00Z', clock_in_lat: 36.11, clock_in_lng: -115.17 };
o = originFor({ market: 'vegas', openShifts: [lianOpen], lastShift: null });
assert.deepEqual(o, { kind: 'clock_in', lat: 36.11, lng: -115.17, label: 'where Lian clocked in', shiftId: 's2' });
o = originFor({ market: 'vegas', openShifts: [], lastShift: { id: 's0', clock_in_lat: 36.12, clock_in_lng: -115.2 } });
assert.equal(o.kind, 'last_clock_in'); assert.equal(o.lat, 36.12); assert.equal(o.label, 'last clock-in spot in Vegas');
assert.equal(originFor({ market: 'vegas', openShifts: [], lastShift: null }).kind, 'none');
const reviewer = { ...lianOpen, id: 's9', worker_email: 'appreview@hamptonscoconuts.com', clock_in_at: '2026-09-12T15:00:00Z' };
assert.equal(originFor({ market: 'vegas', openShifts: [reviewer, lianOpen], lastShift: null }).shiftId, 's2');
pass('originFor: NY is always the garage; Vegas is the clock-in spot, then the last clock-in, then none; reviewer shifts skipped');

// ── 5. leaveByMs ────────────────────────────────────────────────────
assert.equal(leaveByMs({ arriveAtMs: T('2026-09-12T19:30:00Z'), driveSeconds: 11100, hasFerry: true }), T('2026-09-12T14:55:00Z'));
assert.equal(leaveByMs({ arriveAtMs: T('2026-09-12T18:00:00Z'), driveSeconds: 11100, hasFerry: true }), T('2026-09-12T13:25:00Z'));
assert.equal(leaveByMs({ arriveAtMs: T('2026-09-12T19:30:00Z'), driveSeconds: 11100, hasFerry: false }), T('2026-09-12T14:55:00Z') + 1800 * 1000);
assert.equal(leaveByMs({ arriveAtMs: T('2026-09-12T19:30:00Z'), driveSeconds: NaN, hasFerry: true }), null);
assert.equal(leaveByMs({ arriveAtMs: T('2026-09-12T19:30:00Z'), driveSeconds: -5, hasFerry: true }), null);
assert.equal(DEPARTURE_BUFFER_SECONDS, 3600); assert.equal(FERRY_QUEUE_SECONDS, 1800); assert.equal(ROUTE_CALLS_PER_TICK_MAX, 5);
pass('leaveByMs: arrival minus drive minus 1h minus 30m ferry, floored to the minute; bad inputs are null');

// ── 6. refreshDue ───────────────────────────────────────────────────
const arrive = T('2026-09-12T19:30:00Z');
const due = (hoursOut, extra) => refreshDue({ nowMs: arrive - hoursOut * 3600000, arriveAtMs: arrive, leaveByMs: arrive - 4.5 * 3600000, computedAtMs: null, state: 'planned', movement: 'nobody', inputsChanged: false, routeFailures: 0, ...extra });
assert.equal(due(36), false);
assert.equal(due(29), true);
assert.equal(due(26, { computedAtMs: arrive - 26 * 3600000 - 50 * MIN }), false);
assert.equal(due(26, { computedAtMs: arrive - 26 * 3600000 - 61 * MIN }), true);
const leave = arrive - 4.5 * 3600000;
const dueLeave = (minToLeave, sinceMin, extra) => refreshDue({ nowMs: leave - minToLeave * MIN, arriveAtMs: arrive, leaveByMs: leave, computedAtMs: leave - minToLeave * MIN - sinceMin * MIN, state: 'planned', movement: 'at_origin', inputsChanged: false, routeFailures: 0, ...extra });
assert.equal(dueLeave(120, 14), false);
assert.equal(dueLeave(120, 16), true);
assert.equal(dueLeave(40, 5), true);
assert.equal(refreshDue({ nowMs: arrive - 3 * 3600000, arriveAtMs: arrive, leaveByMs: leave, computedAtMs: arrive - 3 * 3600000 - 10 * MIN, state: 'planned', movement: 'departed', inputsChanged: false, routeFailures: 0 }), false);
assert.equal(refreshDue({ nowMs: arrive - 3 * 3600000, arriveAtMs: arrive, leaveByMs: leave, computedAtMs: arrive - 3 * 3600000 - 16 * MIN, state: 'planned', movement: 'departed', inputsChanged: false, routeFailures: 0 }), true);
assert.equal(refreshDue({ nowMs: arrive - 45 * MIN, arriveAtMs: arrive, leaveByMs: leave, computedAtMs: arrive - 51 * MIN, state: 'planned', movement: 'departed', inputsChanged: false, routeFailures: 0 }), true);
assert.equal(due(2, { state: 'arrived' }), false);
assert.equal(due(2, { state: 'closed' }), false);
assert.equal(refreshDue({ nowMs: arrive + 61 * MIN, arriveAtMs: arrive, leaveByMs: leave, computedAtMs: null, state: 'planned', movement: 'nobody', inputsChanged: false, routeFailures: 0 }), false);
assert.equal(due(40, { inputsChanged: true }), true);
assert.equal(due(10, { computedAtMs: arrive - 10 * 3600000 - 14 * MIN, routeFailures: 2 }), false);
assert.equal(due(10, { computedAtMs: arrive - 10 * 3600000 - 16 * MIN, routeFailures: 2 }), true);
assert.equal(due(10, { computedAtMs: arrive - 10 * 3600000 - 16 * MIN, routeFailures: 7 }), false);
pass('refreshDue: the cost-control cadence (30h horizon, hourly, 15 min, 5 min, departed, failures, arrived/closed, inputsChanged)');

// ── 7. movementState and pickupSeenByGps ────────────────────────────
const now = T('2026-09-12T17:12:00Z');
const fresh = (p, minAgo = 1) => ({ ...p, at: new Date(now - minAgo * MIN).toISOString() });
const nearGarage = (m) => ({ lat: GARAGE.lat + m / 111320, lng: GARAGE.lng });
const base = { marketHasGarage: true, origin: GARAGE, dest: PRIDWIN, clockInPoint: KEARNY, nowMs: now, pickupSeenAt: null, pickupSource: null, recentPoints: [], hasOpenShift: true };
assert.equal(movementState({ ...base, newestPoint: fresh({ lat: KEARNY.lat + 0.027, lng: KEARNY.lng }) }), 'moving_no_pickup');
assert.equal(movementState({ ...base, newestPoint: fresh({ lat: KEARNY.lat + 0.027, lng: KEARNY.lng }), pickupSeenAt: '2026-09-12T16:20:00Z' }), 'departed');
assert.equal(movementState({ ...base, newestPoint: fresh({ lat: KEARNY.lat + 0.027, lng: KEARNY.lng }), recentPoints: [fresh(nearGarage(350), 40)] }), 'departed');
assert.equal(movementState({ ...base, newestPoint: fresh({ lat: KEARNY.lat + 0.027, lng: KEARNY.lng }), recentPoints: [fresh(nearGarage(550), 40), fresh(nearGarage(550), 32)] }), 'departed');
assert.equal(pickupSeenByGps([fresh(nearGarage(550), 40), fresh(nearGarage(550), 38)], GARAGE), false);
assert.equal(movementState({ ...base, newestPoint: fresh({ lat: KEARNY.lat + 0.025, lng: KEARNY.lng }), pickupSource: 'claim' }), 'departed');
assert.equal(movementState({ ...base, newestPoint: fresh({ lat: KEARNY.lat + 0.025, lng: KEARNY.lng }, 20), pickupSource: 'claim' }), 'unknown');
assert.equal(movementState({ ...base, newestPoint: fresh(nearGarage(100)) }), 'at_origin');
assert.equal(movementState({ ...base, newestPoint: fresh(nearGarage(100), 20) }), 'unknown');
assert.equal(movementState({ ...base, newestPoint: fresh({ lat: KEARNY.lat + 0.0045, lng: KEARNY.lng }) }), 'at_origin');
assert.equal(movementState({ ...base, newestPoint: null, clockInPoint: null, hasOpenShift: false }), 'nobody');
assert.equal(movementState({ ...base, newestPoint: fresh({ lat: PRIDWIN.lat + 0.002, lng: PRIDWIN.lng }) }), 'arrived');
const vegasOrigin = { lat: 36.11, lng: -115.17 };
const vegasBase = { marketHasGarage: false, origin: vegasOrigin, dest: { lat: 36.1118, lng: -115.17 }, clockInPoint: vegasOrigin, nowMs: now, pickupSeenAt: null, pickupSource: null, recentPoints: [], hasOpenShift: true };
assert.equal(movementState({ ...vegasBase, newestPoint: fresh({ lat: 36.1118, lng: -115.17 }) }), 'arrived');
assert.equal(movementState({ ...vegasBase, dest: { lat: 36.2, lng: -115.3 }, newestPoint: fresh({ lat: 36.137, lng: -115.17 }) }), 'departed');
assert.equal(movementState({ ...vegasBase, dest: { lat: 36.2, lng: -115.3 }, newestPoint: fresh({ lat: 36.1105, lng: -115.17 }) }), 'at_origin');
pass('movementState: nobody, unknown, at_origin, moving_no_pickup, departed (GPS pickup, claim), arrived, Vegas rules');

// ── 8. alertStage ───────────────────────────────────────────────────
const stageAt = (m, extra = {}) => alertStage({ nowMs: now, leaveByMs: now + m * MIN, arriveAtMs: now + (m + 270) * MIN, movement: 'at_origin', etaMs: null, alerts: {}, silenced: false, claimed: false, ...extra });
assert.equal(stageAt(63), null);
assert.deepEqual(stageAt(58), { stage: 'heads_up', index: 0, send: true, alsoStamp: [] });
assert.equal(stageAt(58, { alerts: { heads_up: { at: 'x' } } }), null);
assert.equal(stageAt(4).stage, 'leave_now');
assert.deepEqual(stageAt(4).alsoStamp, ['heads_up']);
assert.equal(stageAt(-3).stage, 'leave_now');
let s = stageAt(-12, { alerts: { leave_now: {} } });
assert.equal(s.stage, 'late'); assert.equal(s.index, 10);
s = stageAt(-35, { alerts: { late_10: {}, leave_now: {}, heads_up: {} } });
assert.equal(s.index, 30); assert.deepEqual(s.alsoStamp, []);
s = stageAt(-65);
assert.equal(s.index, 60); assert.deepEqual(s.alsoStamp, [30, 10, 'leave_now', 'heads_up']);
const arr = now + 60 * MIN;
s = alertStage({ nowMs: now, leaveByMs: now - 200 * MIN, arriveAtMs: arr, movement: 'departed', etaMs: arr + 20 * MIN, alerts: {}, silenced: false, claimed: false });
assert.equal(s.stage, 'running_late');
assert.equal(alertStage({ nowMs: now + 10 * MIN, leaveByMs: now - 200 * MIN, arriveAtMs: arr, movement: 'departed', etaMs: arr + 20 * MIN, alerts: { running_late: { at: new Date(now).toISOString(), eta: arr + 20 * MIN } }, silenced: false, claimed: false }), null);
assert.equal(alertStage({ nowMs: now + 31 * MIN, leaveByMs: now - 200 * MIN, arriveAtMs: arr, movement: 'departed', etaMs: arr + 32 * MIN, alerts: { running_late: { at: new Date(now).toISOString(), eta: arr + 20 * MIN } }, silenced: false, claimed: false }).stage, 'running_late');
assert.equal(stageAt(-500, { movement: 'arrived' }), null);
assert.equal(alertStage({ nowMs: arr + 16 * MIN, leaveByMs: arr - 270 * MIN, arriveAtMs: arr, movement: 'at_origin', etaMs: null, alerts: {}, silenced: false, claimed: false }).stage, 'missed');
assert.equal(alertStage({ nowMs: arr + 16 * MIN, leaveByMs: arr - 270 * MIN, arriveAtMs: arr, movement: 'at_origin', etaMs: null, alerts: { missed: {} }, silenced: false, claimed: false }), null);
assert.equal(stageAt(-12, { movement: 'unknown', alerts: { leave_now: {} } }).stage, 'late');
// silence and claim rules
s = stageAt(-35, { silenced: true, alerts: { late_10: {}, leave_now: {}, heads_up: {} } });
assert.equal(s.stage, 'late'); assert.equal(s.index, 30); assert.equal(s.send, false);
assert.equal(alertStage({ nowMs: arr + 16 * MIN, leaveByMs: arr - 270 * MIN, arriveAtMs: arr, movement: 'at_origin', etaMs: null, alerts: {}, silenced: true, claimed: false }).send, true);
assert.equal(stageAt(-35, { claimed: true }), null);
assert.equal(alertStage({ nowMs: now, leaveByMs: now - 200 * MIN, arriveAtMs: arr, movement: 'departed', etaMs: arr + 20 * MIN, alerts: {}, silenced: false, claimed: true }).stage, 'running_late');
s = alertStage({ nowMs: arr + 16 * MIN, leaveByMs: arr - 270 * MIN, arriveAtMs: arr, movement: 'unknown', etaMs: null, alerts: {}, silenced: false, claimed: true });
assert.equal(s.stage, 'missed'); assert.equal(s.claim, true);
s = stageAt(-125, { alerts: { late_10: {}, late_30: {}, late_60: {}, leave_now: {}, heads_up: {} } });
assert.equal(s.index, 120); assert.deepEqual(s.alsoStamp, []);
assert.equal(stageAt(-12, { movement: 'moving_no_pickup', alerts: {} }).stage, 'moving_no_pickup');
assert.equal(stageAt(-12, { movement: 'moving_no_pickup', alerts: { moving_no_pickup: {}, leave_now: {} } }).stage, 'late');
pass('alertStage: heads_up, leave_now, late 10/30/60/120/180 with silent lower stamps, running_late, missed, silence, claim, moving_no_pickup');

// ── 9. departureQueueId ─────────────────────────────────────────────
const V5 = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const q1 = await departureQueueId(ORDER.id, PLAN.arrive_at, 'late', 30);
assert.equal(q1, await departureQueueId(ORDER.id, PLAN.arrive_at, 'late', 30));
assert.notEqual(q1, await departureQueueId(ORDER.id, PLAN.arrive_at, 'late', 60));
assert.notEqual(q1, await departureQueueId(ORDER.id, PLAN.arrive_at, 'leave_now', 0));
assert.notEqual(q1, await departureQueueId(ORDER.id, '2026-09-12T18:00:00.000Z', 'late', 30));
assert.match(q1, V5);
pass('departureQueueId: stable, distinct per stage/index/arrival, version-5 uuid');

// ── 10. cardStatus ──────────────────────────────────────────────────
const cs = (extra) => cardStatus({ plan: PLAN, nowMs: T('2026-09-12T13:00:00Z'), movement: 'nobody', etaMs: null, market: 'ny', ...extra });
assert.equal(cs(), 'Leave by 10:55a');
assert.equal(cs({ nowMs: T('2026-09-12T15:00:00Z') }), 'LEAVE NOW · Pridwin');
assert.equal(cs({ nowMs: T('2026-09-12T15:25:00Z') }), 'Late 30m · Pridwin');
assert.equal(cs({ nowMs: T('2026-09-12T17:42:00Z') }), 'Late 2h47m · Pridwin');
assert.equal(cs({ movement: 'departed', etaMs: T('2026-09-12T20:45:00Z') }), 'ETA 4:45p · Pridwin');
assert.equal(cs({ movement: 'departed', etaMs: T('2026-09-12T19:00:00Z') }), 'Enroute');
assert.equal(cs({ movement: 'arrived' }), 'On site · Pridwin');
assert.equal(cs({ movement: 'moving_no_pickup' }), 'No pickup · Pridwin');
assert.equal(cardStatus({ plan: { ...PLAN, venue: "Gurney's Montauk Resort" }, nowMs: T('2026-09-12T15:00:00Z'), movement: 'nobody', market: 'ny' }), "LEAVE NOW · Gurney's");
for (const text of [cs(), cs({ nowMs: T('2026-09-12T17:42:00Z') }), cs({ movement: 'arrived' })]) assert.ok(text.length <= 20, text);
pass('cardStatus: every lock-screen status fits 20 characters and reads as the catalogue says');

// ── 10b. departureCard: the structured card build 34 renders ────────
const dc = (extra) => departureCard({ plan: PLAN, nowMs: T('2026-09-12T13:00:00Z'), movement: 'nobody', etaMs: null, market: 'ny', order: ORDER, ...extra });
assert.deepEqual(dc(), {
  status: 'Leave by 10:55a', stage: 'garage', headline: 'Leave by 10:55 AM', jobTag: 'Canelle / Pridwin',
  leaveByISO: '2026-09-12T14:55:00.000Z', etaISO: null, lateMinutes: null,
});
// The first ten minutes past leave-by are LEAVE NOW, not a late count.
assert.deepEqual(dc({ nowMs: T('2026-09-12T15:00:00Z') }), { ...dc(), status: 'LEAVE NOW · Pridwin', headline: 'LEAVE NOW' });
assert.deepEqual(dc({ nowMs: T('2026-09-12T15:25:00Z') }), { ...dc(), status: 'Late 30m · Pridwin', headline: 'Late 30m', lateMinutes: 30 });
assert.deepEqual(dc({ nowMs: T('2026-09-12T17:42:00Z') }), { ...dc(), status: 'Late 2h47m · Pridwin', headline: 'Late 2h47m', lateMinutes: 167 });
// En route: the ETA clock is on the headline whenever it is known; the
// 20-character words only say ETA when it is later than the arrival time.
assert.deepEqual(dc({ movement: 'departed', etaMs: T('2026-09-12T20:45:00Z') }), { ...dc(), status: 'ETA 4:45p · Pridwin', stage: 'enroute', headline: 'ETA 4:45 PM', etaISO: '2026-09-12T20:45:00.000Z' });
assert.deepEqual(dc({ movement: 'departed', etaMs: T('2026-09-12T19:00:00Z') }), { ...dc(), status: 'Enroute', stage: 'enroute', headline: 'ETA 3:00 PM', etaISO: '2026-09-12T19:00:00.000Z' });
assert.deepEqual(dc({ movement: 'departed' }), { ...dc(), status: 'Enroute', stage: 'enroute', headline: 'En route' });
assert.deepEqual(dc({ movement: 'arrived', nowMs: T('2026-09-12T21:00:00Z') }), { ...dc(), status: 'On site · Pridwin', stage: 'arrived', headline: 'On site' });
// Moving without a pickup keeps its warning words even when late.
assert.deepEqual(dc({ movement: 'moving_no_pickup', nowMs: T('2026-09-12T15:25:00Z') }), { ...dc(), status: 'No pickup · Pridwin', stage: 'enroute', headline: 'No pickup' });
// No leave-by yet: nothing to say, and nothing to count down to.
assert.deepEqual(dc({ plan: { ...PLAN, leave_by_at: null } }), { ...dc(), status: '', headline: '', leaveByISO: null });
// Vegas reads its own clock and never gets a " PT" suffix on the card.
assert.equal(dc({ plan: { ...PLAN, market: 'vegas' }, market: 'vegas' }).headline, 'Leave by 7:55 AM');
assert.equal(dc({ plan: { ...PLAN, market: 'vegas' }, market: 'vegas' }).status, 'Leave by 7:55a');
// The words never drift from cardStatus: same tree, same text.
for (const extra of [{}, { nowMs: T('2026-09-12T15:00:00Z') }, { nowMs: T('2026-09-12T17:42:00Z') }, { movement: 'departed', etaMs: T('2026-09-12T20:45:00Z') }, { movement: 'arrived' }, { movement: 'moving_no_pickup' }]) {
  assert.equal(dc(extra).status, cs(extra));
}
pass('departureCard: stage, headline, leaveByISO, etaISO and lateMinutes for every movement, words identical to cardStatus');

// ── 10c. cardJobTag never carries an email, a phone or a dollar ─────
assert.equal(cardJobTag(ORDER, PLAN.dest_address), 'Canelle / Pridwin');
assert.equal(cardJobTag({ client_name: 'Abigail Canelle', delivery_notes: 'Pridwin Hotel, Shelter Island, NY' }, null), 'Canelle / Pridwin');
assert.equal(cardJobTag(null, 'Pridwin Hotel, Shelter Island, NY'), 'Pridwin');
assert.equal(cardJobTag({ client_name: 'abigail@example.invalid', venue: 'Pridwin Hotel' }, null), 'Pridwin');
assert.equal(cardJobTag({ client_name: '862-899-1468', venue: 'Pridwin Hotel' }, null), 'Pridwin');
assert.equal(cardJobTag({ client_name: '$500 Deposit', venue: 'Pridwin Hotel' }, null), 'Deposit / Pridwin');
assert.equal(cardJobTag({ client_name: 'Marcus Lee', venue: '74 Wythe Ave, Brooklyn' }, null), 'Lee / Wythe');
// A venue with no safe word falls through to the delivery notes, then the plan's destination.
assert.equal(cardJobTag({ client_name: 'Marcus Lee', venue: '74', delivery_notes: 'Wythe Hotel, Brooklyn' }, null), 'Lee / Wythe');
assert.equal(cardJobTag({ client_name: 'Marcus Lee', venue: '74', delivery_notes: '(917) 555-0100' }, 'Pridwin Hotel'), 'Lee / Pridwin');
assert.equal(cardJobTag({ client_name: 'Tom Baker', venue: "Gurney's Montauk Resort" }, null), "Baker / Gurney's");
assert.equal(cardJobTag({ client_name: 'Dana Ruiz', venue: 'Southampton, NY' }, null), 'Ruiz / Southamp');
assert.equal(cardJobTag({ client_name: 'Anna Wolfeschlegelsteinhausen', venue: '' }, ''), 'Wolfeschlege');
assert.equal(cardJobTag({ client_name: 'sales@example.invalid', venue: '$$$' }, '917-555-0100'), null);
for (const o of [ORDER, { client_name: 'a@b.c', venue: '$9 (555) 123-4567' }, { client_name: 'Jo (917) 555-0100', venue: 'Pier 17' }]) {
  const tag = cardJobTag(o, 'Pridwin Hotel') || '';
  assert.ok(!/[@$\d]/.test(tag), tag);
}
pass('cardJobTag: surname / venue word, emails, phones, street numbers and dollars dropped, null when nothing safe is left');

// ── 10d. the content state carries the card's keys only when present ─
const REPORT = '2026-09-12T12:58:00.000Z';
const OLD_SHAPE = { status: 'At NJ Garage', statusMinutes: 0, lastReportISO: REPORT, marketLabel: 'NJ' };
assert.deepEqual(buildLiveActivityContentState('At NJ Garage', 0, REPORT, 'ny'), OLD_SHAPE);
assert.deepEqual(buildLiveActivityContentState('At NJ Garage', 0, REPORT, 'ny', null), OLD_SHAPE);
const garageCard = dc();
assert.deepEqual(buildLiveActivityContentState(garageCard.status, 0, REPORT, 'ny', garageCard), {
  status: 'Leave by 10:55a', statusMinutes: 0, lastReportISO: REPORT, marketLabel: 'NJ',
  stage: 'garage', headline: 'Leave by 10:55 AM', jobTag: 'Canelle / Pridwin', leaveByISO: '2026-09-12T14:55:00.000Z',
});
const lateCard = dc({ nowMs: T('2026-09-12T15:25:00Z') });
assert.deepEqual(buildLiveActivityContentState(lateCard.status, 0, REPORT, 'ny', lateCard), {
  status: 'Late 30m · Pridwin', statusMinutes: 0, lastReportISO: REPORT, marketLabel: 'NJ',
  stage: 'garage', headline: 'Late 30m', jobTag: 'Canelle / Pridwin', leaveByISO: '2026-09-12T14:55:00.000Z', lateMinutes: 30,
});
const etaCard = dc({ movement: 'departed', etaMs: T('2026-09-12T20:45:00Z') });
assert.deepEqual(buildLiveActivityContentState(etaCard.status, 0, REPORT, 'ny', etaCard), {
  status: 'ETA 4:45p · Pridwin', statusMinutes: 0, lastReportISO: REPORT, marketLabel: 'NJ',
  stage: 'enroute', headline: 'ETA 4:45 PM', jobTag: 'Canelle / Pridwin', leaveByISO: '2026-09-12T14:55:00.000Z', etaISO: '2026-09-12T20:45:00.000Z',
});
// The key order is fixed: the update path fingerprints the JSON text.
assert.deepEqual(Object.keys(buildLiveActivityContentState(etaCard.status, 0, REPORT, 'ny', etaCard)),
  ['status', 'statusMinutes', 'lastReportISO', 'marketLabel', 'stage', 'headline', 'jobTag', 'leaveByISO', 'etaISO']);
// Stopped wins: a stale GPS never gets a countdown or a late count painted over it.
assert.deepEqual(buildLiveActivityContentState('Stopped', 30, REPORT, 'ny', lateCard), { status: 'Stopped', statusMinutes: 30, lastReportISO: REPORT, marketLabel: 'NJ' });
// Garbage in the card adds nothing: unknown stage, bad dates, a zero or negative late count.
assert.deepEqual(buildLiveActivityContentState('Enroute', 0, REPORT, 'ny', { stage: 'flying', headline: '  ', jobTag: null, leaveByISO: 'nope', etaISO: '', lateMinutes: -3 }),
  { status: 'Enroute', statusMinutes: 0, lastReportISO: REPORT, marketLabel: 'NJ' });
assert.deepEqual(buildLiveActivityContentState('Enroute', 0, REPORT, 'ny', { stage: 'Enroute', lateMinutes: 0 }), { status: 'Enroute', statusMinutes: 0, lastReportISO: REPORT, marketLabel: 'NJ', stage: 'enroute' });
pass('buildLiveActivityContentState: old shape without a card, six optional keys with one, Stopped drops them, garbage adds nothing');

// ── 11. routeSanity ─────────────────────────────────────────────────
assert.deepEqual(routeSanity({ meters: 186700, driveSeconds: 11100, endLat: PRIDWIN.lat, endLng: PRIDWIN.lng, originLat: GARAGE.lat, originLng: GARAGE.lng, marketCenter: GARAGE }), { ok: true, reason: null });
assert.equal(routeSanity({ meters: 300000, driveSeconds: 12000, endLat: 39.28, endLng: -74.58, originLat: GARAGE.lat, originLng: GARAGE.lng, marketCenter: { lat: 41.1, lng: -72.3 } }).reason, 'too_far');
assert.equal(routeSanity({ meters: 1000, driveSeconds: 3000, endLat: GARAGE.lat + 0.45, endLng: GARAGE.lng, originLat: GARAGE.lat, originLng: GARAGE.lng, marketCenter: GARAGE }).reason, 'shorter_than_straight_line');
assert.equal(routeSanity({ meters: 186700, driveSeconds: 40000, endLat: PRIDWIN.lat, endLng: PRIDWIN.lng, originLat: GARAGE.lat, originLng: GARAGE.lng, marketCenter: GARAGE }).reason, 'implausible_duration');
assert.equal(routeSanity({ meters: 1000, driveSeconds: 100, endLat: null, endLng: null, originLat: GARAGE.lat, originLng: GARAGE.lng }).reason, 'no_end_point');
pass('routeSanity: too far, shorter than the straight line, implausible duration, no end point');

// ── 12. extractArrivalTimes ─────────────────────────────────────────
const body54869 = `Resending with the correct email address!\n\nWarmest Regards,\nAnadina Saladino (she/her)\nSlick Little Bride\n862-899-1468\n\n---------- Forwarded message ---------\nFrom: Anadina Saladino <example@example.invalid>\nDate: Thu, Sep 10, 2026 at 12:12 PM\nSubject: Abigail Canelle & Nolan Walsh-Day-of Coordination Timeline-09/12/2026\nTo: <a@example.invalid>\n\nHello, everyone,\nPlease find the timeline and floor plans attached.`;
assert.deepEqual(extractArrivalTimes(body54869), []);
let times = extractArrivalTimes(body54869 + '\n\n=== ATTACHMENT: Canelle-Walsh Timeline.pdf (PDF text, 20 pages) ===\n5:00 PM Ceremony\n2:00 PM Hamptons Coconuts arrival + setup\n');
assert.equal(times.length, 1); assert.equal(times[0].hh, 14); assert.equal(times[0].where, 'attachment:Canelle-Walsh Timeline.pdf'); assert.equal(times[0].label, '2:00 PM');
assert.deepEqual(extractArrivalTimes('2:00 PM Vendors arrive').map((t) => t.hh), [14]);
assert.deepEqual(extractArrivalTimes('2:00 PM   Rentals + Bar'), []);
times = extractArrivalTimes('1:30 PM\n2:00 PM\n4:00 PM\nRentals\nHamptons Coconuts\nCeremony');
assert.deepEqual(times.map((t) => t.hh), [14]);
assert.deepEqual(extractArrivalTimes('Vendor load-in 12:00-1:00 PM').map((t) => [t.hh, t.mm]), [[12, 0]]);
assert.deepEqual(extractArrivalTimes('Coconuts delivered by 2pm').map((t) => t.hh), [14]);
assert.deepEqual(extractArrivalTimes('delivery\n(631) 555-1200'), []);
assert.deepEqual(extractArrivalTimes('Coconut delivery 2').map((t) => t.hh), []);
times = extractArrivalTimes('3:00 PM vendor arrival\n2:00 PM Hamptons Coconuts\n1:00 PM delivery of chairs\n1:00 PM coconut water');
assert.deepEqual(times.map((t) => t.hh), [13, 14, 15]);
pass('extractArrivalTimes: coordinator body yields nothing, attachment lines yield the coconut time, tables paired, ceremony lines excluded, phones ignored');
// 12b. Mail plumbing never proposes a time (the 2026-09-14 "1:24 AM" false
// alarm: a customer's reply quoted Sidd's 1:24 AM email, and his address
// carries the word "hamptons").
const replyHeader = 'Thanks Sidd, that works for us.\n\nOn Mon, Sep 14, 2026 at 1:24 AM Sidd Saxena <sidd@hamptonscoconuts.com<mailto:sidd@hamptonscoconuts.com>> wrote:\n> Hi Nadege, following up on the quote.';
assert.deepEqual(extractArrivalTimes(replyHeader), []);
assert.deepEqual(extractArrivalTimes('From: Hamptons Coconuts <sidd@hamptonscoconuts.com>\nSent: Monday, September 14, 2026 1:24 AM\nTo: Charles'), []);
assert.deepEqual(extractArrivalTimes('Submitted 04:56 PM - 11 May 2026\nName: Charles'), []);
assert.deepEqual(extractArrivalTimes('On Mon, Sep 14, 2026 at 1:24 AM Hamptons Coconuts <sidd@hamptonscoconuts.com>\nwrote:'), []);
assert.deepEqual(extractArrivalTimes('> On 9/14/2026 at 1:24 AM, Hamptons Coconuts wrote:'), []);
assert.deepEqual(extractArrivalTimes('Meeting at 9:00 AM with sidd@hamptonscoconuts.com'), []);
// The real thing ABOVE a reply header still reads, and a line that merely
// starts with "on" is not a header. What sits under the header is quoted
// text (2026-09-14, reconfirmation plan section 5): the customer's own
// words come first, our email comes after, so a quoted line is never read
// as the answer, even when it names coconuts and a time.
assert.deepEqual(extractArrivalTimes('Coconuts should arrive by 2:00 PM please\n\nOn Mon, Sep 14, 2026 at 1:24 AM Sidd Saxena <sidd@hamptonscoconuts.com> wrote:\n> Hi Nadege, following up on the quote.').map((t) => t.hh), [14]);
assert.deepEqual(extractArrivalTimes('On Mon, Sep 14, 2026 at 1:24 AM Sidd Saxena <sidd@hamptonscoconuts.com> wrote:\n> Coconuts should arrive by 2:00 PM please').map((t) => t.hh), []);
assert.deepEqual(extractArrivalTimes('On site vendor arrival at 2:00 PM').map((t) => t.hh), [14]);
pass('extractArrivalTimes: reply attribution, Sent/Date/Submitted headers and addresses never yield a time; the coconut line above a header still does, a quoted one never');
// 12c. Our own reconfirmation template quoted back is never the answer
// (Gmail "wrote:" quoting, Apple Mail ">" quoting, and Outlook's own
// From/Sent block), while a coordinator PDF pasted BELOW the quote is
// still read, because attachment sections are never stripped.
const ourTemplateLine = 'Delivery: Saturday, September 19, arriving 3:30 PM';
const gmailQuote = 'Can we do 4:00 PM for the coconut delivery instead?\n\nOn Tue, Sep 15, 2026 at 10:00 AM Sidd Saxena <sidd@hamptonscoconuts.com> wrote:\n> Hi Jamie,\n>\n> ' + ourTemplateLine + '\n> Drop off: The Maidstone, 207 Main St, East Hampton, NY 11937';
assert.deepEqual(extractArrivalTimes(gmailQuote).map((t) => [t.hh, t.mm]), [[16, 0]]);
const appleQuote = 'Confirmed, thanks!\n\n> On Sep 15, 2026, at 10:00 AM, Sidd Saxena <sidd@hamptonscoconuts.com> wrote:\n>\n> ' + ourTemplateLine;
assert.deepEqual(extractArrivalTimes(appleQuote), []);
const outlookQuote = 'Looks good.\n\n________________________________\nFrom: Sidd Saxena <sidd@hamptonscoconuts.com>\nSent: Tuesday, September 15, 2026 10:00 AM\nTo: Jamie <jamie@example.invalid>\nSubject: Your coconuts for Saturday, September 19: quick reconfirm\n\nHi Jamie,\n\n' + ourTemplateLine;
assert.deepEqual(extractArrivalTimes(outlookQuote), []);
// A forwarded coordinator email keeps its header block (their From line is not ours).
assert.deepEqual(extractArrivalTimes('FYI\n\n---------- Forwarded message ---------\nFrom: Planner <planner@example.invalid>\nDate: Thu, Sep 10, 2026 at 12:12 PM\nSubject: Timeline\n\nHamptons Coconuts arrival 2:00 PM').map((t) => t.hh), [14]);
const pdfBelowQuote = 'See attached.\n\nOn Tue, Sep 15, 2026 at 10:00 AM Sidd Saxena <sidd@hamptonscoconuts.com> wrote:\n> ' + ourTemplateLine + '\n\n=== ATTACHMENT: Run of Show.pdf (PDF text, 3 pages) ===\n5:00 PM Ceremony\n2:00 PM Hamptons Coconuts arrival + setup\n';
const pdfTimes = extractArrivalTimes(pdfBelowQuote);
assert.deepEqual(pdfTimes.map((t) => [t.hh, t.where]), [[14, 'attachment:Run of Show.pdf']]);
pass('extractArrivalTimes: our template line quoted back (Gmail, Apple Mail, Outlook) is ignored; a forward and a PDF section below a quote are still read');
assert.equal(windowsConflict({ hh: 14, mm: 0 }, { hh: 15, mm: 30 }), true);
assert.equal(windowsConflict({ hh: 15, mm: 30 }, { hh: 15, mm: 40 }), false);
assert.equal(windowsConflict(null, { hh: 15, mm: 30 }), false);
pass('windowsConflict: more than 15 minutes apart');

// ── 13. pushBodyByteCap ─────────────────────────────────────────────
const enc = new TextEncoder();
assert.equal(pushBodyByteCap('x'.repeat(900), 1500), 'x'.repeat(900));
const eight = Array.from({ length: 8 }, (_, i) => '• ' + String(i).repeat(298)).join('\n');
let capped = pushBodyByteCap(eight, 1500);
assert.ok(enc.encode(capped).length <= 1500);
assert.equal(capped.split('\n').length, 5);
assert.ok(capped.endsWith('… plus 4 more in Calendar.'), capped.slice(-40));
const multibyte = Array.from({ length: 12 }, () => '• Abigail Canelle · Pridwin Hotel · arrive 3:30 PM · leave NJ garage by 10:55 AM · 100 coconuts: brand and box them TODAY (Fri) ✓✓✓✓✓✓✓✓✓✓').join('\n');
capped = pushBodyByteCap(multibyte, 1500);
assert.ok(enc.encode(capped).length <= 1500);
assert.equal(new TextDecoder('utf-8', { fatal: true }).decode(enc.encode(capped)), capped);
pass('pushBodyByteCap: under the cap unchanged, over the cap cut at bullets with the overflow line, never a broken character');

// ── 14. departureAlertTexts and onShiftLine ─────────────────────────
let t = departureAlertTexts(PLAN, ORDER, { ...NOBODY, stage: 'heads_up', minutesToLeave: 60, nowMs: T('2026-09-12T13:55:00Z') });
assert.equal(t.title, 'Leave in 1 hour: Canelle / Pridwin');
assert.equal(t.body, 'Leave NJ garage by 10:55 AM to arrive 3:30 PM. 3h 05m with traffic incl. ferry, +1h buffer, +30m ferry. On shift (NY): nobody clocked in.');
assert.equal(departureAlertTexts(PLAN, ORDER, { ...NOBODY, stage: 'heads_up', minutesToLeave: 25, nowMs: now }).title, 'Leave in 25 min: Canelle / Pridwin');
t = departureAlertTexts(PLAN, ORDER, { ...NOBODY, stage: 'leave_now', nowMs: T('2026-09-12T14:55:00Z') });
assert.equal(t.title, 'LEAVE NOW: Canelle / Pridwin');
assert.equal(t.body, 'Leave-by 10:55 AM is now. Arrive 3:30 PM at Pridwin Hotel, Shelter Island, NY. 3h 05m + ferry. On shift (NY): nobody clocked in.');
const jayden = { name: 'Jayden Martin', clockInAtIso: '2026-09-12T16:12:00Z', atGarage: false };
t = departureAlertTexts(PLAN, ORDER, { market: 'ny', stage: 'late', index: 30, nowMs: T('2026-09-12T16:35:00Z'), onShift: [jayden], unreachable: [] });
assert.equal(t.title, 'Late 30 min: Canelle / Pridwin');
assert.equal(t.body, 'Nobody has left the NJ garage. Leaving now arrives 4:10 PM with traffic, needed 3:30 PM. On shift (NY): Jayden Martin, clocked in at 12:12 PM, not seen at the garage.');
assert.equal(onShiftLine({ market: 'ny', onShift: [{ ...jayden, atGarage: true }], unreachable: ['Jayden Martin'] }), 'Jayden Martin, at the garage since 12:12 PM (no alerts on their phone)');
assert.equal(onShiftLine({ market: 'ny', onShift: [{ name: 'Jayden Martin', gpsStaleSinceIso: '2026-09-12T16:40:00Z' }], unreachable: [] }), 'Jayden Martin, GPS stale since 12:40 PM, cannot tell if moving');
assert.equal(onShiftLine({ market: 'ny', onShift: [jayden], unreachable: [], ack: { kind: 'on_my_way', name: 'Jayden Martin', atIso: '2026-09-12T16:14:00Z' } }), 'Jayden Martin, clocked in at 12:12 PM, not seen at the garage. Jayden tapped On my way at 12:14 PM');
assert.equal(departureAlertTexts(PLAN, ORDER, { ...NOBODY, stage: 'late', index: 120, nowMs: now }).title, 'Late 2h: Canelle / Pridwin');
t = departureAlertTexts(PLAN, ORDER, { market: 'ny', stage: 'running_late', nowMs: now, onShift: [jayden], unreachable: [], etaMs: T('2026-09-12T20:45:00Z') });
assert.equal(t.body, 'Jayden Martin ETA 4:45 PM, needed 3:30 PM (1h 15m late). Call the venue.');
t = departureAlertTexts(PLAN, ORDER, { ...NOBODY, stage: 'missed', nowMs: T('2026-09-12T19:45:00Z') });
assert.equal(t.title, 'ARRIVAL MISSED: Canelle / Pridwin');
assert.equal(t.body, 'It is 3:45 PM. The coconuts were needed at 3:30 PM at Pridwin Hotel, Shelter Island, NY, and nobody has left the NJ garage. Call the venue now.');
t = departureAlertTexts({ ...PLAN, arrive_at: '2026-09-12T18:00:00.000Z' }, ORDER, { ...NOBODY, stage: 'missed', nowMs: T('2026-09-12T18:15:00Z'), claim: { name: 'Jayden Martin', atIso: '2026-09-12T16:14:00Z' }, gpsSeenIso: '2026-09-12T17:40:00Z' });
assert.equal(t.body, 'Jayden Martin said they left the garage at 12:14 PM. It is 2:15 PM, the coconuts were needed at 2:00 PM at Pridwin Hotel, Shelter Island, NY, and no arrival has been seen (GPS 1:40 PM). Call the venue now.');
t = departureAlertTexts(PLAN, ORDER, { market: 'ny', stage: 'moving_no_pickup', nowMs: now, onShift: [jayden], unreachable: [], etaMs: T('2026-09-12T20:45:00Z') });
assert.equal(t.title, 'Moving, no pickup: Canelle / Pridwin');
assert.equal(t.body, "Jayden Martin is moving but has not been seen at the NJ garage, where the boxes are. ETA via the garage 4:45 PM, needed 3:30 PM. If they have the boxes, they should tap 'Left the garage with the boxes' in My Day.");
t = departureAlertTexts(PLAN, ORDER, { ...NOBODY, stage: 'crew_ack', ack: { kind: 'left_garage', name: 'Jayden Martin', atIso: '2026-09-12T16:14:00Z' } });
assert.equal(t.title, 'Jayden left the garage: Canelle / Pridwin');
assert.equal(t.body, "Jayden Martin tapped 'Left the garage with the boxes' at 12:14 PM. Late nags stop; you get an ETA warning only if traffic slips. Not right? Undo in Needs you.");
t = departureAlertTexts(PLAN, ORDER, { ...NOBODY, stage: 'crew_ack', ack: { kind: 'on_my_way', name: 'Jayden Martin', atIso: '2026-09-12T16:14:00Z' } });
assert.equal(t.title, 'Jayden is on it: Canelle / Pridwin');
t = departureAlertTexts({ ...PLAN, alt_arrive_at: '2026-09-12T18:00:00.000Z' }, ORDER, { ...NOBODY, stage: 'heads_up', minutesToLeave: 60, nowMs: now, unsilencedByTimeChange: true, multiStop: 2 });
assert.ok(t.body.includes('\nUnconfirmed: a coordinator email says 2:00 PM (on file As close to 3:30/4 PM as possible). This alarm uses 2:00 PM. Open Needs you to Accept or Keep.'));
assert.ok(t.body.includes('\n2 stops in NY today: each leave-by assumes it is the only stop.'));
assert.ok(t.body.endsWith('\nAlerts un-silenced: the time changed.'));
t = departureAlertTexts({ ...PLAN, state: 'no_route', route_source: 'none', route_error: '403: key missing' }, ORDER, { ...NOBODY, stage: 'cannot_plan' });
assert.equal(t.title, 'Cannot plan departure: Canelle (Sat Sep 12)');
assert.equal(t.body, 'Apple Maps routing failed (403: key missing). Leave-by unknown until it works.');
assert.equal(departureAlertTexts({ ...PLAN, state: 'no_address', dest_address: '45 Ocean Ave' }, ORDER, { ...NOBODY, stage: 'cannot_plan' }).body, 'Address "45 Ocean Ave" is incomplete (no town or state); fix it on the invoice.');
assert.equal(departureAlertTexts({ ...PLAN, state: 'no_time', window_text: 'before the ceremony' }, ORDER, { ...NOBODY, stage: 'cannot_plan' }).body, 'Window reads "before the ceremony" and I cannot read a clock time from it. Fix it in Needs you.');
const vegasPlan = { ...PLAN, market: 'vegas', origin_label: 'where Lian clocked in', arrive_at: '2026-09-12T21:00:00.000Z', leave_by_at: '2026-09-12T19:30:00.000Z', has_ferry: false, drive_seconds: 1800, dest_address: 'Wynn, Las Vegas, NV' };
t = departureAlertTexts(vegasPlan, { client_name: 'Dana Ruiz', venue: 'Wynn' }, { market: 'vegas', stage: 'leave_now', nowMs: T('2026-09-12T19:30:00Z'), onShift: [], unreachable: [] });
assert.equal(t.body, 'Leave-by 12:30 PM PT is now. Arrive 2:00 PM PT at Wynn, Las Vegas, NV. 30m. On shift (Vegas): nobody clocked in.');
for (const text of [t.body, t.title]) { assert.ok(!text.includes('@')); assert.ok(!/\d{3}[\s.-]\d{3}[\s.-]\d{4}/.test(text)); assert.ok(!text.includes('$')); }
pass('departureAlertTexts: heads_up, leave_now, late, running_late, missed (claim and no claim), moving_no_pickup, crew_ack, cannot_plan, Vegas, alt/multi/unsilenced tails, no contact details');

// ── 15. dayBeforeLines ──────────────────────────────────────────────
const orders = [
  ORDER,
  { id: 'o2', client_name: 'Marcus Lee', venue: 'Surf Lodge, Montauk', coconuts_qty: 50 },
  { id: 'o3', client_name: 'Dana Ruiz', venue: 'Topping Rose, Bridgehampton', coconuts_qty: 60 },
  { id: 'o4', client_name: 'Priya Shah', venue: '45 Ocean Ave' },
  { id: 'o5', client_name: 'Tom Baker', venue: "Gurney's, Montauk" },
];
const plans = new Map([
  [ORDER.id, PLAN],
  ['o2', { state: 'no_time', window_text: 'before the ceremony', dest_address: 'Surf Lodge, Montauk' }],
  ['o3', { state: 'needs_ampm', window_text: '7', dest_address: 'Topping Rose, Bridgehampton' }],
  ['o4', { state: 'no_address', dest_address: '45 Ocean Ave' }],
  ['o5', { state: 'no_route', route_source: 'none', route_error: '403: API not enabled', dest_address: "Gurney's, Montauk" }],
]);
const db = dayBeforeLines('ny', orders, plans,
  [{ client_name: 'Abigail Canelle', proposed_label: '2:00 PM', on_file_window: '3:30/4 PM' }],
  [{ client_name: 'Marcus Lee', why: 'coordinator PDF read, no arrival time found' }],
  ['Jayden Martin'], { day: '2026-09-12' });
assert.equal(db.title, 'Tomorrow Sat Sep 12 (NY): 5 jobs');
assert.equal(db.manageBody.split('\n')[0], '• Abigail Canelle · Pridwin Hotel, Shelter Island, NY · arrive 3:30 PM (window "As close to 3:30/4 PM as possible") · leave NJ garage by 10:55 AM (3h 05m predicted traffic incl. ferry, +1h buffer, +30m ferry) · 100 coconuts: brand and box them TODAY (Fri)');
assert.deepEqual(db.manageBody.split('\n').slice(1), [
  '• NO TIME ON FILE: Marcus Lee · Surf Lodge, Montauk · window reads "before the ceremony" and I cannot read a clock time from it. Fix it in Needs you.',
  '• AM OR PM? Dana Ruiz · Topping Rose, Bridgehampton · window "7" has no AM or PM, so no leave-by and no alerts until you settle it in Needs you.',
  '• NO ADDRESS: Priya Shah (venue: 45 Ocean Ave, incomplete) · add the full shipping address on the invoice.',
  "• NO DRIVE TIME: Tom Baker · Gurney's, Montauk · Apple Maps routing failed (403: API not enabled). Leave-by unknown.",
  "• UNDECIDED EMAIL about tomorrow: Canelle, a coordinator email says 2:00 PM, on file 3:30/4 PM. Tomorrow's alarm uses 2:00 PM until you decide (Needs you).",
  '• UNREAD EMAIL about tomorrow: Marcus Lee, coordinator PDF read, no arrival time found. Open it in Outlook.',
  '• No alerts reach: Jayden Martin (phone not registered; ask them to open HC Field and allow notifications).',
]);
assert.equal(db.teamBody, '• Abigail Canelle · Pridwin Hotel, Shelter Island, NY · arrive 3:30 PM · leave NJ garage by 10:55 AM (3h 05m incl. ferry + 1h buffer) · 100 coconuts: brand and box them TODAY (Fri)');
const alt = dayBeforeLines('ny', [ORDER], new Map([[ORDER.id, { ...PLAN, alt_arrive_at: '2026-09-12T18:00:00.000Z', leave_by_at: '2026-09-12T13:25:00.000Z' }]]), [], [], [], { day: '2026-09-12' });
assert.ok(alt.teamBody.endsWith(' · time not final (a coordinator email says 2:00 PM, Sidd is deciding); the alarm uses 9:25 AM'));
const many = dayBeforeLines('ny', Array.from({ length: 15 }, (_, i) => ({ id: 'm' + i, client_name: 'Client Number ' + i, venue: 'Some Long Venue Name ' + i + ', Southampton, NY', coconuts_qty: 100 })),
  new Map(Array.from({ length: 15 }, (_, i) => ['m' + i, { ...PLAN, dest_address: 'Some Long Venue Name ' + i + ', Southampton, NY' }])), [], [], [], { day: '2026-09-12' });
assert.ok(enc.encode(many.manageBody).length <= 1500 && many.manageBody.includes('… plus'), many.manageBody.length);
assert.ok(enc.encode(many.teamBody).length <= 1500);
assert.ok(many.manageBody.includes('15 stops in NY tomorrow') || many.manageBody.includes('… plus'));
for (const text of [db.manageBody, db.teamBody]) { assert.ok(!text.includes('@')); assert.ok(!text.includes('$')); }
pass('dayBeforeLines: the manage body byte for byte, the crew body, the alt-time crew line, the 1,500-byte cap');

console.log(`\nPASS: ${passed} departure plan checks. No network, no database.`);

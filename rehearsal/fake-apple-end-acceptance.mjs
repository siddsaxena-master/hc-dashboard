// Database-backed rehearsal for the temporary migration-017 END drain.
//
// This script can write only to the named disposable Supabase project. It
// executes the real temporary producer, validates its exact END queue row,
// substitutes a local 200 response for Apple, and applies the same guarded
// token-delete-then-queue-finish sequence as the temporary sender. It never
// reads Apple credentials and never contacts an Apple host.

import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { runEndDrain017 } from '../worker/end-drain-017.js';

export const REHEARSAL_PROJECT_REF = 'gfbtxfwavninuapjzksk';
export const REHEARSAL_HOST = `${REHEARSAL_PROJECT_REF}.supabase.co`;
export const REQUIRED_CONFIRMATION =
  `${REHEARSAL_PROJECT_REF}:fake-apple-end-acceptance`;
export const EXPECTED_TOKEN_ID = '00000000-0000-4000-8000-000000001501';
export const EXPECTED_SHIFT_ID = '00000000-0000-4000-8000-000000001511';
export const LIVE_ACTIVITY_TOPIC =
  'com.hamptonscoconuts.field.push-type.liveactivity';
export const GATE_INTERVAL_MS = 5 * 60 * 1000;

const MAX_ATTEMPTS = 5;
const CLAIM_STALE_MS = 3 * 60 * 1000;
const REQUEST_LIMIT = 1000;
const BLOCKING_END_ERRORS = [
  'topic or provider authentication rejected',
  'bad la_end payload',
  'cleanup failed',
  'retry budget exhausted',
];

function iso(value = Date.now()) {
  return new Date(value).toISOString();
}

export function guardedEnvironment(source = process.env) {
  const rawUrl = String(source.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const serviceKey = String(source.SUPABASE_SERVICE_KEY || '').trim();
  const confirmation = String(
    source.HC_FAKE_APPLE_REHEARSAL_PROJECT || '',
  ).trim();
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('A valid rehearsal SUPABASE_URL is required');
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== REHEARSAL_HOST ||
      parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error(
      `Safety stop: this harness runs only on ${REHEARSAL_HOST}`,
    );
  }
  if (confirmation !== REQUIRED_CONFIRMATION) {
    throw new Error(
      'Safety stop: HC_FAKE_APPLE_REHEARSAL_PROJECT is not the exact ' +
      'disposable-project confirmation',
    );
  }
  if (!serviceKey) {
    throw new Error('The rehearsal SUPABASE_SERVICE_KEY is required');
  }
  return {
    SUPABASE_URL: rawUrl,
    SUPABASE_SERVICE_KEY: serviceKey,
    END_DRAIN_MAX_BATCHES: '1',
  };
}

function serviceHeaders(env, extras = {}) {
  return {
    apikey: env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    ...extras,
  };
}

function restUrl(env, table, filters = {}) {
  const url = new URL(`/rest/v1/${table}`, `${env.SUPABASE_URL}/`);
  for (const [name, value] of Object.entries(filters)) {
    url.searchParams.set(name, value);
  }
  return url;
}

async function jsonResponse(response, label) {
  if (!response.ok) {
    throw new Error(`${label} failed with status ${response.status}`);
  }
  const value = await response.json();
  if (!Array.isArray(value)) {
    throw new Error(`${label} returned a non-array response`);
  }
  return value;
}

async function selectRows(env, table, filters, label) {
  const rows = await jsonResponse(await fetch(restUrl(env, table, {
    ...filters,
    limit: String(REQUEST_LIMIT),
  }), { headers: serviceHeaders(env) }), label);
  if (rows.length === REQUEST_LIMIT) {
    throw new Error(`${label} reached the rehearsal safety row limit`);
  }
  return rows;
}

async function patchRows(env, table, filters, body, label) {
  return jsonResponse(await fetch(restUrl(env, table, filters), {
    method: 'PATCH',
    headers: serviceHeaders(env, {
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    }),
    body: JSON.stringify(body),
  }), label);
}

async function deleteRows(env, table, filters, label) {
  return jsonResponse(await fetch(restUrl(env, table, filters), {
    method: 'DELETE',
    headers: serviceHeaders(env, { Prefer: 'return=representation' }),
  }), label);
}

function sameInstant(left, right) {
  return Number.isFinite(Date.parse(String(left || ''))) &&
    Date.parse(String(left)) === Date.parse(String(right));
}

export function validateEndContract(queueRow, tokenRow) {
  assert.equal(queueRow.id, tokenRow.end_queue_id,
    'queue ID must equal the token lease queue ID');
  assert.equal(queueRow.kind, 'la_end', 'queue kind must be la_end');
  assert.equal(queueRow.done_at, null, 'queue must still be unfinished');
  assert.ok(Number(queueRow.attempts || 0) < MAX_ATTEMPTS,
    'queue retry budget must be available');

  const payload = queueRow.payload;
  assert.ok(payload && typeof payload === 'object' && !Array.isArray(payload),
    'queue payload must be an object');
  assert.deepEqual(payload.tokens, [tokenRow.token],
    'queue must contain only the exact preserved token');
  assert.equal(payload.live_activity_token_id, tokenRow.id,
    'payload token ID must match the preserved row');
  assert.equal(payload.live_activity_shift_id, tokenRow.shift_id,
    'payload shift ID must match the preserved row');
  assert.equal(payload.live_activity_queue_id, queueRow.id,
    'payload queue ID must match the queue row');
  assert.ok(sameInstant(
    payload.live_activity_end_requested_at,
    tokenRow.end_requested_at,
  ), 'payload claim time must match the exact token lease');

  assert.deepEqual(payload.headers, {
    topic: LIVE_ACTIVITY_TOPIC,
    push_type: 'liveactivity',
    priority: 10,
    collapse_id: queueRow.id,
  }, 'queue headers must match the reviewed Live Activity END contract');
  assert.equal(payload.aps?.event, 'end', 'APS event must be END');
  assert.ok(Number.isInteger(payload.aps?.timestamp),
    'APS timestamp must be an integer');
  assert.ok(Number.isInteger(payload.aps?.['dismissal-date']) &&
    payload.aps['dismissal-date'] <= payload.aps.timestamp,
  'APS dismissal must not be later than its timestamp');
  assert.ok(payload.aps?.['content-state'] &&
    typeof payload.aps['content-state'] === 'object' &&
    !Array.isArray(payload.aps['content-state']),
  'APS content state must be an object');
  return true;
}

// This is the entire Apple substitute. It is deliberately synchronous and
// has no network capability. A valid reviewed END request receives local 200.
export function fakeAppleAccept(queueRow, tokenRow) {
  validateEndContract(queueRow, tokenRow);
  return { status: 200, reason: '' };
}

async function assertInitialPreservedRow(env) {
  const tokens = await selectRows(env, 'live_activity_tokens', {
    select: 'id,token,token_type,shift_id,device_id,end_requested_at,end_queue_id',
    token_type: 'eq.activity_update',
  }, 'initial preserved-token read');
  assert.equal(tokens.length, 1,
    'exactly one preserved Activity Update row is required');
  const tokenRow = tokens[0];
  assert.equal(tokenRow.id, EXPECTED_TOKEN_ID,
    'the fixed rehearsal token row is required');
  assert.equal(tokenRow.shift_id, EXPECTED_SHIFT_ID,
    'the fixed closed rehearsal shift is required');
  assert.equal(tokenRow.device_id, tokenRow.id,
    'the preservation marker must use its reviewed self-equal identity');
  assert.equal(tokenRow.end_requested_at, null,
    'the preserved token must not already be leased');
  assert.equal(tokenRow.end_queue_id, null,
    'the preserved token must not already name a queue row');
  assert.match(String(tokenRow.token || ''), /^[0-9a-f]{32,512}$/i,
    'the preserved token shape must be valid');

  const shifts = await selectRows(env, 'shifts', {
    select: 'id,clock_out_at',
    id: `eq.${EXPECTED_SHIFT_ID}`,
  }, 'expected closed-shift read');
  assert.equal(shifts.length, 1, 'the fixed rehearsal shift must exist');
  assert.ok(shifts[0].clock_out_at,
    'the fixed rehearsal shift must be clocked out');

  const openShifts = await selectRows(env, 'shifts', {
    select: 'id',
    clock_out_at: 'is.null',
  }, 'initial open-shift gate');
  assert.equal(openShifts.length, 0,
    'the rehearsal must begin with zero open shifts');
}

async function loadExactTokenAndQueue(env) {
  const tokens = await selectRows(env, 'live_activity_tokens', {
    select: 'id,token,token_type,shift_id,device_id,end_requested_at,end_queue_id',
    id: `eq.${EXPECTED_TOKEN_ID}`,
    token_type: 'eq.activity_update',
  }, 'claimed preserved-token read');
  assert.equal(tokens.length, 1, 'producer must retain the exact token lease');
  const tokenRow = tokens[0];
  assert.ok(tokenRow.end_requested_at && tokenRow.end_queue_id,
    'producer must assign the exact durable END lease');

  const queues = await selectRows(env, 'push_queue', {
    select: 'id,kind,payload,created_at,claimed_at,done_at,attempts,last_error',
    id: `eq.${tokenRow.end_queue_id}`,
    kind: 'eq.la_end',
  }, 'produced END queue read');
  assert.equal(queues.length, 1, 'producer must create one exact END queue row');
  validateEndContract(queues[0], tokenRow);
  return { tokenRow, queueRow: queues[0] };
}

async function claimExactQueue(env, queueRow) {
  const claimAt = iso();
  const staleBefore = iso(Date.now() - CLAIM_STALE_MS);
  const rows = await patchRows(env, 'push_queue', {
    id: `eq.${queueRow.id}`,
    kind: 'eq.la_end',
    done_at: 'is.null',
    attempts: `lt.${MAX_ATTEMPTS}`,
    or: `(claimed_at.is.null,claimed_at.lt.${staleBefore})`,
  }, { claimed_at: claimAt }, 'exact END queue claim');
  assert.equal(rows.length, 1,
    'the fake sender must exclusively claim one exact queue row');
  assert.ok(sameInstant(rows[0].claimed_at, claimAt),
    'the exact queue claim timestamp must be retained');
  return rows[0];
}

async function deleteExactAcceptedToken(env, tokenRow, queueRow) {
  const rows = await deleteRows(env, 'live_activity_tokens', {
    id: `eq.${tokenRow.id}`,
    token: `eq.${tokenRow.token}`,
    token_type: 'eq.activity_update',
    shift_id: `eq.${tokenRow.shift_id}`,
    end_queue_id: `eq.${queueRow.id}`,
    end_requested_at: `eq.${tokenRow.end_requested_at}`,
  }, 'accepted END exact-token cleanup');
  assert.equal(rows.length, 1,
    'accepted END must delete exactly its leased token row');
}

async function finishExactAcceptedQueue(env, queueRow) {
  const doneAt = iso();
  const rows = await patchRows(env, 'push_queue', {
    id: `eq.${queueRow.id}`,
    kind: 'eq.la_end',
    done_at: 'is.null',
    claimed_at: `eq.${queueRow.claimed_at}`,
  }, { done_at: doneAt, last_error: null }, 'accepted END queue completion');
  assert.equal(rows.length, 1,
    'accepted END must finish exactly its exclusively claimed queue row');
  assert.ok(rows[0].done_at && rows[0].last_error === null,
    'accepted END queue completion must be clean');
}

async function simulateAcceptedDelivery(env) {
  const produced = await loadExactTokenAndQueue(env);
  const claimedQueue = await claimExactQueue(env, produced.queueRow);
  validateEndContract(claimedQueue, produced.tokenRow);
  const fakeResponse = fakeAppleAccept(claimedQueue, produced.tokenRow);
  assert.deepEqual(fakeResponse, { status: 200, reason: '' },
    'local Apple substitute must return an accepted response');

  // Keep this order identical to enddrain017.py's status-200 branch. Once a
  // destination accepts END, delete the exact leased token first, then finish
  // only the queue row owned by this exact claim.
  await deleteExactAcceptedToken(env, produced.tokenRow, claimedQueue);
  await finishExactAcceptedQueue(env, claimedQueue);
}

async function zeroGate(env, rolloutStartedAt) {
  const [openShifts, activityTokens, unfinishedEnds, recentEnds] =
    await Promise.all([
      selectRows(env, 'shifts', {
        select: 'id',
        clock_out_at: 'is.null',
      }, 'open-shift gate'),
      selectRows(env, 'live_activity_tokens', {
        select: 'id,device_id,shift_id',
        token_type: 'eq.activity_update',
      }, 'Activity Update gate'),
      selectRows(env, 'push_queue', {
        select: 'id',
        kind: 'eq.la_end',
        done_at: 'is.null',
      }, 'unfinished END gate'),
      selectRows(env, 'push_queue', {
        select: 'id,last_error',
        kind: 'eq.la_end',
        created_at: `gte.${rolloutStartedAt}`,
      }, 'blocking END error gate'),
    ]);

  const closedShiftIds = [];
  for (const tokenRow of activityTokens) {
    if (!tokenRow.shift_id) continue;
    const rows = await selectRows(env, 'shifts', {
      select: 'id',
      id: `eq.${tokenRow.shift_id}`,
      clock_out_at: 'not.is.null',
    }, 'closed token shift gate');
    if (rows.length) closedShiftIds.push(tokenRow.shift_id);
  }

  const counts = {
    open_shifts: openShifts.length,
    closed_end_tokens: closedShiftIds.length,
    synthetic_recovery_ids: activityTokens.filter(
      (row) => row.device_id && row.device_id === row.id,
    ).length,
    unfinished_end_rows: unfinishedEnds.length,
    blocking_end_errors: recentEnds.filter((row) => {
      const error = String(row.last_error || '').toLowerCase();
      return BLOCKING_END_ERRORS.some((fragment) => error.includes(fragment));
    }).length,
  };
  assert.deepEqual(counts, {
    open_shifts: 0,
    closed_end_tokens: 0,
    synthetic_recovery_ids: 0,
    unfinished_end_rows: 0,
    blocking_end_errors: 0,
  }, 'every reviewed migration-017 hard-gate count must be zero');
  return counts;
}

function producerWasEmpty(stats) {
  return stats.batches === 1 && stats.claimed === 0 && stats.queued === 0 &&
    stats.retainedUnknown === 0 && stats.released === 0 &&
    stats.malformed === 0;
}

export async function runFakeAppleEndAcceptance(source = process.env) {
  const env = guardedEnvironment(source);
  const rolloutStartedAt = iso();
  console.log(`SAFE PROJECT: ${REHEARSAL_PROJECT_REF}`);
  console.log('Apple mode: local accepted-response substitute, no Apple network');

  await assertInitialPreservedRow(env);
  console.log('PASS  preserved closed-shift END row is exact');

  const firstProducer = await runEndDrain017(env, { maxBatches: 1 });
  assert.equal(firstProducer.claimed, 1,
    'first producer cycle must claim the one preserved row');
  assert.equal(firstProducer.queued, 1,
    'first producer cycle must queue the one preserved END');
  assert.equal(firstProducer.retainedUnknown, 0,
    'first producer cycle must retain no uncertain lease');
  assert.equal(firstProducer.released, 0,
    'first producer cycle must release no valid lease');
  assert.equal(firstProducer.malformed, 0,
    'first producer cycle must find no malformed claim');
  console.log('PASS  real temporary producer created one exact END queue row');

  await simulateAcceptedDelivery(env);
  console.log('PASS  local Apple 200 deleted the exact token, then finished its queue');

  const firstGate = await zeroGate(env, rolloutStartedAt);
  console.log('PASS  zero gate 1', JSON.stringify(firstGate));
  console.log('WAIT  one full five-minute producer interval');
  await new Promise((resolve) => setTimeout(resolve, GATE_INTERVAL_MS));

  const secondProducer = await runEndDrain017(env, { maxBatches: 1 });
  assert.ok(producerWasEmpty(secondProducer),
    'second producer cycle must claim and queue zero rows');
  console.log('PASS  second producer cycle claimed zero rows');

  const secondGate = await zeroGate(env, rolloutStartedAt);
  console.log('PASS  zero gate 2', JSON.stringify(secondGate));
  console.log('PASS  fake Apple migration-017 database acceptance completed');
  return { firstProducer, firstGate, secondProducer, secondGate };
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (invokedPath === import.meta.url) {
  runFakeAppleEndAcceptance().catch((error) => {
    console.error('FAIL ', error?.message || String(error));
    process.exitCode = 1;
  });
}

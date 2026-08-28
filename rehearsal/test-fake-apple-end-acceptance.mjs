// Offline safety tests for the database-backed fake Apple rehearsal.
// No Supabase or Apple request leaves this process.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  EXPECTED_SHIFT_ID,
  EXPECTED_TOKEN_ID,
  GATE_INTERVAL_MS,
  REHEARSAL_HOST,
  REQUIRED_CONFIRMATION,
  fakeAppleAccept,
  guardedEnvironment,
  validateEndContract,
} from './fake-apple-end-acceptance.mjs';

const source = await readFile(
  new URL('./fake-apple-end-acceptance.mjs', import.meta.url),
  'utf8',
);
const daemon = await readFile(
  new URL('../droplet/enddrain017.py', import.meta.url),
  'utf8',
);

const SERVICE_KEY = 'offline-rehearsal-service-key';
const SAFE_ENV = {
  SUPABASE_URL: `https://${REHEARSAL_HOST}`,
  SUPABASE_SERVICE_KEY: SERVICE_KEY,
  HC_FAKE_APPLE_REHEARSAL_PROJECT: REQUIRED_CONFIRMATION,
};
const TOKEN = 'a'.repeat(64);
const QUEUE_ID = '22222222-2222-4222-8222-222222222222';
const CLAIMED_AT = '2026-08-27T20:00:00.000Z';
const tokenRow = {
  id: EXPECTED_TOKEN_ID,
  token: TOKEN,
  token_type: 'activity_update',
  shift_id: EXPECTED_SHIFT_ID,
  device_id: EXPECTED_TOKEN_ID,
  end_requested_at: CLAIMED_AT,
  end_queue_id: QUEUE_ID,
};
const queueRow = {
  id: QUEUE_ID,
  kind: 'la_end',
  claimed_at: null,
  done_at: null,
  attempts: 0,
  payload: {
    tokens: [TOKEN],
    headers: {
      topic: 'com.hamptonscoconuts.field.push-type.liveactivity',
      push_type: 'liveactivity',
      priority: 10,
      collapse_id: QUEUE_ID,
    },
    aps: {
      timestamp: 1787860800,
      event: 'end',
      'content-state': { status: 'Clocked out' },
      'dismissal-date': 1787860799,
    },
    live_activity_token_id: EXPECTED_TOKEN_ID,
    live_activity_shift_id: EXPECTED_SHIFT_ID,
    live_activity_queue_id: QUEUE_ID,
    live_activity_end_requested_at: CLAIMED_AT,
  },
};

let total = 0;
let failed = 0;
async function check(name, fn) {
  total += 1;
  try {
    await fn();
    console.log('PASS ', name);
  } catch (error) {
    failed += 1;
    console.error('FAIL ', name, error);
  }
}

await check('guard accepts only the exact disposable project and confirmation', () => {
  const env = guardedEnvironment(SAFE_ENV);
  assert.equal(env.SUPABASE_URL, `https://${REHEARSAL_HOST}`);
  assert.equal(env.SUPABASE_SERVICE_KEY, SERVICE_KEY);
});

await check('guard rejects the production project even with confirmation', () => {
  assert.throws(() => guardedEnvironment({
    ...SAFE_ENV,
    SUPABASE_URL: 'https://omdcfphbwuwsrffdszlg.supabase.co',
  }), /runs only/);
});

await check('guard rejects custom hosts, paths, and missing confirmation', () => {
  for (const badUrl of [
    `http://${REHEARSAL_HOST}`,
    `https://${REHEARSAL_HOST}.attacker.invalid`,
    `https://${REHEARSAL_HOST}/rest/v1`,
  ]) {
    assert.throws(() => guardedEnvironment({
      ...SAFE_ENV,
      SUPABASE_URL: badUrl,
    }), /runs only/);
  }
  assert.throws(() => guardedEnvironment({
    ...SAFE_ENV,
    HC_FAKE_APPLE_REHEARSAL_PROJECT: '',
  }), /confirmation/);
});

await check('local accepted response requires the exact reviewed END contract', () => {
  assert.equal(validateEndContract(queueRow, tokenRow), true);
  assert.deepEqual(fakeAppleAccept(queueRow, tokenRow), {
    status: 200,
    reason: '',
  });
  assert.throws(() => fakeAppleAccept({
    ...queueRow,
    payload: { ...queueRow.payload, tokens: ['b'.repeat(64)] },
  }, tokenRow), /exact preserved token/);
});

await check('harness never names an Apple host or Apple credential variable', () => {
  assert.doesNotMatch(source, /api\.push\.apple\.com/);
  assert.doesNotMatch(source, /APPLE_TEAM_ID|APNS_KEY_ID|APNS_P8_PATH/);
  assert.match(source, /synchronous and\s*\/\/ has no network capability/);
});

await check('harness executes the real temporary producer twice', () => {
  assert.match(source, /import \{ runEndDrain017 \}/);
  assert.equal((source.match(/await runEndDrain017\(/g) || []).length, 2);
  assert.match(source, /second producer cycle must claim and queue zero rows/);
});

await check('accepted database cleanup order matches the real daemon', () => {
  const harnessDelete = source.indexOf(
    'await deleteExactAcceptedToken(env, produced.tokenRow, claimedQueue)',
  );
  const harnessFinish = source.indexOf(
    'await finishExactAcceptedQueue(env, claimedQueue)',
  );
  assert.ok(harnessDelete >= 0 && harnessDelete < harnessFinish);
  const daemonAccepted = daemon.indexOf('if status == 200:');
  const daemonDelete = daemon.indexOf('_delete_exact_token(identity)', daemonAccepted);
  const daemonFinish = daemon.indexOf('_finish_queue(', daemonAccepted);
  assert.ok(daemonAccepted >= 0 && daemonDelete < daemonFinish);
  assert.match(source, /end_queue_id: `eq\.\$\{queueRow\.id\}`/);
  assert.match(source, /end_requested_at: `eq\.\$\{tokenRow\.end_requested_at\}`/);
  assert.match(source, /claimed_at: `eq\.\$\{queueRow\.claimed_at\}`/);
});

await check('two zero gates are separated by a full five-minute cycle', () => {
  assert.equal(GATE_INTERVAL_MS, 300000);
  assert.equal((source.match(/await zeroGate\(/g) || []).length, 2);
  const firstGate = source.indexOf('const firstGate = await zeroGate');
  const wait = source.indexOf('setTimeout(resolve, GATE_INTERVAL_MS)');
  const secondProducer = source.indexOf('const secondProducer = await runEndDrain017');
  const secondGate = source.indexOf('const secondGate = await zeroGate');
  assert.ok(firstGate < wait && wait < secondProducer && secondProducer < secondGate);
  for (const name of [
    'open_shifts',
    'closed_end_tokens',
    'synthetic_recovery_ids',
    'unfinished_end_rows',
    'blocking_end_errors',
  ]) {
    assert.match(source, new RegExp(`${name}: 0`));
  }
});

if (failed) {
  console.error(`\n${failed} failed, ${total - failed} passed, ${total} total`);
  process.exitCode = 1;
} else {
  console.log(`\n${total} passed, 0 failed, ${total} total`);
}

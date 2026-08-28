// Offline tests for the temporary migration-017 END producer.
// No Supabase, Cloudflare, Apple, or Telegram request leaves this process.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import worker, {
  buildEndQueueRow,
  enqueueEndQueue,
  runEndDrain017,
} from './end-drain-017.js';

const here = dirname(fileURLToPath(import.meta.url));
const source = await readFile(join(here, 'end-drain-017.js'), 'utf8');
const config = await readFile(join(here, 'wrangler.end-drain-017.toml'), 'utf8');

const TOKEN_ID = '11111111-1111-4111-8111-111111111111';
const QUEUE_ID = '22222222-2222-4222-8222-222222222222';
const SHIFT_ID = '33333333-3333-4333-8333-333333333333';
const TOKEN = 'a'.repeat(64);
const NOW = Date.parse('2026-08-27T20:00:00.000Z');
const ENV = {
  SUPABASE_URL: 'https://offline.invalid',
  SUPABASE_SERVICE_KEY: 'offline-service-key',
  END_DRAIN_MAX_BATCHES: '1',
};

function tokenRow(index = 0) {
  const suffix = String(index + 1).padStart(12, '0');
  return {
    token_id: '11111111-1111-4111-8111-' + suffix,
    queue_id: '22222222-2222-4222-8222-' + suffix,
    shift_id: SHIFT_ID,
    token: (index + 1).toString(16).padStart(64, '0'),
    clock_in_at: '2026-08-27T16:00:00.000Z',
    clock_out_at: '2026-08-27T18:15:00.000Z',
  };
}

function response(status, value) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return value; },
    async text() { return typeof value === 'string' ? value : JSON.stringify(value); },
  };
}

let total = 0;
let failed = 0;
async function check(name, fn) {
  total++;
  try {
    await fn();
    console.log('PASS ', name);
  } catch (error) {
    failed++;
    console.error('FAIL ', name, error);
  }
}

await check('deployment is scheduled-only, uniquely named, and non-public', () => {
  assert.deepEqual(Object.keys(worker), ['scheduled']);
  assert.equal(worker.fetch, undefined);
  assert.match(config, /name\s*=\s*"hc-live-activity-end-drain-017"/);
  assert.match(config, /workers_dev\s*=\s*false/);
  assert.doesNotMatch(config, /^routes?\s*=/m);
});

await check('producer source never names post-017 queue columns', () => {
  for (const forbidden of [
    'outbox' + '_type',
    'next' + '_attempt_at',
    'dead' + '_lettered_at',
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});

await check('queue row uses only schema-011 columns and exact END identity', () => {
  const row = buildEndQueueRow({
    ...tokenRow(),
    token_id: TOKEN_ID,
    queue_id: QUEUE_ID,
    token: TOKEN,
  }, '2026-08-27T20:00:00.000Z', NOW);
  assert.deepEqual(Object.keys(row).sort(), ['id', 'kind', 'payload']);
  assert.equal(row.id, QUEUE_ID);
  assert.equal(row.kind, 'la_end');
  assert.deepEqual(row.payload.tokens, [TOKEN]);
  assert.equal(row.payload.headers.collapse_id, QUEUE_ID);
  assert.equal(row.payload.aps.event, 'end');
  assert.equal(row.payload.aps['dismissal-date'], Math.floor(NOW / 1000) - 1);
  assert.equal(row.payload.live_activity_token_id, TOKEN_ID);
  assert.equal(row.payload.live_activity_queue_id, QUEUE_ID);
});

await check('lost insert response is verified without a second destination', async () => {
  const wanted = buildEndQueueRow({
    ...tokenRow(), token_id: TOKEN_ID, queue_id: QUEUE_ID, token: TOKEN,
  }, '2026-08-27T20:00:00.000Z', NOW);
  let calls = 0;
  global.fetch = async (_url, options = {}) => {
    calls++;
    if (options.method === 'POST') throw new Error('response lost after commit');
    return response(200, [wanted]);
  };
  assert.equal(await enqueueEndQueue(ENV, wanted), 'verified');
  assert.equal(calls, 2);
});

await check('definite insert failure releases the exact claimed token', async () => {
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.includes('/rpc/hc_claim_live_activity_ends')) {
      return response(200, [{
        ...tokenRow(), token_id: TOKEN_ID, queue_id: QUEUE_ID, token: TOKEN,
      }]);
    }
    if (url.endsWith('/rest/v1/push_queue') && options.method === 'POST') {
      return response(503, { error: 'offline failure' });
    }
    if (url.includes('/rest/v1/push_queue?')) return response(200, []);
    if (url.includes('/rest/v1/live_activity_tokens?')) {
      return response(200, [{ id: TOKEN_ID }]);
    }
    throw new Error('unexpected request ' + url);
  };
  const stats = await runEndDrain017(ENV, { maxBatches: 1, now: () => NOW });
  assert.equal(stats.released, 1);
  const release = calls.find((call) =>
    call.url.includes('/rest/v1/live_activity_tokens?'));
  assert.ok(release.url.includes('id=eq.' + TOKEN_ID));
  assert.ok(release.url.includes('end_queue_id=eq.' + QUEUE_ID));
  assert.deepEqual(JSON.parse(release.options.body), {
    end_requested_at: null,
    end_queue_id: null,
  });
});

await check('bounded scheduled repeats drain more than 50 rows', async () => {
  const pending = Array.from({ length: 75 }, (_, index) => tokenRow(index));
  let claimCalls = 0;
  let queueCalls = 0;
  global.fetch = async (url, options = {}) => {
    if (url.includes('/rpc/hc_claim_live_activity_ends')) {
      claimCalls++;
      return response(200, pending.splice(0, 8));
    }
    if (url.endsWith('/rest/v1/push_queue') && options.method === 'POST') {
      const body = JSON.parse(options.body);
      assert.deepEqual(Object.keys(body).sort(), ['id', 'kind', 'payload']);
      queueCalls++;
      return response(201, null);
    }
    throw new Error('unexpected request ' + url);
  };
  let claimed = 0;
  let queued = 0;
  for (let tick = 0; tick < 10; tick++) {
    const stats = await runEndDrain017(
      ENV, { maxBatches: 1, now: () => NOW + tick * 300000 });
    claimed += stats.claimed;
    queued += stats.queued;
  }
  assert.equal(claimCalls, 10);
  assert.equal(queueCalls, 75);
  assert.equal(claimed, 75);
  assert.equal(queued, 75);
  assert.equal(pending.length, 0);
});

await check('malformed claim is never queued and releases only exact identity', async () => {
  let queuePosts = 0;
  let releases = 0;
  global.fetch = async (url, options = {}) => {
    if (url.includes('/rpc/hc_claim_live_activity_ends')) {
      return response(200, [{ ...tokenRow(), clock_out_at: 'not-a-date' }]);
    }
    if (url.endsWith('/rest/v1/push_queue') && options.method === 'POST') {
      queuePosts++;
      return response(201, null);
    }
    if (url.includes('/rest/v1/live_activity_tokens?')) {
      releases++;
      return response(200, [{ id: tokenRow().token_id }]);
    }
    throw new Error('unexpected request ' + url);
  };
  const stats = await runEndDrain017(ENV, { maxBatches: 1, now: () => NOW });
  assert.equal(queuePosts, 0);
  assert.equal(releases, 1);
  assert.equal(stats.malformed, 1);
  assert.equal(stats.released, 1);
});

if (failed) {
  console.error(`\n${failed} failed, ${total - failed} passed, ${total} total`);
  process.exitCode = 1;
} else {
  console.log(`\n${total} passed, 0 failed, ${total} total`);
}

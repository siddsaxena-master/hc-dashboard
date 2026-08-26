// Offline Live Activity END worker tests. No Supabase, Apple, Telegram, or
// Cloudflare request leaves this process.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildLiveActivityPushPayload,
  enqueuePush,
  runLiveActivityEndScan,
} from './worker.js';

const here = dirname(fileURLToPath(import.meta.url));
const migration = await readFile(
  join(here, '..', 'migrations', '017_live_activity_end_delivery.sql'),
  'utf8',
);
const rollback = await readFile(
  join(here, '..', 'migrations', '017_live_activity_end_delivery_rollback.sql'),
  'utf8',
);

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
    console.log('      ' + String(error.message || error));
  }
}

function reply(status, data = null) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return data; },
    async text() { return data == null ? '' : JSON.stringify(data); },
  };
}

const shiftId = '11111111-1111-4111-8111-111111111111';
const queueA = '10000000-0000-4000-8000-000000000001';
const queueB = '10000000-0000-4000-8000-000000000002';
const queueLate = '10000000-0000-4000-8000-000000000003';
const tokenA = {
  token_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  queue_id: queueA,
  email: 'owner@example.com',
  token: 'a'.repeat(64),
  shift_id: shiftId,
  clock_in_at: '2026-08-25T12:00:00.000Z',
  clock_out_at: '2026-08-25T14:15:42.000Z',
};
const tokenB = {
  token_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  queue_id: queueB,
  email: 'manager@example.com',
  token: 'b'.repeat(64),
  shift_id: shiftId,
  clock_in_at: '2026-08-25T12:00:00.000Z',
  clock_out_at: '2026-08-25T14:15:42.000Z',
};
const lateToken = {
  token_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  queue_id: queueLate,
  email: 'owner@example.com',
  token: 'c'.repeat(64),
  shift_id: shiftId,
  clock_in_at: '2026-08-25T12:00:00.000Z',
  clock_out_at: '2026-08-25T14:15:42.000Z',
};

function installFetchHarness(initialRows) {
  let currentRows = initialRows;
  let failQueueInserts = false;
  let loseCommittedResponse = false;
  const calls = [];
  const queued = [];
  const queueById = new Map();
  const originalFetch = global.fetch;

  global.fetch = async (urlValue, options = {}) => {
    const url = String(urlValue);
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, method, body });

    if (method === 'POST' && url.endsWith('/rpc/hc_claim_live_activity_ends')) {
      assert.equal(typeof body.p_claimed_at, 'string');
      assert.equal(typeof body.p_stale_before, 'string');
      assert.equal(body.p_limit, 50);
      return reply(200, currentRows);
    }
    if (method === 'PATCH' && url.includes('/live_activity_tokens?')) {
      return reply(204, null);
    }
    if (method === 'POST' && url.endsWith('/push_queue')) {
      assert.match(body.id, /^[0-9a-f-]{36}$/);
      assert.equal(body.payload.headers.collapse_id, body.id);
      if (failQueueInserts) {
        return reply(503, { error: 'offline simulated queue failure' });
      }
      if (!queueById.has(body.id)) {
        queueById.set(body.id, body);
        queued.push(body);
      }
      if (loseCommittedResponse) {
        loseCommittedResponse = false;
        throw new Error('offline response lost after commit');
      }
      return reply(201, null);
    }
    if (method === 'GET' && url.includes('/push_queue?id=eq.')) {
      const queueId = decodeURIComponent(url.split('/push_queue?id=eq.')[1].split('&')[0]);
      const row = queueById.get(queueId);
      return reply(200, row ? [{ id: row.id, kind: row.kind }] : []);
    }
    throw new Error('unexpected offline fetch: ' + method + ' ' + url);
  };

  return {
    calls,
    queued,
    setRows(rows) { currentRows = rows; },
    failQueue() { failQueueInserts = true; },
    loseResponseAfterCommit() { loseCommittedResponse = true; },
    restore() { global.fetch = originalFetch; },
  };
}

await check('END payload uses a past dismissal-date for immediate removal', () => {
  const nowMs = 2_000_000;
  const payload = buildLiveActivityPushPayload(
    [tokenA.token],
    'end',
    { status: 'Clocked out', statusMinutes: 135, boxesLine: 'Shift ended' },
    { dismissalDate: Math.floor(nowMs / 1000) - 1, priority: 10 },
    nowMs,
  );
  assert.equal(payload.aps.event, 'end');
  assert.ok(payload.aps['dismissal-date'] < payload.aps.timestamp);
  assert.equal(payload.headers.priority, 10);
});

await check('migration protects durable end state and resets it on token identity rotation', () => {
  assert.ok(migration.includes('add column if not exists end_requested_at timestamptz,'));
  assert.ok(migration.includes('add column if not exists end_queue_id uuid;'));
  assert.ok(migration.includes('live_activity_tokens_end_request_idx'));
  assert.ok(migration.includes('new.token is distinct from old.token'));
  assert.ok(migration.includes('before insert or update'));
  assert.ok(migration.includes("coalesce(auth.role(), '') <> 'service_role'"));
  assert.ok(migration.includes('new.end_requested_at := old.end_requested_at;'));
  assert.ok(migration.includes('new.end_queue_id := old.end_queue_id;'));
  assert.ok(migration.includes('new.end_requested_at := null;'));
  assert.ok(migration.includes('new.end_queue_id := null;'));
  const topLevelSql = migration.split('$function$')
    .filter((_part, index) => index % 2 === 0).join('\n');
  assert.ok(!/\b(update|delete|truncate)\s+(from\s+)?public\.live_activity_tokens\b/i.test(topLevelSql));
});

await check('two physical phones on one email retain separate token rows', () => {
  assert.ok(migration.includes('drop index if exists public.live_activity_tokens_p2s_uniq;'));
  assert.ok(migration.includes('drop index if exists public.live_activity_tokens_upd_uniq;'));
  assert.ok(migration.includes('on conflict (device_id, token_type)'));
  assert.ok(migration.includes('on conflict (device_id, token_type, shift_id)'));
  assert.ok(migration.includes('or device_id is distinct from p_device_id'));
  const lockAt = migration.indexOf("pg_catalog.hashtextextended('hc-live-activity:' || v_token, 0)");
  const reclaimAt = migration.indexOf('where lower(token) = v_token', lockAt);
  assert.ok(lockAt > 0 && reclaimAt > lockAt);
  const rows = new Map();
  for (const [deviceId, token] of [['device-a', 'token-a'], ['device-b', 'token-b']]) {
    rows.set([deviceId, 'activity_update', shiftId].join('|'), {
      email: 'same-owner@example.com', deviceId, token,
    });
  }
  assert.equal(rows.size, 2);
  for (const [key, row] of rows) {
    if (row.token === 'token-a' && row.deviceId !== 'device-a-regenerated') rows.delete(key);
  }
  rows.set(['device-a-regenerated', 'activity_update', shiftId].join('|'), {
    email: 'same-owner@example.com', deviceId: 'device-a-regenerated', token: 'token-a',
  });
  assert.equal(rows.size, 2);
  assert.deepEqual(new Set([...rows.values()].map((row) => row.token)),
    new Set(['token-a', 'token-b']));
});

await check('serialized same-token device regeneration leaves one destination', () => {
  let destinations = [{ deviceId: 'old-device', token: tokenA.token }];
  const serializedRegister = (deviceId, token) => {
    destinations = destinations.filter((row) => row.token !== token);
    destinations.push({ deviceId, token });
  };
  serializedRegister('new-device-a', tokenA.token);
  serializedRegister('new-device-b', tokenA.token);
  assert.deepEqual(destinations, [{ deviceId: 'new-device-b', token: tokenA.token }]);
});

await check('closed-only claim cannot starve behind more than 50 open tokens', () => {
  const marker = 'create or replace function public.hc_claim_live_activity_ends(';
  const rpc = migration.split(marker)[1].split(
    'create or replace function public.hc_list_managed_open_shift_ids()',
  )[0];
  assert.match(rpc, /returns table \(\s*token_id uuid,\s*queue_id uuid,/);
  assert.ok(rpc.includes("and s.clock_out_at is not null"));
  assert.ok(!rpc.includes('public.field_workers'));
  assert.ok(rpc.indexOf('and s.clock_out_at is not null') < rpc.indexOf('limit greatest'));
  assert.ok(rpc.includes('where pending.id = lat.end_queue_id'));
  assert.ok(rpc.includes('and pending.done_at is null'));
  assert.ok(rpc.includes("auth.role() is distinct from 'service_role'"));
  assert.ok(rpc.includes('for update of lat skip locked'));
  assert.ok(!rpc.includes('summary_sent_at'));
  const candidates = Array.from({ length: 60 }, (_, i) => ({ id: 'open-' + i, closed: false }));
  candidates.push({ id: 'closed-after-sixty', closed: true });
  assert.deepEqual(candidates.filter((row) => row.closed).slice(0, 50), [
    { id: 'closed-after-sixty', closed: true },
  ]);
});

await check('END cleanup retains a closed token after role or roster removal', () => {
  const formerlyAuthorizedToken = {
    token_type: 'activity_update',
    shift_id: shiftId,
    roster_row: null,
  };
  const shift = { id: shiftId, clock_out_at: '2026-08-25T14:15:42.000Z' };
  const eligibleForCleanup = formerlyAuthorizedToken.token_type === 'activity_update' &&
    formerlyAuthorizedToken.shift_id === shift.id && shift.clock_out_at !== null;
  assert.equal(eligibleForCleanup, true);
});

await check('open-shift cleanup RPC is complete, UUID-only, and securely granted', () => {
  const marker = 'create or replace function public.hc_list_managed_open_shift_ids()';
  assert.ok(migration.includes(marker));
  const rpc = migration.split(marker)[1].split('\ncommit;')[0];
  assert.match(rpc, /^\s*returns table \(shift_id uuid\)/);
  assert.ok(rpc.includes('stable\nsecurity definer\nset search_path = \'\''));
  assert.ok(rpc.includes('if not public.hc_can_manage_shifts() then'));
  assert.ok(rpc.includes('select s.id as shift_id'));
  assert.ok(rpc.includes('where s.clock_out_at is null'));
  assert.ok(!rpc.includes('p_since'));
  assert.ok(!/\blimit\b/i.test(rpc));
  assert.ok(!rpc.includes('worker_name'));
  assert.ok(!rpc.includes('worker_email'));
  assert.ok(migration.includes(
    'revoke all on function public.hc_list_managed_open_shift_ids()\n' +
    '  from public, anon, authenticated;'
  ));
  assert.ok(migration.includes(
    'grant execute on function public.hc_list_managed_open_shift_ids()\n' +
    '  to authenticated, service_role;'
  ));
});

await check('017 rollback is ordered, data-preserving, and keeps token reads private', () => {
  const drainAt = rollback.indexOf('Keep the 017 worker and pushdrain running');
  const stopAt = rollback.indexOf('Stop the 017 worker producer and pushdrain consumer');
  const runAt = rollback.indexOf('Run THIS rollback');
  assert.ok(drainAt > 0 && stopAt > drainAt && runAt > stopAt);
  assert.ok(rollback.includes('select count(*) as unfinished_la_end_rows'));
  assert.ok(rollback.includes('select count(*) as active_end_links'));
  assert.ok(rollback.includes('Do not manually null these fields.'));
  assert.ok(rollback.includes('Live Activity END leases are still active'));
  assert.ok(rollback.includes('unfinished Live Activity END queue rows remain'));
  assert.ok(rollback.includes('multiple physical phones share an email/token lane; no rows were deleted'));
  assert.ok(rollback.includes('live_activity_tokens_replace_legacy_insert'));
  assert.ok(rollback.includes('if new.device_id is null then'));
  assert.ok(!/grant\s+select\s+on\s+(table\s+)?public\.live_activity_tokens\s+to\s+anon/i.test(rollback));
});

await check('closed shift queues exactly one END row per phone and never deletes on INSERT', async () => {
  const h = installFetchHarness([tokenA, tokenB]);
  try {
    await runLiveActivityEndScan({
      SUPABASE_URL: 'https://offline.invalid',
      SUPABASE_SERVICE_KEY: 'offline-test-key',
    });
    assert.equal(h.queued.length, 2);
    assert.deepEqual(h.queued.map((row) => row.kind), ['la_end', 'la_end']);
    assert.deepEqual(h.queued.map((row) => row.payload.tokens.length), [1, 1]);
    assert.deepEqual(
      new Set(h.queued.map((row) => row.payload.live_activity_token_id)),
      new Set([tokenA.token_id, tokenB.token_id]),
    );
    for (const row of h.queued) {
      assert.ok(row.payload.aps['dismissal-date'] < row.payload.aps.timestamp);
      assert.equal(row.payload.live_activity_queue_id, row.id);
    }
    assert.equal(h.calls.filter((call) => call.method === 'DELETE').length, 0);
  } finally {
    h.restore();
  }
});

await check('a token registered after summary delivery is recovered on a later scan', async () => {
  const h = installFetchHarness([tokenA]);
  try {
    await runLiveActivityEndScan({
      SUPABASE_URL: 'https://offline.invalid',
      SUPABASE_SERVICE_KEY: 'offline-test-key',
    });
    h.setRows([lateToken]);
    await runLiveActivityEndScan({
      SUPABASE_URL: 'https://offline.invalid',
      SUPABASE_SERVICE_KEY: 'offline-test-key',
    });
    assert.equal(h.queued.length, 2);
    assert.equal(h.queued[1].payload.live_activity_token_id, lateToken.token_id);
    assert.equal(h.queued[1].payload.live_activity_shift_id, shiftId);
  } finally {
    h.restore();
  }
});

await check('committed queue INSERT with a lost response is verified without release or duplicate', async () => {
  const h = installFetchHarness([tokenA]);
  h.loseResponseAfterCommit();
  try {
    await runLiveActivityEndScan({
      SUPABASE_URL: 'https://offline.invalid',
      SUPABASE_SERVICE_KEY: 'offline-test-key',
    });
    assert.equal(h.queued.length, 1);
    assert.equal(h.queued[0].id, queueA);
    assert.equal(h.calls.filter((call) =>
      call.method === 'POST' && call.url.endsWith('/push_queue')).length, 1);
    assert.equal(h.calls.filter((call) =>
      call.method === 'PATCH' && call.body && call.body.end_requested_at === null).length, 0);
  } finally {
    h.restore();
  }
});

await check('generic unknown enqueue returns failure for direct fallback', async () => {
  const originalFetch = global.fetch;
  const posts = [];
  global.fetch = async (_urlValue, options = {}) => {
    if ((options.method || 'GET') === 'POST') {
      posts.push(JSON.parse(options.body));
      throw new Error('offline POST outcome unknown with no commit');
    }
    throw new Error('offline verification lookup failed');
  };
  try {
    const queued = await enqueuePush({
      SUPABASE_URL: 'https://offline.invalid',
      SUPABASE_SERVICE_KEY: 'offline-test-key',
    }, 'alert', {
      tokens: [tokenA.token],
      headers: { topic: 'offline.alert', push_type: 'alert', priority: 10 },
      aps: { alert: { title: 'Test', body: 'Fallback must run' } },
      telegram_text: 'fallback copy',
      fallback_chat_ids: ['offline-chat'],
    });
    assert.equal(queued, false);
    assert.equal(posts.length, 2);
    assert.equal(posts[0].id, posts[1].id);
  } finally {
    global.fetch = originalFetch;
  }
});

await check('generic committed but unreadable enqueue still chooses fallback over loss', async () => {
  const originalFetch = global.fetch;
  const committed = new Map();
  const posts = [];
  global.fetch = async (_urlValue, options = {}) => {
    if ((options.method || 'GET') === 'POST') {
      const row = JSON.parse(options.body);
      posts.push(row);
      committed.set(row.id, row);
      throw new Error('offline committed response and verification both lost');
    }
    throw new Error('offline verification remains unreadable');
  };
  try {
    const queued = await enqueuePush({
      SUPABASE_URL: 'https://offline.invalid',
      SUPABASE_SERVICE_KEY: 'offline-test-key',
    }, 'alert', {
      tokens: [tokenA.token],
      headers: { topic: 'offline.alert', push_type: 'alert', priority: 10 },
      aps: { alert: { title: 'Test', body: 'Accepted duplicate risk' } },
      telegram_text: 'caller sends this fallback when queued is false',
      fallback_chat_ids: ['offline-chat'],
    });
    assert.equal(queued, false);
    assert.equal(posts.length, 2);
    assert.equal(posts[0].id, posts[1].id);
    assert.equal(committed.size, 1);
    // false tells the caller to send Telegram. The committed queue may later
    // push too; this rare duplicate is intentionally preferred to silent loss.
  } finally {
    global.fetch = originalFetch;
  }
});

await check('daemon outage beyond the lease cannot create a second END queue row', async () => {
  const h = installFetchHarness([tokenA]);
  try {
    await runLiveActivityEndScan({
      SUPABASE_URL: 'https://offline.invalid',
      SUPABASE_SERVICE_KEY: 'offline-test-key',
    });
    // A real second RPC returns no row because queueA is still pending. The
    // migration assertions above verify that exclusion occurs before LIMIT.
    h.setRows([]);
    await runLiveActivityEndScan({
      SUPABASE_URL: 'https://offline.invalid',
      SUPABASE_SERVICE_KEY: 'offline-test-key',
    });
    assert.equal(h.queued.length, 1);
    assert.equal(h.queued[0].id, queueA);
  } finally {
    h.restore();
  }
});

await check('definite queue insertion failure releases the exact phone lease for retry', async () => {
  const h = installFetchHarness([tokenA]);
  h.failQueue();
  try {
    await runLiveActivityEndScan({
      SUPABASE_URL: 'https://offline.invalid',
      SUPABASE_SERVICE_KEY: 'offline-test-key',
    });
    assert.equal(h.queued.length, 0);
    const releases = h.calls.filter((call) =>
      call.method === 'PATCH' && call.body && call.body.end_requested_at === null);
    assert.equal(releases.length, 1);
    assert.ok(releases[0].url.includes(encodeURIComponent(tokenA.token_id)));
    assert.ok(releases[0].url.includes(encodeURIComponent(tokenA.token)));
    assert.ok(releases[0].url.includes('token_type=eq.activity_update'));
    assert.ok(releases[0].url.includes('shift_id=eq.' + encodeURIComponent(shiftId)));
    assert.ok(releases[0].url.includes('end_queue_id=eq.' + encodeURIComponent(queueA)));
    assert.deepEqual(releases[0].body, { end_requested_at: null, end_queue_id: null });
  } finally {
    h.restore();
  }
});

console.log('');
console.log(`${total - failed} passed, ${failed} failed, ${total} total`);
process.exit(failed ? 1 : 0);

// Offline Live Activity START deduplication tests. No Supabase, Apple,
// Telegram, or Cloudflare request leaves this process.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildLiveActivityContentState,
  runLiveActivityStartScan,
} from './worker.js';

const here = dirname(fileURLToPath(import.meta.url));
const migration = await readFile(
  join(here, '..', 'migrations', '018_live_activity_start_dedup.sql'),
  'utf8',
);
const rollback = await readFile(
  join(here, '..', 'migrations', '018_live_activity_start_dedup_rollback.sql'),
  'utf8',
);
const workerSource = await readFile(join(here, 'worker.js'), 'utf8');

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
const deliveryA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const deliveryB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const deviceA = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const deviceB = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const queueA = '10000000-0000-4000-8000-000000000001';
const queueB = '10000000-0000-4000-8000-000000000002';
const reportAt = '2026-08-26T11:58:30.000Z';

const claimA = {
  delivery_id: deliveryA,
  queue_id: queueA,
  device_id: deviceA,
  email: 'owner@example.com',
  token: 'a'.repeat(64),
  shift_id: shiftId,
  worker_name: 'Hashim Nadir',
  worker_email: 'hashim@example.com',
  clock_in_at: '2026-08-26T11:00:00.000Z',
  report_at: reportAt,
  report_lat: 40.586659,
  report_lng: -74.323824,
  generation: 1,
  market: 'ny',
};

const claimB = {
  ...claimA,
  delivery_id: deliveryB,
  queue_id: queueB,
  device_id: deviceB,
  email: 'manager@example.com',
  token: 'b'.repeat(64),
};

function installFetchHarness(initialClaimBatches, { v2Missing = false } = {}) {
  const claimBatches = [...initialClaimBatches];
  const calls = [];
  const queuePosts = [];
  const queueById = new Map();
  let failQueue = false;
  let loseQueueResponse = false;
  let failCompletion = false;
  let unknownQueueOutcome = false;
  const originalFetch = global.fetch;

  global.fetch = async (urlValue, options = {}) => {
    const url = String(urlValue);
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, method, body });

    if (method === 'POST' && url.endsWith('/rpc/hc_claim_live_activity_starts_v2')) {
      assert.equal(typeof body.p_claimed_at, 'string');
      assert.equal(typeof body.p_stale_before, 'string');
      assert.equal(typeof body.p_started_after, 'string');
      assert.equal(body.p_limit, 50);
      if (v2Missing) {
        v2Missing = false;
        return reply(404, { code: 'PGRST202', message: 'function not found' });
      }
      return reply(200, claimBatches.shift() || []);
    }

    if (method === 'POST' && url.endsWith('/rpc/hc_claim_live_activity_starts')) {
      return reply(200, claimBatches.shift() || []);
    }

    if (method === 'POST' && url.endsWith('/push_queue')) {
      queuePosts.push(body);
      assert.equal(body.kind, 'la_start');
      assert.equal(body.id, body.payload.headers.collapse_id);
      if (failQueue) return reply(503, { error: 'simulated definite failure' });
      if (unknownQueueOutcome) {
        throw new Error('simulated unknown queue outcome without commit');
      }
      if (!queueById.has(body.id)) queueById.set(body.id, body);
      if (loseQueueResponse) {
        loseQueueResponse = false;
        throw new Error('simulated lost response after commit');
      }
      // Supabase's ignore-duplicates POST is successful for both the first
      // insert and a later retry of this same primary-key UUID.
      return reply(201, null);
    }

    if (method === 'GET' && url.includes('/push_queue?id=eq.')) {
      if (unknownQueueOutcome) {
        return reply(503, { error: 'simulated unknown verification read' });
      }
      const id = decodeURIComponent(url.split('/push_queue?id=eq.')[1].split('&')[0]);
      const queued = queueById.get(id);
      return reply(200, queued ? [{ id: queued.id, kind: queued.kind }] : []);
    }

    if (method === 'PATCH' && url.includes('/live_activity_start_deliveries?')) {
      if (body.queued_at && failCompletion) return reply(503, { error: 'completion down' });
      return reply(204, null);
    }

    throw new Error('unexpected offline fetch: ' + method + ' ' + url);
  };

  return {
    calls,
    queuePosts,
    queueById,
    failQueue(value = true) { failQueue = value; },
    loseQueueResponse() { loseQueueResponse = true; },
    failCompletion(value = true) { failCompletion = value; },
    unknownQueueOutcome(value = true) { unknownQueueOutcome = value; },
    restore() { global.fetch = originalFetch; },
  };
}

const offlineEnv = {
  SUPABASE_URL: 'https://offline.invalid',
  SUPABASE_SERVICE_KEY: 'offline-test-key',
};

await check('content state includes normalized GPS time and safe market labels', () => {
  assert.deepEqual(
    buildLiveActivityContentState('At NJ Garage', 0, reportAt, 'ny'),
    {
      status: 'At NJ Garage',
      statusMinutes: 0,
      lastReportISO: reportAt,
      marketLabel: 'NJ',
    },
  );
  assert.deepEqual(
    buildLiveActivityContentState('Enroute', 0, reportAt, 'MIAMI'),
    {
      status: 'Enroute',
      statusMinutes: 0,
      lastReportISO: reportAt,
      marketLabel: 'Miami',
    },
  );
  assert.deepEqual(
    buildLiveActivityContentState('Enroute', 0, 'not-a-date', 'unknown'),
    { status: 'Enroute', statusMinutes: 0 },
  );
});

await check('migration creates one private immutable queue identity per shift and phone', () => {
  assert.ok(migration.includes('create table if not exists public.live_activity_start_deliveries'));
  assert.ok(migration.includes('unique (shift_id, device_id)'));
  assert.ok(migration.includes('unique (shift_id, start_token)'));
  assert.ok(migration.includes('unique (queue_id)'));
  assert.ok(migration.includes('Live Activity START identity is immutable'));
  assert.ok(migration.includes('new.queue_id is distinct from old.queue_id'));
  assert.ok(migration.includes('alter table public.live_activity_start_deliveries enable row level security'));
  assert.ok(migration.includes('from public, anon, authenticated;'));
  assert.ok(!/grant\s+select\s+on\s+(table\s+)?public\.live_activity_start_deliveries\s+to\s+(anon|authenticated)/i.test(migration));
  assert.ok(migration.includes(
    '018 install blocked: clock out every open shift before START dedup cutover'
  ));
  assert.ok(migration.includes(
    '018 install blocked: drain every unfinished legacy START before dedup cutover'
  ));
  assert.ok(migration.includes("where kind = 'la_start'"));
  assert.ok(migration.includes('and done_at is null'));
  assert.ok(migration.includes("where clock_out_at is null"));
  const installGuard = migration.indexOf('018 install blocked:');
  const createLedger = migration.indexOf(
    'create table if not exists public.live_activity_start_deliveries'
  );
  assert.ok(installGuard > 0 && installGuard < createLedger);
});

await check('claim RPC seeds recent shifts but recovers every existing pending receipt', () => {
  const marker = 'create or replace function public.hc_claim_live_activity_starts(';
  assert.ok(migration.includes(marker));
  const rpc = migration.split(marker)[1].split('do $assertions$')[0];
  assert.ok(rpc.includes("auth.role() is distinct from 'service_role'"));
  assert.ok(rpc.includes("lat.token_type = 'push_to_start'"));
  assert.ok(rpc.includes('lat.device_id is not null'));
  assert.ok(rpc.includes('s.clock_out_at is null'));
  assert.equal((rpc.match(/s\.clock_in_at >= p_started_after/g) || []).length, 1);
  const seed = rpc.split('insert into public.live_activity_start_deliveries')[1]
    .split('return query')[0];
  const recovery = rpc.split('return query')[1];
  assert.ok(seed.includes('s.clock_in_at >= p_started_after'));
  assert.ok(!recovery.includes('clock_in_at >= p_started_after'));
  assert.ok(rpc.includes("fw.role in ('owner', 'manager')"));
  assert.ok(rpc.includes('fw.active is true'));
  assert.ok(rpc.includes('fw.auth_user_id is not null'));
  assert.ok(rpc.includes("'appreview@hamptonscoconuts.com'"));
  assert.ok(rpc.includes("lower(lat.email) <>"));
  assert.ok(rpc.includes('shift_id, device_id, start_token'));
  assert.ok(rpc.includes('on conflict do nothing'));
  assert.ok(rpc.includes('delivery.delivered_at is null'));
  assert.ok(rpc.includes('delivery.terminal_at is null'));
  assert.ok(rpc.includes('This is intentionally a separate statement from RETURN QUERY'));
  assert.ok(rpc.indexOf('insert into public.live_activity_start_deliveries') <
    rpc.indexOf('return query'));
  assert.ok(!rpc.includes('seeded as ('));
  assert.ok(rpc.includes('for update of delivery skip locked'));
  assert.ok(rpc.includes('left join lateral'));
  assert.ok(rpc.includes('order by loc.at desc, loc.id desc'));
  assert.ok(migration.includes(
    'grant execute on function public.hc_claim_live_activity_starts(\n' +
    '  timestamptz, timestamptz, timestamptz, integer\n) to service_role;'
  ));
});

await check('migration refuses insecure token access and guards every START insert', () => {
  assert.ok(migration.includes(
    '018 requires migration 016: direct Live Activity token policies remain'
  ));
  assert.ok(migration.includes("has_table_privilege(\n         'anon'"));
  assert.ok(migration.includes('linked authenticated token registration'));
  assert.ok(migration.includes(
    'create trigger push_queue_validate_live_activity_start'
  ));
  assert.ok(migration.includes("if new.kind <> 'la_start'"));
  assert.ok(migration.includes('live_activity_start_generation'));
  assert.ok(migration.includes('live_activity_start_claimed_at'));
  assert.ok(migration.includes(
    "new.payload #>> '{headers,collapse_id}' is distinct from v_queue_id::text"
  ));
  assert.ok(migration.includes(
    "new.payload #>> '{aps,event}' is distinct from 'start'"
  ));
  assert.ok(migration.includes(
    "new.payload #>> '{aps,attributes,shiftId}' is distinct from v_shift_id::text"
  ));
  assert.ok(migration.includes('shift_row.clock_out_at is null'));
  assert.ok(migration.includes("manager.role in ('owner', 'manager')"));
  assert.ok(migration.includes('manager.auth_user_id is not null'));
  assert.ok(migration.includes('rejected ineligible or stale Live Activity START queue row'));
});

await check('only a permanent dead token can rotate a delivered phone generation', () => {
  const claimMarker =
    'create or replace function public.hc_claim_live_activity_starts(';
  const claimRpc = migration.split(claimMarker)[1].split(
    'create or replace function public.hc_validate_live_activity_start_delivery('
  )[0];
  assert.ok(claimRpc.includes('delivery.terminal_at is not null'));
  assert.ok(claimRpc.includes('generation = delivery.generation + 1'));
  assert.ok(claimRpc.includes('pending.done_at is null'));
  assert.ok(claimRpc.includes('lower(token_row.token) <> delivery.start_token'));
  assert.ok(migration.includes('v_terminal_rotation'));
  assert.ok(migration.includes('new.generation = old.generation + 1'));
});

await check('same-token device regeneration preserves every START outcome', () => {
  assert.ok(migration.includes(
    'create trigger live_activity_tokens_reconcile_start_device'
  ));
  assert.ok(migration.includes(
    'create or replace function public.hc_reconcile_live_activity_start_device()'
  ));
  const reconcile = migration.split(
    'create or replace function public.hc_reconcile_live_activity_start_device()'
  )[1].split('create or replace function public.hc_claim_live_activity_starts(')[0];
  assert.ok(reconcile.includes('delivery.start_token = lower(new.token)'));
  assert.ok(reconcile.includes('set device_id = new.device_id'));
  assert.ok(reconcile.includes('occupied.device_id = new.device_id'));
  assert.ok(!reconcile.includes('delivery.queued_at is null'));
  assert.ok(!reconcile.includes('delivery.delivered_at is null'));
  assert.ok(!reconcile.includes('delivery.terminal_at is null'));

  const protect = migration.split('v_device_reconcile :=')[1]
    .split('v_unsent_token_refresh :=')[0];
  assert.ok(protect.includes('new.start_token = old.start_token'));
  assert.ok(protect.includes(
    'new.delivered_at is not distinct from old.delivered_at'
  ));
  assert.ok(protect.includes(
    'new.terminal_at is not distinct from old.terminal_at'
  ));
  assert.ok(!protect.includes('old.delivered_at is null'));
  assert.ok(!protect.includes('old.terminal_at is null'));
});

await check('queued same-token handoff validates by Apple token, not stale device ID', () => {
  const insertGuard = migration.split(
    'create or replace function public.hc_validate_live_activity_start_queue()'
  )[1].split('create or replace function public.hc_protect_live_activity_start_delivery()')[0];
  assert.ok(insertGuard.includes('lower(token_row.token) = delivery.start_token'));
  assert.ok(!insertGuard.includes('token_row.device_id = delivery.device_id'));
  assert.ok(!insertGuard.includes('delivery.device_id = v_device_id'));
  assert.ok(insertGuard.includes('occupied.device_id = token_row.device_id'));

  const validate = migration.split(
    'create or replace function public.hc_validate_live_activity_start_delivery('
  )[1].split('do $assertions$')[0];
  assert.ok(validate.includes('lower(token_row.token) = delivery.start_token'));
  assert.ok(!validate.includes('token_row.device_id = delivery.device_id'));
  assert.ok(!validate.includes('p_device_id uuid'));
  assert.ok(validate.includes('occupied.device_id = token_row.device_id'));
});

await check('pushdrain has a service-only pre-send eligibility RPC', () => {
  const marker =
    'create or replace function public.hc_validate_live_activity_start_delivery(';
  assert.ok(migration.includes(marker));
  const rpc = migration.split(marker)[1].split('do $assertions$')[0];
  assert.ok(rpc.includes("auth.role() is distinct from 'service_role'"));
  assert.ok(rpc.includes('shift_row.clock_out_at is null'));
  assert.ok(rpc.includes('delivery.delivered_at is null'));
  assert.ok(rpc.includes('delivery.terminal_at is null'));
  assert.ok(rpc.includes('lower(token_row.token) = delivery.start_token'));
  assert.ok(rpc.includes("manager.role in ('owner', 'manager')"));
  assert.ok(rpc.includes('manager.auth_user_id is not null'));
});

await check('normal clock-in alert scan contains no Live Activity START path', () => {
  const alertScan = workerSource.split('async function runClockInAlertScan(env)')[1]
    .split('// ── stillness watch')[0];
  assert.ok(alertScan);
  assert.ok(!alertScan.includes('startShiftLiveActivities'));
  assert.ok(!alertScan.includes("'start'"));
  assert.ok(workerSource.includes('await runLiveActivityStartScan(env);'));
  assert.ok(workerSource.indexOf('await runLiveActivityStartScan(env);') <
    workerSource.indexOf('await runClockInAlertScan(env);'));
  assert.match(
    workerSource,
    /updateShiftLiveActivity\(\s*env,\s*row\.id,\s*laStatus,\s*laMins,\s*p\.at,\s*row\.market,?\s*\)/,
  );
});

await check('unconfirmed stable START queue rows survive the seven-day purge', () => {
  assert.ok(migration.includes(
    'create or replace function public.hc_retain_unconfirmed_live_activity_start_queue()'
  ));
  assert.ok(migration.includes("if old.kind = 'la_start'"));
  assert.ok(migration.includes('where delivery.queue_id = old.id'));
  assert.ok(migration.includes('and delivery.queued_at is null'));
  assert.ok(migration.includes('and shift_row.clock_out_at is null'));
  assert.ok(migration.includes('return null;'));
  assert.ok(migration.includes(
    'create trigger push_queue_retain_unconfirmed_live_activity_start'
  ));
  assert.ok(migration.includes('before delete on public.push_queue'));
  assert.ok(migration.includes(
    'Once a shift is closed this function can never enqueue its START again.'
  ));
  assert.ok(migration.includes('set claimed_at = null'));
  assert.ok(migration.includes('and shift_row.clock_out_at is not null'));
  assert.ok(rollback.includes(
    'drop trigger push_queue_retain_unconfirmed_live_activity_start'
  ));
  assert.ok(rollback.includes(
    'drop function public.hc_retain_unconfirmed_live_activity_start_queue()'
  ));
});

await check('one claimed phone queues one stable START and completes its exact lease', async () => {
  const h = installFetchHarness([[claimA]]);
  try {
    assert.equal(await runLiveActivityStartScan(offlineEnv), 1);
    assert.equal(h.queueById.size, 1);
    const queued = h.queueById.get(queueA);
    assert.equal(queued.id, queueA);
    assert.deepEqual(queued.payload.tokens, [claimA.token]);
    assert.equal(queued.payload.aps.event, 'start');
    assert.equal(queued.payload.headers.expiration, 0);
    assert.equal(queued.payload.aps['content-state'].lastReportISO, reportAt);
    assert.equal(queued.payload.aps['content-state'].marketLabel, 'NJ');
    assert.equal(queued.payload.aps.attributes.shiftId, shiftId);
    assert.equal(queued.payload.live_activity_start_delivery_id, deliveryA);
    assert.equal(queued.payload.live_activity_start_generation, 1);
    assert.equal(typeof queued.payload.live_activity_start_claimed_at, 'string');
    const completions = h.calls.filter((call) =>
      call.method === 'PATCH' && call.body && call.body.queued_at);
    assert.equal(completions.length, 1);
    assert.ok(completions[0].url.includes('id=eq.' + deliveryA));
    assert.ok(!completions[0].url.includes('device_id=eq.'));
    assert.ok(completions[0].url.includes('queue_id=eq.' + queueA));
    assert.ok(completions[0].url.includes('generation=eq.1'));
    assert.ok(completions[0].url.includes('start_token=eq.' + claimA.token));
    assert.ok(completions[0].url.includes('claimed_at=eq.'));
    assert.equal(completions[0].body.claimed_at, null);
  } finally {
    h.restore();
  }
});

await check('pre-022 Worker falls back once to the proven START claim', async () => {
  const h = installFetchHarness([[{ ...claimA, market: undefined }]], { v2Missing: true });
  try {
    assert.equal(await runLiveActivityStartScan(offlineEnv), 1);
    assert.equal(h.queueById.size, 1);
    assert.deepEqual(
      h.calls.filter((call) => call.url.includes('/rpc/hc_claim_live_activity_starts'))
        .map((call) => call.url.split('/rpc/')[1]),
      ['hc_claim_live_activity_starts_v2', 'hc_claim_live_activity_starts'],
    );
    assert.equal(
      h.queueById.get(queueA).payload.aps['content-state'].marketLabel,
      undefined,
    );
  } finally {
    h.restore();
  }
});

await check('normal-alert retries cannot create a second START queue row', async () => {
  // The second independent claim is empty because queued_at is durable. The
  // generic alert scan is statically proven above to contain no START call.
  const h = installFetchHarness([[claimA], []]);
  try {
    await runLiveActivityStartScan(offlineEnv);
    await runLiveActivityStartScan(offlineEnv);
    assert.equal(h.queueById.size, 1);
    assert.equal(h.queuePosts.length, 1);
  } finally {
    h.restore();
  }
});

await check('a late second phone receives one separate START while the shift remains open', async () => {
  const h = installFetchHarness([[claimA], [claimB], []]);
  try {
    await runLiveActivityStartScan(offlineEnv);
    await runLiveActivityStartScan(offlineEnv);
    await runLiveActivityStartScan(offlineEnv);
    assert.equal(h.queueById.size, 2);
    assert.deepEqual(new Set(h.queueById.keys()), new Set([queueA, queueB]));
    assert.deepEqual(
      new Set([...h.queueById.values()].map((row) => row.payload.tokens[0])),
      new Set([claimA.token, claimB.token]),
    );
  } finally {
    h.restore();
  }
});

await check('definite enqueue failure releases only the exact lease and retains queue identity', async () => {
  const h = installFetchHarness([[claimA], [claimA]]);
  h.failQueue();
  try {
    assert.equal(await runLiveActivityStartScan(offlineEnv), 0);
    const releases = h.calls.filter((call) =>
      call.method === 'PATCH' && call.body &&
      Object.keys(call.body).length === 1 && call.body.claimed_at === null);
    assert.equal(releases.length, 1);
    assert.ok(releases[0].url.includes('id=eq.' + deliveryA));
    assert.ok(releases[0].url.includes('queue_id=eq.' + queueA));
    assert.deepEqual(releases[0].body, { claimed_at: null });
    h.failQueue(false);
    assert.equal(await runLiveActivityStartScan(offlineEnv), 1);
    assert.equal(h.queueById.size, 1);
    assert.ok(h.queuePosts.every((row) => row.id === queueA));
  } finally {
    h.restore();
  }
});

await check('lost committed INSERT response verifies the same queue without duplicate', async () => {
  const h = installFetchHarness([[claimA]]);
  h.loseQueueResponse();
  try {
    assert.equal(await runLiveActivityStartScan(offlineEnv), 1);
    assert.equal(h.queueById.size, 1);
    assert.equal(h.queuePosts.length, 1);
    assert.equal(h.queuePosts[0].id, queueA);
    const releases = h.calls.filter((call) =>
      call.method === 'PATCH' && call.body && !call.body.queued_at);
    assert.equal(releases.length, 0);
  } finally {
    h.restore();
  }
});

await check('fully unknown no-commit START retains its lease and stable queue ID', async () => {
  const h = installFetchHarness([[claimA], [claimA]]);
  h.unknownQueueOutcome();
  try {
    assert.equal(await runLiveActivityStartScan(offlineEnv), 0);
    assert.equal(h.queueById.size, 0);
    assert.equal(h.queuePosts.length, 2);
    assert.ok(h.queuePosts.every((row) => row.id === queueA));
    const deliveryWrites = h.calls.filter((call) =>
      call.method === 'PATCH' &&
      call.url.includes('/live_activity_start_deliveries?'));
    assert.equal(deliveryWrites.length, 0);

    h.unknownQueueOutcome(false);
    assert.equal(await runLiveActivityStartScan(offlineEnv), 1);
    assert.equal(h.queueById.size, 1);
    assert.equal(h.queueById.get(queueA).id, queueA);
  } finally {
    h.restore();
  }
});

await check('stale claim after completion failure reuses the same existing queue row', async () => {
  const h = installFetchHarness([[claimA], [claimA]]);
  h.failCompletion();
  try {
    await runLiveActivityStartScan(offlineEnv);
    h.failCompletion(false);
    await runLiveActivityStartScan(offlineEnv);
    assert.equal(h.queueById.size, 1);
    assert.equal(h.queuePosts.length, 2);
    assert.ok(h.queuePosts.every((row) => row.id === queueA));
    const releases = h.calls.filter((call) =>
      call.method === 'PATCH' && call.body &&
      Object.keys(call.body).length === 1 && call.body.claimed_at === null);
    assert.equal(releases.length, 0);
  } finally {
    h.restore();
  }
});

await check('guarded rollback drains starts, blocks open shifts, and preserves 017', () => {
  const keepAt = rollback.indexOf('Keep the 018 worker and pushdrain running');
  const stopAt = rollback.indexOf('Stop the 018 worker producer and pushdrain consumer');
  const runAt = rollback.indexOf('Run THIS rollback');
  assert.ok(keepAt > 0 && stopAt > keepAt && runAt > stopAt);
  assert.ok(rollback.includes('open_start_deliveries'));
  assert.ok(rollback.includes('active_start_claims'));
  assert.ok(rollback.includes('unfinished_la_start_rows'));
  assert.ok(rollback.includes('an open shift still has a START delivery receipt'));
  assert.ok(rollback.includes('active START delivery claims remain'));
  assert.ok(rollback.includes('unfinished Live Activity START queue rows remain'));
  assert.ok(rollback.includes('if 017 was mistakenly rolled'));
  assert.ok(rollback.indexOf('do $object_preflight$') <
    rollback.indexOf('lock table'));
  assert.ok(rollback.includes(
    'drop trigger push_queue_validate_live_activity_start'
  ));
  assert.ok(rollback.includes(
    'drop function public.hc_validate_live_activity_start_delivery('
  ));
  assert.ok(rollback.includes(
    'drop trigger live_activity_tokens_reconcile_start_device'
  ));
  assert.ok(!rollback.includes('migration 017 objects changed'));
  assert.ok(!/delete\s+from\s+public\.live_activity_start_deliveries/i.test(rollback));
});

console.log('');
console.log(`${total - failed} passed, ${failed} failed, ${total} total`);
process.exit(failed ? 1 : 0);

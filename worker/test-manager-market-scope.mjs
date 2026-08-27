// Offline exact-market privacy checks. No Supabase, Apple, Telegram, or
// Cloudflare request leaves this process.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const migrationDir = join(here, '..', 'migrations');
const [migration, rollback, worker, rehearsal] = await Promise.all([
  readFile(join(migrationDir, '025_manager_market_scope.sql'), 'utf8'),
  readFile(join(migrationDir, '025_manager_market_scope_rollback.sql'), 'utf8'),
  readFile(join(here, 'worker.js'), 'utf8'),
  readFile(join(here, '..', 'rehearsal', '005_manager_market_scope_runtime_checks.sql'), 'utf8'),
]);

let failed = 0;
let total = 0;

function check(name, fn) {
  total++;
  try {
    fn();
    console.log('PASS  ' + name);
  } catch (error) {
    failed++;
    console.log('FAIL  ' + name);
    console.log('      ' + String(error.message || error));
  }
}

function functionBody(name, nextMarker = null) {
  const marker = 'create or replace function public.' + name;
  const start = migration.indexOf(marker);
  assert.ok(start >= 0, 'missing function: ' + name);
  const tail = migration.slice(start);
  if (!nextMarker) return tail.split('\n$function$;')[0];
  const end = tail.indexOf(nextMarker);
  assert.ok(end > 0, 'missing next marker after ' + name);
  return tail.slice(0, end);
}

check('central rule keeps owners global and managers exact nonblank market', () => {
  const body = functionBody(
    'hc_management_can_access_shift_market(',
    'revoke all on function public.hc_management_can_access_shift_market',
  );
  assert.ok(body.includes("when 'owner' then true"));
  assert.ok(body.includes("when 'manager' then"));
  assert.ok(body.includes("nullif(lower(trim(coalesce(p_roster_market, ''))), '') is not null"));
  assert.ok(body.includes("nullif(lower(trim(coalesce(p_shift_market, ''))), '') is not null"));
  assert.ok(body.includes('lower(trim(p_roster_market)) = lower(trim(p_shift_market))'));
  assert.ok(body.includes('else false'));
});

check('shift access is owner global, manager exact market, team self only', () => {
  const body = functionBody('hc_can_access_shift(', 'revoke all on function public.hc_can_access_shift');
  assert.ok(body.includes("lower(trim(worker.role)) = 'team'"));
  assert.ok(body.includes('shift_row.field_worker_id = worker.id'));
  assert.ok(body.includes('hc_management_can_access_shift_market'));
  assert.ok(!body.includes("worker.role in ('owner', 'manager')"));
});

check('base shift and audit policies close cross-market bypasses', () => {
  const basePolicy = migration.split('create policy shifts_authenticated_select')[1]
    .split('-- Audit rows')[0];
  assert.ok(basePolicy.includes("lower(trim(worker.role)) = 'manager'"));
  assert.ok(basePolicy.includes('shifts.field_worker_id = worker.id'));
  assert.ok(basePolicy.includes('hc_management_can_access_shift_market'));
  const editPolicy = migration.split('create policy shift_edits_authenticated_select')[1]
    .split('create or replace function public.hc_list_managed_shifts')[0];
  assert.ok(editPolicy.includes('hc_can_manage_shifts()'));
  assert.ok(editPolicy.includes('hc_can_access_shift(shift_edits.shift_id)'));
});

check('managed shift list is exact-market and suppresses manager paid status', () => {
  const body = functionBody(
    'hc_list_managed_shifts(',
    'create or replace function public.hc_manage_clock_out(',
  );
  assert.ok(body.includes("v_role = 'manager' and nullif(v_market, '') is null"));
  assert.ok(body.includes('hc_management_can_access_shift_market'));
  assert.ok(body.includes("when v_role = 'owner' then shift_row.paid_at is not null"));
  assert.ok(body.includes('else null::boolean'));
  assert.ok(!body.includes('shift_row.paid_cents'));
  assert.ok(!body.includes('shift_row.paid_minutes'));
});

check('managed clock-out and time edit filter before locking or changing rows', () => {
  const clockOut = functionBody(
    'hc_manage_clock_out(',
    'create or replace function public.hc_edit_shift_times(',
  );
  const edit = functionBody(
    'hc_edit_shift_times(',
    'create or replace function public.hc_list_managed_open_shift_ids()',
  );
  for (const body of [clockOut, edit]) {
    assert.ok(body.includes('for share;'));
    const authorization = body.indexOf('hc_management_can_access_shift_market');
    const firstWrite = body.indexOf('update public.shifts');
    assert.ok(authorization >= 0 && firstWrite > authorization);
    assert.ok(body.includes("v_role = 'manager' and nullif(v_market, '') is null"));
    assert.ok(body.includes('v_after.paid_at := null'));
    assert.ok(body.includes('v_after.paid_cents := null'));
    assert.ok(body.includes('v_after.paid_minutes := null'));
  }
});

check('open-shift truth is market-scoped and excludes App Review', () => {
  const body = functionBody(
    'hc_list_managed_open_shift_ids()',
    'create or replace function public.hc_claim_live_activity_starts(',
  );
  assert.ok(body.includes('hc_management_can_access_shift_market'));
  assert.ok(body.includes("'appreview@hamptonscoconuts.com'"));
});

check('START seed, claim, queue insert, and pre-send validation all recheck market', () => {
  const claim = functionBody(
    'hc_claim_live_activity_starts(',
    'create or replace function public.hc_validate_live_activity_start_queue()',
  );
  assert.ok((claim.match(/hc_management_can_access_shift_market/g) || []).length >= 2);
  assert.ok(claim.includes("manager.active is true"));
  assert.ok(claim.includes('manager.auth_user_id is not null'));
  assert.ok(claim.includes("'appreview@hamptonscoconuts.com'"));

  const queue = functionBody(
    'hc_validate_live_activity_start_queue()',
    'create or replace function public.hc_validate_live_activity_start_delivery(',
  );
  assert.ok(queue.includes('hc_management_can_access_shift_market'));
  assert.ok(queue.includes('rejected ineligible or stale Live Activity START queue row'));

  const delivery = functionBody(
    'hc_validate_live_activity_start_delivery(',
    '-- Reassert all affected grants.',
  );
  assert.ok(delivery.includes('notification_device_authorizations'));
  assert.ok(delivery.includes('hc_management_can_access_shift_market'));
  assert.ok(delivery.includes('shift_row.clock_out_at is null'));
});

check('migration leaves durable END implementation untouched', () => {
  assert.ok(migration.includes("'public.hc_claim_live_activity_ends(timestamp with time zone,timestamp with time zone,integer)'"));
  assert.ok(!migration.includes('create or replace function public.hc_claim_live_activity_ends('));
  assert.ok(!migration.includes('drop function public.hc_claim_live_activity_ends'));
  assert.ok(worker.includes("'/rest/v1/rpc/hc_claim_live_activity_ends'"));
});

check('normal manager alerts pass shift market and recipient lookup reads roster market', () => {
  assert.ok(worker.includes('select=email,role,market'));
  assert.ok(worker.includes('partitionRecipients(staff, opts.excludeEmail, opts.market)'));
  assert.ok((worker.match(/market: row\.market/g) || []).length >= 3);
  assert.ok(worker.includes('String(r.market || \'\').trim().toLowerCase() === market'));
});

check('Live Activity UPDATE is exact-market while END stays token-durable', () => {
  assert.ok(worker.includes('async function laManageEmails(env, market)'));
  assert.ok(worker.includes('partitionRecipients(staff, null, market)'));
  assert.ok(worker.includes('async function laTokensForShift(env, shiftId, market)'));
  assert.ok(worker.includes('laTokensForShift(env, shiftId, market)'));
  const endScan = worker.split('export async function runLiveActivityEndScan(env)')[1];
  assert.ok(endScan);
  assert.ok(!endScan.includes('laManageEmails'));
  assert.ok(!endScan.includes('partitionRecipients'));
});

check('sandbox rehearsal exercises Worker v2 and pay-free positive clock-out', () => {
  assert.ok(rehearsal.includes('from public.hc_claim_live_activity_starts_v2('));
  assert.ok(!rehearsal.includes('from public.hc_claim_live_activity_starts('));
  assert.ok(rehearsal.includes('set paid_at = clock_timestamp()'));
  assert.ok(rehearsal.includes('from public.hc_manage_clock_out('));
  assert.ok(rehearsal.includes("v_rows->0->>'paid_at' is not null"));
  assert.ok(rehearsal.includes("v_rows->0->>'paid_cents' is not null"));
  assert.ok(rehearsal.includes("v_rows->0->>'paid_minutes' is not null"));
  assert.ok(rehearsal.includes('rollback;'));
});

check('automatic rollback cannot reopen the privacy leak', () => {
  assert.ok(rollback.includes('automatic rollback blocked'));
  assert.ok(rollback.includes("errcode = '55000'"));
  assert.ok(!rollback.includes('create or replace function public.hc_can_access_shift'));
});

console.log('');
console.log(`${total - failed} passed, ${failed} failed, ${total} total`);
process.exit(failed ? 1 : 0);

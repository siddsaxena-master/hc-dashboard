import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migration = await readFile(new URL('../migrations/028_owner_mfa_enforcement.sql', import.meta.url), 'utf8');
const rollback = await readFile(new URL('../migrations/028_owner_mfa_enforcement_rollback.sql', import.meta.url), 'utf8');
const rehearsal = await readFile(new URL('./009_owner_mfa_runtime_checks.sql', import.meta.url), 'utf8');
const worker = await readFile(new URL('../worker/worker.js', import.meta.url), 'utf8');

let checks = 0;
function check(value, message) {
  assert.ok(value, message);
  checks += 1;
  console.log('PASS ', message);
}

check(/^begin;/m.test(migration) && /^commit;/m.test(migration), 'migration 028 is one transaction');
check(/\$preflight\$/.test(migration) && /\$postflight\$/.test(migration), 'migration has structural preflight and postflight assertions');
check(/auth\.jwt\(\) ->> 'aal'/.test(migration) && /'aal2'/.test(migration), 'owner assurance uses the signed top-level JWT AAL');

const bootstrapStart = migration.indexOf('create or replace function public.hc_get_auth_bootstrap()');
const bootstrapEnd = migration.indexOf('-- Full profile claims', bootstrapStart);
const bootstrap = migration.slice(bootstrapStart, bootstrapEnd);
check(/returns table \(\s*auth_user_id uuid,\s*role text,\s*mfa_required boolean\s*\)/.test(bootstrap), 'AAL1 bootstrap returns only Auth UUID, role, and MFA routing');
check(!/worker\.name|worker\.market|hourly_rate|paid_|public\.orders|public\.shifts/i.test(bootstrap), 'AAL1 bootstrap contains no operational or financial projection');
check(!/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/.test(bootstrap), 'owner authorization does not hardcode an email');

const claimStart = migration.indexOf('create or replace function public.hc_claim_field_worker()');
const claimEnd = migration.indexOf('create or replace function public.hc_claim_field_worker_v2()', claimStart);
const claim = migration.slice(claimStart, claimEnd);
check(/hc_get_auth_bootstrap\(\)/.test(claim) && /hc_session_allows_roster_role\(v_bootstrap\.role\)/.test(claim), 'full profile claim follows bootstrap and role-specific AAL enforcement');

for (const helper of [
  'hc_current_worker_id',
  'hc_current_worker_email',
  'hc_current_worker_role',
  'hc_is_active_worker',
  'hc_is_owner',
  'hc_current_roster_session_allowed',
  'hc_can_access_order_market'
]) {
  const start = migration.indexOf(`create or replace function public.${helper}`);
  const next = migration.indexOf('create or replace function public.', start + 40);
  const body = migration.slice(start, next < 0 ? migration.length : next);
  check(start >= 0 && /hc_(?:session_allows_roster_role|owner_session_is_aal2)/.test(body), `${helper} enforces the signed owner AAL`);
}

check(/create policy field_workers_authenticated_select[\s\S]{0,500}hc_session_allows_roster_role/.test(migration), 'field worker direct-read policy enforces owner AAL2');
check(/create policy shifts_authenticated_select[\s\S]{0,900}hc_session_allows_roster_role/.test(migration), 'shift direct-read policy enforces owner AAL2');

const wrappers = [
  'hc_start_shift',
  'hc_list_managed_shifts',
  'hc_manage_clock_out',
  'hc_edit_shift_times',
  'hc_list_managed_open_shift_ids',
  'hc_list_orders_for_current_user',
  'hc_confirm_order_delivery_v2',
  'hc_authorize_notification_device',
  'hc_sync_notification_device',
  'hc_register_live_activity_token'
];
for (const name of wrappers) {
  check(
    new RegExp(`rename to ${name}_pre_mfa_028`).test(migration) &&
      new RegExp(`create function public\\.${name}\\(`).test(migration) &&
      new RegExp(`${name}_pre_mfa_028`).test(migration) &&
      new RegExp(`revoke all on function public\\.${name}_pre_mfa_028`).test(migration),
    `${name} is gated through a private pre-MFA implementation`
  );
}

check(/revoke all on function public\.hc_get_auth_bootstrap\(\)[\s\S]{0,100}from public, anon/.test(migration), 'PUBLIC and anon cannot execute the bootstrap');
check(/grant execute on function public\.hc_get_auth_bootstrap\(\)\s+to authenticated;/.test(migration), 'only authenticated clients receive bootstrap execution');
check(/rpc\/hc_claim_field_worker/.test(worker), 'Worker dashboard AI authorization uses the MFA-gated full claim');

check(/raise exception[\s\S]*rollback blocked/i.test(rollback) && !/^\s*(?:drop|delete|truncate)\b/im.test(rollback), 'rollback is explicitly blocked and non-destructive');
check(/^begin;/m.test(rehearsal) && /^rollback;/m.test(rehearsal), 'runtime rehearsal rolls every fixture and roster change back');
check(/'aal', 'aal1'/.test(rehearsal) && /'aal', 'aal2'/.test(rehearsal), 'rehearsal simulates owner AAL1 denial and AAL2 success');
check(/'user_metadata'[\s\S]{0,180}'aal', 'aal2'/.test(rehearsal), 'rehearsal proves spoofed client metadata cannot upgrade assurance');
check(/set role = 'manager'/.test(rehearsal) && /set role = 'team'/.test(rehearsal), 'rehearsal preserves manager and team AAL1 scope');
check(/has_function_privilege\(\s*'anon'/.test(rehearsal) && /pre_mfa_028/.test(rehearsal), 'rehearsal checks anon denial and hidden implementation grants');
for (const name of wrappers) {
  check(
    new RegExp(`(?:select|from) (?:\\* from )?public\\.${name}\\(`).test(rehearsal),
    `runtime rehearsal calls ${name}`
  );
}
check(/v_wrapper_count <> 10/.test(rehearsal), 'AAL1 runtime matrix requires all ten migration-028 wrappers');
check(/hc_mark_shifts_paid\(/.test(rehearsal) && /shift_payment_records/.test(rehearsal), 'rehearsal covers payroll denial, success, and immutable payment audit');
check(/hc_clock_out_my_shift\(/.test(rehearsal) && /hc_record_shift_orders\(/.test(rehearsal), 'rehearsal covers self clock-out and order attribution paths');
check(/delivery_request_id = v_delivery_request/.test(rehearsal), 'rehearsal proves delivery-v2 success through its receipt row');
check(/hc_authorize_notification_device\(v_device_id\)/.test(rehearsal) && /hc_sync_notification_device\(/.test(rehearsal) && /hc_register_live_activity_token\(/.test(rehearsal), 'rehearsal covers notification authorization, sync, and registration');
check(/set local role authenticated;/.test(rehearsal) && /reset role;/.test(rehearsal), 'direct table checks run as the PostgREST authenticated role');
for (const table of [
  'field_workers',
  'shifts',
  'shift_locations',
  'shift_edits',
  'shift_orders',
  'orders',
  'app_config',
  'shift_payment_records'
]) {
  check(rehearsal.includes(`'${table}'`), `owner AAL1 RLS rehearsal includes ${table}`);
}
check(/has_function_privilege\('authenticated', v_signature, 'EXECUTE'\)/.test(rehearsal), 'rehearsal checks authenticated execute on every public wrapper');
check(/has_function_privilege\('service_role', v_internal, 'EXECUTE'\)/.test(rehearsal), 'rehearsal hides every renamed implementation from service clients too');
check(/32::integer as scenarios_checked/.test(rehearsal), 'rehearsal reports the expanded 32-scenario matrix');

console.log(`\n${checks}/${checks} owner MFA security checks passed`);

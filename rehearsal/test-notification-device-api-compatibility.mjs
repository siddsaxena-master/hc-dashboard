// Offline contract checks for migration 015c.
// No database, network, Apple, or production request leaves this process.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const migrationDir = join(here, '..', 'migrations');
const [migration, rollback, transition, laterTransition, app] = await Promise.all([
  readFile(join(migrationDir, '015c_notification_device_api_compatibility.sql'), 'utf8'),
  readFile(join(migrationDir, '015c_notification_device_api_compatibility_rollback.sql'), 'utf8'),
  readFile(join(migrationDir, '015_field_auth_transition.sql'), 'utf8'),
  readFile(join(migrationDir, '021_notification_device_authorization_transition.sql'), 'utf8'),
  readFile(join(here, '..', '..', 'hc-field-app', 'App.js'), 'utf8'),
]);

let total = 0;
let failed = 0;

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

function includesAll(source, snippets) {
  for (const snippet of snippets) {
    assert.ok(source.includes(snippet), `missing: ${snippet}`);
  }
}

function functionBody(source, signatureStart) {
  const start = source.indexOf(signatureStart);
  assert.ok(start >= 0, `missing function: ${signatureStart}`);
  const end = source.indexOf('$function$;', start);
  assert.ok(end > start, `unterminated function: ${signatureStart}`);
  return source.slice(start, end + '$function$;'.length);
}

function dollarTagCounts(source) {
  const counts = new Map();
  for (const match of source.matchAll(/\$[a-z_][a-z0-9_]*\$/gi)) {
    counts.set(match[0], (counts.get(match[0]) || 0) + 1);
  }
  return counts;
}

check('SQL dollar blocks and transaction boundaries are balanced', () => {
  for (const [name, source] of [['migration', migration], ['rollback', rollback]]) {
    for (const [tag, count] of dollarTagCounts(source)) {
      assert.equal(count % 2, 0, `${name} has unbalanced ${tag}`);
    }
    assert.equal((source.match(/^begin;$/gm) || []).length, 1, `${name} begin`);
    assert.equal((source.match(/^commit;$/gm) || []).length, 1, `${name} commit`);
    assert.ok(source.trimEnd().endsWith('commit;'), `${name} must end at commit`);
  }
});

check('bridge is transactional, bounded, and reloads the API schema', () => {
  includesAll(migration, [
    'begin;',
    "set local lock_timeout = '10s';",
    "set local statement_timeout = '120s';",
    "notify pgrst, 'reload schema';",
    'commit;',
  ]);
});

check('preflight pins migration 015 and blocks every later implementation', () => {
  includesAll(migration, [
    "'public.hc_can_manage_shifts()'",
    "'public.hc_sync_notification_device(uuid,text,boolean,boolean)'",
    "'public.hc_register_live_activity_token(text,uuid,text,uuid,boolean)'",
    "'public.hc_unregister_device(uuid)'",
    "'public.live_activity_tokens_p2s_uniq'",
    "'public.live_activity_tokens_upd_uniq'",
    "'public.live_activity_tokens_device_p2s_uidx'",
    "'public.live_activity_tokens_device_update_uidx'",
    "'public.hc_claim_live_activity_ends(timestamp with time zone,timestamp with time zone,integer)'",
    "'public.hc_claim_live_activity_starts(timestamp with time zone,timestamp with time zone,timestamp with time zone,integer)'",
    "'public.hc_validate_live_activity_start_delivery(uuid,uuid,uuid,integer,text)'",
    "'public.hc_enforce_notification_destination_authorization()'",
    "'public.hc_management_can_access_shift_market(text,text,text)'",
    'a later notification or manager migration is already present',
  ]);
});

check('mixed capability states fail closed but the guarded list-only state can reapply', () => {
  includesAll(migration, [
    'notification capability tables are in a mixed state',
    'orphaned capability functions or triggers exist',
    'installed capability objects are incomplete',
    'A guarded rollback deliberately leaves only the harmless open-shift RPC.',
    'existing open-shift RPC is incompatible',
  ]);
});

check('private capability storage matches the later reviewed transition', () => {
  includesAll(migration, [
    'create table if not exists public.notification_device_authorizations (',
    'revoke_secret_hash bytea not null',
    'references auth.users(id) on delete cascade',
    'references public.field_workers(id) on delete cascade',
    'check (octet_length(revoke_secret_hash) = 32)',
    'create table if not exists public.notification_device_security_state (',
    'ever_issued_at          timestamptz',
    'alter table public.notification_device_authorizations enable row level security;',
    'alter table public.notification_device_security_state enable row level security;',
  ]);
  assert.equal(migration.includes('revoke_secret text,'), true,
    'the RPC output may contain revoke_secret');
  const tableBlock = migration
    .split('create table if not exists public.notification_device_authorizations (')[1]
    .split(');')[0];
  assert.equal(/\brevoke_secret\s+text\b/.test(tableBlock), false,
    'plaintext secret must not be stored');
});

check('authorization output exactly matches the installed app contract', () => {
  const authorize = functionBody(
    migration,
    'create or replace function public.hc_authorize_notification_device('
  );
  includesAll(authorize, [
    'p_device_id uuid',
    'device_id uuid',
    'revoke_secret text',
    'secret_version integer',
    'authorized_at timestamptz',
    'fw.auth_user_id = auth.uid()',
    'fw.active is true',
    "fw.role in ('owner', 'manager')",
    'for update of fw;',
    'pg_advisory_xact_lock',
    'notification_device_authorizations_pkey',
    'update public.notification_device_security_state as security_state',
    'set ever_issued_at = coalesce(',
    'notification device security state is missing',
  ]);
  assert.match(
    authorize,
    /from public\.field_workers as fw[\s\S]*?limit 1\s+for update of fw;/,
    'the selected eligibility row must be locked'
  );
  const workerLock = authorize.indexOf('for update of fw;');
  const deviceLock = authorize.indexOf('pg_advisory_xact_lock');
  const upsert = authorize.indexOf(
    'on conflict on constraint notification_device_authorizations_pkey'
  );
  const issueMarker = authorize.indexOf(
    'update public.notification_device_security_state as security_state'
  );
  const returnedSecret = authorize.indexOf('return query');
  assert.ok(workerLock >= 0 && workerLock < deviceLock, 'worker lock must come first');
  assert.ok(upsert >= 0 && upsert < issueMarker, 'marker must follow capability upsert');
  assert.ok(issueMarker < returnedSecret, 'marker must commit before secret return');
  includesAll(app, [
    "sb('rpc/hc_authorize_notification_device'",
    'row?.revoke_secret',
    'String(row.device_id || \'\').toLowerCase() !== deviceId',
  ]);
});

check('anonymous revoke is exact-device, exact-secret, and preserves END addresses', () => {
  const revoke = functionBody(
    migration,
    'create or replace function public.hc_revoke_notification_device('
  );
  includesAll(revoke, [
    'length(p_revoke_secret) <> 64',
    "p_revoke_secret !~ '^[0-9a-f]{64}$'",
    'device_auth.device_id = p_device_id',
    'device_auth.revoke_secret_hash = v_hash',
    "token_type = 'push_to_start'",
    'shift_id is null',
    'if v_matched is true then',
    'return coalesce(v_matched, false);',
  ]);
  assert.equal(revoke.includes('return v_matched;'), false,
    'a wrong well-formed secret must return false, never null');
  assert.equal(revoke.includes("token_type = 'activity_update'"), false);
  assert.match(migration, /grant execute on function public\.hc_revoke_notification_device\(uuid, text\)\s+to anon, authenticated;/);
  includesAll(app, [
    '/rpc/hc_revoke_notification_device',
    'p_revoke_secret: secret',
    'confirmed !== true',
  ]);
});

check('foreground truth RPC is UUID-only, management-only, and excludes App Review', () => {
  const listOpen = functionBody(
    migration,
    'create or replace function public.hc_list_managed_open_shift_ids()'
  );
  includesAll(listOpen, [
    'returns table (shift_id uuid)',
    'if not public.hc_can_manage_shifts()',
    's.clock_out_at is null',
    'appreview@hamptonscoconuts.com',
  ]);
  assert.equal(listOpen.includes('paid_'), false);
  assert.equal(listOpen.includes('worker_name'), false);
  assert.match(migration, /grant execute on function public\.hc_list_managed_open_shift_ids\(\)\s+to authenticated, service_role;/);
});

check('migration execution preserves all migration-015 functions, indexes, and token counts', () => {
  includesAll(migration, [
    'create temporary table hc_015c_baseline',
    'push_token_count',
    'live_token_count',
    'can_manage_definition',
    'sync_definition',
    'register_definition',
    'unregister_definition',
    'legacy_p2s_index',
    'legacy_update_index',
    'device_p2s_index',
    'device_update_index',
    'migration-015 state or token rows changed',
  ]);
  assert.equal(
    migration.includes('create or replace function public.hc_sync_notification_device('),
    false
  );
  assert.equal(
    migration.includes('create or replace function public.hc_register_live_activity_token('),
    false
  );
  assert.equal(
    migration.includes('create or replace function public.hc_unregister_device('),
    false
  );
});

check('bridge blocks current migration 021 until a forward-only safety replacement', () => {
  for (const marker of [
    'notification_device_authorizations_hash_check',
    'notification_device_authorizations_version_check',
    'notification_device_authorizations_revoke_check',
    'notification_device_security_state_singleton_check',
    'notification_device_authorizations_purge',
    'field_workers_revoke_notification_devices',
    'on conflict on constraint notification_device_authorizations_pkey',
  ]) {
    assert.ok(migration.includes(marker), marker);
    assert.ok(laterTransition.includes(marker), marker + ' missing from 021');
  }
  includesAll(migration, [
    'the current migration 021 must not be run after this bridge',
    'Prepare a new forward-only safety migration or a',
  ]);
  const laterAuthorize = functionBody(
    laterTransition,
    'create or replace function public.hc_authorize_notification_device('
  );
  assert.equal(laterAuthorize.includes('for update of fw;'), false,
    'the warning is required while current 021 lacks the worker lock');
  assert.equal(laterAuthorize.includes('ever_issued_at'), false,
    'the warning is required while current 021 lacks the issue marker');
});

check('rerun and postflight pin exact keys, indexes, and check expressions', () => {
  includesAll(migration, [
    'create temporary table hc_015c_expected_authorization_checks',
    'create temporary table hc_015c_expected_security_state_check',
    'index_info.indnkeyatts = expected.key_count',
    'index_info.indnatts = expected.key_count',
    'index_info.indexprs is null',
    'index_info.indpred is null',
    'constraint_info.conkey = array[',
    'constraint_info.confkey = array[',
    'actual_constraint.conbin',
    'expected_constraint.conbin',
    'installed capability index definition is incompatible',
    'installed capability key definition is incompatible',
    'installed capability constraint definition is incompatible',
    'capability index definition is incompatible',
    'capability check expression is incompatible',
    'field_workers_auth_user_uidx',
    'auth_user_idisnotnull',
  ]);
  assert.ok(
    (migration.match(/hc_015c_expected_authorization_checks/g) || []).length >= 5,
    'canonical checks must be used in preflight and postflight'
  );
  assert.ok(
    (migration.match(/index_info\.indnkeyatts = expected\.key_count/g) || []).length >= 2,
    'exact capability indexes must be checked before and after installation'
  );
  assert.ok(
    (migration.match(/migration-015 worker Auth uniqueness is incompatible/g) || []).length >= 2,
    'worker Auth uniqueness must be checked before and after installation'
  );
});

check('migration and rollback use worker-first lock order', () => {
  const migrationWorkerLock = migration.indexOf(
    'lock table public.field_workers in share row exclusive mode;'
  );
  const migrationCapabilityLock = migration.indexOf('do $optional_capability_locks$');
  assert.ok(
    migrationWorkerLock >= 0 && migrationWorkerLock < migrationCapabilityLock,
    'migration must lock field_workers before capability tables'
  );
  const rollbackWorkerLock = rollback.indexOf(
    'lock table public.field_workers in share row exclusive mode;'
  );
  const rollbackCapabilityLock = rollback.indexOf(
    'public.notification_device_authorizations,',
    rollbackWorkerLock
  );
  assert.ok(
    rollbackWorkerLock >= 0 && rollbackWorkerLock < rollbackCapabilityLock,
    'rollback must lock field_workers before capability tables'
  );
});

check('postflight pins RLS, grants, function hardening, triggers, and return types', () => {
  includesAll(migration, [
    'capability-table RLS is disabled',
    'plaintext capability column exists',
    'a private capability table has a policy',
    'client retains private-table %s',
    'service role lacks private-table %s',
    'client RPC grants are wrong',
    'private helper %s is callable',
    'function %s is not hardened',
    'app-facing return contracts are wrong',
    'durable revocation trigger is missing',
    'transition security state is invalid',
  ]);
});

check('rollback blocks after capability use or later migrations', () => {
  includesAll(rollback, [
    'at least one phone received a capability',
    'a phone capability was previously issued',
    'security history is missing or ambiguous',
    'ever_issued_at is not null',
    'notification authorization cutover was enforced',
    'a later migration is present',
    'a later migration appeared before drops',
    'a later migration object appeared',
    "'public.hc_validate_live_activity_start_delivery(uuid,uuid,uuid,integer,text)'",
    'lock table',
    'public.notification_device_authorizations',
    'in share row exclusive mode',
  ]);
  assert.ok(
    (rollback.match(/hc_validate_live_activity_start_delivery/g) || []).length >= 3,
    'later START validation must be checked before locks, before drops, and after drops'
  );
  assert.ok(
    (migration.match(/hc_validate_live_activity_start_delivery/g) || []).length >= 2,
    'later START validation must be checked in migration preflight and postflight'
  );
  assert.ok(
    rollback.indexOf('ever_issued_at is not null') >
      rollback.indexOf('lock table public.field_workers in share row exclusive mode;'),
    'permanent history must be checked under lock'
  );
});

check('rollback retains safe local cleanup and shared pgcrypto', () => {
  assert.equal(
    rollback.includes('drop function if exists public.hc_list_managed_open_shift_ids()'),
    false
  );
  assert.equal(rollback.includes('drop extension'), false);
  includesAll(rollback, [
    'safe open-shift RPC was not retained',
    'shared pgcrypto was removed',
    "notify pgrst, 'reload schema';",
  ]);
});

check('rollback changes no migration-015 token row or function', () => {
  includesAll(rollback, [
    'create temporary table hc_015c_rollback_baseline',
    'migration-015 state changed',
  ]);
  assert.equal(/delete\s+from\s+public\.push_tokens/i.test(rollback), false);
  assert.equal(/delete\s+from\s+public\.live_activity_tokens/i.test(rollback), false);
  assert.equal(/update\s+public\.(push_tokens|live_activity_tokens)/i.test(rollback), false);
});

check('migration 015 source remains untouched by the bridge contract', () => {
  includesAll(transition, [
    'create or replace function public.hc_sync_notification_device(',
    'create or replace function public.hc_register_live_activity_token(',
    'create or replace function public.hc_unregister_device(p_device_id uuid)',
  ]);
});

if (failed) {
  console.log(`\n${failed} failed, ${total - failed} passed, ${total} total`);
  process.exit(1);
}

console.log(`\n${total} passed, 0 failed, ${total} total`);

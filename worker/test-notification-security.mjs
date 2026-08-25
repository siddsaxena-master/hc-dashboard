// Offline contract checks for device-scoped notification reconciliation.
//
// These tests do not connect to Supabase or run SQL. They pin the security
// clauses that must be present before the draft migrations receive a separate
// production review and manual database test.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const migrationDir = join(here, '..', 'migrations');
const [transition, cutover, worker] = await Promise.all([
  readFile(join(migrationDir, '015_field_auth_transition.sql'), 'utf8'),
  readFile(join(migrationDir, '016_field_auth_cutover.sql'), 'utf8'),
  readFile(join(here, 'worker.js'), 'utf8'),
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

function includesAll(source, snippets) {
  for (const snippet of snippets) assert.ok(source.includes(snippet), `missing: ${snippet}`);
}

check('stable device UUID columns and partial unique indexes exist', () => {
  includesAll(transition, [
    'alter table public.push_tokens\n  add column if not exists device_id uuid;',
    'alter table public.live_activity_tokens\n  add column if not exists device_id uuid;',
    'create unique index if not exists push_tokens_device_uidx',
    'create unique index if not exists live_activity_tokens_device_p2s_uidx',
    'create unique index if not exists live_activity_tokens_device_update_uidx',
  ]);
});

check('device sync exposes the exact PostgREST argument names used by the app', () => {
  assert.ok(transition.includes(
    'create or replace function public.hc_sync_notification_device(\n' +
    '  p_device_id uuid,\n' +
    '  p_apns_token text,\n' +
    '  p_push_allowed boolean,\n' +
    '  p_live_supported boolean\n' +
    ')'
  ));
  assert.ok(!transition.includes('p_live_activity_supported'));
});

check('old zero-device notification overloads are removed and blocked', () => {
  includesAll(transition, [
    'drop function if exists public.hc_register_push_token(text, text);',
    'drop function if exists public.hc_register_live_activity_token(text, uuid, text);',
    'drop function if exists public.hc_unregister_device();',
  ]);
  includesAll(cutover, [
    "'public.hc_register_push_token(text,text)'",
    "'public.hc_register_live_activity_token(text,uuid,text)'",
    "'public.hc_unregister_device()'",
    'cutover blocked: obsolete RPC %s still exists',
  ]);
});

check('inactive and downgraded identities delete every current-email destination', () => {
  const eligibility = "if v_active is not true or v_role not in ('owner', 'manager') then";
  assert.equal(transition.split(eligibility).length - 1, 2);
  assert.match(transition, /delete from public\.push_tokens\s+where lower\(email\) = v_email;\s+\n\s*delete from public\.live_activity_tokens\s+where lower\(email\) = v_email;/);
});

check('a stable device and exact token reclaim rows from a prior email', () => {
  assert.match(transition, /delete from public\.push_tokens\s+where device_id = p_device_id\s+and lower\(email\) <> v_email;/);
  assert.match(transition, /delete from public\.live_activity_tokens\s+where device_id = p_device_id\s+and lower\(email\) <> v_email;/);
  assert.match(transition, /where lower\(apns_token\) = v_token\s+and lower\(email\) <> v_email;/);
  assert.match(transition, /where lower\(token\) = v_token\s+and lower\(email\) <> v_email;/);
});

check('denied push permission removes only this or its legacy phone row', () => {
  assert.match(transition, /if p_push_allowed is true and v_token is not null then[\s\S]*?elsif p_push_allowed is not true then[\s\S]*?delete from public\.push_tokens[\s\S]*?device_id = p_device_id or device_id is null/);
});

check('a transient missing APNs token does not block role or Live Activity cleanup', () => {
  assert.ok(!transition.includes('APNs token is required when push is allowed'));
  const eligibilityAt = transition.indexOf("if v_active is not true or v_role not in ('owner', 'manager') then", transition.indexOf('create or replace function public.hc_sync_notification_device'));
  const pushMutationAt = transition.indexOf('if p_push_allowed is true and v_token is not null then');
  const liveCleanupAt = transition.indexOf('if p_live_supported is not true then');
  assert.ok(eligibilityAt >= 0 && pushMutationAt > eligibilityAt && liveCleanupAt > pushMutationAt);
});

check('unsupported Live Activity never reinserts and cleans this phone', () => {
  assert.match(transition, /if p_live_supported is not true then[\s\S]*?delete from public\.live_activity_tokens[\s\S]*?device_id = p_device_id or device_id is null/);
  assert.match(transition, /if p_supported is not true then[\s\S]*?delete from public\.live_activity_tokens[\s\S]*?device_id = p_device_id or device_id is null[\s\S]*?return;/);
});

check('sign-out is device scoped and also removes legacy null-device rows', () => {
  assert.ok(transition.includes('create or replace function public.hc_unregister_device(p_device_id uuid)'));
  const unregister = transition.split('create or replace function public.hc_unregister_device(p_device_id uuid)')[1]
    .split('-- --------------------------------------------------------------------------')[0];
  assert.equal(unregister.split('(device_id = p_device_id or device_id is null)').length - 1, 2);
  assert.ok(!unregister.includes('where lower(email) = v_email;'));
});

check('cutover prunes only after locking and keeps malformed and duplicate blockers', () => {
  const lockAt = cutover.indexOf('lock table');
  const pruneAt = cutover.indexOf('delete from public.push_tokens as pt');
  const malformedAt = cutover.indexOf("message = 'cutover blocked: push token has an unsafe owner, role, platform, or format'");
  const duplicateAt = cutover.indexOf("message = 'cutover blocked: one device ID belongs to multiple notification identities'");
  assert.ok(lockAt >= 0 && pruneAt > lockAt && malformedAt > pruneAt && duplicateAt > malformedAt);
});

check('worker recipient reads require active owner or manager rows', () => {
  const activeFilter = 'field_workers?role=in.(owner,manager)&active=eq.true&select=';
  assert.equal(worker.split(activeFilter).length - 1, 2);
  assert.ok(!worker.includes('field_workers?role=in.(owner,manager)&select='));
});

console.log('');
console.log(`${total - failed} passed, ${failed} failed, ${total} total`);
process.exit(failed ? 1 : 0);

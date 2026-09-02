// Static safety checks for migration 031 and its rollback-only rehearsal.
//
// Run with: node test-order-payment-runtime-hotfix.mjs
// No database or network connection is used.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const paths = {
  original: './migrations/030_order_payment_integrity.sql',
  forward: './migrations/031_order_payment_greatest_runtime_fix.sql',
  rollback: './migrations/031_order_payment_greatest_runtime_fix_rollback.sql',
  builder: './rehearsal/build-031-runtime-rehearsal.mjs',
  rehearsal: './rehearsal/031_order_payment_greatest_runtime_rehearsal.sql',
};

const [original, forward, rollback, builder, rehearsal] = await Promise.all(
  Object.values(paths).map((path) => readFile(new URL(path, import.meta.url), 'utf8')),
);

const expectedHashes = {
  original: '451bf850d2ed5a0321e6ea9acec4b7c064e358f62fab8f6d263d0a496cf4c27a',
  forward: '4d38414a46cc81a208da1f55c9d74530c3bf6053c9869bcfb9d86fe5fb735454',
  rollback: '31bb64d5c8e74e1a12ef8c6461aeaecfd991f0dd2efe00e2aae33762274c14fe',
  rehearsal: 'd5ffd8a7767028a5541bea542c1e7058233edd2ae87fca129ce0da41c08503fa',
};

const checks = [];

function check(name, test) {
  test();
  checks.push(name);
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function md5(text) {
  return createHash('md5').update(text).digest('hex');
}

function countStandalone(sql, statement) {
  return sql
    .split(/\r?\n/)
    .filter((line) => line.trim().toLowerCase() === statement.toLowerCase())
    .length;
}

function routineBody(source, creationPrefix) {
  const start = source.indexOf(creationPrefix);
  assert.notEqual(start, -1, `missing ${creationPrefix}`);
  const bodyStartMarker = 'as $function$';
  const bodyStart = source.indexOf(bodyStartMarker, start);
  assert.notEqual(bodyStart, -1, 'missing payment body start');
  const bodyEnd = source.indexOf('$function$;', bodyStart + bodyStartMarker.length);
  assert.notEqual(bodyEnd, -1, 'missing payment body end');
  return source.slice(bodyStart + bodyStartMarker.length, bodyEnd);
}

const originalBody = routineBody(
  original,
  'create function public.hc_apply_verified_order_payment(',
);
const fixedBody = routineBody(
  forward,
  'create or replace function public.hc_apply_verified_order_payment(',
);

check('applied migration 030 remains byte-for-byte immutable', () => {
  assert.equal(sha256(original), expectedHashes.original);
});

check('reviewed migration 031 hash is sealed', () => {
  assert.equal(sha256(forward), expectedHashes.forward);
});

check('blocked rollback hash is sealed', () => {
  assert.equal(sha256(rollback), expectedHashes.rollback);
});

check('broken routine fingerprint is exact', () => {
  assert.equal(md5(originalBody), 'b80a1c1861eac52a8602a47aebd1818f');
});

check('fixed routine fingerprint is exact', () => {
  assert.equal(md5(fixedBody), 'a37c02f62545f0188c951a8ae611e731');
});

check('routine body changes only the invalid GREATEST qualifier', () => {
  assert.equal(
    fixedBody.replace('greatest(', 'pg_catalog.greatest('),
    originalBody,
  );
  assert.equal((originalBody.match(/pg_catalog\.greatest\(/g) || []).length, 1);
  assert.equal((fixedBody.match(/(?<!\.)\bgreatest\(/g) || []).length, 1);
  assert.doesNotMatch(fixedBody, /pg_catalog\.greatest\(/);
});

check('forward migration uses one explicit transaction', () => {
  assert.equal(countStandalone(forward, 'begin;'), 1);
  assert.equal(countStandalone(forward, 'commit;'), 1);
  assert.equal(countStandalone(forward, 'rollback;'), 0);
});

check('forward migration accepts only known old or fixed fingerprints', () => {
  assert.match(forward, /b80a1c1861eac52a8602a47aebd1818f/);
  assert.match(forward, /a37c02f62545f0188c951a8ae611e731/);
  assert.match(forward, /pg_catalog\.replace\(function_info\.prosrc, pg_catalog\.chr\(13\), ''\)/);
});

check('forward migration preserves exact signature and result', () => {
  assert.match(forward, /function_info\.pronargs = 10/);
  assert.match(forward, /function_info\.pronargdefaults = 1/);
  assert.match(forward, /'p_expected_balance_cents'/);
  assert.match(
    forward,
    /TABLE\(order_id uuid, stage text, deposit_cents bigint, balance_cents bigint, event_inserted boolean\)/,
  );
});

check('forward migration preserves definer security and empty search path', () => {
  assert.match(forward, /language plpgsql\s*security definer\s*set search_path = ''/);
  assert.match(forward, /function_info\.prosecdef is true/g);
  assert.match(forward, /pg_catalog\.cardinality\(function_info\.proconfig\) = 1/g);
});

check('only trusted backend roles can execute the repaired RPC', () => {
  assert.match(
    forward,
    /revoke all on function public\.hc_apply_verified_order_payment\([\s\S]*?\) from public, anon, authenticated, service_role, supabase_admin;/,
  );
  assert.match(
    forward,
    /grant execute on function public\.hc_apply_verified_order_payment\([\s\S]*?\) to service_role, supabase_admin;/,
  );
  assert.match(forward, /privilege_info\.grantee not in/);
});

check('supporting ledgers, helper, void RPC, and guard triggers are required', () => {
  assert.match(forward, /public\.verified_order_payment_events/);
  assert.match(forward, /public\.verified_order_void_events/);
  assert.match(forward, /public\.hc_apply_verified_order_void/);
  assert.match(forward, /public\.hc_can_apply_direct_order_stage_transition/);
  assert.match(forward, /orders_payment_integrity_insert/);
  assert.match(forward, /orders_payment_integrity_update/);
});

check('migration briefly locks writers during the function swap', () => {
  assert.match(forward, /lock table public\.orders in share row exclusive mode;/);
  assert.match(
    forward,
    /lock table public\.verified_order_payment_events in share row exclusive mode;/,
  );
  assert.match(forward, /set local lock_timeout = '5s';/);
});

check('forward migration makes no immediate data correction', () => {
  const outsideBody = forward.replace(fixedBody, '');
  assert.doesNotMatch(outsideBody, /\b(?:insert\s+into|update\s+public\.orders|delete\s+from|truncate)\b/i);
  assert.doesNotMatch(forward, /\b(?:drop|alter)\s+(?:table|function)\b/i);
});

check('rollback refuses to restore the known production failure', () => {
  assert.match(rollback, /-- BLOCKED ROLLBACK/);
  assert.match(rollback, /errcode = '55000'/);
  assert.match(rollback, /invalid schema-qualified GREATEST/);
  assert.doesNotMatch(rollback, /create(?: or replace)? function/i);
});

check('rehearsal builder is sealed to the reviewed forward migration', () => {
  assert.match(builder, new RegExp(expectedHashes.forward));
  assert.match(builder, /Forward migration hash changed/);
});

check('rehearsal executes the payment RPC three times', () => {
  assert.equal(
    (rehearsal.match(/from public\.hc_apply_verified_order_payment\(/g) || []).length,
    3,
  );
  assert.match(rehearsal, /event_inserted is distinct from true/);
  assert.equal(
    (rehearsal.match(/event_inserted is distinct from false/g) || []).length,
    2,
  );
});

check('rehearsal proves the greatest receipt remains one cent', () => {
  assert.match(rehearsal, /v_ledger\.max_qbo_received_cents is distinct from 1/);
  assert.match(rehearsal, /retry ledger did not preserve the greatest receipt/);
});

check('rehearsal proves direct writes remain blocked', () => {
  assert.match(rehearsal, /direct payment-field update bypassed the guard/);
  assert.match(rehearsal, /when sqlstate '42501'/);
});

check('rehearsal has exactly one outer rollback transaction', () => {
  assert.equal(sha256(rehearsal), expectedHashes.rehearsal);
  assert.equal(countStandalone(rehearsal, 'begin;'), 1);
  assert.equal(countStandalone(rehearsal, 'commit;'), 0);
  assert.equal(countStandalone(rehearsal, 'rollback;'), 1);
  assert.match(rehearsal, /The final ROLLBACK restores the original routine and all tested rows/);
});

for (const name of checks) console.log(`PASS  ${name}`);
console.log(`PASS  ${checks.length}/${checks.length} migration 031 runtime hotfix checks`);

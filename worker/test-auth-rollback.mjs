// Offline contract checks for the emergency migration 016 rollback.
//
// This file reads SQL as text. It does not parse or execute SQL, connect to
// Supabase, read environment files, or make network requests.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const migrationDir = join(here, '..', 'migrations');
const [transition, cutover, rollback] = await Promise.all([
  readFile(join(migrationDir, '015_field_auth_transition.sql'), 'utf8'),
  readFile(join(migrationDir, '016_field_auth_cutover.sql'), 'utf8'),
  readFile(join(migrationDir, '016_field_auth_cutover_rollback.sql'), 'utf8'),
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
  for (const snippet of snippets) {
    assert.ok(source.includes(snippet), `missing: ${snippet}`);
  }
}

function countMatches(source, pattern) {
  return [...source.matchAll(pattern)].length;
}

function extractThrough(source, start, end) {
  const startAt = source.indexOf(start);
  assert.ok(startAt >= 0, `missing start marker: ${start}`);
  const endAt = source.indexOf(end, startAt);
  assert.ok(endAt >= 0, `missing end marker after: ${start}`);
  return source.slice(startAt, endAt + end.length);
}

function normalizeSql(source) {
  return source.replace(/\s+/g, ' ').trim().toLowerCase();
}

// The dangerous-statement checks operate on executable text, not comments.
// Dollar-quoted function bodies remain included, which is intentional.
const executable = rollback.replace(/^\s*--.*$/gm, '');
const grantStatements = [...executable.matchAll(/^\s*grant\s+[\s\S]*?;\s*$/gmi)]
  .map((match) => match[0]);

const expectedPolicies = [
  ['anon read field_workers', 'field_workers', 'select', 'using (true)'],
  ['anon insert shifts', 'shifts', 'insert', 'with check (true)'],
  ['anon read shifts', 'shifts', 'select', 'using (true)'],
  ['anon update shifts', 'shifts', 'update', 'using (true)'],
  ['anon insert shift_locations', 'shift_locations', 'insert', 'with check (true)'],
  ['anon read shift_locations', 'shift_locations', 'select', 'using (true)'],
  ['shift_edits_anon_insert', 'shift_edits', 'insert', 'with check (true)'],
  ['shift_edits_anon_select', 'shift_edits', 'select', 'using (true)'],
  ['push_tokens_anon_insert', 'push_tokens', 'insert', 'with check (true)'],
  ['push_tokens_anon_update', 'push_tokens', 'update', 'using (true) with check (true)'],
  ['live_activity_tokens_anon_insert', 'live_activity_tokens', 'insert', 'with check (true)'],
  ['live_activity_tokens_anon_update', 'live_activity_tokens', 'update', 'using (true) with check (true)'],
  ['app_config_anon_select', 'app_config', 'select', 'using (true)'],
];

const expectedTablePrivileges = [
  ['field_workers', 'select'],
  ['shifts', 'select'],
  ['shifts', 'insert'],
  ['shifts', 'update'],
  ['shift_locations', 'select'],
  ['shift_locations', 'insert'],
  ['shift_edits', 'select'],
  ['shift_edits', 'insert'],
  ['push_tokens', 'insert'],
  ['push_tokens', 'update'],
  ['live_activity_tokens', 'insert'],
  ['live_activity_tokens', 'update'],
  ['app_config', 'select'],
];

check('the file is explicitly emergency-only and explains irreversible token loss', () => {
  includesAll(rollback, [
    'LOCAL ROLLBACK FILE ONLY. DO NOT RUN THIS FILE AS A NORMAL MIGRATION.',
    'EMERGENCY USE ONLY',
    'Migration 016 removes legacy and ineligible notification token rows',
    'This rollback cannot reconstruct those secrets.',
    'must register again',
    'could send private notifications to the wrong phone',
    'needs Sidd\'s explicit',
    '"yes do it" confirmation',
  ]);
});

check('one top-level transaction contains the complete rollback', () => {
  assert.equal(countMatches(rollback, /^begin;\s*$/gmi), 1);
  assert.equal(countMatches(rollback, /^commit;\s*$/gmi), 1);
  assert.equal(countMatches(rollback, /^rollback;\s*$/gmi), 0);
  assert.ok(rollback.indexOf('begin;') < rollback.indexOf('do $preflight$'));
  assert.ok(rollback.indexOf('do $assertions$') < rollback.lastIndexOf('commit;'));
});

check('timeouts and lock set exactly match migration 016', () => {
  includesAll(rollback, [
    "set local lock_timeout = '15s';",
    "set local statement_timeout = '2min';",
  ]);

  const lockStart = 'lock table\n';
  const lockEnd = 'in share row exclusive mode;';
  assert.equal(
    normalizeSql(extractThrough(rollback, lockStart, lockEnd)),
    normalizeSql(extractThrough(cutover, lockStart, lockEnd)),
  );
});

check('rollback contains no row mutation or destructive schema statement', () => {
  const banned = [
    /^\s*delete\s+from\b/im,
    /^\s*truncate(?:\s+table)?\b/im,
    /^\s*drop\s+(?:table|schema|database|index|sequence|function|trigger|policy)\b/im,
    /^\s*alter\s+table\b/im,
    /^\s*insert\s+into\b/im,
    /^\s*update\s+public\./im,
    /^\s*merge\s+into\b/im,
    /^\s*copy\s+public\./im,
  ];
  for (const pattern of banned) {
    assert.doesNotMatch(executable, pattern, `dangerous SQL matched ${pattern}`);
  }
});

check('safe 015 and 016 schema objects are retained', () => {
  assert.doesNotMatch(executable, /\bdrop\b/i);
  assert.doesNotMatch(executable, /\balter\s+(?:table|function)\b/i);
  includesAll(rollback, [
    "'field_workers_auth_user_uidx'",
    "'shifts_one_open_worker_uidx'",
    "'push_tokens_device_uidx'",
    "'live_activity_tokens_device_p2s_uidx'",
    "'live_activity_tokens_device_update_uidx'",
    "'public.hc_sync_notification_device(uuid,text,boolean,boolean)'",
    "'public.hc_register_live_activity_token(text,uuid,text,uuid,boolean)'",
    "'public.hc_unregister_device(uuid)'",
  ]);
});

check('structural preflight fails closed before taking locks', () => {
  const preflightAt = rollback.indexOf('do $preflight$');
  const lockAt = rollback.indexOf('lock table');
  const functionAt = rollback.indexOf('create or replace function public.hc_assign_shift_worker()');
  assert.ok(preflightAt >= 0 && lockAt > preflightAt && functionAt > lockAt);
  includesAll(rollback, [
    'rollback blocked: a required migration 015 identity column is missing or incompatible',
    'rollback blocked: a validated migration 015 identity foreign key is missing',
    'rollback blocked: required index public.%I is missing',
    'rollback blocked: required RPC %s is missing',
    'rollback blocked: obsolete RPC %s still exists',
    'rollback blocked: row level security is disabled on a field table',
    'rollback blocked: an anonymous or PUBLIC field policy already exists',
    'rollback blocked: authenticated field policies differ from migration 016',
    'rollback blocked: anon already has %s on public.%I',
    'rollback blocked: PUBLIC already has a field table or column grant',
  ]);
});

check('all seven authenticated policies are required and never recreated or removed', () => {
  const expectedAuthenticated = [
    'field_workers_authenticated_select',
    'shifts_authenticated_select',
    'shift_locations_authenticated_select',
    'shift_locations_authenticated_insert',
    'shift_edits_authenticated_select',
    'shift_orders_authenticated_select',
    'app_config_authenticated_owner_select',
  ];
  for (const policy of expectedAuthenticated) {
    assert.ok(rollback.includes(`'${policy}'`), `missing authenticated policy check: ${policy}`);
  }
  assert.equal(countMatches(executable, /create\s+policy\s+[^\n]+authenticated/gi), 0);
  assert.equal(countMatches(executable, /drop\s+policy/gi), 0);
  assert.ok(rollback.includes('if v_expected_policy_count <> 7'));
  assert.equal(countMatches(executable, /^alter\s+policy\s+/gmi), 7);
  includesAll(rollback, [
    'alter policy field_workers_authenticated_select',
    'alter policy shifts_authenticated_select',
    'alter policy shift_locations_authenticated_select',
    'alter policy shift_locations_authenticated_insert',
    'alter policy shift_edits_authenticated_select',
    'alter policy shift_orders_authenticated_select',
    'alter policy app_config_authenticated_owner_select',
    "and p.permissive = 'PERMISSIVE'",
    'and p.with_check is null',
    'into v_policy_check',
    'rollback assertion failed: authenticated policy predicate is wrong for %s',
    'rollback assertion failed: bounded authenticated GPS policy predicate is wrong',
  ]);
});

check('canonical authenticated policy predicates are reasserted under the cutover lock', () => {
  const lockAt = rollback.indexOf('lock table');
  const lockEnd = rollback.indexOf('in share row exclusive mode;', lockAt);
  const firstPolicyAt = rollback.indexOf('alter policy field_workers_authenticated_select');
  const anonPoliciesAt = rollback.indexOf('create policy "anon read field_workers"');
  assert.ok(lockAt >= 0 && lockEnd > lockAt && firstPolicyAt > lockEnd && anonPoliciesAt > firstPolicyAt);
  includesAll(rollback, [
    'alter policy field_workers_authenticated_select\n' +
      'on public.field_workers\n' +
      'to authenticated\n' +
      'using (\n' +
      '  (auth_user_id = auth.uid() and active is true)\n' +
      '  or public.hc_is_owner()\n' +
      ');',
    'alter policy shift_locations_authenticated_insert\n' +
      'on public.shift_locations\n' +
      'to authenticated\n' +
      'with check (',
    'and lat between -90 and 90',
    'and lng between -180 and 180',
    'and (accuracy_m is null or accuracy_m >= 0)',
    "shift_locations.at >= s.clock_in_at - interval '5 minutes'",
    "shift_locations.at <= coalesce(s.clock_out_at, now()) + interval '5 minutes'",
  ]);
});

check('assignment function body is byte-for-byte the migration 015 version', () => {
  const start = 'create or replace function public.hc_assign_shift_worker()';
  const end = '$function$;';
  assert.equal(
    extractThrough(rollback, start, end),
    extractThrough(transition, start, end),
  );
  includesAll(rollback, [
    'revoke all on function public.hc_assign_shift_worker()\n  from public, anon, authenticated;',
    'create trigger shifts_assign_field_worker\n' +
      'before insert or update on public.shifts\n' +
      'for each row execute function public.hc_assign_shift_worker();',
  ]);
  assert.equal(countMatches(executable, /create\s+trigger\s+shifts_assign_field_worker/gi), 1);
  assert.equal(countMatches(executable, /\bcreate\s+trigger\b/gi), 1);
  assert.equal(countMatches(executable, /\bcreate\s+or\s+replace\s+function\b/gi), 1);
});

check('exactly the canonical 13 anonymous policies are restored', () => {
  assert.equal(countMatches(executable, /\bcreate\s+policy\b/gi), 13);
  for (const [name, table, command, predicate] of expectedPolicies) {
    const quotedName = name.includes(' ') ? `"${name}"` : name;
    const pattern = new RegExp(
      `create\\s+policy\\s+${quotedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` +
      `\\s+on\\s+public\\.${table}\\s+for\\s+${command}\\s+to\\s+anon\\s+` +
      `${predicate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*;`,
      'i',
    );
    assert.match(executable, pattern, `missing canonical policy ${name}`);
  }
  assert.ok(rollback.includes('if v_expected_policy_count <> 13'));
});

check('anonymous shift_orders access and token reads remain absent', () => {
  assert.doesNotMatch(executable, /create\s+policy\s+\S+\s+on\s+public\.shift_orders[\s\S]*?to\s+anon/i);
  assert.ok(!grantStatements.some((statement) => /\bshift_orders\b/i.test(statement)));
  assert.ok(!grantStatements.some((statement) => (
    /\bgrant\s+select\b/i.test(statement) && /\bpush_tokens\b/i.test(statement)
  )));
  assert.ok(!grantStatements.some((statement) => (
    /\bgrant\s+select\b/i.test(statement) && /\blive_activity_tokens\b/i.test(statement)
  )));
});

check('anonymous table grants match the exact narrow ACL matrix', () => {
  includesAll(rollback, [
    'grant select on table\n' +
      '  public.field_workers,\n' +
      '  public.shifts,\n' +
      '  public.shift_locations,\n' +
      '  public.shift_edits,\n' +
      '  public.app_config\n' +
      'to anon;',
    'grant insert on table\n' +
      '  public.shifts,\n' +
      '  public.shift_locations,\n' +
      '  public.shift_edits,\n' +
      '  public.push_tokens,\n' +
      '  public.live_activity_tokens\n' +
      'to anon;',
    'grant update on table\n' +
      '  public.shifts,\n' +
      '  public.push_tokens,\n' +
      '  public.live_activity_tokens\n' +
      'to anon;',
    'grant usage, select on sequence public.shift_locations_id_seq to anon;',
  ]);
  assert.equal(countMatches(executable, /\bgrant\b[\s\S]*?\bto\s+anon\s*;/gi), 4);
  assert.equal(grantStatements.length, 4);

  for (const [table, privilege] of expectedTablePrivileges) {
    const tuple = `('${table}', '${privilege.toUpperCase()}')`;
    assert.ok(rollback.includes(tuple), `missing final ACL assertion tuple ${tuple}`);
  }
});

check('no PUBLIC grant or broad anonymous grant is introduced', () => {
  assert.doesNotMatch(executable, /\bgrant\b[\s\S]*?\bto\s+public\b/i);
  assert.doesNotMatch(executable, /\bgrant\s+all\b[\s\S]*?\bto\s+anon\b/i);
  assert.doesNotMatch(executable, /\bgrant\s+(?:delete|truncate|references|trigger)\b[\s\S]*?\bto\s+anon\b/i);
  assert.equal(countMatches(rollback, /grantee = 'PUBLIC'/g), 4);
});

check('legacy trigger execution stays private and authenticated RPCs stay protected', () => {
  includesAll(rollback, [
    "pg_catalog.has_function_privilege(\n       'anon',\n       'public.hc_assign_shift_worker()',\n       'EXECUTE'",
    "pg_catalog.has_function_privilege(\n       'authenticated',\n       'public.hc_assign_shift_worker()',\n       'EXECUTE'",
    "pg_catalog.has_function_privilege('anon', v_signature, 'EXECUTE')",
    "not pg_catalog.has_function_privilege('authenticated', v_signature, 'EXECUTE')",
    "not pg_catalog.has_function_privilege('service_role', v_signature, 'EXECUTE')",
  ]);
});

check('all RPC security and return privacy contracts are checked before and after', () => {
  assert.equal(countMatches(rollback, /SECURITY DEFINER or empty search_path lock/gi), 2);
  assert.equal(countMatches(rollback, /where setting\.value ~ '\^search_path=\(\|""\)\$'/g), 2);
  assert.equal(countMatches(rollback, /p\.prorettype = pg_catalog\.to_regtype\('integer'\)::oid/g), 2);
  assert.equal(countMatches(rollback, /v_arg_names && array\[/g), 2);
  for (const privateField of ['paid_at', 'paid_cents', 'paid_minutes', 'hourly_rate_cents']) {
    assert.equal(
      countMatches(rollback, new RegExp(`'${privateField}'`, 'g')),
      2,
      `return privacy field must be checked twice: ${privateField}`,
    );
  }
  includesAll(rollback, [
    'rollback blocked: hc_mark_shifts_paid must return integer',
    'rollback blocked: hc_list_managed_shifts return privacy contract is wrong',
    'rollback assertion failed: hc_mark_shifts_paid return type changed',
    'rollback assertion failed: managed-shift return privacy contract changed',
  ]);
});

check('critical index fingerprints are checked before and after', () => {
  assert.equal(countMatches(rollback, /for v_index in/g), 2);
  for (const snippet of [
    "idx.relkind = 'i'",
    'idx.relowner = tbl.relowner',
    'i.indisunique is true',
    'i.indisvalid is true',
    'i.indisready is true',
    'i.indislive is true',
    'i.indnkeyatts = v_index.key_count',
    'i.indnatts = v_index.key_count',
    'pg_catalog.pg_get_indexdef(i.indexrelid, 1, true) = v_index.key_one',
  ]) {
    assert.equal(countMatches(rollback, new RegExp(snippet.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')), 2);
  }
  assert.equal(countMatches(rollback, /pg_catalog\.pg_get_expr\(i\.indpred, i\.indrelid\)/g), 2);
  includesAll(rollback, [
    'rollback blocked: required index public.%I is missing or incompatible',
    'rollback assertion failed: required index public.%I changed',
  ]);
});

check('critical index predicates use exact normalized canonical comparisons', () => {
  const canonicalPredicates = [
    ['auth_user_id IS NOT NULL', 'auth_user_idisnotnull'],
    ['clock_out_at IS NULL AND worker_email IS NOT NULL', 'clock_out_atisnullandworker_emailisnotnull'],
    ['clock_out_at IS NULL AND field_worker_id IS NOT NULL', 'clock_out_atisnullandfield_worker_idisnotnull'],
    ['device_id IS NOT NULL', 'device_idisnotnull'],
    ['shift_id IS NULL AND device_id IS NOT NULL', 'shift_idisnullanddevice_idisnotnull'],
    ['shift_id IS NOT NULL AND device_id IS NOT NULL', 'shift_idisnotnullanddevice_idisnotnull'],
  ];

  const normalizePredicate = (predicate) => predicate.toLowerCase().replace(/[\s()]/g, '');
  for (const [sqlPredicate, predicateToken] of canonicalPredicates) {
    assert.equal(normalizePredicate(sqlPredicate), predicateToken);
    assert.notEqual(normalizePredicate(`(${sqlPredicate}) AND false`), predicateToken);
    assert.equal(countMatches(rollback, new RegExp(`'${predicateToken}'`, 'g')), 2);
    assert.equal(countMatches(cutover, new RegExp(`'${predicateToken}'`, 'g')), 1);
  }

  for (const source of [rollback, cutover]) {
    assert.doesNotMatch(
      source,
      /pg_catalog\.pg_get_expr\(i\.indpred, i\.indrelid\)\s+ilike/i,
    );
    includesAll(source, [
      'when v_index.predicate_tokens is null then i.indpred is null',
      'pg_catalog.regexp_replace(',
      "'[[:space:]()]',",
      ') = v_index.predicate_tokens',
    ]);
  }

  assert.equal(countMatches(rollback, /\) = v_index\.predicate_tokens/g), 2);
  assert.equal(countMatches(cutover, /\) = v_index\.predicate_tokens/g), 1);
});

check('migration 016 preflight pins full index structure as well as predicates', () => {
  assert.equal(countMatches(cutover, /for v_index in/g), 1);
  for (const snippet of [
    "idx.relkind = 'i'",
    'idx.relowner = tbl.relowner',
    'i.indisunique is true',
    'i.indisvalid is true',
    'i.indisready is true',
    'i.indislive is true',
    'i.indnkeyatts = v_index.key_count',
    'i.indnatts = v_index.key_count',
    'pg_catalog.pg_get_indexdef(i.indexrelid, 1, true) = v_index.key_one',
  ]) {
    assert.equal(countMatches(cutover, new RegExp(snippet.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')), 1);
  }
  assert.ok(cutover.includes('cutover blocked: required index public.%I is missing or incompatible'));
});

check('authenticated and service-role ACL matrices are complete and mirrored', () => {
  assert.equal(countMatches(rollback, /authenticated %s on public\.%I differs from 016/g), 2);
  assert.equal(countMatches(rollback, /authenticated column %s on public\.%I\.%I differs from 016/g), 2);
  assert.equal(countMatches(rollback, /service_role lost %s on public\.%I/g), 2);
  assert.equal(countMatches(rollback, /service_role lost column %s on public\.%I\.%I/g), 2);
  assert.equal(countMatches(rollback, /authenticated GPS sequence grants differ from 016/g), 2);
  assert.equal(countMatches(rollback, /service_role lost GPS sequence %s/g), 2);
  assert.equal(countMatches(rollback, /v_column\.column_name = any\(array\[/g), 2);
  includesAll(rollback, [
    "'shift_id',\n            'at',\n            'lat',\n            'lng',\n            'accuracy_m',\n            'speed_mps'",
    "'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'",
    "foreach v_privilege in array array['USAGE', 'SELECT', 'UPDATE'] loop",
  ]);
});

check('final assertions pin policies, ACLs, trigger, RPCs, and preserved access', () => {
  const assertionsAt = rollback.indexOf('do $assertions$');
  const commitAt = rollback.lastIndexOf('commit;');
  assert.ok(assertionsAt >= 0 && commitAt > assertionsAt);
  const assertions = rollback.slice(assertionsAt, commitAt);
  includesAll(assertions, [
    'rollback assertion failed: anonymous policy allowlist is wrong',
    'rollback assertion failed: PUBLIC field policy exists',
    'rollback assertion failed: anon %s on public.%I is wrong',
    'rollback assertion failed: anonymous GPS sequence grants are wrong',
    'rollback assertion failed: PUBLIC has a field table or column grant',
    'rollback assertion failed: shift assignment function is unsafe',
    'rollback assertion failed: shift assignment trigger is missing or disabled',
    'rollback assertion failed: RPC execution grants changed for %s',
    'rollback assertion failed: authenticated or service-role access was not preserved',
  ]);
});

console.log('');
console.log(`${total - failed} passed, ${failed} failed, ${total} total`);
process.exit(failed ? 1 : 0);

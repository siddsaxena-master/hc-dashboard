// Offline checks only. No database, network, environment, or customer data.
// These check the migration's narrow patch, not PostgreSQL compilation.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const [migration, originalMigration, wrapperMigration] = await Promise.all([
  readFile(join(root, 'migrations/034_calendar_delivery_details.sql'), 'utf8'),
  readFile(join(root, 'migrations/019_dashboard_auth_transition.sql'), 'utf8'),
  readFile(join(root, 'migrations/028_owner_mfa_enforcement.sql'), 'utf8'),
]);
let checks = 0;
function check(name, test) {
  test();
  checks++;
  console.log(`PASS ${name}`);
}
function between(text, start, end) {
  const startAt = text.indexOf(start);
  assert.ok(startAt >= 0, `missing ${start}`);
  const endAt = text.indexOf(end, startAt + start.length);
  assert.ok(endAt >= 0, `missing ${end}`);
  return text.slice(startAt + start.length, endAt);
}
const anchor = between(migration, '$anchor$', '$anchor$');
const addition = between(migration, '$addition$', '$addition$');
const original = between(originalMigration,
  'create or replace function public.hc_list_orders_for_current_user(',
  'revoke all on function public.hc_list_orders_for_current_user(');
const patched = original.replace(anchor, anchor + addition);

check('only two nullable metadata columns are added without backfill', () => {
  assert.match(migration, /add column if not exists invoice_fulfillment jsonb,/);
  assert.match(migration, /add column if not exists delivery_request jsonb;/);
  assert.doesNotMatch(migration, /\b(?:update|insert\s+into|delete\s+from|drop\s+(?:table|column))\s+public\./i);
  assert.doesNotMatch(migration, /add column[^;]*\b(?:default|not null)\b/i);
  assert.match(migration, /invoice_fulfillment is null\s+or pg_catalog\.jsonb_typeof\(invoice_fulfillment\) = 'object'/);
  assert.match(migration, /delivery_request is null\s+or pg_catalog\.jsonb_typeof\(delivery_request\) = 'object'/);
});

check('projection insertion is unique and preserves every original byte outside it', () => {
  assert.equal(original.split(anchor).length - 1, 1);
  assert.notEqual(patched, original);
  assert.equal(patched.replace(anchor + addition, anchor), original);
  for (const guard of [
    'if auth.uid() is null then',
    'where fw.auth_user_id = auth.uid()',
    'and fw.active is true',
    "v_role not in ('owner', 'manager', 'team')",
    "v_role <> 'owner' and nullif(v_market, '') is null",
    "nullif(lower(trim(o.market)), '') is not null",
    'and lower(trim(o.market)) = v_market',
    "when v_role = 'owner' then to_jsonb(o)",
    'p_offset is null or p_offset < 0',
    'p_limit is null or p_limit < 1 or p_limit > 500',
    'and (p_delivery_from is null or o.delivery_at_utc >= p_delivery_from)',
    'and (p_delivery_before is null or o.delivery_at_utc < p_delivery_before)',
    'and (p_stages is null or o.stage = any(p_stages))',
    'order by o.delivery_at_utc asc nulls last, o.id asc',
    'offset p_offset',
    'limit p_limit',
  ]) assert.ok(patched.includes(guard), `guard changed: ${guard}`);
});

check('non-owner invoice metadata is an explicit operational whitelist', () => {
  const projection = between(addition,
    "'invoice_fulfillment', case", "'delivery_request', case");
  const fields = [...projection.matchAll(/'([a-z_]+)', o\.invoice_fulfillment -> '([a-z_]+)'/g)];
  assert.deepEqual(fields.map((match) => match[1]), [
    'source', 'read_status', 'invoice_id', 'checked_at', 'source_updated_at',
    'address', 'cracking', 'cracking_note', 'delivery_date', 'delivery_window',
  ]);
  assert.ok(fields.every((match) => match[1] === match[2]));
  assert.match(projection, /when o\.invoice_fulfillment is null then null/);
});

check('non-owner requests omit private source references and arbitrary future keys', () => {
  const projection = addition.slice(addition.indexOf("'delivery_request', case"));
  const fields = [...projection.matchAll(/'([a-z_]+)', o\.delivery_request -> '([a-z_]+)'/g)];
  assert.deepEqual(fields.map((match) => match[1]), [
    'date', 'window', 'status', 'source', 'checked_at',
  ]);
  assert.ok(fields.every((match) => match[1] === match[2]));
  assert.match(projection, /when o\.delivery_request is null then null/);
  assert.doesNotMatch(addition, /source_ref|invoice_pdf_url|external_invoice_url|client_email|client_phone|total_cents|deposit_cents|balance_cents/);
  assert.doesNotMatch(addition, /else o\.(?:invoice_fulfillment|delivery_request)\b/);
});

check('existing optional authentication wrapper stays in place', () => {
  const wrapper = between(wrapperMigration,
    'create function public.hc_list_orders_for_current_user(',
    'create function public.hc_confirm_order_delivery_v2(');
  assert.ok(wrapper.includes('public.hc_list_orders_for_current_user_pre_mfa_028('));
  assert.equal(wrapper.includes(anchor), false);
  assert.match(migration, /v_target := pg_catalog\.to_regprocedure\(\s*'public\.hc_list_orders_for_current_user_pre_mfa_028/);
  assert.match(migration, /v_target <> v_public\s+and pg_catalog\.pg_get_functiondef\(v_public\) <> v_public_before/);
  assert.doesNotMatch(migration, /\balter\s+function\b|\brename\s+to\b/i);
});

check('no new grants, policies, or write functions are introduced', () => {
  const statements = migration.replace(/--[^\n]*/g, '');
  assert.doesNotMatch(statements, /\b(?:grant|revoke|create\s+policy|drop\s+policy)\b/i);
  assert.doesNotMatch(statements, /\bcreate\s+(?:or\s+replace\s+)?function\b/i);
  for (const property of ['proacl', 'proowner', 'prosecdef', 'proconfig']) {
    assert.ok(migration.includes(`${property} is distinct from`));
  }
});

check('unknown existing definitions abort and identical reruns do not append twice', () => {
  assert.match(migration, /v_security_definer is not true/);
  assert.match(migration, /unrecognized order projection/);
  assert.match(migration, /different delivery metadata/);
  assert.match(migration, /pg_catalog\.strpos\(v_before, v_anchor \|\| v_addition\) > 0/);
  assert.match(migration, /v_after := v_before;/);
  assert.match(migration, /pg_catalog\.replace\(v_after, v_anchor \|\| v_addition, v_anchor\) <> v_before/);
});

console.log(`${checks} calendar delivery-detail checks passed. PostgreSQL runtime rehearsal is still required.`);

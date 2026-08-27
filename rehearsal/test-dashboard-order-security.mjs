// Offline contract checks for dashboard order authentication migrations.
//
// This file reads SQL and App.js as text. It does not execute SQL, connect to
// Supabase, read environment files, or make network requests.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dashboardRoot = join(here, '..');
const workspaceRoot = join(dashboardRoot, '..');
const [transition, cutover, integrity, fieldApp] = await Promise.all([
  readFile(join(dashboardRoot, 'migrations', '019_dashboard_auth_transition.sql'), 'utf8'),
  readFile(join(dashboardRoot, 'migrations', '020_dashboard_auth_cutover.sql'), 'utf8'),
  readFile(join(dashboardRoot, 'migrations', '026_delivery_confirmation_integrity.sql'), 'utf8'),
  readFile(join(workspaceRoot, 'hc-field-app', 'App.js'), 'utf8'),
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

function extractBetween(source, start, end) {
  const startAt = source.indexOf(start);
  assert.ok(startAt >= 0, `missing start marker: ${start}`);
  const endAt = source.indexOf(end, startAt + start.length);
  assert.ok(endAt >= 0, `missing end marker after: ${start}`);
  return source.slice(startAt, endAt);
}

function compact(source) {
  return source.replace(/\s+/g, ' ').trim().toLowerCase();
}

const listFunction = extractBetween(
  transition,
  'create or replace function public.hc_list_orders_for_current_user(',
  'revoke all on function public.hc_list_orders_for_current_user(',
);
const safeProjection = extractBetween(
  listFunction,
  'else jsonb_build_object(',
  '\n    )\n  end',
);
const transitionSelectPolicy = extractBetween(
  transition,
  'create policy orders_authenticated_select',
  'drop policy if exists orders_authenticated_insert',
);
const cutoverSelectPolicy = extractBetween(
  cutover,
  'create policy orders_authenticated_select',
  'drop policy if exists orders_authenticated_insert',
);
const integrityFunction = extractBetween(
  integrity,
  'create or replace function public.hc_confirm_order_delivery_v2(',
  '-- Disable the five-argument implementation.',
);

check('order list RPC has a stable paginated contract', () => {
  for (const snippet of [
    'p_delivery_from timestamptz default null',
    'p_delivery_before timestamptz default null',
    'p_stages text[] default null',
    'p_offset integer default 0',
    'p_limit integer default 500',
    'returns setof jsonb',
    'order by o.delivery_at_utc asc nulls last, o.id asc',
    'offset p_offset',
    'limit p_limit',
  ]) assert.ok(listFunction.includes(snippet), `missing: ${snippet}`);
});

check('owner receives the complete order row', () => {
  assert.ok(listFunction.includes("when v_role = 'owner' then to_jsonb(o)"));
});

check('nonowner projection contains exactly the approved operational keys', () => {
  const actual = [...safeProjection.matchAll(/'([a-z_]+)'\s*,\s*o\./g)]
    .map((match) => match[1]);
  assert.deepEqual(actual, [
    'id',
    'client_name',
    'venue',
    'delivery_notes',
    'event_start_at',
    'coconuts_qty',
    'crack_type',
    'delivery_at_utc',
    'stage',
    'market',
    'stamp_status',
    'logo_received',
    'is_recurring',
    'delivery_signed_at',
  ]);
});

check('nonowners are restricted to one exact nonblank market', () => {
  for (const snippet of [
    "v_role <> 'owner' and nullif(v_market, '') is null",
    "nullif(lower(trim(o.market)), '') is not null",
    'lower(trim(o.market)) = v_market',
  ]) assert.ok(listFunction.includes(snippet), `missing: ${snippet}`);
});

check('direct order SELECT stays owner-only in transition and cutover', () => {
  assert.equal(compact(transitionSelectPolicy).includes('using (public.hc_is_owner())'), true);
  assert.equal(compact(cutoverSelectPolicy).includes('using (public.hc_is_owner())'), true);
  assert.equal(transitionSelectPolicy.includes('hc_can_access_order_market'), false);
  assert.equal(cutoverSelectPolicy.includes('hc_can_access_order_market'), false);
});

check('anonymous callers cannot execute either dashboard RPC', () => {
  for (const sql of [transition, cutover]) {
    assert.match(
      sql,
      /revoke all on function public\.hc_list_orders_for_current_user\([\s\S]*?\) from public, anon, authenticated;/,
    );
    assert.match(
      sql,
      /revoke all on function public\.hc_confirm_order_delivery\([\s\S]*?\) from public, anon, authenticated;/,
    );
  }
});

check('delivery confirmation locks the authorized order before writing', () => {
  const deliveryFunction = extractBetween(
    transition,
    'create or replace function public.hc_confirm_order_delivery(',
    'revoke all on function public.hc_confirm_order_delivery(',
  );
  assert.match(
    compact(deliveryFunction),
    /perform 1 from public\.orders as o where o\.id = p_order_id and public\.hc_can_access_order_market\(o\.market\) for update;/,
  );
  assert.ok(deliveryFunction.indexOf('for update;') < deliveryFunction.indexOf('insert into public.delivery_signatures'));
  assert.ok(deliveryFunction.includes('v_actor_email := public.hc_current_worker_email()'));
  assert.ok(deliveryFunction.includes("v_client not in ('dashboard', 'field-app')"));
  assert.ok(deliveryFunction.includes("v_actor_email || ' via ' || v_client"));
  assert.ok(!deliveryFunction.includes('coalesce(v_signed_via'));
});

check('migration 026 adds immutable request and actor audit fields', () => {
  for (const snippet of [
    'delivery_request_id uuid',
    'actor_auth_user_id uuid',
    'delivery_source text',
    'is_authoritative boolean not null default false',
    'delivery_signatures_request_id_key',
    'delivery_signatures_authoritative_order_uidx',
  ]) assert.ok(integrity.includes(snippet), `missing: ${snippet}`);
});

check('migration 026 disables the legacy delivery bypass and grants only v2', () => {
  assert.match(
    integrity,
    /revoke all on function public\.hc_confirm_order_delivery\(\s*uuid, timestamptz, text, text, text\s*\) from public, anon, authenticated, service_role;/,
  );
  assert.match(
    integrity,
    /grant execute on function public\.hc_confirm_order_delivery_v2\(\s*uuid, uuid, timestamptz, text, text, text\s*\) to authenticated, service_role;/,
  );
});

check('v2 profile claim returns the immutable Auth UUID', () => {
  const claim = extractBetween(
    integrity,
    'create or replace function public.hc_claim_field_worker_v2()',
    'create or replace function public.hc_confirm_order_delivery_v2(',
  );
  assert.ok(claim.includes('auth_user_id uuid'));
  assert.ok(claim.includes('v_auth_user_id uuid := auth.uid()'));
  assert.ok(claim.includes('from public.hc_claim_field_worker() as claimed'));
});

check('exact replay matches every immutable field before current order access', () => {
  for (const snippet of [
    'v_existing.order_id is distinct from p_order_id',
    'v_existing.actor_auth_user_id is distinct from v_actor_auth_user_id',
    'v_existing.signed_at is distinct from p_signed_at',
    'v_existing.signed_by is distinct from v_signed_by',
    'v_existing.signature_data_url is distinct from p_signature_data_url',
    'v_existing.delivery_source is distinct from v_source',
  ]) assert.ok(integrityFunction.includes(snippet), `missing: ${snippet}`);
  assert.ok(integrityFunction.indexOf('where signature_row.delivery_request_id = p_delivery_request_id') < integrityFunction.indexOf('public.hc_can_access_order_market(order_row.market)'));
  assert.ok(integrityFunction.indexOf('return true;') < integrityFunction.indexOf('public.hc_can_access_order_market(order_row.market)'));
});

check('new delivery requests enforce the exact server-side deliverable predicate', () => {
  for (const snippet of [
    'v_order.is_recurring is distinct from false',
    "'invoiced', 'deposit_paid', 'paid_full', 'fulfilled', 'complete'",
    'v_order.delivery_at_utc is null',
    'v_order.event_start_at is null',
    'v_order.cancelled_at is not null',
    'v_order.delivery_signed_at is not null',
    'prior_signature.order_id = p_order_id',
  ]) assert.ok(integrityFunction.includes(snippet), `missing: ${snippet}`);
});

check('field app uses only the role-shaped order RPC', () => {
  assert.ok(fieldApp.includes("sb('rpc/hc_list_orders_for_current_user'"));
  assert.doesNotMatch(fieldApp, /sb\(\s*[`'"]orders\?select=/);
});

check('field app sends exclusive date bounds and paginates every order view', () => {
  for (const snippet of [
    'p_delivery_from: deliveryFrom',
    'p_delivery_before: deliveryBefore',
    'p_offset: offset',
    'p_limit: ORDER_RPC_PAGE_SIZE',
    'rows.length < ORDER_RPC_PAGE_SIZE',
  ]) assert.ok(fieldApp.includes(snippet), `missing: ${snippet}`);
});

check('the field app no longer requests direct customer contact data', () => {
  assert.doesNotMatch(fieldApp, /orders\?select=[^`\n]*client_(?:email|phone)/);
});

console.log(`\n${total - failed}/${total} dashboard order security checks passed`);
if (failed) process.exit(1);

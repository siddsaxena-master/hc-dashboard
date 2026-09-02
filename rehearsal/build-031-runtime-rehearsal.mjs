import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const forwardPath = join(
  repoRoot,
  'migrations',
  '031_order_payment_greatest_runtime_fix.sql',
);
const outputPath = join(
  here,
  '031_order_payment_greatest_runtime_rehearsal.sql',
);

const expectedForwardHash =
  '4d38414a46cc81a208da1f55c9d74530c3bf6053c9869bcfb9d86fe5fb735454';

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function stripOuterTransaction(source) {
  const normalized = source.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const begins = lines
    .map((line, index) => ({ line: line.trim().toLowerCase(), index }))
    .filter(({ line }) => line === 'begin;');
  const commits = lines
    .map((line, index) => ({ line: line.trim().toLowerCase(), index }))
    .filter(({ line }) => line === 'commit;');

  if (begins.length !== 1 || commits.length !== 1) {
    throw new Error('Forward migration must contain one standalone BEGIN and COMMIT');
  }
  if (begins[0].index >= commits[0].index) {
    throw new Error('Forward migration transaction boundaries are out of order');
  }

  return lines
    .filter((_, index) => index !== begins[0].index && index !== commits[0].index)
    .join('\n')
    .trim();
}

function countStandalone(sql, statement) {
  return sql
    .split('\n')
    .filter((line) => line.trim().toLowerCase() === statement.toLowerCase())
    .length;
}

const forwardSource = await readFile(forwardPath, 'utf8');
const actualForwardHash = sha256(forwardSource);

if (actualForwardHash !== expectedForwardHash) {
  throw new Error(`Forward migration hash changed: ${actualForwardHash}`);
}

const forwardBody = stripOuterTransaction(forwardSource);

const runtimeProbe = String.raw`
do $runtime_probe$
declare
  v_key constant text := 'hc-migration-031-runtime-rehearsal';
  v_order record;
  v_first record;
  v_second record;
  v_third record;
  v_ledger public.verified_order_payment_events%rowtype;
  v_expected_stage text;
begin
  if exists (
    select 1
    from public.verified_order_payment_events as event_row
    where event_row.source = 'quickbooks_reconciliation'
      and event_row.idempotency_key = v_key
  ) then
    raise exception using
      errcode = '55000',
      message = '031 rehearsal refused: runtime probe key already exists';
  end if;

  select
    order_row.id,
    order_row.external_invoice_id,
    order_row.stage,
    order_row.total_cents,
    order_row.deposit_cents,
    order_row.balance_cents
  into v_order
  from public.orders as order_row
  where order_row.external_invoice_id is not null
    and pg_catalog.length(order_row.external_invoice_id) between 1 and 200
    and order_row.external_invoice_id = pg_catalog.btrim(order_row.external_invoice_id)
    and order_row.external_invoice_id !~ '[[:cntrl:]]'
    and order_row.total_cents between 2 and 1000000000000
  order by order_row.id
  limit 1
  for update skip locked;

  if not found then
    raise exception using
      errcode = '55000',
      message = '031 rehearsal failed: no eligible linked order is available';
  end if;

  select *
  into v_first
  from public.hc_apply_verified_order_payment(
    v_order.id,
    v_order.external_invoice_id,
    v_order.total_cents,
    v_order.total_cents,
    v_order.stage,
    v_order.total_cents,
    v_order.deposit_cents,
    v_order.balance_cents,
    v_key,
    'quickbooks_reconciliation'
  );

  v_expected_stage := case
    when v_order.stage in ('fulfilled', 'complete', 'cancelled')
      then v_order.stage
    else 'invoiced'
  end;

  if v_first.order_id is distinct from v_order.id
     or v_first.stage is distinct from v_expected_stage
     or v_first.deposit_cents is distinct from 0
     or v_first.balance_cents is distinct from 0
     or v_first.event_inserted is distinct from true then
    raise exception using
      errcode = '55000',
      message = '031 rehearsal failed: zero-payment first call returned unexpected state';
  end if;

  select *
  into v_second
  from public.hc_apply_verified_order_payment(
    v_order.id,
    v_order.external_invoice_id,
    v_order.total_cents,
    v_order.total_cents - 1,
    v_first.stage,
    v_order.total_cents,
    v_first.deposit_cents,
    v_first.balance_cents,
    v_key,
    'quickbooks_reconciliation'
  );

  v_expected_stage := case
    when v_first.stage in ('fulfilled', 'complete', 'cancelled')
      then v_first.stage
    else 'deposit_paid'
  end;

  if v_second.order_id is distinct from v_order.id
     or v_second.stage is distinct from v_expected_stage
     or v_second.deposit_cents is distinct from 1
     or v_second.balance_cents is distinct from 0
     or v_second.event_inserted is distinct from false then
    raise exception using
      errcode = '55000',
      message = '031 rehearsal failed: retry call returned unexpected state';
  end if;

  select *
  into v_third
  from public.hc_apply_verified_order_payment(
    v_order.id,
    v_order.external_invoice_id,
    v_order.total_cents,
    v_order.total_cents,
    v_second.stage,
    v_order.total_cents,
    v_second.deposit_cents,
    v_second.balance_cents,
    v_key,
    'quickbooks_reconciliation'
  );

  v_expected_stage := case
    when v_second.stage in ('fulfilled', 'complete', 'cancelled')
      then v_second.stage
    else 'invoiced'
  end;

  if v_third.order_id is distinct from v_order.id
     or v_third.stage is distinct from v_expected_stage
     or v_third.deposit_cents is distinct from 0
     or v_third.balance_cents is distinct from 0
     or v_third.event_inserted is distinct from false then
    raise exception using
      errcode = '55000',
      message = '031 rehearsal failed: zero-payment retry returned unexpected state';
  end if;

  select event_row.*
  into v_ledger
  from public.verified_order_payment_events as event_row
  where event_row.source = 'quickbooks_reconciliation'
    and event_row.idempotency_key = v_key;

  if not found
     or v_ledger.order_id is distinct from v_order.id
     or v_ledger.external_invoice_id is distinct from v_order.external_invoice_id
     or v_ledger.first_qbo_total_cents is distinct from v_order.total_cents
     or v_ledger.first_qbo_balance_cents is distinct from v_order.total_cents
     or v_ledger.last_qbo_total_cents is distinct from v_order.total_cents
     or v_ledger.last_qbo_balance_cents is distinct from v_order.total_cents
     or v_ledger.max_qbo_received_cents is distinct from 1 then
    raise exception using
      errcode = '55000',
      message = '031 rehearsal failed: retry ledger did not preserve the greatest receipt';
  end if;

  begin
    update public.orders as order_row
    set deposit_cents = coalesce(order_row.deposit_cents, 0) + 1
    where order_row.id = v_order.id;

    raise exception using
      errcode = '55000',
      message = '031 rehearsal failed: direct payment-field update bypassed the guard';
  exception
    when sqlstate '42501' then
      null;
  end;
end
$runtime_probe$;`;

const rehearsalSql = [
  '-- GENERATED FILE. DO NOT EDIT BY HAND.',
  '-- Rehearses migration 031 and executes the repaired payment path.',
  '-- The final ROLLBACK restores the original routine and all tested rows.',
  '',
  'begin;',
  "set local idle_in_transaction_session_timeout = '30s';",
  '',
  '-- Exact reviewed forward migration body.',
  forwardBody,
  '',
  '-- Three runtime calls prove first insert, retry, and greatest-value retention.',
  runtimeProbe.trim(),
  '',
  '-- This is intentionally the only terminal transaction statement.',
  'rollback;',
  '',
].join('\n');

const shape = {
  begin: countStandalone(rehearsalSql, 'begin;'),
  commit: countStandalone(rehearsalSql, 'commit;'),
  rollback: countStandalone(rehearsalSql, 'rollback;'),
  rpcCalls: (
    rehearsalSql.match(/from public\.hc_apply_verified_order_payment\(/g) || []
  ).length,
};

if (
  shape.begin !== 1
  || shape.commit !== 0
  || shape.rollback !== 1
  || shape.rpcCalls !== 3
) {
  throw new Error(`Unsafe rehearsal shape: ${JSON.stringify(shape)}`);
}

await writeFile(outputPath, rehearsalSql, 'utf8');

console.log(JSON.stringify({
  outputPath,
  forwardHash: actualForwardHash,
  rehearsalHash: sha256(rehearsalSql),
  shape,
}, null, 2));

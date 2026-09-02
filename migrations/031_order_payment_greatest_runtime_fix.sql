-- Migration 031: repair the verified payment RPC's GREATEST expression.
--
-- Migration 030 schema-qualified GREATEST as though it were an ordinary
-- pg_catalog function. PostgreSQL treats GREATEST as a special SQL
-- expression, so the payment RPC failed only when this UPDATE was executed.
-- This migration recreates that one RPC with the one invalid qualifier
-- removed. Every other byte of the PL/pgSQL body is preserved.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $payment_rpc_preflight$
declare
  v_rpc_oid oid;
  v_owner_oid oid;
  v_body_hash text;
  v_comment text;
begin
  -- Serialize this repair with any other reviewed HC schema migration.
  perform pg_catalog.pg_advisory_xact_lock(310031, 1);

  if pg_catalog.to_regclass('public.orders') is null
     or pg_catalog.to_regclass('public.verified_order_payment_events') is null
     or pg_catalog.to_regclass('public.verified_order_void_events') is null
     or pg_catalog.to_regprocedure(
       'public.hc_apply_verified_order_void(uuid,text,text,bigint,bigint,bigint,text,text)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.hc_can_apply_direct_order_stage_transition(uuid,text,text,bigint,bigint)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.hc_protect_order_payment_fields()'
     ) is null then
    raise exception using
      errcode = '55000',
      message = '031 preflight failed: migration 030 payment protections are incomplete';
  end if;

  select
    function_info.oid,
    function_info.proowner,
    pg_catalog.md5(
      pg_catalog.replace(function_info.prosrc, pg_catalog.chr(13), '')
    ),
    pg_catalog.obj_description(function_info.oid, 'pg_proc')
  into v_rpc_oid, v_owner_oid, v_body_hash, v_comment
  from pg_catalog.pg_proc as function_info
  join pg_catalog.pg_namespace as namespace_info
    on namespace_info.oid = function_info.pronamespace
  join pg_catalog.pg_language as language_info
    on language_info.oid = function_info.prolang
  where function_info.oid = pg_catalog.to_regprocedure(
      'public.hc_apply_verified_order_payment(uuid,text,bigint,bigint,text,bigint,bigint,bigint,text,text)'
    )
    and namespace_info.nspname = 'public'
    and function_info.pronargs = 10
    and function_info.pronargdefaults = 1
    and function_info.proargnames = array[
      'p_order_id',
      'p_external_invoice_id',
      'p_qbo_total_cents',
      'p_qbo_balance_cents',
      'p_expected_stage',
      'p_expected_total_cents',
      'p_expected_deposit_cents',
      'p_expected_balance_cents',
      'p_idempotency_key',
      'p_source',
      'order_id',
      'stage',
      'deposit_cents',
      'balance_cents',
      'event_inserted'
    ]::text[]
    and pg_catalog.pg_get_expr(function_info.proargdefaults, 0) =
      '''quickbooks''::text'
    and function_info.prosecdef is true
    and function_info.prokind = 'f'
    and function_info.provolatile = 'v'
    and language_info.lanname = 'plpgsql'
    and pg_catalog.pg_get_userbyid(function_info.proowner) in (
      'postgres', 'supabase_admin'
    )
    and pg_catalog.pg_get_function_result(function_info.oid) =
      'TABLE(order_id uuid, stage text, deposit_cents bigint, balance_cents bigint, event_inserted boolean)'
    and pg_catalog.cardinality(function_info.proconfig) = 1
    and function_info.proconfig[1] ~ '^search_path=(|"")$';

  if v_rpc_oid is null
     or (
       select pg_catalog.count(*)
       from pg_catalog.pg_proc as function_info
       join pg_catalog.pg_namespace as namespace_info
         on namespace_info.oid = function_info.pronamespace
       where namespace_info.nspname = 'public'
         and function_info.proname = 'hc_apply_verified_order_payment'
     ) <> 1 then
    raise exception using
      errcode = '55000',
      message = '031 preflight failed: verified payment RPC shape drifted';
  end if;

  if not (
    (
      v_body_hash = 'b80a1c1861eac52a8602a47aebd1818f'
      and v_comment =
        'Migration 030 RPC: compare and reconcile one exact order from cumulative QuickBooks invoice truth.'
    )
    or (
      v_body_hash = 'a37c02f62545f0188c951a8ae611e731'
      and v_comment =
        'Migration 030 RPC, runtime-corrected by migration 031: compare and reconcile one exact order from cumulative QuickBooks invoice truth.'
    )
  ) then
    raise exception using
      errcode = '55000',
      message = '031 preflight failed: verified payment RPC body or comment drifted';
  end if;

  if pg_catalog.has_function_privilege(
       'anon',
       'public.hc_apply_verified_order_payment(uuid,text,bigint,bigint,text,bigint,bigint,bigint,text,text)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.hc_apply_verified_order_payment(uuid,text,bigint,bigint,text,bigint,bigint,bigint,text,text)',
       'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.hc_apply_verified_order_payment(uuid,text,bigint,bigint,text,bigint,bigint,bigint,text,text)',
       'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'supabase_admin',
       'public.hc_apply_verified_order_payment(uuid,text,bigint,bigint,text,bigint,bigint,bigint,text,text)',
       'EXECUTE'
     )
     or exists (
       select 1
       from pg_catalog.pg_proc as function_acl
       cross join lateral pg_catalog.aclexplode(
         coalesce(
           function_acl.proacl,
           pg_catalog.acldefault('f', function_acl.proowner)
         )
       ) as privilege_info
       where function_acl.oid = v_rpc_oid
         and privilege_info.privilege_type = 'EXECUTE'
         and privilege_info.grantee not in (
           v_owner_oid,
           pg_catalog.to_regrole('service_role')::oid,
           pg_catalog.to_regrole('supabase_admin')::oid
         )
     ) then
    raise exception using
      errcode = '42501',
      message = '031 preflight failed: verified payment RPC grants drifted';
  end if;

  if (
       select pg_catalog.count(*)
       from pg_catalog.pg_trigger as trigger_info
       where trigger_info.tgrelid = pg_catalog.to_regclass('public.orders')
         and trigger_info.tgname in (
           'orders_payment_integrity_insert',
           'orders_payment_integrity_update'
         )
         and trigger_info.tgfoid = pg_catalog.to_regprocedure(
           'public.hc_protect_order_payment_fields()'
         )
         and trigger_info.tgisinternal is false
         and trigger_info.tgenabled = 'O'
     ) <> 2 then
    raise exception using
      errcode = '55000',
      message = '031 preflight failed: order payment guard triggers drifted';
  end if;
end
$payment_rpc_preflight$;

-- Pause concurrent order and payment-ledger writers for the brief function swap.
lock table public.orders in share row exclusive mode;
lock table public.verified_order_payment_events in share row exclusive mode;

create or replace function public.hc_apply_verified_order_payment(
  p_order_id uuid,
  p_external_invoice_id text,
  p_qbo_total_cents bigint,
  p_qbo_balance_cents bigint,
  p_expected_stage text,
  p_expected_total_cents bigint,
  p_expected_deposit_cents bigint,
  p_expected_balance_cents bigint,
  p_idempotency_key text,
  p_source text default 'quickbooks'
)
returns table (
  order_id uuid,
  stage text,
  deposit_cents bigint,
  balance_cents bigint,
  event_inserted boolean
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_jwt_role text := nullif(auth.role(), '');
  v_order public.orders%rowtype;
  v_event public.verified_order_payment_events%rowtype;
  v_event_inserted boolean := false;
  v_received_cents bigint;
  v_payment_stage text;
  v_final_order_id uuid;
  v_final_stage text;
  v_final_deposit_cents bigint;
  v_final_balance_cents bigint;
  v_updated integer;
begin
  if not (
    v_jwt_role = 'service_role'
    or (
      v_jwt_role is null
      and session_user::text in ('postgres', 'supabase_admin', 'service_role')
    )
  ) then
    raise exception using
      errcode = '42501',
      message = 'verified QuickBooks payment writer required';
  end if;

  if p_order_id is null then
    raise exception using
      errcode = '22023',
      message = 'order ID is required';
  end if;

  if p_external_invoice_id is null
     or pg_catalog.length(p_external_invoice_id) not between 1 and 200
     or p_external_invoice_id <> pg_catalog.btrim(p_external_invoice_id)
     or p_external_invoice_id ~ '[[:cntrl:]]' then
    raise exception using
      errcode = '22023',
      message = 'external invoice ID is invalid';
  end if;

  if p_idempotency_key is null
     or pg_catalog.length(p_idempotency_key) not between 1 and 200
     or p_idempotency_key <> pg_catalog.btrim(p_idempotency_key)
     or p_idempotency_key ~ '[[:cntrl:]]' then
    raise exception using
      errcode = '22023',
      message = 'payment idempotency key is invalid';
  end if;

  if p_source is null
     or p_source not in ('quickbooks', 'quickbooks_reconciliation') then
    raise exception using
      errcode = '22023',
      message = 'verified payment source is invalid';
  end if;

  if p_qbo_total_cents is null
     or p_qbo_balance_cents is null
     or p_qbo_total_cents not between 0 and 1000000000000
     or p_qbo_balance_cents not between 0 and p_qbo_total_cents then
    raise exception using
      errcode = '22023',
      message = 'QuickBooks invoice cents are invalid';
  end if;

  select order_row.*
  into v_order
  from public.orders as order_row
  where order_row.id = p_order_id
  for update;

  if not found then
    raise exception using
      errcode = '22023',
      message = 'verified payment order was not found';
  end if;

  if v_order.external_invoice_id is distinct from p_external_invoice_id then
    raise exception using
      errcode = '22023',
      message = 'QuickBooks invoice ID does not match the order';
  end if;

  -- SQL NULL is an exact expected value here, never a wildcard. This
  -- compare-and-set check runs under the row lock and before provenance is
  -- inserted, so a reviewed snapshot cannot overwrite a newer order change.
  if v_order.stage is distinct from p_expected_stage
     or v_order.total_cents is distinct from p_expected_total_cents
     or v_order.deposit_cents is distinct from p_expected_deposit_cents
     or v_order.balance_cents is distinct from p_expected_balance_cents then
    raise exception using
      errcode = '40001',
      message = 'verified payment order snapshot changed';
  end if;

  insert into public.verified_order_payment_events (
    source,
    idempotency_key,
    order_id,
    external_invoice_id,
    first_qbo_total_cents,
    first_qbo_balance_cents,
    last_qbo_total_cents,
    last_qbo_balance_cents,
    max_qbo_received_cents
  ) values (
    p_source,
    p_idempotency_key,
    p_order_id,
    p_external_invoice_id,
    p_qbo_total_cents,
    p_qbo_balance_cents,
    p_qbo_total_cents,
    p_qbo_balance_cents,
    p_qbo_total_cents - p_qbo_balance_cents
  )
  on conflict (source, idempotency_key) do nothing
  returning true into v_event_inserted;

  v_event_inserted := coalesce(v_event_inserted, false);

  select event_row.*
  into v_event
  from public.verified_order_payment_events as event_row
  where event_row.source = p_source
    and event_row.idempotency_key = p_idempotency_key
  for update;

  if not found then
    raise exception using
      errcode = '40001',
      message = 'verified payment event changed concurrently';
  end if;

  if v_event.order_id is distinct from p_order_id
     or v_event.external_invoice_id is distinct from p_external_invoice_id then
    raise exception using
      errcode = '23505',
      message = 'payment idempotency key is bound to another invoice';
  end if;

  update public.verified_order_payment_events as event_row
  set last_qbo_total_cents = p_qbo_total_cents,
      last_qbo_balance_cents = p_qbo_balance_cents,
      max_qbo_received_cents = greatest(
        event_row.max_qbo_received_cents,
        p_qbo_total_cents - p_qbo_balance_cents
      ),
      last_seen_at = pg_catalog.clock_timestamp()
  where event_row.source = p_source
    and event_row.idempotency_key = p_idempotency_key;

  v_received_cents := p_qbo_total_cents - p_qbo_balance_cents;

  if p_qbo_total_cents > 0 and p_qbo_balance_cents = 0 then
    v_payment_stage := 'paid_full';
  elsif v_received_cents > 0 then
    v_payment_stage := 'deposit_paid';
  else
    v_payment_stage := 'invoiced';
  end if;

  -- A verified QuickBooks snapshot with zero cumulative receipts clears the
  -- recorded split. Non-operational orders return to invoiced. Fulfilled,
  -- complete, and cancelled remain operationally stable below.
  if v_received_cents = 0 then
    v_final_deposit_cents := 0;
    v_final_balance_cents := 0;
  elsif coalesce(v_order.deposit_cents, 0) > 0
        and v_order.deposit_cents <= v_received_cents then
    v_final_deposit_cents := v_order.deposit_cents;
    v_final_balance_cents := v_received_cents - v_order.deposit_cents;
  elsif v_received_cents < p_qbo_total_cents then
    v_final_deposit_cents := v_received_cents;
    v_final_balance_cents := 0;
  else
    v_final_deposit_cents := 0;
    v_final_balance_cents := p_qbo_total_cents;
  end if;

  if v_order.stage in ('fulfilled', 'complete', 'cancelled') then
    v_final_stage := v_order.stage;
  else
    v_final_stage := v_payment_stage;
  end if;

  if v_order.stage is distinct from v_final_stage
     or v_order.deposit_cents is distinct from v_final_deposit_cents
     or v_order.balance_cents is distinct from v_final_balance_cents then
    perform pg_catalog.set_config(
      'hc.verified_qbo_order_id',
      p_order_id::text,
      true
    );

    update public.orders as order_row
    set stage = v_final_stage,
        deposit_cents = v_final_deposit_cents,
        balance_cents = v_final_balance_cents
    where order_row.id = p_order_id
    returning
      order_row.id,
      order_row.stage,
      order_row.deposit_cents,
      order_row.balance_cents
    into
      v_final_order_id,
      v_final_stage,
      v_final_deposit_cents,
      v_final_balance_cents;

    get diagnostics v_updated = row_count;

    perform pg_catalog.set_config(
      'hc.verified_qbo_order_id',
      '',
      true
    );

    if v_updated <> 1 then
      raise exception using
        errcode = '40001',
        message = 'verified payment order changed concurrently';
    end if;
  else
    v_final_order_id := v_order.id;
  end if;

  return query
  select
    v_final_order_id,
    v_final_stage,
    v_final_deposit_cents,
    v_final_balance_cents,
    v_event_inserted;
end
$function$;

revoke all on function public.hc_apply_verified_order_payment(
  uuid, text, bigint, bigint, text, bigint, bigint, bigint, text, text
) from public, anon, authenticated, service_role, supabase_admin;
grant execute on function public.hc_apply_verified_order_payment(
  uuid, text, bigint, bigint, text, bigint, bigint, bigint, text, text
) to service_role, supabase_admin;

comment on function public.hc_apply_verified_order_payment(
  uuid, text, bigint, bigint, text, bigint, bigint, bigint, text, text
) is
  'Migration 030 RPC, runtime-corrected by migration 031: compare and reconcile one exact order from cumulative QuickBooks invoice truth.';

do $payment_rpc_postflight$
declare
  v_rpc_oid oid;
  v_owner_oid oid;
begin
  select function_info.oid, function_info.proowner
  into v_rpc_oid, v_owner_oid
  from pg_catalog.pg_proc as function_info
  join pg_catalog.pg_namespace as namespace_info
    on namespace_info.oid = function_info.pronamespace
  join pg_catalog.pg_language as language_info
    on language_info.oid = function_info.prolang
  where function_info.oid = pg_catalog.to_regprocedure(
      'public.hc_apply_verified_order_payment(uuid,text,bigint,bigint,text,bigint,bigint,bigint,text,text)'
    )
    and namespace_info.nspname = 'public'
    and function_info.pronargs = 10
    and function_info.pronargdefaults = 1
    and function_info.proargnames = array[
      'p_order_id',
      'p_external_invoice_id',
      'p_qbo_total_cents',
      'p_qbo_balance_cents',
      'p_expected_stage',
      'p_expected_total_cents',
      'p_expected_deposit_cents',
      'p_expected_balance_cents',
      'p_idempotency_key',
      'p_source',
      'order_id',
      'stage',
      'deposit_cents',
      'balance_cents',
      'event_inserted'
    ]::text[]
    and pg_catalog.pg_get_expr(function_info.proargdefaults, 0) =
      '''quickbooks''::text'
    and function_info.prosecdef is true
    and function_info.prokind = 'f'
    and function_info.provolatile = 'v'
    and language_info.lanname = 'plpgsql'
    and pg_catalog.pg_get_userbyid(function_info.proowner) in (
      'postgres', 'supabase_admin'
    )
    and pg_catalog.pg_get_function_result(function_info.oid) =
      'TABLE(order_id uuid, stage text, deposit_cents bigint, balance_cents bigint, event_inserted boolean)'
    and pg_catalog.cardinality(function_info.proconfig) = 1
    and function_info.proconfig[1] ~ '^search_path=(|"")$'
    and pg_catalog.md5(
      pg_catalog.replace(function_info.prosrc, pg_catalog.chr(13), '')
    ) = 'a37c02f62545f0188c951a8ae611e731'
    and pg_catalog.strpos(function_info.prosrc, 'pg_catalog.greatest(') = 0
    and (
      pg_catalog.length(function_info.prosrc)
      - pg_catalog.length(
        pg_catalog.replace(function_info.prosrc, 'greatest(', '')
      )
    ) / pg_catalog.length('greatest(') = 1;

  if v_rpc_oid is null
     or (
       select pg_catalog.count(*)
       from pg_catalog.pg_proc as function_info
       join pg_catalog.pg_namespace as namespace_info
         on namespace_info.oid = function_info.pronamespace
       where namespace_info.nspname = 'public'
         and function_info.proname = 'hc_apply_verified_order_payment'
     ) <> 1
     or pg_catalog.obj_description(v_rpc_oid, 'pg_proc') is distinct from
       'Migration 030 RPC, runtime-corrected by migration 031: compare and reconcile one exact order from cumulative QuickBooks invoice truth.'
     or pg_catalog.has_function_privilege(
       'anon',
       'public.hc_apply_verified_order_payment(uuid,text,bigint,bigint,text,bigint,bigint,bigint,text,text)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.hc_apply_verified_order_payment(uuid,text,bigint,bigint,text,bigint,bigint,bigint,text,text)',
       'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.hc_apply_verified_order_payment(uuid,text,bigint,bigint,text,bigint,bigint,bigint,text,text)',
       'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'supabase_admin',
       'public.hc_apply_verified_order_payment(uuid,text,bigint,bigint,text,bigint,bigint,bigint,text,text)',
       'EXECUTE'
     )
     or exists (
       select 1
       from pg_catalog.pg_proc as function_acl
       cross join lateral pg_catalog.aclexplode(
         coalesce(
           function_acl.proacl,
           pg_catalog.acldefault('f', function_acl.proowner)
         )
       ) as privilege_info
       where function_acl.oid = v_rpc_oid
         and privilege_info.privilege_type = 'EXECUTE'
         and privilege_info.grantee not in (
           v_owner_oid,
           pg_catalog.to_regrole('service_role')::oid,
           pg_catalog.to_regrole('supabase_admin')::oid
         )
     ) then
    raise exception using
      errcode = '42501',
      message = '031 postflight failed: repaired payment RPC is unsafe';
  end if;

  if (
       select pg_catalog.count(*)
       from pg_catalog.pg_trigger as trigger_info
       where trigger_info.tgrelid = pg_catalog.to_regclass('public.orders')
         and trigger_info.tgname in (
           'orders_payment_integrity_insert',
           'orders_payment_integrity_update'
         )
         and trigger_info.tgfoid = pg_catalog.to_regprocedure(
           'public.hc_protect_order_payment_fields()'
         )
         and trigger_info.tgisinternal is false
         and trigger_info.tgenabled = 'O'
     ) <> 2 then
    raise exception using
      errcode = '55000',
      message = '031 postflight failed: order payment guard triggers drifted';
  end if;
end
$payment_rpc_postflight$;

commit;

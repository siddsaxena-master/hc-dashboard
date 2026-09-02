-- GENERATED FILE. DO NOT EDIT BY HAND.
-- Installs migration 030 and its rollback inside one outer transaction.
-- The final ROLLBACK guarantees that this rehearsal leaves no live objects.

begin;
set local idle_in_transaction_session_timeout = '30s';

-- Exact reviewed forward migration body.
-- ============================================================================
-- 030_order_payment_integrity.sql
-- Keep verified QuickBooks payment state authoritative on public.orders.
--
-- This migration changes no existing order data. It installs BEFORE triggers
-- that reject direct payment writes from every API role, including the generic
-- service role. Verified QuickBooks writes must use the guarded RPC below.
-- ============================================================================


set local lock_timeout = '10s';
set local statement_timeout = '60s';

do $table_preflight$
declare
  v_orders_oid oid;
begin
  select relation_info.oid
  into v_orders_oid
  from pg_catalog.pg_class as relation_info
  join pg_catalog.pg_namespace as namespace_info
    on namespace_info.oid = relation_info.relnamespace
  where namespace_info.nspname = 'public'
    and relation_info.relname = 'orders'
    and relation_info.relkind = 'r';

  if v_orders_oid is null then
    raise exception using
      errcode = '55000',
      message = '030 requires public.orders to be an ordinary table';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_attribute as column_info
    where column_info.attrelid = v_orders_oid
      and column_info.attname = 'id'
      and column_info.atttypid = 'pg_catalog.uuid'::pg_catalog.regtype
      and column_info.atttypmod = -1
      and column_info.attnum > 0
      and column_info.attisdropped is false
  ) or not exists (
    select 1
    from pg_catalog.pg_attribute as column_info
    where column_info.attrelid = v_orders_oid
      and column_info.attname = 'external_invoice_id'
      and column_info.atttypid = 'pg_catalog.text'::pg_catalog.regtype
      and column_info.atttypmod = -1
      and column_info.attnum > 0
      and column_info.attisdropped is false
  ) or not exists (
    select 1
    from pg_catalog.pg_attribute as column_info
    where column_info.attrelid = v_orders_oid
      and column_info.attname = 'market'
      and column_info.atttypid = 'pg_catalog.text'::pg_catalog.regtype
      and column_info.atttypmod = -1
      and column_info.attnum > 0
      and column_info.attisdropped is false
  ) or not exists (
    select 1
    from pg_catalog.pg_attribute as column_info
    where column_info.attrelid = v_orders_oid
      and column_info.attname = 'stage'
      and column_info.atttypid = 'pg_catalog.text'::pg_catalog.regtype
      and column_info.atttypmod = -1
      and column_info.attnotnull is true
      and column_info.attnum > 0
      and column_info.attisdropped is false
  ) or not exists (
    select 1
    from pg_catalog.pg_attribute as column_info
    where column_info.attrelid = v_orders_oid
      and column_info.attname = 'total_cents'
      and column_info.atttypid = 'pg_catalog.int8'::pg_catalog.regtype
      and column_info.atttypmod = -1
      and column_info.attnotnull is false
      and column_info.attnum > 0
      and column_info.attisdropped is false
  ) or not exists (
    select 1
    from pg_catalog.pg_attribute as column_info
    where column_info.attrelid = v_orders_oid
      and column_info.attname = 'deposit_cents'
      and column_info.atttypid = 'pg_catalog.int8'::pg_catalog.regtype
      and column_info.atttypmod = -1
      and column_info.attnotnull is true
      and column_info.attnum > 0
      and column_info.attisdropped is false
  ) or not exists (
    select 1
    from pg_catalog.pg_attribute as column_info
    where column_info.attrelid = v_orders_oid
      and column_info.attname = 'balance_cents'
      and column_info.atttypid = 'pg_catalog.int8'::pg_catalog.regtype
      and column_info.atttypmod = -1
      and column_info.attnotnull is false
      and column_info.attnum > 0
      and column_info.attisdropped is false
  ) then
    raise exception using
      errcode = '55000',
      message = '030 requires the authenticated orders payment schema';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_proc as function_info
    join pg_catalog.pg_namespace as namespace_info
      on namespace_info.oid = function_info.pronamespace
    where namespace_info.nspname = 'auth'
      and function_info.proname = 'role'
      and function_info.pronargs = 0
      and function_info.prorettype = 'pg_catalog.text'::pg_catalog.regtype
      and function_info.prokind = 'f'
  ) then
    raise exception using
      errcode = '55000',
      message = '030 requires Supabase auth.role() returning text';
  end if;

  if pg_catalog.to_regprocedure(
       'public.hc_can_access_order_market(text)'
     ) is null then
    raise exception using
      errcode = '55000',
      message = '030 requires authenticated dashboard migration 019';
  end if;

  if (
    select pg_catalog.count(*)
    from pg_catalog.pg_roles as role_info
    where role_info.rolname in (
      'anon', 'authenticated', 'service_role', 'postgres', 'supabase_admin'
    )
  ) <> 5 then
    raise exception using
      errcode = '55000',
      message = '030 requires the Supabase API roles';
  end if;
end
$table_preflight$;

-- Serialize trigger installation with writes and other trigger changes while
-- still allowing normal SELECT queries to continue.
lock table public.orders in share row exclusive mode;

do $object_preflight$
begin
  if exists (
    select 1
    from pg_catalog.pg_proc as function_info
    join pg_catalog.pg_namespace as namespace_info
      on namespace_info.oid = function_info.pronamespace
    where namespace_info.nspname = 'public'
      and function_info.proname = 'hc_protect_order_payment_fields'
  ) then
    raise exception using
      errcode = '55000',
      message = '030 refused: payment guard function already exists';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_proc as function_info
    join pg_catalog.pg_namespace as namespace_info
      on namespace_info.oid = function_info.pronamespace
    where namespace_info.nspname = 'public'
      and function_info.proname = 'hc_can_apply_direct_order_stage_transition'
  ) then
    raise exception using
      errcode = '55000',
      message = '030 refused: payment provenance helper already exists';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_proc as function_info
    join pg_catalog.pg_namespace as namespace_info
      on namespace_info.oid = function_info.pronamespace
    where namespace_info.nspname = 'public'
      and function_info.proname = 'hc_apply_verified_order_payment'
  ) or pg_catalog.to_regclass(
       'public.verified_order_payment_events'
     ) is not null
     or pg_catalog.to_regclass(
       'public.verified_order_payment_events_order_idx'
     ) is not null then
    raise exception using
      errcode = '55000',
      message = '030 refused: verified payment RPC or audit objects already exist';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_proc as function_info
    join pg_catalog.pg_namespace as namespace_info
      on namespace_info.oid = function_info.pronamespace
    where namespace_info.nspname = 'public'
      and function_info.proname = 'hc_apply_verified_order_void'
  ) or pg_catalog.to_regclass(
       'public.verified_order_void_events'
     ) is not null
     or pg_catalog.to_regclass(
       'public.verified_order_void_events_order_idx'
     ) is not null then
    raise exception using
      errcode = '55000',
      message = '030 refused: verified void RPC or audit objects already exist';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_trigger as trigger_info
    where trigger_info.tgrelid = 'public.orders'::pg_catalog.regclass
      and trigger_info.tgname in (
        'orders_payment_integrity',
        'orders_payment_integrity_insert',
        'orders_payment_integrity_update'
      )
  ) then
    raise exception using
      errcode = '55000',
      message = '030 refused: a reserved payment guard trigger already exists';
  end if;
end
$object_preflight$;

create table public.verified_order_payment_events (
  source                    text not null,
  idempotency_key           text not null,
  order_id                  uuid not null,
  external_invoice_id       text not null,
  first_qbo_total_cents     bigint not null,
  first_qbo_balance_cents   bigint not null,
  last_qbo_total_cents      bigint not null,
  last_qbo_balance_cents    bigint not null,
  max_qbo_received_cents    bigint not null,
  first_seen_at             timestamptz not null default pg_catalog.clock_timestamp(),
  last_seen_at              timestamptz not null default pg_catalog.clock_timestamp(),
  constraint verified_order_payment_events_pkey
    primary key (source, idempotency_key),
  constraint verified_order_payment_events_order_fkey
    foreign key (order_id) references public.orders(id) on delete restrict,
  constraint verified_order_payment_events_source_check
    check (source in ('quickbooks', 'quickbooks_reconciliation')),
  constraint verified_order_payment_events_key_check
    check (
      pg_catalog.length(idempotency_key) between 1 and 200
      and idempotency_key = pg_catalog.btrim(idempotency_key)
      and idempotency_key !~ '[[:cntrl:]]'
    ),
  constraint verified_order_payment_events_invoice_check
    check (
      pg_catalog.length(external_invoice_id) between 1 and 200
      and external_invoice_id = pg_catalog.btrim(external_invoice_id)
      and external_invoice_id !~ '[[:cntrl:]]'
    ),
  constraint verified_order_payment_events_first_snapshot_check
    check (
      first_qbo_total_cents between 0 and 1000000000000
      and first_qbo_balance_cents between 0 and first_qbo_total_cents
    ),
  constraint verified_order_payment_events_last_snapshot_check
    check (
      last_qbo_total_cents between 0 and 1000000000000
      and last_qbo_balance_cents between 0 and last_qbo_total_cents
    ),
  constraint verified_order_payment_events_max_received_check
    check (
      max_qbo_received_cents between 0 and 1000000000000
    )
);

create index verified_order_payment_events_order_idx
  on public.verified_order_payment_events (order_id, last_seen_at desc);

alter table public.verified_order_payment_events enable row level security;
revoke all on table public.verified_order_payment_events
  from public, anon, authenticated, service_role, supabase_admin;

create table public.verified_order_void_events (
  source                    text not null,
  idempotency_key           text not null,
  order_id                  uuid not null,
  external_invoice_id       text not null,
  first_seen_at             timestamptz not null default pg_catalog.clock_timestamp(),
  last_seen_at              timestamptz not null default pg_catalog.clock_timestamp(),
  constraint verified_order_void_events_pkey
    primary key (source, idempotency_key),
  constraint verified_order_void_events_order_fkey
    foreign key (order_id) references public.orders(id) on delete restrict,
  constraint verified_order_void_events_source_check
    check (source in ('quickbooks', 'quickbooks_reconciliation')),
  constraint verified_order_void_events_key_check
    check (
      pg_catalog.length(idempotency_key) between 1 and 200
      and idempotency_key = pg_catalog.btrim(idempotency_key)
      and idempotency_key !~ '[[:cntrl:]]'
    ),
  constraint verified_order_void_events_invoice_check
    check (
      pg_catalog.length(external_invoice_id) between 1 and 200
      and external_invoice_id = pg_catalog.btrim(external_invoice_id)
      and external_invoice_id !~ '[[:cntrl:]]'
    )
);

create index verified_order_void_events_order_idx
  on public.verified_order_void_events (order_id, last_seen_at desc);

alter table public.verified_order_void_events enable row level security;
revoke all on table public.verified_order_void_events
  from public, anon, authenticated, service_role, supabase_admin;

-- The trigger remains SECURITY INVOKER so its RPC marker cannot be spoofed by
-- a generic service-role row update. This narrowly scoped SECURITY DEFINER
-- helper returns only one allow/deny bit after checking the caller can see the
-- exact locked order snapshot. The two private ledgers remain unreadable.
create function public.hc_can_apply_direct_order_stage_transition(
  p_order_id uuid,
  p_old_stage text,
  p_new_stage text,
  p_deposit_cents bigint,
  p_balance_cents bigint
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_jwt_role text := nullif(auth.role(), '');
  v_context_visible boolean;
  v_has_positive_payment boolean;
  v_has_verified_void boolean;
begin
  if p_order_id is null then
    raise exception using
      errcode = '22023',
      message = 'order stage transition context is invalid';
  end if;

  if v_jwt_role = 'authenticated' then
    select exists (
      select 1
      from public.orders as order_row
      where order_row.id = p_order_id
        and order_row.stage is not distinct from p_old_stage
        and order_row.deposit_cents is not distinct from p_deposit_cents
        and order_row.balance_cents is not distinct from p_balance_cents
        and public.hc_can_access_order_market(order_row.market)
    )
    into v_context_visible;
  elsif v_jwt_role = 'service_role'
        or (
          v_jwt_role is null
          and session_user::text in ('postgres', 'supabase_admin', 'service_role')
        ) then
    select exists (
      select 1
      from public.orders as order_row
      where order_row.id = p_order_id
        and order_row.stage is not distinct from p_old_stage
        and order_row.deposit_cents is not distinct from p_deposit_cents
        and order_row.balance_cents is not distinct from p_balance_cents
    )
    into v_context_visible;
  else
    raise exception using
      errcode = '42501',
      message = 'order stage transition reader is not authorized';
  end if;

  if coalesce(v_context_visible, false) is false then
    raise exception using
      errcode = '42501',
      message = 'order stage transition context is not accessible';
  end if;

  if p_old_stage is not distinct from p_new_stage then
    return true;
  end if;

  -- Payment stages themselves can only be asserted by the payment RPC.
  if p_new_stage in ('deposit_paid', 'paid_full') then
    return false;
  end if;

  select
    coalesce(p_deposit_cents, 0) > 0
      or coalesce(p_balance_cents, 0) > 0
      or exists (
        select 1
        from public.verified_order_payment_events as payment_event
        where payment_event.order_id = p_order_id
          and payment_event.max_qbo_received_cents > 0
      ),
    exists (
      select 1
      from public.verified_order_void_events as void_event
      where void_event.order_id = p_order_id
    )
  into v_has_positive_payment, v_has_verified_void;

  -- A verified void makes cancelled durable. A normal no-payment customer
  -- Passed/cancelled order has no ledger row and remains editable below.
  if v_has_verified_void then
    return p_new_stage = 'cancelled';
  end if;

  if v_has_positive_payment then
    return case
      when p_old_stage in ('deposit_paid', 'paid_full')
        then p_new_stage in ('fulfilled', 'complete')
      when p_old_stage = 'fulfilled'
        then p_new_stage = 'complete'
      else false
    end;
  end if;

  -- No positive payment evidence and no verified void means the ordinary
  -- unpaid workflow remains editable, including Passed/cancelled corrections.
  return true;
end
$function$;

revoke all on function public.hc_can_apply_direct_order_stage_transition(
  uuid, text, text, bigint, bigint
) from public, anon, authenticated, service_role, supabase_admin;
grant execute on function public.hc_can_apply_direct_order_stage_transition(
  uuid, text, text, bigint, bigint
) to authenticated, service_role, supabase_admin;

comment on function public.hc_can_apply_direct_order_stage_transition(
  uuid, text, text, bigint, bigint
) is
  'Migration 030 helper: allow one visible direct stage transition without exposing private payment provenance.';

-- One idempotency key identifies one immutable source/order/invoice event.
-- A retry may carry newer QuickBooks totals, so the event remains "existing"
-- while current QuickBooks truth is still reapplied to the locked order.
create function public.hc_apply_verified_order_payment(
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
      max_qbo_received_cents = pg_catalog.greatest(
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

comment on table public.verified_order_payment_events is
  'Private idempotency and reconciliation audit for verified QuickBooks payment events.';
comment on function public.hc_apply_verified_order_payment(
  uuid, text, bigint, bigint, text, bigint, bigint, bigint, text, text
) is
  'Migration 030 RPC: compare and reconcile one exact order from cumulative QuickBooks invoice truth.';

create function public.hc_apply_verified_order_void(
  p_order_id uuid,
  p_external_invoice_id text,
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
  event_inserted boolean
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_jwt_role text := nullif(auth.role(), '');
  v_order public.orders%rowtype;
  v_event public.verified_order_void_events%rowtype;
  v_event_inserted boolean := false;
  v_final_order_id uuid;
  v_final_stage text;
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
      message = 'verified QuickBooks void writer required';
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
      message = 'void idempotency key is invalid';
  end if;

  if p_source is null
     or p_source not in ('quickbooks', 'quickbooks_reconciliation') then
    raise exception using
      errcode = '22023',
      message = 'verified void source is invalid';
  end if;

  select order_row.*
  into v_order
  from public.orders as order_row
  where order_row.id = p_order_id
  for update;

  if not found then
    raise exception using
      errcode = '22023',
      message = 'verified void order was not found';
  end if;

  if v_order.external_invoice_id is distinct from p_external_invoice_id then
    raise exception using
      errcode = '22023',
      message = 'QuickBooks invoice ID does not match the order';
  end if;

  -- A retry using the original pre-void snapshot is safe only when this exact
  -- event already exists and the locked order is still cancelled with the
  -- same non-stage values. It performs no insert, update, or ledger refresh.
  if v_order.stage is distinct from p_expected_stage
     or v_order.total_cents is distinct from p_expected_total_cents
     or v_order.deposit_cents is distinct from p_expected_deposit_cents
     or v_order.balance_cents is distinct from p_expected_balance_cents then
    select event_row.*
    into v_event
    from public.verified_order_void_events as event_row
    where event_row.source = p_source
      and event_row.idempotency_key = p_idempotency_key
    for update;

    if found
       and v_event.order_id is not distinct from p_order_id
       and v_event.external_invoice_id is not distinct from p_external_invoice_id
       and v_order.stage = 'cancelled'
       and p_expected_stage is not null
       and p_expected_stage <> 'cancelled'
       and v_order.total_cents is not distinct from p_expected_total_cents
       and v_order.deposit_cents is not distinct from p_expected_deposit_cents
       and v_order.balance_cents is not distinct from p_expected_balance_cents then
      return query
      select v_order.id, v_order.stage, false;
      return;
    end if;

    raise exception using
      errcode = '40001',
      message = 'verified void order snapshot changed';
  end if;

  insert into public.verified_order_void_events (
    source,
    idempotency_key,
    order_id,
    external_invoice_id
  ) values (
    p_source,
    p_idempotency_key,
    p_order_id,
    p_external_invoice_id
  )
  on conflict (source, idempotency_key) do nothing
  returning true into v_event_inserted;

  v_event_inserted := coalesce(v_event_inserted, false);

  select event_row.*
  into v_event
  from public.verified_order_void_events as event_row
  where event_row.source = p_source
    and event_row.idempotency_key = p_idempotency_key
  for update;

  if not found then
    raise exception using
      errcode = '40001',
      message = 'verified void event changed concurrently';
  end if;

  if v_event.order_id is distinct from p_order_id
     or v_event.external_invoice_id is distinct from p_external_invoice_id then
    raise exception using
      errcode = '23505',
      message = 'void idempotency key is bound to another invoice';
  end if;

  update public.verified_order_void_events as event_row
  set last_seen_at = pg_catalog.clock_timestamp()
  where event_row.source = p_source
    and event_row.idempotency_key = p_idempotency_key;

  if v_order.stage is distinct from 'cancelled' then
    perform pg_catalog.set_config(
      'hc.verified_qbo_order_id',
      p_order_id::text,
      true
    );

    update public.orders as order_row
    set stage = 'cancelled'
    where order_row.id = p_order_id
    returning order_row.id, order_row.stage
    into v_final_order_id, v_final_stage;

    get diagnostics v_updated = row_count;

    perform pg_catalog.set_config(
      'hc.verified_qbo_order_id',
      '',
      true
    );

    if v_updated <> 1 then
      raise exception using
        errcode = '40001',
        message = 'verified void order changed concurrently';
    end if;
  else
    v_final_order_id := v_order.id;
    v_final_stage := v_order.stage;
  end if;

  return query
  select v_final_order_id, v_final_stage, v_event_inserted;
end
$function$;

revoke all on function public.hc_apply_verified_order_void(
  uuid, text, text, bigint, bigint, bigint, text, text
) from public, anon, authenticated, service_role, supabase_admin;
grant execute on function public.hc_apply_verified_order_void(
  uuid, text, text, bigint, bigint, bigint, text, text
) to service_role, supabase_admin;

comment on table public.verified_order_void_events is
  'Private idempotency audit for verified QuickBooks invoice void events.';
comment on function public.hc_apply_verified_order_void(
  uuid, text, text, bigint, bigint, bigint, text, text
) is
  'Migration 030 RPC: compare and cancel one exact order after a verified QuickBooks void.';

create function public.hc_protect_order_payment_fields()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_guard_order_id text := nullif(
    pg_catalog.current_setting('hc.verified_qbo_order_id', true),
    ''
  );
  v_payment_rpc_owner oid;
  v_void_rpc_owner oid;
begin
  if tg_table_schema <> 'public'
     or tg_table_name <> 'orders'
     or tg_when <> 'BEFORE'
     or tg_level <> 'ROW' then
    raise exception using
      errcode = '55000',
      message = 'order payment guard is attached incorrectly';
  end if;

  -- The marker is local to this transaction and names the one locked order.
  -- The current role must also be the dedicated security-definer RPC owner.
  if tg_op = 'UPDATE'
     and v_guard_order_id = new.id::text then
    select payment_function.proowner, void_function.proowner
    into v_payment_rpc_owner, v_void_rpc_owner
    from pg_catalog.pg_proc as payment_function
    cross join pg_catalog.pg_proc as void_function
    where payment_function.oid = pg_catalog.to_regprocedure(
        'public.hc_apply_verified_order_payment(uuid,text,bigint,bigint,text,bigint,bigint,bigint,text,text)'
      )
      and void_function.oid = pg_catalog.to_regprocedure(
        'public.hc_apply_verified_order_void(uuid,text,text,bigint,bigint,bigint,text,text)'
      );

    if v_payment_rpc_owner is not null
       and v_payment_rpc_owner = v_void_rpc_owner
       and pg_catalog.pg_get_userbyid(v_payment_rpc_owner) = current_user::text then
      return new;
    end if;
  end if;

  if tg_op = 'INSERT' then
    if coalesce(new.deposit_cents, 0) <> 0
       or coalesce(new.balance_cents, 0) <> 0
       or new.stage in ('deposit_paid', 'paid_full') then
      raise exception using
        errcode = '42501',
        message = 'verified QuickBooks payment fields are read-only';
    end if;

    return new;
  end if;

  if tg_op <> 'UPDATE' then
    raise exception using
      errcode = '55000',
      message = 'order payment guard received an unsupported operation';
  end if;

  if new.deposit_cents is distinct from old.deposit_cents
     or new.balance_cents is distinct from old.balance_cents then
    raise exception using
      errcode = '42501',
      message = 'verified QuickBooks payment amounts are read-only';
  end if;

  if new.stage is distinct from old.stage then
    -- Only a trusted QuickBooks writer may assert either payment stage or
    -- advance one verified payment stage to another.
    if new.stage in ('deposit_paid', 'paid_full') then
      raise exception using
        errcode = '42501',
        message = 'verified QuickBooks payment status is read-only';
    end if;

    if coalesce(
      public.hc_can_apply_direct_order_stage_transition(
        old.id,
        old.stage,
        new.stage,
        old.deposit_cents,
        old.balance_cents
      ),
      false
    ) is false then
      raise exception using
        errcode = '42501',
        message = 'verified QuickBooks payment or void status cannot be replaced';
    end if;
  end if;

  return new;
end
$function$;

revoke all on function public.hc_protect_order_payment_fields()
  from public, anon, authenticated, service_role;

create trigger orders_payment_integrity_insert
before insert on public.orders
for each row execute function public.hc_protect_order_payment_fields();

create trigger orders_payment_integrity_update
before update of deposit_cents, balance_cents, stage on public.orders
for each row execute function public.hc_protect_order_payment_fields();

comment on function public.hc_protect_order_payment_fields() is
  'Migration 030 trigger: direct order payment writes are blocked outside the verified RPC.';
comment on trigger orders_payment_integrity_insert on public.orders is
  'Migration 030: blocks untrusted payment state on new orders.';
comment on trigger orders_payment_integrity_update on public.orders is
  'Migration 030: protects verified order payment fields and stages.';

create temporary table hc_030_expected_payment_checks (
  source text,
  idempotency_key text,
  external_invoice_id text,
  first_qbo_total_cents bigint,
  first_qbo_balance_cents bigint,
  last_qbo_total_cents bigint,
  last_qbo_balance_cents bigint,
  max_qbo_received_cents bigint,
  constraint verified_order_payment_events_source_check
    check (source in ('quickbooks', 'quickbooks_reconciliation')),
  constraint verified_order_payment_events_key_check
    check (
      pg_catalog.length(idempotency_key) between 1 and 200
      and idempotency_key = pg_catalog.btrim(idempotency_key)
      and idempotency_key !~ '[[:cntrl:]]'
    ),
  constraint verified_order_payment_events_invoice_check
    check (
      pg_catalog.length(external_invoice_id) between 1 and 200
      and external_invoice_id = pg_catalog.btrim(external_invoice_id)
      and external_invoice_id !~ '[[:cntrl:]]'
    ),
  constraint verified_order_payment_events_first_snapshot_check
    check (
      first_qbo_total_cents between 0 and 1000000000000
      and first_qbo_balance_cents between 0 and first_qbo_total_cents
    ),
  constraint verified_order_payment_events_last_snapshot_check
    check (
      last_qbo_total_cents between 0 and 1000000000000
      and last_qbo_balance_cents between 0 and last_qbo_total_cents
    ),
  constraint verified_order_payment_events_max_received_check
    check (
      max_qbo_received_cents between 0 and 1000000000000
    )
) on commit drop;

create temporary table hc_030_expected_void_checks (
  source text,
  idempotency_key text,
  external_invoice_id text,
  constraint verified_order_void_events_source_check
    check (source in ('quickbooks', 'quickbooks_reconciliation')),
  constraint verified_order_void_events_key_check
    check (
      pg_catalog.length(idempotency_key) between 1 and 200
      and idempotency_key = pg_catalog.btrim(idempotency_key)
      and idempotency_key !~ '[[:cntrl:]]'
    ),
  constraint verified_order_void_events_invoice_check
    check (
      pg_catalog.length(external_invoice_id) between 1 and 200
      and external_invoice_id = pg_catalog.btrim(external_invoice_id)
      and external_invoice_id !~ '[[:cntrl:]]'
    )
) on commit drop;

do $void_postflight$
declare
  v_events_oid oid;
  v_expected_checks_oid oid;
  v_orders_oid oid := 'public.orders'::pg_catalog.regclass;
  v_void_rpc_oid oid;
begin
  select relation_info.oid
  into v_events_oid
  from pg_catalog.pg_class as relation_info
  join pg_catalog.pg_namespace as namespace_info
    on namespace_info.oid = relation_info.relnamespace
  where namespace_info.nspname = 'public'
    and relation_info.relname = 'verified_order_void_events'
    and relation_info.relkind = 'r'
    and relation_info.relrowsecurity is true
    and relation_info.relforcerowsecurity is false;

  v_expected_checks_oid := 'pg_temp.hc_030_expected_void_checks'::pg_catalog.regclass;

  if v_events_oid is null
     or pg_catalog.obj_description(v_events_oid, 'pg_class') is distinct from
       'Private idempotency audit for verified QuickBooks invoice void events.'
     or (
       select pg_catalog.count(*)
       from pg_catalog.pg_attribute as column_info
       where column_info.attrelid = v_events_oid
         and column_info.attnum > 0
         and column_info.attisdropped is false
     ) <> 6
     or (
       select pg_catalog.count(*)
       from pg_catalog.pg_attribute as column_info
       join (
         values
           ('source', 'pg_catalog.text'::pg_catalog.regtype::oid, true),
           ('idempotency_key', 'pg_catalog.text'::pg_catalog.regtype::oid, true),
           ('order_id', 'pg_catalog.uuid'::pg_catalog.regtype::oid, true),
           ('external_invoice_id', 'pg_catalog.text'::pg_catalog.regtype::oid, true),
           ('first_seen_at', 'pg_catalog.timestamptz'::pg_catalog.regtype::oid, true),
           ('last_seen_at', 'pg_catalog.timestamptz'::pg_catalog.regtype::oid, true)
       ) as expected(column_name, type_oid, not_null)
         on expected.column_name = column_info.attname
        and expected.type_oid = column_info.atttypid
        and expected.not_null = column_info.attnotnull
       where column_info.attrelid = v_events_oid
         and column_info.atttypmod = -1
         and column_info.attnum > 0
         and column_info.attisdropped is false
     ) <> 6
     or (
       select pg_catalog.count(*)
       from pg_catalog.pg_attrdef as default_info
       join pg_catalog.pg_attribute as column_info
         on column_info.attrelid = default_info.adrelid
        and column_info.attnum = default_info.adnum
       where default_info.adrelid = v_events_oid
         and column_info.attname in ('first_seen_at', 'last_seen_at')
         and pg_catalog.pg_get_expr(
           default_info.adbin,
           default_info.adrelid
         ) = 'clock_timestamp()'
     ) <> 2
     or (
       select pg_catalog.count(*)
       from pg_catalog.pg_attrdef as default_info
       where default_info.adrelid = v_events_oid
     ) <> 2
     or (
       select pg_catalog.count(*)
       from pg_catalog.pg_constraint as constraint_info
       where constraint_info.conrelid = v_events_oid
     ) <> 5
     or not exists (
       select 1
       from pg_catalog.pg_constraint as constraint_info
       where constraint_info.conrelid = v_events_oid
         and constraint_info.conname = 'verified_order_void_events_pkey'
         and constraint_info.contype = 'p'
         and constraint_info.conindid = pg_catalog.to_regclass(
           'public.verified_order_void_events_pkey'
         )
         and constraint_info.conkey = array[
           (
             select column_info.attnum
             from pg_catalog.pg_attribute as column_info
             where column_info.attrelid = v_events_oid
               and column_info.attname = 'source'
           ),
           (
             select column_info.attnum
             from pg_catalog.pg_attribute as column_info
             where column_info.attrelid = v_events_oid
               and column_info.attname = 'idempotency_key'
           )
         ]::smallint[]
         and constraint_info.convalidated is true
         and constraint_info.condeferrable is false
         and constraint_info.condeferred is false
     )
     or not exists (
       select 1
       from pg_catalog.pg_constraint as constraint_info
       where constraint_info.conrelid = v_events_oid
         and constraint_info.conname = 'verified_order_void_events_order_fkey'
         and constraint_info.contype = 'f'
         and constraint_info.confrelid = v_orders_oid
         and constraint_info.conkey = array[
           (
             select column_info.attnum
             from pg_catalog.pg_attribute as column_info
             where column_info.attrelid = v_events_oid
               and column_info.attname = 'order_id'
           )
         ]::smallint[]
         and constraint_info.confkey = array[
           (
             select column_info.attnum
             from pg_catalog.pg_attribute as column_info
             where column_info.attrelid = v_orders_oid
               and column_info.attname = 'id'
           )
         ]::smallint[]
         and constraint_info.confmatchtype = 's'
         and constraint_info.confupdtype = 'a'
         and constraint_info.confdeltype = 'r'
         and constraint_info.convalidated is true
         and constraint_info.condeferrable is false
         and constraint_info.condeferred is false
     )
     or (
       select pg_catalog.count(*)
       from pg_catalog.pg_constraint as actual_check
       join pg_catalog.pg_constraint as expected_check
         on expected_check.conrelid = v_expected_checks_oid
        and expected_check.conname = actual_check.conname
        and expected_check.contype = 'c'
       where actual_check.conrelid = v_events_oid
         and actual_check.contype = 'c'
         and actual_check.convalidated is true
         and actual_check.condeferrable is false
         and actual_check.condeferred is false
         and actual_check.connoinherit is false
         and pg_catalog.pg_get_expr(
           actual_check.conbin,
           actual_check.conrelid
         ) = pg_catalog.pg_get_expr(
           expected_check.conbin,
           expected_check.conrelid
         )
     ) <> 3
     or (
       select pg_catalog.count(*)
       from pg_catalog.pg_index as index_info
       where index_info.indrelid = v_events_oid
     ) <> 2
     or not exists (
       select 1
       from pg_catalog.pg_index as index_info
       join pg_catalog.pg_class as index_relation
         on index_relation.oid = index_info.indexrelid
       join pg_catalog.pg_class as table_relation
         on table_relation.oid = index_info.indrelid
       join pg_catalog.pg_am as access_method
         on access_method.oid = index_relation.relam
       where index_info.indrelid = v_events_oid
         and index_relation.relname = 'verified_order_void_events_pkey'
         and index_relation.relkind = 'i'
         and index_relation.relowner = table_relation.relowner
         and access_method.amname = 'btree'
         and index_info.indisprimary is true
         and index_info.indisunique is true
         and index_info.indisexclusion is false
         and index_info.indimmediate is true
         and index_info.indisvalid is true
         and index_info.indisready is true
         and index_info.indislive is true
         and index_info.indnkeyatts = 2
         and index_info.indnatts = 2
         and index_info.indexprs is null
         and index_info.indpred is null
         and pg_catalog.pg_get_indexdef(index_info.indexrelid, 1, true) = 'source'
         and pg_catalog.pg_get_indexdef(index_info.indexrelid, 2, true) = 'idempotency_key'
     )
     or not exists (
       select 1
       from pg_catalog.pg_index as index_info
       join pg_catalog.pg_class as index_relation
         on index_relation.oid = index_info.indexrelid
       join pg_catalog.pg_class as table_relation
         on table_relation.oid = index_info.indrelid
       join pg_catalog.pg_am as access_method
         on access_method.oid = index_relation.relam
       where index_info.indrelid = v_events_oid
         and index_relation.relname = 'verified_order_void_events_order_idx'
         and index_relation.relkind = 'i'
         and index_relation.relowner = table_relation.relowner
         and access_method.amname = 'btree'
         and index_info.indisprimary is false
         and index_info.indisunique is false
         and index_info.indisexclusion is false
         and index_info.indisvalid is true
         and index_info.indisready is true
         and index_info.indislive is true
         and index_info.indnkeyatts = 2
         and index_info.indnatts = 2
         and index_info.indexprs is null
         and index_info.indpred is null
         and pg_catalog.pg_get_indexdef(index_info.indexrelid, 1, true) = 'order_id'
         and pg_catalog.pg_get_indexdef(index_info.indexrelid, 2, true) = 'last_seen_at'
         and pg_catalog.pg_index_column_has_property(
           index_info.indexrelid,
           2,
           'desc'
         ) is true
         and pg_catalog.pg_index_column_has_property(
           index_info.indexrelid,
           2,
           'nulls_first'
         ) is true
     ) then
    raise exception using
      errcode = '55000',
      message = '030 assertion failed: verified void audit shape is incomplete';
  end if;

  if pg_catalog.has_table_privilege(
       'anon',
       'public.verified_order_void_events',
       'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
     ) or pg_catalog.has_table_privilege(
       'authenticated',
       'public.verified_order_void_events',
       'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
     ) or pg_catalog.has_table_privilege(
       'service_role',
       'public.verified_order_void_events',
       'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
     ) or exists (
       select 1
       from pg_catalog.pg_class as table_acl
       cross join lateral pg_catalog.aclexplode(
         coalesce(
           table_acl.relacl,
           pg_catalog.acldefault('r', table_acl.relowner)
         )
       ) as privilege_info
       where table_acl.oid = v_events_oid
         and privilege_info.grantee = 0
     ) then
    raise exception using
      errcode = '42501',
      message = '030 assertion failed: verified void audit is directly accessible';
  end if;

  select function_info.oid
  into v_void_rpc_oid
  from pg_catalog.pg_proc as function_info
  join pg_catalog.pg_language as language_info
    on language_info.oid = function_info.prolang
  where function_info.oid = pg_catalog.to_regprocedure(
      'public.hc_apply_verified_order_void(uuid,text,text,bigint,bigint,bigint,text,text)'
    )
    and function_info.pronargs = 8
    and function_info.pronargdefaults = 1
    and function_info.proargnames = array[
      'p_order_id',
      'p_external_invoice_id',
      'p_expected_stage',
      'p_expected_total_cents',
      'p_expected_deposit_cents',
      'p_expected_balance_cents',
      'p_idempotency_key',
      'p_source',
      'order_id',
      'stage',
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
    and function_info.proowner = (
      select payment_function.proowner
      from pg_catalog.pg_proc as payment_function
      where payment_function.oid = pg_catalog.to_regprocedure(
        'public.hc_apply_verified_order_payment(uuid,text,bigint,bigint,text,bigint,bigint,bigint,text,text)'
      )
    )
    and pg_catalog.pg_get_function_result(function_info.oid) =
      'TABLE(order_id uuid, stage text, event_inserted boolean)'
    and exists (
      select 1
      from pg_catalog.unnest(function_info.proconfig) as setting(value)
      where setting.value ~ '^search_path=(|"")$'
    );

  if v_void_rpc_oid is null
     or (
       select pg_catalog.count(*)
       from pg_catalog.pg_proc as function_info
       join pg_catalog.pg_namespace as namespace_info
         on namespace_info.oid = function_info.pronamespace
       where namespace_info.nspname = 'public'
         and function_info.proname = 'hc_apply_verified_order_void'
     ) <> 1
     or pg_catalog.obj_description(v_void_rpc_oid, 'pg_proc') is distinct from
       'Migration 030 RPC: compare and cancel one exact order after a verified QuickBooks void.'
     or pg_catalog.has_function_privilege(
       'anon',
       'public.hc_apply_verified_order_void(uuid,text,text,bigint,bigint,bigint,text,text)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.hc_apply_verified_order_void(uuid,text,text,bigint,bigint,bigint,text,text)',
       'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.hc_apply_verified_order_void(uuid,text,text,bigint,bigint,bigint,text,text)',
       'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'supabase_admin',
       'public.hc_apply_verified_order_void(uuid,text,text,bigint,bigint,bigint,text,text)',
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
       where function_acl.oid = v_void_rpc_oid
         and privilege_info.grantee = 0
         and privilege_info.privilege_type = 'EXECUTE'
     ) then
    raise exception using
      errcode = '42501',
      message = '030 assertion failed: verified void RPC shape or grants are unsafe';
  end if;
end
$void_postflight$;

do $rpc_postflight$
declare
  v_events_oid oid;
  v_expected_checks_oid oid;
  v_orders_oid oid := 'public.orders'::pg_catalog.regclass;
  v_rpc_oid oid;
begin
  select relation_info.oid
  into v_events_oid
  from pg_catalog.pg_class as relation_info
  join pg_catalog.pg_namespace as namespace_info
    on namespace_info.oid = relation_info.relnamespace
  where namespace_info.nspname = 'public'
    and relation_info.relname = 'verified_order_payment_events'
    and relation_info.relkind = 'r'
    and relation_info.relrowsecurity is true
    and relation_info.relforcerowsecurity is false;

  v_expected_checks_oid := 'pg_temp.hc_030_expected_payment_checks'::pg_catalog.regclass;

  if v_events_oid is null
     or pg_catalog.obj_description(v_events_oid, 'pg_class') is distinct from
       'Private idempotency and reconciliation audit for verified QuickBooks payment events.'
     or (
       select pg_catalog.count(*)
       from pg_catalog.pg_attribute as column_info
       where column_info.attrelid = v_events_oid
         and column_info.attnum > 0
         and column_info.attisdropped is false
     ) <> 11
     or (
       select pg_catalog.count(*)
       from pg_catalog.pg_attribute as column_info
       join (
         values
           ('source', 'pg_catalog.text'::pg_catalog.regtype::oid, true),
           ('idempotency_key', 'pg_catalog.text'::pg_catalog.regtype::oid, true),
           ('order_id', 'pg_catalog.uuid'::pg_catalog.regtype::oid, true),
           ('external_invoice_id', 'pg_catalog.text'::pg_catalog.regtype::oid, true),
           ('first_qbo_total_cents', 'pg_catalog.int8'::pg_catalog.regtype::oid, true),
           ('first_qbo_balance_cents', 'pg_catalog.int8'::pg_catalog.regtype::oid, true),
            ('last_qbo_total_cents', 'pg_catalog.int8'::pg_catalog.regtype::oid, true),
            ('last_qbo_balance_cents', 'pg_catalog.int8'::pg_catalog.regtype::oid, true),
            ('max_qbo_received_cents', 'pg_catalog.int8'::pg_catalog.regtype::oid, true),
            ('first_seen_at', 'pg_catalog.timestamptz'::pg_catalog.regtype::oid, true),
            ('last_seen_at', 'pg_catalog.timestamptz'::pg_catalog.regtype::oid, true)
       ) as expected(column_name, type_oid, not_null)
         on expected.column_name = column_info.attname
        and expected.type_oid = column_info.atttypid
        and expected.not_null = column_info.attnotnull
       where column_info.attrelid = v_events_oid
         and column_info.atttypmod = -1
         and column_info.attnum > 0
         and column_info.attisdropped is false
     ) <> 11
     or (
       select pg_catalog.count(*)
       from pg_catalog.pg_attrdef as default_info
       join pg_catalog.pg_attribute as column_info
         on column_info.attrelid = default_info.adrelid
        and column_info.attnum = default_info.adnum
       where default_info.adrelid = v_events_oid
         and column_info.attname in ('first_seen_at', 'last_seen_at')
         and pg_catalog.pg_get_expr(
           default_info.adbin,
           default_info.adrelid
         ) = 'clock_timestamp()'
     ) <> 2
     or (
       select pg_catalog.count(*)
       from pg_catalog.pg_attrdef as default_info
       where default_info.adrelid = v_events_oid
     ) <> 2
     or (
       select pg_catalog.count(*)
       from pg_catalog.pg_constraint as constraint_info
       where constraint_info.conrelid = v_events_oid
     ) <> 8
     or not exists (
       select 1
       from pg_catalog.pg_constraint as constraint_info
       where constraint_info.conrelid = v_events_oid
         and constraint_info.conname = 'verified_order_payment_events_pkey'
         and constraint_info.contype = 'p'
         and constraint_info.conindid = pg_catalog.to_regclass(
           'public.verified_order_payment_events_pkey'
         )
         and constraint_info.conkey = array[
           (
             select column_info.attnum
             from pg_catalog.pg_attribute as column_info
             where column_info.attrelid = v_events_oid
               and column_info.attname = 'source'
           ),
           (
             select column_info.attnum
             from pg_catalog.pg_attribute as column_info
             where column_info.attrelid = v_events_oid
               and column_info.attname = 'idempotency_key'
           )
         ]::smallint[]
         and constraint_info.convalidated is true
         and constraint_info.condeferrable is false
         and constraint_info.condeferred is false
     )
     or not exists (
       select 1
       from pg_catalog.pg_constraint as constraint_info
       where constraint_info.conrelid = v_events_oid
         and constraint_info.conname = 'verified_order_payment_events_order_fkey'
         and constraint_info.contype = 'f'
         and constraint_info.confrelid = v_orders_oid
         and constraint_info.conkey = array[
           (
             select column_info.attnum
             from pg_catalog.pg_attribute as column_info
             where column_info.attrelid = v_events_oid
               and column_info.attname = 'order_id'
           )
         ]::smallint[]
         and constraint_info.confkey = array[
           (
             select column_info.attnum
             from pg_catalog.pg_attribute as column_info
             where column_info.attrelid = v_orders_oid
               and column_info.attname = 'id'
           )
         ]::smallint[]
         and constraint_info.confmatchtype = 's'
         and constraint_info.confupdtype = 'a'
         and constraint_info.confdeltype = 'r'
         and constraint_info.convalidated is true
         and constraint_info.condeferrable is false
         and constraint_info.condeferred is false
     )
     or (
       select pg_catalog.count(*)
       from pg_catalog.pg_constraint as actual_check
       join pg_catalog.pg_constraint as expected_check
         on expected_check.conrelid = v_expected_checks_oid
        and expected_check.conname = actual_check.conname
        and expected_check.contype = 'c'
       where actual_check.conrelid = v_events_oid
         and actual_check.contype = 'c'
         and actual_check.convalidated is true
         and actual_check.condeferrable is false
         and actual_check.condeferred is false
         and actual_check.connoinherit is false
         and pg_catalog.pg_get_expr(
           actual_check.conbin,
           actual_check.conrelid
         ) = pg_catalog.pg_get_expr(
           expected_check.conbin,
           expected_check.conrelid
         )
     ) <> 6
     or (
       select pg_catalog.count(*)
       from pg_catalog.pg_index as index_info
       where index_info.indrelid = v_events_oid
     ) <> 2
     or not exists (
       select 1
       from pg_catalog.pg_index as index_info
       join pg_catalog.pg_class as index_relation
         on index_relation.oid = index_info.indexrelid
       join pg_catalog.pg_class as table_relation
         on table_relation.oid = index_info.indrelid
       join pg_catalog.pg_am as access_method
         on access_method.oid = index_relation.relam
       where index_info.indrelid = v_events_oid
         and index_relation.relname = 'verified_order_payment_events_pkey'
         and index_relation.relkind = 'i'
         and index_relation.relowner = table_relation.relowner
         and access_method.amname = 'btree'
         and index_info.indisprimary is true
         and index_info.indisunique is true
         and index_info.indisexclusion is false
         and index_info.indimmediate is true
         and index_info.indisvalid is true
         and index_info.indisready is true
         and index_info.indislive is true
         and index_info.indnkeyatts = 2
         and index_info.indnatts = 2
         and index_info.indexprs is null
         and index_info.indpred is null
         and pg_catalog.pg_get_indexdef(index_info.indexrelid, 1, true) = 'source'
         and pg_catalog.pg_get_indexdef(index_info.indexrelid, 2, true) = 'idempotency_key'
     )
     or not exists (
       select 1
       from pg_catalog.pg_index as index_info
       join pg_catalog.pg_class as index_relation
         on index_relation.oid = index_info.indexrelid
       join pg_catalog.pg_class as table_relation
         on table_relation.oid = index_info.indrelid
       join pg_catalog.pg_am as access_method
         on access_method.oid = index_relation.relam
       where index_info.indrelid = v_events_oid
         and index_relation.relname = 'verified_order_payment_events_order_idx'
         and index_relation.relkind = 'i'
         and index_relation.relowner = table_relation.relowner
         and access_method.amname = 'btree'
         and index_info.indisprimary is false
         and index_info.indisunique is false
         and index_info.indisexclusion is false
         and index_info.indisvalid is true
         and index_info.indisready is true
         and index_info.indislive is true
         and index_info.indnkeyatts = 2
         and index_info.indnatts = 2
         and index_info.indexprs is null
         and index_info.indpred is null
         and pg_catalog.pg_get_indexdef(index_info.indexrelid, 1, true) = 'order_id'
         and pg_catalog.pg_get_indexdef(index_info.indexrelid, 2, true) = 'last_seen_at'
         and pg_catalog.pg_index_column_has_property(
           index_info.indexrelid,
           2,
           'desc'
         ) is true
         and pg_catalog.pg_index_column_has_property(
           index_info.indexrelid,
           2,
           'nulls_first'
         ) is true
     ) then
    raise exception using
      errcode = '55000',
      message = '030 assertion failed: verified payment audit shape is incomplete';
  end if;

  if pg_catalog.has_table_privilege(
       'anon',
       'public.verified_order_payment_events',
       'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
     ) or pg_catalog.has_table_privilege(
       'authenticated',
       'public.verified_order_payment_events',
       'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
     ) or pg_catalog.has_table_privilege(
       'service_role',
       'public.verified_order_payment_events',
       'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
     ) or exists (
       select 1
       from pg_catalog.pg_class as table_acl
       cross join lateral pg_catalog.aclexplode(
         coalesce(
           table_acl.relacl,
           pg_catalog.acldefault('r', table_acl.relowner)
         )
       ) as privilege_info
       where table_acl.oid = v_events_oid
         and privilege_info.grantee = 0
     ) then
    raise exception using
      errcode = '42501',
      message = '030 assertion failed: verified payment audit is directly accessible';
  end if;

  select function_info.oid
  into v_rpc_oid
  from pg_catalog.pg_proc as function_info
  join pg_catalog.pg_language as language_info
    on language_info.oid = function_info.prolang
  where function_info.oid = pg_catalog.to_regprocedure(
      'public.hc_apply_verified_order_payment(uuid,text,bigint,bigint,text,bigint,bigint,bigint,text,text)'
    )
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
    and exists (
      select 1
      from pg_catalog.unnest(function_info.proconfig) as setting(value)
      where setting.value ~ '^search_path=(|"")$'
    );

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
       'Migration 030 RPC: compare and reconcile one exact order from cumulative QuickBooks invoice truth.'
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
         and privilege_info.grantee = 0
         and privilege_info.privilege_type = 'EXECUTE'
     ) then
    raise exception using
      errcode = '42501',
      message = '030 assertion failed: verified payment RPC shape or grants are unsafe';
  end if;
end
$rpc_postflight$;

do $transition_helper_postflight$
declare
  v_helper_oid oid;
  v_payment_rpc_oid oid;
begin
  v_payment_rpc_oid := pg_catalog.to_regprocedure(
    'public.hc_apply_verified_order_payment(uuid,text,bigint,bigint,text,bigint,bigint,bigint,text,text)'
  );

  select function_info.oid
  into v_helper_oid
  from pg_catalog.pg_proc as function_info
  join pg_catalog.pg_namespace as namespace_info
    on namespace_info.oid = function_info.pronamespace
  join pg_catalog.pg_language as language_info
    on language_info.oid = function_info.prolang
  where function_info.oid = pg_catalog.to_regprocedure(
      'public.hc_can_apply_direct_order_stage_transition(uuid,text,text,bigint,bigint)'
    )
    and namespace_info.nspname = 'public'
    and function_info.pronargs = 5
    and function_info.pronargdefaults = 0
    and function_info.proargnames = array[
      'p_order_id',
      'p_old_stage',
      'p_new_stage',
      'p_deposit_cents',
      'p_balance_cents'
    ]::text[]
    and function_info.prorettype = 'pg_catalog.bool'::pg_catalog.regtype
    and function_info.prosecdef is true
    and function_info.prokind = 'f'
    and function_info.provolatile = 'v'
    and language_info.lanname = 'plpgsql'
    and pg_catalog.pg_get_userbyid(function_info.proowner) in (
      'postgres', 'supabase_admin'
    )
    and function_info.proowner = (
      select payment_function.proowner
      from pg_catalog.pg_proc as payment_function
      where payment_function.oid = v_payment_rpc_oid
    )
    and pg_catalog.pg_get_function_result(function_info.oid) = 'boolean'
    and exists (
      select 1
      from pg_catalog.unnest(function_info.proconfig) as setting(value)
      where setting.value ~ '^search_path=(|"")$'
    );

  if v_helper_oid is null
     or (
       select pg_catalog.count(*)
       from pg_catalog.pg_proc as function_info
       join pg_catalog.pg_namespace as namespace_info
         on namespace_info.oid = function_info.pronamespace
       where namespace_info.nspname = 'public'
         and function_info.proname = 'hc_can_apply_direct_order_stage_transition'
     ) <> 1
     or pg_catalog.obj_description(v_helper_oid, 'pg_proc') is distinct from
       'Migration 030 helper: allow one visible direct stage transition without exposing private payment provenance.'
     or pg_catalog.has_function_privilege(
       'anon',
       'public.hc_can_apply_direct_order_stage_transition(uuid,text,text,bigint,bigint)',
       'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'authenticated',
       'public.hc_can_apply_direct_order_stage_transition(uuid,text,text,bigint,bigint)',
       'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.hc_can_apply_direct_order_stage_transition(uuid,text,text,bigint,bigint)',
       'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'supabase_admin',
       'public.hc_can_apply_direct_order_stage_transition(uuid,text,text,bigint,bigint)',
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
       left join pg_catalog.pg_roles as granted_role
         on granted_role.oid = privilege_info.grantee
       where function_acl.oid = v_helper_oid
         and privilege_info.privilege_type = 'EXECUTE'
         and (
           privilege_info.grantee = 0
           or (
             privilege_info.grantee <> function_acl.proowner
             and granted_role.rolname not in (
               'authenticated', 'service_role', 'supabase_admin'
             )
           )
         )
     ) then
    raise exception using
      errcode = '42501',
      message = '030 assertion failed: payment provenance helper shape or grants are unsafe';
  end if;
end
$transition_helper_postflight$;

do $postflight$
declare
  v_guard_oid oid;
  v_update_columns text[];
begin
  select function_info.oid
  into v_guard_oid
  from pg_catalog.pg_proc as function_info
  join pg_catalog.pg_namespace as namespace_info
    on namespace_info.oid = function_info.pronamespace
  join pg_catalog.pg_language as language_info
    on language_info.oid = function_info.prolang
  where namespace_info.nspname = 'public'
    and function_info.proname = 'hc_protect_order_payment_fields'
    and function_info.pronargs = 0
    and function_info.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
    and function_info.prokind = 'f'
    and function_info.prosecdef is false
    and language_info.lanname = 'plpgsql'
    and exists (
      select 1
      from pg_catalog.unnest(function_info.proconfig) as setting(value)
      where setting.value ~ '^search_path=(|"")$'
    );

  if v_guard_oid is null
     or (
       select pg_catalog.count(*)
       from pg_catalog.pg_proc as function_info
       join pg_catalog.pg_namespace as namespace_info
         on namespace_info.oid = function_info.pronamespace
       where namespace_info.nspname = 'public'
         and function_info.proname = 'hc_protect_order_payment_fields'
     ) <> 1
     or pg_catalog.obj_description(v_guard_oid, 'pg_proc') is distinct from
       'Migration 030 trigger: direct order payment writes are blocked outside the verified RPC.' then
    raise exception using
      errcode = '55000',
      message = '030 assertion failed: payment guard function shape is incorrect';
  end if;

  if pg_catalog.has_function_privilege(
       'anon',
       'public.hc_protect_order_payment_fields()',
       'EXECUTE'
     ) or pg_catalog.has_function_privilege(
       'authenticated',
       'public.hc_protect_order_payment_fields()',
       'EXECUTE'
     ) or pg_catalog.has_function_privilege(
       'service_role',
       'public.hc_protect_order_payment_fields()',
       'EXECUTE'
     ) or exists (
       select 1
       from pg_catalog.pg_proc as function_acl
       cross join lateral pg_catalog.aclexplode(
         coalesce(
           function_acl.proacl,
           pg_catalog.acldefault('f', function_acl.proowner)
         )
       ) as privilege_info
       where function_acl.oid = v_guard_oid
         and privilege_info.grantee = 0
         and privilege_info.privilege_type = 'EXECUTE'
     ) then
    raise exception using
      errcode = '42501',
      message = '030 assertion failed: payment guard function is callable';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_trigger as trigger_info
    where trigger_info.tgrelid = 'public.orders'::pg_catalog.regclass
      and trigger_info.tgname = 'orders_payment_integrity_insert'
      and trigger_info.tgenabled = 'O'
      and trigger_info.tgisinternal is false
      and trigger_info.tgconstraint = 0
      and trigger_info.tgfoid = v_guard_oid
      and trigger_info.tgtype = 7
      and pg_catalog.cardinality(trigger_info.tgattr::smallint[]) = 0
      and pg_catalog.octet_length(trigger_info.tgargs) = 0
      and pg_catalog.obj_description(
        trigger_info.oid,
        'pg_trigger'
      ) = 'Migration 030: blocks untrusted payment state on new orders.'
  ) then
    raise exception using
      errcode = '55000',
      message = '030 assertion failed: insert payment guard is incorrect';
  end if;

  select pg_catalog.array_agg(
           column_info.attname
           order by column_info.attname
         )
  into v_update_columns
  from pg_catalog.pg_trigger as trigger_info
  cross join lateral pg_catalog.unnest(
    trigger_info.tgattr::smallint[]
  ) as protected_column(attnum)
  join pg_catalog.pg_attribute as column_info
    on column_info.attrelid = trigger_info.tgrelid
   and column_info.attnum = protected_column.attnum
  where trigger_info.tgrelid = 'public.orders'::pg_catalog.regclass
    and trigger_info.tgname = 'orders_payment_integrity_update';

  if not exists (
    select 1
    from pg_catalog.pg_trigger as trigger_info
    where trigger_info.tgrelid = 'public.orders'::pg_catalog.regclass
      and trigger_info.tgname = 'orders_payment_integrity_update'
      and trigger_info.tgenabled = 'O'
      and trigger_info.tgisinternal is false
      and trigger_info.tgconstraint = 0
      and trigger_info.tgfoid = v_guard_oid
      and trigger_info.tgtype = 19
      and pg_catalog.cardinality(trigger_info.tgattr::smallint[]) = 3
      and pg_catalog.octet_length(trigger_info.tgargs) = 0
      and pg_catalog.obj_description(
        trigger_info.oid,
        'pg_trigger'
      ) = 'Migration 030: protects verified order payment fields and stages.'
  ) or v_update_columns is distinct from
       array['balance_cents', 'deposit_cents', 'stage']::text[] then
    raise exception using
      errcode = '55000',
      message = '030 assertion failed: update payment guard is incorrect';
  end if;

  if (
    select pg_catalog.count(*)
    from pg_catalog.pg_trigger as trigger_info
    where trigger_info.tgrelid = 'public.orders'::pg_catalog.regclass
      and trigger_info.tgfoid = v_guard_oid
      and trigger_info.tgisinternal is false
  ) <> 2 or exists (
    select 1
    from pg_catalog.pg_trigger as trigger_info
    where trigger_info.tgrelid = 'public.orders'::pg_catalog.regclass
      and trigger_info.tgname = 'orders_payment_integrity'
  ) then
    raise exception using
      errcode = '55000',
      message = '030 assertion failed: payment guard trigger set is incomplete';
  end if;
end
$postflight$;

-- Simulate the forward COMMIT dropping its temporary validation tables.
drop table pg_temp.hc_030_expected_payment_checks;
drop table pg_temp.hc_030_expected_void_checks;

-- Exact reviewed rollback migration body.
-- ============================================================================
-- 030_order_payment_integrity_rollback.sql
-- Remove only the exact order payment guard installed by migration 030.
--
-- This changes no order data. It deliberately refuses partial, missing, or
-- drifted objects. It also refuses to delete a nonempty payment audit ledger.
-- ============================================================================


set local lock_timeout = '10s';
set local statement_timeout = '60s';

do $table_preflight$
declare
  v_orders_oid oid;
  v_events_oid oid;
  v_void_events_oid oid;
begin
  select relation_info.oid
  into v_orders_oid
  from pg_catalog.pg_class as relation_info
  join pg_catalog.pg_namespace as namespace_info
    on namespace_info.oid = relation_info.relnamespace
  where namespace_info.nspname = 'public'
    and relation_info.relname = 'orders'
    and relation_info.relkind = 'r';

  if v_orders_oid is null then
    raise exception using
      errcode = '55000',
      message = '030 rollback requires public.orders to be an ordinary table';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_attribute as column_info
    where column_info.attrelid = v_orders_oid
      and column_info.attname = 'market'
      and column_info.atttypid = 'pg_catalog.text'::pg_catalog.regtype
      and column_info.atttypmod = -1
      and column_info.attnum > 0
      and column_info.attisdropped is false
  ) or not exists (
    select 1
    from pg_catalog.pg_attribute as column_info
    where column_info.attrelid = v_orders_oid
      and column_info.attname = 'stage'
      and column_info.atttypid = 'pg_catalog.text'::pg_catalog.regtype
      and column_info.atttypmod = -1
      and column_info.attnotnull is true
      and column_info.attnum > 0
      and column_info.attisdropped is false
  ) or not exists (
    select 1
    from pg_catalog.pg_attribute as column_info
    where column_info.attrelid = v_orders_oid
      and column_info.attname = 'total_cents'
      and column_info.atttypid = 'pg_catalog.int8'::pg_catalog.regtype
      and column_info.atttypmod = -1
      and column_info.attnotnull is false
      and column_info.attnum > 0
      and column_info.attisdropped is false
  ) or not exists (
    select 1
    from pg_catalog.pg_attribute as column_info
    where column_info.attrelid = v_orders_oid
      and column_info.attname = 'deposit_cents'
      and column_info.atttypid = 'pg_catalog.int8'::pg_catalog.regtype
      and column_info.atttypmod = -1
      and column_info.attnotnull is true
      and column_info.attnum > 0
      and column_info.attisdropped is false
  ) or not exists (
    select 1
    from pg_catalog.pg_attribute as column_info
    where column_info.attrelid = v_orders_oid
      and column_info.attname = 'balance_cents'
      and column_info.atttypid = 'pg_catalog.int8'::pg_catalog.regtype
      and column_info.atttypmod = -1
      and column_info.attnotnull is false
      and column_info.attnum > 0
      and column_info.attisdropped is false
  ) then
    raise exception using
      errcode = '55000',
      message = '030 rollback found an unexpected orders payment schema';
  end if;

  if (
    select pg_catalog.count(*)
    from pg_catalog.pg_roles as role_info
    where role_info.rolname in (
      'anon', 'authenticated', 'service_role', 'postgres', 'supabase_admin'
    )
  ) <> 5 then
    raise exception using
      errcode = '55000',
      message = '030 rollback requires the Supabase API roles';
  end if;

  select relation_info.oid
  into v_events_oid
  from pg_catalog.pg_class as relation_info
  join pg_catalog.pg_namespace as namespace_info
    on namespace_info.oid = relation_info.relnamespace
  where namespace_info.nspname = 'public'
    and relation_info.relname = 'verified_order_payment_events'
    and relation_info.relkind = 'r'
    and relation_info.relrowsecurity is true
    and relation_info.relforcerowsecurity is false;

  if v_events_oid is null then
    raise exception using
      errcode = '55000',
      message = '030 rollback requires the private verified payment audit';
  end if;

  select relation_info.oid
  into v_void_events_oid
  from pg_catalog.pg_class as relation_info
  join pg_catalog.pg_namespace as namespace_info
    on namespace_info.oid = relation_info.relnamespace
  where namespace_info.nspname = 'public'
    and relation_info.relname = 'verified_order_void_events'
    and relation_info.relkind = 'r'
    and relation_info.relrowsecurity is true
    and relation_info.relforcerowsecurity is false;

  if v_void_events_oid is null then
    raise exception using
      errcode = '55000',
      message = '030 rollback requires the private verified void audit';
  end if;
end
$table_preflight$;

lock table public.orders in share row exclusive mode;
lock table public.verified_order_payment_events in access exclusive mode;
lock table public.verified_order_void_events in access exclusive mode;

create temporary table hc_030_expected_payment_checks (
  source text,
  idempotency_key text,
  external_invoice_id text,
  first_qbo_total_cents bigint,
  first_qbo_balance_cents bigint,
  last_qbo_total_cents bigint,
  last_qbo_balance_cents bigint,
  max_qbo_received_cents bigint,
  constraint verified_order_payment_events_source_check
    check (source in ('quickbooks', 'quickbooks_reconciliation')),
  constraint verified_order_payment_events_key_check
    check (
      pg_catalog.length(idempotency_key) between 1 and 200
      and idempotency_key = pg_catalog.btrim(idempotency_key)
      and idempotency_key !~ '[[:cntrl:]]'
    ),
  constraint verified_order_payment_events_invoice_check
    check (
      pg_catalog.length(external_invoice_id) between 1 and 200
      and external_invoice_id = pg_catalog.btrim(external_invoice_id)
      and external_invoice_id !~ '[[:cntrl:]]'
    ),
  constraint verified_order_payment_events_first_snapshot_check
    check (
      first_qbo_total_cents between 0 and 1000000000000
      and first_qbo_balance_cents between 0 and first_qbo_total_cents
    ),
  constraint verified_order_payment_events_last_snapshot_check
    check (
      last_qbo_total_cents between 0 and 1000000000000
      and last_qbo_balance_cents between 0 and last_qbo_total_cents
    ),
  constraint verified_order_payment_events_max_received_check
    check (
      max_qbo_received_cents between 0 and 1000000000000
    )
) on commit drop;

create temporary table hc_030_expected_void_checks (
  source text,
  idempotency_key text,
  external_invoice_id text,
  constraint verified_order_void_events_source_check
    check (source in ('quickbooks', 'quickbooks_reconciliation')),
  constraint verified_order_void_events_key_check
    check (
      pg_catalog.length(idempotency_key) between 1 and 200
      and idempotency_key = pg_catalog.btrim(idempotency_key)
      and idempotency_key !~ '[[:cntrl:]]'
    ),
  constraint verified_order_void_events_invoice_check
    check (
      pg_catalog.length(external_invoice_id) between 1 and 200
      and external_invoice_id = pg_catalog.btrim(external_invoice_id)
      and external_invoice_id !~ '[[:cntrl:]]'
    )
) on commit drop;

do $object_preflight$
declare
  v_events_oid oid;
  v_expected_payment_checks_oid oid;
  v_expected_void_checks_oid oid;
  v_guard_oid oid;
  v_helper_oid oid;
  v_orders_oid oid := 'public.orders'::pg_catalog.regclass;
  v_rpc_oid oid;
  v_void_events_oid oid;
  v_void_rpc_oid oid;
  v_update_columns text[];
begin
  v_events_oid := 'public.verified_order_payment_events'::pg_catalog.regclass;
  v_void_events_oid := 'public.verified_order_void_events'::pg_catalog.regclass;
  v_expected_payment_checks_oid :=
    'pg_temp.hc_030_expected_payment_checks'::pg_catalog.regclass;
  v_expected_void_checks_oid :=
    'pg_temp.hc_030_expected_void_checks'::pg_catalog.regclass;

  if pg_catalog.obj_description(v_events_oid, 'pg_class') is distinct from
       'Private idempotency and reconciliation audit for verified QuickBooks payment events.'
     or (
       select pg_catalog.count(*)
       from pg_catalog.pg_attribute as column_info
       where column_info.attrelid = v_events_oid
         and column_info.attnum > 0
         and column_info.attisdropped is false
     ) <> 11
     or (
       select pg_catalog.count(*)
       from pg_catalog.pg_attribute as column_info
       join (
         values
           ('source', 'pg_catalog.text'::pg_catalog.regtype::oid, true),
           ('idempotency_key', 'pg_catalog.text'::pg_catalog.regtype::oid, true),
           ('order_id', 'pg_catalog.uuid'::pg_catalog.regtype::oid, true),
           ('external_invoice_id', 'pg_catalog.text'::pg_catalog.regtype::oid, true),
           ('first_qbo_total_cents', 'pg_catalog.int8'::pg_catalog.regtype::oid, true),
           ('first_qbo_balance_cents', 'pg_catalog.int8'::pg_catalog.regtype::oid, true),
            ('last_qbo_total_cents', 'pg_catalog.int8'::pg_catalog.regtype::oid, true),
            ('last_qbo_balance_cents', 'pg_catalog.int8'::pg_catalog.regtype::oid, true),
            ('max_qbo_received_cents', 'pg_catalog.int8'::pg_catalog.regtype::oid, true),
            ('first_seen_at', 'pg_catalog.timestamptz'::pg_catalog.regtype::oid, true),
            ('last_seen_at', 'pg_catalog.timestamptz'::pg_catalog.regtype::oid, true)
       ) as expected(column_name, type_oid, not_null)
         on expected.column_name = column_info.attname
        and expected.type_oid = column_info.atttypid
        and expected.not_null = column_info.attnotnull
       where column_info.attrelid = v_events_oid
         and column_info.atttypmod = -1
         and column_info.attnum > 0
         and column_info.attisdropped is false
     ) <> 11
     or (
       select pg_catalog.count(*)
       from pg_catalog.pg_attrdef as default_info
       join pg_catalog.pg_attribute as column_info
         on column_info.attrelid = default_info.adrelid
        and column_info.attnum = default_info.adnum
       where default_info.adrelid = v_events_oid
         and column_info.attname in ('first_seen_at', 'last_seen_at')
         and pg_catalog.pg_get_expr(
           default_info.adbin,
           default_info.adrelid
         ) = 'clock_timestamp()'
     ) <> 2
     or (
       select pg_catalog.count(*)
       from pg_catalog.pg_attrdef as default_info
       where default_info.adrelid = v_events_oid
     ) <> 2
     or (
       select pg_catalog.count(*)
       from pg_catalog.pg_constraint as constraint_info
       where constraint_info.conrelid = v_events_oid
     ) <> 8
     or not exists (
       select 1
       from pg_catalog.pg_constraint as constraint_info
       where constraint_info.conrelid = v_events_oid
         and constraint_info.conname = 'verified_order_payment_events_pkey'
         and constraint_info.contype = 'p'
         and constraint_info.conindid = pg_catalog.to_regclass(
           'public.verified_order_payment_events_pkey'
         )
         and constraint_info.conkey = array[
           (
             select column_info.attnum
             from pg_catalog.pg_attribute as column_info
             where column_info.attrelid = v_events_oid
               and column_info.attname = 'source'
           ),
           (
             select column_info.attnum
             from pg_catalog.pg_attribute as column_info
             where column_info.attrelid = v_events_oid
               and column_info.attname = 'idempotency_key'
           )
         ]::smallint[]
         and constraint_info.convalidated is true
         and constraint_info.condeferrable is false
         and constraint_info.condeferred is false
     )
     or not exists (
       select 1
       from pg_catalog.pg_constraint as constraint_info
       where constraint_info.conrelid = v_events_oid
         and constraint_info.conname = 'verified_order_payment_events_order_fkey'
         and constraint_info.contype = 'f'
         and constraint_info.confrelid = v_orders_oid
         and constraint_info.conkey = array[
           (
             select column_info.attnum
             from pg_catalog.pg_attribute as column_info
             where column_info.attrelid = v_events_oid
               and column_info.attname = 'order_id'
           )
         ]::smallint[]
         and constraint_info.confkey = array[
           (
             select column_info.attnum
             from pg_catalog.pg_attribute as column_info
             where column_info.attrelid = v_orders_oid
               and column_info.attname = 'id'
           )
         ]::smallint[]
         and constraint_info.confmatchtype = 's'
         and constraint_info.confupdtype = 'a'
         and constraint_info.confdeltype = 'r'
         and constraint_info.convalidated is true
         and constraint_info.condeferrable is false
         and constraint_info.condeferred is false
     )
     or (
       select pg_catalog.count(*)
       from pg_catalog.pg_constraint as actual_check
       join pg_catalog.pg_constraint as expected_check
         on expected_check.conrelid = v_expected_payment_checks_oid
        and expected_check.conname = actual_check.conname
        and expected_check.contype = 'c'
       where actual_check.conrelid = v_events_oid
         and actual_check.contype = 'c'
         and actual_check.convalidated is true
         and actual_check.condeferrable is false
         and actual_check.condeferred is false
         and actual_check.connoinherit is false
         and pg_catalog.pg_get_expr(
           actual_check.conbin,
           actual_check.conrelid
         ) = pg_catalog.pg_get_expr(
           expected_check.conbin,
           expected_check.conrelid
         )
     ) <> 6
     or (
       select pg_catalog.count(*)
       from pg_catalog.pg_index as index_info
       where index_info.indrelid = v_events_oid
     ) <> 2
     or not exists (
       select 1
       from pg_catalog.pg_index as index_info
       join pg_catalog.pg_class as index_relation
         on index_relation.oid = index_info.indexrelid
       join pg_catalog.pg_class as table_relation
         on table_relation.oid = index_info.indrelid
       join pg_catalog.pg_am as access_method
         on access_method.oid = index_relation.relam
       where index_info.indrelid = v_events_oid
         and index_relation.relname = 'verified_order_payment_events_pkey'
         and index_relation.relkind = 'i'
         and index_relation.relowner = table_relation.relowner
         and access_method.amname = 'btree'
         and index_info.indisprimary is true
         and index_info.indisunique is true
         and index_info.indisexclusion is false
         and index_info.indimmediate is true
         and index_info.indisvalid is true
         and index_info.indisready is true
         and index_info.indislive is true
         and index_info.indnkeyatts = 2
         and index_info.indnatts = 2
         and index_info.indexprs is null
         and index_info.indpred is null
         and pg_catalog.pg_get_indexdef(index_info.indexrelid, 1, true) = 'source'
         and pg_catalog.pg_get_indexdef(index_info.indexrelid, 2, true) = 'idempotency_key'
     )
     or not exists (
       select 1
       from pg_catalog.pg_index as index_info
       join pg_catalog.pg_class as index_relation
         on index_relation.oid = index_info.indexrelid
       join pg_catalog.pg_class as table_relation
         on table_relation.oid = index_info.indrelid
       join pg_catalog.pg_am as access_method
         on access_method.oid = index_relation.relam
       where index_info.indrelid = v_events_oid
         and index_relation.relname = 'verified_order_payment_events_order_idx'
         and index_relation.relkind = 'i'
         and index_relation.relowner = table_relation.relowner
         and access_method.amname = 'btree'
         and index_info.indisprimary is false
         and index_info.indisunique is false
         and index_info.indisexclusion is false
         and index_info.indisvalid is true
         and index_info.indisready is true
         and index_info.indislive is true
         and index_info.indnkeyatts = 2
         and index_info.indnatts = 2
         and index_info.indexprs is null
         and index_info.indpred is null
         and pg_catalog.pg_get_indexdef(index_info.indexrelid, 1, true) = 'order_id'
         and pg_catalog.pg_get_indexdef(index_info.indexrelid, 2, true) = 'last_seen_at'
         and pg_catalog.pg_index_column_has_property(
           index_info.indexrelid,
           2,
           'desc'
         ) is true
         and pg_catalog.pg_index_column_has_property(
           index_info.indexrelid,
           2,
           'nulls_first'
         ) is true
     ) then
    raise exception using
      errcode = '55000',
      message = '030 rollback refused: payment audit shape drifted';
  end if;

  if pg_catalog.has_table_privilege(
       'anon',
       'public.verified_order_payment_events',
       'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
     ) or pg_catalog.has_table_privilege(
       'authenticated',
       'public.verified_order_payment_events',
       'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
     ) or pg_catalog.has_table_privilege(
       'service_role',
       'public.verified_order_payment_events',
       'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
     ) or exists (
       select 1
       from pg_catalog.pg_class as table_acl
       cross join lateral pg_catalog.aclexplode(
         coalesce(
           table_acl.relacl,
           pg_catalog.acldefault('r', table_acl.relowner)
         )
       ) as privilege_info
       where table_acl.oid = v_events_oid
         and privilege_info.grantee = 0
     ) then
    raise exception using
      errcode = '55000',
      message = '030 rollback refused: payment audit grants drifted';
  end if;

  if exists (
    select 1
    from public.verified_order_payment_events
  ) then
    raise exception using
      errcode = '55000',
      message = '030 rollback blocked: preserve recorded payment audit events with a reviewed forward migration';
  end if;

  if pg_catalog.obj_description(v_void_events_oid, 'pg_class') is distinct from
       'Private idempotency audit for verified QuickBooks invoice void events.'
     or (
       select pg_catalog.count(*)
       from pg_catalog.pg_attribute as column_info
       where column_info.attrelid = v_void_events_oid
         and column_info.attnum > 0
         and column_info.attisdropped is false
     ) <> 6
     or (
       select pg_catalog.count(*)
       from pg_catalog.pg_attribute as column_info
       join (
         values
           ('source', 'pg_catalog.text'::pg_catalog.regtype::oid, true),
           ('idempotency_key', 'pg_catalog.text'::pg_catalog.regtype::oid, true),
           ('order_id', 'pg_catalog.uuid'::pg_catalog.regtype::oid, true),
           ('external_invoice_id', 'pg_catalog.text'::pg_catalog.regtype::oid, true),
           ('first_seen_at', 'pg_catalog.timestamptz'::pg_catalog.regtype::oid, true),
           ('last_seen_at', 'pg_catalog.timestamptz'::pg_catalog.regtype::oid, true)
       ) as expected(column_name, type_oid, not_null)
         on expected.column_name = column_info.attname
        and expected.type_oid = column_info.atttypid
        and expected.not_null = column_info.attnotnull
       where column_info.attrelid = v_void_events_oid
         and column_info.atttypmod = -1
         and column_info.attnum > 0
         and column_info.attisdropped is false
     ) <> 6
     or (
       select pg_catalog.count(*)
       from pg_catalog.pg_attrdef as default_info
       join pg_catalog.pg_attribute as column_info
         on column_info.attrelid = default_info.adrelid
        and column_info.attnum = default_info.adnum
       where default_info.adrelid = v_void_events_oid
         and column_info.attname in ('first_seen_at', 'last_seen_at')
         and pg_catalog.pg_get_expr(
           default_info.adbin,
           default_info.adrelid
         ) = 'clock_timestamp()'
     ) <> 2
     or (
       select pg_catalog.count(*)
       from pg_catalog.pg_attrdef as default_info
       where default_info.adrelid = v_void_events_oid
     ) <> 2
     or (
       select pg_catalog.count(*)
       from pg_catalog.pg_constraint as constraint_info
       where constraint_info.conrelid = v_void_events_oid
     ) <> 5
     or not exists (
       select 1
       from pg_catalog.pg_constraint as constraint_info
       where constraint_info.conrelid = v_void_events_oid
         and constraint_info.conname = 'verified_order_void_events_pkey'
         and constraint_info.contype = 'p'
         and constraint_info.conindid = pg_catalog.to_regclass(
           'public.verified_order_void_events_pkey'
         )
         and constraint_info.conkey = array[
           (
             select column_info.attnum
             from pg_catalog.pg_attribute as column_info
             where column_info.attrelid = v_void_events_oid
               and column_info.attname = 'source'
           ),
           (
             select column_info.attnum
             from pg_catalog.pg_attribute as column_info
             where column_info.attrelid = v_void_events_oid
               and column_info.attname = 'idempotency_key'
           )
         ]::smallint[]
         and constraint_info.convalidated is true
         and constraint_info.condeferrable is false
         and constraint_info.condeferred is false
     )
     or not exists (
       select 1
       from pg_catalog.pg_constraint as constraint_info
       where constraint_info.conrelid = v_void_events_oid
         and constraint_info.conname = 'verified_order_void_events_order_fkey'
         and constraint_info.contype = 'f'
         and constraint_info.confrelid = v_orders_oid
         and constraint_info.conkey = array[
           (
             select column_info.attnum
             from pg_catalog.pg_attribute as column_info
             where column_info.attrelid = v_void_events_oid
               and column_info.attname = 'order_id'
           )
         ]::smallint[]
         and constraint_info.confkey = array[
           (
             select column_info.attnum
             from pg_catalog.pg_attribute as column_info
             where column_info.attrelid = v_orders_oid
               and column_info.attname = 'id'
           )
         ]::smallint[]
         and constraint_info.confmatchtype = 's'
         and constraint_info.confupdtype = 'a'
         and constraint_info.confdeltype = 'r'
         and constraint_info.convalidated is true
         and constraint_info.condeferrable is false
         and constraint_info.condeferred is false
     )
     or (
       select pg_catalog.count(*)
       from pg_catalog.pg_constraint as actual_check
       join pg_catalog.pg_constraint as expected_check
         on expected_check.conrelid = v_expected_void_checks_oid
        and expected_check.conname = actual_check.conname
        and expected_check.contype = 'c'
       where actual_check.conrelid = v_void_events_oid
         and actual_check.contype = 'c'
         and actual_check.convalidated is true
         and actual_check.condeferrable is false
         and actual_check.condeferred is false
         and actual_check.connoinherit is false
         and pg_catalog.pg_get_expr(
           actual_check.conbin,
           actual_check.conrelid
         ) = pg_catalog.pg_get_expr(
           expected_check.conbin,
           expected_check.conrelid
         )
     ) <> 3
     or (
       select pg_catalog.count(*)
       from pg_catalog.pg_index as index_info
       where index_info.indrelid = v_void_events_oid
     ) <> 2
     or not exists (
       select 1
       from pg_catalog.pg_index as index_info
       join pg_catalog.pg_class as index_relation
         on index_relation.oid = index_info.indexrelid
       join pg_catalog.pg_class as table_relation
         on table_relation.oid = index_info.indrelid
       join pg_catalog.pg_am as access_method
         on access_method.oid = index_relation.relam
       where index_info.indrelid = v_void_events_oid
         and index_relation.relname = 'verified_order_void_events_pkey'
         and index_relation.relkind = 'i'
         and index_relation.relowner = table_relation.relowner
         and access_method.amname = 'btree'
         and index_info.indisprimary is true
         and index_info.indisunique is true
         and index_info.indisexclusion is false
         and index_info.indimmediate is true
         and index_info.indisvalid is true
         and index_info.indisready is true
         and index_info.indislive is true
         and index_info.indnkeyatts = 2
         and index_info.indnatts = 2
         and index_info.indexprs is null
         and index_info.indpred is null
         and pg_catalog.pg_get_indexdef(index_info.indexrelid, 1, true) = 'source'
         and pg_catalog.pg_get_indexdef(index_info.indexrelid, 2, true) = 'idempotency_key'
     )
     or not exists (
       select 1
       from pg_catalog.pg_index as index_info
       join pg_catalog.pg_class as index_relation
         on index_relation.oid = index_info.indexrelid
       join pg_catalog.pg_class as table_relation
         on table_relation.oid = index_info.indrelid
       join pg_catalog.pg_am as access_method
         on access_method.oid = index_relation.relam
       where index_info.indrelid = v_void_events_oid
         and index_relation.relname = 'verified_order_void_events_order_idx'
         and index_relation.relkind = 'i'
         and index_relation.relowner = table_relation.relowner
         and access_method.amname = 'btree'
         and index_info.indisprimary is false
         and index_info.indisunique is false
         and index_info.indisexclusion is false
         and index_info.indisvalid is true
         and index_info.indisready is true
         and index_info.indislive is true
         and index_info.indnkeyatts = 2
         and index_info.indnatts = 2
         and index_info.indexprs is null
         and index_info.indpred is null
         and pg_catalog.pg_get_indexdef(index_info.indexrelid, 1, true) = 'order_id'
         and pg_catalog.pg_get_indexdef(index_info.indexrelid, 2, true) = 'last_seen_at'
         and pg_catalog.pg_index_column_has_property(
           index_info.indexrelid,
           2,
           'desc'
         ) is true
         and pg_catalog.pg_index_column_has_property(
           index_info.indexrelid,
           2,
           'nulls_first'
         ) is true
     ) then
    raise exception using
      errcode = '55000',
      message = '030 rollback refused: void audit shape drifted';
  end if;

  if pg_catalog.has_table_privilege(
       'anon',
       'public.verified_order_void_events',
       'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
     ) or pg_catalog.has_table_privilege(
       'authenticated',
       'public.verified_order_void_events',
       'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
     ) or pg_catalog.has_table_privilege(
       'service_role',
       'public.verified_order_void_events',
       'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
     ) or exists (
       select 1
       from pg_catalog.pg_class as table_acl
       cross join lateral pg_catalog.aclexplode(
         coalesce(
           table_acl.relacl,
           pg_catalog.acldefault('r', table_acl.relowner)
         )
       ) as privilege_info
       where table_acl.oid = v_void_events_oid
         and privilege_info.grantee = 0
     ) then
    raise exception using
      errcode = '55000',
      message = '030 rollback refused: void audit grants drifted';
  end if;

  if exists (
    select 1
    from public.verified_order_void_events
  ) then
    raise exception using
      errcode = '55000',
      message = '030 rollback blocked: preserve recorded void audit events with a reviewed forward migration';
  end if;

  select function_info.oid
  into v_rpc_oid
  from pg_catalog.pg_proc as function_info
  join pg_catalog.pg_language as language_info
    on language_info.oid = function_info.prolang
  where function_info.oid = pg_catalog.to_regprocedure(
      'public.hc_apply_verified_order_payment(uuid,text,bigint,bigint,text,bigint,bigint,bigint,text,text)'
    )
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
    and exists (
      select 1
      from pg_catalog.unnest(function_info.proconfig) as setting(value)
      where setting.value ~ '^search_path=(|"")$'
    );

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
       'Migration 030 RPC: compare and reconcile one exact order from cumulative QuickBooks invoice truth.'
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
         and privilege_info.grantee = 0
         and privilege_info.privilege_type = 'EXECUTE'
     ) then
    raise exception using
      errcode = '55000',
      message = '030 rollback refused: verified payment RPC shape or grants drifted';
  end if;

  select function_info.oid
  into v_void_rpc_oid
  from pg_catalog.pg_proc as function_info
  join pg_catalog.pg_language as language_info
    on language_info.oid = function_info.prolang
  where function_info.oid = pg_catalog.to_regprocedure(
      'public.hc_apply_verified_order_void(uuid,text,text,bigint,bigint,bigint,text,text)'
    )
    and function_info.pronargs = 8
    and function_info.pronargdefaults = 1
    and function_info.proargnames = array[
      'p_order_id',
      'p_external_invoice_id',
      'p_expected_stage',
      'p_expected_total_cents',
      'p_expected_deposit_cents',
      'p_expected_balance_cents',
      'p_idempotency_key',
      'p_source',
      'order_id',
      'stage',
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
    and function_info.proowner = (
      select payment_function.proowner
      from pg_catalog.pg_proc as payment_function
      where payment_function.oid = v_rpc_oid
    )
    and pg_catalog.pg_get_function_result(function_info.oid) =
      'TABLE(order_id uuid, stage text, event_inserted boolean)'
    and exists (
      select 1
      from pg_catalog.unnest(function_info.proconfig) as setting(value)
      where setting.value ~ '^search_path=(|"")$'
    );

  if v_void_rpc_oid is null
     or (
       select pg_catalog.count(*)
       from pg_catalog.pg_proc as function_info
       join pg_catalog.pg_namespace as namespace_info
         on namespace_info.oid = function_info.pronamespace
       where namespace_info.nspname = 'public'
         and function_info.proname = 'hc_apply_verified_order_void'
     ) <> 1
     or pg_catalog.obj_description(v_void_rpc_oid, 'pg_proc') is distinct from
       'Migration 030 RPC: compare and cancel one exact order after a verified QuickBooks void.'
     or pg_catalog.has_function_privilege(
       'anon',
       'public.hc_apply_verified_order_void(uuid,text,text,bigint,bigint,bigint,text,text)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.hc_apply_verified_order_void(uuid,text,text,bigint,bigint,bigint,text,text)',
       'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.hc_apply_verified_order_void(uuid,text,text,bigint,bigint,bigint,text,text)',
       'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'supabase_admin',
       'public.hc_apply_verified_order_void(uuid,text,text,bigint,bigint,bigint,text,text)',
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
       where function_acl.oid = v_void_rpc_oid
         and privilege_info.grantee = 0
         and privilege_info.privilege_type = 'EXECUTE'
     ) then
    raise exception using
      errcode = '55000',
      message = '030 rollback refused: verified void RPC shape or grants drifted';
  end if;

  select function_info.oid
  into v_helper_oid
  from pg_catalog.pg_proc as function_info
  join pg_catalog.pg_namespace as namespace_info
    on namespace_info.oid = function_info.pronamespace
  join pg_catalog.pg_language as language_info
    on language_info.oid = function_info.prolang
  where function_info.oid = pg_catalog.to_regprocedure(
      'public.hc_can_apply_direct_order_stage_transition(uuid,text,text,bigint,bigint)'
    )
    and namespace_info.nspname = 'public'
    and function_info.pronargs = 5
    and function_info.pronargdefaults = 0
    and function_info.proargnames = array[
      'p_order_id',
      'p_old_stage',
      'p_new_stage',
      'p_deposit_cents',
      'p_balance_cents'
    ]::text[]
    and function_info.prorettype = 'pg_catalog.bool'::pg_catalog.regtype
    and function_info.prosecdef is true
    and function_info.prokind = 'f'
    and function_info.provolatile = 'v'
    and language_info.lanname = 'plpgsql'
    and pg_catalog.pg_get_userbyid(function_info.proowner) in (
      'postgres', 'supabase_admin'
    )
    and pg_catalog.pg_get_function_result(function_info.oid) = 'boolean'
    and exists (
      select 1
      from pg_catalog.unnest(function_info.proconfig) as setting(value)
      where setting.value ~ '^search_path=(|"")$'
    );

  -- The helper and payment RPC must have the same trusted owner.
  if v_helper_oid is not null and not exists (
    select 1
    from pg_catalog.pg_proc as helper_function
    join pg_catalog.pg_proc as payment_function
      on payment_function.oid = v_rpc_oid
     and payment_function.proowner = helper_function.proowner
    where helper_function.oid = v_helper_oid
  ) then
    v_helper_oid := null;
  end if;

  if v_helper_oid is null
     or (
       select pg_catalog.count(*)
       from pg_catalog.pg_proc as function_info
       join pg_catalog.pg_namespace as namespace_info
         on namespace_info.oid = function_info.pronamespace
       where namespace_info.nspname = 'public'
         and function_info.proname = 'hc_can_apply_direct_order_stage_transition'
     ) <> 1
     or pg_catalog.obj_description(v_helper_oid, 'pg_proc') is distinct from
       'Migration 030 helper: allow one visible direct stage transition without exposing private payment provenance.'
     or pg_catalog.has_function_privilege(
       'anon',
       'public.hc_can_apply_direct_order_stage_transition(uuid,text,text,bigint,bigint)',
       'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'authenticated',
       'public.hc_can_apply_direct_order_stage_transition(uuid,text,text,bigint,bigint)',
       'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.hc_can_apply_direct_order_stage_transition(uuid,text,text,bigint,bigint)',
       'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'supabase_admin',
       'public.hc_can_apply_direct_order_stage_transition(uuid,text,text,bigint,bigint)',
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
       left join pg_catalog.pg_roles as granted_role
         on granted_role.oid = privilege_info.grantee
       where function_acl.oid = v_helper_oid
         and privilege_info.privilege_type = 'EXECUTE'
         and (
           privilege_info.grantee = 0
           or (
             privilege_info.grantee <> function_acl.proowner
             and granted_role.rolname not in (
               'authenticated', 'service_role', 'supabase_admin'
             )
           )
         )
     ) then
    raise exception using
      errcode = '55000',
      message = '030 rollback refused: payment provenance helper shape or grants drifted';
  end if;

  select function_info.oid
  into v_guard_oid
  from pg_catalog.pg_proc as function_info
  join pg_catalog.pg_namespace as namespace_info
    on namespace_info.oid = function_info.pronamespace
  join pg_catalog.pg_language as language_info
    on language_info.oid = function_info.prolang
  where namespace_info.nspname = 'public'
    and function_info.proname = 'hc_protect_order_payment_fields'
    and function_info.pronargs = 0
    and function_info.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
    and function_info.prokind = 'f'
    and function_info.prosecdef is false
    and language_info.lanname = 'plpgsql'
    and exists (
      select 1
      from pg_catalog.unnest(function_info.proconfig) as setting(value)
      where setting.value ~ '^search_path=(|"")$'
    );

  if v_guard_oid is null
     or (
       select pg_catalog.count(*)
       from pg_catalog.pg_proc as function_info
       join pg_catalog.pg_namespace as namespace_info
         on namespace_info.oid = function_info.pronamespace
       where namespace_info.nspname = 'public'
         and function_info.proname = 'hc_protect_order_payment_fields'
     ) <> 1
     or pg_catalog.obj_description(v_guard_oid, 'pg_proc') is distinct from
       'Migration 030 trigger: direct order payment writes are blocked outside the verified RPC.' then
    raise exception using
      errcode = '55000',
      message = '030 rollback refused: exact payment guard function is missing';
  end if;

  if pg_catalog.has_function_privilege(
       'anon',
       'public.hc_protect_order_payment_fields()',
       'EXECUTE'
     ) or pg_catalog.has_function_privilege(
       'authenticated',
       'public.hc_protect_order_payment_fields()',
       'EXECUTE'
     ) or pg_catalog.has_function_privilege(
       'service_role',
       'public.hc_protect_order_payment_fields()',
       'EXECUTE'
     ) or exists (
       select 1
       from pg_catalog.pg_proc as function_acl
       cross join lateral pg_catalog.aclexplode(
         coalesce(
           function_acl.proacl,
           pg_catalog.acldefault('f', function_acl.proowner)
         )
       ) as privilege_info
       where function_acl.oid = v_guard_oid
         and privilege_info.grantee = 0
         and privilege_info.privilege_type = 'EXECUTE'
     ) then
    raise exception using
      errcode = '55000',
      message = '030 rollback refused: payment guard grants drifted';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_trigger as trigger_info
    where trigger_info.tgrelid = 'public.orders'::pg_catalog.regclass
      and trigger_info.tgname = 'orders_payment_integrity_insert'
      and trigger_info.tgenabled = 'O'
      and trigger_info.tgisinternal is false
      and trigger_info.tgconstraint = 0
      and trigger_info.tgfoid = v_guard_oid
      and trigger_info.tgtype = 7
      and pg_catalog.cardinality(trigger_info.tgattr::smallint[]) = 0
      and pg_catalog.octet_length(trigger_info.tgargs) = 0
      and pg_catalog.obj_description(
        trigger_info.oid,
        'pg_trigger'
      ) = 'Migration 030: blocks untrusted payment state on new orders.'
  ) then
    raise exception using
      errcode = '55000',
      message = '030 rollback refused: exact insert guard is missing';
  end if;

  select pg_catalog.array_agg(
           column_info.attname
           order by column_info.attname
         )
  into v_update_columns
  from pg_catalog.pg_trigger as trigger_info
  cross join lateral pg_catalog.unnest(
    trigger_info.tgattr::smallint[]
  ) as protected_column(attnum)
  join pg_catalog.pg_attribute as column_info
    on column_info.attrelid = trigger_info.tgrelid
   and column_info.attnum = protected_column.attnum
  where trigger_info.tgrelid = 'public.orders'::pg_catalog.regclass
    and trigger_info.tgname = 'orders_payment_integrity_update';

  if not exists (
    select 1
    from pg_catalog.pg_trigger as trigger_info
    where trigger_info.tgrelid = 'public.orders'::pg_catalog.regclass
      and trigger_info.tgname = 'orders_payment_integrity_update'
      and trigger_info.tgenabled = 'O'
      and trigger_info.tgisinternal is false
      and trigger_info.tgconstraint = 0
      and trigger_info.tgfoid = v_guard_oid
      and trigger_info.tgtype = 19
      and pg_catalog.cardinality(trigger_info.tgattr::smallint[]) = 3
      and pg_catalog.octet_length(trigger_info.tgargs) = 0
      and pg_catalog.obj_description(
        trigger_info.oid,
        'pg_trigger'
      ) = 'Migration 030: protects verified order payment fields and stages.'
  ) or v_update_columns is distinct from
       array['balance_cents', 'deposit_cents', 'stage']::text[] then
    raise exception using
      errcode = '55000',
      message = '030 rollback refused: exact update guard is missing';
  end if;

  if (
    select pg_catalog.count(*)
    from pg_catalog.pg_trigger as trigger_info
    where trigger_info.tgrelid = 'public.orders'::pg_catalog.regclass
      and trigger_info.tgfoid = v_guard_oid
      and trigger_info.tgisinternal is false
  ) <> 2 or exists (
    select 1
    from pg_catalog.pg_trigger as trigger_info
    where trigger_info.tgrelid = 'public.orders'::pg_catalog.regclass
      and trigger_info.tgname = 'orders_payment_integrity'
  ) then
    raise exception using
      errcode = '55000',
      message = '030 rollback refused: payment guard trigger set drifted';
  end if;
end
$object_preflight$;

drop trigger orders_payment_integrity_update on public.orders;
drop trigger orders_payment_integrity_insert on public.orders;
drop function public.hc_protect_order_payment_fields();
drop function public.hc_can_apply_direct_order_stage_transition(
  uuid, text, text, bigint, bigint
);
drop function public.hc_apply_verified_order_payment(
  uuid, text, bigint, bigint, text, bigint, bigint, bigint, text, text
);
drop function public.hc_apply_verified_order_void(
  uuid, text, text, bigint, bigint, bigint, text, text
);
drop table public.verified_order_payment_events;
drop table public.verified_order_void_events;

do $postflight$
begin
  if exists (
       select 1
       from pg_catalog.pg_proc as function_info
       join pg_catalog.pg_namespace as namespace_info
         on namespace_info.oid = function_info.pronamespace
       where namespace_info.nspname = 'public'
         and function_info.proname in (
           'hc_protect_order_payment_fields',
           'hc_can_apply_direct_order_stage_transition',
           'hc_apply_verified_order_payment',
           'hc_apply_verified_order_void'
         )
     )
     or pg_catalog.to_regclass(
       'public.verified_order_payment_events'
     ) is not null
     or pg_catalog.to_regclass(
       'public.verified_order_payment_events_order_idx'
     ) is not null
     or pg_catalog.to_regclass(
       'public.verified_order_void_events'
     ) is not null
     or pg_catalog.to_regclass(
       'public.verified_order_void_events_order_idx'
     ) is not null
     or exists (
       select 1
       from pg_catalog.pg_trigger as trigger_info
       where trigger_info.tgrelid = 'public.orders'::pg_catalog.regclass
         and trigger_info.tgname in (
           'orders_payment_integrity',
           'orders_payment_integrity_insert',
           'orders_payment_integrity_update'
         )
     ) then
    raise exception using
      errcode = '55000',
      message = '030 rollback assertion failed: verified payment objects remain';
  end if;
end
$postflight$;

-- This is intentionally the only terminal transaction statement.
rollback;

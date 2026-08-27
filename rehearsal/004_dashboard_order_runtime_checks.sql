-- ============================================================================
-- SANDBOX ONLY: 004_dashboard_order_runtime_checks.sql
--
-- Run only after migrations 019 through 023 on hc-field-rehearsal. Two fixed
-- synthetic orders are inserted, exercised through the dashboard RPCs, and
-- rolled back with every temporary roster and delivery-signature change.
-- ============================================================================

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $test$
declare
  v_owner_auth_user_id uuid;
  v_owner_worker_id uuid;
  v_order_ny constant uuid := '00000000-0000-4000-8000-000000001901';
  v_order_nj constant uuid := '00000000-0000-4000-8000-000000001902';
  v_rows jsonb;
  v_confirmed boolean;
begin
  if (select count(*) from auth.users) <> 1
     or not exists (
       select 1
       from auth.users
       where lower(email) = 'siddsaxena@gmail.com'
         and email_confirmed_at is not null
     )
     or exists (
       select 1
       from public.orders
       where client_name not like 'Sandbox %'
     ) then
    raise exception using
      errcode = '55000',
      message = 'SANDBOX GUARD: expected the isolated one-user rehearsal project';
  end if;

  select fw.auth_user_id, fw.id
  into v_owner_auth_user_id, v_owner_worker_id
  from public.field_workers as fw
  where fw.active is true
    and fw.role = 'owner'
    and fw.auth_user_id is not null
  order by fw.created_at asc nulls last, fw.id asc
  limit 1;

  if v_owner_auth_user_id is null then
    raise exception using
      errcode = '55000',
      message = 'SANDBOX GUARD: linked active owner is missing';
  end if;

  perform pg_catalog.set_config(
    'request.jwt.claim.sub',
    v_owner_auth_user_id::text,
    true
  );
  perform pg_catalog.set_config('request.jwt.claim.role', 'authenticated', true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    pg_catalog.json_build_object(
      'sub', v_owner_auth_user_id,
      'role', 'authenticated'
    )::text,
    true
  );

  insert into public.orders (
    id,
    client_name,
    client_email,
    client_phone,
    company,
    venue,
    coconuts_qty,
    delivery_at_utc,
    delivery_notes,
    stage,
    market,
    total_cents,
    external_invoice_id,
    notes
  )
  values
    (
      v_order_ny,
      'Sandbox NY Runtime',
      'private-ny@sandbox.invalid',
      '+15555550191',
      'Private NY Company',
      'Sandbox NY Venue',
      100,
      clock_timestamp() + interval '1 day',
      'Use the loading dock',
      'paid_full',
      'ny',
      50000,
      'sandbox-private-invoice-ny',
      'private owner note ny'
    ),
    (
      v_order_nj,
      'Sandbox NJ Runtime',
      'private-nj@sandbox.invalid',
      '+15555550192',
      'Private NJ Company',
      'Sandbox NJ Venue',
      200,
      clock_timestamp() + interval '2 days',
      'Call on arrival',
      'paid_full',
      'nj',
      90000,
      'sandbox-private-invoice-nj',
      'private owner note nj'
    );

  select pg_catalog.jsonb_agg(order_row order by order_row->>'id')
  into v_rows
  from public.hc_list_orders_for_current_user(
    null, null, null, 0, 500
  ) as order_row
  where order_row->>'id' in (v_order_ny::text, v_order_nj::text);

  if pg_catalog.jsonb_array_length(coalesce(v_rows, '[]'::jsonb)) <> 2
     or not exists (
       select 1
       from pg_catalog.jsonb_array_elements(v_rows) as item(value)
       where item.value->>'id' = v_order_ny::text
         and item.value->>'client_email' = 'private-ny@sandbox.invalid'
         and item.value->>'total_cents' = '50000'
         and item.value->>'notes' = 'private owner note ny'
     ) then
    raise exception using
      errcode = '55000',
      message = 'owner order projection is incomplete';
  end if;

  update public.field_workers
  set role = 'manager',
      market = 'ny'
  where id = v_owner_worker_id;

  select pg_catalog.jsonb_agg(order_row order by order_row->>'id')
  into v_rows
  from public.hc_list_orders_for_current_user(
    null, null, null, 0, 500
  ) as order_row
  where order_row->>'id' in (v_order_ny::text, v_order_nj::text);

  if pg_catalog.jsonb_array_length(coalesce(v_rows, '[]'::jsonb)) <> 1
     or v_rows->0->>'id' <> v_order_ny::text
     or v_rows->0->>'market' <> 'ny'
     or v_rows->0 ?| array[
       'client_email',
       'client_phone',
       'company',
       'pre_tax_cents',
       'tax_cents',
       'total_cents',
       'deposit_cents',
       'balance_cents',
       'pay_notes',
       'external_invoice_id',
       'external_invoice_url',
       'notes',
       'delivery_signed_by'
     ] then
    raise exception using
      errcode = '55000',
      message = 'manager order projection leaked fields or crossed markets';
  end if;

  select public.hc_confirm_order_delivery(
    v_order_ny,
    clock_timestamp(),
    'Sandbox Receiver',
    'data:image/png;base64,AA==',
    'dashboard'
  )
  into v_confirmed;

  if v_confirmed is not true
     or not exists (
       select 1
       from public.orders
       where id = v_order_ny
         and delivery_signed_at is not null
         and delivery_signed_by = 'Sandbox Receiver'
     )
     or not exists (
       select 1
       from public.delivery_signatures
       where order_id = v_order_ny
         and signed_by = 'Sandbox Receiver'
         and signed_via = 'siddsaxena@gmail.com via dashboard'
     ) then
    raise exception using
      errcode = '55000',
      message = 'authorized delivery confirmation was not recorded atomically';
  end if;

  begin
    perform public.hc_confirm_order_delivery(
      v_order_nj,
      clock_timestamp(),
      'Blocked Receiver',
      'data:image/png;base64,AA==',
      'dashboard'
    );
    raise exception using
      errcode = '55000',
      message = 'cross-market delivery confirmation was accepted';
  exception
    when insufficient_privilege then
      null;
  end;

  if exists (
    select 1
    from public.delivery_signatures
    where order_id = v_order_nj
  ) or exists (
    select 1
    from public.orders
    where id = v_order_nj
      and delivery_signed_at is not null
  ) then
    raise exception using
      errcode = '55000',
      message = 'cross-market delivery denial was not atomic';
  end if;
end
$test$;

rollback;

select
  'passed'::text as dashboard_order_runtime_rehearsal,
  4::integer as scenarios_checked;

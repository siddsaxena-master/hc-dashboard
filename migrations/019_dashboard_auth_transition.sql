-- ============================================================================
-- 019_dashboard_auth_transition.sql
--
-- PURPOSE
-- Add secure Supabase Auth access for the static operations dashboard without
-- removing the legacy anonymous path yet. This is the no-downtime half of the
-- dashboard cutover. Run only after migration 015 is active.
--
-- SAFE ORDER
-- 1. Run this transition.
-- 2. Deploy and verify the dashboard build that sends a real user JWT.
-- 3. Run 020_dashboard_auth_cutover.sql to remove anonymous access.
--
-- This migration does not delete customer rows or revoke legacy access.
-- ============================================================================

begin;

set local lock_timeout = '15s';
set local statement_timeout = '2min';

do $preflight$
begin
  if to_regclass('public.orders') is null
     or to_regclass('public.delivery_signatures') is null
     or to_regclass('public.field_workers') is null then
    raise exception using
      errcode = '55000',
      message = '019 requires orders, delivery_signatures, and field_workers';
  end if;

  if to_regprocedure('public.hc_claim_field_worker()') is null
     or to_regprocedure('public.hc_is_owner()') is null then
    raise exception using
      errcode = '55000',
      message = '019 requires the authenticated identity helpers from migration 015';
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'field_workers'
      and column_name = 'auth_user_id'
      and data_type = 'uuid'
  ) then
    raise exception using
      errcode = '55000',
      message = '019 requires field_workers.auth_user_id from migration 015';
  end if;
end
$preflight$;

lock table public.orders in share row exclusive mode;
lock table public.delivery_signatures in share row exclusive mode;

-- This helper is deliberately narrower than a table-read policy. It is used
-- only by server-side order projections and delivery confirmation. Owners may
-- access every market. Active managers and team members must match one exact,
-- nonblank roster market.
create or replace function public.hc_can_access_order_market(p_market text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.field_workers as fw
    where fw.auth_user_id = auth.uid()
      and fw.active is true
      and (
        fw.role = 'owner'
        or (
          fw.role in ('manager', 'team')
          and nullif(lower(trim(p_market)), '') is not null
          and lower(trim(fw.market)) = lower(trim(p_market))
        )
      )
  )
$function$;

revoke all on function public.hc_can_access_order_market(text)
  from public, anon, authenticated;
grant execute on function public.hc_can_access_order_market(text)
  to authenticated, service_role;

-- Return order data in a shape chosen by the server, never by the phone or
-- browser. Owners receive the complete order row needed by the operations
-- dashboard. Managers and team members receive only the fields needed to plan
-- and complete work in their exact roster market. In particular, the safe
-- projection excludes contact details, every money field, invoice links and
-- IDs, internal notes, source/referral data, and delivery signatures.
--
-- The upper delivery bound is exclusive. Stable delivery_at_utc + id ordering
-- makes offset pagination deterministic for the current clients.
create or replace function public.hc_list_orders_for_current_user(
  p_delivery_from timestamptz default null,
  p_delivery_before timestamptz default null,
  p_stages text[] default null,
  p_offset integer default 0,
  p_limit integer default 500
)
returns setof jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_role text;
  v_market text;
begin
  if auth.uid() is null then
    raise exception using
      errcode = '42501',
      message = 'authenticated field worker required';
  end if;

  select lower(trim(fw.role)), lower(trim(fw.market))
  into v_role, v_market
  from public.field_workers as fw
  where fw.auth_user_id = auth.uid()
    and fw.active is true
  limit 1;

  if v_role is null or v_role not in ('owner', 'manager', 'team') then
    raise exception using
      errcode = '42501',
      message = 'active field worker required';
  end if;

  if v_role <> 'owner' and nullif(v_market, '') is null then
    raise exception using
      errcode = '42501',
      message = 'non-owner field worker requires an assigned market';
  end if;

  if p_offset is null or p_offset < 0 then
    raise exception using
      errcode = '22023',
      message = 'order offset must be zero or greater';
  end if;

  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception using
      errcode = '22023',
      message = 'order page limit must be between 1 and 500';
  end if;

  if p_delivery_from is not null
     and p_delivery_before is not null
     and p_delivery_from >= p_delivery_before then
    raise exception using
      errcode = '22023',
      message = 'order delivery range is invalid';
  end if;

  return query
  select case
    when v_role = 'owner' then to_jsonb(o)
    else jsonb_build_object(
      'id', o.id,
      'client_name', o.client_name,
      'venue', o.venue,
      'delivery_notes', o.delivery_notes,
      'event_start_at', o.event_start_at,
      'coconuts_qty', o.coconuts_qty,
      'crack_type', o.crack_type,
      'delivery_at_utc', o.delivery_at_utc,
      'stage', o.stage,
      'market', o.market,
      'stamp_status', o.stamp_status,
      'logo_received', o.logo_received,
      'is_recurring', o.is_recurring,
      'delivery_signed_at', o.delivery_signed_at
    )
  end
  from public.orders as o
  where (
      v_role = 'owner'
      or (
        nullif(lower(trim(o.market)), '') is not null
        and lower(trim(o.market)) = v_market
      )
    )
    and (p_delivery_from is null or o.delivery_at_utc >= p_delivery_from)
    and (p_delivery_before is null or o.delivery_at_utc < p_delivery_before)
    and (p_stages is null or o.stage = any(p_stages))
  order by o.delivery_at_utc asc nulls last, o.id asc
  offset p_offset
  limit p_limit;
end
$function$;

revoke all on function public.hc_list_orders_for_current_user(
  timestamptz, timestamptz, text[], integer, integer
) from public, anon, authenticated;
grant execute on function public.hc_list_orders_for_current_user(
  timestamptz, timestamptz, text[], integer, integer
) to authenticated;

-- Delivery confirmation is the one write allowed from a non-owner dashboard.
-- Keep the signature insert and order stamp atomic, and validate every input
-- on the server. General order writes remain owner-only through RLS.
create or replace function public.hc_confirm_order_delivery(
  p_order_id uuid,
  p_signed_at timestamptz,
  p_signed_by text,
  p_signature_data_url text,
  p_signed_via text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_signed_by text := nullif(trim(p_signed_by), '');
  v_client text := lower(nullif(trim(p_signed_via), ''));
  v_actor_email text;
begin
  if auth.uid() is null then
    raise exception using
      errcode = '42501',
      message = 'authenticated field worker required';
  end if;

  -- Hold this row lock through the signature insert and order stamp. An owner
  -- cannot move the order to another market between authorization and update.
  perform 1
  from public.orders as o
  where o.id = p_order_id
    and public.hc_can_access_order_market(o.market)
  for update;

  if p_order_id is null or not found then
    raise exception using
      errcode = '42501',
      message = 'order access denied';
  end if;

  v_actor_email := public.hc_current_worker_email();
  if v_actor_email is null then
    raise exception using
      errcode = '42501',
      message = 'confirmed field worker identity required';
  end if;

  if p_signed_at is null
     or p_signed_at < clock_timestamp() - interval '30 days'
     or p_signed_at > clock_timestamp() + interval '5 minutes' then
    raise exception using
      errcode = '22023',
      message = 'delivery signature timestamp is invalid';
  end if;

  if v_signed_by is null or length(v_signed_by) > 200 then
    raise exception using
      errcode = '22023',
      message = 'delivery signer name is invalid';
  end if;

  if p_signature_data_url is null
     or length(p_signature_data_url) > 2000000
     or p_signature_data_url !~ '^data:image/png;base64,[A-Za-z0-9+/=]+$' then
    raise exception using
      errcode = '22023',
      message = 'delivery signature image is invalid';
  end if;

  if v_client is null or v_client not in ('dashboard', 'field-app') then
    raise exception using
      errcode = '22023',
      message = 'delivery signature source is invalid';
  end if;

  insert into public.delivery_signatures (
    order_id,
    signed_by,
    signed_at,
    signature_data_url,
    signed_via
  )
  values (
    p_order_id,
    v_signed_by,
    p_signed_at,
    p_signature_data_url,
    v_actor_email || ' via ' || v_client
  );

  update public.orders
  set delivery_signed_at = p_signed_at,
      delivery_signed_by = v_signed_by,
      updated_at = clock_timestamp()
  where id = p_order_id;

  return true;
end
$function$;

revoke all on function public.hc_confirm_order_delivery(
  uuid, timestamptz, text, text, text
) from public, anon, authenticated;
grant execute on function public.hc_confirm_order_delivery(
  uuid, timestamptz, text, text, text
) to authenticated, service_role;

alter table public.orders enable row level security;
alter table public.delivery_signatures enable row level security;

-- Canonical authenticated policies. Direct order rows are owner-only. The
-- role-shaped RPC above is the sole read path for managers and team members.
-- Existing anonymous policies deliberately remain until migration 020, after
-- the new dashboard has been verified.
drop policy if exists orders_authenticated_select on public.orders;
create policy orders_authenticated_select
on public.orders
for select
to authenticated
using (public.hc_is_owner());

drop policy if exists orders_authenticated_insert on public.orders;
create policy orders_authenticated_insert
on public.orders
for insert
to authenticated
with check (public.hc_is_owner());

drop policy if exists orders_authenticated_update on public.orders;
create policy orders_authenticated_update
on public.orders
for update
to authenticated
using (public.hc_is_owner())
with check (public.hc_is_owner());

drop policy if exists orders_authenticated_delete on public.orders;
create policy orders_authenticated_delete
on public.orders
for delete
to authenticated
using (public.hc_is_owner());

grant select, insert, update, delete on table public.orders to authenticated;
grant all on table public.orders to service_role;
grant all on table public.delivery_signatures to service_role;

do $postflight$
begin
  if (
    select count(*)
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'orders'
      and policyname in (
        'orders_authenticated_select',
        'orders_authenticated_insert',
        'orders_authenticated_update',
        'orders_authenticated_delete'
      )
      and 'authenticated'::name = any(roles)
  ) <> 4 then
    raise exception using
      errcode = '55000',
      message = '019 postflight failed: authenticated order policies are incomplete';
  end if;

  if has_function_privilege(
       'anon',
       'public.hc_confirm_order_delivery(uuid,timestamptz,text,text,text)',
       'execute'
     )
     or not has_function_privilege(
       'authenticated',
       'public.hc_confirm_order_delivery(uuid,timestamptz,text,text,text)',
       'execute'
     ) then
    raise exception using
      errcode = '55000',
      message = '019 postflight failed: delivery RPC grants are unsafe';
  end if;

  if has_function_privilege(
       'anon',
       'public.hc_list_orders_for_current_user(timestamptz,timestamptz,text[],integer,integer)',
       'execute'
     )
     or not has_function_privilege(
       'authenticated',
       'public.hc_list_orders_for_current_user(timestamptz,timestamptz,text[],integer,integer)',
       'execute'
     ) then
    raise exception using
      errcode = '55000',
      message = '019 postflight failed: order-list RPC grants are unsafe';
  end if;
end
$postflight$;

commit;

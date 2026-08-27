-- ============================================================================
-- 020_dashboard_auth_cutover.sql
--
-- SECURITY CUTOFF
-- Remove anonymous browser access to orders and delivery signatures. Run only
-- after migration 019, after at least one active owner has a confirmed Auth
-- identity, and after the Supabase-authenticated dashboard is verified live.
--
-- This changes policies and grants. It does not delete customer rows.
-- ============================================================================

begin;

set local lock_timeout = '15s';
set local statement_timeout = '2min';

do $preflight$
begin
  if to_regprocedure('public.hc_can_access_order_market(text)') is null
     or to_regprocedure(
       'public.hc_list_orders_for_current_user(timestamptz,timestamptz,text[],integer,integer)'
     ) is null
     or to_regprocedure(
       'public.hc_confirm_order_delivery(uuid,timestamptz,text,text,text)'
     ) is null then
    raise exception using
      errcode = '55000',
      message = '020 requires migration 019';
  end if;

  if not exists (
    select 1
    from public.field_workers as fw
    join auth.users as au on au.id = fw.auth_user_id
    where fw.active is true
      and fw.role = 'owner'
      and au.email_confirmed_at is not null
      and lower(au.email) = lower(fw.email)
  ) then
    raise exception using
      errcode = '55000',
      message = '020 blocked: no active confirmed owner Auth identity is linked';
  end if;
end
$preflight$;

lock table public.orders in share row exclusive mode;
lock table public.delivery_signatures in share row exclusive mode;

-- Drop every policy that names PUBLIC or anon, including drifted legacy names.
do $drop_anon_policies$
declare
  v_policy record;
begin
  for v_policy in
    select schemaname, tablename, policyname
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename in ('orders', 'delivery_signatures')
      and (
        'public'::name = any(roles)
        or 'anon'::name = any(roles)
      )
  loop
    execute format(
      'drop policy %I on %I.%I',
      v_policy.policyname,
      v_policy.schemaname,
      v_policy.tablename
    );
  end loop;
end
$drop_anon_policies$;

revoke all on table public.orders from public, anon;
revoke all on table public.delivery_signatures from public, anon, authenticated;

-- Reassert the complete authenticated order policy set under the cutover lock.
-- Only owners may read complete rows. Managers and team members use the
-- role-shaped RPC from migration 019.
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

-- Reassert function grants in case they drifted between transition and
-- cutover. PostgreSQL grants new functions to PUBLIC by default unless this is
-- revoked explicitly.
revoke all on function public.hc_list_orders_for_current_user(
  timestamptz, timestamptz, text[], integer, integer
) from public, anon, authenticated;
grant execute on function public.hc_list_orders_for_current_user(
  timestamptz, timestamptz, text[], integer, integer
) to authenticated;

revoke all on function public.hc_confirm_order_delivery(
  uuid, timestamptz, text, text, text
) from public, anon, authenticated;
grant execute on function public.hc_confirm_order_delivery(
  uuid, timestamptz, text, text, text
) to authenticated, service_role;

do $postflight$
begin
  if exists (
    select 1
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename in ('orders', 'delivery_signatures')
      and (
        'public'::name = any(roles)
        or 'anon'::name = any(roles)
      )
  ) then
    raise exception using
      errcode = '55000',
      message = '020 postflight failed: anonymous dashboard policy remains';
  end if;

  if has_table_privilege('anon', 'public.orders', 'select')
     or has_table_privilege('anon', 'public.orders', 'insert')
     or has_table_privilege('anon', 'public.orders', 'update')
     or has_table_privilege('anon', 'public.orders', 'delete')
     or has_table_privilege('anon', 'public.delivery_signatures', 'select')
     or has_table_privilege('anon', 'public.delivery_signatures', 'insert') then
    raise exception using
      errcode = '55000',
      message = '020 postflight failed: anonymous dashboard privilege remains';
  end if;

  if not has_table_privilege('authenticated', 'public.orders', 'select')
     or not has_table_privilege('authenticated', 'public.orders', 'insert')
     or not has_table_privilege('authenticated', 'public.orders', 'update')
     or not has_table_privilege('authenticated', 'public.orders', 'delete')
     or has_table_privilege(
       'authenticated', 'public.delivery_signatures', 'select'
     )
     or has_table_privilege(
       'authenticated', 'public.delivery_signatures', 'insert'
     ) then
    raise exception using
      errcode = '55000',
      message = '020 postflight failed: authenticated dashboard grants are wrong';
  end if;

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
      message = '020 postflight failed: canonical order policies are incomplete';
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
     )
     or has_function_privilege(
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
      message = '020 postflight failed: dashboard RPC grants are unsafe';
  end if;
end
$postflight$;

commit;

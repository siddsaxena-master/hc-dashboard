-- ============================================================================
-- 015b_payroll_payment_rpc_compatibility.sql
--
-- Temporary production bridge for HC Field build 26. Production still has the
-- migration-015 one-argument payment RPC, while build 26 explicitly sends the
-- optional payment-note argument introduced by migration 023.
--
-- This migration does not change rows, tables, policies, or the existing
-- payment calculation. It adds a non-defaulted two-argument wrapper that
-- accepts a blank note and delegates to the existing owner-only, atomic RPC.
-- Migration 023 later replaces this wrapper with the permanent audited
-- implementation after the authenticated field cutover is complete.
--
-- Sequential replay order is 015, 015a, 015b, 016, then later 023. Migration
-- 023 safely replaces this wrapper when the permanent audit cutover is ready.
-- ============================================================================

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $preflight$
declare
  v_old constant text := 'public.hc_mark_shifts_paid(jsonb)';
  v_new constant text := 'public.hc_mark_shifts_paid(jsonb,text)';
begin
  if pg_catalog.to_regprocedure(v_old) is null
     or pg_catalog.to_regprocedure('public.hc_is_owner()') is null then
    raise exception using
      errcode = '55000',
      message = '015b requires migration 015 payroll authentication';
  end if;

  if pg_catalog.to_regprocedure(v_new) is not null then
    raise exception using
      errcode = '55000',
      message = '015b blocked: two-argument payment RPC already exists';
  end if;

  if pg_catalog.has_function_privilege('anon', v_old, 'EXECUTE')
     or not pg_catalog.has_function_privilege(
       'authenticated', v_old, 'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'service_role', v_old, 'EXECUTE'
     )
     or not exists (
       select 1
       from pg_catalog.pg_proc as function_info
       where function_info.oid = pg_catalog.to_regprocedure(v_old)
         and function_info.prosecdef is true
         and function_info.prorettype = 'integer'::pg_catalog.regtype
         and function_info.proargnames = array['p_items']
         and function_info.pronargdefaults = 0
         and exists (
           select 1
           from pg_catalog.unnest(function_info.proconfig) as setting(value)
           where setting.value ~ '^search_path=(|"")$'
         )
     ) then
    raise exception using
      errcode = '42501',
      message = '015b blocked: existing payment RPC is not safely locked';
  end if;
end
$preflight$;

create function public.hc_mark_shifts_paid(
  p_items jsonb,
  p_payment_note text
)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if not public.hc_is_owner() then
    raise exception using
      errcode = '42501',
      message = 'owner required';
  end if;

  if nullif(pg_catalog.btrim(p_payment_note), '') is not null then
    raise exception using
      errcode = '0A000',
      message = 'payment notes require the payroll audit cutover';
  end if;

  return public.hc_mark_shifts_paid(p_items);
end
$function$;

revoke all on function public.hc_mark_shifts_paid(jsonb, text)
  from public, anon, authenticated, service_role;
grant execute on function public.hc_mark_shifts_paid(jsonb, text)
  to authenticated, service_role;

do $postflight$
declare
  v_old constant text := 'public.hc_mark_shifts_paid(jsonb)';
  v_new constant text := 'public.hc_mark_shifts_paid(jsonb,text)';
begin
  if pg_catalog.to_regprocedure(v_old) is null
     or pg_catalog.to_regprocedure(v_new) is null
     or not exists (
       select 1
       from pg_catalog.pg_proc as function_info
       where function_info.oid = pg_catalog.to_regprocedure(v_old)
         and function_info.prosecdef is true
         and function_info.prorettype = 'integer'::pg_catalog.regtype
         and function_info.proargnames = array['p_items']
         and function_info.pronargdefaults = 0
         and exists (
           select 1
           from pg_catalog.unnest(function_info.proconfig) as setting(value)
           where setting.value ~ '^search_path=(|"")$'
         )
     )
     or pg_catalog.has_function_privilege('anon', v_old, 'EXECUTE')
     or not pg_catalog.has_function_privilege(
       'authenticated', v_old, 'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'service_role', v_old, 'EXECUTE'
     )
     or pg_catalog.has_function_privilege('anon', v_new, 'EXECUTE')
     or not pg_catalog.has_function_privilege(
       'authenticated', v_new, 'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'service_role', v_new, 'EXECUTE'
     )
     or not exists (
       select 1
       from pg_catalog.pg_proc as function_info
       where function_info.oid = pg_catalog.to_regprocedure(v_new)
         and function_info.prosecdef is true
         and function_info.prorettype = 'integer'::pg_catalog.regtype
         and function_info.proargnames = array[
           'p_items',
           'p_payment_note'
         ]
         and function_info.pronargdefaults = 0
         and exists (
           select 1
           from pg_catalog.unnest(function_info.proconfig) as setting(value)
           where setting.value ~ '^search_path=(|"")$'
         )
     ) then
    raise exception using
      errcode = '42501',
      message = '015b assertion failed: compatibility RPC is unsafe';
  end if;
end
$postflight$;

notify pgrst, 'reload schema';

commit;

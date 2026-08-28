-- ============================================================================
-- 015b_payroll_payment_rpc_compatibility_rollback.sql
--
-- Removes only the temporary build 26 wrapper created by migration 015b. It
-- refuses to remove the permanent two-argument RPC installed by migration 023.
-- ============================================================================

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $rollback$
declare
  v_signature constant text :=
    'public.hc_mark_shifts_paid(jsonb,text)';
  v_definition text;
begin
  if pg_catalog.to_regprocedure(v_signature) is null then
    return;
  end if;

  select pg_catalog.pg_get_functiondef(function_info.oid)
  into v_definition
  from pg_catalog.pg_proc as function_info
  where function_info.oid = pg_catalog.to_regprocedure(v_signature)
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
    );

  if pg_catalog.to_regprocedure(
       'public.hc_mark_shifts_paid(jsonb)'
     ) is null
     or v_definition is null
     or pg_catalog.strpos(
       v_definition,
       'payment notes require the payroll audit cutover'
     ) = 0
     or pg_catalog.strpos(
       pg_catalog.lower(v_definition),
       'return public.hc_mark_shifts_paid(p_items)'
     ) = 0 then
    raise exception using
      errcode = '55000',
      message = '015b rollback blocked: the payment RPC is not the temporary compatibility wrapper';
  end if;

  execute 'drop function public.hc_mark_shifts_paid(jsonb, text)';
end
$rollback$;

notify pgrst, 'reload schema';

commit;

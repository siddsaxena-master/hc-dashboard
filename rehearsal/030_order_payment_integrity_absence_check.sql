-- Read-only check to run after the rollback-only migration 030 rehearsal.
select
  to_regclass('public.verified_order_payment_events') is null
    as payment_ledger_absent,
  to_regclass('public.verified_order_void_events') is null
    as void_ledger_absent,
  to_regclass('public.verified_order_payment_events_order_idx') is null
    as payment_ledger_index_absent,
  to_regclass('public.verified_order_void_events_order_idx') is null
    as void_ledger_index_absent,
  (
    select count(*) = 0
    from pg_catalog.pg_proc as function_info
    join pg_catalog.pg_namespace as namespace_info
      on namespace_info.oid = function_info.pronamespace
    where namespace_info.nspname = 'public'
      and function_info.proname in (
        'hc_can_apply_direct_order_stage_transition',
        'hc_apply_verified_order_payment',
        'hc_apply_verified_order_void',
        'hc_protect_order_payment_fields'
      )
  ) as payment_functions_absent,
  (
    select count(*) = 0
    from pg_catalog.pg_trigger as trigger_info
    where trigger_info.tgrelid = 'public.orders'::pg_catalog.regclass
      and trigger_info.tgname in (
        'orders_payment_integrity',
        'orders_payment_integrity_insert',
        'orders_payment_integrity_update'
      )
  ) as payment_triggers_absent,
  (
    select count(*) = 1
    from pg_catalog.pg_trigger as trigger_info
    where trigger_info.tgrelid = 'public.orders'::pg_catalog.regclass
      and trigger_info.tgname = 'orders_updated_at'
      and trigger_info.tgisinternal is false
      and trigger_info.tgenabled = 'O'
      and trigger_info.tgtype = 19
      and pg_catalog.cardinality(trigger_info.tgattr::smallint[]) = 0
      and pg_catalog.octet_length(trigger_info.tgargs) = 0
      and trigger_info.tgfoid = 'public.set_updated_at()'::pg_catalog.regprocedure
  ) as original_updated_at_trigger_intact;

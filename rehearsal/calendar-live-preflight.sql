-- Read-only production preflight for the 13 already reviewed September orders.
select jsonb_build_object(
  'checked_at', now(),
  'database', current_database(),
  'orders', (select jsonb_agg(to_jsonb(o) order by o.id) from public.orders o
    where o.external_invoice_id in ('3124','3478','3508','3513','3494','3503','3520','3500','3208','3430','3449','3448','3519')),
  'columns', (select jsonb_agg(jsonb_build_object('name',column_name,'type',udt_name))
    from information_schema.columns where table_schema='public' and table_name='orders'),
  'order_reader', pg_get_functiondef('public.hc_list_orders_for_current_user(timestamptz,timestamptz,text[],integer,integer)'::regprocedure),
  'reader_settings', (select jsonb_build_object('owner',proowner,'acl',proacl,'config',proconfig,'security_definer',prosecdef)
    from pg_proc where oid='public.hc_list_orders_for_current_user(timestamptz,timestamptz,text[],integer,integer)'::regprocedure),
  'order_triggers', (select jsonb_agg(jsonb_build_object('name',t.tgname,'definition',pg_get_triggerdef(t.oid),'function',t.tgfoid::regprocedure::text))
    from pg_trigger t where t.tgrelid='public.orders'::regclass and not t.tgisinternal),
  'logo_bucket', (select to_jsonb(b) from storage.buckets b where b.id='order-logos'),
  'storage_policies', (select jsonb_agg(to_jsonb(p)) from pg_policies p where p.schemaname='storage' and p.tablename='objects'),
  'storage_row_security', (select relrowsecurity from pg_class where oid='storage.objects'::regclass)
) as snapshot;

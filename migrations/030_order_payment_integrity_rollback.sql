-- ============================================================================
-- 030_order_payment_integrity_rollback.sql
-- Remove only the exact order payment guard installed by migration 030.
--
-- This changes no order data. It deliberately refuses partial, missing, or
-- drifted objects. It also refuses to delete a nonempty payment audit ledger.
-- ============================================================================

begin;

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

commit;

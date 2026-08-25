-- ============================================================================
-- 016_field_auth_cutover_rollback.sql
-- Emergency rollback for 016_field_auth_cutover.sql.
--
-- LOCAL ROLLBACK FILE ONLY. DO NOT RUN THIS FILE AS A NORMAL MIGRATION.
-- Running it against Supabase is a production write and needs Sidd's explicit
-- "yes do it" confirmation plus a separate production review.
--
-- EMERGENCY USE ONLY
-- This deliberately restores the anonymous phone access that migration 016
-- removed. Use it only when a cutover failure makes the installed legacy app
-- unusable. Keep the rollback window short, verify every phone, then perform a
-- corrected authenticated cutover.
--
-- IMPORTANT LIMIT
-- Migration 016 removes legacy and ineligible notification token rows before
-- it commits. This rollback cannot reconstruct those secrets. Eligible phones
-- must register again. Restoring stale tokens from a backup without proving
-- the current phone owner could send private notifications to the wrong phone.
--
-- SCOPE
-- 1. Keep every safe schema addition, Auth link, index, authenticated policy,
--    authenticated RPC, and service-role grant from migrations 015 and 016.
-- 2. Restore the exact legacy shift assignment trigger from migration 015.
-- 3. Restore only the 13 canonical anonymous policies that existed during 015.
-- 4. Restore only the anonymous privileges those policies require.
-- 5. Keep shift_orders and both notification token tables unreadable to anon.
--
-- This transaction changes access metadata only. It contains no row deletion,
-- row insertion, row update, table truncation, table drop, or schema rollback.
-- ============================================================================

begin;

-- Match the cutover's bounded wait behavior. Abort instead of waiting behind
-- a phone or bot transaction indefinitely.
set local lock_timeout = '15s';
set local statement_timeout = '2min';

-- --------------------------------------------------------------------------
-- 1. Structural preflight, require the exact committed 016 starting posture
-- --------------------------------------------------------------------------

do $preflight$
declare
  v_table text;
  v_privilege text;
  v_signature text;
  v_expected_policy_count int;
  v_should_have boolean;
  v_column record;
  v_index record;
  v_function_oid oid;
  v_arg_names text[];
  v_arg_types oid[];
  v_is_paid_position int;
begin
  foreach v_table in array array[
    'field_workers',
    'shifts',
    'shift_locations',
    'shift_edits',
    'shift_orders',
    'push_tokens',
    'live_activity_tokens',
    'app_config'
  ] loop
    if pg_catalog.to_regclass(pg_catalog.format('public.%I', v_table)) is null then
      raise exception using
        errcode = '55000',
        message = pg_catalog.format('rollback blocked: public.%I is missing', v_table);
    end if;
  end loop;

  if pg_catalog.to_regclass('public.shift_locations_id_seq') is null then
    raise exception using
      errcode = '55000',
      message = 'rollback blocked: shift_locations_id_seq is missing';
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'field_workers'
      and column_name = 'auth_user_id'
      and data_type = 'uuid'
  ) or not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'shifts'
      and column_name = 'field_worker_id'
      and data_type = 'uuid'
  ) or not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'push_tokens'
      and column_name = 'device_id'
      and data_type = 'uuid'
      and is_nullable = 'YES'
  ) or not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'live_activity_tokens'
      and column_name = 'device_id'
      and data_type = 'uuid'
      and is_nullable = 'YES'
  ) then
    raise exception using
      errcode = '55000',
      message = 'rollback blocked: a required migration 015 identity column is missing or incompatible';
  end if;

  for v_index in
    select *
    from (
      values
        ('field_workers_email_lower_uidx', 'field_workers', 1, 'lower(email)', null, null, null),
        ('field_workers_auth_user_uidx', 'field_workers', 1, 'auth_user_id', null, null,
          'auth_user_idisnotnull'),
        ('shifts_one_open_worker_email_uidx', 'shifts', 1, 'lower(worker_email)', null, null,
          'clock_out_atisnullandworker_emailisnotnull'),
        ('shifts_one_open_worker_uidx', 'shifts', 1, 'field_worker_id', null, null,
          'clock_out_atisnullandfield_worker_idisnotnull'),
        ('push_tokens_device_uidx', 'push_tokens', 1, 'device_id', null, null,
          'device_idisnotnull'),
        ('live_activity_tokens_device_p2s_uidx', 'live_activity_tokens', 2, 'device_id', 'token_type', null,
          'shift_idisnullanddevice_idisnotnull'),
        ('live_activity_tokens_device_update_uidx', 'live_activity_tokens', 3, 'device_id', 'token_type', 'shift_id',
          'shift_idisnotnullanddevice_idisnotnull')
    ) as expected(index_name, table_name, key_count, key_one, key_two, key_three, predicate_tokens)
  loop
    if not exists (
      select 1
      from pg_catalog.pg_index as i
      join pg_catalog.pg_class as idx on idx.oid = i.indexrelid
      join pg_catalog.pg_class as tbl on tbl.oid = i.indrelid
      join pg_catalog.pg_namespace as ns on ns.oid = idx.relnamespace
      where ns.nspname = 'public'
        and idx.relname::text = v_index.index_name
        and idx.relkind = 'i'
        and tbl.oid = pg_catalog.to_regclass(
          pg_catalog.format('public.%I', v_index.table_name)
        )
        and idx.relowner = tbl.relowner
        and i.indisunique is true
        and i.indisvalid is true
        and i.indisready is true
        and i.indislive is true
        and i.indnkeyatts = v_index.key_count
        and i.indnatts = v_index.key_count
        and pg_catalog.pg_get_indexdef(i.indexrelid, 1, true) = v_index.key_one
        and (
          v_index.key_count < 2
          or pg_catalog.pg_get_indexdef(i.indexrelid, 2, true) = v_index.key_two
        )
        and (
          v_index.key_count < 3
          or pg_catalog.pg_get_indexdef(i.indexrelid, 3, true) = v_index.key_three
        )
        and case
          when v_index.predicate_tokens is null then i.indpred is null
          else
            i.indpred is not null
            and pg_catalog.regexp_replace(
              pg_catalog.lower(pg_catalog.pg_get_expr(i.indpred, i.indrelid)),
              '[[:space:]()]',
              '',
              'g'
            ) = v_index.predicate_tokens
        end
    ) then
      raise exception using
        errcode = '55000',
        message = pg_catalog.format(
          'rollback blocked: required index public.%I is missing or incompatible',
          v_index.index_name
        );
    end if;
  end loop;

  if not exists (
    select 1
    from pg_catalog.pg_constraint as c
    where c.conrelid = 'public.field_workers'::pg_catalog.regclass
      and c.conname = 'field_workers_auth_user_id_fkey'
      and c.contype = 'f'
      and c.convalidated is true
  ) or not exists (
    select 1
    from pg_catalog.pg_constraint as c
    where c.conrelid = 'public.shifts'::pg_catalog.regclass
      and c.conname = 'shifts_field_worker_id_fkey'
      and c.contype = 'f'
      and c.convalidated is true
  ) then
    raise exception using
      errcode = '55000',
      message = 'rollback blocked: a validated migration 015 identity foreign key is missing';
  end if;

  foreach v_signature in array array[
    'public.hc_claim_field_worker()',
    'public.hc_current_worker_id()',
    'public.hc_current_worker_email()',
    'public.hc_current_worker_role()',
    'public.hc_is_active_worker()',
    'public.hc_can_manage_shifts()',
    'public.hc_is_owner()',
    'public.hc_can_access_shift(uuid)',
    'public.hc_list_managed_shifts(timestamp with time zone,integer)',
    'public.hc_start_shift(double precision,double precision,text)',
    'public.hc_clock_out_my_shift(uuid,timestamp with time zone,double precision,double precision)',
    'public.hc_manage_clock_out(uuid,timestamp with time zone,double precision,double precision)',
    'public.hc_edit_shift_times(uuid,timestamp with time zone,timestamp with time zone,timestamp with time zone,timestamp with time zone,text)',
    'public.hc_mark_shifts_paid(jsonb)',
    'public.hc_record_shift_orders(uuid,jsonb)',
    'public.hc_sync_notification_device(uuid,text,boolean,boolean)',
    'public.hc_register_live_activity_token(text,uuid,text,uuid,boolean)',
    'public.hc_unregister_device(uuid)'
  ] loop
    if pg_catalog.to_regprocedure(v_signature) is null then
      raise exception using
        errcode = '55000',
        message = pg_catalog.format('rollback blocked: required RPC %s is missing', v_signature);
    end if;

    if pg_catalog.has_function_privilege('anon', v_signature, 'EXECUTE')
       or not pg_catalog.has_function_privilege('authenticated', v_signature, 'EXECUTE')
       or not pg_catalog.has_function_privilege('service_role', v_signature, 'EXECUTE') then
      raise exception using
        errcode = '42501',
        message = pg_catalog.format('rollback blocked: RPC grants are unsafe for %s', v_signature);
    end if;

    if not exists (
      select 1
      from pg_catalog.pg_proc as p
      where p.oid = pg_catalog.to_regprocedure(v_signature)
        and p.prosecdef is true
        and exists (
          select 1
          from pg_catalog.unnest(p.proconfig) as setting(value)
          where setting.value ~ '^search_path=(|"")$'
        )
    ) then
      raise exception using
        errcode = '42501',
        message = pg_catalog.format(
          'rollback blocked: SECURITY DEFINER or empty search_path lock is wrong for %s',
          v_signature
        );
    end if;
  end loop;

  v_function_oid := pg_catalog.to_regprocedure('public.hc_mark_shifts_paid(jsonb)');
  if not exists (
    select 1
    from pg_catalog.pg_proc as p
    where p.oid = v_function_oid
      and p.prorettype = pg_catalog.to_regtype('integer')::oid
  ) then
    raise exception using
      errcode = '55000',
      message = 'rollback blocked: hc_mark_shifts_paid must return integer';
  end if;

  v_function_oid := pg_catalog.to_regprocedure(
    'public.hc_list_managed_shifts(timestamp with time zone,integer)'
  );

  select p.proargnames, p.proallargtypes
  into v_arg_names, v_arg_types
  from pg_catalog.pg_proc as p
  where p.oid = v_function_oid;

  v_is_paid_position := pg_catalog.array_position(v_arg_names, 'is_paid');
  if v_is_paid_position is null
     or v_arg_types[v_is_paid_position] is distinct from pg_catalog.to_regtype('boolean')::oid
     or v_arg_names && array[
       'paid_at',
       'paid_cents',
       'paid_minutes',
       'hourly_rate_cents'
     ]::text[] then
    raise exception using
      errcode = '55000',
      message = 'rollback blocked: hc_list_managed_shifts return privacy contract is wrong';
  end if;

  foreach v_signature in array array[
    'public.hc_register_push_token(text,text)',
    'public.hc_register_live_activity_token(text,uuid,text)',
    'public.hc_unregister_device()'
  ] loop
    if pg_catalog.to_regprocedure(v_signature) is not null then
      raise exception using
        errcode = '55000',
        message = pg_catalog.format('rollback blocked: obsolete RPC %s still exists', v_signature);
    end if;
  end loop;

  if pg_catalog.to_regprocedure('public.hc_assign_shift_worker()') is not null
     or exists (
       select 1
       from pg_catalog.pg_trigger as t
       where t.tgrelid = 'public.shifts'::pg_catalog.regclass
         and t.tgname = 'shifts_assign_field_worker'
         and t.tgisinternal is false
     ) then
    raise exception using
      errcode = '55000',
      message = 'rollback blocked: legacy shift assignment trigger is already present';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_class as c
    join pg_catalog.pg_namespace as n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname::text = any(array[
        'field_workers',
        'shifts',
        'shift_locations',
        'shift_edits',
        'shift_orders',
        'push_tokens',
        'live_activity_tokens',
        'app_config'
      ])
      and c.relrowsecurity is false
  ) then
    raise exception using
      errcode = '55000',
      message = 'rollback blocked: row level security is disabled on a field table';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_policies as p
    where p.schemaname = 'public'
      and p.tablename::text = any(array[
        'field_workers',
        'shifts',
        'shift_locations',
        'shift_edits',
        'shift_orders',
        'push_tokens',
        'live_activity_tokens',
        'app_config'
      ])
      and (
        'public'::name = any(p.roles)
        or 'anon'::name = any(p.roles)
      )
  ) then
    raise exception using
      errcode = '42501',
      message = 'rollback blocked: an anonymous or PUBLIC field policy already exists';
  end if;

  select count(*)
  into v_expected_policy_count
  from (
    values
      ('field_workers', 'field_workers_authenticated_select', 'SELECT'),
      ('shifts', 'shifts_authenticated_select', 'SELECT'),
      ('shift_locations', 'shift_locations_authenticated_select', 'SELECT'),
      ('shift_locations', 'shift_locations_authenticated_insert', 'INSERT'),
      ('shift_edits', 'shift_edits_authenticated_select', 'SELECT'),
      ('shift_orders', 'shift_orders_authenticated_select', 'SELECT'),
      ('app_config', 'app_config_authenticated_owner_select', 'SELECT')
  ) as expected(table_name, policy_name, command)
  join pg_catalog.pg_policies as p
    on p.schemaname = 'public'
   and p.tablename::text = expected.table_name
   and p.policyname::text = expected.policy_name
   and p.permissive = 'PERMISSIVE'
   and p.cmd = expected.command
   and pg_catalog.cardinality(p.roles) = 1
   and 'authenticated'::name = any(p.roles);

  if v_expected_policy_count <> 7 or (
    select count(*)
    from pg_catalog.pg_policies as p
    where p.schemaname = 'public'
      and p.tablename::text = any(array[
        'field_workers',
        'shifts',
        'shift_locations',
        'shift_edits',
        'shift_orders',
        'push_tokens',
        'live_activity_tokens',
        'app_config'
      ])
      and 'authenticated'::name = any(p.roles)
  ) <> 7 then
    raise exception using
      errcode = '42501',
      message = 'rollback blocked: authenticated field policies differ from migration 016';
  end if;

  -- Migration 016 cleared anonymous table and column grants. Require that exact
  -- starting posture so this file cannot accidentally preserve unknown drift.
  foreach v_table in array array[
    'field_workers',
    'shifts',
    'shift_locations',
    'shift_edits',
    'shift_orders',
    'push_tokens',
    'live_activity_tokens',
    'app_config'
  ] loop
    foreach v_privilege in array array[
      'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
    ] loop
      if pg_catalog.has_table_privilege(
        'anon',
        pg_catalog.format('public.%I', v_table),
        v_privilege
      ) then
        raise exception using
          errcode = '42501',
          message = pg_catalog.format(
            'rollback blocked: anon already has %s on public.%I',
            v_privilege,
            v_table
          );
      end if;
    end loop;

    foreach v_privilege in array array['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'] loop
      if pg_catalog.has_any_column_privilege(
        'anon',
        pg_catalog.format('public.%I', v_table),
        v_privilege
      ) then
        raise exception using
          errcode = '42501',
          message = pg_catalog.format(
            'rollback blocked: anon already has column %s on public.%I',
            v_privilege,
            v_table
          );
      end if;
    end loop;
  end loop;

  foreach v_privilege in array array['USAGE', 'SELECT', 'UPDATE'] loop
    if pg_catalog.has_sequence_privilege(
      'anon',
      'public.shift_locations_id_seq',
      v_privilege
    ) then
      raise exception using
        errcode = '42501',
        message = pg_catalog.format(
          'rollback blocked: anon already has GPS sequence %s',
          v_privilege
      );
    end if;
  end loop;

  -- Pin the complete authenticated and service-role table and column matrices
  -- from migration 016. Column checks catch grants that a table-only check
  -- cannot see, including a broad GPS INSERT or a token-table read.
  foreach v_table in array array[
    'field_workers',
    'shifts',
    'shift_locations',
    'shift_edits',
    'shift_orders',
    'push_tokens',
    'live_activity_tokens',
    'app_config'
  ] loop
    foreach v_privilege in array array[
      'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
    ] loop
      v_should_have := v_privilege = 'SELECT' and v_table = any(array[
        'field_workers',
        'shifts',
        'shift_locations',
        'shift_edits',
        'shift_orders',
        'app_config'
      ]);

      if pg_catalog.has_table_privilege(
        'authenticated',
        pg_catalog.format('public.%I', v_table),
        v_privilege
      ) is distinct from v_should_have then
        raise exception using
          errcode = '42501',
          message = pg_catalog.format(
            'rollback blocked: authenticated %s on public.%I differs from 016',
            v_privilege,
            v_table
          );
      end if;

      if not pg_catalog.has_table_privilege(
        'service_role',
        pg_catalog.format('public.%I', v_table),
        v_privilege
      ) then
        raise exception using
          errcode = '42501',
          message = pg_catalog.format(
            'rollback blocked: service_role lost %s on public.%I',
            v_privilege,
            v_table
          );
      end if;
    end loop;

    for v_column in
      select c.column_name
      from information_schema.columns as c
      where c.table_schema = 'public'
        and c.table_name = v_table
    loop
      foreach v_privilege in array array['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'] loop
        v_should_have := (
          v_privilege = 'SELECT'
          and v_table = any(array[
            'field_workers',
            'shifts',
            'shift_locations',
            'shift_edits',
            'shift_orders',
            'app_config'
          ])
        ) or (
          v_privilege = 'INSERT'
          and v_table = 'shift_locations'
          and v_column.column_name = any(array[
            'shift_id',
            'at',
            'lat',
            'lng',
            'accuracy_m',
            'speed_mps'
          ])
        );

        if pg_catalog.has_column_privilege(
          'authenticated',
          pg_catalog.format('public.%I', v_table),
          v_column.column_name,
          v_privilege
        ) is distinct from v_should_have then
          raise exception using
            errcode = '42501',
            message = pg_catalog.format(
              'rollback blocked: authenticated column %s on public.%I.%I differs from 016',
              v_privilege,
              v_table,
              v_column.column_name
            );
        end if;

        if not pg_catalog.has_column_privilege(
          'service_role',
          pg_catalog.format('public.%I', v_table),
          v_column.column_name,
          v_privilege
        ) then
          raise exception using
            errcode = '42501',
            message = pg_catalog.format(
              'rollback blocked: service_role lost column %s on public.%I.%I',
              v_privilege,
              v_table,
              v_column.column_name
            );
        end if;
      end loop;
    end loop;
  end loop;

  if not pg_catalog.has_sequence_privilege(
    'authenticated',
    'public.shift_locations_id_seq',
    'USAGE'
  ) or not pg_catalog.has_sequence_privilege(
    'authenticated',
    'public.shift_locations_id_seq',
    'SELECT'
  ) or pg_catalog.has_sequence_privilege(
    'authenticated',
    'public.shift_locations_id_seq',
    'UPDATE'
  ) then
    raise exception using
      errcode = '42501',
      message = 'rollback blocked: authenticated GPS sequence grants differ from 016';
  end if;

  foreach v_privilege in array array['USAGE', 'SELECT', 'UPDATE'] loop
    if not pg_catalog.has_sequence_privilege(
      'service_role',
      'public.shift_locations_id_seq',
      v_privilege
    ) then
      raise exception using
        errcode = '42501',
        message = pg_catalog.format(
          'rollback blocked: service_role lost GPS sequence %s',
          v_privilege
        );
    end if;
  end loop;

  if exists (
    select 1
    from information_schema.table_privileges as privilege
    where privilege.table_schema = 'public'
      and privilege.table_name::text = any(array[
        'field_workers',
        'shifts',
        'shift_locations',
        'shift_edits',
        'shift_orders',
        'push_tokens',
        'live_activity_tokens',
        'app_config'
      ])
      and privilege.grantee = 'PUBLIC'
  ) or exists (
    select 1
    from information_schema.column_privileges as privilege
    where privilege.table_schema = 'public'
      and privilege.table_name::text = any(array[
        'field_workers',
        'shifts',
        'shift_locations',
        'shift_edits',
        'shift_orders',
        'push_tokens',
        'live_activity_tokens',
        'app_config'
      ])
      and privilege.grantee = 'PUBLIC'
  ) then
    raise exception using
      errcode = '42501',
      message = 'rollback blocked: PUBLIC already has a field table or column grant';
  end if;
end
$preflight$;

-- Use the same lock set and mode as migration 016. This keeps the compatibility
-- trigger, policies, and grants from changing underneath a concurrent write.
lock table
  public.app_config,
  public.field_workers,
  public.live_activity_tokens,
  public.push_tokens,
  public.shift_edits,
  public.shift_locations,
  public.shift_orders,
  public.shifts
in share row exclusive mode;

-- Reassert the canonical migration 016 predicates after the policy identity,
-- command, permissive mode, and sole authenticated role pass preflight. ALTER
-- POLICY changes access metadata only and repairs predicate drift in place.
alter policy field_workers_authenticated_select
on public.field_workers
to authenticated
using (
  (auth_user_id = auth.uid() and active is true)
  or public.hc_is_owner()
);

alter policy shifts_authenticated_select
on public.shifts
to authenticated
using (
  public.hc_is_active_worker()
  and (
    field_worker_id = public.hc_current_worker_id()
    or public.hc_is_owner()
  )
);

alter policy shift_locations_authenticated_select
on public.shift_locations
to authenticated
using (
  public.hc_is_active_worker()
  and public.hc_can_access_shift(shift_locations.shift_id)
);

alter policy shift_locations_authenticated_insert
on public.shift_locations
to authenticated
with check (
  public.hc_is_active_worker()
  and shift_id is not null
  and lat between -90 and 90
  and lng between -180 and 180
  and (accuracy_m is null or accuracy_m >= 0)
  and exists (
    select 1
    from public.shifts as s
    where s.id = shift_locations.shift_id
      and s.field_worker_id = public.hc_current_worker_id()
      and shift_locations.at >= s.clock_in_at - interval '5 minutes'
      and shift_locations.at <= coalesce(s.clock_out_at, now()) + interval '5 minutes'
  )
);

alter policy shift_edits_authenticated_select
on public.shift_edits
to authenticated
using (public.hc_can_manage_shifts());

alter policy shift_orders_authenticated_select
on public.shift_orders
to authenticated
using (
  public.hc_is_active_worker()
  and public.hc_can_access_shift(shift_orders.shift_id)
);

alter policy app_config_authenticated_owner_select
on public.app_config
to authenticated
using (public.hc_is_owner());

-- --------------------------------------------------------------------------
-- 2. Restore the exact migration 015 legacy shift identity bridge
-- --------------------------------------------------------------------------

create or replace function public.hc_assign_shift_worker()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_worker_id uuid;
begin
  if tg_op = 'UPDATE' then
    -- Existing ownership is immutable. For an unmatched historical row, keep
    -- it unmatched so service-role summary/status updates remain compatible.
    new.worker_email := old.worker_email;
    if old.field_worker_id is not null then
      new.field_worker_id := old.field_worker_id;
    else
      select fw.id
      into v_worker_id
      from public.field_workers as fw
      where lower(fw.email) = lower(old.worker_email)
      limit 1;
      new.field_worker_id := v_worker_id;
    end if;
    return new;
  end if;

  select fw.id
  into v_worker_id
  from public.field_workers as fw
  where fw.active is true
    and lower(fw.email) = lower(new.worker_email)
  limit 1;

  if v_worker_id is null then
    raise exception using
      errcode = '23503',
      message = 'shift worker email is not on the active field roster';
  end if;

  new.field_worker_id := v_worker_id;
  new.worker_email := lower(new.worker_email);
  return new;
end
$function$;

revoke all on function public.hc_assign_shift_worker()
  from public, anon, authenticated;

create trigger shifts_assign_field_worker
before insert or update on public.shifts
for each row execute function public.hc_assign_shift_worker();

-- --------------------------------------------------------------------------
-- 3. Restore exactly the 13 anonymous policies present during migration 015
-- --------------------------------------------------------------------------

create policy "anon read field_workers" on public.field_workers
  for select to anon using (true);

create policy "anon insert shifts" on public.shifts
  for insert to anon with check (true);
create policy "anon read shifts" on public.shifts
  for select to anon using (true);
create policy "anon update shifts" on public.shifts
  for update to anon using (true);

create policy "anon insert shift_locations" on public.shift_locations
  for insert to anon with check (true);
create policy "anon read shift_locations" on public.shift_locations
  for select to anon using (true);

create policy shift_edits_anon_insert on public.shift_edits
  for insert to anon with check (true);
create policy shift_edits_anon_select on public.shift_edits
  for select to anon using (true);

create policy push_tokens_anon_insert on public.push_tokens
  for insert to anon with check (true);
create policy push_tokens_anon_update on public.push_tokens
  for update to anon using (true) with check (true);

create policy live_activity_tokens_anon_insert on public.live_activity_tokens
  for insert to anon with check (true);
create policy live_activity_tokens_anon_update on public.live_activity_tokens
  for update to anon using (true) with check (true);

create policy app_config_anon_select on public.app_config
  for select to anon using (true);

-- --------------------------------------------------------------------------
-- 4. Restore the minimum anonymous privileges required by those policies
-- --------------------------------------------------------------------------

grant select on table
  public.field_workers,
  public.shifts,
  public.shift_locations,
  public.shift_edits,
  public.app_config
to anon;

grant insert on table
  public.shifts,
  public.shift_locations,
  public.shift_edits,
  public.push_tokens,
  public.live_activity_tokens
to anon;

grant update on table
  public.shifts,
  public.push_tokens,
  public.live_activity_tokens
to anon;

grant usage, select on sequence public.shift_locations_id_seq to anon;

-- No anonymous or PUBLIC grant is made on shift_orders. No anonymous SELECT is
-- granted on push_tokens or live_activity_tokens. All new phone writes keep
-- using authenticated RPCs, while only a legacy installed build uses this
-- temporary compatibility path.

-- --------------------------------------------------------------------------
-- 5. Final assertions, any failure rolls the entire rollback back
-- --------------------------------------------------------------------------

do $assertions$
declare
  v_table text;
  v_privilege text;
  v_signature text;
  v_should_have boolean;
  v_expected_policy_count int;
  v_column record;
  v_index record;
  v_policy record;
  v_policy_check text;
  v_function_oid oid;
  v_arg_names text[];
  v_arg_types oid[];
  v_is_paid_position int;
begin
  select count(*)
  into v_expected_policy_count
  from (
    values
      ('field_workers', 'anon read field_workers', 'SELECT'),
      ('shifts', 'anon insert shifts', 'INSERT'),
      ('shifts', 'anon read shifts', 'SELECT'),
      ('shifts', 'anon update shifts', 'UPDATE'),
      ('shift_locations', 'anon insert shift_locations', 'INSERT'),
      ('shift_locations', 'anon read shift_locations', 'SELECT'),
      ('shift_edits', 'shift_edits_anon_insert', 'INSERT'),
      ('shift_edits', 'shift_edits_anon_select', 'SELECT'),
      ('push_tokens', 'push_tokens_anon_insert', 'INSERT'),
      ('push_tokens', 'push_tokens_anon_update', 'UPDATE'),
      ('live_activity_tokens', 'live_activity_tokens_anon_insert', 'INSERT'),
      ('live_activity_tokens', 'live_activity_tokens_anon_update', 'UPDATE'),
      ('app_config', 'app_config_anon_select', 'SELECT')
  ) as expected(table_name, policy_name, command)
  join pg_catalog.pg_policies as p
    on p.schemaname = 'public'
   and p.tablename::text = expected.table_name
   and p.policyname::text = expected.policy_name
   and p.cmd = expected.command
   and pg_catalog.cardinality(p.roles) = 1
   and 'anon'::name = any(p.roles);

  if v_expected_policy_count <> 13 or (
    select count(*)
    from pg_catalog.pg_policies as p
    where p.schemaname = 'public'
      and p.tablename::text = any(array[
        'field_workers',
        'shifts',
        'shift_locations',
        'shift_edits',
        'shift_orders',
        'push_tokens',
        'live_activity_tokens',
        'app_config'
      ])
      and 'anon'::name = any(p.roles)
  ) <> 13 then
    raise exception using
      errcode = '42501',
      message = 'rollback assertion failed: anonymous policy allowlist is wrong';
  end if;

  select count(*)
  into v_expected_policy_count
  from (
    values
      ('field_workers', 'field_workers_authenticated_select', 'SELECT'),
      ('shifts', 'shifts_authenticated_select', 'SELECT'),
      ('shift_locations', 'shift_locations_authenticated_select', 'SELECT'),
      ('shift_locations', 'shift_locations_authenticated_insert', 'INSERT'),
      ('shift_edits', 'shift_edits_authenticated_select', 'SELECT'),
      ('shift_orders', 'shift_orders_authenticated_select', 'SELECT'),
      ('app_config', 'app_config_authenticated_owner_select', 'SELECT')
  ) as expected(table_name, policy_name, command)
  join pg_catalog.pg_policies as p
    on p.schemaname = 'public'
   and p.tablename::text = expected.table_name
   and p.policyname::text = expected.policy_name
   and p.permissive = 'PERMISSIVE'
   and p.cmd = expected.command
   and pg_catalog.cardinality(p.roles) = 1
   and 'authenticated'::name = any(p.roles);

  if v_expected_policy_count <> 7 or (
    select count(*)
    from pg_catalog.pg_policies as p
    where p.schemaname = 'public'
      and p.tablename::text = any(array[
        'field_workers',
        'shifts',
        'shift_locations',
        'shift_edits',
        'shift_orders',
        'push_tokens',
        'live_activity_tokens',
        'app_config'
      ])
      and 'authenticated'::name = any(p.roles)
  ) <> 7 then
    raise exception using
      errcode = '42501',
      message = 'rollback assertion failed: authenticated policy allowlist is wrong';
  end if;

  for v_policy in
    select *
    from (
      values
        ('field_workers', 'field_workers_authenticated_select',
          'auth_user_id=auth.uidandactiveistrueorhc_is_owner'),
        ('shifts', 'shifts_authenticated_select',
          'hc_is_active_workerandfield_worker_id=hc_current_worker_idorhc_is_owner'),
        ('shift_locations', 'shift_locations_authenticated_select',
          'hc_is_active_workerandhc_can_access_shiftshift_id'),
        ('shift_edits', 'shift_edits_authenticated_select',
          'hc_can_manage_shifts'),
        ('shift_orders', 'shift_orders_authenticated_select',
          'hc_is_active_workerandhc_can_access_shiftshift_id'),
        ('app_config', 'app_config_authenticated_owner_select',
          'hc_is_owner')
    ) as expected(table_name, policy_name, qual_tokens)
  loop
    if not exists (
      select 1
      from pg_catalog.pg_policies as p
      where p.schemaname = 'public'
        and p.tablename::text = v_policy.table_name
        and p.policyname::text = v_policy.policy_name
        and p.permissive = 'PERMISSIVE'
        and p.cmd = 'SELECT'
        and pg_catalog.cardinality(p.roles) = 1
        and 'authenticated'::name = any(p.roles)
        and p.with_check is null
        and pg_catalog.translate(
          pg_catalog.lower(
            pg_catalog.replace(
              pg_catalog.replace(p.qual, 'public.', ''),
              p.tablename::text || '.',
              ''
            )
          ),
          E' \n\r\t()"',
          ''
        ) = v_policy.qual_tokens
    ) then
      raise exception using
        errcode = '42501',
        message = pg_catalog.format(
          'rollback assertion failed: authenticated policy predicate is wrong for %s',
          v_policy.policy_name
        );
    end if;
  end loop;

  select pg_catalog.lower(
    pg_catalog.replace(
      pg_catalog.replace(p.with_check, 'public.', ''),
      'shift_locations.',
      ''
    )
  )
  into v_policy_check
  from pg_catalog.pg_policies as p
  where p.schemaname = 'public'
    and p.tablename = 'shift_locations'
    and p.policyname = 'shift_locations_authenticated_insert'
    and p.permissive = 'PERMISSIVE'
    and p.cmd = 'INSERT'
    and pg_catalog.cardinality(p.roles) = 1
    and 'authenticated'::name = any(p.roles)
    and p.qual is null;

  if v_policy_check is null
     or v_policy_check not like '%hc_is_active_worker()%'
     or v_policy_check not like '%shift_id is not null%'
     or v_policy_check !~ 'lat[^0-9-]*>=[^0-9-]*-90'
     or v_policy_check !~ 'lat[^0-9]*<=[^0-9]*90'
     or v_policy_check !~ 'lng[^0-9-]*>=[^0-9-]*-180'
     or v_policy_check !~ 'lng[^0-9]*<=[^0-9]*180'
     or v_policy_check not like '%accuracy_m is null%'
     or v_policy_check !~ 'accuracy_m[^0-9]*>=[^0-9]*0'
     or v_policy_check not like '%exists%'
     or v_policy_check not like '%from shifts%'
     or v_policy_check not like '%s.id = shift_id%'
     or v_policy_check not like '%s.field_worker_id = hc_current_worker_id()%'
     or v_policy_check not like '%at >= (s.clock_in_at -%'
     or v_policy_check not like '%at <= (coalesce(s.clock_out_at, now()) +%'
     or v_policy_check like '% or true%'
     or v_policy_check like '% and false%' then
    raise exception using
      errcode = '42501',
      message = 'rollback assertion failed: bounded authenticated GPS policy predicate is wrong';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_policies as p
    where p.schemaname = 'public'
      and p.tablename::text = any(array[
        'field_workers',
        'shifts',
        'shift_locations',
        'shift_edits',
        'shift_orders',
        'push_tokens',
        'live_activity_tokens',
        'app_config'
      ])
      and 'public'::name = any(p.roles)
  ) then
    raise exception using
      errcode = '42501',
      message = 'rollback assertion failed: PUBLIC field policy exists';
  end if;

  -- Pin every anonymous table privilege. Anything outside this matrix fails.
  foreach v_table in array array[
    'field_workers',
    'shifts',
    'shift_locations',
    'shift_edits',
    'shift_orders',
    'push_tokens',
    'live_activity_tokens',
    'app_config'
  ] loop
    foreach v_privilege in array array[
      'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
    ] loop
      select exists (
        select 1
        from (
          values
            ('field_workers', 'SELECT'),
            ('shifts', 'SELECT'),
            ('shifts', 'INSERT'),
            ('shifts', 'UPDATE'),
            ('shift_locations', 'SELECT'),
            ('shift_locations', 'INSERT'),
            ('shift_edits', 'SELECT'),
            ('shift_edits', 'INSERT'),
            ('push_tokens', 'INSERT'),
            ('push_tokens', 'UPDATE'),
            ('live_activity_tokens', 'INSERT'),
            ('live_activity_tokens', 'UPDATE'),
            ('app_config', 'SELECT')
        ) as expected(table_name, privilege_name)
        where expected.table_name = v_table
          and expected.privilege_name = v_privilege
      ) into v_should_have;

      if pg_catalog.has_table_privilege(
        'anon',
        pg_catalog.format('public.%I', v_table),
        v_privilege
      ) is distinct from v_should_have then
        raise exception using
          errcode = '42501',
          message = pg_catalog.format(
            'rollback assertion failed: anon %s on public.%I is wrong',
            v_privilege,
            v_table
          );
      end if;
    end loop;

    foreach v_privilege in array array['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'] loop
      select exists (
        select 1
        from (
          values
            ('field_workers', 'SELECT'),
            ('shifts', 'SELECT'),
            ('shifts', 'INSERT'),
            ('shifts', 'UPDATE'),
            ('shift_locations', 'SELECT'),
            ('shift_locations', 'INSERT'),
            ('shift_edits', 'SELECT'),
            ('shift_edits', 'INSERT'),
            ('push_tokens', 'INSERT'),
            ('push_tokens', 'UPDATE'),
            ('live_activity_tokens', 'INSERT'),
            ('live_activity_tokens', 'UPDATE'),
            ('app_config', 'SELECT')
        ) as expected(table_name, privilege_name)
        where expected.table_name = v_table
          and expected.privilege_name = v_privilege
      ) into v_should_have;

      if pg_catalog.has_any_column_privilege(
        'anon',
        pg_catalog.format('public.%I', v_table),
        v_privilege
      ) is distinct from v_should_have then
        raise exception using
          errcode = '42501',
          message = pg_catalog.format(
            'rollback assertion failed: anon column %s on public.%I is wrong',
            v_privilege,
            v_table
          );
      end if;
    end loop;
  end loop;

  if not pg_catalog.has_sequence_privilege(
    'anon',
    'public.shift_locations_id_seq',
    'USAGE'
  ) or not pg_catalog.has_sequence_privilege(
    'anon',
    'public.shift_locations_id_seq',
    'SELECT'
  ) or pg_catalog.has_sequence_privilege(
    'anon',
    'public.shift_locations_id_seq',
    'UPDATE'
  ) then
    raise exception using
      errcode = '42501',
      message = 'rollback assertion failed: anonymous GPS sequence grants are wrong';
  end if;

  foreach v_table in array array[
    'field_workers',
    'shifts',
    'shift_locations',
    'shift_edits',
    'shift_orders',
    'push_tokens',
    'live_activity_tokens',
    'app_config'
  ] loop
    foreach v_privilege in array array[
      'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
    ] loop
      v_should_have := v_privilege = 'SELECT' and v_table = any(array[
        'field_workers',
        'shifts',
        'shift_locations',
        'shift_edits',
        'shift_orders',
        'app_config'
      ]);

      if pg_catalog.has_table_privilege(
        'authenticated',
        pg_catalog.format('public.%I', v_table),
        v_privilege
      ) is distinct from v_should_have then
        raise exception using
          errcode = '42501',
          message = pg_catalog.format(
            'rollback assertion failed: authenticated %s on public.%I differs from 016',
            v_privilege,
            v_table
          );
      end if;

      if not pg_catalog.has_table_privilege(
        'service_role',
        pg_catalog.format('public.%I', v_table),
        v_privilege
      ) then
        raise exception using
          errcode = '42501',
          message = pg_catalog.format(
            'rollback assertion failed: service_role lost %s on public.%I',
            v_privilege,
            v_table
          );
      end if;
    end loop;

    for v_column in
      select c.column_name
      from information_schema.columns as c
      where c.table_schema = 'public'
        and c.table_name = v_table
    loop
      foreach v_privilege in array array['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'] loop
        v_should_have := (
          v_privilege = 'SELECT'
          and v_table = any(array[
            'field_workers',
            'shifts',
            'shift_locations',
            'shift_edits',
            'shift_orders',
            'app_config'
          ])
        ) or (
          v_privilege = 'INSERT'
          and v_table = 'shift_locations'
          and v_column.column_name = any(array[
            'shift_id',
            'at',
            'lat',
            'lng',
            'accuracy_m',
            'speed_mps'
          ])
        );

        if pg_catalog.has_column_privilege(
          'authenticated',
          pg_catalog.format('public.%I', v_table),
          v_column.column_name,
          v_privilege
        ) is distinct from v_should_have then
          raise exception using
            errcode = '42501',
            message = pg_catalog.format(
              'rollback assertion failed: authenticated column %s on public.%I.%I differs from 016',
              v_privilege,
              v_table,
              v_column.column_name
            );
        end if;

        if not pg_catalog.has_column_privilege(
          'service_role',
          pg_catalog.format('public.%I', v_table),
          v_column.column_name,
          v_privilege
        ) then
          raise exception using
            errcode = '42501',
            message = pg_catalog.format(
              'rollback assertion failed: service_role lost column %s on public.%I.%I',
              v_privilege,
              v_table,
              v_column.column_name
            );
        end if;
      end loop;
    end loop;
  end loop;

  if not pg_catalog.has_sequence_privilege(
    'authenticated',
    'public.shift_locations_id_seq',
    'USAGE'
  ) or not pg_catalog.has_sequence_privilege(
    'authenticated',
    'public.shift_locations_id_seq',
    'SELECT'
  ) or pg_catalog.has_sequence_privilege(
    'authenticated',
    'public.shift_locations_id_seq',
    'UPDATE'
  ) then
    raise exception using
      errcode = '42501',
      message = 'rollback assertion failed: authenticated GPS sequence grants differ from 016';
  end if;

  foreach v_privilege in array array['USAGE', 'SELECT', 'UPDATE'] loop
    if not pg_catalog.has_sequence_privilege(
      'service_role',
      'public.shift_locations_id_seq',
      v_privilege
    ) then
      raise exception using
        errcode = '42501',
        message = pg_catalog.format(
          'rollback assertion failed: service_role lost GPS sequence %s',
          v_privilege
        );
    end if;
  end loop;

  if exists (
    select 1
    from information_schema.table_privileges as privilege
    where privilege.table_schema = 'public'
      and privilege.table_name::text = any(array[
        'field_workers',
        'shifts',
        'shift_locations',
        'shift_edits',
        'shift_orders',
        'push_tokens',
        'live_activity_tokens',
        'app_config'
      ])
      and privilege.grantee = 'PUBLIC'
  ) or exists (
    select 1
    from information_schema.column_privileges as privilege
    where privilege.table_schema = 'public'
      and privilege.table_name::text = any(array[
        'field_workers',
        'shifts',
        'shift_locations',
        'shift_edits',
        'shift_orders',
        'push_tokens',
        'live_activity_tokens',
        'app_config'
      ])
      and privilege.grantee = 'PUBLIC'
  ) then
    raise exception using
      errcode = '42501',
      message = 'rollback assertion failed: PUBLIC has a field table or column grant';
  end if;

  if pg_catalog.to_regprocedure('public.hc_assign_shift_worker()') is null
     or not exists (
       select 1
       from pg_catalog.pg_proc as p
       where p.oid = pg_catalog.to_regprocedure('public.hc_assign_shift_worker()')
         and p.prosecdef is true
         and exists (
           select 1
           from pg_catalog.unnest(p.proconfig) as setting(value)
           where setting.value like 'search_path=%'
         )
     )
     or pg_catalog.has_function_privilege(
       'anon',
       'public.hc_assign_shift_worker()',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.hc_assign_shift_worker()',
       'EXECUTE'
     ) then
    raise exception using
      errcode = '42501',
      message = 'rollback assertion failed: shift assignment function is unsafe';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_trigger as t
    where t.tgrelid = 'public.shifts'::pg_catalog.regclass
      and t.tgname = 'shifts_assign_field_worker'
      and t.tgisinternal is false
      and t.tgenabled <> 'D'
      and lower(pg_catalog.pg_get_triggerdef(t.oid)) like
        '%before insert or update on public.shifts%hc_assign_shift_worker()%'
  ) then
    raise exception using
      errcode = '55000',
      message = 'rollback assertion failed: shift assignment trigger is missing or disabled';
  end if;

  for v_index in
    select *
    from (
      values
        ('field_workers_email_lower_uidx', 'field_workers', 1, 'lower(email)', null, null, null),
        ('field_workers_auth_user_uidx', 'field_workers', 1, 'auth_user_id', null, null,
          'auth_user_idisnotnull'),
        ('shifts_one_open_worker_email_uidx', 'shifts', 1, 'lower(worker_email)', null, null,
          'clock_out_atisnullandworker_emailisnotnull'),
        ('shifts_one_open_worker_uidx', 'shifts', 1, 'field_worker_id', null, null,
          'clock_out_atisnullandfield_worker_idisnotnull'),
        ('push_tokens_device_uidx', 'push_tokens', 1, 'device_id', null, null,
          'device_idisnotnull'),
        ('live_activity_tokens_device_p2s_uidx', 'live_activity_tokens', 2, 'device_id', 'token_type', null,
          'shift_idisnullanddevice_idisnotnull'),
        ('live_activity_tokens_device_update_uidx', 'live_activity_tokens', 3, 'device_id', 'token_type', 'shift_id',
          'shift_idisnotnullanddevice_idisnotnull')
    ) as expected(index_name, table_name, key_count, key_one, key_two, key_three, predicate_tokens)
  loop
    if not exists (
      select 1
      from pg_catalog.pg_index as i
      join pg_catalog.pg_class as idx on idx.oid = i.indexrelid
      join pg_catalog.pg_class as tbl on tbl.oid = i.indrelid
      join pg_catalog.pg_namespace as ns on ns.oid = idx.relnamespace
      where ns.nspname = 'public'
        and idx.relname::text = v_index.index_name
        and idx.relkind = 'i'
        and tbl.oid = pg_catalog.to_regclass(
          pg_catalog.format('public.%I', v_index.table_name)
        )
        and idx.relowner = tbl.relowner
        and i.indisunique is true
        and i.indisvalid is true
        and i.indisready is true
        and i.indislive is true
        and i.indnkeyatts = v_index.key_count
        and i.indnatts = v_index.key_count
        and pg_catalog.pg_get_indexdef(i.indexrelid, 1, true) = v_index.key_one
        and (
          v_index.key_count < 2
          or pg_catalog.pg_get_indexdef(i.indexrelid, 2, true) = v_index.key_two
        )
        and (
          v_index.key_count < 3
          or pg_catalog.pg_get_indexdef(i.indexrelid, 3, true) = v_index.key_three
        )
        and case
          when v_index.predicate_tokens is null then i.indpred is null
          else
            i.indpred is not null
            and pg_catalog.regexp_replace(
              pg_catalog.lower(pg_catalog.pg_get_expr(i.indpred, i.indrelid)),
              '[[:space:]()]',
              '',
              'g'
            ) = v_index.predicate_tokens
        end
    ) then
      raise exception using
        errcode = '55000',
        message = pg_catalog.format(
          'rollback assertion failed: required index public.%I changed',
          v_index.index_name
        );
    end if;
  end loop;

  -- The authenticated path and service-role integrations must remain intact.
  foreach v_signature in array array[
    'public.hc_claim_field_worker()',
    'public.hc_current_worker_id()',
    'public.hc_current_worker_email()',
    'public.hc_current_worker_role()',
    'public.hc_is_active_worker()',
    'public.hc_can_manage_shifts()',
    'public.hc_is_owner()',
    'public.hc_can_access_shift(uuid)',
    'public.hc_list_managed_shifts(timestamp with time zone,integer)',
    'public.hc_start_shift(double precision,double precision,text)',
    'public.hc_clock_out_my_shift(uuid,timestamp with time zone,double precision,double precision)',
    'public.hc_manage_clock_out(uuid,timestamp with time zone,double precision,double precision)',
    'public.hc_edit_shift_times(uuid,timestamp with time zone,timestamp with time zone,timestamp with time zone,timestamp with time zone,text)',
    'public.hc_mark_shifts_paid(jsonb)',
    'public.hc_record_shift_orders(uuid,jsonb)',
    'public.hc_sync_notification_device(uuid,text,boolean,boolean)',
    'public.hc_register_live_activity_token(text,uuid,text,uuid,boolean)',
    'public.hc_unregister_device(uuid)'
  ] loop
    if pg_catalog.has_function_privilege('anon', v_signature, 'EXECUTE')
       or not pg_catalog.has_function_privilege('authenticated', v_signature, 'EXECUTE')
       or not pg_catalog.has_function_privilege('service_role', v_signature, 'EXECUTE') then
      raise exception using
        errcode = '42501',
        message = pg_catalog.format(
          'rollback assertion failed: RPC execution grants changed for %s',
          v_signature
        );
    end if;

    if not exists (
      select 1
      from pg_catalog.pg_proc as p
      where p.oid = pg_catalog.to_regprocedure(v_signature)
        and p.prosecdef is true
        and exists (
          select 1
          from pg_catalog.unnest(p.proconfig) as setting(value)
          where setting.value ~ '^search_path=(|"")$'
        )
    ) then
      raise exception using
        errcode = '42501',
        message = pg_catalog.format(
          'rollback assertion failed: SECURITY DEFINER or empty search_path lock changed for %s',
          v_signature
        );
    end if;
  end loop;

  v_function_oid := pg_catalog.to_regprocedure('public.hc_mark_shifts_paid(jsonb)');
  if not exists (
    select 1
    from pg_catalog.pg_proc as p
    where p.oid = v_function_oid
      and p.prorettype = pg_catalog.to_regtype('integer')::oid
  ) then
    raise exception using
      errcode = '55000',
      message = 'rollback assertion failed: hc_mark_shifts_paid return type changed';
  end if;

  v_function_oid := pg_catalog.to_regprocedure(
    'public.hc_list_managed_shifts(timestamp with time zone,integer)'
  );

  select p.proargnames, p.proallargtypes
  into v_arg_names, v_arg_types
  from pg_catalog.pg_proc as p
  where p.oid = v_function_oid;

  v_is_paid_position := pg_catalog.array_position(v_arg_names, 'is_paid');
  if v_is_paid_position is null
     or v_arg_types[v_is_paid_position] is distinct from pg_catalog.to_regtype('boolean')::oid
     or v_arg_names && array[
       'paid_at',
       'paid_cents',
       'paid_minutes',
       'hourly_rate_cents'
     ]::text[] then
    raise exception using
      errcode = '55000',
      message = 'rollback assertion failed: managed-shift return privacy contract changed';
  end if;

  if not pg_catalog.has_table_privilege(
    'authenticated',
    'public.shifts',
    'SELECT'
  ) or not pg_catalog.has_table_privilege(
    'service_role',
    'public.shifts',
    'SELECT'
  ) or not pg_catalog.has_column_privilege(
    'authenticated',
    'public.shift_locations',
    'shift_id',
    'INSERT'
  ) then
    raise exception using
      errcode = '42501',
      message = 'rollback assertion failed: authenticated or service-role access was not preserved';
  end if;
end
$assertions$;

commit;

-- REQUIRED MANUAL TESTS AFTER AN APPROVED EMERGENCY ROLLBACK
-- 1. A controlled legacy anon client can read the active roster and app config.
-- 2. It can start/read/close a shift and insert/read GPS and shift edit rows.
-- 3. The assignment trigger rejects an inactive or unknown email and keeps a
--    shift's worker_email and field_worker_id immutable after insertion.
-- 4. It can insert/update, but cannot read or delete, notification token rows.
-- 5. It cannot read or insert shift_orders and cannot execute authenticated RPCs.
-- 6. Authenticated team, manager, and owner flows still pass their canary tests.
-- 7. Service-role integrations still read/write, and eligible phones register
--    fresh notification tokens without any wrong-user alert delivery.

-- ============================================================================
-- 015c_notification_device_api_compatibility.sql
-- Build-26 notification API bridge while production remains on migration 015.
--
-- LOCAL MIGRATION FILE ONLY. Running this against Supabase is a production
-- write and needs Sidd's fresh, exact "yes do it" confirmation.
--
-- This bridge installs only the transition-stage device capability objects and
-- the UUID-only open-shift truth RPC already reviewed in migration 021. It does
-- not change migration 015's notification registration functions, token
-- indexes, policies, table grants, or existing token rows.
--
-- IMPORTANT: the current migration 021 must not be run after this bridge. It
-- would replace the corrected authorization function without the worker lock or
-- permanent issue marker. Prepare a new forward-only safety migration or a
-- replacement for 021 before continuing the later ordered rollout.
--
-- This bridge is not durable remote ActivityKit END delivery. It lets the
-- already-installed app authorize its phone, reconcile its existing tokens,
-- and end stale or duplicate cards locally whenever the app is foregrounded.
-- ============================================================================

begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';

create extension if not exists pgcrypto;

-- Build canonical check expressions inside this transaction. Comparing the
-- deparsed expressions below catches a same-name constraint with weaker logic
-- while avoiding PostgreSQL-version-specific formatting assumptions.
create temporary table hc_015c_expected_authorization_checks (
  revoke_secret_hash bytea,
  secret_version integer,
  revoked_at timestamptz,
  revoked_reason text,
  constraint hc_015c_expected_hash_check
    check (octet_length(revoke_secret_hash) = 32),
  constraint hc_015c_expected_version_check
    check (secret_version > 0),
  constraint hc_015c_expected_revoke_check
    check (
      (revoked_at is null and revoked_reason is null)
      or (
        revoked_at is not null
        and nullif(pg_catalog.btrim(revoked_reason), '') is not null
        and length(revoked_reason) <= 120
      )
    )
) on commit drop;

create temporary table hc_015c_expected_security_state_check (
  singleton boolean,
  constraint hc_015c_expected_singleton_check
    check (singleton is true)
) on commit drop;

do $preflight$
declare
  v_table_count integer;
  v_function_count integer;
  v_trigger_count integer;
  v_definition text;
  v_signature text;
  v_privilege text;
begin
  -- Require the exact migration-015 structures used by the bridge.
  if pg_catalog.to_regclass('auth.users') is null
     or pg_catalog.to_regclass('public.field_workers') is null
     or pg_catalog.to_regclass('public.shifts') is null
     or pg_catalog.to_regclass('public.push_tokens') is null
     or pg_catalog.to_regclass('public.live_activity_tokens') is null then
    raise exception using
      errcode = '55000',
      message = '015c requires migration 015 field and notification tables';
  end if;

  if exists (
    select 1
    from (
      values
        ('field_workers', 'id', 'uuid'),
        ('field_workers', 'email', 'text'),
        ('field_workers', 'role', 'text'),
        ('field_workers', 'active', 'bool'),
        ('field_workers', 'auth_user_id', 'uuid'),
        ('shifts', 'id', 'uuid'),
        ('shifts', 'worker_email', 'text'),
        ('shifts', 'clock_in_at', 'timestamptz'),
        ('shifts', 'clock_out_at', 'timestamptz'),
        ('push_tokens', 'email', 'text'),
        ('push_tokens', 'device_id', 'uuid'),
        ('live_activity_tokens', 'id', 'uuid'),
        ('live_activity_tokens', 'email', 'text'),
        ('live_activity_tokens', 'token_type', 'text'),
        ('live_activity_tokens', 'shift_id', 'uuid'),
        ('live_activity_tokens', 'token', 'text'),
        ('live_activity_tokens', 'updated_at', 'timestamptz'),
        ('live_activity_tokens', 'device_id', 'uuid')
    ) as required(table_name, column_name, udt_name)
    left join information_schema.columns as column_info
      on column_info.table_schema = 'public'
     and column_info.table_name = required.table_name
     and column_info.column_name = required.column_name
     and column_info.udt_name = required.udt_name
    where column_info.column_name is null
  ) then
    raise exception using
      errcode = '55000',
      message = '015c blocked: a required migration-015 column is missing or incompatible';
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name in ('push_tokens', 'live_activity_tokens')
      and column_name = 'device_id'
      and is_nullable <> 'YES'
  ) then
    raise exception using
      errcode = '55000',
      message = '015c blocked: migration-015 device identity is no longer transitional';
  end if;

  foreach v_signature in array array[
    'public.hc_can_manage_shifts()',
    'public.hc_sync_notification_device(uuid,text,boolean,boolean)',
    'public.hc_register_live_activity_token(text,uuid,text,uuid,boolean)',
    'public.hc_unregister_device(uuid)'
  ] loop
    if pg_catalog.to_regprocedure(v_signature) is null then
      raise exception using
        errcode = '55000',
        message = pg_catalog.format(
          '015c blocked: required migration-015 RPC %s is missing',
          v_signature
        );
    end if;
  end loop;

  foreach v_signature in array array[
    'public.hc_sync_notification_device(uuid,text,boolean,boolean)',
    'public.hc_register_live_activity_token(text,uuid,text,uuid,boolean)',
    'public.hc_unregister_device(uuid)'
  ] loop
    if pg_catalog.has_function_privilege('anon', v_signature, 'EXECUTE')
       or not pg_catalog.has_function_privilege(
         'authenticated', v_signature, 'EXECUTE'
       )
       or not pg_catalog.has_function_privilege(
         'service_role', v_signature, 'EXECUTE'
       )
       or not exists (
         select 1
         from pg_catalog.pg_proc as function_info
         where function_info.oid = pg_catalog.to_regprocedure(v_signature)
           and function_info.prosecdef is true
           and exists (
             select 1
             from pg_catalog.unnest(function_info.proconfig) as setting(value)
             where setting.value like 'search_path=%'
           )
       ) then
      raise exception using
        errcode = '42501',
        message = pg_catalog.format(
          '015c blocked: migration-015 RPC %s is not hardened',
          v_signature
        );
    end if;
  end loop;

  foreach v_signature in array array[
    'public.hc_register_push_token(text,text)',
    'public.hc_register_live_activity_token(text,uuid,text)',
    'public.hc_unregister_device()'
  ] loop
    if pg_catalog.to_regprocedure(v_signature) is not null then
      raise exception using
        errcode = '55000',
        message = pg_catalog.format(
          '015c blocked: obsolete notification RPC %s still exists',
          v_signature
        );
    end if;
  end loop;

  if pg_catalog.to_regclass('public.field_workers_auth_user_uidx') is null
     or pg_catalog.to_regclass('public.push_tokens_pkey') is null
     or pg_catalog.to_regclass('public.push_tokens_device_uidx') is null
     or pg_catalog.to_regclass('public.live_activity_tokens_p2s_uniq') is null
     or pg_catalog.to_regclass('public.live_activity_tokens_upd_uniq') is null
     or pg_catalog.to_regclass(
       'public.live_activity_tokens_device_p2s_uidx'
     ) is null
     or pg_catalog.to_regclass(
       'public.live_activity_tokens_device_update_uidx'
     ) is null then
    raise exception using
      errcode = '55000',
      message = '015c blocked: migration-015 worker or notification uniqueness is incomplete';
  end if;

  -- Authorization selects one worker by Auth identity. Require migration 015's
  -- exact partial unique index so LIMIT 1 can never hide duplicate links.
  if not exists (
    select 1
    from pg_catalog.pg_index as index_info
    join pg_catalog.pg_class as index_class
      on index_class.oid = index_info.indexrelid
    join pg_catalog.pg_class as table_class
      on table_class.oid = index_info.indrelid
    join pg_catalog.pg_namespace as namespace_info
      on namespace_info.oid = index_class.relnamespace
    join pg_catalog.pg_am as access_method
      on access_method.oid = index_class.relam
    where namespace_info.nspname = 'public'
      and index_class.relname = 'field_workers_auth_user_uidx'
      and index_class.relkind = 'i'
      and table_class.oid = 'public.field_workers'::pg_catalog.regclass
      and index_class.relowner = table_class.relowner
      and access_method.amname = 'btree'
      and index_info.indisunique is true
      and index_info.indisprimary is false
      and index_info.indisexclusion is false
      and index_info.indimmediate is true
      and index_info.indisvalid is true
      and index_info.indisready is true
      and index_info.indislive is true
      and index_info.indnkeyatts = 1
      and index_info.indnatts = 1
      and index_info.indexprs is null
      and index_info.indpred is not null
      and pg_catalog.pg_get_indexdef(
        index_info.indexrelid, 1, true
      ) = 'auth_user_id'
      and pg_catalog.regexp_replace(
        pg_catalog.lower(
          pg_catalog.pg_get_expr(index_info.indpred, index_info.indrelid)
        ),
        '[[:space:]()]',
        '',
        'g'
      ) = 'auth_user_idisnotnull'
  ) then
    raise exception using
      errcode = '55000',
      message = '015c blocked: migration-015 worker Auth uniqueness is incompatible';
  end if;

  -- This bridge must never overwrite the later durable END, START, capability
  -- cutover, or manager-market implementations.
  if pg_catalog.to_regprocedure(
       'public.hc_claim_live_activity_ends(timestamp with time zone,timestamp with time zone,integer)'
     ) is not null
     or pg_catalog.to_regprocedure(
       'public.hc_claim_live_activity_starts(timestamp with time zone,timestamp with time zone,timestamp with time zone,integer)'
     ) is not null
     or pg_catalog.to_regprocedure(
       'public.hc_validate_live_activity_start_delivery(uuid,uuid,uuid,integer,text)'
     ) is not null
     or pg_catalog.to_regprocedure(
       'public.hc_enforce_notification_destination_authorization()'
     ) is not null
     or pg_catalog.to_regprocedure(
       'public.hc_management_can_access_shift_market(text,text,text)'
     ) is not null then
    raise exception using
      errcode = '55000',
      message = '015c blocked: a later notification or manager migration is already present';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_extension
    where extname = 'pgcrypto'
  ) then
    raise exception using
      errcode = '55000',
      message = '015c requires pgcrypto';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_extension as extension_info
    join pg_catalog.pg_proc as function_info
      on function_info.pronamespace = extension_info.extnamespace
    where extension_info.extname = 'pgcrypto'
      and function_info.proname = 'gen_random_bytes'
      and pg_catalog.pg_get_function_identity_arguments(function_info.oid) =
          'integer'
  ) or not exists (
    select 1
    from pg_catalog.pg_extension as extension_info
    join pg_catalog.pg_proc as function_info
      on function_info.pronamespace = extension_info.extnamespace
    where extension_info.extname = 'pgcrypto'
      and function_info.proname = 'digest'
      and pg_catalog.pg_get_function_identity_arguments(function_info.oid) =
          'bytea, text'
  ) then
    raise exception using
      errcode = '55000',
      message = '015c requires pgcrypto gen_random_bytes(integer) and digest(bytea,text)';
  end if;

  select count(*)
  into v_table_count
  from (
    values
      ('public.notification_device_authorizations'),
      ('public.notification_device_security_state')
  ) as expected(name)
  where pg_catalog.to_regclass(expected.name) is not null;

  if v_table_count = 1 then
    raise exception using
      errcode = '55000',
      message = '015c blocked: notification capability tables are in a mixed state';
  end if;

  select count(*)
  into v_function_count
  from (
    values
      ('public.hc_notification_random_secret()'),
      ('public.hc_notification_secret_hash(text)'),
      ('public.hc_purge_revoked_notification_device()'),
      ('public.hc_revoke_ineligible_worker_devices()'),
      ('public.hc_authorize_notification_device(uuid)'),
      ('public.hc_revoke_notification_device(uuid,text)')
  ) as expected(signature)
  where pg_catalog.to_regprocedure(expected.signature) is not null;

  select count(*)
  into v_trigger_count
  from pg_catalog.pg_trigger as trigger_info
  where not trigger_info.tgisinternal
    and trigger_info.tgenabled <> 'D'
    and (
      (
        trigger_info.tgrelid =
          pg_catalog.to_regclass('public.notification_device_authorizations')
        and trigger_info.tgname = 'notification_device_authorizations_purge'
      )
      or (
        trigger_info.tgrelid = 'public.field_workers'::pg_catalog.regclass
        and trigger_info.tgname = 'field_workers_revoke_notification_devices'
      )
    );

  if v_table_count = 0 then
    -- A guarded rollback deliberately leaves only the harmless open-shift RPC.
    if v_function_count <> 0 or v_trigger_count <> 0 then
      raise exception using
        errcode = '55000',
        message = '015c blocked: orphaned capability functions or triggers exist';
    end if;
  else
    if v_function_count <> 6
       or v_trigger_count <> 2
       or pg_catalog.to_regprocedure(
            'public.hc_list_managed_open_shift_ids()'
          ) is null then
      raise exception using
        errcode = '55000',
        message = '015c blocked: installed capability objects are incomplete';
    end if;

    if exists (
      select 1
      from public.notification_device_security_state
      where singleton is true
        and cutover_at is not null
    ) then
      raise exception using
        errcode = '55000',
        message = '015c blocked: notification authorization cutover is already enforced';
    end if;

    if exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'notification_device_authorizations'
        and column_name in ('revoke_secret', 'capability_secret', 'secret')
    ) then
      raise exception using
        errcode = '42501',
        message = '015c blocked: a plaintext capability column exists';
    end if;

    if (
      select count(*)
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'notification_device_authorizations'
        and column_name in (
          'device_id', 'auth_user_id', 'field_worker_id',
          'revoke_secret_hash', 'secret_version', 'authorized_at',
          'last_registered_at', 'revoked_at', 'revoked_reason',
          'created_at', 'updated_at'
        )
    ) <> 11
       or (
         select count(*)
         from information_schema.columns
         where table_schema = 'public'
           and table_name = 'notification_device_authorizations'
       ) <> 11
       or (
         select count(*)
         from information_schema.columns
         where table_schema = 'public'
           and table_name = 'notification_device_security_state'
           and column_name in (
             'singleton', 'transition_installed_at', 'ever_issued_at',
             'cutover_at'
           )
       ) <> 4
       or (
         select count(*)
         from information_schema.columns
         where table_schema = 'public'
           and table_name = 'notification_device_security_state'
       ) <> 4 then
      raise exception using
        errcode = '55000',
        message = '015c blocked: installed capability table shape is incompatible';
    end if;

    if (
      select count(*)
      from public.notification_device_security_state
    ) <> 1 or not exists (
      select 1
      from public.notification_device_security_state
      where singleton is true
        and transition_installed_at is not null
        and cutover_at is null
    ) or (
      exists (
        select 1
        from public.notification_device_authorizations
      )
      and not exists (
        select 1
        from public.notification_device_security_state
        where singleton is true
          and ever_issued_at is not null
      )
    ) then
      raise exception using
        errcode = '55000',
        message = '015c blocked: installed capability security history is invalid';
    end if;

    -- CREATE TABLE/INDEX IF NOT EXISTS must never silently accept a drifted
    -- same-name key, index, or check expression on an idempotent re-run.
    if exists (
      select 1
      from (
        values
          (
            'notification_device_authorizations_pkey',
            'notification_device_authorizations',
            true, true, 1, 'device_id', null
          ),
          (
            'notification_device_authorizations_user_idx',
            'notification_device_authorizations',
            false, false, 2, 'auth_user_id', 'revoked_at'
          ),
          (
            'notification_device_authorizations_worker_idx',
            'notification_device_authorizations',
            false, false, 2, 'field_worker_id', 'revoked_at'
          ),
          (
            'notification_device_security_state_pkey',
            'notification_device_security_state',
            true, true, 1, 'singleton', null
          )
      ) as expected(
        index_name, table_name, is_unique, is_primary, key_count,
        key_one, key_two
      )
      where not exists (
        select 1
        from pg_catalog.pg_index as index_info
        join pg_catalog.pg_class as index_class
          on index_class.oid = index_info.indexrelid
        join pg_catalog.pg_class as table_class
          on table_class.oid = index_info.indrelid
        join pg_catalog.pg_namespace as namespace_info
          on namespace_info.oid = index_class.relnamespace
        join pg_catalog.pg_am as access_method
          on access_method.oid = index_class.relam
        where namespace_info.nspname = 'public'
          and index_class.relname::text = expected.index_name
          and index_class.relkind = 'i'
          and table_class.oid = pg_catalog.to_regclass(
            pg_catalog.format('public.%I', expected.table_name)
          )
          and index_class.relowner = table_class.relowner
          and access_method.amname = 'btree'
          and index_info.indisunique = expected.is_unique
          and index_info.indisprimary = expected.is_primary
          and index_info.indisexclusion is false
          and index_info.indimmediate is true
          and index_info.indisvalid is true
          and index_info.indisready is true
          and index_info.indislive is true
          and index_info.indnkeyatts = expected.key_count
          and index_info.indnatts = expected.key_count
          and index_info.indexprs is null
          and index_info.indpred is null
          and pg_catalog.pg_get_indexdef(
            index_info.indexrelid, 1, true
          ) = expected.key_one
          and (
            expected.key_count < 2
            or pg_catalog.pg_get_indexdef(
              index_info.indexrelid, 2, true
            ) = expected.key_two
          )
      )
    ) then
      raise exception using
        errcode = '55000',
        message = '015c blocked: installed capability index definition is incompatible';
    end if;

    if not exists (
      select 1
      from pg_catalog.pg_constraint as constraint_info
      where constraint_info.conrelid =
            'public.notification_device_authorizations'::pg_catalog.regclass
        and constraint_info.conname =
            'notification_device_authorizations_pkey'
        and constraint_info.contype = 'p'
        and constraint_info.conindid =
            'public.notification_device_authorizations_pkey'::pg_catalog.regclass
        and constraint_info.conkey = array[
          (
            select attribute_info.attnum
            from pg_catalog.pg_attribute as attribute_info
            where attribute_info.attrelid = constraint_info.conrelid
              and attribute_info.attname = 'device_id'
              and not attribute_info.attisdropped
          )
        ]
        and not constraint_info.condeferrable
        and not constraint_info.condeferred
        and constraint_info.convalidated
    ) or not exists (
      select 1
      from pg_catalog.pg_constraint as constraint_info
      where constraint_info.conrelid =
            'public.notification_device_security_state'::pg_catalog.regclass
        and constraint_info.conname =
            'notification_device_security_state_pkey'
        and constraint_info.contype = 'p'
        and constraint_info.conindid =
            'public.notification_device_security_state_pkey'::pg_catalog.regclass
        and constraint_info.conkey = array[
          (
            select attribute_info.attnum
            from pg_catalog.pg_attribute as attribute_info
            where attribute_info.attrelid = constraint_info.conrelid
              and attribute_info.attname = 'singleton'
              and not attribute_info.attisdropped
          )
        ]
        and not constraint_info.condeferrable
        and not constraint_info.condeferred
        and constraint_info.convalidated
    ) or not exists (
      select 1
      from pg_catalog.pg_constraint as constraint_info
      where constraint_info.conrelid =
            'public.notification_device_authorizations'::pg_catalog.regclass
        and constraint_info.conname =
            'notification_device_authorizations_auth_user_id_fkey'
        and constraint_info.contype = 'f'
        and constraint_info.confrelid = 'auth.users'::pg_catalog.regclass
        and constraint_info.conkey = array[
          (
            select attribute_info.attnum
            from pg_catalog.pg_attribute as attribute_info
            where attribute_info.attrelid = constraint_info.conrelid
              and attribute_info.attname = 'auth_user_id'
              and not attribute_info.attisdropped
          )
        ]
        and constraint_info.confkey = array[
          (
            select attribute_info.attnum
            from pg_catalog.pg_attribute as attribute_info
            where attribute_info.attrelid = constraint_info.confrelid
              and attribute_info.attname = 'id'
              and not attribute_info.attisdropped
          )
        ]
        and constraint_info.confupdtype = 'a'
        and constraint_info.confdeltype = 'c'
        and constraint_info.confmatchtype = 's'
        and not constraint_info.condeferrable
        and not constraint_info.condeferred
        and constraint_info.convalidated
    ) or not exists (
      select 1
      from pg_catalog.pg_constraint as constraint_info
      where constraint_info.conrelid =
            'public.notification_device_authorizations'::pg_catalog.regclass
        and constraint_info.conname =
            'notification_device_authorizations_field_worker_id_fkey'
        and constraint_info.contype = 'f'
        and constraint_info.confrelid =
            'public.field_workers'::pg_catalog.regclass
        and constraint_info.conkey = array[
          (
            select attribute_info.attnum
            from pg_catalog.pg_attribute as attribute_info
            where attribute_info.attrelid = constraint_info.conrelid
              and attribute_info.attname = 'field_worker_id'
              and not attribute_info.attisdropped
          )
        ]
        and constraint_info.confkey = array[
          (
            select attribute_info.attnum
            from pg_catalog.pg_attribute as attribute_info
            where attribute_info.attrelid = constraint_info.confrelid
              and attribute_info.attname = 'id'
              and not attribute_info.attisdropped
          )
        ]
        and constraint_info.confupdtype = 'a'
        and constraint_info.confdeltype = 'c'
        and constraint_info.confmatchtype = 's'
        and not constraint_info.condeferrable
        and not constraint_info.condeferred
        and constraint_info.convalidated
    ) then
      raise exception using
        errcode = '55000',
        message = '015c blocked: installed capability key definition is incompatible';
    end if;

    if exists (
      select 1
      from (
        values
          (
            'notification_device_authorizations',
            'notification_device_authorizations_hash_check',
            'hc_015c_expected_authorization_checks',
            'hc_015c_expected_hash_check'
          ),
          (
            'notification_device_authorizations',
            'notification_device_authorizations_version_check',
            'hc_015c_expected_authorization_checks',
            'hc_015c_expected_version_check'
          ),
          (
            'notification_device_authorizations',
            'notification_device_authorizations_revoke_check',
            'hc_015c_expected_authorization_checks',
            'hc_015c_expected_revoke_check'
          ),
          (
            'notification_device_security_state',
            'notification_device_security_state_singleton_check',
            'hc_015c_expected_security_state_check',
            'hc_015c_expected_singleton_check'
          )
      ) as expected(
        table_name, constraint_name, expected_table_name,
        expected_constraint_name
      )
      where not exists (
        select 1
        from pg_catalog.pg_constraint as actual_constraint
        join pg_catalog.pg_constraint as expected_constraint
          on expected_constraint.conrelid = pg_catalog.to_regclass(
               'pg_temp.' || expected.expected_table_name
             )
         and expected_constraint.conname = expected.expected_constraint_name
        where actual_constraint.conrelid = pg_catalog.to_regclass(
                'public.' || expected.table_name
              )
          and actual_constraint.conname = expected.constraint_name
          and actual_constraint.contype = 'c'
          and actual_constraint.convalidated
          and not actual_constraint.connoinherit
          and pg_catalog.pg_get_expr(
                actual_constraint.conbin,
                actual_constraint.conrelid,
                false
              ) = pg_catalog.pg_get_expr(
                expected_constraint.conbin,
                expected_constraint.conrelid,
                false
              )
      )
    ) or (
      select count(*)
      from pg_catalog.pg_constraint as constraint_info
      where constraint_info.conrelid =
            'public.notification_device_authorizations'::pg_catalog.regclass
    ) <> 6 or (
      select count(*)
      from pg_catalog.pg_constraint as constraint_info
      where constraint_info.conrelid =
            'public.notification_device_security_state'::pg_catalog.regclass
    ) <> 2 then
      raise exception using
        errcode = '55000',
        message = '015c blocked: installed capability constraint definition is incompatible';
    end if;

    if exists (
      select 1
      from pg_catalog.pg_policies as policy_info
      where policy_info.schemaname = 'public'
        and policy_info.tablename in (
          'notification_device_authorizations',
          'notification_device_security_state'
        )
    ) or not exists (
      select 1
      from pg_catalog.pg_class as table_info
      where table_info.oid =
            'public.notification_device_authorizations'::pg_catalog.regclass
        and table_info.relrowsecurity
    ) or not exists (
      select 1
      from pg_catalog.pg_class as table_info
      where table_info.oid =
            'public.notification_device_security_state'::pg_catalog.regclass
        and table_info.relrowsecurity
    ) then
      raise exception using
        errcode = '42501',
        message = '015c blocked: installed capability-table privacy is incompatible';
    end if;

    foreach v_privilege in array array[
      'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
    ] loop
      if pg_catalog.has_table_privilege(
           'anon',
           'public.notification_device_authorizations',
           v_privilege
         )
         or pg_catalog.has_table_privilege(
           'authenticated',
           'public.notification_device_authorizations',
           v_privilege
         )
         or pg_catalog.has_table_privilege(
           'anon',
           'public.notification_device_security_state',
           v_privilege
         )
         or pg_catalog.has_table_privilege(
           'authenticated',
           'public.notification_device_security_state',
           v_privilege
         ) then
        raise exception using
          errcode = '42501',
          message = pg_catalog.format(
            '015c blocked: a client retains private-table %s',
            v_privilege
          );
      end if;
    end loop;

    foreach v_privilege in array array[
      'SELECT', 'INSERT', 'UPDATE', 'REFERENCES'
    ] loop
      if pg_catalog.has_any_column_privilege(
           'anon',
           'public.notification_device_authorizations',
           v_privilege
         )
         or pg_catalog.has_any_column_privilege(
           'authenticated',
           'public.notification_device_authorizations',
           v_privilege
         )
         or pg_catalog.has_any_column_privilege(
           'anon',
           'public.notification_device_security_state',
           v_privilege
         )
         or pg_catalog.has_any_column_privilege(
           'authenticated',
           'public.notification_device_security_state',
           v_privilege
         ) then
        raise exception using
          errcode = '42501',
          message = pg_catalog.format(
            '015c blocked: a client retains private-column %s',
            v_privilege
          );
      end if;
    end loop;

    foreach v_signature in array array[
      'public.hc_notification_random_secret()',
      'public.hc_notification_secret_hash(text)',
      'public.hc_purge_revoked_notification_device()',
      'public.hc_revoke_ineligible_worker_devices()',
      'public.hc_authorize_notification_device(uuid)',
      'public.hc_revoke_notification_device(uuid,text)'
    ] loop
      if not exists (
        select 1
        from pg_catalog.pg_proc as function_info
        where function_info.oid = pg_catalog.to_regprocedure(v_signature)
          and function_info.prosecdef is true
          and exists (
            select 1
            from pg_catalog.unnest(function_info.proconfig) as setting(value)
            where setting.value like 'search_path=%'
          )
      ) then
        raise exception using
          errcode = '42501',
          message = pg_catalog.format(
            '015c blocked: installed capability function %s is not hardened',
            v_signature
          );
      end if;
    end loop;

    if pg_catalog.has_function_privilege(
         'anon', 'public.hc_authorize_notification_device(uuid)', 'EXECUTE'
       )
       or not pg_catalog.has_function_privilege(
         'authenticated',
         'public.hc_authorize_notification_device(uuid)',
         'EXECUTE'
       )
       or not pg_catalog.has_function_privilege(
         'anon',
         'public.hc_revoke_notification_device(uuid,text)',
         'EXECUTE'
       )
       or not pg_catalog.has_function_privilege(
         'authenticated',
         'public.hc_revoke_notification_device(uuid,text)',
         'EXECUTE'
       ) then
      raise exception using
        errcode = '42501',
        message = '015c blocked: installed capability RPC grants are incompatible';
    end if;

    if pg_catalog.pg_get_functiondef(
         'public.hc_authorize_notification_device(uuid)'::pg_catalog.regprocedure
       ) !~* 'on conflict[[:space:]]+on constraint[[:space:]]+notification_device_authorizations_pkey'
       or pg_catalog.regexp_replace(
         pg_catalog.pg_get_functiondef(
           'public.hc_authorize_notification_device(uuid)'::pg_catalog.regprocedure
         ),
         '[[:space:]]+',
         ' ',
         'g'
       ) !~* 'from public[.]field_workers as fw .* limit 1 for update'
       or pg_catalog.pg_get_functiondef(
         'public.hc_authorize_notification_device(uuid)'::pg_catalog.regprocedure
       ) !~ 'set ever_issued_at = coalesce'
       or pg_catalog.pg_get_functiondef(
         'public.hc_revoke_notification_device(uuid,text)'::pg_catalog.regprocedure
       ) !~ 'token_type = ''push_to_start'''
       or pg_catalog.pg_get_functiondef(
         'public.hc_revoke_notification_device(uuid,text)'::pg_catalog.regprocedure
       ) !~ 'if v_matched is true then'
       or pg_catalog.pg_get_functiondef(
         'public.hc_revoke_notification_device(uuid,text)'::pg_catalog.regprocedure
       ) !~ 'return coalesce[(]v_matched, false[)];'
       or pg_catalog.pg_get_functiondef(
         'public.hc_revoke_notification_device(uuid,text)'::pg_catalog.regprocedure
       ) ~ 'token_type = ''activity_update''' then
      raise exception using
        errcode = '55000',
        message = '015c blocked: installed capability behavior is incompatible';
    end if;
  end if;

  -- A list-only state is the expected guarded rollback state. Any existing
  -- copy must still be this bridge's unscoped implementation.
  if pg_catalog.to_regprocedure(
       'public.hc_list_managed_open_shift_ids()'
     ) is not null then
    select pg_catalog.pg_get_functiondef(
      'public.hc_list_managed_open_shift_ids()'::pg_catalog.regprocedure
    ) into v_definition;

    if v_definition !~ 'hc_can_manage_shifts'
       or v_definition !~ 'appreview@hamptonscoconuts[.]com'
       or v_definition ~ 'hc_management_can_access_shift_market'
       or pg_catalog.has_function_privilege(
         'anon', 'public.hc_list_managed_open_shift_ids()', 'EXECUTE'
       )
       or not pg_catalog.has_function_privilege(
         'authenticated',
         'public.hc_list_managed_open_shift_ids()',
         'EXECUTE'
       ) then
      raise exception using
        errcode = '42501',
        message = '015c blocked: existing open-shift RPC is incompatible';
    end if;
  end if;
end
$preflight$;

-- Roster updates lock field_workers before their revocation trigger writes the
-- capability table. Follow that same order to avoid a cross-table deadlock.
lock table public.field_workers in share row exclusive mode;

-- On an idempotent re-run, block capability writes after the roster lock and
-- before taking token locks below.
do $optional_capability_locks$
begin
  if pg_catalog.to_regclass(
       'public.notification_device_authorizations'
     ) is not null then
    execute
      'lock table public.notification_device_authorizations, ' ||
      'public.notification_device_security_state ' ||
      'in share row exclusive mode';
  end if;
end
$optional_capability_locks$;

-- Block roster and token writers so the postflight can prove this migration
-- changed no existing destination or migration-015 function definition.
lock table
  public.shifts,
  public.push_tokens,
  public.live_activity_tokens
in share row exclusive mode;

create temporary table hc_015c_baseline (
  push_token_count bigint not null,
  live_token_count bigint not null,
  can_manage_definition text not null,
  sync_definition text not null,
  register_definition text not null,
  unregister_definition text not null,
  legacy_p2s_index text not null,
  legacy_update_index text not null,
  device_p2s_index text not null,
  device_update_index text not null
) on commit drop;

insert into hc_015c_baseline
select
  (select count(*) from public.push_tokens),
  (select count(*) from public.live_activity_tokens),
  pg_catalog.pg_get_functiondef(
    'public.hc_can_manage_shifts()'::pg_catalog.regprocedure
  ),
  pg_catalog.pg_get_functiondef(
    'public.hc_sync_notification_device(uuid,text,boolean,boolean)'::pg_catalog.regprocedure
  ),
  pg_catalog.pg_get_functiondef(
    'public.hc_register_live_activity_token(text,uuid,text,uuid,boolean)'::pg_catalog.regprocedure
  ),
  pg_catalog.pg_get_functiondef(
    'public.hc_unregister_device(uuid)'::pg_catalog.regprocedure
  ),
  pg_catalog.pg_get_indexdef(
    'public.live_activity_tokens_p2s_uniq'::pg_catalog.regclass
  ),
  pg_catalog.pg_get_indexdef(
    'public.live_activity_tokens_upd_uniq'::pg_catalog.regclass
  ),
  pg_catalog.pg_get_indexdef(
    'public.live_activity_tokens_device_p2s_uidx'::pg_catalog.regclass
  ),
  pg_catalog.pg_get_indexdef(
    'public.live_activity_tokens_device_update_uidx'::pg_catalog.regclass
  );

-- pgcrypto lives in the extensions schema on Supabase but may live in public
-- on a local PostgreSQL clone. These private wrappers resolve that schema from
-- pg_catalog instead of trusting search_path.
create or replace function public.hc_notification_random_secret()
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_extension_schema text;
  v_secret text;
begin
  select namespace_info.nspname
  into v_extension_schema
  from pg_catalog.pg_extension as extension_info
  join pg_catalog.pg_namespace as namespace_info
    on namespace_info.oid = extension_info.extnamespace
  where extension_info.extname = 'pgcrypto';

  if v_extension_schema is null then
    raise exception using
      errcode = '55000',
      message = 'pgcrypto extension is unavailable';
  end if;

  execute pg_catalog.format(
    'select pg_catalog.encode(%I.gen_random_bytes(32), ''hex'')',
    v_extension_schema
  ) into v_secret;

  if v_secret is null
     or length(v_secret) <> 64
     or v_secret !~ '^[0-9a-f]{64}$' then
    raise exception using
      errcode = '55000',
      message = 'failed to generate a 32-byte notification capability';
  end if;

  return v_secret;
end
$function$;

create or replace function public.hc_notification_secret_hash(p_secret text)
returns bytea
language plpgsql
stable
strict
security definer
set search_path = ''
as $function$
declare
  v_extension_schema text;
  v_hash bytea;
begin
  select namespace_info.nspname
  into v_extension_schema
  from pg_catalog.pg_extension as extension_info
  join pg_catalog.pg_namespace as namespace_info
    on namespace_info.oid = extension_info.extnamespace
  where extension_info.extname = 'pgcrypto';

  if v_extension_schema is null then
    raise exception using
      errcode = '55000',
      message = 'pgcrypto extension is unavailable';
  end if;

  execute pg_catalog.format(
    'select %I.digest(pg_catalog.convert_to($1, ''UTF8''), ''sha256'')',
    v_extension_schema
  ) into v_hash using p_secret;

  return v_hash;
end
$function$;

revoke all on function public.hc_notification_random_secret()
  from public, anon, authenticated, service_role;
revoke all on function public.hc_notification_secret_hash(text)
  from public, anon, authenticated, service_role;

-- One row represents one physical-device UUID. Only a SHA-256 hash of the
-- 32-byte revoke capability is stored. The raw value is returned once to the
-- authenticated app and belongs only in iOS SecureStore.
create table if not exists public.notification_device_authorizations (
  device_id          uuid primary key,
  auth_user_id       uuid not null references auth.users(id) on delete cascade,
  field_worker_id    uuid not null references public.field_workers(id) on delete cascade,
  revoke_secret_hash bytea not null,
  secret_version     integer not null default 1,
  authorized_at      timestamptz not null default clock_timestamp(),
  last_registered_at timestamptz,
  revoked_at         timestamptz,
  revoked_reason     text,
  created_at         timestamptz not null default clock_timestamp(),
  updated_at         timestamptz not null default clock_timestamp(),
  constraint notification_device_authorizations_hash_check
    check (octet_length(revoke_secret_hash) = 32),
  constraint notification_device_authorizations_version_check
    check (secret_version > 0),
  constraint notification_device_authorizations_revoke_check
    check (
      (revoked_at is null and revoked_reason is null)
      or (
        revoked_at is not null
        and nullif(pg_catalog.btrim(revoked_reason), '') is not null
        and length(revoked_reason) <= 120
      )
    )
);

create index if not exists notification_device_authorizations_user_idx
  on public.notification_device_authorizations (auth_user_id, revoked_at);

create index if not exists notification_device_authorizations_worker_idx
  on public.notification_device_authorizations (field_worker_id, revoked_at);

alter table public.notification_device_authorizations enable row level security;
revoke all on table public.notification_device_authorizations
  from public, anon, authenticated, service_role;
grant select, insert, update, delete
  on table public.notification_device_authorizations to service_role;

create table if not exists public.notification_device_security_state (
  singleton               boolean primary key default true,
  transition_installed_at timestamptz not null default clock_timestamp(),
  ever_issued_at          timestamptz,
  cutover_at              timestamptz,
  constraint notification_device_security_state_singleton_check
    check (singleton is true)
);

insert into public.notification_device_security_state (singleton)
values (true)
on conflict (singleton) do nothing;

alter table public.notification_device_security_state enable row level security;
revoke all on table public.notification_device_security_state
  from public, anon, authenticated, service_role;
grant select, insert, update, delete
  on table public.notification_device_security_state to service_role;

-- Revocation removes ordinary push and Push-to-Start for exactly one phone.
-- Activity Update rows survive so a later END worker can still close a card.
create or replace function public.hc_purge_revoked_notification_device()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_device_id uuid;
  v_should_purge boolean := false;
begin
  if tg_op = 'DELETE' then
    v_device_id := old.device_id;
    v_should_purge := true;
  else
    v_device_id := new.device_id;
    v_should_purge := new.revoked_at is not null
      or new.auth_user_id is distinct from old.auth_user_id
      or new.field_worker_id is distinct from old.field_worker_id;
  end if;

  if v_should_purge then
    delete from public.push_tokens
    where device_id = v_device_id;

    delete from public.live_activity_tokens
    where device_id = v_device_id
      and token_type = 'push_to_start'
      and shift_id is null;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end
$function$;

revoke all on function public.hc_purge_revoked_notification_device()
  from public, anon, authenticated, service_role;

drop trigger if exists notification_device_authorizations_purge
  on public.notification_device_authorizations;
create trigger notification_device_authorizations_purge
after update of auth_user_id, field_worker_id, revoked_at
or delete on public.notification_device_authorizations
for each row
execute function public.hc_purge_revoked_notification_device();

-- A roster downgrade, deactivation, relink, or email change revokes every
-- capability for that worker and invokes the exact-device purge above.
create or replace function public.hc_revoke_ineligible_worker_devices()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.active is not true
     or new.role not in ('owner', 'manager')
     or new.auth_user_id is null
     or new.auth_user_id is distinct from old.auth_user_id
     or lower(new.email) is distinct from lower(old.email) then
    update public.notification_device_authorizations as device_auth
    set revoked_at = coalesce(device_auth.revoked_at, clock_timestamp()),
        revoked_reason = coalesce(
          device_auth.revoked_reason,
          'field worker eligibility changed'
        ),
        updated_at = clock_timestamp()
    where device_auth.field_worker_id = old.id;
  end if;

  return new;
end
$function$;

revoke all on function public.hc_revoke_ineligible_worker_devices()
  from public, anon, authenticated, service_role;

drop trigger if exists field_workers_revoke_notification_devices
  on public.field_workers;
create trigger field_workers_revoke_notification_devices
after update of active, role, auth_user_id, email
on public.field_workers
for each row
execute function public.hc_revoke_ineligible_worker_devices();

-- Active, linked owners and managers can create or rotate one capability for
-- an exact physical-device UUID. A lost response is safe because retrying
-- rotates again and returns the only secret that remains valid.
create or replace function public.hc_authorize_notification_device(
  p_device_id uuid
)
returns table (
  device_id uuid,
  revoke_secret text,
  secret_version integer,
  authorized_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_worker_id uuid;
  v_prior_auth_user_id uuid;
  v_secret text;
  v_hash bytea;
  v_secret_version integer;
  v_authorized_at timestamptz := clock_timestamp();
begin
  if auth.uid() is null then
    raise exception using
      errcode = '42501',
      message = 'authenticated Supabase user required';
  end if;

  if p_device_id is null then
    raise exception using
      errcode = '22023',
      message = 'device ID is required';
  end if;

  select fw.id
  into v_worker_id
  from public.field_workers as fw
  where fw.auth_user_id = auth.uid()
    and fw.active is true
    and fw.role in ('owner', 'manager')
  limit 1
  for update of fw;

  if v_worker_id is null then
    raise exception using
      errcode = '42501',
      message = 'active owner or manager required';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'hc-notification-device:' || p_device_id::text,
      0
    )
  );

  select device_auth.auth_user_id
  into v_prior_auth_user_id
  from public.notification_device_authorizations as device_auth
  where device_auth.device_id = p_device_id
  for update;

  v_secret := public.hc_notification_random_secret();
  v_hash := public.hc_notification_secret_hash(v_secret);

  insert into public.notification_device_authorizations as device_auth (
    device_id,
    auth_user_id,
    field_worker_id,
    revoke_secret_hash,
    secret_version,
    authorized_at,
    last_registered_at,
    revoked_at,
    revoked_reason,
    updated_at
  ) values (
    p_device_id,
    auth.uid(),
    v_worker_id,
    v_hash,
    1,
    v_authorized_at,
    null,
    null,
    null,
    v_authorized_at
  )
  on conflict on constraint notification_device_authorizations_pkey do update
  set auth_user_id = excluded.auth_user_id,
      field_worker_id = excluded.field_worker_id,
      revoke_secret_hash = excluded.revoke_secret_hash,
      secret_version = device_auth.secret_version + 1,
      authorized_at = excluded.authorized_at,
      last_registered_at = case
        when device_auth.auth_user_id = excluded.auth_user_id
         and device_auth.field_worker_id = excluded.field_worker_id
          then device_auth.last_registered_at
        else null
      end,
      revoked_at = null,
      revoked_reason = null,
      updated_at = excluded.updated_at
  returning device_auth.secret_version
  into v_secret_version;

  -- This first-issue marker survives authorization-row cascades. It is updated
  -- in the same transaction as the successful capability upsert, so rollback
  -- can never mistake a previously used bridge for an unused one.
  update public.notification_device_security_state as security_state
  set ever_issued_at = coalesce(
        security_state.ever_issued_at,
        v_authorized_at
      )
  where security_state.singleton is true;

  if not found then
    raise exception using
      errcode = '55000',
      message = 'notification device security state is missing';
  end if;

  if v_prior_auth_user_id is not null
     and v_prior_auth_user_id is distinct from auth.uid() then
    delete from public.push_tokens as push_token
    where push_token.device_id = p_device_id;
    delete from public.live_activity_tokens as live_token
    where live_token.device_id = p_device_id
      and live_token.token_type = 'push_to_start'
      and live_token.shift_id is null;
  end if;

  return query
  select p_device_id, v_secret, v_secret_version, v_authorized_at;
end
$function$;

-- This bearer-capability RPC intentionally works after the Auth session is
-- gone. Wrong, malformed, old, or rotated secrets change no state.
create or replace function public.hc_revoke_notification_device(
  p_device_id uuid,
  p_revoke_secret text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_hash bytea;
  v_matched boolean := false;
begin
  if p_device_id is null
     or p_revoke_secret is null
     or length(p_revoke_secret) <> 64
     or p_revoke_secret !~ '^[0-9a-f]{64}$' then
    return false;
  end if;

  v_hash := public.hc_notification_secret_hash(p_revoke_secret);

  update public.notification_device_authorizations as device_auth
  set revoked_at = coalesce(device_auth.revoked_at, clock_timestamp()),
      revoked_reason = coalesce(
        device_auth.revoked_reason,
        'device capability revoked'
      ),
      updated_at = case
        when device_auth.revoked_at is null
          then clock_timestamp()
        else device_auth.updated_at
      end
  where device_auth.device_id = p_device_id
    and device_auth.revoke_secret_hash = v_hash
  returning true into v_matched;

  if v_matched is true then
    delete from public.push_tokens where device_id = p_device_id;
    delete from public.live_activity_tokens
    where device_id = p_device_id
      and token_type = 'push_to_start'
      and shift_id is null;
  end if;

  return coalesce(v_matched, false);
end
$function$;

revoke all on function public.hc_authorize_notification_device(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.hc_revoke_notification_device(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.hc_authorize_notification_device(uuid)
  to authenticated;
grant execute on function public.hc_revoke_notification_device(uuid, text)
  to anon, authenticated;

-- App Review shifts are synthetic and must never keep a real owner's local
-- card alive during foreground truth reconciliation.
create or replace function public.hc_list_managed_open_shift_ids()
returns table (shift_id uuid)
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if not public.hc_can_manage_shifts() then
    raise exception using
      errcode = '42501',
      message = 'owner or manager required';
  end if;

  return query
  select s.id as shift_id
  from public.shifts as s
  where s.clock_out_at is null
    and lower(coalesce(s.worker_email, '')) <>
        'appreview@hamptonscoconuts.com'
  order by s.clock_in_at asc, s.id asc;
end
$function$;

revoke all on function public.hc_list_managed_open_shift_ids()
  from public, anon, authenticated, service_role;
grant execute on function public.hc_list_managed_open_shift_ids()
  to authenticated, service_role;

do $assertions$
declare
  v_privilege text;
  v_signature text;
  v_baseline hc_015c_baseline%rowtype;
begin
  if not exists (
    select 1
    from pg_catalog.pg_class as table_info
    where table_info.oid =
          'public.notification_device_authorizations'::pg_catalog.regclass
      and table_info.relrowsecurity
  ) or not exists (
    select 1
    from pg_catalog.pg_class as table_info
    where table_info.oid =
          'public.notification_device_security_state'::pg_catalog.regclass
      and table_info.relrowsecurity
  ) then
    raise exception using
      errcode = '42501',
      message = '015c assertion failed: capability-table RLS is disabled';
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'notification_device_authorizations'
      and column_name in ('revoke_secret', 'capability_secret', 'secret')
  ) then
    raise exception using
      errcode = '42501',
      message = '015c assertion failed: plaintext capability column exists';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_policies as policy_info
    where policy_info.schemaname = 'public'
      and policy_info.tablename in (
        'notification_device_authorizations',
        'notification_device_security_state'
      )
  ) then
    raise exception using
      errcode = '42501',
      message = '015c assertion failed: a private capability table has a policy';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_index as index_info
    join pg_catalog.pg_class as index_class
      on index_class.oid = index_info.indexrelid
    join pg_catalog.pg_class as table_class
      on table_class.oid = index_info.indrelid
    join pg_catalog.pg_namespace as namespace_info
      on namespace_info.oid = index_class.relnamespace
    join pg_catalog.pg_am as access_method
      on access_method.oid = index_class.relam
    where namespace_info.nspname = 'public'
      and index_class.relname = 'field_workers_auth_user_uidx'
      and index_class.relkind = 'i'
      and table_class.oid = 'public.field_workers'::pg_catalog.regclass
      and index_class.relowner = table_class.relowner
      and access_method.amname = 'btree'
      and index_info.indisunique is true
      and index_info.indisprimary is false
      and index_info.indisexclusion is false
      and index_info.indimmediate is true
      and index_info.indisvalid is true
      and index_info.indisready is true
      and index_info.indislive is true
      and index_info.indnkeyatts = 1
      and index_info.indnatts = 1
      and index_info.indexprs is null
      and index_info.indpred is not null
      and pg_catalog.pg_get_indexdef(
        index_info.indexrelid, 1, true
      ) = 'auth_user_id'
      and pg_catalog.regexp_replace(
        pg_catalog.lower(
          pg_catalog.pg_get_expr(index_info.indpred, index_info.indrelid)
        ),
        '[[:space:]()]',
        '',
        'g'
      ) = 'auth_user_idisnotnull'
  ) then
    raise exception using
      errcode = '55000',
      message = '015c assertion failed: migration-015 worker Auth uniqueness is incompatible';
  end if;

  if exists (
    select 1
    from (
      values
        (
          'notification_device_authorizations_pkey',
          'notification_device_authorizations',
          true, true, 1, 'device_id', null
        ),
        (
          'notification_device_authorizations_user_idx',
          'notification_device_authorizations',
          false, false, 2, 'auth_user_id', 'revoked_at'
        ),
        (
          'notification_device_authorizations_worker_idx',
          'notification_device_authorizations',
          false, false, 2, 'field_worker_id', 'revoked_at'
        ),
        (
          'notification_device_security_state_pkey',
          'notification_device_security_state',
          true, true, 1, 'singleton', null
        )
    ) as expected(
      index_name, table_name, is_unique, is_primary, key_count,
      key_one, key_two
    )
    where not exists (
      select 1
      from pg_catalog.pg_index as index_info
      join pg_catalog.pg_class as index_class
        on index_class.oid = index_info.indexrelid
      join pg_catalog.pg_class as table_class
        on table_class.oid = index_info.indrelid
      join pg_catalog.pg_namespace as namespace_info
        on namespace_info.oid = index_class.relnamespace
      join pg_catalog.pg_am as access_method
        on access_method.oid = index_class.relam
      where namespace_info.nspname = 'public'
        and index_class.relname::text = expected.index_name
        and index_class.relkind = 'i'
        and table_class.oid = pg_catalog.to_regclass(
          pg_catalog.format('public.%I', expected.table_name)
        )
        and index_class.relowner = table_class.relowner
        and access_method.amname = 'btree'
        and index_info.indisunique = expected.is_unique
        and index_info.indisprimary = expected.is_primary
        and index_info.indisexclusion is false
        and index_info.indimmediate is true
        and index_info.indisvalid is true
        and index_info.indisready is true
        and index_info.indislive is true
        and index_info.indnkeyatts = expected.key_count
        and index_info.indnatts = expected.key_count
        and index_info.indexprs is null
        and index_info.indpred is null
        and pg_catalog.pg_get_indexdef(
          index_info.indexrelid, 1, true
        ) = expected.key_one
        and (
          expected.key_count < 2
          or pg_catalog.pg_get_indexdef(
            index_info.indexrelid, 2, true
          ) = expected.key_two
        )
    )
  ) then
    raise exception using
      errcode = '55000',
      message = '015c assertion failed: capability index definition is incompatible';
  end if;

  if pg_catalog.to_regclass(
       'public.notification_device_authorizations_user_idx'
     ) is null
     or pg_catalog.to_regclass(
       'public.notification_device_authorizations_worker_idx'
     ) is null
     or not exists (
       select 1
       from pg_catalog.pg_constraint as constraint_info
       where constraint_info.conrelid =
             'public.notification_device_authorizations'::pg_catalog.regclass
         and constraint_info.conname =
             'notification_device_authorizations_pkey'
         and constraint_info.contype = 'p'
         and constraint_info.conindid =
             'public.notification_device_authorizations_pkey'::pg_catalog.regclass
         and constraint_info.conkey = array[
           (
             select attribute_info.attnum
             from pg_catalog.pg_attribute as attribute_info
             where attribute_info.attrelid = constraint_info.conrelid
               and attribute_info.attname = 'device_id'
               and not attribute_info.attisdropped
           )
         ]
         and not constraint_info.condeferrable
         and not constraint_info.condeferred
         and constraint_info.convalidated
     )
     or not exists (
       select 1
       from pg_catalog.pg_constraint as constraint_info
       where constraint_info.conrelid =
             'public.notification_device_security_state'::pg_catalog.regclass
         and constraint_info.conname =
             'notification_device_security_state_pkey'
         and constraint_info.contype = 'p'
         and constraint_info.conindid =
             'public.notification_device_security_state_pkey'::pg_catalog.regclass
         and constraint_info.conkey = array[
           (
             select attribute_info.attnum
             from pg_catalog.pg_attribute as attribute_info
             where attribute_info.attrelid = constraint_info.conrelid
               and attribute_info.attname = 'singleton'
               and not attribute_info.attisdropped
           )
         ]
         and not constraint_info.condeferrable
         and not constraint_info.condeferred
         and constraint_info.convalidated
     )
     or not exists (
       select 1
       from pg_catalog.pg_constraint as constraint_info
       where constraint_info.conrelid =
             'public.notification_device_authorizations'::pg_catalog.regclass
         and constraint_info.conname =
             'notification_device_authorizations_auth_user_id_fkey'
         and constraint_info.contype = 'f'
         and constraint_info.confrelid = 'auth.users'::pg_catalog.regclass
         and constraint_info.conkey = array[
           (
             select attribute_info.attnum
             from pg_catalog.pg_attribute as attribute_info
             where attribute_info.attrelid = constraint_info.conrelid
               and attribute_info.attname = 'auth_user_id'
               and not attribute_info.attisdropped
           )
         ]
         and constraint_info.confkey = array[
           (
             select attribute_info.attnum
             from pg_catalog.pg_attribute as attribute_info
             where attribute_info.attrelid = constraint_info.confrelid
               and attribute_info.attname = 'id'
               and not attribute_info.attisdropped
           )
         ]
         and constraint_info.confupdtype = 'a'
         and constraint_info.confdeltype = 'c'
         and constraint_info.confmatchtype = 's'
         and not constraint_info.condeferrable
         and not constraint_info.condeferred
         and constraint_info.convalidated
     )
     or not exists (
       select 1
       from pg_catalog.pg_constraint as constraint_info
       where constraint_info.conrelid =
             'public.notification_device_authorizations'::pg_catalog.regclass
         and constraint_info.conname =
             'notification_device_authorizations_field_worker_id_fkey'
         and constraint_info.contype = 'f'
         and constraint_info.confrelid =
             'public.field_workers'::pg_catalog.regclass
         and constraint_info.conkey = array[
           (
             select attribute_info.attnum
             from pg_catalog.pg_attribute as attribute_info
             where attribute_info.attrelid = constraint_info.conrelid
               and attribute_info.attname = 'field_worker_id'
               and not attribute_info.attisdropped
           )
         ]
         and constraint_info.confkey = array[
           (
             select attribute_info.attnum
             from pg_catalog.pg_attribute as attribute_info
             where attribute_info.attrelid = constraint_info.confrelid
               and attribute_info.attname = 'id'
               and not attribute_info.attisdropped
           )
         ]
         and constraint_info.confupdtype = 'a'
         and constraint_info.confdeltype = 'c'
         and constraint_info.confmatchtype = 's'
         and not constraint_info.condeferrable
         and not constraint_info.condeferred
         and constraint_info.convalidated
     )
     or not exists (
       select 1
       from pg_catalog.pg_constraint as constraint_info
       where constraint_info.conrelid =
             'public.notification_device_authorizations'::pg_catalog.regclass
         and constraint_info.conname =
             'notification_device_authorizations_hash_check'
         and constraint_info.contype = 'c'
         and constraint_info.convalidated
     )
     or not exists (
       select 1
       from pg_catalog.pg_constraint as constraint_info
       where constraint_info.conrelid =
             'public.notification_device_authorizations'::pg_catalog.regclass
         and constraint_info.conname =
             'notification_device_authorizations_version_check'
         and constraint_info.contype = 'c'
         and constraint_info.convalidated
     )
     or not exists (
       select 1
       from pg_catalog.pg_constraint as constraint_info
       where constraint_info.conrelid =
             'public.notification_device_authorizations'::pg_catalog.regclass
         and constraint_info.conname =
             'notification_device_authorizations_revoke_check'
         and constraint_info.contype = 'c'
         and constraint_info.convalidated
     )
     or not exists (
       select 1
       from pg_catalog.pg_constraint as constraint_info
       where constraint_info.conrelid =
             'public.notification_device_security_state'::pg_catalog.regclass
         and constraint_info.conname =
             'notification_device_security_state_singleton_check'
         and constraint_info.contype = 'c'
         and constraint_info.convalidated
     ) then
    raise exception using
      errcode = '55000',
      message = '015c assertion failed: capability indexes, keys, or checks are missing';
  end if;

  if exists (
    select 1
    from (
      values
        (
          'notification_device_authorizations',
          'notification_device_authorizations_hash_check',
          'hc_015c_expected_authorization_checks',
          'hc_015c_expected_hash_check'
        ),
        (
          'notification_device_authorizations',
          'notification_device_authorizations_version_check',
          'hc_015c_expected_authorization_checks',
          'hc_015c_expected_version_check'
        ),
        (
          'notification_device_authorizations',
          'notification_device_authorizations_revoke_check',
          'hc_015c_expected_authorization_checks',
          'hc_015c_expected_revoke_check'
        ),
        (
          'notification_device_security_state',
          'notification_device_security_state_singleton_check',
          'hc_015c_expected_security_state_check',
          'hc_015c_expected_singleton_check'
        )
    ) as expected(
      table_name, constraint_name, expected_table_name,
      expected_constraint_name
    )
    where not exists (
      select 1
      from pg_catalog.pg_constraint as actual_constraint
      join pg_catalog.pg_constraint as expected_constraint
        on expected_constraint.conrelid = pg_catalog.to_regclass(
             'pg_temp.' || expected.expected_table_name
           )
       and expected_constraint.conname = expected.expected_constraint_name
      where actual_constraint.conrelid = pg_catalog.to_regclass(
              'public.' || expected.table_name
            )
        and actual_constraint.conname = expected.constraint_name
        and actual_constraint.contype = 'c'
        and actual_constraint.convalidated
        and not actual_constraint.connoinherit
        and pg_catalog.pg_get_expr(
              actual_constraint.conbin,
              actual_constraint.conrelid,
              false
            ) = pg_catalog.pg_get_expr(
              expected_constraint.conbin,
              expected_constraint.conrelid,
              false
            )
    )
  ) then
    raise exception using
      errcode = '55000',
      message = '015c assertion failed: capability check expression is incompatible';
  end if;

  if exists (
    select 1
    from (
      values
        ('notification_device_authorizations', 'device_id', 'uuid', 'NO'),
        ('notification_device_authorizations', 'auth_user_id', 'uuid', 'NO'),
        ('notification_device_authorizations', 'field_worker_id', 'uuid', 'NO'),
        ('notification_device_authorizations', 'revoke_secret_hash', 'bytea', 'NO'),
        ('notification_device_authorizations', 'secret_version', 'int4', 'NO'),
        ('notification_device_authorizations', 'authorized_at', 'timestamptz', 'NO'),
        ('notification_device_authorizations', 'last_registered_at', 'timestamptz', 'YES'),
        ('notification_device_authorizations', 'revoked_at', 'timestamptz', 'YES'),
        ('notification_device_authorizations', 'revoked_reason', 'text', 'YES'),
        ('notification_device_authorizations', 'created_at', 'timestamptz', 'NO'),
        ('notification_device_authorizations', 'updated_at', 'timestamptz', 'NO'),
        ('notification_device_security_state', 'singleton', 'bool', 'NO'),
        ('notification_device_security_state', 'transition_installed_at', 'timestamptz', 'NO'),
        ('notification_device_security_state', 'ever_issued_at', 'timestamptz', 'YES'),
        ('notification_device_security_state', 'cutover_at', 'timestamptz', 'YES')
    ) as required(table_name, column_name, udt_name, is_nullable)
    left join information_schema.columns as column_info
      on column_info.table_schema = 'public'
     and column_info.table_name = required.table_name
     and column_info.column_name = required.column_name
     and column_info.udt_name = required.udt_name
     and column_info.is_nullable = required.is_nullable
    where column_info.column_name is null
  ) then
    raise exception using
      errcode = '55000',
      message = '015c assertion failed: capability column contract is incompatible';
  end if;

  if (
    select count(*)
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'notification_device_authorizations'
  ) <> 11
     or (
       select count(*)
       from information_schema.columns
       where table_schema = 'public'
         and table_name = 'notification_device_security_state'
     ) <> 4
     or (
       select count(*)
       from pg_catalog.pg_constraint as constraint_info
       where constraint_info.conrelid =
             'public.notification_device_authorizations'::pg_catalog.regclass
     ) <> 6
     or (
       select count(*)
       from pg_catalog.pg_constraint as constraint_info
       where constraint_info.conrelid =
             'public.notification_device_security_state'::pg_catalog.regclass
     ) <> 2 then
    raise exception using
      errcode = '55000',
      message = '015c assertion failed: capability tables contain unexpected schema';
  end if;

  foreach v_privilege in array array[
    'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
  ] loop
    if pg_catalog.has_table_privilege(
         'anon', 'public.notification_device_authorizations', v_privilege
       )
       or pg_catalog.has_table_privilege(
         'authenticated',
         'public.notification_device_authorizations',
         v_privilege
       )
       or pg_catalog.has_table_privilege(
         'anon', 'public.notification_device_security_state', v_privilege
       )
       or pg_catalog.has_table_privilege(
         'authenticated',
         'public.notification_device_security_state',
         v_privilege
       ) then
      raise exception using
        errcode = '42501',
        message = pg_catalog.format(
          '015c assertion failed: client retains private-table %s',
          v_privilege
        );
    end if;
  end loop;

  foreach v_privilege in array array[
    'SELECT', 'INSERT', 'UPDATE', 'REFERENCES'
  ] loop
    if pg_catalog.has_any_column_privilege(
         'anon',
         'public.notification_device_authorizations',
         v_privilege
       )
       or pg_catalog.has_any_column_privilege(
         'authenticated',
         'public.notification_device_authorizations',
         v_privilege
       )
       or pg_catalog.has_any_column_privilege(
         'anon',
         'public.notification_device_security_state',
         v_privilege
       )
       or pg_catalog.has_any_column_privilege(
         'authenticated',
         'public.notification_device_security_state',
         v_privilege
       ) then
      raise exception using
        errcode = '42501',
        message = pg_catalog.format(
          '015c assertion failed: client retains private-column %s',
          v_privilege
        );
    end if;
  end loop;

  foreach v_privilege in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE'] loop
    if not pg_catalog.has_table_privilege(
      'service_role', 'public.notification_device_authorizations', v_privilege
    ) or not pg_catalog.has_table_privilege(
      'service_role', 'public.notification_device_security_state', v_privilege
    ) then
      raise exception using
        errcode = '42501',
        message = pg_catalog.format(
          '015c assertion failed: service role lacks private-table %s',
          v_privilege
        );
    end if;
  end loop;

  if pg_catalog.has_function_privilege(
       'anon', 'public.hc_authorize_notification_device(uuid)', 'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'authenticated',
       'public.hc_authorize_notification_device(uuid)',
       'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'anon',
       'public.hc_revoke_notification_device(uuid,text)',
       'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'authenticated',
       'public.hc_revoke_notification_device(uuid,text)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'anon', 'public.hc_list_managed_open_shift_ids()', 'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'authenticated',
       'public.hc_list_managed_open_shift_ids()',
       'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.hc_list_managed_open_shift_ids()',
       'EXECUTE'
     ) then
    raise exception using
      errcode = '42501',
      message = '015c assertion failed: client RPC grants are wrong';
  end if;

  foreach v_signature in array array[
    'public.hc_notification_random_secret()',
    'public.hc_notification_secret_hash(text)',
    'public.hc_purge_revoked_notification_device()',
    'public.hc_revoke_ineligible_worker_devices()'
  ] loop
    if pg_catalog.has_function_privilege('anon', v_signature, 'EXECUTE')
       or pg_catalog.has_function_privilege(
         'authenticated', v_signature, 'EXECUTE'
       )
       or pg_catalog.has_function_privilege(
         'service_role', v_signature, 'EXECUTE'
       ) then
      raise exception using
        errcode = '42501',
        message = pg_catalog.format(
          '015c assertion failed: private helper %s is callable',
          v_signature
        );
    end if;
  end loop;

  foreach v_signature in array array[
    'public.hc_notification_random_secret()',
    'public.hc_notification_secret_hash(text)',
    'public.hc_purge_revoked_notification_device()',
    'public.hc_revoke_ineligible_worker_devices()',
    'public.hc_authorize_notification_device(uuid)',
    'public.hc_revoke_notification_device(uuid,text)',
    'public.hc_list_managed_open_shift_ids()'
  ] loop
    if not exists (
      select 1
      from pg_catalog.pg_proc as function_info
      where function_info.oid = pg_catalog.to_regprocedure(v_signature)
        and function_info.prosecdef is true
        and exists (
          select 1
          from pg_catalog.unnest(function_info.proconfig) as setting(value)
          where setting.value like 'search_path=%'
        )
    ) then
      raise exception using
        errcode = '42501',
        message = pg_catalog.format(
          '015c assertion failed: function %s is not hardened',
          v_signature
        );
    end if;
  end loop;

  if pg_catalog.pg_get_function_result(
       'public.hc_authorize_notification_device(uuid)'::pg_catalog.regprocedure
     ) <> 'TABLE(device_id uuid, revoke_secret text, secret_version integer, authorized_at timestamp with time zone)'
     or pg_catalog.pg_get_function_result(
       'public.hc_revoke_notification_device(uuid,text)'::pg_catalog.regprocedure
     ) <> 'boolean'
     or pg_catalog.pg_get_function_result(
       'public.hc_list_managed_open_shift_ids()'::pg_catalog.regprocedure
     ) <> 'TABLE(shift_id uuid)' then
    raise exception using
      errcode = '55000',
      message = '015c assertion failed: app-facing return contracts are wrong';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_trigger as trigger_info
    where trigger_info.tgrelid =
          'public.notification_device_authorizations'::pg_catalog.regclass
      and trigger_info.tgname = 'notification_device_authorizations_purge'
      and not trigger_info.tgisinternal
      and trigger_info.tgenabled <> 'D'
  ) or not exists (
    select 1
    from pg_catalog.pg_trigger as trigger_info
    where trigger_info.tgrelid = 'public.field_workers'::pg_catalog.regclass
      and trigger_info.tgname = 'field_workers_revoke_notification_devices'
      and not trigger_info.tgisinternal
      and trigger_info.tgenabled <> 'D'
  ) then
    raise exception using
      errcode = '55000',
      message = '015c assertion failed: durable revocation trigger is missing';
  end if;

  if pg_catalog.pg_get_functiondef(
       'public.hc_authorize_notification_device(uuid)'::pg_catalog.regprocedure
     ) !~* 'on conflict[[:space:]]+on constraint[[:space:]]+notification_device_authorizations_pkey'
     or pg_catalog.pg_get_functiondef(
       'public.hc_authorize_notification_device(uuid)'::pg_catalog.regprocedure
     ) !~ 'fw[.]active is true'
     or pg_catalog.regexp_replace(
       pg_catalog.pg_get_functiondef(
         'public.hc_authorize_notification_device(uuid)'::pg_catalog.regprocedure
       ),
       '[[:space:]]+',
       ' ',
       'g'
     ) !~* 'from public[.]field_workers as fw .* limit 1 for update'
     or pg_catalog.pg_get_functiondef(
       'public.hc_authorize_notification_device(uuid)'::pg_catalog.regprocedure
     ) !~ 'set ever_issued_at = coalesce'
     or pg_catalog.pg_get_functiondef(
       'public.hc_revoke_notification_device(uuid,text)'::pg_catalog.regprocedure
     ) !~ 'token_type = ''push_to_start'''
     or pg_catalog.pg_get_functiondef(
       'public.hc_revoke_notification_device(uuid,text)'::pg_catalog.regprocedure
     ) !~ 'if v_matched is true then'
     or pg_catalog.pg_get_functiondef(
       'public.hc_revoke_notification_device(uuid,text)'::pg_catalog.regprocedure
     ) !~ 'return coalesce[(]v_matched, false[)];'
     or pg_catalog.pg_get_functiondef(
       'public.hc_revoke_notification_device(uuid,text)'::pg_catalog.regprocedure
     ) ~ 'token_type = ''activity_update'''
     or pg_catalog.pg_get_functiondef(
       'public.hc_list_managed_open_shift_ids()'::pg_catalog.regprocedure
     ) !~ 'appreview@hamptonscoconuts[.]com'
     or pg_catalog.pg_get_functiondef(
       'public.hc_list_managed_open_shift_ids()'::pg_catalog.regprocedure
     ) ~ 'hc_management_can_access_shift_market' then
    raise exception using
      errcode = '55000',
      message = '015c assertion failed: authorization, revoke preservation, or open-shift truth is wrong';
  end if;

  if not exists (
    select 1
    from public.notification_device_security_state
    where singleton is true
      and transition_installed_at is not null
      and cutover_at is null
  ) or (
    select count(*)
    from public.notification_device_security_state
  ) <> 1 or (
    exists (
      select 1
      from public.notification_device_authorizations
    )
    and not exists (
      select 1
      from public.notification_device_security_state
      where singleton is true
        and ever_issued_at is not null
    )
  ) then
    raise exception using
      errcode = '55000',
      message = '015c assertion failed: transition security state is invalid';
  end if;

  select * into strict v_baseline from hc_015c_baseline;

  if v_baseline.push_token_count <>
       (select count(*) from public.push_tokens)
     or v_baseline.live_token_count <>
       (select count(*) from public.live_activity_tokens)
     or v_baseline.can_manage_definition <> pg_catalog.pg_get_functiondef(
       'public.hc_can_manage_shifts()'::pg_catalog.regprocedure
     )
     or v_baseline.sync_definition <> pg_catalog.pg_get_functiondef(
       'public.hc_sync_notification_device(uuid,text,boolean,boolean)'::pg_catalog.regprocedure
     )
     or v_baseline.register_definition <> pg_catalog.pg_get_functiondef(
       'public.hc_register_live_activity_token(text,uuid,text,uuid,boolean)'::pg_catalog.regprocedure
     )
     or v_baseline.unregister_definition <> pg_catalog.pg_get_functiondef(
       'public.hc_unregister_device(uuid)'::pg_catalog.regprocedure
     )
     or v_baseline.legacy_p2s_index <> pg_catalog.pg_get_indexdef(
       'public.live_activity_tokens_p2s_uniq'::pg_catalog.regclass
     )
     or v_baseline.legacy_update_index <> pg_catalog.pg_get_indexdef(
       'public.live_activity_tokens_upd_uniq'::pg_catalog.regclass
     )
     or v_baseline.device_p2s_index <> pg_catalog.pg_get_indexdef(
       'public.live_activity_tokens_device_p2s_uidx'::pg_catalog.regclass
     )
     or v_baseline.device_update_index <> pg_catalog.pg_get_indexdef(
       'public.live_activity_tokens_device_update_uidx'::pg_catalog.regclass
     ) then
    raise exception using
      errcode = '55000',
      message = '015c assertion failed: migration-015 state or token rows changed';
  end if;

  if pg_catalog.to_regprocedure(
       'public.hc_claim_live_activity_ends(timestamp with time zone,timestamp with time zone,integer)'
     ) is not null
     or pg_catalog.to_regprocedure(
       'public.hc_claim_live_activity_starts(timestamp with time zone,timestamp with time zone,timestamp with time zone,integer)'
     ) is not null
     or pg_catalog.to_regprocedure(
       'public.hc_validate_live_activity_start_delivery(uuid,uuid,uuid,integer,text)'
     ) is not null
     or pg_catalog.to_regprocedure(
       'public.hc_enforce_notification_destination_authorization()'
     ) is not null
     or pg_catalog.to_regprocedure(
       'public.hc_management_can_access_shift_market(text,text,text)'
     ) is not null then
    raise exception using
      errcode = '55000',
      message = '015c assertion failed: a later migration object appeared';
  end if;
end
$assertions$;

notify pgrst, 'reload schema';

commit;

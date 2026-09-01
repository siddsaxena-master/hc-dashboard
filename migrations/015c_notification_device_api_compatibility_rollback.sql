-- ============================================================================
-- 015c_notification_device_api_compatibility_rollback.sql
-- Guarded rollback for the build-26 notification API bridge.
--
-- This rollback is safe only before any phone has ever received a capability
-- and before any later notification migration is present. The permanent
-- ever_issued_at marker makes that history survive authorization-row cascades.
-- Once used, repair forward. The harmless UUID-only open-shift truth RPC
-- remains installed so foreground cleanup does not regress. pgcrypto remains.
-- ============================================================================

begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';

do $preflight$
begin
  if pg_catalog.to_regclass(
       'public.notification_device_authorizations'
     ) is null
     or pg_catalog.to_regclass(
       'public.notification_device_security_state'
     ) is null then
    raise exception using
      errcode = '55000',
      message = '015c rollback blocked: capability tables are missing';
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
      message = '015c rollback blocked: a later migration is present';
  end if;

  if exists (
    select 1
    from (
      values
        ('singleton', 'bool', 'NO'),
        ('transition_installed_at', 'timestamptz', 'NO'),
        ('ever_issued_at', 'timestamptz', 'YES'),
        ('cutover_at', 'timestamptz', 'YES')
    ) as required(column_name, udt_name, is_nullable)
    left join information_schema.columns as column_info
      on column_info.table_schema = 'public'
     and column_info.table_name = 'notification_device_security_state'
     and column_info.column_name = required.column_name
     and column_info.udt_name = required.udt_name
     and column_info.is_nullable = required.is_nullable
    where column_info.column_name is null
  ) or (
    select count(*)
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'notification_device_security_state'
  ) <> 4 then
    raise exception using
      errcode = '55000',
      message = '015c rollback blocked: security-history shape is incompatible';
  end if;
end
$preflight$;

-- Match the roster trigger's worker-first lock order to avoid a deadlock.
lock table public.field_workers in share row exclusive mode;

-- Prevent a phone authorization from racing the history and empty-table checks.
lock table
  public.notification_device_authorizations,
  public.notification_device_security_state,
  public.push_tokens,
  public.live_activity_tokens
in share row exclusive mode;

do $capability_guard$
begin
  if (
    select count(*)
    from public.notification_device_security_state
  ) <> 1 or not exists (
    select 1
    from public.notification_device_security_state
    where singleton is true
  ) then
    raise exception using
      errcode = '55000',
      message = '015c rollback blocked: security history is missing or ambiguous';
  end if;

  if exists (
    select 1
    from public.notification_device_security_state
    where singleton is true
      and ever_issued_at is not null
  ) then
    raise exception using
      errcode = '55000',
      message = '015c rollback blocked: a phone capability was previously issued';
  end if;

  if exists (
    select 1
    from public.notification_device_security_state
    where singleton is true
      and cutover_at is not null
  ) then
    raise exception using
      errcode = '55000',
      message = '015c rollback blocked: notification authorization cutover was enforced';
  end if;

  if exists (
    select 1
    from public.notification_device_authorizations
  ) then
    raise exception using
      errcode = '55000',
      message = '015c rollback blocked: at least one phone received a capability';
  end if;

  if pg_catalog.to_regprocedure(
       'public.hc_list_managed_open_shift_ids()'
     ) is null
     or pg_catalog.pg_get_functiondef(
       'public.hc_list_managed_open_shift_ids()'::pg_catalog.regprocedure
     ) !~ 'appreview@hamptonscoconuts[.]com' then
    raise exception using
      errcode = '55000',
      message = '015c rollback blocked: retained open-shift RPC is missing or drifted';
  end if;
end
$capability_guard$;

create temporary table hc_015c_rollback_baseline (
  push_token_count bigint not null,
  live_token_count bigint not null,
  sync_definition text not null,
  register_definition text not null,
  unregister_definition text not null
) on commit drop;

insert into hc_015c_rollback_baseline
select
  (select count(*) from public.push_tokens),
  (select count(*) from public.live_activity_tokens),
  pg_catalog.pg_get_functiondef(
    'public.hc_sync_notification_device(uuid,text,boolean,boolean)'::pg_catalog.regprocedure
  ),
  pg_catalog.pg_get_functiondef(
    'public.hc_register_live_activity_token(text,uuid,text,uuid,boolean)'::pg_catalog.regprocedure
  ),
  pg_catalog.pg_get_functiondef(
    'public.hc_unregister_device(uuid)'::pg_catalog.regprocedure
  );

-- Repeat the later-object check immediately before destructive drops. If a
-- concurrent migration appears afterward, the postflight check aborts and
-- rolls this transaction back.
do $later_object_recheck$
begin
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
      message = '015c rollback blocked: a later migration appeared before drops';
  end if;
end
$later_object_recheck$;

drop trigger if exists field_workers_revoke_notification_devices
  on public.field_workers;
drop function if exists public.hc_revoke_ineligible_worker_devices();

drop trigger if exists notification_device_authorizations_purge
  on public.notification_device_authorizations;
drop function if exists public.hc_purge_revoked_notification_device();

drop function if exists public.hc_authorize_notification_device(uuid);
drop function if exists public.hc_revoke_notification_device(uuid, text);
drop function if exists public.hc_notification_random_secret();
drop function if exists public.hc_notification_secret_hash(text);

drop table public.notification_device_authorizations;
drop table public.notification_device_security_state;

do $assertions$
declare
  v_baseline hc_015c_rollback_baseline%rowtype;
begin
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
      message = '015c rollback assertion failed: a later migration object appeared';
  end if;

  if pg_catalog.to_regclass(
       'public.notification_device_authorizations'
     ) is not null
     or pg_catalog.to_regclass(
       'public.notification_device_security_state'
     ) is not null
     or pg_catalog.to_regprocedure(
       'public.hc_authorize_notification_device(uuid)'
     ) is not null
     or pg_catalog.to_regprocedure(
       'public.hc_revoke_notification_device(uuid,text)'
     ) is not null
     or pg_catalog.to_regprocedure(
       'public.hc_notification_random_secret()'
     ) is not null
     or pg_catalog.to_regprocedure(
       'public.hc_notification_secret_hash(text)'
     ) is not null
     or pg_catalog.to_regprocedure(
       'public.hc_purge_revoked_notification_device()'
     ) is not null
     or pg_catalog.to_regprocedure(
       'public.hc_revoke_ineligible_worker_devices()'
     ) is not null then
    raise exception using
      errcode = '55000',
      message = '015c rollback assertion failed: capability objects remain';
  end if;

  if pg_catalog.to_regprocedure(
       'public.hc_list_managed_open_shift_ids()'
     ) is null
     or pg_catalog.has_function_privilege(
       'anon', 'public.hc_list_managed_open_shift_ids()', 'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'authenticated',
       'public.hc_list_managed_open_shift_ids()',
       'EXECUTE'
     )
     or pg_catalog.pg_get_functiondef(
       'public.hc_list_managed_open_shift_ids()'::pg_catalog.regprocedure
     ) !~ 'appreview@hamptonscoconuts[.]com' then
    raise exception using
      errcode = '55000',
      message = '015c rollback assertion failed: safe open-shift RPC was not retained';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_extension
    where extname = 'pgcrypto'
  ) then
    raise exception using
      errcode = '55000',
      message = '015c rollback assertion failed: shared pgcrypto was removed';
  end if;

  select * into strict v_baseline from hc_015c_rollback_baseline;

  if v_baseline.push_token_count <>
       (select count(*) from public.push_tokens)
     or v_baseline.live_token_count <>
       (select count(*) from public.live_activity_tokens)
     or v_baseline.sync_definition <> pg_catalog.pg_get_functiondef(
       'public.hc_sync_notification_device(uuid,text,boolean,boolean)'::pg_catalog.regprocedure
     )
     or v_baseline.register_definition <> pg_catalog.pg_get_functiondef(
       'public.hc_register_live_activity_token(text,uuid,text,uuid,boolean)'::pg_catalog.regprocedure
     )
     or v_baseline.unregister_definition <> pg_catalog.pg_get_functiondef(
       'public.hc_unregister_device(uuid)'::pg_catalog.regprocedure
     ) then
    raise exception using
      errcode = '55000',
      message = '015c rollback assertion failed: migration-015 state changed';
  end if;
end
$assertions$;

notify pgrst, 'reload schema';

commit;

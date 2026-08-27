-- ============================================================================
-- 021_notification_device_authorization_transition_rollback.sql
-- Guarded rollback for transition migration 021.
--
-- This rollback is safe only before any app has received a capability secret
-- and before migration 022 has enforced the new contract. It intentionally
-- leaves the harmless App Review open-shift exclusion in place.
-- ============================================================================

begin;

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
      message = '021 rollback blocked: transition tables are missing';
  end if;

  if exists (
    select 1
    from public.notification_device_security_state
    where singleton is true
      and cutover_at is not null
  ) then
    raise exception using
      errcode = '55000',
      message = '021 rollback blocked: migration 022 cutover was enforced';
  end if;

  if exists (
    select 1
    from public.notification_device_authorizations
  ) then
    raise exception using
      errcode = '55000',
      message = '021 rollback blocked: at least one app received a capability secret';
  end if;
end
$preflight$;

drop trigger field_workers_revoke_notification_devices
  on public.field_workers;
drop function public.hc_revoke_ineligible_worker_devices();

drop trigger notification_device_authorizations_purge
  on public.notification_device_authorizations;
drop function public.hc_purge_revoked_notification_device();

drop function public.hc_authorize_notification_device(uuid);
drop function public.hc_revoke_notification_device(uuid, text);
drop function public.hc_notification_random_secret();
drop function public.hc_notification_secret_hash(text);

drop table public.notification_device_authorizations;
drop table public.notification_device_security_state;

do $assertions$
begin
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
     ) is not null then
    raise exception using
      errcode = '55000',
      message = '021 rollback assertion failed: transition objects remain';
  end if;
end
$assertions$;

commit;

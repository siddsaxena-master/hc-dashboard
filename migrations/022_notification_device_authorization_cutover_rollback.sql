-- ============================================================================
-- 022_notification_device_authorization_cutover_rollback.sql
-- Intentionally blocked automatic rollback for migration 022.
--
-- After a capability-aware client is installed, restoring the old registration
-- functions would silently let any surviving authenticated session register a
-- notification destination without its device capability. That is a security
-- downgrade and can also re-arm a phone that was revoked after session loss.
--
-- Recovery must be a reviewed forward migration that keeps capability revoke
-- valid. This file is executable only to fail closed with a clear message. It
-- changes no data and drops no object.
-- ============================================================================

do $blocked_rollback$
begin
  raise exception using
    errcode = '55000',
    message = '022 automatic rollback blocked: use a reviewed forward repair that preserves device capability revocation';
end
$blocked_rollback$;

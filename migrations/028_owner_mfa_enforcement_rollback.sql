-- ============================================================================
-- 028_owner_mfa_enforcement_rollback.sql
-- BLOCKED ROLLBACK
--
-- Migration 028 makes owner MFA part of the database authorization boundary.
-- Restoring the pre-028 functions would reopen owner data to an aal1 session.
-- Use a reviewed forward migration to repair MFA or change the policy.
-- ============================================================================

do $blocked$
begin
  raise exception using
    errcode = '55000',
    message = '028 rollback blocked: use a reviewed forward migration so owner MFA is never silently removed';
end
$blocked$;

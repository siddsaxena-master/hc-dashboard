-- ============================================================================
-- 026_delivery_confirmation_integrity_rollback.sql
-- Intentionally blocked automatic rollback for migration 026.
--
-- Removing request IDs, actor IDs, or the one-authoritative-order index would
-- destroy audit meaning and re-enable duplicate or stale delivery overwrites.
-- Recovery must use a reviewed forward migration coordinated with a dashboard
-- rollback. Existing signature rows must never be deleted automatically.
-- ============================================================================

do $blocked_rollback$
begin
  raise exception using
    errcode = '55000',
    message = '026 automatic rollback blocked: use a reviewed forward migration and preserve signature audit rows';
end
$blocked_rollback$;

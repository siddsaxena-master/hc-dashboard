-- ============================================================================
-- 025_manager_market_scope_rollback.sql
-- Intentionally blocked automatic rollback for migration 025.
--
-- The previous function bodies let managers read, edit, clock out, and receive
-- notifications for every market. Restoring them would knowingly reopen a
-- privacy issue. Recovery must use a reviewed forward migration that preserves
-- exact-market enforcement and durable Live Activity END delivery.
-- ============================================================================

do $blocked_rollback$
begin
  raise exception using
    errcode = '55000',
    message = '025 automatic rollback blocked: use a reviewed forward privacy repair';
end
$blocked_rollback$;

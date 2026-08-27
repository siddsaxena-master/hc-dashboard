-- ============================================================================
-- 024_webhook_delivery_receipts_rollback.sql
-- Intentionally blocked automatic rollback for migration 024.
--
-- The matching Worker uses receipt UUIDs as stable order IDs. Dropping the
-- ledger or its RPCs while that Worker is live would re-enable duplicate orders
-- and make valid provider deliveries fail. Recovery must be a reviewed forward
-- migration coordinated with a Worker rollback.
-- ============================================================================

do $blocked_rollback$
begin
  raise exception using
    errcode = '55000',
    message = '024 automatic rollback blocked: coordinate a reviewed Worker and schema rollback';
end
$blocked_rollback$;

-- ============================================================================
-- 029_webhook_delivery_lease_renewal_fix_rollback.sql
-- BLOCKED ROLLBACK
--
-- Reverting this repair would make long-running webhook handlers unable to
-- renew the exact receipt lease they own. Use a reviewed forward migration for
-- any future receipt-lease change.
-- ============================================================================

do $blocked$
begin
  raise exception using
    errcode = '55000',
    message = '029 rollback blocked: keep receipt lease renewal bound to lease_token';
end
$blocked$;

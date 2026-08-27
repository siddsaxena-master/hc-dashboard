-- ============================================================================
-- 027_webhook_async_intake_outbox_rollback.sql
-- Intentionally blocked automatic rollback for migration 027.
--
-- Graph acknowledgments depend on the private intake queue, and encrypted
-- Telegram rows depend on their delivery metadata. Removing either while the
-- compatible Worker or pushdrain is live can silently lose provider events.
-- Use a reviewed forward migration coordinated with both runtimes.
-- ============================================================================

do $blocked_rollback$
begin
  raise exception using
    errcode = '55000',
    message = '027 automatic rollback blocked: coordinate Worker, pushdrain, and schema changes';
end
$blocked_rollback$;

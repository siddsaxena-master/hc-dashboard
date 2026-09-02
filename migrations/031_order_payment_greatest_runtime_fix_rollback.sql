-- BLOCKED ROLLBACK
-- Restoring migration 030 would knowingly restore a runtime failure in every
-- verified QuickBooks payment write. Recovery must use a reviewed forward fix.

do $blocked$
begin
  raise exception using
    errcode = '55000',
    message = '031 rollback blocked: migration 030 uses invalid schema-qualified GREATEST; use a reviewed forward migration';
end
$blocked$;

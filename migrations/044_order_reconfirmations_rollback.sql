-- ============================================================================
-- 044_order_reconfirmations_rollback.sql
-- Undo migration 044: drop the owner's decision function, the read policy,
-- the reconfirmations table with every draft and reply stamp in it, and the
-- conversation_id column on intake_messages (its index goes with it; the
-- thread ids the poller stored are lost, so copy them first if that history
-- matters). Safe to run twice. Touches nothing else: orders, intake rows
-- themselves, delivery_request, order_time_proposals and every other
-- function stay as they are. Until the worker and the droplet are
-- redeployed without the feature they log a missing table and draft or
-- send nothing.
-- ============================================================================

begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';

drop function if exists public.hc_decide_reconfirmation(bigint, text);

drop policy if exists order_reconfirmations_owner_select on public.order_reconfirmations;

drop table if exists public.order_reconfirmations;

alter table public.intake_messages
  drop column if exists conversation_id;

do $postflight$
begin
  if pg_catalog.to_regclass('public.order_reconfirmations') is not null
     or pg_catalog.to_regprocedure('public.hc_decide_reconfirmation(bigint, text)') is not null
     or pg_catalog.to_regclass('public.intake_messages_conversation_id_idx') is not null
     or exists (
       select 1 from pg_catalog.pg_attribute
       where attrelid = 'public.intake_messages'::regclass
         and attname = 'conversation_id'
         and attnum > 0
         and not attisdropped
     ) then
    raise exception using errcode = '55000', message = '044 rollback postflight: something 044 installed is still present';
  end if;
end
$postflight$;

commit;

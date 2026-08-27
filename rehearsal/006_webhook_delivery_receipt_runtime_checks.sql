-- ============================================================================
-- SANDBOX ONLY: 006_webhook_delivery_receipt_runtime_checks.sql
--
-- Run only after migration 024 on hc-field-rehearsal. Every synthetic receipt
-- and request-claim change is inside this transaction and is rolled back.
-- ============================================================================

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $test$
declare
  v_event_a constant text := repeat('a', 64);
  v_event_b constant text := repeat('b', 64);
  v_state text;
  v_receipt_id uuid;
  v_first_receipt_id uuid;
  v_claim_token uuid;
  v_first_claim_token uuid;
  v_claim_expires_at timestamptz;
  v_attempt_count bigint;
  v_denied boolean := false;
begin
  if (select count(*) from auth.users) <> 1
     or not exists (
       select 1
       from auth.users
       where lower(email) = 'siddsaxena@gmail.com'
         and email_confirmed_at is not null
     )
     or exists (
       select 1
       from public.orders
       where client_name not like 'Sandbox %'
     ) then
    raise exception using
      errcode = '55000',
      message = 'SANDBOX GUARD: expected the isolated one-user rehearsal project';
  end if;

  perform pg_catalog.set_config('request.jwt.claim.role', 'authenticated', true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    pg_catalog.json_build_object('role', 'authenticated')::text,
    true
  );

  begin
    perform *
    from public.hc_claim_webhook_delivery('formspree', v_event_a, 300);
  exception
    when insufficient_privilege then
      v_denied := true;
  end;

  if v_denied is not true then
    raise exception using
      errcode = '55000',
      message = 'authenticated caller reached the service-only claim RPC';
  end if;

  perform pg_catalog.set_config('request.jwt.claim.role', 'service_role', true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    pg_catalog.json_build_object('role', 'service_role')::text,
    true
  );

  select claim.claim_state, claim.receipt_id, claim.claim_token,
         claim.claim_expires_at
  into v_state, v_receipt_id, v_claim_token, v_claim_expires_at
  from public.hc_claim_webhook_delivery(
    'formspree',
    v_event_a,
    300
  ) as claim;

  v_first_receipt_id := v_receipt_id;
  v_first_claim_token := v_claim_token;

  if v_state <> 'claimed'
     or v_first_receipt_id is null
     or v_first_claim_token is null
     or v_claim_expires_at <= pg_catalog.clock_timestamp() then
    raise exception using
      errcode = '55000',
      message = 'first webhook claim did not create a valid lease';
  end if;

  select claim.claim_state, claim.receipt_id, claim.claim_token
  into v_state, v_receipt_id, v_claim_token
  from public.hc_claim_webhook_delivery(
    'formspree',
    v_event_a,
    300
  ) as claim;

  if v_state <> 'busy'
     or v_receipt_id is distinct from v_first_receipt_id
     or v_claim_token is not null then
    raise exception using
      errcode = '55000',
      message = 'an active webhook lease was not reported as busy';
  end if;

  if public.hc_release_webhook_delivery(
       'formspree',
       v_event_a,
       pg_catalog.gen_random_uuid()
     ) is not false
     or public.hc_finish_webhook_delivery(
       'formspree',
       v_event_a,
       pg_catalog.gen_random_uuid()
     ) is not false then
    raise exception using
      errcode = '55000',
      message = 'a foreign lease token changed webhook receipt state';
  end if;

  if public.hc_release_webhook_delivery(
       'formspree',
       v_event_a,
       v_first_claim_token
     ) is not true then
    raise exception using
      errcode = '55000',
      message = 'the owning webhook lease could not be released';
  end if;

  select claim.claim_state, claim.receipt_id, claim.claim_token
  into v_state, v_receipt_id, v_claim_token
  from public.hc_claim_webhook_delivery(
    'formspree',
    v_event_a,
    300
  ) as claim;

  if v_state <> 'claimed'
     or v_receipt_id is distinct from v_first_receipt_id
     or v_claim_token is null
     or v_claim_token = v_first_claim_token then
    raise exception using
      errcode = '55000',
      message = 'released webhook receipt did not reclaim with stable identity';
  end if;

  select receipt.attempt_count
  into v_attempt_count
  from public.webhook_delivery_receipts as receipt
  where receipt.id = v_first_receipt_id;

  if v_attempt_count <> 2
     or public.hc_finish_webhook_delivery(
       'formspree',
       v_event_a,
       v_claim_token
     ) is not true then
    raise exception using
      errcode = '55000',
      message = 'reclaimed webhook receipt did not finish exactly once';
  end if;

  select claim.claim_state, claim.receipt_id, claim.claim_token,
         claim.claim_expires_at
  into v_state, v_receipt_id, v_claim_token, v_claim_expires_at
  from public.hc_claim_webhook_delivery(
    'formspree',
    v_event_a,
    300
  ) as claim;

  if v_state <> 'completed'
     or v_receipt_id is distinct from v_first_receipt_id
     or v_claim_token is not null
     or v_claim_expires_at is not null then
    raise exception using
      errcode = '55000',
      message = 'completed webhook duplicate was not acknowledged safely';
  end if;

  select claim.claim_state, claim.receipt_id, claim.claim_token
  into v_state, v_receipt_id, v_claim_token
  from public.hc_claim_webhook_delivery(
    'ms_graph',
    v_event_b,
    300
  ) as claim;

  if v_state <> 'claimed' or v_receipt_id is null or v_claim_token is null then
    raise exception using
      errcode = '55000',
      message = 'second provider fixture did not claim';
  end if;

  update public.webhook_delivery_receipts as receipt
  set lease_expires_at = pg_catalog.clock_timestamp() - interval '1 second'
  where receipt.id = v_receipt_id;

  v_first_receipt_id := v_receipt_id;
  v_first_claim_token := v_claim_token;

  select claim.claim_state, claim.receipt_id, claim.claim_token
  into v_state, v_receipt_id, v_claim_token
  from public.hc_claim_webhook_delivery(
    'ms_graph',
    v_event_b,
    300
  ) as claim;

  if v_state <> 'claimed'
     or v_receipt_id is distinct from v_first_receipt_id
     or v_claim_token is null
     or v_claim_token = v_first_claim_token
     or (
       select receipt.attempt_count
       from public.webhook_delivery_receipts as receipt
       where receipt.id = v_first_receipt_id
     ) <> 2 then
    raise exception using
      errcode = '55000',
      message = 'expired webhook lease did not recover safely';
  end if;

  if pg_catalog.has_table_privilege(
       'service_role',
       'public.webhook_delivery_receipts',
       'SELECT'
     )
     or pg_catalog.has_table_privilege(
       'authenticated',
       'public.webhook_delivery_receipts',
       'SELECT'
     )
     or exists (
       select 1
       from information_schema.columns
       where table_schema = 'public'
         and table_name = 'webhook_delivery_receipts'
         and column_name ~ '(raw|body|payload|secret|provider_event_id)'
     ) then
    raise exception using
      errcode = '55000',
      message = 'private receipt ledger exposed direct reads or sensitive fields';
  end if;
end
$test$;

rollback;

select
  'passed'::text as webhook_delivery_receipt_runtime_rehearsal,
  8::integer as scenarios_checked;

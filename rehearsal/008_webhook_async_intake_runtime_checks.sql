-- ============================================================================
-- SANDBOX ONLY: 008_webhook_async_intake_runtime_checks.sql
--
-- Run only after migration 027 on hc-field-rehearsal. Every synthetic queue
-- row and lease transition is inside this transaction and is rolled back.
-- ============================================================================

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $test$
declare
  v_event_a constant text := repeat('c', 64);
  v_event_b constant text := repeat('d', 64);
  v_items jsonb;
  v_id_a uuid;
  v_id_b uuid;
  v_claim_token_a uuid;
  v_claim_token_b uuid;
  v_reclaimed_token uuid;
  v_receipt_id uuid;
  v_receipt_token uuid;
  v_outbox_id uuid := pg_catalog.gen_random_uuid();
  v_attempt bigint;
  v_enqueue_first integer;
  v_enqueue_duplicate integer;
  v_intake_rows bigint;
  v_wrong_receipt_renew boolean;
  v_owned_receipt_renew boolean;
  v_expired_receipt_renew boolean;
  v_foreign_finish boolean;
  v_foreign_release boolean;
  v_owned_release boolean;
  v_owned_release_state_ok boolean;
  v_reclaimed_finish boolean;
  v_denied boolean := false;
  v_rejected boolean := false;
  v_oversize_rejected boolean := false;
begin
  if pg_catalog.to_regprocedure(
       'public.hc_enqueue_webhook_intake(jsonb)'
     ) is null
     or (select pg_catalog.count(*) from auth.users) <> 1
     or not exists (
       select 1
       from auth.users
       where pg_catalog.lower(email) = 'siddsaxena@gmail.com'
         and email_confirmed_at is not null
     )
     or exists (
       select 1
       from public.orders
       where client_name not like 'Sandbox %'
     ) then
    raise exception using
      errcode = '55000',
      message = 'SANDBOX GUARD: expected migration 027 on the isolated rehearsal project';
  end if;

  v_items := pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object(
      'provider', 'ms_graph',
      'event_key', v_event_a,
      'payload', pg_catalog.jsonb_build_object(
        'id', 'sandbox-graph-a',
        'resourceData', pg_catalog.jsonb_build_object('id', 'message-a')
      )
    ),
    pg_catalog.jsonb_build_object(
      'provider', 'ms_graph',
      'event_key', v_event_b,
      'payload', pg_catalog.jsonb_build_object(
        'id', 'sandbox-graph-b',
        'resourceData', pg_catalog.jsonb_build_object('id', 'message-b')
      )
    )
  );

  perform pg_catalog.set_config('request.jwt.claim.role', 'authenticated', true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    pg_catalog.json_build_object('role', 'authenticated')::text,
    true
  );

  begin
    perform public.hc_enqueue_webhook_intake(v_items);
  exception
    when insufficient_privilege then
      v_denied := true;
  end;
  if v_denied is not true then
    raise exception using
      errcode = '55000',
      message = 'authenticated caller reached service-only intake enqueue';
  end if;

  perform pg_catalog.set_config('request.jwt.claim.role', 'service_role', true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    pg_catalog.json_build_object('role', 'service_role')::text,
    true
  );

  select claim.receipt_id, claim.claim_token
  into v_receipt_id, v_receipt_token
  from public.hc_claim_webhook_delivery(
    'ms_graph', pg_catalog.repeat('e', 64), 300
  ) as claim
  where claim.claim_state = 'claimed';

  if v_receipt_id is null or v_receipt_token is null then
    raise exception using
      errcode = '55000',
      message = 'receipt claim did not return an exact lease';
  end if;

  v_wrong_receipt_renew := public.hc_renew_webhook_delivery(
    'ms_graph', pg_catalog.repeat('e', 64),
    pg_catalog.gen_random_uuid(), 300
  );
  v_owned_receipt_renew := public.hc_renew_webhook_delivery(
    'ms_graph', pg_catalog.repeat('e', 64), v_receipt_token, 300
  );

  if v_wrong_receipt_renew is not false
     or v_owned_receipt_renew is not true then
    raise exception using
      errcode = '55000',
      message = 'exact receipt lease renewal contract failed';
  end if;

  update public.webhook_delivery_receipts
  set lease_expires_at = pg_catalog.clock_timestamp() - interval '1 second'
  where id = v_receipt_id;

  v_expired_receipt_renew := public.hc_renew_webhook_delivery(
    'ms_graph', pg_catalog.repeat('e', 64), v_receipt_token, 300
  );
  if v_expired_receipt_renew is not false then
    raise exception using
      errcode = '55000',
      message = 'expired receipt lease was incorrectly revived';
  end if;

  v_enqueue_first := public.hc_enqueue_webhook_intake(v_items);
  v_enqueue_duplicate := public.hc_enqueue_webhook_intake(v_items);
  select pg_catalog.count(*)
  into v_intake_rows
  from public.webhook_intake_queue
  where event_key in (v_event_a, v_event_b);

  if v_enqueue_first <> 2
     or v_enqueue_duplicate <> 2
     or v_intake_rows <> 2 then
    raise exception using
      errcode = '55000',
      message = 'intake enqueue or exact duplicate handling failed';
  end if;

  begin
    perform public.hc_enqueue_webhook_intake(
      pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'provider', 'ms_graph',
          'event_key', v_event_a,
          'payload', pg_catalog.jsonb_build_object('id', 'changed-payload')
        )
      )
    );
  exception
    when unique_violation then
      v_rejected := true;
  end;
  if v_rejected is not true then
    raise exception using
      errcode = '55000',
      message = 'stable intake identity accepted a changed payload';
  end if;

  select claim.intake_id, claim.claim_token
  into v_id_a, v_claim_token_a
  from public.hc_claim_webhook_intake(1, 300) as claim;

  select claim.intake_id, claim.claim_token
  into v_id_b, v_claim_token_b
  from public.hc_claim_webhook_intake(1, 300) as claim;

  if v_id_a is null or v_id_b is null or v_id_a = v_id_b
     or v_claim_token_a is null or v_claim_token_b is null then
    raise exception using
      errcode = '55000',
      message = 'intake claims did not create independent exact leases';
  end if;

  v_foreign_finish := public.hc_finish_webhook_intake(
    v_id_a, pg_catalog.gen_random_uuid()
  );
  v_foreign_release := public.hc_release_webhook_intake(
    v_id_a, pg_catalog.gen_random_uuid(), 30, 'sandbox retry'
  );
  if v_foreign_finish is not false
     or v_foreign_release is not false then
    raise exception using
      errcode = '55000',
      message = 'foreign intake lease changed queue state';
  end if;

  v_owned_release := public.hc_release_webhook_intake(
    v_id_a, v_claim_token_a, 30, 'sandbox retry'
  );
  select exists (
       select 1
       from public.webhook_intake_queue
       where id = v_id_a
         and delivery_state = 'pending'
         and next_attempt_at > pg_catalog.clock_timestamp()
         and lease_token is null
  ) into v_owned_release_state_ok;

  if v_owned_release is not true
     or v_owned_release_state_ok is not true then
    raise exception using
      errcode = '55000',
      message = 'owning intake release did not schedule backoff';
  end if;

  update public.webhook_intake_queue
  set next_attempt_at = pg_catalog.clock_timestamp() - interval '1 second'
  where id = v_id_a;

  select claim.claim_token, claim.attempt_count
  into v_reclaimed_token, v_attempt
  from public.hc_claim_webhook_intake(1, 300) as claim
  where claim.intake_id = v_id_a;

  if v_reclaimed_token is null
     or v_reclaimed_token = v_claim_token_a
     or v_attempt <> 2 then
    raise exception using
      errcode = '55000',
      message = 'released intake did not reclaim exactly';
  end if;

  v_reclaimed_finish := public.hc_finish_webhook_intake(
    v_id_a, v_reclaimed_token
  );
  if v_reclaimed_finish is not true then
    raise exception using
      errcode = '55000',
      message = 'released intake did not reclaim and finish exactly';
  end if;

  update public.webhook_intake_queue
  set lease_expires_at = pg_catalog.clock_timestamp() - interval '1 second'
  where id = v_id_b;

  select claim.claim_token, claim.attempt_count
  into v_reclaimed_token, v_attempt
  from public.hc_claim_webhook_intake(1, 300) as claim
  where claim.intake_id = v_id_b;

  if v_reclaimed_token is null
     or v_reclaimed_token = v_claim_token_b
     or v_attempt <> 2 then
    raise exception using
      errcode = '55000',
      message = 'expired intake lease did not recover';
  end if;

  -- A 4,096-code-point message made entirely of four-byte Unicode characters
  -- produces about 21,912 base64 ciphertext characters after JSON and the GCM
  -- tag. This synthetic shape proves that valid Worker output fits migration
  -- 027, while the explicit upper bound still rejects unbounded payloads.
  insert into public.push_queue (
    id,
    kind,
    outbox_type,
    payload
  ) values (
    v_outbox_id,
    'alert',
    'webhook_telegram',
    pg_catalog.jsonb_build_object(
      'tokens', pg_catalog.jsonb_build_array(),
      'headers', pg_catalog.jsonb_build_object(
        'collapse_id', v_outbox_id::text
      ),
      'aps', pg_catalog.jsonb_build_object(),
      'telegram_outbox', pg_catalog.jsonb_build_object(
        'version', 2,
        'key_version', 'sandbox-current',
        'nonce', 'AAAAAAAAAAAAAAAA',
        'ciphertext', pg_catalog.repeat('A', 21912)
      )
    )
  );

  if not exists (
    select 1
    from public.push_queue
    where id = v_outbox_id
      and outbox_type = 'webhook_telegram'
      and pg_catalog.char_length(
        payload -> 'telegram_outbox' ->> 'ciphertext'
      ) = 21912
      and next_attempt_at is not null
      and done_at is null
  ) then
    raise exception using
      errcode = '55000',
      message = '4096-character encrypted outbox shape was rejected';
  end if;

  begin
    insert into public.push_queue (
      id,
      kind,
      outbox_type,
      payload
    ) values (
      pg_catalog.gen_random_uuid(),
      'alert',
      'webhook_telegram',
      pg_catalog.jsonb_build_object(
        'tokens', pg_catalog.jsonb_build_array(),
        'telegram_outbox', pg_catalog.jsonb_build_object(
          'version', 2,
          'key_version', 'sandbox-current',
          'nonce', 'AAAAAAAAAAAAAAAA',
          'ciphertext', pg_catalog.repeat('A', 32769)
        )
      )
    );
  exception
    when check_violation then
      v_oversize_rejected := true;
  end;
  if v_oversize_rejected is not true then
    raise exception using
      errcode = '55000',
      message = 'oversize encrypted outbox payload bypassed its bound';
  end if;

  if pg_catalog.has_table_privilege(
       'service_role', 'public.webhook_intake_queue', 'SELECT'
     )
     or pg_catalog.has_table_privilege(
       'authenticated', 'public.webhook_intake_queue', 'SELECT'
     )
     or not pg_catalog.has_table_privilege(
       'service_role', 'public.push_queue', 'SELECT,INSERT,UPDATE,DELETE'
     )
     or pg_catalog.has_table_privilege(
       'authenticated', 'public.push_queue', 'SELECT'
     )
     or exists (
       select 1
       from public.webhook_intake_queue
       where payload ? 'clientState'
          or payload ? 'validationTokens'
     ) then
    raise exception using
      errcode = '55000',
      message = 'queue ACL or payload privacy contract failed';
  end if;
end
$test$;

rollback;

select
  'passed'::text as webhook_async_intake_runtime_rehearsal,
  13::integer as scenarios_checked;

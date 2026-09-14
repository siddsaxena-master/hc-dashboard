-- ============================================================================
-- 044_order_reconfirmations.sql
-- The reconfirmation email: one row per order per delivery day, drafted by
-- the Claudia worker from stored facts (no AI writes the words), previewed
-- by the owner in HC Field, sent by the droplet from the owner's mailbox,
-- and stamped with the customer's reply. Written 2026-09-14 against
-- RECONFIRMATION-CONTRACT-2026-09-14.md section 1.
--
-- LOCAL PREPARATION ONLY until Sidd approves the production run.
--
-- What this adds:
--   * public.order_reconfirmations: the draft, its facts, the recipients, the
--     picture choice, the hold reasons, and every timestamp of its life
--     (preview, reminder, decision, claim, send, reply). The worker and the
--     droplet write it with the service key. Readable by owner phones only;
--     the public dashboard key gets nothing, because the row carries
--     customer emails, addresses and phone numbers.
--   * public.hc_decide_reconfirmation(id, decision): the owner's Send now,
--     Hold, Release, Skip, Resend and Done from the phone. Owner only, the
--     same caller check as 043. Each decision is one allowed transition;
--     anything else is refused with a plain sentence and nothing changes.
--   * public.intake_messages.conversation_id: Microsoft's thread id, stored
--     by the Outlook poller on insert so a customer's reply is matched to
--     the email it answers even when the subject was edited.
--
-- What this never touches: orders (nothing customer-facing is added there;
-- the public key can still read every orders row until 020 lands),
-- delivery_request, order_time_proposals, every existing policy or function,
-- and intake_messages beyond the one new column and its index.
-- ============================================================================

begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';

do $preflight$
declare
  v_column text;
  v_type text;
begin
  if pg_catalog.to_regclass('public.orders') is null
     or pg_catalog.to_regclass('public.intake_messages') is null
     or pg_catalog.to_regclass('public.field_workers') is null
     or pg_catalog.to_regprocedure('auth.uid()') is null
     or pg_catalog.to_regprocedure('public.hc_is_owner()') is null then
    raise exception using
      errcode = '55000',
      message = '044 requires orders, intake_messages, field_workers, auth.uid() and public.hc_is_owner() (015)';
  end if;

  -- The worker reads these to decide who qualifies and what the email says.
  foreach v_column in array array['id', 'stage', 'market', 'client_email', 'delivery_at_utc'] loop
    if not exists (
      select 1 from pg_catalog.pg_attribute
      where attrelid = 'public.orders'::regclass
        and attname = v_column
        and attnum > 0
        and not attisdropped
    ) then
      raise exception using
        errcode = '55000',
        message = pg_catalog.format('044 requires column public.orders.%s', v_column);
    end if;
  end loop;

  -- The reply step matches an intake row to a sent email by these.
  foreach v_column in array array['id', 'order_id', 'status', 'from_addr'] loop
    if not exists (
      select 1 from pg_catalog.pg_attribute
      where attrelid = 'public.intake_messages'::regclass
        and attname = v_column
        and attnum > 0
        and not attisdropped
    ) then
      raise exception using
        errcode = '55000',
        message = pg_catalog.format('044 requires column public.intake_messages.%s (004)', v_column);
    end if;
  end loop;

  -- The owner check reads the roster the way 043 does.
  foreach v_column in array array['id', 'role', 'active', 'auth_user_id'] loop
    if not exists (
      select 1 from pg_catalog.pg_attribute
      where attrelid = 'public.field_workers'::regclass
        and attname = v_column
        and attnum > 0
        and not attisdropped
    ) then
      raise exception using
        errcode = '55000',
        message = pg_catalog.format('044 requires column public.field_workers.%s (015)', v_column);
    end if;
  end loop;

  -- A conversation_id that already exists must be text, or the poller's
  -- insert would fail in a way nobody would notice for days.
  select pg_catalog.format_type(a.atttypid, a.atttypmod) into v_type
  from pg_catalog.pg_attribute as a
  where a.attrelid = 'public.intake_messages'::regclass
    and a.attname = 'conversation_id'
    and a.attnum > 0
    and not a.attisdropped;
  if v_type is not null and v_type <> 'text' then
    raise exception using
      errcode = '55000',
      message = pg_catalog.format('044 refuses an existing public.intake_messages.conversation_id of type %s; review that column before applying', v_type);
  end if;

  if pg_catalog.to_regclass('public.order_reconfirmations') is not null then
    foreach v_column in array array['id', 'order_id', 'delivery_day', 'status', 'hold_reasons', 'facts', 'subject', 'body', 'recipients', 'send_after', 'decision', 'reply_kind'] loop
      if not exists (
        select 1 from pg_catalog.pg_attribute
        where attrelid = 'public.order_reconfirmations'::regclass
          and attname = v_column
          and attnum > 0
          and not attisdropped
      ) then
        raise exception using
          errcode = '55000',
          message = pg_catalog.format(
            '044 refuses an existing public.order_reconfirmations with no %s column; review that table before applying',
            v_column);
      end if;
    end loop;
  end if;
end
$preflight$;

-- Microsoft's thread id on each intake email. Nullable: rows the poller
-- wrote before this migration stay null and are matched by sender instead.
alter table public.intake_messages
  add column if not exists conversation_id text;

create index if not exists intake_messages_conversation_id_idx
  on public.intake_messages (conversation_id);

comment on column public.intake_messages.conversation_id is
  'Microsoft Graph conversationId of the email, stored by the Outlook poller on insert. A reply to a reconfirmation email is matched to the sent row by this before the sender address is tried. Null on rows written before 044.';

-- One reconfirmation per order per delivery day. Status meanings:
--   held        a hard fact is missing (hold_reasons says which); nothing sends
--   ready       drafted and previewable; auto mode releases it at send_after
--   released    cleared to send (the owner tapped Send now, or auto mode)
--   claimed     the droplet picked it up and is creating the draft
--   sent        left the owner's mailbox
--   confirmed   the customer replied with a plain confirmation
--   changed     a fact changed after the send, or the reply asked for a change
--   bounced     Microsoft or the far mail server rejected it
--   skipped     the owner chose not to send this one
--   expired     still held on delivery day minus 1; the digest names it
--   superseded  replaced by a fresh row (Resend); the unique index ignores it
create table if not exists public.order_reconfirmations (
  id bigint generated always as identity primary key,
  order_id uuid not null references public.orders(id) on delete cascade,
  -- The date text of orders.delivery_at_utc, taken as written and never
  -- converted between zones (Jarvis stores it as midnight UTC).
  delivery_day date not null,
  status text not null default 'ready' check (status in (
    'held', 'ready', 'released', 'claimed', 'sent', 'confirmed', 'changed',
    'bounced', 'skipped', 'expired', 'superseded')),
  -- Why a row is held. Every value must be one the app knows how to name.
  hold_reasons text[] not null default '{}' check (hold_reasons <@ array[
    'count_missing', 'address_missing', 'cracking_unknown', 'pending_time_proposal',
    'no_email', 'billing_email_only', 'too_many_emails', 'date_unverified',
    'owner_hold']::text[]),
  -- {source: {...the order fields as read...}, derived: {...the words...}}.
  -- The droplet compares facts.source field by field before it sends.
  facts jsonb not null default '{}' check (pg_catalog.jsonb_typeof(facts) = 'object'),
  subject text not null check (pg_catalog.length(subject) between 1 and 200),
  body text not null check (pg_catalog.length(body) between 1 and 6000),
  recipients text[] not null default '{}',
  -- Null, or {source: 'logo_asset' | 'logo_url', bucket, path, content_type}.
  -- Never a signed URL and never a public URL: the droplet fetches the bytes
  -- and embeds them, so the customer never receives a link to our bucket.
  picture jsonb check (picture is null or (
    pg_catalog.jsonb_typeof(picture) = 'object'
    and picture ->> 'source' in ('logo_asset', 'logo_url'))),
  -- The worker mode when the row was drafted. Informational.
  mode text not null default 'preview' check (mode in ('preview', 'auto')),
  -- Phase A: when set, the droplet sends ONLY to this address and appends
  -- " [TEST for <recipients>]" to the subject.
  test_to text,
  -- When auto mode may release it (10:00 market time on delivery_day minus
  -- 4, or the late-arrival rule). Null means Send now only.
  send_after timestamptz,
  previewed_at timestamptz,
  reminded_at timestamptz,
  decided_at timestamptz,
  decided_by uuid,
  decision text check (decision is null or decision in ('send_now', 'hold', 'release', 'skip', 'resend', 'done')),
  claimed_at timestamptz,
  sent_at timestamptz,
  draft_message_id text,
  sent_message_id text,
  sent_conversation_id text,
  reply_kind text check (reply_kind is null or reply_kind in ('confirmed', 'time', 'changed', 'bounced', 'auto_reply')),
  replied_at timestamptz,
  reply_intake_id bigint,
  -- Plain words for the owner, for example 'count 100 to 120'.
  change_note text,
  error_detail text,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now()
);

-- One live row per order per delivery day. A superseded row steps aside so
-- Resend can draft a fresh one; every other status counts as live, so a
-- repeated scan or a redeploy can never double-draft.
create unique index if not exists order_reconfirmations_active_order_day_uidx
  on public.order_reconfirmations (order_id, delivery_day)
  where status <> 'superseded';

create index if not exists order_reconfirmations_status_send_after_idx
  on public.order_reconfirmations (status, send_after);

create index if not exists order_reconfirmations_order_idx
  on public.order_reconfirmations (order_id);

alter table public.order_reconfirmations enable row level security;

-- Supabase's bootstrap default privileges hand every new table to anon,
-- authenticated AND service_role in full. Take every default back, then
-- grant exactly what the contract names: phones read (the policy below
-- narrows that to the owner), the service key reads, inserts and updates.
-- Nobody deletes by hand; rows cascade away with their order.
revoke all on table public.order_reconfirmations from public, anon, authenticated, service_role;
grant select on table public.order_reconfirmations to authenticated;
grant select, insert, update on table public.order_reconfirmations to service_role;

drop policy if exists order_reconfirmations_owner_select on public.order_reconfirmations;
create policy order_reconfirmations_owner_select
on public.order_reconfirmations
for select to authenticated
using (public.hc_is_owner());

-- The owner's decision from the phone.
--   p_id        the order_reconfirmations row
--   p_decision  send_now | hold | release | skip | resend | done
-- One allowed transition per decision:
--   send_now  ready -> released, send_after = now
--   hold      ready -> held, hold_reasons = {owner_hold}
--   release   held with hold_reasons = {owner_hold} -> ready, reasons cleared
--             (any other hold: fix the missing detail first)
--   skip      ready or held -> skipped
--   resend    sent, confirmed, changed or bounced -> superseded (the worker
--             drafts a fresh row on its next hour, subject "Updated details
--             for ..."; after a bounce the first-time subject is used again,
--             because the customer never saw the first email)
--   done      changed -> sent (the change is acknowledged, change_note kept)
-- Returns jsonb { applied, status, row: {id, order_id, delivery_day, status,
-- hold_reasons, send_after} }. Raises 42501 for the wrong caller and 22023,
-- with a plain sentence, for any other decision or state. Never sends
-- anything itself: the droplet reads released rows on its own clock.
create or replace function public.hc_decide_reconfirmation(
  p_id bigint,
  p_decision text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_me public.field_workers%rowtype;
  v_row public.order_reconfirmations%rowtype;
  v_decision text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_decision, '')));
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if v_uid is null then
    raise exception using
      errcode = '42501',
      message = 'authenticated field worker required';
  end if;

  select w.* into v_me
  from public.field_workers as w
  where w.auth_user_id = v_uid
    and w.active is true
  limit 1;

  if v_me.id is null or pg_catalog.lower(pg_catalog.btrim(coalesce(v_me.role, ''))) <> 'owner' then
    raise exception using
      errcode = '42501',
      message = 'only the owner can decide a reconfirmation';
  end if;

  if v_decision not in ('send_now', 'hold', 'release', 'skip', 'resend', 'done') then
    raise exception using
      errcode = '22023',
      message = 'decision must be send_now, hold, release, skip, resend or done';
  end if;

  if p_id is null then
    raise exception using
      errcode = '22023',
      message = 'a reconfirmation id is required';
  end if;

  -- Hold the row for the rest of this call so two taps cannot interleave,
  -- and so the droplet's claim and a tap never cross.
  select r.* into v_row
  from public.order_reconfirmations as r
  where r.id = p_id
  for update;

  if not found then
    raise exception using
      errcode = '22023',
      message = 'No such reconfirmation';
  end if;

  if v_decision = 'send_now' then
    if v_row.status <> 'ready' then
      raise exception using
        errcode = '22023',
        message = pg_catalog.format('Send now needs a ready reconfirmation; this one is %s.', v_row.status);
    end if;
    update public.order_reconfirmations
       set status = 'released',
           send_after = v_now,
           decision = v_decision,
           decided_at = v_now,
           decided_by = v_uid,
           updated_at = v_now
     where id = v_row.id
     returning * into v_row;

  elsif v_decision = 'hold' then
    if v_row.status <> 'ready' then
      raise exception using
        errcode = '22023',
        message = pg_catalog.format('Hold needs a ready reconfirmation; this one is %s.', v_row.status);
    end if;
    update public.order_reconfirmations
       set status = 'held',
           hold_reasons = array['owner_hold']::text[],
           decision = v_decision,
           decided_at = v_now,
           decided_by = v_uid,
           updated_at = v_now
     where id = v_row.id
     returning * into v_row;

  elsif v_decision = 'release' then
    if v_row.status <> 'held' then
      raise exception using
        errcode = '22023',
        message = pg_catalog.format('Release needs a held reconfirmation; this one is %s.', v_row.status);
    end if;
    -- Only the owner's own hold can be lifted by hand. A missing count,
    -- address, cracking, email or time proposal is lifted by fixing the fact
    -- where it lives; the worker then re-drafts the row as ready itself.
    if v_row.hold_reasons <> array['owner_hold']::text[] then
      raise exception using
        errcode = '22023',
        message = 'Only an owner hold can be released by hand; fix the missing detail first.';
    end if;
    update public.order_reconfirmations
       set status = 'ready',
           hold_reasons = '{}'::text[],
           decision = v_decision,
           decided_at = v_now,
           decided_by = v_uid,
           updated_at = v_now
     where id = v_row.id
     returning * into v_row;

  elsif v_decision = 'skip' then
    if v_row.status not in ('ready', 'held') then
      raise exception using
        errcode = '22023',
        message = pg_catalog.format('Skip needs a ready or held reconfirmation; this one is %s.', v_row.status);
    end if;
    update public.order_reconfirmations
       set status = 'skipped',
           decision = v_decision,
           decided_at = v_now,
           decided_by = v_uid,
           updated_at = v_now
     where id = v_row.id
     returning * into v_row;

  elsif v_decision = 'resend' then
    -- A bounced row may be resent too: the owner fixes the customer email on
    -- the invoice, taps Resend, and the worker drafts the first email again.
    if v_row.status not in ('sent', 'confirmed', 'changed', 'bounced') then
      raise exception using
        errcode = '22023',
        message = pg_catalog.format('Resend needs a sent, confirmed, changed or bounced reconfirmation; this one is %s.', v_row.status);
    end if;
    update public.order_reconfirmations
       set status = 'superseded',
           decision = v_decision,
           decided_at = v_now,
           decided_by = v_uid,
           updated_at = v_now
     where id = v_row.id
     returning * into v_row;

  else
    -- done
    if v_row.status <> 'changed' then
      raise exception using
        errcode = '22023',
        message = pg_catalog.format('Done needs a changed reconfirmation; this one is %s.', v_row.status);
    end if;
    update public.order_reconfirmations
       set status = 'sent',
           decision = v_decision,
           decided_at = v_now,
           decided_by = v_uid,
           updated_at = v_now
     where id = v_row.id
     returning * into v_row;
  end if;

  return pg_catalog.jsonb_build_object(
    'applied', true,
    'status', v_row.status,
    'row', pg_catalog.jsonb_build_object(
      'id', v_row.id,
      'order_id', v_row.order_id,
      'delivery_day', v_row.delivery_day,
      'status', v_row.status,
      'hold_reasons', v_row.hold_reasons,
      'send_after', v_row.send_after));
end
$function$;

-- Supabase default privileges hand execute on a new function to anon,
-- authenticated AND service_role. Take every default back, then grant the
-- one caller: a logged-in phone (the function checks the owner role
-- itself). The worker and the droplet never call this.
revoke all on function public.hc_decide_reconfirmation(bigint, text)
  from public, anon, authenticated, service_role;
grant execute on function public.hc_decide_reconfirmation(bigint, text)
  to authenticated;

comment on function public.hc_decide_reconfirmation(bigint, text) is
  'Owner-only decision on a reconfirmation email from the phone: send_now (ready to released), hold (ready to held with owner_hold), release (an owner hold back to ready; other holds must be fixed where the fact lives), skip (ready or held to skipped), resend (sent, confirmed, changed or bounced to superseded so the worker drafts a fresh row), done (changed back to sent). Any other transition raises 22023 and changes nothing. Never sends anything itself.';

comment on table public.order_reconfirmations is
  'One reconfirmation email per order per delivery day: drafted by the Claudia worker from stored facts, previewed by the owner in HC Field, sent by the droplet from the owner''s mailbox, stamped with the customer''s reply. Owner-readable only; the public dashboard key gets nothing. A superseded row is replaced by a fresh one on Resend.';

do $postflight$
begin
  if pg_catalog.to_regclass('public.order_reconfirmations') is null
     or not (select c.relrowsecurity from pg_catalog.pg_class as c where c.oid = 'public.order_reconfirmations'::regclass) then
    raise exception using errcode = '55000', message = '044 postflight: the table or its row security is missing';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'public' and tablename = 'order_reconfirmations'
      and policyname = 'order_reconfirmations_owner_select'
  ) then
    raise exception using errcode = '55000', message = '044 postflight: the owner select policy is missing';
  end if;
  if pg_catalog.to_regclass('public.order_reconfirmations_active_order_day_uidx') is null
     or pg_catalog.to_regclass('public.order_reconfirmations_status_send_after_idx') is null
     or pg_catalog.to_regclass('public.order_reconfirmations_order_idx') is null then
    raise exception using errcode = '55000', message = '044 postflight: an index on order_reconfirmations is missing';
  end if;
  -- A name is not enough. The body uses "if not exists" so a re-run is
  -- harmless, which also means a table that already existed could carry a
  -- plain index squatting on the unique index name, or a second, wider read
  -- policy. Check the one-live-row rule is really enforced (unique AND
  -- partial) and that the owner select is the only policy.
  if not exists (
    select 1 from pg_catalog.pg_index as i
    where i.indexrelid = 'public.order_reconfirmations_active_order_day_uidx'::regclass
      and i.indrelid = 'public.order_reconfirmations'::regclass
      and i.indisunique
      and i.indpred is not null
  ) then
    raise exception using errcode = '55000', message = '044 postflight: order_reconfirmations_active_order_day_uidx is not a unique partial index';
  end if;
  if (select pg_catalog.count(*) from pg_catalog.pg_policies
      where schemaname = 'public' and tablename = 'order_reconfirmations') <> 1 then
    raise exception using errcode = '55000', message = '044 postflight: order_reconfirmations must carry exactly one policy (the owner select)';
  end if;
  -- Anon: nothing. Authenticated: select only (the policy narrows it to the
  -- owner). service_role: select, insert, update and nothing more.
  if pg_catalog.has_table_privilege('anon', 'public.order_reconfirmations', 'select')
     or pg_catalog.has_table_privilege('anon', 'public.order_reconfirmations', 'insert')
     or pg_catalog.has_table_privilege('anon', 'public.order_reconfirmations', 'update')
     or pg_catalog.has_table_privilege('anon', 'public.order_reconfirmations', 'delete')
     or not pg_catalog.has_table_privilege('authenticated', 'public.order_reconfirmations', 'select')
     or pg_catalog.has_table_privilege('authenticated', 'public.order_reconfirmations', 'insert')
     or pg_catalog.has_table_privilege('authenticated', 'public.order_reconfirmations', 'update')
     or pg_catalog.has_table_privilege('authenticated', 'public.order_reconfirmations', 'delete')
     or not pg_catalog.has_table_privilege('service_role', 'public.order_reconfirmations', 'select')
     or not pg_catalog.has_table_privilege('service_role', 'public.order_reconfirmations', 'insert')
     or not pg_catalog.has_table_privilege('service_role', 'public.order_reconfirmations', 'update')
     or pg_catalog.has_table_privilege('service_role', 'public.order_reconfirmations', 'delete') then
    raise exception using errcode = '55000', message = '044 postflight: table grants are wrong';
  end if;
  if pg_catalog.to_regprocedure('public.hc_decide_reconfirmation(bigint, text)') is null
     or pg_catalog.has_function_privilege('anon', 'public.hc_decide_reconfirmation(bigint, text)', 'execute')
     or pg_catalog.has_function_privilege('service_role', 'public.hc_decide_reconfirmation(bigint, text)', 'execute')
     or not pg_catalog.has_function_privilege('authenticated', 'public.hc_decide_reconfirmation(bigint, text)', 'execute') then
    raise exception using errcode = '55000', message = '044 postflight: hc_decide_reconfirmation grants are wrong';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_attribute as a
    where a.attrelid = 'public.intake_messages'::regclass
      and a.attname = 'conversation_id'
      and a.attnum > 0
      and not a.attisdropped
      and pg_catalog.format_type(a.atttypid, a.atttypmod) = 'text'
  ) or pg_catalog.to_regclass('public.intake_messages_conversation_id_idx') is null then
    raise exception using errcode = '55000', message = '044 postflight: intake_messages.conversation_id or its index is missing';
  end if;
end
$postflight$;

commit;

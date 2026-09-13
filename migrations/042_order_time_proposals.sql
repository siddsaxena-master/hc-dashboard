-- ============================================================================
-- 042_order_time_proposals.sql
-- A proposed delivery time found in an email about a booked job, waiting for
-- the owner's Accept or Keep in the HC Field app.
--
-- LOCAL PREPARATION ONLY until Sidd approves the production run.
--
-- Why: on 2026-09-10 a wedding coordinator's PDF said "2:00 PM Hamptons
-- Coconuts" while the order said 3:30/4 PM. Nothing connected the two. Now
-- Jarvis links the email to the order and the Claudia worker reads the
-- time out of the PDF text; this table is where that reading waits for a
-- human. Nothing here changes a delivery time by itself: approval-first
-- (Sidd, 2026-07-25) stays the rule.
--
-- What this adds:
--   * public.order_time_proposals: one row per intake email (intake_id is
--     the primary key), pointing at one order, holding the proposed time,
--     the line it was read from, and a snapshot of what was on file. The
--     worker writes it with the service key. status: pending, accepted,
--     kept, superseded.
--   * public.hc_decide_proposed_time(order, intake, decision): the owner's
--     Accept or Keep. Accept goes through the SAME door as the app's own
--     delivery-time sheet, hc_set_delivery_request (038), under the owner's
--     own login, so every rule that protects that field (invoice date,
--     cancelled orders, replay safety) applies unchanged. It refuses to
--     apply when the owner typed a newer time by hand after the email
--     arrived, when the invoice date moved, or when the order is
--     cancelled, and says so instead of raising. Both decisions dismiss
--     the intake row so the Telegram queue stops nagging.
--
-- Reading: owner only (row level security with public.hc_is_owner()), a
-- SELECT grant to the authenticated role, nothing for anon or PUBLIC.
-- Managers do not see proposals (decision D-E); one predicate change here
-- would open it to them.
--
-- What this never touches: orders directly (only through 038's function),
-- delivery_request's contract, intake_messages beyond the status flip a
-- decision makes, and every existing policy or function.
-- ============================================================================

begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';

do $preflight$
declare
  v_column text;
  v_check text;
begin
  if pg_catalog.to_regclass('public.orders') is null
     or pg_catalog.to_regclass('public.intake_messages') is null
     or pg_catalog.to_regprocedure('auth.uid()') is null
     or pg_catalog.to_regprocedure('public.hc_is_owner()') is null
     or pg_catalog.to_regprocedure('public.hc_set_delivery_request(uuid,text,text,date,text,text)') is null then
    raise exception using
      errcode = '55000',
      message = '042 requires orders, intake_messages, auth.uid(), public.hc_is_owner() (015) and public.hc_set_delivery_request(uuid,text,text,date,text,text) (038)';
  end if;

  foreach v_column in array array['id', 'order_id', 'status', 'reviewed_at', 'error_detail'] loop
    if not exists (
      select 1 from pg_catalog.pg_attribute
      where attrelid = 'public.intake_messages'::regclass
        and attname = v_column
        and attnum > 0
        and not attisdropped
    ) then
      raise exception using
        errcode = '55000',
        message = pg_catalog.format('042 requires column public.intake_messages.%s (004)', v_column);
    end if;
  end loop;

  foreach v_column in array array['id', 'stage', 'market', 'delivery_at_utc', 'delivery_request'] loop
    if not exists (
      select 1 from pg_catalog.pg_attribute
      where attrelid = 'public.orders'::regclass
        and attname = v_column
        and attnum > 0
        and not attisdropped
    ) then
      raise exception using
        errcode = '55000',
        message = pg_catalog.format('042 requires column public.orders.%s (034 adds delivery_request)', v_column);
    end if;
  end loop;

  -- A decision dismisses the intake row; the status list must allow it.
  select pg_catalog.pg_get_constraintdef(c.oid) into v_check
  from pg_catalog.pg_constraint as c
  where c.conrelid = 'public.intake_messages'::regclass
    and c.conname = 'intake_messages_status_check';
  if v_check is null or pg_catalog.strpos(v_check, 'dismissed') = 0 then
    raise exception using
      errcode = '55000',
      message = '042 requires the intake_messages status list to admit ''dismissed'' (004/005)';
  end if;

  if pg_catalog.to_regclass('public.order_time_proposals') is not null then
    foreach v_column in array array['intake_id', 'order_id', 'proposed_arrive_at', 'proposed_label', 'status', 'found_at'] loop
      if not exists (
        select 1 from pg_catalog.pg_attribute
        where attrelid = 'public.order_time_proposals'::regclass
          and attname = v_column
          and attnum > 0
          and not attisdropped
      ) then
        raise exception using
          errcode = '55000',
          message = pg_catalog.format(
            '042 refuses an existing public.order_time_proposals with no %s column; review that table before applying',
            v_column);
      end if;
    end loop;
  end if;
end
$preflight$;

create table if not exists public.order_time_proposals (
  -- One proposal per email. Cascades away with the email row.
  intake_id bigint primary key references public.intake_messages(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete cascade,
  -- The time the email named, as an instant, plus the words for the banner
  -- ('2:00 PM'). The label is what Accept writes as the window.
  proposed_arrive_at timestamptz not null,
  proposed_label text not null check (pg_catalog.length(proposed_label) between 1 and 40 and proposed_label !~ '[[:cntrl:]]'),
  -- The line it was read from and where (body or attachment name). Never
  -- an email address or phone number: the worker strips those first.
  evidence_line text check (evidence_line is null or pg_catalog.length(evidence_line) <= 200),
  evidence_where text check (evidence_where is null or pg_catalog.length(evidence_where) <= 120),
  -- What the order said when the proposal was made, so the app can say
  -- 're-check' if the on-file time moved meanwhile.
  on_file_window text check (on_file_window is null or pg_catalog.length(on_file_window) <= 80),
  on_file_checked_at text,
  found_at timestamptz not null default pg_catalog.now(),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'kept', 'superseded')),
  decided_at timestamptz,
  decided_by uuid,
  decided_via text check (decided_via is null or decided_via in ('app', 'owner_edit', 'date_moved', 'newer_email', 'cancelled')),
  -- When the last "Still waiting" banner went out.
  nagged_at timestamptz,
  updated_at timestamptz not null default pg_catalog.now()
);

create index if not exists order_time_proposals_order_status_idx
  on public.order_time_proposals (order_id, status);

alter table public.order_time_proposals enable row level security;

revoke all on table public.order_time_proposals from public, anon, authenticated;
grant select on table public.order_time_proposals to authenticated;
grant select, insert, update, delete on table public.order_time_proposals to service_role;

drop policy if exists order_time_proposals_owner_select on public.order_time_proposals;
create policy order_time_proposals_owner_select
on public.order_time_proposals
for select to authenticated
using (public.hc_is_owner());

-- The owner's decision. Returns jsonb:
--   { applied: true,  outcome: 'accepted' | 'kept', row }
--   { applied: false, outcome: 'accepted' | 'kept' | 'superseded' | 'refused'
--                   | 'cancelled', message, row }
-- Never raises for a state the app should simply show; raises 42501 for
-- the wrong caller and 22023 for a malformed call.
create or replace function public.hc_decide_proposed_time(
  p_order_id uuid,
  p_intake_id bigint,
  p_decision text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_decision text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_decision, '')));
  v_p public.order_time_proposals%rowtype;
  v_stage text;
  v_market text;
  v_request jsonb;
  v_checked timestamptz;
  v_zone text;
  v_day date;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_message text;
begin
  if v_uid is null then
    raise exception using
      errcode = '42501',
      message = 'authenticated field worker required';
  end if;

  if not public.hc_is_owner() then
    raise exception using
      errcode = '42501',
      message = 'only the owner can decide a proposed time';
  end if;

  if v_decision not in ('accept', 'keep') then
    raise exception using
      errcode = '22023',
      message = 'decision must be accept or keep';
  end if;

  if p_order_id is null or p_intake_id is null then
    raise exception using
      errcode = '22023',
      message = 'an order id and an intake id are required';
  end if;

  select p.* into v_p
  from public.order_time_proposals as p
  where p.intake_id = p_intake_id
    and p.order_id = p_order_id
  for update;

  if not found then
    raise exception using
      errcode = '22023',
      message = 'No such proposal';
  end if;

  -- Already decided: report it, write nothing.
  if v_p.status <> 'pending' then
    return pg_catalog.jsonb_build_object(
      'applied', false, 'outcome', v_p.status, 'decided_at', v_p.decided_at,
      'message', 'Already decided.', 'row', pg_catalog.to_jsonb(v_p));
  end if;

  select o.stage, o.market, o.delivery_request
  into v_stage, v_market, v_request
  from public.orders as o
  where o.id = p_order_id;

  if v_stage = 'cancelled' then
    update public.order_time_proposals
       set status = 'superseded', decided_via = 'cancelled', decided_at = v_now,
           decided_by = v_uid, updated_at = v_now
     where intake_id = p_intake_id
     returning * into v_p;
    return pg_catalog.jsonb_build_object(
      'applied', false, 'outcome', 'cancelled',
      'message', 'This order is cancelled.', 'row', pg_catalog.to_jsonb(v_p));
  end if;

  -- The owner typed a time by hand AFTER this email arrived: their word
  -- wins and this proposal is stale.
  begin
    v_checked := nullif(v_request ->> 'checked_at', '')::timestamptz;
  exception when others then
    v_checked := null;
  end;
  if v_request ->> 'source' = 'owner' and v_checked is not null and v_checked > v_p.found_at then
    update public.order_time_proposals
       set status = 'superseded', decided_via = 'owner_edit', decided_at = v_now,
           decided_by = v_uid, updated_at = v_now
     where intake_id = p_intake_id
     returning * into v_p;
    return pg_catalog.jsonb_build_object(
      'applied', false, 'outcome', 'superseded',
      'message', 'The time on file changed after this email arrived. Open the Calendar.',
      'row', pg_catalog.to_jsonb(v_p));
  end if;

  if v_decision = 'accept' then
    v_zone := case when pg_catalog.lower(pg_catalog.btrim(coalesce(v_market, ''))) = 'vegas'
                   then 'America/Los_Angeles' else 'America/New_York' end;
    v_day := (v_p.proposed_arrive_at at time zone v_zone)::date;
    -- The same door as the phone's sheet. 038 refuses a moved invoice date,
    -- an undated order and a cancelled order with 22023; that is reported
    -- as 'refused', never raised.
    begin
      perform public.hc_set_delivery_request(
        p_order_id,
        v_p.proposed_label,
        nullif(v_request ->> 'location', ''),
        v_day,
        nullif(v_request ->> 'contact_name', ''),
        nullif(v_request ->> 'contact_phone', ''));
    exception when sqlstate '22023' then
      v_message := sqlerrm;
      update public.order_time_proposals
         set status = 'superseded', decided_via = 'date_moved', decided_at = v_now,
             decided_by = v_uid, updated_at = v_now
       where intake_id = p_intake_id
       returning * into v_p;
      return pg_catalog.jsonb_build_object(
        'applied', false, 'outcome', 'refused', 'message', v_message,
        'row', pg_catalog.to_jsonb(v_p));
    end;
    update public.order_time_proposals
       set status = 'accepted', decided_via = 'app', decided_at = v_now,
           decided_by = v_uid, updated_at = v_now
     where intake_id = p_intake_id
     returning * into v_p;
  else
    update public.order_time_proposals
       set status = 'kept', decided_via = 'app', decided_at = v_now,
           decided_by = v_uid, updated_at = v_now
     where intake_id = p_intake_id
     returning * into v_p;
  end if;

  -- The email is answered either way; the Telegram queue stops nagging.
  -- Status-guarded: a row Sidd already acted on elsewhere is left alone.
  update public.intake_messages
     set status = 'dismissed',
         reviewed_at = v_now,
         error_detail = 'time proposal ' || v_p.status || ' by the owner in HC Field'
   where id = p_intake_id
     and status = 'pending_review';

  return pg_catalog.jsonb_build_object(
    'applied', true, 'outcome', v_p.status, 'row', pg_catalog.to_jsonb(v_p));
end
$function$;

revoke all on function public.hc_decide_proposed_time(uuid, bigint, text)
  from public, anon, authenticated, service_role;
grant execute on function public.hc_decide_proposed_time(uuid, bigint, text)
  to authenticated;

comment on function public.hc_decide_proposed_time(uuid, bigint, text) is
  'Owner-only Accept or Keep of a delivery time proposed by an email about a booked job. Accept writes the window through hc_set_delivery_request (038) under the owner''s login; a newer hand-typed time, a moved invoice date or a cancelled order is reported as not applied, never raised. Both decisions dismiss the intake row.';

comment on table public.order_time_proposals is
  'One proposed delivery time per intake email about a booked job (found by the Claudia worker in the email or its PDF), waiting for the owner''s Accept or Keep in HC Field. Owner-readable only. Never changes an order by itself.';

do $postflight$
begin
  if pg_catalog.to_regclass('public.order_time_proposals') is null
     or not (select c.relrowsecurity from pg_catalog.pg_class as c where c.oid = 'public.order_time_proposals'::regclass) then
    raise exception using errcode = '55000', message = '042 postflight: the table or its row security is missing';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'public' and tablename = 'order_time_proposals'
      and policyname = 'order_time_proposals_owner_select'
  ) then
    raise exception using errcode = '55000', message = '042 postflight: the owner select policy is missing';
  end if;
  if pg_catalog.has_table_privilege('anon', 'public.order_time_proposals', 'select')
     or not pg_catalog.has_table_privilege('authenticated', 'public.order_time_proposals', 'select')
     or pg_catalog.has_table_privilege('authenticated', 'public.order_time_proposals', 'update')
     or not pg_catalog.has_table_privilege('service_role', 'public.order_time_proposals', 'insert') then
    raise exception using errcode = '55000', message = '042 postflight: table grants are wrong';
  end if;
  if pg_catalog.to_regprocedure('public.hc_decide_proposed_time(uuid, bigint, text)') is null
     or pg_catalog.has_function_privilege('anon', 'public.hc_decide_proposed_time(uuid, bigint, text)', 'execute')
     or pg_catalog.has_function_privilege('service_role', 'public.hc_decide_proposed_time(uuid, bigint, text)', 'execute')
     or not pg_catalog.has_function_privilege('authenticated', 'public.hc_decide_proposed_time(uuid, bigint, text)', 'execute') then
    raise exception using errcode = '55000', message = '042 postflight: hc_decide_proposed_time grants are wrong';
  end if;
end
$postflight$;

commit;

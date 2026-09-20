-- ============================================================================
-- 047_passed_leads.sql
-- A lead the owner marks as PASSED from its Calendar card, with a reason, so
-- "Natali Carvalho passed due to cheaper price with Cocolux" is tracked
-- instead of remembered. Written 2026-09-19. Sidd chose the word: a lead
-- that went with someone else or went quiet is PASSED, in every column,
-- function, badge and digest line.
--
-- LOCAL PREPARATION ONLY until Sidd approves the production run.
--
-- Why: a lead is an orders row at stage inquiry or quoted. When it goes with
-- someone else, or goes quiet, nothing records that today; the card keeps its
-- LEAD badge and the follow-up to-do keeps nagging. Now the owner taps Mark
-- passed on the card, picks a reason (and the competitor when there is one),
-- and the row is retired the way a cancelled order is (stage cancelled, so
-- every existing cancelled filter, the follow-up to-do included, skips it)
-- while the reason lives in one jsonb column the phone, the dashboard and
-- the 8am digest can read. Reopen puts the lead back exactly where it was.
--
-- What this adds:
--   * public.orders.passed jsonb, null on every row until the owner marks the
--     lead. When set: {reason, competitor, note, at, by, prior_stage}.
--       reason       one of price, competitor, timing, no_reply,
--                    event_cancelled, other
--       competitor   the other company's name (60 characters at most) or null
--       note         a free line (200 characters at most) or null
--       at           when it was marked, ISO 8601 UTC text the shape
--                    JavaScript's toISOString produces
--                    (2026-09-19T14:05:00.000Z), so the digest's
--                    passed->>at=gte.<month start> text filter sorts right
--       by           the owner's auth user id
--       prior_stage  the stage before the mark (inquiry or quoted), what
--                    Reopen restores
--     A check constraint (orders_passed_check) holds that shape on every
--     write, whoever writes it.
--   * public.hc_mark_order_passed(order, reason, competitor, note): the mark.
--     Owner only. Sets stage cancelled, cancelled_at now, cancelled_reason
--     'passed: <reason>' (', <competitor>' appended when one was named) and
--     the passed record. Refuses (22023) anything that is not a lead: an
--     invoiced, paid, fulfilled, complete or hand-cancelled order stays as it
--     is. A second tap on a passed lead answers applied false, "Already
--     marked passed." and rewrites nothing.
--   * public.hc_reopen_passed_order(order): the undo. Owner only. Puts the
--     stage back to prior_stage, clears cancelled_at, cancelled_reason and
--     passed. Refuses (22023) an order that was never marked passed. If the
--     stage moved on since the mark (Jarvis invoiced it after a hand edit),
--     the stage is left where it is and only the passed record and the
--     cancelled fields are cleared, so Reopen can never push an invoiced
--     order back to quoted.
--
-- Both functions check the owner themselves (auth.uid() set and
-- public.hc_is_owner()), so execute is granted to authenticated only. The
-- worker, Jarvis and the public dashboard key never call them; the worker's
-- digest reads the column with the service key it already holds.
--
-- What this never touches: every other orders column and policy, the stage
-- check itself (cancelled is already in its list), hc_is_owner, the intake
-- and proposal tables, Jarvis's sync (a lead has no invoice, so the sync
-- never rewrites it; a hand-set stage is never auto-corrected either).
-- ============================================================================

begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';

do $preflight$
declare
  v_column text;
  v_type text;
  v_check text;
begin
  if pg_catalog.to_regclass('public.orders') is null
     or pg_catalog.to_regprocedure('auth.uid()') is null
     or pg_catalog.to_regprocedure('public.hc_is_owner()') is null then
    raise exception using
      errcode = '55000',
      message = '047 requires public.orders, auth.uid() and public.hc_is_owner() (015)';
  end if;

  -- The mark writes these four; Reopen reads them back.
  foreach v_column in array array['id', 'stage', 'cancelled_at', 'cancelled_reason', 'updated_at'] loop
    if not exists (
      select 1 from pg_catalog.pg_attribute
      where attrelid = 'public.orders'::regclass
        and attname = v_column
        and attnum > 0
        and not attisdropped
    ) then
      raise exception using
        errcode = '55000',
        message = pg_catalog.format('047 requires column public.orders.%s', v_column);
    end if;
  end loop;

  -- The mark sets stage = 'cancelled'. If an in-list check on stage exists
  -- (Postgres prints "stage in (...)" as "(stage = ANY (ARRAY[...]))") it
  -- must admit that word and the two lead words, or every mark would fail
  -- 23514. Other constraints that merely mention stage are left alone.
  for v_check in
    select pg_catalog.pg_get_constraintdef(c.oid)
    from pg_catalog.pg_constraint as c
    where c.conrelid = 'public.orders'::regclass
      and c.contype = 'c'
      and pg_catalog.pg_get_constraintdef(c.oid) ~ '\(stage(::text)? = ANY'
  loop
    if pg_catalog.strpos(v_check, '''cancelled''') = 0
       or pg_catalog.strpos(v_check, '''inquiry''') = 0
       or pg_catalog.strpos(v_check, '''quoted''') = 0 then
      raise exception using
        errcode = '55000',
        message = '047 requires the orders stage check to admit inquiry, quoted and cancelled; review that constraint before applying';
    end if;
  end loop;

  -- A passed column that already exists must be jsonb, or the functions
  -- would write into a column of the wrong shape.
  select pg_catalog.format_type(a.atttypid, a.atttypmod) into v_type
  from pg_catalog.pg_attribute as a
  where a.attrelid = 'public.orders'::regclass
    and a.attname = 'passed'
    and a.attnum > 0
    and not a.attisdropped;
  if v_type is not null and v_type <> 'jsonb' then
    raise exception using
      errcode = '55000',
      message = pg_catalog.format('047 refuses an existing public.orders.passed of type %s; review that column before applying', v_type);
  end if;
end
$preflight$;

-- A. The column. Null on every existing row.
alter table public.orders
  add column if not exists passed jsonb;

comment on column public.orders.passed is
  'Set by hc_mark_order_passed when the owner marks a lead passed (went with someone else, went quiet): {reason, competitor, note, at, by, prior_stage}. reason is one of price, competitor, timing, no_reply, event_cancelled, other; at is ISO 8601 UTC text; prior_stage is what hc_reopen_passed_order restores. Null on every order that was never marked passed. Passed is the word (Sidd, 2026-09-19).';

-- B. The shape, held on every write. Dropped and re-added under the same
-- name so a re-run is harmless. Every jsonb read is wrapped in coalesce: a
-- missing key would otherwise make the whole check NULL, and a NULL check
-- passes. competitor and note may be absent, JSON null, or a string within
-- the length; at must be present and non-blank.
alter table public.orders
  drop constraint if exists orders_passed_check;

alter table public.orders
  add constraint orders_passed_check check (
    passed is null
    or (
      pg_catalog.jsonb_typeof(passed) = 'object'
      and coalesce(passed ->> 'reason', '') in ('price', 'competitor', 'timing', 'no_reply', 'event_cancelled', 'other')
      and (
        passed -> 'competitor' is null
        or pg_catalog.jsonb_typeof(passed -> 'competitor') = 'null'
        or (pg_catalog.jsonb_typeof(passed -> 'competitor') = 'string'
            and pg_catalog.length(passed ->> 'competitor') <= 60))
      and (
        passed -> 'note' is null
        or pg_catalog.jsonb_typeof(passed -> 'note') = 'null'
        or (pg_catalog.jsonb_typeof(passed -> 'note') = 'string'
            and pg_catalog.length(passed ->> 'note') <= 200))
      and coalesce(pg_catalog.jsonb_typeof(passed -> 'at'), '') = 'string'
      and pg_catalog.btrim(coalesce(passed ->> 'at', '')) <> ''
      and coalesce(passed ->> 'prior_stage', '') in ('inquiry', 'quoted')
    )
  );

-- The digest's month read (passed not null, at >= month start) and the
-- phone's Passed chip both filter on the column; the rows are few, so a
-- partial index on the stamp keeps the read cheap without touching the
-- other 1,200 rows.
create index if not exists orders_passed_at_idx
  on public.orders ((passed ->> 'at'))
  where passed is not null;

-- C. The mark. Returns jsonb:
--   { applied: true,  row }
--   { applied: false, message: 'Already marked passed.', row }
-- Raises 42501 for the wrong caller and 22023 for a malformed call or an
-- order that is not a lead.
create or replace function public.hc_mark_order_passed(
  p_order_id uuid,
  p_reason text,
  p_competitor text default null,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_reason text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_reason, '')));
  -- The competitor name lands on one digest line, so runs of whitespace
  -- (a pasted newline included) fold to one space; blank means none.
  v_competitor text := nullif(pg_catalog.btrim(pg_catalog.regexp_replace(coalesce(p_competitor, ''), '\s+', ' ', 'g')), '');
  v_note text := nullif(pg_catalog.btrim(coalesce(p_note, '')), '');
  v_order public.orders%rowtype;
  v_now timestamptz := pg_catalog.now();
begin
  if v_uid is null then
    raise exception using
      errcode = '42501',
      message = 'authenticated field worker required';
  end if;

  if not public.hc_is_owner() then
    raise exception using
      errcode = '42501',
      message = 'only the owner can mark a lead passed';
  end if;

  if v_reason not in ('price', 'competitor', 'timing', 'no_reply', 'event_cancelled', 'other') then
    raise exception using
      errcode = '22023',
      message = 'reason must be one of price, competitor, timing, no_reply, event_cancelled, other';
  end if;

  if v_competitor is not null and pg_catalog.length(v_competitor) > 60 then
    raise exception using
      errcode = '22023',
      message = 'the competitor name is too long (60 characters at most)';
  end if;

  if v_note is not null and pg_catalog.length(v_note) > 200 then
    raise exception using
      errcode = '22023',
      message = 'the note is too long (200 characters at most)';
  end if;

  if p_order_id is null then
    raise exception using
      errcode = '22023',
      message = 'an order id is required';
  end if;

  -- Locked, so a double tap cannot mark the same lead twice.
  select o.* into v_order
  from public.orders as o
  where o.id = p_order_id
  for update;

  if not found then
    raise exception using
      errcode = '22023',
      message = 'No such order';
  end if;

  -- Already passed (its stage reads cancelled now): report it, write nothing.
  -- This runs before the stage check on purpose.
  if v_order.passed is not null then
    return pg_catalog.jsonb_build_object(
      'applied', false, 'message', 'Already marked passed.', 'row', pg_catalog.to_jsonb(v_order));
  end if;

  if v_order.stage not in ('inquiry', 'quoted') then
    raise exception using
      errcode = '22023',
      message = 'only a lead (stage inquiry or quoted) can be marked passed; this order is ' || coalesce(v_order.stage, 'unstaged');
  end if;

  update public.orders
     set stage = 'cancelled',
         cancelled_at = v_now,
         cancelled_reason = 'passed: ' || v_reason
           || case when v_competitor is not null then ', ' || v_competitor else '' end,
         passed = pg_catalog.jsonb_build_object(
           'reason', v_reason,
           'competitor', v_competitor,
           'note', v_note,
           -- ISO 8601, UTC, the shape JavaScript produces (038 does the same).
           'at', pg_catalog.to_char(v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           'by', v_uid,
           'prior_stage', v_order.stage),
         updated_at = v_now
   where id = p_order_id
   returning * into v_order;

  return pg_catalog.jsonb_build_object('applied', true, 'row', pg_catalog.to_jsonb(v_order));
end
$function$;

-- D. The undo. Returns { applied: true, row }. Raises 42501 for the wrong
-- caller and 22023 when the order is missing or was never marked passed.
create or replace function public.hc_reopen_passed_order(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_order public.orders%rowtype;
  v_prior text;
  v_now timestamptz := pg_catalog.now();
begin
  if v_uid is null then
    raise exception using
      errcode = '42501',
      message = 'authenticated field worker required';
  end if;

  if not public.hc_is_owner() then
    raise exception using
      errcode = '42501',
      message = 'only the owner can reopen a passed lead';
  end if;

  if p_order_id is null then
    raise exception using
      errcode = '22023',
      message = 'an order id is required';
  end if;

  select o.* into v_order
  from public.orders as o
  where o.id = p_order_id
  for update;

  if not found then
    raise exception using
      errcode = '22023',
      message = 'No such order';
  end if;

  if v_order.passed is null then
    raise exception using
      errcode = '22023',
      message = 'this order was never marked passed';
  end if;

  -- The stage goes back only while it still reads cancelled. An order that
  -- moved on since the mark keeps its stage; the record and the cancelled
  -- fields are cleared either way.
  v_prior := v_order.passed ->> 'prior_stage';
  if v_order.stage = 'cancelled' and v_prior in ('inquiry', 'quoted') then
    update public.orders
       set stage = v_prior,
           cancelled_at = null,
           cancelled_reason = null,
           passed = null,
           updated_at = v_now
     where id = p_order_id
     returning * into v_order;
  else
    update public.orders
       set cancelled_at = null,
           cancelled_reason = null,
           passed = null,
           updated_at = v_now
     where id = p_order_id
     returning * into v_order;
  end if;

  return pg_catalog.jsonb_build_object('applied', true, 'row', pg_catalog.to_jsonb(v_order));
end
$function$;

-- E. Grants. Supabase default privileges hand execute on a new function to
-- anon, authenticated AND service_role. Take every default back, then grant
-- the one caller: a logged-in phone (the functions check the owner role
-- themselves). The worker, Jarvis and the dashboard key never call these.
revoke all on function public.hc_mark_order_passed(uuid, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.hc_mark_order_passed(uuid, text, text, text)
  to authenticated;

revoke all on function public.hc_reopen_passed_order(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.hc_reopen_passed_order(uuid)
  to authenticated;

comment on function public.hc_mark_order_passed(uuid, text, text, text) is
  'Owner-only: mark a lead (stage inquiry or quoted) passed with a reason (price, competitor, timing, no_reply, event_cancelled, other), an optional competitor name and an optional note. Sets stage cancelled, cancelled_at, cancelled_reason (passed: <reason>, <competitor>) and the passed record. Anything that is not a lead is refused (22023). A second call on a passed lead answers applied false and rewrites nothing.';

comment on function public.hc_reopen_passed_order(uuid) is
  'Owner-only undo of hc_mark_order_passed: restores the stage recorded in passed.prior_stage (while the stage still reads cancelled), clears cancelled_at, cancelled_reason and passed. An order never marked passed is refused (22023).';

-- F. Postflight.
do $postflight$
declare
  v_check text;
  v_signature text;
begin
  if not exists (
    select 1 from pg_catalog.pg_attribute as a
    where a.attrelid = 'public.orders'::regclass
      and a.attname = 'passed'
      and a.attnum > 0
      and not a.attisdropped
      and pg_catalog.format_type(a.atttypid, a.atttypmod) = 'jsonb'
  ) then
    raise exception using errcode = '55000', message = '047 postflight: public.orders.passed (jsonb) is missing';
  end if;

  select pg_catalog.pg_get_constraintdef(c.oid) into v_check
  from pg_catalog.pg_constraint as c
  where c.conrelid = 'public.orders'::regclass
    and c.conname = 'orders_passed_check'
    and c.contype = 'c';
  if v_check is null
     or pg_catalog.strpos(v_check, '''price''') = 0
     or pg_catalog.strpos(v_check, '''competitor''') = 0
     or pg_catalog.strpos(v_check, '''timing''') = 0
     or pg_catalog.strpos(v_check, '''no_reply''') = 0
     or pg_catalog.strpos(v_check, '''event_cancelled''') = 0
     or pg_catalog.strpos(v_check, '''other''') = 0
     or pg_catalog.strpos(v_check, 'prior_stage') = 0
     or pg_catalog.strpos(v_check, '''inquiry''') = 0
     or pg_catalog.strpos(v_check, '''quoted''') = 0 then
    raise exception using errcode = '55000', message = '047 postflight: the orders_passed_check constraint is missing or does not name every reason';
  end if;

  if pg_catalog.to_regclass('public.orders_passed_at_idx') is null then
    raise exception using errcode = '55000', message = '047 postflight: the orders_passed_at_idx index is missing';
  end if;

  foreach v_signature in array array[
    'public.hc_mark_order_passed(uuid, text, text, text)',
    'public.hc_reopen_passed_order(uuid)'
  ] loop
    if pg_catalog.to_regprocedure(v_signature) is null then
      raise exception using errcode = '55000', message = pg_catalog.format('047 postflight: %s is missing', v_signature);
    end if;
    if not exists (
      select 1 from pg_catalog.pg_proc as p
      where p.oid = pg_catalog.to_regprocedure(v_signature)
        and p.prosecdef is true
        and exists (
          select 1 from pg_catalog.unnest(p.proconfig) as setting(value)
          where setting.value like 'search_path=%'
        )
    ) then
      raise exception using errcode = '55000', message = pg_catalog.format('047 postflight: %s is not security definer with search_path set', v_signature);
    end if;
    if pg_catalog.has_function_privilege('anon', v_signature, 'execute')
       or pg_catalog.has_function_privilege('public', v_signature, 'execute')
       or pg_catalog.has_function_privilege('service_role', v_signature, 'execute')
       or not pg_catalog.has_function_privilege('authenticated', v_signature, 'execute') then
      raise exception using errcode = '55000', message = pg_catalog.format('047 postflight: %s grants are wrong (authenticated only)', v_signature);
    end if;
  end loop;
end
$postflight$;

commit;

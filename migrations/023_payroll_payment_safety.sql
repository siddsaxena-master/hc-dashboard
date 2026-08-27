-- ============================================================================
-- 023_payroll_payment_safety.sql
-- Reject placeholder shifts and keep an immutable record of every payment.
--
-- LOCAL DRAFT. Do not run this against production until migrations 015 through
-- 022 have passed the sandbox rehearsal and the owner has approved production.
-- ============================================================================

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $preflight$
begin
  if pg_catalog.to_regclass('public.shifts') is null
     or pg_catalog.to_regclass('public.field_workers') is null
     or (
       pg_catalog.to_regprocedure(
         'public.hc_mark_shifts_paid(jsonb)'
       ) is null
       and pg_catalog.to_regprocedure(
         'public.hc_mark_shifts_paid(jsonb,text)'
       ) is null
     )
     or pg_catalog.to_regprocedure('public.hc_is_owner()') is null
     or pg_catalog.to_regprocedure(
       'public.hc_current_worker_email()'
     ) is null then
    raise exception using
      errcode = '55000',
      message = '023 requires the authenticated payroll objects from migration 015';
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'shifts'
      and column_name = 'paid_at'
  ) or not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'shifts'
      and column_name = 'paid_minutes'
  ) or not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'shifts'
      and column_name = 'paid_cents'
  ) then
    raise exception using
      errcode = '55000',
      message = '023 requires the paid shift snapshot columns from migration 012';
  end if;

  -- The audit would be incomplete if a legacy anonymous client could still
  -- update paid_at directly. Migration 016 removes both direct write grants.
  if pg_catalog.has_table_privilege('anon', 'public.shifts', 'UPDATE')
     or pg_catalog.has_table_privilege(
       'authenticated', 'public.shifts', 'UPDATE'
     )
     or pg_catalog.has_column_privilege(
       'anon', 'public.shifts', 'paid_at', 'UPDATE'
     )
     or pg_catalog.has_column_privilege(
       'anon', 'public.shifts', 'paid_minutes', 'UPDATE'
     )
     or pg_catalog.has_column_privilege(
       'anon', 'public.shifts', 'paid_cents', 'UPDATE'
     )
     or pg_catalog.has_column_privilege(
       'authenticated', 'public.shifts', 'paid_at', 'UPDATE'
     )
     or pg_catalog.has_column_privilege(
       'authenticated', 'public.shifts', 'paid_minutes', 'UPDATE'
     )
     or pg_catalog.has_column_privilege(
       'authenticated', 'public.shifts', 'paid_cents', 'UPDATE'
     ) then
    raise exception using
      errcode = '55000',
      message = '023 requires the authenticated field cutover from migration 016';
  end if;
end
$preflight$;

create table if not exists public.shift_payment_records (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  payment_batch_id uuid not null,
  shift_id uuid not null references public.shifts(id) on delete restrict,
  field_worker_id uuid not null
    references public.field_workers(id) on delete restrict,
  worker_email text not null,
  worker_name text not null,
  payer_auth_user_id uuid not null,
  payer_email text not null,
  paid_at timestamptz not null,
  paid_minutes integer not null,
  hourly_rate_cents integer not null,
  paid_cents integer not null,
  payment_note text,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  constraint shift_payment_records_shift_key unique (shift_id),
  constraint shift_payment_records_paid_minutes_check check (
    paid_minutes between 1 and 1440
  ),
  constraint shift_payment_records_rate_check check (
    hourly_rate_cents >= 0
  ),
  constraint shift_payment_records_paid_cents_check check (
    paid_cents >= 0
  ),
  constraint shift_payment_records_amount_check check (
    paid_cents = pg_catalog.round(
      paid_minutes::numeric * hourly_rate_cents::numeric / 60
    )::integer
  ),
  constraint shift_payment_records_worker_email_check check (
    worker_email = pg_catalog.lower(worker_email)
    and worker_email = pg_catalog.btrim(worker_email)
    and worker_email <> ''
  ),
  constraint shift_payment_records_payer_email_check check (
    payer_email = pg_catalog.lower(payer_email)
    and payer_email = pg_catalog.btrim(payer_email)
    and payer_email <> ''
  ),
  constraint shift_payment_records_note_length_check check (
    payment_note is null or (
      pg_catalog.length(payment_note) <= 500
      and payment_note = pg_catalog.btrim(payment_note)
      and payment_note <> ''
    )
  )
);

comment on table public.shift_payment_records is
  'Append-only owner payment audit. One immutable record per paid shift.';

create index if not exists shift_payment_records_paid_at_idx
  on public.shift_payment_records (paid_at desc, id);
create index if not exists shift_payment_records_worker_paid_at_idx
  on public.shift_payment_records (field_worker_id, paid_at desc, id);

alter table public.shift_payment_records enable row level security;

drop policy if exists shift_payment_records_owner_select
  on public.shift_payment_records;
create policy shift_payment_records_owner_select
on public.shift_payment_records
for select
to authenticated
using (public.hc_is_owner());

revoke all on table public.shift_payment_records
  from public, anon, authenticated;
grant select on table public.shift_payment_records to authenticated;
revoke all on table public.shift_payment_records from service_role;
grant select on table public.shift_payment_records to service_role;

-- Even a trusted service-role client cannot rewrite history accidentally.
-- The database owner can still replace this trigger in a reviewed migration.
create or replace function public.hc_keep_shift_payment_records_immutable()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  raise exception using
    errcode = '42501',
    message = 'shift payment records are immutable';
  return null;
end
$function$;

revoke all on function public.hc_keep_shift_payment_records_immutable()
  from public, anon, authenticated, service_role;

drop trigger if exists shift_payment_records_immutable
  on public.shift_payment_records;
create trigger shift_payment_records_immutable
before update or delete on public.shift_payment_records
for each row execute function public.hc_keep_shift_payment_records_immutable();

-- The old one-argument function cannot coexist with the defaulted second
-- argument in PostgREST because a request containing only p_items would be
-- ambiguous. The app sends p_payment_note explicitly after this migration.
drop function if exists public.hc_mark_shifts_paid(jsonb);

create or replace function public.hc_mark_shifts_paid(
  p_items jsonb,
  p_payment_note text default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_item_count integer;
  v_recorded_count integer;
  v_shift_id uuid;
  v_worker_id uuid;
  v_paid_at timestamptz;
  v_batch_id uuid;
  v_payer_auth_user_id uuid;
  v_payer_email text;
  v_payment_note text := NULLIF(pg_catalog.btrim(p_payment_note), '');
begin
  if not public.hc_is_owner() then
    raise exception using
      errcode = '42501',
      message = 'owner required';
  end if;

  v_payer_auth_user_id := auth.uid();
  v_payer_email := NULLIF(
    pg_catalog.lower(
      pg_catalog.btrim(public.hc_current_worker_email())
    ),
    ''
  );
  if v_payer_auth_user_id is null or v_payer_email is null then
    raise exception using
      errcode = '42501',
      message = 'confirmed owner identity required';
  end if;

  if v_payment_note is not null
     and pg_catalog.length(v_payment_note) > 500 then
    raise exception using
      errcode = '22023',
      message = 'payment note must be 500 characters or fewer';
  end if;

  if p_items is null or pg_catalog.jsonb_typeof(p_items) <> 'array' then
    raise exception using
      errcode = '22023',
      message = 'p_items must be a JSON array';
  end if;

  v_item_count := pg_catalog.jsonb_array_length(p_items);
  if v_item_count < 1 or v_item_count > 200 then
    raise exception using
      errcode = '22023',
      message = 'p_items must contain between 1 and 200 shifts';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_to_recordset(p_items) as item(
      shift_id uuid,
      expected_clock_in_at timestamptz,
      expected_clock_out_at timestamptz,
      expected_rate_cents integer
    )
    where item.shift_id is null
  ) then
    raise exception using
      errcode = '22023',
      message = 'every pay item requires a shift_id';
  end if;

  if (
    select count(*) <> count(distinct item.shift_id)
    from pg_catalog.jsonb_to_recordset(p_items) as item(
      shift_id uuid,
      expected_clock_in_at timestamptz,
      expected_clock_out_at timestamptz,
      expected_rate_cents integer
    )
  ) then
    raise exception using
      errcode = '23505',
      message = 'duplicate shift_id in p_items';
  end if;

  -- Lock every shift and rate row in a stable order. Two owner devices cannot
  -- double-pay or deadlock one another while confirming overlapping batches.
  for v_shift_id in
    select item.shift_id
    from pg_catalog.jsonb_to_recordset(p_items) as item(
      shift_id uuid,
      expected_clock_in_at timestamptz,
      expected_clock_out_at timestamptz,
      expected_rate_cents integer
    )
    order by item.shift_id
  loop
    perform 1
    from public.shifts as s
    where s.id = v_shift_id
    for update;
  end loop;

  for v_worker_id in
    select distinct s.field_worker_id
    from pg_catalog.jsonb_to_recordset(p_items) as item(
      shift_id uuid,
      expected_clock_in_at timestamptz,
      expected_clock_out_at timestamptz,
      expected_rate_cents integer
    )
    join public.shifts as s on s.id = item.shift_id
    where s.field_worker_id is not null
    order by s.field_worker_id
  loop
    perform 1
    from public.field_workers as fw
    where fw.id = v_worker_id
    for update;
  end loop;

  -- A remote-close placeholder has equal timestamps. A sub-minute shift would
  -- also round to zero. Both require a time correction before payment. Shifts
  -- longer than 24 hours are held for review instead of silently overpaying.
  if exists (
    select 1
    from pg_catalog.jsonb_to_recordset(p_items) as item(
      shift_id uuid,
      expected_clock_in_at timestamptz,
      expected_clock_out_at timestamptz,
      expected_rate_cents integer
    )
    join public.shifts as s on s.id = item.shift_id
    where s.clock_out_at is not null
      and (
        s.clock_out_at - s.clock_in_at < interval '1 minute'
        or s.clock_out_at - s.clock_in_at > interval '24 hours'
      )
  ) then
    raise exception using
      errcode = '22023',
      message = 'shift duration must be between 1 minute and 24 hours';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_to_recordset(p_items) as item(
      shift_id uuid,
      expected_clock_in_at timestamptz,
      expected_clock_out_at timestamptz,
      expected_rate_cents integer
    )
    join public.shifts as s on s.id = item.shift_id
    left join public.shift_payment_records as payment
      on payment.shift_id = s.id
    where s.paid_at is not null
       or payment.shift_id is not null
  ) then
    raise exception using
      errcode = '23505',
      message = 'one or more shifts were already paid';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_to_recordset(p_items) as item(
      shift_id uuid,
      expected_clock_in_at timestamptz,
      expected_clock_out_at timestamptz,
      expected_rate_cents integer
    )
    left join public.shifts as s on s.id = item.shift_id
    left join public.field_workers as fw on fw.id = s.field_worker_id
    where s.id is null
       or s.field_worker_id is null
       or fw.id is null
       or s.clock_out_at is null
       or fw.hourly_rate_cents is null
       or fw.hourly_rate_cents < 0
       or not (
         s.clock_in_at is not distinct from item.expected_clock_in_at
       )
       or not (
         s.clock_out_at is not distinct from item.expected_clock_out_at
       )
       or not (
         fw.hourly_rate_cents is not distinct from item.expected_rate_cents
       )
  ) then
    raise exception using
      errcode = '40001',
      message = 'one or more pay items changed or are invalid; no shifts were marked paid';
  end if;

  v_paid_at := pg_catalog.clock_timestamp();
  v_batch_id := pg_catalog.gen_random_uuid();

  with items as (
    select *
    from pg_catalog.jsonb_to_recordset(p_items) as item(
      shift_id uuid,
      expected_clock_in_at timestamptz,
      expected_clock_out_at timestamptz,
      expected_rate_cents integer
    )
  ), updated as (
    update public.shifts as s
    set paid_at = v_paid_at,
        paid_minutes = pg_catalog.floor(
          pg_catalog.date_part('epoch', s.clock_out_at - s.clock_in_at) / 60
        )::integer,
        paid_cents = pg_catalog.round(
          pg_catalog.floor(
            pg_catalog.date_part('epoch', s.clock_out_at - s.clock_in_at) / 60
          )::numeric * fw.hourly_rate_cents::numeric / 60
        )::integer
    from items as item
    join public.field_workers as fw
      on fw.hourly_rate_cents is not distinct from item.expected_rate_cents
    where s.id = item.shift_id
      and fw.id = s.field_worker_id
      and s.paid_at is null
    returning
      s.id,
      s.field_worker_id,
      fw.email as roster_email,
      fw.name as roster_name,
      s.paid_at,
      s.paid_minutes,
      s.paid_cents,
      fw.hourly_rate_cents
  )
  insert into public.shift_payment_records (
    payment_batch_id,
    shift_id,
    field_worker_id,
    worker_email,
    worker_name,
    payer_auth_user_id,
    payer_email,
    paid_at,
    paid_minutes,
    hourly_rate_cents,
    paid_cents,
    payment_note
  )
  select
    v_batch_id,
    updated.id,
    updated.field_worker_id,
    pg_catalog.lower(pg_catalog.btrim(updated.roster_email)),
    updated.roster_name,
    v_payer_auth_user_id,
    v_payer_email,
    updated.paid_at,
    updated.paid_minutes,
    updated.hourly_rate_cents,
    updated.paid_cents,
    v_payment_note
  from updated;

  get diagnostics v_recorded_count = row_count;
  if v_recorded_count <> v_item_count then
    raise exception using
      errcode = '40001',
      message = 'pay batch changed during update; no shifts were marked paid';
  end if;

  return v_recorded_count;
end
$function$;

revoke all on function public.hc_mark_shifts_paid(jsonb, text)
  from public, anon, authenticated;
grant execute on function public.hc_mark_shifts_paid(jsonb, text)
  to authenticated, service_role;

do $postflight$
declare
  v_signature text :=
    'public.hc_mark_shifts_paid(jsonb,text)';
  v_constraint text;
begin
  if not exists (
    select 1
    from pg_catalog.pg_class as table_info
    where table_info.oid =
          'public.shift_payment_records'::regclass
      and table_info.relrowsecurity
  ) then
    raise exception using
      errcode = '42501',
      message = '023 assertion failed: payment audit RLS is disabled';
  end if;

  foreach v_constraint in array array[
    'shift_payment_records_pkey',
    'shift_payment_records_shift_key',
    'shift_payment_records_shift_id_fkey',
    'shift_payment_records_field_worker_id_fkey',
    'shift_payment_records_paid_minutes_check',
    'shift_payment_records_rate_check',
    'shift_payment_records_paid_cents_check',
    'shift_payment_records_amount_check',
    'shift_payment_records_worker_email_check',
    'shift_payment_records_payer_email_check',
    'shift_payment_records_note_length_check'
  ] loop
    if not exists (
      select 1
      from pg_catalog.pg_constraint as constraint_info
      where constraint_info.conrelid =
            'public.shift_payment_records'::pg_catalog.regclass
        and constraint_info.conname = v_constraint
        and constraint_info.convalidated is true
    ) then
      raise exception using
        errcode = '55000',
        message = pg_catalog.format(
          '023 assertion failed: payment audit constraint %s is missing',
          v_constraint
        );
    end if;
  end loop;

  if not exists (
    select 1
    from pg_catalog.pg_trigger as trigger_info
    where trigger_info.tgrelid =
          'public.shift_payment_records'::pg_catalog.regclass
      and trigger_info.tgname = 'shift_payment_records_immutable'
      and trigger_info.tgenabled = 'O'
      and trigger_info.tgisinternal is false
  ) then
    raise exception using
      errcode = '42501',
      message = '023 assertion failed: payment audit immutability trigger is missing';
  end if;

  if (
    select pg_catalog.count(*)
    from pg_catalog.pg_policies as policy_info
    where policy_info.schemaname = 'public'
      and policy_info.tablename = 'shift_payment_records'
  ) <> 1 or not exists (
    select 1
    from pg_catalog.pg_policies as policy_info
    where policy_info.schemaname = 'public'
      and policy_info.tablename = 'shift_payment_records'
      and policy_info.policyname = 'shift_payment_records_owner_select'
      and policy_info.cmd = 'SELECT'
      and policy_info.roles = array['authenticated'::name]
      and policy_info.qual like '%hc_is_owner%'
  ) then
    raise exception using
      errcode = '42501',
      message = '023 assertion failed: payment audit owner policy is wrong';
  end if;

  if pg_catalog.has_table_privilege(
       'anon', 'public.shift_payment_records', 'SELECT'
     )
     or pg_catalog.has_table_privilege(
       'anon', 'public.shift_payment_records', 'INSERT'
     )
     or pg_catalog.has_table_privilege(
       'authenticated', 'public.shift_payment_records', 'INSERT'
     )
     or pg_catalog.has_table_privilege(
       'authenticated', 'public.shift_payment_records', 'UPDATE'
     )
     or pg_catalog.has_table_privilege(
       'authenticated', 'public.shift_payment_records', 'DELETE'
     )
     or not pg_catalog.has_table_privilege(
       'authenticated', 'public.shift_payment_records', 'SELECT'
     )
     or not pg_catalog.has_table_privilege(
       'service_role', 'public.shift_payment_records', 'SELECT'
     )
     or pg_catalog.has_table_privilege(
       'service_role', 'public.shift_payment_records', 'INSERT'
     )
     or pg_catalog.has_table_privilege(
       'service_role', 'public.shift_payment_records', 'UPDATE'
     )
     or pg_catalog.has_table_privilege(
       'service_role', 'public.shift_payment_records', 'DELETE'
     ) then
    raise exception using
      errcode = '42501',
      message = '023 assertion failed: payment audit write or anonymous access leaked';
  end if;

  if pg_catalog.to_regprocedure(v_signature) is null
     or pg_catalog.to_regprocedure(
       'public.hc_mark_shifts_paid(jsonb)'
     ) is not null
     or pg_catalog.has_function_privilege(
       'anon', v_signature, 'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'authenticated', v_signature, 'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'service_role', v_signature, 'EXECUTE'
     ) then
    raise exception using
      errcode = '42501',
      message = '023 assertion failed: payment RPC grants are unsafe';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_proc as function_info
    where function_info.oid = pg_catalog.to_regprocedure(v_signature)
      and function_info.prosecdef is true
      and function_info.prorettype =
          'integer'::pg_catalog.regtype
      and function_info.proargnames = array['p_items', 'p_payment_note']
      and function_info.pronargdefaults = 1
      and exists (
        select 1
        from pg_catalog.unnest(function_info.proconfig) as setting(value)
        where setting.value ~ '^search_path=(|"")$'
      )
  ) then
    raise exception using
      errcode = '42501',
      message = '023 assertion failed: payment RPC is not a locked SECURITY DEFINER';
  end if;

  if pg_catalog.has_function_privilege(
       'anon',
       'public.hc_keep_shift_payment_records_immutable()',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.hc_keep_shift_payment_records_immutable()',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'service_role',
       'public.hc_keep_shift_payment_records_immutable()',
       'EXECUTE'
     ) then
    raise exception using
      errcode = '42501',
      message = '023 assertion failed: payment audit trigger function is callable';
  end if;
end
$postflight$;

commit;

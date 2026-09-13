-- DISPOSABLE LOCAL DATABASE ONLY. No real identities, orders, or credentials.
do $guard$
begin
  if current_database() <> 'hc_calendar_logo_rehearsal' then
    raise exception 'This fixture requires the named disposable local database';
  end if;
end
$guard$;

create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create schema storage;
grant usage on schema public, auth, storage to anon, authenticated;

create function auth.uid() returns uuid language sql stable as $function$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$function$;

create table public.field_workers (
  id uuid primary key,
  auth_user_id uuid unique,
  role text,
  market text,
  active boolean not null
);
create table public.orders (
  id uuid primary key,
  client_name text,
  client_email text,
  venue text,
  delivery_notes text,
  event_start_at timestamptz,
  coconuts_qty integer,
  crack_type text,
  delivery_at_utc timestamptz,
  stage text,
  market text,
  stamp_status text,
  logo_received boolean,
  is_recurring boolean,
  delivery_signed_at timestamptz,
  total_cents bigint,
  external_invoice_id text
);
alter table public.orders enable row level security;

create table storage.buckets (id text primary key, name text not null, public boolean not null default false);
create table storage.objects (id bigserial primary key, bucket_id text references storage.buckets(id), name text not null);
alter table storage.objects enable row level security;
grant select on storage.objects to anon, authenticated;
-- Deliberately unsafe old read rule: 035 must still protect the new bucket.
create policy rehearsal_existing_broad_read on storage.objects for select to public using (true);
insert into storage.buckets values ('existing-private', 'existing-private', false);
insert into storage.objects(bucket_id, name) values ('existing-private', 'unchanged.txt');

create function public.rehearsal_assert(p_pass boolean, p_message text)
returns void language plpgsql set search_path = '' as $function$
begin
  if p_pass is not true then raise exception 'FAIL: %', p_message; end if;
  raise notice 'PASS: %', p_message;
end
$function$;

insert into public.field_workers values
('10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','owner',null,true),
('10000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000002','manager','ny',true),
('10000000-0000-4000-8000-000000000003','20000000-0000-4000-8000-000000000003',' TEAM ',' NY ',true),
('10000000-0000-4000-8000-000000000004','20000000-0000-4000-8000-000000000004','owner',null,false),
('10000000-0000-4000-8000-000000000005','20000000-0000-4000-8000-000000000005','guest','ny',true),
('10000000-0000-4000-8000-000000000006','20000000-0000-4000-8000-000000000006','manager',' ',true),
('10000000-0000-4000-8000-000000000007','20000000-0000-4000-8000-000000000007','team','miami',true);
insert into public.orders(id,client_name,client_email,delivery_at_utc,stage,market,total_cents,external_invoice_id) values
('30000000-0000-4000-8000-000000000001','Fake NY order','private@example.invalid','2026-09-10T12:00:00Z','paid_full',' NY ',90000,'fake-invoice-1'),
('30000000-0000-4000-8000-000000000002','Fake Miami order',null,'2026-09-11T12:00:00Z','invoiced','miami',45000,'fake-invoice-2'),
('30000000-0000-4000-8000-000000000003','Fake unassigned order',null,'2026-09-12T12:00:00Z','paid_full',null,18000,'fake-invoice-3'),
('30000000-0000-4000-8000-000000000004','Fake undated order',null,null,'quoted','ny',null,null),
('30000000-0000-4000-8000-000000000005','Fake malformed optional files',null,null,'inquiry','ny',null,null);

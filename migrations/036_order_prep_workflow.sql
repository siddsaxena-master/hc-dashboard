-- LOCAL PREPARATION ONLY. Samples and packing checks do not approve artwork,
-- contact customers, hold production, or alter invoices, inventory, or payroll.
begin;
set local lock_timeout = '10s';
set local statement_timeout = '120s';

do $preflight$
begin
  if pg_catalog.to_regclass('public.orders') is null
     or pg_catalog.to_regclass('public.field_workers') is null
     or pg_catalog.to_regclass('storage.objects') is null
     or not exists (select 1 from pg_catalog.pg_attribute
       where attrelid = 'public.orders'::regclass and attname = 'logo_asset' and not attisdropped)
     or not exists (select 1 from pg_catalog.pg_class
       where oid = 'storage.objects'::regclass and relrowsecurity) then
    raise exception '036 requires 035, authenticated field workers, and Storage row security';
  end if;
  if exists (select 1 from storage.buckets where id = 'order-prep-media'
    and (public is distinct from false or name <> 'order-prep-media'
      or file_size_limit is distinct from 8388608::bigint
      or allowed_mime_types is distinct from array['image/jpeg']::text[])) then
    raise exception '036 refuses an existing prep-media bucket with different restrictions';
  end if;
end
$preflight$;

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('order-prep-media', 'order-prep-media', false, 8388608, array['image/jpeg'])
on conflict (id) do nothing;
do $bucket_assertion$
declare v_bucket storage.buckets%rowtype;
begin
  select * into v_bucket from storage.buckets where id = 'order-prep-media' for update;
  if v_bucket.public is distinct from false or v_bucket.name is distinct from 'order-prep-media'
    or v_bucket.file_size_limit is distinct from 8388608::bigint
    or v_bucket.allowed_mime_types is distinct from array['image/jpeg']::text[] then
    raise exception '036 requires the expected private JPEG-only prep bucket';
  end if;
end
$bucket_assertion$;

create table if not exists public.order_prep_state (
  order_id uuid primary key references public.orders(id),
  version integer not null default 0 check (version >= 0),
  stamp_checked boolean not null default false,
  stamp_artwork_snapshot jsonb,
  cracking_method text check (cracking_method in ('circle','cocktail','straw_hole','whole')),
  staffing boolean,
  onsite_cracking_method text check (onsite_cracking_method in ('circle','cocktail','straw_hole')),
  cracking_checked boolean not null default false,
  straws_packed boolean not null default false,
  circle_tools_packed boolean not null default false,
  cocktail_tools_packed boolean not null default false,
  straw_hole_tools_packed boolean not null default false,
  updated_at timestamptz,
  updated_by uuid
);

create table if not exists public.order_prep_photos (
  id uuid primary key,
  order_id uuid not null references public.orders(id),
  path text not null unique,
  reserved_by uuid not null,
  reserved_at timestamptz not null default pg_catalog.clock_timestamp(),
  captured_at timestamptz not null,
  logo_snapshot jsonb,
  finished_at timestamptz
);
create index if not exists order_prep_photos_order_finished
  on public.order_prep_photos(order_id, finished_at desc);

create table if not exists public.order_prep_audit (
  id bigint generated always as identity primary key,
  order_id uuid not null references public.orders(id),
  actor_id uuid not null,
  recorded_at timestamptz not null default pg_catalog.clock_timestamp(),
  action text not null check (action in ('checklist','sample_reserved','sample_finished')),
  details jsonb not null
);
alter table public.order_prep_state enable row level security;
alter table public.order_prep_photos enable row level security;
alter table public.order_prep_audit enable row level security;
-- Only the narrowly checked functions below can expose or change these rows.
revoke all on public.order_prep_state, public.order_prep_photos, public.order_prep_audit
  from public, anon, authenticated;
revoke all on sequence public.order_prep_audit_id_seq from public, anon, authenticated;

create or replace function public.hc_can_access_order_prep(p_order_id uuid)
returns boolean language sql stable security definer set search_path = '' as $function$
  select auth.uid() is not null and exists (
    select 1 from public.orders o join public.field_workers w
      on w.auth_user_id = auth.uid() and w.active is true
    where o.id = p_order_id and (
      lower(trim(w.role)) = 'owner'
      or (lower(trim(w.role)) in ('manager','team')
        and nullif(lower(trim(w.market)), '') is not null
        and nullif(lower(trim(o.market)), '') is not null
        and lower(trim(w.market)) = lower(trim(o.market))))
  );
$function$;

-- Exact identity of the artwork shown to staff. Private email references are
-- excluded. Strings are not trimmed or coerced, and file ordering is retained.
create or replace function public.hc_order_prep_artwork_identity(p_asset jsonb)
returns jsonb language sql immutable set search_path = '' as $function$
  select pg_catalog.jsonb_build_object(
    'status', case when pg_catalog.jsonb_typeof(p_asset -> 'status') = 'string' then p_asset -> 'status' else 'null'::jsonb end,
    'checked_at', case when pg_catalog.jsonb_typeof(p_asset -> 'checked_at') = 'string' then p_asset -> 'checked_at' else 'null'::jsonb end,
    'files', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'file_name', case when pg_catalog.jsonb_typeof(f.value -> 'file_name') = 'string' then f.value -> 'file_name' else 'null'::jsonb end,
      'mime_type', case when pg_catalog.jsonb_typeof(f.value -> 'mime_type') = 'string' then f.value -> 'mime_type' else 'null'::jsonb end,
      'original_path', case when pg_catalog.jsonb_typeof(f.value -> 'original_path') = 'string' then f.value -> 'original_path' else 'null'::jsonb end,
      'preview_path', case when pg_catalog.jsonb_typeof(f.value -> 'preview_path') = 'string' then f.value -> 'preview_path' else 'null'::jsonb end,
      'usage', case when pg_catalog.jsonb_typeof(f.value -> 'usage') = 'string' then f.value -> 'usage' else 'null'::jsonb end
    ) order by f.position)
    from pg_catalog.jsonb_array_elements(case when pg_catalog.jsonb_typeof(p_asset -> 'files') = 'array'
      then p_asset -> 'files' else '[]'::jsonb end) with ordinality as f(value,position)
    where pg_catalog.jsonb_typeof(f.value) = 'object'), '[]'::jsonb));
$function$;

create or replace function public.hc_get_order_prep_state(p_order_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $function$
declare
  v_state public.order_prep_state%rowtype;
  v_sample jsonb;
  v_logo jsonb;
begin
  if not public.hc_can_access_order_prep(p_order_id) then
    raise exception using errcode = '42501', message = 'Order preparation access denied';
  end if;
  select * into v_state from public.order_prep_state where order_id = p_order_id;
  select public.hc_order_prep_artwork_identity(logo_asset) into v_logo from public.orders where id = p_order_id;
  select pg_catalog.jsonb_build_object(
    'id', p.id, 'path', p.path, 'captured_at', p.captured_at,
    'logo_checked_at', p.logo_snapshot -> 'checked_at',
    'artwork_current', coalesce(p.logo_snapshot is not null
      and pg_catalog.jsonb_typeof(p.logo_snapshot -> 'checked_at') = 'string'
      and nullif(p.logo_snapshot ->> 'checked_at', '') is not null
      and case when pg_catalog.jsonb_typeof(p.logo_snapshot -> 'files') = 'array'
        then pg_catalog.jsonb_array_length(p.logo_snapshot -> 'files') > 0 else false end
      and p.logo_snapshot is not distinct from public.hc_order_prep_artwork_identity(o.logo_asset), false))
    into v_sample
    from public.order_prep_photos p join public.orders o on o.id = p.order_id
    where p.order_id = p_order_id and p.finished_at is not null
    order by p.finished_at desc, p.id desc limit 1;
  return pg_catalog.jsonb_build_object(
    'version', coalesce(v_state.version, 0),
    'stamp_checked', coalesce(v_state.stamp_checked, false)
      and v_state.stamp_artwork_snapshot is not null
      and v_state.stamp_artwork_snapshot is not distinct from v_logo,
    'cracking_method', v_state.cracking_method, 'staffing', v_state.staffing,
    'onsite_cracking_method', v_state.onsite_cracking_method,
    'checks', pg_catalog.jsonb_build_object(
      'cracking_checked', coalesce(v_state.cracking_checked, false),
      'straws_packed', coalesce(v_state.straws_packed, false),
      'circle_tools_packed', coalesce(v_state.circle_tools_packed, false),
      'cocktail_tools_packed', coalesce(v_state.cocktail_tools_packed, false),
      'straw_hole_tools_packed', coalesce(v_state.straw_hole_tools_packed, false)),
    'latest_sample', v_sample, 'updated_at', v_state.updated_at);
end
$function$;

create or replace function public.hc_save_order_prep_state(
  p_order_id uuid, p_expected_version integer, p_patch jsonb, p_expected_artwork jsonb default null)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  v_before public.order_prep_state%rowtype;
  v_after public.order_prep_state%rowtype;
  v_key text;
  v_value jsonb;
  v_checks jsonb;
  v_logo jsonb;
begin
  if not public.hc_can_access_order_prep(p_order_id) then
    raise exception using errcode = '42501', message = 'Order preparation access denied';
  end if;
  if (p_patch ? 'cracking_method' or p_patch ? 'staffing' or p_patch ? 'onsite_cracking_method') and not exists (
    select 1 from public.field_workers where auth_user_id = auth.uid()
      and active is true and lower(trim(role)) in ('owner','manager')
  ) then
    raise exception using errcode = '42501', message = 'Only an owner or manager can set preparation requirements';
  end if;
  if p_expected_version is null or p_expected_version < 0
     or p_patch is null or pg_catalog.jsonb_typeof(p_patch) <> 'object'
     or p_patch = '{}'::jsonb then
    raise exception using errcode = '22023', message = 'A version and nonempty checklist patch are required';
  end if;
  for v_key, v_value in select * from pg_catalog.jsonb_each(p_patch) loop
    if v_key not in ('stamp_checked','cracking_method','staffing','onsite_cracking_method','checks') then
      raise exception using errcode = '22023', message = 'Unknown checklist field';
    end if;
    if v_key = 'stamp_checked' and pg_catalog.jsonb_typeof(v_value) <> 'boolean'
       or v_key = 'staffing' and pg_catalog.jsonb_typeof(v_value) not in ('boolean','null')
       or v_key = 'cracking_method' and (pg_catalog.jsonb_typeof(v_value) not in ('string','null')
         or (pg_catalog.jsonb_typeof(v_value) = 'string'
           and p_patch ->> v_key not in ('circle','cocktail','straw_hole','whole')))
       or v_key = 'onsite_cracking_method' and (pg_catalog.jsonb_typeof(v_value) not in ('string','null')
         or (pg_catalog.jsonb_typeof(v_value) = 'string'
           and p_patch ->> v_key not in ('circle','cocktail','straw_hole')))
       or v_key = 'checks' and pg_catalog.jsonb_typeof(v_value) <> 'object' then
      raise exception using errcode = '22023', message = 'Invalid checklist field value';
    end if;
  end loop;
  v_checks := coalesce(p_patch -> 'checks', '{}'::jsonb);
  for v_key, v_value in select * from pg_catalog.jsonb_each(v_checks) loop
    if v_key not in ('cracking_checked','straws_packed','circle_tools_packed',
      'cocktail_tools_packed','straw_hole_tools_packed')
      or pg_catalog.jsonb_typeof(v_value) <> 'boolean' then
      raise exception using errcode = '22023', message = 'Invalid packing check';
    end if;
  end loop;
  select public.hc_order_prep_artwork_identity(logo_asset) into v_logo from public.orders where id = p_order_id for share;
  if p_patch -> 'stamp_checked' = 'true'::jsonb
    and (p_expected_artwork is null or p_expected_artwork is distinct from v_logo) then
    raise exception using errcode = '40001', message = 'Customer artwork changed or was not confirmed; reload it before checking the stamp';
  end if;
  insert into public.order_prep_state(order_id) values (p_order_id) on conflict do nothing;
  select * into v_before from public.order_prep_state where order_id = p_order_id for update;
  if v_before.version <> p_expected_version then
    raise exception using errcode = '40001', message = 'Checklist changed on another device; reload before saving';
  end if;
  v_after := v_before;
  if p_patch ? 'stamp_checked' then
    v_after.stamp_checked := (p_patch ->> 'stamp_checked')::boolean;
    if v_after.stamp_checked and (v_logo is null or case
      when pg_catalog.jsonb_typeof(v_logo -> 'files') = 'array'
        then pg_catalog.jsonb_array_length(v_logo -> 'files') = 0 else true end) then
      raise exception using errcode = '22023', message = 'Select customer artwork before checking the stamp against it';
    end if;
    v_after.stamp_artwork_snapshot := case when v_after.stamp_checked then v_logo else null end;
  end if;
  if p_patch ? 'cracking_method' then v_after.cracking_method := p_patch ->> 'cracking_method'; end if;
  if p_patch ? 'staffing' then v_after.staffing := (p_patch ->> 'staffing')::boolean; end if;
  if p_patch ? 'onsite_cracking_method' then v_after.onsite_cracking_method := p_patch ->> 'onsite_cracking_method'; end if;
  -- Old checks must not certify changed instructions. The user can reconfirm
  -- after saving and seeing the new method or staffing requirement.
  if v_after.cracking_method is distinct from v_before.cracking_method then
    v_after.cracking_checked := false;
  end if;
  if v_after.staffing is distinct from v_before.staffing
    or v_after.onsite_cracking_method is distinct from v_before.onsite_cracking_method then
    v_after.circle_tools_packed := false;
    v_after.cocktail_tools_packed := false;
    v_after.straw_hole_tools_packed := false;
  end if;
  if v_checks ? 'cracking_checked' and v_after.cracking_method is not distinct from v_before.cracking_method then
    v_after.cracking_checked := (v_checks ->> 'cracking_checked')::boolean;
  end if;
  if v_checks ? 'straws_packed' then v_after.straws_packed := (v_checks ->> 'straws_packed')::boolean; end if;
  if v_after.staffing is not distinct from v_before.staffing
    and v_after.onsite_cracking_method is not distinct from v_before.onsite_cracking_method then
    if v_checks ? 'circle_tools_packed' then v_after.circle_tools_packed := (v_checks ->> 'circle_tools_packed')::boolean; end if;
    if v_checks ? 'cocktail_tools_packed' then v_after.cocktail_tools_packed := (v_checks ->> 'cocktail_tools_packed')::boolean; end if;
    if v_checks ? 'straw_hole_tools_packed' then v_after.straw_hole_tools_packed := (v_checks ->> 'straw_hole_tools_packed')::boolean; end if;
  end if;
  if v_after.cracking_checked and v_after.cracking_method is null then
    raise exception using errcode = '22023', message = 'Confirm the cracking instructions before checking the work';
  end if;
  if (v_after.circle_tools_packed or v_after.cocktail_tools_packed or v_after.straw_hole_tools_packed)
    and v_after.staffing is distinct from true then
    raise exception using errcode = '22023', message = 'Confirm staffing before checking event tools';
  end if;
  if v_after.circle_tools_packed and v_after.onsite_cracking_method is distinct from 'circle'
    or v_after.cocktail_tools_packed and v_after.onsite_cracking_method is distinct from 'cocktail'
    or v_after.straw_hole_tools_packed and v_after.onsite_cracking_method is distinct from 'straw_hole' then
    raise exception using errcode = '22023', message = 'Packed tools must match the confirmed on-site cracking instructions';
  end if;
  update public.order_prep_state set version = version + 1,
    stamp_checked = v_after.stamp_checked, cracking_method = v_after.cracking_method,
    stamp_artwork_snapshot = v_after.stamp_artwork_snapshot,
    onsite_cracking_method = v_after.onsite_cracking_method,
    staffing = v_after.staffing, cracking_checked = v_after.cracking_checked,
    straws_packed = v_after.straws_packed, circle_tools_packed = v_after.circle_tools_packed,
    cocktail_tools_packed = v_after.cocktail_tools_packed,
    straw_hole_tools_packed = v_after.straw_hole_tools_packed,
    updated_at = pg_catalog.clock_timestamp(), updated_by = auth.uid()
    where order_id = p_order_id returning * into v_after;
  insert into public.order_prep_audit(order_id,actor_id,action,details)
    values (p_order_id, auth.uid(), 'checklist', pg_catalog.jsonb_build_object(
      'before', pg_catalog.to_jsonb(v_before), 'after', pg_catalog.to_jsonb(v_after)));
  return public.hc_get_order_prep_state(p_order_id);
end
$function$;

create or replace function public.hc_reserve_order_prep_photo(
  p_order_id uuid, p_photo_id uuid, p_captured_at timestamptz, p_expected_artwork jsonb default null)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  v_photo public.order_prep_photos%rowtype;
  v_logo jsonb;
begin
  if not public.hc_can_access_order_prep(p_order_id) then
    raise exception using errcode = '42501', message = 'Order preparation access denied';
  end if;
  if p_photo_id is null or p_captured_at is null or not pg_catalog.isfinite(p_captured_at)
     or p_captured_at > pg_catalog.clock_timestamp() + interval '5 minutes' then
    raise exception using errcode = '22023', message = 'A photo identity and valid capture time are required';
  end if;
  select public.hc_order_prep_artwork_identity(logo_asset) into v_logo from public.orders where id = p_order_id for share;
  if p_expected_artwork is null or p_expected_artwork is distinct from v_logo then
    raise exception using errcode = '40001', message = 'Customer artwork changed or was not confirmed; reload it before taking the sample';
  end if;
  if not exists (select 1 from public.order_prep_state where order_id = p_order_id
    and stamp_checked is true and stamp_artwork_snapshot is not null
    and stamp_artwork_snapshot is not distinct from v_logo) then
    raise exception using errcode = '22023', message = 'Check that the correct stamp is physically present for the current artwork first';
  end if;
  insert into public.order_prep_photos(id,order_id,path,reserved_by,captured_at,logo_snapshot)
    values (p_photo_id, p_order_id,
      p_order_id::text || '/' || auth.uid()::text || '/' || p_photo_id::text || '.jpg',
      auth.uid(), p_captured_at, v_logo)
    on conflict (id) do nothing returning * into v_photo;
  if not found then
    select * into v_photo from public.order_prep_photos where id = p_photo_id;
    if v_photo.order_id <> p_order_id or v_photo.reserved_by <> auth.uid()
       or v_photo.captured_at is distinct from p_captured_at then
      raise exception using errcode = '42501', message = 'Photo identity already reserved';
    end if;
  else
    insert into public.order_prep_audit(order_id,actor_id,action,details)
      values (p_order_id, auth.uid(), 'sample_reserved', pg_catalog.jsonb_build_object('photo_id',p_photo_id));
  end if;
  return pg_catalog.jsonb_build_object('id',v_photo.id,'path',v_photo.path);
end
$function$;

create or replace function public.hc_can_access_order_prep_photo(p_name text, p_upload boolean)
returns boolean language sql stable security definer set search_path = '' as $function$
  select auth.uid() is not null and exists (
    select 1 from public.order_prep_photos p
    where p.path = p_name and public.hc_can_access_order_prep(p.order_id)
      and case when p_upload then p.reserved_by = auth.uid() and p.finished_at is null
        else p.finished_at is not null or p.reserved_by = auth.uid() end
  );
$function$;

create or replace function public.hc_finish_order_prep_photo(p_order_id uuid, p_photo_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  v_photo public.order_prep_photos%rowtype;
  v_logo jsonb;
  v_metadata jsonb;
begin
  if not public.hc_can_access_order_prep(p_order_id) then
    raise exception using errcode = '42501', message = 'Order preparation access denied';
  end if;
  select public.hc_order_prep_artwork_identity(logo_asset) into v_logo from public.orders where id = p_order_id for share;
  select * into v_photo from public.order_prep_photos where id = p_photo_id for update;
  if not found or v_photo.order_id <> p_order_id or v_photo.reserved_by <> auth.uid() then
    raise exception using errcode = '42501', message = 'Photo reservation belongs to another user or order';
  end if;
  if v_photo.finished_at is not null then
    return public.hc_get_order_prep_state(p_order_id) || pg_catalog.jsonb_build_object(
      'confirmed_photo_id',v_photo.id,'confirmed_photo_path',v_photo.path);
  end if;
  if v_photo.logo_snapshot is distinct from v_logo then
    raise exception using errcode = '40001', message = 'Customer artwork changed; reload and take a new sample photo';
  end if;
  select metadata into v_metadata from storage.objects
    where bucket_id = 'order-prep-media' and name = v_photo.path;
  if not found then
    raise exception using errcode = '22023', message = 'Sample photo upload has not finished';
  end if;
  if v_metadata ->> 'mimetype' is distinct from 'image/jpeg'
    or coalesce(v_metadata ->> 'size','') !~ '^[0-9]{1,8}$' then
    raise exception using errcode = '22023', message = 'Sample must be a JPEG photo no larger than 8 MB';
  end if;
  if (v_metadata ->> 'size')::bigint not between 1 and 8388608 then
    raise exception using errcode = '22023', message = 'Sample must be a JPEG photo no larger than 8 MB';
  end if;
  insert into public.order_prep_state(order_id) values (p_order_id) on conflict do nothing;
  update public.order_prep_state set version = version + 1,
    updated_at = pg_catalog.clock_timestamp(), updated_by = auth.uid() where order_id = p_order_id;
  update public.order_prep_photos set finished_at = pg_catalog.clock_timestamp() where id = p_photo_id;
  insert into public.order_prep_audit(order_id,actor_id,action,details)
    values (p_order_id,auth.uid(),'sample_finished',pg_catalog.jsonb_build_object('photo_id',p_photo_id));
  return public.hc_get_order_prep_state(p_order_id) || pg_catalog.jsonb_build_object(
    'confirmed_photo_id',v_photo.id,'confirmed_photo_path',v_photo.path);
end
$function$;

revoke all on function public.hc_can_access_order_prep(uuid),
  public.hc_order_prep_artwork_identity(jsonb),
  public.hc_get_order_prep_state(uuid), public.hc_save_order_prep_state(uuid,integer,jsonb,jsonb),
  public.hc_reserve_order_prep_photo(uuid,uuid,timestamptz,jsonb),
  public.hc_can_access_order_prep_photo(text,boolean), public.hc_finish_order_prep_photo(uuid,uuid)
  from public, anon, authenticated;
grant execute on function public.hc_get_order_prep_state(uuid),
  public.hc_save_order_prep_state(uuid,integer,jsonb,jsonb),
  public.hc_reserve_order_prep_photo(uuid,uuid,timestamptz,jsonb),
  public.hc_can_access_order_prep_photo(text,boolean), public.hc_finish_order_prep_photo(uuid,uuid)
  to authenticated;

-- Restrictive rules also defeat legacy policies granting broad Storage access.
-- Other buckets retain their existing permissions.
drop policy if exists hc_order_prep_read on storage.objects;
create policy hc_order_prep_read on storage.objects for select to authenticated
  using (bucket_id = 'order-prep-media' and public.hc_can_access_order_prep_photo(name,false));
drop policy if exists hc_order_prep_read_guard on storage.objects;
create policy hc_order_prep_read_guard on storage.objects as restrictive for select to authenticated
  using (case when bucket_id = 'order-prep-media' then public.hc_can_access_order_prep_photo(name,false) else true end);
drop policy if exists hc_order_prep_insert on storage.objects;
create policy hc_order_prep_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'order-prep-media' and public.hc_can_access_order_prep_photo(name,true));
drop policy if exists hc_order_prep_insert_guard on storage.objects;
create policy hc_order_prep_insert_guard on storage.objects as restrictive for insert to authenticated
  with check (case when bucket_id = 'order-prep-media' then public.hc_can_access_order_prep_photo(name,true) else true end);
drop policy if exists hc_order_prep_update_guard on storage.objects;
create policy hc_order_prep_update_guard on storage.objects as restrictive for update to authenticated
  using (bucket_id <> 'order-prep-media') with check (bucket_id <> 'order-prep-media');
drop policy if exists hc_order_prep_delete_guard on storage.objects;
create policy hc_order_prep_delete_guard on storage.objects as restrictive for delete to authenticated
  using (bucket_id <> 'order-prep-media');
drop policy if exists hc_order_prep_anon_guard on storage.objects;
create policy hc_order_prep_anon_guard on storage.objects as restrictive for all to anon
  using (bucket_id <> 'order-prep-media') with check (bucket_id <> 'order-prep-media');

comment on table public.order_prep_state is 'Operational observations only. Prep cracking and on-site cracking are separate; unknown requirements stay null. Stamp check is tied to a server-only current artwork snapshot. Does not replace invoice facts or authorize customer approval.';
comment on table public.order_prep_photos is 'Private sample photos. Server-created paths and immutable artwork snapshots. Pending uploads are not completed samples. Capture time is device-reported, reservation and finish times are server-reported.';
comment on table public.order_prep_audit is 'Append-only through checked functions. No direct field-app reads or writes. Sample retakes preserve history.';
commit;

-- LOCAL PREPARATION ONLY. Physical box evidence, not billing, payroll, delivery,
-- inventory, or production-time allocation. Existing sample photos never count.
begin;
set local lock_timeout = '10s';
set local statement_timeout = '120s';

do $preflight$
begin
  if pg_catalog.to_regprocedure('public.hc_get_order_prep_state(uuid)') is null
    or pg_catalog.to_regprocedure('public.hc_order_prep_artwork_identity(jsonb)') is null
    or not exists (select 1 from pg_catalog.pg_class where oid = 'storage.objects'::regclass and relrowsecurity) then
    raise exception '037 requires 036 and existing Storage row security';
  end if;
  if exists (select 1 from storage.buckets where id = 'order-box-media'
    and (public is distinct from false or name is distinct from 'order-box-media'
      or file_size_limit is distinct from 8388608::bigint
      or allowed_mime_types is distinct from array['image/jpeg']::text[])) then
    raise exception '037 refuses an existing box-media bucket with different restrictions';
  end if;
end
$preflight$;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('order-box-media','order-box-media',false,8388608,array['image/jpeg']) on conflict(id) do nothing;
do $bucket$
declare v_bucket storage.buckets%rowtype;
begin
  select * into v_bucket from storage.buckets where id = 'order-box-media' for update;
  if v_bucket.public is distinct from false or v_bucket.name is distinct from 'order-box-media'
    or v_bucket.file_size_limit is distinct from 8388608::bigint
    or v_bucket.allowed_mime_types is distinct from array['image/jpeg']::text[] then
    raise exception '037 requires the expected private JPEG-only box bucket';
  end if;
end
$bucket$;

create table if not exists public.order_production_plans (
  order_id uuid primary key references public.orders(id),
  version integer not null default 0 check(version >= 0),
  target_coconuts integer check(target_coconuts > 0),
  source text check(source = 'owner_confirmed'),
  updated_at timestamptz,
  updated_by uuid
);
create table if not exists public.order_production_boxes (
  id uuid primary key,
  order_id uuid not null references public.orders(id),
  box_number integer not null check(box_number > 0),
  coconuts_qty integer not null check(coconuts_qty > 0),
  created_by uuid not null,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  latest_photo_id uuid,
  loaded boolean not null default false,
  loaded_at timestamptz,
  loaded_by uuid,
  voided boolean not null default false,
  voided_at timestamptz,
  voided_by uuid,
  void_reason text,
  check(not voided or not loaded),
  unique(order_id,box_number)
);
create index if not exists order_production_boxes_order on public.order_production_boxes(order_id);
create table if not exists public.order_box_photos (
  id uuid primary key,
  box_id uuid not null references public.order_production_boxes(id),
  order_id uuid not null references public.orders(id),
  revision integer not null check(revision > 0),
  path text not null unique,
  reserved_by uuid not null,
  photographer_name text not null,
  reserved_at timestamptz not null default pg_catalog.clock_timestamp(),
  captured_at timestamptz not null,
  artwork_snapshot jsonb not null,
  plan_version integer not null,
  finished_at timestamptz,
  unique(box_id,revision)
);
create index if not exists order_box_photos_order on public.order_box_photos(order_id);
create table if not exists public.order_box_audit (
  id bigint generated always as identity primary key,
  order_id uuid not null references public.orders(id),
  actor_id uuid not null,
  recorded_at timestamptz not null default pg_catalog.clock_timestamp(),
  action text not null check(action in ('target_confirmed','box_photo_reserved','box_photo_finished','box_loaded','order_loaded','box_voided')),
  details jsonb not null
);
alter table public.order_production_plans enable row level security;
alter table public.order_production_boxes enable row level security;
alter table public.order_box_photos enable row level security;
alter table public.order_box_audit enable row level security;
revoke all on public.order_production_plans,public.order_production_boxes,public.order_box_photos,public.order_box_audit from public,anon,authenticated;
revoke all on sequence public.order_box_audit_id_seq from public,anon,authenticated;

-- Private internal helper. A missing/deleted file cannot certify a box.
create or replace function public.hc_order_box_photo_valid(p_photo_id uuid,p_artwork jsonb)
returns boolean language sql stable security definer set search_path = '' as $function$
  select exists(select 1 from public.order_box_photos p
    where p.id = p_photo_id and p.finished_at is not null and p.artwork_snapshot = p_artwork
      and exists(select 1 from storage.objects o where o.bucket_id = 'order-box-media' and o.name = p.path));
$function$;

create or replace function public.hc_get_order_box_progress(p_order_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $function$
declare
  v_plan public.order_production_plans%rowtype;
  v_logo jsonb;
  v_prep jsonb;
  v_boxes jsonb;
  v_reasons text[] := array[]::text[];
  v_reserved bigint;
  v_completed bigint;
  v_loaded bigint;
  v_completed_boxes bigint;
  v_pending bigint;
  v_review bigint;
  v_invoice jsonb;
  v_invoice_id text;
  v_invoice_checked timestamptz;
  v_invoice_valid boolean := false;
begin
  if not public.hc_can_access_order_prep(p_order_id) then raise exception using errcode='42501',message='Order production access denied'; end if;
  select * into v_plan from public.order_production_plans where order_id = p_order_id;
  select public.hc_order_prep_artwork_identity(logo_asset) into v_logo from public.orders where id = p_order_id;
  select invoice_fulfillment,external_invoice_id::text into v_invoice,v_invoice_id from public.orders where id=p_order_id;
  v_prep := public.hc_get_order_prep_state(p_order_id);
  select coalesce(sum(b.coconuts_qty),0),
    coalesce(sum(b.coconuts_qty) filter(where public.hc_order_box_photo_valid(b.latest_photo_id,v_logo)),0),
    coalesce(sum(b.coconuts_qty) filter(where b.loaded and public.hc_order_box_photo_valid(b.latest_photo_id,v_logo)),0),
    count(*) filter(where public.hc_order_box_photo_valid(b.latest_photo_id,v_logo)),
    count(*) filter(where b.latest_photo_id is null),
    count(*) filter(where b.latest_photo_id is not null and not public.hc_order_box_photo_valid(b.latest_photo_id,v_logo))
    into v_reserved,v_completed,v_loaded,v_completed_boxes,v_pending,v_review
    from public.order_production_boxes b where b.order_id = p_order_id and b.voided is false;
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'id',b.id,'box_number',b.box_number,'coconuts_qty',b.coconuts_qty,
    'created_by',b.created_by,'created_at',b.created_at,
    'voided',b.voided,'voided_at',b.voided_at,'voided_by',b.voided_by,'void_reason',b.void_reason,
    'loaded',b.loaded and public.hc_order_box_photo_valid(b.latest_photo_id,v_logo),
    'loaded_at',case when b.loaded and public.hc_order_box_photo_valid(b.latest_photo_id,v_logo) then b.loaded_at else null end,
    'loaded_by',case when b.loaded and public.hc_order_box_photo_valid(b.latest_photo_id,v_logo) then b.loaded_by else null end,
    'latest_photo',case when p.id is null then null else pg_catalog.jsonb_build_object(
      'id',p.id,'path',p.path,'revision',p.revision,'captured_at',p.captured_at,'finished_at',p.finished_at,
      'photographer_id',p.reserved_by,'photographer_name',p.photographer_name,
      'artwork_current',public.hc_order_box_photo_valid(p.id,v_logo)) end
  ) order by b.box_number),'[]'::jsonb) into v_boxes
    from public.order_production_boxes b left join public.order_box_photos p on p.id = b.latest_photo_id
    where b.order_id = p_order_id;
  -- Manual prep settings cannot silently flatten a reviewed mixed invoice or
  -- overrule conflicting verified instructions. Missing snapshots still use
  -- the explicit manager plan, not unverified legacy crack_type/quantity.
  if v_invoice is not null then
    if v_invoice ->> 'source'='quickbooks' and v_invoice ->> 'read_status'='complete'
      and pg_catalog.jsonb_typeof(v_invoice -> 'invoice_id')='string'
      and nullif(trim(v_invoice ->> 'invoice_id'),'') is not null
      and v_invoice ->> 'invoice_id'=v_invoice_id
      and pg_catalog.jsonb_typeof(v_invoice -> 'checked_at')='string'
      and v_invoice ->> 'checked_at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' then
      begin
        v_invoice_checked := (v_invoice ->> 'checked_at')::timestamptz;
        v_invoice_valid := pg_catalog.isfinite(v_invoice_checked);
      exception when invalid_datetime_format or datetime_field_overflow then v_invoice_valid := false;
      end;
    end if;
    if not v_invoice_valid then
      v_reasons := array_append(v_reasons,'Invoice preparation details are unverified; review the invoice before confirming the whole order.');
    elsif v_invoice ->> 'cracking'='review' then
      v_reasons := array_append(v_reasons,'Invoice cracking instructions are mixed or unresolved; review the breakdown before confirming the whole order.');
    elsif coalesce(v_invoice ->> 'cracking','') not in ('circle','cocktail','straw_hole','whole') then
      v_reasons := array_append(v_reasons,'Invoice cracking instructions need review.');
    elsif v_prep ->> 'cracking_method' is distinct from v_invoice ->> 'cracking' then
      v_reasons := array_append(v_reasons,'Confirmed prep cracking conflicts with the verified invoice; review the instructions.');
    end if;
  end if;
  if v_plan.target_coconuts is null then v_reasons := array_append(v_reasons,'Confirm the production quantity with an owner or manager.'); end if;
  if v_plan.target_coconuts is not null and v_completed <> v_plan.target_coconuts then v_reasons := array_append(v_reasons,'Completed box photos must cover the confirmed coconut quantity.'); end if;
  if v_review > 0 then v_reasons := array_append(v_reasons,'Some box photos need review against current artwork or are unavailable.'); end if;
  if v_prep ->> 'stamp_checked' is distinct from 'true' then v_reasons := array_append(v_reasons,'Check the correct stamp against current artwork.'); end if;
  if v_prep ->> 'cracking_method' is null or v_prep #>> '{checks,cracking_checked}' is distinct from 'true' then v_reasons := array_append(v_reasons,'Confirm the prep cracking instructions and completed cracking check.'); end if;
  if v_prep #>> '{checks,straws_packed}' is distinct from 'true' then v_reasons := array_append(v_reasons,'Pack and confirm straws.'); end if;
  if v_prep ->> 'staffing' is null then
    v_reasons := array_append(v_reasons,'Confirm whether this order includes event staffing.');
  elsif v_prep ->> 'staffing' = 'true' then
    if v_prep ->> 'onsite_cracking_method' is null
      or v_prep #>> array['checks',coalesce(v_prep ->> 'onsite_cracking_method','') || '_tools_packed'] is distinct from 'true' then
      v_reasons := array_append(v_reasons,'Confirm the on-site cracking method and matching tools.');
    end if;
  end if;
  return pg_catalog.jsonb_build_object(
    'plan',pg_catalog.jsonb_build_object('version',coalesce(v_plan.version,0),'target_coconuts',v_plan.target_coconuts,'source',v_plan.source,'updated_at',v_plan.updated_at),
    'boxes',v_boxes,'totals',pg_catalog.jsonb_build_object(
      'reserved_coconuts',v_reserved,'completed_coconuts',v_completed,'loaded_coconuts',v_loaded,
      'completed_boxes',v_completed_boxes,'pending_boxes',v_pending,'needs_review_boxes',v_review,
      'remaining_coconuts',case when v_plan.target_coconuts is null then null else v_plan.target_coconuts-v_completed end,
      'unreserved_coconuts',case when v_plan.target_coconuts is null then null else v_plan.target_coconuts-v_reserved end),
    'ready_to_load',pg_catalog.cardinality(v_reasons)=0,
    'fully_loaded',pg_catalog.cardinality(v_reasons)=0 and v_loaded=v_plan.target_coconuts,
    'readiness_reasons',pg_catalog.to_jsonb(v_reasons));
end
$function$;

create or replace function public.hc_save_order_production_plan(p_order_id uuid,p_expected_version integer,p_target_coconuts integer)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare v_plan public.order_production_plans%rowtype; v_reserved bigint;
begin
  if not public.hc_can_access_order_prep(p_order_id) or not exists(select 1 from public.field_workers where auth_user_id=auth.uid() and active is true and lower(trim(role)) in ('owner','manager')) then
    raise exception using errcode='42501',message='Only an authorized owner or manager can confirm production quantities';
  end if;
  if p_expected_version is null or p_expected_version<0 or p_target_coconuts is null or p_target_coconuts<=0 then raise exception using errcode='22023',message='A version and positive whole coconut quantity are required'; end if;
  perform 1 from public.orders where id=p_order_id for share;
  insert into public.order_production_plans(order_id) values(p_order_id) on conflict do nothing;
  select * into v_plan from public.order_production_plans where order_id=p_order_id for update;
  if v_plan.version<>p_expected_version then raise exception using errcode='40001',message='Production target changed; reload before confirming'; end if;
  select coalesce(sum(coconuts_qty),0) into v_reserved from public.order_production_boxes where order_id=p_order_id and voided is false;
  if p_target_coconuts<v_reserved then raise exception using errcode='22023',message='Target cannot be less than coconut quantities already assigned to physical boxes'; end if;
  update public.order_production_plans set target_coconuts=p_target_coconuts,source='owner_confirmed',version=version+1,updated_by=auth.uid(),updated_at=pg_catalog.clock_timestamp() where order_id=p_order_id;
  insert into public.order_box_audit(order_id,actor_id,action,details) values(p_order_id,auth.uid(),'target_confirmed',pg_catalog.jsonb_build_object('previous_target',v_plan.target_coconuts,'target_coconuts',p_target_coconuts,'previous_version',v_plan.version));
  return public.hc_get_order_box_progress(p_order_id);
end
$function$;

create or replace function public.hc_reserve_order_box_photo(
  p_order_id uuid,p_box_id uuid,p_photo_id uuid,p_captured_at timestamptz,
  p_expected_artwork jsonb,p_coconuts_qty integer,p_expected_plan_version integer)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  v_plan public.order_production_plans%rowtype;
  v_box public.order_production_boxes%rowtype;
  v_photo public.order_box_photos%rowtype;
  v_logo jsonb; v_prep jsonb; v_reserved bigint; v_number integer; v_revision integer; v_name text;
begin
  if not public.hc_can_access_order_prep(p_order_id) then raise exception using errcode='42501',message='Order production access denied'; end if;
  if p_box_id is null or p_photo_id is null or p_coconuts_qty is null or p_coconuts_qty<=0
    or p_captured_at is null or not pg_catalog.isfinite(p_captured_at) or p_captured_at>pg_catalog.clock_timestamp()+interval '5 minutes'
    or p_expected_plan_version is null or p_expected_plan_version<0 then
    raise exception using errcode='22023',message='Box identity, photo identity, actual coconut quantity, capture time and plan version are required';
  end if;
  select public.hc_order_prep_artwork_identity(logo_asset) into v_logo from public.orders where id=p_order_id for share;
  if p_expected_artwork is null or p_expected_artwork is distinct from v_logo then raise exception using errcode='40001',message='Customer artwork changed; reload before photographing this box'; end if;
  select * into v_plan from public.order_production_plans where order_id=p_order_id for update;
  if not found or v_plan.target_coconuts is null then raise exception using errcode='22023',message='An owner or manager must confirm the production quantity first'; end if;
  if v_plan.version<>p_expected_plan_version then raise exception using errcode='40001',message='Production target changed; reload before photographing this box'; end if;
  perform 1 from public.order_prep_state where order_id=p_order_id for share;
  v_prep := public.hc_get_order_prep_state(p_order_id);
  if v_prep ->> 'stamp_checked' is distinct from 'true' or nullif(v_logo ->> 'checked_at','') is null then raise exception using errcode='22023',message='Confirm the physical stamp against checked customer artwork first'; end if;
  select * into v_box from public.order_production_boxes where id=p_box_id for update;
  if found then
    if v_box.order_id<>p_order_id then raise exception using errcode='42501',message='Box identity belongs to another order'; end if;
    if v_box.voided then raise exception using errcode='22023',message='This box was corrected and retired; use a new physical-box identity'; end if;
    if v_box.coconuts_qty<>p_coconuts_qty then raise exception using errcode='22023',message='A retake must keep the same physical box and coconut quantity'; end if;
  else
    select coalesce(sum(coconuts_qty) filter(where voided is false),0),coalesce(max(box_number),0)+1 into v_reserved,v_number from public.order_production_boxes where order_id=p_order_id;
    if v_reserved+p_coconuts_qty>v_plan.target_coconuts then raise exception using errcode='22023',message='This box would exceed the confirmed production quantity; ask a manager to review the target'; end if;
    insert into public.order_production_boxes(id,order_id,box_number,coconuts_qty,created_by)
      values(p_box_id,p_order_id,v_number,p_coconuts_qty,auth.uid()) returning * into v_box;
  end if;
  select * into v_photo from public.order_box_photos where id=p_photo_id;
  if found then
    if v_photo.box_id<>p_box_id or v_photo.order_id<>p_order_id or v_photo.reserved_by<>auth.uid() or v_photo.captured_at is distinct from p_captured_at then
      raise exception using errcode='42501',message='Photo identity is already reserved';
    end if;
  else
    select coalesce(max(revision),0)+1 into v_revision from public.order_box_photos where box_id=p_box_id;
    select coalesce(nullif(pg_catalog.to_jsonb(w)->>'name',''),'Field team') into v_name from public.field_workers w where w.auth_user_id=auth.uid() and w.active is true;
    insert into public.order_box_photos(id,box_id,order_id,revision,path,reserved_by,photographer_name,captured_at,artwork_snapshot,plan_version)
      values(p_photo_id,p_box_id,p_order_id,v_revision,p_order_id::text||'/'||auth.uid()::text||'/'||p_photo_id::text||'.jpg',auth.uid(),v_name,p_captured_at,v_logo,v_plan.version) returning * into v_photo;
    insert into public.order_box_audit(order_id,actor_id,action,details) values(p_order_id,auth.uid(),'box_photo_reserved',pg_catalog.jsonb_build_object('box_id',p_box_id,'photo_id',p_photo_id,'box_number',v_box.box_number,'coconuts_qty',v_box.coconuts_qty,'revision',v_photo.revision));
  end if;
  return pg_catalog.jsonb_build_object('id',v_photo.id,'photo_id',v_photo.id,'box_id',v_box.id,'box_number',v_box.box_number,'coconuts_qty',v_box.coconuts_qty,'revision',v_photo.revision,'path',v_photo.path);
end
$function$;

create or replace function public.hc_finish_order_box_photo(p_order_id uuid,p_box_id uuid,p_photo_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare v_photo public.order_box_photos%rowtype; v_box public.order_production_boxes%rowtype; v_logo jsonb; v_metadata jsonb; v_latest_revision integer;
begin
  if not public.hc_can_access_order_prep(p_order_id) then raise exception using errcode='42501',message='Order production access denied'; end if;
  select public.hc_order_prep_artwork_identity(logo_asset) into v_logo from public.orders where id=p_order_id for share;
  perform 1 from public.order_production_plans where order_id=p_order_id for update;
  select * into v_box from public.order_production_boxes where id=p_box_id for update;
  if not found or v_box.order_id<>p_order_id then raise exception using errcode='42501',message='Box identity belongs to another order'; end if;
  if v_box.voided then raise exception using errcode='22023',message='This box was corrected and retired; its photos cannot add production'; end if;
  select * into v_photo from public.order_box_photos where id=p_photo_id for update;
  if not found or v_photo.box_id<>p_box_id or v_photo.order_id<>p_order_id or v_photo.reserved_by<>auth.uid() then raise exception using errcode='42501',message='Photo reservation belongs to another user or box'; end if;
  if v_photo.finished_at is null then
    if v_photo.artwork_snapshot is distinct from v_logo then raise exception using errcode='40001',message='Customer artwork changed; reload and take a new photo of the correctly branded box'; end if;
    select metadata into v_metadata from storage.objects where bucket_id='order-box-media' and name=v_photo.path;
    if not found then raise exception using errcode='22023',message='Box photo upload has not finished'; end if;
    if v_metadata ->> 'mimetype' is distinct from 'image/jpeg' or coalesce(v_metadata ->> 'size','') !~ '^[0-9]{1,8}$' then raise exception using errcode='22023',message='Box photo must be a JPEG no larger than 8 MB'; end if;
    if (v_metadata ->> 'size')::bigint not between 1 and 8388608 then raise exception using errcode='22023',message='Box photo must be a JPEG no larger than 8 MB'; end if;
    update public.order_box_photos set finished_at=pg_catalog.clock_timestamp() where id=p_photo_id;
    select revision into v_latest_revision from public.order_box_photos where id=v_box.latest_photo_id;
    -- An old queued upload must not replace a more recent retake.
    if v_box.latest_photo_id is null or v_photo.revision>coalesce(v_latest_revision,0) then
      update public.order_production_boxes set latest_photo_id=p_photo_id,loaded=false,loaded_at=null,loaded_by=null where id=p_box_id;
    end if;
    insert into public.order_box_audit(order_id,actor_id,action,details) values(p_order_id,auth.uid(),'box_photo_finished',pg_catalog.jsonb_build_object('box_id',p_box_id,'photo_id',p_photo_id,'revision',v_photo.revision));
  end if;
  return public.hc_get_order_box_progress(p_order_id)||pg_catalog.jsonb_build_object('confirmed_box_id',p_box_id,'confirmed_photo_id',p_photo_id,'confirmed_photo_path',v_photo.path);
end
$function$;

create or replace function public.hc_set_order_box_loaded(p_order_id uuid,p_box_id uuid,p_expected_photo_id uuid,p_loaded boolean)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare v_box public.order_production_boxes%rowtype; v_logo jsonb;
begin
  if not public.hc_can_access_order_prep(p_order_id) then raise exception using errcode='42501',message='Order production access denied'; end if;
  if p_loaded is null or p_expected_photo_id is null then raise exception using errcode='22023',message='A current photo and explicit loading choice are required'; end if;
  select public.hc_order_prep_artwork_identity(logo_asset) into v_logo from public.orders where id=p_order_id for share;
  perform 1 from public.order_production_plans where order_id=p_order_id for update;
  select * into v_box from public.order_production_boxes where id=p_box_id for update;
  if not found or v_box.order_id<>p_order_id then raise exception using errcode='42501',message='Box identity belongs to another order'; end if;
  if v_box.voided then raise exception using errcode='22023',message='This box was corrected and retired; it cannot be loaded'; end if;
  if v_box.latest_photo_id is distinct from p_expected_photo_id then raise exception using errcode='40001',message='Box photo changed; reload before confirming loading'; end if;
  if p_loaded and not public.hc_order_box_photo_valid(v_box.latest_photo_id,v_logo) then raise exception using errcode='22023',message='A current finished box photo is required before loading'; end if;
  if v_box.loaded is distinct from p_loaded then
    update public.order_production_boxes set loaded=p_loaded,loaded_at=case when p_loaded then pg_catalog.clock_timestamp() else null end,loaded_by=case when p_loaded then auth.uid() else null end where id=p_box_id;
    insert into public.order_box_audit(order_id,actor_id,action,details) values(p_order_id,auth.uid(),'box_loaded',pg_catalog.jsonb_build_object('box_id',p_box_id,'photo_id',p_expected_photo_id,'loaded',p_loaded));
  end if;
  return public.hc_get_order_box_progress(p_order_id);
end
$function$;

create or replace function public.hc_mark_order_loaded(p_order_id uuid,p_expected_plan_version integer)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare v_plan public.order_production_plans%rowtype; v_progress jsonb; v_changed jsonb;
begin
  if not public.hc_can_access_order_prep(p_order_id) then raise exception using errcode='42501',message='Order production access denied'; end if;
  perform 1 from public.orders where id=p_order_id for share;
  select * into v_plan from public.order_production_plans where order_id=p_order_id for update;
  if not found or p_expected_plan_version is null or v_plan.version<>p_expected_plan_version then raise exception using errcode='40001',message='Production target changed; reload before confirming loading'; end if;
  perform 1 from public.order_prep_state where order_id=p_order_id for share;
  v_progress := public.hc_get_order_box_progress(p_order_id);
  if v_progress ->> 'ready_to_load' is distinct from 'true' then raise exception using errcode='22023',message='Production photos and all required prep, straws and tool checks must be complete before loading the whole order'; end if;
  with changed as (update public.order_production_boxes set loaded=true,loaded_at=pg_catalog.clock_timestamp(),loaded_by=auth.uid() where order_id=p_order_id and loaded is false and voided is false returning id,coconuts_qty,latest_photo_id)
    select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(changed)) into v_changed from changed;
  if v_changed is not null then insert into public.order_box_audit(order_id,actor_id,action,details) values(p_order_id,auth.uid(),'order_loaded',pg_catalog.jsonb_build_object('boxes',v_changed,'plan_version',v_plan.version)); end if;
  return public.hc_get_order_box_progress(p_order_id);
end
$function$;

create or replace function public.hc_void_order_production_box(p_order_id uuid,p_box_id uuid,p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare v_box public.order_production_boxes%rowtype;
begin
  if not public.hc_can_access_order_prep(p_order_id) or not exists(select 1 from public.field_workers where auth_user_id=auth.uid() and active is true and lower(trim(role)) in ('owner','manager')) then
    raise exception using errcode='42501',message='Only an authorized owner or manager can correct a physical-box record';
  end if;
  if p_reason is null or pg_catalog.length(trim(p_reason)) not between 5 and 500 then raise exception using errcode='22023',message='Enter a clear correction reason (5 to 500 characters)'; end if;
  perform 1 from public.orders where id=p_order_id for share;
  perform 1 from public.order_production_plans where order_id=p_order_id for update;
  select * into v_box from public.order_production_boxes where id=p_box_id for update;
  if not found or v_box.order_id<>p_order_id then raise exception using errcode='42501',message='Box identity belongs to another order'; end if;
  if v_box.loaded then raise exception using errcode='22023',message='Confirm this box is unloaded before correcting its record'; end if;
  if not v_box.voided then
    update public.order_production_boxes set voided=true,voided_at=pg_catalog.clock_timestamp(),voided_by=auth.uid(),void_reason=trim(p_reason) where id=p_box_id;
    insert into public.order_box_audit(order_id,actor_id,action,details) values(p_order_id,auth.uid(),'box_voided',pg_catalog.jsonb_build_object('box_id',p_box_id,'box_number',v_box.box_number,'coconuts_qty',v_box.coconuts_qty,'reason',trim(p_reason)));
  elsif v_box.void_reason is distinct from trim(p_reason) then
    raise exception using errcode='22023',message='This box was already retired with a recorded correction reason';
  end if;
  return public.hc_get_order_box_progress(p_order_id);
end
$function$;

create or replace function public.hc_can_access_order_box_photo(p_name text,p_upload boolean)
returns boolean language sql stable security definer set search_path = '' as $function$
  select auth.uid() is not null and exists(select 1 from public.order_box_photos p
    where p.path=p_name and public.hc_can_access_order_prep(p.order_id)
      and case when p_upload then p.reserved_by=auth.uid() and p.finished_at is null
        and exists(select 1 from public.order_production_boxes b where b.id=p.box_id and b.voided is false)
        else p.finished_at is not null or p.reserved_by=auth.uid() end);
$function$;
revoke all on function public.hc_order_box_photo_valid(uuid,jsonb),public.hc_get_order_box_progress(uuid),
  public.hc_save_order_production_plan(uuid,integer,integer),
  public.hc_reserve_order_box_photo(uuid,uuid,uuid,timestamptz,jsonb,integer,integer),
  public.hc_finish_order_box_photo(uuid,uuid,uuid),public.hc_set_order_box_loaded(uuid,uuid,uuid,boolean),
  public.hc_mark_order_loaded(uuid,integer),public.hc_void_order_production_box(uuid,uuid,text),public.hc_can_access_order_box_photo(text,boolean) from public,anon,authenticated;
grant execute on function public.hc_get_order_box_progress(uuid),public.hc_save_order_production_plan(uuid,integer,integer),
  public.hc_reserve_order_box_photo(uuid,uuid,uuid,timestamptz,jsonb,integer,integer),
  public.hc_finish_order_box_photo(uuid,uuid,uuid),public.hc_set_order_box_loaded(uuid,uuid,uuid,boolean),
  public.hc_mark_order_loaded(uuid,integer),public.hc_void_order_production_box(uuid,uuid,text),public.hc_can_access_order_box_photo(text,boolean) to authenticated;

drop policy if exists hc_order_box_read on storage.objects;
create policy hc_order_box_read on storage.objects for select to authenticated using(bucket_id='order-box-media' and public.hc_can_access_order_box_photo(name,false));
drop policy if exists hc_order_box_read_guard on storage.objects;
create policy hc_order_box_read_guard on storage.objects as restrictive for select to authenticated using(case when bucket_id='order-box-media' then public.hc_can_access_order_box_photo(name,false) else true end);
drop policy if exists hc_order_box_insert on storage.objects;
create policy hc_order_box_insert on storage.objects for insert to authenticated with check(bucket_id='order-box-media' and public.hc_can_access_order_box_photo(name,true));
drop policy if exists hc_order_box_insert_guard on storage.objects;
create policy hc_order_box_insert_guard on storage.objects as restrictive for insert to authenticated with check(case when bucket_id='order-box-media' then public.hc_can_access_order_box_photo(name,true) else true end);
drop policy if exists hc_order_box_update_guard on storage.objects;
create policy hc_order_box_update_guard on storage.objects as restrictive for update to authenticated using(bucket_id<>'order-box-media') with check(bucket_id<>'order-box-media');
drop policy if exists hc_order_box_delete_guard on storage.objects;
create policy hc_order_box_delete_guard on storage.objects as restrictive for delete to authenticated using(bucket_id<>'order-box-media');
drop policy if exists hc_order_box_anon_guard on storage.objects;
create policy hc_order_box_anon_guard on storage.objects as restrictive for all to anon using(bucket_id<>'order-box-media') with check(bucket_id<>'order-box-media');

comment on table public.order_production_plans is 'Explicit owner/manager production target, separate from invoice quantities. Reserved boxes cannot exceed the target. Never automatically copies raw invoice coconuts_qty.';
comment on table public.order_production_boxes is 'One identity per physical box, including partial boxes. Retakes reuse the identity and quantity. Loading is physical confirmation, not delivery.';
comment on table public.order_box_photos is 'Immutable JPEG revisions with authenticated photographer and server times. Capture time is device reported. Samples from 036 are separate and never contribute to counts.';
comment on table public.order_box_audit is 'Server-only action history. Counts and photos are evidence, not claims about elapsed labor time or profit.';
commit;

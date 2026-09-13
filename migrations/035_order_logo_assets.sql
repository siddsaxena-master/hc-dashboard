-- Selected customer logos for Calendar. Local preparation, not a deployment.
-- No assets, email bodies, guessed selections, or upload permissions are added.

begin;
set local lock_timeout = '10s';
set local statement_timeout = '120s';

do $preflight$
begin
  if pg_catalog.to_regclass('public.orders') is null
     or pg_catalog.to_regclass('storage.buckets') is null
     or pg_catalog.to_regclass('storage.objects') is null
     or pg_catalog.to_regprocedure(
       'public.hc_list_orders_for_current_user(timestamp with time zone,timestamp with time zone,text[],integer,integer)'
     ) is null then
    raise exception using errcode = '55000',
      message = '035 requires authenticated orders and Supabase Storage';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_class
    where oid = 'storage.objects'::regclass and relrowsecurity is true
  ) then
    raise exception using errcode = '55000',
      message = '035 requires Storage object row security to already be enabled';
  end if;
  if exists (
    select 1 from storage.buckets
    where id = 'order-logos' and public is distinct from false
  ) then
    raise exception using errcode = '55000',
      message = '035 refuses an existing public logo bucket; review it separately';
  end if;
end
$preflight$;

alter table public.orders add column if not exists logo_asset jsonb;
do $constraint$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.orders'::regclass
      and conname = 'orders_logo_asset_object'
  ) then
    alter table public.orders add constraint orders_logo_asset_object
      check (logo_asset is null or pg_catalog.jsonb_typeof(logo_asset) = 'object');
  end if;
end
$constraint$;
comment on column public.orders.logo_asset is
  'Optional selected logo manifest: {status:"received"|"approved"|"needs_review",checked_at,source_received_at,source_ref?,files:[{file_name,mime_type,original_path,preview_path,usage:"Coconut front"|"Coconut back"|"Display"|"Coconut"|"Usage needs confirmation"}]}. Paths are object names inside private order-logos. source_ref remains owner-only. No email body, signed URL, invoice PDF, or automatic approval belongs here.';

insert into storage.buckets (id, name, public)
values ('order-logos', 'order-logos', false)
on conflict (id) do nothing;

do $bucket_assertion$
declare
  v_public boolean;
  v_name text;
begin
  select bucket.public, bucket.name into v_public, v_name
  from storage.buckets as bucket where bucket.id = 'order-logos'
  for update;
  if not found or v_public is distinct from false or v_name is distinct from 'order-logos' then
    raise exception using errcode = '55000',
      message = '035 requires the expected private logo bucket; no existing bucket was changed';
  end if;
end
$bucket_assertion$;

-- This helper reads order metadata, never Storage itself, so the Storage
-- policy cannot recurse. Knowing a filename alone never authorizes a read.
create or replace function public.hc_can_read_order_logo(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select auth.uid() is not null
    and p_name is not null
    and pg_catalog.length(p_name) > 0
    and exists (
      select 1
      from public.orders as order_row
      join public.field_workers as worker
        on worker.auth_user_id = auth.uid()
       and worker.active is true
      where (
        lower(trim(worker.role)) = 'owner'
        or (
          lower(trim(worker.role)) in ('manager', 'team')
          and nullif(lower(trim(worker.market)), '') is not null
          and nullif(lower(trim(order_row.market)), '') is not null
          and lower(trim(order_row.market)) = lower(trim(worker.market))
        )
      )
      and exists (
        select 1
        from pg_catalog.jsonb_array_elements(
          case when pg_catalog.jsonb_typeof(order_row.logo_asset -> 'files') = 'array'
            then order_row.logo_asset -> 'files' else '[]'::jsonb end
        ) as logo_file(value)
        where pg_catalog.jsonb_typeof(logo_file.value) = 'object'
        and (
          (
            pg_catalog.jsonb_typeof(logo_file.value -> 'original_path') = 'string'
            and logo_file.value ->> 'original_path' = p_name
          )
          or (
            pg_catalog.jsonb_typeof(logo_file.value -> 'preview_path') = 'string'
            and logo_file.value ->> 'preview_path' = p_name
          )
        )
      )
    );
$function$;

revoke all on function public.hc_can_read_order_logo(text) from public, anon, authenticated;
grant execute on function public.hc_can_read_order_logo(text) to authenticated;

-- Allow only selected originals/previews. Restrictive guards are necessary:
-- older permissive Storage policies otherwise combine with this one using OR.
-- They affect only order-logos; access to other buckets stays unchanged.
drop policy if exists hc_order_logos_selected_read on storage.objects;
create policy hc_order_logos_selected_read on storage.objects
as permissive for select to authenticated
using (bucket_id = 'order-logos' and public.hc_can_read_order_logo(name));

drop policy if exists hc_order_logos_authenticated_read_guard on storage.objects;
create policy hc_order_logos_authenticated_read_guard on storage.objects
as restrictive for select to authenticated
using (case when bucket_id = 'order-logos'
  then public.hc_can_read_order_logo(name) else true end);

drop policy if exists hc_order_logos_anonymous_read_guard on storage.objects;
create policy hc_order_logos_anonymous_read_guard on storage.objects
as restrictive for select to anon
using (bucket_id <> 'order-logos');

-- Add only safe logo fields to the installed order projection. The anchor is
-- different from 034's anchor, so the two narrow patches do not overlap.
do $projection$
declare
  v_public regprocedure := pg_catalog.to_regprocedure(
    'public.hc_list_orders_for_current_user(timestamp with time zone,timestamp with time zone,text[],integer,integer)'
  );
  v_target regprocedure;
  v_public_before text;
  v_before text;
  v_after text;
  v_acl aclitem[];
  v_owner oid;
  v_security_definer boolean;
  v_config text[];
  v_anchor constant text := $anchor$'id', o.id$anchor$;
  v_addition constant text := $addition$,
      'logo_asset', case
        when o.logo_asset is null then null
        else jsonb_build_object(
          'status', o.logo_asset -> 'status',
          'checked_at', o.logo_asset -> 'checked_at',
          'source_received_at', o.logo_asset -> 'source_received_at',
          'files', (
            select coalesce(jsonb_agg(jsonb_build_object(
              'file_name', logo_file.value -> 'file_name',
              'mime_type', logo_file.value -> 'mime_type',
              'original_path', logo_file.value -> 'original_path',
              'preview_path', logo_file.value -> 'preview_path',
              'usage', logo_file.value -> 'usage'
            ) order by logo_file.position), '[]'::jsonb)
            from pg_catalog.jsonb_array_elements(
              case when pg_catalog.jsonb_typeof(o.logo_asset -> 'files') = 'array'
                then o.logo_asset -> 'files' else '[]'::jsonb end
            ) with ordinality as logo_file(value, position)
            where pg_catalog.jsonb_typeof(logo_file.value) = 'object'
          )
        )
      end$addition$;
begin
  v_public_before := pg_catalog.pg_get_functiondef(v_public);
  v_target := v_public;
  if pg_catalog.strpos(v_public_before,
       'public.hc_list_orders_for_current_user_pre_mfa_028(') > 0 then
    v_target := pg_catalog.to_regprocedure(
      'public.hc_list_orders_for_current_user_pre_mfa_028(timestamp with time zone,timestamp with time zone,text[],integer,integer)'
    );
    if v_target is null then
      raise exception using errcode = '55000',
        message = '035 cannot find the existing wrapped order projection';
    end if;
  end if;
  v_before := pg_catalog.pg_get_functiondef(v_target);
  select proacl, proowner, prosecdef, proconfig
  into v_acl, v_owner, v_security_definer, v_config
  from pg_catalog.pg_proc where oid = v_target;

  if v_security_definer is not true
     or pg_catalog.strpos(v_before, 'else jsonb_build_object(') = 0
     or pg_catalog.strpos(v_before, 'when v_role = ''owner'' then to_jsonb(o)') = 0
     or (pg_catalog.length(v_before)
       - pg_catalog.length(pg_catalog.replace(v_before, v_anchor, '')))
       <> pg_catalog.length(v_anchor) then
    raise exception using errcode = '55000',
      message = '035 found an unrecognized order projection; review before applying';
  end if;
  if pg_catalog.strpos(v_before, v_anchor || v_addition) > 0 then
    v_after := v_before;
  else
    if pg_catalog.strpos(v_before, '''logo_asset''') > 0 then
      raise exception using errcode = '55000',
        message = '035 found different logo metadata; review before applying';
    end if;
    v_after := pg_catalog.replace(v_before, v_anchor, v_anchor || v_addition);
    if pg_catalog.replace(v_after, v_anchor || v_addition, v_anchor) <> v_before then
      raise exception using errcode = '55000',
        message = '035 refused a change outside the operational projection';
    end if;
    execute v_after;
  end if;

  if exists (
    select 1 from pg_catalog.pg_proc where oid = v_target
      and (proacl is distinct from v_acl or proowner is distinct from v_owner
        or prosecdef is distinct from v_security_definer or proconfig is distinct from v_config)
  ) then
    raise exception using errcode = '55000',
      message = '035 assertion failed: order-list privileges or settings changed';
  end if;
  if v_target <> v_public and pg_catalog.pg_get_functiondef(v_public) <> v_public_before then
    raise exception using errcode = '55000',
      message = '035 assertion failed: the authentication wrapper changed';
  end if;
end
$projection$;

do $permission_assertions$
begin
  if pg_catalog.has_function_privilege('anon', 'public.hc_can_read_order_logo(text)', 'EXECUTE')
     or not pg_catalog.has_function_privilege('authenticated', 'public.hc_can_read_order_logo(text)', 'EXECUTE') then
    raise exception using errcode = '42501',
      message = '035 assertion failed: logo-read helper grants are incorrect';
  end if;
end
$permission_assertions$;

commit;

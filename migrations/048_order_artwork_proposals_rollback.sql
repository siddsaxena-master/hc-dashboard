-- ============================================================================
-- 048_order_artwork_proposals_rollback.sql
-- Undo migration 048: put the 035 text of public.hc_can_read_order_logo back
-- byte for byte, drop the two owner functions, the read policy, the artwork
-- proposals table with every row in it, the two columns on intake_messages
-- (email_meta, artwork_scanned_at) and the email_meta check, and clear the
-- 25 MB cap on the order-logos bucket. Safe to run twice. Touches nothing
-- else: orders.logo_asset (files a Use it put on a card STAY on the card,
-- readable through the 035 rule), the intake rows themselves (rows a
-- decision already dismissed stay dismissed), the three 035 storage
-- policies, order_address_proposals, order_time_proposals, the
-- reconfirmation rows and every other function stay as they are.
--
-- It REFUSES (55000) while any order_artwork_proposals row is pending: the
-- owner may be looking at it on the phone. Decide those rows in the app (or
-- retire them by hand with the service key), then run this again.
--
-- It also REFUSES (55000) while a used row exists whose file is still on a
-- card (its sha256, original_path or preview_path is in that order's
-- logo_asset files): dropping the row would lose the record of which email
-- that card file came from. Take the file off the card by hand first (a
-- guarded service-key PATCH of orders.logo_asset, its own "yes do it",
-- decision 11 of the plan), or keep 048.
--
-- Dropping email_meta loses the replay's attachment records: run the replay
-- again after a re-apply. Dropping artwork_scanned_at makes a re-applied 048
-- re-examine every linked email once (harmless: the sha256 dedupe makes
-- them repeats). Until the poller, the worker and the phone are redeployed
-- without the feature they log a missing table or column and propose or
-- show nothing.
-- ============================================================================

begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';

do $preflight$
declare
  v_pending integer := 0;
  v_on_card integer := 0;
begin
  -- Dynamic SQL, so this block still parses when the table is already gone
  -- (the second run of this file).
  if pg_catalog.to_regclass('public.order_artwork_proposals') is not null then
    execute 'select pg_catalog.count(*)::integer from public.order_artwork_proposals where status = ''pending'''
       into v_pending;
    if v_pending > 0 then
      raise exception using
        errcode = '55000',
        message = pg_catalog.format('048 rollback refuses while %s artwork proposal(s) are pending (the owner may be looking at them); decide them in HC Field, then run again', v_pending);
    end if;
    execute 'select pg_catalog.count(*)::integer from public.order_artwork_proposals as p'
         || ' join public.orders as o on o.id = p.order_id'
         || ' where p.status = ''used'' and exists ('
         || '   select 1 from pg_catalog.jsonb_array_elements('
         || '     case when pg_catalog.jsonb_typeof(o.logo_asset -> ''files'') = ''array'''
         || '       then o.logo_asset -> ''files'' else ''[]''::jsonb end) as logo_file(value)'
         || '   where pg_catalog.jsonb_typeof(logo_file.value) = ''object'''
         || '     and (logo_file.value ->> ''sha256'' = p.sha256'
         || '       or logo_file.value ->> ''preview_sha256'' = p.sha256'
         || '       or (p.original_path is not null and logo_file.value ->> ''original_path'' = p.original_path)'
         || '       or (p.preview_path is not null and logo_file.value ->> ''preview_path'' = p.preview_path)))'
       into v_on_card;
    if v_on_card > 0 then
      raise exception using
        errcode = '55000',
        message = pg_catalog.format('048 rollback refuses while %s used artwork proposal(s) still have their file on a card (the record of which email each card file came from would go with the table); take the file off the card by hand first, then run again', v_on_card);
    end if;
  end if;
end
$preflight$;

-- The 035 text of the logo-read helper (035:73-120), byte for byte. The
-- three storage policies keep calling it by name.
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

drop function if exists public.hc_decide_proposed_artwork(uuid, bigint, text);

drop function if exists public.hc_approve_order_artwork(uuid, text);

drop policy if exists order_artwork_proposals_owner_select on public.order_artwork_proposals;

drop table if exists public.order_artwork_proposals;

alter table public.intake_messages
  drop constraint if exists intake_messages_email_meta_object;

alter table public.intake_messages
  drop column if exists email_meta;

alter table public.intake_messages
  drop column if exists artwork_scanned_at;

update storage.buckets
   set file_size_limit = null
 where id = 'order-logos';

do $postflight$
declare
  v_src text;
  v_policy text;
  v_035 constant text := $body035$
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
$body035$;
begin
  if pg_catalog.to_regclass('public.order_artwork_proposals') is not null
     or pg_catalog.to_regprocedure('public.hc_decide_proposed_artwork(uuid, bigint, text)') is not null
     or pg_catalog.to_regprocedure('public.hc_approve_order_artwork(uuid, text)') is not null
     or exists (
       select 1 from pg_catalog.pg_attribute
       where attrelid = 'public.intake_messages'::regclass
         and attname in ('email_meta', 'artwork_scanned_at')
         and attnum > 0
         and not attisdropped
     ) then
    raise exception using errcode = '55000', message = '048 rollback postflight: something 048 installed is still present';
  end if;
  select p.prosrc into v_src from pg_catalog.pg_proc as p
  where p.oid = pg_catalog.to_regprocedure('public.hc_can_read_order_logo(text)');
  if v_src is null
     or pg_catalog.replace(v_src, pg_catalog.chr(13), '') <> pg_catalog.replace(v_035, pg_catalog.chr(13), '')
     or pg_catalog.has_function_privilege('anon', 'public.hc_can_read_order_logo(text)', 'execute')
     or not pg_catalog.has_function_privilege('authenticated', 'public.hc_can_read_order_logo(text)', 'execute') then
    raise exception using errcode = '55000', message = '048 rollback postflight: hc_can_read_order_logo is not back on the 035 text with the 035 grants';
  end if;
  foreach v_policy in array array['hc_order_logos_selected_read', 'hc_order_logos_authenticated_read_guard', 'hc_order_logos_anonymous_read_guard'] loop
    if not exists (
      select 1 from pg_catalog.pg_policies
      where schemaname = 'storage' and tablename = 'objects' and policyname = v_policy
    ) then
      raise exception using errcode = '55000', message = pg_catalog.format('048 rollback postflight: the 035 storage policy %s is missing', v_policy);
    end if;
  end loop;
  if exists (select 1 from storage.buckets as b where b.id = 'order-logos' and b.file_size_limit is not null) then
    raise exception using errcode = '55000', message = '048 rollback postflight: the order-logos bucket still carries a cap';
  end if;
end
$postflight$;

commit;

-- ============================================================================
-- 038_delivery_request_owner_edit.sql
-- Owner-confirmed delivery time and on-site location (HC Field app Calendar).
--
-- LOCAL PREPARATION ONLY until Sidd approves the production run.
--
-- What this adds:
--   * public.hc_set_delivery_request(order, window, location, date): the ONE
--     write path for orders.delivery_request. Owners anywhere, managers only
--     inside their own market (the 036 access rule). Team, anon, and public
--     are refused. It writes the 034 contract keys plus the optional
--     location, mirrors the location into orders.venue (the crew screens
--     already print venue), remembers the original venue in venue_before,
--     and restores it when the location is cleared.
--   * 'location' joins the delivery_request keys that non-owner phones may
--     see through hc_list_orders_for_current_user. The live projection is
--     patched in place exactly like 034 did, so a database that carries the
--     028 owner-MFA wrapper keeps that wrapper untouched.
--
-- What this never touches: delivery_at_utc (a date marker the app buckets
-- days by), delivery_notes (the street address Navigate uses), market,
-- stage, and every payment field. Dates change through the invoice only.
-- Jarvis never writes delivery_request; the Claudia worker only stamps
-- notified_at after its confirmation push.
-- ============================================================================

begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';

do $preflight$
declare
  v_column text;
begin
  if pg_catalog.to_regclass('public.orders') is null
     or pg_catalog.to_regclass('public.field_workers') is null
     or pg_catalog.to_regprocedure('auth.uid()') is null
     or pg_catalog.to_regprocedure(
       'public.hc_list_orders_for_current_user(timestamp with time zone,timestamp with time zone,text[],integer,integer)'
     ) is null then
    raise exception using
      errcode = '55000',
      message = '038 requires orders, field_workers, auth.uid() and the authenticated order-list function';
  end if;

  -- Every column the function reads or writes must already exist.
  foreach v_column in array array[
    'delivery_request', 'venue', 'updated_at', 'delivery_at_utc',
    'event_start_at', 'stage', 'market'
  ] loop
    if not exists (
      select 1 from pg_catalog.pg_attribute
      where attrelid = 'public.orders'::regclass
        and attname = v_column
        and attnum > 0
        and not attisdropped
    ) then
      raise exception using
        errcode = '55000',
        message = pg_catalog.format('038 requires column public.orders.%s (034 adds delivery_request)', v_column);
    end if;
  end loop;

  if not exists (
    select 1 from pg_catalog.pg_attribute
    where attrelid = 'public.field_workers'::regclass
      and attname = 'auth_user_id'
      and not attisdropped
  ) then
    raise exception using
      errcode = '55000',
      message = '038 requires field_workers.auth_user_id from migration 015';
  end if;

  -- The 034 shape guard: delivery_request is null or a JSON object.
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.orders'::regclass
      and conname = 'orders_delivery_request_object'
  ) then
    raise exception using
      errcode = '55000',
      message = '038 requires the 034 constraint orders_delivery_request_object';
  end if;
end
$preflight$;

-- Confirms (or clears) the delivery window and on-site location for one order.
--   p_window   the time or window as typed, trimmed, 1..80 characters
--   p_location optional on-site instruction, trimmed, up to 200 characters
--   p_date     optional; must equal the row's own delivery date
-- Both p_window and p_location null (or blank) clears the request.
-- Returns the stored delivery_request, or null once cleared.
create or replace function public.hc_set_delivery_request(
  p_order_id uuid,
  p_window text,
  p_location text default null,
  p_date date default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_role text;
  v_market text;
  v_order public.orders%rowtype;
  -- Whitespace runs (including line breaks) collapse to one space, then the
  -- ends are trimmed. Blank input becomes null.
  v_window text := nullif(pg_catalog.btrim(
    pg_catalog.regexp_replace(coalesce(p_window, ''), '\s+', ' ', 'g')), '');
  v_location text := nullif(pg_catalog.btrim(
    pg_catalog.regexp_replace(coalesce(p_location, ''), '\s+', ' ', 'g')), '');
  v_row_date date;
  v_existing jsonb;
  v_material jsonb;
  v_new jsonb;
  v_venue text;
  v_now timestamptz := pg_catalog.now();
begin
  if v_uid is null then
    raise exception using
      errcode = '42501',
      message = 'authenticated field worker required';
  end if;

  -- Who is calling: one active roster row, role and market normalized the
  -- same way 019 and 036 normalize them.
  select pg_catalog.lower(pg_catalog.btrim(w.role)),
         nullif(pg_catalog.lower(pg_catalog.btrim(w.market)), '')
  into v_role, v_market
  from public.field_workers as w
  where w.auth_user_id = v_uid
    and w.active is true
  limit 1;

  if v_role is null or v_role not in ('owner', 'manager') then
    raise exception using
      errcode = '42501',
      message = 'only an active owner or manager can confirm delivery details';
  end if;

  if p_order_id is null then
    raise exception using
      errcode = '22023',
      message = 'an order id is required';
  end if;

  -- Lock the row for the rest of this call so a QuickBooks re-sync or a
  -- second phone cannot slip in between the checks and the write.
  select o.* into v_order
  from public.orders as o
  where o.id = p_order_id
  for update;

  if not found then
    if v_role = 'owner' then
      raise exception using
        errcode = '22023',
        message = 'order not found';
    end if;
    -- A manager learns nothing about orders outside the market.
    raise exception using
      errcode = '42501',
      message = 'order access denied';
  end if;

  -- Managers: the order market must be nonblank and equal their own market.
  if v_role = 'manager' and (
       v_market is null
       or nullif(pg_catalog.lower(pg_catalog.btrim(v_order.market)), '') is null
       or pg_catalog.lower(pg_catalog.btrim(v_order.market)) <> v_market
     ) then
    raise exception using
      errcode = '42501',
      message = 'order access denied';
  end if;

  if pg_catalog.lower(pg_catalog.btrim(coalesce(v_order.stage, ''))) = 'cancelled' then
    raise exception using
      errcode = '22023',
      message = 'a cancelled order cannot take delivery details';
  end if;

  if v_window ~ '[[:cntrl:]]' or v_location ~ '[[:cntrl:]]' then
    raise exception using
      errcode = '22023',
      message = 'delivery details must be plain text';
  end if;

  if v_window is not null and pg_catalog.length(v_window) > 80 then
    raise exception using
      errcode = '22023',
      message = 'delivery window must be 80 characters or fewer';
  end if;

  if v_location is not null and pg_catalog.length(v_location) > 200 then
    raise exception using
      errcode = '22023',
      message = 'delivery location must be 200 characters or fewer';
  end if;

  if v_window is null and v_location is not null then
    raise exception using
      errcode = '22023',
      message = 'a delivery window is required when setting a location';
  end if;

  -- The row's own delivery date, the way the app buckets days: the UTC
  -- calendar date of the delivery marker, else of the event start. Reading it
  -- through 'UTC' keeps the answer the same whatever timezone the session has.
  v_row_date := coalesce(
    (v_order.delivery_at_utc at time zone 'UTC')::date,
    (v_order.event_start_at at time zone 'UTC')::date
  );

  if p_date is not null and (v_row_date is null or p_date <> v_row_date) then
    raise exception using
      errcode = '22023',
      message = pg_catalog.format(
        'delivery dates change through the invoice; this order is on %s',
        coalesce(pg_catalog.to_char(v_row_date, 'YYYY-MM-DD'), 'no date yet'));
  end if;

  v_existing := v_order.delivery_request;

  -- CLEAR: no window and no location.
  if v_window is null then
    if v_existing is null then
      -- Nothing to clear; a repeated clear changes nothing.
      return null;
    end if;
    v_venue := v_order.venue;
    -- Put the original venue back only while our mirror is still in place.
    -- If someone else changed venue meanwhile, their value stays.
    if (v_existing ? 'venue_before')
       and v_order.venue is not distinct from (v_existing ->> 'location') then
      v_venue := v_existing ->> 'venue_before';
    end if;
    update public.orders
    set delivery_request = null,
        venue = v_venue,
        updated_at = v_now
    where id = p_order_id;
    return null;
  end if;

  if v_row_date is null then
    raise exception using
      errcode = '22023',
      message = 'this order has no delivery date yet; set the date on the invoice first';
  end if;

  -- The keys that describe the request itself.
  v_material := pg_catalog.jsonb_build_object(
    'date', pg_catalog.to_char(v_row_date, 'YYYY-MM-DD'),
    'window', v_window,
    'status', 'confirmed',
    'source', 'owner'
  );
  if v_location is not null then
    v_material := v_material || pg_catalog.jsonb_build_object('location', v_location);
  end if;

  -- Replay safety: the same details again leave the row exactly as it is.
  -- checked_at, set_by, notified_at and venue_before stay, so a retried tap
  -- never re-announces a time the crew already heard about.
  if v_existing is not null
     and (v_existing - array['checked_at', 'set_by', 'notified_at', 'venue_before']) = v_material then
    return v_existing;
  end if;

  -- A real edit: fresh checked_at (ISO 8601, UTC, the shape JavaScript
  -- produces), no notified_at, so the worker announces it again.
  v_new := v_material || pg_catalog.jsonb_build_object(
    'checked_at', pg_catalog.to_char(v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'set_by', v_uid
  );

  v_venue := v_order.venue;
  if v_location is not null then
    -- venue_before is captured the first time a location is set and kept
    -- across later location edits, so a clear always restores the original.
    if v_existing is not null and (v_existing ? 'venue_before') then
      v_new := v_new || pg_catalog.jsonb_build_object('venue_before', v_existing -> 'venue_before');
    else
      v_new := v_new || pg_catalog.jsonb_build_object('venue_before', v_order.venue);
    end if;
    v_venue := v_location;
  elsif v_existing is not null and (v_existing ? 'venue_before')
        and v_order.venue is not distinct from (v_existing ->> 'location') then
    -- Location removed while the window stays: restore the original venue.
    v_venue := v_existing ->> 'venue_before';
  end if;

  update public.orders
  set delivery_request = v_new,
      venue = v_venue,
      updated_at = v_now
  where id = p_order_id;

  return v_new;
end
$function$;

revoke all on function public.hc_set_delivery_request(uuid, text, text, date)
  from public, anon, authenticated;
grant execute on function public.hc_set_delivery_request(uuid, text, text, date)
  to authenticated;

comment on function public.hc_set_delivery_request(uuid, text, text, date) is
  'Owner or same-market manager confirms a delivery window (1..80 chars) and optional on-site location (up to 200 chars) for one order. p_date must equal the row delivery date (UTC date of delivery_at_utc, else event_start_at); other dates are refused because dates change through the invoice. Both null clears the request and restores venue from venue_before. The location mirrors into venue while set. Replay-safe: identical details leave the row untouched. Never touches delivery_at_utc, delivery_notes, market, stage, or payment fields.';

comment on column public.orders.delivery_request is
  'Optional human-verified request: {date:"YYYY-MM-DD"|null,window,status:"requested"|"confirmed"|"conflict",source:"email"|"owner",checked_at,source_ref?,location?,venue_before?,set_by?,notified_at?}. Owner edits go only through hc_set_delivery_request (038): status confirmed, source owner, date equal to the row delivery date, checked_at ISO UTC. location mirrors into venue while set; venue_before keeps the pre-mirror venue and is restored when the location is cleared. notified_at is stamped only by the Claudia worker after its confirmation push and is dropped by the next edit. No automatic email ingestion. source_ref stays owner-only. Missing or conflicting details must remain visible as unknown/conflicting.';

-- Extend the existing non-owner JSON projection by one key. Reusing the
-- installed definition preserves its authentication, role, market, date,
-- stage, pagination, execution privileges, and function settings. In a
-- database that has the optional 028 wrapper, change its backing projection
-- and leave the wrapper itself intact, exactly as 034 did.
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
  -- The last line 034 placed inside the delivery_request block.
  v_anchor constant text := $anchor$'checked_at', o.delivery_request -> 'checked_at'$anchor$;
  v_addition constant text := $addition$,
          'location', o.delivery_request -> 'location'$addition$;
begin
  v_public_before := pg_catalog.pg_get_functiondef(v_public);
  v_target := v_public;
  if pg_catalog.strpos(v_public_before,
       'public.hc_list_orders_for_current_user_pre_mfa_028(') > 0 then
    v_target := pg_catalog.to_regprocedure(
      'public.hc_list_orders_for_current_user_pre_mfa_028(timestamp with time zone,timestamp with time zone,text[],integer,integer)'
    );
    if v_target is null then
      raise exception using
        errcode = '55000',
        message = '038 cannot find the existing wrapped order projection';
    end if;
  end if;

  v_before := pg_catalog.pg_get_functiondef(v_target);
  select proacl, proowner, prosecdef, proconfig
  into v_acl, v_owner, v_security_definer, v_config
  from pg_catalog.pg_proc where oid = v_target;

  -- The anchor must appear exactly once: that is the 034 delivery block.
  if v_security_definer is not true
     or pg_catalog.strpos(v_before, 'else jsonb_build_object(') = 0
     or pg_catalog.strpos(v_before, 'when v_role = ''owner'' then to_jsonb(o)') = 0
     or (pg_catalog.length(v_before)
       - pg_catalog.length(pg_catalog.replace(v_before, v_anchor, '')))
       <> pg_catalog.length(v_anchor) then
    raise exception using
      errcode = '55000',
      message = '038 requires the 034 delivery projection; review the order projection before applying';
  end if;

  if pg_catalog.strpos(v_before, v_anchor || v_addition) > 0 then
    -- Rerunning this exact migration must not duplicate the key.
    v_after := v_before;
  else
    if pg_catalog.strpos(v_before, '''location'', o.delivery_request') > 0 then
      raise exception using
        errcode = '55000',
        message = '038 found a different location projection; review it before applying';
    end if;
    v_after := pg_catalog.replace(v_before, v_anchor, v_anchor || v_addition);
    if pg_catalog.replace(v_after, v_anchor || v_addition, v_anchor) <> v_before then
      raise exception using
        errcode = '55000',
        message = '038 refused to change code outside the operational projection';
    end if;
    execute v_after;
  end if;

  if exists (
    select 1 from pg_catalog.pg_proc
    where oid = v_target
      and (proacl is distinct from v_acl
        or proowner is distinct from v_owner
        or prosecdef is distinct from v_security_definer
        or proconfig is distinct from v_config)
  ) then
    raise exception using
      errcode = '55000',
      message = '038 assertion failed: function privileges or settings changed';
  end if;
  if v_target <> v_public
     and pg_catalog.pg_get_functiondef(v_public) <> v_public_before then
    raise exception using
      errcode = '55000',
      message = '038 assertion failed: the existing authentication wrapper changed';
  end if;
end
$projection$;

do $postflight$
declare
  v_signature constant text := 'public.hc_set_delivery_request(uuid,text,text,date)';
  v_definition text;
  v_projection text;
begin
  if pg_catalog.to_regprocedure(v_signature) is null
     or pg_catalog.has_function_privilege('anon', v_signature, 'EXECUTE')
     or not pg_catalog.has_function_privilege('authenticated', v_signature, 'EXECUTE')
     -- grantee 0 is PUBLIC: nobody may reach this through a default grant.
     or exists (
       select 1
       from pg_catalog.pg_proc as p
       cross join lateral pg_catalog.aclexplode(p.proacl) as a
       where p.oid = v_signature::regprocedure
         and a.grantee = 0
     )
     or not exists (
       select 1 from pg_catalog.pg_proc as p
       where p.oid = v_signature::regprocedure
         and p.prosecdef is true
         and pg_catalog.array_to_string(p.proconfig, ',') ~ 'search_path='
     ) then
    raise exception using
      errcode = '42501',
      message = '038 assertion failed: delivery request RPC grants or settings are unsafe';
  end if;

  v_definition := pg_catalog.pg_get_functiondef(v_signature::regprocedure);
  if v_definition !~ 'for update'
     or v_definition !~ '''cancelled'''
     or v_definition !~ 'venue_before'
     or v_definition !~ 'at time zone ''UTC'''
     or v_definition !~ 'notified_at'
     or v_definition ~ 'delivery_notes\s*=' then
    raise exception using
      errcode = '55000',
      message = '038 assertion failed: delivery request function definition drifted';
  end if;

  -- Whichever function carries the projection body must now expose location
  -- to non-owners, and still never the whole delivery_request object.
  select pg_catalog.pg_get_functiondef(p.oid)
  into v_projection
  from pg_catalog.pg_proc as p
  where p.pronamespace = 'public'::regnamespace
    and p.proname in ('hc_list_orders_for_current_user', 'hc_list_orders_for_current_user_pre_mfa_028')
    and pg_catalog.pg_get_functiondef(p.oid) like '%''location'', o.delivery_request -> ''location''%'
  limit 1;
  if v_projection is null
     or v_projection ~ 'else o\.delivery_request\M'
     or v_projection ~ '''venue_before''|''set_by''|''notified_at''|''source_ref''' then
    raise exception using
      errcode = '55000',
      message = '038 assertion failed: the non-owner projection is not the expected whitelist';
  end if;
end
$postflight$;

commit;

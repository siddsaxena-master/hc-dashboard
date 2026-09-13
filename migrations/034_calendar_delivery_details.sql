-- Calendar delivery details. Local preparation only until separately approved.
-- 030 and 031 are payment changes; 032 and 033 stay reserved for parallel work.
-- This adds no guessed data, new write function, policy, or permission grant.

begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';

do $preflight$
begin
  if pg_catalog.to_regclass('public.orders') is null
     or pg_catalog.to_regprocedure(
       'public.hc_list_orders_for_current_user(timestamp with time zone,timestamp with time zone,text[],integer,integer)'
     ) is null then
    raise exception using
      errcode = '55000',
      message = '034 requires the existing authenticated order-list function';
  end if;
end
$preflight$;

alter table public.orders
  add column if not exists invoice_fulfillment jsonb,
  add column if not exists delivery_request jsonb;

-- SQL NULL means not checked yet. Objects may gain optional keys later;
-- neither an empty object nor a field's mere presence means verified.
do $constraints$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.orders'::regclass
      and conname = 'orders_invoice_fulfillment_object'
  ) then
    alter table public.orders
      add constraint orders_invoice_fulfillment_object
      check (invoice_fulfillment is null
        or pg_catalog.jsonb_typeof(invoice_fulfillment) = 'object');
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.orders'::regclass
      and conname = 'orders_delivery_request_object'
  ) then
    alter table public.orders
      add constraint orders_delivery_request_object
      check (delivery_request is null
        or pg_catalog.jsonb_typeof(delivery_request) = 'object');
  end if;
end
$constraints$;

comment on column public.orders.invoice_fulfillment is
  'Optional invoice snapshot: {source:"quickbooks",read_status:"unread"|"complete",invoice_id,checked_at,source_updated_at,address,cracking:"cocktail"|"straw_hole"|"review",cracking_note,delivery_date:"YYYY-MM-DD"|null,delivery_window}. Require complete read_status and validate identity/timestamps before showing checked. Does not replace the requested delivery details or reschedule the calendar.';
comment on column public.orders.delivery_request is
  'Optional human-verified request: {date:"YYYY-MM-DD"|null,window,status:"requested"|"confirmed"|"conflict",source:"email"|"owner",checked_at,source_ref?}. No automatic email ingestion. source_ref stays owner-only. Missing or conflicting details must remain visible as unknown/conflicting.';

-- Extend only the existing non-owner JSON projection. Reusing the installed
-- definition preserves its exact authentication, role, market, date, stage,
-- pagination, execution privileges, and function settings. In a database that
-- has the optional 028 wrapper, change its backing projection and leave the
-- wrapper itself intact. This migration never installs that wrapper.
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
  v_anchor constant text := $anchor$'delivery_signed_at', o.delivery_signed_at$anchor$;
  v_addition constant text := $addition$,
      'invoice_fulfillment', case
        when o.invoice_fulfillment is null then null
        else jsonb_build_object(
          'source', o.invoice_fulfillment -> 'source',
          'read_status', o.invoice_fulfillment -> 'read_status',
          'invoice_id', o.invoice_fulfillment -> 'invoice_id',
          'checked_at', o.invoice_fulfillment -> 'checked_at',
          'source_updated_at', o.invoice_fulfillment -> 'source_updated_at',
          'address', o.invoice_fulfillment -> 'address',
          'cracking', o.invoice_fulfillment -> 'cracking',
          'cracking_note', o.invoice_fulfillment -> 'cracking_note',
          'delivery_date', o.invoice_fulfillment -> 'delivery_date',
          'delivery_window', o.invoice_fulfillment -> 'delivery_window'
        )
      end,
      'delivery_request', case
        when o.delivery_request is null then null
        else jsonb_build_object(
          'date', o.delivery_request -> 'date',
          'window', o.delivery_request -> 'window',
          'status', o.delivery_request -> 'status',
          'source', o.delivery_request -> 'source',
          'checked_at', o.delivery_request -> 'checked_at'
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
      raise exception using
        errcode = '55000',
        message = '034 cannot find the existing wrapped order projection';
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
    raise exception using
      errcode = '55000',
      message = '034 found an unrecognized order projection; review it before applying';
  end if;

  if pg_catalog.strpos(v_before, v_anchor || v_addition) > 0 then
    -- Rerunning this exact migration must not duplicate projection keys.
    v_after := v_before;
  else
    if pg_catalog.strpos(v_before, '''invoice_fulfillment''') > 0
       or pg_catalog.strpos(v_before, '''delivery_request''') > 0 then
      raise exception using
        errcode = '55000',
        message = '034 found different delivery metadata; review it before applying';
    end if;
    v_after := pg_catalog.replace(v_before, v_anchor, v_anchor || v_addition);
    if pg_catalog.replace(v_after, v_anchor || v_addition, v_anchor) <> v_before then
      raise exception using
        errcode = '55000',
        message = '034 refused to change code outside the operational projection';
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
      message = '034 assertion failed: function privileges or settings changed';
  end if;
  if v_target <> v_public
     and pg_catalog.pg_get_functiondef(v_public) <> v_public_before then
    raise exception using
      errcode = '55000',
      message = '034 assertion failed: the existing authentication wrapper changed';
  end if;
end
$projection$;

commit;

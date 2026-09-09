-- ============================================================================
-- 038_delivery_request_owner_edit_rollback.sql
-- Undo the 038 code change: drop hc_set_delivery_request and take the
-- 'location', 'contact_name' and 'contact_phone' keys back out of the
-- non-owner order projection (the exact 034
-- shape). Rerunning it is harmless.
--
-- Data is deliberately left alone. Rows already carrying location,
-- venue_before, set_by, or notified_at keep them (034's object constraint
-- allows any keys), and a venue that mirrors an owner location stays as it
-- is. Rewriting customer rows needs its own reviewed script and Sidd's
-- explicit approval. Jarvis keeps skipping the address fields of rows whose
-- delivery_request still carries a location.
-- ============================================================================

begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';

drop function if exists public.hc_set_delivery_request(uuid, text, text, date, text, text);

-- Reverse the 038 projection patch on whichever function carries the body
-- (the public function, or the 028 backing implementation when the optional
-- owner-MFA wrapper is installed). Missing addition = nothing to undo.
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
  v_anchor constant text := $anchor$'checked_at', o.delivery_request -> 'checked_at'$anchor$;
  v_addition constant text := $addition$,
          'location', o.delivery_request -> 'location',
          'contact_name', o.delivery_request -> 'contact_name',
          'contact_phone', o.delivery_request -> 'contact_phone'$addition$;
begin
  if v_public is null then
    -- No projection installed at all: nothing to restore.
    return;
  end if;

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
        message = '038 rollback cannot find the existing wrapped order projection';
    end if;
  end if;

  v_before := pg_catalog.pg_get_functiondef(v_target);
  if pg_catalog.strpos(v_before, v_anchor || v_addition) = 0 then
    -- Already the 034 shape.
    return;
  end if;

  select proacl, proowner, prosecdef, proconfig
  into v_acl, v_owner, v_security_definer, v_config
  from pg_catalog.pg_proc where oid = v_target;

  v_after := pg_catalog.replace(v_before, v_anchor || v_addition, v_anchor);
  if pg_catalog.replace(v_after, v_anchor, v_anchor || v_addition) <> v_before then
    raise exception using
      errcode = '55000',
      message = '038 rollback refused to change code outside the operational projection';
  end if;
  execute v_after;

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
      message = '038 rollback assertion failed: function privileges or settings changed';
  end if;
  if v_target <> v_public
     and pg_catalog.pg_get_functiondef(v_public) <> v_public_before then
    raise exception using
      errcode = '55000',
      message = '038 rollback assertion failed: the existing authentication wrapper changed';
  end if;
end
$projection$;

-- The 034 column comment, verbatim.
do $comment$
begin
  if exists (
    select 1 from pg_catalog.pg_attribute
    where attrelid = 'public.orders'::regclass
      and attname = 'delivery_request'
      and not attisdropped
  ) then
    comment on column public.orders.delivery_request is
      'Optional human-verified request: {date:"YYYY-MM-DD"|null,window,status:"requested"|"confirmed"|"conflict",source:"email"|"owner",checked_at,source_ref?}. No automatic email ingestion. source_ref stays owner-only. Missing or conflicting details must remain visible as unknown/conflicting.';
  end if;
end
$comment$;

do $postflight$
begin
  if pg_catalog.to_regprocedure('public.hc_set_delivery_request(uuid,text,text,date,text,text)') is not null
     or exists (
       select 1
       from pg_catalog.pg_proc as p
       where p.pronamespace = 'public'::regnamespace
         and p.proname in ('hc_list_orders_for_current_user', 'hc_list_orders_for_current_user_pre_mfa_028')
         and pg_catalog.pg_get_functiondef(p.oid) like '%''location'', o.delivery_request%'
     ) then
    raise exception using
      errcode = '55000',
      message = '038 rollback assertion failed: the owner-edit function or location projection is still present';
  end if;
end
$postflight$;

commit;

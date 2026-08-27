-- ============================================================================
-- 029_webhook_delivery_lease_renewal_fix.sql
--
-- Forward repair for migration 027. The receipt table created by migration 024
-- stores its active claim in lease_token. The renewal RPC must compare that
-- stored lease token with the public claim-token parameter before extending a
-- lease.
-- ============================================================================

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $preflight$
begin
  if pg_catalog.to_regclass('public.webhook_delivery_receipts') is null
     or pg_catalog.to_regprocedure(
       'public.hc_renew_webhook_delivery(text,text,uuid,integer)'
     ) is null
     or not exists (
       select 1
       from pg_catalog.pg_attribute as column_info
       where column_info.attrelid =
         'public.webhook_delivery_receipts'::pg_catalog.regclass
         and column_info.attname = 'lease_token'
         and column_info.attisdropped is false
     ) then
    raise exception using
      errcode = '55000',
      message = '029 requires migrations 024 and 027 with receipt lease_token';
  end if;
end
$preflight$;

create or replace function public.hc_renew_webhook_delivery(
  p_provider text,
  p_event_key text,
  p_claim_token uuid,
  p_lease_seconds integer default 300
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_updated integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using
      errcode = '42501',
      message = 'service role required';
  end if;

  if p_provider is null
     or p_provider not in ('formspree', 'quo', 'ms_graph')
     or p_event_key is null
     or p_event_key <> pg_catalog.lower(p_event_key)
     or p_event_key !~ '^[0-9a-f]{64}$'
     or p_claim_token is null
     or p_lease_seconds is null
     or p_lease_seconds < 30
     or p_lease_seconds > 900 then
    raise exception using
      errcode = '22023',
      message = 'invalid webhook renewal';
  end if;

  update public.webhook_delivery_receipts as receipt
  set lease_expires_at =
        v_now + pg_catalog.make_interval(secs => p_lease_seconds),
      last_claimed_at = v_now
  where receipt.provider = p_provider
    and receipt.event_key = p_event_key
    and receipt.delivery_state = 'processing'
    and receipt.lease_token = p_claim_token
    and receipt.lease_expires_at > v_now;

  get diagnostics v_updated = row_count;
  return v_updated = 1;
end
$function$;

revoke all on function public.hc_renew_webhook_delivery(text, text, uuid, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.hc_renew_webhook_delivery(text, text, uuid, integer)
  to service_role;

do $postflight$
declare
  v_definition text;
begin
  select pg_catalog.pg_get_functiondef(function_info.oid)
  into v_definition
  from pg_catalog.pg_proc as function_info
  where function_info.oid = pg_catalog.to_regprocedure(
    'public.hc_renew_webhook_delivery(text,text,uuid,integer)'
  )
    and function_info.prosecdef is true
    and exists (
      select 1
      from pg_catalog.unnest(function_info.proconfig) as setting(value)
      where setting.value ~ '^search_path=(|"")$'
    );

  if v_definition is null
     or v_definition not like '%receipt.lease_token = p_claim_token%'
     or v_definition like '%receipt.claim_token%'
     or pg_catalog.has_function_privilege(
       'anon',
       'public.hc_renew_webhook_delivery(text,text,uuid,integer)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.hc_renew_webhook_delivery(text,text,uuid,integer)',
       'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.hc_renew_webhook_delivery(text,text,uuid,integer)',
       'EXECUTE'
     )
     or exists (
       select 1
       from pg_catalog.pg_proc as function_acl
       cross join lateral pg_catalog.aclexplode(
         coalesce(
           function_acl.proacl,
           pg_catalog.acldefault('f', function_acl.proowner)
         )
       ) as privilege_info
       where function_acl.oid = pg_catalog.to_regprocedure(
         'public.hc_renew_webhook_delivery(text,text,uuid,integer)'
       )
         and privilege_info.grantee = 0
         and privilege_info.privilege_type = 'EXECUTE'
     ) then
    raise exception using
      errcode = '42501',
      message = '029 assertion failed: receipt lease renewal repair is incomplete';
  end if;
end
$postflight$;

commit;

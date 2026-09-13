-- Runs only after setup plus the real 019 order reader and migrations 034/035.
do $guard$
begin
  if current_database() <> 'hc_calendar_logo_rehearsal' then
    raise exception 'This fixture requires the named disposable local database';
  end if;
end
$guard$;

select public.rehearsal_assert((select bool_and(invoice_fulfillment is null and delivery_request is null and logo_asset is null) from public.orders), 'migration adds no guessed metadata');
select public.rehearsal_assert((select public is false from storage.buckets where id='order-logos'), 'logo bucket is private after apply and rerun');
select public.rehearsal_assert((select count(*)=3 from pg_policies where schemaname='storage' and tablename='objects' and policyname like 'hc_order_logos_%'), 'rerun retains exactly three logo read policies');
select public.rehearsal_assert((select count(*)=0 from pg_policies where schemaname='storage' and tablename='objects' and policyname like 'hc_order_logos_%' and cmd<>'SELECT'), 'no logo write policy exists');

update public.orders set
 invoice_fulfillment='{"source":"quickbooks","read_status":"complete","invoice_id":"fake-invoice-1","checked_at":"2026-09-06T12:00:00Z","source_updated_at":"2026-09-05T12:00:00Z","address":"Fake NY address","cracking":"cocktail","cracking_note":"Cocktail cut","delivery_date":"2026-09-10","delivery_window":"9am to 11am","source_ref":"invoice-private-ref"}',
 delivery_request='{"date":"2026-09-11","window":"10am to noon","status":"conflict","source":"email","checked_at":"2026-09-06T12:00:00Z","source_ref":"email-private-ref"}',
 logo_asset='{"status":"received","checked_at":"2026-09-06T12:00:00Z","source_received_at":"2026-09-05T12:00:00Z","source_ref":"logo-private-ref","files":[{"file_name":"front.ai","mime_type":"application/postscript","original_path":"fake-ny/front.ai","preview_path":"fake-ny/front.png","usage":"Coconut front","source_ref":"file-private-ref"},{"file_name":"back.svg","mime_type":"image/svg+xml","original_path":"fake-ny/back.svg","preview_path":"fake-ny/back.png","usage":"Coconut back"}]}'
where id='30000000-0000-4000-8000-000000000001';
update public.orders set logo_asset='{"files":[{"original_path":"fake-miami/logo.pdf"}]}' where id='30000000-0000-4000-8000-000000000002';
update public.orders set logo_asset='{"files":[{"original_path":"fake-unassigned/logo.png"}]}' where id='30000000-0000-4000-8000-000000000003';
update public.orders set logo_asset='{"files":{"original_path":"bad-shape.png"}}' where id='30000000-0000-4000-8000-000000000005';
insert into storage.objects(bucket_id,name) values
('order-logos','fake-ny/front.ai'),('order-logos','fake-ny/front.png'),
('order-logos','fake-ny/back.svg'),('order-logos','fake-ny/back.png'),
('order-logos','fake-ny/unselected.png'),('order-logos','fake-miami/logo.pdf'),
('order-logos','fake-unassigned/logo.png'),('order-logos','bad-shape.png');

do $constraints$
begin
  begin
    update public.orders set logo_asset='[]' where id='30000000-0000-4000-8000-000000000001';
    raise exception 'array logo metadata incorrectly accepted';
  exception when check_violation then null; end;
  begin
    update public.orders set invoice_fulfillment='"invalid"' where id='30000000-0000-4000-8000-000000000001';
    raise exception 'scalar invoice metadata incorrectly accepted';
  exception when check_violation then null; end;
  begin
    update public.orders set delivery_request='false' where id='30000000-0000-4000-8000-000000000001';
    raise exception 'boolean request metadata incorrectly accepted';
  exception when check_violation then null; end;
  raise notice 'PASS: all three metadata object constraints reject nonobjects';
end
$constraints$;

set role authenticated;
set request.jwt.claim.sub='20000000-0000-4000-8000-000000000001';
select public.rehearsal_assert((select count(*)=5 from public.hc_list_orders_for_current_user()), 'owner sees orders across every market');
select public.rehearsal_assert((select count(*)=6 from storage.objects where bucket_id='order-logos'), 'owner reads selected logos globally including unassigned market');
select public.rehearsal_assert(not public.hc_can_read_order_logo('fake-ny/unselected.png'), 'unselected object is denied even to owner');
select public.rehearsal_assert(not public.hc_can_read_order_logo('bad-shape.png'), 'malformed files shape is safely denied');
select public.rehearsal_assert((select payload #>> '{logo_asset,source_ref}'='logo-private-ref' from public.hc_list_orders_for_current_user() as projection(payload) where payload->>'id'='30000000-0000-4000-8000-000000000001'), 'owner retains selected source reference');

set request.jwt.claim.sub='20000000-0000-4000-8000-000000000002';
select public.rehearsal_assert((select count(*)=3 from public.hc_list_orders_for_current_user()), 'manager reads exact normalized market only');
select public.rehearsal_assert((select count(*)=4 from storage.objects where bucket_id='order-logos'), 'manager gets both NY originals and both previews');
select public.rehearsal_assert((select count(*)=1 from storage.objects where bucket_id='existing-private'), 'unrelated bucket old access stays unchanged');
select public.rehearsal_assert(not public.hc_can_read_order_logo('fake-miami/logo.pdf') and not public.hc_can_read_order_logo('fake-unassigned/logo.png'), 'manager cannot read foreign or unassigned order logos');
select public.rehearsal_assert((select payload::text not like '%private-ref%' and not(payload ? 'client_email') and not(payload ? 'total_cents') and not(payload ? 'external_invoice_id') from public.hc_list_orders_for_current_user() as projection(payload) where payload->>'id'='30000000-0000-4000-8000-000000000001'), 'nonowner projection hides private refs at every level plus contacts and money');
select public.rehearsal_assert((select payload #>> '{logo_asset,files,0,usage}'='Coconut front' and payload #>> '{logo_asset,files,1,usage}'='Coconut back' and payload #>> '{invoice_fulfillment,read_status}'='complete' and payload #>> '{delivery_request,status}'='conflict' from public.hc_list_orders_for_current_user() as projection(payload) where payload->>'id'='30000000-0000-4000-8000-000000000001'), 'safe details and ordered multiple logo usages survive projection');
select public.rehearsal_assert((select payload->'delivery_at_utc'='null'::jsonb and payload->'invoice_fulfillment'='null'::jsonb and payload->'delivery_request'='null'::jsonb and payload->'logo_asset'='null'::jsonb from public.hc_list_orders_for_current_user() as projection(payload) where payload->>'id'='30000000-0000-4000-8000-000000000004'), 'missing dates and unchecked details remain null');
select public.rehearsal_assert((select payload #> '{logo_asset,files}'='[]'::jsonb from public.hc_list_orders_for_current_user() as projection(payload) where payload->>'id'='30000000-0000-4000-8000-000000000005'), 'malformed files shape projects as empty list');
select public.rehearsal_assert((select count(*)=1 from public.hc_list_orders_for_current_user('2026-09-10T00:00:00Z','2026-09-11T00:00:00Z',array['paid_full'],0,500)), 'exclusive date and stage filters are unchanged despite requested-date conflict');
select public.rehearsal_assert((select count(*)=1 from public.hc_list_orders_for_current_user(null,null,null,1,1)), 'offset and page limit still apply');

set request.jwt.claim.sub='20000000-0000-4000-8000-000000000003';
select public.rehearsal_assert((select count(*)=4 from storage.objects where bucket_id='order-logos'), 'team reads its normalized exact market');
set request.jwt.claim.sub='20000000-0000-4000-8000-000000000007';
select public.rehearsal_assert((select count(*)=1 from storage.objects where bucket_id='order-logos') and not public.hc_can_read_order_logo('fake-ny/front.ai'), 'Miami team cannot cross into NY');

do $denied_roster$
declare
  v_id text;
begin
  foreach v_id in array array[
    '', '20000000-0000-4000-8000-000000000004',
    '20000000-0000-4000-8000-000000000005',
    '20000000-0000-4000-8000-000000000006',
    '20000000-0000-4000-8000-000000000099'
  ] loop
    perform set_config('request.jwt.claim.sub', v_id, false);
    perform public.rehearsal_assert((select count(*)=0 from storage.objects where bucket_id='order-logos'), 'missing/inactive/unknown/blank-market roster denies logos: '||v_id);
    begin
      perform public.hc_list_orders_for_current_user();
      raise exception 'invalid roster incorrectly read orders';
    exception when insufficient_privilege then null; end;
  end loop;
end
$denied_roster$;

reset role;
set role anon;
set request.jwt.claim.sub='20000000-0000-4000-8000-000000000001';
select public.rehearsal_assert((select count(*)=0 from storage.objects where bucket_id='order-logos'), 'anonymous denied despite broad old policy and fake owner claim');
select public.rehearsal_assert((select count(*)=1 from storage.objects where bucket_id='existing-private'), 'anonymous unrelated-bucket behavior is unchanged');
do $anon_helper$
begin
  begin
    perform public.hc_can_read_order_logo('fake-ny/front.ai');
    raise exception 'anonymous helper execution incorrectly allowed';
  exception when insufficient_privilege then null; end;
  raise notice 'PASS: anonymous cannot execute the security-definer logo helper';
end
$anon_helper$;

reset role;
update public.orders set logo_asset=jsonb_set(logo_asset,'{files,0,original_path}','"fake-ny/replacement.ai"') where id='30000000-0000-4000-8000-000000000001';
set role authenticated;
set request.jwt.claim.sub='20000000-0000-4000-8000-000000000002';
select public.rehearsal_assert(not public.hc_can_read_order_logo('fake-ny/front.ai') and public.hc_can_read_order_logo('fake-ny/replacement.ai'), 'changing selected manifest revokes old path immediately');
reset role;
update public.field_workers set market='miami' where auth_user_id='20000000-0000-4000-8000-000000000002';
set role authenticated;
set request.jwt.claim.sub='20000000-0000-4000-8000-000000000002';
select public.rehearsal_assert(not public.hc_can_read_order_logo('fake-ny/replacement.ai'), 'market reassignment revokes prior logo access');
reset role;

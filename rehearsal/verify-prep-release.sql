-- Read-only verification of approved 036 and 037 on the HC production project.
select jsonb_agg(to_jsonb(verified) order by kind,name) as results from (
select 'table' as kind, c.relname as name,
  jsonb_build_object('row_security', c.relrowsecurity,
    'anon_direct_access', has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE'),
    'staff_direct_access', has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE')) as checks
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relname in
 ('order_prep_state','order_prep_photos','order_prep_audit','order_production_plans',
  'order_production_boxes','order_box_photos','order_box_audit')
union all
select 'bucket', id, jsonb_build_object('public', public, 'size_limit', file_size_limit,
  'mime_types', allowed_mime_types)
from storage.buckets where id in ('order-prep-media','order-box-media')
union all
select 'function', p.proname,
  jsonb_build_object('anonymous_execute',has_function_privilege('anon',p.oid,'EXECUTE'),
    'staff_execute',has_function_privilege('authenticated',p.oid,'EXECUTE'),
    'security_definer',p.prosecdef,'config',p.proconfig,
    'body_md5',md5(replace(p.prosrc,E'\r\n',E'\n')))
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in
 ('hc_can_access_order_prep','hc_order_prep_artwork_identity','hc_get_order_prep_state',
  'hc_save_order_prep_state','hc_reserve_order_prep_photo','hc_finish_order_prep_photo',
  'hc_can_access_order_prep_photo','hc_order_box_photo_valid','hc_get_order_box_progress',
  'hc_save_order_production_plan','hc_reserve_order_box_photo','hc_finish_order_box_photo',
  'hc_set_order_box_loaded','hc_mark_order_loaded','hc_void_order_production_box','hc_can_access_order_box_photo')
) verified;

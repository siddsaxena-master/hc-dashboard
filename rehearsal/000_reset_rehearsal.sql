-- ============================================================================
-- SANDBOX ONLY: 000_reset_rehearsal.sql
--
-- Exact target: hc-field-rehearsal, project ref gfbtxfwavninuapjzksk.
-- Never run this file against production. It intentionally removes the prior
-- HC Field rehearsal objects so the complete migration chain can start again.
-- It preserves the one rehearsal Auth user, the public schema itself, its ACL,
-- its schema-specific default privileges, and every extension-owned object.
-- ============================================================================

begin;

set local lock_timeout = '5s';
set local statement_timeout = '5min';
set local search_path = pg_catalog, pg_temp;

-- The snapshots live only in pg_temp. They let the final block prove that the
-- reset did not replace public or change its access/default-privilege state.
create temporary table hc_reset_public_schema_before on commit drop as
select
  namespace.oid,
  namespace.nspowner,
  namespace.nspacl
from pg_catalog.pg_namespace as namespace
where namespace.nspname = 'public';

create temporary table hc_reset_public_defaults_before on commit drop as
select
  default_acl.defaclrole,
  default_acl.defaclobjtype,
  default_acl.defaclacl
from pg_catalog.pg_default_acl as default_acl
where default_acl.defaclnamespace = 'public'::pg_catalog.regnamespace;

create temporary table hc_reset_auth_user_before on commit drop as
select
  auth_user.id,
  pg_catalog.lower(auth_user.email) as email,
  auth_user.email_confirmed_at
from auth.users as auth_user;

create temporary table hc_reset_public_extensions_before on commit drop as
select
  dependency.classid,
  dependency.objid,
  dependency.objsubid
from pg_catalog.pg_depend as dependency
join pg_catalog.pg_extension as extension_row
  on extension_row.oid = dependency.refobjid
join pg_catalog.pg_class as relation
  on dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
 and relation.oid = dependency.objid
join pg_catalog.pg_namespace as namespace
  on namespace.oid = relation.relnamespace
where dependency.refclassid =
      'pg_catalog.pg_extension'::pg_catalog.regclass
  and dependency.deptype = 'e'
  and namespace.nspname = 'public'
union all
select
  dependency.classid,
  dependency.objid,
  dependency.objsubid
from pg_catalog.pg_depend as dependency
join pg_catalog.pg_extension as extension_row
  on extension_row.oid = dependency.refobjid
join pg_catalog.pg_proc as routine
  on dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
 and routine.oid = dependency.objid
join pg_catalog.pg_namespace as namespace
  on namespace.oid = routine.pronamespace
where dependency.refclassid =
      'pg_catalog.pg_extension'::pg_catalog.regclass
  and dependency.deptype = 'e'
  and namespace.nspname = 'public'
union all
select
  dependency.classid,
  dependency.objid,
  dependency.objsubid
from pg_catalog.pg_depend as dependency
join pg_catalog.pg_extension as extension_row
  on extension_row.oid = dependency.refobjid
join pg_catalog.pg_type as type_entry
  on dependency.classid = 'pg_catalog.pg_type'::pg_catalog.regclass
 and type_entry.oid = dependency.objid
join pg_catalog.pg_namespace as namespace
  on namespace.oid = type_entry.typnamespace
where dependency.refclassid =
      'pg_catalog.pg_extension'::pg_catalog.regclass
  and dependency.deptype = 'e'
  and namespace.nspname = 'public';

do $sandbox_guard$
declare
  v_expected_project_ref constant text := 'gfbtxfwavninuapjzksk';
  v_sandbox_worker_id constant uuid :=
    '00000000-0000-4000-8000-000000000103'::uuid;
begin
  if (select pg_catalog.count(*) from auth.users) <> 1
     or not exists (
       select 1
       from auth.users as auth_user
       where pg_catalog.lower(auth_user.email) = 'siddsaxena@gmail.com'
         and auth_user.email_confirmed_at is not null
     ) then
    raise exception using
      errcode = '55000',
      message = pg_catalog.format(
        'SANDBOX GUARD: %s requires exactly one confirmed siddsaxena@gmail.com Auth user',
        v_expected_project_ref
      );
  end if;

  -- A first reset is allowed only after the known HC Field rehearsal tables
  -- exist. This makes a blank project or an unrelated project fail closed.
  if pg_catalog.to_regclass('public.orders') is null
     or pg_catalog.to_regclass('public.field_workers') is null
     or pg_catalog.to_regclass('public.shifts') is null
     or pg_catalog.to_regclass('public.live_activity_tokens') is null then
    raise exception using
      errcode = '55000',
      message = 'SANDBOX GUARD: expected prior HC Field rehearsal tables are missing';
  end if;

  if exists (
    select 1
    from public.field_workers as worker
    where pg_catalog.lower(worker.email) = 'siddsaxena@gmail.com'
    group by pg_catalog.lower(worker.email)
    having pg_catalog.count(*) <> 1
  ) or not exists (
    select 1
    from public.field_workers as worker
    where pg_catalog.lower(worker.email) = 'siddsaxena@gmail.com'
  ) or exists (
    select 1
    from public.field_workers as worker
    where pg_catalog.lower(worker.email) not in (
      'siddsaxena@gmail.com',
      'worker@sandbox.invalid'
    )
       or (
         pg_catalog.lower(worker.email) = 'worker@sandbox.invalid'
         and worker.id <> v_sandbox_worker_id
       )
  ) then
    raise exception using
      errcode = '55000',
      message = 'SANDBOX GUARD: unrelated field_workers rows exist';
  end if;

  -- Rehearsal order fixtures always use the reserved UUID prefix and a
  -- Sandbox client name. Any other order is treated as business data.
  if exists (
    select 1
    from public.orders as order_row
    where order_row.client_name not like 'Sandbox %'
       or order_row.id::text !~
          '^00000000-0000-4000-8000-00000000[0-9a-f]{4}$'
  ) then
    raise exception using
      errcode = '55000',
      message = 'SANDBOX GUARD: unrelated orders rows exist';
  end if;
end
$sandbox_guard$;

-- Drop schema-owned relations first. CASCADE is required for their own
-- indexes, triggers, policies, constraints, and dependent public routines.
-- The extension-membership predicate keeps extension-owned objects intact.
do $drop_public_relations$
declare
  object_row record;
  object_kind text;
begin
  for object_row in
    select relation.relname, relation.relkind
    from pg_catalog.pg_class as relation
    join pg_catalog.pg_namespace as namespace
      on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relkind in ('v', 'm', 'f', 'r', 'p', 'S', 'c')
      and not exists (
        select 1
        from pg_catalog.pg_depend as dependency
        join pg_catalog.pg_extension as extension_row
          on extension_row.oid = dependency.refobjid
        where dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
          and dependency.objid = relation.oid
          and dependency.refclassid =
              'pg_catalog.pg_extension'::pg_catalog.regclass
          and dependency.deptype = 'e'
      )
    order by case relation.relkind
      when 'v' then 1
      when 'm' then 2
      when 'f' then 3
      when 'r' then 4
      when 'p' then 4
      when 'S' then 5
      when 'c' then 6
    end,
    relation.relname
  loop
    object_kind := case object_row.relkind
      when 'v' then 'view'
      when 'm' then 'materialized view'
      when 'f' then 'foreign table'
      when 'r' then 'table'
      when 'p' then 'table'
      when 'S' then 'sequence'
      when 'c' then 'type'
    end;

    execute pg_catalog.format(
      'drop %s if exists %I.%I cascade',
      object_kind,
      'public',
      object_row.relname
    );
  end loop;
end
$drop_public_relations$;

-- Relations may have removed some dependent routines already. IF EXISTS
-- makes this safe for every remaining overload without printing its body.
do $drop_public_routines$
declare
  routine_row record;
  routine_kind text;
begin
  for routine_row in
    select
      routine.oid,
      routine.proname,
      routine.prokind,
      pg_catalog.pg_get_function_identity_arguments(routine.oid) as arguments
    from pg_catalog.pg_proc as routine
    join pg_catalog.pg_namespace as namespace
      on namespace.oid = routine.pronamespace
    where namespace.nspname = 'public'
      and not exists (
        select 1
        from pg_catalog.pg_depend as dependency
        join pg_catalog.pg_extension as extension_row
          on extension_row.oid = dependency.refobjid
        where dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
          and dependency.objid = routine.oid
          and dependency.refclassid =
              'pg_catalog.pg_extension'::pg_catalog.regclass
          and dependency.deptype = 'e'
      )
    order by routine.proname, routine.oid
  loop
    routine_kind := case routine_row.prokind
      when 'p' then 'procedure'
      when 'a' then 'aggregate'
      else 'function'
    end;

    execute pg_catalog.format(
      'drop %s if exists %I.%I(%s) cascade',
      routine_kind,
      'public',
      routine_row.proname,
      routine_row.arguments
    );
  end loop;
end
$drop_public_routines$;

-- HC migrations currently create tables and routines, but this final type
-- pass also removes a leftover user enum/domain/range from an interrupted run.
do $drop_public_types$
declare
  type_row record;
begin
  for type_row in
    select type_entry.typname
    from pg_catalog.pg_type as type_entry
    join pg_catalog.pg_namespace as namespace
      on namespace.oid = type_entry.typnamespace
    where namespace.nspname = 'public'
      and type_entry.typrelid = 0
      and type_entry.typelem = 0
      and type_entry.typisdefined
      and not exists (
        select 1
        from pg_catalog.pg_depend as dependency
        join pg_catalog.pg_extension as extension_row
          on extension_row.oid = dependency.refobjid
        where dependency.classid = 'pg_catalog.pg_type'::pg_catalog.regclass
          and dependency.objid = type_entry.oid
          and dependency.refclassid =
              'pg_catalog.pg_extension'::pg_catalog.regclass
          and dependency.deptype = 'e'
      )
    order by type_entry.typname
  loop
    execute pg_catalog.format(
      'drop type if exists %I.%I cascade',
      'public',
      type_row.typname
    );
  end loop;
end
$drop_public_types$;

-- This schema is created only by migration 015a and deliberately contains no
-- production application surface. Remove it after its public dependents.
drop schema if exists hc_migration_private cascade;

do $sandbox_assertions$
begin
  if (select pg_catalog.count(*) from auth.users) <> 1
     or not exists (
       select 1
       from auth.users as auth_user
       join pg_temp.hc_reset_auth_user_before as before_user
         on before_user.id = auth_user.id
        and before_user.email = pg_catalog.lower(auth_user.email)
        and before_user.email_confirmed_at = auth_user.email_confirmed_at
       where before_user.email = 'siddsaxena@gmail.com'
         and auth_user.email_confirmed_at is not null
     ) then
    raise exception using
      errcode = '55000',
      message = 'SANDBOX ASSERTION: the confirmed rehearsal Auth user changed';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_namespace as namespace
    join pg_temp.hc_reset_public_schema_before as before_schema
      on before_schema.oid = namespace.oid
     and before_schema.nspowner = namespace.nspowner
     and before_schema.nspacl is not distinct from namespace.nspacl
    where namespace.nspname = 'public'
  ) then
    raise exception using
      errcode = '55000',
      message = 'SANDBOX ASSERTION: public schema ownership or ACL changed';
  end if;

  if exists (
    (
      select
        default_acl.defaclrole,
        default_acl.defaclobjtype,
        default_acl.defaclacl
      from pg_catalog.pg_default_acl as default_acl
      where default_acl.defaclnamespace = 'public'::pg_catalog.regnamespace
      except all
      select
        before_default.defaclrole,
        before_default.defaclobjtype,
        before_default.defaclacl
      from pg_temp.hc_reset_public_defaults_before as before_default
    )
    union all
    (
      select
        before_default.defaclrole,
        before_default.defaclobjtype,
        before_default.defaclacl
      from pg_temp.hc_reset_public_defaults_before as before_default
      except all
      select
        default_acl.defaclrole,
        default_acl.defaclobjtype,
        default_acl.defaclacl
      from pg_catalog.pg_default_acl as default_acl
      where default_acl.defaclnamespace = 'public'::pg_catalog.regnamespace
    )
  ) then
    raise exception using
      errcode = '55000',
      message = 'SANDBOX ASSERTION: public default privileges changed';
  end if;

  if pg_catalog.to_regnamespace('hc_migration_private') is not null then
    raise exception using
      errcode = '55000',
      message = 'SANDBOX ASSERTION: hc_migration_private still exists';
  end if;

  if exists (
    select 1
    from pg_temp.hc_reset_public_extensions_before as before_extension
    where not exists (
      select 1
      from pg_catalog.pg_depend as dependency
      where dependency.classid = before_extension.classid
        and dependency.objid = before_extension.objid
        and dependency.objsubid = before_extension.objsubid
        and dependency.refclassid =
            'pg_catalog.pg_extension'::pg_catalog.regclass
        and dependency.deptype = 'e'
    )
  ) then
    raise exception using
      errcode = '55000',
      message = 'SANDBOX ASSERTION: an extension-owned public object changed';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_class as relation
    join pg_catalog.pg_namespace as namespace
      on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relkind in ('v', 'm', 'f', 'r', 'p', 'S', 'c')
      and not exists (
        select 1
        from pg_catalog.pg_depend as dependency
        join pg_catalog.pg_extension as extension_row
          on extension_row.oid = dependency.refobjid
        where dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
          and dependency.objid = relation.oid
          and dependency.refclassid =
              'pg_catalog.pg_extension'::pg_catalog.regclass
          and dependency.deptype = 'e'
      )
  ) or exists (
    select 1
    from pg_catalog.pg_proc as routine
    join pg_catalog.pg_namespace as namespace
      on namespace.oid = routine.pronamespace
    where namespace.nspname = 'public'
      and not exists (
        select 1
        from pg_catalog.pg_depend as dependency
        join pg_catalog.pg_extension as extension_row
          on extension_row.oid = dependency.refobjid
        where dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
          and dependency.objid = routine.oid
          and dependency.refclassid =
              'pg_catalog.pg_extension'::pg_catalog.regclass
          and dependency.deptype = 'e'
      )
  ) or exists (
    select 1
    from pg_catalog.pg_type as type_entry
    join pg_catalog.pg_namespace as namespace
      on namespace.oid = type_entry.typnamespace
    where namespace.nspname = 'public'
      and type_entry.typrelid = 0
      and type_entry.typelem = 0
      and type_entry.typisdefined
      and not exists (
        select 1
        from pg_catalog.pg_depend as dependency
        join pg_catalog.pg_extension as extension_row
          on extension_row.oid = dependency.refobjid
        where dependency.classid = 'pg_catalog.pg_type'::pg_catalog.regclass
          and dependency.objid = type_entry.oid
          and dependency.refclassid =
              'pg_catalog.pg_extension'::pg_catalog.regclass
          and dependency.deptype = 'e'
      )
  ) then
    raise exception using
      errcode = '55000',
      message = 'SANDBOX ASSERTION: non-extension public objects remain';
  end if;
end
$sandbox_assertions$;

select
  'passed'::text as rehearsal_reset,
  'gfbtxfwavninuapjzksk'::text as project_ref,
  1::integer as preserved_auth_users;

commit;

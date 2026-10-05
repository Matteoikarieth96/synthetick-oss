-- SyntheTick: verify row level security and RPC privileges (read-only, idempotent).
-- Run in the Supabase SQL editor after applying db/*.sql, and again after any
-- schema change. It changes nothing.
--
-- Why: the anon key ships to every browser by design, and any signed-in user
-- holds an `authenticated` token. If a public table has RLS off, a policy lets
-- a browser role write, a function is executable by one, or a view reads past
-- RLS, anyone with that key or a free account can reach it through the REST API.
--
-- Parts 1 to 6 list problems (expected: zero rows each). The editor shows only
-- the LAST result set, so run each SELECT on its own if you want to see rows;
-- part 7 (the DO block) raises an exception, and therefore fails the script
-- loudly, when any check finds a problem.

-- 1. Tables in schema public WITHOUT row level security.
select c.relname as table_without_rls
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind in ('r', 'p')          -- ordinary and partitioned tables
  and not c.relrowsecurity
order by c.relname;

-- 2. Functions in schema public executable by anon OR authenticated.
--    Extension-owned functions (pgvector operators etc.) are ignored. The app's
--    RPCs (spend_credit, add_credit, handle_new_user, match_candidates,
--    update_asset_returns) are service-role only and must not appear here.
select p.oid::regprocedure as function_executable_by_client, r.rolname as role
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
cross join (values ('anon'::name), ('authenticated'::name)) as r(rolname)
where n.nspname = 'public'
  and has_function_privilege(r.rolname, p.oid, 'execute')
  and not exists (
    select 1 from pg_depend d
    where d.classid = 'pg_proc'::regclass
      and d.objid = p.oid
      and d.deptype = 'e'
  )
order by p.oid::regprocedure::text, r.rolname;

-- 3. SECURITY DEFINER functions in public without a pinned search_path that
--    ends in pg_temp (`set search_path = public, pg_temp`).
select p.oid::regprocedure as definer_without_safe_search_path
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.prosecdef
  and not exists (
    select 1 from unnest(coalesce(p.proconfig, '{}')) as cfg
    where cfg like 'search_path=%' and cfg like '%pg_temp'
  )
  and not exists (
    select 1 from pg_depend d
    where d.classid = 'pg_proc'::regclass
      and d.objid = p.oid
      and d.deptype = 'e'
  )
order by p.oid::regprocedure::text;

-- 4. Policies that let a browser role WRITE (insert, update, delete or all) to a
--    public table. The app writes with the service role only; its client
--    policies are read-own-row SELECTs (profiles, credit_ledger).
select pol.tablename, pol.policyname, pol.cmd, pol.roles
from pg_policies pol
where pol.schemaname = 'public'
  and pol.cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
  and pol.roles && array['public', 'anon', 'authenticated']::name[]
order by 1, 2;

-- 5. Table grants on the service-only tables whose SQL revokes the browser
--    roles (app_settings in auth_credits.sql, api_keys in api_keys.sql): anon
--    and authenticated must hold no privilege there at all. Other tables keep
--    Supabase's default grants and rely on RLS (part 1) and part 4.
--    Effective privileges (has_table_privilege), so grants through PUBLIC count.
select t.table_name, r.rolname as grantee, string_agg(pr.privilege, ', ' order by pr.privilege) as privileges
from (values ('app_settings'), ('api_keys')) as t(table_name)
cross join (values ('anon'::name), ('authenticated'::name)) as r(rolname)
cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) as pr(privilege)
where to_regclass('public.' || t.table_name) is not null
  and has_table_privilege(r.rolname, to_regclass('public.' || t.table_name)::oid, pr.privilege)
group by t.table_name, r.rolname
order by 1, 2;

-- 6. Views in public that a browser role can read and that run with their
--    owner's rights (not security_invoker): such a view reads past RLS.
select c.relname as view_bypassing_rls, r.rolname as readable_by
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
cross join (values ('anon'::name), ('authenticated'::name)) as r(rolname)
where n.nspname = 'public'
  and c.relkind in ('v', 'm')
  and has_table_privilege(r.rolname, c.oid, 'select')
  and not coalesce(
    (select bool_or(opt in ('security_invoker=true', 'security_invoker=on', 'security_invoker=1'))
       from unnest(coalesce(c.reloptions, '{}')) as opt),
    false
  )
order by 1, 2;

-- 7. Fail loudly if any check found anything.
do $$
declare
  no_rls text;
  client_fns text;
  unsafe_definers text;
  write_policies text;
  service_grants text;
  rls_views text;
begin
  select string_agg(c.relname, ', ' order by c.relname) into no_rls
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind in ('r', 'p')
    and not c.relrowsecurity;

  select string_agg(distinct p.oid::regprocedure::text || ' (' || r.rolname || ')', ', ') into client_fns
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  cross join (values ('anon'::name), ('authenticated'::name)) as r(rolname)
  where n.nspname = 'public'
    and has_function_privilege(r.rolname, p.oid, 'execute')
    and not exists (
      select 1 from pg_depend d
      where d.classid = 'pg_proc'::regclass
        and d.objid = p.oid
        and d.deptype = 'e'
    );

  select string_agg(p.oid::regprocedure::text, ', ') into unsafe_definers
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prosecdef
    and not exists (
      select 1 from unnest(coalesce(p.proconfig, '{}')) as cfg
      where cfg like 'search_path=%' and cfg like '%pg_temp'
    )
    and not exists (
      select 1 from pg_depend d
      where d.classid = 'pg_proc'::regclass
        and d.objid = p.oid
        and d.deptype = 'e'
    );

  select string_agg(pol.tablename || '.' || pol.policyname || ' (' || pol.cmd || ')', ', ') into write_policies
  from pg_policies pol
  where pol.schemaname = 'public'
    and pol.cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
    and pol.roles && array['public', 'anon', 'authenticated']::name[];

  select string_agg(distinct t.table_name || ' (' || r.rolname || ': ' || pr.privilege || ')', ', ') into service_grants
  from (values ('app_settings'), ('api_keys')) as t(table_name)
  cross join (values ('anon'::name), ('authenticated'::name)) as r(rolname)
  cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) as pr(privilege)
  where to_regclass('public.' || t.table_name) is not null
    and has_table_privilege(r.rolname, to_regclass('public.' || t.table_name)::oid, pr.privilege);

  select string_agg(distinct c.relname || ' (' || r.rolname || ')', ', ') into rls_views
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  cross join (values ('anon'::name), ('authenticated'::name)) as r(rolname)
  where n.nspname = 'public'
    and c.relkind in ('v', 'm')
    and has_table_privilege(r.rolname, c.oid, 'select')
    and not coalesce(
      (select bool_or(opt in ('security_invoker=true', 'security_invoker=on', 'security_invoker=1'))
         from unnest(coalesce(c.reloptions, '{}')) as opt),
      false
    );

  if no_rls is not null then
    raise exception 'RLS check FAILED: tables without row level security: %', no_rls;
  end if;
  if client_fns is not null then
    raise exception 'RPC check FAILED: functions executable by a browser role: %', client_fns;
  end if;
  if unsafe_definers is not null then
    raise exception 'search_path check FAILED: SECURITY DEFINER functions without "set search_path = public, pg_temp": % (re-run db/auth_credits.sql)', unsafe_definers;
  end if;
  if write_policies is not null then
    raise exception 'Policy check FAILED: policies that let a browser role write: %', write_policies;
  end if;
  if service_grants is not null then
    raise exception 'Grant check FAILED: browser roles hold privileges on service-only tables: % (re-run db/auth_credits.sql and db/api_keys.sql)', service_grants;
  end if;
  if rls_views is not null then
    raise exception 'View check FAILED: views readable by a browser role that bypass RLS (set security_invoker = true or revoke): %', rls_views;
  end if;
  raise notice 'verify-rls: OK (RLS on every public table; no function executable, no write policy, no service-only table grant and no RLS-bypassing view for anon or authenticated; definer functions pin search_path)';
end $$;

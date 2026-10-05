-- Migration 001: bootstrap admin moves from a hard-coded literal to app_settings.
-- Idempotent. Run in the Supabase SQL editor on an EXISTING deployment.
--
-- Before this change the handle_new_user() trigger promoted one hard-coded email
-- to admin on signup. After it, the address lives in app_settings (empty by
-- default). Existing admins are unaffected either way: is_admin is stored on
-- profiles, the trigger only matters for a NEW signup with that address.
--
-- Step 1: apply the new trigger function + table (safe to re-run).
--   Run the whole of db/auth_credits.sql.
--
-- Step 2: preserve the old behaviour for your deployment. Keep your address out
-- of git: run this in the SQL editor only, with your own value.
--
--   insert into app_settings (key, value) values ('admin_email', '<you@example.com>')
--   on conflict (key) do update set value = excluded.value, updated_at = now();
--
-- Step 3 (optional): confirm the current admins are intact.
--
--   select email, is_admin from profiles where is_admin;
--
-- Step 4: re-run db/verify-rls.sql and expect "verify-rls: OK".

create table if not exists app_settings (
  key        text primary key,
  value      text not null default '',
  updated_at timestamptz not null default now()
);
alter table app_settings enable row level security;
revoke all on app_settings from anon, authenticated;
insert into app_settings (key, value) values ('admin_email', '')
on conflict (key) do nothing;

do $$
begin
  if exists (select 1 from app_settings where key = 'admin_email' and value = '') then
    raise notice 'app_settings.admin_email is empty: no signup will be auto-promoted (see Step 2 above).';
  end if;
end $$;

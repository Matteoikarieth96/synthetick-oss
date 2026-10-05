-- SyntheTick beta — auth profiles + daily credit system (spec §12)
-- Run once in the Supabase SQL editor. Idempotent.
--
-- Model: every user gets `daily_cap` credits per day (default 10), refreshed
-- lazily at first use each UTC day. A search costs 1 credit, a PDF download
-- costs 1 credit. Admin grants add to TODAY's balance only (the next daily
-- reset overwrites to daily_cap); permanent changes go through daily_cap.
-- All writes happen server-side via the service role; the RPCs are revoked
-- from anon/authenticated so clients can never mint credits.
--
-- ADMIN BOOTSTRAP. Nobody is admin by default (forks get no auto-admin). Pick ONE:
--   a) after your first sign-in, run once in the SQL editor:
--        update profiles set is_admin = true where email = '<you@example.com>';
--   b) before you sign in, store the address that the signup trigger promotes:
--        insert into app_settings (key, value) values ('admin_email', '<you@example.com>')
--        on conflict (key) do update set value = excluded.value;
-- Emptying the value turns auto-promotion off again. Existing deployment: see
-- db/migrations/001_admin_email_setting.sql.

-- profiles --------------------------------------------------------------------
create table if not exists profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  email        text not null default '',
  credits      int  not null default 10,   -- remaining today
  daily_cap    int  not null default 10,   -- refreshed to this at first use each UTC day
  credits_date date not null default current_date,  -- day `credits` refers to (UTC)
  is_admin     boolean not null default false,
  created_at   timestamptz not null default now()
);

-- credit_ledger ---------------------------------------------------------------
create table if not exists credit_ledger (
  id            bigserial primary key,
  user_id       uuid not null references auth.users(id) on delete cascade,
  delta         int  not null,
  reason        text not null check (reason in
                  ('signup','search','pdf','refund','daily_reset','admin_grant','admin_set')),
  balance_after int  not null,
  created_at    timestamptz not null default now()
);
create index if not exists credit_ledger_user_idx on credit_ledger (user_id, created_at desc);

-- RLS: clients may read their own rows; only the service role writes ----------
alter table profiles enable row level security;
alter table credit_ledger enable row level security;
drop policy if exists "read own profile" on profiles;
create policy "read own profile" on profiles for select using (auth.uid() = id);
drop policy if exists "read own ledger" on credit_ledger;
create policy "read own ledger" on credit_ledger for select using (auth.uid() = user_id);

-- app_settings: tiny key/value config read by the signup trigger -------------
-- RLS on with NO client policies: only the service role (and the SECURITY
-- DEFINER trigger below, which runs as the table owner) can read or write it.
create table if not exists app_settings (
  key        text primary key,
  value      text not null default '',
  updated_at timestamptz not null default now()
);
alter table app_settings enable row level security;
revoke all on app_settings from anon, authenticated;
-- Empty by default: no bootstrap admin until the operator sets one.
insert into app_settings (key, value) values ('admin_email', '')
on conflict (key) do nothing;

-- signup trigger: auto-create the profile on first Google sign-in -------------
create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into profiles (id, email, is_admin)
  values (
    new.id,
    coalesce(new.email, ''),
    -- bootstrap admin: only when app_settings.admin_email is set (non-empty)
    -- and matches this signup, case-insensitively
    exists (
      select 1 from app_settings s
      where s.key = 'admin_email'
        and s.value <> ''
        and lower(s.value) = lower(coalesce(new.email, ''))
    )
  )
  on conflict (id) do nothing;
  insert into credit_ledger (user_id, delta, reason, balance_after)
  values (new.id, 10, 'signup', 10);
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users for each row execute function handle_new_user();

-- spend_credit: atomic lazy daily reset + check-and-decrement -----------------
-- p_amount 0 = peek (reset if new day, report balance, no ledger row).
-- Returns {ok, credits, cap}; ok=false means insufficient credits (no charge).
-- A negative amount is refused: spending must never mint credits (grants and
-- refunds go through add_credit, which records its own reason).
create or replace function spend_credit(p_user uuid, p_amount int, p_reason text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v profiles;
begin
  if p_amount is null or p_amount < 0 then
    raise exception 'spend_credit: amount must be zero or positive (got %)', p_amount;
  end if;
  select * into v from profiles where id = p_user for update;
  if not found then
    -- Defensive: users created before the trigger existed.
    insert into profiles (id) values (p_user)
    on conflict (id) do nothing;
    select * into v from profiles where id = p_user for update;
  end if;
  if v.credits_date < current_date then
    update profiles set credits = daily_cap, credits_date = current_date
    where id = p_user returning * into v;
  end if;
  if p_amount > 0 and v.credits < p_amount then
    return jsonb_build_object('ok', false, 'credits', v.credits, 'cap', v.daily_cap);
  end if;
  if p_amount <> 0 then
    update profiles set credits = credits - p_amount where id = p_user returning * into v;
    insert into credit_ledger (user_id, delta, reason, balance_after)
    values (p_user, -p_amount, p_reason, v.credits);
  end if;
  return jsonb_build_object('ok', true, 'credits', v.credits, 'cap', v.daily_cap);
end $$;

-- add_credit: admin grants and error refunds (today's balance only) -----------
-- Negative p_amount revokes; balance floors at 0.
create or replace function add_credit(p_user uuid, p_amount int, p_reason text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v profiles;
begin
  select * into v from profiles where id = p_user for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'no such user');
  end if;
  if v.credits_date < current_date then
    update profiles set credits = daily_cap, credits_date = current_date
    where id = p_user returning * into v;
  end if;
  update profiles set credits = greatest(0, credits + p_amount)
  where id = p_user returning * into v;
  insert into credit_ledger (user_id, delta, reason, balance_after)
  values (p_user, p_amount, p_reason, v.credits);
  return jsonb_build_object('ok', true, 'credits', v.credits, 'cap', v.daily_cap);
end $$;

-- SECURITY DEFINER functions run as their owner, so each one pins its
-- search_path to public, pg_temp (pg_temp LAST): no object a caller creates in
-- a temporary schema can shadow the tables these functions write.

-- Service-role only: clients must never call the credit RPCs directly ---------
revoke execute on function spend_credit(uuid, int, text) from public, anon, authenticated;
revoke execute on function add_credit(uuid, int, text) from public, anon, authenticated;
revoke execute on function handle_new_user() from public, anon, authenticated;

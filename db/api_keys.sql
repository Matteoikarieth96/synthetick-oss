-- SyntheTick — personal API keys for the public API and MCP (spec §13)
-- Run once in the Supabase SQL editor. Idempotent.
--
-- A key belongs to a signed-in user and spends that user's daily credits.
-- The server stores only the SHA-256 hash of the full key (stk_…); key_prefix
-- (first 12 chars) is what the management UI lists. Revocation is a timestamp,
-- never a delete, so last_used_at history survives. Deleting the auth user
-- deletes their keys with them.

create table if not exists api_keys (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  name         text not null default '',    -- capped server-side at 60 chars
  key_hash     text not null unique,        -- sha256 hex of the full stk_ key
  key_prefix   text not null,               -- first 12 chars, for display only
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
create index if not exists api_keys_user_idx on api_keys (user_id, created_at desc);

-- RLS on with no policies: only the service role can read or write.
alter table api_keys enable row level security;
-- Second layer: the browser roles hold no privileges on the key table at all
-- (Supabase grants every public table to anon and authenticated by default).
-- The service role keeps its own grant. Checked by db/verify-rls.sql part 5.
revoke all on api_keys from anon, authenticated;

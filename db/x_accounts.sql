-- SyntheTick — X (Twitter) account links for the X bot (spec §14, PR 1)
-- Run once in the Supabase SQL editor. Idempotent.
--
-- A row maps one X identity onto one SyntheTick account: the bot resolves a
-- mention's author x_user_id to the user whose credits the reply spends.
-- user_id as primary key = one X account per user; the unique x_user_id =
-- one user per X account. Re-linking replaces the row (upsert on user_id).
-- Deleting the auth user deletes the link with them.

create table if not exists x_accounts (
  user_id   uuid primary key references auth.users(id) on delete cascade,
  x_user_id text not null unique,   -- X's numeric user id, as text
  x_handle  text not null,          -- @handle at link time, display only
  linked_at timestamptz not null default now()
);

-- RLS on with no policies: only the service role can read or write.
alter table x_accounts enable row level security;

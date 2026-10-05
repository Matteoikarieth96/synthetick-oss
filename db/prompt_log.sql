-- SyntheTick beta — research prompt log (user decision 2026-07-15)
-- Run once in the Supabase SQL editor. Idempotent.
--
-- Stores the text each signed-in user submits to start a research (the typed
-- prompt plus any text extracted from their sources — never the files
-- themselves, which are not stored anywhere). One row per /api/thesis call,
-- written server-side with the service role; clients have no access at all.
-- Deleting the auth user deletes their prompts with them.

create table if not exists prompt_log (
  id         bigserial primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  email      text not null default '',
  prompt     text not null,               -- capped server-side at 20k chars (excerpt)
  created_at timestamptz not null default now()
);
create index if not exists prompt_log_user_idx on prompt_log (user_id, created_at desc);

-- RLS on with no policies: only the service role can read or write.
alter table prompt_log enable row level security;

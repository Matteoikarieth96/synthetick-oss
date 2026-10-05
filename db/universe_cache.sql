-- Universe last-good vendor snapshots (spec §16.1 freshness model, 2026-07-31)
-- Run once in the Supabase SQL editor. Idempotent.
--
-- One row per cache family (key e.g. 'robinhood:dex'), written server-side
-- with the service role after a successful vendor fetch (throttled) and read
-- once at boot. A boot/outage fallback so users never see empty onchain
-- columns — NOT a history table; each write overwrites the previous snapshot.

create table if not exists universe_cache (
  key        text primary key,
  payload    jsonb not null,
  updated_at timestamptz not null default now()
);

alter table universe_cache enable row level security;
-- No policies: only the service role (which bypasses RLS) touches this table.

-- SyntheTick — X bot worker state (spec §14, PR 3)
-- Run once in the Supabase SQL editor. Idempotent.
--
-- bot_state holds the mentions since_id watermark (and any future cursors).
-- bot_replies is the idempotency ledger: one row per mention the bot has
-- handled, inserted BEFORE the reply is posted (claim-first), so a crashed
-- worker can drop at most one reply but never double-reply or double-charge.
-- kind 'ignored' = claimed without replying (unlinked author already got
-- today's pointer reply).

create table if not exists bot_state (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);

create table if not exists bot_replies (
  mention_id  text primary key,     -- the mention tweet id we handled
  author_x_id text not null,        -- who tagged the bot
  kind        text not null check (kind in ('assets','unlinked','no_credits','error','ignored')),
  created_at  timestamptz not null default now()
);
create index if not exists bot_replies_author_idx on bot_replies (author_x_id, created_at desc);

-- RLS on with no policies: only the service role can read or write.
alter table bot_state enable row level security;
alter table bot_replies enable row level security;

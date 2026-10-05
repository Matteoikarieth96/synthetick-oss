-- SyntheTick v4 — database schema (spec §3)
-- Source of truth: signal-desk-v4-spec.md §3. If this diverges from the spec,
-- update the spec first, then this file.

-- Extensions -----------------------------------------------------------------
create extension if not exists vector;      -- pgvector: embeddings + hnsw index

-- assets ---------------------------------------------------------------------
create table if not exists assets (
  id            bigserial primary key,
  ticker        text not null,             -- display symbol (AAPL, ETH, ASML.AS; private: slug uppercased)
  vendor_id     text not null,             -- FMP symbol (Yahoo-style), CoinGecko id, or Sacra company domain (unique per source)
  source        text not null,             -- 'fmp' | 'coingecko' | 'sacra' ('eodhd' = legacy rows, retired after FMP backfill)
  name          text not null,
  kind          text not null check (kind in ('stock','etf','bond','crypto','private')),
  region        text not null check (region in ('us','eu','cn','other','global')),
  exchange      text,                      -- primary listing (stocks/ETFs/bonds)
  cex_venues    text[] default '{}',       -- crypto: Binance, Coinbase, Kraken…
  dex_venues    text[] default '{}',       -- crypto: Uniswap v3 (Ethereum), Aerodrome (Base)…
  cap_class     text check (cap_class in ('mega','large','mid','small','micro')),
  market_cap_usd numeric,                  -- ALWAYS USD (converted at ingestion, §4.1c); private: latest est. valuation (§4.2b)
  volume_24h_usd numeric,                  -- CoinGecko total_volume (24h, USD); crypto only, null for equities (§5.2 liquidity screen)
  isin          text,                      -- dedup key for cross-listed equities (§4.1b)
  listings      jsonb default '[]',        -- secondary listings: [{exchange, ticker, currency}]
  accessibility text default 'open'
                check (accessibility in ('open','restricted')),  -- 'restricted' = A-shares etc., excluded by default (§4.1a)
  sector        text,                      -- GICS sector / CoinGecko primary category
  industry      text,
  categories    text[] default '{}',       -- tags: 'AI', 'Layer 2', 'uranium', 'UCITS'…
  description   text,                      -- the text that gets embedded
  etf_portfolio jsonb,                      -- ETFs/bond ETFs: holdings + breakdowns from EODHD; null = no vendor data
  website_url   text,                       -- project/company own site (CoinGecko homepage / EODHD WebURL); null = no vendor data
  logo_url      text,                       -- vendor-hosted logo image (spec §5.6b); null = no vendor logo
  enrichment    text,                       -- LLM+web thematic context appended to the embed text (spec §4.3b); null = not enriched
  is_active     boolean default true,      -- delisted/dead assets flip false, never deleted
  currency      text,
  updated_at    timestamptz default now(),
  unique (source, vendor_id)
);
alter table assets add column if not exists etf_portfolio jsonb;
-- One truthful empty state (null = no vendor data): the column briefly shipped
-- with default '{}', which hides defaulted rows from `is null` queries.
-- Idempotent — run once in the Supabase SQL editor on already-migrated DBs.
alter table assets alter column etf_portfolio drop default;
update assets set etf_portfolio = null where etf_portfolio = '{}'::jsonb;
-- Project/company website (spec §5.6b). Nullable, backward-compatible; fills in
-- as the nightly crypto-detail and equity-fundamentals refresh cycles re-crawl.
-- Run once in the Supabase SQL editor.
alter table assets add column if not exists website_url text;
-- Crypto 24h trading volume (spec §5.2 liquidity screen). Nullable, backward-compatible;
-- backfills as the nightly crypto ingest re-crawls CoinGecko total_volume.
-- Run once in the Supabase SQL editor on already-migrated DBs.
alter table assets add column if not exists volume_24h_usd numeric;
-- Thematic enrichment (spec §4.3b): dense LLM+web context appended to the embed
-- text so mega-caps/base-layer assets connect to theses that never name them.
-- Nullable, additive; null the column + re-embed to fully revert. Run once.
alter table assets add column if not exists enrichment text;
-- Vendor logo URL (spec §5.6b, 2026-07-13): FMP profile.image (skipped when
-- defaultImage=true) / CoinGecko markets image. Nullable, backward-compatible;
-- crypto backfills via `npm run backfill:logos`, equities fill over the nightly
-- profile re-crawl (~6-day cycle). Run once in the Supabase SQL editor.
alter table assets add column if not exists logo_url text;
-- Pre-IPO privates from the Sacra watchlist (spec §4.2b): kind='private'.
-- Postgres cannot alter a check constraint in place — drop + re-add (idempotent
-- via the drop-if-exists). Run once in the Supabase SQL editor.
alter table assets drop constraint if exists assets_kind_check;
alter table assets add constraint assets_kind_check
  check (kind in ('stock','etf','bond','crypto','private'));
create index if not exists assets_kind_region_cap_idx
  on assets (kind, region, cap_class) where is_active;
create index if not exists assets_categories_gin_idx
  on assets using gin (categories);

-- asset_embeddings -----------------------------------------------------------
create table if not exists asset_embeddings (
  asset_id   bigint primary key references assets(id) on delete cascade,
  embedding  vector(512),                  -- voyage-3-lite dimension
  model      text not null,
  updated_at timestamptz default now()
);
create index if not exists asset_embeddings_hnsw_idx
  on asset_embeddings using hnsw (embedding vector_cosine_ops);

-- Row level security -----------------------------------------------------------
-- RLS ON with NO client policies: only the service role (which bypasses RLS)
-- reads or writes these tables. Without this, anyone holding the public anon
-- key could read (licensed vendor data in private_data/enrichment) and write
-- (poison the screening universe) both tables. Idempotent. Verify any
-- deployment with db/verify-rls.sql.
alter table assets enable row level security;
alter table asset_embeddings enable row level security;

-- Notes:
-- kind='bond' = bond ETFs and sovereign-benchmark ETFs only, identified at
-- ingestion by EODHD ETF category containing bond/fixed-income/treasury/gilt
-- (categories gets 'bond-etf'). See spec §3 trailing note and §4.1.

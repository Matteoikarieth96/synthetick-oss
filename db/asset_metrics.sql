-- SyntheTick — quantitative metrics store for data queries (spec §15.1)
-- Run once in the Supabase SQL editor. Idempotent.
--
-- Both tables are DERIVED: every value is rewritten by the nightly bulk ingest
-- (ingest/run-metrics.ts) from FMP whole-market files. They are a cache, never
-- a source of truth — dropping them costs one ingest run, not data. Every
-- metric column is nullable: a vendor that does not compute a ratio for a line
-- leaves it null, and the query engine reports the gap rather than hiding it
-- (spec §15.5). Deleting an asset deletes its metrics and price history.

-- asset_metrics --------------------------------------------------------------
-- One row per asset, refreshed nightly.
create table if not exists asset_metrics (
  asset_id            bigint primary key references assets(id) on delete cascade,

  -- valuation (FMP ratios-ttm-bulk + key-metrics-ttm-bulk)
  pe                  numeric,   -- price / earnings, TTM
  peg                 numeric,
  forward_pe          numeric,
  price_to_sales      numeric,
  price_to_book       numeric,
  ev_to_ebitda        numeric,
  ev_to_sales         numeric,
  dividend_yield_pct  numeric,   -- percent, already x100 (vendor sends a fraction)
  market_cap_usd      numeric,   -- mirrored from assets so ranking hits one table

  -- performance (computed from asset_prices; volume from profile-bulk)
  return_1d_pct       numeric,
  return_7d_pct       numeric,
  return_30d_pct      numeric,
  return_ytd_pct      numeric,
  return_1y_pct       numeric,
  volume              numeric,   -- latest session volume, shares
  avg_volume          numeric,   -- vendor average daily volume, shares
  beta                numeric,

  -- profitability & leverage (ratios-ttm-bulk, key-metrics-ttm-bulk, scores-bulk)
  gross_margin_pct    numeric,   -- percent, already x100
  operating_margin_pct numeric,
  net_margin_pct      numeric,
  roe                 numeric,   -- return on equity, fraction (0.21 = 21%)
  roa                 numeric,
  roic                numeric,
  debt_to_equity      numeric,
  current_ratio       numeric,
  interest_coverage   numeric,
  altman_z            numeric,
  piotroski           integer,

  -- growth (financial-growth-bulk)
  revenue_growth_pct  numeric,   -- percent, year over year
  earnings_growth_pct numeric,
  fcf_growth_pct      numeric,
  revenue_cagr_3y_pct numeric,
  earnings_cagr_3y_pct numeric,

  -- analyst consensus (third-party opinion — always attributed, spec §15.5)
  price_target_avg    numeric,   -- reporting currency of the vendor estimate
  target_upside_pct   numeric,   -- vs latest close, percent
  rating_consensus    text,      -- "Buy" | "Hold" | "Sell" | vendor wording
  analyst_count       integer,

  -- added 2026-07-28 for thesis requirements (spec §15.3): all three ride the
  -- bulk families the nightly job already downloads, so no extra vendor cost.
  net_debt_to_ebitda  numeric,   -- leverage requirement ("net debt/EBITDA below 3x")
  fcf_per_share       numeric,   -- sign answers "positive free cash flow"
  fcf_yield_pct       numeric,   -- percent, already x100

  as_of               date,      -- vendor data date for the ratio families
  source              text not null default 'fmp',
  updated_at          timestamptz not null default now()
);

-- Additive columns for databases migrated before 2026-07-28. Idempotent.
alter table asset_metrics add column if not exists net_debt_to_ebitda numeric;
alter table asset_metrics add column if not exists fcf_per_share numeric;
alter table asset_metrics add column if not exists fcf_yield_pct numeric;

-- Ranking indexes. Every data query filters on the cohort first (sector/region
-- via assets, kind implicitly) then orders by ONE metric, so the useful shape
-- is a partial index per rankable metric skipping the nulls that can never win
-- a ranking anyway. Only the metrics users actually rank by get one; the rest
-- ride the primary key when read as row detail.
create index if not exists asset_metrics_pe_idx
  on asset_metrics (pe) where pe is not null;
create index if not exists asset_metrics_mcap_idx
  on asset_metrics (market_cap_usd desc) where market_cap_usd is not null;
create index if not exists asset_metrics_ret30_idx
  on asset_metrics (return_30d_pct desc) where return_30d_pct is not null;
create index if not exists asset_metrics_ret1y_idx
  on asset_metrics (return_1y_pct desc) where return_1y_pct is not null;
create index if not exists asset_metrics_divy_idx
  on asset_metrics (dividend_yield_pct desc) where dividend_yield_pct is not null;
create index if not exists asset_metrics_ps_idx
  on asset_metrics (price_to_sales) where price_to_sales is not null;
create index if not exists asset_metrics_pb_idx
  on asset_metrics (price_to_book) where price_to_book is not null;
create index if not exists asset_metrics_revgrowth_idx
  on asset_metrics (revenue_growth_pct desc) where revenue_growth_pct is not null;

-- The cohort half of every query: assets is filtered by sector+region+kind
-- before the join, so give that predicate its own index (spec §15.1).
create index if not exists assets_sector_region_idx
  on assets (sector, region) where is_active;

-- asset_prices ---------------------------------------------------------------
-- Daily closes, the only source for return_*_pct. Accumulated one nightly
-- eod-bulk snapshot at a time because that endpoint is rate-limited and
-- refuses back-to-back date fetches (spec §15.2, verified 2026-07-27);
-- seeded once by ingest/backfill-prices.ts. Retention 400 days (1y returns
-- plus slack), pruned by the nightly job.
create table if not exists asset_prices (
  asset_id bigint not null references assets(id) on delete cascade,
  date     date not null,
  close    numeric not null,
  primary key (asset_id, date)
);
-- Return computation walks one asset's window; the primary key already orders
-- by (asset_id, date). The date-first index serves the nightly prune instead.
create index if not exists asset_prices_date_idx on asset_prices (date);

-- update_asset_returns(p_from, p_to) -----------------------------------------
-- Compute returns for one slice of the asset id space and write them straight
-- into asset_metrics. Returns the number of rows touched.
--
-- Two constraints shape this, both hit live on 2026-07-27:
--
-- 1. It must not return rows to the client. PostgREST caps a set-returning
--    function at its max-rows setting (1,000 here) and .range() cannot lift
--    it, so a version that SELECTed the results silently updated 1,000 of
--    13,000 assets and every "biggest 30-day gainer" came from that slice.
--
-- 2. It must be batched. asset_prices holds millions of rows, and computing
--    the whole universe in one statement exceeds the database statement
--    timeout. The id range keeps each call an index-bounded slice, so the
--    caller can walk the universe in pieces that always finish.
--
-- Windows are "the close at or before the target date", not "the close exactly
-- N days ago", so weekends, holidays and thin history shift the basis instead
-- of blanking the row. nullif guards a zero basis; a zero or negative close
-- would otherwise divide by zero or invent a percentage.
--
-- Call AFTER the ingest's own asset_metrics write, which creates the rows with
-- the return columns nulled for equities. Crypto returns come from CoinGecko
-- and are untouched here, since crypto has no asset_prices history.
create or replace function update_asset_returns(p_from bigint, p_to bigint)
returns integer
language plpgsql
as $$
declare
  touched integer;
begin
  insert into asset_metrics as m (
    asset_id, return_1d_pct, return_7d_pct, return_30d_pct, return_ytd_pct, return_1y_pct, updated_at
  )
  select
    l.asset_id,
    (l.close - prev.close) / nullif(prev.close, 0) * 100,
    (l.close - w7.close)   / nullif(w7.close, 0)   * 100,
    (l.close - w30.close)  / nullif(w30.close, 0)  * 100,
    (l.close - wytd.close) / nullif(wytd.close, 0) * 100,
    (l.close - w1y.close)  / nullif(w1y.close, 0)  * 100,
    now()
  from (
    select distinct on (p.asset_id) p.asset_id, p.date, p.close
    from asset_prices p
    where p.asset_id between p_from and p_to
    order by p.asset_id, p.date desc
  ) l
  -- The PRIOR SESSION, not "yesterday": a Monday close compares to Friday.
  left join lateral (
    select p.close from asset_prices p
    where p.asset_id = l.asset_id and p.date < l.date
    order by p.date desc limit 1
  ) prev on true
  left join lateral (
    select p.close from asset_prices p
    where p.asset_id = l.asset_id and p.date <= l.date - 7
    order by p.date desc limit 1
  ) w7 on true
  left join lateral (
    select p.close from asset_prices p
    where p.asset_id = l.asset_id and p.date <= l.date - 30
    order by p.date desc limit 1
  ) w30 on true
  left join lateral (
    select p.close from asset_prices p
    where p.asset_id = l.asset_id and p.date < date_trunc('year', l.date)::date
    order by p.date desc limit 1
  ) wytd on true
  left join lateral (
    select p.close from asset_prices p
    where p.asset_id = l.asset_id and p.date <= l.date - 365
    order by p.date desc limit 1
  ) w1y on true
  where l.close > 0
  on conflict (asset_id) do update set
    return_1d_pct  = excluded.return_1d_pct,
    return_7d_pct  = excluded.return_7d_pct,
    return_30d_pct = excluded.return_30d_pct,
    return_ytd_pct = excluded.return_ytd_pct,
    return_1y_pct  = excluded.return_1y_pct,
    updated_at     = now();
  get diagnostics touched = row_count;
  return touched;
end;
$$;

-- The earlier client-readable variants are traps (see constraint 1 above):
-- they look like they work and quietly truncate. Remove them.
drop function if exists compute_asset_returns();
drop function if exists update_asset_returns();

-- Service-role only: this function rewrites return columns for a whole id range
-- and must never be callable through the public RPC endpoint. Invoker-rights, so
-- RLS below already blocks anon writes; the revoke removes the endpoint itself.
-- The service role keeps its own explicit grant.
revoke execute on function update_asset_returns(bigint, bigint) from public, anon, authenticated;
grant execute on function update_asset_returns(bigint, bigint) to service_role;

-- RLS on with no policies: only the service role can read or write. The query
-- engine runs server-side under the service key like every other runtime path.
alter table asset_metrics enable row level security;
alter table asset_prices enable row level security;

-- SyntheTick — stored market data fallback for equities (spec §5.6).
-- Run once in the Supabase SQL editor. Idempotent.
--
-- Why: unlike the ingest data (universe, ISINs, sectors, ETF holdings) which
-- already lives in this table, the market layer is not persisted —
-- runtime/market.ts calls /stable/quote, /stable/historical-price-eod/light and
-- /stable/ratios-ttm live on every run, with only a 60s in-process cache, so a
-- failed vendor call leaves an equity card without its price, 1d/30d change,
-- sparkline, 52-week range and financials table.
--
-- This column holds one snapshot per asset, written by `npm run snapshot:market`.
-- Store only what your data license allows. It is a FALLBACK, never a cache:
-- runtime/market.ts still calls the vendor first and only reads this when the
-- call fails or no key is set. The payload therefore mirrors the live
-- MarketData shape exactly, produced by the same pure mapper, so the two paths
-- cannot drift.
--
-- Shape (the values below are placeholders, not real data):
--   {
--     "as_of": "2026-01-31",        -- when the snapshot was taken
--     "price": 100.00, "currency": "USD",
--     "change1d": 0.5, "change30d": 2.0,
--     "series": [ ...up to 30 closes, oldest first... ],
--     "yearHigh": 120.00, "yearLow": 80.00,
--     "fin": { "open": …, "prevClose": …, "dayLow": …, "dayHigh": …,
--              "volume": …, "priceAvg50": …, "priceAvg200": …,
--              "pe": …, "eps": …, "priceToSales": …, "priceToBook": …,
--              "debtToEquity": …, "dividendYieldPct": …,
--              "grossMarginPct": …, "netMarginPct": … }
--   }
--
-- Every field is nullable and absent means "no vendor data", never zero — a
-- fake 0 P/E would win every lowest-P/E ranking. Snapshot data is surfaced as
-- stale in the UI (dated series label, "snapshot" marker) so a card can never
-- present an old close as a live quote.
--
-- Additive and reversible: null the column to fall back to live-only behavior.
alter table assets add column if not exists market_snapshot jsonb;

-- Only equities carry it (crypto keeps its live CoinGecko path, pre-IPO uses
-- private_data), so the partial index stays small.
create index if not exists assets_market_snapshot_idx
  on assets using gin (market_snapshot)
  where market_snapshot is not null;

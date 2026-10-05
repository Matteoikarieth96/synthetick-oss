-- SyntheTick — stored pre-IPO series for kind='private' rows (spec §4.2b).
-- Run once in the Supabase SQL editor. Idempotent.
--
-- Filled by `npm run load:private-data` from vendor files the operator holds
-- under their own data license. Only time series are stored, never vendor news.
--
-- Shape (all keys optional; absent = no vendor data, never a fabricated zero).
-- The values below are placeholders, not real data:
--   {
--     "as_of": "2026-01-31",
--     "valuation_series":  [{"d":"2025-12-31","v":1000000000}, ...],
--     "revenue_series":    [{"d":"2025-12-31","v":100000000}, ...],
--     "revenue_growth":    [{"d":"2025-12-31","v":50.0}, ...],   -- percent
--     "price_per_share":   [{"d":"2025-12-31","v":10.0}, ...],
--     "projections":       [{"base":"trailing_revenue","scenario":"projection",
--                            "date":"2030-12-31","amount":500000000,
--                            "currency":"USD"}, ...],
--     "funding_rounds":    [{"name":"Series A","issue_price":10.0,
--                            "issued_at":"2025-12-31"}, ...],
--     "sources":           ["https://..."],
--     "dropped":           [{"d":"2026-01-15","v":1000000,"why":"..."}]
--   }
--
-- `dropped` keeps series points removed by the sanity check (for example a
-- transaction size recorded as a valuation), so the cleaning stays reviewable.
--
-- Nullable and additive: null the column to fully revert. Nothing reads it
-- unless runtime/market.ts finds it populated on a source='sacra' row.
alter table assets add column if not exists private_data jsonb;

-- Only pre-IPO rows carry it; keeps the index small and makes a stray write on
-- an equity/crypto row obvious rather than silent.
create index if not exists assets_private_data_idx
  on assets using gin (private_data)
  where private_data is not null;

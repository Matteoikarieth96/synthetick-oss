-- SyntheTick v4 — /candidates hard filter + semantic retrieval (spec §5.2).
-- Apply in the Supabase SQL editor after db/schema.sql. Re-runnable.
--
-- Hard requirements ("MUST be followed") live HERE, in SQL — the LLM never
-- gets to see assets that violate them. Region filters don't apply to crypto
-- (kind='crypto' is region-global); restricted assets (A-shares) are always
-- excluded; inactive assets never surface.

-- Return shape includes etf_portfolio as of PR #10. PostgreSQL cannot
-- create-or-replace a function when OUT columns change, so drop first.
drop function if exists match_candidates(vector,text[],text[],text[],boolean,boolean,boolean,text[],integer);
drop function if exists match_candidates(vector,text[],text[],text[],boolean,boolean,text[],integer);
drop function if exists match_candidates(vector,text[],text[],text[],boolean,text[],integer);

create or replace function match_candidates(
  thesis_embedding vector(512),
  asset_set text[] default null,      -- e.g. '{crypto}' for "only crypto"
  region_set text[] default null,     -- COARSE regions only, e.g. '{eu}' — 'it' never reaches SQL
  cap_set text[] default null,        -- e.g. '{mega,large}'
  cex_only boolean default false,     -- crypto must be listed on a CEX
  cn_hkex_only boolean default false, -- card-selected China means HKEX lines only
  italy_scope boolean default false,  -- card-selected Italy: 'Italy' category tag passes too (§6)
  exclude_tickers text[] default '{}',
  match_count int default 100
) returns table (
  id bigint,
  ticker text,
  name text,
  kind text,
  region text,
  cap_class text,
  exchange text,
  cex_venues text[],
  dex_venues text[],
  sector text,
  categories text[],
  etf_portfolio jsonb,
  volume_24h_usd numeric,
  blurb text,
  sim double precision
)
language plpgsql stable
as $$
begin
  -- HNSW recall fix: the default hnsw.ef_search=40 caps the index at 40
  -- nearest neighbors BEFORE the WHERE clause, so narrow filters ("US stocks
  -- only") post-filtered down to a handful of rows. Raise the pool and let
  -- pgvector keep scanning until the LIMIT is satisfied (pgvector ≥0.8).
  -- set_config (transaction-local) instead of function SET: the editor role
  -- lacks permission to attach these GUCs at definition time.
  perform set_config('hnsw.ef_search', '400', true);
  perform set_config('hnsw.iterative_scan', 'relaxed_order', true);
  return query
  select a.id, a.ticker, a.name, a.kind, a.region, a.cap_class, a.exchange,
         a.cex_venues, a.dex_venues, a.sector, a.categories,
         a.etf_portfolio, a.volume_24h_usd,
         left(a.description, 300) as blurb,
         1 - (e.embedding <=> thesis_embedding) as sim
  from assets a
  join asset_embeddings e on e.asset_id = a.id
  where a.is_active
    and a.accessibility = 'open'
    and (asset_set is null or a.kind = any(asset_set))
    -- Markets (§6): union across the selected coarse regions and, when Italy is
    -- selected, the 'Italy' category tag (Italy ETFs are US/IE/LU-domiciled —
    -- no region value can express them). region_set=null + italy_scope means
    -- Italy-only, NOT unconstrained.
    and (
      (region_set is null and not italy_scope)
      or a.kind = 'crypto'
      or (region_set is not null and a.region = any(region_set))
      or (italy_scope and a.categories @> array['Italy'])
    )
    -- Cap filters don't apply to funds (§5.2 2026-07-08): an ETF's cap_class
    -- bands its own AUM, not the caps of what it holds — "small-cap" in a
    -- thesis is an exposure claim, judged semantically downstream.
    and (cap_set is null or a.kind in ('etf','bond') or a.cap_class = any(cap_set))
    and (not cex_only or a.kind <> 'crypto' or cardinality(a.cex_venues) > 0)
    and (
      not cn_hkex_only or a.kind = 'crypto' or a.region <> 'cn' or
      -- FMP stores Hong Kong listings as HKSE; retain the older normalized
      -- HK/HKEX aliases for rows ingested before the FMP migration.
      upper(coalesce(a.exchange, '')) in ('HK', 'HKEX', 'HKSE')
    )
    -- Liquidity screen (§5.2): drop crypto whose 24h volume is a KNOWN value
    -- below $100k. NULL passes, so crypto keeps surfacing before the volume
    -- backfill lands. Crypto only — equities have no volume_24h_usd.
    and (a.kind <> 'crypto' or a.volume_24h_usd is null or a.volume_24h_usd >= 100000)
    and not (a.ticker = any(exclude_tickers))
  order by e.embedding <=> thesis_embedding
  limit match_count;
end;
$$;

-- Service-role only. The function is invoker-rights, so RLS on assets and
-- asset_embeddings already protects the data; the revoke removes the RPC
-- endpoint from anon/authenticated entirely (PostgREST exposes every function
-- that PUBLIC may execute). The service role keeps its own explicit grant.
-- Re-runnable: the drop+create above resets privileges, so this must stay last.
revoke execute on function match_candidates(vector,text[],text[],text[],boolean,boolean,boolean,text[],integer)
  from public, anon, authenticated;
grant execute on function match_candidates(vector,text[],text[],text[],boolean,boolean,boolean,text[],integer)
  to service_role;

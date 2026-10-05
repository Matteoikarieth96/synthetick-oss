import { createClient } from '@supabase/supabase-js';
import { env } from './env.js';
import { log } from './log.js';
import type { CapClass } from './caps.js';

export const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export interface EtfPortfolioSlice {
  name: string;
  weight: number | null;
}

export interface EtfHolding {
  symbol?: string | null;
  name: string;
  weight: number | null;
}

export interface EtfPortfolio {
  holdings_count?: number | null;
  top_holdings?: EtfHolding[];
  asset_allocation?: EtfPortfolioSlice[];
  sector_weights?: EtfPortfolioSlice[];
  region_weights?: EtfPortfolioSlice[];
  // Fund facts (spec §3, 2026-07-12) — from the same FMP etf/info call, zero
  // extra vendor cost; existing rows fill over the ~6-day refresh cycle.
  expense_ratio?: number | null; // percent units: 0.2 = 0.20% TER
  avg_volume?: number | null; // average daily volume, shares
  inception_date?: string | null; // "YYYY-MM-DD"
  nav?: number | null; // in nav_currency
  nav_currency?: string | null;
  issuer?: string | null;
  domicile?: string | null; // ISO
}

/** A row destined for the `assets` table (spec §3). */
export interface AssetRow {
  ticker: string;
  vendor_id: string;
  source: 'fmp' | 'eodhd' | 'coingecko' | 'sacra'; // 'eodhd' = retired vendor; its rows are all inactive
  name: string;
  kind: 'stock' | 'etf' | 'bond' | 'crypto' | 'private';
  region: 'us' | 'eu' | 'cn' | 'other' | 'global';
  exchange?: string | null;
  cex_venues?: string[];
  dex_venues?: string[];
  cap_class?: CapClass | null;
  market_cap_usd?: number | null;
  volume_24h_usd?: number | null; // crypto 24h trading volume, USD (CoinGecko total_volume); null for equities

  isin?: string | null;
  listings?: unknown[];
  accessibility?: 'open' | 'restricted';
  sector?: string | null;
  industry?: string | null;
  categories?: string[];
  description?: string | null;
  etf_portfolio?: EtfPortfolio | null;
  website_url?: string | null;
  logo_url?: string | null; // vendor-hosted logo image (spec §5.6b); null = no vendor logo
  enrichment?: string | null;
  is_active?: boolean;
  currency?: string | null;
}

/** Upsert assets in chunks on (source, vendor_id). Returns inserted/updated ids + vendor_ids. */
export async function upsertAssets(
  rows: AssetRow[],
  chunkSize = 500,
): Promise<{ id: number; vendor_id: string }[]> {
  const out: { id: number; vendor_id: string }[] = [];
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize).map((r) => ({ ...r, updated_at: new Date().toISOString() }));
    const { data, error } = await supabase
      .from('assets')
      .upsert(chunk, { onConflict: 'source,vendor_id' })
      .select('id, vendor_id');
    if (error) throw new Error(`upsertAssets failed at chunk ${i}: ${error.message}`);
    if (data) out.push(...(data as { id: number; vendor_id: string }[]));
  }
  return out;
}

/** Mark rows of a source whose vendor_id is not in `keepVendorIds` as inactive (§4.1 step 5). */
export async function deactivateMissing(
  source: AssetRow['source'],
  keepVendorIds: string[],
): Promise<number> {
  // Fetch active vendor_ids for this source (PAGED — Supabase caps unranged
  // selects at 1000 rows, which silently exempted every row past the first
  // page from deactivation), diff locally, flip the rest.
  const active: string[] = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    const { data, error } = await supabase
      .from('assets')
      .select('vendor_id')
      .eq('source', source)
      .eq('is_active', true)
      // Stable order: offset paging without ORDER BY can skip or repeat rows,
      // and a skipped row is a missed deactivation (review R2).
      .order('id')
      .range(from, from + page - 1);
    if (error) throw new Error(`deactivateMissing read failed: ${error.message}`);
    if (!data || data.length === 0) break;
    active.push(...data.map((r) => r.vendor_id as string));
    if (data.length < page) break;
  }
  const keep = new Set(keepVendorIds);
  const stale = active.filter((v) => !keep.has(v));
  for (let i = 0; i < stale.length; i += 500) {
    const batch = stale.slice(i, i + 500);
    const { error: uErr } = await supabase
      .from('assets')
      .update({ is_active: false })
      .eq('source', source)
      .in('vendor_id', batch);
    if (uErr) throw new Error(`deactivateMissing update failed: ${uErr.message}`);
  }
  // Embedding cleanup (§4.1 step 5, 2026-07-12): runs even when this run
  // deactivated nothing — heals strays from crash windows and other paths.
  await sweepInactiveEmbeddings();
  return stale.length;
}

/** Delete embeddings of ALL inactive assets (§4.1 step 5, 2026-07-12).
 * An inactive row's vector can never surface (§5.2 joins on is_active) but it
 * stays in the HNSW graph and slows every retrieval: the retired-EODHD backlog
 * reached 42% dead vectors and pushed match_candidates past Supabase's ~8s
 * statement timeout (live incident 2026-07-12). Sweeping everything inactive,
 * not one run's batch, makes every deactivation path self-healing (pre-IPO
 * IPO-graduation, manual cutovers). Re-activated rows re-embed via the normal
 * upsert path. NOTE: after a BULK deactivation also rebuild the graph —
 * `reindex index asset_embeddings_hnsw_idx;` — deletes leave HNSW tombstones. */
export async function sweepInactiveEmbeddings(): Promise<number> {
  let removed = 0;
  // Always re-fetch from range 0: each delete shifts the remaining result set.
  for (let guard = 0; guard < 200; guard++) {
    const { data, error } = await supabase
      .from('asset_embeddings')
      .select('asset_id, assets!inner(id)')
      .eq('assets.is_active', false)
      .order('asset_id')
      .range(0, 499);
    if (error) throw new Error(`sweepInactiveEmbeddings read failed: ${error.message}`);
    const ids = (data ?? []).map((r) => r.asset_id as number);
    if (ids.length === 0) break;
    const { error: dErr } = await supabase.from('asset_embeddings').delete().in('asset_id', ids);
    if (dErr) throw new Error(`sweepInactiveEmbeddings delete failed: ${dErr.message}`);
    removed += ids.length;
  }
  if (removed > 0) log.info(`embedding cleanup: removed ${removed} vectors of inactive assets`);
  return removed;
}

/** Exact count for a table with optional filters. */
export async function countAssets(filter?: Partial<Pick<AssetRow, 'source' | 'kind' | 'region'>>): Promise<number> {
  let q = supabase.from('assets').select('id', { count: 'exact', head: true });
  if (filter?.source) q = q.eq('source', filter.source);
  if (filter?.kind) q = q.eq('kind', filter.kind);
  if (filter?.region) q = q.eq('region', filter.region);
  const { count, error } = await q;
  if (error) throw new Error(`countAssets failed: ${error.message}`);
  return count ?? 0;
}

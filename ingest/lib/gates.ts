import { log } from './log.js';
import { supabase, type AssetRow } from './supabase.js';

/**
 * Data-quality gates (spec §4.4). Each throws to abort the run. The count and
 * field gates run BEFORE upsert so the DB is left untouched on failure; the
 * embedding gate runs after embedding.
 */
export class QualityGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QualityGateError';
  }
}

/** Pure verdict of the symbol-count gate (spec §4.4): true = the new count
 * dropped more than 20% below the previous ACTIVE count. Exported for tests. */
export function symbolCountDropped(prev: number, newCount: number): boolean {
  return prev > 0 && newCount < prev * 0.8;
}

/** Exact count of ACTIVE rows for a source. The gate must compare against the
 * active count ("vs previous run", spec §4.4), not every row ever inserted:
 * with inactive rows included the baseline only grows, and a healthy top-3000
 * crypto run would start failing once ~3750 rows had accumulated. */
async function countActive(source: AssetRow['source']): Promise<number> {
  const { count, error } = await supabase
    .from('assets')
    .select('id', { count: 'exact', head: true })
    .eq('source', source)
    .eq('is_active', true);
  if (error) throw new QualityGateError(`active count failed: ${error.message}`);
  return count ?? 0;
}

/** Abort if the new active count would drop >20% vs the previous run (§4.4). */
export async function assertSymbolCount(
  source: AssetRow['source'],
  newCount: number,
): Promise<void> {
  const prev = await countActive(source);
  if (symbolCountDropped(prev, newCount)) {
    throw new QualityGateError(
      `symbol count dropped >20%: ${source} was ${prev}, new run has ${newCount}. DB left untouched.`,
    );
  }
  log.info(`gate ok: symbol count ${newCount} vs previous ${prev} active (${source})`);
}

/**
 * Which previously-active vendor ids a COMPLETE crypto run should deactivate.
 * Conservative on purpose: returns `skip` (with the reason) instead of ids
 * when the run does not look like a full top-N snapshot, or when it would
 * retire an implausibly large share of the active rows (a vendor hiccup that
 * returned a short or shuffled list must not wipe the universe).
 *  - `fetched`   how many markets the run returned
 *  - `requested` the configured top-N
 * A run is "complete" when it returned at least 95% of what it asked for.
 * Exported for offline tests.
 */
export function planCryptoDeactivation(
  activeVendorIds: string[],
  fetchedVendorIds: string[],
  requested: number,
  maxFraction = 0.1,
): { stale: string[]; skip?: string } {
  if (fetchedVendorIds.length < requested * 0.95) {
    return { stale: [], skip: `run returned ${fetchedVendorIds.length}/${requested} markets (partial)` };
  }
  const keep = new Set(fetchedVendorIds);
  const stale = activeVendorIds.filter((v) => !keep.has(v));
  if (stale.length > Math.max(50, activeVendorIds.length * maxFraction)) {
    return {
      stale: [],
      skip: `would deactivate ${stale.length} of ${activeVendorIds.length} active rows (> ${Math.round(maxFraction * 100)}%)`,
    };
  }
  return { stale };
}

/** Abort if >5% of rows are missing kind or region (§4.4). */
export function assertFieldCoverage(rows: AssetRow[]): void {
  if (rows.length === 0) return;
  const missing = rows.filter((r) => !r.kind || !r.region).length;
  const ratio = missing / rows.length;
  if (ratio > 0.05) {
    throw new QualityGateError(
      `>5% rows missing kind/region: ${missing}/${rows.length} (${(ratio * 100).toFixed(1)}%). DB left untouched.`,
    );
  }
  log.info(`gate ok: kind/region coverage ${(100 - ratio * 100).toFixed(1)}%`);
}

/** Abort if embedding coverage of active rows for a source is <98% (§4.4). */
export async function assertEmbeddingCoverage(source: AssetRow['source']): Promise<void> {
  // ACTIVE rows only, matching the numerator below — deactivated rows keep
  // their stale embeddings by design and must not drag coverage down (spec
  // §4.4 measures coverage "of active rows").
  const { count: activeCount, error: aErr } = await supabase
    .from('assets')
    .select('id', { count: 'exact', head: true })
    .eq('source', source)
    .eq('is_active', true);
  if (aErr) throw new QualityGateError(`embedding coverage count failed: ${aErr.message}`);
  const active = activeCount ?? 0;
  if (active === 0) return;
  // Count active assets of this source that have an embedding (inner join).
  const { count, error } = await supabase
    .from('assets')
    .select('id, asset_embeddings!inner(asset_id)', { count: 'exact', head: true })
    .eq('source', source)
    .eq('is_active', true);
  if (error) throw new QualityGateError(`embedding coverage query failed: ${error.message}`);
  const embedded = count ?? 0;
  const coverage = embedded / active;
  if (coverage < 0.98) {
    throw new QualityGateError(
      `embedding coverage <98%: ${embedded}/${active} (${(coverage * 100).toFixed(1)}%) for ${source}.`,
    );
  }
  log.info(`gate ok: embedding coverage ${(coverage * 100).toFixed(1)}% (${embedded}/${active} ${source})`);
}

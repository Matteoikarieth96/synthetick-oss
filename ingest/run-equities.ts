import { log } from './lib/log.js';
import { FxTable } from './lib/fx.js';
import { supabase, upsertAssets, deactivateMissing, countAssets, type AssetRow } from './lib/supabase.js';
import {
  DEFAULT_EXCHANGES,
  fetchSymbolList,
  fetchProfile,
  applyProfile,
  fetchEtfData,
  dedupByIsin,
  toAssetRow,
  type FmpProfile,
  type SymCandidate,
  type DedupGroup,
} from './sources/fmp.js';
import { buildEmbedText, embedAssets, type EmbedTarget } from './embeddings/voyage.js';
import { assertSymbolCount, assertFieldCoverage, assertEmbeddingCoverage } from './lib/gates.js';
import * as fmp from './sources/fmp.js';

// ---- config (env-overridable) ----
const EXCHANGES = (process.env.EQUITIES_EXCHANGES ?? DEFAULT_EXCHANGES.join(','))
  .split(',').map((s) => s.trim()).filter(Boolean);
const ONLY_ISINS = (process.env.EQUITIES_ONLY_ISINS ?? '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const LIMIT = Number(process.env.EQUITIES_LIMIT ?? 0); // 0 = no cap
const CONCURRENCY = Number(process.env.EQUITIES_CONCURRENCY ?? 8);
const DEACTIVATE = (process.env.EQUITIES_DEACTIVATE ?? 'true') !== 'false';
/** Resume: skip companies whose DB row was updated within this many days.
 * FMP has no daily credit quota (the EODHD budget machinery is retired) — this
 * now exists to avoid re-embedding an unchanged universe every day. */
const MAX_AGE_DAYS = Number(process.env.EQUITIES_MAX_AGE_DAYS ?? 6);
/** Batch size for the fetch→upsert→embed cycle (progress persists per batch). */
const BATCH = Number(process.env.EQUITIES_BATCH ?? 250);

/** Exchange priority: most-queried assets land first during the backfill. */
const EXCHANGE_PRIORITY = new Map<string, number>(
  ['NYSE', 'NASDAQ', 'AMEX', 'LSE', 'XETRA', 'PAR', 'AMS', 'SIX', 'STO', 'BME',
   'MIL', 'BRU', 'CPH', 'HEL', 'OSL', 'LIS', 'VIE', 'DUB', 'HKSE']
    .map((ex, i) => [ex, i]),
);

/** Run an async fn over items with bounded concurrency. */
async function runPool<T, R>(items: T[], concurrency: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!, i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

const vendorId = (g: DedupGroup) => g.canonical.code; // FMP symbol IS the vendor id

/** vendor_ids of ACTIVE fmp rows updated within MAX_AGE_DAYS (paged read).
 * Active-only is load-bearing: when a group's canonical flips to a vendor_id
 * whose row exists but was deactivated (Ferrari: 2FE.DE → RACE.MI), a
 * freshness check that counts inactive rows skips the group, deactivates the
 * old canonical, and the company vanishes from the universe. */
async function fetchFreshVendorIds(): Promise<Set<string>> {
  const cutoff = new Date(Date.now() - MAX_AGE_DAYS * 86400_000).toISOString();
  const fresh = new Set<string>();
  const page = 1000;
  for (let from = 0; ; from += page) {
    const { data, error } = await supabase
      .from('assets')
      .select('vendor_id')
      .eq('source', 'fmp')
      .eq('is_active', true)
      .gte('updated_at', cutoff)
      // Stable order: offset paging without ORDER BY can skip or repeat rows.
      .order('id')
      .range(from, from + page - 1);
    if (error) throw new Error(`fetchFreshVendorIds failed: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const r of data) fresh.add(r.vendor_id as string);
    if (data.length < page) break;
  }
  return fresh;
}

/** Upsert + embed one mapped batch. Returns [upserted, embedded]. */
async function flushBatch(rows: AssetRow[]): Promise<[number, number]> {
  if (rows.length === 0) return [0, 0];
  const upserted = await upsertAssets(rows);
  const idByVendor = new Map(upserted.map((u) => [u.vendor_id, u.id]));
  const targets: EmbedTarget[] = [];
  for (const r of rows) {
    const id = idByVendor.get(r.vendor_id);
    if (id != null) targets.push({ id, text: buildEmbedText(r) });
  }
  const embedded = await embedAssets(targets);
  return [upserted.length, embedded];
}

async function main() {
  const t0 = Date.now();
  log.step(`Equities ingest (FMP) — exchanges: ${EXCHANGES.join(', ')} (batch ${BATCH})`);

  // 1. Screener symbol lists across all exchanges (skip any that fail, don't abort).
  const all: SymCandidate[] = [];
  let symbolListsComplete = true;
  for (const ex of EXCHANGES) {
    try {
      all.push(...(await fetchSymbolList(ex)));
    } catch (err) {
      symbolListsComplete = false;
      log.warn(`exchange ${ex} skipped: ${(err as Error).message}`);
    }
  }
  if (all.length === 0) throw new Error('No symbols fetched from any exchange (vendor down or key invalid).');

  // 2. Profile sweep: the screener carries no ISIN/currency, so dedup needs a
  //    profile for every candidate. Calls are quota-free on FMP; the limiter
  //    keeps us under the per-minute cap (~15 min for the full universe).
  log.step(`Collected ${all.length} candidate symbols; fetching profiles…`);
  const profiles = new Map<string, FmpProfile>();
  let profiled = 0;
  await runPool(all, CONCURRENCY, async (c) => {
    const p = await fetchProfile(c.code);
    profiled++;
    if (profiled % 1000 === 0) log.info(`profiles ${profiled}/${all.length}`);
    if (p) {
      profiles.set(c.code, p);
      applyProfile(c, p);
    }
  });
  const candidates = all.filter((c) => profiles.has(c.code));
  if (all.length - candidates.length > 0) {
    log.info(`${all.length - candidates.length} symbols had no profile — dropped`);
  }
  if (fmp.hardStop) throw new Error('FMP hard-rejected during the profile sweep — aborting before DB writes.');

  // 3. Dedup to one row per company; order by exchange priority (US → EU → HK).
  let groups: DedupGroup[] = dedupByIsin(candidates);
  const universeSize = groups.length;
  // Preserve the complete symbol-list universe before resume filters.
  // Deactivation must compare against what still trades, not merely the stale
  // subset selected for refresh today.
  const universeVendorIds = groups.map(vendorId);
  groups.sort(
    (a, b) =>
      (EXCHANGE_PRIORITY.get(a.canonical.exchange) ?? 99) -
      (EXCHANGE_PRIORITY.get(b.canonical.exchange) ?? 99),
  );
  log.info(`${candidates.length} symbols → ${universeSize} companies after dedup`);

  if (ONLY_ISINS.length) {
    const want = new Set(ONLY_ISINS);
    groups = groups.filter((gp) => gp.canonical.isin && want.has(gp.canonical.isin));
    log.info(`ONLY_ISINS filter → ${groups.length} companies`);
  }

  // 4. Resume: skip companies already fresh in the DB (saves ETF calls + embeds).
  const isFullRun = !ONLY_ISINS.length && LIMIT === 0;
  if (isFullRun) {
    const fresh = await fetchFreshVendorIds();
    const before = groups.length;
    groups = groups.filter((gp) => !fresh.has(vendorId(gp)));
    log.step(`Resume: ${before - groups.length} companies already fresh (<${MAX_AGE_DAYS}d), ${groups.length} to process`);
  }
  if (LIMIT > 0 && groups.length > LIMIT) {
    groups = groups.slice(0, LIMIT);
    log.info(`LIMIT → ${groups.length} companies`);
  }

  // Universe-level gate: candidate count sanity vs what the DB already holds.
  if (isFullRun && symbolListsComplete) await assertSymbolCount('fmp', universeSize);
  else if (isFullRun) log.warn('symbol-list coverage was partial — deactivation and the universe-count gate are disabled');

  // 5. FX table for all currencies present (one FMP batch-quote call).
  const currencies = [...new Set(candidates.map((c) => c.currency).filter((c): c is string => !!c))];
  const fx = new FxTable();
  await fx.load([...currencies, 'GBP']);

  // 6. Batched map (ETF enrichment) → upsert → embed. Progress persists per batch.
  let processed = 0;
  let totalUpserted = 0;
  let totalEmbedded = 0;
  let belowFloor = 0;
  let stopped = false;

  for (let i = 0; i < groups.length && !stopped; i += BATCH) {
    const slice = groups.slice(i, i + BATCH);
    const mapped = await runPool(slice, CONCURRENCY, async (gp) => {
      const profile = profiles.get(gp.canonical.code);
      processed++;
      if (processed % 500 === 0) log.info(`companies ${processed}/${groups.length}`);
      if (!profile) return null;
      const isEtf = (profile.isEtf ?? false) || gp.canonical.type === 'ETF';
      let etf = isEtf ? await fetchEtfData(gp.canonical.code) : null;
      // ETP classification probe (spec §4.1 step 3): FMP marks exchange-traded
      // products isFund with isEtf=false (USO, IAU). The etf endpoints answer
      // for those and stay empty for the mislabeled stocks sharing the flag
      // (REITs, CEFs, banks), so one probe both classifies and enriches.
      if (!isEtf && profile.isFund) {
        const probe = await fetchEtfData(gp.canonical.code);
        if (probe.info) {
          gp.canonical.type = 'ETF'; // toAssetRow keys off the candidate type
          etf = probe;
        }
      }
      return toAssetRow(gp, profile, etf, fx);
    });
    const rows = mapped.filter((r): r is AssetRow => r !== null);
    belowFloor += slice.length - rows.length;
    assertFieldCoverage(rows);
    const [u, e] = await flushBatch(rows);
    totalUpserted += u;
    totalEmbedded += e;
    if (fmp.hardStop) {
      stopped = true;
      log.warn(`FMP hard-rejected mid-run — flushed progress, stopping cleanly at ${processed}/${groups.length}`);
    }
  }

  const completedUniverse = isFullRun && symbolListsComplete && !stopped;

  // 7. Deactivate stale rows ONLY when the whole universe was covered this run
  //    (otherwise unprocessed companies would be wrongly flipped inactive).
  if (DEACTIVATE && completedUniverse) {
    const deactivated = await deactivateMissing('fmp', universeVendorIds);
    if (deactivated) log.info(`marked ${deactivated} stale fmp rows inactive`);
  }

  if (completedUniverse) await assertEmbeddingCoverage('fmp');

  const total = await countAssets({ source: 'fmp' });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  log.step(
    `Done in ${secs}s — processed ${processed}, upserted ${totalUpserted}, embedded ${totalEmbedded}, ` +
      `below-floor/no-data ${belowFloor}, total fmp rows: ${total}` +
      (stopped ? ' — stopped early on vendor rejection; re-run to finish' : ' — universe complete ✓'),
  );
}

main().catch((err) => {
  log.error('equities ingest failed', err);
  process.exit(1);
});

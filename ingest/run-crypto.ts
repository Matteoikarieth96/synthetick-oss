import { log, sleep } from './lib/log.js';
import { supabase, upsertAssets, countAssets, deactivateMissing, type AssetRow } from './lib/supabase.js';
import {
  fetchTopMarkets,
  fetchCoinDetail,
  toAssetRow,
  PACE_MS,
} from './sources/coingecko.js';
import { buildEmbedText, embedAssets, type EmbedTarget } from './embeddings/voyage.js';
import { assertSymbolCount, assertFieldCoverage, assertEmbeddingCoverage, planCryptoDeactivation } from './lib/gates.js';

// Config (env-overridable). Demo key: 30 calls/min, 10k/month — so nightly runs
// refresh markets cheaply and spend a bounded detail budget (spec §4.2 note).
const TOP_N = Number(process.env.CRYPTO_TOP_N ?? 3000);
const DETAIL_BUDGET = Number(process.env.CRYPTO_DETAIL_BUDGET ?? 200);
const GATES = (process.env.CRYPTO_GATES ?? 'true') !== 'false';
// Retire coins that fell out of the top N (set CRYPTO_DEACTIVATE=false to disable).
const DEACTIVATE = (process.env.CRYPTO_DEACTIVATE ?? 'true') !== 'false';

/** Enrichment freshness per coin ≈ its embedding's updated_at (re-embedded on each detail fetch). */
async function fetchEnrichmentAges(): Promise<{ ages: Map<string, string | null>; active: string[] }> {
  // vendor_id → embedding updated_at (null = never enriched/embedded)
  const ages = new Map<string, string | null>();
  const active: string[] = []; // vendor_ids currently flagged is_active
  const page = 1000;
  for (let from = 0; ; from += page) {
    const { data, error } = await supabase
      .from('assets')
      .select('vendor_id, is_active, asset_embeddings(updated_at)')
      .eq('source', 'coingecko')
      // Stable order: offset paging without ORDER BY can skip or repeat rows.
      .order('id')
      .range(from, from + page - 1);
    if (error) throw new Error(`fetchEnrichmentAges failed: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const r of data as unknown as {
      vendor_id: string;
      is_active: boolean;
      asset_embeddings: { updated_at: string } | { updated_at: string }[] | null;
    }[]) {
      const emb = Array.isArray(r.asset_embeddings) ? r.asset_embeddings[0] : r.asset_embeddings;
      ages.set(r.vendor_id, emb?.updated_at ?? null);
      if (r.is_active) active.push(r.vendor_id);
    }
    if (data.length < page) break;
  }
  return { ages, active };
}

/** Cap + volume partial row: safe to upsert without clobbering detail fields. */
function toPartialRow(m: { id: string; symbol: string; name: string; image: string | null; market_cap: number | null; total_volume: number | null }): AssetRow {
  const full = toAssetRow(m, null);
  return {
    ticker: full.ticker,
    vendor_id: full.vendor_id,
    source: 'coingecko',
    name: full.name,
    kind: 'crypto',
    region: 'global',
    cap_class: full.cap_class,
    market_cap_usd: full.market_cap_usd,
    volume_24h_usd: full.volume_24h_usd,
    logo_url: full.logo_url, // rides the markets payload — present even without detail
    accessibility: 'open',
    currency: 'USD',
    is_active: true,
    // NOTE: no description/categories/sector/venues — existing values persist on conflict.
  };
}

async function main() {
  const t0 = Date.now();
  log.step(`Crypto ingest — top ${TOP_N}, detail budget ${DETAIL_BUDGET}`);

  const markets = await fetchTopMarkets(TOP_N);
  log.step(`Fetched ${markets.length} markets; selecting detail targets…`);
  if (GATES) await assertSymbolCount('coingecko', markets.length);

  // Pick detail targets: new coins first, then stalest-enriched.
  const { ages, active: activeBefore } = await fetchEnrichmentAges();
  const newCoins = markets.filter((m) => !ages.has(m.id) || ages.get(m.id) === null);
  const known = markets
    .filter((m) => ages.get(m.id))
    .sort((a, b) => String(ages.get(a.id)).localeCompare(String(ages.get(b.id)))); // oldest first
  const detailSet = new Set([...newCoins, ...known].slice(0, DETAIL_BUDGET).map((m) => m.id));
  log.info(`detail targets: ${detailSet.size} (${Math.min(newCoins.length, DETAIL_BUDGET)} new)`);

  // Enriched rows: fetch detail (paced), full upsert + embed, in batches of 100.
  const enriched = markets.filter((m) => detailSet.has(m.id));
  const capOnly = markets.filter((m) => !detailSet.has(m.id));
  let embedded = 0;
  let upserted = 0;
  let detailFailures = 0;

  for (let i = 0; i < enriched.length; i += 100) {
    const slice = enriched.slice(i, i + 100);
    const rows: AssetRow[] = [];
    const detailedRows: AssetRow[] = [];
    for (const m of slice) {
      const detail = await fetchCoinDetail(m.id);
      // A transient detail failure must not erase an existing coin's venues,
      // categories, description, or website. Keep the cap/volume refresh, but
      // leave the embedding untouched so this coin remains stale and is
      // retried by the next rolling enrichment run.
      if (detail) {
        const row = toAssetRow(m, detail);
        rows.push(row);
        detailedRows.push(row);
      } else {
        rows.push(toPartialRow(m));
        detailFailures++;
      }
      await sleep(PACE_MS);
    }
    const ups = await upsertAssets(rows);
    const idByVendor = new Map(ups.map((u) => [u.vendor_id, u.id]));
    const targets: EmbedTarget[] = detailedRows
      .map((r) => ({ id: idByVendor.get(r.vendor_id), text: buildEmbedText(r) }))
      .filter((t): t is EmbedTarget => t.id != null);
    embedded += await embedAssets(targets);
    upserted += ups.length;
    log.info(`enriched ${Math.min(i + 100, enriched.length)}/${enriched.length}`);
  }

  // Cap-only partial updates for the rest (no detail fields touched).
  if (capOnly.length) {
    const partialRows = capOnly.map(toPartialRow);
    if (GATES) assertFieldCoverage(partialRows);
    const ups = await upsertAssets(partialRows);
    upserted += ups.length;
    log.step(`cap-only refresh for ${ups.length} coins`);
  }

  // Retire coins that dropped out of the top N. Without this they stay
  // is_active=true forever with a stale market cap / volume, still retrievable
  // and shown, and the symbol-count gate's baseline only grows. Runs only
  // after every upsert above succeeded (an exception earlier skips it), and
  // planCryptoDeactivation refuses partial runs and mass deactivations.
  // deactivateMissing also sweeps the embeddings of inactive rows. A coin that
  // later re-enters the top N is re-activated by the normal upsert
  // (is_active: true).
  if (DEACTIVATE) {
    const plan = planCryptoDeactivation(activeBefore, markets.map((m) => m.id), TOP_N);
    if (plan.skip) {
      log.warn(`crypto deactivation skipped: ${plan.skip}`);
    } else if (plan.stale.length) {
      const n = await deactivateMissing('coingecko', markets.map((m) => m.id));
      log.info(`marked ${n} coingecko rows inactive (fell out of the top ${TOP_N})`);
    }
  }

  // Embedding-coverage gate only meaningful when everything got detail (backfill runs).
  if (GATES && capOnly.length === 0) await assertEmbeddingCoverage('coingecko');

  const total = await countAssets({ source: 'coingecko' });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  log.step(
    `Done in ${secs}s — upserted ${upserted}, embedded ${embedded}, total crypto rows: ${total}` +
      (detailFailures ? ` — ${detailFailures} detail fetch(es) deferred without clearing existing enrichment` : '') +
      (capOnly.some((m) => !ages.has(m.id) || ages.get(m.id) === null)
        ? ' — some new coins deferred to next night’s budget'
        : ''),
  );
}

main().catch((err) => {
  log.error('crypto ingest failed', err);
  process.exit(1);
});

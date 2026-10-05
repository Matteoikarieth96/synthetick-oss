/**
 * Nightly quantitative metrics ingest (spec §15.2).
 *
 * Fills asset_metrics (one row per asset) and asset_prices (daily closes) so
 * data queries can rank the whole universe from our own tables instead of
 * making a vendor call per candidate. Equities/ETFs come from FMP's
 * whole-market bulk CSVs — one call per family, streamed, keeping only the
 * ~17k symbols that match assets.vendor_id. Crypto comes from CoinGecko's
 * paged markets endpoint, which carries its own multi-window price changes.
 *
 * Design rules that are load-bearing:
 * - Every family is best-effort and independent. A family that fails leaves
 *   its columns at last night's values rather than nulling them: a vendor
 *   outage must degrade to slightly stale data, never to an empty ranking.
 * - Everything is an upsert keyed on asset_id, so re-running is safe.
 * - eod-bulk is rate-limited and refuses back-to-back date fetches, so
 *   returns are computed from our accumulated asset_prices history, never by
 *   fetching two dates on demand. ingest/backfill-prices.ts seeds it.
 *
 * Run: npm run ingest:metrics
 */
import { requireFmp, env } from './lib/env.js';
import { streamCsv, num, pct, type CsvRow } from './lib/bulkcsv.js';
import { fetchJson } from './lib/http.js';
import { supabase } from './lib/supabase.js';
import { log, sleep } from './lib/log.js';

const BASE = 'https://financialmodelingprep.com/stable';
const CG = 'https://api.coingecko.com/api/v3';
const PRICE_RETENTION_DAYS = 400; // 1-year returns plus slack (spec §15.1)
const UPSERT_CHUNK = 500;
/**
 * Gap between bulk calls. The bulk endpoints share one aggressive limiter that
 * is separate from the 3,000/min API budget: firing eight families back to
 * back returned HTTP 429 on three of them (live 2026-07-27), and the growth
 * family exhausted its retries, landing 374 rows instead of ~8,200. Retries
 * alone do not fix a limiter this coarse — the calls have to be spaced.
 */
const BULK_GAP_MS = Number(process.env.METRICS_BULK_GAP_MS ?? 12_000);

/** Columns of asset_metrics we write. Everything nullable but asset_id. */
interface MetricRow {
  asset_id: number;
  [column: string]: number | string | null;
}

/** vendor_id → asset row, for joining vendor files to our universe. */
interface UniverseRow {
  id: number;
  vendor_id: string;
  kind: string;
  source: string;
  market_cap_usd: number | null;
}

/** Paged read of every active asset, keyed by source for the two ingest paths. */
async function loadUniverse(): Promise<UniverseRow[]> {
  const out: UniverseRow[] = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    const { data, error } = await supabase
      .from('assets')
      .select('id, vendor_id, kind, source, market_cap_usd')
      .eq('is_active', true)
      .order('id')
      .range(from, from + page - 1);
    if (error) throw new Error(`loadUniverse failed: ${error.message}`);
    if (!data?.length) break;
    out.push(...(data as UniverseRow[]));
    if (data.length < page) break;
  }
  return out;
}

/** Merge a family's values into the accumulating per-asset row. */
function merge(acc: Map<number, MetricRow>, assetId: number, values: Record<string, number | string | null>): void {
  const row = acc.get(assetId) ?? { asset_id: assetId };
  for (const [k, v] of Object.entries(values)) {
    // Null from one family must not erase a value another family supplied.
    if (v !== null && v !== undefined) row[k] = v;
  }
  acc.set(assetId, row);
}

/**
 * Columns this run actually collected — the write set.
 *
 * This is load-bearing, not bookkeeping. PostgREST builds a bulk upsert from
 * the UNION of keys across the payload and writes NULL wherever a row omits
 * one (verified live 2026-07-27), so a batch of rows with differing key sets
 * silently clobbers columns. Writing exactly the columns whose family
 * succeeded gives the documented behavior: a failed family's columns are
 * absent from the payload and keep last night's values, while a succeeded
 * family writes a real value or an honest null.
 */
const written = new Set<string>(['as_of', 'source', 'updated_at']);

/**
 * Stream one FMP bulk family into the accumulator. Best-effort: a failure is
 * logged, its columns stay out of the write set, and the run continues with
 * the remaining families (spec §15.2).
 */
async function ingestFamily(
  label: string,
  url: string,
  byVendorId: Map<string, UniverseRow>,
  acc: Map<number, MetricRow>,
  map: (row: CsvRow) => Record<string, number | string | null>,
  columns: string[],
): Promise<void> {
  await sleep(BULK_GAP_MS);
  try {
    let matched = 0;
    const seen = await streamCsv(
      url,
      (row) => {
        const asset = byVendorId.get(row.symbol ?? '');
        if (!asset) return;
        matched++;
        merge(acc, asset.id, map(row));
      },
      { label, retries: 4 },
    );
    for (const c of columns) written.add(c);
    log.info(`${label}: ${seen} vendor rows → ${matched} matched our universe`);
  } catch (err) {
    log.warn(`${label} unavailable, keeping previous values: ${(err as Error).message}`);
  }
}

/**
 * Paged variant for families where `part` is REAL pagination.
 *
 * `part` is a no-op on ratios-ttm-bulk (part=0 and part=1 are byte-identical),
 * and I wrongly generalized that to every family: profile-bulk part=1 and
 * part=2 return entirely different symbols, so fetching only part=0 silently
 * dropped most of the universe's beta and volume (live 2026-07-27). Pages
 * until one comes back empty.
 */
async function ingestPagedFamily(
  label: string,
  urlFor: (part: number) => string,
  byVendorId: Map<string, UniverseRow>,
  acc: Map<number, MetricRow>,
  map: (row: CsvRow) => Record<string, number | string | null>,
  columns: string[],
  maxParts = 12,
): Promise<void> {
  let matched = 0;
  let pages = 0;
  for (let part = 0; part < maxParts; part++) {
    await sleep(BULK_GAP_MS);
    let seen = 0;
    try {
      seen = await streamCsv(
        urlFor(part),
        (row) => {
          const asset = byVendorId.get(row.symbol ?? '');
          if (!asset) return;
          matched++;
          merge(acc, asset.id, map(row));
        },
        { label: `${label} part=${part}`, retries: 4 },
      );
    } catch (err) {
      log.warn(`${label} part=${part} failed: ${(err as Error).message}`);
      break; // a mid-sequence failure keeps the pages already collected
    }
    if (!seen) break; // past the last page
    pages++;
  }
  if (pages) {
    for (const c of columns) written.add(c);
    log.info(`${label}: ${pages} part(s) → ${matched} matched our universe`);
  } else {
    log.warn(`${label} unavailable, keeping previous values`);
  }
}

// ---- FMP families -----------------------------------------------------------

async function ingestEquityMetrics(byVendorId: Map<string, UniverseRow>, acc: Map<number, MetricRow>): Promise<void> {
  const key = requireFmp();
  const year = new Date().getUTCFullYear();

  await ingestFamily(
    'ratios-ttm-bulk',
    `${BASE}/ratios-ttm-bulk?apikey=${key}`,
    byVendorId,
    acc,
    (r) => ({
      pe: num(r.priceToEarningsRatioTTM),
      peg: num(r.priceToEarningsGrowthRatioTTM),
      price_to_sales: num(r.priceToSalesRatioTTM),
      price_to_book: num(r.priceToBookRatioTTM),
      debt_to_equity: num(r.debtToEquityRatioTTM),
      current_ratio: num(r.currentRatioTTM),
      interest_coverage: num(r.interestCoverageRatioTTM),
      fcf_per_share: num(r.freeCashFlowPerShareTTM),
      // The vendor sends margins and yield as fractions; the table stores percent.
      dividend_yield_pct: pct(r.dividendYieldTTM),
      gross_margin_pct: pct(r.grossProfitMarginTTM),
      operating_margin_pct: pct(r.operatingProfitMarginTTM),
      net_margin_pct: pct(r.netProfitMarginTTM),
    }),
    ['pe', 'peg', 'price_to_sales', 'price_to_book', 'debt_to_equity', 'current_ratio',
     'interest_coverage', 'fcf_per_share', 'dividend_yield_pct', 'gross_margin_pct',
     'operating_margin_pct', 'net_margin_pct'],
  );

  await ingestFamily(
    'key-metrics-ttm-bulk',
    `${BASE}/key-metrics-ttm-bulk?apikey=${key}`,
    byVendorId,
    acc,
    (r) => ({
      ev_to_ebitda: num(r.evToEBITDATTM),
      ev_to_sales: num(r.evToSalesTTM),
      roe: num(r.returnOnEquityTTM),
      roa: num(r.returnOnAssetsTTM),
      roic: num(r.returnOnInvestedCapitalTTM),
      net_debt_to_ebitda: num(r.netDebtToEBITDATTM),
      fcf_yield_pct: pct(r.freeCashFlowYieldTTM),
    }),
    ['ev_to_ebitda', 'ev_to_sales', 'roe', 'roa', 'roic', 'net_debt_to_ebitda', 'fcf_yield_pct'],
  );

  await ingestPagedFamily(
    'profile-bulk',
    (part) => `${BASE}/profile-bulk?part=${part}&apikey=${key}`,
    byVendorId,
    acc,
    (r) => ({
      beta: num(r.beta),
      volume: num(r.volume),
      avg_volume: num(r.averageVolume),
    }),
    ['beta', 'volume', 'avg_volume'],
  );

  await ingestFamily(
    'scores-bulk',
    `${BASE}/scores-bulk?apikey=${key}`,
    byVendorId,
    acc,
    (r) => ({
      altman_z: num(r.altmanZScore),
      piotroski: num(r.piotroskiScore),
    }),
    ['altman_z', 'piotroski'],
  );

  // Growth: the per-statement growth files, keyed by fiscal year. The current
  // calendar year has thin coverage early on (few companies have filed), so
  // fall back to the prior year — `merge` keeps whichever lands first, and the
  // newer file is fetched first so it wins where it exists.
  for (const y of [year, year - 1]) {
    await ingestFamily(
      `income-statement-growth-bulk ${y}`,
      `${BASE}/income-statement-growth-bulk?year=${y}&period=FY&apikey=${key}`,
      byVendorId,
      acc,
      (r) => ({
        revenue_growth_pct: pct(r.growthRevenue),
        earnings_growth_pct: pct(r.growthNetIncome),
      }),
      ['revenue_growth_pct', 'earnings_growth_pct'],
    );
    await ingestFamily(
      `cash-flow-statement-growth-bulk ${y}`,
      `${BASE}/cash-flow-statement-growth-bulk?year=${y}&period=FY&apikey=${key}`,
      byVendorId,
      acc,
      (r) => ({ fcf_growth_pct: pct(r.growthFreeCashFlow) }),
      ['fcf_growth_pct'],
    );
  }

  // Analyst consensus — third-party opinion, always rendered as attributed
  // (spec §15.5). lastYear is the useful window: allTime averages drag in
  // targets set years ago at prices that no longer exist.
  await ingestFamily(
    'price-target-summary-bulk',
    `${BASE}/price-target-summary-bulk?part=0&apikey=${key}`,
    byVendorId,
    acc,
    (r): Record<string, number | string | null> => {
      const target = num(r.lastYearAvgPriceTarget);
      // A zero target alongside a zero count is "no coverage", not a $0 target.
      if (target == null || target <= 0) return {};
      return { price_target_avg: target, analyst_count: num(r.lastYearCount) };
    },
    ['price_target_avg', 'analyst_count'],
  );
  await ingestFamily(
    'upgrades-downgrades-consensus-bulk',
    `${BASE}/upgrades-downgrades-consensus-bulk?part=0&apikey=${key}`,
    byVendorId,
    acc,
    (r) => ({ rating_consensus: (r.consensus ?? '').trim() || null }),
    ['rating_consensus'],
  );
}

// ---- Crypto (CoinGecko) -----------------------------------------------------

interface CgMarketRow {
  id: string;
  current_price?: number | null;
  market_cap?: number | null;
  total_volume?: number | null;
  price_change_percentage_24h_in_currency?: number | null;
  price_change_percentage_7d_in_currency?: number | null;
  price_change_percentage_30d_in_currency?: number | null;
  price_change_percentage_1y_in_currency?: number | null;
}

/**
 * Crypto metrics: one paged markets sweep carrying every price-change window
 * we need, so crypto ranks alongside equities on returns and volume without a
 * price-history table of its own (eod-bulk is equities only).
 */
async function ingestCryptoMetrics(universe: UniverseRow[], acc: Map<number, MetricRow>): Promise<void> {
  const coins = universe.filter((a) => a.source === 'coingecko');
  if (!coins.length) return;
  const byId = new Map(coins.map((a) => [a.vendor_id, a]));
  const headers: Record<string, string> = { accept: 'application/json' };
  if (env.COINGECKO_KEY) headers['x-cg-demo-api-key'] = env.COINGECKO_KEY;
  const paceMs = env.COINGECKO_KEY ? 2100 : 1500; // demo key: 30 calls/min
  const ids = [...byId.keys()];
  const PER_CALL = 250; // CoinGecko's per_page maximum
  let matched = 0;
  for (let i = 0; i < ids.length; i += PER_CALL) {
    const batch = ids.slice(i, i + PER_CALL);
    try {
      const rows = await fetchJson<CgMarketRow[]>(
        `${CG}/coins/markets?vs_currency=usd&ids=${encodeURIComponent(batch.join(','))}` +
          `&per_page=${PER_CALL}&page=1&price_change_percentage=24h,7d,30d,1y`,
        { headers, label: `cg markets ${i / PER_CALL + 1}`, retries: 3 },
      );
      for (const row of rows ?? []) {
        const asset = byId.get(row.id);
        if (!asset) continue;
        matched++;
        merge(acc, asset.id, {
          market_cap_usd: num(row.market_cap),
          volume: num(row.total_volume),
          return_1d_pct: num(row.price_change_percentage_24h_in_currency),
          return_7d_pct: num(row.price_change_percentage_7d_in_currency),
          return_30d_pct: num(row.price_change_percentage_30d_in_currency),
          return_1y_pct: num(row.price_change_percentage_1y_in_currency),
        });
      }
    } catch (err) {
      log.warn(`crypto metrics batch ${i / PER_CALL + 1} failed: ${(err as Error).message}`);
    }
    if (i + PER_CALL < ids.length) await sleep(paceMs);
  }
  if (matched) {
    for (const c of ['market_cap_usd', 'volume', 'return_1d_pct', 'return_7d_pct', 'return_30d_pct', 'return_1y_pct']) {
      written.add(c);
    }
  }
  log.info(`crypto metrics: ${matched} of ${ids.length} coins`);
}

// ---- Prices and returns -----------------------------------------------------

/**
 * Append one day of closes from eod-bulk. The endpoint is rate-limited and
 * rejects back-to-back date fetches (verified 2026-07-27), so this takes the
 * single most recent close and lets history accumulate night by night.
 * Weekends and holidays return an empty file — walk back to find a session.
 * Returns whether any close was written (prunePrices only runs when one was).
 */
async function ingestDailyCloses(byVendorId: Map<string, UniverseRow>): Promise<boolean> {
  const key = requireFmp();
  for (let back = 1; back <= 5; back++) {
    const date = new Date(Date.now() - back * 86400_000).toISOString().slice(0, 10);
    const rows: { asset_id: number; date: string; close: number }[] = [];
    try {
      await streamCsv(
        `${BASE}/eod-bulk?date=${date}&apikey=${key}`,
        (r) => {
          const asset = byVendorId.get(r.symbol ?? '');
          if (!asset) return;
          const close = num(r.adjClose) ?? num(r.close);
          if (close != null && close > 0) rows.push({ asset_id: asset.id, date, close });
        },
        { label: `eod-bulk ${date}`, retries: 1 },
      );
    } catch (err) {
      log.warn(`eod-bulk ${date} failed: ${(err as Error).message}`);
      return false; // rate limited or down: tonight adds no history, returns stay as they were
    }
    if (!rows.length) {
      log.info(`eod-bulk ${date}: no session (weekend/holiday), trying the day before`);
      continue;
    }
    await upsertRows('asset_prices', rows, 'asset_id,date');
    log.info(`asset_prices: ${rows.length} closes for ${date}`);
    return true;
  }
  log.warn('eod-bulk: no trading session found in the last 5 days');
  return false;
}

/**
 * Recompute equity returns entirely inside the database (spec §15.1).
 *
 * Nothing is transferred: update_asset_returns() reads asset_prices, computes
 * every window and writes the columns itself. Reading the rows back through
 * PostgREST would cap at its max-rows setting (1,000 of ~13,000 assets, and
 * .range() cannot lift it), which is exactly how the first run produced a
 * "biggest 30-day gainer" drawn from a truncated slice.
 *
 * MUST run after the main asset_metrics write, which creates the rows with the
 * return columns nulled for equities.
 */
const RETURN_BATCH_IDS = Number(process.env.METRICS_RETURN_BATCH ?? 2000);
/** Below this the slice is too small to be worth splitting again. */
const MIN_RETURN_BATCH = 125;

class MigrationMissingError extends Error {}

/**
 * Update one id slice, halving it on a statement timeout.
 *
 * Asset ids are distributed very unevenly: the equity block around 44k-50k
 * holds thousands of price-bearing assets while most of the id space is
 * empty, so a fixed slice that is comfortable in the sparse regions times out
 * in the dense one and silently skips it (5 slices lost on the first run,
 * 2026-07-27). Splitting on failure adapts to whatever the distribution is.
 */
async function updateReturnSlice(from: number, to: number): Promise<number> {
  const { data, error } = await supabase.rpc('update_asset_returns', { p_from: from, p_to: to });
  if (!error) return Number(data ?? 0);
  if (/Could not find the function|schema cache/i.test(error.message)) {
    throw new MigrationMissingError(error.message);
  }
  const timedOut = /statement timeout|canceling statement/i.test(error.message);
  if (!timedOut || to - from < MIN_RETURN_BATCH) {
    log.warn(`returns not updated for ids ${from}-${to}: ${error.message}`);
    return 0;
  }
  const mid = Math.floor((from + to) / 2);
  return (await updateReturnSlice(from, mid)) + (await updateReturnSlice(mid + 1, to));
}

async function updateReturns(maxAssetId: number): Promise<void> {
  let touched = 0;
  try {
    for (let from = 0; from <= maxAssetId; from += RETURN_BATCH_IDS) {
      touched += await updateReturnSlice(from, from + RETURN_BATCH_IDS - 1);
    }
  } catch (err) {
    if (err instanceof MigrationMissingError) {
      // Migration not applied yet; returns keep their previous values rather
      // than failing the whole nightly run.
      log.warn(`returns not updated: ${err.message}`);
      return;
    }
    throw err;
  }
  log.info(`returns updated for ${touched} assets`);
}

/** Drop price rows past the retention window (spec §15.1).
 *
 * One day at a time: a single `delete where date < cutoff` removes a full
 * day's rows (~13k) times however many days have accumulated, and the whole
 * statement hit Supabase's statement timeout once the table passed ~5M rows
 * (live 2026-08-03). Per-day deletes ride the date index and each finish in
 * well under a second; the min-date probe bounds the loop. */
async function prunePrices(): Promise<void> {
  const cutoff = new Date(Date.now() - PRICE_RETENTION_DAYS * 86400_000).toISOString().slice(0, 10);
  const { data, error: minErr } = await supabase
    .from('asset_prices')
    .select('date')
    .order('date')
    .limit(1);
  if (minErr) {
    log.warn(`price prune failed: ${minErr.message}`);
    return;
  }
  const oldest = data?.[0]?.date as string | undefined;
  if (!oldest || oldest >= cutoff) return;
  let pruned = 0;
  for (let d = new Date(oldest + 'T00:00:00Z'); ; d.setUTCDate(d.getUTCDate() + 1)) {
    const day = d.toISOString().slice(0, 10);
    if (day >= cutoff) break;
    const { error } = await supabase.from('asset_prices').delete().eq('date', day);
    if (error) {
      log.warn(`price prune failed at ${day}: ${error.message}`);
      return;
    }
    pruned++;
  }
  if (pruned) log.info(`price prune: dropped ${pruned} day(s) before ${cutoff}`);
}

// ---- Writing ----------------------------------------------------------------

async function upsertRows(table: string, rows: Record<string, unknown>[], onConflict: string): Promise<void> {
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const chunk = rows.slice(i, i + UPSERT_CHUNK);
    const { error } = await supabase.from(table).upsert(chunk, { onConflict });
    if (error) throw new Error(`${table} upsert failed: ${error.message}`);
  }
}

// ---- Orchestration ----------------------------------------------------------

async function main(): Promise<void> {
  const started = Date.now();
  log.step('Loading the universe…');
  const universe = await loadUniverse();
  const byVendorId = new Map<string, UniverseRow>();
  for (const a of universe) if (a.source === 'fmp') byVendorId.set(a.vendor_id, a);
  log.info(`universe: ${universe.length} active assets, ${byVendorId.size} FMP-sourced`);
  const maxAssetId = universe.reduce((max, a) => Math.max(max, a.id), 0);

  // Returns are derived purely from asset_prices, so they can be rebuilt
  // without re-pulling a single vendor file — useful after a price backfill
  // or when a slice timed out.
  if (process.env.METRICS_RETURNS_ONLY === '1') {
    log.step('Updating returns only…');
    await updateReturns(maxAssetId);
    log.step(`Done in ${Math.round((Date.now() - started) / 1000)}s`);
    return;
  }

  const acc = new Map<number, MetricRow>();
  // Market cap is mirrored from assets for EVERY kind so a single-table
  // ranking works universally, including pre-IPO rows that have no vendor
  // metrics at all (spec §15.1). Crypto overwrites it with a fresher figure.
  for (const a of universe) {
    if (a.market_cap_usd != null) merge(acc, a.id, { market_cap_usd: a.market_cap_usd });
  }
  written.add('market_cap_usd');

  // FMP is optional (spec §17: the plan ended, and forks may never have a key).
  // requireFmp() used to throw here and fail the WHOLE run, so crypto metrics
  // and the market-cap mirror stopped refreshing along with the equities.
  const hasFmp = Boolean(env.FMP_KEY);
  let appendedCloses = false;
  if (hasFmp) {
    log.step('Fetching equity metric families…');
    await ingestEquityMetrics(byVendorId, acc);
  } else {
    log.warn('FMP_KEY not set: equity metric families and daily closes skipped; crypto metrics still refresh');
  }

  log.step('Fetching crypto metrics…');
  await ingestCryptoMetrics(universe, acc);

  if (hasFmp) {
    log.step('Appending daily closes…');
    appendedCloses = await ingestDailyCloses(byVendorId);
  }

  log.step('Writing asset_metrics…');
  const asOf = new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString();
  // Every row carries EXACTLY the write set, so the payload is homogeneous.
  // PostgREST would otherwise take the union of keys across the batch and null
  // the ones a given row omits, clobbering values from families that are not
  // part of tonight's run (verified live 2026-07-27).
  const columns = [...written];
  const rows: MetricRow[] = [...acc.values()].map((r) => {
    const row: MetricRow = { asset_id: r.asset_id as number };
    for (const c of columns) row[c] = (r[c] as number | string | null) ?? null;
    row.as_of = asOf;
    row.source = 'fmp';
    row.updated_at = now;
    return row;
  });
  log.info(`writing ${columns.length - 3} metric columns for ${rows.length} assets`);
  await upsertRows('asset_metrics', rows, 'asset_id');

  // After the row write, never before: the write above nulls the return
  // columns for equities, and this fills them straight from asset_prices.
  log.step('Updating returns…');
  await updateReturns(maxAssetId);
  // Retention only makes sense while history is growing: with no close added
  // tonight (vendor down or gone), pruning just shrinks a frozen history until
  // the 1-year window is empty (review R9).
  if (appendedCloses) await prunePrices();
  else log.info('no new closes tonight: price history kept, retention prune skipped');

  const withPe = rows.filter((r) => typeof r.pe === 'number').length;
  const withRet = rows.filter((r) => typeof r.return_30d_pct === 'number').length;
  log.step(
    `Done in ${Math.round((Date.now() - started) / 1000)}s — ${rows.length} metric rows ` +
      `(${withPe} with P/E, ${withRet} with a 30-day return)`,
  );
}

main().catch((err) => {
  log.error(`metrics ingest failed: ${(err as Error).message}`);
  process.exit(1);
});

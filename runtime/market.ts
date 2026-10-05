/**
 * /market (spec §5.6) — real vendor data, never fabricated.
 * - stocks/ETFs/bonds: FMP delayed quote + 30 trading days EOD closes
 * - crypto: CoinGecko market_chart?days=30 + current price
 * - per asset: {price, change1d, change30d, marketCap, series[30], currency,
 *   asOf, delayed, yearHigh, yearLow} — the 1d/52-week fields ride the quote
 *   calls we already make (spec §5.6 quote-field surfacing, 2026-07-12)
 * - 60s in-process cache; vendor failure → nulls and dataUnavailable:true
 *   (the card renders "—"), SIM/LIVE tagging retired in favor of asOf.
 */
import 'dotenv/config';
import { fetchJson } from '../ingest/lib/http.js';
import { fmpLimiter } from '../ingest/lib/ratelimit.js';
import { log } from '../ingest/lib/log.js';

/** Stored pre-IPO series (spec §4.2b, db/private_data.sql). Only the fields
 * the runtime reads; the column holds more (projections, rounds, sources). */
export interface PrivateData {
  valuation_series?: { d: string; v: number }[];
}

/** Frozen equity market data (spec §5.6, db/market_snapshot.sql). A FALLBACK,
 * not a cache: read only when the live vendor call fails or no key is set. */
export interface MarketSnapshot {
  as_of: string; // YYYY-MM-DD the snapshot was taken
  price?: number | null;
  currency?: string | null;
  change1d?: number | null;
  change30d?: number | null;
  series?: number[];
  yearHigh?: number | null;
  yearLow?: number | null;
  fin?: MarketFin;
}

export interface MarketAssetRef {
  source: 'fmp' | 'coingecko' | 'sacra';
  vendor_id: string; // FMP Yahoo-style symbol, CoinGecko id, or Sacra domain
  ticker: string;
  kind?: 'stock' | 'etf' | 'bond' | 'crypto' | 'private' | null; // gates the stock-only ratios call (§5.6 fin)
  currency?: string | null; // native display currency for equities
  market_cap_usd?: number | null; // from the DB row
  volume_24h_usd?: number | null; // crypto 24h volume, USD; from the DB row (null for equities)
  updated_at?: string | null; // row freshness; pre-IPO rows surface it as asOf (§5.6)
  private_data?: PrivateData | null; // pre-IPO stored series; null on every other source
  market_snapshot?: MarketSnapshot | null; // frozen equity fallback; null until snapshotted
}

/** Kind-specific extras for the Financial data table (§5.6 fin, 2026-07-13). All nullable, never guessed. */
export interface MarketFin {
  // equities — FMP quote fields we already fetch
  open?: number | null;
  prevClose?: number | null;
  dayLow?: number | null;
  dayHigh?: number | null;
  volume?: number | null;
  priceAvg50?: number | null;
  priceAvg200?: number | null;
  // stocks — one ratios-ttm call per pick
  pe?: number | null;
  eps?: number | null; // netIncomePerShare TTM, reporting currency
  priceToSales?: number | null;
  priceToBook?: number | null;
  debtToEquity?: number | null;
  dividendYieldPct?: number | null; // percent, already ×100
  grossMarginPct?: number | null;
  netMarginPct?: number | null;
  // crypto — batch coins/markets + market_chart total_volumes
  rank?: number | null;
  fdv?: number | null;
  circSupply?: number | null;
  totalSupply?: number | null;
  maxSupply?: number | null;
  high24h?: number | null;
  low24h?: number | null;
  ath?: number | null;
  athChangePct?: number | null;
  atl?: number | null;
  avgVol7d?: number | null; // average daily volume, USD
  avgVol30d?: number | null;
}

export interface MarketData {
  ticker: string;
  price: number | null;
  change1d: number | null; // percent, 1 trading day (crypto: last two daily closes ≈ 24h)
  change30d: number | null; // percent
  marketCap: number | null; // USD (from DB)
  volume24h: number | null; // crypto 24h trading volume, USD (from DB); null for equities
  series: number[]; // up to 30 closes, oldest → newest; [] when unavailable
  /** What `series` actually plots. Absent = 30 daily closes (the default for
   * every quoted asset). Pre-IPO rows plot a multi-year valuation curve
   * instead, so the card must not label it "30 day price history" (§4.2b). */
  seriesLabel?: string | null;
  /** Formatting hint for `series` values: 'price' (default) or 'cap' for
   * figures in the billions, which the money formatter renders unreadably. */
  seriesFormat?: 'price' | 'cap';
  currency: string; // display currency code ("USD", "EUR", "HKD"…)
  asOf: string | null; // ISO timestamp of the quote
  delayed: boolean; // FMP equity quotes are delayed on most non-US exchanges
  yearHigh: number | null; // 52-week high, native currency (equities only)
  yearLow: number | null; // 52-week low, native currency (equities only)
  fin?: MarketFin; // kind-specific extras for the Financial data table (§5.6, 2026-07-13)
  dataUnavailable?: boolean;
  /** True when these figures came from `assets.market_snapshot` rather than a
   * live vendor call (spec §5.6, 2026-07-28). The card must say so — a frozen
   * close presented as a quote is the one failure mode worse than no data. */
  stale?: boolean;
}

const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; data: MarketData }>();

function fmpKey(): string {
  const k = process.env.FMP_KEY;
  if (!k) throw new Error('FMP_KEY missing for /market');
  return k;
}

function cgHeaders(): Record<string, string> {
  const h: Record<string, string> = { accept: 'application/json' };
  if (process.env.COINGECKO_KEY) h['x-cg-demo-api-key'] = process.env.COINGECKO_KEY;
  return h;
}

interface FmpQuote {
  price?: number;
  changePercentage?: number;
  yearHigh?: number;
  yearLow?: number;
  timestamp?: number;
  open?: number;
  previousClose?: number;
  dayLow?: number;
  dayHigh?: number;
  volume?: number;
  priceAvg50?: number;
  priceAvg200?: number;
}

interface FmpRatiosTtm {
  priceToEarningsRatioTTM?: number;
  netIncomePerShareTTM?: number;
  priceToSalesRatioTTM?: number;
  priceToBookRatioTTM?: number;
  debtToEquityRatioTTM?: number;
  dividendYieldTTM?: number; // fraction (0.004 = 0.4%)
  grossProfitMarginTTM?: number; // fraction
  netProfitMarginTTM?: number; // fraction
}

/** Exported for `ingest/snapshot-market.ts`, which must hit the same three
 * endpoints through the same code as a live run — not a parallel reimplementation. */
export async function fmpEquityMarket(a: MarketAssetRef): Promise<MarketData> {
  const sym = encodeURIComponent(a.vendor_id); // FMP symbols are used verbatim (AAPL, ENI.MI)
  const from = new Date(Date.now() - 60 * 86400_000).toISOString().slice(0, 10);
  const [quoteResult, eodResult, ratiosResult] = await Promise.allSettled([
    fetchJson<FmpQuote[]>(
      `https://financialmodelingprep.com/stable/quote?symbol=${sym}&apikey=${fmpKey()}`,
      { label: `mkt quote ${a.vendor_id}`, retries: 2 },
    ),
    fetchJson<{ date: string; price: number }[]>(
      // ~60 calendar days back covers ≥30 trading days; rows arrive newest-first
      `https://financialmodelingprep.com/stable/historical-price-eod/light?symbol=${sym}&from=${from}&apikey=${fmpKey()}`,
      { label: `mkt eod ${a.vendor_id}`, retries: 2 },
    ),
    // Stock-only TTM ratios for the Financial data table (§5.6 fin) — funds have no
    // meaningful ratios and pre-IPO/crypto never reach this branch. Failure degrades
    // to a ratio-less fin, never fails the quote.
    a.kind === 'stock'
      ? fetchJson<FmpRatiosTtm[]>(
          `https://financialmodelingprep.com/stable/ratios-ttm?symbol=${sym}&apikey=${fmpKey()}`,
          { label: `mkt ratios ${a.vendor_id}`, retries: 1 },
        )
      : Promise.resolve([] as FmpRatiosTtm[]),
  ]);
  if (quoteResult.status === 'rejected' && eodResult.status === 'rejected') {
    throw quoteResult.reason;
  }
  const quote = quoteResult.status === 'fulfilled' ? quoteResult.value?.[0] : null;
  const eod = eodResult.status === 'fulfilled' ? eodResult.value : [];
  const ratios = ratiosResult.status === 'fulfilled' ? ratiosResult.value?.[0] : null;
  return mapFmpMarket(a, quote ?? null, eod ?? [], ratios ?? null);
}

/** Pure mapping from FMP's three responses to MarketData. Extracted so
 * `ingest/snapshot-market.ts` builds `assets.market_snapshot` through exactly
 * this code (spec §5.6, 2026-07-28) — a second hand-written mapping would
 * drift from the live path the moment either side gained a field. */
export function mapFmpMarket(
  a: MarketAssetRef,
  quote: FmpQuote | null,
  eod: { date: string; price: number }[],
  ratios: FmpRatiosTtm | null,
): MarketData {
  const series = (eod ?? [])
    .slice()
    .sort((x, y) => x.date.localeCompare(y.date)) // oldest → newest
    .map((d) => Number(d.price))
    .filter((v) => Number.isFinite(v) && v > 0)
    .slice(-30);
  const quoted = Number(quote?.price);
  const price = Number.isFinite(quoted) && quoted > 0 ? quoted : (series.at(-1) ?? null);
  const first = series[0];
  const change30d = price != null && first ? ((price - first) / first) * 100 : null;
  const finiteOrNull = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const yearHigh = finiteOrNull(quote?.yearHigh);
  const yearLow = finiteOrNull(quote?.yearLow);
  // FMP margins/yield arrive as fractions; the table wants percent.
  const pctOrNull = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) * 100 : null);
  const fin: MarketFin = {
    open: finiteOrNull(quote?.open),
    prevClose: finiteOrNull(quote?.previousClose),
    dayLow: finiteOrNull(quote?.dayLow),
    dayHigh: finiteOrNull(quote?.dayHigh),
    volume: finiteOrNull(quote?.volume),
    priceAvg50: finiteOrNull(quote?.priceAvg50),
    priceAvg200: finiteOrNull(quote?.priceAvg200),
    pe: finiteOrNull(ratios?.priceToEarningsRatioTTM),
    eps: finiteOrNull(ratios?.netIncomePerShareTTM),
    priceToSales: finiteOrNull(ratios?.priceToSalesRatioTTM),
    priceToBook: finiteOrNull(ratios?.priceToBookRatioTTM),
    debtToEquity: finiteOrNull(ratios?.debtToEquityRatioTTM),
    dividendYieldPct: pctOrNull(ratios?.dividendYieldTTM),
    grossMarginPct: pctOrNull(ratios?.grossProfitMarginTTM),
    netMarginPct: pctOrNull(ratios?.netProfitMarginTTM),
  };
  return {
    ticker: a.ticker,
    price,
    change1d: finiteOrNull(quote?.changePercentage),
    change30d,
    marketCap: a.market_cap_usd ?? null,
    volume24h: a.volume_24h_usd ?? null,
    series,
    currency: a.currency ?? 'USD',
    asOf: quote?.timestamp && Number.isFinite(Number(quote.timestamp))
      ? new Date(Number(quote.timestamp) * 1000).toISOString()
      : null,
    delayed: true, // FMP equity quotes: delayed on most non-US exchanges
    // Only a coherent range is worth rendering (a lone bound or an inverted pair isn't).
    yearHigh: yearHigh != null && yearLow != null && yearHigh > yearLow ? yearHigh : null,
    yearLow: yearHigh != null && yearLow != null && yearHigh > yearLow ? yearLow : null,
    fin,
  };
}

async function cryptoMarket(a: MarketAssetRef): Promise<MarketData> {
  const chart = await fetchJson<{ prices?: [number, number][]; total_volumes?: [number, number][] }>(
    `https://api.coingecko.com/api/v3/coins/${a.vendor_id}/market_chart?vs_currency=usd&days=30&interval=daily`,
    { headers: cgHeaders(), label: `mkt cg ${a.vendor_id}`, retries: 2 },
  );
  const prices = (chart.prices ?? []).filter(
    (row): row is [number, number] =>
      Array.isArray(row) && Number.isFinite(Number(row[0])) && Number.isFinite(Number(row[1])) && Number(row[1]) > 0,
  );
  const series = prices.map(([, p]) => Number(p)).slice(-30);
  const price = series.at(-1) ?? null;
  const first = series[0];
  const change30d = price != null && first ? ((price - first) / first) * 100 : null;
  // Last two daily closes ≈ 24h move (the chart's final point is the latest price).
  const prev = series.at(-2);
  const change1d = price != null && prev ? ((price - prev) / prev) * 100 : null;
  const lastTs = prices.at(-1)?.[0];
  // 7d/30d average daily volume from the total_volumes array that rides the same
  // response (§5.6 fin) — no extra call, omitted when the vendor sends nothing.
  const vols = (chart.total_volumes ?? [])
    .map((row) => Number(row?.[1]))
    .filter((v) => Number.isFinite(v) && v >= 0)
    .slice(-30);
  const avg = (xs: number[]) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null);
  return {
    ticker: a.ticker,
    price,
    change1d,
    change30d,
    marketCap: a.market_cap_usd ?? null,
    volume24h: a.volume_24h_usd ?? null,
    series,
    currency: 'USD',
    asOf: lastTs ? new Date(lastTs).toISOString() : null,
    delayed: false,
    yearHigh: null, // 30-day window only — no 52-week fields for crypto
    yearLow: null,
    fin: { avgVol7d: avg(vols.slice(-7)), avgVol30d: avg(vols) },
  };
}

// Batch snapshot for crypto picks (§5.6 fin): ONE coins/markets call covers every
// coingecko pick in the run — supply, rank, FDV, 24h range, ATH/ATL. 60s cache per id.
interface CgMarketRow {
  id: string;
  market_cap_rank?: number;
  fully_diluted_valuation?: number;
  circulating_supply?: number;
  total_supply?: number;
  max_supply?: number;
  high_24h?: number;
  low_24h?: number;
  ath?: number;
  ath_change_percentage?: number;
  atl?: number;
}
const snapCache = new Map<string, { at: number; fin: MarketFin }>();

async function cryptoSnapshots(ids: string[]): Promise<Map<string, MarketFin>> {
  const out = new Map<string, MarketFin>();
  const missing: string[] = [];
  for (const id of ids) {
    const hit = snapCache.get(id);
    if (hit && Date.now() - hit.at < CACHE_MS) out.set(id, hit.fin);
    else missing.push(id);
  }
  if (!missing.length) return out;
  try {
    const rows = await fetchJson<CgMarketRow[]>(
      `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${encodeURIComponent(missing.join(','))}`,
      { headers: cgHeaders(), label: `mkt cg snapshots (${missing.length})`, retries: 2 },
    );
    const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : null);
    for (const row of rows ?? []) {
      if (!row?.id) continue;
      const fin: MarketFin = {
        rank: n(row.market_cap_rank),
        fdv: n(row.fully_diluted_valuation),
        circSupply: n(row.circulating_supply),
        totalSupply: n(row.total_supply),
        maxSupply: n(row.max_supply),
        high24h: n(row.high_24h),
        low24h: n(row.low_24h),
        ath: n(row.ath),
        athChangePct: n(row.ath_change_percentage),
        atl: n(row.atl),
      };
      snapCache.set(row.id, { at: Date.now(), fin });
      out.set(row.id, fin);
    }
  } catch (err) {
    // Degrade to chart-only fin — the card and table render what they have.
    log.warn(`crypto snapshot batch unavailable: ${(err as Error).message}`);
  }
  return out;
}

/** Rebuild MarketData from a stored snapshot, marked stale so the card can
 * never present a frozen close as a live quote (spec §5.6, 2026-07-28).
 * Returns null when the row has no snapshot, so the caller degrades as before. */
function fromSnapshot(a: MarketAssetRef): MarketData | null {
  const s = a.market_snapshot;
  if (!s?.as_of) return null;
  const series = (s.series ?? []).filter((v) => Number.isFinite(v) && v > 0);
  const asOfLabel = new Date(s.as_of).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  return {
    ticker: a.ticker,
    price: s.price ?? null,
    change1d: s.change1d ?? null,
    change30d: s.change30d ?? null,
    // Market cap tracks the DB row, which the ingest still refreshes; only the
    // quote layer is frozen.
    marketCap: a.market_cap_usd ?? null,
    volume24h: a.volume_24h_usd ?? null,
    series,
    seriesLabel: series.length >= 2 ? `30 days to ${asOfLabel}` : null,
    currency: s.currency ?? a.currency ?? 'USD',
    asOf: s.as_of,
    delayed: false, // not a delayed quote — a frozen one; `stale` is the honest flag
    yearHigh: s.yearHigh ?? null,
    yearLow: s.yearLow ?? null,
    fin: s.fin,
    stale: true,
  };
}

/** Fetch market data for one asset, with a 60s cache. Never fabricates. */
export async function marketFor(a: MarketAssetRef): Promise<MarketData> {
  // Pre-IPO privates (§5.6): no live quote exists anywhere — render the stored
  // estimated valuation, never call a quote vendor (and never fall through to
  // the crypto branch below, which matches any non-fmp source).
  if (a.source === 'sacra') {
    // Valuation history from the stored series (§4.2b, db/private_data.sql), not
    // a live lookup. The curve is irregular and multi-year, not 30 daily closes,
    // hence the label.
    // change1d/change30d stay null: a private company has no trading day, and
    // filling them from revaluation events would misrepresent the number.
    const points = a.private_data?.valuation_series ?? [];
    const series = points.map((p) => p.v).filter((v) => Number.isFinite(v) && v > 0);
    return {
      ticker: a.ticker,
      price: null,
      change1d: null,
      change30d: null,
      marketCap: a.market_cap_usd ?? null,
      volume24h: null,
      series,
      seriesLabel: series.length >= 2 ? 'Valuation history' : null,
      seriesFormat: 'cap',
      currency: 'USD',
      // The date of the latest valuation, not the row's sync time, which would
      // claim the data is fresh.
      asOf: points.at(-1)?.d ?? a.updated_at ?? null,
      delayed: false,
      yearHigh: null,
      yearLow: null,
    };
  }
  const key = `${a.source}:${a.vendor_id}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  try {
    if (a.source === 'fmp') await fmpLimiter.wait();
    const data = a.source === 'fmp' ? await fmpEquityMarket(a) : await cryptoMarket(a);
    cache.set(key, { at: Date.now(), data });
    return data;
  } catch (err) {
    // Snapshot fallback before giving up (spec §5.6, 2026-07-28). Covers both a
    // failing vendor call and a missing key: with no FMP_KEY, fmpKey() throws
    // inside the fetch and lands here, so no separate branch is needed.
    const snap = fromSnapshot(a);
    if (snap) {
      log.info(`market data for ${a.ticker} served from snapshot ${snap.asOf} (live call failed)`);
      cache.set(key, { at: Date.now(), data: snap });
      return snap;
    }
    log.warn(`market data unavailable for ${a.ticker}: ${(err as Error).message}`);
    return {
      ticker: a.ticker,
      price: null,
      change1d: null,
      change30d: null,
      marketCap: a.market_cap_usd ?? null,
      volume24h: a.volume_24h_usd ?? null,
      series: [],
      currency: a.currency ?? 'USD',
      asOf: null,
      delayed: false,
      yearHigh: null,
      yearLow: null,
      dataUnavailable: true,
    };
  }
}

/** Key of one asset in a marketForAll result. Tickers are NOT unique across
 * sources and exchanges (crypto ETH vs the ETH mini-trust ETF, BTC likewise),
 * so keying by ticker attached one asset's price to another's card (review R1). */
export const marketKey = (a: Pick<MarketAssetRef, 'source' | 'vendor_id'>): string => `${a.source}:${a.vendor_id}`;

/** Batch helper for a result set (≤10 picks): sequential to respect vendor
 * pacing. Keyed by marketKey(asset), never by ticker. */
export async function marketForAll(assets: MarketAssetRef[]): Promise<Record<string, MarketData>> {
  const out: Record<string, MarketData> = {};
  // One coins/markets call for all crypto picks, concurrent with the per-asset loop.
  const cgIds = assets.filter((a) => a.source === 'coingecko').map((a) => a.vendor_id);
  const snapsP = cgIds.length ? cryptoSnapshots(cgIds) : Promise.resolve(new Map<string, MarketFin>());
  for (const a of assets) out[marketKey(a)] = await marketFor(a);
  const snaps = await snapsP;
  for (const a of assets) {
    const snap = snaps.get(a.vendor_id);
    const data = out[marketKey(a)];
    if (snap && data && a.source === 'coingecko') {
      out[marketKey(a)] = { ...data, fin: { ...data.fin, ...snap } };
    }
  }
  return out;
}

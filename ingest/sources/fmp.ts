/**
 * FMP equities/ETF source (spec §4.1, v4.1 migration 2026-07-10).
 *
 * FMP splits data differently from EODHD, so the pipeline reshapes:
 *   screener (symbols per exchange; no ISIN/currency, cap currency unreliable)
 *   → profile per symbol (ISIN, HQ-domicile country, isAdr, cap+currency,
 *     sector/industry, description, website — everything dedup & mapping need)
 *   → ISIN dedup (ingest/lib/dedup.ts)
 *   → ETF enrichment: etf/info + etf/holdings + etf/sector-weightings +
 *     etf/country-weightings (4 calls, canonical ETFs only).
 *
 * Uses the /stable/ API exclusively — legacy /api/v3/ endpoints are dead for
 * accounts created after 2025-08-31.
 */
import { requireFmp } from '../lib/env.js';
import { fetchJson, HttpError } from '../lib/http.js';
import { fmpLimiter } from '../lib/ratelimit.js';
import { log } from '../lib/log.js';
import { capClass } from '../lib/caps.js';
import { FxTable } from '../lib/fx.js';
import { regionForCountry, isinCountry, type Region } from '../lib/regions.js';
import { dedupByIsin, MIN_CAP_USD, type SymCandidate, type DedupGroup } from '../lib/dedup.js';
import type { AssetRow, EtfHolding, EtfPortfolio, EtfPortfolioSlice } from '../lib/supabase.js';

export { dedupByIsin, MIN_CAP_USD, type SymCandidate, type DedupGroup };

const BASE = 'https://financialmodelingprep.com/stable';

/** Exchanges to ingest (spec §4.1 step 1), FMP short names. MIL is new. */
export const DEFAULT_EXCHANGES = [
  'NYSE', 'NASDAQ', 'AMEX', // US (Chinese ADRs flagged cn by profile.country, §4.1a)
  'LSE', 'XETRA', 'PAR', 'AMS', 'BRU', 'LIS', 'BME', 'SIX', 'VIE', 'DUB',
  'STO', 'CPH', 'HEL', 'OSL',
  'MIL', // Borsa Italiana — the exchange EODHD lacked
  'HKSE', // China (HKEX)
];

// The screener has no security-type field beyond isEtf/isFund, so warrants,
// rights, units and preferred lines are dropped by name/symbol shape (spec
// §4.1 step 2). Name regex stays narrow — "preferred"/"depositary" would kill
// legit issuers (Preferred Bank) and ADR lines; the FMP symbol shape catches
// those instead (BAC-PL, ABC-WS, XYZ.U). The $50M floor removes remaining dust.
const JUNK_NAME_RE = /\b(warrants?|units? consisting)\b/i;
const JUNK_SYMBOL_RE = /[-.](WS|WT|RT|R|U|P[A-Z]?)$/;
// LSE International Order Book lines (0QYR.L = Toyota etc.) are pure secondary
// listings with empty ISINs — they duplicate the home line as a separate
// company (name-fallback grouping can't merge them into an ISIN-keyed group).
const LSE_IOB_RE = /^0[A-Z0-9]{3}\./;

// FMP's isFund flag is NOT "mutual fund" (spec §4.1 step 2, 2026-07-29): it
// also marks exchange-traded products whose isEtf is false (USO, IAU), REIT
// common stock (ESS, FRT, VNO), closed-end/investment trusts (PDI, SMT.L) and
// the odd bank (CTBI) — all screenable assets a bare !isFund silently dropped.
// A true mutual fund is an isFund row that never prints on-exchange volume
// (all 4,390 X-suffix NASDAQ fund classes report zero/absent volume) or that
// matches the 5–6-letter X-suffix share-class symbol shape (VTSAX, QCGRIX).
const MUTUAL_FUND_SYMBOL_RE = /^[A-Z]{4,5}X$/;
function isMutualFund(r: ScreenerRow): boolean {
  return r.isFund && (!r.volume || MUTUAL_FUND_SYMBOL_RE.test(r.symbol));
}

interface ScreenerRow {
  symbol: string;
  companyName: string;
  marketCap: number | null; // mixed currencies (JPY for Toyota's .L line) — NEVER filter on it
  sector: string | null;
  industry: string | null;
  volume: number | null;
  exchange: string | null; // full name
  exchangeShortName: string | null;
  country: string | null; // ISO
  isEtf: boolean;
  isFund: boolean;
  isActivelyTrading: boolean;
}

/** The screener hard-caps every response at 10k rows regardless of `limit`
 * (NASDAQ has ~13k rows, live-verified 2026-07-10) — page until a short page. */
const SCREENER_PAGE = 10000;
const SCREENER_MAX_PAGES = 10; // safety: no exchange is near 100k rows

/** Fetch + filter a single exchange's screener list to keepable stocks/ETFs. */
export async function fetchSymbolList(exchange: string): Promise<SymCandidate[]> {
  const key = requireFmp();
  const raw: ScreenerRow[] = [];
  for (let page = 0; page < SCREENER_MAX_PAGES; page++) {
    await fmpLimiter.wait();
    const batch = await fetchJson<ScreenerRow[]>(
      `${BASE}/company-screener?exchange=${exchange}&limit=${SCREENER_PAGE}&page=${page}&apikey=${key}`,
      { label: `screener ${exchange} p${page}` },
    );
    raw.push(...batch);
    if (batch.length < SCREENER_PAGE) break;
    if (page === SCREENER_MAX_PAGES - 1) {
      log.warn(`screener ${exchange} still full at page ${page} — universe may be truncated`);
    }
  }
  const kept = raw
    .filter(
      (r) =>
        !isMutualFund(r) &&
        r.isActivelyTrading !== false &&
        r.symbol &&
        r.companyName &&
        !JUNK_NAME_RE.test(r.companyName) &&
        !JUNK_SYMBOL_RE.test(r.symbol) &&
        !(exchange === 'LSE' && LSE_IOB_RE.test(r.symbol)),
    )
    .map<SymCandidate>((r) => ({
      code: r.symbol, // FMP symbols are Yahoo-style (AAPL, ENI.MI, 0700.HK)
      exchange,
      venue: r.exchangeShortName || exchange,
      name: r.companyName,
      currency: null, // screener has no currency — filled from the profile
      type: r.isEtf ? 'ETF' : 'Common Stock',
      isin: null, // filled from the profile
      countryIso: r.country || null,
      volume: r.volume ?? null,
    }));
  log.info(`${exchange}: ${raw.length} symbols → ${kept.length} common stock/ETF`);
  return kept;
}

// ---- Profiles ---------------------------------------------------------------

export interface FmpProfile {
  symbol: string;
  companyName?: string | null;
  marketCap?: number | null; // LOCAL currency (verified: ENI.MI in EUR)
  currency?: string | null;
  isin?: string | null;
  country?: string | null; // HQ domicile ISO (BABA → CN), NOT listing country
  isAdr?: boolean;
  isEtf?: boolean;
  isFund?: boolean;
  sector?: string | null;
  industry?: string | null;
  description?: string | null;
  website?: string | null;
  image?: string | null; // logo on FMP's CDN, public/hotlinkable — spec §5.6b card logo
  defaultImage?: boolean; // true = FMP's generic placeholder, not a real logo
  exchange?: string | null;
  isActivelyTrading?: boolean;
}

/**
 * Set when FMP hard-rejects calls (402/403: bandwidth cap or plan problem).
 * All subsequent profile/ETF fetches short-circuit to null; the orchestrator
 * checks this to stop scheduling work and flush what it has. (429s and 5xx
 * are transient and retried inside fetchJson instead.)
 */
export let hardStop = false;

function handleVendorError(err: unknown, label: string): null {
  if (err instanceof HttpError && (err.status === 402 || err.status === 403)) {
    if (!hardStop) log.warn(`FMP hard-rejected (${err.status}) — stopping fetches`);
    hardStop = true;
    return null;
  }
  log.warn(`skip ${label}: ${(err as Error).message}`);
  return null;
}

export async function fetchProfile(symbol: string): Promise<FmpProfile | null> {
  if (hardStop) return null;
  const key = requireFmp();
  try {
    await fmpLimiter.wait();
    const rows = await fetchJson<FmpProfile[]>(
      `${BASE}/profile?symbol=${encodeURIComponent(symbol)}&apikey=${key}`,
      { label: `profile ${symbol}` },
    );
    return rows?.[0] ?? null; // unknown symbols return []
  } catch (err) {
    return handleVendorError(err, `profile ${symbol}`);
  }
}

/** Merge profile facts into the screener candidate (dedup needs ISIN + ADR
 * flag). FMP returns empty strings, not nulls, for missing fields — normalize,
 * or ""-ISIN rows group as one giant "company". */
export function applyProfile(c: SymCandidate, p: FmpProfile): void {
  c.isin = p.isin?.trim() || null;
  c.currency = p.currency?.trim() || null;
  c.isAdr = p.isAdr ?? null;
  c.countryIso = p.country?.trim() || c.countryIso;
  c.capLocal = p.marketCap ?? null; // ghost-duplicate tiebreak (spec §4.1b rule 6)
}

// ---- ETF enrichment ---------------------------------------------------------

interface EtfInfo {
  assetClass?: string | null; // 'Equity' | 'Fixed Income' | … (missing for some cross-listed lines)
  assetsUnderManagement?: number | null; // in navCurrency — NOT the profile currency
  navCurrency?: string | null;
  holdingsCount?: number | null;
  domicile?: string | null; // ISO (IE for UCITS)
  website?: string | null;
  // Fund facts (spec §3, 2026-07-12) — same payload, previously discarded.
  etfCompany?: string | null; // issuer ("IShares")
  expenseRatio?: number | null; // percent units: 0.2 = 0.20% TER (live-verified SWDA.MI)
  avgVolume?: number | null; // average daily volume, shares
  inceptionDate?: string | null; // "YYYY-MM-DD"
  nav?: number | null; // in navCurrency
}

interface EtfHoldingRow {
  asset?: string | null; // constituent ticker
  name?: string | null;
  isin?: string | null;
  weightPercentage?: number | null;
}

interface SectorWeightRow {
  sector?: string | null;
  weightPercentage?: number | string | null; // number here…
}

interface CountryWeightRow {
  country?: string | null;
  weightPercentage?: number | string | null; // …but a "70.33%" STRING here (live-verified)
}

export interface EtfBundle {
  info: EtfInfo | null;
  holdings: EtfHoldingRow[];
  sectors: SectorWeightRow[];
  countries: CountryWeightRow[];
}

async function etfCall<T>(path: string, symbol: string): Promise<T | null> {
  if (hardStop) return null;
  const key = requireFmp();
  try {
    await fmpLimiter.wait();
    return await fetchJson<T>(
      `${BASE}/etf/${path}?symbol=${encodeURIComponent(symbol)}&apikey=${key}`,
      { label: `etf/${path} ${symbol}` },
    );
  } catch (err) {
    return handleVendorError(err, `etf/${path} ${symbol}`);
  }
}

/** Fetch the 4 ETF endpoints; each is best-effort (empty for some lines). */
export async function fetchEtfData(symbol: string): Promise<EtfBundle> {
  const [info, holdings, sectors, countries] = await Promise.all([
    etfCall<EtfInfo[]>('info', symbol),
    etfCall<EtfHoldingRow[]>('holdings', symbol),
    etfCall<SectorWeightRow[]>('sector-weightings', symbol),
    etfCall<CountryWeightRow[]>('country-weightings', symbol),
  ]);
  return {
    info: info?.[0] ?? null,
    holdings: holdings ?? [],
    sectors: sectors ?? [],
    countries: countries ?? [],
  };
}

/** Parse FMP weights: numbers pass through, "70.33%" strings are stripped. */
function num(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[%,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** Largest weight first; null weights sink below real values (incl. negative
 * ones — inverse ETFs carry negative swap weights). `|| 0` keeps nulls stable. */
function rankByWeight<T extends { weight: number | null }>(rows: T[], limit: number): T[] {
  return rows
    .sort((a, b) => ((b.weight ?? -Infinity) - (a.weight ?? -Infinity)) || 0)
    .slice(0, limit);
}

export function buildEtfPortfolio(etf: EtfBundle): EtfPortfolio | null {
  const top_holdings: EtfHolding[] = rankByWeight(
    etf.holdings
      .filter((h) => h.name || h.asset)
      .map((h) => ({
        symbol: h.asset ?? null,
        name: (h.name ?? h.asset ?? '').slice(0, 100),
        weight: num(h.weightPercentage),
      })),
    10,
  );
  const sector_weights: EtfPortfolioSlice[] = rankByWeight(
    etf.sectors
      .filter((s) => s.sector)
      .map((s) => ({ name: String(s.sector).slice(0, 80), weight: num(s.weightPercentage) })),
    12,
  );
  // FMP breaks regions down by country; that fills the region_weights slice.
  const region_weights: EtfPortfolioSlice[] = rankByWeight(
    etf.countries
      .filter((c) => c.country)
      .map((c) => ({ name: String(c.country).slice(0, 80), weight: num(c.weightPercentage) })),
    12,
  );

  const portfolio: EtfPortfolio = {};
  const holdingsCount = num(etf.info?.holdingsCount);
  if (holdingsCount != null) portfolio.holdings_count = holdingsCount;
  if (top_holdings.length) portfolio.top_holdings = top_holdings;
  if (sector_weights.length) portfolio.sector_weights = sector_weights;
  if (region_weights.length) portfolio.region_weights = region_weights;
  // No asset_allocation: FMP has no equivalent endpoint (spec §3 comment).

  // Fund facts (spec §3, 2026-07-12): expense ratio to the card metrics row,
  // the rest to the detailed-analysis "Fund facts" section. Absent → omitted.
  const info = etf.info;
  if (info) {
    const expense = num(info.expenseRatio);
    if (expense != null && expense >= 0) portfolio.expense_ratio = expense;
    const avgVol = num(info.avgVolume);
    if (avgVol != null && avgVol >= 0) portfolio.avg_volume = avgVol;
    if (info.inceptionDate) portfolio.inception_date = String(info.inceptionDate).slice(0, 10);
    const nav = num(info.nav);
    if (nav != null && nav > 0) {
      portfolio.nav = nav;
      if (info.navCurrency) portfolio.nav_currency = String(info.navCurrency).slice(0, 8);
    }
    if (info.etfCompany) portfolio.issuer = String(info.etfCompany).slice(0, 60);
    if (info.domicile) portfolio.domicile = String(info.domicile).slice(0, 8);
  }
  return Object.keys(portfolio).length ? portfolio : null;
}

// ---- Mapping ----------------------------------------------------------------

const BOND_RE = /\b(bond|treasur|gilt|fixed income|sovereign|govern|aggregate bond|corporate bond)\b/i;

// Italy-exposure ETF names (spec §4.1 country scope tag): the fund itself is
// usually IE/LU-domiciled, so the name is the only signal.
const ITALY_ETF_RE = /\b(ital(y|ia|ian)|ftse ?mib)\b/i;

/** Layered (spec §3): vendor assetClass when present, name regex otherwise. */
function isBondEtf(name: string, info: EtfInfo | null): boolean {
  if (info?.assetClass === 'Fixed Income') return true;
  return BOND_RE.test(name);
}

/** Map a deduped company + its profile (+ ETF bundle) into an AssetRow. */
export function toAssetRow(
  group: DedupGroup,
  profile: FmpProfile,
  etf: EtfBundle | null,
  fx: FxTable,
): AssetRow | null {
  const { canonical, secondaries } = group;
  const isEtf = (profile.isEtf ?? false) || canonical.type === 'ETF';

  // Market cap → USD. ETFs: fund-level AUM in navCurrency (profile.marketCap
  // is the listing line's number); stocks: profile cap in profile currency.
  const currency = profile.currency ?? canonical.currency ?? null;
  let capUsd: number | null;
  if (isEtf && etf?.info?.assetsUnderManagement) {
    capUsd = fx.toUsd(etf.info.assetsUnderManagement, etf.info.navCurrency ?? currency);
  } else {
    capUsd = fx.toUsd(profile.marketCap ?? null, currency);
  }

  // profile.country is already the HQ domicile (BABA → CN, §4.1a); the ETF
  // fund domicile (IE for UCITS) wins over the listing profile when present.
  const domicile =
    (isEtf ? etf?.info?.domicile : null) ??
    profile.country ??
    canonical.countryIso ??
    isinCountry(profile.isin ?? canonical.isin);
  const region: Region = regionForCountry(domicile);

  const bond = isEtf && isBondEtf(canonical.name, etf?.info ?? null);
  const kind: AssetRow['kind'] = bond ? 'bond' : isEtf ? 'etf' : 'stock';

  const name = profile.companyName ?? canonical.name;
  const categories: string[] = [];
  const etfPortfolio = isEtf && etf ? buildEtfPortfolio(etf) : null;
  if (isEtf) {
    if (bond) categories.push('bond-etf');
    if (region === 'eu' && /ucits/i.test(name)) categories.push('UCITS');
    // Holdings/sectors deliberately do NOT enter categories: they'd pollute
    // the curated scope tags and break the §5.2 semantic boost (schema §3).
  }
  // Country scope tag (spec §4.1): Italian-domiciled assets + Italy-exposure ETFs.
  if (domicile === 'IT' || (isEtf && ITALY_ETF_RE.test(name))) categories.push('Italy');

  // Noise floor: require a USD cap ≥ threshold (ETFs with AUM count too).
  if (capUsd == null || capUsd < MIN_CAP_USD) return null;

  const listings = secondaries.map((s) => ({
    exchange: s.venue,
    ticker: s.code,
    currency: s.currency,
  }));

  return {
    ticker: canonical.code, // FMP symbols are already display-ready (AAPL, ENI.MI)
    vendor_id: canonical.code,
    source: 'fmp',
    name,
    kind,
    region,
    exchange: canonical.venue,
    cex_venues: [],
    dex_venues: [],
    cap_class: capClass(capUsd),
    market_cap_usd: capUsd,
    isin: profile.isin ?? canonical.isin ?? null,
    listings,
    accessibility: 'open',
    sector: isEtf ? null : profile.sector ?? null,
    industry: isEtf ? null : profile.industry ?? null,
    categories,
    description: (profile.description ?? '').trim() || null,
    etf_portfolio: etfPortfolio,
    website_url: (profile.website ?? etf?.info?.website ?? '').trim() || null, // spec §5.6b
    logo_url: profile.defaultImage ? null : (profile.image ?? '').trim() || null,
    is_active: true,
    currency,
  };
}

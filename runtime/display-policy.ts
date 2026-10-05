/**
 * Data display policy (owner decision 2026-10-05): which third-party vendor
 * data each surface may show. Three env flags, all OFF by default (the safe
 * setting):
 *
 *   DISPLAY_FMP_DATA=1       show FMP-derived data for stocks, ETFs and bond
 *                            ETFs: price, changes, series, market cap, the fin
 *                            block, 52-week range, volume, ETF portfolio, the
 *                            vendor description and FMP-hosted logos. FMP needs
 *                            its Data Display and Licensing Agreement for that.
 *   DISPLAY_SACRA_DATA=1     show Sacra-derived pre-IPO data: valuation series,
 *                            valuation-based market cap, price per share and
 *                            the Sacra description.
 *   API_RELAY_MARKET_DATA=1  let /v1/* and MCP responses (and the X bot, whose
 *                            replies are public posts) carry third-party market
 *                            data, each market object with an `attribution`
 *                            string. Without it they carry none, plus a short
 *                            `market_note`.
 *
 * Channels: 'web' is the website (the browser /api/* routes and the same-origin
 * universe explorer). It keeps CoinGecko and GeckoTerminal data, which the
 * free terms allow with visible attribution (the UI renders it). 'api' is every
 * key-authenticated /v1/* caller, MCP and the X bot. Route handlers decide the
 * channel and pass it in; nothing here reads a request.
 *
 * Ticker, name, kind, region, exchange, sector and categories are always shown.
 * Pure: no network, no database, no request state.
 */
import type { MarketData } from './market.js';
import type { Candidate } from './candidates.js';
import type { UniverseAssetData, UniverseAssetRecord } from './universe.js';
import { clipBlurb, clipText } from './text.js';

export type Channel = 'web' | 'api';
export type Vendor = 'fmp' | 'sacra' | 'coingecko' | 'geckoterminal';

export interface DisplayFlags {
  /** DISPLAY_FMP_DATA=1 */
  fmp: boolean;
  /** DISPLAY_SACRA_DATA=1 */
  sacra: boolean;
  /** API_RELAY_MARKET_DATA=1 */
  apiRelay: boolean;
}

/** Read the three flags. Only the exact value 1 turns one on. */
export function displayFlags(env: Record<string, string | undefined> = process.env): DisplayFlags {
  const on = (v: string | undefined) => (v ?? '').trim() === '1';
  return { fmp: on(env.DISPLAY_FMP_DATA), sacra: on(env.DISPLAY_SACRA_DATA), apiRelay: on(env.API_RELAY_MARKET_DATA) };
}

/** The credit line each vendor's data carries in API responses (CoinGecko and
 * GeckoTerminal wording from their attribution guide). */
export const ATTRIBUTION: Record<Vendor, string> = {
  coingecko: 'Data provided by CoinGecko (https://www.coingecko.com/en/api)',
  geckoterminal: 'On-chain data provided by GeckoTerminal (https://www.geckoterminal.com)',
  fmp: 'Data provided by Financial Modeling Prep (https://financialmodelingprep.com)',
  sacra: 'Data provided by Sacra (https://sacra.com)',
};

/** API responses without relay rights. */
export const API_MARKET_NOTE =
  'Third-party market data (CoinGecko, GeckoTerminal, FMP, Sacra) is omitted under data-vendor terms.';

/** How long the asset's own enrichment text may run when it stands in for a vendor description. */
export const OWN_TEXT_CHARS = 500;

/** Which vendor's data a row carries: its source first, its kind as the
 * fallback. Legacy equity rows (source 'eodhd') and any unknown equity source
 * follow the FMP flag: an equity licence question either way. */
export function vendorOf(a: { source?: string | null; kind?: string | null }): Vendor {
  const source = String(a.source ?? '').trim().toLowerCase();
  if (source === 'coingecko') return 'coingecko';
  if (source === 'sacra') return 'sacra';
  if (source === 'fmp' || source === 'eodhd') return 'fmp';
  const kind = String(a.kind ?? '').trim().toLowerCase();
  if (kind === 'crypto') return 'coingecko';
  if (kind === 'private') return 'sacra';
  return 'fmp';
}

/** May this channel show this vendor's data at all? */
export function mayShow(vendor: Vendor, channel: Channel, flags: DisplayFlags): boolean {
  if (channel === 'api' && !flags.apiRelay) return false;
  if (vendor === 'fmp') return flags.fmp;
  if (vendor === 'sacra') return flags.sacra;
  return true; // CoinGecko and GeckoTerminal: displayed with attribution
}

/** Vendor descriptions, ETF portfolios and the analysis prompt's vendor text
 * follow the FMP and Sacra flags only (they are not market objects). */
export function vendorTextAllowed(vendor: Vendor, flags: DisplayFlags): boolean {
  if (vendor === 'fmp') return flags.fmp;
  if (vendor === 'sacra') return flags.sacra;
  return true;
}

/** Skip the live market lookup for a row this channel could not show anyway:
 * no FMP call for a withheld equity, no CoinGecko call without relay rights. */
export function shouldFetchMarket(a: { source?: string | null; kind?: string | null }, channel: Channel, flags: DisplayFlags): boolean {
  return mayShow(vendorOf(a), channel, flags);
}

/** The vendor whose CDN hosts a logo, or null for self-hosted and company
 * hosts (our own storage bucket, a company site). */
export function logoVendor(url: string | null | undefined): Vendor | null {
  if (!url) return null;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  const on = (domain: string) => host === domain || host.endsWith(`.${domain}`);
  if (on('financialmodelingprep.com')) return 'fmp';
  if (on('coingecko.com')) return 'coingecko';
  if (on('geckoterminal.com')) return 'geckoterminal';
  if (on('sacra.com')) return 'sacra';
  return null;
}

/** A logo URL the channel may show, or null. An unparseable URL is dropped. */
export function displayLogo(url: string | null | undefined, channel: Channel, flags: DisplayFlags): string | null {
  if (!url) return null;
  try {
    new URL(url);
  } catch {
    return null;
  }
  const vendor = logoVendor(url);
  return vendor && !mayShow(vendor, channel, flags) ? null : url;
}

/** The asset's own enrichment text, clipped at a word boundary, or null. */
export function ownText(enrichment: string | null | undefined, max = OWN_TEXT_CHARS): string | null {
  const t = String(enrichment ?? '').replace(/\s+/g, ' ').trim();
  return t ? clipText(t, max) : null;
}

/** A market object the channel may show (with its attribution on the API), or null. */
export function displayMarket<M extends object>(
  vendor: Vendor,
  market: M | null | undefined,
  channel: Channel,
  flags: DisplayFlags,
): (M & { attribution?: string }) | null {
  if (!market || !mayShow(vendor, channel, flags)) return null;
  return channel === 'api' ? { ...market, attribution: ATTRIBUTION[vendor] } : market;
}

/** The vendor-dependent fields of one run pick (server/run.ts). */
export interface PickSource {
  source?: string | null;
  kind?: string | null;
  market?: MarketData | null;
  /** Vendor description prefix (the candidate blurb). */
  blurb?: string | null;
  /** The asset's own LLM enrichment text (assets.enrichment). */
  enrichment?: string | null;
  etf_portfolio?: unknown;
  logo?: string | null;
}

export interface PickDisplay {
  market: (MarketData & { attribution?: string }) | null;
  /** True when this pick's market data is not shown on this channel (the card
   * renders its empty state; the result carries market_note). */
  market_withheld: boolean;
  about: string | null;
  etf_portfolio: unknown;
  logo: string | null;
}

/** May this channel show the vendor's own descriptive text? On the API without
 * API_RELAY_MARKET_DATA, no vendor's text is relayed (CoinGecko included); the
 * asset's own enrichment text stands in, as it does for FMP and Sacra. */
export function vendorTextShown(vendor: Vendor, channel: Channel, flags: DisplayFlags): boolean {
  if (channel === 'api' && !flags.apiRelay) return false;
  return vendorTextAllowed(vendor, flags);
}

export function presentPickData(p: PickSource, channel: Channel, flags: DisplayFlags): PickDisplay {
  const vendor = vendorOf(p);
  const textOk = vendorTextShown(vendor, channel, flags);
  return {
    market: displayMarket(vendor, p.market ?? null, channel, flags),
    market_withheld: !mayShow(vendor, channel, flags),
    about: textOk ? (p.blurb ? clipBlurb(p.blurb) : null) : ownText(p.enrichment),
    etf_portfolio: textOk ? (p.etf_portfolio ?? null) : null,
    logo: displayLogo(p.logo, channel, flags),
  };
}

/** What the website says when the flags hold equity or pre-IPO data back. */
export function webMarketNote(flags: DisplayFlags): string | null {
  if (!flags.fmp && !flags.sacra) return 'Market data for stocks, ETFs and pre-IPO companies is not shown on this site.';
  if (!flags.fmp) return 'Market data for stocks and ETFs is not shown on this site.';
  if (!flags.sacra) return 'Market data for pre-IPO companies is not shown on this site.';
  return null;
}

/** API responses with relay rights that still hold equity or pre-IPO data back. */
function apiPartialNote(flags: DisplayFlags): string | null {
  if (!flags.fmp && !flags.sacra) return 'Market data for stocks, ETFs and pre-IPO companies is omitted under data-vendor terms.';
  if (!flags.fmp) return 'Market data for stocks and ETFs is omitted under data-vendor terms.';
  if (!flags.sacra) return 'Market data for pre-IPO companies is omitted under data-vendor terms.';
  return null;
}

/** The run result's market_note: always on an API run without relay rights;
 * otherwise only when a pick of this run actually had data withheld. */
export function runMarketNote(channel: Channel, flags: DisplayFlags, picks: { market_withheld: boolean }[]): string | null {
  if (channel === 'api' && !flags.apiRelay) return API_MARKET_NOTE;
  if (!picks.some((p) => p.market_withheld)) return null;
  return channel === 'web' ? webMarketNote(flags) : apiPartialNote(flags);
}

// ---- tradable universe (/v1/universe/:name/assets) ----------------------------

export const UNIVERSE_WEB_NOTE = 'Market cap, fundamentals and price history for these stocks and ETFs are not shown on this site.';
const UNIVERSE_API_FMP_NOTE = 'Market cap, fundamentals and price history for these stocks and ETFs are omitted under data-vendor terms.';

/** The universe payload's market_note: GeckoTerminal DEX data is the only
 * vendor market data the web explorer keeps; equity fields follow the FMP flag. */
export function universeMarketNote(channel: Channel, flags: DisplayFlags): string | null {
  if (channel === 'api' && !flags.apiRelay) return API_MARKET_NOTE;
  if (flags.fmp) return null;
  return channel === 'web' ? UNIVERSE_WEB_NOTE : UNIVERSE_API_FMP_NOTE;
}

/** Credit lines for a universe API response: the vendors whose data it carries. */
export function universeAttribution(channel: Channel, flags: DisplayFlags): string[] | null {
  if (channel !== 'api' || !flags.apiRelay) return null;
  return [ATTRIBUTION.geckoterminal, ...(flags.fmp ? [ATTRIBUTION.fmp] : [])];
}

/** The public universe asset for this channel, built field by field so the
 * record's internal inputs (source, enrichment) can never leak. Venue quotes
 * (Robinhood), onchain state, the Chainlink oracle, corporate actions and
 * holder counts are not vendor market data under this policy and stay. */
export function presentUniverseAsset(rec: UniverseAssetRecord, channel: Channel, flags: DisplayFlags): UniverseAssetData {
  const vendor = vendorOf({ source: rec.source, kind: rec.kind });
  const equity = mayShow(vendor, channel, flags);
  const dexOk = rec.dex != null && mayShow('geckoterminal', channel, flags);
  return {
    ticker: rec.ticker,
    name: rec.name,
    kind: rec.kind,
    region: rec.region,
    sector: rec.sector,
    categories: rec.categories,
    about: vendorTextShown(vendor, channel, flags) ? rec.about : ownText(rec.enrichment),
    website: rec.website,
    logo: displayLogo(rec.logo, channel, flags),
    contract: rec.contract,
    holders: rec.holders,
    marketCapUsd: equity ? rec.marketCapUsd : null,
    currency: rec.currency,
    metrics: equity ? rec.metrics : null,
    asOf: equity ? rec.asOf : null,
    quote: rec.quote,
    dex: dexOk && rec.dex ? (channel === 'api' ? { ...rec.dex, attribution: ATTRIBUTION.geckoterminal } : rec.dex) : null,
    onchain: rec.onchain,
    events: rec.events,
    spark30d: equity ? rec.spark30d : null,
    portfolio: vendorTextShown(vendor, channel, flags) ? rec.portfolio : null,
  };
}

/** The single-asset endpoint's full description: the vendor text when it may
 * be shown, else the asset's own enrichment text (unclipped). */
export function fullUniverseAbout(
  full: { description: string | null; enrichment: string | null; source: string | null; kind: string | null },
  channel: Channel,
  flags: DisplayFlags,
): string | null {
  const vendor = vendorOf({ source: full.source, kind: full.kind });
  const text = vendorTextShown(vendor, channel, flags) ? full.description : full.enrichment;
  return text?.trim() ? text : null;
}

/** The response's per-family refresh times, without the DEX one when DEX data is withheld. */
export function presentUniverseAsOf<T extends { dex: string | null }>(asOf: T, channel: Channel, flags: DisplayFlags): T {
  return mayShow('geckoterminal', channel, flags) ? asOf : { ...asOf, dex: null };
}

// ---- prompt hygiene (the analysis and the select rationale are shown to users) ----

/** True when some vendor's data is held back, so user-visible model output
 * must not be fed (or quote) that vendor's figures and text. */
export function promptHygieneActive(flags: DisplayFlags): boolean {
  return !flags.fmp || !flags.sacra;
}

/** One instruction for the select prompt: its "w" rationale is shown as written. */
export const SELECT_RATIONALE_RULE =
  'The "w" text is shown to users as written: do not quote prices, financial ratios, market caps, valuations, AUM figures or holding weights in it.\n';

/** What the analysis prompt may read for one pick under hygiene. */
export interface AnalysisHygiene {
  flags: DisplayFlags;
  /** assets.enrichment by asset id (the asset's own LLM text). */
  ownText: Map<number, string | null>;
}

/** Does this candidate's vendor text and size data stay out of the analysis prompt? */
export function analysisNeedsHygiene(a: Pick<Candidate, 'kind'>, hygiene: AnalysisHygiene | null | undefined): boolean {
  return hygiene ? !vendorTextAllowed(vendorOf({ kind: a.kind }), hygiene.flags) : false;
}

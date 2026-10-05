import { env } from '../lib/env.js';
import { fetchJson } from '../lib/http.js';
import { log, sleep } from '../lib/log.js';
import { capClass } from '../lib/caps.js';
import type { AssetRow } from '../lib/supabase.js';

const CG = 'https://api.coingecko.com/api/v3';

// Free tier has no key; a demo/pro key raises limits and changes the header.
function cgHeaders(): Record<string, string> {
  const h: Record<string, string> = { accept: 'application/json' };
  if (env.COINGECKO_KEY) h['x-cg-demo-api-key'] = env.COINGECKO_KEY;
  return h;
}

// Pace between calls. Demo key = 30 calls/min hard cap → 2.1s spacing;
// keyless public tier is unpredictable, keep 1.5s + rely on 429 backoff.
const PACE_MS = env.COINGECKO_KEY ? 2100 : 1500;

interface CgMarket {
  id: string;
  symbol: string;
  name: string;
  image: string | null; // coin logo on CoinGecko's CDN — spec §5.6b card logo
  market_cap: number | null;
  total_volume: number | null; // 24h trading volume, USD (vs_currency=usd) — spec §5.2 liquidity screen
}

interface CgTicker {
  base: string;
  target: string;
  market: { name: string; identifier: string };
}

interface CgCoinDetail {
  id: string;
  symbol: string;
  name: string;
  categories: (string | null)[];
  description: { en?: string };
  links?: { homepage?: (string | null)[] };
  tickers: CgTicker[];
}

/** First non-empty homepage URL from a CoinGecko coin detail (spec §5.6b). */
function homepageUrl(detail: CgCoinDetail | null): string | null {
  const raw = (detail?.links?.homepage ?? []).map((h) => (h ?? '').trim()).find(Boolean);
  return raw || null;
}

/**
 * DEX registry (spec §4.2): exchange identifiers considered decentralized.
 * Anything NOT matching lands in cex_venues. Matched by substring on the
 * CoinGecko market.identifier (e.g. "uniswap_v3", "pancakeswap-new").
 */
const DEX_IDENTIFIER_PATTERNS = [
  'uniswap', 'sushiswap', 'pancakeswap', 'curve', 'balancer', 'aerodrome',
  'velodrome', 'quickswap', 'trader_joe', 'traderjoe', 'raydium', 'orca',
  'camelot', 'gmx', 'dydx', 'jupiter', 'meteora', 'osmosis', 'thorchain',
  'dodo', 'kyber', 'bancor', 'shibaswap', 'spookyswap', 'spiritswap',
  'honeyswap', 'biswap', 'apeswap', 'baseswap', 'ramses', 'maverick',
  'pangolin', 'joe_', 'hyperliquid', 'vertex', 'drift', 'phoenix', '_dex',
  'swap_', '_swap', 'fusion',
];

function isDex(identifier: string): boolean {
  const id = identifier.toLowerCase();
  return DEX_IDENTIFIER_PATTERNS.some((p) => id.includes(p));
}

/** Paginate /coins/markets to the requested depth (by market cap desc). */
export async function fetchTopMarkets(topN: number): Promise<CgMarket[]> {
  const perPage = 250;
  const pages = Math.ceil(topN / perPage);
  const out: CgMarket[] = [];
  for (let page = 1; page <= pages; page++) {
    const url =
      `${CG}/coins/markets?vs_currency=usd&order=market_cap_desc` +
      `&per_page=${perPage}&page=${page}&sparkline=false`;
    const batch = await fetchJson<CgMarket[]>(url, { headers: cgHeaders(), label: `cg markets p${page}` });
    out.push(...batch);
    log.info(`markets page ${page}/${pages} → ${batch.length} coins (total ${out.length})`);
    if (batch.length < perPage) break;
    await sleep(PACE_MS);
  }
  // Ranks shift between page fetches, so the same coin can appear on two pages;
  // duplicate (source, vendor_id) rows in one upsert make Postgres error with
  // "ON CONFLICT DO UPDATE command cannot affect row a second time".
  const seen = new Set<string>();
  const deduped = out.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
  if (deduped.length < out.length) log.info(`deduped ${out.length - deduped.length} repeated coins across pages`);
  return deduped.slice(0, topN);
}

/** Fetch per-coin detail: categories, description, venue split from tickers. */
export async function fetchCoinDetail(id: string): Promise<CgCoinDetail | null> {
  const url =
    `${CG}/coins/${id}?localization=false&tickers=true&market_data=false` +
    `&community_data=false&developer_data=false&sparkline=false`;
  try {
    return await fetchJson<CgCoinDetail>(url, { headers: cgHeaders(), label: `cg coin ${id}` });
  } catch (err) {
    log.warn(`skip coin ${id}: ${(err as Error).message}`);
    return null;
  }
}

function splitVenues(tickers: CgTicker[]): { cex: string[]; dex: string[] } {
  const cex = new Set<string>();
  const dex = new Set<string>();
  for (const t of tickers) {
    const name = t.market?.name?.trim();
    const ident = t.market?.identifier ?? '';
    if (!name) continue;
    if (isDex(ident)) dex.add(name);
    else cex.add(name);
  }
  return { cex: [...cex], dex: [...dex] };
}

/** Map a CoinGecko market + detail into an AssetRow (spec §4.2). */
export function toAssetRow(m: CgMarket, detail: CgCoinDetail | null): AssetRow {
  const categories = (detail?.categories ?? []).filter((c): c is string => !!c);
  const { cex, dex } = detail ? splitVenues(detail.tickers ?? []) : { cex: [], dex: [] };
  const description = (detail?.description?.en ?? '').trim() || null;
  return {
    ticker: m.symbol.toUpperCase(),
    vendor_id: m.id,
    source: 'coingecko',
    name: m.name,
    kind: 'crypto',
    region: 'global',
    exchange: null,
    cex_venues: cex,
    dex_venues: dex,
    cap_class: capClass(m.market_cap),
    market_cap_usd: m.market_cap ?? null,
    volume_24h_usd: m.total_volume ?? null,
    isin: null,
    listings: [],
    accessibility: 'open',
    sector: categories[0] ?? null, // CoinGecko primary category (spec §3)
    industry: null,
    categories,
    description,
    website_url: homepageUrl(detail),
    logo_url: (m.image ?? '').trim() || null,
    is_active: true,
    currency: 'USD',
  };
}

export { PACE_MS };

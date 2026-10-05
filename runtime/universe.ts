/**
 * Tradable-universe registries (spec §16): a universe is a fixed allowlist of
 * assets that exist as tradable tokens on an external venue. A screen run with
 * a universe set skips embedding retrieval entirely — the whole universe IS
 * the candidate pool (it fits the normal 100-candidate budget), so /select
 * reasons over exactly the allowed set and nothing else. Picks map back to the
 * venue's token contract in the run payload, so a downstream execution agent
 * receives addresses it can trade, never bare tickers to resolve.
 *
 * Registries are generated files (npm run universe:robinhood — see
 * ingest/robinhood-universe.ts): symbols and contract addresses come from the
 * venue's canonical published list and are verified against the chain explorer
 * at generation time. The screen itself still runs on the UNDERLYING listed
 * equities in the assets table — tokenized-clone crypto rows stay excluded
 * like everywhere else (§5.2).
 */
import { supabase } from '../ingest/lib/supabase.js';
import { log } from '../ingest/lib/log.js';
import type { Candidate } from './candidates.js';
import { clipText } from './text.js';
import { normWebsite } from './links.js';
import robinhoodChain from './universe/robinhood-chain.json' with { type: 'json' };

export interface UniverseToken {
  symbol: string;
  name: string;
  address: string;
  decimals: number;
  kind: string;
  /** Token holder count at generation time — a coarse onchain liquidity prior. */
  holders: number | null;
  logoUrl?: string | null;
}

export interface UniverseRegistry {
  version: number;
  chain: string;
  chainId: number;
  explorerBase: string;
  source: string;
  generatedAt: string;
  core: { symbol: string; name: string; address: string; decimals: number }[];
  assets: UniverseToken[];
}

export const UNIVERSES = {
  robinhood: robinhoodChain as UniverseRegistry,
} as const;

export type UniverseName = keyof typeof UNIVERSES;

export function isUniverseName(v: unknown): v is UniverseName {
  return typeof v === 'string' && v in UNIVERSES;
}

/** Token entry for a picked ticker, or null when the ticker left the universe
 * (never expected for universe-mode picks; the null keeps the payload honest). */
export function universeToken(name: UniverseName, ticker: string): (UniverseToken & { chainId: number; chain: string; explorer: string }) | null {
  const reg = UNIVERSES[name];
  const t = reg.assets.find((a) => a.symbol.toUpperCase() === ticker.toUpperCase());
  if (!t) return null;
  return { ...t, chainId: reg.chainId, chain: reg.chain, explorer: reg.explorerBase + t.address };
}

/** Tradability of the UNDERLYING equity per session, as the venue publishes
 * it: `TRADING_STATUS_` prefixes stripped and lowercased (`tradable`,
 * `untradable`, ...). The venue docs describe a flatter shape than the API
 * serves; we pass through the live shape. */
export interface VenueSessions {
  market: { whole: string | null; fractional: string | null };
  extended: { whole: string | null; fractional: string | null };
  overnight: { whole: string | null; fractional: string | null };
}

/** Live venue quote for one token, from Robinhood's public price API. Raw
 * underlying bid/ask passed through as the venue serves it — NOT
 * multiplier-adjusted; the multiplier rides along so consumers apply it per
 * the venue's docs. mintBurnUsd is the day's onchain creation/redemption
 * flow, the truest venue-side activity signal we have. */
export interface VenueQuote {
  bid: number | null;
  ask: number | null;
  currency: string | null;
  dailyHigh: number | null;
  dailyLow: number | null;
  /** Underlying equity's session volume (shares), passed through by the venue. */
  underlyingVolume: number | null;
  /** Onchain mint/burn flow for the token, USD, current day. */
  mintBurnUsd: number | null;
  halted: boolean;
  /** Shares per token as the venue publishes it; null when the venue does
   * not report one (never a default of 1: a wrong 1 misprices split tokens). */
  multiplier: number | null;
  /** Scheduled corporate-action multiplier change; null when none pending. */
  pendingMultiplier: number | null;
  pendingMultiplierEffectiveAt: string | null;
  sessions: VenueSessions | null;
  generatedAt: string | null;
}

interface QuoteCache {
  at: number;
  quotes: Map<string, VenueQuote>;
}

const RHJ_BASE = 'https://api.robinhood.com/rhj';
/** Every venue/DEX/RPC call is bounded (review R3): these run on request paths
 * and in the 60s warmer, where a hung socket would pile up behind each tick. */
const vendorTimeout = () => AbortSignal.timeout(15_000);
const QUOTES_TTL_MS = 30_000; // venue caches 15s; agents/browsers poll freely
const ASSET_INFO_TTL_MS = 300_000;
let quoteCache: QuoteCache | null = null;

const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** '' means "none pending" at the venue — distinct from an unparsable value. */
const optNum = (v: unknown): number | null => (v == null || v === '' ? null : num(v));

/** A shares-per-token multiplier: positive and finite, else unknown (null). */
const multiplierOrNull = (v: unknown): number | null => {
  const n = optNum(v);
  return n != null && n > 0 ? n : null;
};

const tradingStatus = (v: unknown): string | null =>
  typeof v === 'string' && v ? v.replace(/^TRADING_STATUS_/, '').toLowerCase() : null;

/** Venue asset state that isn't a price: multiplier (current + pending) and
 * per-session tradability of the underlying. One /rhj/assets call, cached. */
interface VenueAssetInfo {
  multiplier: number | null;
  pendingMultiplier: number | null;
  pendingMultiplierEffectiveAt: string | null;
  sessions: VenueSessions | null;
}

let assetInfoCache: { at: number; bySymbol: Map<string, VenueAssetInfo> } | null = null;

async function venueAssetInfo(): Promise<Map<string, VenueAssetInfo>> {
  if (assetInfoCache && Date.now() - assetInfoCache.at < ASSET_INFO_TTL_MS) return assetInfoCache.bySymbol;
  const res = await fetch(`${RHJ_BASE}/assets`, { headers: { accept: 'application/json' }, signal: vendorTimeout() });
  if (!res.ok) throw new Error(`rhj/assets HTTP ${res.status}`);
  const body = (await res.json()) as {
    assets?: {
      tokenSymbol?: string;
      currentMultiplier?: string;
      pendingMultiplier?: string;
      pendingMultiplierEffectiveTime?: string;
      tradingCapabilities?: Record<string, { whole?: string; fractional?: string }>;
    }[];
  };
  const bySymbol = new Map<string, VenueAssetInfo>();
  for (const a of body.assets ?? []) {
    if (!a.tokenSymbol) continue;
    const caps = a.tradingCapabilities;
    const session = (k: string) => ({ whole: tradingStatus(caps?.[k]?.whole), fractional: tradingStatus(caps?.[k]?.fractional) });
    bySymbol.set(a.tokenSymbol.toUpperCase(), {
      // Absent, empty or non-positive = unknown, never 1 (sail-agent applies the same rule).
      multiplier: multiplierOrNull(a.currentMultiplier),
      pendingMultiplier: optNum(a.pendingMultiplier),
      pendingMultiplierEffectiveAt: a.pendingMultiplierEffectiveTime || null,
      sessions: caps ? { market: session('market'), extended: session('extended'), overnight: session('overnight') } : null,
    });
  }
  assetInfoCache = { at: Date.now(), bySymbol };
  return bySymbol;
}

/**
 * All live token quotes in one venue call (GET /rhj/prices with no symbol
 * returns the whole board — undocumented but stable), cached briefly
 * in-process. Throws on venue failure; callers degrade to null quotes rather
 * than fabricating (§5.6 doctrine).
 */
export async function venueQuotes(name: UniverseName): Promise<Map<string, VenueQuote>> {
  if (name !== 'robinhood') return new Map();
  if (quoteCache && Date.now() - quoteCache.at < QUOTES_TTL_MS) return quoteCache.quotes;
  try {
    return await venueQuotesFresh();
  } catch (err) {
    if (quoteCache && Date.now() - quoteCache.at < 15 * 60_000) {
      log.warn(`venue quotes fetch failed, serving stale: ${(err as Error).message}`);
      return quoteCache.quotes;
    }
    throw err;
  }
}

async function venueQuotesFresh(): Promise<Map<string, VenueQuote>> {
  const [res, infoBySymbol] = await Promise.all([
    fetch(`${RHJ_BASE}/prices`, { headers: { accept: 'application/json' }, signal: vendorTimeout() }),
    venueAssetInfo(),
  ]);
  if (!res.ok) throw new Error(`rhj/prices HTTP ${res.status}`);
  const body = (await res.json()) as { quotes?: Record<string, unknown>[] };
  const quotes = new Map<string, VenueQuote>();
  for (const q of body.quotes ?? []) {
    const symbol = String(q.tokenSymbol ?? '').toUpperCase();
    if (!symbol) continue;
    const info = infoBySymbol.get(symbol);
    quotes.set(symbol, {
      bid: num(q.bid),
      ask: num(q.ask),
      currency: typeof q.currency === 'string' && q.currency ? q.currency : null,
      dailyHigh: num(q.dailyHigh),
      dailyLow: num(q.dailyLow),
      underlyingVolume: num(q.dailyTradingVolume),
      mintBurnUsd: num(q.mintBurnUsdVolume),
      halted: q.isTradingHalt === true,
      multiplier: info?.multiplier ?? null,
      pendingMultiplier: info?.pendingMultiplier ?? null,
      pendingMultiplierEffectiveAt: info?.pendingMultiplierEffectiveAt ?? null,
      sessions: info?.sessions ?? null,
      generatedAt: typeof q.generatedAt === 'string' ? q.generatedAt : null,
    });
  }
  quoteCache = { at: Date.now(), quotes };
  return quotes;
}

/** Onchain DEX aggregates for one token (GeckoTerminal, network `robinhood`):
 * the price the token ACTUALLY trades at in Uniswap pools, its pooled
 * liquidity, and 24h DEX volume. Distinct from VenueQuote, which passes
 * through the UNDERLYING equity's bid/ask from traditional markets — the
 * spread between the two is the onchain premium/discount. */
export interface DexData {
  /** Onchain trade price, USD (GeckoTerminal aggregated across pools). */
  priceUsd: number | null;
  /** Total pooled liquidity for the token across DEX pools, USD. */
  tvlUsd: number | null;
  /** 24h DEX trading volume, USD. */
  volume24hUsd: number | null;
}

const GECKO_TERMINAL = 'https://api.geckoterminal.com/api/v2/networks/robinhood/tokens/multi/';

/** GeckoTerminal blocks beyond the per-minute window under sustained 429s —
 * keep hitting it and the block extends. After a 429, every GeckoTerminal
 * call sits out this cooldown (stale-serving covers the gap). */
let geckoCooldownUntil = 0;
const GECKO_COOLDOWN_MS = 5 * 60_000;
const geckoGate = () => {
  if (Date.now() < geckoCooldownUntil) throw new Error('geckoterminal cooling down after 429');
};
const noteGecko429 = (status: number) => {
  if (status === 429) geckoCooldownUntil = Date.now() + GECKO_COOLDOWN_MS;
};
// Matches the warmer's dex cadence: requests between warms serve the cache
// instead of re-hitting the free tier (a refresh costs 4 batched calls).
const DEX_TTL_MS = 4 * 60_000;
/** DEX numbers move slowly at this scale; a legend-labeled 6h-old snapshot
 * beats dashes during a long GeckoTerminal outage (spec §16.1, 2026-07-31). */
const DEX_STALE_MAX_MS = 6 * 3600_000;
let dexCache: { at: number; byAddress: Map<string, DexData> } | null = null;

/** DEX aggregates for every universe token, batched 30 addresses per call and
 * cached briefly. Falls back to the Supabase-persisted snapshot when the
 * in-process cache is empty (fresh boot); throws only once every fallback is
 * exhausted, and callers degrade to null (§5.6). */
export async function dexData(name: UniverseName): Promise<Map<string, DexData>> {
  if (name !== 'robinhood') return new Map();
  if (dexCache && Date.now() - dexCache.at < DEX_TTL_MS) return dexCache.byAddress;
  if (!dexCache) await loadDexSnapshot(name);
  try {
    return await dexDataFresh(name);
  } catch (err) {
    if (dexCache && Date.now() - dexCache.at < DEX_STALE_MAX_MS) {
      log.warn(`dex data fetch failed, serving stale: ${(err as Error).message}`);
      return dexCache.byAddress;
    }
    throw err;
  }
}

/** Boot/outage fallback (spec §16.1, 2026-07-31): the last good DEX snapshot
 * persisted in universe_cache. Loaded at most once per process; best-effort —
 * a missing table or row only warns. */
let dexSnapshotLoadTried = false;
async function loadDexSnapshot(name: UniverseName): Promise<void> {
  if (dexSnapshotLoadTried) return;
  dexSnapshotLoadTried = true;
  try {
    const { data, error } = await supabase.from('universe_cache').select('payload, updated_at').eq('key', `${name}:dex`).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return;
    const at = Date.parse(data.updated_at as string);
    if (!Number.isFinite(at) || Date.now() - at > DEX_STALE_MAX_MS) return; // too old: honest nulls beat ancient prices
    const entries = Object.entries((data.payload ?? {}) as Record<string, DexData>);
    if (!entries.length) return;
    // Never shadow a newer in-process snapshot (a concurrent fetch may have won).
    if (!dexCache || dexCache.at < at) {
      dexCache = { at, byAddress: new Map(entries) };
      log.info(`dex snapshot loaded from universe_cache (${entries.length} tokens, ${new Date(at).toISOString()})`);
    }
  } catch (err) {
    log.warn(`dex snapshot load failed (continuing without): ${(err as Error).message}`);
  }
}

let dexSnapshotSavedAt = 0;
const DEX_SNAPSHOT_MIN_INTERVAL_MS = 5 * 60_000;
function persistDexSnapshot(name: UniverseName, byAddress: Map<string, DexData>): void {
  if (Date.now() - dexSnapshotSavedAt < DEX_SNAPSHOT_MIN_INTERVAL_MS) return;
  dexSnapshotSavedAt = Date.now();
  void supabase
    .from('universe_cache')
    .upsert({ key: `${name}:dex`, payload: Object.fromEntries(byAddress), updated_at: new Date().toISOString() })
    .then(({ error }) => {
      if (error) log.warn(`dex snapshot persist failed: ${error.message}`);
    });
}

async function dexDataFresh(name: UniverseName): Promise<Map<string, DexData>> {
  geckoGate();
  const addresses = UNIVERSES[name].assets.map((a) => a.address);
  const byAddress = new Map<string, DexData>();
  for (let i = 0; i < addresses.length; i += 30) {
    const batch = addresses.slice(i, i + 30);
    const res = await fetch(GECKO_TERMINAL + batch.join(','), { headers: { accept: 'application/json' }, signal: vendorTimeout() });
    if (!res.ok) {
      noteGecko429(res.status);
      throw new Error(`geckoterminal HTTP ${res.status}`);
    }
    const body = (await res.json()) as {
      data?: { attributes?: { address?: string; price_usd?: string; volume_usd?: { h24?: string }; total_reserve_in_usd?: string } }[];
    };
    for (const t of body.data ?? []) {
      const a = t.attributes;
      if (!a?.address) continue;
      byAddress.set(a.address.toLowerCase(), {
        priceUsd: a.price_usd != null ? Number(a.price_usd) : null,
        tvlUsd: a.total_reserve_in_usd != null ? Number(a.total_reserve_in_usd) : null,
        volume24hUsd: a.volume_usd?.h24 != null ? Number(a.volume_usd.h24) : null,
      });
    }
  }
  dexCache = { at: Date.now(), byAddress };
  persistDexSnapshot(name, byAddress);
  return byAddress;
}

/**
 * Onchain daily price history for one token (spec §16.1 chart): its top
 * GeckoTerminal pool's daily OHLCV. Lazily fetched per symbol so browsing the
 * table costs zero GeckoTerminal calls; pool discovery cached 24h, candles
 * 30min, both in-process. History is short-lived by nature (the chain
 * launched 2026-07-01) and grows daily. Null = no pool or no candles; throws
 * on vendor failure so the endpoint can degrade explicitly (§5.6).
 */
export interface OnchainChart {
  pool: string;
  /** Oldest first. */
  points: { t: string; o: number; h: number; l: number; c: number; volUsd: number | null }[];
}

const GECKO_BASE = 'https://api.geckoterminal.com/api/v2/networks/robinhood';
const POOL_TTL_MS = 24 * 3_600_000;
const CHART_TTL_MS = 30 * 60_000;
const poolCache = new Map<string, { at: number; pool: string | null; side: 'base' | 'quote' }>();
const chartCache = new Map<string, { at: number; chart: OnchainChart | null }>();

export async function onchainChart(name: UniverseName, symbol: string): Promise<OnchainChart | null> {
  if (name !== 'robinhood') return null;
  const token = UNIVERSES[name].assets.find((a) => a.symbol.toUpperCase() === symbol.toUpperCase());
  if (!token) return null;
  const key = token.symbol.toUpperCase();
  const cached = chartCache.get(key);
  if (cached && Date.now() - cached.at < CHART_TTL_MS) return cached.chart;

  let poolEntry = poolCache.get(key);
  if (!poolEntry || Date.now() - poolEntry.at > POOL_TTL_MS) {
    geckoGate();
    const res = await fetch(`${GECKO_BASE}/tokens/${token.address}/pools`, { headers: { accept: 'application/json' }, signal: vendorTimeout() });
    if (!res.ok) {
      noteGecko429(res.status);
      throw new Error(`geckoterminal pools HTTP ${res.status}`);
    }
    const body = (await res.json()) as {
      data?: { attributes?: { address?: string }; relationships?: { base_token?: { data?: { id?: string } } } }[];
    };
    const top = body.data?.[0];
    // The candles follow the pool's BASE token by default; when our token is
    // the quote side (USDG/aapl pools exist), ask for the quote series or the
    // chart would be USDG at $1.00.
    const baseId = top?.relationships?.base_token?.data?.id ?? '';
    const side: 'base' | 'quote' = baseId.toLowerCase().endsWith(token.address.toLowerCase()) ? 'base' : 'quote';
    poolEntry = { at: Date.now(), pool: top?.attributes?.address ?? null, side };
    poolCache.set(key, poolEntry);
  }
  if (!poolEntry.pool) {
    chartCache.set(key, { at: Date.now(), chart: null });
    return null;
  }

  geckoGate();
  const res = await fetch(`${GECKO_BASE}/pools/${poolEntry.pool}/ohlcv/day?aggregate=1&limit=60&token=${poolEntry.side}`, {
    headers: { accept: 'application/json' },
    signal: vendorTimeout(),
  });
  if (!res.ok) {
    noteGecko429(res.status);
    throw new Error(`geckoterminal ohlcv HTTP ${res.status}`);
  }
  const body = (await res.json()) as { data?: { attributes?: { ohlcv_list?: [number, number, number, number, number, number][] } } };
  const list = body.data?.attributes?.ohlcv_list ?? [];
  const points = list
    .map(([ts, o, h, l, c, vol]) => ({
      t: new Date(ts * 1000).toISOString().slice(0, 10),
      o: Number(o),
      h: Number(h),
      l: Number(l),
      c: Number(c),
      volUsd: Number.isFinite(Number(vol)) ? Number(vol) : null,
    }))
    .reverse();
  const chart = points.length ? { pool: poolEntry.pool, points } : null;
  chartCache.set(key, { at: Date.now(), chart });
  return chart;
}

/**
 * Onchain per-token state (spec §16.1 `onchain`): four ERC-8056 reads per
 * token contract, all batched into ONE eth_call via Multicall3 — the public
 * RPC rate-limits a plain 96-call JSON-RPC batch (429) but takes the single
 * aggregated call. aggregate3 is hand-encoded (fixed shape: one 4-byte call
 * per target) to avoid a web3 dependency for static reads.
 */
const RPC_URL = 'https://rpc.mainnet.chain.robinhood.com';
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
// keccak256(sig)[0:4] for the ERC-8056 reads and Chainlink AggregatorV3.
const SEL_UI_MULTIPLIER = 'a60bf13d'; // uiMultiplier()
const SEL_ORACLE_PAUSED = '7706ba52'; // oraclePaused()
const SEL_NEW_UI_MULTIPLIER = 'dc767007'; // newUIMultiplier()
const SEL_EFFECTIVE_AT = '97a4064f'; // effectiveAt()
const SEL_TOTAL_SUPPLY = '18160ddd'; // totalSupply() (ERC-20)
const SEL_LATEST_ROUND_DATA = 'feaf968c'; // latestRoundData()
const ONCHAIN_TTL_MS = 60_000;

const abiWord = (hex: string) => hex.padStart(64, '0');

/** One aggregate3 call: `calls` = (target, 4-byte selector) pairs. Returns
 * the raw 32-byte first word per call, null where the subcall failed. */
async function multicall(calls: { to: string; selector: string }[]): Promise<(bigint | null)[]> {
  const n = calls.length;
  let data = '82ad56cb' + abiWord('20') + abiWord(n.toString(16));
  for (let i = 0; i < n; i++) data += abiWord((n * 32 + i * 160).toString(16));
  for (const c of calls) {
    data += abiWord(c.to.slice(2).toLowerCase()) + abiWord('1') + abiWord('60') + abiWord('4') + c.selector.padEnd(64, '0');
  }
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: vendorTimeout(),
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: MULTICALL3, data: '0x' + data }, 'latest'] }),
  });
  if (!res.ok) throw new Error(`robinhood rpc HTTP ${res.status}`);
  const body = (await res.json()) as { result?: string; error?: { message?: string } };
  if (!body.result) throw new Error(`robinhood rpc: ${body.error?.message ?? 'empty result'}`);
  // decode Result[] = (bool success, bytes returnData)[]; first word of each returnData
  const hex = body.result.slice(2);
  const word = (i: number) => hex.slice(i * 64, (i + 1) * 64);
  const count = Number.parseInt(word(1), 16);
  const out: (bigint | null)[] = new Array(n).fill(null);
  for (let i = 0; i < Math.min(count, n); i++) {
    const el = Number.parseInt(word(2 + i), 16) / 32 + 2; // word index of element start
    const success = Number.parseInt(word(el), 16) === 1;
    const len = Number.parseInt(word(el + 2), 16);
    if (success && len >= 32) out[i] = BigInt('0x' + word(el + 3));
  }
  return out;
}

/** Multi-word variant of the decode for calls whose returndata is a struct
 * (latestRoundData): returns all returndata words per call. */
async function multicallWords(calls: { to: string; selector: string }[]): Promise<(bigint[] | null)[]> {
  const n = calls.length;
  let data = '82ad56cb' + abiWord('20') + abiWord(n.toString(16));
  for (let i = 0; i < n; i++) data += abiWord((n * 32 + i * 160).toString(16));
  for (const c of calls) {
    data += abiWord(c.to.slice(2).toLowerCase()) + abiWord('1') + abiWord('60') + abiWord('4') + c.selector.padEnd(64, '0');
  }
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: vendorTimeout(),
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: MULTICALL3, data: '0x' + data }, 'latest'] }),
  });
  if (!res.ok) throw new Error(`robinhood rpc HTTP ${res.status}`);
  const body = (await res.json()) as { result?: string; error?: { message?: string } };
  if (!body.result) throw new Error(`robinhood rpc: ${body.error?.message ?? 'empty result'}`);
  const hex = body.result.slice(2);
  const word = (i: number) => hex.slice(i * 64, (i + 1) * 64);
  const count = Number.parseInt(word(1), 16);
  const out: (bigint[] | null)[] = new Array(n).fill(null);
  for (let i = 0; i < Math.min(count, n); i++) {
    const el = Number.parseInt(word(2 + i), 16) / 32 + 2;
    const success = Number.parseInt(word(el), 16) === 1;
    const len = Number.parseInt(word(el + 2), 16);
    if (!success || len < 32) continue;
    const words: bigint[] = [];
    for (let w = 0; w < len / 32; w++) words.push(BigInt('0x' + word(el + 3 + w)));
    out[i] = words;
  }
  return out;
}

/** State of one token contract (ERC-8056): the live shares-per-token, whether
 * the price oracle is paused for a corporate action, and a genuinely PENDING
 * multiplier change (the contract keeps the last scheduled change after it
 * applies, so pending means effectiveAt in the future only). */
export interface OnchainState {
  uiMultiplier: number | null;
  oraclePaused: boolean | null;
  pendingMultiplier: number | null;
  pendingEffectiveAt: string | null;
  /** ERC-20 totalSupply in token units (registry decimals applied). */
  totalSupply: number | null;
}

/** Vendor hiccups serve the last good snapshot up to this age before
 * degrading to null — a 429 window must not blank the page (§16.1). */
const STALE_MAX_MS = 15 * 60_000;

let onchainCache: { at: number; byAddress: Map<string, OnchainState> } | null = null;

export async function onchainState(name: UniverseName): Promise<Map<string, OnchainState>> {
  if (name !== 'robinhood') return new Map();
  if (onchainCache && Date.now() - onchainCache.at < ONCHAIN_TTL_MS) return onchainCache.byAddress;
  try {
    const tokens = UNIVERSES[name].assets;
    const selectors = [SEL_UI_MULTIPLIER, SEL_ORACLE_PAUSED, SEL_NEW_UI_MULTIPLIER, SEL_EFFECTIVE_AT, SEL_TOTAL_SUPPLY];
    const calls = tokens.flatMap((t) => selectors.map((selector) => ({ to: t.address, selector })));
    const words = await multicall(calls);
    const byAddress = new Map<string, OnchainState>();
    const nowSec = Math.floor(Date.now() / 1000);
    tokens.forEach((t, i) => {
      const [mult, paused, newMult, effAt, supply] = [0, 1, 2, 3, 4].map((k) => words[i * 5 + k]);
      const effSec = effAt === null ? null : Number(effAt);
      const pending = newMult !== null && effSec !== null && effSec > nowSec;
      byAddress.set(t.address.toLowerCase(), {
        uiMultiplier: mult === null ? null : Number(mult) / 1e18,
        oraclePaused: paused === null ? null : paused === 1n,
        pendingMultiplier: pending ? Number(newMult) / 1e18 : null,
        pendingEffectiveAt: pending && effSec !== null ? new Date(effSec * 1000).toISOString() : null,
        totalSupply: supply === null ? null : Number(supply) / 10 ** t.decimals,
      });
    });
    onchainCache = { at: Date.now(), byAddress };
    return byAddress;
  } catch (err) {
    if (onchainCache && Date.now() - onchainCache.at < STALE_MAX_MS) {
      log.warn(`onchain state fetch failed, serving stale: ${(err as Error).message}`);
      return onchainCache.byAddress;
    }
    throw err;
  }
}

/**
 * Chainlink price feed per token (spec §16.1 `onchain.oracle`): the price the
 * CHAIN believes — feed price = underlying share price × multiplier, so it is
 * token-unit and directly comparable to the DEX price. Feed addresses come
 * from Chainlink's reference-data directory (the JSON behind docs.chain.link,
 * which the venue docs name as the source of truth), cached 12h; coverage is
 * partial by the registry's own state and missing feeds stay null.
 */
export interface OracleQuote {
  priceUsd: number | null;
  updatedAt: string | null;
  heartbeatSec: number | null;
  /** now - updatedAt exceeds the feed heartbeat (stock feeds publish 24/5). */
  stale: boolean | null;
}

const RDD_URL = 'https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json';
const RDD_TTL_MS = 12 * 3_600_000;
interface FeedRef {
  symbol: string;
  proxy: string;
  decimals: number;
  heartbeat: number | null;
}
let feedCache: { at: number; feeds: FeedRef[] } | null = null;
let oracleCache: { at: number; bySymbol: Map<string, OracleQuote> } | null = null;

async function chainlinkFeeds(): Promise<FeedRef[]> {
  if (feedCache && Date.now() - feedCache.at < RDD_TTL_MS) return feedCache.feeds;
  const res = await fetch(RDD_URL, { headers: { accept: 'application/json' }, signal: vendorTimeout() });
  if (!res.ok) throw new Error(`chainlink rdd HTTP ${res.status}`);
  const body = (await res.json()) as {
    name?: string;
    proxyAddress?: string | null;
    decimals?: number;
    heartbeat?: number;
    docs?: { baseAsset?: string; quoteAsset?: string };
  }[];
  const feeds: FeedRef[] = [];
  for (const f of body) {
    if (!f.proxyAddress) continue;
    // "Robinhood GOOGL / USD" or "Robinhood SGOV-USD"; docs.baseAsset when present.
    const parsed = /^Robinhood ([A-Z0-9.]+)\s*[-/]/.exec(f.name ?? '')?.[1];
    const symbol = (f.docs?.baseAsset || parsed || '').toUpperCase();
    if (!symbol) continue;
    feeds.push({ symbol, proxy: f.proxyAddress, decimals: f.decimals ?? 8, heartbeat: f.heartbeat ?? null });
  }
  feedCache = { at: Date.now(), feeds };
  return feeds;
}

export async function oracleQuotes(name: UniverseName): Promise<Map<string, OracleQuote>> {
  if (name !== 'robinhood') return new Map();
  if (oracleCache && Date.now() - oracleCache.at < ONCHAIN_TTL_MS) return oracleCache.bySymbol;
  try {
    return await oracleQuotesFresh(name);
  } catch (err) {
    if (oracleCache && Date.now() - oracleCache.at < STALE_MAX_MS) {
      log.warn(`oracle quotes fetch failed, serving stale: ${(err as Error).message}`);
      return oracleCache.bySymbol;
    }
    throw err;
  }
}

async function oracleQuotesFresh(name: UniverseName): Promise<Map<string, OracleQuote>> {
  const universeSymbols = new Set(UNIVERSES[name].assets.map((a) => a.symbol.toUpperCase()));
  const feeds = (await chainlinkFeeds()).filter((f) => universeSymbols.has(f.symbol));
  const rounds = await multicallWords(feeds.map((f) => ({ to: f.proxy, selector: SEL_LATEST_ROUND_DATA })));
  const bySymbol = new Map<string, OracleQuote>();
  const nowSec = Math.floor(Date.now() / 1000);
  feeds.forEach((f, i) => {
    const w = rounds[i];
    if (!w || w.length < 4) return;
    // latestRoundData: (roundId, answer, startedAt, updatedAt, answeredInRound)
    const answer = BigInt.asIntN(256, w[1]!);
    const updatedSec = Number(w[3]!);
    bySymbol.set(f.symbol, {
      priceUsd: answer > 0n ? Number(answer) / 10 ** f.decimals : null,
      updatedAt: updatedSec > 0 ? new Date(updatedSec * 1000).toISOString() : null,
      heartbeatSec: f.heartbeat,
      stale: f.heartbeat != null && updatedSec > 0 ? nowSec - updatedSec > f.heartbeat : null,
    });
  });
  oracleCache = { at: Date.now(), bySymbol };
  return bySymbol;
}

/** One venue corporate action (spec §16.1 `events`): enum prefixes stripped,
 * processDate flattened to YYYY-MM-DD (null while unscheduled), details the
 * type-specific inner object as the venue serves it (rates are decimal
 * strings — for a CASH_DIVIDEND, USD per underlying share). */
export interface CorporateAction {
  id: string;
  type: string;
  status: string;
  processDate: string | null;
  details: Record<string, unknown> | null;
}

const CORP_ACTIONS_TTL_MS = 3_600_000; // venue caches 1h
let corpActionsCache: { at: number; bySymbol: Map<string, CorporateAction[]> } | null = null;

/**
 * The venue's corporate-action feed (GET /rhj/corporate-actions), grouped by
 * token symbol, most-recent-first as served. The feed keys by the CURRENT
 * symbol (NAME_CHANGE entries carry the post-change symbol); entries for
 * symbols outside the universe simply never attach. Throws on failure;
 * callers degrade to null — distinct from [] = "feed answered, no actions".
 */
export async function corporateActions(name: UniverseName): Promise<Map<string, CorporateAction[]>> {
  if (name !== 'robinhood') return new Map();
  if (corpActionsCache && Date.now() - corpActionsCache.at < CORP_ACTIONS_TTL_MS) return corpActionsCache.bySymbol;
  try {
    return await corporateActionsFresh();
  } catch (err) {
    // Slow-moving data: a day-old feed beats a blank one.
    if (corpActionsCache && Date.now() - corpActionsCache.at < 24 * 3_600_000) {
      log.warn(`corporate actions fetch failed, serving stale: ${(err as Error).message}`);
      return corpActionsCache.bySymbol;
    }
    throw err;
  }
}

async function corporateActionsFresh(): Promise<Map<string, CorporateAction[]>> {
  const res = await fetch(`${RHJ_BASE}/corporate-actions`, { headers: { accept: 'application/json' }, signal: vendorTimeout() });
  if (!res.ok) throw new Error(`rhj/corporate-actions HTTP ${res.status}`);
  const body = (await res.json()) as { corpActions?: Record<string, unknown>[] };
  const bySymbol = new Map<string, CorporateAction[]>();
  for (const c of body.corpActions ?? []) {
    const symbol = String(c.tokenSymbol ?? '').toUpperCase();
    if (!symbol) continue;
    const pd = c.processDate as { year?: number; month?: number; day?: number } | null | undefined;
    // `details` holds exactly one key matching `type`; the type survives
    // top-level, so pass through just the inner object.
    const inner = c.details && typeof c.details === 'object' ? Object.values(c.details)[0] : null;
    const list = bySymbol.get(symbol) ?? [];
    list.push({
      id: String(c.id ?? ''),
      type: String(c.type ?? '').replace(/^CORPORATE_ACTION_TYPE_/, ''),
      status: String(c.status ?? '').replace(/^CORPORATE_ACTION_STATUS_/, ''),
      processDate:
        pd?.year && pd.month && pd.day
          ? `${pd.year}-${String(pd.month).padStart(2, '0')}-${String(pd.day).padStart(2, '0')}`
          : null,
      details: inner && typeof inner === 'object' ? (inner as Record<string, unknown>) : null,
    });
    bySymbol.set(symbol, list);
  }
  corpActionsCache = { at: Date.now(), bySymbol };
  return bySymbol;
}

/**
 * One universe asset with everything we know about it (spec §16.2): registry
 * identity + token contract, joined with the assets row and the nightly
 * asset_metrics row. DB-only by design — fundamentals refresh nightly at zero
 * marginal vendor cost, while live prices are the VENUE's job (/rhj/prices);
 * this endpoint must never fan out into per-asset vendor calls. Registry
 * entries with no active DB row still appear (identity + contract, data
 * nulls): a data gap announces itself rather than shrinking the universe
 * (§15.5 doctrine).
 */
export interface UniverseAssetData {
  ticker: string;
  name: string;
  kind: string;
  region: string | null;
  sector: string | null;
  categories: string[];
  about: string | null;
  website: string | null;
  logo: string | null;
  contract: { address: string; chainId: number; decimals: number; explorer: string };
  holders: number | null;
  marketCapUsd: number | null;
  currency: string | null;
  metrics: Record<string, number | string | null> | null;
  /** Vendor data date of the metrics row; null when metrics are null. */
  asOf: string | null;
  /** Live venue quote; null when the venue call failed or the token is unknown there. */
  quote: VenueQuote | null;
  /** Onchain DEX price/TVL/volume plus the premium of the onchain price over
   * the venue quote mid, percent; null parts degrade independently. */
  dex: (DexData & { premiumPct: number | null; attribution?: string }) | null;
  /** State read from the chain itself: shares-per-token, oracle pause,
   * genuinely pending multiplier, and the Chainlink oracle price (token-unit;
   * feed = underlying x multiplier). Null when the RPC read failed. */
  onchain: (OnchainState & { oracle: OracleQuote | null }) | null;
  /** Venue corporate actions for this token, most recent first; [] = feed
   * answered with none, null = feed unavailable. */
  events: CorporateAction[] | null;
  /** Last ~30 daily closes of the UNDERLYING equity (asset_prices), oldest
   * first, with their dates so charts can align it with onchain series. */
  spark30d: { from: string; dates: string[]; closes: number[] } | null;
  /** ETF holdings/sector weights as ingested; null for non-funds. */
  portfolio: unknown | null;
}

/**
 * What universeAssetData holds per asset BEFORE the display policy runs
 * (runtime/display-policy.ts presentUniverseAsset): the full public shape plus
 * the policy's inputs. Never sent as is: the presenter rebuilds the public
 * object field by field for the caller's channel.
 */
export interface UniverseAssetRecord extends UniverseAssetData {
  /** assets.source of the joined row ('fmp' for listed lines); null when no row matched. */
  source: string | null;
  /** The asset's own LLM enrichment text (spec §4.3b); null when not enriched. */
  enrichment: string | null;
}

/** Last ~30 daily closes per asset id, one query for the whole universe. */
async function sparks(ids: number[]): Promise<Map<number, { from: string; dates: string[]; closes: number[] }>> {
  if (!ids.length) return new Map();
  const since = new Date(Date.now() - 46 * 86_400_000).toISOString().slice(0, 10);
  // PostgREST silently caps a response at 1,000 rows no matter the .limit();
  // the universe window holds ~3k, so page through — an ascending query that
  // stops at 1,000 keeps only the OLDEST rows and every spark ends weeks ago
  // (shipped like that; the chart's honest date labels exposed it).
  const pageSize = 1000;
  const all: { asset_id: number; date: string; close: number }[] = [];
  for (let start = 0; ; start += pageSize) {
    const { data, error } = await supabase
      .from('asset_prices')
      .select('asset_id, date, close')
      .in('asset_id', ids)
      .gte('date', since)
      .order('date', { ascending: true })
      .order('asset_id', { ascending: true })
      .range(start, start + pageSize - 1);
    if (error) throw new Error(`universe sparks failed: ${error.message}`);
    all.push(...(data ?? []));
    if (!data || data.length < pageSize) break;
  }
  const byId = new Map<number, { dates: string[]; closes: number[] }>();
  for (const r of all) {
    const s = byId.get(r.asset_id) ?? { dates: [], closes: [] };
    s.dates.push(r.date);
    s.closes.push(Number(r.close));
    byId.set(r.asset_id, s);
  }
  const out = new Map<number, { from: string; dates: string[]; closes: number[] }>();
  for (const [id, s] of byId) {
    const closes = s.closes.slice(-30);
    const dates = s.dates.slice(-30);
    const from = dates[0];
    if (closes.length >= 2 && from) out.set(id, { from, dates, closes });
  }
  return out;
}

/** DEX aggregates + premium over the venue mid for one token. The venue quote
 * is the UNDERLYING share price while the DEX price is the TOKEN price, so
 * the venue side must be scaled by the multiplier (shares per token) before
 * comparing — without it, a 4:1-split token would show a phantom +300%. The
 * venue's multiplier first, the token contract's own as the fallback; with
 * neither known there is no premium (never an assumed 1). */
export function dexEntry(
  byAddress: Map<string, DexData>,
  address: string,
  quote: VenueQuote | null,
  onchainMultiplier: number | null = null,
): (DexData & { premiumPct: number | null }) | null {
  const d = byAddress.get(address.toLowerCase());
  if (!d) return null;
  const mid = quote && quote.bid != null && quote.ask != null ? (quote.bid + quote.ask) / 2 : (quote?.bid ?? quote?.ask ?? null);
  const multiplier = quote?.multiplier ?? onchainMultiplier;
  const tokenMid = mid != null && multiplier != null && multiplier > 0 ? mid * multiplier : null;
  const premiumPct = d.priceUsd != null && tokenMid != null && tokenMid > 0 ? ((d.priceUsd - tokenMid) / tokenMid) * 100 : null;
  return { ...d, premiumPct };
}

/** Everything we hold on every universe asset, keyed off the registry so the
 * list always covers all tokens. One assets query + one metrics query. The
 * records carry the display policy's inputs; serve them only through
 * presentUniverseAsset (runtime/display-policy.ts). */
export async function universeAssetData(name: UniverseName): Promise<UniverseAssetRecord[]> {
  const reg = UNIVERSES[name];
  const { data: rows, error } = await supabase
    .from('assets')
    .select('id, ticker, name, kind, region, sector, categories, currency, market_cap_usd, website_url, logo_url, description, etf_portfolio, source, enrichment')
    .in('ticker', reg.assets.map((a) => a.symbol))
    .in('kind', ['stock', 'etf', 'bond'])
    .eq('is_active', true)
    .eq('accessibility', 'open')
    // Largest line first: a ticker can match more than one row (review R1).
    .order('market_cap_usd', { ascending: false, nullsFirst: false });
  if (error) throw new Error(`universeAssetData(${name}) assets failed: ${error.message}`);
  // First row wins = the major line (a plain Map from the list kept the LAST).
  const byTicker = new Map<string, NonNullable<typeof rows>[number]>();
  for (const r of rows ?? []) if (!byTicker.has(r.ticker.toUpperCase())) byTicker.set(r.ticker.toUpperCase(), r);
  const ids = (rows ?? []).map((r) => r.id);
  const [{ data: metricRows, error: mErr }, sparkById, quotes, dexByAddress, eventsBySymbol, onchainByAddress, oracleBySymbol] = await Promise.all([
    ids.length
      ? supabase.from('asset_metrics').select('*').in('asset_id', ids)
      : Promise.resolve({ data: [], error: null } as { data: Record<string, unknown>[]; error: null }),
    sparks(ids),
    // Venue down must not take the whole payload with it: quotes degrade to null.
    venueQuotes(name).catch((err) => {
      log.warn(`venue quotes unavailable for ${name}: ${(err as Error).message}`);
      return new Map<string, VenueQuote>();
    }),
    dexData(name).catch((err) => {
      log.warn(`dex data unavailable for ${name}: ${(err as Error).message}`);
      return new Map<string, DexData>();
    }),
    // null (feed down) must stay distinguishable from [] (no actions).
    corporateActions(name).catch((err): null => {
      log.warn(`corporate actions unavailable for ${name}: ${(err as Error).message}`);
      return null;
    }),
    // null (RPC down) must stay distinguishable from per-field nulls.
    onchainState(name).catch((err): null => {
      log.warn(`onchain state unavailable for ${name}: ${(err as Error).message}`);
      return null;
    }),
    oracleQuotes(name).catch((err) => {
      log.warn(`oracle quotes unavailable for ${name}: ${(err as Error).message}`);
      return new Map<string, OracleQuote>();
    }),
  ]);
  if (mErr) throw new Error(`universeAssetData(${name}) metrics failed: ${mErr.message}`);
  const metricsById = new Map((metricRows ?? []).map((m) => [m.asset_id as number, m]));
  return reg.assets.map((t) => {
    const row = byTicker.get(t.symbol.toUpperCase());
    const m = row ? (metricsById.get(row.id) as Record<string, number | string | null> | undefined) : undefined;
    // Strip the join key and bookkeeping; market cap surfaces top-level.
    const { asset_id: _a, market_cap_usd: _m, source: _s, updated_at: _u, as_of, ...metrics } = m ?? {};
    const quote = quotes.get(t.symbol.toUpperCase()) ?? null;
    const chainState = onchainByAddress?.get(t.address.toLowerCase()) ?? null;
    return {
      ticker: t.symbol,
      name: row?.name ?? t.name,
      kind: row?.kind ?? t.kind,
      region: row?.region ?? null,
      sector: row?.sector ?? null,
      categories: row?.categories ?? [],
      // Word-boundary clip (the card's Read more fetches the full text).
      about: row?.description ? clipText(String(row.description), 500) : null,
      // http(s) with a real host only, like the run payload's links (audit L15).
      website: normWebsite(row?.website_url),
      // Company logos from our ingest first: the venue CDN serves a generic
      // Robinhood badge per token, useful only when we hold nothing.
      logo: row?.logo_url ?? t.logoUrl ?? null,
      contract: { address: t.address, chainId: UNIVERSES[name].chainId, decimals: t.decimals, explorer: UNIVERSES[name].explorerBase + t.address },
      holders: t.holders,
      marketCapUsd: row?.market_cap_usd ?? null,
      currency: row?.currency ?? null,
      metrics: m ? (metrics as Record<string, number | string | null>) : null,
      asOf: m ? ((as_of as string | null) ?? null) : null,
      quote,
      dex: dexEntry(dexByAddress, t.address, quote, chainState?.uiMultiplier ?? null),
      onchain: onchainByAddress
        ? {
            ...(chainState ?? {
              uiMultiplier: null,
              oraclePaused: null,
              pendingMultiplier: null,
              pendingEffectiveAt: null,
              totalSupply: null,
            }),
            oracle: oracleBySymbol.get(t.symbol.toUpperCase()) ?? null,
          }
        : null,
      events: eventsBySymbol ? (eventsBySymbol.get(t.symbol.toUpperCase()) ?? []) : null,
      spark30d: row ? (sparkById.get(row.id) ?? null) : null,
      portfolio: row?.etf_portfolio ?? null,
      source: row?.source ?? null,
      enrichment: row?.enrichment ?? null,
    };
  });
}

/** Full (untruncated) texts for ONE asset — the list payload caps `about` at
 * 500 chars; the single-asset endpoint swaps in the full text so the card's
 * "Read more" can show everything (spec §16.1). Which of the two texts may be
 * shown is the display policy's call (fullUniverseAbout). */
export async function fullAbout(
  name: UniverseName,
  ticker: string,
): Promise<{ description: string | null; enrichment: string | null; source: string | null; kind: string | null } | null> {
  if (!UNIVERSES[name].assets.some((a) => a.symbol.toUpperCase() === ticker.toUpperCase())) return null;
  const { data, error } = await supabase
    .from('assets')
    .select('description, enrichment, source, kind')
    .eq('ticker', ticker.toUpperCase())
    .in('kind', ['stock', 'etf', 'bond'])
    .eq('is_active', true)
    .eq('accessibility', 'open')
    // Same row universeAssetData shows: the largest line for the ticker.
    .order('market_cap_usd', { ascending: false, nullsFirst: false })
    .limit(1);
  if (error) throw new Error(`fullAbout(${ticker}) failed: ${error.message}`);
  const row = data?.[0];
  return row
    ? { description: row.description ?? null, enrichment: row.enrichment ?? null, source: row.source ?? null, kind: row.kind ?? null }
    : null;
}

/** Cache timestamps for the /assets response's `asOf` block: when each data
 * family was last refreshed successfully (spec §16.1 freshness model). */
export function universeDataAsOf(): Record<'quotes' | 'dex' | 'onchain' | 'oracle' | 'events', string | null> {
  const iso = (at: number | undefined) => (at ? new Date(at).toISOString() : null);
  return {
    quotes: iso(quoteCache?.at),
    dex: iso(dexCache?.at),
    onchain: iso(onchainCache?.at),
    oracle: iso(oracleCache?.at),
    events: iso(corpActionsCache?.at),
  };
}

/**
 * Background warmer (spec §16.1 freshness model): refresh every universe
 * cache each minute so requests never pay vendor latency and 429 windows
 * serve the last good snapshot instead of dashes. Errors only warn — the
 * stale-serving in each fetcher is the actual safety net.
 */
export function startUniverseWarmer(): void {
  const warm = () => {
    for (const name of Object.keys(UNIVERSES) as UniverseName[]) {
      void venueQuotes(name).catch((err) => log.warn(`warmer: venue quotes: ${(err as Error).message}`));
      void onchainState(name).catch((err) => log.warn(`warmer: onchain state: ${(err as Error).message}`));
      void oracleQuotes(name).catch((err) => log.warn(`warmer: oracle quotes: ${(err as Error).message}`));
      void corporateActions(name).catch((err) => log.warn(`warmer: corporate actions: ${(err as Error).message}`));
    }
  };
  // DEX rides its own slower tick (spec §16.1, 2026-07-31): the data moves
  // slowly and fewer GeckoTerminal calls mean fewer 429 cooldowns.
  const warmDex = () => {
    for (const name of Object.keys(UNIVERSES) as UniverseName[]) {
      void dexData(name).catch((err) => log.warn(`warmer: dex data: ${(err as Error).message}`));
    }
  };
  warm();
  warmDex();
  setInterval(warm, 60_000).unref();
  setInterval(warmDex, 4 * 60_000).unref();
  log.info('universe cache warmer started (60s; dex 240s)');
}

/**
 * The universe as a candidate pool: every active, open listed row whose ticker
 * is in the registry (stock/etf/bond kinds only — the crypto clone rows of the
 * very same tokens must never match). sim carries the holders-based liquidity
 * prior (0..1) so downstream sim ordering remains meaningful.
 */
export async function universeCandidates(name: UniverseName): Promise<Candidate[]> {
  const reg = UNIVERSES[name];
  const bySymbol = new Map(reg.assets.map((a) => [a.symbol.toUpperCase(), a]));
  const { data, error } = await supabase
    .from('assets')
    .select('id, ticker, name, kind, region, cap_class, exchange, cex_venues, dex_venues, sector, categories, etf_portfolio, volume_24h_usd, description')
    .in('ticker', reg.assets.map((a) => a.symbol))
    .in('kind', ['stock', 'etf', 'bond'])
    .eq('is_active', true)
    .eq('accessibility', 'open')
    // Largest line first, so the pipeline's one-row-per-ticker pass keeps the
    // major listing when a symbol matches more than one row (review R1).
    .order('market_cap_usd', { ascending: false, nullsFirst: false });
  if (error) throw new Error(`universeCandidates(${name}) failed: ${error.message}`);
  const maxHolders = Math.max(1, ...reg.assets.map((a) => a.holders ?? 0));
  return (data ?? [])
    .map((a) => ({
      ...a,
      blurb: (a.description ?? '').slice(0, 300),
      sim: (bySymbol.get(a.ticker.toUpperCase())?.holders ?? 0) / maxHolders,
    }))
    .map(({ description: _d, ...rest }) => rest as Candidate)
    .sort((a, b) => b.sim - a.sim);
}

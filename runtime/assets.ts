/**
 * Light asset extraction (spec §14, PR 2): which assets is this content
 * about? One cheap LLM call names them, the assets table resolves them, the
 * existing market lookup attaches price + day change. Deliberately NOT the
 * screening pipeline: this answers in seconds for 1 credit, /v1/screen takes
 * minutes and real LLM spend.
 */
import { callClaude, parseJSON } from './llm.js';
import { marketForAll, marketKey, type MarketAssetRef } from './market.js';
import { ATTRIBUTION, displayFlags, mayShow, runMarketNote, vendorOf, type Channel } from './display-policy.js';
import { getCandidates } from './candidates.js';
import { supabase } from '../ingest/lib/supabase.js';
import { log } from '../ingest/lib/log.js';

// Cheap-by-default, like the news and audio paths; override to taste.
const assetsModel = () => process.env.SIGNAL_ASSETS_MODEL || 'google/gemini-2.5-flash';
export const MAX_ASSET_HITS = 8;

/** What the LLM names in the content; ticker/kind only when it is confident. */
interface Mention {
  name: string;
  ticker?: string;
  kind?: string;
}

export interface AssetHit {
  id: number;
  name: string;
  ticker: string;
  kind: string;
  /** price, change1dPct and marketCapUsd are null when the data display
   * policy withholds this asset's market data (market_withheld). */
  price: number | null;
  change1dPct: number | null;
  currency: string | null;
  marketCapUsd: number | null;
  market_withheld: boolean;
  /** The vendor credit line, on the API channel when market data is included. */
  attribution?: string;
}

export interface AssetsResult {
  assets: AssetHit[];
  /** Named in the content but not resolvable in our universe. */
  unmatched: string[];
  /** The post's investment thesis as the extractor read it; null when unclear. */
  thesis: ThesisRead | null;
  /**
   * True when the content named no resolvable assets (macro posts) and
   * `assets` instead holds the closest thesis plays from the embedded
   * universe (2026-07-22) — callers must present them as thesis-related,
   * not as named in the post.
   */
  implied: boolean;
  /** The reader's explicit long/short ask, when any (request context). */
  direction: 'long' | 'short' | null;
  /** Why market data is missing, when the display policy withheld it (null otherwise). */
  market_note: string | null;
}

const SYSTEM = `You extract the investment thesis and the financial assets from content. Answer with STRICT JSON only, no prose:
{"thesis":{"title":"US chip supply buildout","summary":"...","themes":["semiconductors","reshoring"]},"assets":[{"name":"Apple","ticker":"AAPL","kind":"stock"}],"filters":{"kinds":["etf"],"regions":["us"],"direction":"long"}}
Rules:
- "thesis": title under 8 words naming the post's investment thesis; summary 1-2 sentences; themes 2-5 keywords.
- "assets": only assets the content is materially about, or whose business it directly affects: public stocks, ETFs, bonds, cryptocurrencies, notable private companies.
- At most ${MAX_ASSET_HITS} assets, most relevant first. An empty list is a valid answer.
- "ticker" only when you are confident; omit the field otherwise. Never invent one.
- "kind" is one of stock, etf, bond, crypto, private; omit when unsure.
- Name the company behind a product or brand (iPhone -> Apple).
- A READER REQUEST may precede the content. When it asks for something explicit, report it in "filters" (omit the key or fields otherwise): "kinds" from stock|etf|bond|crypto|private ("only ETFs" -> ["etf"]); "regions" from us|eu|cn|other|global ("stocks from usa" -> kinds ["stock"], regions ["us"]); "direction" long or short.
- The request steers "assets": with a kinds filter, list well-known assets of that kind expressing the thesis even when the content names none (crypto post + "only ETFs" -> the relevant crypto ETFs). With direction short, list the assets the thesis argues AGAINST or that suffer if it plays out; with long, the beneficiaries.`;

/** One-line thesis read of the content (spec §14 smart replies, 2026-07-22). */
export interface ThesisRead {
  title: string;
  summary: string;
  themes: string[];
}

/** Explicit filters the reader asked for (spec §14 request context, 2026-07-22). */
export interface RequestFilters {
  kinds: string[];
  regions: string[];
  direction: 'long' | 'short' | null;
}

const KINDS = new Set(['stock', 'etf', 'bond', 'crypto', 'private']);
const REGIONS = new Set(['us', 'eu', 'cn', 'other', 'global']);

/** One LLM call → the post's thesis + the assets it names. Bad JSON degrades to empty. */
async function extractContent(
  text: string,
  request: string,
): Promise<{ thesis: ThesisRead | null; mentions: Mention[]; filters: RequestFilters }> {
  const user = request
    ? `READER REQUEST: ${request.slice(0, 500)}\n\nCONTENT:\n${text.slice(0, 20_000)}`
    : text.slice(0, 20_000);
  let raw: string;
  try {
    raw = await callClaude(user, { system: SYSTEM, maxTokens: 1500, temperature: 0, model: assetsModel() });
  } catch (err) {
    // Flash models intermittently answer empty; one retry before the caller's
    // refund path takes over (seen live 2026-07-22).
    log.warn(`asset extraction call failed, retrying once: ${(err as Error).message}`);
    raw = await callClaude(user, { system: SYSTEM, maxTokens: 1500, temperature: 0, model: assetsModel() });
  }
  const none: RequestFilters = { kinds: [], regions: [], direction: null };
  try {
    const parsed = parseJSON<{
      thesis?: Partial<ThesisRead>;
      assets?: Mention[];
      filters?: { kinds?: unknown[]; regions?: unknown[]; direction?: unknown };
    }>(raw);
    const t = parsed.thesis;
    const f = parsed.filters;
    const filters: RequestFilters = !request
      ? none
      : {
          kinds: (f?.kinds ?? []).map(String).filter((k) => KINDS.has(k)),
          regions: (f?.regions ?? []).map(String).filter((r) => REGIONS.has(r)),
          direction: f?.direction === 'long' || f?.direction === 'short' ? f.direction : null,
        };
    return {
      filters,
      thesis:
        t && typeof t.title === 'string' && typeof t.summary === 'string'
          ? { title: t.title, summary: t.summary, themes: Array.isArray(t.themes) ? t.themes.map(String) : [] }
          : null,
      mentions: (parsed.assets ?? [])
        .filter((m) => m && typeof m.name === 'string' && m.name.trim())
        .slice(0, MAX_ASSET_HITS),
    };
  } catch (err) {
    log.warn(`asset extraction returned unparseable JSON: ${(err as Error).message}`);
    return { thesis: null, mentions: [], filters: none };
  }
}

/** Escape LIKE wildcards in LLM-derived text (same helper as thesis.ts anchors):
 * an unescaped leading % would force a sequential scan of `assets`. */
const escLike = (s: string) => s.replace(/[%_\\]/g, '\\$&');

/** DB row shape we resolve to: market ref + display fields. */
type ResolvedRow = MarketAssetRef & { id: number; name: string; region?: string | null };
const ROW_FIELDS =
  // market_snapshot rides along so /v1/assets and the X bot keep quoting prices
  // from the frozen fallback once the FMP subscription ends (spec §5.6).
  'id, name, region, source, vendor_id, ticker, kind, currency, market_cap_usd, volume_24h_usd, updated_at, market_snapshot';

/**
 * Does the mentioned name plausibly belong to this DB row? Guards the bare
 * ticker match against collisions across kinds: "Leonardo (LDO)" must not
 * resolve to Lido DAO just because the crypto owns the exact ticker LDO
 * while the equity is listed as LDO.MI (live incident 2026-07-22).
 */
function namesAgree(mentionName: string, rowName: string): boolean {
  const a = mentionName.toLowerCase().trim();
  const b = rowName.toLowerCase();
  if (!a) return true;
  if (b.includes(a) || a.includes(b)) return true;
  return a.split(/[^a-z0-9]+/).some((w) => w.length >= 4 && b.includes(w));
}

/**
 * Resolve one mention: exact ticker match first, but only if the row's name
 * agrees with what the content actually named; otherwise (and when the
 * ticker misses, e.g. suffixed listings like LDO.MI) a name lookup decides.
 * A disagreeing ticker hit is still the last resort — vendor names can
 * differ from colloquial ones (Google vs Alphabet). Largest cap wins every
 * query. null = not in our universe.
 */
async function resolveMention(m: Mention): Promise<ResolvedRow | null> {
  const ticker = (m.ticker ?? '').trim();
  let tickerHit: ResolvedRow | null = null;
  if (ticker) {
    const { data, error } = await supabase
      .from('assets')
      .select(ROW_FIELDS)
      .ilike('ticker', escLike(ticker))
      .eq('is_active', true)
      .order('market_cap_usd', { ascending: false, nullsFirst: false })
      .limit(1);
    if (error) throw new Error(`assets ticker lookup failed: ${error.message}`);
    tickerHit = data?.length ? (data[0] as unknown as ResolvedRow) : null;
    if (tickerHit && namesAgree(m.name, tickerHit.name)) return tickerHit;
  }
  const name = m.name.trim();
  if (name) {
    const { data, error } = await supabase
      .from('assets')
      .select(ROW_FIELDS)
      .ilike('name', `%${escLike(name)}%`)
      .eq('is_active', true)
      .order('market_cap_usd', { ascending: false, nullsFirst: false })
      .limit(1);
    if (error) throw new Error(`assets name lookup failed: ${error.message}`);
    if (data?.length) return data[0] as unknown as ResolvedRow;
  }
  return tickerHit;
}

const IMPLIED_COUNT = 3;

/**
 * Macro posts (inflation, rates, geopolitics) name no assets; retrieve the
 * closest thesis plays from the embedded universe instead — grounded in our
 * own data, similarity-ranked, never hallucinated. Best-effort: [] on any
 * failure and the caller keeps the honest no-assets answer.
 */
async function impliedFromThesis(thesis: ThesisRead, filters: RequestFilters): Promise<ResolvedRow[]> {
  try {
    const kinds = filters.kinds.filter((k): k is 'stock' | 'etf' | 'bond' | 'crypto' => k !== 'private');
    const regions = filters.regions as ('us' | 'eu' | 'cn' | 'other' | 'global')[];
    const cands = await getCandidates(
      `${thesis.title}. ${thesis.summary}`,
      { assetSet: kinds.length ? kinds : null, regionSet: regions.length ? regions : null },
      { queries: thesis.themes.slice(0, 2) },
    );
    const top = [...cands].sort((a, b) => b.sim - a.sim).slice(0, 20);
    if (!top.length) return [];
    const { data, error } = await supabase
      .from('assets')
      .select(ROW_FIELDS)
      .in('id', top.map((c) => c.id));
    if (error) throw new Error(error.message);
    const byId = new Map((data ?? []).map((r) => [(r as { id: number }).id, r as unknown as ResolvedRow]));
    // Publishable floor (2026-07-22): without the pipeline's liquidity screen
    // the raw embedding match happily surfaces 27M-cap memecoins for a
    // geopolitics post. Equities/ETFs/bonds only — crypto only when the
    // thesis is actually about crypto — and at least 100M of size.
    const cryptoThesis =
      filters.kinds.includes('crypto') ||
      /crypto|bitcoin|btc|ethereum|eth|token|defi|stablecoin|blockchain|solana/i.test(
        `${thesis.title} ${thesis.summary} ${thesis.themes.join(' ')}`,
      );
    // Leveraged/inverse ETPs are trading vehicles, not theme exposure — a
    // bullish-oil post must never get a Bear 2X fund ("DRIP", 2026-07-22).
    // \bshort\b(?!-) spares "Short-Term" bond funds while catching
    // "ProShares Short S&P500".
    const isTradingVehicle = (r: ResolvedRow) =>
      r.kind === 'etf' && (/\b([23]x|-1x|ultra|inverse|leveraged|bear)\b/i.test(r.name) || /\bshort\b(?!-)/i.test(r.name));
    return top
      .map((c) => byId.get(c.id))
      .filter((r): r is ResolvedRow => Boolean(r))
      .filter(
        (r) =>
          r.kind !== 'private' &&
          (r.kind !== 'crypto' || cryptoThesis) &&
          (r.market_cap_usd ?? 0) >= 1e8 &&
          !isTradingVehicle(r),
      )
      .slice(0, IMPLIED_COUNT);
  } catch (err) {
    log.warn(`implied-assets retrieval failed: ${(err as Error).message}`);
    return [];
  }
}

/**
 * The full light path: extract → resolve → market. `request` is optional
 * reader context ("give me only ETFs", "assets to short"): the extractor
 * honors it when choosing assets, and the parsed filters are enforced hard
 * here — a kinds/regions ask can never be answered with the wrong kind.
 * `channel` is the data display policy's (runtime/display-policy.ts): 'api'
 * for API keys and the X bot (its replies are public posts), 'web' for a
 * signed-in browser session. Withheld market data is never fetched.
 */
export async function assetsFromContent(text: string, request = '', opts: { channel: Channel } = { channel: 'api' }): Promise<AssetsResult> {
  const { channel } = opts;
  const flags = displayFlags();
  const { thesis, mentions, filters } = await extractContent(text, request);
  let resolved: ResolvedRow[] = [];
  const unmatched: string[] = [];
  const seen = new Set<number>();
  for (const m of mentions) {
    const row = await resolveMention(m);
    if (!row) {
      unmatched.push(m.name.trim());
      continue;
    }
    if (seen.has(row.id)) continue; // two mentions of the same asset
    seen.add(row.id);
    resolved.push(row);
  }
  // Hard enforcement of the reader's explicit filters. Crypto and global
  // rows pass region filters (spec §5.2 semantics).
  if (filters.kinds.length) resolved = resolved.filter((r) => filters.kinds.includes(r.kind ?? ''));
  if (filters.regions.length) {
    resolved = resolved.filter(
      (r) =>
        !r.region || r.region === 'global' || r.kind === 'crypto' || filters.regions.includes(r.region),
    );
  }
  // Named assets missing or filtered away → the embedded universe answers,
  // under the same constraints. EXCEPT for an explicit short ask: embedding
  // retrieval is direction-blind, and serving theme exposure as short
  // candidates would be misleading — an honest empty answer wins.
  let implied = false;
  if (!resolved.length && thesis && filters.direction !== 'short') {
    resolved = await impliedFromThesis(thesis, filters);
    implied = resolved.length > 0;
  }
  // Only what this channel may show is looked up (display policy).
  const market = await marketForAll(resolved.filter((r) => mayShow(vendorOf(r), channel, flags)));
  const assets: AssetHit[] = resolved.map((r) => {
    // By source + vendor id: two resolved rows can share a ticker (review R1).
    const vendor = vendorOf(r);
    const shown = mayShow(vendor, channel, flags);
    const md = shown ? market[marketKey(r)] : undefined;
    const price = shown ? (md?.price ?? null) : null;
    const change1dPct = shown ? (md?.change1d ?? null) : null;
    const marketCapUsd = shown ? (md?.marketCap ?? r.market_cap_usd ?? null) : null;
    const hasData = price != null || change1dPct != null || marketCapUsd != null;
    return {
      id: r.id,
      name: r.name,
      ticker: r.ticker,
      kind: r.kind ?? '',
      price,
      change1dPct,
      currency: md?.currency ?? r.currency ?? null,
      marketCapUsd,
      market_withheld: !shown,
      ...(channel === 'api' && hasData ? { attribution: ATTRIBUTION[vendor] } : {}),
    };
  });
  return {
    assets,
    unmatched,
    thesis,
    implied,
    direction: filters.direction,
    market_note: runMarketNote(channel, flags, assets),
  };
}

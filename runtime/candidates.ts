/**
 * /candidates core (spec §5.2): SQL hard filter + pgvector retrieval + semantic
 * category soft boost. Runs in Node today; ports into a Supabase Edge Function
 * in Milestone 3 (the logic is deliberately dependency-light).
 */
import { supabase } from '../ingest/lib/supabase.js';
import { embedQuery } from '../ingest/embeddings/voyage.js';
import type { EtfPortfolio } from '../ingest/lib/supabase.js';
import { currentRunSignal } from './runsignal.js';

/** Binding requirements relevant to retrieval (subset of the v3 requirement object). */
export interface Requirements {
  /** Allowed kinds, e.g. ['crypto'] for "only crypto". null = no constraint. */
  assetSet?: ('stock' | 'etf' | 'bond' | 'crypto')[] | null;
  /** Allowed regions, e.g. ['eu']. Crypto passes region filters (spec §5.2).
   * 'it' = Italy (§6): binds via the 'Italy' category tag, not the region
   * column — union with any coarse regions alongside it. */
  regionSet?: ('us' | 'eu' | 'cn' | 'other' | 'global' | 'it')[] | null;
  /** Allowed cap classes, e.g. ['mega','large']. */
  capSet?: ('mega' | 'large' | 'mid' | 'small' | 'micro')[] | null;
  /** Crypto must be listed on at least one CEX. */
  cexOnly?: boolean;
  /** If China is selected on the review card, only HKEX lines may pass
   * (FMP venue code HKSE; legacy normalized aliases HK/HKEX also accepted). */
  cnHkexOnly?: boolean;
  /** Tickers to exclude. */
  excludeTickers?: string[];
  /**
   * Meaning-level scope, e.g. "Ethereum ecosystem" — soft-boosts candidates
   * whose categories match (+0.15 before the cut); the compliance audit (§5.4)
   * enforces the hard version.
   */
  semantic?: string | null;
}

export interface Candidate {
  id: number;
  ticker: string;
  name: string;
  kind: string;
  region: string;
  cap_class: string | null;
  exchange: string | null;
  cex_venues: string[];
  dex_venues: string[];
  sector: string | null;
  categories: string[];
  etf_portfolio: EtfPortfolio | null;
  /** Crypto 24h trading volume, USD (null for equities / not-yet-backfilled). */
  volume_24h_usd: number | null;
  blurb: string | null;
  sim: number;
  /** Which retrieval query found the row first; useful for later debugging/evals. */
  retrieval_query?: string;
  /** Other listings of the same company (spec §5.3 'ten distinct companies'). */
  siblings?: Candidate[];
}

/** Compact ETF holdings(/sectors) segment for LLM prompt lines — the single
 * shared format for /select and /analysis so the two prompts never drift. */
export function portfolioLine(pf: EtfPortfolio | null | undefined, opts: { sectors?: boolean } = {}): string {
  const holdings = (pf?.top_holdings ?? [])
    .slice(0, 5)
    .map((h) => [h.symbol, h.name].filter(Boolean).join(' '))
    .join(',');
  const sectors = opts.sectors
    ? (pf?.sector_weights ?? []).slice(0, 4).map((s) => s.name).join(',')
    : '';
  return [holdings ? `holds ${holdings}` : '', sectors ? `sectors ${sectors}` : ''].filter(Boolean).join('; ');
}

/** cap_class → human dollar band (ingest/lib/caps.ts boundaries, spec §4.1). */
const CAP_BAND: Record<string, string> = {
  mega: 'above $200B',
  large: '$10B to $200B',
  mid: '$2B to $10B',
  small: '$300M to $2B',
  micro: 'below $300M',
};

/** Size segment for LLM prompt lines — "AUM $10B to $200B" for etf/bond rows
 * (cap_class = AUM for funds, spec §5.2 2026-07-08), "market cap …" otherwise,
 * '' when cap_class is null. Shared by the audit and analysis pick lines: any
 * model asked to reason about size must SEE the banded figure, or it invents
 * one from the asset's name (§5.4 2026-07-23). */
export function sizeBand(a: Candidate): string {
  const band = a.cap_class ? CAP_BAND[a.cap_class] : undefined;
  return band ? `${a.kind === 'etf' || a.kind === 'bond' ? 'AUM' : 'market cap'} ${band}` : '';
}

const FINAL_COUNT = 100;
// Over-fetch so the +0.15 boost is applied BEFORE the top-100 cut (spec §5.2.3).
const FETCH_COUNT = 400;
const SECONDARY_FETCH_COUNT = 180;
const SEMANTIC_BOOST = 0.15;
const RRF_K = 60;
// Majors rescue: mega/large-caps have diffuse descriptions (many business
// lines) and lose raw-similarity contests to niche pure-plays, so reserve a
// few candidate slots for the biggest caps in the fetched pool — otherwise
// /select can never even consider them (ETH missing from an Ethereum thesis).
const SIM_SLOTS = 85;

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

/**
 * Force-include anchors (assets the user explicitly named) into the candidate
 * set — v3 parity: a named asset is always considered, then scored/audited
 * like any other. Anchors that fail the hard filters are NOT added (binding
 * requirements still win over mentions).
 */
export async function ensureAnchors(
  candidates: Candidate[],
  anchorTickers: string[],
  passes: (c: Candidate) => boolean,
): Promise<Candidate[]> {
  const have = new Set(candidates.map((c) => c.ticker.toUpperCase()));
  const missing = anchorTickers.filter((t) => !have.has(t.toUpperCase()));
  if (!missing.length) return candidates;
  const { data, error } = await supabase
    .from('assets')
    .select('id, ticker, name, kind, region, cap_class, exchange, cex_venues, dex_venues, sector, categories, etf_portfolio, volume_24h_usd, description')
    .in('ticker', missing)
    .eq('is_active', true)
    .eq('accessibility', 'open');
  if (error) throw new Error(`ensureAnchors failed: ${error.message}`);
  const extra = (data ?? [])
    .map((a) => ({
      ...a,
      blurb: (a.description ?? '').slice(0, 300),
      sim: 0, // display-rank last; /select judges by meaning, not sim
    }))
    .map(({ description: _d, ...rest }) => rest as Candidate)
    .filter(passes);
  return [...candidates, ...extra];
}

const SEMANTIC_ALIASES: Record<string, string[]> = {
  ai: ['artificial intelligence', 'machine learning', 'ml', 'neural', 'gpu', 'compute', 'data center'],
  'artificial intelligence': ['ai', 'machine learning', 'ml', 'neural', 'gpu', 'compute', 'data center'],
  bitcoin: ['btc', 'lightning', 'ordinals'],
  btc: ['bitcoin', 'lightning', 'ordinals'],
  ethereum: ['eth', 'evm', 'rollup', 'rollups', 'layer 2', 'l2', 'defi', 'staking'],
  eth: ['ethereum', 'evm', 'rollup', 'rollups', 'layer 2', 'l2', 'defi', 'staking'],
  solana: ['sol', 'spl', 'consumer crypto'],
  stablecoin: ['stablecoins', 'payments', 'dollar', 'usd'],
  stablecoins: ['stablecoin', 'payments', 'dollar', 'usd'],
  tokenization: ['rwa', 'real world assets', 'real-world assets'],
  rwa: ['tokenization', 'real world assets', 'real-world assets'],
  rearmament: ['defense', 'aerospace', 'weapons', 'military'],
  semiconductor: ['semiconductors', 'chips', 'chip', 'foundry', 'equipment'],
  semiconductors: ['semiconductor', 'chips', 'chip', 'foundry', 'equipment'],
};

const STOP_WORDS = new Set([
  'and', 'are', 'for', 'from', 'into', 'only', 'related', 'the', 'that', 'this', 'with',
  'ecosystem', 'sector', 'theme', 'themes', 'market', 'markets', 'assets', 'asset',
]);

function semanticTerms(semantic: string): string[] {
  const phrases = semantic
    .toLowerCase()
    .split(/[,;/.()]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 2);
  const words = semantic
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
  const expanded = [...phrases, ...words];
  for (const t of [...expanded]) expanded.push(...(SEMANTIC_ALIASES[t] ?? []));
  return uniq(expanded.map((t) => t.toLowerCase()).filter((t) => t.length > 2));
}

/** Semantic scope/category match with a tiny controlled synonym map. This is
 * still a boost, never a filter; the compliance audit enforces hard scope. */
function categoryMatches(semantic: string, candidateText: string): boolean {
  const haystack = candidateText.toLowerCase();
  return semanticTerms(semantic).some((term) => haystack.includes(term));
}

// Tokenized-clone retrieval filter (§5.2, 2026-07-08): tokenized TradFi clones
// ("Tesla xStock", "SPDR S&P 500 ETF Trust Defichain") are near-perfect
// embedding matches for stock/ETF theses and crowd real funds out of the pool.
// The bare word "defichain" is deliberately NOT a marker — DFI, the real
// DeFiChain L1 coin, must survive; clone names betray themselves through the
// tokenization or TradFi-issuer words instead.
const CLONE_NAME_RE = /\btokeni[sz]ed\b|xstock\b|\bbstocks\b|\(backpack/i;
const CLONE_ISSUER_RE = /\b(ishares|spdr|vanguard|invesco|xtrackers|etf)\b/i;
/** Thesis is ABOUT tokenization → clones are the subject, keep them. */
const TOKENIZATION_THESIS_RE = /tokeni[sz]|\brwa\b|real[- ]world asset|xstock|on-?chain (stock|equit|treasur)/i;

function isTokenizedClone(c: Candidate): boolean {
  if (c.kind !== 'crypto') return false;
  if ((c.categories ?? []).some((cat) => /tokeni[sz]ed/i.test(cat))) return true;
  return CLONE_NAME_RE.test(c.name) || CLONE_ISSUER_RE.test(c.name);
}

async function retrieveForQuery(thesisText: string, req: Requirements, matchCount: number): Promise<Candidate[]> {
  const embedding = await embedQuery(thesisText, currentRunSignal());

  // Italy (§6) is a category-tag scope, not a region value: strip 'it' from
  // what SQL sees and pass italy_scope instead. Coarse=[] with Italy selected
  // means Italy-only — region_set must go null WITH the flag, never alone.
  const italyScope = !!req.regionSet?.includes('it');
  const coarseRegions: string[] = (req.regionSet ?? []).filter((r) => r !== 'it');
  const baseArgs = {
    thesis_embedding: JSON.stringify(embedding),
    asset_set: req.assetSet ?? null,
    region_set: req.regionSet ? (coarseRegions.length ? coarseRegions : null) : null,
    cap_set: req.capSet ?? null,
    cex_only: req.cexOnly ?? false,
    exclude_tickers: req.excludeTickers ?? [],
    match_count: matchCount,
  };
  let usedLegacySignature = false;
  let { data, error } = await supabase.rpc('match_candidates', {
    ...baseArgs,
    cn_hkex_only: req.cnHkexOnly ?? false,
    italy_scope: italyScope,
  });
  // Rolling-deploy compatibility: before db/rpc_match_candidates.sql is
  // applied, PostgREST only knows the old signatures. Retry without the new
  // args and enforce their rules locally; for Italy the old RPC widens to
  // eu+us (where Italy-tagged rows live) so tagged rows can enter the pool at
  // all — the local filter below narrows to the tag. After migration the
  // first call wins and SQL keeps the pool exact.
  if (error && /Could not find the function|schema cache/i.test(error.message)) {
    usedLegacySignature = true;
    const widened = italyScope ? [...new Set([...coarseRegions, 'eu', 'us'])] : baseArgs.region_set;
    ({ data, error } = await supabase.rpc('match_candidates', { ...baseArgs, region_set: widened }));
  }
  // Rolling-deploy compatibility for the 2026-07-11 HKSE normalization fix:
  // the previous SQL function accepted only HK/HKEX, but FMP persists HKSE.
  // A zero-row explicit-China response may therefore be a stale-function
  // false empty. Retry without the SQL flag and enforce HKSE locally below.
  if (!error && !usedLegacySignature && req.cnHkexOnly && (data ?? []).length === 0) {
    ({ data, error } = await supabase.rpc('match_candidates', {
      ...baseArgs,
      cn_hkex_only: false,
      italy_scope: italyScope,
    }));
  }
  if (error) throw new Error(`match_candidates RPC failed: ${error.message}`);
  let rows = (data ?? []) as Candidate[];
  if (req.cnHkexOnly) {
    rows = rows.filter(
      (a) => a.kind === 'crypto' || a.region !== 'cn' || /^(HK|HKEX|HKSE)$/i.test(a.exchange ?? ''),
    );
  }
  // Harmless after the SQL filter (§6 union already applied); load-bearing on
  // the fallback path, where the widened region_set over-fetched eu+us rows.
  if (italyScope) {
    rows = rows.filter(
      (a) =>
        a.kind === 'crypto' ||
        coarseRegions.includes(a.region) ||
        (a.categories ?? []).includes('Italy'),
    );
  }
  return rows;
}

/**
 * Retrieve up to 100 candidates for a thesis. `thesisText` MUST be the English
 * structured summary + themes from /thesis — never raw document text (§4.1c note).
 * Returns [] when nothing passes the hard filter: no relaxation, ever (§5.2.4).
 */
export async function getCandidates(
  thesisText: string,
  req: Requirements = {},
  opts: { queries?: string[]; finalCount?: number } = {},
): Promise<Candidate[]> {
  // Data queries (§15.3) rank quantitatively INSIDE the retrieved cohort, so a
  // wider pool strictly improves the answer; screening keeps the 100 that
  // /select can actually reason about.
  const finalCount = Math.max(1, Math.min(500, opts.finalCount ?? FINAL_COUNT));
  const queries = uniq([thesisText, ...(opts.queries ?? [])].map((q) => q.trim()).filter((q) => q.length > 2)).slice(0, 6);
  const byId = new Map<number, Candidate>();
  let lastStatementTimeout: Error | undefined;
  for (const [queryIdx, query] of queries.entries()) {
    const requestedCount = queryIdx === 0 ? FETCH_COUNT : SECONDARY_FETCH_COUNT;
    let rows: Candidate[];
    try {
      rows = await retrieveForQuery(query, req, requestedCount);
    } catch (error) {
      const err = error as Error;
      if (!/statement timeout|canceling statement/i.test(err.message)) throw err;
      lastStatementTimeout = err;
      // pgvector can occasionally exceed the database statement budget when
      // the HNSW scan is asked for a large, heavily filtered pool. Retry once
      // with a smaller pool; if it still times out, keep the other successful
      // thesis/theme queries instead of failing the entire multi-query run.
      try {
        rows = await retrieveForQuery(query, req, Math.min(requestedCount, queryIdx === 0 ? 200 : 100));
      } catch (retryError) {
        const retryErr = retryError as Error;
        if (!/statement timeout|canceling statement/i.test(retryErr.message)) throw retryErr;
        lastStatementTimeout = retryErr;
        continue;
      }
    }
    rows.forEach((row, rank) => {
      const fused = row.sim + 1 / (RRF_K + rank + 1);
      const cur = byId.get(row.id);
      if (!cur) {
        byId.set(row.id, { ...row, sim: fused, retrieval_query: query.slice(0, 120) });
      } else {
        const wasBetter = fused > cur.sim;
        cur.sim = Math.max(cur.sim, fused);
        if (!cur.retrieval_query || wasBetter) cur.retrieval_query = query.slice(0, 120);
      }
    });
  }

  if (byId.size === 0 && lastStatementTimeout) throw lastStatementTimeout;

  let candidates = [...byId.values()];

  // Tokenized clones out of retrieval (§5.2) — unless the thesis is about
  // tokenization itself. Anchors are unaffected: ensureAnchors force-includes
  // named assets after this, so SpaceX-via-SPCXB style fallbacks keep working.
  if (!TOKENIZATION_THESIS_RE.test(`${thesisText} ${req.semantic ?? ''}`)) {
    candidates = candidates.filter((c) => !isTokenizedClone(c));
  }

  // Semantic soft boost before the cut (boost, not filter — §5.2.3).
  if (req.semantic) {
    const sem = req.semantic;
    candidates = candidates.map((c) => ({
      ...c,
      sim: categoryMatches(sem, `${c.sector ?? ''} ${(c.categories ?? []).join(' ')} ${c.name}`) ? c.sim + SEMANTIC_BOOST : c.sim,
    }));
  }

  candidates.sort((a, b) => b.sim - a.sim);

  // Top slots by (boosted) similarity, remainder reserved for the largest
  // caps in the pool that similarity alone would have cut.
  // The rescue reserve scales with the pool so a widened request keeps the
  // same shape (85 of 100 by similarity, the remainder held for majors).
  const simSlots = Math.round(finalCount * (SIM_SLOTS / FINAL_COUNT));
  const head = candidates.slice(0, simSlots);
  const rescue = candidates
    .slice(simSlots)
    .filter(
      (c) =>
        c.cap_class === 'mega' ||
        c.cap_class === 'large' ||
        // Crypto's cap scale runs smaller: a $5B protocol (mid) is a major.
        (c.kind === 'crypto' && c.cap_class === 'mid'),
    )
    .slice(0, finalCount - head.length);
  return [...head, ...rescue].sort((a, b) => b.sim - a.sim).slice(0, finalCount);
}

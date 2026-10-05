/**
 * Shared run service (spec §13): the charge → SSE → pipeline → enrichment →
 * refund-on-failure core that both the browser route (/api/complete) and the
 * public API (/v1/screen) stream through. One implementation, so the two
 * surfaces cannot drift.
 *
 * The caller owns request parsing, thesis construction and crit merging; this
 * module owns everything from the credit charge to res.end().
 */
import type http from 'node:http';
import { completeResearch, type RunResult } from '../runtime/pipeline.js';
import { EMPTY_FINREQ, type FinReq } from '../runtime/finreq.js';
import { buildThesis, type Thesis } from '../runtime/thesis.js';
import { hasAnyConstraint, mergeCrit, type Crit } from '../runtime/requirements.js';
import { marketForAll, marketKey, type MarketAssetRef } from '../runtime/market.js';
import { displayFlags, presentPickData, runMarketNote, shouldFetchMarket, type Channel } from '../runtime/display-policy.js';
import { findPredictionMarkets, type PredictionPick } from '../runtime/polymarket.js';
import { recentNewsForPicks } from '../runtime/news.js';
import { assetLinks, type AssetLinks } from '../runtime/links.js';
import { supabase } from '../ingest/lib/supabase.js';
import { log } from '../ingest/lib/log.js';
import { spendCredit, refundCredit, logPrompt, type AuthedUser, type SpendResult } from './auth.js';
import { isUniverseName, universeToken, UNIVERSES, type UniverseName } from '../runtime/universe.js';
import { acquireRunSlot } from './ratelimit.js';
import { runFailureMessage } from '../runtime/errors.js';
import { RunAbortedError, throwIfRunAborted, withRunSignal } from '../runtime/runsignal.js';

// Recent news is disabled for beta (spec §5.7, 2026-07-16): the lookup was the
// dominant per-run cost on Sonnet and intermittently empty on Gemini. The UI
// shows "Coming soon." in the news box; flip the env to bring it back.
const NEWS_ENABLED = process.env.SIGNAL_NEWS_ENABLED === '1';

/** A picked asset's DB ref: market inputs plus link fields (vendor_id + website
 * + logo) and the asset's own enrichment text (the display policy's stand-in
 * for a vendor description it may not show). */
type PickRef = MarketAssetRef & { id: number; website_url?: string | null; logo_url?: string | null; enrichment?: string | null };

/** Fetch vendor refs for the picked asset ids (for /market and outbound links). */
async function vendorRefs(ids: number[]): Promise<PickRef[]> {
  if (!ids.length) return [];
  const { data, error } = await supabase
    .from('assets')
    .select('id, source, vendor_id, ticker, kind, currency, market_cap_usd, volume_24h_usd, website_url, logo_url, updated_at, private_data, market_snapshot, enrichment')
    .in('id', ids);
  if (error && /website_url|volume_24h_usd|logo_url|column .* does not exist/i.test(error.message)) {
    // Graceful pre-migration path: these fields are nullable additions. Until
    // their ALTERs run, fall back to the market-only ref set so runs never break.
    log.warn('assets.website_url/volume_24h_usd/logo_url missing; continuing without them (volume shows —)');
    const fallback = await supabase
      .from('assets')
      .select('id, source, vendor_id, ticker, kind, currency, market_cap_usd')
      .in('id', ids);
    if (fallback.error) throw new Error(`vendorRefs failed: ${fallback.error.message}`);
    return (fallback.data ?? []) as PickRef[];
  }
  if (error) throw new Error(`vendorRefs failed: ${error.message}`);
  return (data ?? []) as PickRef[];
}

export interface RunInput {
  /** Source document / prompt text the pipeline reads. */
  text: string;
  /** The (already sanitized) structured thesis driving the run. */
  thesis: Thesis;
  /** Fully merged requirements; pass what you have, empty crit runs open. */
  crit: Crit;
  /** Prediction markets: include them (§5.8) / run them alone. */
  wantsPm: boolean;
  pmOnly: boolean;
  breadth: 'focused' | 'diversified';
  /** When set, logged to prompt_log right after a successful charge (re-runs
   * and API/MCP runs never pass /api/thesis, which does the normal logging). */
  promptLog?: string;
  /**
   * Financial requirements as the review card left them (spec §15.3). Present
   * for browser runs, where the user may have removed a chip; absent for
   * /v1/screen and MCP, which let the pipeline extract from the text.
   */
  finReq?: FinReq;
  /** Tradable-universe mode (spec §16): picks come only from this universe's
   * allowlist and each carries its token contract in the payload. */
  universe?: UniverseName;
  /**
   * Who receives the result, for the data display policy
   * (runtime/display-policy.ts): 'web' for the website (/api/complete, a
   * signed-in browser session), 'api' for API keys and MCP. Set by the route
   * handler, never inferred here.
   */
  channel: Channel;
}

/** Programmatic constraint selectors (/v1/screen and the MCP run_screen tool). */
export interface ScreenConstraints {
  assets?: string[];
  regions?: string[];
  caps?: string[];
  cn_hkex_only?: boolean;
  /** Tradable-universe allowlist, e.g. 'robinhood' (spec §16). */
  universe?: string;
}

/**
 * Build a RunInput from programmatic input: thesis text → buildThesis, then
 * constraint selectors mirroring the review card (§6) — binding, validated
 * against the same allowlists; 'polymarket' is not a DB kind, it gates the
 * prediction-market path (§5.8). Document prose (docCrit) merges first, an
 * explicit selector beats it.
 */
export async function buildScreenInput(
  text: string,
  constraints: ScreenConstraints | null | undefined,
  breadthRaw: string | undefined,
  promptTag: '[API]' | '[MCP]',
  /** The route handler's channel (display policy): 'api' for a key or MCP,
   * 'web' for a signed-in browser session on /v1/screen. */
  channel: Channel,
): Promise<RunInput> {
  const thesis = await buildThesis(text);
  const universe = isUniverseName(constraints?.universe) ? constraints.universe : undefined;
  const sel = (constraints?.assets ?? [])
    .map(String)
    .filter((v) => ['stock', 'crypto', 'etf', 'bond', 'private', 'polymarket'].includes(v));
  const assetKinds = sel.filter((v) => v !== 'polymarket');
  const pmOnly = !universe && sel.includes('polymarket') && assetKinds.length === 0;
  // Universe mode: prediction markets are not tradable on the venue, so they
  // run only when explicitly asked for alongside the universe.
  const wantsPm = universe ? sel.includes('polymarket') : sel.length === 0 || sel.includes('polymarket');
  const regions = (constraints?.regions ?? [])
    .map(String)
    .filter((v) => ['us', 'eu', 'cn', 'it', 'other'].includes(v));
  const caps = (constraints?.caps ?? [])
    .map(String)
    .filter((v) => ['mega', 'large', 'mid', 'small', 'micro'].includes(v));
  let crit: Crit = thesis.docCrit ?? { constrained: true };
  if (assetKinds.length || regions.length || caps.length) {
    const cc: Crit = { constrained: true };
    if (assetKinds.length) cc.asset_set = assetKinds;
    if (regions.length) cc.region_set = regions;
    if (caps.length) cc.cap_set = caps;
    if (constraints?.cn_hkex_only === true && regions.includes('cn')) cc.cn_hkex_only = true;
    crit = mergeCrit(crit, cc);
  }
  return {
    text,
    thesis,
    crit,
    wantsPm,
    pmOnly,
    breadth: breadthRaw === 'diversified' ? 'diversified' : 'focused',
    universe,
    // API/MCP runs never pass /api/thesis, so the prompt log happens here
    // (tagged; written after the charge).
    promptLog: `${promptTag} ${text.slice(0, 2000)}`,
    channel,
  };
}

/** Thrown by performRun before any output when the daily budget is spent. */
export class OutOfCreditsError extends Error {
  constructor(public credits: number, public cap: number) {
    super('No credits left today. Credits refresh every day at midnight UTC.');
    this.name = 'OutOfCreditsError';
  }
}

/**
 * Non-charging pre-flight for callers that spend LLM money BEFORE performRun
 * charges (buildScreenInput's thesis extraction, audit N3): a key whose owner
 * has no credit left must not trigger a single model call. The atomic charge
 * in performRun stays authoritative; this only peeks.
 */
export async function assertCreditAvailable(
  user: AuthedUser | null,
  peekCredit: typeof spendCredit = spendCredit, // injectable for the offline test
): Promise<void> {
  if (!user) return;
  const peek = await peekCredit(user.id, 0, 'daily_reset');
  if (peek.credits < 1) throw new OutOfCreditsError(peek.credits, peek.cap);
}

export interface RunHooks {
  /** After the charge cleared (null when auth is off) and before the pipeline
   * starts — the moment a streaming caller should open its stream. */
  onStart: (charged: SpendResult | null) => void;
  /** §5.7 transparency lines as the run progresses. */
  onStatus: (line: string) => void;
  /** A failed run refunded its credit (fires before the error is rethrown). */
  onRefund?: (refunded: SpendResult) => void;
  /** Fires when the client that asked for the run has gone away (closed tab,
   * cancelled MCP call): the pipeline stops at the next LLM call or status
   * line instead of finishing for nobody (review R12). */
  signal?: AbortSignal;
}

/** An AbortSignal that fires when the HTTP client disconnects before the
 * response has finished (review R12). Create it as early as the handler can,
 * so a disconnect during thesis extraction is caught too. */
export function abortWhenClientGone(res: http.ServerResponse): AbortSignal {
  const ac = new AbortController();
  const gone = () => {
    if (!res.writableFinished) ac.abort(new RunAbortedError());
  };
  if (res.destroyed) gone();
  else res.once('close', gone);
  return ac.signal;
}

/**
 * The run core shared by /api/complete, /v1/screen and the MCP server:
 * charge 1 credit (spec §12) → pipeline → market/news/links enrichment →
 * the result payload. A failed run refunds the credit and rethrows;
 * out-of-credits throws OutOfCreditsError before onStart.
 */
export async function performRun(
  user: AuthedUser | null,
  input: RunInput,
  hooks: RunHooks,
): Promise<Record<string, unknown>> {
  // A client that already left gets neither a slot nor a charge.
  throwIfRunAborted(hooks.signal);
  // At most MAX_CONCURRENT_RUNS (default 2) runs in flight per user, taken
  // BEFORE the charge so a refused run costs nothing (audit H2). Signed-out
  // open-access servers have no user to key on and rely on the IP limits.
  const release = user ? acquireRunSlot(user.id) : null;
  try {
    // The signal rides AsyncLocalStorage into every LLM call of the run.
    return await withRunSignal(hooks.signal, () => performRunCharged(user, input, hooks));
  } finally {
    release?.();
  }
}

async function performRunCharged(
  user: AuthedUser | null,
  input: RunInput,
  hooks: RunHooks,
): Promise<Record<string, unknown>> {
  const { text, thesis, crit, wantsPm, pmOnly, breadth } = input;
  // Data display policy (runtime/display-policy.ts), read once per run.
  const flags = displayFlags();
  let charged: SpendResult | null = null;
  if (user) {
    // Re-checked right before the charge: callers may have spent seconds on
    // the thesis extraction since the client was last seen.
    throwIfRunAborted(hooks.signal);
    charged = await spendCredit(user.id, 1, 'search');
    if (!charged.ok) throw new OutOfCreditsError(charged.credits, charged.cap);
    // Logged after the charge: a refusal is not a search.
    if (input.promptLog) logPrompt(user, input.promptLog);
  }
  // Every status line is a stage boundary: a run whose client has gone stops
  // at the next one (review R12) — the in-flight LLM call is aborted too.
  const send = (event: 'status', data: string) => {
    throwIfRunAborted(hooks.signal);
    hooks.onStatus(data);
  };
  try {
    // Inside the try: once the credit is spent, every failure path refunds.
    hooks.onStart(charged);
    // Prediction markets (spec §5.8) run concurrently with the asset pipeline —
    // thesis-only input, degrades to [] on failure, never blocks the picks.
    const predictionsP: Promise<PredictionPick[]> = wantsPm
      ? findPredictionMarkets(thesis).catch((err) => {
          log.error('polymarket lookup failed', err);
          return [];
        })
      : Promise.resolve([]);
    let result: RunResult;
    let market: Awaited<ReturnType<typeof marketForAll>> = {};
    let news: Awaited<ReturnType<typeof recentNewsForPicks>> = {};
    // Keyed by asset id, never by ticker: tickers collide across sources and
    // exchanges (crypto ETH vs an ETF trading as ETH), and a ticker key attached
    // one asset's price, links and logo to the other's card (review R1).
    const refById = new Map<number, PickRef>();
    const links = new Map<number, AssetLinks>();
    if (pmOnly) {
      send('status', 'Prediction markets only. Listed assets will not be screened.');
      result = { thesis, candidates: [], picks: [], analysis: {}, status: [], path: 'full', breadth: 'focused', finReq: EMPTY_FINREQ };
    } else {
      result = await completeResearch(
        text,
        thesis,
        hasAnyConstraint(crit) ? crit : null,
        (line) => send('status', line),
        undefined,
        { breadth, finReq: input.finReq, universe: input.universe, channel: input.channel },
      );
      const refs = await vendorRefs(result.picks.map((p) => p.a.id));
      // Only what this channel may show is fetched (display policy): a withheld
      // equity costs no FMP call, an API run without relay rights no CoinGecko call.
      const toFetch = refs.filter((r) => shouldFetchMarket(r, input.channel, flags));
      // Said only when something will load (e2e P2-3).
      if (toFetch.length) send('status', 'Loading prices and 30 day history…');
      market = await marketForAll(toFetch);
      for (const r of refs) refById.set(r.id, r);
      // Outbound links (spec §5.6b): project/company site + a financial-info
      // platform (CoinGecko / Yahoo Finance).
      for (const p of result.picks) {
        const r = refById.get(p.a.id);
        links.set(p.a.id, assetLinks({
          kind: p.a.kind,
          vendor_id: r?.vendor_id,
          ticker: p.a.ticker,
          website_url: r?.website_url,
          source: r?.source,
        }));
      }
      if (NEWS_ENABLED && result.picks.length) {
        send('status', 'Checking recent news for the final assets…');
        try {
          news = await recentNewsForPicks(thesis.summary, result.picks);
          send(
            'status',
            Object.keys(news).length
              ? `Found recent news sources for ${Object.keys(news).length} final asset${Object.keys(news).length > 1 ? 's' : ''}.`
              : 'No material recent news sources found for the final assets.',
          );
        } catch (err) {
          log.error('recent news lookup failed', err);
          send('status', 'Recent news is unavailable. The screen will continue without it.');
        }
      }
    }
    let predictions: PredictionPick[] = [];
    if (wantsPm) {
      send('status', 'Scanning Polymarket for related prediction markets…');
      predictions = await predictionsP;
      send(
        'status',
        predictions.length
          ? `Found ${predictions.length} related prediction market${predictions.length > 1 ? 's' : ''}.`
          : 'No related prediction markets found.',
      );
    }
    const picks = result.picks.map((p) => {
      const ref = refById.get(p.a.id);
      // Vendor-dependent fields through the display policy: market object,
      // vendor description (or the asset's own enrichment text), ETF portfolio
      // and vendor-hosted logo. Identity fields are always shown.
      const shown = presentPickData(
        {
          source: ref?.source,
          kind: p.a.kind,
          market: ref ? (market[marketKey(ref)] ?? null) : null,
          blurb: p.a.blurb,
          enrichment: ref?.enrichment,
          etf_portfolio: p.a.etf_portfolio,
          logo: ref?.logo_url,
        },
        input.channel,
        flags,
      );
      return {
        ticker: p.a.ticker,
        name: p.a.name,
        kind: p.a.kind,
        region: p.a.region,
        exchange: p.a.exchange,
        sector: p.a.sector,
        categories: (p.a.categories ?? []).slice(0, 6),
        etf_portfolio: shown.etf_portfolio,
        cex_venues: (p.a.cex_venues ?? []).slice(0, 6),
        dex_venues: (p.a.dex_venues ?? []).slice(0, 4),
        score: p.score,
        rel: p.rel,
        dir: p.dir ?? 'long',
        strategy: p.strategy ?? null,
        why: p.why,
        about: shown.about,
        // analysis/news stay ticker-keyed: the pipeline guarantees one pool
        // row per ticker before /select (uniqueTickers), so picks cannot collide.
        analysis: result.analysis[p.a.ticker] ?? null,
        market: shown.market,
        market_withheld: shown.market_withheld,
        news: news[p.a.ticker] ?? null,
        website: links.get(p.a.id)?.website ?? null,
        platform: links.get(p.a.id)?.platform ?? null,
        logo: shown.logo,
        // The pick's tradable token contract (universe mode only): the hard
        // execution-side allowlist is the SMA mandate, but the screen hands
        // over addresses so the agent never resolves tickers on its own.
        token: input.universe ? universeToken(input.universe, p.a.ticker) : undefined,
      };
    });
    return {
      thesis: result.thesis,
      crit,
      path: result.path,
      pmOnly,
      breadth: result.breadth,
      // Universe mode (§16): name the universe and chain so an execution agent
      // can trust the token fields below came from the allowlist it expects.
      universe: input.universe ? { name: input.universe, chainId: UNIVERSES[input.universe].chainId } : null,
      predictions,
      picks,
      // Why market data is missing, when the display policy withheld it (null otherwise).
      market_note: runMarketNote(input.channel, flags, picks),
    };
  } catch (err) {
    if (err instanceof RunAbortedError || hooks.signal?.aborted) {
      // The client left: stop quietly. The credit stays spent, exactly as when
      // a finished run's result went undelivered before cancellation existed;
      // refunding here would let a start-and-cancel loop spend model money
      // without ever touching the daily credit budget, the product's single
      // spend guard (spec §13).
      log.info(`run cancelled: the client disconnected${user ? ` (user ${user.id})` : ''}`);
      throw err instanceof RunAbortedError ? err : new RunAbortedError();
    }
    log.error('research failed', err);
    // A failed run is not a spent search: give the credit back before erroring.
    if (charged && user) {
      const refunded = await refundCredit(user.id);
      if (refunded) hooks.onRefund?.(refunded);
    }
    throw err;
  }
}

/**
 * SSE surface over performRun (/api/complete and /v1/screen): `credits`,
 * `status` lines, one final `result` (or `error`), with a heartbeat for
 * Cloudflare. Out-of-credits answers a plain 402 before any stream.
 */
export async function executeRunSSE(
  user: AuthedUser | null,
  input: RunInput,
  res: http.ServerResponse,
  /** Pass the signal the handler already created (it may have spent LLM time
   * before this call); otherwise one is tied to this response here. */
  signal: AbortSignal = abortWhenClientGone(res),
): Promise<void> {
  let heartbeat: NodeJS.Timeout | null = null;
  const send = (event: string, data: unknown) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const startStream = () => {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    // Cloudflare (fronting synthetick.org) drops a streaming response after
    // ~100s without bytes, and the long pipeline stages (news lookup, select)
    // can stay silent longer than that. A comment line every 20s keeps the
    // connection alive; the client's SSE parser skips blocks with no event field.
    heartbeat = setInterval(() => {
      if (!res.writableEnded && !res.destroyed) res.write(': hb\n\n');
    }, 20_000);
    // A closed tab must not leave the timer firing for the rest of the run.
    res.once('close', () => {
      if (heartbeat) clearInterval(heartbeat);
    });
  };
  try {
    const payload = await performRun(user, input, {
      signal,
      onStart: (charged) => {
        startStream();
        if (charged) send('credits', { credits: charged.credits, cap: charged.cap });
      },
      onStatus: (line) => send('status', line),
      onRefund: (r) => send('credits', { credits: r.credits, cap: r.cap }),
    });
    send('result', payload);
  } catch (err) {
    if (err instanceof RunAbortedError) {
      // Nobody is listening any more: release the stream quietly.
      if (heartbeat) clearInterval(heartbeat);
      if (!res.writableEnded) res.end();
      return;
    }
    if (err instanceof OutOfCreditsError && !heartbeat) {
      // The charge was refused before any stream bytes: a plain 402.
      res.writeHead(402, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: err.message, code: 'payment_required', credits: err.credits, cap: err.cap }));
      return;
    }
    if (!heartbeat) throw err; // pre-stream failure: the router answers {error, code} JSON
    // Mid-stream: a curated message plus a stable code, never the raw upstream
    // text (OpenRouter/Voyage/Supabase bodies); the detail is already logged
    // by performRun (audit M4).
    send('error', runFailureMessage(err));
  }
  if (heartbeat) clearInterval(heartbeat);
  res.end();
}

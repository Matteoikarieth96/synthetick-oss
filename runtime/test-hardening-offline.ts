/**
 * Offline regression tests for the 2026-10 final correctness pass
 * (scratchpad report final-bugs.md). No network, no keys, no DB: `fetch` and
 * the shared Supabase client's methods are replaced in-process.
 *   npx tsx runtime/test-hardening-offline.ts
 */
import { EventEmitter } from 'node:events';

// The shared clients need these to construct; nothing is ever sent to them.
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'placeholder';
process.env.VOYAGE_KEY ||= 'placeholder';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${name}${detail ? `: ${detail}` : ''}`);
}
async function rejectsWith(p: Promise<unknown>, test: (e: unknown) => boolean): Promise<boolean> {
  try {
    await p;
    return false;
  } catch (e) {
    return test(e);
  }
}

const req = await import('./requirements.js');
const { fundMatchesRegions } = await import('./fundgeo.js');
const { clipText, clipBlurb, BLURB_CHARS } = await import('./text.js');
const { parseAnalysis, fallbackAnalysis } = await import('./analysis.js');
const { uniqueTickers } = await import('./pipeline.js');
const { marketForAll, marketKey } = await import('./market.js');
const { withRunSignal, RunAbortedError } = await import('./runsignal.js');
const { callClaude } = await import('./llm.js');
const { embedQuery, findStaleEmbeddings } = await import('../ingest/embeddings/voyage.js');
const { supabase, deactivateMissing } = await import('../ingest/lib/supabase.js');
const { performRun, abortWhenClientGone } = await import('../server/run.js');
const { acquireRunSlot } = await import('../server/ratelimit.js');
const { revokeKey } = await import('../server/keys.js');
const { completeLink, signState } = await import('../server/xlink.js');
const { getMentions, MAX_MENTION_PAGES } = await import('../bot/x-api.js');
type Candidate = import('./candidates.js').Candidate;
type Pick = import('./select.js').Pick;
type Thesis = import('./thesis.js').Thesis;

const realFetch = globalThis.fetch;
const sb = supabase as unknown as Record<string, unknown>;
const realFrom = sb.from;
const realRpc = sb.rpc;

// ---- negated mentions never become required classes/regions -----------------
const off = (t: string, instrOnly = true) => req.offlineConstraints(t, instrOnly);
const dice = off('I want diversified exposure to the global energy transition through ETFs only, no single stocks.');
check('negation: "ETFs only, no single stocks" binds ETFs, not stocks', JSON.stringify(dice.asset_set) === '["etf"]', JSON.stringify(dice.asset_set));
const notStocks = off('Give me only ETFs, not stocks.');
check('negation: "only ETFs, not stocks" stays ETF-only', JSON.stringify(notStocks.asset_set) === '["etf"]' && notStocks.asset_exclusive === true, JSON.stringify(notStocks));
const notChina = off('Only stocks not listed in China.');
check('negation: "not listed in China" does NOT bind China', !notChina.region_set?.length && JSON.stringify(notChina.asset_set) === '["stock"]', JSON.stringify(notChina));
const noAdrs = off('Only US companies, no Chinese ADRs.');
check('negation: "no Chinese ADRs" keeps US-only', JSON.stringify(noAdrs.region_set) === '["us"]', JSON.stringify(noAdrs.region_set));
const nonUs = off('Only non-US stocks.');
check('negation: "non-US" never binds the US', !nonUs.region_set?.includes('us') && JSON.stringify(nonUs.asset_set) === '["stock"]', JSON.stringify(nonUs));
const dont = off("I don't want bonds, give me ETFs.");
check("negation: \"don't want bonds\" adds no bond class", JSON.stringify(dont.asset_set) === '["etf"]', JSON.stringify(dont.asset_set));
const noSmall = off('Show me crypto but no small caps.');
check('negation: "no small caps" binds no small-cap set', !noSmall.cap_set?.length, JSON.stringify(noSmall.cap_set));
const notOnly = off('I want not only stocks but also ETFs.');
check('"not only X but also Y" is not a negation', ['stock', 'etf'].every((k) => notOnly.asset_set?.includes(k)), JSON.stringify(notOnly.asset_set));
const defense = off('Only US stocks, no defense.');
check('exclusion tags still read the negation ("no defense")', defense.exclusions_set?.includes('defense') === true && JSON.stringify(defense.region_set) === '["us"]', JSON.stringify(defense));
const box = req.offlineConstraints('crypto please, but without stocks or ETFs');
check('full-text mode (plain-language box) honors negation too', JSON.stringify(box.asset_set) === '["crypto"]', JSON.stringify(box.asset_set));
const merged = req.mergeCrit({ asset_set: ['etf'], constrained: true }, off('I want ETFs, not stocks.'), { sameSource: true });
check('dual-extractor merge: regex no longer puts the negated class back', JSON.stringify(merged.asset_set) === '["etf"]', JSON.stringify(merged.asset_set));

// ---- LLM code normalization ----------------------------------------------------
check('regionSet: upper-case codes are not dropped', JSON.stringify(req.regionSet(['US', 'EU', ' China '])) === '["us","eu","cn"]', JSON.stringify(req.regionSet(['US', 'EU', ' China '])));
check('normalizeAssetClass: plurals and synonyms', ['Stocks', 'ETFs', 'equities', 'Bonds', 'cryptocurrencies', 'pre-IPO'].map(req.normalizeAssetClass).join(',') === 'stock,etf,stock,bond,crypto,private');
check('normalizeAssetClass: unknown words are dropped', req.normalizeAssetClass('real estate') === '' && req.normalizeAssetClass('') === '');
check('normalizeCapClass: "Large-cap", "mid caps"', req.normalizeCapClass('Large-cap') === 'large' && req.normalizeCapClass('mid caps') === 'mid' && req.normalizeCapClass('huge') === '');
check('hasAnyConstraint: a CEX-only venue rule alone still binds', req.hasAnyConstraint({ cex_only: true }) && !req.hasAnyConstraint({ risk: 'low' }));

// ---- fund geography: the allowed SET is judged as a whole ---------------------
const mixed = { region_weights: [{ name: 'United States', weight: 45 }, { name: 'France', weight: 45 }, { name: 'Japan', weight: 10 }] };
check('fund 45% US + 45% EU satisfies "US or EU"', fundMatchesRegions(mixed, ['us', 'eu']) === true);
check('...but not "US" alone', fundMatchesRegions(mixed, ['us']) === false);
const italian = { region_weights: [{ name: 'Italy', weight: 30 }, { name: 'France', weight: 25 }, { name: 'Japan', weight: 45 }] };
check('overlapping set (eu + it) counts each slice once', fundMatchesRegions(italian, ['eu', 'it']) === true && fundMatchesRegions(italian, ['it']) === false);
check('no breakdown is still unverifiable (null)', fundMatchesRegions({}, ['us', 'eu']) === null);

// ---- clipping at word boundaries ----------------------------------------------
check('clipText: short text untouched', clipText('  short  ', 10) === 'short');
const clipped = clipText('alpha beta gamma delta', 12);
check('clipText: cut at a word boundary with an ellipsis', clipped === 'alpha beta…', clipped);
check('clipText: never longer than max', clipText('x'.repeat(50), 10).length <= 10);
const blurb = `${'word '.repeat(59)}specifically those`.slice(0, BLURB_CHARS);
const cb = clipBlurb(blurb);
check('clipBlurb: a query-truncated blurb no longer ends mid-word', cb.endsWith('…') && !/specifically tho…$/.test(cb) && cb.length <= BLURB_CHARS, cb.slice(-30));
check('clipBlurb: a whole short description passes through', clipBlurb('A short description.') === 'A short description.');
const pick = (ticker: string, why = 'direct exposure'): Pick =>
  ({ a: { ticker, name: `${ticker} Inc`, kind: 'etf', id: 1 } as unknown as Candidate, score: 70, why, rel: 'adjacent' }) as Pick;
const longAnalysis = `${'The fund tracks income maximization strategies across sectors. '.repeat(14)}income maximization`;
const pa = parseAnalysis(JSON.stringify({ FHYS: longAnalysis }), [pick('FHYS')])['FHYS'] ?? '';
check('parseAnalysis: an over-long analysis is clipped at a word boundary', pa.length <= 800 && pa.endsWith('…') && !/maxi…$/.test(pa), pa.slice(-40));
const fb = fallbackAnalysis([pick('FHYS', 'x '.repeat(10) + 'income maximization '.repeat(20))])['FHYS'] ?? '';
check('fallbackAnalysis: no mid-word cut, no "…." double stop', !/maxi\.$/.test(fb) && !fb.endsWith('….'), fb.slice(-30));
// e2e E6: the constraint note (quoted in the PDF criteria) and the audit's drop
// reason (a status line) end on a whole word.
const atWordEnd = (full: string, cut: string) => {
  const body = cut.replace(/…$/, '');
  return cut.endsWith('…') && full.startsWith(body) && /[\s,;:.]/.test(full[body.length] ?? ' ');
};
const restriction = 'Only crypto related to the Ethereum ecosystem, specifically ETH-native protocols and nothing merely bridged.';
const restrictionNote = off(restriction).constraint_note ?? '';
check('E6 offline constraint note: clipped at a word boundary', restrictionNote.length <= 90 && atWordEnd(restriction, restrictionNote), restrictionNote);
const { filterViolations } = await import('./audit.js');
const ecoScope = { constraint_note: 'only crypto related to the Ethereum ecosystem' };
const longWhy = 'outside the Ethereum ecosystem: not clearly Ethereum-native staking protocol infrastructure';
const dropWhy = filterViolations([{ t: 'ARB', c: 'semantic', why: longWhy }], ecoScope, new Set(['ARB'])).drop.ARB ?? '';
check('E6 audit drop reason: clipped at a word boundary', dropWhy.length <= 60 && atWordEnd(longWhy, dropWhy), dropWhy);
check('E6 audit: a blank reason still drops the pick, with the default text', filterViolations([{ t: 'ARB', c: 'semantic', why: '   ' }], ecoScope, new Set(['ARB'])).drop.ARB === 'violates your instructions');

// ---- R1: one pool row per ticker; market data keyed by source + vendor id -----
const cand = (id: number, ticker: string, kind: string, sim: number): Candidate =>
  ({ id, ticker, name: `${kind} ${id}`, kind, region: 'us', sim, categories: [] }) as unknown as Candidate;
const pool = uniqueTickers([cand(1, 'ETH', 'crypto', 0.6), cand(2, 'SOL', 'crypto', 0.5), cand(3, 'eth', 'etf', 0.55), cand(4, 'ARB', 'crypto', 0.4)]);
check('uniqueTickers: colliding tickers keep the better-matching row', pool.length === 3 && pool.some((c) => c.id === 1) && !pool.some((c) => c.id === 3), JSON.stringify(pool.map((c) => c.id)));
check('uniqueTickers: order of the survivors is preserved', JSON.stringify(pool.map((c) => c.id)) === '[1,2,4]');
const noDup = [cand(1, 'A', 'stock', 0.1), cand(2, 'B', 'stock', 0.2)];
check('uniqueTickers: no collision returns the same array', uniqueTickers(noDup) === noDup);
// sacra rows short-circuit inside marketFor: no vendor call is made.
const refs = [
  { source: 'sacra' as const, vendor_id: 'one.example', ticker: 'DUP', market_cap_usd: 1e9 },
  { source: 'sacra' as const, vendor_id: 'two.example', ticker: 'DUP', market_cap_usd: 2e9 },
];
const md = await marketForAll(refs);
check(
  'marketForAll: two assets sharing a ticker keep their own data',
  md[marketKey(refs[0]!)]?.marketCap === 1e9 && md[marketKey(refs[1]!)]?.marketCap === 2e9 && Object.keys(md).length === 2,
  JSON.stringify(Object.keys(md)),
);

// ---- R12: a cancelled run stops its model calls -------------------------------
process.env.OPENROUTER_API_KEY = 'offline-test-key'; // fetch is stubbed below; nothing leaves the process
let fetchCalls = 0;
try {
  globalThis.fetch = (async () => {
    fetchCalls++;
    throw new Error('fetch must not be called');
  }) as typeof fetch;
  const gone = new AbortController();
  gone.abort();
  check(
    'callClaude: an already-cancelled run makes no request',
    (await rejectsWith(withRunSignal(gone.signal, () => callClaude('hi')), (e) => e instanceof RunAbortedError)) && fetchCalls === 0,
    `fetch calls ${fetchCalls}`,
  );
  check(
    'embedQuery: a cancelled run makes no request',
    (await rejectsWith(embedQuery('thesis', gone.signal), (e) => /aborted/.test((e as Error).message))) && fetchCalls === 0,
  );

  fetchCalls = 0;
  globalThis.fetch = ((_u: unknown, init?: RequestInit) => {
    fetchCalls++;
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
  }) as typeof fetch;
  const midway = new AbortController();
  const inflight = withRunSignal(midway.signal, () => callClaude('hi'));
  setTimeout(() => midway.abort(), 20);
  check(
    'callClaude: cancelling mid-request aborts it and is never retried as a timeout',
    (await rejectsWith(inflight, (e) => e instanceof RunAbortedError)) && fetchCalls === 1,
    `fetch calls ${fetchCalls}`,
  );
} finally {
  globalThis.fetch = realFetch;
}

const res1 = Object.assign(new EventEmitter(), { writableFinished: false, destroyed: false });
const s1 = abortWhenClientGone(res1 as never);
res1.emit('close');
const res2 = Object.assign(new EventEmitter(), { writableFinished: true, destroyed: false });
const s2 = abortWhenClientGone(res2 as never);
res2.emit('close');
const s3 = abortWhenClientGone({ destroyed: true, writableFinished: false, once() {} } as never);
check('abortWhenClientGone: a close before the response finished aborts', s1.aborted);
check('abortWhenClientGone: the normal close after res.end() does not', !s2.aborted);
check('abortWhenClientGone: an already-closed response is aborted at once', s3.aborted);

const thesis = { title: 'T', stance: '', summary: 'S', intent: 'thematic', direction: 'long', anchors: [], private_entities: [], avoid: [], themes: [], strategies: [], docCrit: {} } as Thesis;
const input = { text: 'x', thesis, crit: {}, wantsPm: false, pmOnly: true, breadth: 'focused' as const, channel: 'web' as const };
const user = { id: 'offline-user', email: '' };
const rpcCalls: string[] = [];
sb.rpc = async (name: string) => {
  rpcCalls.push(name);
  return { data: { ok: true, credits: 9, cap: 10 }, error: null };
};
try {
  const before = new AbortController();
  before.abort();
  const early = await rejectsWith(
    performRun(user, input, { signal: before.signal, onStart: () => {}, onStatus: () => {} }),
    (e) => e instanceof RunAbortedError,
  );
  check('performRun: a client gone before the start is neither charged nor slotted', early && rpcCalls.length === 0, rpcCalls.join(','));

  const during = new AbortController();
  let refunded = false;
  const cancelled = await rejectsWith(
    performRun(user, input, { signal: during.signal, onStart: () => during.abort(), onStatus: () => {}, onRefund: () => (refunded = true) }),
    (e) => e instanceof RunAbortedError,
  );
  check(
    'performRun: a client gone mid-run stops at the next stage, charge kept (no refund loop)',
    cancelled && JSON.stringify(rpcCalls) === '["spend_credit"]' && !refunded,
    rpcCalls.join(','),
  );
  const a = acquireRunSlot(user.id);
  const b = acquireRunSlot(user.id);
  check('performRun: cancelled runs released their concurrency slots', typeof a === 'function' && typeof b === 'function');
  a();
  b();

  rpcCalls.length = 0;
  const failed = await rejectsWith(
    performRun(user, input, {
      onStart: () => {},
      onStatus: () => {
        throw new Error('pipeline broke');
      },
      onRefund: () => (refunded = true),
    }),
    (e) => (e as Error).message === 'pipeline broke',
  );
  check('performRun: a genuine failure still refunds', failed && JSON.stringify(rpcCalls) === '["spend_credit","add_credit"]' && refunded, rpcCalls.join(','));
} finally {
  sb.rpc = realRpc;
}

// ---- R2: offset pagination is ordered -----------------------------------------
function recordingClient(log: string[]) {
  const chain: unknown = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === 'then') return (resolve: (v: unknown) => void) => resolve({ data: [], error: null, count: 0 });
      return (..._args: unknown[]) => {
        log.push(String(prop));
        return chain;
      };
    },
  });
  return (table: string) => {
    log.push(`from:${table}`);
    return chain;
  };
}
const orderedBeforeRange = (log: string[], table: string) => {
  const start = log.indexOf(`from:${table}`);
  const range = log.indexOf('range', start);
  const order = log.indexOf('order', start);
  return start >= 0 && order > start && order < range;
};
try {
  const log1: string[] = [];
  sb.from = recordingClient(log1);
  await deactivateMissing('coingecko', []);
  check('deactivateMissing: active rows are paged in a stable order', orderedBeforeRange(log1, 'assets'), log1.join(' '));
  const log2: string[] = [];
  sb.from = recordingClient(log2);
  await findStaleEmbeddings('coingecko');
  check('findStaleEmbeddings: rows are paged in a stable order', orderedBeforeRange(log2, 'assets'), log2.join(' '));

  // ---- keys: a malformed id is a 404, not a database error ----------------------
  sb.from = () => {
    throw new Error('must not query');
  };
  check('revokeKey: a non-UUID id is "not found" without touching the DB', (await revokeKey('u', 'not-a-uuid')) === false);
} finally {
  sb.from = realFrom;
}

// ---- B8: admin reads page past PostgREST's 1,000-row cap ------------------------
const { selectAllPages } = await import('../server/paging.js');
const ranges: string[] = [];
const all = await selectAllPages(async (from, to) => {
  ranges.push(`${from}-${to}`);
  const total = 2003;
  const rows = Array.from({ length: Math.max(0, Math.min(to, total - 1) - from + 1) }, (_, i) => ({ n: from + i }));
  return { data: rows, error: null };
});
check('selectAllPages: reads every row past the 1,000 cap', all.data.length === 2003 && all.data[2002]?.n === 2002 && ranges.join(',') === '0-999,1000-1999,2000-2999', ranges.join(','));
const failedPage = await selectAllPages(async (from) => (from ? { data: null, error: { message: 'boom' } } : { data: new Array(1000).fill({}), error: null }));
check('selectAllPages: a failing page surfaces its error', failedPage.error?.message === 'boom');

// ---- X link: a network failure is an outcome, not a raw error page -------------
try {
  globalThis.fetch = (async () => {
    throw new TypeError('fetch failed');
  }) as typeof fetch;
  check('completeLink: network failure answers "error"', (await completeLink('code', signState('u1', 'verifier'))) === 'error');
} finally {
  globalThis.fetch = realFetch;
}

// ---- R4: the bot reads every page of a mention burst ---------------------------
const urls: string[] = [];
const tweet = (id: string) => ({ id, text: `@SyntheTick ${id}`, author_id: 'a' });
try {
  globalThis.fetch = (async (u: unknown) => {
    const url = new URL(String(u));
    urls.push(url.search);
    const token = url.searchParams.get('pagination_token');
    const body =
      token === 't2'
        ? { data: [tweet('102'), tweet('101')], meta: { newest_id: '102' } }
        : { data: [tweet('105'), tweet('104'), tweet('103')], includes: { tweets: [tweet('99')] }, meta: { newest_id: '105', next_token: 't2' } };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const page = await getMentions('bot', '100');
  check(
    'getMentions: follows next_token and returns the whole burst oldest first',
    JSON.stringify(page.mentions.map((m) => m.id)) === '["101","102","103","104","105"]',
    JSON.stringify(page.mentions.map((m) => m.id)),
  );
  check('getMentions: the watermark is the newest id of the first page', page.newestId === '105');
  check('getMentions: the second page keeps since_id and passes the token', urls.length === 2 && /since_id=100/.test(urls[1]!) && /pagination_token=t2/.test(urls[1]!));
  check('getMentions: expansions from every page are merged', page.parents.has('99'));
  urls.length = 0;
  await getMentions('bot', null);
  check('getMentions: the first-run watermark call reads one page only', urls.length === 1);
  check('getMentions: the page cap is finite', MAX_MENTION_PAGES > 1 && MAX_MENTION_PAGES <= 20);
} finally {
  globalThis.fetch = realFetch;
}

// ---- pipeline end to end, offline: a named asset is held to numeric requirements ---
// Supabase (rpc + query builder), Voyage and OpenRouter are all stubbed here.
const { completeResearch } = await import('./pipeline.js');
const { llmSelect } = await import('./select.js');
function tableClient(rows: (q: { table: string; select: string; filters: Record<string, unknown> }) => unknown[]) {
  return (table: string) => {
    const q = { table, select: '', filters: {} as Record<string, unknown> };
    const chain: unknown = new Proxy(function () {}, {
      get(_t, prop) {
        if (prop === 'then') return (resolve: (v: unknown) => void) => resolve({ data: rows(q), error: null });
        return (...args: unknown[]) => {
          if (prop === 'select') q.select = String(args[0] ?? '');
          if (prop === 'in' || prop === 'eq') q.filters[String(args[0])] = args[1];
          return chain;
        };
      },
    });
    return chain;
  };
}
const row = (id: number, ticker: string, kind = 'stock', sim = 0.5) => ({
  id, ticker, name: `${ticker} Corp`, kind, region: 'us', cap_class: 'large', exchange: 'NASDAQ',
  cex_venues: [], dex_venues: [], sector: 'Technology', categories: [], etf_portfolio: null,
  volume_24h_usd: null, blurb: `${ticker} makes chips`, sim,
});
const llmReplies = { select: '[]', stretch: '[]' };
let stretchCalls = 0;
const stubFetch = (async (u: unknown, init?: RequestInit) => {
  const url = String(u);
  if (url.includes('voyageai')) {
    return new Response(JSON.stringify({ data: [{ embedding: new Array(512).fill(0.01), index: 0 }] }), { status: 200 });
  }
  const system = String((JSON.parse(String(init?.body ?? '{}')) as { messages?: { content?: string }[] }).messages?.[0]?.content ?? '');
  const content = /STRETCH/.test(system) ? (stretchCalls++, llmReplies.stretch) : /select which assets/.test(system) ? llmReplies.select : '{}';
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
}) as typeof fetch;

try {
  globalThis.fetch = stubFetch;
  sb.rpc = async (name: string) => ({ data: name === 'match_candidates' ? [row(2, 'VALU', 'stock', 0.6), row(3, 'CHEP', 'stock', 0.55)] : null, error: null });
  sb.from = tableClient((q) => {
    if (q.table === 'asset_metrics') {
      return [
        { asset_id: 1, pe: 50 },
        { asset_id: 2, pe: 10 },
        { asset_id: 3, pe: 12 },
      ];
    }
    if (q.select.includes('description')) {
      // ensureAnchors: NVDA was named but not retrieved by similarity.
      const { blurb: _b, sim: _s, ...r } = row(1, 'NVDA');
      return [{ ...r, description: 'NVDA makes GPUs' }];
    }
    return [1, 2, 3].map((id) => ({ id, kind: 'stock', currency: 'USD', market_cap_usd: 1e11, etf_portfolio: null }));
  });
  llmReplies.select = '[{"t":"NVDA","s":95,"w":"the named chip leader","r":"anchor"},{"t":"VALU","s":80,"w":"cheap chips","r":"adjacent"},{"t":"CHEP","s":70,"w":"cheap chips","r":"adjacent"}]';
  const anchored = { ...thesis, anchors: ['NVDA'], summary: 'Cheap chip stocks will rerate.' } as Thesis;
  const peBelow15 = { bounds: [{ key: 'pe', min: null, max: 15 }], exposures: [], currencies: [], domiciles: [], unverifiable: [] };
  const run = await completeResearch('Cheap chip stocks will rerate.', anchored, null, () => {}, undefined, { finReq: peBelow15 });
  const tickers = run.picks.map((p) => p.a.ticker);
  check('pipeline: a named asset failing "P/E below 15" never reaches the picks', !tickers.includes('NVDA') && tickers.includes('VALU'), JSON.stringify(tickers));
  check('pipeline: the anchor counted in the requirement check', run.status.some((s) => /Checked 3 candidates/.test(s)), run.status.join(' | '));

  // Hybrid kind cap + minimum shortlist: a capped 60-score pick beats a 30 stretch.
  stretchCalls = 0;
  const etfs = [1, 2, 3, 4, 5, 6].map((i) => row(10 + i, `E${i}`, 'etf', 1 - i / 10)) as unknown as Candidate[];
  llmReplies.select = JSON.stringify([90, 85, 80, 75, 60, 30].map((s, i) => ({ t: `E${i + 1}`, s, w: 'fund', r: 'adjacent' })));
  const sel = await llmSelect(thesis, 'grid ETFs', etfs, null);
  const selT = sel.map((p) => p.a.ticker);
  check(
    'select: in scarcity a capped pick that cleared the bar fills before a sub-35 stretch',
    JSON.stringify(selT) === '["E1","E2","E3","E4","E5"]' && stretchCalls === 0,
    `${JSON.stringify(selT)} stretch calls ${stretchCalls}`,
  );
} finally {
  globalThis.fetch = realFetch;
  sb.rpc = realRpc;
  sb.from = realFrom;
}

// ---- E6: the thesis extractor's semantic scope is clipped at a word boundary ----
{
  const semantic = 'only crypto related to the Ethereum ecosystem, specifically ETH-native protocols rather than bridged tokens';
  const reply = { title: 'Eth', stance: 'bullish', summary: 'Ethereum-native protocols will capture value.', intent: 'thematic', direction: 'long', anchors: [], private_entities: [], avoid: [], themes: ['ethereum'], strategies: [], requirements: { semantic } };
  globalThis.fetch = (async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }), { status: 200 })) as typeof fetch;
  sb.from = tableClient(() => []);
  try {
    const { buildThesis } = await import('./thesis.js');
    const note = (await buildThesis('Ethereum-native protocols will capture value.')).docCrit.constraint_note ?? '';
    check('E6 thesis constraint note: clipped at a word boundary', note.length <= 90 && atWordEnd(semantic, note), note);
  } finally {
    globalThis.fetch = realFetch;
    sb.from = realFrom;
  }
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);

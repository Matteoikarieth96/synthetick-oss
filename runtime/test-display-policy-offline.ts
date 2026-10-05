/**
 * Offline tests for the data display policy (runtime/display-policy.ts) and
 * the release fixes that ride with it: every flag combination on synthetic
 * FMP, CoinGecko, GeckoTerminal and Sacra assets, web vs api channel, the run
 * payload end to end (performRun with the pipeline, Supabase, OpenRouter,
 * Voyage and the market vendors all stubbed in-process), /v1/assets and the
 * X bot path, the universe payload (null multiplier, website normalization),
 * prompt hygiene, the self-hosted pdf.js and the frontend fixes (static checks).
 * No network, no keys, no database.
 *   npx tsx runtime/test-display-policy-offline.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// The shared clients need these to construct; nothing is ever sent to them.
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'placeholder-service-key';
process.env.VOYAGE_KEY ||= 'placeholder';
process.env.OPENROUTER_API_KEY = 'offline-test-key'; // fetch is stubbed; nothing leaves the process
process.env.FMP_KEY = 'offline-fmp-key';
process.env.FMP_INTERVAL_MS = '0';
for (const k of ['DISPLAY_FMP_DATA', 'DISPLAY_SACRA_DATA', 'API_RELAY_MARKET_DATA', 'SIGNAL_NEWS_ENABLED', 'COINGECKO_KEY']) delete process.env[k];

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const src = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${name}${detail ? `: ${detail}` : ''}`);
}
const hasDash = (s: string) => /[–—]/.test(s);

const policy = await import('./display-policy.js');
const { supabase } = await import('../ingest/lib/supabase.js');
type Channel = import('./display-policy.js').Channel;
type Vendor = import('./display-policy.js').Vendor;
type DisplayFlags = import('./display-policy.js').DisplayFlags;
type Candidate = import('./candidates.js').Candidate;
type Thesis = import('./thesis.js').Thesis;
type UniverseAssetRecord = import('./universe.js').UniverseAssetRecord;

const FLAG_ENV = ['DISPLAY_FMP_DATA', 'DISPLAY_SACRA_DATA', 'API_RELAY_MARKET_DATA'] as const;
function setFlags(f: DisplayFlags) {
  const vals = [f.fmp, f.sacra, f.apiRelay];
  FLAG_ENV.forEach((k, i) => {
    if (vals[i]) process.env[k] = '1';
    else delete process.env[k];
  });
}
const ALL_COMBOS: DisplayFlags[] = [];
for (const fmp of [false, true]) for (const sacra of [false, true]) for (const apiRelay of [false, true]) ALL_COMBOS.push({ fmp, sacra, apiRelay });
const label = (f: DisplayFlags, c: Channel) => `${c} fmp=${+f.fmp} sacra=${+f.sacra} relay=${+f.apiRelay}`;

// ==== flags ====================================================================
{
  const none = policy.displayFlags({});
  check('flags: all off by default', !none.fmp && !none.sacra && !none.apiRelay);
  const on = policy.displayFlags({ DISPLAY_FMP_DATA: '1', DISPLAY_SACRA_DATA: ' 1 ', API_RELAY_MARKET_DATA: '1' });
  check('flags: 1 turns each on', on.fmp && on.sacra && on.apiRelay);
  const loose = policy.displayFlags({ DISPLAY_FMP_DATA: 'true', DISPLAY_SACRA_DATA: 'yes', API_RELAY_MARKET_DATA: '0' });
  check('flags: only the exact value 1 counts (true/yes/0 stay off)', !loose.fmp && !loose.sacra && !loose.apiRelay);
}

// ==== vendor classification and logos ============================================
{
  check('vendorOf: source wins', policy.vendorOf({ source: 'coingecko', kind: 'stock' }) === 'coingecko' && policy.vendorOf({ source: 'sacra', kind: 'crypto' }) === 'sacra');
  check('vendorOf: fmp and legacy eodhd rows follow the FMP flag', policy.vendorOf({ source: 'fmp' }) === 'fmp' && policy.vendorOf({ source: 'EODHD', kind: 'etf' }) === 'fmp');
  check('vendorOf: kind fallback (crypto, private, equities)', policy.vendorOf({ kind: 'crypto' }) === 'coingecko' && policy.vendorOf({ kind: 'private' }) === 'sacra' && policy.vendorOf({ kind: 'bond' }) === 'fmp');
  check('vendorOf: unknown rows are treated as equity data (the restrictive default)', policy.vendorOf({}) === 'fmp' && policy.vendorOf({ source: 'other', kind: 'other' }) === 'fmp');
  const logos: [string, Vendor | null][] = [
    ['https://images.financialmodelingprep.com/symbol/AAPL.png', 'fmp'],
    ['https://financialmodelingprep.com/image-stock/AAPL.png', 'fmp'],
    ['https://coin-images.coingecko.com/coins/images/279/large/ethereum.png', 'coingecko'],
    ['https://assets.coingecko.com/coins/images/1/large/bitcoin.png', 'coingecko'],
    ['https://assets.geckoterminal.com/x.png', 'geckoterminal'],
    ['https://sacra.com/logo.png', 'sacra'],
    ['https://abc.supabase.co/storage/v1/object/public/asset-logos/AAPL.png', null],
    ['https://notfinancialmodelingprep.com/a.png', null],
  ];
  check('logoVendor: vendor CDNs recognised, own storage and look-alike hosts are not', logos.every(([u, v]) => policy.logoVendor(u) === v), logos.map(([u]) => String(policy.logoVendor(u))).join(','));
  check('displayLogo: an unparseable URL is dropped', policy.displayLogo('not a url', 'web', { fmp: true, sacra: true, apiRelay: true }) === null);
}

// ==== the full matrix: 8 flag combinations x 2 channels x 4 vendors =============
const MARKET = { ticker: 'X', price: 10, change1d: 1, change30d: 2, marketCap: 1e9, volume24h: 5, series: [1, 2], currency: 'USD', asOf: '2026-10-01T00:00:00Z', delayed: false, yearHigh: 12, yearLow: 8 };
const FIX: Record<'fmp' | 'coingecko' | 'sacra', { source: string; kind: string; logo: string | null; blurb: string; enrichment: string | null; etf_portfolio: unknown }> = {
  fmp: { source: 'fmp', kind: 'etf', logo: 'https://images.financialmodelingprep.com/symbol/ETFX.png', blurb: 'VENDOR-FMP-TEXT about the fund.', enrichment: 'OWN-TEXT-FMP thematic exposure to grids.', etf_portfolio: { top_holdings: [{ symbol: 'AAA', name: 'Holding A', weight: 12.5 }] } },
  coingecko: { source: 'coingecko', kind: 'crypto', logo: 'https://coin-images.coingecko.com/coins/images/1/large/cgx.png', blurb: 'VENDOR-CG-TEXT about the coin.', enrichment: null, etf_portfolio: null },
  sacra: { source: 'sacra', kind: 'private', logo: null, blurb: 'VENDOR-SACRA-TEXT about the company.', enrichment: null, etf_portfolio: null },
};
const NOTE_BOTH = 'Market data for stocks, ETFs and pre-IPO companies is not shown on this site.';
{
  let matrixOk = true;
  const bad: string[] = [];
  for (const f of ALL_COMBOS) {
    for (const channel of ['web', 'api'] as Channel[]) {
      for (const vendor of ['fmp', 'coingecko', 'sacra'] as const) {
        const fx = FIX[vendor];
        const out = policy.presentPickData({ ...fx, market: { ...MARKET } as never }, channel, f);
        const textOk = vendor === 'fmp' ? f.fmp : vendor === 'sacra' ? f.sacra : true;
        const marketOk = (channel === 'web' || f.apiRelay) && textOk;
        // Vendor text needs its own flag AND, on the API, relay rights (no vendor's text is relayed).
        const textShown = textOk && (channel === 'web' || f.apiRelay);
        const expectAbout = textShown ? fx.blurb : fx.enrichment ? policy.ownText(fx.enrichment) : null;
        const expectLogo = fx.logo && (channel === 'web' || f.apiRelay) && textOk ? fx.logo : null;
        const ok =
          (marketOk ? out.market?.price === 10 : out.market === null) &&
          out.market_withheld === !marketOk &&
          (marketOk && channel === 'api' ? out.market?.attribution === policy.ATTRIBUTION[vendor] : !out.market || out.market.attribution === undefined) &&
          out.about === expectAbout &&
          (vendor === 'fmp' ? (textShown ? out.etf_portfolio === fx.etf_portfolio : out.etf_portfolio === null) : true) &&
          out.logo === expectLogo;
        if (!ok) {
          matrixOk = false;
          bad.push(`${label(f, channel)} ${vendor} -> ${JSON.stringify(out).slice(0, 160)}`);
        }
      }
      // GeckoTerminal (universe DEX data): web always, API only with relay rights.
      if (policy.mayShow('geckoterminal', channel, f) !== (channel === 'web' || f.apiRelay)) {
        matrixOk = false;
        bad.push(`${label(f, channel)} geckoterminal`);
      }
    }
  }
  check('matrix: market, about, ETF portfolio, logo and attribution for every flag x channel x vendor', matrixOk, bad.slice(0, 3).join(' | '));

  // market_note for a run
  const withheld = [{ market_withheld: true }];
  const clean = [{ market_withheld: false }];
  const off = { fmp: false, sacra: false, apiRelay: false };
  check('note: API without relay rights always says why (even with no picks)', policy.runMarketNote('api', off, []) === policy.API_MARKET_NOTE && /data-vendor terms/.test(policy.API_MARKET_NOTE));
  check('note: web shows the owner\'s sentence when a pick was withheld', policy.runMarketNote('web', off, withheld) === NOTE_BOTH);
  check('note: web shows nothing when no pick was withheld (crypto-only run)', policy.runMarketNote('web', off, clean) === null);
  check('note: web wording follows the flags that are off', policy.runMarketNote('web', { fmp: true, sacra: false, apiRelay: false }, withheld) === 'Market data for pre-IPO companies is not shown on this site.' && policy.runMarketNote('web', { fmp: false, sacra: true, apiRelay: false }, withheld) === 'Market data for stocks and ETFs is not shown on this site.');
  check('note: API with relay rights notes only what the flags still hold back', policy.runMarketNote('api', { fmp: false, sacra: true, apiRelay: true }, withheld) === 'Market data for stocks and ETFs is omitted under data-vendor terms.' && policy.runMarketNote('api', { fmp: true, sacra: true, apiRelay: true }, clean) === null);
  const texts = [policy.API_MARKET_NOTE, NOTE_BOTH, policy.UNIVERSE_WEB_NOTE, ...Object.values(policy.ATTRIBUTION), policy.SELECT_RATIONALE_RULE];
  check('copy: notes and attribution lines carry no em or en dash', texts.every((t) => !hasDash(t)));
  check('attribution: CoinGecko and GeckoTerminal wording from their guide', policy.ATTRIBUTION.coingecko === 'Data provided by CoinGecko (https://www.coingecko.com/en/api)' && policy.ATTRIBUTION.geckoterminal === 'On-chain data provided by GeckoTerminal (https://www.geckoterminal.com)');
  check('shouldFetchMarket: an FMP row is never fetched with the flag off, crypto never on the API without relay', !policy.shouldFetchMarket({ source: 'fmp' }, 'web', off) && policy.shouldFetchMarket({ source: 'coingecko' }, 'web', off) && !policy.shouldFetchMarket({ source: 'coingecko' }, 'api', off));
}

// ==== universe presenter ===========================================================
const uniRecord = (over: Partial<UniverseAssetRecord> = {}): UniverseAssetRecord => ({
  ticker: 'AAPL',
  name: 'Apple Inc.',
  kind: 'stock',
  region: 'us',
  sector: 'Technology',
  categories: ['Consumer Electronics'],
  about: 'VENDOR-FMP-TEXT about Apple.',
  website: 'https://www.apple.com/',
  logo: 'https://images.financialmodelingprep.com/symbol/AAPL.png',
  contract: { address: '0xabc', chainId: 4663, decimals: 18, explorer: 'https://x/0xabc' },
  holders: 10,
  marketCapUsd: 3e12,
  currency: 'USD',
  metrics: { pe: 31.2, return_30d_pct: 4.1 },
  asOf: '2026-10-01',
  quote: { bid: 200, ask: 201, currency: 'USD', dailyHigh: 205, dailyLow: 198, underlyingVolume: 1, mintBurnUsd: 2, halted: false, multiplier: null, pendingMultiplier: null, pendingMultiplierEffectiveAt: null, sessions: null, generatedAt: null },
  dex: { priceUsd: 201.5, tvlUsd: 1000, volume24hUsd: 50, premiumPct: 0.2 },
  onchain: { uiMultiplier: 1, oraclePaused: false, pendingMultiplier: null, pendingEffectiveAt: null, totalSupply: 5, oracle: null },
  events: [],
  spark30d: { from: '2026-09-01', dates: ['2026-09-01', '2026-09-02'], closes: [190, 191] },
  portfolio: null,
  source: 'fmp',
  enrichment: 'OWN-TEXT Apple themes: devices, services.',
  ...over,
});
{
  let ok = true;
  const bad: string[] = [];
  for (const f of ALL_COMBOS) {
    for (const channel of ['web', 'api'] as Channel[]) {
      const out = policy.presentUniverseAsset(uniRecord(), channel, f) as unknown as Record<string, unknown>;
      const equity = (channel === 'web' || f.apiRelay) && f.fmp;
      const dexOk = channel === 'web' || f.apiRelay;
      const good =
        !('source' in out) &&
        !('enrichment' in out) &&
        out.ticker === 'AAPL' && out.sector === 'Technology' && out.region === 'us' &&
        (equity ? out.marketCapUsd === 3e12 && out.metrics !== null && out.spark30d !== null && out.asOf === '2026-10-01' : out.marketCapUsd === null && out.metrics === null && out.spark30d === null && out.asOf === null) &&
        (dexOk ? (out.dex as { priceUsd: number }).priceUsd === 201.5 : out.dex === null) &&
        (dexOk && channel === 'api' ? (out.dex as { attribution?: string }).attribution === policy.ATTRIBUTION.geckoterminal : !out.dex || (out.dex as { attribution?: string }).attribution === undefined) &&
        (f.fmp && (channel === 'web' || f.apiRelay) ? out.about === 'VENDOR-FMP-TEXT about Apple.' : out.about === 'OWN-TEXT Apple themes: devices, services.') &&
        (equity ? out.logo !== null : out.logo === null) &&
        out.quote !== null && out.onchain !== null && Array.isArray(out.events);
      if (!good) {
        ok = false;
        bad.push(`${label(f, channel)} -> ${JSON.stringify(out).slice(0, 200)}`);
      }
    }
  }
  check('universe: every flag x channel keeps venue/onchain data, gates FMP fields and GeckoTerminal DEX data, never leaks internals', ok, bad.slice(0, 2).join(' | '));
  const off = { fmp: false, sacra: false, apiRelay: false };
  check('universe note: web explains the hidden equity fields', policy.universeMarketNote('web', off) === policy.UNIVERSE_WEB_NOTE && policy.universeMarketNote('web', { ...off, fmp: true }) === null);
  check('universe note: API without relay rights', policy.universeMarketNote('api', off) === policy.API_MARKET_NOTE && policy.universeMarketNote('api', { fmp: true, sacra: true, apiRelay: true }) === null);
  check('universe attribution: only on the API with relay rights, FMP listed only with its flag', policy.universeAttribution('web', { fmp: true, sacra: true, apiRelay: true }) === null && policy.universeAttribution('api', off) === null && JSON.stringify(policy.universeAttribution('api', { fmp: false, sacra: false, apiRelay: true })) === JSON.stringify([policy.ATTRIBUTION.geckoterminal]) && policy.universeAttribution('api', { fmp: true, sacra: false, apiRelay: true })?.length === 2);
  check('universe asOf: DEX time hidden when DEX data is', policy.presentUniverseAsOf({ quotes: 'q', dex: 'd' }, 'api', off).dex === null && policy.presentUniverseAsOf({ quotes: 'q', dex: 'd' }, 'web', off).dex === 'd');
  check('universe full about: vendor text only with its flag, otherwise the full own text', policy.fullUniverseAbout({ description: 'V', enrichment: 'OWN', source: 'fmp', kind: 'stock' }, 'web', off) === 'OWN' && policy.fullUniverseAbout({ description: 'V', enrichment: 'OWN', source: 'fmp', kind: 'stock' }, 'web', { ...off, fmp: true }) === 'V' && policy.fullUniverseAbout({ description: 'V', enrichment: null, source: 'fmp', kind: 'stock' }, 'web', off) === null);
  // API channel without API_RELAY_MARKET_DATA: no vendor's descriptive text is relayed, CoinGecko included.
  const cgPick = { source: 'coingecko', kind: 'crypto', blurb: 'VENDOR TEXT', enrichment: 'OWN TEXT', market: null, logo: null };
  check('api channel: CoinGecko description withheld, own text stands in', policy.presentPickData(cgPick as never, 'api', off).about === 'OWN TEXT');
  check('web channel: CoinGecko description shown', policy.presentPickData(cgPick as never, 'web', off).about === 'VENDOR TEXT');
  check('api channel with relay on: CoinGecko description shown', policy.presentPickData(cgPick as never, 'api', { ...off, apiRelay: true }).about === 'VENDOR TEXT');
  check('universe full about on api without relay: own text even for crypto', policy.fullUniverseAbout({ description: 'V', enrichment: 'OWN', source: 'coingecko', kind: 'crypto' }, 'api', off) === 'OWN');
  const ownLong = policy.ownText('word '.repeat(300));
  check('own text is clipped at a word boundary (500 chars)', !!ownLong && ownLong.length <= policy.OWN_TEXT_CHARS && ownLong.endsWith('…'));

  // e2e P2-1: the own text is model output; its Markdown never reaches a card or the API.
  const md = 'NVIDIA is the defining play on **AI infrastructure**, *sovereign AI* and ## grids, per [Reuters](https://reuters.example/a); 2**10 stays.';
  check('own text: Markdown emphasis, links and heading markers are stripped', policy.ownText(md) === 'NVIDIA is the defining play on AI infrastructure, sovereign AI and grids, per Reuters; 2**10 stays.', String(policy.ownText(md)));
  const mdLong = policy.ownText(`${'word '.repeat(95)}**a bold phrase that runs across the clip point** tail`);
  check('own text: stripped before clipping, so no marker is left at the cut', !!mdLong && !mdLong.includes('*') && mdLong.endsWith('…'), mdLong?.slice(-40));
  check('own text: the card and universe list paths are plain text', policy.presentPickData({ source: 'fmp', kind: 'stock', blurb: 'V', enrichment: '**Grid** play' }, 'web', off).about === 'Grid play' && policy.presentUniverseAsset(uniRecord({ enrichment: '**Apple** themes' }), 'web', off).about === 'Apple themes');
  check('universe full about: the own text is plain text, vendor text untouched', policy.fullUniverseAbout({ description: 'V', enrichment: 'OWN **bold** [link](https://x.example/a)', source: 'fmp', kind: 'stock' }, 'web', off) === 'OWN bold link' && policy.fullUniverseAbout({ description: 'V **x**', enrichment: 'OWN', source: 'fmp', kind: 'stock' }, 'web', { ...off, fmp: true }) === 'V **x**');
  check('enrichment prompt asks for plain text, so the next refresh stores no Markdown', /Plain text, no Markdown\./.test(src('ingest/enrich-descriptions.ts')));
}

// ==== universe payload: null multiplier, website normalization (L15) ==============
const { normWebsite } = await import('./links.js');
{
  check('normWebsite: javascript:, data: and host-less values are refused', [normWebsite('javascript:alert(1)'), normWebsite('data:text/html,x'), normWebsite('javascript://evil.com/%0aalert(1)'), normWebsite('localhost')].every((v) => v === null));
  check('normWebsite: bare domains and http(s) URLs normalise', normWebsite('apple.com') === 'https://apple.com/' && normWebsite('http://x.example/a') === 'http://x.example/a');

  const uni = await import('./universe.js');
  const dex = new Map([['0xabc', { priceUsd: 410, tvlUsd: 1, volume24hUsd: 1 }]]);
  const quote = (multiplier: number | null) => ({ bid: 100, ask: 100, currency: 'USD', dailyHigh: null, dailyLow: null, underlyingVolume: null, mintBurnUsd: null, halted: false, multiplier, pendingMultiplier: null, pendingMultiplierEffectiveAt: null, sessions: null, generatedAt: null });
  check('dexEntry: a known venue multiplier scales the premium', Math.abs((uni.dexEntry(dex, '0xABC', quote(4))?.premiumPct ?? NaN) - 2.5) < 1e-9);
  check('dexEntry: unknown venue multiplier falls back to the contract\'s own', Math.abs((uni.dexEntry(dex, '0xabc', quote(null), 4)?.premiumPct ?? NaN) - 2.5) < 1e-9);
  check('dexEntry: with no multiplier at all there is no premium (never an assumed 1)', uni.dexEntry(dex, '0xabc', quote(null), null)?.premiumPct === null);

  // universeAssetData with the venue, Supabase and every vendor stubbed.
  const reg = uni.UNIVERSES.robinhood;
  const [t1, t2, t3] = reg.assets;
  const realFetch = globalThis.fetch;
  const sb = supabase as unknown as Record<string, unknown>;
  const realFrom = sb.from;
  globalThis.fetch = (async (u: unknown) => {
    const url = String(u);
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/rhj/prices')) return json({ quotes: [t1, t2, t3].map((t) => ({ tokenSymbol: t!.symbol, bid: '10', ask: '11', isTradingHalt: false })) });
    if (url.endsWith('/rhj/assets')) {
      return json({ assets: [
        { tokenSymbol: t1!.symbol, currentMultiplier: '' },
        { tokenSymbol: t2!.symbol, currentMultiplier: '1.25' },
        { tokenSymbol: t3!.symbol, currentMultiplier: '0' },
      ] });
    }
    return json({}, 404); // GeckoTerminal, RPC, Chainlink directory, corporate actions: down
  }) as typeof fetch;
  sb.from = (table: string) => {
    const rows =
      table === 'assets'
        ? [
            { id: 1, ticker: t1!.symbol, name: 'One', kind: 'stock', region: 'us', sector: 'Tech', categories: [], currency: 'USD', market_cap_usd: 1e9, website_url: 'javascript:alert(1)', logo_url: null, description: 'VENDOR', etf_portfolio: null, source: 'fmp', enrichment: 'OWN' },
            { id: 2, ticker: t2!.symbol, name: 'Two', kind: 'stock', region: 'us', sector: 'Tech', categories: [], currency: 'USD', market_cap_usd: 2e9, website_url: 'two.example', logo_url: null, description: null, etf_portfolio: null, source: 'fmp', enrichment: null },
          ]
        : [];
    const chain: unknown = new Proxy(function () {}, {
      get(_t, prop) {
        if (prop === 'then') return (resolve: (v: unknown) => void) => resolve({ data: rows, error: null });
        return () => chain;
      },
    });
    return chain;
  };
  try {
    const recs = await uni.universeAssetData('robinhood');
    const r1 = recs.find((r) => r.ticker === t1!.symbol);
    const r2 = recs.find((r) => r.ticker === t2!.symbol);
    const r3 = recs.find((r) => r.ticker === t3!.symbol);
    check('universe: an empty venue multiplier is null, never 1', r1?.quote !== null && r1?.quote?.multiplier === null, JSON.stringify(r1?.quote?.multiplier));
    check('universe: a reported multiplier passes through', r2?.quote?.multiplier === 1.25);
    check('universe: a zero multiplier is unknown (null)', r3?.quote?.multiplier === null);
    check('universe: website_url goes through normWebsite (L15)', r1?.website === null && r2?.website === 'https://two.example/');
    check('universe: records carry the policy inputs', r1?.source === 'fmp' && r1?.enrichment === 'OWN' && recs.length === reg.assets.length);
    const shown = policy.presentUniverseAsset(r1!, 'web', policy.displayFlags({}));
    check('universe: presented web asset hides FMP fields and keeps the venue quote', shown.marketCapUsd === null && shown.about === 'OWN' && shown.quote?.bid === 10 && !('enrichment' in shown));
  } finally {
    globalThis.fetch = realFetch;
    sb.from = realFrom;
  }
}

// ==== prompt hygiene: analysis lines and the select rule ===========================
const { analysisLineFor, pickAnalysisLine, explainPicksWithStatus } = await import('./analysis.js');
const cand = (over: Partial<Candidate>): Candidate =>
  ({
    id: 1, ticker: 'ETFX', name: 'Grid ETF', kind: 'etf', region: 'us', cap_class: 'large', exchange: 'NYSE ARCA',
    cex_venues: [], dex_venues: [], sector: 'Utilities', categories: ['Grid', 'Power'],
    etf_portfolio: { top_holdings: [{ symbol: 'AAA', name: 'Holding A', weight: 12.5 }] }, volume_24h_usd: null,
    blurb: 'VENDOR-FMP-TEXT tracks grid utilities.', sim: 0.5, ...over,
  }) as Candidate;
{
  const off = policy.displayFlags({});
  const hy = { flags: off, ownText: new Map<number, string | null>([[1, 'OWN-TEXT grid buildout and transmission.']]) };
  const etf = cand({});
  const line = analysisLineFor(etf, hy);
  check('hygiene: the analysis line drops the vendor description, holdings and size band', !/VENDOR-FMP-TEXT|Holding A|AAA|AUM|\$/.test(line), line);
  check('hygiene: the analysis line keeps identity facts and the own text', /^ETFX\|Grid ETF\|etf\|\|Utilities\|/.test(line) && /OWN-TEXT grid buildout/.test(line) && /listed on NYSE ARCA/.test(line) && /categories Grid, Power/.test(line), line);
  check('hygiene: without own text the line is identity facts only', !/OWN-TEXT/.test(analysisLineFor(etf, { flags: off, ownText: new Map() })));
  check('hygiene off (flags on): the line is unchanged', analysisLineFor(etf, { flags: { fmp: true, sacra: true, apiRelay: false }, ownText: new Map() }) === pickAnalysisLine(etf) && analysisLineFor(etf, null) === pickAnalysisLine(etf));
  const coin = cand({ id: 2, ticker: 'CGX', kind: 'crypto', blurb: 'VENDOR-CG-TEXT', etf_portfolio: null });
  check('hygiene: CoinGecko rows keep their description (displayable with attribution)', analysisLineFor(coin, hy) === pickAnalysisLine(coin));
  const priv = cand({ id: 3, ticker: 'PRIVX', kind: 'private', blurb: 'VENDOR-SACRA-TEXT', etf_portfolio: null, cap_class: 'mega' });
  check('hygiene: Sacra rows lose the vendor text and the valuation band with DISPLAY_SACRA_DATA off', !/VENDOR-SACRA-TEXT|market cap/.test(analysisLineFor(priv, hy)) && /VENDOR-SACRA-TEXT/.test(analysisLineFor(priv, { flags: { fmp: false, sacra: true, apiRelay: false }, ownText: new Map() })));
  let seen = '';
  const pick = { a: etf, score: 80, why: 'grid exposure', rel: 'adjacent' as const };
  await explainPicksWithStatus('thesis', [pick], null, 'long', async (usr) => ((seen = String(usr)), '{}'), { hygiene: hy });
  check('hygiene: the analysis prompt never receives the vendor text or holdings', /OWN-TEXT grid buildout/.test(seen) && !/VENDOR-FMP-TEXT|Holding A/.test(seen));
  check('select rule: one plain instruction about the user-visible rationale', /shown to users/.test(policy.SELECT_RATIONALE_RULE) && /prices/.test(policy.SELECT_RATIONALE_RULE) && /holding weights/.test(policy.SELECT_RATIONALE_RULE) && /market caps/.test(policy.SELECT_RATIONALE_RULE));
  check('hygiene is active while any vendor flag is off', policy.promptHygieneActive(off) && policy.promptHygieneActive({ fmp: true, sacra: false, apiRelay: true }) && !policy.promptHygieneActive({ fmp: true, sacra: true, apiRelay: false }));
  // e2e P2-4: on the API without relay rights no CoinGecko figure or text is relayed either.
  const apiHy = { ...hy, channel: 'api' as const };
  check('hygiene api/no relay: CoinGecko rows lose the vendor text and the size band', !/VENDOR-CG-TEXT|market cap/.test(analysisLineFor(coin, apiHy)) && /market cap/.test(pickAnalysisLine(coin)), analysisLineFor(coin, apiHy));
  check('hygiene api with relay rights: CoinGecko rows keep their line', analysisLineFor(coin, { ...apiHy, flags: { ...off, apiRelay: true } }) === pickAnalysisLine(coin));
  check('hygiene is active on the API without relay rights, even with both display flags on', policy.promptHygieneActive({ fmp: true, sacra: true, apiRelay: false }, 'api') && !policy.promptHygieneActive({ fmp: true, sacra: true, apiRelay: true }, 'api') && !policy.promptHygieneActive({ fmp: true, sacra: true, apiRelay: false }, 'web'));
}

// ==== end to end: performRun with the pipeline and every vendor stubbed ===========
const { performRun } = await import('../server/run.js');
const { assetsFromContent } = await import('./assets.js');
const sb = supabase as unknown as Record<string, unknown>;
const realFetch = globalThis.fetch;
const realFrom = sb.from;
const realRpc = sb.rpc;

const ASSETS = [
  { id: 11, ticker: 'FMPX', name: 'FMPX Corp', kind: 'stock', source: 'fmp', vendor_id: 'FMPX', cap_class: 'large', blurb: 'VENDOR-FMP-STOCK-TEXT makes grid equipment.', enrichment: 'OWN-TEXT-FMPX grid equipment and transmission.', logo_url: 'https://images.financialmodelingprep.com/symbol/FMPX.png', etf_portfolio: null, market_cap_usd: 123_456_789_000, private_data: null },
  { id: 12, ticker: 'ETFX', name: 'ETFX Grid Fund', kind: 'etf', source: 'fmp', vendor_id: 'ETFX', cap_class: 'mid', blurb: 'VENDOR-FMP-ETF-TEXT tracks grid utilities.', enrichment: null, logo_url: 'https://images.financialmodelingprep.com/symbol/ETFX.png', etf_portfolio: { top_holdings: [{ symbol: 'HOLDA', name: 'Holding Alpha', weight: 17.77 }] }, market_cap_usd: 4_567_000_000, private_data: null },
  { id: 13, ticker: 'CGX', name: 'CGX Network', kind: 'crypto', source: 'coingecko', vendor_id: 'cgx-network', cap_class: 'mid', blurb: 'VENDOR-CG-TEXT powers grid settlement.', enrichment: null, logo_url: 'https://coin-images.coingecko.com/coins/images/1/large/cgx.png', etf_portfolio: null, market_cap_usd: 2_000_000_000, private_data: null },
  { id: 14, ticker: 'PRIVX', name: 'PrivX Energy', kind: 'private', source: 'sacra', vendor_id: 'privx.example', cap_class: 'large', blurb: 'VENDOR-SACRA-TEXT builds grid software.', enrichment: null, logo_url: null, etf_portfolio: null, market_cap_usd: 9_876_000_000, private_data: { valuation_series: [{ d: '2025-01-01', v: 5e9 }, { d: '2026-01-01', v: 9.876e9 }] } },
];
const candidateRow = (a: (typeof ASSETS)[number], i: number) => ({
  id: a.id, ticker: a.ticker, name: a.name, kind: a.kind, region: a.kind === 'crypto' || a.kind === 'private' ? 'global' : 'us',
  cap_class: a.cap_class, exchange: a.kind === 'crypto' ? null : 'NASDAQ', cex_venues: a.kind === 'crypto' ? ['Binance'] : [], dex_venues: [],
  sector: 'Utilities', categories: ['Grid'], etf_portfolio: a.etf_portfolio, volume_24h_usd: a.kind === 'crypto' ? 5e6 : null, blurb: a.blurb, sim: 0.9 - i / 10,
});
const refRow = (a: (typeof ASSETS)[number]) => ({
  id: a.id, source: a.source, vendor_id: a.vendor_id, ticker: a.ticker, kind: a.kind, currency: 'USD', market_cap_usd: a.market_cap_usd,
  volume_24h_usd: a.kind === 'crypto' ? 5e6 : null, website_url: `https://${a.ticker.toLowerCase()}.example`, logo_url: a.logo_url,
  updated_at: '2026-10-01T00:00:00Z', private_data: a.private_data, market_snapshot: null, enrichment: a.enrichment, name: a.name, region: 'us',
});

const vendorUrls: string[] = [];
const prompts: { system: string; user: string }[] = [];
const llm = { select: '', assets: '' };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = (async (u: unknown, init?: RequestInit) => {
  const url = String(u);
  if (url.includes('voyageai')) return json({ data: [{ embedding: new Array(512).fill(0.01), index: 0 }] });
  if (url.includes('openrouter')) {
    const msgs = (JSON.parse(String(init?.body ?? '{}')) as { messages?: { content?: string }[] }).messages ?? [];
    const system = String(msgs[0]?.content ?? '');
    const user = String(msgs[msgs.length - 1]?.content ?? '');
    prompts.push({ system, user });
    const content = /select which assets/.test(system) ? llm.select : /extract the investment thesis and the financial assets/.test(system) ? llm.assets : /STRETCH/.test(system) ? '[]' : '{}';
    return json({ choices: [{ message: { content } }] });
  }
  vendorUrls.push(url);
  if (url.includes('financialmodelingprep.com/stable/quote')) return json([{ price: 321.09, changePercentage: 1.11, yearHigh: 400, yearLow: 200, timestamp: 1_759_600_000, open: 320, previousClose: 318 }]);
  if (url.includes('financialmodelingprep.com/stable/historical-price-eod')) return json([{ date: '2026-10-02', price: 321 }, { date: '2026-10-01', price: 300 }]);
  if (url.includes('financialmodelingprep.com/stable/ratios-ttm')) return json([{ priceToEarningsRatioTTM: 44.44 }]);
  if (url.includes('api.coingecko.com/api/v3/coins/markets')) return json([{ id: 'cgx-network', market_cap_rank: 77 }]);
  if (url.includes('api.coingecko.com/api/v3/coins/')) return json({ prices: [[1_759_500_000_000, 1.5], [1_759_586_400_000, 1.75]], total_volumes: [[1_759_586_400_000, 1000]] });
  return json({}, 404);
}) as typeof fetch;
sb.rpc = async (name: string) => ({ data: name === 'match_candidates' ? ASSETS.map(candidateRow) : null, error: null });
sb.from = (table: string) => {
  const q = { select: '', filters: {} as Record<string, unknown> };
  const chain: unknown = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === 'then') {
        return (resolve: (v: unknown) => void) => {
          let rows: unknown[] = [];
          if (table === 'assets') {
            const ids = (q.filters.id as number[] | undefined) ?? null;
            const ticker = String(q.filters.ticker ?? '').toUpperCase();
            const picked = ASSETS.filter((a) => (ids ? ids.includes(a.id) : ticker ? a.ticker === ticker : false));
            rows = picked.map(refRow);
          }
          resolve({ data: rows, error: null });
        };
      }
      return (...args: unknown[]) => {
        if (prop === 'select') q.select = String(args[0] ?? '');
        if (prop === 'in' || prop === 'eq' || prop === 'ilike') q.filters[String(args[0])] = args[1];
        return chain;
      };
    },
  });
  return chain;
};

const thesis = { title: 'Grid', stance: '', summary: 'Grid buildout will reward equipment makers, grid funds and settlement networks.', intent: 'thematic', direction: 'long', anchors: [], private_entities: [], avoid: [], themes: ['grid'], strategies: [], docCrit: {} } as unknown as Thesis;
llm.select = JSON.stringify(ASSETS.map((a, i) => ({ t: a.ticker, s: 90 - i * 5, w: `${a.ticker} fits the grid thesis.`, r: 'adjacent' })));
const EMPTY = { bounds: [], exposures: [], currencies: [], domiciles: [], unverifiable: [] };
async function runOnce(channel: Channel, f: DisplayFlags) {
  setFlags(f);
  vendorUrls.length = 0;
  prompts.length = 0;
  const status: string[] = [];
  const payload = (await performRun(
    null,
    { text: thesis.summary, thesis, crit: {}, wantsPm: false, pmOnly: false, breadth: 'focused', finReq: EMPTY, channel },
    { onStart: () => {}, onStatus: (l) => status.push(l) },
  )) as { picks: Record<string, unknown>[]; market_note: string | null };
  const byT = new Map(payload.picks.map((p) => [String(p.ticker), p]));
  return { payload, byT, status, urls: [...vendorUrls], prompts: [...prompts] };
}
const mk = (p: Record<string, unknown> | undefined) => (p?.market ?? null) as Record<string, unknown> | null;

try {
  // 1) API, everything off: no vendor call at all, no market object, no vendor logo.
  const a = await runOnce('api', { fmp: false, sacra: false, apiRelay: false });
  check('run api/all off: four picks came back', a.payload.picks.length === 4, String(a.payload.picks.length));
  check('run api/all off: no vendor market call was made (FMP or CoinGecko)', a.urls.length === 0, a.urls.join(' '));
  check('run api/all off: every market object is null and flagged withheld', a.payload.picks.every((p) => p.market === null && p.market_withheld === true));
  check('run api/all off: no vendor-hosted logo for any source', a.payload.picks.every((p) => p.logo === null));
  check('run api/all off: market_note says why', a.payload.market_note === policy.API_MARKET_NOTE);
  check('run api/all off: every vendor description replaced (own text or null), CoinGecko included', a.byT.get('FMPX')?.about === 'OWN-TEXT-FMPX grid equipment and transmission.' && a.byT.get('ETFX')?.about === null && a.byT.get('PRIVX')?.about === null && !/VENDOR-CG-TEXT/.test(String(a.byT.get('CGX')?.about)));
  check('run api/all off: the ETF portfolio is withheld', a.byT.get('ETFX')?.etf_portfolio === null);
  const body = JSON.stringify(a.payload);
  check('run api/all off: no internal field and no vendor figure leaks into the payload', !/"enrichment"|"source"|VENDOR-FMP|VENDOR-SACRA|Holding Alpha|321\.09|123456789000|9876000000|44\.44/.test(body));
  check('run: identity fields stay (ticker, name, kind, region, exchange, sector, categories)', a.payload.picks.every((p) => p.ticker && p.name && p.kind && p.region && 'exchange' in p && p.sector === 'Utilities' && Array.isArray(p.categories)));
  const sel = a.prompts.find((p) => /select which assets/.test(p.system));
  check('prompt: the select prompt carries the rationale rule while vendor data is held back', !!sel && sel.user.includes(policy.SELECT_RATIONALE_RULE.trim()));
  const ana = a.prompts.find((p) => /senior investment analyst/.test(p.system));
  const lineOf = (t: string) => (ana?.user.split('\n') ?? []).find((l) => l.startsWith(`${t}|`)) ?? '';
  const heldBack = ['FMPX', 'ETFX', 'PRIVX'].map(lineOf);
  check('prompt: the analysis prompt gets own text, never FMP/Sacra text, holdings or size bands', !!ana && /OWN-TEXT-FMPX/.test(lineOf('FMPX')) && heldBack.every((l) => l && !/VENDOR-|Holding Alpha|HOLDA|\$/.test(l)) && !/VENDOR-FMP|VENDOR-SACRA|Holding Alpha/.test(ana.user), heldBack.join(' / '));
  // e2e P2-4: the API channel without relay rights relays no CoinGecko data, so its analysis line is hygienic too.
  check('prompt: on the API without relay rights the CoinGecko line carries no vendor text or size band', /^CGX\|CGX Network\|crypto\|\|/.test(lineOf('CGX')) && !/VENDOR-CG-TEXT|market cap/.test(lineOf('CGX')), lineOf('CGX'));
  check('status lines never print vendor values', !a.status.some((s) => /321\.09|44\.44|123456789000|1\.75|VENDOR-/.test(s)), a.status.join(' | '));
  // e2e P2-3: nothing is fetched on this run, so nothing says it is loading.
  check('status: no "Loading prices" line when no pick will be fetched', !a.status.some((s) => /Loading prices/.test(s)), a.status.join(' | '));

  // 2) Website, everything off: CoinGecko shown (and fetched), FMP never fetched, Sacra hidden.
  const w = await runOnce('web', { fmp: false, sacra: false, apiRelay: false });
  check('run web/all off: CoinGecko market data is fetched and shown, without an attribution field', mk(w.byT.get('CGX'))?.price === 1.75 && mk(w.byT.get('CGX'))?.attribution === undefined && w.byT.get('CGX')?.market_withheld === false);
  check('run web/all off: the FMP quote endpoints are never called', !w.urls.some((u) => u.includes('financialmodelingprep')) && w.urls.some((u) => u.includes('coingecko')), w.urls.join(' '));
  check('run web/all off: stock, ETF and pre-IPO markets are withheld', ['FMPX', 'ETFX', 'PRIVX'].every((t) => w.byT.get(t)?.market === null && w.byT.get(t)?.market_withheld === true));
  check('run web/all off: the website note is the owner\'s sentence', w.payload.market_note === NOTE_BOTH);
  check('run web/all off: CoinGecko logo kept, FMP logos dropped', String(w.byT.get('CGX')?.logo).includes('coingecko') && w.byT.get('FMPX')?.logo === null && w.byT.get('ETFX')?.logo === null);
  check('run web/all off: no Sacra valuation anywhere in the payload', !/9876000000|9\.876e9|5000000000/.test(JSON.stringify(w.payload)));
  check('status: "Loading prices" is said when a pick is fetched (the CoinGecko one)', w.status.some((s) => /^Loading prices and 30 day history/.test(s)), w.status.join(' | '));
  const anaW = w.prompts.find((p) => /senior investment analyst/.test(p.system));
  const cgLineW = (anaW?.user.split('\n') ?? []).find((l) => l.startsWith('CGX|')) ?? '';
  check('prompt: on the website CoinGecko text and its size band still reach the analysis prompt', /VENDOR-CG-TEXT/.test(cgLineW) && /market cap/.test(cgLineW), cgLineW);

  // 3) API with every right: everything relayed, each market object attributed.
  const r = await runOnce('api', { fmp: true, sacra: true, apiRelay: true });
  check('run api/all on: FMP is fetched now', r.urls.some((u) => u.includes('financialmodelingprep.com/stable/quote')), r.urls.join(' '));
  check('run api/all on: every market object is present with its vendor attribution', mk(r.byT.get('FMPX'))?.price === 321.09 && mk(r.byT.get('FMPX'))?.attribution === policy.ATTRIBUTION.fmp && mk(r.byT.get('CGX'))?.attribution === policy.ATTRIBUTION.coingecko && mk(r.byT.get('PRIVX'))?.attribution === policy.ATTRIBUTION.sacra && (mk(r.byT.get('PRIVX'))?.series as number[] | undefined)?.length === 2);
  check('run api/all on: vendor descriptions, portfolio and logos are relayed; no note', /VENDOR-FMP-STOCK-TEXT/.test(String(r.byT.get('FMPX')?.about)) && r.byT.get('ETFX')?.etf_portfolio !== null && String(r.byT.get('FMPX')?.logo).includes('financialmodelingprep') && r.payload.market_note === null);
  const sel3 = r.prompts.find((p) => /select which assets/.test(p.system));
  check('prompt: with every flag on the select prompt is unchanged (no rule)', !!sel3 && !sel3.user.includes('shown to users as written'));

  // 4) Website with FMP licensed, Sacra not: the note names only pre-IPO data.
  const s = await runOnce('web', { fmp: true, sacra: false, apiRelay: false });
  check('run web/fmp on, sacra off: FMP data shown, Sacra withheld, matching note', mk(s.byT.get('FMPX'))?.price === 321.09 && s.byT.get('PRIVX')?.market === null && s.payload.market_note === 'Market data for pre-IPO companies is not shown on this site.');

  // /v1/assets and the X bot path.
  llm.assets = JSON.stringify({ thesis: { title: 'Grid', summary: 'Grid buildout.', themes: ['grid'] }, assets: [{ name: 'FMPX Corp', ticker: 'FMPX', kind: 'stock' }, { name: 'CGX Network', ticker: 'CGX', kind: 'crypto' }] });
  setFlags({ fmp: false, sacra: false, apiRelay: false });
  vendorUrls.length = 0;
  const botView = await assetsFromContent('Grid buildout is coming.', '', { channel: 'api' });
  check('assets api/all off: prices and caps null, withheld, note set, no vendor call', botView.assets.length === 2 && botView.assets.every((x) => x.price === null && x.marketCapUsd === null && x.change1dPct === null && x.market_withheld && !x.attribution) && botView.market_note === policy.API_MARKET_NOTE && vendorUrls.length === 0, JSON.stringify(botView.assets));
  const webView = await assetsFromContent('Grid buildout is coming.', '', { channel: 'web' });
  const cg = webView.assets.find((x) => x.ticker === 'CGX');
  const fm = webView.assets.find((x) => x.ticker === 'FMPX');
  check('assets web/all off: crypto price shown, FMP price and cap withheld, web note', cg?.price === 1.75 && fm?.price === null && fm?.marketCapUsd === null && fm?.market_withheld === true && webView.market_note === NOTE_BOTH);
  setFlags({ fmp: true, sacra: false, apiRelay: true });
  const relayed = await assetsFromContent('Grid buildout is coming.', '', { channel: 'api' });
  check('assets api/relay+fmp: data relayed with attribution', relayed.assets.find((x) => x.ticker === 'FMPX')?.attribution === policy.ATTRIBUTION.fmp && relayed.assets.find((x) => x.ticker === 'FMPX')?.price === 321.09 && relayed.assets.find((x) => x.ticker === 'CGX')?.attribution === policy.ATTRIBUTION.coingecko && relayed.market_note === null);
  const { composeAssetsReply } = await import('../bot/reply.js');
  const reply = composeAssetsReply(botView.assets);
  check('bot template reply without market data names the tickers and no figure', reply === 'Assets in this post: $FMPX, CGX.', reply);
} finally {
  globalThis.fetch = realFetch;
  sb.from = realFrom;
  sb.rpc = realRpc;
  setFlags({ fmp: false, sacra: false, apiRelay: false });
}

// ==== wiring (static): channels are passed explicitly by the route handlers ========
{
  const server = src('server/server.ts');
  const body = (fn: string) => server.slice(server.indexOf(`async function ${fn}`), server.indexOf('\n}\n', server.indexOf(`async function ${fn}`)));
  check('wiring: /api/complete runs on the web channel', /channel: 'web'/.test(body('handleComplete')));
  check('wiring: /v1/screen and /v1/assets pick the channel from how the caller authenticated', ['handleV1Screen', 'handleV1Assets'].every((fn) => /channel = keyUser \? 'api' : 'web'/.test(body(fn)) && /let channel: Channel = 'api'/.test(body(fn))));
  check('wiring: /v1/screen hands its channel to buildScreenInput', /buildScreenInput\([\s\S]*?'\[API\]', channel\)/.test(body('handleV1Screen')));
  check('wiring: /v1/assets hands its channel to assetsFromContent', /assetsFromContent\([^;]*\{ channel \}\)/.test(body('handleV1Assets')));
  check('wiring: the universe route presents each record for the caller\'s channel', /presentUniverseAsset\(r, channel, flags\)/.test(body('handleV1Universe')) && /channel = keyUser \? 'api' : 'web'/.test(body('handleV1Universe')) && /private, max-age=300/.test(body('handleV1Universe')));
  check('wiring: the chart is not fetched for a channel that may not show it', /mayShow\('geckoterminal', channel, flags\)/.test(body('handleV1Universe')));
  check('wiring: MCP run_screen is the API channel', /'\[MCP\]',\s*\/\/[^\n]*\n\s*'api'/.test(src('server/mcp.ts')));
  check('wiring: the X bot is the API channel', /assetsFromContent\(content, request, \{ channel: 'api' \}\)/.test(src('bot/worker.ts')));
  check('wiring: the policy module reads no request state', !/IncomingMessage|req\.headers|sec-fetch/i.test(src('runtime/display-policy.ts')));
}

// ==== pdf.js: self-hosted, maintained, extraction works ===========================
{
  const require = createRequire(import.meta.url);
  const version = String((require('pdfjs-dist/package.json') as { version: string }).version);
  const [maj = 0, min = 0, pat = 0] = version.split('.').map(Number);
  check('pdf.js: a maintained pdfjs-dist past the CVE-2024-4367 fix (>= 4.2.67)', maj > 4 || (maj === 4 && (min > 2 || (min === 2 && pat >= 67))), version);
  const server = src('server/server.ts');
  check('pdf.js: the CSP no longer allows cdnjs (script or connect)', !/cdnjs/.test(server.slice(server.indexOf('const CSP'), server.indexOf("].join('; ')"))));
  check('pdf.js: served from an exact two-file allowlist', /'\/vendor\/pdfjs\/pdf\.min\.mjs': 'legacy\/build\/pdf\.min\.mjs'/.test(server) && /'\/vendor\/pdfjs\/pdf\.worker\.min\.mjs': 'legacy\/build\/pdf\.worker\.min\.mjs'/.test(server));
  const app = src('public/signal-desk.js');
  check('pdf.js: the page loads it on demand from our origin with eval off', /import\('\/vendor\/pdfjs\/pdf\.min\.mjs'\)/.test(app) && /isEvalSupported: false/.test(app) && !/cdnjs|pdfjsLib\.GlobalWorkerOptions/.test(app));
  check('pdf.js: the layout no longer loads a CDN script', !/cdnjs/.test(src('app/layout.tsx')));

  // A one-page PDF built here (standard Helvetica, no embedded font), read by
  // the same legacy build the browser loads.
  const text = 'SyntheTick sample PDF text extraction check';
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];
  const stream = `BT /F1 18 Tf 72 700 Td (${text}) Tj ET`;
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(pdf.length);
    pdf += o === null ? `${i + 1} 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n` : `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: new Uint8Array(Buffer.from(pdf, 'latin1')), isEvalSupported: false, verbosity: 0 } as never);
  const doc = await task.promise;
  const page = await doc.getPage(1);
  const content = await page.getTextContent();
  const got = content.items.map((it) => ('str' in it ? it.str : '')).join(' ').trim();
  check('pdf.js: text extraction works on a locally generated PDF', got === text, got);
  await task.destroy();
}

// ==== frontend fixes (static) =======================================================
{
  const auth = src('public/sd-auth.js');
  check('sign-in: Escape dismisses the dialog and focuses the visible sign-in button', /hideGate\(\{ dismissed: true \}\)/.test(auth) && /visibleSignInButton\(\) \|\| \$\('doc'\)/.test(auth) && /setSignedOutUi\(dismissed\)/.test(auth));
  check('sign-in: the dialog can be reopened (sign-in buttons, sdAuth.showGate)', /for \(const b of signInButtons\(\)\) b\.addEventListener\('click', \(\) => showGate\(\)\)/.test(auth) && /showGate: \(\) =>/.test(auth));
  check('sign-in: a second showGate keeps the inert list it must restore', /if \(gate && gate\.hidden\) \{/.test(auth));
  check('sign-in: a 401 reopens the dialog instead of a dead end', /window\.sdAuth\.showGate\?\.\(\)/.test(src('public/signal-desk.js')));
  const page = src('app/page.tsx');
  check('sign-in: the page has the sidebar and mobile-bar buttons', /id="sideSignIn"/.test(page) && /id="mbSignIn"/.test(page));
  const uni = src('app/universe/page.tsx');
  check('universe page: a failed poll keeps the table with a stale note (R7)', /lastGoodAt\.current != null\) setStaleSince/.test(uni) && /The latest refresh failed/.test(uni));
  check('universe page: a missing multiplier is never 1', !/multiplier \?\? 1|uiMultiplier \?\? 1/.test(uni));
  check('universe page: always-visible GeckoTerminal credit, A9 popover wording', /On-chain data provided by\{' '\}\s*<a href="https:\/\/www\.geckoterminal\.com" target="_blank" rel="noopener">/.test(uni) && /Uniswap pools: on-chain data provided by GeckoTerminal \(token price, TVL, DEX volume, price history\)/.test(uni));
  const app = src('public/signal-desk.js');
  check('results: CoinGecko credit next to crypto prices, in the footer, the PDF footer and the data-sources text', /Data provided by CoinGecko<\/a>/.test(app) && (app.match(/Crypto data provided by/g) ?? []).length >= 3 && /const CG_URL='https:\/\/www\.coingecko\.com\/en\/api'/.test(app));
  check('results: the market note renders in the results area', /r\.market_note\)\s*view\.insertAdjacentHTML/.test(app));
  check('results: attribution links open in a new tab with rel=noopener', !/coingecko\.com\/en\/api"[^>]*rel="noreferrer"/.test(app) && /target="_blank" rel="noopener">CoinGecko<\/a>/.test(app));
  check('css: the stale "unicorn buy" comment is gone', !/unicorn/i.test(src('app/globals.css')) && /swap link/.test(src('app/globals.css')));
  const env = src('.env.example');
  check('.env.example documents the three flags, empty (off)', /\nDISPLAY_FMP_DATA=\n/.test(env) && /\nDISPLAY_SACRA_DATA=\n/.test(env) && /\nAPI_RELAY_MARKET_DATA=\n/.test(env));
  const docs = `${src('docs/API.md')}\n${src('docs/PRIVACY.md')}`;
  check('docs: API.md and PRIVACY.md name the final variables', ['DISPLAY_FMP_DATA', 'DISPLAY_SACRA_DATA', 'API_RELAY_MARKET_DATA', 'market_note', 'attribution'].every((v) => docs.includes(v)) && !/cdnjs/.test(src('docs/PRIVACY.md')));
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);

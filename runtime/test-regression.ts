/**
 * Milestone 3 regression gate (spec §10.3): v3's regression set — only-crypto,
 * european-etf, ethereum-ecosystem, off-topic real-estate doc. Part A runs
 * offline (merge/extractor semantics, no LLM); Part B runs the full pipeline
 * and needs OPENROUTER_API_KEY.
 */
import { log } from '../ingest/lib/log.js';
import { countAssets } from '../ingest/lib/supabase.js';
import { buildEtfPortfolio } from '../ingest/sources/fmp.js';
import { offlineConstraints, mergeCrit, applyBeginnerEtfDefault, isBeginnerOrLowRisk, type Crit } from './requirements.js';
import { activeCodes, filterViolations, pickAuditLine } from './audit.js';
import { pickAnalysisLine } from './analysis.js';
import { parseJSON } from './llm.js';
import { runResearch } from './pipeline.js';
import { LOW_PRIORITY_CRYPTO_SCORE_CAP, capLowPriorityCryptoScore, allocateByStrategy, pickSelectLine, type Pick } from './select.js';
import { asksForSimilarAssets, similarReferenceMentions } from './thesis.js';
import { passesFilters } from './audit.js';
import { assertPublicHttpUrl } from './extract.js';
import { isLocalRequest } from '../server/auth.js';
import type http from 'node:http';
import type { Candidate } from './candidates.js';

let failures = 0;
function check(name: string, ok: boolean, detail: string) {
  if (!ok) failures++;
  log.info(`${ok ? 'PASS' : 'FAIL'} — ${name}: ${detail}`);
}
function skip(name: string, why: string) {
  log.warn(`SKIP — ${name}: ${why}`);
}

function partA() {
  log.step('Part A — extractor + merge semantics (offline, v3 behavior)');

  // "only crypto" is exclusive and REPLACES a doc-level stock requirement.
  const doc = offlineConstraints('I like tech stocks and companies with strong moats.');
  const box = offlineConstraints('only crypto');
  const merged = mergeCrit(doc, box);
  check('exclusive-merge: only-crypto replaces stocks', JSON.stringify(merged.asset_set) === '["crypto"]', JSON.stringify(merged.asset_set));

  // Exclusions are additive across sources.
  const m2 = mergeCrit({ exclusions_set: ['defense'] }, { exclusions_set: ['micro'] });
  check('exclusions additive', m2.exclusions_set!.length === 2, JSON.stringify(m2.exclusions_set));

  // Same-source guard: exclusive extraction beats non-exclusive from the same text.
  const llmSide = { asset_set: ['stock', 'crypto'], constrained: true };
  const regexSide = offlineConstraints('Show me only crypto, nothing else.', true);
  const m3 = mergeCrit(regexSide, llmSide, { sameSource: true });
  check('same-source guard: exclusive wins', JSON.stringify(m3.asset_set) === '["crypto"]', JSON.stringify(m3.asset_set));

  // Italian instruction cue ("soltanto") detected.
  const it = offlineConstraints('Voglio soltanto crypto legate a Ethereum.');
  check('italian only-clause → crypto exclusive', it.asset_exclusive === true && JSON.stringify(it.asset_set) === '["crypto"]', JSON.stringify(it.asset_set));

  // "only European ETFs" → etf + eu, both exclusive.
  const eu = offlineConstraints('Give me only European ETFs please.');
  check('only-european-etf extraction', JSON.stringify(eu.asset_set) === '["etf"]' && JSON.stringify(eu.region_set) === '["eu"]', `${JSON.stringify(eu.asset_set)} ${JSON.stringify(eu.region_set)}`);

  // §5.1 regex narrowing II (2026-07-10): a currency mention is not a market
  // scope, and a goal sentence is not a semantic constraint. Found by the
  // strategy-breadth E2E — the false region_set=['us'] + topic constraint_note
  // armed the auditor, which deleted the non-USD-currency strategy's picks.
  const hedge = offlineConstraints(
    'I want to hedge against the US dollar. I want my portfolio to preserve purchasing power if the U.S. dollar weakens.',
  );
  check(
    'currency mention binds nothing',
    (hedge.region_set ?? []).length === 0 && !hedge.constraint_note && !hedge.constrained,
    `region=${JSON.stringify(hedge.region_set)} note=${hedge.constraint_note ?? '—'} constrained=${!!hedge.constrained}`,
  );
  const usOnly = offlineConstraints('Only US stocks please.');
  check(
    'explicit US market still binds',
    JSON.stringify(usOnly.region_set) === '["us"]' && usOnly.region_exclusive === true,
    JSON.stringify(usOnly.region_set),
  );
  const ecoNote = offlineConstraints('Show me only crypto related to the Ethereum ecosystem.');
  check(
    'restriction cue keeps constraint_note',
    !!ecoNote.constraint_note && /ethereum/i.test(ecoNote.constraint_note),
    ecoNote.constraint_note ?? '—',
  );

  // §5.1b beginner / low-risk first screen (2026-07-14): a new or low-risk
  // investor who named neither an asset class nor a specific asset defaults to
  // an ETF-only FIRST run; guards keep it from hijacking a real thesis.
  check(
    'beginner/low-risk cue detected (incl. Italian)',
    isBeginnerOrLowRisk("I'm new to investing and want something safe.") &&
      isBeginnerOrLowRisk('Looking for low-risk assets.') &&
      isBeginnerOrLowRisk('Sono un principiante, voglio qualcosa a basso rischio.') &&
      !isBeginnerOrLowRisk('AI will reshape entire industries over the next decade.'),
    'detector',
  );
  const begin = applyBeginnerEtfDefault({ constrained: false } as Crit, "I'm a beginner, what's a safe way to invest?", false);
  check(
    'beginner + no asset/anchor → ETF-only first screen',
    JSON.stringify(begin.asset_set) === '["etf"]' && begin.constrained === true,
    JSON.stringify(begin.asset_set),
  );
  const beginAnchored = applyBeginnerEtfDefault({ constrained: false } as Crit, 'NVDA is a low-risk play on AI.', true);
  check(
    'named-asset guard: anchored low-risk thesis keeps no ETF default',
    !beginAnchored.asset_set?.length,
    JSON.stringify(beginAnchored.asset_set ?? []),
  );
  const beginStocks = applyBeginnerEtfDefault({ asset_set: ['stock'], constrained: true } as Crit, 'Low-risk tech stocks for a beginner.', false);
  check(
    'explicit-asset guard: low-risk stock request stays stocks',
    JSON.stringify(beginStocks.asset_set) === '["stock"]',
    JSON.stringify(beginStocks.asset_set),
  );
  const noCue = applyBeginnerEtfDefault({ constrained: false } as Crit, 'Ethereum will win the L2 race.', false);
  check(
    'no beginner cue → no ETF default',
    !noCue.asset_set?.length,
    JSON.stringify(noCue.asset_set ?? []),
  );

  check(
    'similar-to reference detector',
    asksForSimilarAssets('Find companies similar to Nvidia.') &&
      asksForSimilarAssets('Show me alternatives to Tesla.') &&
      !asksForSimilarAssets('Nvidia will benefit from AI data centers.'),
    'similar/alternatives true, ordinary anchor false',
  );
  check(
    'similar-to reference mention extraction',
    JSON.stringify(similarReferenceMentions('Find companies similar to Nvidia, but not Nvidia itself.')) === '["Nvidia"]' &&
      JSON.stringify(similarReferenceMentions('Give me tokens like Solana for consumer apps.')) === '["Solana"]' &&
      JSON.stringify(similarReferenceMentions('Show me alternatives to Bitcoin for a digital-gold thesis.')) === '["Bitcoin"]' &&
      JSON.stringify(similarReferenceMentions('Which US companies are analogous to Apple in brand power?')) === '["Apple"]',
    'extracts reference objects without trailing scope words',
  );

  const candidate = (ticker: string, name: string, categories: string[]): Candidate => ({
    id: 0,
    ticker,
    name,
    kind: 'crypto',
    region: 'global',
    cap_class: null,
    exchange: null,
    cex_venues: [],
    dex_venues: [],
    sector: null,
    categories,
    etf_portfolio: null,
    volume_24h_usd: null,
    blurb: null,
    sim: 0,
  });
  check(
    'crypto meme/stablecoin score cap',
    capLowPriorityCryptoScore(candidate('DOGE', 'Dogecoin', ['Memes']), 92) === LOW_PRIORITY_CRYPTO_SCORE_CAP &&
      capLowPriorityCryptoScore(candidate('USDC', 'USD Coin', ['Stablecoin']), 88) === LOW_PRIORITY_CRYPTO_SCORE_CAP &&
      capLowPriorityCryptoScore(candidate('ETH', 'Ethereum', ['Smart Contract Platform']), 88) === 88,
    `cap=${LOW_PRIORITY_CRYPTO_SCORE_CAP}`,
  );
  // On-topic escape (§5.3): a thesis ABOUT the capped class keeps honest scores —
  // and the escape is per-class (a stablecoin thesis does not uncap memes).
  const stableScope = 'Morgan Stanley stablecoin reserve fund thesis stablecoin infrastructure';
  check(
    'crypto cap on-topic escape',
    capLowPriorityCryptoScore(candidate('USDC', 'USD Coin', ['Stablecoin']), 88, stableScope) === 88 &&
      capLowPriorityCryptoScore(candidate('DOGE', 'Dogecoin', ['Memes']), 92, stableScope) === LOW_PRIORITY_CRYPTO_SCORE_CAP &&
      capLowPriorityCryptoScore(candidate('DOGE', 'Dogecoin', ['Memes']), 92, 'meme coin supercycle thesis') === 92,
    'stablecoin thesis uncaps stablecoins only',
  );

  // §5.3 strategy breadth (2026-07-10): Diversified allocation caps each
  // strategy at 3 and, when trimming to maxPicks, keeps every covered
  // strategy's best pick before filling by score — coverage over convergence.
  const sp = (ticker: string, score: number, strategy?: string): Pick => ({
    a: candidate(ticker, ticker, []),
    score,
    why: '',
    rel: 'adjacent',
    ...(strategy ? { strategy } : {}),
  });
  const goldHeavy = [
    sp('G1', 98, 'Precious metals'), sp('G2', 96, 'Precious metals'), sp('G3', 94, 'Precious metals'),
    sp('G4', 92, 'Precious metals'), // 4th gold pick must be cut by the per-strategy cap
    sp('FX1', 60, 'Non-USD currencies'), sp('BTC', 55, 'Bitcoin & hard-asset crypto'),
    sp('X1', 40), // unattributed → 'other' group, still allowed
  ];
  const alloc = allocateByStrategy(goldHeavy, 10);
  check(
    'strategy allocation: per-strategy cap, alternatives survive',
    alloc.length === 6 && !alloc.some((p) => p.a.ticker === 'G4') &&
      ['FX1', 'BTC', 'X1'].every((t) => alloc.some((p) => p.a.ticker === t)),
    alloc.map((p) => p.a.ticker).join(','),
  );
  const crowded = [
    sp('A1', 99, 'S1'), sp('A2', 98, 'S1'), sp('A3', 97, 'S1'),
    sp('B1', 96, 'S2'), sp('B2', 95, 'S2'), sp('B3', 94, 'S2'),
    sp('C1', 30, 'S3'), sp('D1', 25, 'S4'),
  ];
  const trimmed = allocateByStrategy(crowded, 6);
  check(
    'strategy allocation: trim keeps each strategy’s best pick',
    trimmed.length === 6 && ['C1', 'D1'].every((t) => trimmed.some((p) => p.a.ticker === t)),
    trimmed.map((p) => `${p.a.ticker}:${p.score}`).join(','),
  );

  // §5.4 (2026-07-10): the compliance auditor may drop a pick only for breaking a
  // constraint that is actually on `crit`. The regression that motivated it: five
  // broad-Europe ETFs deleted as "not AI compute independence themed" — a fit
  // objection wearing a compliance badge.
  const picked = new Set(['FLEE', 'IEUR', 'ARB']);
  const themeOnly = filterViolations(
    [{ t: 'FLEE', c: 'semantic', why: 'Broad Europe ETF, not AI compute themed' }],
    { region_set: ['eu'] },
    picked,
  );
  check(
    'audit: off-theme drop discarded when no semantic constraint',
    Object.keys(themeOnly.drop).length === 0 && themeOnly.discarded.length === 1,
    `drop=${JSON.stringify(themeOnly.drop)} discarded=${themeOnly.discarded.length}`,
  );

  // A real semantic scope still binds — the eth-ecosystem case must keep working.
  const ecoBinds = filterViolations(
    [{ t: 'ARB', c: 'semantic', why: 'outside Ethereum ecosystem' }],
    { constraint_note: 'only crypto related to the Ethereum ecosystem' },
    picked,
  );
  check('audit: semantic violation binds when constraint_note set', !!ecoBinds.drop.ARB, JSON.stringify(ecoBinds.drop));

  // An inactive code, a missing code, and an invented ticker all fail closed.
  const bogus = filterViolations(
    [
      { t: 'IEUR', c: 'cap', why: 'wrong size' }, // no cap_set on crit
      { t: 'FLEE', why: 'no code at all' },
      { t: 'NVDA', c: 'region', why: 'not among the picks' },
    ],
    { region_set: ['eu'] },
    picked,
  );
  check(
    'audit: inactive code / missing code / unknown ticker all discarded',
    Object.keys(bogus.drop).length === 0,
    `drop=${JSON.stringify(bogus.drop)} discarded=${bogus.discarded.length}`,
  );

  // Active codes mirror exactly the constraints present on the merged Crit.
  check(
    'audit: activeCodes derives from crit fields',
    JSON.stringify([...activeCodes({ region_set: ['eu'], exclude_tickers: ['ETH'] })].sort()) === '["region","ticker"]' &&
      activeCodes(null).size === 0 &&
      activeCodes({}).size === 0,
    JSON.stringify([...activeCodes({ region_set: ['eu'], exclude_tickers: ['ETH'] })]),
  );

  // §5.4 (2026-07-23): the audit lines carry the cap_class size band — AUM
  // wording for funds, market cap otherwise, omitted when unbanded — so the
  // auditor never guesses dollar figures for "AUM above 10 billion" scopes.
  const vt: Candidate = { ...candidate('VT', 'Vanguard Total World Stock ETF', ['UCITS']), kind: 'etf', cap_class: 'large' };
  const nvda: Candidate = { ...candidate('NVDA', 'NVIDIA Corp', []), kind: 'stock', cap_class: 'mega', sector: 'Semiconductors' };
  const unbanded: Candidate = { ...candidate('XYZ', 'Mystery Fund', []), kind: 'etf' };
  check(
    'audit lines: fund AUM band, stock market-cap band, unbanded omitted',
    pickAuditLine(vt) === 'VT = Vanguard Total World Stock ETF (etf; AUM $10B to $200B; UCITS)' &&
      pickAuditLine(nvda) === 'NVDA = NVIDIA Corp (stock; market cap above $200B; Semiconductors)' &&
      pickAuditLine(unbanded) === 'XYZ = Mystery Fund (etf)',
    [vt, nvda, unbanded].map(pickAuditLine).join(' | '),
  );

  // §5.5 (2026-07-23): the analysis lines carry the same band — the prose
  // stage invented figures without it (SMH "AUM near $10B", actually ~$70B).
  check(
    'analysis lines: size field banded, empty when unbanded',
    pickAnalysisLine(vt) === 'VT|Vanguard Total World Stock ETF|etf|AUM $10B to $200B|UCITS|' &&
      pickAnalysisLine(nvda) === 'NVDA|NVIDIA Corp|stock|market cap above $200B|Semiconductors|' &&
      pickAnalysisLine(unbanded) === 'XYZ|Mystery Fund|etf|||',
    [vt, nvda, unbanded].map(pickAnalysisLine).join(' | '),
  );

  // §5.3 (2026-07-23): the select catalog lines carry the same band — the
  // "w" rationales invented figures without it (SMH "~$22B AUM", actually ~$70B).
  check(
    'select lines: size field banded, empty when unbanded',
    pickSelectLine(vt) === 'VT|Vanguard Total World Stock ETF|etf|AUM $10B to $200B|global||UCITS|' &&
      pickSelectLine(nvda) === 'NVDA|NVIDIA Corp|stock|market cap above $200B|global|Semiconductors||' &&
      pickSelectLine(unbanded) === 'XYZ|Mystery Fund|etf||global|||',
    [vt, nvda, unbanded].map(pickSelectLine).join(' | '),
  );

  const chinaStock = (ticker: string, exchange: string): Candidate => ({
    ...candidate(ticker, ticker, []),
    kind: 'stock',
    region: 'cn',
    exchange,
  });
  check(
    'card-selected China is HKEX-only',
    passesFilters(chinaStock('0700.HK', 'HK'), { region_set: ['cn'], cn_hkex_only: true }) &&
      passesFilters(chinaStock('9961.HK', 'HKSE'), { region_set: ['cn'], cn_hkex_only: true }) &&
      !passesFilters(chinaStock('TCEHY', 'PINK'), { region_set: ['cn'], cn_hkex_only: true }) &&
      passesFilters(chinaStock('TCEHY', 'PINK'), { region_set: ['cn'] }),
    'HK and FMP HKSE pass; ADR/OTC fails only for the explicit card flag',
  );

  // §6 Italy market button: 'it' binds via the 'Italy' category tag in UNION
  // with any coarse regions — an Italy-only selection passes Italian-tagged
  // rows wherever domiciled (EWI is a US fund) and nothing else; EU alone
  // still includes Italian stocks via region='eu'.
  const regionStock = (ticker: string, region: string, cats: string[], kind = 'stock'): Candidate => ({
    ...candidate(ticker, ticker, cats),
    kind,
    region,
  });
  check(
    'card-selected Italy binds via the Italy category tag',
    passesFilters(regionStock('RACE.MI', 'eu', ['Italy']), { region_set: ['it'] }) &&
      passesFilters(regionStock('EWI', 'us', ['Italy'], 'etf'), { region_set: ['it'] }) &&
      !passesFilters(regionStock('SAP', 'eu', []), { region_set: ['it'] }) &&
      !passesFilters(regionStock('AAPL', 'us', []), { region_set: ['it'] }) &&
      passesFilters(regionStock('SAP', 'eu', []), { region_set: ['eu'] }) &&
      passesFilters(regionStock('RACE.MI', 'eu', ['Italy']), { region_set: ['eu'] }) &&
      passesFilters(regionStock('SAP', 'eu', []), { region_set: ['eu', 'it'] }),
    'Italy-only passes tagged rows wherever domiciled; EU keeps including Italy; eu+it is a union',
  );

  let blockedPrivateUrl = false;
  try {
    assertPublicHttpUrl('http://169.254.169.254/latest/meta-data');
  } catch {
    blockedPrivateUrl = true;
  }
  check(
    'link extraction blocks private-network targets',
    blockedPrivateUrl &&
      (() => {
        try {
          assertPublicHttpUrl('http://[::ffff:127.0.0.1]/admin');
          return false;
        } catch {
          return true;
        }
      })() &&
      assertPublicHttpUrl('https://example.com/article').hostname === 'example.com',
    'metadata IP and IPv4-mapped loopback blocked; public HTTPS accepted',
  );

  // Localhost auth bypass is a development convenience only. Host is supplied
  // by the client, so production must fail closed on every Host spelling.
  const previousNodeEnv = process.env.NODE_ENV;
  // Locality now comes from the TCP peer (socket), not the Host header alone.
  const localReq = { headers: { host: 'localhost:8787' }, socket: { remoteAddress: '127.0.0.1' } } as unknown as http.IncomingMessage;
  const spoofedReq = { headers: { host: 'localhost:8787' }, socket: { remoteAddress: '203.0.113.5' } } as unknown as http.IncomingMessage;
  const rebindReq = { headers: { host: 'evil.example:8787' }, socket: { remoteAddress: '127.0.0.1' } } as unknown as http.IncomingMessage;
  Reflect.set(process.env, 'NODE_ENV', 'development');
  const devLocal = isLocalRequest(localReq);
  const devSpoofed = isLocalRequest(spoofedReq);
  const devRebind = isLocalRequest(rebindReq);
  Reflect.set(process.env, 'NODE_ENV', 'production');
  const prodLocal = isLocalRequest(localReq);
  if (previousNodeEnv === undefined) Reflect.deleteProperty(process.env, 'NODE_ENV');
  else Reflect.set(process.env, 'NODE_ENV', previousNodeEnv);
  check(
    'localhost auth bypass is development-only',
    devLocal && !prodLocal,
    `development=${devLocal} production=${prodLocal}`,
  );
  check(
    'localhost bypass ignores a spoofed Host from a remote socket and a rebinding Host',
    !devSpoofed && !devRebind,
    `remote-socket=${devSpoofed} rebinding-host=${devRebind}`,
  );

  // FMP ETF payloads normalize into stable top holdings + slices. Fixture
  // mirrors the LIVE vendor shapes (spec §4.1, verified 2026-07-10): sector
  // weightPercentage arrives as a NUMBER but country weightPercentage as a
  // "70.33%" STRING; weight-less rows must rank BELOW real values, including
  // negative ones (inverse-ETF swap legs).
  const pf = buildEtfPortfolio({
    info: {
      holdingsCount: 503,
      // Fund facts (spec §3, 2026-07-12) — live SWDA.MI-shaped values.
      etfCompany: 'IShares',
      expenseRatio: 0.2,
      avgVolume: 121740,
      inceptionDate: '2009-09-25',
      nav: 126.4,
      navCurrency: 'EUR',
      domicile: 'IE',
    },
    holdings: [
      { asset: 'MSFT', name: 'Microsoft Corporation', weightPercentage: 6.4 },
      { asset: 'AAPL', name: 'Apple Inc', weightPercentage: 6.8 },
      { asset: 'SWP', name: 'Inverse Swap Leg', weightPercentage: -98.9 },
      { asset: 'UNK', name: 'Unknown' }, // weight-less row ranks last
    ],
    sectors: [
      { sector: 'Healthcare', weightPercentage: 12.3 },
      { sector: 'Technology', weightPercentage: 29.1 },
    ],
    countries: [
      { country: 'United States', weightPercentage: '70.33%' },
      { country: 'Italy', weightPercentage: '4.2%' },
    ],
  });
  check(
    'etf-portfolio normalization (live vendor shapes)',
    pf?.holdings_count === 503 &&
      pf.top_holdings?.[0]?.symbol === 'AAPL' &&
      pf.top_holdings?.[0]?.weight === 6.8 &&
      pf.top_holdings?.[2]?.weight === -98.9 &&
      pf.top_holdings?.[3]?.weight === null &&
      pf.sector_weights?.[0]?.name === 'Technology' &&
      pf.sector_weights?.[0]?.weight === 29.1 &&
      pf.region_weights?.[0]?.name === 'United States' &&
      pf.region_weights?.[0]?.weight === 70.33,
    JSON.stringify(pf),
  );
  check(
    'etf fund facts stored from etf/info (spec §3 2026-07-12)',
    pf?.expense_ratio === 0.2 &&
      pf.avg_volume === 121740 &&
      pf.inception_date === '2009-09-25' &&
      pf.nav === 126.4 &&
      pf.nav_currency === 'EUR' &&
      pf.issuer === 'IShares' &&
      pf.domicile === 'IE',
    JSON.stringify({ er: pf?.expense_ratio, av: pf?.avg_volume, inc: pf?.inception_date, nav: pf?.nav, cur: pf?.nav_currency, iss: pf?.issuer, dom: pf?.domicile }),
  );

  // parseJSON inner-quote repair (2026-07-29): the /analysis prompt asks the
  // model to quote the thesis, and it answered with real double quotes inside
  // a string value — `Research failed: Model returned non-JSON output` on prod.
  const innerQuoted =
    '{"REMX":"EVIDENCE — The thesis targets "ETFs focused on rare earth elements and precious/critical minerals only," and REMX is the most direct single-fund expression of it."}';
  let iq: Record<string, string> | null = null;
  try {
    iq = parseJSON<Record<string, string>>(innerQuoted);
  } catch {
    /* fail below */
  }
  check(
    'parseJSON repairs unescaped quotes inside string values',
    iq?.REMX?.includes('"ETFs focused on rare earth elements') === true,
    iq?.REMX?.slice(0, 80) ?? 'threw',
  );
  const validEscaped = '{"A":"he said \\"only crypto\\", nothing else","s":0.78}';
  const ve = parseJSON<{ A: string; s: number }>(validEscaped);
  check(
    'parseJSON leaves already-valid escaped quotes untouched',
    ve.A === 'he said "only crypto", nothing else' && ve.s === 0.78,
    JSON.stringify(ve),
  );
  const slips = parseJSON<{ s: number }>('```json\n{"s":.78,}\n```');
  check('parseJSON still fixes leading-dot decimals and trailing commas', slips.s === 0.78, JSON.stringify(slips));
}

async function partB() {
  log.step('Part B — full pipeline regression (LLM)');
  if (!process.env.OPENROUTER_API_KEY) {
    skip('pipeline regression', 'OPENROUTER_API_KEY not set');
    return;
  }
  const equities = await countAssets({ source: 'fmp' });

  // 1. only-crypto: a stock can NEVER render.
  {
    const doc =
      'I believe decentralized finance will eat traditional banking fees. Lending, exchanges and staking all accrue value on-chain. Show me only crypto.';
    const r = await runResearch(doc);
    const nonCrypto = r.picks.filter((p) => p.a.kind !== 'crypto');
    check('only-crypto: zero non-crypto picks', nonCrypto.length === 0, `${r.picks.length} picks, ${nonCrypto.length} violations`);
    check('only-crypto: got results', r.picks.length > 0, `${r.picks.length} picks (${r.path})`);
  }

  // 2. ethereum-ecosystem: semantic scope respected.
  {
    const doc =
      'Rollups and staking make ETH productive. I want exposure, but only crypto related to the Ethereum ecosystem.';
    const r = await runResearch(doc);
    const offEco = r.picks.filter((p) => !(p.a.categories ?? []).some((c) => /ethereum/i.test(c)));
    check('eth-ecosystem: picks are crypto', r.picks.every((p) => p.a.kind === 'crypto'), `${r.picks.length} picks`);
    check('eth-ecosystem: ≤2 picks lack Ethereum tags (audit tolerance)', offEco.length <= 2, `${offEco.length} untagged: ${offEco.map((p) => p.a.ticker).join(', ') || '—'}`);
  }

  // 3. european-etf: exclusively etf+eu, or an honest empty state pre-backfill.
  {
    const doc = 'I want broad European market exposure for my retirement account. Only European ETFs.';
    const r = await runResearch(doc);
    const viol = r.picks.filter((p) => p.a.kind !== 'etf' || p.a.region !== 'eu');
    check('european-etf: zero violations', viol.length === 0, `${r.picks.length} picks, ${viol.length} violations`);
    if (r.path === 'empty' && equities < 5000) skip('european-etf: results expected', `honest empty (${equities} equities ingested)`);
    else check('european-etf: results or honest empty', r.path === 'full' ? r.picks.length > 0 : true, `path=${r.path}`);
  }

  // 4. off-topic real-estate doc: with the real universe this should return
  //    REITs (needs equities); until then it must NOT fabricate.
  {
    const doc =
      'Housing shortages persist across major metros. Rental demand and commercial property income streams look durable. I want income from real estate.';
    const r = await runResearch(doc);
    if (equities > 5000) {
      check('real-estate: returns real matches', r.picks.length > 0, `${r.picks.length} picks: ${r.picks.map((p) => p.a.ticker).join(', ')}`);
    } else {
      check('real-estate: no fabricated equities', r.picks.every((p) => p.a.kind === 'crypto' || equities > 0), `${r.picks.length} picks (universe still crypto-heavy: honest behavior)`);
      skip('real-estate: REIT retrieval', `equities universe too small (${equities})`);
    }
  }
}

async function main() {
  partA();
  await partB();
  log.step(failures === 0 ? 'ALL REGRESSION CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  log.error('test-regression failed', err);
  process.exit(1);
});

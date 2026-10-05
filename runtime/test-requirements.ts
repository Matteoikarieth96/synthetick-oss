/**
 * Financial-requirement gate (spec §15.6).
 *
 *   npm run test:requirements
 *
 * Three layers:
 *   1. pure       — bound checking, unit handling, exposure weights, track
 *                   record, and the "missing metric excludes" rule. No network.
 *   2. extraction — the 20 request fixtures, asserting the parsed bounds and
 *                   that unavailable asks are reported rather than dropped.
 *                   One cheap call each; skipped without OPENROUTER_API_KEY.
 *   3. live       — every requirement applied against the real universe, with
 *                   each survivor re-verified INDEPENDENTLY from the database
 *                   rather than through the same filter. Skips pre-migration.
 *
 * Full screens are not run here: 20 of them is 40 minutes and real LLM spend,
 * and what needs proving is that the filter admits exactly the right assets.
 * A handful of end-to-end runs are exercised separately.
 */
import 'dotenv/config';
import { log } from '../ingest/lib/log.js';
import { supabase } from '../ingest/lib/supabase.js';
import { passesFilters } from './audit.js';
import { fundMatchesRegions, fundRegionWeightPct, regionForCountryName } from './fundgeo.js';
import type { Candidate } from './candidates.js';
import {
  extractFinReq,
  checkAsset,
  factFor,
  exposureWeight,
  trackRecordYears,
  loadFacts,
  finReqSummary,
  hasFinReq,
  sanitizeFinReq,
  SPECS,
  type AssetFacts,
  type FinReq,
} from './finreq.js';

let pass = 0;
let fail = 0;
let skipped = 0;
const failures: string[] = [];
function ok(name: string, good: boolean, detail = '') {
  if (good) pass++;
  else {
    fail++;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  }
  return good;
}
const skip = (name: string, why: string) => {
  skipped++;
  log.warn(`SKIP — ${name}: ${why}`);
};

const facts = (over: Partial<AssetFacts> = {}): AssetFacts => ({
  assetId: 1,
  kind: 'stock',
  currency: 'USD',
  marketCapUsd: 5e9,
  portfolio: null,
  metrics: {},
  ...over,
});

// ---- 1. Pure ---------------------------------------------------------------

function pureTests() {
  log.step('Pure: bound checking and fund fields');

  const peReq: FinReq = { bounds: [{ key: 'pe', max: 12 }], exposures: [], currencies: [], domiciles: [], unverifiable: [] };
  ok('bound: passes under the max', checkAsset(peReq, facts({ metrics: { pe: 9 } })).pass);
  ok('bound: fails over the max', !checkAsset(peReq, facts({ metrics: { pe: 20 } })).pass);
  ok('bound: boundary is inclusive', checkAsset(peReq, facts({ metrics: { pe: 12 } })).pass);
  // The rule that matters most: an asset we cannot verify does not qualify,
  // and the reason is reported rather than silently folded into "failed".
  const missing = checkAsset(peReq, facts({ metrics: {} }));
  ok('bound: missing metric excludes', !missing.pass);
  ok('bound: missing metric is reported as unchecked', missing.unchecked.includes('pe'), JSON.stringify(missing.unchecked));

  // An upper bound on a valuation multiple implies a positive one: a negative
  // P/E is a loss-making company, not a cheap one.
  ok('valuation: negative P/E fails "below 12"', !checkAsset(peReq, facts({ metrics: { pe: -24.4 } })).pass);
  ok('valuation: zero P/E fails "below 12"', !checkAsset(peReq, facts({ metrics: { pe: 0 } })).pass);
  const pbReq: FinReq = { bounds: [{ key: 'price_to_book', max: 1 }], exposures: [], currencies: [], domiciles: [], unverifiable: [] };
  ok('valuation: negative book value fails "below book"', !checkAsset(pbReq, facts({ metrics: { price_to_book: -0.5 } })).pass);
  ok('valuation: a min bound still admits any positive value', checkAsset({ bounds: [{ key: 'pe', min: 5 }], exposures: [], currencies: [], domiciles: [], unverifiable: [] }, facts({ metrics: { pe: 30 } })).pass);

  const range: FinReq = { bounds: [{ key: 'market_cap_usd', min: 1e8, max: 1e9 }], exposures: [], currencies: [], domiciles: [], unverifiable: [] };
  ok('range: inside', checkAsset(range, facts({ metrics: { market_cap_usd: 5e8 } })).pass);
  ok('range: above', !checkAsset(range, facts({ metrics: { market_cap_usd: 2e9 } })).pass);
  ok('range: below', !checkAsset(range, facts({ metrics: { market_cap_usd: 5e7 } })).pass);

  // A negative bound: "fell more than 20%" is return_1y_pct <= -20.
  const fell: FinReq = { bounds: [{ key: 'return_1y_pct', max: -20 }], exposures: [], currencies: [], domiciles: [], unverifiable: [] };
  ok('negative bound: -35% passes', checkAsset(fell, facts({ metrics: { return_1y_pct: -35 } })).pass);
  ok('negative bound: -5% fails', !checkAsset(fell, facts({ metrics: { return_1y_pct: -5 } })).pass);

  // Fund AUM is market_cap_usd on etf/bond rows, and nothing on a stock.
  const aum: FinReq = { bounds: [{ key: 'aum_usd', min: 5e8 }], exposures: [], currencies: [], domiciles: [], unverifiable: [] };
  ok('aum: fund reads market_cap_usd', checkAsset(aum, facts({ kind: 'etf', metrics: { market_cap_usd: 1e9 } })).pass);
  ok('aum: a stock has no AUM', !checkAsset(aum, facts({ kind: 'stock', metrics: { market_cap_usd: 1e9 } })).pass);

  ok('ter: read from the portfolio', factFor('ter_pct', facts({ kind: 'etf', portfolio: { expense_ratio: 0.07 } })) === 0.07);
  ok('ter: absent is null', factFor('ter_pct', facts({ kind: 'etf', portfolio: {} })) === null);

  const tr = trackRecordYears('2019-01-01');
  ok('track record: computed in years', tr != null && tr > 6 && tr < 9, String(tr));
  ok('track record: absent is null', trackRecordYears(null) === null);
  ok('track record: garbage is null', trackRecordYears('not a date') === null);

  // Exposure: a breakdown that exists but omits the name means zero, which is
  // a real failure; no breakdown at all is unverifiable.
  const ind = { kind: 'country' as const, name: 'India', minWeightPct: 50 };
  ok('exposure: matching country weight', exposureWeight(ind, facts({ portfolio: { region_weights: [{ name: 'India', weight: 98 }] } })) === 98);
  ok('exposure: absent from a real breakdown is 0', exposureWeight(ind, facts({ portfolio: { region_weights: [{ name: 'United States', weight: 99 }] } })) === 0);
  ok('exposure: no breakdown is null', exposureWeight(ind, facts({ portfolio: {} })) === null);

  // Review-card round trip (live 2026-07-28): the extractor emits explicit
  // nulls ({min: 2e8, max: null}), the browser posts them back verbatim, and
  // Number(null) is 0 — so a naive re-validation turned "AUM at or above
  // $200M" into "AUM between $200M and $0" and every browser run with a
  // requirement chip returned empty while API runs (which re-extract) passed.
  const posted = sanitizeFinReq({
    bounds: [{ key: 'aum_usd', min: 2e8, max: null }],
    exposures: [{ kind: 'sector', name: 'Energy', minWeightPct: null }],
    currencies: [], domiciles: [], unverifiable: [],
  });
  ok('sanitize: null max stays null', posted?.bounds[0]?.max == null, JSON.stringify(posted?.bounds));
  ok('sanitize: min survives', posted?.bounds[0]?.min === 2e8);
  ok('sanitize: null minWeightPct falls back to 50, not 0', posted?.exposures[0]?.minWeightPct === 50, String(posted?.exposures[0]?.minWeightPct));
  const boundOnly = sanitizeFinReq({ bounds: [{ key: 'aum_usd', min: 2e8, max: null }], exposures: [], currencies: [], domiciles: [], unverifiable: [] });
  ok(
    'sanitize: round-tripped bound admits an asset above the min',
    boundOnly != null && checkAsset(boundOnly, facts({ kind: 'etf', metrics: { market_cap_usd: 49e9 } })).pass,
  );
  ok(
    'sanitize: summary has no "$0" upper bound',
    posted != null && !finReqSummary(posted).some((s) => s.includes('$0')),
    posted ? finReqSummary(posted).join('; ') : '',
  );

  const eur: FinReq = { bounds: [], exposures: [], currencies: ['EUR'], domiciles: [], unverifiable: [] };
  ok('currency: matches', checkAsset(eur, facts({ currency: 'EUR' })).pass);
  ok('currency: mismatch fails', !checkAsset(eur, facts({ currency: 'USD' })).pass);

  const ucits: FinReq = { bounds: [], exposures: [], currencies: [], domiciles: ['IE', 'LU'], unverifiable: [] };
  ok('domicile: IE passes', checkAsset(ucits, facts({ kind: 'etf', portfolio: { domicile: 'IE' } })).pass);
  ok('domicile: US fails', !checkAsset(ucits, facts({ kind: 'etf', portfolio: { domicile: 'US' } })).pass);

  // ---- fund geography: holdings, not domicile (spec §15.4) ----
  ok('geo: United States maps to us', regionForCountryName('United States') === 'us');
  ok('geo: Ireland maps to eu', regionForCountryName('Ireland') === 'eu');
  ok('geo: Japan maps to other', regionForCountryName('Japan') === 'other');
  ok('geo: Hong Kong maps to cn', regionForCountryName('Hong Kong') === 'cn');
  ok('geo: vendor name variants resolve', regionForCountryName('Korea (the Republic of)') === 'other' && regionForCountryName('Taiwan (Province of China)') === 'other');
  ok('geo: an unknown country is other', regionForCountryName('Freedonia') === 'other');

  const jpFund = { region_weights: [{ name: 'Japan', weight: 97 }, { name: 'Other', weight: 3 }] };
  ok('geo: a Japan fund matches other, not eu', fundMatchesRegions(jpFund, ['other']) === true && fundMatchesRegions(jpFund, ['eu']) === false);
  // The case that motivated all of this: an Irish wrapper holding US equities
  // is a US fund, and an Irish wrapper holding Japan is a Japan fund. Neither
  // is European just because the paperwork is.
  const sp500Ucits = { region_weights: [{ name: 'United States', weight: 99 }] };
  ok('geo: an Irish S&P 500 UCITS is not European', fundMatchesRegions(sp500Ucits, ['eu']) === false);
  ok('geo: ...and is American', fundMatchesRegions(sp500Ucits, ['us']) === true);
  ok('geo: no breakdown is unverifiable, not zero', fundMatchesRegions({}, ['eu']) === null);
  ok('geo: italy is Italy alone, not the eu bucket', fundRegionWeightPct({ region_weights: [{ name: 'Italy', weight: 88 }, { name: 'France', weight: 12 }] }, 'it') === 88);

  // The same rule through the real filter both paths use.
  const fund = (pf: unknown, kind = 'etf') => ({ ticker: 'X', name: 'X', kind, region: 'eu', categories: [], etf_portfolio: pf } as unknown as Candidate);
  ok('passesFilters: Irish Japan ETF passes an "other" region ask', passesFilters(fund(jpFund), { region_set: ['other'] }));
  ok('passesFilters: Irish Japan ETF fails a "eu" region ask', !passesFilters(fund(jpFund), { region_set: ['eu'] }));
  ok('passesFilters: a company is still judged by domicile', passesFilters({ ticker: 'Y', name: 'Y', kind: 'stock', region: 'eu', categories: [] } as unknown as Candidate, { region_set: ['eu'] }));
  ok('passesFilters: a fund with no breakdown fails a region ask', !passesFilters(fund({}), { region_set: ['eu'] }));

  ok('summary: renders usd compactly', finReqSummary({ bounds: [{ key: 'aum_usd', min: 5e8 }], exposures: [], currencies: [], domiciles: [], unverifiable: [] })[0] === 'AUM at or above $500M');
  ok('hasFinReq: false when only unverifiable', !hasFinReq({ bounds: [], exposures: [], currencies: [], domiciles: [], unverifiable: ['x'] }));
}

// ---- 2. Extraction ---------------------------------------------------------

interface ExtractCase {
  n: number;
  prompt: string;
  /** Bound keys that must be present, with their expected min/max. */
  want?: { key: string; min?: number; max?: number }[];
  /** Substrings, at least one of which must appear in `unverifiable`. */
  wantUnverifiable?: string[];
  wantCountry?: string;
  wantCurrency?: string;
  wantDomicile?: string;
}

const CASES: ExtractCase[] = [
  { n: 1, prompt: 'I believe in the nuclear sector, give me ETFs with AUM above 500m.', want: [{ key: 'aum_usd', min: 5e8 }] },
  { n: 2, prompt: 'I think defense spending in Europe keeps rising, show me European defense ETFs with TER below 0.50% listed in EUR.', want: [{ key: 'ter_pct', max: 0.5 }], wantCurrency: 'EUR' },
  { n: 3, prompt: 'I want exposure to Indian domestic consumption, find UCITS ETFs tracking India with at least 3 years of track record.', want: [{ key: 'track_record_years', min: 3 }], wantCountry: 'India', wantDomicile: 'IE' },
  { n: 4, prompt: 'I expect rates to fall in 2027, show me long duration government bond ETFs with average maturity above 15 years.', wantUnverifiable: ['maturity'] },
  { n: 5, prompt: 'I am bullish on copper as the electrification bottleneck, list copper miner ETFs with daily volume above 1m and AUM above 200m.', want: [{ key: 'fund_avg_volume', min: 1e6 }, { key: 'aum_usd', min: 2e8 }] },
  { n: 6, prompt: 'I believe active fixed income beats passive right now, show me actively managed bond ETFs with a yield above 5% and TER below 0.60%.', want: [{ key: 'ter_pct', max: 0.6 }], wantUnverifiable: ['yield', 'active'] },
  { n: 7, prompt: 'I think grid infrastructure is the real AI trade, give me listed utilities and grid equipment makers in Europe with market cap above 5bn.', want: [{ key: 'market_cap_usd', min: 5e9 }] },
  { n: 8, prompt: 'I believe obesity drugs compress the medtech device market, show me cardiac and bariatric device makers that fell more than 20% over the last 12 months.', want: [{ key: 'return_1y_pct', max: -20 }] },
  { n: 9, prompt: 'I am betting on the reshoring of semiconductor manufacturing, find equipment suppliers with more than 40% of revenue from foundry customers and market cap above 2bn.', want: [{ key: 'market_cap_usd', min: 2e9 }], wantUnverifiable: ['revenue'] },
  { n: 10, prompt: 'I think Japanese corporate governance reform is real, screen Japanese companies trading below book value with a buyback announced in the last 12 months.', want: [{ key: 'price_to_book', max: 1 }], wantUnverifiable: ['buyback'] },
  { n: 11, prompt: 'I believe cybersecurity budgets are non discretionary, give me software names with revenue growth above 20% and positive free cash flow.', want: [{ key: 'revenue_growth_pct', min: 20 }, { key: 'fcf_per_share', min: 0 }] },
  { n: 12, prompt: 'I want to own the water scarcity theme, list utilities and treatment companies with a dividend yield above 3% and net debt to EBITDA below 3x.', want: [{ key: 'dividend_yield_pct', min: 3 }, { key: 'net_debt_to_ebitda', max: 3 }] },
  { n: 13, prompt: 'I think Italian small caps are structurally mispriced, show me Milan listed companies with market cap between 100m and 1bn and P/E below 12.', want: [{ key: 'market_cap_usd', min: 1e8, max: 1e9 }, { key: 'pe', max: 12 }] },
  { n: 14, prompt: 'I am bearish on legacy autos but bullish on suppliers, find tier 1 auto suppliers with EV exposure above 30% of revenue.', wantUnverifiable: ['EV', 'revenue'] },
  { n: 15, prompt: 'I believe uranium supply stays tight through 2030, give me producers and developers with a market cap above 1bn and production already online.', want: [{ key: 'market_cap_usd', min: 1e9 }], wantUnverifiable: ['production'] },
  { n: 16, prompt: 'I think European high yield spreads are too tight, show me investment grade EUR corporate bonds maturing between 2029 and 2032 with a yield above 4%.', wantUnverifiable: ['grade', 'maturi', 'yield'] },
  { n: 17, prompt: 'I want inflation protection without duration risk, list short dated inflation linked bonds with maturity under 5 years.', wantUnverifiable: ['maturi'] },
  { n: 18, prompt: 'I believe private credit is peaking, give me listed BDCs and credit funds trading at a discount to NAV above 10%.', wantUnverifiable: ['NAV'] },
  { n: 19, prompt: 'I want a barbell on AI: infrastructure now, applications later. Show me 5 picks for each side with market cap above 10bn.', want: [{ key: 'market_cap_usd', min: 1e10 }] },
  { n: 20, prompt: 'I think gold keeps working as a central bank reserve asset, compare physical gold ETCs and gold miner ETFs by cost, AUM and 12 month performance.' },
];

/** Themes, industries, geographies and asset classes must never be reported as
 * unverifiable: they are handled by the thesis and by §5.4, and listing them
 * would tell the user we ignored something we did not. */
const THEME_NOISE = /theme|barbell|device makers|tier 1|grid equipment|in europe|milan|japanese compan|treatment compan|producers and developers|etfs?$|bonds?$|companies$/i;

const extracted = new Map<number, FinReq>();

async function extractionTests() {
  log.step('Extraction: the 20 request fixtures');
  if (!process.env.OPENROUTER_API_KEY) {
    skip('extraction fixtures', 'OPENROUTER_API_KEY not set');
    return;
  }
  for (const c of CASES) {
    const r = await extractFinReq(c.prompt);
    extracted.set(c.n, r);
    const label = `[${String(c.n).padStart(2)}]`;
    for (const w of c.want ?? []) {
      const got = r.bounds.find((b) => b.key === w.key);
      if (!ok(`${label} bound ${w.key}`, !!got, `missing; got ${r.bounds.map((b) => b.key).join(',') || 'none'}`)) continue;
      if (w.min !== undefined) ok(`${label} ${w.key} min`, got!.min === w.min, `want ${w.min}, got ${got!.min}`);
      if (w.max !== undefined) ok(`${label} ${w.key} max`, got!.max === w.max, `want ${w.max}, got ${got!.max}`);
    }
    if (c.wantUnverifiable) {
      const joined = r.unverifiable.join(' | ').toLowerCase();
      ok(
        `${label} reports what it cannot check`,
        c.wantUnverifiable.some((u) => joined.includes(u.toLowerCase())),
        `want one of ${c.wantUnverifiable.join('/')}, got "${r.unverifiable.join(' | ')}"`,
      );
    }
    if (c.wantCountry) {
      ok(`${label} country exposure`, r.exposures.some((e) => e.kind === 'country' && e.name.toLowerCase().includes(c.wantCountry!.toLowerCase())), JSON.stringify(r.exposures));
    }
    if (c.wantCurrency) ok(`${label} currency`, r.currencies.includes(c.wantCurrency), JSON.stringify(r.currencies));
    if (c.wantDomicile) ok(`${label} domicile`, r.domiciles.includes(c.wantDomicile), JSON.stringify(r.domiciles));
    // No theme/industry/geography noise in the unverifiable list.
    const noisy = r.unverifiable.filter((u) => THEME_NOISE.test(u));
    ok(`${label} no theme noise in cannot-check`, noisy.length === 0, noisy.join(' | '));
    // Nuclear, copper, defense and gold are themes, not GICS sectors.
    ok(`${label} no invented sector exposure`, !r.exposures.some((e) => e.kind === 'sector'), JSON.stringify(r.exposures));
  }
}

// ---- 3. Live ---------------------------------------------------------------

/** Assets of the given kinds, as candidate pool material. */
async function poolIds(kinds: string[], limit = 900): Promise<number[]> {
  const { data, error } = await supabase
    .from('assets')
    .select('id')
    .eq('is_active', true)
    .in('kind', kinds)
    .order('market_cap_usd', { ascending: false, nullsFirst: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => r.id as number);
}

async function liveTests() {
  log.step('Live: requirements applied to the real universe');
  if (process.env.SYNTHETICK_OFFLINE === '1') {
    skip('live enforcement', 'offline mode (no database contact)');
    return;
  }
  const { error } = await supabase.from('asset_metrics').select('asset_id').limit(1);
  if (error) {
    skip('live enforcement', 'db/asset_metrics.sql not applied');
    return;
  }
  if (!extracted.size) {
    skip('live enforcement', 'extraction did not run');
    return;
  }

  for (const c of CASES) {
    const req = extracted.get(c.n);
    if (!req || !hasFinReq(req)) continue;
    const fundish = req.bounds.some((b) => SPECS[b.key]?.source === 'fund') || req.exposures.length > 0;
    const ids = await poolIds(fundish ? ['etf', 'bond'] : ['stock']);
    const factMap = await loadFacts(ids);
    const survivors = [...factMap.values()].filter((f) => checkAsset(req, f).pass);
    const label = `[${String(c.n).padStart(2)}] live`;

    // Independent re-verification: re-read each survivor's numbers straight
    // from the database and re-apply the bounds by hand, so a bug in
    // checkAsset cannot validate itself.
    let violations = 0;
    for (const s of survivors.slice(0, 40)) {
      const { data } = await supabase
        .from('assets')
        .select('currency, market_cap_usd, etf_portfolio, asset_metrics(*)')
        .eq('id', s.assetId)
        .maybeSingle();
      if (!data) continue;
      const m = ((data as Record<string, unknown>).asset_metrics ?? {}) as Record<string, number | null>;
      const pf = ((data as Record<string, unknown>).etf_portfolio ?? {}) as Record<string, unknown>;
      for (const b of req.bounds) {
        let v: number | null = null;
        if (b.key === 'aum_usd') v = Number(m.market_cap_usd ?? (data as Record<string, unknown>).market_cap_usd);
        else if (b.key === 'ter_pct') v = Number(pf.expense_ratio);
        else if (b.key === 'fund_avg_volume') v = Number(pf.avg_volume);
        else if (b.key === 'track_record_years') v = trackRecordYears(pf.inception_date as string) ?? Number.NaN;
        else if (b.key === 'holdings_count') v = Number(pf.holdings_count);
        else v = Number(m[b.key]);
        if (!Number.isFinite(v as number)) { violations++; continue; }
        if (b.min != null && (v as number) < b.min) violations++;
        if (b.max != null && (v as number) > b.max) violations++;
      }
      if (req.currencies.length && !req.currencies.includes(String((data as Record<string, unknown>).currency ?? '').toUpperCase())) violations++;
      if (req.domiciles.length && !req.domiciles.includes(String(pf.domicile ?? '').toUpperCase())) violations++;
    }
    ok(`${label} survivors satisfy every bound`, violations === 0, `${violations} violation(s) across ${Math.min(40, survivors.length)} checked`);
    log.info(
      `  ${label} ${finReqSummary(req).join('; ')} → ${survivors.length} of ${ids.length} ${fundish ? 'funds' : 'stocks'} qualify`,
    );
  }
}

async function main() {
  log.step('Financial-requirement gate (spec §15)');
  pureTests();
  await extractionTests();
  await liveTests();
  log.step(`${fail === 0 ? 'All checks passed' : `${fail} check(s) FAILED`} (${pass} passed${skipped ? `, ${skipped} skipped` : ''})`);
  if (failures.length) {
    log.error('FAILURES:');
    for (const f of failures) log.error('  - ' + f);
  }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  log.error(`gate crashed: ${(err as Error).message}`);
  process.exit(1);
});

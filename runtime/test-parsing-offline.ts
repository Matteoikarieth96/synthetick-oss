/**
 * Offline tests for the 2026-10 hardening of LLM-output parsing, the ingest
 * gates, FX sub-unit currencies and the sail-agent price reader. No network, no
 * keys, no DB: the LLM is an injected stub, `fetch` is replaced in-process, and
 * the Supabase client is built from placeholders and never called.
 *   npx tsx runtime/test-parsing-offline.ts
 */
export {}; // make this file a module (top-level await)

process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'placeholder';
process.env.VOYAGE_KEY ||= 'placeholder';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${name}${detail ? `: ${detail}` : ''}`);
}

const { parseViolations, verifyPicks } = await import('./audit.js');
const { parseAnalysis, fallbackAnalysis, explainPicksWithStatus } = await import('./analysis.js');
const { parseRawThesis } = await import('./thesis.js');
const { asStringArray, asText } = await import('./requirements.js');
const { symbolCountDropped, planCryptoDeactivation } = await import('../ingest/lib/gates.js');
const { resolveCurrency, FxTable } = await import('../ingest/lib/fx.js');
const { parseMultipliers, fetchVenuePrices } = await import('../sail-agent/src/prices.js');
type Pick = import('./select.js').Pick;
type Candidate = import('./candidates.js').Candidate;

const pick = (ticker: string, score = 80, why = 'direct exposure'): Pick =>
  ({ a: { ticker, name: `${ticker} Inc`, kind: 'crypto', id: 1 } as unknown as Candidate, score, why, rel: 'adjacent' }) as Pick;

// ---- coercion helpers --------------------------------------------------------
check('asStringArray: array of strings', JSON.stringify(asStringArray(['a', ' b ', ''])) === '["a","b"]');
check('asStringArray: bare string splits on commas', JSON.stringify(asStringArray('Apple, Microsoft; Tesla')) === '["Apple","Microsoft","Tesla"]');
check('asStringArray: array of objects uses name/ticker', JSON.stringify(asStringArray([{ name: 'Apple' }, { ticker: 'MSFT' }, { x: 1 }])) === '["Apple","MSFT"]');
check('asStringArray: null/number/object → []', asStringArray(null).length === 0 && asStringArray(5).length === 0 && asStringArray({}).length === 0);
check('asText: object → empty string', asText({ a: 1 }) === '' && asText(' x ') === 'x');

// ---- B4: audit --------------------------------------------------------------
check('parseViolations: normal shape', parseViolations('{"violations":[{"t":"ETH","c":"ticker","why":"excluded"}]}').length === 1);
check('parseViolations: bare array', parseViolations('[{"t":"ETH","c":"ticker"}]').length === 1);
check('parseViolations: violations as a string → none, no throw', parseViolations('{"violations":"none"}').length === 0);
check('parseViolations: violations null → none', parseViolations('{"violations":null}').length === 0);
check('parseViolations: single violation object', parseViolations('{"t":"ETH","c":"ticker","why":"x"}').length === 1);
check('parseViolations: bad items skipped, good kept', parseViolations('{"violations":[1,null,"x",{"t":"ARB","c":"cap"}]}').length === 1);
check('parseViolations: numeric ticker coerced to string', parseViolations('[{"t":123,"c":"cap"}]')[0]?.t === '123');
let threw = false;
try {
  parseViolations('I cannot comply with this request.');
} catch {
  threw = true;
}
check('parseViolations: prose throws (so the caller can retry)', threw);

const crit = { asset_set: ['crypto'], exclude_tickers: ['ETH'], constrained: true };
const picks = [pick('ETH'), pick('SOL')];
const good = await verifyPicks('only crypto', picks, 'only crypto, never ETH', crit, undefined, async () =>
  '{"violations":[{"t":"ETH","c":"ticker","why":"excluded ticker"}]}',
);
check('verifyPicks: valid answer still drops the violator', good.drop['ETH'] !== undefined && !good.unavailable, JSON.stringify(good));

let calls = 0;
const flaky = await verifyPicks('only crypto', picks, 'only crypto', crit, undefined, async () =>
  ++calls === 1 ? 'not json at all' : '{"violations":[]}',
);
check('verifyPicks: one malformed answer is retried', calls === 2 && !flaky.unavailable, `calls=${calls}`);

calls = 0;
const dead = await verifyPicks('only crypto', picks, 'only crypto', crit, undefined, async () => {
  calls++;
  return 'still not json';
});
check(
  'verifyPicks: two bad answers do not throw; audit reported unavailable, nothing dropped silently',
  calls === 2 && dead.unavailable !== undefined && Object.keys(dead.drop).length === 0,
  JSON.stringify(dead),
);
const down = await verifyPicks('only crypto', picks, 'only crypto', crit, undefined, async () => {
  throw new Error('OpenRouter 503');
});
check('verifyPicks: LLM transport failure does not throw, flagged unavailable', down.unavailable?.includes('503') === true, JSON.stringify(down));

// ---- B4: analysis ------------------------------------------------------------
const long = 'x'.repeat(80);
check('parseAnalysis: normal map', parseAnalysis(`{"ETH":"${long}"}`, [pick('ETH')])['ETH'] === long);
check('parseAnalysis: sentence array is joined', (parseAnalysis(`{"ETH":["${long}","${long}"]}`, [pick('ETH')])['ETH'] ?? '').length > 80);
check('parseAnalysis: wrapped in {"analysis":…}', parseAnalysis(`{"analysis":{"ETH":"${long}"}}`, [pick('ETH')])['ETH'] === long);
check('parseAnalysis: array/null answers → empty, no throw', Object.keys(parseAnalysis('[]', [pick('ETH')])).length === 0 && Object.keys(parseAnalysis('null', [pick('ETH')])).length === 0);
check('parseAnalysis: too-short line is omitted (existing behavior)', Object.keys(parseAnalysis('{"ETH":"ok"}', [pick('ETH')])).length === 0);
check('fallbackAnalysis: neutral line mentions score and says analysis was unavailable', /unavailable/.test(fallbackAnalysis([pick('ETH', 77)])['ETH'] ?? '') && /77\/100/.test(fallbackAnalysis([pick('ETH', 77)])['ETH'] ?? ''));

const okA = await explainPicksWithStatus('thesis', [pick('ETH')], null, 'long', async () => `{"ETH":"${long}"}`);
check('explainPicksWithStatus: good answer, not degraded', !okA.degraded && okA.analysis['ETH'] === long);
const badA = await explainPicksWithStatus('thesis', [pick('ETH'), pick('SOL')], null, 'long', async () => 'garbage');
check('explainPicksWithStatus: malformed answer degrades to template for every pick', badA.degraded && Object.keys(badA.analysis).length === 2, JSON.stringify(badA));
let aCalls = 0;
const retryA = await explainPicksWithStatus('thesis', [pick('ETH')], null, 'long', async () => (++aCalls === 1 ? 'garbage' : `{"ETH":"${long}"}`));
check('explainPicksWithStatus: second attempt can recover', !retryA.degraded && aCalls === 2);
const throwA = await explainPicksWithStatus('thesis', [pick('ETH')], null, 'long', async () => {
  throw new Error('boom');
});
check('explainPicksWithStatus: thrown LLM error degrades, never throws', throwA.degraded);

// ---- R11: thesis shape tolerance ----------------------------------------------
const t1 = parseRawThesis({
  title: 'T', summary: 'S', anchors: 'Apple, Tesla', themes: { not: 'an array' }, avoid: null,
  private_entities: 'xAI', strategies: [{ name: 'Gold' }, 'Bonds'],
  requirements: { asset_classes: 'etf', regions: ['eu'], caps: null, semantic: ['x'] },
});
check('parseRawThesis: string anchors become an array', JSON.stringify(t1.anchors) === '["Apple","Tesla"]');
check('parseRawThesis: object themes / null avoid become []', t1.themes.length === 0 && t1.avoid.length === 0);
check('parseRawThesis: private_entities string tolerated', t1.private_entities.length === 1 && t1.private_entities[0]!.name === 'xAI');
check('parseRawThesis: strategies objects flattened', JSON.stringify(t1.strategies) === '["Gold","Bonds"]');
check('parseRawThesis: requirements strings coerced', JSON.stringify(t1.requirements.asset_classes) === '["etf"]' && t1.requirements.semantic === '');
for (const bad of [null, undefined, 'text', 42, []]) {
  const t = parseRawThesis(bad);
  check(`parseRawThesis(${JSON.stringify(bad)}) gives the empty thesis`, t.anchors.length === 0 && t.summary === '' && t.requirements.regions.length === 0);
}

// ---- B5: symbol-count gate + crypto deactivation --------------------------------
check('gate: 5000 active → 3000 new fails', symbolCountDropped(5000, 3000));
check('gate: first run (prev 0) passes', !symbolCountDropped(0, 10));
check('gate: exactly 80% passes', !symbolCountDropped(1000, 800));
const active = Array.from({ length: 3000 }, (_, i) => `c${i}`);
const fetchedFull = [...active.slice(10), 'new1', 'new2', ...Array.from({ length: 8 }, (_, i) => `n${i}`)];
const plan = planCryptoDeactivation(active, fetchedFull, 3000);
check('deactivation: 10 coins fell out of a full run → exactly those 10', !plan.skip && plan.stale.length === 10 && plan.stale[0] === 'c0', JSON.stringify({ ...plan, stale: plan.stale.length }));
check('deactivation: partial run (1500/3000) is skipped', planCryptoDeactivation(active, active.slice(0, 1500), 3000).skip !== undefined);
const shuffled = Array.from({ length: 3000 }, (_, i) => `z${i}`);
check('deactivation: a run that would retire everything is skipped', planCryptoDeactivation(active, shuffled, 3000).skip !== undefined);
check('deactivation: nothing stale → empty plan', planCryptoDeactivation(active, active, 3000).stale.length === 0);

// ---- R10: pence / cents / agorot ----------------------------------------------------
check('resolveCurrency GBp → GBP/100', JSON.stringify(resolveCurrency('GBp')) === '{"base":"GBP","divisor":100}');
check('resolveCurrency GBX → GBP/100', resolveCurrency('GBX').divisor === 100 && resolveCurrency('GBX').base === 'GBP');
check('resolveCurrency GBP stays pounds', resolveCurrency('GBP').divisor === 1);
check('resolveCurrency ZAc and ZAC → ZAR/100', resolveCurrency('ZAc').base === 'ZAR' && resolveCurrency('ZAC').divisor === 100);
check('resolveCurrency ILA → ILS/100, ILS untouched', resolveCurrency('ILA').base === 'ILS' && resolveCurrency('ILA').divisor === 100 && resolveCurrency('ILS').divisor === 1);
check('resolveCurrency eur → EUR', resolveCurrency('eur').base === 'EUR');
const fx = new FxTable({ GBP: 1.25, ZAR: 0.05, ILS: 0.27, EUR: 1.1 });
check('toUsd: 10,000,000 GBp = £100,000 = $125,000', fx.toUsd(10_000_000, 'GBp') === 125_000);
check('toUsd: GBX same as GBp', fx.toUsd(10_000_000, 'GBX') === 125_000);
check('toUsd: 100 GBP stays pounds', fx.toUsd(100, 'GBP') === 125);
check('toUsd: ZAc cents', Math.abs((fx.toUsd(1000, 'ZAc') ?? 0) - 0.5) < 1e-9);
check('toUsd: ILA agorot', Math.abs((fx.toUsd(1000, 'ILA') ?? 0) - 2.7) < 1e-9);
check('toUsd: unknown currency is null', fx.toUsd(1, 'XYZ') === null);

// ---- B6: sail-agent fails closed ------------------------------------------------------
const m = parseMultipliers([
  { tokenSymbol: 'AAA', currentMultiplier: '2' },
  { tokenSymbol: 'BBB' },
  { tokenSymbol: 'CCC', currentMultiplier: 'abc' },
  { tokenSymbol: 'DDD', currentMultiplier: '0' },
  { tokenSymbol: 'EEE', currentMultiplier: '-1' },
  { currentMultiplier: '5' },
]);
check('parseMultipliers: valid value kept', m.get('AAA') === 2);
check('parseMultipliers: absent field on a listed token is UNKNOWN, not 1 (D8a, fail closed)', !m.has('BBB'));
check('parseMultipliers: malformed / zero / negative are UNKNOWN (omitted)', !m.has('CCC') && !m.has('DDD') && !m.has('EEE'));
check('parseMultipliers: {results:[…]} wrapper accepted', parseMultipliers({ results: [{ tokenSymbol: 'X', currentMultiplier: '3' }] }).get('X') === 3);
check('parseMultipliers: an empty string is unknown too', !parseMultipliers([{ tokenSymbol: 'Y', currentMultiplier: '' }]).has('Y'));
check('parseMultipliers: garbage → empty map', parseMultipliers(null).size === 0 && parseMultipliers('x').size === 0);

const realFetch = globalThis.fetch;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const quote = { quotes: [{ bid: '99', ask: '101', isTradingHalt: false }] };
const warn = console.warn;
console.warn = () => {}; // the module logs why it skips; keep test output clean
try {
  globalThis.fetch = (async (url: unknown) => {
    const u = String(url);
    if (u.endsWith('/assets')) return json([{ tokenSymbol: 'AAA', currentMultiplier: '2' }, { tokenSymbol: 'BBB' }]);
    return json(quote);
  }) as typeof fetch;
  const ok = await fetchVenuePrices(['AAA', 'BBB', 'ZZZ']);
  check('prices: multiplier applied (100 x 2)', ok.get('AAA')?.mid === 200);
  check('prices: listed token without a multiplier field is SKIPPED (was priced at x1)', !ok.has('BBB'));
  check('prices: symbol missing from /assets is SKIPPED (was priced at x1)', !ok.has('ZZZ'));

  globalThis.fetch = (async (url: unknown) => (String(url).endsWith('/assets') ? json({}, 503) : json(quote))) as typeof fetch;
  check('prices: /assets HTTP error → every symbol skipped', (await fetchVenuePrices(['AAA', 'BBB'])).size === 0);

  globalThis.fetch = (async (url: unknown) => {
    if (String(url).endsWith('/assets')) throw new Error('network down');
    return json(quote);
  }) as typeof fetch;
  check('prices: /assets network failure → every symbol skipped', (await fetchVenuePrices(['AAA'])).size === 0);

  globalThis.fetch = (async (url: unknown) =>
    String(url).endsWith('/assets') ? json([{ tokenSymbol: 'AAA', currentMultiplier: 'garbage' }]) : json(quote)) as typeof fetch;
  check('prices: malformed multiplier → symbol skipped', (await fetchVenuePrices(['AAA'])).size === 0);
} finally {
  globalThis.fetch = realFetch;
  console.warn = warn;
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);

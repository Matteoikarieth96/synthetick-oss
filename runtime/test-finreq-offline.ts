/**
 * Offline tests for runtime/finreq.ts (spec §15). No network, no keys, no DB.
 *   npx tsx runtime/test-finreq-offline.ts
 *
 * Covers the 2026-10 review fixes:
 *  - SQL NULL must never become 0 (Number(null) === 0 made missing metrics and
 *    missing market caps PASS numeric requirements);
 *  - forward_pe is no longer offered to the extractor (nothing ingests it); an
 *    ask for it is reported as unverifiable;
 *  - sector/country names match on whole words, not substrings.
 */
import { readFileSync } from 'node:fs';

// finreq.ts imports the Supabase client, whose env module requires these at
// import time. Placeholders only — nothing here ever opens a connection.
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'placeholder';
process.env.VOYAGE_KEY ||= 'placeholder';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${name}${detail ? `: ${detail}` : ''}`);
}

const { SPECS, toNum, rowsToFacts, factFor, checkAsset, normalizeRawFinReq, sameName, exposureWeight, EMPTY_FINREQ } =
  await import('./finreq.js');

// ---- B1: NULL is "cannot verify", never 0 ----------------------------------
check('toNum(null) is null', toNum(null) === null);
check('toNum(undefined) is null', toNum(undefined) === null);
check('toNum("") is null', toNum('') === null);
check('toNum("abc") is null', toNum('abc') === null);
check('toNum(0) stays 0 (a real zero)', toNum(0) === 0);
check('toNum("12.5") parses', toNum('12.5') === 12.5);

const facts = rowsToFacts(
  [
    { id: 1, kind: 'stock', currency: 'USD', market_cap_usd: null, etf_portfolio: null },
    { id: 2, kind: 'stock', currency: 'USD', market_cap_usd: 5e9, etf_portfolio: null },
    { id: 3, kind: 'stock', currency: 'USD', market_cap_usd: 5e8, etf_portfolio: null },
  ],
  [
    { asset_id: 1, net_debt_to_ebitda: null, fcf_per_share: null, pe: null, market_cap_usd: null },
    { asset_id: 2, net_debt_to_ebitda: 1.5, fcf_per_share: 0, pe: 11, market_cap_usd: 5e9 },
    // asset 3 has no asset_metrics row at all
  ],
);
const none = facts.get(1)!;
const real = facts.get(2)!;
const noRow = facts.get(3)!;
check('null metric maps to null, not 0', none.metrics.net_debt_to_ebitda === null, String(none.metrics.net_debt_to_ebitda));
check('null assets.market_cap_usd maps to null, not 0', none.marketCapUsd === null, String(none.marketCapUsd));
check('factFor(null metric) is null', factFor('net_debt_to_ebitda', none) === null);
check('factFor(market cap, all null) is null', factFor('market_cap_usd', none) === null);

const lowDebt = { ...EMPTY_FINREQ, bounds: [{ key: 'net_debt_to_ebitda', max: 3 }] };
const r1 = checkAsset(lowDebt, none);
check('missing net debt/EBITDA does NOT pass "below 3"', !r1.pass && r1.unchecked.includes('net_debt_to_ebitda'), JSON.stringify(r1));
const r2 = checkAsset(lowDebt, real);
check('real 1.5 passes "below 3" and is checkable', r2.pass && r2.unchecked.length === 0, JSON.stringify(r2));

const posFcf = { ...EMPTY_FINREQ, bounds: [{ key: 'fcf_per_share', min: 0 }] };
check('missing FCF does NOT pass "positive free cash flow"', !checkAsset(posFcf, none).pass);
check('a genuine 0 FCF still satisfies min 0', checkAsset(posFcf, real).pass);

const smallCap = { ...EMPTY_FINREQ, bounds: [{ key: 'market_cap_usd', max: 1e9 }] };
const rc = checkAsset(smallCap, none);
check('null market cap does NOT pass "market cap below 1bn"', !rc.pass && rc.unchecked.includes('market_cap_usd'), JSON.stringify(rc));
check('asset with no metrics row falls back to assets.market_cap_usd', checkAsset(smallCap, noRow).pass);

// ---- B2: forward_pe is not offered; asking for it is reported --------------
check('forward_pe is not in the extractor vocabulary', !('forward_pe' in SPECS));
const fwd = normalizeRawFinReq({ bounds: [{ key: 'forward_pe', max: 15 }, { key: 'pe', max: 12 }] });
check('forward_pe bound is not applied as a filter', fwd.bounds.length === 1 && fwd.bounds[0]!.key === 'pe', JSON.stringify(fwd.bounds));
check(
  'forward_pe ask is reported as unverifiable',
  fwd.unverifiable.some((u) => /forward pe/i.test(u) && u.includes('15')),
  JSON.stringify(fwd.unverifiable),
);
const nullMax = normalizeRawFinReq({ bounds: [{ key: 'aum_usd', min: 2e8, max: null }] });
check('"max": null stays null (not an upper bound of 0)', nullMax.bounds[0]?.max === null && nullMax.bounds[0]?.min === 2e8, JSON.stringify(nullMax.bounds));
const junk = normalizeRawFinReq({ bounds: 'oops' as unknown as never, currencies: 'EUR' as unknown as never, unverifiable: null as never });
check('malformed extractor shapes degrade to empty, no throw', junk.bounds.length === 0 && junk.currencies.length === 0 && junk.unverifiable.length === 0);
check('normalizeRawFinReq(null) is empty', normalizeRawFinReq(null).bounds.length === 0);

// Every metric key the extractor may emit must actually be ingested.
const runMetrics = readFileSync(new URL('../ingest/run-metrics.ts', import.meta.url), 'utf8');
const metricsSql = readFileSync(new URL('../db/asset_metrics.sql', import.meta.url), 'utf8');
const unwritten = Object.values(SPECS)
  .filter((s) => s.source === 'metrics')
  .map((s) => s.key)
  .filter((k) => !new RegExp(`\\b${k}\\b`).test(runMetrics) && !metricsSql.includes(`${k} = excluded.${k}`));
check('every offered metric key has an ingest writer', unwritten.length === 0, unwritten.join(', ') || 'all written');

// ---- R13: whole-word name matching ------------------------------------------
check('"oman" does not match "Romania"', !sameName('oman', 'Romania'));
check('"us" does not match "Austria"', !sameName('us', 'Austria'));
check('"us" does not match "Australia"', !sameName('us', 'Australia'));
check('"niger" does not match "Nigeria"', !sameName('niger', 'Nigeria'));
check('"india" matches "India"', sameName('India', 'india'));
check('"united states" matches "United States of America"', sameName('united states', 'United States of America'));
check('"korea" matches "South Korea"', sameName('korea', 'South Korea'));
check('empty name never matches', !sameName('', 'India'));

const fund = {
  assetId: 9, kind: 'etf', currency: 'USD', marketCapUsd: 1e9, metrics: {},
  portfolio: { region_weights: [{ name: 'Romania', weight: 40 }, { name: 'India', weight: 55 }, { name: 'Austria', weight: 5 }] },
} as unknown as Parameters<typeof exposureWeight>[1];
check('Oman exposure is 0, not Romania\'s 40', exposureWeight({ kind: 'country', name: 'Oman', minWeightPct: 10 }, fund) === 0);
check('India exposure sums only India', exposureWeight({ kind: 'country', name: 'India', minWeightPct: 10 }, fund) === 55);

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);

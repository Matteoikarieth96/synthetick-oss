/**
 * Fund geography: what a fund HOLDS, not where it is incorporated (spec §15.4).
 *
 * `assets.region` follows domicile (§4.1a), which is the right test for a
 * company and the wrong one for a fund. Every UCITS ETF is domiciled in
 * Ireland or Luxembourg, so a "Japanese equity ETF", an "India ETF" and a
 * "China exposure ETF" all carry region `eu` — and a region constraint
 * derived from the user's words then excludes exactly the funds they asked
 * for. That is how "UCITS ETFs tracking India" returned nothing while
 * NDIA.L, FLXI.DE and TIGR.MI sat in the table (live 2026-07-28).
 *
 * §6 already fixed this for one country by tagging Italy exposure at ingest.
 * This generalizes it: the fund's own country weightings (FMP
 * etf/country-weightings, present on 4,460 of 4,599 fund rows) are mapped
 * through the SAME region buckets as domiciles, so `eu` means the same thing
 * whichever side of the test an asset sits on.
 */
import { regionForCountry, type Region } from '../ingest/lib/regions.js';
import type { EtfPortfolio } from '../ingest/lib/supabase.js';

/**
 * Country NAME → ISO, for the names FMP actually uses in country weightings
 * (101 distinct values across our fund universe, measured 2026-07-28). Names
 * not listed here fall through to 'other', which is also where the vendor's
 * own "Other" bucket belongs.
 */
const NAME_TO_ISO: Record<string, string> = {
  'united states': 'US', 'usa': 'US', 'u.s.': 'US', 'puerto rico': 'US',
  'united kingdom': 'GB', 'great britain': 'GB', 'england': 'GB', 'jersey': 'GB', 'guernsey': 'GB', 'isle of man': 'GB',
  germany: 'DE', france: 'FR', netherlands: 'NL', belgium: 'BE', portugal: 'PT', spain: 'ES',
  italy: 'IT', austria: 'AT', ireland: 'IE', switzerland: 'CH', sweden: 'SE', denmark: 'DK',
  finland: 'FI', norway: 'NO', iceland: 'IS', luxembourg: 'LU', poland: 'PL', greece: 'GR',
  'czech republic': 'CZ', czechia: 'CZ', hungary: 'HU', romania: 'RO', estonia: 'EE', latvia: 'LV',
  lithuania: 'LT', slovakia: 'SK', slovenia: 'SI', croatia: 'HR', bulgaria: 'BG', cyprus: 'CY',
  malta: 'MT', monaco: 'FR', liechtenstein: 'CH', gibraltar: 'GB',
  china: 'CN', "china (people's republic of)": 'CN', 'hong kong': 'HK', macau: 'HK', macao: 'HK',
  japan: 'JP', 'south korea': 'KR', 'korea (the republic of)': 'KR', korea: 'KR',
  taiwan: 'TW', 'taiwan (province of china)': 'TW', india: 'IN', indonesia: 'ID', malaysia: 'MY',
  singapore: 'SG', thailand: 'TH', philippines: 'PH', vietnam: 'VN', 'viet nam': 'VN',
  australia: 'AU', 'new zealand': 'NZ', canada: 'CA', mexico: 'MX', brazil: 'BR', chile: 'CL',
  colombia: 'CO', peru: 'PE', argentina: 'AR', uruguay: 'UY', 'south africa': 'ZA',
  israel: 'IL', 'saudi arabia': 'SA', 'united arab emirates': 'AE', qatar: 'QA', kuwait: 'KW',
  turkey: 'TR', 'türkiye': 'TR', egypt: 'EG', nigeria: 'NG', kenya: 'KE', morocco: 'MA',
  russia: 'RU', 'russian federation': 'RU', kazakhstan: 'KZ', bermuda: 'BM', 'cayman islands': 'KY',
  'british virgin islands': 'VG', bahamas: 'BS', panama: 'PA', curacao: 'CW', 'curaçao': 'CW',
};

/** Region bucket for a country name as it appears in a fund's weightings. */
export function regionForCountryName(name: string | null | undefined): Region {
  const iso = NAME_TO_ISO[(name ?? '').trim().toLowerCase()];
  // Bermuda and the Caymans are incorporation havens for operating companies
  // listed elsewhere; the vendor's own "Other" bucket lands here too.
  return iso ? regionForCountry(iso) : 'other';
}

/**
 * Percentage of a fund invested in a region, or null when the fund has no
 * country breakdown at all. Null is "cannot verify", which is different from
 * zero and is treated as such by the caller (spec §15.4).
 */
export function fundRegionWeightPct(pf: EtfPortfolio | null | undefined, region: string): number | null {
  const slices = pf?.region_weights;
  if (!Array.isArray(slices) || !slices.length) return null;
  let total = 0;
  for (const s of slices) {
    const w = Number(s?.weight);
    if (!Number.isFinite(w)) continue;
    // 'it' is Italy specifically (§6), not the whole eu bucket.
    if (sliceInRegion(s?.name, region)) total += w;
  }
  return total;
}

/**
 * Majority rule: a fund "is" European when most of what it holds is European.
 * Deliberately the same 50% default the exposure requirements use, so the two
 * paths agree on what counts as tracking a place.
 */
export const FUND_REGION_MIN_PCT = 50;

/** Does one country slice fall in `region`? ('it' is Italy only, §6.) */
function sliceInRegion(name: string | null | undefined, region: string): boolean {
  return region === 'it' ? (name ?? '').trim().toLowerCase() === 'italy' : regionForCountryName(name) === region;
}

/**
 * Does this fund satisfy a region constraint, judged by holdings? The
 * majority rule applies to the ALLOWED SET as a whole: a fund 45% US and 45%
 * Europe satisfies "US or European" (90% of it is in scope), which a
 * per-region test rejected because neither region alone reached 50%. Each
 * slice counts once even when the set overlaps (Italy is inside eu).
 * Returns null when the fund has no breakdown to judge.
 */
export function fundMatchesRegions(
  pf: EtfPortfolio | null | undefined,
  regions: string[],
  minPct = FUND_REGION_MIN_PCT,
): boolean | null {
  if (!regions.length) return true;
  const slices = pf?.region_weights;
  if (!Array.isArray(slices) || !slices.length) return null;
  let total = 0;
  for (const s of slices) {
    const w = Number(s?.weight);
    if (!Number.isFinite(w)) continue;
    if (regions.some((r) => sliceInRegion(s?.name, r))) total += w;
  }
  return total >= minPct;
}

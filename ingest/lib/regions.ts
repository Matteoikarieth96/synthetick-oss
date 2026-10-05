/** Region mapping (spec §4.1 step 4, §4.1a). region follows DOMICILE, not venue. */
export type Region = 'us' | 'eu' | 'cn' | 'other' | 'global';

// Vendor exchange code → ISO country of that exchange (for canonical/home
// pick). Mixes FMP short names and retired-EODHD list codes — no collisions,
// and the legacy codes stay so inactive legacy rows keep resolving.
export const EXCHANGE_COUNTRY: Record<string, string> = {
  US: 'US', NYSE: 'US', NASDAQ: 'US', AMEX: 'US', BATS: 'US',
  LSE: 'GB', IL: 'GB', IOB: 'GB',
  XETRA: 'DE', F: 'DE', FSX: 'DE', STU: 'DE', MU: 'DE', MUN: 'DE', BE: 'DE', BER: 'DE', HM: 'DE', HAM: 'DE', HA: 'DE', DU: 'DE', DUS: 'DE',
  PA: 'FR', PAR: 'FR', AS: 'NL', AMS: 'NL', BR: 'BE', BRU: 'BE', LS: 'PT', LIS: 'PT',
  MC: 'ES', BME: 'ES', MI: 'IT', MIL: 'IT', VI: 'AT', VIE: 'AT', IR: 'IE', DUB: 'IE',
  SW: 'CH', VX: 'CH', SIX: 'CH',
  ST: 'SE', STO: 'SE', CO: 'DK', CPH: 'DK', HE: 'FI', HEL: 'FI', OL: 'NO', OSL: 'NO', IC: 'IS',
  LU: 'LU', WAR: 'PL', WSE: 'PL', AT: 'GR', ATH: 'GR', PR: 'CZ', PRA: 'CZ', BUD: 'HU',
  HK: 'HK', HKSE: 'HK', SHG: 'CN', SHH: 'CN', SHE: 'CN', SHZ: 'CN',
};

/** Exchange codes that count as a US listing for the canonical-pick fallback. */
export const US_EXCHANGES = new Set(['US', 'NYSE', 'NASDAQ', 'AMEX', 'BATS']);

// ISO country → region bucket.
const EU_COUNTRIES = new Set([
  'GB', 'DE', 'FR', 'NL', 'BE', 'PT', 'ES', 'IT', 'AT', 'IE', 'CH', 'SE', 'DK',
  'FI', 'NO', 'IS', 'LU', 'PL', 'GR', 'CZ', 'HU', 'RO', 'EE', 'LV', 'LT', 'SK',
  'SI', 'HR', 'BG', 'CY', 'MT',
]);
const CN_COUNTRIES = new Set(['CN', 'HK']);
const US_COUNTRIES = new Set(['US']);

/** Map a domicile ISO country to a region bucket. */
export function regionForCountry(countryIso: string | null | undefined): Region {
  if (!countryIso) return 'other';
  const c = countryIso.toUpperCase();
  if (US_COUNTRIES.has(c)) return 'us';
  if (EU_COUNTRIES.has(c)) return 'eu';
  if (CN_COUNTRIES.has(c)) return 'cn';
  return 'other';
}

/** First two chars of an ISIN encode the issuing country. */
export function isinCountry(isin: string | null | undefined): string | null {
  if (!isin || isin.length < 2) return null;
  return isin.slice(0, 2).toUpperCase();
}

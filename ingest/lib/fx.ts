import { env } from './env.js';
import { fetchJson } from './http.js';
import { fmpLimiter } from './ratelimit.js';
import { log } from './log.js';

/**
 * FX table: currency code → USD multiplier (1 unit of currency = N USD).
 *
 * Primary source is the ECB via frankfurter.dev (§4.1c, 2026-08-03): keyless,
 * free, and needs no vendor key (forex quotes are a paid feature on FMP). One
 * call returns every ECB-published rate as USD→CUR, inverted here. Anything the
 * ECB doesn't publish (e.g. TWD) falls back to FMP forex quotes when an FMP key
 * is set and the plan includes them. Sub-unit quote
 * currencies (pence, cents, agorot) are resolved by `resolveCurrency` and
 * converted as base/100 at conversion time. Refreshed each ingest run.
 */

/**
 * Vendor currency code → ISO base currency + divisor. Vendors quote some
 * exchanges in a SUB-UNIT: London in pence ("GBp" at FMP, "GBX" elsewhere),
 * Johannesburg in cents ("ZAc"/"ZAC"), Tel Aviv in agorot ("ILA"/"ILa"). The
 * sub-unit and the main unit differ only by letter case ("GBp" vs "GBP"), so
 * this MUST look at the code before it is upper-cased: upper-casing first
 * turned every "GBp" market cap into pounds, a 100x overstatement that put LSE
 * stocks in the wrong cap_class. Unknown or ordinary codes pass through
 * upper-cased with divisor 1. Exported for offline tests.
 */
export function resolveCurrency(code: string): { base: string; divisor: number } {
  const c = code.trim();
  switch (c) {
    case 'GBp':
    case 'GBX':
    case 'GBx':
      return { base: 'GBP', divisor: 100 };
    case 'ZAc':
    case 'ZAC':
    case 'ZAX':
      return { base: 'ZAR', divisor: 100 };
    case 'ILA':
    case 'ILa':
      return { base: 'ILS', divisor: 100 };
    default:
      return { base: c.toUpperCase(), divisor: 1 };
  }
}

export class FxTable {
  private rates = new Map<string, number>([['USD', 1]]);

  /** Optional seed rates (currency → USD per unit); used by offline tests. */
  constructor(initial?: Record<string, number>) {
    for (const [cur, rate] of Object.entries(initial ?? {})) this.rates.set(cur.toUpperCase(), rate);
  }

  /** Fetch USD rates for the given currencies. */
  async load(currencies: string[]): Promise<void> {
    // Sub-unit codes load their BASE currency's rate (GBp → GBP).
    const wanted = [...new Set(currencies.map((c) => resolveCurrency(c).base))].filter((c) => c !== 'USD');
    if (wanted.length === 0) {
      log.info('FX table loaded: USD');
      return;
    }
    try {
      // All published rates in one call; passing unknown symbols would 404
      // the whole request, so filter locally instead.
      const ecb = await fetchJson<{ rates?: Record<string, number> }>(
        'https://api.frankfurter.dev/v1/latest?base=USD',
        { label: 'fx ecb', retries: 2 },
      );
      for (const cur of wanted) {
        const usdToCur = ecb?.rates?.[cur];
        if (usdToCur && usdToCur > 0) this.rates.set(cur, 1 / usdToCur);
      }
    } catch (err) {
      log.warn(`FX ECB fetch failed: ${(err as Error).message}`);
    }
    const missing = wanted.filter((c) => !this.rates.has(c));
    if (missing.length) await this.loadFromFmp(missing);
    for (const cur of wanted) {
      if (!this.rates.has(cur)) log.warn(`no FX rate for ${cur}; caps in ${cur} will be dropped`);
    }
    log.info(`FX table loaded: ${[...this.rates.keys()].join(', ')}`);
  }

  /** FMP fallback for non-ECB currencies — best-effort, needs a working key. */
  private async loadFromFmp(missing: string[]): Promise<void> {
    const key = env.FMP_KEY;
    if (!key) {
      log.warn(`no FMP key for FX fallback (${missing.join(', ')})`);
      return;
    }
    try {
      await fmpLimiter.wait();
      // batch-quote silently drops pairs FMP doesn't quote — the inverse
      // fallback below picks those up.
      const direct = await fetchJson<{ symbol: string; price?: number }[]>(
        `https://financialmodelingprep.com/stable/batch-quote?symbols=${missing
          .map((c) => `${c}USD`)
          .join(',')}&apikey=${key}`,
        { label: 'fx batch', retries: 2 },
      );
      for (const q of direct ?? []) {
        const cur = q.symbol.replace(/USD$/, '');
        if (missing.includes(cur) && q.price && q.price > 0) this.rates.set(cur, q.price);
      }
    } catch (err) {
      log.warn(`FX batch fetch failed: ${(err as Error).message}`);
    }
    for (const cur of missing) {
      if (this.rates.has(cur)) continue;
      try {
        await fmpLimiter.wait();
        const inv = await fetchJson<{ price?: number }[]>(
          `https://financialmodelingprep.com/stable/quote?symbol=USD${cur}&apikey=${key}`,
          { label: `fx USD${cur}`, retries: 2 },
        );
        const p = inv?.[0]?.price;
        if (p && p > 0) this.rates.set(cur, 1 / p);
      } catch (err) {
        log.warn(`FX fetch failed for ${cur}: ${(err as Error).message}`);
      }
    }
  }

  /** Convert an amount in `currency` to USD. Returns null if rate unknown. */
  toUsd(amount: number | null | undefined, currency: string | null | undefined): number | null {
    if (amount == null || !Number.isFinite(amount)) return null;
    if (!currency) return null;
    const { base, divisor } = resolveCurrency(currency);
    const rate = this.rates.get(base);
    return rate != null ? (amount / divisor) * rate : null;
  }
}

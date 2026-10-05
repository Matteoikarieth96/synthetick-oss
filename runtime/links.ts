/**
 * Deterministic outbound links for an asset card (spec §5.6b).
 *
 *  - platform: a public page carrying full financial info — CoinGecko for
 *    crypto, Yahoo Finance for equities/ETFs. Built from ids we already store,
 *    so it costs nothing and never lags behind a re-crawl.
 *  - website: the project's / company's own site, captured at ingest into
 *    assets.website_url (CoinGecko homepage[0] / FMP profile website).
 *
 * Both are best-effort: return null when a reliable URL can't be built rather
 * than guessing one that 404s.
 */

export interface AssetLink {
  url: string;
  label: string;
}
export interface AssetLinks {
  website: string | null;
  platform: AssetLink | null;
}

export interface LinkableAsset {
  kind: string;
  vendor_id?: string | null; // fmp: Yahoo-style symbol verbatim; crypto: CoinGecko slug
  ticker: string;
  website_url?: string | null;
  source?: string | null;
}

const clean = (s: unknown) => String(s ?? '').trim();

/** An http(s) URL with a real host, or null: never a javascript:, data: or
 * other scheme. Shared by the run's card links and the universe payload. */
export function normWebsite(raw: unknown): string | null {
  const s = clean(raw);
  if (!s) return null;
  const withProto = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  try {
    const u = new URL(withProto);
    return /^https?:$/.test(u.protocol) && u.hostname.includes('.') ? u.href : null;
  } catch {
    return null;
  }
}

export function assetLinks(a: LinkableAsset): AssetLinks {
  const website = normWebsite(a.website_url);
  const vid = clean(a.vendor_id);
  let platform: AssetLink | null = null;

  if (a.kind === 'private') {
    // Sacra's public company page — vendor_id is the company domain, and the
    // page slug matches our ticker (the Sacra slug, stored uppercased).
    const slug = clean(a.ticker).toLowerCase();
    if (slug) platform = { url: `https://sacra.com/c/${encodeURIComponent(slug)}/`, label: 'Sacra' };
  } else if (a.kind === 'crypto') {
    if (vid) platform = { url: `https://www.coingecko.com/en/coins/${encodeURIComponent(vid)}`, label: 'CoinGecko' };
  } else if (a.kind === 'stock' || a.kind === 'etf') {
    // FMP symbols ARE Yahoo symbols (US bare, ENI.MI, 0700.HK) — use verbatim;
    // a missing vendor_id falls back to a Yahoo lookup so a link never
    // resolves to a wrong quote.
    platform = vid
      ? { url: `https://finance.yahoo.com/quote/${encodeURIComponent(vid)}`, label: 'Yahoo Finance' }
      : { url: `https://finance.yahoo.com/lookup?s=${encodeURIComponent(a.ticker)}`, label: 'Yahoo Finance' };
  }
  // bonds: no reliable public quote page → platform stays null

  return { website, platform };
}

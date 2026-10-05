'use client';

// Universe explorer (spec §16.1): every tokenized asset on Robinhood Chain
// with its live venue quote, 30 day trend and nightly fundamentals, straight
// from GET /v1/universe/robinhood/assets. The endpoint requires an API key
// for programmatic use, but same-origin browser fetches pass keyless (spec
// §16.1 Auth, 2026-07-31), so this page works signed out; a session token is
// still sent when present, harmlessly. What the payload carries follows the
// server's data display policy (runtime/display-policy.ts); `market_note`
// says what is held back.
import Script from 'next/script';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

interface Quote {
  bid: number | null;
  ask: number | null;
  dailyHigh: number | null;
  dailyLow: number | null;
  underlyingVolume: number | null;
  mintBurnUsd: number | null;
  halted: boolean;
  /** Shares per token from the venue; null when it does not report one (never 1 by default). */
  multiplier: number | null;
  pendingMultiplier: number | null;
  pendingMultiplierEffectiveAt: string | null;
  generatedAt: string | null;
}

interface CorpEvent {
  id: string;
  type: string;
  status: string;
  processDate: string | null;
  details: Record<string, unknown> | null;
}

interface Dex {
  priceUsd: number | null;
  tvlUsd: number | null;
  volume24hUsd: number | null;
  premiumPct: number | null;
}

interface EtfPortfolio {
  top_holdings?: { symbol?: string | null; name: string; weight: number | null }[];
  sector_weights?: { name: string; weight: number | null }[];
}

interface Onchain {
  uiMultiplier: number | null;
  oraclePaused: boolean | null;
  pendingMultiplier: number | null;
  pendingEffectiveAt: string | null;
  totalSupply: number | null;
  oracle: { priceUsd: number | null; updatedAt: string | null; heartbeatSec: number | null; stale: boolean | null } | null;
}

interface DataAsOf {
  quotes: string | null;
  dex: string | null;
  onchain: string | null;
  oracle: string | null;
  events: string | null;
}

interface UniverseAsset {
  ticker: string;
  name: string;
  kind: string;
  region: string | null;
  sector: string | null;
  about: string | null;
  website: string | null;
  logo: string | null;
  contract: { address: string; chainId: number; decimals: number; explorer: string };
  holders: number | null;
  marketCapUsd: number | null;
  metrics: Record<string, number | string | null> | null;
  asOf: string | null;
  quote: Quote | null;
  dex: Dex | null;
  onchain: Onchain | null;
  events: CorpEvent[] | null;
  spark30d: { from: string; dates?: string[]; closes: number[] } | null;
  portfolio: EtfPortfolio | null;
}

type Gate = 'loading' | 'signedOut' | 'error' | 'ready';
type SortKey = 'mcap' | 'onmcap' | 'unipx' | 'offpx' | 'mult' | 'dexvol' | 'tvl' | 'supply' | 'holders' | 'type' | 'region' | 'ticker';

/** Shares per token: the venue's figure, else the token contract's own; null
 * when neither is known (rendered as a dash, never assumed to be 1). */
const sharesPerToken = (a: UniverseAsset): number | null => a.quote?.multiplier ?? a.onchain?.uiMultiplier ?? null;

/** Venue mid scaled to PER TOKEN, the same unit as the DEX and oracle prices. */
const tokenPrice = (a: UniverseAsset): number | null => {
  const mid = a.quote && a.quote.bid != null && a.quote.ask != null ? (a.quote.bid + a.quote.ask) / 2 : (a.quote?.bid ?? a.quote?.ask ?? null);
  const mult = sharesPerToken(a);
  return mid != null && mult != null ? mid * mult : null;
};

const uniswapBuyUrl = (address: string) => 'https://app.uniswap.org/swap?chain=robinhood&outputCurrency=' + address;

/** Row and card logo: the payload's own logo (the display policy drops vendor
 * CDN logos), else the company site's favicon, the same fallback the result
 * cards use (assetLogo in public/signal-desk.js). */
const assetLogo = (a: UniverseAsset): string | null => {
  if (a.logo) return a.logo;
  if (!a.website) return null;
  try {
    // Without www.: Google indexes many sites at 64px or more only on the bare host.
    const host = new URL(a.website).hostname.replace(/^www\./, '');
    return 'https://www.google.com/s2/favicons?sz=128&domain=' + encodeURIComponent(host);
  } catch {
    return null;
  }
};

/** Onchain market cap: token supply times token price (DEX price first, the
 * venue per-token value as fallback) — the tokens, not the equities. */
const onchainMcap = (a: UniverseAsset): number | null => {
  const px = a.dex?.priceUsd ?? tokenPrice(a);
  return a.onchain?.totalSupply != null && px != null ? a.onchain.totalSupply * px : null;
};

// window.sdAuth/sdAuthReady are declared globally by app/admin/page.tsx; the
// bootstrap script is the same /sd-auth.js.

const DASH = String.fromCharCode(8212); // data placeholder, matches the app's card style

async function sdReady() {
  for (let i = 0; i < 100 && !window.sdAuthReady; i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  await (window.sdAuthReady ?? Promise.resolve());
}

const fmtBig = (v: number | null | undefined) => {
  if (v == null) return DASH;
  const abs = Math.abs(v);
  if (abs >= 1e12) return '$' + (v / 1e12).toFixed(2) + 'T';
  if (abs >= 1e9) return '$' + (v / 1e9).toFixed(1) + 'B';
  if (abs >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
  if (abs >= 1e3) return '$' + (v / 1e3).toFixed(0) + 'K';
  return '$' + v.toFixed(0);
};

const fmtTime = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString() : DASH);

/** Token counts: like fmtBig but a quantity, not a dollar amount. */
const fmtCount = (v: number | null | undefined) => {
  if (v == null) return DASH;
  const abs = Math.abs(v);
  if (abs >= 1e9) return (v / 1e9).toFixed(1) + 'B';
  if (abs >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (abs >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return v.toFixed(0);
};
const fmtPct = (v: number | null | undefined) =>
  v == null ? DASH : (v > 0 ? '+' : '') + v.toFixed(1) + '%';
const pctClass = (v: number | null | undefined) => (v == null ? '' : v >= 0 ? 'uv-up' : 'uv-down');
const metricNum = (a: UniverseAsset, key: string): number | null => {
  const v = a.metrics?.[key];
  return typeof v === 'number' ? v : null;
};
const midPrice = (q: Quote | null) => (q && q.bid != null && q.ask != null ? (q.bid + q.ask) / 2 : (q?.bid ?? q?.ask ?? null));
/** Analyst upside vs the LIVE venue mid; falls back to the nightly figure. */
const upsidePct = (a: UniverseAsset): number | null => {
  const nightly = metricNum(a, 'target_upside_pct');
  const target = metricNum(a, 'price_target_avg');
  const price = midPrice(a.quote);
  if (target != null && price != null && price > 0) return ((target - price) / price) * 100;
  return nightly;
};

/**
 * Card price chart: the underlying value only — offchain daily share closes
 * times the current multiplier, teal. The onchain Uniswap line was removed
 * 2026-07-30 (user decision); the /chart endpoint stays for API users.
 * Fixed-aspect SVG (no preserveAspectRatio=none), so nothing stretches or
 * distorts.
 */
function PriceChart({
  offchain,
  multiplier,
}: {
  offchain: { from: string; dates?: string[]; closes: number[] } | null;
  /** Null = shares per token unknown: the per-token value cannot be drawn. */
  multiplier: number | null;
}) {
  if (multiplier == null) return <div className="uv-chart uv-dim">{DASH}</div>;
  const day = 86_400_000;
  // Older payloads had no per-point dates; approximate by counting back from
  // the first date so the x axis still runs on time.
  const offDates =
    offchain && offchain.closes.length >= 2
      ? (offchain.dates?.map((d) => Date.parse(d)) ??
        offchain.closes.map((_, i) => Date.parse(offchain.from) + i * day))
      : [];
  const series: [number, number][] =
    offchain && offchain.closes.length >= 2 ? offchain.closes.map((c, i) => [offDates[i]!, c * multiplier]) : [];
  if (!series.length) return <div className="uv-chart uv-dim">No price history yet</div>;

  const ts = series.map(([t]) => t);
  const vs = series.map(([, v]) => v);
  const t0 = Math.min(...ts);
  const t1 = Math.max(...ts);
  const vMin = Math.min(...vs);
  const vMax = Math.max(...vs);
  const W = 640;
  const H = 180;
  const padX = 10;
  const padTop = 26;
  const padBottom = 22;
  const x = (t: number) => padX + (t1 === t0 ? 0.5 : (t - t0) / (t1 - t0)) * (W - 2 * padX);
  const y = (v: number) => padTop + (1 - (v - vMin) / (vMax - vMin || 1)) * (H - padTop - padBottom);
  const path = series.map(([t, v]) => `${x(t).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const last = vs[vs.length - 1]!;
  return (
    <div className="uv-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Underlying value, daily">
        <text x={padX} y={15} className="uv-chart-label" fill="var(--offchain)">
          Underlying value (offchain)
        </text>
        <text x={W - padX} y={15} textAnchor="end" className="uv-chart-label">
          {'$' + last.toFixed(2)}
        </text>
        <polyline points={path} fill="none" stroke="var(--offchain)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        <text x={padX} y={H - 6} className="uv-chart-label">{new Date(t0).toISOString().slice(0, 10)}</text>
        <text x={W - padX} y={H - 6} textAnchor="end" className="uv-chart-label">{new Date(t1).toISOString().slice(0, 10)}</text>
      </svg>
    </div>
  );
}

/** Neutral stacked-token glyph. The page names the venue in text only and
 * carries a non-association disclaimer; no third-party logo artwork is bundled. */
function VenueGlyph() {
  return (
    <svg className="uv-feather" width="26" height="30" viewBox="0 0 26 30" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <path d="M13 2 24 8v14l-11 6L2 22V8z" />
      <path d="M13 2v26M2 8l11 6 11-6" />
    </svg>
  );
}

/** Generic swap glyph for the "buy" links (replaces the Uniswap logo). */
function SwapGlyph({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 8h14M14 4l4 4-4 4M20 16H6M10 12l-4 4 4 4" />
    </svg>
  );
}

function ContractIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="4" y="2" width="16" height="20" rx="2" />
      <path d="M8 7h8M8 11h8M8 15h5" />
    </svg>
  );
}

function GlobeIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h20M12 2c2.7 2.9 4 6.4 4 10s-1.3 7.1-4 10c-2.7-2.9-4-6.4-4-10s1.3-7.1 4-10z" />
    </svg>
  );
}

// Shares-per-token with float noise trimmed: 4 -> "4", 1.0022109... -> "1.002211".
const fmtMult = (m: number) => {
  const s = m.toFixed(6);
  return s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
};

const EVENT_LABELS: Record<string, string> = {
  CASH_DIVIDEND: 'Cash dividend',
  STOCK_DIVIDEND: 'Stock dividend',
  FORWARD_SPLIT: 'Forward split',
  REVERSE_SPLIT: 'Reverse split',
  UNIT_SPLIT: 'Unit split',
  NAME_CHANGE: 'Name change',
  SPIN_OFF: 'Spin-off',
  CASH_MERGER: 'Cash merger',
  STOCK_MERGER: 'Stock merger',
  STOCK_AND_CASH_MERGER: 'Stock and cash merger',
  REDEMPTION: 'Redemption',
  RIGHTS_DISTRIBUTION: 'Rights distribution',
  WORTHLESS_REMOVAL: 'Removal',
};

function eventDetail(e: CorpEvent): string {
  const d = (e.details ?? {}) as Record<string, string | undefined>;
  switch (e.type) {
    case 'CASH_DIVIDEND':
      return d.rate ? '$' + d.rate + ' per share' : '';
    case 'STOCK_DIVIDEND':
      return d.rate ? d.rate + ' shares per share' : '';
    case 'FORWARD_SPLIT':
    case 'REVERSE_SPLIT':
      return d.newRate && d.oldRate ? d.newRate + ' for ' + d.oldRate : '';
    case 'NAME_CHANGE':
      return d.oldUnderlyingSymbol && d.newUnderlyingSymbol && d.oldUnderlyingSymbol !== d.newUnderlyingSymbol
        ? d.oldUnderlyingSymbol + ' to ' + d.newUnderlyingSymbol
        : '';
    default:
      return '';
  }
}

function shortAddr(a: string) {
  return a.slice(0, 6) + String.fromCharCode(8230) + a.slice(-4);
}

export default function UniversePage() {
  const [gate, setGate] = useState<Gate>('loading');
  const [assets, setAssets] = useState<UniverseAsset[]>([]);
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<'all' | 'stock' | 'etf'>('all');
  const [sort, setSort] = useState<SortKey>('mcap');
  const [desc, setDesc] = useState(true);
  const [copied, setCopied] = useState('');
  const [sel, setSel] = useState<UniverseAsset | null>(null);
  const [asOf, setAsOf] = useState<DataAsOf | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  // What the server's display policy holds back on this site (null = nothing).
  const [policyNote, setPolicyNote] = useState<string | null>(null);
  // Time of the last good load while the latest poll failed (null = fresh).
  const [staleSince, setStaleSince] = useState<number | null>(null);
  const lastGoodAt = useRef<number | null>(null);

  const load = useCallback(async () => {
    // A failed poll keeps the table it already shows, with a small stale note
    // (e2e R7); only a first load with nothing to show yet reports the error.
    const fail = (signedOut = false) => {
      if (lastGoodAt.current != null) setStaleSince(lastGoodAt.current);
      else setGate(signedOut ? 'signedOut' : 'error');
    };
    await sdReady();
    const t = await window.sdAuth?.token();
    const headers: Record<string, string> = {};
    if (t) headers.authorization = 'Bearer ' + t;
    let body: { assets: UniverseAsset[]; asOf?: DataAsOf; market_note?: string | null };
    try {
      // The endpoint allows 5min HTTP caching for API users; the page polls
      // every 60s itself, so stale cache hits would defeat the live quotes.
      const res = await fetch('/v1/universe/robinhood/assets', { headers, cache: 'no-store' });
      if (res.status === 401) return fail(true);
      if (!res.ok) return fail();
      body = (await res.json()) as typeof body;
      if (!Array.isArray(body?.assets)) return fail();
    } catch {
      return fail();
    }
    setAssets(body.assets);
    setAsOf(body.asOf ?? null);
    setPolicyNote(body.market_note ?? null);
    lastGoodAt.current = Date.now();
    setStaleSince(null);
    setGate('ready');
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 60_000);
    return () => clearInterval(timer);
  }, [load]);

  // Equity market cap withheld by the display policy (or null on every row):
  // that column would be all dashes, so it is hidden and the token market cap
  // is the default sort, leaving one "Mkt cap" header (e2e P2-2).
  const capWithheld = policyNote != null || (assets.length > 0 && assets.every((a) => a.marketCapUsd == null));
  const sortKey: SortKey = sort === 'mcap' && capWithheld ? 'onmcap' : sort;

  const sortVal = useCallback((a: UniverseAsset): number | string => {
    switch (sortKey) {
      case 'ticker': return a.ticker;
      case 'mcap': return a.marketCapUsd ?? -1;
      case 'onmcap': return onchainMcap(a) ?? -1;
      case 'unipx': return a.dex?.priceUsd ?? -1;
      case 'offpx': return tokenPrice(a) ?? -1;
      case 'mult': return a.onchain?.uiMultiplier ?? -1;
      case 'dexvol': return a.dex?.volume24hUsd ?? -1;
      case 'tvl': return a.dex?.tvlUsd ?? -1;
      case 'supply': return a.onchain?.totalSupply ?? -1;
      case 'holders': return a.holders ?? -1;
      case 'type': return a.kind;
      case 'region': return a.region ?? '';
    }
  }, [sortKey]);

  const view = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const filtered = assets.filter(
      (a) =>
        (kind === 'all' || a.kind === kind || (kind === 'etf' && a.kind === 'bond')) &&
        (!needle || a.ticker.toLowerCase().includes(needle) || a.name.toLowerCase().includes(needle)),
    );
    return filtered.sort((x, y) => {
      const a = sortVal(x);
      const b = sortVal(y);
      const cmp = typeof a === 'string' || typeof b === 'string' ? String(a).localeCompare(String(b)) : a - b;
      return desc ? -cmp : cmp;
    });
  }, [assets, q, kind, sortVal, desc]);

  // Universe-wide onchain totals for the stat tiles: whole registry, not the
  // filtered view. Token mkt cap = supply times TOKEN price (DEX first, venue
  // per-token value as fallback), so it measures the tokens, not the equities.
  const totals = useMemo(() => {
    let tvl = 0;
    let mcap = 0;
    let vol = 0;
    for (const a of assets) {
      if (a.dex?.tvlUsd != null) tvl += a.dex.tvlUsd;
      if (a.dex?.volume24hUsd != null) vol += a.dex.volume24hUsd;
      mcap += onchainMcap(a) ?? 0;
    }
    return { tvl, mcap, vol };
  }, [assets]);

  const setSortKey = (k: SortKey) => {
    if (sortKey === k) setDesc(!desc);
    else {
      setSort(k);
      setDesc(k !== 'ticker' && k !== 'type' && k !== 'region');
    }
  };
  const copy = async (addr: string) => {
    try {
      await navigator.clipboard.writeText(addr);
      setCopied(addr);
      setTimeout(() => setCopied(''), 1200);
    } catch {
      /* clipboard denied: the full address is still on the explorer link */
    }
  };

  const th = (label: string, k: SortKey, cat: 'on' | 'off' | null = null, right = true) => (
    <th
      className={[right ? 'uv-num' : '', cat === 'on' ? 'uv-th-on' : cat === 'off' ? 'uv-th-off' : ''].join(' ').trim() || undefined}
      onClick={() => setSortKey(k)}
      role="button"
      title={cat === 'on' ? 'Onchain data' : cat === 'off' ? 'Offchain data' : undefined}
    >
      {label}
      {sortKey === k ? <span className="uv-arrow">{desc ? ' ▾' : ' ▴'}</span> : null}
    </th>
  );

  return (
    <main className="uv-wrap">
      <nav className="uv-nav" aria-label="Site">
        <a className="uv-back" href="/">
          ← Back to SyntheTick
        </a>
      </nav>
      <header className="uv-head">
        <div className="uv-title">
          <VenueGlyph />
          <div>
            <h1>Robinhood Chain RWA Universe</h1>
            <p className="uv-sub">
              {assets.length || 96} tokenized stocks and ETFs on chain 4663, with live venue quotes, onchain data
              and, where data licences allow it,{' '}
              <a className="uv-link" href="https://synthetick.org" target="_blank" rel="noreferrer">
                SyntheTick
              </a>{' '}
              fundamentals. The registry, venue and onchain data on this page are also available for free through
              the{' '}
              <a className="uv-link" href="/#api">
                SyntheTick API
              </a>
              .<span className="uv-dim"> An independent SyntheTick page, not associated with Robinhood (RHDA, LLC).</span>
            </p>
          </div>
        </div>
      </header>

      <aside className="uv-explain" role="note">
        <span className="uv-explain-icon" aria-hidden>
          i
        </span>
        <div className="uv-explain-body">
          <h2>How stock tokens work</h2>
          <p className="uv-explain-intro">
            Stock tokens are ERC-20 tokens minted and burned by Robinhood, implementing{' '}
            <a className="uv-link" href="https://eips.ethereum.org/EIPS/eip-8056" target="_blank" rel="noreferrer">
              ERC-8056
            </a>
            , the scaled UI amount standard for tokenized equities. One token represents its balance times an onchain
            multiplier in underlying shares, and it trades on Uniswap at any hour, while the stock itself only trades
            during market hours.
          </p>
          {infoOpen ? (
            <p className="uv-explain-intro">
              The <strong>token price</strong> is what the token trades at on Uniswap right now, and the chip next to
              it is the gap from the <strong>underlying value</strong>, the stock&apos;s live market price times the
              shares one token represents. The <strong>shares per token</strong> figure is the{' '}
              <a className="uv-link" href="https://eips.ethereum.org/EIPS/eip-8056" target="_blank" rel="noreferrer">
                ERC-8056
              </a>{' '}
              multiplier, read straight from the token contract: dividends and splits never change token balances, they
              move this multiplier instead. While a corporate action is being processed the price oracle pauses, and
              any scheduled multiplier change shows on the asset card before it takes effect.
            </p>
          ) : null}
          <button className="uv-readmore" onClick={() => setInfoOpen(!infoOpen)} aria-expanded={infoOpen}>
            {infoOpen ? 'Show less' : 'Read more'}
          </button>
        </div>
      </aside>

      {/* GeckoTerminal's attribution, always visible above the token prices,
          TVL and DEX volume it supplies (its attribution guide). */}
      <p className="uv-attrib">
        On-chain data provided by{' '}
        <a href="https://www.geckoterminal.com" target="_blank" rel="noopener">
          GeckoTerminal
        </a>
        .
      </p>

      {gate === 'loading' && <p className="uv-note">Loading the universe{String.fromCharCode(8230)}</p>}
      {gate === 'signedOut' && (
        <p className="uv-note">
          Sign in to view the universe data.{' '}
          <a href="/" className="uv-link">
            Go to SyntheTick
          </a>
        </p>
      )}
      {gate === 'error' && <p className="uv-note">The universe data is unavailable right now. Try again in a minute.</p>}

      {gate === 'ready' && staleSince != null ? (
        <p className="uv-stale" role="status">
          Showing data from {new Date(staleSince).toLocaleTimeString()}. The latest refresh failed, so the table tries
          again every minute.
        </p>
      ) : null}
      {gate === 'ready' && policyNote ? (
        <p className="uv-policy-note" role="note">
          {policyNote}
        </p>
      ) : null}

      {gate === 'ready' && (
        <div className="uv-scroll">
          <div className="uv-stats">
            <div className="uv-stat">
              <span className="uv-stat-label uv-haspop">
                TVL
                <span className="uv-pop">
                  <strong>Total value locked</strong>
                  The combined liquidity of every token&apos;s Uniswap pools on Robinhood Chain, summed across the
                  whole universe.
                </span>
              </span>
              <span className="uv-stat-value">{fmtBig(totals.tvl)}</span>
            </div>
            <div className="uv-stat">
              <span className="uv-stat-label uv-haspop">
                Mkt cap
                <span className="uv-pop">
                  <strong>Onchain market cap</strong>
                  The sum of each token&apos;s onchain supply times its token price (DEX price, or the venue value when
                  no pool trades). It measures the tokens in circulation, not the underlying companies.
                </span>
              </span>
              <span className="uv-stat-value">{fmtBig(totals.mcap)}</span>
            </div>
            <div className="uv-stat">
              <span className="uv-stat-label uv-haspop">
                DEX vol 24h
                <span className="uv-pop">
                  <strong>DEX volume, 24 hours</strong>
                  The sum of every token&apos;s Uniswap trading volume over the last 24 hours.
                </span>
              </span>
              <span className="uv-stat-value">{fmtBig(totals.vol)}</span>
            </div>
          </div>
          <div className="uv-controls uv-controls-row">
            <input
              className="uv-search"
              aria-label="Search ticker or name"
              placeholder="Search ticker or name"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            {(['all', 'stock', 'etf'] as const).map((k) => (
              <button key={k} className={'uv-chip' + (kind === k ? ' on' : '')} onClick={() => setKind(k)}>
                {k === 'all' ? 'All' : k === 'stock' ? 'Stocks' : 'ETFs'}
              </button>
            ))}
          </div>
          <div className="uv-legend">
            <span className="uv-legend-on uv-haspop">
              Onchain
              <span className="uv-pop">
                <strong>Onchain sources</strong>
                <ul>
                  <li>Robinhood Chain RPC: multiplier, token supply, oracle state, read from the token contracts</li>
                  <li>Chainlink price feeds on chain 4663</li>
                  <li>Uniswap pools: on-chain data provided by GeckoTerminal (token price, TVL, DEX volume, price history)</li>
                  <li>Blockscout: holder counts</li>
                </ul>
              </span>
            </span>
            <span className="uv-legend-off uv-haspop">
              Offchain
              <span className="uv-pop">
                <strong>Offchain sources</strong>
                <ul>
                  <li>Robinhood market feed: underlying quotes, corporate actions, trading sessions</li>
                  {policyNote ? null : (
                    <li>SyntheTick fundamentals, refreshed nightly: market cap, financials, share price history</li>
                  )}
                </ul>
              </span>
            </span>
            {asOf ? (
              <span className="uv-legend-asof uv-dim">
                last update: chain {fmtTime(asOf.onchain)} / DEX {fmtTime(asOf.dex)} / market {fmtTime(asOf.quotes)}
              </span>
            ) : null}
          </div>
          <table className="uv-table">
            <thead>
              <tr>
                {th('Asset', 'ticker', null, false)}
                {th('Token price', 'unipx', 'on')}
                {th('Underlying value', 'offpx', 'off')}
                {th('Shares/token', 'mult', 'on')}
                {capWithheld ? null : th('Mkt cap', 'mcap', 'off')}
                {th('Mkt cap', 'onmcap', 'on')}
                {th('TVL', 'tvl', 'on')}
                {th('DEX vol 24h', 'dexvol', 'on')}
                {th('Supply', 'supply', 'on')}
                {th('Holders', 'holders', 'on')}
                {th('Type', 'type', 'off', false)}
                {th('Region', 'region', 'off', false)}
                <th className="uv-th-on">Contract</th>
              </tr>
            </thead>
            <tbody>
              {view.map((a) => {
                const offPx = tokenPrice(a);
                const logo = assetLogo(a);
                return (
                  <tr key={a.ticker} className="uv-row" onClick={() => setSel(a)}>
                    <td className="uv-asset">
                      {logo ? <img src={logo} alt="" width={22} height={22} loading="lazy" referrerPolicy="no-referrer" /> : <span className="uv-nologo" />}
                      <div>
                        <span className="uv-ticker">{a.ticker}</span>
                        <span className="uv-name">{a.name}</span>
                      </div>
                      <span className="uv-rowlinks">
                        <a
                          className="uv-buy uv-iconbtn"
                          href={uniswapBuyUrl(a.contract.address)}
                          target="_blank"
                          rel="noreferrer"
                          title={'Buy ' + a.ticker + ' on Uniswap (Robinhood Chain)'}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <SwapGlyph size={14} />
                        </a>
                        <a
                          className="uv-iconbtn"
                          href={a.contract.explorer}
                          target="_blank"
                          rel="noreferrer"
                          title="Token contract on Blockscout"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <ContractIcon />
                        </a>
                        {a.website ? (
                          <a
                            className="uv-iconbtn"
                            href={a.website}
                            target="_blank"
                            rel="noreferrer"
                            title="Company website"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <GlobeIcon />
                          </a>
                        ) : null}
                      </span>
                    </td>
                    <td className="uv-num">
                      {a.dex?.priceUsd != null ? '$' + a.dex.priceUsd.toFixed(2) : DASH}
                      {a.dex?.premiumPct != null && Math.abs(a.dex.premiumPct) >= 1 ? (
                        <span
                          className={'uv-prem ' + pctClass(a.dex.premiumPct)}
                          title={'Token price ' + fmtPct(a.dex.premiumPct) + ' vs the underlying value'}
                        >
                          {fmtPct(a.dex.premiumPct)}
                        </span>
                      ) : null}
                    </td>
                    <td className="uv-num">
                      {offPx != null ? '$' + offPx.toFixed(2) : DASH}
                      {a.quote?.halted ? (
                        <span className="uv-halt uv-haspop" onClick={(e) => e.stopPropagation()}>
                          halt
                          <span className="uv-pop">
                            <strong>Trading halted</strong>
                            The underlying stock is not tradable right now, as reported by Robinhood&apos;s market
                            feed. Outside regular market hours every stock shows this; during the session it marks a
                            regulatory or volatility halt. The token itself keeps trading on Uniswap.
                          </span>
                        </span>
                      ) : null}
                    </td>
                    <td className="uv-num">
                      {a.onchain?.uiMultiplier != null ? fmtMult(a.onchain.uiMultiplier) : DASH}
                      {a.onchain?.oraclePaused ? (
                        <span className="uv-halt" title="Price oracle paused while a corporate action is processed">
                          oracle
                        </span>
                      ) : null}
                    </td>
                    {capWithheld ? null : <td className="uv-num">{fmtBig(a.marketCapUsd)}</td>}
                    <td className="uv-num">{fmtBig(onchainMcap(a))}</td>
                    <td className="uv-num">{fmtBig(a.dex?.tvlUsd ?? null)}</td>
                    <td className="uv-num">{fmtBig(a.dex?.volume24hUsd ?? null)}</td>
                    <td className="uv-num">{fmtCount(a.onchain?.totalSupply)}</td>
                    <td className="uv-num">{a.holders != null ? a.holders.toLocaleString() : DASH}</td>
                    <td>
                      <span className="uv-tag">{a.kind === 'bond' ? 'etf' : a.kind}</span>
                    </td>
                    <td className="uv-region">{a.region ? a.region.toUpperCase() : DASH}</td>
                    <td className="uv-contract">
                      <button
                        className="uv-addr"
                        onClick={(e) => {
                          e.stopPropagation();
                          copy(a.contract.address);
                        }}
                        title={a.contract.address}
                      >
                        {copied === a.contract.address ? 'copied' : shortAddr(a.contract.address)}
                      </button>
                      <a
                        className="uv-link"
                        href={a.contract.explorer}
                        target="_blank"
                        rel="noreferrer"
                        title="Open in Blockscout"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {String.fromCharCode(8599)}
                      </a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {sel ? <AssetCard a={sel} policyNote={policyNote} onClose={() => setSel(null)} /> : null}
      <Script src="/sd-auth.js" strategy="afterInteractive" />
    </main>
  );
}

/** Metric rows for the card's financial data grid, grouped like the app's
 * asset cards. [metrics key, label, format]. */
const METRIC_GROUPS: { title: string; rows: [string, string, 'num' | 'pct' | 'big' | 'text'][] }[] = [
  {
    title: 'Valuation',
    rows: [
      ['pe', 'P/E (TTM)', 'num'],
      ['forward_pe', 'Forward P/E', 'num'],
      ['peg', 'PEG', 'num'],
      ['price_to_sales', 'Price/Sales', 'num'],
      ['price_to_book', 'Price/Book', 'num'],
      ['ev_to_ebitda', 'EV/EBITDA', 'num'],
      ['dividend_yield_pct', 'Dividend yield', 'pct'],
    ],
  },
  {
    title: 'Performance',
    rows: [
      ['return_1d_pct', '1 day', 'pct'],
      ['return_7d_pct', '7 days', 'pct'],
      ['return_30d_pct', '30 days', 'pct'],
      ['return_ytd_pct', 'YTD', 'pct'],
      ['return_1y_pct', '1 year', 'pct'],
      ['beta', 'Beta', 'num'],
    ],
  },
  {
    title: 'Profitability and leverage',
    rows: [
      ['gross_margin_pct', 'Gross margin', 'pct'],
      ['operating_margin_pct', 'Operating margin', 'pct'],
      ['net_margin_pct', 'Net margin', 'pct'],
      ['roe', 'ROE', 'num'],
      ['roic', 'ROIC', 'num'],
      ['debt_to_equity', 'Debt/Equity', 'num'],
      ['net_debt_to_ebitda', 'Net debt/EBITDA', 'num'],
      ['altman_z', 'Altman Z', 'num'],
    ],
  },
  {
    title: 'Growth',
    rows: [
      ['revenue_growth_pct', 'Revenue YoY', 'pct'],
      ['earnings_growth_pct', 'Earnings YoY', 'pct'],
      ['fcf_growth_pct', 'FCF YoY', 'pct'],
      ['revenue_cagr_3y_pct', 'Revenue 3y CAGR', 'pct'],
    ],
  },
];

function fmtMetric(v: number | string | null | undefined, kind: 'num' | 'pct' | 'big' | 'text'): string {
  if (v == null) return DASH;
  if (kind === 'text') return String(v);
  const n = Number(v);
  if (!Number.isFinite(n)) return DASH;
  if (kind === 'pct') return fmtPct(n);
  if (kind === 'big') return fmtBig(n);
  return n.toFixed(2);
}

function AssetCard({ a, policyNote, onClose }: { a: UniverseAsset; policyNote: string | null; onClose: () => void }) {
  // The list payload truncates the description at 500 chars; the single-asset
  // endpoint carries the full text for "Read more".
  const [fullText, setFullText] = useState<string | null>(null);
  const [aboutOpen, setAboutOpen] = useState(false);
  useEffect(() => {
    let alive = true;
    setFullText(null);
    setAboutOpen(false);
    (async () => {
      try {
        await sdReady();
        const t = await window.sdAuth?.token();
        const headers: Record<string, string> = {};
        if (t) headers.authorization = 'Bearer ' + t;
        const res = await fetch('/v1/universe/robinhood/assets/' + a.ticker, { headers });
        if (alive && res.ok) setFullText(((await res.json()) as { about: string | null }).about);
      } catch {
        /* card falls back to the truncated text */
      }
    })();
    return () => {
      alive = false;
    };
  }, [a.ticker]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    // The overlay owns scrolling while open; the table behind must not move.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);
  const mid = midPrice(a.quote);
  const ret30 = metricNum(a, 'return_30d_pct');
  const rating = a.metrics?.rating_consensus;
  const target = metricNum(a, 'price_target_avg');
  const upside = upsidePct(a);
  const holdings = (a.portfolio?.top_holdings ?? []).slice(0, 8);
  const logo = assetLogo(a);
  return (
    <div className="uv-overlay" onClick={onClose}>
      <div className="uv-card" onClick={(e) => e.stopPropagation()}>
        <header className="uv-card-head">
          {logo ? <img src={logo} alt="" width={34} height={34} referrerPolicy="no-referrer" /> : <span className="uv-nologo" />}
          <div className="uv-card-title">
            <h2>
              {a.ticker} <span className="uv-card-name">{a.name}</span>
            </h2>
            <p className="uv-dim">
              {[a.kind === 'stock' ? 'Stock' : 'ETF', a.sector].filter(Boolean).join(' / ')}
              {a.asOf ? ` / data as of ${a.asOf}` : ''}
            </p>
          </div>
          <button className="uv-close" onClick={onClose} aria-label="Close">
            {String.fromCharCode(10005)}
          </button>
        </header>

        {a.about ? (
          <div>
            <p className={'uv-about' + (aboutOpen ? '' : ' uv-about-clamp')}>{aboutOpen ? (fullText ?? a.about) : a.about}</p>
            <button className="uv-readmore" onClick={() => setAboutOpen(!aboutOpen)}>
              {aboutOpen ? 'Show less' : 'Read more'}
            </button>
          </div>
        ) : null}

        <div className="uv-price-tiles">
          <div className="uv-tile uv-tile-off">
            <h3>Underlying quote (offchain)</h3>
            <p className="uv-tile-big">{mid != null ? '$' + mid.toFixed(2) : DASH}</p>
            <p className="uv-dim">
              bid {a.quote?.bid != null ? '$' + a.quote.bid.toFixed(2) : DASH} / ask{' '}
              {a.quote?.ask != null ? '$' + a.quote.ask.toFixed(2) : DASH}
              {a.quote?.halted ? ' / trading halted' : ''}
            </p>
            <p className="uv-dim">
              day {a.quote?.dailyLow != null ? '$' + a.quote.dailyLow.toFixed(2) : DASH} to{' '}
              {a.quote?.dailyHigh != null ? '$' + a.quote.dailyHigh.toFixed(2) : DASH}
            </p>
            {mid != null && a.quote?.multiplier != null && Math.abs(a.quote.multiplier - 1) > 1e-6 ? (
              <p className="uv-dim">
                per token ${(mid * a.quote.multiplier).toFixed(2)} at x{fmtMult(a.quote.multiplier)}
              </p>
            ) : null}
            <p className="uv-tile-note">The underlying equity market price, passed through by Robinhood. Not the onchain price.</p>
          </div>
          <div className="uv-tile uv-tile-on">
            <h3>Token price (Uniswap)</h3>
            <p className="uv-tile-big">
              {a.dex?.priceUsd != null ? '$' + a.dex.priceUsd.toFixed(2) : DASH}
              {a.dex?.premiumPct != null ? (
                <span className={'uv-prem ' + pctClass(a.dex.premiumPct)}>{fmtPct(a.dex.premiumPct)}</span>
              ) : null}
            </p>
            {a.onchain?.oracle?.priceUsd != null ? (
              <p className="uv-dim">
                Chainlink oracle ${a.onchain.oracle.priceUsd.toFixed(2)}
                {a.onchain.oracle.stale ? ' (stale)' : ''}
              </p>
            ) : null}
            <p className="uv-dim">
              TVL {fmtBig(a.dex?.tvlUsd)} / 24h DEX vol {fmtBig(a.dex?.volume24hUsd)}
            </p>
            <p className="uv-dim">
              mint/burn today {fmtBig(a.quote?.mintBurnUsd)} / holders{' '}
              {a.holders != null ? a.holders.toLocaleString() : DASH}
            </p>
            <p className="uv-tile-note">
              What the token trades at in DEX pools, with the price the chain&apos;s oracle believes. The premium is the
              distance from the offchain price. On-chain data provided by{' '}
              <a href="https://www.geckoterminal.com" target="_blank" rel="noopener">
                GeckoTerminal
              </a>
              .
            </p>
          </div>
        </div>

        {/* Price history held back by the display policy: the note below says so, no empty chart. */}
        {a.spark30d || !policyNote ? <PriceChart offchain={a.spark30d} multiplier={sharesPerToken(a)} /> : null}

        <div className="uv-card-spark">
          <span className={pctClass(ret30)}>{fmtPct(ret30)} 30d</span>
          <span className="uv-dim">mkt cap {fmtBig(a.marketCapUsd)}</span>
          {typeof rating === 'string' && rating ? (
            <span>
              <span className="uv-rating">{rating}</span>
              <span className={pctClass(upside)}>
                {target != null ? 'target $' + target.toFixed(0) + ' (' + fmtPct(upside) + ')' : fmtPct(upside)}
              </span>
            </span>
          ) : null}
        </div>

        {a.onchain?.uiMultiplier != null || (a.events?.length ?? 0) > 0 ? (
          <section className="uv-holdings uv-mechanics">
            <h3>Token mechanics</h3>
            <dl>
              {a.onchain?.uiMultiplier != null ? (
                <div>
                  <dt className="uv-dt-on">Shares per token</dt>
                  <dd>
                    {fmtMult(a.onchain.uiMultiplier)}
                    {a.quote?.multiplier != null && Math.abs(a.onchain.uiMultiplier - a.quote.multiplier) > 1e-6 ? (
                      <span className="uv-down"> venue says {fmtMult(a.quote.multiplier)}</span>
                    ) : null}
                  </dd>
                </div>
              ) : null}
              {a.onchain?.totalSupply != null ? (
                <div>
                  <dt className="uv-dt-on">Token supply</dt>
                  <dd>
                    {fmtCount(a.onchain.totalSupply)}
                    {a.onchain.uiMultiplier != null ? (
                      <span className="uv-dim"> = {fmtCount(a.onchain.totalSupply * a.onchain.uiMultiplier)} shares</span>
                    ) : null}
                  </dd>
                </div>
              ) : null}
              {a.onchain?.oraclePaused ? (
                <div>
                  <dt className="uv-dt-on">Price oracle</dt>
                  <dd>
                    <span className="uv-inprogress">paused, corporate action processing</span>
                  </dd>
                </div>
              ) : null}
              {(a.onchain?.pendingMultiplier ?? a.quote?.pendingMultiplier) != null ? (
                <div>
                  <dt className="uv-dt-on">Pending multiplier</dt>
                  <dd>
                    {fmtMult((a.onchain?.pendingMultiplier ?? a.quote?.pendingMultiplier)!)}
                    {(a.onchain?.pendingEffectiveAt ?? a.quote?.pendingMultiplierEffectiveAt) ? (
                      <span className="uv-dim"> from {(a.onchain?.pendingEffectiveAt ?? a.quote?.pendingMultiplierEffectiveAt)!.slice(0, 10)}</span>
                    ) : null}
                  </dd>
                </div>
              ) : null}
              {(a.events ?? []).map((e) => (
                <div key={e.id}>
                  <dt className="uv-dt-off">
                    {EVENT_LABELS[e.type] ?? e.type}
                    {e.status === 'IN_PROGRESS' ? <span className="uv-inprogress"> in progress</span> : null}
                  </dt>
                  <dd>
                    {eventDetail(e)}
                    {e.processDate ? <span className="uv-dim"> {e.processDate}</span> : null}
                  </dd>
                </div>
              ))}
            </dl>
            <p className="uv-tile-note">
              Dividends and splits never change token balances. They move the onchain multiplier, the shares each token
              represents, read here straight from the contract.
            </p>
          </section>
        ) : null}

        {a.metrics ? (
          <div className="uv-metrics">
            {METRIC_GROUPS.map((g) => {
              const rows = g.rows.filter(([k]) => a.metrics?.[k] != null);
              if (!rows.length) return null;
              return (
                <section key={g.title}>
                  <h3 className="uv-h-off">{g.title}</h3>
                  <dl>
                    {rows.map(([k, label, kindF]) => (
                      <div key={k}>
                        <dt>{label}</dt>
                        <dd className={kindF === 'pct' ? pctClass(metricNum(a, k)) : undefined}>
                          {fmtMetric(a.metrics?.[k], kindF)}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </section>
              );
            })}
          </div>
        ) : (
          <p className="uv-note">{policyNote ?? 'No fundamentals in the database for this asset yet.'}</p>
        )}

        {holdings.length ? (
          <section className="uv-holdings">
            <h3 className="uv-h-off">Top holdings</h3>
            <dl>
              {holdings.map((h) => (
                <div key={(h.symbol ?? '') + h.name}>
                  <dt>{[h.symbol, h.name].filter(Boolean).join(' ')}</dt>
                  <dd>{h.weight != null ? h.weight.toFixed(2) + '%' : DASH}</dd>
                </div>
              ))}
            </dl>
          </section>
        ) : null}

        <footer className="uv-card-foot">
          <code title={a.contract.address}>{a.contract.address}</code>
          <span>
            {a.website ? (
              <a className="uv-link" href={a.website} target="_blank" rel="noreferrer">
                Website
              </a>
            ) : null}
            <a className="uv-link" href={a.contract.explorer} target="_blank" rel="noreferrer">
              Blockscout
            </a>
            <a className="uv-buy" href={uniswapBuyUrl(a.contract.address)} target="_blank" rel="noreferrer">
              <SwapGlyph size={13} />
              Buy on Uniswap
            </a>
          </span>
        </footer>
      </div>
    </div>
  );
}

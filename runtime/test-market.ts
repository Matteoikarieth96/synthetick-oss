/**
 * Milestone 4 test gate (spec §10.4): chart endpoints match vendor data within
 * delay tolerance; vendor failure renders unavailable, never fabricated.
 */
import 'dotenv/config';
import { log } from '../ingest/lib/log.js';
import { marketFor, marketForAll } from './market.js';

let failures = 0;
function check(name: string, ok: boolean, detail: string) {
  if (!ok) failures++;
  log.info(`${ok ? 'PASS' : 'FAIL'} — ${name}: ${detail}`);
}

async function main() {
  // 1. Equity (AAPL): series ≈30 points, price agrees with the FMP quote
  //    exactly (same vendor), asOf present.
  {
    const m = await marketFor({ source: 'fmp', vendor_id: 'AAPL', ticker: 'AAPL', currency: 'USD' });
    check('AAPL: price present', m.price != null && m.price > 0, `price=${m.price}`);
    check('AAPL: ~30 point series', m.series.length >= 25 && m.series.length <= 30, `${m.series.length} points`);
    check('AAPL: change30d finite', m.change30d != null && Number.isFinite(m.change30d), `${m.change30d?.toFixed(2)}%`);
    check('AAPL: change1d finite', m.change1d != null && Number.isFinite(m.change1d), `${m.change1d?.toFixed(2)}%`);
    check(
      'AAPL: 52-week range coherent, price inside ±5%',
      m.yearLow != null && m.yearHigh != null && m.yearHigh > m.yearLow &&
        m.price != null && m.price >= m.yearLow * 0.95 && m.price <= m.yearHigh * 1.05,
      `low=${m.yearLow} high=${m.yearHigh} price=${m.price}`,
    );
    check('AAPL: asOf present', !!m.asOf, String(m.asOf));
    const direct = await fetch(
      `https://financialmodelingprep.com/stable/quote?symbol=AAPL&apikey=${process.env.FMP_KEY}`,
    ).then((r) => r.json() as Promise<{ price: number }[]>);
    const vendor = direct?.[0]?.price ?? NaN;
    const tol = Math.abs((m.price! - vendor) / vendor);
    check('AAPL: matches vendor quote ≤0.5%', tol <= 0.005, `ours=${m.price} vendor=${vendor} (Δ${(tol * 100).toFixed(3)}%)`);
  }

  // 1b. Stock fin (§5.6, 2026-07-13): quote extras always, TTM ratios when kind='stock'.
  {
    const m = await marketFor({ source: 'fmp', vendor_id: 'MSFT', ticker: 'MSFT', kind: 'stock', currency: 'USD' });
    const f = m.fin ?? {};
    check('MSFT: quote extras present', f.open != null && f.prevClose != null && f.volume != null, JSON.stringify({ o: f.open, pc: f.prevClose, v: f.volume }));
    check('MSFT: day range coherent', f.dayLow != null && f.dayHigh != null && f.dayHigh >= f.dayLow, `${f.dayLow} to ${f.dayHigh}`);
    check('MSFT: TTM ratios present', f.pe != null && f.eps != null && f.pe > 0, JSON.stringify({ pe: f.pe, eps: f.eps }));
    check('MSFT: margins as percent', f.netMarginPct != null && f.netMarginPct > 1 && f.netMarginPct < 100, `${f.netMarginPct?.toFixed(1)}%`);
  }

  // 2. Crypto (BTC): series ≈30 points, last point within 3% of vendor spot
  //    (daily-interval last point may lag intraday moves).
  {
    const m = await marketFor({ source: 'coingecko', vendor_id: 'bitcoin', ticker: 'BTC' });
    check('BTC: price present', m.price != null && m.price > 0, `price=${m.price?.toFixed(0)}`);
    check('BTC: ~30 point series', m.series.length >= 28 && m.series.length <= 31, `${m.series.length} points`);
    check('BTC: change1d from daily closes', m.change1d != null && Number.isFinite(m.change1d), `${m.change1d?.toFixed(2)}%`);
    check('BTC: no 52-week fields for crypto', m.yearHigh === null && m.yearLow === null, JSON.stringify({ h: m.yearHigh, l: m.yearLow }));
    const spot = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd', {
      headers: process.env.COINGECKO_KEY ? { 'x-cg-demo-api-key': process.env.COINGECKO_KEY } : {},
    }).then((r) => r.json() as Promise<{ bitcoin: { usd: number } }>);
    const tol = Math.abs((m.price! - spot.bitcoin.usd) / spot.bitcoin.usd);
    check('BTC: within 3% of vendor spot', tol <= 0.03, `ours=${m.price?.toFixed(0)} vendor=${spot.bitcoin.usd} (Δ${(tol * 100).toFixed(2)}%)`);
  }

  // 2b. Crypto fin via marketForAll (§5.6, 2026-07-13): batch coins/markets
  //     snapshot (supply/rank/ATH) merged onto the chart data, avg volumes from
  //     the market_chart total_volumes we already fetch.
  {
    const all = await marketForAll([{ source: 'coingecko', vendor_id: 'ethereum', ticker: 'ETH', kind: 'crypto' }]);
    // Keyed by source:vendor_id, not ticker (tickers collide across sources).
    const f = all['coingecko:ethereum']?.fin ?? {};
    check('ETH: supply from batch snapshot', f.circSupply != null && f.circSupply > 1e6, `circ=${f.circSupply}`);
    check('ETH: rank + ATH present', f.rank != null && f.ath != null && f.athChangePct != null, JSON.stringify({ rank: f.rank, ath: f.ath }));
    check('ETH: avg volumes from chart', f.avgVol7d != null && f.avgVol30d != null && f.avgVol7d > 0, JSON.stringify({ v7: f.avgVol7d?.toExponential(2), v30: f.avgVol30d?.toExponential(2) }));
    check('ETH: 24h range coherent', f.low24h != null && f.high24h != null && f.high24h >= f.low24h, `${f.low24h} to ${f.high24h}`);
  }

  // 3. EU equity (ASML.AS): native currency preserved. FMP vendor_ids are
  //    Yahoo-style symbols used verbatim.
  {
    const m = await marketFor({ source: 'fmp', vendor_id: 'ASML.AS', ticker: 'ASML.AS', currency: 'EUR' });
    check('ASML: EUR currency', m.currency === 'EUR', m.currency);
    check('ASML: price present', m.price != null && m.price > 0, `price=${m.price}`);
  }

  // 4. Vendor failure → unavailable, never fabricated.
  {
    const m = await marketFor({ source: 'coingecko', vendor_id: 'this-coin-does-not-exist-xyz', ticker: 'FAKE' });
    check('FAKE: dataUnavailable, no fabrication', m.dataUnavailable === true && m.price === null && m.series.length === 0, JSON.stringify({ p: m.price, n: m.series.length }));
    check('FAKE: new fields null too', m.change1d === null && m.yearHigh === null && m.yearLow === null, JSON.stringify({ c1: m.change1d, h: m.yearHigh, l: m.yearLow }));
  }

  // 5. Cache: second call returns instantly (same object timestamps).
  {
    const t0 = Date.now();
    await marketFor({ source: 'fmp', vendor_id: 'AAPL', ticker: 'AAPL', currency: 'USD' });
    const ms = Date.now() - t0;
    check('cache: repeat call <50ms', ms < 50, `${ms}ms`);
  }

  log.step(failures === 0 ? 'ALL MARKET CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  log.error('test-market failed', err);
  process.exit(1);
});

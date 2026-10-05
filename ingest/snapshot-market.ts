/**
 * Snapshot live equity market data into assets.market_snapshot (spec §5.6).
 *
 *   npm run snapshot:market                  # all active FMP rows without a snapshot
 *   SNAP_LIMIT=500 npm run snapshot:market   # a capped chunk
 *   SNAP_REFRESH=1 npm run snapshot:market   # re-snapshot rows that already have one
 *   SNAP_CONCURRENCY=8 npm run snapshot:market
 *
 * Why this exists: without a stored copy, an equity card loses its price,
 * changes, sparkline, 52-week range and financials whenever the live vendor
 * call fails. Store only what your data license allows.
 *
 * Fidelity matters more than speed here: this calls `fmpEquityMarket` — the
 * exact function a live run uses — rather than a parallel reimplementation, so
 * the stored payload is by construction what the live path would have produced.
 * The bulk CSV endpoints would be faster but are a different code path with
 * their own rate limiter and blank-cell traps, and a snapshot that disagrees
 * with the live shape defeats the point.
 *
 * Resumable: rows that already carry a snapshot are skipped unless SNAP_REFRESH
 * is set, so an interrupted run picks up where it stopped. Rows whose vendor
 * calls fail are left null rather than written with a hollow payload — a null
 * means "no snapshot, fall through", an empty one would mean "we checked and
 * the asset has no price".
 */
import { log } from './lib/log.js';
import { supabase } from './lib/supabase.js';
import { fmpLimiter } from './lib/ratelimit.js';
import { fmpEquityMarket, type MarketAssetRef } from '../runtime/market.js';

const LIMIT = Number(process.env.SNAP_LIMIT ?? Number.POSITIVE_INFINITY);
const CONCURRENCY = Math.max(1, Number(process.env.SNAP_CONCURRENCY ?? 6));
const REFRESH = process.env.SNAP_REFRESH === '1';
const PAGE = 1000; // Supabase caps unranged selects at 1000 rows and does so silently

type Row = MarketAssetRef & { id: number };

/** Page through every active FMP row; an unranged select would quietly return
 * only the first 1000 and the run would look complete at 7% coverage. */
async function loadRows(): Promise<Row[]> {
  const out: Row[] = [];
  for (let from = 0; ; from += PAGE) {
    let q = supabase
      .from('assets')
      .select('id, source, vendor_id, ticker, kind, currency, market_cap_usd, volume_24h_usd, market_snapshot')
      .eq('source', 'fmp')
      .eq('is_active', true)
      .order('id')
      .range(from, from + PAGE - 1);
    if (!REFRESH) q = q.is('market_snapshot', null);
    const { data, error } = await q;
    if (error) throw new Error(`loadRows failed: ${error.message}`);
    if (!data?.length) break;
    out.push(...(data as unknown as Row[]));
    if (data.length < PAGE) break;
    if (out.length >= LIMIT) break;
  }
  return Number.isFinite(LIMIT) ? out.slice(0, LIMIT) : out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Write a batch, retrying transient failures.
 *
 * This MUST NOT throw. It runs inside a worker whose rejection propagates
 * through `Promise.all` and aborts every other worker — a single dropped
 * Supabase connection killed a 13k-row run at 15% on 2026-07-28. Rows that
 * still fail after the retries are simply left null, and the next run picks
 * them up, because the sweep is resumable by design.
 */
async function flush(batch: { id: number; market_snapshot: unknown }[]): Promise<number> {
  if (!batch.length) return 0;
  let lost = 0;
  // Per-row updates, not an upsert: an upsert on `assets` would need every
  // NOT NULL column and could resurrect stale values for the rest of the row.
  for (const { id, market_snapshot } of batch) {
    for (let attempt = 0; ; attempt++) {
      try {
        const { error } = await supabase.from('assets').update({ market_snapshot }).eq('id', id);
        if (error) throw new Error(error.message);
        break;
      } catch (err) {
        if (attempt >= 3) {
          log.warn(`update ${id} gave up after ${attempt + 1} tries: ${(err as Error).message.slice(0, 80)}`);
          lost++;
          break;
        }
        await sleep(500 * 2 ** attempt);
      }
    }
  }
  return lost;
}

async function main() {
  if (!process.env.FMP_KEY) throw new Error('FMP_KEY required — this is the last chance to snapshot');
  const t0 = Date.now();
  const rows = await loadRows();
  const asOf = new Date().toISOString().slice(0, 10);
  log.step(
    `Snapshotting ${rows.length} active FMP rows (concurrency ${CONCURRENCY}, ~${(rows.length * 3).toLocaleString()} calls)` +
      `${REFRESH ? ' — REFRESH: existing snapshots overwritten' : ''}`,
  );

  let done = 0;
  let written = 0;
  let empty = 0;
  const failed: string[] = [];
  let lostWrites = 0;
  let batch: { id: number; market_snapshot: unknown }[] = [];
  let cursor = 0;

  async function worker() {
    for (;;) {
      const i = cursor++;
      const r = rows[i];
      if (!r) return;
      try {
        // fmpEquityMarket fires THREE requests in parallel (quote, EOD, ratios)
        // off a single wait, so one tick per row under-counts the real rate by
        // 3x and earns HTTP 429s. Claim a tick per underlying request.
        await fmpLimiter.wait();
        await fmpLimiter.wait();
        await fmpLimiter.wait();
        const m = await fmpEquityMarket(r);
        // A snapshot with neither a price nor a series would assert "this asset
        // has no market data" on every future run. Leave the column null so the
        // card degrades honestly instead.
        if (m.price == null && m.series.length === 0) {
          empty++;
        } else {
          batch.push({
            id: r.id,
            market_snapshot: {
              as_of: asOf,
              price: m.price,
              currency: m.currency,
              change1d: m.change1d,
              change30d: m.change30d,
              series: m.series,
              yearHigh: m.yearHigh,
              yearLow: m.yearLow,
              fin: m.fin,
            },
          });
          written++;
        }
      } catch (err) {
        failed.push(`${r.ticker} (${r.vendor_id}): ${(err as Error).message.slice(0, 80)}`);
      }
      done++;
      if (batch.length >= 100) {
        const b = batch;
        batch = [];
        lostWrites += await flush(b);
      }
      if (done % 250 === 0) {
        const rate = done / ((Date.now() - t0) / 1000);
        const eta = Math.round((rows.length - done) / rate / 60);
        log.info(`${done}/${rows.length} — written ${written}, empty ${empty}, failed ${failed.length}, ~${eta}m left`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  lostWrites += await flush(batch);

  const mins = ((Date.now() - t0) / 60000).toFixed(1);
  log.step(`Done in ${mins}m — ${written} snapshotted, ${empty} had no data, ${failed.length} fetch-failed, ${lostWrites} write-failed`);
  if (failed.length) {
    log.warn(`Failures (re-run to retry; they stay null meanwhile):\n  ${failed.slice(0, 25).join('\n  ')}`);
    if (failed.length > 25) log.warn(`  …and ${failed.length - 25} more`);
  }
}

main().catch((err) => {
  log.error('snapshot-market failed', err);
  process.exit(1);
});

/**
 * One-time price-history seed (spec §15.2).
 *
 * asset_prices normally grows one nightly eod-bulk snapshot at a time, which
 * means 1-month returns would only become correct a month after launch. This
 * backfills a real window per symbol up front so the feature ships complete.
 *
 * Uses the per-symbol light EOD endpoint rather than eod-bulk: eod-bulk is
 * rate-limited to roughly one date per call window (verified 2026-07-27), so
 * seeding 60 days through it is not possible. FMP Ultimate has no daily call
 * quota and allows 3,000 calls/min, so ~8.8k symbols at the shared limiter's
 * pace is a few minutes.
 *
 * Safe to re-run: every write is an upsert on (asset_id, date). Resumable:
 * symbols that already have enough history in the window are skipped, so an
 * interrupted run picks up where it stopped.
 *
 * Run: npm run backfill:prices
 */
import { requireFmp } from './lib/env.js';
import { fetchJson } from './lib/http.js';
import { fmpLimiter } from './lib/ratelimit.js';
import { supabase } from './lib/supabase.js';
import { log } from './lib/log.js';

const BASE = 'https://financialmodelingprep.com/stable';
const DAYS = Number(process.env.BACKFILL_PRICE_DAYS ?? 400); // 1y returns at launch
const CONCURRENCY = Number(process.env.BACKFILL_PRICE_CONCURRENCY ?? 8);
const LIMIT = Number(process.env.BACKFILL_PRICE_LIMIT ?? 0); // 0 = whole universe
/** A symbol with at least this many closes in the window is considered done. */
const ENOUGH = Number(process.env.BACKFILL_PRICE_ENOUGH ?? 20);
/** Skip the resume check and refetch every symbol. With FMP's quota-free
 * limiter a full refetch costs about the same as the resume check itself, so
 * this is the right mode when the goal is completeness, not incremental
 * catch-up (e.g. a full refresh). */
const FORCE = process.env.BACKFILL_PRICE_FORCE === '1';
const UPSERT_CHUNK = 1000;

interface Target {
  id: number;
  vendor_id: string;
}

async function loadTargets(): Promise<Target[]> {
  const out: Target[] = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    const { data, error } = await supabase
      .from('assets')
      .select('id, vendor_id, market_cap_usd')
      .eq('is_active', true)
      .eq('source', 'fmp')
      // Biggest first: an interrupted run leaves the most-queried names done.
      .order('market_cap_usd', { ascending: false, nullsFirst: false })
      // Unique tiebreaker: equal and null caps have no stable order, so offset
      // pages could skip or repeat those rows (review R2).
      .order('id')
      .range(from, from + page - 1);
    if (error) throw new Error(`loadTargets failed: ${error.message}`);
    if (!data?.length) break;
    out.push(...data.map((r) => ({ id: r.id as number, vendor_id: r.vendor_id as string })));
    if (data.length < page) break;
  }
  return LIMIT > 0 ? out.slice(0, LIMIT) : out;
}

/** asset_ids that already have enough history — the resume set.
 *
 * One HEAD count per target riding the (asset_id, date) primary key. The old
 * approach — offset-paginating every asset_prices row in the window sorted by
 * asset_id — hit Supabase's statement timeout once the table passed ~5M rows
 * (live 2026-08-03); 13k tiny index-range counts finish in a couple of
 * minutes and never touch more than one asset's slice at a time. */
async function loadDone(targets: Target[], cutoff: string): Promise<Set<number>> {
  const done = new Set<number>();
  await runPool(targets, CONCURRENCY, async (t) => {
    const { count, error } = await supabase
      .from('asset_prices')
      .select('asset_id', { count: 'exact', head: true })
      .eq('asset_id', t.id)
      .gte('date', cutoff);
    if (error) throw new Error(`loadDone failed for asset ${t.id}: ${error.message}`);
    if ((count ?? 0) >= ENOUGH) done.add(t.id);
  });
  return done;
}

async function runPool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

async function main(): Promise<void> {
  const key = requireFmp();
  const started = Date.now();
  const from = new Date(Date.now() - DAYS * 86400_000).toISOString().slice(0, 10);

  log.step('Loading targets…');
  const targets = await loadTargets();
  const done = FORCE ? new Set<number>() : await loadDone(targets, from);
  const todo = targets.filter((t) => !done.has(t.id));
  log.info(
    `${targets.length} FMP assets, ${done.size} already seeded${FORCE ? ' (force: refetching all)' : ''}, ${todo.length} to fetch`,
  );
  if (!todo.length) return;

  const buffer: { asset_id: number; date: string; close: number }[] = [];
  let fetched = 0;
  let failed = 0;

  const flush = async (force = false) => {
    if (buffer.length < UPSERT_CHUNK && !force) return;
    const chunk = buffer.splice(0, buffer.length);
    if (!chunk.length) return;
    // Retried: a single transient "fetch failed" here once threw away a
    // 50-minute run (live 2026-08-03). supabase-js does not retry writes.
    for (let attempt = 1; ; attempt++) {
      const { error } = await supabase.from('asset_prices').upsert(chunk, { onConflict: 'asset_id,date' });
      if (!error) return;
      if (attempt >= 4) throw new Error(`asset_prices upsert failed: ${error.message}`);
      log.warn(`asset_prices upsert attempt ${attempt} failed (${error.message}), retrying…`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  };

  await runPool(todo, CONCURRENCY, async (t) => {
    try {
      await fmpLimiter.wait();
      const rows = await fetchJson<{ date: string; price: number }[]>(
        `${BASE}/historical-price-eod/light?symbol=${encodeURIComponent(t.vendor_id)}&from=${from}&apikey=${key}`,
        { label: `eod ${t.vendor_id}`, retries: 2 },
      );
      for (const r of rows ?? []) {
        const close = Number(r.price);
        if (!r.date || !Number.isFinite(close) || close <= 0) continue;
        buffer.push({ asset_id: t.id, date: r.date, close });
      }
      fetched++;
    } catch (err) {
      failed++;
      log.warn(`skip ${t.vendor_id}: ${(err as Error).message}`);
    }
    if (buffer.length >= UPSERT_CHUNK) await flush();
    if (fetched % 500 === 0 && fetched) log.info(`…${fetched}/${todo.length} symbols`);
  });
  await flush(true);

  log.step(
    `Done in ${Math.round((Date.now() - started) / 1000)}s — ${fetched} symbols seeded, ${failed} failed`,
  );
}

main().catch((err) => {
  log.error(`price backfill failed: ${(err as Error).message}`);
  process.exit(1);
});

/**
 * Backfill assets.website_url for rows that predate the website-capture code
 * (spec §5.6b). Re-fetches ONLY the vendor detail that carries the homepage,
 * for rows where website_url IS NULL — so it's resumable (re-run picks up the
 * remaining nulls) and budget-capped.
 *
 *   npm run backfill:websites                       # all null crypto rows
 *   BF_BUDGET=500 npm run backfill:websites         # a capped chunk
 *
 * CoinGecko only: FMP equities capture website at ingest, and the retired
 * EODHD rows are inactive. Cost: 1 detail call/coin (paced ~2.1s, ~31% of the
 * 10k/mo quota for the full 3k set).
 */
import { supabase } from './lib/supabase.js';
import { fetchCoinDetail, PACE_MS } from './sources/coingecko.js';
import { log, sleep } from './lib/log.js';

const BUDGET = Number(process.env.BF_BUDGET ?? 100_000);

const pickUrl = (raw: unknown): string | null => String(raw ?? '').trim() || null;

/** All active crypto rows that still lack a website, id-ordered. */
async function nullRows(): Promise<{ id: number; vendor_id: string }[]> {
  const out: { id: number; vendor_id: string }[] = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    const { data, error } = await supabase
      .from('assets')
      .select('id, vendor_id')
      .eq('source', 'coingecko')
      .eq('is_active', true)
      .is('website_url', null)
      .order('id', { ascending: true })
      .range(from, from + page - 1);
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    out.push(...data);
    if (data.length < page) break;
  }
  return out;
}

async function setUrl(id: number, url: string): Promise<void> {
  const { error } = await supabase.from('assets').update({ website_url: url }).eq('id', id);
  if (error) log.warn(`update ${id} failed: ${error.message}`);
}

async function main() {
  const rows = await nullRows();
  const todo = rows.slice(0, BUDGET);
  log.step(`website backfill — coingecko: ${rows.length} null rows, processing ${todo.length} (budget ${BUDGET})`);
  let done = 0;
  let found = 0;
  for (const r of todo) {
    const detail = (await fetchCoinDetail(r.vendor_id)) as { links?: { homepage?: (string | null)[] } } | null;
    const url = pickUrl((detail?.links?.homepage ?? []).map((h) => String(h ?? '').trim()).find(Boolean));
    await sleep(PACE_MS); // fetchCoinDetail is NOT self-paced — pacing lives in the caller (run-crypto.ts)
    if (url) {
      await setUrl(r.id, url);
      found++;
    }
    done++;
    if (done % 100 === 0) log.info(`  ${done}/${todo.length} processed, ${found} websites found`);
  }
  log.step(`done — ${done} processed, ${found} websites written`);
}

main().catch((e) => {
  log.error('backfill failed', e);
  process.exit(1);
});

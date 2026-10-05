/**
 * Backfill assets.logo_url for rows that predate the logo-capture code
 * (spec §5.6b). Resumable: only rows where logo_url IS NULL are touched,
 * so a re-run picks up the remainder.
 *
 *   npm run backfill:logos                            # crypto (default): ~12 calls total
 *   BF_SOURCE=fmp BF_BUDGET=2000 npm run backfill:logos   # equities, capped chunk
 *
 * coingecko: one /coins/markets sweep carries every coin's image — the whole
 * 3k set fills in ~12 paged calls (vs 1 detail call per coin).
 * fmp: 1 profile call per row (self-paced via fmpLimiter, no daily quota on
 * Ultimate); the nightly re-crawl fills these anyway over ~6 days, so this
 * path is only for jumping the queue. defaultImage placeholders stay null.
 */
import { supabase } from './lib/supabase.js';
import { fetchTopMarkets } from './sources/coingecko.js';
import { fetchProfile } from './sources/fmp.js';
import { log } from './lib/log.js';

const SOURCE = (process.env.BF_SOURCE ?? 'coingecko') as 'coingecko' | 'fmp';
const BUDGET = Number(process.env.BF_BUDGET ?? 100_000);
const TOP_N = Number(process.env.CRYPTO_TOP_N ?? 3000);

/** All active rows of the source that still lack a logo, id-ordered. */
async function nullRows(): Promise<{ id: number; vendor_id: string }[]> {
  const out: { id: number; vendor_id: string }[] = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    const { data, error } = await supabase
      .from('assets')
      .select('id, vendor_id')
      .eq('source', SOURCE)
      .eq('is_active', true)
      .is('logo_url', null)
      .order('id', { ascending: true })
      .range(from, from + page - 1);
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    out.push(...data);
    if (data.length < page) break;
  }
  return out;
}

async function setLogo(id: number, url: string): Promise<void> {
  const { error } = await supabase.from('assets').update({ logo_url: url }).eq('id', id);
  if (error) log.warn(`update ${id} failed: ${error.message}`);
}

async function main() {
  const rows = await nullRows();
  const todo = rows.slice(0, BUDGET);
  log.step(`logo backfill — ${SOURCE}: ${rows.length} null rows, processing ${todo.length} (budget ${BUDGET})`);
  let done = 0;
  let found = 0;

  if (SOURCE === 'coingecko') {
    const markets = await fetchTopMarkets(TOP_N);
    const imageById = new Map(markets.map((m) => [m.id, (m.image ?? '').trim()]));
    for (const r of todo) {
      const url = imageById.get(r.vendor_id);
      if (url) {
        await setLogo(r.id, url);
        found++;
      }
      done++;
      if (done % 250 === 0) log.info(`  ${done}/${todo.length} processed, ${found} logos written`);
    }
  } else {
    for (const r of todo) {
      const profile = await fetchProfile(r.vendor_id); // self-paced (fmpLimiter), null on hard stop
      const url = profile && !profile.defaultImage ? (profile.image ?? '').trim() : '';
      if (url) {
        await setLogo(r.id, url);
        found++;
      }
      done++;
      if (done % 100 === 0) log.info(`  ${done}/${todo.length} processed, ${found} logos written`);
    }
  }
  log.step(`done — ${done} processed, ${found} logos written`);
}

main().catch((e) => {
  log.error('backfill failed', e);
  process.exit(1);
});

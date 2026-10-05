/**
 * Standalone delta embedding runner (`npm run embed`).
 *
 * Ingestion normally embeds rows immediately. This command repairs missing or
 * stale vectors after migrations/manual edits and can deliberately rebuild
 * them with EMBED_FORCE=true. It never touches inactive/retired rows.
 *
 * Knobs:
 *   EMBED_SOURCE=fmp,coingecko,sacra  subset to process (default: all)
 *   EMBED_LIMIT=100                   cap rows for a smoke run (default: none)
 *   EMBED_FORCE=true                  re-embed every active row in scope
 */
import { log } from '../lib/log.js';
import { supabase, type AssetRow } from '../lib/supabase.js';
import { assertEmbeddingCoverage } from '../lib/gates.js';
import { buildEmbedText, embedAssets, findStaleEmbeddings, type EmbedTarget } from './voyage.js';

const ACTIVE_SOURCES = ['fmp', 'coingecko', 'sacra'] as const;
type ActiveSource = (typeof ACTIVE_SOURCES)[number];

function sourcesFromEnv(): ActiveSource[] {
  const raw = (process.env.EMBED_SOURCE ?? '').trim();
  if (!raw) return [...ACTIVE_SOURCES];
  const requested = [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))];
  const invalid = requested.filter((s) => !ACTIVE_SOURCES.includes(s as ActiveSource));
  if (invalid.length) {
    throw new Error(`Invalid EMBED_SOURCE: ${invalid.join(', ')}. Use fmp, coingecko, and/or sacra.`);
  }
  return requested as ActiveSource[];
}

function limitFromEnv(): number | null {
  const raw = (process.env.EMBED_LIMIT ?? '').trim();
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error('EMBED_LIMIT must be a positive integer.');
  return value;
}

async function activeIds(source: ActiveSource): Promise<number[]> {
  const ids: number[] = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from('assets')
      .select('id')
      .eq('source', source)
      .eq('is_active', true)
      .order('id')
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`active asset read failed for ${source}: ${error.message}`);
    if (!data?.length) break;
    ids.push(...data.map((row) => row.id as number));
    if (data.length < pageSize) break;
  }
  return ids;
}

async function loadTargets(ids: number[]): Promise<EmbedTarget[]> {
  const targets: EmbedTarget[] = [];
  for (let i = 0; i < ids.length; i += 500) {
    const { data, error } = await supabase
      .from('assets')
      .select('id, name, kind, sector, categories, description, etf_portfolio, enrichment')
      .in('id', ids.slice(i, i + 500));
    if (error) throw new Error(`embedding target read failed: ${error.message}`);
    for (const row of data ?? []) {
      targets.push({
        id: row.id as number,
        text: buildEmbedText(row as Pick<
          AssetRow,
          'name' | 'kind' | 'sector' | 'categories' | 'description' | 'etf_portfolio' | 'enrichment'
        >),
      });
    }
  }
  return targets.sort((a, b) => a.id - b.id);
}

async function main(): Promise<void> {
  const sources = sourcesFromEnv();
  const limit = limitFromEnv();
  const force = process.env.EMBED_FORCE === 'true';
  let remaining = limit ?? Number.POSITIVE_INFINITY;
  let embedded = 0;

  log.step(`standalone embeddings: ${sources.join(', ')}${force ? ' (forced rebuild)' : ' (delta)'}`);
  for (const source of sources) {
    if (remaining <= 0) break;
    const ids = force
      ? await activeIds(source)
      : [...await findStaleEmbeddings(source as AssetRow['source'])].sort((a, b) => a - b);
    const selected = ids.slice(0, remaining);
    if (!selected.length) {
      log.info(`${source}: no ${force ? 'active' : 'stale'} assets to embed`);
    } else {
      log.step(`${source}: embedding ${selected.length}${selected.length < ids.length ? ` of ${ids.length}` : ''} assets`);
      embedded += await embedAssets(await loadTargets(selected));
      remaining -= selected.length;
    }
    // A capped smoke run intentionally leaves work behind, so only enforce the
    // production coverage gate after an uncapped source pass.
    if (limit == null) await assertEmbeddingCoverage(source as AssetRow['source']);
  }
  log.step(`standalone embeddings complete — ${embedded} vector${embedded === 1 ? '' : 's'} written`);
}

main().catch((error) => {
  log.error('standalone embedding run failed', error);
  process.exit(1);
});

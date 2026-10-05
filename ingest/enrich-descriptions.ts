/**
 * Thematic description enrichment (spec §4.3b). For the top-N assets by market
 * cap, fetch dense factual context via LLM + web search, store it in
 * assets.enrichment, then re-embed so retrieval connects these assets to theses
 * that never name them (proven: ETH's Swift/RWA thesis cosine 0.329 → 0.467,
 * crossing the ~0.416 retrieval bar).
 *
 *   ENRICH_TOP_N=100 npm run enrich:descriptions              # top 100 by mcap (any kind)
 *   ENRICH_TOP_N=100 ENRICH_KIND=crypto npm run enrich:descriptions
 *
 * Resumable (only enriches rows where enrichment IS NULL) and reversible
 * (`update assets set enrichment=null` + re-embed reverts it entirely).
 */
import { supabase } from './lib/supabase.js';
import { callClaude } from '../runtime/llm.js';
import { buildEmbedText, embedAssets, type EmbedTarget } from './embeddings/voyage.js';
import { log, sleep } from './lib/log.js';

const TOP_N = Number(process.env.ENRICH_TOP_N ?? 100);
const KIND = process.env.ENRICH_KIND ?? ''; // '' = any kind
const PACE_MS = Number(process.env.ENRICH_PACE_MS ?? 400);
// ENRICH_REFRESH=true re-enriches the whole top-N with current facts (the
// bi-weekly cron path); default only fills nulls (one-time / new entrants).
const REFRESH = process.env.ENRICH_REFRESH === 'true';

// Theme-first (2026-07-09): LEAD with thematic exposures, not generic identity —
// retrieval matches on themes, so front-loading them is what surfaces an asset
// for theses that never name it (proven: ETH moved from not-retrieved to pool
// rank #66 / sim 0.562 on the Swift/RWA thesis when the prompt led with themes).
const SYS =
  'You enrich an asset profile for a semantic-search index that matches assets to investment theses. Use web search. In 3-4 dense sentences, LEAD with the specific sectors, investment themes, narratives, use-cases, and trends this asset is a play on or the infrastructure for — be exhaustive about its thematic exposures and which theses it should surface for — THEN briefly what it is. Factual and current. No preamble, no marketing fluff, no price predictions or targets.';

type Row = {
  id: number;
  ticker: string;
  name: string;
  kind: string;
  sector: string | null;
  categories: string[] | null;
  description: string | null;
  etf_portfolio: unknown;
  enrichment: string | null;
};

async function main() {
  let q = supabase
    .from('assets')
    .select('id, ticker, name, kind, sector, categories, description, etf_portfolio, enrichment')
    .eq('is_active', true)
    .not('market_cap_usd', 'is', null)
    .order('market_cap_usd', { ascending: false })
    .limit(TOP_N);
  if (KIND) q = q.eq('kind', KIND);
  // Pre-IPO rows are excluded (§4.2b): their market_cap_usd is an estimated
  // valuation that would crack the top-N, and their Sacra profile paragraph
  // already plays the enrichment role — enriching would waste budget on it.
  else q = q.neq('kind', 'private');
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Row[];
  const todo = REFRESH ? rows : rows.filter((r) => !r.enrichment); // refresh: re-enrich all; else fill nulls
  log.step(`enrichment — top ${TOP_N}${KIND ? ` ${KIND}` : ''} by mcap${REFRESH ? ' (REFRESH)' : ''}: ${rows.length} rows, ${todo.length} to enrich`);

  const enriched: Row[] = [];
  for (const r of todo) {
    try {
      const txt = await callClaude(
        `Asset: ${r.name} (${r.ticker}, ${r.kind}${r.sector ? ', ' + r.sector : ''}). Enrich its profile.`,
        { system: SYS, web: true, maxTokens: 320, temperature: 0.1 },
      );
      const enrichment = txt.replace(/\s+/g, ' ').trim().slice(0, 900);
      if (enrichment) {
        const { error: uerr } = await supabase.from('assets').update({ enrichment }).eq('id', r.id);
        if (uerr) log.warn(`update ${r.ticker} failed: ${uerr.message}`);
        else enriched.push({ ...r, enrichment });
      }
    } catch (e) {
      log.warn(`enrich ${r.ticker} failed: ${(e as Error).message}`);
    }
    if (enriched.length % 10 === 0 && enriched.length) log.info(`  ${enriched.length}/${todo.length} enriched`);
    await sleep(PACE_MS);
  }

  // Re-embed every row we enriched this run so the new context reaches retrieval.
  const targets: EmbedTarget[] = enriched.map((r) => ({ id: r.id, text: buildEmbedText(r as never) }));
  if (targets.length) {
    log.step(`re-embedding ${targets.length} enriched assets…`);
    await embedAssets(targets);
  }
  log.step(`done — ${enriched.length} enriched + re-embedded`);
}

main().catch((e) => {
  log.error('enrichment failed', e);
  process.exit(1);
});

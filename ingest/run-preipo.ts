/**
 * Pre-IPO watchlist sync — Sacra (spec §4.2b). Weekly (Monday cron) or manual.
 *
 * The universe is the WATCHLIST below, not a screener sweep: Sacra meters
 * every request per company touched, so the run costs ~2 tasks per name
 * (1 company detail + 1 share of the batched events call) ≈ 55 tasks at the
 * default list, ~230/month weekly — inside the Standard plan's 500.
 */
import { log } from './lib/log.js';
import { requireSacra } from './lib/env.js';
import { supabase, upsertAssets, sweepInactiveEmbeddings, type AssetRow } from './lib/supabase.js';
import {
  initSacra, fetchCompany, fetchEvents, hasGraduated, toAssetRow, tasksSpent,
  type SacraCompany,
} from './sources/sacra.js';
import { buildEmbedText, embedAssets, type EmbedTarget } from './embeddings/voyage.js';

/** Curated pre-IPO watchlist (spec §4.2b) — Sacra company domains, all 24
 * live-validated 2026-07-10. Names that IPO are auto-deactivated by the sync;
 * prune them here after (cerebras.ai and spacex.com already graduated). */
const DEFAULT_WATCHLIST = [
  // AI
  'openai.com', 'anthropic.com', 'x.ai', 'perplexity.ai', 'mistral.ai',
  'scale.com', 'groq.com', 'cursor.com',
  // fintech
  'stripe.com', 'revolut.com', 'plaid.com', 'ramp.com', 'deel.com', 'checkout.com',
  // data / dev infra
  'databricks.com', 'vercel.com', 'notion.so', 'canva.com',
  // defense
  'anduril.com', 'helsing.ai',
  // consumer / other
  'bytedance.com', 'shein.com', 'discord.com', 'epicgames.com',
];

const WATCHLIST = (process.env.PREIPO_DOMAINS ?? '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const domains = WATCHLIST.length ? WATCHLIST : DEFAULT_WATCHLIST;

/** Per-run task ceiling: refuse to start a run that could blow the budget. */
const TASK_BUDGET = Number(process.env.PREIPO_TASK_BUDGET ?? 150);

async function deactivate(domain: string, reason: string): Promise<void> {
  const { data, error } = await supabase
    .from('assets')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('source', 'sacra')
    .eq('vendor_id', domain)
    .select('id');
  if (error) throw new Error(`deactivate ${domain} failed: ${error.message}`);
  if (data?.length) log.info(`${domain} deactivated — ${reason}`);
}

async function main() {
  const t0 = Date.now();
  if (!Number.isFinite(TASK_BUDGET) || TASK_BUDGET < 1 || !Number.isInteger(TASK_BUDGET)) {
    throw new Error('PREIPO_TASK_BUDGET must be a positive integer');
  }
  initSacra(requireSacra(), TASK_BUDGET);

  // Worst case: 1 task per company detail + 1 per company per events page (×2 pages headroom).
  const worstCase = domains.length * 3;
  if (worstCase > TASK_BUDGET) {
    throw new Error(
      `watchlist of ${domains.length} could cost ~${worstCase} Sacra tasks > budget ${TASK_BUDGET} — shrink PREIPO_DOMAINS or raise PREIPO_TASK_BUDGET`,
    );
  }
  log.step(`Pre-IPO sync (Sacra) — ${domains.length} companies, task budget ${TASK_BUDGET}`);

  // 1. Company details (sequential: 26 calls, pacing is irrelevant vs metering).
  const companies = new Map<string, SacraCompany>();
  for (const domain of domains) {
    const c = await fetchCompany(domain);
    if (!c) {
      log.warn(`${domain} not covered by Sacra — skipped (check the watchlist entry)`);
      continue;
    }
    companies.set(domain, c);
  }

  // 2. Recent events for everyone Sacra resolved, one batched query.
  const events = await fetchEvents([...companies.keys()]);

  // 3. Split graduates (IPO'd / gone public) from the still-private rows.
  const rows: AssetRow[] = [];
  for (const [domain, c] of companies) {
    const evs = events.get(domain) ?? [];
    if (hasGraduated(c, evs)) {
      await deactivate(domain, `no longer private (type=${c.type}, listings=${(c.listings ?? []).length}) — remove from the watchlist`);
      continue;
    }
    if (!c.is_active) {
      await deactivate(domain, 'inactive on Sacra');
      continue;
    }
    rows.push(toAssetRow(c, evs));
  }

  // 4. Upsert + delta embed (same flow as every other source).
  const upserted = await upsertAssets(rows);
  const idByVendor = new Map(upserted.map((u) => [u.vendor_id, u.id]));
  const targets: EmbedTarget[] = [];
  for (const r of rows) {
    const id = idByVendor.get(r.vendor_id);
    if (id != null) targets.push({ id, text: buildEmbedText(r) });
  }
  const embedded = await embedAssets(targets);

  // Embedding cleanup (§4.1 step 5, 2026-07-12): IPO-graduated rows were
  // deactivated above via deactivate(); drop their vectors from the index.
  const swept = await sweepInactiveEmbeddings();

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  log.step(
    `Done in ${secs}s — ${companies.size}/${domains.length} resolved, upserted ${upserted.length}, ` +
      `embedded ${embedded}, swept ${swept} inactive embeddings, Sacra tasks spent ~${tasksSpent}`,
  );
}

main().catch((err) => {
  log.error('pre-IPO ingest failed', err);
  process.exit(1);
});

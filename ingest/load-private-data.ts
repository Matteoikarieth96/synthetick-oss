/**
 * Load assets.private_data for pre-IPO rows from vendor files the operator
 * holds under their own Sacra license (spec §4.2b). It reads a local directory,
 * not the vendor API, so it spends no metered tasks and can be re-run freely.
 *
 *   npm run load:private-data
 *   SACRA_ARCHIVE_DIR=/path/to/archive npm run load:private-data   (default ./sacra-archive)
 *
 * The directory holds three files per company:
 * detail-<slug>.json (company_datasets, financials, milestones),
 * metrics-<slug>.json (observations incl. projection scenarios) and
 * rounds-<slug>.json (funding rounds with share-level issue prices).
 *
 * Requires db/private_data.sql to have been applied.
 */
import { readFileSync, existsSync } from 'node:fs';
import { log } from './lib/log.js';
import { supabase } from './lib/supabase.js';

// Operator-supplied directory of vendor files (not shipped in the repo).
const DIR = process.env.SACRA_ARCHIVE_DIR ?? process.env.SACRA_ARCHIVE ?? './sacra-archive';

interface Pt {
  d: string;
  v: number;
}

/** A company_datasets entry → sorted {date, value} points. */
function series(ds: { data?: { x?: string; y?: number }[] } | undefined): Pt[] {
  return (ds?.data ?? [])
    .filter((p): p is { x: string; y: number } => Number.isFinite(p.y) && !!p.x)
    .map((p) => ({ d: p.x.slice(0, 10), v: Number(p.y) }))
    .sort((a, b) => a.d.localeCompare(b.d));
}

const findSet = (c: { company_datasets?: { name: string }[] }, re: RegExp) =>
  (c.company_datasets ?? []).find((d) => re.test(d.name)) as
    | { data?: { x?: string; y?: number }[]; source_url?: string }
    | undefined;

/**
 * Strip trailing implausible points from a valuation series.
 *
 * Some secondary-transaction events report the transaction size in the
 * valuation field. Such a point lands as the newest one and would anchor the
 * sparkline and the stored market cap. The vendor's own
 * `financials.latest_estimated_valuation` is the anchor when present. Without
 * one, require that a trailing point not collapse more than 75% against its
 * predecessor. Genuine down-rounds of about 50% sit well inside both bounds.
 * Removed points are returned, not discarded, and are stored under `dropped`
 * so the cleaning stays reviewable.
 */
export function cleanValuationSeries(
  pts: Pt[],
  anchor: number | null,
): { kept: Pt[]; dropped: (Pt & { why: string })[] } {
  const dropped: (Pt & { why: string })[] = [];
  const kept = [...pts];
  while (kept.length) {
    const last = kept[kept.length - 1];
    if (!last) break;
    const prev = kept[kept.length - 2];
    let why = '';
    if (anchor && last.v < anchor * 0.5) {
      why = `below 50% of profile valuation ${anchor}`;
    } else if (!anchor && prev && last.v < prev.v * 0.25) {
      why = 'collapsed >75% versus previous point';
    }
    if (!why) break;
    dropped.push({ d: last.d, v: last.v, why });
    kept.pop();
  }
  return { kept, dropped: dropped.reverse() };
}

function readJson(file: string): Record<string, unknown> | null {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

async function main() {
  const probe = await supabase.from('assets').select('private_data').eq('source', 'sacra').limit(1);
  if (probe.error) {
    throw new Error(`db/private_data.sql not applied yet — ${probe.error.message}`);
  }

  const { data: rows, error } = await supabase
    .from('assets')
    .select('ticker, vendor_id')
    .eq('source', 'sacra')
    .eq('is_active', true)
    .order('vendor_id');
  if (error) throw new Error(error.message);

  log.step(`Loading private_data for ${rows.length} pre-IPO rows from ${DIR}`);
  const removals: string[] = [];
  let written = 0;

  for (const r of rows) {
    const slug = r.ticker.toLowerCase(); // ticker is slug.toUpperCase() at ingest
    const detail = readJson(`${DIR}/detail-${slug}.json`);
    if (!detail) {
      log.warn(`${slug}: no archived detail — skipped`);
      continue;
    }
    const c = (detail.company ?? detail) as Record<string, any>;

    const anchor =
      (c.financials ?? []).find((f: { name: string }) => f.name === 'latest_estimated_valuation')?.value ?? null;
    const { kept: valuation_series, dropped } = cleanValuationSeries(
      series(findSet(c as never, /Valuation \(\$\)/)),
      anchor,
    );
    for (const d of dropped) {
      removals.push(`${slug}: ${d.d} $${(d.v / 1e9).toFixed(2)}B — ${d.why}`);
    }

    const metrics = (readJson(`${DIR}/metrics-${slug}.json`)?.metrics ?? []) as Record<string, any>[];
    const projections = metrics
      .filter((m) => m.measurement?.scenario === 'projection' && Number.isFinite(m.measurement?.amount))
      .map((m) => ({
        base: m.metric_definition?.base ?? null,
        scenario: 'projection',
        date: m.measurement.end_date,
        amount: m.measurement.amount,
        currency: m.measurement.currency_code ?? null,
      }));

    const rounds = (readJson(`${DIR}/rounds-${slug}.json`)?.funding_rounds ?? []) as Record<string, any>[];
    const funding_rounds = rounds.flatMap((fr) =>
      (fr.share_details ?? []).map((s: Record<string, any>) => ({
        name: s.name ?? fr.round_name ?? null,
        // Vendor sends issue price as a display string (e.g. "$12.3456").
        issue_price: Number(String(s.issue_price ?? '').replace(/[^0-9.]/g, '')) || null,
        issued_at: s.issued_at ? String(s.issued_at).slice(0, 10) : null,
      })),
    );

    const revenue_series = series(findSet(c as never, /Annualized Revenue \(\$M\)/));
    const revenue_growth = series(findSet(c as never, /Annualized Revenue Growth/));
    const price_per_share = series(findSet(c as never, /Price per Share/));
    const sources = [
      ...new Set((c.company_datasets ?? []).map((d: { source_url?: string }) => d.source_url).filter(Boolean)),
    ];

    // Absent key = no vendor data. Never write an empty array, which would read
    // as "we checked and there is none" on a row we simply couldn't cover.
    const pd: Record<string, unknown> = { as_of: new Date().toISOString().slice(0, 10) };
    if (valuation_series.length) pd.valuation_series = valuation_series;
    if (revenue_series.length) pd.revenue_series = revenue_series;
    if (revenue_growth.length) pd.revenue_growth = revenue_growth;
    if (price_per_share.length) pd.price_per_share = price_per_share;
    if (projections.length) pd.projections = projections;
    if (funding_rounds.length) pd.funding_rounds = funding_rounds;
    if (sources.length) pd.sources = sources;
    if (dropped.length) pd.dropped = dropped;

    const { error: upErr } = await supabase
      .from('assets')
      .update({ private_data: pd })
      .eq('source', 'sacra')
      .eq('vendor_id', r.vendor_id);
    if (upErr) throw new Error(`${slug}: ${upErr.message}`);
    written++;
    log.info(
      `${slug.padEnd(14)} valuation:${String(valuation_series.length).padStart(2)} ` +
        `revenue:${String(revenue_series.length).padStart(2)} projections:${String(projections.length).padStart(2)} ` +
        `rounds:${String(funding_rounds.length).padStart(2)}${dropped.length ? `  (dropped ${dropped.length})` : ''}`,
    );
  }

  log.step(`Done — ${written} rows written`);
  if (removals.length) {
    log.warn(`Corrupted valuation points removed (kept under private_data.dropped):\n  ${removals.join('\n  ')}`);
  }
}

main().catch((err) => {
  log.error('load-private-data failed', err);
  process.exit(1);
});

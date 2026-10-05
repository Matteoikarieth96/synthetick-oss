import 'dotenv/config';

/**
 * Sacra API probe — one-shot evaluation of the pre-IPO data surface.
 * Not part of any pipeline; run manually: npx tsx ingest/sacra-probe.ts
 *
 * Budget: every company touched by a request costs 1 "task" (Standard plan
 * includes 500/month). This script spends ~15 tasks total and prints a
 * running tally so we know exactly what the evaluation cost.
 *
 * Requires SACRA_API_KEY in .env (org settings → API Keys on sacra.com).
 */

const BASE = 'https://sacra.com/api/v1';

const key = process.env.SACRA_API_KEY?.trim();
if (!key) {
  console.error('Missing SACRA_API_KEY in .env — create one at sacra.com org settings → API Keys.');
  process.exit(1);
}

// Pre-IPO watchlist for the probe. Domains are Sacra's primary lookup key.
const WATCHLIST = ['spacex.com', 'openai.com', 'anthropic.com', 'stripe.com', 'databricks.com', 'revolut.com'];

let tasksSpent = 0;

async function get(path: string, params: Record<string, string>, taskCost: number): Promise<unknown> {
  const url = `${BASE}${path}?${new URLSearchParams(params)}`;
  const res = await fetch(url, { headers: { Authorization: `Token ${key}` } });
  tasksSpent += taskCost;
  if (!res.ok) {
    console.error(`  ${res.status} ${res.statusText} — ${url}`);
    console.error(`  ${(await res.text()).slice(0, 500)}`);
    return null;
  }
  return res.json();
}

function show(label: string, data: unknown, maxChars = 3000) {
  console.log(`\n=== ${label} (tasks so far: ${tasksSpent}) ===`);
  if (data == null) return;
  const s = JSON.stringify(data, null, 2);
  console.log(s.length > maxChars ? `${s.slice(0, maxChars)}\n  …[${s.length} chars total]` : s);
}

async function main() {
  // 1. Company lookup + full detail for one flagship name (2 tasks).
  //    Detail includes financials (est. revenue/valuation/funding), listings
  //    (ticker/venue/listed_at — how we'd detect an IPO), datasets, milestones.
  const lookup = await get('/companies/', { company_domain: 'anthropic.com' }, 1);
  show('company lookup (anthropic.com)', lookup);

  const slug = (lookup as any)?.company?.slug ?? 'anthropic';
  const detail = await get(`/companies/${slug}/`, {}, 1);
  show(`company detail (${slug})`, detail, 6000);

  // 2. Events across the watchlist: funding rounds, secondaries (tender
  //    offers = the pre-IPO market signal), corporate actions incl. `ipo`
  //    subtype (6 tasks).
  const events = await get(
    '/events/',
    {
      company_domains: WATCHLIST.join(','),
      types: 'funding-round,secondary-transaction,corporate-action',
      start_date: '2025-07-01',
      include_citations: '1',
      pagination: 'cursor',
      page_size: '50',
    },
    WATCHLIST.length,
  );
  show('events — funding/secondaries/corporate-actions since 2025-07', events, 6000);

  // 3. Revenue observations with citations for one company (1 task).
  //    NB: docs examples (`revenue`, `arr`) are rejected by the live API;
  //    verified vocabulary is `trailing_revenue`, `run_rate_revenue`.
  const metrics = await get(
    '/metrics/',
    { company_domain: 'anthropic.com', metric_base: 'trailing_revenue,run_rate_revenue', page_size: '20' },
    1,
  );
  show('metric observations (anthropic revenue)', metrics, 6000);

  // 4. Funding-round history for one company (1 task).
  const rounds = await get('/funding-rounds/', { company_domain: 'spacex.com' }, 1);
  show('funding rounds (spacex)', rounds, 4000);

  // 5. Curated news for one company (1 task).
  const news = await get('/news/company/', { company_domain: 'openai.com', page_size: '10' }, 1);
  show('news (openai)', news, 4000);

  // 6. Categories — live API requires a company_domain/company_id/slug,
  //    despite docs describing a no-arg list mode (1 task).
  const categories = await get('/categories/', { company_domain: 'anthropic.com' }, 1);
  show('categories (anthropic)', categories, 3000);

  console.log(`\nDone. Estimated task spend: ~${tasksSpent} of 500/month (Standard plan).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * Sacra — pre-IPO private companies (spec §4.2b).
 *
 * Every request costs 1 metered "task" PER COMPANY TOUCHED (Standard plan:
 * 500/month, then $0.05 each, hard cap 1,500 — requests block after that).
 * The exported `tasksSpent` counter is the budget ledger. run-preipo.ts
 * sets a hard per-run ceiling that is checked before every metered request.
 */
import { fetchJson, HttpError } from '../lib/http.js';
import { log } from '../lib/log.js';
import { regionForCountry, type Region } from '../lib/regions.js';
import { capClass } from '../lib/caps.js';
import type { AssetRow } from '../lib/supabase.js';

const BASE = 'https://sacra.com/api/v1';

let apiKey = '';
let taskBudget = Number.POSITIVE_INFINITY;
export function initSacra(key: string, budget = Number.POSITIVE_INFINITY) {
  apiKey = key;
  taskBudget = budget;
  tasksSpent = 0;
}

/** Metered tasks consumed so far in this process (1 per company per request). */
export let tasksSpent = 0;

async function sacraGet<T>(path: string, params: Record<string, string>, taskCost: number): Promise<T> {
  if (!apiKey) throw new Error('sacra source not initialized — call initSacra(key) first');
  if (tasksSpent + taskCost > taskBudget) {
    throw new Error(`Sacra task budget exceeded: ${tasksSpent + taskCost} requested, ${taskBudget} allowed`);
  }
  const url = `${BASE}${path}?${new URLSearchParams(params)}`;
  tasksSpent += taskCost;
  return fetchJson<T>(url, {
    headers: { Authorization: `Token ${apiKey}` },
    label: `sacra ${path}`,
    // Sacra meters every request. A scheduled retry could spend again without
    // knowing whether the first request was charged, so this source does not retry.
    retries: 0,
  });
}

// ---- vendor shapes (subset we consume; live-verified 2026-07-10) ----

interface SacraFinancial {
  name: 'latest_estimated_revenue' | 'latest_estimated_valuation' | 'total_estimated_funding';
  value: number | null;
  date: string | null;
}

export interface SacraCompany {
  id: number;
  slug: string;
  name: string;
  domain: string;
  type: string; // 'private' | 'public' …
  is_active: boolean;
  description: string | null;
  founding_year: number | null;
  headquarters?: { city?: string | null; country?: string | null } | null;
  categories?: { name: string; slug: string }[];
  financials?: SacraFinancial[];
  listings?: unknown[];
  updated_at?: string;
}

export interface SacraEvent {
  event_type: string; // funding_round | secondary_transaction | corporate_action | company_milestone
  event_subtype: string | null; // growth, series_h, direct_sale, tender_offer, ipo…
  event_date: string | null;
  event_status: string | null; // announced | closed | cancelled
  company: { domain: string | null; slug: string | null };
  data?: {
    amount_raised?: string | null;
    transaction_amount?: string | null;
    valuation?: string | null;
    round_type?: string | null;
    transaction_type?: string | null;
  };
}

/**
 * Fetch one watchlist company by domain. The domain lookup returns the full
 * detail payload (financials, categories, listings — live-verified), so this
 * is 1 task per company. Returns null when Sacra doesn't cover the domain.
 */
export async function fetchCompany(domain: string): Promise<SacraCompany | null> {
  try {
    const res = await sacraGet<{ company: SacraCompany }>('/companies/', { company_domain: domain }, 1);
    return res.company ?? null;
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) return null;
    throw err;
  }
}

/** Batched events for all watchlist domains: funding, secondaries, corporate
 * actions over the trailing 12 months. 1 task per domain in one request. */
export async function fetchEvents(domains: string[]): Promise<Map<string, SacraEvent[]>> {
  const byDomain = new Map<string, SacraEvent[]>();
  if (domains.length === 0) return byDomain;
  const start = new Date(Date.now() - 365 * 86400_000).toISOString().slice(0, 10);
  let cursor: string | null = null;
  do {
    const params: Record<string, string> = {
      company_domains: domains.join(','),
      types: 'funding-round,secondary-transaction,corporate-action',
      start_date: start,
      pagination: 'cursor',
      page_size: '100',
    };
    if (cursor) params.page_after = cursor;
    // Only the first page is metered per company; follow-up cursor pages of the
    // same query re-touch the same companies, so count them again to stay honest.
    const res = await sacraGet<{ events: SacraEvent[]; pagination?: { next_cursor?: string | null } }>(
      '/events/', params, domains.length,
    );
    for (const ev of res.events ?? []) {
      const d = ev.company?.domain;
      if (!d) continue;
      if (!byDomain.has(d)) byDomain.set(d, []);
      byDomain.get(d)!.push(ev);
    }
    cursor = res.pagination?.next_cursor ?? null;
  } while (cursor);
  return byDomain;
}

// ---- mapping ----

/** Sacra reports full country names, not ISO codes. */
const COUNTRY_ISO: Record<string, string> = {
  'united states': 'US', 'united kingdom': 'GB', germany: 'DE', france: 'FR',
  ireland: 'IE', netherlands: 'NL', sweden: 'SE', switzerland: 'CH',
  denmark: 'DK', norway: 'NO', finland: 'FI', italy: 'IT', spain: 'ES',
  austria: 'AT', belgium: 'BE', estonia: 'EE', lithuania: 'LT', poland: 'PL',
  china: 'CN', 'hong kong': 'HK', singapore: 'SG', japan: 'JP', 'south korea': 'KR',
  india: 'IN', israel: 'IL', australia: 'AU', canada: 'CA', brazil: 'BR',
};

function regionFor(c: SacraCompany): Region {
  const name = c.headquarters?.country?.trim().toLowerCase();
  return regionForCountry(name ? COUNTRY_ISO[name] ?? null : null);
}

/** A company that IPO'd (or otherwise left the private universe) must drop out
 * of the pre-IPO category — it graduates to the FMP universe on its own. */
export function hasGraduated(c: SacraCompany, events: SacraEvent[] = []): boolean {
  if (c.type !== 'private') return true;
  if ((c.listings ?? []).length > 0) return true;
  return events.some(
    (e) => e.event_type === 'corporate_action' && e.event_subtype === 'ipo' && e.event_status !== 'cancelled',
  );
}

const fmtUsd = (n: number): string =>
  n >= 1e12 ? `$${(n / 1e12).toFixed(1)}T`
  : n >= 1e9 ? `$${(n / 1e9).toFixed(1)}B`
  : n >= 1e6 ? `$${(n / 1e6).toFixed(0)}M`
  : `$${Math.round(n).toLocaleString('en-US')}`;

const fmtMonth = (iso: string | null | undefined): string =>
  iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : '';

function financial(c: SacraCompany, name: SacraFinancial['name']): SacraFinancial | null {
  return c.financials?.find((f) => f.name === name && f.value != null) ?? null;
}

/** One compact line per recent event, newest first. */
function eventLines(events: SacraEvent[], max = 4): string[] {
  return [...events]
    .filter((e) => e.event_status !== 'cancelled' && e.event_date)
    .sort((a, b) => (b.event_date ?? '').localeCompare(a.event_date ?? ''))
    .slice(0, max)
    .map((e) => {
      const when = fmtMonth(e.event_date);
      const amt = Number(e.data?.amount_raised ?? e.data?.transaction_amount);
      const val = Number(e.data?.valuation);
      const what =
        e.event_type === 'funding_round' ? `${(e.data?.round_type ?? 'funding').replace(/_/g, ' ')} round`
        : e.event_type === 'secondary_transaction' ? `${(e.data?.transaction_type ?? 'secondary').replace(/_/g, ' ')} secondary`
        : (e.event_subtype ?? e.event_type).replace(/_/g, ' ');
      const parts = [what];
      if (Number.isFinite(amt) && amt > 0) parts.push(fmtUsd(amt));
      if (Number.isFinite(val) && val > 0) parts.push(`at ${fmtUsd(val)} valuation`);
      return `${when}: ${parts.join(', ')}`;
    });
}

/** Latest estimated valuation: profile financial, superseded by any newer
 * priced event (the profile field can lag the event stream — §4.2b gotchas). */
export function latestValuation(c: SacraCompany, events: SacraEvent[]): { value: number; date: string | null } | null {
  const fin = financial(c, 'latest_estimated_valuation');
  let best: { value: number; date: string | null } | null =
    fin?.value ? { value: fin.value, date: fin.date } : null;
  for (const e of events) {
    const val = Number(e.data?.valuation);
    if (!Number.isFinite(val) || val <= 0 || e.event_status === 'cancelled') continue;
    // Vendor quirk (live-observed): some secondaries report `valuation` equal
    // to the transaction amount (a $100M Shein share sale ≠ a $100M Shein) —
    // that field is the deal size there, not a company valuation. Skip it.
    const amt = Number(e.data?.amount_raised ?? e.data?.transaction_amount);
    if (e.event_type === 'secondary_transaction' && Number.isFinite(amt) && amt === val) continue;
    if (!best || (e.event_date ?? '') > (best.date ?? '')) best = { value: val, date: e.event_date };
  }
  return best;
}

/** Map a Sacra company (+ its recent events) to an assets row (spec §4.2b). */
export function toAssetRow(c: SacraCompany, events: SacraEvent[]): AssetRow {
  const revenue = financial(c, 'latest_estimated_revenue');
  const valuation = latestValuation(c, events);
  const funding = financial(c, 'total_estimated_funding');
  const cats = (c.categories ?? []).map((x) => x.name);

  const profileBits = [
    revenue?.value ? `estimated revenue ${fmtUsd(revenue.value)} (${fmtMonth(revenue.date)})` : '',
    valuation ? `estimated valuation ${fmtUsd(valuation.value)} (${fmtMonth(valuation.date)})` : '',
    funding?.value ? `total funding raised ${fmtUsd(funding.value)}` : '',
  ].filter(Boolean);
  const recent = eventLines(events);
  const hq = [c.headquarters?.city, c.headquarters?.country].filter(Boolean).join(', ');
  const description = [
    c.description ?? '',
    `Pre-IPO private company${profileBits.length ? ` — ${profileBits.join('; ')}` : ''}.`,
    recent.length ? `Recent: ${recent.join('. ')}.` : '',
    [hq ? `HQ ${hq}` : '', c.founding_year ? `founded ${c.founding_year}` : ''].filter(Boolean).join('; '),
  ].filter(Boolean).join('\n');

  return {
    ticker: c.slug.toUpperCase(),
    vendor_id: c.domain,
    source: 'sacra',
    name: c.name,
    kind: 'private',
    region: regionFor(c),
    market_cap_usd: valuation?.value ?? null,
    cap_class: capClass(valuation?.value),
    sector: cats[0] ?? null,
    categories: [...cats, 'pre-IPO'],
    description,
    website_url: `https://${c.domain}`,
    currency: 'USD',
    is_active: true,
  };
}

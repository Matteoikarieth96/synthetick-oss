/**
 * Financial requirements on a thesis (spec §15.3/§15.4).
 *
 * A thesis may carry quantitative requirements — "ETFs with AUM above 500m",
 * "TER below 0.50% listed in EUR", "market cap between 100m and 1bn and P/E
 * below 12". They bind exactly like the §5.4 requirements: enforced
 * deterministically in code, before /select sees a candidate, so no model is
 * ever asked to check arithmetic it cannot see.
 *
 * Three shapes:
 *   - metric bounds   {metric, min?, max?}      numbers we hold per asset
 *   - exposures       {kind, name, minWeightPct} a fund's sector/country weights
 *   - categoricals    listing currency, fund domicile
 *
 * Plus `unverifiable`: the asks that have no field behind them. Those are
 * REPORTED, never dropped, because a list that quietly ignores half the
 * question is worse than one that says what it could not check.
 */
import { callClaude, parseJSON } from './llm.js';
import { log } from '../ingest/lib/log.js';
import { supabase } from '../ingest/lib/supabase.js';
import type { EtfPortfolio } from '../ingest/lib/supabase.js';

const finreqModel = () => process.env.SIGNAL_FINREQ_MODEL || 'google/gemini-2.5-flash';

/** Where a requirement's value comes from. */
type Source = 'metrics' | 'fund';

export interface MetricSpec {
  /** Column on asset_metrics, or a derived fund field. */
  key: string;
  label: string;
  source: Source;
  /** 'usd' | 'pct' | 'ratio' | 'years' | 'shares' | 'score' — display only. */
  unit: string;
  /** Fund AUM and company market cap are the same column, different words. */
  note?: string;
  /**
   * A valuation multiple, where a NEGATIVE value is meaningless rather than
   * extremely cheap. "P/E below 12" must not admit a P/E of -24: that company
   * is loss-making, not a bargain, and it is not what anyone means. So an
   * upper bound on these keys also requires the value to be positive
   * (live 2026-07-28: doValue at -24.4 and Tinexta at -14.8 satisfied
   * "P/E below 12" until this existed).
   */
  positiveOnly?: boolean;
}

/**
 * The closed vocabulary. The extractor picks keys from here and never invents
 * one, so an unsupported ask fails as an explicit "cannot verify" rather than
 * a filter on the wrong column.
 */
export const SPECS: Record<string, MetricSpec> = {
  // ---- company metrics (asset_metrics) ----
  market_cap_usd: { key: 'market_cap_usd', label: 'market cap', source: 'metrics', unit: 'usd', note: 'for funds this is AUM' },
  pe: { key: 'pe', label: 'P/E', source: 'metrics', unit: 'ratio' , positiveOnly: true },
  // forward_pe is deliberately NOT here: asset_metrics has the column but no
  // ingest job ever writes it, so offering it to the extractor produced a bound
  // that every asset failed as "cannot verify" and an empty result. An ask for
  // it now lands in `unverifiable` (see normalizeRawFinReq) and is reported.
  price_to_book: { key: 'price_to_book', label: 'price/book', source: 'metrics', unit: 'ratio' , positiveOnly: true },
  price_to_sales: { key: 'price_to_sales', label: 'price/sales', source: 'metrics', unit: 'ratio' , positiveOnly: true },
  ev_to_ebitda: { key: 'ev_to_ebitda', label: 'EV/EBITDA', source: 'metrics', unit: 'ratio' , positiveOnly: true },
  dividend_yield_pct: { key: 'dividend_yield_pct', label: 'dividend yield', source: 'metrics', unit: 'pct' },
  revenue_growth_pct: { key: 'revenue_growth_pct', label: 'revenue growth', source: 'metrics', unit: 'pct' },
  earnings_growth_pct: { key: 'earnings_growth_pct', label: 'earnings growth', source: 'metrics', unit: 'pct' },
  gross_margin_pct: { key: 'gross_margin_pct', label: 'gross margin', source: 'metrics', unit: 'pct' },
  operating_margin_pct: { key: 'operating_margin_pct', label: 'operating margin', source: 'metrics', unit: 'pct' },
  net_margin_pct: { key: 'net_margin_pct', label: 'net margin', source: 'metrics', unit: 'pct' },
  roe: { key: 'roe', label: 'return on equity', source: 'metrics', unit: 'ratio' },
  roic: { key: 'roic', label: 'return on invested capital', source: 'metrics', unit: 'ratio' },
  debt_to_equity: { key: 'debt_to_equity', label: 'debt/equity', source: 'metrics', unit: 'ratio' },
  net_debt_to_ebitda: { key: 'net_debt_to_ebitda', label: 'net debt/EBITDA', source: 'metrics', unit: 'ratio' },
  fcf_per_share: { key: 'fcf_per_share', label: 'free cash flow per share', source: 'metrics', unit: 'ratio' },
  fcf_yield_pct: { key: 'fcf_yield_pct', label: 'free cash flow yield', source: 'metrics', unit: 'pct' },
  current_ratio: { key: 'current_ratio', label: 'current ratio', source: 'metrics', unit: 'ratio' },
  interest_coverage: { key: 'interest_coverage', label: 'interest coverage', source: 'metrics', unit: 'ratio' },
  altman_z: { key: 'altman_z', label: 'Altman Z-score', source: 'metrics', unit: 'score' },
  piotroski: { key: 'piotroski', label: 'Piotroski score', source: 'metrics', unit: 'score' },
  beta: { key: 'beta', label: 'beta', source: 'metrics', unit: 'ratio' },
  return_30d_pct: { key: 'return_30d_pct', label: '30-day return', source: 'metrics', unit: 'pct' },
  return_ytd_pct: { key: 'return_ytd_pct', label: 'year-to-date return', source: 'metrics', unit: 'pct' },
  return_1y_pct: { key: 'return_1y_pct', label: '12-month return', source: 'metrics', unit: 'pct' },
  avg_volume: { key: 'avg_volume', label: 'average daily volume', source: 'metrics', unit: 'shares' },

  // ---- fund fields (assets.etf_portfolio) ----
  aum_usd: { key: 'aum_usd', label: 'AUM', source: 'fund', unit: 'usd' },
  ter_pct: { key: 'ter_pct', label: 'TER', source: 'fund', unit: 'pct', note: 'expense ratio, percent units' },
  track_record_years: { key: 'track_record_years', label: 'track record', source: 'fund', unit: 'years' },
  fund_avg_volume: { key: 'fund_avg_volume', label: 'fund average daily volume', source: 'fund', unit: 'shares' },
  holdings_count: { key: 'holdings_count', label: 'number of holdings', source: 'fund', unit: 'score' },
};

export interface Bound {
  key: string;
  min?: number | null;
  max?: number | null;
}

export interface Exposure {
  kind: 'sector' | 'country';
  name: string;
  minWeightPct: number;
}

export interface FinReq {
  bounds: Bound[];
  exposures: Exposure[];
  /** Listing currency codes the asset must trade in, e.g. ['EUR']. */
  currencies: string[];
  /** Fund domicile ISO codes, e.g. ['IE','LU'] for UCITS. */
  domiciles: string[];
  /** Asks with no field behind them, surfaced verbatim to the user. */
  unverifiable: string[];
}

export const EMPTY_FINREQ: FinReq = { bounds: [], exposures: [], currencies: [], domiciles: [], unverifiable: [] };

export function hasFinReq(r: FinReq | null | undefined): boolean {
  return !!r && (r.bounds.length > 0 || r.exposures.length > 0 || r.currencies.length > 0 || r.domiciles.length > 0);
}

// ---- extraction ------------------------------------------------------------

function vocabulary(): string {
  return Object.values(SPECS)
    .map((s) => `${s.key} (${s.label}${s.note ? `; ${s.note}` : ''}, ${s.unit})`)
    .join('\n');
}

const SYSTEM = `You extract QUANTITATIVE REQUIREMENTS from an investment request. Answer with STRICT JSON only, no prose.

{"bounds":[{"key":"aum_usd","min":500000000}],"exposures":[{"kind":"sector","name":"Energy","minWeightPct":50}],"currencies":["EUR"],"domiciles":[],"unverifiable":[]}

"key" must be exactly one of:
${vocabulary()}

Rules:
- Only extract requirements the user actually states as a CONDITION on the results. The investment view itself is not a requirement: "I believe in nuclear" constrains nothing, "with AUM above 500m" does.
- Units matter. usd: write full numbers, so "500m" is 500000000 and "1bn" is 1000000000. pct: write percent numbers, so "TER below 0.50%" is {"key":"ter_pct","max":0.5} and "fell more than 20% over 12 months" is {"key":"return_1y_pct","max":-20}. years: "at least 3 years of track record" is {"key":"track_record_years","min":3}. shares: "daily volume above 1m" is {"key":"avg_volume","min":1000000} for companies or fund_avg_volume for funds.
- "between X and Y" is one bound with both min and max.
- "positive free cash flow" is {"key":"fcf_per_share","min":0}.
- Forward P/E, revenue or earnings CAGR, analyst target upside and any other figure missing from the key list above have NO key: put them in unverifiable, never invent a key.
- dividend_yield_pct is a COMPANY figure. A yield requirement on a FUND or a bond ("bond ETFs with a yield above 5%") has no key here, so it goes in unverifiable, not into dividend_yield_pct.
- Use aum_usd (not market_cap_usd) when the subject is funds; use market_cap_usd for companies.
- Use fund_avg_volume for funds, avg_volume for companies.
- "exposures" is for funds only, and is a NARROW tool. Use it for a COUNTRY the user requires the fund to track ("ETFs tracking India" -> {"kind":"country","name":"India","minWeightPct":50}). Use it for a sector ONLY when the user names one of these exact sectors as a requirement: Technology, Financial Services, Healthcare, Industrials, Consumer Cyclical, Consumer Defensive, Energy, Basic Materials, Real Estate, Utilities, Communication Services. Do NOT invent a sector for a theme: "nuclear", "copper miners", "defense", "water", "gold" and "cybersecurity" are THEMES, not sectors, and mapping them to a sector would wrongly exclude the right funds. Leave exposures empty for themes. Default minWeightPct 50 unless the user states a number.
- "currencies": ISO codes, only when the user requires a listing currency ("listed in EUR" -> ["EUR"]).
- "domiciles": ISO codes, only for an explicit domicile or wrapper requirement. "UCITS" -> ["IE","LU"].
- "unverifiable": ONLY for a MEASURABLE CONDITION that has no key above. Belongs here: revenue share from a customer type or segment, buyback announcements, EV or product-line share of revenue, whether production is already online, average bond maturity or duration, a bond or fund yield to maturity, actively-vs-passively managed, discount or premium to NAV, credit rating.
  NEVER put these in unverifiable, because they are handled elsewhere in the product and listing them would falsely tell the user we ignored their request: the investment theme or story ("water scarcity", "barbell on AI", "grid infrastructure"), a business description or industry in words ("cardiac device makers", "tier 1 auto suppliers", "producers and developers", "grid equipment makers"), a geography or market ("in Europe", "Milan listed", "Japanese"), an asset class ("ETFs", "bonds", "companies"), or how many results to return.
- Extract nothing else. No sectors, regions, asset classes or ticker lists: those are handled elsewhere. Empty arrays are the correct answer for a request with no numeric conditions.`;

export interface RawReq {
  bounds?: { key?: string; min?: number | null; max?: number | null }[];
  exposures?: { kind?: string; name?: string; minWeightPct?: number | null }[];
  currencies?: unknown[];
  domiciles?: unknown[];
  unverifiable?: unknown[];
}

/** One cheap call, run in parallel with buildThesis. Never throws: a failed
 * extraction degrades to "no requirements", which is the pre-§15 behavior. */
export async function extractFinReq(text: string): Promise<FinReq> {
  if (!text?.trim()) return EMPTY_FINREQ;
  let raw: string;
  try {
    raw = await callClaude(text.slice(0, 6000), {
      system: SYSTEM,
      // 1800, not 900: prompts 3 and 5 came back empty and truncated
      // mid-object respectively, because the flash model spends tokens before
      // it emits and this schema has six keys to fill (2026-07-28).
      maxTokens: 1800,
      temperature: 0,
      model: finreqModel(),
    });
  } catch (err) {
    log.warn(`financial requirement extraction failed: ${(err as Error).message}`);
    return EMPTY_FINREQ;
  }
  let parsed: RawReq;
  try {
    parsed = parseJSON<RawReq>(raw);
  } catch (err) {
    log.warn(`financial requirement extraction returned non-JSON: ${(err as Error).message}`);
    return EMPTY_FINREQ;
  }
  return normalizeRawFinReq(parsed);
}

/** Human wording for a bound on a key we do not hold, so the ask can be
 * reported verbatim-ish in `unverifiable` instead of vanishing. */
function describeUnknownBound(key: string, min: number | null, max: number | null): string {
  const name = key.replace(/_/g, ' ').trim().slice(0, 40);
  if (min != null && max != null) return `${name} between ${min} and ${max}`;
  if (min != null) return `${name} at or above ${min}`;
  return `${name} at or below ${max}`;
}

/**
 * Pure half of extractFinReq: turn the model's parsed JSON into a validated
 * FinReq. Exported for offline tests. A bound on a key outside SPECS (the model
 * guessed one, e.g. forward_pe) is NOT dropped silently: it is moved to
 * `unverifiable`, so the user is told it was not applied.
 */
export function normalizeRawFinReq(parsed: RawReq | null | undefined): FinReq {
  const p: RawReq = parsed && typeof parsed === 'object' ? parsed : {};
  // null must stay null (Number(null) is 0): a "max": null from the model
  // would otherwise become an upper bound of 0 and exclude every asset.
  const num = (v: unknown) => (v == null ? null : Number.isFinite(Number(v)) ? Number(v) : null);
  const list = <T,>(x: T[] | undefined): T[] => (Array.isArray(x) ? x : []);
  const bounds: Bound[] = [];
  const unverifiable: string[] = [];
  for (const b of list(p.bounds)) {
    if (!b || typeof b.key !== 'string') continue;
    const min = num(b.min);
    const max = num(b.max);
    if (min == null && max == null) continue;
    if (Object.hasOwn(SPECS, b.key)) bounds.push({ key: b.key, min, max });
    else unverifiable.push(describeUnknownBound(b.key, min, max));
  }
  const exposures: Exposure[] = list(p.exposures)
    .filter((e) => e && (e.kind === 'sector' || e.kind === 'country') && typeof e.name === 'string' && e.name.trim())
    .map((e) => ({
      kind: e.kind as 'sector' | 'country',
      name: (e.name as string).trim().slice(0, 40),
      minWeightPct: Math.max(0, Math.min(100, num(e.minWeightPct) ?? 50)),
    }));
  const codes = (xs: unknown[] | undefined) =>
    [...new Set(list(xs).map((x) => String(x).trim().toUpperCase()).filter((x) => /^[A-Z]{2,3}$/.test(x)))];
  const said = list(p.unverifiable).map((x) => String(x).trim()).filter(Boolean);
  return {
    bounds,
    exposures,
    currencies: codes(p.currencies),
    domiciles: codes(p.domiciles),
    unverifiable: [...new Set([...said, ...unverifiable])].slice(0, 8),
  };
}

/**
 * Sanitize a requirement set posted back from the review card (server body →
 * FinReq). The browser may only REMOVE what the extractor found; every value
 * is re-validated here so a crafted body cannot filter on an arbitrary column.
 * Lives beside extractFinReq because it must mirror the shape that function
 * emits — including its explicit nulls: Number(null) is 0, so a naive numeric
 * check turned "AUM at or above $200M" into "AUM between $200M and $0" and
 * every browser run with a requirement chip returned empty while API runs
 * (which re-extract from text) passed (live 2026-07-28).
 */
export function sanitizeFinReq(raw: unknown): FinReq | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown) => (v == null ? null : Number.isFinite(Number(v)) ? Number(v) : null);
  // Every list is capped (audit N2): the whole object is echoed into the
  // compliance auditor's prompt, so an uncapped body would be an amplifier.
  const items = (xs: unknown): unknown[] => (Array.isArray(xs) ? xs.slice(0, MAX_FINREQ_SCAN) : []);
  const seenKeys = new Set<string>();
  const bounds = items(r.bounds)
    .map((b) => b as Record<string, unknown>)
    .filter((b) => typeof b?.key === 'string' && Object.hasOwn(SPECS, b.key as string))
    .map((b) => ({ key: String(b.key), min: num(b.min), max: num(b.max) }))
    .filter((b) => (b.min != null || b.max != null) && !seenKeys.has(b.key) && !!seenKeys.add(b.key))
    .slice(0, MAX_FINREQ_ITEMS);
  const exposures = items(r.exposures)
    .map((e) => e as Record<string, unknown>)
    .filter((e) => (e?.kind === 'sector' || e?.kind === 'country') && typeof e?.name === 'string')
    .map((e) => ({
      kind: e.kind as 'sector' | 'country',
      name: String(e.name).slice(0, 40),
      minWeightPct: Math.max(0, Math.min(100, num(e.minWeightPct) ?? 50)),
    }))
    .slice(0, MAX_FINREQ_ITEMS);
  const codes = (xs: unknown) => [
    ...new Set(
      items(xs)
        .map((x) => String(x).slice(0, 8).toUpperCase())
        .filter((x) => /^[A-Z]{2,3}$/.test(x)),
    ),
  ].slice(0, MAX_FINREQ_ITEMS);
  const strings = (xs: unknown) => items(xs).map((x) => String(x).slice(0, 120)).filter(Boolean).slice(0, 8);
  return {
    bounds,
    exposures,
    currencies: codes(r.currencies),
    domiciles: codes(r.domiciles),
    unverifiable: strings(r.unverifiable),
  };
}

/** Most bounds (one per metric) and exposures a browser-posted requirement set may keep. */
export const MAX_FINREQ_ITEMS = 12;
/** How many entries of each posted list are even looked at (work cap before filtering). */
const MAX_FINREQ_SCAN = 100;

// ---- enforcement -----------------------------------------------------------

/** The per-asset facts a requirement check needs. */
export interface AssetFacts {
  assetId: number;
  kind: string;
  currency: string | null;
  marketCapUsd: number | null;
  portfolio: EtfPortfolio | null;
  metrics: Record<string, number | null>;
}

const FUND_KINDS = new Set(['etf', 'bond']);

/** Years between a fund's inception date and today; null when unknown. */
export function trackRecordYears(inception: string | null | undefined): number | null {
  if (!inception) return null;
  const t = Date.parse(inception);
  if (!Number.isFinite(t)) return null;
  return (Date.now() - t) / (365.25 * 86400_000);
}

/**
 * Resolve one requirement key to a number for this asset, or null when we do
 * not hold it. Null is the reason an asset gets excluded (spec §15.4), so the
 * distinction between "fails the bound" and "cannot be checked" is kept.
 */
export function factFor(key: string, a: AssetFacts): number | null {
  const spec = SPECS[key];
  if (!spec) return null;
  if (spec.source === 'metrics') {
    // Company market cap and fund AUM are the same stored column.
    if (key === 'market_cap_usd') return a.metrics.market_cap_usd ?? a.marketCapUsd ?? null;
    return a.metrics[key] ?? null;
  }
  const pf = a.portfolio;
  switch (key) {
    case 'aum_usd':
      // Fund AUM is what market_cap_usd holds for etf/bond rows (§4.1).
      return FUND_KINDS.has(a.kind) ? (a.metrics.market_cap_usd ?? a.marketCapUsd ?? null) : null;
    case 'ter_pct':
      return pf?.expense_ratio ?? null;
    case 'track_record_years':
      return trackRecordYears(pf?.inception_date ?? null);
    case 'fund_avg_volume':
      return pf?.avg_volume ?? null;
    case 'holdings_count':
      return pf?.holdings_count ?? null;
    default:
      return null;
  }
}

/**
 * Do two sector/country names refer to the same thing? Compares whole words,
 * not substrings: the old `includes` check let "oman" match "Romania", "us"
 * match "Austria"/"Australia" and "niger" match "Nigeria", summing the
 * weights of unrelated countries. One name may still contain the other as a
 * run of whole words ("korea" ~ "south korea", "united states" ~ "united
 * states of america"). Exported for offline tests.
 */
export function sameName(a: string, b: string): boolean {
  const tok = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  const x = tok(a);
  const y = tok(b);
  if (!x.length || !y.length) return false;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  for (let i = 0; i + short.length <= long.length; i++) {
    if (short.every((w, j) => long[i + j] === w)) return true;
  }
  return false;
}

/** Weight of a named sector/country in a fund, or null when we have no
 * breakdown at all. A breakdown that exists but omits the name means zero. */
export function exposureWeight(e: Exposure, a: AssetFacts): number | null {
  const slices = e.kind === 'sector' ? a.portfolio?.sector_weights : a.portfolio?.region_weights;
  if (!Array.isArray(slices) || !slices.length) return null;
  const target = e.name.toLowerCase();
  let total = 0;
  let matched = false;
  for (const s of slices) {
    const name = (s?.name ?? '').toLowerCase();
    if (!name) continue;
    if (sameName(name, target)) {
      matched = true;
      total += Number(s.weight ?? 0);
    }
  }
  return matched ? total : 0;
}

export interface CheckResult {
  pass: boolean;
  /** Requirement keys we could not evaluate for this asset. */
  unchecked: string[];
}

/**
 * Does this asset satisfy every requirement? An asset we cannot verify does
 * NOT qualify (user decision 2026-07-28) — but the keys that could not be
 * checked come back so the run can report coverage honestly.
 */
export function checkAsset(req: FinReq, a: AssetFacts): CheckResult {
  const unchecked: string[] = [];
  let pass = true;
  for (const b of req.bounds) {
    const v = factFor(b.key, a);
    if (v == null) {
      unchecked.push(b.key);
      pass = false;
      continue;
    }
    if (b.min != null && v < b.min) pass = false;
    if (b.max != null && v > b.max) pass = false;
    // An upper bound on a valuation multiple implies a positive one.
    if (b.max != null && SPECS[b.key]?.positiveOnly && v <= 0) pass = false;
  }
  for (const e of req.exposures) {
    const w = exposureWeight(e, a);
    if (w == null) {
      unchecked.push(`${e.kind}:${e.name}`);
      pass = false;
      continue;
    }
    if (w < e.minWeightPct) pass = false;
  }
  if (req.currencies.length) {
    const c = (a.currency ?? '').toUpperCase();
    if (!c) {
      unchecked.push('currency');
      pass = false;
    } else if (!req.currencies.includes(c)) pass = false;
  }
  if (req.domiciles.length) {
    const d = (a.portfolio?.domicile ?? '').toUpperCase();
    if (!d) {
      unchecked.push('domicile');
      pass = false;
    } else if (!req.domiciles.includes(d)) pass = false;
  }
  return { pass, unchecked };
}

// ---- loading facts ---------------------------------------------------------

const METRIC_COLUMNS = Object.values(SPECS)
  .filter((s) => s.source === 'metrics')
  .map((s) => s.key);

/** Load the facts for a set of candidate assets in one round trip each. */
export async function loadFacts(assetIds: number[]): Promise<Map<number, AssetFacts>> {
  const out = new Map<number, AssetFacts>();
  if (!assetIds.length) return out;
  const [{ data: assetRows, error: aErr }, { data: metricRows, error: mErr }] = await Promise.all([
    supabase.from('assets').select('id, kind, currency, market_cap_usd, etf_portfolio').in('id', assetIds),
    supabase.from('asset_metrics').select(`asset_id, ${METRIC_COLUMNS.join(', ')}`).in('asset_id', assetIds),
  ]);
  if (aErr) throw new Error(`loadFacts assets failed: ${aErr.message}`);
  // A missing asset_metrics table must not break the screen: without it every
  // numeric requirement is simply uncheckable, which the caller reports.
  if (mErr) log.warn(`loadFacts metrics unavailable: ${mErr.message}`);
  // The column list is built at runtime, so supabase-js cannot infer a row
  // type for it; rowsToFacts validates the values field by field.
  return rowsToFacts(
    (assetRows ?? []) as Record<string, unknown>[],
    ((metricRows ?? []) as unknown) as Record<string, unknown>[],
  );
}

/** SQL NULL / missing / non-numeric → null. NEVER Number(null), which is 0:
 * run-metrics writes a row for every asset with null for each metric a family
 * did not supply, and 0 would make "net debt/EBITDA below 3" or "positive free
 * cash flow" pass assets we have no data for (spec §15.4: missing = cannot
 * verify). */
export function toNum(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Pure row → facts mapper behind loadFacts. Exported for offline tests. */
export function rowsToFacts(
  assetRows: Record<string, unknown>[],
  metricRows: Record<string, unknown>[],
): Map<number, AssetFacts> {
  const out = new Map<number, AssetFacts>();
  const metricsById = new Map<number, Record<string, number | null>>();
  for (const r of metricRows) {
    const vals: Record<string, number | null> = {};
    for (const c of METRIC_COLUMNS) vals[c] = toNum(r[c]);
    metricsById.set(Number(r.asset_id), vals);
  }
  for (const r of assetRows) {
    const id = Number(r.id);
    out.set(id, {
      assetId: id,
      kind: String(r.kind ?? ''),
      currency: (r.currency as string) ?? null,
      marketCapUsd: toNum(r.market_cap_usd),
      portfolio: (r.etf_portfolio as EtfPortfolio) ?? null,
      metrics: metricsById.get(id) ?? {},
    });
  }
  return out;
}

// ---- human wording --------------------------------------------------------

function fmtValue(v: number, unit: string): string {
  if (unit === 'usd') {
    const abs = Math.abs(v);
    if (abs >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
    if (abs >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
    if (abs >= 1e6) return `$${(v / 1e6).toFixed(0)}M`;
    return `$${v}`;
  }
  if (unit === 'pct') return `${v}%`;
  if (unit === 'years') return `${v} years`;
  if (unit === 'shares') return v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : `${v}`;
  return String(v);
}

/** One-line summary of the requirements, for status lines and the card. */
export function finReqSummary(req: FinReq): string[] {
  const parts: string[] = [];
  for (const b of req.bounds) {
    const spec = SPECS[b.key]!;
    if (b.min != null && b.max != null) {
      parts.push(`${spec.label} between ${fmtValue(b.min, spec.unit)} and ${fmtValue(b.max, spec.unit)}`);
    } else if (b.min != null) {
      parts.push(`${spec.label} at or above ${fmtValue(b.min, spec.unit)}`);
    } else if (b.max != null) {
      parts.push(`${spec.label} at or below ${fmtValue(b.max, spec.unit)}`);
    }
  }
  for (const e of req.exposures) parts.push(`at least ${e.minWeightPct}% in ${e.name}`);
  if (req.currencies.length) parts.push(`listed in ${req.currencies.join(' or ')}`);
  if (req.domiciles.length) parts.push(`domiciled in ${req.domiciles.join(' or ')}`);
  return parts;
}

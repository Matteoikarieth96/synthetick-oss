/**
 * /analysis (spec §5.5) — v3 explainPicks unchanged: final picks only, full
 * budget; per pick 3 sentences (evidence / mechanism / fit-or-caveat);
 * filler banned; varied structure.
 */
import { z } from 'zod';
import { log } from '../ingest/lib/log.js';
import { callClaude, parseJSON } from './llm.js';
import { reqSummary, type Crit } from './requirements.js';
import { portfolioLine, sizeBand, type Candidate } from './candidates.js';
import type { Pick } from './select.js';
import { clipText } from './text.js';
import { analysisNeedsHygiene, type AnalysisHygiene } from './display-policy.js';

/** One analysis line per pick (§5.5 2026-07-23): the size field carries the
 * row's banded AUM/market cap — without it the prose invented figures (SMH
 * "AUM near $10B", actually ~$70B). Exported for offline tests. */
export function pickAnalysisLine(a: Candidate): string {
  return `${a.ticker}|${a.name}|${a.kind}|${sizeBand(a)}|${a.sector ?? a.categories?.[0] ?? ''}|${[portfolioLine(a.etf_portfolio), (a.blurb ?? '').slice(0, 120)].filter(Boolean).join(' — ')}`;
}

/** The analysis line under the data display policy (runtime/display-policy.ts).
 * The analysis is shown to users, so when a pick's vendor data may not be
 * shown its line carries identity facts and the asset's own enrichment text
 * only: no size band, no ETF holdings, no vendor description. Otherwise it is
 * pickAnalysisLine unchanged. Exported for offline tests. */
export function analysisLineFor(a: Candidate, hygiene?: AnalysisHygiene | null): string {
  if (!analysisNeedsHygiene(a, hygiene)) return pickAnalysisLine(a);
  const own = (hygiene?.ownText.get(a.id) ?? '').replace(/\s+/g, ' ').trim();
  const facts = [
    a.region ? `region ${a.region}` : '',
    a.exchange ? `listed on ${a.exchange}` : '',
    (a.categories ?? []).length ? `categories ${(a.categories ?? []).slice(0, 5).join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('; ');
  return `${a.ticker}|${a.name}|${a.kind}||${a.sector ?? a.categories?.[0] ?? ''}|${[own ? clipText(own, 300) : '', facts].filter(Boolean).join(' — ')}`;
}

export async function explainPicksWithStatus(
  thesisText: string,
  picks: Pick[],
  crit: Crit | null | undefined,
  direction: 'long' | 'short' = 'long',
  /** Injectable for offline tests; production always uses callClaude. */
  call: typeof callClaude = callClaude,
  /** Data display policy: what each pick's prompt line may carry (null = everything). */
  opts: { hygiene?: AnalysisHygiene | null } = {},
): Promise<{ analysis: Record<string, string>; degraded: boolean }> {
  if (!picks.length) return { analysis: {}, degraded: false };
  const list = picks.map((p) => analysisLineFor(p.a, opts.hygiene)).join('\n');
  const binding = reqSummary(crit);
  const short = direction === 'short';
  const sys = short
    ? 'You are a senior investment analyst writing for a sophisticated reader. You explain, concretely and without filler, why each asset stands to LOSE if the user’s thesis plays out — these are SHORT candidates. Output ONLY minified JSON.'
    : 'You are a senior investment analyst writing for a sophisticated reader. You explain, concretely and without filler, why each asset expresses the user’s specific thesis. Output ONLY minified JSON.';
  const framing = short
    ? `For EACH pick write a 3-sentence SHORT-side analysis:\n` +
      `1) EVIDENCE — tie it to the user’s actual argument, quoting or closely paraphrasing a short phrase from their thesis.\n` +
      `2) DAMAGE MECHANISM — concretely what erodes: which revenue line, moat or margin the thesis destroys, and how fast.\n` +
      `3) SHORT CAVEAT — the honest risk of the short: hedged business lines, balance-sheet strength, squeeze/borrow/timing risk.\n`
    : `For EACH pick write a 3-sentence analysis:\n` +
      `1) EVIDENCE — tie it to the user’s actual argument, quoting or closely paraphrasing a short phrase from their thesis.\n` +
      `2) MECHANISM — the concrete way this asset captures that dynamic (what it does, who pays it, what drives its value).\n` +
      `3) FIT OR CAVEAT — either why it’s a core rather than peripheral expression, or the honest limit of the overlap.\n`;
  const usr =
    `USER’S THESIS:\n"""${(thesisText || '').slice(0, 2500)}"""\n` +
    (binding ? `Their binding requirements: ${binding}\n` : '') +
    `\nFINAL ${short ? 'SHORT CANDIDATES' : 'PICKS'} (ticker|name|kind|size|sector|what it does):\n${list}\n\n` +
    framing +
    `The size field is the asset's banded AUM (funds) or market cap: any size claim you write must stay within the shown band — never state a precise figure, and write nothing about size when the field is empty.\n` +
    `Vary the sentence structure across picks; never use “is a good fit”, “well positioned”, “strong play” or similar filler.\n` +
    `Return: {"TICKER":"three sentences", ...} covering every pick. When you quote a phrase from the thesis, wrap it in single quotes ('…') — a double quote inside a JSON string value breaks the output.`;
  // Analysis is explanatory text, not a constraint: one malformed answer must
  // not throw away a whole run (≈5 paid LLM calls). One retry on bad output,
  // then a neutral template line per pick, flagged `degraded` so the caller
  // can say so in the status lines (spec §1: every LLM output is validated
  // JSON with a fallback).
  for (let attempt = 0; attempt < 2; attempt++) {
    let raw: string;
    try {
      raw = await call(usr, { system: sys, maxTokens: 4000 });
    } catch (err) {
      // callClaude already retries transport errors; do not double the wait.
      log.warn(`analysis call failed: ${(err as Error).message}`);
      break;
    }
    try {
      const out = parseAnalysis(raw, picks);
      if (Object.keys(out).length) return { analysis: out, degraded: false };
      log.warn('analysis answer carried no usable line for any pick');
    } catch (err) {
      log.warn(`analysis attempt ${attempt + 1} returned unusable output: ${(err as Error).message}`);
    }
  }
  return { analysis: fallbackAnalysis(picks), degraded: true };
}

/** Back-compat wrapper: the analysis map only. */
export async function explainPicks(
  thesisText: string,
  picks: Pick[],
  crit: Crit | null | undefined,
  direction: 'long' | 'short' = 'long',
): Promise<Record<string, string>> {
  return (await explainPicksWithStatus(thesisText, picks, crit, direction)).analysis;
}

/** Map of ticker → text. Values the model returned as arrays of sentences or
 * numbers are joined/stringified; non-object answers yield {}. */
const AnalysisSchema = z.record(
  z.string(),
  z.preprocess(
    (v) => (Array.isArray(v) ? v.map((x) => String(x)).join(' ') : v == null ? '' : typeof v === 'object' ? '' : String(v)),
    z.string(),
  ),
);

/** Pure: raw model text → {ticker: analysis} for the given picks. Throws only
 * when the text is not JSON at all (so the caller can retry). A model that
 * wraps the map in {"analysis":{…}} is unwrapped. Exported for offline tests. */
export function parseAnalysis(raw: string, picks: Pick[]): Record<string, string> {
  let j: unknown = parseJSON<unknown>(raw);
  if (j && typeof j === 'object' && !Array.isArray(j)) {
    const inner = (j as Record<string, unknown>).analysis;
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) j = inner;
  }
  const parsed = AnalysisSchema.safeParse(j && typeof j === 'object' && !Array.isArray(j) ? j : {});
  if (!parsed.success) return {};
  const byUpper = new Map(Object.entries(parsed.data).map(([k, v]) => [k.toUpperCase(), v]));
  const out: Record<string, string> = {};
  for (const p of picks) {
    const w = byUpper.get(p.a.ticker.toUpperCase());
    if (w && w.length > 60) out[p.a.ticker] = clipText(w, 800);
  }
  return out;
}

/** Neutral per-pick line used when the analysis call is unavailable. States
 * only what the product already knows (the /select score and rationale) and
 * says plainly that the written analysis is missing. Exported for tests. */
export function fallbackAnalysis(picks: Pick[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of picks) {
    const why = clipText(p.why ?? '', 300);
    out[p.a.ticker] =
      `Detailed analysis was unavailable for this run. Ranked ${p.score}/100 on fit with the thesis` +
      (why ? `: ${why}${/[.!?…]$/.test(why) ? '' : '.'}` : '.');
  }
  return out;
}

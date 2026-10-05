/**
 * /select (spec §5.3) — v3 llmSelect adapted: candidate lines now carry
 * region+categories (spec format ticker|name|kind|region|sector|categories|blurb),
 * every returned ticker validated against the candidate set, s≥35 or omit,
 * max 10, fewer-than-10 is correct when true.
 */
import { log } from '../ingest/lib/log.js';
import { callClaude, parseJSON } from './llm.js';
import { reqSummary, prefSummary, type Crit } from './requirements.js';
import { portfolioLine, sizeBand, type Candidate } from './candidates.js';
import type { Thesis } from './thesis.js';
import { clipText } from './text.js';
import { SELECT_RATIONALE_RULE } from './display-policy.js';

export const REL_THRESHOLD = 35; // v3 verbatim: below this, an asset is NOT shown
export const LOW_PRIORITY_CRYPTO_SCORE_CAP = 50;

export interface Pick {
  a: Candidate;
  score: number; // 0–100 absolute
  why: string;
  rel: 'anchor' | 'complement' | 'competitor' | 'adjacent';
  /** Which side of the trade this pick is on (set explicitly in 'both' mode). */
  dir?: 'long' | 'short';
  /** Diversified runs only (spec §5.3): the strategy this pick expresses,
   * verbatim from thesis.strategies; undefined = unattributed ("other"). */
  strategy?: string;
}

function lowPriorityCryptoReason(a: Candidate): 'meme' | 'stablecoin' | null {
  if (a.kind !== 'crypto') return null;
  const text = `${a.ticker} ${a.name} ${a.sector ?? ''} ${(a.categories ?? []).join(' ')}`.toLowerCase();
  if (/\b(stable\s*coin|stablecoin|stablecoins)\b/.test(text)) return 'stablecoin';
  if (/\b(meme\s*coins?|memecoins?|memes?)\b/.test(text)) return 'meme';
  return null;
}

/** Cap meme/stablecoin crypto at 50 — UNLESS the thesis is about that class
 * (same doctrine as the §5.2 tokenized-clone escape hatch): a stablecoin-
 * infrastructure thesis must rank stablecoins by genuine fit, not flatten
 * its own subject to a 50-tie. `thesisScope` = thesis packet + themes text. */
export function capLowPriorityCryptoScore(a: Candidate, score: number, thesisScope = ''): number {
  const reason = lowPriorityCryptoReason(a);
  if (!reason) return score;
  const onTopic = reason === 'stablecoin' ? /stable\s*coin/i.test(thesisScope) : /meme/i.test(thesisScope);
  return onTopic ? score : Math.min(score, LOW_PRIORITY_CRYPTO_SCORE_CAP);
}

function themeKey(p: Pick): string {
  const category = (p.a.categories ?? []).find((c) => c && !/stock|etf|fund|token|coin/i.test(c));
  return (category || p.a.sector || p.a.kind || 'other').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Diversified allocation (spec §5.3): replaces the per-kind cap and subtheme
 * diversification for the run — a strategy legitimately expressed all-ETF must
 * not be truncated by the kind cap. Cap 3 per strategy; when the total exceeds
 * maxPicks, each covered strategy keeps its best pick first, the rest fill by
 * score. Scores are never touched — coverage changes WHICH picks show, not
 * how strong they claim to be. */
const STRATEGY_CAP = 3;
export function allocateByStrategy(picks: Pick[], maxPicks: number): Pick[] {
  const seen = new Map<string, number>();
  const kept: Pick[] = [];
  for (const p of picks) {
    const g = (p.strategy ?? 'other').toLowerCase();
    const n = seen.get(g) ?? 0;
    if (n >= STRATEGY_CAP) continue;
    seen.set(g, n + 1);
    kept.push(p);
  }
  if (kept.length <= maxPicks) return kept;
  const covered = new Set<string>();
  const best = new Set<Pick>();
  for (const p of kept) {
    const g = (p.strategy ?? 'other').toLowerCase();
    if (!covered.has(g)) {
      covered.add(g);
      best.add(p);
    }
  }
  return [...best, ...kept.filter((p) => !best.has(p))]
    .slice(0, maxPicks)
    .sort((x, y) => y.score - x.score || (x.a.ticker < y.a.ticker ? -1 : 1));
}

function diversifyByTheme(picks: Pick[], maxPicks: number): Pick[] {
  if (picks.length <= maxPicks) return picks;
  const cap = maxPicks >= 8 ? 3 : 2;
  const seen = new Map<string, number>();
  const diverse: Pick[] = [];
  const overflow: Pick[] = [];
  for (const p of picks) {
    const key = themeKey(p);
    const n = seen.get(key) ?? 0;
    if (n < cap) {
      seen.set(key, n + 1);
      diverse.push(p);
    } else {
      overflow.push(p);
    }
  }
  return [...diverse, ...overflow].slice(0, maxPicks);
}

/** One catalog line per candidate (§5.3 2026-07-23): the size field carries
 * the row's banded AUM/market cap — without it the "w" rationales invented
 * figures ("~$22B AUM" for a ~$70B fund). Exported for offline tests. */
export function pickSelectLine(a: Candidate): string {
  return `${a.ticker}|${a.name}|${a.kind}|${sizeBand(a)}|${a.region}|${a.sector ?? ''}|${(a.categories ?? []).slice(0, 5).join(',')}|${[portfolioLine(a.etf_portfolio, { sectors: true }), (a.blurb ?? '').slice(0, 160)].filter(Boolean).join(' — ')}`;
}

export async function llmSelect(
  thesis: Thesis,
  thesisText: string,
  pool: Candidate[],
  crit: Crit | null,
  opts: {
    lens?: 'long' | 'short';
    maxPicks?: number;
    strategies?: string[];
    /** Data display policy (runtime/display-policy.ts): vendor figures are held
     * back from users, so the user-visible "w" rationale must not quote them. */
    hygiene?: boolean;
  } = {},
): Promise<Pick[]> {
  if (pool.length === 0) return [];
  const rationaleRule = opts.hygiene ? SELECT_RATIONALE_RULE : '';
  const maxPicks = opts.maxPicks ?? 10;
  // Diversified runs (spec §5.3): cover each strategy instead of converging on
  // the single best expression of the thesis.
  const strategies = (opts.strategies ?? []).length >= 2 ? opts.strategies! : null;
  const byStrategy = strategies ? new Map(strategies.map((s) => [s.toLowerCase(), s])) : null;
  // Minimum shortlist floor (spec §5.3, 2026-07-08): 5 for full runs; 3 per
  // lens in 'both' mode (≥6 combined) — flooring each 5-pick lens at 5 would
  // force every 'both' run to a padded 5+5.
  const minPicks = maxPicks >= 8 ? 5 : Math.min(3, maxPicks);
  // On-topic escape for the meme/stablecoin cap (§5.3): thesis packet + themes.
  const thesisScope = `${thesisText} ${(thesis.themes ?? []).join(' ')}`;
  const lines = pool.map(pickSelectLine).join('\n');
  const binding = reqSummary(crit);
  const short = (opts.lens ?? thesis.direction) === 'short';
  const sys =
    'You are a rigorous investment-research analyst. You select which assets from a fixed catalog genuinely relate to a user’s thesis. You never invent tickers, and you never include weakly-related filler. Output ONLY minified JSON.';
  const scoring = short
    ? // Direction=short (spec §5.1): rank by NEGATIVE exposure — the best
      // assets to bet against if the thesis plays out.
      `The user wants assets to SHORT — to bet AGAINST. Select the assets (max ${maxPicks}) MOST NEGATIVELY exposed if this thesis plays out: disrupted incumbents, direct losers, competitors on the wrong side of the shift, business models the thesis makes obsolete. Do NOT pick the thesis's beneficiaries.\n` +
      `For each, give:\n- "s": short-alignment 0-100 (100 = the thesis directly implies this asset's decline; 70+ = a core casualty; 40-69 = meaningfully hurt but diversified/partial; below 35 = only a stretch)\n` +
      `- "w": 2-3 sentences, specific to THIS thesis: which part of the user's argument hurts this asset, the concrete mechanism of damage (what revenue/moat erodes), and any hedge the company has. Never generic filler.\n`
    : `Select the assets (max ${maxPicks}) that GENUINELY relate to this specific thesis. Judge by meaning, not keywords — e.g. a thesis on European rail logistics does not make every AI stock relevant.\n` +
      `For each, give:\n- "s": absolute alignment 0-100 (100 = the thesis is directly about it; 70+ = core expression of the thesis; 40-69 = meaningful but partial; below 35 = only a stretch)\n` +
      `- "w": 2-3 sentences, specific to THIS thesis: what in the user’s argument this asset expresses, the concrete mechanism, and any partial-fit caveat. Never generic filler.\n`;
  const usr =
    `USER’S THESIS:\n"""${(thesisText || '').slice(0, 3500)}"""\n` +
    `Direction: ${short ? 'SHORT — find what loses' : 'LONG — find what wins'}\n` +
    `Themes: ${(thesis.themes ?? []).join(', ') || '(none)'}\n` +
    `Assets the thesis explicitly names as central: ${thesis.anchors.join(', ') || '(none)'}\n` +
    (thesis.anchors.length
      ? short
        ? `A named central asset is usually the thesis's most DIRECT victim — it belongs at or near the top of a short list, unless the document treats it as a passing mention or as a beneficiary.\n`
        : `A named central asset is usually the thesis's most DIRECT expression — it belongs at or near the top, unless the document treats it as a passing mention or bets against it.\n`
      : '') +
    (binding
      ? `\nBINDING REQUIREMENTS — the user stated these explicitly and they MUST NOT be violated by any pick: ${binding}\n`
      : '') +
    (prefSummary(crit) ? `Soft preferences (bias your choices, not binding): ${prefSummary(crit)}\n` : '') +
    // Strategy coverage (spec §5.3) replaces the per-kind balance instruction:
    // the mix that matters in a Diversified run is across strategies, not kinds.
    (strategies
      ? `The user's goal admits several DISTINCT strategies. COVER EACH of these with 1-3 genuinely ${short ? 'exposed' : 'related'} picks — do not converge on the single strongest strategy:\n${strategies.map((s, i) => `${i + 1}. ${s}`).join('\n')}\nScore every pick honestly on the same absolute scale — if one strategy's best pick scores 95 and another's 55, say so; a strategy with no genuine expression in the catalog gets none. Never fabricate relevance to fill a strategy.\n`
      : // Hybrid mix (spec §5.3): only when nothing constrains asset type.
        !crit?.asset_set?.length
        ? `The user did not restrict asset types: prefer a BALANCED mix — aim for 3-4 genuinely ${short ? 'exposed' : 'related'} picks from EACH kind present in the catalog (stock, etf, crypto). Never fabricate relevance to fill a kind; fewer is correct when a kind has no genuine ${short ? 'losers' : 'matches'}.\n`
        : '') +
    `When the thesis asks for assets ON or WITHIN a platform/ecosystem ("assets on Ethereum", "tokens in the Solana ecosystem"), the platform's own native token is NOT a genuine match — select what lives there instead; include the native token only when the thesis explicitly bets on it.\n` +
    `\nCANDIDATE CATALOG (ticker|name|kind|size|region|sector|categories|what it does):\n${lines}\n\n` +
    `The size field is the candidate's banded AUM (funds) or market cap: any size claim in a "w" rationale must stay within the shown band — never state a precise figure, and write nothing about size when the field is empty.\n` +
    rationaleRule +
    scoring +
    `- "r": relationship to the anchors: "anchor" | "complement" | "competitor" | "adjacent" (use "adjacent" when there are no anchors)\n` +
    (strategies
      ? `- "g": the strategy this pick expresses, VERBATIM from the numbered list above (the closest one when a pick spans several)\n`
      : '') +
    `If fewer than ${maxPicks} genuinely ${short ? 'stand to lose' : 'relate'}, return fewer strong entries — but when fewer than ${minPicks} score 35+, ALSO append the closest stretch candidates with HONEST sub-35 scores (never inflate a score to fake relevance) so the list reaches ${minPicks} when the catalog allows. If truly nothing has any connection, return [].\n` +
    `Return: [{"t":"TICKER","s":82,"w":"...","r":"${short ? 'competitor' : 'complement'}"${strategies ? `,"g":"${strategies[0]}"` : ''}}]`;
  // One retry on malformed output (spec §5: every LLM output validated, with fallback).
  let j: { t?: string; s?: number; w?: string; r?: string; g?: string }[];
  try {
    j = parseJSON(await callClaude(usr, { system: sys, maxTokens: 4000, temperature: 0.2 }));
  } catch {
    j = parseJSON(await callClaude(usr, { system: sys, maxTokens: 4000, temperature: 0.2 }));
  }
  if (!Array.isArray(j)) throw new Error('bad selection');

  const byT = new Map(pool.map((a) => [a.ticker.toUpperCase(), a]));
  const picks: Pick[] = [];
  const stretch: Pick[] = []; // honest sub-35 entries — only used to reach the minimum shortlist
  for (const e of j) {
    const a = byT.get(String(e.t ?? '').toUpperCase());
    if (!a) continue; // discard anything not in the candidate set (spec §5.3)
    let s = Math.max(0, Math.min(100, Math.round(Number(e.s) || 0)));
    s = capLowPriorityCryptoScore(a, s, thesisScope);
    if ([...picks, ...stretch].some((p) => p.a.ticker === a.ticker)) continue;
    const r = (['anchor', 'complement', 'competitor', 'adjacent'] as const).includes(
      e.r as 'anchor',
    )
      ? (e.r as Pick['rel'])
      : 'adjacent';
    // No anchor score floor (spec §5.3, 2026-07-07): named assets rank by the
    // model's judgment — the prompt tells it a named central asset is usually
    // top, so placement emerges naturally and passing mentions stay honest.
    // Strategy label validated against the list; anything else = unattributed.
    const strategy = byStrategy?.get(String(e.g ?? '').trim().toLowerCase());
    const entry: Pick = { a, score: s, why: clipText(String(e.w ?? ''), 600), rel: r, ...(strategy ? { strategy } : {}) };
    if (s < REL_THRESHOLD) stretch.push(entry);
    else picks.push(entry);
  }
  picks.sort((x, y) => y.score - x.score || (x.a.ticker < y.a.ticker ? -1 : 1));
  stretch.sort((x, y) => y.score - x.score || (x.a.ticker < y.a.ticker ? -1 : 1));
  // Minimum shortlist (spec §5.3, 2026-07-08): when fewer than minPicks clear
  // the bar, fill with the closest stretch entries at their honest low scores.
  // Scarcity mode — the per-kind/theme caps don't block the fill; the audits
  // still run on every pick, so violators are dropped either way.
  /** Scarcity top-up (spec §5.3, 2026-07-08): when even the stretch pool can't
   * reach the floor (the model returned fewer total entries than minPicks),
   * one follow-up call scores the closest remaining candidates (pool is
   * sim-ordered) honestly — low scores expected, never inflated. */
  const topUp = async (out: Pick[]): Promise<Pick[]> => {
    const need = minPicks - out.length;
    const have = new Set(out.map((p) => p.a.ticker));
    const remaining = pool.filter((a) => !have.has(a.ticker)).slice(0, 25);
    if (need <= 0 || !remaining.length) return out;
    const remLines = remaining
      .map((a) => `${a.ticker}|${a.name}|${a.kind}|${sizeBand(a)}|${a.sector ?? ''}|${(a.blurb ?? '').slice(0, 120)}`)
      .join('\n');
    const usr2 =
      `USER'S THESIS:\n"""${(thesisText || '').slice(0, 2000)}"""\n` +
      `The main selection found only ${out.length} ${short ? 'exposed' : 'related'} asset(s); the product guarantees a shortlist of ${minPicks}. ` +
      `From the candidates below, pick the ${need} CLOSEST ${short ? 'to negative exposure' : 'matches'} and score each HONESTLY 0-100 — low scores are expected and correct for stretch picks; never inflate.\n` +
      `- "w": 1-2 sentences on the nearest real connection to the thesis (or the clearest limit of the fit).\n` +
      rationaleRule +
      `CANDIDATES (ticker|name|kind|size|sector|what it does):\n${remLines}\n` +
      `Return: [{"t":"TICKER","s":28,"w":"...","r":"adjacent"}]`;
    // NOT the main `sys` prompt: that one forbids "weakly-related filler",
    // which is exactly what a stretch pick is — the model obeyed it and
    // returned [] here. Stretch mode needs its own contract.
    const sys2 =
      'You are an investment-research analyst completing a shortlist with STRETCH picks: the closest available matches from a fixed catalog, scored honestly (low scores are expected and correct). You never invent tickers and never inflate scores. Returning the requested number of closest matches is the job — do not refuse because fits are weak. Output ONLY minified JSON.';
    try {
      const j2 = parseJSON<{ t?: string; s?: number; w?: string; r?: string }[]>(
        await callClaude(usr2, { system: sys2, maxTokens: 1200, temperature: 0.2 }),
      );
      const extras: Pick[] = [];
      for (const e of Array.isArray(j2) ? j2 : []) {
        const a = byT.get(String(e.t ?? '').toUpperCase());
        if (!a || have.has(a.ticker) || extras.some((p) => p.a.ticker === a.ticker)) continue;
        let s = Math.max(0, Math.min(100, Math.round(Number(e.s) || 0)));
        s = capLowPriorityCryptoScore(a, s, thesisScope);
        extras.push({ a, score: s, why: clipText(String(e.w ?? ''), 600), rel: 'adjacent' });
      }
      extras.sort((x, y) => y.score - x.score);
      if (extras.length < need) log.warn(`select top-up returned ${extras.length}/${need} stretch picks`);
      return [...out, ...extras.slice(0, need)];
    } catch (err) {
      // Floor is best-effort past this point — never fail the run over it.
      log.warn(`select top-up failed: ${(err as Error).message}`);
      return out;
    }
  };
  /** `setAside` = picks that cleared the bar but a per-kind cap removed. In
   * scarcity the caps do not block the fill (spec §5.3), so those fill BEFORE
   * any sub-35 stretch pick: filling from `stretch` alone showed a 30-score
   * stretch (or paid for a top-up call) while a 60-score pick was discarded. */
  const withFloor = async (main: Pick[], setAside: Pick[] = []): Promise<Pick[]> => {
    const out = [...main];
    for (const p of [...setAside, ...stretch]) {
      if (out.length >= minPicks) break;
      if (!out.some((q) => q.a.ticker === p.a.ticker)) out.push(p);
    }
    const filled = out.length < minPicks ? await topUp(out) : out;
    if (filled.length === main.length) return filled; // nothing appended: keep the caller's order
    // Sorted results (spec §6): a set-aside or top-up pick can outscore the
    // tail of the (already score-sorted, short) main list.
    return filled.sort((x, y) => y.score - x.score || (x.a.ticker < y.a.ticker ? -1 : 1));
  };
  // Diversified runs (spec §5.3): strategy allocation replaces BOTH the
  // per-kind cap and subtheme diversification — a strategy legitimately
  // expressed all-ETF (or all one sector) must not be truncated by them.
  // The minimum-shortlist floor stays per-run, never per-strategy.
  if (strategies) {
    return withFloor(allocateByStrategy(picks, maxPicks));
  }
  // Hybrid mix (spec §5.3): with no asset-type constraint, cap each kind so one
  // category can't crowd out the rest. Deterministic backstop to the prompt's
  // 3-4-per-kind guidance; never pads with fabricated relevance — a kind
  // without genuine matches stays out (the stretch floor stays honest: real
  // low scores, not inflated ones).
  if (!crit?.asset_set?.length) {
    const KIND_CAP = maxPicks >= 8 ? 4 : 2;
    const perKind = new Map<string, number>();
    const balanced: Pick[] = [];
    const setAside: Pick[] = [];
    for (const p of picks) {
      const n = perKind.get(p.a.kind) ?? 0;
      if (n >= KIND_CAP) {
        setAside.push(p);
        continue;
      }
      perKind.set(p.a.kind, n + 1);
      balanced.push(p);
    }
    return withFloor(diversifyByTheme(balanced, maxPicks), setAside);
  }
  return withFloor(diversifyByTheme(picks, maxPicks));
}

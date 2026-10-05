/**
 * Run orchestration (spec §5.7): thesis → candidates → select → audit →
 * analysis, with status-line transparency at each step. /market joins in M4.
 */
import { log } from '../ingest/lib/log.js';
import { supabase } from '../ingest/lib/supabase.js';
import { analysisNeedsHygiene, displayFlags, promptHygieneActive, type AnalysisHygiene, type Channel } from './display-policy.js';
import { getCandidates, ensureAnchors, type Requirements, type Candidate } from './candidates.js';
import { universeCandidates, UNIVERSES, type UniverseName } from './universe.js';
import { passesFilters } from './audit.js';
import { buildThesis, type Thesis } from './thesis.js';
import { llmSelect } from './select.js';
import type { Pick } from './select.js';
import { auditPicks, verifyPicks } from './audit.js';
import { explainPicksWithStatus } from './analysis.js';
import { instructionSentences, reqSummary, type Crit } from './requirements.js';
import {
  extractFinReq,
  hasFinReq,
  loadFacts,
  checkAsset,
  finReqSummary,
  SPECS,
  EMPTY_FINREQ,
  type FinReq,
} from './finreq.js';

export interface RunResult {
  thesis: Thesis;
  candidates: Candidate[];
  picks: Pick[];
  analysis: Record<string, string>;
  status: string[]; // §5.7 transparency lines
  path: 'full' | 'empty';
  /** Which breadth the run actually used (spec §5.3): 'diversified' only when
   * the mode was on AND ≥2 strategies existed AND the run was single-lens. */
  breadth: 'focused' | 'diversified';
  /** Quantitative requirements read from the request (spec §15.3), and what
   * they did: enforced deterministically before /select, with the asks we
   * could not express reported rather than dropped. */
  finReq: FinReq;
  /** True when the analysis LLM call failed and `analysis` holds neutral
   * template lines instead of written prose (see analysis.ts). */
  analysisDegraded?: boolean;
}

export interface RunOpts {
  /** Breadth control (§6). Default: focused — the standard behavior; the seg
   * is pre-set to Focused and 'diversified' is the explicit opt-in. */
  breadth?: 'focused' | 'diversified';
  /**
   * Financial requirements the caller already has (spec §15.3). The browser
   * extracts them at /api/thesis so the review card can show them as editable
   * chips, then posts back whatever survived the user's edits — so a chip the
   * user removed must NOT come back from a re-extraction here. Omitted by
   * /v1/screen and MCP, which extract from the text instead.
   */
  finReq?: FinReq;
  /**
   * Tradable-universe mode (spec §16): candidates come from the named
   * universe's allowlist instead of embedding retrieval — the whole universe
   * is the pool, so /select can only ever pick assets that exist as tokens on
   * the venue. Anchors outside the universe are NOT rescued in: the allowlist
   * is binding the way other hard requirements are.
   */
  universe?: UniverseName;
  /** Who receives the result, for the data display policy
   * (runtime/display-policy.ts); absent means the website. */
  channel?: Channel;
}

/** Adapter: v3-shaped Crit → M2 Requirements for the SQL hard filter. */
export function critToRequirements(crit: Crit | null | undefined): Requirements {
  if (!crit) return {};
  // SQL filters region by DOMICILE, which is right for companies and wrong for
  // funds (spec §15.4). When funds are in scope, widen the SQL region set with
  // the two buckets funds are actually domiciled in — us, and eu for every
  // UCITS wrapper — so they survive retrieval; passesFilters then judges them
  // on what they hold. Same trick §6 already uses for the Italy scope tag.
  const fundsInScope = !crit.asset_set?.length || crit.asset_set.some((k) => k === 'etf' || k === 'bond');
  const regions = crit.region_set?.length
    ? fundsInScope
      ? [...new Set([...crit.region_set, 'us', 'eu'])]
      : crit.region_set
    : null;
  return {
    assetSet: crit.asset_set?.length ? (crit.asset_set as Requirements['assetSet']) : null,
    regionSet: regions as Requirements['regionSet'],
    capSet: crit.cap_set?.length ? (crit.cap_set as Requirements['capSet']) : null,
    cexOnly: crit.cex_only ?? false,
    cnHkexOnly: crit.cn_hkex_only ?? false,
    excludeTickers: crit.exclude_tickers ?? [],
    semantic: crit.constraint_note ?? null,
  };
}

const OTC_RE = /^(PINK|OTC)/i; // PINK, OTCGREY, OTCQB, OTCMKTS, OTCQX, OTCBB, OTCCE…
const normName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** True for OTC/pink-sheet venues, which lose to a real exchange listing. */
export const isOtcExchange = (exchange: string | null | undefined): boolean => OTC_RE.test(exchange ?? '');

/**
 * The identity of a COMPANY across its listings (spec §5.3). Shared so the
 * screening pipeline and the data-query ranking (§15.3) collapse sibling
 * lines the same way: BHP's NYSE ADR, LSE line and pink sheet are one company
 * whether they are competing for a pick slot or a ranking row.
 */
export const companyKey = (kind: string, name: string): string => `${kind}|${normName(name)}`;

/** One candidate line per company (spec §5.3 "ten distinct companies"): the
 * ≤10 /select slots must go to distinct companies, not to sibling listings of
 * the same one (BIDU ADR + BAIDF OTC line). Primary = anchor ticker > non-OTC
 * exchange > higher similarity; the losers ride along as `siblings` and
 * re-join the picks as UI options after the audits. */
export function dedupeCompanies(candidates: Candidate[], anchors: Set<string>): Candidate[] {
  const byKey = new Map<string, Candidate>();
  const order: string[] = [];
  const beats = (a: Candidate, b: Candidate): boolean => {
    const aAnchor = anchors.has(a.ticker.toUpperCase());
    const bAnchor = anchors.has(b.ticker.toUpperCase());
    if (aAnchor !== bAnchor) return aAnchor;
    const aOtc = isOtcExchange(a.exchange);
    const bOtc = isOtcExchange(b.exchange);
    if (aOtc !== bOtc) return !aOtc;
    return a.sim >= b.sim;
  };
  for (const c of candidates) {
    const k = companyKey(c.kind, c.name);
    const cur = byKey.get(k);
    if (!cur) {
      byKey.set(k, c);
      order.push(k);
    } else if (beats(c, cur)) {
      c.siblings = [...(c.siblings ?? []), ...(cur.siblings ?? []), { ...cur, siblings: undefined }];
      byKey.set(k, c);
    } else {
      cur.siblings = [...(cur.siblings ?? []), { ...c, siblings: undefined }];
    }
  }
  return order.map((k) => byKey.get(k) as Candidate);
}

/**
 * One pool row per ticker (review R1). Tickers are unique per (source,
 * vendor_id), not globally: crypto ETH and the ETF trading as ETH, or BTC and
 * its mini-trust ETF, can both reach the pool. /select validates the model's
 * answer by ticker, and the audit, analysis and news maps are ticker-keyed, so
 * a collision silently made one asset unreachable and could hang one asset's
 * analysis on the other's card. Keeps the row with the higher similarity (the
 * first on a tie, so callers' ordering decides); the other line is dropped
 * from this run with a log line. Exported for offline tests.
 */
export function uniqueTickers(candidates: Candidate[]): Candidate[] {
  const best = new Map<string, Candidate>();
  for (const c of candidates) {
    const k = c.ticker.toUpperCase();
    const cur = best.get(k);
    if (!cur || c.sim > cur.sim) best.set(k, c);
  }
  if (best.size === candidates.length) return candidates;
  const kept = candidates.filter((c) => best.get(c.ticker.toUpperCase()) === c);
  const dropped = candidates.filter((c) => best.get(c.ticker.toUpperCase()) !== c);
  log.info(`ticker collision: dropped ${dropped.map((c) => `${c.ticker} (${c.kind} ${c.name})`).join(', ')} in favor of a better-matching line`);
  return kept;
}

/**
 * The assets' own enrichment text (assets.enrichment, spec §4.3b) for the
 * analysis prompt under the data display policy, which keeps vendor
 * descriptions out of that user-visible prompt. Best-effort: a failed read
 * means no text for those picks, never a failed run.
 */
async function ownTextFor(ids: number[]): Promise<Map<number, string | null>> {
  const out = new Map<number, string | null>();
  if (!ids.length) return out;
  try {
    const { data, error } = await supabase.from('assets').select('id, enrichment').in('id', ids);
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as { id: number; enrichment?: string | null }[]) out.set(r.id, r.enrichment ?? null);
  } catch (err) {
    log.warn(`own asset text unavailable for the analysis prompt: ${(err as Error).message}`);
  }
  return out;
}

function thesisContext(thesis: Thesis): string {
  return [
    thesis.summary,
    thesis.stance ? `Stance: ${thesis.stance}` : '',
    thesis.themes.length ? `Themes: ${thesis.themes.join(', ')}` : '',
    thesis.anchors.length ? `Central investable assets: ${thesis.anchors.join(', ')}` : '',
    thesis.private_entities.length
      ? `Central but not directly investable: ${thesis.private_entities.map((e) => `${e.name} (${e.note})`).join('; ')}`
      : '',
    `Direction: ${thesis.direction}`,
  ]
    .filter(Boolean)
    .join('\n');
}

function candidateQueries(thesis: Thesis, baseContext: string, diversified = false): string[] {
  // PRIORITY order (§5.2): getCandidates caps the fan-out at 6 queries, so the
  // short-lens and anchor queries must come before the theme fill — appended
  // last, the negative-exposure query was silently dropped on exactly the
  // richest short theses (4+ themes with anchors). Themes are the safest to
  // trim: the full packet already embeds every theme.
  const queries = [baseContext];
  if (thesis.direction === 'short' || thesis.direction === 'both') {
    queries.push(
      `Assets negatively exposed if this thesis is right: disrupted incumbents, direct losers, obsolete business models.\n${thesis.summary}`,
    );
  }
  if (thesis.anchors.length) {
    queries.push(`Direct and adjacent exposures to ${thesis.anchors.join(', ')}\nThesis: ${thesis.summary}`);
  }
  // Diversified runs (§5.3): the strategies take the theme slots — each avenue
  // must have candidates in the pool before /select can cover it, and the full
  // packet already embeds every theme, so themes are what gets displaced.
  if (diversified) {
    queries.push(...thesis.strategies.slice(0, 5).map((s) => `Investment strategy: ${s}\nGoal: ${thesis.summary}`));
  } else {
    queries.push(...thesis.themes.slice(0, 4).map((t) => `Investment theme: ${t}\nThesis: ${thesis.summary}`));
  }
  return queries;
}

export async function runResearch(
  documentText: string,
  extraCrit?: Crit,
  onStatus?: (line: string) => void,
  opts?: RunOpts,
): Promise<RunResult> {
  const status: string[] = [];
  const say = (s: string) => {
    status.push(s);
    log.step(s);
    onStatus?.(s);
  };
  say('Reading the source and identifying the investment thesis…');
  const thesis = await buildThesis(documentText);
  let crit = thesis.docCrit;
  if (extraCrit) {
    const { mergeCrit } = await import('./requirements.js');
    crit = mergeCrit(crit, extraCrit);
  }
  return completeResearch(documentText, thesis, crit, onStatus, status, opts);
}

/** Stages after thesis review (candidates → select → audit → analysis) — lets
 * the frontend pause for thesis editing / the expert interview in between. */
export async function completeResearch(
  documentText: string,
  thesis: Thesis,
  critIn: Crit | null,
  onStatus?: (line: string) => void,
  statusSoFar?: string[],
  opts?: RunOpts,
): Promise<RunResult> {
  // Reassigned once below, when a country-exposure requirement supersedes the
  // coarse domicile filter.
  let crit = critIn;
  const status: string[] = statusSoFar ?? [];
  const say = (s: string) => {
    status.push(s);
    log.step(s);
    onStatus?.(s);
  };
  // Strategy breadth (§5.3): single-lens runs only — two 5-pick lenses in
  // 'both' mode are too small to sub-allocate. Focused is the standard;
  // 'diversified' is the explicit opt-in, honored only with ≥2 strategies.
  const strategies = (thesis.strategies ?? []).map(String).filter(Boolean).slice(0, 5);
  const diversified = opts?.breadth === 'diversified' && strategies.length >= 2 && thesis.direction !== 'both';
  // Data display policy (runtime/display-policy.ts): the select rationale and
  // the analysis are shown to users, so while vendor data is held back they
  // must not quote it. Ranking and the numeric requirement filters below still
  // read every figure we hold.
  const flags = displayFlags();
  const channel = opts?.channel ?? 'web';
  const hygiene = promptHygieneActive(flags, channel);

  // 2. /candidates — embedding computed from the ENGLISH structured thesis (§4.1c note).
  const thesisText = diversified
    ? `${thesisContext(thesis)}\nDistinct strategies to cover: ${strategies.join('; ')}`
    : thesisContext(thesis);
  // Financial requirements (spec §15.3). An edited set from the review card
  // wins: the user removing a chip is a decision, and re-extracting would
  // silently reinstate it. Otherwise read them from the user's own words.
  // Best-effort either way: extraction failure degrades to no requirements,
  // never a failed run.
  const finReq = opts?.finReq ?? (documentText ? await extractFinReq(documentText) : EMPTY_FINREQ);
  const reqLines = finReqSummary(finReq);
  if (reqLines.length) say(`Financial requirements: ${reqLines.join('; ')}.`);
  if (finReq.unverifiable.length) {
    say(
      `Cannot verify from our data, so not applied as a filter: ${finReq.unverifiable.join('; ')}.`,
    );
  }

  let candidates: Candidate[];
  if (opts?.universe) {
    // Universe mode (§16): the allowlist IS the pool — no retrieval, and no
    // anchor rescue below (an anchor outside the universe must not enter).
    const reg = UNIVERSES[opts.universe];
    say(`Screening the ${reg.chain} tokenized universe (${reg.assets.length} assets) against the thesis…`);
    candidates = await universeCandidates(opts.universe);
  } else {
    say('Screening the eligible universe against the thesis…');
    candidates = await getCandidates(thesisText, critToRequirements(crit), {
      queries: candidateQueries(thesis, thesisText, diversified),
      // A hard numeric filter can cut the pool heavily, so ask for more before
      // it applies — otherwise a legitimate requirement starves /select.
      finalCount: hasFinReq(finReq) ? 400 : undefined,
    });
  }
  // Belt-and-braces re-check of every hard rule; violators must not reach /select at all.
  candidates = candidates.filter((c) => passesFilters(c, crit));
  // Named assets are always considered (v3 parity) — unless they violate a
  // binding requirement, which still wins. Universe mode skips the rescue:
  // an anchor that is not in the allowlist is out, full stop. Added BEFORE the
  // numeric requirements below, so a force-included anchor is held to them
  // too: added after, "P/E below 15" let a named P/E-50 stock through, and the
  // compliance auditor is told those requirements are already verified.
  if (thesis.anchors.length && !opts?.universe) {
    candidates = await ensureAnchors(candidates, thesis.anchors, (c) => passesFilters(c, crit));
  }

  // Numeric requirements bind here, deterministically, before /select sees
  // anything (spec §15.4). An asset whose metric we do not hold does NOT
  // qualify, so the coverage count is reported: a thin-data requirement has to
  // announce itself rather than just returning a short list.
  if (hasFinReq(finReq) && candidates.length) {
    const facts = await loadFacts(candidates.map((c) => c.id));
    let checkable = 0;
    const kept = candidates.filter((c) => {
      const f = facts.get(c.id);
      if (!f) return false;
      const { pass, unchecked } = checkAsset(finReq, f);
      if (!unchecked.length) checkable++;
      return pass;
    });
    const labels = [
      ...finReq.bounds.map((b) => SPECS[b.key]?.label ?? b.key),
      ...finReq.exposures.map((e) => e.name),
    ];
    say(
      `Checked ${candidates.length} candidates against ${labels.length} financial requirement${labels.length === 1 ? '' : 's'}: ` +
        `${checkable} had every figure, ${kept.length} met them all.`,
    );
    candidates = kept;
  }
  // One line per company so /select's slots go to distinct companies (§5.3),
  // then one line per ticker so every ticker-keyed map below is unambiguous.
  candidates = uniqueTickers(dedupeCompanies(candidates, new Set(thesis.anchors.map((t) => t.toUpperCase()))));
  if (candidates.length === 0) {
    say(
      hasFinReq(finReq)
        ? 'No asset meets the thesis and every financial requirement.'
        : 'No asset meets every selected criterion.',
    );
    return { thesis, candidates, picks: [], analysis: {}, status, path: 'empty', breadth: 'focused', finReq };
  }
  say(
    thesis.direction === 'short'
      ? `Ranking ${candidates.length} short candidates by exposure to the thesis…`
      : thesis.direction === 'both'
        ? `Ranking ${candidates.length} candidates across the long and short sides…`
        : diversified
          ? `Covering ${strategies.length} distinct strategies across ${candidates.length} candidate assets…`
          : `Ranking ${candidates.length} candidate assets by thesis fit…`,
  );

  // 3. /select — 'both' runs the reranker once per lens: 5 longs + 5 shorts.
  let selected: Pick[];
  if (thesis.direction === 'both') {
    const [longs, shorts] = await Promise.all([
      llmSelect(thesis, thesisText, candidates, crit, { lens: 'long', maxPicks: 5, hygiene }),
      llmSelect(thesis, thesisText, candidates, crit, { lens: 'short', maxPicks: 5, hygiene }),
    ]);
    // An asset can't be on both sides of the same trade — the long lens wins.
    const longTickers = new Set(longs.map((p) => p.a.ticker));
    selected = [
      ...longs.map((p) => ({ ...p, dir: 'long' as const })),
      ...shorts.filter((p) => !longTickers.has(p.a.ticker)).map((p) => ({ ...p, dir: 'short' as const })),
    ];
  } else {
    const lens = thesis.direction === 'short' ? ('short' as const) : ('long' as const);
    selected = (
      await llmSelect(thesis, thesisText, candidates, crit, diversified ? { strategies, hygiene } : { hygiene })
    ).map((p) => ({
      ...p,
      dir: lens,
    }));
  }

  // 4. /audit — deterministic, then compliance.
  const det = auditPicks(selected, crit);
  if (det.dropped.length) say(`Criteria check removed ${det.dropped.join(', ')} because they did not meet the requirements.`);
  let picks = det.picks;
  // Spec §5.4: the user's OWN merged requirements bind strictly; the document's
  // instruction-like sentences are secondary (warnings never bind).
  const docInstr = instructionSentences(documentText);
  const userReq = [reqSummary(crit), crit?.constraint_note].filter(Boolean).join('; ');
  if ((docInstr || userReq) && picks.length) {
    // Numeric requirements were enforced in code; the auditor is told so and
    // loses the codes they own (spec §15.4).
    const { drop, unavailable } = await verifyPicks(docInstr, picks, userReq, crit, {
      lines: finReqSummary(finReq),
      suppress: finReq.bounds.some((b) => b.key === 'market_cap_usd' || b.key === 'aum_usd')
        ? ['cap']
        : [],
    });
    const flagged = picks.filter((p) => drop[p.a.ticker.toUpperCase()]);
    if (unavailable) {
      // Never imply a review happened that did not: the automatic criteria
      // check above (and any numeric requirement) still applied to every pick.
      say('The final compliance review was unavailable, so only the automatic criteria check was applied to these results.');
    } else if (flagged.length) {
      say(
        `Final criteria check removed ${flagged
          .map((p) => `${p.a.ticker} (${drop[p.a.ticker.toUpperCase()]})`)
          .join(', ')}.`,
      );
      picks = picks.filter((p) => !drop[p.a.ticker.toUpperCase()]);
    } else {
      say('All remaining candidates meet the selected criteria.');
    }
  }

  // 5. /analysis — per lens, so short candidates get the damage-mechanism framing.
  let analysis: Record<string, string> = {};
  let analysisDegraded = false;
  if (picks.length) {
    const longs = picks.filter((p) => p.dir !== 'short');
    const shorts = picks.filter((p) => p.dir === 'short');
    const none = { analysis: {} as Record<string, string>, degraded: false };
    // Picks whose vendor text is held back get identity facts plus their own
    // enrichment text in the analysis prompt (display policy).
    let analysisHygiene: AnalysisHygiene | null = null;
    if (hygiene) {
      analysisHygiene = { flags, channel, ownText: new Map() };
      const withheld = picks.filter((p) => analysisNeedsHygiene(p.a, analysisHygiene)).map((p) => p.a.id);
      analysisHygiene.ownText = await ownTextFor(withheld);
    }
    const [aL, aS] = await Promise.all([
      longs.length ? explainPicksWithStatus(thesisText, longs, crit, 'long', undefined, { hygiene: analysisHygiene }) : none,
      shorts.length ? explainPicksWithStatus(thesisText, shorts, crit, 'short', undefined, { hygiene: analysisHygiene }) : none,
    ]);
    analysis = { ...aL.analysis, ...aS.analysis };
    analysisDegraded = aL.degraded || aS.degraded;
    if (analysisDegraded) say('Written analysis was unavailable for some results, so a short summary of their thesis score is shown instead.');
  }
  say(
    picks.length
      ? thesis.direction === 'both'
        ? `Final list: ${picks.filter((p) => p.dir !== 'short').length} long and ${picks.filter((p) => p.dir === 'short').length} short.`
        : `Final list: ${picks.length} ${thesis.direction === 'short' ? `short candidate${picks.length === 1 ? '' : 's'}` : `result${picks.length === 1 ? '' : 's'}`}.`
      : 'No candidate passed the final criteria check.',
  );

  // Sibling listings re-join right after their primary (spec §5.3): same
  // score/why/analysis — identical company economics — but each listing must
  // still pass the hard filters itself. The UI's
  // same-company collapse (§6) shows them behind the "n options" button.
  const withOptions: Pick[] = [];
  for (const p of picks) {
    withOptions.push(p);
    for (const s of p.a.siblings ?? []) {
      if (!passesFilters(s, crit)) continue;
      withOptions.push({ ...p, a: s });
      const primaryAnalysis = analysis[p.a.ticker];
      if (primaryAnalysis) analysis[s.ticker] = primaryAnalysis;
    }
  }
  picks = withOptions;

  return {
    thesis,
    candidates,
    picks,
    analysis,
    status,
    path: 'full',
    breadth: diversified ? 'diversified' : 'focused',
    finReq,
    ...(analysisDegraded ? { analysisDegraded: true } : {}),
  };
}

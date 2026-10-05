/**
 * Requirement object + dual extractor + merge semantics — ported from v3
 * (spec §5.1: "port verbatim": INSTR_RE, instructionSentences, offlineConstraints,
 * mergeCrit exclusive-merge, reqSummary). v4 adaptations, documented inline:
 * region 'china'→'cn' bucket; sector_set dropped (v4 uses semantic + categories);
 * ticker lists validated against the DB downstream instead of a hand catalog.
 */
import { clipText } from './text.js';

export interface Crit {
  asset_set?: string[]; // subset of stock/etf/bond/crypto
  region_set?: string[]; // subset of us/eu/cn/other
  cap_set?: string[]; // subset of mega/large/mid/small/micro
  exclusions_set?: string[]; // additive tags: defense, micro, stableyield
  include_tickers?: string[];
  exclude_tickers?: string[];
  constraint_note?: string; // verbatim semantic scope ("related to the Ethereum ecosystem")
  asset_exclusive?: boolean;
  region_exclusive?: boolean;
  constrained?: boolean;
  cex_only?: boolean;
  /** Review-card China selection: HKEX listings only (FMP code HKSE;
   * legacy HK/HKEX aliases accepted), not US ADR/OTC. */
  cn_hkex_only?: boolean;
  // Soft preferences from the expert interview (bias /select, never binding).
  risk?: string;
  horizon?: string;
  familiarity?: string;
  spread?: string;
  expert?: boolean;
}

/** Soft-preference line for the /select prompt (v3 interview answers 5–7, 11). */
export function prefSummary(crit: Crit | null | undefined): string {
  if (!crit) return '';
  const parts: string[] = [];
  if (crit.risk) parts.push(`risk appetite: ${crit.risk}`);
  if (crit.horizon) parts.push(`time horizon: ${{ under1: 'under 1 year', '1to3': '1–3 years', '3plus': '3+ years' }[crit.horizon] ?? crit.horizon}`);
  if (crit.familiarity) parts.push({ household: 'prefers household names', gems: 'prefers lesser-known names', mix: 'mix of familiarity' }[crit.familiarity] ?? crit.familiarity);
  if (crit.spread === 'diversified') parts.push('spread picks across sub-themes');
  if (crit.spread === 'concentrated') parts.push('best matches even if similar');
  return parts.join('; ');
}

/** v3 INSTR_RE verbatim (multilingual instruction cues incl. Italian). */
export const INSTR_RE =
  /\b(only|exclude|excluding|without|must|i want|give me|show me|focus on|limit(?:ed)? to|restrict|avoid|just|solo|soltanto|solamente)\b/i;

/** Genuine RESTRICTION cues — the subset of INSTR_RE that limits what may
 * appear in the results (spec §5.1, 2026-07-10). "I want to hedge against the
 * dollar" is a goal, not a scope: soft cues must not turn the thesis topic
 * into a semantic constraint the auditor then enforces (§5.4 topic-leak). */
const RESTRICT_RE =
  /\b(only|exclude|excluding|without|avoid|nothing but|exclusively|restrict(?:ed)?(?:\s+to)?|limit(?:ed)?\s+to|solo|soltanto|solamente)\b/i;

/** Sentences of the document that read as instructions (v3 verbatim). */
export function instructionSentences(text: string): string {
  const sents = (text || '').replace(/\s+/g, ' ').split(/(?<=[.?!])\s+|\n+/);
  return sents.filter((s) => INSTR_RE.test(s)).join(' ').slice(0, 600);
}

/** v3 regionSet: free tokens → v4 region buckets. Case-insensitive: the LLM
 * extractor answers "US"/"EU" as often as "us", and an unmatched token is
 * silently dropped, so a case slip used to erase a binding region. */
export function regionSet(tokens: string[] | undefined): string[] {
  const m: Record<string, string[]> = {
    us: ['us'], usa: ['us'], eu: ['eu'], europe: ['eu'], china: ['cn'], cn: ['cn'],
    asia: ['cn', 'other'], row: ['other'], other: ['other'],
  };
  const s = new Set<string>();
  (tokens ?? []).forEach((t) => (m[String(t).trim().toLowerCase()] ?? []).forEach((x) => s.add(x)));
  return [...s];
}

/** LLM asset-class word → the vocabulary (stock/etf/bond/crypto/private), or
 * '' when it is not one. The extractor is told the exact codes but answers
 * "stocks", "ETFs" or "equities" often enough; dropping those silently made a
 * binding set NARROWER than the request (a reply of ["stocks", "etf"] bound
 * ETFs only). */
export function normalizeAssetClass(v: string): string {
  const k = String(v).trim().toLowerCase().replace(/[\s_-]+/g, ' ');
  const ALIASES: Record<string, string> = {
    stock: 'stock', stocks: 'stock', equity: 'stock', equities: 'stock', share: 'stock', shares: 'stock',
    etf: 'etf', etfs: 'etf',
    bond: 'bond', bonds: 'bond', 'bond etf': 'bond', 'bond etfs': 'bond',
    crypto: 'crypto', cryptos: 'crypto', cryptocurrency: 'crypto', cryptocurrencies: 'crypto', token: 'crypto', tokens: 'crypto',
    private: 'private', privates: 'private', 'pre ipo': 'private', 'private company': 'private', 'private companies': 'private',
  };
  return ALIASES[k] ?? '';
}

/** LLM cap word → mega/large/mid/small/micro, or '' ("Large", "large-cap" and
 * "large caps" all mean large). */
export function normalizeCapClass(v: string): string {
  const k = String(v).trim().toLowerCase().replace(/[\s_-]*caps?$/, '');
  return ['mega', 'large', 'mid', 'small', 'micro'].includes(k) ? k : '';
}

/**
 * Remove NEGATED mentions before the class/region/cap triggers run: "ETFs
 * only, no single stocks", "only stocks not listed in China", "without crypto
 * exposure", "excluding Chinese ADRs", "I don't want bonds", "non-US stocks".
 * The v3 regexes matched the class word wherever it appeared, so each of these
 * made the negated class or region REQUIRED ("not listed in China" bound
 * China-only; "no single stocks" put stocks back into an ETF-only request) —
 * the exact opposite of what the user asked. A negation cue drops itself plus
 * up to four following words, stopping at punctuation; "non-"/"ex-" drop only
 * the word they attach to. "not only"/"not just" are not negations of scope.
 * Exported for offline tests.
 */
export function stripNegations(text: string): string {
  return (text || '')
    .replace(/\b(?:non|ex)-[a-z.]+/gi, ' ')
    .replace(
      /\b(?:no|nor|not(?!\s+(?:only|just)\b)|[a-z]+n['’]t|without|excluding|exclude|except|never|avoid(?:ing)?|other than|rather than|instead of)(?:\s+[^\s.,;:!?]+){1,4}/gi,
      ' ',
    );
}

/** Deterministic regex extractor (v3 offlineConstraints, verbatim logic,
 * plus stripNegations so a negated mention never binds). */
export function offlineConstraints(text: string, instrOnly = false): Crit {
  const instr = instructionSentences(text || '');
  const scope = instrOnly ? instr : text || '';
  // `raw` keeps the negations (exclusion tags read them: "no defense");
  // `t` and the only-clauses read the scope with negated mentions removed.
  const raw = scope.toLowerCase();
  const positive = stripNegations(scope);
  const t = positive.toLowerCase();
  const toks: string[] = [];
  const aset: string[] = [];
  const c: Crit = {
    cap_set: [], exclusions_set: [], include_tickers: [], exclude_tickers: [],
    constrained: true,
    // Semantic scope only from a real restriction (§5.1 2026-07-10): a goal
    // sentence ("I want to hedge…") is a topic, and topics never bind (§5.4).
    constraint_note: instr && RESTRICT_RE.test(instr) ? clipText(instr, 90) : undefined,
  };
  if (/\betfs?\b|index funds?|tracker funds?|ucits/.test(t)) aset.push('etf');
  if (/\bbonds?\b|fixed income|treasur|gilts?\b/.test(t)) aset.push('bond');
  // 'company/companies' deliberately NOT a trigger here (spec §5.1 narrowing):
  // it names beneficiaries, not an asset class. It still binds inside an
  // explicit "only …" clause below.
  if (/\bstocks?\b|equit|shares?\b/.test(t)) aset.push('stock');
  if (/crypto|coins?|tokens?|bitcoin|ethereum/.test(t)) aset.push('crypto');
  if (/pre[- ]?ipo\b|private compan|unlisted compan/.test(t)) aset.push('private');
  c.asset_set = [...new Set(aset)];
  // "US dollar" names a currency, not a market scope (§5.1 2026-07-10) — a
  // dollar-hedge thesis must not get a binding region_set=['us'].
  if (/\bus\b(?![-\s]?dollars?)|u\.s\.(?![-\s]?dollars?)|american?\b(?![-\s]?dollars?)|united states(?![-\s]?dollars?)|nasdaq|nyse/.test(t)) toks.push('us');
  if (/europe|european|eu\b|uk\b|british|german|france|french|italian|spanish|dutch/.test(t)) toks.push('eu');
  if (/china|chinese|hong ?kong/.test(t)) toks.push('china');
  if (/asia|asian|japan|korea|india|taiwan/.test(t)) toks.push('asia');
  if (/large[- ]?cap|blue[- ]?chip|mega[- ]?cap/.test(t)) c.cap_set!.push('mega', 'large');
  if (/mid[- ]?cap/.test(t)) c.cap_set!.push('mid');
  if (/small[- ]?cap/.test(t)) c.cap_set!.push('small');
  if (/micro[- ]?cap/.test(t)) c.cap_set!.push('micro');
  if (/no defense|exclude defense|without defense|no weapons/.test(raw)) c.exclusions_set!.push('defense');
  c.region_set = regionSet(toks);
  c.cap_set = [...new Set(c.cap_set)];
  // "only X" clauses are EXCLUSIVE: they restrict to X, discarding anything else (v3 verbatim).
  const onlyClauses = [...positive.matchAll(/\b(?:only|just|nothing but|exclusively|solo|soltanto|solamente)\s+([^.?!;\n]{0,70})/gi)].map(
    (m) => m[1]!.toLowerCase(),
  );
  if (onlyClauses.length) {
    const has = (re: RegExp) => onlyClauses.some((cl) => re.test(cl));
    const exA: string[] = [];
    if (has(/etf|index fund|ucits|tracker/)) exA.push('etf');
    if (has(/\bbonds?\b|fixed income|treasur/)) exA.push('bond');
    // 'compan(y)' binds stock only when not the "private companies" idiom —
    // "only private companies" is a pre-IPO restriction, not a stocks one.
    if (has(/stock|equit|share|(?<!private[- ])compan/)) exA.push('stock');
    if (has(/crypto|coin|token|bitcoin|ethereum/)) exA.push('crypto');
    if (has(/pre[- ]?ipo|private[- ]compan|unlisted/)) exA.push('private');
    if (exA.length) {
      c.asset_set = [...new Set(exA)];
      c.asset_exclusive = true;
    }
    const exR: string[] = [];
    if (has(/\bus\b(?![-\s]?dollars?)|american\b(?![-\s]?dollars?)|united states(?![-\s]?dollars?)/)) exR.push('us');
    if (has(/europe|european/)) exR.push('eu');
    if (has(/china|chinese|hong ?kong/)) exR.push('china');
    if (has(/\basia\b|asian|japan|korea|india|taiwan/)) exR.push('asia');
    if (exR.length) {
      c.region_set = regionSet(exR);
      c.region_exclusive = true;
    }
  }
  c.constrained = !!(c.asset_set!.length || c.region_set!.length || c.cap_set!.length || c.exclusions_set!.length);
  return c;
}

/** v3 mergeCrit verbatim: restrictive fields REPLACE (last writer wins,
 * exclusive beats non-exclusive from the same source); exclusions ADD. */
export function mergeCrit(base: Crit, extra: Crit, opts: { sameSource?: boolean } = {}): Crit {
  base = base || {};
  extra = extra || {};
  const out: Crit = { ...base };
  // Scalar preferences travel with whichever side defines them (extra wins, v3).
  (['cex_only', 'cn_hkex_only', 'risk', 'horizon', 'familiarity', 'spread', 'expert'] as const).forEach((k) => {
    if (extra[k] !== undefined) (out as Record<string, unknown>)[k] = extra[k];
  });
  (
    [
      ['asset_set', 'asset_exclusive'],
      ['region_set', 'region_exclusive'],
      ['cap_set', null],
    ] as [keyof Crit, keyof Crit | null][]
  ).forEach(([f, ex]) => {
    const b = (base[f] as string[] | undefined) ?? [];
    const e = (extra[f] as string[] | undefined) ?? [];
    if (e.length) {
      // same-source guard: an exclusive extraction ("only crypto") beats a
      // non-exclusive one from the same text
      if (opts.sameSource && ex && base[ex] && !extra[ex]) {
        (out[f] as string[]) = b.slice();
      } else {
        (out[f] as string[]) = [...new Set(e)];
        if (ex && extra[ex]) (out[ex] as boolean) = true;
      }
    } else {
      (out[f] as string[]) = b.slice();
      if (ex && base[ex]) (out[ex] as boolean) = true;
    }
  });
  out.exclusions_set = [...new Set([...(base.exclusions_set ?? []), ...(extra.exclusions_set ?? [])])];
  out.include_tickers = [...new Set([...(base.include_tickers ?? []), ...(extra.include_tickers ?? [])])];
  out.exclude_tickers = [...new Set([...(base.exclude_tickers ?? []), ...(extra.exclude_tickers ?? [])])];
  const noteBits = [out.constraint_note, extra.constraint_note].filter(Boolean) as string[];
  if (noteBits.length) out.constraint_note = clipText([...new Set(noteBits)].join(' · '), 180);
  if (extra.constrained) out.constrained = true;
  return out;
}

/** Human-readable binding-requirements summary for prompts (v3 reqSummary). */
export function reqSummary(crit: Crit | null | undefined): string {
  if (!crit) return '';
  const parts: string[] = [];
  const AL: Record<string, string> = { stock: 'stocks', crypto: 'crypto', etf: 'ETFs', bond: 'bonds', private: 'pre-IPO private companies' };
  const RL: Record<string, string> = { us: 'US', eu: 'Europe', cn: 'China', it: 'Italy (Italian assets incl. Italy-exposure ETFs, wherever domiciled)', other: 'other international' };
  if (crit.asset_set?.length) parts.push('asset classes: ONLY ' + crit.asset_set.map((a) => AL[a] ?? a).join(' + '));
  if (crit.region_set?.length) parts.push('markets: ONLY ' + crit.region_set.map((r) => RL[r] ?? r).join(' / '));
  if (crit.cap_set?.length) parts.push('size: ONLY ' + crit.cap_set.join('/'));
  if (crit.cn_hkex_only) parts.push('China listings: HKEX only (no US ADR/OTC lines)');
  if (crit.exclusions_set?.length) parts.push('exclude: ' + crit.exclusions_set.join(', '));
  if (crit.exclude_tickers?.length) parts.push('never include exact tickers only: ' + crit.exclude_tickers.join(', '));
  if (crit.constraint_note) parts.push('verbatim requirement: “' + crit.constraint_note + '”');
  return parts.join('; ');
}

/** Beginner / low-risk profile cue in free text (spec §5.1b). A self-described
 * new investor or an explicitly low-risk / conservative / "safe" mandate —
 * multilingual, Italian included like INSTR_RE. "safe" only counts next to an
 * investing word so "safe harbor"/"safe bet on X" prose doesn't trip it. */
export const BEGINNER_LOWRISK_RE =
  /\b(beginners?|new to invest(?:ing)?|just start(?:ing|ed)(?: out)?|starting out|novice|first[- ]?time investor|new investor|low[- ]?risk|lower[- ]?risk|risk[- ]?averse|conservative(?:ly)?|capital preservation|preserve (?:my )?capital|safe(?:st)?\s+(?:invest\w*|option|asset|choice|way|bet)|principiante|basso rischio|prudente|conservativ[oa])\b/i;

export function isBeginnerOrLowRisk(text: string): boolean {
  return BEGINNER_LOWRISK_RE.test(text || '');
}

/** First-run ETF default for beginner / low-risk theses (spec §5.1b). A new or
 * explicitly low-risk investor who has NOT already named an asset class and
 * names no specific assets (no anchors) gets an ETF-only FIRST screen — the
 * class advisers steer such investors toward. Mutates and returns docCrit.
 * The review-card Asset seg + a re-run override it (a re-run posts an explicit
 * cardCrit that replaces this under exclusive-merge), so it only shapes the
 * first run. Guards: a named asset keeps its anchor + class (hasAnchors); an
 * explicit asset request keeps its class (non-empty asset_set). */
export function applyBeginnerEtfDefault(docCrit: Crit, text: string, hasAnchors: boolean): Crit {
  if (!hasAnchors && !docCrit.asset_set?.length && isBeginnerOrLowRisk(text)) {
    docCrit.asset_set = ['etf'];
    docCrit.constrained = true;
  }
  return docCrit;
}

/** Does `c` bind anything? The run passes `null` instead of a crit without
 * one, so every BINDING field must count here — a CEX-only venue rule (the
 * interview's crypto-venue answer) used to be dropped when it was the only
 * constraint. */
export function hasAnyConstraint(c: Crit | null | undefined): boolean {
  return !!(
    c &&
    (c.asset_set?.length ||
      c.region_set?.length ||
      c.cap_set?.length ||
      c.exclusions_set?.length ||
      c.include_tickers?.length ||
      c.exclude_tickers?.length ||
      c.constraint_note ||
      c.cex_only ||
      c.cn_hkex_only)
  );
}

// ---- tolerant coercion of LLM JSON fields -----------------------------------
// Models routinely answer a "list of strings" field with a bare string, a
// comma-joined string, an array of objects or null. `x ?? []` only guards the
// null case, so `.map` on a string threw a TypeError that killed the whole run.

/** Coerce any JSON value to a clean string[]. Arrays keep their usable items
 * (strings, numbers, or objects carrying name/ticker/text); a bare string is
 * split on commas, semicolons and newlines; anything else becomes []. */
export function asStringArray(x: unknown): string[] {
  const one = (v: unknown): string => {
    if (typeof v === 'string') return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      for (const k of ['name', 'ticker', 'text', 'label']) {
        if (typeof o[k] === 'string') return (o[k] as string).trim();
      }
    }
    return '';
  };
  if (Array.isArray(x)) return x.map(one).filter(Boolean);
  if (typeof x === 'string') return x.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);
  return [];
}

/** Coerce any JSON value to a trimmed string ('' for null/objects/arrays). */
export function asText(x: unknown): string {
  if (typeof x === 'string') return x.trim();
  if (typeof x === 'number' && Number.isFinite(x)) return String(x);
  return '';
}

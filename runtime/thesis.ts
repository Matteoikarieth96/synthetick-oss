/**
 * /thesis (spec §5.1) — carry over from v3 unchanged in behavior:
 * structured thesis via Claude + dual-extractor union (LLM ∪ deterministic
 * regex on instruction sentences, exclusive-merge, same-source guard).
 * v4 change per spec: anchors resolve against the DB (ilike), not a hand list.
 * 2026-07-06: prompt sees the whole document up to DOC_CHAR_CAP (was 6k chars).
 */
import { z } from 'zod';
import { callClaude, parseJSON } from './llm.js';
import { log } from '../ingest/lib/log.js';
import { supabase } from '../ingest/lib/supabase.js';
import {
  offlineConstraints,
  mergeCrit,
  regionSet,
  applyBeginnerEtfDefault,
  asStringArray,
  asText,
  normalizeAssetClass,
  normalizeCapClass,
  type Crit,
} from './requirements.js';

export interface Thesis {
  title: string;
  stance: string;
  summary: string;
  intent: 'anchor' | 'thematic';
  /** 'short' = bet against; 'both' = 5 longs + 5 shorts (spec §5.1). */
  direction: 'long' | 'short' | 'both';
  anchors: string[]; // tickers resolved against the DB
  /** Central companies that do NOT trade publicly (spec §5.1: a product's
   * owner resolved up the chain may be private — xAI, SpaceX…). Shown on the
   * review card; they can never be picks in a listed-only universe. */
  private_entities: { name: string; note: string }[];
  avoid: string[];
  themes: string[];
  /** Goal-seeking theses only (spec §5.1): 2-5 mutually distinct strategy
   * families that each independently express the goal ("hedge against the
   * dollar" → precious metals / non-USD currencies / …). [] for directional
   * theses; drives the Breadth control + Diversified allocation (§5.3, §6). */
  strategies: string[];
  docCrit: Crit;
}

/**
 * What the model returned, after coercion. Every list is a real string[] and
 * every scalar a string, whatever shape the model used (a bare string, an
 * array of objects, null, a number) — a single `.map` on a string used to
 * throw a TypeError and kill the whole run.
 */
const strList = z.preprocess(asStringArray, z.array(z.string()));
const zText = z.preprocess(asText, z.string());
const privateEntities = z.preprocess(
  (v) =>
    (Array.isArray(v) ? v : typeof v === 'string' ? asStringArray(v) : [])
      .map((p: unknown) => {
        if (typeof p === 'string') return { name: p, note: '' };
        const o = p && typeof p === 'object' ? (p as Record<string, unknown>) : {};
        return { name: asText(o.name), note: asText(o.note) };
      })
      .filter((p) => p.name),
  z.array(z.object({ name: z.string(), note: z.string() })),
);
const RawThesisSchema = z.object({
  title: zText,
  stance: zText,
  summary: zText,
  intent: zText,
  direction: zText,
  anchors: strList,
  private_entities: privateEntities,
  avoid: strList,
  themes: strList,
  strategies: strList,
  requirements: z.preprocess(
    (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {}),
    z.object({
      asset_classes: strList,
      regions: strList,
      caps: strList,
      exclude: strList,
      semantic: zText,
    }),
  ),
});
type RawThesis = z.infer<typeof RawThesisSchema>;

/** Pure: any parsed JSON value → a fully-defaulted RawThesis. Never throws:
 * `null`, an array or a string (a model that answered with the wrong shape)
 * yields the empty thesis, and buildThesis then falls back to the document's
 * own words. Exported for offline tests. */
export function parseRawThesis(j: unknown): RawThesis {
  const o = j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  const r = RawThesisSchema.safeParse(o);
  return r.success ? r.data : RawThesisSchema.parse({});
}

/** Resolve free-form anchor mentions against the assets table (spec §5.1).
 * Strict on purpose: explicit ticker → exact name → name prefix. No fuzzy
 * `%substring%` first-match, and no string-built `.or()` — PostgREST treats
 * commas/colons in mentions like "Lennox International (NYSE: LII)" as filter
 * syntax, which is how false anchors like HYLN got in. A mention that doesn't
 * resolve is dropped; a wrong anchor is worse than a missing one, since
 * anchors are force-included in the candidate pool. */
const CORP_SUFFIX_RE =
  /[\s,]+(inc(orporated)?|corp(oration)?|co(mpany)?|ltd|limited|plc|s\.?p?\.?a\.?|n\.?v\.?|s\.?e\.?|a\.?g\.?|holdings?|group)\.?$/i;

export async function resolveAnchors(mentions: string[]): Promise<string[]> {
  const escLike = (s: string) => s.replace(/[%_\\]/g, '\\$&');
  const lookupRow = async (col: 'ticker' | 'name', pattern: string): Promise<{ ticker: string; cap: number } | undefined> => {
    const { data, error } = await supabase
      .from('assets')
      .select('ticker, exchange, market_cap_usd')
      .eq('is_active', true)
      .ilike(col, pattern)
      // Ambiguous matches resolve to the major, not an arbitrary row.
      .order('market_cap_usd', { ascending: false, nullsFirst: false })
      .limit(5);
    // A DB hiccup must not look like "no such asset": anchors are
    // force-included, so a silently dropped one changes the result. Still
    // non-fatal (the run continues), but visible in the logs.
    if (error) log.warn(`anchor lookup (${col}) failed, mention left unresolved: ${error.message}`);
    if (!data?.length) return undefined;
    // Same company can have several lines with near-equal caps ("Baidu Inc" =
    // BIDU ADR + BAIDF OTC): prefer a major-exchange line over an OTC one.
    const major = data.find((r) => !/^(PINK|OTC|PK\b)/i.test(r.exchange ?? ''));
    const row = major ?? data[0]!;
    return { ticker: row.ticker, cap: Number(row.market_cap_usd ?? 0) };
  };
  const lookup = async (col: 'ticker' | 'name', pattern: string) => (await lookupRow(col, pattern))?.ticker;
  const out: string[] = [];
  for (const m of mentions.slice(0, 12)) {
    const q = m.trim().replace(/^["'“”]+|["'“”]+$/g, '');
    if (q.length < 2) continue;
    // "Lennox International (NYSE: LII)" → ticker candidate LII. Digits are
    // legal (HKEX "0700"); an exchange suffix is also tried without ("0700.HK").
    const paren = q.match(/\((?:[A-Z]+:\s*)?([A-Z0-9]{1,6}(?:\.[A-Z]+)?)\)/)?.[1];
    const parenBase = paren?.replace(/\.[A-Z]+$/, '');
    // "Strategy (formerly MicroStrategy)" → name candidate "MicroStrategy".
    const parenName = q
      .match(/\(([^)]{3,60})\)/)?.[1]
      ?.replace(/^\s*(formerly|previously|now|aka|a\.k\.a\.|née)\s+/i, '')
      .trim();
    // Parentheticals are short; the bound keeps a run of "(" from scanning to the end each time.
    const outer = q.replace(/\([^)]{0,200}\)/g, ' ').replace(/\s+/g, ' ').trim();
    // Longest name first: a rebrand's more specific former name must win the
    // prefix round (bare "Strategy%" would grab an unrelated "Strategy Shares…" ETF).
    const names = [...new Set([outer, parenName].filter((n): n is string => !!n && n.length >= 2 && n !== paren))]
      .sort((a, b) => b.length - a.length);
    // Corporate-suffix/punctuation variants: "Tesla, Inc." ↔ "Tesla Inc" ↔
    // "Tesla", "Tencent Holdings Limited" ↔ "Tencent" — vendors and models
    // never agree on the tail. Derived stems are still exact/prefix matched.
    const stems: string[] = [];
    for (const n of names) {
      let s = n.replace(/[.,’']/g, '').replace(/\s+/g, ' ').trim();
      if (s && s.toLowerCase() !== n.toLowerCase()) stems.push(s);
      for (let guard = 0; guard < 3; guard++) {
        const next = s.replace(CORP_SUFFIX_RE, '').trim();
        if (next === s || next.length < 2) break;
        s = next;
        stems.push(s);
      }
    }
    const allNames = [...new Set([...names, ...stems])].sort((a, b) => b.length - a.length);
    const tickerish = /^[A-Z0-9.\-]{1,6}$/.test(outer);
    let hit =
      (paren ? await lookup('ticker', escLike(paren)) : undefined) ??
      (parenBase && parenBase !== paren ? await lookup('ticker', escLike(parenBase)) : undefined) ??
      (tickerish ? await lookup('ticker', escLike(outer)) : undefined);
    if (!hit) for (const n of allNames) { hit = await lookup('name', escLike(n)); if (hit) break; }
    // Prefix round: ≥4 chars for raw mentions (v3 strictness), ≥2 for stems —
    // a stem came from an explicit longer company name, so "3M" (from
    // "3M Company") or "Tesla" (from "Tesla, Inc.") may prefix-match. A
    // leading-article variant runs alongside ("Boeing" must reach "The
    // Boeing Company", not lose to a tokenized "Boeing (Ondo…)" line), and
    // the larger market cap wins across both patterns.
    if (!hit) for (const n of allNames) {
      const min = stems.includes(n) ? 2 : 4;
      if (n.length < min) continue;
      const plain = await lookupRow('name', `${escLike(n)}%`);
      const the = /^the\s/i.test(n) ? undefined : await lookupRow('name', `The ${escLike(n)}%`);
      const best = [plain, the].filter((r): r is NonNullable<typeof r> => !!r).sort((a, b) => b.cap - a.cap)[0];
      if (best) { hit = best.ticker; break; }
    }
    if (hit) out.push(hit);
  }
  return [...new Set(out)];
}

/** The resolved rows behind a set of anchor tickers (major line per ticker). */
async function anchorRows(tickers: string[]): Promise<{ ticker: string; name: string; kind: string; sector: string | null }[]> {
  if (!tickers.length) return [];
  const { data } = await supabase
    .from('assets')
    .select('ticker, name, kind, sector')
    .in('ticker', tickers)
    .eq('is_active', true)
    .order('market_cap_usd', { ascending: false, nullsFirst: false });
  const seen = new Set<string>();
  const out: { ticker: string; name: string; kind: string; sector: string | null }[] = [];
  for (const r of data ?? []) if (!seen.has(r.ticker)) { seen.add(r.ticker); out.push(r); }
  return out;
}

interface EntityCheck {
  keep: Set<string>;
  add: string[]; // "Company Name (TICKER)" — re-resolved against the DB
  unpickable: { name: string; note: string }[];
  /** Summary with stale ownership/listing claims fixed (spec §5.1); undefined = already accurate. */
  correctedSummary?: string;
}

/** Web-checked entity status (spec §5.1). Two failure modes it exists for:
 * (1) name/ticker lookup can't tell the entity a document MEANS from an
 * unrelated listed asset sharing the string — "xAI" resolves to the XAI
 * Octagon credit fund; (2) training data goes stale on corporate structure
 * (mergers, IPOs, absorptions), so listing status must come from a LIVE web
 * search, not model memory. One `:online` call; fails open (null) so the
 * caller keeps the plain resolution. `allowWebSearch` (when given) is asked
 * only when the paid call is really about to happen. */
async function checkEntities(
  thesisLine: string,
  summary: string,
  anchors: string[],
  unresolvedMentions: string[],
  claimedPrivate: { name: string; note: string }[],
  allowWebSearch?: () => boolean,
): Promise<EntityCheck | null> {
  const rows = await anchorRows(anchors);
  if (!rows.length && !unresolvedMentions.length && !claimedPrivate.length) return null;
  if (allowWebSearch && !allowWebSearch()) {
    log.info('thesis: web entity check skipped (web lookup budget spent), using the plain resolution');
    return null;
  }
  const sys =
    'You verify entity resolution for investment research using CURRENT facts. Corporate structure changes (mergers, IPOs, absorptions) — your training data may be stale, so use a quick web search to confirm ownership and listing status TODAY before answering. Output ONLY minified JSON, no commentary.';
  const usr =
    `Thesis: """${thesisLine.slice(0, 300)}"""\n\n` +
    `Extracted summary (written WITHOUT web access — its factual claims may be stale):\n"""${summary.slice(0, 700)}"""\n\n` +
    (rows.length
      ? `Anchor candidates resolved from our asset DB by name/ticker lookup — collisions happen (a private startup's name can match an unrelated listed fund):\n${rows
          .map((r) => `${r.ticker} = ${r.name} (${r.kind}${r.sector ? ', ' + r.sector : ''})`)
          .join('\n')}\n\n`
      : '') +
    (unresolvedMentions.length ? `Entity mentions that did NOT resolve in our DB: ${unresolvedMentions.join('; ')}\n\n` : '') +
    (claimedPrivate.length ? `Entities the extractor believes are private: ${claimedPrivate.map((p) => p.name).join('; ')}\n\n` : '') +
    `After checking current listing status on the web, return:\n` +
    `{"keep":["only candidate tickers whose asset genuinely IS an entity this thesis centers on"],` +
    `"add":["ONLY entities the thesis itself CENTERS on (the owner/maker of a named product, or the LISTED parent/acquirer that absorbed a private company central to the thesis) that are publicly traded today and missing above, as 'Company Name (TICKER)'. NEVER suppliers, competitors, customers or ecosystem beneficiaries — those are search themes, not anchors. Usually 0-1 entries, at most 2; [] if none"],` +
    `"private":[{"name":"central entity NOT publicly investable today","note":"≤12 words: relation to the thesis + current status"}],` +
    `"corrected_summary":"the summary rewritten ONLY IF it contains verifiable factual claims that are outdated or wrong per the web — ownership, corporate structure, listing status (e.g. calls a company private after it was absorbed by a listed one), product/release status, dates. Fix ONLY such facts; NEVER change or second-guess the user's investment view, direction, or scope, and keep the wording everywhere else; null when the summary is already accurate"}`;
  try {
    const v = parseJSON<Record<string, unknown> | null>(
      await callClaude(usr, { system: sys, maxTokens: 1000, temperature: 0, web: true }),
    );
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const corrected = asText(v.corrected_summary);
    const priv = (Array.isArray(v.private) ? v.private : []) as Record<string, unknown>[];
    return {
      keep: new Set(asStringArray(v.keep).map((x) => x.toUpperCase())),
      add: asStringArray(v.add).slice(0, 3),
      unpickable: priv
        .map((p) => ({ name: asText(p?.name).slice(0, 60), note: asText(p?.note).slice(0, 90) }))
        .filter((p) => p.name),
      // Guard against a lazy echo or a gutted rewrite: only a substantive,
      // genuinely different summary replaces the extraction's.
      correctedSummary: corrected.length >= 60 && corrected !== summary ? corrected.slice(0, 1200) : undefined,
    };
  } catch {
    return null;
  }
}

// Whole document up to a safety ceiling (≈37k tokens); past it, keep head +
// tail — instructions cluster at document edges. Regex extractors below always
// see the full text either way.
const DOC_CHAR_CAP = 150_000;
const docExcerpt = (t: string) =>
  t.length <= DOC_CHAR_CAP
    ? t
    : `${t.slice(0, DOC_CHAR_CAP - 20_000)}\n[…middle of document omitted…]\n${t.slice(-20_000)}`;

/** "Companies similar to Nvidia" means Nvidia is the reference object, not a
 * desired pick. Keep it as an anchor for context, but exclude the exact ticker. */
export function asksForSimilarAssets(text: string): boolean {
  const t = text.replace(/\s+/g, ' ');
  return (
    /\b(?:compan(?:y|ies)|stocks?|shares?|equities|assets?|business(?:es)?|tokens?|coins?|etfs?)\s+(?:(?:that\s+)?are\s+)?(?:similar|comparable|analogous|like)\s+(?:to\s+)?/i.test(t) ||
    /\b(?:alternatives?|peers|competitors)\s+(?:to|of|for)\b/i.test(t)
  );
}

export function similarReferenceMentions(text: string): string[] {
  const out: string[] = [];
  const add = (raw: string | undefined) => {
    const stop = /\b(?:but|not|itself|for|in|with|exposed|related|around|that|which|and|or|only)\b/i.exec(String(raw ?? ''));
    // Cut at the first stop word (a `\b...\b.*$` regex re-scanned the line from every stop word).
    const cleaned = (stop ? String(raw ?? '').slice(0, stop.index) : String(raw ?? ''))
      .replace(/^["'“”]+|["'“”]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (cleaned.length >= 2 && !out.some((x) => x.toLowerCase() === cleaned.toLowerCase())) out.push(cleaned);
  };
  for (const re of [
    /\b(?:compan(?:y|ies)|stocks?|shares?|equities|assets?|business(?:es)?|tokens?|coins?|etfs?)\s+(?:(?:that\s+)?are\s+)?(?:similar|comparable|analogous)\s+to\s+([^.,;?!\n]{1,90})/gi,
    /\b(?:compan(?:y|ies)|stocks?|shares?|equities|assets?|business(?:es)?|tokens?|coins?|etfs?)\s+(?:(?:that\s+)?are\s+)?like\s+([^.,;?!\n]{1,90})/gi,
    /\b(?:alternatives?|peers|competitors)\s+(?:to|of|for)\s+([^.,;?!\n]{1,90})/gi,
  ]) {
    for (const m of text.matchAll(re)) add(m[1]);
  }
  return out.slice(0, 6);
}

export interface BuildThesisOptions {
  /**
   * Gate for the PAID `:online` entity check (final audit H1). The uncharged
   * /api/thesis route passes the per-user web-lookup budget; when it says no,
   * the check is skipped and the plain DB resolution stands (the documented
   * "check unavailable" path), so the review still works. Charged runs pass
   * nothing and always run the check.
   */
  allowWebSearch?: () => boolean;
}

/** v3 buildThesis prompt, minus the hand-catalog anchor list. */
export async function buildThesis(text: string, opts: BuildThesisOptions = {}): Promise<Thesis> {
  const sys =
    'You are a precise investment-research analyst. Read the user’s document and extract a structured thesis. Output ONLY minified JSON, no markdown, no commentary.';
  const usr =
    `Document:\n"""${docExcerpt(text)}"""\n\nReturn JSON with exactly these keys:\n` +
    `{"title":"short label (≤6 words)","stance":"one sentence: the user’s core view",` +
    `"summary":"2-4 sentence reference thesis written in the user’s spirit — ALWAYS in English regardless of the document language",` +
    `"intent":"anchor if the user is bullish on specific named assets they hold/favor, else thematic",` +
    `"direction":"short if the user asks what to short/bet against, or expresses a bearish thesis they want to profit from (e.g. ‘X is doomed, what do I short?’); both if they explicitly want winners AND losers / longs AND shorts / both sides of the trade; otherwise long",` +
    `"anchors":["assets CENTRAL to the thesis — whether to bet on them or against them (a bearish thesis about Bitcoin makes Bitcoin an anchor). PROPER-NAME RESOLUTION: when the document centers on a product, model, service, brand, or subsidiary rather than a company, the anchor is its OWNER — the publicly listed company that sells or controls it, resolved UP the ownership chain (MacBook → Apple; Instagram → Meta Platforms; Gemini → Alphabet; a surge in PS5 sales → Sony). This applies even when no company is named anywhere: a thesis about Post-it notes and industrial adhesives is a thesis about 3M — if the named products belong to one identifiable company, that company IS the anchor. Use the ticker symbol if the document states one (e.g. LII, BTC), else the most widely-recognized company name (for a rebrand like Strategy, keep the parenthetical: 'Strategy (formerly MicroStrategy)'). ONLY entities whose stock/token actually trades publicly — NEVER a private company: xAI, SpaceX, OpenAI, Anthropic and similar startups do NOT trade and belong in private_entities instead, and you must NOT guess a ticker for them (invented tickers collide with unrelated listed funds); NOT passing mentions; ECOSYSTEM/VENUE SCOPE IS NOT AN ANCHOR: when a blockchain or platform names WHERE the assets live rather than WHAT to buy ('assets on Ethereum', 'tokens in the Solana ecosystem', 'protocols on Base'), the chain's own token is NOT an anchor — put the ecosystem in requirements.semantic instead; anchor a chain token only when the thesis bets on that asset itself ('ETH will outperform'); [] if none"],` +
    `"private_entities":[{"name":"company/organization CENTRAL to the thesis whose stock does NOT trade publicly — startups and private companies (xAI, SpaceX, OpenAI…), including the owner a central product resolves to when that owner is private (Grok → xAI)","note":"≤12 words: relation to the thesis, plus notable ownership links (e.g. 'builds Grok; Musk-controlled, sibling of SpaceX')"}],` +
    `"avoid":["assets/sectors the user dislikes or rules out; [] if none"],` +
    `"themes":["3-6 concise investable themes, in English"],` +
    `"strategies":["ONLY when the document states a GOAL rather than a directional view on specific assets — hedging/protecting against something, generating income, getting broad exposure to an outcome: 2-5 MUTUALLY DISTINCT strategy families that each INDEPENDENTLY achieve the goal, ≤5 words each, in English (e.g. hedging against the dollar → 'Precious metals','Non-USD currencies','Bitcoin & hard-asset crypto','Inflation-linked bonds','Non-US equities'). Strategies are NOT themes: themes are facets of one topic; strategies are alternative ANSWERS the user could choose between. A directional thesis about specific assets/sectors ('NVDA wins AI', 'short legacy autos') gets []. Never pad: a goal with one real expression gets []"],` +
    `"requirements":{"asset_classes":["subset of stock,etf,bond,crypto,private — ONLY types the user EXPLICITLY requests (e.g. ‘I want European ETFs’ -> ["etf"]; ‘pre-IPO / private companies only’ -> ["private"]); merely saying ‘companies’/‘businesses’ as the subject of the thesis is NOT a stocks-only request; [] if none stated"],` +
    `"regions":["subset of us,eu,china,asia,row the user explicitly restricts to; [] if none"],` +
    `"caps":["subset of mega,large,mid,small,micro if explicitly stated"],` +
    `"exclude":["subset of defense,micro,stableyield if explicitly stated"],` +
    `"semantic":"a meaning-level scope RESTRICTION the user explicitly states that the fields above cannot express (e.g. ‘only crypto related to the Ethereum ecosystem’), quoted or restated in ≤15 words; empty string if none"}}\n` +
    `CRITICAL: requirements are the user’s literal instructions about WHAT to show. They must be followed precisely downstream, so only include what is explicitly stated — never infer. Risk warnings, disclaimers, and advice the document's author gives their audience (e.g. "companies must avoid X due to liability") are NOT requirements.\n` +
    `CRITICAL: the document's SUBJECT is not a requirement. A paper arguing for European AI compute independence is a thesis ABOUT that topic — it is NOT an instruction to exclude assets that are not "AI-compute-independence themed", and "semantic" must stay empty. Topics belong in summary/themes, where they already drive retrieval and scoring; "semantic" is only for a restriction on WHAT MAY APPEAR in the results.`;
  // One retry on a non-JSON answer (spec §1: every LLM output is validated
  // JSON with a fallback). If both attempts fail the run continues on the
  // document's own words rather than aborting: no anchors or themes, the
  // summary is the document's opening, and the deterministic extractors below
  // (offlineConstraints, direction regexes) still apply. A transport/credential
  // error from callClaude itself still propagates — nothing downstream would
  // work either.
  let parsedJson: unknown;
  for (let attempt = 0; attempt < 2 && parsedJson === undefined; attempt++) {
    const raw = await callClaude(usr, { system: sys, maxTokens: 1500, temperature: 0.2 });
    try {
      parsedJson = parseJSON<unknown>(raw);
    } catch (err) {
      log.warn(`thesis extraction returned non-JSON (attempt ${attempt + 1}): ${(err as Error).message.slice(0, 160)}`);
    }
  }
  const j = parseRawThesis(parsedJson);
  if (!j.summary) {
    log.warn('thesis extraction unusable; continuing with the document text as the summary');
    j.summary = text.replace(/\s+/g, ' ').trim().slice(0, 600);
  }

  // A name the model itself calls private must not also be resolved as an
  // anchor — bare names collide with unrelated listed tickers (xAI → the XAI
  // Octagon credit fund).
  const rawPrivate = j.private_entities
    .map((p) => ({ name: p.name.slice(0, 60), note: p.note.slice(0, 90) }))
    .slice(0, 6);
  const privNames = new Set(rawPrivate.map((p) => p.name.toLowerCase()));
  const anchorMentions = j.anchors.filter((m) => !privNames.has(m.trim().toLowerCase()));
  // Per-mention resolution so the web check can see what did NOT resolve.
  let anchors: string[] = [];
  const unresolvedMentions: string[] = [];
  for (const m of anchorMentions.slice(0, 12)) {
    const [hit] = await resolveAnchors([m]);
    if (hit) { if (!anchors.includes(hit)) anchors.push(hit); }
    else if (m.trim()) unresolvedMentions.push(m.trim());
  }
  const private_entities: Thesis['private_entities'] = [];
  const addPrivate = (name: string, note: string) => {
    if (name && private_entities.length < 6 && !private_entities.some((e) => e.name.toLowerCase() === name.toLowerCase())) {
      private_entities.push({ name, note });
    }
  };
  // Web entity check (spec §5.1): rejects DB name-collisions, adds listed
  // parents/acquirers current as of TODAY, classifies the rest as private,
  // and fixes stale ownership/listing claims inside the summary itself.
  let summary = j.summary;
  const check = await checkEntities(j.stance || j.summary, summary, anchors, unresolvedMentions, rawPrivate, opts.allowWebSearch);
  if (check) {
    if (check.correctedSummary) summary = check.correctedSummary;
    anchors = anchors.filter((t) => check.keep.has(t.toUpperCase()));
    for (const a of check.add) {
      // Name-first: the web model's parenthetical ticker is a guess, and
      // resolveAnchors trusts paren tickers first — "Tesla (TSLAX)" would
      // anchor a $59M tokenized line instead of TSLA. Resolving the bare name
      // is market-cap ordered, so the major listing wins; the stated ticker
      // is only the fallback.
      const bare = a.replace(/\([^)]{0,200}\)\s*$/, '').trim();
      const [hit] = bare && bare !== a ? await resolveAnchors([bare]) : [undefined];
      const [hit2] = hit ? [hit] : await resolveAnchors([a]);
      if (hit2) {
        if (!anchors.includes(hit2)) anchors.push(hit2);
      } else {
        // Listed per the web, but not in our ingested universe (recent IPO):
        // honest note instead of a silent drop or a fabricated pick.
        addPrivate(bare || a, 'publicly listed, but not in SyntheTick’s universe yet');
      }
    }
    check.unpickable.forEach((p) => addPrivate(p.name, p.note));
  } else {
    // Check unavailable — fall back to plain resolution + the extractor's own
    // private list (a claimed-private name that resolves is promoted).
    for (const p of rawPrivate) {
      const [hit] = await resolveAnchors([p.name]);
      if (hit) { if (!anchors.includes(hit)) anchors.push(hit); }
      else addPrivate(p.name, p.note);
    }
  }
  const rq = j.requirements;
  const llmCrit: Crit = {
    // Plurals/synonyms normalized, not dropped: losing one class of a mixed
    // request made the binding set narrower than what the user asked for.
    asset_set: [...new Set(rq.asset_classes.map(normalizeAssetClass).filter(Boolean))],
    region_set: regionSet(rq.regions),
    cap_set: [...new Set(rq.caps.map(normalizeCapClass).filter(Boolean))],
    exclusions_set: rq.exclude.map((v) => v.toLowerCase()).filter((v) => ['defense', 'micro', 'stableyield'].includes(v)),
    constraint_note: rq.semantic ? rq.semantic.slice(0, 90) : undefined,
    constrained: true,
  };
  // Dual-extractor union (v3 line 1310): deterministic regex on the document's
  // instruction sentences merged over the LLM extraction, same-source guard on.
  const docCrit = mergeCrit(llmCrit, offlineConstraints(text, true), { sameSource: true });
  // Beginner / low-risk first screen (spec §5.1b): a new or explicitly low-risk
  // investor who named no asset class and no specific assets gets an ETF-only
  // FIRST run — broadenable via the review-card Asset seg + a re-run.
  applyBeginnerEtfDefault(docCrit, text, anchors.length > 0);
  const similarRefTickers = asksForSimilarAssets(text) ? await resolveAnchors(similarReferenceMentions(text)) : [];
  const similarExcludes = [...new Set([...anchors, ...similarRefTickers])];
  if (similarExcludes.length && asksForSimilarAssets(text)) {
    docCrit.exclude_tickers = [...new Set([...(docCrit.exclude_tickers ?? []), ...similarExcludes])];
    docCrit.constrained = true;
  }

  const intent = j.intent === 'anchor' || j.intent === 'thematic' ? j.intent : anchors.length ? 'anchor' : 'thematic';
  // Deterministic backstop for direction, like the requirements dual-extractor.
  const SHORT_RE = /\b(short(?:ing|s)?\b(?!\s*-?\s*term)|bet(?:ting)? against|puts on|overvalued|doomed|collapse|bubble|to zero|profit from .{0,30}(decline|fall|crash))\b/i;
  const BOTH_RE = /\b(longs? and shorts?|shorts? and longs?|both sides|winners and losers|losers and winners|pair trade)\b/i;
  const direction: Thesis['direction'] =
    j.direction === 'both' || BOTH_RE.test(text)
      ? 'both'
      : j.direction === 'short' || (j.direction !== 'long' && SHORT_RE.test(text))
        ? 'short'
        : 'long';
  return {
    title: j.title || 'Investment thesis',
    stance: j.stance,
    summary,
    intent,
    direction,
    anchors,
    private_entities,
    avoid: j.avoid,
    themes: j.themes,
    // A single "strategy" is just the thesis itself — breadth needs ≥2 real
    // alternatives, so a lone entry is dropped rather than shown as a choice.
    strategies: (() => {
      const seen = new Set<string>();
      const s = j.strategies
        .map((x) => x.trim().slice(0, 60))
        .filter((x) => x && !seen.has(x.toLowerCase()) && (seen.add(x.toLowerCase()), true))
        .slice(0, 5);
      return s.length >= 2 ? s : [];
    })(),
    docCrit,
  };
}

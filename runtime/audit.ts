/**
 * /audit (spec §5.4) — both v3 exit audits, unchanged in behavior:
 * 1. Deterministic: every pick re-checked in code against the requirement
 *    object (kind/region/cap/venue/exclusions). Violators dropped + logged.
 * 2. Compliance (LLM): picks vs the user's literal instruction sentences.
 */
import { z } from 'zod';
import { log } from '../ingest/lib/log.js';
import { callClaude, parseJSON } from './llm.js';
import type { Crit } from './requirements.js';
import { fundMatchesRegions } from './fundgeo.js';
import { sizeBand, type Candidate } from './candidates.js';
import type { Pick } from './select.js';
import { clipText } from './text.js';

/** v4 passesFilters: a DB-backed candidate vs the requirement object. */
export function passesFilters(a: Candidate, crit: Crit | null | undefined): boolean {
  if (!crit) return true;
  if (crit.asset_set?.length && !crit.asset_set.includes(a.kind)) return false;
  // Region filters don't apply to crypto (kind='crypto' is region-global, §5.2).
  // 'it' (§6) binds via the 'Italy' category tag, union with coarse regions —
  // Italy ETFs are US/IE/LU-domiciled, so the region column can't express them.
  if (crit.region_set?.length && a.kind !== 'crypto') {
    const italyPass = crit.region_set.includes('it') && (a.categories ?? []).includes('Italy');
    if (a.kind === 'etf' || a.kind === 'bond') {
      // A FUND's geography is what it holds, not where it is incorporated
      // (spec §15.4). Every UCITS ETF is Irish or Luxembourgish, so judging
      // one by assets.region excludes exactly the funds a geographic request
      // asks for. A fund with no country breakdown cannot be placed, and an
      // unverifiable asset does not satisfy a binding constraint.
      const held = fundMatchesRegions(a.etf_portfolio, crit.region_set);
      if (held !== true && !italyPass) return false;
    } else if (!crit.region_set.includes(a.region) && !italyPass) {
      return false;
    }
  }
  if (
    crit.cn_hkex_only &&
    a.kind !== 'crypto' &&
    a.region === 'cn' &&
    !/^(HK|HKEX|HKSE)$/i.test(a.exchange ?? '')
  )
    return false;
  // Cap filters don't apply to funds (§5.2): an ETF's cap_class bands its own
  // AUM, not the caps of what it holds — "small-cap" is an exposure claim.
  if (
    crit.cap_set?.length &&
    a.kind !== 'etf' &&
    a.kind !== 'bond' &&
    (!a.cap_class || !crit.cap_set.includes(a.cap_class))
  )
    return false;
  if (crit.exclude_tickers?.length && crit.exclude_tickers.includes(a.ticker)) return false;
  if (crit.cex_only && a.kind === 'crypto' && (a.cex_venues ?? []).length === 0) return false;
  for (const ex of crit.exclusions_set ?? []) {
    // v4 mapping of v3's catalog exclusion tags onto DB fields:
    if (ex === 'micro' && a.cap_class === 'micro') return false;
    if (ex === 'defense' && /defen[cs]e|aerospace|weapons?/i.test(`${a.sector ?? ''} ${a.name}`)) return false;
    if (ex === 'stableyield' && (a.categories ?? []).some((c) => /stablecoin/i.test(c))) return false;
  }
  return true;
}

/** Deterministic exit audit (v3 auditPicks): violators never render. */
export function auditPicks(picks: Pick[], crit: Crit | null | undefined): { picks: Pick[]; dropped: string[] } {
  if (!crit) return { picks, dropped: [] };
  const ok: Pick[] = [];
  const dropped: string[] = [];
  for (const p of picks) {
    if (passesFilters(p.a, crit)) ok.push(p);
    else dropped.push(p.a.ticker);
  }
  return { picks: ok, dropped };
}

/** Closed set of things a pick can violate (§5.4 2026-07-10). Each code names a
 * field of `Crit`; there is deliberately no code for "off-theme", so the
 * auditor cannot express a fit objection — fit is a /select score (§5.3). */
export const VIOLATION_CODES = ['asset_type', 'region', 'cap', 'venue', 'exclusion', 'ticker', 'semantic'] as const;
export type ViolationCode = (typeof VIOLATION_CODES)[number];

const CODE_ACTIVE: Record<ViolationCode, (c: Crit) => boolean> = {
  asset_type: (c) => !!c.asset_set?.length,
  region: (c) => !!c.region_set?.length,
  cap: (c) => !!c.cap_set?.length,
  venue: (c) => !!c.cex_only,
  exclusion: (c) => !!c.exclusions_set?.length,
  ticker: (c) => !!c.exclude_tickers?.length,
  semantic: (c) => !!c.constraint_note,
};

/** Which codes the merged requirements can actually justify. A violation whose
 * code is not active is a hallucinated constraint and never drops a pick. */
export function activeCodes(crit: Crit | null | undefined): Set<ViolationCode> {
  const out = new Set<ViolationCode>();
  if (!crit) return out;
  for (const code of VIOLATION_CODES) if (CODE_ACTIVE[code](crit)) out.add(code);
  return out;
}

export interface RawViolation {
  t?: string;
  c?: string;
  why?: string;
}

/** One compliance-audit line per pick (§5.4 2026-07-23): kind, then the SIZE
 * the row's cap_class already bands — fund AUM for etf/bond rows, market cap
 * otherwise — then sector + categories. Without the size segment the auditor
 * had to guess dollar figures for quantitative requirements ("AUM above 10
 * billion") and guessed wrong: whole runs came back empty with every ETF
 * flagged "AUM not clearly above threshold". Exported for offline tests. */
export function pickAuditLine(a: Candidate): string {
  const tags = [a.sector, ...(a.categories ?? [])].filter(Boolean).slice(0, 6).join(', ');
  return `${a.ticker} = ${a.name} (${[a.kind, sizeBand(a), tags].filter(Boolean).join('; ')})`;
}

/** Pure gate over the auditor's raw output — the load-bearing half of the fix
 * (the prompt is the other half, and prompts alone lose to a section header
 * that says "enforce strictly"). Exported for offline test coverage. */
/**
 * A violation must be a property of the PICK, not of the result list. The
 * auditor deleted all five picks of "5 picks for each side with market cap
 * above 10bn" because the list held five rather than ten — "only 5 total
 * picks shown, missing 5 app" — and deleting picks cannot fix a shortfall
 * (live 2026-07-28). Result-set shape is /select's business (§5.3), never a
 * compliance violation.
 */
const LIST_SHAPE_RE =
  /\bonly \d|\bmissing \d|\btotal picks\b|\bpicks shown\b|\bnot enough\b|\btoo few\b|\bboth sides\b|\blist (?:has|contains|shows)\b/i;

export function filterViolations(
  raw: RawViolation[],
  crit: Crit | null | undefined,
  pickTickers: Set<string>,
  /** Human labels of requirements already enforced in code (spec §15.4);
   * a violation that re-litigates one of these is discarded. */
  enforcedTerms: string[] = [],
): { drop: Record<string, string>; discarded: string[] } {
  const active = activeCodes(crit);
  const terms = enforcedTerms
    .map((t) => t.toLowerCase())
    .flatMap((t) => t.split(/\s+(?:at or above|at or below|between)\s+/)[0]?.trim() ?? [])
    .filter((t) => t.length > 2);
  const drop: Record<string, string> = {};
  const discarded: string[] = [];
  for (const v of raw) {
    if (!v?.t) continue;
    const t = String(v.t).toUpperCase();
    const code = String(v.c ?? '') as ViolationCode;
    if (!pickTickers.has(t)) continue; // ticker the model invented
    if (!active.has(code)) {
      discarded.push(`${t}(${code || 'no-code'}: ${String(v.why ?? '').slice(0, 40)})`);
      continue;
    }
    const why = String(v.why ?? '');
    if (LIST_SHAPE_RE.test(why)) {
      discarded.push(`${t}(list-shape: ${why.slice(0, 40)})`);
      continue;
    }
    // Re-litigating a requirement already verified against exact figures, from
    // a coarse band the auditor can see (spec §15.4).
    const lower = why.toLowerCase();
    if (terms.some((term) => lower.includes(term))) {
      discarded.push(`${t}(already enforced: ${why.slice(0, 40)})`);
      continue;
    }
    drop[t] = clipText(why, 60) || 'violates your instructions';
  }
  return { drop, discarded };
}

/** Compliance exit audit (v3 verifyPicks): LLM vs the user's literal words.
 * Spec §5.4 (2026-07-07): the user's own merged requirements bind strictly;
 * instruction-LIKE sentences harvested from the document bind only when they
 * clearly direct result scope — an author's risk warnings never cause a flag.
 * Spec §5.4 (2026-07-10): a violation must carry a code naming a constraint
 * that is actually present on `crit`, so the auditor can drop picks only for
 * breaking a rule — never for being a weak expression of the thesis. */
export async function verifyPicks(
  docInstr: string,
  picks: Pick[],
  userReq = '',
  crit?: Crit | null,
  /**
   * Requirements already enforced deterministically upstream (spec §15.4),
   * as human-readable lines. They are shown to the auditor as SETTLED, and
   * any code they own is removed from the enforceable list below.
   */
  enforced: { lines: string[]; suppress: ViolationCode[] } = { lines: [], suppress: [] },
  /** Injectable for offline tests; production always uses callClaude. */
  call: typeof callClaude = callClaude,
): Promise<{ drop: Record<string, string>; unavailable?: string }> {
  if ((!docInstr && !userReq) || !picks.length) return { drop: {} };
  // Nothing enforceable → nothing to audit. The document's sentences corroborate
  // constraints that reached `crit`; they are never a source of them (§5.4).
  const active = activeCodes(crit);
  // A numeric requirement checked in code must not be re-judged from a coarse
  // band. Left active, the size code deleted every pick on "Milan companies
  // with market cap between 100m and 1bn" — all 97 had been verified against
  // the exact figures moments earlier, but the auditor sees only "$300M-$2B"
  // and reads that as possibly breaching 1bn (live 2026-07-28).
  for (const code of enforced.suppress) active.delete(code);
  if (!active.size) return { drop: {} };
  // Full category context (§5.4 2026-07-08): sector alone starved the auditor —
  // PERP carries sector "Decentralized Exchange (DEX)" AND category
  // "Decentralized Finance (DeFi)"; showing only the first got DeFi picks
  // flagged as "DEX, not DeFi protocol".
  const list = picks.map((p) => pickAuditLine(p.a)).join('\n');
  const sys =
    'You are a strict compliance auditor for an investment-research tool. You flag ONLY clear violations of the user’s explicit instructions. Output ONLY minified JSON.';
  const settled = enforced.lines.length
    ? `ALREADY VERIFIED NUMERICALLY — treat as satisfied by every pick below and NEVER flag any pick for these:\n${enforced.lines.map((l) => `- ${l}`).join('\n')}\n\n`
    : '';
  const usr =
    `USER’S OWN REQUIREMENTS (set explicitly by the user — enforce strictly):\n"""${userReq.slice(0, 400) || '(none)'}"""\n\n` +
    settled +
    `INSTRUCTION-LIKE SENTENCES FROM THE SOURCE DOCUMENT (regex-harvested — read with care):\n"""${docInstr.slice(0, 800) || '(none)'}"""\n\n` +
    `FINAL PICKS:\n${list}\n\n` +
    `The document sentences are often NOT instructions: risk warnings, disclaimers, legal/compliance language, or an author's advice to their audience (e.g. "companies must avoid liability from Chinese-origin models") do NOT bind — when the user wants such constraints they state them in their own requirements. Treat a document sentence as binding ONLY when it clearly says what the research results should contain or exclude (e.g. "only crypto", "exclude defense", "related to the Ethereum ecosystem").\n` +
    `Ticker exclusions are LITERAL exact-ticker exclusions only: "never include exact tickers only: ETH" means drop ETH itself, NOT Ethereum L2s, ecosystem assets, wrappers, peers, competitors, alternatives, or functionally similar assets such as ARB or OP. Only flag a pick for a ticker exclusion when the pick's displayed ticker exactly matches an excluded ticker.\n` +
    `Flag every pick that CONTRADICTS the user's own requirements or such a clear scope directive (wrong asset type, wrong market, outside a named ecosystem, an explicit exclusion). Do NOT flag picks for being merely imperfect fits, and NEVER because of risks the document merely warns about.\n` +
    `Category labels are HIERARCHICAL — judge scope by meaning, not by label string: a DEX, AMM, lending, derivatives, staking or stablecoin protocol IS a DeFi protocol; a Layer 2 belongs to its base chain's ecosystem; a sector ETF belongs to its sector's scope. Never flag a pick because its label is a SUBCATEGORY of the requested scope.\n` +
    `A FUND's geography is what it HOLDS, not where it is incorporated: an Ireland or Luxembourg domiciled UCITS ETF tracking Japan, India or China satisfies a request for that market, and is never a region violation for being an Irish fund. Judge a fund's market from what it tracks; judge a company's from where it is based.\n` +
    `Size, market-cap and AUM requirements are judged ONLY from the size range shown on the pick's own line: a pick whose shown range satisfies the requirement is never a size violation, and a pick whose line shows no size is never flagged on size alone. NEVER estimate a fund's AUM or a company's market cap from its name or your own knowledge.\n` +
    `THESIS FIT IS NOT A CONSTRAINT. The thesis TOPIC is what the research is about, not a rule about what may appear. Never flag a pick for being a broad, diversified, indirect or partial expression of the topic — a broad Europe ETF on a thesis about European AI compute is a WEAK PICK, not a violation, and the product scores it as such. Only the constraints listed below can be violated.\n` +
    `ENFORCEABLE CONSTRAINTS ON THIS RUN — every violation MUST cite exactly one code from this list, and you may cite NOTHING else:\n${[...active].map((c) => `- ${c}`).join('\n')}\n` +
    `A violation is a property of the PICK ITSELF. Never flag a pick because of how many picks there are, which other picks are present, or that the list looks unbalanced or incomplete — how many results to return and how to spread them is decided elsewhere, and removing a pick could never fix it.\n` +
    `Return: {"violations":[{"t":"TICKER","c":"CODE","why":"≤10 words"}]} — empty array if none. A violation without a code from the list above is discarded.`;
  // One retry on a malformed answer, like llmSelect. If the auditor stays
  // unusable the run is NOT aborted and enforcement is NOT dropped: the
  // deterministic audit (auditPicks, plus the numeric requirements enforced in
  // code upstream) already ran on these picks and still stands; only the
  // LLM's literal-instruction review is missing, and `unavailable` makes the
  // caller say so in the status lines.
  let violations: RawViolation[] | undefined;
  let lastErr = '';
  for (let attempt = 0; attempt < 2 && !violations; attempt++) {
    let raw: string;
    try {
      raw = await call(usr, { system: sys, maxTokens: 800, temperature: 0.2 });
    } catch (err) {
      // callClaude already retries transport errors; do not double the wait.
      lastErr = (err as Error).message;
      break;
    }
    try {
      violations = parseViolations(raw);
    } catch (err) {
      lastErr = (err as Error).message;
    }
  }
  if (!violations) {
    log.warn(`compliance audit unavailable, deterministic audit still applies: ${lastErr.slice(0, 200)}`);
    return { drop: {}, unavailable: lastErr.slice(0, 120) || 'unusable answer' };
  }
  const tickers = new Set(picks.map((p) => p.a.ticker.toUpperCase()));
  const { drop, discarded } = filterViolations(violations, crit, tickers, enforced.lines);
  if (discarded.length) log.warn(`compliance audit: discarded unbacked violations — ${discarded.join(', ')}`);
  return { drop };
}

const optStr = z.preprocess((v) => (v == null ? undefined : typeof v === 'object' ? undefined : String(v)), z.string().optional());
const ViolationSchema = z.object({ t: optStr, c: optStr, why: optStr });

/**
 * Pure: raw auditor text → violations. Tolerant of the shapes models actually
 * return: {"violations":[…]}, a bare array, a single violation object, or
 * `violations` given as a string/null (→ none). Items that are not objects or
 * lack a ticker are skipped individually instead of failing the whole answer.
 * Throws only when the text is not JSON at all, so the caller can retry.
 * Exported for offline tests.
 */
export function parseViolations(raw: string): RawViolation[] {
  const j = parseJSON<unknown>(raw);
  let list: unknown;
  if (Array.isArray(j)) list = j;
  else if (j && typeof j === 'object') {
    const o = j as Record<string, unknown>;
    list = 'violations' in o ? o.violations : 't' in o ? [o] : [];
  } else list = [];
  if (!Array.isArray(list)) return [];
  const out: RawViolation[] = [];
  for (const item of list) {
    const r = ViolationSchema.safeParse(item);
    if (r.success && r.data.t) out.push(r.data);
  }
  return out;
}

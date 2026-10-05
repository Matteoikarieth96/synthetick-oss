/**
 * Cross-listing dedup — one row per company (spec §4.1b). Vendor-neutral:
 * built for the EODHD pipeline, now fed by FMP screener candidates.
 */
import {
  EXCHANGE_COUNTRY,
  US_EXCHANGES,
  regionForCountry,
  isinCountry,
} from './regions.js';

export const MIN_CAP_USD = 50_000_000; // noise floor (spec §4.1 step 2)

export interface SymCandidate {
  code: string; // vendor symbol code (e.g. ASML)
  exchange: string; // vendor list/exchange code used for API symbols (e.g. AS, US)
  venue: string; // actual venue for display (e.g. NASDAQ, AS)
  name: string;
  currency: string | null;
  type: string; // 'Common Stock' | 'ETF'
  isin: string | null;
  countryIso: string | null; // HQ country ISO
  /** Vendor ADR flag (FMP profile.isAdr). Absent → name regex decides. */
  isAdr?: boolean | null;
  /** Screener volume (FMP) — canonical-pick tiebreak; the most liquid line wins. */
  volume?: number | null;
  /** Profile market cap in `currency` (FMP profile.marketCap) — ghost-duplicate tiebreak (§4.1b rule 6). */
  capLocal?: number | null;
}

/** A deduped company: one canonical listing + its secondary listings (§4.1b). */
export interface DedupGroup {
  canonical: SymCandidate;
  secondaries: SymCandidate[];
}

function normName(n: string): string {
  return n.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40);
}

const ADR_RE = /\bADR\b|\bADS\b|\bADR[SG]?\b/i;
function isAdrName(name: string): boolean {
  return ADR_RE.test(name);
}

/** Vendor flag first (spec §4.1a), name regex as fallback for unflagged lines. */
function isAdrCandidate(c: SymCandidate): boolean {
  return c.isAdr ?? isAdrName(c.name);
}

/** Depositary-style wrapper the vendor did NOT flag as ADR: a US ISIN on a
 * company HQ'd elsewhere (ASML on NASDAQ is "NY Registry Shares" with
 * isAdr=false; Vienna carries ADR lines like Tencent NNN1.VI). Venue doesn't
 * matter — a US-ISIN'd line of a foreign-HQ company is a wrapper wherever it
 * trades. Treat as ADR-like so the stage-2 name fold merges it into the
 * domestic line (no domestic match → it stays its own row, unchanged). */
function isUsWrappedForeign(c: SymCandidate): boolean {
  return isinCountry(c.isin) === 'US' && !!c.countryIso && c.countryIso !== 'US';
}

/** Normalized core name: strip ADR marker + legal suffixes for cross-listing match (§4.1b). */
function coreName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(adr|ads|reg\.?s|sponsored|unsponsored)\b/g, ' ')
    .replace(/\b(n\.?v|inc|incorporated|plc|s\.?a|s\.?p\.?a|ag|ltd|limited|corp|corporation|co|company|holdings?|group|se|ab|oyj|asa|nv)\b/g, ' ')
    .replace(/[^a-z0-9]/g, '');
}

/** Volume order decides rung ties, EXCEPT when a same-currency rival's market
 * cap is decisively (≥1.5×) larger than the volume leader's: FMP occasionally
 * keeps a ghost duplicate of a listing under a stale symbol with the SAME
 * ISIN/CUSIP/CIK but a dead share count (EchoStar: ECHO vs SATS, §4.1b rule
 * 6), and the ghost's screener volume can exceed the real line's. Share
 * classes are safe — GOOG/GOOGL report near-identical company-level caps,
 * nowhere near the 1.5× bar. Cross-currency caps aren't comparable → tie. */
function preferDominantCap(matches: SymCandidate[]): SymCandidate | undefined {
  const lead = matches[0];
  if (!lead?.capLocal) return lead;
  let best = lead;
  for (const m of matches) {
    if (m.currency && m.currency === lead.currency && m.capLocal && m.capLocal > (best.capLocal ?? 0)) {
      best = m;
    }
  }
  return best !== lead && best.capLocal! >= lead.capLocal * 1.5 ? best : lead;
}

function pickCanonical(members: SymCandidate[]): DedupGroup {
  // Wrapper lines (flagged ADRs and US-ISIN'd foreign-HQ lines) never become
  // canonical while a real line exists: a wrapper's US ISIN + US venue would
  // otherwise satisfy the "home exchange" rung below (ASML on NASDAQ).
  const nonAdr = members.filter((m) => !isAdrCandidate(m) && !isUsWrappedForeign(m));
  // Most liquid first, so every rung below resolves ties toward the traded
  // line (GOOGL over GOOG, BRK-B over BRK-A). Stable for vendors w/o volume.
  const pool = [...(nonAdr.length ? nonAdr : members)].sort(
    (a, b) => (b.volume ?? 0) - (a.volume ?? 0),
  );
  // 1. Home exchange by ISIN country. Fails for offshore-incorporated issuers
  //    (Tencent's ISIN is KY — no venue is "home"), hence the next rung:
  const home = preferDominantCap(
    pool.filter((m) => EXCHANGE_COUNTRY[m.exchange] === isinCountry(m.isin)),
  );
  // 2. Venue in the company's HQ region (CN HQ → HKEX beats a Vienna line).
  const regionHome = pool.find((m) => {
    const r = regionForCountry(m.countryIso);
    return r !== 'other' && regionForCountry(EXCHANGE_COUNTRY[m.exchange] ?? null) === r;
  });
  const canonical =
    home ?? regionHome ?? pool.find((m) => US_EXCHANGES.has(m.exchange)) ?? pool[0]!;
  return { canonical, secondaries: members.filter((m) => m !== canonical) };
}

/**
 * One row per company (spec §4.1b). Stage 1: group by ISIN (fallback name+country
 * when ISIN missing). Stage 2: fold ADR groups into the same-core-name domestic
 * group (ADRs carry a different ISIN), targeted to avoid false merges.
 * Stage 3: fold share classes (§4.1b rule 5) — same ISIN issuer prefix + core
 * name + HQ country, stocks only.
 */
export function dedupByIsin(candidates: SymCandidate[]): DedupGroup[] {
  // Stage 1: ISIN / name-fallback groups.
  const groups = new Map<string, SymCandidate[]>();
  for (const c of candidates) {
    const key = c.isin ? `isin:${c.isin}` : `name:${normName(c.name)}|${c.countryIso ?? '?'}`;
    const arr = groups.get(key);
    if (arr) arr.push(c);
    else groups.set(key, [c]);
  }

  // Stage 2: separate ADR groups; index non-ADR companies by core name; fold ADRs in.
  const companies: SymCandidate[][] = [];
  const byCore = new Map<string, SymCandidate[]>();
  const adrGroups: SymCandidate[][] = [];
  for (const members of groups.values()) {
    if (members.some((m) => isAdrCandidate(m) || isUsWrappedForeign(m))) {
      adrGroups.push(members);
    } else {
      companies.push(members);
      const core = coreName(members[0]!.name);
      if (core.length >= 4 && !byCore.has(core)) byCore.set(core, members);
    }
  }
  for (const adr of adrGroups) {
    const core = coreName(adr[0]!.name);
    const target = core.length >= 4 ? byCore.get(core) : undefined;
    if (target) target.push(...adr); // fold ADR listing(s) into the domestic company
    else companies.push(adr); // ADR with no domestic listing in our universe → its own row
  }

  // Stage 3: share classes (§4.1b rule 5). One issuer's classes carry
  // DIFFERENT ISINs sharing the issuer prefix (US02079K…305 vs …107 =
  // Alphabet A/C), and FMP names both lines identically — so match on
  // country+issuer (first 8 ISIN chars) plus the FULL normalized name + HQ
  // country. NOT coreName: it strips "Holding", and sequential-ISIN countries
  // reuse prefixes across issuers — Heineken N.V. and Heineken Holding N.V.
  // are distinct companies sharing NL000000. Stocks only: acc/dist ETF
  // classes are distinct products and stay separate.
  const byIssuer = new Map<string, SymCandidate[]>();
  const folded: SymCandidate[][] = [];
  for (const members of companies) {
    const m0 = members[0]!;
    const exactName = normName(m0.name);
    const foldable = m0.type !== 'ETF' && m0.isin && m0.isin.length >= 8 && exactName.length >= 4;
    if (!foldable) {
      folded.push(members);
      continue;
    }
    const key = `${m0.isin!.slice(0, 8)}|${exactName}|${m0.countryIso ?? '?'}`;
    const target = byIssuer.get(key);
    if (target) target.push(...members); // another class of the same issuer
    else {
      byIssuer.set(key, members);
      folded.push(members);
    }
  }

  return folded.map(pickCanonical);
}

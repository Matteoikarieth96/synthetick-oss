/**
 * Drip (dripstack.xyz) newsletter enrichment for the daily thesis.
 *
 * Discovery is free: GET /api/v1/search returns candidate premium-newsletter
 * posts with price, coverage and snippet. Summaries are paid per fetch
 * (~10-50c, credits via DRIP_API_KEY). Without a key the agent still runs in
 * free mode: titles + snippets only, zero spend.
 *
 * Cost caps mirror the X caps in agent.config.json: dripMaxSummariesPerRun,
 * dripMaxCentsPerRun. Selection filters on topicCoverageRatio, NOT
 * relevanceScore — live probing showed relevanceScore=100 on posts matching a
 * single query token. Any error skips enrichment, never the run.
 */
import fs from "node:fs";
import path from "node:path";
import { secret } from "./settings.js";

export interface DripResearchItem {
  publication: string;
  title: string;
  publishedAt: string;
  priceCents: number;
  paidCents: number | null; // null = snippet only, nothing purchased
  content: string; // synthesizedSummary when bought, else the free snippet
}

export interface DripResult {
  items: DripResearchItem[];
  spentCents: number;
}

export interface DripCaps {
  maxSummaries: number;
  maxCents: number;
  minCoverage: number;
  maxAgeDays: number;
  noRebuyDays: number;
}

const BASE = "https://dripstack.xyz/api/v1";

interface SearchItem {
  publicationSlug: string;
  slug: string;
  title: string;
  priceCents: number;
  relevanceScore: number;
  topicCoverageRatio: number | null;
  matchedTokenCount: number | null;
  publishedAt: string;
  snippet: string | null; // live API returns null on some posts
}

// A candidate is topical if it covers minCoverage of the query tokens OR
// matched at least this many tokens outright — coverage alone punishes long
// thesis titles (ratio = matched/total dilutes as the query grows).
const MIN_MATCHED_TOKENS = 3;

// Semantic-tier hits carry no token stats at all (coverage null, matched
// 0/0), so a lexical-only filter structurally excludes meaning matches —
// which can be the only good fresh research on a theme. Admit the top few
// in API rank order.
const MAX_SEMANTIC = 2;

// Summaries are pay-per-fetch (no permanent access), so with a weeks-wide
// freshness window the same big piece would be re-bought every day. Remember
// purchases and serve the free snippet inside the no-rebuy window instead.
const PURCHASES_PATH = path.join(process.cwd(), ".sail", "memory", "drip-purchases.json");

function loadPurchases(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(PURCHASES_PATH, "utf-8")) as Record<string, string>;
  } catch {
    return {};
  }
}

function rememberPurchase(key: string): void {
  const all = loadPurchases();
  all[key] = new Date().toISOString().slice(0, 10);
  try {
    fs.mkdirSync(path.dirname(PURCHASES_PATH), { recursive: true });
    fs.writeFileSync(PURCHASES_PATH, JSON.stringify(all, null, 2));
  } catch {
    // purchase memory is best-effort — losing it only risks a 10c re-buy
  }
}

export async function fetchDripResearch(query: string, caps: DripCaps, log: (m: string) => void): Promise<DripResult> {
  const empty: DripResult = { items: [], spentCents: 0 };
  let candidates: SearchItem[];
  try {
    const url = new URL(`${BASE}/search`);
    url.searchParams.set("q", query);
    url.searchParams.set("limit", "15");
    url.searchParams.set("mode", "hybrid");
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) {
      log(`drip search: HTTP ${res.status} — enrichment skipped`);
      return empty;
    }
    const json = (await res.json()) as { matchConfidence?: string; items?: SearchItem[] };
    if (json.matchConfidence === "none" || !json.items?.length) {
      log(`drip search: no matches (confidence ${json.matchConfidence ?? "?"})`);
      return empty;
    }
    candidates = json.items;
  } catch (e) {
    log(`drip search: ${(e as Error).message.slice(0, 100)} — enrichment skipped`);
    return empty;
  }

  // Filter: fresh enough, then topical two ways — lexical (real token
  // coverage) ranked first, plus the top semantic-tier hits — one post per
  // publication.
  const cutoff = Date.now() - caps.maxAgeDays * 86_400_000;
  const fresh = candidates.filter((c) => Date.parse(c.publishedAt) >= cutoff);
  const lexical = fresh
    .filter((c) => (c.topicCoverageRatio ?? 0) >= caps.minCoverage || (c.matchedTokenCount ?? 0) >= MIN_MATCHED_TOKENS)
    .sort((a, b) => (b.topicCoverageRatio ?? 0) - (a.topicCoverageRatio ?? 0) || Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  const semantic = fresh.filter((c) => c.topicCoverageRatio == null).slice(0, MAX_SEMANTIC);
  const seenPubs = new Set<string>();
  const selected = [...lexical, ...semantic]
    .filter((c) => (seenPubs.has(c.publicationSlug) ? false : (seenPubs.add(c.publicationSlug), true)))
    .slice(0, caps.maxSummaries);
  log(
    `drip search: ${candidates.length} candidates -> ${selected.length} selected (${lexical.length} lexical @ coverage >= ${caps.minCoverage}, ${semantic.length} semantic, <= ${caps.maxAgeDays}d)`,
  );
  if (!selected.length) return empty;

  const key = secret("DRIP_API_KEY");
  const purchases = loadPurchases();
  const rebuyCutoff = new Date(Date.now() - caps.noRebuyDays * 86_400_000).toISOString().slice(0, 10);
  const items: DripResearchItem[] = [];
  let spentCents = 0;
  let buying = !!key;
  if (!key) log("drip: no DRIP_API_KEY — free mode, snippets only");

  for (const c of selected) {
    const base: DripResearchItem = {
      publication: c.publicationSlug,
      title: c.title,
      publishedAt: c.publishedAt,
      priceCents: c.priceCents,
      paidCents: null,
      content: c.snippet ?? "",
    };
    // Budget check against the advertised price BEFORE spending anything.
    if (buying && spentCents + c.priceCents > caps.maxCents) {
      log(`drip: budget reached (${spentCents}c spent, next costs ${c.priceCents}c) — snippet only for the rest`);
      buying = false;
    }
    const purchaseKey = `${c.publicationSlug}/${c.slug}`;
    const lastBought = purchases[purchaseKey];
    const recentlyBought = !!lastBought && lastBought >= rebuyCutoff;
    if (buying && recentlyBought) log(`drip: "${c.title.slice(0, 60)}" bought ${lastBought} — no re-buy within ${caps.noRebuyDays}d, snippet only`);
    if (buying && !recentlyBought) {
      try {
        const res = await fetch(`${BASE}/publications/${encodeURIComponent(c.publicationSlug)}/${encodeURIComponent(c.slug)}`, {
          headers: { authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(30_000),
        });
        if (res.ok) {
          const json = (await res.json()) as { synthesizedSummary?: string; paymentInfo?: { amountCents?: number } };
          if (json.synthesizedSummary) {
            const paid = json.paymentInfo?.amountCents ?? c.priceCents;
            spentCents += paid;
            rememberPurchase(purchaseKey);
            items.push({ ...base, paidCents: paid, content: json.synthesizedSummary });
            log(`drip: bought "${c.title.slice(0, 60)}" (${c.publicationSlug}) for ${paid}c`);
            continue;
          }
          log(`drip: ${c.publicationSlug}/${c.slug} — 200 but no summary, using snippet`);
        } else if (res.status === 403) {
          log("drip: insufficient credits — top up at dripstack.xyz/dashboard/credits; snippets only for the rest");
          buying = false;
        } else if (res.status === 402) {
          log("drip: API key not accepted (402 wallet challenge) — check DRIP_API_KEY; snippets only");
          buying = false;
        } else if (res.status === 404) {
          log(`drip: ${c.publicationSlug}/${c.slug} — 404, skipped (not paid)`);
          continue;
        } else {
          log(`drip: ${c.publicationSlug}/${c.slug} — HTTP ${res.status}, using snippet`);
        }
      } catch (e) {
        log(`drip: ${c.publicationSlug}/${c.slug} — ${(e as Error).message.slice(0, 80)}, using snippet`);
      }
    }
    // A title with no snippet and no summary is not research — feeding
    // title-only items to the revision invites invented "consensus".
    if (!base.content) {
      log(`drip: "${c.title.slice(0, 60)}" has no snippet — dropped (title-only)`);
      continue;
    }
    items.push(base);
  }

  log(`drip: ${items.length} research items, ${spentCents}c spent`);
  return { items, spentCents };
}

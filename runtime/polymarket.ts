/**
 * Prediction-market discovery — Polymarket (spec §5.8): match the thesis
 * against live bets, same path as assets: retrieve → LLM rerank by meaning →
 * aligned side. Public Gamma API (https://gamma-api.polymarket.com), no key.
 * Failures degrade to [] and must never break the asset pipeline.
 */
import { callClaude, parseJSON } from './llm.js';
import type { Thesis } from './thesis.js';

export interface PredictionPick {
  question: string;
  eventTitle: string;
  url: string; // polymarket.com event page
  outcomes: string[]; // e.g. ["Yes","No"]
  prices: number[]; // implied probabilities 0..1, same order as outcomes
  side: string; // the outcome that pays out if the user's view proves correct
  sideIndex: number;
  score: number; // 0–100 relevance to the thesis
  why: string;
  volume: number | null;
  endDate: string | null;
  /** Leading outcome's 24h move in percentage points (§5.8), null = unknown. */
  leadDayChangePct: number | null;
}

interface GammaMarket {
  id?: string;
  question?: string;
  outcomes?: string; // JSON-encoded array
  outcomePrices?: string; // JSON-encoded array
  oneDayPriceChange?: number | string; // 24h delta of outcome[0]'s price
  volume?: string | number;
  endDate?: string;
  active?: boolean;
  closed?: boolean;
}

interface GammaEvent {
  title?: string;
  slug?: string;
  active?: boolean;
  closed?: boolean;
  markets?: GammaMarket[];
}

interface Candidate {
  id: string;
  question: string;
  eventTitle: string;
  eventSlug: string;
  outcomes: string[];
  prices: number[];
  volume: number | null;
  endDate: string | null;
  leadDayChangePct: number | null;
}

const GAMMA = 'https://gamma-api.polymarket.com';
const MAX_CANDIDATES = 40;
const REL_THRESHOLD = 35; // same bar as /select (spec §5.3 s≥35): below this it isn't "related"

/** Thesis → 3–5 short queries in prediction-market phrasing. LLM with a
 * deterministic fallback (themes verbatim), like the direction backstop. */
async function searchQueries(thesis: Thesis): Promise<string[]> {
  const fallback = [...thesis.themes.slice(0, 3), thesis.title].filter((q) => q.trim().length > 2);
  const sys =
    'You turn an investment thesis into short search queries for a prediction-market site (Polymarket). Output ONLY minified JSON, no commentary.';
  const usr =
    `Thesis: """${thesis.summary.slice(0, 1200)}"""\nThemes: ${thesis.themes.join(', ') || '(none)'}\n\n` +
    `Return {"queries":["..."]} — 3 to 5 queries, each 1-3 words, the concrete nouns a bet's question would contain ` +
    `(events, places, people, metrics — e.g. "heat wave", "Paris temperature", "ETH price", "Fed rate cut"). ` +
    `No investing jargon: bets are about real-world outcomes, not portfolios.`;
  try {
    const j = parseJSON<{ queries?: unknown[] }>(await callClaude(usr, { system: sys, maxTokens: 300, temperature: 0.2 }));
    const qs = (j.queries ?? []).map(String).filter((q) => q.trim().length > 2).slice(0, 5);
    return qs.length ? qs : fallback;
  } catch {
    return fallback;
  }
}

async function searchEvents(q: string): Promise<GammaEvent[]> {
  try {
    const r = await fetch(
      `${GAMMA}/public-search?q=${encodeURIComponent(q)}&limit_per_type=12&events_status=active`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!r.ok) return [];
    const j = (await r.json()) as { events?: GammaEvent[] };
    return j.events ?? [];
  } catch {
    return [];
  }
}

const parseArr = (s: string | undefined): string[] => {
  try {
    const v = JSON.parse(s ?? '[]');
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
};

/** Search all queries, flatten events→markets, filter live, dedupe, rank by volume. */
async function retrieve(queries: string[]): Promise<Candidate[]> {
  const settled = await Promise.allSettled(queries.map(searchEvents));
  const byId = new Map<string, Candidate>();
  for (const s of settled) {
    if (s.status !== 'fulfilled') continue;
    for (const ev of s.value) {
      if (ev.closed || ev.active === false || !ev.slug) continue;
      for (const m of ev.markets ?? []) {
        if (m.closed || m.active === false || !m.id || !m.question) continue;
        const outcomes = parseArr(m.outcomes);
        const prices = parseArr(m.outcomePrices).map(Number);
        if (
          outcomes.length < 2 ||
          prices.length !== outcomes.length ||
          prices.some((p) => !Number.isFinite(p) || p < 0 || p > 1)
        )
          continue;
        // 24h chip (§5.8): Gamma's oneDayPriceChange is outcome[0]'s delta.
        // The LEADER's change is that value when the leader is outcome 0, its
        // negation in a binary market — and unknowable otherwise (omit, never guess).
        const d = m.oneDayPriceChange != null ? Number(m.oneDayPriceChange) : NaN;
        const leadIdx = prices.indexOf(Math.max(...prices));
        const leadDayChangePct = !Number.isFinite(d)
          ? null
          : leadIdx === 0
            ? Math.round(d * 1000) / 10
            : outcomes.length === 2
              ? Math.round(-d * 1000) / 10
              : null;
        const volume = m.volume != null ? Number(m.volume) : null;
        byId.set(String(m.id), {
          id: String(m.id),
          question: m.question,
          eventTitle: ev.title ?? m.question,
          eventSlug: ev.slug,
          outcomes,
          prices,
          volume: volume != null && Number.isFinite(volume) && volume >= 0 ? volume : null,
          endDate: m.endDate ?? null,
          leadDayChangePct,
        });
      }
    }
  }
  return [...byId.values()]
    .sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0))
    .slice(0, MAX_CANDIDATES);
}

/** LLM rerank: genuine relevance only (meaning, not keywords — same principle
 * as /select), plus the side that pays out if the user's view proves correct. */
async function rerank(thesis: Thesis, pool: Candidate[], maxPicks: number): Promise<PredictionPick[]> {
  const lines = pool
    .map((c) => `${c.id}|${c.question}|${c.outcomes.map((o, i) => `${o} ${((c.prices[i] ?? 0) * 100).toFixed(0)}%`).join(', ')}|ends ${c.endDate?.slice(0, 10) ?? '?'}`)
    .join('\n');
  const sys =
    'You are a precise investment-research analyst matching a user\'s thesis to prediction-market bets. Output ONLY minified JSON, no markdown, no commentary.';
  const usr =
    `USER'S THESIS:\n"""${thesis.summary.slice(0, 1500)}"""\n` +
    `Themes: ${thesis.themes.join(', ') || '(none)'}\n\n` +
    `LIVE POLYMARKET BETS (id|question|outcomes with implied probability|end date):\n${lines}\n\n` +
    `Select the bets (max ${maxPicks}) whose RESOLUTION genuinely depends on this thesis playing out. ` +
    `Judge by meaning, not keywords — a thesis on European temperatures does not make a Seoul temperature bet relevant.\n` +
    `For each: "id"; "s" 0-100 how directly the bet's outcome tracks the thesis; ` +
    `"o" the INDEX (0-based) of the outcome that PAYS OUT if the user's view proves correct; ` +
    `"w" one specific sentence: what resolving that way would confirm about the thesis.\n` +
    `Threshold-ladder bets for the same asset/metric ("reach $X" rungs) must carry CONSISTENT sides: ` +
    `a thesis implying YES at a higher threshold implies YES at every lower threshold too (and the reverse for bearish views).\n` +
    `If fewer than ${maxPicks} genuinely relate, return fewer. If NONE relate, return [].\n` +
    `Return: [{"id":"123","s":82,"o":0,"w":"..."}]`;
  let j: { id?: string; s?: number; o?: number; w?: string }[];
  try {
    j = parseJSON(await callClaude(usr, { system: sys, maxTokens: 1500, temperature: 0.2 }));
  } catch {
    j = parseJSON(await callClaude(usr, { system: sys, maxTokens: 1500, temperature: 0.2 }));
  }
  if (!Array.isArray(j)) return [];

  const byId = new Map(pool.map((c) => [c.id, c]));
  const picks: PredictionPick[] = [];
  for (const e of j) {
    const c = byId.get(String(e.id ?? ''));
    if (!c) continue; // discard anything not in the candidate set
    const s = Math.max(0, Math.min(100, Math.round(Number(e.s) || 0)));
    if (s < REL_THRESHOLD) continue;
    if (picks.some((p) => p.url === `https://polymarket.com/event/${c.eventSlug}` && p.question === c.question)) continue;
    // An invalid outcome index means we don't know which side the why-text
    // describes — drop the pick rather than show a possibly-inverted side.
    const oi = Number.isInteger(e.o) && (e.o as number) >= 0 && (e.o as number) < c.outcomes.length ? (e.o as number) : -1;
    if (oi < 0) continue;
    picks.push({
      question: c.question,
      eventTitle: c.eventTitle,
      url: `https://polymarket.com/event/${c.eventSlug}`,
      outcomes: c.outcomes,
      prices: c.prices,
      side: c.outcomes[oi] ?? '?',
      sideIndex: oi,
      score: s,
      why: String(e.w ?? '').slice(0, 400),
      volume: c.volume,
      endDate: c.endDate,
      leadDayChangePct: c.leadDayChangePct,
    });
  }
  picks.sort((a, b) => b.score - a.score);
  return ladderConsistent(picks).slice(0, maxPicks);
}

/** Ladder-side consistency (§5.8): picks whose questions differ only by
 * numbers ("reach $4,000" vs "reach $3,500" rungs) must agree on side; when
 * they disagree, the top-scored pick's side wins and contradictors are dropped
 * — a wrong side is worse than a missing pick (same doctrine as anchors). */
function ladderConsistent(picks: PredictionPick[]): PredictionPick[] {
  const stem = (q: string) => q.toLowerCase().replace(/[\d,.$%]+/g, '#').replace(/\s+/g, ' ').trim();
  const sideByStem = new Map<string, string>(); // picks arrive score-desc: first seen = top-scored
  const out: PredictionPick[] = [];
  for (const p of picks) {
    const k = stem(p.question);
    const want = sideByStem.get(k);
    if (want == null) {
      sideByStem.set(k, p.side);
      out.push(p);
    } else if (p.side === want) {
      out.push(p);
    }
    // else: contradicts the ladder's top-scored side — dropped.
  }
  return out;
}

/** Thesis → up to `maxPicks` related live Polymarket bets. Never throws. */
export async function findPredictionMarkets(thesis: Thesis, maxPicks = 5): Promise<PredictionPick[]> {
  try {
    const queries = await searchQueries(thesis);
    const pool = await retrieve(queries);
    if (!pool.length) return [];
    return await rerank(thesis, pool, maxPicks);
  } catch {
    return [];
  }
}

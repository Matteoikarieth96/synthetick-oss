/**
 * Post-selection news context: web search runs ONLY after final picks are
 * audited. It enriches the displayed assets but never influences retrieval,
 * selection, or compliance.
 */
import { callClaude, parseJSON } from './llm.js';
import type { Pick } from './select.js';

export interface PickNews {
  headline: string;
  source: string;
  url: string;
  date?: string | null;
  summary: string;
}

interface RawNews {
  t?: string;
  headline?: string;
  source?: string;
  url?: string;
  date?: string | null;
  summary?: string;
}

const MAX_RECENT_NEWS_AGE_DAYS = 30;

// News runs on a cheap web-grounded model (decision 2026-07-16): with the
// default Sonnet, OpenRouter's `:online` injects ~200K tokens of fetched pages
// into the prompt (~$0.80/run, ~90% of a run's cost); Gemini's native search
// grounding keeps the same lookup at ~$0.01.
// `||`, not `??`: empty string means unset (see the model() note in llm.ts).
const newsModel = () => process.env.SIGNAL_NEWS_MODEL || 'google/gemini-2.5-flash';

const clean = (s: unknown, max: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function normalizeUrl(s: unknown): string {
  const u = clean(s, 500);
  try {
    const parsed = new URL(u);
    return /^https?:$/.test(parsed.protocol) ? parsed.href : '';
  } catch {
    return '';
  }
}

function isoDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function recentNewsCutoff(now = new Date()): Date {
  const cutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  // Fixed-day arithmetic avoids Date#setUTCMonth rollover (e.g. March 31 →
  // March 3 when subtracting one month because February has fewer days).
  cutoff.setUTCDate(cutoff.getUTCDate() - MAX_RECENT_NEWS_AGE_DAYS);
  return cutoff;
}

function parseIsoDate(s: unknown): Date | null {
  const value = clean(s, 24);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    return null;
  }
  return parsed;
}

function isRecentNewsDate(s: unknown, now = new Date()): boolean {
  const parsed = parseIsoDate(s);
  if (!parsed) return false;
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return parsed >= recentNewsCutoff(now) && parsed <= today;
}

export async function recentNewsForPicks(thesisText: string, picks: Pick[]): Promise<Record<string, PickNews>> {
  if (!picks.length) return {};
  const cutoff = isoDateOnly(recentNewsCutoff());
  const today = isoDateOnly(new Date());
  const unique = [...new Map(picks.map((p) => [p.a.ticker.toUpperCase(), p])).values()];
  const lines = unique
    .map((p) =>
      [
        p.a.ticker,
        p.a.name,
        p.a.kind,
        p.a.region,
        p.dir ?? 'long',
        p.a.sector ?? p.a.categories?.[0] ?? '',
      ].join('|'),
    )
    .join('\n');
  const sys =
    'You are a careful financial-news researcher. Use web search. Return only JSON. Do not invent sources, URLs, or dates.';
  const usr =
    `Investment thesis:\n"""${thesisText.slice(0, 1800)}"""\n\n` +
    `FINAL AUDITED ASSETS ONLY (ticker|name|kind|region|side|sector):\n${lines}\n\n` +
    `For each final asset, find the single most important news item that matters to this thesis or to the asset's risk/reward and was published from ${cutoff} through ${today}. Do not use older items. If no material item exists in that one-month window, omit that asset from the JSON. Use reputable primary or financial-news sources when available.\n` +
    `Return a JSON object keyed by ticker. Each value must be {"headline":"...", "source":"publisher name", "url":"https://...", "date":"YYYY-MM-DD", "summary":"one sentence on why this news matters to the thesis/watch-out"}.`;
  const raw = await callClaude(usr, { system: sys, web: true, maxTokens: 5000, temperature: 0.1, model: newsModel() });
  const parsed = parseJSON<Record<string, RawNews>>(raw);
  const out: Record<string, PickNews> = {};
  for (const p of unique) {
    const t = p.a.ticker.toUpperCase();
    const r = parsed[t] ?? parsed[p.a.ticker] ?? parsed[p.a.name];
    if (!r) continue;
    const url = normalizeUrl(r.url);
    const headline = clean(r.headline, 180);
    const source = clean(r.source, 80);
    const date = clean(r.date, 24);
    const summary = clean(r.summary, 260);
    if (!url || !headline || !source || !date || !summary || !isRecentNewsDate(date)) continue;
    out[p.a.ticker] = {
      headline,
      source,
      url,
      date,
      summary,
    };
  }
  return out;
}

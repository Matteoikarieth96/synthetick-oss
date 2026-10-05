/**
 * Daily X news pull for the tickers the agent holds or watches.
 *
 * Uses the X API v2 recent-search endpoint with an app bearer token
 * (X_BEARER_TOKEN, or X_BOT_BEARER to reuse the SyntheTick bot credential).
 * X bills pay-per-use per post read — newsMaxPostsPerTicker and newsMaxTickers
 * in agent.config.json are the cost caps. A 429 or error on one ticker skips
 * that ticker, never the run.
 */
import { requireSecret } from "./settings.js";

export interface TickerNews {
  symbol: string;
  posts: { text: string; createdAt: string; likes: number; reposts: number }[];
}

const SEARCH_URL = "https://api.x.com/2/tweets/search/recent";

export async function fetchNews(
  tickers: { symbol: string; name: string }[],
  maxPostsPerTicker: number,
  log: (m: string) => void,
): Promise<TickerNews[]> {
  const bearer = requireSecret("X_BEARER_TOKEN", "X_BOT_BEARER");
  const out: TickerNews[] = [];
  for (const t of tickers) {
    // Cashtag + company-name query, original posts only. Company names with
    // punctuation are quoted; single-word names ride bare.
    const name = t.name.replace(/"/g, "").trim();
    const query = `($${t.symbol} OR "${name}") -is:retweet -is:reply lang:en`;
    const url = new URL(SEARCH_URL);
    url.searchParams.set("query", query);
    url.searchParams.set("max_results", String(Math.min(Math.max(maxPostsPerTicker, 10), 100)));
    url.searchParams.set("sort_order", "relevancy");
    url.searchParams.set("tweet.fields", "created_at,public_metrics");
    try {
      // Bounded: the runner ticks one at a time, so a hung read would freeze it.
      const res = await fetch(url, { headers: { authorization: `Bearer ${bearer}` }, signal: AbortSignal.timeout(20_000) });
      if (!res.ok) {
        log(`news ${t.symbol}: HTTP ${res.status} — skipped`);
        continue;
      }
      const json = (await res.json()) as {
        data?: { text: string; created_at: string; public_metrics?: { like_count?: number; retweet_count?: number } }[];
      };
      const posts = (json.data ?? [])
        .slice(0, maxPostsPerTicker)
        .map((p) => ({
          text: p.text,
          createdAt: p.created_at,
          likes: p.public_metrics?.like_count ?? 0,
          reposts: p.public_metrics?.retweet_count ?? 0,
        }));
      if (posts.length) out.push({ symbol: t.symbol, posts });
      log(`news ${t.symbol}: ${posts.length} posts`);
    } catch (e) {
      log(`news ${t.symbol}: ${(e as Error).message.slice(0, 100)} — skipped`);
    }
  }
  return out;
}

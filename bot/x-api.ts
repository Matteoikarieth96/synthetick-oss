/**
 * Minimal X API v2 client for the bot (spec §14, PR 3).
 *
 * Auth is split by direction: mention reads use the app-only bearer;
 * posting a reply signs OAuth 1.0a with the bot account's own token, which
 * never expires (unlike OAuth 2.0 user tokens with refresh rotation).
 * No SDK — two endpoints do not justify a dependency.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { env } from '../ingest/lib/env.js';
import { log } from '../ingest/lib/log.js';

const API = 'https://api.x.com/2';
/** Per-request ceiling: the worker is one sequential loop, so a hung call
 * would stall every mention behind it. */
const X_TIMEOUT_MS = 30_000;
/** Mention pages one poll may read (25 each). More than this in one poll
 * interval is a burst; whatever is older is logged, not silently dropped. */
export const MAX_MENTION_PAGES = 8;

/** Thrown on 429; resetAtMs comes from x-rate-limit-reset (or +15min). */
export class XRateLimit extends Error {
  constructor(public resetAtMs: number) {
    super(`X rate limit; resets ${new Date(resetAtMs).toISOString()}`);
  }
}

export function requireBotEnv(): void {
  const missing = [
    'X_BOT_BEARER',
    'X_BOT_CONSUMER_KEY',
    'X_BOT_CONSUMER_SECRET',
    'X_BOT_ACCESS_TOKEN',
    'X_BOT_ACCESS_SECRET',
  ].filter((k) => !env[k as keyof typeof env]);
  if (missing.length) {
    throw new Error(
      `X bot env missing: ${missing.join(', ')}. Set them in .env / Railway (spec §14 PR 3).`,
    );
  }
}

// ---- OAuth 1.0a (posting + users/me) ----------------------------------------

/** RFC 3986 percent-encoding (encodeURIComponent misses !'()*). */
const enc = (s: string) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

/**
 * OAuth 1.0a HMAC-SHA1 header. JSON request bodies never enter the signature
 * base (only query + oauth params do), per the X v2 signing rules.
 * `testOverrides` injects fixed nonce/timestamp/credentials so the gate can
 * verify the signature against X's documented worked example.
 */
export function oauth1Header(
  method: 'GET' | 'POST',
  rawUrl: string,
  testOverrides?: Partial<Record<string, string>>,
): string {
  const u = new URL(rawUrl);
  const oauth: Record<string, string> = {
    oauth_consumer_key: env.X_BOT_CONSUMER_KEY,
    oauth_nonce: randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: env.X_BOT_ACCESS_TOKEN,
    oauth_version: '1.0',
    ...testOverrides,
  };
  const consumerSecret = oauth.consumer_secret ?? env.X_BOT_CONSUMER_SECRET;
  const tokenSecret = oauth.token_secret ?? env.X_BOT_ACCESS_SECRET;
  delete oauth.consumer_secret;
  delete oauth.token_secret;
  const pairs: [string, string][] = [
    ...Object.entries(oauth),
    ...[...u.searchParams.entries()],
  ].map(([k, v]) => [enc(k), enc(v)]);
  pairs.sort(([ka, va], [kb, vb]) => (ka === kb ? va.localeCompare(vb) : ka.localeCompare(kb)));
  const base = [
    method,
    enc(`${u.origin}${u.pathname}`),
    enc(pairs.map(([k, v]) => `${k}=${v}`).join('&')),
  ].join('&');
  const key = `${enc(consumerSecret)}&${enc(tokenSecret)}`;
  oauth.oauth_signature = createHmac('sha1', key).update(base).digest('base64');
  return (
    'OAuth ' +
    Object.entries(oauth)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${enc(k)}="${enc(v)}"`)
      .join(', ')
  );
}

function throwOnLimit(res: Response): void {
  if (res.status !== 429) return;
  const reset = Number(res.headers.get('x-rate-limit-reset') ?? 0) * 1000;
  throw new XRateLimit(reset > Date.now() ? reset : Date.now() + 15 * 60 * 1000);
}

// ---- endpoints --------------------------------------------------------------

export interface XTweet {
  id: string;
  text: string;
  author_id?: string;
  referenced_tweets?: { type: string; id: string }[];
  entities?: { urls?: { expanded_url?: string; url?: string }[] };
  attachments?: { media_keys?: string[] };
}

export interface XMediaVariant {
  bit_rate?: number;
  content_type: string;
  url: string;
}

export interface XMedia {
  media_key: string;
  type: 'photo' | 'video' | 'animated_gif' | string;
  duration_ms?: number;
  variants?: XMediaVariant[];
}

export interface MentionsPage {
  /** Oldest first (X answers newest first; we reverse for in-order handling). */
  mentions: XTweet[];
  /** Referenced (replied-to) tweets by id, from the expansion. */
  parents: Map<string, XTweet>;
  /** Media attached to mentions or referenced posts, keyed by media_key. */
  media: Map<string, XMedia>;
  /** Watermark for the next poll; null when nothing new. */
  newestId: string | null;
}

/** The bot account's own user id: env override, else OAuth1 users/me. */
export async function getBotUserId(): Promise<string> {
  if (env.X_BOT_USER_ID) return env.X_BOT_USER_ID;
  const url = `${API}/users/me`;
  const res = await fetch(url, { headers: { authorization: oauth1Header('GET', url) }, signal: AbortSignal.timeout(X_TIMEOUT_MS) });
  throwOnLimit(res);
  if (!res.ok) throw new Error(`X users/me failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { data?: { id?: string } };
  if (!json.data?.id) throw new Error('X users/me answered without an id');
  return json.data.id;
}

/**
 * Every mention since `sinceId`, oldest first. X answers newest first, 25 per
 * page, and the rest sits behind `meta.next_token`: reading only the first
 * page and then advancing the watermark to its newest id silently skipped
 * every older mention of a burst for good (review R4). Pages are followed up
 * to MAX_MENTION_PAGES. The first-run call (no `sinceId`) only needs the
 * newest id, so it reads one page.
 */
export async function getMentions(botUserId: string, sinceId: string | null): Promise<MentionsPage> {
  const newestFirst: XTweet[] = [];
  const parents = new Map<string, XTweet>();
  const media = new Map<string, XMedia>();
  let newestId: string | null = null;
  let token: string | undefined;
  for (let page = 0; page < MAX_MENTION_PAGES; page++) {
    const url = new URL(`${API}/users/${botUserId}/mentions`);
    url.searchParams.set('max_results', '25');
    url.searchParams.set('tweet.fields', 'author_id,referenced_tweets,entities,conversation_id,attachments');
    url.searchParams.set(
      'expansions',
      'referenced_tweets.id,attachments.media_keys,referenced_tweets.id.attachments.media_keys',
    );
    url.searchParams.set('media.fields', 'media_key,type,duration_ms,variants');
    if (sinceId) url.searchParams.set('since_id', sinceId);
    if (token) url.searchParams.set('pagination_token', token);
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${env.X_BOT_BEARER}` },
      signal: AbortSignal.timeout(X_TIMEOUT_MS),
    });
    throwOnLimit(res);
    if (!res.ok) throw new Error(`X mentions failed: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as {
      data?: XTweet[];
      includes?: { tweets?: XTweet[]; media?: XMedia[] };
      meta?: { newest_id?: string; next_token?: string };
    };
    if (page === 0) newestId = json.meta?.newest_id ?? null;
    newestFirst.push(...(json.data ?? []));
    for (const t of json.includes?.tweets ?? []) parents.set(t.id, t);
    for (const item of json.includes?.media ?? []) media.set(item.media_key, item);
    token = json.meta?.next_token;
    if (!token || !sinceId) break;
  }
  if (token && sinceId) {
    log.warn(`bot: more than ${MAX_MENTION_PAGES * 25} new mentions in one poll; the oldest beyond that were not read`);
  }
  return { mentions: newestFirst.reverse(), parents, media, newestId };
}

/** Post a reply as the bot; returns the new tweet id. */
export async function postReply(text: string, inReplyToTweetId: string): Promise<string> {
  const url = `${API}/tweets`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: oauth1Header('POST', url), 'content-type': 'application/json' },
    body: JSON.stringify({ text, reply: { in_reply_to_tweet_id: inReplyToTweetId } }),
    signal: AbortSignal.timeout(X_TIMEOUT_MS),
  });
  throwOnLimit(res);
  if (!res.ok) throw new Error(`X post failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { data?: { id?: string } };
  if (!json.data?.id) throw new Error('X post answered without an id');
  return json.data.id;
}

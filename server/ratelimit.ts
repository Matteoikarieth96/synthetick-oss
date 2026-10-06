/**
 * In-memory rate limiting + run concurrency caps (security audit H2).
 *
 * Why in memory: SyntheTick runs as ONE Node process (Railway), so a Map is
 * enough and adds no dependency or round trip. If the app is ever scaled out
 * to several instances, each instance enforces its own budget (limits become
 * per instance); move the buckets to Redis/Postgres then.
 *
 * Limits are defense in depth, NOT credit economics: they never charge or
 * change what a run costs, they only stop abuse bursts. All defaults can be
 * overridden by env (see LIMIT_DEFS).
 *
 * Client IP: derived from the socket unless a proxy is known.
 *  - On Railway (RAILWAY_ENVIRONMENT is set, or TRUST_PROXY=railway) the edge
 *    strips any incoming X-Forwarded-For and writes the address that connected
 *    to it as the FIRST entry, so that entry cannot be forged. When it belongs to
 *    Cloudflare's published ranges the request came through Cloudflare and the
 *    visitor is in CF-Connecting-IP; otherwise the first entry is the visitor
 *    (someone calling Railway directly) and a forged CF-Connecting-IP is ignored.
 *  - Elsewhere, X-Forwarded-For is trusted ONLY when TRUST_PROXY is a hop count
 *    (1 = take the rightmost entry, 2 = the second from the right).
 * Trusting the header without a known proxy would let any client pick its own
 * IP and dodge the limiter, so the default is the raw socket address.
 *
 * Pure module (no env.ts import): the security gate tests it offline.
 */
import type http from 'node:http';
import { BlockList, isIP } from 'node:net';
import { PublicError } from '../runtime/errors.js';
import { isLoopbackAddress, isPrivateAddress } from '../runtime/netguard.js';

// ---- token bucket -----------------------------------------------------------

export type TakeResult = { ok: true; remaining: number } | { ok: false; retryAfterSec: number };

/**
 * Classic token bucket: `capacity` tokens, refilled continuously so a full
 * bucket regenerates over `windowMs` (capacity per window). Starts full, so a
 * legitimate burst up to `capacity` always passes.
 */
export class TokenBucketLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  private ops = 0;
  private lastPruneAt = 0;

  constructor(
    readonly capacity: number,
    readonly windowMs: number,
    private now: () => number = Date.now,
    private maxKeys = 50_000,
  ) {}

  take(key: string, cost = 1): TakeResult {
    const t = this.now();
    const perMs = this.capacity / this.windowMs;
    const prev = this.buckets.get(key);
    let tokens = prev ? Math.min(this.capacity, prev.tokens + (t - prev.at) * perMs) : this.capacity;
    let result: TakeResult;
    if (tokens >= cost) {
      tokens -= cost;
      result = { ok: true, remaining: Math.floor(tokens) };
    } else {
      result = { ok: false, retryAfterSec: Math.max(1, Math.ceil((cost - tokens) / perMs / 1000)) };
    }
    // Delete + set keeps Map insertion order = least recently used first.
    this.buckets.delete(key);
    this.buckets.set(key, { tokens, at: t });
    // Over the cap, prune at most once a second: a flood of new keys must not
    // turn every request into a full scan (audit N5).
    if (this.ops++ % 1000 === 999 || (this.buckets.size > this.maxKeys && t - this.lastPruneAt >= 1000)) this.prune(t);
    return result;
  }

  /**
   * Drop buckets that have fully refilled (indistinguishable from new, so
   * dropping them loses nothing). A bucket that is still draining or
   * throttled is NEVER evicted, so a flood of fresh keys
   * cannot reset an active throttle (audit N5); the map can only exceed the
   * cap by the number of keys that are currently busy, which empties within
   * one window.
   */
  private prune(t: number): void {
    this.lastPruneAt = t;
    const perMs = this.capacity / this.windowMs;
    for (const [k, b] of this.buckets) {
      if (b.tokens + (t - b.at) * perMs >= this.capacity) this.buckets.delete(k);
    }
  }

  get size(): number {
    return this.buckets.size;
  }
}

// ---- daily quota --------------------------------------------------------------

const DAY_MS = 86_400_000;
const utcDay = (t: number) => Math.floor(t / DAY_MS);

/** Seconds from `t` to the next midnight UTC (at least 1): the Retry-After of a daily limit. */
export function secondsUntilUtcMidnight(t = Date.now()): number {
  return Math.max(1, Math.ceil(((utcDay(t) + 1) * DAY_MS - t) / 1000));
}

/**
 * A count per key per UTC day (final audit H1, L5): `limit` units per key,
 * reset at midnight UTC. In memory like the buckets above (one process; a
 * restart forgets today's counts). Entries from earlier days are dropped once
 * the map grows past `maxKeys`.
 */
export class DailyQuota {
  private counts = new Map<string, { day: number; n: number }>();

  constructor(
    readonly limit: number,
    private now: () => number = Date.now,
    private maxKeys = 10_000,
  ) {}

  /** Units `key` has used today. */
  used(key: string): number {
    const c = this.counts.get(key);
    return c && c.day === utcDay(this.now()) ? c.n : 0;
  }

  /** Count one unit for `key` today; false (nothing counted) once the limit is reached. */
  take(key: string): boolean {
    const day = utcDay(this.now());
    const n = this.used(key);
    if (n >= this.limit) return false;
    this.counts.set(key, { day, n: n + 1 });
    if (this.counts.size > this.maxKeys) {
      for (const [k, c] of this.counts) if (c.day !== day) this.counts.delete(k);
    }
    return true;
  }

  /** Undo one take: the counted work did not happen after all. */
  giveBack(key: string): void {
    const c = this.counts.get(key);
    if (c && c.day === utcDay(this.now()) && c.n > 0) c.n -= 1;
  }

  get size(): number {
    return this.counts.size;
  }
}

// ---- concurrency cap --------------------------------------------------------

/** Caps simultaneous in-flight work per key (e.g. pipeline runs per user). */
export class ConcurrencyGuard {
  private active = new Map<string, number>();

  constructor(readonly max: number) {}

  /** True when `key` could acquire a slot right now (nothing is taken). */
  available(key: string): boolean {
    return (this.active.get(key) ?? 0) < this.max;
  }

  /** A release function, or null when the key is already at its cap. */
  acquire(key: string): (() => void) | null {
    const n = this.active.get(key) ?? 0;
    if (n >= this.max) return null;
    this.active.set(key, n + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const cur = this.active.get(key) ?? 1;
      if (cur <= 1) this.active.delete(key);
      else this.active.set(key, cur - 1);
    };
  }
}

// ---- named limits -----------------------------------------------------------

const MIN = 60_000;
const HOUR = 60 * MIN;

/** name -> [env var, default capacity, window ms, human description] */
const LIMIT_DEFS = {
  /** Every API request per client IP (coarse, protects auth lookups and Supabase). */
  ip: ['RATE_IP_PER_MIN', 60, MIN],
  /** /api/thesis and /api/extract per user: each call is 1-2 paid LLM calls (daily caps below too). */
  llm: ['RATE_LLM_PER_USER_HOUR', 20, HOUR],
  /** POST /v1/assets per user (also costs 1 credit). */
  assets: ['RATE_ASSETS_PER_USER_HOUR', 60, HOUR],
  /** Pipeline runs (/api/complete, /v1/screen, MCP run_screen) per user (also cost 1 credit). */
  run: ['RATE_RUN_PER_USER_HOUR', 30, HOUR],
  /** Paid lookups per user: the `:online` web-search fallbacks, the ytscribe
   * transcript API and the thesis review's web entity check. */
  websearch: ['RATE_WEBSEARCH_PER_USER_HOUR', 6, HOUR],
  /** /v1/universe/* per IP: the explorer fans out one request per opened asset. */
  universe: ['RATE_UNIVERSE_PER_IP_MIN', 120, MIN],
  /** Keyless same-origin universe reads (the signed-out explorer), per IP. */
  universe_anon: ['RATE_UNIVERSE_ANON_PER_IP_MIN', 30, MIN],
} as const;

export type LimitName = keyof typeof LIMIT_DEFS;

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

const limiters = new Map<LimitName, TokenBucketLimiter>();

export function limiter(name: LimitName): TokenBucketLimiter {
  let l = limiters.get(name);
  if (!l) {
    const [envVar, def, windowMs] = LIMIT_DEFS[name];
    l = new TokenBucketLimiter(envInt(envVar, def), windowMs);
    limiters.set(name, l);
  }
  return l;
}

/** Test hook: forget every bucket, quota and slot (and re-read env). */
export function resetLimitersForTests(): void {
  limiters.clear();
  quotas.clear();
  runGuard = null;
  extractGlobal = null;
  extractPerActor = null;
}

// ---- daily quotas -------------------------------------------------------------

/** name -> [env var, default per UTC day] */
const DAILY_DEFS = {
  /** /api/thesis + /api/extract per user (or per client address when anonymous). */
  llm_user: ['RATE_LLM_PER_USER_DAY', 40],
  /** The same uncharged calls summed over EVERY caller: the service-wide daily LLM budget. */
  llm_global: ['RATE_LLM_GLOBAL_PER_DAY', 1500],
  /** Automatic credit refunds after a failed run, per user (final audit L5). */
  refund: ['REFUNDS_PER_USER_DAY', 3],
} as const;

type DailyName = keyof typeof DAILY_DEFS;
const quotas = new Map<DailyName, DailyQuota>();

export function dailyQuota(name: DailyName): DailyQuota {
  let q = quotas.get(name);
  if (!q) {
    const [envVar, def] = DAILY_DEFS[name];
    q = new DailyQuota(envInt(envVar, def));
    quotas.set(name, q);
  }
  return q;
}

const GLOBAL_KEY = 'all';

/**
 * Count one uncharged LLM request (/api/thesis, /api/extract) for `actor`
 * against its daily quota AND the service-wide daily budget (final audit H1).
 * Both are checked before either is counted, so a refusal costs nothing.
 * Throws a 429 that says which limit was hit and that it resets at midnight UTC.
 */
export function consumeUnchargedLlm(actor: string): void {
  const mine = dailyQuota('llm_user');
  const all = dailyQuota('llm_global');
  const retry = secondsUntilUtcMidnight();
  if (mine.used(actor) >= mine.limit) {
    throw new PublicError(
      429,
      'rate_limited',
      `You have reached today's limit of ${mine.limit} thesis reviews and source reads. It resets at midnight UTC.`,
      retry,
    );
  }
  if (all.used(GLOBAL_KEY) >= all.limit) {
    throw new PublicError(
      429,
      'rate_limited',
      'SyntheTick has used up today\'s capacity for thesis reviews and source reads. Please try again after midnight UTC.',
      retry,
    );
  }
  mine.take(actor);
  all.take(GLOBAL_KEY);
}

/** Claim one of today's automatic refunds for a user; false once REFUNDS_PER_USER_DAY are used. */
export function takeRefundAllowance(userId: string): boolean {
  return dailyQuota('refund').take(`u:${userId}`);
}

/** Give a claimed refund back (the refund itself failed, so it did not happen). */
export function returnRefundAllowance(userId: string): void {
  dailyQuota('refund').giveBack(`u:${userId}`);
}

// ---- /api/extract concurrency (final audit M2) ----------------------------------

let extractGlobal: ConcurrencyGuard | null = null;
let extractPerActor: ConcurrencyGuard | null = null;

/**
 * A slot for one /api/extract request, taken BEFORE its body is buffered: an
 * upload can be 35 MB and parsing multiplies that, so at most
 * EXTRACT_MAX_CONCURRENT (default 4) bodies are in memory server-wide and one
 * per user (EXTRACT_MAX_CONCURRENT_PER_USER, default 1). `actor` null skips the
 * per-user cap (loopback development). Returns the release function.
 */
export function acquireExtractSlot(actor: string | null): () => void {
  extractGlobal ??= new ConcurrencyGuard(envInt('EXTRACT_MAX_CONCURRENT', 4));
  extractPerActor ??= new ConcurrencyGuard(envInt('EXTRACT_MAX_CONCURRENT_PER_USER', 1));
  const mine = actor ? extractPerActor.acquire(actor) : () => {};
  if (!mine) {
    throw new PublicError(429, 'rate_limited', 'Another source is still being read. Wait for it to finish, then try again.', 5);
  }
  const shared = extractGlobal.acquire(GLOBAL_KEY);
  if (!shared) {
    mine();
    throw new PublicError(503, 'server_busy', 'SyntheTick is reading many sources right now. Please try again in a few seconds.', 10);
  }
  return () => {
    shared();
    mine();
  };
}

export const RATE_LIMITED_MESSAGE = 'Too many requests. Please slow down and try again shortly.';

/** Consume one token from `name` for `key`; throws PublicError 429 (rate_limited) when empty. */
export function consume(name: LimitName, key: string): void {
  const r = limiter(name).take(key);
  if (!r.ok) {
    throw new PublicError(
      429,
      'rate_limited',
      `${RATE_LIMITED_MESSAGE} Retry in ${r.retryAfterSec} second${r.retryAfterSec === 1 ? '' : 's'}.`,
      r.retryAfterSec,
    );
  }
}

/** Non-throwing variant for soft gates (web-search fallback): true = allowed. */
export function tryConsume(name: LimitName, key: string): boolean {
  return limiter(name).take(key).ok;
}

/** Key for per-user limits: the account when signed in, else the client address
 * (an IPv6 client keyed by its /64, final audit L16, so one subscriber network
 * cannot mint a fresh budget per address). */
export function actorKey(user: { id: string } | null, req: Pick<http.IncomingMessage, 'headers' | 'socket'>): string {
  return user ? `u:${user.id}` : `ip:${ipBucketKey(clientIp(req).ip)}`;
}

// ---- concurrency of pipeline runs ------------------------------------------

let runGuard: ConcurrencyGuard | null = null;

function tooManyRuns(max: number): PublicError {
  return new PublicError(
    429,
    'too_many_runs',
    `You already have ${max} screens running. Wait for one to finish before starting another.`,
    15,
  );
}

/** Throws the too_many_runs 429 when the user could not start another run now
 * (nothing is taken). Lets a handler that charges BEFORE the run core refuse
 * early instead of charging for a run the concurrency cap would turn away
 * (final audit L4). */
export function assertRunSlotAvailable(userId: string): void {
  runGuard ??= new ConcurrencyGuard(envInt('MAX_CONCURRENT_RUNS', 2));
  if (!runGuard.available(userId)) throw tooManyRuns(runGuard.max);
}

/** At most MAX_CONCURRENT_RUNS (default 2) pipeline runs in flight per user. */
export function acquireRunSlot(userId: string): () => void {
  runGuard ??= new ConcurrencyGuard(envInt('MAX_CONCURRENT_RUNS', 2));
  const release = runGuard.acquire(userId);
  if (!release) throw tooManyRuns(runGuard.max);
  return release;
}

// ---- client IP --------------------------------------------------------------

/** Number of trusted proxies in front of the app (TRUST_PROXY=1 or a hop count); 0 = none. */
export function trustedProxyHops(env: Record<string, string | undefined> = process.env): number {
  const v = (env.TRUST_PROXY ?? '').trim().toLowerCase();
  if (!v || v === '0' || v === 'false') return 0;
  if (v === 'true') return 1;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/** Strip the IPv4-mapped IPv6 prefix so ::ffff:1.2.3.4 and 1.2.3.4 share one bucket. */
function normalizeIp(ip: string): string {
  return ip.replace(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i, '$1');
}

export interface ClientIp {
  ip: string;
  /** True when the address came from a trusted proxy header, not the socket. */
  viaProxy: boolean;
  /** Where the address came from. */
  source: 'socket' | 'xff' | 'railway' | 'cloudflare';
  /** True when the address is a shared proxy edge, not a visitor: never bucket it. */
  shared?: boolean;
}

/**
 * Cloudflare's published edge ranges (https://www.cloudflare.com/ips-v4/ and
 * https://www.cloudflare.com/ips-v6/, fetched 2026-10-06). They change rarely;
 * refresh this list when Cloudflare announces a change.
 */
export const CLOUDFLARE_RANGES: Readonly<{ v4: readonly string[]; v6: readonly string[] }> = {
  v4: [
    '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18',
    '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17',
    '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
  ],
  v6: ['2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32'],
};

const cloudflareNets = new BlockList();
for (const cidr of CLOUDFLARE_RANGES.v4) {
  const [net, bits] = cidr.split('/');
  cloudflareNets.addSubnet(net!, Number(bits), 'ipv4');
}
for (const cidr of CLOUDFLARE_RANGES.v6) {
  const [net, bits] = cidr.split('/');
  cloudflareNets.addSubnet(net!, Number(bits), 'ipv6');
}

// Railway's internal proxies live in 100.0.0.0/8 (wider than the CGNAT /10 that
// isPrivateAddress knows) and in its private IPv6 network (fd00::/8).
const railwayInternalNets = new BlockList();
railwayInternalNets.addSubnet('100.0.0.0', 8, 'ipv4');
railwayInternalNets.addSubnet('fd00::', 8, 'ipv6');

/** True when the peer is a Railway internal proxy (or any private address). */
function isRailwayPeer(ip: string): boolean {
  const v = isIP(ip);
  return isPrivateAddress(ip) || (v !== 0 && railwayInternalNets.check(ip, v === 6 ? 'ipv6' : 'ipv4'));
}

/** True when the address belongs to Cloudflare's edge. */
export function isCloudflareIp(ip: string): boolean {
  const v = isIP(ip);
  return v !== 0 && cloudflareNets.check(ip, v === 6 ? 'ipv6' : 'ipv4');
}

/**
 * The platform proxy whose header semantics are known: 'railway' when running
 * on Railway (RAILWAY_ENVIRONMENT, set by Railway itself) or when TRUST_PROXY is
 * 'railway'. An explicit TRUST_PROXY hop count overrides the detection.
 */
export function platformProxy(env: Record<string, string | undefined> = process.env): 'railway' | null {
  const v = (env.TRUST_PROXY ?? '').trim().toLowerCase();
  if (v === 'railway') return 'railway';
  // On Railway a hop count is always wrong: with Cloudflare in front, counting
  // from the right lands on a Cloudflare edge address, which would put every
  // visitor in ONE bucket (one client could then 429 the whole site), and a
  // direct caller could pick its own address. The edge semantics are known, so
  // a numeric TRUST_PROXY is ignored there (warnRailwayTrustProxy says so).
  if (env.RAILWAY_ENVIRONMENT?.trim()) return 'railway';
  if (trustedProxyHops(env) > 0) return null;
  return null;
}

/** Boot hint: a numeric TRUST_PROXY on Railway is ignored (see platformProxy). */
export function warnRailwayTrustProxy(env: Record<string, string | undefined>, warn: (msg: string) => void): void {
  if (env.RAILWAY_ENVIRONMENT?.trim() && trustedProxyHops(env) > 0) {
    warn(`TRUST_PROXY=${env.TRUST_PROXY} is ignored on Railway: the client IP is detected automatically (edge address, or the Cloudflare visitor header). Remove the variable.`);
  }
}

function headerValue(req: Pick<http.IncomingMessage, 'headers'>, name: string): string | undefined {
  const raw = req.headers[name];
  return Array.isArray(raw) ? raw.join(',') : raw;
}

/** First X-Forwarded-For entry, normalised, when it is a valid IP. */
function firstForwarded(req: Pick<http.IncomingMessage, 'headers'>): string | null {
  const first = headerValue(req, 'x-forwarded-for')?.split(',')[0]?.trim();
  return first && isIP(first) ? normalizeIp(first) : null;
}

/**
 * The client address for rate limiting. Socket address unless TRUST_PROXY is
 * set, in which case the Nth-from-right X-Forwarded-For entry (N = hops) is
 * used when it is a valid IP; any malformed header falls back to the socket.
 */
export function clientIp(
  req: Pick<http.IncomingMessage, 'headers' | 'socket'>,
  env: Record<string, string | undefined> = process.env,
): ClientIp {
  const socketIp = normalizeIp(req.socket?.remoteAddress ?? 'unknown');
  // Railway: only when the request really arrives from Railway's internal proxy.
  if (platformProxy(env) === 'railway' && isRailwayPeer(socketIp)) {
    const hop = firstForwarded(req);
    if (hop) {
      if (!isCloudflareIp(hop)) return { ip: hop, viaProxy: true, source: 'railway' };
      const cf = headerValue(req, 'cf-connecting-ip')?.trim();
      if (cf && isIP(cf)) return { ip: normalizeIp(cf), viaProxy: true, source: 'cloudflare' };
      // Through Cloudflare but without its visitor header: the hop is a shared edge.
      return { ip: hop, viaProxy: true, source: 'cloudflare', shared: true };
    }
  }
  const hops = trustedProxyHops(env);
  if (hops > 0) {
    const raw = req.headers['x-forwarded-for'];
    const header = Array.isArray(raw) ? raw.join(',') : raw;
    if (header) {
      const parts = header.split(',').map((s) => s.trim()).filter(Boolean);
      const pick = parts[parts.length - hops];
      if (pick && isIP(pick)) return { ip: normalizeIp(pick), viaProxy: true, source: 'xff' };
    }
  }
  return { ip: socketIp, viaProxy: false, source: 'socket' };
}

/**
 * ORIGIN_LOCK=cloudflare (off by default): on Railway, refuse requests that did
 * not come through Cloudflare (the first X-Forwarded-For hop is not a Cloudflare
 * address), so nobody can skip Cloudflare by calling the Railway domain. Requests
 * without the header (Railway's own health checks) are not affected.
 */
export function originLockRefuses(
  req: Pick<http.IncomingMessage, 'headers' | 'socket'>,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if ((env.ORIGIN_LOCK ?? '').trim().toLowerCase() !== 'cloudflare') return false;
  if (platformProxy(env) !== 'railway') return false;
  const hop = firstForwarded(req);
  return hop !== null && !isCloudflareIp(hop);
}

/**
 * One line describing how the proxy headers look, for checking the client-IP
 * setup in the deployment logs. Counts and yes/no only, never an address.
 */
export function describeProxyShape(
  req: Pick<http.IncomingMessage, 'headers' | 'socket'>,
  env: Record<string, string | undefined> = process.env,
): string {
  const xff = headerValue(req, 'x-forwarded-for');
  const entries = xff ? xff.split(',').filter((s) => s.trim()).length : 0;
  const hop = firstForwarded(req);
  const c = clientIp(req, env);
  return (
    `proxy headers: x-forwarded-for entries=${entries}, first hop is Cloudflare=${hop ? (isCloudflareIp(hop) ? 'yes' : 'no') : 'n/a'}, ` +
    `cf-connecting-ip present=${headerValue(req, 'cf-connecting-ip') ? 'yes' : 'no'}, peer private=${isPrivateAddress(normalizeIp(req.socket?.remoteAddress ?? '')) ? 'yes' : 'no'}, ` +
    `client ip source=${c.source}${c.shared ? ' (shared edge, not bucketed)' : ''}`
  );
}

/**
 * Bucket key for an address: IPv4 as is, IPv6 reduced to its /64 (one
 * subscriber network), so a client that owns a /64 cannot mint 2^64 buckets.
 */
export function ipBucketKey(ip: string): string {
  if (isIP(ip) !== 6) return ip;
  const s = ip.split('%')[0]!.toLowerCase();
  const [head = '', tail = ''] = s.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = s.includes('::') ? [...left, ...new Array<string>(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left;
  const first4 = groups.slice(0, 4).map((g) => Number.parseInt(g, 16));
  if (first4.length !== 4 || first4.some((n) => !Number.isFinite(n))) return ip; // embedded IPv4 tail etc.: keep whole
  return `${first4.map((n) => n.toString(16)).join(':')}::/64`;
}

let warnedSharedIp = false;

/** Test hook: let the one-shot shared-IP warning fire again. */
export function resetSharedIpWarningForTests(): void {
  warnedSharedIp = false;
}

/**
 * Boot-time hint: a deployed server without TRUST_PROXY sits behind a proxy
 * (Railway, Cloudflare) whose address is private, so the per-IP limit below
 * silently switches itself off. Say so once at startup (audit N5).
 */
export function warnIfTrustProxyUnset(
  env: Record<string, string | undefined>,
  warn: (msg: string) => void,
  deployed: boolean,
): void {
  if (!deployed || trustedProxyHops(env) > 0 || platformProxy(env) === 'railway') return;
  warn(
    'TRUST_PROXY is not set: if a proxy sits in front of this server, per-IP rate limits are OFF because every ' +
      'request arrives from the proxy\'s private address. Set TRUST_PROXY to the number of proxies in front of it: ' +
      '2 behind Cloudflare plus Railway (the synthetick.org setup), 1 behind Railway alone. Do not use 1 behind ' +
      'Cloudflare: every visitor would then share one Cloudflare edge address. Per-user limits and credits still apply.',
  );
}

/**
 * Enforce the per-IP bucket `name`. When the peer is a private/loopback address
 * and no proxy is trusted, every client looks like the same proxy, so an IP
 * bucket would throttle the whole site as one user: skip it (per-user buckets
 * and the run cap still apply) and warn once so the operator sets TRUST_PROXY.
 * Loopback in development stays silent (that is just you).
 */
export function consumeIp(
  name: LimitName,
  req: Pick<http.IncomingMessage, 'headers' | 'socket'>,
  warn: (msg: string) => void = () => {},
): void {
  const { ip, viaProxy, shared } = clientIp(req);
  if (shared) return; // a shared proxy edge is not one visitor: per-user limits still apply
  if (!viaProxy && (isPrivateAddress(ip) || (platformProxy() === 'railway' && isRailwayPeer(ip)))) {
    if (!warnedSharedIp && (process.env.NODE_ENV === 'production' || !isLoopbackAddress(ip))) {
      warnedSharedIp = true;
      warn(
        `rate limit: client IP ${ip} is a private address and TRUST_PROXY is not set; per-IP limits are disabled. ` +
          'Set TRUST_PROXY to the number of proxies in front of the app: 2 behind Cloudflare plus Railway, 1 behind Railway alone.',
      );
    }
    return;
  }
  consume(name, `ip:${ipBucketKey(ip)}`);
}

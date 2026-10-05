/**
 * Beta auth + daily credits (spec §12).
 *
 * Auth is a deploy-time switch: when SUPABASE_ANON_KEY is set the API requires
 * a signed-in Supabase user (Google) and enforces the daily credit budget;
 * when it is absent everything runs open, exactly as before (local dev, tests).
 * Loopback requests always run open (isLocalRequest): OAuth cannot redirect
 * back to localhost, so local dev skips the gate even with the key set.
 * Production refuses to start without the key (assertAuthConfigured).
 *
 * All credit writes go through the service-role client and the SECURITY DEFINER
 * RPCs in db/auth_credits.sql; browsers never touch the credit tables directly.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type http from 'node:http';
import { supabase } from '../ingest/lib/supabase.js';
import { env } from '../ingest/lib/env.js';
import { log } from '../ingest/lib/log.js';
import { isLocalRequest } from './access.js';
import { dailyQuota, returnRefundAllowance, takeRefundAllowance } from './ratelimit.js';
import { addRunFailureNote } from '../runtime/errors.js';

export function authEnabled(): boolean {
  return Boolean(env.SUPABASE_ANON_KEY);
}

// Locality is decided from the TCP peer, never the Host header alone: see
// server/access.ts (security audit H4). Re-exported for existing importers.
export { isLocalRequest } from './access.js';

export interface AuthedUser {
  id: string;
  email: string;
}

export interface Profile {
  id: string;
  email: string;
  credits: number;
  daily_cap: number;
  credits_date: string;
  is_admin: boolean;
  created_at: string;
}

export interface SpendResult {
  ok: boolean;
  credits: number;
  cap: number;
}

/** The parts of a verified Supabase user that decide whether its session is accepted. */
export interface SessionUserFacts {
  is_anonymous?: boolean | null;
  app_metadata?: { provider?: unknown; providers?: unknown } | null;
}

/** Sign-in providers whose sessions the API accepts: AUTH_PROVIDERS (comma list), default google. */
export function allowedAuthProviders(e: Record<string, string | undefined> = process.env): string[] {
  const list = (e.AUTH_PROVIDERS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s && s !== 'anonymous');
  return list.length ? list : ['google'];
}

/**
 * Only real Google accounts may use the API (final audit M1). The app offers
 * Google sign-in alone, but a Supabase project can have other providers on
 * (Email is on by default, anonymous sign-ins can be enabled), and its URL and
 * anon key are public: without this check a script could mint accounts, each
 * with daily credits and the uncharged LLM budget. Anonymous users are refused
 * whatever AUTH_PROVIDERS says. Pure: offline tested with fake users.
 */
export function isAcceptedSessionUser(user: SessionUserFacts, allowed: string[] = allowedAuthProviders()): boolean {
  if (user.is_anonymous === true) return false;
  const meta = user.app_metadata ?? {};
  const providers = [
    ...(typeof meta.provider === 'string' ? [meta.provider] : []),
    ...(Array.isArray(meta.providers) ? meta.providers.filter((p): p is string => typeof p === 'string') : []),
  ].map((p) => p.toLowerCase());
  if (providers.includes('anonymous')) return false;
  return providers.some((p) => allowed.includes(p));
}

/** Resolve the Bearer token to a Supabase user; null = missing/invalid, or
 * not an accepted sign-in (anonymous, or a provider other than Google). */
export async function userFromRequest(req: http.IncomingMessage): Promise<AuthedUser | null> {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
  if (!m) return null;
  const { data, error } = await supabase.auth.getUser(m[1]);
  if (error || !data.user) return null;
  if (!isAcceptedSessionUser(data.user)) {
    log.warn(`auth: refused a session from an unaccepted sign-in (user ${data.user.id})`);
    return null;
  }
  return { id: data.user.id, email: data.user.email ?? '' };
}

/**
 * Auth gate for API handlers. Auth off → null (caller proceeds unauthed).
 * Auth on → the user, or writes 401 and returns undefined (caller must return).
 */
export async function requireUser(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<AuthedUser | null | undefined> {
  if (!authEnabled() || isLocalRequest(req)) return null;
  const user = await userFromRequest(req);
  if (!user) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Sign in to use SyntheTick.', code: 'unauthorized' }));
    return undefined;
  }
  return user;
}

// ---- charge first, run later (final audit L4) ---------------------------------
//
// /v1/screen and MCP used to peek at the balance, run the paid thesis call,
// and only then charge inside the shared run core (server/run.ts), so parallel
// requests all passed the peek. They now charge FIRST. The run core still
// performs its own `spendCredit(user, 1, 'search')`; inside withPrepaidCredit
// that call consumes the credit already taken instead of charging a second
// time. Everything after it (concurrency slot, refund on failure, credits
// event, prompt log) is unchanged.

/** A credit charged before the run core started. `used` flips when the core takes it over. */
export interface PrepaidCredit {
  userId: string;
  result: SpendResult;
  used: boolean;
}

const prepaidStore = new AsyncLocalStorage<PrepaidCredit>();

/** Run `fn` with `prepaid` (when given) as the credit the run core will take instead of charging. */
export function withPrepaidCredit<T>(prepaid: PrepaidCredit | null, fn: () => Promise<T>): Promise<T> {
  return prepaid ? prepaidStore.run(prepaid, fn) : fn();
}

/**
 * Charge-first wrapper for handlers whose run starts with paid work (L4):
 * charge 1 credit, run `fn` with it prepaid, and refund it when the run core
 * never took it over (the run was refused or failed before it started). A
 * client that disconnected keeps the charge, exactly like a cancelled run
 * (spec §12): refunding would let start-and-cancel loops spend model money
 * outside the daily credit budget. Returns null when the user has no credit
 * left (`onNoCredit` has answered). Auth off (no user) charges nothing.
 */
export async function chargeFirst<T>(
  user: AuthedUser | null,
  opts: {
    signal?: AbortSignal;
    /** The balance is spent: answer the client (402); nothing ran, nothing was charged. */
    onNoCredit: (spent: SpendResult) => void;
    /** The prepaid credit was given back because the run never started. */
    onRefund?: (refunded: SpendResult) => void;
  },
  fn: () => Promise<T>,
): Promise<{ value: T } | null> {
  if (!user) return { value: await fn() };
  const spent = await spendCredit(user.id, 1, 'search');
  if (!spent.ok) {
    opts.onNoCredit(spent);
    return null;
  }
  const prepaid: PrepaidCredit = { userId: user.id, result: spent, used: false };
  try {
    return { value: await withPrepaidCredit(prepaid, fn) };
  } finally {
    // The run core never took the credit over: the run was refused or failed
    // before it started. Refund it (within the daily refund cap), unless the
    // client left, which keeps the charge like any cancelled run.
    if (!prepaid.used) {
      if (opts.signal?.aborted) {
        log.info(`charge kept: the client left before the run started (user ${user.id})`);
      } else {
        const r = await refundCredit(user.id);
        if (r) opts.onRefund?.(r);
      }
    }
  }
}

/** Spend credits atomically (lazy daily reset inside the RPC). amount 0 = peek.
 * Inside withPrepaidCredit, the run core's charge consumes the prepaid credit. */
export async function spendCredit(
  userId: string,
  amount: number,
  reason: 'search' | 'pdf' | 'daily_reset',
): Promise<SpendResult> {
  const prepaid = prepaidStore.getStore();
  if (prepaid && !prepaid.used && prepaid.userId === userId && amount === 1 && reason === 'search') {
    prepaid.used = true;
    return prepaid.result;
  }
  const { data, error } = await supabase.rpc('spend_credit', {
    p_user: userId,
    p_amount: amount,
    p_reason: reason,
  });
  if (error) throw new Error(`spend_credit failed: ${error.message}`);
  return data as SpendResult;
}

/** Grant (or revoke, negative amount) credits on today's balance. */
export async function addCredit(
  userId: string,
  amount: number,
  reason: 'refund' | 'admin_grant' | 'admin_set',
): Promise<SpendResult> {
  const { data, error } = await supabase.rpc('add_credit', {
    p_user: userId,
    p_amount: amount,
    p_reason: reason,
  });
  if (error) throw new Error(`add_credit failed: ${error.message}`);
  return data as SpendResult;
}

/** Why a refund did not happen: the daily refund cap, or the refund call failed. */
export type RefundOutcome = { refunded: SpendResult; reason?: undefined } | { refunded: null; reason: 'capped' | 'failed' };

/** Client-safe sentence for a refund refused by the daily cap (no em or en dashes). */
export function refundCappedNote(limit: number): string {
  return `Automatic refunds are limited to ${limit} a day, so the credit for this request stays charged.`;
}
export const REFUND_FAILED_NOTE = 'The credit could not be refunded automatically.';

/**
 * Refund a charge after a failed run, at most REFUNDS_PER_USER_DAY (default 3)
 * times per user per UTC day (final audit L5): a request crafted to fail late,
 * after the paid calls, must not be repeatable for free. Past the cap the
 * credit stays charged. Either way the current request's failure message says
 * so (addRunFailureNote), so no error ever claims a refund that did not
 * happen. Never throws (the run error wins).
 */
export async function refundCreditDetailed(userId: string): Promise<RefundOutcome> {
  if (!takeRefundAllowance(userId)) {
    const limit = dailyQuota('refund').limit;
    log.warn(`refund refused: the daily automatic refund cap (${limit}) is reached (user ${userId})`);
    addRunFailureNote(refundCappedNote(limit));
    return { refunded: null, reason: 'capped' };
  }
  try {
    return { refunded: await addCredit(userId, 1, 'refund') };
  } catch (err) {
    returnRefundAllowance(userId); // nothing was refunded, so the allowance is not used up
    log.error('credit refund failed', err);
    addRunFailureNote(REFUND_FAILED_NOTE);
    return { refunded: null, reason: 'failed' };
  }
}

/** Refund a charge after a failed run (capped, see refundCreditDetailed); null = not refunded. Never throws. */
export async function refundCredit(userId: string): Promise<SpendResult | null> {
  return (await refundCreditDetailed(userId)).refunded;
}

/** prompt_log keeps an excerpt, never a whole document (final audit H1): the
 * pipeline still gets the full text, the table cannot be filled 100 KB a call. */
export const PROMPT_LOG_MAX_CHARS = 20_000;

/**
 * Log a submitted research prompt (db/prompt_log.sql, user decision
 * 2026-07-15). Fire-and-forget: a missing table or insert error must never
 * fail the run. No-op when auth is off (nothing to attribute).
 */
export function logPrompt(user: AuthedUser | null, prompt: string): void {
  if (!user) return;
  supabase
    .from('prompt_log')
    .insert({ user_id: user.id, email: user.email, prompt: prompt.slice(0, PROMPT_LOG_MAX_CHARS) })
    .then(({ error }) => {
      if (error) log.error('prompt log failed', error);
    });
}

/** Load a user's profile row (service role bypasses RLS). */
export async function getProfile(userId: string): Promise<Profile | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, email, credits, daily_cap, credits_date, is_admin, created_at')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw new Error(`profiles read failed: ${error.message}`);
  return (data as Profile) ?? null;
}

/** Admin gate: requireUser + profiles.is_admin. Writes 401/403 on failure. */
export async function requireAdmin(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<AuthedUser | undefined> {
  if (!authEnabled() || isLocalRequest(req)) {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        error: isLocalRequest(req)
          ? 'Sign-in is skipped on localhost, so the admin panel is unavailable. Use the deployed site.'
          : 'Beta auth is not enabled on this server.',
        code: 'forbidden',
      }),
    );
    return undefined;
  }
  const user = await requireUser(req, res);
  if (!user) return undefined;
  const profile = await getProfile(user.id);
  if (!profile?.is_admin) {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Admin access required.', code: 'forbidden' }));
    return undefined;
  }
  return user;
}

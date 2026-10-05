/**
 * X (Twitter) account linking (spec §14, PR 1).
 *
 * Maps an X identity onto an existing SyntheTick account so the X bot can
 * resolve a mention's author to the user whose credits a reply spends. Not a
 * sign-in method: Google remains the only way into the app.
 *
 * OAuth 2.0 + PKCE against X, scopes users.read tweet.read (identity only —
 * no offline.access, we never hold a token that acts as the user). The state
 * is an AES-256-GCM sealed blob carrying the user id and the PKCE code
 * verifier (final audit L3: encrypted, so the verifier that travels in the
 * authorize URL and the callback is unreadable and PKCE keeps its point), so
 * the browser-redirect callback needs no server-side session store and
 * survives restarts. Single use within its 10-minute TTL. The key comes from
 * X_STATE_SECRET, or when that is unset from SUPABASE_SERVICE_KEY through HKDF
 * with a fixed domain-separation label (a warning is logged once in
 * production). A missing x_accounts table degrades like api_keys: linking
 * reports the pending migration, nothing throws to the app's other routes.
 */
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { supabase } from '../ingest/lib/supabase.js';
import { env } from '../ingest/lib/env.js';
import { log } from '../ingest/lib/log.js';

const X_AUTHORIZE_URL = 'https://x.com/i/oauth2/authorize';
const X_TOKEN_URL = 'https://api.x.com/2/oauth2/token';
const X_ME_URL = 'https://api.x.com/2/users/me';
const X_SCOPES = 'users.read tweet.read';
export const STATE_TTL_MS = 10 * 60 * 1000;

export function xLinkConfigured(): boolean {
  if (!(env.X_CLIENT_ID && env.X_REDIRECT_URL)) return false;
  try {
    stateKey(); // a key is always derivable when SUPABASE_SERVICE_KEY is set (env.ts requires it)
    return true;
  } catch {
    return false;
  }
}

export const missingXTable = (msg: string) => /x_accounts.*(does not exist|not find)/i.test(msg);

// ---- sealed state -----------------------------------------------------------

interface StatePayload {
  u: string; // SyntheTick user id
  v: string; // PKCE code verifier
  exp: number; // ms epoch
}

/** Fixed HKDF labels: a key derived for X link state is useless for anything else. */
const HKDF_SALT = 'synthetick/x-link-state';
const HKDF_INFO_DEDICATED = 'aes-256-gcm key from X_STATE_SECRET, v2';
const HKDF_INFO_DERIVED = 'aes-256-gcm key from SUPABASE_SERVICE_KEY, v2';
/** Authenticated with every state, so a sealed blob from another context never opens here. */
const STATE_AAD = Buffer.from('x-link-state:v2');
const STATE_VERSION = 'v2';

export interface StateKeyEnv {
  X_STATE_SECRET?: string;
  SUPABASE_SERVICE_KEY?: string;
  NODE_ENV?: string;
  RAILWAY_ENVIRONMENT?: string;
}

/**
 * The 32-byte AES-256-GCM key for the link state and where it came from.
 * X_STATE_SECRET when set. Otherwise (production included, e2e P1-b: X linking
 * must keep working when the variable is missing) SUPABASE_SERVICE_KEY through
 * HKDF-SHA256 with a fixed salt and label: the derived key is independent of
 * the service key itself, which is never used as a key directly. Throws only
 * when neither secret exists.
 */
export function stateKeyFrom(e: StateKeyEnv): { key: Buffer; source: 'dedicated' | 'derived' } {
  const dedicated = e.X_STATE_SECRET?.trim();
  if (dedicated) {
    return { key: Buffer.from(hkdfSync('sha256', dedicated, HKDF_SALT, HKDF_INFO_DEDICATED, 32)), source: 'dedicated' };
  }
  const service = e.SUPABASE_SERVICE_KEY?.trim();
  if (!service) throw new Error('X link state needs X_STATE_SECRET or SUPABASE_SERVICE_KEY.');
  return { key: Buffer.from(hkdfSync('sha256', service, HKDF_SALT, HKDF_INFO_DERIVED, 32)), source: 'derived' };
}

/** The state key alone (kept for the security gate's key-separation checks). */
export function stateSecretFrom(e: StateKeyEnv): Buffer {
  return stateKeyFrom(e).key;
}

let warnedDerivedKey = false;

function stateKey(): Buffer {
  const e: StateKeyEnv = { ...process.env, SUPABASE_SERVICE_KEY: env.SUPABASE_SERVICE_KEY };
  const { key, source } = stateKeyFrom(e);
  if (source === 'derived' && !warnedDerivedKey && (e.NODE_ENV === 'production' || e.RAILWAY_ENVIRONMENT)) {
    warnedDerivedKey = true;
    log.warn(
      'X_STATE_SECRET is not set: the X link state key is derived from SUPABASE_SERVICE_KEY (HKDF, X linking keeps ' +
        'working). Set X_STATE_SECRET to a long random string to give it its own key.',
    );
  }
  return key;
}

/** Seal { user id, PKCE verifier, expiry } with AES-256-GCM. ttlMs is injectable for the expiry test only. */
export function signState(userId: string, verifier: string, ttlMs = STATE_TTL_MS): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', stateKey(), iv);
  cipher.setAAD(STATE_AAD);
  const plain = Buffer.from(JSON.stringify({ u: userId, v: verifier, exp: Date.now() + ttlMs } satisfies StatePayload));
  const sealed = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${STATE_VERSION}.${iv.toString('base64url')}.${sealed.toString('base64url')}.${tag.toString('base64url')}`;
}

/** null = malformed, tampered, sealed with another key, or expired. */
export function verifyState(state: string): { userId: string; verifier: string } | null {
  const parts = state.split('.');
  if (parts.length !== 4 || parts[0] !== STATE_VERSION) return null;
  try {
    const [, ivB64, sealedB64, tagB64] = parts as [string, string, string, string];
    // Canonical encoding only: base64url decoding is lenient (padding, stray
    // characters), and a re-encoded copy of a used state must not count as a
    // new state for the single-use check below.
    if ([ivB64, sealedB64, tagB64].some((p) => Buffer.from(p, 'base64url').toString('base64url') !== p)) return null;
    const iv = Buffer.from(ivB64, 'base64url');
    const tag = Buffer.from(tagB64, 'base64url');
    if (iv.length !== 12 || tag.length !== 16) return null;
    const decipher = createDecipheriv('aes-256-gcm', stateKey(), iv, { authTagLength: 16 });
    decipher.setAAD(STATE_AAD);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(Buffer.from(sealedB64, 'base64url')), decipher.final()]);
    const parsed = JSON.parse(plain.toString('utf8')) as StatePayload;
    if (typeof parsed.u !== 'string' || typeof parsed.v !== 'string') return null;
    if (typeof parsed.exp !== 'number' || parsed.exp < Date.now()) return null;
    return { userId: parsed.u, verifier: parsed.v };
  } catch {
    return null; // authentication failed (tampered or foreign key) or not JSON
  }
}

const consumedStates = new Map<string, number>(); // sha256(state) -> ms epoch it may be forgotten
const MAX_CONSUMED_STATES = 2000;

/**
 * Single use within the TTL (audit L1): true the first time a verified state is
 * presented, false for every replay. Kept in memory (one process, entries die
 * with the TTL anyway); the map is bounded, oldest entries go first.
 */
export function consumeStateOnce(state: string, now = Date.now()): boolean {
  const key = createHash('sha256').update(state).digest('base64url'); // unique per issued state (random IV)
  if (consumedStates.has(key)) return false;
  if (consumedStates.size >= MAX_CONSUMED_STATES) {
    for (const [k, until] of consumedStates) if (until <= now) consumedStates.delete(k);
    for (const k of consumedStates.keys()) {
      if (consumedStates.size < MAX_CONSUMED_STATES) break;
      consumedStates.delete(k);
    }
  }
  consumedStates.set(key, now + STATE_TTL_MS);
  return true;
}

// ---- OAuth flow -------------------------------------------------------------

/** Build the X authorize URL for a signed-in user (spec §14). */
export function beginLink(userId: string): string {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const url = new URL(X_AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', env.X_CLIENT_ID);
  url.searchParams.set('redirect_uri', env.X_REDIRECT_URL);
  url.searchParams.set('scope', X_SCOPES);
  url.searchParams.set('state', signState(userId, verifier));
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

/** Callback outcome → the /?x= redirect value the frontend turns into a notice. */
export type LinkOutcome = 'linked' | 'taken' | 'error';

/** Exchange the code, fetch the X identity, upsert the link row. */
export async function completeLink(code: string, state: string): Promise<LinkOutcome> {
  const verified = verifyState(state);
  if (!verified || !consumeStateOnce(state)) return 'error';

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: env.X_REDIRECT_URL,
    code_verifier: verified.verifier,
    client_id: env.X_CLIENT_ID,
  });
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (env.X_CLIENT_SECRET) {
    headers.authorization =
      'Basic ' + Buffer.from(`${env.X_CLIENT_ID}:${env.X_CLIENT_SECRET}`).toString('base64');
  }
  let me: { data?: { id?: string; username?: string } };
  try {
    const tokenRes = await fetch(X_TOKEN_URL, { method: 'POST', headers, body, signal: AbortSignal.timeout(10_000) });
    if (!tokenRes.ok) {
      log.error(`X token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`);
      return 'error';
    }
    const token = (await tokenRes.json()) as { access_token?: string };
    if (!token.access_token) return 'error';

    const meRes = await fetch(X_ME_URL, {
      headers: { authorization: `Bearer ${token.access_token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!meRes.ok) {
      log.error(`X users/me failed: ${meRes.status} ${await meRes.text()}`);
      return 'error';
    }
    me = (await meRes.json()) as { data?: { id?: string; username?: string } };
  } catch (err) {
    // A timeout or network error is an outcome too: the callback is a browser
    // redirect, and a thrown error reached the user as a raw JSON error page
    // instead of the /?x=error notice.
    log.error(`X link exchange failed: ${(err as Error).message}`);
    return 'error';
  }
  if (!me.data?.id || !me.data.username) return 'error';

  return linkXAccount(verified.userId, me.data.id, me.data.username);
}

// ---- DB ---------------------------------------------------------------------

export interface XAccount {
  x_user_id: string;
  x_handle: string;
  linked_at: string;
}

/** Upsert the link; re-linking replaces the user's previous X account. */
export async function linkXAccount(
  userId: string,
  xUserId: string,
  xHandle: string,
): Promise<LinkOutcome> {
  const { error } = await supabase
    .from('x_accounts')
    .upsert(
      { user_id: userId, x_user_id: xUserId, x_handle: xHandle, linked_at: new Date().toISOString() },
      { onConflict: 'user_id' },
    );
  if (!error) return 'linked';
  // Unique violation on x_user_id: that X account belongs to another user.
  if (error.code === '23505' || /duplicate key|unique constraint/i.test(error.message)) return 'taken';
  log.error(`x_accounts upsert failed: ${error.message}`);
  return 'error';
}

/** The user's link, or null when unlinked (or pre-migration). */
export async function getXAccount(userId: string): Promise<XAccount | null> {
  const { data, error } = await supabase
    .from('x_accounts')
    .select('x_user_id, x_handle, linked_at')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    if (missingXTable(error.message)) return null;
    throw new Error(`x_accounts read failed: ${error.message}`);
  }
  return (data as XAccount) ?? null;
}

/** Remove the user's link. False = nothing to remove. */
export async function unlinkXAccount(userId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('x_accounts')
    .delete()
    .eq('user_id', userId)
    .select('user_id');
  if (error) {
    if (missingXTable(error.message)) return false;
    throw new Error(`x_accounts delete failed: ${error.message}`);
  }
  return (data ?? []).length > 0;
}

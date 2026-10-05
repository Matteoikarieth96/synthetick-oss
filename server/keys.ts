/**
 * Personal API keys (spec §13).
 *
 * A key belongs to a signed-in user and spends that user's daily credits.
 * Only the SHA-256 hash of the full key is stored (db/api_keys.sql, service
 * role only); the full key is returned exactly once at creation. Revocation
 * is a timestamp, never a delete. A missing api_keys table degrades: key auth
 * resolves nobody, management calls report the pending migration.
 */
import { createHash, randomBytes } from 'node:crypto';
import type http from 'node:http';
import { supabase } from '../ingest/lib/supabase.js';
import { log } from '../ingest/lib/log.js';
import type { AuthedUser } from './auth.js';

export const MAX_ACTIVE_KEYS = 5;
const NAME_MAX = 60;
const PREFIX_LEN = 12;

export interface ApiKeyRow {
  id: string;
  name: string;
  key_prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const missingTable = (msg: string) => /api_keys.*(does not exist|not find)/i.test(msg);

/** Business refusal (too many keys, missing migration) vs thrown DB errors. */
export type CreateKeyResult =
  | { ok: true; key: string; row: ApiKeyRow }
  | { ok: false; error: string };

export async function createKey(user: AuthedUser, rawName: string): Promise<CreateKeyResult> {
  const name = rawName.trim().slice(0, NAME_MAX);
  const active = await supabase
    .from('api_keys')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', user.id)
    .is('revoked_at', null);
  if (active.error) {
    if (missingTable(active.error.message)) {
      return { ok: false, error: 'API keys are not set up yet on this server (db/api_keys.sql).' };
    }
    throw new Error(`api_keys count failed: ${active.error.message}`);
  }
  if ((active.count ?? 0) >= MAX_ACTIVE_KEYS) {
    return { ok: false, error: `You already have ${MAX_ACTIVE_KEYS} active keys. Revoke one first.` };
  }
  const key = `stk_${randomBytes(32).toString('base64url')}`;
  const { data, error } = await supabase
    .from('api_keys')
    .insert({
      user_id: user.id,
      name,
      key_hash: sha256(key),
      key_prefix: key.slice(0, PREFIX_LEN),
    })
    .select('id, name, key_prefix, created_at, last_used_at, revoked_at')
    .single();
  if (error) throw new Error(`api_keys insert failed: ${error.message}`);
  return { ok: true, key, row: data as ApiKeyRow };
}

/** All of a user's keys newest-first (revoked ones included, marked by revoked_at). */
export async function listKeys(userId: string): Promise<ApiKeyRow[] | null> {
  const { data, error } = await supabase
    .from('api_keys')
    .select('id, name, key_prefix, created_at, last_used_at, revoked_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) {
    if (missingTable(error.message)) return null; // pre-migration
    throw new Error(`api_keys list failed: ${error.message}`);
  }
  return (data ?? []) as ApiKeyRow[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Revoke one of the user's own active keys. False = not found / not theirs.
 * A malformed id is "not found" too: sent to Postgres it failed the uuid cast
 * and surfaced as a 500 instead of the route's 404. */
export async function revokeKey(userId: string, keyId: string): Promise<boolean> {
  if (!UUID_RE.test(keyId)) return false;
  const { data, error } = await supabase
    .from('api_keys')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', keyId)
    .eq('user_id', userId)
    .is('revoked_at', null)
    .select('id');
  if (error) {
    if (missingTable(error.message)) return false;
    throw new Error(`api_keys revoke failed: ${error.message}`);
  }
  return (data ?? []).length > 0;
}

/**
 * Resolve a request's API key (Authorization: Bearer stk_… or x-api-key) to
 * its owner. null = no key / unknown / revoked. Touches last_used_at
 * fire-and-forget; a stale timestamp must never fail a run.
 */
export async function userFromApiKey(req: http.IncomingMessage): Promise<AuthedUser | null> {
  const bearer = /^Bearer\s+(stk_[A-Za-z0-9_-]+)$/i.exec(req.headers.authorization ?? '')?.[1];
  const headerKey = typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'] : '';
  const key = bearer ?? (headerKey.startsWith('stk_') ? headerKey : '');
  if (!key) return null;
  const { data, error } = await supabase
    .from('api_keys')
    .select('id, user_id')
    .eq('key_hash', sha256(key))
    .is('revoked_at', null)
    .maybeSingle();
  if (error) {
    if (missingTable(error.message)) return null;
    throw new Error(`api_keys lookup failed: ${error.message}`);
  }
  if (!data) return null;
  supabase
    .from('api_keys')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', data.id)
    .then(({ error: touchErr }) => {
      if (touchErr) log.error('api_keys last_used_at touch failed', touchErr);
    });
  const profile = await supabase.from('profiles').select('email').eq('id', data.user_id).maybeSingle();
  if (profile.error) throw new Error(`profiles read failed: ${profile.error.message}`);
  return { id: data.user_id, email: (profile.data?.email as string | undefined) ?? '' };
}

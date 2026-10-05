/**
 * Bot persistence (spec §14, PR 3): the since_id watermark in bot_state and
 * the claim-first idempotency ledger in bot_replies (db/bot_state.sql).
 * Factored out of the worker loop so the test gate can exercise it without
 * polling X.
 */
import { supabase } from '../ingest/lib/supabase.js';
import type { AuthedUser } from '../server/auth.js';

export type ReplyKind = 'assets' | 'unlinked' | 'no_credits' | 'error' | 'ignored';

/** Loud, actionable failure when db/bot_state.sql has not been run yet. */
export async function requireBotTables(): Promise<void> {
  const probe = await supabase.from('bot_state').select('key', { head: true, count: 'exact' });
  if (probe.error) {
    if (/does not exist|not find/i.test(probe.error.message)) {
      throw new Error('bot_state table missing: run db/bot_state.sql in the Supabase SQL editor.');
    }
    throw new Error(`bot_state probe failed: ${probe.error.message}`);
  }
}

export async function stateGet(key: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('bot_state')
    .select('value')
    .eq('key', key)
    .maybeSingle();
  if (error) throw new Error(`bot_state read failed: ${error.message}`);
  return (data?.value as string | undefined) ?? null;
}

export async function stateSet(key: string, value: string): Promise<void> {
  const { error } = await supabase
    .from('bot_state')
    .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) throw new Error(`bot_state write failed: ${error.message}`);
}

/**
 * Claim a mention BEFORE acting on it. False = already claimed (a previous
 * run handled or started handling it) — skip without side effects.
 */
export async function claimMention(
  mentionId: string,
  authorXId: string,
  kind: ReplyKind,
): Promise<boolean> {
  const { error } = await supabase
    .from('bot_replies')
    .insert({ mention_id: mentionId, author_x_id: authorXId, kind });
  if (!error) return true;
  if (error.code === '23505' || /duplicate key/i.test(error.message)) return false;
  throw new Error(`bot_replies claim failed: ${error.message}`);
}

/** Correct a claim's kind after the fact (e.g. assets → no_credits). */
export async function updateClaimKind(mentionId: string, kind: ReplyKind): Promise<void> {
  const { error } = await supabase.from('bot_replies').update({ kind }).eq('mention_id', mentionId);
  if (error) throw new Error(`bot_replies update failed: ${error.message}`);
}

/** Has this unlinked author already received today's pointer reply? (UTC day) */
export async function unlinkedRepliedToday(authorXId: string): Promise<boolean> {
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const { count, error } = await supabase
    .from('bot_replies')
    .select('mention_id', { head: true, count: 'exact' })
    .eq('author_x_id', authorXId)
    .eq('kind', 'unlinked')
    .gte('created_at', dayStart.toISOString());
  if (error) throw new Error(`bot_replies count failed: ${error.message}`);
  return (count ?? 0) > 0;
}

/** Resolve a mention author to the linked SyntheTick user, or null. */
export async function linkedUserFor(authorXId: string): Promise<AuthedUser | null> {
  const { data, error } = await supabase
    .from('x_accounts')
    .select('user_id')
    .eq('x_user_id', authorXId)
    .maybeSingle();
  if (error) {
    if (/does not exist|not find/i.test(error.message)) return null; // pre-migration
    throw new Error(`x_accounts read failed: ${error.message}`);
  }
  if (!data) return null;
  const profile = await supabase
    .from('profiles')
    .select('email')
    .eq('id', data.user_id)
    .maybeSingle();
  if (profile.error) throw new Error(`profiles read failed: ${profile.error.message}`);
  return { id: data.user_id as string, email: (profile.data?.email as string | undefined) ?? '' };
}

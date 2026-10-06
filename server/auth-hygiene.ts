/**
 * Google-only sign-in hygiene. The API accepts Google sessions only
 * (isAcceptedSessionUser, AUTH_PROVIDERS), but Supabase may still let anyone
 * create an email/password or anonymous account when those providers are on in
 * the dashboard. Such accounts can never use the app; this job removes them so
 * they do not pile up as profiles. Deleting the auth user cascades to its
 * profile, ledger, prompts, API keys and X link.
 *
 * Safety: admins are never removed, an account must be at least an hour old,
 * at most AUTH_PRUNE_MAX_PER_RUN deletions happen per run, and
 * AUTH_PRUNE_DRY_RUN=1 only counts. It runs on the deployed server only, unless
 * AUTH_PRUNE_INTERVAL_MIN is set explicitly (0 turns it off). Logs carry counts,
 * never emails.
 */
import { isAcceptedSessionUser, allowedAuthProviders, type SessionUserFacts } from './auth.js';

export interface PrunableUser extends SessionUserFacts {
  id: string;
  created_at?: string;
}

/** The slice of the Supabase admin client this job uses (fakeable in tests). */
export interface AuthAdminClient {
  listUsers(page: number, perPage: number): Promise<PrunableUser[]>;
  adminIds(ids: string[]): Promise<Set<string>>;
  deleteUser(id: string): Promise<void>;
}

export interface PruneOptions {
  now?: number;
  minAgeMs?: number;
  maxDeletes?: number;
  dryRun?: boolean;
  allowed?: string[];
}

export interface PruneResult {
  scanned: number;
  candidates: number;
  deleted: number;
  capped: boolean;
}

/** Can this account be removed: never accepted by the API, old enough, not an admin. */
export function isPrunable(user: PrunableUser, adminIds: Set<string>, now: number, minAgeMs: number, allowed: string[]): boolean {
  if (adminIds.has(user.id)) return false;
  if (isAcceptedSessionUser(user, allowed)) return false;
  const created = Date.parse(user.created_at ?? '');
  if (!Number.isFinite(created)) return false; // unknown age: leave it
  return now - created >= minAgeMs;
}

export async function pruneNonAcceptedUsers(client: AuthAdminClient, opts: PruneOptions = {}): Promise<PruneResult> {
  const now = opts.now ?? Date.now();
  const minAgeMs = opts.minAgeMs ?? 60 * 60 * 1000;
  const maxDeletes = opts.maxDeletes ?? 100;
  const allowed = opts.allowed ?? allowedAuthProviders();
  const perPage = 1000;
  const users: PrunableUser[] = [];
  for (let page = 1; page <= 100; page++) {
    const batch = await client.listUsers(page, perPage);
    users.push(...batch);
    if (batch.length < perPage) break;
  }
  // Only accounts the API would refuse can be candidates; look up admin flags for those.
  const refused = users.filter((u) => !isAcceptedSessionUser(u, allowed));
  const admins = refused.length ? await client.adminIds(refused.map((u) => u.id)) : new Set<string>();
  const candidates = refused.filter((u) => isPrunable(u, admins, now, minAgeMs, allowed));
  let deleted = 0;
  if (!opts.dryRun) {
    for (const u of candidates.slice(0, maxDeletes)) {
      await client.deleteUser(u.id);
      deleted++;
    }
  }
  return { scanned: users.length, candidates: candidates.length, deleted, capped: candidates.length > maxDeletes };
}

/** Supabase-backed client: the service key's admin API plus the profiles table. */
export function supabaseAuthAdmin(supabase: {
  auth: { admin: { listUsers: Function; deleteUser: Function } };
  from: Function;
}): AuthAdminClient {
  return {
    async listUsers(page, perPage) {
      const { data, error } = await (supabase.auth.admin.listUsers as (o: object) => Promise<{ data: { users: PrunableUser[] }; error: { message: string } | null }>)({ page, perPage });
      if (error) throw new Error(`listUsers failed: ${error.message}`);
      return data.users;
    },
    async adminIds(ids) {
      const out = new Set<string>();
      for (let i = 0; i < ids.length; i += 200) {
        const { data, error } = await (supabase.from as (t: string) => any)('profiles').select('id,is_admin').in('id', ids.slice(i, i + 200));
        if (error) throw new Error(`profiles read failed: ${error.message}`);
        for (const r of (data ?? []) as { id: string; is_admin: boolean }[]) if (r.is_admin) out.add(r.id);
      }
      return out;
    },
    async deleteUser(id) {
      const { error } = await (supabase.auth.admin.deleteUser as (id: string) => Promise<{ error: { message: string } | null }>)(id);
      if (error) throw new Error(`deleteUser failed: ${error.message}`);
    },
  };
}

/** Minutes between runs: AUTH_PRUNE_INTERVAL_MIN, default 60 on a deployed server, off elsewhere. */
export function pruneIntervalMinutes(env: Record<string, string | undefined>, deployed: boolean): number {
  const raw = env.AUTH_PRUNE_INTERVAL_MIN?.trim();
  if (raw !== undefined && raw !== '') {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }
  return deployed ? 60 : 0;
}

/** Start the hourly job (first run five minutes after boot). Returns a stop function. */
export function startAuthHygiene(
  client: AuthAdminClient,
  env: Record<string, string | undefined>,
  deployed: boolean,
  log: { info: (m: string) => void; warn: (m: string) => void },
): () => void {
  const minutes = pruneIntervalMinutes(env, deployed);
  if (minutes <= 0) return () => {};
  const dryRun = env.AUTH_PRUNE_DRY_RUN === '1';
  const maxDeletes = Math.max(1, Number(env.AUTH_PRUNE_MAX_PER_RUN) || 100);
  const run = async () => {
    try {
      const r = await pruneNonAcceptedUsers(client, { dryRun, maxDeletes });
      if (r.candidates > 0 || dryRun) {
        log.info(`auth hygiene: ${r.scanned} accounts scanned, ${r.candidates} not accepted by the API, ${dryRun ? 'dry run, none' : r.deleted} removed${r.capped ? ' (capped this run)' : ''}`);
      }
    } catch (err) {
      log.warn(`auth hygiene skipped: ${(err as Error).message}`);
    }
  };
  const first = setTimeout(run, 5 * 60 * 1000);
  const timer = setInterval(run, minutes * 60 * 1000);
  first.unref?.();
  timer.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

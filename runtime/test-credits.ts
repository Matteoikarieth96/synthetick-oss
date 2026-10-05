/**
 * Beta credit system gate (spec §12) — verifies db/auth_credits.sql end to end
 * against the live Supabase project, using a disposable auth user.
 *
 *   npm run test:credits
 *
 * Needs SUPABASE_URL + SUPABASE_SERVICE_KEY (no anon key, no LLM spend).
 * Skips cleanly when the migration has not been applied yet. The disposable
 * user is deleted at the end (cascades profile + ledger), even on failure.
 */
import { supabase } from '../ingest/lib/supabase.js';
import { log } from '../ingest/lib/log.js';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) log.info(`PASS — ${name}${detail ? `: ${detail}` : ''}`);
  else {
    failures += 1;
    log.error(`FAIL — ${name}${detail ? `: ${detail}` : ''}`);
  }
}

interface Spend {
  ok: boolean;
  credits: number;
  cap: number;
}

async function rpcSpend(userId: string, amount: number, reason: string): Promise<Spend> {
  const { data, error } = await supabase.rpc('spend_credit', {
    p_user: userId,
    p_amount: amount,
    p_reason: reason,
  });
  if (error) throw new Error(`spend_credit: ${error.message}`);
  return data as Spend;
}

async function rpcAdd(userId: string, amount: number, reason: string): Promise<Spend> {
  const { data, error } = await supabase.rpc('add_credit', {
    p_user: userId,
    p_amount: amount,
    p_reason: reason,
  });
  if (error) throw new Error(`add_credit: ${error.message}`);
  return data as Spend;
}

async function main() {
  log.step('Beta credit system gate (db/auth_credits.sql)');

  // Migration applied?
  const probe = await supabase.from('profiles').select('id').limit(1);
  if (probe.error && /relation .* does not exist|Could not find the table/i.test(probe.error.message)) {
    log.warn('SKIP — profiles table missing: run db/auth_credits.sql in the Supabase SQL editor first');
    return;
  }
  if (probe.error) throw new Error(`profiles probe failed: ${probe.error.message}`);

  // Disposable user; the auth trigger must create the profile + signup ledger row.
  const email = `credit-gate-${Date.now()}@example.test`;
  const created = await supabase.auth.admin.createUser({ email, email_confirm: true });
  if (created.error || !created.data.user) {
    throw new Error(`test user creation failed: ${created.error?.message}`);
  }
  const uid = created.data.user.id;

  try {
    const { data: prof } = await supabase.from('profiles').select('*').eq('id', uid).single();
    check('signup trigger creates the profile', Boolean(prof), JSON.stringify(prof));
    check('defaults are 10 credits / cap 10 / not admin',
      prof?.credits === 10 && prof?.daily_cap === 10 && prof?.is_admin === false);

    const s1 = await rpcSpend(uid, 1, 'search');
    check('search debit: 10 → 9', s1.ok && s1.credits === 9, JSON.stringify(s1));
    const s2 = await rpcSpend(uid, 1, 'pdf');
    check('pdf debit: 9 → 8', s2.ok && s2.credits === 8);

    const drained = await rpcAdd(uid, -8, 'admin_set');
    check('admin revoke to 0', drained.ok && drained.credits === 0);
    const broke = await rpcSpend(uid, 1, 'search');
    check('insufficient credits refuses without charging', !broke.ok && broke.credits === 0);

    const grant = await rpcAdd(uid, 3, 'admin_grant');
    check('admin grant: 0 → 3', grant.ok && grant.credits === 3);
    const refund = await rpcAdd(uid, 1, 'refund');
    check('refund: 3 → 4', refund.ok && refund.credits === 4);

    // Lazy daily reset: rewind credits_date, a 0-amount peek must refill to cap.
    await supabase.from('profiles').update({ credits_date: '2020-01-01' }).eq('id', uid);
    const reset = await rpcSpend(uid, 0, 'daily_reset');
    check('lazy daily reset refills to cap', reset.ok && reset.credits === 10, JSON.stringify(reset));

    // Cap change is permanent: raise it, rewind, peek refills to the new cap.
    await supabase.from('profiles').update({ daily_cap: 25, credits_date: '2020-01-01' }).eq('id', uid);
    const capped = await rpcSpend(uid, 0, 'daily_reset');
    check('raised cap drives the refill', capped.ok && capped.credits === 25 && capped.cap === 25);

    const { data: ledger } = await supabase
      .from('credit_ledger')
      .select('delta, reason')
      .eq('user_id', uid)
      .order('id');
    const reasons = (ledger ?? []).map((l) => l.reason);
    check(
      'ledger records every movement',
      ['signup', 'search', 'pdf', 'admin_set', 'admin_grant', 'refund'].every((r) => reasons.includes(r)),
      reasons.join(','),
    );
  } finally {
    const del = await supabase.auth.admin.deleteUser(uid);
    if (del.error) log.error(`cleanup failed — delete auth user ${uid} manually`, del.error);
    else log.info(`cleanup — disposable user ${email} deleted`);
  }

  if (failures) {
    log.error(`${failures} CHECK(S) FAILED`);
    process.exit(1);
  }
  log.step('ALL CREDIT CHECKS PASSED');
}

main().catch((err) => {
  log.error('credit gate crashed', err);
  process.exit(1);
});

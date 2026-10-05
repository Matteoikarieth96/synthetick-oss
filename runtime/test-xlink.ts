/**
 * X account linking gate (spec §14, PR 1) — verifies the signed OAuth state
 * and db/x_accounts.sql end to end against the live Supabase project, using
 * disposable auth users.
 *
 *   npm run test:xlink
 *
 * Needs SUPABASE_URL + SUPABASE_SERVICE_KEY (no X app, no LLM spend — the
 * OAuth exchange itself only runs against the real X app in production).
 * Skips the DB half cleanly when db/x_accounts.sql has not been applied yet.
 * Disposable users are deleted at the end (cascades the link rows), even on
 * failure.
 */
import { supabase } from '../ingest/lib/supabase.js';
import { log } from '../ingest/lib/log.js';
import { signState, verifyState, linkXAccount, getXAccount, unlinkXAccount } from '../server/xlink.js';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) log.info(`PASS — ${name}${detail ? `: ${detail}` : ''}`);
  else {
    failures += 1;
    log.error(`FAIL — ${name}${detail ? `: ${detail}` : ''}`);
  }
}

async function main() {
  log.step('X link gate (server/xlink.ts + db/x_accounts.sql)');

  // ---- signed state (pure, no DB) -------------------------------------------
  const state = signState('user-123', 'verifier-abc');
  const ok = verifyState(state);
  check('state round trip', ok?.userId === 'user-123' && ok?.verifier === 'verifier-abc');

  const dot = state.lastIndexOf('.');
  const payload = state.slice(0, dot);
  const sig = state.slice(dot + 1);
  const tamperedPayload = Buffer.from(
    JSON.stringify({ u: 'attacker', v: 'verifier-abc', exp: Date.now() + 60_000 }),
  ).toString('base64url');
  check('tampered payload rejected', verifyState(`${tamperedPayload}.${sig}`) === null);
  const flipped = sig.slice(0, -1) + (sig.endsWith('A') ? 'B' : 'A');
  check('tampered signature rejected', verifyState(`${payload}.${flipped}`) === null);
  check('malformed state rejected', verifyState('not-a-state') === null);
  check('expired state rejected', verifyState(signState('user-123', 'v', -1000)) === null);

  // ---- x_accounts constraints -----------------------------------------------
  const probe = await supabase.from('x_accounts').select('user_id').limit(1);
  if (probe.error && /does not exist|not find/i.test(probe.error.message)) {
    log.warn('SKIP — x_accounts table missing: run db/x_accounts.sql in the Supabase SQL editor first');
    finish();
    return;
  }
  if (probe.error) throw new Error(`x_accounts probe failed: ${probe.error.message}`);

  const stamp = Date.now();
  async function disposableUser(label: string): Promise<string> {
    const created = await supabase.auth.admin.createUser({
      email: `xlink-gate-${label}-${stamp}@example.test`,
      email_confirm: true,
    });
    if (created.error || !created.data.user) {
      throw new Error(`test user creation failed: ${created.error?.message}`);
    }
    return created.data.user.id;
  }
  const userA = await disposableUser('a');
  const userB = await disposableUser('b');
  const users = [userA, userB];

  try {
    check('link user A → X1', (await linkXAccount(userA, `x1-${stamp}`, 'alice')) === 'linked');
    const linked = await getXAccount(userA);
    check('read back the link', linked?.x_user_id === `x1-${stamp}` && linked?.x_handle === 'alice');

    check('re-link replaces (A → X2)', (await linkXAccount(userA, `x2-${stamp}`, 'alice2')) === 'linked');
    const relinked = await getXAccount(userA);
    check('replacement stored', relinked?.x_user_id === `x2-${stamp}` && relinked?.x_handle === 'alice2');

    check('cross-user conflict refused', (await linkXAccount(userB, `x2-${stamp}`, 'bob')) === 'taken');
    check('conflict left user B unlinked', (await getXAccount(userB)) === null);

    check('unlink removes the row', (await unlinkXAccount(userA)) === true);
    check('unlinked reads null', (await getXAccount(userA)) === null);
    check('unlink again is a no-op', (await unlinkXAccount(userA)) === false);

    check('X1 freed after replace: user B can take it', (await linkXAccount(userB, `x1-${stamp}`, 'bob')) === 'linked');
  } finally {
    for (const uid of users) {
      const del = await supabase.auth.admin.deleteUser(uid);
      if (del.error) log.error(`cleanup failed — delete auth user ${uid} manually`, del.error);
    }
    log.info('cleanup — disposable users deleted');
  }

  finish();
}

function finish() {
  if (failures) {
    log.error(`${failures} CHECK(S) FAILED`);
    process.exit(1);
  }
  log.step('ALL X LINK CHECKS PASSED');
}

main().catch((err) => {
  log.error('x link gate crashed', err);
  process.exit(1);
});

/**
 * Offline checks for the Railway/Cloudflare client-IP detection and the
 * Google-only account hygiene job. No network, no database, no keys.
 */
import {
  clientIp,
  consumeIp,
  describeProxyShape,
  isCloudflareIp,
  originLockRefuses,
  platformProxy,
  resetLimitersForTests,
} from '../server/ratelimit.js';
import { isPrunable, pruneIntervalMinutes, pruneNonAcceptedUsers, type AuthAdminClient, type PrunableUser } from '../server/auth-hygiene.js';

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`PASS — ${name}`);
  else {
    failures++;
    console.log(`FAIL — ${name}${detail !== undefined ? `: ${JSON.stringify(detail)}` : ''}`);
  }
}
const req = (peer: string, headers: Record<string, string> = {}) => ({ headers, socket: { remoteAddress: peer } }) as never;
const RAILWAY = { RAILWAY_ENVIRONMENT: 'production' };

// ---- Cloudflare ranges -------------------------------------------------------
check('Cloudflare IPv4 edge recognised', isCloudflareIp('172.64.1.10') && isCloudflareIp('104.16.0.1') && isCloudflareIp('162.158.5.5'));
check('Cloudflare IPv6 edge recognised', isCloudflareIp('2606:4700::1') && isCloudflareIp('2a06:98c0::5'));
check('non-Cloudflare addresses are not', !isCloudflareIp('8.8.8.8') && !isCloudflareIp('100.64.0.1') && !isCloudflareIp('2001:db8::1') && !isCloudflareIp('not-an-ip'));

// ---- platform detection ----------------------------------------------------------
check('Railway detected from RAILWAY_ENVIRONMENT', platformProxy(RAILWAY) === 'railway');
check('TRUST_PROXY=railway forces it', platformProxy({ TRUST_PROXY: 'railway' }) === 'railway');
check('a numeric TRUST_PROXY is ignored on Railway (red-team H1)', platformProxy({ ...RAILWAY, TRUST_PROXY: '2' }) === 'railway' && platformProxy({ ...RAILWAY, TRUST_PROXY: '1' }) === 'railway');
check('a hop count still works off Railway', platformProxy({ TRUST_PROXY: '2' }) === null);
{
  const viaCf2 = clientIp(req('100.64.0.1', { 'x-forwarded-for': '172.64.10.20, 100.64.0.9', 'cf-connecting-ip': '203.0.113.7' }), { ...RAILWAY, TRUST_PROXY: '2' });
  check('with TRUST_PROXY=2 on Railway visitors still get their own bucket, not the Cloudflare edge', viaCf2.ip === '203.0.113.7' && viaCf2.source === 'cloudflare', viaCf2);
}
check('no platform outside Railway', platformProxy({}) === null);

// ---- client IP on Railway ----------------------------------------------------------
{
  const viaCf = clientIp(req('100.64.0.1', { 'x-forwarded-for': '172.64.10.20, 100.64.0.9', 'cf-connecting-ip': '203.0.113.7' }), RAILWAY);
  check('through Cloudflare: the visitor comes from CF-Connecting-IP', viaCf.ip === '203.0.113.7' && viaCf.source === 'cloudflare' && !viaCf.shared, viaCf);
  const direct = clientIp(req('100.64.0.1', { 'x-forwarded-for': '198.51.100.9', 'cf-connecting-ip': '1.2.3.4' }), RAILWAY);
  check('direct to Railway: a forged CF-Connecting-IP is ignored, the edge address wins', direct.ip === '198.51.100.9' && direct.source === 'railway', direct);
  const cfNoHeader = clientIp(req('100.64.0.1', { 'x-forwarded-for': '104.16.0.1' }), RAILWAY);
  check('Cloudflare hop without its visitor header is a shared edge, never bucketed', cfNoHeader.shared === true, cfNoHeader);
  const badCf = clientIp(req('100.64.0.1', { 'x-forwarded-for': '104.16.0.1', 'cf-connecting-ip': 'nonsense' }), RAILWAY);
  check('malformed CF-Connecting-IP is not trusted', badCf.shared === true, badCf);
  const v6 = clientIp(req('100.64.0.1', { 'x-forwarded-for': '2606:4700::6810:1', 'cf-connecting-ip': '2001:db8:1:2::7' }), RAILWAY);
  check('IPv6 visitor through an IPv6 Cloudflare edge', v6.ip === '2001:db8:1:2::7', v6);
  const wideInternal = clientIp(req('100.5.6.7', { 'x-forwarded-for': '198.51.100.9' }), RAILWAY);
  check('a Railway proxy anywhere in 100.0.0.0/8 is recognised', wideInternal.ip === '198.51.100.9', wideInternal);
  const publicPeer = clientIp(req('8.8.4.4', { 'x-forwarded-for': '1.2.3.4' }), RAILWAY);
  check('a public peer is never asked for headers, even on Railway', publicPeer.ip === '8.8.4.4' && publicPeer.source === 'socket', publicPeer);
  const noHeader = clientIp(req('100.64.0.1'), RAILWAY);
  check('no forwarding header (health check): falls back to the socket', noHeader.source === 'socket', noHeader);
  const mapped = clientIp(req('::ffff:100.64.0.1', { 'x-forwarded-for': '::ffff:198.51.100.9' }), RAILWAY);
  check('IPv4-mapped addresses are normalised', mapped.ip === '198.51.100.9', mapped);
  const offRailway = clientIp(req('10.0.0.5', { 'x-forwarded-for': '198.51.100.9' }), {});
  check('outside Railway without TRUST_PROXY the header is not trusted', offRailway.ip === '10.0.0.5' && offRailway.source === 'socket', offRailway);
  const legacy = clientIp(req('10.0.0.5', { 'x-forwarded-for': '1.1.1.1, 198.51.100.9' }), { TRUST_PROXY: '1' });
  check('TRUST_PROXY=1 keeps the rightmost entry (other platforms)', legacy.ip === '198.51.100.9' && legacy.source === 'xff', legacy);
}

// ---- per-IP buckets actually engage on Railway --------------------------------------
{
  const prev = process.env.RAILWAY_ENVIRONMENT;
  process.env.RAILWAY_ENVIRONMENT = 'production';
  resetLimitersForTests();
  let blocked = false;
  try {
    for (let i = 0; i < 1000; i++) consumeIp('ip', req('100.64.0.1', { 'x-forwarded-for': '172.64.10.20', 'cf-connecting-ip': '203.0.113.50' }));
  } catch (err) {
    blocked = (err as { status?: number }).status === 429;
  }
  check('per-IP limit engages for one visitor behind Cloudflare and Railway', blocked);
  resetLimitersForTests();
  let sharedBlocked = false;
  try {
    for (let i = 0; i < 1000; i++) consumeIp('ip', req('100.64.0.1', { 'x-forwarded-for': '172.64.10.20' }));
  } catch {
    sharedBlocked = true;
  }
  check('a shared Cloudflare edge is never throttled as one visitor', !sharedBlocked);
  resetLimitersForTests();
  if (prev === undefined) delete process.env.RAILWAY_ENVIRONMENT;
  else process.env.RAILWAY_ENVIRONMENT = prev;
}

// ---- origin lock --------------------------------------------------------------------------
check('origin lock off by default', !originLockRefuses(req('100.64.0.1', { 'x-forwarded-for': '198.51.100.9' }), RAILWAY));
check('origin lock refuses traffic that skipped Cloudflare', originLockRefuses(req('100.64.0.1', { 'x-forwarded-for': '198.51.100.9' }), { ...RAILWAY, ORIGIN_LOCK: 'cloudflare' }));
check('origin lock lets Cloudflare traffic through', !originLockRefuses(req('100.64.0.1', { 'x-forwarded-for': '172.64.10.20', 'cf-connecting-ip': '203.0.113.7' }), { ...RAILWAY, ORIGIN_LOCK: 'cloudflare' }));
check('origin lock ignores requests without the header (health checks)', !originLockRefuses(req('100.64.0.1'), { ...RAILWAY, ORIGIN_LOCK: 'cloudflare' }));

// ---- proxy shape log has no addresses ---------------------------------------------------------
{
  const line = describeProxyShape(req('100.64.0.1', { 'x-forwarded-for': '172.64.10.20, 100.64.0.9', 'cf-connecting-ip': '203.0.113.7' }), RAILWAY);
  check('proxy shape line describes the chain without any address', /entries=2/.test(line) && /Cloudflare=yes/.test(line) && !/\d+\.\d+\.\d+\.\d+/.test(line) && !/:[0-9a-f]{1,4}:/i.test(line), line);
}

// ---- account hygiene ----------------------------------------------------------------------------
{
  const now = Date.parse('2026-10-06T12:00:00Z');
  const old = '2026-10-06T09:00:00Z';
  const fresh = '2026-10-06T11:30:00Z';
  const users: PrunableUser[] = [
    { id: 'g1', created_at: old, app_metadata: { provider: 'google', providers: ['google'] } },
    { id: 'e1', created_at: old, app_metadata: { provider: 'email', providers: ['email'] } },
    { id: 'e2', created_at: fresh, app_metadata: { provider: 'email', providers: ['email'] } },
    { id: 'a1', created_at: old, app_metadata: { provider: 'email', providers: ['email'] } },
    { id: 'anon', created_at: old, is_anonymous: true, app_metadata: { provider: 'anonymous', providers: ['anonymous'] } },
    { id: 'linked', created_at: old, app_metadata: { provider: 'email', providers: ['email', 'google'] } },
    { id: 'noage', app_metadata: { provider: 'email', providers: ['email'] } },
  ];
  const admins = new Set(['a1']);
  const allowed = ['google'];
  check('hygiene keeps Google accounts', !isPrunable(users[0]!, admins, now, 3600_000, allowed));
  check('hygiene removes an old email-only account', isPrunable(users[1]!, admins, now, 3600_000, allowed));
  check('hygiene waits an hour before touching a new account', !isPrunable(users[2]!, admins, now, 3600_000, allowed));
  check('hygiene never removes an admin', !isPrunable(users[3]!, admins, now, 3600_000, allowed));
  check('hygiene removes anonymous accounts', isPrunable(users[4]!, admins, now, 3600_000, allowed));
  check('hygiene keeps an email account that also linked Google', !isPrunable(users[5]!, admins, now, 3600_000, allowed));
  check('hygiene leaves accounts of unknown age alone', !isPrunable(users[6]!, admins, now, 3600_000, allowed));

  const deleted: string[] = [];
  const fake = (list: PrunableUser[]): AuthAdminClient => ({
    async listUsers(page) {
      return page === 1 ? list : [];
    },
    async adminIds(ids) {
      return new Set(ids.filter((id) => admins.has(id)));
    },
    async deleteUser(id) {
      deleted.push(id);
    },
  });
  const r = await pruneNonAcceptedUsers(fake(users), { now, allowed });
  check('prune run deletes exactly the email-only and anonymous accounts', deleted.sort().join(',') === 'anon,e1' && r.deleted === 2 && r.scanned === 7, { deleted, r });
  deleted.length = 0;
  const dry = await pruneNonAcceptedUsers(fake(users), { now, allowed, dryRun: true });
  check('dry run counts and deletes nothing', deleted.length === 0 && dry.candidates === 2, dry);
  const many: PrunableUser[] = Array.from({ length: 250 }, (_, i) => ({ id: `e${i}`, created_at: old, app_metadata: { provider: 'email', providers: ['email'] } }));
  deleted.length = 0;
  const capped = await pruneNonAcceptedUsers(fake(many), { now, allowed, maxDeletes: 100 });
  check('deletions are capped per run', deleted.length === 100 && capped.capped === true, capped);
  check('job is off outside the deployment unless asked', pruneIntervalMinutes({}, false) === 0 && pruneIntervalMinutes({}, true) === 60 && pruneIntervalMinutes({ AUTH_PRUNE_INTERVAL_MIN: '0' }, true) === 0 && pruneIntervalMinutes({ AUTH_PRUNE_INTERVAL_MIN: '15' }, false) === 15);
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);

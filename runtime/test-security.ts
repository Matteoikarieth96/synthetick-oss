/**
 * Security regression gate (open-source audit, H2/H4/M2/M4/M6/M7/L1/L4, re-audit N1-N3/N5/N6/N7):
 * rate limiter, SSRF address classification, access-mode decisions, thesis
 * validation, error mapping, X link state secret and the bot content filter.
 *
 *   npm run test:security
 *
 * Fully offline: no .env, no keys, no network, no database, no LLM spend. The
 * server modules import ingest/lib/env.ts (which refuses to load without
 * Supabase variables), so dummy values are set BEFORE the dynamic imports;
 * nothing here ever connects to them.
 */
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_KEY = 'test-only-service-key';
process.env.VOYAGE_KEY = 'test-only-voyage-key';
delete process.env.TRUST_PROXY;
delete process.env.RATE_IP_PER_MIN;
delete process.env.MAX_CONCURRENT_RUNS;

import http from 'node:http';
import { readFileSync } from 'node:fs';

const { log } = await import('../ingest/lib/log.js');
const net = await import('./netguard.js');
const errors = await import('./errors.js');
const extract = await import('./extract.js');
const rl = await import('../server/ratelimit.js');
const access = await import('../server/access.js');
const validate = await import('../server/validate.js');
const xlink = await import('../server/xlink.js');
const reply = await import('../bot/reply.js');
const universe = await import('./universe.js');
const finreq = await import('./finreq.js');
const thesisMod = await import('./thesis.js');
const run = await import('../server/run.js');

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) log.info(`PASS — ${name}${detail ? `: ${detail}` : ''}`);
  else {
    failures += 1;
    log.error(`FAIL — ${name}${detail ? `: ${detail}` : ''}`);
  }
}

const throws = (fn: () => unknown): unknown => {
  try {
    fn();
    return null;
  } catch (e) {
    return e;
  }
};

async function main() {
  log.step('Security gate (audit regression tests, offline)');

  // ---- 1. address classification (SSRF) --------------------------------------
  const blocked: [string, string][] = [
    ['0.0.0.0', 'this network'],
    ['10.0.0.1', 'private 10/8'],
    ['10.255.255.255', 'private 10/8 top'],
    ['127.0.0.1', 'loopback'],
    ['127.255.0.9', 'loopback range'],
    ['169.254.169.254', 'cloud metadata'],
    ['172.16.0.1', 'private 172.16/12 low'],
    ['172.31.255.255', 'private 172.16/12 high'],
    ['192.168.1.1', 'private 192.168/16'],
    ['100.64.0.1', 'CGNAT low'],
    ['100.127.255.255', 'CGNAT high'],
    ['198.18.0.1', 'benchmarking'],
    ['192.0.2.1', 'TEST-NET-1'],
    ['198.51.100.7', 'TEST-NET-2'],
    ['203.0.113.9', 'TEST-NET-3'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'broadcast'],
    ['::', 'v6 unspecified'],
    ['::1', 'v6 loopback'],
    ['fc00::1', 'v6 unique local fc'],
    ['fd12:3456:789a::1', 'v6 unique local fd'],
    ['fe80::1', 'v6 link-local'],
    ['febf::1', 'v6 link-local top of fe80::/10'],
    ['fec0::1', 'v6 site-local'],
    ['ff02::1', 'v6 multicast'],
    ['::ffff:127.0.0.1', 'v4-mapped loopback (dotted)'],
    ['::ffff:7f00:1', 'v4-mapped loopback (hex)'],
    ['::ffff:10.1.2.3', 'v4-mapped private'],
    ['::ffff:a9fe:a9fe', 'v4-mapped metadata (hex)'],
    ['::127.0.0.1', 'v4-compatible loopback'],
    ['::8.8.8.8', 'v4-compatible public (whole ::/96 blocked)'],
    ['64:ff9b::7f00:1', 'NAT64 embedding 127.0.0.1'],
    ['64:ff9b::a00:1', 'NAT64 embedding 10.0.0.1'],
    ['64:ff9b::808:808', 'NAT64 embedding a public IPv4 (prefix blocked wholesale)'],
    ['64:ff9b:1::1', 'NAT64 local-use /48'],
    ['2002:7f00:1::', '6to4 embedding 127.0.0.1'],
    ['2002:a9fe:a9fe::1', '6to4 embedding metadata'],
    ['2002:808:808::1', '6to4 embedding a public IPv4 (deprecated range blocked wholesale)'],
    ['2001::1', 'Teredo'],
    ['2001:db8::1', 'v6 documentation'],
    ['100::1', 'v6 discard'],
    ['not-an-ip', 'unparseable fails closed'],
    ['999.1.1.1', 'invalid v4 fails closed'],
  ];
  for (const [ip, why] of blocked) check(`blocked: ${ip}`, net.isPrivateAddress(ip), why);
  const allowed: [string, string][] = [
    ['8.8.8.8', 'public v4'],
    ['1.1.1.1', 'public v4'],
    ['93.184.216.34', 'public v4'],
    ['172.15.255.255', 'just below 172.16/12'],
    ['172.32.0.1', 'just above 172.16/12'],
    ['100.63.255.255', 'just below CGNAT'],
    ['100.128.0.1', 'just above CGNAT'],
    ['2606:4700:4700::1111', 'public v6'],
    ['2001:4860:4860::8888', 'public v6'],
    ['2a00:1450:4001:81b::200e', 'public v6'],
    ['::ffff:8.8.8.8', 'v4-mapped PUBLIC is judged by its v4'],
    ['::ffff:808:808', 'v4-mapped public (hex)'],
  ];
  for (const [ip, why] of allowed) check(`allowed: ${ip}`, !net.isPrivateAddress(ip), why);

  check('loopback helper: 127.0.0.1, ::1, ::ffff:127.0.0.1', ['127.0.0.1', '::1', '::ffff:127.0.0.1', '127.9.9.9'].every((i) => net.isLoopbackAddress(i)));
  check('loopback helper: rejects private LAN and public', !['192.168.1.5', '8.8.8.8', '::ffff:10.0.0.1', '', undefined, 'localhost'].some((i) => net.isLoopbackAddress(i as string)));

  // URL-level policy (hostname forms, userinfo, WHATWG canonicalization).
  const badUrls = [
    'http://localhost/admin',
    'http://foo.localhost/',
    'http://service.internal/',
    'http://printer.local/',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://2130706433/', // decimal 127.0.0.1
    'http://0x7f.1/', // hex dotted
    'http://0177.0.0.1/', // octal
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:7f00:1]/',
    'http://[64:ff9b::7f00:1]/',
    'http://[2002:7f00:1::]/',
    'http://[fd00::1]/',
    'http://user:pass@example.com/',
    'http://admin@example.com/',
    'ftp://example.com/file',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'gopher://example.com/',
  ];
  for (const u of badUrls) {
    const e = throws(() => extract.assertPublicHttpUrl(u));
    check(`url blocked: ${u}`, e instanceof errors.PublicError);
  }
  const unsafe = throws(() => extract.assertPublicHttpUrl('http://127.0.0.1/'));
  check(
    'blocked URL carries the stable unsafe_url code',
    unsafe instanceof errors.PublicError && unsafe.code === 'unsafe_url' && unsafe.status === 422,
  );
  check('public https URL accepted', extract.assertPublicHttpUrl('https://example.com/a?b=1').hostname === 'example.com');
  check('public IP literal accepted', extract.assertPublicHttpUrl('http://8.8.8.8/').hostname === '8.8.8.8');
  check('over-long URL rejected', throws(() => extract.assertPublicHttpUrl('https://example.com/' + 'a'.repeat(3000))) instanceof errors.PublicError);

  // Connect-time guard: the lookup hook refuses names that resolve to private addresses.
  const lookupResult = await new Promise<{ err: Error | null }>((resolve) => {
    net.safeLookup('localhost', { all: true }, (err) => resolve({ err }));
  });
  check('safeLookup refuses a name that resolves to loopback', lookupResult.err instanceof net.BlockedAddressError, lookupResult.err?.name);
  const literalOk = await new Promise<{ err: Error | null; addr: unknown }>((resolve) => {
    net.safeLookup('8.8.8.8', {}, (err, addr) => resolve({ err, addr }));
  });
  check('safeLookup passes a public literal through', literalOk.err === null && literalOk.addr === '8.8.8.8');

  // Streaming body cap.
  async function* chunks(n: number, size: number) {
    for (let i = 0; i < n; i++) yield Buffer.alloc(size, 'a');
  }
  const capped = await extract.readCapped(chunks(100, 1024), 10 * 1024);
  check('readCapped truncates at the cap', capped.truncated && capped.text.length === 10 * 1024, `${capped.text.length} bytes`);
  const small = await extract.readCapped(chunks(3, 1024), 10 * 1024);
  check('readCapped keeps a small body whole', !small.truncated && small.text.length === 3072);
  check('page cap is 2 MB', extract.MAX_PAGE_BYTES === 2 * 1024 * 1024);

  // ---- 2. rate limiter ------------------------------------------------------
  let now = 1_000_000;
  const bucket = new rl.TokenBucketLimiter(3, 60_000, () => now);
  check('bucket: first 3 pass', [1, 2, 3].every(() => bucket.take('a').ok));
  const denied = bucket.take('a');
  check('bucket: 4th is denied with a retry hint', !denied.ok && denied.retryAfterSec >= 1 && denied.retryAfterSec <= 20, JSON.stringify(denied));
  check('bucket: keys are isolated', bucket.take('b').ok);
  now += 21_000; // one token = 20 s at 3 per minute
  check('bucket: refills over time', bucket.take('a').ok);
  check('bucket: ...but only one token', !bucket.take('a').ok);
  now += 10 * 60_000;
  check('bucket: refill is capped at capacity', [1, 2, 3].every(() => bucket.take('a').ok) && !bucket.take('a').ok);
  const tiny = new rl.TokenBucketLimiter(1, 1000, () => now, 5);
  for (let i = 0; i < 50; i++) tiny.take(`k${i}`);
  now += 2000; // every bucket has refilled: idle buckets are what gets reclaimed
  tiny.take('later');
  check('bucket: memory is bounded by maxKeys once buckets are idle', tiny.size <= 6, `size ${tiny.size}`);

  const guard = new rl.ConcurrencyGuard(2);
  const r1 = guard.acquire('u');
  const r2 = guard.acquire('u');
  check('concurrency: two slots per key', r1 !== null && r2 !== null);
  check('concurrency: third refused', guard.acquire('u') === null);
  check('concurrency: other key unaffected', guard.acquire('v') !== null);
  r1!();
  r1!(); // double release must not free a second slot
  check('concurrency: release frees exactly one slot', guard.acquire('u') !== null && guard.acquire('u') === null);

  // Named limits + env override + stable 429 shape.
  rl.resetLimitersForTests();
  process.env.RATE_IP_PER_MIN = '2';
  const ipReq = { headers: {}, socket: { remoteAddress: '8.8.4.4' } } as unknown as http.IncomingMessage;
  rl.consumeIp('ip', ipReq);
  rl.consumeIp('ip', ipReq);
  const limited = throws(() => rl.consumeIp('ip', ipReq));
  check(
    'consumeIp: env-tunable limit answers 429 rate_limited with Retry-After',
    limited instanceof errors.PublicError && limited.status === 429 && limited.code === 'rate_limited' && (limited.retryAfterSec ?? 0) >= 1,
  );
  const mapped429 = errors.toPublicError(limited);
  check('429 maps to the stable body', mapped429.status === 429 && mapped429.body.code === 'rate_limited' && typeof mapped429.body.error === 'string' && mapped429.retryAfterSec !== undefined);
  const otherIp = { headers: {}, socket: { remoteAddress: '8.8.8.8' } } as unknown as http.IncomingMessage;
  check('consumeIp: a different client keeps its own budget', throws(() => rl.consumeIp('ip', otherIp)) === null);
  delete process.env.RATE_IP_PER_MIN;

  // Private peer without TRUST_PROXY: every client looks like the proxy, so the IP bucket is skipped (not a site-wide throttle).
  rl.resetLimitersForTests();
  process.env.RATE_IP_PER_MIN = '1';
  const proxied = { headers: {}, socket: { remoteAddress: '100.64.0.7' } } as unknown as http.IncomingMessage;
  check('consumeIp: private peer and no TRUST_PROXY is not throttled as one user', [1, 2, 3].every(() => throws(() => rl.consumeIp('ip', proxied)) === null));
  delete process.env.RATE_IP_PER_MIN;
  rl.resetLimitersForTests();

  // Per-user run cap.
  rl.resetLimitersForTests();
  const s1 = rl.acquireRunSlot('user-1');
  const s2 = rl.acquireRunSlot('user-1');
  const third = throws(() => rl.acquireRunSlot('user-1'));
  check('run cap: 3rd concurrent run refused with too_many_runs (429)', third instanceof errors.PublicError && third.code === 'too_many_runs' && third.status === 429);
  check('run cap: another user is unaffected', throws(() => rl.acquireRunSlot('user-2')) === null);
  s1();
  check('run cap: finishing a run frees a slot', throws(() => rl.acquireRunSlot('user-1')) === null);
  s2();

  // Client IP derivation.
  const fwd = (xff: string | undefined, remote: string) =>
    ({ headers: xff === undefined ? {} : { 'x-forwarded-for': xff }, socket: { remoteAddress: remote } }) as unknown as http.IncomingMessage;
  check('clientIp: socket address by default', rl.clientIp(fwd('1.2.3.4', '203.0.113.9'), {}).ip === '203.0.113.9');
  check('clientIp: spoofed X-Forwarded-For ignored without TRUST_PROXY', rl.clientIp(fwd('9.9.9.9', '203.0.113.9'), { TRUST_PROXY: '' }).ip === '203.0.113.9');
  check('clientIp: TRUST_PROXY=1 takes the rightmost entry (cannot be spoofed from the left)', rl.clientIp(fwd('6.6.6.6, 198.51.100.4', '10.0.0.2'), { TRUST_PROXY: '1' }).ip === '198.51.100.4');
  check('clientIp: TRUST_PROXY=2 skips one more hop', rl.clientIp(fwd('6.6.6.6, 198.51.100.4, 104.16.0.1', '10.0.0.2'), { TRUST_PROXY: '2' }).ip === '198.51.100.4');
  check('clientIp: malformed header falls back to the socket', rl.clientIp(fwd('not-an-ip', '203.0.113.9'), { TRUST_PROXY: '1' }).ip === '203.0.113.9');
  check('clientIp: ::ffff: prefix normalized', rl.clientIp(fwd(undefined, '::ffff:203.0.113.9'), {}).ip === '203.0.113.9');
  check('trustedProxyHops parsing', rl.trustedProxyHops({ TRUST_PROXY: '1' }) === 1 && rl.trustedProxyHops({ TRUST_PROXY: '2' }) === 2 && rl.trustedProxyHops({ TRUST_PROXY: 'true' }) === 1 && rl.trustedProxyHops({ TRUST_PROXY: '0' }) === 0 && rl.trustedProxyHops({}) === 0);

  // ---- 3. access mode (H4, L4) ----------------------------------------------
  const prodNoKey = throws(() => access.assertAuthConfigured({ NODE_ENV: 'production' }));
  check('startup: production without SUPABASE_ANON_KEY refuses to start', prodNoKey instanceof Error && /SUPABASE_ANON_KEY/.test(prodNoKey.message));
  check('startup: Railway without the key also refuses', throws(() => access.assertAuthConfigured({ RAILWAY_ENVIRONMENT: 'production' })) instanceof Error);
  check('startup: production with the key starts', throws(() => access.assertAuthConfigured({ NODE_ENV: 'production', SUPABASE_ANON_KEY: 'k' })) === null);
  check('startup: ALLOW_OPEN_ACCESS=1 is the explicit opt-out', throws(() => access.assertAuthConfigured({ NODE_ENV: 'production', ALLOW_OPEN_ACCESS: '1' })) === null);
  check('startup: ALLOW_OPEN_ACCESS=true is NOT accepted (exactly 1)', throws(() => access.assertAuthConfigured({ NODE_ENV: 'production', ALLOW_OPEN_ACCESS: 'true' })) instanceof Error);
  check('startup: development without the key is fine', throws(() => access.assertAuthConfigured({ NODE_ENV: 'development' })) === null);
  check('bind: development binds to loopback', access.bindHost({ NODE_ENV: 'development' }) === '127.0.0.1');
  check('bind: HOST overrides', access.bindHost({ HOST: '0.0.0.0' }) === '0.0.0.0');
  check('bind: production keeps the default (platform proxy must reach it)', access.bindHost({ NODE_ENV: 'production' }) === undefined);

  const mk = (remote: string | undefined, headers: Record<string, string>) =>
    ({ headers, socket: { remoteAddress: remote } }) as unknown as http.IncomingMessage;
  const dev: Record<string, string> = { NODE_ENV: 'development' };
  const loc = (remote: string | undefined, headers: Record<string, string>, env: Record<string, string> = dev) => access.isLocalRequest(mk(remote, headers), env);
  check('local: loopback socket + localhost Host', loc('127.0.0.1', { host: 'localhost:8787' }));
  check('local: ::1 socket + [::1] Host', loc('::1', { host: '[::1]:8787' }));
  check('local: ::ffff:127.0.0.1 socket', loc('::ffff:127.0.0.1', { host: '127.0.0.1:8787' }));
  check('local: spoofed Host from a REMOTE socket is not local', !loc('203.0.113.5', { host: 'localhost:8787' }));
  check('local: LAN client with Host localhost is not local', !loc('192.168.1.20', { host: 'localhost' }));
  check('local: DNS rebinding (loopback socket, attacker Host) is not local', !loc('127.0.0.1', { host: 'evil.example:8787' }));
  check('local: reverse proxy on the same host (X-Forwarded-For) is not local', !loc('127.0.0.1', { host: 'localhost', 'x-forwarded-for': '203.0.113.5' }));
  check('local: cross-site Origin is not local', !loc('127.0.0.1', { host: 'localhost:8787', origin: 'https://evil.example' }));
  check('local: opaque null Origin is not local', !loc('127.0.0.1', { host: 'localhost:8787', origin: 'null' }));
  check('local: same-origin Origin is local', loc('127.0.0.1', { host: 'localhost:8787', origin: 'http://localhost:8787' }));
  check('local: no socket address is not local', !loc(undefined, { host: 'localhost' }));
  check('local: production is never local', !loc('127.0.0.1', { host: 'localhost' }, { NODE_ENV: 'production' }));
  check('local: Railway is never local', !loc('127.0.0.1', { host: 'localhost' }, { NODE_ENV: 'development', RAILWAY_ENVIRONMENT: 'production' }));
  const open = (remote: string, headers: Record<string, string>, env: Record<string, string> = dev) =>
    access.refuseOpenModeRequest(mk(remote, headers), false, env);
  check('open mode: loopback request served', !open('127.0.0.1', { host: 'localhost:8787' }));
  check('open mode: remote request refused', open('203.0.113.5', { host: 'localhost:8787' }));
  check('open mode: cross-site page refused', open('127.0.0.1', { host: 'localhost:8787', origin: 'https://evil.example' }));
  check('open mode: HOST set on purpose allows other clients', !open('203.0.113.5', { host: 'dev.lan' }, { NODE_ENV: 'development', HOST: '0.0.0.0' }));
  check('open mode: authed servers are never refused here', !access.refuseOpenModeRequest(mk('203.0.113.5', { host: 'x' }), true, dev));

  // ---- 4. thesis + request validation (M6, QA) ------------------------------
  const goodThesis = {
    title: 'US chip supply buildout',
    stance: 'bullish',
    summary: 'Reshoring semiconductor supply chains.',
    intent: 'thematic',
    direction: 'long',
    anchors: ['TSM'],
    private_entities: [{ name: 'Acme', note: 'private' }],
    avoid: [],
    themes: ['semiconductors', 'reshoring'],
    strategies: ['equipment makers'],
    docCrit: { constrained: true, asset_set: ['stock'], risk: null },
  };
  const okParsed = throws(() => validate.parseClientThesis(goodThesis));
  check('thesis: a normal server-produced thesis passes', !(okParsed instanceof Error));
  const t = validate.parseClientThesis(goodThesis);
  check('thesis: explicit nulls are treated as absent', t.docCrit.risk === undefined && t.docCrit.asset_set?.[0] === 'stock');
  check('thesis: unknown keys are stripped', !('evil' in validate.parseClientThesis({ ...goodThesis, evil: 'x' })));
  const bad = (patch: Record<string, unknown>) => throws(() => validate.parseClientThesis({ ...goodThesis, ...patch }));
  const is400 = (e: unknown) => e instanceof errors.PublicError && e.status === 400 && e.code === 'bad_request';
  // e2e R4: the server's own output is never refused for its LENGTH: over-long
  // fields are cut to the caps; wrong types are still a 400.
  check('thesis: oversized summary is cut to 8000, not rejected', validate.parseClientThesis({ ...goodThesis, summary: 'x'.repeat(8001) }).summary.length === 8000);
  check('thesis: summary at the cap accepted', !(bad({ summary: 'x'.repeat(8000) }) instanceof Error));
  check('thesis: empty summary rejected', is400(bad({ summary: '' })));
  check('thesis: non-string summary rejected', is400(bad({ summary: { a: 1 } })));
  check('thesis: invalid direction rejected', is400(bad({ direction: 'sideways' })));
  check('thesis: direction both accepted', !(bad({ direction: 'both' }) instanceof Error));
  check('thesis: too many anchors are cut to 25', validate.parseClientThesis({ ...goodThesis, anchors: Array.from({ length: 26 }, (_, i) => `T${i}`) }).anchors.length === 25);
  check('thesis: an over-long anchor is cut to 64', validate.parseClientThesis({ ...goodThesis, anchors: ['x'.repeat(65)] }).anchors[0]!.length === 64);
  check('thesis: too many themes are cut to 20', validate.parseClientThesis({ ...goodThesis, themes: Array.from({ length: 21 }, (_, i) => `t${i}`) }).themes.length === 20);
  check('thesis: an over-long theme is cut to 160', validate.parseClientThesis({ ...goodThesis, themes: ['x'.repeat(161)] }).themes[0]!.length === 160);
  check('thesis: non-array anchors rejected', is400(bad({ anchors: 'TSM' })));
  check('thesis: non-string array element rejected', is400(bad({ themes: [1, 2] })));
  check('thesis: bad docCrit type rejected', is400(bad({ docCrit: { asset_set: 'stock' } })));
  const strat = validate.parseClientThesis({ ...goodThesis, strategies: ['  a  ', 'x'.repeat(100), '', 'b', 'c', 'd', 'e', 'f'] });
  check('thesis: strategies trimmed to <= 5 chips of <= 60 chars (as before)', strat.strategies.length === 5 && strat.strategies.every((s) => s.length <= 60) && strat.strategies[0] === 'a');
  check('thesis: non-object rejected', is400(throws(() => validate.parseClientThesis('hello'))));
  check('thesis: error does not echo the submitted value', !/xxxxx/.test((bad({ direction: 'xxxxxsideways' }) as Error).message));

  const screen = (b: unknown) => validate.V1ScreenBody.safeParse(b);
  check('screen: valid body accepted', screen({ thesis: 'AI power demand', constraints: { assets: ['stock'], regions: ['us'], caps: ['mega'], universe: 'robinhood' }, breadth: 'diversified' }).success);
  check('screen: regions ["mars"] rejected before any charge', !screen({ thesis: 'AI power demand', constraints: { regions: ['mars'] } }).success);
  check('screen: unknown asset kind rejected', !screen({ thesis: 'AI power demand', constraints: { assets: ['nft'] } }).success);
  check('screen: assets given as a string rejected', !screen({ thesis: 'AI power demand', constraints: { assets: 'stock' } }).success);
  check('screen: thesis as an object rejected', !screen({ thesis: { a: 1 } }).success);
  check('screen: unknown top-level universe rejected', !screen({ thesis: 'AI power demand', universe: 'nasdaq' }).success);
  check('screen: bad breadth rejected', !screen({ thesis: 'AI power demand', breadth: 'wide' }).success);
  const badScreen = throws(() => validate.parseOr400(validate.V1ScreenBody, { thesis: 'x', constraints: { regions: ['mars'] } }, 'request'));
  check('screen: 400 message names the field and the allowed values, not the input', is400(badScreen) && /regions/.test((badScreen as Error).message) && /us/.test((badScreen as Error).message) && !/mars/.test((badScreen as Error).message), (badScreen as Error).message);
  check('requireObject: null is a 400, not a TypeError', is400(throws(() => validate.requireObject(null))));
  check('requireObject: arrays and primitives are a 400', is400(throws(() => validate.requireObject([]))) && is400(throws(() => validate.requireObject(5))));
  check('requireObject: objects pass', throws(() => validate.requireObject({ a: 1 })) === null);
  check(
    'enums stay in sync with the universe registry',
    JSON.stringify([...validate.UNIVERSE_NAMES].sort()) === JSON.stringify(Object.keys(universe.UNIVERSES).sort()),
  );

  // ---- 5. error mapping (M4) ------------------------------------------------
  const leaks = [
    'OpenRouter API 402: {"error":"insufficient credits on key sk-or-v1-abc"}',
    'voyage query embed HTTP 401: invalid api key pa-secretvalue',
    'profiles read failed: column "daily_cap" of relation "profiles" does not exist',
    'api_keys insert failed: duplicate key value violates unique constraint "api_keys_pkey"',
    'connect ECONNREFUSED 10.0.0.5:5432',
    'fetch failed',
  ];
  for (const raw of leaks) {
    const m = errors.toPublicError(new Error(raw));
    const text = JSON.stringify(m.body);
    check(
      `error mapping hides upstream detail: ${raw.slice(0, 32)}...`,
      !/sk-or|pa-secret|daily_cap|profiles|api_keys|10\.0\.0\.5|OpenRouter|voyage|relation|constraint/i.test(text) && ['upstream_unavailable', 'internal_error'].includes(m.body.code),
      text,
    );
  }
  const passThrough = errors.toPublicError(new errors.PublicError(422, 'source_unreadable', 'Could not read that link.'));
  check('PublicError passes through unchanged', passThrough.status === 422 && passThrough.body.code === 'source_unreadable' && passThrough.body.error === 'Could not read that link.');
  const ise = errors.toPublicError(new TypeError("Cannot read properties of undefined (reading 'x')"));
  check('unknown errors become a generic 500 internal_error', ise.status === 500 && ise.body.code === 'internal_error' && !/undefined/.test(ise.body.error));
  const up = errors.toPublicError(new Error('OpenRouter API 429: rate limited'));
  check('upstream failures are 502 upstream_unavailable', up.status === 502 && up.body.code === 'upstream_unavailable');
  const runFail = errors.runFailureMessage(new Error('profiles read failed: boom'));
  check('run failure message is curated with a stable code', runFail.code === 'run_failed' && !/profiles|boom/.test(runFail.message));
  const runUp = errors.runFailureMessage(new Error('OpenRouter API 500: kaboom'));
  check('run failure from an upstream names no vendor', runUp.code === 'upstream_unavailable' && !/openrouter|kaboom/i.test(runUp.message));
  const noDashes = [passThrough.body.error, ise.body.error, up.body.error, runFail.message, rl.RATE_LIMITED_MESSAGE].every((m) => !/[–—]/.test(m));
  check('error copy contains no em or en dashes', noDashes);

  // ---- 6. X link state secret (L1) ------------------------------------------
  const k1 = xlink.stateSecretFrom({ X_STATE_SECRET: 'one', SUPABASE_SERVICE_KEY: 'svc' });
  const k2 = xlink.stateSecretFrom({ X_STATE_SECRET: 'two', SUPABASE_SERVICE_KEY: 'svc' });
  const kSvc = xlink.stateSecretFrom({ SUPABASE_SERVICE_KEY: 'svc' });
  check('state secret: dedicated secret is used and differs from the service-key derivation', !k1.equals(k2) && !k1.equals(kSvc));
  check('state secret: dev falls back to the service-key derivation', kSvc.equals(xlink.stateSecretFrom({ SUPABASE_SERVICE_KEY: 'svc', NODE_ENV: 'development' })));
  // e2e P1-b: production without X_STATE_SECRET keeps X linking working with an
  // HKDF key derived from the service key (never the raw key itself).
  const kProd = throws(() => xlink.stateSecretFrom({ NODE_ENV: 'production', SUPABASE_SERVICE_KEY: 'svc' }));
  check('state secret: production without X_STATE_SECRET derives an HKDF key (no 503)', kProd === null && xlink.stateSecretFrom({ NODE_ENV: 'production', SUPABASE_SERVICE_KEY: 'svc' }).equals(kSvc) && !kSvc.equals(Buffer.from('svc')));
  check('state secret: Railway without X_STATE_SECRET derives it too', throws(() => xlink.stateSecretFrom({ RAILWAY_ENVIRONMENT: 'production', SUPABASE_SERVICE_KEY: 'svc' })) === null);
  check('state secret: production with X_STATE_SECRET works', throws(() => xlink.stateSecretFrom({ NODE_ENV: 'production', X_STATE_SECRET: 'z' })) === null);

  // ---- 7. bot content filter (M7), short copy of the full suite in test-bot.ts
  check('bot filter: URL rejected', reply.replyRejection('BTC on the radar https://evil.example') === 'url');
  check('bot filter: unlisted mention rejected', reply.replyRejection('thanks @someone') === 'mention');
  check('bot filter: two cashtags rejected', reply.replyRejection('$BTC and $ETH') === 'cashtags');
  check('bot filter: blocklist rejected', reply.replyRejection('claim now, free money') === 'blocklist');
  check('bot filter: clean data reply passes', reply.replyRejection('For chips, TSM 402.30 USD (+1.0%) is worth watching.') === null);

  // ---- 8. re-audit regressions -----------------------------------------------
  const here = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
  const timed = <T,>(fn: () => T): { ms: number; out: T } => {
    const t0 = performance.now();
    const out = fn();
    return { ms: performance.now() - t0, out };
  };

  // N1: HTML extraction must be linear. 2 MB adversarial pages used to take minutes.
  const MB2 = extract.MAX_PAGE_BYTES;
  const rep = (u: string) => u.repeat(Math.ceil(MB2 / u.length)).slice(0, MB2);
  const adversarial: Record<string, string> = {
    '<div  (no ">")': rep('<div '),
    '<article  (no ">")': rep('<article '),
    '<script without end': rep('<script'),
    '<script> without end': rep('<script>'),
    '<style without end': rep('<style'),
    '<!-- without end': rep('<!--'),
    'run of "<"': '<'.repeat(MB2),
    '"x<" run': rep('x<'),
    'attribute run': `<div class="${rep('a="b" ')}`,
    '<title  (no ">")': rep('<title '),
    '<title> without end': rep('<title>'),
    '<nav> without end': rep('<nav>'),
    '<form  (no ">")': rep('<form '),
    '<main> without end': rep('<main>'),
    'content div, no ">"': rep('<div class="article-body" '),
    'content div opens': rep('<div class="article-body">'),
    'nested divs in one tag': rep('<div <div <div <div <div <div class="x"> '),
    'long attribute values': rep(`<div id="${'a'.repeat(1900)}"> `),
    'whitespace run': ' '.repeat(MB2) + '<',
    '"<br " run': rep('<br '),
    '"</div>" run': rep('</div>'),
  };
  let slowest = { name: '', ms: 0 };
  for (const [name, html] of Object.entries(adversarial)) {
    const { ms } = timed(() => {
      extract.extractTitle(html);
      return extract.stripHtml(extract.extractMainHtml(html));
    });
    if (ms > slowest.ms) slowest = { name, ms };
    check(`N1 linear-time HTML (2 MB): ${name}`, ms < 750, `${Math.round(ms)} ms`);
  }
  log.info(`N1 slowest adversarial page: ${slowest.name} ${Math.round(slowest.ms)} ms`);

  // Equivalence with the old regex behaviour on ordinary pages.
  const para = `<p>${'Lorem ipsum dolor sit amet. '.repeat(40)}</p>`;
  check('N1 stripHtml: script and style removed, entities decoded, blocks become lines', extract.stripHtml('<style>p{}</style><script>var a="<p>";</script><p>a &amp; b &lt;c&gt;</p><p>two</p>') === 'a & b <c>\n two');
  check('N1 stripHtml: tag names are case-insensitive; "<>" and a "<" with no later ">" survive as text', extract.stripHtml('x <> y <SCRIPT>x</SCRIPT><b>bold</b>') === 'x <> y bold' && extract.stripHtml('a < b') === 'a < b');
  check('N1 stripHtml: <br> becomes a newline', extract.stripHtml('one<br/>two<br>three') === 'one\ntwo\nthree');
  check('N1 stripHtml: an unterminated script is left as text, as before', extract.stripHtml('<script>keep <p>this</p>') === 'keep this');
  check('N1 extractTitle: first title, trimmed; none when absent or unclosed', extract.extractTitle('<head><title>  Hello  </title></head><title>x</title>') === 'Hello' && extract.extractTitle('<p>x</p>') === undefined && extract.extractTitle('<title>open') === undefined);
  const mainOf = (html: string) => extract.stripHtml(extract.extractMainHtml(html));
  check('N1 extractMainHtml: prefers <article> and drops nav/footer', mainOf(`<nav>MENU</nav><article>${para}</article><footer>FOOT</footer>`).startsWith('Lorem ipsum') && !/MENU|FOOT/.test(mainOf(`<nav>MENU</nav><article>${para}</article><footer>FOOT</footer>`)));
  check('N1 extractMainHtml: falls back to <main>, then to a content div', mainOf(`<aside>SIDE</aside><main>${para}</main>`).startsWith('Lorem') && mainOf(`<div class="entry-content">${para}</div><div>TAIL</div>`).startsWith('Lorem'));
  check('N1 extractMainHtml: a stub container falls back to the whole page', mainOf('<article>tiny</article><p>the rest of the page</p>').includes('the rest of the page'));
  check('N1 extractMainHtml: comments and an unterminated <nav> behave as before', !mainOf('<!-- secret --><p>shown</p>').includes('secret') && mainOf('<nav>unclosed <p>keep</p>').includes('keep'));

  // Other user-text regexes found quadratic in the same sweep.
  const N40 = 40_000;
  const t1 = timed(() => reply.replyRejection('a.'.repeat(N40)));
  check('N1 bot URL filter is linear on "a." runs', t1.ms < 500, `${Math.round(t1.ms)} ms`);
  const t2 = timed(() => thesisMod.similarReferenceMentions(`companies similar to ${'('.repeat(80)} and ${'and '.repeat(N40)}`));
  check('N1 similar-to mention parsing is linear on hostile text', t2.ms < 500, `${Math.round(t2.ms)} ms`);
  check('stripLeadingMentions still strips every leading @mention', reply.stripLeadingMentions('  @a @b   hello @c') === 'hello @c');

  // N2: finReq caps.
  const bigReq = {
    bounds: Array.from({ length: 5000 }, (_, i) => ({ key: i % 2 ? 'pe' : 'beta', min: i, max: null })),
    exposures: Array.from({ length: 5000 }, (_, i) => ({ kind: 'sector', name: `Sector ${i} ${'x'.repeat(500)}`, minWeightPct: 50 })),
    currencies: Array.from({ length: 5000 }, () => 'USD'),
    domiciles: Array.from({ length: 5000 }, (_, i) => `D${i % 100}`.slice(0, 2).padEnd(2, 'X')),
    unverifiable: Array.from({ length: 5000 }, () => 'y'.repeat(5000)),
    evil: 'drop me',
  };
  const capped2 = finreq.sanitizeFinReq(bigReq)!;
  check('N2 sanitizeFinReq: at most 12 exposures with capped names', capped2.exposures.length === 12 && capped2.exposures.every((e) => e.name.length <= 40));
  check('N2 sanitizeFinReq: bounds are unique per metric and at most 12', capped2.bounds.length === 2 && new Set(capped2.bounds.map((b) => b.key)).size === 2);
  check('N2 sanitizeFinReq: code lists, unverifiable and unknown keys are capped or dropped', capped2.currencies.length <= 12 && capped2.domiciles.length <= 12 && capped2.unverifiable.length <= 8 && capped2.unverifiable.every((x) => x.length <= 120) && !('evil' in capped2));
  check('N2 sanitizeFinReq: serialised size stays small', JSON.stringify(capped2).length < 4000, `${JSON.stringify(capped2).length} bytes`);
  const manyKeys = { bounds: Object.keys(finreq.SPECS).map((key) => ({ key, min: 1, max: null })) };
  check('N2 sanitizeFinReq: never more than 12 bounds even with every metric', finreq.sanitizeFinReq(manyKeys)!.bounds.length === 12);
  const review = { bounds: [{ key: 'ter_pct', min: null, max: 0.3 }, { key: 'aum_usd', min: 200_000_000, max: null }], exposures: [{ kind: 'sector', name: 'Technology', minWeightPct: 60 }], currencies: ['USD', 'EUR'], domiciles: ['IE'], unverifiable: ['no ESG filter available'] };
  const roundTrip = finreq.sanitizeFinReq(validate.ClientFinReqSchema.parse(review))!;
  check('N2 a normal review-card payload passes the schema and survives sanitising unchanged', JSON.stringify(roundTrip) === JSON.stringify(review), JSON.stringify(roundTrip));
  check('N2 schema: oversized lists are cut to 100 (e2e R4), wrong types still fail', validate.ClientFinReqSchema.parse({ bounds: Array.from({ length: 101 }, () => ({ key: 'pe' })) }).bounds?.length === 100 && !validate.ClientFinReqSchema.safeParse({ bounds: 'pe' }).success && !validate.ClientFinReqSchema.safeParse({ exposures: [{ kind: 5, name: 'x' }] }).success);
  check('N2 schema: unknown keys stripped, nulls and empty object accepted', !('evil' in validate.ClientFinReqSchema.parse({ evil: 1 })) && validate.ClientFinReqSchema.safeParse({ bounds: null, currencies: null }).success);

  // N3: a key with no credit must not reach an LLM call.
  const peekWith = (credits: number) => (async () => ({ ok: true, credits, cap: 10 })) as unknown as Parameters<typeof run.assertCreditAvailable>[1];
  const usr = { id: 'u1', email: 'u@example.com' } as Parameters<typeof run.assertCreditAvailable>[0];
  const zero = await run.assertCreditAvailable(usr, peekWith(0)).then(() => null, (e) => e);
  check('N3 zero credits: OutOfCreditsError before any thesis call', zero instanceof run.OutOfCreditsError && zero.credits === 0 && zero.cap === 10);
  check('N3 one credit: allowed', (await run.assertCreditAvailable(usr, peekWith(1)).then(() => 'ok', () => 'blocked')) === 'ok');
  let peeked = false;
  await run.assertCreditAvailable(null, (async () => { peeked = true; return { ok: true, credits: 0, cap: 0 }; }) as never);
  check('N3 auth-off (no user): no peek, no block', !peeked);
  // Final audit L4 supersedes the peek: both now CHARGE before the thesis call.
  const orderOk = (src: string, from: string) => {
    const body = src.slice(src.indexOf(from));
    const a = body.indexOf('chargeFirst(');
    const b = body.indexOf('buildScreenInput(');
    return a > 0 && b > 0 && a < b;
  };
  check('N3/L4 /v1/screen charges before buildScreenInput', orderOk(here('../server/server.ts'), 'async function handleV1Screen'));
  check('N3/L4 MCP run_screen charges before buildScreenInput', orderOk(here('../server/mcp.ts'), "'run_screen'"));
  const assetsSrc = here('../server/server.ts');
  const assetsBody = assetsSrc.slice(assetsSrc.indexOf('async function handleV1Assets'));
  check('N3 /v1/assets charges before any extraction or LLM call', assetsBody.indexOf("spendCredit(user.id, 1, 'search')") < assetsBody.indexOf('extractLink(') && assetsBody.indexOf("spendCredit(user.id, 1, 'search')") < assetsBody.indexOf('assetsFromContent('));

  // N5: per-IP limiter.
  check('N5 IPv6 buckets are keyed by /64', rl.ipBucketKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd') === rl.ipBucketKey('2001:db8:1:2::1') && rl.ipBucketKey('2001:db8:1:2::1') !== rl.ipBucketKey('2001:db8:1:3::1'), rl.ipBucketKey('2001:db8:1:2::1'));
  check('N5 IPv4 and unparseable keys are unchanged; uppercase and compression normalise', rl.ipBucketKey('203.0.113.9') === '203.0.113.9' && rl.ipBucketKey('2001:DB8:0:0:0:0:0:1') === rl.ipBucketKey('2001:db8::1'));
  rl.resetLimitersForTests();
  process.env.RATE_IP_PER_MIN = '2';
  const v6req = (addr: string) => ({ headers: {}, socket: { remoteAddress: addr } }) as unknown as http.IncomingMessage;
  rl.consumeIp('ip', v6req('2606:4700:1:2::1'));
  rl.consumeIp('ip', v6req('2606:4700:1:2::2'));
  check('N5 rotating addresses inside one /64 share one budget', throws(() => rl.consumeIp('ip', v6req('2606:4700:1:2:ffff::9'))) instanceof errors.PublicError);
  check('N5 ...a different /64 has its own', throws(() => rl.consumeIp('ip', v6req('2606:4700:1:3::1'))) === null);
  delete process.env.RATE_IP_PER_MIN;
  rl.resetLimitersForTests();
  let tNow = 5_000_000;
  const flood = new rl.TokenBucketLimiter(2, 60_000, () => tNow, 100);
  flood.take('victim');
  flood.take('victim');
  check('N5 victim is throttled before the flood', !flood.take('victim').ok);
  for (let i = 0; i < 1000; i++) {
    tNow += 5;
    flood.take(`attacker-${i}`);
  }
  check('N5 a flood of new keys does not reset an active throttle', !flood.take('victim').ok);
  tNow += 61_000;
  flood.take('late');
  for (let i = 0; i < 1000; i++) flood.take(`idle-${i}`);
  tNow += 61_000;
  flood.take('trigger');
  check('N5 idle buckets are reclaimed so the map stays bounded', flood.size <= 101, `size ${flood.size}`);
  const warned: string[] = [];
  rl.warnIfTrustProxyUnset({}, (m) => warned.push(m), true);
  rl.warnIfTrustProxyUnset({ TRUST_PROXY: '1' }, (m) => warned.push(m), true);
  rl.warnIfTrustProxyUnset({}, (m) => warned.push(m), false);
  check('N5 boot warning: once, names TRUST_PROXY, only when deployed without it', warned.length === 1 && /TRUST_PROXY/.test(warned[0]!), warned[0]?.slice(0, 40));
  rl.resetSharedIpWarningForTests();
  process.env.RATE_IP_PER_MIN = '1';
  const warnLines: string[] = [];
  const lan = { headers: {}, socket: { remoteAddress: '10.1.2.3' } } as unknown as http.IncomingMessage;
  rl.consumeIp('ip', lan, (m) => warnLines.push(m));
  rl.consumeIp('ip', lan, (m) => warnLines.push(m));
  rl.consumeIp('ip', { headers: {}, socket: { remoteAddress: '127.0.0.1' } } as unknown as http.IncomingMessage, (m) => warnLines.push(m));
  check('N5 private peer without TRUST_PROXY: still unlimited, one warning', warnLines.length === 1 && /TRUST_PROXY/.test(warnLines[0]!));
  rl.resetSharedIpWarningForTests();
  const loopWarn: string[] = [];
  rl.consumeIp('ip', { headers: {}, socket: { remoteAddress: '127.0.0.1' } } as unknown as http.IncomingMessage, (m) => loopWarn.push(m));
  check('N5 loopback development stays silent and unlimited', loopWarn.length === 0 || process.env.NODE_ENV === 'production');
  delete process.env.RATE_IP_PER_MIN;
  rl.resetLimitersForTests();
  rl.resetSharedIpWarningForTests();

  // N6 / N7: more SSRF.
  for (const u of ['http://localhost../', 'http://localhost.../x', 'http://foo.localhost../', 'http://metadata.google.internal../', 'http://127.0.0.1../', 'http://printer.local../']) {
    check(`N6 url blocked: ${u}`, throws(() => extract.assertPublicHttpUrl(u)) instanceof errors.PublicError);
  }
  check('N6 a normal absolute name with a trailing dot is still allowed', extract.assertPublicHttpUrl('https://example.com./a').hostname === 'example.com.');
  check('N7 IP literals are checked like resolved addresses', ['127.0.0.1', '[::1]', '169.254.169.254', '10.0.0.5', '[::ffff:7f00:1]'].every((h) => throws(() => net.assertPublicLiteralHost(h)) instanceof net.BlockedAddressError) && throws(() => net.assertPublicLiteralHost('8.8.8.8')) === null && throws(() => net.assertPublicLiteralHost('example.com')) === null);
  // Live: the lookup hook is skipped for literals; the connect-time check still refuses.
  let hits = 0;
  const srv = http.createServer((_req, resp) => {
    hits += 1;
    resp.end('internal');
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as { port: number }).port;
  const peerErr = await new Promise<Error | null>((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, lookup: net.safeLookup as never }, () => resolve(null));
    net.refuseNonPublicPeer(req);
    req.on('error', (e) => resolve(e));
    req.end();
  });
  await new Promise((r) => setTimeout(r, 50));
  srv.close();
  check('N7 socket-level check refuses a literal private peer even though the lookup hook never ran', peerErr instanceof net.BlockedAddressError, peerErr?.name);
  check('N7 ...before the internal server answers anything', hits === 0, `${hits} request(s) reached it`);

  // M7: the blocklist cannot be dodged with spacing, leetspeak, accents or invisible characters.
  const evaded = ['free a1rdrop here', 'a i r d r o p today', 'A.I.R.D.R.O.P', 'air drop soon', 'airdr​op', 'áirdrop', 'G1VEAWAY time', 'g i v e a w a y', 'claim n0w', 'gu4rant33d returns', 'tele gram group', 'аirdrop' /* cyrillic a */, 'sеnd me' /* cyrillic e */, 'd m  m e', '1000x', '1 0 0 0 x', 'FREE M0NEY'];
  for (const d of evaded) check(`M7 evasion caught: ${JSON.stringify(d)}`, reply.replyRejection(d) === 'blocklist', String(reply.replyRejection(d)));
  const clean = ['For chips, TSM 402.30 USD (+1.0%) is worth watching.', 'ADM 54.10 USD (-0.4%) and the energy names', 'Gold, silver and BTC are in the data: GLD 410.20 USD.', 'Margins improved 12% year over year; ASML.AS 905 EUR.'];
  for (const d of clean) check(`M7 no false positive: ${JSON.stringify(d.slice(0, 40))}`, reply.replyRejection(d, { knownTickers: ['ASML.AS'] }) === null, String(reply.replyRejection(d, { knownTickers: ['ASML.AS'] })));
  check('M7 normaliser folds case, leetspeak and invisibles', reply.normalizeForBlocklist('A1RDR0P​') === 'airdrop');
  check('M7 word boundaries still hold after normalising', reply.replyRejection('Guaranteeing nothing, ETH at 3,100 is worth watching.') === null && reply.replyRejection('ADM USD 54 and ADM US peers') === null);

  // L10: worker logs carry ids and lengths, not emails or reply text.
  const workerSrc = here('../bot/worker.ts');
  check('L10 bot worker never logs user.email or the reply body', !/log\.\w+\([^;]*user\.email/.test(workerSrc) && !/log\.\w+\([^;]*\$\{reply\}/.test(workerSrc));

  // L1: X link state is single use within its TTL.
  const st = xlink.signState('user-9', 'verifier-9');
  check('L1 first presentation of a valid state is accepted', xlink.verifyState(st) !== null && xlink.consumeStateOnce(st) === true);
  check('L1 replaying the same state is refused', xlink.consumeStateOnce(st) === false);
  const st2 = xlink.signState('user-9', 'verifier-10');
  check('L1 a different state is independent', xlink.consumeStateOnce(st2) === true);
  const manyStates = Array.from({ length: 2500 }, (_, i) => xlink.signState('u', `v${i}`));
  for (const x of manyStates) xlink.consumeStateOnce(x);
  check('L1 the consumed-state map is bounded and recent states stay blocked', xlink.consumeStateOnce(manyStates[2499]!) === false);

  if (failures) {
    log.error(`${failures} CHECK(S) FAILED`);
    process.exit(1);
  }
  log.step('ALL SECURITY CHECKS PASSED');
}

main().catch((err) => {
  log.error('security gate crashed', err);
  process.exit(1);
});

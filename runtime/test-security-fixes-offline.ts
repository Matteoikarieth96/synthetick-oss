/**
 * Offline regression tests for the final security round (scratchpad reports
 * final-security.md H1, H2, M1-M3, L1, L3-L5, L7-L9, L12, L13, L16 and
 * final-e2e.md R1, R4, R5, P1-b). No network, no keys, no database: `fetch`
 * and the shared Supabase client's methods are replaced in-process, and the
 * only sockets opened are local test servers on 127.0.0.1.
 *   npx tsx runtime/test-security-fixes-offline.ts
 */
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, type Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, createGunzip, deflateSync, gzipSync } from 'node:zlib';

// The shared clients need these to construct; nothing is ever sent to them.
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'placeholder-service-key';
process.env.VOYAGE_KEY ||= 'placeholder';
// X linking configured WITHOUT X_STATE_SECRET (e2e P1-b): must keep working.
process.env.X_CLIENT_ID = 'offline-client';
process.env.X_REDIRECT_URL = 'https://example.invalid/api/x/callback';
delete process.env.X_STATE_SECRET;
for (const k of [
  'TRUST_PROXY',
  'RATE_LLM_PER_USER_DAY',
  'RATE_LLM_GLOBAL_PER_DAY',
  'REFUNDS_PER_USER_DAY',
  'EXTRACT_MAX_CONCURRENT',
  'EXTRACT_MAX_CONCURRENT_PER_USER',
  'SERVER_MAX_CONNECTIONS',
  'AUTH_PROVIDERS',
  'FFMPEG_PATH',
  'OPENROUTER_REFERER',
  'X_BOT_MENTION_TIMEOUT_SECONDS',
  'X_BOT_MAX_REPLIES_PER_DAY',
  'NODE_ENV',
  'RAILWAY_ENVIRONMENT',
  'HOST',
]) {
  delete process.env[k];
}

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const src = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${name}${detail ? `: ${detail}` : ''}`);
}
async function rejectsWith(p: Promise<unknown>, test: (e: unknown) => boolean): Promise<boolean> {
  try {
    await p;
    return false;
  } catch (e) {
    return test(e);
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
/** How a promise settles within `ms`: 'resolved', 'rejected' or still 'pending'. */
async function settleWithin(p: Promise<unknown>, ms: number): Promise<'resolved' | 'rejected' | 'pending'> {
  let timer: NodeJS.Timeout | undefined;
  const pending = new Promise<'pending'>((r) => (timer = setTimeout(() => r('pending'), ms)));
  const out = await Promise.race([p.then(() => 'resolved' as const, () => 'rejected' as const), pending]);
  clearTimeout(timer);
  return out;
}
const hasDash = (s: string) => /[–—]/.test(s);

const errors = await import('./errors.js');
const extract = await import('./extract.js');
const llm = await import('./llm.js');
const thesisMod = await import('./thesis.js');
const rl = await import('../server/ratelimit.js');
const auth = await import('../server/auth.js');
const access = await import('../server/access.js');
const validate = await import('../server/validate.js');
const xlink = await import('../server/xlink.js');
const cache = await import('../server/cache.js');
const hard = await import('../server/http-hardening.js');
const run = await import('../server/run.js');
const guards = await import('../bot/guards.js');
const reply = await import('../bot/reply.js');
const video = await import('../bot/video.js');
const { supabase } = await import('../ingest/lib/supabase.js');
const { withRunSignal, RunAbortedError } = await import('./runsignal.js');
type Thesis = import('./thesis.js').Thesis;

const realFetch = globalThis.fetch;
const sb = supabase as unknown as Record<string, unknown>;
const realFrom = sb.from;
const realRpc = sb.rpc;

/** A Supabase query-builder stand-in: every chain resolves to `rows`. */
function emptyTableClient(rows: unknown[] = []) {
  return () => {
    const chain: unknown = new Proxy(function () {}, {
      get(_t, prop) {
        if (prop === 'then') return (resolve: (v: unknown) => void) => resolve({ data: rows, error: null });
        return () => chain;
      },
    });
    return chain;
  };
}

// ==== H2: compressed bodies always settle =====================================
{
  const page = Buffer.from(`<html><title>T</title><body><p>${'hello world '.repeat(300)}</p></body></html>`);
  const gz = gzipSync(page);
  const decode = (enc: string, signal = new AbortController().signal) => {
    const res = new PassThrough();
    return { res, body: extract.decodedBody(res, enc, signal) };
  };

  const ok = decode('gzip');
  ok.res.end(gz);
  const whole = await extract.readCapped(ok.body);
  check('H2 decodedBody: a complete gzip body decodes', whole.text.includes('hello world') && !whole.truncated);

  for (const [enc, data] of [['gzip', gz], ['br', brotliCompressSync(page)], ['deflate', deflateSync(page)]] as const) {
    const ac = new AbortController();
    const stalled = decode(enc, ac.signal);
    stalled.res.write(data.subarray(0, 20)); // a partial body, then the upstream goes silent
    const reading = extract.readCapped(stalled.body);
    setTimeout(() => ac.abort(new Error('request timed out')), 50);
    check(`H2 decodedBody: a stalled ${enc} body settles when the request deadline fires`, (await settleWithin(reading, 2000)) === 'rejected');

    const reset = decode(enc);
    reset.res.write(data.subarray(0, 20));
    const reading2 = extract.readCapped(reset.body);
    setTimeout(() => reset.res.destroy(new Error('socket hang up')), 50);
    check(`H2 decodedBody: a ${enc} body reset mid-stream settles at once`, (await settleWithin(reading2, 2000)) === 'rejected');
  }

  const cut = decode('gzip');
  cut.res.end(gz.subarray(0, 30)); // truncated stream that ends "cleanly"
  check('H2 decodedBody: a truncated gzip body that ends is an error, not a hang', (await settleWithin(extract.readCapped(cut.body), 2000)) === 'rejected');

  const already = new AbortController();
  already.abort(new Error('gone'));
  const late = decode('gzip', already.signal);
  check('H2 decodedBody: a signal that already fired destroys the body', (await settleWithin(extract.readCapped(late.body), 1000)) === 'rejected');

  // Control: the old `res.pipe(createGunzip())` wiring hangs on the same input,
  // so the checks above would catch a regression.
  const oldRes = new PassThrough();
  oldRes.on('error', () => {}); // a real socket error has a listener; keep the test process up
  const oldBody: Readable = oldRes.pipe(createGunzip());
  oldBody.on('error', () => {});
  oldRes.write(gz.subarray(0, 20));
  const oldReading = extract.readCapped(oldBody);
  setTimeout(() => oldRes.destroy(new Error('socket hang up')), 20);
  check('H2 control: the old pipe() wiring never settles (the bug this guards)', (await settleWithin(oldReading, 400)) === 'pending');
  oldBody.destroy();
  await settleWithin(oldReading, 200);
}

// ==== H2: bot deadlines and exit guards =======================================
{
  let sawAbort = false;
  const never = guards.withDeadline(80, (signal) => {
    signal.addEventListener('abort', () => (sawAbort = true));
    return new Promise<string>(() => {});
  }, 'test mention');
  check(
    'H2 withDeadline: work that never settles is cut at the deadline',
    (await rejectsWith(never, (e) => e instanceof guards.DeadlineError)) && sawAbort,
  );
  check('H2 withDeadline: finished work returns its value', (await guards.withDeadline(1000, async () => 'done')) === 'done');
  check('H2 withDeadline: a thrown error passes through', await rejectsWith(guards.withDeadline(1000, async () => { throw new Error('boom'); }), (e) => (e as Error).message === 'boom'));
  const t = guards.mentionTimeouts({});
  check('H2 mention deadline defaults: 240 s per mention, 210 s for the charged work', t.mentionMs === 240_000 && t.workMs === 210_000);
  check('H2 mention deadline is bounded (60..900 s)', guards.mentionTimeouts({ X_BOT_MENTION_TIMEOUT_SECONDS: '5' }).mentionMs === 60_000 && guards.mentionTimeouts({ X_BOT_MENTION_TIMEOUT_SECONDS: '99999' }).mentionMs === 900_000);

  const proc = Object.assign(new EventEmitter(), { codes: [] as number[], exit(code?: number) { this.codes.push(code ?? 0); } });
  const logged: string[] = [];
  guards.installExitGuards(proc as never, { error: (m: string) => logged.push(m) });
  proc.emit('beforeExit', 0);
  proc.emit('uncaughtException', new Error('x'));
  proc.emit('unhandledRejection', new Error('y'));
  check('H2 exit guards: drained loop, uncaught error and unhandled rejection all exit 1', JSON.stringify(proc.codes) === '[1,1,1]' && logged.length === 3, JSON.stringify(proc.codes));

  // The real thing, in a child process: a pending promise with no handles
  // drains the event loop (what killed the bot with exit 0).
  const dir = mkdtempSync(join(tmpdir(), 'synthetick-exit-'));
  try {
    const guardsUrl = new URL('../bot/guards.ts', import.meta.url).href;
    // Shaped like bot/worker.ts: main() is started, not awaited at the top
    // level, and its only pending promise holds no handle.
    const script = (install: boolean) =>
      `const g = await import(${JSON.stringify(guardsUrl)});\n` +
      (install ? 'g.installExitGuards(process, { error: () => {} });\n' : '') +
      'async function main() { await new Promise(() => {}); }\n' +
      'main().then(() => process.exit(0), () => process.exit(2));\n';
    writeFileSync(join(dir, 'guarded.mts'), script(true));
    writeFileSync(join(dir, 'unguarded.mts'), script(false));
    const guarded = spawnSync('npx', ['tsx', join(dir, 'guarded.mts')], { encoding: 'utf8', timeout: 60_000 });
    const unguarded = spawnSync('npx', ['tsx', join(dir, 'unguarded.mts')], { encoding: 'utf8', timeout: 60_000 });
    check('H2 a drained worker process exits 1 (Railway restarts it)', guarded.status === 1, `status ${guarded.status}`);
    check('H2 control: without the guard the same process exits 0 (never restarted)', unguarded.status === 0, `status ${unguarded.status}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const worker = src('bot/worker.ts');
  check('H2 the worker installs the exit guards and bounds every mention', /installExitGuards\(process/.test(worker) && /withDeadline\(MENTION_TIMEOUT_MS/.test(worker) && /withDeadline\(\s*WORK_TIMEOUT_MS/.test(worker));
}

// ==== H1: uncharged LLM budgets ================================================
{
  let now = Date.UTC(2026, 9, 5, 23, 59, 0);
  const q = new rl.DailyQuota(2, () => now);
  check('H1 DailyQuota: limit per key per day', q.take('a') && q.take('a') && !q.take('a') && q.take('b'));
  q.giveBack('a');
  check('H1 DailyQuota: giveBack frees one unit', q.take('a') && !q.take('a'));
  now += 2 * 60_000; // past midnight UTC
  check('H1 DailyQuota: resets at midnight UTC', q.used('a') === 0 && q.take('a'));
  check('H1 secondsUntilUtcMidnight', rl.secondsUntilUtcMidnight(Date.UTC(2026, 9, 5, 23, 59, 30)) === 30 && rl.secondsUntilUtcMidnight(Date.UTC(2026, 9, 5, 0, 0, 0)) === 86_400);
  const big = new rl.DailyQuota(5, () => now, 10);
  for (let i = 0; i < 10; i++) big.take(`old-${i}`);
  now += 86_400_000;
  big.take('fresh');
  check('H1 DailyQuota: earlier days are pruned once the map is large', big.size === 1, `size ${big.size}`);

  process.env.RATE_LLM_PER_USER_DAY = '3';
  process.env.RATE_LLM_GLOBAL_PER_DAY = '5';
  rl.resetLimitersForTests();
  for (let i = 0; i < 3; i++) rl.consumeUnchargedLlm('u:alice');
  const mine = throws(() => rl.consumeUnchargedLlm('u:alice'));
  check(
    'H1 per-user daily quota answers 429 that says it resets at midnight UTC',
    mine instanceof errors.PublicError && mine.status === 429 && /midnight UTC/.test(mine.message) && (mine.retryAfterSec ?? 0) > 0 && !hasDash(mine.message),
    (mine as Error)?.message,
  );
  rl.consumeUnchargedLlm('u:bob');
  rl.consumeUnchargedLlm('u:bob');
  const all = throws(() => rl.consumeUnchargedLlm('u:carol'));
  check(
    'H1 the service-wide daily budget stops every caller with a clear 429',
    all instanceof errors.PublicError && all.status === 429 && /capacity/.test(all.message) && !hasDash(all.message),
    (all as Error)?.message,
  );
  check('H1 a refusal costs nothing (carol was not counted)', rl.dailyQuota('llm_user').used('u:carol') === 0 && rl.dailyQuota('llm_global').used('all') === 5);
  delete process.env.RATE_LLM_PER_USER_DAY;
  delete process.env.RATE_LLM_GLOBAL_PER_DAY;
  rl.resetLimitersForTests();
  check('H1 defaults: 40 per user and 1500 overall per UTC day', rl.dailyQuota('llm_user').limit === 40 && rl.dailyQuota('llm_global').limit === 1500);

  const server = src('server/server.ts');
  const body = (fn: string) => server.slice(server.indexOf(`async function ${fn}`), server.indexOf('\n}\n', server.indexOf(`async function ${fn}`)));
  check('H1 /api/thesis and /api/extract both take the daily budgets', /enforceUnchargedBudget\(req, user\)/.test(body('handleThesis')) && /enforceUnchargedBudget\(req, user\)/.test(body('handleExtract')));
  check('H1 /api/thesis routes the web entity check through the web-lookup bucket', /buildThesis\(text, \{ allowWebSearch: webSearchGate\(req, user\) \}\)/.test(body('handleThesis')));

  // prompt_log keeps a 20k excerpt, the pipeline keeps the 100k document.
  let stored = '';
  sb.from = () => ({
    insert: (row: { prompt: string }) => {
      stored = row.prompt;
      return Promise.resolve({ error: null });
    },
  });
  try {
    auth.logPrompt({ id: 'u1', email: '' }, 'x'.repeat(100_000));
    await new Promise((r) => setTimeout(r, 10));
  } finally {
    sb.from = realFrom;
  }
  check('H1 prompt_log stores at most 20,000 characters', stored.length === 20_000 && auth.PROMPT_LOG_MAX_CHARS === 20_000, `${stored.length}`);
  check('H1 the pipeline document cap stays 100k', validate.MAX_DOC_CHARS === 100_000);

  // The thesis review's paid web entity check asks the gate first.
  process.env.OPENROUTER_API_KEY = 'offline-test-key'; // fetch is stubbed; nothing leaves the process
  const models: string[] = [];
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
    const sent = JSON.parse(String(init?.body ?? '{}')) as { model?: string };
    models.push(String(sent.model));
    const content = /:online$/.test(String(sent.model))
      ? '{"keep":[],"add":[],"private":[],"corrected_summary":null}'
      : JSON.stringify({ title: 'Widgets', stance: 'bullish', summary: 'Acme Widgets will grow fast with new demand.', intent: 'anchor', direction: 'long', anchors: ['Acme Widgets'], private_entities: [], avoid: [], themes: ['widgets'], strategies: [], requirements: {} });
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  }) as typeof fetch;
  sb.from = emptyTableClient([]);
  try {
    let asked = 0;
    await thesisMod.buildThesis('Acme Widgets will grow fast.', { allowWebSearch: () => (asked++, false) });
    check('H1 thesis: a spent web-lookup budget skips the paid :online call', asked === 1 && !models.some((m) => m.endsWith(':online')), models.join(','));
    models.length = 0;
    await thesisMod.buildThesis('Acme Widgets will grow fast.', { allowWebSearch: () => true });
    check('H1 thesis: with budget left the entity check runs', models.filter((m) => m.endsWith(':online')).length === 1, models.join(','));
    models.length = 0;
    await thesisMod.buildThesis('Acme Widgets will grow fast.');
    check('H1 thesis: charged runs (no gate) keep the check', models.filter((m) => m.endsWith(':online')).length === 1, models.join(','));
  } finally {
    globalThis.fetch = realFetch;
    sb.from = realFrom;
  }

  // YouTube: the paid ytscribe call is behind the same gate.
  process.env.YTSCRIBE_API_KEY = 'offline';
  const urls: string[] = [];
  globalThis.fetch = (async (u: unknown) => {
    urls.push(String(u));
    return new Response(JSON.stringify({ status: 'ok', data: { transcript: 'A long transcript about chips and power demand. '.repeat(5), metadata: { video: { title: 'Chips' } } } }), { status: 200 });
  }) as typeof fetch;
  try {
    const yt = 'https://www.youtube.com/watch?v=abcdefghijk';
    const refused = await rejectsWith(extract.extractLink(yt, { allowWebSearch: () => false }), (e) => e instanceof errors.PublicError && e.status === 429);
    check('H1 YouTube: a spent web-lookup budget refuses before the paid ytscribe call', refused && urls.length === 0, urls.join(','));
    const got = await extract.extractLink(yt, { allowWebSearch: () => true });
    check('H1 YouTube: with budget left the transcript is fetched', urls.length === 1 && urls[0]!.includes('ytscribe') && got.text.includes('transcript'));
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.YTSCRIBE_API_KEY;
  }
}

// ==== M1: Google sessions only ================================================
{
  const g = { app_metadata: { provider: 'google', providers: ['google'] }, is_anonymous: false };
  check('M1 a Google session is accepted', auth.isAcceptedSessionUser(g));
  check('M1 an email signup is refused', !auth.isAcceptedSessionUser({ app_metadata: { provider: 'email', providers: ['email'] } }));
  check('M1 an anonymous sign-in is refused', !auth.isAcceptedSessionUser({ is_anonymous: true, app_metadata: { provider: 'anonymous', providers: ['anonymous'] } }));
  check('M1 anonymous is refused even with google listed', !auth.isAcceptedSessionUser({ ...g, is_anonymous: true }));
  check('M1 phone and other providers are refused', !auth.isAcceptedSessionUser({ app_metadata: { provider: 'phone' } }) && !auth.isAcceptedSessionUser({ app_metadata: { provider: 'github', providers: ['github'] } }));
  check('M1 missing metadata is refused', !auth.isAcceptedSessionUser({}) && !auth.isAcceptedSessionUser({ app_metadata: null }));
  check('M1 an email account that linked Google is accepted (providers list)', auth.isAcceptedSessionUser({ app_metadata: { provider: 'email', providers: ['email', 'google'] } }));
  check('M1 AUTH_PROVIDERS can widen the list, never to anonymous', auth.isAcceptedSessionUser({ app_metadata: { provider: 'email' } }, auth.allowedAuthProviders({ AUTH_PROVIDERS: 'google,email' })) && JSON.stringify(auth.allowedAuthProviders({ AUTH_PROVIDERS: 'anonymous' })) === '["google"]' && JSON.stringify(auth.allowedAuthProviders({})) === '["google"]');
  check('M1 userFromRequest applies the check', /isAcceptedSessionUser\(data\.user\)/.test(src('server/auth.ts')));
}

// ==== M2: extract concurrency =================================================
{
  process.env.EXTRACT_MAX_CONCURRENT = '2';
  rl.resetLimitersForTests();
  const a = rl.acquireExtractSlot('u:a');
  const twice = throws(() => rl.acquireExtractSlot('u:a'));
  check('M2 one extraction per user at a time (429)', twice instanceof errors.PublicError && twice.status === 429 && !hasDash(twice.message));
  const b = rl.acquireExtractSlot('u:b');
  const full = throws(() => rl.acquireExtractSlot('u:c'));
  check('M2 server-wide cap answers 503 server_busy with Retry-After', full instanceof errors.PublicError && full.status === 503 && full.code === 'server_busy' && (full.retryAfterSec ?? 0) > 0);
  check('M2 a refused global slot does not leak the per-user slot', throws(() => rl.acquireExtractSlot('u:c')) instanceof errors.PublicError);
  a();
  const c = rl.acquireExtractSlot('u:c');
  check('M2 releasing frees the slot', typeof c === 'function');
  b();
  c();
  const l1 = rl.acquireExtractSlot(null);
  const l2 = rl.acquireExtractSlot(null);
  check('M2 loopback dev (null actor) only takes server-wide slots', typeof l1 === 'function' && typeof l2 === 'function');
  l1();
  l2();
  delete process.env.EXTRACT_MAX_CONCURRENT;
  rl.resetLimitersForTests();
  const server = src('server/server.ts');
  const ex = server.slice(server.indexOf('async function handleExtract'));
  check('M2 the slot is taken before the 35 MB body is read, released in finally', ex.indexOf('acquireExtractSlot(') < ex.indexOf('readJson') && /finally \{\s*release\(\);/.test(ex));
  check('M2 audio limit unchanged (25 MB)', /MAX_AUDIO_BYTES = 25 \* 1024 \* 1024/.test(src('runtime/extract.ts')));
}

// ==== M3: universe cache and TRUST_PROXY text ================================
{
  let now = 1_000;
  let loads = 0;
  let release!: (v: string) => void;
  const c = new cache.TtlSingleFlight<string, string>(60_000, () => now);
  const load = () => {
    loads++;
    return new Promise<string>((r) => (release = r));
  };
  const p1 = c.get('robinhood', load);
  const p2 = c.get('robinhood', load);
  release('payload');
  check('M3 concurrent callers share one in-flight load', (await p1) === 'payload' && (await p2) === 'payload' && loads === 1);
  now += 59_000;
  await c.get('robinhood', async () => (loads++, 'x'));
  check('M3 cached for 60 s', loads === 1);
  now += 2_000;
  check('M3 reloaded after the TTL', (await c.get('robinhood', async () => (loads++, 'fresh'))) === 'fresh' && loads === 2);
  const failing = c.get('other', async () => {
    throw new Error('db down');
  });
  await failing.catch(() => {});
  await new Promise((r) => setTimeout(r, 0));
  check('M3 a failed load is not cached', (await c.get('other', async () => 'ok')) === 'ok');
  const server = src('server/server.ts');
  check('M3 the universe route reads through the cache', /universeDataCache\.get\(name, \(\) => universeAssetData\(name\)\)/.test(server) && !/await universeAssetData\(name\)/.test(server));

  const warned: string[] = [];
  rl.warnIfTrustProxyUnset({}, (m) => warned.push(m), true);
  check('M3 boot warning names 2 for Cloudflare plus Railway and 1 for Railway alone', /2 behind Cloudflare plus Railway/.test(warned[0] ?? '') && /1 behind Railway alone/.test(warned[0] ?? ''), warned[0]);
  rl.resetSharedIpWarningForTests();
  const lines: string[] = [];
  rl.consumeIp('ip', { headers: {}, socket: { remoteAddress: '10.0.0.9' } } as never, (m) => lines.push(m));
  check('M3 per-IP limits stay off (fail safe) without TRUST_PROXY, with the corrected hint', lines.length === 1 && /2 behind Cloudflare plus Railway, 1 behind Railway alone/.test(lines[0]!));
  rl.resetSharedIpWarningForTests();
}

// ==== L1: development guard on every path ======================================
{
  const mk = (remote: string, headers: Record<string, string>) => ({ headers, socket: { remoteAddress: remote } }) as never;
  const dev = { NODE_ENV: 'development' };
  check('L1 dev: a page request from localhost is served', !access.refuseDevRequest(mk('127.0.0.1', { host: 'localhost:8787' }), dev));
  check('L1 dev: a DNS-rebinding Host is refused on every path', access.refuseDevRequest(mk('127.0.0.1', { host: 'evil.example:8787' }), dev));
  check('L1 dev: a cross-site Origin is refused', access.refuseDevRequest(mk('127.0.0.1', { host: 'localhost:8787', origin: 'https://evil.example' }), dev));
  check('L1 dev: HOST set on purpose turns the guard off', !access.refuseDevRequest(mk('192.168.1.5', { host: 'dev.lan' }), { ...dev, HOST: '0.0.0.0' }));
  check('L1 deployed servers never use it', !access.refuseDevRequest(mk('10.0.0.1', { host: 'synthetick.org' }), { NODE_ENV: 'production' }));
  const server = src('server/server.ts');
  const route = server.slice(server.indexOf('async function route'));
  check('L1 the guard runs before pages are handed to Next', route.indexOf('refuseDevRequest(req)') > 0 && route.indexOf('refuseDevRequest(req)') < route.indexOf('handleNextRequest(req, res)'));
  const cfg = (await import('../next.config.js')).default as { allowedDevOrigins?: string[] };
  check('L1 next.config allowedDevOrigins lists loopback hosts only', JSON.stringify(cfg.allowedDevOrigins) === '["localhost","127.0.0.1","[::1]"]', JSON.stringify(cfg.allowedDevOrigins));
}

// ==== L3 + P1-b: sealed X link state, key without X_STATE_SECRET ===============
{
  const verifier = 'pkce-verifier-secret-value-0123456789';
  const st = xlink.signState('user-7', verifier);
  const decodedParts = st.split('.').map((p) => Buffer.from(p, 'base64url').toString('latin1')).join('|');
  check('L3 the PKCE verifier is not readable in the state', !st.includes(verifier) && !decodedParts.includes(verifier) && !decodedParts.includes('user-7'));
  const v = xlink.verifyState(st);
  check('L3 round trip', v?.userId === 'user-7' && v.verifier === verifier);
  const parts = st.split('.');
  const flip = (s: string) => s.slice(0, -2) + (s.slice(-2, -1) === 'A' ? 'B' : 'A') + s.slice(-1);
  check('L3 tampered ciphertext, IV or tag is refused', [1, 2, 3].every((i) => xlink.verifyState(parts.map((p, j) => (j === i ? flip(p) : p)).join('.')) === null));
  check('L3 an old HMAC-format state is refused', xlink.verifyState(`${Buffer.from('{"u":"x","v":"y","exp":9e15}').toString('base64url')}.sig`) === null);
  check('L3 expired state is refused', xlink.verifyState(xlink.signState('user-7', verifier, -1000)) === null);
  const reencoded = `${parts[0]}.${parts[1]}=.${parts[2]}.${parts[3]}`;
  check('L3 a re-encoded copy (base64 padding) is refused, so it cannot dodge single use', xlink.verifyState(reencoded) === null);
  check('L3 single use: the first presentation passes, replays do not', xlink.consumeStateOnce(st) === true && xlink.consumeStateOnce(st) === false);
  const k1 = xlink.stateKeyFrom({ X_STATE_SECRET: 'one', SUPABASE_SERVICE_KEY: 'svc' });
  const k2 = xlink.stateKeyFrom({ SUPABASE_SERVICE_KEY: 'svc', NODE_ENV: 'production' });
  check('P1-b production without X_STATE_SECRET derives a key (no 503)', k2.source === 'derived' && k2.key.length === 32);
  check('P1-b the derived key is not the service key, nor the dedicated-secret key', !k2.key.equals(Buffer.from('svc')) && !k2.key.equals(k1.key) && k1.source === 'dedicated');
  check('P1-b no secret at all still throws (nothing to derive from)', throws(() => xlink.stateKeyFrom({ NODE_ENV: 'production' })) instanceof Error);
  check('P1-b linking is configured with X_CLIENT_ID and X_REDIRECT_URL only', xlink.xLinkConfigured());
  const warns: string[] = [];
  const realErr = console.error;
  console.error = (...a: unknown[]) => void warns.push(a.map(String).join(' '));
  process.env.RAILWAY_ENVIRONMENT = 'production';
  try {
    xlink.signState('u', 'v');
    xlink.signState('u', 'v');
  } finally {
    delete process.env.RAILWAY_ENVIRONMENT;
    console.error = realErr;
  }
  check('P1-b one warning when the key is derived in production', warns.filter((w) => /X_STATE_SECRET is not set/.test(w)).length === 1, String(warns.length));
  check('P1-b the 503 hint no longer asks for X_STATE_SECRET', !/X_STATE_SECRET\)/.test(src('server/server.ts')));
}

// ==== L4 + L5: charge first, capped refunds ===================================
{
  const user = { id: 'u-charge', email: '' };
  const calls: string[] = [];
  let spendOk = true;
  let addFails = false;
  sb.rpc = async (name: string) => {
    calls.push(name);
    if (name === 'add_credit') {
      if (addFails) return { data: null, error: { message: 'boom' } };
      return { data: { ok: true, credits: 5, cap: 10 }, error: null };
    }
    return { data: spendOk ? { ok: true, credits: 4, cap: 10 } : { ok: false, credits: 0, cap: 10 }, error: null };
  };
  rl.resetLimitersForTests();
  const thesis = { title: 'T', stance: '', summary: 'S', intent: 'thematic', direction: 'long', anchors: [], private_entities: [], avoid: [], themes: [], strategies: [], docCrit: {} } as unknown as Thesis;
  const input = { text: 'x', thesis, crit: {}, wantsPm: false, pmOnly: true, breadth: 'focused' as const, channel: 'web' as const };
  try {
    const done = await auth.chargeFirst(user, { onNoCredit: () => {} }, () =>
      run.performRun(user, input, { onStart: () => {}, onStatus: () => {} }),
    );
    check('L4 charge first: the run core takes the prepaid credit (one charge in total)', !!done && JSON.stringify(calls) === '["spend_credit"]', calls.join(','));

    calls.length = 0;
    let order = '';
    await rejectsWith(
      auth.chargeFirst(user, { onNoCredit: () => {} }, async () => {
        order = calls.join(',');
        throw new Error('thesis call failed');
      }),
      () => true,
    );
    check('L4 the charge happens BEFORE the paid thesis work', order === 'spend_credit');
    check('L4 a failure before the run core refunds the prepaid credit', JSON.stringify(calls) === '["spend_credit","add_credit"]', calls.join(','));

    calls.length = 0;
    const gone = new AbortController();
    gone.abort();
    await rejectsWith(
      auth.chargeFirst(user, { signal: gone.signal, onNoCredit: () => {} }, () => withRunSignal(gone.signal, () => run.performRun(user, input, { signal: gone.signal, onStart: () => {}, onStatus: () => {} }))),
      (e) => e instanceof RunAbortedError,
    );
    check('L4 a client gone before the run keeps the charge (no refund loop)', JSON.stringify(calls) === '["spend_credit"]', calls.join(','));

    calls.length = 0;
    spendOk = false;
    let noCredit = false;
    let ran = false;
    const none = await auth.chargeFirst(user, { onNoCredit: () => (noCredit = true) }, async () => {
      ran = true;
    });
    check('L4 no credit: answered before any work, nothing ran', none === null && noCredit && !ran);
    spendOk = true;

    calls.length = 0;
    const open = await auth.chargeFirst(null, { onNoCredit: () => {} }, async () => 'open');
    check('L4 auth off: no charge at all', open?.value === 'open' && calls.length === 0);

    const server = src('server/server.ts');
    const mcp = src('server/mcp.ts');
    const v1 = server.slice(server.indexOf('async function handleV1Screen'));
    const mcpTool = mcp.slice(mcp.indexOf("'run_screen'"));
    check('L4 /v1/screen charges before buildScreenInput', v1.indexOf('chargeFirst(') > 0 && v1.indexOf('chargeFirst(') < v1.indexOf('buildScreenInput('));
    check('L4 MCP run_screen charges before buildScreenInput', mcpTool.indexOf('chargeFirst(') > 0 && mcpTool.indexOf('chargeFirst(') < mcpTool.indexOf('buildScreenInput('));
    check('L4 the concurrency cap is checked before the charge', v1.indexOf('assertRunSlotAvailable(') < v1.indexOf('chargeFirst(') && mcpTool.indexOf('assertRunSlotAvailable(') < mcpTool.indexOf('chargeFirst('));

    // L5: three automatic refunds a day, then the charge stays and the error says so.
    rl.resetLimitersForTests();
    calls.length = 0;
    const refunded: boolean[] = [];
    for (let i = 0; i < 3; i++) refunded.push((await auth.refundCreditDetailed('u-refund')).refunded !== null);
    const fourth = await errors.withRunFailureNotes(async () => {
      const out = await auth.refundCreditDetailed('u-refund');
      return { out, msg: errors.runFailureMessage(new Error('Model returned non-JSON output')).message };
    });
    check('L5 three refunds a day go through', refunded.every(Boolean) && calls.filter((c) => c === 'add_credit').length === 3);
    check('L5 the fourth is refused without calling the database', fourth.out.refunded === null && fourth.out.reason === 'capped' && calls.filter((c) => c === 'add_credit').length === 3);
    check('L5 the run error says the credit stays charged', /Automatic refunds are limited to 3 a day/.test(fourth.msg) && !hasDash(fourth.msg), fourth.msg);
    check('L5 outside a request scope nothing leaks into other messages', !/refund/i.test(errors.runFailureMessage(new Error('x')).message));

    rl.resetLimitersForTests();
    addFails = true;
    const failed = await errors.withRunFailureNotes(async () => ({ out: await auth.refundCreditDetailed('u-flaky'), notes: errors.runFailureNotes() }));
    addFails = false;
    check('L5 a refund that fails is reported and does not use up an allowance', failed.out.reason === 'failed' && /could not be refunded/.test(failed.notes) && rl.dailyQuota('refund').used('u:u-flaky') === 0);

    // performRun's own refund path honors the cap and the note reaches the SSE error text.
    rl.resetLimitersForTests();
    for (let i = 0; i < 3; i++) await auth.refundCredit('u-run');
    let onRefund = false;
    const viaRun = await errors.withRunFailureNotes(async () => {
      await rejectsWith(
        run.performRun({ id: 'u-run', email: '' }, input, { onStart: () => {}, onStatus: () => { throw new Error('pipeline broke'); }, onRefund: () => (onRefund = true) }),
        () => true,
      );
      return errors.runFailureMessage(new Error('pipeline broke')).message;
    });
    check('L5 performRun: past the cap no refund event, and the error says why', !onRefund && /stays charged/.test(viaRun), viaRun);

    const texts = [reply.runFailedReply('refunded'), reply.runFailedReply('capped', 3), reply.runFailedReply('failed')];
    check('L5 bot failure replies never claim a refund that did not happen', texts[0] === reply.RUN_FAILED_REPLY && /limited to 3 a day/.test(texts[1]!) && !/returned\.$/.test(texts[1]!) && /could not be returned/.test(texts[2]!));
    check('L5 bot failure replies fit a post and carry no dashes or URLs', texts.every((x) => x.length <= 280 && !hasDash(x) && reply.replyRejection(x) === null));
  } finally {
    sb.rpc = realRpc;
    rl.resetLimitersForTests();
  }
}

// ==== L7: HTTP server limits ==================================================
{
  const s = hard.hardenHttpServer(http.createServer(hard.httpServerOptions(), () => {}), {});
  check('L7 headersTimeout 15 s, requestTimeout 120 s, keep-alive 65 s, no socket timeout, 1000 connections', s.headersTimeout === 15_000 && s.requestTimeout === 120_000 && s.keepAliveTimeout === 65_000 && s.timeout === 0 && s.maxConnections === 1000);
  check('L7 SERVER_MAX_CONNECTIONS is honored, garbage ignored', hard.maxConnectionsFrom({ SERVER_MAX_CONNECTIONS: '50' }) === 50 && hard.maxConnectionsFrom({ SERVER_MAX_CONNECTIONS: 'lots' }) === 1000);
  check('L7 server.ts builds its server from these limits', /http\.createServer\(httpServerOptions\(\)/.test(src('server/server.ts')) && /hardenHttpServer\(server\)/.test(src('server/server.ts')));

  // Live, with small limits: a slow client is cut, an SSE stream outlives requestTimeout.
  const limits = { headersTimeoutMs: 300, requestTimeoutMs: 600, keepAliveTimeoutMs: 1000, connectionsCheckingIntervalMs: 50, maxConnections: 20 };
  const srv = http.createServer(hard.httpServerOptions(limits), (req, res) => {
    if (req.url === '/sse') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      let n = 0;
      const iv = setInterval(() => {
        res.write(`data: ${n++}\n\n`);
        if (n === 8) {
          clearInterval(iv);
          res.end();
        }
      }, 200);
      return;
    }
    res.end('ok');
  });
  hard.hardenHttpServer(srv, {}, limits);
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as net.AddressInfo).port;
  try {
    const slow = await new Promise<{ closedMs: number; data: string }>((resolve) => {
      const t0 = Date.now();
      let data = '';
      const sock = net.connect(port, '127.0.0.1', () => sock.write('GET / HTTP/1.1\r\nHost: x\r\n')); // headers never finish
      sock.on('data', (d) => (data += d.toString()));
      sock.on('close', () => resolve({ closedMs: Date.now() - t0, data }));
      setTimeout(() => sock.destroy(), 5000);
    });
    check('L7 a client that never finishes its headers is cut (408)', slow.closedMs < 3000 && /408/.test(slow.data), `${slow.closedMs} ms ${slow.data.split('\r\n')[0]}`);
    const sse = await new Promise<{ ms: number; events: number }>((resolve, reject) => {
      const t0 = Date.now();
      http.get({ host: '127.0.0.1', port, path: '/sse' }, (res) => {
        let events = 0;
        res.on('data', (d) => (events += (d.toString().match(/data: /g) ?? []).length));
        res.on('end', () => resolve({ ms: Date.now() - t0, events }));
        res.on('error', reject);
      }).on('error', reject);
    });
    check('L7 an SSE stream stays open well past requestTimeout', sse.events === 8 && sse.ms > limits.requestTimeoutMs * 2, `${sse.events} events in ${sse.ms} ms`);
  } finally {
    srv.closeAllConnections?.();
    await new Promise((r) => srv.close(r));
  }
}

// ==== L8: bot video fetch and ffmpeg ===========================================
{
  const args = video.ffmpegArgs('/tmp/in.mp4', '/tmp/out.wav');
  const i = args.indexOf('-i');
  check('L8 ffmpeg reads the local file only (-protocol_whitelist file before -i)', args[args.indexOf('-protocol_whitelist') + 1] === 'file' && args.indexOf('-protocol_whitelist') < i);
  check('L8 ffmpeg is told the input container (-f mp4) and the output (-f wav)', args.indexOf('mp4') === args.indexOf('-f') + 1 && args.indexOf('-f') < i && args.slice(i).join(' ').includes('-f wav'));
  check('L8 FFMPEG_PATH selects a system ffmpeg (absolute paths only)', video.ffmpegBinary({ FFMPEG_PATH: '/usr/bin/ffmpeg' }) === '/usr/bin/ffmpeg' && throws(() => video.ffmpegBinary({ FFMPEG_PATH: 'ffmpeg' })) instanceof Error && typeof video.ffmpegBinary({}) === 'string');

  const fetched: { url: string; redirect?: string }[] = [];
  globalThis.fetch = (async (u: unknown, init?: RequestInit) => {
    const url = String(u);
    fetched.push({ url, redirect: init?.redirect });
    if (url.includes('hop')) return new Response(null, { status: 302, headers: { location: 'https://video.twimg.com/final.mp4' } });
    if (url.includes('evil')) return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } });
    return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-length': '3' } });
  }) as typeof fetch;
  try {
    const refused = await rejectsWith(video.downloadBounded('https://video.twimg.com/evil.mp4'), (e) => /outside its media CDN/.test((e as Error).message));
    check('L8 a redirect off the media CDN is refused BEFORE it is requested', refused && fetched.length === 1 && fetched[0]!.redirect === 'manual', JSON.stringify(fetched));
    fetched.length = 0;
    const buf = await video.downloadBounded('https://video.twimg.com/hop.mp4');
    check('L8 a redirect within the CDN is followed', buf.length === 3 && fetched.length === 2 && fetched[1]!.url === 'https://video.twimg.com/final.mp4');
    check('L8 an untrusted first URL is never requested', (await rejectsWith(video.downloadBounded('https://evil.example/x.mp4'), () => true)) && fetched.length === 2);
  } finally {
    globalThis.fetch = realFetch;
  }

  // The real binary (when installed): a valid MP4 converts, a URL input is refused.
  const bin = video.ffmpegBinary({});
  if (bin && existsSync(bin)) {
    const dir = mkdtempSync(join(tmpdir(), 'synthetick-ffmpeg-'));
    try {
      const mp4 = join(dir, 'in.mp4');
      const made = spawnSync(bin, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=1', '-shortest', '-c:v', 'mpeg4', '-c:a', 'aac', mp4]);
      const conv = spawnSync(bin, video.ffmpegArgs(mp4, join(dir, 'out.wav')));
      const viaUrl = spawnSync(bin, video.ffmpegArgs('http://127.0.0.1:9/x.mp4', join(dir, 'u.wav')), { encoding: 'utf8' });
      check('L8 the hardened arguments still transcode a real MP4', made.status === 0 && conv.status === 0 && existsSync(join(dir, 'out.wav')));
      check('L8 ffmpeg refuses a network input with these arguments', viaUrl.status !== 0 && /not on whitelist/.test(viaUrl.stderr));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } else {
    console.log('SKIP — L8 live ffmpeg run: no ffmpeg binary installed');
  }
}

// ==== L9: reply cost guard =====================================================
{
  let now = Date.UTC(2026, 9, 5, 12);
  const b = new guards.ReplyBudget(3, () => now);
  check('L9 a template reply goes to an author once per UTC day', b.templateAllowed('no_credits', 'a') && (b.recordPost(), b.recordTemplate('no_credits', 'a'), !b.templateAllowed('no_credits', 'a')) && b.templateAllowed('run_failed', 'a') && b.templateAllowed('no_credits', 'b'));
  b.recordPost();
  b.recordPost();
  check('L9 the global daily cap stops every post', !b.canPost() && !b.templateAllowed('unlinked', 'z'));
  now += 86_400_000;
  check('L9 both reset at midnight UTC', b.canPost() && b.templateAllowed('no_credits', 'a'));
  const r = new guards.ReplyBudget(10, () => now);
  r.restore(new Date(now).toISOString().slice(0, 10), 7);
  r.restore('2000-01-01', 9);
  check('L9 the persisted count survives a restart (today only)', r.postsToday === 7);
  check('L9 X_BOT_MAX_REPLIES_PER_DAY, default 300', guards.ReplyBudget.fromEnv({}).maxPostsPerDay === 300 && guards.ReplyBudget.fromEnv({ X_BOT_MAX_REPLIES_PER_DAY: '50' }).maxPostsPerDay === 50);
  const worker = src('bot/worker.ts');
  check('L9 the worker checks the budget before charging and before every template', /if \(!budget\.canPost\(\)\)/.test(worker) && /templateAllowed\('no_credits'/.test(worker) && /templateAllowed\('run_failed'/.test(worker) && /templateAllowed\('unlinked'/.test(worker) && !/postReply\((UNLINKED_REPLY|NO_CREDITS_REPLY|RUN_FAILED_REPLY)/.test(worker));
}

// ==== L12, L13: SQL and CI hardening (static) ==================================
{
  const sqlFiles = readdirSync(join(ROOT, 'db')).filter((f) => f.endsWith('.sql')).map((f) => [f, src(`db/${f}`)] as const);
  // Function declarations only: comment lines and the verifier's own text do not count.
  const definers = sqlFiles
    .filter(([f]) => f !== 'verify-rls.sql')
    .flatMap(([f, s]) => s.split('\n').filter((l) => /security definer/i.test(l) && !l.trim().startsWith('--')).map((l) => `${f}: ${l.trim()}`));
  check('L12 every SECURITY DEFINER function pins search_path = public, pg_temp', definers.length >= 3 && definers.every((d) => /set search_path = public, pg_temp/.test(d)), definers.join(' | '));
  const credits = src('db/auth_credits.sql');
  const spend = credits.slice(credits.indexOf('create or replace function spend_credit'));
  check('L12 spend_credit refuses a negative amount', /if p_amount is null or p_amount < 0 then\s+raise exception/.test(spend));
  const verify = src('db/verify-rls.sql');
  check('L12 verify-rls checks authenticated too, write policies, grants and views', /'authenticated'::name/.test(verify) && /pg_policies/.test(verify) && /has_table_privilege/.test(verify) && /security_invoker/.test(verify) && /pg_temp/.test(verify));
  check('L12 api_keys revokes the browser roles', /revoke all on api_keys from anon, authenticated;/.test(src('db/api_keys.sql')));

  const wfDir = join(ROOT, '.github/workflows');
  const checkouts = readdirSync(wfDir).flatMap((f) => {
    const lines = readFileSync(join(wfDir, f), 'utf8').split('\n');
    return lines.flatMap((l, i) => (/uses: actions\/checkout@/.test(l) ? [{ f, block: lines.slice(i + 1, i + 5).join('\n') }] : []));
  });
  check('L13 every checkout step sets persist-credentials: false', checkouts.length > 0 && checkouts.every((c) => /persist-credentials: false/.test(c.block)), checkouts.filter((c) => !/persist-credentials: false/.test(c.block)).map((c) => c.f).join(','));
  const dep = src('.github/dependabot.yml');
  check('L13 Dependabot no longer ignores every major update, groups stay', !/version-update:semver-major/.test(dep) && /npm-minor-and-patch/.test(dep) && /sail-agent-minor-and-patch/.test(dep));
}

// ==== L16: IPv6 actors keyed by /64 =============================================
{
  const req = (ip: string) => ({ headers: {}, socket: { remoteAddress: ip } }) as never;
  check('L16 actorKey groups an IPv6 /64', rl.actorKey(null, req('2001:db8:1:2::1')) === rl.actorKey(null, req('2001:db8:1:2:ffff::9')) && rl.actorKey(null, req('2001:db8:1:2::1')) !== rl.actorKey(null, req('2001:db8:1:3::1')));
  check('L16 IPv4 and signed-in users unchanged', rl.actorKey(null, req('203.0.113.7')) === 'ip:203.0.113.7' && rl.actorKey({ id: 'u1' }, req('203.0.113.7')) === 'u:u1');
}

// ==== R1: pages over 2 MB ======================================================
{
  const article = `<p>${'Real reporting about the grid and power demand. '.repeat(40)}</p>`;
  const cutPage = `<html><head><title>Big Page - Site</title></head><body><div class="top">Jump to content\nDonate\nCreate account\nPersonal tools</div><main id="content">${article}`; // cut: no </main>
  const asTruncated = extract.stripHtml(extract.extractMainHtml(cutPage, { truncated: true }));
  check('R1 a cut page still yields its main content without the site chrome', asTruncated.startsWith('Real reporting') && !/Donate|Create account/.test(asTruncated), asTruncated.slice(0, 60));
  const asWhole = extract.stripHtml(extract.extractMainHtml(cutPage));
  check('R1 a complete page with a missing closer keeps the old fallback', /Donate/.test(asWhole));
  check('R1 the title is never part of the body (the caller prepends it once)', !/Big Page - Site/.test(asWhole) && !/Big Page - Site/.test(asTruncated));
  check('R1 extractArticle passes the truncation flag', /extractMainHtml\(html, \{ truncated \}\)/.test(src('runtime/extract.ts')));
  const t0 = performance.now();
  extract.extractMainHtml('<main>'.repeat(400_000), { truncated: true });
  check('R1 the open-ended path stays linear on hostile input', performance.now() - t0 < 750);
}

// ==== R4: the server's own thesis output is never refused for its length =======
{
  const own = {
    title: 't'.repeat(400),
    stance: 's',
    summary: 'x'.repeat(9000),
    intent: 'thematic',
    direction: 'long',
    anchors: Array.from({ length: 30 }, (_, k) => `T${k}`),
    private_entities: Array.from({ length: 15 }, (_, k) => ({ name: `P${k}`, note: 'n'.repeat(500) })),
    avoid: ['a'.repeat(200), ...Array.from({ length: 35 }, () => 'b')],
    themes: Array.from({ length: 25 }, () => 'z'.repeat(200)),
    strategies: [],
    docCrit: { constrained: true, constraint_note: 'c'.repeat(500), asset_set: Array.from({ length: 20 }, () => 'stock') },
  };
  const parsed = throws(() => validate.parseClientThesis(own));
  check('R4 an over-long thesis is truncated, not a 400', !(parsed instanceof Error), (parsed as Error)?.message);
  const t = validate.parseClientThesis(own);
  check(
    'R4 fields are cut to their caps',
    t.summary.length === 8000 && t.title.length === 300 && t.anchors.length === 25 && t.private_entities.length === 12 && t.private_entities[0]!.note.length === 400 &&
      t.avoid.length === 30 && t.avoid[0]!.length === 120 && t.themes.length === 20 && t.themes[0]!.length === 160 && (t.docCrit.constraint_note ?? '').length === 400 && (t.docCrit.asset_set ?? []).length === 12,
  );
  const is400 = (e: unknown) => e instanceof errors.PublicError && e.status === 400;
  check('R4 wrong types are still a 400', is400(throws(() => validate.parseClientThesis({ ...own, themes: 'x' }))) && is400(throws(() => validate.parseClientThesis({ ...own, summary: 5 }))) && is400(throws(() => validate.parseClientThesis({ ...own, summary: '' }))));
  const fr = validate.ClientFinReqSchema.parse({ unverifiable: ['u'.repeat(500)], bounds: Array.from({ length: 150 }, () => ({ key: 'pe', min: 1, max: null })) });
  check('R4 finReq: over-long items and lists are cut too', fr.unverifiable![0]!.length === 400 && fr.bounds!.length === 100);
  check('R4 finReq: wrong types still fail', !validate.ClientFinReqSchema.safeParse({ unverifiable: [5] }).success && !validate.ClientFinReqSchema.safeParse({ bounds: 'pe' }).success);
}

// ==== R5: content types for /v1 and /mcp =======================================
{
  const allow = validate.contentTypeAllowed;
  check('R5 browser /api/* stays strict', allow('application/json', 'strict') && allow('application/vnd.api+json; charset=utf-8', 'strict') && !allow(undefined, 'strict') && !allow('text/plain', 'strict') && !allow('application/x-www-form-urlencoded', 'strict'));
  check('R5 /v1 and /mcp accept JSON without a JSON content type', allow(undefined, 'lenient') && allow('', 'lenient') && allow('text/plain', 'lenient') && allow('application/octet-stream', 'lenient') && allow('application/json', 'lenient'));
  check('R5 forms and multipart stay a 415', !allow('application/x-www-form-urlencoded', 'lenient') && !allow('multipart/form-data; boundary=x', 'lenient') && !allow('  Multipart/mixed', 'lenient'));
  const mk = (ct?: string) => {
    const rawHeaders = ['Host', 'x', ...(ct === undefined ? [] : ['Content-Type', ct])];
    return { method: 'POST', headers: { host: 'x', ...(ct === undefined ? {} : { 'content-type': ct }) } as Record<string, string | undefined>, rawHeaders };
  };
  const none = mk();
  validate.normalizeJsonContentType(none);
  const plain = mk('text/plain');
  validate.normalizeJsonContentType(plain);
  check('R5 /mcp: a missing or text/plain type becomes application/json for the SDK', none.headers['content-type'] === 'application/json' && plain.headers['content-type'] === 'application/json' && plain.rawHeaders.filter((h) => /content-type/i.test(h)).length === 1 && plain.rawHeaders.includes('application/json'));
  const json = mk('application/json; charset=utf-8');
  validate.normalizeJsonContentType(json);
  check('R5 /mcp: a JSON type is left alone', json.headers['content-type'] === 'application/json; charset=utf-8');
  const form = throws(() => validate.normalizeJsonContentType(mk('application/x-www-form-urlencoded')));
  check('R5 /mcp: a form body is a 415', form instanceof errors.PublicError && form.status === 415);
  const server = src('server/server.ts');
  check('R5 /v1/screen and /v1/assets read lenient, /api/* strict', server.split("MAX_JSON_BODY_BYTES, 'lenient')").length - 1 === 2 && /normalizeJsonContentType\(req\)/.test(server));
}

// ==== E8: the stateless /mcp endpoint takes POST only ===========================
{
  const server = src('server/server.ts');
  const mcpRoute = server.slice(server.indexOf("if (path === '/mcp')"), server.indexOf('return handleMcp(req, res, mcpUser)'));
  const refuse = mcpRoute.indexOf("if (method !== 'POST')");
  check(
    'E8 GET (and any method but POST) on /mcp is a 405 with Allow: POST, OPTIONS, before auth and the transport',
    refuse > 0 && /if \(method !== 'POST'\) \{\s*res\.writeHead\(405, \{ 'content-type': 'application\/json', allow: 'POST, OPTIONS' \}\);/.test(mcpRoute) && refuse < mcpRoute.indexOf('v1User(req, res)'),
    mcpRoute.slice(0, 120),
  );
  check('E8 OPTIONS on /mcp advertises the same methods', /res\.writeHead\(204, \{ allow: 'POST, OPTIONS' \}\)/.test(mcpRoute) && !/GET, POST, DELETE/.test(mcpRoute));
  check('E8 the transport is still stateless (no session id generator)', /new StreamableHTTPServerTransport\(\{ sessionIdGenerator: undefined \}\)/.test(src('server/mcp.ts')));
}

// ==== small items ================================================================
{
  check('referer: default https://synthetick.org', llm.openRouterReferer() === 'https://synthetick.org');
  process.env.OPENROUTER_REFERER = 'https://fork.example';
  check('referer: OPENROUTER_REFERER overrides it', llm.openRouterReferer() === 'https://fork.example');
  delete process.env.OPENROUTER_REFERER;
  let sent = '';
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
    sent = String((init?.headers as Record<string, string>)['http-referer']);
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 });
  }) as typeof fetch;
  try {
    process.env.OPENROUTER_REFERER = 'https://fork.example';
    await llm.callClaude('hi');
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.OPENROUTER_REFERER;
  }
  check('referer: callClaude sends it', sent === 'https://fork.example');
  check('.env.example documents OPENROUTER_REFERER', /\nOPENROUTER_REFERER=/.test(src('.env.example')));
  const ex = src('runtime/extract.ts');
  check('extract fallback asks for publicly accessible reporting, never paywalled text', /publicly accessible reporting, quotes and summaries/.test(ex) && /Never reproduce paywalled or subscriber-only text/.test(ex));
  check('test-bot uses a placeholder handle', !/@elon/.test(src('runtime/test-bot.ts')) && /@example_user/.test(src('runtime/test-bot.ts')));
}

// ==== CodeQL follow-ups (2026-10-06) =============================================
{
  const { BEARER_RE } = await import('../server/auth.js');
  const hostile = 'Bearer' + ' '.repeat(16000) + '\n';
  const t0 = Date.now();
  BEARER_RE.exec(hostile);
  const ms = Date.now() - t0;
  check('CodeQL redos: Authorization parsing is linear on 16 KB of spaces', ms < 50, `${ms} ms`);
  check('CodeQL redos: a normal bearer token still parses', BEARER_RE.exec('Bearer abc.def-ghi_123')?.[1] === 'abc.def-ghi_123');
  check('CodeQL redos: case and trailing spaces tolerated', BEARER_RE.exec('bearer   tok  ')?.[1] === 'tok');
  check('CodeQL redos: a token with inner spaces is refused', BEARER_RE.exec('Bearer a b') === null);

  const { stripHtml } = await import('./extract.js');
  check('CodeQL double-escaping: entities decode once', stripHtml('<p>a &amp;lt;b&amp;gt; c &amp; d</p>') === 'a &lt;b&gt; c & d', stripHtml('<p>a &amp;lt;b&amp;gt; c &amp; d</p>'));

  const logSrc = src('ingest/lib/log.ts');
  check('CodeQL format string: log lines are passed as data, not as a format', /stream\('%s', line, extra\)/.test(logSrc) && /stream\('%s', line\)/.test(logSrc));
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);

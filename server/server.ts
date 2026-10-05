/**
 * Local API server for Milestone 4 — the same handler logic ports into
 * Supabase Edge Functions at deploy (spec §1); until then this keeps every
 * secret server-side while Next.js renders the frontend.
 *
 *   POST /api/extract            → source extraction                (auth)
 *   POST /api/thesis             → structured thesis review          (auth)
 *   POST /api/complete           → SSE status lines + full result    (auth, 1 credit)
 *   POST /api/pdf-credit         → debit for a PDF report download   (auth, 1 credit)
 *   GET  /api/config             → public auth config for the browser
 *   GET  /api/me                 → signed-in profile + today's credits
 *   GET  /api/keys               → list the user's API keys            (auth)
 *   POST /api/keys               → create an API key (full key once)   (auth)
 *   POST /api/keys/revoke        → revoke one of the user's keys       (auth)
 *   GET  /api/x/link             → X linking: authorize URL            (auth)
 *   GET  /api/x/callback         → X linking: browser redirect from X
 *   POST /api/x/unlink           → X linking: remove the link          (auth)
 *   POST /v1/screen              → public API: thesis in, SSE run out  (API key, 1 credit)
 *   GET  /v1/universe/:name      → tradable-universe registry (spec §16, public)
 *   GET  /v1/universe/:name/assets[/:sym] → registry + full ingested data (§16.2, API key)
 *   POST /v1/assets              → public API: content in, assets out  (API key or session, 1 credit)
 *   GET  /v1/me                  → public API: owner + today's credits (API key)
 *   POST /mcp                    → MCP server: run_screen, get_credits (API key)
 *   GET  /api/admin/users        → admin: all profiles + today's usage
 *   POST /api/admin/adjust       → admin: set cap / grant / set credits
 *   *    /*                      → Next.js App Router
 *
 * Auth + credits (spec §12) only bind when SUPABASE_ANON_KEY is set; without
 * it the server runs open (local dev, offline tests). A production server
 * REFUSES to start without it unless ALLOW_OPEN_ACCESS=1 (assertAuthConfigured),
 * and an open dev server binds to 127.0.0.1 and answers loopback requests only.
 *
 * Abuse limits (server/ratelimit.ts, env-tunable): per-IP and per-user token
 * buckets, daily quotas plus a service-wide daily budget for the uncharged LLM
 * routes, a cap on concurrent runs per user and on concurrent extractions, and
 * JSON error bodies of the stable shape {error, code}; 429s carry Retry-After.
 * Behind a proxy set TRUST_PROXY so the client IP comes from X-Forwarded-For:
 * 2 behind Cloudflare plus Railway, 1 behind Railway alone.
 *
 * Errors: clients only ever receive curated messages (runtime/errors.ts);
 * details are logged server-side.
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import next from 'next';
import { buildThesis } from '../runtime/thesis.js';
import {
  mergeCrit,
  offlineConstraints,
  regionSet,
  type Crit,
} from '../runtime/requirements.js';
import { assertPublicHttpUrl, extractLink, extractImage, extractAudio } from '../runtime/extract.js';
import { supabase } from '../ingest/lib/supabase.js';
import { env } from '../ingest/lib/env.js';
import { log } from '../ingest/lib/log.js';
import {
  authEnabled,
  isLocalRequest,
  requireUser,
  requireAdmin,
  userFromRequest,
  spendCredit,
  addCredit,
  refundCredit,
  getProfile,
  logPrompt,
  chargeFirst,
  type AuthedUser,
} from './auth.js';
import { assetsFromContent } from '../runtime/assets.js';
import { extractFinReq, sanitizeFinReq } from '../runtime/finreq.js';
import { createKey, listKeys, revokeKey, missingTable, MAX_ACTIVE_KEYS, userFromApiKey } from './keys.js';
import { xLinkConfigured, beginLink, completeLink, getXAccount, unlinkXAccount } from './xlink.js';
import { executeRunSSE, buildScreenInput, abortWhenClientGone } from './run.js';
import { RunAbortedError, withRunSignal } from '../runtime/runsignal.js';
import { selectAllPages } from './paging.js';
import { clipText } from '../runtime/text.js';
import { fullAbout, isUniverseName, onchainChart, startUniverseWarmer, universeAssetData, universeDataAsOf, UNIVERSES } from '../runtime/universe.js';
import {
  ATTRIBUTION,
  displayFlags,
  fullUniverseAbout,
  mayShow,
  presentUniverseAsOf,
  presentUniverseAsset,
  universeAttribution,
  universeMarketNote,
  type Channel,
} from '../runtime/display-policy.js';
import { handleMcp } from './mcp.js';
import { assertAuthConfigured, bindHost, isDeployedEnv, refuseDevRequest, refuseOpenModeRequest } from './access.js';
import {
  acquireExtractSlot,
  actorKey,
  assertRunSlotAvailable,
  consume,
  consumeIp,
  consumeUnchargedLlm,
  tryConsume,
  warnIfTrustProxyUnset,
  type LimitName,
} from './ratelimit.js';
import { PublicError, runFailureNotes, toPublicError, withRunFailureNotes, type ErrorCode } from '../runtime/errors.js';
import {
  ClientFinReqSchema,
  MAX_DOC_CHARS,
  MAX_SCREEN_THESIS_CHARS,
  V1ScreenBody,
  UNSUPPORTED_MEDIA_MESSAGE,
  contentTypeAllowed,
  normalizeJsonContentType,
  parseClientThesis,
  parseOr400,
  requireObject,
} from './validate.js';
import { TtlSingleFlight } from './cache.js';
import { hardenHttpServer, httpServerOptions } from './http-hardening.js';
import { z } from 'zod';

const PORT = Number(process.env.PORT ?? 8787);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65_535) {
  throw new Error(`Invalid PORT: ${process.env.PORT ?? ''}`);
}
// Only /api/extract carries media: a 25 MiB audio file grows ~33% as base64
// (about 33.4 MiB) plus the JSON envelope. Every other endpoint is text and
// gets a much smaller ceiling (a 100k-char document is under 0.5 MiB).
const MAX_EXTRACT_BODY_BYTES = 35 * 1024 * 1024;
const MAX_JSON_BODY_BYTES = 1024 * 1024;

// A refuse-to-start check, before anything binds a port (security audit H4).
assertAuthConfigured();

// Security headers on every response (2026-07-21 audit). Each CSP allowance
// maps to something the app actually loads: Google Fonts css/woff2, pdf.js
// served same-origin from the pdfjs-dist package (/vendor/pdfjs/, module
// script plus module worker, security audit M4), asset logos/favicons from
// arbitrary https hosts (FMP, CoinGecko, google s2, duckduckgo), and the
// browser's direct Supabase auth/REST calls. Next.js dev mode additionally
// needs eval (source maps) and a websocket (HMR); those two never ship to a
// deployed environment.
const IS_DEPLOYED = process.env.NODE_ENV === 'production' || Boolean(process.env.RAILWAY_ENVIRONMENT);
const CSP = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${IS_DEPLOYED ? '' : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: https:",
  `connect-src 'self' https://*.supabase.co${IS_DEPLOYED ? '' : ' ws:'}`,
  "worker-src 'self' blob:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

function setSecurityHeaders(res: http.ServerResponse) {
  res.setHeader('content-security-policy', CSP);
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
  // The composer's voice notes record via MediaRecorder, so the microphone
  // stays allowed for our own origin.
  res.setHeader('permissions-policy', 'microphone=(self), camera=(), geolocation=(), payment=()');
  if (IS_DEPLOYED) res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
}

async function readBody(req: http.IncomingMessage, maxBytes: number): Promise<string> {
  // Reject on the declared length first: no bytes are buffered for a body the
  // client already admits is too big. The streamed count below is the real cap.
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new PublicError(413, 'payload_too_large', 'Request body is too large.');
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const c of req) {
    const chunk = Buffer.isBuffer(c) ? c : Buffer.from(c);
    bytes += chunk.length;
    if (bytes > maxBytes) throw new PublicError(413, 'payload_too_large', 'Request body is too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Read and parse a JSON object body. `contentTypes` (validate.ts):
 * 'strict' for the browser /api/* routes (the body must declare JSON: a
 * text/plain or form POST is what a cross-site page can send without a CORS
 * preflight, audit L4), 'lenient' for /v1/* (anything but a form or multipart
 * body is parsed as JSON, e2e R5).
 */
async function readJson<T extends object>(
  req: http.IncomingMessage,
  maxBytes = MAX_JSON_BODY_BYTES,
  contentTypes: 'strict' | 'lenient' = 'strict',
): Promise<T> {
  const hasBody = Number(req.headers['content-length'] ?? 0) > 0 || req.headers['transfer-encoding'] !== undefined;
  if (hasBody && !contentTypeAllowed(req.headers['content-type'], contentTypes)) {
    throw new PublicError(415, 'unsupported_media', UNSUPPORTED_MEDIA_MESSAGE);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse((await readBody(req, maxBytes)) || '{}');
  } catch (err) {
    if (err instanceof PublicError) throw err;
    throw new PublicError(400, 'bad_request', 'Invalid JSON request body.');
  }
  // `null`, arrays and primitives are valid JSON but never a valid body: 400, not a 500.
  return requireObject<T>(parsed);
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

/**
 * pdf.js, self-hosted (security audit M4): the browser imports the library and
 * its worker from the pdfjs-dist package through these two fixed paths, so no
 * third-party CDN script runs on the signed-in origin. The legacy build keeps
 * older Safari and iOS working. Exact-path allowlist, read once and kept in
 * memory; every load revalidates (ETag = package version), so an upgrade can
 * never pair a cached library with a new worker.
 */
const PDFJS_FILES: Record<string, string> = {
  '/vendor/pdfjs/pdf.min.mjs': 'legacy/build/pdf.min.mjs',
  '/vendor/pdfjs/pdf.worker.min.mjs': 'legacy/build/pdf.worker.min.mjs',
};
const pdfjsBodies = new Map<string, Buffer>();
let pdfjsPackage: { dir: string; version: string } | null = null;

function pdfjsPkg(): { dir: string; version: string } {
  if (!pdfjsPackage) {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve('pdfjs-dist/package.json');
    pdfjsPackage = { dir: dirname(pkgPath), version: String((require(pkgPath) as { version?: unknown }).version ?? '0') };
  }
  return pdfjsPackage;
}

/** Answer one of the PDFJS_FILES paths; false for anything else. */
async function servePdfjs(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): Promise<boolean> {
  const rel = Object.hasOwn(PDFJS_FILES, pathname) ? PDFJS_FILES[pathname] : undefined;
  if (!rel) return false;
  const method = req.method ?? 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' });
    res.end();
    return true;
  }
  const pkg = pdfjsPkg();
  const etag = `"pdfjs-${pkg.version}-${basename(rel)}"`;
  const headers = { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, no-cache', etag };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return true;
  }
  let body = pdfjsBodies.get(rel);
  if (!body) {
    body = await readFile(join(pkg.dir, rel));
    pdfjsBodies.set(rel, body);
  }
  res.writeHead(200, { ...headers, 'content-length': String(body.length) });
  res.end(method === 'HEAD' ? undefined : body);
  return true;
}

/** The stable client error shape: {error, code} (+ optional extras such as credits). */
function sendError(
  res: http.ServerResponse,
  status: number,
  code: ErrorCode,
  error: string,
  extra: Record<string, unknown> = {},
) {
  sendJson(res, status, { error, code, ...extra });
}

/** Per-user (or per-IP when anonymous) budget for the paid-LLM endpoints. Loopback dev is exempt. */
function enforceUserLimit(req: http.IncomingMessage, user: AuthedUser | null, name: LimitName) {
  if (isLocalRequest(req)) return;
  consume(name, actorKey(user, req));
}

/**
 * The uncharged LLM routes (/api/thesis, /api/extract) on top of the hourly
 * bucket (final audit H1): a daily quota per user (RATE_LLM_PER_USER_DAY,
 * default 40) and a service-wide daily budget (RATE_LLM_GLOBAL_PER_DAY, default
 * 1500), after which these routes answer 429 until midnight UTC. In memory,
 * like every limit here. Loopback dev is exempt.
 */
function enforceUnchargedBudget(req: http.IncomingMessage, user: AuthedUser | null) {
  if (isLocalRequest(req)) return;
  consumeUnchargedLlm(actorKey(user, req));
}

/** The gate for every paid lookup behind a link or a review: the web-search
 * fallbacks, the ytscribe transcript and the thesis web entity check. */
function webSearchGate(req: http.IncomingMessage, user: AuthedUser | null) {
  return () => isLocalRequest(req) || tryConsume('websearch', actorKey(user, req));
}

/**
 * Rethrow an error raised before a run's stream started with the request's
 * failure notes appended (final audit L5: "the refund was refused, the credit
 * stays charged"), so the router's {error, code} answer says so. The original
 * error is logged here because the router only sees the rewritten one.
 */
function withFailureNotes(err: unknown): unknown {
  const notes = runFailureNotes();
  if (!notes || err instanceof RunAbortedError) return err;
  const mapped = toPublicError(err);
  log.error('request failed and its credit was not refunded', err);
  return new PublicError(mapped.status, mapped.body.code, `${mapped.body.error} ${notes}`, mapped.retryAfterSec);
}

/** Stage 1: extract + return the structured thesis for review/editing. */
async function handleThesis(req: http.IncomingMessage, res: http.ServerResponse) {
  const user = await requireUser(req, res);
  if (user === undefined) return;
  // Two paid LLM calls per request and no credit charge: hourly and daily
  // budgets per user plus the service-wide daily budget (audit H2, final H1).
  enforceUserLimit(req, user, 'llm');
  enforceUnchargedBudget(req, user);
  const body = await readJson<{ text?: unknown; log?: unknown }>(req);
  if (body.text !== undefined && typeof body.text !== 'string') {
    throw new PublicError(400, 'bad_request', 'text must be a string.');
  }
  const text = (typeof body.text === 'string' ? body.text : '').trim().slice(0, MAX_DOC_CHARS);
  if (!text) {
    sendError(res, 400, 'bad_request', 'Provide a thesis prompt.');
    return;
  }
  // Per-user prompt log (db/prompt_log.sql), never blocks the run. `log` is
  // the frontend's compact view of the same input (links as URL only,
  // screenshots/files as a placeholder, voice notes as full transcript,
  // user decision 2026-07-16); the full text is the fallback. logPrompt keeps
  // an excerpt (PROMPT_LOG_MAX_CHARS); the pipeline below gets the full text.
  const logText = typeof body.log === 'string' && body.log.trim() ? body.log.trim() : text;
  logPrompt(user, logText);
  // The requirement extraction runs in PARALLEL with the thesis (spec §15.3):
  // the review card has to show the requirements as editable chips, so they
  // must exist before the card renders, not when the run starts.
  // A closed tab stops the (uncharged) model calls too (review R12). The web
  // entity check rides the per-user web-lookup budget (final audit H1).
  const [thesis, finReq] = await withRunSignal(abortWhenClientGone(res), () =>
    Promise.all([buildThesis(text, { allowWebSearch: webSearchGate(req, user) }), extractFinReq(text)]),
  );
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ thesis, finReq }));
}

/** Extract text from an added source: link (tweet/YouTube/article), image, or voice note. */
async function handleExtract(req: http.IncomingMessage, res: http.ServerResponse) {
  // Auth before the body read: extract accepts 35MB payloads, so reject
  // anonymous callers before buffering anything.
  const user = await requireUser(req, res);
  if (user === undefined) return;
  // Rate limit before buffering too: vision/audio/transcript calls are the
  // costliest uncharged path (audit H2). Images (5 MB) and audio (25 MB) stay
  // allowed, only behind this budget.
  enforceUserLimit(req, user, 'llm');
  // Before the body is buffered: at most EXTRACT_MAX_CONCURRENT (4) bodies in
  // memory server-wide and one per user (final audit M2). Loopback dev only
  // takes the server-wide slot.
  const release = acquireExtractSlot(isLocalRequest(req) ? null : actorKey(user, req));
  try {
    enforceUnchargedBudget(req, user);
    const body = await readJson<{
      kind?: unknown;
      url?: unknown;
      media_type?: unknown;
      data?: unknown; // base64
    }>(req, MAX_EXTRACT_BODY_BYTES);
    // Errors keep their curated message and code (PublicError from the extractors);
    // anything else is logged and answered generically by the router (audit M4).
    // A closed tab stops the vision/audio/web-search call too (review R12).
    const out = await withRunSignal(abortWhenClientGone(res), async () =>
      body.kind === 'link'
        ? await extractLink(String(body.url ?? ''), { allowWebSearch: webSearchGate(req, user) })
        : body.kind === 'image'
          ? await extractImage(String(body.media_type ?? ''), typeof body.data === 'string' ? body.data : '')
          : body.kind === 'audio'
            ? await extractAudio(String(body.media_type ?? ''), typeof body.data === 'string' ? body.data : '')
            : (() => {
                throw new PublicError(400, 'bad_request', 'kind must be link, image or audio.');
              })(),
    );
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out));
  } finally {
    release();
  }
}

/** Interview answers → Crit (v3 finishInterview mapping). */
const ASEL_MAP: Record<string, string[]> = {
  stock: ['stock'], crypto: ['crypto'], etf: ['etf'], bond: ['bond'],
  preipo: ['private'],
  both: ['stock', 'crypto'],
};
/** Interview answers as posted: strings (single choice) or string lists (multi choice). */
interface Answers {
  asset_class?: string | null;
  geography?: string[] | null;
  cap?: string[] | null;
  risk?: string | null;
  horizon?: string | null;
  familiarity?: string | null;
  crypto_venue?: string | null;
  exclusions?: string[] | null;
  spread?: string | null;
}

const answerStr = (max: number) => z.string().max(max);
const answerList = z.array(answerStr(60)).max(20);
/**
 * Client-supplied POST /api/complete body. Everything is bounded so a request
 * cannot inflate the prompts or the Voyage query fan-out (audit M6). The
 * thesis itself is validated separately by parseClientThesis. Unknown keys are
 * dropped.
 */
const CompleteBody = z.object({
  text: z.string().optional(),
  thesis: z.unknown().optional(),
  extraReq: z.string().max(4000).nullish(),
  answers: z
    .object({
      asset_class: answerStr(40).nullish(),
      geography: answerList.nullish(),
      cap: answerList.nullish(),
      risk: answerStr(60).nullish(),
      horizon: answerStr(60).nullish(),
      familiarity: answerStr(60).nullish(),
      crypto_venue: answerStr(60).nullish(),
      exclusions: answerList.nullish(),
      spread: answerStr(60).nullish(),
    })
    .nullish(),
  breadth: z.string().max(40).nullish(),
  cardCrit: z
    .object({
      asset_set: answerList.nullish(),
      region_set: answerList.nullish(),
      cap_set: answerList.nullish(),
      cn_hkex_only: z.boolean().nullish(),
    })
    .nullish(),
  rerun: z.boolean().nullish(),
  /** Requirements as they stood on the review card, after the user's edits (sanitized by sanitizeFinReq). */
  finReq: ClientFinReqSchema.nullish(),
});

function answersToCrit(A: Answers): Crit {
  return {
    expert: true,
    constrained: true,
    asset_set: A.asset_class ? (ASEL_MAP[A.asset_class] ?? [A.asset_class]).slice() : [],
    region_set: regionSet(A.geography ?? undefined),
    cap_set: (A.cap ?? []).slice(),
    exclusions_set: (A.exclusions ?? []).slice(),
    cex_only: A.crypto_venue === 'cex',
    risk: A.risk ?? undefined, horizon: A.horizon ?? undefined, familiarity: A.familiarity ?? undefined, spread: A.spread ?? undefined,
  };
}

/** Stage 2: reviewed thesis (+ optional extra requirements and interview answers)
 *  → candidates → select → audit → analysis → market, streamed over SSE. */
async function handleComplete(req: http.IncomingMessage, res: http.ServerResponse) {
  const user = await requireUser(req, res);
  if (user === undefined) return;
  // Burst guard on top of the 1-credit charge and the concurrent-run cap
  // (the cap itself is taken in performRun, before the charge).
  enforceUserLimit(req, user, 'run');
  const body = parseOr400(CompleteBody, await readJson(req), 'request');
  const text = (body.text ?? '').trim().slice(0, MAX_DOC_CHARS);
  // The posted thesis is untrusted: validated, size-capped and stripped of
  // unknown keys, then rebuilt (audit M6). Direction must be long/short/both;
  // strategy chips are the user's final word, trimmed to <= 5 chips of <= 60
  // chars (§6). A missing thesis keeps the old 400 below.
  const thesis = body.thesis == null ? undefined : parseClientThesis(body.thesis);
  // Breadth (§6): 'diversified' is the explicit opt-in; anything else runs
  // Focused — the standard behavior.
  const breadth = body.breadth === 'diversified' ? ('diversified' as const) : ('focused' as const);
  if (!text || !thesis?.summary) {
    sendError(res, 400, 'bad_request', 'Missing document text or thesis.');
    return;
  }
  // Requirements = document's (docCrit) + the plain-language box + interview
  // answers, merged with v3 semantics (restrictive replace, exclusions add).
  let crit: Crit = thesis.docCrit ?? { constrained: true };
  const extraReq = (body.extraReq ?? '').trim();
  if (extraReq.length > 2) {
    const box = offlineConstraints(extraReq);
    box.constraint_note = box.constraint_note ?? clipText(extraReq, 140); // compliance enforces verbatim
    crit = mergeCrit(crit, box);
  }
  // Review-card selectors (spec §6): binding, merged after the box so an
  // explicit click beats prose, but before interview answers (asked later).
  // 'polymarket' is not a DB kind — it gates the prediction-market path (§5.8).
  const cardSel = (body.cardCrit?.asset_set ?? []).filter((v) =>
    ['stock', 'crypto', 'etf', 'bond', 'private', 'polymarket'].includes(v),
  );
  const assetKinds = cardSel.filter((v) => v !== 'polymarket');
  const pmOnly = cardSel.includes('polymarket') && assetKinds.length === 0;
  const wantsPm = cardSel.length === 0 || cardSel.includes('polymarket');
  const cardRegions = (body.cardCrit?.region_set ?? []).filter((v) =>
    ['us', 'eu', 'cn', 'it', 'other'].includes(v),
  );
  // Mcap band(s) — already expanded to DB cap_class values by the card (§6).
  const cardCaps = (body.cardCrit?.cap_set ?? []).filter((v) =>
    ['mega', 'large', 'mid', 'small', 'micro'].includes(v),
  );
  if (assetKinds.length || cardRegions.length || cardCaps.length) {
    const cc: Crit = { constrained: true };
    if (assetKinds.length) cc.asset_set = assetKinds;
    if (cardRegions.length) cc.region_set = cardRegions;
    if (cardCaps.length) cc.cap_set = cardCaps;
    if (body.cardCrit?.cn_hkex_only === true && cardRegions.includes('cn')) cc.cn_hkex_only = true;
    crit = mergeCrit(crit, cc);
  }
  if (body.answers) crit = mergeCrit(crit, answersToCrit(body.answers));
  // Re-runs never pass /api/thesis, so the admin prompt log would miss them
  // (user decision 2026-07-16); executeRunSSE logs after a successful charge.
  // The notes scope lets a refused refund (daily cap, final audit L5) show up
  // in the run's error event instead of a silent charge.
  await withRunFailureNotes(() =>
    executeRunSSE(
      user,
      {
        text,
        thesis,
        crit,
        wantsPm,
        pmOnly,
        breadth,
        finReq: sanitizeFinReq(body.finReq),
        promptLog: body.rerun ? `[Re-run] ${(thesis?.summary ?? text).slice(0, 2000)}` : undefined,
        // The browser app: the website channel of the display policy.
        channel: 'web',
      },
      res,
    ).catch((err) => {
      throw withFailureNotes(err);
    }),
  );
}

/** Public browser config: whether auth binds, and where to sign in. */
async function handleConfig(req: http.IncomingMessage, res: http.ServerResponse) {
  // Localhost skips the gate: Supabase only redirects OAuth back to the
  // production site URL, so sign-in can never complete in local dev.
  const active = authEnabled() && !isLocalRequest(req);
  sendJson(res, 200, {
    authRequired: active,
    supabaseUrl: active ? env.SUPABASE_URL : null,
    // The publishable (anon) key is public by design; RLS + service-only RPCs
    // are the actual protection.
    supabaseAnonKey: env.SUPABASE_ANON_KEY || null,
  });
}

/** Signed-in profile + today's balance (lazy daily reset happens in the peek). */
async function handleMe(req: http.IncomingMessage, res: http.ServerResponse) {
  if (!authEnabled() || isLocalRequest(req)) {
    sendJson(res, 200, { authRequired: false });
    return;
  }
  const user = await requireUser(req, res);
  if (!user) return;
  const peek = await spendCredit(user.id, 0, 'daily_reset');
  const profile = await getProfile(user.id);
  const xAccount = await getXAccount(user.id);
  sendJson(res, 200, {
    authRequired: true,
    email: user.email,
    credits: peek.credits,
    cap: peek.cap,
    isAdmin: Boolean(profile?.is_admin),
    xHandle: xAccount?.x_handle ?? null,
  });
}

/**
 * API key management (spec §13), session-authed. Keys only exist where
 * sign-in does: auth-off servers (local dev) run /v1 open instead, so key
 * management there answers with a pointer to the deployed site.
 */
function keysUnavailable(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  if (authEnabled() && !isLocalRequest(req)) return false;
  sendError(
    res,
    503,
    'forbidden',
    isLocalRequest(req)
      ? 'Sign-in is skipped on localhost, so API keys are managed on the deployed site.'
      : 'Beta auth is not enabled on this server, so API keys are unavailable.',
  );
  return true;
}

async function handleKeysList(req: http.IncomingMessage, res: http.ServerResponse) {
  if (keysUnavailable(req, res)) return;
  const user = await requireUser(req, res);
  if (!user) return;
  const keys = await listKeys(user.id);
  if (keys === null) {
    sendJson(res, 200, {
      keys: [],
      warning: 'The api_keys table was not found. Run db/api_keys.sql once in the Supabase SQL editor.',
    });
    return;
  }
  sendJson(res, 200, { keys, maxActive: MAX_ACTIVE_KEYS });
}

async function handleKeysCreate(req: http.IncomingMessage, res: http.ServerResponse) {
  if (keysUnavailable(req, res)) return;
  const user = await requireUser(req, res);
  if (!user) return;
  const body = await readJson<{ name?: string }>(req);
  const out = await createKey(user, String(body.name ?? ''));
  if (!out.ok) {
    sendError(res, 409, 'bad_request', out.error);
    return;
  }
  // The only response that ever carries the full key.
  sendJson(res, 200, { key: out.key, row: out.row });
}

async function handleKeysRevoke(req: http.IncomingMessage, res: http.ServerResponse) {
  if (keysUnavailable(req, res)) return;
  const user = await requireUser(req, res);
  if (!user) return;
  const body = await readJson<{ id?: string }>(req);
  const id = String(body.id ?? '');
  if (!id) {
    sendError(res, 400, 'bad_request', 'id is required.');
    return;
  }
  const revoked = await revokeKey(user.id, id);
  if (!revoked) {
    sendError(res, 404, 'not_found', 'No active key with that id.');
    return;
  }
  sendJson(res, 200, { ok: true });
}

/** Debit 1 credit for a PDF report download (spec §12). Auth off = free. */
async function handlePdfCredit(req: http.IncomingMessage, res: http.ServerResponse) {
  const user = await requireUser(req, res);
  if (user === undefined) return;
  if (!user) {
    sendJson(res, 200, { ok: true, credits: null });
    return;
  }
  const spend = await spendCredit(user.id, 1, 'pdf');
  if (!spend.ok) {
    sendError(res, 402, 'payment_required', 'No credits left today. Credits refresh every day at midnight UTC.', {
      credits: spend.credits,
      cap: spend.cap,
    });
    return;
  }
  sendJson(res, 200, { ok: true, credits: spend.credits, cap: spend.cap });
}

/**
 * X account linking (spec §14), session-authed. Links only exist where
 * sign-in does, and need the X app env; anything else answers with a pointer,
 * the API-keys pattern.
 */
function xLinkUnavailable(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  if (authEnabled() && !isLocalRequest(req) && xLinkConfigured()) return false;
  sendError(
    res,
    503,
    'forbidden',
    isLocalRequest(req)
      ? 'Sign-in is skipped on localhost, so X linking happens on the deployed site.'
      : !authEnabled()
        ? 'Beta auth is not enabled on this server, so X linking is unavailable.'
        : 'X linking is not configured on this server (set X_CLIENT_ID and X_REDIRECT_URL).',
  );
  return true;
}

/** Start the link: hand the browser the X authorize URL to navigate to. */
async function handleXLink(req: http.IncomingMessage, res: http.ServerResponse) {
  if (xLinkUnavailable(req, res)) return;
  const user = await requireUser(req, res);
  if (!user) return;
  sendJson(res, 200, { url: beginLink(user.id) });
}

/**
 * Browser redirect back from X. Always answers with a redirect to /?x=…
 * (linked | taken | denied | error) — the frontend turns it into a notice.
 */
async function handleXCallback(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const redirect = (outcome: string) => {
    res.writeHead(302, { location: `/?x=${outcome}` });
    res.end();
  };
  if (!authEnabled() || isLocalRequest(req) || !xLinkConfigured()) return redirect('error');
  if (url.searchParams.get('error')) return redirect('denied');
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) return redirect('error');
  return redirect(await completeLink(code, state));
}

async function handleXUnlink(req: http.IncomingMessage, res: http.ServerResponse) {
  if (xLinkUnavailable(req, res)) return;
  const user = await requireUser(req, res);
  if (!user) return;
  await unlinkXAccount(user.id);
  sendJson(res, 200, { ok: true });
}

/** Admin: every profile plus today's spend, for the /admin panel. */
async function handleAdminUsers(req: http.IncomingMessage, res: http.ServerResponse) {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  // Paged (review B8): an unranged select stops silently at 1,000 rows.
  const { data: profiles, error } = await selectAllPages((from, to) =>
    supabase
      .from('profiles')
      .select('id, email, credits, daily_cap, credits_date, is_admin, created_at')
      .order('created_at', { ascending: true })
      .order('id')
      .range(from, to),
  );
  if (error) throw new Error(`profiles read failed: ${error.message}`);
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const { data: ledger, error: ledgerErr } = await selectAllPages((from, to) =>
    supabase
      .from('credit_ledger')
      .select('user_id, reason')
      .gte('created_at', dayStart.toISOString())
      .order('id')
      .range(from, to),
  );
  if (ledgerErr) throw new Error(`ledger read failed: ${ledgerErr.message}`);
  const usage = new Map<string, { searches: number; pdfs: number }>();
  for (const row of ledger ?? []) {
    const u = usage.get(row.user_id) ?? { searches: 0, pdfs: 0 };
    if (row.reason === 'search') u.searches += 1;
    if (row.reason === 'pdf') u.pdfs += 1;
    usage.set(row.user_id, u);
  }
  // API keys created per user (spec §13). A missing api_keys table means the
  // migration hasn't run yet: show zeros rather than break the panel.
  const keyCounts = new Map<string, { active: number; created: number }>();
  const { data: keys, error: keysErr } = await selectAllPages((from, to) =>
    supabase.from('api_keys').select('user_id, revoked_at').order('id').range(from, to),
  );
  if (keysErr && !missingTable(keysErr.message)) {
    throw new Error(`api_keys read failed: ${keysErr.message}`);
  }
  for (const k of keys ?? []) {
    const c = keyCounts.get(k.user_id) ?? { active: 0, created: 0 };
    c.created += 1;
    if (!k.revoked_at) c.active += 1;
    keyCounts.set(k.user_id, c);
  }
  sendJson(res, 200, {
    users: (profiles ?? []).map((p) => ({
      ...p,
      // A stale credits_date means the lazy reset hasn't run today: show the
      // balance the user would actually see (full cap), not yesterday's rest.
      credits: p.credits_date < new Date().toISOString().slice(0, 10) ? p.daily_cap : p.credits,
      today: usage.get(p.id) ?? { searches: 0, pdfs: 0 },
      api_keys: keyCounts.get(p.id) ?? { active: 0, created: 0 },
    })),
  });
}

/** Admin: latest submitted research prompts (db/prompt_log.sql), for the /admin panel. */
async function handleAdminPrompts(req: http.IncomingMessage, res: http.ServerResponse) {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { data, error } = await supabase
    .from('prompt_log')
    .select('id, email, prompt, created_at')
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) {
    // Table not created yet: the panel should say so, not break.
    sendJson(res, 200, {
      prompts: [],
      warning: 'The prompt_log table was not found. Run db/prompt_log.sql once in the Supabase SQL editor.',
    });
    return;
  }
  sendJson(res, 200, {
    prompts: (data ?? []).map((p) => ({
      id: p.id,
      email: p.email,
      created_at: p.created_at,
      chars: p.prompt.length,
      // The full prompt can be 100k chars; the panel shows an excerpt.
      prompt: p.prompt.slice(0, 2000),
    })),
  });
}

/** Admin: adjust a user — permanent daily cap, one-day grant, or set today's balance. */
async function handleAdminAdjust(req: http.IncomingMessage, res: http.ServerResponse) {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const body = await readJson<{ userId?: string; action?: string; value?: number }>(req);
  const userId = String(body.userId ?? '');
  const value = Math.trunc(Number(body.value));
  if (!userId || !Number.isFinite(value)) {
    sendError(res, 400, 'bad_request', 'userId and a numeric value are required.');
    return;
  }
  if (body.action === 'set_cap') {
    const cap = Math.min(Math.max(value, 0), 1000);
    const { error } = await supabase.from('profiles').update({ daily_cap: cap }).eq('id', userId);
    if (error) throw new Error(`cap update failed: ${error.message}`);
    const profile = await getProfile(userId);
    sendJson(res, 200, { ok: true, credits: profile?.credits ?? 0, cap });
    return;
  }
  if (body.action === 'grant') {
    const out = await addCredit(userId, Math.min(Math.max(value, -1000), 1000), 'admin_grant');
    sendJson(res, 200, out);
    return;
  }
  if (body.action === 'set_credits') {
    // Set today's balance to an absolute value (0 = revoke the rest of today).
    const peek = await spendCredit(userId, 0, 'daily_reset');
    const out = await addCredit(userId, Math.min(Math.max(value, 0), 1000) - peek.credits, 'admin_set');
    sendJson(res, 200, out);
    return;
  }
  sendError(res, 400, 'bad_request', 'action must be set_cap, grant or set_credits.');
}

/**
 * Public API v1 (spec §13): programmatic runs authenticated with a personal
 * API key (server/keys.ts). Auth-off servers (no SUPABASE_ANON_KEY, or
 * localhost) run /v1 open, mirroring the app's deploy-time switch.
 */
async function v1User(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<AuthedUser | null | undefined> {
  if (!authEnabled() || isLocalRequest(req)) return null;
  const user = await userFromApiKey(req);
  if (!user) {
    sendError(
      res,
      401,
      'unauthorized',
      'A valid API key is required: Authorization: Bearer stk_… (or x-api-key). Create one on synthetick.org in the API section.',
    );
    return undefined;
  }
  return user;
}

/** POST /v1/screen — thesis text in, SSE run out (status/credits/result/error).
 * Auth: API key, or a signed-in session (the /universe thesis bar streams
 * through here, mirroring /v1/assets) — both spend the same daily credits. */
async function handleV1Screen(req: http.IncomingMessage, res: http.ServerResponse) {
  let user: AuthedUser | null = null;
  // Display policy channel: an API key (or an open dev server) is the API; a
  // signed-in browser session is the website.
  let channel: Channel = 'api';
  if (authEnabled() && !isLocalRequest(req)) {
    const keyUser = await userFromApiKey(req);
    user = keyUser ?? (await userFromRequest(req));
    if (!user) {
      sendError(
        res,
        401,
        'unauthorized',
        'A valid API key (Authorization: Bearer stk_…) or signed-in session is required. Create a key on synthetick.org in the API section.',
      );
      return;
    }
    channel = keyUser ? 'api' : 'web';
  }
  enforceUserLimit(req, user, 'run');
  // Validated BEFORE any LLM call or charge: wrong types and unknown enum
  // values (regions:["mars"]) are a 400, never silently dropped. API clients
  // may omit the JSON content type (e2e R5).
  const body = parseOr400(V1ScreenBody, await readJson(req, MAX_JSON_BODY_BYTES, 'lenient'), 'request');
  const text = body.thesis.trim().slice(0, MAX_SCREEN_THESIS_CHARS);
  if (text.length < 8) {
    sendError(res, 400, 'bad_request', 'Provide a thesis: a few sentences describing the investment case.');
    return;
  }
  // A run the concurrency cap would turn away is refused before the charge.
  if (user) assertRunSlotAvailable(user.id);
  const requestedUniverse = body.universe ?? body.constraints?.universe;
  // Tied to the client from here on (review R12).
  const signal = abortWhenClientGone(res);
  // Charge FIRST, then the paid thesis call, then the run (final audit L4):
  // parallel requests used to pass a balance peek and all run the thesis call
  // before one of them was charged. The run core takes the prepaid credit over;
  // a failure before it does refunds it (within the daily refund cap, L5).
  await withRunFailureNotes(async () => {
    try {
      await chargeFirst(
        user,
        {
          signal,
          onNoCredit: (spent) =>
            sendError(res, 402, 'payment_required', 'No credits left today. Credits refresh every day at midnight UTC.', {
              credits: spent.credits,
              cap: spent.cap,
            }),
        },
        async () => {
          const input = await withRunSignal(signal, () =>
            buildScreenInput(text, { ...(body.constraints ?? {}), universe: requestedUniverse }, body.breadth, '[API]', channel),
          );
          await executeRunSSE(user, input, res, signal);
        },
      );
    } catch (err) {
      throw withFailureNotes(err);
    }
  });
}

/**
 * GET /v1/universe/:name (spec §16) — the tradable-universe registry: token
 * symbols, names and verified contract addresses. Public reference data (it
 * mirrors Robinhood's own public asset API), no key and no credit: execution
 * agents fetch it to build swap allowlists/mandates, and it must stay
 * readable even when the caller's daily budget is spent.
 *
 * GET /v1/universe/:name/assets[/:symbol] (spec §16.2) — the same universe
 * with everything we hold per asset: identity, logo, token contract, and the
 * nightly asset_metrics fundamentals, filtered by the data display policy
 * (runtime/display-policy.ts) for the caller's channel. API key, no credit (a
 * DB read, not a screen). Live prices are the venue's job (/rhj/prices).
 */
/** Keyless browser fetches from our own pages (spec §16.1 Auth, 2026-07-31):
 * Sec-Fetch-Site is set by the browser and not settable from page JS; the
 * Referer host comparison covers browsers that predate fetch metadata. */
function isSameOriginPageRequest(req: http.IncomingMessage): boolean {
  if (req.headers['sec-fetch-site'] === 'same-origin') return true;
  const referer = req.headers.referer;
  const host = req.headers.host;
  if (typeof referer !== 'string' || !host) return false;
  try {
    return new URL(referer).host === host;
  } catch {
    return false;
  }
}

/**
 * The assets records are identical for every caller (nightly data plus cached
 * venue state), so they are built once per universe per 60 s and shared,
 * including while a build is in flight (final audit M3): the keyless explorer
 * path used to run three database queries plus venue lookups on every call. The
 * display policy then shapes each answer for its channel, which is cheap. The
 * same for a single asset's full texts. Keys come from the registry (bounded).
 */
const UNIVERSE_CACHE_TTL_MS = 60_000;
const universeDataCache = new TtlSingleFlight<string, Awaited<ReturnType<typeof universeAssetData>>>(UNIVERSE_CACHE_TTL_MS);
const universeAboutCache = new TtlSingleFlight<string, Awaited<ReturnType<typeof fullAbout>>>(UNIVERSE_CACHE_TTL_MS);

async function handleV1Universe(req: http.IncomingMessage, res: http.ServerResponse, rest: string) {
  const [rawNameCased = '', sub, symbol, extra] = rest.split('/');
  const rawName = rawNameCased.toLowerCase(); // names are lowercase; accept any casing
  if (!isUniverseName(rawName)) {
    sendError(res, 404, 'not_found', `Unknown universe. Available: ${Object.keys(UNIVERSES).join(', ')}.`);
    return;
  }
  const name = rawName;
  if (!sub) {
    res.writeHead(200, {
      'content-type': 'application/json',
      // Regenerated only on deploy: cache generously but not forever.
      'cache-control': 'public, max-age=3600',
    });
    res.end(JSON.stringify(UNIVERSES[name]));
    return;
  }
  if (sub !== 'assets' || (extra !== undefined && !(extra === 'chart' && symbol))) {
    sendError(res, 404, 'not_found', `Unknown universe path. Use /v1/universe/${name} or /v1/universe/${name}/assets[/SYMBOL[/chart]].`);
    return;
  }
  // Auth (spec §16.1, revised 2026-07-31): programmatic use needs an API key
  // or session, but the /universe explorer works signed out, so a keyless
  // request is accepted when it LOOKS like a same-origin page fetch.
  //
  // That hint is spoofable (curl can send Sec-Fetch-Site / Referer), so it is
  // only a soft hint, never a boundary (audit M3): keyless same-origin reads
  // share a small per-IP budget (RATE_UNIVERSE_ANON_PER_IP_MIN, default 30/min)
  // on top of the general universe budget the router already applied, while
  // requests that carry a valid key or session (the in-app docs say "requires
  // an API key") skip it. Chosen as the least-breaking option: the signed-out
  // web explorer keeps working, scraping at volume needs a key and an account.
  //
  // Redistribution (owner decision 2026-10-05): what each caller receives is
  // the display policy's call (runtime/display-policy.ts). The same-origin
  // explorer, signed in or not, is the website channel; an API key is the API
  // channel, which carries no vendor market data unless API_RELAY_MARKET_DATA=1.
  const sameOrigin = isSameOriginPageRequest(req);
  let channel: Channel = sameOrigin ? 'web' : 'api';
  if (authEnabled() && !isLocalRequest(req)) {
    const keyUser = await userFromApiKey(req);
    const user = keyUser ?? (await userFromRequest(req));
    if (!user) {
      if (!sameOrigin) {
        sendError(
          res,
          401,
          'unauthorized',
          'A valid API key (Authorization: Bearer stk_…) or signed-in session is required. Create a key on synthetick.org in the API section.',
        );
        return;
      }
      consumeIp('universe_anon', req, log.warn);
    }
    channel = keyUser ? 'api' : 'web';
  }
  const flags = displayFlags();
  // The answer depends on the caller's channel: never cached by shared caches.
  const headers = { 'content-type': 'application/json', 'cache-control': 'private, max-age=300' };
  const extras = () => {
    const note = universeMarketNote(channel, flags);
    const attribution = universeAttribution(channel, flags);
    return { ...(note ? { market_note: note } : {}), ...(attribution ? { attribution } : {}) };
  };
  // /assets/:symbol/chart — the token's ONCHAIN daily price history (spec
  // §16.1 chart): lazily fetched + cached per symbol, so it never rides the
  // main payload. Null chart = no pool yet or vendor down, never fabricated.
  // GeckoTerminal data: not fetched at all for a channel that may not show it.
  if (extra === 'chart' && symbol) {
    if (!UNIVERSES[name].assets.some((a) => a.symbol.toUpperCase() === symbol.toUpperCase())) {
      sendError(res, 404, 'not_found', `"${symbol.slice(0, 20).toUpperCase()}" is not in the ${name} universe.`);
      return;
    }
    const allowed = mayShow('geckoterminal', channel, flags);
    let chart = null;
    if (allowed) {
      try {
        chart = await onchainChart(name, symbol);
      } catch (err) {
        log.warn(`onchain chart unavailable for ${symbol}: ${(err as Error).message}`);
      }
    }
    res.writeHead(200, headers);
    res.end(
      JSON.stringify({
        symbol: symbol.toUpperCase(),
        chart,
        ...(!allowed ? extras() : channel === 'api' ? { attribution: ATTRIBUTION.geckoterminal } : {}),
      }),
    );
    return;
  }
  const records = await universeDataCache.get(name, () => universeAssetData(name));
  // The cached records are channel-free; the policy shapes each answer.
  const all = records.map((r) => presentUniverseAsset(r, channel, flags));
  if (symbol) {
    const one = all.find((a) => a.ticker.toUpperCase() === symbol.toUpperCase());
    if (!one) {
      sendError(res, 404, 'not_found', `"${symbol.slice(0, 20).toUpperCase()}" is not in the ${name} universe.`);
      return;
    }
    // Single asset carries the FULL description (the list caps at 500 chars),
    // or the full enrichment text when the vendor's may not be shown.
    let about = one.about;
    try {
      const full = await universeAboutCache.get(`${name}:${one.ticker}`, () => fullAbout(name, one.ticker));
      if (full) about = fullUniverseAbout(full, channel, flags) ?? one.about;
    } catch (err) {
      log.warn(`fullAbout(${one.ticker}) failed: ${(err as Error).message}`);
    }
    res.writeHead(200, headers);
    res.end(JSON.stringify({ ...one, about, ...extras() }));
    return;
  }
  res.writeHead(200, headers);
  res.end(
    JSON.stringify({
      universe: name,
      chainId: UNIVERSES[name].chainId,
      count: all.length,
      asOf: presentUniverseAsOf(universeDataAsOf(), channel, flags),
      assets: all,
      ...extras(),
    }),
  );
}

/**
 * POST /v1/assets (spec §14): which assets is this content about? One cheap
 * LLM call + DB resolution + live market data — seconds, not minutes.
 * 1 credit, refunded on failure. Auth: API key or a signed-in session token,
 * the one /v1 route the browser app may also call.
 */
async function handleV1Assets(req: http.IncomingMessage, res: http.ServerResponse) {
  let user: AuthedUser | null = null;
  // Display policy channel, as /v1/screen: a key is the API, a session the website.
  let channel: Channel = 'api';
  if (authEnabled() && !isLocalRequest(req)) {
    const keyUser = await userFromApiKey(req);
    user = keyUser ?? (await userFromRequest(req));
    if (!user) {
      sendError(
        res,
        401,
        'unauthorized',
        'A valid API key (Authorization: Bearer stk_…) or signed-in session is required. Create a key on synthetick.org in the API section.',
      );
      return;
    }
    channel = keyUser ? 'api' : 'web';
  }
  enforceUserLimit(req, user, 'assets');
  // API clients may omit the JSON content type (e2e R5); forms stay a 415.
  const body = await readJson<{ text?: unknown; url?: unknown; request?: unknown }>(req, MAX_JSON_BODY_BYTES, 'lenient');
  for (const k of ['text', 'url', 'request'] as const) {
    if (body[k] !== undefined && body[k] !== null && typeof body[k] !== 'string') {
      throw new PublicError(400, 'bad_request', `${k} must be a string.`);
    }
  }
  let text = String(body.text ?? '')
    .trim()
    .slice(0, 20_000);
  const link = String(body.url ?? '').trim();
  if (!text && !link) {
    sendError(res, 400, 'bad_request', 'Provide text and/or url: the content to read.');
    return;
  }
  // Syntactic URL policy (scheme, credentials, private literals) BEFORE the
  // charge: a malformed or blocked URL costs nothing.
  if (link) assertPublicHttpUrl(link);
  // Charge first, refund on failure, as /v1/screen does (audit M1): the link
  // fetch (possibly a web-search LLM call) must never run for free.
  let credits: number | null = null;
  let cap: number | null = null;
  if (user) {
    const spent = await spendCredit(user.id, 1, 'search');
    if (!spent.ok) {
      sendError(res, 402, 'payment_required', 'No credits left today. Credits refresh every day at midnight UTC.', {
        credits: spent.credits,
        cap: spent.cap,
      });
      return;
    }
    credits = spent.credits;
    cap = spent.cap;
  }
  // The notes scope lets a refused refund (daily cap, final audit L5) show up
  // in the error instead of a silent charge.
  await withRunFailureNotes(async () => {
    try {
      if (link) {
        const ex = await extractLink(link, { allowWebSearch: webSearchGate(req, user) });
        text = `${text}\n\n${ex.text}`.trim().slice(0, 40_000);
      }
      if (user) logPrompt(user, `[API assets] ${text.slice(0, 2000)}`);
      const result = await assetsFromContent(text, String(body.request ?? '').slice(0, 500), { channel });
      sendJson(res, 200, { ...result, credits, cap });
    } catch (err) {
      if (user) await refundCredit(user.id);
      throw withFailureNotes(err);
    }
  });
}

/** GET /v1/me — the key's owner and today's credit balance. */
async function handleV1Me(req: http.IncomingMessage, res: http.ServerResponse) {
  const user = await v1User(req, res);
  if (user === undefined) return;
  if (!user) {
    sendJson(res, 200, { authRequired: false, credits: null, cap: null });
    return;
  }
  const peek = await spendCredit(user.id, 0, 'daily_reset');
  sendJson(res, 200, { email: user.email, credits: peek.credits, cap: peek.cap });
}

// ---- routing ----------------------------------------------------------------

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => Promise<void>;
type Method = 'GET' | 'POST';

/** Exact-path API routes. A path listed here answers 405 + Allow for other methods. */
const API_ROUTES: Record<string, Partial<Record<Method, Handler>>> = {
  '/api/extract': { POST: handleExtract },
  '/api/thesis': { POST: handleThesis },
  '/api/complete': { POST: handleComplete },
  '/api/pdf-credit': { POST: handlePdfCredit },
  '/api/config': { GET: handleConfig },
  '/api/me': { GET: handleMe },
  '/v1/screen': { POST: handleV1Screen },
  '/v1/assets': { POST: handleV1Assets },
  '/v1/me': { GET: handleV1Me },
  '/api/keys': { GET: handleKeysList, POST: handleKeysCreate },
  '/api/keys/revoke': { POST: handleKeysRevoke },
  '/api/x/link': { GET: handleXLink },
  '/api/x/callback': { GET: handleXCallback },
  '/api/x/unlink': { POST: handleXUnlink },
  '/api/admin/users': { GET: handleAdminUsers },
  '/api/admin/prompts': { GET: handleAdminPrompts },
  '/api/admin/adjust': { POST: handleAdminAdjust },
};

const isApiPath = (p: string) => p === '/mcp' || p.startsWith('/api/') || p.startsWith('/v1/');

/**
 * CORS: none by default (the API is Bearer-token and server-to-server; the
 * browser app is same-origin). Set CORS_ORIGINS to a comma-separated list of
 * exact origins to let those browser apps call /v1 and /mcp. Never a wildcard.
 */
const CORS_ORIGINS = new Set(
  (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim().replace(/\/$/, ''))
    .filter(Boolean),
);

function applyCors(req: http.IncomingMessage, res: http.ServerResponse, pathname: string) {
  if (!(pathname === '/mcp' || pathname.startsWith('/v1/'))) return;
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || !CORS_ORIGINS.has(origin)) return;
  res.setHeader('access-control-allow-origin', origin);
  res.setHeader('vary', 'Origin');
  res.setHeader('access-control-expose-headers', 'mcp-session-id, retry-after');
  if (req.method === 'OPTIONS') {
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    res.setHeader(
      'access-control-allow-headers',
      'authorization, content-type, x-api-key, mcp-session-id, mcp-protocol-version, last-event-id',
    );
    res.setHeader('access-control-max-age', '600');
  }
}

/** Per-IP budget for an API request (skipped for loopback dev). */
function ipBudget(req: http.IncomingMessage, pathname: string) {
  if (isLocalRequest(req)) return;
  consumeIp(pathname.startsWith('/v1/universe/') ? 'universe' : 'ip', req, log.warn);
}

const DEV_LOCAL_ONLY_MESSAGE = 'This development server only accepts requests from localhost. Set HOST to expose it on purpose.';

async function route(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const path = url.pathname;
  const method = req.method ?? 'GET';
  applyCors(req, res, path);

  // Development: loopback Host and Origin only, on EVERY path (final audit
  // L1): pages and Next's dev endpoints used to reach Next before this check,
  // so a DNS-rebinding page could load them.
  if (refuseDevRequest(req)) return sendError(res, 403, 'forbidden', DEV_LOCAL_ONLY_MESSAGE);

  // Self-hosted pdf.js (audit M4); Next does not serve node_modules.
  if (path.startsWith('/vendor/pdfjs/') && (await servePdfjs(req, res, path))) return;

  if (!isApiPath(path)) return handleNextRequest(req, res); // pages and static assets

  // An open (auth-off) dev server answers loopback requests only (audit H4, L4).
  if (refuseOpenModeRequest(req, authEnabled())) {
    return sendError(res, 403, 'forbidden', DEV_LOCAL_ONLY_MESSAGE);
  }

  if (path === '/mcp') {
    if (method === 'OPTIONS') {
      res.writeHead(204, { allow: 'POST, OPTIONS' });
      return void res.end();
    }
    // The transport is stateless (server/mcp.ts): no session, so no standalone
    // SSE stream for GET (it held the connection open with nothing to send,
    // e2e E8) and nothing for DELETE to end. The MCP spec allows a 405 here.
    if (method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json', allow: 'POST, OPTIONS' });
      return void res.end(JSON.stringify({ error: 'Method not allowed.', code: 'method_not_allowed' }));
    }
    ipBudget(req, path);
    normalizeJsonContentType(req); // lenient like /v1 (e2e R5); forms and multipart are a 415
    // Same key auth as /v1.
    const mcpUser = await v1User(req, res);
    if (mcpUser === undefined) return;
    return handleMcp(req, res, mcpUser);
  }

  if (path.startsWith('/v1/universe/')) {
    if (method === 'OPTIONS') {
      res.writeHead(204, { allow: 'GET, HEAD, OPTIONS' });
      return void res.end();
    }
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'application/json', allow: 'GET, HEAD, OPTIONS' });
      return void res.end(JSON.stringify({ error: 'Method not allowed.', code: 'method_not_allowed' }));
    }
    ipBudget(req, path);
    return handleV1Universe(req, res, path.slice('/v1/universe/'.length));
  }

  const entry = Object.hasOwn(API_ROUTES, path) ? API_ROUTES[path] : undefined;
  if (!entry) return sendError(res, 404, 'not_found', 'Not found.');
  const allow = [...Object.keys(entry), ...(entry.GET ? ['HEAD'] : []), 'OPTIONS'].join(', ');
  if (method === 'OPTIONS') {
    res.writeHead(204, { allow });
    return void res.end();
  }
  const handler = entry[(method === 'HEAD' ? 'GET' : method) as Method];
  if (!handler) {
    res.writeHead(405, { 'content-type': 'application/json', allow });
    return void res.end(JSON.stringify({ error: 'Method not allowed.', code: 'method_not_allowed' }));
  }
  ipBudget(req, path);
  return handler(req, res, url);
}

const dev = process.env.NODE_ENV !== 'production';
const nextApp = next({ dev });
const handleNextRequest = nextApp.getRequestHandler();

await nextApp.prepare();

// Header/request timeouts, keep-alive and a connection cap (final audit L7):
// they bound RECEIVING a request only, so a run's SSE stream stays open.
const server = http.createServer(httpServerOptions(), async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  setSecurityHeaders(res);
  try {
    return await route(req, res, url);
  } catch (err) {
    // The client went away mid-request (review R12): nobody to answer.
    if (err instanceof RunAbortedError) {
      if (!res.writableEnded) res.end();
      return;
    }
    // Details stay in the server log; the client gets {error, code} only.
    const mapped = toPublicError(err);
    if (mapped.status >= 500) log.error('server error', err);
    else log.warn(`request refused (${mapped.status} ${mapped.body.code}) ${req.method} ${url.pathname}`);
    if (!res.headersSent) {
      res.writeHead(mapped.status, {
        'content-type': 'application/json',
        ...(mapped.retryAfterSec ? { 'retry-after': String(mapped.retryAfterSec) } : {}),
        // An over-long body was refused unread: do not keep the socket for more.
        ...(mapped.status === 413 ? { connection: 'close' } : {}),
      });
    }
    res.end(JSON.stringify(mapped.body));
  }
});
hardenHttpServer(server);

server.listen(PORT, bindHost(), () => {
  log.step(
    `SyntheTick ${dev ? 'development' : 'production'} server → http://localhost:${PORT} ` +
      `(beta auth ${authEnabled() ? 'ENABLED: sign-in + daily credits enforced' : 'off: open access'}` +
      `${bindHost() ? `, bound to ${bindHost()}` : ''})`,
  );
  if (isDeployedEnv() && !authEnabled()) log.warn('ALLOW_OPEN_ACCESS=1: running a deployed server WITHOUT auth, credits or per-user limits.');
  warnIfTrustProxyUnset(process.env, log.warn, isDeployedEnv());
  // Self-hosting hint: clients only ever see a generic "provider unavailable" for
  // upstream failures, so say loudly here what is not configured.
  if (!process.env.OPENROUTER_API_KEY?.trim()) {
    log.warn('OPENROUTER_API_KEY is not set: research runs will fail until you add it to .env (see docs/QUICKSTART.md).');
  }
  startUniverseWarmer();
});

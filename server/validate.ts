/**
 * Request validation shared by the HTTP routes and the MCP tool (security
 * audit M6 and QA findings). One definition of the screen enums, so REST and
 * MCP can never drift apart again. Pure: no env, no network.
 */
import { z } from 'zod';
import type { Thesis } from '../runtime/thesis.js';
import { PublicError } from '../runtime/errors.js';

// ---- shared screen constraint enums ----------------------------------------

export const ASSET_KINDS = ['stock', 'etf', 'bond', 'crypto', 'private', 'polymarket'] as const;
export const REGIONS = ['us', 'eu', 'cn', 'it', 'other'] as const;
export const CAP_CLASSES = ['mega', 'large', 'mid', 'small', 'micro'] as const;
export const BREADTHS = ['focused', 'diversified'] as const;
/** Mirrors Object.keys(UNIVERSES) in runtime/universe.ts; test-security.ts asserts they match. */
export const UNIVERSE_NAMES = ['robinhood'] as const;

/** Constraint fields of a screen request: REST /v1/screen and the MCP run_screen tool both use these. */
export const screenFields = {
  assets: z.array(z.enum(ASSET_KINDS)).max(ASSET_KINDS.length),
  regions: z.array(z.enum(REGIONS)).max(REGIONS.length),
  caps: z.array(z.enum(CAP_CLASSES)).max(CAP_CLASSES.length),
  cn_hkex_only: z.boolean(),
  breadth: z.enum(BREADTHS),
  universe: z.enum(UNIVERSE_NAMES),
};

/** Longest thesis text a programmatic screen accepts (a few paragraphs; the UI path has its own cap). */
export const MAX_SCREEN_THESIS_CHARS = 30_000;
/** Longest document text the browser flow sends to /api/thesis and /api/complete. */
export const MAX_DOC_CHARS = 100_000;

const constraintsSchema = z.object({
  assets: screenFields.assets.optional(),
  regions: screenFields.regions.optional(),
  caps: screenFields.caps.optional(),
  cn_hkex_only: screenFields.cn_hkex_only.optional(),
  universe: screenFields.universe.optional(),
});

/** POST /v1/screen body. Unknown values are rejected BEFORE any charge or LLM call. */
export const V1ScreenBody = z.object({
  thesis: z.string(),
  constraints: constraintsSchema.nullish(),
  breadth: screenFields.breadth.optional(),
  /** Accepted at top level too: universe is a screen mode as much as a constraint. */
  universe: screenFields.universe.optional(),
});

/**
 * Turn a zod failure into a 400 PublicError that names the offending field and
 * (for enums) the allowed values, never the submitted value.
 */
export function badRequestFrom(err: z.ZodError, what = 'request'): PublicError {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const i of err.issues) {
    const path = i.path.map(String).join('.') || '(body)';
    if (seen.has(path)) continue;
    seen.add(path);
    const allowed = i.code === 'invalid_value' && 'values' in i ? ` (one of: ${(i.values as unknown[]).join(', ')})` : '';
    parts.push(`${path}${allowed}`);
    if (parts.length >= 4) break;
  }
  return new PublicError(400, 'bad_request', `Invalid ${what}: check ${parts.join('; ')}.`);
}

/** Parse with a schema or throw a 400 PublicError. */
export function parseOr400<S extends z.ZodType>(schema: S, value: unknown, what?: string): z.infer<S> {
  const r = schema.safeParse(value);
  if (!r.success) throw badRequestFrom(r.error, what);
  return r.data;
}

// ---- request body content type ----------------------------------------------

/** application/json or any +json type, parameters allowed. */
export function declaresJson(contentType: unknown): boolean {
  return /^application\/(?:[\w.+-]+\+)?json\s*(?:;|$)/i.test(String(contentType ?? ''));
}

/** A form or multipart body: what an HTML form (or a cross-site page) sends, never JSON. */
export function isFormBody(contentType: unknown): boolean {
  return /^\s*(?:application\/x-www-form-urlencoded|multipart\/)/i.test(String(contentType ?? ''));
}

/**
 * Which body content types a route accepts (e2e R5).
 *   strict (browser /api/* routes): the body must declare JSON. A text/plain or
 *     form POST is what a cross-site page can send without a CORS preflight,
 *     so it is refused (audit L4); this matters in local open mode.
 *   lenient (/v1/*, /mcp): API clients authenticate with a key in a header, so
 *     they are not CSRF-able; a JSON body sent without a JSON content type (curl
 *     -d without -H, some HTTP libraries) is parsed as JSON. Forms and multipart
 *     are still refused with 415.
 */
export function contentTypeAllowed(contentType: unknown, mode: 'strict' | 'lenient'): boolean {
  return mode === 'strict' ? declaresJson(contentType) : !isFormBody(contentType);
}

export const UNSUPPORTED_MEDIA_MESSAGE = 'Send the request body as JSON with Content-Type: application/json.';

/**
 * /mcp is lenient like /v1 (e2e R5): anything but a form or multipart POST body
 * goes to the MCP transport as JSON. The SDK insists on the header itself, so a
 * missing or non-JSON one is rewritten to application/json, in both the parsed
 * headers and the raw list (the SDK's request adapter may read either). A form
 * or multipart body is a 415.
 */
export function normalizeJsonContentType(req: {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  rawHeaders: string[];
}): void {
  if (req.method !== 'POST') return;
  const ct = req.headers['content-type'];
  if (!contentTypeAllowed(ct, 'lenient')) throw new PublicError(415, 'unsupported_media', UNSUPPORTED_MEDIA_MESSAGE);
  if (declaresJson(ct)) return;
  req.headers['content-type'] = 'application/json';
  const raw = req.rawHeaders;
  for (let i = raw.length - 2; i >= 0; i -= 2) {
    if (raw[i]?.toLowerCase() === 'content-type') raw.splice(i, 2);
  }
  raw.push('Content-Type', 'application/json');
}

/** JSON body must be a plain object: `null`, arrays and primitives are a 400, not a 500. */
export function requireObject<T extends object>(value: unknown): T {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new PublicError(400, 'bad_request', 'The request body must be a JSON object.');
  }
  return value as T;
}

// ---- client-supplied thesis (POST /api/complete) ---------------------------
//
// The browser posts back what /api/thesis produced, after the user's edits. The
// size caps TRUNCATE (e2e R4): the extractor does not cap every field at the
// source, and a 400 on the server's own output left the user with no way out
// ("Try again" repeated the same request). Wrong TYPES are still a 400. The
// whole body is bounded by the 1 MB JSON limit before any of this runs.

/** A string cut to `max` characters (never rejected for its length). */
const str = (max: number) => z.string().transform((s) => s.slice(0, max));
/** A list of strings: each cut to `itemMax`, the list cut to `maxItems`. */
const strList = (itemMax: number, maxItems: number) =>
  z.array(z.string()).transform((a) => a.slice(0, maxItems).map((s) => s.slice(0, itemMax)));
/** A list of anything cut to `maxItems` entries (item shapes validated by `item`). */
const cappedList = <T extends z.ZodType>(item: T, maxItems: number) =>
  z.array(item).transform((a) => a.slice(0, maxItems));
/** JSON from the browser may carry explicit nulls for "unset": treat them as absent. */
const dropNulls = (v: unknown) =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null))
    : v;

/** The shape /api/thesis returns, with hard size caps: the client sends it back after review/editing. */
export const ClientThesisSchema = z.preprocess(dropNulls, z.object({
  title: str(300).default(''),
  stance: str(2000).default(''),
  summary: z.string().min(1).transform((s) => s.slice(0, 8000)),
  intent: z.enum(['anchor', 'thematic']).default('thematic'),
  direction: z.enum(['long', 'short', 'both']).default('long'),
  anchors: strList(64, 25).default([]),
  private_entities: cappedList(z.object({ name: str(120), note: str(400) }), 12).default([]),
  avoid: strList(120, 30).default([]),
  themes: strList(160, 20).default([]),
  // Strategy chips are edited on the review card; over-long chips are trimmed
  // (not rejected) exactly as before: sanitized to <= 5 chips of <= 60 chars.
  strategies: z
    .preprocess(
      (v) =>
        (Array.isArray(v) ? v : [])
          .map((s) => String(s).trim().slice(0, 60))
          .filter(Boolean)
          .slice(0, 5),
      z.array(z.string()),
    )
    .default([]),
  docCrit: z
    .preprocess(dropNulls, z.object({
      asset_set: strList(40, 12).optional(),
      region_set: strList(40, 12).optional(),
      cap_set: strList(40, 12).optional(),
      exclusions_set: strList(60, 30).optional(),
      include_tickers: strList(64, 30).optional(),
      exclude_tickers: strList(64, 30).optional(),
      constraint_note: str(400).optional(),
      asset_exclusive: z.boolean().optional(),
      region_exclusive: z.boolean().optional(),
      constrained: z.boolean().optional(),
      cex_only: z.boolean().optional(),
      cn_hkex_only: z.boolean().optional(),
      risk: str(60).optional(),
      horizon: str(60).optional(),
      familiarity: str(60).optional(),
      spread: str(60).optional(),
      expert: z.boolean().optional(),
    }))
    .default({ constrained: true }),
}));

/** Validate (and strip unknown keys from) a client-posted thesis; throws a 400 PublicError. */
export function parseClientThesis(value: unknown): Thesis {
  return parseOr400(ClientThesisSchema, value, 'thesis') as Thesis;
}

// ---- client-supplied requirements (POST /api/complete finReq) --------------

const finNum = z.number().nullish();
/**
 * Shape of the requirement set the review card posts back (audit N2). Lists and
 * strings are cut to these caps (e2e R4: the server's own /api/thesis output is
 * never refused for its length; wrong types still are); the exact keep-list
 * (12 bounds, 12 exposures, value caps) is sanitizeFinReq's job. Unknown keys
 * are stripped.
 */
export const ClientFinReqSchema = z.object({
  bounds: cappedList(z.object({ key: str(64), min: finNum, max: finNum }), 100).nullish(),
  exposures: cappedList(z.object({ kind: str(20), name: str(120), minWeightPct: finNum }), 100).nullish(),
  currencies: strList(8, 100).nullish(),
  domiciles: strList(8, 100).nullish(),
  unverifiable: strList(400, 100).nullish(),
});

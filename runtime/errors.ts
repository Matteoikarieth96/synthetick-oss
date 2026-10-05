/**
 * Stable, client-safe error model (security audit M4).
 *
 * Clients only ever see `{ error, code }`: a curated sentence plus a stable
 * machine-readable code. Raw upstream text (Supabase table and column names,
 * Voyage or OpenRouter response bodies, stack fragments) is logged server-side
 * and never forwarded. Pure module: no env, no network.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export type ErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'method_not_allowed'
  | 'payment_required'
  | 'payload_too_large'
  | 'unsupported_media'
  | 'rate_limited'
  | 'too_many_runs'
  | 'unsafe_url'
  | 'source_unreadable'
  | 'source_too_large'
  | 'upstream_unavailable'
  | 'server_busy'
  | 'run_failed'
  | 'internal_error';

/** An error whose message is already safe to show a client. */
export class PublicError extends Error {
  constructor(
    public status: number,
    public code: ErrorCode,
    message: string,
    /** Seconds for a Retry-After header (rate limits). */
    public retryAfterSec?: number,
  ) {
    super(message);
    this.name = 'PublicError';
  }
}

export interface PublicErrorBody {
  error: string;
  code: ErrorCode;
}

const UPSTREAM_RE =
  /openrouter|voyage|embed|supabase|postgrest|fetch failed|network|socket|econn|enotfound|timed? out|timeout|HTTP 4\d\d|HTTP 5\d\d|rate.?limit|overload/i;

/**
 * Map ANY thrown value to a client-safe `{status, code, error}`. Known
 * PublicErrors pass through; everything else collapses to a generic sentence
 * so internals cannot leak. The caller logs the original error.
 */
export function toPublicError(err: unknown): { status: number; body: PublicErrorBody; retryAfterSec?: number } {
  if (err instanceof PublicError) {
    return { status: err.status, body: { error: err.message, code: err.code }, retryAfterSec: err.retryAfterSec };
  }
  const message = err instanceof Error ? err.message : String(err);
  if (UPSTREAM_RE.test(message)) {
    return {
      status: 502,
      body: {
        error: 'A data or AI provider is temporarily unavailable. Please try again in a moment.',
        code: 'upstream_unavailable',
      },
    };
  }
  return { status: 500, body: { error: 'Something went wrong. Please try again.', code: 'internal_error' } };
}

// ---- per-request failure notes ----------------------------------------------
//
// Facts about a failed run that the code raising the error does not know, for
// example that the automatic refund was refused by the daily refund cap (final
// audit L5). A handler opens a scope with withRunFailureNotes; the credit code
// adds a sentence with addRunFailureNote; runFailureMessage appends it, so the
// error a client reads never claims a refund that did not happen.

const failureNotes = new AsyncLocalStorage<string[]>();

/** Run `fn` with its own (initially empty) list of failure notes. */
export function withRunFailureNotes<T>(fn: () => Promise<T>): Promise<T> {
  return failureNotes.run([], fn);
}

/** Attach a client-safe sentence to the current request's failure message (no-op outside a scope). */
export function addRunFailureNote(note: string): void {
  const notes = failureNotes.getStore();
  if (notes && !notes.includes(note)) notes.push(note);
}

/** The current request's failure notes as one string ('' when none). */
export function runFailureNotes(): string {
  return (failureNotes.getStore() ?? []).join(' ');
}

/** Message for a failed screen run (SSE `error` event, MCP tool error). */
export function runFailureMessage(err: unknown): { message: string; code: ErrorCode } {
  const mapped = toPublicError(err);
  const notes = runFailureNotes();
  const withNotes = (m: string) => (notes ? `${m} ${notes}` : m);
  if (mapped.body.code === 'internal_error') {
    return { message: withNotes('The screen could not be completed. Please try again.'), code: 'run_failed' };
  }
  return { message: withNotes(mapped.body.error), code: mapped.body.code };
}

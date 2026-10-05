import { log, sleep } from './log.js';

/** HTTP error carrying the status code; 4xx (≠429) are non-retryable. */
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface FetchJsonOpts {
  headers?: Record<string, string>;
  /** Additional retries after the first attempt (default 6). */
  retries?: number;
  /** Base backoff ms (default 1000, exponential). */
  backoffMs?: number;
  /** Label for logging. */
  label?: string;
  /** Per-attempt network timeout (default 30s). */
  timeoutMs?: number;
}

/** GET JSON with retry + exponential backoff, honoring Retry-After on 429. */
export async function fetchJson<T = unknown>(url: string, opts: FetchJsonOpts = {}): Promise<T> {
  const { headers, retries = 6, backoffMs = 1000, label, timeoutMs = 30_000 } = opts;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new HttpError(res.status, `${label ?? url} → HTTP ${res.status}`);
        if (attempt === retries) break;
        const ra = Number(res.headers.get('retry-after'));
        // Cap exponential backoff at 15s so a slot recovers without stalling the pool.
        const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(backoffMs * 2 ** attempt, 15000);
        log.warn(`${label ?? url} → HTTP ${res.status}, retry in ${wait}ms (attempt ${attempt + 1})`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) {
        // 4xx (except 429, handled above) are not retryable — fail immediately.
        const body = await res.text().catch(() => '');
        throw new HttpError(res.status, `${label ?? url} → HTTP ${res.status}: ${body.slice(0, 200)}`);
      }
      return (await res.json()) as T;
    } catch (err) {
      lastErr = err;
      if (err instanceof HttpError) throw err; // non-retryable client error
      if (attempt === retries) break;
      const wait = backoffMs * 2 ** attempt;
      log.warn(`${label ?? url} → ${(err as Error).message}, retry in ${wait}ms`);
      await sleep(wait);
    }
  }
  throw new Error(`fetchJson exhausted retries for ${label ?? url}: ${(lastErr as Error)?.message}`);
}

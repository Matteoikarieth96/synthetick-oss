import { sleep } from './log.js';

/**
 * Minimum-interval rate limiter. Serializes request *start times* to be at
 * least `intervalMs` apart, even under concurrency, keeping us under a
 * vendor's per-minute cap.
 */
export class RateLimiter {
  private last = 0;
  constructor(private intervalMs: number) {}

  async wait(): Promise<void> {
    const now = Date.now();
    const waitMs = Math.max(0, this.last + this.intervalMs - now);
    this.last = now + waitMs; // reserve this slot synchronously before awaiting
    if (waitMs > 0) await sleep(waitMs);
  }
}

/** Shared limiter for all FMP calls (FMP Ultimate: 3000/min → 25ms ≈ 2400/min headroom). */
export const fmpLimiter = new RateLimiter(Number(process.env.FMP_INTERVAL_MS ?? 25));

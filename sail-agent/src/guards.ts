/**
 * Off-chain trade guards (final audit M5, final-bugs D8). REAL-MONEY CODE:
 * every check here fails closed, and every refusal is explained in the log.
 *
 * 1. Quote vs an independent reference price. The router quote (QuoterV2) and
 *    the mandate's on-chain price band both read the SAME Uniswap pool the
 *    swap executes in, so a pool pushed off-price before the tick sets the
 *    price the agent accepts and still passes the band. The reference here is
 *    the venue's own price for the token (Robinhood /rhj mid x corporate-action
 *    multiplier, src/prices.ts), which that pool cannot move. A quote whose
 *    effective price deviates from it by more than maxQuoteDeviationBps
 *    (default 300 = 3%, either direction) is not traded.
 *
 * 2. Sell size in USD, not token units. The on-chain sell cap is 10 tokens per
 *    swap, which is ~$200 only at a $20 token: $1.8k for NVDA, $5k-9k for SPY,
 *    MSFT or COST. Sells are sized so their USD value never exceeds
 *    hardCapUsdPerTrade, the documented per-trade cap, even at a price up to
 *    the allowed deviation above the reference; and they are also clamped to
 *    the on-chain 10-token cap so a swap is never sent to a certain denial.
 *
 * Pure: no viem, no Sailor runtime, no network (sail-agent/test/offline.test.ts).
 */

/** Mirrors the sell permission's per-swap cap (10 whole tokens, .sail/strategy.md). */
export const ONCHAIN_SELL_CAP_TOKENS = 10;

/** Base units -> a decimal number (relative precision ~1e-15, ample for price ratios). */
export function unitsToNumber(amount: bigint, decimals: number): number {
  return Number(amount) / 10 ** decimals;
}

export interface QuoteCheckInput {
  side: "buy" | "sell";
  /** tokenIn base units (USDG for a buy, the stock token for a sell). */
  amountIn: bigint;
  /** QuoterV2 amountOut, tokenOut base units. */
  expectedOut: bigint;
  usdgDecimals: number;
  tokenDecimals: number;
  /** Independent reference: USD per token (venue mid x multiplier). */
  referencePriceUsd: number;
  maxDeviationBps: number;
}

export type QuoteCheck =
  | { ok: true; effectivePriceUsd: number; deviationBps: number }
  | { ok: false; reason: string; effectivePriceUsd?: number; deviationBps?: number };

/**
 * Compare the quote's effective token price (USDG per token, fees and price
 * impact included) with the reference. Fails closed on any missing or
 * non-finite input. Both directions count: a pool far BELOW the reference is
 * as wrong as one far above it.
 */
export function checkQuoteAgainstReference(q: QuoteCheckInput): QuoteCheck {
  if (!(Number.isFinite(q.referencePriceUsd) && q.referencePriceUsd > 0)) {
    return { ok: false, reason: "no usable reference price" };
  }
  if (!(Number.isInteger(q.maxDeviationBps) && q.maxDeviationBps > 0)) {
    return { ok: false, reason: "no valid deviation limit" };
  }
  if (q.amountIn <= 0n || q.expectedOut <= 0n) return { ok: false, reason: "empty amount or quote" };
  const usdg = unitsToNumber(q.side === "buy" ? q.amountIn : q.expectedOut, q.usdgDecimals);
  const tokens = unitsToNumber(q.side === "buy" ? q.expectedOut : q.amountIn, q.tokenDecimals);
  if (!(usdg > 0 && tokens > 0 && Number.isFinite(usdg) && Number.isFinite(tokens))) {
    return { ok: false, reason: "unreadable quote amounts" };
  }
  const effectivePriceUsd = usdg / tokens;
  const deviationBps = Math.round((effectivePriceUsd / q.referencePriceUsd - 1) * 10_000);
  if (!Number.isFinite(deviationBps)) return { ok: false, reason: "unreadable deviation" };
  if (Math.abs(deviationBps) > q.maxDeviationBps) {
    return {
      ok: false,
      effectivePriceUsd,
      deviationBps,
      reason: `quote price $${effectivePriceUsd.toFixed(4)} is ${(deviationBps / 100).toFixed(2)}% from the reference $${q.referencePriceUsd.toFixed(4)} (limit ${(q.maxDeviationBps / 100).toFixed(2)}%)`,
    };
  }
  return { ok: true, effectivePriceUsd, deviationBps };
}

export interface SellSizeInput {
  /** The plan's USD amount for this sell. */
  usd: number;
  /** Reference USD per token (venue mid x multiplier). */
  referencePriceUsd: number;
  decimals: number;
  /** Current on-chain balance, base units. */
  held: bigint;
  /** hardCapUsdPerTrade: the documented per-trade USD cap. */
  capUsd: number;
  /** maxQuoteDeviationBps: sizing leaves room for a price this far above the reference. */
  maxDeviationBps: number;
}

export interface SellSize {
  amountIn: bigint;
  /** What bound the size, for the log. */
  limitedBy: "plan" | "usd-cap" | "onchain-cap" | "holding";
}

/**
 * Token units to sell: the plan's USD amount at the reference price, never more
 * than capUsd worth even at a price maxDeviationBps above the reference (the
 * quote check lets a fill through up to that far), never more than the
 * on-chain 10-token cap, never more than held. 0n = nothing to sell (or no
 * usable price: fail closed).
 */
export function sizeSell(s: SellSizeInput): SellSize {
  const none: SellSize = { amountIn: 0n, limitedBy: "plan" };
  if (!(Number.isFinite(s.referencePriceUsd) && s.referencePriceUsd > 0)) return none;
  if (!(Number.isFinite(s.usd) && s.usd > 0 && Number.isFinite(s.capUsd) && s.capUsd > 0)) return none;
  if (!(Number.isInteger(s.decimals) && s.decimals >= 0 && s.decimals <= 36)) return none;
  const toUnits = (tokens: number): bigint => {
    if (!(Number.isFinite(tokens) && tokens > 0)) return 0n;
    // Floor at 6 decimals of a token, then scale: never rounds a size up.
    const micro = BigInt(Math.floor(tokens * 1e6));
    return s.decimals >= 6 ? micro * 10n ** BigInt(s.decimals - 6) : micro / 10n ** BigInt(6 - s.decimals);
  };
  const worstPrice = s.referencePriceUsd * (1 + Math.max(0, s.maxDeviationBps) / 10_000);
  const candidates: [bigint, SellSize["limitedBy"]][] = [
    [toUnits(s.usd / s.referencePriceUsd), "plan"],
    [toUnits(s.capUsd / worstPrice), "usd-cap"],
    [BigInt(ONCHAIN_SELL_CAP_TOKENS) * 10n ** BigInt(s.decimals), "onchain-cap"],
    [s.held > 0n ? s.held : 0n, "holding"],
  ];
  let best = candidates[0]!;
  for (const c of candidates) if (c[0] < best[0]) best = c;
  return { amountIn: best[0], limitedBy: best[1] };
}

/**
 * Last check on a sell's quote: the USDG it would actually receive must not
 * exceed the per-trade USD cap (sizeSell already aims below it; this is the
 * belt to that brace).
 */
export function sellWithinUsdCap(expectedOutUsdg: bigint, usdgDecimals: number, capUsd: number): boolean {
  return Number.isFinite(capUsd) && capUsd > 0 && unitsToNumber(expectedOutUsdg, usdgDecimals) <= capUsd;
}

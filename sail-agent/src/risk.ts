/**
 * Risk tiers — the user-facing knob that sizes every trade.
 *
 * maxTradePct   — per-trade ceiling as % of portfolio NAV (cash + holdings).
 * maxTradesPerDay — how many swaps one daily plan may contain.
 * minScore      — minimum SyntheTick pick score (0-100) to open/add to a position.
 * exitScore     — a held asset scoring below this (or flipping to short) is trimmed.
 *
 * agent.config.json's maxTradePctOverride, when set, replaces maxTradePct.
 * The onchain mandate cap (hardCapUsdPerTrade) is the absolute ceiling that
 * holds even if this file is edited or the engine is buggy.
 */
export interface RiskParams {
  maxTradePct: number;
  maxTradesPerDay: number;
  minScore: number;
  exitScore: number;
}

export const RISK_TIERS: Record<string, RiskParams> = {
  conservative: { maxTradePct: 5, maxTradesPerDay: 2, minScore: 85, exitScore: 50 },
  balanced: { maxTradePct: 10, maxTradesPerDay: 4, minScore: 75, exitScore: 45 },
  aggressive: { maxTradePct: 20, maxTradesPerDay: 8, minScore: 65, exitScore: 40 },
};

export function riskParams(tier: string, maxTradePctOverride: number | null): RiskParams {
  const base = RISK_TIERS[tier];
  if (!base) throw new Error(`Unknown risk tier "${tier}" — use one of: ${Object.keys(RISK_TIERS).join(", ")}`);
  return maxTradePctOverride != null ? { ...base, maxTradePct: maxTradePctOverride } : base;
}

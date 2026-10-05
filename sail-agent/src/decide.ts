/**
 * The decision engine: SyntheTick picks + current portfolio + risk tier -> a
 * day plan of USD-sized trades.
 *
 * Rules (v1, deliberately simple and fully logged):
 *  - Only assets in the tradable universe (liquid USDG pool) are ever traded.
 *  - Per-trade USD = min(maxTradePct% of NAV, hardCapUsdPerTrade, available cash for buys,
 *    holding value for sells).
 *  - A held asset that the screen scores below exitScore, or flags short, is trimmed.
 *  - A pick scoring >= minScore with dir long is bought (held or not);
 *    bearish same-day news sentiment vetoes a buy.
 *  - Highest score first; at most maxTradesPerDay trades; trades under
 *    minTradeUsd are dropped.
 */
import type { ScreenPick } from "./screen.js";
import type { RiskParams } from "./risk.js";
import { bySymbol } from "./universe.js";

export interface Holding {
  symbol: string;
  balance: bigint; // token base units
  valueUsd: number;
}

export interface PlannedTrade {
  side: "buy" | "sell";
  symbol: string;
  usd: number;
  score: number;
  reason: string;
}

export function decideTrades(args: {
  picks: ScreenPick[];
  holdings: Holding[];
  cashUsd: number;
  sentiment: Record<string, string>;
  risk: RiskParams;
  hardCapUsdPerTrade: number;
  minTradeUsd: number;
  log: (m: string) => void;
}): PlannedTrade[] {
  const { picks, holdings, cashUsd, sentiment, risk, hardCapUsdPerTrade, minTradeUsd, log } = args;
  const nav = cashUsd + holdings.reduce((s, h) => s + h.valueUsd, 0);
  const perTradeCap = Math.min((risk.maxTradePct / 100) * nav, hardCapUsdPerTrade);
  const held = new Map(holdings.map((h) => [h.symbol, h]));
  const pickBy = new Map(picks.map((p) => [p.ticker, p]));

  log(`decide: NAV $${nav.toFixed(2)} (cash $${cashUsd.toFixed(2)}), per-trade cap $${perTradeCap.toFixed(2)}`);

  const candidates: PlannedTrade[] = [];

  // Sells first: held assets the thesis has turned against.
  for (const h of holdings) {
    if (h.valueUsd < minTradeUsd) continue;
    const p = pickBy.get(h.symbol);
    if (p && p.dir === "short") {
      candidates.push({ side: "sell", symbol: h.symbol, usd: Math.min(perTradeCap, h.valueUsd), score: p.score, reason: `screen flags ${h.symbol} short (score ${p.score}): ${p.why.slice(0, 140)}` });
    } else if (p && p.score < risk.exitScore) {
      candidates.push({ side: "sell", symbol: h.symbol, usd: Math.min(perTradeCap, h.valueUsd), score: 100 - p.score, reason: `score ${p.score} below exit threshold ${risk.exitScore}` });
    } else if (!p && sentiment[h.symbol] === "bearish") {
      candidates.push({ side: "sell", symbol: h.symbol, usd: Math.min(perTradeCap, h.valueUsd), score: 50, reason: `not in today's screen and news sentiment bearish` });
    }
  }

  // Buys: long picks above the conviction bar, tradable, not vetoed by news.
  for (const p of picks) {
    if (p.dir !== "long" || p.score < risk.minScore) continue;
    if (!bySymbol.has(p.ticker)) {
      log(`decide: ${p.ticker} (score ${p.score}) skipped — no liquid USDG pool`);
      continue;
    }
    if (sentiment[p.ticker] === "bearish") {
      log(`decide: ${p.ticker} (score ${p.score}) skipped — bearish news sentiment veto`);
      continue;
    }
    const already = held.get(p.ticker);
    candidates.push({
      side: "buy",
      symbol: p.ticker,
      usd: perTradeCap,
      score: p.score,
      reason: `${already ? "add to" : "open"} position (score ${p.score}): ${p.why.slice(0, 140)}`,
    });
  }

  // Rank, cap the day, then size buys against remaining cash sequentially.
  candidates.sort((a, b) => b.score - a.score);
  const plan: PlannedTrade[] = [];
  let cashLeft = cashUsd;
  for (const t of candidates) {
    if (plan.length >= risk.maxTradesPerDay) break;
    let usd = t.usd;
    if (t.side === "buy") {
      usd = Math.min(usd, cashLeft * 0.98); // leave dust headroom for rounding
      if (usd < minTradeUsd) { log(`decide: buy ${t.symbol} dropped — cash left $${cashLeft.toFixed(2)}`); continue; }
      cashLeft -= usd;
    } else {
      const h = held.get(t.symbol);
      usd = Math.min(usd, h?.valueUsd ?? 0);
      if (usd < minTradeUsd) continue;
      cashLeft += usd;
    }
    plan.push({ ...t, usd: Math.floor(usd * 100) / 100 });
  }

  for (const t of plan) log(`decide: ${t.side.toUpperCase()} ${t.symbol} $${t.usd} — ${t.reason}`);
  if (!plan.length) log("decide: no trades today");
  return plan;
}

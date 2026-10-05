/** agent.config.json + secrets. Secrets live in .sail/.env.local (gitignored). */
import fs from "node:fs";
import path from "node:path";

export interface AgentSettings {
  riskTier: string;
  maxTradePctOverride: number | null;
  hardCapUsdPerTrade: number;
  minTradeUsd: number;
  slippageBps: number;
  /** Largest gap, in bps, allowed between a swap quote's price and the venue
   * reference price before the trade is skipped (src/guards.ts). Default 300. */
  maxQuoteDeviationBps: number;
  watchlist: string[];
  synthetickBaseUrl: string;
  newsMaxPostsPerTicker: number;
  newsMaxTickers: number;
  thesisModel: string;
  planTtlHours: number;
  dripEnabled: boolean;
  dripMaxSummariesPerRun: number;
  dripMaxCentsPerRun: number;
  dripMinCoverage: number;
  dripMaxAgeDays: number;
  dripNoRebuyDays: number;
}

export function loadSettings(): AgentSettings {
  const p = path.join(process.cwd(), "agent.config.json");
  const s = JSON.parse(fs.readFileSync(p, "utf-8")) as AgentSettings;
  // Money knobs are validated as real numbers: a missing key read as
  // `undefined <= 0` (false) and slipped through, and a fractional slippage
  // only failed later inside BigInt() at trade time, on every tick.
  const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  if (!Number.isInteger(s.slippageBps) || s.slippageBps < 10 || s.slippageBps > 1000) {
    throw new Error("slippageBps must be an integer in range (10-1000)");
  }
  if (!isNum(s.hardCapUsdPerTrade) || s.hardCapUsdPerTrade <= 0) throw new Error("hardCapUsdPerTrade must be positive");
  if (!isNum(s.minTradeUsd) || s.minTradeUsd < 0) throw new Error("minTradeUsd must be a number >= 0");
  if (!isNum(s.planTtlHours) || s.planTtlHours <= 0) throw new Error("planTtlHours must be positive");
  if (s.maxTradePctOverride != null && (!isNum(s.maxTradePctOverride) || s.maxTradePctOverride <= 0 || s.maxTradePctOverride > 100)) {
    throw new Error("maxTradePctOverride must be null or a percent in (0, 100]");
  }
  // Quote vs venue reference price (final audit M5): 3% unless configured;
  // a present but invalid value refuses to load rather than trading unguarded.
  s.maxQuoteDeviationBps ??= 300;
  if (!Number.isInteger(s.maxQuoteDeviationBps) || s.maxQuoteDeviationBps < 10 || s.maxQuoteDeviationBps > 1000) {
    throw new Error("maxQuoteDeviationBps must be an integer in range (10-1000)");
  }
  // Drip knobs: default to free mode (search + snippets, zero spend) for
  // configs written before this feature existed.
  s.dripEnabled ??= false;
  s.dripMaxSummariesPerRun ??= 3;
  s.dripMaxCentsPerRun ??= 150;
  s.dripMinCoverage ??= 0.5;
  s.dripMaxAgeDays ??= 30;
  s.dripNoRebuyDays ??= 7;
  if (s.dripMaxCentsPerRun < 0 || s.dripMaxCentsPerRun > 1000) throw new Error("dripMaxCentsPerRun out of range (0-1000)");
  if (s.dripMaxSummariesPerRun < 0 || s.dripMaxSummariesPerRun > 10) throw new Error("dripMaxSummariesPerRun out of range (0-10)");
  return s;
}

/** The runner exports .sail/.env.local into process.env; fall back to parsing it directly. */
export function secret(...names: string[]): string | null {
  for (const n of names) if (process.env[n]) return process.env[n]!;
  const envFile = path.join(process.cwd(), ".sail", ".env.local");
  try {
    const text = fs.readFileSync(envFile, "utf-8");
    for (const line of text.split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && names.includes(m[1]!)) return m[2]!.trim();
    }
  } catch {
    // no env file — fall through
  }
  return null;
}

export function requireSecret(...names: string[]): string {
  const v = secret(...names);
  if (!v) throw new Error(`Missing secret ${names[0]} — add it to .sail/.env.local`);
  return v;
}

/**
 * SyntheTick x Sail — autonomous Robinhood Chain stock-token agent.
 *
 * Once per UTC day (the pipeline tick):
 *   1. read the SMA's holdings (USDG + tradable stock tokens),
 *   2. pull X news for held/watched tickers,
 *   3. write an investment thesis (OpenRouter),
 *   4. screen it against SyntheTick's Robinhood universe (/v1/screen),
 *   5. size buys/sells with the user's risk tier -> a day plan + report.
 *
 * Every tick after that drains the plan: allowance check (self-approve under
 * BoundedErc20Approve when short), QuoterV2 quote, then one bounded
 * exactInputSingle dispatch per trade through the Sail kernel. The mandate
 * (SwapPermissionNoOracle x2 + BoundedErc20Approve) enforces router, token
 * allowlists, per-tx caps, recipient=SMA, and a pool-referenced price band
 * on-chain on every dispatch.
 *
 * Read -> decide -> act shape per .agents/skills/sailor-agent-build; ledger
 * doctrine per sailor-memory (chain-reconciled, never intention-recorded).
 */
import fs from "node:fs";
import path from "node:path";
import type { Agent, AgentContext, Call, Dispatch } from "@sail.money/sailor/sdk";
import { decodeFunctionData, encodeFunctionData, formatUnits, parseEventLogs } from "viem";

import { TRADABLE, USDG, USDG_DECIMALS, SWAP_ROUTER_02, QUOTER_V2, bySymbol, byToken } from "./universe.js";
import { loadSettings } from "./settings.js";
import { riskParams } from "./risk.js";
import { fetchNews } from "./news.js";
import { writeThesis, reviseThesis, type ThesisResult } from "./thesis.js";
import { fetchDripResearch, type DripResult } from "./drip.js";
import { runScreen, fetchCredits } from "./screen.js";
import { decideTrades, type Holding } from "./decide.js";
import { loadPlan, savePlan, lastPipelineDate, pipelineAttempts, recordPipelineAttempt, type DayPlan, type PlanTrade } from "./plan.js";
import { fetchVenuePrices } from "./prices.js";
import { checkQuoteAgainstReference, sellWithinUsdCap, sizeSell } from "./guards.js";
import { writeReport } from "./report.js";

const MAX_SWAPS_PER_TICK = 2; // keep receipts/reconciliation simple
// The success guard (lastPipelineDate) only writes when the pipeline
// completes, so a persistently failing screen would otherwise re-run
// news/thesis/Drip every tick all day. Attempts are recorded up front and
// capped here; the counter resets at UTC midnight.
const MAX_PIPELINE_ATTEMPTS_PER_DAY = 3;

// ── ABI fragments ───────────────────────────────────────────────────────────
const QUOTER_ABI = [
  {
    name: "quoteExactInputSingle",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "fee", type: "uint24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

// SwapRouter02 variant of exactInputSingle (0x04e45aaf, no deadline).
const ROUTER_ABI = [
  {
    name: "exactInputSingle",
    type: "function",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "recipient", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;

const ERC20_APPROVE_ABI = [
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

const ERC20_TRANSFER_ABI = [
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
] as const;

// ── Ledger (.sail/memory/ledger.jsonl) — see sailor-memory ─────────────────
const LEDGER_PATH = path.join(process.cwd(), ".sail", "memory", "ledger.jsonl");
const ACTIVITY_PATH = path.join(process.cwd(), ".sail", "activity.jsonl");

const readLines = (file: string): string[] => {
  try {
    return fs.readFileSync(file, "utf-8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
};

const appendLedger = (entry: Record<string, unknown>): void => {
  fs.mkdirSync(path.dirname(LEDGER_PATH), { recursive: true });
  fs.appendFileSync(LEDGER_PATH, `${JSON.stringify(entry)}\n`);
};

const ledgeredTxHashes = (): Set<string> => {
  const set = new Set<string>();
  for (const line of readLines(LEDGER_PATH).slice(-100)) {
    try {
      const entry = JSON.parse(line);
      if (entry.kind === "acted" && typeof entry.txHash === "string") set.add(entry.txHash);
    } catch {
      // malformed line — never fatal
    }
  }
  return set;
};

const symbolOf = (token: string): string =>
  token.toLowerCase() === USDG.toLowerCase() ? "USDG" : (byToken.get(token.toLowerCase())?.symbol ?? token);

/** Chain-reconcile every swap dispatch the runner has confirmed or reverted. */
async function reconcilePending(ctx: AgentContext, plan: DayPlan | null): Promise<boolean> {
  const already = ledgeredTxHashes();
  const events = readLines(ACTIVITY_PATH)
    .slice(-40)
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter(
      (e): e is Record<string, unknown> =>
        !!e &&
        (e["type"] === "dispatch_executed" || e["type"] === "dispatch_reverted") &&
        typeof e["target"] === "string" &&
        (e["target"] as string).toLowerCase() === SWAP_ROUTER_02.toLowerCase() &&
        typeof e["txHash"] === "string" &&
        !already.has(e["txHash"] as string),
    );

  let planTouched = false;
  for (const event of events) {
    const txHash = event["txHash"] as `0x${string}`;
    try {
      const [tx, receipt] = await Promise.all([
        ctx.publicClient.getTransaction({ hash: txHash }),
        ctx.publicClient.getTransactionReceipt({ hash: txHash }),
      ]);
      const { args } = decodeFunctionData({ abi: ROUTER_ABI, data: tx.input });
      const [params] = args;
      const outcome: "confirmed" | "reverted" = receipt.status === "success" ? "confirmed" : "reverted";

      let amountOut: bigint | null = null;
      if (outcome === "confirmed") {
        const transfers = parseEventLogs({ abi: ERC20_TRANSFER_ABI, logs: receipt.logs, eventName: "Transfer" });
        const toSma = transfers.find(
          (t) =>
            t.address.toLowerCase() === params.tokenOut.toLowerCase() &&
            t.args.to.toLowerCase() === ctx.safe.toLowerCase(),
        );
        amountOut = toSma?.args.value ?? null;
      }

      const inSym = symbolOf(params.tokenIn);
      const outSym = symbolOf(params.tokenOut);
      const decIn = params.tokenIn.toLowerCase() === USDG.toLowerCase() ? USDG_DECIMALS : (byToken.get(params.tokenIn.toLowerCase())?.decimals ?? 18);
      const decOut = params.tokenOut.toLowerCase() === USDG.toLowerCase() ? USDG_DECIMALS : (byToken.get(params.tokenOut.toLowerCase())?.decimals ?? 18);

      appendLedger({
        ts: ctx.timestamp,
        block: Number(receipt.blockNumber),
        chainId: ctx.chainId,
        kind: "acted",
        action: "swap",
        outcome,
        txHash,
        gasUsed: receipt.gasUsed.toString(),
        tokenIn: params.tokenIn,
        tokenOut: params.tokenOut,
        amountIn: { baseUnits: params.amountIn.toString(), human: `${formatUnits(params.amountIn, decIn)} ${inSym}` },
        amountOut: amountOut === null ? null : { baseUnits: amountOut.toString(), human: `${formatUnits(amountOut, decOut)} ${outSym}` },
      });
      ctx.log(`reconciled ${outcome}: ${inSym}->${outSym} tx ${txHash}`);

      if (plan) {
        const side = inSym === "USDG" ? "buy" : "sell";
        const symbol = side === "buy" ? outSym : inSym;
        const trade = plan.trades.find((t) => t.status === "submitted" && t.side === side && t.symbol === symbol);
        if (trade) {
          trade.status = outcome === "confirmed" ? "done" : "failed";
          if (outcome === "reverted") trade.note = `reverted: ${txHash}`;
          planTouched = true;
        }
      }
    } catch (e) {
      appendLedger({
        ts: ctx.timestamp,
        block: Number(ctx.blockNumber),
        chainId: ctx.chainId,
        kind: "acted",
        action: "swap",
        outcome: "unverified",
        txHash,
        note: (e as Error).message.slice(0, 160),
      });
    }
  }
  return planTouched;
}

// ── Portfolio reads ─────────────────────────────────────────────────────────
async function readHoldings(ctx: AgentContext): Promise<{ holdings: Holding[]; cashUnits: bigint }> {
  const cashUnits = await ctx.read.balance(USDG);
  const balances: { symbol: string; balance: bigint; decimals: number }[] = [];
  for (const t of TRADABLE) {
    const bal = await ctx.read.balance(t.token);
    if (bal > 0n) balances.push({ symbol: t.symbol, balance: bal, decimals: t.decimals });
  }
  const prices = await fetchVenuePrices(balances.map((b) => b.symbol));
  const holdings: Holding[] = [];
  for (const b of balances) {
    const p = prices.get(b.symbol);
    // Fail closed: a holding with no readable price is carried at zero value
    // and never sold this tick (the sell path re-checks the price).
    const valueUsd = p ? Number(formatUnits(b.balance, b.decimals)) * p.mid : 0;
    holdings.push({ symbol: b.symbol, balance: b.balance, valueUsd });
  }
  return { holdings, cashUnits };
}

// ── The daily pipeline ──────────────────────────────────────────────────────
async function runPipeline(ctx: AgentContext, holdings: Holding[], cashUsd: number): Promise<DayPlan> {
  const settings = loadSettings();
  const risk = riskParams(settings.riskTier, settings.maxTradePctOverride);
  const today = new Date(ctx.timestamp * 1000).toISOString().slice(0, 10);

  // News set: held tickers + watchlist, topped up with the most liquid
  // tradables so an all-cash portfolio still reads the market.
  const wanted = [...new Set([...holdings.map((h) => h.symbol), ...settings.watchlist])];
  for (const t of TRADABLE) {
    if (wanted.length >= settings.newsMaxTickers) break;
    if (!wanted.includes(t.symbol)) wanted.push(t.symbol);
  }
  const tickers = wanted.slice(0, settings.newsMaxTickers).flatMap((s) => {
    const t = bySymbol.get(s);
    return t ? [{ symbol: t.symbol, name: t.name }] : [];
  });

  const nav = cashUsd + holdings.reduce((s, h) => s + h.valueUsd, 0);
  const weights = holdings.map((h) => ({ symbol: h.symbol, weightPct: nav > 0 ? (h.valueUsd / nav) * 100 : 0 }));

  const news = await fetchNews(tickers, settings.newsMaxPostsPerTicker, ctx.log);
  let thesis: ThesisResult = await writeThesis(news, weights, settings.thesisModel, ctx.log);

  // Newsletter enrichment (Drip): free search on the draft theme, budgeted
  // paid summaries, one revision pass. Any failure keeps the draft thesis.
  let research: DripResult = { items: [], spentCents: 0 };
  let divergence: string | null = null;
  if (settings.dripEnabled) {
    // The model's compact searchQuery retrieves far better than the verbose
    // title — long queries dilute Drip's token-coverage ranking into junk.
    const query = thesis.searchQuery?.trim() || thesis.title;
    research = await fetchDripResearch(
      query,
      {
        maxSummaries: settings.dripMaxSummariesPerRun,
        maxCents: settings.dripMaxCentsPerRun,
        minCoverage: settings.dripMinCoverage,
        maxAgeDays: settings.dripMaxAgeDays,
        noRebuyDays: settings.dripNoRebuyDays,
      },
      ctx.log,
    );
    if (research.items.length) {
      try {
        const revised = await reviseThesis(thesis, research.items, settings.thesisModel, ctx.log);
        thesis = revised;
        divergence = revised.divergence;
      } catch (e) {
        ctx.log(`drip revision failed (${(e as Error).message.slice(0, 100)}) — keeping draft thesis`);
      }
    }
  }

  const screen = await runScreen(settings.synthetickBaseUrl, `${thesis.title}. ${thesis.thesis}`, ctx.log);
  const trades = decideTrades({
    picks: screen.picks,
    holdings,
    cashUsd,
    sentiment: thesis.sentiment,
    risk,
    hardCapUsdPerTrade: settings.hardCapUsdPerTrade,
    minTradeUsd: settings.minTradeUsd,
    log: ctx.log,
  });

  const reportPath = writeReport({ date: today, news, thesis, research: research.items, spentCents: research.spentCents, divergence, picks: screen.picks, holdings, cashUsd, plan: trades });
  ctx.log(`report written: ${reportPath}`);

  return {
    createdAt: ctx.timestamp,
    expiresAt: ctx.timestamp + settings.planTtlHours * 3600,
    pipelineDate: today,
    thesisTitle: thesis.title,
    trades: trades.map((t): PlanTrade => ({ ...t, status: "pending" })),
  };
}

// ── Trade execution ─────────────────────────────────────────────────────────
const intent = (call: Call): Dispatch => ({ txHash: "0x", calls: [call], success: false, gasUsed: 0n });

async function executeTrades(ctx: AgentContext, plan: DayPlan, cashUnits: bigint): Promise<Dispatch[]> {
  const settings = loadSettings();
  // Every pending trade needs the venue price now, buys included: it is the
  // independent reference each quote is checked against (src/guards.ts).
  const pending = [...new Set(plan.trades.filter((t) => t.status === "pending").map((t) => t.symbol))];
  const prices = await fetchVenuePrices(pending);
  const dispatches: Dispatch[] = [];
  let swaps = 0;
  let cashLeft = cashUnits;

  for (const trade of plan.trades) {
    if (trade.status !== "pending" || swaps >= MAX_SWAPS_PER_TICK) continue;
    const asset = bySymbol.get(trade.symbol);
    if (!asset) {
      trade.status = "failed";
      trade.note = "not in tradable universe";
      continue;
    }

    const isBuy = trade.side === "buy";
    const tokenIn = isBuy ? USDG : asset.token;
    const tokenOut = isBuy ? asset.token : USDG;
    const decIn = isBuy ? USDG_DECIMALS : asset.decimals;

    // Fail closed without an independent reference price (missing price,
    // unknown corporate-action multiplier, or trading halted at the venue).
    const p = prices.get(trade.symbol);
    if (!p || p.halted || !(p.mid > 0)) {
      ctx.log(`exec: ${trade.side} ${trade.symbol}: no venue reference price or trading halted, deferring`);
      trade.note = "deferred: no venue reference price or trading halted";
      continue;
    }

    // Size the leg in tokenIn base units.
    let amountIn: bigint;
    if (isBuy) {
      amountIn = BigInt(Math.floor(trade.usd * 10 ** USDG_DECIMALS));
      if (amountIn > cashLeft) {
        ctx.log(`exec: buy ${trade.symbol}: USDG balance short, deferring`);
        continue;
      }
    } else {
      // Sized in USD (never above hardCapUsdPerTrade, even at the worst price
      // the quote check allows), then clamped to the on-chain 10-token cap and
      // to the holding (final audit M5).
      const held = await ctx.read.balance(asset.token);
      const size = sizeSell({
        usd: trade.usd,
        referencePriceUsd: p.mid,
        decimals: asset.decimals,
        held,
        capUsd: settings.hardCapUsdPerTrade,
        maxDeviationBps: settings.maxQuoteDeviationBps,
      });
      amountIn = size.amountIn;
      if (amountIn === 0n) {
        trade.status = "failed";
        trade.note = held > 0n ? "sell size rounds to zero" : "nothing held";
        continue;
      }
      if (size.limitedBy !== "plan") {
        ctx.log(`exec: sell ${trade.symbol}: size limited by the ${size.limitedBy} to ${formatUnits(amountIn, asset.decimals)} tokens`);
      }
    }

    // Client-side mandate-cap check: never burn gas on a certain denial.
    // (Buys: the USDG cap. Sells: sized under it above.)
    if (isBuy && Number(formatUnits(amountIn, decIn)) > settings.hardCapUsdPerTrade) {
      trade.status = "failed";
      trade.note = `amount exceeds mandate cap $${settings.hardCapUsdPerTrade}`;
      continue;
    }

    // Allowance: self-approve (standing max) under BoundedErc20Approve when short.
    const allowance = await ctx.read.allowance(tokenIn, ctx.safe, SWAP_ROUTER_02);
    if (allowance < amountIn) {
      ctx.log(`exec: allowance ${symbolOf(tokenIn)}->router short — self-approving (standing max)`);
      dispatches.push(
        intent({
          target: tokenIn,
          value: 0n,
          data: encodeFunctionData({
            abi: ERC20_APPROVE_ABI,
            functionName: "approve",
            args: [SWAP_ROUTER_02, 2n ** 256n - 1n],
          }),
        }),
      );
      continue; // swap on a later tick, once the approve clears
    }

    // Quote — fail closed on revert or zero.
    let expectedOut: bigint;
    try {
      const q = await ctx.publicClient.simulateContract({
        address: QUOTER_V2,
        abi: QUOTER_ABI,
        functionName: "quoteExactInputSingle",
        args: [{ tokenIn, tokenOut, amountIn, fee: asset.feeTier, sqrtPriceLimitX96: 0n }],
      });
      expectedOut = (q.result as readonly [bigint, bigint, number, bigint])[0];
    } catch (e) {
      ctx.log(`exec: ${trade.side} ${trade.symbol} — quote unavailable (${(e as Error).message.slice(0, 80)}), deferring`);
      continue;
    }
    if (expectedOut === 0n) {
      ctx.log(`exec: ${trade.side} ${trade.symbol} — quote returned 0, deferring`);
      continue;
    }
    // The quote reads the pool the swap executes in, and so does the mandate's
    // on-chain band: a pool pushed off-price passes both. Check it against the
    // venue price, which that pool cannot move; skip the trade on a gap above
    // maxQuoteDeviationBps (final audit M5). Deferred, not failed: a transient
    // gap may close before the plan expires.
    const quoteCheck = checkQuoteAgainstReference({
      side: trade.side,
      amountIn,
      expectedOut,
      usdgDecimals: USDG_DECIMALS,
      tokenDecimals: asset.decimals,
      referencePriceUsd: p.mid,
      maxDeviationBps: settings.maxQuoteDeviationBps,
    });
    if (!quoteCheck.ok) {
      ctx.log(`exec: ${trade.side} ${trade.symbol}: SKIPPED, ${quoteCheck.reason}`);
      trade.note = `deferred: ${quoteCheck.reason}`;
      continue;
    }
    if (!isBuy && !sellWithinUsdCap(expectedOut, USDG_DECIMALS, settings.hardCapUsdPerTrade)) {
      ctx.log(`exec: sell ${trade.symbol}: SKIPPED, quote of ${formatUnits(expectedOut, USDG_DECIMALS)} USDG exceeds the $${settings.hardCapUsdPerTrade} per-trade cap`);
      trade.note = "deferred: sell quote above the per-trade USD cap";
      continue;
    }
    const minOut = (expectedOut * BigInt(10_000 - settings.slippageBps)) / 10_000n;
    if (minOut === 0n) {
      ctx.log(`exec: ${trade.side} ${trade.symbol} — minOut truncates to 0, deferring`);
      continue;
    }

    ctx.log(
      `exec: ${trade.side.toUpperCase()} ${trade.symbol} — ${formatUnits(amountIn, decIn)} ${symbolOf(tokenIn)} for >= ${minOut} out (${settings.slippageBps} bps floor)`,
    );
    dispatches.push(
      intent({
        target: SWAP_ROUTER_02,
        value: 0n,
        data: encodeFunctionData({
          abi: ROUTER_ABI,
          functionName: "exactInputSingle",
          args: [{ tokenIn, tokenOut, fee: asset.feeTier, recipient: ctx.safe, amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }],
        }),
      }),
    );
    trade.status = "submitted";
    if (isBuy) cashLeft -= amountIn;
    swaps++;
  }

  return dispatches;
}

// ── The agent ───────────────────────────────────────────────────────────────
export const agent: Agent = {
  name: "synthetick-robinhood-agent",
  description:
    "Daily: X news -> thesis -> SyntheTick Robinhood-universe screen -> risk-tiered buy/sell plan, executed as bounded Uniswap V3 swaps (USDG hub) under the Sail mandate.",

  async tick(ctx: AgentContext): Promise<Dispatch[]> {
    ctx.log(`tick — block ${ctx.blockNumber}, sma ${ctx.safe}`);

    let plan: DayPlan | null;
    try {
      plan = loadPlan(ctx.timestamp);
    } catch (e) {
      // Unreadable plan.json (PlanFileCorruptError): keep the ledger honest,
      // then refuse to trade or re-plan until an operator looks (fail closed).
      await reconcilePending(ctx, null);
      throw e;
    }
    const planTouched = await reconcilePending(ctx, plan);
    if (plan && planTouched) savePlan(plan);

    // Drain a live plan first — cheap ticks, at most MAX_SWAPS_PER_TICK swaps.
    if (plan && plan.trades.some((t) => t.status === "pending")) {
      const cashUnits = await ctx.read.balance(USDG);
      const dispatches = await executeTrades(ctx, plan, cashUnits);
      savePlan(plan);
      if (!dispatches.length) ctx.log("plan: nothing executable this tick");
      return dispatches;
    }

    // Once-per-UTC-day pipeline guard (survives restarts — read from disk).
    const today = new Date(ctx.timestamp * 1000).toISOString().slice(0, 10);
    if (lastPipelineDate() === today) {
      ctx.log(`pipeline already ran ${today} and plan is drained — skipping`);
      return [];
    }
    const attempts = pipelineAttempts(today);
    if (attempts >= MAX_PIPELINE_ATTEMPTS_PER_DAY) {
      ctx.log(`pipeline failed ${attempts}x today — capped until tomorrow UTC`);
      return [];
    }

    const { holdings, cashUnits } = await readHoldings(ctx);
    const cashUsd = Number(formatUnits(cashUnits, USDG_DECIMALS));
    if (cashUsd < 1 && holdings.every((h) => h.valueUsd < 1)) {
      ctx.log("SMA unfunded (no USDG, no holdings) — skipping. Fund the SMA with USDG to start.");
      return [];
    }

    // Credits preflight — a screen with no credits must fail HERE, before
    // news/thesis/Drip spend anything. No attempt is recorded on a skip:
    // retrying an out-of-credits day next tick costs one HTTP call.
    try {
      const credits = await fetchCredits(loadSettings().synthetickBaseUrl);
      if (credits === 0) {
        ctx.log("SyntheTick credits exhausted — skipping pipeline until they refresh (midnight UTC)");
        return [];
      }
    } catch (e) {
      ctx.log(`credits preflight failed (${(e as Error).message.slice(0, 100)}) — skipping pipeline this tick`);
      return [];
    }

    recordPipelineAttempt(today);
    plan = await runPipeline(ctx, holdings, cashUsd);
    savePlan(plan);
    ctx.log(`plan saved: ${plan.trades.length} trades (execution starts next tick)`);
    return [];
  },
};

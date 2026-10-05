# How this agent works — the complete record

Everything that was built and deployed on 2026-08-03 to take this project from an idea
("an autonomous onchain agent trading tokenized Robinhood stocks from SyntheTick
screens") to a live, mandate-bounded agent on Robinhood Chain. This is the narrative
companion to [README.md](../README.md) (operations) and
[.sail/strategy.md](../.sail/strategy.md) (the resolved strategy spec).

## The idea

Given a portfolio of tokenized stocks on Robinhood Chain, every day:

1. read the news about those stocks on X,
2. write an investment thesis from that news,
3. enrich it with premium newsletter research (Drip, budget-capped) and revise the
   thesis, flagging where professional research disagrees with the social flow,
4. call the SyntheTick API to find the relevant adjacent stocks,
5. buy or sell — never more than a user-set % per trade,
6. with defaults per risk level (conservative / balanced / aggressive).

## How sail.money is used

[Sail](https://sail.money) is the custody and authorization layer — the piece that makes
"autonomous agent with my money" sane. The core ideas, as used here:

**Separately Managed Account (SMA).** The capital lives in a self-custodial Safe:
`0xYourSafe…` (chain 4663, deterministic — the same
address is reserved on every Sail chain). The owner wallet (`0xYourOwner…`) controls it;
the agent never holds funds.

**The manager key.** The agent signs with its own key (`0xYourManager…`), generated in the
Sailor setup wizard and encrypted at `.sail/keys/manager.json`. That key has zero
standing authority — it can only submit transactions to the Sail kernel.

**The mandate.** Authority comes from three permission contracts registered against the
SMA on the kernel (`0x38b5…A6ED`). On every dispatch the kernel evaluates the named
permission fail-closed — a denied call reverts with nothing changed, no matter what the
agent's code intended:

| Permission | Address | What it allows |
|---|---|---|
| swap-buy (`SwapPermissionNoOracle` shared singleton) | `0x34Ba96CbEd1f46c88A5265E645DC5fe41662b519` | USDG → any of the 21 allowlisted stock tokens, ≤ 200 USDG per swap, only on the canonical Uniswap V3 SwapRouter02, recipient pinned to the SMA, `amountOutMinimum` within a 6% band of the token's own reference-pool spot price |
| swap-sell (second instance of the same template, deployed from Sail's template source: GPL-2.0-or-later, fetched from github.com/sail-money/Protocol) | `0xYourSellInstance…` | the reverse direction: stock tokens → USDG, ≤ 10 tokens per swap, same router/band/recipient bounds |
| router-approve (bespoke `BoundedErc20Approve`, in [contracts/mandates/](../contracts/mandates/)) | `0xYourApprovePermission…` | ERC-20 `approve()` only, spender = the router only, on the 22 allowlisted tokens only |

Why two swap permissions: the template's strict-coverage rule demands a reference pool
for every directional tokenIn×tokenOut pair, so a single config cannot hold both
directions of a 21-token basket (it would require stock↔stock pools that do not exist).
One singleton config covers buys; a second deployment of the same audited-source
template covers sells. Every trade routes through USDG — the agent never swaps stock
for stock.

**Owner controls.** `npx sailor session pause` revokes the agent's dispatch rights in
one block (custody untouched); the mandate can be reconfigured (new caps, new tokens)
or revoked entirely with owner signatures. Registration cost 0.00015 ETH per permission.

**What was proven before signing.** `forge test` (11 tests on the approve permission)
plus live-chain probes via `sailor mandate simulate`: buys 6/6, sells 6/6, approvals
5/5 — including the must-reject proofs (over-cap, off-allowlist router, wrong
recipient, reversed direction, zero min-out). A finding from that gate worth keeping:
the band correctly denies any swap whose `amountOutMinimum` is not anchored to a real
quote — the "hallucination guard" doing its job.

## How the SyntheTick API is used

- **`GET /v1/universe/robinhood`** (public, keyless) is the source of verified token
  contracts. [scripts/gen-universe.mjs](../scripts/gen-universe.mjs) intersects it with
  live Uniswap V3 pool discovery (canonical factory `0x1f7d…2EfA`, verified on-chain via
  `pool.factory()`) and keeps tokens with a USDG pool holding ≥ $15k — 21 of 96 qualified
  at resolution. That basket becomes both the mandate allowlists and
  [src/universe.ts](../src/universe.ts).
- **`POST /v1/screen`** with `"universe": "robinhood"` turns the day's thesis into
  scored picks that each carry their token address — the agent never resolves tickers.
  One SyntheTick credit per day.
- **Robinhood's public `/rhj` API** supplies venue truth: share prices, corporate-action
  multipliers, and halt flags used for valuation and sell sizing.
- **X recent search** (bearer token, pay-per-use) feeds the news; **OpenRouter** writes
  the thesis and per-ticker sentiment.
- **[Drip](https://dripstack.xyz)** (`DRIP_API_KEY`, prepaid credits) supplies premium
  newsletter/podcast research: free topic search, then synthesized summaries (~10c each,
  ≤ 3 per day, ≤ $1.50/day hard cap, no re-buy within 7 days via
  `.sail/memory/drip-purchases.json`). A revision pass folds the research into the
  thesis; where it disagrees with X, the revised per-ticker sentiment feeds the
  bearish-buy veto. Without a key it degrades to free snippets; on any error the draft
  thesis carries through.

## The daily loop (src/agent.ts)

Tick 1 of the day runs the pipeline: holdings → news → thesis → newsletter research →
revised thesis → screen → plan.
The decision engine ([src/decide.ts](../src/decide.ts)) applies the risk tier
(conservative 5%/2 trades/min score 85 · balanced 10%/4/75 · aggressive 20%/8/65),
sells holdings the screen turns against (short flag or score below the exit bar),
buys long picks above the conviction bar, vetoes buys whose same-day news sentiment is
bearish, and drops anything without a liquid pool. Later ticks drain the plan: check
allowance (self-approve under the approve permission when short), quote via QuoterV2,
dispatch one bounded `exactInputSingle` per trade (max 2 swaps per tick), and reconcile
every fill from the chain into `.sail/memory/ledger.jsonl` — outcomes are recorded from
receipts, never from intentions. Each day produces `reports/<date>.md` with the full
news → thesis → picks → decisions trail.

The first live run (2026-08-03) is a good example of the guardrails: thesis
"AI Infrastructure Financing Concerns and Circular Capital Flows", four picks, zero
trades — NVDA (score 88) vetoed by bearish news sentiment, CRWV skipped for having no
liquid pool, SOXX under the conviction bar.

## Operations

- **Local:** `SAILOR_INTERVAL=900 npx sailor run` (continuous) or `npx sailor run --once`.
- **Unattended:** wire your own scheduler (see the
  [sailor-automation skill](../.agents/skills/sailor-automation/SKILL.md)); no trading
  workflow ships in this repository. A trading day is one pipeline tick followed by
  execution ticks that drain the plan; keep `.sail/memory/` between runs, because it
  holds the plan and the ledger. In CI, the agent key is an encrypted keystore you
  export yourself with `sailor keys export-ci`: store it as a CI secret (never commit it
  to a public repository) and unlock it with a `SAIL_PASSPHRASE` secret. The agent
  reads the same variables as in step 1 of the README's go-live checklist.
- **Costs per trading day:** ~80 X posts (pay-per-use), one OpenRouter call (cents),
  1 SyntheTick credit, cents of gas + the pools' 0.05–1% swap fees.

## What bounds what — the honest summary

The chain enforces: router, token allowlists, per-tx caps, recipient, the price band,
and approve scope. The code enforces: the exact % of NAV per trade, trades per day,
conviction thresholds, slippage floors from live quotes, halt/missing-price fail-closed.
The caps are blast-radius ceilings, not rate limits — the kernel has no clock, so
trades-per-day lives in code. The pools are thin ($15k–$770k); the 6% band catches a
bad quote, not a sandwich — which is why the per-trade cap defaults small. Judge the
strategy over weeks of reports, not days.

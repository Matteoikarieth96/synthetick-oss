# ⛵ sail-agent — SyntheTick × Sail Robinhood Chain stock-token agent

An autonomous onchain agent, built on the Sailor scaffold, that every day:

1. reads its portfolio from a self-custodial Sail SMA (Safe) on **Robinhood Chain (4663)**,
2. pulls **X news** for the tickers it holds/watches,
3. writes an **investment thesis** (OpenRouter),
4. enriches it with **premium newsletter research** ([Drip](https://dripstack.xyz), budget-capped; free snippets without a key) and revises the thesis, flagging where research and X flow disagree,
5. screens it with **SyntheTick** (`POST /v1/screen`, `universe: "robinhood"`) to find adjacent tokenized stocks,
6. sizes buys/sells with your **risk tier** and executes them as bounded **Uniswap V3** swaps (USDG hub) through the Sail kernel — every dispatch checked on-chain against the mandate.

Try the thesis pipeline end to end without touching X or the chain: `node scripts/drip-demo.mjs` (real OpenRouter + Drip calls on fixture news).

The full resolved strategy (basket, pools, caps, addresses) is in [`.sail/strategy.md`](.sail/strategy.md).
Risk tiers and every user knob live in [`agent.config.json`](agent.config.json); tier definitions in [`src/risk.ts`](src/risk.ts).
**The complete record of what was built, how sail.money is used, and what was proven before signing: [`docs/HOW-IT-WORKS.md`](docs/HOW-IT-WORKS.md).**

## What bounds what

| Layer | Enforces |
|---|---|
| Onchain mandate (`SwapPermissionNoOracle` ×2 + `BoundedErc20Approve`) | router allowlist, USDG-hub token allowlists, per-tx caps, recipient = SMA, 6% pool-band price sanity, approve only to the router |
| Agent code (this repo) | exact per-trade % of NAV (risk tier), trades/day, conviction thresholds, slippage floor from QuoterV2, halted-market and missing-price fail-closed |

The onchain cap is the ceiling that holds even if the code is wrong. Pause everything at any time: `npx sailor session pause`.

## Go-live checklist

Everything code-side is done (contracts tested, typecheck clean). The remaining steps need **you** — keys, money, and signatures:

1. **Secrets** — create `.sail/.env.local` (gitignored) with:
   ```
   CHAIN_ID=4663
   ROBINHOOD_RPC_URL=https://rpc.mainnet.chain.robinhood.com
   SYNTHETICK_API_KEY=stk_...        # mint in the SyntheTick app
   OPENROUTER_API_KEY=sk-or-...      # existing key works
   X_BEARER_TOKEN=...                # or X_BOT_BEARER; set an X spending limit!
   DRIP_API_KEY=pk_drip_...          # OPTIONAL — newsletter summaries (dripstack.xyz/dashboard/api-keys,
                                     # prepaid credits; without it Drip runs in free snippet-only mode)
   ```
2. **Wallet + SMA** — `npx sailor ui start`, open the printed URL: choose Robinhood Chain, connect your owner wallet, set the agent-wallet passphrase, deploy the SMA. Then `npx sailor doctor` must be green.
3. **Gas** — send a little ETH on Robinhood Chain to the agent (manager) wallet shown by `npx sailor status` (it submits the transactions).
4. **Mandate** — register + configure + simulate + sign (owner signs each step in the browser; registration fee 0.00015 ETH per permission):
   ```bash
   # buys: shared SwapPermissionNoOracle singleton
   npx sailor mandate register --address 0x34Ba96CbEd1f46c88A5265E645DC5fe41662b519 --label "buy stocks (USDG->token)"
   node scripts/build-mandate-blob.mjs buy > /tmp/buy.blob
   npx sailor mandate configure --address 0x34Ba96CbEd1f46c88A5265E645DC5fe41662b519 --params "$(cat /tmp/buy.blob)"

   # sells: second instance of the same template. Its source is GPL-2.0-or-later and is not shipped
   # in this MIT repository. Fetch ConfigurablePermission.sol and SwapPermissionNoOracle.sol from
   # github.com/sail-money/Protocol (contracts/templates/) into contracts/mandates/templates/,
   # change their "../interfaces/" imports to "@sail/interfaces/", install OpenZeppelin v5.1.0, then:
   npx sailor mandate deploy --contract SwapPermissionNoOracle --attach   # constructor: (kernel, author)
   node scripts/build-mandate-blob.mjs sell > /tmp/sell.blob
   npx sailor mandate configure --address <DEPLOYED_SELL_ADDR> --params "$(cat /tmp/sell.blob)"

   # approvals: bespoke BoundedErc20Approve (tokens = USDG + basket, spender = router, uncapped)
   npx sailor mandate deploy --contract BoundedErc20Approve --attach

   # prove the bounds before signing (must-pass AND must-fail probes)
   node scripts/probe-mandate.mjs --template SwapPermissionNoOracle --params "$(cat /tmp/buy.blob)" --address 0x34Ba96CbEd1f46c88A5265E645DC5fe41662b519
   node scripts/probe-mandate.mjs --template SwapPermissionNoOracle --params "$(cat /tmp/sell.blob)" --address <DEPLOYED_SELL_ADDR>
   npx sailor mandate sign
   ```
5. **Fund** — send USDG (and/or basket tokens) on Robinhood Chain to the SMA address. Start small; this is experimental code trading thin pools.
6. **First tick** — `npx sailor run --once` (first tick runs the pipeline and writes `reports/<date>.md`; the next tick starts executing). Then run continuously (`SAILOR_INTERVAL=900 npx sailor run`) or wire your own scheduler (see the [sailor-automation skill](.agents/skills/sailor-automation/SKILL.md)); no trading workflow ships in this repository.

## Costs per daily run

- X recent search: ~80 posts read (pay-per-use — set a spending limit on the X console)
- OpenRouter: one thesis call (cents)
- SyntheTick: 1 credit per screen
- Gas on Robinhood Chain: cents per swap; each swap also pays the pool fee (0.05–1%)

## Honest limitations (read once)

- **Thin pools.** Most basket pools hold $15k–$770k. The 600 bps mandate band is a hallucination guard, not manipulation protection; `hardCapUsdPerTrade` (default $200) is deliberately small. Raising it materially on these pools is how you get sandwiched.
- **Sell cap is in token units.** One number covers all 21 tokens (sized for a $20 token); a $900 token can move ~45× more USD in one tx than the buy cap. The exact % lives off-chain.
- **Per-tx caps don't rate-limit.** trades/day is code-enforced only; the kernel has no clock. `sailor session pause` is the brake.
- **The daily pipeline is only as good as its inputs** — X search coverage, one LLM thesis, one screen. Expect noise; judge it over weeks, not days.

## Project layout

- `src/agent.ts` — tick loop (reconcile → drain plan → daily pipeline)
- `src/news.ts` / `src/thesis.ts` / `src/screen.ts` / `src/decide.ts` — the pipeline
- `src/universe.ts` — generated tradable basket (regen: `node scripts/gen-universe.mjs`)
- `src/risk.ts`, `agent.config.json` — risk tiers and user knobs
- `contracts/` — `BoundedErc20Approve` (+ tests); the `SwapPermissionNoOracle` source is fetched from Sail's protocol repo (GPL-2.0-or-later, not shipped here)
- `scripts/build-mandate-blob.mjs` — mandate config encoder (buy/sell)
- `reports/` — daily human-readable reports · `.sail/memory/` — plan + chain-reconciled ledger
- `AGENTS.md` / `.agents/skills/` — the Sailor operator guide this project follows

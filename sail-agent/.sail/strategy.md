# Strategy — SyntheTick news-thesis rebalancer (Robinhood Chain)

**Category:** trading · **Archetype:** news-driven thesis rebalancer · **Chain:** Robinhood (4663)

**Intent (user's words):** an autonomous onchain agent that, given a portfolio of tokenized
Robinhood stocks, every day reads X news about them, writes an investment thesis, calls the
SyntheTick API to find relevant adjacent stocks, and buys/sells within a per-trade % set by
the user, with defaults per risk level.

## Strategy-wide dimensions

| Dimension | Value |
|---|---|
| Cash hub | USDG `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` (6 dec) — every trade is USDG->token or token->USDG, exactInputSingle only |
| Venue | Uniswap V3 SwapRouter02 `0xCaf681a66D020601342297493863E78C959E5cb2` (canonical factory `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA`, QuoterV2 `0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7`) |
| Risk tiers | conservative 5%/2 trades/minScore 85 · balanced 10%/4/75 · aggressive 20%/8/65 (agent.config.json overrides %) |
| Onchain per-tx caps | buys 200 USDG; sells 10 tokens (~$200 @ $20 floor — see caveat in JSON) |
| Slippage | agent 150 bps via QuoterV2 floor; permission band tolerance 600 bps (hallucination guard, NOT manipulation protection) |
| Cadence | pipeline 1x/UTC day; execution ticks drain the plan (max 2 swaps/tick) |
| Exit condition | runs until paused/revoked (user-stated) |
| Data | X recent search (news), OpenRouter (thesis), SyntheTick /v1/screen universe=robinhood (picks + token addresses), Robinhood /rhj prices (valuation) |

## Tradable basket (21 tokens — Uniswap V3 USDG pool, reserve >= $15k at resolution, source: GeckoTerminal)

| symbol | token | reference pool | feeTier |
|---|---|---|---|
| NVDA | `0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC` | `0xd4eb21209c4d6093f80b5b84f5c45cc093ea14a3` | 500 |
| SPCX | `0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa` | `0xeb07d9587efd1778dfb9c385ec43ef6d5f9fe401` | 3000 |
| GME | `0x1b0E319c6A659F002271B69dB8A7df2F911c153E` | `0xe2b46c905e12ab8e2f864e4821a4325884c1b126` | 500 |
| SPY | `0x117cc2133c37B721F49dE2A7a74833232B3B4C0C` | `0xa43b424bc609495aed4bcd88d654934b510b0ad9` | 3000 |
| SLV | `0x411eFb0E7f985935DAec3D4C3ebaEa0d0AD7D89f` | `0x0fa7bc480885dcf58ad2ef63ec7289cf2481d51c` | 10000 |
| AAPL | `0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9` | `0x783c9bbb765047cfdd2b84b92b2ca9f11d34b7ed` | 3000 |
| COST | `0x4EA005168D7F09a7A0Ba9D1DEf21a479950E44C2` | `0x0a2121a50a09ed0796ae81f9c53ff9398355a398` | 3000 |
| USO | `0xa30FA36Db767ad9eD3f7a60fC79526fB4d56D344` | `0x6ed11c7dfd8e2ca5620eed29a7b9b53ae90dd0d2` | 10000 |
| QQQ | `0xD5f3879160bc7c32ebb4dC785F8a4F505888de68` | `0xebd78dcfc8a6b3a696f1e191ad1ff321f9579f79` | 3000 |
| TSLA | `0x322F0929c4625eD5bAd873c95208D54E1c003b2d` | `0xf4acdaeeb7022862a763c9b1b885e11191c889e3` | 3000 |
| RDDT | `0x05b37Fb53A299a1b874A619e1c4C404D52C36F4C` | `0xa8744e76aed23b05f0126335e7bd38f7935d19fe` | 10000 |
| MSFT | `0xe93237C50D904957Cf27E7B1133b510C669c2e74` | `0xeb60bcd1d920ad6e102690ccfc6fb488899e1510` | 3000 |
| NFLX | `0xE0444EF8BF4eD74f74FD73686e2ddF4C1c5591E8` | `0xea75ea625d83ae276b9ae8b0a3dc205916ee65cf` | 10000 |
| DELL | `0x941AE714EC6D8130c7B75d67160Ca08f1e7d11Dd` | `0xc30c89cb7815a1488b7998d15eec73961707fc5a` | 10000 |
| INTC | `0xc72b96e0E48ecd4DC75E1e45396e26300BC39681` | `0x2e5a92f5013a64661a49312111be2e8abd33f56a` | 3000 |
| GOOGL | `0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3` | `0x553e9a453425cd9b90919f317061fbc3794cc57a` | 3000 |
| ASML | `0x47F93d52cBeC7C6D2CfC080e154002370a60dAEA` | `0xedb22516b14eb2d1c86927db373b0e8bf70f5cd1` | 10000 |
| AMZN | `0x12f190a9F9d7D37a250758b26824B97CE941bF54` | `0x8ac92da74ab5f3b1d024dc1943ad7e15dc4179ef` | 3000 |
| MSTR | `0xec262a75e413fAfD0dF80480274532C79D42da09` | `0x17578c0e0d15da44f31677263114f71ae76653ea` | 10000 |
| PLTR | `0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A` | `0x851680416a4f4e1c463d45171d61acddbc8554c0` | 3000 |
| RBLX | `0xF0C4BF4C582cb3836e98394b1d4e7B7281101bE8` | `0x2ef5945cd5664876b6481fdacfaa2942995a4da8` | 10000 |

Tokens outside this basket are never bought or sold, even if the screen picks them.
Regenerate with `node scripts/gen-universe.mjs` (then re-configure the mandate).

## Machine form

```json
{
  "category": "trading",
  "archetype": "news-thesis-rebalancer",
  "chains": [
    4663
  ],
  "actions": [
    {
      "id": "buy-stock-tokens",
      "kind": "swap",
      "chain": 4663,
      "route": {
        "type": "template",
        "name": "SwapPermissionNoOracle"
      },
      "tokenIn": {
        "symbol": "USDG",
        "address": "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
        "decimals": 6
      },
      "tokenOutBasket": [
        {
          "symbol": "NVDA",
          "address": "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC",
          "decimals": 18,
          "pool": "0xd4eb21209c4d6093f80b5b84f5c45cc093ea14a3",
          "feeTier": 500
        },
        {
          "symbol": "SPCX",
          "address": "0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa",
          "decimals": 18,
          "pool": "0xeb07d9587efd1778dfb9c385ec43ef6d5f9fe401",
          "feeTier": 3000
        },
        {
          "symbol": "GME",
          "address": "0x1b0E319c6A659F002271B69dB8A7df2F911c153E",
          "decimals": 18,
          "pool": "0xe2b46c905e12ab8e2f864e4821a4325884c1b126",
          "feeTier": 500
        },
        {
          "symbol": "SPY",
          "address": "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C",
          "decimals": 18,
          "pool": "0xa43b424bc609495aed4bcd88d654934b510b0ad9",
          "feeTier": 3000
        },
        {
          "symbol": "SLV",
          "address": "0x411eFb0E7f985935DAec3D4C3ebaEa0d0AD7D89f",
          "decimals": 18,
          "pool": "0x0fa7bc480885dcf58ad2ef63ec7289cf2481d51c",
          "feeTier": 10000
        },
        {
          "symbol": "AAPL",
          "address": "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9",
          "decimals": 18,
          "pool": "0x783c9bbb765047cfdd2b84b92b2ca9f11d34b7ed",
          "feeTier": 3000
        },
        {
          "symbol": "COST",
          "address": "0x4EA005168D7F09a7A0Ba9D1DEf21a479950E44C2",
          "decimals": 18,
          "pool": "0x0a2121a50a09ed0796ae81f9c53ff9398355a398",
          "feeTier": 3000
        },
        {
          "symbol": "USO",
          "address": "0xa30FA36Db767ad9eD3f7a60fC79526fB4d56D344",
          "decimals": 18,
          "pool": "0x6ed11c7dfd8e2ca5620eed29a7b9b53ae90dd0d2",
          "feeTier": 10000
        },
        {
          "symbol": "QQQ",
          "address": "0xD5f3879160bc7c32ebb4dC785F8a4F505888de68",
          "decimals": 18,
          "pool": "0xebd78dcfc8a6b3a696f1e191ad1ff321f9579f79",
          "feeTier": 3000
        },
        {
          "symbol": "TSLA",
          "address": "0x322F0929c4625eD5bAd873c95208D54E1c003b2d",
          "decimals": 18,
          "pool": "0xf4acdaeeb7022862a763c9b1b885e11191c889e3",
          "feeTier": 3000
        },
        {
          "symbol": "RDDT",
          "address": "0x05b37Fb53A299a1b874A619e1c4C404D52C36F4C",
          "decimals": 18,
          "pool": "0xa8744e76aed23b05f0126335e7bd38f7935d19fe",
          "feeTier": 10000
        },
        {
          "symbol": "MSFT",
          "address": "0xe93237C50D904957Cf27E7B1133b510C669c2e74",
          "decimals": 18,
          "pool": "0xeb60bcd1d920ad6e102690ccfc6fb488899e1510",
          "feeTier": 3000
        },
        {
          "symbol": "NFLX",
          "address": "0xE0444EF8BF4eD74f74FD73686e2ddF4C1c5591E8",
          "decimals": 18,
          "pool": "0xea75ea625d83ae276b9ae8b0a3dc205916ee65cf",
          "feeTier": 10000
        },
        {
          "symbol": "DELL",
          "address": "0x941AE714EC6D8130c7B75d67160Ca08f1e7d11Dd",
          "decimals": 18,
          "pool": "0xc30c89cb7815a1488b7998d15eec73961707fc5a",
          "feeTier": 10000
        },
        {
          "symbol": "INTC",
          "address": "0xc72b96e0E48ecd4DC75E1e45396e26300BC39681",
          "decimals": 18,
          "pool": "0x2e5a92f5013a64661a49312111be2e8abd33f56a",
          "feeTier": 3000
        },
        {
          "symbol": "GOOGL",
          "address": "0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3",
          "decimals": 18,
          "pool": "0x553e9a453425cd9b90919f317061fbc3794cc57a",
          "feeTier": 3000
        },
        {
          "symbol": "ASML",
          "address": "0x47F93d52cBeC7C6D2CfC080e154002370a60dAEA",
          "decimals": 18,
          "pool": "0xedb22516b14eb2d1c86927db373b0e8bf70f5cd1",
          "feeTier": 10000
        },
        {
          "symbol": "AMZN",
          "address": "0x12f190a9F9d7D37a250758b26824B97CE941bF54",
          "decimals": 18,
          "pool": "0x8ac92da74ab5f3b1d024dc1943ad7e15dc4179ef",
          "feeTier": 3000
        },
        {
          "symbol": "MSTR",
          "address": "0xec262a75e413fAfD0dF80480274532C79D42da09",
          "decimals": 18,
          "pool": "0x17578c0e0d15da44f31677263114f71ae76653ea",
          "feeTier": 10000
        },
        {
          "symbol": "PLTR",
          "address": "0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A",
          "decimals": 18,
          "pool": "0x851680416a4f4e1c463d45171d61acddbc8554c0",
          "feeTier": 3000
        },
        {
          "symbol": "RBLX",
          "address": "0xF0C4BF4C582cb3836e98394b1d4e7B7281101bE8",
          "decimals": 18,
          "pool": "0x2ef5945cd5664876b6481fdacfaa2942995a4da8",
          "feeTier": 10000
        }
      ],
      "venue": {
        "name": "Uniswap V3 SwapRouter02 (Robinhood Chain canonical)",
        "address": "0xCaf681a66D020601342297493863E78C959E5cb2"
      },
      "caps": {
        "perTx": {
          "baseUnits": "200000000",
          "human": "200 USDG"
        },
        "perDay": {
          "human": "riskTier maxTradesPerDay x per-trade %, enforced off-chain"
        }
      },
      "riskBounds": {
        "agentSlippageBps": 150,
        "bandToleranceBps": 600
      },
      "exitPath": {
        "managedBy": "agent",
        "actionIds": [
          "sell-stock-tokens"
        ]
      }
    },
    {
      "id": "sell-stock-tokens",
      "kind": "swap",
      "chain": 4663,
      "route": {
        "type": "template",
        "name": "SwapPermissionNoOracle (second instance, project-deployed)"
      },
      "tokenInBasket": [
        {
          "symbol": "NVDA",
          "address": "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC",
          "decimals": 18,
          "pool": "0xd4eb21209c4d6093f80b5b84f5c45cc093ea14a3",
          "feeTier": 500
        },
        {
          "symbol": "SPCX",
          "address": "0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa",
          "decimals": 18,
          "pool": "0xeb07d9587efd1778dfb9c385ec43ef6d5f9fe401",
          "feeTier": 3000
        },
        {
          "symbol": "GME",
          "address": "0x1b0E319c6A659F002271B69dB8A7df2F911c153E",
          "decimals": 18,
          "pool": "0xe2b46c905e12ab8e2f864e4821a4325884c1b126",
          "feeTier": 500
        },
        {
          "symbol": "SPY",
          "address": "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C",
          "decimals": 18,
          "pool": "0xa43b424bc609495aed4bcd88d654934b510b0ad9",
          "feeTier": 3000
        },
        {
          "symbol": "SLV",
          "address": "0x411eFb0E7f985935DAec3D4C3ebaEa0d0AD7D89f",
          "decimals": 18,
          "pool": "0x0fa7bc480885dcf58ad2ef63ec7289cf2481d51c",
          "feeTier": 10000
        },
        {
          "symbol": "AAPL",
          "address": "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9",
          "decimals": 18,
          "pool": "0x783c9bbb765047cfdd2b84b92b2ca9f11d34b7ed",
          "feeTier": 3000
        },
        {
          "symbol": "COST",
          "address": "0x4EA005168D7F09a7A0Ba9D1DEf21a479950E44C2",
          "decimals": 18,
          "pool": "0x0a2121a50a09ed0796ae81f9c53ff9398355a398",
          "feeTier": 3000
        },
        {
          "symbol": "USO",
          "address": "0xa30FA36Db767ad9eD3f7a60fC79526fB4d56D344",
          "decimals": 18,
          "pool": "0x6ed11c7dfd8e2ca5620eed29a7b9b53ae90dd0d2",
          "feeTier": 10000
        },
        {
          "symbol": "QQQ",
          "address": "0xD5f3879160bc7c32ebb4dC785F8a4F505888de68",
          "decimals": 18,
          "pool": "0xebd78dcfc8a6b3a696f1e191ad1ff321f9579f79",
          "feeTier": 3000
        },
        {
          "symbol": "TSLA",
          "address": "0x322F0929c4625eD5bAd873c95208D54E1c003b2d",
          "decimals": 18,
          "pool": "0xf4acdaeeb7022862a763c9b1b885e11191c889e3",
          "feeTier": 3000
        },
        {
          "symbol": "RDDT",
          "address": "0x05b37Fb53A299a1b874A619e1c4C404D52C36F4C",
          "decimals": 18,
          "pool": "0xa8744e76aed23b05f0126335e7bd38f7935d19fe",
          "feeTier": 10000
        },
        {
          "symbol": "MSFT",
          "address": "0xe93237C50D904957Cf27E7B1133b510C669c2e74",
          "decimals": 18,
          "pool": "0xeb60bcd1d920ad6e102690ccfc6fb488899e1510",
          "feeTier": 3000
        },
        {
          "symbol": "NFLX",
          "address": "0xE0444EF8BF4eD74f74FD73686e2ddF4C1c5591E8",
          "decimals": 18,
          "pool": "0xea75ea625d83ae276b9ae8b0a3dc205916ee65cf",
          "feeTier": 10000
        },
        {
          "symbol": "DELL",
          "address": "0x941AE714EC6D8130c7B75d67160Ca08f1e7d11Dd",
          "decimals": 18,
          "pool": "0xc30c89cb7815a1488b7998d15eec73961707fc5a",
          "feeTier": 10000
        },
        {
          "symbol": "INTC",
          "address": "0xc72b96e0E48ecd4DC75E1e45396e26300BC39681",
          "decimals": 18,
          "pool": "0x2e5a92f5013a64661a49312111be2e8abd33f56a",
          "feeTier": 3000
        },
        {
          "symbol": "GOOGL",
          "address": "0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3",
          "decimals": 18,
          "pool": "0x553e9a453425cd9b90919f317061fbc3794cc57a",
          "feeTier": 3000
        },
        {
          "symbol": "ASML",
          "address": "0x47F93d52cBeC7C6D2CfC080e154002370a60dAEA",
          "decimals": 18,
          "pool": "0xedb22516b14eb2d1c86927db373b0e8bf70f5cd1",
          "feeTier": 10000
        },
        {
          "symbol": "AMZN",
          "address": "0x12f190a9F9d7D37a250758b26824B97CE941bF54",
          "decimals": 18,
          "pool": "0x8ac92da74ab5f3b1d024dc1943ad7e15dc4179ef",
          "feeTier": 3000
        },
        {
          "symbol": "MSTR",
          "address": "0xec262a75e413fAfD0dF80480274532C79D42da09",
          "decimals": 18,
          "pool": "0x17578c0e0d15da44f31677263114f71ae76653ea",
          "feeTier": 10000
        },
        {
          "symbol": "PLTR",
          "address": "0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A",
          "decimals": 18,
          "pool": "0x851680416a4f4e1c463d45171d61acddbc8554c0",
          "feeTier": 3000
        },
        {
          "symbol": "RBLX",
          "address": "0xF0C4BF4C582cb3836e98394b1d4e7B7281101bE8",
          "decimals": 18,
          "pool": "0x2ef5945cd5664876b6481fdacfaa2942995a4da8",
          "feeTier": 10000
        }
      ],
      "tokenOut": {
        "symbol": "USDG",
        "address": "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
        "decimals": 6
      },
      "venue": {
        "name": "Uniswap V3 SwapRouter02 (Robinhood Chain canonical)",
        "address": "0xCaf681a66D020601342297493863E78C959E5cb2"
      },
      "caps": {
        "perTx": {
          "baseUnits": "10000000000000000000",
          "human": "10 tokens (~$200 at a $20 floor price; pricier tokens can move more USD per tx \u2014 blast-radius ceiling, exact % enforced off-chain)"
        }
      },
      "riskBounds": {
        "agentSlippageBps": 150,
        "bandToleranceBps": 600
      }
    },
    {
      "id": "router-approvals",
      "kind": "custom",
      "chain": 4663,
      "route": {
        "type": "bespoke",
        "name": "BoundedErc20Approve"
      },
      "tokenInBasket": [
        {
          "symbol": "USDG",
          "address": "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
          "decimals": 6
        },
        {
          "symbol": "NVDA",
          "address": "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC",
          "decimals": 18,
          "pool": "0xd4eb21209c4d6093f80b5b84f5c45cc093ea14a3",
          "feeTier": 500
        },
        {
          "symbol": "SPCX",
          "address": "0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa",
          "decimals": 18,
          "pool": "0xeb07d9587efd1778dfb9c385ec43ef6d5f9fe401",
          "feeTier": 3000
        },
        {
          "symbol": "GME",
          "address": "0x1b0E319c6A659F002271B69dB8A7df2F911c153E",
          "decimals": 18,
          "pool": "0xe2b46c905e12ab8e2f864e4821a4325884c1b126",
          "feeTier": 500
        },
        {
          "symbol": "SPY",
          "address": "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C",
          "decimals": 18,
          "pool": "0xa43b424bc609495aed4bcd88d654934b510b0ad9",
          "feeTier": 3000
        },
        {
          "symbol": "SLV",
          "address": "0x411eFb0E7f985935DAec3D4C3ebaEa0d0AD7D89f",
          "decimals": 18,
          "pool": "0x0fa7bc480885dcf58ad2ef63ec7289cf2481d51c",
          "feeTier": 10000
        },
        {
          "symbol": "AAPL",
          "address": "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9",
          "decimals": 18,
          "pool": "0x783c9bbb765047cfdd2b84b92b2ca9f11d34b7ed",
          "feeTier": 3000
        },
        {
          "symbol": "COST",
          "address": "0x4EA005168D7F09a7A0Ba9D1DEf21a479950E44C2",
          "decimals": 18,
          "pool": "0x0a2121a50a09ed0796ae81f9c53ff9398355a398",
          "feeTier": 3000
        },
        {
          "symbol": "USO",
          "address": "0xa30FA36Db767ad9eD3f7a60fC79526fB4d56D344",
          "decimals": 18,
          "pool": "0x6ed11c7dfd8e2ca5620eed29a7b9b53ae90dd0d2",
          "feeTier": 10000
        },
        {
          "symbol": "QQQ",
          "address": "0xD5f3879160bc7c32ebb4dC785F8a4F505888de68",
          "decimals": 18,
          "pool": "0xebd78dcfc8a6b3a696f1e191ad1ff321f9579f79",
          "feeTier": 3000
        },
        {
          "symbol": "TSLA",
          "address": "0x322F0929c4625eD5bAd873c95208D54E1c003b2d",
          "decimals": 18,
          "pool": "0xf4acdaeeb7022862a763c9b1b885e11191c889e3",
          "feeTier": 3000
        },
        {
          "symbol": "RDDT",
          "address": "0x05b37Fb53A299a1b874A619e1c4C404D52C36F4C",
          "decimals": 18,
          "pool": "0xa8744e76aed23b05f0126335e7bd38f7935d19fe",
          "feeTier": 10000
        },
        {
          "symbol": "MSFT",
          "address": "0xe93237C50D904957Cf27E7B1133b510C669c2e74",
          "decimals": 18,
          "pool": "0xeb60bcd1d920ad6e102690ccfc6fb488899e1510",
          "feeTier": 3000
        },
        {
          "symbol": "NFLX",
          "address": "0xE0444EF8BF4eD74f74FD73686e2ddF4C1c5591E8",
          "decimals": 18,
          "pool": "0xea75ea625d83ae276b9ae8b0a3dc205916ee65cf",
          "feeTier": 10000
        },
        {
          "symbol": "DELL",
          "address": "0x941AE714EC6D8130c7B75d67160Ca08f1e7d11Dd",
          "decimals": 18,
          "pool": "0xc30c89cb7815a1488b7998d15eec73961707fc5a",
          "feeTier": 10000
        },
        {
          "symbol": "INTC",
          "address": "0xc72b96e0E48ecd4DC75E1e45396e26300BC39681",
          "decimals": 18,
          "pool": "0x2e5a92f5013a64661a49312111be2e8abd33f56a",
          "feeTier": 3000
        },
        {
          "symbol": "GOOGL",
          "address": "0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3",
          "decimals": 18,
          "pool": "0x553e9a453425cd9b90919f317061fbc3794cc57a",
          "feeTier": 3000
        },
        {
          "symbol": "ASML",
          "address": "0x47F93d52cBeC7C6D2CfC080e154002370a60dAEA",
          "decimals": 18,
          "pool": "0xedb22516b14eb2d1c86927db373b0e8bf70f5cd1",
          "feeTier": 10000
        },
        {
          "symbol": "AMZN",
          "address": "0x12f190a9F9d7D37a250758b26824B97CE941bF54",
          "decimals": 18,
          "pool": "0x8ac92da74ab5f3b1d024dc1943ad7e15dc4179ef",
          "feeTier": 3000
        },
        {
          "symbol": "MSTR",
          "address": "0xec262a75e413fAfD0dF80480274532C79D42da09",
          "decimals": 18,
          "pool": "0x17578c0e0d15da44f31677263114f71ae76653ea",
          "feeTier": 10000
        },
        {
          "symbol": "PLTR",
          "address": "0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A",
          "decimals": 18,
          "pool": "0x851680416a4f4e1c463d45171d61acddbc8554c0",
          "feeTier": 3000
        },
        {
          "symbol": "RBLX",
          "address": "0xF0C4BF4C582cb3836e98394b1d4e7B7281101bE8",
          "decimals": 18,
          "pool": "0x2ef5945cd5664876b6481fdacfaa2942995a4da8",
          "feeTier": 10000
        }
      ],
      "recipients": [
        "0xCaf681a66D020601342297493863E78C959E5cb2"
      ],
      "caps": {
        "perTx": {
          "human": "uncapped standing approvals to the allowlisted router only (allowance size does not widen what a swap may do)"
        }
      }
    }
  ],
  "cadence": "pipeline once per UTC day (news -> thesis -> SyntheTick screen -> plan); execution ticks every SAILOR_INTERVAL drain the plan, max 2 swaps/tick",
  "exitCondition": "No exit condition \u2014 runs until paused or revoked (sailor session pause / mandate revoke)",
  "provenance": {
    "resolvedAt": "2026-08-03T09:07:41Z",
    "chains": {
      "4663": {
        "rpc": "https://rpc.mainnet.chain.robinhood.com (public), pools via GeckoTerminal + factory()-verified on-chain"
      }
    }
  },
  "confirmedByUser": false,
  "version": 3
}
```

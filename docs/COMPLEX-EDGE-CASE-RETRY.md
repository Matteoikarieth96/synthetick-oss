# Signal Desk — 20 complex edge-case report

> AI-generated test output (LLM), not investment advice, no vendor data redistributed

Generated: 2026-07-12T07:10:58.753Z · Cases run: 3 · Passed: 3 · Failed: 0

| # | Case | Status | Expected hits | Picks | Leaks | Time |
|---:|---|---|---|---:|---:|---:|
| 6 | US next-generation gene sequencing | PASS | ILMN, PACB, TXG | 5 | 0 | 70.1s |
| 19 | Mixed AI data-center stocks and crypto | PASS | RENDER, TAO, AKT | 10 | 0 | 80.9s |
| 20 | Streaming disruption long-and-short book | PASS | NFLX, ROKU, CHTR | 10 | 0 | 129.2s |

## 6. US next-generation gene sequencing — PASS

**Prompt:** Long-read sequencing and lower per-genome costs should expand research and clinical genomics. Screen only US stocks that manufacture gene-sequencing instruments or platforms.

**Expected assets:** ILMN, PACB, TXG

**Why expected:** Illumina, Pacific Biosciences and 10x Genomics are direct listed sequencing-platform exposures.

**Returned:** PACB (Pacific Biosciences of California, Inc.; stock; long; 97), ILMN (Illumina, Inc.; stock; long; 88), TXG (10x Genomics, Inc.; stock; long; 72), QSI (Quantum-Si incorporated; stock; long; 68), TMO (Thermo Fisher Scientific Inc.; stock; long; 52)

**Expected hits:** ILMN, PACB, TXG

**Checks:** hard filters PASS · direction long · path full

## 19. Mixed AI data-center stocks and crypto — PASS

**Prompt:** AI data-center buildout should reward physical cooling and networking suppliers as well as decentralized compute networks. Screen only US stocks and crypto, and include both asset classes.

**Expected assets:** VRT, MOD, AVGO, RENDER, TAO, AKT

**Why expected:** VRT/MOD/AVGO are direct US infrastructure exposures; RENDER/TAO/AKT are direct crypto compute-network exposures.

**Returned:** ANET (Arista Networks, Inc.; stock; long; 92), NVDA (NVIDIA Corporation; stock; long; 88), SMCI (Super Micro Computer, Inc.; stock; long; 85), RENDER (Render; crypto; long; 82), IO (io.net; crypto; long; 80), ATH (Aethir; crypto; long; 78), AKT (Akash Network; crypto; long; 75), APH (Amphenol Corporation; stock; long; 72), TAO (Bittensor; crypto; long; 70), AMD (Advanced Micro Devices, Inc.; stock; long; 65)

**Expected hits:** RENDER, TAO, AKT

**Checks:** hard filters PASS · direction long · path full

## 20. Streaming disruption long-and-short book — PASS

**Prompt:** Streaming subscriptions and ad-supported streaming will keep taking viewing time from linear television. Give me both long positions in streaming winners and short candidates among US-listed legacy cable or linear-TV companies. Only US stocks.

**Expected assets:** NFLX, ROKU, SPOT, CHTR, PARA, WBD

**Why expected:** NFLX/ROKU/SPOT express streaming growth; CHTR/PARA/WBD/CMCSA carry legacy distribution or linear-TV exposure.

**Returned:** NFLX (Netflix, Inc.; stock; long; 97), ROKU (Roku, Inc.; stock; long; 92), DIS (The Walt Disney Company; stock; long; 78), MGNI (Magnite, Inc.; stock; long; 74), TTD (The Trade Desk, Inc.; stock; long; 71), CMCSA (Comcast Corporation; stock; short; 88), CHTR (Charter Communications, Inc.; stock; short; 87), AMCX (AMC Global Media Inc.; stock; short; 84), GTN (Gray Media, Inc.; stock; short; 74), FOXA (Fox Corporation; stock; short; 72)

**Expected hits:** NFLX, ROKU, CHTR

**Expected-side hits:** long NFLX, ROKU · short CHTR, CMCSA

**Checks:** hard filters PASS · direction both · path full

Total runtime: 4.7 minutes. This was a selected-case rerun.

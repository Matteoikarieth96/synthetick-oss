# Signal Desk — 20 complex edge-case report

> AI-generated test output (LLM), not investment advice, no vendor data redistributed

Generated: 2026-07-12T06:49:40.750Z · Cases run: 20 · Passed: 17 · Failed: 3

| # | Case | Status | Expected hits | Picks | Leaks | Time |
|---:|---|---|---|---:|---:|---:|
| 1 | Italian merchant-payments infrastructure | PASS | NEXI.MI | 5 | 0 | 71.8s |
| 2 | European hearing-aid manufacturers | PASS | DEMANT.CO, GN.CO, SOON.SW | 5 | 0 | 84.6s |
| 3 | European commercial-aircraft engines | PASS | MTX.DE, RR.L | 2 | 0 | 75.1s |
| 4 | European securities-exchange operators | PASS | DB1.DE, LSEG.L | 2 | 0 | 54.4s |
| 5 | US electronic-design-automation duopoly | PASS | CDNS, SNPS | 4 | 0 | 61.6s |
| 6 | US next-generation gene sequencing | FAIL | — | 0 | 0 | 16.2s |
| 7 | Short US packaged snacks after GLP-1 adoption | PASS | MDLZ, HSY, SJM | 9 | 0 | 140.3s |
| 8 | HKEX Chinese online-travel platforms | PASS | 0780.HK, 780.HK | 1 | 0 | 59.6s |
| 9 | HKEX Chinese EV-battery manufacturers | PASS | 1211.HK, 3750.HK | 5 | 0 | 60.4s |
| 10 | US managed-futures ETFs | PASS | DBMF, KMLM, CTA | 10 | 0 | 93.6s |
| 11 | US short-duration inflation-linked bond ETFs | PASS | STIP | 7 | 0 | 72.6s |
| 12 | US cybersecurity ETFs only | PASS | CIBR, HACK, IHAK, BUG | 6 | 0 | 62.1s |
| 13 | Decentralized storage excluding Filecoin | PASS | AR, STORJ, SC | 9 | 0 | 73.1s |
| 14 | Bitcoin scaling networks excluding BTC | PASS | STX, CORE, MERL | 10 | 0 | 78.6s |
| 15 | Privacy-preserving payment coins | PASS | XMR, ZEC | 6 | 0 | 66.3s |
| 16 | Solana liquid-staking ecosystem excluding SOL | PASS | JTO | 3 | 0 | 47.4s |
| 17 | Private AI-inference chip companies | PASS | GROQ | 1 | 0 | 59.9s |
| 18 | US alternatives to Nvidia excluding NVDA | PASS | AMD, MRVL | 10 | 0 | 90.1s |
| 19 | Mixed AI data-center stocks and crypto | FAIL | — | 0 | 0 | 167.3s |
| 20 | Streaming disruption long-and-short book | FAIL | — | 0 | 0 | 10.5s |

## 1. Italian merchant-payments infrastructure — PASS

**Prompt:** Cashless adoption and merchant acquiring consolidation should benefit scaled Italian payment processors. Screen only Italian stocks directly exposed to digital merchant payments.

**Expected assets:** NEXI.MI

**Why expected:** Nexi is the primary listed Italian merchant-acquiring and payments-infrastructure pure play.

**Returned:** NEXI.MI (Nexi S.p.A.; stock; long; 99), PST.MI (Poste Italiane S.p.A.; stock; long; 42), TNXT.MI (Tinexta S.p.A.; stock; long; 31), MOL.MI (Moltiply Group S.p.A.; stock; long; 22), FBK.MI (FinecoBank Banca Fineco S.p.A.; stock; long; 18)

**Expected hits:** NEXI.MI

**Checks:** hard filters PASS · direction long · path full

## 2. European hearing-aid manufacturers — PASS

**Prompt:** Ageing populations and better miniaturized devices support long-term hearing-aid penetration. Screen only European stocks that manufacture hearing aids or hearing-care devices.

**Expected assets:** DEMANT.CO, GN.CO, SOON.SW

**Why expected:** Demant, GN Store Nord and Sonova are the core listed European hearing-device manufacturers.

**Returned:** DEMANT.CO (Demant A/S; stock; long; 99), SOON.SW (Sonova Holding AG; stock; long; 99), GN.CO (GN Store Nord A/S; stock; long; 95), AMP.MI (Amplifon S.p.A.; stock; long; 90), FIE.DE (Fielmann AG; stock; long; 62)

**Expected hits:** DEMANT.CO, GN.CO, SOON.SW

**Checks:** hard filters PASS · direction long · path full

## 3. European commercial-aircraft engines — PASS

**Prompt:** A decade of commercial aircraft backlog should support engine deliveries and high-margin aftermarket service. Screen only European stocks that manufacture large commercial-aircraft engines.

**Expected assets:** SAF.PA, MTX.DE, RR.L

**Why expected:** Safran, MTU Aero Engines and Rolls-Royce are the main listed European commercial-engine exposures.

**Returned:** RR.L (Rolls-Royce Holdings plc; stock; long; 98), MTX.DE (MTU Aero Engines AG; stock; long; 90)

**Expected hits:** MTX.DE, RR.L

**Checks:** hard filters PASS · direction long · path full

## 4. European securities-exchange operators — PASS

**Prompt:** Higher market volatility and expanding derivatives volumes should benefit trading venues. Screen only European stocks that directly operate securities exchanges or clearing venues.

**Expected assets:** DB1.DE, LSEG.L, ENX.PA

**Why expected:** Deutsche Börse, London Stock Exchange Group and Euronext are the direct European exchange operators.

**Returned:** DB1.DE (Deutsche Börse AG; stock; long; 97), LSEG.L (London Stock Exchange Group plc; stock; long; 82)

**Expected hits:** DB1.DE, LSEG.L

**Checks:** hard filters PASS · direction long · path full

## 5. US electronic-design-automation duopoly — PASS

**Prompt:** Chip complexity makes verification and electronic design automation software increasingly indispensable. Screen only US stocks whose core business is semiconductor EDA software.

**Expected assets:** CDNS, SNPS

**Why expected:** Cadence and Synopsys form the dominant listed EDA software duopoly.

**Returned:** SNPS (Synopsys, Inc.; stock; long; 99), CDNS (Cadence Design Systems, Inc.; stock; long; 98), SVCO (Silvaco Group, Inc. Common Stock; stock; long; 72), PDFS (PDF Solutions, Inc.; stock; long; 42)

**Expected hits:** CDNS, SNPS

**Checks:** hard filters PASS · direction long · path full

## 6. US next-generation gene sequencing — FAIL

**Prompt:** Long-read sequencing and lower per-genome costs should expand research and clinical genomics. Screen only US stocks that manufacture gene-sequencing instruments or platforms.

**Expected assets:** ILMN, PACB, TXG

**Why expected:** Illumina, Pacific Biosciences and 10x Genomics are direct listed sequencing-platform exposures.

**Returned:** No assets

**Expected hits:** None

**Checks:** hard filters PASS · direction — · path error

**Issues:** match_candidates RPC failed: canceling statement due to statement timeout

## 7. Short US packaged snacks after GLP-1 adoption — PASS

**Prompt:** GLP-1 adoption will structurally reduce calorie intake and impulse snacking. Give me short candidates only among US-listed packaged-snack manufacturers, not retailers or restaurants.

**Expected assets:** MDLZ, HSY, KHC, SJM

**Why expected:** Mondelez, Hershey, Kraft Heinz and J.M. Smucker have direct packaged-snack exposure.

**Returned:** MDLZ (Mondelez International, Inc.; stock; short; 95), UTZ (Utz Brands, Inc.; stock; short; 93), HSY (The Hershey Company; stock; short; 88), TR (Tootsie Roll Industries, Inc.; stock; short; 80), SJM (The J. M. Smucker Company; stock; short; 75), CPB (Campbell Soup Company; stock; short; 62), POST (Post Holdings, Inc.; stock; short; 48), GIS (General Mills, Inc.; stock; short; 45), JJSF (J&J Snack Foods Corp.; stock; short; 42)

**Expected hits:** MDLZ, HSY, SJM

**Checks:** hard filters PASS · direction short · path full

## 8. HKEX Chinese online-travel platforms — PASS

**Prompt:** Chinese outbound tourism and domestic hotel bookings should normalize upward. Screen only HKEX-listed Chinese online-travel booking platforms.

**Expected assets:** 9961.HK, 0780.HK, 780.HK

**Why expected:** Trip.com and Tongcheng Travel are the main HKEX-listed Chinese online-travel platforms.

**Returned:** 0780.HK (Tongcheng Travel Holdings Limited; stock; long; 97)

**Expected hits:** 0780.HK, 780.HK

**Checks:** hard filters PASS · direction long · path full

## 9. HKEX Chinese EV-battery manufacturers — PASS

**Prompt:** Battery cost declines and vertical integration should strengthen leading Chinese EV-battery suppliers. Screen only HKEX-listed Chinese companies that manufacture EV batteries or battery cells.

**Expected assets:** 1211.HK, 3750.HK

**Why expected:** BYD and CATL are the clearest HKEX-listed Chinese battery-manufacturing exposures.

**Returned:** 3750.HK (Contemporary Amperex Technology Co., Limited; stock; long; 97), 1211.HK (BYD Company Limited; stock; long; 92), 3931.HK (CALB Group Co., Ltd.; stock; long; 90), 0666.HK (REPT BATTERO Energy Co Ltd; stock; long; 88), 3677.HK (Jiangsu Zenergy Battery Technologies Group Co., Ltd.; stock; long; 72)

**Expected hits:** 1211.HK, 3750.HK

**Checks:** hard filters PASS · direction long · path full

## 10. US managed-futures ETFs — PASS

**Prompt:** Persistent macro dispersion should reward systematic trend following across commodities, rates, currencies and equities. Screen only US-listed managed-futures ETFs.

**Expected assets:** DBMF, KMLM, CTA, FMF

**Why expected:** DBMF, KMLM, CTA and FMF are established US-listed managed-futures ETFs.

**Returned:** DBMF (iMGP DBi Managed Futures Strategy ETF; etf; long; 95), CTA (Simplify Managed Futures Strategy ETF; etf; long; 94), KMLM (KraneShares Mount Lucas Managed Futures Index Strategy ETF; etf; long; 92), AHLT (American Beacon Select Funds - Ahl Liquid Trend ETF; etf; long; 91), TFPN (Blueprint Chesapeake Multi-Asset Trend ETF; etf; long; 90), WTMF (WisdomTree Managed Futures Strategy Fund; etf; long; 88), FFUT (Fidelity Managed Futures ETF; etf; long; 85), IALT (iShares Systematic Alternatives Active ETF; etf; long; 78), CTAP (Simplify US Equity PLUS Managed Futures Strategy ETF; etf; long; 72), LALT (First Trust Multi-Strategy Alternative ETF; etf; long; 62)

**Expected hits:** DBMF, KMLM, CTA

**Checks:** hard filters PASS · direction long · path full

## 11. US short-duration inflation-linked bond ETFs — PASS

**Prompt:** Inflation may stay sticky, but I want minimal interest-rate duration. Screen only US bond ETFs holding short-maturity Treasury Inflation-Protected Securities.

**Expected assets:** VTIP, STIP

**Why expected:** VTIP and STIP are the primary short-duration US TIPS ETFs.

**Returned:** STIP (iShares 0-5 Year TIPS Bond ETF; bond; long; 98), STPZ (PIMCO 1-5 Year U.S. TIPS Index Exchange-Traded Fund; bond; long; 96), RBIL (F/m Ultrashort Treasury Inflation-Protected Security (TIPS) ETF; bond; long; 95), IBIC (iShares iBonds Oct 2026 Term TIPS ETF; bond; long; 90), IBID (iShares iBonds Oct 2027 Term TIPS ETF; bond; long; 85), IBIE (iShares iBonds Oct 2028 Term TIPS ETF; bond; long; 80), IBIG (iShares iBonds Oct 2030 Term TIPS ETF; bond; long; 55)

**Expected hits:** STIP

**Checks:** hard filters PASS · direction long · path full

## 12. US cybersecurity ETFs only — PASS

**Prompt:** AI-driven attacks should keep enterprise cybersecurity spending resilient. Screen only US-listed cybersecurity ETFs, with no individual stocks.

**Expected assets:** CIBR, HACK, IHAK, BUG

**Why expected:** CIBR, HACK, IHAK and BUG are direct US-listed cybersecurity ETFs.

**Returned:** HACK (Amplify Cybersecurity ETF; etf; long; 97), CIBR (First Trust Nasdaq Cybersecurity ETF; etf; long; 96), BUG (Global X - Cybersecurity ETF; etf; long; 95), WCBR (WisdomTree Cybersecurity Fund; etf; long; 94), IHAK (iShares Cybersecurity and Tech ETF; etf; long; 92), FITE (State Street SPDR S&P Kensho Future Security ETF; etf; long; 52)

**Expected hits:** CIBR, HACK, IHAK, BUG

**Checks:** hard filters PASS · direction long · path full

## 13. Decentralized storage excluding Filecoin — PASS

**Prompt:** Decentralized storage networks can undercut centralized cloud archives. Screen only crypto storage-network tokens available on centralized exchanges, but exclude Filecoin.

**Expected assets:** AR, STORJ, SC

**Why expected:** Arweave, Storj and Siacoin are the main non-Filecoin decentralized-storage tokens.

**Returned:** SC (Siacoin; crypto; long; 92), STORJ (Storj; crypto; long; 92), AR (Arweave; crypto; long; 85), ANT (Autonomi; crypto; long; 80), ICNT (Impossible Cloud Network Token; crypto; long; 78), CESS (CESS Network; crypto; long; 75), SRX (StorX; crypto; long; 72), BTT (BitTorrent; crypto; long; 65), AIOZ (AIOZ Network; crypto; long; 55)

**Expected hits:** AR, STORJ, SC

**Checks:** hard filters PASS · direction long · path full

## 14. Bitcoin scaling networks excluding BTC — PASS

**Prompt:** Applications and faster settlement layers can expand the Bitcoin economy. Screen only crypto tokens for Bitcoin layer-2 or Bitcoin scaling networks, excluding BTC itself, and require centralized-exchange access.

**Expected assets:** STX, CORE, MERL

**Why expected:** Stacks, Core and Merlin Chain are prominent tradable Bitcoin-scaling network tokens.

**Returned:** MERL (Merlin Chain; crypto; long; 92), CTR (Citrea; crypto; long; 91), FB (Fractal Bitcoin; crypto; long; 89), STX (Stacks; crypto; long; 87), BTR (Bitlayer; crypto; long; 85), BOB (BOB (Build on Bitcoin); crypto; long; 83), HEMI (Hemi; crypto; long; 72), CORE (Core; crypto; long; 68), CKB (Nervos Network; crypto; long; 52), GOATED (GOAT Network; crypto; long; 50)

**Expected hits:** STX, CORE, MERL

**Checks:** hard filters PASS · direction long · path full

## 15. Privacy-preserving payment coins — PASS

**Prompt:** Demand for censorship-resistant private payments will persist. Screen only privacy-focused crypto payment coins available on centralized exchanges.

**Expected assets:** XMR, ZEC, DASH

**Why expected:** Monero, Zcash and Dash are the established listed privacy-payment coins.

**Returned:** XMR (Monero; crypto; long; 97), ZEC (Zcash; crypto; long; 90), FIRO (Firo; crypto; long; 82), PIVX (PIVX; crypto; long; 75), DCR (Decred; crypto; long; 52), XVG (Verge; crypto; long; 44)

**Expected hits:** XMR, ZEC

**Checks:** hard filters PASS · direction long · path full

## 16. Solana liquid-staking ecosystem excluding SOL — PASS

**Prompt:** Liquid staking can turn Solana staking positions into composable collateral. Screen only crypto tokens directly tied to Solana liquid-staking protocols, exclude SOL, and require centralized-exchange access.

**Expected assets:** JTO, MNDE, INF

**Why expected:** Jito and Marinade are the main tokenized Solana liquid-staking protocol exposures.

**Returned:** JTO (Jito; crypto; long; 95), CLOUD (Cloud; crypto; long; 85), LAYER (Solayer; crypto; long; 50)

**Expected hits:** JTO

**Checks:** hard filters PASS · direction long · path full

## 17. Private AI-inference chip companies — PASS

**Prompt:** Low-latency inference will create demand for specialized accelerators beyond GPUs. Screen only pre-IPO private companies whose core product is AI inference hardware.

**Expected assets:** GROQ

**Why expected:** Groq is the directly covered private AI-inference accelerator company in the watchlist.

**Returned:** GROQ (Groq; private; long; 92)

**Expected hits:** GROQ

**Checks:** hard filters PASS · direction long · path full

## 18. US alternatives to Nvidia excluding NVDA — PASS

**Prompt:** Find US-listed semiconductor companies similar to Nvidia that can benefit from AI accelerator and networking demand, but exclude Nvidia itself.

**Expected assets:** AMD, AVGO, MRVL, ARM

**Why expected:** AMD, Broadcom, Marvell and Arm are the most direct listed alternatives across accelerators, networking and architectures.

**Returned:** AMD (Advanced Micro Devices, Inc.; stock; long; 95), MRVL (Marvell Technology, Inc.; stock; long; 92), ALAB (Astera Labs, Inc. Common Stock; stock; long; 90), CBRS (Cerebras Systems Inc.; stock; long; 85), CEVA (CEVA, Inc.; stock; long; 78), ANET (Arista Networks, Inc.; stock; long; 75), MU (Micron Technology, Inc.; stock; long; 74), SMTC (Semtech Corporation; stock; long; 62), LSCC (Lattice Semiconductor Corporation; stock; long; 58), SNPS (Synopsys, Inc.; stock; long; 55)

**Expected hits:** AMD, MRVL

**Checks:** hard filters PASS · direction long · path full

## 19. Mixed AI data-center stocks and crypto — FAIL

**Prompt:** AI data-center buildout should reward physical cooling and networking suppliers as well as decentralized compute networks. Screen only US stocks and crypto, and include both asset classes.

**Expected assets:** VRT, MOD, AVGO, RENDER, TAO, AKT

**Why expected:** VRT/MOD/AVGO are direct US infrastructure exposures; RENDER/TAO/AKT are direct crypto compute-network exposures.

**Returned:** No assets

**Expected hits:** None

**Checks:** hard filters PASS · direction — · path error

**Issues:** fetch failed

## 20. Streaming disruption long-and-short book — FAIL

**Prompt:** Streaming subscriptions and ad-supported streaming will keep taking viewing time from linear television. Give me both long positions in streaming winners and short candidates among US-listed legacy cable or linear-TV companies. Only US stocks.

**Expected assets:** NFLX, ROKU, SPOT, CHTR, PARA, WBD

**Why expected:** NFLX/ROKU/SPOT express streaming growth; CHTR/PARA/WBD/CMCSA carry legacy distribution or linear-TV exposure.

**Returned:** No assets

**Expected hits:** None

**Expected-side hits:** long none · short none

**Checks:** hard filters PASS · direction — · path error

**Issues:** fetch failed

Total runtime: 24.1 minutes.

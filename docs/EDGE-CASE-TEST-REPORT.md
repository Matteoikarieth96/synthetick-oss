# Signal Desk — Edge-case matching report

> AI-generated test output (LLM), not investment advice, no vendor data redistributed

Generated: 2026-07-11T14:34:59.128Z · Full-pipeline cases: 10 · Passed: 7 · Failed: 3

| # | Edge case | Status | Picks | Direction | Hard-filter leaks | Time |
|---|---|---|---:|---|---:|---:|
| 1 | Italian ultra-luxury sports cars | PASS | 5 | long | 0 | 66.5s |
| 2 | European semiconductor equipment | FAIL | 0 | — | 0 | 16.2s |
| 3 | HKEX food-delivery platforms | FAIL | 0 | long | 0 | 10.4s |
| 4 | US orbital launch pure plays | PASS | 9 | long | 0 | 86.8s |
| 5 | US uranium enrichment | FAIL | 0 | — | 0 | 19.0s |
| 6 | European subsea power cables | PASS | 2 | long | 0 | 52.0s |
| 7 | US ultra-short Treasury ETFs | PASS | 10 | long | 0 | 71.9s |
| 8 | Crypto oracles excluding Chainlink | PASS | 10 | long | 0 | 78.0s |
| 9 | Liquid-staking tokens excluding ETH | PASS | 10 | long | 0 | 100.9s |
| 10 | Private defense-autonomy companies | PASS | 2 | long | 0 | 74.1s |

## 1. Italian ultra-luxury sports cars — PASS

**Prompt:** Ultra-luxury sports-car makers can preserve margins through scarcity, brand heritage and long waitlists. Screen only Italian stocks.

**Expected niche:** Ferrari or another directly relevant Italian luxury-auto company

**Returned:** RACE.MI (Ferrari N.V.), MONC.MI (Moncler S.p.A.), BC.MI (Brunello Cucinelli S.p.A.), SFER.MI (Salvatore Ferragamo S.p.A.), PINF.MI (Pininfarina S.p.A.)

**Checks:** relevance PASS · hard filters PASS · path full

## 2. European semiconductor equipment — FAIL

**Prompt:** Advanced chip nodes require increasingly complex lithography, deposition and packaging equipment. Screen only European stocks that sell semiconductor manufacturing equipment.

**Expected niche:** ASML, ASM International, BESI, or a comparable European equipment supplier

**Returned:** No assets

**Checks:** relevance FAIL · hard filters PASS · path error

**Issue:** match_candidates RPC failed: canceling statement due to statement timeout

## 3. HKEX food-delivery platforms — FAIL

**Prompt:** Local-commerce platforms in China can improve margins as food-delivery competition rationalizes. Screen only HKEX-listed Chinese stocks directly exposed to food delivery.

**Expected niche:** Meituan or another HKEX-listed Chinese food-delivery platform

**Returned:** No assets

**Checks:** relevance FAIL · hard filters PASS · path empty

**Issue:** unexpected empty result; no result matched the expected niche: Meituan or another HKEX-listed Chinese food-delivery platform

## 4. US orbital launch pure plays — PASS

**Prompt:** Falling launch costs and rising satellite demand benefit companies that build launch vehicles and orbital systems. Screen only US-listed stocks with direct space-launch exposure.

**Expected niche:** Rocket Lab or another directly exposed US-listed launch company

**Returned:** RKLB (Rocket Lab USA, Inc.), FLY (Firefly Aerospace Inc.), LUNR (Intuitive Machines, Inc.), RDW (Redwire Corp), KRMN (Karman Holdings Inc.), AADX (Applied Aerospace & Defense, Inc.), VOYG (Voyager Technologies, Inc.), SPIR (Spire Global, Inc.), PL (Planet Labs PBC)

**Checks:** relevance PASS · hard filters PASS · path full

## 5. US uranium enrichment — FAIL

**Prompt:** Western nuclear expansion creates a bottleneck in domestic uranium enrichment and nuclear-fuel services. Screen only US stocks directly exposed to enrichment or the nuclear fuel cycle.

**Expected niche:** Centrus Energy or another direct US nuclear-fuel-cycle company

**Returned:** No assets

**Checks:** relevance FAIL · hard filters PASS · path error

**Issue:** match_candidates RPC failed: canceling statement due to statement timeout

## 6. European subsea power cables — PASS

**Prompt:** Grid interconnectors and offshore wind create a multiyear shortage of high-voltage subsea power cables. Screen only European stocks that manufacture power cables.

**Expected niche:** Prysmian, Nexans, NKT, or another European power-cable manufacturer

**Returned:** PRY.MI (Prysmian S.p.A.), CENER.BR (Cenergy Holdings S.A.)

**Checks:** relevance PASS · hard filters PASS · path full

## 7. US ultra-short Treasury ETFs — PASS

**Prompt:** I want cash-like exposure to US Treasury bills with minimal duration risk. Screen only US bond ETFs focused on bills maturing within roughly one year.

**Expected niche:** SGOV, BIL, SHV, or another ultra-short US Treasury-bill ETF

**Returned:** BIL (State Street SPDR Bloomberg 1-3 Month T-Bill ETF), SGOV (iShares 0-3 Month Treasury Bond ETF), TBIL (F/m US Treasury 3 Month Bill Fund), BILS (State Street SPDR Bloomberg 3-12 Month T-Bill ETF), GBIL (Goldman Sachs Access Treasury 0-1 Year ETF), SHV (iShares Trust iShares 0-1 Year Treasury Bond ETF), XBIL (US Treasury 6 Month Bill ETF), TBLL (Invesco Short Term Treasury ETF), OBIL (US Treasury 12 Month Bill ETF), XHLF (BondBloxx Bloomberg Six Month Target Duration US Treasury ETF)

**Checks:** relevance PASS · hard filters PASS · path full

## 8. Crypto oracles excluding Chainlink — PASS

**Prompt:** On-chain applications need independent real-time data feeds. Screen only crypto oracle networks listed on a centralized exchange, but exclude Chainlink.

**Expected niche:** PYTH, BAND, API3, or another non-LINK oracle network

**Returned:** BAND (Band), PYTH (Pyth Network), RED (RedStone), API3 (Api3), DIA (DIA), TRB (Tellor Tributes), WIN (WINkLink), SUPRA (Supra), AT (Apro), ZKP (zkPass)

**Checks:** relevance PASS · hard filters PASS · path full

## 9. Liquid-staking tokens excluding ETH — PASS

**Prompt:** Liquid-staking protocols turn staked assets into reusable collateral. Screen only crypto protocol tokens with centralized-exchange access, excluding ETH itself.

**Expected niche:** LDO, RPL, ETHFI, or another liquid-staking protocol token

**Returned:** LDO (Lido DAO), RPL (Rocket Pool), ANKR (Ankr Network), FIS (Stafi), SD (Stader), MNDE (Marinade), JTO (Jito), ETHFI (Ether.fi), OBOL (Obol), SSV (SSV Network)

**Checks:** relevance PASS · hard filters PASS · path full

## 10. Private defense-autonomy companies — PASS

**Prompt:** Autonomous systems and software-defined defense will take procurement share from legacy hardware. Screen only pre-IPO private companies directly focused on defense autonomy.

**Expected niche:** Anduril, Helsing, or another private defense-autonomy company

**Returned:** ANDURIL (Anduril), HELSING (Helsing)

**Checks:** relevance PASS · hard filters PASS · path full

Total runtime: 9.6 minutes.

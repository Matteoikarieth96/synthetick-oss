# Complex edge-case matching — validation summary

> AI-generated test output (LLM), not investment advice, no vendor data redistributed

Date: 2026-07-12

## Outcome

Twenty new full-pipeline cases were defined with their expected assets before execution. The cases cover Italian, European, US, and HKEX stocks; ETFs and bond ETFs; crypto; private/pre-IPO assets; exclusions; a mixed stock/crypto screen; a short thesis; and a two-sided long/short book.

- Initial complete run: **17/20 passed**.
- Failed cases: packaged-snack shorts (provider request terminated), HKEX online travel (false empty), and HKEX EV batteries (false empty).
- After the first fixes, those three cases passed **3/3** individually.
- A subsequent complete run again passed **17/20**. The three failures were transient infrastructure errors: one pgvector statement timeout and two low-level network `fetch failed` errors.
- After the final resilience fixes, those three cases passed **3/3** individually.
- A final complete 20-case rerun was requested, but the external execution quota blocked it before starting. There is therefore no claim of a single 20/20 run; every case has passed, but the final evidence is one 17/20 complete run plus a 3/3 targeted rerun.
- Across completed results, **zero hard asset-class, region, ticker-exclusion, CEX, or direction leaks** were detected.

## Problems found and fixes

### 1. Explicit-China screens incorrectly excluded all FMP HKEX rows

FMP stores Hong Kong listings with `exchange='HKSE'`. The strict China filter accepted only `HK` and `HKEX`, causing reproducible empty results for food delivery, online travel, and EV-battery niches.

Fix:

- accept `HKSE`, `HK`, and `HKEX` in SQL, runtime fallback, and deterministic audit;
- add a rolling-deploy fallback that retries a zero-row strict-China RPC without the stale server-side flag and enforces the corrected exchange rule locally;
- add an offline regression assertion for an `HKSE` row.

Validated results after the fix:

- HKEX online travel: `0780.HK` (Tongcheng Travel) returned;
- HKEX EV batteries: `3750.HK` (CATL) and `1211.HK` (BYD) returned;
- adjacent non-matches were removed by the compliance pass.

### 2. OpenRouter calls could hang or terminate without a bounded retry

One short-thesis run waited almost nine minutes before returning `terminated`; later runs exposed low-level `fetch failed` errors.

Fix:

- 90-second default per-call timeout, configurable with `SIGNAL_LLM_TIMEOUT_MS`;
- one retry by default, configurable with `SIGNAL_LLM_RETRIES` and capped at three;
- retry transient timeouts, terminations, rate limits, overloads, 5xx responses, socket/network failures, and `fetch failed` errors;
- permanent errors still surface normally.

Validated results after the fix:

- packaged-snack short case returned `MDLZ`, `HSY`, and `SJM` on the short side;
- mixed AI infrastructure returned both stocks and crypto, including `RENDER`, `TAO`, and `AKT`;
- streaming disruption returned expected long (`NFLX`, `ROKU`) and short (`CHTR`, `CMCSA`) exposures.

### 3. A single pgvector statement timeout failed the whole multi-query screen

The retrieval pipeline runs several thesis/theme queries. Previously, one statement timeout aborted the entire screen even when other retrieval facets could succeed.

Fix:

- retry a timed-out RPC once with a smaller candidate pool;
- if the retry still times out, keep other successful thesis/theme facets;
- if every facet times out, fail visibly rather than returning a false honest-empty state.

Validated result after the fix:

- the gene-sequencing case returned all three expected platforms: `PACB`, `ILMN`, and `TXG`.

## Coverage highlights

| Case | Expected | Observed expected matches |
|---|---|---|
| Italian merchant payments | NEXI.MI | NEXI.MI |
| European hearing aids | DEMANT.CO, GN.CO, SOON.SW | All three |
| European aircraft engines | SAF.PA, MTX.DE, RR.L | MTX.DE, RR.L |
| European exchanges | DB1.DE, LSEG.L, ENX.PA | DB1.DE, LSEG.L |
| US EDA software | CDNS, SNPS | Both |
| US gene sequencing | ILMN, PACB, TXG | All three |
| Packaged-snack shorts | MDLZ, HSY, KHC, SJM | MDLZ, HSY, SJM |
| HKEX online travel | 9961.HK, 0780.HK | 0780.HK |
| HKEX EV batteries | 1211.HK, 3750.HK | Both |
| Managed-futures ETFs | DBMF, KMLM, CTA, FMF | DBMF, KMLM, CTA |
| Short-duration TIPS ETFs | VTIP, STIP | STIP |
| Cybersecurity ETFs | CIBR, HACK, IHAK, BUG | All four |
| Storage crypto ex-FIL | AR, STORJ, SC | All three |
| Bitcoin scaling ex-BTC | STX, CORE, MERL | All three |
| Privacy coins | XMR, ZEC, DASH | XMR, ZEC |
| Solana liquid staking ex-SOL | JTO, MNDE, INF | JTO/MNDE across runs |
| Private AI inference | GROQ | GROQ only |
| Nvidia alternatives ex-NVDA | AMD, AVGO, MRVL, ARM | AMD, AVGO/MRVL across runs |
| Mixed AI stocks + crypto | VRT/MOD/AVGO + RENDER/TAO/AKT | Both asset classes; multiple expected hits |
| Streaming long + short | NFLX/ROKU/SPOT + CHTR/PARA/WBD/CMCSA | Expected assets on both sides |

Detailed machine-generated results are in `COMPLEX-EDGE-CASE-TEST-REPORT.md` and `COMPLEX-EDGE-CASE-RETRY.md`.

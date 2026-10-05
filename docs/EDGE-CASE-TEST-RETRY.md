# Signal Desk — Edge-case matching report

> AI-generated test output (LLM), not investment advice, no vendor data redistributed

Generated: 2026-07-11T14:37:26.031Z · Full-pipeline cases: 3 · Passed: 1 · Failed: 2

| # | Edge case | Status | Picks | Direction | Hard-filter leaks | Time |
|---|---|---|---:|---|---:|---:|
| 1 | European semiconductor equipment | FAIL | 0 | — | 0 | 17.6s |
| 2 | HKEX food-delivery platforms | FAIL | 0 | long | 0 | 17.3s |
| 3 | US uranium enrichment | PASS | 5 | long | 0 | 65.7s |

## 1. European semiconductor equipment — FAIL

**Prompt:** Advanced chip nodes require increasingly complex lithography, deposition and packaging equipment. Screen only European stocks that sell semiconductor manufacturing equipment.

**Expected niche:** ASML, ASM International, BESI, or a comparable European equipment supplier

**Returned:** No assets

**Checks:** relevance FAIL · hard filters PASS · path error

**Issue:** match_candidates RPC failed: canceling statement due to statement timeout

## 2. HKEX food-delivery platforms — FAIL

**Prompt:** Local-commerce platforms in China can improve margins as food-delivery competition rationalizes. Screen only HKEX-listed Chinese stocks directly exposed to food delivery.

**Expected niche:** Meituan or another HKEX-listed Chinese food-delivery platform

**Returned:** No assets

**Checks:** relevance FAIL · hard filters PASS · path empty

**Issue:** unexpected empty result; no result matched the expected niche: Meituan or another HKEX-listed Chinese food-delivery platform

## 3. US uranium enrichment — PASS

**Prompt:** Western nuclear expansion creates a bottleneck in domestic uranium enrichment and nuclear-fuel services. Screen only US stocks directly exposed to enrichment or the nuclear fuel cycle.

**Expected niche:** Centrus Energy or another direct US nuclear-fuel-cycle company

**Returned:** LEU (Centrus Energy Corp.), BWXT (BWX Technologies, Inc.), XE (X-Energy, Inc. Class A Common Stock), LTBR (Lightbridge Corporation), PESI (Perma-Fix Environmental Services, Inc.)

**Checks:** relevance PASS · hard filters PASS · path full

Total runtime: 1.7 minutes.

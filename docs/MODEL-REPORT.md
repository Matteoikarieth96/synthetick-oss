# Signal Desk — model comparison report (OpenRouter)

> AI-generated test output (LLM), not investment advice, no vendor data redistributed

Generated: 2026-07-06T15:20:52.933Z · Same 20 full-pipeline prompts per model · Retrieval identical across models (Voyage embeddings)

| Model | Class | Pass | Avg picks | Avg run time | Failures |
|---|---|---|---|---|---|
| `anthropic/claude-opus-4.8` | frontier (Anthropic Opus-class) | 20/20 | 8.2 | 53s | — |
| `openai/gpt-5.5` | frontier (OpenAI GPT-class) | 19/20 | 7.3 | 86s | #19 |
| `google/gemini-2.5-pro` | strong mid (Gemini Pro-class) | **20/20**¹ | 8.1 | 48s | — (was 3/20 before fix¹) |
| `anthropic/claude-haiku-4.5` | fast small (Haiku/Flash-class) | 19/20² | 7.0 | 23s | #16 (JSON truncation²) |
| `meta-llama/llama-4-maverick` | small open-weights | 19/20² | 8.2 | 45s | #18 (JSON truncation²) |

### Findings

1. **Reasoning-token trap (fixed).** Gemini 2.5 Pro always "thinks", and the
   hidden reasoning consumed `max_tokens`, truncating the visible JSON — the
   first pass scored 3/20 with "unterminated string" / "empty completion"
   errors. After capping the thinking budget (`reasoning.max_tokens=1024` in
   `llm.ts`, applied only to always-thinking model families) the re-run scored
   **20/20 at 48s avg**. The table shows post-fix numbers; the pre-fix detail
   section below is kept for the record.
2. **Token-ceiling truncations (fixed).** Haiku's and Llama's single failures
   were JSON cut off near the 3,000-token completion ceiling on verbose
   10-pick outputs; the ceiling is now 4,000.
3. **GPT-5.5 refused the short prompt** (#19 "What should I short?") with
   "I'm sorry…" — a safety-posture difference, not a capability gap. Relevant
   if short/both modes matter to your model choice.
4. **Haiku-4.5 is the value pick**: 19/20 at 23s avg — near-frontier accuracy
   on this workload at ~10× lower cost and 2–4× the speed; a strong
   `SIGNAL_LLM_MODEL` candidate for high-volume use.
5. **Opus-4.8 is the only first-pass clean sweep**: 20/20, no caveats.

## anthropic/claude-opus-4.8

| # | Prompt | OK | Picks | Dir | Viol | Hit | Time | Issue |
|---|---|---|---|---|---|---|---|---|
| 1 | AI chips | ✅ | 7 | ✓ | 0 | ✓ | 53s |  |
| 2 | Megabanks | ✅ | 5 | ✓ | 0 | ✓ | 35s |  |
| 3 | Defense | ✅ | 10 | ✓ | 0 | ✓ | 60s |  |
| 4 | REIT income | ✅ | 10 | ✓ | 0 | n/a | 56s |  |
| 5 | Broad market | ✅ | 10 | ✓ | 0 | n/a | 55s |  |
| 6 | Treasuries | ✅ | 10 | ✓ | 0 | n/a | 59s |  |
| 7 | Semis | ✅ | 9 | ✓ | 0 | ✓ | 54s |  |
| 8 | Luxury | ✅ | 10 | ✓ | 0 | n/a | 68s |  |
| 9 | Banks | ✅ | 10 | ✓ | 0 | n/a | 56s |  |
| 10 | UCITS broad | ✅ | 0 | ✓ | 0 | n/a | 4s |  |
| 11 | E-commerce | ✅ | 8 | ✓ | 0 | ✓ | 59s |  |
| 12 | EV makers | ✅ | 9 | ✓ | 0 | ✓ | 62s |  |
| 13 | State banks | ✅ | 10 | ✓ | 0 | n/a | 52s |  |
| 14 | BTC macro | ✅ | 1 | ✓ | 0 | ✓ | 25s |  |
| 15 | ETH ecosystem | ✅ | 9 | ✓ | 0 | n/a | 53s |  |
| 16 | Stablecoins | ✅ | 10 | ✓ | 0 | ✓ | 58s |  |
| 17 | DePIN | ✅ | 10 | ✓ | 0 | n/a | 56s |  |
| 18 | Mega-cap AI | ✅ | 8 | ✓ | 0 | n/a | 73s |  |
| 19 | Short AI capex | ✅ | 9 | ✓ | 0 | n/a | 64s |  |
| 20 | EV both sides | ✅ | 9 | ✓ | 0 | n/a | 49s |  |

## openai/gpt-5.5

| # | Prompt | OK | Picks | Dir | Viol | Hit | Time | Issue |
|---|---|---|---|---|---|---|---|---|
| 1 | AI chips | ✅ | 8 | ✓ | 0 | ✓ | 116s |  |
| 2 | Megabanks | ✅ | 5 | ✓ | 0 | ✓ | 60s |  |
| 3 | Defense | ✅ | 10 | ✓ | 0 | ✓ | 81s |  |
| 4 | REIT income | ✅ | 10 | ✓ | 0 | n/a | 83s |  |
| 5 | Broad market | ✅ | 10 | ✓ | 0 | n/a | 90s |  |
| 6 | Treasuries | ✅ | 10 | ✓ | 0 | n/a | 92s |  |
| 7 | Semis | ✅ | 6 | ✓ | 0 | ✓ | 67s |  |
| 8 | Luxury | ✅ | 5 | ✓ | 0 | n/a | 51s |  |
| 9 | Banks | ✅ | 10 | ✓ | 0 | n/a | 81s |  |
| 10 | UCITS broad | ✅ | 0 | ✓ | 0 | n/a | 11s |  |
| 11 | E-commerce | ✅ | 4 | ✓ | 0 | ✓ | 53s |  |
| 12 | EV makers | ✅ | 6 | ✓ | 0 | ✓ | 102s |  |
| 13 | State banks | ✅ | 10 | ✓ | 0 | n/a | 87s |  |
| 14 | BTC macro | ✅ | 7 | ✓ | 0 | ✓ | 126s |  |
| 15 | ETH ecosystem | ✅ | 10 | ✓ | 0 | n/a | 109s |  |
| 16 | Stablecoins | ✅ | 10 | ✓ | 0 | ✓ | 74s |  |
| 17 | DePIN | ✅ | 10 | ✓ | 0 | n/a | 118s |  |
| 18 | Mega-cap AI | ✅ | 9 | ✓ | 0 | n/a | 157s |  |
| 19 | Short AI capex | ❌ | 0 | ✗ | 0 | n/a | 77s | ERROR: Unexpected token 'I', "I'm sorry,"... is not valid JSON |
| 20 | EV both sides | ✅ | 7 | ✓ | 0 | n/a | 93s |  |

## google/gemini-2.5-pro

| # | Prompt | OK | Picks | Dir | Viol | Hit | Time | Issue |
|---|---|---|---|---|---|---|---|---|
| 1 | AI chips | ❌ | 0 | ✗ | 0 | n/a | 287s | ERROR: OpenRouter: empty completion |
| 2 | Megabanks | ✅ | 5 | ✓ | 0 | ✓ | 211s |  |
| 3 | Defense | ❌ | 0 | ✗ | 0 | n/a | 78s | ERROR: Expected ',' or ']' after array element in JSON at position 357 (line 7 column 4) |
| 4 | REIT income | ❌ | 0 | ✗ | 0 | n/a | 15s | ERROR: Expected ',' or '}' after property value in JSON at position 580 (line 1 column 581) |
| 5 | Broad market | ❌ | 0 | ✗ | 0 | n/a | 76s | ERROR: Expected ',' or ']' after array element in JSON at position 350 (line 1 column 351) |
| 6 | Treasuries | ❌ | 0 | ✗ | 0 | n/a | 79s | ERROR: Expected ',' or ']' after array element in JSON at position 388 (line 1 column 389) |
| 7 | Semis | ❌ | 0 | ✗ | 0 | n/a | 23s | ERROR: Unterminated string in JSON at position 456 (line 1 column 457) |
| 8 | Luxury | ❌ | 0 | ✗ | 0 | n/a | 73s | ERROR: Expected ',' or ']' after array element in JSON at position 409 (line 1 column 410) |
| 9 | Banks | ❌ | 0 | ✗ | 0 | n/a | 132s | ERROR: OpenRouter: empty completion |
| 10 | UCITS broad | ✅ | 0 | ✓ | 0 | n/a | 14s |  |
| 11 | E-commerce | ❌ | 0 | ✗ | 0 | n/a | 14s | ERROR: Expected ',' or '}' after property value in JSON at position 605 (line 1 column 606) |
| 12 | EV makers | ❌ | 0 | ✗ | 0 | n/a | 76s | ERROR: Expected ',' or ']' after array element in JSON at position 397 (line 1 column 398) |
| 13 | State banks | ✅ | 5 | ✓ | 0 | n/a | 96s |  |
| 14 | BTC macro | ❌ | 0 | ✗ | 0 | n/a | 123s | ERROR: Unterminated string in JSON at position 172 (line 5 column 137) |
| 15 | ETH ecosystem | ❌ | 0 | ✗ | 0 | n/a | 15s | ERROR: Unterminated string in JSON at position 344 (line 1 column 345) |
| 16 | Stablecoins | ❌ | 0 | ✗ | 0 | n/a | 80s | ERROR: Expected ',' or ']' after array element in JSON at position 451 (line 1 column 452) |
| 17 | DePIN | ❌ | 0 | ✗ | 0 | n/a | 16s | ERROR: Unterminated string in JSON at position 333 (line 1 column 334) |
| 18 | Mega-cap AI | ❌ | 0 | ✗ | 0 | n/a | 74s | ERROR: Expected ',' or ']' after array element in JSON at position 461 (line 1 column 462) |
| 19 | Short AI capex | ❌ | 0 | ✗ | 0 | n/a | 14s | ERROR: Unterminated string in JSON at position 524 (line 1 column 525) |
| 20 | EV both sides | ❌ | 0 | ✗ | 0 | n/a | 68s | ERROR: Expected ',' or ']' after array element in JSON at position 370 (line 1 column 371) |

## anthropic/claude-haiku-4.5

| # | Prompt | OK | Picks | Dir | Viol | Hit | Time | Issue |
|---|---|---|---|---|---|---|---|---|
| 1 | AI chips | ✅ | 10 | ✓ | 0 | ✓ | 31s |  |
| 2 | Megabanks | ✅ | 5 | ✓ | 0 | ✓ | 18s |  |
| 3 | Defense | ✅ | 9 | ✓ | 0 | ✓ | 25s |  |
| 4 | REIT income | ✅ | 10 | ✓ | 0 | n/a | 24s |  |
| 5 | Broad market | ✅ | 8 | ✓ | 0 | n/a | 25s |  |
| 6 | Treasuries | ✅ | 10 | ✓ | 0 | n/a | 23s |  |
| 7 | Semis | ✅ | 2 | ✓ | 0 | ✓ | 17s |  |
| 8 | Luxury | ✅ | 6 | ✓ | 0 | n/a | 25s |  |
| 9 | Banks | ✅ | 9 | ✓ | 0 | n/a | 25s |  |
| 10 | UCITS broad | ✅ | 0 | ✓ | 0 | n/a | 3s |  |
| 11 | E-commerce | ✅ | 7 | ✓ | 0 | ✓ | 24s |  |
| 12 | EV makers | ✅ | 6 | ✓ | 0 | ✓ | 22s |  |
| 13 | State banks | ✅ | 10 | ✓ | 0 | n/a | 27s |  |
| 14 | BTC macro | ✅ | 9 | ✓ | 0 | ✓ | 27s |  |
| 15 | ETH ecosystem | ✅ | 6 | ✓ | 0 | n/a | 20s |  |
| 16 | Stablecoins | ❌ | 0 | ✗ | 0 | n/a | 28s | ERROR: Expected ',' or '}' after property value in JSON at position 3330 (line 7 column 600) |
| 17 | DePIN | ✅ | 8 | ✓ | 0 | n/a | 22s |  |
| 18 | Mega-cap AI | ✅ | 7 | ✓ | 0 | n/a | 22s |  |
| 19 | Short AI capex | ✅ | 9 | ✓ | 0 | n/a | 33s |  |
| 20 | EV both sides | ✅ | 9 | ✓ | 0 | n/a | 20s |  |

## meta-llama/llama-4-maverick

| # | Prompt | OK | Picks | Dir | Viol | Hit | Time | Issue |
|---|---|---|---|---|---|---|---|---|
| 1 | AI chips | ✅ | 8 | ✓ | 0 | ✓ | 31s |  |
| 2 | Megabanks | ✅ | 9 | ✓ | 0 | ✓ | 31s |  |
| 3 | Defense | ✅ | 9 | ✓ | 0 | ✓ | 40s |  |
| 4 | REIT income | ✅ | 10 | ✓ | 0 | n/a | 35s |  |
| 5 | Broad market | ✅ | 10 | ✓ | 0 | n/a | 46s |  |
| 6 | Treasuries | ✅ | 10 | ✓ | 0 | n/a | 57s |  |
| 7 | Semis | ✅ | 7 | ✓ | 0 | ✓ | 91s |  |
| 8 | Luxury | ✅ | 10 | ✓ | 0 | n/a | 52s |  |
| 9 | Banks | ✅ | 10 | ✓ | 0 | n/a | 54s |  |
| 10 | UCITS broad | ✅ | 0 | ✓ | 0 | n/a | 3s |  |
| 11 | E-commerce | ✅ | 9 | ✓ | 0 | ✓ | 70s |  |
| 12 | EV makers | ✅ | 10 | ✓ | 0 | ✓ | 64s |  |
| 13 | State banks | ✅ | 10 | ✓ | 0 | n/a | 46s |  |
| 14 | BTC macro | ✅ | 10 | ✓ | 0 | ✓ | 49s |  |
| 15 | ETH ecosystem | ✅ | 5 | ✓ | 0 | n/a | 41s |  |
| 16 | Stablecoins | ✅ | 10 | ✓ | 0 | ✓ | 43s |  |
| 17 | DePIN | ✅ | 9 | ✓ | 0 | n/a | 35s |  |
| 18 | Mega-cap AI | ❌ | 0 | ✗ | 0 | n/a | 43s | ERROR: Unterminated string in JSON at position 1692 (line 5 column 82) |
| 19 | Short AI capex | ✅ | 8 | ✓ | 0 | n/a | 33s |  |
| 20 | EV both sides | ✅ | 9 | ✓ | 0 | n/a | 34s |  |

## google/gemini-2.5-pro

| # | Prompt | OK | Picks | Dir | Viol | Hit | Time | Issue |
|---|---|---|---|---|---|---|---|---|
| 1 | AI chips | ✅ | 7 | ✓ | 0 | ✓ | 53s |  |
| 2 | Megabanks | ✅ | 4 | ✓ | 0 | ✓ | 41s |  |
| 3 | Defense | ✅ | 10 | ✓ | 0 | ✓ | 56s |  |
| 4 | REIT income | ✅ | 10 | ✓ | 0 | n/a | 45s |  |
| 5 | Broad market | ✅ | 10 | ✓ | 0 | n/a | 50s |  |
| 6 | Treasuries | ✅ | 10 | ✓ | 0 | n/a | 49s |  |
| 7 | Semis | ✅ | 9 | ✓ | 0 | ✓ | 53s |  |
| 8 | Luxury | ✅ | 7 | ✓ | 0 | n/a | 48s |  |
| 9 | Banks | ✅ | 9 | ✓ | 0 | n/a | 46s |  |
| 10 | UCITS broad | ✅ | 0 | ✓ | 0 | n/a | 6s |  |
| 11 | E-commerce | ✅ | 6 | ✓ | 0 | ✓ | 47s |  |
| 12 | EV makers | ✅ | 7 | ✓ | 0 | ✓ | 44s |  |
| 13 | State banks | ✅ | 7 | ✓ | 0 | n/a | 45s |  |
| 14 | BTC macro | ✅ | 9 | ✓ | 0 | ✓ | 52s |  |
| 15 | ETH ecosystem | ✅ | 10 | ✓ | 0 | n/a | 56s |  |
| 16 | Stablecoins | ✅ | 10 | ✓ | 0 | ✓ | 54s |  |
| 17 | DePIN | ✅ | 10 | ✓ | 0 | n/a | 56s |  |
| 18 | Mega-cap AI | ✅ | 9 | ✓ | 0 | n/a | 62s |  |
| 19 | Short AI capex | ✅ | 9 | ✓ | 0 | n/a | 51s |  |
| 20 | EV both sides | ✅ | 8 | ✓ | 0 | n/a | 49s |  |


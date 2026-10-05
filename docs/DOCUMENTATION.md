# SyntheTick — Service Documentation

> Version: v4 (M1–M4 complete; M5 hardening shipped except cost telemetry and a stricter CSP, see §8) · Spec: [`signal-desk-v4-spec.md`](../signal-desk-v4-spec.md)

SyntheTick turns any investment thesis — pasted text, an article, notes, or a
PDF — into a researched, audited list of up to 10 real assets, matched against
a live universe of stocks, ETFs, bond ETFs and crypto, with real prices and
30-day charts. It is a **research starting point, not a recommendation**.

---

## 1. What the service does

Given a source document, SyntheTick:

1. **Extracts a structured thesis** — title, stance, summary, investable
   themes, anchors (assets you're already convinced by), and **binding
   requirements** taken from your own words ("only crypto", "European ETFs
   only", "exclude defense").
2. **Lets you review** the thesis before anything runs: edit the summary,
   flip the intent (conviction vs. thematic), add more requirements in plain
   language.
3. **Matches it against a real universe** — semantic search over embedded
   asset descriptions, hard-filtered in SQL so a requirement can never be
   violated at the retrieval stage.
4. **Reranks with an analyst model** — up to 10 picks, each with an absolute
   0–100 alignment score and a specific explanation. Fewer than 10 is a
   correct answer; zero is answered honestly, never padded.
5. **Audits twice** — a deterministic code audit re-checks every pick against
   the requirement object; a compliance audit checks picks against your
   literal instruction sentences. Violators are dropped and the drop is shown.
6. **Attaches real market data** — live/delayed price, 30-day change, market
   cap, a true 30-day sparkline, and where the asset trades. ETF and bond ETF
   cards also show FMP portfolio data when available: top holdings, holdings
   count, and sector/country breakdowns. Every figure carries an `as of`
   timestamp; nothing is ever simulated or fabricated. What is shown follows
   the data display policy (`.env.example`): FMP and Sacra data only with
   `DISPLAY_FMP_DATA=1` / `DISPLAY_SACRA_DATA=1`, otherwise the card shows its
   empty state and the results say why.

### The honesty contract

- A binding requirement is enforced in **three independent layers**: the SQL
  hard filter, the deterministic exit audit, and the LLM compliance audit.
- "Only crypto" can never show a stock. "Only European ETFs" can never show a
  US stock.
- If nothing qualifies, the app says **"Nothing matched your requirements"**
  and stops. Requirements are never silently relaxed.
- Market data comes from vendors (FMP, CoinGecko) or renders as "—
  data unavailable". There is no fallback to invented numbers.
- ETF portfolio sections come from FMP ETF endpoints and render only when the
  vendor supplies them; missing holdings never get inferred.

---

## 2. Using the app

Run it yourself with the [quickstart](QUICKSTART.md) and open **http://localhost:8787**, or use the live app at synthetick.org. Programmatic access: see [API.md](API.md).

### Composer
- **Paste text** — thesis, article, tweet, notes; any language (the structured
  summary is always produced in English so retrieval quality is uniform).
- **➕ Add file** — combineable sources, each shown as a removable chip:
  - **PDF** — text extracted in your browser (first 20 pages)
  - **Screenshot / image** (PNG, JPG, GIF, WebP ≤5MB) — read server-side with
    Claude vision: verbatim text plus a description of any charts
  - **Audio / video files** — decoded in the browser, normalized to 16 kHz mono
    WAV, then transcribed by the configured audio-capable OpenRouter model
- **🔗 Add link**:
  - **X/Twitter post** — fetched via the public oEmbed endpoint (public posts)
  - **YouTube video** — the real transcript via ytscribe.ai when
    `YTSCRIBE_API_KEY` is set; otherwise content reconstructed via web search
    (marked *approximate* — review the thesis card before continuing)
  - **Any article URL** — fetched and stripped to readable text
- **Example chips** — one-click sample theses.
- **Mode picker**:
  - **⚡ One-shot** — straight from thesis review to results.
  - **🎯 Expert mode** — a short interview (max 9 questions) tailors the list.
- **Start research** enables as soon as any prompt or extracted source text is present.

### Thesis review card
Appears after extraction, before any matching:
- **① The document's thesis** — the English summary. **Edit** lets you rewrite
  it (Save & continue / Cancel); the edited text drives retrieval and analysis.
- **Direction toggle — 📈 Long / 📉 Short / ⚖ Both.** Auto-detected from your
  words ("what should I short?", "give me longs and shorts") and overridable
  here. **Long** ranks the assets that best *express* your thesis. **Short**
  flips the ranking's meaning: candidates are still found in the thesis's
  semantic neighborhood, but the score becomes *negative exposure* — 100 means
  the thesis directly implies that asset's decline, so the best shorts rank
  first (disrupted incumbents, losing competitors, obsolete business models —
  never the thesis's beneficiaries). **Both** returns the two sides of the
  trade — up to 5 longs and 5 shorts, each judged through its own lens, with
  no asset allowed on both sides. Analyses reframe on the short side to
  evidence → damage mechanism → shorting caveat (hedges, borrow/squeeze risk),
  and your named holdings are never auto-promoted onto a short list. Binding
  requirements and both audits apply identically in every direction.
- Note: there is no intent toggle — the tool always behaves as "conviction in
  specific assets": any asset you name is resolved, force-considered, and
  scored; theses without named assets degrade naturally to thematic matching.
- **Anchors & themes** — what was detected, shown as tags.
- **② Binding requirements** — chips for everything detected in your document,
  plus a free-text box to add more ("only European ETFs · exclude defense").
  Box contents merge with the document's requirements using v3 semantics
  (see §4).

### Expert interview
Nine questions, fewer in practice — questions auto-skip when irrelevant
(answer "Crypto only" and the stock-markets question disappears). Multi-select
where it makes sense, **Skip** and **← Back** always available.

Answers split into:
- **Hard filters** (asset class, markets, size, exclusions, CEX-only) —
  enforced like any other binding requirement.
- **Soft preferences** (risk, horizon, familiarity, concentration) — bias the
  reranker but never exclude an asset.

If an interview answer contradicts the document ("document says only crypto,
you answered stocks"), the app **asks which to follow** — it never silently
overrides either.

### Results
- Status line narrates each stage, including exactly which picks the audits
  dropped and why.
- Each card: kind badge (stock/etf/bond/crypto), relationship badge
  (anchor/complement/competitor/adjacent), the alignment gauge (High ≥70 /
  Medium 40–69 / Low <40), a 3-sentence analysis (evidence → mechanism →
  fit-or-caveat), price + 30-day change with `as of` stamp, market cap, a real
  30-day sparkline, and trading venues (exchange for equities; CEX/DEX list
  for crypto).
- The footer disclaimer is always present.

---

## 3. The asset universe

| Segment | Source | Scope | Refresh |
|---|---|---|---|
| Stocks & ETFs | FMP | US (NYSE/NASDAQ/AMEX), major EU exchanges including Borsa Italiana, China (HKEX + US-listed ADRs) | daily job; rows refresh when older than six days |
| Bond ETFs | FMP | bond/treasury/fixed-income ETFs (no individual bonds in v1) | with equities |
| Crypto | CoinGecko + GeckoTerminal | top ~3,000 by market cap, CEX + DEX venues | nightly (markets daily; detail on a rolling ~2-week cycle) |

Universe rules worth knowing:

- **One row per company.** Cross-listings dedup by ISIN, with an ADR
  name-merge (ADRs carry different ISINs). The canonical row is the home
  exchange; other listings render as "also trades on".
- **Region = domicile, not listing venue.** ASML is `eu` despite its NASDAQ
  ADR; Alibaba is `cn` despite listing on NYSE (domicile comes from the
  company's HQ country). "Only European stocks" therefore behaves correctly.
- **Market caps are USD-normalized** at ingestion (GBX pence handled); prices
  display in the native currency ("€612.40", "HK$342.20").
- **A-shares excluded** (not investable for most users); noise floor drops
  sub-$50M caps; delisted assets are deactivated, never deleted.
- Borsa Italiana is included through FMP. The daily ingest is resumable and
  skips fresh rows, so interrupted runs retain progress without rewriting the
  whole universe.

---

## 4. Requirements semantics (the part worth reading twice)

Requirements come from three places — the **document**, the **plain-language
box**, and the **interview** — and merge with fixed rules:

- **Restrictive fields replace** (asset classes, markets, sizes): "only X"
  means X. A document saying "stocks" plus a box saying "only crypto" yields
  *crypto*, never both — unioning restrictions would loosen them.
- **Exclusions add** across sources (defense + micro-caps stay excluded).
- **Exclusive beats non-exclusive** from the same text ("only crypto" in a
  document that also mentions stocks wins).
- **Semantic scope** ("related to the Ethereum ecosystem") boosts matching
  categories at retrieval (+0.15 before the top-100 cut) and is enforced
  *verbatim* by the compliance audit.
- Extraction is **dual**: an LLM extractor and a deterministic regex over
  instruction sentences run independently and merge — so a plainly stated
  "only European ETFs" is caught even if the model misses it. Instruction
  cues include English and Italian ("solo", "soltanto", "solamente").

---

## 5. Architecture

```
INGESTION (GitHub Actions, scheduled)
  FMP (equities/ETFs)   ─┐
  CoinGecko (crypto)     ├─► normalize ─► embed (Voyage voyage-3-lite, 512-d) ─► Supabase Postgres + pgvector
  GeckoTerminal (DEX)   ─┘

RUNTIME
  app/ + public/signal-desk.js  (Next.js browser UI — no secrets, ever)
    └─► custom Node server  (local :8787 · deployed on Railway)
          ├─ POST /api/thesis     Claude: structured thesis + requirements
          └─ POST /api/complete   SSE stream:
               candidates  SQL hard filter + pgvector top-100 (+ semantic boost)
               select      Claude rerank → ≤10 picks, s≥35, tickers validated
               audit       deterministic re-check + Claude compliance audit
               analysis    3-sentence per-pick analysis
               market      FMP / CoinGecko quotes + 30d series (60s cache)
```

- **LLM**: via **OpenRouter** (default `anthropic/claude-sonnet-4.6`, any OpenRouter model via `SIGNAL_LLM_MODEL`), JSON-only prompts with a repair-and-retry
  guard (~5–7 calls per research run).
- **Embeddings**: computed once per asset at ingestion; thesis embeddings use
  the English structured summary (never raw document text) so non-English
  input retrieves as well as English.
- **Repo layout**: see [README](../README.md).

### API (dev server)

| Endpoint | Body | Returns |
|---|---|---|
| `POST /api/thesis` | `{ text }` | `{ thesis, finReq }` — title, stance, summary, intent, anchors, avoid, themes, docCrit, plus the requirement set shown on the review card |
| `POST /api/complete` | `{ text, thesis, extraReq?, answers?, finReq? }` | SSE: `status` events (progress lines), then one `result` event — thesis, final crit, picks (score, rel, why, analysis, market), path `full｜empty` |

`/api/*` bodies must be sent with `Content-Type: application/json` (anything else gets 415) and, when sign-in is on, with the signed-in session. The public API is documented in [API.md](API.md).

---

## 6. Operations

### Schedules (GitHub Actions)
- **Equities**: daily 01:00 UTC. The FMP job is resumable and skips rows
  fresher than six days, so it converges to a weekly per-asset refresh. Stale
  symbols are deactivated only on full-universe runs.
- **Crypto**: nightly 03:00 UTC. Markets refresh is cheap; per-coin detail
  spends a bounded budget (new coins first, then stalest), staying inside the
  CoinGecko demo quota (30 req/min, 10k/month).
- The scheduled jobs run only in the upstream repository (a
  `github.repository` guard in each workflow), so a fork never runs them or
  spends secrets by accident. In a fork, run the ingest scripts yourself or
  change the guard.

### Quality gates (a failed gate aborts the run, DB untouched)
- symbol count dropping >20% vs the previous run
- >5% of rows missing kind/region
- embedding coverage <98% of active rows

### Environment / secrets

| Variable | Used by | Notes |
|---|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | everything | service key is server-side only |
| `SUPABASE_ANON_KEY` | optional beta auth | publishable key; setting it enables sign-in and daily credits |
| `FMP_KEY` | equities, /market | optional; Financial Modeling Prep key. Its data is shown only with `DISPLAY_FMP_DATA=1`, which needs FMP's display licence |
| `DISPLAY_FMP_DATA`, `DISPLAY_SACRA_DATA`, `API_RELAY_MARKET_DATA` | display policy (`runtime/display-policy.ts`) | all off by default: stock/ETF (FMP) data, pre-IPO (Sacra) data, and third-party market data in API, MCP and X bot answers stay hidden until you set the flag to `1`. Turn one on only if your vendor licence allows it |
| `VOYAGE_KEY` | embeddings, retrieval | base tier = 3 req/min, 10k tokens/min |
| `COINGECKO_KEY` | crypto, /market | optional demo key (crypto also works on the keyless public tier). If you show CoinGecko data publicly, its terms require the attribution "Data provided by CoinGecko" linked to https://www.coingecko.com/en/api next to the data; GeckoTerminal data needs "On-chain data provided by GeckoTerminal" linked to https://www.geckoterminal.com |
| `OPENROUTER_API_KEY` | thesis/select/audit/analysis/vision | web search via `:online` suffix |

Local: `.env` (gitignored). CI: GitHub Actions secrets. Never in the browser.

### Tests
```bash
npm run test:candidates   # retrieval + hard-filter gate (§10.2)
npm run test:regression   # extractor/merge semantics + full pipeline (§10.3)
npm run test:market       # vendor accuracy, honest failure states (§10.4)
```
Gates adapt to what you have loaded: checks that need assets you have not
ingested SKIP rather than fail, and activate automatically as the universe grows.
For checks that need no keys at all, run `npm run test:offline`.

---

## 7. What works today — tested example prompts

This section reflects **behavior verified in July 2026** against a fully
loaded universe (equities and ETFs from a market-data vendor, about 3,000
crypto assets). What you get depends on what you have ingested: a crypto-only
install answers the crypto prompts and honestly returns nothing for the rest.
Every prompt below is exercised by `npm run test:prompts` (needs live keys),
which checks that it returns results, that no hard filter is violated, and
that the expected names reach the candidate set the reranker judges.
**Last verified: 25/25 passing.**

Two retrieval behaviors worth knowing (both discovered by testing these
prompts, both now handled):
- **Mega-caps vs pure-plays** — giants with many business lines embed
  diffusely, so a slice of candidate slots is reserved for the largest caps
  and the reranker decides ("majors rescue").
- **Named assets are always considered** — if your thesis names an asset
  (e.g. "like Aave"), it is force-included into the candidates unless it
  violates a binding requirement, which always wins.

> Tip: these all work in **One-shot** mode as-is. In **Expert mode** the same
> prompts work with the interview refining them further.

### US stocks (10)

| # | Prompt | Names it should surface |
|---|---|---|
| 1 | *AI compute demand keeps exploding; chip designers and hyperscale cloud platforms capture the spend. Only US stocks.* | NVDA, AMD, MSFT, GOOGL |
| 2 | *Semiconductor equipment makers are the picks and shovels of the AI buildout: deposition, etch, metrology. Only US stocks.* | AMAT, KLAC, LRCX |
| 3 | *Digital advertising rebounds as AI improves targeting and creative automation. Only US stocks.* | META, GOOGL |
| 4 | *Premium hardware ecosystems like Apple's — devices with attached subscription services are sticky cash machines. Only US stocks.* | AAPL |
| 5 | *Large US banks earn more in a higher-for-longer rate environment through net interest margins. Only US stocks.* | JPM, BAC, GS |
| 6 | *GLP-1 obesity and diabetes drugs are reshaping healthcare economics. Only US stocks.* | LLY |
| 7 | *Electric vehicles and charging infrastructure keep scaling in the US market. Only US stocks.* | GM, F |
| 8 | *Rising geopolitical tension drives sustained growth in defense procurement and munitions. Only US stocks.* | GD, LMT, NOC |
| 9 | *Streaming platforms with pricing power and ad tiers win the living room. Only US stocks.* | NFLX |
| 10 | *Ransomware and AI-powered attacks make cybersecurity spend non-discretionary. Only US stocks.* | CRWD, FTNT, NET |

### Chinese stocks (5)

"Only Chinese stocks" correctly returns companies **domiciled** in China
regardless of where they list (region = domicile, §3). That includes
US-listed ADRs and OTC lines (BABA, LI, NIO, ICBC…) and, if your vendor covers
it, Hong Kong (HKEX) local listings.

| # | Prompt | Names it should surface |
|---|---|---|
| 11 | *Chinese e-commerce giants trade at depressed multiples despite dominant market share. Only Chinese stocks.* | BABA, JD |
| 12 | *Chinese EV makers are winning on cost and technology at home and abroad. Only Chinese companies.* | LI, NIO |
| 13 | *Chinese state banks offer high dividend yields backed by deposits. Only Chinese stocks.* | ICBC/ABC ADRs |
| 14 | *Chinese internet platforms monetize search, gaming and social traffic. Only Chinese stocks.* | Tencent, Baidu (needs HKEX coverage) |
| 15 | *The Chinese consumer recovery lifts retail, travel and food delivery. Only Chinese stocks.* | Meituan (needs HKEX coverage) |

### Crypto (10)

| # | Prompt | Names it should surface |
|---|---|---|
| 16 | *Rollups and staking make ETH productive capital. Only crypto related to the Ethereum ecosystem.* | ETH, ARB, OP |
| 17 | *On-chain lending and decentralized exchanges eat traditional finance fees. Only crypto.* | DeFi protocols (name Aave/Uniswap in the thesis to pin them — named assets are always considered) |
| 18 | *Layer 2 rollups scale Ethereum and capture sequencer revenue. Only crypto.* | ARB, OP, POL |
| 19 | *Bitcoin is digital gold: a scarce, neutral reserve asset for a fragmenting world. Only crypto.* | BTC |
| 20 | *Dollar stablecoins are the killer app of crypto payments and settlement. Only crypto.* | USDT, USDC |
| 21 | *Decentralized GPU networks and AI-model markets monetize idle compute. Only crypto.* | RENDER, TAO |
| 22 | *High-throughput consumer apps live on Solana. Only crypto in the Solana ecosystem.* | SOL + ecosystem |
| 23 | *Liquid staking and restaking protocols turn locked stake into productive collateral. Only crypto.* | LDO, ETHFI |
| 24 | *On-chain gaming economies and metaverse land monetize player ownership. Only crypto.* | gaming tokens |
| 25 | *Decentralized physical infrastructure — storage, wireless, sensors — bootstraps real networks with tokens. Only crypto.* | FIL, HNT, AR |

### Known gaps
- Coverage is whatever your data vendor supplies. With a limited plan, late-alphabet
  tickers and **EU ETFs** may be missing, and "only European ETFs" then returns
  an honest empty state.
- Some Chinese companies appear twice via Y/F OTC ADR pairs (e.g. IDCBY/IDCBF);
  a dedup refinement is open.
- HKEX local listings (Tencent, Meituan, BYD…) need a vendor that carries them.

---

## 8. Current limitations & roadmap

- **Equities data source** — the equities pipeline is written against one
  vendor. A vendor-neutral adapter interface and free keyless sources are open
  contribution areas, see the issue tracker.
- **Audio/video file transcription** — runs through the audio-capable
  OpenRouter model in `SIGNAL_AUDIO_MODEL`; a dedicated speech-to-text
  provider (e.g. a Whisper-compatible API) is still an open option. YouTube
  links use ytscribe.ai when `YTSCRIBE_API_KEY` is set, else web-search
  reconstruction.
- **Deployment** — the runtime is a single Node server (`npm start`), deployed
  on a container host. Hardening shipped: per-user and per-IP rate limits,
  security headers, RLS on every table, stable error codes. Still open: a
  stricter CSP (no inline scripts) and cost telemetry.
- **Secondary listings** are display-only; `/market` quotes the primary.
- **No portfolio tracking, execution, or personalized advice** — explicitly
  out of scope (v1 non-goals).

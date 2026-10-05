# Public API and MCP

Both are thin layers over the same pipeline the web app uses. A run costs **1 credit** from the key owner's daily budget.
Keys are created in the app (sign in, then the API view). You run your own deployment? Then you create keys there.

Market data in responses comes from your data vendors; their terms decide whether you may pass it to API users.
The data display policy (`runtime/display-policy.ts`) applies three flags from `.env.example`, all off by default:

- `API_RELAY_MARKET_DATA`: off, key-authenticated `/v1/screen`, `/v1/assets` and `/v1/universe/:name/assets` callers and MCP `run_screen` get no third-party market data (CoinGecko, GeckoTerminal, FMP, Sacra) and no vendor-hosted logos; each response carries a `market_note` saying so. Set to `1`, market objects are included and each carries an `attribution` string (for example `Data provided by CoinGecko (https://www.coingecko.com/en/api)`).
- `DISPLAY_FMP_DATA`: off, stock, ETF and bond ETF market data, ETF holdings, the vendor description and FMP-hosted logos are left out everywhere, API included, even with relay on. The `about` field then holds the asset's own AI-written enrichment text, or `null`.
- `DISPLAY_SACRA_DATA`: off, the same for pre-IPO companies (valuation history, valuation-based market cap, price per share, Sacra description).

Ticker, name, kind, region, exchange, sector and categories are always included. A signed-in browser session calling `/v1/screen` or `/v1/assets` counts as the website, not the API.

## Authentication

Send `Authorization: Bearer stk_...` (or `x-api-key: stk_...`). Keys are shown once at creation and stored only as a SHA-256 hash.
A server started without `SUPABASE_ANON_KEY` (local development) runs open on loopback only.

## Errors and limits

Every error is JSON: `{"error": "human readable", "code": "stable_machine_code"}`.

| Status | `code` | When |
|---|---|---|
| 400 | `bad_request` | invalid JSON or input (wrong type, unknown enum value, thesis too short), checked before any credit is charged |
| 401 | `unauthorized` | missing, unknown or revoked API key |
| 402 | `payment_required` | no credits left today; the body also carries `credits` and `cap` |
| 404 | `not_found` | unknown path, universe or symbol |
| 405 | `method_not_allowed` | wrong method; the `Allow` header lists the accepted ones |
| 413 | `payload_too_large` | a body larger than 1 MiB |
| 415 | `unsupported_media` | a form or multipart body |
| 422 | `unsafe_url`, `source_unreadable` | `/v1/assets` only: the link is refused (private address, credentials in the URL, a scheme other than http or https) or could not be read |
| 429 | `rate_limited`, `too_many_runs` | too many requests, or too many runs in flight; wait the seconds in `Retry-After` |

Bodies are JSON. The `/v1` endpoints and `/mcp` read the body as JSON whatever its `Content-Type` (only form and multipart bodies are refused); the web app's own `/api` routes require `Content-Type: application/json`.
A failing data or AI provider answers 502 (`upstream_unavailable`), anything unexpected 500 (`internal_error`); the details stay in the server log.
Browsers need `CORS_ORIGINS` set to call the API from another origin; there is no wildcard.

## Endpoints

### `GET /v1/me`
Your email, credits left today and the daily cap.

### `POST /v1/screen`
Body:

```json
{
  "thesis": "Grid operators and nuclear utilities will win from AI data center demand.",
  "constraints": {
    "assets": ["stock", "etf"],
    "regions": ["us", "eu"],
    "caps": ["large", "mid"],
    "cn_hkex_only": false,
    "universe": "robinhood"
  },
  "breadth": "focused"
}
```

`thesis` is required (8 to 30,000 characters); everything else is optional.
Allowed values: `assets` = `stock, etf, bond, crypto, private, polymarket`; `regions` = `us, eu, cn, it, other`;
`caps` = `mega, large, mid, small, micro`; `breadth` = `focused, diversified`; `universe` = `robinhood` (also accepted at the top level of the body).
Constraints written inside the thesis text are honored too. The source of truth for the enums is `server/validate.ts`.

The response is a Server-Sent Events stream: `credits` (your balance after the charge), `status` lines (what the pipeline is doing, including what the audits dropped and why),
then `result` or `error`. `result` holds up to 10 `picks` with score, rationale and analysis, each with a `market` object (`null` when withheld, with `attribution` when included), `market_withheld` (true when the display policy held that pick's market data back), and a top-level `market_note` (why market data is missing, or `null`).
A failed run refunds the credit (at most three automatic refunds per user per day, `REFUNDS_PER_USER_DAY`; the error says when no refund was made) and sends an updated `credits` event.
Closing the connection stops the run at its next step; an abandoned run keeps its credit. An empty `picks` list is a valid answer: nothing met your requirements.

```bash
curl -N https://synthetick.org/v1/screen \
  -H "Authorization: Bearer $SYNTHETICK_API_KEY" -H "Content-Type: application/json" \
  -d '{"thesis":"Grid operators and nuclear utilities will win from AI data center demand."}'
```

### `POST /v1/assets`
Which assets is this content about? Body: `{"text": "...", "url": "https://...", "request": "optional focus"}` with `text`, `url` or both.
Returns `assets`, `unmatched` names, the `thesis` it read, `implied` (true when the content named no asset and the list holds the closest thesis plays instead), `market_note`, plus `credits` and `cap`.
Each asset has `id`, `name`, `ticker`, `kind`, `currency`, `market_withheld`, and `price`, `change1dPct` and `marketCapUsd`, which are `null` when withheld; with relay on, an asset carrying market data also has `attribution`.
1 credit, charged before fetching the link and refunded on failure.

### `GET /v1/universe/:name`
The tradable-universe registry (for example `robinhood`): public.

### `GET /v1/universe/:name/assets[/:symbol[/chart]]`
The registry joined with ingested data. Needs a key; the web explorer reads it from the same origin under a stricter per-IP limit. No credit.
Always included: identity, `website`, the token `contract`, `holders`, the venue `quote` (its `multiplier` is `null` when the venue reports none, never a default of 1), `onchain` state with the Chainlink oracle, and corporate action `events`.
With relay off, `dex`, `marketCapUsd`, `metrics`, `asOf`, `spark30d` and vendor-hosted logos are `null` and the response has `market_note`; `/chart` answers `{"symbol", "chart": null, "market_note"}`.
With relay on, `dex` objects and `/chart` carry `attribution`, and the response lists its vendors in `attribution`.
`marketCapUsd`, `metrics`, `asOf`, `spark30d` and `portfolio` also need `DISPLAY_FMP_DATA=1`. Responses vary by caller, so they are sent with `Cache-Control: private`.

## MCP

A stateless Streamable-HTTP MCP server at `POST /mcp`, same API keys.

| Tool | What it does |
|---|---|
| `run_screen` | Arguments: `thesis`, and optionally `assets`, `regions`, `caps`, `cn_hkex_only`, `breadth`, `universe` (flat, not nested). Returns the same payload as the `/v1/screen` `result` event (picks, `market_note`) plus the `status` lines; MCP is always the API channel. 1 credit, 1 to 3 minutes. |
| `get_credits` | Today's balance. |

Claude Code:

```bash
claude mcp add --transport http synthetick https://synthetick.org/mcp --header "Authorization: Bearer $SYNTHETICK_API_KEY"
```

Invalid arguments are rejected without spending a credit.

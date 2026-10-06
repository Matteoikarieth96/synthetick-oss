# Privacy notes for operators

If you run SyntheTick for other people, you are the data controller. This page lists what the code stores and where it sends data, so you can write an honest privacy notice and set up the right processor agreements. It is not legal advice.

## What is stored

| Data | Where | Why | Who can read it |
|---|---|---|---|
| Google sign-in identity: email, Google user id, and the profile Google returns (name, avatar URL) | Supabase Auth `auth.users`; email also in `profiles` | sign-in, daily credits | the user (own `profiles` row), service role |
| Every research prompt, including text extracted from the sources a user adds (never the files themselves), plus the user's email | `prompt_log` | debugging, abuse handling | service role and admin pages |
| Credit usage | `credit_ledger` | enforce the daily budget | the user (own rows), service role |
| API key hashes and 12-character prefixes (never the key) | `api_keys` | API access | service role |
| Linked X account id and handle | `x_accounts` | the X bot | service role |
| Post id and X user id of everyone who mentions the bot, including people without an account | `bot_replies` | idempotency, one pointer reply per day | service role |
| Bot polling cursor | `bot_state` | resume polling | service role |

Row level security is on for every table. The only client policies let a signed-in user read their own `profiles` row and their own `credit_ledger` rows; everything else needs the service key. Server logs record user ids, X ids, request paths, the host names of links users add, pipeline status lines (requirements and tickers derived from a thesis) and lengths, not the prompt text.
The browser keeps the sign-in session and recent research (thesis, source excerpts, results) in `localStorage`. Recent research is stored under a key that contains the user's email and stays until the user clears it.

## Where data is sent

| Recipient | What | When |
|---|---|---|
| OpenRouter and the model provider it routes to | prompt text, text extracted from sources, screenshots, voice notes and X video audio for transcription | every run, `/v1/assets`, the X bot |
| OpenRouter web search (`:online`) | the thesis, or a link that could not be read directly | news lookups when enabled, link and YouTube fallbacks |
| Voyage AI | the thesis text, to embed the search query | every run |
| ytscribe.ai (optional) | YouTube links | when `YTSCRIBE_API_KEY` is set |
| X | post links (oEmbed), mentions and replies (API); bot replies are public posts | link extraction, X bot, account linking |
| Any website a user links | one request from your server's IP address | link extraction |
| Polymarket | search terms derived from the thesis | runs that include prediction markets |
| CoinGecko, GeckoTerminal, FMP, Robinhood, Blockscout, Chainlink directory | tickers, ids and token addresses only; FMP is called at run time only when `DISPLAY_FMP_DATA=1`, and no vendor market lookup runs for an API answer without `API_RELAY_MARKET_DATA=1` | market data |
| Google, Supabase | account data | sign-in and hosting |
| From the visitor's browser: Google Fonts, Google and DuckDuckGo icon services | the visitor's IP address; for icons, the domains of the assets shown | page load, result cards |
| Your visitors, API users and X | vendor market data, under the display policy in `.env.example` (all flags off by default): stock, ETF and bond ETF data from FMP only with `DISPLAY_FMP_DATA=1`, pre-IPO data from Sacra only with `DISPLAY_SACRA_DATA=1`, and third-party market data in API, MCP and X bot answers only with `API_RELAY_MARKET_DATA=1`. The website shows CoinGecko and GeckoTerminal data with their attribution. Turn a flag on only if your vendor licence allows it | result cards, the universe explorer, API and MCP responses, bot replies |

pdf.js is served by your own server (from the `pdfjs-dist` package), so PDF reading contacts no third party. If you serve EU visitors, self-host the fonts and replace the icon services, or ask for consent first. If you run the X bot, set the "Automated" label on its X account.

## Retention and deletion

Accounts the API never accepts (anything that is not a Google sign-in, for example an email sign-up left enabled in the Supabase dashboard) are removed automatically, hourly, once they are an hour old. Admins are never removed. See `server/auth-hygiene.ts`.


Nothing is deleted automatically. Pick a retention period and run it on a schedule, for example 90 days for prompts:

```sql
delete from prompt_log where created_at < now() - interval '90 days';
```

Deleting a user (Supabase dashboard, Authentication, Users, or `auth.admin.deleteUser`) cascades to their profile, ledger, prompts, API keys and X link.
`bot_replies` rows are keyed by X user id, not by account: delete them by `author_x_id` when you handle a request. To answer a data request, export that user's rows from the tables above by `user_id` (and `author_x_id` for the bot).

## Admin accounts

New sign-ups are never admin. Use Google as the only sign-in provider and keep "Confirm email" on if you ever enable email and password, because the optional `app_settings.admin_email` bootstrap promotes whoever signs up with that address.

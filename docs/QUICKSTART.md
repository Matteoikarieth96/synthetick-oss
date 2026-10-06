# Quickstart: run SyntheTick on your laptop

The cheapest honest setup is **crypto only**: crypto data needs no paid vendor, so you only pay for LLM calls (a few cents per research run).
Free still has a condition: if you show CoinGecko or GeckoTerminal data publicly, their terms require an attribution next to it (see Common problems).
Equities and ETFs need a market-data vendor you bring yourself (see [DOCUMENTATION.md](DOCUMENTATION.md), section 3).

## You need

- Node 22 or newer
- A free [Supabase](https://supabase.com) project
- A [Voyage AI](https://www.voyageai.com) key (embeddings; the free tier is 3 requests per minute, so the first ingest is slow)
- An [OpenRouter](https://openrouter.ai) key with a few dollars of credit. Set a spending limit on the key.
- Optional: `psql` (the PostgreSQL client), to apply the database files in one command

## Steps

```bash
git clone https://github.com/Matteoikarieth96/synthetick-oss.git
cd synthetick-oss
npm install
cp .env.example .env        # fill in the REQUIRED values (three to boot, the LLM key on the first run)
```

1. **Database.** In your Supabase project: Project Settings, Database, copy the connection string. Then:

   ```bash
   DATABASE_URL="postgresql://postgres:<password>@db.<project>.supabase.co:5432/postgres" npm run db:setup
   ```

   No `psql`? Paste the files from `db/` into the Supabase SQL editor in the order listed in [db/README.md](../db/README.md).
2. **Data.** Load the top 200 coins and embed them:

   ```bash
   CRYPTO_TOP_N=200 npm run ingest:crypto
   ```

3. **Run.**

   ```bash
   npm run dev
   ```

   Open http://localhost:8787, pick an example chip, and set Assets to Crypto in the requirements panel (or write "only crypto" in your thesis).
   Local development runs open on loopback: no sign-in, no credits.
   Anything you expose through a reverse proxy or tunnel must run `npm run build && npm start`, never the dev server: the dev server treats every request from the same machine as local, and a proxy on that machine is one.

## Check your setup without any keys

```bash
npm run typecheck
npm run test:offline
```

These need no keys, no database and no `.env`: the runner supplies throwaway placeholders and never contacts a real service. They are what CI runs on every pull request, together with `npm run build`.

## Common problems

| Symptom | Cause |
|---|---|
| `SyntheTick cannot start: missing required environment variables` | `.env` is missing `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` or `VOYAGE_KEY` |
| "A data or AI provider is temporarily unavailable" on every run | A key is wrong or missing (usually `OPENROUTER_API_KEY`, or a wrong Supabase URL). Clients only see the generic message on purpose; the real cause is in the server log |
| Ingest crawls | Voyage free tier is 3 requests per minute; add a payment method to lift it |
| "Nothing matched your requirements" | Working as designed: your constraints exclude everything loaded so far |
| Warning "TRUST_PROXY is not set" at startup, or per-IP limits never trigger | Behind a proxy every request arrives from the proxy's private address, so the per-IP limit stays off unless the app knows the proxy (otherwise it would throttle the whole site as one user). On Railway this is automatic, with or without Cloudflare in front. Elsewhere, set `TRUST_PROXY` to the number of proxies in front of the app. Per-user limits and credits apply either way. Loopback development needs nothing |
| Server exits at startup in production | `SUPABASE_ANON_KEY` is unset; set it, or `ALLOW_OPEN_ACCESS=1` if you really want an open server |
| Crypto prices on a public deployment carry no data credit | CoinGecko's API terms require attribution: show "Data provided by CoinGecko" linked to https://www.coingecko.com/en/api next to the data, and "On-chain data provided by GeckoTerminal" linked to https://www.geckoterminal.com for pool data. The bundled UI shows both next to the data; keep them if you change the cards. The public API and MCP relay no third-party market data unless you set `API_RELAY_MARKET_DATA=1` (see `.env.example`) |

## Safe habits

- Never commit `.env`. The repository ignores it and a secret scan runs on every push.
- The Supabase **service key** bypasses row level security. Keep it on the server only.
- Run `db/verify-rls.sql` after any schema change.

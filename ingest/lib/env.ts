import 'dotenv/config';

const missing: string[] = [];

/** Read a required env var. Missing ones are collected and reported together (see below). */
function required(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    missing.push(name);
    return '';
  }
  return v.trim();
}

/** Optional env var with a default. */
function optional(name: string, fallback = ''): string {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : fallback;
}

export const env = {
  SUPABASE_URL: required('SUPABASE_URL'),
  SUPABASE_SERVICE_KEY: required('SUPABASE_SERVICE_KEY'),
  // Beta auth switch (spec §12): when the publishable/anon key is set, the API
  // requires a signed-in user and enforces daily credits; when absent the app
  // runs open, exactly as before (local dev, offline tests).
  SUPABASE_ANON_KEY: optional('SUPABASE_ANON_KEY'),
  VOYAGE_KEY: required('VOYAGE_KEY'),
  // FMP is only required by the equities pipeline; read lazily there.
  FMP_KEY: optional('FMP_KEY'),
  // CoinGecko / GeckoTerminal work without a key on the free tier; a key
  // (if present) raises rate limits.
  COINGECKO_KEY: optional('COINGECKO_KEY'),
  // Sacra: pre-IPO watchlist sync only (§4.2b); metered per company touched.
  SACRA_API_KEY: optional('SACRA_API_KEY'),
  // X account linking (spec §14): /api/x/* answers 503 until X_CLIENT_ID and
  // X_REDIRECT_URL are both set. X_CLIENT_SECRET marks a confidential client
  // (token exchange adds HTTP Basic); public clients leave it empty.
  X_CLIENT_ID: optional('X_CLIENT_ID'),
  X_CLIENT_SECRET: optional('X_CLIENT_SECRET'),
  X_REDIRECT_URL: optional('X_REDIRECT_URL'),
  // X bot worker (spec §14 PR 3, bot/ only): app-only bearer for mention
  // reads; OAuth 1.0a consumer + bot-account token for posting replies.
  // X_BOT_USER_ID optionally skips the boot-time users/me lookup.
  X_BOT_BEARER: optional('X_BOT_BEARER'),
  X_BOT_CONSUMER_KEY: optional('X_BOT_CONSUMER_KEY'),
  X_BOT_CONSUMER_SECRET: optional('X_BOT_CONSUMER_SECRET'),
  X_BOT_ACCESS_TOKEN: optional('X_BOT_ACCESS_TOKEN'),
  X_BOT_ACCESS_SECRET: optional('X_BOT_ACCESS_SECRET'),
  X_BOT_USER_ID: optional('X_BOT_USER_ID'),
};

// One readable message instead of a stack trace naming only the first variable.
if (missing.length) {
  console.error(
    '\nSyntheTick cannot start: missing required environment variable' + (missing.length > 1 ? 's' : '') + ':\n' +
      missing.map((m) => '  - ' + m).join('\n') +
      '\n\nCopy .env.example to .env and fill them in (see docs/QUICKSTART.md).\n' +
      'To only run the key-free checks, use: npm run test:offline\n',
  );
  process.exit(1);
}

export function requireFmp(): string {
  if (!env.FMP_KEY) {
    throw new Error('FMP_KEY is required for the equities pipeline.');
  }
  return env.FMP_KEY;
}

export function requireSacra(): string {
  if (!env.SACRA_API_KEY) {
    throw new Error('SACRA_API_KEY is required for the pre-IPO pipeline.');
  }
  return env.SACRA_API_KEY;
}

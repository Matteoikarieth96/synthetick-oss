#!/usr/bin/env bash
# Apply every db/*.sql file in dependency order, then verify RLS.
# Usage: DATABASE_URL=postgresql://... ./db/setup.sh   (or: npm run db:setup)
set -euo pipefail
: "${DATABASE_URL:?Set DATABASE_URL to your Postgres connection string}"
command -v psql >/dev/null || { echo "psql not found. Install the PostgreSQL client or paste the files into the Supabase SQL editor."; exit 1; }
cd "$(dirname "$0")"
for f in schema rpc_match_candidates asset_metrics private_data market_snapshot universe_cache \
         auth_credits api_keys prompt_log x_accounts bot_state verify-rls; do
  echo "==> $f.sql"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$f.sql"
done
echo "Done. Next: promote your admin account (see db/README.md)."

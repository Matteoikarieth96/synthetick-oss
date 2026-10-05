# Database

PostgreSQL with the `pgvector` extension. Supabase's free tier works.

## Apply order

Run the files in this order (each one is idempotent, so re-running is safe):

1. `schema.sql` (assets, embeddings, pgvector)
2. `rpc_match_candidates.sql` (hard filter plus vector search)
3. `asset_metrics.sql` (metrics and price history, returns function)
4. `private_data.sql`, `market_snapshot.sql`, `universe_cache.sql`
5. `auth_credits.sql` (profiles, daily credits, admin setting)
6. `api_keys.sql`, `prompt_log.sql`, `x_accounts.sql`, `bot_state.sql`
7. `verify-rls.sql` (read-only check, fails loudly if a table is unprotected)

Either paste each file into the Supabase SQL editor, or run them all:

```bash
DATABASE_URL="postgresql://postgres:<password>@db.<project>.supabase.co:5432/postgres" npm run db:setup
```

`db:setup` needs the `psql` client on your PATH.

## Make yourself admin

New sign-ups are never admin by default. After you sign in once, promote your account:

```sql
update profiles set is_admin = true where email = 'you@example.com';
```

(or set `app_settings.admin_email` before the first sign-in; see the header of `auth_credits.sql`).
If you set `admin_email`, keep Google as the only sign-in provider (or keep email confirmation on): whoever signs up with that address becomes admin. See [docs/PRIVACY.md](../docs/PRIVACY.md) for what else is stored.

## Row level security

Every table has RLS on and no client policies. Only the server, using the service key, reads and writes.
Never put the service key in a browser or in a public repository. `verify-rls.sql` checks this.

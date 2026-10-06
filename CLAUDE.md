# CLAUDE.md

This repo implements SPEC.md — that file is the single source of truth; when code and spec conflict, the spec wins; when we change a decision, update the spec first. Never commit secrets; all keys live in .env (gitignored) locally and in GitHub/Supabase secrets in deployment. Work milestone by milestone (spec §10); each milestone must pass its test gate before moving on.
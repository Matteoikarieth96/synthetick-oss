#!/bin/sh
# Materialise wallet files from runtime secrets (if given), then run the agent loop.
# Files mounted at /app/.sail/... are used as-is; env values only fill gaps.
set -eu
umask 077

mkdir -p .sail/keys

write_b64() { # <env value> <target path>
  if [ -n "${1:-}" ] && [ ! -s "$2" ]; then
    printf '%s' "$1" | base64 -d > "$2"
    chmod 600 "$2"
  fi
}

write_b64 "${KEYSTORE_B64:-}" .sail/keys/manager.json
write_b64 "${SAIL_ACCOUNT_B64:-}" .sail/account.json
write_b64 "${SAIL_MANDATE_B64:-}" .sail/mandate.json
# The files now hold these values: do not pass them on to the agent or its children.
unset KEYSTORE_B64 SAIL_ACCOUNT_B64 SAIL_MANDATE_B64

for f in .sail/keys/manager.json .sail/account.json .sail/mandate.json; do
  if [ ! -s "$f" ]; then
    echo "missing $f: mount it, or set KEYSTORE_B64 / SAIL_ACCOUNT_B64 / SAIL_MANDATE_B64 (see Dockerfile)." >&2
    exit 1
  fi
done

while true; do
  npx sailor run --once
  sleep "${AGENT_INTERVAL:-300}"
done

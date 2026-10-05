FROM node:22-slim
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
# Run as the unprivileged "node" user. The state directories exist up front so a
# named volume mounted at .sail/memory inherits this ownership on first use. If
# your platform mounts volumes as root, give the volume to uid 1000 instead of
# dropping this line.
RUN chmod +x docker-entrypoint.sh \
 && mkdir -p .sail/keys .sail/memory \
 && chown -R node:node /app
USER node

# Seconds between ticks. Ticks are cheap (plan draining + guards); the paid
# pipeline (news/thesis/Drip/screen) runs once per UTC day, max 3 attempts.
ENV AGENT_INTERVAL=300

# NOTHING SECRET OR WALLET-SPECIFIC IS BAKED INTO THIS IMAGE. The build context
# excludes (see .dockerignore) any keystore, .sail/account.json and
# .sail/mandate.json. Provide them at RUNTIME, either as read-only file mounts:
#
#   docker run -v $PWD/manager.json:/app/.sail/keys/manager.json:ro \
#              -v $PWD/.sail/account.json:/app/.sail/account.json:ro \
#              -v $PWD/.sail/mandate.json:/app/.sail/mandate.json:ro \
#              -v sail-memory:/app/.sail/memory \
#              --env-file .env ...
#
# or as base64 environment secrets (no file mounts):
#   KEYSTORE_B64, SAIL_ACCOUNT_B64, SAIL_MANDATE_B64   (base64 of each file)
# The entrypoint writes them to files with mode 600 and removes them from the
# environment before the agent starts. Export your own keystore with
# `sailor keys export-ci` and unlock it with the SAIL_PASSPHRASE secret.
# Never commit a keystore to a public repository.
#
# .sail/memory holds the daily guards: mount a persistent volume there, or every
# restart re-runs the pipeline once.
CMD ["./docker-entrypoint.sh"]

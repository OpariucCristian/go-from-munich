# One image for api + worker (linux/amd64 and linux/arm64, e.g. Oracle Ampere).
FROM node:22-bookworm-slim

# Python venv for the nightly LightGBM trainer.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv libgomp1 ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY ml/requirements.txt /tmp/requirements.txt
RUN python3 -m venv /opt/venv && /opt/venv/bin/pip install --no-cache-dir -r /tmp/requirements.txt
ENV PYTHON=/opt/venv/bin/python TRAINER=python NODE_ENV=production

WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/iris/package.json packages/iris/
COPY packages/model/package.json packages/model/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
RUN npm ci --omit=dev --include-workspace-root
COPY tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
COPY ml ./ml

# Default: API. The worker service overrides the command.
CMD ["npx", "tsx", "apps/api/src/server.ts"]

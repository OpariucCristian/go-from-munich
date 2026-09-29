#!/usr/bin/env bash
# Deploys the working tree to the VM: package (no secrets, no node_modules), upload, rebuild, restart.
# The server keeps its own .env and database; neither is touched.
#
#   DEPLOY_KEY="C:/Users/me/key for vm.key" DEPLOY_HOST=ubuntu@92.5.50.6 scripts/deploy.sh
set -euo pipefail

: "${DEPLOY_HOST:?set DEPLOY_HOST, e.g. ubuntu@92.5.50.6}"
: "${DEPLOY_KEY:?set DEPLOY_KEY to the SSH private key path}"
cd "$(dirname "$0")/.."

archive="$(mktemp -d)/gfm.tgz"
tar --force-local \
  --exclude=node_modules --exclude=./data --exclude=./models --exclude=./spikes \
  --exclude=.env --exclude=.git --exclude=apps/web/dist \
  --exclude='*.key' --exclude='*.pem' --exclude=.ssh --exclude=.claude \
  -czf "$archive" .
if tar --force-local -tzf "$archive" | grep -qiE '\.key$|\.pem$|(^|/)\.env$'; then
  echo "refusing to deploy: archive contains a key or .env file" >&2
  exit 1
fi

scp -i "$DEPLOY_KEY" -q "$archive" "$DEPLOY_HOST:/tmp/gfm.tgz"
ssh -i "$DEPLOY_KEY" "$DEPLOY_HOST" 'set -e
  mkdir -p ~/gofrommunich && tar -xzf /tmp/gfm.tgz -C ~/gofrommunich && rm /tmp/gfm.tgz
  cd ~/gofrommunich
  sg docker -c "docker compose --profile app up -d --build"
  sg docker -c "docker image prune -f" >/dev/null
  sg docker -c "docker compose ps --format \"table {{.Service}}\t{{.Status}}\""'
rm -f "$archive"

#!/usr/bin/env bash
# Ships a model trained on this machine to the VM and registers it there. It is promoted only if
# its recorded validation score beats what the VM serves (see registerAndMaybePromote); the api
# picks up a promoted model within 5 minutes. The VM never trains (DISABLE_TRAINING=1).
#
#   DEPLOY_KEY="C:/Users/me/key for vm.key" DEPLOY_HOST=ubuntu@92.5.50.6 scripts/model-deploy.sh lgbm-muc-202609291600
set -euo pipefail

: "${DEPLOY_HOST:?set DEPLOY_HOST, e.g. ubuntu@92.5.50.6}"
: "${DEPLOY_KEY:?set DEPLOY_KEY to the SSH private key path}"
version="${1:?usage: model-deploy.sh <version> (a directory under models/)}"
cd "$(dirname "$0")/.."

dir="models/$version"
for f in model.onnx metrics.json; do
  [[ -f "$dir/$f" ]] || { echo "missing $dir/$f" >&2; exit 1; }
done

ssh -i "$DEPLOY_KEY" "$DEPLOY_HOST" "mkdir -p /tmp/gfm-model/$version"
scp -i "$DEPLOY_KEY" -q "$dir/model.onnx" "$dir/metrics.json" "$DEPLOY_HOST:/tmp/gfm-model/$version/"
# The models volume is shared by worker and api; registering stores the in-container path.
ssh -i "$DEPLOY_KEY" "$DEPLOY_HOST" "set -e
  cd ~/gofrommunich
  sg docker -c 'docker compose exec -T worker mkdir -p /app/models/$version'
  sg docker -c 'docker compose cp /tmp/gfm-model/$version/model.onnx worker:/app/models/$version/model.onnx'
  sg docker -c 'docker compose cp /tmp/gfm-model/$version/metrics.json worker:/app/models/$version/metrics.json'
  rm -rf /tmp/gfm-model/$version
  sg docker -c 'docker compose exec -T worker npx tsx apps/worker/src/cli.ts register-model --dir models/$version'"

#!/usr/bin/env bash
# Deploys the gateway and dashboard to the CreateOS project provisioned by Stripe Projects.
# Builds from a clean copy so .env, git history and the test-foil labels never leave this machine.
set -euo pipefail
cd "$(dirname "$0")/.."
PROJECT_ID="${CREATEOS_PROJECT_ID:-2c6933e7-ae1f-4e21-b179-43a645c02da4}"
KEY="$(grep '^CREATEOS_PROJECT_API_KEY=' .env | cut -d= -f2- | tr -d "'\"")"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

cp -R package.json package-lock.json tsconfig.json Dockerfile .dockerignore packages apps "$STAGE"/
rm -rf "$STAGE/apps/gateway/.runtime"
mkdir -p "$STAGE/data/offers"
for f in data/offers/*.json; do
  case "$f" in *.foil.json) ;; *) cp "$f" "$STAGE/data/offers/" ;; esac
done

ENV_ID="${CREATEOS_ENVIRONMENT_ID:-9354fe38-3fa1-466f-b6b8-f1866862e622}"
(cd "$STAGE" && createos --api-key "$KEY" deploy --project "$PROJECT_ID" --dir .)

# Promote the newest deployment, then put every older one to sleep. Two running gateways
# would each keep a warm pool and drain the sandbox quota.
list() { createos --api-key "$KEY" -o json deployments list --project "$PROJECT_ID"; }
NEW_ID="$(list | python3 -c 'import sys,json; d=json.load(sys.stdin); d=d if isinstance(d,list) else d.get("data",[]); print(d[0]["id"])')"
createos --api-key "$KEY" deployments promote --project "$PROJECT_ID" --environment "$ENV_ID" --deployment "$NEW_ID"
for old in $(list | python3 -c 'import sys,json; d=json.load(sys.stdin); d=d if isinstance(d,list) else d.get("data",[]); print(" ".join(x["id"] for x in d[1:] if x.get("status")=="deployed"))'); do
  createos --api-key "$KEY" deployments sleep --force --project "$PROJECT_ID" --deployment "$old"
done
echo "Live deployment: $NEW_ID"

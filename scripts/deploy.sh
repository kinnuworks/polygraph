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

(cd "$STAGE" && createos --api-key "$KEY" deploy --project "$PROJECT_ID" --dir .)
echo "Promote the new deployment with: createos deployments promote --project $PROJECT_ID --environment <id> --deployment <id>"

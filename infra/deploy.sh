#!/usr/bin/env bash
# One-shot deploy to Azure Container Apps. Reads values interactively; nothing is written to disk.
set -euo pipefail

RG="${RG:-rg-dashflow}"
LOCATION="${LOCATION:-eastus}"
NAME="${NAME:-avddash}"
IMAGE="${IMAGE:-ghcr.io/bg-red/dashflow:latest}"

command -v az >/dev/null || { echo "Azure CLI is required: https://aka.ms/azure-cli"; exit 1; }

ME=$(az ad signed-in-user show --query '{id:id,upn:userPrincipalName}' -o json)
ADMIN_ID=$(echo "$ME" | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')
ADMIN_UPN=$(echo "$ME" | python3 -c 'import json,sys;print(json.load(sys.stdin)["upn"])')

read -rp "Entra app (client) ID for sign-in: " AUTH_CLIENT_ID
read -rsp "Client secret for that app: " AUTH_CLIENT_SECRET
echo

az group create -n "$RG" -l "$LOCATION" -o none

az deployment group create \
  -g "$RG" \
  -f infra/main.bicep \
  -p name="$NAME" image="$IMAGE" authClientId="$AUTH_CLIENT_ID" authClientSecret="$AUTH_CLIENT_SECRET" \
     postgresAdminObjectId="$ADMIN_ID" postgresAdminName="$ADMIN_UPN" \
     bootstrapOwnerObjectIds="[\"$ADMIN_ID\"]" \
  -o json --query properties.outputs > /tmp/dashflow-outputs.json

IDENTITY_PRINCIPAL=$(python3 -c 'import json;print(json.load(open("/tmp/dashflow-outputs.json"))["identityPrincipalId"]["value"])')
IDENTITY_NAME="$(python3 -c 'import json;print(json.load(open("/tmp/dashflow-outputs.json"))["postgresHost"]["value"].split(".")[0])')"
PG_SERVER=$(python3 -c 'import json;print(json.load(open("/tmp/dashflow-outputs.json"))["postgresHost"]["value"].split(".")[0])')
WEB_URL=$(python3 -c 'import json;print(json.load(open("/tmp/dashflow-outputs.json"))["webUrl"]["value"])')
REDIRECT=$(python3 -c 'import json;print(json.load(open("/tmp/dashflow-outputs.json"))["consentRedirectUri"]["value"])')

# Administrator resources need a name known before deployment, so the app identity is added here.
echo "Making the app identity a Postgres administrator…"
az postgres flexible-server ad-admin create \
  -g "$RG" -s "$PG_SERVER" \
  -u "$(az identity list -g "$RG" --query "[0].name" -o tsv)" \
  -i "$IDENTITY_PRINCIPAL" \
  -t ServicePrincipal -o none

rm -f /tmp/dashflow-outputs.json

cat <<SUMMARY

Deployed.

  App:                 $WEB_URL
  Sign-in redirect:    $WEB_URL/.auth/login/aad/callback
  Consent redirect:    $REDIRECT   (only needed for Partner Center connections)

Next:
  1. Add both redirect URIs to the app registration ($AUTH_CLIENT_ID).
  2. Open the app — you are pre-authorized as owner, so no setup code is needed.
  3. Add a connection.
SUMMARY

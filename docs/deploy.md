# Deploying

## 1. Create the sign-in app registration

Container Apps authentication needs an Entra app registration:

```bash
az ad app create --display-name "DashFlow" --sign-in-audience AzureADMyOrg
APP_ID=$(az ad app list --display-name "DashFlow" --query "[0].appId" -o tsv)
az ad app credential reset --id "$APP_ID" --years 1 --query password -o tsv   # keep this
```

Leave the redirect URIs for now — the app's URL does not exist yet.

## 2. Deploy

```bash
RG=rg-dashflow LOCATION=eastus IMAGE=ghcr.io/bg-red/dashflow:latest ./infra/deploy.sh
```

The script asks for the client ID and secret, deploys `infra/main.bicep`, makes the app's
managed identity a Postgres administrator, and prints the URLs you need.

What it creates:

| Resource | Why |
|---|---|
| Container Apps environment + Log Analytics | Runtime and the app's own logs |
| Container app `-web` with `authConfigs` | The UI and API, behind EasyAuth |
| Container app `-worker` (`APP_ROLE=worker`) | Syncs, scaled separately |
| User-assigned managed identity | Key Vault, Postgres, and optionally Azure data access |
| Key Vault (RBAC) | The EasyAuth secret, the encryption key, connection secrets |
| Postgres Flexible Server, Entra-only auth | Storage, with no password anywhere |

## 3. Finish the app registration

Add these redirect URIs to the app registration (both printed by the script):

- `https://<app-url>/.auth/login/aad/callback` — sign-in
- `https://<app-url>/api/connections/consent/callback` — only for Partner Center connections

## 4. Claim and connect

Open the app. If you passed `bootstrapOwnerObjectIds` (the script passes your own object ID),
you are already the owner; otherwise read the one-time code from the logs:

```bash
az containerapp logs show -n <prefix>-web -g <rg> --tail 200 | grep -A3 "first-run setup"
```

Then add a connection and follow the wizard.

## Updating

```bash
az containerapp update -n <prefix>-web -g <rg> --image ghcr.io/bg-red/dashflow:v0.2.0
az containerapp update -n <prefix>-worker -g <rg> --image ghcr.io/bg-red/dashflow:v0.2.0
```

Migrations run at startup under a Postgres advisory lock, so replicas starting at once are safe.

## Running it somewhere else

Any container host works. The requirements are:

- Postgres 14+ (`DATABASE_URL`)
- Something in front that authenticates users and sets `X-MS-CLIENT-PRINCIPAL` the way EasyAuth
  does — **or** accept that whoever reaches the port is whoever they claim to be. Read
  [security.md](security.md) before exposing it.
- `APP_ENCRYPTION_KEY` (32 bytes, base64) if you want to store connection secrets without Key
  Vault: `openssl rand -base64 32`

Split web and worker by running the same image twice with `APP_ROLE=web` and `APP_ROLE=worker`.
`APP_ROLE=all` (the default) runs both in one process, which is fine for a single-instance
deployment.

## Sizing

The defaults handle a few thousand session hosts. What grows is `connection_facts` — roughly
one row per connection. At 50,000 connections a day and 180 days of retention that is about 9M
rows, comfortable on the Burstable tier. Turn down `retentionDays` per connection, or raise the
Postgres SKU, if you go much beyond that.

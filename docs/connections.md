# Connections

A connection is one way of reaching AVD data. You can have several at once, and they can
overlap — Azure and Nerdio data about the same host pool merge on the ARM resource ID.

The wizard (Connections → Add connection) walks through: type → prerequisites with generated
commands → credentials → **permission test** → discovery → first sync. Nothing is collected
until the test passes.

## Azure (direct)

One Entra tenant. Authenticate with a service principal (client secret or certificate) or with
the container's own managed identity — the managed identity is the better option on Azure
because there is no secret to store or rotate.

Choose specific subscriptions, or leave the list empty to use every subscription the identity
can see.

## Azure Lighthouse

One identity in your managing tenant. Delegated subscriptions report your tenant in
`managedByTenants`, which is how customers are discovered — there is no per-customer
credential. Include the managing tenant's own subscriptions with the "include home tenant"
toggle.

## Partner Center (GDAP)

For CSP partners. A partner admin consents once; the resulting refresh token is exchanged for a
token in each customer tenant on demand (the Secure Application Model). Customers come from the
Partner Center API, and Microsoft Graph tells the app which GDAP relationships are active.

Remember that GDAP grants Entra roles — Azure RBAC in each customer subscription is a separate
step. See [permissions.md](permissions.md).

## Nerdio Manager

Works with Nerdio Manager for MSP (accounts become customers) and for Enterprise (one
environment). Client credentials against the instance's REST API.

Because REST paths differ between editions and versions, the connection test reads your
instance's own API definition, compares it against the defaults, and lists the paths it does
expose if something does not line up. Override any of them per connection:

```json
{
  "endpoints": {
    "accounts": "/rest-api/v1/accounts",
    "hostPools": "/rest-api/v1/host-pool",
    "sessionHosts": "/rest-api/v1/host-pool/{subscriptionId}/{resourceGroup}/{hostPoolName}/host"
  }
}
```

Nerdio does not expose connection-level telemetry, so latency, errors and connection history
still come from Azure. Pair a Nerdio connection with an Azure or Lighthouse one for the full
picture.

## What each connection syncs

| Stream | What | Interval (default) |
|---|---|---|
| `inventory` | Host pools, session hosts, app groups, scaling plans | 60 min |
| `sessions` | Active/disconnected sessions, capacity, host health | 5 min |
| `logs` | Connections, errors, latency, CPU/memory | 15 min, incremental with a 2 h overlap |
| `cost` | Daily cost per resource group and meter | 24 h |

The first run backfills `backfillDays` (30 by default). Watch it on the Sync health page.

## Troubleshooting

**"No subscriptions are visible"** — the identity has no Reader anywhere, or, under GDAP, has
Entra roles but no Azure RBAC.

**Inventory works, but experience and reliability widgets are empty** — host pool diagnostic
settings are missing. That is where `WVDConnections` and friends come from.

**Cost widgets are empty** — Cost Management Reader is not assigned, or the subscription is too
new to have data.

**Nerdio calls 404** — your instance's API paths differ; the connection test lists the real
ones, and you can override them.

**A customer disappeared** — check Customers: something disabled is hidden from dashboards but
keeps its history.

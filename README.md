# DashFlow

Self-hosted dashboards for Azure Virtual Desktop. One container, one Postgres database, and
your own Entra sign-in — no SaaS, no data leaving your tenant.

It reads AVD data **directly from Azure** or **through Nerdio Manager**, and it is built for
multi-tenant work from the start: a single service principal, an **Azure Lighthouse** managing
tenant, **Partner Center (GDAP)** customers, and **Nerdio Manager for MSP** accounts can all feed
the same dashboards.

- **Guided setup.** The connection wizard generates the exact `az` commands for the roles it
  needs, then proves the access with a permission checklist before anything syncs.
- **Guided dashboards.** Pick a question — usage, experience, reliability, capacity, cost —
  see the dashboard filled with *your* data, adjust, save.
- **Runs behind EasyAuth.** Azure Container Apps handles sign-in; the app adds its own roles on
  top, including viewers scoped to a single customer so you can share a dashboard with them.
- **MIT licensed**, no telemetry, and a secret-scanning pre-commit hook so contributors cannot
  leak a tenant ID by accident.

> Not affiliated with Microsoft or Nerdio. "Azure Virtual Desktop" and "Nerdio" are their
> owners' trademarks.

---

## Try it in two minutes

```bash
git clone https://github.com/BG-Red/dashflow.git
cd dashflow
docker compose up --build
```

Open <http://127.0.0.1:3000>. Demo mode generates four synthetic customers with 30 days of
history, so every dashboard has something in it. The compose file uses `AUTH_MODE=dev`, which
trusts every request — it binds to localhost only and refuses to start with
`NODE_ENV=production`.

Prefer Bun directly?

```bash
bun install
cp .env.example .env            # then set DATABASE_URL and APP_ENCRYPTION_KEY
bun run db:migrate
bun run build                   # build the web app once
bun run start
```

## Deploy to Azure

```bash
IMAGE=ghcr.io/bg-red/dashflow:latest ./infra/deploy.sh
```

That creates a Container Apps environment with **Container Apps authentication (EasyAuth)** in
front of the app, a user-assigned managed identity, Key Vault, and a Postgres Flexible Server
with **Entra-only auth** — so no database password exists anywhere. See
[docs/deploy.md](docs/deploy.md) for the app registration, and
[docs/security.md](docs/security.md) for what the app trusts and why.

## How it fits together

```
                  ┌──────────────── Azure Container Apps ────────────────┐
  browser ──TLS──▶│ EasyAuth sidecar ──▶ web (Bun + Hono + React SPA)    │
                  │                            │                        │
                  │                      Postgres (Entra auth)          │
                  │                            ▲                        │
                  │ worker (same image, APP_ROLE=worker) ──▶ connectors ─┼──▶ ARM / Log Analytics
                  └──────────────────────────────────────────────────────┘      Cost Management
                                                                                Partner Center
                                                                                Nerdio REST API
```

- **`apps/server`** — Hono API, EasyAuth middleware, app RBAC, the query engine, the job queue.
- **`apps/web`** — React + Vite + Tailwind SPA; ECharts for charts.
- **`packages/connectors`** — one interface (`test` / `discover` / `sync`), four implementations.
- **`packages/core`** — the metric catalog and dashboard templates: the only things that become SQL.
- **`packages/db`** — Drizzle schema and migrations.
- **`packages/demo`** — the synthetic data generator.

## Connection types

| | How it reaches your data | Use it when |
|---|---|---|
| **Azure (direct)** | Service principal, or this container's managed identity | One tenant — internal IT, or a single customer |
| **Azure Lighthouse** | One identity in your managing tenant, projected into delegated subscriptions | You already onboard customers with Lighthouse |
| **Partner Center (GDAP)** | Partner admin consent once (Secure Application Model), then per-customer tokens | CSP partners with GDAP relationships |
| **Nerdio Manager** | Nerdio's REST API with client credentials | Environments managed by Nerdio Manager (MSP or Enterprise) |

Azure and Nerdio data about the same host pool merge on the ARM resource ID, so running both
gives you Nerdio's autoscale view next to Azure's connection telemetry.

[docs/connections.md](docs/connections.md) has the per-type setup, and
[docs/permissions.md](docs/permissions.md) the exact roles.

## What you get out of the box

| Dashboard | Answers |
|---|---|
| Executive overview | Who is using AVD, is it succeeding, what does it cost |
| User experience | Time to connect, round-trip latency, by pool / client / gateway region |
| Reliability | Failed connections, error codes, unhealthy and drained hosts |
| Capacity and scaling | Utilization against capacity, sessions per host, CPU and memory |
| Cost and savings | Spend by customer, pool and meter; cost per user; autoscale savings |
| Customer report | A single-customer page you can hand over |

Every widget comes from a metric catalog (`packages/core/src/metrics.ts`) with typed
dimensions. Widgets reference metric IDs, so a dashboard author never writes SQL and cannot
reach a customer they are not scoped to.

## Data it collects

| Stream | Source | Default interval |
|---|---|---|
| Inventory — pools, hosts, app groups, scaling plans | ARM `Microsoft.DesktopVirtualization` | hourly |
| Sessions — concurrency, capacity, host health | ARM session/user sessions | 5 minutes |
| Connections, errors, latency, CPU | Log Analytics (`WVDConnections`, `WVDErrors`, `WVDConnectionNetworkData`, `Perf`) | 15 minutes, incremental |
| Cost | Cost Management query API | daily |

User names are hashed with a per-instance salt by default (`PSEUDONYMIZE_USERS=true`), so
per-user counts still work without storing UPNs.

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Install
[gitleaks](https://github.com/gitleaks/gitleaks) before your first commit; the pre-commit hook
uses it to keep tenant IDs, domains and secrets out of the repository.

```bash
bun test          # unit tests; set TEST_DATABASE_URL to include the SQL ones
bun run lint
bun run typecheck
bun run secrets:scan
```

MIT licensed. See [LICENSE](LICENSE).

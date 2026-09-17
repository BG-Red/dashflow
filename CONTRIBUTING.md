# Contributing

Thanks for helping. Issues, bug reports and pull requests are all welcome.

## Before your first commit

Install [gitleaks](https://github.com/gitleaks/gitleaks) — the pre-commit hook uses it, and CI
will fail without it passing:

```bash
brew install gitleaks     # or see the gitleaks README
bun install               # installs the hooks via lefthook
```

**Never commit real tenant identifiers.** That includes tenant, subscription, client and object
GUIDs, `*.onmicrosoft.com` domains, Nerdio instance URLs, user names, and anything from a real
environment — including screenshots. Use the placeholders the repo already uses: zero GUIDs,
`contoso.onmicrosoft.com`, and the sample companies in `packages/demo`. For screenshots, run
with `DEMO_MODE=true`.

## Getting set up

```bash
bun install
docker compose up postgres -d
cp .env.example .env    # set DATABASE_URL and APP_ENCRYPTION_KEY
bun run db:migrate
bun run --filter '@avd/server' dev    # API on :3000
bun run --filter '@avd/web' dev       # UI on :5173, proxies /api
```

`DEMO_MODE=true` seeds a synthetic connection on first boot, so you can work on dashboards
without an Azure tenant.

## Checks

```bash
bun run lint
bun run typecheck
bun test
TEST_DATABASE_URL=postgres://avd:avd@localhost:5432/avd_test bun test   # includes the SQL tests
```

## Where things live

| Path | What |
|---|---|
| `packages/core` | Metric catalog, dashboard templates, RBAC, zod schemas |
| `packages/db` | Drizzle schema and migrations (`bun run db:generate` after schema edits) |
| `packages/connectors` | One connector per data source; pure normalizers are unit tested |
| `apps/server` | API, auth, query engine, job queue |
| `apps/web` | React SPA |

## Adding a metric

1. Add it to `METRICS` in `packages/core/src/metrics.ts` — table, timestamp column, aggregate,
   allowed dimensions and visualizations.
2. `bun test packages/core` checks the catalog's invariants.
3. It shows up in the widget picker automatically.

SQL fragments in the catalog become SQL text verbatim, so they must be static: never
interpolate anything into them. Everything a user can influence is bound as a parameter by
`apps/server/src/query/engine.ts`. There is a test for that; keep it passing.

## Adding a connector

Implement the `Connector` interface in `packages/connectors/src/types.ts` (`test`, `discover`,
`sync`) and register it in `createConnector`. Keep API-shaped code out of the server: connectors
return the normalized records in `packages/core/src/avd.ts` and never touch the database. Put
payload-shape logic in pure functions so it can be tested against recorded, **scrubbed**
fixtures.

## Style

Biome formats and lints (`bun run format`). Comments explain *why*, not *what*. British or
American spelling, either is fine — just match the file you are in.

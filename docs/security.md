# Security model

## What the app trusts

The app has **no login page of its own**. On Azure it runs behind Container Apps
authentication ("EasyAuth"): the platform terminates every request, authenticates the user
against Entra ID, and injects `X-MS-CLIENT-PRINCIPAL` with the signed-in identity.

That header is only trustworthy **because nothing can reach the container except through that
sidecar**. If you expose the container's port directly, anyone can forge the header and become
whoever they like. So:

- Keep ingress on the container app, with `authConfigs` enabled and
  `unauthenticatedClientAction` set to redirect or 401 (the Bicep template does this).
- Do not put the image behind a load balancer or gateway that bypasses the auth sidecar.
- Defence in depth: set `EASYAUTH_VALIDATE_TOKEN=true` and `EASYAUTH_CLIENT_ID=<app id>`, and
  the app additionally verifies the forwarded `X-MS-TOKEN-AAD-ID-TOKEN` against Entra's JWKS.
  This needs the token store enabled.
- `ALLOWED_TENANT_IDS` restricts which home tenants may sign in at all.

`AUTH_MODE=dev` fabricates an identity for local work. It refuses to start when
`NODE_ENV=production`, and it refuses any bind address other than localhost unless you
explicitly set `DEV_AUTH_ALLOW_REMOTE=true` (which containers need; publish that port to
127.0.0.1 only).

## First-run ownership

On first boot, a one-time code is printed to the container logs. Whoever can read the logs —
the person who deployed the app — can claim ownership once. After that, the code is deleted.
`BOOTSTRAP_OWNER_OIDS` pre-authorizes owners so infrastructure-as-code deployments skip the
step entirely.

Everyone else signs in and lands with **no access** until an admin grants a role.

## Roles

| Role | Can |
|---|---|
| Viewer | Open dashboards shared with them; optionally limited to specific customers |
| Analyst | Build, edit and share dashboards |
| Admin | Manage connections, customers, sync and users |
| Owner | Everything, including other owners |

A viewer can be scoped to one or more customers. That scope is enforced **in the SQL
compiler**, not in the UI: every query intersects the requested tenants with the ones the user
may see, and a request for someone else's tenant returns no rows rather than falling back to
"all". The tests in `apps/server/src/query/engine.test.ts` assert exactly that.

## Credentials

Connection secrets live in one of two places and nowhere else:

1. **Key Vault** — the database stores only the secret's name; the value is read at runtime
   with the container's managed identity. Preferred.
2. **Postgres, AES-256-GCM encrypted** with `APP_ENCRYPTION_KEY` (32 bytes, base64). Use this
   when there is no Key Vault.

Secrets are never returned by the API, never rendered in the UI, and never logged: the logger
redacts anything whose key looks like a credential, and the API scrubs config objects before
echoing them. Partner Center refresh tokens rotate on use and the new token is persisted
automatically.

The app makes **only read calls** to Microsoft and Nerdio APIs. The roles it asks for are all
`*Reader` roles — see [permissions.md](permissions.md).

## Privacy of user data

By default (`PSEUDONYMIZE_USERS=true`) a user's UPN is hashed with a random per-instance salt
before it is stored, so "unique users" and per-user counts work without keeping identifiers.
Set it to `false` if you need to identify individuals in drill-through, and tell your users.

Retention is per connection (`retentionDays`, default 180) and a daily job deletes facts older
than that.

## Reporting a vulnerability

Please do not open a public issue. See [SECURITY.md](../SECURITY.md).

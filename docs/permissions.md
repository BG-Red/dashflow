# Permissions

Everything this app needs is read-only.

## Azure (direct, Lighthouse, and per-customer under GDAP)

| Role | Role definition ID | Needed for | Required? |
|---|---|---|---|
| Reader | `acdd72a7-3385-48ef-bd42-f606fba81ae7` | Listing subscriptions and resources | Yes |
| Desktop Virtualization Reader | `49a72310-ab8d-41df-bbb0-79b649203868` | Host pools, session hosts, app groups, scaling plans, user sessions | Yes |
| Log Analytics Reader | `73c42c96-874c-492b-b04d-ab87d138a893` | Querying `WVD*` and `Perf` tables | For experience, reliability and CPU data |
| Cost Management Reader | `72fafb9e-0641-4937-9268-a91bfd8191a3` | Cost Management query API | For cost widgets |

Assign at the subscription, or at the resource groups that contain AVD plus the Log Analytics
workspace if you want a tighter scope.

**Diagnostic settings matter as much as roles.** Connections, errors, checkpoints and network
data only exist in Log Analytics if each host pool has a diagnostic setting sending them there.
Without it you still get inventory and live sessions, but no history, latency or error
analysis. The connection test reports this as a warning with the fix.

## Azure Lighthouse

Add the app's **service principal object ID** to the delegated authorizations in your offer,
with the four role definition IDs above. Customers must accept the updated offer before the
access appears. Tokens are always issued by your managing tenant.

## Partner Center (GDAP)

A multi-tenant app registration in the partner tenant, with:

- **Redirect URI** — `https://<your-app>/api/connections/consent/callback`
- **Delegated permissions** — Partner Center `user_impersonation`, Azure Service Management
  `user_impersonation`, Microsoft Graph `DelegatedAdminRelationship.Read.All`, `offline_access`
- Consent granted by a partner admin holding the **AdminAgents** role

The refresh token from that consent is stored as a secret and exchanged per customer tenant
(the Secure Application Model), so no per-customer credential ever exists.

**The trap:** a GDAP relationship grants **Entra** roles in the customer tenant. Reading AVD
needs **Azure RBAC** on the customer's subscription as well. Assign the four roles above to
your partner security group inside each customer subscription — Azure Lighthouse is the usual
way to automate that. The connection diagnostics say so explicitly when ARM refuses.

## Nerdio Manager

1. In Nerdio Manager: **Settings → Integrations → REST API** — enable it and note the API
   scope (`api://<guid>/.default`).
2. Create an app registration in the tenant hosting Nerdio Manager, add a client secret, and
   authorize it in those same REST API settings.
3. The role you give it in Nerdio should be read-only. This app only issues GET requests.

Nerdio's REST paths differ between MSP and Enterprise editions and between versions, so the
connection test fetches your instance's own API definition and tells you which paths to
override (per-connection `endpoints`) if the defaults do not match.

## The app's own Azure identity

When deployed with the included Bicep, the container's user-assigned managed identity needs:

- **Key Vault Secrets User** on the vault (the template assigns it)
- To be a **Postgres administrator** for the Flexible Server (the deploy script adds it)

That identity can also be used as the *Azure (direct)* connection credential, which means no
secret to store or rotate at all.

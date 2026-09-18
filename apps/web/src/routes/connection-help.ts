import type { ConnectionType } from "@dashflow/core";

/**
 * The prerequisite steps for each connection type, with copyable commands. Values the
 * operator types in the wizard are substituted in the browser only — nothing here is sent
 * anywhere, and every example value is a placeholder.
 */

export const ROLE_LIST = [
  "Reader",
  "Desktop Virtualization Reader",
  "Log Analytics Reader",
  "Cost Management Reader",
];

export interface HelpStep {
  title: string;
  body: string;
  code?: string;
  codeLabel?: string;
}

export function prerequisiteSteps(
  type: ConnectionType,
  values: {
    tenantId?: string;
    clientId?: string;
    subscriptionId?: string;
    baseUrl?: string;
    redirectUri: string;
  },
): HelpStep[] {
  const tenant = values.tenantId || "<tenant-id>";
  const client = values.clientId || "<client-id>";
  const subscription = values.subscriptionId || "<subscription-id>";

  switch (type) {
    case "azure":
      return [
        {
          title: "Create an app registration (or use this container's managed identity)",
          body: "A managed identity is the safer option when you run this on Azure — there is no secret to store or rotate. Use an app registration when the app runs elsewhere.",
          codeLabel: "az cli",
          code: `az ad app create --display-name "DashFlow"
APP_ID=$(az ad app list --display-name "DashFlow" --query "[0].appId" -o tsv)
az ad sp create --id "$APP_ID"
# Create a client secret (store it in Key Vault, not in a file)
az ad app credential reset --id "$APP_ID" --years 1 --query password -o tsv`,
        },
        {
          title: "Grant read-only Azure roles",
          body: "Assign these at the subscription, or at the resource groups that hold AVD if you prefer a tighter scope. Cost Management Reader is optional and only powers the cost widgets.",
          codeLabel: "az cli",
          code: ROLE_LIST.map(
            (role) =>
              `az role assignment create --assignee "${client}" --role "${role}" --scope "/subscriptions/${subscription}"`,
          ).join("\n"),
        },
        {
          title: "Send AVD diagnostics to Log Analytics",
          body: "Connections, errors, checkpoints and network data only exist if each host pool has a diagnostic setting pointing at a Log Analytics workspace. Without it you still get inventory and live sessions, but no experience or reliability history.",
          codeLabel: "az cli",
          code: `az monitor diagnostic-settings create \\
  --name avd-to-law \\
  --resource "/subscriptions/${subscription}/resourceGroups/<rg>/providers/Microsoft.DesktopVirtualization/hostPools/<pool>" \\
  --workspace "/subscriptions/${subscription}/resourceGroups/<rg>/providers/Microsoft.OperationalInsights/workspaces/<workspace>" \\
  --logs '[{"categoryGroup":"allLogs","enabled":true}]'`,
        },
      ];

    case "lighthouse":
      return [
        {
          title: "Create the app registration in your managing tenant",
          body: "One identity in the managing tenant is all you need — Lighthouse projects it into every delegated customer subscription.",
          codeLabel: "az cli",
          code: `az ad app create --display-name "DashFlow (Lighthouse)"
APP_ID=$(az ad app list --display-name "DashFlow (Lighthouse)" --query "[0].appId" -o tsv)
az ad sp create --id "$APP_ID"
# Note the service principal OBJECT id — Lighthouse authorizations use it
az ad sp show --id "$APP_ID" --query id -o tsv`,
        },
        {
          title: "Add the identity to your delegated authorizations",
          body: "In the Lighthouse offer (ARM template or Managed Services marketplace plan), add an authorization for this service principal with these role definition IDs. Customers must accept the updated offer before the access appears.",
          codeLabel: "role definition ids",
          code: `Reader                        acdd72a7-3385-48ef-bd42-f606fba81ae7
Desktop Virtualization Reader 49a72310-ab8d-41df-bbb0-79b649203868
Log Analytics Reader          73c42c96-874c-492b-b04d-ab87d138a893
Cost Management Reader        72fafb9e-0641-4937-9268-a91bfd8191a3`,
        },
        {
          title: "Confirm the delegation landed",
          body: "Delegated subscriptions report your managing tenant. If this list is empty, the offer has not been accepted for those subscriptions yet.",
          codeLabel: "az cli",
          code: `az account list --query "[?managedByTenants[?tenantId=='${tenant}']].{name:name,id:id,tenant:tenantId}" -o table`,
        },
      ];

    case "partner-center":
      return [
        {
          title: "Register a multi-tenant app in your partner tenant",
          body: "It needs a web redirect URI pointing back at this instance, and a client secret.",
          codeLabel: "redirect uri",
          code: values.redirectUri,
        },
        {
          title: "Add delegated API permissions",
          body: "Partner Center API (user_impersonation), Azure Service Management (user_impersonation) and Microsoft Graph DelegatedAdminRelationship.Read.All. Grant admin consent in the partner tenant.",
          codeLabel: "delegated scopes",
          code: `https://api.partnercenter.microsoft.com/user_impersonation
https://management.azure.com/user_impersonation
https://graph.microsoft.com/DelegatedAdminRelationship.Read.All
offline_access`,
        },
        {
          title: "Consent as a partner admin with the AdminAgents role",
          body: "The next step opens a Microsoft sign-in. The refresh token it returns is stored as a secret and used to get per-customer tokens — this is the Secure Application Model, so no customer-specific credential ever exists.",
        },
        {
          title: "Remember: GDAP is Entra, Azure RBAC is separate",
          body: "A GDAP relationship grants Entra roles in the customer tenant. Reading AVD needs Azure RBAC on the customer's subscription as well — assign the same four read-only roles to your partner security group there (Azure Lighthouse is the usual way to automate that). The connection test says so explicitly if ARM refuses.",
        },
      ];

    case "nerdio":
      return [
        {
          title: "Turn on the Nerdio Manager REST API",
          body: "In Nerdio Manager: Settings → Integrations → REST API. Enable it, then note the API scope it shows (it looks like api://<guid>/.default).",
        },
        {
          title: "Create an app registration for this app",
          body: "Nerdio's REST API authenticates with client credentials from the tenant that hosts Nerdio Manager. Create the app, add a secret, then authorize it in Nerdio's REST API settings.",
          codeLabel: "az cli",
          code: `az ad app create --display-name "DashFlow (Nerdio)"
APP_ID=$(az ad app list --display-name "DashFlow (Nerdio)" --query "[0].appId" -o tsv)
az ad sp create --id "$APP_ID"
az ad app credential reset --id "$APP_ID" --years 1 --query password -o tsv`,
        },
        {
          title: "Find your instance URL",
          body: "It is the URL you open Nerdio Manager with, without a trailing slash. The connection test reads the instance's own API definition and tells you if any of the default paths need overriding for your version.",
          codeLabel: "example",
          code: values.baseUrl || "https://nmw-app-example.azurewebsites.net",
        },
      ];

    default:
      return [];
  }
}

export const CHECK_ORDER: Record<string, number> = { fail: 0, warn: 1, pass: 2, skip: 3 };

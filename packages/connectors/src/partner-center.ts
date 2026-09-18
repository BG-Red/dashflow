import type { DiagnosticCheck, Discovery, PartnerCenterConfig, SyncBatch } from "@dashflow/core";
import { AzureCollector } from "./azure/collectors";
import { createRefreshTokenFn, SCOPES } from "./azure/credentials";
import { httpJson } from "./http";
import { type Connector, type ConnectorContext, ConnectorError, check, type SyncInput } from "./types";

const PARTNER_CENTER = "https://api.partnercenter.microsoft.com/v1";
const GRAPH = "https://graph.microsoft.com/v1.0";

/** Scopes the partner admin consents to once; the refresh token is then reused per customer. */
export const PARTNER_CONSENT_SCOPES = [
  "openid",
  "profile",
  "offline_access",
  "https://api.partnercenter.microsoft.com/user_impersonation",
  "https://management.azure.com/user_impersonation",
  "https://graph.microsoft.com/DelegatedAdminRelationship.Read.All",
].join(" ");

export function buildConsentUrl(opts: {
  partnerTenantId: string;
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const params = new URLSearchParams({
    client_id: opts.clientId,
    response_type: "code",
    redirect_uri: opts.redirectUri,
    response_mode: "query",
    scope: PARTNER_CONSENT_SCOPES,
    state: opts.state,
    prompt: "consent",
  });
  return `https://login.microsoftonline.com/${opts.partnerTenantId}/oauth2/v2.0/authorize?${params}`;
}

/** Exchange the auth code for the long-lived refresh token (Secure Application Model). */
export async function redeemConsentCode(opts: {
  partnerTenantId: string;
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
}): Promise<{ refreshToken: string; upn: string | null }> {
  const doFetch = opts.fetchImpl ?? fetch;
  const response = await doFetch(
    `https://login.microsoftonline.com/${opts.partnerTenantId}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: opts.clientId,
        client_secret: opts.clientSecret,
        grant_type: "authorization_code",
        code: opts.code,
        redirect_uri: opts.redirectUri,
        scope: PARTNER_CONSENT_SCOPES,
      }),
    },
  );
  const payload = (await response.json().catch(() => ({}))) as {
    refresh_token?: string;
    id_token?: string;
    error_description?: string;
    error?: string;
  };
  if (!response.ok || !payload.refresh_token) {
    throw new ConnectorError(
      `Consent failed: ${payload.error ?? response.status} ${(payload.error_description ?? "").slice(0, 200)}`,
    );
  }
  let upn: string | null = null;
  if (payload.id_token) {
    try {
      const claims = JSON.parse(Buffer.from(payload.id_token.split(".")[1]!, "base64url").toString("utf8"));
      upn = (claims.preferred_username ?? claims.upn ?? null) as string | null;
    } catch {
      upn = null;
    }
  }
  return { refreshToken: payload.refresh_token, upn };
}

interface PartnerCustomer {
  id: string;
  companyProfile?: { tenantId?: string; domain?: string; companyName?: string };
}

/**
 * CSP partners: customers come from Partner Center, and access to each customer's Azure
 * resources goes through a GDAP relationship. Note the split that trips everyone up —
 * GDAP grants *Entra* roles, while reading AVD needs *Azure RBAC* on the subscription. The
 * diagnostics below say so explicitly when ARM refuses.
 */
export function createPartnerCenterConnector(config: PartnerCenterConfig, ctx: ConnectorContext): Connector {
  if (!ctx.refreshToken) {
    const missing: Connector = {
      type: "partner-center",
      async test() {
        return [
          check(
            "consent",
            "Partner admin consent",
            "fail",
            "No refresh token is stored for this connection",
            "Open the connection and run 'Grant consent' as a partner admin with the AdminAgents role.",
          ),
        ];
      },
      async discover() {
        throw new ConnectorError("This Partner Center connection has not been consented yet.");
      },
      async sync() {
        throw new ConnectorError("This Partner Center connection has not been consented yet.");
      },
    };
    return missing;
  }

  const token = createRefreshTokenFn({
    clientId: config.clientId,
    clientSecret: ctx.secret ?? "",
    refreshToken: ctx.refreshToken,
    partnerTenantId: config.partnerTenantId,
    onRotate: ctx.onRefreshToken,
    fetchImpl: ctx.fetch,
  });
  const collectorFor = (customerTenantId: string) =>
    new AzureCollector(token, customerTenantId, ctx.log, customerTenantId);

  async function listCustomers(): Promise<PartnerCustomer[]> {
    const doFetch = ctx.fetch ?? fetch;
    const accessToken = await token(SCOPES.partnerCenter, config.partnerTenantId);
    const out: PartnerCustomer[] = [];
    let continuation: string | null = null;
    let pages = 0;

    do {
      const url: string = continuation
        ? `${PARTNER_CENTER}/customers?size=200&seekOperation=Next`
        : `${PARTNER_CENTER}/customers?size=200`;
      const response: Response = await doFetch(url, {
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: "application/json",
          ...(continuation ? { "MS-ContinuationToken": continuation } : {}),
        },
      });
      if (!response.ok) {
        throw new ConnectorError(`Partner Center returned ${response.status}`, {
          status: response.status,
          hint:
            response.status === 403
              ? "The consenting account needs the AdminAgents role in Partner Center, and the app must be registered as a Partner Center app."
              : undefined,
        });
      }
      const payload = (await response.json()) as { items?: PartnerCustomer[] };
      out.push(...(payload.items ?? []));
      continuation = response.headers.get("MS-ContinuationToken");
      pages++;
    } while (continuation && pages < 25);

    return out.filter((customer) => Boolean(customer.companyProfile?.tenantId));
  }

  /** GDAP relationships tell us which customers we can actually act on, and with which roles. */
  async function listGdap(): Promise<Map<string, { status: string; roles: string[]; endsAt?: string }>> {
    const accessToken = await token(SCOPES.graph, config.partnerTenantId);
    const map = new Map<string, { status: string; roles: string[]; endsAt?: string }>();
    try {
      const payload = await httpJson<{
        value?: {
          customer?: { tenantId?: string };
          status?: string;
          endDateTime?: string;
          accessDetails?: { unifiedRoles?: { roleDefinitionId?: string }[] };
        }[];
      }>(`${GRAPH}/tenantRelationships/delegatedAdminRelationships?$top=500`, accessToken);
      for (const relationship of payload.value ?? []) {
        const tenantId = relationship.customer?.tenantId;
        if (!tenantId) continue;
        const existing = map.get(tenantId);
        const roles = (relationship.accessDetails?.unifiedRoles ?? [])
          .map((role) => role.roleDefinitionId ?? "")
          .filter(Boolean);
        if (!existing || relationship.status === "active") {
          map.set(tenantId, {
            status: relationship.status ?? "unknown",
            roles,
            endsAt: relationship.endDateTime,
          });
        }
      }
    } catch (err) {
      ctx.log.warn({ err: (err as Error).message }, "could not read GDAP relationships");
    }
    return map;
  }

  return {
    type: "partner-center",

    async test(): Promise<DiagnosticCheck[]> {
      const checks: DiagnosticCheck[] = [];
      let customers: PartnerCustomer[] = [];
      try {
        customers = await listCustomers();
        checks.push(
          check("partner-center", "List Partner Center customers", "pass", `${customers.length} customer(s)`),
        );
      } catch (err) {
        const e = err as ConnectorError;
        checks.push(check("partner-center", "List Partner Center customers", "fail", e.message, e.hint));
        return checks;
      }

      const gdap = await listGdap();
      const active = [...gdap.values()].filter((r) => r.status === "active").length;
      checks.push(
        check(
          "gdap",
          "Active GDAP relationships",
          active > 0 ? "pass" : "warn",
          `${active} active relationship(s) for ${customers.length} customer(s)`,
          active > 0
            ? undefined
            : "Create GDAP relationships with your customers. Without one, tokens for their tenant will be refused.",
        ),
      );

      // Probe ARM for the first customer that has an active relationship.
      const candidate =
        customers.find((c) => gdap.get(c.companyProfile!.tenantId!)?.status === "active") ?? customers[0];
      if (candidate?.companyProfile?.tenantId) {
        const tenantId = candidate.companyProfile.tenantId;
        try {
          const collector = collectorFor(tenantId);
          const subs = await collector.arm.listSubscriptions();
          checks.push(
            check(
              "customer-arm",
              "Reach a customer's Azure subscriptions",
              subs.length > 0 ? "pass" : "warn",
              `${candidate.companyProfile.companyName ?? tenantId}: ${subs.length} subscription(s)`,
              subs.length > 0
                ? undefined
                : "GDAP grants Entra roles, not Azure RBAC. Assign Reader, Desktop Virtualization Reader and Log Analytics Reader to your partner security group inside the customer's subscription (Azure Lighthouse is the usual way to automate this).",
            ),
          );
          if (subs.length > 0) {
            checks.push(
              ...(await collector.diagnose({ subscriptionIds: subs.map((s) => s.subscriptionId) })),
            );
          }
        } catch (err) {
          const e = err as ConnectorError;
          checks.push(
            check(
              "customer-arm",
              "Reach a customer's Azure subscriptions",
              "fail",
              e.message,
              e.hint ??
                "GDAP grants Entra roles, not Azure RBAC. Assign Azure roles in the customer's subscription as well.",
            ),
          );
        }
      }
      return checks;
    },

    async discover(): Promise<Discovery> {
      const [customers, gdap] = await Promise.all([listCustomers(), listGdap()]);
      const discovery: Discovery = { tenants: [], subscriptions: [], workspaces: [], hostPoolCount: 0 };

      for (const customer of customers) {
        const tenantId = customer.companyProfile!.tenantId!;
        const relationship = gdap.get(tenantId);
        discovery.tenants.push({
          tenantId,
          displayName: customer.companyProfile?.companyName ?? tenantId,
          domain: customer.companyProfile?.domain,
          meta: {
            partnerCenterCustomerId: customer.id,
            gdapStatus: relationship?.status ?? "none",
            gdapEndsAt: relationship?.endsAt,
          },
        });

        // Only probe Azure for customers we can actually reach, so discovery stays quick.
        if (relationship?.status !== "active") continue;
        try {
          const collector = collectorFor(tenantId);
          const subs = await collector.arm.listSubscriptions();
          discovery.subscriptions.push(
            ...subs.map((sub) => ({
              tenantId,
              subscriptionId: sub.subscriptionId,
              displayName: sub.displayName,
            })),
          );
          const rest = await collector.discover(subs.map((s) => s.subscriptionId));
          discovery.workspaces.push(...rest.workspaces);
          discovery.hostPoolCount += rest.hostPoolCount;
        } catch (err) {
          ctx.log.warn({ err: (err as Error).message, tenantId }, "customer discovery failed");
        }
      }
      return discovery;
    },

    async sync(input: SyncInput): Promise<SyncBatch> {
      const collector = collectorFor(input.tenantId);
      const subscriptionIds =
        input.subscriptionIds.length > 0
          ? input.subscriptionIds
          : (await collector.arm.listSubscriptions()).map((s) => s.subscriptionId);
      switch (input.stream) {
        case "inventory":
          return collector.inventory(subscriptionIds);
        case "sessions":
          return collector.sessions(input.hostPoolIds);
        case "logs":
          return collector.logs(input);
        case "cost":
          return collector.cost({ ...input, subscriptionIds });
      }
    },
  };
}

import type { DiagnosticCheck, Discovery, LighthouseConfig, SyncBatch } from "@dashflow/core";
import { AzureCollector } from "./azure/collectors";
import { createTokenFn } from "./azure/credentials";
import { type Connector, type ConnectorContext, check, type SyncInput } from "./types";

/**
 * Azure Lighthouse: one identity in the managing tenant already has RBAC on every delegated
 * subscription, so tokens always come from the managing tenant. Customers are discovered from
 * the subscriptions themselves — each delegated subscription reports its own home tenant.
 */
export function createLighthouseConnector(config: LighthouseConfig, ctx: ConnectorContext): Connector {
  const token = createTokenFn({
    mode: config.credentialMode,
    tenantId: config.tenantId,
    clientId: config.clientId,
    secret: ctx.secret,
  });
  /** Collector used for tenant-agnostic ARM calls (listing subscriptions). */
  const home = new AzureCollector(token, config.tenantId, ctx.log);
  const collectorFor = (customerTenantId: string) =>
    new AzureCollector(token, customerTenantId, ctx.log, config.tenantId);

  async function delegated() {
    const subs = await home.arm.listSubscriptions();
    return subs.filter((sub) => {
      const isDelegated = sub.managedByTenants.some((t) => t.toLowerCase() === config.tenantId.toLowerCase());
      const isHome = (sub.tenantId ?? "").toLowerCase() === config.tenantId.toLowerCase();
      return isDelegated || (config.includeHomeTenant && isHome);
    });
  }

  return {
    type: "lighthouse",

    async test(): Promise<DiagnosticCheck[]> {
      const checks: DiagnosticCheck[] = [];
      let subs: Awaited<ReturnType<typeof delegated>> = [];
      try {
        subs = await delegated();
        const customers = new Set(subs.map((s) => s.tenantId ?? "unknown"));
        checks.push(
          check(
            "lighthouse-subscriptions",
            "Find delegated subscriptions",
            subs.length > 0 ? "pass" : "fail",
            subs.length > 0
              ? `${subs.length} subscription(s) across ${customers.size} customer tenant(s)`
              : "No delegated subscriptions are visible",
            subs.length > 0
              ? undefined
              : "Onboard customers to Azure Lighthouse and include this app's identity in the delegated authorizations, with at least Reader, Desktop Virtualization Reader and Log Analytics Reader.",
          ),
        );
      } catch (err) {
        checks.push(
          check(
            "lighthouse-subscriptions",
            "Find delegated subscriptions",
            "fail",
            (err as Error).message,
            "Check the managing tenant id, client id and secret.",
          ),
        );
        return checks;
      }

      // Diagnose against the first customer so failures name a real permission problem.
      const firstCustomer = subs.find((s) => s.tenantId)?.tenantId;
      if (firstCustomer) {
        const sample = subs.filter((s) => s.tenantId === firstCustomer).map((s) => s.subscriptionId);
        checks.push(...(await collectorFor(firstCustomer).diagnose({ subscriptionIds: sample })));
      }
      return checks;
    },

    async discover(): Promise<Discovery> {
      const subs = await delegated();
      const byTenant = new Map<string, { subscriptionId: string; displayName: string }[]>();
      for (const sub of subs) {
        const tenantId = sub.tenantId ?? config.tenantId;
        const list = byTenant.get(tenantId) ?? [];
        list.push({ subscriptionId: sub.subscriptionId, displayName: sub.displayName });
        byTenant.set(tenantId, list);
      }

      const discovery: Discovery = { tenants: [], subscriptions: [], workspaces: [], hostPoolCount: 0 };
      for (const [tenantId, tenantSubs] of byTenant) {
        const collector = collectorFor(tenantId);
        const names = await collector.arm.listTenants().catch(() => []);
        const info = names.find((t) => t.tenantId.toLowerCase() === tenantId.toLowerCase());
        discovery.tenants.push({
          tenantId,
          displayName: info?.displayName ?? tenantSubs[0]?.displayName ?? tenantId,
          domain: info?.defaultDomain,
          meta: { delegated: true, subscriptions: tenantSubs.length },
        });
        discovery.subscriptions.push(
          ...tenantSubs.map((sub) => ({
            tenantId,
            subscriptionId: sub.subscriptionId,
            displayName: sub.displayName,
          })),
        );
        const rest = await collector.discover(tenantSubs.map((s) => s.subscriptionId));
        discovery.workspaces.push(...rest.workspaces);
        discovery.hostPoolCount += rest.hostPoolCount;
      }
      return discovery;
    },

    async sync(input: SyncInput): Promise<SyncBatch> {
      const collector = collectorFor(input.tenantId);
      switch (input.stream) {
        case "inventory":
          return collector.inventory(input.subscriptionIds);
        case "sessions":
          return collector.sessions(input.hostPoolIds);
        case "logs":
          return collector.logs(input);
        case "cost":
          return collector.cost(input);
      }
    },
  };
}

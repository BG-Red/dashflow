import type { DiagnosticCheck, Discovery, SyncBatch } from "@avd/core";
import { demoBatch, demoTenants } from "@avd/demo";
import { type Connector, type ConnectorContext, check, type SyncInput } from "./types";

interface DemoConfig {
  type: "demo";
  tenants: number;
}

/** Fully synthetic connector so the whole pipeline can be exercised without an Azure tenant. */
export function createDemoConnector(config: DemoConfig, _ctx: ConnectorContext): Connector {
  const tenants = demoTenants(config.tenants);

  return {
    type: "demo",

    async test(): Promise<DiagnosticCheck[]> {
      return [
        check("demo", "Demo connection", "pass", `${tenants.length} sample customers with synthetic data`),
        check(
          "demo-note",
          "This is not real data",
          "warn",
          "Everything under this connection is generated locally",
          "Add an Azure, Lighthouse, Partner Center or Nerdio connection to chart a real environment.",
        ),
      ];
    },

    async discover(): Promise<Discovery> {
      return {
        tenants: tenants.map((tenant) => ({
          tenantId: tenant.tenantId,
          displayName: tenant.displayName,
          domain: tenant.domain,
          meta: { demo: true },
        })),
        subscriptions: tenants.map((tenant) => ({
          tenantId: tenant.tenantId,
          subscriptionId: tenant.subscriptionId,
          displayName: `${tenant.displayName} — AVD`,
        })),
        workspaces: tenants.map((tenant) => ({
          tenantId: tenant.tenantId,
          resourceId: `/subscriptions/${tenant.subscriptionId}/resourcegroups/rg-avd/providers/microsoft.operationalinsights/workspaces/law-avd`,
          workspaceId: tenant.tenantId,
          name: "law-avd (demo)",
          hostPoolIds: tenant.pools.map((pool) => pool.resourceId),
        })),
        hostPoolCount: tenants.reduce((sum, tenant) => sum + tenant.pools.length, 0),
      };
    },

    async sync(input: SyncInput): Promise<SyncBatch> {
      const tenant = tenants.find((t) => t.tenantId === input.tenantId);
      if (!tenant) return {};
      const from = input.since ?? new Date(input.until.getTime() - input.backfillDays * 86_400_000);
      return demoBatch(tenant, input.stream, from, input.until);
    },
  };
}

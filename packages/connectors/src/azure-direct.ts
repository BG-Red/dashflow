import type { AzureConfig, DiagnosticCheck, Discovery, SyncBatch } from "@dashflow/core";
import { AzureCollector } from "./azure/collectors";
import { createTokenFn } from "./azure/credentials";
import { type Connector, type ConnectorContext, check, type SyncInput } from "./types";

/** One Entra tenant, reached with a service principal or the app's own managed identity. */
export function createAzureConnector(config: AzureConfig, ctx: ConnectorContext): Connector {
  const token = createTokenFn({
    mode: config.credentialMode,
    tenantId: config.tenantId,
    clientId: config.clientId,
    secret: ctx.secret,
  });
  const collector = new AzureCollector(token, config.tenantId, ctx.log);

  const subscriptionsFor = async (): Promise<string[]> =>
    config.subscriptionIds.length > 0
      ? config.subscriptionIds
      : (await collector.arm.listSubscriptions()).map((s) => s.subscriptionId);

  return {
    type: "azure",

    async test(): Promise<DiagnosticCheck[]> {
      const checks: DiagnosticCheck[] = [
        check(
          "credential",
          config.credentialMode === "managed-identity"
            ? "Use the app's managed identity"
            : "Use the configured credential",
          config.credentialMode !== "managed-identity" && !ctx.secret ? "fail" : "pass",
          config.credentialMode !== "managed-identity" && !ctx.secret
            ? "No secret is stored for this connection"
            : undefined,
          "Re-enter the client secret or certificate on the connection page.",
        ),
      ];
      if (checks[0]!.status === "fail") return checks;
      return [...checks, ...(await collector.diagnose({ subscriptionIds: config.subscriptionIds }))];
    },

    async discover(): Promise<Discovery> {
      const tenants = await collector.arm.listTenants().catch(() => []);
      const self = tenants.find((t) => t.tenantId.toLowerCase() === config.tenantId.toLowerCase());
      const subscriptions = await collector.arm.listSubscriptions().catch(() => []);
      const selected =
        config.subscriptionIds.length > 0
          ? config.subscriptionIds
          : subscriptions.map((s) => s.subscriptionId);
      const rest = await collector.discover(selected);

      return {
        tenants: [
          {
            tenantId: config.tenantId,
            displayName: self?.displayName ?? "Azure tenant",
            domain: self?.defaultDomain,
          },
        ],
        subscriptions: subscriptions
          .filter((s) => selected.includes(s.subscriptionId))
          .map((s) => ({
            tenantId: config.tenantId,
            subscriptionId: s.subscriptionId,
            displayName: s.displayName,
          })),
        workspaces: rest.workspaces,
        hostPoolCount: rest.hostPoolCount,
      };
    },

    async sync(input: SyncInput): Promise<SyncBatch> {
      const subscriptionIds =
        input.subscriptionIds.length > 0 ? input.subscriptionIds : await subscriptionsFor();
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

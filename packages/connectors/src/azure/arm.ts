import type { AppGroupRecord, HostPoolRecord, ScalingPlanRecord, SessionHostRecord } from "@avd/core";
import { normalizeResourceId, parseResourceId } from "@avd/core";
import { armList, httpJson, type TokenFn } from "../http";
import { SCOPES } from "./credentials";

export const API = {
  desktopVirtualization: "2024-04-03",
  resourceGraph: "2022-10-01",
  subscriptions: "2022-12-01",
  diagnosticSettings: "2021-05-01-preview",
  operationalInsights: "2022-10-01",
  costManagement: "2023-11-01",
} as const;

const ARM = "https://management.azure.com";

interface ArmResource {
  id: string;
  name: string;
  location?: string;
  properties?: Record<string, unknown>;
}

export interface ArmClient {
  /** Tenants this identity can see; a service principal only ever sees its own. */
  listTenants(): Promise<{ tenantId: string; displayName?: string; defaultDomain?: string }[]>;
  listSubscriptions(): Promise<
    { subscriptionId: string; displayName: string; tenantId?: string; managedByTenants: string[] }[]
  >;
  listHostPools(subscriptionId: string): Promise<HostPoolRecord[]>;
  listSessionHosts(hostPoolId: string): Promise<SessionHostRecord[]>;
  listUserSessions(hostPoolId: string): Promise<{ sessionState: string; sessionHost: string }[]>;
  listAppGroups(subscriptionId: string): Promise<AppGroupRecord[]>;
  listScalingPlans(subscriptionId: string): Promise<ScalingPlanRecord[]>;
  /** Log Analytics workspaces that receive diagnostics for this host pool. */
  diagnosticWorkspaces(hostPoolId: string): Promise<string[]>;
  workspaceCustomerId(resourceId: string): Promise<{ workspaceId: string; name: string } | null>;
  resourceGraph<T>(query: string, subscriptionIds: string[]): Promise<T[]>;
  raw<T>(path: string, apiVersion: string): Promise<T>;
}

export function createArmClient(token: TokenFn, tenantId: string): ArmClient {
  const get = <T>(path: string, apiVersion: string) =>
    token(SCOPES.arm, tenantId).then((t) =>
      httpJson<T>(`${ARM}${path}${path.includes("?") ? "&" : "?"}api-version=${apiVersion}`, t),
    );
  const list = <T>(path: string, apiVersion: string) =>
    armList<T>(`${ARM}${path}?api-version=${apiVersion}`, token, SCOPES.arm, tenantId);

  return {
    async listTenants() {
      const tenants = await list<{ tenantId: string; displayName?: string; defaultDomain?: string }>(
        "/tenants",
        API.subscriptions,
      );
      return tenants.filter((t) => Boolean(t.tenantId));
    },

    async listSubscriptions() {
      const subs = await list<{
        subscriptionId: string;
        displayName: string;
        tenantId?: string;
        managedByTenants?: { tenantId: string }[];
        state?: string;
      }>("/subscriptions", API.subscriptions);
      return subs
        .filter((s) => s.state !== "Disabled" && s.state !== "Deleted")
        .map((s) => ({
          subscriptionId: s.subscriptionId,
          displayName: s.displayName,
          tenantId: s.tenantId,
          managedByTenants: (s.managedByTenants ?? []).map((m) => m.tenantId),
        }));
    },

    async listHostPools(subscriptionId) {
      const pools = await list<ArmResource>(
        `/subscriptions/${subscriptionId}/providers/Microsoft.DesktopVirtualization/hostPools`,
        API.desktopVirtualization,
      );
      return pools.map((pool) => {
        const props = pool.properties ?? {};
        return {
          resourceId: normalizeResourceId(pool.id),
          tenantId,
          subscriptionId,
          name: pool.name,
          friendlyName: (props.friendlyName as string) ?? null,
          location: pool.location ?? "unknown",
          poolType: (props.hostPoolType as string) ?? "Pooled",
          loadBalancer: (props.loadBalancerType as string) ?? null,
          maxSessions: typeof props.maxSessionLimit === "number" ? props.maxSessionLimit : null,
          startVmOnConnect: (props.startVMOnConnect as boolean) ?? null,
          validationEnvironment: (props.validationEnvironment as boolean) ?? null,
          preferredAppGroupType: (props.preferredAppGroupType as string) ?? null,
          autoscaleEnabled: null,
          source: "azure",
        } satisfies HostPoolRecord;
      });
    },

    async listSessionHosts(hostPoolId) {
      const hosts = await list<ArmResource>(`${hostPoolId}/sessionHosts`, API.desktopVirtualization);
      return hosts.map((host) => {
        const props = host.properties ?? {};
        // ARM returns "hostpoolname/vmname.domain"; keep just the host part.
        const name = host.name.includes("/") ? host.name.slice(host.name.indexOf("/") + 1) : host.name;
        return {
          resourceId: normalizeResourceId(host.id),
          hostPoolId: normalizeResourceId(hostPoolId),
          tenantId,
          name,
          vmResourceId: props.resourceId ? normalizeResourceId(props.resourceId as string) : null,
          status: (props.status as string) ?? "Unknown",
          allowNewSession: props.allowNewSession !== false,
          sessions: typeof props.sessions === "number" ? props.sessions : 0,
          agentVersion: (props.agentVersion as string) ?? null,
          osVersion: (props.osVersion as string) ?? null,
          lastHeartBeat: (props.lastHeartBeat as string) ?? null,
          updateState: (props.updateState as string) ?? null,
          source: "azure",
        } satisfies SessionHostRecord;
      });
    },

    async listUserSessions(hostPoolId) {
      const sessions = await list<ArmResource>(`${hostPoolId}/userSessions`, API.desktopVirtualization);
      return sessions.map((session) => {
        const props = session.properties ?? {};
        const parts = session.name.split("/");
        return {
          sessionState: (props.sessionState as string) ?? "Unknown",
          sessionHost: parts.length > 1 ? parts[1]! : session.name,
        };
      });
    },

    async listAppGroups(subscriptionId) {
      const groups = await list<ArmResource>(
        `/subscriptions/${subscriptionId}/providers/Microsoft.DesktopVirtualization/applicationGroups`,
        API.desktopVirtualization,
      );
      return groups.map((group) => {
        const props = group.properties ?? {};
        return {
          resourceId: normalizeResourceId(group.id),
          hostPoolId: props.hostPoolArmPath ? normalizeResourceId(props.hostPoolArmPath as string) : null,
          tenantId,
          name: group.name,
          groupType: (props.applicationGroupType as string) ?? "Desktop",
          workspaceId: props.workspaceArmPath ? normalizeResourceId(props.workspaceArmPath as string) : null,
        } satisfies AppGroupRecord;
      });
    },

    async listScalingPlans(subscriptionId) {
      const plans = await list<ArmResource>(
        `/subscriptions/${subscriptionId}/providers/Microsoft.DesktopVirtualization/scalingPlans`,
        API.desktopVirtualization,
      );
      return plans.map((plan) => {
        const props = plan.properties ?? {};
        const references = (props.hostPoolReferences as { hostPoolArmPath?: string }[] | undefined) ?? [];
        return {
          resourceId: normalizeResourceId(plan.id),
          tenantId,
          name: plan.name,
          timeZone: (props.timeZone as string) ?? null,
          hostPoolIds: references
            .map((r) => (r.hostPoolArmPath ? normalizeResourceId(r.hostPoolArmPath) : ""))
            .filter(Boolean),
          schedules: Array.isArray(props.schedules) ? (props.schedules as unknown[]).length : 0,
        } satisfies ScalingPlanRecord;
      });
    },

    async diagnosticWorkspaces(hostPoolId) {
      const settings = await get<{ value?: { properties?: { workspaceId?: string } }[] }>(
        `${hostPoolId}/providers/Microsoft.Insights/diagnosticSettings`,
        API.diagnosticSettings,
      );
      return [
        ...new Set(
          (settings.value ?? [])
            .map((s) => s.properties?.workspaceId)
            .filter((id): id is string => typeof id === "string" && id.length > 0)
            .map(normalizeResourceId),
        ),
      ];
    },

    async workspaceCustomerId(resourceId) {
      const workspace = await get<{ name?: string; properties?: { customerId?: string } }>(
        resourceId,
        API.operationalInsights,
      );
      const customerId = workspace.properties?.customerId;
      if (!customerId) return null;
      return {
        workspaceId: customerId,
        name: workspace.name ?? parseResourceId(resourceId).name ?? resourceId,
      };
    },

    async resourceGraph<T>(query: string, subscriptionIds: string[]) {
      const out: T[] = [];
      let skipToken: string | undefined;
      let pages = 0;
      do {
        const accessToken = await token(SCOPES.arm, tenantId);
        const page = await httpJson<{ data?: T[]; $skipToken?: string }>(
          `${ARM}/providers/Microsoft.ResourceGraph/resources?api-version=${API.resourceGraph}`,
          accessToken,
          {
            method: "POST",
            body: {
              query,
              ...(subscriptionIds.length > 0 ? { subscriptions: subscriptionIds } : {}),
              options: {
                $top: 1000,
                resultFormat: "objectArray",
                ...(skipToken ? { $skipToken: skipToken } : {}),
              },
            },
          },
        );
        if (page.data) out.push(...page.data);
        skipToken = page.$skipToken;
        pages++;
      } while (skipToken && pages < 50);
      return out;
    },

    raw: get,
  };
}

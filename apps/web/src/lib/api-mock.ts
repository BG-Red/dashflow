import {
  CATEGORY_INFO,
  CONNECTION_TYPE_INFO,
  DASHBOARD_TEMPLATES,
  type DashboardSpec,
  DIMENSIONS,
  METRICS,
  type QueryRequest,
  ROLE_INFO,
  templateFor,
} from "@dashflow/core";
import { buildDataset, type Dataset } from "@dashflow/demo/dataset";
import { evaluate } from "@dashflow/demo/evaluator";
import type { DetailRow, api as RealApi } from "./api";

/**
 * The demo build's API: the same surface as the HTTP client, answered from a synthetic estate
 * generated in the browser. It exists so anyone can click through DashFlow without deploying
 * anything — and the evaluator behind it is checked against the real SQL engine by
 * `packages/demo/src/parity.test.ts`, so the demo cannot quietly drift from the product.
 */

let dataset: Dataset | null = null;
const data = (): Dataset => {
  dataset ??= buildDataset({ tenants: 4, days: 30 });
  return dataset;
};

const STORAGE_KEY = "dashflow.demo.dashboards";

interface StoredDashboard extends DashboardSpec {
  id: string;
  updatedAt: string;
  favorite: boolean;
}

function seedDashboards(): StoredDashboard[] {
  return ["executive", "experience", "reliability"].map((goal, index) => {
    const template = templateFor(goal as never)!;
    return {
      id: `demo-${goal}`,
      name: template.name,
      description: template.description,
      goal: template.goal,
      widgets: template.widgets,
      defaultPreset: "7d" as const,
      tenantScope: null,
      visibility: "shared" as const,
      sharedWithRole: "viewer" as const,
      updatedAt: new Date(Date.now() - index * 3_600_000).toISOString(),
      favorite: index === 0,
    };
  });
}

function loadDashboards(): StoredDashboard[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as StoredDashboard[];
  } catch {
    // A demo that cannot write to storage still works; it just forgets.
  }
  const seeded = seedDashboards();
  saveDashboards(seeded);
  return seeded;
}

function saveDashboards(dashboards: StoredDashboard[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(dashboards));
  } catch {
    // ignore
  }
}

const delay = <T>(value: T, ms = 120): Promise<T> =>
  new Promise((resolve) => setTimeout(() => resolve(value), ms));

const poolLabel = (pool: { friendlyName?: string | null; name: string }) => pool.friendlyName ?? pool.name;

function tenantName(id: string): string {
  return data().tenants.find((tenant) => tenant.id === id)?.displayName ?? "Unknown";
}

function runQuery(request: QueryRequest & { tz?: string }) {
  return evaluate(data(), {
    ...request,
    from: new Date(request.from),
    to: new Date(request.to),
  });
}

/** Rows behind a click, matching the shape the real detail endpoint returns. */
function detailRows(body: {
  metric?: string;
  from: string;
  to: string;
  tenantIds: string[] | null;
  hostPools: string[];
  groupBy?: string;
  groupValue?: string;
  limit?: number;
}) {
  const from = new Date(body.from).getTime();
  const to = new Date(body.to).getTime();
  const metric = body.metric ?? "connections.count";
  const isError = metric.startsWith("errors.");
  const source = isError ? data().errors : data().connections;

  const rows = source
    .filter((row) => {
      const at = new Date(row.ts).getTime();
      if (at < from || at >= to) return false;
      if (body.tenantIds?.length && !body.tenantIds.includes(row.tenantId)) return false;
      if (body.hostPools.length && !body.hostPools.includes(row.hostPoolId ?? "")) return false;
      if (body.groupBy && body.groupValue) {
        const pool = data().pools.find((candidate) => candidate.resourceId === row.hostPoolId);
        const value =
          body.groupBy === "hostPool"
            ? pool
              ? poolLabel(pool)
              : "Unknown"
            : body.groupBy === "tenant"
              ? tenantName(row.tenantId)
              : String((row as unknown as Record<string, unknown>)[body.groupBy] ?? "");
        if (value !== body.groupValue) return false;
      }
      return true;
    })
    .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime())
    .slice(0, body.limit ?? 200);

  if (isError) {
    return rows.map((row) => {
      const error = row as (typeof dataset extends null ? never : Dataset)["errors"][number];
      const pool = data().pools.find((candidate) => candidate.resourceId === error.hostPoolId);
      return {
        ts: error.ts,
        tenant: tenantName(error.tenantId),
        host_pool: pool ? poolLabel(pool) : "—",
        code: error.code,
        source: error.source,
        service_error: error.serviceError,
        message: error.message,
      } satisfies DetailRow;
    });
  }

  return rows.map((row) => {
    const connection = row as unknown as {
      ts: string;
      tenantId: string;
      hostPoolId: string | null;
      user: string;
      sessionHost: string | null;
      clientOs: string | null;
      clientType: string | null;
      gatewayRegion: string | null;
      state: string;
      connectMs: number | null;
      rttMs: number | null;
      durationSec: number | null;
    };
    const pool = data().pools.find((candidate) => candidate.resourceId === connection.hostPoolId);
    return {
      ts: connection.ts,
      tenant: tenantName(connection.tenantId),
      host_pool: pool ? poolLabel(pool) : "—",
      user: connection.user,
      session_host: connection.sessionHost,
      client_os: connection.clientOs,
      client_type: connection.clientType,
      gateway_region: connection.gatewayRegion,
      state: connection.state,
      connect_ms: connection.connectMs,
      rtt_ms: connection.rttMs,
      duration_sec: connection.durationSec,
    } satisfies DetailRow;
  });
}

const readOnly = () => {
  throw new Error("This is the hosted demo — connections and users are read-only here.");
};

export const mockApi: typeof RealApi = {
  me: () =>
    delay({
      user: {
        id: "demo-user",
        email: "you@demo.dashflow",
        displayName: "Demo visitor",
        role: "owner" as const,
        tenantScope: null,
      },
      instance: {
        claimed: true,
        authMode: "easyauth" as const,
        demoMode: true,
        pseudonymizeUsers: true,
        canStoreSecrets: false,
        canUseKeyVault: false,
        connectionCount: 1,
      },
      tenants: data().tenants.map((tenant) => ({
        id: tenant.id,
        displayName: tenant.displayName,
        domain: tenant.domain,
        connectionId: "demo",
      })),
    }),

  claim: () => delay({ ok: true }),

  catalog: () =>
    delay({
      metrics: METRICS.map((metric) => ({
        id: metric.id,
        label: metric.label,
        description: metric.description,
        category: metric.category,
        unit: metric.unit,
        betterWhen: metric.betterWhen,
        viz: [...metric.viz],
        dims: Object.keys(metric.dims),
        requires: metric.requires ?? null,
        available: metric.id !== "autoscale.actions" && metric.id !== "cost.savings",
      })),
      dimensions: DIMENSIONS,
      categories: CATEGORY_INFO,
      templates: DASHBOARD_TEMPLATES,
      connectionTypes: CONNECTION_TYPE_INFO,
      roles: ROLE_INFO,
    }),

  connections: () =>
    delay([
      {
        id: "demo",
        name: "Demo data (synthetic)",
        type: "demo" as const,
        config: { type: "demo", tenants: 4 },
        schedule: {
          inventoryMinutes: 60,
          sessionsMinutes: 5,
          logsMinutes: 15,
          costHours: 24,
          backfillDays: 30,
          retentionDays: 180,
        },
        enabled: true,
        status: "ok" as const,
        hasSecret: false,
        consented: false,
        lastTestedAt: new Date().toISOString(),
        lastTest: [
          { id: "demo", label: "Demo connection", status: "pass" as const, detail: "4 synthetic customers" },
          {
            id: "demo-note",
            label: "This is not real data",
            status: "warn" as const,
            detail: "Everything here is generated in your browser",
            fix: "Deploy DashFlow and add an Azure, Lighthouse, Partner Center or Nerdio connection.",
          },
        ],
        lastSyncAt: new Date().toISOString(),
        tenantCount: data().tenants.length,
      },
    ]),
  createConnection: readOnly,
  updateConnection: readOnly,
  deleteConnection: readOnly,
  testConnection: () => delay({ checks: [] }),
  discover: readOnly,
  syncConnection: readOnly,
  consentUrl: readOnly,

  tenants: () =>
    delay(
      data().tenants.map((tenant) => ({
        id: tenant.id,
        connectionId: "demo",
        connectionName: "Demo data (synthetic)",
        connectionType: "demo",
        tenantId: tenant.id,
        displayName: tenant.displayName,
        domain: tenant.domain,
        enabled: true,
        meta: { demo: true },
        subscriptions: [],
        workspaces: [],
        hostPools: data()
          .pools.filter((pool) => pool.tenantId === tenant.id)
          .map((pool) => ({
            resourceId: pool.resourceId,
            name: pool.name,
            friendlyName: pool.friendlyName ?? null,
            location: pool.location,
            poolType: pool.poolType,
            maxSessions: pool.maxSessions ?? null,
            autoscaleEnabled: pool.autoscaleEnabled ?? null,
            sources: ["demo"],
            enabled: true,
          })),
      })),
    ),
  saveSelection: readOnly,
  hostPools: () =>
    delay(
      data().pools.map((pool) => ({
        resourceId: pool.resourceId,
        name: pool.name,
        friendlyName: pool.friendlyName ?? null,
        tenantId: pool.tenantId,
        tenantName: pool.tenantName,
        poolType: pool.poolType,
        location: pool.location,
      })),
    ),

  dashboards: () =>
    delay(
      loadDashboards().map((dashboard) => ({
        id: dashboard.id,
        name: dashboard.name,
        description: dashboard.description,
        goal: dashboard.goal,
        widgetCount: dashboard.widgets.length,
        visibility: dashboard.visibility,
        sharedWithRole: dashboard.sharedWithRole,
        defaultPreset: dashboard.defaultPreset,
        tenantScope: dashboard.tenantScope,
        isOwner: true,
        favorite: dashboard.favorite,
        updatedAt: dashboard.updatedAt,
      })),
    ),
  dashboard: (id) => {
    const dashboard = loadDashboards().find((candidate) => candidate.id === id);
    if (!dashboard) return Promise.reject(new Error("No such dashboard"));
    return delay({ ...dashboard, isOwner: true, canEdit: true });
  },
  createDashboard: (body) => {
    const dashboards = loadDashboards();
    const id = `demo-${Math.random().toString(36).slice(2, 8)}`;
    dashboards.unshift({ ...body, id, updatedAt: new Date().toISOString(), favorite: false });
    saveDashboards(dashboards);
    return delay({ id });
  },
  createFromTemplate: (body) => {
    const template = templateFor(body.goal as never);
    if (!template) return Promise.reject(new Error("No such template"));
    const dashboards = loadDashboards();
    const id = `demo-${Math.random().toString(36).slice(2, 8)}`;
    dashboards.unshift({
      id,
      name: body.name ?? template.name,
      description: template.description,
      goal: template.goal,
      widgets: template.widgets.filter((widget) => !body.omit.includes(widget.id)),
      defaultPreset: body.defaultPreset as StoredDashboard["defaultPreset"],
      tenantScope: body.tenantScope,
      visibility: "private",
      sharedWithRole: "viewer",
      updatedAt: new Date().toISOString(),
      favorite: false,
    });
    saveDashboards(dashboards);
    return delay({ id });
  },
  saveDashboard: (id, body) => {
    const dashboards = loadDashboards();
    const index = dashboards.findIndex((candidate) => candidate.id === id);
    if (index >= 0) {
      dashboards[index] = { ...dashboards[index]!, ...body, updatedAt: new Date().toISOString() };
      saveDashboards(dashboards);
    }
    return delay({ ok: true as const });
  },
  deleteDashboard: (id) => {
    saveDashboards(loadDashboards().filter((candidate) => candidate.id !== id));
    return delay({ ok: true as const });
  },
  duplicateDashboard: (id) => {
    const dashboards = loadDashboards();
    const source = dashboards.find((candidate) => candidate.id === id);
    if (!source) return Promise.reject(new Error("No such dashboard"));
    const copy = {
      ...source,
      id: `demo-${Math.random().toString(36).slice(2, 8)}`,
      name: `${source.name} (copy)`,
      favorite: false,
      updatedAt: new Date().toISOString(),
    };
    dashboards.unshift(copy);
    saveDashboards(dashboards);
    return delay({ id: copy.id });
  },
  setFavorite: (id, favorite) => {
    const dashboards = loadDashboards();
    const index = dashboards.findIndex((candidate) => candidate.id === id);
    if (index >= 0) {
      dashboards[index] = { ...dashboards[index]!, favorite };
      saveDashboards(dashboards);
    }
    return delay({ ok: true as const });
  },

  query: (body) => delay(runQuery(body), 60),
  queryBatch: (body) =>
    delay(
      {
        results: body.queries.map(({ key, ...request }) => {
          try {
            return { key, result: runQuery(request) };
          } catch (error) {
            return { key, error: (error as Error).message };
          }
        }),
      },
      80,
    ),
  detail: (body) => delay({ rows: detailRows(body), pseudonymized: true, table: "connection_facts" }),
  dimensionValues: (metric, dim) => {
    const request: QueryRequest = {
      metric,
      viz: "bar",
      groupBy: dim as never,
      topN: 50,
      grain: "day",
      from: new Date(Date.now() - 30 * 86_400_000),
      to: new Date(),
      tenantIds: null,
      filters: {},
      compare: false,
    };
    const result = evaluate(data(), request);
    return delay({
      values:
        result.kind === "breakdown"
          ? result.items.map((item) => ({ value: item.name, hits: item.value }))
          : [],
    });
  },

  pool: (resourceId) => {
    const pool = data().pools.find((candidate) => candidate.resourceId === resourceId);
    if (!pool) return Promise.reject(new Error("No such host pool"));
    return delay({
      pool: {
        resourceId: pool.resourceId,
        name: pool.name,
        friendlyName: pool.friendlyName ?? null,
        location: pool.location,
        poolType: pool.poolType,
        loadBalancer: pool.loadBalancer ?? null,
        maxSessions: pool.maxSessions ?? null,
        autoscaleEnabled: pool.autoscaleEnabled ?? null,
        startVmOnConnect: pool.startVmOnConnect ?? null,
        validationEnvironment: pool.validationEnvironment ?? null,
        sources: ["demo"],
        subscriptionId: pool.subscriptionId,
        updatedAt: new Date().toISOString(),
        tenantId: pool.tenantId,
        tenantName: pool.tenantName,
      },
      hosts: data()
        .hosts.filter((host) => host.hostPoolId === resourceId)
        .map((host) => ({
          resourceId: host.resourceId,
          name: host.name,
          status: host.status,
          allowNewSession: host.allowNewSession,
          sessions: host.sessions,
          agentVersion: host.agentVersion ?? null,
          osVersion: host.osVersion ?? null,
          lastHeartBeat: host.lastHeartBeat ?? null,
          updateState: host.updateState ?? null,
          source: "demo",
        })),
    });
  },

  host: (poolId, name) => {
    const host = data().hosts.find((candidate) => candidate.hostPoolId === poolId && candidate.name === name);
    const pool = data().pools.find((candidate) => candidate.resourceId === poolId);
    if (!host || !pool) return Promise.reject(new Error("No such session host"));
    const since = Date.now() - 7 * 86_400_000;
    return delay({
      host: {
        resourceId: host.resourceId,
        name: host.name,
        status: host.status,
        allowNewSession: host.allowNewSession,
        sessions: host.sessions,
        agentVersion: host.agentVersion ?? null,
        osVersion: host.osVersion ?? null,
        lastHeartBeat: host.lastHeartBeat ?? null,
        updateState: host.updateState ?? null,
        vmResourceId: host.vmResourceId ?? null,
        source: "demo",
        tenantId: host.tenantId,
        tenantName: pool.tenantName,
        hostPoolId: pool.resourceId,
        hostPoolName: pool.name,
        hostPoolFriendlyName: pool.friendlyName ?? null,
      },
      health: data()
        .hostHealth.filter(
          (row) =>
            row.hostPoolId === poolId && row.sessionHost === name && new Date(row.ts).getTime() > since,
        )
        .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime())
        .slice(0, 500) as unknown as Record<string, unknown>[],
      errors: data()
        .errors.filter((row) => row.hostPoolId === poolId && new Date(row.ts).getTime() > since)
        .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime())
        .slice(0, 50)
        .map((row) => ({ ...row, service_error: row.serviceError })) as unknown as Record<string, unknown>[],
    });
  },

  errorGroups: (days) => {
    const since = Date.now() - days * 86_400_000;
    const groups = new Map<
      string,
      {
        code: string;
        source: string;
        serviceError: boolean;
        hits: number;
        pools: Set<string>;
        tenants: Set<string>;
        lastSeen: string;
        sample: string;
      }
    >();
    for (const row of data().errors) {
      if (new Date(row.ts).getTime() < since) continue;
      const key = `${row.code}|${row.source}`;
      const group = groups.get(key) ?? {
        code: row.code,
        source: row.source,
        serviceError: row.serviceError,
        hits: 0,
        pools: new Set<string>(),
        tenants: new Set<string>(),
        lastSeen: row.ts,
        sample: row.message,
      };
      group.hits += 1;
      if (row.hostPoolId) group.pools.add(row.hostPoolId);
      group.tenants.add(row.tenantId);
      if (row.ts > group.lastSeen) group.lastSeen = row.ts;
      groups.set(key, group);
    }
    return delay({
      groups: [...groups.values()]
        .sort((a, b) => b.hits - a.hits)
        .map((group) => ({
          code: group.code,
          source: group.source,
          serviceError: group.serviceError,
          hits: group.hits,
          pools: group.pools.size,
          tenants: group.tenants.size,
          lastSeen: group.lastSeen,
          sample: group.sample,
        })),
    });
  },

  topUsers: (days) => {
    const since = Date.now() - days * 86_400_000;
    const users = new Map<
      string,
      {
        connections: number;
        failed: number;
        pools: Set<string>;
        connect: number[];
        seconds: number;
        lastSeen: string;
      }
    >();
    for (const row of data().connections) {
      if (new Date(row.ts).getTime() < since) continue;
      const entry = users.get(row.user) ?? {
        connections: 0,
        failed: 0,
        pools: new Set<string>(),
        connect: [],
        seconds: 0,
        lastSeen: row.ts,
      };
      entry.connections += 1;
      if (row.state === "failed") entry.failed += 1;
      if (row.hostPoolId) entry.pools.add(row.hostPoolId);
      if (row.connectMs != null) entry.connect.push(row.connectMs);
      entry.seconds += row.durationSec ?? 0;
      if (row.ts > entry.lastSeen) entry.lastSeen = row.ts;
      users.set(row.user, entry);
    }
    return delay({
      pseudonymized: false,
      users: [...users.entries()]
        .sort((a, b) => b[1].connections - a[1].connections)
        .slice(0, 200)
        .map(([user, entry]) => {
          const sorted = entry.connect.sort((a, b) => a - b);
          return {
            user,
            connections: entry.connections,
            failed: entry.failed,
            pools: entry.pools.size,
            connectP95: sorted.length ? Math.round(sorted[Math.floor(sorted.length * 0.95)] ?? 0) : null,
            hours: entry.seconds / 3600,
            lastSeen: entry.lastSeen,
          };
        }),
    });
  },

  settings: () =>
    delay({
      instance: { name: "DashFlow demo", organizationName: "" },
      runtime: {
        version: "demo",
        commit: "",
        authMode: "dev",
        appRole: "all",
        demoMode: true,
        pseudonymizeUsers: false,
        keyVault: false,
        encryptionKey: false,
        tokenValidation: false,
        allowedTenants: [],
      },
      counts: { connections: 1, customers: data().tenants.length, dashboards: loadDashboards().length },
    }),
  saveSettings: readOnly,

  syncRuns: () =>
    delay({
      runs: ["inventory", "sessions", "logs", "cost"].flatMap((stream, index) =>
        data()
          .tenants.slice(0, 2)
          .map((tenant, tenantIndex) => ({
            id: `${stream}-${tenantIndex}`,
            stream,
            status: "ok" as const,
            startedAt: new Date(Date.now() - (index + 1) * 600_000).toISOString(),
            finishedAt: new Date(Date.now() - (index + 1) * 600_000 + 4200).toISOString(),
            stats: { hostPools: 3, sessionSnapshots: 288, connections: 420 },
            error: null,
            connectionName: "Demo data (synthetic)",
            tenantName: tenant.displayName,
          })),
      ),
      queue: { queued: 0, running: 0, failed: 0 },
    }),
  triggerSync: readOnly,

  users: () =>
    delay([
      {
        id: "demo-user",
        email: "you@demo.dashflow",
        displayName: "Demo visitor",
        disabled: false,
        lastSeenAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        assignments: [
          { id: "demo-assignment", role: "owner" as const, customerTenantId: null, tenantName: null },
        ],
      },
    ]),
  grantRole: readOnly,
  revokeRole: readOnly,
  setDisabled: readOnly,
};

import type {
  DashboardGoal,
  DashboardSpec,
  DashboardTemplate,
  DiagnosticCheck,
  QueryRequest,
  QueryResult,
  Role,
  SyncSchedule,
  WidgetSpec,
} from "@dashflow/core";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly issues?: { path: string; message: string }[],
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: { ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers },
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as {
      error?: string;
      message?: string;
      issues?: { path: string; message: string }[];
    };
    throw new ApiError(
      payload.error ?? payload.message ?? `Request failed (${response.status})`,
      response.status,
      payload.issues,
    );
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

// ─── shapes the API returns ─────────────────────────────────────────────────────

export interface Me {
  user: {
    id: string;
    email: string;
    displayName: string | null;
    role: Role | null;
    tenantScope: string[] | null;
  };
  instance: {
    claimed: boolean;
    authMode: "easyauth" | "dev";
    demoMode: boolean;
    pseudonymizeUsers: boolean;
    canStoreSecrets: boolean;
    canUseKeyVault: boolean;
    connectionCount: number;
  };
  tenants: { id: string; displayName: string; domain: string | null; connectionId: string }[];
}

export interface CatalogMetric {
  id: string;
  label: string;
  description: string;
  category: string;
  unit: string;
  betterWhen: "lower" | "higher" | "neutral";
  viz: WidgetSpec["viz"][];
  dims: string[];
  requires: string | null;
  available: boolean;
}

export interface Catalog {
  metrics: CatalogMetric[];
  dimensions: Record<string, { label: string; short: string }>;
  categories: Record<string, { label: string; description: string }>;
  templates: DashboardTemplate[];
  connectionTypes: Record<string, { label: string; tagline: string; bestFor: string; multiTenant: boolean }>;
  roles: Record<Role, { label: string; description: string }>;
}

export interface ConnectionSummary {
  id: string;
  name: string;
  type: "azure" | "lighthouse" | "partner-center" | "nerdio" | "demo";
  config: Record<string, unknown>;
  schedule: SyncSchedule;
  enabled: boolean;
  status: "new" | "ok" | "degraded" | "error";
  hasSecret: boolean;
  consented: boolean;
  lastTestedAt: string | null;
  lastTest: DiagnosticCheck[] | null;
  lastSyncAt: string | null;
  tenantCount: number;
}

export interface TenantDetail {
  id: string;
  connectionId: string;
  connectionName: string;
  connectionType: string;
  tenantId: string;
  displayName: string;
  domain: string | null;
  enabled: boolean;
  meta: Record<string, unknown> | null;
  subscriptions: { id: string; subscriptionId: string; displayName: string; enabled: boolean }[];
  workspaces: { id: string; name: string; resourceId: string; enabled: boolean; hostPoolIds: string[] }[];
  hostPools: {
    resourceId: string;
    name: string;
    friendlyName: string | null;
    location: string;
    poolType: string;
    maxSessions: number | null;
    autoscaleEnabled: boolean | null;
    sources: string[];
    enabled: boolean;
  }[];
}

export interface HostPoolOption {
  resourceId: string;
  name: string;
  friendlyName: string | null;
  tenantId: string;
  tenantName: string;
  poolType: string;
  location: string;
}

/** A row of raw facts behind a chart point; columns vary by table. */
export type DetailRow = Record<string, string | number | boolean | null>;

export interface ErrorGroup {
  code: string;
  source: string;
  serviceError: boolean;
  hits: number;
  pools: number;
  tenants: number;
  lastSeen: string | null;
  sample: string | null;
}

export interface TopUser {
  user: string;
  connections: number;
  failed: number;
  pools: number;
  connectP95: number | null;
  hours: number;
  lastSeen: string | null;
}

export interface PoolDetail {
  pool: {
    resourceId: string;
    name: string;
    friendlyName: string | null;
    location: string;
    poolType: string;
    loadBalancer: string | null;
    maxSessions: number | null;
    autoscaleEnabled: boolean | null;
    startVmOnConnect: boolean | null;
    validationEnvironment: boolean | null;
    sources: string[];
    subscriptionId: string | null;
    updatedAt: string;
    tenantId: string;
    tenantName: string;
  };
  hosts: {
    resourceId: string;
    name: string;
    status: string;
    allowNewSession: boolean;
    sessions: number;
    agentVersion: string | null;
    osVersion: string | null;
    lastHeartBeat: string | null;
    updateState: string | null;
    source: string;
  }[];
}

export interface HostDetail {
  host: {
    resourceId: string;
    name: string;
    status: string;
    allowNewSession: boolean;
    sessions: number;
    agentVersion: string | null;
    osVersion: string | null;
    lastHeartBeat: string | null;
    updateState: string | null;
    vmResourceId: string | null;
    source: string;
    tenantId: string;
    tenantName: string;
    hostPoolId: string;
    hostPoolName: string;
    hostPoolFriendlyName: string | null;
  };
  health: Record<string, unknown>[];
  errors: Record<string, unknown>[];
}

export interface SettingsPayload {
  instance: { name: string; organizationName: string };
  runtime: {
    version: string;
    commit: string;
    authMode: string;
    appRole: string;
    demoMode: boolean;
    pseudonymizeUsers: boolean;
    keyVault: boolean;
    encryptionKey: boolean;
    tokenValidation: boolean;
    allowedTenants: string[];
  };
  counts: { connections: number; customers: number; dashboards: number };
}

export interface DashboardListItem {
  id: string;
  name: string;
  description: string;
  goal: DashboardGoal;
  widgetCount: number;
  visibility: "private" | "shared";
  sharedWithRole: Role;
  defaultPreset: string;
  tenantScope: string[] | null;
  isOwner: boolean;
  favorite: boolean;
  updatedAt: string;
}

export interface DashboardDetail extends DashboardSpec {
  id: string;
  isOwner: boolean;
  canEdit: boolean;
  favorite: boolean;
  updatedAt: string;
}

export interface SyncRun {
  id: string;
  stream: string;
  status: "running" | "ok" | "partial" | "error";
  startedAt: string;
  finishedAt: string | null;
  stats: Record<string, number> | null;
  error: string | null;
  connectionName: string;
  tenantName: string | null;
}

export interface UserRow {
  id: string;
  email: string;
  displayName: string | null;
  disabled: boolean;
  lastSeenAt: string | null;
  createdAt: string;
  assignments: { id: string; role: Role; customerTenantId: string | null; tenantName: string | null }[];
}

export interface BatchQueryResult {
  results: { key: string; result?: QueryResult; error?: string }[];
}

const httpApi = {
  me: () => request<Me>("/me"),
  claim: (code: string) => post<{ ok: boolean }>("/setup/claim", { code }),
  catalog: () => request<Catalog>("/catalog"),

  connections: () => request<ConnectionSummary[]>("/connections"),
  createConnection: (body: {
    name: string;
    config: Record<string, unknown>;
    secret?: { kind: "none" } | { kind: "inline"; value: string } | { kind: "keyvault"; secretName: string };
    schedule?: Partial<SyncSchedule>;
  }) => post<{ id: string }>("/connections", body),
  updateConnection: (id: string, body: Record<string, unknown>) =>
    request<{ ok: true }>(`/connections/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteConnection: (id: string) => request<{ ok: true }>(`/connections/${id}`, { method: "DELETE" }),
  testConnection: (id: string) => post<{ checks: DiagnosticCheck[] }>(`/connections/${id}/test`),
  discover: (id: string) =>
    post<{ tenants: number; subscriptions: number; workspaces: number; hostPools: number }>(
      `/connections/${id}/discover`,
    ),
  syncConnection: (id: string, backfill = false) =>
    post<{ queued: number }>(`/connections/${id}/sync?backfill=${backfill}`),
  consentUrl: (id: string) => post<{ url: string }>(`/connections/${id}/consent-url`),

  tenants: (connectionId?: string) =>
    request<TenantDetail[]>(`/tenants${connectionId ? `?connectionId=${connectionId}` : ""}`),
  saveSelection: (body: {
    tenants?: { id: string; enabled: boolean }[];
    subscriptions?: { id: string; enabled: boolean }[];
    workspaces?: { id: string; enabled: boolean }[];
    hostPools?: { resourceId: string; enabled: boolean }[];
  }) => post<{ ok: true }>("/tenants/selection", body),
  hostPools: () => request<HostPoolOption[]>("/tenants/host-pools"),

  dashboards: () => request<DashboardListItem[]>("/dashboards"),
  dashboard: (id: string) => request<DashboardDetail>(`/dashboards/${id}`),
  createDashboard: (body: DashboardSpec) => post<{ id: string }>("/dashboards", body),
  createFromTemplate: (body: {
    goal: string;
    name?: string;
    tenantScope: string[] | null;
    defaultPreset: string;
    omit: string[];
  }) => post<{ id: string }>("/dashboards/from-template", body),
  saveDashboard: (id: string, body: DashboardSpec) =>
    request<{ ok: true }>(`/dashboards/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteDashboard: (id: string) => request<{ ok: true }>(`/dashboards/${id}`, { method: "DELETE" }),
  duplicateDashboard: (id: string) => post<{ id: string }>(`/dashboards/${id}/duplicate`),
  setFavorite: (id: string, favorite: boolean) =>
    request<{ ok: true }>(`/dashboards/${id}/favorite`, { method: favorite ? "PUT" : "DELETE" }),

  query: (body: QueryRequest & { tz?: string }) => post<QueryResult>("/query", body),
  queryBatch: (body: { tz: string; queries: ({ key: string } & QueryRequest)[] }) =>
    post<BatchQueryResult>("/query/batch", body),
  detail: (body: {
    metric?: string;
    from: string;
    to: string;
    tenantIds: string[] | null;
    hostPools: string[];
    groupBy?: string;
    groupValue?: string;
    limit?: number;
  }) => post<{ rows: DetailRow[]; pseudonymized: boolean; table?: string }>("/query/detail", body),
  dimensionValues: (metric: string, dim: string) =>
    request<{ values: { value: string; hits: number }[] }>(
      `/query/values?metric=${encodeURIComponent(metric)}&dim=${encodeURIComponent(dim)}`,
    ),

  syncRuns: () =>
    request<{ runs: SyncRun[]; queue: { queued: number; running: number; failed: number } }>("/sync/runs"),
  triggerSync: (body: {
    connectionId: string;
    stream: string;
    backfill?: boolean;
    customerTenantId?: string;
  }) => post<{ queued: number }>("/sync/trigger", body),

  pool: (resourceId: string) => request<PoolDetail>(`/entities/pools/${encodeURIComponent(resourceId)}`),
  host: (poolId: string, name: string) =>
    request<HostDetail>(`/entities/hosts/${encodeURIComponent(poolId)}/${encodeURIComponent(name)}`),
  errorGroups: (days: number) => request<{ groups: ErrorGroup[] }>(`/entities/errors?days=${days}`),
  topUsers: (days: number) =>
    request<{ users: TopUser[]; pseudonymized: boolean }>(`/entities/users?days=${days}`),

  settings: () => request<SettingsPayload>("/settings"),
  saveSettings: (body: { name: string; organizationName: string }) =>
    request<{ ok: true }>("/settings", { method: "PUT", body: JSON.stringify(body) }),

  users: () => request<UserRow[]>("/users"),
  grantRole: (userId: string, body: { role: Role; customerTenantId: string | null }) =>
    post<{ ok: true }>(`/users/${userId}/roles`, body),
  revokeRole: (assignmentId: string) =>
    request<{ ok: true }>(`/users/roles/${assignmentId}`, { method: "DELETE" }),
  setDisabled: (userId: string, disabled: boolean) =>
    post<{ ok: true }>(`/users/${userId}/disabled`, { disabled }),
};

/**
 * The hosted demo ships the same UI with a mock client, so the whole app is clickable with no
 * server. `import.meta.env.VITE_MOCK_API` is replaced at build time, so the branch not taken —
 * and the demo data generator behind it — is dropped from the production bundle.
 */
export const api = (
  import.meta.env.VITE_MOCK_API === "1" ? (await import("./api-mock")).mockApi : httpApi
) as typeof httpApi;

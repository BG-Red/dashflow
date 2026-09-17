/**
 * Normalized AVD records produced by connectors. Connector-specific shapes never
 * leave packages/connectors; the server only persists these.
 * Host pool / session host keys are lowercase ARM resource IDs so Azure and Nerdio data dedupe.
 */

export type DataSource = "azure" | "nerdio" | "demo";

export interface DiscoveredTenant {
  tenantId: string;
  displayName: string;
  domain?: string;
  /** e.g. GDAP relationship status, Lighthouse offer name, Nerdio account id */
  meta?: Record<string, unknown>;
}

export interface DiscoveredSubscription {
  tenantId: string;
  subscriptionId: string;
  displayName: string;
}

export interface DiscoveredWorkspace {
  tenantId: string;
  resourceId: string;
  /** Log Analytics "customerId" used by the query API. */
  workspaceId: string;
  name: string;
  /** Host pool resource IDs whose diagnostics are sent here. */
  hostPoolIds: string[];
}

export interface Discovery {
  tenants: DiscoveredTenant[];
  subscriptions: DiscoveredSubscription[];
  workspaces: DiscoveredWorkspace[];
  hostPoolCount: number;
}

export interface HostPoolRecord {
  resourceId: string;
  tenantId: string;
  subscriptionId: string;
  name: string;
  friendlyName?: string | null;
  location: string;
  poolType: "Pooled" | "Personal" | string;
  loadBalancer?: string | null;
  maxSessions?: number | null;
  startVmOnConnect?: boolean | null;
  validationEnvironment?: boolean | null;
  preferredAppGroupType?: string | null;
  autoscaleEnabled?: boolean | null;
  source: DataSource;
}

export interface SessionHostRecord {
  resourceId: string;
  hostPoolId: string;
  tenantId: string;
  name: string;
  vmResourceId?: string | null;
  status: string;
  allowNewSession: boolean;
  sessions: number;
  agentVersion?: string | null;
  osVersion?: string | null;
  lastHeartBeat?: string | null;
  updateState?: string | null;
  source: DataSource;
}

export interface AppGroupRecord {
  resourceId: string;
  hostPoolId: string | null;
  tenantId: string;
  name: string;
  groupType: string;
  workspaceId?: string | null;
}

export interface ScalingPlanRecord {
  resourceId: string;
  tenantId: string;
  name: string;
  timeZone?: string | null;
  hostPoolIds: string[];
  schedules: number;
}

export interface SessionSnapshotRecord {
  ts: string;
  hostPoolId: string;
  tenantId: string;
  activeSessions: number;
  disconnectedSessions: number;
  capacity: number;
  availableHosts: number;
  totalHosts: number;
}

export interface ConnectionFactRecord {
  correlationId: string;
  tenantId: string;
  hostPoolId: string | null;
  ts: string;
  user: string;
  sessionHost?: string | null;
  clientOs?: string | null;
  clientType?: string | null;
  clientVersion?: string | null;
  gatewayRegion?: string | null;
  state: "connected" | "failed";
  connectMs?: number | null;
  rttMs?: number | null;
  bandwidthKbps?: number | null;
  durationSec?: number | null;
}

export interface ErrorFactRecord {
  key: string;
  ts: string;
  tenantId: string;
  hostPoolId: string | null;
  correlationId?: string | null;
  code: string;
  source: string;
  message: string;
  serviceError: boolean;
}

export interface HostHealthRecord {
  ts: string;
  tenantId: string;
  hostPoolId: string;
  sessionHost: string;
  status: string;
  healthy: boolean;
  drain: boolean;
  sessions: number;
}

export interface PerfRecord {
  ts: string;
  tenantId: string;
  hostPoolId: string | null;
  sessionHost: string;
  cpuPct?: number | null;
  memAvailableMb?: number | null;
}

export interface CostRecord {
  date: string;
  tenantId: string;
  hostPoolId: string | null;
  meterCategory: string;
  cost: number;
  currency: string;
  estimatedSavings?: number | null;
}

export interface AutoscaleEventRecord {
  key: string;
  ts: string;
  tenantId: string;
  hostPoolId: string;
  action: string;
  hostsBefore?: number | null;
  hostsAfter?: number | null;
  detail?: string | null;
}

/** A batch of normalized records. Tenant IDs are Entra tenant GUIDs; the server maps them to rows. */
export interface SyncBatch {
  hostPools?: HostPoolRecord[];
  sessionHosts?: SessionHostRecord[];
  appGroups?: AppGroupRecord[];
  scalingPlans?: ScalingPlanRecord[];
  sessionSnapshots?: SessionSnapshotRecord[];
  hostHealth?: HostHealthRecord[];
  connections?: ConnectionFactRecord[];
  errors?: ErrorFactRecord[];
  perf?: PerfRecord[];
  costs?: CostRecord[];
  autoscaleEvents?: AutoscaleEventRecord[];
}

export type SyncStream = "inventory" | "sessions" | "logs" | "cost";

export function normalizeResourceId(id: string): string {
  return id.trim().toLowerCase().replace(/\/+$/, "");
}

/** Parse /subscriptions/{sub}/resourceGroups/{rg}/... */
export function parseResourceId(id: string): {
  subscriptionId?: string;
  resourceGroup?: string;
  name?: string;
} {
  const parts = id.split("/").filter(Boolean);
  const get = (key: string) => {
    const i = parts.findIndex((p) => p.toLowerCase() === key.toLowerCase());
    return i >= 0 ? parts[i + 1] : undefined;
  };
  return { subscriptionId: get("subscriptions"), resourceGroup: get("resourceGroups"), name: parts.at(-1) };
}

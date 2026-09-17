import { z } from "zod";

/**
 * The metric catalog is the only thing that can turn into SQL. Widgets reference metric
 * and dimension IDs; the server compiles them with these fragments. Nothing a user types
 * ever reaches the query as SQL text — see apps/server/src/query/compile.ts.
 */

export const DIMENSIONS = {
  tenant: { label: "Customer", short: "Customer" },
  hostPool: { label: "Host pool", short: "Pool" },
  poolType: { label: "Pool type", short: "Type" },
  location: { label: "Azure region", short: "Region" },
  sessionHost: { label: "Session host", short: "Host" },
  clientOs: { label: "Client OS", short: "Client OS" },
  clientType: { label: "Client type", short: "Client" },
  gatewayRegion: { label: "Gateway region", short: "Gateway" },
  errorCode: { label: "Error code", short: "Code" },
  errorSource: { label: "Error source", short: "Source" },
  hostStatus: { label: "Host status", short: "Status" },
  meterCategory: { label: "Meter category", short: "Meter" },
} as const;

export type DimensionId = keyof typeof DIMENSIONS;
export const dimensionSchema = z.enum(Object.keys(DIMENSIONS) as [DimensionId, ...DimensionId[]]);

export const VIZ_KINDS = [
  "kpi",
  "line",
  "area",
  "bar",
  "stacked-bar",
  "donut",
  "table",
  "heatmap",
  "host-grid",
] as const;
export const vizSchema = z.enum(VIZ_KINDS);
export type VizKind = z.infer<typeof vizSchema>;

export type MetricUnit = "count" | "sessions" | "ms" | "seconds" | "percent" | "currency" | "hosts";
export type MetricCategory = "usage" | "experience" | "reliability" | "capacity" | "cost";

export interface MetricDef {
  id: string;
  label: string;
  description: string;
  category: MetricCategory;
  unit: MetricUnit;
  /** Lower is better for latency/errors; used for trend colouring. */
  betterWhen: "lower" | "higher" | "neutral";
  /** Physical table (see packages/db/src/schema.ts). Aliased as `f` when compiled. */
  table:
    | "session_snapshots"
    | "connection_facts"
    | "error_facts"
    | "host_health"
    | "perf_hourly"
    | "cost_daily"
    | "autoscale_events";
  tsColumn: string;
  /** Extra row filter, SQL fragment in terms of `f`. */
  where?: string;
  /** Aggregate over rows inside one bucket+group. */
  agg: string;
  /**
   * When set, rows are first aggregated per (bucket, group, innerKey) with `agg`,
   * then combined across innerKey with this. Needed for anything that is a sum across
   * host pools but an average across time (concurrency, capacity).
   */
  innerKey?: string;
  stage2?: "avg" | "max" | "sum";
  /** Dimension → SQL expression. Available aliases: f, hp (host_pools), ct (customer_tenants). */
  dims: Partial<Record<DimensionId, string>>;
  viz: readonly VizKind[];
  /** Only meaningful when a connector of this kind has synced. */
  requires?: "nerdio";
  /** Computed from two other metrics rather than SQL. */
  ratioOf?: { numerator: string; denominator: string; scale?: number };
}

const POOL_DIMS = {
  tenant: "ct.display_name",
  hostPool: "coalesce(hp.friendly_name, hp.name)",
  poolType: "hp.pool_type",
  location: "hp.location",
} as const;

export const METRICS: MetricDef[] = [
  // ─── usage ────────────────────────────────────────────────────────────────────
  {
    id: "sessions.active",
    label: "Active sessions",
    description: "Average number of active sessions, from 5-minute snapshots.",
    category: "usage",
    unit: "sessions",
    betterWhen: "neutral",
    table: "session_snapshots",
    tsColumn: "ts",
    agg: "sum(f.active_sessions)",
    innerKey: "f.ts",
    stage2: "avg",
    dims: POOL_DIMS,
    viz: ["kpi", "line", "area", "bar", "stacked-bar", "heatmap", "table"],
  },
  {
    id: "sessions.peak",
    label: "Peak sessions",
    description: "Highest concurrent session count in the period.",
    category: "usage",
    unit: "sessions",
    betterWhen: "neutral",
    table: "session_snapshots",
    tsColumn: "ts",
    agg: "sum(f.active_sessions)",
    innerKey: "f.ts",
    stage2: "max",
    dims: POOL_DIMS,
    viz: ["kpi", "line", "bar", "table"],
  },
  {
    id: "sessions.disconnected",
    label: "Disconnected sessions",
    description: "Average number of disconnected sessions still holding a host.",
    category: "usage",
    unit: "sessions",
    betterWhen: "lower",
    table: "session_snapshots",
    tsColumn: "ts",
    agg: "sum(f.disconnected_sessions)",
    innerKey: "f.ts",
    stage2: "avg",
    dims: POOL_DIMS,
    viz: ["kpi", "line", "area", "bar", "table"],
  },
  {
    id: "connections.count",
    label: "Connections",
    description: "Number of user connections.",
    category: "usage",
    unit: "count",
    betterWhen: "neutral",
    table: "connection_facts",
    tsColumn: "ts",
    agg: "count(*)",
    dims: {
      ...POOL_DIMS,
      clientOs: "coalesce(nullif(f.client_os, ''), 'Unknown')",
      clientType: "coalesce(nullif(f.client_type, ''), 'Unknown')",
      gatewayRegion: "coalesce(nullif(f.gateway_region, ''), 'Unknown')",
      sessionHost: "coalesce(nullif(f.session_host, ''), 'Unknown')",
    },
    viz: ["kpi", "line", "area", "bar", "stacked-bar", "donut", "heatmap", "table"],
  },
  {
    id: "users.unique",
    label: "Unique users",
    description: "Distinct users who connected.",
    category: "usage",
    unit: "count",
    betterWhen: "neutral",
    table: "connection_facts",
    tsColumn: "ts",
    agg: "count(distinct f.user_key)",
    dims: { ...POOL_DIMS, clientOs: "coalesce(nullif(f.client_os, ''), 'Unknown')" },
    viz: ["kpi", "line", "bar", "table"],
  },
  // ─── experience ───────────────────────────────────────────────────────────────
  {
    id: "connect.p95",
    label: "Time to connect (p95)",
    description: "95th percentile of the time from connection start to connected.",
    category: "experience",
    unit: "ms",
    betterWhen: "lower",
    table: "connection_facts",
    tsColumn: "ts",
    where: "f.connect_ms is not null and f.state = 'connected'",
    agg: "percentile_cont(0.95) within group (order by f.connect_ms)",
    dims: {
      ...POOL_DIMS,
      clientOs: "coalesce(nullif(f.client_os, ''), 'Unknown')",
      clientType: "coalesce(nullif(f.client_type, ''), 'Unknown')",
      gatewayRegion: "coalesce(nullif(f.gateway_region, ''), 'Unknown')",
      sessionHost: "coalesce(nullif(f.session_host, ''), 'Unknown')",
    },
    viz: ["kpi", "line", "bar", "table"],
  },
  {
    id: "connect.median",
    label: "Time to connect (median)",
    description: "Median time from connection start to connected.",
    category: "experience",
    unit: "ms",
    betterWhen: "lower",
    table: "connection_facts",
    tsColumn: "ts",
    where: "f.connect_ms is not null and f.state = 'connected'",
    agg: "percentile_cont(0.5) within group (order by f.connect_ms)",
    dims: {
      ...POOL_DIMS,
      clientOs: "coalesce(nullif(f.client_os, ''), 'Unknown')",
      gatewayRegion: "coalesce(nullif(f.gateway_region, ''), 'Unknown')",
    },
    viz: ["kpi", "line", "bar", "table"],
  },
  {
    id: "rtt.median",
    label: "Round trip time (median)",
    description: "Median estimated round trip time reported by the client.",
    category: "experience",
    unit: "ms",
    betterWhen: "lower",
    table: "connection_facts",
    tsColumn: "ts",
    where: "f.rtt_ms is not null",
    agg: "percentile_cont(0.5) within group (order by f.rtt_ms)",
    dims: {
      ...POOL_DIMS,
      gatewayRegion: "coalesce(nullif(f.gateway_region, ''), 'Unknown')",
      clientOs: "coalesce(nullif(f.client_os, ''), 'Unknown')",
      sessionHost: "coalesce(nullif(f.session_host, ''), 'Unknown')",
    },
    viz: ["kpi", "line", "bar", "table", "heatmap"],
  },
  {
    id: "rtt.p95",
    label: "Round trip time (p95)",
    description: "95th percentile round trip time — the tail users complain about.",
    category: "experience",
    unit: "ms",
    betterWhen: "lower",
    table: "connection_facts",
    tsColumn: "ts",
    where: "f.rtt_ms is not null",
    agg: "percentile_cont(0.95) within group (order by f.rtt_ms)",
    dims: { ...POOL_DIMS, gatewayRegion: "coalesce(nullif(f.gateway_region, ''), 'Unknown')" },
    viz: ["kpi", "line", "bar", "table"],
  },
  {
    id: "session.duration.median",
    label: "Session duration (median)",
    description: "Median length of a completed session.",
    category: "usage",
    unit: "seconds",
    betterWhen: "neutral",
    table: "connection_facts",
    tsColumn: "ts",
    where: "f.duration_sec is not null",
    agg: "percentile_cont(0.5) within group (order by f.duration_sec)",
    dims: POOL_DIMS,
    viz: ["kpi", "line", "bar", "table"],
  },
  // ─── reliability ──────────────────────────────────────────────────────────────
  {
    id: "connections.failed",
    label: "Failed connections",
    description: "Connections that never reached the connected state.",
    category: "reliability",
    unit: "count",
    betterWhen: "lower",
    table: "connection_facts",
    tsColumn: "ts",
    where: "f.state = 'failed'",
    agg: "count(*)",
    dims: {
      ...POOL_DIMS,
      clientOs: "coalesce(nullif(f.client_os, ''), 'Unknown')",
      gatewayRegion: "coalesce(nullif(f.gateway_region, ''), 'Unknown')",
      sessionHost: "coalesce(nullif(f.session_host, ''), 'Unknown')",
    },
    viz: ["kpi", "line", "bar", "stacked-bar", "table"],
  },
  {
    id: "connections.success_rate",
    label: "Connection success rate",
    description: "Share of connections that reached the connected state.",
    category: "reliability",
    unit: "percent",
    betterWhen: "higher",
    table: "connection_facts",
    tsColumn: "ts",
    agg: "100.0 * count(*) filter (where f.state = 'connected') / nullif(count(*), 0)",
    dims: {
      ...POOL_DIMS,
      clientOs: "coalesce(nullif(f.client_os, ''), 'Unknown')",
      gatewayRegion: "coalesce(nullif(f.gateway_region, ''), 'Unknown')",
    },
    viz: ["kpi", "line", "area", "bar", "table"],
  },
  {
    id: "errors.count",
    label: "Errors",
    description: "Errors reported on the AVD control plane and agents.",
    category: "reliability",
    unit: "count",
    betterWhen: "lower",
    table: "error_facts",
    tsColumn: "ts",
    agg: "count(*)",
    dims: {
      ...POOL_DIMS,
      errorCode: "f.code",
      errorSource: "coalesce(nullif(f.source, ''), 'Unknown')",
    },
    viz: ["kpi", "line", "bar", "stacked-bar", "donut", "table"],
  },
  {
    id: "errors.service",
    label: "Service-side errors",
    description: "Errors Microsoft flagged as service errors rather than customer-side.",
    category: "reliability",
    unit: "count",
    betterWhen: "lower",
    table: "error_facts",
    tsColumn: "ts",
    where: "f.service_error",
    agg: "count(*)",
    dims: { ...POOL_DIMS, errorCode: "f.code", errorSource: "coalesce(nullif(f.source, ''), 'Unknown')" },
    viz: ["kpi", "line", "bar", "table"],
  },
  {
    id: "hosts.unhealthy",
    label: "Unhealthy hosts",
    description: "Session hosts not reporting Available.",
    category: "reliability",
    unit: "hosts",
    betterWhen: "lower",
    table: "host_health",
    tsColumn: "ts",
    agg: "count(*) filter (where not f.healthy)",
    innerKey: "f.ts",
    stage2: "avg",
    dims: { ...POOL_DIMS, hostStatus: "f.status", sessionHost: "f.session_host" },
    viz: ["kpi", "line", "bar", "table", "host-grid"],
  },
  {
    id: "hosts.drain",
    label: "Hosts in drain mode",
    description: "Session hosts that are up but not accepting new sessions.",
    category: "reliability",
    unit: "hosts",
    betterWhen: "lower",
    table: "host_health",
    tsColumn: "ts",
    agg: "count(*) filter (where f.drain)",
    innerKey: "f.ts",
    stage2: "avg",
    dims: { ...POOL_DIMS, sessionHost: "f.session_host" },
    viz: ["kpi", "line", "bar", "table"],
  },
  // ─── capacity ─────────────────────────────────────────────────────────────────
  {
    id: "capacity.utilization",
    label: "Capacity utilization",
    description: "Active sessions as a share of the maximum sessions the running hosts allow.",
    category: "capacity",
    unit: "percent",
    betterWhen: "neutral",
    table: "session_snapshots",
    tsColumn: "ts",
    agg: "100.0 * sum(f.active_sessions) / nullif(sum(f.capacity), 0)",
    innerKey: "f.ts",
    stage2: "avg",
    dims: POOL_DIMS,
    viz: ["kpi", "line", "area", "bar", "heatmap", "table"],
  },
  {
    id: "hosts.available",
    label: "Available hosts",
    description: "Average number of session hosts available to take sessions.",
    category: "capacity",
    unit: "hosts",
    betterWhen: "neutral",
    table: "session_snapshots",
    tsColumn: "ts",
    agg: "sum(f.available_hosts)",
    innerKey: "f.ts",
    stage2: "avg",
    dims: POOL_DIMS,
    viz: ["kpi", "line", "area", "bar", "table"],
  },
  {
    id: "sessions.per_host",
    label: "Sessions per host",
    description: "Average active sessions on each available host.",
    category: "capacity",
    unit: "sessions",
    betterWhen: "neutral",
    table: "session_snapshots",
    tsColumn: "ts",
    agg: "sum(f.active_sessions)::numeric / nullif(sum(f.available_hosts), 0)",
    innerKey: "f.ts",
    stage2: "avg",
    dims: POOL_DIMS,
    viz: ["kpi", "line", "bar", "table"],
  },
  {
    id: "cpu.avg",
    label: "CPU average",
    description: "Average processor time across session hosts (needs the Perf table).",
    category: "capacity",
    unit: "percent",
    betterWhen: "lower",
    table: "perf_hourly",
    tsColumn: "ts",
    where: "f.cpu_pct is not null",
    agg: "avg(f.cpu_pct)",
    dims: { ...POOL_DIMS, sessionHost: "f.session_host" },
    viz: ["kpi", "line", "area", "bar", "table", "heatmap"],
  },
  {
    id: "memory.available",
    label: "Available memory",
    description: "Average available megabytes across session hosts (needs the Perf table).",
    category: "capacity",
    unit: "count",
    betterWhen: "higher",
    table: "perf_hourly",
    tsColumn: "ts",
    where: "f.mem_available_mb is not null",
    agg: "avg(f.mem_available_mb)",
    dims: { ...POOL_DIMS, sessionHost: "f.session_host" },
    viz: ["kpi", "line", "bar", "table"],
  },
  // ─── cost ─────────────────────────────────────────────────────────────────────
  {
    id: "cost.total",
    label: "Cost",
    description: "Actual cost of the resource groups that host AVD workloads.",
    category: "cost",
    unit: "currency",
    betterWhen: "lower",
    table: "cost_daily",
    tsColumn: "ts",
    agg: "sum(f.cost)",
    dims: { ...POOL_DIMS, meterCategory: "f.meter_category" },
    viz: ["kpi", "line", "area", "bar", "stacked-bar", "donut", "table"],
  },
  {
    id: "cost.savings",
    label: "Autoscale savings",
    description: "Savings Nerdio attributes to autoscale compared with always-on hosts.",
    category: "cost",
    unit: "currency",
    betterWhen: "higher",
    table: "cost_daily",
    tsColumn: "ts",
    where: "f.estimated_savings is not null",
    agg: "sum(f.estimated_savings)",
    dims: POOL_DIMS,
    viz: ["kpi", "line", "bar", "table"],
    requires: "nerdio",
  },
  {
    id: "cost.per_user",
    label: "Cost per user",
    description: "Cost divided by the number of unique users who connected.",
    category: "cost",
    unit: "currency",
    betterWhen: "lower",
    table: "cost_daily",
    tsColumn: "ts",
    agg: "sum(f.cost)",
    dims: POOL_DIMS,
    viz: ["kpi", "line", "bar", "table"],
    ratioOf: { numerator: "cost.total", denominator: "users.unique" },
  },
  {
    id: "autoscale.actions",
    label: "Autoscale actions",
    description: "Host start, stop, resize and rebuild actions performed by Nerdio autoscale.",
    category: "cost",
    unit: "count",
    betterWhen: "neutral",
    table: "autoscale_events",
    tsColumn: "ts",
    agg: "count(*)",
    dims: { ...POOL_DIMS, errorSource: "f.action" },
    viz: ["kpi", "line", "bar", "stacked-bar", "table"],
    requires: "nerdio",
  },
];

export const METRICS_BY_ID: Record<string, MetricDef> = Object.fromEntries(METRICS.map((m) => [m.id, m]));

export function getMetric(id: string): MetricDef | undefined {
  return METRICS_BY_ID[id];
}

export const CATEGORY_INFO: Record<MetricCategory, { label: string; description: string }> = {
  usage: { label: "Usage", description: "Who is using the environment, and how much." },
  experience: { label: "User experience", description: "How fast and smooth sessions feel." },
  reliability: { label: "Reliability", description: "Failures, errors and host health." },
  capacity: { label: "Capacity", description: "Headroom, utilization and host performance." },
  cost: { label: "Cost", description: "Spend, savings and cost per user." },
};

export function formatUnit(unit: MetricUnit, value: number, currency = "USD"): string {
  if (!Number.isFinite(value)) return "—";
  switch (unit) {
    case "ms":
      return value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${Math.round(value)} ms`;
    case "seconds": {
      const m = Math.round(value / 60);
      return m >= 60 ? `${(m / 60).toFixed(1)} h` : `${m} min`;
    }
    case "percent":
      return `${value.toFixed(value < 10 ? 1 : 0)}%`;
    case "currency":
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency,
        maximumFractionDigits: value < 100 ? 2 : 0,
      }).format(value);
    default:
      return value >= 1000
        ? value.toLocaleString(undefined, { maximumFractionDigits: 0 })
        : value.toLocaleString(undefined, { maximumFractionDigits: value < 10 ? 1 : 0 });
  }
}

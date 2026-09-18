import type { DimensionId, QueryRequest, QueryResult, Series, TimeGrain } from "@dashflow/core";
import { getMetric } from "@dashflow/core";
import type { Dataset } from "./dataset";

/**
 * The metric catalog, evaluated in JavaScript instead of SQL.
 *
 * The hosted demo has no database, so this computes the same numbers over the in-memory
 * dataset. It is deliberately a second implementation rather than a translation: the parity
 * test runs both this and the real SQL engine over identical rows and fails if they disagree,
 * which is the only thing that keeps a demo honest over time.
 */

type Row = Record<string, unknown>;

interface JsMetric {
  rows: (data: Dataset) => Row[];
  ts: (row: Row) => Date;
  where?: (row: Row) => boolean;
  /** Aggregate a group of rows into one number. */
  agg: (rows: Row[]) => number | null;
  /** Two-stage metrics aggregate per inner key first, then combine. */
  innerKey?: (row: Row) => string;
  stage2?: "avg" | "max" | "sum";
  dims: Partial<Record<DimensionId, (row: Row, data: Dataset) => string>>;
  ratioOf?: { numerator: string; denominator: string };
}

// ─── aggregate helpers ──────────────────────────────────────────────────────────

const numbers = (rows: Row[], key: string): number[] =>
  rows
    .map((row) => row[key])
    .filter((value): value is number => typeof value === "number" && !Number.isNaN(value));

const sum = (rows: Row[], key: string): number =>
  numbers(rows, key).reduce((total, value) => total + value, 0);

const avg = (rows: Row[], key: string): number | null => {
  const values = numbers(rows, key);
  return values.length === 0 ? null : values.reduce((total, value) => total + value, 0) / values.length;
};

/**
 * Postgres `percentile_cont`: linear interpolation between the two neighbouring values, which
 * is not the same as picking the nearest rank. Matching it exactly is the point.
 */
const percentile = (rows: Row[], key: string, fraction: number): number | null => {
  const values = numbers(rows, key).sort((a, b) => a - b);
  if (values.length === 0) return null;
  if (values.length === 1) return values[0]!;
  const position = fraction * (values.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return values[lower]!;
  return values[lower]! + (values[upper]! - values[lower]!) * (position - lower);
};

const distinct = (rows: Row[], key: string): number => new Set(rows.map((row) => String(row[key]))).size;

// ─── dimension helpers ──────────────────────────────────────────────────────────

const tenantName = (row: Row, data: Dataset): string =>
  data.tenants.find((tenant) => tenant.id === row.tenantId)?.displayName ?? "Unknown";

const poolName = (row: Row, data: Dataset): string => {
  const pool = data.pools.find((candidate) => candidate.resourceId === row.hostPoolId);
  return pool ? (pool.friendlyName ?? pool.name) : "Unknown";
};

const poolField =
  (field: "poolType" | "location") =>
  (row: Row, data: Dataset): string => {
    const pool = data.pools.find((candidate) => candidate.resourceId === row.hostPoolId);
    return pool ? String(pool[field]) : "Unknown";
  };

const text =
  (key: string, fallback = "Unknown") =>
  (row: Row): string => {
    const value = row[key];
    return value === null || value === undefined || value === "" ? fallback : String(value);
  };

const POOL_DIMS = {
  tenant: tenantName,
  hostPool: poolName,
  poolType: poolField("poolType"),
  location: poolField("location"),
} satisfies JsMetric["dims"];

const CLIENT_DIMS = {
  clientOs: text("clientOs"),
  clientType: text("clientType"),
  gatewayRegion: text("gatewayRegion"),
  sessionHost: text("sessionHost"),
} satisfies JsMetric["dims"];

const ts = (key: string) => (row: Row) => new Date(String(row[key]));

// ─── the catalog, mirrored ──────────────────────────────────────────────────────

export const JS_METRICS: Record<string, JsMetric> = {
  "sessions.active": {
    rows: (data) => data.snapshots as unknown as Row[],
    ts: ts("ts"),
    agg: (rows) => sum(rows, "activeSessions"),
    innerKey: (row) => String(row.ts),
    stage2: "avg",
    dims: POOL_DIMS,
  },
  "sessions.peak": {
    rows: (data) => data.snapshots as unknown as Row[],
    ts: ts("ts"),
    agg: (rows) => sum(rows, "activeSessions"),
    innerKey: (row) => String(row.ts),
    stage2: "max",
    dims: POOL_DIMS,
  },
  "sessions.disconnected": {
    rows: (data) => data.snapshots as unknown as Row[],
    ts: ts("ts"),
    agg: (rows) => sum(rows, "disconnectedSessions"),
    innerKey: (row) => String(row.ts),
    stage2: "avg",
    dims: POOL_DIMS,
  },
  "connections.count": {
    rows: (data) => data.connections as unknown as Row[],
    ts: ts("ts"),
    agg: (rows) => rows.length,
    dims: { ...POOL_DIMS, ...CLIENT_DIMS },
  },
  "users.unique": {
    rows: (data) => data.connections as unknown as Row[],
    ts: ts("ts"),
    agg: (rows) => distinct(rows, "user"),
    dims: { ...POOL_DIMS, clientOs: CLIENT_DIMS.clientOs },
  },
  "connect.p95": {
    rows: (data) => data.connections as unknown as Row[],
    ts: ts("ts"),
    where: (row) => row.connectMs != null && row.state === "connected",
    agg: (rows) => percentile(rows, "connectMs", 0.95),
    dims: { ...POOL_DIMS, ...CLIENT_DIMS },
  },
  "connect.median": {
    rows: (data) => data.connections as unknown as Row[],
    ts: ts("ts"),
    where: (row) => row.connectMs != null && row.state === "connected",
    agg: (rows) => percentile(rows, "connectMs", 0.5),
    dims: { ...POOL_DIMS, clientOs: CLIENT_DIMS.clientOs, gatewayRegion: CLIENT_DIMS.gatewayRegion },
  },
  "rtt.median": {
    rows: (data) => data.connections as unknown as Row[],
    ts: ts("ts"),
    where: (row) => row.rttMs != null,
    agg: (rows) => percentile(rows, "rttMs", 0.5),
    dims: {
      ...POOL_DIMS,
      gatewayRegion: CLIENT_DIMS.gatewayRegion,
      clientOs: CLIENT_DIMS.clientOs,
      sessionHost: CLIENT_DIMS.sessionHost,
    },
  },
  "rtt.p95": {
    rows: (data) => data.connections as unknown as Row[],
    ts: ts("ts"),
    where: (row) => row.rttMs != null,
    agg: (rows) => percentile(rows, "rttMs", 0.95),
    dims: { ...POOL_DIMS, gatewayRegion: CLIENT_DIMS.gatewayRegion },
  },
  "session.duration.median": {
    rows: (data) => data.connections as unknown as Row[],
    ts: ts("ts"),
    where: (row) => row.durationSec != null,
    agg: (rows) => percentile(rows, "durationSec", 0.5),
    dims: POOL_DIMS,
  },
  "connections.failed": {
    rows: (data) => data.connections as unknown as Row[],
    ts: ts("ts"),
    where: (row) => row.state === "failed",
    agg: (rows) => rows.length,
    dims: { ...POOL_DIMS, ...CLIENT_DIMS },
  },
  "connections.success_rate": {
    rows: (data) => data.connections as unknown as Row[],
    ts: ts("ts"),
    agg: (rows) =>
      rows.length === 0 ? null : (100 * rows.filter((row) => row.state === "connected").length) / rows.length,
    dims: { ...POOL_DIMS, clientOs: CLIENT_DIMS.clientOs, gatewayRegion: CLIENT_DIMS.gatewayRegion },
  },
  "errors.count": {
    rows: (data) => data.errors as unknown as Row[],
    ts: ts("ts"),
    agg: (rows) => rows.length,
    dims: { ...POOL_DIMS, errorCode: text("code"), errorSource: text("source") },
  },
  "errors.service": {
    rows: (data) => data.errors as unknown as Row[],
    ts: ts("ts"),
    where: (row) => row.serviceError === true,
    agg: (rows) => rows.length,
    dims: { ...POOL_DIMS, errorCode: text("code"), errorSource: text("source") },
  },
  "hosts.unhealthy": {
    rows: (data) => data.hostHealth as unknown as Row[],
    ts: ts("ts"),
    agg: (rows) => rows.filter((row) => row.healthy === false).length,
    innerKey: (row) => String(row.ts),
    stage2: "avg",
    dims: { ...POOL_DIMS, hostStatus: text("status"), sessionHost: text("sessionHost") },
  },
  "hosts.drain": {
    rows: (data) => data.hostHealth as unknown as Row[],
    ts: ts("ts"),
    agg: (rows) => rows.filter((row) => row.drain === true).length,
    innerKey: (row) => String(row.ts),
    stage2: "avg",
    dims: { ...POOL_DIMS, sessionHost: text("sessionHost") },
  },
  "capacity.utilization": {
    rows: (data) => data.snapshots as unknown as Row[],
    ts: ts("ts"),
    agg: (rows) => {
      const capacity = sum(rows, "capacity");
      return capacity === 0 ? null : (100 * sum(rows, "activeSessions")) / capacity;
    },
    innerKey: (row) => String(row.ts),
    stage2: "avg",
    dims: POOL_DIMS,
  },
  "hosts.available": {
    rows: (data) => data.snapshots as unknown as Row[],
    ts: ts("ts"),
    agg: (rows) => sum(rows, "availableHosts"),
    innerKey: (row) => String(row.ts),
    stage2: "avg",
    dims: POOL_DIMS,
  },
  "sessions.per_host": {
    rows: (data) => data.snapshots as unknown as Row[],
    ts: ts("ts"),
    agg: (rows) => {
      const hosts = sum(rows, "availableHosts");
      return hosts === 0 ? null : sum(rows, "activeSessions") / hosts;
    },
    innerKey: (row) => String(row.ts),
    stage2: "avg",
    dims: POOL_DIMS,
  },
  "cpu.avg": {
    rows: (data) => data.perf as unknown as Row[],
    ts: ts("ts"),
    where: (row) => row.cpuPct != null,
    agg: (rows) => avg(rows, "cpuPct"),
    dims: { ...POOL_DIMS, sessionHost: text("sessionHost") },
  },
  "memory.available": {
    rows: (data) => data.perf as unknown as Row[],
    ts: ts("ts"),
    where: (row) => row.memAvailableMb != null,
    agg: (rows) => avg(rows, "memAvailableMb"),
    dims: { ...POOL_DIMS, sessionHost: text("sessionHost") },
  },
  "cost.total": {
    rows: (data) => data.costs as unknown as Row[],
    ts: (row) => new Date(`${String(row.date)}T00:00:00Z`),
    agg: (rows) => sum(rows, "cost"),
    dims: { ...POOL_DIMS, meterCategory: text("meterCategory") },
  },
  "cost.savings": {
    rows: (data) => data.costs as unknown as Row[],
    ts: (row) => new Date(`${String(row.date)}T00:00:00Z`),
    where: (row) => row.estimatedSavings != null,
    agg: (rows) => sum(rows, "estimatedSavings"),
    dims: POOL_DIMS,
  },
  "cost.per_user": {
    rows: (data) => data.costs as unknown as Row[],
    ts: (row) => new Date(`${String(row.date)}T00:00:00Z`),
    agg: (rows) => sum(rows, "cost"),
    dims: POOL_DIMS,
    ratioOf: { numerator: "cost.total", denominator: "users.unique" },
  },
  "autoscale.actions": {
    rows: () => [],
    ts: ts("ts"),
    agg: (rows) => rows.length,
    dims: POOL_DIMS,
  },
};

// ─── evaluation ─────────────────────────────────────────────────────────────────

function bucketStart(date: Date, grain: TimeGrain): number {
  const copy = new Date(date);
  copy.setUTCMinutes(0, 0, 0);
  if (grain === "day") copy.setUTCHours(0);
  return copy.getTime();
}

function select(metric: JsMetric, data: Dataset, request: QueryRequest): Row[] {
  const from = request.from.getTime();
  const to = request.to.getTime();
  const pools = request.filters.hostPools ?? [];
  const dims = Object.entries(request.filters.dims ?? {});
  const tenants = request.tenantIds;

  return metric.rows(data).filter((row) => {
    const at = metric.ts(row).getTime();
    if (at < from || at >= to) return false;
    if (metric.where && !metric.where(row)) return false;
    if (tenants && tenants.length > 0 && !tenants.includes(String(row.tenantId))) return false;
    if (pools.length > 0 && !pools.includes(String(row.hostPoolId))) return false;
    for (const [dim, values] of dims) {
      if (!values || values.length === 0) continue;
      const accessor = metric.dims[dim as DimensionId];
      if (!accessor) return false;
      if (!values.includes(accessor(row, data))) return false;
    }
    return true;
  });
}

function aggregate(metric: JsMetric, rows: Row[]): number | null {
  if (!metric.innerKey || !metric.stage2) return metric.agg(rows);

  const byInner = new Map<string, Row[]>();
  for (const row of rows) {
    const key = metric.innerKey(row);
    const list = byInner.get(key) ?? [];
    list.push(row);
    byInner.set(key, list);
  }
  const inner = [...byInner.values()]
    .map((group) => metric.agg(group))
    .filter((value): value is number => value !== null);
  if (inner.length === 0) return null;

  switch (metric.stage2) {
    case "max":
      return Math.max(...inner);
    case "sum":
      return inner.reduce((total, value) => total + value, 0);
    default:
      return inner.reduce((total, value) => total + value, 0) / inner.length;
  }
}

function groupRows(
  metric: JsMetric,
  data: Dataset,
  rows: Row[],
  dim: DimensionId | undefined,
): Map<string, Row[]> {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const key = dim ? (metric.dims[dim]?.(row, data) ?? "Unknown") : "total";
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  return groups;
}

function rankValue(metricId: string, values: (number | null)[]): number {
  const definition = getMetric(metricId);
  const clean = values.filter((value): value is number => value !== null);
  if (clean.length === 0) return Number.NEGATIVE_INFINITY;
  if (definition?.stage2 === "max") return Math.max(...clean);
  if (definition && ["percent", "ms", "seconds"].includes(definition.unit)) {
    return clean.reduce((total, value) => total + value, 0) / clean.length;
  }
  return clean.reduce((total, value) => total + value, 0);
}

export function evaluate(data: Dataset, request: QueryRequest): QueryResult {
  const definition = getMetric(request.metric);
  const metric = JS_METRICS[request.metric];
  if (!definition || !metric) throw new Error(`Unknown metric ${request.metric}`);

  const unit = definition.unit;
  const currency = unit === "currency" ? "USD" : undefined;

  if (metric.ratioOf) {
    const numerator = evaluate(data, { ...request, metric: metric.ratioOf.numerator });
    const denominator = evaluate(data, { ...request, metric: metric.ratioOf.denominator });
    if (numerator.kind === "scalar" && denominator.kind === "scalar") {
      const value =
        numerator.value == null || !denominator.value ? null : numerator.value / denominator.value;
      return { kind: "scalar", unit, value, currency };
    }
    if (numerator.kind === "series" && denominator.kind === "series") {
      const denom = new Map<string, number | null>();
      for (const series of denominator.series) {
        for (const point of series.points) denom.set(`${series.name}|${point.ts}`, point.value);
      }
      return {
        kind: "series",
        unit,
        grain: request.grain,
        currency,
        series: numerator.series.map((series) => ({
          name: series.name,
          points: series.points.map((point) => {
            const bottom = denom.get(`${series.name}|${point.ts}`) ?? denom.get(`total|${point.ts}`) ?? null;
            return { ts: point.ts, value: point.value == null || !bottom ? null : point.value / bottom };
          }),
        })),
      };
    }
  }

  const rows = select(metric, data, request);

  switch (request.viz) {
    case "kpi": {
      const value = aggregate(metric, rows);
      const span = request.to.getTime() - request.from.getTime();
      const previousRequest = {
        ...request,
        from: new Date(request.from.getTime() - span),
        to: new Date(request.from.getTime()),
      };
      const previous = request.compare ? aggregate(metric, select(metric, data, previousRequest)) : undefined;
      const sparkGrain: TimeGrain = span > 10 * 86_400_000 ? "day" : "hour";
      const spark = buildSeries(metric, data, rows, { ...request, grain: sparkGrain, groupBy: undefined }, 1);
      return { kind: "scalar", unit, value, previous, spark: spark[0]?.points, currency };
    }
    case "line":
    case "area":
    case "stacked-bar":
      return {
        kind: "series",
        unit,
        grain: request.grain,
        currency,
        series: buildSeries(metric, data, rows, request, request.topN),
      };
    case "bar":
    case "donut":
      return { kind: "breakdown", unit, currency, items: buildBreakdown(metric, data, rows, request) };
    case "table": {
      const items = buildBreakdown(metric, data, rows, request);
      return {
        kind: "table",
        unit,
        currency,
        columns: [
          { key: "name", label: request.groupBy ?? "All" },
          { key: "value", label: definition.label, numeric: true },
        ],
        rows: items,
      };
    }
    case "heatmap": {
      const cells: { day: number; hour: number; value: number }[] = [];
      const byCell = new Map<string, Row[]>();
      for (const row of rows) {
        const at = metric.ts(row);
        const day = (at.getUTCDay() + 6) % 7;
        const hour = at.getUTCHours();
        const key = `${day}|${hour}`;
        const list = byCell.get(key) ?? [];
        list.push(row);
        byCell.set(key, list);
      }
      for (const [key, group] of byCell) {
        const [day, hour] = key.split("|").map(Number);
        const value = aggregate(metric, group);
        if (value !== null) cells.push({ day: day!, hour: hour!, value });
      }
      return { kind: "heatmap", unit, currency, cells };
    }
    case "host-grid": {
      const tenants = request.tenantIds;
      const hosts = data.hosts
        .filter((host) => !tenants || tenants.length === 0 || tenants.includes(host.tenantId))
        .filter(
          (host) =>
            (request.filters.hostPools ?? []).length === 0 ||
            (request.filters.hostPools ?? []).includes(host.hostPoolId),
        )
        .slice(0, 500)
        .map((host) => {
          const pool = data.pools.find((candidate) => candidate.resourceId === host.hostPoolId);
          return {
            name: host.name,
            hostPool: pool ? (pool.friendlyName ?? pool.name) : "—",
            tenant: data.tenants.find((tenant) => tenant.id === host.tenantId)?.displayName ?? "—",
            status: host.status,
            sessions: host.sessions,
            allowNewSession: host.allowNewSession,
            agentVersion: host.agentVersion ?? null,
            lastHeartBeat: host.lastHeartBeat ?? null,
          };
        });
      return { kind: "hosts", hosts };
    }
  }
}

function buildSeries(
  metric: JsMetric,
  data: Dataset,
  rows: Row[],
  request: QueryRequest,
  topN: number,
): Series[] {
  const groups = groupRows(metric, data, rows, request.groupBy);
  const step = request.grain === "day" ? 86_400_000 : 3_600_000;
  const first = bucketStart(request.from, request.grain);
  const last = bucketStart(request.to, request.grain);

  const series: Series[] = [];
  for (const [name, groupRowsList] of groups) {
    const byBucket = new Map<number, Row[]>();
    for (const row of groupRowsList) {
      const bucket = bucketStart(metric.ts(row), request.grain);
      const list = byBucket.get(bucket) ?? [];
      list.push(row);
      byBucket.set(bucket, list);
    }
    const points = [];
    for (let at = first; at <= last; at += step) {
      const group = byBucket.get(at);
      points.push({ ts: new Date(at).toISOString(), value: group ? aggregate(metric, group) : null });
    }
    series.push({ name, points });
  }

  return series
    .sort(
      (a, b) =>
        rankValue(
          request.metric,
          b.points.map((point) => point.value),
        ) -
        rankValue(
          request.metric,
          a.points.map((point) => point.value),
        ),
    )
    .slice(0, topN);
}

function buildBreakdown(
  metric: JsMetric,
  data: Dataset,
  rows: Row[],
  request: QueryRequest,
): { name: string; value: number }[] {
  const groups = groupRows(metric, data, rows, request.groupBy);
  return [...groups.entries()]
    .map(([name, group]) => ({ name, value: aggregate(metric, group) ?? 0 }))
    .sort((a, b) => b.value - a.value)
    .slice(0, request.topN);
}

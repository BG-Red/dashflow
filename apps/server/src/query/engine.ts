import {
  type Access,
  type DimensionId,
  getMetric,
  type MetricDef,
  type QueryRequest,
  type QueryResult,
  type Series,
  scopeTenants,
  type TimeGrain,
} from "@dashflow/core";
import type { Db } from "@dashflow/db";
import { type SQL, sql } from "drizzle-orm";

/**
 * Compiles a validated QueryRequest into one parameterized SQL statement.
 *
 * Only two things ever become SQL text: fragments from the metric catalog (they live in
 * code, not in the database) and a grain keyword from a closed list. Every value a user
 * can influence — time range, tenant ids, host pool ids, dimension filters, top N — is
 * bound as a parameter. That is what keeps dashboard building safe for Analysts.
 */

export class QueryError extends Error {}

const TZ_PATTERN = /^[A-Za-z][A-Za-z0-9_+\-/]{1,63}$/;

export interface QueryOptions {
  tz?: string;
  /** Currency label for cost metrics; resolved from synced data. */
  currency?: string;
}

interface Compiled {
  metric: MetricDef;
  /** naive-local bucket expression, or null for non-time queries */
  where: SQL;
  from: SQL;
}

function grainKeyword(grain: TimeGrain): SQL {
  // closed list → safe to inline
  return sql.raw(grain === "day" ? "'day'" : "'hour'");
}

function intervalFor(grain: TimeGrain): SQL {
  return sql.raw(grain === "day" ? "interval '1 day'" : "interval '1 hour'");
}

function tzOf(opts: QueryOptions): string {
  const tz = opts.tz ?? "UTC";
  if (!TZ_PATTERN.test(tz)) throw new QueryError("Invalid time zone");
  return tz;
}

/**
 * Bind a timestamp as an ISO string with an explicit cast. drizzle's raw `execute` hands
 * parameters straight to postgres.js, which cannot serialize a JS Date there.
 */
function ts(date: Date): SQL {
  return sql`${date.toISOString()}::timestamptz`;
}

/**
 * Build `array[$1, $2]::type[]`. Each element is its own bind parameter: postgres.js cannot
 * infer an array type for a single JS array parameter in raw SQL, and binding element by
 * element keeps user-supplied values as values.
 */
export function arrayParam(values: string[], castTo: "uuid" | "text"): SQL {
  const cast = sql.raw(`::${castTo}[]`);
  if (values.length === 0) return sql`array[]${cast}`;
  return sql`array[${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )}]${cast}`;
}

export function dimensionExpression(metric: MetricDef, dim: DimensionId): SQL {
  const expr = metric.dims[dim];
  if (!expr) throw new QueryError(`Metric ${metric.id} cannot be grouped or filtered by ${dim}`);
  return sql.raw(expr);
}

/** FROM + joins. Facts always carry tenant_id; host_pool_id may be null. */
function buildFrom(metric: MetricDef): SQL {
  return sql`
    from ${sql.raw(metric.table)} f
    join customer_tenants ct on ct.id = f.tenant_id
    left join host_pools hp on hp.resource_id = f.host_pool_id`;
}

function buildWhere(metric: MetricDef, req: QueryRequest, access: Access): SQL {
  const tenants = scopeTenants(access, req.tenantIds);
  const parts: SQL[] = [
    sql`f.${sql.raw(metric.tsColumn)} >= ${ts(req.from)}`,
    sql`f.${sql.raw(metric.tsColumn)} < ${ts(req.to)}`,
    sql`ct.enabled`,
    sql`(hp.resource_id is null or hp.enabled)`,
  ];
  if (metric.where) parts.push(sql`(${sql.raw(metric.where)})`);

  if (tenants !== null) {
    if (tenants.length === 0) return sql`false`; // scoped to nothing → no rows, not all rows
    parts.push(sql`f.tenant_id = any(${arrayParam(tenants, "uuid")})`);
  }
  const pools = req.filters.hostPools;
  if (pools && pools.length > 0) parts.push(sql`f.host_pool_id = any(${arrayParam(pools, "text")})`);

  for (const [dim, values] of Object.entries(req.filters.dims ?? {})) {
    if (!values || values.length === 0) continue;
    parts.push(sql`${dimensionExpression(metric, dim as DimensionId)} = any(${arrayParam(values, "text")})`);
  }
  return sql.join(parts, sql` and `);
}

function compile(metric: MetricDef, req: QueryRequest, access: Access): Compiled {
  return { metric, from: buildFrom(metric), where: buildWhere(metric, req, access) };
}

/** How to combine per-bucket values when ranking groups or totalling a series. */
function rankAgg(metric: MetricDef): SQL {
  if (metric.stage2 === "max") return sql.raw("max");
  if (metric.unit === "percent" || metric.unit === "ms" || metric.unit === "seconds") return sql.raw("avg");
  return sql.raw("sum");
}

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

type Row = Record<string, unknown>;

export async function rowsFrom(db: Db, statement: SQL): Promise<Row[]> {
  const result = await db.execute(statement);
  return (Array.isArray(result) ? result : ((result as { rows?: Row[] }).rows ?? [])) as Row[];
}

// ─── scalar ─────────────────────────────────────────────────────────────────────

async function scalar(db: Db, c: Compiled, _req: QueryRequest, _opts: QueryOptions): Promise<number | null> {
  const { metric } = c;
  const agg = sql.raw(metric.agg);
  if (metric.innerKey && metric.stage2) {
    const statement = sql`
      select ${sql.raw(metric.stage2)}(inner_value) as value from (
        select ${sql.raw(metric.innerKey)} as inner_key, ${agg} as inner_value
        ${c.from}
        where ${c.where}
        group by 1
      ) s`;
    const [row] = await rowsFrom(db, statement);
    return num(row?.value);
  }
  const [row] = await rowsFrom(db, sql`select ${agg} as value ${c.from} where ${c.where}`);
  return num(row?.value);
}

// ─── series ─────────────────────────────────────────────────────────────────────

async function series(
  db: Db,
  c: Compiled,
  req: QueryRequest,
  opts: QueryOptions,
  fill: boolean,
): Promise<Series[]> {
  const { metric } = c;
  const tz = tzOf(opts);
  const grain = grainKeyword(req.grain);
  const agg = sql.raw(metric.agg);
  const group = req.groupBy ? dimensionExpression(metric, req.groupBy) : null;
  const grpSelect = group ? sql`coalesce(${group}::text, 'Unknown')` : sql`'total'::text`;

  const inner = metric.innerKey
    ? sql`
        select date_trunc(${grain}, f.${sql.raw(metric.tsColumn)} at time zone ${tz}) as bucket,
               ${grpSelect} as grp,
               ${sql.raw(metric.innerKey)} as inner_key,
               ${agg} as value
        ${c.from}
        where ${c.where}
        group by 1, 2, 3`
    : sql`
        select date_trunc(${grain}, f.${sql.raw(metric.tsColumn)} at time zone ${tz}) as bucket,
               ${grpSelect} as grp,
               ${agg} as value
        ${c.from}
        where ${c.where}
        group by 1, 2`;

  const staged =
    metric.innerKey && metric.stage2
      ? sql`select bucket, grp, ${sql.raw(metric.stage2)}(value) as value from (${inner}) i group by 1, 2`
      : inner;

  const statement = fill
    ? sql`
        with staged as (${staged}),
        top_groups as (
          select grp from staged group by grp order by ${rankAgg(metric)}(value) desc nulls last limit ${req.topN}
        ),
        buckets as (
          select b as bucket from generate_series(
            date_trunc(${grain}, ${ts(req.from)} at time zone ${tz}),
            date_trunc(${grain}, ${ts(req.to)} at time zone ${tz}),
            ${intervalFor(req.grain)}
          ) as b
        )
        select (b.bucket at time zone ${tz}) as ts, g.grp as grp, s.value as value
        from buckets b
        cross join top_groups g
        left join staged s on s.bucket = b.bucket and s.grp = g.grp
        order by g.grp, b.bucket`
    : sql`
        with staged as (${staged})
        select (bucket at time zone ${tz}) as ts, grp, value from staged order by grp, bucket`;

  const result = await rowsFrom(db, statement);
  const byGroup = new Map<string, Series>();
  for (const row of result) {
    const name = String(row.grp ?? "total");
    let s = byGroup.get(name);
    if (!s) {
      s = { name, points: [] };
      byGroup.set(name, s);
    }
    s.points.push({ ts: new Date(row.ts as string).toISOString(), value: num(row.value) });
  }
  return [...byGroup.values()];
}

// ─── breakdown / table ──────────────────────────────────────────────────────────

async function breakdown(db: Db, c: Compiled, req: QueryRequest): Promise<{ name: string; value: number }[]> {
  const { metric } = c;
  const agg = sql.raw(metric.agg);
  const group = req.groupBy ? dimensionExpression(metric, req.groupBy) : null;
  const grpSelect = group ? sql`coalesce(${group}::text, 'Unknown')` : sql`'total'::text`;

  const statement =
    metric.innerKey && metric.stage2
      ? sql`
          select grp, ${sql.raw(metric.stage2)}(value) as value from (
            select ${grpSelect} as grp, ${sql.raw(metric.innerKey)} as inner_key, ${agg} as value
            ${c.from} where ${c.where} group by 1, 2
          ) i
          group by 1 order by 2 desc nulls last limit ${req.topN}`
      : sql`
          select ${grpSelect} as grp, ${agg} as value
          ${c.from} where ${c.where}
          group by 1 order by 2 desc nulls last limit ${req.topN}`;

  return (await rowsFrom(db, statement))
    .map((row) => ({ name: String(row.grp ?? "Unknown"), value: num(row.value) ?? 0 }))
    .filter((item) => item.name !== "");
}

// ─── heatmap ────────────────────────────────────────────────────────────────────

async function heatmap(
  db: Db,
  c: Compiled,
  _req: QueryRequest,
  opts: QueryOptions,
): Promise<{ day: number; hour: number; value: number }[]> {
  const { metric } = c;
  const tz = tzOf(opts);
  const agg = sql.raw(metric.agg);
  const local = sql`(f.${sql.raw(metric.tsColumn)} at time zone ${tz})`;

  const statement =
    metric.innerKey && metric.stage2
      ? sql`
          select day, hour, ${sql.raw(metric.stage2)}(value) as value from (
            select extract(isodow from ${local})::int - 1 as day,
                   extract(hour from ${local})::int as hour,
                   ${sql.raw(metric.innerKey)} as inner_key,
                   ${agg} as value
            ${c.from} where ${c.where} group by 1, 2, 3
          ) i
          group by 1, 2`
      : sql`
          select extract(isodow from ${local})::int - 1 as day,
                 extract(hour from ${local})::int as hour,
                 ${agg} as value
          ${c.from} where ${c.where} group by 1, 2`;

  return (await rowsFrom(db, statement)).map((row) => ({
    day: Number(row.day),
    hour: Number(row.hour),
    value: num(row.value) ?? 0,
  }));
}

// ─── host grid ──────────────────────────────────────────────────────────────────

async function hostGrid(db: Db, req: QueryRequest, access: Access) {
  const tenants = scopeTenants(access, req.tenantIds);
  const filters: SQL[] = [sql`ct.enabled`, sql`hp.enabled`];
  if (tenants !== null) {
    if (tenants.length === 0) return [];
    filters.push(sql`sh.customer_tenant_id = any(${arrayParam(tenants, "uuid")})`);
  }
  const pools = req.filters.hostPools;
  if (pools && pools.length > 0) filters.push(sql`sh.host_pool_id = any(${arrayParam(pools, "text")})`);

  const result = await rowsFrom(
    db,
    sql`
      select sh.name, coalesce(hp.friendly_name, hp.name) as host_pool, ct.display_name as tenant,
             sh.status, sh.sessions, sh.allow_new_session, sh.agent_version, sh.last_heart_beat
      from session_hosts sh
      join host_pools hp on hp.resource_id = sh.host_pool_id
      join customer_tenants ct on ct.id = sh.customer_tenant_id
      where ${sql.join(filters, sql` and `)}
      order by (sh.status = 'Available') asc, ct.display_name, hp.name, sh.name
      limit 500`,
  );
  return result.map((row) => ({
    name: String(row.name),
    hostPool: String(row.host_pool ?? "—"),
    tenant: String(row.tenant ?? "—"),
    status: String(row.status ?? "Unknown"),
    sessions: Number(row.sessions ?? 0),
    allowNewSession: Boolean(row.allow_new_session),
    agentVersion: (row.agent_version as string | null) ?? null,
    lastHeartBeat: row.last_heart_beat ? new Date(row.last_heart_beat as string).toISOString() : null,
  }));
}

// ─── entry point ────────────────────────────────────────────────────────────────

function sparkGrain(req: QueryRequest): TimeGrain {
  const hours = (req.to.getTime() - req.from.getTime()) / 3600_000;
  return hours > 24 * 10 ? "day" : "hour";
}

function previousRange(req: QueryRequest): QueryRequest {
  const span = req.to.getTime() - req.from.getTime();
  return { ...req, from: new Date(req.from.getTime() - span), to: new Date(req.from.getTime()) };
}

export async function runQuery(
  db: Db,
  req: QueryRequest,
  access: Access,
  opts: QueryOptions = {},
): Promise<QueryResult> {
  const metric = getMetric(req.metric);
  if (!metric) throw new QueryError(`Unknown metric ${req.metric}`);
  if (!metric.viz.includes(req.viz)) throw new QueryError(`${metric.label} cannot be shown as ${req.viz}`);
  if (req.to <= req.from) throw new QueryError("The time range is empty");

  const currency = metric.unit === "currency" ? (opts.currency ?? "USD") : undefined;

  // Ratio metrics are two metrics divided, so the numerator and denominator can come from
  // different tables (cost per user is cost_daily over connection_facts).
  if (metric.ratioOf) {
    return ratioQuery(db, metric, req, access, opts);
  }

  const c = compile(metric, req, access);

  switch (req.viz) {
    case "kpi": {
      const value = await scalar(db, c, req, opts);
      const previous = req.compare
        ? await scalar(db, compile(metric, previousRange(req), access), previousRange(req), opts)
        : undefined;
      const sparkReq = { ...req, grain: sparkGrain(req), groupBy: undefined, topN: 1 };
      const spark = await series(db, compile(metric, sparkReq, access), sparkReq, opts, true);
      return { kind: "scalar", unit: metric.unit, value, previous, spark: spark[0]?.points, currency };
    }
    case "line":
    case "area":
    case "stacked-bar":
      return {
        kind: "series",
        unit: metric.unit,
        grain: req.grain,
        series: await series(db, c, req, opts, true),
        currency,
      };
    case "bar":
    case "donut":
      return { kind: "breakdown", unit: metric.unit, items: await breakdown(db, c, req), currency };
    case "table": {
      const items = await breakdown(db, c, req);
      const label = req.groupBy ?? "total";
      return {
        kind: "table",
        unit: metric.unit,
        columns: [
          { key: "name", label: label === "total" ? "All" : label },
          { key: "value", label: metric.label, numeric: true },
        ],
        rows: items.map((item) => ({ name: item.name, value: item.value })),
        currency,
      };
    }
    case "heatmap":
      return { kind: "heatmap", unit: metric.unit, cells: await heatmap(db, c, req, opts), currency };
    case "host-grid":
      return { kind: "hosts", hosts: await hostGrid(db, req, access) };
  }
}

async function ratioQuery(
  db: Db,
  metric: MetricDef,
  req: QueryRequest,
  access: Access,
  opts: QueryOptions,
): Promise<QueryResult> {
  const numerator = getMetric(metric.ratioOf!.numerator);
  const denominator = getMetric(metric.ratioOf!.denominator);
  if (!numerator || !denominator) throw new QueryError(`Metric ${metric.id} references an unknown metric`);
  const scale = metric.ratioOf!.scale ?? 1;
  const currency = metric.unit === "currency" ? (opts.currency ?? "USD") : undefined;

  const divide = (a: number | null, b: number | null) =>
    a === null || b === null || b === 0 ? null : (a / b) * scale;

  const asReq = (m: MetricDef, r: QueryRequest): QueryRequest => ({
    ...r,
    metric: m.id,
    // Drop group/filter dimensions the other metric does not have.
    groupBy: r.groupBy && m.dims[r.groupBy] ? r.groupBy : undefined,
    filters: {
      hostPools: r.filters.hostPools,
      dims: Object.fromEntries(
        Object.entries(r.filters.dims ?? {}).filter(([dim]) => m.dims[dim as DimensionId] !== undefined),
      ) as QueryRequest["filters"]["dims"],
    },
  });

  switch (req.viz) {
    case "kpi": {
      const [a, b] = await Promise.all([
        scalar(db, compile(numerator, asReq(numerator, req), access), asReq(numerator, req), opts),
        scalar(db, compile(denominator, asReq(denominator, req), access), asReq(denominator, req), opts),
      ]);
      let previous: number | null | undefined;
      if (req.compare) {
        const prev = previousRange(req);
        const [pa, pb] = await Promise.all([
          scalar(db, compile(numerator, asReq(numerator, prev), access), asReq(numerator, prev), opts),
          scalar(db, compile(denominator, asReq(denominator, prev), access), asReq(denominator, prev), opts),
        ]);
        previous = divide(pa, pb);
      }
      return { kind: "scalar", unit: metric.unit, value: divide(a, b), previous, currency };
    }
    case "line":
    case "area":
    case "stacked-bar": {
      const nReq = asReq(numerator, req);
      const dReq = asReq(denominator, req);
      const [ns, ds] = await Promise.all([
        series(db, compile(numerator, nReq, access), nReq, opts, true),
        series(db, compile(denominator, dReq, access), dReq, opts, true),
      ]);
      const denomByGroupTs = new Map<string, number | null>();
      for (const s of ds) for (const p of s.points) denomByGroupTs.set(`${s.name}|${p.ts}`, p.value);
      const combined: Series[] = ns.map((s) => ({
        name: s.name,
        points: s.points.map((p) => ({
          ts: p.ts,
          value: divide(
            p.value,
            denomByGroupTs.get(`${s.name}|${p.ts}`) ?? denomByGroupTs.get(`total|${p.ts}`) ?? null,
          ),
        })),
      }));
      return { kind: "series", unit: metric.unit, grain: req.grain, series: combined, currency };
    }
    default: {
      const nReq = asReq(numerator, req);
      const dReq = asReq(denominator, req);
      const [ni, di] = await Promise.all([
        breakdown(db, compile(numerator, nReq, access), nReq),
        breakdown(db, compile(denominator, dReq, access), dReq),
      ]);
      const denomByName = new Map(di.map((item) => [item.name, item.value]));
      const items = ni
        .map((item) => ({
          name: item.name,
          value: divide(item.value, denomByName.get(item.name) ?? denomByName.get("total") ?? null) ?? 0,
        }))
        .sort((a, b) => b.value - a.value);
      if (req.viz === "table") {
        return {
          kind: "table",
          unit: metric.unit,
          columns: [
            { key: "name", label: req.groupBy ?? "All" },
            { key: "value", label: metric.label, numeric: true },
          ],
          rows: items,
          currency,
        };
      }
      return { kind: "breakdown", unit: metric.unit, items, currency };
    }
  }
}

import { type DimensionId, getMetric, queryRequestSchema, scopeTenants } from "@dashflow/core";
import { schema } from "@dashflow/db";
import { desc, sql } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { requireAccess } from "../auth/access";
import type { AppVariables } from "../auth/middleware";
import type { AppContext } from "../context";
import { arrayParam, dimensionExpression, QueryError, rowsFrom, runQuery } from "../query/engine";

const batchSchema = z.object({
  tz: z.string().max(64).optional(),
  queries: z
    .array(z.object({ key: z.string().max(64) }).and(queryRequestSchema))
    .min(1)
    .max(24),
});

/** Columns worth showing when drilling into each fact table. */
const DETAIL_SHAPES = {
  connection_facts: {
    select: sql`f.ts, ct.display_name as tenant, coalesce(hp.friendly_name, hp.name) as host_pool,
      f.user_key as "user", f.session_host, f.client_os, f.client_type, f.gateway_region,
      f.state, f.connect_ms, f.rtt_ms, f.duration_sec`,
    order: sql`f.ts desc`,
  },
  error_facts: {
    select: sql`f.ts, ct.display_name as tenant, coalesce(hp.friendly_name, hp.name) as host_pool,
      f.code, f.source, f.service_error, f.message, f.correlation_id`,
    order: sql`f.ts desc`,
  },
  session_snapshots: {
    select: sql`f.ts, ct.display_name as tenant, coalesce(hp.friendly_name, hp.name) as host_pool,
      f.active_sessions, f.disconnected_sessions, f.capacity, f.available_hosts, f.total_hosts`,
    order: sql`f.ts desc`,
  },
  host_health: {
    select: sql`f.ts, ct.display_name as tenant, coalesce(hp.friendly_name, hp.name) as host_pool,
      f.session_host, f.status, f.healthy, f.drain, f.sessions`,
    order: sql`f.ts desc`,
  },
  perf_hourly: {
    select: sql`f.ts, ct.display_name as tenant, coalesce(hp.friendly_name, hp.name) as host_pool,
      f.session_host, f.cpu_pct, f.mem_available_mb`,
    order: sql`f.ts desc`,
  },
  cost_daily: {
    select: sql`f.ts, ct.display_name as tenant, coalesce(hp.friendly_name, hp.name) as host_pool,
      f.meter_category, f.cost, f.currency, f.estimated_savings`,
    order: sql`f.ts desc`,
  },
  autoscale_events: {
    select: sql`f.ts, ct.display_name as tenant, coalesce(hp.friendly_name, hp.name) as host_pool,
      f.action, f.hosts_before, f.hosts_after, f.detail`,
    order: sql`f.ts desc`,
  },
} as const;

/** The only path from a dashboard widget to the database. Every widget goes through here. */
export function queryRoutes(ctx: AppContext) {
  const app = new Hono<{ Variables: AppVariables }>();

  const currency = async (): Promise<string> => {
    const [row] = await ctx.db
      .select({ currency: schema.costDaily.currency })
      .from(schema.costDaily)
      .orderBy(desc(schema.costDaily.ts))
      .limit(1);
    return row?.currency ?? "USD";
  };

  app.post("/", async (c) => {
    const access = requireAccess(c.get("user"), "viewer");
    const body = queryRequestSchema.parse(await c.req.json());
    try {
      const result = await runQuery(ctx.db, body, access, {
        tz: c.req.query("tz") ?? undefined,
        currency: await currency(),
      });
      return c.json(result);
    } catch (err) {
      if (err instanceof QueryError) throw new HTTPException(400, { message: err.message });
      throw err;
    }
  });

  /** One round trip for a whole dashboard. */
  app.post("/batch", async (c) => {
    const access = requireAccess(c.get("user"), "viewer");
    const body = batchSchema.parse(await c.req.json());
    const resolvedCurrency = await currency();

    const results = await Promise.all(
      body.queries.map(async ({ key, ...request }) => {
        try {
          const result = await runQuery(ctx.db, request, access, { tz: body.tz, currency: resolvedCurrency });
          return { key, result };
        } catch (err) {
          if (!(err instanceof QueryError)) {
            ctx.log.error({ err: (err as Error).message, metric: request.metric }, "widget query failed");
          }
          return { key, error: (err as Error).message };
        }
      }),
    );
    return c.json({ results });
  });

  /**
   * The rows behind a number. A widget passes its own metric and filters plus whatever the
   * user clicked, and gets back the underlying facts — same tenant scoping and the same
   * parameter discipline as the chart query.
   */
  app.post("/detail", async (c) => {
    const access = requireAccess(c.get("user"), "viewer");
    const body = z
      .object({
        metric: z.string().default("connections.count"),
        from: z.coerce.date(),
        to: z.coerce.date(),
        tenantIds: z.array(z.string().uuid()).nullable().default(null),
        hostPools: z.array(z.string()).default([]),
        /** The dimension the widget was grouped by, plus the value that was clicked. */
        groupBy: z.string().max(40).optional(),
        groupValue: z.string().max(200).optional(),
        limit: z.number().int().min(1).max(2000).default(200),
      })
      .parse(await c.req.json());

    const metric = getMetric(body.metric);
    if (!metric) throw new HTTPException(400, { message: `Unknown metric ${body.metric}` });
    const shape = DETAIL_SHAPES[metric.table as keyof typeof DETAIL_SHAPES];
    if (!shape) throw new HTTPException(400, { message: "This metric has no row-level view." });

    const tenants = scopeTenants(access, body.tenantIds);
    const filters = [
      sql`f.ts >= ${body.from.toISOString()}::timestamptz`,
      sql`f.ts < ${body.to.toISOString()}::timestamptz`,
      sql`ct.enabled`,
    ];
    if (metric.where) filters.push(sql`(${sql.raw(metric.where)})`);
    if (tenants !== null) {
      if (tenants.length === 0) return c.json({ rows: [], pseudonymized: ctx.env.PSEUDONYMIZE_USERS });
      filters.push(sql`f.tenant_id = any(${arrayParam(tenants, "uuid")})`);
    }
    if (body.hostPools.length > 0) {
      filters.push(sql`f.host_pool_id = any(${arrayParam(body.hostPools, "text")})`);
    }
    if (body.groupBy && body.groupValue) {
      try {
        const expression = dimensionExpression(metric, body.groupBy as DimensionId);
        filters.push(sql`${expression} = ${body.groupValue}`);
      } catch (err) {
        if (err instanceof QueryError) throw new HTTPException(400, { message: err.message });
        throw err;
      }
    }

    const rows = await rowsFrom(
      ctx.db,
      sql`
        select ${shape.select}
        from ${sql.raw(metric.table)} f
        join customer_tenants ct on ct.id = f.tenant_id
        left join host_pools hp on hp.resource_id = f.host_pool_id
        where ${sql.join(filters, sql` and `)}
        order by ${shape.order}
        limit ${body.limit}`,
    );

    return c.json({ rows, pseudonymized: ctx.env.PSEUDONYMIZE_USERS, table: metric.table });
  });

  /** Distinct values for a dimension, so filters offer real choices rather than free text. */
  app.get("/values", async (c) => {
    const access = requireAccess(c.get("user"), "viewer");
    const metricId = c.req.query("metric") ?? "";
    const dim = c.req.query("dim") ?? "";
    const metric = getMetric(metricId);
    if (!metric) throw new HTTPException(400, { message: `Unknown metric ${metricId}` });

    let expression: ReturnType<typeof dimensionExpression>;
    try {
      expression = dimensionExpression(metric, dim as DimensionId);
    } catch (err) {
      if (err instanceof QueryError) throw new HTTPException(400, { message: err.message });
      throw err;
    }

    const tenants = scopeTenants(access, null);
    const filters = [sql`ct.enabled`, sql`f.ts > now() - interval '30 days'`];
    if (tenants !== null) {
      if (tenants.length === 0) return c.json({ values: [] });
      filters.push(sql`f.tenant_id = any(${arrayParam(tenants, "uuid")})`);
    }

    const rows = await rowsFrom(
      ctx.db,
      sql`
        select ${expression}::text as value, count(*) as hits
        from ${sql.raw(metric.table)} f
        join customer_tenants ct on ct.id = f.tenant_id
        left join host_pools hp on hp.resource_id = f.host_pool_id
        where ${sql.join(filters, sql` and `)}
        group by 1
        order by 2 desc
        limit 200`,
    );

    return c.json({
      values: rows
        .map((row) => ({ value: String(row.value ?? ""), hits: Number(row.hits ?? 0) }))
        .filter((row) => row.value.length > 0),
    });
  });

  return app;
}

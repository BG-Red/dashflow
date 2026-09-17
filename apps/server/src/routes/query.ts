import { queryRequestSchema } from "@avd/core";
import { schema } from "@avd/db";
import { desc, sql } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { requireAccess } from "../auth/access";
import type { AppVariables } from "../auth/middleware";
import type { AppContext } from "../context";
import { arrayParam, QueryError, runQuery } from "../query/engine";

const batchSchema = z.object({
  tz: z.string().max(64).optional(),
  queries: z
    .array(z.object({ key: z.string().max(64) }).and(queryRequestSchema))
    .min(1)
    .max(24),
});

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

  /** Rows behind a widget, for drill-through and CSV export. */
  app.post("/detail", async (c) => {
    const access = requireAccess(c.get("user"), "viewer");
    const body = z
      .object({
        from: z.coerce.date(),
        to: z.coerce.date(),
        tenantIds: z.array(z.string().uuid()).nullable().default(null),
        hostPools: z.array(z.string()).default([]),
        state: z.enum(["all", "connected", "failed"]).default("all"),
        limit: z.number().int().min(1).max(2000).default(500),
      })
      .parse(await c.req.json());

    const tenants = access.tenantScope === null ? body.tenantIds : (body.tenantIds ?? access.tenantScope);
    const filters = [
      sql`f.ts >= ${body.from.toISOString()}::timestamptz`,
      sql`f.ts < ${body.to.toISOString()}::timestamptz`,
      sql`ct.enabled`,
      ...(tenants && tenants.length > 0 ? [sql`f.tenant_id = any(${arrayParam(tenants, "uuid")})`] : []),
      ...(access.tenantScope !== null && (!tenants || tenants.length === 0) ? [sql`false`] : []),
      ...(body.hostPools.length > 0
        ? [sql`f.host_pool_id = any(${arrayParam(body.hostPools, "text")})`]
        : []),
      ...(body.state !== "all" ? [sql`f.state = ${body.state}`] : []),
    ];

    const result = await ctx.db.execute(sql`
      select f.ts, ct.display_name as tenant, coalesce(hp.friendly_name, hp.name) as host_pool,
             f.user_key, f.session_host, f.client_os, f.client_type, f.gateway_region,
             f.state, f.connect_ms, f.rtt_ms, f.duration_sec
      from connection_facts f
      join customer_tenants ct on ct.id = f.tenant_id
      left join host_pools hp on hp.resource_id = f.host_pool_id
      where ${sql.join(filters, sql` and `)}
      order by f.ts desc
      limit ${body.limit}`);

    const rows = (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as Record<
      string,
      unknown
    >[];
    return c.json({ rows, pseudonymized: ctx.env.PSEUDONYMIZE_USERS });
  });

  return app;
}

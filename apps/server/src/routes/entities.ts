import { scopeTenants } from "@dashflow/core";
import { schema } from "@dashflow/db";
import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireAccess } from "../auth/access";
import type { AppVariables } from "../auth/middleware";
import type { AppContext } from "../context";
import { arrayParam, rowsFrom } from "../query/engine";

/**
 * Lookups for the detail pages — one host pool, one session host, the error catalogue, the
 * busiest users. Anything chartable on those pages still goes through the metric engine; these
 * routes only answer "what is this thing, and what is around it".
 */
export function entityRoutes(ctx: AppContext) {
  const app = new Hono<{ Variables: AppVariables }>();

  /** Tenant scope as a SQL fragment, or null when the user may see nothing. */
  const tenantFilter = (tenants: string[] | null, column: string) => {
    if (tenants === null) return sql`true`;
    if (tenants.length === 0) return null;
    return sql`${sql.raw(column)} = any(${arrayParam(tenants, "uuid")})`;
  };

  app.get("/pools/:id", async (c) => {
    const access = requireAccess(c.get("user"), "viewer");
    const resourceId = decodeURIComponent(c.req.param("id")).toLowerCase();
    const allowed = scopeTenants(access, null);

    const pool = await ctx.db
      .select({
        resourceId: schema.hostPools.resourceId,
        name: schema.hostPools.name,
        friendlyName: schema.hostPools.friendlyName,
        location: schema.hostPools.location,
        poolType: schema.hostPools.poolType,
        loadBalancer: schema.hostPools.loadBalancer,
        maxSessions: schema.hostPools.maxSessions,
        autoscaleEnabled: schema.hostPools.autoscaleEnabled,
        startVmOnConnect: schema.hostPools.startVmOnConnect,
        validationEnvironment: schema.hostPools.validationEnvironment,
        sources: schema.hostPools.sources,
        subscriptionId: schema.hostPools.subscriptionId,
        updatedAt: schema.hostPools.updatedAt,
        tenantId: schema.hostPools.customerTenantId,
        tenantName: schema.customerTenants.displayName,
      })
      .from(schema.hostPools)
      .innerJoin(schema.customerTenants, eq(schema.customerTenants.id, schema.hostPools.customerTenantId))
      .where(eq(schema.hostPools.resourceId, resourceId))
      .limit(1);

    const row = pool[0];
    if (!row) throw new HTTPException(404, { message: "No such host pool" });
    if (allowed !== null && !allowed.includes(row.tenantId)) {
      // Same answer as a pool that does not exist — scope is not a hint.
      throw new HTTPException(404, { message: "No such host pool" });
    }

    const hosts = await ctx.db
      .select({
        resourceId: schema.sessionHosts.resourceId,
        name: schema.sessionHosts.name,
        status: schema.sessionHosts.status,
        allowNewSession: schema.sessionHosts.allowNewSession,
        sessions: schema.sessionHosts.sessions,
        agentVersion: schema.sessionHosts.agentVersion,
        osVersion: schema.sessionHosts.osVersion,
        lastHeartBeat: schema.sessionHosts.lastHeartBeat,
        updateState: schema.sessionHosts.updateState,
        source: schema.sessionHosts.source,
      })
      .from(schema.sessionHosts)
      .where(eq(schema.sessionHosts.hostPoolId, resourceId));

    return c.json({ pool: row, hosts });
  });

  app.get("/hosts/:pool/:name", async (c) => {
    const access = requireAccess(c.get("user"), "viewer");
    const hostPoolId = decodeURIComponent(c.req.param("pool")).toLowerCase();
    const name = decodeURIComponent(c.req.param("name"));
    const allowed = scopeTenants(access, null);

    const [host] = await ctx.db
      .select({
        resourceId: schema.sessionHosts.resourceId,
        name: schema.sessionHosts.name,
        status: schema.sessionHosts.status,
        allowNewSession: schema.sessionHosts.allowNewSession,
        sessions: schema.sessionHosts.sessions,
        agentVersion: schema.sessionHosts.agentVersion,
        osVersion: schema.sessionHosts.osVersion,
        lastHeartBeat: schema.sessionHosts.lastHeartBeat,
        updateState: schema.sessionHosts.updateState,
        vmResourceId: schema.sessionHosts.vmResourceId,
        source: schema.sessionHosts.source,
        tenantId: schema.sessionHosts.customerTenantId,
        tenantName: schema.customerTenants.displayName,
        hostPoolId: schema.sessionHosts.hostPoolId,
        hostPoolName: schema.hostPools.name,
        hostPoolFriendlyName: schema.hostPools.friendlyName,
      })
      .from(schema.sessionHosts)
      .innerJoin(schema.customerTenants, eq(schema.customerTenants.id, schema.sessionHosts.customerTenantId))
      .innerJoin(schema.hostPools, eq(schema.hostPools.resourceId, schema.sessionHosts.hostPoolId))
      .where(and(eq(schema.sessionHosts.hostPoolId, hostPoolId), eq(schema.sessionHosts.name, name)))
      .limit(1);

    if (!host) throw new HTTPException(404, { message: "No such session host" });
    if (allowed !== null && !allowed.includes(host.tenantId)) {
      throw new HTTPException(404, { message: "No such session host" });
    }

    const [health, errors] = await Promise.all([
      rowsFrom(
        ctx.db,
        sql`
          select ts, status, healthy, drain, sessions
          from host_health
          where host_pool_id = ${hostPoolId} and session_host = ${name} and ts > now() - interval '7 days'
          order by ts desc
          limit 500`,
      ),
      rowsFrom(
        ctx.db,
        sql`
          select ts, code, source, service_error, message
          from error_facts
          where host_pool_id = ${hostPoolId} and ts > now() - interval '7 days'
          order by ts desc
          limit 50`,
      ),
    ]);

    return c.json({ host, health, errors });
  });

  /** The error catalogue: what is failing, how often, where, and when it last happened. */
  app.get("/errors", async (c) => {
    const access = requireAccess(c.get("user"), "viewer");
    const days = Math.min(90, Math.max(1, Number(c.req.query("days") ?? 7)));
    const allowed = scopeTenants(access, null);
    const scope = tenantFilter(allowed, "f.tenant_id");
    if (!scope) return c.json({ groups: [] });

    const groups = await rowsFrom(
      ctx.db,
      sql`
        select f.code,
               coalesce(nullif(f.source, ''), 'Unknown') as source,
               bool_or(f.service_error) as service_error,
               count(*) as hits,
               count(distinct f.host_pool_id) as pools,
               count(distinct f.tenant_id) as tenants,
               max(f.ts) as last_seen,
               (array_agg(f.message order by f.ts desc))[1] as sample
        from error_facts f
        join customer_tenants ct on ct.id = f.tenant_id
        where ct.enabled
          and f.ts > now() - ${sql.raw(`interval '${days} days'`)}
          and ${scope}
        group by 1, 2
        order by hits desc
        limit 200`,
    );

    return c.json({
      groups: groups.map((row) => ({
        code: String(row.code),
        source: String(row.source),
        serviceError: Boolean(row.service_error),
        hits: Number(row.hits),
        pools: Number(row.pools),
        tenants: Number(row.tenants),
        lastSeen: row.last_seen ? new Date(row.last_seen as string).toISOString() : null,
        sample: row.sample ? String(row.sample).slice(0, 300) : null,
      })),
    });
  });

  /** Busiest users. Honours pseudonymization: the key is whatever was stored. */
  app.get("/users", async (c) => {
    const access = requireAccess(c.get("user"), "viewer");
    const days = Math.min(90, Math.max(1, Number(c.req.query("days") ?? 7)));
    const allowed = scopeTenants(access, null);
    const scope = tenantFilter(allowed, "f.tenant_id");
    if (!scope) return c.json({ users: [], pseudonymized: ctx.env.PSEUDONYMIZE_USERS });

    const users = await rowsFrom(
      ctx.db,
      sql`
        select f.user_key,
               count(*) as connections,
               count(*) filter (where f.state = 'failed') as failed,
               count(distinct f.host_pool_id) as pools,
               round(percentile_cont(0.95) within group (order by f.connect_ms))::int as connect_p95,
               sum(coalesce(f.duration_sec, 0)) as seconds,
               max(f.ts) as last_seen
        from connection_facts f
        join customer_tenants ct on ct.id = f.tenant_id
        where ct.enabled
          and f.ts > now() - ${sql.raw(`interval '${days} days'`)}
          and ${scope}
        group by 1
        order by connections desc
        limit 200`,
    );

    return c.json({
      pseudonymized: ctx.env.PSEUDONYMIZE_USERS,
      users: users.map((row) => ({
        user: String(row.user_key),
        connections: Number(row.connections),
        failed: Number(row.failed),
        pools: Number(row.pools),
        connectP95: row.connect_p95 == null ? null : Number(row.connect_p95),
        hours: Number(row.seconds ?? 0) / 3600,
        lastSeen: row.last_seen ? new Date(row.last_seen as string).toISOString() : null,
      })),
    });
  });

  return app;
}

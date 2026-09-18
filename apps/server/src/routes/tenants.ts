import { scopeTenants } from "@dashflow/core";
import { schema } from "@dashflow/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { requireAccess } from "../auth/access";
import type { AppVariables } from "../auth/middleware";
import type { AppContext } from "../context";

/** Customers, their subscriptions, workspaces and host pools — the "what do we sync" screen. */
export function tenantRoutes(ctx: AppContext) {
  const app = new Hono<{ Variables: AppVariables }>();

  app.get("/", async (c) => {
    const access = requireAccess(c.get("user"), "viewer");
    const connectionId = c.req.query("connectionId");

    const tenants = await ctx.db
      .select({
        id: schema.customerTenants.id,
        connectionId: schema.customerTenants.connectionId,
        tenantId: schema.customerTenants.tenantId,
        displayName: schema.customerTenants.displayName,
        domain: schema.customerTenants.domain,
        enabled: schema.customerTenants.enabled,
        meta: schema.customerTenants.meta,
        connectionName: schema.connections.name,
        connectionType: schema.connections.type,
      })
      .from(schema.customerTenants)
      .innerJoin(schema.connections, eq(schema.connections.id, schema.customerTenants.connectionId))
      .where(connectionId ? eq(schema.customerTenants.connectionId, connectionId) : sql`true`);

    const allowed = scopeTenants(access, null);
    const visible = allowed === null ? tenants : tenants.filter((tenant) => allowed.includes(tenant.id));
    if (visible.length === 0) return c.json([]);

    const ids = visible.map((tenant) => tenant.id);
    const [subs, workspaces, pools] = await Promise.all([
      ctx.db.select().from(schema.subscriptions).where(inArray(schema.subscriptions.customerTenantId, ids)),
      ctx.db
        .select()
        .from(schema.logAnalyticsWorkspaces)
        .where(inArray(schema.logAnalyticsWorkspaces.customerTenantId, ids)),
      ctx.db
        .select({
          resourceId: schema.hostPools.resourceId,
          customerTenantId: schema.hostPools.customerTenantId,
          name: schema.hostPools.name,
          friendlyName: schema.hostPools.friendlyName,
          location: schema.hostPools.location,
          poolType: schema.hostPools.poolType,
          maxSessions: schema.hostPools.maxSessions,
          autoscaleEnabled: schema.hostPools.autoscaleEnabled,
          sources: schema.hostPools.sources,
          enabled: schema.hostPools.enabled,
        })
        .from(schema.hostPools)
        .where(inArray(schema.hostPools.customerTenantId, ids)),
    ]);

    return c.json(
      visible.map((tenant) => ({
        ...tenant,
        subscriptions: subs.filter((s) => s.customerTenantId === tenant.id),
        workspaces: workspaces.filter((w) => w.customerTenantId === tenant.id),
        hostPools: pools.filter((p) => p.customerTenantId === tenant.id),
      })),
    );
  });

  /** Turn customers, subscriptions, workspaces or pools on and off for syncing. */
  app.post("/selection", async (c) => {
    requireAccess(c.get("user"), "admin");
    const body = z
      .object({
        tenants: z.array(z.object({ id: z.string().uuid(), enabled: z.boolean() })).default([]),
        subscriptions: z.array(z.object({ id: z.string().uuid(), enabled: z.boolean() })).default([]),
        workspaces: z.array(z.object({ id: z.string().uuid(), enabled: z.boolean() })).default([]),
        hostPools: z.array(z.object({ resourceId: z.string(), enabled: z.boolean() })).default([]),
      })
      .parse(await c.req.json());

    for (const item of body.tenants) {
      await ctx.db
        .update(schema.customerTenants)
        .set({ enabled: item.enabled })
        .where(eq(schema.customerTenants.id, item.id));
    }
    for (const item of body.subscriptions) {
      await ctx.db
        .update(schema.subscriptions)
        .set({ enabled: item.enabled })
        .where(eq(schema.subscriptions.id, item.id));
    }
    for (const item of body.workspaces) {
      await ctx.db
        .update(schema.logAnalyticsWorkspaces)
        .set({ enabled: item.enabled })
        .where(eq(schema.logAnalyticsWorkspaces.id, item.id));
    }
    for (const item of body.hostPools) {
      await ctx.db
        .update(schema.hostPools)
        .set({ enabled: item.enabled })
        .where(eq(schema.hostPools.resourceId, item.resourceId));
    }
    return c.json({ ok: true });
  });

  /** Host pools the signed-in user may filter by, for the dashboard scope picker. */
  app.get("/host-pools", async (c) => {
    const access = requireAccess(c.get("user"), "viewer");
    const allowed = scopeTenants(access, null);
    const rows = await ctx.db
      .select({
        resourceId: schema.hostPools.resourceId,
        name: schema.hostPools.name,
        friendlyName: schema.hostPools.friendlyName,
        tenantId: schema.hostPools.customerTenantId,
        tenantName: schema.customerTenants.displayName,
        poolType: schema.hostPools.poolType,
        location: schema.hostPools.location,
      })
      .from(schema.hostPools)
      .innerJoin(schema.customerTenants, eq(schema.customerTenants.id, schema.hostPools.customerTenantId))
      .where(
        and(
          eq(schema.hostPools.enabled, true),
          eq(schema.customerTenants.enabled, true),
          allowed === null ? sql`true` : inArray(schema.hostPools.customerTenantId, allowed),
        ),
      );
    return c.json(rows);
  });

  return app;
}

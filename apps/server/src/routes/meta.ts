import {
  CATEGORY_INFO,
  CONNECTION_TYPE_INFO,
  DASHBOARD_TEMPLATES,
  DIMENSIONS,
  METRICS,
  ROLE_INFO,
} from "@dashflow/core";
import { schema } from "@dashflow/db";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { resolveAccess } from "../auth/access";
import { claimOwnership, isClaimed } from "../auth/bootstrap";
import type { AppVariables } from "../auth/middleware";
import type { AppContext } from "../context";

/** Everything the web app needs to render itself: who am I, what can I see, what exists. */
export function metaRoutes(ctx: AppContext) {
  const app = new Hono<{ Variables: AppVariables }>();

  app.get("/me", async (c) => {
    const user = c.get("user");
    const claimed = await isClaimed(ctx.db);
    const tenants = user.access
      ? await ctx.db
          .select({
            id: schema.customerTenants.id,
            displayName: schema.customerTenants.displayName,
            domain: schema.customerTenants.domain,
            connectionId: schema.customerTenants.connectionId,
          })
          .from(schema.customerTenants)
          .where(eq(schema.customerTenants.enabled, true))
      : [];

    const visible =
      user.access?.tenantScope === null
        ? tenants
        : tenants.filter((tenant) => user.access!.tenantScope!.includes(tenant.id));

    const connectionCount = user.access
      ? (await ctx.db.select({ id: schema.connections.id }).from(schema.connections)).length
      : 0;

    return c.json({
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        role: user.access?.role ?? null,
        tenantScope: user.access?.tenantScope ?? null,
      },
      instance: {
        claimed,
        authMode: ctx.env.AUTH_MODE,
        demoMode: ctx.env.DEMO_MODE,
        pseudonymizeUsers: ctx.env.PSEUDONYMIZE_USERS,
        canStoreSecrets: ctx.secrets.canEncrypt,
        canUseKeyVault: ctx.secrets.canUseKeyVault,
        connectionCount,
      },
      tenants: visible,
    });
  });

  /** First-run: turn the one-time code from the container logs into an owner. */
  app.post("/setup/claim", async (c) => {
    const user = c.get("user");
    const principal = c.get("principal");
    const body = await c.req.json<{ code?: string }>().catch(() => ({ code: "" }));
    const result = await claimOwnership(ctx.db, {
      userId: user.id,
      code: body.code ?? "",
      principal,
      allowedOids: ctx.env.BOOTSTRAP_OWNER_OIDS,
    });
    if (!result.ok) return c.json({ error: result.reason }, 400);
    ctx.log.info({ email: user.email }, "instance ownership claimed");
    const access = await resolveAccess(ctx.db, user.id);
    return c.json({ ok: true, access });
  });

  /** The metric catalog, templates and enum labels — the guided builder is driven by this. */
  app.get("/catalog", async (c) => {
    const nerdioConnections = await ctx.db
      .select({ id: schema.connections.id })
      .from(schema.connections)
      .where(and(eq(schema.connections.type, "nerdio"), eq(schema.connections.enabled, true)));

    return c.json({
      metrics: METRICS.map((metric) => ({
        id: metric.id,
        label: metric.label,
        description: metric.description,
        category: metric.category,
        unit: metric.unit,
        betterWhen: metric.betterWhen,
        viz: metric.viz,
        dims: Object.keys(metric.dims),
        requires: metric.requires ?? null,
        available: metric.requires !== "nerdio" || nerdioConnections.length > 0,
      })),
      dimensions: DIMENSIONS,
      categories: CATEGORY_INFO,
      templates: DASHBOARD_TEMPLATES,
      connectionTypes: CONNECTION_TYPE_INFO,
      roles: ROLE_INFO,
    });
  });

  return app;
}

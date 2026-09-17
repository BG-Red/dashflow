import { dashboardSchema, hasRole, type Role, roleRank, templateFor } from "@avd/core";
import { schema } from "@avd/db";
import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { requireAccess } from "../auth/access";
import type { AppVariables } from "../auth/middleware";
import type { AppContext } from "../context";

type DashboardRow = typeof schema.dashboards.$inferSelect;

/** A dashboard is visible if you own it, or it is shared with your role or below. */
function canRead(row: DashboardRow, userId: string, role: Role): boolean {
  if (row.ownerId === userId) return true;
  if (row.visibility !== "shared") return false;
  return roleRank(role) >= roleRank(row.sharedWithRole);
}

function canWrite(row: DashboardRow, userId: string, role: Role): boolean {
  return row.ownerId === userId || hasRole(role, "admin");
}

export function dashboardRoutes(ctx: AppContext) {
  const app = new Hono<{ Variables: AppVariables }>();

  app.get("/", async (c) => {
    const user = c.get("user");
    const access = requireAccess(user, "viewer");
    const rows = await ctx.db.select().from(schema.dashboards).orderBy(desc(schema.dashboards.updatedAt));
    return c.json(
      rows
        .filter((row) => canRead(row, user.id, access.role))
        .map((row) => ({
          id: row.id,
          name: row.name,
          description: row.description,
          goal: row.goal,
          widgetCount: row.widgets.length,
          visibility: row.visibility,
          sharedWithRole: row.sharedWithRole,
          defaultPreset: row.defaultPreset,
          tenantScope: row.tenantScope,
          isOwner: row.ownerId === user.id,
          updatedAt: row.updatedAt,
        })),
    );
  });

  app.get("/:id", async (c) => {
    const user = c.get("user");
    const access = requireAccess(user, "viewer");
    const row = await ctx.db.query.dashboards.findFirst({
      where: eq(schema.dashboards.id, c.req.param("id")),
    });
    if (!row || !canRead(row, user.id, access.role))
      throw new HTTPException(404, { message: "No such dashboard" });
    return c.json({ ...row, isOwner: row.ownerId === user.id, canEdit: canWrite(row, user.id, access.role) });
  });

  app.post("/", async (c) => {
    const user = c.get("user");
    requireAccess(user, "analyst");
    const body = dashboardSchema.parse(await c.req.json());
    const [row] = await ctx.db
      .insert(schema.dashboards)
      .values({
        name: body.name,
        description: body.description,
        goal: body.goal,
        widgets: body.widgets,
        defaultPreset: body.defaultPreset,
        tenantScope: body.tenantScope,
        visibility: body.visibility,
        sharedWithRole: body.sharedWithRole,
        ownerId: user.id,
      })
      .returning({ id: schema.dashboards.id });
    return c.json({ id: row!.id }, 201);
  });

  /** Build a dashboard from a template — the last step of the guided builder. */
  app.post("/from-template", async (c) => {
    const user = c.get("user");
    requireAccess(user, "analyst");
    const body = z
      .object({
        goal: z.string(),
        name: z.string().min(1).max(120).optional(),
        tenantScope: z.array(z.string().uuid()).nullable().default(null),
        defaultPreset: z.enum(["24h", "7d", "30d", "90d"]).default("7d"),
        /** Widget ids the user unchecked in the preview step. */
        omit: z.array(z.string()).default([]),
      })
      .parse(await c.req.json());

    const template = templateFor(body.goal as never);
    if (!template) throw new HTTPException(400, { message: "No such template" });

    const widgets = template.widgets.filter((widget) => !body.omit.includes(widget.id));
    const [row] = await ctx.db
      .insert(schema.dashboards)
      .values({
        name: body.name ?? template.name,
        description: template.description,
        goal: template.goal,
        widgets,
        defaultPreset: body.defaultPreset,
        tenantScope: body.tenantScope,
        visibility: "private",
        sharedWithRole: "viewer",
        ownerId: user.id,
      })
      .returning({ id: schema.dashboards.id });
    return c.json({ id: row!.id }, 201);
  });

  app.put("/:id", async (c) => {
    const user = c.get("user");
    const access = requireAccess(user, "analyst");
    const id = c.req.param("id");
    const row = await ctx.db.query.dashboards.findFirst({ where: eq(schema.dashboards.id, id) });
    if (!row) throw new HTTPException(404, { message: "No such dashboard" });
    if (!canWrite(row, user.id, access.role)) {
      throw new HTTPException(403, { message: "Only the owner or an admin can change this dashboard." });
    }
    const body = dashboardSchema.parse(await c.req.json());
    await ctx.db
      .update(schema.dashboards)
      .set({
        name: body.name,
        description: body.description,
        goal: body.goal,
        widgets: body.widgets,
        defaultPreset: body.defaultPreset,
        tenantScope: body.tenantScope,
        visibility: body.visibility,
        sharedWithRole: body.sharedWithRole,
        updatedAt: new Date(),
      })
      .where(eq(schema.dashboards.id, id));
    return c.json({ ok: true });
  });

  app.delete("/:id", async (c) => {
    const user = c.get("user");
    const access = requireAccess(user, "analyst");
    const row = await ctx.db.query.dashboards.findFirst({
      where: eq(schema.dashboards.id, c.req.param("id")),
    });
    if (!row) throw new HTTPException(404, { message: "No such dashboard" });
    if (!canWrite(row, user.id, access.role))
      throw new HTTPException(403, { message: "Not yours to delete." });
    await ctx.db.delete(schema.dashboards).where(eq(schema.dashboards.id, row.id));
    return c.json({ ok: true });
  });

  return app;
}

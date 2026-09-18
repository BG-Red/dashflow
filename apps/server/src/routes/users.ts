import { roleSchema } from "@dashflow/core";
import { schema } from "@dashflow/db";
import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { grantRole, requireAccess } from "../auth/access";
import type { AppVariables } from "../auth/middleware";
import type { AppContext } from "../context";

/**
 * Users appear here the first time they sign in through EasyAuth, with no access at all.
 * An admin then grants a role — optionally limited to specific customers, which is how an
 * MSP gives a customer's own staff a view of just their environment.
 */
export function userRoutes(ctx: AppContext) {
  const app = new Hono<{ Variables: AppVariables }>();

  app.get("/", async (c) => {
    requireAccess(c.get("user"), "admin");
    const users = await ctx.db.select().from(schema.users);
    const assignments = await ctx.db
      .select({
        id: schema.roleAssignments.id,
        userId: schema.roleAssignments.userId,
        role: schema.roleAssignments.role,
        customerTenantId: schema.roleAssignments.customerTenantId,
        tenantName: schema.customerTenants.displayName,
      })
      .from(schema.roleAssignments)
      .leftJoin(
        schema.customerTenants,
        eq(schema.customerTenants.id, schema.roleAssignments.customerTenantId),
      );

    return c.json(
      users.map((user) => ({
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        disabled: user.disabled,
        lastSeenAt: user.lastSeenAt,
        createdAt: user.createdAt,
        assignments: assignments.filter((assignment) => assignment.userId === user.id),
      })),
    );
  });

  app.post("/:id/roles", async (c) => {
    const actor = c.get("user");
    const access = requireAccess(actor, "admin");
    const body = z
      .object({ role: roleSchema, customerTenantId: z.string().uuid().nullable().default(null) })
      .parse(await c.req.json());

    if (body.role === "owner" && access.role !== "owner") {
      throw new HTTPException(403, { message: "Only an owner can create another owner." });
    }
    const target = await ctx.db.query.users.findFirst({ where: eq(schema.users.id, c.req.param("id")) });
    if (!target) throw new HTTPException(404, { message: "No such user" });

    await grantRole(ctx.db, {
      userId: target.id,
      role: body.role,
      customerTenantId: body.customerTenantId,
      createdBy: actor.id,
    });
    ctx.log.info({ target: target.email, role: body.role }, "role granted");
    return c.json({ ok: true });
  });

  app.delete("/roles/:assignmentId", async (c) => {
    const actor = c.get("user");
    const access = requireAccess(actor, "admin");
    const assignment = await ctx.db.query.roleAssignments.findFirst({
      where: eq(schema.roleAssignments.id, c.req.param("assignmentId")),
    });
    if (!assignment) throw new HTTPException(404, { message: "No such assignment" });
    if (assignment.role === "owner") {
      if (access.role !== "owner")
        throw new HTTPException(403, { message: "Only an owner can remove an owner." });
      const owners = await ctx.db
        .select({ id: schema.roleAssignments.id })
        .from(schema.roleAssignments)
        .where(
          and(eq(schema.roleAssignments.role, "owner"), isNull(schema.roleAssignments.customerTenantId)),
        );
      if (owners.length <= 1) {
        throw new HTTPException(400, {
          message: "This is the last owner — grant ownership to someone else first.",
        });
      }
    }
    await ctx.db.delete(schema.roleAssignments).where(eq(schema.roleAssignments.id, assignment.id));
    return c.json({ ok: true });
  });

  app.post("/:id/disabled", async (c) => {
    const actor = c.get("user");
    requireAccess(actor, "admin");
    const body = z.object({ disabled: z.boolean() }).parse(await c.req.json());
    if (c.req.param("id") === actor.id)
      throw new HTTPException(400, { message: "You cannot disable yourself." });
    await ctx.db
      .update(schema.users)
      .set({ disabled: body.disabled })
      .where(eq(schema.users.id, c.req.param("id")));
    return c.json({ ok: true });
  });

  return app;
}

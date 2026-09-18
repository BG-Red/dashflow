import { schema } from "@dashflow/db";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { requireAccess } from "../auth/access";
import type { AppVariables } from "../auth/middleware";
import type { AppContext } from "../context";

const INSTANCE_KEY = "instance";

const instanceSchema = z.object({
  name: z.string().min(1).max(80).default("DashFlow"),
  /** Shown on dashboards handed to a customer. */
  organizationName: z.string().max(120).default(""),
});
export type InstanceSettings = z.infer<typeof instanceSchema>;

export async function readInstanceSettings(ctx: AppContext): Promise<InstanceSettings> {
  const row = await ctx.db.query.settings.findFirst({ where: eq(schema.settings.key, INSTANCE_KEY) });
  const parsed = instanceSchema.safeParse(row?.value ?? {});
  return parsed.success ? parsed.data : instanceSchema.parse({});
}

/** Instance-level settings, plus the facts an operator needs when something looks wrong. */
export function settingsRoutes(ctx: AppContext) {
  const app = new Hono<{ Variables: AppVariables }>();

  app.get("/", async (c) => {
    requireAccess(c.get("user"), "admin");
    const instance = await readInstanceSettings(ctx);
    const [connections, tenants, dashboards] = await Promise.all([
      ctx.db.select({ id: schema.connections.id }).from(schema.connections),
      ctx.db.select({ id: schema.customerTenants.id }).from(schema.customerTenants),
      ctx.db.select({ id: schema.dashboards.id }).from(schema.dashboards),
    ]);

    return c.json({
      instance,
      runtime: {
        version: process.env.APP_VERSION ?? "dev",
        commit: (process.env.APP_COMMIT ?? "").slice(0, 7),
        authMode: ctx.env.AUTH_MODE,
        appRole: ctx.env.APP_ROLE,
        demoMode: ctx.env.DEMO_MODE,
        pseudonymizeUsers: ctx.env.PSEUDONYMIZE_USERS,
        keyVault: ctx.secrets.canUseKeyVault,
        encryptionKey: ctx.secrets.canEncrypt,
        tokenValidation: ctx.env.EASYAUTH_VALIDATE_TOKEN,
        allowedTenants: ctx.env.ALLOWED_TENANT_IDS,
      },
      counts: {
        connections: connections.length,
        customers: tenants.length,
        dashboards: dashboards.length,
      },
    });
  });

  app.put("/", async (c) => {
    requireAccess(c.get("user"), "owner");
    const body = instanceSchema.parse(await c.req.json());
    await ctx.db
      .insert(schema.settings)
      .values({ key: INSTANCE_KEY, value: body })
      .onConflictDoUpdate({ target: schema.settings.key, set: { value: body, updatedAt: new Date() } });
    return c.json({ ok: true });
  });

  return app;
}

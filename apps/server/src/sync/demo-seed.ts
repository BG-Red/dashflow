import { DEFAULT_SCHEDULE } from "@dashflow/core";
import { schema } from "@dashflow/db";
import { eq } from "drizzle-orm";
import type { AppContext } from "../context";
import { enqueue } from "../worker/queue";
import { runDiscovery } from "./runner";

/**
 * With DEMO_MODE=true, create one synthetic connection so a fresh container has something to
 * look at. It is a normal connection row, so the setup wizard, sync engine and dashboards all
 * behave exactly as they do against a real tenant.
 */
export async function seedDemoConnection(ctx: AppContext): Promise<void> {
  const existing = await ctx.db.query.connections.findFirst({ where: eq(schema.connections.type, "demo") });
  if (existing) return;

  const [row] = await ctx.db
    .insert(schema.connections)
    .values({
      name: "Demo data (synthetic)",
      type: "demo",
      config: { type: "demo", tenants: 4 },
      schedule: { ...DEFAULT_SCHEDULE, backfillDays: 30 },
      status: "ok",
    })
    .returning({ id: schema.connections.id });

  const connection = await ctx.db.query.connections.findFirst({ where: eq(schema.connections.id, row!.id) });
  if (!connection) return;

  await runDiscovery(ctx, connection);
  const tenants = await ctx.db
    .select({ id: schema.customerTenants.id })
    .from(schema.customerTenants)
    .where(eq(schema.customerTenants.connectionId, connection.id));

  for (const tenant of tenants) {
    for (const stream of ["inventory", "sessions", "logs", "cost"] as const) {
      await enqueue(ctx, {
        type: "sync",
        payload: { connectionId: connection.id, customerTenantId: tenant.id, stream, backfill: true },
        dedupeKey: `sync:${connection.id}:${tenant.id}:${stream}`,
      });
    }
  }
  ctx.log.info({ tenants: tenants.length }, "demo connection seeded — synthetic data is loading");
}

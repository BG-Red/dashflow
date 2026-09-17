import { schema } from "@avd/db";
import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { requireAccess } from "../auth/access";
import type { AppVariables } from "../auth/middleware";
import type { AppContext } from "../context";
import { subscribe } from "../lib/events";
import { enqueue } from "../worker/queue";

/** Sync health: recent runs, queue depth, and a live stream for the wizard's progress view. */
export function syncRoutes(ctx: AppContext) {
  const app = new Hono<{ Variables: AppVariables }>();

  app.get("/runs", async (c) => {
    requireAccess(c.get("user"), "admin");
    const runs = await ctx.db
      .select({
        id: schema.syncRuns.id,
        stream: schema.syncRuns.stream,
        status: schema.syncRuns.status,
        startedAt: schema.syncRuns.startedAt,
        finishedAt: schema.syncRuns.finishedAt,
        stats: schema.syncRuns.stats,
        error: schema.syncRuns.error,
        connectionName: schema.connections.name,
        tenantName: schema.customerTenants.displayName,
      })
      .from(schema.syncRuns)
      .innerJoin(schema.connections, eq(schema.connections.id, schema.syncRuns.connectionId))
      .leftJoin(schema.customerTenants, eq(schema.customerTenants.id, schema.syncRuns.customerTenantId))
      .orderBy(desc(schema.syncRuns.startedAt))
      .limit(100);

    const queued = await ctx.db.select({ id: schema.jobs.id, status: schema.jobs.status }).from(schema.jobs);
    return c.json({
      runs,
      queue: {
        queued: queued.filter((job) => job.status === "queued").length,
        running: queued.filter((job) => job.status === "running").length,
        failed: queued.filter((job) => job.status === "failed").length,
      },
    });
  });

  app.post("/trigger", async (c) => {
    requireAccess(c.get("user"), "admin");
    const body = z
      .object({
        connectionId: z.string().uuid(),
        customerTenantId: z.string().uuid().optional(),
        stream: z.enum(["inventory", "sessions", "logs", "cost"]),
        backfill: z.boolean().default(false),
      })
      .parse(await c.req.json());

    const tenants = body.customerTenantId
      ? [{ id: body.customerTenantId }]
      : await ctx.db
          .select({ id: schema.customerTenants.id })
          .from(schema.customerTenants)
          .where(eq(schema.customerTenants.connectionId, body.connectionId));

    for (const tenant of tenants) {
      await enqueue(ctx, {
        type: "sync",
        payload: {
          connectionId: body.connectionId,
          customerTenantId: tenant.id,
          stream: body.stream,
          backfill: body.backfill,
        },
        dedupeKey: `sync:${body.connectionId}:${tenant.id}:${body.stream}`,
      });
    }
    return c.json({ queued: tenants.length });
  });

  /** Server-sent events so the setup wizard can show sync progress as it happens. */
  app.get("/events", async (c) => {
    requireAccess(c.get("user"), "admin");
    return streamSSE(c, async (stream) => {
      let open = true;
      const unsubscribe = subscribe((event) => {
        if (!open) return;
        void stream.writeSSE({ data: JSON.stringify(event), event: event.type });
      });
      stream.onAbort(() => {
        open = false;
        unsubscribe();
      });
      // Heartbeat so proxies do not close an idle stream.
      while (open && !ctx.shuttingDown) {
        await stream.writeSSE({ data: JSON.stringify({ type: "ping", at: Date.now() }), event: "ping" });
        await stream.sleep(20_000);
      }
      unsubscribe();
    });
  });

  return app;
}

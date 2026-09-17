import type { SyncStream } from "@avd/core";
import { schema } from "@avd/db";
import { and, eq, sql } from "drizzle-orm";
import type { AppContext } from "../context";
import { applyRetention, runDiscovery, syncOne, testConnection } from "../sync/runner";
import { claim, complete, enqueue, fail, type Job, requeueStale, workerId } from "./queue";

const POLL_INTERVAL_MS = 5_000;
const SCHEDULE_INTERVAL_MS = 60_000;

/** Per-stream schedule, in minutes, from the connection's settings. */
function intervalFor(
  stream: SyncStream,
  schedule: (typeof schema.connections.$inferSelect)["schedule"],
): number {
  switch (stream) {
    case "inventory":
      return schedule.inventoryMinutes;
    case "sessions":
      return schedule.sessionsMinutes;
    case "logs":
      return schedule.logsMinutes;
    case "cost":
      return schedule.costHours * 60;
  }
}

const STREAMS: SyncStream[] = ["inventory", "sessions", "logs", "cost"];

/**
 * Queue the work that is due. Runs every minute; `dedupeKey` means a slow customer never
 * piles up duplicate jobs, and one noisy tenant cannot starve the others.
 */
export async function scheduleDueWork(ctx: AppContext): Promise<number> {
  const connections = await ctx.db
    .select()
    .from(schema.connections)
    .where(eq(schema.connections.enabled, true));
  let queued = 0;

  for (const connection of connections) {
    const tenants = await ctx.db
      .select({ id: schema.customerTenants.id })
      .from(schema.customerTenants)
      .where(
        and(eq(schema.customerTenants.connectionId, connection.id), eq(schema.customerTenants.enabled, true)),
      );

    for (const tenant of tenants) {
      for (const stream of STREAMS) {
        const last = await ctx.db.query.watermarks.findFirst({
          where: and(
            eq(schema.watermarks.connectionId, connection.id),
            eq(schema.watermarks.customerTenantId, tenant.id),
            eq(schema.watermarks.stream, stream),
          ),
        });
        const dueAt = last ? last.value.getTime() + intervalFor(stream, connection.schedule) * 60_000 : 0;
        if (dueAt > Date.now()) continue;
        await enqueue(ctx, {
          type: "sync",
          payload: { connectionId: connection.id, customerTenantId: tenant.id, stream, backfill: !last },
          dedupeKey: `sync:${connection.id}:${tenant.id}:${stream}`,
        });
        queued++;
      }
    }

    await enqueue(ctx, {
      type: "retention",
      payload: { connectionId: connection.id },
      runAt: new Date(Date.now() + 60_000),
      dedupeKey: `retention:${connection.id}:${new Date().toISOString().slice(0, 10)}`,
    });
  }
  return queued;
}

async function handle(ctx: AppContext, job: Job): Promise<void> {
  switch (job.type) {
    case "sync":
      await syncOne(ctx, {
        connectionId: String(job.payload.connectionId),
        customerTenantId: String(job.payload.customerTenantId),
        stream: job.payload.stream as SyncStream,
        backfill: Boolean(job.payload.backfill),
      });
      return;
    case "discovery": {
      const connection = await ctx.db.query.connections.findFirst({
        where: eq(schema.connections.id, String(job.payload.connectionId)),
      });
      if (connection) await runDiscovery(ctx, connection);
      return;
    }
    case "test": {
      const connection = await ctx.db.query.connections.findFirst({
        where: eq(schema.connections.id, String(job.payload.connectionId)),
      });
      if (connection) await testConnection(ctx, connection);
      return;
    }
    case "retention":
      await applyRetention(ctx, String(job.payload.connectionId));
      return;
    default:
      ctx.log.warn({ type: job.type }, "unknown job type");
  }
}

export async function startWorker(ctx: AppContext): Promise<() => Promise<void>> {
  const id = workerId();
  ctx.log.info({ workerId: id }, "worker started");

  const released = await requeueStale(ctx);
  if (released > 0) ctx.log.info({ released }, "requeued jobs from a previous run");

  let stopped = false;
  const timers: Timer[] = [];

  const loop = async () => {
    while (!stopped && !ctx.shuttingDown) {
      try {
        const jobs = await claim(ctx, id, 2);
        if (jobs.length === 0) {
          await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
          continue;
        }
        for (const job of jobs) {
          try {
            await handle(ctx, job);
            await complete(ctx, job.id);
          } catch (err) {
            await fail(ctx, job, (err as Error).message);
          }
        }
      } catch (err) {
        ctx.log.error({ err: (err as Error).message }, "worker loop error");
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
    }
  };

  const scheduler = async () => {
    try {
      // Only one replica should schedule at a time.
      const [lock] = (await ctx.db.execute(sql`select pg_try_advisory_lock(918273645) as ok`)) as unknown as {
        ok: boolean;
      }[];
      if (lock?.ok) {
        const queued = await scheduleDueWork(ctx);
        if (queued > 0) ctx.log.debug({ queued }, "queued due work");
        await ctx.db.execute(sql`select pg_advisory_unlock(918273645)`);
      }
    } catch (err) {
      ctx.log.error({ err: (err as Error).message }, "scheduler error");
    }
  };

  void loop();
  void scheduler();
  timers.push(setInterval(scheduler, SCHEDULE_INTERVAL_MS));

  return async () => {
    stopped = true;
    for (const timer of timers) clearInterval(timer);
  };
}

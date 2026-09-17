import { randomUUID } from "node:crypto";
import { schema } from "@avd/db";
import { and, eq, sql } from "drizzle-orm";
import type { AppContext } from "../context";

/**
 * A job queue in Postgres, claimed with `for update skip locked`. No Redis, no extra service —
 * a self-hosted dashboard app should need one database and nothing else.
 */

export interface Job {
  id: number;
  type: string;
  payload: Record<string, unknown>;
  attempts: number;
}

export const MAX_ATTEMPTS = 4;

export interface EnqueueOptions {
  type: string;
  payload: Record<string, unknown>;
  runAt?: Date;
  /** Collapses duplicates: a second identical queued job is ignored. */
  dedupeKey?: string;
}

export async function enqueue(ctx: AppContext, options: EnqueueOptions): Promise<void> {
  await ctx.db
    .insert(schema.jobs)
    .values({
      type: options.type,
      payload: options.payload,
      runAt: options.runAt ?? new Date(),
      dedupeKey: options.dedupeKey ?? null,
    })
    .onConflictDoNothing();
}

export async function claim(ctx: AppContext, workerId: string, limit = 1): Promise<Job[]> {
  const result = await ctx.db.execute(sql`
    with claimed as (
      select id from jobs
      where status = 'queued' and run_at <= now()
      order by run_at
      for update skip locked
      limit ${limit}
    )
    update jobs j
    set status = 'running', locked_at = now(), locked_by = ${workerId}, attempts = j.attempts + 1
    from claimed
    where j.id = claimed.id
    returning j.id, j.type, j.payload, j.attempts`);

  const rows = (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as {
    id: number | string;
    type: string;
    payload: Record<string, unknown>;
    attempts: number;
  }[];
  return rows.map((row) => ({ ...row, id: Number(row.id) }));
}

export async function complete(ctx: AppContext, jobId: number): Promise<void> {
  await ctx.db.delete(schema.jobs).where(eq(schema.jobs.id, jobId));
}

export async function fail(ctx: AppContext, job: Job, error: string): Promise<void> {
  if (job.attempts >= MAX_ATTEMPTS) {
    await ctx.db
      .update(schema.jobs)
      .set({ status: "failed", lastError: error.slice(0, 2000), lockedAt: null, lockedBy: null })
      .where(eq(schema.jobs.id, job.id));
    return;
  }
  // Exponential backoff: 1, 4, 9 minutes.
  const delayMs = job.attempts ** 2 * 60_000;
  await ctx.db
    .update(schema.jobs)
    .set({
      status: "queued",
      runAt: new Date(Date.now() + delayMs),
      lastError: error.slice(0, 2000),
      lockedAt: null,
      lockedBy: null,
    })
    .where(eq(schema.jobs.id, job.id));
}

/** Release jobs whose worker died mid-flight. */
export async function requeueStale(ctx: AppContext, olderThanMinutes = 30): Promise<number> {
  const result = await ctx.db
    .update(schema.jobs)
    .set({ status: "queued", lockedAt: null, lockedBy: null })
    .where(
      and(
        eq(schema.jobs.status, "running"),
        sql`${schema.jobs.lockedAt} < now() - ${sql.raw(`interval '${olderThanMinutes} minutes'`)}`,
      ),
    )
    .returning({ id: schema.jobs.id });
  return result.length;
}

export const workerId = (): string => `${process.env.HOSTNAME ?? "local"}-${randomUUID().slice(0, 8)}`;

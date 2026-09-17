import { type Connector, createConnector } from "@avd/connectors";
import type { DiagnosticCheck, SyncStream } from "@avd/core";
import { schema } from "@avd/db";
import { and, eq, inArray, lt } from "drizzle-orm";
import type { AppContext } from "../context";
import { publish } from "../lib/events";
import { ingest } from "./ingest";

type ConnectionRow = typeof schema.connections.$inferSelect;

/** Build a connector from a stored connection, resolving its secrets on the way. */
export async function connectorFor(ctx: AppContext, connection: ConnectionRow): Promise<Connector> {
  const [secret, refreshToken] = await Promise.all([
    ctx.secrets.get(connection.secretId),
    ctx.secrets.get(connection.refreshSecretId),
  ]);

  return createConnector(connection.config, {
    log: ctx.log.child({ connection: connection.name, type: connection.type }),
    secret,
    refreshToken,
    onRefreshToken: async (token) => {
      // Partner Center rotates refresh tokens; persist the new one or the next sync fails.
      const next = await ctx.secrets.replace(connection.refreshSecretId, { kind: "inline", value: token });
      if (next && next !== connection.refreshSecretId) {
        await ctx.db
          .update(schema.connections)
          .set({ refreshSecretId: next })
          .where(eq(schema.connections.id, connection.id));
      }
    },
  });
}

export async function testConnection(ctx: AppContext, connection: ConnectionRow): Promise<DiagnosticCheck[]> {
  let checks: DiagnosticCheck[];
  try {
    const connector = await connectorFor(ctx, connection);
    checks = await connector.test();
  } catch (err) {
    checks = [
      {
        id: "unexpected",
        label: "Test the connection",
        status: "fail",
        detail: (err as Error).message,
        fix: "Check the connection settings, then try again.",
      },
    ];
  }
  const worst = checks.some((c) => c.status === "fail")
    ? "error"
    : checks.some((c) => c.status === "warn")
      ? "degraded"
      : "ok";
  await ctx.db
    .update(schema.connections)
    .set({ lastTestedAt: new Date(), lastTest: checks, status: worst })
    .where(eq(schema.connections.id, connection.id));
  return checks;
}

export interface DiscoverySummary {
  tenants: number;
  subscriptions: number;
  workspaces: number;
  hostPools: number;
}

/** Discover customers, subscriptions and workspaces, and store them for the operator to pick from. */
export async function runDiscovery(ctx: AppContext, connection: ConnectionRow): Promise<DiscoverySummary> {
  const connector = await connectorFor(ctx, connection);
  const discovery = await connector.discover();

  for (const tenant of discovery.tenants) {
    await ctx.db
      .insert(schema.customerTenants)
      .values({
        connectionId: connection.id,
        tenantId: tenant.tenantId,
        displayName: tenant.displayName,
        domain: tenant.domain ?? null,
        meta: tenant.meta ?? null,
      })
      .onConflictDoUpdate({
        target: [schema.customerTenants.connectionId, schema.customerTenants.tenantId],
        set: { displayName: tenant.displayName, domain: tenant.domain ?? null, meta: tenant.meta ?? null },
      });
  }

  const tenantRows = await ctx.db
    .select({ id: schema.customerTenants.id, tenantId: schema.customerTenants.tenantId })
    .from(schema.customerTenants)
    .where(eq(schema.customerTenants.connectionId, connection.id));
  const rowIdFor = new Map(tenantRows.map((row) => [row.tenantId, row.id]));

  for (const subscription of discovery.subscriptions) {
    const tenantRowId = rowIdFor.get(subscription.tenantId);
    if (!tenantRowId) continue;
    await ctx.db
      .insert(schema.subscriptions)
      .values({
        customerTenantId: tenantRowId,
        subscriptionId: subscription.subscriptionId,
        displayName: subscription.displayName,
      })
      .onConflictDoUpdate({
        target: [schema.subscriptions.customerTenantId, schema.subscriptions.subscriptionId],
        set: { displayName: subscription.displayName },
      });
  }

  for (const workspace of discovery.workspaces) {
    const tenantRowId = rowIdFor.get(workspace.tenantId);
    if (!tenantRowId) continue;
    await ctx.db
      .insert(schema.logAnalyticsWorkspaces)
      .values({
        customerTenantId: tenantRowId,
        resourceId: workspace.resourceId,
        workspaceId: workspace.workspaceId,
        name: workspace.name,
        hostPoolIds: workspace.hostPoolIds,
      })
      .onConflictDoUpdate({
        target: [schema.logAnalyticsWorkspaces.customerTenantId, schema.logAnalyticsWorkspaces.resourceId],
        set: { name: workspace.name, workspaceId: workspace.workspaceId, hostPoolIds: workspace.hostPoolIds },
      });
  }

  return {
    tenants: discovery.tenants.length,
    subscriptions: discovery.subscriptions.length,
    workspaces: discovery.workspaces.length,
    hostPools: discovery.hostPoolCount,
  };
}

export interface SyncOneInput {
  connectionId: string;
  customerTenantId: string;
  stream: SyncStream;
  /** Ignore the watermark and pull the full backfill window. */
  backfill?: boolean;
}

/** Sync one stream for one customer. This is the unit of work the job queue schedules. */
export async function syncOne(ctx: AppContext, input: SyncOneInput): Promise<void> {
  const connection = await ctx.db.query.connections.findFirst({
    where: eq(schema.connections.id, input.connectionId),
  });
  if (!connection?.enabled) return;

  const tenant = await ctx.db.query.customerTenants.findFirst({
    where: and(
      eq(schema.customerTenants.id, input.customerTenantId),
      eq(schema.customerTenants.connectionId, connection.id),
    ),
  });
  if (!tenant?.enabled) return;

  const [run] = await ctx.db
    .insert(schema.syncRuns)
    .values({
      connectionId: connection.id,
      customerTenantId: tenant.id,
      stream: input.stream,
      status: "running",
    })
    .returning({ id: schema.syncRuns.id });

  const log = ctx.log.child({
    connection: connection.name,
    tenant: tenant.displayName,
    stream: input.stream,
  });
  publish({ type: "sync:start", connectionId: connection.id, tenantId: tenant.id, stream: input.stream });

  try {
    const [subscriptions, workspaces, pools, watermark] = await Promise.all([
      ctx.db
        .select({ subscriptionId: schema.subscriptions.subscriptionId })
        .from(schema.subscriptions)
        .where(
          and(eq(schema.subscriptions.customerTenantId, tenant.id), eq(schema.subscriptions.enabled, true)),
        ),
      ctx.db
        .select({
          workspaceId: schema.logAnalyticsWorkspaces.workspaceId,
          hostPoolIds: schema.logAnalyticsWorkspaces.hostPoolIds,
        })
        .from(schema.logAnalyticsWorkspaces)
        .where(
          and(
            eq(schema.logAnalyticsWorkspaces.customerTenantId, tenant.id),
            eq(schema.logAnalyticsWorkspaces.enabled, true),
          ),
        ),
      ctx.db
        .select({ resourceId: schema.hostPools.resourceId })
        .from(schema.hostPools)
        .where(and(eq(schema.hostPools.customerTenantId, tenant.id), eq(schema.hostPools.enabled, true))),
      ctx.db.query.watermarks.findFirst({
        where: and(
          eq(schema.watermarks.connectionId, connection.id),
          eq(schema.watermarks.customerTenantId, tenant.id),
          eq(schema.watermarks.stream, input.stream),
        ),
      }),
    ]);

    const until = new Date();
    const connector = await connectorFor(ctx, connection);
    const batch = await connector.sync({
      stream: input.stream,
      tenantId: tenant.tenantId,
      subscriptionIds: subscriptions.map((s) => s.subscriptionId),
      workspaces: workspaces.map((w) => ({ workspaceId: w.workspaceId, hostPoolIds: w.hostPoolIds })),
      hostPoolIds: pools.map((p) => p.resourceId),
      since: input.backfill ? undefined : (watermark?.value ?? undefined),
      until,
      backfillDays: connection.schedule.backfillDays,
    });

    const stats = await ingest(
      ctx,
      { connectionId: connection.id, tenantRowId: tenant.id, tenantId: tenant.tenantId },
      batch,
    );

    await ctx.db
      .insert(schema.watermarks)
      .values({
        connectionId: connection.id,
        customerTenantId: tenant.id,
        stream: input.stream,
        value: until,
      })
      .onConflictDoUpdate({
        target: [
          schema.watermarks.connectionId,
          schema.watermarks.customerTenantId,
          schema.watermarks.stream,
        ],
        set: { value: until },
      });

    await ctx.db
      .update(schema.syncRuns)
      .set({ status: "ok", finishedAt: new Date(), stats })
      .where(eq(schema.syncRuns.id, run!.id));
    await ctx.db
      .update(schema.connections)
      .set({ lastSyncAt: new Date() })
      .where(eq(schema.connections.id, connection.id));

    log.info({ stats }, "sync finished");
    publish({
      type: "sync:done",
      connectionId: connection.id,
      tenantId: tenant.id,
      stream: input.stream,
      stats,
    });
  } catch (err) {
    const message = (err as Error).message.slice(0, 1000);
    log.error({ err: message }, "sync failed");
    await ctx.db
      .update(schema.syncRuns)
      .set({ status: "error", finishedAt: new Date(), error: message })
      .where(eq(schema.syncRuns.id, run!.id));
    publish({
      type: "sync:error",
      connectionId: connection.id,
      tenantId: tenant.id,
      stream: input.stream,
      error: message,
    });
    throw err;
  }
}

/** Apply the retention setting by deleting old facts. Runs once a day per connection. */
export async function applyRetention(ctx: AppContext, connectionId: string): Promise<void> {
  const connection = await ctx.db.query.connections.findFirst({
    where: eq(schema.connections.id, connectionId),
  });
  if (!connection) return;
  const cutoff = new Date(Date.now() - connection.schedule.retentionDays * 86_400_000);
  const tenants = await ctx.db
    .select({ id: schema.customerTenants.id })
    .from(schema.customerTenants)
    .where(eq(schema.customerTenants.connectionId, connectionId));
  if (tenants.length === 0) return;
  const ids = tenants.map((t) => t.id);

  await Promise.all([
    ctx.db
      .delete(schema.sessionSnapshots)
      .where(and(inArray(schema.sessionSnapshots.tenantId, ids), lt(schema.sessionSnapshots.ts, cutoff))),
    ctx.db
      .delete(schema.connectionFacts)
      .where(and(inArray(schema.connectionFacts.tenantId, ids), lt(schema.connectionFacts.ts, cutoff))),
    ctx.db
      .delete(schema.errorFacts)
      .where(and(inArray(schema.errorFacts.tenantId, ids), lt(schema.errorFacts.ts, cutoff))),
    ctx.db
      .delete(schema.hostHealth)
      .where(and(inArray(schema.hostHealth.tenantId, ids), lt(schema.hostHealth.ts, cutoff))),
    ctx.db
      .delete(schema.perfHourly)
      .where(and(inArray(schema.perfHourly.tenantId, ids), lt(schema.perfHourly.ts, cutoff))),
    ctx.db
      .delete(schema.costDaily)
      .where(and(inArray(schema.costDaily.tenantId, ids), lt(schema.costDaily.ts, cutoff))),
  ]);
  ctx.log.info({ connection: connection.name, cutoff }, "retention applied");
}

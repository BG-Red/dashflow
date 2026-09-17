import { createHash, randomBytes } from "node:crypto";
import type { SyncBatch } from "@avd/core";
import { type Db, schema } from "@avd/db";
import { eq, sql } from "drizzle-orm";
import type { AppContext } from "../context";

/**
 * Writes a connector's normalized batch into Postgres. Everything is an upsert keyed on the
 * ARM resource id (inventory) or a stable natural key (facts), so a sync can be re-run over
 * an overlapping window without creating duplicates.
 */

const CHUNK = 500;

function chunks<T>(items: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

let cachedSalt: string | null = null;

/** One random salt per instance, so hashed user keys cannot be matched across deployments. */
async function userSalt(db: Db): Promise<string> {
  if (cachedSalt) return cachedSalt;
  const row = await db.query.settings.findFirst({ where: eq(schema.settings.key, "users.salt") });
  if (row && typeof (row.value as { salt?: string }).salt === "string") {
    cachedSalt = (row.value as { salt: string }).salt;
    return cachedSalt;
  }
  const salt = randomBytes(24).toString("base64url");
  await db.insert(schema.settings).values({ key: "users.salt", value: { salt } }).onConflictDoNothing();
  cachedSalt = salt;
  return salt;
}

export interface IngestScope {
  connectionId: string;
  /** Entra tenant id (or a Nerdio account key) → customer_tenants.id */
  tenantRowId: string;
  tenantId: string;
}

export interface IngestStats extends Record<string, number> {
  hostPools: number;
  sessionHosts: number;
  appGroups: number;
  scalingPlans: number;
  sessionSnapshots: number;
  hostHealth: number;
  connections: number;
  errors: number;
  perf: number;
  costs: number;
  autoscaleEvents: number;
  skippedUnknownPool: number;
}

const emptyStats = (): IngestStats => ({
  hostPools: 0,
  sessionHosts: 0,
  appGroups: 0,
  scalingPlans: 0,
  sessionSnapshots: 0,
  hostHealth: 0,
  connections: 0,
  errors: 0,
  perf: 0,
  costs: 0,
  autoscaleEvents: 0,
  skippedUnknownPool: 0,
});

export async function ingest(ctx: AppContext, scope: IngestScope, batch: SyncBatch): Promise<IngestStats> {
  const { db } = ctx;
  const stats = emptyStats();
  const tenantRowId = scope.tenantRowId;

  // ─── inventory ────────────────────────────────────────────────────────────────
  for (const group of chunks(batch.hostPools ?? [])) {
    await db
      .insert(schema.hostPools)
      .values(
        group.map((pool) => ({
          resourceId: pool.resourceId,
          customerTenantId: tenantRowId,
          connectionId: scope.connectionId,
          subscriptionId: pool.subscriptionId,
          name: pool.name,
          friendlyName: pool.friendlyName ?? null,
          location: pool.location,
          poolType: pool.poolType,
          loadBalancer: pool.loadBalancer ?? null,
          maxSessions: pool.maxSessions ?? null,
          startVmOnConnect: pool.startVmOnConnect ?? null,
          validationEnvironment: pool.validationEnvironment ?? null,
          preferredAppGroupType: pool.preferredAppGroupType ?? null,
          autoscaleEnabled: pool.autoscaleEnabled ?? null,
          sources: [pool.source],
          updatedAt: new Date(),
        })),
      )
      .onConflictDoUpdate({
        target: schema.hostPools.resourceId,
        set: {
          name: sql`excluded.name`,
          friendlyName: sql`excluded.friendly_name`,
          location: sql`excluded.location`,
          poolType: sql`excluded.pool_type`,
          loadBalancer: sql`excluded.load_balancer`,
          maxSessions: sql`coalesce(excluded.max_sessions, ${schema.hostPools.maxSessions})`,
          startVmOnConnect: sql`excluded.start_vm_on_connect`,
          validationEnvironment: sql`excluded.validation_environment`,
          preferredAppGroupType: sql`excluded.preferred_app_group_type`,
          // Nerdio knows about autoscale, Azure does not — keep whichever said "true".
          autoscaleEnabled: sql`coalesce(excluded.autoscale_enabled, ${schema.hostPools.autoscaleEnabled})`,
          // Track every source that has seen this pool so the UI can show "Azure + Nerdio".
          sources: sql`(
            select jsonb_agg(distinct s) from jsonb_array_elements(${schema.hostPools.sources} || excluded.sources) as t(s)
          )`,
          updatedAt: new Date(),
        },
      });
    stats.hostPools += group.length;
  }

  const knownPools = await knownPoolIds(ctx, tenantRowId);

  for (const group of chunks(batch.sessionHosts ?? [])) {
    const rows = group
      .filter((host) => knownPools.has(host.hostPoolId))
      .map((host) => ({
        resourceId: host.resourceId,
        hostPoolId: host.hostPoolId,
        customerTenantId: tenantRowId,
        name: host.name,
        vmResourceId: host.vmResourceId ?? null,
        status: host.status,
        allowNewSession: host.allowNewSession,
        sessions: host.sessions,
        agentVersion: host.agentVersion ?? null,
        osVersion: host.osVersion ?? null,
        lastHeartBeat: host.lastHeartBeat ? new Date(host.lastHeartBeat) : null,
        updateState: host.updateState ?? null,
        source: host.source,
        updatedAt: new Date(),
      }));
    stats.skippedUnknownPool += group.length - rows.length;
    if (rows.length === 0) continue;
    await db
      .insert(schema.sessionHosts)
      .values(rows)
      .onConflictDoUpdate({
        target: schema.sessionHosts.resourceId,
        set: {
          status: sql`excluded.status`,
          allowNewSession: sql`excluded.allow_new_session`,
          sessions: sql`excluded.sessions`,
          agentVersion: sql`excluded.agent_version`,
          osVersion: sql`excluded.os_version`,
          lastHeartBeat: sql`excluded.last_heart_beat`,
          updateState: sql`excluded.update_state`,
          updatedAt: new Date(),
        },
      });
    stats.sessionHosts += rows.length;
  }

  for (const group of chunks(batch.appGroups ?? [])) {
    await db
      .insert(schema.appGroups)
      .values(
        group.map((appGroup) => ({
          resourceId: appGroup.resourceId,
          customerTenantId: tenantRowId,
          hostPoolId: appGroup.hostPoolId && knownPools.has(appGroup.hostPoolId) ? appGroup.hostPoolId : null,
          name: appGroup.name,
          groupType: appGroup.groupType,
          workspaceId: appGroup.workspaceId ?? null,
          updatedAt: new Date(),
        })),
      )
      .onConflictDoUpdate({
        target: schema.appGroups.resourceId,
        set: { name: sql`excluded.name`, groupType: sql`excluded.group_type`, updatedAt: new Date() },
      });
    stats.appGroups += group.length;
  }

  for (const group of chunks(batch.scalingPlans ?? [])) {
    await db
      .insert(schema.scalingPlans)
      .values(
        group.map((plan) => ({
          resourceId: plan.resourceId,
          customerTenantId: tenantRowId,
          name: plan.name,
          timeZone: plan.timeZone ?? null,
          hostPoolIds: plan.hostPoolIds,
          schedules: plan.schedules,
          updatedAt: new Date(),
        })),
      )
      .onConflictDoUpdate({
        target: schema.scalingPlans.resourceId,
        set: {
          name: sql`excluded.name`,
          timeZone: sql`excluded.time_zone`,
          hostPoolIds: sql`excluded.host_pool_ids`,
          schedules: sql`excluded.schedules`,
          updatedAt: new Date(),
        },
      });
    stats.scalingPlans += group.length;
  }

  // ─── facts ────────────────────────────────────────────────────────────────────
  for (const group of chunks(batch.sessionSnapshots ?? [])) {
    const rows = group
      .filter((snapshot) => knownPools.has(snapshot.hostPoolId))
      .map((snapshot) => ({
        ts: new Date(snapshot.ts),
        hostPoolId: snapshot.hostPoolId,
        tenantId: tenantRowId,
        activeSessions: snapshot.activeSessions,
        disconnectedSessions: snapshot.disconnectedSessions,
        capacity: snapshot.capacity,
        availableHosts: snapshot.availableHosts,
        totalHosts: snapshot.totalHosts,
      }));
    if (rows.length === 0) continue;
    await db
      .insert(schema.sessionSnapshots)
      .values(rows)
      .onConflictDoUpdate({
        target: [schema.sessionSnapshots.ts, schema.sessionSnapshots.hostPoolId],
        set: {
          activeSessions: sql`excluded.active_sessions`,
          disconnectedSessions: sql`excluded.disconnected_sessions`,
          capacity: sql`excluded.capacity`,
          availableHosts: sql`excluded.available_hosts`,
          totalHosts: sql`excluded.total_hosts`,
        },
      });
    stats.sessionSnapshots += rows.length;
  }

  for (const group of chunks(batch.hostHealth ?? [])) {
    const rows = group
      .filter((record) => knownPools.has(record.hostPoolId))
      .map((record) => ({
        ts: new Date(record.ts),
        sessionHost: record.sessionHost,
        hostPoolId: record.hostPoolId,
        tenantId: tenantRowId,
        status: record.status,
        healthy: record.healthy,
        drain: record.drain,
        sessions: record.sessions,
      }));
    if (rows.length === 0) continue;
    await db
      .insert(schema.hostHealth)
      .values(rows)
      .onConflictDoUpdate({
        target: [schema.hostHealth.ts, schema.hostHealth.hostPoolId, schema.hostHealth.sessionHost],
        set: {
          status: sql`excluded.status`,
          healthy: sql`excluded.healthy`,
          drain: sql`excluded.drain`,
          sessions: sql`excluded.sessions`,
        },
      });
    stats.hostHealth += rows.length;
  }

  if (batch.connections?.length) {
    const salt = ctx.env.PSEUDONYMIZE_USERS ? await userSalt(db) : null;
    const userKey = (user: string) =>
      salt
        ? createHash("sha256").update(`${salt}|${user.toLowerCase()}`).digest("base64url").slice(0, 32)
        : user.toLowerCase();

    for (const group of chunks(batch.connections)) {
      await db
        .insert(schema.connectionFacts)
        .values(
          group.map((fact) => ({
            correlationId: fact.correlationId,
            tenantId: tenantRowId,
            hostPoolId: fact.hostPoolId && knownPools.has(fact.hostPoolId) ? fact.hostPoolId : null,
            ts: new Date(fact.ts),
            userKey: userKey(fact.user),
            sessionHost: fact.sessionHost ?? null,
            clientOs: fact.clientOs ?? null,
            clientType: fact.clientType ?? null,
            clientVersion: fact.clientVersion ?? null,
            gatewayRegion: fact.gatewayRegion ?? null,
            state: fact.state,
            connectMs: fact.connectMs ?? null,
            rttMs: fact.rttMs ?? null,
            bandwidthKbps: fact.bandwidthKbps ?? null,
            durationSec: fact.durationSec ?? null,
          })),
        )
        .onConflictDoUpdate({
          target: schema.connectionFacts.correlationId,
          set: {
            // A later run may see the session complete, so let newer data win.
            state: sql`excluded.state`,
            connectMs: sql`coalesce(excluded.connect_ms, ${schema.connectionFacts.connectMs})`,
            rttMs: sql`coalesce(excluded.rtt_ms, ${schema.connectionFacts.rttMs})`,
            bandwidthKbps: sql`coalesce(excluded.bandwidth_kbps, ${schema.connectionFacts.bandwidthKbps})`,
            durationSec: sql`coalesce(excluded.duration_sec, ${schema.connectionFacts.durationSec})`,
            sessionHost: sql`coalesce(excluded.session_host, ${schema.connectionFacts.sessionHost})`,
            hostPoolId: sql`coalesce(excluded.host_pool_id, ${schema.connectionFacts.hostPoolId})`,
          },
        });
      stats.connections += group.length;
    }
  }

  for (const group of chunks(batch.errors ?? [])) {
    await db
      .insert(schema.errorFacts)
      .values(
        group.map((error) => ({
          key: error.key,
          tenantId: tenantRowId,
          hostPoolId: error.hostPoolId && knownPools.has(error.hostPoolId) ? error.hostPoolId : null,
          ts: new Date(error.ts),
          correlationId: error.correlationId ?? null,
          code: error.code,
          source: error.source,
          message: error.message,
          serviceError: error.serviceError,
        })),
      )
      .onConflictDoNothing();
    stats.errors += group.length;
  }

  for (const group of chunks(batch.perf ?? [])) {
    await db
      .insert(schema.perfHourly)
      .values(
        group.map((record) => ({
          ts: new Date(record.ts),
          sessionHost: record.sessionHost,
          hostPoolId: record.hostPoolId && knownPools.has(record.hostPoolId) ? record.hostPoolId : null,
          tenantId: tenantRowId,
          cpuPct: record.cpuPct ?? null,
          memAvailableMb: record.memAvailableMb ?? null,
        })),
      )
      .onConflictDoUpdate({
        target: [schema.perfHourly.ts, schema.perfHourly.sessionHost],
        set: { cpuPct: sql`excluded.cpu_pct`, memAvailableMb: sql`excluded.mem_available_mb` },
      });
    stats.perf += group.length;
  }

  for (const group of chunks(batch.costs ?? [])) {
    await db
      .insert(schema.costDaily)
      .values(
        group.map((cost) => ({
          key: `${tenantRowId}|${cost.date}|${cost.hostPoolId ?? "-"}|${cost.meterCategory}`,
          ts: new Date(`${cost.date}T00:00:00Z`),
          day: cost.date,
          tenantId: tenantRowId,
          hostPoolId: cost.hostPoolId && knownPools.has(cost.hostPoolId) ? cost.hostPoolId : null,
          meterCategory: cost.meterCategory,
          cost: cost.cost.toFixed(4),
          currency: cost.currency,
          estimatedSavings: cost.estimatedSavings != null ? cost.estimatedSavings.toFixed(4) : null,
        })),
      )
      .onConflictDoUpdate({
        target: schema.costDaily.key,
        set: {
          cost: sql`excluded.cost`,
          currency: sql`excluded.currency`,
          estimatedSavings: sql`coalesce(excluded.estimated_savings, ${schema.costDaily.estimatedSavings})`,
        },
      });
    stats.costs += group.length;
  }

  for (const group of chunks(batch.autoscaleEvents ?? [])) {
    await db
      .insert(schema.autoscaleEvents)
      .values(
        group
          .filter((event) => knownPools.has(event.hostPoolId))
          .map((event) => ({
            key: event.key,
            ts: new Date(event.ts),
            tenantId: tenantRowId,
            hostPoolId: event.hostPoolId,
            action: event.action,
            hostsBefore: event.hostsBefore ?? null,
            hostsAfter: event.hostsAfter ?? null,
            detail: event.detail ?? null,
          })),
      )
      .onConflictDoNothing();
    stats.autoscaleEvents += group.length;
  }

  return stats;
}

async function knownPoolIds(ctx: AppContext, tenantRowId: string): Promise<Set<string>> {
  const rows = await ctx.db
    .select({ resourceId: schema.hostPools.resourceId })
    .from(schema.hostPools)
    .where(eq(schema.hostPools.customerTenantId, tenantRowId));
  return new Set(rows.map((row) => row.resourceId));
}

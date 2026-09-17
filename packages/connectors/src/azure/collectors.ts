import { createHash } from "node:crypto";
import type { DiagnosticCheck, Discovery, HostHealthRecord, SessionHostRecord, SyncBatch } from "@avd/core";
import { normalizeResourceId, parseResourceId } from "@avd/core";
import type { TokenFn } from "../http";
import { type ConnectorError, type ConnectorLogger, check, type SyncInput } from "../types";
import { API, type ArmClient, createArmClient } from "./arm";
import { attributeCost, queryDailyCost } from "./cost";
import {
  CONNECTIONS_QUERY,
  type ConnectionRow,
  ERRORS_QUERY,
  type ErrorRow,
  kql,
  PERF_QUERY,
  type PerfRow,
  TABLE_PROBE_QUERY,
  withWindow,
} from "./logAnalytics";

const HEALTHY_STATUSES = new Set(["available"]);
/** Hosts that are simply switched off are not a fault — autoscale does that on purpose. */
const NEUTRAL_STATUSES = new Set(["shutdown", "unavailable(vmnotrunning)"]);

export function isHealthy(status: string): boolean {
  const s = status.toLowerCase();
  return HEALTHY_STATUSES.has(s) || NEUTRAL_STATUSES.has(s);
}

function shortHostName(name: string): string {
  const withoutPool = name.includes("/") ? name.slice(name.indexOf("/") + 1) : name;
  return withoutPool.split(".")[0]!.toLowerCase();
}

/**
 * Collection logic shared by every Azure-backed connector. Azure direct, Lighthouse and
 * Partner Center differ only in how they get a token and which tenants they enumerate —
 * once there is a token for a tenant, the data collection is identical.
 */
export class AzureCollector {
  readonly arm: ArmClient;

  /**
   * `tenantId` is the customer the records belong to. `tokenTenantId` is the tenant that
   * issues tokens — the same thing for a direct connection, but the managing tenant for
   * Azure Lighthouse, where one identity reaches many customers' subscriptions.
   */
  constructor(
    private readonly token: TokenFn,
    readonly tenantId: string,
    private readonly log: ConnectorLogger,
    private readonly tokenTenantId: string = tenantId,
  ) {
    this.arm = createArmClient(token, tokenTenantId);
  }

  /** Host pools and Log Analytics workspaces for the selected subscriptions. */
  async discover(subscriptionIds: string[]): Promise<Omit<Discovery, "tenants">> {
    const subs = subscriptionIds.length
      ? subscriptionIds
      : (await this.arm.listSubscriptions()).map((s) => s.subscriptionId);

    const pools = (await Promise.all(subs.map((sub) => this.arm.listHostPools(sub).catch(() => [])))).flat();

    const workspaces = new Map<string, { resourceId: string; hostPoolIds: string[] }>();
    for (const pool of pools) {
      const ids = await this.arm.diagnosticWorkspaces(pool.resourceId).catch(() => []);
      for (const id of ids) {
        const entry = workspaces.get(id) ?? { resourceId: id, hostPoolIds: [] };
        entry.hostPoolIds.push(pool.resourceId);
        workspaces.set(id, entry);
      }
    }

    const resolved = await Promise.all(
      [...workspaces.values()].map(async (workspace) => {
        const info = await this.arm.workspaceCustomerId(workspace.resourceId).catch(() => null);
        if (!info) return null;
        return {
          tenantId: this.tenantId,
          resourceId: workspace.resourceId,
          workspaceId: info.workspaceId,
          name: info.name,
          hostPoolIds: workspace.hostPoolIds,
        };
      }),
    );

    return {
      subscriptions: subs.map((subscriptionId) => ({
        tenantId: this.tenantId,
        subscriptionId,
        displayName: subscriptionId,
      })),
      workspaces: resolved.filter((w): w is NonNullable<typeof w> => w !== null),
      hostPoolCount: pools.length,
    };
  }

  async inventory(subscriptionIds: string[]): Promise<SyncBatch> {
    const batch: SyncBatch = {
      hostPools: [],
      sessionHosts: [],
      appGroups: [],
      scalingPlans: [],
      hostHealth: [],
    };
    const ts = new Date().toISOString();

    for (const subscriptionId of subscriptionIds) {
      const [pools, appGroups, scalingPlans] = await Promise.all([
        this.arm.listHostPools(subscriptionId),
        this.arm.listAppGroups(subscriptionId).catch((err) => {
          this.log.warn({ err: (err as Error).message, subscriptionId }, "could not list application groups");
          return [];
        }),
        this.arm.listScalingPlans(subscriptionId).catch(() => []),
      ]);
      batch.hostPools!.push(...pools);
      batch.appGroups!.push(...appGroups);
      batch.scalingPlans!.push(...scalingPlans);

      const scaledPools = new Set(scalingPlans.flatMap((plan) => plan.hostPoolIds));
      for (const pool of pools) {
        if (scaledPools.has(pool.resourceId)) pool.autoscaleEnabled = true;
        const hosts = await this.arm.listSessionHosts(pool.resourceId).catch((err) => {
          this.log.warn({ err: (err as Error).message, pool: pool.name }, "could not list session hosts");
          return [] as SessionHostRecord[];
        });
        batch.sessionHosts!.push(...hosts);
        batch.hostHealth!.push(...hostHealthFrom(hosts, pool.resourceId, this.tenantId, ts));
      }
    }
    return batch;
  }

  /** A point-in-time view of sessions and hosts, one row per host pool. */
  async sessions(hostPoolIds: string[]): Promise<SyncBatch> {
    const ts = roundToFiveMinutes(new Date()).toISOString();
    const batch: SyncBatch = { sessionSnapshots: [], sessionHosts: [], hostHealth: [] };

    for (const hostPoolId of hostPoolIds) {
      const hosts = await this.arm.listSessionHosts(hostPoolId).catch((err) => {
        this.log.warn({ err: (err as Error).message, hostPoolId }, "could not list session hosts");
        return [] as SessionHostRecord[];
      });
      if (hosts.length === 0) continue;
      batch.sessionHosts!.push(...hosts);
      batch.hostHealth!.push(...hostHealthFrom(hosts, hostPoolId, this.tenantId, ts));

      const userSessions = await this.arm.listUserSessions(hostPoolId).catch(() => []);
      const active = userSessions.filter((s) => s.sessionState.toLowerCase() === "active").length;
      const disconnected = userSessions.filter((s) => s.sessionState.toLowerCase() === "disconnected").length;
      const availableHosts = hosts.filter((h) => h.status === "Available").length;
      const totalSessions = hosts.reduce((sum, host) => sum + host.sessions, 0);

      // maxSessionLimit lives on the pool; capacity uses the per-host limit when we know it.
      type PoolProps = { properties?: { maxSessionLimit?: number; hostPoolType?: string } };
      const pool: PoolProps = await this.arm
        .raw<PoolProps>(hostPoolId, API.desktopVirtualization)
        .catch(() => ({}) as PoolProps);
      const perHostLimit =
        pool.properties?.maxSessionLimit ?? (pool.properties?.hostPoolType === "Personal" ? 1 : 0);

      batch.sessionSnapshots!.push({
        ts,
        hostPoolId,
        tenantId: this.tenantId,
        activeSessions: userSessions.length > 0 ? active : totalSessions,
        disconnectedSessions: disconnected,
        capacity: perHostLimit > 0 ? availableHosts * perHostLimit : totalSessions,
        availableHosts,
        totalHosts: hosts.length,
      });
    }
    return batch;
  }

  async logs(input: SyncInput): Promise<SyncBatch> {
    const window = logWindow(input);
    const batch: SyncBatch = { connections: [], errors: [], perf: [] };
    // Perf rows arrive with a computer name, so build a host → pool map first.
    const hostToPool = await this.hostToPoolMap(input.hostPoolIds);

    for (const workspace of input.workspaces) {
      const poolFallback = workspace.hostPoolIds.length === 1 ? workspace.hostPoolIds[0]! : null;

      const [connections, errors, perf] = await Promise.all([
        kql<ConnectionRow>(
          this.token,
          this.tokenTenantId,
          workspace.workspaceId,
          withWindow(CONNECTIONS_QUERY, window),
          window,
        ).catch((err) => this.logQueryFailure<ConnectionRow>(err, workspace.workspaceId, "WVDConnections")),
        kql<ErrorRow>(this.token, this.tokenTenantId, workspace.workspaceId, ERRORS_QUERY, window).catch(
          (err) => this.logQueryFailure<ErrorRow>(err, workspace.workspaceId, "WVDErrors"),
        ),
        kql<PerfRow>(this.token, this.tokenTenantId, workspace.workspaceId, PERF_QUERY, window).catch(
          () => [] as PerfRow[],
        ),
      ]);

      for (const row of connections) {
        if (!row.CorrelationId || !row.Ts) continue;
        const hostPoolId = row.PoolId ? normalizeResourceId(row.PoolId) : poolFallback;
        batch.connections!.push({
          correlationId: row.CorrelationId,
          tenantId: this.tenantId,
          hostPoolId,
          ts: new Date(row.Ts).toISOString(),
          user: row.UserName ?? "unknown",
          sessionHost: row.SessionHostName ? shortHostName(row.SessionHostName) : null,
          clientOs: row.ClientOS ?? null,
          clientType: row.ClientType ?? null,
          clientVersion: row.ClientVersion ?? null,
          gatewayRegion: row.GatewayRegion ?? null,
          state: row.ConnState === "connected" ? "connected" : "failed",
          connectMs: nonNegative(row.ConnectMs),
          rttMs: nonNegative(row.RttMs),
          bandwidthKbps: nonNegative(row.BandwidthKbps),
          durationSec: nonNegative(row.DurationSec),
        });
      }

      for (const row of errors) {
        if (!row.TimeGenerated) continue;
        const ts = new Date(row.TimeGenerated).toISOString();
        const code = String(row.Code ?? "Unknown");
        batch.errors!.push({
          key: hashKey([this.tenantId, row.CorrelationId ?? "", ts, code, row.Source ?? ""]),
          ts,
          tenantId: this.tenantId,
          hostPoolId: row.PoolId ? normalizeResourceId(row.PoolId) : poolFallback,
          correlationId: row.CorrelationId ?? null,
          code,
          source: row.Source ?? "Unknown",
          message: (row.Message ?? "").slice(0, 500),
          serviceError: Boolean(row.ServiceError),
        });
      }

      for (const row of perf) {
        if (!row.Computer || !row.Ts) continue;
        const host = shortHostName(row.Computer);
        batch.perf!.push({
          ts: new Date(row.Ts).toISOString(),
          tenantId: this.tenantId,
          hostPoolId: hostToPool.get(host) ?? poolFallback,
          sessionHost: host,
          cpuPct: typeof row.CpuPct === "number" ? row.CpuPct : null,
          memAvailableMb: typeof row.MemAvailableMb === "number" ? row.MemAvailableMb : null,
        });
      }
    }
    return batch;
  }

  async cost(input: SyncInput): Promise<SyncBatch> {
    const to = input.until;
    const from = input.since ?? new Date(to.getTime() - input.backfillDays * 86_400_000);
    const poolByResourceGroup = await this.resourceGroupToPoolMap(input.hostPoolIds);
    const costs: SyncBatch["costs"] = [];

    for (const subscriptionId of input.subscriptionIds) {
      const rows = await queryDailyCost(this.token, this.tokenTenantId, subscriptionId, { from, to }).catch(
        (err) => {
          this.log.warn({ err: (err as Error).message, subscriptionId }, "cost query failed");
          return [];
        },
      );
      costs.push(...attributeCost(rows, this.tenantId, poolByResourceGroup));
    }
    return { costs };
  }

  /** Probe the permissions this connector needs and explain what to fix. */
  async diagnose(opts: { subscriptionIds: string[] }): Promise<DiagnosticCheck[]> {
    const checks: DiagnosticCheck[] = [];

    let subscriptions: { subscriptionId: string; displayName: string }[] = [];
    try {
      subscriptions = await this.arm.listSubscriptions();
      checks.push(
        check(
          "arm-token",
          "Sign in to Azure Resource Manager",
          "pass",
          `${subscriptions.length} subscription(s) visible`,
        ),
      );
    } catch (err) {
      const e = err as ConnectorError;
      checks.push(
        check(
          "arm-token",
          "Sign in to Azure Resource Manager",
          "fail",
          e.message,
          e.hint ?? "Check the tenant id, client id and secret.",
        ),
      );
      return checks;
    }

    const subs = opts.subscriptionIds.length
      ? opts.subscriptionIds
      : subscriptions.map((s) => s.subscriptionId);
    if (subs.length === 0) {
      checks.push(
        check(
          "subscriptions",
          "Find subscriptions",
          "fail",
          "No subscriptions are visible to this identity",
          "Assign at least Reader on the subscriptions that contain AVD, or select them explicitly.",
        ),
      );
      return checks;
    }

    let pools: { resourceId: string; name: string }[] = [];
    try {
      pools = (await Promise.all(subs.slice(0, 10).map((sub) => this.arm.listHostPools(sub)))).flat();
      checks.push(
        check(
          "host-pools",
          "Read AVD host pools",
          pools.length > 0 ? "pass" : "warn",
          pools.length > 0
            ? `${pools.length} host pool(s) found`
            : "No host pools found in these subscriptions",
          pools.length > 0 ? undefined : "Assign Desktop Virtualization Reader where the host pools live.",
        ),
      );
    } catch (err) {
      const e = err as ConnectorError;
      checks.push(
        check(
          "host-pools",
          "Read AVD host pools",
          "fail",
          e.message,
          "Assign the Desktop Virtualization Reader role.",
        ),
      );
    }

    if (pools.length > 0) {
      try {
        await this.arm.listSessionHosts(pools[0]!.resourceId);
        checks.push(check("session-hosts", "Read session hosts", "pass"));
      } catch (err) {
        checks.push(
          check(
            "session-hosts",
            "Read session hosts",
            "fail",
            (err as Error).message,
            "Desktop Virtualization Reader covers session hosts; check it is assigned at the resource group or subscription.",
          ),
        );
      }

      const workspaceIds = await this.arm.diagnosticWorkspaces(pools[0]!.resourceId).catch(() => []);
      if (workspaceIds.length === 0) {
        checks.push(
          check(
            "diagnostics",
            "AVD diagnostics sent to Log Analytics",
            "warn",
            "No diagnostic settings found on the first host pool",
            "Without diagnostics there are no connections, errors or latency to chart. Enable diagnostic settings on each host pool and send them to a Log Analytics workspace.",
          ),
        );
      } else {
        checks.push(
          check(
            "diagnostics",
            "AVD diagnostics sent to Log Analytics",
            "pass",
            `${workspaceIds.length} workspace(s)`,
          ),
        );
        const info = await this.arm.workspaceCustomerId(workspaceIds[0]!).catch(() => null);
        if (!info) {
          checks.push(
            check(
              "workspace-read",
              "Read the Log Analytics workspace",
              "fail",
              "Could not read the workspace resource",
              "Assign Log Analytics Reader on the workspace (or its resource group).",
            ),
          );
        } else {
          try {
            const probe = await kql<{ Table: string; Rows: number }>(
              this.token,
              this.tokenTenantId,
              info.workspaceId,
              TABLE_PROBE_QUERY,
              { from: new Date(Date.now() - 7 * 86_400_000), to: new Date() },
            );
            const found = probe.filter((row) => Number(row.Rows) > 0).map((row) => row.Table);
            checks.push(
              check(
                "la-query",
                "Query AVD logs",
                found.includes("WVDConnections") ? "pass" : "warn",
                found.length > 0
                  ? `Tables with data: ${found.join(", ")}`
                  : "No AVD tables have data in the last 7 days",
                found.includes("WVDConnections")
                  ? undefined
                  : "Enable the Connection, Error, Checkpoint and NetworkData categories in the host pool diagnostic settings.",
              ),
            );
          } catch (err) {
            checks.push(
              check(
                "la-query",
                "Query AVD logs",
                "fail",
                (err as Error).message,
                "Assign Log Analytics Reader so this app can run queries against the workspace.",
              ),
            );
          }
        }
      }
    }

    try {
      await queryDailyCost(this.token, this.tokenTenantId, subs[0]!, {
        from: new Date(Date.now() - 3 * 86_400_000),
        to: new Date(),
      });
      checks.push(check("cost", "Read cost data", "pass"));
    } catch (err) {
      checks.push(
        check(
          "cost",
          "Read cost data",
          "warn",
          (err as Error).message,
          "Optional. Assign Cost Management Reader on the subscription to chart spend.",
        ),
      );
    }

    return checks;
  }

  private async hostToPoolMap(hostPoolIds: string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    for (const hostPoolId of hostPoolIds) {
      const hosts = await this.arm.listSessionHosts(hostPoolId).catch(() => []);
      for (const host of hosts) map.set(shortHostName(host.name), hostPoolId);
    }
    return map;
  }

  private async resourceGroupToPoolMap(hostPoolIds: string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    for (const hostPoolId of hostPoolIds) {
      const hosts = await this.arm.listSessionHosts(hostPoolId).catch(() => []);
      for (const host of hosts) {
        const rg = host.vmResourceId ? parseResourceId(host.vmResourceId).resourceGroup : undefined;
        if (rg) map.set(rg.toLowerCase(), hostPoolId);
      }
      // The host pool's own resource group counts too (it holds the pool and app groups).
      const poolRg = parseResourceId(hostPoolId).resourceGroup;
      if (poolRg && !map.has(poolRg.toLowerCase())) map.set(poolRg.toLowerCase(), hostPoolId);
    }
    return map;
  }

  private logQueryFailure<T>(err: unknown, _workspaceId: string, table: string): T[] {
    this.log.warn({ err: (err as Error).message, table }, "log analytics query failed");
    return [];
  }
}

export function hostHealthFrom(
  hosts: SessionHostRecord[],
  hostPoolId: string,
  tenantId: string,
  ts: string,
): HostHealthRecord[] {
  return hosts.map((host) => ({
    ts,
    tenantId,
    hostPoolId,
    sessionHost: host.name,
    status: host.status,
    healthy: isHealthy(host.status),
    drain: !host.allowNewSession,
    sessions: host.sessions,
  }));
}

/** Snapshots line up on 5-minute boundaries so concurrency sums across pools. */
export function roundToFiveMinutes(date: Date): Date {
  const ms = 5 * 60_000;
  return new Date(Math.floor(date.getTime() / ms) * ms);
}

/** Re-read a little of the previous window so late-arriving rows are not missed. */
export function logWindow(input: SyncInput): { from: Date; to: Date } {
  const OVERLAP_MS = 2 * 3600_000;
  const from = input.since
    ? new Date(input.since.getTime() - OVERLAP_MS)
    : new Date(input.until.getTime() - input.backfillDays * 86_400_000);
  return { from, to: input.until };
}

function nonNegative(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

export function hashKey(parts: string[]): string {
  return createHash("sha1").update(parts.join("|")).digest("base64url").slice(0, 27);
}

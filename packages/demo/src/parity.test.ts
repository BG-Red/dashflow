import { beforeAll, describe, expect, test } from "bun:test";
import type { Access, QueryRequest } from "@dashflow/core";
import { createDb, schema } from "@dashflow/db";
import { runMigrations } from "@dashflow/db/migrate";
import { sql } from "drizzle-orm";
import { runQuery } from "../../../apps/server/src/query/engine";
import { buildDataset, type Dataset } from "./dataset";
import { evaluate } from "./evaluator";

/**
 * The hosted demo computes its numbers in JavaScript because it has no database. This test
 * loads one generated dataset into real Postgres, runs the same questions through the SQL
 * engine and the JavaScript evaluator, and fails if they disagree.
 *
 * Without this, the demo drifts from the product and nobody notices until someone deploys.
 * Run it with TEST_DATABASE_URL set.
 */
const url = process.env.TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

const UNTIL = new Date("2026-09-15T00:00:00Z");
const FROM = new Date(UNTIL.getTime() - 7 * 86_400_000);
const CONNECTION_ID = "dddddddd-0000-4000-8000-00000000000d";

maybe("demo evaluator matches the SQL engine", () => {
  const { db, client } = createDb({ url: url ?? "postgres://invalid", max: 2 });
  let data: Dataset;
  /** tenantId (as generated) → customer_tenants.id (as stored). */
  const tenantRowId = new Map<string, string>();

  const access: Access = { role: "owner", tenantScope: null };

  const request = (overrides: Partial<QueryRequest>): QueryRequest => ({
    metric: "connections.count",
    viz: "kpi",
    topN: 8,
    grain: "hour",
    from: FROM,
    to: UNTIL,
    tenantIds: null,
    filters: {},
    compare: false,
    ...overrides,
  });

  /** The SQL engine keys tenants by row id; the evaluator uses the generated tenant id. */
  const forSql = (input: QueryRequest): QueryRequest => ({
    ...input,
    tenantIds: input.tenantIds ? input.tenantIds.map((id) => tenantRowId.get(id) ?? id) : null,
  });

  beforeAll(async () => {
    data = buildDataset({ tenants: 2, days: 10, until: UNTIL });

    await runMigrations(db, () => {});
    await db.execute(sql`truncate connection_facts, session_snapshots, host_health, perf_hourly, cost_daily,
      error_facts, host_pools, session_hosts, customer_tenants, connections cascade`);

    await db.insert(schema.connections).values({
      id: CONNECTION_ID,
      name: "parity",
      type: "demo",
      config: { type: "demo", tenants: 2 },
      schedule: {
        inventoryMinutes: 60,
        sessionsMinutes: 5,
        logsMinutes: 15,
        costHours: 24,
        backfillDays: 30,
        retentionDays: 180,
      },
    });

    for (const tenant of data.tenants) {
      const [row] = await db
        .insert(schema.customerTenants)
        .values({
          connectionId: CONNECTION_ID,
          tenantId: tenant.id,
          displayName: tenant.displayName,
          domain: tenant.domain,
        })
        .returning({ id: schema.customerTenants.id });
      tenantRowId.set(tenant.id, row!.id);
    }

    await db.insert(schema.hostPools).values(
      data.pools.map((pool) => ({
        resourceId: pool.resourceId,
        customerTenantId: tenantRowId.get(pool.tenantId)!,
        connectionId: CONNECTION_ID,
        subscriptionId: pool.subscriptionId,
        name: pool.name,
        friendlyName: pool.friendlyName ?? null,
        location: pool.location,
        poolType: pool.poolType,
        maxSessions: pool.maxSessions ?? null,
      })),
    );

    const chunked = async <T>(rows: T[], insert: (batch: T[]) => Promise<unknown>) => {
      for (let i = 0; i < rows.length; i += 1000) await insert(rows.slice(i, i + 1000));
    };

    await chunked(data.snapshots, (batch) =>
      db.insert(schema.sessionSnapshots).values(
        batch.map((row) => ({
          ts: new Date(row.ts),
          hostPoolId: row.hostPoolId,
          tenantId: tenantRowId.get(row.tenantId)!,
          activeSessions: row.activeSessions,
          disconnectedSessions: row.disconnectedSessions,
          capacity: row.capacity,
          availableHosts: row.availableHosts,
          totalHosts: row.totalHosts,
        })),
      ),
    );

    await chunked(data.hostHealth, (batch) =>
      db.insert(schema.hostHealth).values(
        batch.map((row) => ({
          ts: new Date(row.ts),
          sessionHost: row.sessionHost,
          hostPoolId: row.hostPoolId,
          tenantId: tenantRowId.get(row.tenantId)!,
          status: row.status,
          healthy: row.healthy,
          drain: row.drain,
          sessions: row.sessions,
        })),
      ),
    );

    await chunked(data.connections, (batch) =>
      db.insert(schema.connectionFacts).values(
        batch.map((row) => ({
          correlationId: row.correlationId,
          tenantId: tenantRowId.get(row.tenantId)!,
          hostPoolId: row.hostPoolId,
          ts: new Date(row.ts),
          // The parity check is about aggregation, so the user key passes through unhashed.
          userKey: row.user,
          sessionHost: row.sessionHost ?? null,
          clientOs: row.clientOs ?? null,
          clientType: row.clientType ?? null,
          clientVersion: row.clientVersion ?? null,
          gatewayRegion: row.gatewayRegion ?? null,
          state: row.state,
          connectMs: row.connectMs ?? null,
          rttMs: row.rttMs ?? null,
          bandwidthKbps: row.bandwidthKbps ?? null,
          durationSec: row.durationSec ?? null,
        })),
      ),
    );

    await chunked(data.errors, (batch) =>
      db.insert(schema.errorFacts).values(
        batch.map((row) => ({
          key: row.key,
          tenantId: tenantRowId.get(row.tenantId)!,
          hostPoolId: row.hostPoolId,
          ts: new Date(row.ts),
          code: row.code,
          source: row.source,
          message: row.message,
          serviceError: row.serviceError,
        })),
      ),
    );

    await chunked(data.perf, (batch) =>
      db.insert(schema.perfHourly).values(
        batch.map((row) => ({
          ts: new Date(row.ts),
          sessionHost: row.sessionHost,
          hostPoolId: row.hostPoolId,
          tenantId: tenantRowId.get(row.tenantId)!,
          cpuPct: row.cpuPct ?? null,
          memAvailableMb: row.memAvailableMb ?? null,
        })),
      ),
    );

    await chunked(data.costs, (batch) =>
      db.insert(schema.costDaily).values(
        batch.map((row) => ({
          key: `${row.tenantId}|${row.date}|${row.hostPoolId ?? "-"}|${row.meterCategory}`,
          ts: new Date(`${row.date}T00:00:00Z`),
          day: row.date,
          tenantId: tenantRowId.get(row.tenantId)!,
          hostPoolId: row.hostPoolId,
          meterCategory: row.meterCategory,
          cost: row.cost.toFixed(4),
          currency: row.currency,
          estimatedSavings: row.estimatedSavings != null ? row.estimatedSavings.toFixed(4) : null,
        })),
      ),
    );
  });

  const close = (a: number | null | undefined, b: number | null | undefined, label: string) => {
    if (a == null || b == null) {
      expect(`${label}: ${a}`).toBe(`${label}: ${b}`);
      return;
    }
    // Postgres numerics and JS floats differ in the last bits; anything larger is a real gap.
    expect(Math.abs(a - b)).toBeLessThan(Math.max(1e-6, Math.abs(a) * 1e-9));
  };

  const SCALAR_METRICS = [
    "connections.count",
    "users.unique",
    "connections.failed",
    "connections.success_rate",
    "connect.p95",
    "rtt.median",
    "errors.count",
    "sessions.active",
    "sessions.peak",
    "capacity.utilization",
    "cpu.avg",
    "cost.total",
  ];

  for (const metric of SCALAR_METRICS) {
    test(`scalar: ${metric}`, async () => {
      const input = request({ metric, viz: "kpi" });
      const sqlResult = await runQuery(db, forSql(input), access, { tz: "UTC" });
      const jsResult = evaluate(data, input);
      expect(sqlResult.kind).toBe("scalar");
      if (sqlResult.kind === "scalar" && jsResult.kind === "scalar") {
        close(sqlResult.value, jsResult.value, metric);
      }
    });
  }

  test("series with a split match bucket for bucket", async () => {
    const input = request({ metric: "connections.count", viz: "line", groupBy: "clientOs", topN: 3 });
    const sqlResult = await runQuery(db, forSql(input), access, { tz: "UTC" });
    const jsResult = evaluate(data, input);
    if (sqlResult.kind !== "series" || jsResult.kind !== "series") throw new Error("expected series");

    expect(jsResult.series.map((series) => series.name).sort()).toEqual(
      sqlResult.series.map((series) => series.name).sort(),
    );
    for (const series of sqlResult.series) {
      const mirror = jsResult.series.find((candidate) => candidate.name === series.name)!;
      expect(mirror.points.length).toBe(series.points.length);
      for (const [index, point] of series.points.entries()) {
        expect(mirror.points[index]!.ts).toBe(point.ts);
        close(point.value, mirror.points[index]!.value, `${series.name}@${point.ts}`);
      }
    }
  });

  test("breakdowns agree on both order and value", async () => {
    const input = request({ metric: "errors.count", viz: "bar", groupBy: "errorCode", topN: 5 });
    const sqlResult = await runQuery(db, forSql(input), access, { tz: "UTC" });
    const jsResult = evaluate(data, input);
    if (sqlResult.kind !== "breakdown" || jsResult.kind !== "breakdown")
      throw new Error("expected breakdown");
    expect(jsResult.items.map((item) => item.name)).toEqual(sqlResult.items.map((item) => item.name));
    for (const [index, item] of sqlResult.items.entries()) {
      close(item.value, jsResult.items[index]!.value, item.name);
    }
  });

  test("heatmaps agree cell for cell", async () => {
    const input = request({ metric: "sessions.active", viz: "heatmap" });
    const sqlResult = await runQuery(db, forSql(input), access, { tz: "UTC" });
    const jsResult = evaluate(data, input);
    if (sqlResult.kind !== "heatmap" || jsResult.kind !== "heatmap") throw new Error("expected heatmap");
    expect(jsResult.cells.length).toBe(sqlResult.cells.length);
    for (const cell of sqlResult.cells) {
      const mirror = jsResult.cells.find(
        (candidate) => candidate.day === cell.day && candidate.hour === cell.hour,
      );
      expect(mirror).toBeDefined();
      close(cell.value, mirror!.value, `${cell.day}@${cell.hour}`);
    }
  });

  test("a dimension filter narrows both the same way", async () => {
    const input = request({
      metric: "connections.count",
      viz: "kpi",
      filters: { dims: { clientOs: ["macOS"] } },
    });
    const sqlResult = await runQuery(db, forSql(input), access, { tz: "UTC" });
    const jsResult = evaluate(data, input);
    if (sqlResult.kind === "scalar" && jsResult.kind === "scalar") {
      close(sqlResult.value, jsResult.value, "clientOs filter");
      expect(sqlResult.value).toBeGreaterThan(0);
    }
    await client.end();
  });
});

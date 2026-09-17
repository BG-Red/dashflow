import { beforeAll, describe, expect, test } from "bun:test";
import type { Access, QueryRequest } from "@avd/core";
import { createDb, schema } from "@avd/db";
import { runMigrations } from "@avd/db/migrate";
import { sql } from "drizzle-orm";
import { QueryError, runQuery } from "./engine";

/**
 * These tests run real SQL, because the thing worth proving — that a Viewer scoped to one
 * customer cannot read another, and that filter values cannot break out into SQL — only
 * holds end to end. Set TEST_DATABASE_URL to run them:
 *   TEST_DATABASE_URL=postgres://user@localhost:5432/avd_test bun test
 */
const url = process.env.TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

maybe("query engine", () => {
  const { db, client } = createDb({ url: url ?? "postgres://invalid", max: 2 });
  const tenantA = "aaaaaaaa-0000-4000-8000-000000000001";
  const tenantB = "bbbbbbbb-0000-4000-8000-000000000002";
  const poolA =
    "/subscriptions/s/resourcegroups/a/providers/microsoft.desktopvirtualization/hostpools/pool-a";
  const poolB =
    "/subscriptions/s/resourcegroups/b/providers/microsoft.desktopvirtualization/hostpools/pool-b";
  const from = new Date("2026-09-10T00:00:00Z");
  const to = new Date("2026-09-11T00:00:00Z");

  const request = (overrides: Partial<QueryRequest> = {}): QueryRequest => ({
    metric: "connections.count",
    viz: "kpi",
    topN: 8,
    grain: "hour",
    from,
    to,
    tenantIds: null,
    filters: {},
    compare: false,
    ...overrides,
  });

  const all: Access = { role: "owner", tenantScope: null };
  const onlyA: Access = { role: "viewer", tenantScope: [tenantA] };

  beforeAll(async () => {
    await runMigrations(db, () => {});
    // A clean slate for each run; every fixture id is a placeholder GUID.
    await db.execute(sql`truncate connection_facts, session_snapshots, host_pools, customer_tenants,
      connections, error_facts, host_health, perf_hourly, cost_daily cascade`);

    const [connection] = await db
      .insert(schema.connections)
      .values({
        name: "test",
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
      })
      .returning({ id: schema.connections.id });

    await db.insert(schema.customerTenants).values([
      { id: tenantA, connectionId: connection!.id, tenantId: "tenant-a", displayName: "Customer A" },
      { id: tenantB, connectionId: connection!.id, tenantId: "tenant-b", displayName: "Customer B" },
    ]);
    await db.insert(schema.hostPools).values([
      {
        resourceId: poolA,
        customerTenantId: tenantA,
        name: "pool-a",
        location: "eastus",
        poolType: "Pooled",
      },
      {
        resourceId: poolB,
        customerTenantId: tenantB,
        name: "pool-b",
        location: "eastus",
        poolType: "Pooled",
      },
    ]);

    // 10 connections for A (2 failed), 4 for B.
    const facts = [
      ...Array.from({ length: 10 }, (_, i) => ({
        correlationId: `a-${i}`,
        tenantId: tenantA,
        hostPoolId: poolA,
        ts: new Date(from.getTime() + i * 3600_000),
        userKey: `user-${i % 5}`,
        clientOs: i % 2 === 0 ? "Windows 11" : "macOS",
        state: (i < 2 ? "failed" : "connected") as "failed" | "connected",
        connectMs: 1000 + i * 100,
      })),
      ...Array.from({ length: 4 }, (_, i) => ({
        correlationId: `b-${i}`,
        tenantId: tenantB,
        hostPoolId: poolB,
        ts: new Date(from.getTime() + i * 3600_000),
        userKey: `other-${i}`,
        clientOs: "Windows 11",
        state: "connected" as const,
        connectMs: 5000,
      })),
    ];
    await db.insert(schema.connectionFacts).values(facts);
  });

  test("an unrestricted user sees every customer", async () => {
    const result = await runQuery(db, request(), all);
    expect(result.kind).toBe("scalar");
    if (result.kind === "scalar") expect(result.value).toBe(14);
  });

  test("a scoped viewer only ever sees their own customer", async () => {
    const result = await runQuery(db, request(), onlyA);
    if (result.kind === "scalar") expect(result.value).toBe(10);
  });

  test("a scoped viewer asking for someone else's tenant gets nothing, not everything", async () => {
    const result = await runQuery(db, request({ tenantIds: [tenantB] }), onlyA);
    // Zero rows, and emphatically not the 14 an unscoped query returns.
    if (result.kind === "scalar") expect(result.value).toBe(0);
  });

  test("a host pool filter cannot reach across the tenant scope", async () => {
    const result = await runQuery(db, request({ filters: { hostPools: [poolB] } }), onlyA);
    if (result.kind === "scalar") expect(result.value).toBe(0);
  });

  test("filter values are parameters, not SQL", async () => {
    const nasty = "Windows 11'; drop table connection_facts; --";
    const result = await runQuery(db, request({ filters: { dims: { clientOs: [nasty] } } }), all);
    // Treated as a literal value that matches nothing.
    if (result.kind === "scalar") expect(result.value).toBe(0);
    // The table is still there, and still has every row.
    const check = await runQuery(db, request(), all);
    if (check.kind === "scalar") expect(check.value).toBe(14);
  });

  test("dimension filters work for the legitimate case", async () => {
    const result = await runQuery(db, request({ filters: { dims: { clientOs: ["macOS"] } } }), all);
    if (result.kind === "scalar") expect(result.value).toBe(5);
  });

  test("series are gap-filled across the whole range", async () => {
    const result = await runQuery(db, request({ viz: "line", metric: "connections.count" }), all);
    expect(result.kind).toBe("series");
    if (result.kind === "series") {
      expect(result.series).toHaveLength(1);
      // 24 hourly buckets plus the closing boundary.
      expect(result.series[0]!.points.length).toBeGreaterThanOrEqual(24);
      expect(result.series[0]!.points.some((point) => point.value === null)).toBe(true);
    }
  });

  test("breakdowns rank groups and honour topN", async () => {
    const result = await runQuery(db, request({ viz: "bar", groupBy: "tenant", topN: 1 }), all);
    if (result.kind === "breakdown") {
      expect(result.items).toHaveLength(1);
      expect(result.items[0]!.name).toBe("Customer A");
    }
  });

  test("a rate metric computes from the same rows", async () => {
    const result = await runQuery(db, request({ metric: "connections.success_rate" }), onlyA);
    if (result.kind === "scalar") expect(result.value).toBeCloseTo(80, 5);
  });

  test("an unknown metric or a wrong visualization is refused", async () => {
    await expect(runQuery(db, request({ metric: "nope" }), all)).rejects.toThrow(QueryError);
    await expect(runQuery(db, request({ metric: "sessions.peak", viz: "donut" }), all)).rejects.toThrow(
      QueryError,
    );
  });

  test("an empty range is refused", async () => {
    await expect(runQuery(db, request({ from: to, to: from }), all)).rejects.toThrow(/empty/);
  });

  test("an invalid time zone never reaches SQL", async () => {
    await expect(
      runQuery(db, request({ viz: "line" }), all, { tz: "'; drop table users; --" }),
    ).rejects.toThrow(/time zone/);
  });

  test("disabling a customer hides its data immediately", async () => {
    await db.execute(sql`update customer_tenants set enabled = false where id = ${tenantB}::uuid`);
    const result = await runQuery(db, request(), all);
    if (result.kind === "scalar") expect(result.value).toBe(10);
    await db.execute(sql`update customer_tenants set enabled = true where id = ${tenantB}::uuid`);
    await client.end();
  });
});

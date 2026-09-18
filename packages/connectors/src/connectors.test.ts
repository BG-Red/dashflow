import { afterEach, describe, expect, test } from "bun:test";
import { createArmClient } from "./azure/arm";
import { hashKey, isHealthy, logWindow, roundToFiveMinutes } from "./azure/collectors";
import { attributeCost } from "./azure/cost";
import { createNerdioConnector, normalizeNerdioHostPool, normalizeNerdioSessionHost } from "./nerdio";
import { buildConsentUrl } from "./partner-center";
import type { ConnectorLogger, SyncInput } from "./types";

const silentLog: ConnectorLogger = { debug() {}, info() {}, warn() {}, error() {} };
const token = async () => "fake-token";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Stub the global fetch with a URL → JSON map, and record what was requested. */
function stubFetch(routes: Record<string, unknown>) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    const match = Object.keys(routes).find((key) => url.includes(key));
    if (!match) return new Response("not found", { status: 404, statusText: "Not Found" });
    return new Response(JSON.stringify(routes[match]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return calls;
}

describe("host health rules", () => {
  test("a shut down host is not a fault, an unavailable one is", () => {
    expect(isHealthy("Available")).toBe(true);
    expect(isHealthy("Shutdown")).toBe(true);
    expect(isHealthy("Unavailable(VMNotRunning)")).toBe(true);
    expect(isHealthy("Unavailable")).toBe(false);
    expect(isHealthy("NeedsAssistance")).toBe(false);
    expect(isHealthy("UpgradeFailed")).toBe(false);
  });
});

describe("incremental log windows", () => {
  const until = new Date("2026-09-17T12:00:00Z");
  const base: SyncInput = {
    stream: "logs",
    tenantId: "t",
    subscriptionIds: [],
    workspaces: [],
    hostPoolIds: [],
    until,
    backfillDays: 30,
  };

  test("the first run reaches back over the backfill window", () => {
    expect(logWindow(base).from.toISOString()).toBe("2026-08-18T12:00:00.000Z");
  });

  test("later runs overlap the previous window so late rows are not lost", () => {
    const since = new Date("2026-09-17T11:00:00Z");
    expect(logWindow({ ...base, since }).from.toISOString()).toBe("2026-09-17T09:00:00.000Z");
  });

  test("snapshots land on five minute boundaries so pools add up", () => {
    expect(roundToFiveMinutes(new Date("2026-09-17T12:07:43Z")).toISOString()).toBe(
      "2026-09-17T12:05:00.000Z",
    );
  });

  test("fact keys are stable and short", () => {
    const key = hashKey(["tenant", "corr", "2026-09-17T12:00:00Z", "Code", "RDAgent"]);
    expect(key).toBe(hashKey(["tenant", "corr", "2026-09-17T12:00:00Z", "Code", "RDAgent"]));
    expect(key).not.toBe(hashKey(["tenant", "corr", "2026-09-17T12:00:00Z", "Other", "RDAgent"]));
    expect(key.length).toBeLessThanOrEqual(27);
  });
});

describe("ARM normalization", () => {
  test("host pools become normalized records with lowercase resource ids", async () => {
    stubFetch({
      "Microsoft.DesktopVirtualization/hostPools": {
        value: [
          {
            id: "/subscriptions/SUB/resourceGroups/RG/providers/Microsoft.DesktopVirtualization/hostPools/HP-1",
            name: "HP-1",
            location: "eastus",
            properties: {
              friendlyName: "Sales desktops",
              hostPoolType: "Pooled",
              loadBalancerType: "BreadthFirst",
              maxSessionLimit: 8,
              startVMOnConnect: true,
            },
          },
        ],
      },
    });
    const arm = createArmClient(token, "tenant-1");
    const [pool] = await arm.listHostPools("sub-1");
    expect(pool!.resourceId).toBe(
      "/subscriptions/sub/resourcegroups/rg/providers/microsoft.desktopvirtualization/hostpools/hp-1",
    );
    expect(pool!.friendlyName).toBe("Sales desktops");
    expect(pool!.maxSessions).toBe(8);
    expect(pool!.source).toBe("azure");
    expect(pool!.tenantId).toBe("tenant-1");
  });

  test("session host names lose the host pool prefix", async () => {
    stubFetch({
      sessionHosts: {
        value: [
          {
            id: "/subscriptions/s/resourceGroups/r/providers/Microsoft.DesktopVirtualization/hostPools/hp/sessionHosts/hp/vm-0.corp.example",
            name: "hp/vm-0.corp.example",
            properties: {
              status: "Available",
              allowNewSession: false,
              sessions: 3,
              agentVersion: "1.0.0",
              resourceId:
                "/subscriptions/S/resourceGroups/R/providers/Microsoft.Compute/virtualMachines/vm-0",
            },
          },
        ],
      },
    });
    const arm = createArmClient(token, "tenant-1");
    const [host] = await arm.listSessionHosts("/subscriptions/s/hostpools/hp");
    expect(host!.name).toBe("vm-0.corp.example");
    expect(host!.allowNewSession).toBe(false);
    expect(host!.sessions).toBe(3);
    expect(host!.vmResourceId).toContain("microsoft.compute/virtualmachines/vm-0");
  });

  test("throttling is retried and does not surface as an error", async () => {
    let calls = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL) => {
      calls++;
      if (calls === 1) {
        return new Response("{}", {
          status: 429,
          statusText: "Too Many Requests",
          headers: { "retry-after": "0" },
        });
      }
      return new Response(JSON.stringify({ value: [] }), { status: 200 });
    }) as typeof fetch;
    const arm = createArmClient(token, "tenant-1");
    expect(await arm.listHostPools("sub-1")).toEqual([]);
    expect(calls).toBe(2);
  });
});

describe("cost attribution", () => {
  test("resource group cost is folded into host pools and unmatched cost is kept", () => {
    const rows = [
      {
        day: "2026-09-16",
        resourceGroup: "rg-avd",
        meterCategory: "Virtual Machines",
        cost: 10,
        currency: "USD",
      },
      {
        day: "2026-09-16",
        resourceGroup: "rg-avd",
        meterCategory: "Virtual Machines",
        cost: 5,
        currency: "USD",
      },
      { day: "2026-09-16", resourceGroup: "rg-other", meterCategory: "Storage", cost: 2, currency: "USD" },
    ];
    const result = attributeCost(rows, "tenant-1", new Map([["rg-avd", "pool-1"]]));
    expect(result).toHaveLength(2);
    const pooled = result.find((row) => row.hostPoolId === "pool-1")!;
    expect(pooled.cost).toBe(15);
    expect(result.find((row) => row.hostPoolId === null)!.cost).toBe(2);
  });
});

describe("Partner Center consent", () => {
  test("the consent url asks for offline access and the partner scopes", () => {
    const url = new URL(
      buildConsentUrl({
        partnerTenantId: "00000000-0000-0000-0000-000000000001",
        clientId: "00000000-0000-0000-0000-000000000002",
        redirectUri: "https://example.invalid/api/connections/consent/callback",
        state: "state-1",
      }),
    );
    expect(url.origin).toBe("https://login.microsoftonline.com");
    expect(url.pathname).toContain("00000000-0000-0000-0000-000000000001");
    const scope = url.searchParams.get("scope")!;
    expect(scope).toContain("offline_access");
    expect(scope).toContain("api.partnercenter.microsoft.com/user_impersonation");
    expect(scope).toContain("management.azure.com/user_impersonation");
    expect(url.searchParams.get("state")).toBe("state-1");
  });
});

describe("Nerdio connector", () => {
  const config = {
    type: "nerdio" as const,
    edition: "msp" as const,
    baseUrl: "https://nerdio.invalid",
    tenantId: "00000000-0000-0000-0000-000000000001",
    clientId: "00000000-0000-0000-0000-000000000002",
    scope: "api://00000000-0000-0000-0000-000000000003/.default",
    credentialMode: "client-secret" as const,
    endpoints: {},
  };

  test("a host pool without an ARM id gets one built from subscription, resource group and name", () => {
    const pool = normalizeNerdioHostPool(
      {
        name: "hp-contoso",
        subscriptionId: "00000000-0000-0000-0000-0000000000ff",
        resourceGroup: "RG-AVD",
        maxSessionLimit: 6,
        autoScaleEnabled: true,
        region: "eastus",
      },
      { tenantKey: "00000000-0000-0000-0000-00000000000a" },
    )!;
    // Matching Azure's id exactly is what lets Nerdio and Azure data merge on one row.
    expect(pool.resourceId).toBe(
      "/subscriptions/00000000-0000-0000-0000-0000000000ff/resourcegroups/rg-avd/providers/microsoft.desktopvirtualization/hostpools/hp-contoso",
    );
    expect(pool.maxSessions).toBe(6);
    expect(pool.autoscaleEnabled).toBe(true);
    expect(pool.location).toBe("eastus");
    expect(pool.source).toBe("nerdio");
  });

  test("an explicit ARM id wins and is lowercased", () => {
    const pool = normalizeNerdioHostPool(
      {
        name: "HP",
        armId: "/subscriptions/S/resourceGroups/R/providers/Microsoft.DesktopVirtualization/hostPools/HP",
      },
      { tenantKey: "t" },
    )!;
    expect(pool.resourceId).toBe(
      "/subscriptions/s/resourcegroups/r/providers/microsoft.desktopvirtualization/hostpools/hp",
    );
  });

  test("a pool with nothing to build an ARM id from is skipped rather than guessed at", () => {
    expect(normalizeNerdioHostPool({ name: "hp-orphan" }, { tenantKey: "t" })).toBeNull();
    expect(
      normalizeNerdioHostPool({ subscriptionId: "s", resourceGroup: "r" }, { tenantKey: "t" }),
    ).toBeNull();
  });

  test("session hosts are keyed under their pool and tolerate alternate field names", () => {
    const host = normalizeNerdioSessionHost(
      {
        hostName: "hp/vm-3.corp.example",
        sessionCount: 2,
        healthStatus: "Available",
        allowNewSessions: false,
      },
      { resourceId: "/subscriptions/s/hostpools/hp", tenantId: "t" },
    );
    expect(host.name).toBe("vm-3");
    expect(host.hostPoolId).toBe("/subscriptions/s/hostpools/hp");
    expect(host.sessions).toBe(2);
    expect(host.status).toBe("Available");
    expect(host.allowNewSession).toBe(false);
  });

  test("a missing secret fails the test with an actionable message", async () => {
    const connector = createNerdioConnector(config, { log: silentLog, secret: null });
    const checks = await connector.test();
    expect(checks[0]!.status).toBe("fail");
    expect(checks[0]!.fix).toContain("client secret");
  });
});

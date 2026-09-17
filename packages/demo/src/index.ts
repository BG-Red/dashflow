import type {
  ConnectionFactRecord,
  CostRecord,
  ErrorFactRecord,
  HostHealthRecord,
  HostPoolRecord,
  PerfRecord,
  SessionHostRecord,
  SessionSnapshotRecord,
  SyncBatch,
} from "@avd/core";

/**
 * Synthetic AVD data for demo mode, screenshots and tests. Every name here is a Microsoft
 * sample company, every GUID is a placeholder, and nothing in this file comes from a real
 * tenant — that is deliberate, so the repo and its screenshots stay free of customer data.
 */

const COMPANIES = [
  { name: "Contoso Ltd", domain: "contoso.onmicrosoft.com" },
  { name: "Fabrikam Inc", domain: "fabrikam.onmicrosoft.com" },
  { name: "Adatum Corporation", domain: "adatum.onmicrosoft.com" },
  { name: "Northwind Traders", domain: "northwind.onmicrosoft.com" },
  { name: "Tailspin Toys", domain: "tailspin.onmicrosoft.com" },
  { name: "Wide World Importers", domain: "wideworld.onmicrosoft.com" },
  { name: "Proseware Inc", domain: "proseware.onmicrosoft.com" },
  { name: "Woodgrove Bank", domain: "woodgrove.onmicrosoft.com" },
];

const POOL_BLUEPRINTS = [
  {
    suffix: "desktops-eus",
    location: "eastus",
    type: "Pooled",
    hosts: 8,
    maxSessions: 8,
    gateway: "us-east",
  },
  { suffix: "apps-eus", location: "eastus", type: "Pooled", hosts: 4, maxSessions: 12, gateway: "us-east" },
  {
    suffix: "engineering-weu",
    location: "westeurope",
    type: "Personal",
    hosts: 6,
    maxSessions: 1,
    gateway: "eu-west",
  },
  {
    suffix: "callcenter-cus",
    location: "centralus",
    type: "Pooled",
    hosts: 10,
    maxSessions: 10,
    gateway: "us-central",
  },
];

const CLIENT_OS = ["Windows 11", "Windows 10", "macOS", "iOS", "Android", "Web"] as const;
const CLIENT_TYPE = ["Desktop", "Web", "Mobile"] as const;
const ERROR_CODES = [
  { code: "ConnectionFailedClientDisconnect", source: "Client", service: false },
  { code: "ConnectionFailedNoHealthyRdshAvailable", source: "RdGateway", service: true },
  { code: "AgentHealthDomainTrustRelationshipLost", source: "RDAgent", service: false },
  { code: "ConnectionFailedAvNotAvailable", source: "RdBroker", service: true },
  { code: "FslogixProfileLoadFailed", source: "RDAgent", service: false },
  { code: "SessionHostUnhealthyFslogixHealthCheckFailed", source: "RDAgent", service: false },
];
const METER_CATEGORIES: { name: string; share: number }[] = [
  { name: "Virtual Machines", share: 0.72 },
  { name: "Storage", share: 0.14 },
  { name: "Bandwidth", share: 0.05 },
  { name: "Virtual Network", share: 0.04 },
  { name: "Azure Monitor", share: 0.05 },
];

/** Small deterministic PRNG so demo data is stable across restarts. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFrom(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export interface DemoTenant {
  tenantId: string;
  displayName: string;
  domain: string;
  subscriptionId: string;
  pools: DemoPool[];
}

export interface DemoPool {
  resourceId: string;
  name: string;
  location: string;
  poolType: string;
  maxSessions: number;
  hostCount: number;
  gateway: string;
  /** Scales usage so tenants differ from each other. */
  scale: number;
}

const GUID_PREFIX = "00000000-0000-4000-8000-0000000000";

function guid(index: number): string {
  return `${GUID_PREFIX}${index.toString().padStart(2, "0")}`;
}

export function demoTenants(count: number): DemoTenant[] {
  return COMPANIES.slice(0, Math.min(count, COMPANIES.length)).map((company, index) => {
    const random = mulberry32(seedFrom(company.name));
    const slug = company.name.toLowerCase().split(" ")[0]!;
    const subscriptionId = guid(20 + index);
    const poolCount = 2 + Math.floor(random() * 3);
    const pools = POOL_BLUEPRINTS.slice(0, poolCount).map((blueprint) => {
      const name = `hp-${slug}-${blueprint.suffix}`;
      return {
        resourceId:
          `/subscriptions/${subscriptionId}/resourcegroups/rg-avd-${slug}/providers/` +
          `microsoft.desktopvirtualization/hostpools/${name}`,
        name,
        location: blueprint.location,
        poolType: blueprint.type,
        maxSessions: blueprint.maxSessions,
        hostCount: blueprint.hosts,
        gateway: blueprint.gateway,
        scale: 0.6 + random() * 0.9,
      } satisfies DemoPool;
    });
    return {
      tenantId: guid(index + 1),
      displayName: company.name,
      domain: company.domain,
      subscriptionId,
      pools,
    };
  });
}

/** Weekday business-hours shape, in the 0..1 range. */
function usageShape(date: Date, random: () => number): number {
  const day = date.getUTCDay();
  const hour = date.getUTCHours() + date.getUTCMinutes() / 60;
  const weekend = day === 0 || day === 6 ? 0.12 : 1;
  // Two humps: morning ramp and afternoon peak, with a lunch dip.
  const morning = Math.exp(-((hour - 9.5) ** 2) / 8);
  const afternoon = Math.exp(-((hour - 14.5) ** 2) / 10);
  const base = Math.max(morning, afternoon * 0.95);
  return Math.max(0, Math.min(1, base * weekend * (0.9 + random() * 0.2)));
}

export function demoInventory(tenant: DemoTenant): SyncBatch {
  const hostPools: HostPoolRecord[] = [];
  const sessionHosts: SessionHostRecord[] = [];
  const hostHealth: HostHealthRecord[] = [];
  const ts = new Date().toISOString();

  for (const pool of tenant.pools) {
    const random = mulberry32(seedFrom(pool.name));
    hostPools.push({
      resourceId: pool.resourceId,
      tenantId: tenant.tenantId,
      subscriptionId: tenant.subscriptionId,
      name: pool.name,
      friendlyName: pool.name.replace(/^hp-/, "").replace(/-/g, " "),
      location: pool.location,
      poolType: pool.poolType,
      loadBalancer: pool.poolType === "Pooled" ? "BreadthFirst" : null,
      maxSessions: pool.maxSessions,
      startVmOnConnect: pool.poolType === "Personal",
      validationEnvironment: false,
      preferredAppGroupType: pool.poolType === "Personal" ? "Desktop" : "RailApplications",
      autoscaleEnabled: random() > 0.3,
      source: "demo",
    });

    const hosts = demoHosts(tenant, pool, new Date());
    sessionHosts.push(...hosts);
    hostHealth.push(
      ...hosts.map((host) => ({
        ts,
        tenantId: tenant.tenantId,
        hostPoolId: pool.resourceId,
        sessionHost: host.name,
        status: host.status,
        healthy: host.status === "Available" || host.status === "Shutdown",
        drain: !host.allowNewSession,
        sessions: host.sessions,
      })),
    );
  }
  return { hostPools, sessionHosts, hostHealth };
}

function demoHosts(tenant: DemoTenant, pool: DemoPool, at: Date): SessionHostRecord[] {
  const random = mulberry32(seedFrom(`${pool.name}|hosts`));
  const shape = usageShape(at, random);
  const running = Math.max(1, Math.round(pool.hostCount * Math.max(0.25, shape)));

  return Array.from({ length: pool.hostCount }, (_, index) => {
    const name = `${pool.name.replace("hp-", "vm-")}-${index}`;
    const isRunning = index < running;
    const roll = random();
    const status = !isRunning
      ? "Shutdown"
      : roll > 0.97
        ? "Unavailable"
        : roll > 0.94
          ? "UpgradeFailed"
          : "Available";
    return {
      resourceId: `${pool.resourceId}/sessionhosts/${name}`,
      hostPoolId: pool.resourceId,
      tenantId: tenant.tenantId,
      name,
      vmResourceId: `/subscriptions/${tenant.subscriptionId}/resourcegroups/rg-avd-${
        tenant.displayName.toLowerCase().split(" ")[0]
      }/providers/microsoft.compute/virtualmachines/${name}`,
      status,
      allowNewSession: !(roll > 0.9),
      sessions: status === "Available" ? Math.round(shape * pool.maxSessions * pool.scale * random()) : 0,
      agentVersion: "1.0.11742.1700",
      osVersion: "10.0.22621",
      lastHeartBeat: at.toISOString(),
      updateState: "Succeeded",
      source: "demo",
    } satisfies SessionHostRecord;
  });
}

const SNAPSHOT_INTERVAL_MS = 15 * 60_000;

export function demoSnapshots(tenant: DemoTenant, from: Date, to: Date): SessionSnapshotRecord[] {
  const out: SessionSnapshotRecord[] = [];
  for (const pool of tenant.pools) {
    const random = mulberry32(seedFrom(`${pool.name}|snap`));
    for (let t = alignTo(from, SNAPSHOT_INTERVAL_MS); t < to.getTime(); t += SNAPSHOT_INTERVAL_MS) {
      const at = new Date(t);
      const shape = usageShape(at, random);
      const availableHosts = Math.max(1, Math.round(pool.hostCount * Math.max(0.25, shape)));
      const active = Math.round(shape * pool.maxSessions * availableHosts * 0.55 * pool.scale);
      out.push({
        ts: at.toISOString(),
        hostPoolId: pool.resourceId,
        tenantId: tenant.tenantId,
        activeSessions: active,
        disconnectedSessions: Math.round(active * 0.12 * random()),
        capacity: availableHosts * pool.maxSessions,
        availableHosts,
        totalHosts: pool.hostCount,
      });
    }
  }
  return out;
}

/** Hourly host-health history, so the reliability dashboards have a trend to draw. */
export function demoHostHealth(tenant: DemoTenant, from: Date, to: Date): HostHealthRecord[] {
  const out: HostHealthRecord[] = [];
  for (const pool of tenant.pools) {
    const random = mulberry32(seedFrom(`${pool.name}|health`));
    for (let t = alignTo(from, 3600_000); t < to.getTime(); t += 3600_000) {
      const at = new Date(t);
      const shape = usageShape(at, random);
      const running = Math.max(1, Math.round(pool.hostCount * Math.max(0.25, shape)));
      for (let index = 0; index < pool.hostCount; index++) {
        const roll = random();
        const status =
          index >= running
            ? "Shutdown"
            : roll > 0.985
              ? "Unavailable"
              : roll > 0.975
                ? "NeedsAssistance"
                : "Available";
        out.push({
          ts: at.toISOString(),
          tenantId: tenant.tenantId,
          hostPoolId: pool.resourceId,
          sessionHost: `${pool.name.replace("hp-", "vm-")}-${index}`,
          status,
          healthy: status === "Available" || status === "Shutdown",
          drain: roll > 0.99,
          sessions: status === "Available" ? Math.round(shape * pool.maxSessions * random()) : 0,
        });
      }
    }
  }
  return out;
}

export function demoConnections(tenant: DemoTenant, from: Date, to: Date): ConnectionFactRecord[] {
  const out: ConnectionFactRecord[] = [];
  for (const pool of tenant.pools) {
    const random = mulberry32(seedFrom(`${pool.name}|conn`));
    const userCount = Math.max(6, Math.round(pool.hostCount * pool.maxSessions * 0.8 * pool.scale));

    for (let t = alignTo(from, 3600_000); t < to.getTime(); t += 3600_000) {
      const at = new Date(t);
      const shape = usageShape(at, random);
      const attempts = Math.round(shape * userCount * 0.35);
      // A rough patch every few days makes the reliability dashboards interesting.
      const badHour = Math.floor(t / 3600_000) % 173 === 0;

      for (let i = 0; i < attempts; i++) {
        const ts = new Date(t + Math.floor(random() * 3600_000));
        const failed = random() < (badHour ? 0.25 : 0.02);
        const userIndex = Math.floor(random() * userCount);
        const osIndex = Math.floor(random() ** 1.6 * CLIENT_OS.length);
        out.push({
          correlationId: `demo-${pool.name}-${ts.getTime()}-${i}`,
          tenantId: tenant.tenantId,
          hostPoolId: pool.resourceId,
          ts: ts.toISOString(),
          user: `user${String(userIndex).padStart(3, "0")}@${tenant.domain}`,
          sessionHost: `${pool.name.replace("hp-", "vm-")}-${Math.floor(random() * pool.hostCount)}`,
          clientOs: CLIENT_OS[osIndex] ?? "Windows 11",
          clientType: CLIENT_TYPE[Math.floor(random() ** 2 * CLIENT_TYPE.length)] ?? "Desktop",
          clientVersion: "1.2.5405",
          gatewayRegion: pool.gateway,
          state: failed ? "failed" : "connected",
          connectMs: failed ? null : Math.round(1200 + random() ** 2 * (badHour ? 18_000 : 6_000)),
          rttMs: Math.round(25 + random() ** 2 * (pool.gateway.startsWith("eu") ? 120 : 70)),
          bandwidthKbps: Math.round(2_000 + random() * 40_000),
          durationSec: failed ? null : Math.round(600 + random() ** 1.5 * 28_000),
        });
      }
    }
  }
  return out;
}

export function demoErrors(tenant: DemoTenant, from: Date, to: Date): ErrorFactRecord[] {
  const out: ErrorFactRecord[] = [];
  for (const pool of tenant.pools) {
    const random = mulberry32(seedFrom(`${pool.name}|err`));
    for (let t = alignTo(from, 3600_000); t < to.getTime(); t += 3600_000) {
      const at = new Date(t);
      const shape = usageShape(at, random);
      const badHour = Math.floor(t / 3600_000) % 173 === 0;
      const count = Math.round(shape * (badHour ? 14 : 1.5) * random());
      for (let i = 0; i < count; i++) {
        const error = ERROR_CODES[Math.floor(random() * ERROR_CODES.length)]!;
        const ts = new Date(t + Math.floor(random() * 3600_000));
        out.push({
          key: `demo-${pool.name}-${ts.getTime()}-${i}`,
          ts: ts.toISOString(),
          tenantId: tenant.tenantId,
          hostPoolId: pool.resourceId,
          correlationId: null,
          code: error.code,
          source: error.source,
          message: `${error.code} on ${pool.name}`,
          serviceError: error.service,
        });
      }
    }
  }
  return out;
}

export function demoPerf(tenant: DemoTenant, from: Date, to: Date): PerfRecord[] {
  const out: PerfRecord[] = [];
  for (const pool of tenant.pools) {
    const random = mulberry32(seedFrom(`${pool.name}|perf`));
    for (let t = alignTo(from, 3600_000); t < to.getTime(); t += 3600_000) {
      const at = new Date(t);
      const shape = usageShape(at, random);
      const running = Math.max(1, Math.round(pool.hostCount * Math.max(0.25, shape)));
      for (let index = 0; index < running; index++) {
        out.push({
          ts: at.toISOString(),
          tenantId: tenant.tenantId,
          hostPoolId: pool.resourceId,
          sessionHost: `${pool.name.replace("hp-", "vm-")}-${index}`,
          cpuPct: Math.min(99, 8 + shape * 60 + random() * 25),
          memAvailableMb: Math.max(400, 16_000 - shape * 9_000 - random() * 2_000),
        });
      }
    }
  }
  return out;
}

export function demoCosts(tenant: DemoTenant, from: Date, to: Date): CostRecord[] {
  const out: CostRecord[] = [];
  for (const pool of tenant.pools) {
    const random = mulberry32(seedFrom(`${pool.name}|cost`));
    for (let t = alignTo(from, 86_400_000); t < to.getTime(); t += 86_400_000) {
      const at = new Date(t);
      const weekend = at.getUTCDay() === 0 || at.getUTCDay() === 6;
      const daily = pool.hostCount * pool.scale * (weekend ? 18 : 46) * (0.9 + random() * 0.2);
      for (const meter of METER_CATEGORIES) {
        out.push({
          date: at.toISOString().slice(0, 10),
          tenantId: tenant.tenantId,
          hostPoolId: pool.resourceId,
          meterCategory: meter.name,
          cost: Number((daily * meter.share).toFixed(2)),
          currency: "USD",
          estimatedSavings:
            meter.name === "Virtual Machines"
              ? Number((daily * meter.share * (0.25 + random() * 0.2)).toFixed(2))
              : null,
        });
      }
    }
  }
  return out;
}

function alignTo(date: Date, intervalMs: number): number {
  return Math.ceil(date.getTime() / intervalMs) * intervalMs;
}

export function demoBatch(tenant: DemoTenant, stream: string, from: Date, to: Date): SyncBatch {
  switch (stream) {
    case "inventory":
      return demoInventory(tenant);
    case "sessions":
      return {
        ...demoInventory(tenant),
        sessionSnapshots: demoSnapshots(tenant, from, to),
        hostHealth: demoHostHealth(tenant, from, to),
      };
    case "logs":
      return {
        connections: demoConnections(tenant, from, to),
        errors: demoErrors(tenant, from, to),
        perf: demoPerf(tenant, from, to),
      };
    case "cost":
      return { costs: demoCosts(tenant, from, to) };
    default:
      return {};
  }
}

import type {
  ConnectionFactRecord,
  CostRecord,
  ErrorFactRecord,
  HostHealthRecord,
  HostPoolRecord,
  PerfRecord,
  SessionHostRecord,
  SessionSnapshotRecord,
} from "@dashflow/core";
import {
  demoConnections,
  demoCosts,
  demoErrors,
  demoHostHealth,
  demoInventory,
  demoPerf,
  demoSnapshots,
  demoTenants,
} from "./index";

/**
 * A complete synthetic estate, generated once and held in memory.
 *
 * This is what the hosted demo runs on, and what the parity test feeds to both the JavaScript
 * evaluator and the real SQL engine to prove they agree.
 */
export interface Dataset {
  tenants: { id: string; displayName: string; domain: string }[];
  pools: (HostPoolRecord & { tenantName: string })[];
  hosts: SessionHostRecord[];
  snapshots: SessionSnapshotRecord[];
  hostHealth: HostHealthRecord[];
  connections: ConnectionFactRecord[];
  errors: ErrorFactRecord[];
  perf: PerfRecord[];
  costs: CostRecord[];
}

export interface DatasetOptions {
  tenants?: number;
  days?: number;
  /** End of the window; defaults to now. */
  until?: Date;
}

export function buildDataset(options: DatasetOptions = {}): Dataset {
  const tenantCount = options.tenants ?? 4;
  const days = options.days ?? 30;
  const until = options.until ?? new Date();
  const from = new Date(until.getTime() - days * 86_400_000);

  const dataset: Dataset = {
    tenants: [],
    pools: [],
    hosts: [],
    snapshots: [],
    hostHealth: [],
    connections: [],
    errors: [],
    perf: [],
    costs: [],
  };

  for (const tenant of demoTenants(tenantCount)) {
    dataset.tenants.push({ id: tenant.tenantId, displayName: tenant.displayName, domain: tenant.domain });

    const inventory = demoInventory(tenant);
    for (const pool of inventory.hostPools ?? []) {
      dataset.pools.push({ ...pool, tenantName: tenant.displayName });
    }
    dataset.hosts.push(...(inventory.sessionHosts ?? []));

    dataset.snapshots.push(...demoSnapshots(tenant, from, until));
    dataset.hostHealth.push(...demoHostHealth(tenant, from, until));
    dataset.connections.push(...demoConnections(tenant, from, until));
    dataset.errors.push(...demoErrors(tenant, from, until));
    dataset.perf.push(...demoPerf(tenant, from, until));
    dataset.costs.push(...demoCosts(tenant, from, until));
  }

  return dataset;
}

export function poolLabel(pool: { friendlyName?: string | null; name: string }): string {
  return pool.friendlyName ?? pool.name;
}

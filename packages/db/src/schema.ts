import type {
  ConnectionConfig,
  DashboardSpec,
  DiagnosticCheck,
  Role,
  SyncSchedule,
  WidgetSpec,
} from "@avd/core";
import { relations, sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const now = () => ts("created_at").notNull().defaultNow();

// ─── instance, users, access ────────────────────────────────────────────────────

/** Instance-level key/value settings: setup progress, instance name, user pseudonymization. */
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Entra object id from the EasyAuth principal. */
    oid: text("oid").notNull(),
    tenantId: text("tenant_id").notNull(),
    email: text("email").notNull(),
    displayName: text("display_name"),
    disabled: boolean("disabled").notNull().default(false),
    createdAt: now(),
    lastSeenAt: ts("last_seen_at"),
  },
  (t) => [unique("users_oid_unique").on(t.oid)],
);

export const roleAssignments = pgTable(
  "role_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").$type<Role>().notNull(),
    /** null = all customers; otherwise limited to this customer tenant row. */
    customerTenantId: uuid("customer_tenant_id").references(() => customerTenants.id, {
      onDelete: "cascade",
    }),
    createdAt: now(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [index("role_assignments_user_idx").on(t.userId)],
);

// ─── secrets and connections ───────────────────────────────────────────────────

/**
 * Either an AES-256-GCM ciphertext (kind = "encrypted") or a pointer to a Key Vault
 * secret (kind = "keyvault"). Plaintext never lands in this table.
 */
export const secrets = pgTable("secrets", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: text("kind").$type<"encrypted" | "keyvault">().notNull(),
  ciphertext: text("ciphertext"),
  iv: text("iv"),
  authTag: text("auth_tag"),
  keyVaultSecretName: text("key_vault_secret_name"),
  createdAt: now(),
  rotatedAt: ts("rotated_at"),
});

export const connections = pgTable("connections", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  type: text("type").$type<ConnectionConfig["type"]>().notNull(),
  config: jsonb("config").$type<ConnectionConfig>().notNull(),
  schedule: jsonb("schedule").$type<SyncSchedule>().notNull(),
  secretId: uuid("secret_id").references(() => secrets.id, { onDelete: "set null" }),
  /** Partner Center refresh token, kept apart from the client secret. */
  refreshSecretId: uuid("refresh_secret_id").references(() => secrets.id, { onDelete: "set null" }),
  enabled: boolean("enabled").notNull().default(true),
  status: text("status").$type<"new" | "ok" | "degraded" | "error">().notNull().default("new"),
  lastTestedAt: ts("last_tested_at"),
  lastTest: jsonb("last_test").$type<DiagnosticCheck[]>(),
  lastSyncAt: ts("last_sync_at"),
  createdAt: now(),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
});

export const customerTenants = pgTable(
  "customer_tenants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    tenantId: text("tenant_id").notNull(),
    displayName: text("display_name").notNull(),
    domain: text("domain"),
    enabled: boolean("enabled").notNull().default(true),
    meta: jsonb("meta").$type<Record<string, unknown>>(),
    createdAt: now(),
  },
  (t) => [unique("customer_tenants_conn_tenant").on(t.connectionId, t.tenantId)],
);

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerTenantId: uuid("customer_tenant_id")
      .notNull()
      .references(() => customerTenants.id, { onDelete: "cascade" }),
    subscriptionId: text("subscription_id").notNull(),
    displayName: text("display_name").notNull(),
    enabled: boolean("enabled").notNull().default(true),
  },
  (t) => [unique("subscriptions_tenant_sub").on(t.customerTenantId, t.subscriptionId)],
);

export const logAnalyticsWorkspaces = pgTable(
  "log_analytics_workspaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerTenantId: uuid("customer_tenant_id")
      .notNull()
      .references(() => customerTenants.id, { onDelete: "cascade" }),
    resourceId: text("resource_id").notNull(),
    /** The workspace "customerId" GUID used by api.loganalytics.io. */
    workspaceId: text("workspace_id").notNull(),
    name: text("name").notNull(),
    hostPoolIds: jsonb("host_pool_ids").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    enabled: boolean("enabled").notNull().default(true),
  },
  (t) => [unique("la_workspaces_tenant_resource").on(t.customerTenantId, t.resourceId)],
);

// ─── sync plumbing ─────────────────────────────────────────────────────────────

export const jobs = pgTable(
  "jobs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    type: text("type").notNull(),
    /** Deduplicates queued work, e.g. "logs:<connectionId>:<tenantId>". */
    dedupeKey: text("dedupe_key"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    runAt: ts("run_at").notNull().defaultNow(),
    status: text("status").$type<"queued" | "running" | "done" | "failed">().notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    lockedAt: ts("locked_at"),
    lockedBy: text("locked_by"),
    lastError: text("last_error"),
    createdAt: now(),
  },
  (t) => [
    index("jobs_claim_idx").on(t.status, t.runAt),
    unique("jobs_dedupe_unique").on(t.dedupeKey, t.status).nullsNotDistinct(),
  ],
);

export const syncRuns = pgTable(
  "sync_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    customerTenantId: uuid("customer_tenant_id").references(() => customerTenants.id, {
      onDelete: "cascade",
    }),
    stream: text("stream").notNull(),
    status: text("status").$type<"running" | "ok" | "partial" | "error">().notNull(),
    startedAt: ts("started_at").notNull().defaultNow(),
    finishedAt: ts("finished_at"),
    stats: jsonb("stats").$type<Record<string, number>>(),
    error: text("error"),
  },
  (t) => [index("sync_runs_recent_idx").on(t.startedAt)],
);

export const watermarks = pgTable(
  "watermarks",
  {
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    customerTenantId: uuid("customer_tenant_id")
      .notNull()
      .references(() => customerTenants.id, { onDelete: "cascade" }),
    stream: text("stream").notNull(),
    value: ts("value").notNull(),
  },
  (t) => [primaryKey({ columns: [t.connectionId, t.customerTenantId, t.stream] })],
);

// ─── AVD inventory ─────────────────────────────────────────────────────────────

export const hostPools = pgTable(
  "host_pools",
  {
    /** Lowercased ARM resource id — the join key for every fact table. */
    resourceId: text("resource_id").primaryKey(),
    customerTenantId: uuid("customer_tenant_id")
      .notNull()
      .references(() => customerTenants.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id").references(() => connections.id, { onDelete: "set null" }),
    subscriptionId: text("subscription_id"),
    name: text("name").notNull(),
    friendlyName: text("friendly_name"),
    location: text("location").notNull().default("unknown"),
    poolType: text("pool_type").notNull().default("Pooled"),
    loadBalancer: text("load_balancer"),
    maxSessions: integer("max_sessions"),
    startVmOnConnect: boolean("start_vm_on_connect"),
    validationEnvironment: boolean("validation_environment"),
    preferredAppGroupType: text("preferred_app_group_type"),
    autoscaleEnabled: boolean("autoscale_enabled"),
    sources: jsonb("sources").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    enabled: boolean("enabled").notNull().default(true),
    firstSeenAt: now(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("host_pools_tenant_idx").on(t.customerTenantId)],
);

export const sessionHosts = pgTable(
  "session_hosts",
  {
    resourceId: text("resource_id").primaryKey(),
    hostPoolId: text("host_pool_id")
      .notNull()
      .references(() => hostPools.resourceId, { onDelete: "cascade" }),
    customerTenantId: uuid("customer_tenant_id")
      .notNull()
      .references(() => customerTenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    vmResourceId: text("vm_resource_id"),
    status: text("status").notNull().default("Unknown"),
    allowNewSession: boolean("allow_new_session").notNull().default(true),
    sessions: integer("sessions").notNull().default(0),
    agentVersion: text("agent_version"),
    osVersion: text("os_version"),
    lastHeartBeat: ts("last_heart_beat"),
    updateState: text("update_state"),
    source: text("source").notNull().default("azure"),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("session_hosts_pool_idx").on(t.hostPoolId)],
);

export const appGroups = pgTable("app_groups", {
  resourceId: text("resource_id").primaryKey(),
  customerTenantId: uuid("customer_tenant_id")
    .notNull()
    .references(() => customerTenants.id, { onDelete: "cascade" }),
  hostPoolId: text("host_pool_id").references(() => hostPools.resourceId, { onDelete: "set null" }),
  name: text("name").notNull(),
  groupType: text("group_type").notNull().default("Desktop"),
  workspaceId: text("workspace_id"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const scalingPlans = pgTable("scaling_plans", {
  resourceId: text("resource_id").primaryKey(),
  customerTenantId: uuid("customer_tenant_id")
    .notNull()
    .references(() => customerTenants.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  timeZone: text("time_zone"),
  hostPoolIds: jsonb("host_pool_ids").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  schedules: integer("schedules").notNull().default(0),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

// ─── facts ─────────────────────────────────────────────────────────────────────

export const sessionSnapshots = pgTable(
  "session_snapshots",
  {
    ts: ts("ts").notNull(),
    hostPoolId: text("host_pool_id")
      .notNull()
      .references(() => hostPools.resourceId, { onDelete: "cascade" }),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => customerTenants.id, { onDelete: "cascade" }),
    activeSessions: integer("active_sessions").notNull().default(0),
    disconnectedSessions: integer("disconnected_sessions").notNull().default(0),
    capacity: integer("capacity").notNull().default(0),
    availableHosts: integer("available_hosts").notNull().default(0),
    totalHosts: integer("total_hosts").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.ts, t.hostPoolId] }),
    index("session_snapshots_tenant_ts").on(t.tenantId, t.ts),
  ],
);

export const connectionFacts = pgTable(
  "connection_facts",
  {
    correlationId: text("correlation_id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => customerTenants.id, { onDelete: "cascade" }),
    hostPoolId: text("host_pool_id").references(() => hostPools.resourceId, { onDelete: "set null" }),
    ts: ts("ts").notNull(),
    /** UPN, or a salted hash of it when pseudonymization is on (the default). */
    userKey: text("user_key").notNull(),
    sessionHost: text("session_host"),
    clientOs: text("client_os"),
    clientType: text("client_type"),
    clientVersion: text("client_version"),
    gatewayRegion: text("gateway_region"),
    state: text("state").$type<"connected" | "failed">().notNull(),
    connectMs: integer("connect_ms"),
    rttMs: integer("rtt_ms"),
    bandwidthKbps: integer("bandwidth_kbps"),
    durationSec: integer("duration_sec"),
  },
  (t) => [
    index("connection_facts_tenant_ts").on(t.tenantId, t.ts),
    index("connection_facts_pool_ts").on(t.hostPoolId, t.ts),
  ],
);

export const errorFacts = pgTable(
  "error_facts",
  {
    key: text("key").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => customerTenants.id, { onDelete: "cascade" }),
    hostPoolId: text("host_pool_id").references(() => hostPools.resourceId, { onDelete: "set null" }),
    ts: ts("ts").notNull(),
    correlationId: text("correlation_id"),
    code: text("code").notNull(),
    source: text("source"),
    message: text("message"),
    serviceError: boolean("service_error").notNull().default(false),
  },
  (t) => [index("error_facts_tenant_ts").on(t.tenantId, t.ts), index("error_facts_code").on(t.code)],
);

export const hostHealth = pgTable(
  "host_health",
  {
    ts: ts("ts").notNull(),
    sessionHost: text("session_host").notNull(),
    hostPoolId: text("host_pool_id")
      .notNull()
      .references(() => hostPools.resourceId, { onDelete: "cascade" }),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => customerTenants.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    healthy: boolean("healthy").notNull(),
    drain: boolean("drain").notNull().default(false),
    sessions: integer("sessions").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.ts, t.hostPoolId, t.sessionHost] }),
    index("host_health_tenant_ts").on(t.tenantId, t.ts),
  ],
);

export const perfHourly = pgTable(
  "perf_hourly",
  {
    ts: ts("ts").notNull(),
    sessionHost: text("session_host").notNull(),
    hostPoolId: text("host_pool_id").references(() => hostPools.resourceId, { onDelete: "cascade" }),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => customerTenants.id, { onDelete: "cascade" }),
    cpuPct: doublePrecision("cpu_pct"),
    memAvailableMb: doublePrecision("mem_available_mb"),
  },
  (t) => [
    primaryKey({ columns: [t.ts, t.sessionHost] }),
    index("perf_hourly_tenant_ts").on(t.tenantId, t.ts),
  ],
);

export const costDaily = pgTable(
  "cost_daily",
  {
    key: text("key").primaryKey(),
    ts: ts("ts").notNull(),
    day: date("day").notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => customerTenants.id, { onDelete: "cascade" }),
    hostPoolId: text("host_pool_id").references(() => hostPools.resourceId, { onDelete: "set null" }),
    meterCategory: text("meter_category").notNull().default("Other"),
    cost: numeric("cost", { precision: 18, scale: 4 }).notNull(),
    currency: text("currency").notNull().default("USD"),
    estimatedSavings: numeric("estimated_savings", { precision: 18, scale: 4 }),
  },
  (t) => [index("cost_daily_tenant_ts").on(t.tenantId, t.ts)],
);

export const autoscaleEvents = pgTable(
  "autoscale_events",
  {
    key: text("key").primaryKey(),
    ts: ts("ts").notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => customerTenants.id, { onDelete: "cascade" }),
    hostPoolId: text("host_pool_id").references(() => hostPools.resourceId, { onDelete: "cascade" }),
    action: text("action").notNull(),
    hostsBefore: integer("hosts_before"),
    hostsAfter: integer("hosts_after"),
    detail: text("detail"),
  },
  (t) => [index("autoscale_events_tenant_ts").on(t.tenantId, t.ts)],
);

// ─── dashboards ────────────────────────────────────────────────────────────────

export const dashboards = pgTable(
  "dashboards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    goal: text("goal").$type<DashboardSpec["goal"]>().notNull().default("blank"),
    widgets: jsonb("widgets").$type<WidgetSpec[]>().notNull(),
    defaultPreset: text("default_preset").notNull().default("7d"),
    tenantScope: jsonb("tenant_scope").$type<string[] | null>(),
    visibility: text("visibility").$type<"private" | "shared">().notNull().default("private"),
    sharedWithRole: text("shared_with_role").$type<Role>().notNull().default("viewer"),
    ownerId: uuid("owner_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: now(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("dashboards_owner_idx").on(t.ownerId)],
);

export const connectionsRelations = relations(connections, ({ many }) => ({
  tenants: many(customerTenants),
}));

export const customerTenantsRelations = relations(customerTenants, ({ one, many }) => ({
  connection: one(connections, { fields: [customerTenants.connectionId], references: [connections.id] }),
  subscriptions: many(subscriptions),
  hostPools: many(hostPools),
}));

export const hostPoolsRelations = relations(hostPools, ({ one, many }) => ({
  tenant: one(customerTenants, { fields: [hostPools.customerTenantId], references: [customerTenants.id] }),
  hosts: many(sessionHosts),
}));

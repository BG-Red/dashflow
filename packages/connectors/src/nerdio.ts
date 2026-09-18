import type {
  DiagnosticCheck,
  Discovery,
  HostPoolRecord,
  NerdioConfig,
  SessionHostRecord,
  SyncBatch,
} from "@dashflow/core";
import { normalizeResourceId } from "@dashflow/core";
import { hostHealthFrom, isHealthy, roundToFiveMinutes } from "./azure/collectors";
import { createTokenFn } from "./azure/credentials";
import { httpJson, type TokenFn } from "./http";
import { type Connector, type ConnectorContext, ConnectorError, check, type SyncInput } from "./types";

/**
 * Nerdio Manager exposes a REST API whose paths differ between Manager for MSP (NMM) and
 * Manager for Enterprise (NME), and between versions. Rather than guess, the connector ships
 * these defaults, then verifies them against the instance's own Swagger document during the
 * connection test and tells the user which paths to override (connection config `endpoints`).
 *
 * Not affiliated with or endorsed by Nerdio.
 */
export const NERDIO_DEFAULT_ENDPOINTS = {
  /** MSP only: the customer accounts this instance manages. */
  accounts: "/rest-api/v1/accounts",
  hostPools: "/rest-api/v1/host-pool",
  sessionHosts: "/rest-api/v1/host-pool/{subscriptionId}/{resourceGroup}/{hostPoolName}/host",
  autoscaleConfig:
    "/rest-api/v1/host-pool/{subscriptionId}/{resourceGroup}/{hostPoolName}/auto-scale-configuration",
  /** Optional: only used when an instance exposes it. */
  costSummary: "",
} as const;

export type NerdioEndpointKey = keyof typeof NERDIO_DEFAULT_ENDPOINTS;

const SWAGGER_CANDIDATES = [
  "/swagger/v1/swagger.json",
  "/rest-api/swagger/v1/swagger.json",
  "/swagger/v1/swagger.yaml",
];

/** Compare paths ignoring parameter names: /a/{x}/b matches /a/{id}/b. */
function pathShape(path: string): string {
  return path
    .replace(/\{[^}]+\}/g, "{}")
    .replace(/\/+$/, "")
    .toLowerCase();
}

function pick<T>(obj: Record<string, unknown>, keys: string[]): T | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (value !== undefined && value !== null && value !== "") return value as T;
  }
  return undefined;
}

function armHostPoolId(subscriptionId: string, resourceGroup: string, name: string): string {
  return normalizeResourceId(
    `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.DesktopVirtualization/hostPools/${name}`,
  );
}

/**
 * Pure normalizers, kept separate from the HTTP client so they can be tested against
 * recorded payload shapes without a live Nerdio instance.
 */
export function normalizeNerdioHostPool(
  row: Record<string, unknown>,
  ctx: { tenantKey: string; subscriptionFallback?: string },
): HostPoolRecord | null {
  const name = pick<string>(row, ["name", "hostPoolName", "poolName"]);
  const subscriptionId = pick<string>(row, ["subscriptionId", "subscription", "subscriptionGuid"]);
  const resourceGroup = pick<string>(row, ["resourceGroup", "resourceGroupName", "rg"]);
  const armId = pick<string>(row, ["armId", "resourceId", "id", "hostPoolArmPath"]);
  const resourceId = armId?.startsWith("/subscriptions/")
    ? normalizeResourceId(armId)
    : name && subscriptionId && resourceGroup
      ? armHostPoolId(subscriptionId, resourceGroup, name)
      : null;
  if (!resourceId || !name) return null;

  return {
    resourceId,
    tenantId: ctx.tenantKey,
    subscriptionId: subscriptionId ?? ctx.subscriptionFallback ?? "",
    name,
    friendlyName: pick<string>(row, ["friendlyName", "displayName"]) ?? null,
    location: pick<string>(row, ["location", "region"]) ?? "unknown",
    poolType: pick<string>(row, ["hostPoolType", "type", "poolType"]) ?? "Pooled",
    loadBalancer: pick<string>(row, ["loadBalancerType"]) ?? null,
    maxSessions: Number(pick<number>(row, ["maxSessionLimit", "maxSessions"]) ?? 0) || null,
    startVmOnConnect: pick<boolean>(row, ["startVmOnConnect", "startVMOnConnect"]) ?? null,
    validationEnvironment: pick<boolean>(row, ["validationEnvironment"]) ?? null,
    preferredAppGroupType: pick<string>(row, ["preferredAppGroupType"]) ?? null,
    autoscaleEnabled:
      pick<boolean>(row, ["autoScaleEnabled", "autoscaleEnabled", "isAutoScaleEnabled"]) ?? null,
    source: "nerdio",
  };
}

export function normalizeNerdioSessionHost(
  row: Record<string, unknown>,
  pool: Pick<HostPoolRecord, "resourceId" | "tenantId">,
): SessionHostRecord {
  const name = String(pick<string>(row, ["name", "hostName", "vmName", "sessionHostName"]) ?? "unknown");
  const short = name.includes("/") ? name.slice(name.indexOf("/") + 1) : name;
  const vmId = pick<string>(row, ["vmId", "vmArmId", "resourceId", "armId"]);
  return {
    resourceId: `${pool.resourceId}/sessionhosts/${short.toLowerCase()}`,
    hostPoolId: pool.resourceId,
    tenantId: pool.tenantId,
    name: short.split(".")[0]!.toLowerCase(),
    vmResourceId: vmId ? normalizeResourceId(vmId) : null,
    status: String(pick<string>(row, ["status", "healthStatus", "sessionHostStatus"]) ?? "Unknown"),
    allowNewSession: pick<boolean>(row, ["allowNewSession", "allowNewSessions"]) ?? true,
    sessions: Number(pick<number>(row, ["sessions", "sessionCount", "activeSessions"]) ?? 0),
    agentVersion: pick<string>(row, ["agentVersion"]) ?? null,
    osVersion: pick<string>(row, ["osVersion", "imageVersion"]) ?? null,
    lastHeartBeat: pick<string>(row, ["lastHeartBeat", "lastHeartbeat"]) ?? null,
    updateState: pick<string>(row, ["updateState"]) ?? null,
    source: "nerdio",
  };
}

interface NerdioAccount {
  id: string;
  name: string;
  tenantId?: string;
}

export function createNerdioConnector(config: NerdioConfig, ctx: ConnectorContext): Connector {
  const token: TokenFn = createTokenFn({
    mode: config.credentialMode,
    tenantId: config.tenantId,
    clientId: config.clientId,
    secret: ctx.secret,
  });
  const scope = config.scope.endsWith("/.default")
    ? config.scope
    : `${config.scope.replace(/\/$/, "")}/.default`;
  const endpoint = (key: NerdioEndpointKey): string => config.endpoints[key] ?? NERDIO_DEFAULT_ENDPOINTS[key];

  async function api<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    if (!path) throw new ConnectorError("This Nerdio endpoint is not configured for this instance");
    const filled = Object.entries(params).reduce(
      (acc, [key, value]) => acc.replace(`{${key}}`, encodeURIComponent(value)),
      path,
    );
    const accessToken = await token(scope, config.tenantId);
    return httpJson<T>(`${config.baseUrl}${filled}`, accessToken, {
      fetchImpl: ctx.fetch,
      timeoutMs: 60_000,
    });
  }

  function unwrap<T>(payload: unknown): T[] {
    if (Array.isArray(payload)) return payload as T[];
    if (payload && typeof payload === "object") {
      for (const key of ["items", "value", "data", "results", "hostPools", "hosts", "accounts"]) {
        const value = (payload as Record<string, unknown>)[key];
        if (Array.isArray(value)) return value as T[];
      }
    }
    return [];
  }

  async function accounts(): Promise<NerdioAccount[]> {
    if (config.edition !== "msp")
      return [{ id: "default", name: "Nerdio Manager", tenantId: config.tenantId }];
    const payload = await api<unknown>(endpoint("accounts"));
    return unwrap<Record<string, unknown>>(payload).map((row) => ({
      id: String(pick<string | number>(row, ["id", "accountId", "guid"]) ?? ""),
      name: String(pick<string>(row, ["name", "displayName", "accountName"]) ?? "Account"),
      tenantId: pick<string>(row, ["tenantId", "aadTenantId", "azureTenantId", "customerTenantId"]),
    }));
  }

  function tenantKey(account: NerdioAccount): string {
    return account.tenantId ?? `nerdio-account-${account.id}`;
  }

  async function hostPools(account: NerdioAccount): Promise<HostPoolRecord[]> {
    const payload = await api<unknown>(endpoint("hostPools"), { accountId: account.id });
    const pools: HostPoolRecord[] = [];
    for (const row of unwrap<Record<string, unknown>>(payload)) {
      const pool = normalizeNerdioHostPool(row, { tenantKey: tenantKey(account) });
      if (!pool) {
        ctx.log.warn({ account: account.name }, "skipped a Nerdio host pool with no Azure resource id");
        continue;
      }
      pools.push(pool);
    }
    return pools;
  }

  async function sessionHosts(account: NerdioAccount, pool: HostPoolRecord): Promise<SessionHostRecord[]> {
    const parts = pool.resourceId.split("/");
    const payload = await api<unknown>(endpoint("sessionHosts"), {
      accountId: account.id,
      subscriptionId: parts[2] ?? pool.subscriptionId,
      resourceGroup: parts[4] ?? "",
      hostPoolName: pool.name,
    });
    return unwrap<Record<string, unknown>>(payload).map((row) => normalizeNerdioSessionHost(row, pool));
  }

  async function swaggerPaths(): Promise<string[] | null> {
    const doFetch = ctx.fetch ?? fetch;
    const accessToken = await token(scope, config.tenantId).catch(() => null);
    for (const candidate of SWAGGER_CANDIDATES) {
      try {
        const response = await doFetch(`${config.baseUrl}${candidate}`, {
          headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {},
        });
        if (!response.ok) continue;
        const text = await response.text();
        if (candidate.endsWith(".json")) {
          const document = JSON.parse(text) as { paths?: Record<string, unknown> };
          if (document.paths) return Object.keys(document.paths);
        } else {
          // Minimal YAML scrape: collect top-level keys under "paths:".
          const matches = [...text.matchAll(/^\s{2}(\/[^\s:]+):/gm)].map((m) => m[1]!);
          if (matches.length > 0) return matches;
        }
      } catch {
        // try the next candidate
      }
    }
    return null;
  }

  return {
    type: "nerdio",

    async test(): Promise<DiagnosticCheck[]> {
      const checks: DiagnosticCheck[] = [];
      if (!ctx.secret) {
        return [
          check(
            "credential",
            "Nerdio API credential",
            "fail",
            "No secret is stored",
            "Re-enter the client secret.",
          ),
        ];
      }
      try {
        await token(scope, config.tenantId);
        checks.push(check("token", "Get a token for the Nerdio API", "pass", `scope ${scope}`));
      } catch (err) {
        return [
          check(
            "token",
            "Get a token for the Nerdio API",
            "fail",
            (err as Error).message,
            "Check the tenant id, client id, secret and the API scope from Nerdio Manager → Settings → Integrations → REST API.",
          ),
        ];
      }

      const paths = await swaggerPaths();
      if (!paths) {
        checks.push(
          check(
            "swagger",
            "Read the instance's API definition",
            "warn",
            "Could not fetch a Swagger document",
            "Not fatal — the default paths will be tried. If calls fail, note the correct paths from your instance's Swagger UI and set them as endpoint overrides.",
          ),
        );
      } else {
        const shapes = new Set(paths.map(pathShape));
        const needed: NerdioEndpointKey[] =
          config.edition === "msp"
            ? ["accounts", "hostPools", "sessionHosts"]
            : ["hostPools", "sessionHosts"];
        const missing = needed.filter((key) => !shapes.has(pathShape(endpoint(key))));
        const suggestions = paths.filter((p) => /host-?pool/i.test(p)).slice(0, 8);
        checks.push(
          check(
            "swagger",
            "Match API paths against this instance",
            missing.length === 0 ? "pass" : "warn",
            missing.length === 0
              ? `${paths.length} operations, all required paths present`
              : `These configured paths are not in the API definition: ${missing.join(", ")}`,
            missing.length === 0
              ? undefined
              : `Set endpoint overrides on this connection. Host pool paths this instance does expose: ${suggestions.join(", ") || "none found"}`,
          ),
        );
      }

      try {
        const list = await accounts();
        checks.push(
          check(
            "accounts",
            config.edition === "msp" ? "List Nerdio accounts" : "Reach the Nerdio API",
            list.length > 0 ? "pass" : "warn",
            `${list.length} account(s)`,
            list.length > 0 ? undefined : "The API responded but returned no accounts.",
          ),
        );
        const first = list[0];
        if (first) {
          const pools = await hostPools(first);
          checks.push(
            check(
              "host-pools",
              "Read host pools",
              pools.length > 0 ? "pass" : "warn",
              `${pools.length} host pool(s) in ${first.name}`,
              pools.length > 0
                ? undefined
                : "No host pools came back. Check the REST API user's scope in Nerdio.",
            ),
          );
          if (!first.tenantId) {
            checks.push(
              check(
                "tenant-mapping",
                "Map accounts to Entra tenants",
                "warn",
                "Nerdio did not report an Entra tenant id for this account",
                "Customers will be listed under a Nerdio account name instead of a tenant. Add an Azure or Lighthouse connection alongside this one to merge the data by ARM resource id.",
              ),
            );
          }
        }
      } catch (err) {
        const e = err as ConnectorError;
        checks.push(
          check(
            "accounts",
            "Call the Nerdio API",
            "fail",
            e.message,
            e.hint ?? "Confirm the base URL and that this app is allowed in Nerdio's REST API settings.",
          ),
        );
      }

      checks.push(
        check(
          "cost",
          "Cost and savings from Nerdio",
          config.endpoints.costSummary ? "pass" : "skip",
          config.endpoints.costSummary
            ? "Using the configured cost endpoint"
            : "No cost endpoint configured — add an Azure connection for spend, or set a costSummary override",
        ),
      );
      return checks;
    },

    async discover(): Promise<Discovery> {
      const list = await accounts();
      const discovery: Discovery = { tenants: [], subscriptions: [], workspaces: [], hostPoolCount: 0 };
      for (const account of list) {
        const pools = await hostPools(account).catch((err) => {
          ctx.log.warn({ err: (err as Error).message, account: account.name }, "could not list host pools");
          return [];
        });
        discovery.tenants.push({
          tenantId: tenantKey(account),
          displayName: account.name,
          meta: { nerdioAccountId: account.id, hostPools: pools.length, source: "nerdio" },
        });
        const subs = new Set(pools.map((pool) => pool.subscriptionId).filter(Boolean));
        discovery.subscriptions.push(
          ...[...subs].map((subscriptionId) => ({
            tenantId: tenantKey(account),
            subscriptionId,
            displayName: subscriptionId,
          })),
        );
        discovery.hostPoolCount += pools.length;
      }
      return discovery;
    },

    async sync(input: SyncInput): Promise<SyncBatch> {
      const list = await accounts();
      const account = list.find((a) => tenantKey(a) === input.tenantId);
      if (!account) return {};

      if (input.stream === "logs" || input.stream === "cost") {
        // Nerdio does not expose connection-level telemetry; those streams come from Azure.
        return {};
      }

      const pools = await hostPools(account);
      const batch: SyncBatch = { hostPools: pools, sessionHosts: [], hostHealth: [], sessionSnapshots: [] };
      const ts = roundToFiveMinutes(new Date()).toISOString();

      for (const pool of pools) {
        const hosts = await sessionHosts(account, pool).catch((err) => {
          ctx.log.warn(
            { err: (err as Error).message, pool: pool.name },
            "could not list Nerdio session hosts",
          );
          return [] as SessionHostRecord[];
        });
        batch.sessionHosts!.push(...hosts);
        batch.hostHealth!.push(...hostHealthFrom(hosts, pool.resourceId, pool.tenantId, ts));

        if (input.stream === "sessions" && hosts.length > 0) {
          const availableHosts = hosts.filter(
            (host) => isHealthy(host.status) && host.status !== "Shutdown",
          ).length;
          const sessions = hosts.reduce((sum, host) => sum + host.sessions, 0);
          batch.sessionSnapshots!.push({
            ts,
            hostPoolId: pool.resourceId,
            tenantId: pool.tenantId,
            activeSessions: sessions,
            disconnectedSessions: 0,
            capacity: pool.maxSessions ? availableHosts * pool.maxSessions : sessions,
            availableHosts,
            totalHosts: hosts.length,
          });
        }
      }
      return batch;
    },
  };
}

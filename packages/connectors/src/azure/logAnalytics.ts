import { httpJson, type TokenFn } from "../http";
import { ConnectorError } from "../types";
import { SCOPES } from "./credentials";

const LA_BASE = "https://api.loganalytics.io/v1";

interface LaTable {
  name: string;
  columns: { name: string; type: string }[];
  rows: unknown[][];
}

/** Run KQL against one workspace and return rows as objects. */
export async function kql<T extends Record<string, unknown>>(
  token: TokenFn,
  tenantId: string,
  workspaceId: string,
  query: string,
  timespan: { from: Date; to: Date },
): Promise<T[]> {
  const accessToken = await token(SCOPES.logAnalytics, tenantId);
  const body = {
    query,
    timespan: `${timespan.from.toISOString()}/${timespan.to.toISOString()}`,
  };
  const response = await httpJson<{ tables?: LaTable[]; error?: { message?: string } }>(
    `${LA_BASE}/workspaces/${workspaceId}/query`,
    accessToken,
    { method: "POST", body, timeoutMs: 180_000 },
  );
  if (response.error)
    throw new ConnectorError(`Log Analytics query failed: ${response.error.message ?? "unknown"}`);
  const table = response.tables?.find((t) => t.name === "PrimaryResult") ?? response.tables?.[0];
  if (!table) return [];
  return table.rows.map((row) => {
    const out: Record<string, unknown> = {};
    table.columns.forEach((column, index) => {
      out[column.name] = row[index];
    });
    return out as T;
  });
}

/** Which AVD tables exist and have recent data — used by the connection diagnostics. */
export const TABLE_PROBE_QUERY = `
let tables = dynamic(["WVDConnections","WVDErrors","WVDCheckpoints","WVDAgentHealthStatus","WVDConnectionNetworkData","Perf"]);
union isfuzzy=true
  (WVDConnections | where TimeGenerated > ago(7d) | summarize Rows = count() | extend Table = "WVDConnections"),
  (WVDErrors | where TimeGenerated > ago(7d) | summarize Rows = count() | extend Table = "WVDErrors"),
  (WVDConnectionNetworkData | where TimeGenerated > ago(7d) | summarize Rows = count() | extend Table = "WVDConnectionNetworkData"),
  (WVDAgentHealthStatus | where TimeGenerated > ago(7d) | summarize Rows = count() | extend Table = "WVDAgentHealthStatus"),
  (Perf | where TimeGenerated > ago(7d) | summarize Rows = count() | extend Table = "Perf")
| project Table, Rows`;

/**
 * One row per connection attempt. AVD writes several WVDConnections rows per connection
 * (Started / Connected / Completed) sharing a CorrelationId, so we fold them into one fact:
 * time to connect, session length, and whether it ever reached "connected".
 *
 * Rows are re-read with an overlap each run and upserted by CorrelationId, so a connection
 * that is still in progress at the end of a window gets corrected by the next run.
 */
export const CONNECTIONS_QUERY = `
let windowEnd = _endTime;
WVDConnections
| summarize
    StartTime = minif(TimeGenerated, State == "Started"),
    ConnectTime = minif(TimeGenerated, State == "Connected"),
    EndTime = maxif(TimeGenerated, State == "Completed"),
    UserName = take_any(UserName),
    SessionHostName = take_anyif(SessionHostName, isnotempty(SessionHostName)),
    ClientOS = take_anyif(ClientOS, isnotempty(ClientOS)),
    ClientType = take_anyif(ClientType, isnotempty(ClientType)),
    ClientVersion = take_anyif(ClientVersion, isnotempty(ClientVersion)),
    GatewayRegion = take_anyif(GatewayRegion, isnotempty(GatewayRegion)),
    PoolId = take_any(_ResourceId)
  by CorrelationId
| where isnotnull(ConnectTime) or isnotnull(EndTime) or StartTime < windowEnd - 15m
| extend ConnectMs = iff(isnotnull(ConnectTime) and isnotnull(StartTime), toint((ConnectTime - StartTime) / 1ms), int(null))
| extend DurationSec = iff(isnotnull(EndTime) and isnotnull(ConnectTime), toint((EndTime - ConnectTime) / 1s), int(null))
| extend ConnState = iff(isnotnull(ConnectTime), "connected", "failed")
| join kind=leftouter (
    WVDConnectionNetworkData
    | summarize RttMs = toint(percentile(EstRoundTripTimeInMs, 50)), BandwidthKbps = toint(avg(EstAvailableBandwidthKBps))
      by CorrelationId
  ) on CorrelationId
| project CorrelationId, Ts = coalesce(StartTime, ConnectTime, EndTime), UserName, SessionHostName,
          ClientOS, ClientType, ClientVersion, GatewayRegion, ConnState, ConnectMs, DurationSec, RttMs, BandwidthKbps, PoolId
| where isnotnull(Ts)
| take 200000`;

export const ERRORS_QUERY = `
WVDErrors
| extend Symbolic = tostring(column_ifexists("CodeSymbolic", ""))
| project TimeGenerated, CorrelationId, Code = iff(isempty(Symbolic), tostring(Code), Symbolic),
          Message = substring(tostring(Message), 0, 500), Source = tostring(Source),
          ServiceError = tobool(column_ifexists("ServiceError", false)), PoolId = _ResourceId
| take 200000`;

export const PERF_QUERY = `
Perf
| where (ObjectName == "Processor" and CounterName == "% Processor Time" and InstanceName == "_Total")
     or (ObjectName == "Memory" and CounterName == "Available MBytes")
| summarize CpuPct = avgif(CounterValue, CounterName == "% Processor Time"),
            MemAvailableMb = avgif(CounterValue, CounterName == "Available MBytes")
  by Computer, Ts = bin(TimeGenerated, 1h)
| where isnotnull(CpuPct) or isnotnull(MemAvailableMb)
| take 200000`;

export interface ConnectionRow extends Record<string, unknown> {
  CorrelationId: string;
  Ts: string;
  UserName?: string;
  SessionHostName?: string;
  ClientOS?: string;
  ClientType?: string;
  ClientVersion?: string;
  GatewayRegion?: string;
  ConnState: string;
  ConnectMs?: number | null;
  DurationSec?: number | null;
  RttMs?: number | null;
  BandwidthKbps?: number | null;
  PoolId?: string;
}

export interface ErrorRow extends Record<string, unknown> {
  TimeGenerated: string;
  CorrelationId?: string;
  Code?: string;
  Message?: string;
  Source?: string;
  ServiceError?: boolean;
  PoolId?: string;
}

export interface PerfRow extends Record<string, unknown> {
  Computer: string;
  Ts: string;
  CpuPct?: number | null;
  MemAvailableMb?: number | null;
}

/** `_endTime` is not a KQL builtin, so substitute it before sending. */
export function withWindow(query: string, window: { from: Date; to: Date }): string {
  return query.replace(/_endTime/g, `datetime(${window.to.toISOString()})`);
}

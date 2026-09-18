import type { CostRecord } from "@dashflow/core";
import { httpJson, type TokenFn } from "../http";
import { API } from "./arm";
import { SCOPES } from "./credentials";

interface CostQueryResponse {
  properties?: {
    columns?: { name: string; type: string }[];
    rows?: unknown[][];
  };
}

/**
 * Daily actual cost per resource group and meter category. Cost Management has no notion of
 * a host pool, so the caller maps resource groups to host pools using the session hosts'
 * VM resource ids — good enough for "what does this pool cost", and honest about it in the UI.
 */
export async function queryDailyCost(
  token: TokenFn,
  tenantId: string,
  subscriptionId: string,
  window: { from: Date; to: Date },
): Promise<{ day: string; resourceGroup: string; meterCategory: string; cost: number; currency: string }[]> {
  const accessToken = await token(SCOPES.arm, tenantId);
  const response = await httpJson<CostQueryResponse>(
    `https://management.azure.com/subscriptions/${subscriptionId}/providers/Microsoft.CostManagement/query?api-version=${API.costManagement}`,
    accessToken,
    {
      method: "POST",
      timeoutMs: 120_000,
      body: {
        type: "ActualCost",
        timeframe: "Custom",
        timePeriod: { from: window.from.toISOString(), to: window.to.toISOString() },
        dataset: {
          granularity: "Daily",
          aggregation: { totalCost: { name: "Cost", function: "Sum" } },
          grouping: [
            { type: "Dimension", name: "ResourceGroupName" },
            { type: "Dimension", name: "MeterCategory" },
          ],
        },
      },
    },
  );

  const columns = response.properties?.columns ?? [];
  const rows = response.properties?.rows ?? [];
  const index = (name: string) => columns.findIndex((c) => c.name.toLowerCase() === name.toLowerCase());
  const iCost = index("Cost");
  const iDate = index("UsageDate");
  const iRg = index("ResourceGroupName");
  const iMeter = index("MeterCategory");
  const iCurrency = index("Currency");

  return rows
    .map((row) => {
      // UsageDate comes back as the number 20260917.
      const rawDate = String(row[iDate] ?? "");
      const day =
        rawDate.length === 8
          ? `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}`
          : rawDate.slice(0, 10);
      return {
        day,
        resourceGroup: String(row[iRg] ?? "").toLowerCase(),
        meterCategory: String(row[iMeter] ?? "Other") || "Other",
        cost: Number(row[iCost] ?? 0),
        currency: String(row[iCurrency] ?? "USD"),
      };
    })
    .filter((row) => row.day.length === 10 && Number.isFinite(row.cost));
}

/** Turn resource-group level cost into per-host-pool cost using a resource group → pool map. */
export function attributeCost(
  rows: { day: string; resourceGroup: string; meterCategory: string; cost: number; currency: string }[],
  tenantId: string,
  poolByResourceGroup: Map<string, string>,
): CostRecord[] {
  const out = new Map<string, CostRecord>();
  for (const row of rows) {
    const hostPoolId = poolByResourceGroup.get(row.resourceGroup) ?? null;
    const key = `${tenantId}|${row.day}|${hostPoolId ?? "-"}|${row.meterCategory}`;
    const existing = out.get(key);
    if (existing) {
      existing.cost += row.cost;
      continue;
    }
    out.set(key, {
      date: row.day,
      tenantId,
      hostPoolId,
      meterCategory: row.meterCategory,
      cost: row.cost,
      currency: row.currency,
    });
  }
  return [...out.values()];
}

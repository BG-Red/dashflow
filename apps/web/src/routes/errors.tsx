import { formatUnit } from "@dashflow/core";
import { useQuery } from "@tanstack/react-query";
import { TriangleAlert, Users } from "lucide-react";
import { useState } from "react";
import { DrillDrawer, type DrillRequest } from "../components/drill-drawer";
import { PageHeader } from "../components/layout";
import { Badge, Card, CardHeader, DataTable, SegmentedControl } from "../components/ui";
import { api } from "../lib/api";
import { useScope } from "../lib/scope";
import { downloadCsv, formatRelative } from "../lib/utils";

const RANGES = [
  { value: "1", label: "24h" },
  { value: "7", label: "7d" },
  { value: "30", label: "30d" },
] as const;

/**
 * What is failing, ranked. Every row opens the actual error records behind it, and the busiest
 * users sit alongside because "who is affected" is the next question every time.
 */
export function ErrorsPage() {
  const scope = useScope();
  const [days, setDays] = useState<(typeof RANGES)[number]["value"]>("7");
  const [drill, setDrill] = useState<DrillRequest | null>(null);

  const errors = useQuery({ queryKey: ["error-groups", days], queryFn: () => api.errorGroups(Number(days)) });
  const users = useQuery({ queryKey: ["top-users", days], queryFn: () => api.topUsers(Number(days)) });

  const from = new Date(Date.now() - Number(days) * 86_400_000).toISOString();
  const to = new Date().toISOString();

  return (
    <>
      <PageHeader
        title="Errors and users"
        description="The error catalogue for your estate, and who is running into it."
        actions={
          <SegmentedControl
            ariaLabel="Range"
            value={days}
            onChange={(value) => setDays(value)}
            options={RANGES.map((range) => ({ value: range.value, label: range.label }))}
          />
        }
      />

      <Card className="mb-3">
        <CardHeader
          title="Error codes"
          subtitle="Grouped by code and source, most frequent first. Click a row for the records."
          actions={
            <button
              type="button"
              className="rounded-md px-2 py-1 text-[11px] text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]"
              onClick={() => downloadCsv(`errors-${days}d.csv`, errors.data?.groups ?? [])}
            >
              Export CSV
            </button>
          }
        />
        <DataTable
          rows={errors.data?.groups ?? []}
          rowKey={(row) => `${row.code}-${row.source}`}
          pageSize={20}
          empty={errors.isPending ? "Loading…" : "No errors in this range"}
          emptyDescription="Either nothing is failing, or host pool diagnostics are not flowing into Log Analytics yet."
          onRowClick={(row) =>
            setDrill({
              label: row.code,
              metric: "errors.count",
              groupBy: "errorCode",
              groupValue: row.code,
              tenantIds: scope.tenantIds,
              hostPools: scope.hostPools,
              rangeFrom: from,
              rangeTo: to,
            })
          }
          columns={[
            {
              key: "code",
              label: "Code",
              render: (row) => (
                <span className="flex items-center gap-1.5">
                  <TriangleAlert
                    size={13}
                    className={row.serviceError ? "text-[var(--warning)]" : "text-[var(--text-muted)]"}
                  />
                  <span className="font-medium">{row.code}</span>
                </span>
              ),
            },
            { key: "source", label: "Source" },
            {
              key: "serviceError",
              label: "Side",
              render: (row) =>
                row.serviceError ? <Badge tone="warning">service</Badge> : <Badge>customer</Badge>,
              sortValue: (row) => (row.serviceError ? 1 : 0),
            },
            { key: "hits", label: "Hits", numeric: true, render: (row) => row.hits.toLocaleString() },
            { key: "pools", label: "Pools", numeric: true },
            { key: "tenants", label: "Customers", numeric: true },
            {
              key: "lastSeen",
              label: "Last seen",
              render: (row) => formatRelative(row.lastSeen),
              sortValue: (row) => (row.lastSeen ? new Date(row.lastSeen).getTime() : 0),
            },
          ]}
        />
      </Card>

      <Card>
        <CardHeader
          title="Busiest users"
          subtitle={
            users.data?.pseudonymized
              ? "User names are hashed on this instance, so counts work without storing identities"
              : "Ranked by connections in the selected range"
          }
          actions={<Users size={14} className="text-[var(--text-muted)]" />}
        />
        <DataTable
          rows={users.data?.users ?? []}
          rowKey={(row) => row.user}
          pageSize={20}
          empty={users.isPending ? "Loading…" : "No connections in this range"}
          columns={[
            {
              key: "user",
              label: "User",
              render: (row) => <span className="font-mono text-xs">{row.user}</span>,
            },
            { key: "connections", label: "Connections", numeric: true },
            {
              key: "failed",
              label: "Failed",
              numeric: true,
              render: (row) =>
                row.failed > 0 ? <span className="text-[var(--critical)]">{row.failed}</span> : "0",
            },
            { key: "pools", label: "Pools", numeric: true },
            {
              key: "connectP95",
              label: "Connect p95",
              numeric: true,
              render: (row) => (row.connectP95 == null ? "—" : formatUnit("ms", row.connectP95)),
            },
            {
              key: "hours",
              label: "Hours",
              numeric: true,
              render: (row) => row.hours.toFixed(1),
            },
            {
              key: "lastSeen",
              label: "Last seen",
              render: (row) => formatRelative(row.lastSeen),
              sortValue: (row) => (row.lastSeen ? new Date(row.lastSeen).getTime() : 0),
            },
          ]}
        />
      </Card>

      <DrillDrawer request={drill} onClose={() => setDrill(null)} />
    </>
  );
}

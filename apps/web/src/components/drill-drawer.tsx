import { formatUnit, getMetric } from "@dashflow/core";
import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { api } from "../lib/api";
import { downloadCsv, formatDateTime } from "../lib/utils";
import { Alert, Badge, Button, DataTable, Drawer, EmptyState, Skeleton } from "./ui";
import type { DrillTarget } from "./widgets";

export interface DrillRequest extends DrillTarget {
  metric: string;
  groupBy?: string;
  tenantIds: string[] | null;
  hostPools: string[];
  /** Falls back to the dashboard's range when the click carried no bucket. */
  rangeFrom: string;
  rangeTo: string;
}

/** Columns that deserve special formatting; everything else is printed as it comes back. */
const FORMATTERS: Record<string, (value: unknown) => string> = {
  ts: (value) => formatDateTime(value as string),
  connect_ms: (value) => (value == null ? "—" : formatUnit("ms", Number(value))),
  rtt_ms: (value) => (value == null ? "—" : formatUnit("ms", Number(value))),
  duration_sec: (value) => (value == null ? "—" : formatUnit("seconds", Number(value))),
  cpu_pct: (value) => (value == null ? "—" : `${Number(value).toFixed(1)}%`),
  cost: (value) => (value == null ? "—" : formatUnit("currency", Number(value))),
  estimated_savings: (value) => (value == null ? "—" : formatUnit("currency", Number(value))),
};

function label(key: string): string {
  return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * The rows behind a click. Every chart is a question; this is the answer one level down,
 * without leaving the dashboard.
 */
export function DrillDrawer({ request, onClose }: { request: DrillRequest | null; onClose: () => void }) {
  const metric = request ? getMetric(request.metric) : undefined;

  const { data, isPending, error } = useQuery({
    queryKey: ["drill", request],
    enabled: Boolean(request),
    queryFn: () =>
      api.detail({
        metric: request!.metric,
        from: request!.from ?? request!.rangeFrom,
        to: request!.to ?? request!.rangeTo,
        tenantIds: request!.tenantIds,
        hostPools: request!.hostPools,
        groupBy: request!.groupBy,
        groupValue: request!.groupValue,
        limit: 500,
      }),
  });

  const rows = data?.rows ?? [];
  const columns = rows.length > 0 ? Object.keys(rows[0]!) : [];

  return (
    <Drawer
      open={Boolean(request)}
      onClose={onClose}
      title={request?.label ?? "Details"}
      description={
        request
          ? `${metric?.label ?? request.metric} · ${formatDateTime(request.from ?? request.rangeFrom)} → ${formatDateTime(
              request.to ?? request.rangeTo,
            )}`
          : undefined
      }
      footer={
        <>
          {data?.pseudonymized && data.table === "connection_facts" ? (
            <span className="mr-auto text-[11px] text-[var(--text-muted)]">
              User names are hashed on this instance (PSEUDONYMIZE_USERS)
            </span>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            disabled={rows.length === 0}
            onClick={() => downloadCsv(`${request?.metric ?? "rows"}.csv`, rows)}
          >
            <Download size={14} /> Export CSV
          </Button>
          <Button size="sm" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      {isPending ? (
        <div className="space-y-2 p-4">
          {[0, 1, 2, 3, 4].map((key) => (
            <Skeleton key={key} className="h-8" />
          ))}
        </div>
      ) : error ? (
        <div className="p-4">
          <Alert tone="critical" title="Could not load the rows">
            {(error as Error).message}
          </Alert>
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          title="No rows behind this point"
          description="The aggregate may come from a different table than the one holding row-level detail."
        />
      ) : (
        <>
          <div className="flex items-center gap-2 border-b border-[var(--border)] px-4 py-2 text-xs text-[var(--text-muted)]">
            <Badge>{rows.length} rows</Badge>
            {rows.length === 500 ? <span>showing the most recent 500</span> : null}
          </div>
          <DataTable
            dense
            rows={rows}
            rowKey={(_row, index) => String(index)}
            pageSize={25}
            columns={columns.map((key) => ({
              key,
              label: label(key),
              numeric: typeof rows[0]?.[key] === "number",
              render: (row) => {
                const value = (row as Record<string, unknown>)[key];
                const formatter = FORMATTERS[key];
                if (formatter) return formatter(value);
                if (value === null || value === undefined) return "—";
                if (typeof value === "boolean") return value ? "yes" : "no";
                return String(value);
              },
            }))}
          />
        </>
      )}
    </Drawer>
  );
}

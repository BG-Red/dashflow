import { formatUnit, METRICS_BY_ID, type WidgetSpec } from "@dashflow/core";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, Server } from "lucide-react";
import { useMemo } from "react";
import { Link } from "wouter";
import { PageHeader } from "../components/layout";
import { Badge, Card, CardHeader, DataTable, EmptyState, Skeleton } from "../components/ui";
import { WidgetCard } from "../components/widgets";
import { api } from "../lib/api";
import { useScope } from "../lib/scope";
import { formatRelative } from "../lib/utils";

const POOL_WIDGETS: Pick<WidgetSpec, "id" | "title" | "metric" | "viz" | "size">[] = [
  { id: "p-sessions", title: "Active sessions", metric: "sessions.active", viz: "area", size: "lg" },
  { id: "p-util", title: "Capacity utilization", metric: "capacity.utilization", viz: "line", size: "lg" },
  { id: "p-connect", title: "Time to connect (p95)", metric: "connect.p95", viz: "line", size: "md" },
  { id: "p-errors", title: "Errors by code", metric: "errors.count", viz: "bar", size: "md" },
];

function hostTone(status: string, drain: boolean): "good" | "warning" | "critical" | "neutral" {
  const value = status.toLowerCase();
  if (value === "available") return drain ? "warning" : "good";
  if (value === "shutdown" || value.includes("vmnotrunning")) return "neutral";
  return "critical";
}

/** Everything about one host pool: its configuration, its hosts, and how it has been behaving. */
export function PoolDetailPage({ resourceId }: { resourceId: string }) {
  const scope = useScope();
  const { data, isPending, error } = useQuery({
    queryKey: ["pool", resourceId],
    queryFn: () => api.pool(resourceId),
  });

  const queries = useMemo(
    () =>
      POOL_WIDGETS.map((widget) => ({
        key: widget.id,
        metric: widget.metric,
        viz: widget.viz,
        groupBy: widget.metric === "errors.count" ? ("errorCode" as const) : undefined,
        topN: 8,
        grain: scope.range.grain,
        from: scope.range.from,
        to: scope.range.to,
        tenantIds: null,
        filters: { hostPools: [resourceId] },
        compare: false,
      })),
    [resourceId, scope.range.from, scope.range.to, scope.range.grain],
  );

  const results = useQuery({
    queryKey: ["pool-data", resourceId, queries],
    queryFn: () => api.queryBatch({ tz: scope.tz, queries: queries.map((query) => ({ ...query })) }),
  });

  if (isPending) return <Skeleton className="h-64" />;
  if (error || !data) {
    return (
      <Card>
        <EmptyState
          title="Host pool not found"
          description="It may have been removed, or it belongs to a customer you cannot see."
        />
      </Card>
    );
  }

  const { pool, hosts } = data;
  const byKey = new Map((results.data?.results ?? []).map((entry) => [entry.key, entry]));
  const available = hosts.filter((host) => host.status === "Available").length;
  const sessions = hosts.reduce((sum, host) => sum + host.sessions, 0);
  const unhealthy = hosts.filter(
    (host) => !["available", "shutdown", "unavailable(vmnotrunning)"].includes(host.status.toLowerCase()),
  ).length;

  return (
    <>
      <PageHeader
        breadcrumb={[
          { label: "Customers", href: "/customers" },
          { label: pool.tenantName },
          { label: pool.name },
        ]}
        title={pool.friendlyName ?? pool.name}
        description={`${pool.poolType} · ${pool.location} · ${pool.tenantName}`}
        actions={
          <>
            {pool.autoscaleEnabled ? <Badge tone="accent">autoscale</Badge> : null}
            {pool.sources.map((source) => (
              <Badge key={source}>{source}</Badge>
            ))}
          </>
        }
      />

      <div className="mb-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Session hosts" value={String(hosts.length)} hint={`${available} available`} />
        <Stat
          label="Live sessions"
          value={String(sessions)}
          hint={pool.maxSessions ? `max ${pool.maxSessions}/host` : undefined}
        />
        <Stat
          label="Unhealthy"
          value={String(unhealthy)}
          tone={unhealthy > 0 ? "critical" : "good"}
          hint={unhealthy > 0 ? "needs attention" : "all good"}
        />
        <Stat
          label="Load balancer"
          value={pool.loadBalancer ?? "—"}
          hint={pool.startVmOnConnect ? "start VM on connect" : undefined}
        />
      </div>

      <div className="mb-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
        {POOL_WIDGETS.map((widget) => {
          const entry = byKey.get(widget.id);
          const metric = METRICS_BY_ID[widget.metric];
          return (
            <div key={widget.id} style={{ height: 300 }}>
              <WidgetCard
                fill
                widget={
                  {
                    ...widget,
                    groupBy: widget.metric === "errors.count" ? "errorCode" : undefined,
                    topN: 8,
                    grain: "auto",
                    filters: {},
                    compare: false,
                  } as WidgetSpec
                }
                result={entry?.result}
                error={entry?.error}
                loading={results.isPending}
                betterWhen={metric?.betterWhen ?? "neutral"}
              />
            </div>
          );
        })}
      </div>

      <Card>
        <CardHeader
          title="Session hosts"
          subtitle={`${hosts.length} hosts · updated ${formatRelative(pool.updatedAt)}`}
        />
        <DataTable
          rows={hosts}
          rowKey={(host) => host.resourceId}
          pageSize={25}
          empty="No session hosts yet"
          emptyDescription="They appear after the first inventory sync."
          columns={[
            {
              key: "name",
              label: "Host",
              render: (host) => (
                <Link
                  href={`/hosts/${encodeURIComponent(pool.resourceId)}/${encodeURIComponent(host.name)}`}
                  className="flex items-center gap-1.5 text-[var(--accent)] hover:underline"
                >
                  <Server size={13} />
                  {host.name}
                </Link>
              ),
            },
            {
              key: "status",
              label: "Status",
              render: (host) => (
                <span className="flex items-center gap-1.5">
                  <Badge tone={hostTone(host.status, !host.allowNewSession)}>{host.status}</Badge>
                  {!host.allowNewSession ? <Badge tone="warning">drain</Badge> : null}
                </span>
              ),
            },
            { key: "sessions", label: "Sessions", numeric: true },
            { key: "agentVersion", label: "Agent" },
            { key: "osVersion", label: "OS build" },
            {
              key: "lastHeartBeat",
              label: "Last heartbeat",
              render: (host) => formatRelative(host.lastHeartBeat),
              sortValue: (host) => (host.lastHeartBeat ? new Date(host.lastHeartBeat).getTime() : 0),
            },
          ]}
        />
      </Card>

      <p className="mt-3 flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
        <ExternalLink size={12} />
        <span className="font-mono">{pool.resourceId}</span>
      </p>
    </>
  );
}

function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "good" | "critical";
}) {
  return (
    <Card className="px-4 py-3">
      <p className="text-xs text-[var(--text-muted)]">{label}</p>
      <p
        className={`mt-0.5 text-xl font-semibold tabular-nums ${
          tone === "critical" ? "text-[var(--critical)]" : "text-[var(--text-primary)]"
        }`}
      >
        {value}
      </p>
      {hint ? <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">{hint}</p> : null}
    </Card>
  );
}

export { formatUnit };

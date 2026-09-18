import { useQuery } from "@tanstack/react-query";
import { PageHeader } from "../components/layout";
import { Badge, Card, CardHeader, DataTable, EmptyState, Skeleton } from "../components/ui";
import { api } from "../lib/api";
import { formatDateTime, formatRelative } from "../lib/utils";

/**
 * One session host. The health timeline is the point: a host that flaps between Available and
 * Unavailable looks fine in any snapshot, and obvious here.
 */
export function HostDetailPage({ poolId, name }: { poolId: string; name: string }) {
  const { data, isPending, error } = useQuery({
    queryKey: ["host", poolId, name],
    queryFn: () => api.host(poolId, name),
  });

  if (isPending) return <Skeleton className="h-64" />;
  if (error || !data) {
    return (
      <Card>
        <EmptyState
          title="Session host not found"
          description="It may have been removed, or it belongs to a customer you cannot see."
        />
      </Card>
    );
  }

  const { host, health, errors } = data;
  const healthRows = health as {
    ts: string;
    status: string;
    healthy: boolean;
    drain: boolean;
    sessions: number;
  }[];
  const errorRows = errors as {
    ts: string;
    code: string;
    source: string;
    service_error: boolean;
    message: string;
  }[];

  // Collapse the timeline into runs, so "flapping" is visible as a row count rather than noise.
  const runs: { from: string; to: string; status: string; drain: boolean }[] = [];
  for (const row of [...healthRows].reverse()) {
    const last = runs.at(-1);
    if (last && last.status === row.status && last.drain === row.drain) {
      last.to = row.ts;
    } else {
      runs.push({ from: row.ts, to: row.ts, status: row.status, drain: row.drain });
    }
  }
  runs.reverse();

  const unhealthy = (status: string) =>
    !["available", "shutdown", "unavailable(vmnotrunning)"].includes(status.toLowerCase());

  return (
    <>
      <PageHeader
        breadcrumb={[
          { label: "Customers", href: "/customers" },
          {
            label: host.hostPoolFriendlyName ?? host.hostPoolName,
            href: `/pools/${encodeURIComponent(host.hostPoolId)}`,
          },
          { label: host.name },
        ]}
        title={host.name}
        description={`${host.tenantName} · ${host.hostPoolFriendlyName ?? host.hostPoolName}`}
        actions={
          <>
            <Badge tone={unhealthy(host.status) ? "critical" : "good"}>{host.status}</Badge>
            {!host.allowNewSession ? <Badge tone="warning">drain mode</Badge> : null}
            <Badge>{host.source}</Badge>
          </>
        }
      />

      <div className="mb-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Fact label="Sessions" value={String(host.sessions)} />
        <Fact label="Agent" value={host.agentVersion ?? "—"} />
        <Fact label="OS build" value={host.osVersion ?? "—"} />
        <Fact label="Last heartbeat" value={formatRelative(host.lastHeartBeat)} />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card>
          <CardHeader title="Health timeline" subtitle={`${runs.length} state changes in the last 7 days`} />
          <DataTable
            dense
            pageSize={15}
            rows={runs}
            rowKey={(run, index) => `${run.from}-${index}`}
            empty="No health history yet"
            columns={[
              { key: "from", label: "From", render: (run) => formatDateTime(run.from) },
              { key: "to", label: "Until", render: (run) => formatDateTime(run.to) },
              {
                key: "status",
                label: "State",
                render: (run) => (
                  <span className="flex items-center gap-1.5">
                    <Badge tone={unhealthy(run.status) ? "critical" : "good"}>{run.status}</Badge>
                    {run.drain ? <Badge tone="warning">drain</Badge> : null}
                  </span>
                ),
              },
            ]}
          />
        </Card>

        <Card>
          <CardHeader title="Recent errors in this host pool" subtitle="Last 7 days" />
          <DataTable
            dense
            pageSize={15}
            rows={errorRows}
            rowKey={(row, index) => `${row.ts}-${index}`}
            empty="No errors recorded"
            emptyDescription="Nothing has been reported for this host pool in the last week."
            columns={[
              { key: "ts", label: "When", render: (row) => formatRelative(row.ts) },
              { key: "code", label: "Code" },
              { key: "source", label: "Source" },
              {
                key: "service_error",
                label: "Side",
                render: (row) =>
                  row.service_error ? <Badge tone="warning">service</Badge> : <Badge>customer</Badge>,
              },
            ]}
          />
        </Card>
      </div>

      {host.vmResourceId ? (
        <p className="mt-3 font-mono text-xs text-[var(--text-muted)]">{host.vmResourceId}</p>
      ) : null}
    </>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <Card className="px-4 py-3">
      <p className="text-xs text-[var(--text-muted)]">{label}</p>
      <p className="mt-0.5 truncate text-[15px] font-medium text-[var(--text-primary)]">{value}</p>
    </Card>
  );
}

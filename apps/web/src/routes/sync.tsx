import { useQuery } from "@tanstack/react-query";
import { Activity } from "lucide-react";
import { useEffect, useState } from "react";
import { PageHeader } from "../components/layout";
import { Alert, Badge, Card, CardHeader, EmptyState, Skeleton, Table } from "../components/ui";
import { api, type SyncRun } from "../lib/api";
import { formatRelative } from "../lib/utils";

interface LiveEvent {
  id: number;
  type: string;
  stream?: string;
  error?: string;
  stats?: Record<string, number>;
  at?: number;
}

let nextEventId = 1;

/** Sync health: the queue, recent runs, and a live feed while a backfill is running. */
export function SyncPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["sync-runs"],
    queryFn: api.syncRuns,
    refetchInterval: 10_000,
  });
  const [events, setEvents] = useState<LiveEvent[]>([]);

  useEffect(() => {
    const source = new EventSource("/api/sync/events");
    const onMessage = (event: MessageEvent<string>) => {
      try {
        const parsed = JSON.parse(event.data) as Omit<LiveEvent, "id">;
        if (parsed.type === "ping") return;
        setEvents((current) => [{ ...parsed, id: nextEventId++ }, ...current].slice(0, 30));
      } catch {
        // A malformed frame is not worth surfacing.
      }
    };
    for (const type of ["sync:start", "sync:done", "sync:error"]) {
      source.addEventListener(type, onMessage as EventListener);
    }
    return () => source.close();
  }, []);

  if (isLoading) return <Skeleton className="h-64" />;

  const runs = data?.runs ?? [];
  const failing = runs.filter((run) => run.status === "error");

  return (
    <>
      <PageHeader
        title="Sync health"
        description="Every collection run, with row counts and errors. Runs are incremental: logs re-read a two hour overlap so late-arriving rows are not missed."
      />

      <div className="mb-3 grid gap-3 sm:grid-cols-4">
        <Stat label="Queued" value={data?.queue.queued ?? 0} />
        <Stat label="Running" value={data?.queue.running ?? 0} />
        <Stat
          label="Failed jobs"
          value={data?.queue.failed ?? 0}
          tone={data?.queue.failed ? "critical" : "neutral"}
        />
        <Stat label="Runs (last 100)" value={runs.length} />
      </div>

      {failing.length > 0 ? (
        <div className="mb-3">
          <Alert tone="critical" title={`${failing.length} recent run(s) failed`}>
            {failing[0]!.error?.slice(0, 300)}
          </Alert>
        </div>
      ) : null}

      {events.length > 0 ? (
        <Card className="mb-3">
          <CardHeader title="Live" subtitle="Streaming from the worker" />
          <ul className="space-y-1 px-4 pb-3 text-xs">
            {events.map((event) => (
              <li key={event.id} className="flex items-center gap-2 text-[var(--text-secondary)]">
                <Badge
                  tone={
                    event.type === "sync:error" ? "critical" : event.type === "sync:done" ? "good" : "neutral"
                  }
                >
                  {event.type.replace("sync:", "")}
                </Badge>
                <span>{event.stream}</span>
                {event.stats ? (
                  <span className="text-[var(--text-muted)]">
                    {Object.entries(event.stats)
                      .filter(([, value]) => value > 0)
                      .map(([key, value]) => `${key} ${value}`)
                      .join(" · ") || "no new rows"}
                  </span>
                ) : null}
                {event.error ? (
                  <span className="text-[var(--critical)]">{event.error.slice(0, 120)}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card>
        <CardHeader title="Recent runs" />
        {runs.length === 0 ? (
          <EmptyState icon={<Activity size={20} />} title="No sync runs yet" />
        ) : (
          <Table
            dense
            columns={[
              { key: "when", label: "Started" },
              { key: "connection", label: "Connection" },
              { key: "tenant", label: "Customer" },
              { key: "stream", label: "Stream" },
              { key: "status", label: "Status" },
              { key: "rows", label: "Rows", numeric: true },
              { key: "took", label: "Took", numeric: true },
            ]}
            rows={runs.map((run) => ({
              __key: run.id,
              when: formatRelative(run.startedAt),
              connection: run.connectionName,
              tenant: run.tenantName ?? "—",
              stream: run.stream,
              status: (
                <Badge
                  tone={
                    run.status === "ok"
                      ? "good"
                      : run.status === "error"
                        ? "critical"
                        : run.status === "running"
                          ? "accent"
                          : "warning"
                  }
                >
                  {run.status}
                </Badge>
              ),
              rows: rowCount(run),
              took: duration(run),
            }))}
          />
        )}
      </Card>
    </>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "neutral" | "critical" }) {
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
    </Card>
  );
}

function rowCount(run: SyncRun): string {
  if (!run.stats) return "—";
  const total = Object.entries(run.stats)
    .filter(([key]) => key !== "skippedUnknownPool")
    .reduce((sum, [, value]) => sum + value, 0);
  return total.toLocaleString();
}

function duration(run: SyncRun): string {
  if (!run.finishedAt) return "…";
  const ms = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();
  return ms > 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

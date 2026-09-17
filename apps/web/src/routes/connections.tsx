import { CONNECTION_TYPE_INFO, type ConnectionType, type DiagnosticCheck } from "@avd/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ExternalLink, Plug, RefreshCw, Search, Trash2, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { Link } from "wouter";
import { PageHeader } from "../components/layout";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  CodeBlock,
  EmptyState,
  Field,
  Input,
  Select,
  Skeleton,
  StatusDot,
  Switch,
} from "../components/ui";
import { api, type ConnectionSummary, type Me } from "../lib/api";
import { formatRelative } from "../lib/utils";
import { CHECK_ORDER, prerequisiteSteps } from "./connection-help";

export function ChecksList({ checks }: { checks: DiagnosticCheck[] }) {
  const sorted = [...checks].sort((a, b) => (CHECK_ORDER[a.status] ?? 9) - (CHECK_ORDER[b.status] ?? 9));
  return (
    <ul className="space-y-2">
      {sorted.map((check) => (
        <li key={check.id} className="flex gap-2.5">
          <StatusDot status={check.status} />
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-medium text-[var(--text-primary)]">
              {check.label}
              {check.status === "skip" ? (
                <span className="ml-1.5 text-[var(--text-muted)]">(not used)</span>
              ) : null}
            </p>
            {check.detail ? (
              <p className="mt-0.5 text-xs break-words text-[var(--text-secondary)]">{check.detail}</p>
            ) : null}
            {check.fix && check.status !== "pass" ? (
              <p className="mt-1 text-xs text-[var(--text-muted)]">
                <span className="font-medium text-[var(--text-secondary)]">How to fix: </span>
                {check.fix}
              </p>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

function statusTone(status: ConnectionSummary["status"]) {
  return status === "ok"
    ? "good"
    : status === "degraded"
      ? "warning"
      : status === "error"
        ? "critical"
        : "neutral";
}

export function ConnectionsPage({ me }: { me: Me }) {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["connections"], queryFn: api.connections });
  const [expanded, setExpanded] = useState<string | null>(null);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["connections"] });
    void queryClient.invalidateQueries({ queryKey: ["me"] });
    void queryClient.invalidateQueries({ queryKey: ["tenants"] });
  };

  const test = useMutation({ mutationFn: api.testConnection, onSuccess: invalidate });
  const discover = useMutation({ mutationFn: api.discover, onSuccess: invalidate });
  const sync = useMutation({
    mutationFn: ({ id, backfill }: { id: string; backfill: boolean }) => api.syncConnection(id, backfill),
  });
  const remove = useMutation({ mutationFn: api.deleteConnection, onSuccess: invalidate });
  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.updateConnection(id, { enabled }),
    onSuccess: invalidate,
  });
  const consent = useMutation({
    mutationFn: api.consentUrl,
    onSuccess: (result) => window.open(result.url, "_blank", "noopener"),
  });

  return (
    <>
      <PageHeader
        title="Connections"
        description="Where the data comes from. Add as many as you need — Azure, Lighthouse, Partner Center and Nerdio can all feed the same dashboards."
        actions={
          <Link href="/connections/new">
            <Button>
              <Plug size={15} /> Add connection
            </Button>
          </Link>
        }
      />

      {isLoading ? (
        <Skeleton className="h-32" />
      ) : !data || data.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Plug size={22} />}
            title="No connections yet"
            description="Connect Azure directly, an Azure Lighthouse managing tenant, your Partner Center customers, or Nerdio Manager."
            action={
              <Link href="/connections/new">
                <Button>Add your first connection</Button>
              </Link>
            }
          />
        </Card>
      ) : (
        <div className="space-y-3">
          {data.map((connection) => {
            const info = CONNECTION_TYPE_INFO[connection.type as Exclude<ConnectionType, "demo">];
            const open = expanded === connection.id;
            return (
              <Card key={connection.id}>
                <CardHeader
                  title={
                    <span className="flex items-center gap-2">
                      {connection.name}
                      <Badge tone={statusTone(connection.status)}>{connection.status}</Badge>
                      {!connection.enabled ? <Badge>paused</Badge> : null}
                    </span>
                  }
                  subtitle={`${info?.label ?? connection.type} · ${connection.tenantCount} customer(s) · last sync ${formatRelative(connection.lastSyncAt)}`}
                  actions={
                    <>
                      <Switch
                        checked={connection.enabled}
                        onChange={(enabled) => toggle.mutate({ id: connection.id, enabled })}
                        label="Enabled"
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setExpanded(open ? null : connection.id)}
                      >
                        {open ? "Hide" : "Details"}
                      </Button>
                    </>
                  }
                />

                {open ? (
                  <div className="space-y-3 border-t border-[var(--border)] px-4 py-3">
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => test.mutate(connection.id)}
                        disabled={test.isPending}
                      >
                        <CheckCircle2 size={14} /> {test.isPending ? "Testing…" : "Test"}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => discover.mutate(connection.id)}
                        disabled={discover.isPending}
                      >
                        <Search size={14} /> {discover.isPending ? "Discovering…" : "Discover customers"}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => sync.mutate({ id: connection.id, backfill: false })}
                        disabled={sync.isPending}
                      >
                        <RefreshCw size={14} /> Sync now
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => sync.mutate({ id: connection.id, backfill: true })}
                        disabled={sync.isPending}
                      >
                        Backfill {connection.schedule.backfillDays}d
                      </Button>
                      {connection.type === "partner-center" ? (
                        <Button variant="outline" size="sm" onClick={() => consent.mutate(connection.id)}>
                          <ExternalLink size={14} />{" "}
                          {connection.consented ? "Re-grant consent" : "Grant partner consent"}
                        </Button>
                      ) : null}
                      <Button
                        variant="danger"
                        size="sm"
                        className="ml-auto"
                        onClick={() => {
                          if (
                            confirm(
                              `Delete "${connection.name}"? Its customers, host pools and synced history are deleted too.`,
                            )
                          ) {
                            remove.mutate(connection.id);
                          }
                        }}
                      >
                        <Trash2 size={14} /> Delete
                      </Button>
                    </div>

                    {discover.isSuccess && discover.variables === connection.id ? (
                      <Alert tone="good">
                        Found {discover.data.tenants} customer(s), {discover.data.subscriptions}{" "}
                        subscription(s), {discover.data.workspaces} workspace(s) and {discover.data.hostPools}{" "}
                        host pool(s).{" "}
                        <Link href="/customers" className="underline">
                          Choose what to sync
                        </Link>
                        .
                      </Alert>
                    ) : null}
                    {discover.isError && discover.variables === connection.id ? (
                      <Alert tone="critical" title="Discovery failed">
                        {(discover.error as Error).message}
                      </Alert>
                    ) : null}
                    {sync.isSuccess ? <Alert tone="good">Queued {sync.data.queued} sync jobs.</Alert> : null}

                    <div className="grid gap-3 lg:grid-cols-2">
                      <div>
                        <p className="mb-2 text-xs font-medium tracking-wide text-[var(--text-muted)] uppercase">
                          Diagnostics{" "}
                          {connection.lastTestedAt ? `· ${formatRelative(connection.lastTestedAt)}` : ""}
                        </p>
                        {connection.lastTest ? (
                          <ChecksList checks={connection.lastTest} />
                        ) : (
                          <p className="text-sm text-[var(--text-muted)]">Not tested yet.</p>
                        )}
                      </div>
                      <div>
                        <p className="mb-2 text-xs font-medium tracking-wide text-[var(--text-muted)] uppercase">
                          Schedule
                        </p>
                        <ScheduleEditor connection={connection} onSaved={invalidate} />
                      </div>
                    </div>
                  </div>
                ) : null}
              </Card>
            );
          })}
        </div>
      )}

      {me.instance.demoMode ? (
        <div className="mt-4">
          <Alert tone="warning" title="Demo mode is on">
            A synthetic connection generates fake customers and data so you can explore the app. Set{" "}
            <code>DEMO_MODE=false</code> and delete that connection before using this instance for real work.
          </Alert>
        </div>
      ) : null}
    </>
  );
}

function ScheduleEditor({ connection, onSaved }: { connection: ConnectionSummary; onSaved: () => void }) {
  const [schedule, setSchedule] = useState(connection.schedule);
  const save = useMutation({
    mutationFn: () => api.updateConnection(connection.id, { schedule }),
    onSuccess: onSaved,
  });
  const fields: { key: keyof typeof schedule; label: string; suffix: string }[] = [
    { key: "inventoryMinutes", label: "Inventory", suffix: "min" },
    { key: "sessionsMinutes", label: "Sessions", suffix: "min" },
    { key: "logsMinutes", label: "Logs", suffix: "min" },
    { key: "costHours", label: "Cost", suffix: "hours" },
    { key: "backfillDays", label: "Backfill", suffix: "days" },
    { key: "retentionDays", label: "Retention", suffix: "days" },
  ];

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        {fields.map((field) => (
          <label key={field.key} className="text-xs text-[var(--text-muted)]">
            {field.label} ({field.suffix})
            <Input
              type="number"
              className="mt-1 h-8"
              value={schedule[field.key]}
              onChange={(event) => setSchedule({ ...schedule, [field.key]: Number(event.target.value) })}
            />
          </label>
        ))}
      </div>
      <Button size="sm" variant="outline" onClick={() => save.mutate()} disabled={save.isPending}>
        {save.isPending ? "Saving…" : "Save schedule"}
      </Button>
      {save.isError ? <Alert tone="critical">{(save.error as Error).message}</Alert> : null}
    </div>
  );
}

/** Reusable prerequisite panel, shown in the new-connection wizard. */
export function Prerequisites({
  type,
  values,
}: {
  type: ConnectionType;
  values: {
    tenantId?: string;
    clientId?: string;
    subscriptionId?: string;
    baseUrl?: string;
    redirectUri: string;
  };
}) {
  const steps = prerequisiteSteps(type, values);
  return (
    <ol className="space-y-4">
      {steps.map((step, index) => (
        <li key={step.title} className="space-y-2">
          <div className="flex gap-2">
            <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-[var(--surface-2)] text-[11px] font-semibold text-[var(--text-secondary)]">
              {index + 1}
            </span>
            <div>
              <p className="text-[13px] font-medium text-[var(--text-primary)]">{step.title}</p>
              <p className="mt-0.5 text-xs leading-relaxed text-[var(--text-secondary)]">{step.body}</p>
            </div>
          </div>
          {step.code ? (
            <div className="pl-7">
              <CodeBlock code={step.code} label={step.codeLabel} />
            </div>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

export { Field, Select, TriangleAlert };

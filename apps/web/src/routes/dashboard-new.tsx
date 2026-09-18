import { METRICS_BY_ID, type TimePreset, type WidgetSpec } from "@dashflow/core";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Check, Sparkles } from "lucide-react";
import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { PageHeader } from "../components/layout";
import { Alert, Badge, Button, Card, Field, Input, Select, Stepper, Switch } from "../components/ui";
import { WidgetCard } from "../components/widgets";
import { api, type Catalog, type Me } from "../lib/api";
import { useScope } from "../lib/scope";

const STEPS = [
  { id: "goal", label: "What do you want to know?" },
  { id: "scope", label: "Whose data?" },
  { id: "preview", label: "Preview and adjust" },
];

/**
 * The guided build: pick a question, pick a scope, then see the real dashboard before
 * saving it. Previewing with live data is the point — a template that looks good but has
 * no data behind it is worse than none.
 */
export function DashboardNew({ catalog, me }: { catalog: Catalog; me: Me }) {
  const [, navigate] = useLocation();
  const scope = useScope();
  const [step, setStep] = useState(0);
  const [goal, setGoal] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [preset, setPreset] = useState<TimePreset>(scope.preset);
  const [tenantIds, setTenantIds] = useState<string[] | null>(scope.tenantIds);
  const [pinScope, setPinScope] = useState(false);
  const [omitted, setOmitted] = useState<string[]>([]);

  const template = catalog.templates.find((candidate) => candidate.goal === goal);
  const widgets = useMemo(
    () => (template?.widgets ?? []).filter((widget) => !omitted.includes(widget.id)),
    [template, omitted],
  );

  const queries = useMemo(() => {
    const from = new Date(Date.now() - presetHours(preset) * 3600_000);
    const to = new Date();
    return widgets.map((widget) => ({
      key: widget.id,
      metric: widget.metric,
      viz: widget.viz,
      groupBy: widget.groupBy,
      topN: widget.topN,
      grain:
        widget.grain === "auto"
          ? presetHours(preset) > 24 * 10
            ? ("day" as const)
            : ("hour" as const)
          : widget.grain,
      from,
      to,
      tenantIds,
      filters: widget.filters,
      compare: widget.viz === "kpi",
    }));
  }, [widgets, preset, tenantIds]);

  const preview = useQuery({
    queryKey: ["preview", goal, queries],
    queryFn: () => api.queryBatch({ tz: scope.tz, queries: queries.map((query) => ({ ...query })) }),
    enabled: step === 2 && queries.length > 0,
  });

  const create = useMutation({
    mutationFn: () =>
      api.createFromTemplate({
        goal: goal!,
        name: name.trim() || undefined,
        tenantScope: pinScope ? tenantIds : null,
        defaultPreset: preset,
        omit: omitted,
      }),
    onSuccess: (result) => navigate(`/dashboards/${result.id}`),
  });

  const byKey = new Map((preview.data?.results ?? []).map((entry) => [entry.key, entry]));
  const emptyWidgets = (preview.data?.results ?? [])
    .filter((entry) => isEmpty(entry))
    .map((entry) => entry.key);

  return (
    <>
      <PageHeader
        title="Build a dashboard"
        description="Three steps: pick the question, pick the scope, check it against your data."
        actions={
          <Button variant="ghost" onClick={() => navigate("/")}>
            Cancel
          </Button>
        }
      />

      <div className="mb-4">
        <Stepper steps={STEPS} current={step} onSelect={setStep} />
      </div>

      {step === 0 ? (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {catalog.templates.map((candidate) => (
            <button
              type="button"
              key={candidate.goal}
              onClick={() => {
                setGoal(candidate.goal);
                setName(candidate.name);
                setOmitted([]);
                setStep(1);
              }}
              className="h-full text-left"
            >
              <Card
                className={`flex h-full flex-col p-4 transition-all hover:-translate-y-0.5 hover:shadow-md ${
                  goal === candidate.goal ? "ring-2 ring-[var(--accent)]" : ""
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <h3 className="text-sm font-semibold tracking-tight">{candidate.name}</h3>
                  {candidate.requires ? <Badge tone="warning">{candidate.requires}</Badge> : null}
                </div>
                <p className="mt-1 text-xs text-[var(--text-muted)]">{candidate.headline}</p>
                <ul className="mt-3 space-y-1.5">
                  {candidate.answers.map((answer) => (
                    <li key={answer} className="flex gap-1.5 text-[12px] text-[var(--text-secondary)]">
                      <Check size={13} className="mt-0.5 shrink-0 text-[var(--good)]" />
                      {answer}
                    </li>
                  ))}
                </ul>
                <p className="mt-auto pt-3 text-[11px] text-[var(--text-muted)]">
                  {candidate.widgets.length} widgets
                </p>
              </Card>
            </button>
          ))}
        </div>
      ) : null}

      {step === 1 && template ? (
        <Card className="max-w-2xl space-y-4 p-4">
          <Field label="Dashboard name">
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={template.name}
            />
          </Field>

          <Field label="Default time range" hint="Anyone opening the dashboard starts here.">
            <Select value={preset} onChange={(event) => setPreset(event.target.value as TimePreset)}>
              <option value="24h">Last 24 hours</option>
              <option value="7d">Last 7 days</option>
              <option value="30d">Last 30 days</option>
              <option value="90d">Last 90 days</option>
            </Select>
          </Field>

          <Field
            label="Customers"
            hint={
              template.goal === "customer-report"
                ? "A customer report usually covers exactly one customer."
                : "Leave everything selected for an estate-wide view."
            }
          >
            <div className="max-h-56 space-y-1 overflow-auto rounded-lg border border-[var(--border)] p-2">
              <label className="flex items-center gap-2 rounded-md px-1.5 py-1 text-sm hover:bg-[var(--surface-2)]">
                <input
                  type="checkbox"
                  checked={tenantIds === null}
                  onChange={(event) => setTenantIds(event.target.checked ? null : [])}
                />
                All customers
              </label>
              {me.tenants.map((tenant) => (
                <label
                  key={tenant.id}
                  className="flex items-center gap-2 rounded-md px-1.5 py-1 text-sm hover:bg-[var(--surface-2)]"
                >
                  <input
                    type="checkbox"
                    checked={tenantIds === null || tenantIds.includes(tenant.id)}
                    onChange={(event) => {
                      const current = tenantIds === null ? me.tenants.map((item) => item.id) : tenantIds;
                      const next = event.target.checked
                        ? [...new Set([...current, tenant.id])]
                        : current.filter((id) => id !== tenant.id);
                      setTenantIds(next.length === me.tenants.length ? null : next);
                    }}
                  />
                  {tenant.displayName}
                </label>
              ))}
            </div>
          </Field>

          <div className="flex items-center gap-2">
            <Switch checked={pinScope} onChange={setPinScope} label="Pin this customer selection" />
            <span className="text-sm text-[var(--text-secondary)]">
              Pin these customers to the dashboard (otherwise it follows the switcher at the top)
            </span>
          </div>

          <div className="flex justify-between pt-1">
            <Button variant="ghost" onClick={() => setStep(0)}>
              <ArrowLeft size={15} /> Back
            </Button>
            <Button onClick={() => setStep(2)}>
              Preview <ArrowRight size={15} />
            </Button>
          </div>
        </Card>
      ) : null}

      {step === 2 && template ? (
        <div className="space-y-3">
          <Card className="flex flex-wrap items-center justify-between gap-3 p-3">
            <div className="text-sm">
              <p className="font-medium">{name || template.name}</p>
              <p className="text-xs text-[var(--text-muted)]">
                {widgets.length} widgets · {preset} ·{" "}
                {tenantIds === null ? "all customers" : `${tenantIds.length} customer(s)`}
              </p>
            </div>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => setStep(1)}>
                <ArrowLeft size={15} /> Back
              </Button>
              <Button onClick={() => create.mutate()} disabled={create.isPending || widgets.length === 0}>
                <Sparkles size={15} /> {create.isPending ? "Creating…" : "Create dashboard"}
              </Button>
            </div>
          </Card>

          {create.isError ? <Alert tone="critical">{(create.error as Error).message}</Alert> : null}

          {emptyWidgets.length > 0 ? (
            <Alert tone="warning" title="Some widgets have no data yet">
              {emptyWidgets.length} of {widgets.length} widgets came back empty for this range and scope. That
              usually means the matching data has not synced yet — host pool diagnostics for connection and
              error data, the Perf table for CPU, or Cost Management for spend. You can drop them below and
              add them later.
            </Alert>
          ) : null}

          <div className="grid grid-cols-12 gap-3">
            {widgets.map((widget) => {
              const entry = byKey.get(widget.id);
              const metric = METRICS_BY_ID[widget.metric];
              return (
                <WidgetCard
                  key={widget.id}
                  widget={widget}
                  result={entry?.result}
                  error={entry?.error}
                  loading={preview.isPending}
                  betterWhen={metric?.betterWhen ?? "neutral"}
                  actions={
                    <Button
                      variant="ghost"
                      size="sm"
                      title="Leave this widget out"
                      onClick={() => setOmitted((current) => [...current, widget.id])}
                    >
                      Drop
                    </Button>
                  }
                />
              );
            })}
          </div>

          {omitted.length > 0 ? (
            <Card className="p-3">
              <p className="mb-2 text-xs text-[var(--text-muted)]">Dropped widgets</p>
              <div className="flex flex-wrap gap-1.5">
                {omitted.map((id) => {
                  const widget = template.widgets.find((candidate) => candidate.id === id);
                  return (
                    <Button
                      key={id}
                      size="sm"
                      variant="outline"
                      onClick={() => setOmitted((current) => current.filter((value) => value !== id))}
                    >
                      + {widget?.title ?? id}
                    </Button>
                  );
                })}
              </div>
            </Card>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function presetHours(preset: TimePreset): number {
  return preset === "24h" ? 24 : preset === "7d" ? 24 * 7 : preset === "30d" ? 24 * 30 : 24 * 90;
}

function isEmpty(entry: { result?: { kind: string } & Record<string, unknown>; error?: string }): boolean {
  if (entry.error) return true;
  const result = entry.result;
  if (!result) return true;
  switch (result.kind) {
    case "scalar":
      return result.value == null;
    case "series":
      return (result.series as { points: { value: number | null }[] }[]).every((series) =>
        series.points.every((point) => point.value == null),
      );
    case "breakdown":
      return (result.items as unknown[]).length === 0;
    case "table":
      return (result.rows as unknown[]).length === 0;
    case "heatmap":
      return (result.cells as unknown[]).length === 0;
    case "hosts":
      return (result.hosts as unknown[]).length === 0;
    default:
      return false;
  }
}

export type { WidgetSpec };

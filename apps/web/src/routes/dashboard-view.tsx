import {
  type DashboardSpec,
  METRICS_BY_ID,
  SIZE_SPEC,
  type TimePreset,
  vizResultKind,
  type WidgetSize,
  type WidgetSpec,
} from "@avd/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Pencil, Plus, Save, Settings2, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { PageHeader } from "../components/layout";
import { Alert, Badge, Button, Card, EmptyState, Select, Skeleton, Switch } from "../components/ui";
import { WidgetCard } from "../components/widgets";
import { api, type Catalog } from "../lib/api";
import { useScope } from "../lib/scope";
import { downloadCsv } from "../lib/utils";

/** One request per widget, batched into a single round trip. */
function buildQueries(
  widgets: WidgetSpec[],
  scope: ReturnType<typeof useScope>,
  dashboardScope: string[] | null,
) {
  const tenantIds = dashboardScope ?? scope.tenantIds;
  return widgets.map((widget) => ({
    key: widget.id,
    metric: widget.metric,
    viz: widget.viz,
    groupBy: widget.groupBy,
    topN: widget.topN,
    grain: widget.grain === "auto" ? scope.range.grain : widget.grain,
    from: scope.range.from,
    to: scope.range.to,
    tenantIds,
    filters: {
      hostPools: [...(widget.filters.hostPools ?? []), ...scope.hostPools],
      dims: widget.filters.dims,
    },
    compare: widget.viz === "kpi" ? widget.compare : false,
  }));
}

export function DashboardView({ id, catalog }: { id: string; catalog: Catalog }) {
  const queryClient = useQueryClient();
  const scope = useScope();
  const [, navigate] = useLocation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<DashboardSpec | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  const { data: dashboard, isLoading } = useQuery({
    queryKey: ["dashboard", id],
    queryFn: () => api.dashboard(id),
  });

  useEffect(() => {
    if (dashboard && !editing) setDraft(null);
  }, [dashboard, editing]);

  const spec: DashboardSpec | null = draft ?? (dashboard ? toSpec(dashboard) : null);
  const widgets = spec?.widgets ?? [];

  const queries = useMemo(
    () => (widgets.length > 0 ? buildQueries(widgets, scope, spec?.tenantScope ?? null) : []),
    [widgets, scope.tenantIds, scope.hostPools, spec?.tenantScope, scope],
  );

  const results = useQuery({
    queryKey: ["dashboard-data", id, queries],
    queryFn: () => api.queryBatch({ tz: scope.tz, queries: queries.map((q) => ({ ...q })) }),
    enabled: queries.length > 0,
    staleTime: 30_000,
  });

  const save = useMutation({
    mutationFn: (next: DashboardSpec) => api.saveDashboard(id, next),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["dashboard", id] });
      await queryClient.invalidateQueries({ queryKey: ["dashboards"] });
      setEditing(false);
      setDraft(null);
    },
  });

  const remove = useMutation({
    mutationFn: () => api.deleteDashboard(id),
    onSuccess: () => navigate("/"),
  });

  if (isLoading || !dashboard || !spec) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-8 w-64" />
        <div className="grid grid-cols-12 gap-3">
          {[0, 1, 2, 3].map((key) => (
            <Skeleton key={key} className="col-span-3 h-32" />
          ))}
        </div>
      </div>
    );
  }

  const byKey = new Map((results.data?.results ?? []).map((entry) => [entry.key, entry]));
  const update = (next: Partial<DashboardSpec>) => setDraft({ ...spec, ...next });
  const updateWidget = (widgetId: string, next: Partial<WidgetSpec>) =>
    update({
      widgets: spec.widgets.map((widget) => (widget.id === widgetId ? { ...widget, ...next } : widget)),
    });

  const exportCsv = () => {
    const rows: Record<string, unknown>[] = [];
    for (const widget of widgets) {
      const result = byKey.get(widget.id)?.result;
      if (!result) continue;
      if (result.kind === "scalar")
        rows.push({ widget: widget.title, series: "", bucket: "", value: result.value });
      if (result.kind === "series") {
        for (const series of result.series) {
          for (const point of series.points) {
            rows.push({ widget: widget.title, series: series.name, bucket: point.ts, value: point.value });
          }
        }
      }
      if (result.kind === "breakdown" || result.kind === "table") {
        const items = result.kind === "breakdown" ? result.items : result.rows;
        for (const item of items) {
          rows.push({ widget: widget.title, series: String(item.name), bucket: "", value: item.value });
        }
      }
    }
    downloadCsv(`${spec.name.replace(/\s+/g, "-").toLowerCase()}-${scope.preset}.csv`, rows);
  };

  return (
    <>
      <PageHeader
        title={spec.name}
        description={spec.description || undefined}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={exportCsv} disabled={!results.data}>
              <Download size={14} /> CSV
            </Button>
            {dashboard.canEdit ? (
              editing ? (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setEditing(false);
                      setDraft(null);
                    }}
                  >
                    Cancel
                  </Button>
                  <Button size="sm" onClick={() => save.mutate(spec)} disabled={save.isPending}>
                    <Save size={14} /> {save.isPending ? "Saving…" : "Save"}
                  </Button>
                </>
              ) : (
                <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                  <Pencil size={14} /> Edit
                </Button>
              )
            ) : null}
          </>
        }
      />

      {save.isError ? (
        <div className="mb-3">
          <Alert tone="critical" title="Could not save">
            {(save.error as Error).message}
          </Alert>
        </div>
      ) : null}

      {editing ? (
        <Card className="mb-3 space-y-3 p-3">
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-sm">
              <span className="mb-1 block text-xs text-[var(--text-muted)]">Name</span>
              <input
                value={spec.name}
                onChange={(event) => update({ name: event.target.value })}
                className="h-9 w-56 rounded-lg border border-[var(--border-strong)] bg-[var(--surface-1)] px-3 text-sm"
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-xs text-[var(--text-muted)]">Default range</span>
              <Select
                value={spec.defaultPreset}
                onChange={(event) => update({ defaultPreset: event.target.value as TimePreset })}
              >
                {["24h", "7d", "30d", "90d"].map((preset) => (
                  <option key={preset} value={preset}>
                    {preset}
                  </option>
                ))}
              </Select>
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-xs text-[var(--text-muted)]">Sharing</span>
              <Select
                value={spec.visibility === "private" ? "private" : spec.sharedWithRole}
                onChange={(event) =>
                  event.target.value === "private"
                    ? update({ visibility: "private" })
                    : update({
                        visibility: "shared",
                        sharedWithRole: event.target.value as "viewer" | "analyst" | "admin",
                      })
                }
              >
                <option value="private">Just me</option>
                <option value="viewer">Shared — viewers and up</option>
                <option value="analyst">Shared — analysts and up</option>
                <option value="admin">Shared — admins and up</option>
              </Select>
            </label>
            <div className="flex items-center gap-2 text-sm">
              <Switch
                checked={spec.tenantScope !== null}
                onChange={(pinned) => update({ tenantScope: pinned ? (scope.tenantIds ?? null) : null })}
                label="Pin customers"
              />
              <span className="text-[var(--text-secondary)]">
                Pin to the current customer selection
                {spec.tenantScope ? ` (${spec.tenantScope.length})` : ""}
              </span>
            </div>
            <div className="ml-auto flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setShowAdd((value) => !value)}>
                <Plus size={14} /> Add widget
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={() => {
                  if (confirm(`Delete "${spec.name}"?`)) remove.mutate();
                }}
              >
                <Trash2 size={14} /> Delete
              </Button>
            </div>
          </div>

          {showAdd ? (
            <AddWidgetPanel
              catalog={catalog}
              onAdd={(widget) => {
                update({ widgets: [...spec.widgets, widget] });
                setShowAdd(false);
              }}
            />
          ) : null}
        </Card>
      ) : null}

      {widgets.length === 0 ? (
        <Card>
          <EmptyState
            title="This dashboard has no widgets yet"
            description="Switch to edit mode and add one from the metric catalog."
            action={
              dashboard.canEdit ? (
                <Button
                  onClick={() => {
                    setEditing(true);
                    setShowAdd(true);
                  }}
                >
                  Add a widget
                </Button>
              ) : null
            }
          />
        </Card>
      ) : (
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
                loading={results.isPending}
                betterWhen={metric?.betterWhen ?? "neutral"}
                actions={
                  editing ? (
                    <WidgetEditor
                      widget={widget}
                      catalog={catalog}
                      onChange={(next) => updateWidget(widget.id, next)}
                      onRemove={() =>
                        update({ widgets: spec.widgets.filter((candidate) => candidate.id !== widget.id) })
                      }
                    />
                  ) : null
                }
              />
            );
          })}
        </div>
      )}
    </>
  );
}

function WidgetEditor({
  widget,
  catalog,
  onChange,
  onRemove,
}: {
  widget: WidgetSpec;
  catalog: Catalog;
  onChange: (next: Partial<WidgetSpec>) => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const metric = catalog.metrics.find((candidate) => candidate.id === widget.metric);

  return (
    <div className="relative">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen((value) => !value)}
        aria-label="Widget settings"
      >
        <Settings2 size={14} />
      </Button>
      {open ? (
        <div className="absolute right-0 z-30 mt-1 w-64 space-y-2 rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-3 shadow-xl">
          <label className="block text-xs text-[var(--text-muted)]">
            Title
            <input
              value={widget.title}
              onChange={(event) => onChange({ title: event.target.value })}
              className="mt-1 h-8 w-full rounded-md border border-[var(--border-strong)] bg-[var(--surface-1)] px-2 text-sm text-[var(--text-primary)]"
            />
          </label>
          <label className="block text-xs text-[var(--text-muted)]">
            Visualization
            <Select
              className="mt-1 h-8 w-full"
              value={widget.viz}
              onChange={(event) => onChange({ viz: event.target.value as WidgetSpec["viz"] })}
            >
              {(metric?.viz ?? [widget.viz]).map((viz) => (
                <option key={viz} value={viz}>
                  {viz}
                </option>
              ))}
            </Select>
          </label>
          <label className="block text-xs text-[var(--text-muted)]">
            Group by
            <Select
              className="mt-1 h-8 w-full"
              value={widget.groupBy ?? ""}
              onChange={(event) =>
                onChange({ groupBy: (event.target.value || undefined) as WidgetSpec["groupBy"] })
              }
            >
              <option value="">No grouping</option>
              {(metric?.dims ?? []).map((dim) => (
                <option key={dim} value={dim}>
                  {catalog.dimensions[dim]?.label ?? dim}
                </option>
              ))}
            </Select>
          </label>
          <label className="block text-xs text-[var(--text-muted)]">
            Size
            <Select
              className="mt-1 h-8 w-full"
              value={widget.size}
              onChange={(event) => onChange({ size: event.target.value as WidgetSize })}
            >
              {(Object.keys(SIZE_SPEC) as WidgetSize[]).map((size) => (
                <option key={size} value={size}>
                  {size} ({SIZE_SPEC[size].span}/12)
                </option>
              ))}
            </Select>
          </label>
          <div className="flex items-center justify-between pt-1">
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
              <X size={14} /> Close
            </Button>
            <Button variant="danger" size="sm" onClick={onRemove}>
              <Trash2 size={14} /> Remove
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function AddWidgetPanel({ catalog, onAdd }: { catalog: Catalog; onAdd: (widget: WidgetSpec) => void }) {
  const [category, setCategory] = useState(Object.keys(catalog.categories)[0] ?? "usage");
  const metrics = catalog.metrics.filter((metric) => metric.category === category);

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3">
      <div className="mb-2 flex flex-wrap gap-1.5">
        {Object.entries(catalog.categories).map(([key, info]) => (
          <Button
            key={key}
            size="sm"
            variant={key === category ? "default" : "outline"}
            onClick={() => setCategory(key)}
          >
            {info.label}
          </Button>
        ))}
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {metrics.map((metric) => (
          <button
            type="button"
            key={metric.id}
            disabled={!metric.available}
            onClick={() =>
              onAdd({
                id: `${metric.id.replace(/\W+/g, "-")}-${Math.random().toString(36).slice(2, 7)}`,
                title: metric.label,
                viz: metric.viz.includes("kpi") ? "kpi" : metric.viz[0]!,
                metric: metric.id,
                topN: 8,
                grain: "auto",
                filters: {},
                compare: true,
                size: metric.viz.includes("kpi") ? "sm" : "md",
              })
            }
            className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-2.5 text-left transition-colors hover:border-[var(--accent)] disabled:opacity-50"
          >
            <p className="text-[13px] font-medium text-[var(--text-primary)]">{metric.label}</p>
            <p className="mt-0.5 line-clamp-2 text-[11px] text-[var(--text-muted)]">{metric.description}</p>
            {!metric.available ? (
              <span className="mt-1 inline-block">
                <Badge tone="warning">needs a {metric.requires} connection</Badge>
              </span>
            ) : null}
          </button>
        ))}
      </div>
    </div>
  );
}

function toSpec(dashboard: Awaited<ReturnType<typeof api.dashboard>>): DashboardSpec {
  return {
    name: dashboard.name,
    description: dashboard.description,
    goal: dashboard.goal,
    widgets: dashboard.widgets,
    defaultPreset: dashboard.defaultPreset,
    tenantScope: dashboard.tenantScope,
    visibility: dashboard.visibility,
    sharedWithRole: dashboard.sharedWithRole,
  };
}

export { vizResultKind };

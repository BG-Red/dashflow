import {
  type DashboardSpec,
  defaultLayout,
  GRID_COLUMNS,
  GRID_ROW_HEIGHT,
  METRICS_BY_ID,
  type TimePreset,
  type WidgetSpec,
} from "@dashflow/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Download, Pencil, Plus, RefreshCw, Save, Settings2, Star, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { GridLayout, type Layout, type LayoutItem } from "react-grid-layout";
import { useLocation } from "wouter";
import { DrillDrawer, type DrillRequest } from "../components/drill-drawer";
import { PageHeader } from "../components/layout";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  MultiSelect,
  SegmentedControl,
  Select,
  Skeleton,
  Switch,
  useToast,
} from "../components/ui";
import { type DrillTarget, WidgetCard } from "../components/widgets";
import { api, type Catalog } from "../lib/api";
import { useScope } from "../lib/scope";
import { useElementWidth } from "../lib/use-measure";
import { cn, downloadCsv } from "../lib/utils";

const DRAG_HANDLE = "df-drag-handle";

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

const REFRESH_OPTIONS = [
  { value: "off", label: "Off" },
  { value: "30", label: "30s" },
  { value: "60", label: "1m" },
  { value: "300", label: "5m" },
] as const;

type RefreshValue = (typeof REFRESH_OPTIONS)[number]["value"];

export function DashboardView({ id, catalog }: { id: string; catalog: Catalog }) {
  const queryClient = useQueryClient();
  const scope = useScope();
  const toast = useToast();
  const [, navigate] = useLocation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<DashboardSpec | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [drill, setDrill] = useState<DrillRequest | null>(null);
  const [refresh, setRefresh] = useState<RefreshValue>("off");
  const { ref: gridRef, width, measured } = useElementWidth<HTMLDivElement>();

  const { data: dashboard, isLoading } = useQuery({
    queryKey: ["dashboard", id],
    queryFn: () => api.dashboard(id),
  });

  useEffect(() => {
    if (dashboard && !editing) setDraft(null);
  }, [dashboard, editing]);

  const spec: DashboardSpec | null = draft ?? (dashboard ? toSpec(dashboard) : null);
  const widgets = useMemo(() => (spec ? defaultLayout(spec.widgets) : []), [spec]);

  const queries = useMemo(
    () => (widgets.length > 0 ? buildQueries(widgets, scope, spec?.tenantScope ?? null) : []),
    [widgets, scope, spec?.tenantScope],
  );

  const results = useQuery({
    queryKey: ["dashboard-data", id, queries],
    queryFn: () => api.queryBatch({ tz: scope.tz, queries: queries.map((query) => ({ ...query })) }),
    enabled: queries.length > 0,
    staleTime: 30_000,
    refetchInterval: refresh === "off" ? false : Number(refresh) * 1000,
  });

  const save = useMutation({
    mutationFn: (next: DashboardSpec) => api.saveDashboard(id, next),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["dashboard", id] });
      await queryClient.invalidateQueries({ queryKey: ["dashboards"] });
      setEditing(false);
      setDraft(null);
      toast.success("Dashboard saved");
    },
    onError: (error) => toast.error("Could not save", (error as Error).message),
  });

  const remove = useMutation({
    mutationFn: () => api.deleteDashboard(id),
    onSuccess: () => {
      toast.success("Dashboard deleted");
      navigate("/");
    },
  });

  const duplicate = useMutation({
    mutationFn: () => api.duplicateDashboard(id),
    onSuccess: (result) => {
      toast.success("Copied", "You are now looking at your own copy.");
      navigate(`/dashboards/${result.id}`);
    },
  });

  const favorite = useMutation({
    mutationFn: (next: boolean) => api.setFavorite(id, next),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["dashboards"] });
      void queryClient.invalidateQueries({ queryKey: ["dashboard", id] });
    },
  });

  const update = useCallback(
    (next: Partial<DashboardSpec>) =>
      setDraft((current) => ({ ...(current ?? (spec as DashboardSpec)), ...next })),
    [spec],
  );

  const onLayoutChange = useCallback(
    (layout: Layout) => {
      if (!editing || !spec) return;
      const byId = new Map<string, LayoutItem>(layout.map((item) => [item.i, item]));
      const nextWidgets = spec.widgets.map((widget) => {
        const position = byId.get(widget.id);
        return position
          ? { ...widget, layout: { x: position.x, y: position.y, w: position.w, h: position.h } }
          : widget;
      });
      // Only rewrite the draft when something actually moved, or every render loops.
      const changed = nextWidgets.some((widget, index) => {
        const before = spec.widgets[index]?.layout;
        return (
          before?.x !== widget.layout?.x ||
          before?.y !== widget.layout?.y ||
          before?.w !== widget.layout?.w ||
          before?.h !== widget.layout?.h
        );
      });
      if (changed) update({ widgets: nextWidgets });
    },
    [editing, spec, update],
  );

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
  const updateWidget = (widgetId: string, next: Partial<WidgetSpec>) =>
    update({
      widgets: spec.widgets.map((widget) => (widget.id === widgetId ? { ...widget, ...next } : widget)),
    });

  const openDrill = (widget: WidgetSpec) => (target: DrillTarget) =>
    setDrill({
      ...target,
      metric: widget.metric,
      groupBy: widget.groupBy,
      tenantIds: spec.tenantScope ?? scope.tenantIds,
      hostPools: [...(widget.filters.hostPools ?? []), ...scope.hostPools],
      rangeFrom: scope.range.from.toISOString(),
      rangeTo: scope.range.to.toISOString(),
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
        breadcrumb={[{ label: "Dashboards", href: "/" }, { label: spec.name }]}
        title={spec.name}
        description={spec.description || undefined}
        actions={
          <>
            <SegmentedControl
              size="sm"
              ariaLabel="Auto refresh"
              value={refresh}
              onChange={(value) => setRefresh(value)}
              options={REFRESH_OPTIONS.map((option) => ({
                value: option.value,
                label: option.label,
                title: option.value === "off" ? "No auto refresh" : `Refresh every ${option.label}`,
              }))}
            />
            <Button
              variant="ghost"
              size="sm"
              aria-label={dashboard.favorite ? "Remove from favourites" : "Add to favourites"}
              onClick={() => favorite.mutate(!dashboard.favorite)}
            >
              <Star
                size={15}
                className={dashboard.favorite ? "fill-[var(--warning)] text-[var(--warning)]" : ""}
              />
            </Button>
            <Button variant="outline" size="sm" onClick={exportCsv} disabled={!results.data}>
              <Download size={14} /> CSV
            </Button>
            <Button
              variant="outline"
              size="sm"
              aria-label="Refresh"
              onClick={() => results.refetch()}
              disabled={results.isFetching}
            >
              <RefreshCw size={14} className={results.isFetching ? "animate-spin" : ""} />
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
                <>
                  <Button variant="ghost" size="sm" aria-label="Duplicate" onClick={() => duplicate.mutate()}>
                    <Copy size={14} />
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                    <Pencil size={14} /> Edit
                  </Button>
                </>
              )
            ) : (
              <Button variant="outline" size="sm" onClick={() => duplicate.mutate()}>
                <Copy size={14} /> Make a copy
              </Button>
            )}
          </>
        }
      />

      {editing ? (
        <Card className="mb-3 space-y-3 p-3">
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-sm">
              <span className="mb-1 block text-xs text-[var(--text-muted)]">Name</span>
              <Input
                value={spec.name}
                onChange={(event) => update({ name: event.target.value })}
                className="w-56"
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
                Pin to the current customers{spec.tenantScope ? ` (${spec.tenantScope.length})` : ""}
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

          <p className="text-xs text-[var(--text-muted)]">
            Drag a widget by its title to move it, or pull the bottom-right corner to resize.
          </p>

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
        /* The grid needs a real width: rendering before the container is measured would lay
           every widget out against a guess and then visibly jump. */
        <div ref={gridRef} className={cn(editing && "df-editing")}>
          {!measured ? (
            <Skeleton className="h-64 w-full" />
          ) : (
            <GridLayout
              className="layout"
              width={width}
              gridConfig={{
                cols: GRID_COLUMNS,
                rowHeight: GRID_ROW_HEIGHT,
                margin: [12, 12],
                containerPadding: [0, 0],
              }}
              dragConfig={{ enabled: editing, handle: `.${DRAG_HANDLE}` }}
              resizeConfig={{ enabled: editing }}
              onLayoutChange={onLayoutChange}
              layout={widgets.map((widget) => ({ i: widget.id, ...widget.layout, minW: 2, minH: 3 }))}
            >
              {widgets.map((widget) => {
                const entry = byKey.get(widget.id);
                const metric = METRICS_BY_ID[widget.metric];
                return (
                  <div key={widget.id}>
                    <WidgetCard
                      fill
                      dragHandleClass={editing ? DRAG_HANDLE : undefined}
                      widget={widget}
                      result={entry?.result}
                      error={entry?.error}
                      loading={results.isPending}
                      betterWhen={metric?.betterWhen ?? "neutral"}
                      onDrill={editing ? undefined : openDrill(widget)}
                      actions={
                        editing ? (
                          <WidgetEditor
                            widget={widget}
                            catalog={catalog}
                            onChange={(next) => updateWidget(widget.id, next)}
                            onRemove={() =>
                              update({
                                widgets: spec.widgets.filter((candidate) => candidate.id !== widget.id),
                              })
                            }
                          />
                        ) : null
                      }
                    />
                  </div>
                );
              })}
            </GridLayout>
          )}
        </div>
      )}

      <DrillDrawer request={drill} onClose={() => setDrill(null)} />
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
  const [filterDim, setFilterDim] = useState<string>("");

  const { data: values } = useQuery({
    queryKey: ["dim-values", widget.metric, filterDim],
    queryFn: () => api.dimensionValues(widget.metric, filterDim),
    enabled: Boolean(filterDim),
  });

  const dims = (widget.filters.dims ?? {}) as Record<string, string[]>;
  const selectedValues = filterDim ? (dims[filterDim] ?? null) : null;

  return (
    <div className="relative">
      <Button
        variant="ghost"
        size="xs"
        onClick={() => setOpen((value) => !value)}
        aria-label="Widget settings"
      >
        <Settings2 size={14} />
      </Button>
      {open ? (
        <div className="absolute right-0 z-30 mt-1 w-72 space-y-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-1)] p-3 shadow-[var(--elev-3)]">
          <label className="block text-xs text-[var(--text-muted)]">
            Title
            <Input
              className="mt-1 h-8"
              value={widget.title}
              onChange={(event) => onChange({ title: event.target.value })}
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

          <div className="space-y-1.5 border-t border-[var(--border)] pt-2">
            <p className="text-xs text-[var(--text-muted)]">Filter</p>
            <Select
              className="h-8 w-full"
              value={filterDim}
              onChange={(event) => setFilterDim(event.target.value)}
            >
              <option value="">Pick a dimension…</option>
              {(metric?.dims ?? []).map((dim) => (
                <option key={dim} value={dim}>
                  {catalog.dimensions[dim]?.label ?? dim}
                </option>
              ))}
            </Select>
            {filterDim ? (
              <MultiSelect
                className="w-full"
                allLabel="Any value"
                options={(values?.values ?? []).map((item) => ({
                  value: item.value,
                  label: item.value,
                  hint: `${item.hits} rows`,
                }))}
                selected={selectedValues}
                onChange={(next) => {
                  const nextDims = { ...dims };
                  if (next === null || next.length === 0) delete nextDims[filterDim];
                  else nextDims[filterDim] = next;
                  onChange({
                    filters: { ...widget.filters, dims: nextDims as WidgetSpec["filters"]["dims"] },
                  });
                }}
              />
            ) : null}
            {Object.keys(dims).length > 0 ? (
              <div className="flex flex-wrap gap-1 pt-1">
                {Object.entries(dims).map(([dim, list]) => (
                  <Badge key={dim} tone="accent">
                    {catalog.dimensions[dim]?.short ?? dim}: {list.length}
                  </Badge>
                ))}
              </div>
            ) : null}
          </div>

          <div className="flex items-center justify-between border-t border-[var(--border)] pt-2">
            <Button variant="ghost" size="xs" onClick={() => setOpen(false)}>
              <X size={13} /> Close
            </Button>
            <Button variant="danger" size="xs" onClick={onRemove}>
              <Trash2 size={13} /> Remove
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
    <div className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] p-3">
      <div className="mb-2 flex flex-wrap gap-1.5">
        {Object.entries(catalog.categories).map(([key, info]) => (
          <Button
            key={key}
            size="xs"
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
            className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-1)] p-2.5 text-left transition-colors hover:border-[var(--accent)] disabled:opacity-50"
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

import {
  CATEGORY_INFO,
  type DimensionId,
  getMetric,
  type MetricCategory,
  type WidgetSpec,
} from "@dashflow/core";
import { useMutation, useQuery } from "@tanstack/react-query";
import { BarChart3, Compass, Plus, Share2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { DrillDrawer, type DrillRequest } from "../components/drill-drawer";
import { PageHeader } from "../components/layout";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Modal,
  MultiSelect,
  SegmentedControl,
  SelectMenu,
  useToast,
} from "../components/ui";
import { type DrillTarget, WidgetCard } from "../components/widgets";
import { api, type Catalog } from "../lib/api";
import { useScope } from "../lib/scope";

/**
 * Ad-hoc questions. Pick a metric, split it, filter it, look at it — and when the answer is
 * worth keeping, save it onto a dashboard as a widget. The state lives in the URL, so a link
 * to an interesting view is just a copy and paste.
 */
export function ExplorePage({ catalog, canSave }: { catalog: Catalog; canSave: boolean }) {
  const scope = useScope();
  const toast = useToast();
  const [, navigate] = useLocation();
  const search = useSearch();

  const params = useMemo(() => new URLSearchParams(search), [search]);
  const [metric, setMetric] = useState(params.get("metric") ?? "connections.count");
  const [viz, setViz] = useState<WidgetSpec["viz"]>((params.get("viz") as WidgetSpec["viz"]) ?? "line");
  const [groupBy, setGroupBy] = useState<string>(params.get("groupBy") ?? "");
  const [filterDim, setFilterDim] = useState<string>(params.get("filterDim") ?? "");
  const [filterValues, setFilterValues] = useState<string[] | null>(
    params.get("filterValues") ? params.get("filterValues")!.split("~") : null,
  );
  const [drill, setDrill] = useState<DrillRequest | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);

  const definition = getMetric(metric);
  const catalogMetric = catalog.metrics.find((candidate) => candidate.id === metric);
  const allowedViz = catalogMetric?.viz ?? ["line"];
  const dims = catalogMetric?.dims ?? [];

  // Keep the visualization legal when the metric changes under it.
  useEffect(() => {
    if (!allowedViz.includes(viz)) setViz(allowedViz[0]!);
    if (groupBy && !dims.includes(groupBy)) setGroupBy("");
    if (filterDim && !dims.includes(filterDim)) {
      setFilterDim("");
      setFilterValues(null);
    }
  }, [allowedViz, viz, dims, groupBy, filterDim]);

  // Mirror the question into the URL so it can be shared.
  useEffect(() => {
    const next = new URLSearchParams();
    next.set("metric", metric);
    next.set("viz", viz);
    if (groupBy) next.set("groupBy", groupBy);
    if (filterDim && filterValues?.length) {
      next.set("filterDim", filterDim);
      next.set("filterValues", filterValues.join("~"));
    }
    window.history.replaceState(null, "", `/explore?${next.toString()}`);
  }, [metric, viz, groupBy, filterDim, filterValues]);

  const { data: values } = useQuery({
    queryKey: ["dim-values", metric, filterDim],
    queryFn: () => api.dimensionValues(metric, filterDim),
    enabled: Boolean(filterDim),
  });

  const widget: WidgetSpec = useMemo(
    () => ({
      id: "explore",
      title: definition?.label ?? metric,
      subtitle: groupBy ? `split by ${catalog.dimensions[groupBy]?.label ?? groupBy}` : undefined,
      viz,
      metric,
      groupBy: (groupBy || undefined) as DimensionId | undefined,
      topN: 10,
      grain: "auto",
      filters: filterDim && filterValues?.length ? { dims: { [filterDim]: filterValues } as never } : {},
      compare: true,
      size: "xl",
    }),
    [definition, metric, viz, groupBy, filterDim, filterValues, catalog.dimensions],
  );

  const result = useQuery({
    queryKey: [
      "explore",
      widget,
      scope.range.from.getTime(),
      scope.range.to.getTime(),
      scope.tenantIds,
      scope.hostPools,
    ],
    queryFn: () =>
      api.query({
        metric: widget.metric,
        viz: widget.viz,
        groupBy: widget.groupBy,
        topN: widget.topN,
        grain: scope.range.grain,
        from: scope.range.from,
        to: scope.range.to,
        tenantIds: scope.tenantIds,
        filters: { hostPools: scope.hostPools, dims: widget.filters.dims },
        compare: widget.viz === "kpi",
        tz: scope.tz,
      }),
  });

  const dashboards = useQuery({ queryKey: ["dashboards"], queryFn: api.dashboards, enabled: saveOpen });

  const saveToDashboard = useMutation({
    mutationFn: async (dashboardId: string) => {
      const dashboard = await api.dashboard(dashboardId);
      const widgetToAdd: WidgetSpec = {
        ...widget,
        id: `${metric.replace(/\W+/g, "-")}-${Math.random().toString(36).slice(2, 7)}`,
        size: viz === "kpi" ? "sm" : "md",
        layout: undefined,
      };
      await api.saveDashboard(dashboardId, {
        name: dashboard.name,
        description: dashboard.description,
        goal: dashboard.goal,
        widgets: [...dashboard.widgets, widgetToAdd],
        defaultPreset: dashboard.defaultPreset,
        tenantScope: dashboard.tenantScope,
        visibility: dashboard.visibility,
        sharedWithRole: dashboard.sharedWithRole,
      });
      return dashboardId;
    },
    onSuccess: (dashboardId) => {
      setSaveOpen(false);
      toast.success("Added to dashboard");
      navigate(`/dashboards/${dashboardId}`);
    },
    onError: (error) => toast.error("Could not add the widget", (error as Error).message),
  });

  const byCategory = useMemo(() => {
    const groups: Record<string, { value: string; label: string; hint?: string }[]> = {};
    for (const item of catalog.metrics) {
      const list = groups[item.category] ?? [];
      list.push({
        value: item.id,
        label: item.label,
        hint: item.available ? item.description : `needs a ${item.requires} connection`,
      });
      groups[item.category] = list;
    }
    return groups;
  }, [catalog.metrics]);

  const onDrill = (target: DrillTarget) =>
    setDrill({
      ...target,
      metric,
      groupBy: groupBy || undefined,
      tenantIds: scope.tenantIds,
      hostPools: scope.hostPools,
      rangeFrom: scope.range.from.toISOString(),
      rangeTo: scope.range.to.toISOString(),
    });

  return (
    <>
      <PageHeader
        title="Explore"
        description="Ask a question of the data without building a dashboard first."
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void navigator.clipboard?.writeText(window.location.href);
                toast.success("Link copied", "It carries the metric, split and filter.");
              }}
            >
              <Share2 size={14} /> Copy link
            </Button>
            {canSave ? (
              <Button size="sm" onClick={() => setSaveOpen(true)}>
                <Plus size={14} /> Save as widget
              </Button>
            ) : null}
          </>
        }
      />

      <Card className="mb-3 flex flex-wrap items-end gap-3 p-3">
        <label className="block text-xs text-[var(--text-muted)]">
          Metric
          <div className="mt-1 w-64">
            <SelectMenu
              icon={<BarChart3 size={13} />}
              value={metric}
              onChange={setMetric}
              width="w-80"
              options={Object.entries(byCategory).flatMap(([category, items]) =>
                items.map((item) => ({
                  ...item,
                  label: `${CATEGORY_INFO[category as MetricCategory]?.label ?? category} · ${item.label}`,
                })),
              )}
            />
          </div>
        </label>

        <label className="block text-xs text-[var(--text-muted)]">
          Split by
          <div className="mt-1 w-48">
            <SelectMenu
              searchable={false}
              value={groupBy || "none"}
              onChange={(value) => setGroupBy(value === "none" ? "" : value)}
              options={[
                { value: "none", label: "No split" },
                ...dims.map((dim) => ({ value: dim, label: catalog.dimensions[dim]?.label ?? dim })),
              ]}
            />
          </div>
        </label>

        <label className="block text-xs text-[var(--text-muted)]">
          Filter
          <div className="mt-1 flex items-center gap-1.5">
            <SelectMenu
              searchable={false}
              className="w-40"
              value={filterDim || "none"}
              onChange={(value) => {
                setFilterDim(value === "none" ? "" : value);
                setFilterValues(null);
              }}
              options={[
                { value: "none", label: "No filter" },
                ...dims.map((dim) => ({ value: dim, label: catalog.dimensions[dim]?.label ?? dim })),
              ]}
            />
            {filterDim ? (
              <MultiSelect
                allLabel="Any value"
                options={(values?.values ?? []).map((item) => ({
                  value: item.value,
                  label: item.value,
                  hint: `${item.hits.toLocaleString()} rows`,
                }))}
                selected={filterValues}
                onChange={setFilterValues}
              />
            ) : null}
          </div>
        </label>

        <div className="ml-auto">
          <SegmentedControl
            ariaLabel="Visualization"
            value={viz}
            onChange={(value) => setViz(value as WidgetSpec["viz"])}
            options={allowedViz.map((option) => ({ value: option, label: option.replace("-", " ") }))}
          />
        </div>
      </Card>

      {catalogMetric && !catalogMetric.available ? (
        <div className="mb-3">
          <Badge tone="warning">
            This metric needs a {catalogMetric.requires} connection before it returns anything.
          </Badge>
        </div>
      ) : null}

      <div style={{ height: 460 }}>
        <WidgetCard
          fill
          widget={widget}
          result={result.data}
          error={result.error ? (result.error as Error).message : undefined}
          loading={result.isPending}
          betterWhen={definition?.betterWhen ?? "neutral"}
          onDrill={onDrill}
        />
      </div>

      <p className="mt-2 text-xs text-[var(--text-muted)]">
        Click any point, bar or row to see the underlying records.
      </p>

      <Modal
        open={saveOpen}
        onClose={() => setSaveOpen(false)}
        title="Add to a dashboard"
        description="The widget keeps this metric, split and filter."
      >
        {dashboards.isPending ? (
          <p className="text-sm text-[var(--text-muted)]">Loading dashboards…</p>
        ) : (dashboards.data ?? []).length === 0 ? (
          <EmptyState
            icon={<Compass size={20} />}
            title="No dashboards yet"
            description="Build one first, then save widgets onto it."
            action={<Button onClick={() => navigate("/dashboards/new")}>Build a dashboard</Button>}
          />
        ) : (
          <div className="space-y-1">
            {(dashboards.data ?? []).map((dashboard) => (
              <button
                type="button"
                key={dashboard.id}
                disabled={saveToDashboard.isPending}
                onClick={() => saveToDashboard.mutate(dashboard.id)}
                className="flex w-full items-center justify-between rounded-[var(--radius-sm)] border border-[var(--border)] px-3 py-2 text-left text-sm hover:border-[var(--accent)] hover:bg-[var(--surface-2)]"
              >
                <span>
                  <span className="block text-[var(--text-primary)]">{dashboard.name}</span>
                  <span className="block text-[11px] text-[var(--text-muted)]">
                    {dashboard.widgetCount} widgets
                  </span>
                </span>
                <Plus size={14} className="text-[var(--text-muted)]" />
              </button>
            ))}
          </div>
        )}
      </Modal>

      <DrillDrawer request={drill} onClose={() => setDrill(null)} />
    </>
  );
}

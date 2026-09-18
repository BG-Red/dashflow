import { formatUnit, type MetricUnit, type QueryResult, SIZE_SPEC, type WidgetSpec } from "@dashflow/core";
import type * as echarts from "echarts/core";
import {
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  ChartNoAxesColumn,
  Table as TableIcon,
  TriangleAlert,
} from "lucide-react";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { seriesColors } from "../lib/series-color";
import { cn, cssVar, SEQUENTIAL_VARS } from "../lib/utils";
import { baseOption, Chart, useChartTokens } from "./chart";
import { Badge, Card, CardHeader, DataTable, EmptyState, Skeleton, StatusDot } from "./ui";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** What was clicked, so the caller can open the rows behind it. */
export interface DrillTarget {
  label: string;
  /** The series or group the click landed on, if the chart is split. */
  groupValue?: string;
  /** Bucket start and end, for time series. */
  from?: string;
  to?: string;
}

function fmt(unit: string, value: number | null | undefined, currency?: string): string {
  if (value == null) return "—";
  return formatUnit(unit as MetricUnit, value, currency);
}

/** Direction of a change, and whether that direction is good for this metric. */
function trend(
  value: number | null | undefined,
  previous: number | null | undefined,
  betterWhen: "lower" | "higher" | "neutral",
) {
  if (value == null || previous == null || previous === 0) return null;
  const change = ((value - previous) / Math.abs(previous)) * 100;
  if (Math.abs(change) < 0.5) return { change, tone: "neutral" as const, icon: ArrowRight };
  const improving = betterWhen === "neutral" ? null : betterWhen === "lower" ? change < 0 : change > 0;
  return {
    change,
    tone: improving === null ? ("neutral" as const) : improving ? ("good" as const) : ("bad" as const),
    icon: change > 0 ? ArrowUpRight : ArrowDownRight,
  };
}

function Sparkline({ points, tone }: { points: { value: number | null }[]; tone: string }) {
  const path = useMemo(() => {
    const values = points.map((point) => point.value).filter((value): value is number => value != null);
    if (values.length < 2) return null;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    const step = 100 / (points.length - 1);
    let started = false;
    const segments: string[] = [];
    points.forEach((point, index) => {
      if (point.value == null) {
        started = false;
        return;
      }
      const x = index * step;
      const y = 26 - ((point.value - min) / span) * 22;
      segments.push(`${started ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`);
      started = true;
    });
    return segments.join(" ");
  }, [points]);

  if (!path) return null;
  return (
    <svg viewBox="0 0 100 30" preserveAspectRatio="none" className="h-7 w-full" aria-hidden>
      <path
        d={path}
        fill="none"
        stroke={tone}
        strokeWidth={2}
        vectorEffect="non-scaling-stroke"
        strokeLinecap="round"
      />
    </svg>
  );
}

function KpiTile({
  result,
  betterWhen,
}: {
  result: Extract<QueryResult, { kind: "scalar" }>;
  betterWhen: "lower" | "higher" | "neutral";
}) {
  const movement = trend(result.value, result.previous, betterWhen);
  const Icon = movement?.icon;
  const accent = cssVar("--series-1", "#3987e5");

  return (
    <div className="flex h-full flex-col justify-between px-4 pb-3">
      <div>
        <p className="text-[27px] leading-none font-semibold tracking-tight text-[var(--text-primary)] tabular-nums">
          {fmt(result.unit, result.value, result.currency)}
        </p>
        {movement && Icon ? (
          <p
            className={cn(
              "mt-1.5 flex items-center gap-1 text-xs font-medium",
              movement.tone === "good" && "text-[var(--good)]",
              movement.tone === "bad" && "text-[var(--critical)]",
              movement.tone === "neutral" && "text-[var(--text-muted)]",
            )}
          >
            <Icon size={13} strokeWidth={2.5} />
            {Math.abs(movement.change).toFixed(movement.change < 10 ? 1 : 0)}%
            <span className="font-normal text-[var(--text-muted)]">vs previous</span>
          </p>
        ) : (
          <p className="mt-1.5 text-xs text-[var(--text-muted)]">no comparison available</p>
        )}
      </div>
      {result.spark && result.spark.length > 1 ? (
        <div className="mt-2 -mb-1">
          <Sparkline points={result.spark} tone={accent} />
        </div>
      ) : null}
    </div>
  );
}

function bucketMs(grain: string): number {
  return grain === "day" ? 86_400_000 : 3_600_000;
}

function SeriesWidget({
  widget,
  result,
  height,
  onDrill,
}: {
  widget: WidgetSpec;
  result: Extract<QueryResult, { kind: "series" }>;
  height: number;
  onDrill?: (target: DrillTarget) => void;
}) {
  const tokens = useChartTokens();
  const option = useMemo(() => {
    const colors = seriesColors(result.series.map((series) => series.name));
    const base = baseOption(tokens);
    const stacked = widget.viz === "stacked-bar";
    const area = widget.viz === "area";
    const multi = result.series.length > 1;

    return {
      ...base,
      color: colors,
      legend: { ...base.legend, show: multi },
      grid: { left: 8, right: 14, top: 10, bottom: multi ? 28 : 6, containLabel: true },
      tooltip: {
        ...base.tooltip,
        trigger: "axis",
        valueFormatter: (value: number) => fmt(result.unit, value, result.currency),
      },
      xAxis: {
        type: "time",
        axisLine: { lineStyle: { color: tokens.border } },
        axisTick: { show: false },
        axisLabel: { color: tokens.inkMuted, fontSize: 11, hideOverlap: true },
        splitLine: { show: false },
      },
      yAxis: {
        type: "value",
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: {
          color: tokens.inkMuted,
          fontSize: 11,
          formatter: (value: number) => fmt(result.unit, value, result.currency),
        },
        splitLine: { lineStyle: { color: tokens.grid, width: 1 } },
      },
      series: result.series.map((series, index) => ({
        name: series.name,
        type: stacked ? "bar" : "line",
        stack: stacked ? "total" : undefined,
        smooth: false,
        showSymbol: false,
        symbolSize: 9,
        connectNulls: false,
        lineStyle: { width: 2 },
        // A 2px surface gap between stacked fills, with rounded ends on the top segment.
        itemStyle: stacked
          ? { borderColor: tokens.surface, borderWidth: 2, borderRadius: [4, 4, 0, 0] }
          : undefined,
        areaStyle: area ? { opacity: 0.16, color: colors[index % colors.length] } : undefined,
        emphasis: { focus: "series" },
        data: series.points.map((point) => [point.ts, point.value]),
      })),
    } as echarts.EChartsCoreOption;
  }, [result, widget.viz, tokens]);

  const events = useMemo(
    () =>
      onDrill
        ? {
            click: (params: unknown) => {
              const point = params as { seriesName?: string; value?: [string, number] };
              const ts = point.value?.[0];
              if (!ts) return;
              const start = new Date(ts);
              onDrill({
                label:
                  point.seriesName && point.seriesName !== "total"
                    ? `${widget.title} · ${point.seriesName}`
                    : widget.title,
                groupValue: point.seriesName === "total" ? undefined : point.seriesName,
                from: start.toISOString(),
                to: new Date(start.getTime() + bucketMs(result.grain)).toISOString(),
              });
            },
          }
        : undefined,
    [onDrill, result.grain, widget.title],
  );

  if (result.series.every((series) => series.points.every((point) => point.value == null))) {
    return <NoData />;
  }
  return <Chart option={option} height={height} className="px-1" onEvents={events} />;
}

function BreakdownWidget({
  widget,
  result,
  height,
  onDrill,
}: {
  widget: WidgetSpec;
  result: Extract<QueryResult, { kind: "breakdown" }>;
  height: number;
  onDrill?: (target: DrillTarget) => void;
}) {
  const tokens = useChartTokens();
  const option = useMemo(() => {
    const base = baseOption(tokens);
    const donut = widget.viz === "donut";

    if (donut) {
      const colors = seriesColors(result.items.map((item) => item.name));
      return {
        ...base,
        color: colors,
        legend: { ...base.legend, show: true },
        tooltip: {
          ...base.tooltip,
          trigger: "item",
          valueFormatter: (value: number) => fmt(result.unit, value, result.currency),
        },
        series: [
          {
            type: "pie",
            radius: ["54%", "78%"],
            center: ["50%", "44%"],
            avoidLabelOverlap: true,
            label: { show: false },
            itemStyle: { borderColor: tokens.surface, borderWidth: 2 },
            data: result.items.map((item) => ({ name: item.name, value: item.value })),
          },
        ],
      } as echarts.EChartsCoreOption;
    }

    // Horizontal bars: the label carries the identity, so one accent colour is enough.
    const sorted = [...result.items].sort((a, b) => a.value - b.value);
    return {
      ...base,
      legend: { show: false },
      grid: { left: 8, right: 52, top: 6, bottom: 6, containLabel: true },
      tooltip: {
        ...base.tooltip,
        trigger: "item",
        valueFormatter: (value: number) => fmt(result.unit, value, result.currency),
      },
      xAxis: {
        type: "value",
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { show: false },
        splitLine: { show: false },
      },
      yAxis: {
        type: "category",
        data: sorted.map((item) => item.name),
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: tokens.inkSecondary, fontSize: 11, width: 140, overflow: "truncate" },
      },
      series: [
        {
          type: "bar",
          barMaxWidth: 15,
          itemStyle: { color: cssVar("--series-1", "#3987e5"), borderRadius: [0, 4, 4, 0] },
          label: {
            show: true,
            position: "right",
            color: tokens.inkSecondary,
            fontSize: 11,
            formatter: (params: { value: number }) => fmt(result.unit, params.value, result.currency),
          },
          data: sorted.map((item) => item.value),
        },
      ],
    } as echarts.EChartsCoreOption;
  }, [result, widget.viz, tokens]);

  const events = useMemo(
    () =>
      onDrill
        ? {
            click: (params: unknown) => {
              const point = params as { name?: string };
              if (!point.name) return;
              onDrill({ label: `${widget.title} · ${point.name}`, groupValue: point.name });
            },
          }
        : undefined,
    [onDrill, widget.title],
  );

  if (result.items.length === 0) return <NoData />;
  return <Chart option={option} height={height} className="px-1" onEvents={events} />;
}

function HeatmapWidget({
  result,
  height,
}: {
  result: Extract<QueryResult, { kind: "heatmap" }>;
  height: number;
}) {
  const tokens = useChartTokens();
  const option = useMemo(() => {
    const base = baseOption(tokens);
    const max = Math.max(1, ...result.cells.map((cell) => cell.value));
    return {
      ...base,
      legend: { show: false },
      grid: { left: 8, right: 16, top: 8, bottom: 44, containLabel: true },
      tooltip: {
        ...base.tooltip,
        trigger: "item",
        formatter: (params: { value: [number, number, number] }) =>
          `${DAYS[params.value[1]] ?? ""} ${String(params.value[0]).padStart(2, "0")}:00<br/><b>${fmt(
            result.unit,
            params.value[2],
            result.currency,
          )}</b>`,
      },
      xAxis: {
        type: "category",
        data: Array.from({ length: 24 }, (_, hour) => String(hour)),
        splitArea: { show: false },
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: {
          color: tokens.inkMuted,
          fontSize: 10,
          interval: 2,
          formatter: (value: string) => value.padStart(2, "0"),
        },
      },
      yAxis: {
        type: "category",
        data: DAYS,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: tokens.inkMuted, fontSize: 10 },
      },
      visualMap: {
        min: 0,
        max,
        calculable: false,
        orient: "horizontal",
        left: "center",
        bottom: 0,
        itemWidth: 10,
        itemHeight: 80,
        textStyle: { color: tokens.inkMuted, fontSize: 10 },
        inRange: { color: SEQUENTIAL_VARS.map((name) => cssVar(name, "#cde2fb")) },
        formatter: (value: number) => fmt(result.unit, value, result.currency),
      },
      series: [
        {
          type: "heatmap",
          data: result.cells.map((cell) => [cell.hour, cell.day, cell.value]),
          itemStyle: { borderColor: tokens.surface, borderWidth: 2, borderRadius: 3 },
          emphasis: { itemStyle: { borderColor: tokens.ink, borderWidth: 1 } },
          progressive: 0,
        },
      ],
    } as echarts.EChartsCoreOption;
  }, [result, tokens]);

  if (result.cells.length === 0) return <NoData />;
  return <Chart option={option} height={height} />;
}

function HostGridWidget({ result }: { result: Extract<QueryResult, { kind: "hosts" }> }) {
  if (result.hosts.length === 0) {
    return (
      <EmptyState
        title="No session hosts yet"
        description="They appear after the first inventory sync."
        compact
      />
    );
  }
  const tone = (status: string, drain: boolean) => {
    const s = status.toLowerCase();
    if (s === "available") return drain ? "warning" : "good";
    if (s === "shutdown" || s.includes("vmnotrunning")) return "neutral";
    return "critical";
  };

  return (
    <div className="h-full space-y-1.5 overflow-auto px-3 pb-3">
      {result.hosts.slice(0, 200).map((host) => (
        <div
          key={`${host.hostPool}/${host.name}`}
          className="flex items-center justify-between gap-3 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1.5"
        >
          <div className="min-w-0">
            <p className="truncate text-[13px] font-medium text-[var(--text-primary)]">{host.name}</p>
            <p className="truncate text-[11px] text-[var(--text-muted)]">
              {host.tenant} · {host.hostPool}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span className="text-[11px] text-[var(--text-muted)] tabular-nums">
              {host.sessions} sessions
            </span>
            {!host.allowNewSession ? <Badge tone="warning">drain</Badge> : null}
            <Badge
              tone={tone(host.status, !host.allowNewSession) as "good" | "warning" | "critical" | "neutral"}
            >
              {host.status}
            </Badge>
          </div>
        </div>
      ))}
    </div>
  );
}

function NoData() {
  return (
    <EmptyState
      compact
      title="No data in this range"
      description="Widen the time range, or check that this data stream has synced."
    />
  );
}

/**
 * Any chart can be read as a table. Three light-mode series colours sit below 3:1 contrast on
 * the light surface, and the palette's relief rule requires visible labels or a table view in
 * that case — so every widget carries one.
 */
function ResultTable({
  result,
  height,
  onDrill,
}: {
  result: QueryResult;
  height: number;
  onDrill?: (target: DrillTarget) => void;
}) {
  const rows: { name: string; value: number | null }[] = [];
  let unit = "count";
  let currency: string | undefined;

  switch (result.kind) {
    case "scalar":
      unit = result.unit;
      currency = result.currency;
      rows.push({ name: "Value", value: result.value });
      if (result.previous != null) rows.push({ name: "Previous period", value: result.previous });
      break;
    case "series":
      unit = result.unit;
      currency = result.currency;
      for (const series of result.series) {
        for (const point of series.points) {
          if (point.value == null) continue;
          rows.push({
            name: `${series.name === "total" ? "" : `${series.name} · `}${new Date(point.ts).toLocaleString()}`,
            value: point.value,
          });
        }
      }
      break;
    case "breakdown":
      unit = result.unit;
      currency = result.currency;
      rows.push(...result.items);
      break;
    case "table":
      unit = result.unit;
      currency = result.currency;
      rows.push(
        ...result.rows.map((row) => ({
          name: String(row.name ?? "—"),
          value: typeof row.value === "number" ? row.value : null,
        })),
      );
      break;
    case "heatmap":
      unit = result.unit;
      currency = result.currency;
      rows.push(
        ...result.cells.map((cell) => ({
          name: `${DAYS[cell.day] ?? "?"} ${String(cell.hour).padStart(2, "0")}:00`,
          value: cell.value,
        })),
      );
      break;
    case "hosts":
      rows.push(
        ...result.hosts.map((host) => ({ name: `${host.name} · ${host.status}`, value: host.sessions })),
      );
      break;
  }

  return (
    <DataTable
      dense
      maxHeight={height}
      pageSize={rows.length > 40 ? 20 : 0}
      rows={rows}
      rowKey={(row, index) => `${row.name}-${index}`}
      onRowClick={onDrill ? (row) => onDrill({ label: row.name, groupValue: row.name }) : undefined}
      columns={[
        { key: "name", label: "Series" },
        {
          key: "value",
          label: "Value",
          numeric: true,
          sortValue: (row) => row.value,
          render: (row) => fmt(unit, row.value, currency),
        },
      ]}
    />
  );
}

export function WidgetBody({
  widget,
  result,
  error,
  loading,
  betterWhen,
  height,
  asTable,
  onDrill,
}: {
  widget: WidgetSpec;
  result?: QueryResult;
  error?: string;
  loading?: boolean;
  betterWhen: "lower" | "higher" | "neutral";
  height: number;
  asTable?: boolean;
  onDrill?: (target: DrillTarget) => void;
}) {
  if (loading) {
    return (
      <div className="px-4 pb-4">
        <Skeleton className="w-full" style={{ height: Math.max(40, height - 8) }} />
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex items-start gap-2 px-4 pb-4 text-sm text-[var(--text-secondary)]">
        <TriangleAlert size={16} className="mt-0.5 shrink-0 text-[var(--warning)]" />
        <span>{error}</span>
      </div>
    );
  }
  if (!result) return <EmptyState title="No result" compact />;
  if (asTable) return <ResultTable result={result} height={height} onDrill={onDrill} />;

  switch (result.kind) {
    case "scalar":
      return <KpiTile result={result} betterWhen={betterWhen} />;
    case "series":
      return <SeriesWidget widget={widget} result={result} height={height} onDrill={onDrill} />;
    case "breakdown":
      return <BreakdownWidget widget={widget} result={result} height={height} onDrill={onDrill} />;
    case "heatmap":
      return <HeatmapWidget result={result} height={height} />;
    case "hosts":
      return <HostGridWidget result={result} />;
    case "table":
      return <ResultTable result={result} height={height} onDrill={onDrill} />;
  }
}

/** A widget card. In a grid it fills its cell; standalone it uses the size preset's height. */
export function WidgetCard({
  widget,
  result,
  error,
  loading,
  betterWhen,
  actions,
  onDrill,
  fill,
  dragHandleClass,
}: {
  widget: WidgetSpec;
  result?: QueryResult;
  error?: string;
  loading?: boolean;
  betterWhen: "lower" | "higher" | "neutral";
  actions?: ReactNode;
  onDrill?: (target: DrillTarget) => void;
  /** Stretch to the parent's height (grid mode) instead of the size preset. */
  fill?: boolean;
  dragHandleClass?: string;
}) {
  const spec = SIZE_SPEC[widget.size];
  const [asTable, setAsTable] = useState(false);
  const [bodyHeight, setBodyHeight] = useState(spec.height);
  const canTable = widget.viz !== "kpi";

  // In grid mode the card is sized by its cell, so the chart measures the space it was given.
  const measure = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node || !fill) return;
      const observer = new ResizeObserver(() => setBodyHeight(Math.max(80, node.clientHeight)));
      observer.observe(node);
      setBodyHeight(Math.max(80, node.clientHeight));
      return () => observer.disconnect();
    },
    [fill],
  );

  return (
    <Card
      className={cn("df-fade-in flex flex-col overflow-hidden", fill && "h-full")}
      style={fill ? undefined : { gridColumn: `span ${spec.span}` }}
    >
      <CardHeader
        className={dragHandleClass}
        title={widget.title}
        subtitle={widget.subtitle}
        actions={
          <>
            {canTable && result ? (
              <button
                type="button"
                title={asTable ? "Show the chart" : "Read the values as a table"}
                aria-label={asTable ? "Show the chart" : "Read the values as a table"}
                onClick={() => setAsTable((value) => !value)}
                className="rounded-md p-1 text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]"
              >
                {asTable ? <ChartNoAxesColumn size={14} /> : <TableIcon size={14} />}
              </button>
            ) : null}
            {actions}
          </>
        }
      />
      <div ref={measure} className={cn("min-h-0", fill && "flex-1")}>
        <WidgetBody
          widget={widget}
          result={result}
          error={error}
          loading={loading}
          betterWhen={betterWhen}
          height={fill ? bodyHeight : spec.height}
          asTable={asTable}
          onDrill={onDrill}
        />
      </div>
    </Card>
  );
}

export { StatusDot };

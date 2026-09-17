import { formatUnit, type MetricUnit, type QueryResult, SIZE_SPEC, type WidgetSpec } from "@avd/core";
import type * as echarts from "echarts/core";
import {
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  ChartNoAxesColumn,
  Table as TableIcon,
  TriangleAlert,
} from "lucide-react";
import { useMemo, useState } from "react";
import { cn, cssVar, SEQUENTIAL_VARS, SERIES_VARS } from "../lib/utils";
import { baseOption, Chart, useChartTokens } from "./chart";
import { Badge, Card, CardHeader, EmptyState, Skeleton, StatusDot, Table } from "./ui";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function seriesColors(): string[] {
  return SERIES_VARS.map((name, index) => cssVar(name, ["#2a78d6", "#eb6834", "#1baf7a"][index] ?? "#888"));
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
  const accent = cssVar("--series-1", "#2a78d6");

  return (
    <div className="flex h-full flex-col justify-between px-4 pb-3">
      <div>
        <p className="text-[26px] leading-none font-semibold tracking-tight text-[var(--text-primary)] tabular-nums">
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
            <span className="font-normal text-[var(--text-muted)]">vs previous period</span>
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

function SeriesWidget({
  widget,
  result,
  height,
}: {
  widget: WidgetSpec;
  result: Extract<QueryResult, { kind: "series" }>;
  height: number;
}) {
  const tokens = useChartTokens();
  const option = useMemo(() => {
    const colors = seriesColors();
    const stacked = widget.viz === "stacked-bar";
    const area = widget.viz === "area";
    const multi = result.series.length > 1;

    return {
      ...baseOption(tokens),
      color: colors,
      legend: { ...baseOption(tokens).legend, show: multi },
      grid: { left: 8, right: 14, top: 10, bottom: multi ? 28 : 6, containLabel: true },
      tooltip: {
        ...baseOption(tokens).tooltip,
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
        symbolSize: 8,
        connectNulls: false,
        lineStyle: { width: 2 },
        // 2px gap between stacked fills, and rounded data ends on the top segment.
        itemStyle: stacked
          ? { borderColor: tokens.surface, borderWidth: 2, borderRadius: [4, 4, 0, 0] }
          : undefined,
        areaStyle: area
          ? {
              opacity: 0.16,
              color: colors[index % colors.length],
            }
          : undefined,
        data: series.points.map((point) => [point.ts, point.value]),
      })),
    } as echarts.EChartsCoreOption;
  }, [result, widget.viz, tokens]);

  if (result.series.every((series) => series.points.every((point) => point.value == null))) {
    return (
      <EmptyState title="No data in this range" description="Try a wider time range or a different scope." />
    );
  }
  return <Chart option={option} height={height} className="px-1" />;
}

function BreakdownWidget({
  widget,
  result,
  height,
}: {
  widget: WidgetSpec;
  result: Extract<QueryResult, { kind: "breakdown" }>;
  height: number;
}) {
  const tokens = useChartTokens();
  const option = useMemo(() => {
    const colors = seriesColors();
    const donut = widget.viz === "donut";
    const base = baseOption(tokens);

    if (donut) {
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
            radius: ["52%", "76%"],
            center: ["50%", "44%"],
            avoidLabelOverlap: true,
            label: { show: false },
            itemStyle: { borderColor: tokens.surface, borderWidth: 2 },
            data: result.items.map((item) => ({ name: item.name, value: item.value })),
          },
        ],
      } as echarts.EChartsCoreOption;
    }

    // Horizontal bars: the label is the identity, so one colour is enough.
    const sorted = [...result.items].sort((a, b) => a.value - b.value);
    return {
      ...base,
      color: colors,
      legend: { show: false },
      grid: { left: 8, right: 44, top: 6, bottom: 6, containLabel: true },
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
        axisLabel: { color: tokens.inkSecondary, fontSize: 11, width: 130, overflow: "truncate" },
      },
      series: [
        {
          type: "bar",
          barMaxWidth: 14,
          itemStyle: { color: colors[0], borderRadius: [0, 4, 4, 0] },
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

  if (result.items.length === 0) {
    return <EmptyState title="No data in this range" description="Nothing matched this widget's scope." />;
  }
  return <Chart option={option} height={height} className="px-1" />;
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
      grid: { left: 8, right: 16, top: 8, bottom: 42, containLabel: true },
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
          formatter: (value: string) => `${value.padStart(2, "0")}`,
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
        itemHeight: 70,
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

  if (result.cells.length === 0) return <EmptyState title="No data in this range" />;
  return <Chart option={option} height={height} />;
}

function HostGridWidget({ result }: { result: Extract<QueryResult, { kind: "hosts" }> }) {
  if (result.hosts.length === 0) {
    return (
      <EmptyState title="No session hosts yet" description="They appear after the first inventory sync." />
    );
  }
  const tone = (status: string, drain: boolean) => {
    const s = status.toLowerCase();
    if (s === "available") return drain ? "warning" : "good";
    if (s === "shutdown" || s.includes("vmnotrunning")) return "neutral";
    return "critical";
  };

  return (
    <div className="max-h-full space-y-1.5 overflow-auto px-3 pb-3">
      {result.hosts.slice(0, 120).map((host) => {
        const badgeTone = tone(host.status, !host.allowNewSession);
        return (
          <div
            key={`${host.hostPool}/${host.name}`}
            className="flex items-center justify-between gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1.5"
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
              <Badge tone={badgeTone as "good" | "warning" | "critical" | "neutral"}>{host.status}</Badge>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Any chart can be read as a table. Three light-mode series colours sit below 3:1 contrast
 * on the light surface, and the palette's relief rule requires visible labels or a table
 * view in that case — so every widget carries one.
 */
function ResultTable({ result, height }: { result: QueryResult; height: number }) {
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
      unit = "count";
      break;
  }

  return (
    <div className="overflow-auto" style={{ maxHeight: height }}>
      <Table
        dense
        columns={[
          { key: "name", label: "Series" },
          { key: "value", label: "Value", numeric: true },
        ]}
        rows={rows.slice(0, 500).map((row) => ({ name: row.name, value: fmt(unit, row.value, currency) }))}
      />
    </div>
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
}: {
  widget: WidgetSpec;
  result?: QueryResult;
  error?: string;
  loading?: boolean;
  betterWhen: "lower" | "higher" | "neutral";
  height: number;
  asTable?: boolean;
}) {
  if (loading) {
    return (
      <div className="px-4 pb-4">
        <Skeleton className="w-full" style={{ height: height - 8 }} />
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
  if (!result) return <EmptyState title="No result" />;
  if (asTable) return <ResultTable result={result} height={height} />;

  switch (result.kind) {
    case "scalar":
      return <KpiTile result={result} betterWhen={betterWhen} />;
    case "series":
      return <SeriesWidget widget={widget} result={result} height={height} />;
    case "breakdown":
      return <BreakdownWidget widget={widget} result={result} height={height} />;
    case "heatmap":
      return <HeatmapWidget result={result} height={height} />;
    case "hosts":
      return <HostGridWidget result={result} />;
    case "table":
      return (
        <div className="max-h-full overflow-auto" style={{ maxHeight: height }}>
          <Table
            dense
            columns={result.columns.map((column) => ({ ...column, label: column.label }))}
            rows={result.rows.map((row) => ({
              name: String(row.name ?? "—"),
              value: fmt(result.unit, typeof row.value === "number" ? row.value : null, result.currency),
            }))}
          />
        </div>
      );
  }
}

/** A widget card: header, body, and the size it occupies on the 12-column grid. */
export function WidgetCard({
  widget,
  result,
  error,
  loading,
  betterWhen,
  actions,
}: {
  widget: WidgetSpec;
  result?: QueryResult;
  error?: string;
  loading?: boolean;
  betterWhen: "lower" | "higher" | "neutral";
  actions?: React.ReactNode;
}) {
  const spec = SIZE_SPEC[widget.size];
  const [asTable, setAsTable] = useState(false);
  const canTable = widget.viz !== "kpi" && widget.viz !== "table";

  return (
    <Card className="avd-fade-in flex flex-col overflow-hidden" style={{ gridColumn: `span ${spec.span}` }}>
      <CardHeader
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
      <div className="flex-1">
        <WidgetBody
          widget={widget}
          result={result}
          error={error}
          loading={loading}
          betterWhen={betterWhen}
          height={spec.height}
          asTable={asTable}
        />
      </div>
    </Card>
  );
}

export { StatusDot };

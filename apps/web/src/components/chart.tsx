import { BarChart, HeatmapChart, LineChart, PieChart } from "echarts/charts";
import { GridComponent, LegendComponent, TooltipComponent, VisualMapComponent } from "echarts/components";
import * as echarts from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { useEffect, useMemo, useRef } from "react";
import { useTheme } from "../lib/theme";
import { cssVar } from "../lib/utils";

echarts.use([
  BarChart,
  LineChart,
  PieChart,
  HeatmapChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  VisualMapComponent,
  CanvasRenderer,
]);

export interface ChartTokens {
  ink: string;
  inkSecondary: string;
  inkMuted: string;
  grid: string;
  surface: string;
  border: string;
}

/**
 * Charts read their colours from the CSS tokens, so they follow the theme. The hook
 * re-reads them when the resolved theme changes, which makes the chart options depend on
 * the theme through real data rather than a magic dependency.
 */
export function useChartTokens(): ChartTokens {
  const { version } = useTheme();
  // readTokens() reads live CSS custom properties, so the theme version is its only signal.
  // biome-ignore lint/correctness/useExhaustiveDependencies: version is the invalidation signal
  return useMemo(() => readTokens(), [version]);
}

export function readTokens(): ChartTokens {
  return {
    ink: cssVar("--text-primary", "#111"),
    inkSecondary: cssVar("--text-secondary", "#555"),
    inkMuted: cssVar("--text-muted", "#888"),
    grid: cssVar("--grid", "#eee"),
    surface: cssVar("--surface-1", "#fff"),
    border: cssVar("--border", "#ddd"),
  };
}

/**
 * Shared chart chrome: recessive grid and axes, text in ink tokens rather than series
 * colours, and a crosshair tooltip. Individual charts add only their series.
 */
export interface BaseOption {
  animationDuration: number;
  grid: Record<string, unknown>;
  textStyle: Record<string, unknown>;
  tooltip: Record<string, unknown>;
  legend: Record<string, unknown>;
}

export function baseOption(tokens: ChartTokens): BaseOption {
  return {
    animationDuration: 260,
    grid: { left: 8, right: 12, top: 8, bottom: 4, containLabel: true },
    textStyle: { fontFamily: "ui-sans-serif, system-ui, sans-serif", color: tokens.inkSecondary },
    tooltip: {
      backgroundColor: tokens.surface,
      borderColor: tokens.border,
      borderWidth: 1,
      padding: [8, 10],
      textStyle: { color: tokens.ink, fontSize: 12 },
      extraCssText: "box-shadow: 0 6px 24px rgba(0,0,0,0.12); border-radius: 8px;",
      axisPointer: { type: "line", lineStyle: { color: tokens.border, width: 1 } },
    },
    legend: {
      type: "scroll",
      bottom: 0,
      itemWidth: 10,
      itemHeight: 10,
      itemGap: 14,
      icon: "roundRect",
      textStyle: { color: tokens.inkSecondary, fontSize: 11 },
      inactiveColor: tokens.inkMuted,
    },
  };
}

export function Chart({
  option,
  height,
  className,
  onEvents,
}: {
  option: echarts.EChartsCoreOption;
  height: number;
  className?: string;
  onEvents?: Record<string, (params: unknown) => void>;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const instance = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    instance.current = echarts.init(ref.current, undefined, { renderer: "canvas" });
    const observer = new ResizeObserver(() => instance.current?.resize());
    observer.observe(ref.current);
    return () => {
      observer.disconnect();
      instance.current?.dispose();
      instance.current = null;
    };
  }, []);

  useEffect(() => {
    instance.current?.setOption(option, { notMerge: true });
  }, [option]);

  useEffect(() => {
    const chart = instance.current;
    if (!chart || !onEvents) return;
    for (const [event, handler] of Object.entries(onEvents)) chart.on(event, handler);
    return () => {
      for (const event of Object.keys(onEvents)) chart.off(event);
    };
  }, [onEvents]);

  return <div ref={ref} className={className} style={{ height, width: "100%" }} />;
}

import { z } from "zod";
import { dimensionSchema, getMetric, vizSchema } from "./metrics";
import { timeGrainSchema, timePresetSchema } from "./time";

export const widgetSizeSchema = z.enum(["sm", "md", "lg", "xl"]);
export type WidgetSize = z.infer<typeof widgetSizeSchema>;

/** Column span on a 12-column grid, and a pixel height for the body. */
export const SIZE_SPEC: Record<WidgetSize, { span: number; height: number }> = {
  sm: { span: 3, height: 120 },
  md: { span: 6, height: 260 },
  lg: { span: 6, height: 360 },
  xl: { span: 12, height: 380 },
};

export const widgetFiltersSchema = z.object({
  hostPools: z.array(z.string()).optional(),
  /** Dimension value allow-list, e.g. { clientOs: ["Windows"] }. Values are always parameterized. */
  dims: z.partialRecord(dimensionSchema, z.array(z.string().max(200))).optional(),
});
export type WidgetFilters = z.infer<typeof widgetFiltersSchema>;

export const widgetSchema = z
  .object({
    id: z.string().min(1).max(64),
    title: z.string().min(1).max(120),
    subtitle: z.string().max(200).optional(),
    viz: vizSchema,
    metric: z.string().min(1).max(64),
    groupBy: dimensionSchema.optional(),
    topN: z.number().int().min(1).max(50).default(8),
    grain: z.union([z.literal("auto"), timeGrainSchema]).default("auto"),
    filters: widgetFiltersSchema.default({}),
    /** KPI only: also fetch the previous period for a delta. */
    compare: z.boolean().default(true),
    size: widgetSizeSchema.default("md"),
  })
  .refine((w) => getMetric(w.metric) !== undefined, { message: "Unknown metric" })
  .refine((w) => getMetric(w.metric)?.viz.includes(w.viz) ?? false, {
    message: "This metric does not support that visualization",
  })
  .refine((w) => !w.groupBy || getMetric(w.metric)?.dims[w.groupBy] !== undefined, {
    message: "This metric cannot be grouped by that dimension",
  });
export type WidgetSpec = z.infer<typeof widgetSchema>;

export const dashboardGoals = [
  "executive",
  "experience",
  "reliability",
  "capacity",
  "cost",
  "customer-report",
  "blank",
] as const;
export const dashboardGoalSchema = z.enum(dashboardGoals);
export type DashboardGoal = z.infer<typeof dashboardGoalSchema>;

export const dashboardSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(400).default(""),
  goal: dashboardGoalSchema.default("blank"),
  widgets: z.array(widgetSchema).max(40),
  defaultPreset: timePresetSchema.default("7d"),
  /** null = every customer the viewer may see. */
  tenantScope: z.array(z.string().uuid()).nullable().default(null),
  visibility: z.enum(["private", "shared"]).default("private"),
  /** Minimum role that can open a shared dashboard. */
  sharedWithRole: z.enum(["viewer", "analyst", "admin"]).default("viewer"),
});
export type DashboardSpec = z.infer<typeof dashboardSchema>;

// ─── query contract ─────────────────────────────────────────────────────────────

export const queryRequestSchema = z.object({
  metric: z.string().min(1).max(64),
  viz: vizSchema,
  groupBy: dimensionSchema.optional(),
  topN: z.number().int().min(1).max(50).default(8),
  grain: timeGrainSchema.default("hour"),
  from: z.coerce.date(),
  to: z.coerce.date(),
  tenantIds: z.array(z.string().uuid()).nullable().default(null),
  filters: widgetFiltersSchema.default({}),
  compare: z.boolean().default(false),
});
export type QueryRequest = z.infer<typeof queryRequestSchema>;

export interface SeriesPoint {
  ts: string;
  value: number | null;
}
export interface Series {
  name: string;
  points: SeriesPoint[];
}

export type QueryResult =
  | {
      kind: "scalar";
      unit: string;
      value: number | null;
      previous?: number | null;
      spark?: SeriesPoint[];
      currency?: string;
    }
  | { kind: "series"; unit: string; grain: string; series: Series[]; currency?: string }
  | { kind: "breakdown"; unit: string; items: { name: string; value: number }[]; currency?: string }
  | {
      kind: "table";
      unit: string;
      columns: { key: string; label: string; numeric?: boolean }[];
      rows: Record<string, string | number | null>[];
      currency?: string;
    }
  | {
      kind: "heatmap";
      unit: string;
      /** value per [dayOfWeek 0-6 (Mon first), hourOfDay 0-23] */
      cells: { day: number; hour: number; value: number }[];
      currency?: string;
    }
  | {
      kind: "hosts";
      hosts: {
        name: string;
        hostPool: string;
        tenant: string;
        status: string;
        sessions: number;
        allowNewSession: boolean;
        agentVersion: string | null;
        lastHeartBeat: string | null;
      }[];
    };

export function vizResultKind(viz: WidgetSpec["viz"]): QueryResult["kind"] {
  switch (viz) {
    case "kpi":
      return "scalar";
    case "line":
    case "area":
    case "stacked-bar":
      return "series";
    case "bar":
    case "donut":
      return "breakdown";
    case "table":
      return "table";
    case "heatmap":
      return "heatmap";
    case "host-grid":
      return "hosts";
  }
}

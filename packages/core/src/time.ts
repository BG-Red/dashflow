import { z } from "zod";

export const TIME_PRESETS = {
  "24h": { label: "Last 24 hours", hours: 24, grain: "hour" },
  "7d": { label: "Last 7 days", hours: 24 * 7, grain: "hour" },
  "30d": { label: "Last 30 days", hours: 24 * 30, grain: "day" },
  "90d": { label: "Last 90 days", hours: 24 * 90, grain: "day" },
} as const;
export type TimePreset = keyof typeof TIME_PRESETS;
export const timePresetSchema = z.enum(Object.keys(TIME_PRESETS) as [TimePreset, ...TimePreset[]]);

export const timeGrainSchema = z.enum(["hour", "day"]);
export type TimeGrain = z.infer<typeof timeGrainSchema>;

export function resolveRange(
  preset: TimePreset,
  now = new Date(),
): { from: Date; to: Date; grain: TimeGrain } {
  const p = TIME_PRESETS[preset];
  return { from: new Date(now.getTime() - p.hours * 3600_000), to: now, grain: p.grain };
}

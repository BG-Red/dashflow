import { cssVar, SERIES_VARS } from "./utils";

/**
 * Colour follows the entity, not its rank.
 *
 * If colours were handed out by array position, filtering one host pool out of a chart would
 * repaint every survivor and quietly change what the reader thinks they are looking at. So a
 * name claims a slot the first time it is seen and keeps it for the session — the same pool is
 * the same colour on every chart, on every dashboard.
 *
 * Slots are assigned in the palette's fixed order and never generated: a ninth series reuses
 * the ramp rather than inventing a hue outside the validated set.
 */
const slots = new Map<string, number>();

export function colorSlot(name: string): number {
  const existing = slots.get(name);
  if (existing !== undefined) return existing;
  const slot = slots.size % SERIES_VARS.length;
  slots.set(name, slot);
  return slot;
}

export function seriesColor(name: string): string {
  const variable = SERIES_VARS[colorSlot(name)] ?? SERIES_VARS[0]!;
  return cssVar(variable, "#3987e5");
}

/** Colours for a set of names, stable regardless of the order they arrive in. */
export function seriesColors(names: string[]): string[] {
  return names.map(seriesColor);
}

/** A single series ("total") always takes the first slot — it is the subject of the chart. */
export const PRIMARY_SERIES = "total";

export function resetSeriesColors(): void {
  slots.clear();
}

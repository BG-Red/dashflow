import { describe, expect, test } from "bun:test";
import { DIMENSIONS, formatUnit, getMetric, METRICS, VIZ_KINDS } from "./metrics";
import { type Access, scopeTenants } from "./rbac";
import { DASHBOARD_TEMPLATES } from "./templates";
import { resolveRange } from "./time";
import { dashboardSchema, widgetSchema } from "./widgets";

describe("metric catalog", () => {
  test("every metric has a unique id and at least one visualization", () => {
    const ids = new Set<string>();
    for (const metric of METRICS) {
      expect(ids.has(metric.id)).toBe(false);
      ids.add(metric.id);
      expect(metric.viz.length).toBeGreaterThan(0);
      for (const viz of metric.viz) expect(VIZ_KINDS).toContain(viz);
    }
  });

  test("dimension keys are all declared", () => {
    for (const metric of METRICS) {
      for (const dim of Object.keys(metric.dims)) expect(Object.keys(DIMENSIONS)).toContain(dim);
    }
  });

  test("ratio metrics point at metrics that exist", () => {
    for (const metric of METRICS) {
      if (!metric.ratioOf) continue;
      expect(getMetric(metric.ratioOf.numerator)).toBeDefined();
      expect(getMetric(metric.ratioOf.denominator)).toBeDefined();
    }
  });

  test("two-stage metrics declare both an inner key and an outer aggregate", () => {
    for (const metric of METRICS) {
      expect(Boolean(metric.innerKey)).toBe(Boolean(metric.stage2));
    }
  });

  test("SQL fragments never interpolate anything", () => {
    // The compiler puts these straight into SQL, so they must be static text.
    for (const metric of METRICS) {
      const fragments = [
        metric.agg,
        metric.where ?? "",
        metric.innerKey ?? "",
        ...Object.values(metric.dims),
      ];
      for (const fragment of fragments) {
        expect(fragment).not.toContain("${");
        expect(fragment).not.toContain(";");
      }
    }
  });
});

describe("dashboard templates", () => {
  test("every template widget passes widget validation", () => {
    for (const template of DASHBOARD_TEMPLATES) {
      for (const widget of template.widgets) {
        const result = widgetSchema.safeParse(widget);
        if (!result.success) {
          throw new Error(
            `${template.goal}/${widget.id}: ${result.error.issues.map((i) => i.message).join(", ")}`,
          );
        }
      }
    }
  });

  test("a template can be saved as a dashboard", () => {
    const template = DASHBOARD_TEMPLATES[0]!;
    const parsed = dashboardSchema.parse({
      name: template.name,
      goal: template.goal,
      widgets: template.widgets,
    });
    expect(parsed.widgets.length).toBe(template.widgets.length);
    expect(parsed.tenantScope).toBeNull();
  });

  test("goals are unique", () => {
    const goals = DASHBOARD_TEMPLATES.map((template) => template.goal);
    expect(new Set(goals).size).toBe(goals.length);
  });
});

describe("widget validation", () => {
  const base = { id: "w1", title: "Test", metric: "sessions.active", viz: "kpi" as const };

  test("rejects an unknown metric", () => {
    expect(widgetSchema.safeParse({ ...base, metric: "not.a.metric" }).success).toBe(false);
  });

  test("rejects a visualization the metric does not support", () => {
    expect(widgetSchema.safeParse({ ...base, viz: "host-grid" }).success).toBe(false);
  });

  test("rejects a dimension the metric cannot group by", () => {
    expect(widgetSchema.safeParse({ ...base, viz: "bar", groupBy: "errorCode" }).success).toBe(false);
    expect(widgetSchema.safeParse({ ...base, viz: "bar", groupBy: "hostPool" }).success).toBe(true);
  });
});

describe("tenant scoping", () => {
  const unrestricted: Access = { role: "admin", tenantScope: null };
  const restricted: Access = { role: "viewer", tenantScope: ["a", "b"] };

  test("an unrestricted user gets exactly what they asked for", () => {
    expect(scopeTenants(unrestricted, null)).toBeNull();
    expect(scopeTenants(unrestricted, ["x"])).toEqual(["x"]);
  });

  test("a restricted user is limited to their own tenants", () => {
    expect(scopeTenants(restricted, null)).toEqual(["a", "b"]);
    expect(scopeTenants(restricted, ["a"])).toEqual(["a"]);
  });

  test("a restricted user cannot reach another tenant", () => {
    expect(scopeTenants(restricted, ["c"])).toEqual([]);
    expect(scopeTenants(restricted, ["a", "c"])).toEqual(["a"]);
  });
});

describe("formatting and ranges", () => {
  test("units read the way an operator expects", () => {
    expect(formatUnit("ms", 450)).toBe("450 ms");
    expect(formatUnit("ms", 2500)).toBe("2.5 s");
    expect(formatUnit("percent", 97.85)).toBe("98%");
    expect(formatUnit("seconds", 5400)).toBe("1.5 h");
    expect(formatUnit("count", Number.NaN)).toBe("—");
  });

  test("presets resolve to a range and a sensible grain", () => {
    const now = new Date("2026-09-17T12:00:00Z");
    expect(resolveRange("24h", now).grain).toBe("hour");
    expect(resolveRange("30d", now).grain).toBe("day");
    expect(resolveRange("7d", now).from.toISOString()).toBe("2026-09-10T12:00:00.000Z");
  });
});

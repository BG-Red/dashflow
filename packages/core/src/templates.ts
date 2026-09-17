import type { DashboardGoal, WidgetSpec } from "./widgets";

export interface DashboardTemplate {
  goal: DashboardGoal;
  name: string;
  headline: string;
  description: string;
  /** Questions this dashboard answers — shown in the guided builder. */
  answers: string[];
  requires?: "nerdio";
  widgets: WidgetSpec[];
}

type W = Partial<WidgetSpec> & Pick<WidgetSpec, "id" | "title" | "viz" | "metric">;

const w = (spec: W): WidgetSpec => ({
  topN: 8,
  grain: "auto",
  filters: {},
  compare: true,
  size: "md",
  ...spec,
});

export const DASHBOARD_TEMPLATES: DashboardTemplate[] = [
  {
    goal: "executive",
    name: "Executive overview",
    headline: "The one screen to open every morning",
    description: "Usage, reliability and cost at a glance, with trends against the previous period.",
    answers: [
      "How many people are using AVD, and is that growing?",
      "Are connections succeeding?",
      "What is the environment costing?",
    ],
    widgets: [
      w({ id: "kpi-users", title: "Unique users", viz: "kpi", metric: "users.unique", size: "sm" }),
      w({ id: "kpi-peak", title: "Peak sessions", viz: "kpi", metric: "sessions.peak", size: "sm" }),
      w({
        id: "kpi-success",
        title: "Connection success",
        viz: "kpi",
        metric: "connections.success_rate",
        size: "sm",
      }),
      w({ id: "kpi-cost", title: "Cost", viz: "kpi", metric: "cost.total", size: "sm" }),
      w({
        id: "sessions-trend",
        title: "Active sessions over time",
        subtitle: "Average concurrency per bucket",
        viz: "area",
        metric: "sessions.active",
        size: "lg",
      }),
      w({
        id: "connections-by-pool",
        title: "Connections by host pool",
        viz: "bar",
        metric: "connections.count",
        groupBy: "hostPool",
        size: "lg",
      }),
      w({
        id: "heat",
        title: "When people work",
        subtitle: "Average concurrency by day and hour",
        viz: "heatmap",
        metric: "sessions.active",
        size: "xl",
      }),
    ],
  },
  {
    goal: "experience",
    name: "User experience",
    headline: "How fast sessions feel",
    description: "Connection times and round trip latency, sliced by pool, client and gateway region.",
    answers: [
      "Is logging in slow, and for whom?",
      "Which gateway regions have the worst latency?",
      "Do certain clients perform badly?",
    ],
    widgets: [
      w({ id: "kpi-connect", title: "Time to connect (p95)", viz: "kpi", metric: "connect.p95", size: "sm" }),
      w({
        id: "kpi-connect-med",
        title: "Time to connect (median)",
        viz: "kpi",
        metric: "connect.median",
        size: "sm",
      }),
      w({ id: "kpi-rtt", title: "RTT (median)", viz: "kpi", metric: "rtt.median", size: "sm" }),
      w({ id: "kpi-rtt-p95", title: "RTT (p95)", viz: "kpi", metric: "rtt.p95", size: "sm" }),
      w({
        id: "connect-trend",
        title: "Time to connect trend",
        viz: "line",
        metric: "connect.p95",
        size: "lg",
      }),
      w({
        id: "rtt-by-gateway",
        title: "RTT by gateway region",
        viz: "bar",
        metric: "rtt.median",
        groupBy: "gatewayRegion",
        size: "lg",
      }),
      w({
        id: "connect-by-client",
        title: "Time to connect by client OS",
        viz: "table",
        metric: "connect.p95",
        groupBy: "clientOs",
        size: "md",
      }),
      w({
        id: "worst-hosts",
        title: "Slowest session hosts",
        viz: "table",
        metric: "connect.p95",
        groupBy: "sessionHost",
        topN: 10,
        size: "md",
      }),
    ],
  },
  {
    goal: "reliability",
    name: "Reliability",
    headline: "What is breaking, and where",
    description: "Failed connections, error codes and session host health over time.",
    answers: [
      "Which errors are most common?",
      "Are failures concentrated in one host pool or host?",
      "Are hosts unhealthy or stuck in drain mode?",
    ],
    widgets: [
      w({
        id: "kpi-failed",
        title: "Failed connections",
        viz: "kpi",
        metric: "connections.failed",
        size: "sm",
      }),
      w({
        id: "kpi-rate",
        title: "Success rate",
        viz: "kpi",
        metric: "connections.success_rate",
        size: "sm",
      }),
      w({ id: "kpi-errors", title: "Errors", viz: "kpi", metric: "errors.count", size: "sm" }),
      w({ id: "kpi-unhealthy", title: "Unhealthy hosts", viz: "kpi", metric: "hosts.unhealthy", size: "sm" }),
      w({
        id: "errors-trend",
        title: "Errors over time by source",
        viz: "stacked-bar",
        metric: "errors.count",
        groupBy: "errorSource",
        size: "lg",
      }),
      w({
        id: "errors-top",
        title: "Top error codes",
        viz: "table",
        metric: "errors.count",
        groupBy: "errorCode",
        topN: 12,
        size: "lg",
      }),
      w({
        id: "failed-by-pool",
        title: "Failed connections by host pool",
        viz: "bar",
        metric: "connections.failed",
        groupBy: "hostPool",
        size: "md",
      }),
      w({
        id: "host-grid",
        title: "Session host health",
        viz: "host-grid",
        metric: "hosts.unhealthy",
        size: "md",
      }),
    ],
  },
  {
    goal: "capacity",
    name: "Capacity and scaling",
    headline: "Headroom and right-sizing",
    description: "Utilization against capacity, sessions per host and host performance.",
    answers: [
      "Do we have too much or too little capacity?",
      "When do we hit peak load?",
      "Are hosts CPU or memory bound?",
    ],
    widgets: [
      w({
        id: "kpi-util",
        title: "Capacity utilization",
        viz: "kpi",
        metric: "capacity.utilization",
        size: "sm",
      }),
      w({
        id: "kpi-perhost",
        title: "Sessions per host",
        viz: "kpi",
        metric: "sessions.per_host",
        size: "sm",
      }),
      w({ id: "kpi-avail", title: "Available hosts", viz: "kpi", metric: "hosts.available", size: "sm" }),
      w({ id: "kpi-cpu", title: "CPU average", viz: "kpi", metric: "cpu.avg", size: "sm" }),
      w({
        id: "util-trend",
        title: "Utilization over time",
        viz: "area",
        metric: "capacity.utilization",
        size: "lg",
      }),
      w({
        id: "util-heat",
        title: "Utilization by day and hour",
        viz: "heatmap",
        metric: "capacity.utilization",
        size: "lg",
      }),
      w({
        id: "sessions-by-pool",
        title: "Concurrency by host pool",
        viz: "stacked-bar",
        metric: "sessions.active",
        groupBy: "hostPool",
        size: "lg",
      }),
      w({
        id: "disconnected",
        title: "Disconnected sessions",
        subtitle: "Sessions holding capacity without a user",
        viz: "line",
        metric: "sessions.disconnected",
        size: "md",
      }),
    ],
  },
  {
    goal: "cost",
    name: "Cost and savings",
    headline: "Where the money goes",
    description: "Spend by customer, pool and meter, plus cost per user and autoscale savings.",
    answers: [
      "What does each customer or pool cost?",
      "What is our cost per user?",
      "Is autoscale paying off?",
    ],
    widgets: [
      w({ id: "kpi-cost", title: "Cost", viz: "kpi", metric: "cost.total", size: "sm" }),
      w({ id: "kpi-per-user", title: "Cost per user", viz: "kpi", metric: "cost.per_user", size: "sm" }),
      w({ id: "kpi-savings", title: "Autoscale savings", viz: "kpi", metric: "cost.savings", size: "sm" }),
      w({ id: "kpi-users", title: "Unique users", viz: "kpi", metric: "users.unique", size: "sm" }),
      w({
        id: "cost-trend",
        title: "Daily cost",
        viz: "area",
        metric: "cost.total",
        grain: "day",
        size: "lg",
      }),
      w({
        id: "cost-by-meter",
        title: "Cost by meter category",
        viz: "donut",
        metric: "cost.total",
        groupBy: "meterCategory",
        size: "lg",
      }),
      w({
        id: "cost-by-pool",
        title: "Cost by host pool",
        viz: "table",
        metric: "cost.total",
        groupBy: "hostPool",
        topN: 12,
        size: "md",
      }),
      w({
        id: "autoscale",
        title: "Autoscale actions",
        viz: "bar",
        metric: "autoscale.actions",
        groupBy: "errorSource",
        size: "md",
      }),
    ],
  },
  {
    goal: "customer-report",
    name: "Customer report",
    headline: "One page you can hand to a customer",
    description: "Per-customer usage, experience and spend — pick a single customer in the scope step.",
    answers: [
      "What did this customer use this month?",
      "Did they have a good experience?",
      "What did their environment cost?",
    ],
    widgets: [
      w({ id: "kpi-users", title: "Unique users", viz: "kpi", metric: "users.unique", size: "sm" }),
      w({ id: "kpi-sessions", title: "Connections", viz: "kpi", metric: "connections.count", size: "sm" }),
      w({
        id: "kpi-success",
        title: "Success rate",
        viz: "kpi",
        metric: "connections.success_rate",
        size: "sm",
      }),
      w({ id: "kpi-cost", title: "Cost", viz: "kpi", metric: "cost.total", size: "sm" }),
      w({
        id: "usage",
        title: "Daily connections",
        viz: "bar",
        metric: "connections.count",
        groupBy: "hostPool",
        size: "lg",
      }),
      w({ id: "experience", title: "Time to connect (p95)", viz: "line", metric: "connect.p95", size: "lg" }),
      w({
        id: "pools",
        title: "Host pools",
        viz: "table",
        metric: "sessions.peak",
        groupBy: "hostPool",
        topN: 20,
        size: "xl",
      }),
    ],
  },
  {
    goal: "blank",
    name: "Start from scratch",
    headline: "Build it yourself",
    description: "An empty canvas. Add widgets from the metric catalog.",
    answers: [],
    widgets: [],
  },
];

export function templateFor(goal: DashboardGoal): DashboardTemplate | undefined {
  return DASHBOARD_TEMPLATES.find((t) => t.goal === goal);
}

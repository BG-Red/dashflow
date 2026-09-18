# Roadmap

What is done, what is next, and what is deliberately out of scope. Dates are intentions, not
commitments — this is a volunteer project.

## Shipped

- Four connection types: Azure direct, Azure Lighthouse, Partner Center (GDAP), Nerdio Manager
- Sync engine with per-stream schedules, incremental log windows and retention
- Metric catalog with 25 metrics, six dashboard templates and a guided builder
- Drag-and-resize dashboards, click-to-drill, per-widget filters, favourites, duplication
- Explore, host pool and session host pages, error catalogue, busiest users
- App roles including viewers scoped to a single customer
- Hosted demo with an evaluator proved against the SQL engine in CI

## Next

**Alerting.** Threshold rules per metric ("time to connect p95 above 15s for 30 minutes"),
evaluated by the worker, delivered to a webhook or Teams, with an in-app inbox. The evaluator
and schedule already exist; this is a table, a rule evaluator and a delivery step.

**Scheduled customer reports.** A dashboard, rendered on a schedule and emailed as a PDF or a
link. Needs a rendering step and SMTP or Graph mail settings.

**Nerdio autoscale history.** Autoscale actions are currently derived from host state
transitions, which works everywhere. If Nerdio exposes a dependable action history, read it
directly and keep the derivation as a fallback.

## Being considered

- Read-only public share links for a single dashboard, with an expiry
- More cost attribution: tags and per-host-pool allocation rather than resource group matching
- FSLogix profile metrics, once there is a dependable source for them
- A Grafana datasource, so DashFlow's metric catalog can be queried from an existing stack
- Per-instance branding on customer-facing dashboards

## Not planned

- Writing anything back to Azure or Nerdio. DashFlow is read-only by design, and that is what
  makes the permission story simple enough to hand to a customer.
- A hosted SaaS version. Run it yourself; that is the point.
- Non-AVD workloads. A general infrastructure dashboard is a different product.

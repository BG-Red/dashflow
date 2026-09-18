# Changelog

All notable changes to DashFlow are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-09-17

The first release: everything needed to run AVD dashboards for one tenant or thirty.

### Added

- **Connections** — Azure direct (service principal or managed identity), Azure Lighthouse,
  Partner Center with GDAP via the Secure Application Model, and Nerdio Manager for MSP or
  Enterprise. Each has a guided wizard that generates its prerequisites and proves access with
  a permission checklist before anything syncs.
- **Sync engine** — Postgres job queue, per-stream schedules, incremental log windows with
  overlap, retention, and live progress over server-sent events.
- **Dashboards** — six templates behind a guided builder, a 25-metric catalog, drag-and-resize
  widgets, click-to-drill into the underlying records, per-dimension filters, favourites,
  duplication, auto-refresh and CSV export.
- **Explore** — ad-hoc metric, split, filter and visualization, shareable by URL and saveable
  onto a dashboard.
- **Pages** — host pool and session host detail with health timelines, an error catalogue, the
  busiest users, customers, sync health, users and roles, and settings.
- **Access** — Entra sign-in through Container Apps authentication, plus app roles including
  viewers scoped to a single customer, enforced in the query compiler.
- **Deployment** — container image, Docker Compose for local use, and Bicep for Container Apps
  with Key Vault and an Entra-authenticated Postgres.
- **Hosted demo** — the full UI over a synthetic estate, with a JavaScript evaluator held to the
  SQL engine's results by a parity test in CI.

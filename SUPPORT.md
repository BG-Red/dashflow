# Getting help

**Try the [live demo](https://bg-red.github.io/dashflow/)** if you want to see what DashFlow
does before installing anything.

## Something is not working

1. **Check the connection diagnostics.** Connections → your connection → Details → Test. Most
   problems are a missing role assignment, and the checklist names the exact one.
2. **Check sync health.** Failed runs carry the error the API returned.
3. **Read the troubleshooting section** in [docs/connections.md](docs/connections.md) — it covers
   the common cases: no subscriptions visible, empty experience widgets, missing cost, Nerdio
   paths that differ by version.

## Still stuck

Open an [issue](https://github.com/BG-Red/dashflow/issues/new/choose) with:

- What you expected and what happened
- Connection type, deployment (Container Apps, Docker, other) and image tag
- The relevant log lines or diagnostic results

**Please redact tenant IDs, subscription IDs, domains and user names.** Placeholders are fine —
the app's own examples use `00000000-0000-0000-0000-000000000000` and `contoso.onmicrosoft.com`.

## Security issues

Do not open a public issue. See [SECURITY.md](SECURITY.md).

## Feature ideas

Check [ROADMAP.md](ROADMAP.md) first, then open a feature request. Ideas that come with the
operational reason behind them ("I need this because on Monday mornings…") get built first.

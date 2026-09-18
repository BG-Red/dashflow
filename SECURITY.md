# Security policy

## Reporting a vulnerability

Please report security issues privately using GitHub's
[private vulnerability reporting](https://github.com/BG-Red/dashflow/security/advisories/new)
rather than a public issue.

Include what you found, how to reproduce it, and the version or commit. Please do not include
real tenant identifiers or customer data in the report — a placeholder reproduction is enough.

This is a volunteer-maintained open source project, so there is no formal SLA, but reports are
taken seriously and acknowledged as quickly as possible.

## Supported versions

The latest tagged release and `main`.

## Scope

In scope: authentication and authorization bypasses, tenant-scope escapes (one customer's data
visible to a viewer scoped to another), SQL injection through dashboard or query inputs, secret
disclosure through the API or logs, and anything in the deployment template that weakens the
trust boundary described in [docs/security.md](docs/security.md).

Out of scope: running the app with `AUTH_MODE=dev` exposed to a network (it warns loudly and
refuses in production), and findings that require an existing owner or admin role.

## What this changes

<!-- One or two sentences. The why matters more than the what. -->

## How it was verified

<!-- Which of these did you run? Anything you could not check, say so plainly. -->

- [ ] `bun test` (with `TEST_DATABASE_URL` for the SQL and parity suites)
- [ ] `bunx playwright test`
- [ ] `bun run lint && bun run typecheck`
- [ ] Clicked through the change in the running app

## Checklist

- [ ] No tenant IDs, subscription IDs, real domains or user names anywhere in the diff
- [ ] New metrics are in the catalog, not ad-hoc SQL
- [ ] Docs updated if behaviour or configuration changed

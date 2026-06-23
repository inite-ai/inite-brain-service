<!--
Thanks for contributing to INITE Brain! Keep the description focused on the
*why* — the diff already shows the *what*. See CONTRIBUTING.md for the bars.
-->

## What & why

<!-- What does this change, and what problem does it solve? Link any issue: Closes #123 -->

## How

<!-- Notable implementation choices, trade-offs, or anything a reviewer should look at first. -->

## Checklist

- [ ] `pnpm test` passes
- [ ] Retrieval / ingest touched → `pnpm test:eval` stays within tolerance (the eval gate blocks regressions)
- [ ] Schema changes ship as **new numbered migrations** in `src/db/migrations/` (never edit an old one)
- [ ] Docs updated if behavior or the API changed
- [ ] Commit messages explain the *why*

## Screenshots / output

<!-- For UI or eval changes, paste a screenshot or the relevant output. Delete if N/A. -->

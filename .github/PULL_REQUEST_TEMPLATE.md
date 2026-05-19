<!--
Thanks for the PR! A couple of quick checks save reviewer time:

1. Does it touch the public API surface (functions/api/**)? Note any
   breaking changes here.
2. Does it need a D1 migration? Add the SQL to schema/init.sql and
   call it out below — operators on existing instances will need to
   run it.
3. Is the codebase still build-step-free? No new transpilers, bundlers,
   or React/Vue components, please.
-->

## What this changes

<!-- One paragraph. The "why" matters more than the "what" — the diff
shows the what. -->

## How I tested it

<!-- Manual steps, screenshots, or "npm run dev" results. Doesn't have to be
exhaustive — just enough that a reviewer trusts the change works. -->

## Migration notes / breaking changes

<!-- Delete if none. Otherwise: what existing installs need to do. -->

---

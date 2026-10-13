# Upstream dependency

pg-fluent builds on the upstream query builder
[`@supabase/postgrest-js`](https://github.com/supabase/postgrest-js). This file records the exact
pinned version and the reason for every bump.

| Date | Version | Reason |
|---|---|---|
| 2026-10-13 | `2.117.3` | Initial pin for the v1 implementation. |

## Policy

- The dependency is **pinned to an exact version** (no `^`/`~`), because pg-fluent intercepts the
  request the builder emits and translates it to SQL; an unannounced upstream change to URLs,
  headers or the response contract could alter generated SQL or results.
- When bumping:
  1. Update the exact version in `package.json`.
  2. Re-capture the request-contract fixtures from the new upstream for every builder method and
     review the diff (URL, headers, body shape).
  3. Re-run the golden, differential and type fixtures; fix any contract drift.
  4. Add a row to the table above with the date and a short reason (bug fix, new method,
     contract change, security fix).
- A bump that changes observable SQL or results is called out in the changelog as at least a minor
  release.

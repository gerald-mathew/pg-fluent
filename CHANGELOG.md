# Changelog

Notable changes to pg-fluent. Releases before 0.2.0 predate this file.

## 0.3.0 - 2026-11-13

### Changed

- Plain reads (`select`, and streaming reads) now apply the filter directly to the
  source table instead of wrapping it in a `pgfl_filtered` CTE. The CTE is emitted
  only when the request needs it: `count: 'exact'` or a top-level `!inner` embed.
  Generated SQL is simpler and no longer depends on the planner inlining the CTE.
- When the CTE is still required, it is rendered `AS NOT MATERIALIZED` (PostgreSQL
  12+), so an exact count and the page query share one filtered scan instead of
  materializing every matching row. Caveat: a filter containing a volatile function
  (for example `random()`) is evaluated once per reference, so the count and the
  returned page can disagree.
- Deduplicated the per-row SELECT rendering for reads and streaming reads behind
  `renderInnerSql` and `withFilteredCte`.

### Added

- `.toSQL({ shape: 'data' })` returns row-returning SQL without the JSON response
  wrapper. No-argument `.toSQL()` is unchanged.
- Reads now retry serialization failures (`40001`) and deadlocks (`40P01`); writes
  are still never retried.

### Fixed

- `count=planned` now returns the PostgreSQL planner's row estimate; `count=estimated`
  returns an exact count up to `maxRows` and an estimate above it, matching PostgREST.
- Count queries now include `!inner` embed conditions, so counts agree with the
  returned rows.
- Count query failures now fail the request instead of silently omitting the count.
- Hardened `limit`/`offset`/`timeout` parsing to safe integers.

### Tests

- Added unit coverage for inline table reads, no-filter reads, the non-materialized
  exact-count CTE, and inline streaming.
- Added an `EXPLAIN` regression test asserting plain reads do not produce a
  `CTE Scan`.

## 0.2.1 - 2026-11-08

### Fixed

- `select('*')` combined with embeds emitted invalid SQL.
- npm audit findings resolved via the `minimatch` override.

### Changed

- Bumped `@supabase/postgrest-js` to `2.119.0`.
- Refreshed dev dependencies (ESLint 10, typescript-eslint, Vitest 5, tsup 9).

## 0.2.0 - 2026-10-13

### Added

- Embedded-filter guard, differential test suite, ESLint and coverage reporting,
  and trusted publishing from CI.

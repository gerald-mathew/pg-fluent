# Contributing to pg-fluent

Thanks for your interest. This document explains how to set up the project, run the tests, and get
a change merged.

## Prerequisites

- Node.js 22+
- A PostgreSQL 15+ server for integration tests

## Setup

```bash
git clone https://github.com/gerald-mathew/pg-fluent.git
cd pg-fluent
npm install
```

## Running tests

Integration tests need a database. They are skipped automatically when one is not reachable, so
unit tests run anywhere.

```bash
# Provide a test database (any empty database works; the fixture creates its own objects)
export PGFLUENT_TEST_URL=postgres://pgfluent:pgfluent@127.0.0.1:5432/pgfluent_test

npm test          # run the full suite once
npm run test:watch
npm run typecheck # tsc --noEmit
npm run build     # tsup + emit .d.ts
```

## Project layout

```
src/
├─ index.ts        public exports
├─ client.ts       createClient and client wiring
├─ adapter/        fetch adapter: request -> statement -> Response
├─ parser/         select/filter/order/prefer parsers (pure, no I/O)
├─ planner/        request AST + schema cache -> statement plan
├─ sql/            quoteIdent, SQL builder, sql`` tag, identifier()
├─ schema/         schema cache, introspection, refresh
├─ exec/           pools, router, transactions, retry, cancel, stream, copy
├─ listen/         LISTEN/NOTIFY manager
├─ errors/         error classes, SQLSTATE -> status map, redaction
├─ observability/  logger, onQuery, OpenTelemetry
├─ extensions/     toSQL, allowUnfiltered, timeout, stream, primary
└─ cli/            gen-types
test/{unit,golden,security,integration,differential,types}
bench/             reproducible benchmark harness
```

## Guidelines

- **Tests first.** New behavior needs a test; bug fixes need a regression test.
- **Keep the public API stable.** The query builder and documented extras are the compatibility
  contract. Internal modules may change freely.
- **Security.** Never interpolate user-controlled strings into SQL text outside `quoteIdent` or the
  validated cast/aggregate grammar; bind all values as parameters. Add hostile-input coverage for
  anything that reaches SQL.
- **Style.** Match the surrounding code; `npm run typecheck` and `npm run lint` must pass.
- Do not commit secrets or generated `dist/` output.

## Commit and pull requests

- Keep commits focused and write a clear message.
- Open a pull request against `main`; describe the change, the motivation, and how it was tested.
- CI must be green (lint, typecheck, unit/golden/security, integration).

## Reporting bugs and security issues

Open a GitHub issue for bugs and feature requests. For vulnerabilities, **do not** open a public
issue — follow [SECURITY.md](./SECURITY.md) instead.

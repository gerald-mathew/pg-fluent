# pg-fluent

> Supabase-style fluent query builder ([`@supabase/postgrest-js`](https://github.com/supabase/postgrest-js))
> executed **directly against PostgreSQL** over the wire protocol — no PostgREST server in between.

```ts
import { createClient } from 'pg-fluent'

const db = createClient({ connectionString: process.env.DATABASE_URL })

const { data, error } = await db
  .from('todos')
  .select('id, task, done')
  .eq('done', false)
  .order('id')
  .limit(10)
```

pg-fluent reuses the upstream builder you already know (the same request/response contract as
`supabase-js`), but translates the intercepted request into a single parameterized SQL statement
and runs it through [`node-postgres`](https://node-postgres.com/). You keep the ergonomics and the
`{ data, error }` result shape; you drop the HTTP hop, the extra service, and the JSON
re-serialization.

> pg-fluent is an independent project and is **not affiliated with or endorsed by Supabase**.
> "Supabase" is a trademark of Supabase, Inc. and is used here only to describe compatibility.

---

## Table of contents

- [Requirements](#requirements)
- [Install](#install)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Queries](#queries)
- [Embedded resources](#embedded-resources)
- [Writes](#writes)
- [Transactions and savepoints](#transactions-and-savepoints)
- [Raw SQL](#raw-sql)
- [Streaming and COPY](#streaming-and-copy)
- [LISTEN / NOTIFY](#listen--notify)
- [Named connections and read replicas](#named-connections-and-read-replicas)
- [Type generation](#type-generation)
- [Error handling](#error-handling)
- [Observability](#observability)
- [Security](#security)
- [Migrating from `supabase-js`](#migrating-from-supabase-js)
- [Compatibility matrix](#compatibility-matrix)
- [Versioning](#versioning)
- [License](#license)

---

## Requirements

- **Node.js 22+** (LTS).
- **PostgreSQL 15–18** (19 once generally available).

## Install

```bash
npm install pg-fluent
```

Optional peers, installed only if you use the related feature:

```bash
npm install pg-copy-streams    # db.copyFrom()
npm install @opentelemetry/api # telemetry: true
```

## Quick start

```ts
import { createClient } from 'pg-fluent'

const db = createClient({
  connectionString: process.env.DATABASE_URL,
  schemas: ['public'],
})

const { data, error } = await db.from('users').select('id, name').eq('active', true).order('name')
if (error) throw error
console.log(data)

await db.close()
```

Builders are **lazy thenables**: nothing executes until you `await` the chain. Results are always
the shape `{ data, error, count, status, statusText }` and, like upstream, **do not throw** for
query/database errors — check `error` (or call `.throwOnError()`).

## Configuration

```ts
const db = createClient({
  connectionString: 'postgres://user:pass@host:5432/db', // or: host/port/database/user/password
  ssl: { rejectUnauthorized: true },
  schemas: ['public'],                 // exposed-schema allowlist; first is the default
  pool: { max: 10, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 },
  maxRows: 1000,                       // cap for SELECT without an explicit limit/range
  statementTimeoutMs: 30_000,          // server-side statement_timeout (null = server default)
  retries: { max: 2, backoffMs: 50 },  // reads only
  allowUnfilteredMutations: false,
  logger, onQuery, telemetry,
  connections: { analytics: { /* ... */ } }, // named connections, see below
})
```

You may also pass your own `pg.Pool` via the `pool` option; pg-fluent will not close a pool it does
not own. The underlying pool is exposed as `db.$pool` (read-only by convention).

Defaults: `schemas: ['public']`, `maxRows: 1000`, `statementTimeoutMs: 30000`, pool `max: 10`,
`allowUnfilteredMutations: false`, retries reads-only.

`await db.close({ timeoutMs })` drains in-flight queries, ends owned pools and stops LISTEN
connections. It is idempotent; no process-exit hooks are installed implicitly.

## Queries

The full `postgrest-js` surface is available: `select`, `insert`, `update`, `upsert`, `delete`,
`rpc`, and the whole filter set (`eq neq gt gte lt lte like ilike match imatch is in contains
containedBy overlaps range* textSearch not or and filter`), plus JSON-path columns (`->`, `->>`),
`is.null`, nulls-first/last ordering, `limit`/`range`, `single`/`maybeSingle`, `csv`, `geojson`,
`explain`, `count`, `head`, and `.toSQL()`.

```ts
await db.from('todos').select('*').gte('priority', 2).order('created_at', { ascending: false })

await db.from('todos').select('*', { count: 'exact' }).range(0, 9)

await db.from('todos').select('*').or('done.eq.true,priority.gt.3')

await db.from('todos').select('id, meta->>author').eq('meta->>wip', 'true')

const { text, values } = await db.from('todos').select('id').eq('done', false).toSQL() // no execution
```

`.eq('col', null)` is rejected client-side (it never matches in SQL); use `.is('col', null)`.
An empty `in([])` compiles to an always-false predicate rather than a syntax error.

## Embedded resources

Many-to-one, one-to-many and many-to-many (through a junction) relationships are resolved from the
live schema cache; aliases, `!inner`, `!fk_name` / `!column` disambiguation, nested embedding, and
spread of to-one relations are supported, as are filters, ordering and limits on embedded
resources.

```ts
await db.from('posts').select('id, title, author:users(name)')
await db.from('users').select('id, posts!inner(title)').eq('posts.title', 'hello')
await db.from('posts').select('id, ...users(name)')       // spread a to-one relation
await db.from('users').select('id, posts(title)').order('posts.title')
```

A dotted filter or embedded modifier (`posts.title=eq.x`) requires the embed to be present in
`select()`. If it is not, the request is rejected with `PGRST100` rather than silently dropping the
filter — a dropped filter can turn a scoped read into a full-table read.

Embedding **views** is not supported in v1.

## Writes

```ts
await db.from('todos').insert({ task: 'write docs' }).select().single()
await db.from('todos').insert([{ task: 'a' }, { task: 'b' }]).select()
await db.from('todos').update({ done: true }).eq('id', 1).select()
await db.from('todos').upsert({ id: 1, task: 'x' }, { onConflict: 'id' }).select()
await db.from('todos').delete().eq('id', 1)
```

Mutations return rows **only** with `.select()` (there is no separate `.returning()`). Bulk inserts
are sent as a single JSON parameter and expanded server-side, so they are injection-safe and not
limited by the parameter count.

Without `.select()`, an `UPDATE`/`DELETE` that has no filter is refused client-side with
`PGFLUENT_UNFILTERED_MUTATION` unless you opt in with `allowUnfilteredMutations: true` or chain
`.allowUnfiltered()`. Upstream `.maxAffected(n)` rolls back and errors when exceeded.

For very large loads, use [`db.copyFrom()`](#streaming-and-copy).

## Transactions and savepoints

```ts
const user = await db.transaction(async (trx) => {
  const { data, error } = await trx.from('users').insert({ name: 'G' }).select().single()
  if (error) throw error
  await trx.from('profiles').insert({ user_id: data.id })
  await trx.savepoint(async (sp) => {
    /* SAVEPOINT; throwing rolls back to it */
  })
  return data
}, { isolationLevel: 'read committed', readOnly: false })
```

One dedicated connection per transaction; it is released in `finally`, always. Builders inside a
transaction still return `{ data, error }`. `db.transaction()` **rejects** if the callback throws
(rolling back), and resolves with the callback's return value otherwise. Call `trx.rollback()` to
roll back deliberately and resolve with `undefined`.

## Raw SQL

```ts
const { data, error } = await db.sql`select * from users where id = ${id}` // ${id} -> $1 (safe)
const { data } = await db.unsafe('select * from users where id = $1', [id]) // trusted text; params bound
db.identifier('my_table') // `"my_table"` — composable identifier fragment
```

- ``db.sql`` **always** binds interpolations as parameters. A plain string interpolation never
  becomes SQL text; use `db.identifier()` or a nested ``db.sql`` fragment to add structure.
- `db.unsafe(text, params?)` runs a caller-supplied SQL string and is the **only** way to execute
  SQL text you build yourself. The text is trusted; parameters are still bound.

Both return `{ data, error, count }` and work inside transactions.

## Streaming and COPY

Stream large reads without buffering the whole result:

```ts
for await (const row of db.from('events').select('*').gt('id', 0).stream()) {
  await handle(row)
}
```

`.stream()` holds one connection until the iterator finishes, is `return()`ed or throws (released
in `finally`), and respects backpressure. It is not available for `head`/`count` queries, and
embedded resources are delivered as JSON per row. Because a stream pins a connection, it counts
against pool size.

Bulk load very large datasets with `COPY FROM STDIN` (requires the optional `pg-copy-streams`
peer):

```ts
const { data, error } = await db.copyFrom('events', rows, { columns: ['id', 'kind'], format: 'csv' })
// data -> { rowCount }
```

## LISTEN / NOTIFY

```ts
const sub = await db.listen('orders', (payload, meta) => {
  console.log(meta.channel, payload)
})
await db.notify('orders', JSON.stringify({ id: 1 })) // pg_notify($1, $2) — parameterized
await sub.unlisten()
```

The listener uses a **dedicated, non-pooled** connection shared across channels and reconnects
automatically (exponential backoff + jitter, re-`LISTEN` on every channel). It emits
`connected`/`disconnected`/`reconnecting`/`error` events and never crashes the process on
connection loss. Channel names are validated as identifiers and payloads are capped at 8000 bytes.

> **Connection poolers:** LISTEN/NOTIFY is **not compatible with transaction-mode poolers**
> (e.g. PgBouncer in transaction pooling). Use a session-mode or direct connection.
>
> Notifications missed during a disconnect are lost (PostgreSQL semantics); use `onReconnect` to
> re-sync.

## Named connections and read replicas

```ts
const db = createClient({
  connections: {
    main: { connectionString: process.env.DATABASE_URL },
    analytics: { connectionString: process.env.ANALYTICS_URL },
  },
  defaultConnection: 'main',
})

await db.connection('analytics').from('events').select('*')
```

Read-replica routing is configured per connection with `{ primary, replicas: [...] }`. `SELECT`/
`HEAD` and non-volatile `rpc` calls go to replicas (round-robin, with a short unhealthy-replica
cool-down and fallback to the primary on **connection** errors only — never on query errors).
Mutations, volatile RPC, transactions, LISTEN/NOTIFY and schema-cache loads always hit the primary.
Force a primary read for read-your-writes with `.primary()`.

Replication is asynchronous: a read from a replica may not see a just-committed write. There is no
lag measurement in v1.

## Type generation

Generate a `Database` type compatible with upstream `postgrest-js`:

```bash
npx pg-fluent gen-types --connection "$DATABASE_URL" --schema public --out ./database.types.ts
# or set DATABASE_URL and omit --connection
```

```ts
import type { Database } from './database.types'
const db = createClient<Database>({ connectionString: process.env.DATABASE_URL })
```

Flags: `--connection <url>` (or `DATABASE_URL`), `--schema <name>` (repeatable, default `public`),
`--out <file>`, `--no-comments`. The connection string is never printed. Output covers nullable,
default, identity and generated columns, enums, arrays, `json`/`jsonb` (→ `Json`), composite types,
domains, views, foreign-key `Relationships`, and functions with resolvable argument/return types.

## Error handling

Results carry an `error` (a `PostgrestError`-shaped object `{ message, details, hint, code }`) plus
`status`. `code` is the PostgreSQL **SQLSTATE** for database errors, a PostgREST `PGRSTxxx` code
where an equivalent exists (`PGRST100` parse, `PGRST106` schema not exposed, `PGRST116`
cardinality, `PGRST200/201` relationship, `PGRST202/203` function, `PGRST204` column), or a library
code `PGFLUENT_*` (`INVALID_QUERY`, `UNFILTERED_MUTATION`, `ABORTED`, `TIMEOUT`, `CONNECTION`,
`POOL_EXHAUSTED`, `CLOSED`).

`error.kind` classifies the failure as `validation`, `parse`, `database`, `connection`, `timeout`,
`aborted` or `internal`. Distinguish clearly between **no rows** (success: `data: []`, or `null`
for `maybeSingle`), **cardinality** (`PGRST116`), **invalid query** and **database failure**.

Only idempotent work (reads/HEAD/non-volatile RPC) is retried on transient connection failures, with
exponential backoff + jitter. Writes are never retried outside an opt-in transaction retry.

## Observability

Pass a `logger` (`{ debug, info, warn, error }`) and/or an `onQuery(event)` hook receiving
`{ operation, schema, table, durationMs, rowCount, error?, connection, route, retried }`.
**Parameter values are never logged** by default; opt in with `logParams: true` and a
`redactColumns` list.

With `@opentelemetry/api` installed, set `telemetry: true` for one span per query. When the peer is
absent there is zero overhead.

## Security

- **Injection safety.** Every value is a bound parameter. User-controlled *structure* (`select`,
  `order`, `or()`/`filter()` bodies, JSON keys/paths, `on_conflict`, `columns`, embed hints,
  identifiers) is validated against strict allowlists/grammar and quoted via a single
  `quoteIdent`, never concatenated into SQL text. The only way to execute caller-supplied SQL text
  is the explicitly named `db.unsafe()`.
- **Least privilege.** Connect with a **least-privilege role**, not the table owner or a
  superuser/`BYPASSRLS` role.
- **Credentials.** Prefer `connectionString` from the environment. Passwords never appear in
  `toString()`, `JSON.stringify`, logs or error messages. TLS is configurable; a warning is emitted
  for non-local connections without TLS.

### RLS warning (read this before migrating)

pg-fluent runs statements using the **connection's own role** — the same way `psql` or any direct
driver does. It does **not** set `role`/`request.jwt.claims` and does **not** emulate Supabase's
`anon` / `authenticated` roles.

Consequently, **Row Level Security policies written for Supabase's `anon`/`authenticated` roles do
not apply.** If you connect as the table owner or any role with `BYPASSRLS`, RLS is skipped
entirely. Treat pg-fluent as a **server-side only** library: **database credentials must never
reach browsers or untrusted clients.** If you need per-user policy enforcement, connect as a
non-owner role for which RLS is enabled and set `request.jwt.claims` / `SET ROLE` yourself before
querying.

## Migrating from `supabase-js`

The query-builder API is intentionally a drop-in replacement for `postgrest-js`. In most cases:

1. Replace `createClient(url, anonKey)` with `createClient({ connectionString })`.
2. Delete `supabase.auth`, `supabase.storage` and `supabase.functions` — pg-fluent is a database
   client, not a BaaS SDK. Call those services directly.
3. Run `gen-types` against your database (or keep the same generated `Database` type).
4. **Review RLS** (see the warning above): your policies were written for PostgREST's roles and do
   not automatically protect a direct connection.

What differs from Supabase/PostgREST:

| Area | Difference |
|---|---|
| Transport | Direct PostgreSQL wire protocol; no HTTP, no PostgREST service |
| URLs / keys | A connection string (or discrete credentials), not a project URL + anon key |
| Auth / storage / edge functions | Not provided |
| RLS / roles | Runs as the connecting role; Supabase role policies do not apply |
| Views | Readable; **embedding views is unsupported** in v1 |
| Embedded filters | A dotted filter/modifier on an embed that is not in `select()` is rejected with `PGRST100` instead of being silently ignored (which would return unfiltered rows) |
| Streaming | Native `.stream()` (no HTTP chunking) |
| Extras | `.toSQL()`, safe mutations, COPY, LISTEN, named connections, replicas |

## Compatibility matrix

| pg-fluent | Node | PostgreSQL | `@supabase/postgrest-js` |
|---|---|---|---|
| 0.1.x | 22, 24 (26 at LTS) | 15, 16, 17, 18 (19 at GA) | pinned exact (see `docs/UPSTREAM.md`) |

The pinned `postgrest-js` version is recorded in `docs/UPSTREAM.md`, with the date and reason for
every bump.

## Versioning

pg-fluent follows SemVer. The public API (the query builder plus documented extras) is the
compatibility contract; internal modules are not. Dropping a Node/PostgreSQL major that is EOL
upstream is a minor release; otherwise it is a major release.

## License

MIT © Mathew Gerald. See [LICENSE](./LICENSE).

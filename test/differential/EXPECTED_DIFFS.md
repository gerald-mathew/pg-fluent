# Expected differences from PostgREST

`postgrest.test.ts` runs the same logical requests through a real PostgREST server and through
pg-fluent, then asserts the payloads match. One behavior is **intentionally different** from
PostgREST. It is asserted explicitly in the test file so that any *new* drift still fails the suite,
and any change to this decision is a deliberate, reviewable act.

Run them locally with a PostgREST server and a test database:

```bash
export PGFLUENT_TEST_URL=postgres://pgfluent:pgfluent@127.0.0.1:5432/pgfluent_test
export PGFLUENT_POSTGREST_URL=http://127.0.0.1:3000
npx vitest run test/differential
```

Without `PGFLUENT_POSTGREST_URL` the file skips automatically, so it is safe to run anywhere.

## 1. Reserved parameter names used as filter columns

| Request | PostgREST | pg-fluent |
| --- | --- | --- |
| `pf_todos?select=id&columns=eq.1` | `200`, returns every row (`columns` ignored on a read) | `400 PGFLUENT_INVALID_QUERY` |

`select`, `on_conflict` and `columns` are reserved query-string parameters, not columns. When one of
them carries a value that parses as a filter (`select=eq.1`, `columns=eq.1`, `on_conflict=neq.1`),
the caller almost certainly meant `.eq('select', …)` and the filter would otherwise vanish.
pg-fluent rejects it instead of silently dropping the filter. Normal uses of these parameters
(`select=id,name`, `columns=id,name`, `on_conflict=id`) are unaffected.

## Aligned: dotted filter on an embed not in `select`

| Request | PostgREST | pg-fluent |
| --- | --- | --- |
| `pf_posts?select=id&pf_users.name=eq.gerald` | `400` | `400 PGRST100` |

Older PostgREST releases silently dropped an embedded filter when the embedded resource was not in
`select` (PostgREST issue
[#2340](https://github.com/PostgREST/postgrest/issues/2340): *"simply ignored and discarded without
any notification or any error message"*). PostgREST v16+ rejects the request with `400` instead, so
pg-fluent now matches it: `PGRST100` plus a hint to add the embed to `select()` or drop the dotted
filter. The differential test asserts the parity so a future PostgREST change is caught. To filter
parent rows through an embed, select it and use `!inner`:

```ts
db.from('pf_users').select('name, pf_posts!inner(title)').eq('pf_posts.title', 'hello')
```

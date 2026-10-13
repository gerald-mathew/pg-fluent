import { PgFluentError } from '../errors/index.js'
import { quoteCast, quoteIdent } from './quote.js'

/** Accumulates bind parameters and hands out `$n` placeholders. */
export class ParamBag {
  readonly values: unknown[] = []

  add(value: unknown): string {
    this.values.push(value)
    return `$${this.values.length}`
  }
}

function invalid(message: string): PgFluentError {
  return new PgFluentError('PGFLUENT_INVALID_QUERY', message)
}

/**
 * Render a column reference qualified by `alias`, applying JSON access steps.
 * The base column is wrapped in `to_jsonb(...)` so that access works for both
 * `json`/`jsonb` columns and scalar columns (e.g. a `text[]`). Numeric keys are
 * treated as array indices (`->0`); all other keys are bound as parameters
 * (never concatenated) and cast to `text`.
 */
export function renderColumn(
  alias: string,
  base: string,
  steps: ReadonlyArray<{ op: '->' | '->>'; key: string }>,
  bag: ParamBag
): string {
  if (steps.length === 0) return `${alias}.${quoteIdent(base)}`
  let sql = `to_jsonb(${alias}.${quoteIdent(base)})`
  for (const step of steps) {
    if (/^\d+$/.test(step.key)) sql += `${step.op}${step.key}`
    else sql += `${step.op}(${bag.add(step.key)}::text)`
  }
  return sql
}

/** Format a `select` item's SQL expression for a `select-list`. */
export function formatSelectExpr(
  alias: string,
  base: string,
  steps: ReadonlyArray<{ op: '->' | '->>'; key: string }>,
  cast: string | undefined,
  bag: ParamBag
): string {
  let sql = renderColumn(alias, base, steps, bag)
  if (cast) sql += `::${quoteCast(cast)}`
  return sql
}

/** Render a `LIMIT`/`OFFSET` pair. */
export function renderLimitOffset(limit: number | undefined, offset: number | undefined): string {
  let sql = ''
  if (limit !== undefined) sql += ` LIMIT ${Math.trunc(limit)}`
  if (offset !== undefined) sql += ` OFFSET ${Math.trunc(offset)}`
  return sql
}

export function assertNonEmpty(value: string, what: string): void {
  if (value === '') throw invalid(`Empty ${what}`)
}

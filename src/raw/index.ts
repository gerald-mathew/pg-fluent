import type { ClassifiedError } from '../errors/index.js'
import type { Executor } from '../exec/executor.js'
import { classifyError } from '../response/error.js'
import { quoteIdent } from '../sql/quote.js'

/** Result shape shared by `sql` / `unsafe` (mirrors upstream `{ data, error, count }`). */
export interface RawResult<T = Record<string, unknown>> {
  data: T[] | null
  error: ClassifiedError | null
  count: number | null
  status: number
  statusText: string
}

/** A safe identifier fragment produced by `db.identifier(name)`. */
export interface IdentifierFragment {
  readonly __pgflIdent: true
  readonly name: string
}

/** A composable SQL fragment produced by the `sql` tag. */
export interface SqlFragment {
  readonly __pgflSql: true
  readonly strings: readonly string[]
  readonly values: readonly unknown[]
}

export type SqlInterpolation = SqlFragment | IdentifierFragment

function isFragment(value: unknown): value is SqlFragment {
  return (
    typeof value === 'object' && value !== null && (value as { __pgflSql?: unknown }).__pgflSql === true
  )
}

function isIdentifier(value: unknown): value is IdentifierFragment {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { __pgflIdent?: unknown }).__pgflIdent === true
  )
}

/**
 * Compile a tagged template into SQL text, binding plain interpolations as
 * parameters (`$1`, `$2`, …). Nested `sql` fragments are inlined and share the
 * parent's parameter numbering; identifiers are quoted.
 */
function compile(
  strings: readonly string[],
  values: readonly unknown[],
  params: unknown[]
): string {
  let text = ''
  for (let i = 0; i < strings.length; i++) {
    text += strings[i]
    if (i >= values.length) continue
    const value = values[i]
    if (isFragment(value)) {
      text += compile(value.strings, value.values, params)
    } else if (isIdentifier(value)) {
      text += quoteIdent(value.name)
    } else {
      params.push(value)
      text += `$${params.length}`
    }
  }
  return text
}

async function executeRaw<T>(
  executor: Executor,
  text: string,
  params: unknown[]
): Promise<RawResult<T>> {
  try {
    const result = await executor.query(text, params)
    return {
      data: result.rows as T[],
      error: null,
      count: result.rowCount,
      status: 200,
      statusText: 'OK',
    }
  } catch (err) {
    const error = classifyError(err)
    return { data: null, error, count: null, status: error.status, statusText: 'Error' }
  }
}

/** A composable, awaitable `sql` tag result. */
export class SqlQuery<T = Record<string, unknown>>
  implements PromiseLike<RawResult<T>>, SqlFragment
{
  readonly __pgflSql = true as const
  constructor(
    private readonly executor: Executor,
    readonly strings: readonly string[],
    readonly values: readonly unknown[]
  ) {}

  /** The SQL text this fragment would produce (with `$n` placeholders). */
  get text(): string {
    return compile(this.strings, this.values, [])
  }

  /** The compiled `{ text, values }` without executing. */
  toSQL(): { text: string; values: unknown[] } {
    const params: unknown[] = []
    const text = compile(this.strings, this.values, params)
    return { text, values: params }
  }

  then<TResult1 = RawResult<T>, TResult2 = never>(
    onfulfilled?: ((value: RawResult<T>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    const params: unknown[] = []
    const text = compile(this.strings, this.values, params)
    return executeRaw<T>(this.executor, text, params).then(onfulfilled, onrejected)
  }

  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null
  ): Promise<RawResult<T> | TResult> {
    return this.then(undefined, onrejected)
  }

  finally(onfinally?: (() => void) | null): Promise<RawResult<T>> {
    return this.then(
      (value) => {
        onfinally?.()
        return value
      },
      (reason) => {
        onfinally?.()
        throw reason
      }
    )
  }
}

export interface SqlTag {
  <T = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): SqlQuery<T>
}

export function makeSqlTag(executor: Executor): SqlTag {
  return <T>(strings: TemplateStringsArray, ...values: unknown[]) =>
    new SqlQuery<T>(executor, [...strings], values)
}

export function makeIdentifier(name: string): IdentifierFragment {
  return { __pgflIdent: true, name }
}

export function runUnsafe<T = Record<string, unknown>>(
  executor: Executor,
  text: string,
  params: readonly unknown[] = []
): Promise<RawResult<T>> {
  return executeRaw<T>(executor, text, [...params])
}

export { quoteIdent }

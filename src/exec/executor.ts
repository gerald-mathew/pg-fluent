import type { Pool, PoolClient, QueryResult as PgQueryResult } from 'pg'
import { PgFluentError } from '../errors/index.js'
import Cursor from 'pg-cursor'

export interface QueryResult {
  rows: Record<string, unknown>[]
  rowCount: number | null
}

export interface TransactionOptions {
  isolationLevel?: 'read uncommitted' | 'read committed' | 'repeatable read' | 'serializable'
  readOnly?: boolean
  /**
   * Retry the transaction callback this many times on serialization failures
   * (`40001`) or deadlocks (`40P01`). The callback must be idempotent.
   */
  retry?: number
  /** Server-side `idle_in_transaction_session_timeout` in milliseconds. */
  timeoutMs?: number
}

function isRetryableTransactionError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code
  return code === '40001' || code === '40P01'
}

export interface Executor {
  query(text: string, values?: unknown[]): Promise<QueryResult>
  transaction<T>(fn: (tx: Executor) => Promise<T>, options?: TransactionOptions): Promise<T>
  /**
   * Optional: run a statement that can be cancelled via an `AbortSignal`,
   * issuing a PostgreSQL cancel request for the backend PID. The connection is
   * destroyed afterwards so it never returns to the pool in an unknown state.
   */
  queryWithSignal?(
    text: string,
    values: unknown[] | undefined,
    signal: AbortSignal
  ): Promise<QueryResult>
  stream?(text: string, values?: unknown[]): AsyncGenerator<Record<string, unknown>>
}

/** Wraps a value thrown to force a rollback while still returning the value. */
export class RollbackSignal<T = unknown> {
  constructor(readonly value: T) {}
}

/**
 * Run `fn` inside a transaction and always roll it back, returning whatever
 * `fn` produced. Used for `Prefer: tx=rollback` and `EXPLAIN (ANALYZE)` of a
 * mutation.
 */
export async function runAndRollback<T>(
  executor: Executor,
  fn: (tx: Executor) => Promise<T>
): Promise<T> {
  try {
    return await executor.transaction(async (tx) => {
      const value = await fn(tx)
      throw new RollbackSignal(value)
    })
  } catch (err) {
    if (err instanceof RollbackSignal) return err.value as T
    throw err
  }
}

/** Structural view of the `pg` client fields used for cancellation. */
interface CancelableClient {
  activeQuery?: unknown
  cancel?: (client: unknown, query: unknown) => void
}

function abortedError(cause?: unknown): PgFluentError {
  return new PgFluentError('PGFLUENT_ABORTED', 'The request was aborted', { cause })
}

const ISOLATION: Readonly<Record<string, string>> = {
  'read uncommitted': 'READ UNCOMMITTED',
  'read committed': 'READ COMMITTED',
  'repeatable read': 'REPEATABLE READ',
  serializable: 'SERIALIZABLE',
}

function isolationClause(options: TransactionOptions | undefined): string {
  let clause = 'BEGIN'
  if (options?.isolationLevel) {
    const iso = ISOLATION[options.isolationLevel]
    if (!iso) {
      throw new PgFluentError(
        'PGFLUENT_INVALID_QUERY',
        `Unknown isolation level: ${options.isolationLevel}`
      )
    }
    clause += ` ISOLATION LEVEL ${iso}`
  }
  if (options?.readOnly) clause += ' READ ONLY'
  return clause
}

/** Executor pinned to a single pooled connection; supports nested savepoints. */
export class PgClientExecutor implements Executor {
  constructor(
    private readonly client: Pick<PoolClient, 'query'>,
    private readonly depth = 0
  ) {}

  async query(text: string, values?: unknown[]): Promise<QueryResult> {
    const result = (await this.client.query(text, values as never[])) as PgQueryResult
    return { rows: result.rows as Record<string, unknown>[], rowCount: result.rowCount }
  }

  async *stream(text: string, values?: unknown[]): AsyncGenerator<Record<string, unknown>> {
    const client = this.client as any
    const cursor = new Cursor(text, values || [])
    client.query(cursor)
    while (true) {
      const rows = await new Promise<Record<string, unknown>[]>((resolve, reject) => {
        cursor.read(100, (err: any, r: any) => {
          if (err) return reject(err)
          resolve(r || [])
        })
      })
      if (rows.length === 0) {
        try { cursor.close(() => {}) } catch {}
        break
      }
      for (const row of rows) {
        yield row as Record<string, unknown>
      }
    }
  }

  async queryWithSignal(
    text: string,
    values: unknown[] | undefined,
    signal: AbortSignal
  ): Promise<QueryResult> {
    if (signal.aborted) throw abortedError()
    const client = this.client as unknown as CancelableClient
    const onAbort = (): void => {
      try {
        if (client.activeQuery !== undefined && typeof client.cancel === 'function') {
          client.cancel(client, client.activeQuery)
        }
      } catch {
        // Best-effort cancel; the query may already be settling.
      }
    }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      return await this.query(text, values)
    } catch (err) {
      if (signal.aborted) throw abortedError(err)
      throw err
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  async transaction<T>(
    fn: (tx: Executor) => Promise<T>,
    options?: TransactionOptions
  ): Promise<T> {
    const root = this.depth === 0
    const savepoint = `pgfl_sp_${this.depth}`
    await this.client.query(root ? isolationClause(options) : `SAVEPOINT ${savepoint}`)
    if (root && options?.timeoutMs !== undefined) {
      await this.client.query(
        `SET LOCAL idle_in_transaction_session_timeout = ${Math.trunc(options.timeoutMs)}`
      )
    }
    const child = new PgClientExecutor(this.client, this.depth + 1)
    try {
      const value = await fn(child)
      await this.client.query(root ? 'COMMIT' : `RELEASE SAVEPOINT ${savepoint}`)
      return value
    } catch (err) {
      await this.client.query(root ? 'ROLLBACK' : `ROLLBACK TO SAVEPOINT ${savepoint}`)
      throw err
    }
  }
}

export type PgQueryable = Pick<Pool | PoolClient, 'query'>

/** Executor over a pool (acquires a connection per transaction) or a client. */
export class PgExecutor implements Executor {
  constructor(private readonly source: PgQueryable) {}

  async query(text: string, values?: unknown[]): Promise<QueryResult> {
    const result = (await this.source.query(text, values as never[])) as PgQueryResult
    return { rows: result.rows as Record<string, unknown>[], rowCount: result.rowCount }
  }

  async *stream(text: string, values?: unknown[]): AsyncGenerator<Record<string, unknown>> {
    const source = this.source as { connect?: Pool['connect'] }
    if (typeof source.connect === 'function') {
      const pool = this.source as Pool
      const client = await pool.connect()
      try {
        const executor = new PgClientExecutor(client)
        for await (const row of executor.stream!(text, values)) {
          yield row
        }
      } finally {
        client.release()
      }
    } else {
      const executor = new PgClientExecutor(this.source as PoolClient)
      for await (const row of executor.stream!(text, values)) {
        yield row
      }
    }
  }

  async queryWithSignal(
    text: string,
    values: unknown[] | undefined,
    signal: AbortSignal
  ): Promise<QueryResult> {
    const source = this.source as { connect?: Pool['connect'] }
    if (typeof source.connect !== 'function') {
      return new PgClientExecutor(this.source as PoolClient).queryWithSignal(text, values, signal)
    }
    if (signal.aborted) throw abortedError()
    const pool = this.source as Pool
    const client = await pool.connect()
    const pid = (client as unknown as { processID?: number | null }).processID
    let aborted = false
    const onAbort = (): void => {
      aborted = true
      if (pid !== undefined && pid !== null) {
        pool.query('SELECT pg_cancel_backend($1)', [pid]).catch(() => undefined)
      }
    }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      return await new PgClientExecutor(client).query(text, values)
    } catch (err) {
      if (signal.aborted) throw abortedError(err)
      throw err
    } finally {
      signal.removeEventListener('abort', onAbort)
      client.release(aborted ? new Error('pg-fluent: connection destroyed after abort') : undefined)
    }
  }

  transaction<T>(fn: (tx: Executor) => Promise<T>, options?: TransactionOptions): Promise<T> {
    const source = this.source as { connect?: Pool['connect'] }
    if (typeof source.connect === 'function') {
      const pool = this.source as Pool
      const run = async (): Promise<T> => {
        const client = await pool.connect()
        try {
          return await new PgClientExecutor(client).transaction(fn, options)
        } finally {
          client.release()
        }
      }
      const retry = options?.retry ?? 0
      if (retry <= 0) return run()
      return (async () => {
        for (let attempt = 1; ; attempt += 1) {
          try {
            return await run()
          } catch (err) {
            if (attempt > retry || !isRetryableTransactionError(err)) throw err
          }
        }
      })()
    }
    if ('release' in this.source) {
      return new PgClientExecutor(this.source as PoolClient).transaction(fn, options)
    }
    throw new PgFluentError(
      'PGFLUENT_CLOSED',
      'Transactions require a pool or pooled connection executor'
    )
  }
}

export type ExecutorSource = Executor | PgQueryable

/** True for an object exposing `transaction` (i.e. an {@link Executor}). */
export function isExecutor(source: ExecutorSource): source is Executor {
  return typeof (source as Executor).transaction === 'function'
}

export function resolveExecutor(source: ExecutorSource): Executor {
  if (isExecutor(source)) return source
  return new PgExecutor(source as PgQueryable)
}

import pg from 'pg'
import { PostgrestClient, type PostgrestClientOptions } from '@supabase/postgrest-js'
import { PgFluentError } from './errors/index.js'
import { createFetchAdapter } from './adapter/fetch.js'
import { PgExecutor, type Executor, type TransactionOptions } from './exec/executor.js'
import type { RetryConfig } from './exec/retry.js'
import { Instrument, type Logger, type QueryEvent } from './observability/index.js'
import { installExtensions } from './extensions/to-sql.js'
import {
  makeIdentifier,
  makeSqlTag,
  runUnsafe,
  type IdentifierFragment,
  type RawResult,
  type SqlTag,
} from './raw/index.js'
import type { ConnectionConfig, RoutedConnectionConfig, SingleConnectionConfig } from './connections/types.js'
import { isRouted } from './connections/types.js'
import { RoutingExecutor } from './connections/router.js'
import type { RouteContext } from './connections/router.js'
import { assertChannel, ListenManager } from './listen/manager.js'
import type { ListenMeta, ListenOptions, ListenSubscription } from './listen/manager.js'
import { runCopy, type CopyFromOptions } from './copy/copy.js'
import { PRIMARY_HEADER } from './extensions/constants.js'

export type { RetryConfig } from './exec/retry.js'
export type { ConnectionConfig, SingleConnectionConfig, RoutedConnectionConfig } from './connections/types.js'
export type { ReplicaConfig } from './connections/types.js'
export type { ListenMeta, ListenOptions, ListenSubscription } from './listen/manager.js'
export type { CopyFromOptions } from './copy/copy.js'

export interface PoolOptions {
  max?: number
  idleTimeoutMillis?: number
  connectionTimeoutMillis?: number
}

export interface PgFluentConfig {
  connectionString?: string
  host?: string
  port?: number
  database?: string
  user?: string
  password?: string
  ssl?: pg.PoolConfig['ssl']
  schemas?: string[]
  pool?: pg.Pool | (pg.PoolConfig & PoolOptions)
  maxRows?: number
  statementTimeoutMs?: number | null
  allowUnfilteredMutations?: boolean
  retries?: RetryConfig
  logger?: Logger
  onQuery?: (event: QueryEvent) => void
  /** Log parameter values (opt-in). Redact named columns via `redactColumns`. */
  logParams?: boolean
  redactColumns?: string[]
  /** Enable OpenTelemetry spans when `@opentelemetry/api` is installed. */
  telemetry?: boolean
  connections?: Record<string, ConnectionConfig>
  defaultConnection?: string
}

export interface PgFluentExtras<Database = unknown> {
  readonly $pool: pg.Pool
  close(options?: { timeoutMs?: number }): Promise<void>
  /**
   * Run `fn` on a single dedicated connection inside a transaction. Nested
   * calls use savepoints. Throws (and rolls back) if `fn` throws; call
   * `trx.rollback()` to roll back deliberately and resolve with `undefined`.
   */
  transaction<T>(
    fn: (trx: PgFluentClient<Database>) => Promise<T>,
    options?: TransactionOptions
  ): Promise<T>
  /** Alias for {@link transaction} when nesting; rolls back to a savepoint. */
  savepoint<T>(fn: (trx: PgFluentClient<Database>) => Promise<T>): Promise<T>
  /** Deliberately roll back the enclosing transaction. */
  rollback(): never
  /** Safe tagged-template SQL; interpolations are bound as parameters. */
  sql: SqlTag
  /** Execute a trusted SQL string with bound parameters. */
  unsafe<T = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[]
  ): Promise<RawResult<T>>
  /** Build a safely-quoted identifier fragment for use inside `sql`. */
  identifier(name: string): IdentifierFragment
  /** Switch to a named connection. */
  connection(name: string): PgFluentClient<Database>
  /** Force this read to execute against the primary instance. */
  primary(): PgFluentClient<Database>
  /** Clear the schema cache. */
  refreshSchema(): void
  /** Send a PostgreSQL notification. Payload is limited to 8000 bytes. */
  notify(channel: string, payload?: string): Promise<void>
  /**
   * Subscribe to a channel on a dedicated, non-pooled connection shared across
   * channels. Reconnects automatically (backoff + jitter) and re-`LISTEN`s on
   * every channel after reconnection.
   */
  listen(
    channel: string,
    callback: (payload: string, meta: ListenMeta) => void,
    options?: ListenOptions
  ): Promise<ListenSubscription>
  unlisten(channel: string): Promise<void>
  unlistenAll(): Promise<void>
  /**
   * Bulk-load rows via COPY FROM STDIN. Requires the optional peer dependency
   * `pg-copy-streams`. Not available inside transactions.
   */
  copyFrom(
    table: string,
    rows: readonly Record<string, unknown>[] | AsyncIterable<Record<string, unknown>>,
    options?: CopyFromOptions
  ): Promise<{ data: { rowCount: number } | null; error: unknown | null }>
}

/**
 * Client options for a database type. Honours a generated
 * `Database['__InternalSupabase']` override when present; otherwise assumes
 * PostgREST 13 (the features pg-fluent implements, e.g. `maxAffected`, spread).
 */
type ClientOptionsFor<Database> = 0 extends 1 & Database
  ? { PostgrestVersion: '13' }
  : Database extends { __InternalSupabase: infer I extends PostgrestClientOptions }
    ? I
    : { PostgrestVersion: '13' }

export type PgFluentClient<Database = any> = PostgrestClient<
  Database,
  ClientOptionsFor<Database>
> &
  PgFluentExtras<Database>

export const DEFAULT_MAX_ROWS = 1000
export const DEFAULT_STATEMENT_TIMEOUT_MS = 30000
export const DEFAULT_RETRIES: RetryConfig = { max: 2, backoffMs: 50 }

const ROLLBACK = Symbol('pgfluent.rollback')

interface BuiltOptions {
  schemas: string[]
  defaultSchema: string
  maxRows: number
  allowUnfilteredMutations: boolean
  retries: RetryConfig
  instrument: Instrument
  /** Build clients for named connections. */
  getNamedClient?: (name: string) => PgFluentClient<any> | undefined
  /** LISTEN/NOTIFY manager (top-level clients only). */
  listener?: ListenManager
  /** Pin this client's requests to the primary (client-level `.primary()`). */
  forcePrimary?: boolean
  /** Derived view client: `close()` is a no-op; shares the parent's pools. */
  view?: boolean
}

function buildPoolForSingle(
  config: SingleConnectionConfig,
  statementTimeoutDefault: number | null,
  onIdleError?: (err: unknown) => void
): { pool: pg.Pool; owned: boolean } {
  if (config.pool instanceof pg.Pool) {
    return { pool: config.pool, owned: false }
  }
  const poolConfig: pg.PoolConfig = {}
  if (config.connectionString !== undefined) poolConfig.connectionString = config.connectionString
  if (config.host !== undefined) poolConfig.host = config.host
  if (config.port !== undefined) poolConfig.port = config.port
  if (config.database !== undefined) poolConfig.database = config.database
  if (config.user !== undefined) poolConfig.user = config.user
  if (config.password !== undefined) poolConfig.password = config.password
  if (config.ssl !== undefined) poolConfig.ssl = config.ssl
  if (config.pool !== undefined && !(config.pool instanceof pg.Pool)) {
    Object.assign(poolConfig, config.pool)
  }

  const timeout = config.statementTimeoutMs === undefined ? statementTimeoutDefault : config.statementTimeoutMs
  if (timeout !== null) poolConfig.statement_timeout = timeout

  const pool = new pg.Pool(poolConfig)
  // Idle-client errors otherwise become uncaught 'error' events that crash the process.
  if (onIdleError !== undefined) pool.on('error', onIdleError)

  return { pool, owned: true }
}

function buildClient<Database>(
  executor: Executor,
  pool: pg.Pool,
  owned: boolean,
  ownedPools: pg.Pool[] | undefined,
  options: BuiltOptions,
  existingFetchAdapter?: typeof fetch
): PgFluentClient<Database> {
  installExtensions()

  const fetchAdapter =
    existingFetchAdapter ??
    createFetchAdapter({
      executor,
      schemas: options.schemas,
      defaultSchema: options.defaultSchema,
      maxRows: options.maxRows,
      allowUnfilteredMutations: options.allowUnfilteredMutations,
      retries: options.retries,
      instrument: options.instrument,
      getRouteContext: (req) => {
        const ctx: RouteContext = {
          forcePrimary: req.forcePrimary,
          isWrite: req.method === 'POST' || req.method === 'PATCH' || req.method === 'DELETE',
          isVolatileRpc: req.resource.kind === 'rpc',
        }
        return ctx
      },
    })

  const rest = new PostgrestClient<Database, ClientOptionsFor<Database>>(
    'http://pg-fluent.local',
    {
      fetch: fetchAdapter,
      schema: options.defaultSchema as never,
      retry: false,
    }
  )

  if (options.forcePrimary) {
    try {
      (rest as any).headers?.set?.(PRIMARY_HEADER, '1')
    } catch {
      // The headers container is opaque; the builder-level `.primary()` still works.
    }
  }

  let closed = false
  const runTransaction = async <T>(
    fn: (trx: PgFluentClient<Database>) => Promise<T>,
    txOptions?: TransactionOptions
  ): Promise<T> => {
    try {
      return await executor.transaction(async (tx) => {
        const trx = buildClient<Database>(tx, pool, false, undefined, {
          ...options,
          listener: undefined,
        })
        return fn(trx)
      }, txOptions)
    } catch (err) {
      if (err === ROLLBACK) return undefined as T
      throw err
    }
  }

  const extras: PgFluentExtras<Database> = {
    $pool: pool,
    async close(closeOptions?: { timeoutMs?: number }): Promise<void> {
      if (closed) return
      closed = true
      // Derived view clients share the parent's pools and listener; closing a view must not
      // tear them down while the parent remains in use.
      if (options.view) return
      const pools = new Set<pg.Pool>()
      if (owned) pools.add(pool)
      for (const p of ownedPools ?? []) pools.add(p)
      const tasks: Promise<unknown>[] = []
      if (options.listener) tasks.push(options.listener.stop())
      for (const p of pools) tasks.push(p.end())
      if (tasks.length === 0) return
      const timeoutMs = closeOptions?.timeoutMs
      if (timeoutMs === undefined) {
        await Promise.allSettled(tasks)
        return
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      const guard = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new PgFluentError(
                'PGFLUENT_CLOSED',
                `Timed out closing the connection pool after ${timeoutMs} ms`
              )
            ),
          timeoutMs
        )
        timer.unref?.()
      })
      try {
        await Promise.race([Promise.allSettled(tasks).then(() => undefined), guard])
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    },
    transaction: runTransaction,
    savepoint<T>(fn: (trx: PgFluentClient<Database>) => Promise<T>): Promise<T> {
      return runTransaction(fn)
    },
    rollback(): never {
      throw ROLLBACK
    },
    sql: makeSqlTag(executor),
    unsafe: (text: string, params?: readonly unknown[]) => runUnsafe(executor, text, params),
    identifier: makeIdentifier,
    connection(name: string): PgFluentClient<Database> {
      const c = options.getNamedClient?.(name)
      if (!c) throw new PgFluentError('PGFLUENT_INVALID_QUERY', `Unknown connection: ${name}`)
      return c as any
    },
    primary(): PgFluentClient<Database> {
      // Return a derived client whose requests carry the primary header, instead of
      // permanently mutating the shared header set of this client.
      return buildClient<Database>(
        executor,
        pool,
        false,
        undefined,
        { ...options, forcePrimary: true, view: true, listener: options.listener },
        fetchAdapter
      )
    },
    refreshSchema(): void {
      const schemaCache = (fetchAdapter as any)?._schemaCache
      if (schemaCache && typeof schemaCache.refresh === 'function') {
        schemaCache.refresh()
      } else if (schemaCache && typeof schemaCache.clear === 'function') {
        schemaCache.clear()
      }
    },
    async notify(channel: string, payload?: string): Promise<void> {
      assertChannel(channel)
      if (payload !== undefined && Buffer.byteLength(payload, 'utf8') > 8000) {
        throw new PgFluentError(
          'PGFLUENT_INVALID_QUERY',
          `NOTIFY payload exceeds the 8000 byte limit (${Buffer.byteLength(payload, 'utf8')} bytes)`
        )
      }
      if (payload !== undefined) {
        await extras.sql`SELECT pg_notify(${channel}, ${payload})`
      } else {
        await extras.sql`SELECT pg_notify(${channel})`
      }
    },
    async listen(
      channel: string,
      callback: (payload: string, meta: ListenMeta) => void,
      listenOptions?: ListenOptions
    ): Promise<ListenSubscription> {
      assertChannel(channel)
      if (!options.listener) {
        throw new PgFluentError(
          'PGFLUENT_INVALID_QUERY',
          'db.listen() is not available on a transaction client'
        )
      }
      return options.listener.subscribe(channel, callback, listenOptions)
    },
    async unlisten(channel: string): Promise<void> {
      assertChannel(channel)
      await options.listener?.unsubscribe(channel)
    },
    async unlistenAll(): Promise<void> {
      await options.listener?.unlistenAll()
    },
    copyFrom: (
      table: string,
      rows: readonly Record<string, unknown>[] | AsyncIterable<Record<string, unknown>>,
      copyOptions?: CopyFromOptions
    ) => {
      if (options.listener === undefined) {
        return Promise.resolve<{ data: { rowCount: number } | null; error: unknown | null }>({
          data: null,
          error: new PgFluentError(
            'PGFLUENT_INVALID_QUERY',
            'db.copyFrom() is not available inside a transaction'
          ),
        })
      }
      return runCopy(pool, table, rows, copyOptions)
    },
  } as any

  return Object.assign(rest, extras) as any
}

export function createClient<Database = any>(config: PgFluentConfig = {}): PgFluentClient<Database> {
  const schemas = config.schemas && config.schemas.length > 0 ? config.schemas : ['public']
  const defaultSchema = schemas[0]!
  const maxRows = config.maxRows ?? DEFAULT_MAX_ROWS
  const statementTimeoutDefault = config.statementTimeoutMs === undefined ? DEFAULT_STATEMENT_TIMEOUT_MS : config.statementTimeoutMs

  const namedClients = new Map<string, PgFluentClient<any>>()
  const getNamedClient = (name: string): PgFluentClient<any> | undefined => namedClients.get(name)

  const buildOne = (name: string, cfg: PgFluentConfig): PgFluentClient<any> => {
    const instrument = new Instrument({
      logger: cfg.logger,
      onQuery: cfg.onQuery,
      logParams: cfg.logParams,
      redactColumns: cfg.redactColumns,
      telemetry: cfg.telemetry,
    })

    // Idle pooled-client errors otherwise surface as uncaught 'error' events.
    const onIdleError = (err: unknown): void => {
      cfg.logger?.error?.('pg-fluent: pooled client errored', {
        code: (err as { code?: unknown } | null)?.code,
        message: String((err as { message?: unknown } | null)?.message ?? err),
      })
    }

    let bundle
    if (config.connections && config.connections[name]) {
      bundle = (function () {
        const c = config.connections![name]!
        if (isRouted(c)) {
          const routed = c as RoutedConnectionConfig
          const primary = buildPoolForSingle(routed.primary, statementTimeoutDefault, onIdleError)
          const replicas: Executor[] = []
          const ownedPoolsArr: pg.Pool[] = []
          for (const rep of routed.replicas ?? []) {
            const sp2 = buildPoolForSingle(rep, statementTimeoutDefault, onIdleError)
            replicas.push(new PgExecutor(sp2.pool))
            if (sp2.owned) ownedPoolsArr.push(sp2.pool)
          }
          const executor = new RoutingExecutor({ primary: new PgExecutor(primary.pool), replicas })
          // `ownedPools` holds only pools beyond the primary one; `close()` ends the primary
          // via `owned` and the rest via `ownedPools` (no double `end()`).
          return { executor, pool: primary.pool, owned: primary.owned, ownedPools: ownedPoolsArr }
        }
        const sp = buildPoolForSingle(c as SingleConnectionConfig, statementTimeoutDefault, onIdleError)
        return { executor: new PgExecutor(sp.pool), pool: sp.pool, owned: sp.owned, ownedPools: [] }
      })()
    } else {
      const base: SingleConnectionConfig = {
        connectionString: cfg.connectionString,
        host: cfg.host,
        port: cfg.port,
        database: cfg.database,
        user: cfg.user,
        password: cfg.password,
        ssl: cfg.ssl,
        pool: cfg.pool,
        statementTimeoutMs: cfg.statementTimeoutMs,
      }
      const sp = buildPoolForSingle(base, statementTimeoutDefault, onIdleError)
      bundle = { executor: new PgExecutor(sp.pool), pool: sp.pool, owned: sp.owned, ownedPools: [] }
    }

  return buildClient<Database>(bundle.executor, bundle.pool, bundle.owned, bundle.ownedPools, {
    schemas,
    defaultSchema,
    maxRows,
    allowUnfilteredMutations: cfg.allowUnfilteredMutations ?? false,
    retries: cfg.retries ?? DEFAULT_RETRIES,
    instrument,
    getNamedClient,
    listener: new ListenManager(bundle.pool.options),
  }) as unknown as PgFluentClient<any>
}

  const defaultName = config.defaultConnection && config.connections?.[config.defaultConnection] ? config.defaultConnection : (config.connections ? Object.keys(config.connections)[0] ?? 'default' : 'default')
  const defaultClient = buildOne(defaultName, config)
  namedClients.set(defaultName, defaultClient)
  if (config.connections) {
    for (const name of Object.keys(config.connections)) {
      if (!namedClients.has(name)) {
        namedClients.set(name, buildOne(name, config))
      }
    }
  }
  return defaultClient as unknown as PgFluentClient<Database>
}

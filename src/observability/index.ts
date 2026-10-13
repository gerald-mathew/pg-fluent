import type { QueryResult } from '../exec/executor.js'

export type QueryOperation = 'select' | 'insert' | 'update' | 'delete' | 'rpc' | 'exec'

/** Structured event passed to `onQuery`; never contains parameter values. */
export interface QueryEvent {
  operation: QueryOperation
  schema: string
  table: string
  durationMs: number
  rowCount: number | null
  error?: unknown
  connection: string
  route: 'primary' | 'replica'
  retried: boolean
  /** Present only when `logParams` is enabled. */
  params?: unknown[]
}

/** A `console`-compatible logger. */
export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void
  info(message: string, meta?: Record<string, unknown>): void
  warn(message: string, meta?: Record<string, unknown>): void
  error(message: string, meta?: Record<string, unknown>): void
}

export interface ObservabilityOptions {
  logger?: Logger
  onQuery?: (event: QueryEvent) => void
  logParams?: boolean
  telemetry?: boolean
  connection?: string
  route?: 'primary' | 'replica'
  /** Column names whose values are replaced with `[REDACTED]` when `logParams`. */
  redactColumns?: string[]
}

export interface QueryInfo {
  operation: QueryOperation
  schema: string
  table: string
  queryText: string
  params?: unknown[]
  /** Extract the logical row count from a result (defaults to `rowCount`). */
  count?: (result: QueryResult) => number | null
}

interface SpanLike {
  setAttribute(key: string, value: string | number): void
  setStatus(status: { code: number; message?: string }): void
  recordException(error: unknown): void
  end(): void
}

const OTEL_SPAN_STATUS_ERROR = 2

function redactParams(params: unknown, columns: string[] | undefined): unknown {
  if (!columns || columns.length === 0) return params
  const redact = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(redact)
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const [key, val] of Object.entries(value)) {
        out[key] = columns.includes(key) ? '[REDACTED]' : redact(val)
      }
      return out
    }
    return value
  }
  return redact(params)
}

/**
 * Per-query instrumentation: durations, `onQuery` events, optional debug
 * logging (values only with `logParams`), and an OpenTelemetry span when the
 * optional peer is installed and `telemetry` is enabled. Zero overhead when no
 * hooks are configured.
 */
export class Instrument {
  private readonly enabled: boolean
  private otel: unknown = undefined

  constructor(private readonly options: ObservabilityOptions = {}) {
    this.enabled = Boolean(options.logger || options.onQuery || options.telemetry)
  }

  async run<T extends QueryResult>(info: QueryInfo, fn: () => Promise<T>): Promise<T> {
    if (!this.enabled) return fn()
    const started = performance.now()
    const span = await this.startSpan(info)
    try {
      const result = await fn()
      const durationMs = performance.now() - started
      span?.end()
      const rowCount = info.count ? info.count(result) : result.rowCount
      this.emit(info, durationMs, rowCount, undefined, (result as { attempts?: number }).attempts ?? 1)
      return result
    } catch (err) {
      const durationMs = performance.now() - started
      if (span) {
        span.recordException(err)
        span.setStatus({ code: OTEL_SPAN_STATUS_ERROR, message: errorMessage(err) })
        span.end()
      }
      this.emit(info, durationMs, null, err, (err as { attempts?: number }).attempts ?? 1)
      throw err
    }
  }

  private emit(
    info: QueryInfo,
    durationMs: number,
    rowCount: number | null,
    error: unknown,
    attempts: number
  ): void {
    if (!this.options.logger && !this.options.onQuery) return
    const event: QueryEvent = {
      operation: info.operation,
      schema: info.schema,
      table: info.table,
      durationMs,
      rowCount,
      connection: this.options.connection ?? 'default',
      route: this.options.route ?? 'primary',
      retried: attempts > 1,
    }
    if (error !== undefined) event.error = error
    if (this.options.logParams && info.params) {
      event.params = redactParams(info.params, this.options.redactColumns) as unknown[]
    }
    this.options.onQuery?.(event)
    const logger = this.options.logger
    if (!logger) return
    const meta: Record<string, unknown> = {
      operation: info.operation,
      schema: info.schema,
      table: info.table,
      durationMs: Math.round(durationMs),
      rowCount,
      connection: this.options.connection ?? 'default',
      route: this.options.route ?? 'primary',
      retried: attempts > 1,
    }
    if (this.options.logParams) meta['params'] = event.params
    if (error !== undefined && error !== null) {
      logger.error(`pg-fluent ${info.operation} failed`, { ...meta, error: errorMessage(error) })
    } else {
      logger.debug(`pg-fluent ${info.operation}`, meta)
    }
  }

  private async startSpan(info: QueryInfo): Promise<SpanLike | undefined> {
    if (!this.options.telemetry) return undefined
    const otel = await this.loadOtel()
    if (!otel) return undefined
    const tracer = otel.trace.getTracer('pg-fluent')
    const span = tracer.startSpan(`pg-fluent ${info.operation} ${info.table}`)
    span.setAttribute('db.system', 'postgresql')
    span.setAttribute('db.operation.name', info.operation)
    span.setAttribute('db.namespace', info.schema)
    span.setAttribute('db.collection.name', info.table)
    if (this.options.logParams) span.setAttribute('db.query.text', info.queryText)
    return span
  }

  private async loadOtel(): Promise<OtelApi | null> {
    if (this.otel !== undefined) return this.otel as OtelApi | null
    const specifier = '@opentelemetry/api'
    try {
      this.otel = (await import(specifier)) as OtelApi
    } catch {
      this.otel = null
    }
    return this.otel as OtelApi | null
  }
}

interface OtelApi {
  trace: {
    getTracer(name: string): { startSpan(name: string): SpanLike }
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

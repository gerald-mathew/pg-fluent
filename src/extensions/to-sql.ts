import { PostgrestBuilder } from '@supabase/postgrest-js'
import type { PostgrestClientOptions } from '@supabase/postgrest-js'
import { PgFluentError } from '../errors/index.js'
import {
  ALLOW_UNFILTERED_HEADER,
  PLAN_HEADER,
  PLAN_SQL,
  PRIMARY_HEADER,
  STREAM_HEADER,
  TIMEOUT_HEADER,
} from './constants.js'

/** The rendered SQL returned by `.toSQL()`. */
export interface SqlPlan {
  text: string
  values: unknown[]
}

/** Row type streamed by `.stream()`. */
export type StreamRow = Record<string, unknown>

/** Result shape when `.stream()` result is awaited to completion. */
export interface StreamResult<Row = StreamRow> {
  data: Row[]
  error: unknown | null
  count: number | null
  status: number
  statusText: string
}

/**
 * The object returned by `.stream()`: an async iterable of rows driven by a
 * server-side cursor. It is also thenable, so `const { data, error } = await
 * query.stream()` collects all rows into `data`.
 */
export interface PgFluentStream<Row = StreamRow>
  extends AsyncIterable<Row>,
    PromiseLike<StreamResult<Row>> {}

/** Runtime view of the protected fields of `PostgrestBuilder`. */
interface InternalBuilder {
  method: string
  url: URL
  headers: Headers
  schema?: string
  body?: unknown
  signal?: AbortSignal
  fetch: typeof fetch
  __executor?: any
}

async function streamErrorFromResponse(res: Response): Promise<unknown> {
  let text: string
  try {
    text = await res.text()
  } catch {
    text = ''
  }
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    payload = null
  }
  if (payload !== null && typeof payload === 'object') {
    const p = payload as { message?: unknown; details?: unknown; hint?: unknown; code?: unknown }
    const err: Record<string, unknown> = {
      status: res.status,
      statusText: res.statusText,
    }
    if (typeof p.message === 'string') err.message = p.message
    if (typeof p.details === 'string') err.details = p.details
    if (typeof p.hint === 'string') err.hint = p.hint
    if (typeof p.code === 'string') err.code = p.code
    return err
  }
  return {
    status: res.status,
    statusText: res.statusText,
    message: `Streaming request failed (HTTP ${res.status})`,
    details: '',
    hint: '',
    code: '',
  }
}

async function bodyLines(res: Response): Promise<AsyncGenerator<string, void, unknown>> {
  if (res.body === null) {
    return (async function* empty() {})()
  }
  const reader = res.body as ReadableStream<Uint8Array>
  const stream = reader[Symbol.asyncIterator]
    ? (reader as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]()
    : (reader as any).getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  async function* lines(): AsyncGenerator<string, void, unknown> {
    for (;;) {
      const chunk = await readChunk(stream)
      if (chunk === null) break
      buffer += decoder.decode(chunk, { stream: true })
      let idx
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        if (line !== '') yield line
      }
    }
    const tail = buffer.trim()
    if (tail !== '') yield tail
  }
  return lines()
}

async function readChunk(stream: AsyncIterator<Uint8Array> | any): Promise<Uint8Array | null> {
  const next = await stream.next()
  if (next.done) return null
  return next.value as Uint8Array
}

function createStream(state: InternalBuilder): PgFluentStream {
  const headers: Record<string, string> = {}
  state.headers.forEach((value, key) => {
    headers[key] = value
  })
  if (state.schema !== undefined) {
    if (state.method === 'GET' || state.method === 'HEAD') headers['Accept-Profile'] = state.schema
    else headers['Content-Profile'] = state.schema
  }
  if (state.method !== 'GET' && state.method !== 'HEAD') headers['Content-Type'] = 'application/json'
  headers[STREAM_HEADER] = '1'

  const body =
    state.body === undefined
      ? undefined
      : JSON.stringify(state.body, (_key, value) =>
          typeof value === 'bigint' ? value.toString() : value
        )

  const send = (): Promise<Response> =>
    state.fetch(state.url.toString(), {
      method: state.method,
      headers,
      body,
      signal: state.signal,
    })

  const rows = async function* rows(): AsyncGenerator<StreamRow, void, unknown> {
    const res = await send()
    if (!res.ok) throw await streamErrorFromResponse(res)
    const lines = await bodyLines(res)
    for await (const line of lines) {
      yield JSON.parse(line) as StreamRow
    }
  }

  const stream: PgFluentStream = {
    [Symbol.asyncIterator]() {
      return rows()[Symbol.asyncIterator]()
    },
    then<TResult1 = StreamResult, TResult2 = never>(
      onfulfilled?:
        | ((value: StreamResult<StreamRow>) => TResult1 | PromiseLike<TResult1>)
        | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
    ): Promise<TResult1 | TResult2> {
      const collect = async (): Promise<StreamResult<StreamRow>> => {
        try {
          const all: StreamRow[] = []
          for await (const row of rows()) all.push(row)
          return { data: all, error: null, count: all.length, status: 200, statusText: 'OK' }
        } catch (error) {
          const e = error as { status?: number; statusText?: string } & StreamResult<StreamRow>['error']
          return {
            data: [],
            error: e,
            count: null,
            status: e && typeof e.status === 'number' ? e.status : 0,
            statusText: e && typeof e.statusText === 'string' ? e.statusText : '',
          }
        }
      }
      return collect().then(onfulfilled, onrejected)
    },
  }
  return stream
}

interface PlanErrorBody {
  code?: unknown
  details?: unknown
  hint?: unknown
  message?: unknown
}

function planErrorBody(payload: PlanErrorBody | null, status: number): Error & {
  code?: unknown
  details?: unknown
  hint?: unknown
  status?: number
} {
  const message = typeof payload?.message === 'string' ? payload.message : 'Failed to render SQL'
  const error = new Error(message) as Error & {
    code?: unknown
    details?: unknown
    hint?: unknown
    status?: number
  }
  if (typeof payload?.code === 'string') error.code = payload.code
  if (typeof payload?.details === 'string') error.details = payload.details
  if (typeof payload?.hint === 'string') error.hint = payload.hint
  error.status = status
  return error
}

async function toSQL(this: InternalBuilder): Promise<SqlPlan> {
  const headers: Record<string, string> = {}
  this.headers.forEach((value, key) => {
    headers[key] = value
  })
  if (this.schema !== undefined) {
    if (this.method === 'GET' || this.method === 'HEAD') headers['Accept-Profile'] = this.schema
    else headers['Content-Profile'] = this.schema
  }
  if (this.method !== 'GET' && this.method !== 'HEAD') headers['Content-Type'] = 'application/json'
  headers[PLAN_HEADER] = PLAN_SQL

  const body =
    this.body === undefined
      ? undefined
      : JSON.stringify(this.body, (_key, value) =>
          typeof value === 'bigint' ? value.toString() : value
        )

  const response = await this.fetch(this.url.toString(), {
    method: this.method,
    headers,
    body,
    signal: this.signal,
  })

  const payload = (await response.json().catch(() => null)) as
    | ({ text?: unknown; values?: unknown } & PlanErrorBody)
    | null

  if (!response.ok) throw planErrorBody(payload, response.status)
  if (payload === null || typeof payload.text !== 'string') {
    throw new PgFluentError('PGFLUENT_INTERNAL', 'Adapter returned an invalid plan response')
  }
  return { text: payload.text, values: Array.isArray(payload.values) ? payload.values : [] }
}

interface ExtensionProto {
  toSQL?: () => Promise<SqlPlan>
  allowUnfiltered?: () => unknown
  timeout?: (ms: number) => unknown
  primary?: () => unknown
  stream?: () => unknown
}

let installed = false

/** Attach pg-fluent extension methods to the upstream builder prototypes (idempotent). */
export function installExtensions(): void {
  if (installed) return
  installed = true
  const proto = PostgrestBuilder.prototype as unknown as ExtensionProto
  proto.toSQL = function (this: InternalBuilder): Promise<SqlPlan> {
    return toSQL.call(this)
  }
  proto.allowUnfiltered = function (this: InternalBuilder): unknown {
    this.headers.set(ALLOW_UNFILTERED_HEADER, '1')
    return this
  }
  proto.timeout = function (this: InternalBuilder, ms: number): unknown {
    if (!Number.isInteger(ms) || ms <= 0) {
      throw new PgFluentError(
        'PGFLUENT_INVALID_QUERY',
        `Timeout must be a positive integer number of milliseconds, received ${String(ms)}`
      )
    }
    this.headers.set(TIMEOUT_HEADER, String(ms))
    return this
  }
  proto.primary = function (this: InternalBuilder): unknown {
    this.headers.set(PRIMARY_HEADER, '1')
    return this
  }
  proto.stream = function (this: InternalBuilder): PgFluentStream {
    return createStream(this)
  }
}

declare module '@supabase/postgrest-js' {
  interface PostgrestBuilder<
    ClientOptions extends PostgrestClientOptions,
    Result$1,
    ThrowOnError extends boolean = false,
  > {
    /**
     * Render this request to `{ text, values }` without executing it.
     *
     * Values are returned as-is; callers decide whether to log them.
     */
    toSQL(): Promise<SqlPlan>

    /**
     * Permit this mutation to run without a filter, overriding the client's
     * `allowUnfilteredMutations` setting for this request only.
     */
    allowUnfiltered(): this

    /**
     * Set the `statement_timeout` (in milliseconds) for this request. The
     * request fails with `PGFLUENT_TIMEOUT` when the statement is cancelled.
     */
    timeout(ms: number): this

    /**
     * Force this read to execute against the primary instance (skip replicas).
     */
    primary(): this

    /**
     * Stream rows from this query using a server-side cursor. The result is an
     * async iterable of row objects; awaiting it resolves once all rows have
     * been collected.
     */
    stream(): PgFluentStream<Record<string, unknown>>
  }
}

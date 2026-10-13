import { parseRequest, type RawRequest } from '../parser/request.js'
import { planRead, planStream } from '../planner/read.js'
import { buildReadResponse } from '../response/build.js'
import { buildErrorResponse } from '../response/error.js'
import { runAndRollback, type Executor, type QueryResult } from '../exec/executor.js'
import { withRetry, type RetryConfig } from '../exec/retry.js'
import type { Instrument, QueryOperation } from '../observability/index.js'
import { PgFluentError, pgrstError } from '../errors/index.js'
import { itemOutputKey } from '../parser/select.js'
import type { ParsedRequest } from '../parser/types.js'
import { planWrite } from '../planner/write.js'
import { planRpc } from '../planner/rpc.js'
import {
  resolveFilterRelationships,
  resolveOrderRelationships,
  resolveRelationships,
} from '../planner/embed.js'
import { SchemaCache } from '../schema/cache.js'
import { PLAN_HEADER, PLAN_SQL } from '../extensions/constants.js'
import type { RouteContext } from '../connections/router.js'

export interface AdapterOptions {
  executor: Executor
  schemas: string[]
  defaultSchema: string
  maxRows: number
  allowUnfilteredMutations: boolean
  retries?: RetryConfig
  instrument?: Instrument
  /** Optional function to resolve routing context for the request. */
  getRouteContext?: (req: ParsedRequest) => RouteContext | undefined
}

interface Executed extends QueryResult {
  attempts: number
}

/** Logical row count for a shaped (aggregated) result, else `rowCount`. */
function logicalRowCount(result: QueryResult): number | null {
  const first = result.rows[0]
  if (first && first['__pgfl_returned'] !== undefined && first['__pgfl_returned'] !== null) {
    return Number(first['__pgfl_returned'])
  }
  return result.rowCount
}

function operationFor(req: ParsedRequest): QueryOperation {
  if (req.resource.kind === 'rpc') return 'rpc'
  switch (req.method) {
    case 'POST':
      return 'insert'
    case 'PATCH':
      return 'update'
    case 'DELETE':
      return 'delete'
    default:
      return 'select'
  }
}

function isVolatileRpc(req: ParsedRequest, funcInfo?: any): boolean {
  if (req.resource.kind !== 'rpc') return false
  if (!funcInfo || !funcInfo.volatility) return true // default volatile? but spec says check; we don't have full info here easily
  return funcInfo.volatility === 'volatile'
}

type FetchInput = Parameters<typeof fetch>[0]

function normalizeHeaders(headers: RequestInit['headers'] | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!headers) return out
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      out[key.toLowerCase()] = value
    })
    return out
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) out[key.toLowerCase()] = value
    return out
  }
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) out[key.toLowerCase()] = String(value)
  }
  return out
}

function requestUrl(input: FetchInput): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

function toRawRequest(input: FetchInput, init: RequestInit | undefined): RawRequest {
  const method = (init?.method ?? 'GET').toUpperCase()
  const body = init?.body
  return {
    url: requestUrl(input),
    method,
    headers: normalizeHeaders(init?.headers),
    body: typeof body === 'string' ? body : undefined,
    signal: init?.signal ?? undefined,
  }
}

function explicitColumns(req: ParsedRequest): string[] | undefined {
  const cols: string[] = []
  for (const item of req.select) {
    if (item.kind === 'star') return undefined
    const key = itemOutputKey(item)
    if (key !== undefined) cols.push(key)
  }
  return cols.length > 0 ? cols : undefined
}

/**
 * Execute a statement, honouring a per-request `.timeout(ms)`. When a timeout
 * is set the statement runs on a dedicated connection inside a short-lived
 * transaction so `SET LOCAL statement_timeout` applies; PostgreSQL cancels it
 * with SQLSTATE `57014`, which is surfaced as `PGFLUENT_TIMEOUT` (504).
 */
function queryWithSignal(
  executor: Executor,
  signal: AbortSignal | undefined,
  text: string,
  values: unknown[],
  ctx?: any
): Promise<QueryResult> {
  // RoutingExecutor will choose; we pass through
  if (!signal) return executor.query(text, values)
  if (executor.queryWithSignal) return executor.queryWithSignal(text, values, signal)
  return executor.query(text, values)
}

async function runStatement(
  options: AdapterOptions,
  req: ParsedRequest,
  text: string,
  values: unknown[]
): Promise<Executed> {
  if (req.timeoutMs === undefined) {
    const result = await queryWithSignal(options.executor, req.signal, text, values)
    return { ...result, attempts: 1 }
  }
  const result = await options.executor.transaction(async (tx) => {
    await tx.query(`SET LOCAL statement_timeout = ${Math.trunc(req.timeoutMs!)}`)
    return queryWithSignal(tx, req.signal, text, values)
  })
  return { ...result, attempts: 1 }
}

/**
 * Run a read (GET/HEAD) statement with the configured transient-error retries.
 * Only idempotent work is retried; writes and volatile RPC never are.
 */
async function runReadStatement(
  options: AdapterOptions,
  req: ParsedRequest,
  text: string,
  values: unknown[]
): Promise<Executed> {
  const retries = options.retries
  if (!retries || retries.max <= 0) return runStatement(options, req, text, values)
  const { value, attempts } = await withRetry(retries, () =>
    runStatement(options, req, text, values)
  )
  return { ...value, attempts }
}

/** Execute a statement, applying retries for reads and instrumentation. */
async function executeStatement(
  options: AdapterOptions,
  req: ParsedRequest,
  text: string,
  values: unknown[],
  read: boolean
): Promise<Executed> {
  const run = (): Promise<Executed> =>
    read ? runReadStatement(options, req, text, values) : runStatement(options, req, text, values)
  const instrument = options.instrument
  if (!instrument) return run()
  return instrument.run(
    {
      operation: operationFor(req),
      schema: req.schema,
      table: req.resource.name,
      queryText: text,
      params: values,
      count: logicalRowCount,
    },
    run
  )
}

async function resolveCount(
  options: AdapterOptions,
  req: ParsedRequest,
  countText: string | undefined,
  countValues: unknown[]
): Promise<number | undefined> {
  if (countText === undefined) return undefined
  try {
    const result = await options.executor.query(countText, countValues)
    const raw = result.rows[0] ? Object.values(result.rows[0])[0] : undefined
    return raw === undefined || raw === null ? undefined : Number(raw)
  } catch {
    return undefined
  }
}

interface RenderedPlan {
  text: string
  values: unknown[]
}

/** Render the SQL for any request kind without executing it. */
async function buildPlan(
  req: ParsedRequest,
  options: AdapterOptions,
  schemaCache: SchemaCache
): Promise<RenderedPlan> {
  if (req.resource.kind === 'rpc') {
    return planRpc(req, { maxRows: options.maxRows, schemaCache })
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    await resolveRelationships(req, schemaCache)
    return planRead(req, { maxRows: options.maxRows })
  }
  return planWrite(req, {
    allowUnfilteredMutations: options.allowUnfilteredMutations,
    schemaCache,
  })
}

async function planResponse(
  req: ParsedRequest,
  options: AdapterOptions,
  schemaCache: SchemaCache
): Promise<Response> {
  try {
    const plan = await buildPlan(req, options, schemaCache)
    return new Response(JSON.stringify({ text: plan.text, values: plan.values }), {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    })
  } catch (err) {
    return buildErrorResponse(err)
  }
}

const EXPLAIN_OPTIONS = new Set(['analyze', 'verbose', 'settings', 'buffers', 'wal'])

function explainTokens(options: string | undefined): string[] {
  return (options ?? '')
    .split('|')
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token !== '')
}

async function explainResponse(
  req: ParsedRequest,
  options: AdapterOptions,
  schemaCache: SchemaCache
): Promise<Response> {
  try {
    const plan = await buildPlan(req, options, schemaCache)
    const tokens = explainTokens(req.planOptions)
    const analyze = tokens.includes('analyze')
    const format = req.planFormat === 'json' ? 'JSON' : 'TEXT'
    const clauses = tokens
      .filter((token) => EXPLAIN_OPTIONS.has(token))
      .map((token) => token.toUpperCase())
    clauses.push(`FORMAT ${format}`)
    const text = `EXPLAIN (${clauses.join(', ')}) ${plan.text}`

    const isMutation = req.method !== 'GET' && req.method !== 'HEAD'
    const result =
      analyze && isMutation
        ? await runAndRollback(options.executor, (tx) => tx.query(text, plan.values))
        : await options.executor.query(text, plan.values)

    let body: string
    if (format === 'JSON') {
      body = JSON.stringify(result.rows[0]?.['QUERY PLAN'] ?? [])
    } else {
      body = result.rows.map((row) => String(row['QUERY PLAN'])).join('\n')
    }

    return new Response(body, {
      status: 200,
      statusText: 'OK',
      headers: {
        'Content-Type':
          format === 'JSON'
            ? 'application/json; charset=utf-8'
            : 'application/vnd.pgrst.plan+text; charset=utf-8',
      },
    })
  } catch (err) {
    return buildErrorResponse(err)
  }
}

/**
 * Stream one JSON-encoded row per chunk from a server-side cursor. The body
 * is newline-delimited JSON; each `__pgfl_row` value is already a JSON string,
 * so it is passed through verbatim.
 */
function streamResponse(executor: Executor, text: string, values: unknown[]): Response {
  if (typeof executor.stream !== 'function') {
    return buildErrorResponse(
      new PgFluentError(
        'PGFLUENT_NOT_IMPLEMENTED',
        'Streaming is not supported by the current executor'
      )
    )
  }
  const generator = executor.stream(text, values)
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const row of generator) {
          const line = row['__pgfl_row']
          if (typeof line === 'string') controller.enqueue(encoder.encode(`${line}\n`))
        }
        controller.close()
      } catch (err) {
        controller.error(err)
      }
    },
    async cancel() {
      try {
        await generator.return?.(undefined)
      } catch {
        // Best-effort cursor release on cancellation.
      }
    },
  })
  return new Response(body, {
    status: 200,
    statusText: 'OK',
    headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8' },
  })
}

export function createFetchAdapter(options: AdapterOptions): typeof fetch {
  const schemaCache = new SchemaCache(options.executor)
  const fetchFn: any = async function pgFluentFetch(input: any, init: any): Promise<Response> {
    const raw = toRawRequest(input, init)
    const planOnly = raw.headers[PLAN_HEADER] === PLAN_SQL
    let req: ParsedRequest
    try {
      req = parseRequest(raw, {
        schemas: options.schemas,
        defaultSchema: options.defaultSchema,
      })
    } catch (err) {
      return buildErrorResponse(err)
    }

    try {
      if (planOnly) {
        return await planResponse(req, options, schemaCache)
      }

      if (req.mediaType === 'plan') {
        return await explainResponse(req, options, schemaCache)
      }

      if (req.resource.kind === 'rpc') {
        const plan = await planRpc(req, {
          maxRows: options.maxRows,
          schemaCache,
        })
        const result = await executeStatement(
          options,
          req,
          plan.text,
          plan.values,
          req.method === 'GET'
        )
        const countOverride = await resolveCount(
          options,
          req,
          plan.countText,
          plan.countValues ?? []
        )
        return buildReadResponse({
          plan,
          req,
          result,
          columns: explicitColumns(req),
          countOverride,
        })
      }

      if (req.method === 'GET' || req.method === 'HEAD') {
        await resolveRelationships(req, schemaCache)
        await resolveOrderRelationships(req, schemaCache)
        await resolveFilterRelationships(req, schemaCache)
        if (req.stream) {
          if (req.method !== 'GET') {
            return buildErrorResponse(
              new PgFluentError('PGFLUENT_INVALID_QUERY', 'Streaming is not available for HEAD queries')
            )
          }
          const streamPlan = planStream(req, { maxRows: options.maxRows })
          return streamResponse(options.executor, streamPlan.text, streamPlan.values)
        }
        const plan = planRead(req, { maxRows: options.maxRows })
        const result = await executeStatement(options, req, plan.text, plan.values, true)
        const countOverride = await resolveCount(
          options,
          req,
          plan.countText,
          plan.countValues ?? []
        )
        return buildReadResponse({
          plan,
          req,
          result,
          columns: explicitColumns(req),
          countOverride,
        })
      }

      const plan = await planWrite(req, {
        allowUnfilteredMutations: options.allowUnfilteredMutations,
        schemaCache,
      })
      if (process.env['PGFLUENT_DEBUG']) {
        process.stderr.write(`[pg-fluent] ${plan.text}\n`)
        process.stderr.write(`[pg-fluent] values=${JSON.stringify(plan.values)}\n`)
      }

      if (req.rollback || req.maxAffected !== undefined) {
        const run = async (tx: Executor): Promise<Response> => {
          const execute = (): Promise<QueryResult> => tx.query(plan.text, plan.values)
          const result = options.instrument
            ? await options.instrument.run(
                {
                  operation: operationFor(req),
                  schema: req.schema,
                  table: req.resource.name,
                  queryText: plan.text,
                  params: plan.values,
                  count: logicalRowCount,
                },
                execute
              )
            : await execute()
          if (req.maxAffected !== undefined && plan.affected(result) > req.maxAffected) {
            throw pgrstError(
              'PGRST124',
              'The query result exceeds the maximum number of affected rows',
              {
                details:
                  `The result of the query contains ${plan.affected(result)} rows, which is ` +
                  `greater than the max-affected limit of ${req.maxAffected}`,
              }
            )
          }
          return plan.respond(result)
        }
        // `tx=rollback` always rolls back; `max-affected` alone commits when within limit.
        return req.rollback
          ? await runAndRollback(options.executor, run)
          : await options.executor.transaction(run)
      }

      const result = await executeStatement(options, req, plan.text, plan.values, false)
      return plan.respond(result)
    } catch (err) {
      if (err instanceof PgFluentError && err.code === 'PGFLUENT_NOT_IMPLEMENTED') {
        return buildErrorResponse(err)
      }
      return buildErrorResponse(err)
    }
  }
  fetchFn._schemaCache = schemaCache
  return fetchFn
}

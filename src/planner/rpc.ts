import { PgFluentError, PostgrestRequestError } from '../errors/index.js'
import { looksLikeFilterValue, parseFilters } from '../parser/filter.js'
import type { ParsedRequest } from '../parser/types.js'
import type { FunctionInfo, SchemaCache } from '../schema/cache.js'
import { quoteIdent, quoteQualified } from '../sql/quote.js'
import { planSelectCore, type ReadPlan } from './read.js'

export interface RpcOptions {
  maxRows: number
  schemaCache: SchemaCache
}

const RESERVED = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'columns'])

interface CallArg {
  name?: string
  value: unknown
  /** Cast to apply to the bound parameter (e.g. `jsonb`), or `null`. */
  cast: string | null
}

/** JSON/JSONB arguments must be sent as JSON text, not a Postgres array literal. */
function jsonCast(type: string): string | null {
  const normalized = type.trim().toLowerCase()
  return normalized === 'json' || normalized === 'jsonb' ? normalized : null
}

function argNameSet(fn: FunctionInfo): Set<string> {
  return new Set(fn.args.map((a) => a.name).filter((n): n is string => Boolean(n)))
}

function requiredArgNames(fn: FunctionInfo): string[] {
  return fn.args.filter((a) => a.name && !a.hasDefault).map((a) => a.name!)
}

function signature(fn: FunctionInfo): string {
  return fn.args.map((a) => `${a.name ?? '?'} ${a.type}`).join(', ')
}

function notFound(schema: string, name: string, provided: string[]): never {
  throw new PostgrestRequestError(
    'PGRST202',
    `Could not find the function ${schema}.${name}(${provided.join(', ')}) in the schema cache`
  )
}

function ambiguous(schema: string, name: string, overloads: FunctionInfo[]): never {
  const candidates = overloads.map((o) => `${name}(${signature(o)})`).join(', ')
  throw new PostgrestRequestError(
    'PGRST203',
    `Could not choose the best candidate function between: ${candidates}`,
    { details: `Schema: ${schema}` }
  )
}

/** Choose the overload that accepts exactly the provided argument names. */
function pickOverload(
  schema: string,
  name: string,
  overloads: FunctionInfo[],
  provided: string[]
): FunctionInfo {
  const matches = overloads.filter((fn) => {
    const names = argNameSet(fn)
    if (!provided.every((n) => names.has(n))) return false
    return requiredArgNames(fn).every((n) => provided.includes(n))
  })
  if (matches.length === 0) throw notFound(schema, name, provided)
  if (matches.length === 1) return matches[0]!
  const exact = matches.filter((fn) => {
    const names = argNameSet(fn)
    return names.size === provided.length && provided.every((n) => names.has(n))
  })
  if (exact.length === 1) return exact[0]!
  throw ambiguous(schema, name, exact.length ? exact : matches)
}

function buildNamedArgs(fn: FunctionInfo, provided: Map<string, unknown>): CallArg[] {
  const args: CallArg[] = []
  for (const arg of fn.args) {
    if (arg.name === undefined) {
      if (!arg.hasDefault) {
        throw new PgFluentError(
          'PGFLUENT_INVALID_QUERY',
          'Cannot call a function with unnamed arguments by name'
        )
      }
      continue
    }
    if (provided.has(arg.name)) {
      args.push({ name: arg.name, value: provided.get(arg.name), cast: jsonCast(arg.type) })
    } else if (!arg.hasDefault) throw notFound(fn.schema, fn.name, [...provided.keys()])
  }
  return args
}

function buildPositionalArgs(fn: FunctionInfo, body: unknown[]): CallArg[] {
  return fn.args.map((arg, i) => ({ name: arg.name, value: body[i], cast: jsonCast(arg.type) }))
}

function renderCall(
  schema: string,
  name: string,
  args: CallArg[]
): { fromExpr: string; values: unknown[] } {
  const clause = args
    .map((arg, i) => {
      const placeholder = `$${i + 1}${arg.cast ? `::${arg.cast}` : ''}`
      return arg.name !== undefined ? `${quoteIdent(arg.name)} := ${placeholder}` : placeholder
    })
    .join(', ')
  return {
    fromExpr: `${quoteQualified(schema, name)}(${clause})`,
    values: args.map((a) => (a.cast && typeof a.value !== 'string' ? JSON.stringify(a.value) : a.value)),
  }
}

function planScalar(fn: FunctionInfo, fromExpr: string, values: unknown[]): ReadPlan {
  if (fn.returnsSet) {
    const text =
      `SELECT COALESCE(array_to_json(array_agg("pgfl_scalar"."v")), '[]')::text AS "__pgfl_body",\n` +
      `  count(*)::int AS "__pgfl_returned"\n` +
      `FROM (SELECT ${fromExpr} AS "v") AS "pgfl_scalar"`
    return { text, values, aggregate: false, effectiveOffset: 0 }
  }
  const text = `SELECT to_json(${fromExpr})::text AS "__pgfl_body",\n  1 AS "__pgfl_returned"`
  return { text, values, aggregate: false, effectiveOffset: 0 }
}

function applyFilters(req: ParsedRequest, entries: Array<[string, string]>): ParsedRequest {
  if (entries.length === 0) return { ...req, filters: [] }
  const parsed = parseFilters(new URLSearchParams(entries))
  if (parsed.embedded.length > 0) {
    throw new PgFluentError(
      'PGFLUENT_NOT_IMPLEMENTED',
      'Embedded RPC result filters are not supported yet',
      { details: parsed.embedded.map((e) => e.key).join(', ') }
    )
  }
  return { ...req, filters: parsed.filters }
}

function finish(
  req: ParsedRequest,
  fn: FunctionInfo,
  fromExpr: string,
  values: unknown[],
  maxRows: number
): ReadPlan {
  if (!fn.returnsRows) return planScalar(fn, fromExpr, values)
  const effective = fn.returnsSet ? req : { ...req, single: true }
  return planSelectCore(effective, { maxRows }, fromExpr, values)
}

/** Plan an RPC call (`POST|GET|HEAD /rpc/{fn}`) against the schema cache. */
export async function planRpc(req: ParsedRequest, options: RpcOptions): Promise<ReadPlan> {
  if (req.resource.kind !== 'rpc') {
    throw new PgFluentError('PGFLUENT_INVALID_QUERY', 'RPC requires a function resource')
  }
  const schema = req.schema
  const name = req.resource.name
  const overloads = await options.schemaCache.getFunction(schema, name)
  if (overloads.length === 0) throw notFound(schema, name, [])

  let fn: FunctionInfo
  let args: CallArg[]
  let filterEntries: Array<[string, string]>

  if (req.method === 'POST') {
    const body = req.body
    filterEntries = req.query ?? []
    if (Array.isArray(body)) {
      const byArity = overloads.filter((f) => f.args.length === body.length)
      if (byArity.length === 0) throw notFound(schema, name, [])
      fn = byArity.length === 1 ? byArity[0]! : ambiguous(schema, name, byArity)
      args = buildPositionalArgs(fn, body)
    } else if (body !== undefined && body !== null && typeof body === 'object') {
      const obj = body as Record<string, unknown>
      const provided = Object.keys(obj)
      if (overloads.length === 1) {
        const only = overloads[0]!
        const named = only.args.filter((a) => a.name !== undefined)
        if (
          only.args.length === 1 &&
          named.length === 1 &&
          /json/i.test(named[0]!.type) &&
          !provided.includes(named[0]!.name!)
        ) {
          const { fromExpr, values } = renderCall(only.schema, only.name, [
            { name: named[0]!.name, value: obj, cast: jsonCast(named[0]!.type) },
          ])
          return finish(applyFilters(req, filterEntries), only, fromExpr, values, options.maxRows)
        }
      }
      fn = pickOverload(schema, name, overloads, provided)
      args = buildNamedArgs(fn, new Map(Object.entries(obj)))
    } else {
      fn = pickOverload(schema, name, overloads, [])
      args = buildNamedArgs(fn, new Map())
    }
  } else {
    const argEntries: Array<[string, string]> = []
    const rest: Array<[string, string]> = []
    for (const [key, value] of req.query ?? []) {
      if (RESERVED.has(key)) continue
      if (looksLikeFilterValue(value)) rest.push([key, value])
      else argEntries.push([key, value])
    }
    fn = pickOverload(schema, name, overloads, argEntries.map(([k]) => k))
    args = buildNamedArgs(fn, new Map(argEntries))
    filterEntries = rest
  }

  const { fromExpr, values } = renderCall(fn.schema, fn.name, args)
  return finish(applyFilters(req, filterEntries), fn, fromExpr, values, options.maxRows)
}

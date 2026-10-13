import { PgFluentError } from '../errors/index.js'
import type { OrderTerm, ParsedRequest, ResolvedRelationship } from '../parser/types.js'
import { ParamBag, formatSelectExpr } from '../sql/builder.js'
import { quoteIdent, quoteQualified } from '../sql/quote.js'
import { buildLevelProjection, collectInnerConditions, type BuildContext } from './embed.js'
import { renderWhere } from './where.js'

const SRC = '"pgfl_src"'
const BASE = '"pgfl_base"'
const SUB = '"pgfl_sub"'

export interface ReadPlan {
  text: string
  values: unknown[]
  aggregate: boolean
  effectiveOffset: number
  effectiveLimit?: number
  count?: 'exact' | 'planned' | 'estimated'
  countText?: string
  countValues?: unknown[]
}

export interface ReadOptions {
  maxRows: number
}

function notImplemented(message: string): PgFluentError {
  return new PgFluentError('PGFLUENT_NOT_IMPLEMENTED', message)
}

function invalid(message: string): PgFluentError {
  return new PgFluentError('PGFLUENT_INVALID_QUERY', message)
}

/** Everything needed to render the inner (per-row) SELECT for a read. */
interface ReadInner {
  bag: ParamBag
  cteWhere: string
  selectParts: string[]
  groupParts: string[]
  orderParts: string[]
  joins: string
  effectiveLimit?: number
  effectiveOffset: number
  aggregate: boolean
}

/** Render the `LEFT JOIN` chain for a related-table ordering path. */
function renderOrderJoins(
  chain: ResolvedRelationship[],
  counter: { n: number }
): { joins: string; lastAlias: string } {
  let prev = BASE
  let joins = ''
  for (const rel of chain) {
    const alias = quoteIdent(`pgfl_or${++counter.n}`)
    const conds: string[] = []
    for (let i = 0; i < rel.baseColumns.length; i++) {
      conds.push(
        `${prev}.${quoteIdent(rel.baseColumns[i]!)} = ${alias}.${quoteIdent(rel.relationColumns[i]!)}`
      )
    }
    joins += `\n    LEFT JOIN ${quoteQualified(rel.table.schema, rel.table.name)} AS ${alias} ON ${conds.join(' AND ')}`
    prev = alias
  }
  return { joins, lastAlias: prev }
}

function renderRelatedOrder(
  term: OrderTerm,
  prev: string,
  bag: ParamBag
): string {
  const col = formatSelectExpr(prev, term.column.base, term.column.steps, undefined, bag)
  let sql = `${col} ${term.ascending ? 'ASC' : 'DESC'}`
  if (term.nullsFirst === true) sql += ' NULLS FIRST'
  else if (term.nullsFirst === false) sql += ' NULLS LAST'
  return sql
}

/**
 * Build the shared inner SELECT (column expressions, WHERE, ORDER BY, LIMIT)
 * for both aggregated reads and streaming reads.
 */
function buildInner(
  req: ParsedRequest,
  fromExpr: string,
  options: ReadOptions,
  preValues: unknown[] | undefined
): ReadInner {
  const bag = new ParamBag()
  if (preValues) for (const value of preValues) bag.add(value)
  const ctx: BuildContext = { req, bag, maxRows: options.maxRows, counter: { n: 0 }, path: [] }

  const where = renderWhere(req.filters, bag, SRC, {
    baseAlias: SRC,
    resolveRel: (relation) => req.filterRelationships?.get(relation),
  })
  const innerConds = collectInnerConditions(req.select, SRC, ctx)
  const cteWhere = innerConds.length > 0 ? `${where} AND ${innerConds.join(' AND ')}` : where

  const selectParts = buildLevelProjection(req.select, BASE, ctx)
  const aggregates = req.select.filter((i) => i.kind === 'aggregate')
  const hasStar = req.select.some((i) => i.kind === 'star')
  if (aggregates.length > 0 && hasStar) {
    throw notImplemented('Aggregates combined with "*" are not supported yet')
  }
  const groupParts = aggregates.length
    ? req.select
        .filter((i) => i.kind === 'column')
        .map((i) =>
          i.kind === 'column'
            ? formatSelectExpr(BASE, i.path.base, i.path.steps, undefined, bag)
            : ''
        )
        .filter((s) => s !== '')
    : []

  const joinedPaths = new Map<string, { joins: string; lastAlias: string }>()
  const orderParts = req.order.map((term) => {
    if (!term.relation) {
      const col = formatSelectExpr(BASE, term.column.base, term.column.steps, undefined, bag)
      let sql = `${col} ${term.ascending ? 'ASC' : 'DESC'}`
      if (term.nullsFirst === true) sql += ' NULLS FIRST'
      else if (term.nullsFirst === false) sql += ' NULLS LAST'
      return sql
    }
    const key = term.relation.join('.')
    let entry = joinedPaths.get(key)
    if (!entry) {
      const chain = req.orderRelationships?.get(key)
      if (!chain) {
        throw invalid(
          `Could not resolve related-order path '${key}'; the relation must be a to-one embedded relationship`
        )
      }
      entry = renderOrderJoins(chain, ctx.counter)
      joinedPaths.set(key, entry)
    }
    return renderRelatedOrder(term, entry.lastAlias, bag)
  })
  let joins = ''
  for (const { joins: j } of joinedPaths.values()) joins += j

  const requestedLimit = req.limit
  const effectiveLimit =
    options.maxRows === Infinity
      ? requestedLimit ?? undefined
      : requestedLimit === undefined
        ? options.maxRows
        : Math.min(requestedLimit, options.maxRows)
  const effectiveOffset = req.offset ?? 0

  return {
    bag,
    cteWhere,
    selectParts,
    groupParts,
    orderParts,
    joins,
    effectiveLimit,
    effectiveOffset,
    aggregate: aggregates.length > 0,
  }
}

/** Build the SQL for a `SELECT` (or `HEAD`) request over a table. */
export function planRead(req: ParsedRequest, options: ReadOptions): ReadPlan {
  if (req.resource.kind !== 'table') {
    throw new PgFluentError('PGFLUENT_INVALID_QUERY', 'SELECT requires a table resource')
  }
  return planSelectCore(req, options, quoteQualified(req.schema, req.resource.name))
}

/**
 * Build the shaped-select SQL for an arbitrary row source (`FROM` expression).
 *
 * `fromExpr` is a trusted SQL fragment (a quoted table name or an RPC call).
 * `preValues`, when provided, are bound first so any `$n` placeholders inside
 * `fromExpr` line up with `$1..$n`.
 */
export function planSelectCore(
  req: ParsedRequest,
  options: ReadOptions,
  fromExpr: string,
  preValues?: unknown[]
): ReadPlan {
  const inner = buildInner(req, fromExpr, options, preValues)
  const { bag, cteWhere, selectParts, groupParts, orderParts, joins } = inner

  let innerSql = `SELECT ${selectParts.join(', ')}\n    FROM "pgfl_filtered" AS ${BASE}${joins}`
  if (groupParts.length > 0) innerSql += `\n    GROUP BY ${groupParts.join(', ')}`
  if (orderParts.length > 0) innerSql += `\n    ORDER BY ${orderParts.join(', ')}`
  if (inner.effectiveLimit !== undefined) innerSql += `\n    LIMIT ${Math.trunc(inner.effectiveLimit)}`
  if (inner.effectiveOffset > 0) innerSql += `\n    OFFSET ${Math.trunc(inner.effectiveOffset)}`

  const tableName = fromExpr
  let rowExpr = `row_to_json(${SUB})`
  if (req.stripNulls) rowExpr = `jsonb_strip_nulls(${rowExpr}::jsonb)::json`

  const bodyCol = req.single
    ? `("pgfl_agg"."rows" -> 0)::text`
    : `"pgfl_agg"."rows"::text`
  const outerCols = [
    `${bodyCol} AS "__pgfl_body"`,
    `json_array_length("pgfl_agg"."rows") AS "__pgfl_returned"`,
  ]
  let countText: string | undefined
  let countValues: unknown[] | undefined
  if (req.count === 'exact') {
    outerCols.push(`(SELECT count(*) FROM "pgfl_filtered") AS "__pgfl_count"`)
  } else if (req.count === 'planned' || req.count === 'estimated') {
    const countBag = new ParamBag()
    if (preValues) for (const value of preValues) countBag.add(value)
    const countWhere = renderWhere(req.filters, countBag, SRC)
    countText = `SELECT count(*)::text FROM ${tableName} AS ${SRC} WHERE ${countWhere}`
    countValues = countBag.values
  }

  const text =
    `WITH "pgfl_filtered" AS (\n  SELECT * FROM ${tableName} AS ${SRC}\n  WHERE ${cteWhere}\n)\n` +
    `SELECT ${outerCols.join(',\n  ')}\nFROM (\n  SELECT COALESCE(json_agg(${rowExpr}), '[]'::json) AS "rows"\n  FROM (\n${innerSql}\n  ) AS ${SUB}\n) AS "pgfl_agg"`

  return {
    text,
    values: bag.values,
    aggregate: inner.aggregate,
    effectiveOffset: inner.effectiveOffset,
    effectiveLimit: inner.effectiveLimit,
    count: req.count,
    countText,
    countValues,
  }
}

export interface StreamPlan {
  text: string
  values: unknown[]
}

/**
 * Build a streaming SELECT that returns one JSON-encoded row per result row
 * (a `__pgfl_row` text column), driven by a server-side cursor. Not available
 * for HEAD, `single`, count options or non-JSON media types.
 */
export function planStream(req: ParsedRequest, options: ReadOptions): StreamPlan {
  if (req.method !== 'GET') {
    throw invalid('Streaming is only available for GET (read) queries')
  }
  if (req.single) {
    throw invalid('Streaming cannot be combined with .single()')
  }
  if (req.count !== undefined) {
    throw invalid('Streaming is not available with a count option')
  }
  if (req.mediaType !== 'json') {
    throw invalid('Streaming only supports the default JSON media type')
  }
  const fromExpr =
    req.resource.kind === 'table'
      ? quoteQualified(req.schema, req.resource.name)
      : null
  if (fromExpr === null) {
    throw notImplemented('Streaming is not yet supported for RPC results')
  }
  const inner = buildInner(req, fromExpr, options, undefined)
  const { bag, cteWhere, selectParts, groupParts, orderParts, joins } = inner

  let innerSql = `SELECT ${selectParts.join(', ')}\n    FROM "pgfl_filtered" AS ${BASE}${joins}`
  if (groupParts.length > 0) innerSql += `\n    GROUP BY ${groupParts.join(', ')}`
  if (orderParts.length > 0) innerSql += `\n    ORDER BY ${orderParts.join(', ')}`
  if (inner.effectiveLimit !== undefined) innerSql += `\n    LIMIT ${Math.trunc(inner.effectiveLimit)}`
  if (inner.effectiveOffset > 0) innerSql += `\n    OFFSET ${Math.trunc(inner.effectiveOffset)}`

  const text =
    `WITH "pgfl_filtered" AS (\n  SELECT * FROM ${fromExpr} AS ${SRC}\n  WHERE ${cteWhere}\n)\n` +
    `SELECT row_to_json("pgfl_stream")::text AS "__pgfl_row"\nFROM (\n${innerSql}\n  ) AS "pgfl_stream"`

  return { text, values: bag.values }
}
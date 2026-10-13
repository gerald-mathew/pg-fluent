import { PgFluentError, pgrstError } from '../errors/index.js'
import type { ParsedRequest } from '../parser/types.js'
import type { QueryResult } from '../exec/executor.js'
import type { ColumnInfo, SchemaCache, TableInfo } from '../schema/cache.js'
import { ParamBag } from '../sql/builder.js'
import { quoteIdent, quoteLiteral, quoteQualified } from '../sql/quote.js'
import { buildProjection } from './projection.js'
import { renderWhere } from './where.js'

const SRC = '"pgfl_src"'
const BASE = '"pgfl_base"'
const SUB = '"pgfl_sub"'

export interface WritePlan {
  text: string
  values: unknown[]
  respond(result: QueryResult): Response
  /** Number of rows the mutation affected (for `max-affected`). */
  affected(result: QueryResult): number
}

export interface WriteOptions {
  allowUnfilteredMutations: boolean
  schemaCache: SchemaCache
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function bodyRows(body: unknown): Record<string, unknown>[] {
  if (Array.isArray(body)) {
    if (body.length === 0) throw pgrstError('PGRST102', 'Empty JSON array in request body')
    if (!body.every(isPlainObject)) {
      throw pgrstError('PGRST102', 'Invalid request body: expected an array of objects')
    }
    return body
  }
  if (isPlainObject(body)) return [body]
  throw pgrstError('PGRST102', 'Invalid request body: expected a JSON object or array')
}

function collectKeys(rows: Record<string, unknown>[]): string[] {
  const keys: string[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key)
        keys.push(key)
      }
    }
  }
  return keys
}

function validateColumns(keys: string[], tableInfo: TableInfo | undefined): string[] {
  if (!tableInfo) return keys
  const known = new Set(tableInfo.columns.map((c) => c.name))
  for (const key of keys) {
    if (!known.has(key)) {
      throw pgrstError(
        'PGRST204',
        `Could not find the '${key}' column of '${tableInfo.name}' in the schema cache`,
        { details: null, hint: null }
      )
    }
  }
  return keys
}

function assertFiltered(req: ParsedRequest, options: WriteOptions): void {
  if (req.allowUnfiltered || options.allowUnfilteredMutations) return
  if (req.filters.length === 0) {
    throw new PgFluentError(
      'PGFLUENT_UNFILTERED_MUTATION',
      'Refusing to run an unfiltered mutation',
      {
        hint: 'Add a filter, or set allowUnfilteredMutations: true (or call .allowUnfiltered()).',
      }
    )
  }
}

function contentRange(returned: number, count: number | undefined): string {
  if (returned === 0) return `*/${count ?? 0}`
  return `0-${returned - 1}/${count ?? '*'}`
}

/** Build the SQL that runs a mutation and optionally shapes the returned rows. */
async function planMutation(
  req: ParsedRequest,
  options: WriteOptions,
  build: (bag: ParamBag, table: string, tableInfo: TableInfo | undefined) => string
): Promise<WritePlan> {
  const table = quoteQualified(req.schema, req.resource.name)
  const tableInfo = await options.schemaCache.getTable(req.schema, req.resource.name)
  const bag = new ParamBag()
  const mutation = build(bag, table, tableInfo)

  const status = req.method === 'POST' ? 201 : 200
  const minimalStatus = req.method === 'POST' ? 201 : 204

  if (!req.returnRepresentation) {
    return {
      text: mutation,
      values: bag.values,
      affected: (result) => result.rowCount ?? 0,
      respond(result) {
        const headers: Record<string, string> = {}
        let count: number | undefined
        if (req.count && req.method === 'POST') {
          count = result.rowCount ?? undefined
          if (count !== undefined) headers['Content-Range'] = `*/${count}`
        }
        return new Response(null, {
          status: minimalStatus,
          statusText: minimalStatus === 201 ? 'Created' : 'No Content',
          headers,
        })
      },
    }
  }

  const projection = buildProjection(req.select, bag, BASE)
  let rowExpr = `row_to_json(${SUB})`
  if (req.stripNulls) rowExpr = `jsonb_strip_nulls(${rowExpr}::jsonb)::json`
  const bodyCol = req.single ? `("pgfl_agg"."rows" -> 0)::text` : `"pgfl_agg"."rows"::text`
  const text =
    `WITH "pgfl_mutated" AS (\n${mutation}\n)\n` +
    `SELECT\n  ${bodyCol} AS "__pgfl_body",\n  json_array_length("pgfl_agg"."rows") AS "__pgfl_returned"\n` +
    `FROM (\n  SELECT COALESCE(json_agg(${rowExpr}), '[]'::json) AS "rows"\n` +
    `  FROM (\n    SELECT ${projection.parts.join(', ')}\n    FROM "pgfl_mutated" AS ${BASE}\n  ) AS ${SUB}\n) AS "pgfl_agg"`

  return {
    text,
    values: bag.values,
    affected: (result) => Number(result.rows[0]?.['__pgfl_returned'] ?? 0),
    respond(result) {
      const row = result.rows[0] ?? {}
      const returned = Number(row['__pgfl_returned'] ?? 0)
      const bodyText = row['__pgfl_body']
      if (req.single && returned !== 1) {
        return new Response(
          JSON.stringify({
            code: 'PGRST116',
            details: `The result contains ${returned} rows`,
            hint: null,
            message: 'JSON object requested, multiple (or no) rows returned',
          }),
          { status: 406, statusText: 'Not Acceptable', headers: { 'Content-Type': 'application/json; charset=utf-8' } }
        )
      }
      const headers: Record<string, string> = {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Range': contentRange(returned, req.count ? returned : undefined),
      }
      const body = typeof bodyText === 'string' ? bodyText : null
      return new Response(body, {
        status,
        statusText: status === 201 ? 'Created' : 'OK',
        headers,
      })
    },
  }
}

function conflictColumns(req: ParsedRequest, tableInfo: TableInfo | undefined): string[] {
  const source = req.onConflict && req.onConflict.length > 0 ? req.onConflict : tableInfo?.primaryKey
  if (!source || source.length === 0) {
    throw pgrstError(
      'PGRST100',
      'Could not determine the conflict target for the upsert; pass onConflict or define a primary key'
    )
  }
  return source.map((token) => token.split('.')[0]!).filter((c) => c !== '')
}

/** The SQL that reproduces `col`'s default, or `undefined` when it has none. */
function columnDefaultSql(col: ColumnInfo, schema: string, table: string): string | undefined {
  if (col.identity) {
    return (
      `nextval(pg_get_serial_sequence(format('%I.%I', ` +
      `${quoteLiteral(schema)}, ${quoteLiteral(table)}), ${quoteLiteral(col.name)}))`
    )
  }
  if (col.defaultExpr) return `(${col.defaultExpr})`
  return undefined
}

/**
 * `missing=default` insert: build one `INSERT ... SELECT` where columns absent
 * from a given row fall back to that column's default (PostgreSQL's
 * `json_populate_record` alone would use NULL for absent keys, which differs
 * from PostgREST).
 */
function planInsertMissingDefault(
  req: ParsedRequest,
  options: WriteOptions,
  rows: Record<string, unknown>[],
  rawKeys: string[]
): Promise<WritePlan> {
  const upsert = req.resolution !== undefined
  const schema = req.schema
  const tableResource = req.resource.name

  return planMutation(req, options, (bag, table, tableInfo) => {
    if (!tableInfo) {
      throw pgrstError(
        'PGRST205',
        `Could not find the table '${schema}.${tableResource}' in the schema cache`
      )
    }
    const keys = validateColumns(rawKeys, tableInfo)
    if (keys.length === 0) {
      if (upsert) throw pgrstError('PGRST100', 'Cannot upsert without columns')
      return `INSERT INTO ${table} AS ${SRC} DEFAULT VALUES\nRETURNING ${SRC}.*`
    }
    const columnByName = new Map(tableInfo.columns.map((c) => [c.name, c]))
    for (const key of keys) {
      if (columnByName.get(key)?.generated) {
        throw pgrstError(
          'PGRST204',
          `Column '${key}' of '${tableInfo.name}' is generated and cannot be inserted`
        )
      }
    }
    const presentEverywhere = keys.map((key) =>
      rows.every((row) => Object.prototype.hasOwnProperty.call(row, key))
    )
    const rowSelects = rows.map((row) => `SELECT ${bag.add(JSON.stringify(row))}::jsonb AS "r"`)
    const source =
      `(SELECT "r", jsonb_populate_record(NULL::${table}, "r") AS "rec"\n` +
      `     FROM (\n       ${rowSelects.join('\n       UNION ALL ')}\n     ) AS "pgfl_rows") AS "s"`
    const exprs = keys.map((key, i) => {
      const value = `(s."rec").${quoteIdent(key)}`
      if (presentEverywhere[i]) return value
      const col = columnByName.get(key)
      const fallback = (col && columnDefaultSql(col, schema, tableResource)) ?? 'NULL'
      return `CASE WHEN s."r" ? ${quoteLiteral(key)} THEN ${value} ELSE ${fallback} END`
    })
    const cols = keys.map((k) => quoteIdent(k)).join(', ')
    const hasIdentity = keys.some((key) => columnByName.get(key)?.identity)
    const overriding = hasIdentity ? ' OVERRIDING SYSTEM VALUE' : ''
    let sql =
      `INSERT INTO ${table} AS ${SRC} (${cols})${overriding}\n` +
      `SELECT ${exprs.join(', ')}\nFROM ${source}`
    if (upsert) {
      const conflict = conflictColumns(req, tableInfo)
      const conflictSet = new Set(conflict)
      const target = conflict.map((c) => quoteIdent(c)).join(', ')
      if (req.resolution === 'ignore') {
        sql += `\nON CONFLICT (${target}) DO NOTHING`
      } else {
        const updatable = keys.filter((k) => !conflictSet.has(k))
        if (updatable.length === 0) {
          sql += `\nON CONFLICT (${target}) DO NOTHING`
        } else {
          const assignments = updatable
            .map((k) => `${quoteIdent(k)} = excluded.${quoteIdent(k)}`)
            .join(', ')
          sql += `\nON CONFLICT (${target}) DO UPDATE SET ${assignments}`
        }
      }
    }
    sql += `\nRETURNING ${SRC}.*`
    return sql
  })
}

function planInsert(req: ParsedRequest, options: WriteOptions): Promise<WritePlan> {
  const rows = bodyRows(req.body)
  const rawKeys = req.columns && req.columns.length > 0 ? req.columns : collectKeys(rows)
  if (req.missingDefault) {
    return planInsertMissingDefault(req, options, rows, rawKeys)
  }
  const json = JSON.stringify(rows)
  const upsert = req.resolution !== undefined

  return planMutation(req, options, (bag, table, tableInfo) => {
    const keys = validateColumns(rawKeys, tableInfo)
    if (keys.length === 0) {
      if (upsert) throw pgrstError('PGRST100', 'Cannot upsert without columns')
      return `INSERT INTO ${table} AS ${SRC} DEFAULT VALUES\nRETURNING ${SRC}.*`
    }
    const cols = keys.map((k) => quoteIdent(k)).join(', ')
    const hasIdentity = tableInfo
      ? keys.some((k) => tableInfo.columns.find((c) => c.name === k)?.identity)
      : false
    const overriding = hasIdentity ? ' OVERRIDING SYSTEM VALUE' : ''
    const param = bag.add(json)
    let sql = `INSERT INTO ${table} AS ${SRC} (${cols})${overriding}\nSELECT ${cols} FROM json_populate_recordset(null::${table}, ${param}::json)`
    if (upsert) {
      const conflict = conflictColumns(req, tableInfo)
      const conflictSet = new Set(conflict)
      const target = conflict.map((c) => quoteIdent(c)).join(', ')
      if (req.resolution === 'ignore') {
        sql += `\nON CONFLICT (${target}) DO NOTHING`
      } else {
        const updatable = keys.filter((k) => !conflictSet.has(k))
        if (updatable.length === 0) {
          sql += `\nON CONFLICT (${target}) DO NOTHING`
        } else {
          const assignments = updatable
            .map((k) => `${quoteIdent(k)} = excluded.${quoteIdent(k)}`)
            .join(', ')
          sql += `\nON CONFLICT (${target}) DO UPDATE SET ${assignments}`
        }
      }
    }
    sql += `\nRETURNING ${SRC}.*`
    return sql
  })
}

function planUpdate(req: ParsedRequest, options: WriteOptions): Promise<WritePlan> {
  assertFiltered(req, options)
  const rows = bodyRows(req.body)
  const first = rows[0]!
  const rawKeys = req.columns && req.columns.length > 0 ? req.columns : Object.keys(first)
  const json = JSON.stringify(first)

  return planMutation(req, options, (bag, table, tableInfo) => {
    const keys = validateColumns(rawKeys, tableInfo)
    if (keys.length === 0) throw pgrstError('PGRST100', 'Update body has no columns')
    const param = bag.add(json)
    const assignments = keys.map((k) => `${quoteIdent(k)} = "pgfl_new".${quoteIdent(k)}`).join(', ')
    const where = renderWhere(req.filters, bag, SRC)
    const returning = req.returnRepresentation ? `\nRETURNING ${SRC}.*` : ''
    return (
      `UPDATE ${table} AS ${SRC}\n` +
      `SET ${assignments}\n` +
      `FROM json_populate_record(null::${table}, ${param}::json) AS "pgfl_new"\n` +
      `WHERE ${where}${returning}`
    )
  })
}

function planDelete(req: ParsedRequest, options: WriteOptions): Promise<WritePlan> {
  assertFiltered(req, options)
  return planMutation(req, options, (bag, table) => {
    const where = renderWhere(req.filters, bag, SRC)
    const returning = req.returnRepresentation ? `\nRETURNING ${SRC}.*` : ''
    return `DELETE FROM ${table} AS ${SRC}\nWHERE ${where}${returning}`
  })
}

export async function planWrite(req: ParsedRequest, options: WriteOptions): Promise<WritePlan> {
  if (req.resource.kind !== 'table') {
    throw new PgFluentError('PGFLUENT_NOT_IMPLEMENTED', 'RPC is not implemented yet')
  }
  switch (req.method) {
    case 'POST':
      return planInsert(req, options)
    case 'PATCH':
      return planUpdate(req, options)
    case 'DELETE':
      return planDelete(req, options)
    default:
      throw new PgFluentError('PGFLUENT_INVALID_QUERY', `Unsupported method: ${req.method}`)
  }
}

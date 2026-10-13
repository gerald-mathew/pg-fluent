import { PgFluentError, PostgrestRequestError } from '../errors/index.js'
import { parseFilters } from '../parser/filter.js'
import { parseOrder } from '../parser/order.js'
import { itemOutputKey } from '../parser/select.js'
import type {
  EmbedItem,
  EmbeddedParam,
  FilterNode,
  ParsedRequest,
  ResolvedRelationship,
  SelectItem,
} from '../parser/types.js'
import type { ForeignKeyInfo, SchemaCache } from '../schema/cache.js'
import { formatSelectExpr, ParamBag } from '../sql/builder.js'
import { quoteIdent, quoteQualified } from '../sql/quote.js'
import { renderWhere } from './where.js'

export interface BuildContext {
  req: ParsedRequest
  bag: ParamBag
  maxRows: number
  counter: { n: number }
  /** Path of embed aliases from the base table to the current level. */
  path: string[]
}

function noRelationship(base: string, relation: string, hint?: string): PostgrestRequestError {
  return new PostgrestRequestError(
    'PGRST200',
    `Could not find a relationship between '${base}' and '${relation}' in the schema cache`,
    hint ? { hint: `Attempted to use hint '${hint}'` } : {}
  )
}

function ambiguousRelationship(base: string, relation: string): PostgrestRequestError {
  return new PostgrestRequestError(
    'PGRST201',
    `Could not embed because more than one relationship was found for '${base}' and '${relation}'`
  )
}

function matchesDirectHint(fk: ForeignKeyInfo, hint: string | undefined): boolean {
  if (hint === undefined) return true
  return fk.constraint === hint || fk.columns.includes(hint) || fk.referencedColumns.includes(hint)
}

async function findJunctions(
  base: { schema: string; name: string },
  target: string,
  fks: ForeignKeyInfo[],
  related: (schema: string, table: string) => Promise<ForeignKeyInfo[]>
): Promise<Array<{ link: ForeignKeyInfo; target: ForeignKeyInfo; junction: { schema: string; name: string } }>> {
  const results: Array<{
    link: ForeignKeyInfo
    target: ForeignKeyInfo
    junction: { schema: string; name: string }
  }> = []
  for (const link of fks) {
    const outgoing = link.sourceSchema === base.schema && link.sourceTable === base.name
    const incoming = link.referencedSchema === base.schema && link.referencedTable === base.name
    if (!outgoing && !incoming) continue
    const junction = outgoing
      ? { schema: link.referencedSchema, name: link.referencedTable }
      : { schema: link.sourceSchema, name: link.sourceTable }
    if (junction.name === target) continue
    const jfks = await related(junction.schema, junction.name)
    for (const targetFk of jfks) {
      if (
        targetFk.sourceSchema === junction.schema &&
        targetFk.sourceTable === junction.name &&
        targetFk.referencedTable === target
      ) {
        results.push({ link, target: targetFk, junction })
      }
    }
  }
  return results
}

async function resolveEmbed(
  base: { schema: string; name: string },
  item: EmbedItem,
  cache: SchemaCache
): Promise<void> {
  const fks = await cache.getForeignKeys(base.schema, base.name)
  const target = item.relation
  const candidates: NonNullable<EmbedItem['relationship']>[] = []

  for (const fk of fks) {
    const outgoing = fk.sourceSchema === base.schema && fk.sourceTable === base.name
    const incoming = fk.referencedSchema === base.schema && fk.referencedTable === base.name
    if (outgoing && fk.referencedTable === target && matchesDirectHint(fk, item.hint)) {
      candidates.push({
        kind: 'to-one',
        table: { schema: fk.referencedSchema, name: fk.referencedTable },
        baseColumns: fk.columns,
        relationColumns: fk.referencedColumns,
      })
    } else if (incoming && fk.sourceTable === target && matchesDirectHint(fk, item.hint)) {
      candidates.push({
        kind: 'to-many',
        table: { schema: fk.sourceSchema, name: fk.sourceTable },
        baseColumns: fk.referencedColumns,
        relationColumns: fk.columns,
      })
    }
  }

  let chosen: NonNullable<EmbedItem['relationship']> | undefined
  if (candidates.length === 1) {
    chosen = candidates[0]
  } else if (candidates.length === 0) {
    const junctions = await findJunctions(base, target, fks, (s, t) =>
      cache.getForeignKeys(s, t)
    )
    const filtered = item.hint
      ? junctions.filter(
          (j) =>
            j.junction.name === item.hint ||
            j.link.constraint === item.hint ||
            j.target.constraint === item.hint
        )
      : junctions
    if (filtered.length === 1) {
      const { link, target: targetFk, junction } = filtered[0]!
      const outgoing = link.sourceSchema === base.schema && link.sourceTable === base.name
      chosen = {
        kind: 'to-many',
        table: { schema: targetFk.referencedSchema, name: targetFk.referencedTable },
        baseColumns: outgoing ? link.columns : link.referencedColumns,
        relationColumns: targetFk.referencedColumns,
        junction: {
          schema: junction.schema,
          name: junction.name,
          baseColumns: outgoing ? link.columns : link.referencedColumns,
          junctionBaseColumns: outgoing ? link.referencedColumns : link.columns,
          relationColumns: targetFk.referencedColumns,
          junctionRelationColumns: targetFk.columns,
        },
      }
    } else if (filtered.length > 1) {
      throw ambiguousRelationship(base.name, target)
    } else {
      throw noRelationship(base.name, target, item.hint)
    }
  } else {
    throw ambiguousRelationship(base.name, target)
  }

  item.relationship = chosen
  const table = chosen!.table
  for (const child of item.columns) {
    if (child.kind === 'embed') await resolveEmbed(table, child, cache)
  }
}

/** Resolve and attach relationship metadata for every embed in the request. */
export async function resolveRelationships(req: ParsedRequest, cache: SchemaCache): Promise<void> {
  if (req.resource.kind !== 'table') return
  const base = { schema: req.schema, name: req.resource.name }
  for (const item of req.select) {
    if (item.kind === 'embed') await resolveEmbed(base, item, cache)
  }
}

function relationPathKey(relation: string[]): string {
  return relation.join('.')
}

/**
 * Resolve to-one relationships used by related-table ordering
 * (`order=address.city.asc`). Relationships are resolved even when the embed
 * is not part of `select`, matching PostgREST, and stored on the request keyed
 * by dotted path.
 */
export async function resolveOrderRelationships(
  req: ParsedRequest,
  cache: SchemaCache
): Promise<void> {
  if (req.resource.kind !== 'table') return
  const base = { schema: req.schema, name: req.resource.name }
  if (req.orderRelationships === undefined) req.orderRelationships = new Map()
  for (const term of req.order) {
    if (!term.relation || term.relation.length === 0) continue
    const key = relationPathKey(term.relation)
    if (req.orderRelationships.has(key)) continue
    const chain: ResolvedRelationship[] = []
    let current = base
    for (const segment of term.relation) {
      const item: EmbedItem = {
        kind: 'embed',
        alias: segment,
        relation: segment,
        columns: [],
        inner: false,
        spread: false,
      }
      await resolveEmbed(current, item, cache)
      const rel = item.relationship!
      if (rel.kind !== 'to-one') {
        throw ambiguousRelationship(current.name, segment)
      }
      chain.push(rel)
      current = rel.table
    }
    req.orderRelationships.set(key, chain)
  }
}

/**
 * Resolve relationships referenced by top-level `or`/`and` logical filters
 * whose conditions carry a dotted relation prefix (`or=(posts.title.eq.x)`).
 * Stored on the request keyed by the first relation segment.
 */
export async function resolveFilterRelationships(
  req: ParsedRequest,
  cache: SchemaCache
): Promise<void> {
  if (req.resource.kind !== 'table') return
  const base = { schema: req.schema, name: req.resource.name }
  if (req.filterRelationships === undefined) req.filterRelationships = new Map()
  const pending = new Set<string>()
  const collect = (node: FilterNode): void => {
    if (node.kind === 'condition') {
      if (node.relation && node.relation.length > 0) pending.add(node.relation[0]!)
      return
    }
    for (const child of node.nodes) collect(child)
  }
  for (const node of req.filters) collect(node)
  for (const segment of pending) {
    const item: EmbedItem = {
      kind: 'embed',
      alias: segment,
      relation: segment,
      columns: [],
      inner: false,
      spread: false,
    }
    await resolveEmbed(base, item, cache)
    req.filterRelationships!.set(segment, item.relationship!)
  }
}

function embeddedFor(req: ParsedRequest, path: string[]): EmbeddedParam[] {
  return req.embedded.filter(
    (p) => p.path.length === path.length && p.path.every((s, i) => s === path[i])
  )
}

function renderOrderClause(entries: EmbeddedParam[], alias: string, bag: ParamBag): string {
  const order = entries.find((e) => e.kind === 'order')
  if (!order) return ''
  const terms = parseOrder(order.value)
  if (terms.length === 0) return ''
  const parts = terms.map((term) => {
    const col = formatSelectExpr(alias, term.column.base, term.column.steps, undefined, bag)
    let sql = `${col} ${term.ascending ? 'ASC' : 'DESC'}`
    if (term.nullsFirst === true) sql += ' NULLS FIRST'
    else if (term.nullsFirst === false) sql += ' NULLS LAST'
    return sql
  })
  return ` ORDER BY ${parts.join(', ')}`
}

function modifierNumber(entries: EmbeddedParam[], kind: 'limit' | 'offset'): number | undefined {
  const found = entries.find((e) => e.kind === kind)
  if (!found) return undefined
  const n = Number(found.value)
  return Number.isInteger(n) && n >= 0 ? n : undefined
}

function renderEmbedFilter(entries: EmbeddedParam[], alias: string, bag: ParamBag): string {
  const params = entries
    .filter((e) => e.kind === 'filter' || e.kind === 'or' || e.kind === 'and')
    .map((e) => [e.key, e.value] as [string, string])
  if (params.length === 0) return ''
  const parsed = parseFilters(new URLSearchParams(params))
  return renderWhere(parsed.filters, bag, alias)
}

function buildEmbedSource(
  item: EmbedItem,
  parentAlias: string,
  alias: string,
  ctx: BuildContext
): { fromExpr: string; condition: string } {
  const rel = item.relationship!
  const conditions: string[] = []
  let fromExpr: string
  if (rel.junction) {
    const junctionAlias = quoteIdent(`pgfl_j${++ctx.counter.n}`)
    fromExpr =
      `${quoteQualified(rel.junction.schema, rel.junction.name)} AS ${junctionAlias} ` +
      `JOIN ${quoteQualified(rel.table.schema, rel.table.name)} AS ${alias} ON ` +
      `${alias}.${quoteIdent(rel.junction.relationColumns[0]!)} = ${junctionAlias}.${quoteIdent(rel.junction.junctionRelationColumns[0]!)}`
    for (let i = 0; i < rel.baseColumns.length; i++) {
      conditions.push(
        `${parentAlias}.${quoteIdent(rel.baseColumns[i]!)} = ${junctionAlias}.${quoteIdent(rel.junction.junctionBaseColumns[i]!)}`
      )
    }
  } else {
    fromExpr = `${quoteQualified(rel.table.schema, rel.table.name)} AS ${alias}`
    for (let i = 0; i < rel.baseColumns.length; i++) {
      conditions.push(
        `${parentAlias}.${quoteIdent(rel.baseColumns[i]!)} = ${alias}.${quoteIdent(rel.relationColumns[i]!)}`
      )
    }
  }
  const filter = renderEmbedFilter(embeddedFor(ctx.req, ctx.path), alias, ctx.bag)
  if (filter !== '' && filter !== 'TRUE') conditions.push(filter)
  return { fromExpr, condition: conditions.join(' AND ') }
}

function buildEmbedExpr(item: EmbedItem, parentAlias: string, ctx: BuildContext): string {
  if (!item.relationship) {
    throw new PgFluentError('PGFLUENT_INTERNAL', `Unresolved embed: ${item.alias}`)
  }
  const alias = quoteIdent(`pgfl_e${++ctx.counter.n}`)
  const childCtx: BuildContext = { ...ctx, path: [...ctx.path, item.alias] }
  const { fromExpr, condition } = buildEmbedSource(item, parentAlias, alias, childCtx)
  const nested = collectInnerConditions(item.columns, alias, childCtx)
  const parts = buildLevelProjection(item.columns, alias, childCtx)
  const entries = embeddedFor(childCtx.req, childCtx.path)
  const order = renderOrderClause(entries, alias, childCtx.bag)
  const limit = modifierNumber(entries, 'limit')
  const offset = modifierNumber(entries, 'offset')

  const where = [condition, ...nested].filter((c) => c !== '' && c !== 'TRUE').join(' AND ')
  const subAlias = quoteIdent('pgfl_x')

  if (item.relationship.kind === 'to-one') {
    let sub = `SELECT ${parts.join(', ')}\n      FROM ${fromExpr}`
    if (where) sub += `\n      WHERE ${where}`
    sub += limit !== undefined ? `\n      LIMIT ${limit}` : '\n      LIMIT 1'
    if (offset !== undefined) sub += `\n      OFFSET ${offset}`
    return `(SELECT to_json(${subAlias}) FROM (\n      ${sub}\n    ) AS ${subAlias}) AS ${quoteIdent(item.alias)}`
  }

  let sub = `SELECT ${parts.join(', ')}\n      FROM ${fromExpr}`
  if (where) sub += `\n      WHERE ${where}`
  sub += order
  if (limit !== undefined) sub += `\n      LIMIT ${Math.min(limit, ctx.maxRows)}`
  if (offset !== undefined) sub += `\n      OFFSET ${offset}`
  return (
    `(SELECT COALESCE(json_agg(row_to_json(${subAlias})), '[]'::json) FROM (\n      ${sub}\n    ) AS ${subAlias}) ` +
    `AS ${quoteIdent(item.alias)}`
  )
}

/**
 * Render a spread embed (`...rel(cols)`) as one scalar subquery per column,
 * merged into the parent object at the top level. Only to-one relationships
 * can be spread; nested embeds inside a spread are not yet supported.
 */
function buildSpreadExpr(item: EmbedItem, parentAlias: string, ctx: BuildContext): string[] {
  if (!item.relationship) {
    throw new PgFluentError('PGFLUENT_INTERNAL', `Unresolved spread embed: ${item.alias}`)
  }
  if (item.inner) {
    throw new PgFluentError('PGFLUENT_INVALID_QUERY', '`!inner` cannot be combined with a spread embed')
  }
  if (item.relationship.kind !== 'to-one') {
    throw new PgFluentError(
      'PGFLUENT_INVALID_QUERY',
      `Spread embeds ('...${item.relation}') are only supported for to-one relationships`
    )
  }
  const alias = quoteIdent(`pgfl_s${++ctx.counter.n}`)
  const childCtx: BuildContext = { ...ctx, path: [...ctx.path, item.alias] }
  const { fromExpr, condition } = buildEmbedSource(item, parentAlias, alias, childCtx)
  const entries = embeddedFor(childCtx.req, childCtx.path)
  const filter = renderEmbedFilter(entries, alias, childCtx.bag)
  const where = [condition, ...(filter && filter !== 'TRUE' ? [filter] : [])].join(' AND ')

  const parts: string[] = []
  for (const col of item.columns) {
    if (col.kind === 'embed') {
      throw new PgFluentError(
        'PGFLUENT_NOT_IMPLEMENTED',
        `Nested embeds inside a spread ('...${item.relation}') are not supported yet`
      )
    }
    if (col.kind === 'aggregate') {
      throw new PgFluentError(
        'PGFLUENT_INVALID_QUERY',
        `Aggregates cannot be used inside a spread ('...${item.relation}')`
      )
    }
    if (col.kind === 'star') {
      throw new PgFluentError(
        'PGFLUENT_INVALID_QUERY',
        `'...${item.relation}(*)' is not supported; list the columns to spread explicitly`
      )
    }
    const key = itemOutputKey(col)!
    const expr = formatSelectExpr(alias, col.path.base, col.path.steps, col.cast, childCtx.bag)
    parts.push(
      `(SELECT ${expr}\n      FROM ${fromExpr}\n      WHERE ${where}\n      LIMIT 1) AS ${quoteIdent(key)}`
    )
  }
  return parts
}

/** Build select-list expressions for a level, including correlated embed subqueries. */
export function buildLevelProjection(
  items: SelectItem[],
  parentAlias: string,
  ctx: BuildContext
): string[] {
  const parts: string[] = []
  for (const item of items) {
    switch (item.kind) {
      case 'star':
        parts.push(`${parentAlias}.*`)
        break
      case 'column':
        parts.push(
          `${formatSelectExpr(parentAlias, item.path.base, item.path.steps, item.cast, ctx.bag)} AS ${quoteIdent(itemOutputKey(item)!)}`
        )
        break
      case 'aggregate': {
        const key = quoteIdent(itemOutputKey(item)!)
        if (!item.arg || 'star' in item.arg) parts.push(`${item.fn}(*) AS ${key}`)
        else {
          const col = formatSelectExpr(parentAlias, item.arg.base, item.arg.steps, undefined, ctx.bag)
          parts.push(`${item.fn}(${col}) AS ${key}`)
        }
        break
      }
      case 'embed':
        if (item.spread) parts.push(...buildSpreadExpr(item, parentAlias, ctx))
        else parts.push(buildEmbedExpr(item, parentAlias, ctx))
        break
    }
  }
  return parts.length ? parts : [`${parentAlias}.*`]
}

/** `EXISTS` conditions for direct `!inner` embeds at a level (parent alias `parentAlias`). */
export function collectInnerConditions(
  items: SelectItem[],
  parentAlias: string,
  ctx: BuildContext
): string[] {
  const conds: string[] = []
  for (const item of items) {
    if (item.kind !== 'embed' || !item.inner || !item.relationship) continue
    const alias = quoteIdent(`pgfl_i${++ctx.counter.n}`)
    const childCtx: BuildContext = { ...ctx, path: [...ctx.path, item.alias] }
    const { fromExpr, condition } = buildEmbedSource(item, parentAlias, alias, childCtx)
    conds.push(`EXISTS (SELECT 1 FROM ${fromExpr}${condition ? `\n      WHERE ${condition}` : ''})`)
  }
  return conds
}

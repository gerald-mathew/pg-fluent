import { PgFluentError } from '../errors/index.js'
import { ParamBag, renderColumn } from '../sql/builder.js'
import { parseListLiteral } from '../parser/filter.js'
import type { FilterCondition, FilterNode, ResolvedRelationship } from '../parser/types.js'
import { quoteIdent, quoteQualified } from '../sql/quote.js'

const FTS_FN: Readonly<Record<string, string>> = {
  fts: 'to_tsquery',
  plfts: 'plainto_tsquery',
  phfts: 'phraseto_tsquery',
  wfts: 'websearch_to_tsquery',
}

const IS_KEYWORDS: Readonly<Record<string, string>> = {
  null: 'NULL',
  true: 'TRUE',
  false: 'FALSE',
  unknown: 'UNKNOWN',
  not_null: 'NOT NULL',
}

function invalid(message: string): PgFluentError {
  return new PgFluentError('PGFLUENT_INVALID_QUERY', message)
}

function renderCondition(cond: FilterCondition, bag: ParamBag, alias: string): string {
  const col = renderColumn(alias, cond.column.base, cond.column.steps, bag)
  let expr: string
  switch (cond.operator) {
    case 'eq':
      expr = cond.value.toLowerCase() === 'null' ? `${col} IS NULL` : `${col} = ${bag.add(cond.value)}`
      break
    case 'neq':
      expr =
        cond.value.toLowerCase() === 'null' ? `${col} IS NOT NULL` : `${col} <> ${bag.add(cond.value)}`
      break
    case 'gt':
      expr = `${col} > ${bag.add(cond.value)}`
      break
    case 'gte':
      expr = `${col} >= ${bag.add(cond.value)}`
      break
    case 'lt':
      expr = `${col} < ${bag.add(cond.value)}`
      break
    case 'lte':
      expr = `${col} <= ${bag.add(cond.value)}`
      break
    case 'like':
      expr = renderLike('LIKE', col, cond, bag)
      break
    case 'ilike':
      expr = renderLike('ILIKE', col, cond, bag)
      break
    case 'match':
      expr = `${col} ~ ${bag.add(cond.value)}`
      break
    case 'imatch':
      expr = `${col} ~* ${bag.add(cond.value)}`
      break
    case 'is': {
      const keyword = IS_KEYWORDS[cond.value.toLowerCase()]
      if (!keyword) throw invalid(`Invalid value for "is": ${cond.value}`)
      expr = `${col} IS ${keyword}`
      break
    }
    case 'isdistinct':
      expr = `${col} IS DISTINCT FROM ${bag.add(cond.value)}`
      break
    case 'in': {
      const list = parseListLiteral(cond.value)
      if (list.length === 0) expr = 'FALSE'
      else expr = `${col} IN (${list.map((v) => bag.add(v)).join(', ')})`
      break
    }
    case 'cs':
      expr = `${col} @> ${bag.add(cond.value)}`
      break
    case 'cd':
      expr = `${col} <@ ${bag.add(cond.value)}`
      break
    case 'ov':
      expr = `${col} && ${bag.add(cond.value)}`
      break
    case 'sl':
      expr = `${col} << ${bag.add(cond.value)}`
      break
    case 'sr':
      expr = `${col} >> ${bag.add(cond.value)}`
      break
    case 'nxl':
      expr = `${col} &> ${bag.add(cond.value)}`
      break
    case 'nxr':
      expr = `${col} &< ${bag.add(cond.value)}`
      break
    case 'adj':
      expr = `${col} -|- ${bag.add(cond.value)}`
      break
    case 'fts':
    case 'plfts':
    case 'phfts':
    case 'wfts': {
      const fn = FTS_FN[cond.operator]!
      if (cond.config !== undefined) {
        expr = `${col} @@ ${fn}(${bag.add(cond.config)}::regconfig, ${bag.add(cond.value)})`
      } else {
        expr = `${col} @@ ${fn}(${bag.add(cond.value)})`
      }
      break
    }
    default:
      throw invalid(`Unsupported operator: ${String(cond.operator)}`)
  }
  return cond.negated ? `NOT (${expr})` : expr
}

function toLikePattern(value: string): string {
  return value.replace(/\*/g, '%')
}

function renderLike(op: string, col: string, cond: FilterCondition, bag: ParamBag): string {
  if (cond.modifier === 'any' || cond.modifier === 'all') {
    const list = parseListLiteral(cond.value).map(toLikePattern)
    return `${col} ${op} ${cond.modifier.toUpperCase()}(${bag.add(list)}::text[])`
  }
  return `${col} ${op} ${bag.add(toLikePattern(cond.value))}`
}

function renderNode(node: FilterNode, bag: ParamBag, alias: string): string {
  if (node.kind === 'condition') return renderCondition(node, bag, alias)
  if (node.nodes.length === 0) return node.kind === 'and' ? 'TRUE' : 'FALSE'
  const joiner = node.kind === 'and' ? ' AND ' : ' OR '
  return `(${node.nodes.map((n) => renderNode(n, bag, alias)).join(joiner)})`
}

/** Render a node ignoring any embedded-relation prefix (used inside EXISTS). */
function renderRelationStripped(node: FilterNode, bag: ParamBag, alias: string): string {
  if (node.kind === 'condition') return renderCondition(node, bag, alias)
  if (node.nodes.length === 0) return node.kind === 'and' ? 'TRUE' : 'FALSE'
  const joiner = node.kind === 'and' ? ' AND ' : ' OR '
  return `(${node.nodes.map((n) => renderRelationStripped(n, bag, alias)).join(joiner)})`
}

export interface WhereContext {
  /** The alias of the base row being filtered (defaults to `alias`). */
  baseAlias?: string
  /** Resolve an embedded relation by its first path segment. */
  resolveRel?: (relation: string) => ResolvedRelationship | undefined
}

function joinCondition(
  rel: ResolvedRelationship,
  baseAlias: string,
  subAlias: string,
  _bag: ParamBag
): string {
  const conditions: string[] = []
  for (let i = 0; i < rel.baseColumns.length; i++) {
    conditions.push(
      `${baseAlias}.${quoteIdent(rel.baseColumns[i]!)} = ${subAlias}.${quoteIdent(rel.relationColumns[i]!)}`
    )
  }
  return conditions.join(' AND ')
}

function relationExists(
  rel: ResolvedRelationship,
  condition: string,
  baseAlias: string,
  bag: ParamBag
): string {
  const subAlias = quoteIdent('pgfl_f')
  const from = quoteQualified(rel.table.schema, rel.table.name)
  return `EXISTS (SELECT 1 FROM ${from} AS ${subAlias}\n    WHERE ${joinCondition(rel, baseAlias, subAlias, bag)} AND ${condition})`
}

/** Render a single relation-prefixed leaf condition as an EXISTS subquery. */
function renderRelationCondition(
  cond: FilterCondition,
  bag: ParamBag,
  alias: string,
  ctx: WhereContext
): string {
  if (cond.relation && cond.relation.length > 1) {
    throw new PgFluentError(
      'PGFLUENT_NOT_IMPLEMENTED',
      'Filters reaching through multiple embedded relations are not supported yet'
    )
  }
  const segment = cond.relation![0]!
  const rel = ctx.resolveRel?.(segment)
  if (!rel) {
    throw new PgFluentError(
      'PGFLUENT_INVALID_QUERY',
      `Could not resolve embedded relation '${segment}' for filtering`
    )
  }
  const baseAlias = ctx.baseAlias ?? alias
  return relationExists(rel, renderCondition(cond, bag, quoteIdent('pgfl_f')),
    baseAlias, bag)
}

/** Render a relation-prefixed logical subtree as a single EXISTS subquery. */
function renderRelationTree(
  node: FilterNode,
  bag: ParamBag,
  alias: string,
  ctx: WhereContext
): string {
  if (node.kind !== 'and' && node.kind !== 'or') {
    return renderRelationCondition(node as FilterCondition, bag, alias, ctx)
  }
  if (node.relation && node.relation.length > 1) {
    throw new PgFluentError(
      'PGFLUENT_NOT_IMPLEMENTED',
      'Filters reaching through multiple embedded relations are not supported yet'
    )
  }
  const segment = (node.relation ?? extractRelation(node))![0]!
  const rel = ctx.resolveRel?.(segment)
  if (!rel) {
    throw new PgFluentError(
      'PGFLUENT_INVALID_QUERY',
      `Could not resolve embedded relation '${segment}' for filtering`
    )
  }
  const subAlias = quoteIdent('pgfl_f')
  const predicate = renderRelationStripped(node, bag, subAlias)
  const baseAlias = ctx.baseAlias ?? alias
  return relationExists(rel, predicate, baseAlias, bag)
}

function extractRelation(node: FilterNode): string[] | undefined {
  if (node.kind === 'condition') return node.relation
  for (const child of node.nodes) {
    const r = extractRelation(child)
    if (r && r.length > 0) return r
  }
  return undefined
}

function renderTopNode(node: FilterNode, bag: ParamBag, alias: string, ctx: WhereContext): string {
  if (node.kind === 'condition') {
    if (node.relation && node.relation.length > 0) {
      return renderRelationCondition(node, bag, alias, ctx)
    }
    return renderNode(node, bag, alias)
  }
  if (node.relation && node.relation.length > 0) {
    return renderRelationTree(node, bag, alias, ctx)
  }
  if (node.nodes.length === 0) return node.kind === 'and' ? 'TRUE' : 'FALSE'
  const joiner = node.kind === 'and' ? ' AND ' : ' OR '
  return `(${node.nodes.map((n) => renderTopNode(n, bag, alias, ctx)).join(joiner)})`
}

/** Compile a list of top-level filter nodes into a `WHERE` clause body. */
export function renderWhere(
  nodes: FilterNode[],
  bag: ParamBag,
  alias: string,
  ctx?: WhereContext
): string {
  const parts: string[] = []
  for (const node of nodes) {
    parts.push(renderTopNode(node, bag, alias, ctx ?? {}))
  }
  return parts.length ? parts.join(' AND ') : 'TRUE'
}

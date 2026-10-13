import { PgFluentError } from '../errors/index.js'
import { splitTopLevel } from './select.js'
import type { ColumnPath, FilterCondition, FilterNode, FilterOperator } from './types.js'

const OPERATORS = new Set<string>([
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'like',
  'ilike',
  'match',
  'imatch',
  'is',
  'isdistinct',
  'in',
  'cs',
  'cd',
  'ov',
  'sl',
  'sr',
  'nxl',
  'nxr',
  'adj',
  'fts',
  'plfts',
  'phfts',
  'wfts',
])

function parseError(message: string): PgFluentError {
  return new PgFluentError('PGFLUENT_INVALID_QUERY', `Invalid filter: ${message}`)
}

/**
 * Parse a query-string key into an optional embedded relation path and a
 * column path (with JSON access steps).
 */
export function parseKeyPath(key: string): { relation: string[]; path: ColumnPath } {
  if (key.includes('->')) {
    return { relation: [], path: parseJsonPath(key) }
  }
  const dot = key.lastIndexOf('.')
  if (dot === -1) return { relation: [], path: { base: key, steps: [] } }
  const relation = key.slice(0, dot).split('.')
  return { relation, path: { base: key.slice(dot + 1), steps: [] } }
}

function parseJsonPath(input: string): ColumnPath {
  const parts: string[] = []
  let current = ''
  let i = 0
  while (i < input.length) {
    if (input.startsWith('->>', i)) {
      parts.push(current, '->>')
      current = ''
      i += 3
    } else if (input.startsWith('->', i)) {
      parts.push(current, '->')
      current = ''
      i += 2
    } else {
      current += input[i]
      i++
    }
  }
  parts.push(current)
  const base = parts[0]!
  if (base === '') throw parseError(`empty column in ${JSON.stringify(input)}`)
  const steps: ColumnPath['steps'] = []
  for (let k = 1; k < parts.length; k += 2) {
    const op = parts[k]
    const key = parts[k + 1]
    if ((op !== '->' && op !== '->>') || key === undefined || key === '') {
      throw parseError(`malformed JSON path in ${JSON.stringify(input)}`)
    }
    steps.push({ op, key })
  }
  return { base, steps }
}

interface ParsedOperator {
  operator: FilterOperator
  modifier?: 'any' | 'all'
  config?: string
}

function parseOperatorToken(token: string): ParsedOperator {
  const m = /^([a-z]+)(?:\(([^()]*)\))?$/.exec(token)
  if (!m) throw parseError(`unknown operator ${JSON.stringify(token)}`)
  const name = m[1]! as FilterOperator
  const arg = m[2]
  if (!OPERATORS.has(name)) throw parseError(`unknown operator ${JSON.stringify(name)}`)
  if (name === 'like' || name === 'ilike') {
    if (arg === undefined) return { operator: name }
    if (arg === 'any' || arg === 'all') return { operator: name, modifier: arg }
    throw parseError(`invalid modifier for ${name}: ${JSON.stringify(arg)}`)
  }
  if (name === 'fts' || name === 'plfts' || name === 'phfts' || name === 'wfts') {
    return { operator: name, config: arg }
  }
  if (arg !== undefined) throw parseError(`operator ${name} takes no argument`)
  return { operator: name }
}

/** Parse the `op.value` portion of a filter into a condition. */
function parseOperatorAndValue(raw: string, column: ColumnPath, relation: string[]): FilterCondition {
  let negated = false
  let rest = raw
  if (rest.startsWith('not.')) {
    negated = true
    rest = rest.slice(4)
  }
  const dot = rest.indexOf('.')
  if (dot === -1) throw parseError(`missing operator in ${JSON.stringify(raw)}`)
  const opToken = rest.slice(0, dot)
  const value = rest.slice(dot + 1)
  const parsed = parseOperatorToken(opToken)
  return {
    kind: 'condition',
    column,
    relation: relation.length ? relation : undefined,
    negated,
    operator: parsed.operator,
    modifier: parsed.modifier,
    config: parsed.config,
    value,
  }
}

/**
 * Locate where the column key ends and the operator begins in a logical
 * expression like `pf_posts.title.not.eq.hello` or `meta->>author.eq.gerald`.
 * The column may contain relation segments and JSON path operators, so the
 * first `.`-separated segment that names a known operator wins.
 */
function findOperatorStart(token: string): number {
  for (let i = 0; i < token.length; i++) {
    if (token[i] !== '.') continue
    const rest = token.slice(i + 1)
    const seg = rest.startsWith('not.') ? rest.slice(4) : rest
    const match = /^[a-z]+/i.exec(seg)
    if (match && OPERATORS.has(match[0].toLowerCase())) return i + 1
  }
  return -1
}

/** Parse a logical expression body, e.g. `a.eq.1,and(b.gt.2,c.lt.3)`. */
function parseExpression(token: string, relation: string[]): FilterNode {
  const trimmed = token.trim()
  const logical = /^(and|or)\((.*)\)$/s.exec(trimmed)
  if (logical) {
    const inner = logical[2]!
    const nodes = splitTopLevel(inner, ',')
      .map((t) => t.trim())
      .filter((t) => t !== '')
      .map((t) => parseExpression(t, relation))
    return { kind: logical[1] as 'and' | 'or', nodes, relation: relation.length ? relation : undefined }
  }
  const opStart = findOperatorStart(trimmed)
  if (opStart === -1) throw parseError(`malformed expression ${JSON.stringify(token)}`)
  const key = trimmed.slice(0, opStart - 1)
  const { relation: rel, path } = parseKeyPath(key)
  const combined = rel.length ? [...relation, ...rel] : relation
  return parseOperatorAndValue(trimmed.slice(opStart), path, combined)
}

/** The reserved query-string keys that are not filters. */
const RESERVED = new Set([
  'select',
  'order',
  'limit',
  'offset',
  'on_conflict',
  'columns',
  'or',
  'and',
])

const FILTER_GUARDED_KEYS = new Set(['select', 'on_conflict', 'columns'])

const EMBEDDED_SUFFIX = /\.(order|limit|offset|or|and)$/

/**
 * Parse every non-reserved query-string parameter into filter nodes.
 * Embedded-resource filters/modifiers are returned so the planner can handle
 * them (or reject them with a clear error if embedding is unsupported).
 */
export interface EmbeddedFilter {
  /** Full query-string key, e.g. `posts.title` or `instruments.or`. */
  key: string
  value: string
}

export interface ParsedFilters {
  filters: FilterNode[]
  embedded: EmbeddedFilter[]
}

export function parseFilters(params: URLSearchParams): ParsedFilters {
  const filters: FilterNode[] = []
  const embedded: EmbeddedFilter[] = []
  for (const [key, value] of params) {
    if (key === 'or' || key === 'and') {
      filters.push({
        kind: key,
        nodes: splitTopLevel(stripParens(value), ',')
          .map((t) => t.trim())
          .filter((t) => t !== '')
          .map((t) => parseExpression(t, [])),
        relation: undefined,
      })
      continue
    }
    if (RESERVED.has(key)) {
      // `select`, `on_conflict` and `columns` are not filters. If one of them carries a filter
      // value (e.g. `.eq('select', 1)` arrives as `select=eq.1`) a column is being filtered by a
      // reserved name; reject instead of silently dropping the filter.
      if (FILTER_GUARDED_KEYS.has(key) && looksLikeFilterValue(value)) {
        throw parseError(`'${key}' is a reserved parameter name and cannot be used as a filter column`)
      }
      continue
    }
    if (EMBEDDED_SUFFIX.test(key) || key.includes('.')) {
      embedded.push({ key, value })
      continue
    }
    const { path } = parseKeyPath(key)
    filters.push(parseOperatorAndValue(value, path, []))
  }
  return { filters, embedded }
}

/**
 * Heuristic: does a query-string value carry a PostgREST filter operator
 * (`op.value` or `not.op.value`)? Used to separate RPC arguments from filters.
 */
export function looksLikeFilterValue(value: string): boolean {
  let rest = value
  if (rest.startsWith('not.')) rest = rest.slice(4)
  const dot = rest.indexOf('.')
  if (dot <= 0) return false
  const token = rest.slice(0, dot)
  const m = /^([a-z]+)(?:\(([^()]*)\))?$/.exec(token)
  return m !== null && OPERATORS.has(m[1]!)
}

function stripParens(value: string): string {
  if (value.startsWith('(') && value.endsWith(')')) return value.slice(1, -1)
  return value
}

/** Parse a PostgREST list literal such as `(1,2,"a b")` or `{a,b}`. */
export function parseListLiteral(raw: string): string[] {
  let inner = raw
  if ((inner.startsWith('(') && inner.endsWith(')')) || (inner.startsWith('{') && inner.endsWith('}'))) {
    inner = inner.slice(1, -1)
  }
  const out: string[] = []
  let current = ''
  let quoted = false
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]!
    if (c === '"') {
      if (quoted && inner[i + 1] === '"') {
        current += '"'
        i++
        continue
      }
      quoted = !quoted
      continue
    }
    if (c === '\\' && quoted && inner[i + 1] === '"') {
      current += '"'
      i++
      continue
    }
    if (c === ',' && !quoted) {
      out.push(current)
      current = ''
      continue
    }
    current += c
  }
  out.push(current)
  return out
}

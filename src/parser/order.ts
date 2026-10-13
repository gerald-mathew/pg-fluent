import { PgFluentError } from '../errors/index.js'
import type { OrderTerm } from './types.js'
import { parseKeyPath } from './filter.js'

/**
 * Parse a PostgREST `order=` value, e.g. `name.desc.nullslast,id.asc`.
 * Referenced-table ordering uses the `relation(column)` form, e.g.
 * `pf_users(name).desc`; per-embed ordering (`rel.order=...`) arrives as a
 * separate embedded parameter and is handled by the planner.
 */
export function parseOrder(value: string): OrderTerm[] {
  if (value === '') return []
  const terms: OrderTerm[] = []
  for (const raw of value.split(',')) {
    const term = raw.trim()
    if (term === '') continue
    let relation: string[] = []
    let columnToken: string
    let rest: string
    const related = /^([A-Za-z_][A-Za-z0-9_]*)\(([^)]*)\)(.*)$/.exec(term)
    if (related) {
      relation = [related[1]!]
      columnToken = related[2]!.trim()
      rest = related[3]!
    } else {
      const parts = term.split('.')
      columnToken = parts.shift()!
      rest = parts.map((p) => `.${p}`).join('')
    }
    if (!columnToken) throw new PgFluentError('PGFLUENT_INVALID_QUERY', `Invalid order term: ${term}`)
    let ascending = true
    let nullsFirst: boolean | undefined
    for (const part of rest.split('.').filter((p) => p !== '')) {
      if (part === 'asc') ascending = true
      else if (part === 'desc') ascending = false
      else if (part === 'nullsfirst') nullsFirst = true
      else if (part === 'nullslast') nullsFirst = false
      else throw new PgFluentError('PGFLUENT_INVALID_QUERY', `Invalid order modifier: ${part}`)
    }
    const { relation: pathRelation, path } = parseKeyPath(columnToken)
    if (relation.length === 0 && pathRelation.length > 0) relation = pathRelation
    terms.push({
      relation: relation.length ? relation : undefined,
      column: path,
      ascending,
      nullsFirst,
    })
  }
  return terms
}
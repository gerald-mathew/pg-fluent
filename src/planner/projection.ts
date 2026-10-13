import { PgFluentError } from '../errors/index.js'
import type { SelectItem } from '../parser/types.js'
import { itemOutputKey } from '../parser/select.js'
import { ParamBag, formatSelectExpr, renderColumn } from '../sql/builder.js'
import { quoteCast, quoteIdent } from '../sql/quote.js'

export interface Projection {
  parts: string[]
  groupParts: string[]
  aggregate: boolean
}

export function selectItemSql(item: SelectItem, bag: ParamBag, alias: string): string | undefined {
  switch (item.kind) {
    case 'star':
      return `${alias}.*`
    case 'column': {
      const key = itemOutputKey(item)!
      const expr = formatSelectExpr(alias, item.path.base, item.path.steps, item.cast, bag)
      return `${expr} AS ${quoteIdent(key)}`
    }
    case 'aggregate': {
      const key = itemOutputKey(item)!
      let expr: string
      if (!item.arg || 'star' in item.arg) {
        if (item.fn !== 'count') {
          throw new PgFluentError('PGFLUENT_INVALID_QUERY', `${item.fn}() requires a column`)
        }
        expr = 'count(*)'
      } else {
        expr = `${item.fn}(${renderColumn(alias, item.arg.base, item.arg.steps, bag)})`
      }
      if (item.cast) expr += `::${quoteCast(item.cast)}`
      return `${expr} AS ${quoteIdent(key)}`
    }
    case 'embed':
      throw new PgFluentError(
        'PGFLUENT_NOT_IMPLEMENTED',
        'Embedded resources are not supported yet'
      )
  }
}

export function buildProjection(items: SelectItem[], bag: ParamBag, alias: string): Projection {
  const aggregates = items.filter((i) => i.kind === 'aggregate')
  const parts: string[] = []
  const groupParts: string[] = []
  for (const item of items) {
    const sql = selectItemSql(item, bag, alias)
    if (sql) parts.push(sql)
    if (aggregates.length > 0 && item.kind === 'column') {
      groupParts.push(formatSelectExpr(alias, item.path.base, item.path.steps, undefined, bag))
    }
  }
  if (parts.length === 0) parts.push(`${alias}.*`)
  return { parts, groupParts, aggregate: aggregates.length > 0 }
}

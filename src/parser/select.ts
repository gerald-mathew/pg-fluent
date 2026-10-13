import { PgFluentError } from '../errors/index.js'
import type { ColumnPath, JsonStep, SelectItem } from './types.js'

const AGGREGATES = new Set(['count', 'sum', 'avg', 'min', 'max'])

function parseError(message: string): PgFluentError {
  return new PgFluentError('PGFLUENT_INVALID_QUERY', `Invalid select: ${message}`)
}

/** Split `input` on `sep` at depth 0, respecting double quotes and literals. */
export function splitTopLevel(input: string, sep: string): string[] {
  const out: string[] = []
  let depth = 0
  let quoted = false
  let start = 0
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!
    if (c === '"') {
      quoted = !quoted
      continue
    }
    if (quoted) continue
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') depth--
    else if (c === sep && depth === 0) {
      out.push(input.slice(start, i))
      start = i + 1
    }
  }
  out.push(input.slice(start))
  return out
}

function readQuoted(s: string, i: number): { value: string; next: number } {
  // s[i] === '"'
  let out = ''
  let j = i + 1
  while (j < s.length) {
    if (s[j] === '"') {
      if (s[j + 1] === '"') {
        out += '"'
        j += 2
        continue
      }
      return { value: out, next: j + 1 }
    }
    out += s[j]
    j++
  }
  throw parseError('unterminated quoted identifier')
}

const UNQUOTED_STOP = new Set([',', ':', '(', ')', '!', '-', ' '])

function readIdent(s: string, i: number): { value: string; next: number } {
  if (s[i] === '"') return readQuoted(s, i)
  let j = i
  while (j < s.length && !UNQUOTED_STOP.has(s[j]!)) j++
  if (j === i) throw parseError(`expected identifier near ${JSON.stringify(s.slice(i, i + 20))}`)
  return { value: s.slice(i, j), next: j }
}

function readCast(s: string, i: number): { value: string; next: number } {
  // s[i..i+1] === '::'
  let j = i + 2
  let out = ''
  while (j < s.length) {
    const c = s[j]!
    if (/[A-Za-z0-9_.]/.test(c)) {
      out += c
      j++
    } else if (c === '[' && s[j + 1] === ']') {
      out += '[]'
      j += 2
    } else {
      break
    }
  }
  if (out === '') throw parseError('empty cast type')
  return { value: out, next: j }
}

function parseColumnPath(s: string, i: number): { path: ColumnPath; next: number } {
  const base = readIdent(s, i)
  let j = base.next
  const steps: JsonStep[] = []
  while (s.startsWith('->', j)) {
    let op: '->' | '->>' = '->'
    let k = j + 2
    if (s[k] === '>') {
      op = '->>'
      k++
    }
    const key = readIdent(s, k)
    steps.push({ op, key: key.value })
    j = key.next
  }
  return { path: { base: base.value, steps }, next: j }
}

/**
 * Parse a PostgREST `select=` string into a list of select items.
 *
 * Embedding syntax is parsed but resolved later by the planner; unknown
 * syntax raises `PGFLUENT_INVALID_QUERY` (never passed through as raw SQL).
 */
export function parseSelect(input: string | undefined): SelectItem[] {
  if (input === undefined || input === '*') return [{ kind: 'star' }]
  const items: SelectItem[] = []
  for (const raw of splitTopLevel(input, ',')) {
    const item = raw.trim()
    if (item === '') continue
    if (item === '*') {
      items.push({ kind: 'star' })
      continue
    }
    items.push(parseItem(item))
  }
  return items
}

function findAliasColon(item: string): number {
  let quoted = false
  let depth = 0
  for (let i = 0; i < item.length; i++) {
    const c = item[i]!
    if (c === '"') {
      quoted = !quoted
      continue
    }
    if (quoted) continue
    if (c === '(') depth++
    else if (c === ')') depth--
    else if (c === ':' && depth === 0) {
      if (item[i + 1] === ':') {
        i++ // skip the second colon of '::'
        continue
      }
      return i
    }
  }
  return -1
}

function parseItem(item: string): SelectItem {
  let alias: string | undefined
  const colon = findAliasColon(item)
  let rest = item
  if (colon !== -1) {
    const aliasRaw = item.slice(0, colon)
    alias = aliasRaw.startsWith('"') ? readQuoted(aliasRaw, 0).value : aliasRaw
    rest = item.slice(colon + 1)
  }

  const spread = rest.startsWith('...')
  if (spread) rest = rest.slice(3)

  // Embedding or aggregate: an identifier followed by `(`.
  const first = readIdent(rest, 0)
  let j = first.next
  let inner = false
  let hint: string | undefined
  if (rest[j] === '!') {
    j++
    if (rest.startsWith('inner', j)) {
      inner = true
      j += 5
    } else {
      const h = readIdent(rest, j)
      hint = h.value
      j = h.next
    }
  }
  if (rest[j] === '(') {
    if (!rest.endsWith(')')) throw parseError(`unbalanced parentheses in ${JSON.stringify(item)}`)
    const body = rest.slice(j + 1, rest.length - 1)
    if (AGGREGATES.has(first.value)) {
      return parseAggregate(alias, first.value, body, item)
    }
    return {
      kind: 'embed',
      alias: alias ?? first.value,
      relation: first.value,
      hint,
      inner,
      spread,
      columns: body === '' ? [] : parseSelect(body),
    }
  }

  // Plain column with optional JSON path and cast.
  const { path, next } = parseColumnPath(rest, 0)
  let k = next
  let cast: string | undefined
  if (rest.startsWith('::', k)) {
    const c = readCast(rest, k)
    cast = c.value
    k = c.next
  }
  if (k !== rest.length) throw parseError(`unexpected token near ${JSON.stringify(rest.slice(k))}`)
  return { kind: 'column', alias, path, cast }
}

function parseAggregate(
  alias: string | undefined,
  fn: string,
  body: string,
  item: string
): SelectItem {
  if (fn === 'count' && body === '') return { kind: 'aggregate', alias, fn }
  if (body === '*') return { kind: 'aggregate', alias, fn, arg: { star: true } }
  const { path, next } = parseColumnPath(body.trim(), 0)
  if (next !== body.trim().length) throw parseError(`invalid aggregate argument in ${item}`)
  return { kind: 'aggregate', alias, fn, arg: path }
}

/** The JSON key an item produces. `undefined` for `*` and embeddings. */
export function itemOutputKey(item: SelectItem): string | undefined {
  switch (item.kind) {
    case 'star':
      return undefined
    case 'column': {
      if (item.alias) return item.alias
      const last = item.path.steps[item.path.steps.length - 1]
      return last ? last.key : item.path.base
    }
    case 'aggregate':
      return item.alias ?? item.fn
    case 'embed':
      return item.alias
  }
}

import { describe, expect, it } from 'vitest'
import { parseRequest } from '../../src/parser/request.js'
import { parseSelect } from '../../src/parser/select.js'
import { parseFilters } from '../../src/parser/filter.js'
import { parseOrder } from '../../src/parser/order.js'

const ctx = { schemas: ['public', 'billing'], defaultSchema: 'public' }

function errorCode(fn: () => unknown): string | undefined {
  try {
    fn()
  } catch (err) {
    return (err as { code?: string }).code
  }
  return undefined
}

function req(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return parseRequest(
    { url: `http://pg-fluent.local/${url}`, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body },
    ctx
  )
}

describe('parseSelect', () => {
  it('parses star, columns, aliases, casts and json paths', () => {
    const items = parseSelect('id, full_name:name, meta->>city, age::text')
    expect(items).toHaveLength(4)
    expect(items[0]).toMatchObject({ kind: 'column', path: { base: 'id', steps: [] } })
    expect(items[1]).toMatchObject({ kind: 'column', alias: 'full_name', path: { base: 'name' } })
    expect(items[2]).toMatchObject({
      kind: 'column',
      path: { base: 'meta', steps: [{ op: '->>', key: 'city' }] },
    })
    expect(items[3]).toMatchObject({ kind: 'column', path: { base: 'age' }, cast: 'text' })
  })

  it('parses aggregates', () => {
    expect(parseSelect('count()')[0]).toMatchObject({ kind: 'aggregate', fn: 'count' })
    expect(parseSelect('total:sum(amount)')[0]).toMatchObject({
      kind: 'aggregate',
      alias: 'total',
      fn: 'sum',
      arg: { base: 'amount' },
    })
    expect(parseSelect('n:count(*)')[0]).toMatchObject({ kind: 'aggregate', fn: 'count', arg: { star: true } })
  })

  it('parses embeddings', () => {
    const items = parseSelect('id, posts!inner(title, author:users(name))')
    const embed = items[1]
    expect(embed).toMatchObject({ kind: 'embed', relation: 'posts', inner: true })
    if (embed && embed.kind === 'embed') {
      expect(embed.columns[1]).toMatchObject({ kind: 'embed', relation: 'users', alias: 'author' })
    }
  })
})

describe('parseFilters', () => {
  it('parses operators, negation and any/all', () => {
    const params = new URLSearchParams('id=eq.1&name=not.ilike.%25x%25&tags=cs.%7Ba,b%7D')
    const { filters } = parseFilters(params)
    expect(filters[0]).toMatchObject({ kind: 'condition', operator: 'eq', negated: false, value: '1' })
    expect(filters[1]).toMatchObject({ kind: 'condition', operator: 'ilike', negated: true })
    expect(filters[2]).toMatchObject({ kind: 'condition', operator: 'cs' })
  })

  it('parses logical trees', () => {
    const params = new URLSearchParams('or=(a.eq.1,and(b.gt.2,c.lt.3))')
    const { filters } = parseFilters(params)
    expect(filters[0]).toMatchObject({ kind: 'or' })
  })

  it('rejects unknown operators', () => {
    expect(() => parseFilters(new URLSearchParams('a=bogus.1'))).toThrow()
  })
})

describe('parseOrder', () => {
  it('parses direction and nulls modifiers', () => {
    const terms = parseOrder('name.desc.nullslast,age.asc')
    expect(terms[0]).toMatchObject({ column: { base: 'name' }, ascending: false, nullsFirst: false })
    expect(terms[1]).toMatchObject({ column: { base: 'age' }, ascending: true })
  })
})

describe('parseRequest', () => {
  it('maps method, resource, schema and prefer headers', () => {
    const parsed = req('todos?select=id&done=eq.false&limit=5&offset=2&order=id.desc', {
      headers: { prefer: 'count=exact', accept: 'application/json' },
    })
    expect(parsed.method).toBe('GET')
    expect(parsed.resource).toEqual({ kind: 'table', name: 'todos' })
    expect(parsed.limit).toBe(5)
    expect(parsed.offset).toBe(2)
    expect(parsed.count).toBe('exact')
    expect(parsed.order[0]).toMatchObject({ ascending: false })
  })

  it('reads the profile header for the schema', () => {
    expect(req('todos', { headers: { 'accept-profile': 'billing' } }).schema).toBe('billing')
  })

  it('rejects non-exposed schemas', () => {
    expect(errorCode(() => req('todos', { headers: { 'accept-profile': 'secret' } }))).toBe('PGRST106')
  })

  it('recognises single and csv media types', () => {
    expect(req('todos', { headers: { accept: 'application/vnd.pgrst.object+json' } }).single).toBe(true)
    expect(req('todos', { headers: { accept: 'text/csv' } }).mediaType).toBe('csv')
  })

  it('parses write bodies and resolution', () => {
    const parsed = req('todos', {
      method: 'POST',
      headers: { prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify([{ task: 'x' }]),
    })
    expect(parsed.resolution).toBe('merge')
    expect(parsed.returnRepresentation).toBe(true)
    expect(parsed.body).toEqual([{ task: 'x' }])
  })

  it('rejects malformed JSON bodies', () => {
    expect(errorCode(() => req('todos', { method: 'POST', body: '{not json' }))).toBe('PGRST102')
  })
})

describe('dropped-filter guards', () => {
  it('rejects a dotted filter whose embed is not selected', () => {
    expect(errorCode(() => req('users?select=*&a.b=eq.1'))).toBe('PGRST100')
    expect(errorCode(() => req('users?select=id&posts.limit=5'))).toBe('PGRST100')
  })

  it('accepts a dotted filter when the embed is selected (by name or alias)', () => {
    expect(errorCode(() => req('users?select=id,posts(id)&posts.id=eq.1'))).toBeUndefined()
    expect(errorCode(() => req('users?select=id,p:posts(id)&p.id=eq.1'))).toBeUndefined()
    expect(errorCode(() => req('users?select=id,posts(id,comments(id))&posts.comments.id=eq.1'))).toBeUndefined()
  })

  it('rejects reserved parameter names used as filter columns', () => {
    expect(errorCode(() => req('users?select=eq.1'))).toBe('PGFLUENT_INVALID_QUERY')
    expect(errorCode(() => req('users?columns=eq.1'))).toBe('PGFLUENT_INVALID_QUERY')
    expect(errorCode(() => req('users?on_conflict=neq.1'))).toBe('PGFLUENT_INVALID_QUERY')
  })

  it('still accepts normal select/columns/on_conflict values', () => {
    expect(errorCode(() => req('users?select=id,name&columns=id,name&on_conflict=id'))).toBeUndefined()
  })
})

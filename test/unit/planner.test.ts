import { describe, expect, it } from 'vitest'
import { parseRequest } from '../../src/parser/request.js'
import { parseFilters } from '../../src/parser/filter.js'
import { planRead } from '../../src/planner/read.js'
import { planWrite } from '../../src/planner/write.js'
import { renderWhere } from '../../src/planner/where.js'
import { ParamBag } from '../../src/sql/builder.js'
import type { SchemaCache } from '../../src/schema/cache.js'

const ctx = { schemas: ['public'], defaultSchema: 'public' }

function plan(url: string, method = 'GET', body?: string, headers: Record<string, string> = {}) {
  const req = parseRequest(
    { url: `http://pg-fluent.local/${url}`, method, headers, body },
    ctx
  )
  return { req, read: () => planRead(req, { maxRows: 1000 }) }
}

const tableInfo = {
  schema: 'public',
  name: 'todos',
  columns: [
    { name: 'id', hasDefault: true, generated: false, identity: true, nullable: false },
    { name: 'task', hasDefault: false, generated: false, identity: false, nullable: false },
    { name: 'done', hasDefault: true, generated: false, identity: false, nullable: false },
  ],
  primaryKey: ['id'],
}

const mockCache = {
  getTable: async () => tableInfo,
} as unknown as SchemaCache

describe('planRead', () => {
  it('builds a shaped select with filters, order and limit', () => {
    const { read } = plan('todos?select=id,task&done=eq.false&order=id.desc&limit=5&offset=10')
    const p = read()
    expect(p.text).toContain('json_agg')
    expect(p.text).toContain('row_to_json')
    expect(p.text).toContain('"public"."todos"')
    expect(p.text).toContain('ORDER BY "pgfl_base"."id" DESC')
    expect(p.text).toContain('LIMIT 5')
    expect(p.text).toContain('OFFSET 10')
    expect(p.values).toEqual(['false'])
  })

  it('adds an exact count column over the filtered set', () => {
    const { read } = plan('todos?select=id&done=eq.true', 'GET', undefined, { prefer: 'count=exact' })
    expect(read().text).toContain('__pgfl_count')
  })

  it('clamps the limit to maxRows', () => {
    const req = parseRequest({ url: 'http://x/todos?select=id&limit=99999', method: 'GET', headers: {} }, ctx)
    expect(planRead(req, { maxRows: 100 }).text).toContain('LIMIT 100')
  })

  it('applies maxRows as a default cap', () => {
    const req = parseRequest({ url: 'http://x/todos?select=id', method: 'GET', headers: {} }, ctx)
    expect(planRead(req, { maxRows: 50 }).text).toContain('LIMIT 50')
  })

  it('keeps injection attempts in values, never in SQL text', () => {
    const { read } = plan(`todos?select=id&task=eq.${encodeURIComponent("'; drop table users; --")}`)
    const p = read()
    expect(p.text).not.toContain('drop table')
    expect(p.values).toContain("'; drop table users; --")
  })
})

describe('filter SQL rendering', () => {
  function where(query: string) {
    const bag = new ParamBag()
    const { filters } = parseFilters(new URLSearchParams(query))
    return { text: renderWhere(filters, bag, '"t"'), values: bag.values }
  }

  it('maps range operators to the correct PostgreSQL operators', () => {
    expect(where('a=sl.5').text).toContain('"t"."a" << $1')
    expect(where('a=sr.5').text).toContain('"t"."a" >> $1')
    expect(where('a=nxr.5').text).toContain('"t"."a" &< $1')
    expect(where('a=nxl.5').text).toContain('"t"."a" &> $1')
    expect(where('a=adj.5').text).toContain('"t"."a" -|- $1')
  })

  it('renders an empty in-list as FALSE', () => {
    const { text, values } = where('a=in.()')
    expect(text).toBe('FALSE')
    expect(values).toEqual([])
  })

  it('supports is.not_null', () => {
    expect(where('a=is.not_null').text).toBe('"t"."a" IS NOT NULL')
  })

  it('treats eq.null / neq.null as IS NULL / IS NOT NULL', () => {
    expect(where('a=eq.null').text).toBe('"t"."a" IS NULL')
    expect(where('a=neq.null').text).toBe('"t"."a" IS NOT NULL')
    expect(where('a=eq.1').text).toBe('"t"."a" = $1')
    expect(where('a=neq.1').text).toBe('"t"."a" <> $1')
  })

  it('keeps range literals (with commas) intact inside or()/and()', () => {
    const { text, values } = where('or=rng.adj.[5,7),task.eq.write spec')
    expect(text).toContain('"t"."rng" -|- $1')
    expect(text).toContain('"t"."task" = $2')
    expect(values).toEqual(['[5,7)', 'write spec'])
  })

  it('translates * to % for like/ilike', () => {
    const single = where('a=like.*gerald*')
    expect(single.text).toContain('"t"."a" LIKE $1')
    expect(single.values).toEqual(['%gerald%'])
    const list = where('a=ilike(any).{*x,*y}')
    expect(list.text).toContain('ILIKE ANY($1::text[])')
    expect(list.values).toEqual([['%x', '%y']])
  })

  it('renders the remaining comparison, array, regex and text-search operators', () => {
    expect(where('a=neq.1').text).toContain('"t"."a" <> $1')
    expect(where('a=gt.1').text).toContain('"t"."a" > $1')
    expect(where('a=gte.1').text).toContain('"t"."a" >= $1')
    expect(where('a=lt.1').text).toContain('"t"."a" < $1')
    expect(where('a=lte.1').text).toContain('"t"."a" <= $1')
    expect(where('a=match.^x').text).toContain('"t"."a" ~ $1')
    expect(where('a=imatch.^x').text).toContain('"t"."a" ~* $1')
    expect(where('a=isdistinct.1').text).toContain('"t"."a" IS DISTINCT FROM $1')
    expect(where('a=cs.{1}').text).toContain('"t"."a" @> $1')
    expect(where('a=cd.{1}').text).toContain('"t"."a" <@ $1')
    expect(where('a=ov.{1}').text).toContain('"t"."a" && $1')
    expect(where('a=fts.cat').text).toContain('to_tsquery($1)')
    expect(where('a=plfts.cat').text).toContain('plainto_tsquery($1)')
    expect(where('a=phfts.cat').text).toContain('phraseto_tsquery($1)')
    expect(where('a=wfts.cat').text).toContain('websearch_to_tsquery($1)')
    expect(where('a=fts(english).cat').text).toContain('to_tsquery($1::regconfig, $2)')
  })

  it('renders is, negation and logical trees', () => {
    expect(where('a=is.true').text).toBe('"t"."a" IS TRUE')
    expect(where('a=is.false').text).toBe('"t"."a" IS FALSE')
    expect(where('a=is.unknown').text).toBe('"t"."a" IS UNKNOWN')
    expect(where('a=not.eq.1').text).toBe('NOT ("t"."a" = $1)')
    expect(where('or=(a.eq.1,b.gt.2)').text).toContain('("t"."a" = $1 OR "t"."b" > $2)')
  })

  it('wraps JSON access in to_jsonb and treats numeric keys as array indices', () => {
    expect(where('tags->>0=eq.x').text).toContain('to_jsonb("t"."tags")->>0')
    expect(where('tags->>0=eq.x').values).toEqual(['x'])
    expect(where('meta->>author=eq.x').text).toContain('to_jsonb("t"."meta")->>($1::text)')
  })
})

describe('planWrite', () => {
  it('expands insert bodies through json_populate_recordset', async () => {
    const { req } = plan('todos?select=id', 'POST', JSON.stringify({ task: 'x', done: false }), {
      prefer: 'return=representation',
    })
    const p = await planWrite(req, { allowUnfilteredMutations: false, schemaCache: mockCache })
    expect(p.text).toContain('INSERT INTO "public"."todos"')
    expect(p.text).toContain('json_populate_recordset')
    expect(p.text).toContain('RETURNING')
    expect(p.values).toHaveLength(1)
    expect(JSON.parse(String(p.values[0]))).toEqual([{ task: 'x', done: false }])
  })

  it('refuses unfiltered mutations by default', async () => {
    const { req } = plan('todos', 'DELETE')
    await expect(planWrite(req, { allowUnfilteredMutations: false, schemaCache: mockCache })).rejects.toThrow(
      /unfiltered/i
    )
  })

  it('builds an upsert with an on-conflict target', async () => {
    const { req } = plan('todos?on_conflict=id', 'POST', JSON.stringify({ id: 1, task: 'x' }), {
      prefer: 'resolution=merge-duplicates,return=representation',
    })
    const p = await planWrite(req, { allowUnfilteredMutations: false, schemaCache: mockCache })
    expect(p.text).toContain('ON CONFLICT ("id") DO UPDATE SET')
  })

  it('rejects unknown columns', async () => {
    const { req } = plan('todos', 'POST', JSON.stringify({ nope: 1 }))
    await expect(
      planWrite(req, { allowUnfilteredMutations: false, schemaCache: mockCache })
    ).rejects.toMatchObject({ code: 'PGRST204' })
  })
})

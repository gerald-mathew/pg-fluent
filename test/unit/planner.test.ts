import { describe, expect, it } from 'vitest'
import { parseRequest } from '../../src/parser/request.js'
import { planRead } from '../../src/planner/read.js'
import { planWrite } from '../../src/planner/write.js'
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

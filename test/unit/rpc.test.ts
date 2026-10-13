import { describe, expect, it } from 'vitest'
import { planRpc } from '../../src/planner/rpc.js'
import { parseRequest } from '../../src/parser/request.js'
import type { FunctionInfo, SchemaCache } from '../../src/schema/cache.js'

const ctx = { schemas: ['public'], defaultSchema: 'public' }

function fn(partial: Partial<FunctionInfo>): FunctionInfo {
  return {
    schema: 'public',
    name: 'f',
    returnsSet: false,
    returnsRows: false,
    volatility: 'volatile',
    args: [],
    ...partial,
  }
}

function cacheWith(overloads: FunctionInfo[]): SchemaCache {
  return { getFunction: async () => overloads } as unknown as SchemaCache
}

function request(url: string, init: { method?: string; body?: string } = {}) {
  return parseRequest(
    { url: `http://x/${url}`, method: init.method ?? 'GET', headers: {}, body: init.body },
    ctx
  )
}

describe('planRpc', () => {
  it('errors with PGRST202 for an unknown function', async () => {
    const req = request('rpc/nope', { method: 'POST', body: '{}' })
    await expect(planRpc(req, { maxRows: 1000, schemaCache: cacheWith([]) })).rejects.toMatchObject({
      code: 'PGRST202',
    })
  })

  it('errors with PGRST203 on ambiguous overloads', async () => {
    const overloads = [
      fn({ args: [{ name: 'a', type: 'integer', hasDefault: false }] }),
      fn({ args: [{ name: 'a', type: 'bigint', hasDefault: false }] }),
    ]
    const req = request('rpc/f', { method: 'POST', body: JSON.stringify({ a: 1 }) })
    await expect(
      planRpc(req, { maxRows: 1000, schemaCache: cacheWith(overloads) })
    ).rejects.toMatchObject({ code: 'PGRST203' })
  })

  it('binds named arguments for a scalar function', async () => {
    const overloads = [
      fn({ args: [{ name: 'a', type: 'integer', hasDefault: false }, { name: 'b', type: 'integer', hasDefault: false }] }),
    ]
    const req = request('rpc/f', { method: 'POST', body: JSON.stringify({ a: 1, b: 2 }) })
    const plan = await planRpc(req, { maxRows: 1000, schemaCache: cacheWith(overloads) })
    expect(plan.text).toContain('"public"."f"("a" := $1, "b" := $2)')
    expect(plan.values).toEqual([1, 2])
  })

  it('classifies GET query params into args and filters', async () => {
    const overloads = [
      fn({
        returnsSet: true,
        returnsRows: true,
        args: [{ name: 'min_id', type: 'bigint', hasDefault: false }],
      }),
    ]
    const req = request('rpc/f?min_id=2&done=eq.true')
    const plan = await planRpc(req, { maxRows: 1000, schemaCache: cacheWith(overloads) })
    expect(plan.values).toContain('2')
    expect(plan.text).toContain('"min_id" := $1')
    expect(plan.text).toContain('"done"')
  })
})

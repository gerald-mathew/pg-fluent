import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { canConnect, resetFixture, testClient } from '../helpers/db.js'

const available = await canConnect()

describe.skipIf(!available)('rpc', () => {
  const db = testClient()

  beforeAll(async () => {
    await resetFixture()
  })
  beforeEach(async () => {
    await resetFixture()
  })
  afterAll(async () => {
    await db.close()
  })

  it('calls a scalar function via POST body', async () => {
    const { data, error, status } = await db.rpc('pf_add', { a: 2, b: 3 })
    expect(error).toBeNull()
    expect(status).toBe(200)
    expect(data).toBe(5)
  })

  it('calls a scalar function via GET query args', async () => {
    const { data } = await db.rpc('pf_add', { a: 4, b: 6 }, { get: true })
    expect(data).toBe(10)
  })

  it('supports HEAD', async () => {
    const { data, status } = await db.rpc('pf_add', { a: 1, b: 1 }, { head: true })
    expect(status).toBe(200)
    expect(data).toBeNull()
  })

  it('returns rows from a set-returning function', async () => {
    const { data } = await db.rpc('pf_get_todos', { min_id: 2 })
    expect(data).toHaveLength(2)
    expect(data?.[0]).toMatchObject({ id: 2, task: 'build parser' })
  })

  it('applies select on the result', async () => {
    const { data } = await db.rpc('pf_get_todos', { min_id: 1 }).select('id')
    expect(data).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }])
  })

  it('applies filters chained on the result', async () => {
    const { data } = await db.rpc('pf_get_todos', { min_id: 1 }).eq('done', true)
    expect(data).toEqual([expect.objectContaining({ id: 1, done: true })])
  })

  it('passes a single JSON argument from the whole body', async () => {
    const { data } = await db.rpc('pf_echo_json', { hello: 'world' })
    expect(data).toEqual({ hello: 'world' })
  })

  it('passes a JSON argument by name', async () => {
    const { data } = await db.rpc('pf_echo_json', { payload: { hello: 'world' } })
    expect(data).toEqual({ hello: 'world' })
  })

  it('serialises a JSONB object argument as JSON, not an array literal', async () => {
    const { data } = await db.rpc('pf_echo_jsonb', { payload: { a: 1, b: [2, 3] } })
    expect(data).toEqual({ a: 1, b: [2, 3] })
  })

  it('serialises a JSONB array argument alongside other args', async () => {
    const { data, error } = await db.rpc('pf_tag_json', { label: 'nums', payload: [1, 2, 3] })
    expect(error).toBeNull()
    expect(data).toEqual({ label: 'nums', payload: [1, 2, 3] })
  })

  it('returns a set of scalars', async () => {
    const { data } = await db.rpc('pf_numbers')
    expect(data).toEqual([1, 2, 3])
  })

  it('maps an unknown function to PGRST202', async () => {
    const { error, status } = await db.rpc('pf_nope')
    expect(status).toBe(404)
    expect(error?.code).toBe('PGRST202')
  })
})

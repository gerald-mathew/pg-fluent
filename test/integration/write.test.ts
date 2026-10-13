import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { canConnect, resetFixture, testClient } from '../helpers/db.js'

const available = await canConnect()

describe.skipIf(!available)('write queries', () => {
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

  it('inserts and returns the row', async () => {
    const { data, status } = await db
      .from('pf_todos')
      .insert({ task: 'new', priority: 5 })
      .select()
      .single()
    expect(status).toBe(201)
    expect(data).toMatchObject({ task: 'new', priority: 5, done: false })
  })

  it('inserts without returning rows', async () => {
    const { data, status } = await db.from('pf_todos').insert({ task: 'quiet' })
    expect(status).toBe(201)
    expect(data).toBeNull()
  })

  it('bulk inserts', async () => {
    const { data, status } = await db
      .from('pf_todos')
      .insert([{ task: 'b1' }, { task: 'b2', priority: 9 }])
      .select('task, priority')
    expect(status).toBe(201)
    expect(data).toEqual([
      { task: 'b1', priority: null },
      { task: 'b2', priority: 9 },
    ])
  })

  it('updates matching rows', async () => {
    const { data, status } = await db
      .from('pf_todos')
      .update({ done: true })
      .eq('id', 1)
      .select('id, done')
    expect(status).toBe(200)
    expect(data).toEqual([{ id: 1, done: true }])
  })

  it('updates without returning rows', async () => {
    const { status, data } = await db.from('pf_todos').update({ done: true }).eq('id', 2)
    expect(status).toBe(204)
    expect(data).toBeNull()
  })

  it('upserts with merge and ignore strategies', async () => {
    const merged = await db
      .from('pf_todos')
      .upsert({ id: 1, task: 'updated', priority: 1 }, { onConflict: 'id' })
      .select('id, task')
    expect(merged.data).toEqual([{ id: 1, task: 'updated' }])

    const ignored = await db
      .from('pf_todos')
      .upsert({ id: 1, task: 'ignored' }, { onConflict: 'id', ignoreDuplicates: true })
      .select('id, task')
    expect(ignored.data).toEqual([])
  })

  it('deletes matching rows', async () => {
    const { data, status } = await db.from('pf_todos').delete().eq('id', 3).select('id')
    expect(status).toBe(200)
    expect(data).toEqual([{ id: 3 }])
  })

  it('refuses unfiltered mutations', async () => {
    const { error, status } = await db.from('pf_todos').delete()
    expect(status).toBe(400)
    expect(error?.code).toBe('PGFLUENT_UNFILTERED_MUTATION')
  })

  it('rejects unknown columns with PGRST204', async () => {
    const { error, status } = await db.from('pf_todos').insert({ nope: 1 }).select()
    expect(status).toBe(400)
    expect(error?.code).toBe('PGRST204')
  })

  it('maps constraint violations to 409', async () => {
    const { error, status } = await db.from('pf_users').insert({ name: 'gerald' })
    expect(status).toBe(409)
    expect(error?.code).toBe('23505')
  })
})

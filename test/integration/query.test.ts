import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { canConnect, resetFixture, testClient } from '../helpers/db.js'

const available = await canConnect()

describe.skipIf(!available)('read queries', () => {
  const db = testClient()

  beforeAll(async () => {
    await resetFixture()
  })
  afterAll(async () => {
    await db.close()
  })

  it('selects and orders rows', async () => {
    const { data, error } = await db.from('pf_todos').select('id, task').order('id')
    expect(error).toBeNull()
    expect(data).toEqual([
      { id: 1, task: 'write spec' },
      { id: 2, task: 'build parser' },
      { id: 3, task: 'ship v1' },
    ])
  })

  it('filters by boolean and orders by priority', async () => {
    const { data } = await db.from('pf_todos').select('task').eq('done', false).order('priority')
    expect(data).toEqual([{ task: 'build parser' }, { task: 'ship v1' }])
  })

  it('returns an exact count with head', async () => {
    const { data, count, status } = await db
      .from('pf_todos')
      .select('*', { count: 'exact', head: true })
      .eq('done', false)
    expect(data).toBeNull()
    expect(count).toBe(2)
    expect(status).toBe(200)
  })

  it('supports single and maybeSingle', async () => {
    const one = await db.from('pf_todos').select('task').eq('id', 1).single()
    expect(one.data).toEqual({ task: 'write spec' })
    const none = await db.from('pf_todos').select('*').eq('id', 999).maybeSingle()
    expect(none.data).toBeNull()
    expect(none.error).toBeNull()
  })

  it('raises PGRST116 for single with multiple rows', async () => {
    const { error, status } = await db.from('pf_todos').select('*').eq('done', false).single()
    expect(status).toBe(406)
    expect(error?.code).toBe('PGRST116')
  })

  it('handles in, or, contains and full-text search', async () => {
    const inList = await db.from('pf_todos').select('id').in('id', [1, 3]).order('id')
    expect(inList.data).toEqual([{ id: 1 }, { id: 3 }])

    const or = await db.from('pf_todos').select('id').or('priority.eq.1,priority.eq.2').order('id')
    expect(or.data).toEqual([{ id: 1 }, { id: 2 }])

    const contains = await db.from('pf_todos').select('id').contains('tags', ['code'])
    expect(contains.data).toEqual([{ id: 2 }])

    const search = await db.from('pf_todos').select('id').textSearch('task', 'parser')
    expect(search.data).toEqual([{ id: 2 }])
  })

  it('supports JSON path reads and filters', async () => {
    const { data } = await db
      .from('pf_todos')
      .select('id, meta->>author')
      .eq('meta->>author', 'gerald')
      .order('id')
    expect(data).toEqual([
      { id: 1, author: 'gerald' },
      { id: 2, author: 'gerald' },
    ])
  })

  it('paginates with range while keeping the total count', async () => {
    const { data, count } = await db
      .from('pf_todos')
      .select('id', { count: 'exact' })
      .order('id')
      .range(1, 2)
    expect(data).toEqual([{ id: 2 }, { id: 3 }])
    expect(count).toBe(3)
  })

  it('returns CSV', async () => {
    const { data } = await db.from('pf_todos').select('id, task').order('id').csv()
    expect(data).toBe('id,task\n1,write spec\n2,build parser\n3,ship v1\n')
  })

  it('maps undefined tables to 404', async () => {
    const { error, status } = await db.from('pf_missing').select('*')
    expect(status).toBe(404)
    expect(error?.code).toBe('42P01')
  })

  it('caps results at maxRows', async () => {
    const capped = testClient({ maxRows: 2 })
    try {
      const { data } = await capped.from('pf_todos').select('id', { count: 'exact' }).order('id')
      expect(data).toHaveLength(2)
    } finally {
      await capped.close()
    }
  })
})

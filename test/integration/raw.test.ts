import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { canConnect, resetFixture, testClient } from '../helpers/db.js'

const available = await canConnect()

describe.skipIf(!available)('raw sql', () => {
  const db = testClient()

  beforeEach(async () => {
    await resetFixture()
  })
  afterAll(async () => {
    await db.close()
  })

  it('binds values with the sql tag', async () => {
    const { data, error, status } =
      await db.sql`select id::int as id, task from pf_todos where id = ${1}`
    expect(error).toBeNull()
    expect(status).toBe(200)
    expect(data).toEqual([{ id: 1, task: 'write spec' }])
  })

  it('quotes identifiers', async () => {
    const { data } = await db.sql`select count(*)::int as n from ${db.identifier('pf_todos')}`
    expect(data).toEqual([{ n: 3 }])
  })

  it('composes nested sql fragments with shared parameters', async () => {
    const base = db.sql`select task from pf_todos where done = ${false}`
    const { data } = await db.sql`${base} and priority >= ${2} order by priority`
    expect((data as { task: string }[]).map((r) => r.task)).toEqual(['build parser', 'ship v1'])
  })

  it('binds values with unsafe', async () => {
    const { data, count } = await db.unsafe<{ n: number }>('select $1::int as n', [7])
    expect(data).toEqual([{ n: 7 }])
    expect(count).toBe(1)
  })

  it('classifies errors', async () => {
    const { data, error, status } = await db.sql`select * from pf_missing`
    expect(data).toBeNull()
    expect(error?.code).toBe('42P01')
    expect(status).toBe(404)
  })

  it('never interpolates values into SQL text', async () => {
    const evil = "x'; drop table pf_todos; --"
    const { data } = await db.sql<{ v: string }>`select ${evil} as v`
    expect(data).toEqual([{ v: evil }])
    const { count } = await db.from('pf_todos').select('*', { count: 'exact', head: true })
    expect(count).toBe(3)
  })
})

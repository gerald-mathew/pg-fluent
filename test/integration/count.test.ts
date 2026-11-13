import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { canConnect, resetFixture, testClient } from '../helpers/db.js'

const available = await canConnect()

describe.skipIf(!available)('count modes', () => {
  const db = testClient()

  beforeEach(async () => {
    await resetFixture()
  })
  afterAll(async () => {
    await db.close()
  })

  it('returns an exact count for estimated when under maxRows', async () => {
    const capped = testClient({ maxRows: 100 })
    try {
      const { count } = await capped.from('pf_todos').select('id', { count: 'estimated' })
      expect(count).toBe(3)
    } finally {
      await capped.close()
    }
  })

  it('returns a planner-based count for estimated when maxRows is exceeded', async () => {
    const capped = testClient({ maxRows: 2 })
    try {
      const { count, status } = await capped.from('pf_todos').select('id', { count: 'estimated' })
      expect(status).toBe(200)
      expect(count).toBeGreaterThanOrEqual(3)
    } finally {
      await capped.close()
    }
  })

  it('returns an exact count for estimated when maxRows is infinite', async () => {
    const uncapped = testClient({ maxRows: Infinity })
    try {
      const { count } = await uncapped.from('pf_todos').select('id', { count: 'estimated' })
      expect(count).toBe(3)
    } finally {
      await uncapped.close()
    }
  })

  it('returns a planner-based count for planned', async () => {
    const { count, status } = await db.from('pf_todos').select('id', { count: 'planned' })
    expect(status).toBe(200)
    expect(typeof count).toBe('number')
  })

  it('includes !inner conditions in planned counts', async () => {
    const { data, count, status } = await db
      .from('pf_users')
      .select('name, pf_posts!inner(title)', { count: 'planned' })
      .eq('pf_posts.title', 'hello')
    expect(status).toBe(200)
    expect(data).toEqual([{ name: 'alice', pf_posts: [{ title: 'hello' }] }])
    expect(typeof count).toBe('number')
  })

  it('includes !inner conditions in estimated counts', async () => {
    const { data, count } = await db
      .from('pf_users')
      .select('name, pf_posts!inner(title)', { count: 'estimated' })
      .eq('pf_posts.title', 'hello')
    expect(data).toEqual([{ name: 'alice', pf_posts: [{ title: 'hello' }] }])
    expect(count).toBe(1)
  })
})

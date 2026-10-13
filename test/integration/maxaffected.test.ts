import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { canConnect, resetFixture, testClient } from '../helpers/db.js'

const available = await canConnect()

describe.skipIf(!available)('max-affected and tx=rollback', () => {
  const db = testClient()

  beforeEach(async () => {
    await resetFixture()
  })
  afterAll(async () => {
    await db.close()
  })

  it('rejects and rolls back when the limit is exceeded', async () => {
    const { error, status } = await db
      .from('pf_todos')
      .update({ done: true })
      .eq('done', false)
      .maxAffected(1)
      .select('id')
    expect(status).toBe(400)
    expect(error?.code).toBe('PGRST124')

    const { data } = await db.from('pf_todos').select('id, done').eq('done', false)
    expect(data).toHaveLength(2)
  })

  it('succeeds when within the limit', async () => {
    const { data, error } = await db
      .from('pf_todos')
      .update({ done: true })
      .eq('done', false)
      .maxAffected(5)
      .select('id, done')
    expect(error).toBeNull()
    expect(data).toHaveLength(2)
  })

  it('counts affected rows for deletes', async () => {
    const { error } = await db.from('pf_posts').delete().gte('id', 1).maxAffected(1).select('id')
    expect(error?.code).toBe('PGRST124')
    const { count } = await db.from('pf_posts').select('*', { count: 'exact', head: true })
    expect(count).toBe(3)
  })

  it('commits when max-affected is within the limit', async () => {
    await db.from('pf_todos').update({ done: true }).eq('done', false).maxAffected(5)
    const { data } = await db.from('pf_todos').select('id').eq('done', false)
    expect(data).toEqual([])
  })

  it('rolls back a mutation with tx=rollback but returns the rows', async () => {
    const { data } = await db
      .from('pf_todos')
      .update({ done: true })
      .eq('id', 2)
      .rollback()
      .select('id, done')
    expect(data).toEqual([{ id: 2, done: true }])

    const { data: after } = await db.from('pf_todos').select('done').eq('id', 2).single()
    expect(after).toEqual({ done: false })
  })
})

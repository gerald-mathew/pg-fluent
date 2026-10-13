import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { canConnect, resetFixture, testClient } from '../helpers/db.js'

const available = await canConnect()

describe.skipIf(!available)('transactions', () => {
  const db = testClient()

  beforeEach(async () => {
    await resetFixture()
  })
  afterAll(async () => {
    await db.close()
  })

  it('commits changes made in the callback', async () => {
    const result = await db.transaction(async (trx) => {
      const { data, error } = await trx
        .from('pf_todos')
        .insert({ task: 'tx-commit' })
        .select('id, task')
        .single()
      expect(error).toBeNull()
      return data
    })
    expect(result).toMatchObject({ task: 'tx-commit' })
    const { data } = await db.from('pf_todos').select('task').eq('task', 'tx-commit')
    expect(data).toEqual([{ task: 'tx-commit' }])
  })

  it('rolls back and rejects when the callback throws', async () => {
    await expect(
      db.transaction(async (trx) => {
        await trx.from('pf_todos').insert({ task: 'tx-throw' })
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    const { data } = await db.from('pf_todos').select('task').eq('task', 'tx-throw')
    expect(data).toEqual([])
  })

  it('resolves undefined and rolls back on trx.rollback()', async () => {
    const result = await db.transaction(async (trx) => {
      await trx.from('pf_todos').insert({ task: 'tx-explicit' })
      trx.rollback()
    })
    expect(result).toBeUndefined()
    const { data } = await db.from('pf_todos').select('task').eq('task', 'tx-explicit')
    expect(data).toEqual([])
  })

  it('uses savepoints for nested transactions', async () => {
    await db.transaction(async (trx) => {
      await trx.from('pf_todos').insert({ task: 'tx-outer' })
      await expect(
        trx.transaction(async (sp) => {
          await sp.from('pf_todos').insert({ task: 'tx-inner' })
          throw new Error('inner-boom')
        })
      ).rejects.toThrow('inner-boom')
    })
    const { data } = await db
      .from('pf_todos')
      .select('task')
      .in('task', ['tx-outer', 'tx-inner'])
    expect(data).toEqual([{ task: 'tx-outer' }])
  })

  it('enforces read-only transactions', async () => {
    const result = await db.transaction(
      async (trx) => trx.unsafe('insert into pf_todos (task) values ($1) returning id', ['ro']),
      { readOnly: true }
    )
    expect(result.error?.code).toBe('25006')
    const { data } = await db.from('pf_todos').select('task').eq('task', 'ro')
    expect(data).toEqual([])
  })
})

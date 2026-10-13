import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { canConnect, resetFixture, testClient } from '../helpers/db.js'

const available = await canConnect()

describe.skipIf(!available)('copyFrom', () => {
  const db = testClient()

  beforeAll(async () => {
    await resetFixture()
  })
  afterAll(async () => {
    await db.close()
  })

  it('bulk loads an array of rows', async () => {
    const { data, error } = await db.copyFrom('pf_todos', [
      { task: 'copy one', done: false },
      { task: 'copy two', done: true },
      { task: 'copy three', done: false },
    ], { columns: ['task', 'done'] })
    expect(error).toBeNull()
    expect(data).toEqual({ rowCount: 3 })

    const { data: rows } = await db
      .from('pf_todos')
      .select('task, done')
      .like('task', 'copy %')
      .order('task')
    expect(rows).toEqual([
      { task: 'copy one', done: false },
      { task: 'copy three', done: false },
      { task: 'copy two', done: true },
    ])
  })

  it('bulk loads from an async iterable', async () => {
    async function* rows() {
      yield { task: 'stream a', done: false }
      yield { task: 'stream b', done: false }
    }
    const { data, error } = await db.copyFrom('pf_todos', rows(), { columns: ['task', 'done'] })
    expect(error).toBeNull()
    expect(data?.rowCount).toBe(2)
  })

  it('escapes commas, quotes and newlines', async () => {
    const tricky = 'He said "hi", then\nleft'
    const { error } = await db.copyFrom('pf_todos', [{ task: tricky, done: false }], {
      columns: ['task', 'done'],
    })
    expect(error).toBeNull()
    const { data } = await db.from('pf_todos').select('task').eq('task', tricky).single()
    expect(data).toEqual({ task: tricky })
  })

  it('infers columns from the first row', async () => {
    const { data, error } = await db.copyFrom('pf_todos', [{ task: 'inferred', done: true }])
    expect(error).toBeNull()
    expect(data?.rowCount).toBe(1)
  })

  it('returns an error for an unknown table', async () => {
    const { data, error } = await db.copyFrom('pf_missing', [{ x: 1 }], { columns: ['x'] })
    expect(data).toBeNull()
    expect(error).not.toBeNull()
  })
})

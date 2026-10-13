import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { canConnect, resetFixture, testClient } from '../helpers/db.js'

const available = await canConnect()

describe.skipIf(!available)('streaming', () => {
  const db = testClient()

  beforeAll(async () => {
    await resetFixture()
  })
  afterAll(async () => {
    await db.close()
  })

  it('streams rows one by one', async () => {
    const rows: Array<Record<string, unknown>> = []
    for await (const row of db.from('pf_todos').select('id, task').order('id').stream()) {
      rows.push(row)
    }
    expect(rows).toEqual([
      { id: 1, task: 'write spec' },
      { id: 2, task: 'build parser' },
      { id: 3, task: 'ship v1' },
    ])
  })

  it('collects all rows when awaited', async () => {
    const { data, error } = await db.from('pf_todos').select('id').order('id').stream()
    expect(error).toBeNull()
    expect(data).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }])
  })

  it('streams embedded resources as JSON per row', async () => {
    const rows: Array<Record<string, unknown>> = []
    for await (const row of db
      .from('pf_users')
      .select('name, pf_posts(title)')
      .order('name')
      .stream()) {
      rows.push(row)
    }
    expect(rows).toEqual([
      { name: 'alice', pf_posts: [{ title: 'hello' }] },
      { name: 'gerald', pf_posts: [{ title: 'first post' }, { title: 'second post' }] },
    ])
  })

  it('honours filters and limits while streaming', async () => {
    const rows: Array<Record<string, unknown>> = []
    for await (const row of db
      .from('pf_todos')
      .select('id, done')
      .eq('done', false)
      .order('id')
      .limit(1)
      .stream()) {
      rows.push(row)
    }
    expect(rows).toEqual([{ id: 2, done: false }])
  })

  it('rejects streaming combined with a count option', async () => {
    const { error } = await db.from('pf_todos').select('id', { count: 'exact' }).stream()
    expect(error).not.toBeNull()
    expect(String((error as { message?: string })?.message)).toMatch(/count/i)
  })

  it('rejects streaming combined with single()', async () => {
    await expect(async () => {
      for await (const _row of db.from('pf_todos').select('id').single().stream()) {
        void _row
      }
    }).rejects.toMatchObject({ message: expect.stringMatching(/single/i) })
  })

  it('stops reading when the iterator is returned early', async () => {
    const iterator = db.from('pf_todos').select('id').order('id').stream()[Symbol.asyncIterator]()
    const first = await iterator.next()
    expect(first.value).toEqual({ id: 1 })
    await iterator.return?.(undefined)
  })
})

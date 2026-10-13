import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { canConnect, resetFixture, testClient } from '../helpers/db.js'

const available = await canConnect()

describe.skipIf(!available)('phase 5: spread, related ordering, embedded filters', () => {
  const db = testClient()

  beforeAll(async () => {
    await resetFixture()
  })
  afterAll(async () => {
    await db.close()
  })

  it('spreads a to-one embed into parent columns', async () => {
    const { data, error } = await db
      .from('pf_posts')
      .select('id, title, ...pf_users(name)')
      .order('id')
    expect(error).toBeNull()
    expect(data).toEqual([
      { id: 1, title: 'first post', name: 'gerald' },
      { id: 2, title: 'second post', name: 'gerald' },
      { id: 3, title: 'hello', name: 'alice' },
    ])
  })

  it('spreads selected columns only', async () => {
    const { data } = await db
      .from('pf_posts')
      .select('title, ...pf_users(name)')
      .eq('id', 3)
      .single()
    expect(data).toEqual({ title: 'hello', name: 'alice' })
  })

  it('rejects spreading a to-many relationship', async () => {
    const { data, error } = await db.from('pf_users').select('name, ...pf_posts(title)')
    expect(data).toBeNull()
    expect(error?.message).toMatch(/only supported for to-one/i)
  })

  it('rejects aggregates inside a spread', async () => {
    const { data, error } = await db.from('pf_posts').select('id, ...pf_users(count())')
    expect(data).toBeNull()
    expect(error?.message).toMatch(/spread/i)
  })

  it('orders by a to-one related column', async () => {
    const { data, error } = await db
      .from('pf_posts')
      .select('id, title, pf_users(name)')
      .order('pf_users(name)')
      .order('id')
    expect(error).toBeNull()
    expect(data?.map((r: { id: number }) => r.id)).toEqual([3, 1, 2])
  })

  it('orders by a to-one related column descending', async () => {
    const { data } = await db
      .from('pf_posts')
      .select('id')
      .order('pf_users(name)', { ascending: false })
      .order('id')
    expect(data?.map((r: { id: number }) => r.id)).toEqual([1, 2, 3])
  })

  it('filters parents with a top-level or across an embed', async () => {
    const { data, error } = await db
      .from('pf_users')
      .select('name, pf_posts(title)')
      .or('pf_posts.title.eq.hello,pf_posts.title.eq.missing')
      .order('name')
    expect(error).toBeNull()
    expect(data).toEqual([{ name: 'alice', pf_posts: [{ title: 'hello' }] }])
  })

  it('mixes plain and embedded conditions in one or', async () => {
    const { data } = await db
      .from('pf_users')
      .select('name')
      .or('name.eq.alice,pf_posts.title.eq.first post')
      .order('name')
    expect(data).toEqual([{ name: 'alice' }, { name: 'gerald' }])
  })

  it('supports and around embedded conditions', async () => {
    const { data, error } = await db
      .from('pf_users')
      .select('name, pf_posts!inner(title)')
      .or('and(pf_posts.title.eq.first post,pf_posts.title.eq.second post),name.eq.nobody')
      .order('name')
    expect(error).toBeNull()
    expect(data).toEqual([
      { name: 'gerald', pf_posts: [{ title: 'first post' }, { title: 'second post' }] },
    ])
  })
})

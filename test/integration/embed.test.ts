import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { canConnect, resetFixture, testClient } from '../helpers/db.js'

const available = await canConnect()

describe.skipIf(!available)('embedded resources', () => {
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

  it('embeds a to-one relationship', async () => {
    const { data, error } = await db.from('pf_posts').select('id, title, pf_users(name)').order('id')
    expect(error).toBeNull()
    expect(data).toEqual([
      { id: 1, title: 'first post', pf_users: { name: 'gerald' } },
      { id: 2, title: 'second post', pf_users: { name: 'gerald' } },
      { id: 3, title: 'hello', pf_users: { name: 'alice' } },
    ])
  })

  it('supports an embed alias', async () => {
    const { data } = await db.from('pf_posts').select('title, author:pf_users(name)').eq('id', 3)
    expect(data).toEqual([{ title: 'hello', author: { name: 'alice' } }])
  })

  it('embeds a to-many relationship', async () => {
    const { data } = await db.from('pf_users').select('name, pf_posts(title)').order('name')
    expect(data).toEqual([
      { name: 'alice', pf_posts: [{ title: 'hello' }] },
      { name: 'gerald', pf_posts: [{ title: 'first post' }, { title: 'second post' }] },
    ])
  })

  it('supports nested embeds', async () => {
    const { data } = await db
      .from('pf_users')
      .select('name, pf_posts(id, pf_users(name))')
      .eq('name', 'gerald')
      .single()
    expect(data).toMatchObject({
      name: 'gerald',
      pf_posts: [
        { id: 1, pf_users: { name: 'gerald' } },
        { id: 2, pf_users: { name: 'gerald' } },
      ],
    })
  })

  it('filters parents by an embedded filter with !inner', async () => {
    const { data } = await db
      .from('pf_users')
      .select('name, pf_posts!inner(title)')
      .eq('pf_posts.title', 'hello')
    expect(data).toEqual([{ name: 'alice', pf_posts: [{ title: 'hello' }] }])
  })

  it('embeds through a junction table (many-to-many)', async () => {
    const { data } = await db.from('pf_todos').select('id, pf_tags(tag)').eq('id', 1).single()
    expect(data).toMatchObject({
      id: 1,
      pf_tags: [{ tag: 'urgent' }, { tag: 'work' }],
    })
  })

  it('orders and aliases embedded columns', async () => {
    const { data } = await db
      .from('pf_users')
      .select('name, posts:pf_posts(title)')
      .eq('name', 'gerald')
      .single()
    expect(data).toMatchObject({ name: 'gerald', posts: [{ title: 'first post' }, { title: 'second post' }] })
  })

  it('maps a missing relationship to PGRST200', async () => {
    const { error, status } = await db.from('pf_users').select('pf_todos(*)')
    expect(status).toBe(400)
    expect(error?.code).toBe('PGRST200')
  })
})

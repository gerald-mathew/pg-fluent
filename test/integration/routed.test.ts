import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { canConnect, resetFixture, TEST_SCHEMA, TEST_URL } from '../helpers/db.js'
import { createClient } from '../../src/index.js'

const available = await canConnect()

describe.skipIf(!available)('routed connections', () => {
  afterAll(() => {
    // Nothing to clean up: clients close their own pools below.
  })

  beforeEach(async () => {
    await resetFixture()
  })

  function searchPathPool() {
    return { options: `-c search_path=${TEST_SCHEMA}` }
  }

  it('closes primary and replica pools without double-end', async () => {
    const db = createClient({
      schemas: [TEST_SCHEMA],
      connections: {
        main: {
          primary: { connectionString: TEST_URL, pool: searchPathPool() },
          replicas: [{ connectionString: TEST_URL, pool: searchPathPool() }],
        },
      },
      defaultConnection: 'main',
    })
    const { data, error } = await db.from('pf_todos').select('id')
    expect(error).toBeNull()
    expect(Array.isArray(data)).toBe(true)
    await expect(db.close()).resolves.toBeUndefined()
  })

  it('client-level primary() returns a derived client without mutating the original', async () => {
    const db = createClient({
      connectionString: TEST_URL,
      schemas: [TEST_SCHEMA],
      pool: searchPathPool(),
    })
    const primary = db.primary()
    expect(primary).not.toBe(db)

    // Both clients remain usable.
    const a = await db.from('pf_todos').select('id')
    expect(a.error).toBeNull()
    const b = await primary.from('pf_todos').select('id')
    expect(b.error).toBeNull()

    // Closing the view must not tear down the shared pool.
    await primary.close()
    const c = await db.from('pf_todos').select('id')
    expect(c.error).toBeNull()

    await db.close()
  })
})
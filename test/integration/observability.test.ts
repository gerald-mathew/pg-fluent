import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { canConnect, resetFixture, testClient } from '../helpers/db.js'
import type { QueryEvent } from '../../src/index.js'

const available = await canConnect()

describe.skipIf(!available)('observability hooks', () => {
  const events: QueryEvent[] = []
  const db = testClient({ onQuery: (event) => events.push(event) })

  beforeAll(async () => {
    await resetFixture()
  })
  afterAll(async () => {
    await db.close()
  })

  it('emits an event for a successful select', async () => {
    events.length = 0
    const { status } = await db.from('pf_todos').select('id').limit(2)
    expect(status).toBe(200)
    expect(events).toHaveLength(1)
    const event = events[0]!
    expect(event.operation).toBe('select')
    expect(event.table).toBe('pf_todos')
    expect(event.rowCount).toBe(2)
    expect(event.route).toBe('primary')
    expect(event.connection).toBe('default')
    expect(event.retried).toBe(false)
    expect(event.params).toBeUndefined()
    expect(typeof event.durationMs).toBe('number')
  })

  it('emits an event for an insert', async () => {
    await resetFixture()
    events.length = 0
    await db.from('pf_todos').insert({ task: 'observed' }).select('id')
    const last = events.at(-1)
    expect(last?.operation).toBe('insert')
    expect(last?.table).toBe('pf_todos')
  })

  it('reports a database failure on the event', async () => {
    await resetFixture()
    const failing: QueryEvent[] = []
    const local = testClient({ onQuery: (e) => failing.push(e) })
    await local.from('pf_users').insert({ name: 'gerald' })
    const event = failing.at(-1)
    expect(event?.operation).toBe('insert')
    expect(event?.error).toBeDefined()
    await local.close()
  })
})

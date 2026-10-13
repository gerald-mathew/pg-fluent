import { describe, expect, it, vi } from 'vitest'
import { Instrument, type QueryEvent } from '../../src/observability/index.js'

function capture(): { events: QueryEvent[]; onQuery: (e: QueryEvent) => void } {
  const events: QueryEvent[] = []
  return { events, onQuery: (e) => events.push(e) }
}

describe('Instrument', () => {
  it('emits an event with metadata and no params by default', async () => {
    const { events, onQuery } = capture()
    const instrument = new Instrument({ onQuery })
    await instrument.run(
      { operation: 'select', schema: 'public', table: 'pf_todos', queryText: 'select 1', params: [1] },
      async () => ({ rows: [], rowCount: 3, attempts: 1 })
    )
    expect(events).toHaveLength(1)
    const event = events[0]!
    expect(event.operation).toBe('select')
    expect(event.table).toBe('pf_todos')
    expect(event.rowCount).toBe(3)
    expect(event.route).toBe('primary')
    expect(event.connection).toBe('default')
    expect(event.retried).toBe(false)
    expect(event.params).toBeUndefined()
    expect(typeof event.durationMs).toBe('number')
  })

  it('flags retried calls', async () => {
    const { events, onQuery } = capture()
    const instrument = new Instrument({ onQuery })
    await instrument.run(
      { operation: 'select', schema: 'public', table: 't', queryText: 'select 1' },
      async () => ({ rows: [], rowCount: 0, attempts: 3 })
    )
    expect(events[0]!.retried).toBe(true)
  })

  it('includes redacted params when logParams is enabled', async () => {
    const { events, onQuery } = capture()
    const instrument = new Instrument({ onQuery, logParams: true, redactColumns: ['password'] })
    await instrument.run(
      {
        operation: 'insert',
        schema: 'public',
        table: 'users',
        queryText: 'insert ...',
        params: [{ name: 'g', password: 'hunter2' }],
      },
      async () => ({ rows: [], rowCount: 1, attempts: 1 })
    )
    expect(events[0]!.params).toEqual([{ name: 'g', password: '[REDACTED]' }])
  })

  it('never throws when telemetry is enabled but the peer is absent', async () => {
    const instrument = new Instrument({ telemetry: true })
    await expect(
      instrument.run(
        { operation: 'select', schema: 'public', table: 't', queryText: 'select 1' },
        async () => ({ rows: [], rowCount: 0 })
      )
    ).resolves.toMatchObject({ rowCount: 0 })
  })

  it('logs debug on success and error on failure', async () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const instrument = new Instrument({ logger })
    await instrument.run(
      { operation: 'select', schema: 'public', table: 't', queryText: 'select 1' },
      async () => ({ rows: [], rowCount: 1 })
    )
    expect(logger.debug).toHaveBeenCalledTimes(1)
    await expect(
      instrument.run(
        { operation: 'insert', schema: 'public', table: 't', queryText: 'insert ...' },
        async () => {
          throw new Error('boom')
        }
      )
    ).rejects.toThrow('boom')
    expect(logger.error).toHaveBeenCalledTimes(1)
  })
})

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { canConnect, resetFixture, testClient } from '../helpers/db.js'

const available = await canConnect()

function waitForNotification(timeoutMs = 5000): {
  promise: Promise<{ payload: string; channel: string }>
  resolve: (value: { payload: string; channel: string }) => void
} {
  let resolve!: (value: { payload: string; channel: string }) => void
  const promise = new Promise<{ payload: string; channel: string }>((r) => {
    resolve = r
  })
  void timeoutMs
  return { promise, resolve }
}

describe.skipIf(!available)('listen / notify', () => {
  const db = testClient()

  beforeAll(async () => {
    await resetFixture()
  })
  afterEach(async () => {
    await db.unlistenAll()
  })
  afterAll(async () => {
    await db.close()
  })

  it('delivers notifications to a listener', async () => {
    const received: Array<{ payload: string; channel: string }> = []
    const { promise, resolve } = waitForNotification()
    const sub = await db.listen('pgflu_test', (payload, meta) => {
      received.push({ payload, channel: meta.channel })
      resolve({ payload, channel: meta.channel })
    })
    try {
      await db.notify('pgflu_test', JSON.stringify({ id: 1 }))
      const got = await promise
      expect(got).toEqual({ payload: JSON.stringify({ id: 1 }), channel: 'pgflu_test' })
      expect(received).toHaveLength(1)
    } finally {
      await sub.unlisten()
    }
  })

  it('stops delivering after unlisten', async () => {
    let count = 0
    const sub = await db.listen('pgflu_stop', () => {
      count++
    })
    await db.notify('pgflu_stop', 'first')
    await new Promise((r) => setTimeout(r, 200))
    expect(count).toBe(1)

    await sub.unlisten()
    await db.notify('pgflu_stop', 'second')
    await new Promise((r) => setTimeout(r, 200))
    expect(count).toBe(1)
  })

  it('rejects an invalid channel name', async () => {
    await expect(db.listen('bad name', () => {})).rejects.toMatchObject({
      code: 'PGFLUENT_INVALID_QUERY',
    })
    await expect(db.notify('bad;drop', 'x')).rejects.toMatchObject({
      code: 'PGFLUENT_INVALID_QUERY',
    })
  })

  it('rejects a payload larger than 8000 bytes', async () => {
    await expect(db.notify('pgflu_big', 'x'.repeat(8001))).rejects.toMatchObject({
      code: 'PGFLUENT_INVALID_QUERY',
    })
  })

  it('reconnects and re-listens after the connection drops', async () => {
    const pids = await db.sql<{ pid: number }>`
      SELECT pid FROM pg_stat_activity WHERE application_name = 'pg-fluent-listen'
    `
    expect(pids.data?.length).toBeGreaterThan(0)
    const pid = pids.data![0]!.pid

    let reconnected = false
    let resolveReconnect!: () => void
    const reconnectPromise = new Promise<void>((r) => {
      resolveReconnect = r
    })
    const sub = await db.listen(
      'pgflu_reconnect',
      () => {},
      {
        onReconnect: () => {
          reconnected = true
          resolveReconnect()
        },
      }
    )
    try {
      await db.sql`SELECT pg_terminate_backend(${pid})`
      await Promise.race([reconnectPromise, new Promise((r) => setTimeout(r, 8000))])
      expect(reconnected).toBe(true)
    } finally {
      await sub.unlisten()
    }
  })
})
